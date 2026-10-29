import { useStore, SortBy, SortDir } from "../store";

const OPTIONS: { value: string; label: string; by: SortBy; dir: SortDir }[] = [
  { value: "name:asc", label: "Name A → Z", by: "name", dir: "asc" },
  { value: "name:desc", label: "Name Z → A", by: "name", dir: "desc" },
  { value: "mtime:desc", label: "Modified newest", by: "mtime", dir: "desc" },
  { value: "mtime:asc", label: "Modified oldest", by: "mtime", dir: "asc" },
  { value: "image_count:desc", label: "Most pages", by: "image_count", dir: "desc" },
  { value: "image_count:asc", label: "Fewest pages", by: "image_count", dir: "asc" },
  { value: "rating:desc", label: "★ Highest rated", by: "rating", dir: "desc" },
  { value: "rating:asc", label: "★ Lowest rated", by: "rating", dir: "asc" },
  { value: "random:asc", label: "🎲 Random", by: "random", dir: "asc" },
];

export default function SortPicker({ scope = "main" }: { scope?: "main" | "folder" }) {
  const store = useStore();
  const by = scope === "folder" ? store.folderSortBy : store.sortBy;
  const dir = scope === "folder" ? store.folderSortDir : store.sortDir;
  const setSort = scope === "folder" ? store.setFolderSort : store.setSort;
  const value = `${by}:${dir}`;

  return (
    <select
      value={value}
      onChange={(e) => {
        const opt = OPTIONS.find((o) => o.value === e.target.value);
        if (opt) setSort(opt.by, opt.dir);
      }}
      className="px-2 py-1 bg-neutral-900 border border-neutral-800 rounded text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      title={scope === "folder" ? "Sort subfolders" : "Sort top-level folders"}
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
