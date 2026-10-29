import { create } from "zustand";

export type ReaderMode = "single" | "double" | "scroll";
export type ReaderDir = "ltr" | "rtl";
export type FitMode = "height" | "width" | "original";
export type SortBy = "name" | "mtime" | "image_count" | "rating" | "random";
export type SortDir = "asc" | "desc";

type State = {
  /** Library folder (roots.id) the gallery is limited to; null = all of them. */
  library: number | null;
  activeTags: string[];
  query: string;
  minPages: number;
  /** Gallery filters: only favourites / at least this many stars (0 = off). */
  favOnly: boolean;
  minRating: number;
  readerMode: ReaderMode;
  readerDir: ReaderDir;
  fitMode: FitMode;
  /** Two-page mode: show page 1 on its own so the following pairs match print. */
  coverAlone: boolean;
  sortBy: SortBy;
  sortDir: SortDir;
  folderSortBy: SortBy;
  folderSortDir: SortDir;
  /** Multi-select: folder ids in click order; `anchor` is the last plain/ctrl-clicked id for Shift ranges. */
  selected: number[];
  anchor: number | null;
  setLibrary: (id: number | null) => void;
  toggleTag: (t: string) => void;
  clearTags: () => void;
  setQuery: (q: string) => void;
  setMinPages: (n: number) => void;
  setFavOnly: (v: boolean) => void;
  setMinRating: (n: number) => void;
  setReaderMode: (m: ReaderMode) => void;
  setReaderDir: (d: ReaderDir) => void;
  setFitMode: (f: FitMode) => void;
  setCoverAlone: (v: boolean) => void;
  setSort: (by: SortBy, dir: SortDir) => void;
  setFolderSort: (by: SortBy, dir: SortDir) => void;
  toggleSelected: (id: number) => void;
  /** Shift+click: select everything between the anchor and `id` in `order`. */
  selectRange: (id: number, order: number[]) => void;
  setSelected: (ids: number[]) => void;
  clearSelection: () => void;
};

const saved = <T extends string>(key: string, fallback: T): T => (localStorage.getItem(key) as T | null) ?? fallback;

export const useStore = create<State>((set, get) => ({
  library: (() => {
    const v = localStorage.getItem("library");
    return v ? parseInt(v, 10) || null : null;
  })(),
  activeTags: [],
  query: "",
  minPages: parseInt(localStorage.getItem("minPages") ?? "0", 10) || 0,
  favOnly: localStorage.getItem("favOnly") === "1",
  minRating: parseInt(localStorage.getItem("minRating") ?? "0", 10) || 0,
  readerMode: saved<ReaderMode>("readerMode", "single"),
  readerDir: saved<ReaderDir>("readerDir", "ltr"),
  fitMode: saved<FitMode>("fitMode", "height"),
  coverAlone: localStorage.getItem("coverAlone") === "1",
  sortBy: saved<SortBy>("sortBy", "mtime"),
  sortDir: saved<SortDir>("sortDir", "desc"),
  folderSortBy: saved<SortBy>("folderSortBy", "name"),
  folderSortDir: saved<SortDir>("folderSortDir", "asc"),
  selected: [],
  anchor: null,
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
  setFavOnly: (v) => {
    localStorage.setItem("favOnly", v ? "1" : "0");
    set({ favOnly: v });
  },
  setMinRating: (n) => {
    const v = Math.min(5, Math.max(0, Math.floor(n) || 0));
    localStorage.setItem("minRating", String(v));
    set({ minRating: v });
  },
  setReaderMode: (m) => {
    localStorage.setItem("readerMode", m);
    set({ readerMode: m });
  },
  setReaderDir: (d) => {
    localStorage.setItem("readerDir", d);
    set({ readerDir: d });
  },
  setFitMode: (f) => {
    localStorage.setItem("fitMode", f);
    set({ fitMode: f });
  },
  setCoverAlone: (v) => {
    localStorage.setItem("coverAlone", v ? "1" : "0");
    set({ coverAlone: v });
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
  toggleSelected: (id) =>
    set((s) => ({
      selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id],
      anchor: id,
    })),
  selectRange: (id, order) => {
    const { anchor, selected } = get();
    const a = anchor == null ? -1 : order.indexOf(anchor);
    const b = order.indexOf(id);
    if (a < 0 || b < 0) return set({ selected: [...new Set([...selected, id])], anchor: id });
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    set({ selected: [...new Set([...selected, ...range])] });
  },
  setSelected: (ids) => set({ selected: ids }),
  clearSelection: () => set({ selected: [], anchor: null }),
}));
