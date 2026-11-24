# Gallery 

A small desktop app to browse and read folders of images — everything stays on your disk.

What it does
- Scans one or more library folders for image-containing subfolders (each becomes a chapter). Manage them in Settings: add, rescan, change location (drive letter changed / folder moved), remove.
- **Incremental rescans** — only re-reads directories whose mtime changed since the last scan, and prunes rows for folders deleted on disk. Thousands of unchanged folders cost one `stat` each. Rescanning after adding a few titles is near-instant even on a slow HDD. Scanner stays responsive (no "Not Responding") on large libraries.
- Shows covers (first natural image; parents inherit child covers).
- Reads .cbz / .zip chapters directly, without extracting them.
- Tags, ★ ratings and ♥ favourites, written into the cover JPEG's XMP (Windows Explorer shows the tags and stars).
- Settings → Tags: rename, merge or delete a tag across the whole library. Settings → Stats: library overview.
- Multi-select (Ctrl/Shift+click, Ctrl+A): tag, untag, rate, favourite or move many folders at once.
- Search, multi-tag / favourite / star filters, sort options (name, modified, pages, random) and a random-folder picker.
- At the end of a chapter, pressing next (or prev at the start) pops a dialog with the next/previous chapter's cover, title and tags — one click to continue reading.
- Rename folders from the gallery or a card — on disk and in the cache in one go, with all descendant paths and cover paths patched.
- Reader: single / two-page / scroll, left-to-right or right-to-left, fit height / fit width / original size, zoom (Ctrl+wheel, + / −) and drag to pan. In two-page mode, wide double-page scans get a spread of their own so the pairs stay aligned ("Cover alone" and Shift+← / → fix the rest).
- Persistent SQLite cache for fast startup. Diagnostic log at `main.log` next to the cache — captures scanner timings, timeouts and any errors.

Quick start
```bash
npm install
npm run dev   # dev with HMR
# or run.bat
```

Tech highlights
- Electron + React + TypeScript + Vite
- local:// protocol for images (no HTTP server)
- SQLite via better-sqlite3 (WAL)
- Canvas-based conversions for non-JPEG images
- Reader pages are downscaled with pica (high-quality resampling) instead of the browser's default, so screentone and lettering stay crisp

Data locations
- cache.db — app cache (next to the executable / package.json in dev)
- userdata/ — Electron runtime data (Chromium caches, IndexedDB)
- Tags / ratings / favourites persist in cover JPEGs (safe to delete cache.db) — except for .cbz/.zip chapters, series folders and PNG/WebP covers, which keep them in cache.db only

Requirements
- Node.js 20+
- Works on Windows; also runs on macOS and Linux for development
