import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, FolderRow, toLocalUrl } from "../api";
import { useStore, ReaderMode, FitMode } from "../store";
import ChapterJumpDialog from "../components/ChapterJumpDialog";
import RatingControl from "../components/RatingControl";

const MODE_ORDER: ReaderMode[] = ["single", "double", "scroll"];
const MODE_LABEL: Record<ReaderMode, string> = {
  single: "Single page",
  double: "Two pages",
  scroll: "Vertical scroll",
};
const FIT_ORDER: FitMode[] = ["height", "width", "original"];
const FIT_LABEL: Record<FitMode, string> = {
  height: "Fit height",
  width: "Fit width",
  original: "Original size",
};

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.2;
// Pages wider than tall are double-page scans: they get a spread to themselves.
const WIDE_ASPECT = 1.0;
// Until a page has loaded, assume a typical portrait page.
const DEFAULT_ASPECT = 0.7;

type Size = { w: number; h: number };

export default function Reader() {
  const { id } = useParams();
  const folderId = Number(id);
  const nav = useNavigate();
  const [search] = useSearchParams();
  const startPage = Math.max(0, Number(search.get("p") ?? 0));
  const {
    readerMode,
    setReaderMode,
    readerDir,
    setReaderDir,
    fitMode,
    setFitMode,
    coverAlone,
    setCoverAlone,
  } = useStore();
  const rtl = readerDir === "rtl";

  const [folder, setFolder] = useState<FolderRow | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [idx, setIdx] = useState(startPage);
  const [sizes, setSizes] = useState<Record<number, Size>>({});
  const [zoom, setZoom] = useState(1);
  // Session-only flip of the two-page pairing (Shift+arrow).
  const [shifted, setShifted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [nearTop, setNearTop] = useState(true);
  const [nextFolder, setNextFolder] = useState<FolderRow | null>(null);
  const [prevFolder, setPrevFolder] = useState<FolderRow | null>(null);
  const [jump, setJump] = useState<{ folder: FolderRow; direction: "next" | "prev" } | null>(null);

  useEffect(() => {
    api.get(folderId).then(setFolder);
    api.pages(folderId).then(setPages);
    api.nextSibling(folderId).then(setNextFolder);
    api.prevSibling(folderId).then(setPrevFolder);
    setIdx(startPage);
    setSizes({});
    setZoom(1);
    setShifted(false);
  }, [folderId, startPage]);

  useEffect(() => {
    api.isFullscreen().then(setIsFullscreen);
  }, []);

  const recordSize = useCallback((i: number, w: number, h: number) => {
    if (!w || !h) return;
    setSizes((s) => (s[i] && s[i].w === w && s[i].h === h ? s : { ...s, [i]: { w, h } }));
  }, []);

  // One fixed layout for the whole chapter, so paging back shows exactly the
  // pairs you saw going forward. Wide (double-page) scans get a spread of their
  // own, which realigns the pairs after them. Pages not loaded yet count as
  // portrait; neighbours are preloaded, so the layout is right where you are.
  const spreads = useMemo(() => {
    const n = pages.length;
    const out: number[][] = [];
    if (readerMode !== "double") {
      for (let i = 0; i < n; i++) out.push([i]);
      return out;
    }
    const wide = (i: number) => (sizes[i] ? sizes[i].w / sizes[i].h : DEFAULT_ASPECT) > WIDE_ASPECT;
    let i = 0;
    if (n > 0 && coverAlone !== shifted) {
      out.push([0]);
      i = 1;
    }
    while (i < n) {
      if (wide(i) || i === n - 1 || wide(i + 1)) {
        out.push([i]);
        i += 1;
      } else {
        out.push([i, i + 1]);
        i += 2;
      }
    }
    return out;
  }, [pages.length, readerMode, sizes, coverAlone, shifted]);

  const spreadIndex = Math.max(
    0,
    spreads.findIndex((s) => s.includes(idx))
  );
  const spread = spreads[spreadIndex] ?? [];

  const toggleFullscreen = useCallback(async () => {
    const next = await api.toggleFullscreen();
    setIsFullscreen(next);
    setNearTop(true);
  }, []);

  const goTo = useCallback((i: number) => {
    setIdx(i);
  }, []);

  const next = useCallback(() => {
    if (jump) return; // dialog already open
    if (spreadIndex < spreads.length - 1) {
      goTo(spreads[spreadIndex + 1][0]);
      return;
    }
    if (nextFolder) setJump({ folder: nextFolder, direction: "next" });
  }, [spreadIndex, spreads, nextFolder, jump, goTo]);
  const prev = useCallback(() => {
    if (jump) return;
    if (spreadIndex > 0) {
      goTo(spreads[spreadIndex - 1][0]);
      return;
    }
    if (prevFolder) setJump({ folder: prevFolder, direction: "prev" });
  }, [spreadIndex, spreads, prevFolder, jump, goTo]);
  // Screen-direction helpers: in right-to-left mode the left side moves forward.
  const goLeft = useCallback(() => (rtl ? next() : prev()), [rtl, next, prev]);
  const goRight = useCallback(() => (rtl ? prev() : next()), [rtl, next, prev]);

  // Replace history so Back from the new chapter lands on the gallery, not the
  // chapter that just triggered the dialog.
  const confirmJump = useCallback(() => {
    if (!jump) return;
    const targetId = jump.folder.id;
    setJump(null);
    nav(`/read/${targetId}`, { replace: true });
  }, [jump, nav]);
  const cycleMode = useCallback(() => {
    const i = MODE_ORDER.indexOf(readerMode);
    setReaderMode(MODE_ORDER[(i + 1) % MODE_ORDER.length]);
  }, [readerMode, setReaderMode]);
  const cycleFit = useCallback(() => {
    setFitMode(FIT_ORDER[(FIT_ORDER.indexOf(fitMode) + 1) % FIT_ORDER.length]);
    setZoom(1);
  }, [fitMode, setFitMode]);

  // Viewport ↔ keyboard bridge: the paged view registers how to pan/zoom itself.
  const viewApi = useRef<{ panBy: (dx: number, dy: number) => void; zoomTo: (z: number) => void } | null>(null);
  const zoomBy = useCallback(
    (f: number) => {
      const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * f));
      if (viewApi.current) viewApi.current.zoomTo(z);
      else setZoom(z);
    },
    [zoom]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT") return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "F11") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === "Escape") {
        if (isFullscreen) toggleFullscreen();
        // Always go to *this* chapter's folder view, even when we got here
        // via a next/prev chapter jump.
        else nav(`/folder/${folderId}`);
      } else if (e.key === "v" || e.key === "V") cycleMode();
      else if (e.key === "f" || e.key === "F") cycleFit();
      else if (e.key === "r" || e.key === "R") setReaderDir(rtl ? "ltr" : "rtl");
      else if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
      else if (e.key === "-" || e.key === "_") zoomBy(1 / ZOOM_STEP);
      else if (e.key === "0") {
        setZoom(1);
        viewApi.current?.zoomTo(1);
      } else if (readerMode === "double" && e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        // Pairs off by one (e.g. a missing blank page)? Flip which pages pair up.
        setShifted((s) => !s);
      } else if (readerMode === "single" || readerMode === "double") {
        if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") goRight();
        else if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") goLeft();
        else if (e.key === "ArrowDown") {
          e.preventDefault();
          viewApi.current?.panBy(0, -window.innerHeight * 0.2);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          viewApi.current?.panBy(0, window.innerHeight * 0.2);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readerMode, goLeft, goRight, nav, cycleMode, cycleFit, toggleFullscreen, isFullscreen, folderId, rtl, setReaderDir, zoomBy]);

  // Auto-hide header in fullscreen until mouse goes near the top edge — no delay either way.
  useEffect(() => {
    if (!isFullscreen) {
      setNearTop(true);
      return;
    }
    setNearTop(false);
    const onMove = (e: MouseEvent) => {
      setNearTop(e.clientY < 80);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [isFullscreen]);

  const sources = useMemo(() => pages.map(toLocalUrl), [pages]);

  // Preload neighbours and learn their sizes, so spreads are known before we get there.
  useEffect(() => {
    if (readerMode === "scroll") return;
    const imgs: HTMLImageElement[] = [];
    [idx - 2, idx - 1, idx, idx + 1, idx + 2, idx + 3, idx + 4].forEach((i) => {
      if (i >= 0 && i < sources.length) {
        const img = new Image();
        img.onload = () => recordSize(i, img.naturalWidth, img.naturalHeight);
        img.src = sources[i];
        imgs.push(img);
      }
    });
    return () => imgs.forEach((img) => (img.onload = null));
  }, [idx, sources, readerMode, recordSize]);

  const showCounter = readerMode === "single" || readerMode === "double";
  const headerHidden = isFullscreen && !nearTop;
  const lastShown = spread.length ? spread[spread.length - 1] : idx;

  return (
    <div className="h-screen bg-black text-neutral-100 flex flex-col overflow-hidden">
      <header
        className={
          (isFullscreen
            ? "fixed inset-x-0 top-0 z-20 transition-transform duration-200 "
            : "relative z-10 shrink-0 ") +
          (headerHidden ? "-translate-y-full " : "translate-y-0 ") +
          "bg-neutral-950/90 backdrop-blur border-b border-neutral-900 px-4 py-2 flex gap-3 items-center text-sm"
        }
        onMouseEnter={() => isFullscreen && setNearTop(true)}
      >
        <button onClick={() => nav(`/folder/${folderId}`)} className="text-indigo-400 hover:text-indigo-300 shrink-0">
          ← Back
        </button>
        <div className="truncate text-neutral-300 min-w-0" title={folder?.path}>
          {folder?.name}
        </div>
        {folder && (
          <RatingControl
            size="sm"
            folderId={folder.id}
            rating={folder.rating}
            favorite={folder.favorite === 1}
            onChange={(v) => setFolder({ ...folder, rating: v.rating, favorite: v.favorite ? 1 : 0 })}
          />
        )}
        <div className="flex-1" />
        <div className="flex rounded overflow-hidden ring-1 ring-neutral-800 shrink-0">
          {MODE_ORDER.map((m) => (
            <button
              key={m}
              onClick={() => setReaderMode(m)}
              className={
                "px-2 py-1 text-xs transition " +
                (readerMode === m ? "bg-indigo-600 text-white" : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800")
              }
              title={`${MODE_LABEL[m]} (V cycles)`}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        {readerMode === "double" && (
          <button
            onClick={() => setCoverAlone(!coverAlone)}
            className={`px-2 py-1 rounded text-xs shrink-0 ${
              coverAlone ? "bg-indigo-600 text-white" : "bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
            }`}
            title="Show the first page on its own, so the following pages pair up like the printed book. Shift+← / → flips the pairing if it's still off."
          >
            Cover alone
          </button>
        )}
        <button
          onClick={() => setReaderDir(rtl ? "ltr" : "rtl")}
          className={`px-2 py-1 rounded text-xs shrink-0 ${
            rtl ? "bg-indigo-600 text-white" : "bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
          }`}
          title="Reading direction (R). Right-to-left: pages run right to left, ← goes forward."
        >
          {rtl ? "⇠ Right to left" : "Left to right ⇢"}
        </button>
        <select
          value={fitMode}
          onChange={(e) => {
            setFitMode(e.target.value as FitMode);
            setZoom(1);
            viewApi.current?.zoomTo(1);
          }}
          className="px-1.5 py-1 bg-neutral-900 border border-neutral-800 rounded text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 shrink-0"
          title="Page size (F cycles)"
        >
          {FIT_ORDER.map((f) => (
            <option key={f} value={f}>
              {FIT_LABEL[f]}
            </option>
          ))}
        </select>
        <div className="flex items-center rounded ring-1 ring-neutral-800 text-xs shrink-0">
          <button onClick={() => zoomBy(1 / ZOOM_STEP)} className="px-2 py-1 hover:bg-neutral-800" title="Zoom out (−)">
            −
          </button>
          <button
            onClick={() => {
              setZoom(1);
              viewApi.current?.zoomTo(1);
            }}
            className="px-1.5 py-1 tabular-nums text-neutral-300 hover:bg-neutral-800 min-w-[3.25rem]"
            title="Reset zoom (0). Ctrl+wheel zooms at the cursor, drag to pan."
          >
            {Math.round(zoom * 100)}%
          </button>
          <button onClick={() => zoomBy(ZOOM_STEP)} className="px-2 py-1 hover:bg-neutral-800" title="Zoom in (+)">
            +
          </button>
        </div>
        <button
          onClick={toggleFullscreen}
          className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-xs shrink-0"
          title="Toggle fullscreen (F11)"
        >
          {isFullscreen ? "⛶ Exit" : "⛶ Fullscreen"}
        </button>
        {showCounter && pages.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-neutral-400 tabular-nums shrink-0">
            <select
              value={spread[0] ?? idx}
              onChange={(e) => goTo(Number(e.target.value))}
              className="px-1 py-0.5 bg-neutral-900 border border-neutral-800 rounded text-neutral-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              title="Jump to page"
            >
              {Array.from({ length: pages.length }, (_, i) => (
                <option key={i} value={i}>
                  {i + 1}
                </option>
              ))}
            </select>
            {lastShown > (spread[0] ?? idx) && <span>–{lastShown + 1}</span>}
            <span>/ {pages.length}</span>
          </div>
        )}
      </header>

      {readerMode === "scroll" ? (
        <ScrollMode sources={sources} fit={fitMode} zoom={zoom} setZoom={setZoom} />
      ) : (
        <PagedView
          key={`${folderId}:${idx}:${readerMode}`}
          sources={spread.map((i) => sources[i])}
          indices={spread}
          sizes={sizes}
          onSize={recordSize}
          rtl={rtl}
          fit={fitMode}
          zoom={zoom}
          setZoom={setZoom}
          onLeft={() => goLeft()}
          onRight={() => goRight()}
          apiRef={viewApi}
        />
      )}

      {jump && (
        <ChapterJumpDialog
          target={jump.folder}
          direction={jump.direction}
          onConfirm={confirmJump}
          onCancel={() => setJump(null)}
        />
      )}
    </div>
  );
}

type PagedProps = {
  sources: string[];
  indices: number[];
  sizes: Record<number, Size>;
  onSize: (i: number, w: number, h: number) => void;
  rtl: boolean;
  fit: FitMode;
  zoom: number;
  setZoom: (z: number) => void;
  onLeft: () => void;
  onRight: () => void;
  apiRef: React.MutableRefObject<{ panBy: (dx: number, dy: number) => void; zoomTo: (z: number) => void } | null>;
};

/**
 * One or two pages laid out side by side, sized by the fit mode × zoom, and
 * pannable by dragging when bigger than the window. A click (not a drag) on
 * the left/right half turns the page.
 */
function PagedView({ sources, indices, sizes, onSize, rtl, fit, zoom, setZoom, onLeft, onRight, apiRef }: PagedProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  // null = "initial position" (top edge, reading-start side), recomputed as sizes arrive.
  const [pan, setPan] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ sx: number; sy: number; px: number; py: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setVp({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Display order: in right-to-left mode the first page sits on the right.
  const order = rtl ? [...indices].reverse() : indices;
  const aspects = order.map((i) => (sizes[i] ? sizes[i].w / sizes[i].h : DEFAULT_ASPECT));
  const sumAspect = aspects.reduce((a, b) => a + b, 0) || DEFAULT_ASPECT;
  const naturalH = Math.max(0, ...order.map((i) => sizes[i]?.h ?? 0));

  let baseH: number;
  if (fit === "width") baseH = vp.w / sumAspect;
  else if (fit === "original") baseH = naturalH || vp.h;
  else baseH = vp.h;
  const H = baseH * zoom;
  const W = H * sumAspect;

  const clamp = useCallback(
    (x: number, y: number) => ({
      x: W <= vp.w ? (vp.w - W) / 2 : Math.min(0, Math.max(vp.w - W, x)),
      y: H <= vp.h ? (vp.h - H) / 2 : Math.min(0, Math.max(vp.h - H, y)),
    }),
    [W, H, vp.w, vp.h]
  );
  const pos = pan ? clamp(pan.x, pan.y) : clamp(rtl ? vp.w - W : 0, 0);
  const overflow = W > vp.w + 1 || H > vp.h + 1;

  // Zoom keeping the point under (cx, cy) fixed.
  const zoomAt = useCallback(
    (z: number, cx = vp.w / 2, cy = vp.h / 2) => {
      const nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
      const fx = (cx - pos.x) / W;
      const fy = (cy - pos.y) / H;
      const nH = baseH * nz;
      const nW = nH * sumAspect;
      setPan({ x: cx - fx * nW, y: cy - fy * nH });
      setZoom(nz);
    },
    [vp.w, vp.h, pos.x, pos.y, W, H, baseH, sumAspect, setZoom]
  );

  useEffect(() => {
    apiRef.current = {
      panBy: (dx, dy) => setPan(clamp(pos.x + dx, pos.y + dy)),
      zoomTo: (z) => {
        if (z !== 1) return zoomAt(z);
        setPan(null);
        setZoom(1);
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, clamp, pos.x, pos.y, zoomAt, setZoom]);

  // Ctrl+wheel zooms at the cursor; plain wheel pans when the page overflows.
  useEffect(() => {
    const el = ref.current!;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        zoomAt(zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), e.clientX - r.left, e.clientY - r.top);
      } else if (overflow) {
        e.preventDefault();
        setPan(clamp(pos.x - (e.shiftKey ? e.deltaY : e.deltaX), pos.y - (e.shiftKey ? 0 : e.deltaY)));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, zoomAt, overflow, clamp, pos.x, pos.y]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true;
    if (d.moved && overflow) setPan(clamp(d.px + dx, d.py + dy));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const r = ref.current!.getBoundingClientRect();
    if (e.clientX - r.left > r.width / 2) onRight();
    else onLeft();
  };

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
      className={`flex-1 min-h-0 relative overflow-hidden select-none ${overflow ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
    >
      {vp.w > 0 && (
        <div className="absolute flex" style={{ left: pos.x, top: pos.y, height: H }}>
          {order.map((i, k) => (
            <img
              key={i}
              src={sources[indices.indexOf(i)]}
              alt=""
              draggable={false}
              onLoad={(e) => onSize(i, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
              style={{ height: H, width: H * aspects[k] }}
              className="block max-w-none"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScrollMode({
  sources,
  fit,
  zoom,
  setZoom,
}: {
  sources: string[];
  fit: FitMode;
  zoom: number;
  setZoom: (z: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setVp({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ctrl+wheel zooms the whole column.
  useEffect(() => {
    const el = ref.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, setZoom]);

  const imgStyle: React.CSSProperties =
    fit === "width"
      ? { width: vp.w * zoom, height: "auto" }
      : fit === "height"
        ? { height: vp.h * zoom, width: "auto" }
        : { zoom };

  return (
    <div ref={ref} className="flex-1 min-h-0 overflow-auto">
      <div className="flex flex-col items-center w-max min-w-full">
        {sources.map((s, i) => (
          <img key={i} src={s} loading="lazy" style={imgStyle} className="block max-w-none" alt="" />
        ))}
      </div>
    </div>
  );
}
