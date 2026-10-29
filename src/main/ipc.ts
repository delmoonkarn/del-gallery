import { ipcMain, dialog, BrowserWindow, shell } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { getDb } from "./db";
import { scanLibrary, listImages } from "./scanner";
import { addRoot, listRoots, relocateRoot, removeRoot, rootById, rootScope } from "./roots";
import { writeXmpTags } from "./xmp";
import { ensureJpeg, writeJpegBuffer } from "./image";

export type FolderRow = {
  id: number;
  path: string;
  parent_id: number | null;
  name: string;
  depth: number;
  image_count: number;
  child_count: number;
  cover_path: string | null;
  tags: string[];
};

const SELECT_COLS = `
  f.id, f.path, f.parent_id, f.name, f.depth, f.image_count, f.cover_path,
  (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id) AS child_count
`;

type Sort = { by?: "name" | "mtime" | "image_count" | "random"; dir?: "asc" | "desc" };

function orderBy(s: Sort | undefined): string {
  const dir = s?.dir === "desc" ? "DESC" : "ASC";
  switch (s?.by) {
    case "mtime":
      return `ORDER BY f.mtime ${dir}, f.name COLLATE NOCASE ASC`;
    case "image_count":
      return `ORDER BY f.image_count ${dir}, f.name COLLATE NOCASE ASC`;
    case "random":
      return `ORDER BY RANDOM()`;
    case "name":
    default:
      return `ORDER BY f.name COLLATE NOCASE ${dir}`;
  }
}

// Scans run one at a time (two walks on one HDD just thrash it). `scan-done`
// fires once the queue is empty, so the UI's "Scanning…" state stays honest.
let scanChain: Promise<unknown> = Promise.resolve();
let scansQueued = 0;

function queueScan(win: BrowserWindow | null, rootId: number | null) {
  scansQueued++;
  const job = scanChain.then(async () => {
    const ids =
      rootId == null
        ? (getDb().prepare("SELECT id FROM roots ORDER BY path COLLATE NOCASE").all() as { id: number }[]).map((r) => r.id)
        : [rootId];
    let scanned = 0;
    const offline: string[] = [];
    for (const id of ids) {
      const r = rootById(id);
      if (!r) continue;
      try {
        await fs.access(r.path);
      } catch {
        offline.push(r.path);
        continue;
      }
      scanned += await scanLibrary(r.path, win);
    }
    return { scanned, offline };
  });
  scanChain = job.catch(() => {});
  return job.finally(() => {
    scansQueued--;
    if (scansQueued === 0) win?.webContents.send("scan-done", 0);
  });
}

export function registerIpc(): void {
  ipcMain.handle("roots:list", () => listRoots());
  ipcMain.handle("roots:add", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, { title: "Add a manga folder", properties: ["openDirectory"] });
    if (r.canceled || r.filePaths.length === 0) return null;
    const added = addRoot(r.filePaths[0]);
    void queueScan(win, added.id);
    return added;
  });
  ipcMain.handle("roots:remove", (_e, id: number) => removeRoot(id));
  ipcMain.handle("roots:relocate", async (e, id: number) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, { title: "Where is this folder now?", properties: ["openDirectory"] });
    if (r.canceled || r.filePaths.length === 0) return null;
    return relocateRoot(id, r.filePaths[0]);
  });

  ipcMain.handle("library:reset", () => {
    const db = getDb();
    db.transaction(() => {
      db.exec("DELETE FROM folder_tags");
      db.exec("DELETE FROM folders");
      db.exec("DELETE FROM tags");
      db.exec("DELETE FROM meta");
      db.exec("DELETE FROM roots");
    })();
    db.exec("VACUUM");
    return true;
  });

  // rootId null = every library folder.
  ipcMain.handle("library:scan", (e, rootId: number | null) =>
    queueScan(BrowserWindow.fromWebContents(e.sender), rootId)
  );

  ipcMain.handle(
    "library:children",
    (_e, parentId: number | null, sort?: Sort, minPages?: number, rootId?: number | null) => {
      const db = getDb();
      const params: unknown[] = [];
      let where: string;
      if (parentId === null) {
        // Top level = the children of every library folder (or just the picked one).
        where = "f.parent_id IN (SELECT rf.id FROM folders rf JOIN roots r ON r.path = rf.path" +
          (rootId != null ? " WHERE r.id = ?)" : ")");
        if (rootId != null) params.push(rootId);
      } else {
        where = "f.parent_id = ?";
        params.push(parentId);
      }
      if (typeof minPages === "number" && minPages > 0) {
        where += " AND f.image_count >= ?";
        params.push(minPages);
      }
      const sql = `
        SELECT ${SELECT_COLS}
        FROM folders f
        WHERE ${where}
        ${orderBy(sort)}
      `;
      const rows = db.prepare(sql).all(...params) as FolderRow[];
      const tagStmt = db.prepare(
        `SELECT DISTINCT t.name FROM tags t JOIN folder_tags ft ON ft.tag_id = t.id
         WHERE ft.folder_id = ? ORDER BY t.name`
      );
      for (const row of rows) {
        row.tags = (tagStmt.all(row.id) as { name: string }[]).map((r) => r.name);
      }
      return rows;
    }
  );

  ipcMain.handle("library:ancestors", (_e, id: number) => {
    const db = getDb();
    // Walk from the given folder up to the root, then return depth>=1 entries in root→leaf order.
    const rows = db
      .prepare(
        `WITH RECURSIVE chain(id, parent_id, name, depth) AS (
           SELECT id, parent_id, name, depth FROM folders WHERE id = ?
           UNION ALL
           SELECT f.id, f.parent_id, f.name, f.depth
           FROM folders f JOIN chain c ON f.id = c.parent_id
         )
         SELECT id, name, depth FROM chain WHERE depth >= 1 ORDER BY depth ASC`
      )
      .all(id) as { id: number; name: string; depth: number }[];
    return rows;
  });

  ipcMain.handle("library:get", (_e, id: number) => {
    const db = getDb();
    const row = db
      .prepare(`SELECT ${SELECT_COLS} FROM folders f WHERE f.id = ?`)
      .get(id) as FolderRow | undefined;
    if (!row) return null;
    row.tags = (
      db
        .prepare(
          `SELECT DISTINCT t.name FROM tags t JOIN folder_tags ft ON ft.tag_id = t.id
           WHERE ft.folder_id = ? ORDER BY t.name`
        )
        .all(id) as { name: string }[]
    ).map((r) => r.name);
    return row;
  });

  ipcMain.handle("library:pages", async (_e, id: number) => {
    const db = getDb();
    const row = db.prepare("SELECT path FROM folders WHERE id = ?").get(id) as { path: string } | undefined;
    if (!row) return [];
    return listImages(row.path);
  });

  ipcMain.handle(
    "library:search",
    (_e, args: { query: string; tags: string[]; sort?: Sort; minPages?: number; rootId?: number | null }) => {
      const db = getDb();
      const q = `%${args.query.toLowerCase()}%`;
      const scope = rootScope(args.rootId);
      const params: unknown[] = [...scope.params];
      let sql = `${scope.cte}
        SELECT DISTINCT ${SELECT_COLS}
        FROM folders f
      `;
      if (args.tags.length > 0) {
        sql += ` JOIN folder_tags ft ON ft.folder_id = f.id
                 JOIN tags t ON t.id = ft.tag_id AND t.name IN (${args.tags.map(() => "?").join(",")})`;
        params.push(...args.tags);
      }
      const where: string[] = scope.where ? [scope.where] : [];
      if (args.query) {
        where.push("LOWER(f.name) LIKE ?");
        params.push(q);
      }
      if (typeof args.minPages === "number" && args.minPages > 0) {
        where.push("f.image_count >= ?");
        params.push(args.minPages);
      }
      if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
      if (args.tags.length > 0) {
        sql += ` GROUP BY f.id HAVING COUNT(DISTINCT t.id) = ${args.tags.length}`;
      }
      sql += ` ${orderBy(args.sort)} LIMIT 500`;
      const rows = db.prepare(sql).all(...params) as FolderRow[];
      const tagStmt = db.prepare(
        `SELECT DISTINCT t.name FROM tags t JOIN folder_tags ft ON ft.tag_id = t.id
         WHERE ft.folder_id = ? ORDER BY t.name`
      );
      for (const r of rows) r.tags = (tagStmt.all(r.id) as { name: string }[]).map((t) => t.name);
      return rows;
    }
  );

  ipcMain.handle("library:all-tags", (_e, withTags?: string[]) => {
    const db = getDb();
    // No filter — return every tag with its global usage count.
    if (!withTags || withTags.length === 0) {
      return db
        .prepare(
          `SELECT t.name, COUNT(DISTINCT ft.folder_id) as n
           FROM tags t JOIN folder_tags ft ON ft.tag_id = t.id
           GROUP BY t.id ORDER BY n DESC, t.name`
        )
        .all() as { name: string; n: number }[];
    }
    // Narrow to tags that co-occur with all of `withTags` on the same folder.
    const placeholders = withTags.map(() => "?").join(",");
    const sql = `
      SELECT t.name, COUNT(DISTINCT ft.folder_id) as n
      FROM tags t JOIN folder_tags ft ON ft.tag_id = t.id
      WHERE ft.folder_id IN (
        SELECT ft2.folder_id
        FROM folder_tags ft2
        JOIN tags t2 ON t2.id = ft2.tag_id AND t2.name IN (${placeholders})
        GROUP BY ft2.folder_id
        HAVING COUNT(DISTINCT t2.id) = ?
      )
      GROUP BY t.id
      ORDER BY n DESC, t.name
    `;
    return db
      .prepare(sql)
      .all(...withTags, withTags.length) as { name: string; n: number }[];
  });

  ipcMain.handle(
    "library:random",
    (_e, args: { tags: string[]; query?: string; minPages?: number; rootId?: number | null }) => {
      const db = getDb();
      const scope = rootScope(args.rootId);
      const params: unknown[] = [...scope.params];
      let sql = `${scope.cte}
        SELECT DISTINCT ${SELECT_COLS}
        FROM folders f
      `;
      if (args.tags.length > 0) {
        sql += ` JOIN folder_tags ft ON ft.folder_id = f.id
                 JOIN tags t ON t.id = ft.tag_id AND t.name IN (${args.tags.map(() => "?").join(",")})`;
        params.push(...args.tags);
      }
      const where: string[] = ["f.image_count > 0"];
      if (scope.where) where.push(scope.where);
      if (typeof args.minPages === "number" && args.minPages > 0) {
        where.push("f.image_count >= ?");
        params.push(args.minPages);
      }
      if (args.query && args.query.trim()) {
        where.push("LOWER(f.name) LIKE ?");
        params.push(`%${args.query.toLowerCase().trim()}%`);
      }
      sql += ` WHERE ${where.join(" AND ")}`;
      if (args.tags.length > 0) {
        sql += ` GROUP BY f.id HAVING COUNT(DISTINCT t.id) = ${args.tags.length}`;
      }
      sql += ` ORDER BY RANDOM() LIMIT 1`;
      const row = db.prepare(sql).get(...params) as FolderRow | undefined;
      if (!row) return null;
      row.tags = (
        db
          .prepare(
            `SELECT DISTINCT t.name FROM tags t JOIN folder_tags ft ON ft.tag_id = t.id
             WHERE ft.folder_id = ? ORDER BY t.name`
          )
          .all(row.id) as { name: string }[]
      ).map((r) => r.name);
      return row;
    }
  );

  const siblingSql = (direction: "next" | "prev") => `
    SELECT ${SELECT_COLS}
    FROM folders f
    WHERE f.parent_id = ?
      AND f.name COLLATE NOCASE ${direction === "next" ? ">" : "<"} ?
      AND f.image_count > 0
    ORDER BY f.name COLLATE NOCASE ${direction === "next" ? "ASC" : "DESC"}
    LIMIT 1
  `;
  const sibling = (id: number, direction: "next" | "prev"): FolderRow | null => {
    const db = getDb();
    const cur = db.prepare("SELECT parent_id, name FROM folders WHERE id = ?").get(id) as
      | { parent_id: number | null; name: string }
      | undefined;
    if (!cur || cur.parent_id === null) return null;
    const row = db.prepare(siblingSql(direction)).get(cur.parent_id, cur.name) as
      | FolderRow
      | undefined;
    if (!row) return null;
    row.tags = (
      db
        .prepare(
          `SELECT DISTINCT t.name FROM tags t JOIN folder_tags ft ON ft.tag_id = t.id
           WHERE ft.folder_id = ? ORDER BY t.name`
        )
        .all(row.id) as { name: string }[]
    ).map((r) => r.name);
    return row;
  };
  ipcMain.handle("library:next-sibling", (_e, id: number) => sibling(id, "next"));
  ipcMain.handle("library:prev-sibling", (_e, id: number) => sibling(id, "prev"));

  ipcMain.handle(
    "library:rename-folder",
    async (_e, args: { id: number; newName: string }) => {
      const { id } = args;
      const newName = args.newName.trim();
      if (!newName) throw new Error("Folder name cannot be empty");
      if (/[\\/:*?"<>|]/.test(newName)) {
        throw new Error('Folder name cannot contain \\ / : * ? " < > |');
      }
      const db = getDb();
      const row = db.prepare("SELECT path, name, parent_id FROM folders WHERE id = ?").get(id) as
        | { path: string; name: string; parent_id: number | null }
        | undefined;
      if (!row) throw new Error("Folder not found");
      if (row.name === newName) return; // no-op

      const oldPath = row.path;
      const newPath = path.join(path.dirname(oldPath), newName);

      // Refuse if a different filesystem entry already lives at the target.
      // (case-insensitive on Windows: renaming "Foo" → "foo" on the same path
      // is allowed by fs.rename and useful for case fixes.)
      const isCaseOnly = oldPath.toLowerCase() === newPath.toLowerCase();
      if (!isCaseOnly) {
        try {
          await fs.access(newPath);
          throw new Error(`A folder named "${newName}" already exists here`);
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }

      await fs.rename(oldPath, newPath);

      // Patch the DB: this folder's row, every descendant's path, every
      // cover_path that lived under the old folder. SUBSTR-prefix-rewrite is
      // cheap and exact.
      const oldLen = oldPath.length;
      const winPrefix = oldPath + "\\";
      const nixPrefix = oldPath + "/";
      const updatePath = db.prepare(
        `UPDATE folders
         SET path = ? || SUBSTR(path, ? + 1)
         WHERE path = ? OR path LIKE ? OR path LIKE ?`
      );
      const updateCover = db.prepare(
        `UPDATE folders
         SET cover_path = ? || SUBSTR(cover_path, ? + 1)
         WHERE cover_path LIKE ? OR cover_path LIKE ?`
      );
      const updateName = db.prepare("UPDATE folders SET name = ? WHERE id = ?");
      db.transaction(() => {
        updatePath.run(newPath, oldLen, oldPath, winPrefix + "%", nixPrefix + "%");
        updateCover.run(newPath, oldLen, winPrefix + "%", nixPrefix + "%");
        updateName.run(newName, id);
      })();

      // If we renamed a library folder itself, repoint its roots entry too.
      db.prepare("UPDATE roots SET path = ? WHERE path = ?").run(newPath, oldPath);
    }
  );

  ipcMain.handle("shell:open-path", async (_e, p: string) => {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  });

  ipcMain.handle("window:toggle-fullscreen", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    const next = !win.isFullScreen();
    win.setFullScreen(next);
    return next;
  });

  ipcMain.handle("window:is-fullscreen", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win?.isFullScreen() ?? false;
  });

  ipcMain.handle(
    "image:save-jpeg",
    async (_e, args: { srcPath: string; jpegBuffer: ArrayBuffer }) => {
      const newPath = await writeJpegBuffer(args.srcPath, args.jpegBuffer);
      // Repoint any folder whose cover was the source path.
      const db = getDb();
      if (newPath !== args.srcPath) {
        db.prepare("UPDATE folders SET cover_path = ? WHERE cover_path = ?").run(
          newPath,
          args.srcPath
        );
      }
      return newPath;
    }
  );

  ipcMain.handle("xmp:write", async (_e, args: { filePath: string; tags: string[] }) => {
    // Auto-convert PNG/WebP covers to JPEG so XMP can be written.
    const finalPath = await ensureJpeg(args.filePath);
    await writeXmpTags(finalPath, args.tags);

    const db = getDb();
    // If we converted, repoint any folder whose cover was the old PNG/WebP.
    if (finalPath !== args.filePath) {
      db.prepare("UPDATE folders SET cover_path = ? WHERE cover_path = ?").run(finalPath, args.filePath);
    }
    // Refresh DB tags for the folder whose cover is this image.
    const row = db.prepare("SELECT id FROM folders WHERE cover_path = ?").get(finalPath) as
      | { id: number }
      | undefined;
    if (row) {
      // Use the same 'xmp' source the scanner uses — the tags ARE in the file's
      // XMP packet now, so there's no real distinction. Avoids two rows per tag
      // (one 'user', one 'xmp') after the next rescan.
      db.prepare("DELETE FROM folder_tags WHERE folder_id = ? AND source IN ('xmp','user')").run(row.id);
      const ins = db.prepare(
        "INSERT OR IGNORE INTO folder_tags(folder_id, tag_id, source) VALUES (?, ?, 'xmp')"
      );
      const tx = db.transaction(() => {
        for (const t of args.tags) {
          db.prepare("INSERT OR IGNORE INTO tags(name) VALUES (?)").run(t);
          const tid = (db.prepare("SELECT id FROM tags WHERE name = ?").get(t) as { id: number }).id;
          ins.run(row.id, tid);
        }
      });
      tx();
    }
    return { converted: finalPath !== args.filePath, finalPath };
  });
}
