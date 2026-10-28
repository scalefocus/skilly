// Unit tests for the web tier's external base URL and absolute-link resolution (SKILLY_SPEC.md
// §14, §33.6). Pure — no Next runtime, no DB. Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toAbsoluteUrl, webBaseUrl } from "./baseUrl";

test("webBaseUrl: PUBLIC_BASE_URL wins over the other two", () => {
  assert.equal(
    webBaseUrl({ PUBLIC_BASE_URL: "https://a.example", SKILLY_REGISTRY_URL: "https://b.example", NEXTAUTH_URL: "https://c.example" }),
    "https://a.example",
  );
});

test("webBaseUrl: falls back to SKILLY_REGISTRY_URL, then NEXTAUTH_URL (the stock web container)", () => {
  assert.equal(webBaseUrl({ SKILLY_REGISTRY_URL: "https://b.example", NEXTAUTH_URL: "https://c.example" }), "https://b.example");
  assert.equal(webBaseUrl({ NEXTAUTH_URL: "https://c.example" }), "https://c.example");
});

test("webBaseUrl: a blank value counts as unset (compose passes an empty ${PUBLIC_BASE_URL} through)", () => {
  assert.equal(webBaseUrl({ PUBLIC_BASE_URL: "", SKILLY_REGISTRY_URL: "  ", NEXTAUTH_URL: "https://c.example" }), "https://c.example");
});

test("webBaseUrl: trims whitespace and trailing slashes", () => {
  assert.equal(webBaseUrl({ PUBLIC_BASE_URL: "  https://a.example//  " }), "https://a.example");
  assert.equal(webBaseUrl({ PUBLIC_BASE_URL: "https://a.example/skilly/" }), "https://a.example/skilly");
});

test("webBaseUrl: nothing configured → empty string", () => {
  assert.equal(webBaseUrl({}), "");
});

test("toAbsoluteUrl: a bare share path picks up the page's origin, query intact", () => {
  assert.equal(
    toAbsoluteUrl("/skills/global/pdf-tools?s=abc_-123", "http://localhost:3000/skills/global/pdf-tools"),
    "http://localhost:3000/skills/global/pdf-tools?s=abc_-123",
  );
});

test("toAbsoluteUrl: an absolute URL passes through unchanged, whatever the page's origin", () => {
  assert.equal(
    toAbsoluteUrl("https://skilly.example.com/skills/global/pdf-tools?s=abc", "http://localhost:3000/profile"),
    "https://skilly.example.com/skills/global/pdf-tools?s=abc",
  );
});

test("toAbsoluteUrl: unparseable input comes back as-is", () => {
  assert.equal(toAbsoluteUrl("/skills/x", "not a url"), "/skills/x");
});
