import Database from "better-sqlite3";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";

let db: Database.Database | null = null;

/**
 * Where to put cache.db.
 *
 * - Dev (`npm run dev`): project root (right next to package.json).
 * - Installed build: the same folder as the .exe (NSIS installs to a
 *   user-writable location when perMachine=false).
 *
 * This keeps the database with the app instead of hiding it in %APPDATA%.
 * Trade-off: if you delete / move the install folder, the cache goes with it.
 */
function cacheDbPath(): string {
  const dir = app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath();
  return path.join(dir, "cache.db");
}

export function getDb(): Database.Database {
  if (db) return db;
  const file = cacheDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  addColumns(db);
  migrateRoots(db);
  return db;
}

/**
 * Columns added after the first release. SQLite has no ADD COLUMN IF NOT
 * EXISTS, so check table_info first.
 *  - rating 0–5 and favorite 0/1: mirrored into the cover's XMP when it can be.
 *  - is_archive: the row is a .cbz/.zip file read as one chapter, not a directory.
 */
function addColumns(d: Database.Database): void {
  const have = new Set((d.prepare("PRAGMA table_info(folders)").all() as { name: string }[]).map((c) => c.name));
  const add = (name: string, def: string) => {
    if (!have.has(name)) d.exec(`ALTER TABLE folders ADD COLUMN ${name} ${def}`);
  };
  add("rating", "INTEGER NOT NULL DEFAULT 0");
  add("favorite", "INTEGER NOT NULL DEFAULT 0");
  add("is_archive", "INTEGER NOT NULL DEFAULT 0");
}

/**
 * Older versions kept a single `meta.root_path`, and every root ever picked
 * stayed in `folders` as a parent-less row. Turn all of those into entries in
 * `roots` (once), so nothing scanned before disappears.
 */
function migrateRoots(d: Database.Database): void {
  const has = d.prepare("SELECT COUNT(*) AS n FROM roots").get() as { n: number };
  if (has.n > 0) return;
  const candidates = (d.prepare("SELECT path FROM folders WHERE parent_id IS NULL").all() as { path: string }[]).map(
    (r) => r.path
  );
  const legacy = d.prepare("SELECT value FROM meta WHERE key = 'root_path'").get() as { value: string } | undefined;
  if (legacy && !candidates.includes(legacy.value)) candidates.push(legacy.value);
  const now = Math.floor(Date.now() / 1000);
  const ins = d.prepare("INSERT OR IGNORE INTO roots(path, added_at) VALUES (?, ?)");
  d.transaction(() => {
    for (const p of candidates) ins.run(p, now);
    d.prepare("DELETE FROM meta WHERE key = 'root_path'").run();
  })();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS folders (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  parent_id    INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  depth        INTEGER NOT NULL,
  image_count  INTEGER NOT NULL DEFAULT 0,
  cover_path   TEXT,
  mtime        INTEGER NOT NULL,
  last_scanned INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS folder_tags (
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source    TEXT NOT NULL,
  PRIMARY KEY (folder_id, tag_id, source)
);
CREATE INDEX IF NOT EXISTS idx_folder_tags_tag ON folder_tags(tag_id);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Library folders the user added. Each is scanned into a parent-less row in folders.
CREATE TABLE IF NOT EXISTS roots (
  id       INTEGER PRIMARY KEY,
  path     TEXT NOT NULL UNIQUE,
  added_at INTEGER NOT NULL
);
`;

export function upsertTag(name: string): number {
  const d = getDb();
  d.prepare("INSERT OR IGNORE INTO tags(name) VALUES (?)").run(name);
  const row = d.prepare("SELECT id FROM tags WHERE name = ?").get(name) as { id: number };
  return row.id;
}

export function getMeta(key: string): string | null {
  const r = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}
