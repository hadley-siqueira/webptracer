import { describe, expect, it } from 'vitest';
import { Lab, BufferTerminal, IosDevice, Host, frameBytes, buildPcap } from '../src';

function session(lab: Lab, dev: { id: string }) {
  const d = lab.device(dev.id)!;
  const t = new BufferTerminal();
  const s = d.openSession(t);
  s.line('');
  t.take();
  return {
    run(...lines: string[]) {
      for (const l of lines) {
        s.line(l);
        let guard = 0;
        while (s.busy && guard++ < 2000) lab.sim.advance(100);
      }
      return t.take();
    },
    help: (p: string) => s.help(p),
    complete: (p: string) => s.complete(p),
    get prompt() {
      return t.prompt;
    },
  };
}

function twoRouters() {
  const lab = new Lab();
  const r1 = lab.addDevice('CISCO1941/K9', 0, 0) as IosDevice;
  const r2 = lab.addDevice('CISCO1941/K9', 100, 0) as IosDevice;
  lab.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  r1.loadConfig('interface Gi0/0\n ip address 10.0.0.1 255.255.255.252\n no shutdown\n', false);
  r2.loadConfig('interface Gi0/0\n ip address 10.0.0.2 255.255.255.252\n no shutdown\n', false);
  lab.sim.advance(3000);
  return { lab, r1, r2 };
}

describe('IOS CLI', () => {
  it('supports abbreviations, help and IOS error messages', () => {
    const { lab, r1 } = twoRouters();
    const s = session(lab, r1);
    expect(s.run('en')).toBe('');
    expect(s.prompt).toBe('R1#');
    expect(s.run('conf t')).toContain('Enter configuration commands');
    expect(s.prompt).toBe('R1(config)#');
    expect(s.run('int g0/1')).toBe('');
    expect(s.prompt).toBe('R1(config-if)#');
    expect(s.run('ip adress 1.1.1.1 255.0.0.0')).toContain("% Invalid input detected at '^' marker.");
    expect(s.run('ip address 1.1.1.1')).toContain('% Incomplete command.');
    // Global command from interface mode falls back to config mode.
    s.run('hostname EDGE');
    expect(s.prompt).toBe('EDGE(config)#');
    expect(s.help('ip ro')).toContain('route');
    expect(s.help('show ')).toContain('Invalid input');
    expect(s.complete('sh')).toBe('sh');
    s.run('end');
    expect(s.help('show ip ')).toContain('route');
    expect(s.complete('sh')).toBe('show ');
    expect(s.run('do show version')).toContain('Invalid input');
  });

  it('first ping loses one packet while ARP resolves (.!!!!)', () => {
    const { lab, r1 } = twoRouters();
    const s = session(lab, r1);
    const out = s.run('ping 10.0.0.2');
    expect(out).toContain('.!!!!');
    expect(out).toContain('Success rate is 80 percent (4/5)');
    expect(s.run('ping 10.0.0.2')).toContain('!!!!!');
  });

  it('round-trips running-config through replay', () => {
    const { lab, r1 } = twoRouters();
    const s = session(lab, r1);
    s.run('en', 'conf t', 'ip route 192.168.0.0 255.255.0.0 10.0.0.2', 'access-list 10 permit 192.168.1.0 0.0.0.255', 'ip access-list extended WEB', 'permit tcp any host 10.0.0.2 eq 80', 'deny ip any any log', 'exit', 'banner motd #Bem-vindo#', 'enable secret cisco', 'service password-encryption', 'line con 0', 'password segredo', 'login', 'end');
    const a = r1.runningConfig();
    expect(a).toContain('ip route 192.168.0.0 255.255.0.0 10.0.0.2');
    expect(a).toContain(' permit tcp any host 10.0.0.2 eq www');
    expect(a).toMatch(/ password 7 [0-9A-F]+/);
    r1.loadConfig(a, true);
    expect(r1.runningConfig()).toBe(a);
  });

  it('extended ACL blocks traffic and counts matches', () => {
    const { lab, r1, r2 } = twoRouters();
    const s2 = session(lab, r2);
    s2.run('en', 'conf t', 'access-list 101 deny icmp host 10.0.0.1 any', 'access-list 101 permit ip any any', 'int g0/0', 'ip access-group 101 in', 'end');
    const s1 = session(lab, r1);
    expect(s1.run('ping 10.0.0.2')).toContain('Success rate is 0 percent');
    expect(s2.run('show access-lists')).toMatch(/10 deny icmp host 10\.0\.0\.1 any \(\d+ match/);
  });
});

describe('switching', () => {
  it('STP blocks one port of a triangle and the network still works', () => {
    const lab = new Lab();
    const sw = [0, 1, 2].map((i) => lab.addDevice('WS-C2960-24TT-L', i * 100, 0) as IosDevice);
    lab.connect(sw[0].id, 'Gi0/1', sw[1].id, 'Gi0/1');
    lab.connect(sw[1].id, 'Gi0/2', sw[2].id, 'Gi0/2');
    lab.connect(sw[2].id, 'Gi0/1', sw[0].id, 'Gi0/2');
    lab.sim.advance(60_000);
    const blocked = sw.flatMap((d) => d.bridge!.ports.filter((p) => p.port.isUp() && p.state === 'blocking'));
    expect(blocked).toHaveLength(1);
    const roots = sw.filter((d) => d.bridge!.isRoot());
    expect(roots).toHaveLength(1);
    // No storm: frame count stays bounded.
    const before = lab.sim.eventsProcessed;
    lab.sim.advance(10_000);
    expect(lab.sim.eventsProcessed - before).toBeLessThan(500);
  });

  it('BPDU Guard err-disables a PortFast port that receives BPDUs', () => {
    const lab = new Lab();
    const a = lab.addDevice('WS-C2960-24TT-L', 0, 0) as IosDevice;
    const b = lab.addDevice('WS-C2960-24TT-L', 100, 0) as IosDevice;
    a.loadConfig('interface Fa0/1\n switchport mode access\n spanning-tree portfast\n spanning-tree bpduguard enable\n', true);
    lab.connect(a.id, 'Fa0/1', b.id, 'Fa0/1');
    lab.sim.advance(5000);
    expect(a.port('Fa0/1')!.errDisabled).toBe('bpduguard');
    const s = session(lab, a);
    expect(s.run('en', 'show interfaces status')).toMatch(/Fa0\/1\s+err-disabled/);
  });

  it('hosts in different VLANs cannot talk without a router', () => {
    const lab = new Lab();
    const sw = lab.addDevice('WS-C2960-24TT-L', 0, 0) as IosDevice;
    const p1 = lab.addDevice('PC-WIN11', 0, 0) as Host;
    const p2 = lab.addDevice('PC-UBUNTU', 0, 0) as Host;
    lab.connect(sw.id, 'Fa0/1', p1.id, 'Ethernet');
    lab.connect(sw.id, 'Fa0/2', p2.id, 'eth0');
    p1.applyConfig({ hostname: 'P1', ipv4: { mode: 'static', addr: '10.1.1.1', mask: '255.255.255.0' }, ipv6: { mode: 'off' } });
    p2.applyConfig({ hostname: 'P2', ipv4: { mode: 'static', addr: '10.1.1.2', mask: '255.255.255.0' }, ipv6: { mode: 'off' } });
    lab.sim.advance(35_000);
    const s = session(lab, p1);
    expect(s.run('ping -n 2 10.1.1.2')).toContain('Reply from 10.1.1.2: bytes=32');
    sw.loadConfig('vlan 20\ninterface Fa0/2\n switchport access vlan 20\n', false);
    lab.sim.advance(1000);
    s.run('arp -d');
    expect(s.run('ping -n 2 10.1.1.2')).toContain('Destination host unreachable');
  });
});

describe('wire format', () => {
  it('serializes frames with valid sizes and a pcap header', () => {
    const { lab, r1 } = twoRouters();
    const frames: { time: number; frame: Parameters<typeof frameBytes>[0] }[] = [];
    lab.sim.on({ trace: (e) => frames.push({ time: e.time, frame: e.frame }) });
    session(lab, r1).run('ping 10.0.0.2');
    expect(frames.length).toBeGreaterThan(5);
    for (const f of frames) expect(frameBytes(f.frame).length).toBeGreaterThanOrEqual(60);
    const pcap = buildPcap(frames);
    expect([...pcap.slice(0, 4)]).toEqual([0xd4, 0xc3, 0xb2, 0xa1]);
  });
});
