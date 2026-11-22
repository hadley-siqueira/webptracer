import type { EthernetFrame } from '../net/packets';
import { macAdd } from '../net/mac';
import type { Simulator } from '../sim/engine';
import { Port } from './port';
import type { HardwareModel } from './models';
import type { Terminal, CliSession } from '../cli/session';

export interface DeviceInit {
  id: string;
  name: string;
  model: HardwareModel;
  /** Base MAC; ports get consecutive addresses. */
  baseMac: string;
}

/** LED state shown on the physical and logical views. */
export type LedColor = 'off' | 'green' | 'amber' | 'blink-green' | 'blink-amber';

export interface PortView {
  name: string;
  short: string;
  connected: boolean;
  up: boolean;
  led: LedColor;
  /** Extra info (VLAN, IP) displayed in tooltips. */
  info: string;
}

/** Persistent state of a device (what goes in the lab document). */
export interface DeviceState {
  /** IOS: running-config text. Hosts: JSON settings. */
  running: string;
  startup?: string;
}

export abstract class Device {
  readonly id: string;
  name: string;
  readonly model: HardwareModel;
  readonly ports: Port[];
  readonly baseMac: string;
  powered = false;
  /** Incremented at each boot; timers from a previous boot are ignored. */
  protected gen = 0;
  protected sim!: Simulator;

  constructor(init: DeviceInit) {
    this.id = init.id;
    this.name = init.name;
    this.model = init.model;
    this.baseMac = init.baseMac;
    this.ports = init.model.ports.map((spec, i) => new Port(this, spec, macAdd(init.baseMac, i + 1)));
  }

  attach(sim: Simulator) {
    this.sim = sim;
  }

  get simulator(): Simulator {
    return this.sim;
  }

  port(name: string): Port | undefined {
    const n = name.toLowerCase();
    return this.ports.find((p) => p.name.toLowerCase() === n || p.short.toLowerCase() === n);
  }

  /** Timer bound to the current boot; never fires after a power cycle. */
  timer(delay: number, fn: () => void) {
    const g = this.gen;
    return this.sim.schedule(delay, () => {
      if (this.powered && g === this.gen) fn();
    });
  }

  /** Periodic timer bound to the current boot. */
  every(interval: number, fn: () => void, firstDelay = interval) {
    const g = this.gen;
    const tick = () => {
      if (!this.powered || g !== this.gen) return;
      fn();
      this.sim.schedule(interval, tick);
    };
    this.sim.schedule(firstDelay, tick);
  }

  powerOn() {
    if (this.powered) return;
    this.powered = true;
    this.gen++;
    this.boot();
    for (const p of this.ports) this.refreshPort(p);
    this.sim.emitState(this.id);
  }

  powerOff() {
    if (!this.powered) return;
    this.powered = false;
    this.gen++;
    this.shutdownOs();
    for (const p of this.ports) {
      p.carrier = false;
      const peer = p.peer();
      if (peer) peer.device.refreshPort(peer);
    }
    this.sim.emitState(this.id);
  }

  /** Re-evaluates carrier for a port and propagates link up/down to the OS. */
  refreshPort(p: Port) {
    const before = p.carrier;
    const now = !!p.link && this.sim.carrier(p.link);
    p.carrier = now;
    if (before !== now) {
      if (this.powered) this.onCarrier(p, now);
      const peer = p.peer();
      if (peer && peer.carrier !== now) peer.device.refreshPort(peer);
      this.sim.emitState(this.id);
    }
  }

  send(p: Port, f: EthernetFrame) {
    if (!this.powered) return;
    this.sim.transmit(p, f);
  }

  note(text: string, level: 'info' | 'warn' | 'drop' = 'info', traceId?: number) {
    this.sim.note({ time: this.sim.now, device: this.id, text, level, traceId });
  }

  /** Called when a frame arrives on a port. */
  receiveFrame(p: Port, f: EthernetFrame, traceId: number) {
    if (!this.powered) return;
    this.receive(p, f, traceId);
  }

  protected abstract receive(p: Port, f: EthernetFrame, traceId: number): void;
  protected abstract boot(): void;
  protected abstract shutdownOs(): void;
  protected abstract onCarrier(p: Port, up: boolean): void;

  abstract portViews(): PortView[];
  abstract exportState(): DeviceState;
  abstract importState(s: DeviceState): void;
  /** Opens a console session (terminal) on this device. */
  abstract openSession(term: Terminal): CliSession;
  /** One-line description of the device's current addressing, for tooltips. */
  abstract summary(): string;
}

export function nextMac(base: string, i: number) {
  return macAdd(base, i);
}
