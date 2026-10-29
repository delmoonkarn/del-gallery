import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { convertCoverToJpeg } from "../lib/convertToJpeg";
import SearchableTagDropdown from "./SearchableTagDropdown";

type Props = {
  /** Folder whose tags are edited. */
  folderId: number;
  /** Initial tags loaded into the editor (comma-joined into the draft). */
  initial: string[];
  /** The folder's cover image, whose XMP will be rewritten ("<archive>|<entry>" for a .cbz/.zip). */
  coverPath: string;
  /** Called after a successful save. */
  onSaved: () => void;
  /** Called when the user clicks Cancel or closes the editor. */
  onCancel: () => void;
};

export default function TagEditor({ folderId, initial, coverPath, onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState(initial.join(", "));
  const [allTags, setAllTags] = useState<{ name: string; n: number }[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.allTags().then(setAllTags);
  }, []);

  useEffect(() => {
    setDraft(initial.join(", "));
  }, [initial]);

  const sortedTags = useMemo(
    () =>
      [...allTags].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      ),
    [allTags]
  );

  const usedLower = useMemo(
    () =>
      new Set(
        draft
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      ),
    [draft]
  );

  const append = (tag: string) => {
    const parts = draft.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.some((p) => p.toLowerCase() === tag.toLowerCase())) {
      parts.push(tag);
      setDraft(parts.join(", "));
    }
  };

  const save = async () => {
    const tags = draft.split(",").map((t) => t.trim()).filter(Boolean);
    setSaving(true);
    try {
      // Archive chapters can't be written into — their tags live in the cache only.
      const inArchive = coverPath.includes("|");
      // Pre-convert via the renderer's Canvas so WebP and other Chromium-decodable
      // formats work — main's nativeImage falls flat on WebP.
      if (!inArchive) await convertCoverToJpeg(coverPath);
      try {
        await api.setMeta(folderId, { tags }, !inArchive);
        onSaved();
      } catch (err: unknown) {
        const msg = (err as Error).message ?? String(err);
        // File has .jpg/.jpeg extension but its content isn't actually JPEG
        // (renamed PNG/WebP). Force a canvas re-encode and retry once.
        if (/not a JPEG|invalid JPEG/i.test(msg)) {
          await convertCoverToJpeg(coverPath, true);
          await api.setMeta(folderId, { tags }, true);
          onSaved();
        } else {
          throw err;
        }
      }
    } catch (err: unknown) {
      alert(`Failed to save tags: ${(err as Error).message ?? err}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex gap-2 items-center flex-wrap bg-neutral-950 border border-neutral-800 rounded p-2">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="comma, separated, tags"
        className="flex-1 min-w-[200px] px-2 py-1 bg-neutral-900 border border-neutral-800 rounded text-sm text-neutral-100"
      />
      <SearchableTagDropdown tags={sortedTags} excluded={usedLower} onPick={append} />
      <button
        onClick={save}
        disabled={saving}
        className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded text-sm"
      >
        {saving ? "Saving…" : "Save"}
      </button>
      <button
        onClick={onCancel}
        disabled={saving}
        className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 rounded text-sm"
      >
        Cancel
      </button>
    </div>
  );
}
