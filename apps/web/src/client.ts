/**
 * Client-side state of an open lab: a small observable store fed by Socket.IO events.
 * Components read it with the useLab() hook.
 */
import { io, type Socket } from 'socket.io-client';
import { useSyncExternalStore } from 'react';
import type {
  ChatMessage,
  DeviceNote,
  DeviceView,
  HardwareModel,
  LabSnapshot,
  LinkView,
  Role,
  TraceView,
  UserView,
} from '@webptracer/core';

export interface Anim {
  key: number;
  trace: TraceView;
  start: number;
  duration: number;
}

export interface TermHandlers {
  out(text: string): void;
  ready(prompt: string, echo: boolean): void;
  console(text: string): void;
  closed(): void;
}

export interface State {
  connected: boolean;
  snapshot: LabSnapshot | null;
  me: UserView | null;
  users: UserView[];
  cursors: Record<string, { x: number; y: number }>;
  chat: ChatMessage[];
  events: TraceView[];
  notes: DeviceNote[];
  anims: Anim[];
  toasts: { id: number; level: 'info' | 'error'; text: string }[];
  models: HardwareModel[];
  /** Simulation-mode protocol filter (empty = all). */
  filter: Set<string>;
  unreadChat: number;
}

const MAX_EVENTS = 1500;

export class LabClient {
  readonly socket: Socket;
  private listeners = new Set<() => void>();
  state: State = {
    connected: false,
    snapshot: null,
    me: null,
    users: [],
    cursors: {},
    chat: [],
    events: [],
    notes: [],
    anims: [],
    toasts: [],
    models: [],
    filter: new Set(),
    unreadChat: 0,
  };
  private terms = new Map<string, TermHandlers>();
  private animKey = 1;
  private toastSeq = 1;

  constructor(
    readonly labId: string,
    readonly name: string,
    readonly role: Role,
  ) {
    this.socket = io({ transports: ['websocket'] });
    const s = this.socket;
    s.on('connect', () => {
      this.set({ connected: true });
      s.emit('join', { labId, name, role }, (r: { error?: string }) => {
        if (r?.error) this.toast('error', r.error);
        // Reopen consoles after a reconnection.
        for (const id of this.terms.keys()) this.openTerminalRaw(id);
      });
    });
    s.on('disconnect', () => this.set({ connected: false }));
    s.on('snapshot', (snap: LabSnapshot) => this.set({ snapshot: snap }));
    s.on('devices', (a: { devices: DeviceView[]; links: LinkView[]; now: number }) => {
      const snap = this.state.snapshot;
      if (!snap) return;
      const byId = new Map(a.devices.map((d) => [d.id, d]));
      this.set({ snapshot: { ...snap, now: a.now, links: a.links, devices: snap.devices.map((d) => byId.get(d.id) ?? d) } });
    });
    s.on('me', (u: UserView) => this.set({ me: u }));
    s.on('presence', (users: UserView[]) => {
      const cursors: State['cursors'] = {};
      for (const u of users) if (u.cursor) cursors[u.id] = u.cursor;
      this.set({ users, cursors: { ...cursors, ...this.state.cursors } });
    });
    s.on('cursor', (c: { id: string; x: number; y: number }) => this.set({ cursors: { ...this.state.cursors, [c.id]: { x: c.x, y: c.y } } }));
    s.on('chat:history', (m: ChatMessage[]) => this.set({ chat: m }));
    s.on('chat', (m: ChatMessage) => this.set({ chat: [...this.state.chat.slice(-300), m], unreadChat: this.state.unreadChat + 1 }));
    s.on('traces', (list: TraceView[]) => this.onTraces(list));
    s.on('notes', (list: DeviceNote[]) => {
      const warn = list.filter((n) => n.level === 'warn');
      for (const w of warn) this.toast('error', w.text);
      this.set({ notes: [...this.state.notes, ...list].slice(-2000) });
    });
    s.on('toast', (t: { level: 'info' | 'error'; text: string }) => this.toast(t.level, t.text));
    s.on('term:out', (m: { deviceId: string; text: string }) => this.terms.get(m.deviceId)?.out(m.text));
    s.on('term:ready', (m: { deviceId: string; prompt: string; echo: boolean }) => this.terms.get(m.deviceId)?.ready(m.prompt, m.echo));
    s.on('term:console', (m: { deviceId: string; text: string }) => this.terms.get(m.deviceId)?.console(m.text));
    s.on('term:closed', (m: { deviceId: string }) => this.terms.get(m.deviceId)?.closed());
    s.on('term:closed-all', () => {
      for (const t of this.terms.values()) t.closed();
    });
    fetch('/api/models')
      .then((r) => r.json())
      .then((models: HardwareModel[]) => this.set({ models }));
  }

  close() {
    this.socket.close();
  }

  // ------------------------------------------------------------------ store

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  toast(level: 'info' | 'error', text: string) {
    const id = this.toastSeq++;
    this.set({ toasts: [...this.state.toasts.slice(-4), { id, level, text }] });
    setTimeout(() => this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) }), level === 'error' ? 7000 : 3500);
  }

  // ------------------------------------------------------------------ traffic

  private onTraces(list: TraceView[]) {
    const snap = this.state.snapshot;
    const sim = snap?.mode === 'simulation';
    const now = performance.now();
    let anims = this.state.anims.filter((a) => now - a.start < a.duration);
    const filter = this.state.filter;
    const visible = list.filter((t) => !filter.size || filter.has(t.proto));
    const room = sim ? 400 : 80;
    for (const t of visible.slice(-room)) anims.push({ key: this.animKey++, trace: t, start: now, duration: sim ? 750 : 380 });
    if (anims.length > room) anims = anims.slice(-room);
    const patch: Partial<State> = { anims };
    if (sim) patch.events = [...this.state.events, ...list].slice(-MAX_EVENTS);
    this.set(patch);
  }

  toggleFilter(proto: string) {
    const f = new Set(this.state.filter);
    if (f.has(proto)) f.delete(proto);
    else f.add(proto);
    this.set({ filter: f });
  }

  clearEvents() {
    this.set({ events: [], notes: [] });
  }

  // ------------------------------------------------------------------ actions

  emit<T = unknown>(event: string, payload?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      this.socket.emit(event, payload ?? {}, (r: T & { error?: string }) => {
        if (r && typeof r === 'object' && 'error' in r && r.error) {
          this.toast('error', r.error);
          reject(new Error(r.error));
        } else resolve(r);
      });
    });
  }

  send(event: string, payload?: unknown) {
    this.socket.emit(event, payload ?? {});
  }

  // ------------------------------------------------------------------ terminals

  registerTerminal(deviceId: string, h: TermHandlers) {
    this.terms.set(deviceId, h);
  }

  unregisterTerminal(deviceId: string) {
    this.terms.delete(deviceId);
    this.send('term:close', { deviceId });
  }

  private openTerminalRaw(deviceId: string) {
    return this.emit<{ ok: boolean; helpKey: boolean; name: string }>('term:open', { deviceId });
  }

  openTerminal(deviceId: string) {
    return this.openTerminalRaw(deviceId);
  }
}

export function useLab<T>(client: LabClient, select: (s: State) => T): T {
  return useSyncExternalStore(client.subscribe, () => select(client.state));
}

export const PROTO_COLORS: Record<string, string> = {
  ARP: '#f59e0b',
  ICMP: '#16a34a',
  ICMPv6: '#0d9488',
  NDP: '#06b6d4',
  DHCP: '#9333ea',
  STP: '#64748b',
  CDP: '#a16207',
  TCP: '#2563eb',
  UDP: '#4f46e5',
};
