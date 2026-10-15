# Manga Reader (local)

A small desktop app to read folders of images as manga/comics — everything stays on your disk (no servers, no uploads).

What it does
- Scans a root folder for image-containing subfolders (each becomes a chapter).
- Shows covers (first natural image; parents inherit child covers).
- Reads and writes JPEG XMP tags (Windows "Tags" / dc:subject).
- Search, multi-tag filters, sort options, and a reader with single/two-page/scroll modes.
- Persistent SQLite cache for fast startup; tags are also stored in the JPEGs.

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
- Tags persist in cover JPEGs (safe to delete cache.db)

Requirements
- Node.js 20+
- Works on Windows; also runs on macOS and Linux for development
