// Icon crop model — the pure maths behind the crop dialog and the browser-side source checks
// (SKILLY_SPEC.md §33.3–§33.4). No DOM here, so it is unit-tested under `node --test`; the canvas
// work lives in iconCrop.ts and the interaction in components/IconCropDialog.tsx.
import {
  ICON_MAX_DIMENSION,
  ICON_MAX_UPLOAD_SOURCE_BYTES,
  ICON_MIN_DIMENSION,
  detectImageFormat,
} from "@skilly/shared/icon";

/** A decoded source's pixel size (EXIF orientation already applied). */
export interface CropSize {
  width: number;
  height: number;
}

/**
 * The framed square in SOURCE pixels: its centre (cx, cy) and the zoom factor. At zoom 1 the square
 * spans the source's shorter side; at zoom z its side is shorter ÷ z. The frame is fixed on screen —
 * panning and zooming move the image under it.
 */
export interface CropView {
  cx: number;
  cy: number;
  zoom: number;
}

/** The framed square as whole source pixels — what gets drawn into the 256×256 output. */
export interface SourceRect {
  sx: number;
  sy: number;
  side: number;
}

export type PanDirection = "left" | "right" | "up" | "down";

/** An arrow press moves by this share of the frame side; Shift makes it a big step. */
export const KEY_PAN_STEP = 0.02;
export const KEY_PAN_STEP_BIG = 0.1;
/** Each + / − press zooms by this factor. */
export const KEY_ZOOM_FACTOR = 1.1;
/** Bytes read from the file for the magic-byte format check (WebP needs 12). */
export const ICON_SOURCE_HEAD_BYTES = 16;
export const ICON_UNREADABLE = "This image couldn’t be read.";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const shorterSide = (s: CropSize): number => Math.min(s.width, s.height);

/** The deepest zoom: the framed square never drops below the server's 64 px minimum (§33.3). */
export function maxZoom(s: CropSize): number {
  return Math.max(1, shorterSide(s) / ICON_MIN_DIMENSION);
}

/** Side of the framed square in source px at `zoom`. */
export function frameSide(s: CropSize, zoom: number): number {
  return shorterSide(s) / zoom;
}

/** Centred at 1× — where the dialog opens and where Reset returns. A square source's full frame. */
export function initialView(s: CropSize): CropView {
  return { cx: s.width / 2, cy: s.height / 2, zoom: 1 };
}

/** Keep the zoom in range and the frame fully inside the image (no zooming out past its edge). */
export function clampView(s: CropSize, v: CropView): CropView {
  const zoom = clamp(Number.isFinite(v.zoom) ? v.zoom : 1, 1, maxZoom(s));
  const half = frameSide(s, zoom) / 2;
  return { zoom, cx: clamp(v.cx, half, s.width - half), cy: clamp(v.cy, half, s.height - half) };
}

/**
 * Drag the image by (dx, dy) SCREEN px while the frame is `framePx` wide on screen. The image follows
 * the pointer, so the framed centre moves the opposite way.
 */
export function panBy(s: CropSize, v: CropView, dx: number, dy: number, framePx: number): CropView {
  const scale = framePx / frameSide(s, v.zoom); // screen px per source px
  return clampView(s, { ...v, cx: v.cx - dx / scale, cy: v.cy - dy / scale });
}

/**
 * Zoom to `zoom` while the source point under the anchor stays put. The anchor (px, py) is in screen
 * px from the FRAME CENTRE: the pointer for the wheel, the pinch midpoint for a pinch, and (0, 0) —
 * the frame centre — for the slider and the keys.
 */
export function zoomAt(s: CropSize, v: CropView, zoom: number, px: number, py: number, framePx: number): CropView {
  const next = clamp(zoom, 1, maxZoom(s));
  const before = framePx / frameSide(s, v.zoom);
  const after = framePx / frameSide(s, next);
  return clampView(s, { zoom: next, cx: v.cx + px / before - px / after, cy: v.cy + py / before - py / after });
}

/** An arrow key moves around the image in its direction (like panning a map), a share of the frame per press. */
export function keyPan(s: CropSize, v: CropView, dir: PanDirection, big: boolean): CropView {
  const step = frameSide(s, v.zoom) * (big ? KEY_PAN_STEP_BIG : KEY_PAN_STEP);
  const dx = dir === "left" ? -step : dir === "right" ? step : 0;
  const dy = dir === "up" ? -step : dir === "down" ? step : 0;
  return clampView(s, { ...v, cx: v.cx + dx, cy: v.cy + dy });
}

/** Slider position 0…1 → zoom. Logarithmic, so a 4096 px photo's deep range stays usable. */
export function sliderToZoom(t: number, max: number): number {
  return max <= 1 ? 1 : Math.pow(max, clamp(t, 0, 1));
}

/** Zoom → slider position 0…1 (the inverse of sliderToZoom). */
export function zoomToSlider(zoom: number, max: number): number {
  return max <= 1 ? 0 : clamp(Math.log(zoom) / Math.log(max), 0, 1);
}

/** The framed square as whole source pixels: always inside the image and never under 64 px. */
export function sourceRect(s: CropSize, v: CropView): SourceRect {
  const cv = clampView(s, v);
  const shorter = shorterSide(s);
  const side = clamp(Math.round(frameSide(s, cv.zoom)), Math.min(ICON_MIN_DIMENSION, shorter), shorter);
  return {
    side,
    sx: clamp(Math.round(cv.cx - side / 2), 0, s.width - side),
    sy: clamp(Math.round(cv.cy - side / 2), 0, s.height - side),
  };
}

const MB = 1024 * 1024;

/**
 * §33.3 source checks 1–2, run on the picked file before it is decoded: size first, then the format
 * by magic bytes (the check the server runs). `head` is the file's first ICON_SOURCE_HEAD_BYTES.
 */
export function checkIconSourceFile(size: number, head: Uint8Array): string | null {
  if (size > ICON_MAX_UPLOAD_SOURCE_BYTES) {
    return `This image is ${(size / MB).toFixed(1)} MB — icons accept up to ${ICON_MAX_UPLOAD_SOURCE_BYTES / MB} MB.`;
  }
  if (!detectImageFormat(head)) return "Icons must be PNG, JPEG or WebP.";
  return null;
}

/** §33.3 source check 4, on the decoded size: the server's dimension rules, applied to the source. */
export function checkIconSourceSize(s: CropSize): string | null {
  const dims = `${s.width} × ${s.height} px`;
  if (shorterSide(s) < ICON_MIN_DIMENSION) {
    return `This image is ${dims} — icons need at least ${ICON_MIN_DIMENSION} × ${ICON_MIN_DIMENSION} px.`;
  }
  if (Math.max(s.width, s.height) > ICON_MAX_DIMENSION) {
    return `This image is ${dims} — icons accept at most ${ICON_MAX_DIMENSION} px on the longer side.`;
  }
  return null;
}
