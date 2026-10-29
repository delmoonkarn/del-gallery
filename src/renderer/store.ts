import { create } from "zustand";

export type ReaderMode = "single" | "double" | "scroll";
export type SortBy = "name" | "mtime" | "image_count" | "random";
export type SortDir = "asc" | "desc";

type State = {
  /** Library folder (roots.id) the gallery is limited to; null = all of them. */
  library: number | null;
  activeTags: string[];
  query: string;
  minPages: number;
  readerMode: ReaderMode;
  sortBy: SortBy;
  sortDir: SortDir;
  folderSortBy: SortBy;
  folderSortDir: SortDir;
  setLibrary: (id: number | null) => void;
  toggleTag: (t: string) => void;
  clearTags: () => void;
  setQuery: (q: string) => void;
  setMinPages: (n: number) => void;
  setReaderMode: (m: ReaderMode) => void;
  setSort: (by: SortBy, dir: SortDir) => void;
  setFolderSort: (by: SortBy, dir: SortDir) => void;
};

export const useStore = create<State>((set) => ({
  library: (() => {
    const v = localStorage.getItem("library");
    return v ? parseInt(v, 10) || null : null;
  })(),
  activeTags: [],
  query: "",
  minPages: parseInt(localStorage.getItem("minPages") ?? "0", 10) || 0,
  readerMode: (localStorage.getItem("readerMode") as ReaderMode | null) ?? "single",
  sortBy: (localStorage.getItem("sortBy") as SortBy | null) ?? "mtime",
  sortDir: (localStorage.getItem("sortDir") as SortDir | null) ?? "desc",
  folderSortBy: (localStorage.getItem("folderSortBy") as SortBy | null) ?? "name",
  folderSortDir: (localStorage.getItem("folderSortDir") as SortDir | null) ?? "asc",
  setLibrary: (id) => {
    if (id == null) localStorage.removeItem("library");
    else localStorage.setItem("library", String(id));
    set({ library: id });
  },
  toggleTag: (t) =>
    set((s) => ({
      activeTags: s.activeTags.includes(t) ? s.activeTags.filter((x) => x !== t) : [...s.activeTags, t],
    })),
  clearTags: () => set({ activeTags: [] }),
  setQuery: (q) => set({ query: q }),
  setMinPages: (n) => {
    const v = Math.max(0, Math.floor(n) || 0);
    localStorage.setItem("minPages", String(v));
    set({ minPages: v });
  },
  setReaderMode: (m) => {
    localStorage.setItem("readerMode", m);
    set({ readerMode: m });
  },
  setSort: (by, dir) => {
    localStorage.setItem("sortBy", by);
    localStorage.setItem("sortDir", dir);
    set({ sortBy: by, sortDir: dir });
  },
  setFolderSort: (by, dir) => {
    localStorage.setItem("folderSortBy", by);
    localStorage.setItem("folderSortDir", dir);
    set({ folderSortBy: by, folderSortDir: dir });
  },
}));
