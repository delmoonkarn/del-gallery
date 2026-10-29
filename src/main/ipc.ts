import { ipcMain, dialog, BrowserWindow, shell } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { getDb } from "./db";
import { scanLibrary, listImages } from "./scanner";
import { addRoot, listRoots, relocateRoot, removeRoot, rootById, rootScope } from "./roots";
import { writeJpegBuffer } from "./image";
import { closeArchive, entryPath, listArchiveImages } from "./archive";
import { BulkOp, bulkMeta, deleteTag, MetaPatch, renameTag, setFolderMeta } from "./meta";
import { moveFolders } from "./move";

export type FolderRow = {
  id: number;
  path: string;
  parent_id: number | null;
  name: string;
  depth: number;
  image_count: number;
  child_count: number;
  cover_path: string | null;
  rating: number;
  favorite: number;
  is_archive: number;
  tags: string[];
};

const SELECT_COLS = `
  f.id, f.path, f.parent_id, f.name, f.depth, f.image_count, f.cover_path, f.rating, f.favorite, f.is_archive,
  (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id) AS child_count
`;

type Sort = { by?: "name" | "mtime" | "image_count" | "rating" | "random"; dir?: "asc" | "desc" };
/** Gallery filters shared by search and random. */
type Filters = { favOnly?: boolean; minRating?: number };

function filterWhere(f: Filters | undefined, where: string[], params: unknown[]) {
  if (f?.favOnly) where.push("f.favorite = 1");
  if (f?.minRating && f.minRating > 0) {
    where.push("f.rating >= ?");
    params.push(f.minRating);
  }
}

function orderBy(s: Sort | undefined): string {
  const dir = s?.dir === "desc" ? "DESC" : "ASC";
  switch (s?.by) {
    case "mtime":
      return `ORDER BY f.mtime ${dir}, f.name COLLATE NOCASE ASC`;
    case "image_count":
      return `ORDER BY f.image_count ${dir}, f.name COLLATE NOCASE ASC`;
    case "rating":
      return `ORDER BY f.rating ${dir}, f.favorite ${dir}, f.name COLLATE NOCASE ASC`;
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
    const r = await dialog.showOpenDialog(win!, { title: "Add a folder", properties: ["openDirectory"] });
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
    const row = db.prepare("SELECT path, is_archive FROM folders WHERE id = ?").get(id) as
      | { path: string; is_archive: number }
      | undefined;
    if (!row) return [];
    if (row.is_archive) return (await listArchiveImages(row.path)).map((e) => entryPath(row.path, e));
    return listImages(row.path);
  });

  ipcMain.handle(
    "library:search",
    (
      _e,
      args: { query: string; tags: string[]; sort?: Sort; minPages?: number; rootId?: number | null; filters?: Filters }
    ) => {
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
      filterWhere(args.filters, where, params);
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
    (_e, args: { tags: string[]; query?: string; minPages?: number; rootId?: number | null; filters?: Filters }) => {
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
      filterWhere(args.filters, where, params);
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
      const row = db.prepare("SELECT path, name, parent_id, is_archive FROM folders WHERE id = ?").get(id) as
        | { path: string; name: string; parent_id: number | null; is_archive: number }
        | undefined;
      if (!row) throw new Error("Folder not found");

      // Archives are named without their extension in the UI; keep .cbz/.zip on disk.
      const ext = row.is_archive ? path.extname(row.path) : "";
      const fileName = ext && !newName.toLowerCase().endsWith(ext.toLowerCase()) ? newName + ext : newName;
      const displayName = ext ? path.basename(fileName, path.extname(fileName)) : fileName;
      if (row.name === displayName) return; // no-op

      const oldPath = row.path;
      const newPath = path.join(path.dirname(oldPath), fileName);
      if (row.is_archive) closeArchive(oldPath);

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
         WHERE cover_path LIKE ? OR cover_path LIKE ? OR cover_path LIKE ?`
      );
      const updateName = db.prepare("UPDATE folders SET name = ? WHERE id = ?");
      db.transaction(() => {
        updatePath.run(newPath, oldLen, oldPath, winPrefix + "%", nixPrefix + "%");
        // "<archive>|<entry>" covers point inside a renamed .cbz/.zip.
        updateCover.run(newPath, oldLen, winPrefix + "%", nixPrefix + "%", oldPath + "|%");
        updateName.run(displayName, id);
      })();

      // If we renamed a library folder itself, repoint its roots entry too.
      db.prepare("UPDATE roots SET path = ? WHERE path = ?").run(newPath, oldPath);
    }
  );

  ipcMain.handle("shell:open-path", async (_e, p: string) => {
    // For a .cbz/.zip chapter, show the file in its folder rather than opening it.
    if ((await fs.stat(p).catch(() => null))?.isFile()) return shell.showItemInFolder(p);
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

  // Tags / stars / favourite for one folder. Written into the cover's XMP when
  // possible, DB-only otherwise (see meta.ts). Keyed by folder id: a series
  // folder shares its cover file with its first chapter, so the path is ambiguous.
  ipcMain.handle(
    "meta:set",
    (_e, args: { id: number; patch: Omit<MetaPatch, "editTags">; strict?: boolean }) =>
      setFolderMeta(args.id, args.patch, args.strict)
  );

  // Long edits report progress on "op-progress" so the UI can show a bar.
  const progressTo = (e: Electron.IpcMainInvokeEvent) => (p: { done: number; total: number; current: string }) =>
    e.sender.send("op-progress", p);

  ipcMain.handle("meta:bulk", (e, args: { ids: number[]; op: BulkOp }) => bulkMeta(args.ids, args.op, progressTo(e)));
  ipcMain.handle("tags:rename", (e, args: { from: string; to: string }) => renameTag(args.from, args.to, progressTo(e)));
  ipcMain.handle("tags:delete", (e, name: string) => deleteTag(name, progressTo(e)));

  ipcMain.handle("library:move", async (e, ids: number[]) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, {
      title: `Move ${ids.length} item${ids.length === 1 ? "" : "s"} to…`,
      properties: ["openDirectory"],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return moveFolders(ids, r.filePaths[0], progressTo(e));
  });

  ipcMain.handle("library:stats", (_e, rootId: number | null) => libraryStats(rootId));
}

export type Stats = {
  folders: number;
  chapters: number;
  archives: number;
  pages: number;
  favorites: number;
  rated: number;
  ratingCounts: number[]; // index 0..5 (0 = unrated), chapters only
  tags: number;
  topTags: { name: string; n: number }[];
  biggest: { id: number; name: string; pages: number }[];
  newest: { id: number; name: string; mtime: number }[];
  topRated: { id: number; name: string; rating: number; favorite: number }[];
  libraries: { name: string; chapters: number; pages: number }[];
};

function libraryStats(rootId: number | null): Stats {
  const db = getDb();
  const scope = rootScope(rootId);
  const w = (extra: string) => {
    const parts = [scope.where, extra].filter(Boolean);
    return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  };
  const q = <T>(sql: string, ...params: unknown[]) => db.prepare(`${scope.cte} ${sql}`).all(...scope.params, ...params) as T[];

  const totals = q<{ folders: number; chapters: number; archives: number; pages: number; favorites: number; rated: number }>(
    `SELECT COALESCE(SUM(f.is_archive = 0), 0) AS folders, COALESCE(SUM(f.image_count > 0), 0) AS chapters,
            COALESCE(SUM(f.is_archive = 1), 0) AS archives, COALESCE(SUM(f.image_count), 0) AS pages,
            COALESCE(SUM(f.favorite = 1), 0) AS favorites, COALESCE(SUM(f.rating > 0), 0) AS rated
     FROM folders f ${w("")}`
  )[0];
  const ratingCounts = [0, 0, 0, 0, 0, 0];
  for (const r of q<{ rating: number; n: number }>(
    `SELECT f.rating, COUNT(*) AS n FROM folders f ${w("f.image_count > 0")} GROUP BY f.rating`
  )) {
    ratingCounts[Math.min(5, Math.max(0, r.rating))] += r.n;
  }
  const topTags = q<{ name: string; n: number }>(
    `SELECT t.name, COUNT(DISTINCT ft.folder_id) AS n FROM tags t
     JOIN folder_tags ft ON ft.tag_id = t.id JOIN folders f ON f.id = ft.folder_id
     ${w("")} GROUP BY t.id ORDER BY n DESC, t.name LIMIT 30`
  );
  const tags = q<{ n: number }>(
    `SELECT COUNT(DISTINCT ft.tag_id) AS n FROM folder_tags ft JOIN folders f ON f.id = ft.folder_id ${w("")}`
  )[0].n;
  const biggest = q<{ id: number; name: string; pages: number }>(
    `SELECT f.id, f.name, f.image_count AS pages FROM folders f ${w("f.image_count > 0")}
     ORDER BY f.image_count DESC LIMIT 10`
  );
  const newest = q<{ id: number; name: string; mtime: number }>(
    `SELECT f.id, f.name, f.mtime FROM folders f ${w("f.image_count > 0")} ORDER BY f.mtime DESC LIMIT 10`
  );
  const topRated = q<{ id: number; name: string; rating: number; favorite: number }>(
    `SELECT f.id, f.name, f.rating, f.favorite FROM folders f ${w("(f.rating > 0 OR f.favorite = 1)")}
     ORDER BY f.rating DESC, f.favorite DESC, f.name COLLATE NOCASE LIMIT 10`
  );

  const sub = db.prepare(`
    WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id)
    SELECT COALESCE(SUM(f.image_count > 0), 0) AS chapters, COALESCE(SUM(f.image_count), 0) AS pages
    FROM sub JOIN folders f ON f.id = sub.id`);
  const libraries = (
    db
      .prepare(
        `SELECT r.id, rf.id AS fid, rf.name FROM roots r JOIN folders rf ON rf.path = r.path
         ${rootId != null ? "WHERE r.id = ?" : ""} ORDER BY rf.name COLLATE NOCASE`
      )
      .all(...(rootId != null ? [rootId] : [])) as { id: number; fid: number; name: string }[]
  ).map((r) => ({ name: r.name, ...(sub.get(r.fid) as { chapters: number; pages: number }) }));

  return { ...totals, ratingCounts, tags, topTags, biggest, newest, topRated, libraries };
}
