/**
 * Cisco IOS / IOS XE device: routers (ISR), L2 switches (Catalyst 2960) and
 * multilayer switches (Catalyst 3650). The hardware model decides which features exist.
 */
import { Device, type DeviceInit, type DeviceState, type PortView, type LedColor } from './device';
import type { Port } from './port';
import { Bridge, type BridgePort } from '../l2/bridge';
import { IpStack, type L3If, type Addr4, type Addr6, type DhcpClientState } from '../l3/stack';
import { CDP_MAC, isGroupMac, macAdd, macToCisco, STP_MAC, type Mac } from '../net/mac';
import type { CdpPacket, EthernetFrame } from '../net/packets';
import { formatIPv4, type IPv4 } from '../net/ipv4';
import type { Terminal, CliSession } from '../cli/session';
import { IosSession } from '../cli/ios/session';
import { buildRunningConfig } from '../cli/ios/runconfig';

export interface IosIf extends L3If {
  kind: 'physical' | 'sub' | 'svi' | 'loopback';
  port?: Port;
  parent?: IosIf;
  /** Subinterface: dot1Q VLAN (undefined until "encapsulation dot1Q"); SVI: VLAN id. */
  vlan?: number;
  native?: boolean;
  /** Subinterface / loopback number for sorting. */
  num: number;
  description: string;
  shutdown: boolean;
  /** "ip address dhcp" configured. */
  dhcpAddr: boolean;
  /** "ipv6 enable" configured. */
  ipv6On: boolean;
  cdp: boolean;
  /** Last line protocol state reported in the log. */
  lastUp: boolean;
  speedCfg: 'auto' | number;
  duplexCfg: 'auto' | 'full' | 'half';
}

export interface LineCfg {
  password?: string;
  login: boolean | 'local';
  loggingSync: boolean;
  execTimeout?: [number, number];
  transportInput?: string;
  first: number;
  last: number;
}

export interface CdpNeighbor {
  deviceId: string;
  localPort: string;
  portId: string;
  platform: string;
  capabilities: string[];
  addresses: IPv4[];
  version: string;
  holdUntil: number;
  nativeVlan?: number;
}

/** Interface type names and their abbreviations used for display. */
export const IF_TYPES: Record<string, { short: string; cdp: string; help: string }> = {
  FastEthernet: { short: 'Fa', cdp: 'Fas', help: 'FastEthernet IEEE 802.3' },
  GigabitEthernet: { short: 'Gi', cdp: 'Gig', help: 'GigabitEthernet IEEE 802.3z' },
  Vlan: { short: 'Vl', cdp: 'Vl', help: 'Catalyst Vlans' },
  Loopback: { short: 'Lo', cdp: 'Lo', help: 'Loopback interface' },
};

export class IosDevice extends Device {
  readonly stack: IpStack;
  readonly bridge: Bridge | null;
  readonly ifs: IosIf[] = [];
  readonly sessions = new Set<IosSession>();

  // --------------------------------------------------------------- global configuration
  hostname: string;
  enableSecret?: string;
  enablePassword?: string;
  passwordEncryption = false;
  motd?: string;
  lineCon!: LineCfg;
  lineVty!: LineCfg[];
  domainLookup = true;
  domainName?: string;
  nameServers: IPv4[] = [];
  users = new Map<string, { privilege: number; secret: string; type: 'secret' | 'password' }>();
  cdpRun = true;
  startup: string | null = null;
  configRegister = '0x2102';
  bootTime = 0;
  /** Configuration changed since the last save (asked on reload). */
  dirty = false;
  cdpNeighbors = new Map<string, CdpNeighbor>();
  /** Interfaces for which the next state log must say "administratively down". */
  private adminDown = new Set<string>();
  readonly serial: string;

  constructor(init: DeviceInit) {
    super(init);
    this.hostname = init.name;
    const caps = init.model.caps;
    this.stack = new IpStack(this, () => this.l3Ifs(), {
      log: (m) => this.log(m),
      onDuplicate: (i, ip, mac) => this.log(`%IP-4-DUPADDR: Duplicate address ${formatIPv4(ip)} on ${i.name}, sourced by ${macToCisco(mac)}`),
      onDhcpChange: () => this.sim?.emitState(this.id),
    });
    this.stack.arpMode = 'drop';
    this.bridge = caps.switching
      ? new Bridge(this, this.ports, { log: (m) => this.log(m), changed: () => this.syncState() }, 'dynamic auto')
      : null;
    for (const p of this.ports) this.ifs.push(this.makeIf('physical', p.name, p.short, p.mac, 0, p));
    const sn = Math.abs([...init.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36).toUpperCase().padStart(8, '0').slice(0, 8);
    this.serial = (init.model.software?.serialPrefix ?? 'FTX') + sn;
    this.factoryDefaults();
  }

  private makeIf(kind: IosIf['kind'], name: string, short: string, mac: Mac, num: number, port?: Port): IosIf {
    const dev = this;
    const i: IosIf = {
      kind,
      name,
      short,
      mac,
      num,
      port,
      v4: [],
      v6: [],
      v6Enabled: false,
      helpers: [],
      description: '',
      shutdown: false,
      dhcpAddr: false,
      ipv6On: false,
      cdp: true,
      lastUp: false,
      speedCfg: 'auto',
      duplexCfg: 'auto',
      isUp(): boolean {
        if (!dev.powered || this.shutdown) return false;
        switch (this.kind) {
          case 'physical':
            return !!this.port && this.port.isUp();
          case 'sub':
            return !!this.parent && this.parent.isUp() && this.vlan !== undefined;
          case 'svi':
            return !!dev.bridge && dev.bridge.vlans.has(this.vlan!) && dev.bridge.vlanActive(this.vlan!);
          case 'loopback':
            return true;
        }
      },
      tx(f: EthernetFrame) {
        if (!this.isUp()) return;
        switch (this.kind) {
          case 'physical':
            dev.send(this.port!, f);
            break;
          case 'sub':
            dev.send(this.parent!.port!, { ...f, vlan: this.native ? undefined : this.vlan });
            break;
          case 'svi':
            dev.bridge!.sendFromSvi(this.vlan!, f);
            break;
          case 'loopback':
            break;
        }
      },
    };
    if (kind === 'loopback') i.loopback = true;
    return i;
  }

  // ===================================================================== interfaces

  bp(i: IosIf): BridgePort | undefined {
    return i.port && this.bridge ? this.bridge.bp(i.port) : undefined;
  }

  /** Physical port operating as a switchport (layer 2). */
  isSwitchport(i: IosIf): boolean {
    const bp = this.bp(i);
    return !!bp && !bp.routed;
  }

  l3Ifs(): IosIf[] {
    return this.ifs.filter((i) => i.kind !== 'physical' || !this.isSwitchport(i));
  }

  findIf(name: string): IosIf | undefined {
    const n = name.toLowerCase();
    return this.ifs.find((i) => i.name.toLowerCase() === n);
  }

  /** Interface types available on this platform (for "?" and name resolution). */
  ifTypes(): string[] {
    const types = new Set<string>();
    for (const p of this.ports) types.add(p.name.replace(/[\d/.]+$/, ''));
    if (this.bridge) types.add('Vlan');
    types.add('Loopback');
    return [...types];
  }

  /**
   * Resolves user input ("gi0/1", "g 0/0.10", "vlan10", "lo0") to a canonical interface
   * name. With create=false the interface must exist (subinterfaces/SVIs may be created).
   */
  resolveIfName(text: string): string | null {
    const m = /^([a-zA-Z-]+)\s*([\d/.]+)$/.exec(text.trim());
    if (!m) return null;
    const prefix = m[1].toLowerCase();
    const num = m[2];
    const types = this.ifTypes().filter((t) => t.toLowerCase().startsWith(prefix));
    if (types.length !== 1) return null;
    const type = types[0];
    if (type === 'Vlan') {
      if (!/^\d+$/.test(num) || Number(num) < 1 || Number(num) > 4094) return null;
      return `Vlan${Number(num)}`;
    }
    if (type === 'Loopback') {
      if (!/^\d+$/.test(num)) return null;
      return `Loopback${Number(num)}`;
    }
    const [base, sub] = num.split('.');
    const phys = this.ports.find((p) => p.name.toLowerCase() === `${type}${base}`.toLowerCase());
    if (!phys) return null;
    if (sub === undefined) return phys.name;
    if (!/^\d+$/.test(sub) || Number(sub) < 1) return null;
    if (this.bridge && this.isSwitchport(this.findIf(phys.name)!)) return null;
    return `${phys.name}.${Number(sub)}`;
  }

  shortName(name: string): string {
    const m = /^([A-Za-z-]+)(.*)$/.exec(name);
    if (!m) return name;
    const t = IF_TYPES[m[1]];
    return t ? t.short + m[2] : name;
  }

  /** Gets or creates the interface for a canonical name. */
  getOrCreateIf(name: string): IosIf | undefined {
    const ex = this.findIf(name);
    if (ex) return ex;
    let m = /^Vlan(\d+)$/.exec(name);
    if (m && this.bridge) {
      const vlan = Number(m[1]);
      const i = this.makeIf('svi', name, `Vl${vlan}`, macAdd(this.baseMac, 0x40), vlan);
      i.vlan = vlan;
      this.ifs.push(i);
      this.bridge.svis.set(vlan, { vlan, mac: i.mac, deliver: (f, t) => this.stack.receive(i, f, t) });
      this.log(`%LINK-3-UPDOWN: Interface ${name}, changed state to up`);
      this.syncState();
      return i;
    }
    m = /^Loopback(\d+)$/.exec(name);
    if (m) {
      const i = this.makeIf('loopback', name, `Lo${m[1]}`, this.baseMac, Number(m[1]));
      this.ifs.push(i);
      this.log(`%LINK-3-UPDOWN: Interface ${name}, changed state to up`);
      this.syncState();
      return i;
    }
    m = /^(.+)\.(\d+)$/.exec(name);
    if (m) {
      const parent = this.findIf(m[1]);
      if (!parent || parent.kind !== 'physical') return undefined;
      const i = this.makeIf('sub', name, `${parent.short}.${m[2]}`, parent.mac, Number(m[2]));
      i.parent = parent;
      this.ifs.push(i);
      return i;
    }
    return undefined;
  }

  removeIf(i: IosIf) {
    if (i.kind === 'physical') return;
    const idx = this.ifs.indexOf(i);
    if (idx >= 0) this.ifs.splice(idx, 1);
    if (i.kind === 'svi' && this.bridge) this.bridge.svis.delete(i.vlan!);
    this.stack.ifaceChanged({ ...i, isUp: () => false });
    this.syncState();
  }

  /** Interfaces ordered as IOS lists them. */
  sortedIfs(): IosIf[] {
    const rank = (i: IosIf) => (i.kind === 'loopback' ? 0 : i.kind === 'svi' ? 3 : 1);
    const portIdx = (i: IosIf) => this.ports.indexOf((i.port ?? i.parent?.port)!);
    return [...this.ifs].sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? portIdx(a) - portIdx(b) || a.num - b.num : a.num - b.num));
  }

  /** Sets shutdown state of an interface (with the matching log messages). */
  setShutdown(i: IosIf, shut: boolean) {
    if (i.shutdown === shut) return;
    i.shutdown = shut;
    if (i.kind === 'physical' && i.port) {
      if (!shut) i.port.errDisabled = null;
      if (shut) this.adminDown.add(i.name);
      i.port.adminUp = !shut;
      if (i.port.link) this.sim.linkChanged(i.port.link);
      if (shut && !i.port.link) this.log(`%LINK-5-CHANGED: Interface ${i.name}, changed state to administratively down`);
    } else {
      this.log(shut ? `%LINK-5-CHANGED: Interface ${i.name}, changed state to administratively down` : `%LINK-3-UPDOWN: Interface ${i.name}, changed state to up`);
    }
    this.syncState();
  }

  /** Re-evaluates line protocol of every interface, logging changes and notifying the stack. */
  syncState() {
    if (!this.sim) return;
    for (const i of this.ifs) {
      const up = i.kind === 'physical' && this.isSwitchport(i) ? !!i.port?.isUp() && !i.shutdown : i.isUp();
      if (up !== i.lastUp) {
        i.lastUp = up;
        if (this.powered && (i.kind !== 'sub')) {
          const name = i.name;
          this.timer(i.kind === 'physical' ? 1000 : 0, () => {
            if (i.lastUp === up) this.log(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${name}, changed state to ${up ? 'up' : 'down'}`);
          });
        }
        if (this.l3Ifs().includes(i)) this.stack.ifaceChanged(i);
        // Subinterfaces follow their parent.
        if (i.kind === 'physical') for (const s of this.ifs) if (s.parent === i) this.syncOne(s);
      }
    }
    this.sim.emitState(this.id);
  }

  private syncOne(s: IosIf) {
    const up = s.isUp();
    if (up !== s.lastUp) {
      s.lastUp = up;
      this.stack.ifaceChanged(s);
    }
  }

  /** Called when an IPv6 setting changes on an interface. */
  refreshV6(i: IosIf) {
    i.v6Enabled = i.ipv6On || i.v6.some((a) => a.source !== 'linklocal');
    const manualLL = i.v6.find((a) => a.source === 'linklocal' && a.addr !== undefined);
    this.stack.syncLinkLocal(i);
    if (manualLL) void 0;
    if (i.isUp() && i.v6Enabled && this.stack.routing6) this.stack.sendRa(i);
  }

  // ===================================================================== logging

  log(msg: string) {
    if (!this.powered) return;
    this.sim.emitConsole(this.id, msg);
  }

  // ===================================================================== lifecycle

  factoryDefaults() {
    this.hostname = this.model.defaultName;
    this.name = this.hostname;
    this.enableSecret = undefined;
    this.enablePassword = undefined;
    this.passwordEncryption = false;
    this.motd = undefined;
    this.lineCon = { login: false, loggingSync: false, first: 0, last: 0 };
    this.lineVty = this.bridge
      ? [
          { login: true, loggingSync: false, first: 0, last: 4 },
          { login: true, loggingSync: false, first: 5, last: 15 },
        ]
      : [{ login: true, loggingSync: false, first: 0, last: 4 }];
    this.domainLookup = true;
    this.domainName = undefined;
    this.nameServers = [];
    this.users.clear();
    this.cdpRun = true;
    // Remove logical interfaces.
    for (const i of [...this.ifs]) if (i.kind !== 'physical') this.ifs.splice(this.ifs.indexOf(i), 1);
    const isRouter = !this.bridge;
    for (const i of this.ifs) {
      i.v4 = [];
      i.v6 = [];
      i.v6Enabled = false;
      i.ipv6On = false;
      i.helpers = [];
      i.aclIn = i.aclOut = undefined;
      i.nat = undefined;
      i.description = '';
      i.dhcpAddr = false;
      i.dhcp = undefined;
      i.cdp = true;
      i.speedCfg = 'auto';
      i.duplexCfg = 'auto';
      i.raSuppress = false;
      i.raInterval = undefined;
      // Router interfaces ship administratively down; switch ports are enabled.
      i.shutdown = isRouter;
      if (i.port) {
        i.port.adminUp = !i.shutdown;
        i.port.errDisabled = null;
        i.port.forcedSpeed = null;
        i.port.duplex = 'auto';
      }
    }
    const st = this.stack;
    // Routers route IPv4 by default; multilayer switches need "ip routing".
    st.routing = !this.bridge;
    st.routing6 = false;
    st.defaultGateway = undefined;
    st.statics4 = [];
    st.statics6 = [];
    st.acls.clear();
    st.natStatics = [];
    st.natDynamics = [];
    st.natPools.clear();
    st.dhcpPools.clear();
    st.dhcpExcluded = [];
    st.dhcpService = true;
    st.unreachables = true;
    st.hostname = this.hostname;
    if (this.bridge) {
      const b = this.bridge;
      b.resetVlans();
      b.macTable.clear();
      b.svis.clear();
      b.stpEnabled = true;
      b.priority = 32768;
      b.portfastDefault = false;
      b.bpduguardDefault = false;
      for (const bp of b.ports) {
        bp.cfg = { mode: 'dynamic auto', accessVlan: 1, nativeVlan: 1, allowed: null, nonegotiate: false, portfast: false, bpduguard: false, priority: 128 };
        bp.routed = false;
      }
      // Default management SVI.
      const v1 = this.makeIf('svi', 'Vlan1', 'Vl1', macAdd(this.baseMac, 0x40), 1);
      v1.vlan = 1;
      v1.shutdown = true;
      this.ifs.push(v1);
      b.svis.set(1, { vlan: 1, mac: v1.mac, deliver: (f, t) => this.stack.receive(v1, f, t) });
    }
  }

  protected boot() {
    this.bootTime = this.sim.now;
    this.stack.reset();
    this.cdpNeighbors.clear();
    this.adminDown.clear();
    for (const i of this.ifs) i.lastUp = false;
    if (this.startup) this.loadConfig(this.startup, true);
    else this.factoryDefaults();
    this.dirty = false;
    this.bridge?.start();
    this.every(60_000, () => this.cdpTick(), 60_000);
    // Unsolicited Router Advertisements, per interface, with jitter (75-100% of the interval).
    this.every(1000, () => {
      if (!this.stack.routing6) return;
      const now = this.sim.now;
      for (const i of this.l3Ifs()) {
        if (!i.v6Enabled || !i.isUp() || i.raSuppress) continue;
        const interval = (i.raInterval ?? 200) * 1000;
        if (i.nextRa === undefined || i.nextRa > now + interval) i.nextRa = now + interval * (0.75 + 0.25 * this.sim.rng());
        if (now >= i.nextRa) {
          this.stack.sendRa(i);
          i.nextRa = now + interval * (0.75 + 0.25 * this.sim.rng());
        }
      }
    });
    for (const s of this.sessions) s.reboot();
    this.syncState();
  }

  protected shutdownOs() {
    for (const i of this.ifs) i.lastUp = false;
    for (const s of this.sessions) s.powerLost();
  }

  reload() {
    this.powerOff();
    this.sim.schedule(5000, () => this.powerOn());
  }

  protected onCarrier(p: Port, up: boolean) {
    const i = this.findIf(p.name)!;
    if (up) this.log(`%LINK-3-UPDOWN: Interface ${p.name}, changed state to up`);
    else if (this.adminDown.has(p.name)) {
      this.adminDown.delete(p.name);
      this.log(`%LINK-5-CHANGED: Interface ${p.name}, changed state to administratively down`);
    } else if (!i.shutdown) this.log(`%LINK-3-UPDOWN: Interface ${p.name}, changed state to down`);
    const bp = this.bridge?.bp(p);
    if (bp && !bp.routed) this.bridge!.portChanged(bp);
    if (!up) {
      for (const [k, n] of this.cdpNeighbors) if (n.localPort === p.name) this.cdpNeighbors.delete(k);
    } else this.timer(1500, () => this.cdpSend(p));
    this.syncState();
  }

  // ===================================================================== data plane

  protected receive(p: Port, f: EthernetFrame, traceId: number) {
    if (f.dst === CDP_MAC) {
      if (f.payload.kind === 'cdp') this.cdpReceive(p, f.payload);
      return;
    }
    const bp = this.bridge?.bp(p);
    if (bp && !bp.routed) {
      this.bridge!.receive(bp, f, traceId);
      return;
    }
    const phys = this.findIf(p.name);
    if (!phys || phys.shutdown || f.dst === STP_MAC) return;
    let iface: IosIf | undefined;
    if (f.vlan !== undefined) {
      iface = this.ifs.find((s) => s.parent === phys && s.vlan === f.vlan && !s.native);
      if (!iface) {
        this.note(`${phys.short}: quadro com tag 802.1Q VLAN ${f.vlan} sem subinterface correspondente — descartado`, 'drop', traceId);
        return;
      }
    } else {
      iface = this.ifs.find((s) => s.parent === phys && s.native) ?? phys;
    }
    if (!iface.isUp()) return;
    if (f.dst !== iface.mac && !isGroupMac(f.dst)) {
      this.note(`${iface.short}: MAC de destino ${f.dst} não é deste roteador — quadro descartado`, 'drop', traceId);
      return;
    }
    this.stack.receive(iface, { ...f, vlan: undefined }, traceId);
  }

  // ===================================================================== CDP

  platform(): string {
    return `cisco ${this.model.id}`;
  }

  cdpCaps(): string[] {
    if (this.model.caps.routing && this.model.caps.switching) return ['Router', 'Switch', 'IGMP'];
    if (this.model.caps.switching) return ['Switch', 'IGMP'];
    return ['Router'];
  }

  private cdpTick() {
    for (const [k, n] of this.cdpNeighbors) if (n.holdUntil <= this.sim.now) this.cdpNeighbors.delete(k);
    for (const p of this.ports) this.cdpSend(p);
  }

  private mgmtAddresses(p: Port): IPv4[] {
    const i = this.findIf(p.name)!;
    if (!this.isSwitchport(i)) return i.v4.slice(0, 1).map((a) => a.addr);
    const svi = this.ifs.find((s) => s.kind === 'svi' && s.v4.length);
    return svi ? [svi.v4[0].addr] : [];
  }

  private cdpSend(p: Port) {
    if (!this.cdpRun || !p.isUp()) return;
    const i = this.findIf(p.name)!;
    if (!i.cdp || i.shutdown) return;
    const bp = this.bridge?.bp(p);
    const pkt: CdpPacket = {
      kind: 'cdp',
      deviceId: this.domainName ? `${this.hostname}.${this.domainName}` : this.hostname,
      portId: p.name,
      platform: this.platform(),
      capabilities: this.cdpCaps(),
      addresses: this.mgmtAddresses(p),
      softwareVersion: this.model.software?.banner ?? '',
      holdtime: 180,
      nativeVlan: bp && !bp.routed ? (bp.trunk ? bp.cfg.nativeVlan : bp.cfg.accessVlan) : undefined,
    };
    this.send(p, { src: p.mac, dst: CDP_MAC, payload: pkt });
  }

  private cdpReceive(p: Port, c: CdpPacket) {
    if (!this.cdpRun) return;
    const i = this.findIf(p.name);
    if (!i?.cdp) return;
    this.cdpNeighbors.set(`${p.name}|${c.deviceId}`, {
      deviceId: c.deviceId,
      localPort: p.name,
      portId: c.portId,
      platform: c.platform,
      capabilities: c.capabilities,
      addresses: c.addresses,
      version: c.softwareVersion,
      holdUntil: this.sim.now + c.holdtime * 1000,
      nativeVlan: c.nativeVlan,
    });
    const bp = this.bridge?.bp(p);
    if (bp && !bp.routed && c.nativeVlan !== undefined) {
      const mine = bp.trunk ? bp.cfg.nativeVlan : bp.cfg.accessVlan;
      if (mine !== c.nativeVlan) {
        this.log(`%CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch discovered on ${p.name} (${mine}), with ${c.deviceId} ${c.portId} (${c.nativeVlan}).`);
      }
    }
  }

  // ===================================================================== views & state

  portViews(): PortView[] {
    return this.ports.map((p) => {
      const i = this.findIf(p.name)!;
      const bp = this.bridge?.bp(p);
      let led: LedColor = 'off';
      let info = '';
      if (bp && !bp.routed) {
        if (p.errDisabled) led = 'amber';
        else if (p.isUp()) led = bp.state === 'forwarding' ? 'green' : 'amber';
        info = bp.trunk ? `trunk (nativa ${bp.cfg.nativeVlan})` : `VLAN ${bp.cfg.accessVlan}`;
        if (p.isUp()) info += ` · STP ${bp.state}`;
        if (p.errDisabled) info += ' · err-disabled';
      } else {
        if (p.isUp() && !i.shutdown) led = 'green';
        const subs = this.ifs.filter((s) => s.parent === i);
        info = [...i.v4.map((a) => `${formatIPv4(a.addr)}/${a.prefix}`), ...subs.map((s) => `.${s.num}: ${s.v4.map((a) => `${formatIPv4(a.addr)}/${a.prefix}`).join(' ')}`)].join(', ') || 'sem IP';
      }
      if (i.shutdown) info += ' · shutdown';
      return { name: p.name, short: p.short, connected: !!p.link, up: p.isUp(), led, info };
    });
  }

  summary(): string {
    const ips = this.l3Ifs()
      .filter((i) => i.v4.length)
      .map((i) => `${i.short} ${formatIPv4(i.v4[0].addr)}/${i.v4[0].prefix}`);
    return ips.join(' · ');
  }

  runningConfig(): string {
    return buildRunningConfig(this);
  }

  /** Replays a configuration (startup-config load or lab import). */
  loadConfig(text: string, fresh: boolean) {
    if (fresh) {
      this.factoryDefaults();
      // A saved configuration brings interfaces up unless it says "shutdown".
      for (const i of this.ifs) {
        if (i.kind === 'physical') {
          i.shutdown = false;
          if (i.port) i.port.adminUp = true;
        }
        if (i.kind === 'svi') i.shutdown = false;
      }
    }
    const s = new IosSession(this, null);
    s.runConfigScript(text);
    for (const p of this.ports) if (p.link) this.sim?.linkChanged(p.link);
    for (const bp of this.bridge?.ports ?? []) this.bridge!.refreshTrunk(bp);
    this.name = this.hostname;
    this.stack.hostname = this.hostname;
    this.syncState();
  }

  exportState(): DeviceState {
    return { running: this.runningConfig(), startup: this.startup ?? undefined };
  }

  importState(s: DeviceState) {
    this.startup = s.startup ?? null;
    if (this.powered) this.loadConfig(s.running, true);
    else this.pendingRunning = s.running;
  }

  /** Running config to apply at next power-on (lab import while powered off). */
  pendingRunning?: string;

  override powerOn() {
    super.powerOn();
    if (this.pendingRunning !== undefined) {
      this.loadConfig(this.pendingRunning, true);
      this.pendingRunning = undefined;
    }
  }

  openSession(term: Terminal): CliSession {
    const s = new IosSession(this, term);
    this.sessions.add(s);
    s.start();
    return s;
  }

  uptime(): string {
    const total = Math.floor((this.sim.now - this.bootTime) / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const parts: string[] = [];
    if (d) parts.push(`${d} day${d > 1 ? 's' : ''}`);
    if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
    parts.push(`${m} minute${m !== 1 ? 's' : ''}`);
    return parts.join(', ');
  }
}

export type { Addr4, Addr6, DhcpClientState };
