import { api, toLocalUrl } from "../api";

/**
 * Convert a non-JPEG cover image to JPEG using the renderer's Canvas
 * (Chromium decodes PNG / WebP / AVIF / GIF natively), then hand the
 * encoded JPEG bytes to main to persist on disk.
 *
 * Returns the new absolute path of the .jpg file. The original file is
 * deleted by main once the JPEG is safely written.
 *
 * If `srcPath` is already a JPEG by extension and `force` is false,
 * returns it unchanged. Pass `force = true` when the file is named .jpg
 * but its content isn't actually JPEG (e.g. a renamed PNG/WebP) — the
 * canvas will decode it from whatever its true format is and write back
 * a real JPEG to the same path.
 */
export async function convertCoverToJpeg(srcPath: string, force = false): Promise<string> {
  // A page inside a .cbz/.zip — never rewritten.
  if (srcPath.includes("|")) return srcPath;
  if (!force) {
    const lower = srcPath.toLowerCase();
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return srcPath;
  }

  // Load via local:// so Chromium decodes whatever it understands.
  const url = toLocalUrl(srcPath);
  const img = await loadImage(url);

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create 2D canvas context");

  // JPEG has no alpha — paint white behind transparent pixels.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);

  const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
  const buf = await blob.arrayBuffer();
  return api.saveJpegBuffer(srcPath, buf);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to decode image: ${url}`));
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas.toBlob returned null"))),
      type,
      quality
    );
  });
}
