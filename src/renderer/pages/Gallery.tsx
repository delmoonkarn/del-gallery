import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, FolderRow, RootInfo } from "../api";
import { useStore } from "../store";
import Card from "../components/Card";
import TagFilter from "../components/TagFilter";
import SortPicker from "../components/SortPicker";
import SettingsDialog from "../components/SettingsDialog";
import { useScrollRestore } from "../lib/useScrollRestore";
import { getLastVisited, focusFolderCard, clearLastVisited } from "../lib/lastVisited";

export default function Gallery() {
  const {
    library,
    setLibrary,
    query,
    setQuery,
    activeTags,
    clearTags,
    sortBy,
    sortDir,
    minPages,
    setMinPages,
  } = useStore();
  const nav = useNavigate();
  const [rows, setRows] = useState<FolderRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ scannedDirs: number; currentPath: string } | null>(null);
  const [tagsVersion, setTagsVersion] = useState(0);
  const [roots, setRoots] = useState<RootInfo[] | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const loadRoots = useCallback(async () => {
    const list = await api.roots();
    setRoots(list);
    // The picked library was removed — fall back to showing everything.
    const lib = useStore.getState().library;
    if (lib != null && !list.some((r) => r.id === lib)) setLibrary(null);
  }, [setLibrary]);

  // Restore scroll once rows are in the DOM so the page has its real height.
  // If the user came back from a folder they opened from here, prefer scrolling
  // *that card* into view (and highlighting it) over restoring a raw scroll Y.
  const lastChild = getLastVisited("/");
  useScrollRestore("/", rows.length > 0 && lastChild === undefined);
  useEffect(() => {
    if (rows.length === 0) return;
    const target = getLastVisited("/");
    if (target === undefined) return;
    focusFolderCard(target);
    clearLastVisited("/");
  }, [rows]);

  const refresh = useCallback(async () => {
    const sort = { by: sortBy, dir: sortDir };
    if (query || activeTags.length > 0 || minPages > 0) {
      setRows(await api.search(query, activeTags, sort, minPages, library));
    } else {
      setRows(await api.children(null, sort, minPages, library));
    }
  }, [query, activeTags, sortBy, sortDir, minPages, library]);

  // One-time mount: load library folders and install scan listeners.
  useEffect(() => {
    loadRoots();
    const offP = api.onScanProgress((p) => {
      setScanning(true);
      setProgress(p);
    });
    const offD = api.onScanDone(() => {
      setScanning(false);
      setProgress(null);
      loadRoots();
      // `refresh` is captured by ref to avoid resubscribing on every filter change.
      refreshRef.current();
      // The scan likely produced new tags — force TagFilter to refetch.
      setTagsVersion((v) => v + 1);
    });
    return () => {
      offP();
      offD();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refetch whenever the refresh closure changes (i.e. any filter / sort changes).
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
    refresh();
  }, [refresh]);

  const rollRandom = async () => {
    const r = await api.random(activeTags, query, minPages, library);
    if (!r) {
      alert("No folder matches the current filters.");
      return;
    }
    nav(`/folder/${r.id}`);
  };

  // Rescans the library picked in the header, or all of them.
  const rescan = async () => {
    if (!roots?.length) return;
    setScanning(true);
    const r = await api.scan(library);
    if (r.offline.length) alert("Skipped (not reachable — drive disconnected?):\n" + r.offline.join("\n"));
  };

  const resetDb = async () => {
    if (!confirm("Wipe the entire library cache (library folders, scanned folders, tags)? This cannot be undone.")) return;
    await api.reset();
    setSettingsOpen(false);
    setLibrary(null);
    setRoots([]);
    setRows([]);
    clearTags();
    setQuery("");
    setTagsVersion((v) => v + 1);
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="sticky top-0 z-10 bg-neutral-950/95 backdrop-blur border-b border-neutral-900 p-4 flex flex-col gap-3">
        <div className="flex gap-2 items-center">
          <button
            onClick={() => setSettingsOpen(true)}
            className={`px-3 py-1.5 rounded text-sm ${
              roots?.length === 0 ? "bg-indigo-600 hover:bg-indigo-500" : "bg-neutral-800 hover:bg-neutral-700"
            }`}
            title="Library folders, reset"
          >
            ⚙ Settings
          </button>
          <button
            onClick={rescan}
            disabled={!roots?.length || scanning}
            className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 rounded text-sm"
            title={library == null ? "Rescan every library folder" : "Rescan the selected library folder"}
          >
            {scanning ? "Scanning…" : "Rescan"}
          </button>
          <button
            onClick={rollRandom}
            className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-sm"
            title="Open a random folder (respects current tag filter and min pages)"
          >
            🎲 Random
          </button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search folder names…"
            className="flex-1 max-w-md px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <label className="flex items-center gap-1 text-xs text-neutral-400" title="Show only folders with at least this many direct images (not counting subfolders)">
            ≥
            <input
              type="number"
              min={0}
              value={minPages || ""}
              onChange={(e) => setMinPages(parseInt(e.target.value, 10) || 0)}
              placeholder="0"
              className="w-16 px-2 py-1 bg-neutral-900 border border-neutral-800 rounded text-sm text-neutral-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            pages
          </label>
          <SortPicker />
          {roots && roots.length > 1 ? (
            <select
              value={library ?? ""}
              onChange={(e) => setLibrary(e.target.value ? Number(e.target.value) : null)}
              className="min-w-0 max-w-xs px-2 py-1 bg-neutral-900 border border-neutral-800 rounded text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              title="Which library folder to show"
            >
              <option value="">All libraries ({roots.length})</option>
              {roots.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.online ? "" : " (offline)"}
                </option>
              ))}
            </select>
          ) : (
            <div className="text-xs text-neutral-500 truncate flex-1" title={roots?.[0]?.path ?? ""}>
              {roots?.[0]?.path ?? (roots ? "no library folder yet" : "")}
            </div>
          )}
        </div>
        <TagFilter refreshKey={tagsVersion} />
        {progress && (
          <div className="text-xs text-neutral-400 truncate">
            scanned {progress.scannedDirs} dirs — {progress.currentPath}
          </div>
        )}
      </header>

      <main className="p-4">
        {rows.length === 0 ? (
          <div className="text-neutral-500 text-sm p-8 text-center">
            {roots?.length ? (
              "No folders yet. Click Rescan."
            ) : (
              <button onClick={() => setSettingsOpen(true)} className="text-indigo-300 hover:underline">
                Add a library folder in Settings to begin.
              </button>
            )}
          </div>
        ) : (
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
          >
            {rows.map((r) => (
              <Card key={r.id} row={r} onChanged={refresh} />
            ))}
          </div>
        )}
      </main>

      {settingsOpen && (
        <SettingsDialog
          scanning={scanning}
          onClose={() => setSettingsOpen(false)}
          onScanStarted={() => setScanning(true)}
          onChanged={() => {
            loadRoots();
            refreshRef.current();
            setTagsVersion((v) => v + 1);
          }}
          onReset={resetDb}
        />
      )}
    </div>
  );
}
