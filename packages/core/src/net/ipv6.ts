import { macToBytes, type Mac } from './mac';

/** IPv6 addresses are represented as 128-bit bigints. */
export type IPv6 = bigint;

const MAX = (1n << 128n) - 1n;

export function parseIPv6(input: string): IPv6 | null {
  const s = input.trim().toLowerCase();
  if (!/^[0-9a-f:]+$/.test(s) || s.length < 2) return null;
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let groups: string[];
  if (parts.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    if (head.length + tail.length > 7) return null;
    groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  }
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

/** RFC 5952 formatting. Cisco IOS prints addresses in upper case. */
export function formatIPv6(v: IPv6, upper = false): string {
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((v >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  let out: string;
  if (bestStart < 0) out = hex.join(':');
  else {
    const left = hex.slice(0, bestStart).join(':');
    const right = hex.slice(bestStart + bestLen).join(':');
    out = `${left}::${right}`;
  }
  return upper ? out.toUpperCase() : out;
}

export function prefixMask6(prefix: number): IPv6 {
  if (prefix <= 0) return 0n;
  return MAX ^ ((1n << BigInt(128 - prefix)) - 1n);
}

export function network6(addr: IPv6, prefix: number): IPv6 {
  return addr & prefixMask6(prefix);
}

export function inPrefix6(addr: IPv6, net: IPv6, prefix: number): boolean {
  return network6(addr, prefix) === network6(net, prefix);
}

export function parsePrefix6(s: string): { addr: IPv6; prefix: number } | null {
  const idx = s.lastIndexOf('/');
  if (idx < 0) return null;
  const addr = parseIPv6(s.slice(0, idx));
  const pstr = s.slice(idx + 1);
  const prefix = Number(pstr);
  if (addr === null || !/^\d+$/.test(pstr) || prefix > 128) return null;
  return { addr, prefix };
}

/** Modified EUI-64 interface identifier derived from a MAC address. */
export function eui64(mac: Mac): IPv6 {
  const b = macToBytes(mac);
  const id = [b[0] ^ 0x02, b[1], b[2], 0xff, 0xfe, b[3], b[4], b[5]];
  let v = 0n;
  for (const x of id) v = (v << 8n) | BigInt(x);
  return v;
}

export function linkLocalFromMac(mac: Mac): IPv6 {
  return (0xfe80n << 112n) | eui64(mac);
}

export function isLinkLocal6(a: IPv6): boolean {
  return a >> 118n === 0x3fan; // fe80::/10
}

export function isMulticast6(a: IPv6): boolean {
  return a >> 120n === 0xffn;
}

export const ALL_NODES = parseIPv6('ff02::1')!;
export const ALL_ROUTERS = parseIPv6('ff02::2')!;
export const UNSPECIFIED6 = 0n;

export function solicitedNode(a: IPv6): IPv6 {
  return parseIPv6('ff02::1:ff00:0')! | (a & 0xffffffn);
}

export function multicastMac6(a: IPv6): Mac {
  const low = a & 0xffffffffn;
  const bytes = [0x33, 0x33, Number((low >> 24n) & 0xffn), Number((low >> 16n) & 0xffn), Number((low >> 8n) & 0xffn), Number(low & 0xffn)];
  return bytes.map((x) => x.toString(16).padStart(2, '0')).join(':');
}

export function ipv6ToBytes(a: IPv6): number[] {
  const out: number[] = [];
  for (let i = 15; i >= 0; i--) out.push(Number((a >> BigInt(i * 8)) & 0xffn));
  return out;
}
