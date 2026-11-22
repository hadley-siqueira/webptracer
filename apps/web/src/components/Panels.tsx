import { useEffect, useMemo, useRef, useState } from 'react';
import type { DeviceView, FaultView, GradeResult, HostConfig, Objective, TraceDetail, VersionInfo } from '@webptracer/core';
import { LabClient, PROTO_COLORS, useLab } from '../client';

const fmtTime = (ms: number) => {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(3).padStart(6, '0')}`;
};

// =========================================================================== device

export function DevicePanel({ client, id, onOpenConsole }: { client: LabClient; id: string; onOpenConsole(id: string): void }) {
  const snap = useLab(client, (s) => s.snapshot);
  const models = useLab(client, (s) => s.models);
  const d = snap?.devices.find((x) => x.id === id);
  if (!d) return <div className="panel-empty">Equipamento removido.</div>;
  const m = models.find((x) => x.id === d.model);
  return (
    <div className="panel">
      <h3>{d.name}</h3>
      <div className="muted">{m ? `${m.vendor} ${m.name}` : d.model}</div>
      <p className="small">{m?.description}</p>
      <div className="row">
        <button className="primary" onClick={() => onOpenConsole(d.id)} disabled={!d.powered}>Abrir console</button>
        <button onClick={() => client.send('device:power', { id: d.id, on: !d.powered })}>{d.powered ? '⏻ Desligar' : '⏻ Ligar'}</button>
      </div>
      {d.host && <HostForm client={client} d={d} />}
      <h4>Portas</h4>
      <table className="ports">
        <tbody>
          {d.ports.map((p) => (
            <tr key={p.name} title={p.info}>
              <td><span className={`led led-${p.led}`} /></td>
              <td>{p.short}</td>
              <td className="muted small">{p.connected ? (p.up ? 'up' : 'down') : '—'}</td>
              <td className="small">{p.connected ? p.info : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HostForm({ client, d }: { client: LabClient; d: DeviceView }) {
  const h = d.host!;
  const [cfg, setCfg] = useState<HostConfig>(h.cfg);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setCfg(h.cfg);
  }, [h.cfg, dirty]);
  const upd = (fn: (c: HostConfig) => void) => {
    const c = structuredClone(cfg);
    fn(c);
    setCfg(c);
    setDirty(true);
  };
  const apply = () => {
    client.send('host:config', { id: d.id, cfg });
    setDirty(false);
  };
  const e = h.eff;
  return (
    <div className="hostform">
      <h4>Configuração IP</h4>
      <label>Nome do host <input value={cfg.hostname} onChange={(ev) => upd((c) => (c.hostname = ev.target.value))} /></label>
      <div className="radio">
        <label><input type="radio" checked={cfg.ipv4.mode === 'dhcp'} onChange={() => upd((c) => (c.ipv4 = { mode: 'dhcp' }))} /> DHCP</label>
        <label><input type="radio" checked={cfg.ipv4.mode === 'static'} onChange={() => upd((c) => (c.ipv4 = { mode: 'static', addr: e.ipv4, mask: e.mask || '255.255.255.0', gateway: e.gateway, dns: e.dns }))} /> Estático</label>
      </div>
      {cfg.ipv4.mode === 'static' ? (
        <>
          <label>Endereço IPv4 <input value={cfg.ipv4.addr ?? ''} onChange={(ev) => upd((c) => (c.ipv4.addr = ev.target.value))} placeholder="192.168.1.10" /></label>
          <label>Máscara <input value={cfg.ipv4.mask ?? ''} onChange={(ev) => upd((c) => (c.ipv4.mask = ev.target.value))} placeholder="255.255.255.0" /></label>
          <label>Gateway padrão <input value={cfg.ipv4.gateway ?? ''} onChange={(ev) => upd((c) => (c.ipv4.gateway = ev.target.value))} placeholder="192.168.1.1" /></label>
          <label>Servidor DNS <input value={cfg.ipv4.dns?.[0] ?? ''} onChange={(ev) => upd((c) => (c.ipv4.dns = ev.target.value ? [ev.target.value] : []))} /></label>
        </>
      ) : (
        <div className="eff small">
          {e.dhcpState === 'bound' ? `Obtido por DHCP: ${e.ipv4} / ${e.mask}, gateway ${e.gateway || '—'}` : e.apipa ? `Sem resposta do DHCP: APIPA ${e.ipv4}` : 'Solicitando endereço ao servidor DHCP…'}
        </div>
      )}
      <div className="radio">
        IPv6:
        <label><input type="radio" checked={cfg.ipv6.mode === 'auto'} onChange={() => upd((c) => (c.ipv6 = { mode: 'auto' }))} /> Automático (SLAAC)</label>
        <label><input type="radio" checked={cfg.ipv6.mode === 'static'} onChange={() => upd((c) => (c.ipv6 = { mode: 'static', addr: '', gateway: '' }))} /> Estático</label>
        <label><input type="radio" checked={cfg.ipv6.mode === 'off'} onChange={() => upd((c) => (c.ipv6 = { mode: 'off' }))} /> Desligado</label>
      </div>
      {cfg.ipv6.mode === 'static' && (
        <>
          <label>Endereço/prefixo <input value={cfg.ipv6.addr ?? ''} onChange={(ev) => upd((c) => (c.ipv6.addr = ev.target.value))} placeholder="2001:db8:acad:1::10/64" /></label>
          <label>Gateway IPv6 <input value={cfg.ipv6.gateway ?? ''} onChange={(ev) => upd((c) => (c.ipv6.gateway = ev.target.value))} placeholder="fe80::1" /></label>
        </>
      )}
      <div className="eff small">
        {e.ipv6.map((a) => <div key={a}>IPv6: {a}</div>)}
        {e.linkLocal && <div>Link-local: {e.linkLocal}</div>}
        {e.gateway6 && <div>Gateway IPv6: {e.gateway6}</div>}
      </div>
      <button className="primary" disabled={!dirty} onClick={apply}>Aplicar</button>
    </div>
  );
}

export function LinkPanel({ client, id }: { client: LabClient; id: string }) {
  const snap = useLab(client, (s) => s.snapshot);
  const l = snap?.links.find((x) => x.id === id);
  if (!l || !snap) return <div className="panel-empty">Cabo removido.</div>;
  const name = (dev: string) => snap.devices.find((d) => d.id === dev)?.name ?? dev;
  const cableName = { straight: 'Par trançado direto', crossover: 'Par trançado cruzado', fiber: 'Fibra óptica', console: 'Console' }[l.cable];
  return (
    <div className="panel">
      <h3>Cabo</h3>
      <p>{name(l.a.device)} <b>{l.a.port}</b> ↔ {name(l.b.device)} <b>{l.b.port}</b></p>
      <p>Tipo: {cableName}</p>
      <p>Estado: {l.failed ? <span className="bad">rompido</span> : l.up ? <span className="good">ativo</span> : <span className="bad">sem sinal</span>}</p>
      {!l.up && !l.failed && <p className="small muted">Sem sinal: verifique se as portas estão ligadas (no shutdown), se os equipamentos estão ligados e se o tipo de cabo é adequado (portas sem auto-MDIX exigem cabo cruzado entre equipamentos iguais).</p>}
      <div className="row">
        <a className="button" href={`/api/labs/${snap.labId}/pcap/${l.id}`} download>⬇ Captura .pcap (Wireshark)</a>
        <button className="danger" onClick={() => client.send('link:remove', { id: l.id })}>Remover cabo</button>
      </div>
    </div>
  );
}

// =========================================================================== events

export function EventsPanel({ client }: { client: LabClient }) {
  const events = useLab(client, (s) => s.events);
  const filter = useLab(client, (s) => s.filter);
  const snap = useLab(client, (s) => s.snapshot);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const names = useMemo(() => new Map((snap?.devices ?? []).map((d) => [d.id, d.name])), [snap?.devices]);
  const shown = events.filter((e) => !filter.size || filter.has(e.proto));
  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight);
  }, [shown.length]);
  const protos = Object.keys(PROTO_COLORS);
  return (
    <div className="panel events">
      {snap?.mode !== 'simulation' && <p className="small muted">A lista de eventos é registrada no modo <b>Simulação</b>. Mude o modo na barra superior para acompanhar cada quadro passo a passo.</p>}
      <div className="filters">
        {protos.map((p) => (
          <button key={p} className={`chip ${filter.size && !filter.has(p) ? 'off' : ''}`} style={{ borderColor: PROTO_COLORS[p] }} onClick={() => client.toggleFilter(p)}>
            <span className="dot" style={{ background: PROTO_COLORS[p] }} /> {p}
          </button>
        ))}
        <button className="chip" onClick={() => client.clearEvents()}>Limpar</button>
      </div>
      <div className="event-list" ref={listRef}>
        <table>
          <thead>
            <tr><th>Tempo</th><th>De</th><th>Para</th><th>Tipo</th><th>Info</th></tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id} onClick={() => client.emit<TraceDetail>('trace:detail', { id: e.id }).then(setDetail)} className={e.dropped ? 'dropped' : ''}>
                <td>{fmtTime(e.time)}</td>
                <td>{names.get(e.from)}</td>
                <td>{names.get(e.to)}</td>
                <td><span className="dot" style={{ background: PROTO_COLORS[e.proto] ?? '#111' }} /> {e.proto}</td>
                <td className="small">{e.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail && <PduModal detail={detail} names={names} onClose={() => setDetail(null)} />}
    </div>
  );
}

function PduModal({ detail, names, onClose }: { detail: TraceDetail; names: Map<string, string>; onClose(): void }) {
  const t = detail.trace;
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>PDU: {names.get(t.from)} {t.fromPort} → {names.get(t.to)} {t.toPort}</h3>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="pdu">
          <div className="pdu-layers">
            {[...detail.layers].reverse().map((l, i) => (
              <div key={i} className="layer">
                <div className="layer-title">Camada {l.osi} — {l.title}</div>
                <table>
                  <tbody>
                    {l.fields.map(([k, v]) => (
                      <tr key={k}><td className="muted">{k}</td><td><code>{v}</code></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {detail.notes.length > 0 && (
              <div className="layer decisions">
                <div className="layer-title">O que {names.get(t.to)} fez com este quadro</div>
                <ul>{detail.notes.map((n, i) => <li key={i} className={n.level}>{n.text}</li>)}</ul>
              </div>
            )}
            {t.dropped && <div className="layer decisions"><div className="layer-title bad">Quadro descartado ({t.dropped})</div></div>}
          </div>
          <div>
            <div className="layer-title">Bytes no fio (hexadecimal)</div>
            <pre className="hex">{detail.hex}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

// =========================================================================== chat

export function ChatPanel({ client }: { client: LabClient }) {
  const chat = useLab(client, (s) => s.chat);
  const users = useLab(client, (s) => s.users);
  const [text, setText] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
    client.set({ unreadChat: 0 });
  }, [chat.length, client]);
  return (
    <div className="panel chat">
      <div className="users">
        {users.map((u) => (
          <span key={u.id} className="user" style={{ borderColor: u.color }}>
            <span className="dot" style={{ background: u.color }} /> {u.name}{u.role === 'professor' ? ' (prof.)' : ''}
          </span>
        ))}
      </div>
      <div className="messages" ref={ref}>
        {chat.map((m) => (
          <div key={m.id} className={m.system ? 'msg system' : 'msg'}>
            {!m.system && <b style={{ color: m.color }}>{m.user}: </b>}
            {m.text}
          </div>
        ))}
      </div>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) client.send('chat', { text });
        setText('');
      }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Mensagem para a turma…" />
      </form>
    </div>
  );
}

// =========================================================================== instructions

function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^#{1,3} /.test(l)) {
      const n = l.indexOf(' ');
      out.push(`<h${n + 1}>${inline(l.slice(n + 1))}</h${n + 1}>`);
    } else if (l.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        if (!/^\|[\s\-|]+\|$/.test(lines[i])) rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i++;
      }
      out.push('<table>' + rows.map((r, k) => '<tr>' + r.map((c) => (k ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`)).join('') + '</tr>').join('') + '</table>');
      continue;
    } else if (/^\d+\. /.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\d+\. /, ''))}</li>`);
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    } else if (/^[-*] /.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) items.push(`<li>${inline(lines[i++].slice(2))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    } else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
    i++;
  }
  return out.join('\n');
}

export function InstructionsPanel({ client }: { client: LabClient }) {
  const snap = useLab(client, (s) => s.snapshot);
  const me = useLab(client, (s) => s.me);
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState('');
  if (!snap) return null;
  if (edit)
    return (
      <div className="panel">
        <textarea className="md-edit" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row">
          <button className="primary" onClick={() => { client.send('lab:meta', { instructions: text }); setEdit(false); }}>Salvar</button>
          <button onClick={() => setEdit(false)}>Cancelar</button>
        </div>
      </div>
    );
  return (
    <div className="panel">
      <div className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(snap.instructions || '_Sem instruções._') }} />
      {me?.role === 'professor' && <button onClick={() => { setText(snap.instructions); setEdit(true); }}>Editar instruções</button>}
    </div>
  );
}

// =========================================================================== objectives

export function ObjectivesPanel({ client }: { client: LabClient }) {
  const snap = useLab(client, (s) => s.snapshot);
  const me = useLab(client, (s) => s.me);
  const [result, setResult] = useState<GradeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  if (!snap) return null;
  const names = new Map(snap.devices.map((d) => [d.id, d.name]));
  const res = new Map((result?.results ?? []).map((r) => [r.id, r]));
  const describe = (o: Objective) => {
    const c = o.check;
    if (c.kind === 'ping') return `ping de ${names.get(c.from)} para ${c.to} deve ${c.expect === 'success' ? 'funcionar' : 'falhar'}`;
    if (c.kind === 'dhcp') return `${names.get(c.device)} obtém endereço por DHCP`;
    return `configuração de ${names.get(c.device)} ${c.expect ? 'contém' : 'não contém'} /${c.pattern}/`;
  };
  const remove = (id: string) => client.send('objectives:set', { objectives: snap.objectives.filter((o) => o.id !== id) });
  return (
    <div className="panel">
      <p className="small muted">A verificação é feita pelo <b>comportamento</b> da rede: o laboratório é reconstruído, o tempo avança até os protocolos convergirem e cada objetivo é testado (por exemplo, enviando um ping). Qualquer solução correta é aceita.</p>
      <button className="primary" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          setResult(await client.emit<GradeResult>('grade'));
        } finally {
          setBusy(false);
        }
      }}>{busy ? 'Verificando…' : '✔ Verificar meu laboratório'}</button>
      {result && <div className="score">Nota: {result.score} / {result.total}</div>}
      <ul className="objectives">
        {snap.objectives.map((o) => {
          const r = res.get(o.id);
          return (
            <li key={o.id} className={r ? (r.ok ? 'ok' : 'fail') : ''}>
              <span className="mark">{r ? (r.ok ? '✔' : '✘') : '○'}</span>
              <div>
                <div>{o.title} <span className="muted small">({o.points} pt)</span></div>
                <div className="small muted">{r ? r.detail : describe(o)}</div>
              </div>
              {me?.role === 'professor' && <button className="tiny" onClick={() => remove(o.id)}>✕</button>}
            </li>
          );
        })}
      </ul>
      {me?.role === 'professor' && (adding ? <ObjectiveForm client={client} onDone={() => setAdding(false)} /> : <button onClick={() => setAdding(true)}>+ Novo objetivo</button>)}
    </div>
  );
}

function ObjectiveForm({ client, onDone }: { client: LabClient; onDone(): void }) {
  const snap = useLab(client, (s) => s.snapshot)!;
  const [kind, setKind] = useState<'ping' | 'dhcp' | 'config'>('ping');
  const [title, setTitle] = useState('');
  const [dev, setDev] = useState(snap.devices[0]?.id ?? '');
  const [to, setTo] = useState('');
  const [expect, setExpect] = useState(true);
  const [pattern, setPattern] = useState('');
  const [points, setPoints] = useState(1);
  const save = () => {
    const check: Objective['check'] =
      kind === 'ping' ? { kind, from: dev, to, expect: expect ? 'success' : 'fail' } : kind === 'dhcp' ? { kind, device: dev } : { kind, device: dev, pattern, expect };
    const o: Objective = { id: `o${Date.now().toString(36)}`, title: title || 'Objetivo', check, points };
    client.send('objectives:set', { objectives: [...snap.objectives, o] });
    onDone();
  };
  return (
    <div className="objform">
      <label>Título <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>Tipo
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="ping">Conectividade (ping)</option>
          <option value="dhcp">Host obtém IP por DHCP</option>
          <option value="config">Configuração contém texto (regex)</option>
        </select>
      </label>
      <label>Equipamento
        <select value={dev} onChange={(e) => setDev(e.target.value)}>
          {snap.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      {kind === 'ping' && <label>Destino (IPv4 ou IPv6) <input value={to} onChange={(e) => setTo(e.target.value)} /></label>}
      {kind === 'config' && <label>Expressão regular <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="^ip route 0\.0\.0\.0" /></label>}
      {kind !== 'dhcp' && <label className="inline"><input type="checkbox" checked={expect} onChange={(e) => setExpect(e.target.checked)} /> {kind === 'ping' ? 'deve funcionar' : 'deve conter'}</label>}
      <label>Pontos <input type="number" min={0} value={points} onChange={(e) => setPoints(Number(e.target.value))} /></label>
      <div className="row"><button className="primary" onClick={save}>Adicionar</button><button onClick={onDone}>Cancelar</button></div>
    </div>
  );
}

// =========================================================================== versions

export function VersionsPanel({ client }: { client: LabClient }) {
  const [list, setList] = useState<VersionInfo[]>([]);
  const [msg, setMsg] = useState('');
  const reload = () => client.emit<VersionInfo[]>('version:list').then(setList);
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="panel">
      <p className="small muted">Salve versões (como um <i>commit</i>) antes de testar algo arriscado; você pode voltar a qualquer versão.</p>
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        await client.emit('version:commit', { message: msg });
        setMsg('');
        reload();
      }}>
        <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Descrição (ex.: VLANs configuradas)" />
        <button className="primary">Salvar versão</button>
      </form>
      <ul className="versions">
        {list.map((v) => (
          <li key={v.id}>
            <div><b>#{v.id}</b> {v.message}</div>
            <div className="small muted">{v.author} · {new Date(v.createdAt).toLocaleString('pt-BR')}</div>
            <button className="tiny" onClick={() => { if (confirm(`Restaurar a versão #${v.id}? As alterações não salvas serão perdidas.`)) client.send('version:restore', { id: v.id }); }}>Restaurar</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// =========================================================================== chaos

export function ChaosPanel({ client }: { client: LabClient }) {
  const [faults, setFaults] = useState<FaultView[]>([]);
  useEffect(() => {
    client.emit<FaultView[]>('chaos:list').then(setFaults).catch(() => {});
  }, [client]);
  return (
    <div className="panel">
      <p className="small muted"><b>Modo caos</b>: injeta uma falha aleatória (cabo rompido, interface desativada, VLAN errada, gateway ou máscara incorretos, rota removida) para os alunos praticarem a resolução de problemas. A descrição fica visível só para o professor.</p>
      <button className="danger" onClick={() => client.emit<FaultView[]>('chaos:inject').then(setFaults)}>⚡ Injetar falha aleatória</button>
      <ul className="versions">
        {faults.map((f) => (
          <li key={f.id}>
            <div>{f.description}</div>
            <div className="small muted">{new Date(f.time).toLocaleTimeString('pt-BR')} · dica: {f.hint}</div>
            <div className="row">
              <button className="tiny" onClick={() => client.send('chaos:hint', { id: f.id })}>Enviar dica</button>
              <button className="tiny" onClick={() => client.emit<FaultView[]>('chaos:revert', { id: f.id }).then(setFaults)}>Desfazer</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
