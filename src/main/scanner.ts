import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";
import { getDb, upsertTag } from "./db";
import { readXmpTags } from "./xmp";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"]);

type ScanProgress = { scannedDirs: number; currentPath: string };

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Single-pass directory read: returns both the sorted image children and
 * subdirectory list from one fs.readdir call.
 */
async function readDir(dir: string): Promise<{ images: string[]; subs: string[] }> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { images: [], subs: [] };
  }
  const images: string[] = [];
  const subs: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      subs.push(path.join(dir, e.name));
    } else if (e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) {
      images.push(path.join(dir, e.name));
    }
  }
  images.sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
  subs.sort(naturalCompare);
  return { images, subs };
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
    INSERT INTO folders(path, parent_id, name, depth, image_count, cover_path, mtime, last_scanned)
    VALUES(@path, @parent_id, @name, @depth, @image_count, @cover_path, @mtime, @last_scanned)
    ON CONFLICT(path) DO UPDATE SET
      parent_id    = excluded.parent_id,
      name         = excluded.name,
      depth        = excluded.depth,
      image_count  = excluded.image_count,
      cover_path   = excluded.cover_path,
      mtime        = excluded.mtime,
      last_scanned = excluded.last_scanned
  `);
  const findId = db.prepare("SELECT id FROM folders WHERE path = ?");
  const deleteXmpTags = db.prepare("DELETE FROM folder_tags WHERE folder_id = ? AND source = 'xmp'");
  const insertFolderTag = db.prepare(
    "INSERT OR IGNORE INTO folder_tags(folder_id, tag_id, source) VALUES (?, ?, 'xmp')"
  );

  type Visit = { dir: string; parentId: number | null; depth: number };
  const queue: Visit[] = [{ dir: root, parentId: null, depth: 0 }];

  while (queue.length > 0) {
    const { dir, parentId, depth } = queue.shift()!;

    const [{ images, subs }, mtime] = await Promise.all([readDir(dir), dirMtime(dir)]);
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
      });
      const id = (findId.get(dir) as { id: number }).id;
      deleteXmpTags.run(id);
      return id;
    });
    const folderId = tx();

    if (cover) {
      const tags = await readXmpTags(cover);
      if (tags.length > 0) {
        const writeTags = db.transaction((ts: string[]) => {
          for (const t of ts) {
            const tagId = upsertTag(t);
            insertFolderTag.run(folderId, tagId);
          }
        });
        writeTags(tags);
      }
    }

    for (const sub of subs) queue.push({ dir: sub, parentId: folderId, depth: depth + 1 });

    scanned += 1;
    if (scanned % 20 === 0) {
      win?.webContents.send("scan-progress", { scannedDirs: scanned, currentPath: dir } satisfies ScanProgress);
    }
  }

  // Bubble-up: parents with no direct cover inherit from the first child's cover.
  const bubble = db.prepare(`
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

  return scanned;
}
