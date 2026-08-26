import { test } from "node:test";
import assert from "node:assert/strict";
import { plainText, descTooltip, DESC_TOOLTIP_MAX } from "./cardText";

test("plainText strips markdown to a single readable run", () => {
  assert.equal(plainText("# Title\n\nSome **bold** and *italic* text."), "Title Some bold and italic text.");
  assert.equal(plainText("- one\n- two"), "one two");
  assert.equal(plainText("see `npx skills add` for more"), "see npx skills add for more");
  assert.equal(plainText("a ```js\ncode()\n``` b"), "a b");
  assert.equal(plainText("[the docs](https://example.com/x)"), "the docs");
  assert.equal(plainText("![shot](a.png)"), "shot");
  assert.equal(plainText("> quoted line"), "quoted line");
  assert.equal(plainText("  ragged\n\n   whitespace  "), "ragged whitespace");
});

test("descTooltip passes short descriptions through untouched", () => {
  assert.equal(descTooltip("Converts PDFs."), "Converts PDFs.");
  const exact = "x".repeat(DESC_TOOLTIP_MAX);
  assert.equal(descTooltip(exact), exact, "a description exactly at the cap is not truncated");
});

test("descTooltip caps long descriptions with an ellipsis", () => {
  const long = "y".repeat(DESC_TOOLTIP_MAX + 50);
  const out = descTooltip(long);
  assert.equal(out.length, DESC_TOOLTIP_MAX + 1, "cap plus the single ellipsis character");
  assert.ok(out.endsWith("\u2026"));
  assert.equal(out.slice(0, DESC_TOOLTIP_MAX), "y".repeat(DESC_TOOLTIP_MAX));
});

test("descTooltip strips markdown before measuring the cap", () => {
  // 320 chars of markup that collapses to well under the cap must NOT be truncated.
  const md = "**bold**  ".repeat(32);
  const out = descTooltip(md);
  assert.ok(!out.endsWith("\u2026"), "cap applies to the rendered text, not the raw markdown");
  assert.ok(out.length <= DESC_TOOLTIP_MAX);
});

test("descTooltip does not leave dangling whitespace before the ellipsis", () => {
  const long = `${"word ".repeat(80)}tail`;
  const out = descTooltip(long);
  assert.ok(out.endsWith("\u2026"));
  assert.ok(!/\s\u2026$/.test(out), "trailing space is trimmed before the ellipsis");
});
