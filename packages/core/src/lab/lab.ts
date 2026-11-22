/**
 * A lab = topology (devices, links, positions) + device configurations + objectives.
 * The LabDoc is the persistent, versionable representation; Lab is the live simulation.
 */
import { Simulator, type CableType, type Link } from '../sim/engine';
import { getModel, MODELS, type HardwareModel } from '../devices/models';
import type { Device, DeviceState } from '../devices/device';
import { IosDevice } from '../devices/ios';
import { Host } from '../devices/host';
import { Hub } from '../devices/hub';
import type { Port } from '../devices/port';

export interface LabDevice {
  id: string;
  model: string;
  name: string;
  x: number;
  y: number;
  baseMac: string;
  powered: boolean;
  state: DeviceState;
  /** Position in the physical view: rack index and top rack unit. */
  rack?: { rack: number; u: number };
}

export interface LabLink {
  id: string;
  a: { device: string; port: string };
  b: { device: string; port: string };
  cable: CableType;
  failed?: boolean;
}

export type Check =
  | { kind: 'ping'; from: string; to: string; expect: 'success' | 'fail' }
  | { kind: 'dhcp'; device: string }
  | { kind: 'config'; device: string; pattern: string; expect: boolean };

export interface Objective {
  id: string;
  title: string;
  check: Check;
  points: number;
}

export interface LabDoc {
  version: 1;
  name: string;
  description: string;
  /** Instructions shown to students (markdown). */
  instructions: string;
  seed: number;
  devices: LabDevice[];
  links: LabLink[];
  objectives: Objective[];
  racks: { name: string; units: number }[];
}

export function emptyDoc(name = 'Novo laboratório'): LabDoc {
  return { version: 1, name, description: '', instructions: '', seed: 1, devices: [], links: [], objectives: [], racks: [{ name: 'Rack 1', units: 24 }] };
}

const NAME_PREFIX: Record<string, string> = { router: 'R', switch: 'SW', l3switch: 'MLS', hub: 'HUB', pc: 'PC', laptop: 'NB', server: 'SRV' };

function createDevice(model: HardwareModel, id: string, name: string, baseMac: string): Device {
  const init = { id, name, model, baseMac };
  if (model.os === 'ios' || model.os === 'iosxe') return new IosDevice(init);
  if (model.os === 'windows' || model.os === 'linux') return new Host(init);
  return new Hub(init);
}

/** Picks the cable a technician would use (like the "automatic connection" tool). */
export function autoCable(a: Port, b: Port): CableType {
  if (a.spec.media === 'fiber' || b.spec.media === 'fiber') return 'fiber';
  return a.spec.mdi === b.spec.mdi ? 'crossover' : 'straight';
}

export class Lab {
  readonly sim: Simulator;
  doc: Omit<LabDoc, 'devices' | 'links'>;
  /** Editor metadata per device (position, rack). */
  readonly meta = new Map<string, { x: number; y: number; rack?: { rack: number; u: number } }>();
  private idSeq = 1;

  constructor(doc: LabDoc = emptyDoc()) {
    const { devices, links, ...rest } = doc;
    this.doc = structuredClone(rest);
    this.sim = new Simulator(doc.seed);
    for (const d of devices) this.restoreDevice(d);
    for (const l of links) {
      const a = this.sim.devices.get(l.a.device)?.port(l.a.port);
      const b = this.sim.devices.get(l.b.device)?.port(l.b.port);
      if (!a || !b || a.link || b.link) continue;
      const link = this.sim.connect(l.id, a, b, l.cable);
      if (l.failed) {
        link.failed = true;
        this.sim.linkChanged(link);
      }
      this.bumpSeq(l.id);
    }
  }

  private bumpSeq(id: string) {
    const n = Number(/(\d+)$/.exec(id)?.[1] ?? 0);
    if (n >= this.idSeq) this.idSeq = n + 1;
  }

  private restoreDevice(d: LabDevice) {
    const model = getModel(d.model);
    const dev = createDevice(model, d.id, d.name, d.baseMac);
    dev.attach(this.sim);
    this.sim.addDevice(dev);
    this.meta.set(d.id, { x: d.x, y: d.y, rack: d.rack });
    dev.importState(d.state);
    if (d.powered) dev.powerOn();
    this.bumpSeq(d.id);
  }

  newId(prefix: string) {
    return `${prefix}${this.idSeq++}`;
  }

  private randomMac(model: HardwareModel): string {
    const r = () => Math.floor(this.sim.rng() * 256);
    // Low nibble zero: ports and SVIs get base+1, base+2... (macAdd carries across bytes anyway).
    const bytes = [r(), r(), r() & 0xf0];
    return `${model.oui}:${bytes.map((x) => x.toString(16).padStart(2, '0')).join(':')}`;
  }

  private uniqueName(model: HardwareModel): string {
    const prefix = NAME_PREFIX[model.kind] ?? 'DEV';
    const used = new Set([...this.sim.devices.values()].map((d) => d.name));
    for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
  }

  addDevice(modelId: string, x: number, y: number): Device {
    const model = getModel(modelId);
    const id = this.newId('d');
    const name = this.uniqueName(model);
    const dev = createDevice(model, id, name, this.randomMac(model));
    dev.attach(this.sim);
    this.sim.addDevice(dev);
    if (dev instanceof IosDevice) {
      // A brand-new device has the default hostname; give it the lab name like a technician would.
      dev.importState({ running: `hostname ${name}\n` });
    } else if (dev instanceof Host) {
      dev.importState({ running: JSON.stringify({ hostname: name, ipv4: { mode: 'dhcp' }, ipv6: { mode: 'auto' } }) });
    }
    dev.name = name;
    this.meta.set(id, { x, y, rack: this.freeRackSlot(model) });
    dev.powerOn();
    return dev;
  }

  private freeRackSlot(model: HardwareModel): { rack: number; u: number } | undefined {
    if (!model.ru) return undefined;
    const racks = this.doc.racks.length ? this.doc.racks : [{ name: 'Rack 1', units: 24 }];
    for (let r = 0; r < racks.length; r++) {
      const used = new Set<number>();
      for (const [id, m] of this.meta) {
        if (m.rack?.rack !== r) continue;
        const dm = this.sim.devices.get(id)?.model;
        for (let k = 0; k < (dm?.ru ?? 1); k++) used.add(m.rack.u + k);
      }
      for (let u = 1; u + model.ru - 1 <= racks[r].units; u++) {
        let free = true;
        for (let k = 0; k < model.ru; k++) if (used.has(u + k)) free = false;
        if (free) return { rack: r, u };
      }
    }
    return undefined;
  }

  removeDevice(id: string) {
    this.sim.removeDevice(id);
    this.meta.delete(id);
  }

  moveDevice(id: string, x: number, y: number) {
    const m = this.meta.get(id);
    if (m) {
      m.x = x;
      m.y = y;
    }
  }

  connect(aDev: string, aPort: string, bDev: string, bPort: string, cable?: CableType): Link {
    const a = this.sim.devices.get(aDev)?.port(aPort);
    const b = this.sim.devices.get(bDev)?.port(bPort);
    if (!a || !b) throw new Error('porta inexistente');
    if (a.link || b.link) throw new Error('porta já está em uso');
    if (a.device === b.device) throw new Error('não é possível ligar um equipamento a ele mesmo');
    return this.sim.connect(this.newId('l'), a, b, cable ?? autoCable(a, b));
  }

  disconnect(linkId: string) {
    this.sim.disconnect(linkId);
  }

  setPower(id: string, on: boolean) {
    const d = this.sim.devices.get(id);
    if (!d) return;
    if (on) d.powerOn();
    else d.powerOff();
  }

  device(id: string): Device | undefined {
    return this.sim.devices.get(id);
  }

  toDoc(): LabDoc {
    const devices: LabDevice[] = [...this.sim.devices.values()].map((d) => {
      const m = this.meta.get(d.id) ?? { x: 0, y: 0 };
      return { id: d.id, model: d.model.id, name: d.name, x: m.x, y: m.y, rack: m.rack, baseMac: d.baseMac, powered: d.powered, state: d.exportState() };
    });
    const links: LabLink[] = [...this.sim.links.values()].map((l) => ({
      id: l.id,
      a: { device: l.a.device.id, port: l.a.name },
      b: { device: l.b.device.id, port: l.b.name },
      cable: l.cable,
      failed: l.failed || undefined,
    }));
    return { ...structuredClone(this.doc), devices, links };
  }
}

export { MODELS };
