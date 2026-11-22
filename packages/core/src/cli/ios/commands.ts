/**
 * Cisco IOS command set. Each command declares its syntax (see grammar.ts) and a handler
 * that changes the device state or prints output in the same format as real equipment.
 */
import { Grammar, parseVlanList, type Args } from '../grammar';
import type { IosSession } from './session';
import type { IosDevice, IosIf } from '../../devices/ios';
import { formatIPv4, maskToPrefix, networkOf, parseIPv4, classfulPrefix, type IPv4 } from '../../net/ipv4';
import { eui64, formatIPv6, isLinkLocal6, network6, parseIPv6, parsePrefix6 } from '../../net/ipv6';
import { normalizeMac } from '../../net/mac';
import { ANY, ICMP_TYPE_NAMES, PORT_NAMES, type Acl, type AclEntry, type AddrMatch, type PortMatch } from '../../l3/acl';
import type { EchoResult } from '../../l3/stack';
import * as show from './show';
import { buildRunningConfig, interfaceConfig } from './runconfig';
import { type5Hash, type7Decrypt } from './passwords';

type S = IosSession;

const KW: Record<string, string> = {
  access: 'Set access mode characteristics of the interface',
  'access-group': 'Specify access control for packets',
  'access-list': 'Add an access list entry',
  'access-lists': 'List access lists',
  address: 'Set the IP address of an interface',
  allowed: 'Set allowed VLAN characteristics when interface is in trunking mode',
  arp: 'ARP table',
  banner: 'Define a login banner',
  binding: 'DHCP address bindings',
  brief: 'Brief summary',
  cdp: 'CDP information',
  clear: 'Reset functions',
  clock: 'Display the system clock',
  configure: 'Enter configuration mode',
  copy: 'Copy from one file to another',
  'default-gateway': 'Specify default gateway (if not routing IP)',
  'default-router': 'Default routers',
  description: 'Interface specific description',
  detail: 'Show detailed information',
  dhcp: 'Configure DHCP server and relay parameters',
  disable: 'Turn off privileged commands',
  'dns-server': 'DNS servers',
  'domain-lookup': 'Enable IP Domain Name System hostname translation',
  'domain-name': 'Define the default domain name',
  do: 'To run exec commands in config mode',
  duplex: 'Configure duplex operation.',
  enable: 'Turn on privileged commands',
  encapsulation: 'Set encapsulation type for an interface',
  end: 'Exit from configure mode',
  erase: 'Erase a filesystem',
  'excluded-address': 'Prevent DHCP from assigning certain addresses',
  exit: 'Exit from the EXEC',
  'exec-timeout': 'Set the EXEC timeout',
  'helper-address': 'Specify a destination address for UDP broadcasts',
  history: 'Display the session command history',
  hostname: 'Set system\'s network name',
  interface: 'Select an interface to configure',
  interfaces: 'Interface status and configuration',
  ip: 'Global IP configuration subcommands',
  ipv6: 'IPv6 configuration commands',
  lease: 'Address lease time',
  line: 'Configure a terminal line',
  'logging': 'Modify message logging facilities',
  login: 'Enable password checking',
  logout: 'Exit from the EXEC',
  'mac': 'MAC configuration',
  'mac-address-table': 'MAC forwarding table',
  'address-table': 'MAC forwarding table',
  mode: 'Set trunking mode of the interface',
  name: 'Ascii name of the VLAN',
  nat: 'NAT configuration commands',
  native: 'Set native VLAN',
  neighbors: 'CDP neighbor entries',
  network: 'Network number and mask',
  no: 'Negate a command or set its defaults',
  password: 'Assign the terminal connection password',
  ping: 'Send echo messages',
  pool: 'Configure DHCP address pools',
  portfast: 'Spanning tree portfast options',
  range: 'interface range command',
  reload: 'Halt and perform a cold restart',
  route: 'Establish static routes',
  routing: 'Enable IP routing',
  'running-config': 'Current operating configuration',
  secret: 'Assign the privileged level secret',
  service: 'Modify use of network based services',
  show: 'Show running system information',
  shutdown: 'Shutdown the selected interface',
  'spanning-tree': 'Spanning Tree Subsystem',
  speed: 'Configure speed operation.',
  'startup-config': 'Contents of startup configuration',
  status: 'Show interface line status',
  switchport: 'Set switching mode characteristics',
  terminal: 'Set terminal line parameters',
  traceroute: 'Trace route to destination',
  translations: 'Translation entries',
  trunk: 'Set trunking characteristics of the interface',
  'unicast-routing': 'Enable unicast routing',
  username: 'Establish User Name Authentication',
  version: 'System hardware and software status',
  vlan: 'Vlan commands',
  write: 'Write running configuration to memory, network, or terminal',
};

// ===================================================================== helpers

const dev = (s: S) => s.dev;

function ifs(s: S): IosIf[] {
  return s.ifCtx;
}

function prefixOf(maskText: string): number | null {
  const m = parseIPv4(maskText);
  return m === null ? null : maskToPrefix(m);
}

function badMask(s: S, a: Args, maskText: string) {
  const pos = a.raw.indexOf(maskText);
  s.println(' '.repeat(s.prompt().length + Math.max(0, pos)) + '^');
  s.println("% Invalid input detected at '^' marker.\n");
}

/** Overlap check used by "ip address" (IOS refuses overlapping subnets). */
function overlapping(d: IosDevice, self: IosIf, addr: IPv4, prefix: number): IosIf | undefined {
  for (const i of d.l3Ifs()) {
    if (i === self) continue;
    for (const a of i.v4) {
      const p = Math.min(prefix, a.prefix);
      if (networkOf(addr, p) === networkOf(a.addr, p)) return i;
    }
  }
  return undefined;
}

function requireL3(s: S, i: IosIf): boolean {
  if (dev(s).isSwitchport(i)) {
    // IOS does not accept IP addresses on layer 2 ports.
    s.println(`% IP addresses may not be configured on L2 links.`);
    return false;
  }
  return true;
}

function parseIfRange(d: IosDevice, text: string): IosIf[] | null {
  const out: IosIf[] = [];
  for (const part of text.split(',')) {
    const m = /^\s*([a-zA-Z-]+)\s*(\d+(?:\/\d+)*\/)?(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) return null;
    const [, type, prefix = '', from, to] = m;
    const last = to !== undefined ? Number(to) : Number(from);
    if (last < Number(from)) return null;
    for (let n = Number(from); n <= last; n++) {
      const name = d.resolveIfName(`${type}${prefix}${n}`);
      if (!name) return null;
      const i = d.getOrCreateIf(name);
      if (!i) return null;
      out.push(i);
    }
  }
  return out.length ? out : null;
}

/** Physical ports in switchport mode, otherwise prints the IOS error. */
function switchports(s: S): IosIf[] | null {
  const d = dev(s);
  if (!d.bridge) return null;
  const list = ifs(s).filter((i) => i.kind === 'physical');
  for (const i of list) {
    const bp = d.bp(i);
    if (bp?.routed) {
      s.println('% Command rejected: Interface not configured as switchport.');
      return null;
    }
  }
  return list;
}

function afterSwitchportChange(s: S, list: IosIf[]) {
  const d = dev(s);
  for (const i of list) {
    const bp = d.bp(i)!;
    d.bridge!.refreshTrunk(bp);
    d.bridge!.flushPort(bp);
  }
  d.syncState();
}

// --------------------------------------------------------------------- ACL parsing

function parseAddrSpec(toks: string[], i: number): { m: AddrMatch; next: number } | null {
  const t = toks[i]?.toLowerCase();
  if (t === undefined) return null;
  if (t === 'any') return { m: ANY, next: i + 1 };
  if (t === 'host') {
    const ip = parseIPv4(toks[i + 1] ?? '');
    return ip === null ? null : { m: { addr: ip, wildcard: 0 }, next: i + 2 };
  }
  const ip = parseIPv4(toks[i]);
  if (ip === null) return null;
  const w = parseIPv4(toks[i + 1] ?? '');
  if (w === null) return { m: { addr: ip, wildcard: 0 }, next: i + 1 };
  return { m: { addr: (ip & ~w) >>> 0, wildcard: w }, next: i + 2 };
}

function portNum(t: string | undefined): number | null {
  if (t === undefined) return null;
  if (/^\d+$/.test(t) && Number(t) <= 65535) return Number(t);
  return PORT_NAMES[t.toLowerCase()] ?? null;
}

function parsePortSpec(toks: string[], i: number): { m?: PortMatch; next: number } | null {
  const op = toks[i]?.toLowerCase();
  if (op === 'eq' || op === 'neq' || op === 'lt' || op === 'gt') {
    const p = portNum(toks[i + 1]);
    return p === null ? null : { m: { op, ports: [p] }, next: i + 2 };
  }
  if (op === 'range') {
    const a = portNum(toks[i + 1]);
    const b = portNum(toks[i + 2]);
    return a === null || b === null ? null : { m: { op: 'range', ports: [a, b] }, next: i + 3 };
  }
  return { next: i };
}

/** Parses "<proto> <src> [ports] <dst> [ports] [icmp-type] [established] [log]". Returns entry or failing token index. */
function parseExtended(action: 'permit' | 'deny', toks: string[]): AclEntry | number {
  const proto = toks[0]?.toLowerCase();
  if (!['ip', 'icmp', 'tcp', 'udp'].includes(proto)) return 0;
  const src = parseAddrSpec(toks, 1);
  if (!src) return 1;
  let i = src.next;
  let srcPort: PortMatch | undefined;
  if (proto === 'tcp' || proto === 'udp') {
    const sp = parsePortSpec(toks, i);
    if (!sp) return i;
    srcPort = sp.m;
    i = sp.next;
  }
  const dst = parseAddrSpec(toks, i);
  if (!dst) return i;
  i = dst.next;
  const e: AclEntry = { seq: 0, action, proto: proto as AclEntry['proto'], src: src.m, srcPort, dst: dst.m, matches: 0 };
  if (proto === 'tcp' || proto === 'udp') {
    const dp = parsePortSpec(toks, i);
    if (!dp) return i;
    e.dstPort = dp.m;
    i = dp.next;
  }
  while (i < toks.length) {
    const t = toks[i].toLowerCase();
    if (t === 'log') e.log = true;
    else if (t === 'established' && proto === 'tcp') e.established = true;
    else if (proto === 'icmp' && (ICMP_TYPE_NAMES[t] !== undefined || /^\d+$/.test(t))) e.icmpType = ICMP_TYPE_NAMES[t] ?? Number(t);
    else return i;
    i++;
  }
  return e;
}

function parseStandard(action: 'permit' | 'deny', toks: string[]): AclEntry | number {
  const src = parseAddrSpec(toks, 0);
  if (!src) return 0;
  const e: AclEntry = { seq: 0, action, proto: 'ip', src: src.m, matches: 0 };
  let i = src.next;
  if (toks[i]?.toLowerCase() === 'log') {
    e.log = true;
    i++;
  }
  if (i < toks.length) return i;
  return e;
}

function getAcl(d: IosDevice, name: string, type: 'standard' | 'extended', numbered: boolean): Acl {
  let a = d.stack.acls.get(name);
  if (!a) {
    a = { name, type, numbered, entries: [], remarks: [] };
    d.stack.acls.set(name, a);
  }
  return a;
}

function addAclEntry(acl: Acl, e: AclEntry, seq?: number) {
  e.seq = seq ?? (acl.entries.length ? acl.entries[acl.entries.length - 1].seq + 10 : 10);
  acl.entries = acl.entries.filter((x) => x.seq !== e.seq);
  acl.entries.push(e);
  acl.entries.sort((a, b) => a.seq - b.seq);
}

function aclError(s: S, a: Args, toks: string[], idx: number, offsetTok: string) {
  const start = a.raw.indexOf(offsetTok);
  let pos = start;
  // Find the char position of token idx inside the LINE parameter.
  const re = /\S+/g;
  const rest = a.raw.slice(start);
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(rest))) {
    if (n === idx) {
      pos = start + m.index;
      break;
    }
    n++;
    pos = start + rest.length;
  }
  void toks;
  s.println(' '.repeat(s.prompt().length + pos) + '^');
  s.println("% Invalid input detected at '^' marker.\n");
}

// --------------------------------------------------------------------- ping / traceroute

function resultChar(r: EchoResult): string {
  switch (r.type) {
    case 'reply':
      return '!';
    case 'timeout':
      return '.';
    case 'unreachable':
      return r.code === 13 ? 'A' : 'U';
    case 'ttl-exceeded':
      return '&';
    case 'port-unreachable':
      return 'U';
    case 'local-error':
      return '.';
  }
}

function runPing(s: S, target: string, opts: { count: number; size: number; timeout: number; source?: string }) {
  const d = dev(s);
  const v4 = parseIPv4(target);
  const v6 = v4 === null ? parseIPv6(target) : null;
  if (v4 === null && v6 === null) {
    s.println(`Translating "${target}"${d.domainLookup ? '...domain server (255.255.255.255)' : ''}`);
    s.println(`% Unrecognized host or address, or protocol not running.\n`);
    return;
  }
  let src4: IPv4 | undefined;
  if (opts.source) {
    const sIf = d.findIf(opts.source);
    src4 = sIf?.v4[0]?.addr ?? parseIPv4(opts.source) ?? undefined;
    if (src4 === undefined) {
      s.println(`% Invalid source address- IP address not on any of our up interfaces`);
      return;
    }
  }
  const label = v4 !== null ? formatIPv4(v4) : formatIPv6(v6!, true);
  s.println('Type escape sequence to abort.');
  s.println(`Sending ${opts.count}, ${opts.size}-byte ICMP Echos to ${label}, timeout is ${opts.timeout} seconds:`);
  if (src4 !== undefined) s.println(`Packet sent with a source address of ${formatIPv4(src4)} `);
  let aborted = false;
  let ok = 0;
  const rtts: number[] = [];
  s.async(() => {
    aborted = true;
  });
  const finish = (sent: number) => {
    s.println('');
    const pct = sent ? Math.floor((ok * 100) / sent) : 0;
    let line = `Success rate is ${pct} percent (${ok}/${sent})`;
    if (ok) {
      const min = Math.min(...rtts);
      const max = Math.max(...rtts);
      const avg = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
      line += `, round-trip min/avg/max = ${min}/${avg}/${max} ms`;
    }
    s.println(line);
    s.done();
  };
  const send = (seq: number) => {
    if (aborted) return finish(seq);
    if (seq >= opts.count) return finish(seq);
    const cb = (r: EchoResult) => {
      if (r.type === 'reply') {
        ok++;
        rtts.push(Math.max(1, Math.round(r.rtt)));
      }
      s.out(resultChar(r));
      if (r.type === 'local-error' && r.reason === 'no-route') {
        // No route: IOS prints "." after the timeout as well.
        d.timer(opts.timeout * 1000, () => send(seq + 1));
        return;
      }
      d.timer(r.type === 'reply' ? 1 : 0, () => send(seq + 1));
    };
    if (v4 !== null) d.stack.echo4(v4, { seq, size: opts.size - 28, src: src4, timeout: opts.timeout * 1000, ttl: 255 }, cb);
    else d.stack.echo6(v6!, { seq, size: opts.size - 48, timeout: opts.timeout * 1000 }, cb);
  };
  send(0);
}

function runTraceroute(s: S, target: string) {
  const d = dev(s);
  const v4 = parseIPv4(target);
  const v6 = v4 === null ? parseIPv6(target) : null;
  if (v4 === null && v6 === null) {
    s.println(`% Unrecognized host or address, or protocol not running.\n`);
    return;
  }
  const label = v4 !== null ? formatIPv4(v4) : formatIPv6(v6!, true);
  s.println('Type escape sequence to abort.');
  s.println(`Tracing the route to ${label}`);
  s.println('VRF info: (vrf in name/id, vrf out name/id)');
  let aborted = false;
  s.async(() => {
    aborted = true;
  });
  const maxTtl = 30;
  const hop = (ttl: number) => {
    if (aborted || ttl > maxTtl) {
      s.done();
      return;
    }
    s.out(`${String(ttl).padStart(2)} `);
    let probe = 0;
    let printedFrom: string | null = null;
    let reached = false;
    const one = () => {
      if (aborted) {
        s.println('');
        s.done();
        return;
      }
      if (probe >= 3) {
        s.println('');
        if (reached) s.done();
        else hop(ttl + 1);
        return;
      }
      probe++;
      const cb = (r: EchoResult) => {
        if (r.type === 'timeout' || r.type === 'local-error') s.out('* ');
        else {
          const from = typeof r.from === 'bigint' ? formatIPv6(r.from, true) : formatIPv4(r.from as number);
          if (printedFrom !== from) {
            s.out(`${from} `);
            printedFrom = from;
          }
          const rtt = 'rtt' in r ? Math.max(1, Math.round(r.rtt)) : 0;
          s.out(`${rtt} msec ${r.type === 'unreachable' ? '!H ' : ''}`);
          if (r.type === 'port-unreachable' || r.type === 'unreachable') reached = true;
        }
        d.timer(0, one);
      };
      if (v4 !== null) d.stack.probe4(v4, ttl, 3000, cb);
      else d.stack.probe6(v6!, ttl, 3000, cb);
    };
    one();
  };
  hop(1);
}

/** Interactive "extended ping" (ping without arguments). */
function extendedPing(s: S) {
  const ask = (q: string, def: string, cb: (v: string) => void) => s.ask(q, (ans) => cb(ans.trim() || def));
  ask('Protocol [ip]: ', 'ip', (proto) => {
    if (!['ip', 'ipv6'].includes(proto)) {
      s.println(`% Unknown protocol - "${proto}", type "ping ?" for help`);
      return;
    }
    s.ask('Target IP address: ', (target) => {
      if (!target.trim()) {
        s.println('% Bad IP address');
        return;
      }
      ask('Repeat count [5]: ', '5', (rep) => {
        ask('Datagram size [100]: ', '100', (size) => {
          ask('Timeout in seconds [2]: ', '2', (tmo) => {
            ask('Extended commands [n]: ', 'n', (ext) => {
              const go = (source?: string) =>
                ask('Sweep range of sizes [n]: ', 'n', () => runPing(s, target.trim(), { count: Number(rep) || 5, size: Number(size) || 100, timeout: Number(tmo) || 2, source }));
              if (ext.toLowerCase().startsWith('y')) ask('Source address or interface: ', '', (src) => go(src ? s.dev.resolveIfName(src) ?? src : undefined));
              else go();
            });
          });
        });
      });
    });
  });
}

// ===================================================================== grammar

let cached: Grammar<S> | null = null;

export function iosGrammar(): Grammar<S> {
  if (cached) return cached;
  const g = new Grammar<S>(KW);
  const EXEC = ['user', 'priv'];
  const CFG_ALL = ['config', 'if', 'subif', 'ifrange', 'vlan', 'line', 'dhcp', 'stdacl', 'extacl'];
  const IFM = ['if', 'subif', 'ifrange'];

  // ------------------------------------------------------------------- EXEC
  g.add(EXEC, 'enable', (s) => s.enable());
  g.add('priv', 'disable', (s) => {
    s.mode = 'user';
  });
  for (const w of ['exit', 'logout', 'quit'])
    g.add(EXEC, w, (s) => {
      s.mode = 'user';
      s.println('');
      s.start();
    });
  g.add(EXEC, 'ping <word:target>', (s, a) => runPing(s, a.p.target, { count: 5, size: 100, timeout: 2 }), { target: 'Ping destination address or hostname' });
  g.add(EXEC, 'ping ipv6 <ipv6:target>', (s, a) => runPing(s, a.p.target, { count: 5, size: 100, timeout: 2 }), { ipv6: 'IPv6 echo', target: 'IPv6 address' });
  g.add(EXEC, 'ping ip <ipv4:target>', (s, a) => runPing(s, a.p.target, { count: 5, size: 100, timeout: 2 }), { ip: 'IP echo' });
  g.add(EXEC, 'ping <word:target> repeat <int:count:1-2147483647>', (s, a) => runPing(s, a.p.target, { count: Number(a.p.count), size: 100, timeout: 2 }), { repeat: 'specify repeat count' });
  g.add(EXEC, 'ping <word:target> size <int:size:36-18024>', (s, a) => runPing(s, a.p.target, { count: 5, size: Number(a.p.size), timeout: 2 }), { size: 'specify datagram size' });
  g.add(EXEC, 'ping <word:target> repeat <int:count:1-2147483647> size <int:size:36-18024>', (s, a) => runPing(s, a.p.target, { count: Number(a.p.count), size: Number(a.p.size), timeout: 2 }));
  g.add(EXEC, 'ping <word:target> source <iface:src>', (s, a) => runPing(s, a.p.target, { count: 5, size: 100, timeout: 2, source: a.p.src }), { source: 'specify source address or name' });
  g.add(EXEC, 'ping <word:target> source <ipv4:srcip>', (s, a) => runPing(s, a.p.target, { count: 5, size: 100, timeout: 2, source: a.p.srcip }));
  g.add(EXEC, 'ping <word:target> timeout <int:t:0-3600>', (s, a) => runPing(s, a.p.target, { count: 5, size: 100, timeout: Number(a.p.t) }), { timeout: 'specify timeout interval' });
  g.add('priv', 'ping', (s) => extendedPing(s));
  g.add(EXEC, 'traceroute <word:target>', (s, a) => runTraceroute(s, a.p.target), { target: 'Trace route to destination address or hostname' });
  g.add(EXEC, 'traceroute ipv6 <ipv6:target>', (s, a) => runTraceroute(s, a.p.target));
  g.add(EXEC, 'terminal length <int:n:0-512>', () => {}, { length: 'Set number of lines on a screen' });
  g.add(EXEC, 'terminal monitor', () => {}, { monitor: 'Copy debug output to the current terminal line' });
  g.add(EXEC, 'terminal no monitor', () => {});

  g.add('priv', 'configure terminal', (s) => {
    s.println('Enter configuration commands, one per line.  End with CNTL/Z.');
    s.mode = 'config';
  }, { terminal: 'Configure from the terminal' });
  g.add('priv', 'configure', (s) =>
    s.ask('Configuring from terminal, memory, or network [terminal]? ', (ans) => {
      if (!ans.trim() || 'terminal'.startsWith(ans.trim().toLowerCase())) {
        s.println('Enter configuration commands, one per line.  End with CNTL/Z.');
        s.mode = 'config';
      } else s.println('?Must be "terminal", "memory" or "network"');
    }),
  );

  const save = (s: S) => {
    s.println('Building configuration...');
    s.dev.startup = buildRunningConfig(s.dev);
    s.dev.dirty = false;
    s.println('[OK]');
  };
  g.add('priv', 'copy running-config startup-config', (s) =>
    s.ask('Destination filename [startup-config]? ', () => save(s)),
    { 'running-config': 'Copy from current system configuration', 'startup-config': 'Copy to startup configuration' },
  );
  g.add('priv', 'copy startup-config running-config', (s) =>
    s.ask('Destination filename [running-config]? ', () => {
      const d = s.dev;
      if (!d.startup) {
        s.println('%Error opening nvram:/startup-config (No such file or directory)');
        return;
      }
      d.loadConfig(d.startup, false);
      s.println(`${d.startup.length} bytes copied in 0.200 secs`);
    }),
  );
  g.add('priv', 'write', (s) => save(s));
  g.add('priv', 'write memory', (s) => save(s), { memory: 'Write to NV memory' });
  const erase = (s: S) =>
    s.ask('Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]', (ans) => {
      if (ans.trim().toLowerCase().startsWith('n')) return;
      s.dev.startup = null;
      s.println('[OK]');
      s.println('Erase of nvram: complete');
      s.dev.timer(100, () => s.dev.log('%SYS-7-NV_BLOCK_INIT: Initialized the geometry of nvram'));
    });
  g.add('priv', 'erase startup-config', erase);
  g.add('priv', 'erase nvram:', erase);
  g.add('priv', 'write erase', erase, { erase: 'Erase NV memory' });
  g.add('priv', 'reload', (s) => {
    const d = s.dev;
    const running = buildRunningConfig(d);
    const proceed = () =>
      s.ask('Proceed with reload? [confirm]', (ans) => {
        if (ans.trim().toLowerCase().startsWith('n')) return;
        s.println('');
        s.dev.log('%SYS-5-RELOAD: Reload requested by console. Reload Reason: Reload Command.');
        s.async();
        d.reload();
      });
    void running;
    if (d.dirty) {
      s.ask('\nSystem configuration has been modified. Save? [yes/no]: ', (ans) => {
        if (ans.trim().toLowerCase().startsWith('y')) save(s);
        else if (!ans.trim().toLowerCase().startsWith('n')) {
          s.println("% Please answer 'yes' or 'no'.");
          return;
        }
        proceed();
      });
    } else proceed();
  });

  g.add('priv', 'clear arp-cache', (s) => s.dev.stack.clearArp(), { 'arp-cache': 'Clear the entire ARP cache' });
  g.add('priv', 'clear mac address-table dynamic', (s) => s.dev.bridge?.flushAll(), { dynamic: 'dynamic entry type' });
  g.add('priv', 'clear mac-address-table dynamic', (s) => s.dev.bridge?.flushAll());
  g.add('priv', 'clear ip nat translation *', (s) => s.dev.stack.clearNat(), { translation: 'Clear dynamic translation', '*': 'Delete all dynamic translations' });
  g.add('priv', 'clear ip dhcp binding *', (s) => s.dev.stack.dhcpBindings.clear());
  g.add('priv', 'clear counters', (s) =>
    s.ask('Clear "show interface" counters on all interfaces [confirm]', () => {
      for (const p of s.dev.ports) {
        p.stats.rxFrames = 0;
        p.stats.txFrames = 0;
      }
    }),
  );
  g.add('priv', 'clear access-list counters', (s) => {
    for (const a of s.dev.stack.acls.values()) for (const e of a.entries) e.matches = 0;
  });

  // ------------------------------------------------------------------- SHOW
  const SHOW_MODES = ['user', 'priv'];
  const SHOW_HELP: Record<string, string> = {
    'access-lists': 'List access lists',
    arp: 'ARP table',
    brief: 'Brief summary of IP status and configuration',
    cdp: 'CDP information',
    clock: 'Display the system clock',
    dhcp: 'Show items in the DHCP database',
    binding: 'DHCP address bindings',
    pool: 'DHCP pools information',
    history: 'Display the session command history',
    interface: 'IP interface status and configuration',
    interfaces: 'Interface status and configuration',
    ip: 'IP information',
    ipv6: 'IPv6 information',
    mac: 'MAC configuration',
    'address-table': 'MAC forwarding table',
    nat: 'IP NAT information',
    neighbors: 'CDP neighbor entries',
    protocols: 'Active network routing protocols',
    route: 'IP routing table',
    'running-config': 'Current operating configuration',
    'spanning-tree': 'Spanning tree topology',
    'startup-config': 'Contents of startup configuration',
    translations: 'Translation entries',
    version: 'System hardware and software status',
    vlan: 'VTP VLAN status',
  };
  const sh = (syntax: string, fn: (s: S, a: Args) => string, helps?: Record<string, string>, modes: string[] = SHOW_MODES) =>
    g.add(modes, `show ${syntax}`, (s, a) => s.out(fn(s, a)), { ...SHOW_HELP, ...helps });

  sh('running-config', (s) => {
    const c = buildRunningConfig(s.dev);
    return `Building configuration...\n\nCurrent configuration : ${c.length} bytes\n${c}`;
  }, {}, ['priv']);
  sh('running-config interface <iface:if>', (s, a) => {
    const i = s.dev.findIf(a.p.if);
    if (!i) return '%Interface not found\n';
    const c = interfaceConfig(s.dev, i);
    return `Building configuration...\n\nCurrent configuration : ${c.length + 2} bytes\n!\n${c}\nend\n\n`;
  }, {}, ['priv']);
  sh('startup-config', (s) => (s.dev.startup ? `Using ${s.dev.startup.length} out of ${s.dev.bridge ? 65536 : 262136} bytes\n${s.dev.startup}` : 'startup-config is not present\n'), {}, ['priv']);
  sh('version', (s) => show.showVersion(s.dev));
  sh('clock', (s) => show.clockText(s.dev, s.dev.simulator.now) + '\n');
  sh('history', (s) => s.history.map((h) => `  ${h}`).join('\n') + '\n');
  sh('ip interface brief', (s) => show.showIpIntBrief(s.dev));
  sh('ipv6 interface brief', (s) => show.showIpv6IntBrief(s.dev));
  sh('interfaces', (s) => show.showInterfaces(s.dev));
  sh('interfaces <iface:if>', (s, a) => {
    const i = s.dev.findIf(a.p.if);
    return i ? show.showInterfaces(s.dev, i) : '';
  });
  sh('ip route', (s) => show.showIpRoute(s.dev));
  sh('ip route connected', (s) => show.showIpRoute(s.dev, 'connected'), { connected: 'Connected' });
  sh('ip route static', (s) => show.showIpRoute(s.dev, 'static'), { static: 'Static routes' });
  sh('ipv6 route', (s) => show.showIpv6Route(s.dev));
  sh('arp', (s) => show.showArp(s.dev));
  sh('ip arp', (s) => show.showArp(s.dev));
  sh('ipv6 neighbors', (s) => show.showIpv6Neighbors(s.dev));
  sh('ip nat translations', (s) => show.showNatTranslations(s.dev));
  sh('ip nat statistics', (s) => show.showNatStatistics(s.dev), { statistics: 'Translation statistics' });
  sh('access-lists', (s) => show.showAccessLists(s.dev));
  sh('access-lists <word:name>', (s, a) => show.showAccessLists(s.dev, a.p.name));
  sh('ip access-lists', (s) => show.showAccessLists(s.dev));
  sh('ip dhcp binding', (s) => show.showDhcpBinding(s.dev));
  sh('ip dhcp pool', (s) => show.showDhcpPool(s.dev));
  sh('cdp neighbors', (s) => show.showCdpNeighbors(s.dev, false));
  sh('cdp neighbors detail', (s) => show.showCdpNeighbors(s.dev, true));
  sh('cdp', (s) => (s.dev.cdpRun ? 'Global CDP information:\n\tSending CDP packets every 60 seconds\n\tSending a holdtime value of 180 seconds\n\tSending CDPv2 advertisements is  enabled\n' : '% CDP is not enabled\n'));
  sh('flash:', (s) => `Directory of flash:/\n\n    1  -rw-   ${s.dev.model.software?.flash ?? '0'}  <no date>  ${s.dev.model.software?.image.toLowerCase()}.bin\n`);
  sh('protocols', (s) => {
    const l = ['Global values:', `  Internet Protocol routing is ${s.dev.stack.routing ? 'enabled' : 'disabled'}`];
    for (const i of s.dev.sortedIfs()) {
      const st = i.isUp();
      l.push(`${i.name} is ${i.shutdown ? 'administratively down' : st ? 'up' : 'down'}, line protocol is ${st ? 'up' : 'down'}`);
      for (const a of i.v4) l.push(`  Internet address is ${formatIPv4(a.addr)}/${a.prefix}`);
    }
    return l.join('\n') + '\n';
  });
  // Switch-only show commands are registered for every IOS device; they report the
  // missing feature the same way IOS does on a router ("Invalid input").
  sh('vlan', (s) => (s.dev.bridge ? show.showVlanBrief(s.dev, true) : ''));
  sh('vlan brief', (s) => (s.dev.bridge ? show.showVlanBrief(s.dev) : ''));
  sh('interfaces trunk', (s) => (s.dev.bridge ? show.showInterfacesTrunk(s.dev) : ''), { trunk: 'Show interface trunk information' });
  sh('interfaces status', (s) => (s.dev.bridge ? show.showInterfacesStatus(s.dev) : ''));
  sh('interfaces <iface:if> switchport', (s, a) => {
    const i = s.dev.findIf(a.p.if);
    return i ? show.showSwitchport(s.dev, i) : '';
  }, { switchport: 'Show interface switchport information' });
  const macShow = (filter: Parameters<typeof show.showMacTable>[1]) => (s: S) => (s.dev.bridge ? show.showMacTable(s.dev, filter) : '');
  for (const kw of ['mac address-table', 'mac-address-table']) {
    sh(kw, macShow({}));
    sh(`${kw} dynamic`, macShow({ dynamic: true }));
    sh(`${kw} vlan <int:vlan:1-4094>`, (s, a) => macShow({ vlan: Number(a.p.vlan) })(s));
    sh(`${kw} interface <iface:if>`, (s, a) => macShow({ iface: a.p.if })(s));
    sh(`${kw} address <mac:mac>`, (s, a) => macShow({ address: normalizeMac(a.p.mac)! })(s));
  }
  sh('spanning-tree', (s) => (s.dev.bridge ? show.showSpanningTree(s.dev) : ''));
  sh('spanning-tree vlan <int:vlan:1-4094>', (s, a) => (s.dev.bridge ? show.showSpanningTree(s.dev, Number(a.p.vlan)) : ''));

  // ------------------------------------------------------------------- GLOBAL CONFIG
  g.add(CFG_ALL, 'end', (s) => s.endConfig());
  g.add(CFG_ALL, 'exit', (s) => s.exitMode());

  g.add('config', 'hostname <word:name>', (s, a) => {
    s.dev.hostname = a.p.name;
    s.dev.name = a.p.name;
    s.dev.stack.hostname = a.p.name;
    s.dev.simulator.emitState(s.dev.id);
  }, { name: "This system's network name" });
  g.add('config', 'no hostname', (s) => {
    s.dev.hostname = s.dev.model.defaultName;
    s.dev.name = s.dev.hostname;
  });

  g.add('config', 'enable secret <word:pw>', (s, a) => {
    s.dev.enableSecret = type5Hash(a.p.pw);
  }, { secret: 'Assign the privileged level secret (MAX of 25 characters)', pw: 'The UNENCRYPTED (cleartext) \'enable\' secret' });
  g.add('config', 'enable secret 0 <word:pw>', (s, a) => {
    s.dev.enableSecret = type5Hash(a.p.pw);
  });
  g.add('config', 'enable secret 5 <word:hash>', (s, a) => {
    s.dev.enableSecret = a.p.hash;
  });
  g.add('config', 'enable password <word:pw>', (s, a) => {
    s.dev.enablePassword = a.p.pw;
  }, { password: 'Assign the privileged level password (MAX of 25 characters)' });
  g.add('config', 'enable password 7 <word:enc>', (s, a) => {
    s.dev.enablePassword = type7Decrypt(a.p.enc) ?? a.p.enc;
  });
  g.add('config', 'no enable secret', (s) => {
    s.dev.enableSecret = undefined;
  });
  g.add('config', 'no enable password', (s) => {
    s.dev.enablePassword = undefined;
  });
  g.add('config', 'service password-encryption', (s) => {
    s.dev.passwordEncryption = true;
  }, { 'password-encryption': 'Encrypt system passwords' });
  g.add('config', 'no service password-encryption', (s) => {
    s.dev.passwordEncryption = false;
  });
  g.add('config', 'service dhcp', (s) => {
    s.dev.stack.dhcpService = true;
  });
  g.add('config', 'no service dhcp', (s) => {
    s.dev.stack.dhcpService = false;
  });
  g.add('config', 'banner motd <line:text>', (s, a) => s.startBanner(a.p.text, (t) => (s.dev.motd = t)), { motd: 'Set Message of the Day banner', text: 'c  banner-text c, where \'c\' is a delimiting character' });
  g.add('config', 'no banner motd', (s) => {
    s.dev.motd = undefined;
  });
  for (const kw of ['ip domain-lookup', 'ip domain lookup']) {
    g.add('config', kw, (s) => {
      s.dev.domainLookup = true;
    });
    g.add('config', `no ${kw}`, (s) => {
      s.dev.domainLookup = false;
    });
  }
  g.add('config', 'ip domain-name <word:name>', (s, a) => {
    s.dev.domainName = a.p.name;
  });
  g.add('config', 'ip domain name <word:name>', (s, a) => {
    s.dev.domainName = a.p.name;
  });
  g.add('config', 'no ip domain-name', (s) => {
    s.dev.domainName = undefined;
  });
  g.add('config', 'ip name-server <ipv4:ns>', (s, a) => {
    s.dev.nameServers.push(parseIPv4(a.p.ns)!);
  }, { 'name-server': 'Specify address of name server to use' });
  g.add('config', 'no ip name-server', (s) => {
    s.dev.nameServers = [];
  });
  const user = (s: S, name: string, priv: number, type: 'secret' | 'password', pw: string, hashed = false) =>
    s.dev.users.set(name, { privilege: priv, type, secret: type === 'secret' ? (hashed ? pw : type5Hash(pw)) : pw });
  g.add('config', 'username <word:name> secret <word:pw>', (s, a) => user(s, a.p.name, 1, 'secret', a.p.pw));
  g.add('config', 'username <word:name> secret 5 <word:pw>', (s, a) => user(s, a.p.name, 1, 'secret', a.p.pw, true));
  g.add('config', 'username <word:name> password <word:pw>', (s, a) => user(s, a.p.name, 1, 'password', a.p.pw));
  g.add('config', 'username <word:name> password 7 <word:pw>', (s, a) => user(s, a.p.name, 1, 'password', type7Decrypt(a.p.pw) ?? a.p.pw));
  g.add('config', 'username <word:name> privilege <int:lvl:0-15> secret <word:pw>', (s, a) => user(s, a.p.name, Number(a.p.lvl), 'secret', a.p.pw));
  g.add('config', 'username <word:name> privilege <int:lvl:0-15> secret 5 <word:pw>', (s, a) => user(s, a.p.name, Number(a.p.lvl), 'secret', a.p.pw, true));
  g.add('config', 'username <word:name> privilege <int:lvl:0-15> password <word:pw>', (s, a) => user(s, a.p.name, Number(a.p.lvl), 'password', a.p.pw));
  g.add('config', 'no username <word:name>', (s, a) => {
    s.dev.users.delete(a.p.name);
  });

  // Commands that appear in saved configurations and have no effect in the simulator.
  for (const noop of [
    '~version <line:v>',
    '~service timestamps <line:x>',
    '~no service timestamps <line:x>',
    '~no service pad',
    '~service pad',
    '~boot-start-marker',
    '~boot-end-marker',
    '~no aaa new-model',
    '~ip forward-protocol nd',
    '~ip cef',
    '~no ip cef',
    '~ipv6 cef',
    '~no ipv6 cef',
    '~license <line:x>',
    '~spanning-tree extend system-id',
    '~ip http server',
    '~no ip http server',
    '~no ip http secure-server',
    '~ip classless',
    '~memory-size iomem <int:n>',
    '~diagnostic bootup level minimal',
    '~vtp mode transparent',
    '~vtp mode <word:m>',
    '~redundancy',
    '~control-plane',
    '~line aux 0',
  ])
    g.add('config', noop, () => {});
  g.add('line', '~stopbits <int:n>', () => {});

  // interface / interface range
  g.add('config', 'interface <iface:if>', (s, a) => {
    const d = s.dev;
    const i = d.getOrCreateIf(a.p.if);
    if (!i) {
      s.println('% Invalid interface type and number');
      return;
    }
    s.ifCtx = [i];
    s.mode = i.kind === 'sub' ? 'subif' : 'if';
  }, { if: '' });
  g.add('config', 'interface range <line:list>', (s, a) => {
    const list = parseIfRange(s.dev, a.p.list);
    if (!list) {
      s.println('% Command rejected: invalid interface range');
      return;
    }
    s.ifCtx = list;
    s.mode = 'ifrange';
  }, { list: 'Interface range, e.g. FastEthernet0/1 - 12' });
  g.add('config', 'no interface <iface:if>', (s, a) => {
    const i = s.dev.findIf(a.p.if);
    if (!i) return;
    if (i.kind === 'physical') {
      s.println('% Removal of physical interfaces is not permitted');
      return;
    }
    s.dev.removeIf(i);
  });

  // VLANs
  g.add('config', 'vlan <vlanlist:list>', (s, a) => {
    const b = s.dev.bridge;
    if (!b) {
      s.println("% Invalid input detected at '^' marker.");
      return;
    }
    const ids = parseVlanList(a.p.list);
    for (const v of ids) {
      if (v >= 1002 && v <= 1005) {
        s.println(`% Default VLAN ${v} may not have its name changed.`);
        continue;
      }
      if (!b.vlans.has(v)) b.vlans.set(v, { id: v, name: `VLAN${String(v).padStart(4, '0')}` });
    }
    s.vlanCtx = ids;
    s.mode = 'vlan';
    s.dev.syncState();
  }, { list: 'ISL VLAN IDs 1-1005' });
  g.add('config', 'no vlan <vlanlist:list>', (s, a) => {
    const b = s.dev.bridge;
    if (!b) return;
    for (const v of parseVlanList(a.p.list)) {
      if (v === 1 || (v >= 1002 && v <= 1005)) {
        s.println(`%Default VLAN ${v} may not be deleted.`);
        continue;
      }
      b.vlans.delete(v);
      for (const [k, e] of b.macTable) if (e.vlan === v) b.macTable.delete(k);
    }
    s.dev.syncState();
  });
  g.add('vlan', 'name <word:name>', (s, a) => {
    for (const v of s.vlanCtx) {
      const info = s.dev.bridge!.vlans.get(v);
      if (info) info.name = a.p.name;
    }
  }, { name: 'The ascii name for the VLAN' });
  g.add('vlan', 'no name', (s) => {
    for (const v of s.vlanCtx) {
      const info = s.dev.bridge!.vlans.get(v);
      if (info) info.name = `VLAN${String(v).padStart(4, '0')}`;
    }
  });

  // Routing
  g.add('config', 'ip routing', (s) => {
    if (!s.dev.model.caps.routing) {
      s.println("% Invalid input detected at '^' marker.");
      return;
    }
    s.dev.stack.routing = true;
  });
  g.add('config', 'no ip routing', (s) => {
    s.dev.stack.routing = false;
  });
  g.add('config', 'ipv6 unicast-routing', (s) => {
    if (!s.dev.model.caps.routing) return;
    s.dev.stack.routing6 = true;
    for (const i of s.dev.l3Ifs()) s.dev.stack.sendRa(i);
  });
  g.add('config', 'no ipv6 unicast-routing', (s) => {
    s.dev.stack.routing6 = false;
  });
  g.add('config', 'ip default-gateway <ipv4:gw>', (s, a) => {
    s.dev.stack.defaultGateway = parseIPv4(a.p.gw)!;
  });
  g.add('config', 'no ip default-gateway', (s) => {
    s.dev.stack.defaultGateway = undefined;
  });

  const ipRoute = (s: S, a: Args) => {
    const net = parseIPv4(a.p.net)!;
    const prefix = prefixOf(a.p.mask);
    if (prefix === null) return badMask(s, a, a.p.mask);
    if (networkOf(net, prefix) !== net) {
      s.println('%Inconsistent address and mask');
      return;
    }
    const nh = a.p.nh !== undefined ? parseIPv4(a.p.nh)! : undefined;
    const ad = a.p.ad ? Number(a.p.ad) : 1;
    const st = s.dev.stack;
    const same = (r: { net: number; prefix: number; nextHop?: number; iface?: string }) => r.net === net && r.prefix === prefix && r.nextHop === nh && r.iface === a.p.if;
    if (a.no) {
      st.statics4 = st.statics4.filter((r) => !(r.net === net && r.prefix === prefix && (nh === undefined || r.nextHop === nh) && (!a.p.if || r.iface === a.p.if)));
      return;
    }
    if (nh !== undefined && s.dev.stack.ownsV4(nh)) {
      s.println('%Invalid next hop address (it\'s this router)');
      return;
    }
    st.statics4 = st.statics4.filter((r) => !same(r));
    st.statics4.push({ net, prefix, nextHop: nh, iface: a.p.if, ad, permanent: a.kw.has('permanent') });
  };
  const rh = { route: 'Establish static routes', net: 'Destination prefix', mask: 'Destination prefix mask', nh: 'Forwarding router\'s address', ad: 'Distance metric for this route', permanent: 'permanent route' };
  for (const pre of ['', 'no ']) {
    g.add('config', `${pre}ip route <ipv4:net> <ipv4:mask> <ipv4:nh>`, ipRoute, rh);
    g.add('config', `${pre}ip route <ipv4:net> <ipv4:mask> <ipv4:nh> <int:ad:1-255>`, ipRoute, rh);
    g.add('config', `${pre}ip route <ipv4:net> <ipv4:mask> <ipv4:nh> permanent`, ipRoute, rh);
    g.add('config', `${pre}ip route <ipv4:net> <ipv4:mask> <iface:if>`, ipRoute, rh);
    g.add('config', `${pre}ip route <ipv4:net> <ipv4:mask> <iface:if> <ipv4:nh>`, ipRoute, rh);
    g.add('config', `${pre}ip route <ipv4:net> <ipv4:mask> <iface:if> <int:ad:1-255>`, ipRoute, rh);
    g.add('config', `${pre}ip route <ipv4:net> <ipv4:mask> <iface:if> <ipv4:nh> <int:ad:1-255>`, ipRoute, rh);
  }
  g.add('config', 'no ip route <ipv4:net> <ipv4:mask>', ipRoute);

  const ipv6Route = (s: S, a: Args) => {
    const pf = parsePrefix6(a.p.pfx)!;
    const net = network6(pf.addr, pf.prefix);
    const nh = a.p.nh !== undefined ? parseIPv6(a.p.nh)! : undefined;
    const st = s.dev.stack;
    if (a.no) {
      st.statics6 = st.statics6.filter((r) => !(r.net === net && r.prefix === pf.prefix && (nh === undefined || r.nextHop === nh)));
      return;
    }
    if (nh !== undefined && isLinkLocal6(nh) && !a.p.if) {
      s.println('% Interface has to be specified for a link-local nexthop');
      return;
    }
    st.statics6.push({ net, prefix: pf.prefix, nextHop: nh, iface: a.p.if, ad: a.p.ad ? Number(a.p.ad) : 1 });
  };
  for (const pre of ['', 'no ']) {
    g.add('config', `${pre}ipv6 route <ipv6prefix:pfx> <ipv6:nh>`, ipv6Route, { pfx: 'IPv6 prefix', nh: 'IPv6 address of next-hop' });
    g.add('config', `${pre}ipv6 route <ipv6prefix:pfx> <ipv6:nh> <int:ad:1-254>`, ipv6Route);
    g.add('config', `${pre}ipv6 route <ipv6prefix:pfx> <iface:if>`, ipv6Route);
    g.add('config', `${pre}ipv6 route <ipv6prefix:pfx> <iface:if> <ipv6:nh>`, ipv6Route);
    g.add('config', `${pre}ipv6 route <ipv6prefix:pfx> <iface:if> <ipv6:nh> <int:ad:1-254>`, ipv6Route);
  }

  // Access lists (numbered).
  const numberedAcl = (s: S, a: Args, type: 'standard' | 'extended') => {
    const toks = a.p.rest.trim().split(/\s+/);
    const action = a.kw.has('permit') ? 'permit' : 'deny';
    const r = type === 'standard' ? parseStandard(action, toks) : parseExtended(action, toks);
    if (typeof r === 'number') return aclError(s, a, toks, r, a.p.rest.trim().split(/\s+/)[0]);
    addAclEntry(getAcl(s.dev, a.p.num, type, true), r);
  };
  for (const act of ['permit', 'deny']) {
    g.add('config', `access-list <int:num:1-99> ${act} <line:rest>`, (s, a) => numberedAcl(s, a, 'standard'), { num: 'IP standard access list', permit: 'Specify packets to forward', deny: 'Specify packets to reject', rest: 'Source: A.B.C.D [wildcard] | any | host A.B.C.D' });
    g.add('config', `access-list <int:num:1300-1999> ${act} <line:rest>`, (s, a) => numberedAcl(s, a, 'standard'), { num: 'IP standard access list (expanded range)' });
    g.add('config', `access-list <int:num:100-199> ${act} <line:rest>`, (s, a) => numberedAcl(s, a, 'extended'), { num: 'IP extended access list', rest: 'Protocol, source, destination, ports (e.g.: tcp any host 10.0.0.1 eq 80)' });
    g.add('config', `access-list <int:num:2000-2699> ${act} <line:rest>`, (s, a) => numberedAcl(s, a, 'extended'), { num: 'IP extended access list (expanded range)' });
  }
  g.add('config', 'access-list <int:num:1-2699> remark <line:text>', (s, a) => {
    const n = Number(a.p.num);
    const type = n < 100 || (n >= 1300 && n < 2000) ? 'standard' : 'extended';
    const acl = getAcl(s.dev, a.p.num, type, true);
    acl.remarks.push({ before: acl.entries.length, text: a.p.text });
  }, { remark: 'Access list entry comment' });
  g.add('config', 'no access-list <int:num:1-2699>', (s, a) => {
    s.dev.stack.acls.delete(a.p.num);
  });
  // Named access lists.
  const namedAcl = (type: 'standard' | 'extended') => (s: S, a: Args) => {
    const ex = s.dev.stack.acls.get(a.p.name);
    if (ex && ex.type !== type) {
      s.println(`% Access-list type conflicts with existing list ${a.p.name}`);
      return;
    }
    s.aclCtx = getAcl(s.dev, a.p.name, type, /^\d+$/.test(a.p.name));
    s.mode = type === 'standard' ? 'stdacl' : 'extacl';
  };
  g.add('config', 'ip access-list standard <word:name>', namedAcl('standard'), { standard: 'Standard Access List', name: 'Access-list name' });
  g.add('config', 'ip access-list extended <word:name>', namedAcl('extended'), { extended: 'Extended Access List' });
  g.add('config', 'no ip access-list standard <word:name>', (s, a) => {
    s.dev.stack.acls.delete(a.p.name);
  });
  g.add('config', 'no ip access-list extended <word:name>', (s, a) => {
    s.dev.stack.acls.delete(a.p.name);
  });
  for (const [mode, type] of [
    ['stdacl', 'standard'],
    ['extacl', 'extended'],
  ] as const) {
    for (const act of ['permit', 'deny'] as const) {
      const run = (s: S, a: Args) => {
        const toks = a.p.rest.trim().split(/\s+/);
        const r = type === 'standard' ? parseStandard(act, toks) : parseExtended(act, toks);
        if (typeof r === 'number') return aclError(s, a, toks, r, toks[0]);
        if (a.no) {
          const txt = JSON.stringify({ ...r, seq: 0, matches: 0 });
          s.aclCtx!.entries = s.aclCtx!.entries.filter((e) => JSON.stringify({ ...e, seq: 0, matches: 0 }) !== txt);
          return;
        }
        addAclEntry(s.aclCtx!, r, a.p.seq ? Number(a.p.seq) : undefined);
      };
      const hp = { rest: type === 'standard' ? 'Source: A.B.C.D [wildcard] | any | host A.B.C.D' : 'Protocol, source, destination, ports (e.g.: tcp any host 10.0.0.1 eq 80)', seq: 'Sequence Number' };
      g.add(mode, `${act} <line:rest>`, run, hp);
      g.add(mode, `<int:seq:1-2147483647> ${act} <line:rest>`, run, hp);
      g.add(mode, `no ${act} <line:rest>`, run, hp);
    }
    g.add(mode, 'no <int:seq:1-2147483647>', (s, a) => {
      s.aclCtx!.entries = s.aclCtx!.entries.filter((e) => e.seq !== Number(a.p.seq));
    });
    g.add(mode, 'remark <line:text>', (s, a) => {
      s.aclCtx!.remarks.push({ before: s.aclCtx!.entries.length, text: a.p.text });
    });
  }

  // NAT
  g.add('config', 'ip nat inside source static <ipv4:local> <ipv4:global>', (s, a) => {
    const st = s.dev.stack;
    const local = parseIPv4(a.p.local)!;
    const global = parseIPv4(a.p.global)!;
    if (a.no) {
      st.natStatics = st.natStatics.filter((x) => !(x.local === local && x.global === global && !x.proto));
      return;
    }
    if (st.natStatics.some((x) => x.local === local && !x.proto)) {
      s.println(`% ${a.p.local} already mapped (${a.p.local} -> ${formatIPv4(st.natStatics.find((x) => x.local === local)!.global)})`);
      return;
    }
    st.natStatics.push({ local, global });
  }, { nat: 'NAT configuration commands', inside: 'Inside address translation', source: 'Source address translation', static: 'Specify static local->global mapping', local: 'Inside local IP address', global: 'Inside global IP address' });
  g.add('config', 'no ip nat inside source static <ipv4:local> <ipv4:global>', (s, a) => {
    const local = parseIPv4(a.p.local)!;
    s.dev.stack.natStatics = s.dev.stack.natStatics.filter((x) => !(x.local === local && !x.proto));
  });
  for (const proto of ['tcp', 'udp'] as const) {
    g.add('config', `ip nat inside source static ${proto} <ipv4:local> <int:lport:1-65535> <ipv4:global> <int:gport:1-65535>`, (s, a) => {
      s.dev.stack.natStatics.push({ proto, local: parseIPv4(a.p.local)!, localPort: Number(a.p.lport), global: parseIPv4(a.p.global)!, globalPort: Number(a.p.gport) });
    });
    g.add('config', `no ip nat inside source static ${proto} <ipv4:local> <int:lport:1-65535> <ipv4:global> <int:gport:1-65535>`, (s, a) => {
      const local = parseIPv4(a.p.local)!;
      s.dev.stack.natStatics = s.dev.stack.natStatics.filter((x) => !(x.proto === proto && x.local === local && x.localPort === Number(a.p.lport)));
    });
  }
  const natList = (s: S, a: Args) => {
    const st = s.dev.stack;
    const rule = { acl: a.p.acl, pool: a.p.pool, iface: a.p.if, overload: a.kw.has('overload') };
    st.natDynamics = st.natDynamics.filter((r) => r.acl !== rule.acl);
    if (!a.no) st.natDynamics.push(rule);
  };
  for (const pre of ['', 'no ']) {
    g.add('config', `${pre}ip nat inside source list <word:acl> interface <iface:if> overload`, natList, { list: 'Specify access list describing local addresses', acl: 'Access list number or name for local addresses', overload: 'Overload an address translation' });
    g.add('config', `${pre}ip nat inside source list <word:acl> pool <word:pool>`, natList, { pool: 'Name pool of global addresses' });
    g.add('config', `${pre}ip nat inside source list <word:acl> pool <word:pool> overload`, natList);
  }
  g.add('config', 'ip nat pool <word:name> <ipv4:start> <ipv4:end> netmask <ipv4:mask>', (s, a) => {
    const prefix = prefixOf(a.p.mask);
    if (prefix === null) return badMask(s, a, a.p.mask);
    s.dev.stack.natPools.set(a.p.name, { name: a.p.name, start: parseIPv4(a.p.start)!, end: parseIPv4(a.p.end)!, prefix });
  }, { pool: 'Define pool of addresses', name: 'Pool name', start: 'Start IP address', end: 'End IP address', netmask: 'Specify the network mask' });
  g.add('config', 'ip nat pool <word:name> <ipv4:start> <ipv4:end> prefix-length <int:len:1-32>', (s, a) => {
    s.dev.stack.natPools.set(a.p.name, { name: a.p.name, start: parseIPv4(a.p.start)!, end: parseIPv4(a.p.end)!, prefix: Number(a.p.len) });
  });
  g.add('config', 'no ip nat pool <word:name>', (s, a) => {
    s.dev.stack.natPools.delete(a.p.name);
  });

  // DHCP server
  g.add('config', 'ip dhcp pool <word:name>', (s, a) => {
    const st = s.dev.stack;
    let p = st.dhcpPools.get(a.p.name);
    if (!p) st.dhcpPools.set(a.p.name, (p = { name: a.p.name, defaultRouter: [], dns: [], leaseSec: 86400 }));
    s.poolCtx = p;
    s.mode = 'dhcp';
  }, { pool: 'Configure DHCP address pools', name: 'Pool name' });
  g.add('config', 'no ip dhcp pool <word:name>', (s, a) => {
    s.dev.stack.dhcpPools.delete(a.p.name);
  });
  g.add('config', 'ip dhcp excluded-address <ipv4:lo>', (s, a) => {
    const lo = parseIPv4(a.p.lo)!;
    s.dev.stack.dhcpExcluded.push([lo, lo]);
  }, { lo: 'Low IP address' });
  g.add('config', 'ip dhcp excluded-address <ipv4:lo> <ipv4:hi>', (s, a) => {
    const lo = parseIPv4(a.p.lo)!;
    const hi = parseIPv4(a.p.hi)!;
    if (hi < lo) {
      s.println('% Invalid address range');
      return;
    }
    s.dev.stack.dhcpExcluded.push([lo, hi]);
  }, { hi: 'High IP address' });
  g.add('config', 'no ip dhcp excluded-address <ipv4:lo>', (s, a) => {
    const lo = parseIPv4(a.p.lo)!;
    s.dev.stack.dhcpExcluded = s.dev.stack.dhcpExcluded.filter(([x]) => x !== lo);
  });
  g.add('config', 'no ip dhcp excluded-address <ipv4:lo> <ipv4:hi>', (s, a) => {
    const lo = parseIPv4(a.p.lo)!;
    s.dev.stack.dhcpExcluded = s.dev.stack.dhcpExcluded.filter(([x]) => x !== lo);
  });
  g.add('dhcp', 'network <ipv4:net> <ipv4:mask>', (s, a) => {
    const prefix = prefixOf(a.p.mask);
    if (prefix === null) return badMask(s, a, a.p.mask);
    s.poolCtx!.network = networkOf(parseIPv4(a.p.net)!, prefix);
    s.poolCtx!.prefix = prefix;
  }, { net: 'Network number in dotted-decimal notation', mask: 'Network mask' });
  g.add('dhcp', 'network <ipv4:net>', (s, a) => {
    const net = parseIPv4(a.p.net)!;
    const prefix = classfulPrefix(net);
    s.poolCtx!.network = networkOf(net, prefix);
    s.poolCtx!.prefix = prefix;
  });
  g.add('dhcp', 'default-router <ipv4:r1>', (s, a) => {
    s.poolCtx!.defaultRouter = [parseIPv4(a.p.r1)!];
  }, { r1: 'Router\'s IP address' });
  g.add('dhcp', 'default-router <ipv4:r1> <ipv4:r2>', (s, a) => {
    s.poolCtx!.defaultRouter = [parseIPv4(a.p.r1)!, parseIPv4(a.p.r2)!];
  });
  g.add('dhcp', 'no default-router', (s) => {
    s.poolCtx!.defaultRouter = [];
  });
  g.add('dhcp', 'dns-server <ipv4:d1>', (s, a) => {
    s.poolCtx!.dns = [parseIPv4(a.p.d1)!];
  }, { d1: 'Server\'s IP address' });
  g.add('dhcp', 'dns-server <ipv4:d1> <ipv4:d2>', (s, a) => {
    s.poolCtx!.dns = [parseIPv4(a.p.d1)!, parseIPv4(a.p.d2)!];
  });
  g.add('dhcp', 'no dns-server', (s) => {
    s.poolCtx!.dns = [];
  });
  g.add('dhcp', 'domain-name <word:name>', (s, a) => {
    s.poolCtx!.domain = a.p.name;
  });
  g.add('dhcp', 'lease <int:d:0-365>', (s, a) => {
    s.poolCtx!.leaseSec = Number(a.p.d) * 86400;
  }, { d: 'Days' });
  g.add('dhcp', 'lease <int:d:0-365> <int:h:0-23>', (s, a) => {
    s.poolCtx!.leaseSec = Number(a.p.d) * 86400 + Number(a.p.h) * 3600;
  }, { h: 'Hours' });
  g.add('dhcp', 'lease <int:d:0-365> <int:h:0-23> <int:m:0-59>', (s, a) => {
    s.poolCtx!.leaseSec = Number(a.p.d) * 86400 + Number(a.p.h) * 3600 + Number(a.p.m) * 60;
  }, { m: 'Minutes' });
  g.add('dhcp', 'lease infinite', (s) => {
    s.poolCtx!.leaseSec = 0x7fffffff;
  });

  // Spanning tree, CDP, MAC table
  g.add('config', 'spanning-tree mode pvst', (s) => {
    if (s.dev.bridge) s.dev.bridge.stpMode = 'pvst';
  }, { mode: 'Spanning tree operating mode', pvst: 'Per-Vlan spanning tree mode' });
  g.add('config', 'spanning-tree mode rapid-pvst', (s) => {
    if (s.dev.bridge) s.dev.bridge.stpMode = 'rapid-pvst';
  }, { 'rapid-pvst': 'Per-Vlan rapid spanning tree mode' });
  g.add('config', 'spanning-tree vlan <vlanlist:list> priority <int:prio:0-61440>', (s, a) => {
    const p = Number(a.p.prio);
    if (p % 4096 !== 0) {
      s.println('% Bridge Priority must be in increments of 4096.\n% Allowed values are:\n  0     4096  8192  12288 16384 20480 24576 28672\n  32768 36864 40960 45056 49152 53248 57344 61440');
      return;
    }
    s.dev.bridge?.setPriority(p);
  }, { priority: 'Set the bridge priority for the spanning tree' });
  g.add('config', 'no spanning-tree vlan <vlanlist:list> priority', (s) => s.dev.bridge?.setPriority(32768));
  g.add('config', 'spanning-tree vlan <vlanlist:list> root primary', (s) => {
    const b = s.dev.bridge;
    if (!b) return;
    const best = b.isRoot() ? b.priority : Math.max(0, b.rootId.priority - 1 - 4096 * 2);
    b.setPriority(Math.min(24576, Math.floor(best / 4096) * 4096));
  }, { root: 'Configure switch as root', primary: 'Configure this switch as primary root for this spanning tree' });
  g.add('config', 'spanning-tree vlan <vlanlist:list> root secondary', (s) => s.dev.bridge?.setPriority(28672), { secondary: 'Configure switch as secondary root' });
  g.add('config', 'no spanning-tree vlan <vlanlist:list>', (s) => s.dev.bridge?.setStpEnabled(false));
  g.add('config', 'spanning-tree vlan <vlanlist:list>', (s) => s.dev.bridge?.setStpEnabled(true));
  g.add('config', 'spanning-tree portfast default', (s) => {
    if (s.dev.bridge) s.dev.bridge.portfastDefault = true;
  });
  g.add('config', 'no spanning-tree portfast default', (s) => {
    if (s.dev.bridge) s.dev.bridge.portfastDefault = false;
  });
  g.add('config', 'spanning-tree portfast bpduguard default', (s) => {
    if (s.dev.bridge) s.dev.bridge.bpduguardDefault = true;
  });
  g.add('config', 'no spanning-tree portfast bpduguard default', (s) => {
    if (s.dev.bridge) s.dev.bridge.bpduguardDefault = false;
  });
  g.add('config', 'cdp run', (s) => {
    s.dev.cdpRun = true;
  }, { run: '' });
  g.add('config', 'no cdp run', (s) => {
    s.dev.cdpRun = false;
    s.dev.cdpNeighbors.clear();
  });
  for (const kw of ['mac address-table', 'mac-address-table']) {
    g.add('config', `${kw} aging-time <int:sec:0-1000000>`, (s, a) => {
      if (s.dev.bridge) s.dev.bridge.agingTime = Number(a.p.sec);
    });
    g.add('config', `${kw} static <mac:mac> vlan <int:vlan:1-4094> interface <iface:if>`, (s, a) => {
      const b = s.dev.bridge;
      const i = s.dev.findIf(a.p.if);
      const bp = i && b ? s.dev.bp(i) : undefined;
      if (!b || !bp) return;
      const mac = normalizeMac(a.p.mac)!;
      b.macTable.set(`${a.p.vlan}|${mac}`, { vlan: Number(a.p.vlan), mac, port: bp, time: 0, static: true });
    });
  }

  // Lines
  g.add('config', 'line console 0', (s) => {
    s.lineCtx = [s.dev.lineCon];
    s.mode = 'line';
  }, { console: 'Primary terminal line' });
  g.add('config', 'line con 0', (s) => {
    s.lineCtx = [s.dev.lineCon];
    s.mode = 'line';
  });
  const vty = (s: S, a: Args) => {
    const from = Number(a.p.first);
    const to = a.p.last !== undefined ? Number(a.p.last) : from;
    const max = s.dev.bridge ? 15 : 4;
    if (to > max) {
      s.println(`% Invalid input detected at '^' marker.`);
      return;
    }
    s.lineCtx = s.dev.lineVty.filter((v) => v.last >= from && v.first <= to);
    s.mode = 'line';
  };
  g.add('config', 'line vty <int:first:0-15>', vty, { vty: 'Virtual terminal', first: 'First Line number' });
  g.add('config', 'line vty <int:first:0-15> <int:last:1-15>', vty, { last: 'Last Line number' });
  g.add('line', 'password <word:pw>', (s, a) => {
    for (const l of s.lineCtx) l.password = a.p.pw;
  }, { pw: 'The UNENCRYPTED (cleartext) line password' });
  g.add('line', 'password 7 <word:enc>', (s, a) => {
    for (const l of s.lineCtx) l.password = type7Decrypt(a.p.enc) ?? a.p.enc;
  });
  g.add('line', 'no password', (s) => {
    for (const l of s.lineCtx) l.password = undefined;
  });
  g.add('line', 'login', (s) => {
    for (const l of s.lineCtx) {
      if (l.password === undefined && l === s.dev.lineCon) s.println('% Login disabled on line 0, until \'password\' is set');
      l.login = true;
    }
  });
  g.add('line', 'login local', (s) => {
    for (const l of s.lineCtx) l.login = 'local';
  }, { local: 'Local password checking' });
  g.add('line', 'no login', (s) => {
    for (const l of s.lineCtx) l.login = false;
  });
  g.add('line', 'logging synchronous', (s) => {
    for (const l of s.lineCtx) l.loggingSync = true;
  }, { synchronous: 'Synchronized message output' });
  g.add('line', 'no logging synchronous', (s) => {
    for (const l of s.lineCtx) l.loggingSync = false;
  });
  g.add('line', 'exec-timeout <int:min:0-35791>', (s, a) => {
    for (const l of s.lineCtx) l.execTimeout = [Number(a.p.min), 0];
  }, { min: 'Timeout in minutes' });
  g.add('line', 'exec-timeout <int:min:0-35791> <int:sec:0-2147483>', (s, a) => {
    for (const l of s.lineCtx) l.execTimeout = [Number(a.p.min), Number(a.p.sec)];
  }, { sec: 'Timeout in seconds' });
  for (const t of ['all', 'none', 'ssh', 'telnet', 'telnet ssh', 'ssh telnet'])
    g.add('line', `transport input ${t}`, (s) => {
      for (const l of s.lineCtx) l.transportInput = t;
    }, { transport: 'Define transport protocols for line', input: 'Define which protocols to use when connecting to the terminal server' });

  // ------------------------------------------------------------------- INTERFACE
  g.add(IFM, 'description <line:text>', (s, a) => {
    for (const i of ifs(s)) i.description = a.p.text;
  }, { text: 'Up to 240 characters describing this interface' });
  g.add(IFM, 'no description', (s) => {
    for (const i of ifs(s)) i.description = '';
  });
  g.add(IFM, 'shutdown', (s) => {
    for (const i of ifs(s)) s.dev.setShutdown(i, true);
  });
  g.add(IFM, 'no shutdown', (s) => {
    for (const i of ifs(s)) s.dev.setShutdown(i, false);
  });

  const ipAddress = (s: S, a: Args) => {
    const d = s.dev;
    const addr = parseIPv4(a.p.addr)!;
    const prefix = prefixOf(a.p.mask);
    if (prefix === null) return badMask(s, a, a.p.mask);
    for (const i of ifs(s)) {
      if (!requireL3(s, i)) return;
      if (prefix < 31 && (networkOf(addr, prefix) === addr || ((addr | (~(0xffffffff << (32 - prefix)) >>> 0)) >>> 0) === addr)) {
        s.println(`Bad mask /${prefix} for address ${a.p.addr}`);
        return;
      }
      const ov = overlapping(d, i, addr, prefix);
      if (ov) {
        s.println(`% ${formatIPv4(networkOf(addr, prefix))} overlaps with ${ov.name}`);
        return;
      }
      if (i.dhcpAddr) {
        d.stack.dhcpStop(i, true);
        i.dhcpAddr = false;
      }
      if (a.kw.has('secondary')) i.v4.push({ addr, prefix, secondary: true, source: 'manual' });
      else i.v4 = [{ addr, prefix, source: 'manual' }, ...i.v4.filter((x) => x.secondary)];
      d.stack.clearArp(i);
      d.stack.gratuitousArp(i);
      d.syncState();
    }
  };
  g.add(IFM, 'ip address <ipv4:addr> <ipv4:mask>', ipAddress, { address: 'Set the IP address of an interface', addr: 'IP address', mask: 'IP subnet mask' });
  g.add(IFM, 'ip address <ipv4:addr> <ipv4:mask> secondary', ipAddress, { secondary: 'Make this IP address a secondary address' });
  g.add(IFM, 'ip address dhcp', (s) => {
    for (const i of ifs(s)) {
      if (!requireL3(s, i)) return;
      i.dhcpAddr = true;
      i.v4 = [];
      s.dev.stack.dhcpStart(i);
    }
  }, { dhcp: 'IP Address negotiated via DHCP' });
  g.add(IFM, 'no ip address', (s) => {
    for (const i of ifs(s)) {
      if (i.dhcpAddr) s.dev.stack.dhcpStop(i, true);
      i.dhcpAddr = false;
      i.v4 = [];
      s.dev.stack.clearArp(i);
    }
    s.dev.syncState();
  });
  g.add(IFM, 'no ip address <ipv4:addr> <ipv4:mask>', (s, a) => {
    const addr = parseIPv4(a.p.addr)!;
    for (const i of ifs(s)) i.v4 = i.v4.filter((x) => x.addr !== addr);
  });
  g.add(IFM, 'ip helper-address <ipv4:h>', (s, a) => {
    const h = parseIPv4(a.p.h)!;
    for (const i of ifs(s)) if (!i.helpers.includes(h)) i.helpers.push(h);
  }, { h: 'IP destination address' });
  g.add(IFM, 'no ip helper-address <ipv4:h>', (s, a) => {
    const h = parseIPv4(a.p.h)!;
    for (const i of ifs(s)) i.helpers = i.helpers.filter((x) => x !== h);
  });
  g.add(IFM, 'no ip helper-address', (s) => {
    for (const i of ifs(s)) i.helpers = [];
  });
  for (const dir of ['in', 'out'] as const) {
    g.add(IFM, `ip access-group <word:acl> ${dir}`, (s, a) => {
      for (const i of ifs(s)) {
        if (!requireL3(s, i)) return;
        if (dir === 'in') i.aclIn = a.p.acl;
        else i.aclOut = a.p.acl;
      }
    }, { acl: 'IP access list (standard or extended)', in: 'inbound packets', out: 'outbound packets' });
    g.add(IFM, `no ip access-group <word:acl> ${dir}`, (s) => {
      for (const i of ifs(s)) {
        if (dir === 'in') i.aclIn = undefined;
        else i.aclOut = undefined;
      }
    });
    g.add(IFM, `no ip access-group ${dir}`, (s) => {
      for (const i of ifs(s)) {
        if (dir === 'in') i.aclIn = undefined;
        else i.aclOut = undefined;
      }
    });
  }
  for (const side of ['inside', 'outside'] as const) {
    g.add(IFM, `ip nat ${side}`, (s) => {
      for (const i of ifs(s)) if (requireL3(s, i)) i.nat = side;
    }, { inside: 'Inside interface for address translation', outside: 'Outside interface for address translation' });
    g.add(IFM, `no ip nat ${side}`, (s) => {
      for (const i of ifs(s)) if (i.nat === side) i.nat = undefined;
    });
  }

  // IPv6 on interfaces
  g.add(IFM, 'ipv6 address <ipv6prefix:pfx>', (s, a) => {
    const pf = parsePrefix6(a.p.pfx)!;
    for (const i of ifs(s)) {
      if (!requireL3(s, i)) return;
      if (!i.v6.some((x) => x.addr === pf.addr)) i.v6.push({ addr: pf.addr, prefix: pf.prefix, source: 'manual' });
      s.dev.refreshV6(i);
    }
    s.dev.syncState();
  }, { address: 'Configure IPv6 address on interface', pfx: 'IPv6 prefix' });
  g.add(IFM, 'ipv6 address <ipv6prefix:pfx> eui-64', (s, a) => {
    const pf = parsePrefix6(a.p.pfx)!;
    for (const i of ifs(s)) {
      if (!requireL3(s, i)) return;
      const addr = network6(pf.addr, 64) | eui64(i.mac);
      if (!i.v6.some((x) => x.addr === addr)) i.v6.push({ addr, prefix: pf.prefix, source: 'eui64' });
      s.dev.refreshV6(i);
    }
  }, { 'eui-64': 'Use eui-64 interface identifier' });
  g.add(IFM, 'ipv6 address <ipv6:ll> link-local', (s, a) => {
    const ll = parseIPv6(a.p.ll)!;
    if (!isLinkLocal6(ll)) {
      s.println('% Invalid link-local address');
      return;
    }
    for (const i of ifs(s)) {
      i.v6 = i.v6.filter((x) => x.source !== 'linklocal');
      i.v6.unshift({ addr: ll, prefix: 64, source: 'linklocal', manual: true });
      s.dev.refreshV6(i);
    }
  }, { 'link-local': 'Use link-local address' });
  g.add(IFM, 'no ipv6 address', (s) => {
    for (const i of ifs(s)) {
      i.v6 = [];
      s.dev.refreshV6(i);
    }
  });
  g.add(IFM, 'no ipv6 address <ipv6prefix:pfx>', (s, a) => {
    const pf = parsePrefix6(a.p.pfx)!;
    for (const i of ifs(s)) {
      i.v6 = i.v6.filter((x) => x.addr !== pf.addr);
      s.dev.refreshV6(i);
    }
  });
  g.add(IFM, 'ipv6 enable', (s) => {
    for (const i of ifs(s)) {
      if (!requireL3(s, i)) return;
      i.ipv6On = true;
      s.dev.refreshV6(i);
    }
  }, { enable: 'Enable IPv6 on interface' });
  g.add(IFM, 'no ipv6 enable', (s) => {
    for (const i of ifs(s)) {
      i.ipv6On = false;
      s.dev.refreshV6(i);
    }
  });
  g.add(IFM, 'ipv6 nd ra suppress', (s) => {
    for (const i of ifs(s)) i.raSuppress = true;
  }, { nd: 'IPv6 interface Neighbor Discovery subcommands', ra: 'Router Advertisement control', suppress: 'Suppress IPv6 Router Advertisements' });
  g.add(IFM, 'ipv6 nd ra suppress all', (s) => {
    for (const i of ifs(s)) i.raSuppress = true;
  });
  g.add(IFM, 'ipv6 nd ra interval <int:sec:4-1800>', (s, a) => {
    for (const i of ifs(s)) {
      i.raInterval = Number(a.p.sec);
      i.nextRa = undefined;
    }
  }, { interval: 'Set IPv6 Router Advertisement Interval', sec: 'RA Interval (sec)' });
  g.add(IFM, 'no ipv6 nd ra interval', (s) => {
    for (const i of ifs(s)) i.raInterval = undefined;
  });
  g.add(IFM, 'no ipv6 nd ra suppress', (s) => {
    for (const i of ifs(s)) i.raSuppress = false;
  });

  // Subinterfaces
  g.add(['subif'], 'encapsulation dot1Q <int:vlan:1-4094>', (s, a) => {
    for (const i of ifs(s)) {
      i.vlan = Number(a.p.vlan);
      i.native = false;
    }
    s.dev.syncState();
  }, { dot1Q: 'IEEE 802.1Q Virtual LAN', vlan: 'IEEE 802.1Q VLAN ID required' });
  g.add(['subif'], 'encapsulation dot1Q <int:vlan:1-4094> native', (s, a) => {
    for (const i of ifs(s)) {
      i.vlan = Number(a.p.vlan);
      i.native = true;
    }
    s.dev.syncState();
  }, { native: 'Make this as native vlan' });
  g.add(['subif'], 'no encapsulation dot1Q', (s) => {
    for (const i of ifs(s)) i.vlan = undefined;
    s.dev.syncState();
  });

  // Speed / duplex
  const speedCmd = (s: S, v: 'auto' | number) => {
    for (const i of ifs(s)) {
      if (i.kind !== 'physical' || !i.port) continue;
      if (v !== 'auto' && !i.port.spec.speeds.includes(v)) {
        s.println(`% Invalid input detected at '^' marker.`);
        return;
      }
      i.speedCfg = v;
      i.port.forcedSpeed = v === 'auto' ? null : v;
      if (i.port.link) s.dev.simulator.linkChanged(i.port.link);
    }
  };
  for (const v of ['10', '100', '1000']) g.add(IFM, `speed ${v}`, (s) => speedCmd(s, Number(v)), { [v]: `Force ${v} Mbps operation` });
  g.add(IFM, 'speed auto', (s) => speedCmd(s, 'auto'), { auto: 'Enable AUTO speed configuration' });
  g.add(IFM, 'no speed', (s) => speedCmd(s, 'auto'));
  for (const v of ['auto', 'full', 'half'] as const)
    g.add(IFM, `duplex ${v}`, (s) => {
      for (const i of ifs(s)) {
        if (i.kind !== 'physical' || !i.port) continue;
        i.duplexCfg = v;
        i.port.duplex = v;
      }
    }, { [v]: `Force ${v}-duplex operation` });
  g.add(IFM, 'cdp enable', (s) => {
    for (const i of ifs(s)) i.cdp = true;
  }, { enable: 'Enable CDP on interface' });
  g.add(IFM, 'no cdp enable', (s) => {
    for (const i of ifs(s)) i.cdp = false;
  });

  // Switchport
  const swMode = (mode: 'access' | 'trunk' | 'dynamic auto' | 'dynamic desirable') => (s: S) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) s.dev.bp(i)!.cfg.mode = mode;
    afterSwitchportChange(s, list);
  };
  g.add(IFM, 'switchport mode access', swMode('access'), { mode: 'Set trunking mode of the interface', access: 'Set trunking mode to ACCESS unconditionally' });
  g.add(IFM, 'switchport mode trunk', swMode('trunk'), { trunk: 'Set trunking mode to TRUNK unconditionally' });
  g.add(IFM, 'switchport mode dynamic auto', swMode('dynamic auto'), { dynamic: 'Set trunking mode to dynamically negotiate access or trunk mode', auto: 'Set trunking mode dynamic negotiation parameter to AUTO' });
  g.add(IFM, 'switchport mode dynamic desirable', swMode('dynamic desirable'), { desirable: 'Set trunking mode dynamic negotiation parameter to DESIRABLE' });
  g.add(IFM, 'no switchport mode', swMode('dynamic auto'));
  g.add(IFM, 'switchport access vlan <int:vlan:1-4094>', (s, a) => {
    const list = switchports(s);
    if (!list) return;
    const v = Number(a.p.vlan);
    const b = s.dev.bridge!;
    if (!b.vlans.has(v)) {
      s.println(`% Access VLAN does not exist. Creating vlan ${v}`);
      b.vlans.set(v, { id: v, name: `VLAN${String(v).padStart(4, '0')}` });
    }
    for (const i of list) s.dev.bp(i)!.cfg.accessVlan = v;
    afterSwitchportChange(s, list);
  }, { vlan: 'Set VLAN when interface is in access mode' });
  g.add(IFM, 'no switchport access vlan', (s) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) s.dev.bp(i)!.cfg.accessVlan = 1;
    afterSwitchportChange(s, list);
  });
  g.add(IFM, 'switchport trunk native vlan <int:vlan:1-4094>', (s, a) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) s.dev.bp(i)!.cfg.nativeVlan = Number(a.p.vlan);
    afterSwitchportChange(s, list);
  }, { native: 'Set trunking native characteristics when interface is in trunking mode', vlan: 'VLAN ID of the native VLAN when this port is in trunking mode' });
  g.add(IFM, 'no switchport trunk native vlan', (s) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) s.dev.bp(i)!.cfg.nativeVlan = 1;
    afterSwitchportChange(s, list);
  });
  const allowed = (op: 'set' | 'add' | 'remove' | 'all' | 'none' | 'except') => (s: S, a: Args) => {
    const list = switchports(s);
    if (!list) return;
    const vs = a.p.list ? parseVlanList(a.p.list) : [];
    for (const i of list) {
      const c = s.dev.bp(i)!.cfg;
      const cur = c.allowed ?? new Set(Array.from({ length: 4094 }, (_, k) => k + 1));
      if (op === 'set') c.allowed = new Set(vs);
      else if (op === 'add') {
        if (c.allowed !== null) for (const v of vs) cur.add(v);
        if (c.allowed !== null) c.allowed = cur;
      } else if (op === 'remove') {
        for (const v of vs) cur.delete(v);
        c.allowed = cur;
      } else if (op === 'all') c.allowed = null;
      else if (op === 'none') c.allowed = new Set();
      else c.allowed = new Set([...Array.from({ length: 4094 }, (_, k) => k + 1)].filter((v) => !vs.includes(v)));
    }
    afterSwitchportChange(s, list);
  };
  g.add(IFM, 'switchport trunk allowed vlan <vlanlist:list>', allowed('set'), { allowed: 'Set allowed VLAN characteristics when interface is in trunking mode', list: 'VLAN IDs of the allowed VLANs when this port is in trunking mode' });
  g.add(IFM, 'switchport trunk allowed vlan add <vlanlist:list>', allowed('add'), { add: 'add VLANs to the current list' });
  g.add(IFM, 'switchport trunk allowed vlan remove <vlanlist:list>', allowed('remove'), { remove: 'remove VLANs from the current list' });
  g.add(IFM, 'switchport trunk allowed vlan except <vlanlist:list>', allowed('except'), { except: 'all VLANs except the following' });
  g.add(IFM, 'switchport trunk allowed vlan all', allowed('all'), { all: 'all VLANs' });
  g.add(IFM, 'switchport trunk allowed vlan none', allowed('none'), { none: 'no VLANs' });
  g.add(IFM, 'no switchport trunk allowed vlan', allowed('all'));
  g.add(IFM, 'switchport trunk encapsulation dot1q', (s) => {
    if (!s.dev.model.caps.routing) s.println("% Invalid input detected at '^' marker.");
  }, { encapsulation: 'Set trunking encapsulation when interface is in trunking mode', dot1q: 'Interface uses only 802.1q trunking encapsulation when trunking' });
  g.add(IFM, 'switchport nonegotiate', (s) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) {
      const c = s.dev.bp(i)!.cfg;
      if (c.mode !== 'access' && c.mode !== 'trunk') {
        s.println('Command rejected: Conflict between \'nonegotiate\' and \'dynamic\' status.');
        return;
      }
      c.nonegotiate = true;
    }
    afterSwitchportChange(s, list);
  }, { nonegotiate: 'Device will not engage in negotiation protocol on this interface' });
  g.add(IFM, 'no switchport nonegotiate', (s) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) s.dev.bp(i)!.cfg.nonegotiate = false;
    afterSwitchportChange(s, list);
  });
  g.add(IFM, 'no switchport', (s) => {
    const d = s.dev;
    if (!d.bridge) return;
    if (!d.model.caps.routedPorts) {
      s.println("% Invalid input detected at '^' marker.");
      return;
    }
    for (const i of ifs(s)) {
      const bp = d.bp(i);
      if (!bp || bp.routed) continue;
      bp.routed = true;
      bp.state = 'disabled';
      bp.role = 'disabled';
      bp.trunk = false;
      d.bridge.flushPort(bp);
      d.bridge.recompute();
      i.lastUp = false;
    }
    d.syncState();
  });
  g.add(IFM, 'switchport', (s) => {
    const d = s.dev;
    if (!d.bridge) return;
    for (const i of ifs(s)) {
      const bp = d.bp(i);
      if (!bp || !bp.routed) continue;
      bp.routed = false;
      i.v4 = [];
      i.v6 = [];
      i.v6Enabled = false;
      d.bridge.portChanged(bp);
    }
    d.syncState();
  });
  g.add(IFM, 'spanning-tree portfast', (s) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) s.dev.bp(i)!.cfg.portfast = true;
    s.println(`%Warning: portfast should only be enabled on ports connected to a single
 host. Connecting hubs, concentrators, switches, bridges, etc... to this
 interface  when portfast is enabled, can cause temporary bridging loops.
 Use with CAUTION
`);
    s.println(`%Portfast has been configured on ${list.map((i) => i.name).join(', ')} but will only
 have effect when the interface is in a non-trunking mode.`);
    for (const i of list) {
      const bp = s.dev.bp(i)!;
      if (bp.port.isUp() && bp.role === 'designated' && !bp.trunk) s.dev.bridge!.recompute();
    }
  }, { portfast: 'Enable an interface to move directly to forwarding on link up' });
  g.add(IFM, 'no spanning-tree portfast', (s) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) s.dev.bp(i)!.cfg.portfast = false;
  });
  g.add(IFM, 'spanning-tree bpduguard enable', (s) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) s.dev.bp(i)!.cfg.bpduguard = true;
  }, { bpduguard: "Don't accept BPDUs on this interface", enable: 'Enable BPDU guard for this interface' });
  g.add(IFM, 'spanning-tree bpduguard disable', (s) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) s.dev.bp(i)!.cfg.bpduguard = false;
  });
  g.add(IFM, 'no spanning-tree bpduguard', (s) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) s.dev.bp(i)!.cfg.bpduguard = false;
  });
  g.add(IFM, 'spanning-tree cost <int:cost:1-200000000>', (s, a) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) s.dev.bp(i)!.cfg.cost = Number(a.p.cost);
    s.dev.bridge!.recompute();
  });
  g.add(IFM, 'no spanning-tree cost', (s) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) s.dev.bp(i)!.cfg.cost = undefined;
    s.dev.bridge!.recompute();
  });
  g.add(IFM, 'spanning-tree port-priority <int:prio:0-240>', (s, a) => {
    const list = switchports(s);
    if (!list) return;
    for (const i of list) s.dev.bp(i)!.cfg.priority = Number(a.p.prio);
    s.dev.bridge!.recompute();
  });

  cached = g;
  return g;
}

