import { test } from "node:test";
import assert from "node:assert/strict";
import { contentDigest } from "./content-digest.js";
import type { BundleEntry } from "./validate.js";

const e = (path: string, bytes: string): BundleEntry => ({ path, bytes: Buffer.from(bytes) });

test("contentDigest is independent of file order", () => {
  const a = contentDigest([e("SKILL.md", "hello"), e("a.txt", "world")]);
  const b = contentDigest([e("a.txt", "world"), e("SKILL.md", "hello")]);
  assert.equal(a, b);
});

test("contentDigest is independent of file PATHS (same content set, different layout)", () => {
  const a = contentDigest([e("SKILL.md", "hello"), e("docs/a.txt", "world")]);
  const b = contentDigest([e("nested/SKILL.md", "hello"), e("a.txt", "world")]);
  assert.equal(a, b);
});

test("contentDigest ignores junk entries (.DS_Store, __MACOSX)", () => {
  const clean = contentDigest([e("SKILL.md", "hello")]);
  const withJunk = contentDigest([e("SKILL.md", "hello"), e(".DS_Store", "xx"), e("__MACOSX/._SKILL.md", "yy")]);
  assert.equal(withJunk, clean);
});

test("contentDigest changes when any file's content changes", () => {
  const a = contentDigest([e("SKILL.md", "hello")]);
  const b = contentDigest([e("SKILL.md", "hello!")]);
  assert.notEqual(a, b);
});

test("contentDigest distinguishes a missing file from a present one", () => {
  const one = contentDigest([e("SKILL.md", "hello")]);
  const two = contentDigest([e("SKILL.md", "hello"), e("extra.txt", "more")]);
  assert.notEqual(one, two);
});

test("contentDigest returns a 64-char hex digest", () => {
  assert.match(contentDigest([e("SKILL.md", "hello")]), /^[0-9a-f]{64}$/);
});
