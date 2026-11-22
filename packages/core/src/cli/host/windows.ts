/** Windows 11 command prompt (cmd.exe) subset: ipconfig, ping, tracert, arp, netsh, route... */
import { HostShell } from './base';
import { formatIPv4, parseIPv4, prefixToMask, maskToPrefix, broadcastOf } from '../../net/ipv4';
import { formatIPv6, parseIPv6 } from '../../net/ipv6';
import { macToWindows } from '../../net/mac';
import type { EchoResult } from '../../l3/stack';

const IFINDEX = 12;

function dotted(label: string): string {
  // Windows aligns the colon at column 37 with ". " leaders on odd columns.
  let s = `   ${label}`;
  for (let i = s.length; i < 37; i++) s += i % 2 === 1 ? '.' : ' ';
  return s + ': ';
}

function winDate(ms: number): string {
  // Virtual time starts at the lab's creation; show it as a fixed date for readability.
  const d = new Date(Date.UTC(2026, 0, 5, 8, 0, 0) + ms);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const h = d.getUTCHours() % 12 || 12;
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${h}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} ${d.getUTCHours() < 12 ? 'AM' : 'PM'}`;
}

export class WindowsShell extends HostShell {
  prompt() {
    return 'C:\\Users\\aluno>';
  }

  protected banner() {
    return 'Microsoft Windows [Version 10.0.26100.2605]\n(c) Microsoft Corporation. All rights reserved.\n\n';
  }

  protected commands() {
    return ['ipconfig', 'ping', 'tracert', 'arp', 'netsh', 'route', 'hostname', 'cls', 'getmac', 'nslookup', 'help', 'exit', 'ver', 'echo'];
  }

  protected run(args: string[], line: string) {
    const cmd = args[0].toLowerCase().replace(/\.exe$/, '');
    const rest = args.slice(1);
    switch (cmd) {
      case 'ipconfig':
        return this.ipconfig(rest);
      case 'ping':
        return this.ping(rest);
      case 'tracert':
        return this.tracert(rest);
      case 'arp':
        return this.arp(rest);
      case 'netsh':
        return this.netsh(rest);
      case 'route':
        return this.route(rest);
      case 'hostname':
        return this.println(this.host.cfg.hostname);
      case 'getmac':
        this.println('\nPhysical Address    Transport Name');
        this.println('=================== ==========================================================');
        this.println(`${macToWindows(this.host.nic.mac)}   \\Device\\Tcpip_{7C3A2F1E-9B8D-4E6A-A1C2-3D4E5F6A7B8C}\n`);
        return;
      case 'cls':
        this.out('\x1b[2J\x1b[H');
        return;
      case 'ver':
        this.println('\nMicrosoft Windows [Version 10.0.26100.2605]\n');
        return;
      case 'echo':
        this.println(line.slice(4).trim());
        return;
      case 'nslookup':
        return this.nslookup(rest);
      case 'help':
        this.println('Comandos simulados disponíveis:\n  IPCONFIG [/all | /release | /renew]\n  PING [-n count] [-l size] [-t] [-4 | -6] destino\n  TRACERT [-d] destino\n  ARP -a | -d\n  NETSH interface ip set address "Ethernet" static IP MÁSCARA [GATEWAY] | dhcp\n  ROUTE PRINT\n  GETMAC, HOSTNAME, NSLOOKUP, CLS, VER, EXIT\n');
        return;
      case 'exit':
        this.out('\x1b[2J\x1b[H');
        this.start();
        return;
      default:
        this.println(`'${args[0]}' is not recognized as an internal or external command,\noperable program or batch file.\n`);
    }
  }

  // ------------------------------------------------------------------ ipconfig

  private ipconfig(rest: string[]) {
    const opt = (rest[0] ?? '').toLowerCase();
    const h = this.host;
    const nic = h.nic;
    if (opt === '/release') {
      if (!nic.dhcp) {
        this.println('\nWindows IP Configuration\n\nThe operation failed as no adapter is in the state permissible for\nthis operation.\n');
        return;
      }
      h.stack.dhcpStop(nic, true);
      nic.dhcp = { state: 'failed', xid: 0, tries: 0 };
      this.println('\nWindows IP Configuration\n');
      this.adapter(false);
      return;
    }
    if (opt === '/renew') {
      if (h.cfg.ipv4.mode !== 'dhcp') {
        this.println('\nWindows IP Configuration\n\nThe operation failed as no adapter is in the state permissible for\nthis operation.\n');
        return;
      }
      if (!nic.isUp()) {
        this.println('\nWindows IP Configuration\n\nNo operation can be performed on Ethernet while it has its media disconnected.\n');
        return;
      }
      h.stack.dhcpStart(nic);
      let aborted = false;
      this.async(() => {
        aborted = true;
        this.done();
      });
      const started = h.simulator.now;
      const wait = () => {
        if (aborted) return;
        const st = nic.dhcp?.state;
        if (st === 'bound') {
          this.println('\nWindows IP Configuration\n');
          this.adapter(false);
          this.done();
        } else if (st === 'failed' || h.simulator.now - started > 20_000) {
          this.println('\nWindows IP Configuration\n\nAn error occurred while renewing interface Ethernet : unable to contact your DHCP server. Request has timed out.\n');
          this.done();
        } else h.timer(250, wait);
      };
      h.timer(250, wait);
      return;
    }
    const all = opt === '/all';
    if (opt && !all) {
      this.println(`\nError: unrecognized or incomplete command line.\n\nUSAGE:\n    ipconfig [/allcompartments] [/? | /all | /renew | /release]\n`);
      return;
    }
    this.println('\nWindows IP Configuration\n');
    if (all) {
      this.println(dotted('Host Name') + h.cfg.hostname);
      this.println(dotted('Primary Dns Suffix') + '');
      this.println(dotted('Node Type') + 'Hybrid');
      this.println(dotted('IP Routing Enabled') + 'No');
      this.println(dotted('WINS Proxy Enabled') + 'No\n');
    }
    this.adapter(all);
  }

  private adapter(all: boolean) {
    const h = this.host;
    const nic = h.nic;
    const st = h.stack;
    this.println('Ethernet adapter Ethernet:\n');
    if (!nic.isUp()) {
      this.println(dotted('Media State') + 'Media disconnected');
      this.println(dotted('Connection-specific DNS Suffix ') + '');
      if (all) {
        this.println(dotted('Description') + 'Intel(R) Ethernet Connection (17) I219-LM');
        this.println(dotted('Physical Address') + macToWindows(nic.mac));
        this.println(dotted('DHCP Enabled') + (h.cfg.ipv4.mode === 'dhcp' ? 'Yes' : 'No'));
      }
      this.println('');
      return;
    }
    const lease = nic.dhcp?.lease;
    this.println(dotted('Connection-specific DNS Suffix ') + (lease?.domain ?? ''));
    if (all) {
      this.println(dotted('Description') + 'Intel(R) Ethernet Connection (17) I219-LM');
      this.println(dotted('Physical Address') + macToWindows(nic.mac));
      this.println(dotted('DHCP Enabled') + (h.cfg.ipv4.mode === 'dhcp' ? 'Yes' : 'No'));
      this.println(dotted('Autoconfiguration Enabled') + 'Yes');
    }
    for (const a of nic.v6) {
      if (a.source === 'linklocal') continue;
      this.println(dotted('IPv6 Address') + formatIPv6(a.addr) + (all ? '(Preferred) ' : ''));
    }
    const ll = nic.v6.find((a) => a.source === 'linklocal');
    if (ll) this.println(dotted('Link-local IPv6 Address') + `${formatIPv6(ll.addr)}%${IFINDEX}` + (all ? '(Preferred) ' : ''));
    for (const a of nic.v4) {
      const dup = nic.duplicate === a.addr ? '(Duplicate)' : all ? '(Preferred) ' : '';
      const label = a.source === 'apipa' ? 'Autoconfiguration IPv4 Address' : 'IPv4 Address';
      this.println(dotted(label) + formatIPv4(a.addr) + dup);
      this.println(dotted('Subnet Mask') + formatIPv4(prefixToMask(a.prefix)));
    }
    if (all && lease) {
      this.println(dotted('Lease Obtained') + winDate(lease.obtained));
      this.println(dotted('Lease Expires') + winDate(lease.expires));
    }
    const gws: string[] = [];
    const gw6 = st.defaultGateway6 ?? [...st.raRouters.values()][0]?.addr;
    if (gw6 !== undefined) gws.push(`${formatIPv6(gw6)}%${IFINDEX}`);
    const gw4 = nic.dhcp ? lease?.gateway : st.defaultGateway;
    if (gw4 !== undefined) gws.push(formatIPv4(gw4));
    this.println(dotted('Default Gateway') + (gws[0] ?? ''));
    for (const g of gws.slice(1)) this.println(' '.repeat(41) + g);
    if (all) {
      if (lease) this.println(dotted('DHCP Server') + formatIPv4(lease.server));
      const dns = nic.dhcp ? lease?.dns ?? [] : st.dnsServers;
      this.println(dotted('DNS Servers') + (dns.length ? formatIPv4(dns[0]) : 'fec0:0:0:ffff::1%1'));
      for (const d of dns.slice(1)) this.println(' '.repeat(41) + formatIPv4(d));
      this.println(dotted('NetBIOS over Tcpip') + 'Enabled');
    }
    this.println('');
  }

  // ------------------------------------------------------------------ ping

  private ping(rest: string[]) {
    let count = 4;
    let size = 32;
    let forever = false;
    let target: string | undefined;
    let force6 = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i].toLowerCase();
      if (a === '-n') count = Number(rest[++i]) || 4;
      else if (a === '-l') size = Number(rest[++i]) || 32;
      else if (a === '-t') forever = true;
      else if (a === '-6') force6 = true;
      else if (a === '-4') force6 = false;
      else if (a.startsWith('-') || a.startsWith('/')) {
        this.println(`Bad option ${rest[i]}.\n`);
        return;
      } else target = rest[i];
    }
    if (!target) {
      this.println('\nUsage: ping [-t] [-a] [-n count] [-l size] [-f] [-i TTL] [-v TOS]\n            [-r count] [-s count] [[-j host-list] | [-k host-list]]\n            [-w timeout] [-R] [-S srcaddr] [-c compartment] [-p]\n            [-4] [-6] target_name\n');
      return;
    }
    const v4 = force6 ? null : parseIPv4(target);
    const v6 = v4 === null ? parseIPv6(target) : null;
    if (v4 === null && v6 === null) {
      this.println(`Ping request could not find host ${target}. Please check the name and try again.`);
      return;
    }
    const h = this.host;
    const label = v4 !== null ? formatIPv4(v4) : formatIPv6(v6!);
    this.println(`\nPinging ${label} with ${size} bytes of data:`);
    let sent = 0;
    let received = 0;
    const rtts: number[] = [];
    let aborted = false;
    const stats = () => {
      this.println(`\nPing statistics for ${label}:`);
      const lost = sent - received;
      this.println(`    Packets: Sent = ${sent}, Received = ${received}, Lost = ${lost} (${sent ? Math.round((lost * 100) / sent) : 0}% loss),`);
      if (rtts.length) {
        const min = Math.min(...rtts);
        const max = Math.max(...rtts);
        const avg = Math.round(rtts.reduce((x, y) => x + y, 0) / rtts.length);
        this.println('Approximate round trip times in milli-seconds:');
        this.println(`    Minimum = ${min}ms, Maximum = ${max}ms, Average = ${avg}ms`);
      }
      this.done();
    };
    this.async(() => {
      aborted = true;
      stats();
      this.out('Control-C\n^C');
    });
    const one = (seq: number) => {
      if (aborted) return;
      if (!forever && seq >= count) {
        stats();
        return;
      }
      sent++;
      const t0 = h.simulator.now;
      const cb = (r: EchoResult) => {
        if (aborted) return;
        let general = false;
        switch (r.type) {
          case 'reply': {
            received++;
            const rtt = Math.max(1, Math.round(r.rtt));
            rtts.push(rtt);
            this.println(v4 !== null ? `Reply from ${label}: bytes=${size} time=${rtt}ms TTL=${r.ttl}` : `Reply from ${label}: time=${rtt}ms`);
            break;
          }
          case 'timeout':
            this.println('Request timed out.');
            break;
          case 'unreachable': {
            received++;
            const from = typeof r.from === 'bigint' ? formatIPv6(r.from) : formatIPv4(r.from as number);
            this.println(`Reply from ${from}: Destination ${r.code === 0 ? 'net' : r.code === 13 ? 'host' : 'host'} unreachable.`);
            break;
          }
          case 'ttl-exceeded': {
            received++;
            const from = typeof r.from === 'bigint' ? formatIPv6(r.from) : formatIPv4(r.from as number);
            this.println(`Reply from ${from}: TTL expired in transit.`);
            break;
          }
          case 'port-unreachable':
            this.println('Request timed out.');
            break;
          case 'local-error':
            if (r.reason === 'arp-failed') {
              received++;
              const self = h.nic.v4[0] ? formatIPv4(h.nic.v4[0].addr) : '0.0.0.0';
              this.println(`Reply from ${self}: Destination host unreachable.`);
            } else {
              general = true;
              this.println('PING: transmit failed. General failure. ');
            }
        }
        const elapsed = h.simulator.now - t0;
        h.timer(general ? 1000 : Math.max(0, 1000 - elapsed), () => one(seq + 1));
      };
      if (v4 !== null) h.stack.echo4(v4, { seq: seq + 1, size, timeout: 4000 }, cb);
      else h.stack.echo6(v6!, { seq: seq + 1, size, timeout: 4000 }, cb);
    };
    one(0);
  }

  private tracert(rest: string[]) {
    const target = rest.filter((r) => !r.startsWith('-'))[0];
    if (!target) {
      this.println('\nUsage: tracert [-d] [-h maximum_hops] [-j host-list] [-w timeout]\n               [-R] [-S srcaddr] [-4] [-6] target_name\n');
      return;
    }
    const v4 = parseIPv4(target);
    const v6 = v4 === null ? parseIPv6(target) : null;
    if (v4 === null && v6 === null) {
      this.println(`Unable to resolve target system name ${target}.`);
      return;
    }
    const h = this.host;
    const label = v4 !== null ? formatIPv4(v4) : formatIPv6(v6!);
    this.println(`\nTracing route to ${label} over a maximum of 30 hops\n`);
    let aborted = false;
    this.async(() => {
      aborted = true;
      this.println('^C');
      this.done();
    });
    const hop = (ttl: number) => {
      if (aborted) return;
      if (ttl > 30) {
        this.println('\nTrace complete.');
        this.done();
        return;
      }
      const times: string[] = [];
      let from: string | null = null;
      let reached = false;
      let fatal: string | null = null;
      const probe = (n: number) => {
        if (aborted) return;
        if (n === 3) {
          const cols = times.map((t) => t.padStart(6)).join('   ');
          if (fatal) this.println(`${String(ttl).padStart(3)}  ${cols}  ${fatal}`);
          else this.println(`${String(ttl).padStart(3)}  ${cols}  ${from ?? 'Request timed out.'}`);
          if (reached || fatal) {
            this.println('\nTrace complete.');
            this.done();
          } else hop(ttl + 1);
          return;
        }
        const cb = (r: EchoResult) => {
          if (r.type === 'timeout') times.push('*   ');
          else if (r.type === 'local-error') {
            times.push('*   ');
            fatal = 'Transmit error: code 1231.';
          } else {
            const rtt = 'rtt' in r ? Math.max(1, Math.round(r.rtt)) : 1;
            times.push(`${rtt} ms`);
            if ('from' in r) from = typeof r.from === 'bigint' ? formatIPv6(r.from) : formatIPv4(r.from as number);
            if (r.type === 'reply') reached = true;
            if (r.type === 'unreachable') {
              reached = true;
              from = `${from} reports: Destination host unreachable.`;
            }
          }
          h.timer(0, () => probe(n + 1));
        };
        if (v4 !== null) h.stack.echo4(v4, { seq: ttl * 3 + n, ttl, timeout: 4000 }, cb);
        else h.stack.echo6(v6!, { seq: ttl * 3 + n, hopLimit: ttl, timeout: 4000 }, cb);
      };
      probe(0);
    };
    hop(1);
  }

  // ------------------------------------------------------------------ arp / route / netsh

  private arp(rest: string[]) {
    const opt = (rest[0] ?? '').toLowerCase();
    const h = this.host;
    if (opt === '-d') {
      h.stack.clearArp();
      return;
    }
    if (opt !== '-a' && opt !== '-g') {
      this.println('\nDisplays and modifies the IP-to-Physical address translation tables used by\naddress resolution protocol (ARP).\n\nARP -s inet_addr eth_addr [if_addr]\nARP -d inet_addr [if_addr]\nARP -a [inet_addr] [-N if_addr] [-v]\n');
      return;
    }
    const a = h.nic.v4[0];
    if (!a) {
      this.println('No ARP Entries Found.');
      return;
    }
    this.println(`\nInterface: ${formatIPv4(a.addr)} --- 0x${IFINDEX.toString(16)}`);
    this.println('  Internet Address      Physical Address      Type');
    for (const e of h.stack.arpEntries()) {
      if (!e.mac) continue;
      this.println(`  ${formatIPv4(e.ip).padEnd(22)}${e.mac.replace(/:/g, '-').padEnd(22)}dynamic   `);
    }
    this.println(`  ${formatIPv4(broadcastOf(a.addr, a.prefix)).padEnd(22)}${'ff-ff-ff-ff-ff-ff'.padEnd(22)}static    `);
    this.println(`  ${'224.0.0.22'.padEnd(22)}${'01-00-5e-00-00-16'.padEnd(22)}static    `);
    this.println(`  ${'255.255.255.255'.padEnd(22)}${'ff-ff-ff-ff-ff-ff'.padEnd(22)}static    \n`);
  }

  private route(rest: string[]) {
    if ((rest[0] ?? '').toLowerCase() !== 'print') {
      this.println('\nManipulates network routing tables.\n\nROUTE [-f] [-p] [-4|-6] command [destination]\n                  [MASK netmask]  [gateway] [METRIC metric]  [IF interface]\n');
      return;
    }
    const h = this.host;
    this.println('===========================================================================');
    this.println('Interface List');
    this.println(` ${IFINDEX}...${macToWindows(h.nic.mac).replace(/-/g, ' ').toLowerCase()} ......Intel(R) Ethernet Connection (17) I219-LM`);
    this.println('  1...........................Software Loopback Interface 1');
    this.println('===========================================================================\n');
    this.println('IPv4 Route Table');
    this.println('===========================================================================');
    this.println('Active Routes:');
    this.println('Network Destination        Netmask          Gateway       Interface  Metric');
    const me = h.nic.v4[0] ? formatIPv4(h.nic.v4[0].addr) : '';
    for (const r of h.stack.routes4()) {
      const gw = r.nextHop !== undefined ? formatIPv4(r.nextHop) : 'On-link';
      this.println(`${formatIPv4(r.net).padStart(18)}${formatIPv4(prefixToMask(r.prefix)).padStart(18)}${gw.padStart(17)}${me.padStart(16)}${String(r.prefix === 0 ? 25 : 281).padStart(7)}`);
    }
    this.println('===========================================================================\n');
  }

  private netsh(rest: string[]) {
    // netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0 192.168.1.1
    const low = rest.map((r) => r.toLowerCase());
    const isSet = low[0]?.startsWith('int') && (low[1] === 'ip' || low[1] === 'ipv4') && low[2] === 'set' && low[3] === 'address';
    if (!isSet) {
      this.println('\nO simulador implementa:\n  netsh interface ip set address "Ethernet" static IP MÁSCARA [GATEWAY]\n  netsh interface ip set address "Ethernet" dhcp\n  netsh interface ip set dns "Ethernet" static IP\n');
      return;
    }
    let i = 4;
    if (low[i]?.startsWith('name=')) i++;
    else if (low[i] === 'ethernet' || low[i] === '"ethernet"') i++;
    else {
      this.println('The filename, directory name, or volume label syntax is incorrect.\n');
      return;
    }
    const h = this.host;
    const mode = low[i]?.replace('source=', '');
    if (mode === 'dhcp') {
      h.applyConfig({ ...h.cfg, ipv4: { mode: 'dhcp' } });
      this.println('');
      return;
    }
    if (mode !== 'static') {
      this.println('The syntax supplied for this command is not valid. Check help for the correct syntax.\n');
      return;
    }
    const ip = rest[i + 1];
    const mask = rest[i + 2];
    const gw = rest[i + 3];
    const ipN = parseIPv4(ip ?? '');
    const maskN = parseIPv4(mask ?? '');
    if (ipN === null || maskN === null || maskToPrefix(maskN) === null || (gw && parseIPv4(gw) === null)) {
      this.println('The parameter is incorrect.\n');
      return;
    }
    h.applyConfig({ ...h.cfg, ipv4: { mode: 'static', addr: ip, mask, gateway: gw, dns: h.cfg.ipv4.dns } });
    this.println('');
  }

  private nslookup(rest: string[]) {
    const dns = this.host.nic.dhcp?.lease?.dns ?? this.host.stack.dnsServers;
    if (!dns.length) {
      this.println('*** Default servers are not available\nServer:  UnKnown\nAddress:  127.0.0.1\n');
      return;
    }
    this.println(`DNS request timed out.\n    timeout was 2 seconds.\nServer:  UnKnown\nAddress:  ${formatIPv4(dns[0])}\n`);
    if (rest[0]) this.println(`*** Request to UnKnown timed-out\n`);
  }
}
