import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, FolderRow, toLocalUrl } from "../api";
import { setLastVisited } from "../lib/lastVisited";
import { useStore } from "../store";
import RenameDialog from "./RenameDialog";

type Props = {
  row: FolderRow;
  onChanged?: () => void;
  /** Ids of every card in the current view, in display order — for Shift+click ranges. */
  order?: number[];
};

export default function Card({ row, onChanged, order }: Props) {
  const nav = useNavigate();
  const location = useLocation();
  const [renaming, setRenaming] = useState(false);
  const [favorite, setFavorite] = useState(row.favorite === 1);
  useEffect(() => setFavorite(row.favorite === 1), [row.favorite]);
  const selected = useStore((s) => s.selected.includes(row.id));
  const selecting = useStore((s) => s.selected.length > 0);
  const toggleSelected = useStore((s) => s.toggleSelected);
  const selectRange = useStore((s) => s.selectRange);

  // Always show the overview/gallery first; the Reader is opened from there.
  const goto = () => {
    setLastVisited(location.pathname, row.id);
    nav(`/folder/${row.id}`);
  };
  // Ctrl+click toggles, Shift+click extends; once anything is selected a plain click toggles too.
  const onClick = (e: React.MouseEvent) => {
    if (e.shiftKey && order) selectRange(row.id, order);
    else if (e.ctrlKey || e.metaKey || selecting) toggleSelected(row.id);
    else goto();
  };
  const mixed = row.image_count > 0 && row.child_count > 0;

  const toggleFavorite = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const next = !favorite;
    setFavorite(next);
    try {
      await api.setMeta(row.id, { favorite: next });
    } catch (err) {
      setFavorite(!next);
      alert(`Could not save: ${(err as Error).message}`);
    }
  };

  return (
    <button onClick={onClick} data-folder-id={row.id} className="group text-left w-full block relative">
      <span
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleSelected(row.id);
        }}
        role="checkbox"
        aria-checked={selected}
        title="Select (Ctrl+click, Shift+click for a range)"
        className={`absolute top-1 left-1 z-10 w-5 h-5 flex items-center justify-center rounded text-xs transition cursor-pointer ${
          selected
            ? "bg-indigo-600 text-white opacity-100"
            : `bg-black/70 text-transparent hover:text-neutral-300 ${selecting ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`
        }`}
      >
        ✓
      </span>
      <span
        onClick={toggleFavorite}
        role="button"
        title={favorite ? "Remove from favourites" : "Add to favourites"}
        className={`absolute top-1 right-8 z-10 px-1.5 py-0.5 text-xs bg-black/70 rounded transition cursor-pointer ${
          favorite ? "text-rose-500 opacity-100" : "text-neutral-100 hover:text-rose-400 opacity-0 group-hover:opacity-100"
        }`}
      >
        {favorite ? "♥" : "♡"}
      </span>
      <span
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setRenaming(true);
        }}
        role="button"
        title="Rename folder"
        className="absolute top-1 right-1 z-10 px-1.5 py-0.5 text-xs bg-black/70 hover:bg-indigo-600 text-neutral-100 rounded opacity-0 group-hover:opacity-100 transition cursor-pointer"
      >
        ✎
      </span>
      {renaming && (
        <span
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <RenameDialog
            folderId={row.id}
            currentName={row.name}
            onRenamed={() => {
              setRenaming(false);
              onChanged?.();
            }}
            onCancel={() => setRenaming(false)}
          />
        </span>
      )}
      <div
        className={`aspect-[2/3] bg-neutral-800 overflow-hidden rounded-md transition relative ${
          selected ? "ring-2 ring-indigo-400" : "ring-1 ring-neutral-800 group-hover:ring-indigo-500"
        }`}
      >
        {row.cover_path ? (
          <img
            src={toLocalUrl(row.cover_path)}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-neutral-600 text-xs">no cover</div>
        )}
        {selected && <div className="absolute inset-0 bg-indigo-500/20 pointer-events-none" />}
        {(row.rating > 0 || row.is_archive === 1) && (
          <div className="absolute bottom-1 left-1 right-1 flex items-center gap-1 pointer-events-none">
            {row.rating > 0 && (
              <span className="text-[11px] leading-none px-1 py-0.5 bg-black/70 text-amber-400 rounded tracking-tighter">
                {"★".repeat(row.rating)}
              </span>
            )}
            {row.is_archive === 1 && (
              <span className="ml-auto text-[10px] leading-none px-1 py-0.5 bg-black/70 text-sky-300 rounded" title="Read from a .cbz/.zip archive">
                ZIP
              </span>
            )}
          </div>
        )}
      </div>
      <div className="mt-2 text-sm text-neutral-100 truncate flex items-center gap-1.5" title={row.name}>
        <span className="truncate">{row.name}</span>
        {mixed && (
          <span
            className="shrink-0 text-[10px] px-1 py-px bg-amber-700/50 text-amber-200 rounded"
            title={`${row.image_count} images here + ${row.child_count} subfolders`}
          >
            ↳{row.child_count}
          </span>
        )}
      </div>
      {row.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {row.tags.slice(0, 5).map((t) => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 bg-neutral-800 text-neutral-300 rounded">
              {t}
            </span>
          ))}
          {row.tags.length > 5 && (
            <span className="text-[10px] px-1.5 py-0.5 text-neutral-500">+{row.tags.length - 5}</span>
          )}
        </div>
      )}
    </button>
  );
}
