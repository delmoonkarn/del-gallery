import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";
import { getDb, upsertTag } from "./db";
import { isJpegPath, readXmp } from "./xmp";
import { ARCHIVE_EXTS, entryPath, listArchiveImages } from "./archive";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"]);

type ScanProgress = { scannedDirs: number; currentPath: string };

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Single-pass directory read: returns both the sorted image children and
 * subdirectory list from one fs.readdir call.
 */
async function readDir(dir: string): Promise<{ images: string[]; subs: string[]; archives: string[] }> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
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
    const s = await fs.stat(dir);
    return Math.floor(s.mtimeMs / 1000);
  } catch {
    return 0;
  }
}

export async function scanLibrary(root: string, win: BrowserWindow | null): Promise<number> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  let scanned = 0;

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
  const knownArchive = db.prepare(
    "SELECT mtime, image_count, cover_path FROM folders WHERE path = ? AND is_archive = 1"
  );

  type Visit = { dir: string; parentId: number | null; depth: number };
  const queue: Visit[] = [{ dir: root, parentId: null, depth: 0 }];

  while (queue.length > 0) {
    const { dir, parentId, depth } = queue.shift()!;

    const [{ images, subs, archives }, mtime] = await Promise.all([readDir(dir), dirMtime(dir)]);
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

    // Tags, stars and favourite travel in the cover JPEG's XMP. Only a folder's
    // *own* first image counts — bubbled-up covers belong to a child.
    if (cover && isJpegPath(cover)) {
      const meta = await readXmp(cover);
      db.transaction(() => {
        for (const t of meta.tags) insertFolderTag.run(folderId, upsertTag(t));
        // No XMP at all (never tagged, or not really a JPEG): keep what the DB has.
        if (meta.found) setRatingFav.run(meta.rating, meta.favorite ? 1 : 0, folderId);
      })();
    }

    // Each .cbz/.zip is a chapter of its own. Only reopen it when it changed —
    // listing an archive means a seek to its central directory on the HDD.
    for (const archive of archives) {
      let st;
      try {
        st = await fs.stat(archive);
      } catch {
        continue;
      }
      const amtime = Math.floor(st.mtimeMs / 1000);
      const prev = knownArchive.get(archive) as { mtime: number; image_count: number; cover_path: string | null } | undefined;
      let count = prev?.image_count ?? 0;
      let aCover = prev?.cover_path ?? null;
      if (!prev || prev.mtime !== amtime) {
        try {
          const imgs = await listArchiveImages(archive);
          count = imgs.length;
          aCover = imgs[0] ? entryPath(archive, imgs[0]) : null;
        } catch {
          continue; // not a readable zip
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
    }

    for (const sub of subs) queue.push({ dir: sub, parentId: folderId, depth: depth + 1 });

    scanned += 1;
    if (scanned % 20 === 0) {
      win?.webContents.send("scan-progress", { scannedDirs: scanned, currentPath: dir } satisfies ScanProgress);
    }
  }

  bubbleCovers();
  return scanned;
}

// Bubble-up: parents with no direct cover inherit from the first child's cover.
function bubbleCovers(): void {
  const bubble = getDb().prepare(`
    UPDATE folders SET cover_path = (
      SELECT cover_path FROM folders c
      WHERE c.parent_id = folders.id AND c.cover_path IS NOT NULL
      ORDER BY c.name COLLATE NOCASE LIMIT 1
    )
    WHERE cover_path IS NULL
  `);
  while (bubble.run().changes > 0) {
    /* repeat until stable */
  }
}

/** Re-pick every inherited cover — after folders moved between parents. */
export function rebubbleCovers(): void {
  getDb().prepare("UPDATE folders SET cover_path = NULL WHERE image_count = 0 AND is_archive = 0").run();
  bubbleCovers();
}
