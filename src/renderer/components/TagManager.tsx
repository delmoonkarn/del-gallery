import { useCallback, useEffect, useMemo, useState } from "react";
import { api, BulkResult } from "../api";

type Props = {
  /** Tags changed — the gallery should refetch. */
  onChanged: () => void;
  /** True while a rename/delete is writing files, so Settings can refuse to close. */
  onBusy: (busy: boolean) => void;
};

/**
 * Settings → Tags. Rename, merge or delete a tag across the whole library.
 * Each affected folder's cover JPEG is rewritten (or its cached tags, for
 * archives / series folders), so this can take a while on an external HDD —
 * progress is shown.
 */
export default function TagManager({ onChanged, onBusy }: Props) {
  const [tags, setTags] = useState<{ name: string; n: number }[]>([]);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const busy = progress !== null;

  const load = useCallback(() => api.allTags().then(setTags), []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onBusy(busy), [busy, onBusy]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? tags.filter((t) => t.name.toLowerCase().includes(q)) : tags;
    return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [tags, filter]);

  const run = async (label: string, fn: () => Promise<BulkResult>) => {
    setMessage(null);
    setProgress({ done: 0, total: 0, current: "" });
    const off = api.onOpProgress(setProgress);
    try {
      const r = await fn();
      const cacheOnly = r.updated - r.inFile;
      setMessage(
        `${label}: ${r.updated} folder${r.updated === 1 ? "" : "s"} updated` +
          (cacheOnly > 0 ? ` (${cacheOnly} in the cache only — archives / series folders)` : "") +
          (r.failed.length ? `. ${r.failed.length} failed: ${r.failed.slice(0, 3).map((f) => `${f.name} (${f.error})`).join("; ")}` : ".")
      );
      setEditing(null);
      await load();
      onChanged();
    } catch (e) {
      setMessage(`${label} failed: ${(e as Error).message}`);
    } finally {
      off();
      setProgress(null);
    }
  };

  const rename = (from: string) => {
    const to = draft.trim();
    if (!to || to === from) return setEditing(null);
    const existing = tags.find((t) => t.name.toLowerCase() === to.toLowerCase() && t.name.toLowerCase() !== from.toLowerCase());
    if (existing && !confirm(`"${existing.name}" already exists. Merge "${from}" into it?`)) return;
    run(existing ? `Merged into "${existing.name}"` : `Renamed to "${to}"`, () => api.renameTag(from, existing?.name ?? to));
  };

  const remove = (t: { name: string; n: number }) => {
    if (!confirm(`Delete the tag "${t.name}" from ${t.n} folder${t.n === 1 ? "" : "s"}?`)) return;
    run(`Deleted "${t.name}"`, () => api.deleteTag(t.name));
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-4 pb-3 border-b border-neutral-900 space-y-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Find a tag… (${tags.length})`}
          className="w-full px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <p className="text-[11px] text-neutral-500">
          Renaming to a name that already exists merges the two. Changes are written into each folder's cover image.
        </p>
        {busy && (
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <span className="tabular-nums shrink-0">
              {progress.done}/{progress.total || "…"}
            </span>
            <div className="flex-1 h-1.5 rounded bg-neutral-800 overflow-hidden">
              <div
                className="h-full bg-indigo-500 transition-all"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
            <span className="truncate max-w-[12rem]">{progress.current}</span>
          </div>
        )}
        {message && !busy && <div className="text-xs text-neutral-300 break-words">{message}</div>}
      </div>

      <div className={`flex-1 min-h-0 overflow-y-auto ${busy ? "opacity-50 pointer-events-none" : ""}`}>
        {shown.length === 0 && <div className="p-4 text-sm text-neutral-500">No tags{filter ? " match" : " yet"}.</div>}
        {shown.map((t) => (
          <div key={t.name} className="group flex items-center gap-2 px-4 py-1.5 border-b border-neutral-900/70 hover:bg-neutral-900/50">
            {editing === t.name ? (
              <>
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") rename(t.name);
                    if (e.key === "Escape") {
                      // Cancel the edit, don't close Settings.
                      e.stopPropagation();
                      setEditing(null);
                    }
                  }}
                  className="flex-1 px-2 py-0.5 bg-neutral-900 border border-indigo-600 rounded text-sm focus:outline-none"
                />
                <button onClick={() => rename(t.name)} className="px-2 py-0.5 bg-indigo-600 hover:bg-indigo-500 rounded text-xs">
                  Save
                </button>
                <button onClick={() => setEditing(null)} className="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 rounded text-xs">
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="flex-1 text-sm text-neutral-100 truncate" title={t.name}>
                  {t.name}
                </span>
                <span className="text-xs text-neutral-500 tabular-nums">{t.n}</span>
                <button
                  onClick={() => {
                    setEditing(t.name);
                    setDraft(t.name);
                  }}
                  className="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 rounded text-xs opacity-0 group-hover:opacity-100"
                >
                  Rename / merge
                </button>
                <button
                  onClick={() => remove(t)}
                  className="px-2 py-0.5 bg-red-900/50 hover:bg-red-800 text-red-100 rounded text-xs opacity-0 group-hover:opacity-100"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
