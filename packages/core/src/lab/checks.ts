/**
 * Behaviour-based grading: the lab is rebuilt from its document in an isolated simulator,
 * time is advanced until protocols converge (STP, DHCP, SLAAC) and each objective is
 * tested by observing the network (e.g. "does PC1 reach 8.8.8.8?"). Any correct solution
 * passes, regardless of the exact commands typed.
 */
import { Lab, type LabDoc, type Objective } from './lab';
import { IosDevice } from '../devices/ios';
import { Host } from '../devices/host';
import { parseIPv4 } from '../net/ipv4';
import { parseIPv6 } from '../net/ipv6';
import type { EchoResult, IpStack } from '../l3/stack';

export interface CheckResult {
  id: string;
  title: string;
  ok: boolean;
  points: number;
  detail: string;
}

/** Virtual time allowed for convergence before testing (STP needs 30 s, DHCP retries with backoff). */
export const WARMUP_MS = 90_000;

function stackOf(lab: Lab, id: string): IpStack | undefined {
  const d = lab.device(id);
  if (d instanceof IosDevice || d instanceof Host) return d.stack;
  return undefined;
}

function pingOnce(lab: Lab, st: IpStack, to: string, seq: number): EchoResult {
  let result: EchoResult = { type: 'timeout' };
  let done = false;
  const v4 = parseIPv4(to);
  const cb = (r: EchoResult) => {
    result = r;
    done = true;
  };
  if (v4 !== null) st.echo4(v4, { seq, timeout: 2000 }, cb);
  else {
    const v6 = parseIPv6(to);
    if (v6 === null) return { type: 'local-error', reason: 'no-route' };
    st.echo6(v6, { seq, timeout: 2000 }, cb);
  }
  const limit = lab.sim.now + 2500;
  while (!done && lab.sim.now < limit) lab.sim.advance(50);
  return result;
}

function runOne(lab: Lab, o: Objective): CheckResult {
  const base = { id: o.id, title: o.title, points: o.points };
  const c = o.check;
  const nameOf = (id: string) => lab.device(id)?.name ?? id;
  switch (c.kind) {
    case 'ping': {
      const st = stackOf(lab, c.from);
      if (!st) return { ...base, ok: false, detail: `Equipamento ${c.from} não encontrado` };
      let success = false;
      let last: EchoResult = { type: 'timeout' };
      for (let i = 0; i < 4 && !success; i++) {
        last = pingOnce(lab, st, c.to, 9000 + i);
        success = last.type === 'reply';
      }
      const ok = c.expect === 'success' ? success : !success;
      const detail = success ? `${nameOf(c.from)} alcançou ${c.to}` : `${nameOf(c.from)} não alcançou ${c.to} (${last.type})`;
      return { ...base, ok, detail };
    }
    case 'dhcp': {
      const d = lab.device(c.device);
      if (!(d instanceof Host)) return { ...base, ok: false, detail: 'O objetivo exige um host' };
      const ok = d.nic.dhcp?.state === 'bound';
      return { ...base, ok, detail: ok ? `${d.name} obteve ${d.summary()}` : `${d.name} não obteve endereço por DHCP` };
    }
    case 'config': {
      const d = lab.device(c.device);
      if (!d) return { ...base, ok: false, detail: 'Equipamento não encontrado' };
      const text = d.exportState().running;
      let found = false;
      try {
        found = new RegExp(c.pattern, 'm').test(text);
      } catch {
        return { ...base, ok: false, detail: 'Expressão regular inválida no objetivo' };
      }
      const ok = c.expect ? found : !found;
      return { ...base, ok, detail: ok ? 'Configuração conforme' : 'Configuração não encontrada' };
    }
  }
}

export function gradeLab(doc: LabDoc): { results: CheckResult[]; score: number; total: number } {
  const lab = new Lab(structuredClone(doc));
  lab.sim.advance(WARMUP_MS);
  const results = doc.objectives.map((o) => runOne(lab, o));
  const total = results.reduce((a, r) => a + r.points, 0);
  const score = results.filter((r) => r.ok).reduce((a, r) => a + r.points, 0);
  return { results, score, total };
}
