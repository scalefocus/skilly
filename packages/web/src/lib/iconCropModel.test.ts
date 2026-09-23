// Tests for the icon crop model — the crop dialog's geometry and the browser-side source checks
// (SKILLY_SPEC.md §33.3–§33.4, §33.7). Pure functions — no DOM. Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkIconSourceFile,
  checkIconSourceSize,
  clampView,
  frameSide,
  initialView,
  keyPan,
  KEY_PAN_STEP,
  KEY_PAN_STEP_BIG,
  maxZoom,
  panBy,
  sliderToZoom,
  sourceRect,
  zoomAt,
  zoomToSlider,
  type CropSize,
  type CropView,
} from "./iconCropModel";

const MB = 1024 * 1024;
const WIDE: CropSize = { width: 300, height: 150 };
const FRAME_PX = 288;

// Deterministic pseudo-random numbers (an LCG), so the property checks are reproducible.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The frame (at the view's zoom) lies fully inside the image. */
function assertInside(s: CropSize, v: CropView): void {
  const half = frameSide(s, v.zoom) / 2;
  const eps = 1e-9;
  assert.ok(v.cx - half >= -eps && v.cx + half <= s.width + eps, `x out of bounds: ${JSON.stringify(v)} in ${s.width}×${s.height}`);
  assert.ok(v.cy - half >= -eps && v.cy + half <= s.height + eps, `y out of bounds: ${JSON.stringify(v)} in ${s.width}×${s.height}`);
}

test("maxZoom: the framed square stops at the 64 px floor; a 64 px-short source is fixed at 1×", () => {
  assert.equal(maxZoom(WIDE), 150 / 64);
  assert.equal(maxZoom({ width: 4096, height: 4096 }), 64);
  assert.equal(maxZoom({ width: 64, height: 200 }), 1);
  assert.equal(frameSide(WIDE, maxZoom(WIDE)), 64);
});

test("initialView: centred at 1× — the frame spans the shorter side (and is what Reset returns to)", () => {
  assert.deepEqual(initialView(WIDE), { cx: 150, cy: 75, zoom: 1 });
  assert.equal(frameSide(WIDE, 1), 150);
  assertInside(WIDE, initialView(WIDE));
});

test("clampView: zoom stays in [1, max] and the frame never leaves the image, whatever the input", () => {
  assert.equal(clampView(WIDE, { cx: 150, cy: 75, zoom: 0.25 }).zoom, 1, "no zooming out past the image edge");
  assert.equal(clampView(WIDE, { cx: 150, cy: 75, zoom: 99 }).zoom, maxZoom(WIDE));
  assert.equal(clampView(WIDE, { cx: 150, cy: 75, zoom: Number.NaN }).zoom, 1);
  const next = rng(7);
  for (let i = 0; i < 2000; i++) {
    const s = { width: 64 + Math.floor(next() * 4033), height: 64 + Math.floor(next() * 4033) };
    const v = { cx: (next() * 3 - 1) * s.width, cy: (next() * 3 - 1) * s.height, zoom: next() * 80 - 5 };
    assertInside(s, clampView(s, v));
  }
});

test("panBy: the image follows the pointer, so the framed centre moves the other way — and clamps", () => {
  const v: CropView = { cx: 150, cy: 75, zoom: 1 };
  const scale = FRAME_PX / frameSide(WIDE, 1);
  const moved = panBy(WIDE, v, 30, 0, FRAME_PX); // drag the image 30 screen px to the right
  assert.ok(Math.abs(moved.cx - (150 - 30 / scale)) < 1e-9);
  assert.equal(moved.cy, 75, "the shorter axis has no room at 1×");
  const farLeft = panBy(WIDE, v, 10_000, 0, FRAME_PX);
  assert.equal(farLeft.cx, 75, "clamped at the image's left edge");
  const farRight = panBy(WIDE, v, -10_000, 0, FRAME_PX);
  assert.equal(farRight.cx, 225, "clamped at the image's right edge");
});

test("zoomAt: the source point under the anchor stays put (away from the edges)", () => {
  const s: CropSize = { width: 1000, height: 800 };
  const v: CropView = { cx: 500, cy: 400, zoom: 2 };
  const anchor = { x: 40, y: -30 };
  const before = FRAME_PX / frameSide(s, v.zoom);
  const point = { x: v.cx + anchor.x / before, y: v.cy + anchor.y / before };
  const next = zoomAt(s, v, 3, anchor.x, anchor.y, FRAME_PX);
  assert.equal(next.zoom, 3);
  const after = FRAME_PX / frameSide(s, next.zoom);
  assert.ok(Math.abs((point.x - next.cx) * after - anchor.x) < 1e-9);
  assert.ok(Math.abs((point.y - next.cy) * after - anchor.y) < 1e-9);
  // (0, 0) zooms about the frame centre: the centre doesn't move.
  const centred = zoomAt(s, v, 4, 0, 0, FRAME_PX);
  assert.deepEqual({ cx: centred.cx, cy: centred.cy }, { cx: 500, cy: 400 });
});

test("zoomAt: clamps the factor to [1, max] and keeps the frame inside", () => {
  const v: CropView = { cx: 225, cy: 75, zoom: 1 };
  const deep = zoomAt(WIDE, v, 50, 100, 100, FRAME_PX);
  assert.equal(deep.zoom, maxZoom(WIDE));
  assertInside(WIDE, deep);
  const out = zoomAt(WIDE, { cx: 150, cy: 75, zoom: 2 }, 0.1, -100, 60, FRAME_PX);
  assert.equal(out.zoom, 1);
  assertInside(WIDE, out);
});

test("keyPan: arrows move around the image by a share of the frame (Shift = big step), clamped", () => {
  const v: CropView = { cx: 150, cy: 75, zoom: 2 }; // frame side 75
  assert.ok(Math.abs(keyPan(WIDE, v, "right", false).cx - (150 + 75 * KEY_PAN_STEP)) < 1e-9);
  assert.ok(Math.abs(keyPan(WIDE, v, "left", true).cx - (150 - 75 * KEY_PAN_STEP_BIG)) < 1e-9);
  assert.ok(keyPan(WIDE, v, "up", false).cy < 75);
  assert.ok(keyPan(WIDE, v, "down", false).cy > 75);
  let edge = v;
  for (let i = 0; i < 100; i++) edge = keyPan(WIDE, edge, "right", true);
  assert.equal(edge.cx, 300 - 75 / 2, "stops at the right edge");
});

test("slider mapping: logarithmic, 0 → 1× and 1 → max, and it round-trips", () => {
  const max = maxZoom({ width: 4096, height: 3000 });
  assert.equal(sliderToZoom(0, max), 1);
  assert.ok(Math.abs(sliderToZoom(1, max) - max) < 1e-9);
  assert.ok(Math.abs(sliderToZoom(0.5, max) - Math.sqrt(max)) < 1e-9, "the midpoint is the geometric mean");
  for (const t of [0, 0.1, 0.25, 0.5, 0.8, 1]) assert.ok(Math.abs(zoomToSlider(sliderToZoom(t, max), max) - t) < 1e-9);
  // A source that can't zoom (shorter side = 64) keeps the slider at 0 and the zoom at 1×.
  assert.equal(zoomToSlider(1, 1), 0);
  assert.equal(sliderToZoom(0.7, 1), 1);
});

test("sourceRect: whole pixels, inside the image, never under 64 px — for any view", () => {
  const next = rng(42);
  for (let i = 0; i < 2000; i++) {
    const s = { width: 64 + Math.floor(next() * 4033), height: 64 + Math.floor(next() * 4033) };
    const v = { cx: next() * s.width, cy: next() * s.height, zoom: 1 + next() * (maxZoom(s) + 2) };
    const r = sourceRect(s, v);
    assert.ok(Number.isInteger(r.sx) && Number.isInteger(r.sy) && Number.isInteger(r.side), JSON.stringify(r));
    assert.ok(r.side >= 64, `side ${r.side} under the floor`);
    assert.ok(r.sx >= 0 && r.sy >= 0 && r.sx + r.side <= s.width && r.sy + r.side <= s.height, `${JSON.stringify(r)} leaves ${s.width}×${s.height}`);
  }
  assert.deepEqual(sourceRect({ width: 512, height: 512 }, initialView({ width: 512, height: 512 })), { sx: 0, sy: 0, side: 512 }, "a square source is its full frame");
  assert.deepEqual(sourceRect(WIDE, initialView(WIDE)), { sx: 75, sy: 0, side: 150 }, "centred at 1×");
  assert.deepEqual(sourceRect(WIDE, { cx: 1e9, cy: 75, zoom: maxZoom(WIDE) }), { sx: 236, sy: 43, side: 64 }, "deepest zoom, far right");
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const ascii = (s: string) => Uint8Array.from([...s.padEnd(16, " ")].map((c) => c.charCodeAt(0)));

test("checkIconSourceFile: size first (10 MB cap), then PNG / JPEG / WebP by magic bytes", () => {
  assert.equal(checkIconSourceFile(11 * MB, PNG), "This image is 11.0 MB — icons accept up to 10 MB.");
  assert.equal(checkIconSourceFile(Math.round(14.2 * MB), PNG), "This image is 14.2 MB — icons accept up to 10 MB.");
  assert.equal(checkIconSourceFile(10 * MB, PNG), null, "exactly 10 MB is accepted");
  assert.equal(checkIconSourceFile(1024, JPEG), null);
  assert.equal(checkIconSourceFile(1024, WEBP), null);
  for (const head of [ascii("<svg xmlns"), ascii("GIF89a"), ascii("hello world"), new Uint8Array(0)]) {
    assert.equal(checkIconSourceFile(1024, head), "Icons must be PNG, JPEG or WebP.");
  }
  assert.match(checkIconSourceFile(11 * MB, ascii("<svg")) ?? "", /11\.0 MB/, "the size check runs before the format check");
});

test("checkIconSourceSize: shorter side ≥ 64 px and longer side ≤ 4096 px", () => {
  assert.equal(checkIconSourceSize({ width: 40, height: 40 }), "This image is 40 × 40 px — icons need at least 64 × 64 px.");
  assert.equal(checkIconSourceSize({ width: 63, height: 500 }), "This image is 63 × 500 px — icons need at least 64 × 64 px.");
  assert.equal(checkIconSourceSize({ width: 8000, height: 6000 }), "This image is 8000 × 6000 px — icons accept at most 4096 px on the longer side.");
  assert.equal(checkIconSourceSize({ width: 64, height: 4096 }), null);
  assert.equal(checkIconSourceSize(WIDE), null);
});
