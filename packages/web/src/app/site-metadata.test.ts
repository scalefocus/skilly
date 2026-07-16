// Unit tests for the root site metadata (SKILLY_SPEC.md §14). Pure — no Next runtime, no DB.
// Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMetadata, parseBaseUrl, SITE_DESCRIPTION, SITE_NAME, SITE_TITLE } from "./site-metadata";

test("parseBaseUrl: parses a valid absolute URL (trim-tolerant)", () => {
  assert.equal(parseBaseUrl("https://skilly.example.com")?.href, "https://skilly.example.com/");
  assert.equal(parseBaseUrl("  https://skilly.example.com/  ")?.href, "https://skilly.example.com/");
});

test("parseBaseUrl: degrades to undefined on unset/blank/invalid — never throws", () => {
  assert.equal(parseBaseUrl(undefined), undefined);
  assert.equal(parseBaseUrl(""), undefined);
  assert.equal(parseBaseUrl("   "), undefined);
  assert.equal(parseBaseUrl("not a url"), undefined);
});

test("buildMetadata: sets metadataBase from PUBLIC_BASE_URL (so og:image is absolute)", () => {
  const m = buildMetadata("https://skilly.example.com");
  assert.ok(m.metadataBase instanceof URL);
  assert.equal((m.metadataBase as URL).href, "https://skilly.example.com/");
});

test("buildMetadata: undefined metadataBase when PUBLIC_BASE_URL is unset (graceful degradation)", () => {
  assert.equal(buildMetadata(undefined).metadataBase, undefined);
  assert.equal(buildMetadata("").metadataBase, undefined);
});

test("buildMetadata: emits Open Graph + a summary_large_image Twitter card", () => {
  const m = buildMetadata("https://skilly.example.com");
  assert.equal(m.title, SITE_TITLE);
  assert.equal(m.description, SITE_DESCRIPTION);
  // Open Graph
  const og = m.openGraph as { title?: unknown; siteName?: unknown; type?: unknown };
  assert.equal(og.title, SITE_TITLE);
  assert.equal(og.siteName, SITE_NAME);
  assert.equal(og.type, "website");
  // Twitter — must be the large-image card per spec
  const tw = m.twitter as { card?: unknown; title?: unknown };
  assert.equal(tw.card, "summary_large_image");
  assert.equal(tw.title, SITE_TITLE);
});
