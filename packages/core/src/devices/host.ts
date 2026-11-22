import { Device, type DeviceInit, type DeviceState, type PortView } from './device';
import type { Port } from './port';
import type { EthernetFrame } from '../net/packets';
import { IpStack, type L3If } from '../l3/stack';
import { formatIPv4, maskToPrefix, parseIPv4, prefixToMask, type IPv4 } from '../net/ipv4';
import { formatIPv6, parseIPv6, parsePrefix6 } from '../net/ipv6';
import { isGroupMac } from '../net/mac';
import type { Terminal, CliSession } from '../cli/session';
import { WindowsShell } from '../cli/host/windows';
import { LinuxShell } from '../cli/host/linux';

/** Host settings (what the "IP configuration" dialog edits). Persisted as JSON. */
export interface HostConfig {
  hostname: string;
  ipv4: { mode: 'dhcp' | 'static'; addr?: string; mask?: string; gateway?: string; dns?: string[] };
  ipv6: { mode: 'auto' | 'static' | 'off'; addr?: string; gateway?: string };
}

export function defaultHostConfig(name: string): HostConfig {
  return { hostname: name, ipv4: { mode: 'dhcp' }, ipv6: { mode: 'auto' } };
}

export class Host extends Device {
  readonly stack: IpStack;
  readonly nic: L3If;
  cfg: HostConfig;
  /** NIC administratively disabled ("ip link set eth0 down"). */
  nicDisabled = false;
  readonly sessions = new Set<{ reset(): void }>();
  /** Extra static routes ("route add", "ip route add"). */
  dns: IPv4[] = [];

  constructor(init: DeviceInit) {
    super(init);
    const port = this.ports[0];
    const dev = this;
    this.nic = {
      name: port.name,
      short: port.name,
      mac: port.mac,
      v4: [],
      v6: [],
      v6Enabled: true,
      slaac: true,
      helpers: [],
      isUp: () => dev.powered && port.isUp() && !dev.nicDisabled,
      tx: (f: EthernetFrame) => dev.send(port, f),
    };
    this.stack = new IpStack(this, () => [this.nic], {
      onDuplicate: (_i, ip) => this.note(`Conflito de endereço IP detectado: outro equipamento está usando ${formatIPv4(ip)}`, 'warn'),
      onDhcpChange: () => this.sim?.emitState(this.id),
    });
    this.stack.arpMode = 'queue';
    this.stack.apipa = init.model.os === 'windows';
    this.cfg = defaultHostConfig(init.name);
  }

  get os() {
    return this.model.os as 'windows' | 'linux';
  }

  /** Applies the host configuration to the IP stack. */
  applyConfig(cfg: HostConfig = this.cfg) {
    this.cfg = structuredClone(cfg);
    this.name = cfg.hostname;
    this.stack.hostname = cfg.hostname;
    const nic = this.nic;
    const st = this.stack;
    if (!this.powered) return;
    // IPv4
    if (cfg.ipv4.mode === 'dhcp') {
      if (!nic.dhcp) {
        nic.v4 = [];
        st.defaultGateway = undefined;
        st.dhcpStart(nic);
      }
    } else {
      if (nic.dhcp) st.dhcpStop(nic, true);
      nic.v4 = [];
      const addr = parseIPv4(cfg.ipv4.addr ?? '');
      const mask = parseIPv4(cfg.ipv4.mask ?? '');
      const prefix = mask !== null ? maskToPrefix(mask) : null;
      if (addr !== null && prefix !== null) nic.v4 = [{ addr, prefix, source: 'manual' }];
      const gw = parseIPv4(cfg.ipv4.gateway ?? '');
      st.defaultGateway = gw ?? undefined;
      st.dnsServers = (cfg.ipv4.dns ?? []).map((d) => parseIPv4(d)).filter((x): x is number => x !== null);
      nic.duplicate = undefined;
      st.clearArp();
      st.gratuitousArp(nic);
    }
    // IPv6
    nic.v6Enabled = cfg.ipv6.mode !== 'off';
    nic.slaac = cfg.ipv6.mode === 'auto';
    nic.v6 = nic.v6.filter((a) => a.source === 'linklocal' || (a.source === 'slaac' && nic.slaac));
    st.defaultGateway6 = undefined;
    if (cfg.ipv6.mode === 'static') {
      const p = parsePrefix6(cfg.ipv6.addr ?? '');
      if (p) nic.v6.push({ addr: p.addr, prefix: p.prefix, source: 'manual' });
      const gw = parseIPv6(cfg.ipv6.gateway ?? '');
      if (gw !== null) st.defaultGateway6 = gw;
    }
    st.syncLinkLocal(nic);
    if (nic.slaac && nic.isUp()) st.sendRs(nic);
    this.sim.emitState(this.id);
  }

  /** Reads the effective configuration back (for the form), including DHCP results. */
  effective() {
    const nic = this.nic;
    const a = nic.v4[0];
    const lease = nic.dhcp?.lease;
    const gw4 = nic.dhcp ? lease?.gateway : this.stack.defaultGateway;
    const gw6 = this.stack.defaultGateway6 ?? [...this.stack.raRouters.values()][0]?.addr;
    return {
      ipv4: a ? formatIPv4(a.addr) : '',
      mask: a ? formatIPv4(prefixToMask(a.prefix)) : '',
      gateway: gw4 !== undefined ? formatIPv4(gw4) : '',
      dns: (nic.dhcp ? lease?.dns ?? [] : this.stack.dnsServers).map(formatIPv4),
      ipv6: nic.v6.filter((x) => x.source !== 'linklocal').map((x) => `${formatIPv6(x.addr)}/${x.prefix}`),
      linkLocal: nic.v6.find((x) => x.source === 'linklocal') ? formatIPv6(nic.v6.find((x) => x.source === 'linklocal')!.addr) : '',
      gateway6: gw6 !== undefined ? formatIPv6(gw6) : '',
      dhcpState: nic.dhcp?.state,
      apipa: a?.source === 'apipa',
    };
  }

  protected boot() {
    this.stack.reset();
    this.nic.v4 = [];
    this.nic.v6 = [];
    this.nic.dhcp = undefined;
    this.applyConfig(this.cfg);
    for (const s of this.sessions) s.reset();
  }

  protected shutdownOs() {
    this.nic.dhcp = undefined;
  }

  protected onCarrier(_p: Port, up: boolean) {
    if (!up) this.note(`${this.nic.name}: cabo de rede desconectado`, 'info');
    this.stack.ifaceChanged(this.nic);
    this.sim.emitState(this.id);
  }

  setNicEnabled(on: boolean) {
    this.nicDisabled = !on;
    this.stack.ifaceChanged(this.nic);
    this.sim.emitState(this.id);
  }

  protected receive(_p: Port, f: EthernetFrame, traceId: number) {
    if (this.nicDisabled) return;
    if (f.dst !== this.nic.mac && !isGroupMac(f.dst)) {
      this.note(`Quadro para ${f.dst} não é para esta placa de rede (${this.nic.mac}) — descartado`, 'drop', traceId);
      return;
    }
    if (f.vlan !== undefined) {
      this.note(`Quadro com tag 802.1Q recebido — a placa de rede descarta quadros marcados`, 'drop', traceId);
      return;
    }
    this.stack.receive(this.nic, f, traceId);
  }

  portViews(): PortView[] {
    const p = this.ports[0];
    const a = this.nic.v4[0];
    return [{ name: p.name, short: p.short, connected: !!p.link, up: p.isUp(), led: p.isUp() ? 'green' : 'off', info: a ? `${formatIPv4(a.addr)}/${a.prefix}` : 'sem IP' }];
  }

  summary(): string {
    const a = this.nic.v4[0];
    return a ? `${formatIPv4(a.addr)}/${a.prefix}${a.source === 'dhcp' ? ' (DHCP)' : a.source === 'apipa' ? ' (APIPA)' : ''}` : 'sem IP';
  }

  exportState(): DeviceState {
    return { running: JSON.stringify(this.cfg) };
  }

  importState(s: DeviceState) {
    try {
      const cfg = JSON.parse(s.running) as HostConfig;
      this.cfg = cfg;
      this.name = cfg.hostname;
      if (this.powered) this.applyConfig(cfg);
    } catch {
      /* keep defaults */
    }
  }

  openSession(term: Terminal): CliSession {
    const sh = this.os === 'windows' ? new WindowsShell(this, term) : new LinuxShell(this, term);
    this.sessions.add(sh);
    sh.start();
    return sh;
  }
}
