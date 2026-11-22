/**
 * Serializes structured frames to real wire bytes (Ethernet II / 802.3), with correct
 * checksums, so that captures open in Wireshark exactly like real traffic.
 */
import { macToBytes } from './mac';
import { ipv6ToBytes } from './ipv6';
import type { IPv4 } from './ipv4';
import type {
  ArpPacket,
  CdpPacket,
  DhcpMessage,
  EthernetFrame,
  Icmp4,
  Icmp6,
  IPv4Packet,
  IPv6Packet,
  StpBpdu,
  TcpSegment,
  UdpDatagram,
} from './packets';
import { IPPROTO, ICMP6 } from './packets';

class Buf {
  b: number[] = [];
  u8(v: number) {
    this.b.push(v & 255);
    return this;
  }
  u16(v: number) {
    this.b.push((v >>> 8) & 255, v & 255);
    return this;
  }
  u32(v: number) {
    this.b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    return this;
  }
  bytes(a: number[] | Uint8Array) {
    for (const x of a) this.b.push(x & 255);
    return this;
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.b.push(0);
    return this;
  }
  get length() {
    return this.b.length;
  }
  set16(off: number, v: number) {
    this.b[off] = (v >>> 8) & 255;
    this.b[off + 1] = v & 255;
  }
}

function ip4Bytes(a: IPv4): number[] {
  return [(a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255];
}

export function inetChecksum(data: number[]): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 2) sum += (data[i] << 8) + (data[i + 1] ?? 0);
  while (sum >> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

function pattern(n: number): number[] {
  // Same filler used by Windows ping ("abcdefghijklmnopqrstuvwabcdefghi").
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(0x61 + (i % 23));
  return out;
}

// ------------------------------------------------------------------------ L4

function icmp4Bytes(m: Icmp4): number[] {
  const b = new Buf().u8(m.type).u8(m.code).u16(0);
  if (m.type === 0 || m.type === 8) {
    b.u16(m.id ?? 0).u16(m.seq ?? 0).bytes(pattern(m.data ?? 32));
  } else {
    b.u32(0);
    if (m.original) b.bytes(ipv4Bytes(m.original).slice(0, 28));
  }
  b.set16(2, inetChecksum(b.b));
  return b.b;
}

function dhcpBytes(d: DhcpMessage): number[] {
  const b = new Buf().u8(d.op).u8(1).u8(6).u8(0).u32(d.xid).u16(0).u16(d.broadcast ? 0x8000 : 0);
  b.bytes(ip4Bytes(d.ciaddr)).bytes(ip4Bytes(d.yiaddr)).bytes(ip4Bytes(d.siaddr)).bytes(ip4Bytes(d.giaddr));
  b.bytes(macToBytes(d.chaddr)).zeros(10).zeros(64).zeros(128);
  b.u32(0x63825363);
  b.u8(53).u8(1).u8(d.msgType);
  const o = d.options;
  if (o.subnetMask !== undefined) b.u8(1).u8(4).bytes(ip4Bytes(o.subnetMask));
  if (o.router?.length) b.u8(3).u8(4 * o.router.length).bytes(o.router.flatMap(ip4Bytes));
  if (o.dns?.length) b.u8(6).u8(4 * o.dns.length).bytes(o.dns.flatMap(ip4Bytes));
  if (o.hostname) b.u8(12).u8(o.hostname.length).bytes([...o.hostname].map((c) => c.charCodeAt(0)));
  if (o.domainName) b.u8(15).u8(o.domainName.length).bytes([...o.domainName].map((c) => c.charCodeAt(0)));
  if (o.requestedIp !== undefined) b.u8(50).u8(4).bytes(ip4Bytes(o.requestedIp));
  if (o.leaseTime !== undefined) b.u8(51).u8(4).u32(o.leaseTime);
  if (o.serverId !== undefined) b.u8(54).u8(4).bytes(ip4Bytes(o.serverId));
  b.u8(255);
  while (b.length < 300) b.u8(0);
  return b.b;
}

function l4Payload(p: UdpDatagram | TcpSegment): number[] {
  if (p.kind === 'udp' && p.payload.kind === 'dhcp') return dhcpBytes(p.payload);
  const raw = p.payload.kind === 'raw' ? p.payload : { length: 0, text: undefined };
  if (raw.text) return [...raw.text].map((c) => c.charCodeAt(0) & 255);
  return new Array(raw.length).fill(0);
}

function udpBytes(u: UdpDatagram, pseudo: number[]): number[] {
  const data = l4Payload(u);
  const len = 8 + data.length;
  const b = new Buf().u16(u.srcPort).u16(u.dstPort).u16(len).u16(0).bytes(data);
  const ck = inetChecksum([...pseudo, ...b.b]) || 0xffff;
  b.set16(6, ck);
  return b.b;
}

function tcpBytes(t: TcpSegment, pseudo: number[]): number[] {
  const data = l4Payload(t);
  const f = t.flags;
  const flags = (f.fin ? 1 : 0) | (f.syn ? 2 : 0) | (f.rst ? 4 : 0) | (f.psh ? 8 : 0) | (f.ack ? 16 : 0);
  const b = new Buf().u16(t.srcPort).u16(t.dstPort).u32(t.seq).u32(t.ack).u8(5 << 4).u8(flags).u16(t.window).u16(0).u16(0).bytes(data);
  b.set16(16, inetChecksum([...pseudo, ...b.b]));
  return b.b;
}

// ------------------------------------------------------------------------ L3

export function ipv4Bytes(p: IPv4Packet): number[] {
  let payload: number[];
  const proto = p.protocol;
  const pseudoFor = (len: number) => [...ip4Bytes(p.src), ...ip4Bytes(p.dst), 0, proto, (len >>> 8) & 255, len & 255];
  const q = p.payload;
  if (q.kind === 'icmp') payload = icmp4Bytes(q);
  else if (q.kind === 'udp') {
    const len = 8 + l4Payload(q).length;
    payload = udpBytes(q, pseudoFor(len));
  } else {
    const len = 20 + l4Payload(q).length;
    payload = tcpBytes(q, pseudoFor(len));
  }
  const total = 20 + payload.length;
  const h = new Buf()
    .u8(0x45)
    .u8((p.dscp ?? 0) << 2)
    .u16(total)
    .u16(p.id & 0xffff)
    .u16(0)
    .u8(p.ttl)
    .u8(proto)
    .u16(0)
    .bytes(ip4Bytes(p.src))
    .bytes(ip4Bytes(p.dst));
  h.set16(10, inetChecksum(h.b));
  return [...h.b, ...payload];
}

function icmp6Bytes(m: Icmp6, pseudoBase: (len: number) => number[]): number[] {
  const b = new Buf().u8(m.type).u8(m.code).u16(0);
  switch (m.type) {
    case ICMP6.ECHO_REQUEST:
    case ICMP6.ECHO_REPLY:
      b.u16(m.id ?? 0).u16(m.seq ?? 0).bytes(pattern(m.data ?? 32));
      break;
    case ICMP6.RS:
      b.u32(0);
      if (m.lladdr) b.u8(1).u8(1).bytes(macToBytes(m.lladdr));
      break;
    case ICMP6.RA: {
      const ra = m.ra!;
      b.u8(ra.curHopLimit).u8((ra.managed ? 0x80 : 0) | (ra.other ? 0x40 : 0)).u16(ra.routerLifetime).u32(0).u32(0);
      if (m.lladdr) b.u8(1).u8(1).bytes(macToBytes(m.lladdr));
      if (ra.mtu) b.u8(5).u8(1).u16(0).u32(ra.mtu);
      for (const pf of ra.prefixes) {
        b.u8(3).u8(4).u8(pf.length).u8((pf.onLink ? 0x80 : 0) | (pf.autonomous ? 0x40 : 0)).u32(pf.valid).u32(pf.preferred).u32(0).bytes(ipv6ToBytes(pf.prefix));
      }
      break;
    }
    case ICMP6.NS:
      b.u32(0).bytes(ipv6ToBytes(m.target ?? 0n));
      if (m.lladdr) b.u8(1).u8(1).bytes(macToBytes(m.lladdr));
      break;
    case ICMP6.NA: {
      const f = m.naFlags ?? { router: false, solicited: false, override: false };
      b.u8((f.router ? 0x80 : 0) | (f.solicited ? 0x40 : 0) | (f.override ? 0x20 : 0)).zeros(3).bytes(ipv6ToBytes(m.target ?? 0n));
      if (m.lladdr) b.u8(2).u8(1).bytes(macToBytes(m.lladdr));
      break;
    }
    default:
      b.u32(m.type === ICMP6.PACKET_TOO_BIG ? 1500 : 0);
      if (m.original) b.bytes(ipv6Bytes(m.original).slice(0, 1232));
  }
  b.set16(2, inetChecksum([...pseudoBase(b.length), ...b.b]));
  return b.b;
}

export function ipv6Bytes(p: IPv6Packet): number[] {
  const pseudoBase = (len: number) => [...ipv6ToBytes(p.src), ...ipv6ToBytes(p.dst), 0, 0, (len >>> 8) & 255, len & 255, 0, 0, 0, p.nextHeader];
  const q = p.payload;
  let payload: number[];
  if (q.kind === 'icmpv6') payload = icmp6Bytes(q, pseudoBase);
  else if (q.kind === 'udp') payload = udpBytes(q, pseudoBase(8 + l4Payload(q).length));
  else payload = tcpBytes(q, pseudoBase(20 + l4Payload(q).length));
  const h = new Buf().u32(0x60000000).u16(payload.length).u8(p.nextHeader).u8(p.hopLimit).bytes(ipv6ToBytes(p.src)).bytes(ipv6ToBytes(p.dst));
  return [...h.b, ...payload];
}

function arpBytes(a: ArpPacket): number[] {
  return new Buf()
    .u16(1)
    .u16(0x0800)
    .u8(6)
    .u8(4)
    .u16(a.op)
    .bytes(macToBytes(a.senderMac))
    .bytes(ip4Bytes(a.senderIp))
    .bytes(macToBytes(a.targetMac))
    .bytes(ip4Bytes(a.targetIp)).b;
}

function stpBytes(s: StpBpdu): number[] {
  const b = new Buf().u8(0x42).u8(0x42).u8(0x03); // LLC
  b.u16(0).u8(0);
  if (s.bpduType === 'tcn') return b.u8(0x80).b;
  const bid = (x: { priority: number; mac: string }) => [(x.priority >>> 8) & 255, x.priority & 255, ...macToBytes(x.mac)];
  b.u8(0x00).u8((s.tc ? 1 : 0) | (s.tca ? 0x80 : 0));
  b.bytes(bid(s.root)).u32(s.rootCost).bytes(bid(s.bridge)).u16(s.portId);
  b.u16(s.messageAge * 256).u16(s.maxAge * 256).u16(s.helloTime * 256).u16(s.forwardDelay * 256);
  return b.b;
}

function cdpBytes(c: CdpPacket): number[] {
  const tlv = (type: number, data: number[]) => [(type >>> 8) & 255, type & 255, ((data.length + 4) >>> 8) & 255, (data.length + 4) & 255, ...data];
  const str = (s: string) => [...s].map((ch) => ch.charCodeAt(0) & 255);
  const caps = { router: 0x01, switch: 0x08, host: 0x10, igmp: 0x20 } as Record<string, number>;
  const capBits = c.capabilities.reduce((acc, k) => acc | (caps[k.toLowerCase()] ?? 0), 0);
  const addrs: number[] = [0, 0, 0, c.addresses.length];
  for (const a of c.addresses) addrs.push(1, 1, 0xcc, 0, 4, ...ip4Bytes(a));
  const body = [
    ...tlv(1, str(c.deviceId)),
    ...tlv(2, addrs),
    ...tlv(3, str(c.portId)),
    ...tlv(4, [(capBits >>> 24) & 255, (capBits >>> 16) & 255, (capBits >>> 8) & 255, capBits & 255]),
    ...tlv(5, str(c.softwareVersion)),
    ...tlv(6, str(c.platform)),
    ...(c.nativeVlan ? tlv(0x0a, [(c.nativeVlan >>> 8) & 255, c.nativeVlan & 255]) : []),
  ];
  const pdu = [2, c.holdtime, 0, 0, ...body];
  const ck = inetChecksum(pdu);
  pdu[2] = (ck >>> 8) & 255;
  pdu[3] = ck & 255;
  return [0xaa, 0xaa, 0x03, 0x00, 0x00, 0x0c, 0x20, 0x00, ...pdu];
}

// ------------------------------------------------------------------------ L2

export function frameBytes(f: EthernetFrame): Uint8Array {
  const b = new Buf().bytes(macToBytes(f.dst)).bytes(macToBytes(f.src));
  if (f.vlan !== undefined) b.u16(0x8100).u16(f.vlan & 0x0fff);
  const p = f.payload;
  let body: number[];
  switch (p.kind) {
    case 'arp':
      b.u16(0x0806);
      body = arpBytes(p);
      break;
    case 'ipv4':
      b.u16(0x0800);
      body = ipv4Bytes(p);
      break;
    case 'ipv6':
      b.u16(0x86dd);
      body = ipv6Bytes(p);
      break;
    case 'stp':
      body = stpBytes(p);
      b.u16(body.length); // 802.3 length field
      break;
    case 'cdp':
      body = cdpBytes(p);
      b.u16(body.length);
      break;
  }
  b.bytes(body);
  while (b.length < 60) b.u8(0);
  return Uint8Array.from(b.b);
}

/** Builds a libpcap file (linktype Ethernet). Timestamps come from virtual time (ms). */
export function buildPcap(frames: { time: number; frame: EthernetFrame }[]): Uint8Array {
  const out: number[] = [];
  const le32 = (v: number) => out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  const le16 = (v: number) => out.push(v & 255, (v >>> 8) & 255);
  le32(0xa1b2c3d4);
  le16(2);
  le16(4);
  le32(0);
  le32(0);
  le32(65535);
  le32(1);
  for (const { time, frame } of frames) {
    const data = frameBytes(frame);
    const sec = Math.floor(time / 1000);
    const usec = Math.round((time - sec * 1000) * 1000);
    le32(sec);
    le32(usec);
    le32(data.length);
    le32(data.length);
    for (const x of data) out.push(x);
  }
  return Uint8Array.from(out);
}

export function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = Array.from(bytes.slice(i, i + 16));
    const hex = chunk.map((x) => x.toString(16).padStart(2, '0')).join(' ');
    const ascii = chunk.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
    lines.push(`${i.toString(16).padStart(4, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join('\n');
}

export { IPPROTO };
