import pica from "pica";

/**
 * High-quality page scaling for the reader.
 *
 * Chromium scales <img> with a cheap filter: screentone turns into moiré and
 * lettering goes soft. pica (mks2013 filter, in web workers) resizes to the
 * exact on-screen pixel size instead; the result is drawn 1:1 on a canvas.
 * Results are cached per (page, size) so turning back is instant, and the
 * next spread can be prepared ahead of time with `resample()`.
 */

const resizer = pica();

const MAX_RESULTS = 12; // ≈ 2.5 MB each at 1080p
const MAX_SOURCES = 4; // decoded full-size pages, ≈ 15 MB each
// Upscaling beyond this gains nothing over the browser and costs memory.
const MAX_UPSCALE = 3;
const MAX_PIXELS = 24_000_000;

const results = new Map<string, HTMLCanvasElement>();
const pending = new Map<string, Promise<HTMLCanvasElement | null>>();
const sources = new Map<string, Promise<ImageBitmap>>();

const keyOf = (src: string, w: number, h: number) => `${w}x${h}@${src}`;

function touch<V>(map: Map<string, V>, key: string, value: V, max: number, drop?: (v: V) => void) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const [k, v] = map.entries().next().value as [string, V];
    map.delete(k);
    drop?.(v);
  }
}

function decode(src: string): Promise<ImageBitmap> {
  const hit = sources.get(src);
  if (hit) {
    touch(sources, src, hit, MAX_SOURCES);
    return hit;
  }
  // fetch → blob → bitmap: decoded off the main thread, and never "tainted",
  // so pica can read the pixels.
  const p = fetch(src)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.blob();
    })
    .then((b) => createImageBitmap(b));
  p.catch(() => sources.delete(src));
  touch(sources, src, p, MAX_SOURCES, (old) => old.then((b) => b.close()).catch(() => {}));
  return p;
}

/** Already-finished result for this size, if any (lets the UI skip a flash). */
export function peek(src: string, w: number, h: number): HTMLCanvasElement | null {
  return results.get(keyOf(src, w, h)) ?? null;
}

/**
 * The page scaled to exactly w×h device pixels, or null when the browser's own
 * drawing is as good (shown at natural size) or the target is unreasonable.
 */
export function resample(src: string, w: number, h: number): Promise<HTMLCanvasElement | null> {
  if (w < 1 || h < 1 || w * h > MAX_PIXELS) return Promise.resolve(null);
  const key = keyOf(src, w, h);
  const done = results.get(key);
  if (done) {
    touch(results, key, done, MAX_RESULTS);
    return Promise.resolve(done);
  }
  const inflight = pending.get(key);
  if (inflight) return inflight;

  const p = decode(src)
    .then(async (bmp) => {
      if (bmp.width === w && bmp.height === h) return null;
      if (w > bmp.width * MAX_UPSCALE || h > bmp.height * MAX_UPSCALE) return null;
      const out = Object.assign(document.createElement("canvas"), { width: w, height: h });
      await resizer.resize(bmp, out);
      touch(results, key, out, MAX_RESULTS);
      return out;
    })
    .catch(() => null)
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}
