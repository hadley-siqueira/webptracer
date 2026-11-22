import type { EthernetFrame } from '../net/packets';
import type { Device } from '../devices/device';
import type { Port } from '../devices/port';

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface QueuedEvent {
  time: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
  /** Frame deliveries are the "steps" of simulation mode. */
  traceId?: number;
}

class MinHeap {
  private a: QueuedEvent[] = [];
  get size() {
    return this.a.length;
  }
  peek(): QueuedEvent | undefined {
    return this.a[0];
  }
  private less(i: number, j: number) {
    const x = this.a[i];
    const y = this.a[j];
    return x.time < y.time || (x.time === y.time && x.seq < y.seq);
  }
  push(e: QueuedEvent) {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): QueuedEvent | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(l, m)) m = l;
        if (r < a.length && this.less(r, m)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

export type CableType = 'straight' | 'crossover' | 'fiber' | 'console';

export interface Link {
  id: string;
  a: Port;
  b: Port;
  cable: CableType;
  /** Physical fault injected (chaos engineering): the cable is broken. */
  failed: boolean;
}

/** A frame transmission on a link, recorded for animation, the event list and pcap export. */
export interface TraceEvent {
  id: number;
  time: number;
  arrive: number;
  linkId: string;
  fromDevice: string;
  fromPort: string;
  toDevice: string;
  toPort: string;
  frame: EthernetFrame;
  /** Highest-layer protocol, used for filters (ARP, ICMP, STP, CDP, DHCP, ICMPv6, ...). */
  proto: string;
  summary: string;
  /** Set when the frame was lost (storm control, link went down). */
  dropped?: string;
}

/** A decision taken by a device, shown in simulation mode ("switch floods the frame", "ACL denied"). */
export interface DeviceNote {
  time: number;
  device: string;
  text: string;
  level: 'info' | 'warn' | 'drop';
  traceId?: number;
}

export interface SimListener {
  trace?(e: TraceEvent): void;
  note?(n: DeviceNote): void;
  /** Asynchronous console output (syslog messages) of a device. */
  console?(deviceId: string, text: string): void;
  /** Visible device state changed (LEDs, link state). */
  state?(deviceId: string): void;
}

/** Propagation + processing delay per hop, in virtual milliseconds. */
export const HOP_DELAY = 1;

/** Storm control: maximum number of frames per link inside STORM_WINDOW virtual ms. */
const STORM_LIMIT = 300;
const STORM_WINDOW = 1000;

export class Simulator {
  /** Virtual time in milliseconds. */
  now = 0;
  readonly devices = new Map<string, Device>();
  readonly links = new Map<string, Link>();
  readonly rng: () => number;
  private queue = new MinHeap();
  private seq = 0;
  private traceSeq = 0;
  private listeners = new Set<SimListener>();
  private storm = new Map<string, { start: number; count: number; warned: boolean }>();
  /** Recent frames per link for pcap export. */
  readonly captures = new Map<string, TraceEvent[]>();
  captureLimit = 2000;
  eventsProcessed = 0;

  constructor(seed = 1) {
    this.rng = makeRng(seed);
  }

  on(l: SimListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  schedule(delay: number, fn: () => void): QueuedEvent {
    const e: QueuedEvent = { time: this.now + Math.max(0, delay), seq: this.seq++, fn, cancelled: false };
    this.queue.push(e);
    return e;
  }

  cancel(e: QueuedEvent | undefined | null) {
    if (e) e.cancelled = true;
  }

  get pending(): number {
    return this.queue.size;
  }

  /** Time of the next event, or undefined if the queue is empty. */
  nextTime(): number | undefined {
    this.dropCancelled();
    return this.queue.peek()?.time;
  }

  private dropCancelled() {
    while (this.queue.size && this.queue.peek()!.cancelled) this.queue.pop();
  }

  /** Runs every event with time <= t and moves the clock to t. */
  runUntil(t: number, maxEvents = 2_000_000) {
    let n = 0;
    for (;;) {
      this.dropCancelled();
      const e = this.queue.peek();
      if (!e || e.time > t) break;
      this.queue.pop();
      this.now = e.time;
      this.exec(e);
      if (++n > maxEvents) break;
    }
    if (t > this.now) this.now = t;
  }

  advance(ms: number) {
    this.runUntil(this.now + ms);
  }

  /**
   * Simulation mode: runs events until the next frame delivery (inclusive).
   * Returns the trace id delivered, or undefined if nothing is pending within `horizon` ms.
   */
  stepFrame(horizon = 60_000): number | undefined {
    const limit = this.now + horizon;
    for (;;) {
      this.dropCancelled();
      const e = this.queue.peek();
      if (!e || e.time > limit) return undefined;
      this.queue.pop();
      this.now = e.time;
      this.exec(e);
      if (e.traceId !== undefined) return e.traceId;
    }
  }

  private exec(e: QueuedEvent) {
    this.eventsProcessed++;
    try {
      e.fn();
    } catch (err) {
      // A bug in one device must never take the whole lab down.
      console.error('[sim] event error', err);
    }
  }

  // ---------------------------------------------------------------- topology

  addDevice(d: Device) {
    this.devices.set(d.id, d);
  }

  removeDevice(id: string) {
    const d = this.devices.get(id);
    if (!d) return;
    for (const p of d.ports) if (p.link) this.disconnect(p.link.id);
    d.powerOff();
    this.devices.delete(id);
  }

  connect(id: string, a: Port, b: Port, cable: CableType): Link {
    if (a.link || b.link) throw new Error('port already connected');
    if (a === b) throw new Error('cannot connect a port to itself');
    const link: Link = { id, a, b, cable, failed: false };
    a.link = link;
    b.link = link;
    this.links.set(id, link);
    this.linkChanged(link);
    return link;
  }

  disconnect(linkId: string) {
    const l = this.links.get(linkId);
    if (!l) return;
    l.a.link = null;
    l.b.link = null;
    this.links.delete(linkId);
    this.captures.delete(linkId);
    l.a.device.refreshPort(l.a);
    l.b.device.refreshPort(l.b);
  }

  /** Re-evaluates the physical state of both ends of a link. */
  linkChanged(l: Link) {
    l.a.device.refreshPort(l.a);
    l.b.device.refreshPort(l.b);
  }

  /** Physical layer check: is there carrier between the two ends? */
  carrier(l: Link): boolean {
    if (l.failed) return false;
    const { a, b } = l;
    if (!a.device.powered || !b.device.powered) return false;
    if (!a.adminUp || !b.adminUp) return false;
    if (l.cable === 'console') return false;
    const fiber = l.cable === 'fiber';
    if ((a.spec.media === 'fiber') !== fiber || (b.spec.media === 'fiber') !== fiber) return false;
    if (!fiber && !a.spec.mdix && !b.spec.mdix) {
      // Without auto-MDIX the cable type must match the MDI/MDI-X roles of the ports.
      const crossNeeded = a.spec.mdi === b.spec.mdi;
      if ((l.cable === 'crossover') !== crossNeeded) return false;
    }
    if (a.forcedSpeed && b.forcedSpeed && a.forcedSpeed !== b.forcedSpeed) return false;
    const common = a.spec.speeds.filter((s) => b.spec.speeds.includes(s));
    return common.length > 0;
  }

  // ----------------------------------------------------------------- frames

  /** Puts a frame on the wire. Delivery happens HOP_DELAY ms later. */
  transmit(from: Port, frame: EthernetFrame) {
    const l = from.link;
    if (!l || !from.isUp()) return;
    const to = l.a === from ? l.b : l.a;
    const ev: TraceEvent = {
      id: ++this.traceSeq,
      time: this.now,
      arrive: this.now + HOP_DELAY,
      linkId: l.id,
      fromDevice: from.device.id,
      fromPort: from.name,
      toDevice: to.device.id,
      toPort: to.name,
      frame,
      proto: protoOf(frame),
      summary: summarize(frame),
    };
    if (!this.stormCheck(l)) {
      ev.dropped = 'storm-control';
      this.emitTrace(ev);
      return;
    }
    from.stats.txFrames++;
    this.emitTrace(ev);
    const q = this.schedule(HOP_DELAY, () => {
      if (!to.isUp() || to.link !== l) return;
      to.stats.rxFrames++;
      to.device.receiveFrame(to, frame, ev.id);
    });
    q.traceId = ev.id;
  }

  private stormCheck(l: Link): boolean {
    let s = this.storm.get(l.id);
    if (!s || this.now - s.start > STORM_WINDOW) {
      s = { start: this.now, count: 0, warned: false };
      this.storm.set(l.id, s);
    }
    s.count++;
    if (s.count <= STORM_LIMIT) return true;
    if (!s.warned) {
      s.warned = true;
      this.note({
        time: this.now,
        device: l.a.device.id,
        level: 'warn',
        text: `Tempestade de broadcast detectada no enlace ${l.a.device.name} ${l.a.short} ↔ ${l.b.device.name} ${l.b.short}: mais de ${STORM_LIMIT} quadros/s. Provável laço de camada 2 sem STP. Quadros excedentes estão sendo descartados pelo simulador.`,
      });
    }
    return false;
  }

  private emitTrace(ev: TraceEvent) {
    let cap = this.captures.get(ev.linkId);
    if (!cap) this.captures.set(ev.linkId, (cap = []));
    cap.push(ev);
    if (cap.length > this.captureLimit) cap.splice(0, cap.length - this.captureLimit);
    for (const l of this.listeners) l.trace?.(ev);
  }

  note(n: DeviceNote) {
    for (const l of this.listeners) l.note?.(n);
  }

  emitConsole(deviceId: string, text: string) {
    for (const l of this.listeners) l.console?.(deviceId, text);
  }

  emitState(deviceId: string) {
    for (const l of this.listeners) l.state?.(deviceId);
  }
}

export function protoOf(f: EthernetFrame): string {
  const p = f.payload;
  switch (p.kind) {
    case 'arp':
      return 'ARP';
    case 'stp':
      return 'STP';
    case 'cdp':
      return 'CDP';
    case 'ipv4': {
      const q = p.payload;
      if (q.kind === 'icmp') return 'ICMP';
      if (q.kind === 'udp') return q.payload.kind === 'dhcp' ? 'DHCP' : 'UDP';
      return 'TCP';
    }
    case 'ipv6': {
      const q = p.payload;
      if (q.kind === 'icmpv6') return q.type >= 133 && q.type <= 137 ? 'NDP' : 'ICMPv6';
      if (q.kind === 'udp') return 'UDP';
      return 'TCP';
    }
  }
}

// Lazy import to avoid a cycle with describe.ts (which imports address formatters only).
import { summarize } from '../net/describe';
