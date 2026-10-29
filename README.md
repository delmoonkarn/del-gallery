# Gallery (local)

A small desktop app to browse and read folders of images — everything stays on your disk (no servers, no uploads).

What it does
- Scans one or more library folders for image-containing subfolders (each becomes a chapter). Manage them in Settings: add, rescan, change location (drive letter changed / folder moved), remove.
- Shows covers (first natural image; parents inherit child covers).
- Reads .cbz / .zip chapters directly, without extracting them.
- Tags, ★ ratings and ♥ favourites, written into the cover JPEG's XMP (Windows Explorer shows the tags and stars).
- Settings → Tags: rename, merge or delete a tag across the whole library. Settings → Stats: library overview.
- Multi-select (Ctrl/Shift+click, Ctrl+A): tag, untag, rate, favourite or move many folders at once.
- Search, multi-tag / favourite / star filters, sort options and random.
- Reader: single / two-page / scroll, left-to-right or right-to-left, fit height / fit width / original size, zoom (Ctrl+wheel, + / −) and drag to pan. In two-page mode, wide double-page scans get a spread of their own so the pairs stay aligned ("Cover alone" and Shift+← / → fix the rest).
- Persistent SQLite cache for fast startup.

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

Data locations
- cache.db — app cache (next to the executable / package.json in dev)
- userdata/ — Electron runtime data (Chromium caches, IndexedDB)
- Tags / ratings / favourites persist in cover JPEGs (safe to delete cache.db) — except for .cbz/.zip chapters, series folders and PNG/WebP covers, which keep them in cache.db only

Requirements
- Node.js 20+
- Works on Windows; also runs on macOS and Linux for development
