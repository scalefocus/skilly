import { test } from "node:test";
import assert from "node:assert/strict";
import { detectImageFormat, isSingleEmoji, resolveBundleIcon, ICON_MAX_SOURCE_BYTES } from "./icon.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP_MAGIC = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
const SVG_BYTES = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
const GIF_BYTES = Buffer.from("GIF89a");

test("detectImageFormat: recognizes PNG/JPEG/WebP by magic bytes", () => {
  assert.equal(detectImageFormat(PNG_MAGIC), "png");
  assert.equal(detectImageFormat(JPEG_MAGIC), "jpeg");
  assert.equal(detectImageFormat(WEBP_MAGIC), "webp");
});

test("detectImageFormat: refuses SVG and GIF (script-capable / animated)", () => {
  assert.equal(detectImageFormat(SVG_BYTES), null);
  assert.equal(detectImageFormat(GIF_BYTES), null);
});

test("isSingleEmoji: accepts a single emoji, rejects text and multi-emoji runs", () => {
  assert.equal(isSingleEmoji("🚀"), true);
  assert.equal(isSingleEmoji("hello"), false);
  assert.equal(isSingleEmoji(""), false);
  assert.equal(isSingleEmoji("assets/logo.png"), false);
});

test("resolveBundleIcon: frontmatter emoji beats a root icon.png", () => {
  const files = [{ path: "icon.png", bytes: PNG_MAGIC }];
  const r = resolveBundleIcon(files, "🚀");
  assert.equal(r?.emoji, "🚀");
  assert.equal(r?.source, "frontmatter");
});

test("resolveBundleIcon: frontmatter path beats root icon.png", () => {
  const files = [
    { path: "icon.png", bytes: PNG_MAGIC },
    { path: "assets/logo.png", bytes: PNG_MAGIC },
  ];
  const r = resolveBundleIcon(files, "assets/logo.png");
  assert.equal(r?.entry?.path, "assets/logo.png");
  assert.equal(r?.source, "frontmatter");
});

test("resolveBundleIcon: falls back to root icon.png when frontmatter icon is absent", () => {
  const files = [{ path: "icon.jpg", bytes: JPEG_MAGIC }];
  const r = resolveBundleIcon(files, undefined);
  assert.equal(r?.entry?.path, "icon.jpg");
  assert.equal(r?.source, "bundle");
});

test("resolveBundleIcon: an unresolvable frontmatter path warns and falls through to root icon.png", () => {
  const files = [{ path: "icon.png", bytes: PNG_MAGIC }];
  const r = resolveBundleIcon(files, "assets/missing.png");
  assert.equal(r?.entry?.path, "icon.png");
  assert.equal(r?.source, "bundle");
  assert.ok(r?.warnings.some((w) => w.includes("was not found")));
});

test("resolveBundleIcon: a URL-shaped icon value is refused, never fetched", () => {
  const r = resolveBundleIcon([], "https://evil.example/x.png");
  assert.equal(r?.entry, undefined);
  assert.equal(r?.emoji, undefined);
  assert.ok(r?.warnings.some((w) => w.includes("URL")));
});

test("resolveBundleIcon: an oversize bundle icon is skipped", () => {
  const big = Buffer.concat([PNG_MAGIC, Buffer.alloc(ICON_MAX_SOURCE_BYTES)]);
  const files = [{ path: "icon.png", bytes: big }];
  const r = resolveBundleIcon(files, undefined);
  assert.equal(r?.entry, undefined);
  assert.ok(r?.warnings.some((w) => w.includes("512 KB")));
});

test("resolveBundleIcon: no icon anywhere resolves to null", () => {
  assert.equal(resolveBundleIcon([{ path: "SKILL.md", bytes: Buffer.from("x") }], undefined), null);
});
