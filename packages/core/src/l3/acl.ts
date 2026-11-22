import { formatIPv4, wildcardMatch, type IPv4 } from '../net/ipv4';
import type { IPv4Packet } from '../net/packets';

export type PortOp = 'eq' | 'neq' | 'lt' | 'gt' | 'range';

export interface PortMatch {
  op: PortOp;
  ports: number[];
}

export interface AddrMatch {
  addr: IPv4;
  wildcard: IPv4;
}

export interface AclEntry {
  seq: number;
  action: 'permit' | 'deny';
  /** Standard ACLs only use `src`. */
  proto: 'ip' | 'icmp' | 'tcp' | 'udp';
  src: AddrMatch;
  srcPort?: PortMatch;
  dst?: AddrMatch;
  dstPort?: PortMatch;
  icmpType?: number;
  established?: boolean;
  log?: boolean;
  matches: number;
}

export interface Acl {
  name: string;
  type: 'standard' | 'extended';
  /** Numbered ACLs (1-99, 100-199) are shown differently from named ones. */
  numbered: boolean;
  entries: AclEntry[];
  remarks: { before: number; text: string }[];
}

export const ANY: AddrMatch = { addr: 0, wildcard: 0xffffffff };

export function hostMatch(a: IPv4): AddrMatch {
  return { addr: a, wildcard: 0 };
}

function portOk(m: PortMatch | undefined, port: number | undefined): boolean {
  if (!m) return true;
  if (port === undefined) return false;
  switch (m.op) {
    case 'eq':
      return m.ports.includes(port);
    case 'neq':
      return !m.ports.includes(port);
    case 'lt':
      return port < m.ports[0];
    case 'gt':
      return port > m.ports[0];
    case 'range':
      return port >= m.ports[0] && port <= m.ports[1];
  }
}

export function entryMatches(e: AclEntry, p: IPv4Packet, standard: boolean): boolean {
  if (!wildcardMatch(p.src, e.src.addr, e.src.wildcard)) return false;
  if (standard) return true;
  if (e.dst && !wildcardMatch(p.dst, e.dst.addr, e.dst.wildcard)) return false;
  const q = p.payload;
  switch (e.proto) {
    case 'ip':
      return true;
    case 'icmp':
      if (q.kind !== 'icmp') return false;
      return e.icmpType === undefined || e.icmpType === q.type;
    case 'tcp':
      if (q.kind !== 'tcp') return false;
      if (e.established && !(q.flags.ack || q.flags.rst)) return false;
      return portOk(e.srcPort, q.srcPort) && portOk(e.dstPort, q.dstPort);
    case 'udp':
      if (q.kind !== 'udp') return false;
      return portOk(e.srcPort, q.srcPort) && portOk(e.dstPort, q.dstPort);
  }
}

/** Evaluates an ACL. A missing ACL permits everything (as in IOS). */
export function evaluateAcl(acl: Acl | undefined, p: IPv4Packet): { permit: boolean; entry?: AclEntry } {
  if (!acl) return { permit: true };
  for (const e of acl.entries) {
    if (entryMatches(e, p, acl.type === 'standard')) {
      e.matches++;
      return { permit: e.action === 'permit', entry: e };
    }
  }
  return { permit: false };
}

export const PORT_NAMES: Record<string, number> = {
  ftp: 21,
  'ftp-data': 20,
  ssh: 22,
  telnet: 23,
  smtp: 25,
  domain: 53,
  www: 80,
  http: 80,
  pop3: 110,
  ntp: 123,
  snmp: 161,
  bgp: 179,
  https: 443,
  bootps: 67,
  bootpc: 68,
  tftp: 69,
  syslog: 514,
  rip: 520,
};

export const ICMP_TYPE_NAMES: Record<string, number> = {
  'echo-reply': 0,
  unreachable: 3,
  echo: 8,
  'time-exceeded': 11,
};

function addrText(m: AddrMatch): string {
  if (m.wildcard === 0xffffffff) return 'any';
  if (m.wildcard === 0) return `host ${formatIPv4(m.addr)}`;
  return `${formatIPv4(m.addr)} ${formatIPv4(m.wildcard)}`;
}

function portText(m: PortMatch | undefined): string {
  if (!m) return '';
  const name = (p: number) => Object.entries(PORT_NAMES).find(([k, v]) => v === p && k !== 'http')?.[0] ?? String(p);
  return ` ${m.op} ${m.ports.map(name).join(' ')}`;
}

/** Text of an entry as it appears in running-config (without sequence number). */
export function entryText(e: AclEntry, standard: boolean): string {
  if (standard) {
    // IOS shows "host" for /32 in running-config of standard ACLs only as plain address.
    const src = e.src.wildcard === 0 ? `host ${formatIPv4(e.src.addr)}` : e.src.wildcard === 0xffffffff ? 'any' : `${formatIPv4(e.src.addr)} ${formatIPv4(e.src.wildcard)}`;
    return `${e.action} ${src}${e.log ? ' log' : ''}`;
  }
  let s = `${e.action} ${e.proto} ${addrText(e.src)}${portText(e.srcPort)} ${addrText(e.dst ?? ANY)}${portText(e.dstPort)}`;
  if (e.icmpType !== undefined) s += ` ${Object.entries(ICMP_TYPE_NAMES).find(([, v]) => v === e.icmpType)?.[0] ?? e.icmpType}`;
  if (e.established) s += ' established';
  if (e.log) s += ' log';
  return s;
}
