/** MAC addresses are lower-case colon separated strings: "aa:bb:cc:dd:ee:ff". */
export type Mac = string;

export const BROADCAST_MAC: Mac = 'ff:ff:ff:ff:ff:ff';
export const STP_MAC: Mac = '01:80:c2:00:00:00';
export const CDP_MAC: Mac = '01:00:0c:cc:cc:cc';
export const ZERO_MAC: Mac = '00:00:00:00:00:00';

export function isGroupMac(m: Mac): boolean {
  return (parseInt(m.slice(0, 2), 16) & 1) === 1;
}

export function macToBytes(m: Mac): number[] {
  return m.split(':').map((h) => parseInt(h, 16));
}

export function bytesToMac(b: number[]): Mac {
  return b.map((x) => x.toString(16).padStart(2, '0')).join(':');
}

/** Cisco dotted format: aabb.ccdd.eeff */
export function macToCisco(m: Mac): string {
  const h = m.replace(/:/g, '');
  return `${h.slice(0, 4)}.${h.slice(4, 8)}.${h.slice(8)}`;
}

/** Windows format: AA-BB-CC-DD-EE-FF */
export function macToWindows(m: Mac): string {
  return m.replace(/:/g, '-').toUpperCase();
}

export function normalizeMac(input: string): Mac | null {
  const h = input.trim().toLowerCase().replace(/[.:-]/g, '');
  if (!/^[0-9a-f]{12}$/.test(h)) return null;
  return h.match(/../g)!.join(':');
}

export function macAdd(m: Mac, n: number): Mac {
  const b = macToBytes(m);
  let low = ((b[3] << 16) | (b[4] << 8) | b[5]) + n;
  low &= 0xffffff;
  return bytesToMac([b[0], b[1], b[2], (low >> 16) & 255, (low >> 8) & 255, low & 255]);
}

export function randomMac(oui: string, rng: () => number = Math.random): Mac {
  const o = normalizeMac(oui + '000000')!.slice(0, 8);
  const rest = [0, 0, 0].map(() => Math.floor(rng() * 256).toString(16).padStart(2, '0'));
  return `${o}:${rest.join(':')}`;
}

export function compareMac(a: Mac, b: Mac): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
