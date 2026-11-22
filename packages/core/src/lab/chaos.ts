/**
 * Chaos engineering for troubleshooting practice: the instructor injects a random fault;
 * the description stays hidden from students until revealed.
 */
import type { Lab } from './lab';
import { IosDevice } from '../devices/ios';
import { Host } from '../devices/host';
import { formatIPv4, prefixToMask } from '../net/ipv4';

export interface Fault {
  id: string;
  kind: string;
  /** Hidden explanation for the instructor. */
  description: string;
  /** Hint that may be shown to students. */
  hint: string;
  revert: () => void;
}

type Generator = (lab: Lab, pick: <T>(a: T[]) => T) => Omit<Fault, 'id'> | null;

const generators: Generator[] = [
  // Broken cable.
  (lab, pick) => {
    const links = [...lab.sim.links.values()].filter((l) => !l.failed);
    if (!links.length) return null;
    const l = pick(links);
    l.failed = true;
    lab.sim.linkChanged(l);
    return {
      kind: 'cable',
      description: `Cabo rompido entre ${l.a.device.name} ${l.a.short} e ${l.b.device.name} ${l.b.short}`,
      hint: 'Algum problema na camada física.',
      revert: () => {
        l.failed = false;
        lab.sim.linkChanged(l);
      },
    };
  },
  // Interface shut down.
  (lab, pick) => {
    const cands: [IosDevice, string][] = [];
    for (const d of lab.sim.devices.values())
      if (d instanceof IosDevice) for (const i of d.ifs) if (i.kind === 'physical' && i.port?.link && !i.shutdown) cands.push([d, i.name]);
    if (!cands.length) return null;
    const [d, name] = pick(cands);
    const i = d.findIf(name)!;
    d.setShutdown(i, true);
    return {
      kind: 'shutdown',
      description: `Interface ${name} de ${d.name} foi desativada (shutdown)`,
      hint: 'Verifique o estado das interfaces (show ip interface brief).',
      revert: () => d.setShutdown(i, false),
    };
  },
  // Access port moved to the wrong VLAN.
  (lab, pick) => {
    const cands: [IosDevice, number][] = [];
    for (const d of lab.sim.devices.values()) {
      if (!(d instanceof IosDevice) || !d.bridge) continue;
      for (const bp of d.bridge.ports) if (!bp.routed && !bp.trunk && bp.port.link && bp.port.peer()?.device instanceof Host) cands.push([d, bp.index]);
    }
    if (!cands.length) return null;
    const [d, idx] = pick(cands);
    const bp = d.bridge!.ports[idx];
    const old = bp.cfg.accessVlan;
    const wrong = [...d.bridge!.vlans.keys()].find((v) => v !== old && v < 1002) ?? 999;
    if (!d.bridge!.vlans.has(wrong)) d.bridge!.vlans.set(wrong, { id: wrong, name: `VLAN${String(wrong).padStart(4, '0')}` });
    bp.cfg.accessVlan = wrong;
    d.bridge!.flushPort(bp);
    d.syncState();
    return {
      kind: 'vlan',
      description: `Porta ${bp.port.name} de ${d.name} movida da VLAN ${old} para a VLAN ${wrong}`,
      hint: 'Um host perdeu a comunicação com a sua rede local.',
      revert: () => {
        bp.cfg.accessVlan = old;
        d.bridge!.flushPort(bp);
        d.syncState();
      },
    };
  },
  // Wrong default gateway on a static host.
  (lab, pick) => {
    const hosts = [...lab.sim.devices.values()].filter((d): d is Host => d instanceof Host && d.cfg.ipv4.mode === 'static' && !!d.cfg.ipv4.gateway);
    if (!hosts.length) return null;
    const h = pick(hosts);
    const old = structuredClone(h.cfg);
    const gw = h.cfg.ipv4.gateway!.split('.');
    gw[3] = gw[3] === '254' ? '253' : '254';
    h.applyConfig({ ...h.cfg, ipv4: { ...h.cfg.ipv4, gateway: gw.join('.') } });
    return {
      kind: 'gateway',
      description: `Gateway padrão de ${h.name} alterado de ${old.ipv4.gateway} para ${gw.join('.')}`,
      hint: 'Um host conversa com a rede local, mas não com outras redes.',
      revert: () => h.applyConfig(old),
    };
  },
  // Wrong subnet mask on a static host.
  (lab, pick) => {
    const hosts = [...lab.sim.devices.values()].filter((d): d is Host => d instanceof Host && d.cfg.ipv4.mode === 'static' && !!d.cfg.ipv4.mask);
    if (!hosts.length) return null;
    const h = pick(hosts);
    const old = structuredClone(h.cfg);
    const mask = formatIPv4(prefixToMask(30));
    h.applyConfig({ ...h.cfg, ipv4: { ...h.cfg.ipv4, mask } });
    return {
      kind: 'mask',
      description: `Máscara de ${h.name} alterada de ${old.ipv4.mask} para ${mask}`,
      hint: 'Verifique o endereçamento IP dos hosts.',
      revert: () => h.applyConfig(old),
    };
  },
  // Static route removed.
  (lab, pick) => {
    const routers = [...lab.sim.devices.values()].filter((d): d is IosDevice => d instanceof IosDevice && d.stack.statics4.length > 0);
    if (!routers.length) return null;
    const r = pick(routers);
    const route = pick(r.stack.statics4);
    r.stack.statics4 = r.stack.statics4.filter((x) => x !== route);
    return {
      kind: 'route',
      description: `Rota estática para ${formatIPv4(route.net)}/${route.prefix} removida de ${r.name}`,
      hint: 'Verifique as tabelas de roteamento (show ip route).',
      revert: () => r.stack.statics4.push(route),
    };
  },
];

export function injectFault(lab: Lab, id: string, kind?: string): Fault | null {
  const rng = lab.sim.rng;
  const pick = <T>(a: T[]) => a[Math.floor(rng() * a.length)];
  const order = [...generators.keys()].sort(() => rng() - 0.5);
  for (const k of order) {
    const g = generators[k];
    const f = g(lab, pick);
    if (f && (!kind || f.kind === kind)) return { id, ...f };
    if (f && kind) f.revert();
  }
  return null;
}
