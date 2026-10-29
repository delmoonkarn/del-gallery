import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, FolderRow, toLocalUrl } from "../api";
import Card from "../components/Card";
import SortPicker from "../components/SortPicker";
import Breadcrumb, { Crumb } from "../components/Breadcrumb";
import TagEditor from "../components/TagEditor";
import RenameDialog from "../components/RenameDialog";
import RatingControl from "../components/RatingControl";
import BulkBar from "../components/BulkBar";
import { useScrollRestore } from "../lib/useScrollRestore";
import { getLastVisited, focusFolderCard, clearLastVisited } from "../lib/lastVisited";
import { useStore } from "../store";

export default function FolderView() {
  const { id } = useParams();
  const folderId = Number(id);
  const nav = useNavigate();
  const [rows, setRows] = useState<FolderRow[]>([]);
  const [self, setSelf] = useState<FolderRow | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [subExpanded, setSubExpanded] = useState(false);
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [editTags, setEditTags] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const { clearTags, toggleTag, folderSortBy, folderSortDir } = useStore();

  const refreshSelf = async () => {
    const [fresh, freshPages] = await Promise.all([api.get(folderId), api.pages(folderId)]);
    setSelf(fresh);
    setPages(freshPages);
  };

  const refreshChildren = async () => {
    setRows(await api.children(folderId, { by: folderSortBy, dir: folderSortDir }));
  };

  const filterByTag = (tag: string) => {
    clearTags();
    toggleTag(tag);
    nav("/");
  };

  useEffect(() => {
    api.get(folderId).then(setSelf);
    api.children(folderId, { by: folderSortBy, dir: folderSortDir }).then(setRows);
    api.pages(folderId).then(setPages);
    api.ancestors(folderId).then(setTrail);
  }, [folderId, folderSortBy, folderSortDir]);

  const routeKey = `/folder/${folderId}`;
  const lastChild = getLastVisited(routeKey);
  useScrollRestore(
    routeKey,
    (rows.length > 0 || pages.length > 0 || self !== null) && lastChild === undefined
  );
  useEffect(() => {
    if (rows.length === 0) return;
    const target = getLastVisited(routeKey);
    if (target === undefined) return;
    focusFolderCard(target);
    clearLastVisited(routeKey);
  }, [rows, routeKey]);

  const order = rows.map((r) => r.id);
  const hasImages = (self?.image_count ?? 0) > 0;
  const hasChildren = rows.length > 0;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="sticky top-0 z-10 bg-neutral-950/95 backdrop-blur border-b border-neutral-900 p-4 flex gap-3 items-center">
        <button
          onClick={() => nav(-1)}
          className="text-sm text-indigo-400 hover:text-indigo-300 shrink-0"
          title="Go back"
        >
          ←
        </button>
        <div className="flex-1 min-w-0" title={self?.path}>
          <Breadcrumb trail={trail} />
        </div>
        {self && (
          <RatingControl
            folderId={self.id}
            rating={self.rating}
            favorite={self.favorite === 1}
            onChange={(v) => setSelf({ ...self, rating: v.rating, favorite: v.favorite ? 1 : 0 })}
          />
        )}
        {hasChildren && <SortPicker scope="folder" />}
        {self && (
          <button
            onClick={() => setRenaming(true)}
            className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-xs whitespace-nowrap"
            title="Rename this folder"
          >
            ✎ Rename
          </button>
        )}
        {self?.path && (
          <button
            onClick={() =>
              api.openFolder(self.path).catch((e: Error) => alert(`Could not open: ${e.message}`))
            }
            className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-xs whitespace-nowrap"
            title="Open this folder in File Explorer"
          >
            📁 Open
          </button>
        )}
        {hasImages && (
          <button
            onClick={() => nav(`/read/${folderId}`)}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded text-sm whitespace-nowrap"
            title={`Read the ${self?.image_count} image(s) in this folder`}
          >
            ▶ Read {self?.image_count} {self?.image_count === 1 ? "image" : "images"}
          </button>
        )}
      </header>

      <main className="p-4 space-y-6">
        {hasChildren && (
          <section>
            <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2 flex items-center gap-2">
              <span>Subfolders</span>
              <span className="text-neutral-600">({rows.length})</span>
              <div className="flex-1" />
              <button
                onClick={() => setSubExpanded((v) => !v)}
                className="text-[11px] px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded normal-case tracking-normal"
                title={subExpanded ? "Collapse into a single scrollable row" : "Show all subfolders in a full grid"}
              >
                {subExpanded ? "Collapse" : "Show all"}
              </button>
            </div>
            {subExpanded ? (
              <div
                className="grid gap-4"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
              >
                {rows.map((r) => (
                  <Card key={r.id} row={r} onChanged={refreshChildren} order={order} />
                ))}
              </div>
            ) : (
              <div className="flex gap-4 overflow-x-auto pb-2 snap-x">
                {rows.map((r) => (
                  <div key={r.id} className="w-[180px] shrink-0 snap-start">
                    <Card row={r} onChanged={refreshChildren} order={order} />
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {hasImages && self && (
          <section>
            <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2 flex items-center gap-2">
              <span>Tags</span>
              <span className="text-neutral-600">({self.tags.length})</span>
              <div className="flex-1" />
              <button
                onClick={() => setEditTags((v) => !v)}
                className="text-[11px] px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded normal-case tracking-normal"
                title="Edit tags (writes XMP to the cover image)"
              >
                {editTags ? "Close" : self.tags.length > 0 ? "Edit" : "Add tags"}
              </button>
            </div>
            {editTags && self.cover_path ? (
              <TagEditor
                folderId={self.id}
                initial={self.tags}
                coverPath={self.cover_path}
                onSaved={async () => {
                  setEditTags(false);
                  await refreshSelf();
                }}
                onCancel={() => setEditTags(false)}
              />
            ) : self.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {self.tags.map((t) => (
                  <button
                    key={t}
                    onClick={() => filterByTag(t)}
                    className="text-xs px-2 py-1 bg-neutral-800 hover:bg-indigo-600 hover:text-white text-neutral-200 rounded transition"
                    title={`Filter the main gallery by "${t}"`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-xs text-neutral-600">No tags yet.</div>
            )}
          </section>
        )}

        {hasImages && (
          <section>
            <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2 flex items-center gap-2">
              <span>Pages overview</span>
              <span className="text-neutral-600">({pages.length})</span>
            </div>
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}
            >
              {pages.map((p, i) => (
                <button
                  key={p}
                  onClick={() => nav(`/read/${folderId}?p=${i}`)}
                  className="aspect-[2/3] bg-neutral-800 rounded overflow-hidden ring-1 ring-neutral-800 hover:ring-indigo-500 transition relative group"
                  title={`Page ${i + 1}`}
                >
                  <img
                    src={toLocalUrl(p)}
                    loading="lazy"
                    className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                    alt=""
                  />
                  <span className="absolute bottom-1 right-1 text-[10px] bg-black/70 text-neutral-100 px-1 rounded tabular-nums">
                    {i + 1}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {!hasImages && !hasChildren && (
          <div className="text-neutral-500 text-sm p-8 text-center">Empty folder.</div>
        )}
      </main>

      <BulkBar visibleIds={order} onDone={refreshChildren} />

      {renaming && self && (
        <RenameDialog
          folderId={self.id}
          currentName={self.name}
          onRenamed={async () => {
            setRenaming(false);
            await refreshSelf();
            await api.ancestors(folderId).then(setTrail);
          }}
          onCancel={() => setRenaming(false)}
        />
      )}
    </div>
  );
}
