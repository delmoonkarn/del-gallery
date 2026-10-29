import fs from "node:fs/promises";
import path from "node:path";
import { getDb } from "./db";

export type RootInfo = {
  id: number;
  path: string;
  name: string;
  online: boolean;
  chapters: number;
  pages: number;
  lastScanned: number | null;
};

// Case-insensitive on purpose: Windows paths.
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function cleanPath(p: string): string {
  let r = path.resolve(p);
  if (r.length > 3 && /[\\/]$/.test(r)) r = r.slice(0, -1);
  return r;
}

const SUBTREE = `
  WITH RECURSIVE sub(id) AS (
    SELECT ? UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
  )
`;

export function rootById(id: number): { id: number; path: string } | null {
  return (getDb().prepare("SELECT id, path FROM roots WHERE id = ?").get(id) as { id: number; path: string }) ?? null;
}

/** The scanned parent-less folder row for a root, if it has been scanned. */
export function rootFolderId(rootId: number): number | null {
  const r = getDb()
    .prepare("SELECT f.id FROM folders f JOIN roots r ON r.path = f.path WHERE r.id = ?")
    .get(rootId) as { id: number } | undefined;
  return r?.id ?? null;
}

/** SQL fragment + params limiting `f.id` to one root's subtree (or nothing when rootId is null). */
export function rootScope(rootId: number | null | undefined): { cte: string; where: string; params: unknown[] } {
  if (rootId == null) return { cte: "", where: "", params: [] };
  return { cte: SUBTREE, where: "f.id IN (SELECT id FROM sub)", params: [rootFolderId(rootId) ?? -1] };
}

export async function listRoots(): Promise<RootInfo[]> {
  const db = getDb();
  const rows = db.prepare("SELECT id, path FROM roots ORDER BY path COLLATE NOCASE").all() as { id: number; path: string }[];
  const stats = db.prepare(
    `${SUBTREE}
     SELECT COALESCE(SUM(f.image_count > 0), 0) AS chapters, COALESCE(SUM(f.image_count), 0) AS pages
     FROM sub JOIN folders f ON f.id = sub.id`
  );
  return Promise.all(
    rows.map(async (r) => {
      const fid = rootFolderId(r.id);
      const s = fid != null ? (stats.get(fid) as { chapters: number; pages: number }) : { chapters: 0, pages: 0 };
      const last =
        fid != null
          ? (db.prepare("SELECT last_scanned FROM folders WHERE id = ?").get(fid) as { last_scanned: number }).last_scanned
          : null;
      const online = await fs.access(r.path).then(
        () => true,
        () => false
      );
      return { ...r, name: path.basename(r.path) || r.path, online, ...s, lastScanned: last };
    })
  );
}

/**
 * Add a library folder. One inside an existing root is refused; one that
 * contains existing roots absorbs them — their folder rows (and tags) are kept
 * and simply re-parented by the next scan.
 */
export function addRoot(p: string): { id: number; path: string; absorbed: number } {
  const db = getDb();
  const clean = cleanPath(p);
  const existing = db.prepare("SELECT id, path FROM roots").all() as { id: number; path: string }[];
  for (const r of existing) {
    if (isInside(clean, r.path)) throw new Error(`Already in your library (inside ${r.path})`);
  }
  const covered = existing.filter((r) => isInside(r.path, clean));
  const row = db.transaction(() => {
    for (const r of covered) db.prepare("DELETE FROM roots WHERE id = ?").run(r.id);
    return db
      .prepare("INSERT INTO roots(path, added_at) VALUES (?, ?) RETURNING id")
      .get(clean, Math.floor(Date.now() / 1000)) as { id: number };
  })();
  return { id: row.id, path: clean, absorbed: covered.length };
}

/** Forget a library folder: drops its cached folders/tags. Nothing on disk is touched. */
export function removeRoot(id: number): void {
  const db = getDb();
  const r = rootById(id);
  if (!r) return;
  db.transaction(() => {
    // ON DELETE CASCADE on parent_id takes the whole subtree + its folder_tags.
    db.prepare("DELETE FROM folders WHERE path = ?").run(r.path);
    db.prepare("DELETE FROM roots WHERE id = ?").run(id);
    db.prepare("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM folder_tags)").run();
  })();
}

/**
 * The folder moved, or the drive came back under another letter: rewrite the
 * cached paths instead of rescanning, so ids, tags and covers all survive.
 */
export function relocateRoot(id: number, newPath: string): string {
  const db = getDb();
  const r = rootById(id);
  if (!r) throw new Error("Unknown library folder");
  const clean = cleanPath(newPath);
  if (clean.toLowerCase() === r.path.toLowerCase()) return clean;
  const others = db.prepare("SELECT path FROM roots WHERE id <> ?").all(id) as { path: string }[];
  for (const o of others) {
    if (isInside(clean, o.path) || isInside(o.path, clean)) throw new Error(`Overlaps ${o.path}`);
  }

  const move = (p: string) => {
    const rel = path.relative(r.path, p);
    if (rel === "") return clean;
    return rel.startsWith("..") ? p : path.join(clean, rel);
  };
  const fid = rootFolderId(id);
  const rows =
    fid != null
      ? (db
          .prepare(`${SUBTREE} SELECT f.id, f.path, f.cover_path FROM sub JOIN folders f ON f.id = sub.id`)
          .all(fid) as { id: number; path: string; cover_path: string | null }[])
      : [];
  const upd = db.prepare("UPDATE folders SET path = ?, cover_path = ? WHERE id = ?");
  try {
    db.transaction(() => {
      for (const f of rows) upd.run(move(f.path), f.cover_path ? move(f.cover_path) : null, f.id);
      if (fid != null) db.prepare("UPDATE folders SET name = ? WHERE id = ?").run(path.basename(clean) || clean, fid);
      db.prepare("UPDATE roots SET path = ? WHERE id = ?").run(clean, id);
    })();
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) {
      throw new Error("Some folders at the new location are already in the library — remove that library folder first.");
    }
    throw e;
  }
  return clean;
}
