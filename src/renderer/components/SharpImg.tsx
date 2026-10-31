import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { peek, resample } from "../lib/resample";

type Props = React.ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  /** Wait until the image is near the viewport (scroll mode). */
  lazy?: boolean;
};

/**
 * An <img> that swaps itself for a high-quality resampled canvas (pica) of
 * exactly its on-screen pixel size. The plain image shows first and during
 * zoom/resize; the sharp version replaces it ~0.1 s after things settle.
 * Layout is untouched: size it with style/className like any <img>.
 */
export default function SharpImg({ src, lazy, style, className, onLoad, ...rest }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [visible, setVisible] = useState(!lazy);
  // Which size has been settled, and whether that produced a canvas
  // (null result = the plain <img> is already as good, e.g. shown at natural size).
  const [shown, setShown] = useState<{ key: string; canvas: boolean } | null>(null);

  // Track the rendered size in device pixels.
  useLayoutEffect(() => {
    const img = imgRef.current!;
    const measure = () => {
      const r = img.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(r.width * dpr);
      const h = Math.round(r.height * dpr);
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(img);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!lazy) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "1200px 0px" });
    io.observe(imgRef.current!);
    return () => io.disconnect();
  }, [lazy]);

  const key = size ? `${size.w}x${size.h}@${src}` : null;

  // Cached already → draw before paint, no flash of the soft version.
  useLayoutEffect(() => {
    if (!size || !key) return;
    const hit = peek(src, size.w, size.h);
    if (hit && canvasRef.current) {
      draw(canvasRef.current, hit);
      setShown({ key, canvas: true });
    }
  }, [src, size, key]);

  useEffect(() => {
    if (!size || !key || !visible || shown?.key === key) return;
    let cancelled = false;
    // Debounce: zooming or resizing changes the size many times a second.
    const t = setTimeout(async () => {
      const c = await resample(src, size.w, size.h);
      if (cancelled || !canvasRef.current) return;
      if (c) draw(canvasRef.current, c);
      setShown({ key, canvas: !!c });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [src, size, key, visible, shown]);

  const sharp = shown?.key === key && shown.canvas;
  return (
    <span className="relative block shrink-0" style={{ width: style?.width, height: style?.height }}>
      <img
        ref={imgRef}
        src={src}
        style={{ ...style, visibility: sharp ? "hidden" : undefined }}
        className={className}
        onLoad={onLoad}
        {...rest}
      />
      <canvas
        ref={canvasRef}
        aria-hidden
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ visibility: sharp ? "visible" : "hidden" }}
      />
    </span>
  );
}

function draw(target: HTMLCanvasElement, from: HTMLCanvasElement) {
  if (target.width !== from.width) target.width = from.width;
  if (target.height !== from.height) target.height = from.height;
  target.getContext("2d")!.drawImage(from, 0, 0);
}
