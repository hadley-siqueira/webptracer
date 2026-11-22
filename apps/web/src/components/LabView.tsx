import { useEffect, useMemo, useState } from 'react';
import { LabClient, useLab } from '../client';
import type { Role } from '@webptracer/core';
import { Topology, type CableChoice, type Tool } from './Topology';
import { RackView } from './RackView';
import { DeviceTerminal } from './Terminal';
import { DeviceIcon } from './icons';
import { ChaosPanel, ChatPanel, DevicePanel, EventsPanel, InstructionsPanel, LinkPanel, ObjectivesPanel, VersionsPanel } from './Panels';

type Tab = 'device' | 'events' | 'chat' | 'instructions' | 'objectives' | 'versions' | 'chaos';

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
}

export function LabView({ labId, name, role, onExit }: { labId: string; name: string; role: Role; onExit(): void }) {
  const client = useMemo(() => new LabClient(labId, name, role), [labId, name, role]);
  useEffect(() => () => client.close(), [client]);
  const snap = useLab(client, (s) => s.snapshot);
  const connected = useLab(client, (s) => s.connected);
  const models = useLab(client, (s) => s.models);
  const toasts = useLab(client, (s) => s.toasts);
  const unread = useLab(client, (s) => s.unreadChat);
  const me = useLab(client, (s) => s.me);
  const [view, setView] = useState<'logical' | 'physical'>('logical');
  const [tool, setTool] = useState<Tool>('select');
  const [cable, setCable] = useState<CableChoice>('auto');
  const [selected, setSelected] = useState<{ type: 'device' | 'link'; id: string } | null>(null);
  const [tab, setTab] = useState<Tab>('instructions');
  const [terms, setTerms] = useState<string[]>([]);
  const [activeTerm, setActiveTerm] = useState<string | null>(null);
  const [termHeight, setTermHeight] = useState(300);

  const openConsole = (id: string) => {
    setTerms((t) => (t.includes(id) ? t : [...t, id]));
    setActiveTerm(id);
  };
  const closeConsole = (id: string) => {
    setTerms((t) => t.filter((x) => x !== id));
    if (activeTerm === id) setActiveTerm(terms.find((x) => x !== id) ?? null);
  };
  const select = (sel: { type: 'device' | 'link'; id: string } | null) => {
    setSelected(sel);
    // In simulation mode the event list stays visible while the student clicks around.
    if (sel && tab !== 'events') setTab('device');
  };

  useEffect(() => {
    // Close consoles of removed devices.
    if (!snap) return;
    const ids = new Set(snap.devices.map((d) => d.id));
    setTerms((t) => t.filter((x) => ids.has(x)));
  }, [snap]);

  if (!snap) return <div className="loading">{connected ? 'Carregando laboratório…' : 'Conectando ao servidor…'}</div>;
  const sim = snap.mode === 'simulation';
  const groups: [string, string[]][] = [
    ['Roteadores', ['router']],
    ['Switches', ['switch', 'l3switch', 'hub']],
    ['Computadores', ['pc', 'laptop', 'server']],
  ];
  const deviceName = (id: string) => snap.devices.find((d) => d.id === id)?.name ?? id;

  return (
    <div className="labview">
      <header className="toolbar">
        <button className="ghost" onClick={onExit} title="Voltar à lista de laboratórios">◀</button>
        <div className="title">
          <b>{snap.name}</b>
          <span className={`conn ${connected ? 'on' : 'off'}`}>{connected ? '● online' : '● desconectado'}</span>
        </div>
        <div className="seg">
          <button className={view === 'logical' ? 'on' : ''} onClick={() => setView('logical')}>Lógica</button>
          <button className={view === 'physical' ? 'on' : ''} onClick={() => setView('physical')}>Física (rack)</button>
        </div>
        <div className="seg">
          <button className={!sim ? 'on' : ''} onClick={() => client.send('sim:mode', { mode: 'realtime' })} title="O tempo passa continuamente">⏱ Tempo real</button>
          <button className={sim ? 'on' : ''} onClick={() => { client.send('sim:mode', { mode: 'simulation' }); setTab('events'); }} title="Acompanhe cada quadro passo a passo">🔬 Simulação</button>
        </div>
        {sim ? (
          <div className="seg">
            <button onClick={() => client.send('sim:play', { playing: !snap.playing })}>{snap.playing ? '⏸ Pausar' : '▶ Reproduzir'}</button>
            <button onClick={() => client.send('sim:step')} disabled={snap.playing}>⏭ Próximo passo</button>
          </div>
        ) : (
          <div className="seg">
            {[1, 2, 5, 10].map((s) => (
              <button key={s} className={snap.speed === s ? 'on' : ''} onClick={() => client.send('sim:speed', { speed: s })}>{s}×</button>
            ))}
          </div>
        )}
        <button onClick={() => client.send('sim:advance', { ms: 30_000 })} title="Avança 30 segundos do relógio da simulação (ex.: convergência do STP)">+30 s</button>
        <span className="clock" title="Relógio da simulação">{clock(snap.now)}</span>
        <div className="spacer" />
        <a className="button ghost" href={`/api/labs/${labId}/export`} title="Baixar o laboratório (JSON)">⬇ Exportar</a>
        <span className="me" style={{ borderColor: me?.color }}>{name} · {role}</span>
      </header>

      <div className="main">
        <aside className="palette">
          <div className="tools">
            <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')} title="Selecionar e mover">↖</button>
            <button className={tool === 'cable' ? 'on' : ''} onClick={() => setTool('cable')} title="Conectar cabo">〰</button>
            <button className={tool === 'delete' ? 'on' : ''} onClick={() => setTool('delete')} title="Remover">🗑</button>
          </div>
          {tool === 'cable' && (
            <select value={cable} onChange={(e) => setCable(e.target.value as CableChoice)} title="Tipo de cabo">
              <option value="auto">Automático</option>
              <option value="straight">Direto</option>
              <option value="crossover">Cruzado</option>
              <option value="fiber">Fibra</option>
            </select>
          )}
          {groups.map(([label, kinds]) => (
            <div key={label} className="group">
              <div className="group-title">{label}</div>
              {models
                .filter((m) => kinds.includes(m.kind))
                .map((m) => (
                  <div key={m.id} className="model" draggable onDragStart={(e) => e.dataTransfer.setData('text/x-model', m.id)} title={`${m.description}\nArraste para a área de trabalho.`}>
                    <svg width="60" height="46" viewBox="-30 -26 60 50"><DeviceIcon kind={m.kind} /></svg>
                    <span>{m.name}</span>
                  </div>
                ))}
            </div>
          ))}
        </aside>

        <section className="center">
          <div className="canvas">
            {view === 'logical' ? (
              <Topology client={client} tool={tool} cable={cable} selected={selected} onSelect={select} onOpenConsole={openConsole} onConfigure={(id) => select({ type: 'device', id })} onToolDone={() => setTool('select')} />
            ) : (
              <RackView client={client} selected={selected?.type === 'device' ? selected.id : null} onSelect={(id) => select({ type: 'device', id })} />
            )}
          </div>
          {terms.length > 0 && (
            <div className="terminals" style={{ height: termHeight }}>
              <div className="resize" onMouseDown={(e) => {
                const startY = e.clientY;
                const startH = termHeight;
                const move = (ev: MouseEvent) => setTermHeight(Math.max(120, Math.min(window.innerHeight - 200, startH - (ev.clientY - startY))));
                const up = () => {
                  window.removeEventListener('mousemove', move);
                  window.removeEventListener('mouseup', up);
                };
                window.addEventListener('mousemove', move);
                window.addEventListener('mouseup', up);
              }} />
              <div className="term-tabs">
                {terms.map((id) => (
                  <div key={id} className={`term-tab ${activeTerm === id ? 'on' : ''}`} onClick={() => setActiveTerm(id)}>
                    {deviceName(id)}
                    <button onClick={(e) => { e.stopPropagation(); closeConsole(id); }}>✕</button>
                  </div>
                ))}
                <span className="small muted term-hint">Dicas: <code>?</code> ajuda · <code>Tab</code> completa · <code>↑</code> histórico · <code>Ctrl+C</code> interrompe · <code>Ctrl+Z</code> sai da configuração</span>
              </div>
              <div className="term-body">
                {terms.map((id) => (
                  <DeviceTerminal key={id} client={client} deviceId={id} active={activeTerm === id} />
                ))}
              </div>
            </div>
          )}
        </section>

        <aside className="side">
          <nav className="tabs">
            <button className={tab === 'device' ? 'on' : ''} onClick={() => setTab('device')}>Seleção</button>
            <button className={tab === 'events' ? 'on' : ''} onClick={() => setTab('events')}>Eventos</button>
            <button className={tab === 'instructions' ? 'on' : ''} onClick={() => setTab('instructions')}>Roteiro</button>
            <button className={tab === 'objectives' ? 'on' : ''} onClick={() => setTab('objectives')}>Objetivos</button>
            <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>Chat{unread && tab !== 'chat' ? ` (${unread})` : ''}</button>
            <button className={tab === 'versions' ? 'on' : ''} onClick={() => setTab('versions')}>Versões</button>
            {role === 'professor' && <button className={tab === 'chaos' ? 'on' : ''} onClick={() => setTab('chaos')}>Caos</button>}
          </nav>
          <div className="tab-body">
            {tab === 'device' && (selected?.type === 'device' ? <DevicePanel client={client} id={selected.id} onOpenConsole={openConsole} /> : selected?.type === 'link' ? <LinkPanel client={client} id={selected.id} /> : <div className="panel-empty">Selecione um equipamento ou cabo. Arraste equipamentos da paleta à esquerda e use a ferramenta 〰 para conectar cabos. Duplo clique abre o console.</div>)}
            {tab === 'events' && <EventsPanel client={client} />}
            {tab === 'chat' && <ChatPanel client={client} />}
            {tab === 'instructions' && <InstructionsPanel client={client} />}
            {tab === 'objectives' && <ObjectivesPanel client={client} />}
            {tab === 'versions' && <VersionsPanel client={client} />}
            {tab === 'chaos' && role === 'professor' && <ChaosPanel client={client} />}
          </div>
        </aside>
      </div>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}
