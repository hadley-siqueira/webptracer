/**
 * Transparent bridge (Ethernet switch): MAC learning and aging, VLANs (access / 802.1Q
 * trunk, native VLAN, allowed list), simplified DTP and IEEE 802.1D Spanning Tree
 * (single instance, reported per VLAN like PVST), PortFast and BPDU Guard.
 */
import { BROADCAST_MAC, STP_MAC, isGroupMac, compareMac, type Mac } from '../net/mac';
import type { BridgeId, EthernetFrame, StpBpdu } from '../net/packets';
import type { Device } from '../devices/device';
import type { Port } from '../devices/port';

export type SwitchportMode = 'access' | 'trunk' | 'dynamic auto' | 'dynamic desirable';
export type StpState = 'disabled' | 'blocking' | 'listening' | 'learning' | 'forwarding';
export type StpRole = 'root' | 'designated' | 'alternate' | 'disabled';

export interface SwitchportConfig {
  mode: SwitchportMode;
  accessVlan: number;
  nativeVlan: number;
  /** null = all VLANs. */
  allowed: Set<number> | null;
  nonegotiate: boolean;
  portfast: boolean;
  bpduguard: boolean;
  cost?: number;
  priority: number;
}

export function defaultSwitchport(defaultMode: SwitchportMode = 'dynamic auto'): SwitchportConfig {
  return { mode: defaultMode, accessVlan: 1, nativeVlan: 1, allowed: null, nonegotiate: false, portfast: false, bpduguard: false, priority: 128 };
}

interface StpInfo {
  root: BridgeId;
  rootCost: number;
  bridge: BridgeId;
  portId: number;
  messageAge: number;
  expires: number;
}

export interface BridgePort {
  port: Port;
  index: number;
  cfg: SwitchportConfig;
  /** Port is not part of the bridge (routed port on an L3 switch). */
  routed: boolean;
  trunk: boolean;
  role: StpRole;
  state: StpState;
  rx: StpInfo | null;
  stateTimer?: { cancelled: boolean };
}

export interface MacEntry {
  vlan: number;
  mac: Mac;
  port: BridgePort | null;
  time: number;
  static: boolean;
}

export interface Svi {
  vlan: number;
  mac: Mac;
  deliver(f: EthernetFrame, traceId?: number): void;
}

export interface VlanInfo {
  id: number;
  name: string;
}

export interface BridgeHooks {
  log(msg: string): void;
  /** STP / trunk changes alter LEDs and SVI line protocol. */
  changed(): void;
}

const HELLO = 2;
const MAX_AGE = 20;
const FWD_DELAY = 15;

function cmpBridge(a: BridgeId, b: BridgeId): number {
  return a.priority - b.priority || compareMac(a.mac, b.mac);
}

/** Compares STP priority vectors; negative means `a` is better. */
function cmpVector(a: [BridgeId, number, BridgeId, number], b: [BridgeId, number, BridgeId, number]): number {
  return cmpBridge(a[0], b[0]) || a[1] - b[1] || cmpBridge(a[2], b[2]) || a[3] - b[3];
}

export function stpCost(speed: number): number {
  if (speed >= 10000) return 2;
  if (speed >= 1000) return 4;
  if (speed >= 100) return 19;
  return 100;
}

export class Bridge {
  readonly ports: BridgePort[];
  readonly vlans = new Map<number, VlanInfo>();
  readonly macTable = new Map<string, MacEntry>();
  readonly svis = new Map<number, Svi>();
  agingTime = 300;
  stpEnabled = true;
  stpMode: 'pvst' | 'rapid-pvst' = 'pvst';
  /** Bridge priority (configured for VLAN 1). */
  priority = 32768;
  portfastDefault = false;
  bpduguardDefault = false;
  rootId!: BridgeId;
  rootCost = 0;
  rootPort: BridgePort | null = null;
  rootMessageAge = 0;
  topologyChanges = 0;
  lastTopologyChange = 0;

  constructor(
    private readonly dev: Device,
    physical: Port[],
    private readonly hooks: BridgeHooks,
    defaultMode: SwitchportMode,
  ) {
    this.ports = physical.map((port, index) => ({
      port,
      index,
      cfg: defaultSwitchport(defaultMode),
      routed: false,
      trunk: false,
      role: 'disabled',
      state: 'disabled',
      rx: null,
    }));
    this.resetVlans();
    this.rootId = this.bridgeId();
  }

  resetVlans() {
    this.vlans.clear();
    this.vlans.set(1, { id: 1, name: 'default' });
    for (const [id, name] of [
      [1002, 'fddi-default'],
      [1003, 'token-ring-default'],
      [1004, 'fddinet-default'],
      [1005, 'trnet-default'],
    ] as const)
      this.vlans.set(id, { id, name });
  }

  private get now() {
    return this.dev.simulator.now;
  }

  bridgeId(): BridgeId {
    return { priority: this.priority + 1, mac: this.dev.baseMac };
  }

  bp(port: Port): BridgePort | undefined {
    return this.ports.find((b) => b.port === port);
  }

  // ===================================================================== VLAN helpers

  vlanAllowed(bp: BridgePort, vlan: number): boolean {
    if (!this.vlans.has(vlan)) return false;
    if (bp.trunk) return bp.cfg.allowed === null || bp.cfg.allowed.has(vlan);
    return bp.cfg.accessVlan === vlan;
  }

  /** Ports that are members of a VLAN (any STP state). */
  members(vlan: number): BridgePort[] {
    return this.ports.filter((b) => !b.routed && this.vlanAllowed(b, vlan));
  }

  /** At least one forwarding port in the VLAN (drives SVI line protocol). */
  vlanActive(vlan: number): boolean {
    return this.ports.some((b) => !b.routed && b.port.isUp() && b.state === 'forwarding' && this.vlanAllowed(b, vlan));
  }

  // ===================================================================== DTP

  /** DTP view of a port, used by the neighbor to decide whether to trunk. */
  dtpMode(port: Port): { mode: SwitchportMode; nonegotiate: boolean } | null {
    const bp = this.bp(port);
    if (!bp || bp.routed) return null;
    return { mode: bp.cfg.mode, nonegotiate: bp.cfg.nonegotiate };
  }

  private computeTrunk(bp: BridgePort): boolean {
    const m = bp.cfg.mode;
    if (m === 'trunk') return true;
    if (m === 'access') return false;
    if (bp.cfg.nonegotiate) return false;
    const peer = bp.port.peer();
    if (!peer || !bp.port.isUp()) return false;
    const pb = (peer.device as unknown as { bridge?: Bridge }).bridge;
    const pm = pb?.dtpMode(peer);
    if (!pm || pm.nonegotiate) return false;
    if (m === 'dynamic desirable') return pm.mode === 'trunk' || pm.mode === 'dynamic desirable' || pm.mode === 'dynamic auto';
    return pm.mode === 'trunk' || pm.mode === 'dynamic desirable';
  }

  /** Re-evaluates trunk negotiation on a port (and on the neighbor). */
  refreshTrunk(bp: BridgePort, propagate = true) {
    const t = this.computeTrunk(bp);
    if (t !== bp.trunk) {
      bp.trunk = t;
      this.flushPort(bp);
      this.hooks.changed();
    }
    if (propagate) {
      const peer = bp.port.peer();
      const pb = peer && (peer.device as unknown as { bridge?: Bridge }).bridge;
      const pbp = pb && peer && pb.bp(peer);
      if (pb && pbp) pb.refreshTrunk(pbp, false);
    }
  }

  // ===================================================================== link events

  portChanged(bp: BridgePort) {
    if (bp.routed) return;
    if (bp.port.isUp()) {
      this.refreshTrunk(bp);
      bp.rx = null;
      if (this.stpEnabled) {
        bp.role = 'designated';
        if (this.isPortfast(bp)) this.setState(bp, 'forwarding');
        else this.startTransition(bp);
        this.recompute();
        this.sendBpdu(bp);
      } else {
        bp.role = 'designated';
        this.setState(bp, 'forwarding');
      }
    } else {
      const wasForwarding = bp.state === 'forwarding';
      if (bp.stateTimer) bp.stateTimer.cancelled = true;
      bp.state = 'disabled';
      bp.role = 'disabled';
      bp.rx = null;
      bp.trunk = false;
      this.flushPort(bp);
      if (this.stpEnabled) this.recompute();
      if (wasForwarding) this.topologyChange();
    }
    this.hooks.changed();
  }

  isPortfast(bp: BridgePort) {
    return bp.cfg.portfast || (this.portfastDefault && !bp.trunk);
  }

  isBpduguard(bp: BridgePort) {
    return bp.cfg.bpduguard || (this.bpduguardDefault && this.isPortfast(bp));
  }

  private setState(bp: BridgePort, s: StpState) {
    if (bp.state === s) return;
    if (bp.stateTimer) bp.stateTimer.cancelled = true;
    bp.stateTimer = undefined;
    const before = bp.state;
    bp.state = s;
    if (s === 'forwarding' && before !== 'forwarding') this.topologyChange();
    if (s === 'blocking' && before === 'forwarding') this.flushPort(bp);
    this.hooks.changed();
  }

  private startTransition(bp: BridgePort) {
    if (bp.state === 'listening' || bp.state === 'learning' || bp.state === 'forwarding') return;
    this.setState(bp, 'listening');
    const tok = { cancelled: false };
    bp.stateTimer = tok;
    this.dev.timer(FWD_DELAY * 1000, () => {
      if (tok.cancelled) return;
      bp.state = 'learning';
      this.hooks.changed();
      this.dev.timer(FWD_DELAY * 1000, () => {
        if (tok.cancelled) return;
        bp.stateTimer = undefined;
        bp.state = 'forwarding';
        this.topologyChange();
        this.hooks.changed();
      });
    });
  }

  private topologyChange() {
    this.topologyChanges++;
    this.lastTopologyChange = this.now;
    // Simplification of TCN handling: age out learned entries quickly.
    for (const [k, e] of this.macTable) if (!e.static && this.now - e.time > FWD_DELAY * 1000) this.macTable.delete(k);
  }

  flushPort(bp: BridgePort) {
    for (const [k, e] of this.macTable) if (e.port === bp && !e.static) this.macTable.delete(k);
  }

  flushAll() {
    for (const [k, e] of this.macTable) if (!e.static) this.macTable.delete(k);
  }

  // ===================================================================== STP

  start() {
    this.rootId = this.bridgeId();
    this.rootCost = 0;
    this.rootPort = null;
    this.dev.every(HELLO * 1000, () => this.helloTick(), HELLO * 1000);
  }

  setStpEnabled(on: boolean) {
    this.stpEnabled = on;
    for (const bp of this.ports) {
      if (bp.routed || !bp.port.isUp()) continue;
      if (!on) {
        bp.role = 'designated';
        this.setState(bp, 'forwarding');
      } else {
        bp.rx = null;
        bp.state = 'blocking';
        this.startTransition(bp);
      }
    }
    this.recompute();
  }

  setPriority(p: number) {
    this.priority = p;
    this.recompute();
    for (const bp of this.ports) if (bp.role === 'designated' && bp.port.isUp()) this.sendBpdu(bp);
  }

  portCost(bp: BridgePort): number {
    return bp.cfg.cost ?? stpCost(bp.port.speed() || 100);
  }

  portId(bp: BridgePort): number {
    return (bp.cfg.priority << 8) | (bp.index + 1);
  }

  private helloTick() {
    if (!this.stpEnabled) return;
    let expired = false;
    for (const bp of this.ports) {
      if (bp.rx && bp.rx.expires <= this.now) {
        bp.rx = null;
        expired = true;
      }
    }
    if (expired) this.recompute();
    for (const bp of this.ports) {
      if (!bp.routed && bp.port.isUp() && bp.role === 'designated') this.sendBpdu(bp);
    }
  }

  private sendBpdu(bp: BridgePort) {
    if (!this.stpEnabled || bp.routed || !bp.port.isUp()) return;
    const bpdu: StpBpdu = {
      kind: 'stp',
      bpduType: 'config',
      root: this.rootId,
      rootCost: this.rootCost,
      bridge: this.bridgeId(),
      portId: this.portId(bp),
      messageAge: this.rootPort ? this.rootMessageAge + 1 : 0,
      maxAge: MAX_AGE,
      helloTime: HELLO,
      forwardDelay: FWD_DELAY,
      tc: false,
      tca: false,
    };
    this.dev.send(bp.port, { src: bp.port.mac, dst: STP_MAC, payload: bpdu });
  }

  private receiveBpdu(bp: BridgePort, b: StpBpdu, traceId?: number) {
    if (this.isBpduguard(bp)) {
      this.hooks.log(`%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port ${bp.port.name} with BPDU Guard enabled. Disabling port.`);
      this.hooks.log(`%PM-4-ERR_DISABLE: bpduguard error detected on ${bp.port.short}, putting ${bp.port.short} in err-disable state`);
      this.dev.note(`BPDU Guard: BPDU recebida na porta PortFast ${bp.port.short} — porta colocada em err-disabled`, 'drop', traceId);
      bp.port.errDisabled = 'bpduguard';
      this.dev.refreshPort(bp.port);
      this.portChanged(bp);
      const peer = bp.port.peer();
      if (peer) peer.device.refreshPort(peer);
      return;
    }
    if (!this.stpEnabled || b.bpduType !== 'config') return;
    const info: StpInfo = {
      root: b.root,
      rootCost: b.rootCost,
      bridge: b.bridge,
      portId: b.portId,
      messageAge: b.messageAge,
      expires: this.now + Math.max(1, b.maxAge - b.messageAge) * 1000,
    };
    const mine: [BridgeId, number, BridgeId, number] = [this.rootId, this.rootCost, this.bridgeId(), this.portId(bp)];
    const theirs: [BridgeId, number, BridgeId, number] = [info.root, info.rootCost, info.bridge, info.portId];
    const sameSender = bp.rx && cmpBridge(bp.rx.bridge, info.bridge) === 0 && bp.rx.portId === info.portId;
    if (!bp.rx || sameSender || cmpVector(theirs, [bp.rx.root, bp.rx.rootCost, bp.rx.bridge, bp.rx.portId]) < 0) {
      bp.rx = info;
    }
    const before = this.rootId;
    this.recompute();
    if (cmpBridge(before, this.rootId) !== 0) {
      this.dev.note(`STP: nova bridge raiz ${this.rootId.priority}.${this.rootId.mac} aprendida pela porta ${bp.port.short}`, 'info', traceId);
    }
    // Inferior BPDU on a designated port: answer with our superior information.
    if (bp.role === 'designated' && cmpVector(theirs, mine) > 0) this.sendBpdu(bp);
    // Root port: relay fresh information downstream.
    if (bp === this.rootPort) for (const o of this.ports) if (o !== bp && o.role === 'designated' && o.port.isUp()) this.sendBpdu(o);
  }

  /** Port role selection (IEEE 802.1D clause 8.6). */
  recompute() {
    const me = this.bridgeId();
    let bestRoot: BridgeId = me;
    let bestCost = 0;
    let rootPort: BridgePort | null = null;
    let bestVec: [BridgeId, number, BridgeId, number] | null = null;
    let bestPortId = 0;
    for (const bp of this.ports) {
      if (bp.routed || !bp.port.isUp() || !bp.rx || !this.stpEnabled) continue;
      if (bp.rx.expires <= this.now) continue;
      const vec: [BridgeId, number, BridgeId, number] = [bp.rx.root, bp.rx.rootCost + this.portCost(bp), bp.rx.bridge, bp.rx.portId];
      if (cmpBridge(vec[0], me) >= 0) continue;
      if (!bestVec || cmpVector(vec, bestVec) < 0 || (cmpVector(vec, bestVec) === 0 && this.portId(bp) < bestPortId)) {
        bestVec = vec;
        rootPort = bp;
        bestPortId = this.portId(bp);
      }
    }
    if (bestVec && rootPort) {
      bestRoot = bestVec[0];
      bestCost = bestVec[1];
      this.rootMessageAge = rootPort.rx!.messageAge;
    } else {
      this.rootMessageAge = 0;
    }
    this.rootId = bestRoot;
    this.rootCost = bestCost;
    this.rootPort = rootPort;
    if (!this.stpEnabled) return;
    for (const bp of this.ports) {
      if (bp.routed || !bp.port.isUp()) continue;
      let role: StpRole;
      if (bp === rootPort) role = 'root';
      else if (!bp.rx || bp.rx.expires <= this.now) role = 'designated';
      else {
        const mine: [BridgeId, number, BridgeId, number] = [bestRoot, bestCost, me, this.portId(bp)];
        const theirs: [BridgeId, number, BridgeId, number] = [bp.rx.root, bp.rx.rootCost, bp.rx.bridge, bp.rx.portId];
        role = cmpVector(mine, theirs) < 0 ? 'designated' : 'alternate';
      }
      if (role !== bp.role) {
        bp.role = role;
        if (role === 'alternate') this.setState(bp, 'blocking');
        else if (this.isPortfast(bp) && role === 'designated') this.setState(bp, 'forwarding');
        else this.startTransition(bp);
      } else if (role !== 'alternate' && bp.state === 'blocking') {
        this.startTransition(bp);
      }
    }
    this.hooks.changed();
  }

  isRoot(): boolean {
    return cmpBridge(this.rootId, this.bridgeId()) === 0;
  }

  // ===================================================================== data plane

  private learn(vlan: number, mac: Mac, bp: BridgePort) {
    if (isGroupMac(mac)) return;
    const k = `${vlan}|${mac}`;
    const e = this.macTable.get(k);
    if (e?.static) return;
    this.macTable.set(k, { vlan, mac, port: bp, time: this.now, static: false });
  }

  lookup(vlan: number, mac: Mac): MacEntry | undefined {
    const k = `${vlan}|${mac}`;
    const e = this.macTable.get(k);
    if (!e) return undefined;
    if (!e.static && this.now - e.time > this.agingTime * 1000) {
      this.macTable.delete(k);
      return undefined;
    }
    return e;
  }

  entries(): MacEntry[] {
    const out: MacEntry[] = [];
    for (const [k, e] of this.macTable) {
      if (!e.static && this.now - e.time > this.agingTime * 1000) {
        this.macTable.delete(k);
        continue;
      }
      out.push(e);
    }
    return out;
  }

  receive(bp: BridgePort, f: EthernetFrame, traceId?: number) {
    if (bp.routed) return;
    if (f.dst === STP_MAC) {
      this.receiveBpdu(bp, f.payload as StpBpdu, traceId);
      return;
    }
    let vlan: number;
    if (bp.trunk) {
      vlan = f.vlan ?? bp.cfg.nativeVlan;
      if (!(bp.cfg.allowed === null || bp.cfg.allowed.has(vlan))) {
        this.dev.note(`${bp.port.short}: quadro da VLAN ${vlan} descartado — VLAN não permitida no trunk`, 'drop', traceId);
        return;
      }
    } else {
      if (f.vlan !== undefined && f.vlan !== bp.cfg.accessVlan) {
        this.dev.note(`${bp.port.short}: quadro com tag 802.1Q (VLAN ${f.vlan}) recebido em porta de acesso — descartado`, 'drop', traceId);
        return;
      }
      vlan = bp.cfg.accessVlan;
    }
    if (!this.vlans.has(vlan)) {
      this.dev.note(`${bp.port.short}: VLAN ${vlan} não existe neste switch — quadro descartado (porta inativa)`, 'drop', traceId);
      return;
    }
    if (bp.state !== 'forwarding' && bp.state !== 'learning') {
      this.dev.note(`${bp.port.short}: porta em estado STP ${bp.state} — quadro descartado`, 'drop', traceId);
      return;
    }
    const frame: EthernetFrame = { ...f, vlan: undefined };
    this.learn(vlan, f.src, bp);
    if (bp.state === 'learning') return;
    this.forward(vlan, frame, bp, traceId);
  }

  /** Frame generated by an SVI (switch's own IP interface). */
  sendFromSvi(vlan: number, f: EthernetFrame) {
    this.forward(vlan, f, null);
  }

  private forward(vlan: number, f: EthernetFrame, ingress: BridgePort | null, traceId?: number) {
    const svi = this.svis.get(vlan);
    if (svi && ingress && (f.dst === svi.mac || isGroupMac(f.dst))) {
      svi.deliver(f, traceId);
      if (f.dst === svi.mac) return;
    }
    if (isGroupMac(f.dst) || f.dst === BROADCAST_MAC) {
      const outs = this.floodPorts(vlan, ingress);
      if (ingress) this.dev.note(`Quadro ${f.dst === BROADCAST_MAC ? 'broadcast' : 'multicast'} na VLAN ${vlan}: inundando por ${outs.length} porta(s)`, 'info', traceId);
      for (const o of outs) this.egress(o, vlan, f);
      return;
    }
    const e = this.lookup(vlan, f.dst);
    if (e) {
      if (!e.port) return;
      if (e.port === ingress) {
        this.dev.note(`MAC ${f.dst} está na mesma porta de entrada (${e.port.port.short}) — quadro filtrado`, 'drop', traceId);
        return;
      }
      if (e.port.state !== 'forwarding' || !e.port.port.isUp()) return;
      if (ingress) this.dev.note(`MAC ${f.dst} encontrado na tabela (VLAN ${vlan}) → encaminhando pela porta ${e.port.port.short}`, 'info', traceId);
      this.egress(e.port, vlan, f);
      return;
    }
    const outs = this.floodPorts(vlan, ingress);
    if (ingress) this.dev.note(`MAC ${f.dst} desconhecido na VLAN ${vlan}: inundando (unknown unicast) por ${outs.length} porta(s)`, 'info', traceId);
    for (const o of outs) this.egress(o, vlan, f);
  }

  private floodPorts(vlan: number, ingress: BridgePort | null): BridgePort[] {
    return this.ports.filter((o) => o !== ingress && !o.routed && o.port.isUp() && o.state === 'forwarding' && this.vlanAllowed(o, vlan));
  }

  private egress(o: BridgePort, vlan: number, f: EthernetFrame) {
    const tagged = o.trunk && vlan !== o.cfg.nativeVlan;
    this.dev.send(o.port, { ...f, vlan: tagged ? vlan : undefined });
  }
}
