import type { IPv4 } from './ipv4';
import type { IPv6 } from './ipv6';
import type { Mac } from './mac';

/**
 * Packets are immutable structured objects. Devices must copy (spread) a packet
 * before changing any field. They are serialized to real bytes only when needed
 * (pcap export, hex view), see wire.ts.
 */
export interface EthernetFrame {
  src: Mac;
  dst: Mac;
  /** 802.1Q tag (absent = untagged). */
  vlan?: number;
  payload: FramePayload;
}

export type FramePayload = ArpPacket | IPv4Packet | IPv6Packet | StpBpdu | CdpPacket;

export interface ArpPacket {
  kind: 'arp';
  op: 1 | 2;
  senderMac: Mac;
  senderIp: IPv4;
  targetMac: Mac;
  targetIp: IPv4;
}

export const IPPROTO = { ICMP: 1, TCP: 6, UDP: 17, ICMPV6: 58 } as const;

export interface IPv4Packet {
  kind: 'ipv4';
  src: IPv4;
  dst: IPv4;
  ttl: number;
  id: number;
  protocol: number;
  dscp?: number;
  payload: Icmp4 | UdpDatagram | TcpSegment;
}

export interface Icmp4 {
  kind: 'icmp';
  type: number;
  code: number;
  id?: number;
  seq?: number;
  /** Bytes of echo data. */
  data?: number;
  /** Original datagram for error messages. */
  original?: IPv4Packet;
}

export interface UdpDatagram {
  kind: 'udp';
  srcPort: number;
  dstPort: number;
  payload: DhcpMessage | RawData;
}

export interface TcpSegment {
  kind: 'tcp';
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: { syn?: boolean; ack?: boolean; fin?: boolean; rst?: boolean; psh?: boolean };
  window: number;
  payload: RawData;
}

export interface RawData {
  kind: 'raw';
  length: number;
  text?: string;
}

export const DHCP = { DISCOVER: 1, OFFER: 2, REQUEST: 3, DECLINE: 4, ACK: 5, NAK: 6, RELEASE: 7, INFORM: 8 } as const;

export interface DhcpMessage {
  kind: 'dhcp';
  op: 1 | 2;
  xid: number;
  msgType: number;
  chaddr: Mac;
  ciaddr: IPv4;
  yiaddr: IPv4;
  siaddr: IPv4;
  giaddr: IPv4;
  broadcast: boolean;
  options: {
    subnetMask?: IPv4;
    router?: IPv4[];
    dns?: IPv4[];
    leaseTime?: number;
    serverId?: IPv4;
    requestedIp?: IPv4;
    domainName?: string;
    hostname?: string;
  };
}

export interface IPv6Packet {
  kind: 'ipv6';
  src: IPv6;
  dst: IPv6;
  hopLimit: number;
  nextHeader: number;
  payload: Icmp6 | UdpDatagram | TcpSegment;
}

export const ICMP6 = {
  DEST_UNREACH: 1,
  PACKET_TOO_BIG: 2,
  TIME_EXCEEDED: 3,
  ECHO_REQUEST: 128,
  ECHO_REPLY: 129,
  RS: 133,
  RA: 134,
  NS: 135,
  NA: 136,
} as const;

export interface RaPrefix {
  prefix: IPv6;
  length: number;
  onLink: boolean;
  autonomous: boolean;
  valid: number;
  preferred: number;
}

export interface Icmp6 {
  kind: 'icmpv6';
  type: number;
  code: number;
  id?: number;
  seq?: number;
  data?: number;
  /** NS/NA target address. */
  target?: IPv6;
  /** Source (NS/RS/RA) or target (NA) link-layer address option. */
  lladdr?: Mac;
  naFlags?: { router: boolean; solicited: boolean; override: boolean };
  ra?: { curHopLimit: number; managed: boolean; other: boolean; routerLifetime: number; prefixes: RaPrefix[]; mtu?: number };
  original?: IPv6Packet;
}

export interface BridgeId {
  priority: number;
  mac: Mac;
}

export interface StpBpdu {
  kind: 'stp';
  bpduType: 'config' | 'tcn';
  root: BridgeId;
  rootCost: number;
  bridge: BridgeId;
  portId: number;
  messageAge: number;
  maxAge: number;
  helloTime: number;
  forwardDelay: number;
  tc: boolean;
  tca: boolean;
}

export interface CdpPacket {
  kind: 'cdp';
  deviceId: string;
  portId: string;
  platform: string;
  capabilities: string[];
  addresses: IPv4[];
  softwareVersion: string;
  holdtime: number;
  nativeVlan?: number;
}
