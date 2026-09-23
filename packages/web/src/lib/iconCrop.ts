// Browser-side icon image work (SKILLY_SPEC.md §33.3): check and decode the picked file, then render
// the framed square to the 256×256 PNG that is uploaded — the server re-normalizes it regardless;
// this is the proposer's choice of square, not a security boundary.
//
// Deliberately NO `blob:` URLs: the enforced CSP (`img-src 'self' data:`, §22) blocks them. The
// source is decoded with `createImageBitmap` (no URL involved), drawn on canvases, and previewed
// as a `data:` URL.
import { ICON_OUTPUT_SIZE } from "@skilly/shared/icon";
import {
  checkIconSourceFile,
  checkIconSourceSize,
  ICON_SOURCE_HEAD_BYTES,
  ICON_UNREADABLE,
  sourceRect,
  type CropSize,
  type CropView,
} from "./iconCropModel";

/** A picked file that passed the §33.3 checks, decoded (EXIF orientation applied). */
export interface DecodedIconSource extends CropSize {
  bitmap: ImageBitmap;
  name: string;
}

/** The staged output: the PNG that is uploaded, and the same bytes as a `data:` URL for previews. */
export interface RenderedIcon {
  blob: Blob;
  dataUrl: string;
}

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    // An engine that predates the "from-image" enum value rejects the option itself (TypeError);
    // its default is then used. An undecodable image rejects with a DOMException instead.
    if (e instanceof TypeError) return createImageBitmap(file);
    throw e;
  }
}

/** Run the §33.3 source checks in order — size, format, decode, dimensions — and decode the file. */
export async function readIconSource(file: File): Promise<{ ok: true; source: DecodedIconSource } | { ok: false; error: string }> {
  const head = new Uint8Array(await file.slice(0, ICON_SOURCE_HEAD_BYTES).arrayBuffer());
  const fileError = checkIconSourceFile(file.size, head);
  if (fileError) return { ok: false, error: fileError };
  let bitmap: ImageBitmap;
  try {
    bitmap = await decode(file);
  } catch {
    return { ok: false, error: ICON_UNREADABLE };
  }
  const size = { width: bitmap.width, height: bitmap.height };
  const sizeError = checkIconSourceSize(size);
  if (sizeError) {
    bitmap.close();
    return { ok: false, error: sizeError };
  }
  return { ok: true, source: { ...size, bitmap, name: file.name } };
}

function canvas2d(px: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can’t draw the icon.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { canvas, ctx };
}

/**
 * Draw the framed square onto a `px`-square canvas. With `highQuality`, a big reduction first steps
 * down by halves (at most 2:1 per pass) so a 4096 px crop doesn't alias the way one 16:1 draw would;
 * without it (the live preview, redrawn on every move) it is a single draw.
 */
export function drawIconCrop(source: DecodedIconSource, view: CropView, px: number, highQuality = true): HTMLCanvasElement {
  const { sx, sy, side } = sourceRect(source, view);
  let from: CanvasImageSource = source.bitmap;
  let x = sx;
  let y = sy;
  let w = side;
  while (highQuality && w > px * 2) {
    const half = Math.ceil(w / 2);
    const step = canvas2d(half);
    step.ctx.drawImage(from, x, y, w, w, 0, 0, half, half);
    from = step.canvas;
    x = 0;
    y = 0;
    w = half;
  }
  const out = canvas2d(px);
  out.ctx.drawImage(from, x, y, w, w, 0, 0, px, px);
  return out.canvas;
}

/** Render the framed square to the 256×256 PNG that is uploaded (transparency kept). */
export async function renderIconPng(source: DecodedIconSource, view: CropView): Promise<RenderedIcon> {
  const canvas = drawIconCrop(source, view, ICON_OUTPUT_SIZE);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn’t render the icon."))), "image/png"),
  );
  return { blob, dataUrl: canvas.toDataURL("image/png") };
}
