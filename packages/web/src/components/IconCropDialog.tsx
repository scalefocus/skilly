"use client";
// The skill icon crop dialog and the pick flow behind the icon field (SKILLY_SPEC.md §33.3–§33.4).
//
// `useIconCropFlow` owns the whole path, so the propose form and the proposal page behave the same:
// source checks → a square source is staged at its full frame, a non-square one opens the dialog →
// Apply renders the 256×256 PNG → the caller's `onCommit` (the propose form stages it for submit; the
// proposal page uploads it at once). Cancel on a fresh pick drops it — the field is exactly as before.
import { useEffect, useId, useRef, useState } from "react";
import { Modal } from "./ui";
import { SkillIcon } from "./SkillIcon";
import { drawIconCrop, readIconSource, renderIconPng, type DecodedIconSource, type RenderedIcon } from "../lib/iconCrop";
import {
  clampView,
  frameSide,
  initialView,
  keyPan,
  KEY_ZOOM_FACTOR,
  maxZoom,
  panBy,
  sliderToZoom,
  zoomAt,
  zoomToSlider,
  type CropView,
  type PanDirection,
} from "../lib/iconCropModel";

/** The frame's share of the viewport — must match `.crop-frame { inset: 10% }` in globals.css. */
const FRAME_RATIO = 0.8;
const SLIDER_STEPS = 1000;
/** The live preview is drawn for the 48 px tile at 2× density. */
const PREVIEW_PX = 96;
const ARROWS: Record<string, PanDirection> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/** An image picked in this session and applied: its source (kept for Adjust crop), view and render. */
export interface StagedIcon {
  source: DecodedIconSource;
  view: CropView;
  render: RenderedIcon;
}

function IconCropDialog({
  source,
  initial,
  busy,
  onApply,
  onCancel,
}: {
  source: DecodedIconSource;
  initial: CropView;
  busy: boolean;
  onApply: (view: CropView) => void;
  onCancel: () => void;
}) {
  const [view, setView] = useState<CropView>(() => clampView(source, initial));
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [viewportPx, setViewportPx] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const framePx = useRef(0);
  framePx.current = viewportPx * FRAME_RATIO;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; mx: number; my: number } | null>(null);
  const hintId = useId();
  const sliderId = useId();
  const zmax = maxZoom(source);
  const t = zoomToSlider(view.zoom, zmax);

  // The viewport shrinks to fit a phone — track its rendered size.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewportPx(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Draw the image under the fixed frame, then the live preview — once per animation frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewportPx <= 0) return;
    const raf = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      const px = Math.round(viewportPx * dpr);
      if (canvas.width !== px) {
        canvas.width = px;
        canvas.height = px;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewportPx, viewportPx);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const scale = (viewportPx * FRAME_RATIO) / frameSide(source, view.zoom);
      ctx.drawImage(source.bitmap, viewportPx / 2 - view.cx * scale, viewportPx / 2 - view.cy * scale, source.width * scale, source.height * scale);
      setPreviewUrl(drawIconCrop(source, view, PREVIEW_PX, false).toDataURL("image/png"));
    });
    return () => cancelAnimationFrame(raf);
  }, [source, view, viewportPx]);

  // The wheel zooms about the pointer. A native, non-passive listener: React's onWheel is passive, and
  // the page (and the dialog body) must not scroll — nor a trackpad pinch zoom the page — over the viewport.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const f = framePx.current;
      if (f <= 0) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const factor = Math.exp(-e.deltaY * unit * 0.0015);
      const r = el.getBoundingClientRect();
      const px = e.clientX - (r.left + r.width / 2);
      const py = e.clientY - (r.top + r.height / 2);
      setView((v) => zoomAt(source, v, v.zoom * factor, px, py, f));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [source]);

  function pinchNow(): { dist: number; mx: number; my: number } | null {
    const [a, b] = Array.from(pointers.current.values());
    if (!a || !b) return null;
    return { dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) pinch.current = pinchNow();
    setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const prev = pointers.current.get(e.pointerId);
    const f = framePx.current;
    if (!prev || f <= 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      setView((v) => panBy(source, v, dx, dy, f));
    } else if (pointers.current.size === 2 && pinch.current) {
      // Two fingers: the image follows their midpoint and scales with their spread about it.
      const was = pinch.current;
      const now = pinchNow();
      pinch.current = now;
      if (!now) return;
      const r = e.currentTarget.getBoundingClientRect();
      const px = now.mx - (r.left + r.width / 2);
      const py = now.my - (r.top + r.height / 2);
      setView((v) => zoomAt(source, panBy(source, v, now.mx - was.mx, now.my - was.my, f), v.zoom * (now.dist / was.dist), px, py, f));
    }
  }

  function onPointerEnd(e: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    pinch.current = pointers.current.size === 2 ? pinchNow() : null;
    if (pointers.current.size === 0) setDragging(false);
  }

  function onViewportKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const dir = ARROWS[e.key];
    if (dir) {
      e.preventDefault();
      setView((v) => keyPan(source, v, dir, e.shiftKey));
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      setView((v) => zoomAt(source, v, v.zoom * KEY_ZOOM_FACTOR, 0, 0, 1));
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      setView((v) => zoomAt(source, v, v.zoom / KEY_ZOOM_FACTOR, 0, 0, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!busy) onApply(view);
    }
  }

  return (
    <Modal
      title="Crop icon"
      onCancel={onCancel}
      initialFocusRef={viewportRef}
      footer={
        <>
          <button type="button" className="btn btn-ghost modal-foot-start" disabled={busy} onClick={() => setView(initialView(source))}>
            Reset
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onApply(view)}>
            {busy ? "Applying…" : "Apply"}
          </button>
        </>
      }
    >
      <p className="muted crop-hint">Drag to move · scroll or pinch to zoom</p>
      <div
        ref={viewportRef}
        className={`crop-viewport${dragging ? " dragging" : ""}`}
        role="application"
        aria-label="Crop area"
        aria-describedby={hintId}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
        onKeyDown={onViewportKeyDown}
      >
        <canvas ref={canvasRef} className="crop-canvas" aria-hidden />
        <div className="crop-frame" aria-hidden />
      </div>
      <p id={hintId} className="sr-only">
        Arrow keys move around the image, Shift moves further. Plus and minus zoom. Enter applies.
      </p>
      <div className="crop-controls">
        <div className="crop-zoom">
          <label htmlFor={sliderId} className="field-label">
            Zoom
          </label>
          <div className="crop-zoom-row">
            <input
              id={sliderId}
              type="range"
              className="range"
              min={0}
              max={SLIDER_STEPS}
              step={1}
              value={Math.round(t * SLIDER_STEPS)}
              disabled={zmax <= 1}
              aria-valuetext={`${view.zoom.toFixed(1)}×`}
              style={{ "--range-fill": `${t * 100}%` } as React.CSSProperties}
              onChange={(e) => {
                const z = sliderToZoom(Number(e.target.value) / SLIDER_STEPS, zmax);
                setView((v) => zoomAt(source, v, z, 0, 0, 1));
              }}
            />
            <span className="muted crop-zoom-value" aria-hidden>
              {view.zoom.toFixed(1)}×
            </span>
          </div>
        </div>
        <div className="crop-preview">
          <SkillIcon icon={previewUrl ? { url: previewUrl, emoji: null } : null} title="Icon preview" size={48} fallback="default" />
          <span className="field-label">Preview</span>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The icon field's image flow. `onCommit` receives each applied 256×256 render: the propose form
 * stages it (and clears the emoji); the proposal page uploads it and throws on failure, which shows
 * as `error` and leaves the previous icon in place. Render `dialog` somewhere in the field.
 */
export function useIconCropFlow(onCommit: (render: RenderedIcon) => void | Promise<void>) {
  const [staged, setStaged] = useState<StagedIcon | null>(null);
  const [open, setOpen] = useState<{ key: number; source: DecodedIconSource; view: CropView; fresh: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const openRef = useRef(open);
  openRef.current = open;
  const seq = useRef(0);

  // Release the decoded sources when the field goes away.
  useEffect(
    () => () => {
      stagedRef.current?.source.bitmap.close();
      if (openRef.current?.fresh) openRef.current.source.bitmap.close();
    },
    [],
  );

  async function commit(source: DecodedIconSource, view: CropView, fresh: boolean): Promise<void> {
    setBusy(true);
    try {
      const render = await renderIconPng(source, view);
      await commitRef.current(render);
      const prev = stagedRef.current;
      if (prev && prev.source !== source) prev.source.bitmap.close();
      setStaged({ source, view, render });
      setError(null);
    } catch (e) {
      if (fresh) source.bitmap.close();
      setError(e instanceof Error && e.message ? e.message : "Couldn’t use this image.");
    } finally {
      setBusy(false);
    }
  }

  /** A file from the picker: checked, then staged (square) or framed in the dialog (non-square). */
  async function pick(file: File | null | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    setBusy(true);
    const read = await readIconSource(file).finally(() => setBusy(false));
    if (!read.ok) {
      setError(read.error);
      return;
    }
    const { source } = read;
    if (source.width === source.height) await commit(source, initialView(source), true);
    else setOpen({ key: ++seq.current, source, view: initialView(source), fresh: true });
  }

  /** Re-open the dialog on the staged image, at its last applied position and zoom. */
  function adjust(): void {
    const s = stagedRef.current;
    if (s) setOpen({ key: ++seq.current, source: s.source, view: s.view, fresh: false });
  }

  /** Drop the staged image (Remove image, an emoji instead, new-version Remove). */
  function clear(): void {
    stagedRef.current?.source.bitmap.close();
    setStaged(null);
    setError(null);
  }

  const dialog = open ? (
    <IconCropDialog
      key={open.key}
      source={open.source}
      initial={open.view}
      busy={busy}
      onApply={async (view) => {
        await commit(open.source, view, open.fresh);
        setOpen(null);
      }}
      onCancel={() => {
        // A fresh pick is dropped (the field stays as it was); a re-open keeps the applied crop.
        if (open.fresh) open.source.bitmap.close();
        setOpen(null);
      }}
    />
  ) : null;

  return { staged, error, setError, busy, pick, adjust, clear, dialog };
}
