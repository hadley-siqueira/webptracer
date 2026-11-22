import type { IPv4 } from '../net/ipv4';
import type { IPv4Packet } from '../net/packets';

export interface NatStatic {
  local: IPv4;
  global: IPv4;
  proto?: 'tcp' | 'udp';
  localPort?: number;
  globalPort?: number;
}

export interface NatPool {
  name: string;
  start: IPv4;
  end: IPv4;
  prefix: number;
}

export interface NatDynamic {
  acl: string;
  pool?: string;
  /** Interface name for "interface X overload". */
  iface?: string;
  overload: boolean;
}

export interface NatTranslation {
  proto: 'icmp' | 'udp' | 'tcp' | null;
  insideLocal: IPv4;
  insideLocalPort?: number;
  insideGlobal: IPv4;
  insideGlobalPort?: number;
  outsideGlobal?: IPv4;
  outsideGlobalPort?: number;
  static: boolean;
  created: number;
  lastUsed: number;
}

export const NAT_TIMEOUTS = { icmp: 60_000, udp: 300_000, tcp: 86_400_000, simple: 86_400_000 };

/** Transport "ports" used for translation. ICMP echo uses the identifier. */
export function flowOf(p: IPv4Packet, side: 'src' | 'dst'): { proto: 'icmp' | 'udp' | 'tcp' | null; port?: number } {
  const q = p.payload;
  if (q.kind === 'icmp') {
    if (q.type === 8 || q.type === 0) return { proto: 'icmp', port: q.id };
    return { proto: null };
  }
  return { proto: q.kind, port: side === 'src' ? q.srcPort : q.dstPort };
}

export function rewrite(p: IPv4Packet, side: 'src' | 'dst', ip: IPv4, port?: number): IPv4Packet {
  const q = p.payload;
  let payload = q;
  if (port !== undefined) {
    if (q.kind === 'icmp') payload = { ...q, id: port };
    else if (q.kind === 'udp' || q.kind === 'tcp') payload = side === 'src' ? { ...q, srcPort: port } : { ...q, dstPort: port };
  }
  return side === 'src' ? { ...p, src: ip, payload } : { ...p, dst: ip, payload };
}
