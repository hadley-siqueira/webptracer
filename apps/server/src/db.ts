/**
 * Persistence with Drizzle ORM. SQLite for now; switching to PostgreSQL means changing the
 * table builders (sqliteTable -> pgTable) and the driver in this file only.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { desc, eq } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LabDoc } from '@webptracer/core';

export const labs = sqliteTable('labs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  doc: text('doc').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const commits = sqliteTable('commits', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  labId: text('lab_id').notNull(),
  message: text('message').notNull(),
  author: text('author').notNull(),
  doc: text('doc').notNull(),
  createdAt: integer('created_at').notNull(),
});

const here = dirname(fileURLToPath(import.meta.url));
const file = process.env.DB_FILE ?? resolve(here, '../data/webptracer.sqlite');
if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
const sqlite = new Database(file);
sqlite.pragma('journal_mode = WAL');
// Minimal schema migration (drizzle-kit can replace this when the schema grows).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS labs (id TEXT PRIMARY KEY, name TEXT NOT NULL, doc TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS commits (id INTEGER PRIMARY KEY AUTOINCREMENT, lab_id TEXT NOT NULL, message TEXT NOT NULL, author TEXT NOT NULL, doc TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS commits_lab ON commits(lab_id);
`);
export const db = drizzle(sqlite);

export function listLabs() {
  return db.select({ id: labs.id, name: labs.name, updatedAt: labs.updatedAt }).from(labs).orderBy(desc(labs.updatedAt)).all();
}

export function getLab(id: string): LabDoc | null {
  const row = db.select().from(labs).where(eq(labs.id, id)).get();
  return row ? (JSON.parse(row.doc) as LabDoc) : null;
}

export function saveLab(id: string, doc: LabDoc) {
  const now = Date.now();
  const json = JSON.stringify(doc);
  const exists = db.select({ id: labs.id }).from(labs).where(eq(labs.id, id)).get();
  if (exists) db.update(labs).set({ name: doc.name, doc: json, updatedAt: now }).where(eq(labs.id, id)).run();
  else db.insert(labs).values({ id, name: doc.name, doc: json, createdAt: now, updatedAt: now }).run();
}

export function deleteLab(id: string) {
  db.delete(commits).where(eq(commits.labId, id)).run();
  db.delete(labs).where(eq(labs.id, id)).run();
}

export function addCommit(labId: string, message: string, author: string, doc: LabDoc) {
  return db.insert(commits).values({ labId, message, author, doc: JSON.stringify(doc), createdAt: Date.now() }).returning({ id: commits.id }).get();
}

export function listCommits(labId: string) {
  return db
    .select({ id: commits.id, message: commits.message, author: commits.author, createdAt: commits.createdAt })
    .from(commits)
    .where(eq(commits.labId, labId))
    .orderBy(desc(commits.id))
    .all();
}

export function getCommit(id: number): { labId: string; doc: LabDoc } | null {
  const row = db.select().from(commits).where(eq(commits.id, id)).get();
  return row ? { labId: row.labId, doc: JSON.parse(row.doc) as LabDoc } : null;
}
