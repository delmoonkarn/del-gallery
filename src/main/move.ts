import fs from "node:fs/promises";
import path from "node:path";
import { getDb } from "./db";
import { closeArchive } from "./archive";
import { rebubbleCovers } from "./scanner";
import type { Progress } from "./meta";

export type MoveResult = { moved: number; leftLibrary: number; failed: { name: string; error: string }[] };

const SUBTREE = `
  WITH RECURSIVE sub(id) AS (
    SELECT ? UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
  )
`;

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The cached row for `dir`, creating rows for it (and any unscanned parents)
 * when it's inside a library folder but newer than the last scan — e.g. a
 * folder just made in Explorer. Null when `dir` is outside every library.
 */
function ensureFolderRow(dir: string): { id: number; depth: number } | null {
  const db = getDb();
  const find = db.prepare("SELECT id, depth FROM folders WHERE path = ? COLLATE NOCASE AND is_archive = 0");
  const hit = find.get(dir) as { id: number; depth: number } | undefined;
  if (hit) return hit;
  const roots = db.prepare("SELECT path FROM roots").all() as { path: string }[];
  if (!roots.some((r) => isInside(dir, r.path))) return null;

  const missing: string[] = [];
  let cur = dir;
  let parent: { id: number; depth: number } | undefined;
  while (!(parent = find.get(cur) as { id: number; depth: number } | undefined)) {
    missing.unshift(cur);
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(
    `INSERT INTO folders(path, parent_id, name, depth, image_count, cover_path, mtime, last_scanned)
     VALUES (?, ?, ?, ?, 0, NULL, ?, ?) RETURNING id`
  );
  for (const p of missing) {
    const row = ins.get(p, parent.id, path.basename(p), parent.depth + 1, now, now) as { id: number };
    parent = { id: row.id, depth: parent.depth + 1 };
  }
  return parent;
}

/**
 * Move folders (or .cbz/.zip chapters) into `destDir` with a plain rename —
 * same drive only, nothing is ever copied-then-deleted. Cached rows follow
 * the files, so ids, tags and ratings survive. Anything moved somewhere the
 * library doesn't know about drops out of the library (a rescan finds it
 * again if that place is inside a library folder).
 */
export async function moveFolders(ids: number[], picked: string, onProgress: Progress): Promise<MoveResult> {
  const db = getDb();
  const destDir = path.resolve(picked);
  const dest = ensureFolderRow(destDir);
  const result: MoveResult = { moved: 0, leftLibrary: 0, failed: [] };
  const get = db.prepare("SELECT id, path, name, parent_id, depth, is_archive FROM folders WHERE id = ?");

  for (let i = 0; i < ids.length; i++) {
    const row = get.get(ids[i]) as
      | { id: number; path: string; name: string; parent_id: number | null; depth: number; is_archive: number }
      | undefined;
    if (!row) continue;
    onProgress({ done: i, total: ids.length, current: row.name });
    const fail = (error: string) => result.failed.push({ name: row.name, error });

    if (row.parent_id == null) {
      fail("is a library folder itself — use Settings → Change location");
      continue;
    }
    const newPath = path.join(destDir, path.basename(row.path));
    if (newPath.toLowerCase() === row.path.toLowerCase()) continue;
    if (isInside(destDir, row.path)) {
      fail("can't move a folder into itself");
      continue;
    }
    try {
      await fs.access(newPath);
      fail(`"${path.basename(newPath)}" already exists there`);
      continue;
    } catch {
      /* free — good */
    }

    if (row.is_archive) closeArchive(row.path);
    try {
      await fs.rename(row.path, newPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      fail(code === "EXDEV" ? "destination is on another drive — move it in Explorer instead" : (e as Error).message);
      continue;
    }

    if (!dest) {
      db.prepare("DELETE FROM folders WHERE id = ?").run(row.id);
      result.leftLibrary++;
      result.moved++;
      continue;
    }

    const old = row.path;
    const remap = (p: string) =>
      p === old ? newPath : p.startsWith(old + path.sep) || p.startsWith(old + "|") ? newPath + p.slice(old.length) : p;
    const rows = db
      .prepare(`${SUBTREE} SELECT f.id, f.path, f.cover_path, f.depth FROM sub JOIN folders f ON f.id = sub.id`)
      .all(row.id) as { id: number; path: string; cover_path: string | null; depth: number }[];
    const shift = dest.depth + 1 - row.depth;
    const upd = db.prepare("UPDATE folders SET path = ?, cover_path = ?, depth = ? WHERE id = ?");
    try {
      db.transaction(() => {
        // A row already at the new path is stale (the disk said it's free).
        db.prepare("DELETE FROM folders WHERE path = ? AND id <> ?").run(newPath, row.id);
        for (const r of rows) upd.run(remap(r.path), r.cover_path ? remap(r.cover_path) : null, r.depth + shift, r.id);
        db.prepare("UPDATE folders SET parent_id = ? WHERE id = ?").run(dest.id, row.id);
      })();
    } catch (e) {
      fail(`moved on disk, but the cache couldn't follow (${(e as Error).message}) — rescan to fix`);
      continue;
    }
    result.moved++;
  }

  // Series folders that showed a moved chapter's cover need a new one.
  rebubbleCovers();
  onProgress({ done: ids.length, total: ids.length, current: "" });
  return result;
}
