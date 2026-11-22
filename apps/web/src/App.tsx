import { useEffect, useState } from 'react';
import type { Role } from '@webptracer/core';
import { LabView } from './components/LabView';

interface LabItem {
  id: string;
  name: string;
  updatedAt: number;
}

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function Home({ onOpen }: { onOpen(id: string): void }) {
  const [labs, setLabs] = useState<LabItem[]>([]);
  const [name, setName] = useState('');
  const load = () => fetch('/api/labs').then((r) => r.json()).then(setLabs);
  useEffect(() => {
    load();
  }, []);
  const create = async (template: 'empty' | 'sample') => {
    const r = await fetch('/api/labs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name || undefined, template }) }).then((x) => x.json());
    onOpen(r.id);
  };
  const importFile = async (f: File) => {
    const text = await f.text();
    const r = await fetch('/api/labs/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text }).then((x) => x.json());
    if (r.error) alert(r.error);
    else onOpen(r.id);
  };
  return (
    <div className="home">
      <header>
        <h1>webptracer</h1>
        <p>Simulador educacional de redes de computadores na Web: topologia visual, CLI realista, visão física em rack, animação de pacotes e colaboração em tempo real.</p>
      </header>
      <section className="card">
        <h2>Novo laboratório</h2>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do laboratório" />
          <button className="primary" onClick={() => create('empty')}>Criar vazio</button>
          <button onClick={() => create('sample')}>Criar a partir do exemplo</button>
          <label className="button">
            Importar arquivo…
            <input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </label>
        </div>
      </section>
      <section className="card">
        <h2>Laboratórios</h2>
        <table className="labs">
          <tbody>
            {labs.map((l) => (
              <tr key={l.id}>
                <td><a href={`#/lab/${l.id}`}>{l.name}</a></td>
                <td className="muted small">{new Date(l.updatedAt).toLocaleString('pt-BR')}</td>
                <td className="muted small">link: <code>{location.origin}/#/lab/{l.id}</code></td>
                <td>
                  <button className="tiny danger" onClick={async () => {
                    if (!confirm(`Excluir "${l.name}"?`)) return;
                    await fetch(`/api/labs/${l.id}`, { method: 'DELETE' });
                    load();
                  }}>Excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Login({ onDone }: { onDone(name: string, role: Role): void }) {
  const [name, setName] = useState(localStorage.getItem('wpt-name') ?? '');
  const [role, setRole] = useState<Role>((localStorage.getItem('wpt-role') as Role) ?? 'aluno');
  return (
    <div className="modal-bg">
      <form className="modal" onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        localStorage.setItem('wpt-name', name.trim());
        localStorage.setItem('wpt-role', role);
        onDone(name.trim(), role);
      }}>
        <h3>Entrar no laboratório</h3>
        <label>Seu nome <input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="radio">
          <label><input type="radio" checked={role === 'aluno'} onChange={() => setRole('aluno')} /> Aluno</label>
          <label><input type="radio" checked={role === 'professor'} onChange={() => setRole('professor')} /> Professor</label>
        </div>
        <button className="primary">Entrar</button>
      </form>
    </div>
  );
}

export function App() {
  const hash = useHash();
  const [user, setUser] = useState<{ name: string; role: Role } | null>(null);
  const m = /^#\/lab\/([\w-]+)/.exec(hash);
  if (!m) return <Home onOpen={(id) => (location.hash = `#/lab/${id}`)} />;
  if (!user) return <Login onDone={(name, role) => setUser({ name, role })} />;
  return <LabView labId={m[1]} name={user.name} role={user.role} onExit={() => (location.hash = '')} />;
}
