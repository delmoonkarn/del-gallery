# Working on this codebase

Notes for the next dev (or AI agent) picking this up. Pairs with `README.md`
(which is for end users) and `SCROLL_RESTORE_NOTES.md` (a focused log of one
ongoing problem).

## 30-second summary

Electron + React + TypeScript desktop app. The user picks a root folder; the
main process recursively scans it for image-bearing directories, extracts XMP
tags from cover JPEGs, stores everything in a local SQLite cache, then the
React UI lets the user browse and read.

No HTTP server. No external services. Cache and all Electron runtime data live
next to the app, not in `%APPDATA%`.

## Architecture

Two processes, one boundary.

```
┌────────── Renderer (Chromium) ──────────┐  ┌────── Main (Node) ──────┐
│ React UI                                │  │ Electron lifecycle      │
│ Routing: React Router HashRouter        │  │ IPC handlers            │
│ State: Zustand (src/renderer/store.ts)  │◄─┤ SQLite (better-sqlite3) │
│ Local images via:                       │  │ Recursive scanner       │
│   <img src="local://f/<encoded path>">  │  │ XMP parser/writer       │
│                                         │  │ JPEG re-encode helpers  │
│ window.api.xxx() ─── ipcRenderer ──────►│  │ shell:open-path, etc.   │
└─────────────────────────────────────────┘  └─────────────────────────┘
```

The renderer **cannot** import Node modules. It talks to the main process only
through the `window.api` bridge defined in `src/main/preload.ts` (CJS, must
stay CJS — see "Gotchas" below).

The `local://` protocol is registered in `src/main/index.ts`. URLs look like
`local://f/<urlencoded-absolute-path>`. The fake `f` host exists so the URL
parser doesn't choke on Windows drive letters (`G:`).

## File map

```
src/
├── main/
│   ├── index.ts        Electron entry. App lifecycle, local:// protocol,
│   │                   userData/sessionData/logs path redirection.
│   ├── preload.ts      contextBridge → window.api. ESM type but emitted CJS.
│   ├── ipc.ts          All ipcMain.handle() endpoints. The IPC surface.
│   ├── db.ts           SQLite open + schema + small helpers (upsertTag, get/setMeta).
│   ├── scanner.ts      Recursive directory walk, XMP read, cover bubble-up.
│   ├── xmp.ts          Hand-rolled JPEG APP1 + XMP packet reader & writer.
│   └── image.ts        ensureJpeg (nativeImage fallback) + writeJpegBuffer
│                       (accepts a renderer-encoded JPEG buffer).
└── renderer/
    ├── main.tsx        ReactDOM mount + router.
    ├── api.ts          window.api typing + toLocalUrl helper.
    ├── store.ts        Zustand store. Filters, sort, reader mode.
    ├── index.css       Tailwind base + a few custom rules (scrollbar, card flash).
    ├── pages/
    │   ├── Gallery.tsx     "/" — root's children, search/filter/sort/random.
    │   ├── FolderView.tsx  "/folder/:id" — drill-in (subfolders + pages overview + tags).
    │   └── Reader.tsx      "/read/:id" — reader (single / double / scroll).
    ├── components/
    │   ├── Card.tsx              Folder thumbnail. Stashes "last visited" on click.
    │   ├── SortPicker.tsx        Sort dropdown. Has main / folder scope.
    │   ├── TagFilter.tsx         Tag chip row with search input.
    │   ├── TagEditor.tsx         Inline tag editor (input + searchable dropdown).
    │   ├── SearchableTagDropdown Picker used by TagEditor.
    │   └── Breadcrumb.tsx        Used in FolderView header.
    └── lib/
        ├── lastVisited.ts        Stash "which card did the user click" by source route.
        ├── useScrollRestore.ts   Fallback scroll-position hook.
        └── convertToJpeg.ts      Canvas-based PNG/WebP/etc → JPEG (force-able).
```

## Key patterns

### Adding an IPC endpoint

1. Add `ipcMain.handle("namespace:action", ...)` in `src/main/ipc.ts`.
2. Add a typed wrapper in the `api` object in `src/main/preload.ts`.
3. Call it as `api.<name>(...)` from the renderer. The type flows through
   `export type Api = typeof api`.

### Adding a new page / route

1. Create `src/renderer/pages/XYZ.tsx`.
2. Register it in `src/renderer/main.tsx` under the existing `<HashRouter>`.
3. If the page should restore scroll on back, call `useScrollRestore(routeKey, ready)`.
4. If clicking a `<Card>` should land on this page, no Card change needed —
   Card always navigates to `/folder/:id`. Edit `Card.tsx` if you need a
   different destination.

### Adding a sort option

1. Add the literal to `SortBy` in `src/renderer/store.ts`.
2. Mirror in `Sort` (`src/main/ipc.ts`) and `SortOpt` (`src/main/preload.ts`
   AND `src/renderer/api.ts` — same type intentionally duplicated across the
   boundary because the renderer can't import from main).
3. Add a case to `orderBy()` in `src/main/ipc.ts`.
4. Add an entry to `OPTIONS` in `src/renderer/components/SortPicker.tsx`.

### Tag editing flow

`TagEditor` always pre-converts the cover via `convertCoverToJpeg` (canvas →
JPEG buffer → main writes it) before calling `api.writeTags`. This is because
Electron's `nativeImage` can't decode WebP, so we use Chromium's decoder via
`<canvas>` and ship the encoded bytes over IPC. If `writeTags` fails with
"not a JPEG" (file misnamed `.jpg`), we retry with `convertCoverToJpeg(path, true)`
which forces a re-encode regardless of extension.

### "local://" protocol

`toLocalUrl(absPath)` in `src/renderer/api.ts` is the **only** correct way to
build a URL for a local image. Don't roll your own — Windows drive letters
break the URL parser unless you use the fake `f` host.

## Database

SQLite, WAL mode, lives at `<app folder>/cache.db`. Schema in
`src/main/db.ts`. There are five tables:

- `folders` — one row per directory. Path, parent_id, depth, image_count,
  cover_path, mtime, last_scanned.
- `tags` — unique tag names (case-insensitive).
- `folder_tags` — m2m with a `source` column (`'xmp'` for tags read from the
  cover JPEG, `'user'` for tags the user typed in the editor). The scanner
  only deletes `'xmp'` rows on rescan; user tags are preserved.
- `roots` — the library folders the user added (Settings dialog). Each one
  is scanned into a parent-less row in `folders` (matched by path); the
  gallery's top level is the children of all of them, or of the one picked in
  the header's library dropdown. Logic lives in `src/main/roots.ts`.
  Overlapping roots: adding a folder inside a root is refused; adding one
  that contains roots absorbs them (rows are kept and re-parented by the scan).
  Older DBs had a single `meta.root_path`; `migrateRoots()` in `db.ts` turns
  every parent-less folder row into a root once.
- `meta` — small key/value store (currently unused). Wipe is via Settings →
  Reset DB (clears all tables + VACUUMs).

`image_count` is **direct images only** (not recursive). The min-pages filter
in the UI relies on that.

`cover_path` is computed in two passes during scan:

1. Walk pass: set to `images[0]` for folders with images, NULL for parents.
2. Bubble-up pass: repeatedly UPDATE NULL covers with the first child's cover
   until no more rows change.

## Gotchas

- **Preload MUST be CJS.** ESM preloads have a load-timing race in Electron 32
  where `contextBridge.exposeInMainWorld` sometimes lands after the renderer's
  first script runs. `vite.config.ts` forces preload output to `preload.cjs`.
  Do not "fix" this.
- **`__dirname` in main.** Main is emitted as ESM (`"type": "module"`), so we
  derive `__dirname` via `fileURLToPath(import.meta.url)`. Don't reach for
  `require` either.
- **`window.api` undefined.** If you see this in the renderer, preload didn't
  load. There's a guard in `src/renderer/api.ts` that renders a red error
  banner instead of going blank.
- **Drive letters in URLs.** Always go through `toLocalUrl`. The fake `f` host
  matters.
- **`%APPDATA%` writes.** Don't add code that calls `app.getPath("userData")`
  or any other auto-located path. We deliberately redirect those in
  `src/main/index.ts` so the app folder stays self-contained.
- **Scroll restoration is the long-running pain point.** See
  `SCROLL_RESTORE_NOTES.md` for the full history. The current strategy is
  two-pronged: when the user clicks a `<Card>` we stash the card's folder id
  via `lastVisited.ts`; on return we `scrollIntoView` that card and flash it.
  `useScrollRestore` is a fallback for routes where no card was clicked
  (breadcrumb / popstate). Diagnostic switch:
  `window.__scrollDebug = true` in DevTools.
- **Tags travel with the JPEG.** They live in the file's XMP packet **and**
  the cache. Deleting `cache.db` doesn't lose tags. Renaming / moving a JPEG
  outside the app keeps its tags too.
- **Read-only files.** Before writing XMP we `fs.chmod(path, 0o666)` to clear
  the Windows read-only attribute. Same for unlink during conversion.
- **Native modules** (`better-sqlite3`) are rebuilt for Electron's ABI by the
  `postinstall` script (`electron-builder install-app-deps`). If you see an
  ABI mismatch error after upgrading Electron, just re-run `npm install`.

## Common tasks recipe

### "Add a filter to the gallery"

1. Add the state + setter to `src/renderer/store.ts` (persist to
   `localStorage` if it should survive restarts).
2. Add the parameter to `library:children` and `library:search` (and
   `library:random` if relevant) in `src/main/ipc.ts`.
3. Mirror in `preload.ts` and `api.ts`.
4. Render a control in `Gallery.tsx` (header area is the convention).
5. Make sure the `refresh` `useCallback`'s deps include the new state, and
   that the existing refetch `useEffect` will run when it changes.

### "Show some new info on each card"

Edit `src/renderer/components/Card.tsx`. If you need a new field on
`FolderRow`:

1. Add the column to `SELECT_COLS` in `src/main/ipc.ts` (or a computed
   subquery like `child_count`).
2. Add the field to **all three** `FolderRow` definitions: `ipc.ts`,
   `preload.ts`, `renderer/api.ts`. They're intentionally duplicated.

### "Add a new keyboard shortcut to the reader"

`src/renderer/pages/Reader.tsx`, the `useEffect` with `onKey`. Watch the deps
list — every captured variable must appear there or you'll fire on stale state.

## Open issues / TODOs

- **Scroll-restore on routes without a card click**. The `lastVisited`
  approach covers the common case but breadcrumb navigation falls back to
  `useScrollRestore`, which has been historically flaky. See notes file.
- **Incremental scan.** The scanner re-walks the entire tree every time. It
  could skip directories whose mtime is unchanged. The DB already records
  `mtime` and `last_scanned`.
- **Tag inheritance for parent folders.** A parent folder bubbles up a
  *cover* from its first child, but **not** the tags. Searching for a tag
  surfaces the leaf, not the parent. Often what you want, but worth
  remembering.
- **Animated GIF covers.** Only the first frame is captured during JPEG
  conversion. We delete the original — destructive on GIFs in particular.
- **Reader's keyboard listener re-binds on every state change.** Not a bug,
  just chatty. Could refactor to a ref pattern if anyone cares.

## Verifying changes

Always run after editing:

```bash
npx tsc --noEmit                                           # types compile
npx tsc --noEmit --noUnusedLocals --noUnusedParameters     # stricter; catches dead code
```

Then **Ctrl+R** inside the Gallery window to force the renderer to
reload (HMR is mostly reliable but not always).

For a backend-only change, the dev process auto-restarts the Electron main
when `src/main/**` changes — give it a couple of seconds.
