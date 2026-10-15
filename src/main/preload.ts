import { contextBridge, ipcRenderer } from "electron";

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

export type SortOpt = { by?: "name" | "mtime" | "image_count" | "random"; dir?: "asc" | "desc" };

const api = {
  pickRoot: (): Promise<string | null> => ipcRenderer.invoke("dialog:pick-root"),
  getRoot: (): Promise<string | null> => ipcRenderer.invoke("library:get-root"),
  scan: (root: string): Promise<number> => ipcRenderer.invoke("library:scan", root),
  reset: (): Promise<boolean> => ipcRenderer.invoke("library:reset"),
  children: (
    parentId: number | null,
    sort?: SortOpt,
    minPages?: number
  ): Promise<FolderRow[]> => ipcRenderer.invoke("library:children", parentId, sort, minPages),
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
    minPages?: number
  ): Promise<FolderRow[]> =>
    ipcRenderer.invoke("library:search", { query, tags, sort, minPages }),
  random: (
    tags: string[],
    query?: string,
    minPages?: number
  ): Promise<FolderRow | null> =>
    ipcRenderer.invoke("library:random", { tags, query, minPages }),
  toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke("window:toggle-fullscreen"),
  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke("window:is-fullscreen"),
  openFolder: (folderPath: string): Promise<void> =>
    ipcRenderer.invoke("shell:open-path", folderPath),
  renameFolder: (id: number, newName: string): Promise<void> =>
    ipcRenderer.invoke("library:rename-folder", { id, newName }),
  allTags: (withTags?: string[]): Promise<{ name: string; n: number }[]> =>
    ipcRenderer.invoke("library:all-tags", withTags),
  writeTags: (
    filePath: string,
    tags: string[]
  ): Promise<{ converted: boolean; finalPath: string }> =>
    ipcRenderer.invoke("xmp:write", { filePath, tags }),
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
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
