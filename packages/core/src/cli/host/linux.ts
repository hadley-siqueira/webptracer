/** Ubuntu bash subset: ip, ifconfig, ping, traceroute, arp, dhclient, hostname... */
import { HostShell } from './base';
import { broadcastOf, formatIPv4, parseCidr4, parseIPv4, prefixToMask, networkOf } from '../../net/ipv4';
import { formatIPv6, parseIPv6 } from '../../net/ipv6';
import type { EchoResult } from '../../l3/stack';

export class LinuxShell extends HostShell {
  private user = 'aluno';

  prompt() {
    const root = this.user === 'root';
    return `\x1b[1;32m${this.user}@${this.host.cfg.hostname}\x1b[0m:\x1b[1;34m${root ? '/root' : '~'}\x1b[0m${root ? '#' : '$'} `;
  }

  protected banner() {
    return `Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-49-generic x86_64)\n\n * Documentation:  https://help.ubuntu.com\n\nDigite "help" para ver os comandos simulados.\n\n`;
  }

  protected commands() {
    return ['ip', 'ifconfig', 'ping', 'ping6', 'traceroute', 'arp', 'dhclient', 'hostname', 'clear', 'whoami', 'sudo', 'uname', 'help', 'exit', 'cat', 'route', 'ip neigh'];
  }

  protected run(args: string[], line: string) {
    if (args[0] === 'sudo') {
      if (args[1] === '-i' || args[1] === 'su') {
        this.user = 'root';
        return;
      }
      args = args.slice(1);
      if (!args.length) {
        this.println('usage: sudo -h | -K | -k | -V');
        return;
      }
    }
    const root = this.user === 'root' || line.startsWith('sudo');
    const cmd = args[0];
    const rest = args.slice(1);
    switch (cmd) {
      case 'ip':
        return this.ip(rest, root);
      case 'ifconfig':
        return this.ifconfig(rest);
      case 'ping':
        return this.ping(rest, false);
      case 'ping6':
        return this.ping(rest, true);
      case 'traceroute':
        return this.traceroute(rest);
      case 'arp':
        return this.arp();
      case 'route':
        return this.routeCmd();
      case 'dhclient':
        return this.dhclient(rest, root);
      case 'hostname':
        this.println(this.host.cfg.hostname);
        return;
      case 'whoami':
        this.println(this.user);
        return;
      case 'uname':
        this.println(rest.includes('-a') ? `Linux ${this.host.cfg.hostname} 6.8.0-49-generic #49-Ubuntu SMP PREEMPT_DYNAMIC x86_64 x86_64 x86_64 GNU/Linux` : 'Linux');
        return;
      case 'clear':
        this.out('\x1b[2J\x1b[H');
        return;
      case 'cat':
        if (rest[0] === '/etc/resolv.conf') {
          const dns = this.host.nic.dhcp?.lease?.dns ?? this.host.stack.dnsServers;
          this.println('# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).');
          this.println('nameserver 127.0.0.53\noptions edns0 trust-ad');
          if (dns.length) this.println(`# upstream: ${dns.map(formatIPv4).join(' ')}`);
          return;
        }
        if (rest[0] === '/etc/hostname') {
          this.println(this.host.cfg.hostname);
          return;
        }
        this.println(`cat: ${rest[0] ?? ''}: No such file or directory`);
        return;
      case 'exit':
      case 'logout':
        if (this.user === 'root') {
          this.user = 'aluno';
          this.println('logout');
          return;
        }
        this.out('\x1b[2J\x1b[H');
        this.start();
        return;
      case 'help':
        this.println(`Comandos simulados:
  ip addr|a [show]                 ip link [set eth0 up|down]
  ip addr add|del A.B.C.D/NN dev eth0    ip addr flush dev eth0
  ip route|r [show]                ip route add default via A.B.C.D
  ip -6 addr | ip -6 route         ip neigh
  ifconfig [eth0]                  ping [-c N] [-6] destino   (Ctrl+C para parar)
  traceroute destino               arp -n
  dhclient [-r] eth0               hostname, whoami, uname -a, clear, sudo -i`);
        return;
      default:
        this.println(`${cmd}: command not found`);
    }
  }

  private needRoot(root: boolean): boolean {
    if (!root) this.println('RTNETLINK answers: Operation not permitted');
    return root;
  }

  // ------------------------------------------------------------------ ip

  private ip(rest: string[], root: boolean) {
    let six = false;
    let four = false;
    const a = rest.filter((x) => {
      if (x === '-6') six = true;
      else if (x === '-4') four = true;
      else return true;
      return false;
    });
    const obj = a[0] ?? '';
    const sub = a[1] ?? 'show';
    const h = this.host;
    const match = (word: string, full: string) => word.length > 0 && full.startsWith(word);
    if (match(obj, 'address') || obj === 'a') {
      if (match(sub, 'show') || sub === 'list') return this.ipAddrShow(six, four);
      if (sub === 'add' || sub === 'del') {
        if (!this.needRoot(root)) return;
        const c = parseCidr4(a[2] ?? '');
        if (!c || a[3] !== 'dev' || a[4] !== h.nic.name) {
          this.println(`Error: either "local" is duplicate, or "${a[2] ?? ''}" is a garbage.`);
          return;
        }
        const cfg = structuredClone(h.cfg);
        if (sub === 'add') {
          if (h.nic.v4.some((x) => x.addr === c.addr)) {
            this.println('RTNETLINK answers: File exists');
            return;
          }
          cfg.ipv4 = { mode: 'static', addr: formatIPv4(c.addr), mask: formatIPv4(prefixToMask(c.prefix)), gateway: cfg.ipv4.mode === 'static' ? cfg.ipv4.gateway : undefined };
        } else cfg.ipv4 = { mode: 'static' };
        h.applyConfig(cfg);
        return;
      }
      if (sub === 'flush') {
        if (!this.needRoot(root)) return;
        h.applyConfig({ ...h.cfg, ipv4: { mode: 'static' } });
        return;
      }
    }
    if (match(obj, 'link') || obj === 'l') {
      if (sub === 'set') {
        if (!this.needRoot(root)) return;
        if (a[2] !== h.nic.name) {
          this.println(`Cannot find device "${a[2] ?? ''}"`);
          return;
        }
        h.setNicEnabled(a[3] === 'up');
        return;
      }
      return this.ipLinkShow();
    }
    if (match(obj, 'route') || obj === 'r') {
      if (sub === 'add' || sub === 'del' || sub === 'replace') {
        if (!this.needRoot(root)) return;
        const dest = a[2];
        const via = a[3] === 'via' ? parseIPv4(a[4] ?? '') : null;
        if (dest === 'default' && via !== null) {
          const cfg = structuredClone(h.cfg);
          if (cfg.ipv4.mode !== 'static') {
            cfg.ipv4 = { mode: 'static', addr: h.nic.v4[0] ? formatIPv4(h.nic.v4[0].addr) : undefined, mask: h.nic.v4[0] ? formatIPv4(prefixToMask(h.nic.v4[0].prefix)) : undefined };
          }
          cfg.ipv4.gateway = sub === 'del' ? undefined : formatIPv4(via);
          h.applyConfig(cfg);
          return;
        }
        if (dest === 'default' && sub === 'del') {
          h.applyConfig({ ...h.cfg, ipv4: { ...h.cfg.ipv4, gateway: undefined } });
          return;
        }
        const c = parseCidr4(dest ?? '');
        if (c && via !== null) {
          const st = h.stack;
          if (sub === 'del') st.statics4 = st.statics4.filter((r) => !(r.net === networkOf(c.addr, c.prefix) && r.prefix === c.prefix));
          else st.statics4.push({ net: networkOf(c.addr, c.prefix), prefix: c.prefix, nextHop: via, ad: 1 });
          return;
        }
        this.println('Error: any valid prefix is expected rather than "' + (dest ?? '') + '".');
        return;
      }
      return six ? this.ipRoute6() : this.ipRoute4();
    }
    if (match(obj, 'neighbour') || match(obj, 'neighbor') || obj === 'n') {
      for (const e of h.stack.arpEntries()) {
        this.println(`${formatIPv4(e.ip)} dev ${h.nic.name} ${e.mac ? `lladdr ${e.mac} REACHABLE` : 'INCOMPLETE'}`);
      }
      for (const n of h.stack.neighborEntries()) this.println(`${formatIPv6(n.ip)} dev ${h.nic.name} lladdr ${n.mac} ${n.router ? 'router ' : ''}REACHABLE`);
      return;
    }
    this.println(`Object "${obj}" is unknown, try "ip help".`);
  }

  private flags(): string {
    const h = this.host;
    if (h.nicDisabled) return '<BROADCAST,MULTICAST> mtu 1500 qdisc fq_codel state DOWN';
    if (!h.ports[0].isUp()) return '<NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc fq_codel state DOWN';
    return '<BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP';
  }

  private ipLinkShow() {
    const h = this.host;
    this.println('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000');
    this.println('    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00');
    this.println(`2: ${h.nic.name}: ${this.flags()} mode DEFAULT group default qlen 1000`);
    this.println(`    link/ether ${h.nic.mac} brd ff:ff:ff:ff:ff:ff`);
  }

  private ipAddrShow(six: boolean, four: boolean) {
    const h = this.host;
    const nic = h.nic;
    const v4 = !six;
    const v6 = !four;
    this.println('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000');
    if (!six && !four) this.println('    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00');
    if (v4) this.println('    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever');
    if (v6) this.println('    inet6 ::1/128 scope host noprefixroute \n       valid_lft forever preferred_lft forever');
    this.println(`2: ${nic.name}: ${this.flags()} group default qlen 1000`);
    if (!six && !four) this.println(`    link/ether ${nic.mac} brd ff:ff:ff:ff:ff:ff`);
    if (v4) {
      for (const a of nic.v4) {
        const dyn = a.source === 'dhcp' ? ' dynamic' : '';
        this.println(`    inet ${formatIPv4(a.addr)}/${a.prefix} brd ${formatIPv4(broadcastOf(a.addr, a.prefix))} scope global${dyn} ${nic.name}`);
        const lease = nic.dhcp?.lease;
        if (lease && a.source === 'dhcp') {
          const left = Math.max(0, Math.round((lease.expires - h.simulator.now) / 1000));
          this.println(`       valid_lft ${left}sec preferred_lft ${left}sec`);
        } else this.println('       valid_lft forever preferred_lft forever');
      }
    }
    if (v6 && nic.v6Enabled && !h.nicDisabled) {
      for (const a of [...nic.v6].sort((x) => (x.source === 'linklocal' ? 1 : -1))) {
        if (a.source === 'linklocal') this.println(`    inet6 ${formatIPv6(a.addr)}/64 scope link \n       valid_lft forever preferred_lft forever`);
        else if (a.source === 'slaac') this.println(`    inet6 ${formatIPv6(a.addr)}/${a.prefix} scope global dynamic mngtmpaddr noprefixroute \n       valid_lft 2591998sec preferred_lft 604798sec`);
        else this.println(`    inet6 ${formatIPv6(a.addr)}/${a.prefix} scope global \n       valid_lft forever preferred_lft forever`);
      }
    }
  }

  private ipRoute4() {
    const h = this.host;
    for (const r of h.stack.routes4()) {
      if (r.code === 'L') continue;
      if (r.prefix === 0) this.println(`default via ${formatIPv4(r.nextHop!)} dev ${h.nic.name} proto ${h.nic.dhcp ? 'dhcp' : 'static'} metric 100 `);
      else if (r.code === 'C') this.println(`${formatIPv4(r.net)}/${r.prefix} dev ${h.nic.name} proto kernel scope link src ${formatIPv4(h.nic.v4[0]?.addr ?? 0)} metric 100 `);
      else this.println(`${formatIPv4(r.net)}/${r.prefix} via ${formatIPv4(r.nextHop!)} dev ${h.nic.name} `);
    }
  }

  private ipRoute6() {
    const h = this.host;
    for (const r of h.stack.routes6()) {
      if (r.code === 'L') continue;
      if (r.prefix === 0) this.println(`default via ${formatIPv6(r.nextHop!)} dev ${h.nic.name} proto ra metric 100 expires 1798sec pref medium`);
      else this.println(`${formatIPv6(r.net)}/${r.prefix} dev ${h.nic.name} proto kernel metric 256 pref medium`);
    }
    if (h.nic.v6Enabled) this.println(`fe80::/64 dev ${h.nic.name} proto kernel metric 256 pref medium`);
  }

  private ifconfig(rest: string[]) {
    const h = this.host;
    const nic = h.nic;
    if (rest[0] && rest[0] !== nic.name && rest[0] !== 'lo' && rest[0] !== '-a') {
      this.println(`${rest[0]}: error fetching interface information: Device not found`);
      return;
    }
    const up = nic.isUp();
    this.println(`${nic.name}: flags=${up ? '4163<UP,BROADCAST,RUNNING,MULTICAST>' : '4099<UP,BROADCAST,MULTICAST>'}  mtu 1500`);
    for (const a of nic.v4) this.println(`        inet ${formatIPv4(a.addr)}  netmask ${formatIPv4(prefixToMask(a.prefix))}  broadcast ${formatIPv4(broadcastOf(a.addr, a.prefix))}`);
    for (const a of nic.v6) this.println(`        inet6 ${formatIPv6(a.addr)}  prefixlen ${a.prefix}  scopeid ${a.source === 'linklocal' ? '0x20<link>' : '0x0<global>'}`);
    this.println(`        ether ${nic.mac}  txqueuelen 1000  (Ethernet)`);
    const p = h.ports[0];
    this.println(`        RX packets ${p.stats.rxFrames}  bytes ${p.stats.rxFrames * 64}`);
    this.println('        RX errors 0  dropped 0  overruns 0  frame 0');
    this.println(`        TX packets ${p.stats.txFrames}  bytes ${p.stats.txFrames * 64}`);
    this.println('        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0\n');
    if (!rest[0] || rest[0] === 'lo' || rest[0] === '-a') {
      this.println('lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536\n        inet 127.0.0.1  netmask 255.0.0.0\n        inet6 ::1  prefixlen 128  scopeid 0x10<host>\n        loop  txqueuelen 1000  (Local Loopback)\n');
    }
  }

  private arp() {
    const h = this.host;
    const entries = h.stack.arpEntries();
    this.println('Address                  HWtype  HWaddress           Flags Mask            Iface');
    for (const e of entries) {
      if (e.mac) this.println(`${formatIPv4(e.ip).padEnd(25)}ether   ${e.mac.padEnd(20)}C                     ${h.nic.name}`);
      else this.println(`${formatIPv4(e.ip).padEnd(25)}        (incomplete)                              ${h.nic.name}`);
    }
  }

  private routeCmd() {
    const h = this.host;
    this.println('Kernel IP routing table');
    this.println('Destination     Gateway         Genmask         Flags Metric Ref    Use Iface');
    for (const r of h.stack.routes4()) {
      if (r.code === 'L') continue;
      const gw = r.nextHop !== undefined ? formatIPv4(r.nextHop) : '0.0.0.0';
      const flags = r.nextHop !== undefined ? 'UG' : 'U';
      this.println(`${formatIPv4(r.net).padEnd(16)}${gw.padEnd(16)}${formatIPv4(prefixToMask(r.prefix)).padEnd(16)}${flags.padEnd(6)}100    0        0 ${h.nic.name}`);
    }
  }

  private dhclient(rest: string[], root: boolean) {
    const h = this.host;
    if (!root) {
      this.println('dhclient: Operation not permitted (are you root?)');
      return;
    }
    if (rest.includes('-r')) {
      if (h.nic.dhcp) h.stack.dhcpStop(h.nic, true);
      return;
    }
    if (h.cfg.ipv4.mode !== 'dhcp') h.cfg = { ...h.cfg, ipv4: { mode: 'dhcp' } };
    if (!h.nic.isUp()) {
      this.println('');
      return;
    }
    h.stack.dhcpStart(h.nic);
    let aborted = false;
    this.async(() => {
      aborted = true;
      this.out('^C\n');
      this.done();
    });
    const started = h.simulator.now;
    const wait = () => {
      if (aborted) return;
      if (h.nic.dhcp?.state === 'bound' || h.nic.dhcp?.state === 'failed' || h.simulator.now - started > 30_000) this.done();
      else h.timer(250, wait);
    };
    h.timer(250, wait);
  }

  // ------------------------------------------------------------------ ping / traceroute

  private ping(rest: string[], force6: boolean) {
    let count = Infinity;
    let target: string | undefined;
    let size = 56;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '-c') count = Number(rest[++i]);
      else if (a === '-s') size = Number(rest[++i]) || 56;
      else if (a === '-6') force6 = true;
      else if (a === '-4') force6 = false;
      else if (a.startsWith('-')) {
        this.println(`ping: invalid option -- '${a.slice(1)}'`);
        return;
      } else target = a;
    }
    if (!target) {
      this.println('ping: usage error: Destination address required');
      return;
    }
    if (!Number.isFinite(count) && count !== Infinity) count = Infinity;
    const v4 = force6 ? null : parseIPv4(target);
    const v6 = v4 === null ? parseIPv6(target) : null;
    if (v4 === null && v6 === null) {
      this.println(`ping: ${target}: Temporary failure in name resolution`);
      return;
    }
    const h = this.host;
    const label = v4 !== null ? formatIPv4(v4) : formatIPv6(v6!);
    if (v4 !== null && !h.stack.resolve4(v4) && !h.stack.ownsV4(v4)) {
      this.println('ping: connect: Network is unreachable');
      return;
    }
    if (v6 !== null && !h.stack.resolve6(v6) && !h.stack.ownsV6(v6) && !(v6 >> 118n === 0x3fan)) {
      this.println('ping: connect: Network is unreachable');
      return;
    }
    this.println(v4 !== null ? `PING ${label} (${label}) ${size}(${size + 28}) bytes of data.` : `PING ${label} (${label}) ${size} data bytes`);
    let sent = 0;
    let received = 0;
    let errors = 0;
    const rtts: number[] = [];
    let aborted = false;
    let finished = false;
    const start = h.simulator.now;
    const stats = () => {
      if (finished) return;
      finished = true;
      const lost = sent - received;
      this.println(`\n--- ${label} ping statistics ---`);
      this.println(`${sent} packets transmitted, ${received} received,${errors ? ` +${errors} errors,` : ''} ${sent ? Math.round((lost * 100) / sent) : 0}% packet loss, time ${Math.round(h.simulator.now - start)}ms`);
      if (rtts.length) {
        const min = Math.min(...rtts);
        const max = Math.max(...rtts);
        const avg = rtts.reduce((x, y) => x + y, 0) / rtts.length;
        const mdev = Math.sqrt(rtts.reduce((x, y) => x + (y - avg) ** 2, 0) / rtts.length);
        this.println(`rtt min/avg/max/mdev = ${min.toFixed(3)}/${avg.toFixed(3)}/${max.toFixed(3)}/${mdev.toFixed(3)} ms`);
      }
      this.done();
    };
    this.async(() => {
      aborted = true;
      this.out('^C');
      stats();
    });
    let outstanding = 0;
    const one = (seq: number) => {
      if (aborted) return;
      if (seq > count) {
        if (outstanding === 0) stats();
        return;
      }
      sent++;
      outstanding++;
      const cb = (r: EchoResult) => {
        outstanding--;
        if (aborted) return;
        if (r.type === 'reply') {
          received++;
          const rtt = r.rtt + 0.03 + (seq % 7) * 0.011;
          rtts.push(rtt);
          this.println(`${size + 8} bytes from ${label}: icmp_seq=${seq} ttl=${r.ttl} time=${rtt.toFixed(2)} ms`);
        } else if (r.type === 'unreachable' || r.type === 'ttl-exceeded') {
          errors++;
          const from = typeof r.from === 'bigint' ? formatIPv6(r.from) : formatIPv4(r.from as number);
          this.println(`From ${from} icmp_seq=${seq} ${r.type === 'ttl-exceeded' ? 'Time to live exceeded' : r.code === 13 ? 'Packet filtered' : r.code === 0 ? 'Destination Net Unreachable' : 'Destination Host Unreachable'}`);
        } else if (r.type === 'local-error') {
          errors++;
          const self = h.nic.v4[0] ? formatIPv4(h.nic.v4[0].addr) : label;
          this.println(`From ${self} icmp_seq=${seq} Destination Host Unreachable`);
        }
        if (seq >= count && outstanding === 0) stats();
      };
      if (v4 !== null) h.stack.echo4(v4, { seq, size, timeout: 10_000 }, cb);
      else h.stack.echo6(v6!, { seq, size, timeout: 10_000 }, cb);
      h.timer(1000, () => one(seq + 1));
    };
    one(1);
  }

  private traceroute(rest: string[]) {
    const target = rest.filter((r) => !r.startsWith('-'))[0];
    if (!target) {
      this.println('Usage:\n  traceroute [ -46dFITnreAUDV ] [ -f first_ttl ] [ -g gate,... ] [ -i device ] [ -m max_ttl ] host [ packetlen ]');
      return;
    }
    const v4 = parseIPv4(target);
    const v6 = v4 === null ? parseIPv6(target) : null;
    if (v4 === null && v6 === null) {
      this.println(`${target}: Name or service not known\nCannot handle "host" cmdline arg \`${target}' on position 1 (argc 1)`);
      return;
    }
    const h = this.host;
    const label = v4 !== null ? formatIPv4(v4) : formatIPv6(v6!);
    this.println(`traceroute to ${label} (${label}), 30 hops max, 60 byte packets`);
    let aborted = false;
    this.async(() => {
      aborted = true;
      this.out('^C\n');
      this.done();
    });
    const hop = (ttl: number) => {
      if (aborted) return;
      if (ttl > 30) return this.done();
      let line = `${String(ttl).padStart(2)} `;
      let from: string | null = null;
      let reached = false;
      const probe = (n: number) => {
        if (aborted) return;
        if (n === 3) {
          this.println(line);
          if (reached) this.done();
          else hop(ttl + 1);
          return;
        }
        const cb = (r: EchoResult) => {
          if (r.type === 'timeout' || r.type === 'local-error') line += ' *';
          else {
            const f = typeof r.from === 'bigint' ? formatIPv6(r.from) : formatIPv4(r.from as number);
            const isGw = h.stack.defaultGateway !== undefined && typeof r.from === 'number' && r.from === h.stack.defaultGateway;
            if (f !== from) {
              line += ` ${isGw ? '_gateway' : f} (${f})`;
              from = f;
            }
            const rtt = 'rtt' in r ? r.rtt + 0.1 + n * 0.05 : 0;
            line += `  ${rtt.toFixed(3)} ms`;
            if (r.type === 'unreachable') line += ' !H';
            if (r.type === 'port-unreachable' || r.type === 'unreachable') reached = true;
          }
          h.timer(0, () => probe(n + 1));
        };
        if (v4 !== null) h.stack.probe4(v4, ttl, 5000, cb);
        else h.stack.probe6(v6!, ttl, 5000, cb);
      };
      probe(0);
    };
    hop(1);
  }
}
