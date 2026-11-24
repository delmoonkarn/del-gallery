import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";
import { getDb, upsertTag } from "./db";
import { isJpegPath, readXmp } from "./xmp";
import { ARCHIVE_EXTS, entryPath, listArchiveImages } from "./archive";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"]);

/**
 * Default timeout per filesystem operation. External HDDs that are asleep can
 * take tens of seconds to spin up on the first access, so this is generous.
 * Operations that time out are skipped (that folder won't be scanned this run).
 */
const FS_TIMEOUT_MS = 20_000;

type ScanProgress = { scannedDirs: number; currentPath: string };

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Race `p` against a timeout. Returns `fallback` if the operation doesn't
 * resolve in `ms` milliseconds (and logs a warning so we see what stalled).
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[scanner] timed out after ${ms}ms: ${label}`);
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Single-pass directory read: returns both the sorted image children and
 * subdirectory list from one fs.readdir call.
 */
async function readDir(dir: string): Promise<{ images: string[]; subs: string[]; archives: string[] }> {
  let entries;
  try {
    entries = await withTimeout(
      fs.readdir(dir, { withFileTypes: true }),
      FS_TIMEOUT_MS,
      `readdir ${dir}`,
      null as unknown as import("node:fs").Dirent[]
    );
    if (!entries) return { images: [], subs: [], archives: [] };
  } catch {
    return { images: [], subs: [], archives: [] };
  }
  const images: string[] = [];
  const subs: string[] = [];
  const archives: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      subs.push(path.join(dir, e.name));
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (IMAGE_EXTS.has(ext)) images.push(path.join(dir, e.name));
      else if (ARCHIVE_EXTS.has(ext)) archives.push(path.join(dir, e.name));
    }
  }
  images.sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
  subs.sort(naturalCompare);
  archives.sort(naturalCompare);
  return { images, subs, archives };
}

export async function listImages(dir: string): Promise<string[]> {
  return (await readDir(dir)).images;
}

async function dirMtime(dir: string): Promise<number> {
  try {
    const s = await withTimeout(fs.stat(dir), FS_TIMEOUT_MS, `stat ${dir}`, null);
    return s ? Math.floor(s.mtimeMs / 1000) : 0;
  } catch {
    return 0;
  }
}

/**
 * Yield control so pending IPC / timers / GC / Chromium UI messages can run.
 *
 * `setTimeout(fn, 0)` is the right primitive here, NOT `setImmediate`: in
 * Electron on Windows the main process owns the HWND, and Chromium's UI
 * message pump is interleaved with libuv's *timers* phase. `setImmediate`
 * runs in the check phase and can starve the UI pump during long bursts —
 * Windows then marks the window "Not Responding" even though main is alive.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Incremental scan: for each directory, skip the `readdir` when the on-disk
 * mtime matches what we previously recorded (the directory's entries haven't
 * changed). Still descends into every child — a child's own contents might
 * have changed independently.
 *
 * Pass `force = true` to re-read every directory regardless. Useful if XMP
 * tags were edited outside the app (which don't bump a folder's mtime).
 *
 * At the end, folder rows under `root` that were never visited in this run
 * (deleted on disk) are pruned; folder_tags cascade.
 */
export async function scanLibrary(
  root: string,
  win: BrowserWindow | null,
  force = false
): Promise<number> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  let scanned = 0;
  const visited = new Set<number>();

  const upsertFolder = db.prepare(`
    INSERT INTO folders(path, parent_id, name, depth, image_count, cover_path, mtime, last_scanned, is_archive)
    VALUES(@path, @parent_id, @name, @depth, @image_count, @cover_path, @mtime, @last_scanned, @is_archive)
    ON CONFLICT(path) DO UPDATE SET
      parent_id    = excluded.parent_id,
      name         = excluded.name,
      depth        = excluded.depth,
      image_count  = excluded.image_count,
      cover_path   = excluded.cover_path,
      mtime        = excluded.mtime,
      last_scanned = excluded.last_scanned,
      is_archive   = excluded.is_archive
  `);
  const findId = db.prepare("SELECT id FROM folders WHERE path = ?");
  const deleteXmpTags = db.prepare("DELETE FROM folder_tags WHERE folder_id = ? AND source = 'xmp'");
  const insertFolderTag = db.prepare(
    "INSERT OR IGNORE INTO folder_tags(folder_id, tag_id, source) VALUES (?, ?, 'xmp')"
  );
  const setRatingFav = db.prepare("UPDATE folders SET rating = ?, favorite = ? WHERE id = ?");
  const knownFolder = db.prepare(
    "SELECT id, mtime FROM folders WHERE path = ? AND is_archive = 0"
  );
  const knownArchive = db.prepare(
    "SELECT mtime, image_count, cover_path FROM folders WHERE path = ? AND is_archive = 1"
  );
  const touchLastScanned = db.prepare(
    "UPDATE folders SET last_scanned = ?, parent_id = ?, depth = ? WHERE id = ?"
  );
  const childrenOf = db.prepare(
    "SELECT id, path FROM folders WHERE parent_id = ? AND is_archive = 0"
  );
  const archiveChildrenOf = db.prepare(
    "SELECT id FROM folders WHERE parent_id = ? AND is_archive = 1"
  );

  type Visit = { dir: string; parentId: number | null; depth: number };
  const queue: Visit[] = [{ dir: root, parentId: null, depth: 0 }];

  const t0 = Date.now();
  console.log(`[scanner] start root="${root}" force=${force}`);

  // Nothing inside the loop may throw — a bad JPEG, a corrupt zip, a transient
  // EBUSY on a directory, any of those would otherwise abort the whole walk.
  // Everything caught here lands in the main-process log file (see index.ts).
  const scanOne = async (v: Visit): Promise<void> => {
    const { dir, parentId, depth } = v;
    const mtime = await dirMtime(dir);
    const existing = knownFolder.get(dir) as { id: number; mtime: number } | undefined;

    if (!force && existing && existing.mtime === mtime && mtime > 0) {
      visited.add(existing.id);
      touchLastScanned.run(now, parentId, depth, existing.id);
      for (const c of childrenOf.all(existing.id) as { id: number; path: string }[]) {
        queue.push({ dir: c.path, parentId: existing.id, depth: depth + 1 });
      }
      for (const a of archiveChildrenOf.all(existing.id) as { id: number }[]) {
        visited.add(a.id);
      }
      return;
    }

    const { images, subs, archives } = await readDir(dir);
    const cover = images[0] ?? null;
    const name = path.basename(dir) || dir;

    const tx = db.transaction(() => {
      upsertFolder.run({
        path: dir,
        parent_id: parentId,
        name,
        depth,
        image_count: images.length,
        cover_path: cover,
        mtime,
        last_scanned: now,
        is_archive: 0,
      });
      const id = (findId.get(dir) as { id: number }).id;
      deleteXmpTags.run(id);
      return id;
    });
    const folderId = tx();
    visited.add(folderId);

    if (cover && isJpegPath(cover)) {
      try {
        const meta = await readXmp(cover);
        db.transaction(() => {
          for (const t of meta.tags) insertFolderTag.run(folderId, upsertTag(t));
          if (meta.found) setRatingFav.run(meta.rating, meta.favorite ? 1 : 0, folderId);
        })();
      } catch (err) {
        console.error(`[scanner] XMP read failed for ${cover}:`, err);
      }
    }

    for (const archive of archives) {
      try {
        let st;
        try {
          st = await fs.stat(archive);
        } catch {
          continue;
        }
        const amtime = Math.floor(st.mtimeMs / 1000);
        const prev = knownArchive.get(archive) as
          | { mtime: number; image_count: number; cover_path: string | null }
          | undefined;
        let count = prev?.image_count ?? 0;
        let aCover = prev?.cover_path ?? null;
        if (!prev || prev.mtime !== amtime) {
          try {
            const imgs = await listArchiveImages(archive);
            count = imgs.length;
            aCover = imgs[0] ? entryPath(archive, imgs[0]) : null;
          } catch {
            continue;
          }
        }
        upsertFolder.run({
          path: archive,
          parent_id: folderId,
          name: path.basename(archive, path.extname(archive)),
          depth: depth + 1,
          image_count: count,
          cover_path: aCover,
          mtime: amtime,
          last_scanned: now,
          is_archive: 1,
        });
        const aid = (findId.get(archive) as { id: number }).id;
        visited.add(aid);
      } catch (err) {
        console.error(`[scanner] archive read failed for ${archive}:`, err);
      }
    }

    for (const sub of subs) queue.push({ dir: sub, parentId: folderId, depth: depth + 1 });
  };

  let lastMilestone = Date.now();
  try {
    while (queue.length > 0) {
      const v = queue.shift()!;
      const dirT0 = Date.now();
      try {
        await scanOne(v);
      } catch (err) {
        console.error(`[scanner] failed at ${v.dir}:`, err);
      }
      const dirMs = Date.now() - dirT0;
      // Warn about any single directory that took longer than 2s — helps spot
      // the specific HDD folder causing a stall.
      if (dirMs > 2000) console.warn(`[scanner] slow dir ${dirMs}ms: ${v.dir}`);
      scanned += 1;
      if (scanned % 20 === 0) {
        win?.webContents.send("scan-progress", { scannedDirs: scanned, currentPath: v.dir } satisfies ScanProgress);
      }
      // Milestone log every 500 folders or every 10s, whichever comes first.
      if (scanned % 500 === 0 || Date.now() - lastMilestone > 10_000) {
        console.log(`[scanner] ${scanned} dirs, queue=${queue.length}, at ${v.dir}`);
        lastMilestone = Date.now();
      }
      await yieldToEventLoop();
    }

    console.log(`[scanner] walk done: ${scanned} dirs in ${Date.now() - t0}ms`);

    // Prune folder rows under `root` that weren't visited this run — their
    // directories were deleted on disk. folder_tags cascade via the FK.
    // Each DELETE chunk is its own transaction so we can yield between them.
    const pruT0 = Date.now();
    const rootRow = db.prepare("SELECT id FROM folders WHERE path = ?").get(root) as
      | { id: number }
      | undefined;
    if (rootRow) {
      const descendants = db
        .prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM folders WHERE id = ?
             UNION ALL
             SELECT f.id FROM folders f JOIN sub s ON f.parent_id = s.id
           )
           SELECT id FROM sub`
        )
        .all(rootRow.id) as { id: number }[];
      const toDelete = descendants.map((r) => r.id).filter((id) => !visited.has(id));
      const CHUNK = 500;
      for (let i = 0; i < toDelete.length; i += CHUNK) {
        const batch = toDelete.slice(i, i + CHUNK);
        db.prepare(
          `DELETE FROM folders WHERE id IN (${batch.map(() => "?").join(",")})`
        ).run(...batch);
        await yieldToEventLoop();
      }
    }
    console.log(`[scanner] prune done in ${Date.now() - pruT0}ms`);

    // Bubble covers in cooperative async form so a cache with many NULL covers
    // (common after a big scan) can't block main for long enough to go
    // "Not Responding".
    const bubT0 = Date.now();
    await bubbleCoversAsync();
    console.log(`[scanner] bubbleCovers done in ${Date.now() - bubT0}ms`);
  } catch (err) {
    // Last-resort: whatever blew up, the DB has whatever was committed per-row,
    // and the renderer gets a scan-done so its `library:scan` promise resolves.
    console.error("[scanner] unrecoverable error:", err);
  }
  console.log(`[scanner] FINISH root="${root}" scanned=${scanned} total=${Date.now() - t0}ms`);
  return scanned;
}

// The EXISTS filter is load-bearing: without it, folders whose children have
// no cover either get their NULL overwritten with NULL. SQLite counts that as
// a "change", so `result.changes > 0` stays true forever and the loop never
// terminates.
const BUBBLE_SQL = `
  UPDATE folders SET cover_path = (
    SELECT cover_path FROM folders c
    WHERE c.parent_id = folders.id AND c.cover_path IS NOT NULL
    ORDER BY c.name COLLATE NOCASE LIMIT 1
  )
  WHERE cover_path IS NULL
    AND EXISTS (
      SELECT 1 FROM folders c
      WHERE c.parent_id = folders.id AND c.cover_path IS NOT NULL
    )
`;

/**
 * Bubble-up: parents with no direct cover inherit from the first child's cover.
 * Each SQL pass is itself atomic and fast; we yield between passes so the UI
 * pump gets a turn. One pass per level of hierarchy; converges quickly.
 */
async function bubbleCoversAsync(): Promise<void> {
  const bubble = getDb().prepare(BUBBLE_SQL);
  for (let i = 0; i < 100; i++) {
    const { changes } = bubble.run();
    if (changes === 0) return;
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  console.warn("[scanner] bubbleCovers didn't converge after 100 passes");
}

// Synchronous variant for the one remaining caller (move.ts etc.) that doesn't
// need to yield. Keep it small.
function bubbleCovers(): void {
  const bubble = getDb().prepare(BUBBLE_SQL);
  while (bubble.run().changes > 0) {
    /* repeat until stable */
  }
}

/** Re-pick every inherited cover — after folders moved between parents. */
export function rebubbleCovers(): void {
  getDb().prepare("UPDATE folders SET cover_path = NULL WHERE image_count = 0 AND is_archive = 0").run();
  bubbleCovers();
}
