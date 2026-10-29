import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, RootInfo, Stats as StatsData } from "../api";
import { useStore } from "../store";

const nf = new Intl.NumberFormat();

/**
 * Settings → Stats: totals, ratings, favourites, top tags, biggest/newest
 * chapters. Clicking through closes Settings and goes to the folder / tag.
 */
export default function StatsPanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const nav = (to: string) => {
    onClose();
    navigate(to);
  };
  const { library, setLibrary, clearTags, toggleTag } = useStore();
  const [data, setData] = useState<StatsData | null>(null);
  const [roots, setRoots] = useState<RootInfo[]>([]);

  useEffect(() => {
    api.roots().then(setRoots);
  }, []);
  useEffect(() => {
    setData(null);
    api.stats(library).then(setData);
  }, [library]);

  const filterByTag = (tag: string) => {
    clearTags();
    toggleTag(tag);
    nav("/");
  };

  const maxTag = Math.max(1, ...(data?.topTags.map((t) => t.n) ?? [1]));
  const maxRating = Math.max(1, ...(data?.ratingCounts ?? [1]));

  return (
    <div className="text-neutral-100">
      <div className="px-4 pt-4 flex items-center gap-3">
        <div className="text-xs text-neutral-500">
          {library == null ? "Whole library" : `Only ${roots.find((r) => r.id === library)?.name ?? "one library"}`} — follows the
          gallery's library picker.
        </div>
        <div className="flex-1" />
        {roots.length > 1 && (
          <select
            value={library ?? ""}
            onChange={(e) => setLibrary(e.target.value ? Number(e.target.value) : null)}
            className="px-2 py-1 bg-neutral-900 border border-neutral-800 rounded text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="">All libraries ({roots.length})</option>
            {roots.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {!data ? (
        <div className="p-8 text-sm text-neutral-500">Counting…</div>
      ) : (
        <div className="p-4 space-y-6">
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            <Tile label="Chapters" value={data.chapters} />
            <Tile label="Pages" value={data.pages} />
            <Tile label="Folders" value={data.folders} />
            <Tile label="Archives (.cbz/.zip)" value={data.archives} />
            <Tile label="Favourites" value={data.favorites} accent="text-rose-400" />
            <Tile label="Rated" value={data.rated} accent="text-amber-400" />
            <Tile label="Tags in use" value={data.tags} />
            <Tile label="Avg pages / chapter" value={data.chapters ? Math.round(data.pages / data.chapters) : 0} />
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <Panel title="Ratings (chapters)">
              {[5, 4, 3, 2, 1, 0].map((r) => (
                <Bar
                  key={r}
                  label={r ? "★".repeat(r) : "unrated"}
                  labelClass={r ? "text-amber-400" : "text-neutral-500"}
                  n={data.ratingCounts[r]}
                  max={maxRating}
                  color={r ? "bg-amber-500/70" : "bg-neutral-700"}
                />
              ))}
            </Panel>

            <Panel title="Libraries">
              {data.libraries.length === 0 && <Empty />}
              {data.libraries.map((l) => (
                <div key={l.name} className="flex items-center justify-between text-sm py-1 border-b border-neutral-900 last:border-0">
                  <span className="truncate">{l.name}</span>
                  <span className="text-neutral-400 tabular-nums text-xs">
                    {nf.format(l.chapters)} chapters · {nf.format(l.pages)} pages
                  </span>
                </div>
              ))}
            </Panel>
          </div>

          <Panel title={`Top tags${data.topTags.length ? ` (${data.topTags.length})` : ""}`}>
            {data.topTags.length === 0 && <Empty />}
            <div className="grid gap-x-6 md:grid-cols-2">
              {data.topTags.map((t) => (
                <Bar key={t.name} label={t.name} n={t.n} max={maxTag} onClick={() => filterByTag(t.name)} color="bg-indigo-500/70" />
              ))}
            </div>
          </Panel>

          <div className="grid gap-6 md:grid-cols-3">
            <Panel title="Top rated & favourites">
              {data.topRated.length === 0 && <Empty />}
              {data.topRated.map((f) => (
                <Row key={f.id} onClick={() => nav(`/folder/${f.id}`)} name={f.name}>
                  <span className="text-amber-400">{"★".repeat(f.rating)}</span>
                  {f.favorite ? <span className="text-rose-500 ml-1">♥</span> : null}
                </Row>
              ))}
            </Panel>
            <Panel title="Most pages">
              {data.biggest.map((f) => (
                <Row key={f.id} onClick={() => nav(`/folder/${f.id}`)} name={f.name}>
                  {nf.format(f.pages)}
                </Row>
              ))}
            </Panel>
            <Panel title="Recently changed">
              {data.newest.map((f) => (
                <Row key={f.id} onClick={() => nav(`/folder/${f.id}`)} name={f.name}>
                  {new Date(f.mtime * 1000).toLocaleDateString()}
                </Row>
              ))}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2.5">
      <div className={`text-xl font-semibold tabular-nums ${accent ?? "text-neutral-100"}`}>{nf.format(value)}</div>
      <div className="text-[11px] uppercase tracking-wide text-neutral-500 mt-0.5">{label}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-neutral-800 bg-neutral-900/30 p-3">
      <h2 className="text-xs uppercase tracking-wide text-neutral-500 mb-2">{title}</h2>
      {children}
    </section>
  );
}

function Bar({
  label,
  n,
  max,
  color,
  labelClass,
  onClick,
}: {
  label: string;
  n: number;
  max: number;
  color: string;
  labelClass?: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className="w-full flex items-center gap-2 py-0.5 text-left text-sm enabled:hover:bg-neutral-800/50 rounded"
      title={onClick ? `Show folders tagged "${label}"` : undefined}
    >
      <span className={`w-28 shrink-0 truncate ${labelClass ?? "text-neutral-200"}`}>{label}</span>
      <span className="flex-1 h-2 rounded bg-neutral-800 overflow-hidden">
        <span className={`block h-full ${color}`} style={{ width: `${(n / max) * 100}%` }} />
      </span>
      <span className="w-12 text-right text-xs text-neutral-400 tabular-nums">{nf.format(n)}</span>
    </button>
  );
}

function Row({ name, onClick, children }: { name: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between gap-2 py-1 text-sm text-left border-b border-neutral-900 last:border-0 hover:text-indigo-300"
    >
      <span className="truncate" title={name}>
        {name}
      </span>
      <span className="shrink-0 text-xs text-neutral-400 tabular-nums">{children}</span>
    </button>
  );
}

function Empty() {
  return <div className="text-xs text-neutral-600">Nothing yet.</div>;
}
