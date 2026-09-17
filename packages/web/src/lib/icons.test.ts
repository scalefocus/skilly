import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { validateIconSource, normalizeIcon } from "./icons";

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}

test("validateIconSource: accepts a normal PNG", async () => {
  const bytes = await png(300, 300);
  assert.equal(await validateIconSource(bytes), null);
});

test("validateIconSource: rejects an image below the minimum dimension", async () => {
  const bytes = await png(32, 32);
  const err = await validateIconSource(bytes);
  assert.equal(err?.status, 422);
  assert.match(err!.error, /too small/);
});

test("validateIconSource: rejects an image above the maximum dimension", async () => {
  const bytes = await png(5000, 300);
  const err = await validateIconSource(bytes);
  assert.equal(err?.status, 422);
  assert.match(err!.error, /too large/);
});

test("validateIconSource: rejects a bundle bigger than 512 KB", async () => {
  const bytes = Buffer.concat([await png(600, 600), Buffer.alloc(600 * 1024)]);
  const err = await validateIconSource(bytes);
  assert.equal(err?.status, 413);
});

test("validateIconSource: rejects an unrecognized format (SVG)", async () => {
  const bytes = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
  const err = await validateIconSource(bytes);
  assert.equal(err?.status, 422);
  assert.match(err!.error, /unsupported/);
});

test("normalizeIcon: re-encodes a non-square image to a 256x256 PNG, metadata stripped", async () => {
  const bytes = await png(600, 300);
  const normalized = await normalizeIcon(bytes);
  const meta = await sharp(normalized).metadata();
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 256);
  assert.equal(meta.format, "png");
  assert.equal(meta.exif, undefined);
});
