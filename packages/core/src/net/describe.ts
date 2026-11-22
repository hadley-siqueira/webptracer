import { formatIPv4 } from './ipv4';
import { formatIPv6 } from './ipv6';
import type { EthernetFrame, Icmp4, Icmp6, IPv4Packet, IPv6Packet, DhcpMessage } from './packets';
import { DHCP, ICMP6 } from './packets';

const DHCP_NAMES: Record<number, string> = Object.fromEntries(Object.entries(DHCP).map(([k, v]) => [v, k]));

const ICMP4_TYPES: Record<number, string> = {
  0: 'Echo Reply',
  3: 'Destination Unreachable',
  5: 'Redirect',
  8: 'Echo Request',
  11: 'Time Exceeded',
};
const UNREACH_CODES: Record<number, string> = {
  0: 'Network Unreachable',
  1: 'Host Unreachable',
  3: 'Port Unreachable',
  4: 'Fragmentation Needed',
  13: 'Communication Administratively Prohibited',
};
const ICMP6_TYPES: Record<number, string> = {
  1: 'Destination Unreachable',
  2: 'Packet Too Big',
  3: 'Time Exceeded',
  128: 'Echo Request',
  129: 'Echo Reply',
  133: 'Router Solicitation',
  134: 'Router Advertisement',
  135: 'Neighbor Solicitation',
  136: 'Neighbor Advertisement',
};

function icmp4Summary(m: Icmp4) {
  let s = ICMP4_TYPES[m.type] ?? `Type ${m.type}`;
  if (m.type === 3) s += ` (${UNREACH_CODES[m.code] ?? m.code})`;
  if (m.type === 0 || m.type === 8) s += ` id=${m.id} seq=${m.seq}`;
  return s;
}

function icmp6Summary(m: Icmp6) {
  let s = ICMP6_TYPES[m.type] ?? `Type ${m.type}`;
  if (m.type === ICMP6.NS) s += ` para ${formatIPv6(m.target ?? 0n)}`;
  if (m.type === ICMP6.NA) s += ` ${formatIPv6(m.target ?? 0n)} está em ${m.lladdr}`;
  if (m.type === ICMP6.ECHO_REQUEST || m.type === ICMP6.ECHO_REPLY) s += ` id=${m.id} seq=${m.seq}`;
  return s;
}

function dhcpSummary(d: DhcpMessage) {
  const n = DHCP_NAMES[d.msgType] ?? '?';
  const extra = d.yiaddr ? ` ${formatIPv4(d.yiaddr)}` : '';
  return `DHCP ${n}${extra} (xid 0x${d.xid.toString(16)})`;
}

function ip4Summary(p: IPv4Packet) {
  const q = p.payload;
  const route = `${formatIPv4(p.src)} → ${formatIPv4(p.dst)}`;
  if (q.kind === 'icmp') return `${route} ICMP ${icmp4Summary(q)} TTL=${p.ttl}`;
  if (q.kind === 'udp') {
    if (q.payload.kind === 'dhcp') return `${route} ${dhcpSummary(q.payload)}`;
    return `${route} UDP ${q.srcPort} → ${q.dstPort} TTL=${p.ttl}`;
  }
  const f = Object.entries(q.flags)
    .filter(([, v]) => v)
    .map(([k]) => k.toUpperCase())
    .join(',');
  return `${route} TCP ${q.srcPort} → ${q.dstPort} [${f}]`;
}

function ip6Summary(p: IPv6Packet) {
  const q = p.payload;
  const route = `${formatIPv6(p.src)} → ${formatIPv6(p.dst)}`;
  if (q.kind === 'icmpv6') return `${route} ${icmp6Summary(q)}`;
  if (q.kind === 'udp') return `${route} UDP ${q.srcPort} → ${q.dstPort}`;
  return `${route} TCP ${q.srcPort} → ${q.dstPort}`;
}

export function summarize(f: EthernetFrame): string {
  const p = f.payload;
  const tag = f.vlan !== undefined ? `[802.1Q VLAN ${f.vlan}] ` : '';
  switch (p.kind) {
    case 'arp':
      return (
        tag +
        (p.op === 1
          ? `ARP Quem tem ${formatIPv4(p.targetIp)}? Responder para ${formatIPv4(p.senderIp)}`
          : `ARP ${formatIPv4(p.senderIp)} está em ${p.senderMac}`)
      );
    case 'stp':
      return tag + (p.bpduType === 'tcn' ? 'STP TCN' : `STP BPDU raiz ${p.root.priority}.${p.root.mac} custo ${p.rootCost}`);
    case 'cdp':
      return tag + `CDP ${p.deviceId} porta ${p.portId}`;
    case 'ipv4':
      return tag + ip4Summary(p);
    case 'ipv6':
      return tag + ip6Summary(p);
  }
}

export interface Layer {
  title: string;
  /** OSI layer number for the "OSI model" view. */
  osi: number;
  fields: [string, string][];
}

export function describeFrame(f: EthernetFrame): Layer[] {
  const layers: Layer[] = [];
  const p = f.payload;
  const l2: [string, string][] = [
    ['Destino', f.dst],
    ['Origem', f.src],
  ];
  if (f.vlan !== undefined) l2.push(['802.1Q VLAN ID', String(f.vlan)]);
  const ethertype = { arp: '0x0806 (ARP)', ipv4: '0x0800 (IPv4)', ipv6: '0x86DD (IPv6)', stp: '802.3 + LLC (STP)', cdp: '802.3 + SNAP (CDP)' }[p.kind];
  l2.push(['Tipo', ethertype]);
  layers.push({ title: p.kind === 'stp' || p.kind === 'cdp' ? 'Ethernet 802.3' : 'Ethernet II', osi: 2, fields: l2 });

  switch (p.kind) {
    case 'arp':
      layers.push({
        title: 'ARP',
        osi: 2,
        fields: [
          ['Operação', p.op === 1 ? '1 (request)' : '2 (reply)'],
          ['MAC origem', p.senderMac],
          ['IP origem', formatIPv4(p.senderIp)],
          ['MAC destino', p.targetMac],
          ['IP destino', formatIPv4(p.targetIp)],
        ],
      });
      break;
    case 'stp':
      layers.push({
        title: 'Spanning Tree Protocol (802.1D)',
        osi: 2,
        fields:
          p.bpduType === 'tcn'
            ? [['Tipo', 'Topology Change Notification']]
            : [
                ['Raiz', `${p.root.priority} / ${p.root.mac}`],
                ['Custo até a raiz', String(p.rootCost)],
                ['Bridge', `${p.bridge.priority} / ${p.bridge.mac}`],
                ['Port ID', `0x${p.portId.toString(16)}`],
                ['Message age', `${p.messageAge}s`],
                ['Max age / Hello / Fwd delay', `${p.maxAge}s / ${p.helloTime}s / ${p.forwardDelay}s`],
                ['Flags', [p.tc && 'TC', p.tca && 'TCA'].filter(Boolean).join(' ') || '-'],
              ],
      });
      break;
    case 'cdp':
      layers.push({
        title: 'Cisco Discovery Protocol v2',
        osi: 2,
        fields: [
          ['Device ID', p.deviceId],
          ['Port ID', p.portId],
          ['Plataforma', p.platform],
          ['Capacidades', p.capabilities.join(', ')],
          ['Endereços', p.addresses.map(formatIPv4).join(', ') || '-'],
          ['Native VLAN', p.nativeVlan ? String(p.nativeVlan) : '-'],
          ['Holdtime', `${p.holdtime}s`],
        ],
      });
      break;
    case 'ipv4': {
      layers.push({
        title: 'IPv4',
        osi: 3,
        fields: [
          ['Origem', formatIPv4(p.src)],
          ['Destino', formatIPv4(p.dst)],
          ['TTL', String(p.ttl)],
          ['Protocolo', String(p.protocol)],
          ['Identificação', `0x${p.id.toString(16).padStart(4, '0')}`],
        ],
      });
      const q = p.payload;
      if (q.kind === 'icmp') {
        const f: [string, string][] = [
          ['Tipo', `${q.type} (${ICMP4_TYPES[q.type] ?? '?'})`],
          ['Código', `${q.code}${q.type === 3 ? ` (${UNREACH_CODES[q.code] ?? ''})` : ''}`],
        ];
        if (q.id !== undefined) f.push(['Identificador', String(q.id)], ['Sequência', String(q.seq)]);
        if (q.original) f.push(['Datagrama original', ip4Summary(q.original)]);
        layers.push({ title: 'ICMP', osi: 3, fields: f });
      } else if (q.kind === 'udp') {
        layers.push({ title: 'UDP', osi: 4, fields: [['Porta origem', String(q.srcPort)], ['Porta destino', String(q.dstPort)]] });
        if (q.payload.kind === 'dhcp') layers.push(dhcpLayer(q.payload));
      } else {
        layers.push({
          title: 'TCP',
          osi: 4,
          fields: [
            ['Porta origem', String(q.srcPort)],
            ['Porta destino', String(q.dstPort)],
            ['Seq / Ack', `${q.seq} / ${q.ack}`],
            ['Flags', Object.keys(q.flags).filter((k) => (q.flags as Record<string, boolean>)[k]).join(' ').toUpperCase()],
          ],
        });
      }
      break;
    }
    case 'ipv6': {
      layers.push({
        title: 'IPv6',
        osi: 3,
        fields: [
          ['Origem', formatIPv6(p.src)],
          ['Destino', formatIPv6(p.dst)],
          ['Hop limit', String(p.hopLimit)],
          ['Next header', String(p.nextHeader)],
        ],
      });
      const q = p.payload;
      if (q.kind === 'icmpv6') {
        const f: [string, string][] = [
          ['Tipo', `${q.type} (${ICMP6_TYPES[q.type] ?? '?'})`],
          ['Código', String(q.code)],
        ];
        if (q.target !== undefined) f.push(['Alvo', formatIPv6(q.target)]);
        if (q.lladdr) f.push(['Endereço de enlace', q.lladdr]);
        if (q.naFlags) f.push(['Flags', `R=${+q.naFlags.router} S=${+q.naFlags.solicited} O=${+q.naFlags.override}`]);
        if (q.ra) {
          f.push(['Router lifetime', `${q.ra.routerLifetime}s`], ['Flags M/O', `${+q.ra.managed}/${+q.ra.other}`]);
          for (const pf of q.ra.prefixes) f.push(['Prefixo', `${formatIPv6(pf.prefix)}/${pf.length} (L=${+pf.onLink} A=${+pf.autonomous})`]);
        }
        if (q.id !== undefined) f.push(['Identificador', String(q.id)], ['Sequência', String(q.seq)]);
        layers.push({ title: 'ICMPv6', osi: 3, fields: f });
      } else if (q.kind === 'udp') {
        layers.push({ title: 'UDP', osi: 4, fields: [['Porta origem', String(q.srcPort)], ['Porta destino', String(q.dstPort)]] });
      }
      break;
    }
  }
  return layers;
}

function dhcpLayer(d: DhcpMessage): Layer {
  const f: [string, string][] = [
    ['Mensagem', `${d.msgType} (${DHCP_NAMES[d.msgType]})`],
    ['Transaction ID', `0x${d.xid.toString(16)}`],
    ['MAC do cliente', d.chaddr],
    ['ciaddr', formatIPv4(d.ciaddr)],
    ['yiaddr (oferecido)', formatIPv4(d.yiaddr)],
    ['giaddr (relay)', formatIPv4(d.giaddr)],
    ['Broadcast flag', d.broadcast ? 'sim' : 'não'],
  ];
  const o = d.options;
  if (o.subnetMask !== undefined) f.push(['Máscara', formatIPv4(o.subnetMask)]);
  if (o.router?.length) f.push(['Gateway', o.router.map(formatIPv4).join(', ')]);
  if (o.dns?.length) f.push(['DNS', o.dns.map(formatIPv4).join(', ')]);
  if (o.leaseTime !== undefined) f.push(['Lease', `${o.leaseTime}s`]);
  if (o.serverId !== undefined) f.push(['Servidor', formatIPv4(o.serverId)]);
  if (o.requestedIp !== undefined) f.push(['IP solicitado', formatIPv4(o.requestedIp)]);
  return { title: 'DHCP', osi: 7, fields: f };
}
