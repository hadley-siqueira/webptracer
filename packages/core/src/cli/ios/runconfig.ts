/**
 * Builds the running-config text from the device state. This text is the source of truth
 * for persistence: saving a lab stores it; loading replays it through the CLI.
 */
import type { IosDevice, IosIf, LineCfg } from '../../devices/ios';
import { formatIPv4, prefixToMask } from '../../net/ipv4';
import { formatIPv6 } from '../../net/ipv6';
import { macToCisco } from '../../net/mac';
import { entryText } from '../../l3/acl';
import { type7Encrypt } from './passwords';
import { vlanRanges } from './show';

const mask = (p: number) => formatIPv4(prefixToMask(p));

function pw(d: IosDevice, plain: string): string {
  return d.passwordEncryption ? `7 ${type7Encrypt(plain)}` : plain;
}

function ifBlock(d: IosDevice, i: IosIf, only = false): string[] {
  const l: string[] = [`interface ${i.name}`];
  if (i.description) l.push(` description ${i.description}`);
  if (i.kind === 'sub' && i.vlan !== undefined) l.push(` encapsulation dot1Q ${i.vlan}${i.native ? ' native' : ''}`);
  const bp = d.bp(i);
  if (bp && bp.routed && d.model.caps.routedPorts) l.push(' no switchport');
  if (bp && !bp.routed) {
    const c = bp.cfg;
    if (c.accessVlan !== 1) l.push(` switchport access vlan ${c.accessVlan}`);
    if (c.nativeVlan !== 1) l.push(` switchport trunk native vlan ${c.nativeVlan}`);
    if (c.allowed !== null) l.push(` switchport trunk allowed vlan ${c.allowed.size ? vlanRanges([...c.allowed]) : 'none'}`);
    if (c.mode === 'access') l.push(' switchport mode access');
    else if (c.mode === 'trunk') l.push(' switchport mode trunk');
    else if (c.mode === 'dynamic desirable') l.push(' switchport mode dynamic desirable');
    if (c.nonegotiate) l.push(' switchport nonegotiate');
    if (c.portfast) l.push(' spanning-tree portfast');
    if (c.bpduguard) l.push(' spanning-tree bpduguard enable');
    if (c.cost !== undefined) l.push(` spanning-tree cost ${c.cost}`);
    if (c.priority !== 128) l.push(` spanning-tree port-priority ${c.priority}`);
  } else {
    if (i.dhcpAddr) l.push(' ip address dhcp');
    else if (!i.v4.length) l.push(' no ip address');
    for (const a of i.v4) if (a.source === 'manual') l.push(` ip address ${formatIPv4(a.addr)} ${mask(a.prefix)}${a.secondary ? ' secondary' : ''}`);
    for (const h of i.helpers) l.push(` ip helper-address ${formatIPv4(h)}`);
    if (i.aclIn) l.push(` ip access-group ${i.aclIn} in`);
    if (i.aclOut) l.push(` ip access-group ${i.aclOut} out`);
    if (i.nat) l.push(` ip nat ${i.nat}`);
    if (i.ipv6On) l.push(' ipv6 enable');
    for (const a of i.v6) {
      if (a.source === 'manual') l.push(` ipv6 address ${formatIPv6(a.addr, true)}/${a.prefix}`);
      else if (a.source === 'eui64') l.push(` ipv6 address ${formatIPv6(a.addr & ~((1n << 64n) - 1n), true)}/${a.prefix} eui-64`);
      else if (a.source === 'linklocal' && a.manual) l.push(` ipv6 address ${formatIPv6(a.addr, true)} link-local`);
    }
    if (i.raInterval !== undefined) l.push(` ipv6 nd ra interval ${i.raInterval}`);
    if (i.raSuppress) l.push(' ipv6 nd ra suppress');
  }
  if (i.kind === 'physical') {
    if (i.duplexCfg !== 'auto') l.push(` duplex ${i.duplexCfg}`);
    else if (!d.bridge) l.push(' duplex auto');
    if (i.speedCfg !== 'auto') l.push(` speed ${i.speedCfg}`);
    else if (!d.bridge) l.push(' speed auto');
  }
  if (!i.cdp) l.push(' no cdp enable');
  if (i.shutdown) l.push(' shutdown');
  if (!only) l.push('!');
  return l;
}

export function interfaceConfig(d: IosDevice, i: IosIf): string {
  return ifBlock(d, i, true).join('\n');
}

function lineBlock(d: IosDevice, header: string, c: LineCfg): string[] {
  const l = [header];
  if (c.execTimeout) l.push(` exec-timeout ${c.execTimeout[0]} ${c.execTimeout[1]}`);
  if (c.password !== undefined) l.push(` password ${pw(d, c.password)}`);
  if (c.loggingSync) l.push(' logging synchronous');
  if (c.login === 'local') l.push(' login local');
  else if (c.login && header.startsWith('line con')) l.push(' login');
  else if (c.login && header.startsWith('line vty')) l.push(' login');
  if (c.transportInput) l.push(` transport input ${c.transportInput}`);
  return l;
}

export function buildRunningConfig(d: IosDevice): string {
  const st = d.stack;
  const l: string[] = ['!'];
  const ver = d.model.software?.version.split('(')[0].split('.').slice(0, 2).join('.') ?? '15.1';
  l.push(`version ${ver}`);
  l.push('service timestamps debug datetime msec', 'service timestamps log datetime msec');
  l.push(d.passwordEncryption ? 'service password-encryption' : 'no service password-encryption');
  l.push('!', `hostname ${d.hostname}`, '!', 'boot-start-marker', 'boot-end-marker', '!');
  if (d.enableSecret) l.push(`enable secret 5 ${d.enableSecret}`);
  if (d.enablePassword !== undefined) l.push(`enable password ${pw(d, d.enablePassword)}`);
  if (d.enableSecret || d.enablePassword !== undefined) l.push('!');
  for (const [name, u] of d.users) {
    l.push(`username ${name}${u.privilege !== 1 ? ` privilege ${u.privilege}` : ''} ${u.type === 'secret' ? `secret 5 ${u.secret}` : `password ${pw(d, u.secret)}`}`);
  }
  if (d.users.size) l.push('!');
  l.push('no aaa new-model', '!');
  for (const [lo, hi] of st.dhcpExcluded) l.push(`ip dhcp excluded-address ${formatIPv4(lo)}${hi !== lo ? ` ${formatIPv4(hi)}` : ''}`);
  if (st.dhcpExcluded.length) l.push('!');
  for (const p of st.dhcpPools.values()) {
    l.push(`ip dhcp pool ${p.name}`);
    if (p.network !== undefined) l.push(` network ${formatIPv4(p.network)} ${mask(p.prefix!)}`);
    if (p.defaultRouter.length) l.push(` default-router ${p.defaultRouter.map(formatIPv4).join(' ')}`);
    if (p.dns.length) l.push(` dns-server ${p.dns.map(formatIPv4).join(' ')}`);
    if (p.domain) l.push(` domain-name ${p.domain}`);
    if (p.leaseSec !== 86400) {
      const dd = Math.floor(p.leaseSec / 86400);
      const hh = Math.floor((p.leaseSec % 86400) / 3600);
      const mm = Math.floor((p.leaseSec % 3600) / 60);
      l.push(` lease ${dd}${hh || mm ? ` ${hh}` : ''}${mm ? ` ${mm}` : ''}`);
    }
    l.push('!');
  }
  if (!st.dhcpService) l.push('no service dhcp');
  if (!d.domainLookup) l.push('no ip domain-lookup');
  if (d.domainName) l.push(`ip domain-name ${d.domainName}`);
  for (const ns of d.nameServers) l.push(`ip name-server ${formatIPv4(ns)}`);
  if (st.routing && d.bridge) l.push('ip routing');
  if (!st.routing && !d.bridge) l.push('no ip routing');
  if (st.routing6) l.push('ipv6 unicast-routing');
  l.push('!');
  if (!d.cdpRun) l.push('no cdp run', '!');
  const b = d.bridge;
  if (b) {
    l.push(`spanning-tree mode ${b.stpMode}`);
    if (b.portfastDefault) l.push('spanning-tree portfast default');
    if (b.bpduguardDefault) l.push('spanning-tree portfast bpduguard default');
    if (!b.stpEnabled) l.push('no spanning-tree vlan 1');
    if (b.priority !== 32768) l.push(`spanning-tree vlan 1 priority ${b.priority}`);
    l.push('spanning-tree extend system-id', '!');
    if (b.agingTime !== 300) l.push(`mac address-table aging-time ${b.agingTime}`);
    for (const e of b.macTable.values()) if (e.static && e.port) l.push(`mac address-table static ${macToCisco(e.mac)} vlan ${e.vlan} interface ${e.port.port.name}`);
    for (const v of [...b.vlans.values()].sort((x, y) => x.id - y.id)) {
      if (v.id === 1 || v.id >= 1002) continue;
      l.push(`vlan ${v.id}`);
      if (v.name !== `VLAN${String(v.id).padStart(4, '0')}`) l.push(` name ${v.name}`);
      l.push('!');
    }
  }
  for (const i of d.sortedIfs()) l.push(...ifBlock(d, i));
  if (!st.routing && st.defaultGateway !== undefined) l.push(`ip default-gateway ${formatIPv4(st.defaultGateway)}`);
  l.push('ip forward-protocol nd', '!');
  for (const p of st.natPools.values()) l.push(`ip nat pool ${p.name} ${formatIPv4(p.start)} ${formatIPv4(p.end)} netmask ${mask(p.prefix)}`);
  for (const r of st.natDynamics) l.push(`ip nat inside source list ${r.acl} ${r.iface ? `interface ${r.iface}` : `pool ${r.pool}`}${r.overload ? ' overload' : ''}`);
  for (const s of st.natStatics) {
    if (s.proto) l.push(`ip nat inside source static ${s.proto} ${formatIPv4(s.local)} ${s.localPort} ${formatIPv4(s.global)} ${s.globalPort}`);
    else l.push(`ip nat inside source static ${formatIPv4(s.local)} ${formatIPv4(s.global)}`);
  }
  for (const r of st.statics4) {
    const parts = [`ip route ${formatIPv4(r.net)} ${mask(r.prefix)}`];
    if (r.iface) parts.push(r.iface);
    if (r.nextHop !== undefined) parts.push(formatIPv4(r.nextHop));
    if (r.ad !== 1) parts.push(String(r.ad));
    if (r.permanent) parts.push('permanent');
    l.push(parts.join(' '));
  }
  l.push('!');
  // Access lists: numbered as "access-list", named as "ip access-list".
  const acls = [...st.acls.values()];
  for (const a of acls.filter((x) => !x.numbered)) {
    l.push(`ip access-list ${a.type} ${a.name}`);
    for (const r of a.remarks) l.push(` remark ${r.text}`);
    for (const e of a.entries) l.push(` ${entryText(e, a.type === 'standard')}`);
  }
  for (const a of acls.filter((x) => x.numbered)) {
    for (const r of a.remarks) l.push(`access-list ${a.name} remark ${r.text}`);
    for (const e of a.entries) l.push(`access-list ${a.name} ${entryText(e, a.type === 'standard')}`);
  }
  if (acls.length) l.push('!');
  for (const r of st.statics6) {
    const parts = [`ipv6 route ${formatIPv6(r.net, true)}/${r.prefix}`];
    if (r.iface) parts.push(r.iface);
    if (r.nextHop !== undefined) parts.push(formatIPv6(r.nextHop, true));
    if (r.ad !== 1) parts.push(String(r.ad));
    l.push(parts.join(' '));
  }
  if (st.statics6.length) l.push('!');
  if (d.motd !== undefined) l.push(`banner motd ^C${d.motd}^C`, '!');
  l.push(...lineBlock(d, 'line con 0', d.lineCon));
  if (!d.bridge) l.push('line aux 0');
  for (const v of d.lineVty) l.push(...lineBlock(d, `line vty ${v.first} ${v.last}`, v));
  l.push('!', 'end');
  return l.join('\n') + '\n';
}
