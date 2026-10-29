import { contextBridge, ipcRenderer } from "electron";
import type { Stats } from "./ipc";
import type { BulkOp, BulkResult } from "./meta";
import type { MoveResult } from "./move";

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

export type SortOpt = { by?: "name" | "mtime" | "image_count" | "rating" | "random"; dir?: "asc" | "desc" };
export type Filters = { favOnly?: boolean; minRating?: number };
export type MetaPatch = { tags?: string[]; rating?: number; favorite?: boolean };
export type OpProgress = { done: number; total: number; current: string };

export type RootInfo = {
  id: number;
  path: string;
  name: string;
  online: boolean;
  chapters: number;
  pages: number;
  lastScanned: number | null;
};

const api = {
  roots: (): Promise<RootInfo[]> => ipcRenderer.invoke("roots:list"),
  addRoot: (): Promise<{ id: number; path: string; absorbed: number } | null> => ipcRenderer.invoke("roots:add"),
  removeRoot: (id: number): Promise<void> => ipcRenderer.invoke("roots:remove", id),
  relocateRoot: (id: number): Promise<string | null> => ipcRenderer.invoke("roots:relocate", id),
  /** rootId null = scan every library folder. */
  scan: (rootId: number | null): Promise<{ scanned: number; offline: string[] }> =>
    ipcRenderer.invoke("library:scan", rootId),
  reset: (): Promise<boolean> => ipcRenderer.invoke("library:reset"),
  children: (
    parentId: number | null,
    sort?: SortOpt,
    minPages?: number,
    rootId?: number | null
  ): Promise<FolderRow[]> => ipcRenderer.invoke("library:children", parentId, sort, minPages, rootId),
  get: (id: number): Promise<FolderRow | null> => ipcRenderer.invoke("library:get", id),
  ancestors: (id: number): Promise<{ id: number; name: string; depth: number }[]> =>
    ipcRenderer.invoke("library:ancestors", id),
  nextSibling: (id: number): Promise<FolderRow | null> =>
    ipcRenderer.invoke("library:next-sibling", id),
  prevSibling: (id: number): Promise<FolderRow | null> =>
    ipcRenderer.invoke("library:prev-sibling", id),
  pages: (id: number): Promise<string[]> => ipcRenderer.invoke("library:pages", id),
  search: (
    query: string,
    tags: string[],
    sort?: SortOpt,
    minPages?: number,
    rootId?: number | null,
    filters?: Filters
  ): Promise<FolderRow[]> =>
    ipcRenderer.invoke("library:search", { query, tags, sort, minPages, rootId, filters }),
  random: (
    tags: string[],
    query?: string,
    minPages?: number,
    rootId?: number | null,
    filters?: Filters
  ): Promise<FolderRow | null> =>
    ipcRenderer.invoke("library:random", { tags, query, minPages, rootId, filters }),
  toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke("window:toggle-fullscreen"),
  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke("window:is-fullscreen"),
  openFolder: (folderPath: string): Promise<void> =>
    ipcRenderer.invoke("shell:open-path", folderPath),
  renameFolder: (id: number, newName: string): Promise<void> =>
    ipcRenderer.invoke("library:rename-folder", { id, newName }),
  allTags: (withTags?: string[]): Promise<{ name: string; n: number }[]> =>
    ipcRenderer.invoke("library:all-tags", withTags),
  /** Tags / stars / favourite for one folder. `strict`: fail on a cover that isn't really a JPEG. */
  setMeta: (id: number, patch: MetaPatch, strict = false): Promise<{ inFile: boolean }> =>
    ipcRenderer.invoke("meta:set", { id, patch, strict }),
  bulkMeta: (ids: number[], op: BulkOp): Promise<BulkResult> => ipcRenderer.invoke("meta:bulk", { ids, op }),
  renameTag: (from: string, to: string): Promise<BulkResult> => ipcRenderer.invoke("tags:rename", { from, to }),
  deleteTag: (name: string): Promise<BulkResult> => ipcRenderer.invoke("tags:delete", name),
  /** Asks for a destination folder; null if cancelled. */
  move: (ids: number[]): Promise<MoveResult | null> => ipcRenderer.invoke("library:move", ids),
  stats: (rootId: number | null): Promise<Stats> => ipcRenderer.invoke("library:stats", rootId),
  saveJpegBuffer: (srcPath: string, jpegBuffer: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke("image:save-jpeg", { srcPath, jpegBuffer }),

  onScanProgress: (cb: (p: { scannedDirs: number; currentPath: string }) => void) => {
    const l = (_: unknown, p: { scannedDirs: number; currentPath: string }) => cb(p);
    ipcRenderer.on("scan-progress", l);
    return () => ipcRenderer.removeListener("scan-progress", l);
  },
  onScanDone: (cb: (n: number) => void) => {
    const l = (_: unknown, n: number) => cb(n);
    ipcRenderer.on("scan-done", l);
    return () => ipcRenderer.removeListener("scan-done", l);
  },
  onOpProgress: (cb: (p: OpProgress) => void) => {
    const l = (_: unknown, p: OpProgress) => cb(p);
    ipcRenderer.on("op-progress", l);
    return () => ipcRenderer.removeListener("op-progress", l);
  },
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
