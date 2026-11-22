import { useMemo, useState } from 'react';
import type { DeviceView, HardwareModel, PanelItem } from '@webptracer/core';
import { LabClient, useLab } from '../client';
import { DeviceIcon } from './icons';

const U = 44;
const RACK_W = 480;
const RAIL = 22;
const LED: Record<string, string> = { green: '#22c55e', amber: '#f59e0b', off: '#374151', 'blink-green': '#22c55e', 'blink-amber': '#f59e0b' };
const CABLE: Record<string, string> = { straight: '#2563eb', crossover: '#db2777', fiber: '#f97316', console: '#0ea5e9' };

interface PortPos {
  x: number;
  y: number;
}

function Panel({ d, m, x, y, selected, onPick }: { d: DeviceView; m: HardwareModel; x: number; y: number; selected: boolean; onPick(): void }) {
  const h = Math.max(1, m.ru) * U;
  const portState = new Map(d.ports.map((p) => [p.name, p]));
  const deco = (it: PanelItem, i: number) => {
    switch (it.kind) {
      case 'label':
        return (
          <text key={i} x={it.x} y={it.y + 9} fontSize="9" fill="#e5e7eb" fontWeight="600">
            {it.label}
          </text>
        );
      case 'led':
        return (
          <g key={i}>
            <rect x={it.x} y={it.y} width={it.w} height={it.h} fill={d.powered ? '#22c55e' : '#374151'} rx="1" />
            <text x={it.x} y={it.y + 11} fontSize="5" fill="#cbd5e1">{it.label}</text>
          </g>
        );
      case 'console':
        return (
          <g key={i}>
            <rect x={it.x} y={it.y} width={it.w} height={it.h} fill="#7dd3fc" stroke="#0c4a6e" rx="1" />
            <text x={it.x - 2} y={it.y - 2} fontSize="5" fill="#bae6fd">{it.label}</text>
          </g>
        );
      case 'usb':
        return <rect key={i} x={it.x} y={it.y} width={it.w} height={it.h} fill="#111827" stroke="#9ca3af" />;
      case 'power':
        return (
          <g key={i}>
            <circle cx={it.x + 8} cy={it.y + 7} r="6" fill={d.powered ? '#16a34a' : '#4b5563'} stroke="#111" />
            <text x={it.x + 8} y={it.y + 10} fontSize="8" textAnchor="middle" fill="white">⏻</text>
          </g>
        );
      default:
        return null;
    }
  };
  return (
    <g transform={`translate(${x},${y})`} onMouseDown={(e) => { e.stopPropagation(); onPick(); }} style={{ cursor: 'grab' }}>
      <rect width={RACK_W} height={h - 2} fill={m.panelColor} stroke={selected ? '#60a5fa' : '#111827'} strokeWidth={selected ? 3 : 1} rx="2" />
      <rect x="0" y="0" width="12" height={h - 2} fill="#9ca3af" />
      <rect x={RACK_W - 12} y="0" width="12" height={h - 2} fill="#9ca3af" />
      <circle cx="6" cy="8" r="2.5" fill="#4b5563" />
      <circle cx={RACK_W - 6} cy="8" r="2.5" fill="#4b5563" />
      {m.decorations.map(deco)}
      {m.ports.map((ps) => {
        const st = portState.get(ps.name);
        const it = ps.panel;
        const led = LED[st?.led ?? 'off'];
        return (
          <g key={ps.name}>
            <title>{`${ps.name}${st ? ` — ${st.up ? 'up' : 'down'} — ${st.info}` : ''}`}</title>
            {it.kind === 'sfp' ? (
              <rect x={it.x} y={it.y} width={it.w} height={it.h} fill="#0f172a" stroke="#cbd5e1" />
            ) : (
              <g>
                <rect x={it.x} y={it.y} width={it.w} height={it.h} fill="#0f172a" stroke="#94a3b8" rx="1" />
                <rect x={it.x + 3} y={it.flipped ? it.y : it.y + it.h - 4} width={it.w - 6} height="4" fill="#334155" />
              </g>
            )}
            <rect x={it.x + 1} y={it.flipped ? it.y + it.h + 1 : it.y - 4} width="4" height="3" fill={led} />
            <rect x={it.x + it.w - 5} y={it.flipped ? it.y + it.h + 1 : it.y - 4} width="4" height="3" fill={st?.up ? '#22c55e' : '#374151'} />
          </g>
        );
      })}
      <text x={RACK_W - 70} y={h - 6} fontSize="10" fill="#f8fafc" fontWeight="700" textAnchor="end">{d.name}</text>
    </g>
  );
}

export function RackView({ client, selected, onSelect }: { client: LabClient; selected: string | null; onSelect(id: string): void }) {
  const snap = useLab(client, (s) => s.snapshot);
  const models = useLab(client, (s) => s.models);
  const [drag, setDrag] = useState<{ id: string; startY: number; u: number; rack: number; dy: number } | null>(null);
  const modelById = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);
  if (!snap || !models.length) return <div className="canvas-empty">Carregando…</div>;

  const racks = snap.racks.length ? snap.racks : [{ name: 'Rack 1', units: 24 }];
  const rackX = (r: number) => 60 + r * (RACK_W + RAIL * 2 + 80);
  const rackTop = 60;
  const portPos = new Map<string, PortPos>();
  const racked = snap.devices.filter((d) => d.rack && modelById.get(d.model)?.ru);
  const loose = snap.devices.filter((d) => !racked.includes(d));
  const deskY = rackTop + Math.max(...racks.map((r) => r.units)) * U + 80;

  for (const d of racked) {
    const m = modelById.get(d.model)!;
    const u = drag?.id === d.id ? Math.max(1, drag.u + Math.round(drag.dy / U)) : d.rack!.u;
    const x = rackX(d.rack!.rack) + RAIL;
    const y = rackTop + (u - 1) * U;
    for (const p of m.ports) portPos.set(`${d.id}|${p.name}`, { x: x + p.panel.x + p.panel.w / 2, y: y + p.panel.y + p.panel.h / 2 });
  }
  loose.forEach((d, i) => portPos.set(`${d.id}|${d.ports[0]?.name}`, { x: 80 + i * 130, y: deskY - 6 }));

  const width = Math.max(rackX(racks.length) + 40, 80 + loose.length * 130);
  const height = deskY + 120;

  return (
    <div className="rackview" onMouseMove={(e) => drag && setDrag({ ...drag, dy: e.clientY - drag.startY })} onMouseUp={() => {
      if (drag) {
        const u = Math.max(1, drag.u + Math.round(drag.dy / U));
        if (u !== drag.u) client.send('device:rack', { id: drag.id, rack: drag.rack, u });
        setDrag(null);
      }
    }}>
      <svg width={width} height={height}>
        {racks.map((r, i) => (
          <g key={i} transform={`translate(${rackX(i)},${rackTop})`}>
            <text x="0" y="-16" fontSize="14" fontWeight="700" fill="#1f2937">{r.name}</text>
            <rect x="0" y="-4" width={RACK_W + RAIL * 2} height={r.units * U + 8} fill="#1f2937" rx="4" />
            <rect x={RAIL} y="0" width={RACK_W} height={r.units * U} fill="#111827" />
            {Array.from({ length: r.units }, (_, k) => (
              <g key={k}>
                <text x={RAIL / 2} y={k * U + U / 2 + 4} fontSize="9" fill="#9ca3af" textAnchor="middle">{k + 1}</text>
                <line x1={RAIL} x2={RAIL + RACK_W} y1={k * U} y2={k * U} stroke="#1f2937" />
              </g>
            ))}
          </g>
        ))}
        {racked.map((d) => {
          const m = modelById.get(d.model)!;
          const u = drag?.id === d.id ? Math.max(1, drag.u + Math.round(drag.dy / U)) : d.rack!.u;
          return (
            <Panel key={d.id} d={d} m={m} x={rackX(d.rack!.rack) + RAIL} y={rackTop + (u - 1) * U} selected={selected === d.id} onPick={() => {
              onSelect(d.id);
            }} />
          );
        })}
        {racked.map((d) => (
          <rect key={`h${d.id}`} x={rackX(d.rack!.rack)} y={rackTop + (d.rack!.u - 1) * U} width={RAIL} height={(modelById.get(d.model)!.ru) * U} fill="transparent" style={{ cursor: 'ns-resize' }} onMouseDown={(e) => {
            e.stopPropagation();
            setDrag({ id: d.id, startY: e.clientY, u: d.rack!.u, rack: d.rack!.rack, dy: 0 });
          }}>
            <title>Arraste para mudar a posição no rack</title>
          </rect>
        ))}
        <text x="60" y={deskY - 50} fontSize="14" fontWeight="700" fill="#1f2937">Mesa / estações de trabalho</text>
        {loose.map((d, i) => (
          <g key={d.id} transform={`translate(${80 + i * 130},${deskY + 30})`} onMouseDown={() => onSelect(d.id)} style={{ cursor: 'pointer' }}>
            <DeviceIcon kind={d.kind} powered={d.powered} />
            <text y="40" textAnchor="middle" fontSize="12" fontWeight="600">{d.name}</text>
            <rect x="-7" y="-42" width="14" height="10" fill="#0f172a" />
            <rect x="-6" y="-46" width="4" height="3" fill={LED[d.ports[0]?.led ?? 'off']} />
          </g>
        ))}
        {snap.links.map((l) => {
          const a = portPos.get(`${l.a.device}|${l.a.port}`);
          const b = portPos.get(`${l.b.device}|${l.b.port}`);
          if (!a || !b) return null;
          const sag = 40 + Math.abs(a.x - b.x) * 0.1;
          const path = `M${a.x},${a.y} C${a.x},${a.y + sag} ${b.x},${b.y + sag} ${b.x},${b.y}`;
          return (
            <g key={l.id} pointerEvents="none">
              <path d={path} stroke="#0f172a" strokeWidth="4.5" fill="none" opacity="0.35" />
              <path d={path} stroke={l.failed ? '#dc2626' : CABLE[l.cable]} strokeWidth="3" fill="none" strokeDasharray={l.failed ? '6 4' : undefined} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
