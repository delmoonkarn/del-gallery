import yauzl from "yauzl";
import path from "node:path";

/**
 * Read-only access to .cbz/.zip chapters without extracting them.
 *
 * A page inside an archive is addressed as "<archive path>|<entry name>" —
 * `|` can't appear in Windows file names, so it never collides with a real
 * path. Open archives are kept in a small LRU so paging through a chapter
 * reads the central directory once and then only the page bytes.
 */

export const ARCHIVE_EXTS = new Set([".cbz", ".zip"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"]);
const SEP = "|";

export function isArchivePath(p: string): boolean {
  return ARCHIVE_EXTS.has(path.extname(p).toLowerCase());
}

export function isEntryPath(p: string): boolean {
  return p.includes(SEP);
}

export function entryPath(archive: string, entry: string): string {
  return archive + SEP + entry;
}

export function splitEntryPath(p: string): { archive: string; entry: string } {
  const i = p.indexOf(SEP);
  return { archive: p.slice(0, i), entry: p.slice(i + 1) };
}

type Open = { zip: yauzl.ZipFile; entries: Map<string, yauzl.Entry>; images: string[]; lastUsed: number };
const cache = new Map<string, Open>();
const pending = new Map<string, Promise<Open>>();
const MAX_OPEN = 8;

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// Entry names use "/" but some tools write "\"; normalise for lookups.
const norm = (name: string) => name.replace(/\\/g, "/");

function openArchive(file: string): Promise<Open> {
  const hit = cache.get(file);
  if (hit) {
    hit.lastUsed = Date.now();
    return Promise.resolve(hit);
  }
  const inflight = pending.get(file);
  if (inflight) return inflight;

  const p = new Promise<Open>((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("could not open archive"));
      const entries = new Map<string, yauzl.Entry>();
      zip.on("entry", (e: yauzl.Entry) => {
        if (!/\/$/.test(e.fileName)) entries.set(norm(e.fileName), e);
        zip.readEntry();
      });
      zip.on("end", () => {
        const images = [...entries.keys()]
          .filter((n) => IMAGE_EXTS.has(path.extname(n).toLowerCase()) && !n.startsWith("__MACOSX/"))
          .sort(naturalCompare);
        const open: Open = { zip, entries, images, lastUsed: Date.now() };
        cache.set(file, open);
        evict();
        resolve(open);
      });
      zip.on("error", reject);
      zip.readEntry();
    });
  }).finally(() => pending.delete(file));
  pending.set(file, p);
  return p;
}

function evict() {
  while (cache.size > MAX_OPEN) {
    let oldest: string | null = null;
    let t = Infinity;
    for (const [k, v] of cache) {
      if (v.lastUsed < t) {
        t = v.lastUsed;
        oldest = k;
      }
    }
    if (!oldest) return;
    cache.get(oldest)!.zip.close();
    cache.delete(oldest);
  }
}

// Windows won't let Explorer rename/delete a file we hold open, so let idle
// archives go after a minute.
const IDLE_MS = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.lastUsed > IDLE_MS) {
      v.zip.close();
      cache.delete(k);
    }
  }
}, 20_000).unref();

/** Forget an open handle — needed before the archive is renamed or moved. */
export function closeArchive(file: string): void {
  const hit = cache.get(file);
  if (hit) {
    hit.zip.close();
    cache.delete(file);
  }
}

/** Image entries in reading (natural) order. */
export async function listArchiveImages(file: string): Promise<string[]> {
  return (await openArchive(file)).images;
}

export async function readArchiveEntry(file: string, entry: string): Promise<Buffer> {
  const open = await openArchive(file);
  const e = open.entries.get(norm(entry));
  if (!e) throw new Error(`no such entry: ${entry}`);
  return new Promise((resolve, reject) => {
    open.zip.openReadStream(e, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error("could not read entry"));
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  });
}
