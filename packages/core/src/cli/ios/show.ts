/** "show" command outputs, formatted like Cisco IOS 15 / IOS XE. */
import type { IosDevice, IosIf } from '../../devices/ios';
import { IF_TYPES } from '../../devices/ios';
import { classfulPrefix, formatIPv4, networkOf, prefixToMask, inSubnet, broadcastOf } from '../../net/ipv4';
import { formatIPv6 } from '../../net/ipv6';
import { macToCisco } from '../../net/mac';
import type { Route4 } from '../../l3/stack';
import { entryText } from '../../l3/acl';
import type { BridgePort } from '../../l2/bridge';

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);

function ifStatus(d: IosDevice, i: IosIf): { status: string; proto: string } {
  if (i.shutdown) return { status: 'administratively down', proto: 'down' };
  const up = d.isSwitchport(i) ? !!i.port?.isUp() : i.isUp();
  if (i.kind === 'svi') {
    return { status: 'up', proto: up ? 'up' : 'down' };
  }
  if (i.kind === 'sub') {
    const pu = i.parent!.shutdown ? 'administratively down' : i.parent!.port?.isUp() ? 'up' : 'down';
    return { status: pu === 'up' ? 'up' : pu === 'administratively down' ? 'administratively down' : 'down', proto: up ? 'up' : 'down' };
  }
  const phys = i.kind === 'loopback' ? true : !!i.port?.carrier && !i.port?.errDisabled;
  return { status: phys ? 'up' : 'down', proto: up ? 'up' : 'down' };
}

export function showIpIntBrief(d: IosDevice): string {
  const lines = [`${pad('Interface', 23)}${pad('IP-Address', 16)}OK? Method Status                Protocol`];
  for (const i of d.sortedIfs()) {
    const a = i.v4.find((x) => !x.secondary);
    const ip = a ? formatIPv4(a.addr) : 'unassigned';
    const method = i.dhcpAddr ? 'DHCP' : a ? 'manual' : 'unset';
    const st = ifStatus(d, i);
    lines.push(`${pad(i.name, 22)} ${pad(ip, 15)} YES ${pad(method, 6)} ${pad(st.status, 21)} ${st.proto}`);
  }
  return lines.join('\n') + '\n';
}

export function showIpv6IntBrief(d: IosDevice): string {
  const lines: string[] = [];
  for (const i of d.sortedIfs()) {
    if (d.isSwitchport(i)) continue;
    const st = ifStatus(d, i);
    lines.push(`${pad(i.name, 23)}[${st.status}/${st.proto}]`);
    if (!i.v6Enabled) lines.push('    unassigned');
    else for (const a of i.v6) lines.push(`    ${formatIPv6(a.addr, true)}`);
  }
  return lines.join('\n') + '\n';
}

function hwName(i: IosIf): string {
  if (i.kind === 'svi') return 'EtherSVI';
  if (i.kind === 'loopback') return 'Loopback';
  const t = i.name.startsWith('Fast') ? 'Fast Ethernet' : 'Gigabit Ethernet';
  return t;
}

export function showInterfaces(d: IosDevice, only?: IosIf): string {
  const out: string[] = [];
  for (const i of only ? [only] : d.sortedIfs()) {
    const st = ifStatus(d, i);
    const port = i.port ?? i.parent?.port;
    const err = port?.errDisabled ? ' (err-disabled)' : '';
    const conn = d.isSwitchport(i) && st.proto === 'up' ? ' (connected)' : '';
    out.push(`${i.name} is ${st.status}, line protocol is ${st.proto}${err || conn}`);
    out.push(`  Hardware is ${hwName(i)}, address is ${macToCisco(i.mac)} (bia ${macToCisco(i.mac)})`);
    if (i.description) out.push(`  Description: ${i.description}`);
    for (const a of i.v4) out.push(`  Internet address is ${formatIPv4(a.addr)}/${a.prefix}${a.secondary ? ' secondary' : ''}`);
    const speed = port?.speed() || (port ? Math.max(...port.spec.speeds) : 8000);
    const bw = i.kind === 'loopback' ? 8000000 : speed * 1000;
    out.push(`  MTU 1500 bytes, BW ${bw} Kbit/sec, DLY ${i.kind === 'loopback' ? 5000 : speed >= 1000 ? 10 : 100} usec,`);
    out.push('     reliability 255/255, txload 1/255, rxload 1/255');
    if (i.kind === 'sub') out.push(`  Encapsulation 802.1Q Virtual LAN, Vlan ID  ${i.vlan ?? 1}.`);
    else out.push(`  Encapsulation ${i.kind === 'loopback' ? 'LOOPBACK' : 'ARPA'}, loopback not set`);
    if (port && i.kind === 'physical') {
      out.push('  Keepalive set (10 sec)');
      if (port.isUp()) {
        const dpx = port.duplexOper() === 'full' ? 'Full-duplex' : 'Half-duplex';
        const sp = speed >= 1000 ? `${speed / 1000}Gb/s` : `${speed}Mb/s`;
        out.push(`  ${dpx}, ${sp}, media type is 10/100${port.spec.speeds.includes(1000) ? '/1000' : ''}BaseTX`);
      } else out.push('  Auto-duplex, Auto-speed, media type is 10/100BaseTX');
      out.push('  input flow-control is off, output flow-control is unsupported');
    }
    out.push('  ARP type: ARPA, ARP Timeout 04:00:00');
    out.push('  Last input never, output never, output hang never');
    out.push('  Last clearing of "show interface" counters never');
    out.push('  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: 0');
    out.push('  Queueing strategy: fifo');
    out.push('  Output queue: 0/40 (size/max)');
    out.push('  5 minute input rate 0 bits/sec, 0 packets/sec');
    out.push('  5 minute output rate 0 bits/sec, 0 packets/sec');
    const rx = port?.stats.rxFrames ?? 0;
    const tx = port?.stats.txFrames ?? 0;
    out.push(`     ${rx} packets input, ${rx * 64} bytes, 0 no buffer`);
    out.push('     Received 0 broadcasts (0 multicasts)');
    out.push('     0 runts, 0 giants, 0 throttles');
    out.push('     0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored');
    out.push(`     ${tx} packets output, ${tx * 64} bytes, 0 underruns`);
    out.push('     0 output errors, 0 collisions, 1 interface resets');
  }
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ routing

const ROUTE_CODES = `Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2
       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2
       ia - IS-IS inter area, * - candidate default, U - per-user static route
       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP
       + - replicated route, % - next hop override
`;

function routeText(r: Route4, withMask: boolean): string {
  const dest = withMask ? `${formatIPv4(r.net)}/${r.prefix}` : formatIPv4(r.net);
  if (r.code === 'C' || r.code === 'L') return `${dest} is directly connected, ${r.iface!.name}`;
  if (r.nextHop === undefined) return `${dest} is directly connected, ${r.iface!.name}`;
  return `${dest} [${r.ad}/${r.metric}] via ${formatIPv4(r.nextHop)}${r.iface ? `, ${r.iface.name}` : ''}`;
}

export function showIpRoute(d: IosDevice, filter?: 'connected' | 'static'): string {
  const st = d.stack;
  if (!st.routing) {
    const gw = st.defaultGateway !== undefined ? formatIPv4(st.defaultGateway) : 'not set';
    return `Default gateway is ${gw}\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty\n`;
  }
  let routes = st.routes4();
  if (filter === 'connected') routes = routes.filter((r) => r.code === 'C' || r.code === 'L');
  if (filter === 'static') routes = routes.filter((r) => r.code === 'S' || r.code === 'S*');
  const def = st.routes4().find((r) => r.prefix === 0);
  let out = ROUTE_CODES + '\n';
  out += def ? `Gateway of last resort is ${def.nextHop !== undefined ? formatIPv4(def.nextHop) : '0.0.0.0'} to network 0.0.0.0\n\n` : 'Gateway of last resort is not set\n\n';
  // Group by classful network.
  const groups = new Map<number, Route4[]>();
  for (const r of routes) {
    const key = r.prefix === 0 ? -1 : networkOf(r.net, classfulPrefix(r.net));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === -1 ? -1 : b === -1 ? 1 : (a >>> 0) - (b >>> 0)));
  const codeOrder = (r: Route4) => (r.code === 'L' ? 1 : 0);
  for (const k of keys) {
    const rs = groups.get(k)!.sort((a, b) => (a.net >>> 0) - (b.net >>> 0) || a.prefix - b.prefix || codeOrder(a) - codeOrder(b));
    if (k === -1) {
      for (const r of rs) out += `${pad(r.code, 6)}${routeText(r, true)}\n`;
      continue;
    }
    const cp = classfulPrefix(k);
    if (rs.length === 1 && rs[0].prefix === cp) {
      out += `${pad(rs[0].code, 6)}${routeText(rs[0], true)}\n`;
      continue;
    }
    const masks = new Set(rs.map((r) => r.prefix));
    if (masks.size === 1) {
      out += `      ${formatIPv4(k)}/${rs[0].prefix} is subnetted, ${rs.length} subnets\n`;
      for (const r of rs) out += `${pad(r.code, 9)}${routeText(r, false)}\n`;
    } else {
      out += `      ${formatIPv4(k)}/${cp} is variably subnetted, ${rs.length} subnets, ${masks.size} masks\n`;
      for (const r of rs) out += `${pad(r.code, 9)}${routeText(r, true)}\n`;
    }
  }
  return out;
}

export function showIpv6Route(d: IosDevice): string {
  const routes = d.stack.routes6();
  let out = `IPv6 Routing Table - default - ${routes.length + 1} entries
Codes: C - Connected, L - Local, S - Static, U - Per-user Static route
       B - BGP, R - RIP, H - NHRP, I1 - ISIS L1
       I2 - ISIS L2, IA - ISIS interarea, IS - ISIS summary, D - EIGRP
       EX - EIGRP external, ND - ND Default, NDp - ND Prefix, DCE - Destination
       NDr - Redirect, O - OSPF Intra, OI - OSPF Inter, OE1 - OSPF ext 1
       OE2 - OSPF ext 2, ON1 - OSPF NSSA ext 1, ON2 - OSPF NSSA ext 2
       a - Application
`;
  const sorted = [...routes].sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : a.prefix - b.prefix));
  for (const r of sorted) {
    out += `${pad(r.code, 4)}${formatIPv6(r.net, true)}/${r.prefix} [${r.ad}/${r.metric}]\n`;
    if (r.code === 'C') out += `     via ${r.iface!.name}, directly connected\n`;
    else if (r.code === 'L') out += `     via ${r.iface!.name}, receive\n`;
    else out += `     via ${[r.nextHop !== undefined ? formatIPv6(r.nextHop, true) : '', r.iface?.name ?? ''].filter(Boolean).join(', ')}\n`;
  }
  out += 'L   FF00::/8 [0/0]\n     via Null0, receive\n';
  return out;
}

export function showArp(d: IosDevice): string {
  const lines = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
  const rows: [number, string][] = [];
  for (const i of d.l3Ifs()) {
    if (!i.isUp() || i.loopback) continue;
    for (const a of i.v4) rows.push([a.addr, `Internet  ${pad(formatIPv4(a.addr), 17)}${lpad('-', 9)}   ${pad(macToCisco(i.mac), 16)}ARPA   ${i.name}`]);
  }
  for (const e of d.stack.arpEntries()) {
    const age = Math.floor((d.simulator.now - e.time) / 60000);
    rows.push([e.ip, `Internet  ${pad(formatIPv4(e.ip), 17)}${lpad(e.mac ? age : '0', 9)}   ${pad(e.mac ? macToCisco(e.mac) : 'Incomplete', 16)}ARPA   ${e.mac ? e.iface.name : ''}`]);
  }
  rows.sort((a, b) => (a[0] >>> 0) - (b[0] >>> 0));
  return [...lines, ...rows.map((r) => r[1])].join('\n') + '\n';
}

export function showIpv6Neighbors(d: IosDevice): string {
  const lines = ['IPv6 Address                              Age Link-layer Addr State Interface'];
  for (const n of d.stack.neighborEntries()) {
    const age = Math.floor((d.simulator.now - n.time) / 60000);
    lines.push(`${pad(formatIPv6(n.ip, true), 42)}${lpad(age, 3)} ${pad(n.mac ? macToCisco(n.mac) : '-', 15)} ${pad(n.mac ? 'REACH' : 'INCMP', 5)} ${n.iface.short}`);
  }
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------------ switching

function portList(names: string[], indent: number, width = 31): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const n of names) {
    const piece = cur ? `, ${n}` : n;
    if ((cur + piece).length > width) {
      lines.push(cur + ',');
      cur = n;
    } else cur += piece;
  }
  if (cur) lines.push(cur);
  return lines.map((l, i) => (i === 0 ? l : ' '.repeat(indent) + l));
}

export function showVlanBrief(d: IosDevice, full = false): string {
  const b = d.bridge!;
  let out = `\n${pad('VLAN', 5)}${pad('Name', 33)}${pad('Status', 10)}Ports\n---- -------------------------------- --------- -------------------------------\n`;
  for (const v of [...b.vlans.values()].sort((a, c) => a.id - c.id)) {
    const ports = b.ports.filter((bp) => !bp.routed && !bp.trunk && bp.cfg.accessVlan === v.id).map((bp) => bp.port.short);
    const status = v.id >= 1002 ? 'act/unsup' : 'active';
    const pl = portList(ports, 48);
    out += `${pad(v.id, 5)}${pad(v.name, 33)}${pad(status, 10)}${pl[0] ?? ''}\n`;
    for (const l of pl.slice(1)) out += l + '\n';
  }
  if (full) {
    out += '\nVLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2\n---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------\n';
    for (const v of [...b.vlans.values()].sort((a, c) => a.id - c.id)) out += `${pad(v.id, 5)}enet  ${pad(100000 + v.id, 11)}1500  -      -      -        -    -        0      0\n`;
  }
  return out;
}

function vlanRanges(vs: number[]): string {
  const s = [...new Set(vs)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
    i = j + 1;
  }
  return out.join(',') || 'none';
}

export { vlanRanges };

export function showInterfacesTrunk(d: IosDevice): string {
  const b = d.bridge!;
  const trunks = b.ports.filter((bp) => !bp.routed && bp.trunk && bp.port.isUp());
  if (!trunks.length) return '\n';
  const modeName = (bp: BridgePort) => (bp.cfg.mode === 'trunk' ? 'on' : bp.cfg.mode === 'dynamic desirable' ? 'desirable' : 'auto');
  const allowed = (bp: BridgePort) => (bp.cfg.allowed === null ? '1-4094' : vlanRanges([...bp.cfg.allowed]));
  const active = (bp: BridgePort) => vlanRanges([...b.vlans.keys()].filter((v) => v < 1002 && (bp.cfg.allowed === null || bp.cfg.allowed.has(v))));
  let out = `\n${pad('Port', 12)}${pad('Mode', 17)}${pad('Encapsulation', 15)}${pad('Status', 14)}Native vlan\n`;
  for (const bp of trunks) out += `${pad(bp.port.short, 12)}${pad(modeName(bp), 17)}${pad(bp.cfg.mode === 'trunk' ? '802.1q' : 'n-802.1q', 15)}${pad('trunking', 14)}${bp.cfg.nativeVlan}\n`;
  out += `\n${pad('Port', 12)}Vlans allowed on trunk\n`;
  for (const bp of trunks) out += `${pad(bp.port.short, 12)}${allowed(bp)}\n`;
  out += `\n${pad('Port', 12)}Vlans allowed and active in management domain\n`;
  for (const bp of trunks) out += `${pad(bp.port.short, 12)}${active(bp)}\n`;
  out += `\n${pad('Port', 12)}Vlans in spanning tree forwarding state and not pruned\n`;
  for (const bp of trunks) out += `${pad(bp.port.short, 12)}${bp.state === 'forwarding' ? active(bp) : 'none'}\n`;
  return out;
}

export function showInterfacesStatus(d: IosDevice): string {
  const b = d.bridge!;
  let out = `\n${pad('Port', 10)}${pad('Name', 19)}${pad('Status', 13)}${pad('Vlan', 11)}${pad('Duplex', 7)}${lpad('Speed', 6)} Type\n`;
  for (const bp of b.ports) {
    const i = d.findIf(bp.port.name)!;
    const p = bp.port;
    const status = p.errDisabled ? 'err-disabled' : i.shutdown ? 'disabled' : p.isUp() ? 'connected' : 'notconnect';
    const vlan = bp.routed ? 'routed' : bp.trunk ? 'trunk' : String(bp.cfg.accessVlan);
    const duplex = p.isUp() ? `a-${p.duplexOper()}` : 'auto';
    const sp = p.isUp() ? `a-${p.speed()}` : 'auto';
    const type = p.spec.media === 'fiber' ? '1000BaseSX SFP' : p.spec.speeds.includes(1000) ? '10/100/1000BaseTX' : '10/100BaseTX';
    out += `${pad(p.short, 10)}${pad(i.description.slice(0, 18), 19)}${pad(status, 13)}${pad(vlan, 11)}${lpad(duplex, 6)} ${lpad(sp, 6)} ${type}\n`;
  }
  return out;
}

export function showSwitchport(d: IosDevice, i: IosIf): string {
  const bp = d.bp(i);
  if (!bp) return '';
  if (bp.routed) return `Name: ${i.short}\nSwitchport: Disabled\n`;
  const b = d.bridge!;
  const admin = bp.cfg.mode === 'access' ? 'static access' : bp.cfg.mode === 'trunk' ? 'trunk' : bp.cfg.mode;
  const oper = !bp.port.isUp() ? 'down' : bp.trunk ? 'trunk' : 'static access';
  const vname = (v: number) => b.vlans.get(v)?.name ?? 'Inactive';
  return `Name: ${i.short}
Switchport: Enabled
Administrative Mode: ${admin}
Operational Mode: ${oper}
Administrative Trunking Encapsulation: dot1q
Operational Trunking Encapsulation: ${bp.trunk ? 'dot1q' : 'native'}
Negotiation of Trunking: ${bp.cfg.nonegotiate || bp.cfg.mode === 'access' ? 'Off' : 'On'}
Access Mode VLAN: ${bp.cfg.accessVlan} (${vname(bp.cfg.accessVlan)})
Trunking Native Mode VLAN: ${bp.cfg.nativeVlan} (${vname(bp.cfg.nativeVlan)})
Administrative Native VLAN tagging: enabled
Voice VLAN: none
Administrative private-vlan host-association: none
Administrative private-vlan mapping: none
Operational private-vlan: none
Trunking VLANs Enabled: ${bp.cfg.allowed === null ? 'ALL' : vlanRanges([...bp.cfg.allowed])}
Pruning VLANs Enabled: 2-1001
Capture Mode Disabled
Capture VLANs Allowed: ALL
Protected: false
Unknown unicast blocked: disabled
Unknown multicast blocked: disabled
Appliance trust: none
`;
}

export function showMacTable(d: IosDevice, filter: { vlan?: number; iface?: string; dynamic?: boolean; address?: string }): string {
  const b = d.bridge!;
  let entries = b.entries().filter((e) => e.port);
  if (filter.vlan !== undefined) entries = entries.filter((e) => e.vlan === filter.vlan);
  if (filter.iface) entries = entries.filter((e) => e.port!.port.name === filter.iface);
  if (filter.dynamic) entries = entries.filter((e) => !e.static);
  if (filter.address) entries = entries.filter((e) => e.mac === filter.address);
  entries.sort((a, c) => a.vlan - c.vlan || a.mac.localeCompare(c.mac));
  let out = '          Mac Address Table\n-------------------------------------------\n\nVlan    Mac Address       Type        Ports\n----    -----------       --------    -----\n';
  for (const e of entries) out += `${lpad(e.vlan, 4)}    ${pad(macToCisco(e.mac), 18)}${pad(e.static ? 'STATIC' : 'DYNAMIC', 12)}${e.port!.port.short}\n`;
  out += `Total Mac Addresses for this criterion: ${entries.length}\n`;
  return out;
}

export function showSpanningTree(d: IosDevice, onlyVlan?: number): string {
  const b = d.bridge!;
  if (!b.stpEnabled) return onlyVlan !== undefined ? `Spanning tree instance(s) for vlan ${onlyVlan} does not exist.\n` : 'No spanning tree instance exists.\n';
  const vlans = [...b.vlans.keys()].filter((v) => v < 1002 && (onlyVlan === undefined || v === onlyVlan)).filter((v) => b.ports.some((bp) => !bp.routed && bp.port.isUp() && b.vlanAllowed(bp, v)));
  if (!vlans.length) return onlyVlan !== undefined ? `Spanning tree instance(s) for vlan ${onlyVlan} does not exist.\n` : 'No spanning tree instance exists.\n';
  let out = '';
  for (const v of vlans) {
    const rootPrio = b.rootId.priority - 1 + v;
    const myPrio = b.priority + v;
    out += `VLAN${String(v).padStart(4, '0')}\n  Spanning tree enabled protocol ${b.stpMode === 'rapid-pvst' ? 'rstp' : 'ieee'}\n`;
    out += `  Root ID    Priority    ${rootPrio}\n             Address     ${macToCisco(b.rootId.mac)}\n`;
    if (b.isRoot()) out += '             This bridge is the root\n';
    else {
      const rp = b.rootPort!;
      out += `             Cost        ${b.rootCost}\n             Port        ${rp.index + 1}(${rp.port.name})\n`;
    }
    out += '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec\n\n';
    out += `  Bridge ID  Priority    ${myPrio}  (priority ${b.priority} sys-id-ext ${v})\n             Address     ${macToCisco(d.baseMac)}\n`;
    out += '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec\n             Aging Time  300 sec\n\n';
    out += 'Interface           Role Sts Cost      Prio.Nbr Type\n------------------- ---- --- --------- -------- --------------------------------\n';
    for (const bp of b.ports) {
      if (bp.routed || !bp.port.isUp() || !b.vlanAllowed(bp, v)) continue;
      const role = { root: 'Root', designated: 'Desg', alternate: 'Altn', disabled: 'Disa' }[bp.role];
      const sts = { forwarding: 'FWD', blocking: 'BLK', listening: 'LIS', learning: 'LRN', disabled: 'DIS' }[bp.state];
      const type = (bp.port.duplexOper() === 'half' ? 'Shr' : 'P2p') + (b.isPortfast(bp) ? ' Edge' : '');
      out += `${pad(bp.port.short, 20)}${role} ${sts} ${pad(b.portCost(bp), 10)}${pad(`${bp.cfg.priority}.${bp.index + 1}`, 9)}${type}\n`;
    }
    out += '\n';
  }
  return out;
}

// ------------------------------------------------------------------ services

export function showNatTranslations(d: IosDevice): string {
  const tr = d.stack.natTranslations();
  let out = `${pad('Pro', 5)}${pad('Inside global', 22)}${pad('Inside local', 22)}${pad('Outside local', 22)}Outside global\n`;
  const ap = (ip?: number, port?: number) => (ip === undefined ? '---' : port !== undefined ? `${formatIPv4(ip)}:${port}` : formatIPv4(ip));
  for (const t of tr) {
    const pro = t.proto ?? '---';
    const og = t.outsideGlobal !== undefined ? ap(t.outsideGlobal, t.proto ? t.outsideGlobalPort ?? t.insideLocalPort : undefined) : '---';
    out += `${pad(pro, 5)}${pad(ap(t.insideGlobal, t.proto ? t.insideGlobalPort : undefined), 22)}${pad(ap(t.insideLocal, t.proto ? t.insideLocalPort : undefined), 22)}${pad(og, 22)}${og}\n`;
  }
  return out;
}

export function showNatStatistics(d: IosDevice): string {
  const tr = d.stack.natTranslations();
  const stat = tr.filter((t) => t.static).length;
  const ext = tr.filter((t) => t.proto).length;
  const ins = d.l3Ifs().filter((i) => i.nat === 'inside').map((i) => `  ${i.name}`);
  const outs = d.l3Ifs().filter((i) => i.nat === 'outside').map((i) => `  ${i.name}`);
  let out = `Total active translations: ${tr.length} (${stat} static, ${tr.length - stat} dynamic; ${ext} extended)\nOutside interfaces:\n${outs.join('\n')}\nInside interfaces: \n${ins.join('\n')}\n`;
  out += 'Dynamic mappings:\n-- Inside Source\n';
  for (const r of d.stack.natDynamics) out += `[Id: 1] access-list ${r.acl} ${r.iface ? `interface ${r.iface}` : `pool ${r.pool}`}${r.overload ? ' overload' : ''} refcount ${tr.filter((t) => !t.static).length}\n`;
  return out;
}

export function showAccessLists(d: IosDevice, name?: string): string {
  let out = '';
  for (const acl of d.stack.acls.values()) {
    if (name && acl.name !== name) continue;
    const std = acl.type === 'standard';
    out += `${std ? 'Standard' : 'Extended'} IP access list ${acl.name}\n`;
    for (const e of acl.entries) {
      let t: string;
      if (std) {
        t = e.src.wildcard === 0xffffffff ? `${e.action} any` : e.src.wildcard === 0 ? `${e.action} ${formatIPv4(e.src.addr)}` : `${e.action} ${formatIPv4(e.src.addr)}, wildcard bits ${formatIPv4(e.src.wildcard)}`;
        if (e.log) t += ' log';
      } else t = entryText(e, false);
      out += `    ${e.seq} ${t}${e.matches ? ` (${e.matches} match${e.matches > 1 ? 'es' : ''})` : ''}\n`;
    }
  }
  return out;
}

export function showDhcpBinding(d: IosDevice): string {
  let out = 'Bindings from all pools not associated with VRF:\nIP address          Client-ID/              Lease expiration        Type\n                    Hardware address/\n                    User name\n';
  const now = d.simulator.now;
  for (const b of [...d.stack.dhcpBindings.values()].sort((a, c) => (a.ip >>> 0) - (c.ip >>> 0))) {
    if (b.expires <= now || b.offered) continue;
    const cid = ('01' + b.mac.replace(/:/g, '')).replace(/(.{4})/g, '$1.').replace(/\.$/, '');
    out += `${pad(formatIPv4(b.ip), 20)}${pad(cid, 24)}${pad(clockText(d, b.expires, true), 24)}Automatic\n`;
  }
  return out;
}

export function showDhcpPool(d: IosDevice): string {
  let out = '';
  for (const p of d.stack.dhcpPools.values()) {
    out += `\nPool ${p.name} :\n Utilization mark (high/low)    : 100 / 0\n Subnet size (first/next)       : 0 / 0 \n`;
    if (p.network === undefined) {
      out += ' Total addresses                : 0\n Leased addresses               : 0\n Pending event                  : none\n 0 subnet is currently in the pool :\n';
      continue;
    }
    const total = 2 ** (32 - p.prefix!) - 2;
    const leased = [...d.stack.dhcpBindings.values()].filter((b) => b.pool === p.name && !b.offered && b.expires > d.simulator.now).length;
    const first = (p.network + 1) >>> 0;
    const last = (broadcastOf(p.network, p.prefix!) - 1) >>> 0;
    out += ` Total addresses                : ${total}\n Leased addresses               : ${leased}\n Pending event                  : none\n 1 subnet is currently in the pool :\n Current index        IP address range                    Leased addresses\n`;
    out += ` ${pad(formatIPv4(first), 21)}${pad(formatIPv4(first), 17)}- ${pad(formatIPv4(last), 18)}${leased}\n`;
  }
  return out;
}

// ------------------------------------------------------------------ CDP

export function showCdpNeighbors(d: IosDevice, detail: boolean): string {
  const now = d.simulator.now;
  const ns = [...d.cdpNeighbors.values()].filter((n) => n.holdUntil > now);
  const capLetters = (c: string[]) => c.map((x) => ({ Router: 'R', Switch: 'S', IGMP: 'I', Host: 'H' })[x] ?? '').join(' ');
  const cdpIf = (name: string) => {
    const m = /^([A-Za-z-]+)(.*)$/.exec(name);
    return m && IF_TYPES[m[1]] ? `${IF_TYPES[m[1]].cdp} ${m[2]}` : name;
  };
  if (!detail) {
    let out = `Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge
                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone,
                  D - Remote, C - CVTA, M - Two-port Mac Relay

Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID
`;
    for (const n of ns) {
      const hold = Math.max(0, Math.floor((n.holdUntil - now) / 1000));
      out += `${pad(n.deviceId.slice(0, 16), 17)}${pad(cdpIf(n.localPort), 18)}${pad(lpad(hold, 6), 11)}${pad(lpad(capLetters(n.capabilities), 10), 12)}${pad(n.platform.replace('cisco ', '').slice(0, 9), 10)}${cdpIf(n.portId)}\n`;
    }
    out += `\nTotal cdp entries displayed : ${ns.length}\n`;
    return out;
  }
  let out = '';
  for (const n of ns) {
    const hold = Math.max(0, Math.floor((n.holdUntil - now) / 1000));
    out += `-------------------------\nDevice ID: ${n.deviceId}\nEntry address(es): \n${n.addresses.map((a) => `  IP address: ${formatIPv4(a)}`).join('\n')}${n.addresses.length ? '\n' : ''}`;
    out += `Platform: ${n.platform},  Capabilities: ${n.capabilities.join(' ')} \nInterface: ${n.localPort},  Port ID (outgoing port): ${n.portId}\nHoldtime : ${hold} sec\n\nVersion :\n${n.version}\n\nadvertisement version: 2\n`;
    if (n.nativeVlan !== undefined) out += `Native VLAN: ${n.nativeVlan}\n`;
    out += 'Duplex: full\n\n';
  }
  out += `\nTotal cdp entries displayed : ${ns.length}\n`;
  return out;
}

// ------------------------------------------------------------------ system

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** IOS clock starts at 00:00 UTC Mar 1 1993 when not set. */
const CLOCK_BASE = Date.UTC(1993, 2, 1, 0, 0, 0);

export function clockText(d: IosDevice, at: number, short = false): string {
  const t = new Date(CLOCK_BASE + at);
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  const ss = String(t.getUTCSeconds()).padStart(2, '0');
  if (short) {
    const h12 = t.getUTCHours() % 12 || 12;
    return `${MONTHS[t.getUTCMonth()]} ${String(t.getUTCDate()).padStart(2, '0')} ${t.getUTCFullYear()} ${String(h12).padStart(2, '0')}:${mm} ${t.getUTCHours() < 12 ? 'AM' : 'PM'}`;
  }
  const ms = String(t.getUTCMilliseconds()).padStart(3, '0');
  void d;
  return `*${hh}:${mm}:${ss}.${ms} UTC ${DAYS[t.getUTCDay()]} ${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()} ${t.getUTCFullYear()}`;
}

export function showVersion(d: IosDevice): string {
  const sw = d.model.software!;
  const fe = d.ports.filter((p) => p.name.startsWith('Fast')).length;
  const ge = d.ports.filter((p) => p.name.startsWith('Gigabit')).length;
  let out = `${sw.banner}
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2019 by Cisco Systems, Inc.
Compiled by prod_rel_team

ROM: Bootstrap program is ${d.model.name} boot loader

${d.hostname} uptime is ${d.uptime()}
System returned to ROM by power-on
System image file is "flash:${sw.image.toLowerCase()}.bin"

cisco ${d.model.id} processor with ${sw.memory} bytes of memory.
Processor board ID ${d.serial}
`;
  if (fe) out += `${fe} FastEthernet interfaces\n`;
  if (ge) out += `${ge} Gigabit Ethernet interfaces\n`;
  out += `${d.bridge ? '64K' : '255K'} bytes of non-volatile configuration memory.\n${sw.flash} bytes of flash memory.\n`;
  if (d.bridge) out += `\nBase ethernet MAC Address       : ${d.baseMac.toUpperCase()}\nModel number                    : ${d.model.id}\nSystem serial number            : ${d.serial}\n`;
  out += `\nConfiguration register is ${d.configRegister}\n`;
  return out;
}

export function maskText(prefix: number) {
  return formatIPv4(prefixToMask(prefix));
}

export { inSubnet };
