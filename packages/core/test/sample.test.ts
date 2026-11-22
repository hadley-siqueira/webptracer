import { describe, expect, it } from 'vitest';
import { gradeLab, sampleLab, Lab, BufferTerminal, IosDevice, Host } from '../src';

function run(lab: Lab, id: string, lines: string[], wait = 15_000): string {
  const dev = lab.device(id)!;
  const t = new BufferTerminal();
  const s = dev.openSession(t);
  s.line('');
  for (const l of lines) {
    s.line(l);
    let guard = 0;
    while (s.busy && guard++ < 1000) lab.sim.advance(100);
  }
  lab.sim.advance(wait > 0 ? 10 : 0);
  return t.take();
}

describe('sample lab', () => {
  it('passes all objectives', () => {
    const doc = sampleLab();
    const r = gradeLab(doc);
    for (const x of r.results) expect(x, x.title + ' — ' + x.detail).toMatchObject({ ok: true });
  });

  it('shows realistic IOS output', () => {
    const lab = new Lab(sampleLab());
    lab.sim.advance(90_000);
    const pc1 = [...lab.sim.devices.values()].find((d) => d.name === 'PC1') as Host;
    const out = run(lab, pc1.id, ['ipconfig', 'ping 203.0.113.10']);
    expect(out).toContain('IPv4 Address. . . . . . . . . . . : 192.168.10.');
    expect(out).toContain('Reply from 203.0.113.10');
    const r1 = [...lab.sim.devices.values()].find((d) => d.name === 'R1') as IosDevice;
    const o = run(lab, r1.id, ['enable', 'class', 'show ip nat translations', 'show ip route', 'show ip interface brief']);
    expect(o).toContain('icmp 209.165.200.226');
    expect(o).toContain('S*    0.0.0.0/0 [1/0] via 209.165.200.225');
    expect(o).toMatch(/GigabitEthernet0\/0\/0\.10\s+192\.168\.10\.1\s+YES manual up\s+up/);
    const sw = [...lab.sim.devices.values()].find((d) => d.name === 'SW1') as IosDevice;
    const so = run(lab, sw.id, ['en', 'show vlan brief', 'show interfaces trunk', 'show spanning-tree', 'sh mac address-table']);
    expect(so).toMatch(/10\s+ALUNOS\s+active\s+Fa0\/1, Fa0\/2/);
    expect(so).toContain('Gi0/1       on               802.1q         trunking      1');
    expect(so).toContain('This bridge is the root');
  });
});
