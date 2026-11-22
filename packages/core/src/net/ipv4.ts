/** IPv4 addresses are represented as unsigned 32-bit numbers. */
export type IPv4 = number;

export function parseIPv4(s: string): IPv4 | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export function formatIPv4(n: IPv4): string {
  return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

export function prefixToMask(prefix: number): IPv4 {
  return prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** Returns the prefix length of a contiguous mask, or null when the mask is not contiguous. */
export function maskToPrefix(mask: IPv4): number | null {
  let prefix = 0;
  let zero = false;
  for (let i = 31; i >= 0; i--) {
    if ((mask >>> i) & 1) {
      if (zero) return null;
      prefix++;
    } else zero = true;
  }
  return prefix;
}

export function networkOf(ip: IPv4, prefix: number): IPv4 {
  return (ip & prefixToMask(prefix)) >>> 0;
}

export function broadcastOf(ip: IPv4, prefix: number): IPv4 {
  return (networkOf(ip, prefix) | (~prefixToMask(prefix) >>> 0)) >>> 0;
}

export function inSubnet(ip: IPv4, net: IPv4, prefix: number): boolean {
  return networkOf(ip, prefix) === networkOf(net, prefix);
}

/** Wildcard (inverse mask) matching as used by ACLs. */
export function wildcardMatch(ip: IPv4, addr: IPv4, wildcard: IPv4): boolean {
  const care = ~wildcard >>> 0;
  return ((ip & care) >>> 0) === ((addr & care) >>> 0);
}

export function isMulticast4(ip: IPv4): boolean {
  return ip >>> 28 === 0xe;
}

export function classfulPrefix(ip: IPv4): number {
  const first = ip >>> 24;
  if (first < 128) return 8;
  if (first < 192) return 16;
  return 24;
}

export function formatCidr(ip: IPv4, prefix: number): string {
  return `${formatIPv4(ip)}/${prefix}`;
}

/** Parses "a.b.c.d/nn". */
export function parseCidr4(s: string): { addr: IPv4; prefix: number } | null {
  const [a, p] = s.split('/');
  const addr = parseIPv4(a ?? '');
  const prefix = Number(p);
  if (addr === null || !/^\d+$/.test(p ?? '') || prefix > 32) return null;
  return { addr, prefix };
}
