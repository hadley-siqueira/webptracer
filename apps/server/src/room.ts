/**
 * A room hosts one live lab. The server is authoritative: every client sees the same
 * simulation; edits and console input arrive as Socket.IO events and state flows back.
 */
import type { Server, Socket } from 'socket.io';
import {
  Lab,
  Host,
  describeFrame,
  frameBytes,
  hexDump,
  gradeLab,
  injectFault,
  type CliSession,
  type DeviceNote,
  type DeviceView,
  type Fault,
  type FaultView,
  type LabDoc,
  type LabSnapshot,
  type LinkView,
  type SimMode,
  type TraceEvent,
  type TraceView,
  type UserView,
  type ChatMessage,
  type Role,
  type HostConfig,
  type Objective,
} from '@webptracer/core';
import { addCommit, getCommit, listCommits, saveLab } from './db.js';

const TICK_MS = 50;
const TRACE_KEEP = 4000;
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#469990', '#9a6324', '#800000'];

interface Client {
  socket: Socket;
  user: UserView;
  terms: Map<string, CliSession>;
}

function traceView(e: TraceEvent): TraceView {
  return {
    id: e.id,
    time: e.time,
    linkId: e.linkId,
    from: e.fromDevice,
    fromPort: e.fromPort,
    to: e.toDevice,
    toPort: e.toPort,
    proto: e.proto,
    summary: e.summary,
    dropped: e.dropped,
  };
}

export class Room {
  lab: Lab;
  mode: SimMode = 'realtime';
  speed = 1;
  /** Simulation mode: automatic stepping ("Play"). */
  playing = false;
  readonly clients = new Map<string, Client>();
  private traces = new Map<number, TraceEvent>();
  private notes = new Map<number, DeviceNote[]>();
  private pendingTraces: TraceView[] = [];
  private pendingNotes: DeviceNote[] = [];
  private stateDirty = new Set<string>();
  private topologyDirty = true;
  private timer: NodeJS.Timeout;
  private lastPlayStep = 0;
  private ticks = 0;
  private saveTimer?: NodeJS.Timeout;
  private chat: ChatMessage[] = [];
  private chatSeq = 1;
  faults: (Fault & { time: number })[] = [];
  private faultSeq = 1;
  private unsub: () => void = () => {};

  constructor(
    readonly id: string,
    doc: LabDoc,
    private readonly io: Server,
  ) {
    this.lab = new Lab(doc);
    this.listen();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private get channel() {
    return `lab:${this.id}`;
  }

  private listen() {
    this.unsub();
    this.unsub = this.lab.sim.on({
      trace: (e) => {
        this.traces.set(e.id, e);
        if (this.traces.size > TRACE_KEEP) this.traces.delete(this.traces.keys().next().value!);
        this.pendingTraces.push(traceView(e));
      },
      note: (n) => {
        if (n.traceId !== undefined) {
          const list = this.notes.get(n.traceId) ?? [];
          list.push(n);
          this.notes.set(n.traceId, list);
          if (this.notes.size > TRACE_KEEP) this.notes.delete(this.notes.keys().next().value!);
        }
        if (n.level === 'warn' || this.mode === 'simulation') this.pendingNotes.push(n);
      },
      console: (deviceId, text) => {
        for (const c of this.clients.values()) if (c.terms.has(deviceId)) c.socket.emit('term:console', { deviceId, text });
      },
      state: (deviceId) => {
        this.stateDirty.add(deviceId);
      },
    });
  }

  // ===================================================================== clock

  private tick() {
    const sim = this.lab.sim;
    if (this.mode === 'realtime') {
      sim.advance(TICK_MS * this.speed);
    } else if (this.playing) {
      const now = Date.now();
      if (now - this.lastPlayStep >= 800 / this.speed) {
        this.lastPlayStep = now;
        this.step();
      }
    }
    this.flush();
  }

  /** Simulation mode: advances to the next frame delivery and everything at that instant. */
  step() {
    const sim = this.lab.sim;
    const id = sim.stepFrame(10_000);
    if (id === undefined) {
      // Nothing in flight: let timers run (pings waiting, STP hellos...).
      sim.advance(1000);
      return;
    }
    sim.runUntil(sim.now);
  }

  private flush() {
    const io = this.io.to(this.channel);
    if (++this.ticks % 5 === 0) io.emit('clock', { now: this.lab.sim.now, mode: this.mode, playing: this.playing });
    if (this.pendingTraces.length) {
      // In real-time mode only a sample of the traffic is animated.
      const list = this.mode === 'realtime' && this.pendingTraces.length > 120 ? this.pendingTraces.slice(-120) : this.pendingTraces;
      io.emit('traces', list);
      this.pendingTraces = [];
    }
    if (this.pendingNotes.length) {
      io.emit('notes', this.pendingNotes.slice(-200));
      this.pendingNotes = [];
    }
    if (this.topologyDirty) {
      this.topologyDirty = false;
      this.stateDirty.clear();
      io.emit('snapshot', this.snapshot());
    } else if (this.stateDirty.size) {
      const devices = [...this.stateDirty].map((id) => this.lab.device(id)).filter((d) => !!d).map((d) => this.deviceView(d!.id)!);
      this.stateDirty.clear();
      io.emit('devices', { devices, links: this.linkViews(), now: this.lab.sim.now });
    }
  }

  // ===================================================================== views

  deviceView(id: string): DeviceView | undefined {
    const d = this.lab.device(id);
    if (!d) return undefined;
    const m = this.lab.meta.get(id) ?? { x: 0, y: 0 };
    const v: DeviceView = {
      id: d.id,
      name: d.name,
      model: d.model.id,
      kind: d.model.kind,
      os: d.model.os,
      x: m.x,
      y: m.y,
      rack: m.rack,
      powered: d.powered,
      ports: d.portViews(),
      summary: d.summary(),
    };
    if (d instanceof Host) v.host = { cfg: d.cfg, eff: d.effective() };
    return v;
  }

  linkViews(): LinkView[] {
    return [...this.lab.sim.links.values()].map((l) => ({
      id: l.id,
      a: { device: l.a.device.id, port: l.a.name },
      b: { device: l.b.device.id, port: l.b.name },
      cable: l.cable,
      up: l.a.isUp() && l.b.isUp(),
      failed: l.failed,
    }));
  }

  snapshot(): LabSnapshot {
    const doc = this.lab.doc;
    return {
      labId: this.id,
      name: doc.name,
      description: doc.description,
      instructions: doc.instructions,
      mode: this.mode,
      speed: this.speed,
      playing: this.playing,
      now: this.lab.sim.now,
      devices: [...this.lab.sim.devices.keys()].map((id) => this.deviceView(id)!),
      links: this.linkViews(),
      racks: doc.racks,
      objectives: doc.objectives,
    };
  }

  // ===================================================================== persistence

  private changed() {
    this.topologyDirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 2000);
  }

  save() {
    saveLab(this.id, this.lab.toDoc());
  }

  private replaceLab(doc: LabDoc) {
    for (const c of this.clients.values()) {
      for (const s of c.terms.values()) s.close();
      c.terms.clear();
      c.socket.emit('term:closed-all');
    }
    this.lab = new Lab(doc);
    this.traces.clear();
    this.notes.clear();
    this.faults = [];
    this.listen();
    this.changed();
  }

  // ===================================================================== clients

  private system(text: string) {
    const m: ChatMessage = { id: this.chatSeq++, user: '', color: '#888', text, time: Date.now(), system: true };
    this.chat.push(m);
    this.io.to(this.channel).emit('chat', m);
  }

  private presence() {
    this.io.to(this.channel).emit('presence', [...this.clients.values()].map((c) => c.user));
  }

  join(socket: Socket, name: string, role: Role) {
    const color = COLORS[this.clients.size % COLORS.length];
    const client: Client = { socket, user: { id: socket.id, name: name || 'Anônimo', color, role }, terms: new Map() };
    this.clients.set(socket.id, client);
    socket.join(this.channel);
    socket.emit('snapshot', this.snapshot());
    socket.emit('chat:history', this.chat.slice(-100));
    socket.emit('me', client.user);
    this.presence();
    this.system(`${client.user.name} entrou no laboratório`);
    this.bind(client);
  }

  leave(socketId: string) {
    const c = this.clients.get(socketId);
    if (!c) return;
    for (const s of c.terms.values()) s.close();
    this.clients.delete(socketId);
    this.presence();
    this.system(`${c.user.name} saiu`);
  }

  get empty() {
    return this.clients.size === 0;
  }

  dispose() {
    clearInterval(this.timer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.save();
    this.unsub();
  }

  private bind(c: Client) {
    const s = c.socket;
    const lab = () => this.lab;
    const guard =
      <T,>(fn: (arg: T, ack?: (r: unknown) => void) => void) =>
      (arg: T, ack?: (r: unknown) => void) => {
        try {
          fn(arg, ack);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (typeof ack === 'function') ack({ error: msg });
          else s.emit('toast', { level: 'error', text: msg });
        }
      };
    const teacher = () => {
      if (c.user.role !== 'professor') throw new Error('Ação disponível apenas para o professor');
    };

    // ---- topology edits
    s.on('device:add', guard((a: { model: string; x: number; y: number }, ack) => {
      const d = lab().addDevice(a.model, a.x, a.y);
      this.changed();
      ack?.({ id: d.id });
    }));
    s.on('device:move', guard((a: { id: string; x: number; y: number }) => {
      lab().moveDevice(a.id, a.x, a.y);
      this.stateDirty.add(a.id);
      this.changed();
    }));
    s.on('device:rack', guard((a: { id: string; rack: number; u: number }) => {
      const m = lab().meta.get(a.id);
      if (m) m.rack = { rack: a.rack, u: a.u };
      this.changed();
    }));
    s.on('device:remove', guard((a: { id: string }) => {
      for (const cl of this.clients.values()) {
        const t = cl.terms.get(a.id);
        if (t) {
          t.close();
          cl.terms.delete(a.id);
          cl.socket.emit('term:closed', { deviceId: a.id });
        }
      }
      lab().removeDevice(a.id);
      this.changed();
    }));
    s.on('device:power', guard((a: { id: string; on: boolean }) => {
      lab().setPower(a.id, a.on);
      this.changed();
    }));
    s.on('link:add', guard((a: { a: string; aPort: string; b: string; bPort: string; cable?: 'straight' | 'crossover' | 'fiber' }, ack) => {
      const l = lab().connect(a.a, a.aPort, a.b, a.bPort, a.cable);
      this.changed();
      ack?.({ id: l.id });
    }));
    s.on('link:remove', guard((a: { id: string }) => {
      lab().disconnect(a.id);
      this.changed();
    }));
    s.on('host:config', guard((a: { id: string; cfg: HostConfig }) => {
      const d = lab().device(a.id);
      if (!(d instanceof Host)) throw new Error('Não é um host');
      d.applyConfig(a.cfg);
      this.changed();
    }));
    s.on('lab:meta', guard((a: { name?: string; description?: string; instructions?: string }) => {
      const doc = lab().doc;
      if (a.name !== undefined) doc.name = a.name;
      if (a.description !== undefined) doc.description = a.description;
      if (a.instructions !== undefined) doc.instructions = a.instructions;
      this.changed();
    }));

    // ---- clock
    s.on('sim:mode', guard((a: { mode: SimMode }) => {
      this.mode = a.mode;
      this.playing = false;
      this.topologyDirty = true;
    }));
    s.on('sim:speed', guard((a: { speed: number }) => {
      this.speed = Math.max(0.25, Math.min(20, a.speed));
      this.topologyDirty = true;
    }));
    s.on('sim:play', guard((a: { playing: boolean }) => {
      this.playing = a.playing;
      this.topologyDirty = true;
    }));
    s.on('sim:step', guard(() => {
      if (this.mode === 'simulation') this.step();
    }));
    s.on('sim:advance', guard((a: { ms: number }) => {
      lab().sim.advance(Math.min(Math.max(a.ms, 0), 600_000));
      this.topologyDirty = true;
    }));

    // ---- terminals
    s.on('term:open', guard((a: { deviceId: string }, ack) => {
      const d = lab().device(a.deviceId);
      if (!d) throw new Error('Equipamento inexistente');
      c.terms.get(a.deviceId)?.close();
      const deviceId = a.deviceId;
      const session = d.openSession({
        write: (text) => s.emit('term:out', { deviceId, text }),
        ready: (prompt, opts) => s.emit('term:ready', { deviceId, prompt, echo: opts.echo }),
      });
      c.terms.set(deviceId, session);
      const ios = d.model.os === 'ios' || d.model.os === 'iosxe';
      ack?.({ ok: true, helpKey: ios, name: d.name });
    }));
    s.on('term:line', guard((a: { deviceId: string; text: string }) => {
      c.terms.get(a.deviceId)?.line(a.text);
    }));
    s.on('term:help', guard((a: { deviceId: string; text: string }, ack) => {
      ack?.({ text: c.terms.get(a.deviceId)?.help(a.text) ?? '' });
    }));
    s.on('term:complete', guard((a: { deviceId: string; text: string }, ack) => {
      ack?.({ text: c.terms.get(a.deviceId)?.complete(a.text) ?? a.text });
    }));
    s.on('term:interrupt', guard((a: { deviceId: string; kind: 'break' | 'ctrl-z' }) => {
      c.terms.get(a.deviceId)?.interrupt(a.kind);
    }));
    s.on('term:close', guard((a: { deviceId: string }) => {
      c.terms.get(a.deviceId)?.close();
      c.terms.delete(a.deviceId);
    }));

    // ---- inspection
    s.on('trace:detail', guard((a: { id: number }, ack) => {
      const e = this.traces.get(a.id);
      if (!e) throw new Error('Evento não está mais disponível');
      ack?.({ trace: traceView(e), layers: describeFrame(e.frame), hex: hexDump(frameBytes(e.frame)), notes: this.notes.get(e.id) ?? [] });
    }));

    // ---- collaboration
    s.on('cursor', (a: { x: number; y: number }) => {
      c.user.cursor = a;
      s.to(this.channel).emit('cursor', { id: c.user.id, x: a.x, y: a.y });
    });
    s.on('chat', guard((a: { text: string }) => {
      const text = String(a.text ?? '').slice(0, 1000).trim();
      if (!text) return;
      const m: ChatMessage = { id: this.chatSeq++, user: c.user.name, color: c.user.color, text, time: Date.now() };
      this.chat.push(m);
      if (this.chat.length > 500) this.chat.shift();
      this.io.to(this.channel).emit('chat', m);
    }));

    // ---- versions
    s.on('version:commit', guard((a: { message: string }, ack) => {
      this.save();
      const r = addCommit(this.id, a.message || 'Sem descrição', c.user.name, lab().toDoc());
      this.system(`${c.user.name} salvou a versão #${r.id}: ${a.message || 'Sem descrição'}`);
      ack?.({ id: r.id });
    }));
    s.on('version:list', guard((_a: unknown, ack) => ack?.(listCommits(this.id))));
    s.on('version:restore', guard((a: { id: number }) => {
      const v = getCommit(a.id);
      if (!v || v.labId !== this.id) throw new Error('Versão não encontrada');
      this.replaceLab(v.doc);
      this.system(`${c.user.name} restaurou a versão #${a.id}`);
    }));

    // ---- objectives & grading
    s.on('objectives:set', guard((a: { objectives: Objective[] }) => {
      teacher();
      lab().doc.objectives = a.objectives;
      this.changed();
    }));
    s.on('grade', guard((_a: unknown, ack) => {
      const r = gradeLab(lab().toDoc());
      ack?.(r);
    }));

    // ---- chaos engineering
    s.on('chaos:inject', guard((_a: unknown, ack) => {
      teacher();
      const f = injectFault(lab(), `f${this.faultSeq++}`);
      if (!f) throw new Error('Nenhuma falha aplicável a esta topologia');
      const rec = { ...f, time: Date.now() };
      this.faults.push(rec);
      this.changed();
      this.system('⚠ O professor injetou uma falha na rede. Encontre e corrija o problema!');
      ack?.(this.faultViews());
    }));
    s.on('chaos:list', guard((_a: unknown, ack) => {
      teacher();
      ack?.(this.faultViews());
    }));
    s.on('chaos:revert', guard((a: { id: string }, ack) => {
      teacher();
      const f = this.faults.find((x) => x.id === a.id);
      if (f) {
        f.revert();
        this.faults = this.faults.filter((x) => x !== f);
        this.changed();
      }
      ack?.(this.faultViews());
    }));
    s.on('chaos:hint', guard((a: { id: string }) => {
      teacher();
      const f = this.faults.find((x) => x.id === a.id);
      if (f) this.system(`💡 Dica: ${f.hint}`);
    }));
  }

  faultViews(): FaultView[] {
    return this.faults.map((f) => ({ id: f.id, kind: f.kind, description: f.description, hint: f.hint, time: f.time }));
  }

  /** Frames captured on a link (for pcap export). */
  capture(linkId: string) {
    return this.lab.sim.captures.get(linkId) ?? [];
  }
}
