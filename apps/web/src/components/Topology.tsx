import { useEffect, useMemo, useRef, useState } from 'react';
import type { DeviceView, LinkView, PortView } from '@webptracer/core';
import { LabClient, PROTO_COLORS, useLab } from '../client';
import { DeviceIcon } from './icons';

export type Tool = 'select' | 'cable' | 'delete';
export type CableChoice = 'auto' | 'straight' | 'crossover' | 'fiber';

interface Props {
  client: LabClient;
  tool: Tool;
  cable: CableChoice;
  selected: { type: 'device' | 'link'; id: string } | null;
  onSelect(sel: { type: 'device' | 'link'; id: string } | null): void;
  onOpenConsole(id: string): void;
  onConfigure(id: string): void;
  onToolDone(): void;
}

const LED_COLOR: Record<string, string> = { green: '#22c55e', amber: '#f59e0b', off: '#9ca3af', 'blink-green': '#22c55e', 'blink-amber': '#f59e0b' };
const CABLE_STYLE: Record<string, { stroke: string; dash?: string }> = {
  straight: { stroke: '#1f2937' },
  crossover: { stroke: '#1f2937', dash: '7 4' },
  fiber: { stroke: '#ea580c' },
  console: { stroke: '#0ea5e9', dash: '2 3' },
};

function portOf(d: DeviceView | undefined, name: string): PortView | undefined {
  return d?.ports.find((p) => p.name === name);
}

export function Topology(p: Props) {
  const { client } = p;
  const snap = useLab(client, (s) => s.snapshot);
  const anims = useLab(client, (s) => s.anims);
  const cursors = useLab(client, (s) => s.cursors);
  const users = useLab(client, (s) => s.users);
  const me = useLab(client, (s) => s.me);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; x: number; y: number } | null>(null);
  const [pan, setPan] = useState<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const [picker, setPicker] = useState<{ deviceId: string; sx: number; sy: number } | null>(null);
  const [pending, setPending] = useState<{ deviceId: string; port: string } | null>(null);
  const [menu, setMenu] = useState<{ id: string; sx: number; sy: number } | null>(null);
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const [, setFrame] = useState(0);
  const lastCursor = useRef(0);

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Animation loop while packets are travelling.
  useEffect(() => {
    if (!anims.length) return;
    let raf = 0;
    const loop = () => {
      setFrame((f) => f + 1);
      const now = performance.now();
      if (anims.some((a) => now - a.start < a.duration)) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [anims]);

  useEffect(() => {
    if (p.tool !== 'cable') {
      setPending(null);
      setPicker(null);
    }
  }, [p.tool]);

  const devices = snap?.devices ?? [];
  const byId = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);
  const pos = (id: string) => {
    if (drag?.id === id) return { x: drag.x, y: drag.y };
    const d = byId.get(id);
    return d ? { x: d.x, y: d.y } : { x: 0, y: 0 };
  };

  const toWorld = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: view.x + (cx - r.left) / view.zoom, y: view.y + (cy - r.top) / view.zoom };
  };

  // ------------------------------------------------------------------ handlers

  const onWheel = (e: React.WheelEvent) => {
    const w = toWorld(e.clientX, e.clientY);
    const zoom = Math.min(3, Math.max(0.3, view.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    const r = svgRef.current!.getBoundingClientRect();
    setView({ zoom, x: w.x - (e.clientX - r.left) / zoom, y: w.y - (e.clientY - r.top) / zoom });
  };

  const onBgDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setMenu(null);
    setPicker(null);
    setPan({ sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
    p.onSelect(null);
  };

  const onMove = (e: React.MouseEvent) => {
    const w = toWorld(e.clientX, e.clientY);
    setMouse(w);
    const now = performance.now();
    if (now - lastCursor.current > 60) {
      lastCursor.current = now;
      client.send('cursor', { x: Math.round(w.x), y: Math.round(w.y) });
    }
    if (drag) setDrag({ ...drag, x: Math.round(w.x - drag.dx), y: Math.round(w.y - drag.dy) });
    else if (pan) setView({ ...view, x: pan.vx - (e.clientX - pan.sx) / view.zoom, y: pan.vy - (e.clientY - pan.sy) / view.zoom });
  };

  const onUp = () => {
    if (drag) {
      const d = byId.get(drag.id);
      if (d && (d.x !== drag.x || d.y !== drag.y)) client.send('device:move', { id: drag.id, x: drag.x, y: drag.y });
      // Keep the dragged position until the server confirms it.
      setTimeout(() => setDrag(null), 150);
    }
    setPan(null);
  };

  const onDeviceDown = (e: React.MouseEvent, d: DeviceView) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    setMenu(null);
    if (p.tool === 'delete') {
      if (confirm(`Remover ${d.name}?`)) client.send('device:remove', { id: d.id });
      return;
    }
    if (p.tool === 'cable') {
      setPicker({ deviceId: d.id, sx: e.clientX, sy: e.clientY });
      return;
    }
    p.onSelect({ type: 'device', id: d.id });
    const w = toWorld(e.clientX, e.clientY);
    setDrag({ id: d.id, dx: w.x - d.x, dy: w.y - d.y, x: d.x, y: d.y });
  };

  const choosePort = async (deviceId: string, port: string) => {
    setPicker(null);
    if (!pending) {
      setPending({ deviceId, port });
      return;
    }
    if (pending.deviceId === deviceId) {
      client.toast('error', 'Escolha outro equipamento para a outra ponta do cabo.');
      return;
    }
    try {
      await client.emit('link:add', { a: pending.deviceId, aPort: pending.port, b: deviceId, bPort: port, cable: p.cable === 'auto' ? undefined : p.cable });
    } catch {
      /* toast already shown */
    }
    setPending(null);
    p.onToolDone();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const model = e.dataTransfer.getData('text/x-model');
    if (!model) return;
    const w = toWorld(e.clientX, e.clientY);
    client.emit<{ id: string }>('device:add', { model, x: Math.round(w.x), y: Math.round(w.y) }).then((r) => p.onSelect({ type: 'device', id: r.id }));
  };

  if (!snap) return <div className="canvas-empty">Carregando…</div>;
  const now = performance.now();
  const vb = `${view.x} ${view.y} ${size.w / view.zoom} ${size.h / view.zoom}`;

  return (
    <div className={`topology tool-${p.tool}`} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <svg ref={svgRef} width={size.w} height={size.h} viewBox={vb} onWheel={onWheel} onMouseDown={onBgDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#e5e7eb" strokeWidth="1" />
          </pattern>
        </defs>
        <rect x={view.x - 4000} y={view.y - 4000} width="12000" height="12000" fill="url(#grid)" />

        {snap.links.map((l) => (
          <LinkShape key={l.id} l={l} a={pos(l.a.device)} b={pos(l.b.device)} da={byId.get(l.a.device)} db={byId.get(l.b.device)} selected={p.selected?.type === 'link' && p.selected.id === l.id} onClick={(e) => {
            e.stopPropagation();
            if (p.tool === 'delete') {
              client.send('link:remove', { id: l.id });
              return;
            }
            p.onSelect({ type: 'link', id: l.id });
          }} />
        ))}

        {pending && mouse && (
          <line x1={pos(pending.deviceId).x} y1={pos(pending.deviceId).y} x2={mouse.x} y2={mouse.y} stroke="#2563eb" strokeWidth="2" strokeDasharray="5 4" pointerEvents="none" />
        )}

        {devices.map((d) => {
          const sel = p.selected?.type === 'device' && p.selected.id === d.id;
          const pp = pos(d.id);
          return (
            <g key={d.id} transform={`translate(${pp.x},${pp.y})`} className="device" onMouseDown={(e) => onDeviceDown(e, d)} onDoubleClick={() => p.onOpenConsole(d.id)} onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id: d.id, sx: e.clientX, sy: e.clientY });
            }}>
              {sel && <rect x="-36" y="-32" width="72" height="64" rx="8" fill="#dbeafe" stroke="#3b82f6" />}
              <DeviceIcon kind={d.kind} powered={d.powered} />
              <text y="40" textAnchor="middle" className="dev-name">{d.name}</text>
              {d.summary && <text y="53" textAnchor="middle" className="dev-sub">{d.summary.length > 34 ? d.summary.slice(0, 33) + '…' : d.summary}</text>}
              {!d.powered && <text y="-30" textAnchor="middle" className="dev-off">desligado</text>}
            </g>
          );
        })}

        {anims.map((a) => {
          const t = (now - a.start) / a.duration;
          if (t < 0 || t > 1) return null;
          const from = pos(a.trace.from);
          const to = pos(a.trace.to);
          const x = from.x + (to.x - from.x) * t;
          const y = from.y + (to.y - from.y) * t;
          const color = PROTO_COLORS[a.trace.proto] ?? '#111';
          return (
            <g key={a.key} transform={`translate(${x},${y})`} pointerEvents="none" opacity={a.trace.dropped ? 0.5 : 1}>
              <rect x="-9" y="-6" width="18" height="12" rx="2" fill={color} stroke="white" strokeWidth="1.2" />
              <path d="M-9 -6 L0 1 L9 -6" fill="none" stroke="white" strokeWidth="1.2" />
              {a.trace.dropped && <text y="-9" textAnchor="middle" fontSize="12" fill="#dc2626">✕</text>}
            </g>
          );
        })}

        {users
          .filter((u) => u.id !== me?.id && cursors[u.id])
          .map((u) => (
            <g key={u.id} transform={`translate(${cursors[u.id].x},${cursors[u.id].y})`} pointerEvents="none">
              <path d="M0 0 L0 16 L4 12 L8 20 L11 18 L7 11 L13 11 Z" fill={u.color} stroke="white" />
              <text x="14" y="24" fontSize="11" fill={u.color} fontWeight="600">{u.name}</text>
            </g>
          ))}
      </svg>

      {p.tool === 'cable' && <div className="hint">{pending ? `Origem: ${byId.get(pending.deviceId)?.name} ${pending.port}. Agora clique no equipamento de destino.` : 'Clique no equipamento de origem do cabo.'}</div>}

      {picker && (
        <PortPicker device={byId.get(picker.deviceId)!} x={picker.sx} y={picker.sy} onPick={(port) => choosePort(picker.deviceId, port)} onClose={() => setPicker(null)} />
      )}

      {menu && byId.get(menu.id) && (
        <div className="ctx-menu" style={{ left: menu.sx, top: menu.sy }} onMouseLeave={() => setMenu(null)}>
          <button onClick={() => { p.onOpenConsole(menu.id); setMenu(null); }}>Abrir console</button>
          {byId.get(menu.id)!.host && <button onClick={() => { p.onConfigure(menu.id); setMenu(null); }}>Configuração IP…</button>}
          <button onClick={() => { client.send('device:power', { id: menu.id, on: !byId.get(menu.id)!.powered }); setMenu(null); }}>{byId.get(menu.id)!.powered ? 'Desligar' : 'Ligar'}</button>
          <button className="danger" onClick={() => { if (confirm('Remover equipamento?')) client.send('device:remove', { id: menu.id }); setMenu(null); }}>Remover</button>
        </div>
      )}

      <div className="zoom-ctl">
        <button onClick={() => setView({ ...view, zoom: Math.min(3, view.zoom * 1.2) })}>+</button>
        <button onClick={() => setView({ ...view, zoom: Math.max(0.3, view.zoom / 1.2) })}>−</button>
        <button title="Centralizar" onClick={() => {
          if (!devices.length) return;
          const xs = devices.map((d) => d.x);
          const ys = devices.map((d) => d.y);
          const minX = Math.min(...xs) - 100;
          const minY = Math.min(...ys) - 100;
          const w = Math.max(...xs) - minX + 100;
          const h = Math.max(...ys) - minY + 100;
          const zoom = Math.min(2, Math.max(0.3, Math.min(size.w / w, size.h / h)));
          setView({ zoom, x: minX - (size.w / zoom - w) / 2, y: minY - (size.h / zoom - h) / 2 });
        }}>⤢</button>
      </div>
    </div>
  );
}

function LinkShape({ l, a, b, da, db, selected, onClick }: { l: LinkView; a: { x: number; y: number }; b: { x: number; y: number }; da?: DeviceView; db?: DeviceView; selected: boolean; onClick(e: React.MouseEvent): void }) {
  const st = CABLE_STYLE[l.cable] ?? CABLE_STYLE.straight;
  const pa = portOf(da, l.a.port);
  const pb = portOf(db, l.b.port);
  const lerp = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ta = Math.min(0.45, 44 / len);
  const la = lerp(ta);
  const lb = lerp(1 - ta);
  const ma = lerp(Math.min(0.45, 62 / len));
  const mb = lerp(1 - Math.min(0.45, 62 / len));
  const mid = lerp(0.5);
  return (
    <g className="link" onMouseDown={(e) => e.stopPropagation()} onClick={onClick}>
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth="14" />
      {selected && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#93c5fd" strokeWidth="8" />}
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={l.failed ? '#dc2626' : st.stroke} strokeWidth="2" strokeDasharray={st.dash} />
      <circle cx={la.x} cy={la.y} r="5" fill={LED_COLOR[pa?.led ?? 'off']} stroke="white" />
      <circle cx={lb.x} cy={lb.y} r="5" fill={LED_COLOR[pb?.led ?? 'off']} stroke="white" />
      <text x={ma.x} y={ma.y - 6} className="port-label" textAnchor="middle">{pa?.short ?? l.a.port}</text>
      <text x={mb.x} y={mb.y - 6} className="port-label" textAnchor="middle">{pb?.short ?? l.b.port}</text>
      {l.failed && <text x={mid.x} y={mid.y + 5} textAnchor="middle" fontSize="16" fill="#dc2626">✕</text>}
    </g>
  );
}

function PortPicker({ device, x, y, onPick, onClose }: { device: DeviceView; x: number; y: number; onPick(p: string): void; onClose(): void }) {
  return (
    <div className="port-picker" style={{ left: Math.min(x, window.innerWidth - 260), top: Math.min(y, window.innerHeight - 320) }} onMouseLeave={onClose}>
      <div className="pp-title">{device.name} — escolha a porta</div>
      <div className="pp-list">
        {device.ports.map((pt) => (
          <button key={pt.name} disabled={pt.connected} onClick={() => onPick(pt.name)} title={pt.connected ? 'Porta em uso' : pt.info}>
            <span className={`led led-${pt.connected ? pt.led : 'off'}`} /> {pt.name}
          </button>
        ))}
      </div>
    </div>
  );
}
