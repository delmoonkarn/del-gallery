import path from "node:path";
import { getDb, upsertTag } from "./db";
import { isJpegPath, readXmp, updateXmp } from "./xmp";
import { isEntryPath } from "./archive";

/**
 * Tags, star rating and favourite for one folder.
 *
 * They're written into the folder's own cover JPEG (XMP) whenever that's
 * possible, so they survive a cache wipe and show up in Windows Explorer.
 * Otherwise — archives, series folders whose cover belongs to a child, or a
 * PNG/WebP cover — they live in the DB only (tags with source 'user', which
 * the scanner never deletes). Bulk edits never convert image files.
 */

export type MetaPatch = {
  tags?: string[];
  /** Derive the new tag list from the current one (file tags when in-file, DB tags otherwise). */
  editTags?: (current: string[]) => string[];
  rating?: number;
  favorite?: boolean;
};

type Row = { id: number; path: string; image_count: number; cover_path: string | null; is_archive: number };

export function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** The JPEG we may write XMP into for this folder, or null for DB-only. */
function fileTarget(row: Row): string | null {
  if (row.is_archive || row.image_count === 0 || !row.cover_path) return null;
  if (isEntryPath(row.cover_path)) return null;
  // A bubbled-up cover belongs to a child folder — never write that.
  if (path.dirname(row.cover_path).toLowerCase() !== row.path.toLowerCase()) return null;
  return isJpegPath(row.cover_path) ? row.cover_path : null;
}

function dbTags(id: number, source?: "user"): string[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT t.name FROM tags t JOIN folder_tags ft ON ft.tag_id = t.id
         WHERE ft.folder_id = ? ${source ? "AND ft.source = 'user'" : ""} ORDER BY t.name`
      )
      .all(id) as { name: string }[]
  ).map((r) => r.name);
}

export function pruneUnusedTags(): void {
  getDb().prepare("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM folder_tags)").run();
}

/**
 * Apply `patch` to one folder. `strict` makes a cover that isn't really a
 * JPEG an error (the tag editor then re-encodes it and retries) instead of
 * quietly falling back to DB-only.
 */
export async function setFolderMeta(id: number, patch: MetaPatch, strict = false): Promise<{ inFile: boolean }> {
  const db = getDb();
  const row = db.prepare("SELECT id, path, image_count, cover_path, is_archive FROM folders WHERE id = ?").get(id) as
    | Row
    | undefined;
  if (!row) throw new Error("Folder not found");

  const target = fileTarget(row);
  let inFile = false;
  let tags: string[] | undefined = patch.tags ? dedupeTags(patch.tags) : undefined;

  if (target) {
    try {
      // DB-only tags from older versions get folded into the file on the way through.
      if (patch.editTags) tags = dedupeTags(patch.editTags([...(await readXmp(target)).tags, ...dbTags(id, "user")]));
      await updateXmp(target, {
        ...(tags ? { tags } : {}),
        ...(patch.rating !== undefined ? { rating: patch.rating } : {}),
        ...(patch.favorite !== undefined ? { favorite: patch.favorite } : {}),
      });
      inFile = true;
    } catch (e) {
      const msg = (e as Error).message;
      if (strict || !/not a JPEG|invalid JPEG/i.test(msg)) throw e;
    }
  }
  if (!inFile && patch.editTags) tags = dedupeTags(patch.editTags(dbTags(id)));

  db.transaction(() => {
    if (patch.rating !== undefined) {
      db.prepare("UPDATE folders SET rating = ? WHERE id = ?").run(Math.min(5, Math.max(0, Math.round(patch.rating))), id);
    }
    if (patch.favorite !== undefined) {
      db.prepare("UPDATE folders SET favorite = ? WHERE id = ?").run(patch.favorite ? 1 : 0, id);
    }
    if (tags) {
      db.prepare("DELETE FROM folder_tags WHERE folder_id = ? AND source IN ('xmp','user')").run(id);
      const ins = db.prepare("INSERT OR IGNORE INTO folder_tags(folder_id, tag_id, source) VALUES (?, ?, ?)");
      for (const t of tags) ins.run(id, upsertTag(t), inFile ? "xmp" : "user");
    }
  })();
  if (tags) pruneUnusedTags();
  return { inFile };
}

export type BulkOp = { addTags?: string[]; removeTags?: string[]; rating?: number; favorite?: boolean };
export type BulkResult = { updated: number; inFile: number; failed: { name: string; error: string }[] };
export type Progress = (p: { done: number; total: number; current: string }) => void;

/** Same edit on many folders (multi-select). One at a time — they're HDD writes. */
export async function bulkMeta(ids: number[], op: BulkOp, onProgress: Progress): Promise<BulkResult> {
  const add = dedupeTags(op.addTags ?? []);
  const remove = new Set((op.removeTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean));
  const touchTags = add.length > 0 || remove.size > 0;
  const result: BulkResult = { updated: 0, inFile: 0, failed: [] };
  const nameOf = getDb().prepare("SELECT name FROM folders WHERE id = ?");

  for (let i = 0; i < ids.length; i++) {
    const name = (nameOf.get(ids[i]) as { name: string } | undefined)?.name ?? `#${ids[i]}`;
    onProgress({ done: i, total: ids.length, current: name });
    try {
      const r = await setFolderMeta(ids[i], {
        ...(touchTags ? { editTags: (cur) => [...cur.filter((t) => !remove.has(t.toLowerCase())), ...add] } : {}),
        ...(op.rating !== undefined ? { rating: op.rating } : {}),
        ...(op.favorite !== undefined ? { favorite: op.favorite } : {}),
      });
      result.updated++;
      if (r.inFile) result.inFile++;
    } catch (e) {
      result.failed.push({ name, error: (e as Error).message });
    }
  }
  onProgress({ done: ids.length, total: ids.length, current: "" });
  return result;
}

function foldersWithTag(name: string): number[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT ft.folder_id AS id FROM folder_tags ft JOIN tags t ON t.id = ft.tag_id WHERE t.name = ? COLLATE NOCASE`
      )
      .all(name) as { id: number }[]
  ).map((r) => r.id);
}

/**
 * Rename a tag everywhere it's used. If `to` already exists the two merge.
 * A case-only rename ("comedy" → "Comedy") also works.
 */
export async function renameTag(from: string, to: string, onProgress: Progress): Promise<BulkResult> {
  const target = to.trim();
  if (!target) throw new Error("New tag name can't be empty");
  const fromLower = from.toLowerCase();
  const ids = foldersWithTag(from);
  const result: BulkResult = { updated: 0, inFile: 0, failed: [] };
  const nameOf = getDb().prepare("SELECT name FROM folders WHERE id = ?");
  for (let i = 0; i < ids.length; i++) {
    const name = (nameOf.get(ids[i]) as { name: string } | undefined)?.name ?? `#${ids[i]}`;
    onProgress({ done: i, total: ids.length, current: name });
    try {
      const r = await setFolderMeta(ids[i], {
        editTags: (cur) => {
          // Drop any existing copy of the target first, so a case-only rename keeps the new casing.
          const kept = cur.filter((t) => t.toLowerCase() !== target.toLowerCase() || t.toLowerCase() === fromLower);
          return kept.map((t) => (t.toLowerCase() === fromLower ? target : t));
        },
      });
      result.updated++;
      if (r.inFile) result.inFile++;
    } catch (e) {
      result.failed.push({ name, error: (e as Error).message });
    }
  }
  // tags.name is COLLATE NOCASE, so fix the stored casing of a case-only rename.
  getDb().prepare("UPDATE tags SET name = ? WHERE name = ? COLLATE NOCASE").run(target, target);
  pruneUnusedTags();
  onProgress({ done: ids.length, total: ids.length, current: "" });
  return result;
}

export async function deleteTag(name: string, onProgress: Progress): Promise<BulkResult> {
  const lower = name.toLowerCase();
  const ids = foldersWithTag(name);
  const result: BulkResult = { updated: 0, inFile: 0, failed: [] };
  const nameOf = getDb().prepare("SELECT name FROM folders WHERE id = ?");
  for (let i = 0; i < ids.length; i++) {
    const fname = (nameOf.get(ids[i]) as { name: string } | undefined)?.name ?? `#${ids[i]}`;
    onProgress({ done: i, total: ids.length, current: fname });
    try {
      const r = await setFolderMeta(ids[i], { editTags: (cur) => cur.filter((t) => t.toLowerCase() !== lower) });
      result.updated++;
      if (r.inFile) result.inFile++;
    } catch (e) {
      result.failed.push({ name: fname, error: (e as Error).message });
    }
  }
  pruneUnusedTags();
  onProgress({ done: ids.length, total: ids.length, current: "" });
  return result;
}
