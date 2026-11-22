/**
 * IP stack shared by routers, L3 switches, the management SVI of L2 switches and hosts.
 * Implements ARP, IPv4 routing/forwarding, ICMP, ACLs, NAT/PAT, DHCP (server, relay,
 * client), IPv6 with NDP, RA/SLAAC and ICMPv6, plus the ping/traceroute primitives.
 */
import {
  broadcastOf,
  formatIPv4,
  inSubnet,
  networkOf,
  prefixToMask,
  isMulticast4,
  type IPv4,
} from '../net/ipv4';
import {
  ALL_NODES,
  ALL_ROUTERS,
  eui64,
  formatIPv6,
  inPrefix6,
  isLinkLocal6,
  isMulticast6,
  linkLocalFromMac,
  multicastMac6,
  network6,
  solicitedNode,
  type IPv6,
} from '../net/ipv6';
import { BROADCAST_MAC, macToCisco, type Mac } from '../net/mac';
import {
  DHCP,
  ICMP6,
  IPPROTO,
  type ArpPacket,
  type DhcpMessage,
  type EthernetFrame,
  type Icmp4,
  type Icmp6,
  type IPv4Packet,
  type IPv6Packet,
  type UdpDatagram,
} from '../net/packets';
import type { Device } from '../devices/device';
import { evaluateAcl, type Acl } from './acl';
import { flowOf, NAT_TIMEOUTS, rewrite, type NatDynamic, type NatPool, type NatStatic, type NatTranslation } from './nat';

// ============================================================================ types

export interface Addr4 {
  addr: IPv4;
  prefix: number;
  secondary?: boolean;
  source: 'manual' | 'dhcp' | 'apipa';
}

export interface Addr6 {
  addr: IPv6;
  prefix: number;
  source: 'manual' | 'eui64' | 'slaac' | 'linklocal';
}

export interface DhcpLease {
  addr: IPv4;
  prefix: number;
  gateway?: IPv4;
  dns: IPv4[];
  domain?: string;
  server: IPv4;
  obtained: number;
  expires: number;
}

export interface DhcpClientState {
  state: 'init' | 'selecting' | 'requesting' | 'bound' | 'failed';
  xid: number;
  tries: number;
  offer?: DhcpMessage;
  lease?: DhcpLease;
  timer?: { cancelled: boolean };
}

/** A layer 3 interface: routed port, subinterface, SVI, loopback or host NIC. */
export interface L3If {
  name: string;
  short: string;
  mac: Mac;
  v4: Addr4[];
  v6: Addr6[];
  /** IPv6 processing enabled (IOS: "ipv6 enable" or any IPv6 address; hosts: always). */
  v6Enabled: boolean;
  /** Line protocol up. */
  isUp(): boolean;
  /** Sends a frame (the interface adds the 802.1Q tag when needed). */
  tx(f: EthernetFrame): void;
  aclIn?: string;
  aclOut?: string;
  nat?: 'inside' | 'outside';
  helpers: IPv4[];
  dhcp?: DhcpClientState;
  /** Host-side: request IPv6 autoconfiguration from RAs. */
  slaac?: boolean;
  raSuppress?: boolean;
  loopback?: boolean;
  /** Duplicate address detected (Windows shows "(Duplicado)"). */
  duplicate?: IPv4;
}

export interface Route4 {
  net: IPv4;
  prefix: number;
  code: 'C' | 'L' | 'S' | 'S*' | 'D';
  ad: number;
  metric: number;
  nextHop?: IPv4;
  iface?: L3If;
}

export interface Route6 {
  net: IPv6;
  prefix: number;
  code: 'C' | 'L' | 'S' | 'ND' | 'NDp';
  ad: number;
  metric: number;
  nextHop?: IPv6;
  iface?: L3If;
}

export interface StaticRoute4 {
  net: IPv4;
  prefix: number;
  nextHop?: IPv4;
  iface?: string;
  ad: number;
  permanent?: boolean;
}

export interface StaticRoute6 {
  net: IPv6;
  prefix: number;
  nextHop?: IPv6;
  iface?: string;
  ad: number;
}

export interface DhcpPool {
  name: string;
  network?: IPv4;
  prefix?: number;
  defaultRouter: IPv4[];
  dns: IPv4[];
  domain?: string;
  leaseSec: number;
}

export interface DhcpBinding {
  ip: IPv4;
  mac: Mac;
  pool: string;
  expires: number;
}

export interface ArpEntry {
  ip: IPv4;
  mac: Mac | null;
  iface: L3If;
  time: number;
  static?: boolean;
}

export interface NeighborEntry {
  ip: IPv6;
  mac: Mac | null;
  iface: L3If;
  time: number;
  router: boolean;
}

export type EchoResult =
  | { type: 'reply'; from: IPv4 | IPv6; ttl: number; rtt: number; bytes: number }
  | { type: 'timeout' }
  | { type: 'unreachable'; from: IPv4 | IPv6; code: number }
  | { type: 'ttl-exceeded'; from: IPv4 | IPv6; rtt: number }
  | { type: 'port-unreachable'; from: IPv4 | IPv6; rtt: number }
  | { type: 'local-error'; reason: 'no-route' | 'arp-failed' | 'no-source' };

export interface StackHooks {
  /** Console / syslog message. */
  log?(msg: string): void;
  onDuplicate?(iface: L3If, ip: IPv4, mac: Mac): void;
  onDhcpChange?(iface: L3If): void;
}

interface Pending4 {
  pkt: IPv4Packet;
  iface: L3If;
  onFail?: () => void;
}

const IOS_ARP_TIMEOUT = 4 * 3600_000;
const HOST_ARP_TIMEOUT = 120_000;

// ============================================================================ stack

export class IpStack {
  // ------------------------------------------------------------ configuration
  routing = false;
  routing6 = false;
  /** Used for locally originated traffic when routing is disabled. */
  defaultGateway?: IPv4;
  defaultGateway6?: IPv6;
  statics4: StaticRoute4[] = [];
  statics6: StaticRoute6[] = [];
  acls = new Map<string, Acl>();
  natStatics: NatStatic[] = [];
  natDynamics: NatDynamic[] = [];
  natPools = new Map<string, NatPool>();
  dhcpPools = new Map<string, DhcpPool>();
  dhcpExcluded: [IPv4, IPv4][] = [];
  dhcpService = true;
  /** IOS drops the packet that triggers ARP; hosts queue it. */
  arpMode: 'drop' | 'queue' = 'queue';
  /** IOS sends ICMP unreachables by default. */
  unreachables = true;
  hostname = '';
  dnsServers: IPv4[] = [];
  /** Windows APIPA fallback when DHCP fails. */
  apipa = false;
  dhcpRetries = 4;

  // ------------------------------------------------------------ dynamic state
  arp = new Map<string, ArpEntry>();
  neighbors = new Map<string, NeighborEntry>();
  natTable: NatTranslation[] = [];
  dhcpBindings = new Map<Mac, DhcpBinding>();
  /** Default routers learned from RAs (hosts). */
  raRouters = new Map<string, { addr: IPv6; iface: L3If; expires: number }>();
  private pending4 = new Map<string, { queue: Pending4[]; tries: number }>();
  private pending6 = new Map<string, { queue: IPv6Packet[]; iface: L3If; tries: number }>();
  private echoWaiters = new Map<string, { cb: (r: EchoResult) => void; sent: number; done: boolean }>();
  private ipId = 1;
  private echoId = 1;
  private probePort = 33434;

  constructor(
    private readonly dev: Device,
    readonly ifaces: () => L3If[],
    private readonly hooks: StackHooks = {},
  ) {}

  private get now() {
    return this.dev.simulator.now;
  }

  reset() {
    this.arp.clear();
    this.neighbors.clear();
    this.natTable = [];
    this.dhcpBindings.clear();
    this.raRouters.clear();
    this.pending4.clear();
    this.pending6.clear();
    this.echoWaiters.clear();
  }

  private log(msg: string) {
    this.hooks.log?.(msg);
  }

  // ========================================================================= addressing

  ownsV4(ip: IPv4): L3If | undefined {
    return this.ifaces().find((i) => i.v4.some((a) => a.addr === ip));
  }

  ownsV6(ip: IPv6): L3If | undefined {
    return this.ifaces().find((i) => i.v6Enabled && i.v6.some((a) => a.addr === ip));
  }

  primary4(i: L3If): Addr4 | undefined {
    return i.v4.find((a) => !a.secondary);
  }

  linkLocal(i: L3If): IPv6 | undefined {
    return i.v6.find((a) => a.source === 'linklocal')?.addr;
  }

  /** Ensures the automatic link-local address exists on IPv6-enabled interfaces. */
  syncLinkLocal(i: L3If) {
    if (!i.v6Enabled) {
      i.v6 = i.v6.filter((a) => a.source !== 'linklocal' && a.source !== 'slaac');
      return;
    }
    if (!i.v6.some((a) => a.source === 'linklocal')) i.v6.unshift({ addr: linkLocalFromMac(i.mac), prefix: 64, source: 'linklocal' });
  }

  ifByName(name: string): L3If | undefined {
    const n = name.toLowerCase();
    return this.ifaces().find((i) => i.name.toLowerCase() === n || i.short.toLowerCase() === n);
  }

  // ========================================================================= routing tables

  routes4(): Route4[] {
    const out: Route4[] = [];
    for (const i of this.ifaces()) {
      if (!i.isUp()) continue;
      for (const a of i.v4) {
        const net = networkOf(a.addr, a.prefix);
        if (!out.some((r) => r.code === 'C' && r.net === net && r.prefix === a.prefix)) out.push({ net, prefix: a.prefix, code: 'C', ad: 0, metric: 0, iface: i });
        out.push({ net: a.addr, prefix: 32, code: 'L', ad: 0, metric: 0, iface: i });
      }
    }
    const coveredByConnected = (nh: IPv4) => out.some((r) => r.code === 'C' && inSubnet(nh, r.net, r.prefix));
    const resolvable = (nh: IPv4, self: StaticRoute4 | null, depth: number): boolean =>
      coveredByConnected(nh) ||
      (depth < 4 &&
        this.statics4.some((o) => o !== self && o.nextHop !== undefined && inSubnet(nh, o.net, o.prefix) && resolvable(o.nextHop, o, depth + 1)));
    const candidates: Route4[] = [];
    const isHost = this.dev.model.os === 'windows' || this.dev.model.os === 'linux';
    if (this.routing || isHost) {
      for (const s of this.statics4) {
        const iface = s.iface ? this.ifByName(s.iface) : undefined;
        if (s.iface && (!iface || !iface.isUp())) continue;
        if (!s.iface && s.nextHop !== undefined && !resolvable(s.nextHop, s, 0)) continue;
        candidates.push({ net: s.net, prefix: s.prefix, code: s.prefix === 0 ? 'S*' : 'S', ad: s.ad, metric: 0, nextHop: s.nextHop, iface });
      }
    }
    // Default gateway learned by DHCP (IOS installs it with AD 254).
    for (const i of this.ifaces()) {
      const gw = i.dhcp?.state === 'bound' ? i.dhcp.lease?.gateway : undefined;
      if (gw !== undefined && i.isUp() && coveredByConnected(gw)) candidates.push({ net: 0, prefix: 0, code: 'S*', ad: 254, metric: 0, nextHop: gw });
    }
    if (!this.routing && this.defaultGateway !== undefined && coveredByConnected(this.defaultGateway)) {
      candidates.push({ net: 0, prefix: 0, code: 'S*', ad: 1, metric: 0, nextHop: this.defaultGateway });
    }
    // Keep only the best administrative distance per prefix (floating statics stay hidden).
    const best = new Map<string, Route4>();
    for (const r of candidates) {
      if (out.some((c) => c.code === 'C' && c.net === r.net && c.prefix === r.prefix)) continue;
      const k = `${r.net}/${r.prefix}`;
      const cur = best.get(k);
      if (!cur || r.ad < cur.ad) best.set(k, r);
    }
    return [...out, ...best.values()];
  }

  lookup4(dst: IPv4): Route4 | undefined {
    let best: Route4 | undefined;
    for (const r of this.routes4()) {
      if (r.code === 'L') continue;
      if (!inSubnet(dst, r.net, r.prefix)) continue;
      if (!best || r.prefix > best.prefix || (r.prefix === best.prefix && r.ad < best.ad)) best = r;
    }
    return best;
  }

  /** Resolves a destination to an outgoing interface and next-hop address. */
  resolve4(dst: IPv4, depth = 0): { iface: L3If; nextHop: IPv4 } | undefined {
    const r = this.lookup4(dst);
    if (!r || depth > 8) return undefined;
    if (r.iface) return { iface: r.iface, nextHop: r.nextHop ?? dst };
    if (r.nextHop === undefined) return undefined;
    const inner = this.resolve4(r.nextHop, depth + 1);
    if (!inner) return undefined;
    return { iface: inner.iface, nextHop: inner.nextHop === r.nextHop || inner.nextHop === dst ? r.nextHop : inner.nextHop };
  }

  routes6(): Route6[] {
    const out: Route6[] = [];
    for (const i of this.ifaces()) {
      if (!i.isUp() || !i.v6Enabled) continue;
      for (const a of i.v6) {
        if (a.source === 'linklocal') continue;
        const net = network6(a.addr, a.prefix);
        if (!out.some((r) => r.code === 'C' && r.net === net && r.prefix === a.prefix && r.iface === i)) out.push({ net, prefix: a.prefix, code: 'C', ad: 0, metric: 0, iface: i });
        out.push({ net: a.addr, prefix: 128, code: 'L', ad: 0, metric: 0, iface: i });
      }
    }
    const best = new Map<string, Route6>();
    const add = (r: Route6) => {
      const k = `${r.net}/${r.prefix}`;
      if (out.some((c) => c.code === 'C' && c.net === r.net && c.prefix === r.prefix)) return;
      const cur = best.get(k);
      if (!cur || r.ad < cur.ad) best.set(k, r);
    };
    for (const s of this.statics6) {
      const iface = s.iface ? this.ifByName(s.iface) : undefined;
      if (s.iface && (!iface || !iface.isUp())) continue;
      add({ net: s.net, prefix: s.prefix, code: 'S', ad: s.ad, metric: 0, nextHop: s.nextHop, iface });
    }
    if (!this.routing6) {
      for (const r of this.raRouters.values()) {
        if (r.expires > this.now && r.iface.isUp()) add({ net: 0n, prefix: 0, code: 'ND', ad: 2, metric: 0, nextHop: r.addr, iface: r.iface });
      }
      if (this.defaultGateway6 !== undefined) add({ net: 0n, prefix: 0, code: 'S', ad: 1, metric: 0, nextHop: this.defaultGateway6 });
    }
    return [...out, ...best.values()];
  }

  lookup6(dst: IPv6): Route6 | undefined {
    let best: Route6 | undefined;
    for (const r of this.routes6()) {
      if (r.code === 'L') continue;
      if (!inPrefix6(dst, r.net, r.prefix)) continue;
      if (!best || r.prefix > best.prefix || (r.prefix === best.prefix && r.ad < best.ad)) best = r;
    }
    return best;
  }

  resolve6(dst: IPv6, depth = 0): { iface: L3If; nextHop: IPv6 } | undefined {
    const r = this.lookup6(dst);
    if (!r || depth > 8) return undefined;
    if (r.iface) return { iface: r.iface, nextHop: r.nextHop ?? dst };
    if (r.nextHop === undefined) return undefined;
    const inner = this.resolve6(r.nextHop, depth + 1);
    if (!inner) return undefined;
    return { iface: inner.iface, nextHop: r.nextHop };
  }

  // ========================================================================= receive

  receive(iface: L3If, f: EthernetFrame, traceId?: number) {
    const p = f.payload;
    if (p.kind === 'arp') this.receiveArp(iface, p, traceId);
    else if (p.kind === 'ipv4') this.receive4(iface, p, f, traceId);
    else if (p.kind === 'ipv6') this.receive6(iface, p, f, traceId);
  }

  // ------------------------------------------------------------------- ARP

  private arpTimeout() {
    return this.arpMode === 'drop' ? IOS_ARP_TIMEOUT : HOST_ARP_TIMEOUT;
  }

  arpLookup(iface: L3If, ip: IPv4): Mac | null | undefined {
    const e = this.arp.get(`${iface.name}|${ip}`);
    if (!e) return undefined;
    if (!e.static && e.mac && this.now - e.time > this.arpTimeout()) {
      this.arp.delete(`${iface.name}|${ip}`);
      return undefined;
    }
    return e.mac;
  }

  arpEntries(): ArpEntry[] {
    const out: ArpEntry[] = [];
    for (const [k, e] of this.arp) {
      if (!e.static && e.mac && this.now - e.time > this.arpTimeout()) {
        this.arp.delete(k);
        continue;
      }
      out.push(e);
    }
    return out;
  }

  private learnArp(iface: L3If, ip: IPv4, mac: Mac) {
    const k = `${iface.name}|${ip}`;
    const cur = this.arp.get(k);
    if (cur?.static) return;
    this.arp.set(k, { ip, mac, iface, time: this.now });
    const pend = this.pending4.get(k);
    if (pend) {
      this.pending4.delete(k);
      for (const q of pend.queue) this.emit4(q.iface, q.pkt, mac);
    }
  }

  private receiveArp(iface: L3If, a: ArpPacket, traceId?: number) {
    if (!iface.isUp()) return;
    const mine = iface.v4.find((x) => x.addr === a.targetIp);
    // Duplicate address detection.
    if (iface.v4.some((x) => x.addr === a.senderIp) && a.senderMac !== iface.mac) {
      iface.duplicate = a.senderIp;
      this.hooks.onDuplicate?.(iface, a.senderIp, a.senderMac);
      if (a.op === 1 && a.targetIp === a.senderIp) {
        // Defend our address with a reply.
        this.sendArp(iface, 2, a.senderIp, a.senderMac);
      }
      return;
    }
    const known = this.arp.has(`${iface.name}|${a.senderIp}`);
    if (mine || known) this.learnArp(iface, a.senderIp, a.senderMac);
    if (a.op === 1) {
      let answer = !!mine;
      // Router answers for NAT global addresses on outside interfaces.
      if (!answer && iface.nat === 'outside' && this.isNatGlobal(a.targetIp)) answer = true;
      if (answer) {
        this.dev.note(`${iface.short}: ARP request para ${formatIPv4(a.targetIp)} (meu endereço) — respondendo com ${iface.mac}`, 'info', traceId);
        this.sendArp(iface, 2, a.targetIp, a.senderMac, a.senderIp);
      }
    }
  }

  private sendArp(iface: L3If, op: 1 | 2, senderIp: IPv4, targetMac: Mac, targetIp?: IPv4) {
    const arp: ArpPacket =
      op === 1
        ? { kind: 'arp', op, senderMac: iface.mac, senderIp, targetMac: '00:00:00:00:00:00', targetIp: targetIp ?? senderIp }
        : { kind: 'arp', op, senderMac: iface.mac, senderIp, targetMac, targetIp: targetIp ?? senderIp };
    iface.tx({ src: iface.mac, dst: op === 1 ? BROADCAST_MAC : targetMac, payload: arp });
  }

  /** Gratuitous ARP announced when an address is configured or the link comes up. */
  gratuitousArp(iface: L3If) {
    if (!iface.isUp() || iface.loopback) return;
    for (const a of iface.v4) {
      iface.tx({
        src: iface.mac,
        dst: BROADCAST_MAC,
        payload: { kind: 'arp', op: 1, senderMac: iface.mac, senderIp: a.addr, targetMac: '00:00:00:00:00:00', targetIp: a.addr },
      });
    }
  }

  clearArp(iface?: L3If) {
    for (const [k, e] of this.arp) if (!e.static && (!iface || e.iface === iface)) this.arp.delete(k);
  }

  // ------------------------------------------------------------------- IPv4 receive

  private isForMe4(iface: L3If, p: IPv4Packet): boolean {
    if (p.dst === 0xffffffff) return true;
    if (this.ownsV4(p.dst)) return true;
    for (const a of iface.v4) if (a.prefix < 31 && p.dst === broadcastOf(a.addr, a.prefix)) return true;
    // DHCP client still without address.
    if (iface.dhcp && iface.dhcp.state !== 'bound' && p.payload.kind === 'udp' && p.payload.dstPort === 68) return true;
    return false;
  }

  private receive4(iface: L3If, p: IPv4Packet, f: EthernetFrame, traceId?: number) {
    if (!iface.isUp()) return;
    // Inbound ACL.
    if (iface.aclIn) {
      const acl = this.acls.get(iface.aclIn);
      const r = evaluateAcl(acl, p);
      if (!r.permit) {
        this.dev.note(`${iface.short}: pacote ${formatIPv4(p.src)} → ${formatIPv4(p.dst)} NEGADO pela ACL ${iface.aclIn} (entrada)${r.entry ? '' : ' — deny implícito no final da lista'}`, 'drop', traceId);
        if (r.entry?.log) this.log(`%SEC-6-IPACCESSLOGP: list ${iface.aclIn} denied ${formatIPv4(p.src)} -> ${formatIPv4(p.dst)}, 1 packet`);
        this.icmpError(p, 3, 13, iface);
        return;
      }
    }
    // NAT outside → inside happens before routing.
    if (iface.nat === 'outside') {
      const t = this.natOutToIn(p);
      if (t) {
        this.dev.note(`NAT: destino ${formatIPv4(p.dst)} traduzido para ${formatIPv4(t.dst)} (outside → inside)`, 'info', traceId);
        p = t;
      }
    }
    if (this.isForMe4(iface, p)) {
      this.local4(iface, p, f, traceId);
      return;
    }
    if (f.dst === BROADCAST_MAC || isMulticast4(p.dst)) return;
    if (!this.routing) {
      this.dev.note(`Pacote para ${formatIPv4(p.dst)} não é para mim e o roteamento está desabilitado: descartado`, 'drop', traceId);
      return;
    }
    this.forward4(iface, p, traceId);
  }

  private forward4(inIf: L3If, p: IPv4Packet, traceId?: number) {
    if (p.ttl <= 1) {
      this.dev.note(`TTL expirou (TTL=${p.ttl}) — descartando e enviando ICMP Time Exceeded para ${formatIPv4(p.src)}`, 'drop', traceId);
      this.icmpError(p, 11, 0, inIf);
      return;
    }
    const r = this.resolve4(p.dst);
    if (!r) {
      this.dev.note(`Sem rota para ${formatIPv4(p.dst)} na tabela de roteamento — descartando (ICMP Destination Unreachable)`, 'drop', traceId);
      this.icmpError(p, 3, 1, inIf);
      return;
    }
    let out: IPv4Packet = { ...p, ttl: p.ttl - 1 };
    if (inIf.nat === 'inside' && r.iface.nat === 'outside') {
      const t = this.natInToOut(out);
      if (t === null) {
        this.dev.note(`NAT: sem endereço global disponível para ${formatIPv4(p.src)} — descartando`, 'drop', traceId);
        return;
      }
      if (t !== out) this.dev.note(`NAT: origem ${formatIPv4(out.src)} traduzida para ${formatIPv4(t.src)} (inside → outside)`, 'info', traceId);
      out = t;
    }
    if (r.iface.aclOut) {
      const res = evaluateAcl(this.acls.get(r.iface.aclOut), out);
      if (!res.permit) {
        this.dev.note(`${r.iface.short}: pacote ${formatIPv4(out.src)} → ${formatIPv4(out.dst)} NEGADO pela ACL ${r.iface.aclOut} (saída)`, 'drop', traceId);
        this.icmpError(p, 3, 13, inIf);
        return;
      }
    }
    this.dev.note(`Roteando ${formatIPv4(p.dst)} via ${r.iface.short}${r.nextHop !== p.dst ? ` (próximo salto ${formatIPv4(r.nextHop)})` : ' (rede conectada)'}, TTL ${p.ttl} → ${out.ttl}`, 'info', traceId);
    this.output4(r.iface, r.nextHop, out);
  }

  /** Sends an IPv4 packet to a next hop on an interface (resolving ARP). */
  output4(iface: L3If, nextHop: IPv4, p: IPv4Packet, onFail?: () => void) {
    if (!iface.isUp()) return onFail?.();
    if (iface.loopback) {
      // Delivered to ourselves.
      this.dev.simulator.schedule(0, () => this.receive4(iface, p, { src: iface.mac, dst: iface.mac, payload: p }));
      return;
    }
    const bcast = p.dst === 0xffffffff || iface.v4.some((a) => a.prefix < 31 && p.dst === broadcastOf(a.addr, a.prefix));
    if (bcast) return this.emit4(iface, p, BROADCAST_MAC);
    const k = `${iface.name}|${nextHop}`;
    const mac = this.arpLookup(iface, nextHop);
    if (mac) return this.emit4(iface, p, mac);
    const src = this.primary4(iface)?.addr ?? 0;
    let pend = this.pending4.get(k);
    if (pend) {
      if (this.arpMode === 'queue') pend.queue.push({ pkt: p, iface, onFail });
      return;
    }
    pend = { queue: this.arpMode === 'queue' ? [{ pkt: p, iface, onFail }] : [], tries: 0 };
    this.pending4.set(k, pend);
    if (this.arpMode === 'drop') {
      this.arp.set(k, { ip: nextHop, mac: null, iface, time: this.now });
      this.dev.note(`Endereço MAC de ${formatIPv4(nextHop)} desconhecido: enviando ARP request e descartando este pacote (comportamento do IOS)`, 'drop');
    } else {
      this.dev.note(`Endereço MAC de ${formatIPv4(nextHop)} desconhecido: pacote aguardando a resolução ARP`, 'info');
    }
    const attempt = () => {
      const cur = this.pending4.get(k);
      if (!cur) return;
      if (cur.tries >= 3) {
        this.pending4.delete(k);
        if (this.arp.get(k)?.mac === null) this.arp.delete(k);
        for (const q of cur.queue) q.onFail?.();
        return;
      }
      cur.tries++;
      this.sendArp(iface, 1, src, BROADCAST_MAC, nextHop);
      this.dev.timer(1000, attempt);
    };
    attempt();
  }

  private emit4(iface: L3If, p: IPv4Packet, mac: Mac) {
    iface.tx({ src: iface.mac, dst: mac, payload: p });
  }

  /** Originates an IPv4 packet from this device. */
  originate4(p: Omit<IPv4Packet, 'src' | 'id' | 'kind'> & { src?: IPv4 }, onFail?: (reason: 'no-route' | 'arp-failed' | 'no-source') => void): IPv4 | undefined {
    if (p.dst === 0xffffffff) return undefined;
    // Destination is one of our own addresses.
    const own = this.ownsV4(p.dst);
    if (own) {
      const pkt: IPv4Packet = { kind: 'ipv4', ...p, src: p.src ?? p.dst, id: this.ipId++ };
      this.dev.simulator.schedule(0, () => this.local4(own, pkt, { src: own.mac, dst: own.mac, payload: pkt }));
      return pkt.src;
    }
    const r = this.resolve4(p.dst);
    if (!r) {
      onFail?.('no-route');
      return undefined;
    }
    const src = p.src ?? this.primary4(r.iface)?.addr;
    if (src === undefined) {
      onFail?.('no-source');
      return undefined;
    }
    const pkt: IPv4Packet = { kind: 'ipv4', ...p, src, id: this.ipId++ };
    this.output4(r.iface, r.nextHop, pkt, () => onFail?.('arp-failed'));
    return src;
  }

  // ------------------------------------------------------------------- local delivery v4

  private local4(iface: L3If, p: IPv4Packet, _f: EthernetFrame, traceId?: number) {
    const q = p.payload;
    if (q.kind === 'icmp') {
      if (q.type === 8) {
        if (p.dst === 0xffffffff) return;
        this.dev.note(`ICMP Echo Request de ${formatIPv4(p.src)} para mim — respondendo com Echo Reply`, 'info', traceId);
        this.originate4({ dst: p.src, src: p.dst, ttl: this.defaultTtl(), protocol: IPPROTO.ICMP, payload: { kind: 'icmp', type: 0, code: 0, id: q.id, seq: q.seq, data: q.data } });
        return;
      }
      this.icmpToApps4(p, q);
      return;
    }
    if (q.kind === 'udp') {
      if (q.payload.kind === 'dhcp') {
        if (q.dstPort === 67) return this.dhcpServerOrRelay(iface, p, q.payload, traceId);
        if (q.dstPort === 68 && iface.dhcp) return this.dhcpClientReceive(iface, q.payload);
        return;
      }
      if (q.dstPort >= 33434 && q.dstPort < 33534 && p.dst !== 0xffffffff) {
        this.icmpError(p, 3, 3, iface, true);
      }
      return;
    }
  }

  private defaultTtl() {
    // Windows uses 128, Linux and IOS use 64 / 255.
    if (this.dev.model.os === 'windows') return 128;
    if (this.dev.model.os === 'linux') return 64;
    return 255;
  }

  private icmpError(orig: IPv4Packet, type: number, code: number, inIf: L3If, force = false) {
    if (!this.unreachables && type === 3 && !force) return;
    // Never answer ICMP errors with ICMP errors.
    if (orig.payload.kind === 'icmp' && orig.payload.type !== 8 && orig.payload.type !== 0) return;
    if (orig.src === 0 || orig.dst === 0xffffffff) return;
    const src = type === 3 && code === 3 ? orig.dst : this.primary4(inIf)?.addr;
    this.originate4({ dst: orig.src, src, ttl: 255, protocol: IPPROTO.ICMP, payload: { kind: 'icmp', type, code, original: orig } });
  }

  private icmpToApps4(p: IPv4Packet, q: Icmp4) {
    if (q.type === 0) {
      const w = this.echoWaiters.get(`4|${q.id}|${q.seq}`);
      if (w && !w.done) {
        w.done = true;
        w.cb({ type: 'reply', from: p.src, ttl: p.ttl, rtt: this.now - w.sent, bytes: q.data ?? 32 });
      }
      return;
    }
    const o = q.original;
    if (!o) return;
    let key: string | undefined;
    if (o.payload.kind === 'icmp') key = `4|${o.payload.id}|${o.payload.seq}`;
    else if (o.payload.kind === 'udp') key = `4u|${o.payload.dstPort}`;
    if (!key) return;
    const w = this.echoWaiters.get(key);
    if (!w || w.done) return;
    w.done = true;
    const rtt = this.now - w.sent;
    if (q.type === 11) w.cb({ type: 'ttl-exceeded', from: p.src, rtt });
    else if (q.type === 3 && q.code === 3) w.cb({ type: 'port-unreachable', from: p.src, rtt });
    else if (q.type === 3) w.cb({ type: 'unreachable', from: p.src, code: q.code });
  }

  // ------------------------------------------------------------------- apps: ping / traceroute v4

  /** Sends one ICMP echo request; the callback is called exactly once. */
  echo4(dst: IPv4, opts: { size?: number; ttl?: number; src?: IPv4; timeout?: number; seq: number; id?: number }, cb: (r: EchoResult) => void): number {
    const id = opts.id ?? this.echoId++;
    const key = `4|${id}|${opts.seq}`;
    const w = { cb, sent: this.now, done: false };
    this.echoWaiters.set(key, w);
    const finish = (r: EchoResult) => {
      if (w.done) return;
      w.done = true;
      this.echoWaiters.delete(key);
      cb(r);
    };
    w.cb = (r) => {
      this.echoWaiters.delete(key);
      cb(r);
    };
    this.originate4(
      { dst, src: opts.src, ttl: opts.ttl ?? this.defaultTtl(), protocol: IPPROTO.ICMP, payload: { kind: 'icmp', type: 8, code: 0, id, seq: opts.seq, data: opts.size ?? 32 } },
      (reason) => {
        // Windows reports local ARP failures as "Destination host unreachable".
        this.dev.simulator.schedule(reason === 'arp-failed' ? 0 : 0, () => finish({ type: 'local-error', reason }));
      },
    );
    this.dev.timer(opts.timeout ?? 2000, () => finish({ type: 'timeout' }));
    return id;
  }

  /** UDP probe for traceroute (IOS and Linux). */
  probe4(dst: IPv4, ttl: number, timeout: number, cb: (r: EchoResult) => void) {
    const port = this.probePort++;
    if (this.probePort > 33533) this.probePort = 33434;
    const key = `4u|${port}`;
    const w = { cb, sent: this.now, done: false };
    this.echoWaiters.set(key, w);
    const finish = (r: EchoResult) => {
      if (w.done) return;
      w.done = true;
      this.echoWaiters.delete(key);
      cb(r);
    };
    w.cb = (r) => {
      this.echoWaiters.delete(key);
      cb(r);
    };
    this.originate4(
      { dst, ttl, protocol: IPPROTO.UDP, payload: { kind: 'udp', srcPort: 49152 + (port % 1000), dstPort: port, payload: { kind: 'raw', length: 12 } } },
      (reason) => finish({ type: 'local-error', reason }),
    );
    this.dev.timer(timeout, () => finish({ type: 'timeout' }));
  }

  // ========================================================================= NAT

  private natAclPermits(acl: string, p: IPv4Packet): boolean {
    const a = this.acls.get(acl);
    if (!a) return false;
    return evaluateAcl(a, p).permit;
  }

  isNatGlobal(ip: IPv4): boolean {
    if (this.natStatics.some((s) => s.global === ip)) return true;
    for (const pool of this.natPools.values()) if (ip >= pool.start && ip <= pool.end) return true;
    return false;
  }

  private natExpire() {
    const now = this.now;
    this.natTable = this.natTable.filter((t) => {
      if (t.static) return true;
      const tmo = t.proto === null ? NAT_TIMEOUTS.simple : NAT_TIMEOUTS[t.proto];
      return now - t.lastUsed < tmo;
    });
  }

  natTranslations(): NatTranslation[] {
    this.natExpire();
    // Static entries are always listed.
    const statics: NatTranslation[] = this.natStatics.map((s) => ({
      proto: s.proto ?? null,
      insideLocal: s.local,
      insideLocalPort: s.localPort,
      insideGlobal: s.global,
      insideGlobalPort: s.globalPort,
      static: true,
      created: 0,
      lastUsed: 0,
    }));
    return [...this.natTable, ...statics];
  }

  clearNat() {
    this.natTable = [];
  }

  /** Returns the translated packet, the same packet if no rule applies, or null if it must be dropped. */
  private natInToOut(p: IPv4Packet): IPv4Packet | null {
    this.natExpire();
    const flow = flowOf(p, 'src');
    const dflow = flowOf(p, 'dst');
    // Static NAT.
    for (const s of this.natStatics) {
      if (s.local !== p.src) continue;
      if (s.proto) {
        if (s.proto !== flow.proto || s.localPort !== flow.port) continue;
        return rewrite(p, 'src', s.global, s.globalPort);
      }
      return rewrite(p, 'src', s.global);
    }
    // Existing dynamic entry.
    const existing = this.natTable.find(
      (t) =>
        t.insideLocal === p.src &&
        (t.proto === null || (t.proto === flow.proto && t.insideLocalPort === flow.port && t.outsideGlobal === p.dst)),
    );
    if (existing) {
      existing.lastUsed = this.now;
      return rewrite(p, 'src', existing.insideGlobal, existing.proto ? existing.insideGlobalPort : undefined);
    }
    for (const rule of this.natDynamics) {
      if (!this.natAclPermits(rule.acl, p)) continue;
      let candidates: IPv4[] = [];
      if (rule.iface) {
        const i = this.ifByName(rule.iface);
        const a = i && this.primary4(i);
        if (a) candidates = [a.addr];
      } else if (rule.pool) {
        const pool = this.natPools.get(rule.pool);
        if (pool) for (let ip = pool.start; ip <= pool.end; ip++) candidates.push(ip >>> 0);
      }
      if (!candidates.length) return null;
      if (rule.overload && flow.proto) {
        for (const g of candidates) {
          let port = flow.port ?? 1024;
          const used = (pt: number) => this.natTable.some((t) => t.insideGlobal === g && t.proto === flow.proto && t.insideGlobalPort === pt);
          let guard = 0;
          while (used(port) && guard++ < 65535) port = port >= 65535 ? 1024 : port + 1;
          const t: NatTranslation = {
            proto: flow.proto,
            insideLocal: p.src,
            insideLocalPort: flow.port,
            insideGlobal: g,
            insideGlobalPort: port,
            outsideGlobal: p.dst,
            outsideGlobalPort: dflow.port,
            static: false,
            created: this.now,
            lastUsed: this.now,
          };
          this.natTable.push(t);
          return rewrite(p, 'src', g, port);
        }
        return null;
      }
      const free = candidates.find((g) => !this.natTable.some((t) => t.insideGlobal === g) && !this.natStatics.some((s) => s.global === g));
      if (free === undefined) return null;
      this.natTable.push({ proto: null, insideLocal: p.src, insideGlobal: free, static: false, created: this.now, lastUsed: this.now });
      return rewrite(p, 'src', free);
    }
    return p;
  }

  private natOutToIn(p: IPv4Packet): IPv4Packet | undefined {
    this.natExpire();
    const flow = flowOf(p, 'dst');
    if (flow.proto) {
      const t = this.natTable.find((x) => x.proto === flow.proto && x.insideGlobal === p.dst && x.insideGlobalPort === flow.port);
      if (t) {
        t.lastUsed = this.now;
        return rewrite(p, 'dst', t.insideLocal, t.insideLocalPort);
      }
    }
    // ICMP errors about a translated flow.
    if (p.payload.kind === 'icmp' && p.payload.original) {
      const o = p.payload.original;
      const of = flowOf(o, 'src');
      const t = this.natTable.find((x) => x.insideGlobal === o.src && (x.proto === null || x.insideGlobalPort === of.port));
      if (t) {
        const inner = rewrite(o, 'src', t.insideLocal, t.proto ? t.insideLocalPort : undefined);
        return { ...p, dst: t.insideLocal, payload: { ...p.payload, original: inner } };
      }
    }
    for (const s of this.natStatics) {
      if (s.global !== p.dst) continue;
      if (s.proto) {
        if (s.proto !== flow.proto || s.globalPort !== flow.port) continue;
        return rewrite(p, 'dst', s.local, s.localPort);
      }
      return rewrite(p, 'dst', s.local);
    }
    const simple = this.natTable.find((x) => x.proto === null && x.insideGlobal === p.dst);
    if (simple) {
      simple.lastUsed = this.now;
      return rewrite(p, 'dst', simple.insideLocal);
    }
    return undefined;
  }

  // ========================================================================= DHCP server & relay

  private dhcpServerOrRelay(iface: L3If, p: IPv4Packet, d: DhcpMessage, traceId?: number) {
    if (d.op === 2) {
      // Reply from a server to a relay agent (us).
      const relayIf = this.ifaces().find((i) => i.v4.some((a) => a.addr === d.giaddr));
      if (!relayIf) return;
      this.dev.note(`Agente relay DHCP: repassando ${DHCP_NAME[d.msgType]} do servidor para o cliente na ${relayIf.short}`, 'info', traceId);
      const toBroadcast = d.broadcast || d.msgType === DHCP.NAK;
      this.sendDhcp(relayIf, { ...d }, this.primary4(relayIf)?.addr ?? 0, toBroadcast ? 0xffffffff : d.yiaddr, toBroadcast ? BROADCAST_MAC : d.chaddr, 67, 68);
      return;
    }
    // Server role first: a pool matching the subnet.
    const subnetIp = d.giaddr || this.primary4(iface)?.addr;
    if (this.dhcpService && subnetIp !== undefined) {
      const pool = [...this.dhcpPools.values()].find((pl) => pl.network !== undefined && inSubnet(subnetIp, pl.network, pl.prefix!));
      if (pool) {
        this.dhcpServe(iface, pool, d, traceId);
        return;
      }
    }
    // Relay (ip helper-address).
    if (iface.helpers.length && !d.giaddr && p.dst === 0xffffffff) {
      const gi = this.primary4(iface)?.addr;
      if (gi === undefined) return;
      this.dev.note(`ip helper-address: repassando DHCP ${DHCP_NAME[d.msgType]} em unicast para ${iface.helpers.map(formatIPv4).join(', ')} (giaddr ${formatIPv4(gi)})`, 'info', traceId);
      for (const h of iface.helpers) {
        this.originate4({ dst: h, src: gi, ttl: 255, protocol: IPPROTO.UDP, payload: { kind: 'udp', srcPort: 67, dstPort: 67, payload: { ...d, giaddr: gi } } });
      }
    }
  }

  private dhcpAllocate(pool: DhcpPool, mac: Mac): IPv4 | undefined {
    const cur = this.dhcpBindings.get(mac);
    if (cur && cur.pool === pool.name) return cur.ip;
    const net = pool.network!;
    const bcast = broadcastOf(net, pool.prefix!);
    const used = new Set([...this.dhcpBindings.values()].filter((b) => b.expires > this.now).map((b) => b.ip));
    for (let ip = net + 1; ip < bcast; ip++) {
      const a = ip >>> 0;
      if (used.has(a)) continue;
      if (this.dhcpExcluded.some(([lo, hi]) => a >= lo && a <= hi)) continue;
      if (this.ownsV4(a)) continue;
      return a;
    }
    return undefined;
  }

  private dhcpServe(iface: L3If, pool: DhcpPool, d: DhcpMessage, traceId?: number) {
    const serverId = d.giaddr ? this.primary4(iface)?.addr ?? 0 : this.primary4(iface)?.addr ?? 0;
    const reply = (msgType: number, yiaddr: IPv4) => {
      const msg: DhcpMessage = {
        kind: 'dhcp',
        op: 2,
        xid: d.xid,
        msgType,
        chaddr: d.chaddr,
        ciaddr: 0,
        yiaddr,
        siaddr: 0,
        giaddr: d.giaddr,
        broadcast: d.broadcast,
        options:
          msgType === DHCP.NAK
            ? { serverId }
            : {
                subnetMask: prefixToMask(pool.prefix!),
                router: pool.defaultRouter,
                dns: pool.dns,
                domainName: pool.domain,
                leaseTime: pool.leaseSec,
                serverId,
              },
      };
      if (d.giaddr) this.originate4({ dst: d.giaddr, src: serverId, ttl: 255, protocol: IPPROTO.UDP, payload: { kind: 'udp', srcPort: 67, dstPort: 67, payload: msg } });
      else this.sendDhcp(iface, msg, serverId, d.broadcast || msgType === DHCP.NAK ? 0xffffffff : yiaddr, d.broadcast ? BROADCAST_MAC : d.chaddr, 67, 68);
    };
    if (d.msgType === DHCP.DISCOVER) {
      const ip = this.dhcpAllocate(pool, d.chaddr);
      if (ip === undefined) {
        this.log(`%DHCPD-4-NO_ADDRESS: pool ${pool.name} is exhausted`);
        this.dev.note(`Servidor DHCP: pool ${pool.name} sem endereços livres`, 'warn', traceId);
        return;
      }
      this.dev.note(`Servidor DHCP (pool ${pool.name}): oferecendo ${formatIPv4(ip)} para ${d.chaddr}`, 'info', traceId);
      reply(DHCP.OFFER, ip);
    } else if (d.msgType === DHCP.REQUEST) {
      if (d.options.serverId !== undefined && !this.ownsV4(d.options.serverId)) {
        this.dev.note(`Servidor DHCP: cliente escolheu outro servidor (${formatIPv4(d.options.serverId)})`, 'info', traceId);
        return;
      }
      const wanted = d.options.requestedIp ?? d.ciaddr;
      const ok = wanted !== undefined && inSubnet(wanted, pool.network!, pool.prefix!) && (this.dhcpAllocate(pool, d.chaddr) === wanted || !([...this.dhcpBindings.values()].some((b) => b.ip === wanted && b.mac !== d.chaddr && b.expires > this.now)));
      if (!ok) {
        reply(DHCP.NAK, 0);
        return;
      }
      this.dhcpBindings.set(d.chaddr, { ip: wanted, mac: d.chaddr, pool: pool.name, expires: this.now + pool.leaseSec * 1000 });
      this.dev.note(`Servidor DHCP: confirmando ${formatIPv4(wanted)} para ${d.chaddr} (DHCPACK)`, 'info', traceId);
      reply(DHCP.ACK, wanted);
    } else if (d.msgType === DHCP.RELEASE) {
      const b = this.dhcpBindings.get(d.chaddr);
      if (b && b.ip === d.ciaddr) this.dhcpBindings.delete(d.chaddr);
    }
  }

  private sendDhcp(iface: L3If, msg: DhcpMessage, src: IPv4, dst: IPv4, dstMac: Mac, sport: number, dport: number) {
    const pkt: IPv4Packet = {
      kind: 'ipv4',
      src,
      dst,
      ttl: 255,
      id: this.ipId++,
      protocol: IPPROTO.UDP,
      payload: { kind: 'udp', srcPort: sport, dstPort: dport, payload: msg },
    };
    iface.tx({ src: iface.mac, dst: dstMac, payload: pkt });
  }

  // ========================================================================= DHCP client

  dhcpStart(iface: L3If) {
    this.dhcpStop(iface, false);
    iface.v4 = iface.v4.filter((a) => a.source === 'manual');
    iface.dhcp = { state: 'init', xid: Math.floor(this.dev.simulator.rng() * 0xffffffff) >>> 0, tries: 0 };
    this.hooks.onDhcpChange?.(iface);
    if (iface.isUp()) this.dhcpDiscover(iface);
  }

  /** Stops the client; with release=true sends DHCPRELEASE. */
  dhcpStop(iface: L3If, release: boolean) {
    const st = iface.dhcp;
    if (!st) return;
    if (st.timer) st.timer.cancelled = true;
    if (release && st.state === 'bound' && st.lease) {
      const msg = this.dhcpMsg(iface, DHCP.RELEASE, { serverId: st.lease.server });
      msg.ciaddr = st.lease.addr;
      this.originate4({ dst: st.lease.server, src: st.lease.addr, ttl: 128, protocol: IPPROTO.UDP, payload: { kind: 'udp', srcPort: 68, dstPort: 67, payload: msg } });
    }
    iface.v4 = iface.v4.filter((a) => a.source === 'manual');
    iface.dhcp = undefined;
    this.clearArp(iface);
    this.hooks.onDhcpChange?.(iface);
  }

  private dhcpMsg(iface: L3If, type: number, options: DhcpMessage['options'] = {}): DhcpMessage {
    return {
      kind: 'dhcp',
      op: 1,
      xid: iface.dhcp!.xid,
      msgType: type,
      chaddr: iface.mac,
      ciaddr: 0,
      yiaddr: 0,
      siaddr: 0,
      giaddr: 0,
      broadcast: false,
      options: { hostname: this.hostname || undefined, ...options },
    };
  }

  /** Called when the interface comes up. */
  dhcpLinkUp(iface: L3If) {
    const st = iface.dhcp;
    if (!st) return;
    if (st.state === 'bound' && st.lease) {
      // Re-confirm the lease (INIT-REBOOT).
      st.state = 'requesting';
      this.dhcpSend(iface, DHCP.REQUEST, { requestedIp: st.lease.addr });
      this.armDhcpTimer(iface);
      return;
    }
    if (st.state !== 'bound') this.dhcpDiscover(iface);
  }

  private dhcpSend(iface: L3If, type: number, opts: DhcpMessage['options']) {
    this.sendDhcp(iface, this.dhcpMsg(iface, type, opts), 0, 0xffffffff, BROADCAST_MAC, 68, 67);
  }

  private dhcpDiscover(iface: L3If) {
    const st = iface.dhcp;
    if (!st || !iface.isUp()) return;
    st.state = 'selecting';
    st.offer = undefined;
    st.tries++;
    this.dhcpSend(iface, DHCP.DISCOVER, {});
    this.armDhcpTimer(iface);
  }

  private armDhcpTimer(iface: L3If) {
    const st = iface.dhcp!;
    if (st.timer) st.timer.cancelled = true;
    const tok = { cancelled: false };
    st.timer = tok;
    this.dev.timer(4000, () => {
      if (tok.cancelled || iface.dhcp !== st) return;
      if (st.state === 'bound') return;
      if (st.tries >= this.dhcpRetries) {
        st.state = 'failed';
        if (this.apipa) {
          const b = iface.mac.split(':').map((h) => parseInt(h, 16));
          const addr = ((169 << 24) | (254 << 16) | ((b[4] % 254 || 1) << 8) | (b[5] || 1)) >>> 0;
          iface.v4 = [...iface.v4.filter((a) => a.source === 'manual'), { addr, prefix: 16, source: 'apipa' }];
        }
        this.hooks.onDhcpChange?.(iface);
        // Keep trying in the background, like real clients.
        this.dev.timer(60_000, () => {
          if (iface.dhcp === st && st.state === 'failed') {
            st.tries = 0;
            this.dhcpDiscover(iface);
          }
        });
        return;
      }
      this.dhcpDiscover(iface);
    });
  }

  private dhcpClientReceive(iface: L3If, d: DhcpMessage) {
    const st = iface.dhcp;
    if (!st || d.op !== 2 || d.xid !== st.xid || d.chaddr !== iface.mac) return;
    if (d.msgType === DHCP.OFFER && st.state === 'selecting') {
      st.offer = d;
      st.state = 'requesting';
      this.dhcpSend(iface, DHCP.REQUEST, { requestedIp: d.yiaddr, serverId: d.options.serverId });
      this.armDhcpTimer(iface);
    } else if (d.msgType === DHCP.ACK && st.state === 'requesting') {
      const mask = d.options.subnetMask ?? 0xffffff00;
      let prefix = 0;
      for (let m = mask; m & 0x80000000; m = (m << 1) >>> 0) prefix++;
      const lease: DhcpLease = {
        addr: d.yiaddr,
        prefix,
        gateway: d.options.router?.[0],
        dns: d.options.dns ?? [],
        domain: d.options.domainName,
        server: d.options.serverId ?? 0,
        obtained: this.now,
        expires: this.now + (d.options.leaseTime ?? 86400) * 1000,
      };
      st.lease = lease;
      st.state = 'bound';
      st.tries = 0;
      if (st.timer) st.timer.cancelled = true;
      iface.v4 = [...iface.v4.filter((a) => a.source === 'manual'), { addr: lease.addr, prefix, source: 'dhcp' }];
      iface.duplicate = undefined;
      this.dnsServers = lease.dns;
      this.log(`%DHCP-6-ADDRESS_ASSIGN: Interface ${iface.name} assigned DHCP address ${formatIPv4(lease.addr)}, mask ${formatIPv4(mask)}, hostname ${this.hostname}`);
      this.hooks.onDhcpChange?.(iface);
      this.gratuitousArp(iface);
    } else if (d.msgType === DHCP.NAK) {
      st.lease = undefined;
      st.tries = 0;
      iface.v4 = iface.v4.filter((a) => a.source === 'manual');
      this.dhcpDiscover(iface);
    }
  }

  // ========================================================================= IPv6

  private isForMe6(iface: L3If, dst: IPv6): boolean {
    if (dst === ALL_NODES) return true;
    if (dst === ALL_ROUTERS) return this.routing6;
    if (isMulticast6(dst)) return iface.v6.some((a) => solicitedNode(a.addr) === dst);
    return !!this.ownsV6(dst);
  }

  private receive6(iface: L3If, p: IPv6Packet, f: EthernetFrame, traceId?: number) {
    if (!iface.isUp() || !iface.v6Enabled) return;
    if (this.isForMe6(iface, p.dst)) {
      this.local6(iface, p, f, traceId);
      return;
    }
    if (isMulticast6(p.dst)) return;
    if (!this.routing6) {
      this.dev.note(`Pacote IPv6 para ${formatIPv6(p.dst)} não é para mim e o roteamento IPv6 está desabilitado: descartado`, 'drop', traceId);
      return;
    }
    if (isLinkLocal6(p.src) || isLinkLocal6(p.dst)) {
      this.dev.note(`Endereços link-local não são roteados: descartado`, 'drop', traceId);
      return;
    }
    if (p.hopLimit <= 1) {
      this.dev.note(`Hop limit expirou — enviando ICMPv6 Time Exceeded`, 'drop', traceId);
      this.icmp6Error(p, ICMP6.TIME_EXCEEDED, 0, iface);
      return;
    }
    const r = this.resolve6(p.dst);
    if (!r) {
      this.dev.note(`Sem rota IPv6 para ${formatIPv6(p.dst)} — descartando`, 'drop', traceId);
      this.icmp6Error(p, ICMP6.DEST_UNREACH, 0, iface);
      return;
    }
    this.dev.note(`Roteando IPv6 ${formatIPv6(p.dst)} via ${r.iface.short}`, 'info', traceId);
    this.output6(r.iface, r.nextHop, { ...p, hopLimit: p.hopLimit - 1 });
  }

  neighborEntries(): NeighborEntry[] {
    return [...this.neighbors.values()];
  }

  private learnNeighbor(iface: L3If, ip: IPv6, mac: Mac, router = false) {
    const k = `${iface.name}|${ip}`;
    const cur = this.neighbors.get(k);
    this.neighbors.set(k, { ip, mac, iface, time: this.now, router: router || !!cur?.router });
    const pend = this.pending6.get(k);
    if (pend) {
      this.pending6.delete(k);
      for (const q of pend.queue) iface.tx({ src: iface.mac, dst: mac, payload: q });
    }
  }

  private srcFor6(iface: L3If, dst: IPv6): IPv6 | undefined {
    if (isLinkLocal6(dst) || isMulticast6(dst)) return this.linkLocal(iface);
    return iface.v6.find((a) => a.source !== 'linklocal')?.addr ?? this.linkLocal(iface);
  }

  output6(iface: L3If, nextHop: IPv6, p: IPv6Packet) {
    if (!iface.isUp()) return;
    if (iface.loopback) {
      this.dev.simulator.schedule(0, () => this.receive6(iface, p, { src: iface.mac, dst: iface.mac, payload: p }));
      return;
    }
    if (isMulticast6(p.dst)) {
      iface.tx({ src: iface.mac, dst: multicastMac6(p.dst), payload: p });
      return;
    }
    const k = `${iface.name}|${nextHop}`;
    const n = this.neighbors.get(k);
    if (n?.mac) {
      iface.tx({ src: iface.mac, dst: n.mac, payload: p });
      return;
    }
    let pend = this.pending6.get(k);
    if (pend) {
      pend.queue.push(p);
      return;
    }
    pend = { queue: [p], iface, tries: 0 };
    this.pending6.set(k, pend);
    this.dev.note(`Endereço MAC de ${formatIPv6(nextHop)} desconhecido: enviando Neighbor Solicitation`, 'info');
    const attempt = () => {
      const cur = this.pending6.get(k);
      if (!cur) return;
      if (cur.tries >= 3) {
        this.pending6.delete(k);
        return;
      }
      cur.tries++;
      this.sendNs(iface, nextHop);
      this.dev.timer(1000, attempt);
    };
    attempt();
  }

  private sendNs(iface: L3If, target: IPv6) {
    const dst = solicitedNode(target);
    const src = this.srcFor6(iface, target);
    if (src === undefined) return;
    this.emitIcmp6(iface, src, dst, { kind: 'icmpv6', type: ICMP6.NS, code: 0, target, lladdr: iface.mac }, multicastMac6(dst));
  }

  private emitIcmp6(iface: L3If, src: IPv6, dst: IPv6, m: Icmp6, dstMac: Mac, hopLimit = 255) {
    const p: IPv6Packet = { kind: 'ipv6', src, dst, hopLimit, nextHeader: IPPROTO.ICMPV6, payload: m };
    iface.tx({ src: iface.mac, dst: dstMac, payload: p });
  }

  /** Router advertisement on an interface (to all nodes, or unicast to a soliciting host). */
  sendRa(iface: L3If, to?: { ip: IPv6; mac: Mac }) {
    if (!this.routing6 || iface.raSuppress || !iface.isUp() || !iface.v6Enabled || iface.loopback) return;
    const ll = this.linkLocal(iface);
    if (ll === undefined) return;
    const prefixes = iface.v6
      .filter((a) => a.source !== 'linklocal')
      .map((a) => ({ prefix: network6(a.addr, a.prefix), length: a.prefix, onLink: true, autonomous: a.prefix === 64, valid: 2592000, preferred: 604800 }));
    const uniq = prefixes.filter((x, i) => prefixes.findIndex((y) => y.prefix === x.prefix && y.length === x.length) === i);
    this.emitIcmp6(
      iface,
      ll,
      to?.ip ?? ALL_NODES,
      { kind: 'icmpv6', type: ICMP6.RA, code: 0, lladdr: iface.mac, ra: { curHopLimit: 64, managed: false, other: false, routerLifetime: 1800, prefixes: uniq, mtu: 1500 } },
      to?.mac ?? multicastMac6(ALL_NODES),
    );
  }

  sendRs(iface: L3If) {
    const ll = this.linkLocal(iface);
    if (ll === undefined || !iface.isUp()) return;
    this.emitIcmp6(iface, ll, ALL_ROUTERS, { kind: 'icmpv6', type: ICMP6.RS, code: 0, lladdr: iface.mac }, multicastMac6(ALL_ROUTERS));
  }

  private local6(iface: L3If, p: IPv6Packet, _f: EthernetFrame, traceId?: number) {
    const q = p.payload;
    if (q.kind === 'udp') {
      if (q.dstPort >= 33434 && q.dstPort < 33534 && !isMulticast6(p.dst)) this.icmp6Error(p, ICMP6.DEST_UNREACH, 4, iface, p.dst);
      return;
    }
    if (q.kind !== 'icmpv6') return;
    switch (q.type) {
      case ICMP6.NS: {
        const target = q.target ?? 0n;
        if (!iface.v6.some((a) => a.addr === target)) return;
        if (q.lladdr && p.src !== 0n) this.learnNeighbor(iface, p.src, q.lladdr);
        this.dev.note(`Neighbor Solicitation para ${formatIPv6(target)} (meu endereço) — respondendo com Neighbor Advertisement`, 'info', traceId);
        const dst = p.src === 0n ? ALL_NODES : p.src;
        const dstMac = p.src === 0n ? multicastMac6(ALL_NODES) : (q.lladdr ?? multicastMac6(ALL_NODES));
        this.emitIcmp6(iface, target, dst, { kind: 'icmpv6', type: ICMP6.NA, code: 0, target, lladdr: iface.mac, naFlags: { router: this.routing6, solicited: p.src !== 0n, override: true } }, dstMac);
        return;
      }
      case ICMP6.NA:
        if (q.target !== undefined && q.lladdr) {
          if (iface.v6.some((a) => a.addr === q.target)) {
            this.log(`%IPV6_ND-4-DUPLICATE: Duplicate address ${formatIPv6(q.target, true)} on ${iface.name}`);
            return;
          }
          this.learnNeighbor(iface, q.target, q.lladdr, q.naFlags?.router);
        }
        return;
      case ICMP6.RS:
        if (q.lladdr && p.src !== 0n) this.learnNeighbor(iface, p.src, q.lladdr);
        if (this.routing6) {
          this.dev.note(`Router Solicitation recebida — enviando Router Advertisement`, 'info', traceId);
          this.sendRa(iface);
        }
        return;
      case ICMP6.RA:
        if (this.routing6) return;
        if (q.lladdr) this.learnNeighbor(iface, p.src, q.lladdr, true);
        if (q.ra) {
          const life = q.ra.routerLifetime * 1000;
          const k = `${iface.name}|${p.src}`;
          if (life > 0) this.raRouters.set(k, { addr: p.src, iface, expires: this.now + life });
          else this.raRouters.delete(k);
          if (iface.slaac) {
            for (const pf of q.ra.prefixes) {
              if (!pf.autonomous || pf.length !== 64) continue;
              const addr = network6(pf.prefix, 64) | eui64(iface.mac);
              if (!iface.v6.some((a) => a.addr === addr)) {
                iface.v6.push({ addr, prefix: 64, source: 'slaac' });
                this.dev.note(`SLAAC: prefixo ${formatIPv6(pf.prefix)}/64 recebido no RA — endereço ${formatIPv6(addr)} configurado (EUI-64)`, 'info', traceId);
                this.hooks.onDhcpChange?.(iface);
              }
            }
          }
        }
        return;
      case ICMP6.ECHO_REQUEST:
        if (isMulticast6(p.dst) && p.dst !== ALL_NODES) return;
        this.dev.note(`ICMPv6 Echo Request de ${formatIPv6(p.src)} — respondendo`, 'info', traceId);
        this.originate6({ dst: p.src, src: isMulticast6(p.dst) ? undefined : p.dst, hopLimit: 64, payload: { kind: 'icmpv6', type: ICMP6.ECHO_REPLY, code: 0, id: q.id, seq: q.seq, data: q.data } });
        return;
      case ICMP6.ECHO_REPLY: {
        const w = this.echoWaiters.get(`6|${q.id}|${q.seq}`);
        if (w && !w.done) {
          w.done = true;
          w.cb({ type: 'reply', from: p.src, ttl: p.hopLimit, rtt: this.now - w.sent, bytes: q.data ?? 32 });
        }
        return;
      }
      default: {
        const o = q.original;
        if (!o) return;
        let key: string | undefined;
        if (o.payload.kind === 'icmpv6') key = `6|${o.payload.id}|${o.payload.seq}`;
        else if (o.payload.kind === 'udp') key = `6u|${o.payload.dstPort}`;
        const w = key ? this.echoWaiters.get(key) : undefined;
        if (!w || w.done) return;
        w.done = true;
        const rtt = this.now - w.sent;
        if (q.type === ICMP6.TIME_EXCEEDED) w.cb({ type: 'ttl-exceeded', from: p.src, rtt });
        else if (q.type === ICMP6.DEST_UNREACH && q.code === 4) w.cb({ type: 'port-unreachable', from: p.src, rtt });
        else w.cb({ type: 'unreachable', from: p.src, code: q.code });
      }
    }
  }

  private icmp6Error(orig: IPv6Packet, type: number, code: number, inIf: L3If, src?: IPv6) {
    if (orig.payload.kind === 'icmpv6' && orig.payload.type < 128) return;
    if (orig.src === 0n || isMulticast6(orig.dst)) return;
    const s = src ?? inIf.v6.find((a) => a.source !== 'linklocal')?.addr ?? this.linkLocal(inIf);
    this.originate6({ dst: orig.src, src: s, hopLimit: 64, payload: { kind: 'icmpv6', type, code, original: orig } });
  }

  originate6(p: { dst: IPv6; src?: IPv6; hopLimit: number; payload: IPv6Packet['payload'] }, onFail?: (reason: 'no-route' | 'no-source') => void): boolean {
    const own = this.ownsV6(p.dst);
    if (own) {
      const pkt: IPv6Packet = { kind: 'ipv6', src: p.src ?? p.dst, dst: p.dst, hopLimit: p.hopLimit, nextHeader: p.payload.kind === 'icmpv6' ? IPPROTO.ICMPV6 : IPPROTO.UDP, payload: p.payload };
      this.dev.simulator.schedule(0, () => this.local6(own, pkt, { src: own.mac, dst: own.mac, payload: pkt }));
      return true;
    }
    let iface: L3If | undefined;
    let nextHop: IPv6 = p.dst;
    if (isLinkLocal6(p.dst)) {
      // Link-local destinations need an explicit interface; use the first IPv6 interface that is up.
      iface = this.ifaces().find((i) => i.v6Enabled && i.isUp() && !i.loopback);
    } else {
      const r = this.resolve6(p.dst);
      if (r) {
        iface = r.iface;
        nextHop = r.nextHop;
      }
    }
    if (!iface) {
      onFail?.('no-route');
      return false;
    }
    const src = p.src ?? this.srcFor6(iface, p.dst);
    if (src === undefined) {
      onFail?.('no-source');
      return false;
    }
    const nh = p.payload.kind === 'icmpv6' ? IPPROTO.ICMPV6 : p.payload.kind === 'udp' ? IPPROTO.UDP : IPPROTO.TCP;
    this.output6(iface, nextHop, { kind: 'ipv6', src, dst: p.dst, hopLimit: p.hopLimit, nextHeader: nh, payload: p.payload });
    return true;
  }

  echo6(dst: IPv6, opts: { size?: number; hopLimit?: number; src?: IPv6; timeout?: number; seq: number; id?: number }, cb: (r: EchoResult) => void) {
    const id = opts.id ?? this.echoId++;
    const key = `6|${id}|${opts.seq}`;
    const w = { cb, sent: this.now, done: false };
    this.echoWaiters.set(key, w);
    const finish = (r: EchoResult) => {
      if (w.done) return;
      w.done = true;
      this.echoWaiters.delete(key);
      cb(r);
    };
    w.cb = (r) => {
      this.echoWaiters.delete(key);
      cb(r);
    };
    this.originate6({ dst, src: opts.src, hopLimit: opts.hopLimit ?? 64, payload: { kind: 'icmpv6', type: ICMP6.ECHO_REQUEST, code: 0, id, seq: opts.seq, data: opts.size ?? 32 } }, (reason) =>
      finish({ type: 'local-error', reason }),
    );
    this.dev.timer(opts.timeout ?? 2000, () => finish({ type: 'timeout' }));
    return id;
  }

  probe6(dst: IPv6, hopLimit: number, timeout: number, cb: (r: EchoResult) => void) {
    const port = this.probePort++;
    if (this.probePort > 33533) this.probePort = 33434;
    const key = `6u|${port}`;
    const w = { cb, sent: this.now, done: false };
    this.echoWaiters.set(key, w);
    const finish = (r: EchoResult) => {
      if (w.done) return;
      w.done = true;
      this.echoWaiters.delete(key);
      cb(r);
    };
    w.cb = (r) => {
      this.echoWaiters.delete(key);
      cb(r);
    };
    this.originate6({ dst, hopLimit, payload: { kind: 'udp', srcPort: 49152 + (port % 1000), dstPort: port, payload: { kind: 'raw', length: 12 } } as UdpDatagram }, (reason) =>
      finish({ type: 'local-error', reason }),
    );
    this.dev.timer(timeout, () => finish({ type: 'timeout' }));
  }

  // ========================================================================= link events

  /** Called by the device when an interface changes state. */
  ifaceChanged(iface: L3If) {
    if (!iface.isUp()) {
      this.clearArp(iface);
      for (const [k, n] of this.neighbors) if (n.iface === iface) this.neighbors.delete(k);
      for (const [k, r] of this.raRouters) if (r.iface === iface) this.raRouters.delete(k);
      return;
    }
    this.syncLinkLocal(iface);
    this.dev.timer(500, () => this.gratuitousArp(iface));
    if (iface.dhcp) this.dev.timer(300, () => this.dhcpLinkUp(iface));
    if (iface.v6Enabled && iface.slaac && !this.routing6) {
      this.dev.timer(1000, () => this.sendRs(iface));
      this.dev.timer(5000, () => {
        if (![...this.raRouters.values()].some((r) => r.iface === iface)) this.sendRs(iface);
      });
    }
    if (this.routing6) this.dev.timer(1000, () => this.sendRa(iface));
  }

  macCisco(i: L3If) {
    return macToCisco(i.mac);
  }
}

const DHCP_NAME: Record<number, string> = Object.fromEntries(Object.entries(DHCP).map(([k, v]) => [v, k]));
