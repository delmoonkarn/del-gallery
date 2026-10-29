import { useCallback, useEffect, useState } from "react";
import { api, RootInfo } from "../api";

type Props = {
  scanning: boolean;
  onClose: () => void;
  /** A scan was queued from here — the gallery should show its progress. */
  onScanStarted: () => void;
  /** Library folders were added/removed/moved — the gallery should refetch. */
  onChanged: () => void;
  onReset: () => void;
};

const nf = new Intl.NumberFormat();

export default function SettingsDialog({ scanning, onClose, onScanStarted, onChanged, onReset }: Props) {
  const [roots, setRoots] = useState<RootInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.roots().then(setRoots), []);

  useEffect(() => {
    load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [load, onClose]);

  // Counts change as a scan progresses; refresh when it finishes.
  useEffect(() => {
    if (!scanning) load();
  }, [scanning, load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
    await load();
    onChanged();
  };

  const add = () =>
    run(async () => {
      const r = await api.addRoot();
      if (r) onScanStarted();
    });

  const rescan = (id: number) =>
    run(async () => {
      onScanStarted();
      const r = await api.scan(id);
      if (r.offline.length) throw new Error(`Not reachable (drive disconnected?): ${r.offline.join(", ")}`);
    });

  const relocate = (r: RootInfo) =>
    run(async () => {
      const moved = await api.relocateRoot(r.id);
      if (moved) {
        onScanStarted();
        await api.scan(r.id);
      }
    });

  const remove = (r: RootInfo) => {
    if (!confirm(`Remove "${r.path}" from the library?\n\nIts cached folders and tags are dropped from the app. Nothing on disk is touched — tags stay in the cover JPEGs.`))
      return;
    run(() => api.removeRoot(r.id));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="bg-neutral-950 border border-neutral-800 rounded-lg shadow-2xl w-[640px] max-w-full max-h-full overflow-y-auto"
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-900 bg-neutral-900/40">
          <div className="text-[11px] uppercase tracking-wider text-neutral-400 font-medium">Settings</div>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-100 text-sm leading-none">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-6 text-sm">
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-medium text-neutral-200">Library folders</h3>
              <button
                onClick={add}
                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded text-xs font-medium text-white"
              >
                + Add folder
              </button>
            </div>
            <p className="text-xs text-neutral-500 mb-3">
              Every folder here is scanned and shown together in the gallery. Use the library picker in the header to
              look at just one.
            </p>

            {roots && roots.length === 0 && <div className="text-neutral-500 text-xs py-2">No folders yet.</div>}
            <div className="space-y-2">
              {roots?.map((r) => (
                <div key={r.id} className="rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${r.online ? "bg-emerald-400" : "bg-neutral-600"}`}
                      title={r.online ? "Reachable" : "Not reachable"}
                    />
                    <span className="font-mono text-[13px] text-neutral-100 truncate flex-1" title={r.path}>
                      {r.path}
                    </span>
                    {!r.online && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/50 text-amber-200 shrink-0">
                        offline
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-neutral-500">
                    {nf.format(r.chapters)} chapters · {nf.format(r.pages)} pages
                    {r.lastScanned ? ` · scanned ${new Date(r.lastScanned * 1000).toLocaleDateString()}` : " · not scanned yet"}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                    <SmallBtn disabled={scanning || !r.online} onClick={() => rescan(r.id)}>
                      Rescan
                    </SmallBtn>
                    <SmallBtn
                      disabled={scanning}
                      onClick={() => relocate(r)}
                      title="The folder moved, or the drive came back under a different letter. Keeps tags and folder ids."
                    >
                      Change location…
                    </SmallBtn>
                    <SmallBtn disabled={!r.online} onClick={() => run(() => api.openFolder(r.path))}>
                      Show in Explorer
                    </SmallBtn>
                    <SmallBtn danger disabled={scanning} onClick={() => remove(r)}>
                      Remove
                    </SmallBtn>
                  </div>
                </div>
              ))}
            </div>
            {error && <div className="mt-2 text-xs text-red-400 break-words">{error}</div>}
          </section>

          <section className="pt-4 border-t border-neutral-900">
            <h3 className="font-medium text-neutral-200 mb-1">Reset</h3>
            <p className="text-xs text-neutral-500 mb-2">
              Wipes the whole cache: library folders, scanned folders and the tag index. Tags inside your JPEGs are kept.
            </p>
            <SmallBtn danger disabled={scanning} onClick={onReset}>
              Reset DB…
            </SmallBtn>
          </section>
        </div>
      </div>
    </div>
  );
}

function SmallBtn({
  children,
  onClick,
  disabled,
  danger,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-2.5 py-1 rounded disabled:opacity-40 ${
        danger ? "bg-red-900/50 hover:bg-red-800 text-red-100" : "bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
      }`}
    >
      {children}
    </button>
  );
}
