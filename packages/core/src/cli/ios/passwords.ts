/** Cisco "type 7" reversible password cipher (the real algorithm). */
const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';

export function type7Encrypt(plain: string, seed = 8): string {
  let out = String(seed).padStart(2, '0');
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i) ^ XLAT.charCodeAt((seed + i) % XLAT.length);
    out += c.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function type7Decrypt(enc: string): string | null {
  if (!/^\d{2}([0-9A-Fa-f]{2})*$/.test(enc)) return null;
  const seed = parseInt(enc.slice(0, 2), 10);
  let out = '';
  for (let i = 2, j = 0; i < enc.length; i += 2, j++) {
    out += String.fromCharCode(parseInt(enc.slice(i, i + 2), 16) ^ XLAT.charCodeAt((seed + j) % XLAT.length));
  }
  return out;
}

const B64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Didactic "type 5" hash. Real IOS uses MD5-crypt; this keeps the same visible format
 * ($1$salt$hash) and the same property (one-way) without an MD5 implementation.
 */
export function type5Hash(plain: string, salt?: string): string {
  const s = salt ?? saltFor(plain);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const input = s + '$' + plain;
  for (let round = 0; round < 64; round++) {
    for (let i = 0; i < input.length; i++) {
      h1 = Math.imul(h1 ^ input.charCodeAt(i), 16777619) >>> 0;
      h2 = Math.imul(h2 ^ (input.charCodeAt(i) + round), 2246822519) >>> 0;
    }
  }
  let out = '';
  let a = h1;
  let b = h2;
  for (let i = 0; i < 22; i++) {
    out += B64[(a ^ b) & 63];
    a = Math.imul(a ^ (a >>> 13), 1274126177) >>> 0;
    b = Math.imul(b ^ (b >>> 11), 2654435761) >>> 0;
  }
  return `$1$${s}$${out}`;
}

function saltFor(plain: string): string {
  let h = 7;
  for (const c of plain) h = (h * 131 + c.charCodeAt(0)) >>> 0;
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += B64[h & 63];
    h = h >>> 6 || 0x9e3779b1;
  }
  return s;
}

export function type5Verify(plain: string, hash: string): boolean {
  const m = /^\$1\$([^$]+)\$/.exec(hash);
  if (!m) return false;
  return type5Hash(plain, m[1]) === hash;
}
