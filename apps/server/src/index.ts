import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { MODELS, buildPcap, emptyDoc, sampleLab, type LabDoc, type Role } from '@webptracer/core';
import { deleteLab, getLab, listLabs, saveLab } from './db.js';
import { Room } from './room.js';

const PORT = Number(process.env.PORT ?? 3001);
const app = express();
app.use(express.json({ limit: '10mb' }));
const http = createServer(app);
const io = new Server(http, { cors: { origin: true } });

const rooms = new Map<string, Room>();

function room(id: string): Room | null {
  let r = rooms.get(id);
  if (r) return r;
  const doc = getLab(id);
  if (!doc) return null;
  r = new Room(id, doc, io);
  rooms.set(id, r);
  return r;
}

function newLabId() {
  return randomUUID().slice(0, 8);
}

// ------------------------------------------------------------------------- REST

app.get('/api/models', (_req, res) => {
  res.json(Object.values(MODELS));
});

app.get('/api/labs', (_req, res) => {
  res.json(listLabs());
});

app.post('/api/labs', (req, res) => {
  const { name, template } = req.body as { name?: string; template?: 'empty' | 'sample' };
  const doc: LabDoc = template === 'sample' ? sampleLab() : emptyDoc(name || 'Novo laboratório');
  if (name) doc.name = name;
  const id = newLabId();
  saveLab(id, doc);
  res.json({ id });
});

app.post('/api/labs/import', (req, res) => {
  const doc = req.body as LabDoc;
  if (!doc || doc.version !== 1 || !Array.isArray(doc.devices)) {
    res.status(400).json({ error: 'Arquivo de laboratório inválido' });
    return;
  }
  const id = newLabId();
  saveLab(id, doc);
  res.json({ id });
});

app.get('/api/labs/:id/export', (req, res) => {
  const r = rooms.get(req.params.id);
  const doc = r ? r.lab.toDoc() : getLab(req.params.id);
  if (!doc) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Disposition', `attachment; filename="${doc.name.replace(/[^\w\-]+/g, '_')}.webptracer.json"`);
  res.json(doc);
});

app.delete('/api/labs/:id', (req, res) => {
  const r = rooms.get(req.params.id);
  if (r) {
    r.dispose();
    rooms.delete(req.params.id);
  }
  deleteLab(req.params.id);
  res.json({ ok: true });
});

app.get('/api/labs/:id/pcap/:linkId', (req, res) => {
  const r = rooms.get(req.params.id);
  if (!r) {
    res.status(404).end();
    return;
  }
  const frames = r.capture(req.params.linkId).filter((e) => !e.dropped);
  const bytes = buildPcap(frames.map((e) => ({ time: e.time, frame: e.frame })));
  res.setHeader('Content-Type', 'application/vnd.tcpdump.pcap');
  res.setHeader('Content-Disposition', `attachment; filename="captura-${req.params.linkId}.pcap"`);
  res.send(Buffer.from(bytes));
});

// Production: serve the built web app.
const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, '../../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile(resolve(webDist, 'index.html')));
}

// ------------------------------------------------------------------------- sockets

io.on('connection', (socket) => {
  let current: Room | null = null;
  socket.on('join', (a: { labId: string; name: string; role: Role }, ack?: (r: unknown) => void) => {
    if (current) current.leave(socket.id);
    const r = room(a.labId);
    if (!r) {
      ack?.({ error: 'Laboratório não encontrado' });
      return;
    }
    current = r;
    r.join(socket, String(a.name ?? '').slice(0, 40), a.role === 'professor' ? 'professor' : 'aluno');
    ack?.({ ok: true });
  });
  socket.on('disconnect', () => {
    if (!current) return;
    current.leave(socket.id);
    if (current.empty) {
      const r = current;
      // Keep the simulation alive briefly in case the user reconnects (page reload).
      setTimeout(() => {
        if (r.empty && rooms.get(r.id) === r) {
          r.dispose();
          rooms.delete(r.id);
        }
      }, 60_000);
    }
  });
});

// Seed a sample lab on first start.
if (listLabs().length === 0) saveLab('exemplo', sampleLab());

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const r of rooms.values()) r.dispose();
    process.exit(0);
  });
}

http.listen(PORT, () => {
  console.log(`webptracer server on http://localhost:${PORT}`);
});
