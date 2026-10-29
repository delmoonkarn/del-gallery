import { useEffect, useState } from "react";
import { api, BulkResult } from "../api";
import { useStore } from "../store";

type Props = {
  /** Ids of the cards on the current page, for Ctrl+A. */
  visibleIds: number[];
  /** Something changed on disk / in the cache — refetch. */
  onDone: () => void;
};

type Mode = null | "add" | "remove";

/**
 * Floating action bar for multi-select: tag, untag, rate, favourite or move
 * every selected folder at once. Ctrl+A selects all visible cards, Esc clears.
 */
export default function BulkBar({ visibleIds, onDone }: Props) {
  const selected = useStore((s) => s.selected);
  const setSelected = useStore((s) => s.setSelected);
  const clearSelection = useStore((s) => s.clearSelection);
  const [mode, setMode] = useState<Mode>(null);
  const [tagText, setTagText] = useState("");
  const [allTags, setAllTags] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const busy = progress !== null;

  // Selection belongs to the page it was made on.
  useEffect(() => () => clearSelection(), [clearSelection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && visibleIds.length) {
        e.preventDefault();
        setSelected(visibleIds);
      } else if (e.key === "Escape" && useStore.getState().selected.length) {
        e.stopPropagation();
        clearSelection();
        setMode(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleIds, setSelected, clearSelection]);

  useEffect(() => {
    if (mode) api.allTags().then((t) => setAllTags(t.map((x) => x.name)));
  }, [mode]);

  if (selected.length === 0) return null;

  const run = async (label: string, fn: () => Promise<BulkResult | { moved: number; leftLibrary: number; failed: BulkResult["failed"] } | null>) => {
    setProgress({ done: 0, total: selected.length, current: "" });
    const off = api.onOpProgress(setProgress);
    try {
      const r = await fn();
      if (r && r.failed.length) {
        alert(
          `${label}: ${r.failed.length} item(s) failed:\n\n` +
            r.failed
              .slice(0, 15)
              .map((f) => `• ${f.name}: ${f.error}`)
              .join("\n") +
            (r.failed.length > 15 ? `\n…and ${r.failed.length - 15} more` : "")
        );
      }
      if (r && "leftLibrary" in r && r.leftLibrary > 0) {
        alert(`${r.leftLibrary} item(s) were moved outside your library folders and no longer show here.`);
      }
      if (r) {
        clearSelection();
        setMode(null);
        setTagText("");
      }
      onDone();
    } catch (e) {
      alert(`${label} failed: ${(e as Error).message}`);
    } finally {
      off();
      setProgress(null);
    }
  };

  const tagsFromText = () =>
    tagText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  const applyTags = () => {
    const tags = tagsFromText();
    if (!tags.length) return;
    run(mode === "add" ? "Add tags" : "Remove tags", () =>
      api.bulkMeta(selected, mode === "add" ? { addTags: tags } : { removeTags: tags })
    );
  };

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 max-w-[95vw] rounded-lg bg-neutral-900/95 backdrop-blur border border-neutral-700 shadow-2xl px-3 py-2 text-sm">
      {busy ? (
        <div className="flex items-center gap-3 min-w-[360px]">
          <span className="text-neutral-300 tabular-nums shrink-0">
            {progress.done}/{progress.total}
          </span>
          <div className="flex-1 h-1.5 rounded bg-neutral-800 overflow-hidden">
            <div
              className="h-full bg-indigo-500 transition-all"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
          <span className="text-xs text-neutral-500 truncate max-w-[16rem]">{progress.current}</span>
        </div>
      ) : mode ? (
        <div className="flex items-center gap-2">
          <span className="text-neutral-400 shrink-0">{mode === "add" ? "Add tags" : "Remove tags"}:</span>
          <input
            autoFocus
            list="bulkbar-tags"
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setMode(null);
              if (e.key === "Enter") applyTags();
            }}
            placeholder="comma, separated"
            className="w-64 px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <datalist id="bulkbar-tags">
            {allTags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <button
            disabled={!tagsFromText().length}
            onClick={applyTags}
            className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded"
          >
            Apply to {selected.length}
          </button>
          <button onClick={() => setMode(null)} className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded">
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-neutral-200 font-medium px-1 tabular-nums">{selected.length} selected</span>
          <Btn onClick={() => setMode("add")}>+ Tag</Btn>
          <Btn onClick={() => setMode("remove")}>− Tag</Btn>
          <select
            value=""
            onChange={(e) => {
              const n = Number(e.target.value);
              run("Rating", () => api.bulkMeta(selected, { rating: n }));
            }}
            className="px-1.5 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-amber-400 text-xs focus:outline-none"
            title="Set star rating"
          >
            <option value="" disabled>
              ★ Rate…
            </option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {"★".repeat(n)}
              </option>
            ))}
            <option value={0}>Clear rating</option>
          </select>
          <Btn onClick={() => run("Favourite", () => api.bulkMeta(selected, { favorite: true }))} title="Add to favourites">
            <span className="text-rose-500">♥</span>
          </Btn>
          <Btn onClick={() => run("Unfavourite", () => api.bulkMeta(selected, { favorite: false }))} title="Remove from favourites">
            ♡
          </Btn>
          <Btn
            onClick={() => run("Move", () => api.move(selected))}
            title="Move the selected folders into another folder (same drive)"
          >
            Move to…
          </Btn>
          <span className="w-px h-5 bg-neutral-700 mx-1" />
          <Btn onClick={() => setSelected(visibleIds)} title="Select all (Ctrl+A)">
            All
          </Btn>
          <Btn onClick={clearSelection} title="Clear selection (Esc)">
            ✕
          </Btn>
        </div>
      )}
    </div>
  );
}

function Btn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button onClick={onClick} title={title} className="px-2.5 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-200">
      {children}
    </button>
  );
}
