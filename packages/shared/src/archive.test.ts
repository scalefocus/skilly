import { test } from "node:test";
import assert from "node:assert/strict";
import { detectArchive, stripCommonPrefix, isJunkEntry } from "./archive.js";
import type { BundleEntry } from "./validate.js";

const f = (path: string): BundleEntry => ({ path, bytes: new Uint8Array() });

test("detects gzip and zip by magic bytes", () => {
  assert.equal(detectArchive(new Uint8Array([0x1f, 0x8b, 0x08, 0x00])), "gzip");
  assert.equal(detectArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), "zip");
  assert.equal(detectArchive(new Uint8Array([0x50, 0x4b, 0x05, 0x06])), "zip"); // empty zip
  assert.equal(detectArchive(new Uint8Array([0x00, 0x01])), null);
});

test("strips a single common wrapper directory", () => {
  const out = stripCommonPrefix([f("pdf-tools/SKILL.md"), f("pdf-tools/scripts/run.sh")]);
  assert.deepEqual(out.map((x) => x.path).sort(), ["SKILL.md", "scripts/run.sh"]);
});

test("does not strip when files sit at root", () => {
  const files = [f("SKILL.md"), f("scripts/run.sh")];
  assert.deepEqual(stripCommonPrefix(files).map((x) => x.path), ["SKILL.md", "scripts/run.sh"]);
});

test("does not strip a single root file named like a dir", () => {
  assert.deepEqual(stripCommonPrefix([f("SKILL.md")]).map((x) => x.path), ["SKILL.md"]);
});

test("flags junk entries", () => {
  assert.ok(isJunkEntry("__MACOSX/foo"));
  assert.ok(isJunkEntry(".DS_Store"));
  assert.ok(isJunkEntry("a/../b"));
  assert.ok(!isJunkEntry("SKILL.md"));
});
