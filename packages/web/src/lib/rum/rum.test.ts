// Unit tests for the pure parts of real user monitoring (SKILLY_SPEC.md §32.10) — no DB, no React.
// The DB-backed aggregates are covered in rum.dbtest.ts; the collector end-to-end in e2e/rum.spec.ts.
// Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isKnownApiRoute, isKnownPageRoute, labelForRoute, RUM_API_ROUTES, RUM_PAGE_ROUTES, RUM_ROUTE_ALL, RUM_ROUTE_OTHER, templateForApiUrl, templateForPath } from "./routes";
import { fingerprintFor, normalizeMessage, parseRumBatch, RUM_MAX_BATCH, RUM_MAX_CLS, RUM_MAX_DURATION_MS, RUM_MAX_MESSAGE, sanitizeFrame, scrubMessage } from "./validate";
import { p75, rumBucketFor, weightedMean } from "./math";
import { bandFor, bandTone, formatMs } from "./bands";

const SID = "abcdefgh12345678";
const FP = "a".repeat(64);
const view = (route = "/catalog") => ({ kind: "page_view", route, sessionId: SID });

// ---- routes ------------------------------------------------------------------------------------------

test("templateForPath: exact, dynamic and unknown page routes", () => {
  assert.equal(templateForPath("/"), "/");
  assert.equal(templateForPath("/catalog"), "/catalog");
  assert.equal(templateForPath("/catalog/marketplaces"), "/catalog/marketplaces");
  assert.equal(templateForPath("/skills/global/my-skill"), "/skills/[ns]/[slug]");
  assert.equal(templateForPath("/requests/42?tab=x#frag"), "/requests/[id]");
  assert.equal(templateForPath("/admin/rum/"), "/admin/rum");
  assert.equal(templateForPath("/admin"), "/admin");
  // Unknown → the single `other` bucket, never the raw path.
  assert.equal(templateForPath("/tokens"), RUM_ROUTE_OTHER);
  assert.equal(templateForPath("/skills/global/my-skill/extra"), RUM_ROUTE_OTHER);
});

test("templateForApiUrl: same-origin /api only, excludes the monitor's own beacons", () => {
  const o = "https://skilly.example";
  assert.equal(templateForApiUrl(`${o}/api/skills/global/foo?x=1`, o), "/api/skills/[ns]/[slug]");
  assert.equal(templateForApiUrl(`${o}/api/skills/global/foo/versions/1.2.3/changes`, o), "/api/skills/[ns]/[slug]/versions/[semver]/changes");
  assert.equal(templateForApiUrl(`${o}/api/me`, o), "/api/me");
  assert.equal(templateForApiUrl(`${o}/api/nope`, o), RUM_ROUTE_OTHER);
  assert.equal(templateForApiUrl(`${o}/api/rum`, o), null);
  assert.equal(templateForApiUrl(`${o}/api/presence/page`, o), null);
  assert.equal(templateForApiUrl(`${o}/api/csp-report`, o), null);
  assert.equal(templateForApiUrl(`${o}/_next/static/x.js`, o), null);
  assert.equal(templateForApiUrl(`https://other.example/api/me`, o), null);
  assert.equal(templateForApiUrl("not a url", o), null);
});

test("known-route predicates and labels", () => {
  for (const r of RUM_PAGE_ROUTES) assert.ok(isKnownPageRoute(r.template), r.template);
  for (const r of RUM_API_ROUTES) assert.ok(isKnownApiRoute(r), r);
  assert.ok(isKnownPageRoute(RUM_ROUTE_OTHER));
  assert.ok(!isKnownPageRoute("/skills/global/foo"));
  assert.ok(!isKnownPageRoute(RUM_ROUTE_ALL)); // 'all' is a read-side pseudo-route, never accepted from a client
  assert.equal(labelForRoute("/skills/[ns]/[slug]"), "Skill");
  assert.equal(labelForRoute(RUM_ROUTE_ALL), "All routes");
  assert.equal(labelForRoute(RUM_ROUTE_OTHER), "Other");
  assert.equal(labelForRoute("/admin/rum"), "Real user monitoring");
});

// ---- validator ----------------------------------------------------------------------------------------

test("parseRumBatch: accepts a well-formed mixed batch and normalises it", () => {
  const r = parseRumBatch({
    samples: [
      view(),
      { kind: "vital", route: "/catalog", name: "lcp", value: 1234.5, sessionId: SID },
      { kind: "vital", route: "/catalog", name: "cls", value: 0.04, sessionId: SID },
      { kind: "nav", route: "/usage", value: 210, sessionId: SID },
      { kind: "api", route: "/catalog", name: "/api/skills", value: 88, ok: true, sessionId: SID },
      { kind: "api", route: "/catalog", name: "/api/skills", value: 88, sessionId: SID },
      { kind: "error", route: "/catalog", name: FP, sessionId: SID, error: { type: "TypeError", message: "x is not a function", frame: "https://h/app.js:1:2" } },
    ],
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.samples.length, 7);
  assert.deepEqual(r.samples[0], { kind: "page_view", route: "/catalog", name: null, value: null, ok: null, sessionId: SID, error: null });
  assert.equal(r.samples[4]!.ok, true);
  assert.equal(r.samples[5]!.ok, null);
  assert.equal(r.samples[6]!.error?.frame, "/app.js:1:2"); // origin stripped server-side too
});

test("parseRumBatch: all-or-nothing — one bad sample rejects the batch", () => {
  const bad = parseRumBatch({ samples: [view(), { kind: "vital", route: "/catalog", name: "lcp", value: -1, sessionId: SID }] });
  assert.ok(!bad.ok);
  if (bad.ok) return;
  assert.match(bad.reason, /sample 1/);
});

test("parseRumBatch: shape and size limits", () => {
  assert.ok(!parseRumBatch(null).ok);
  assert.ok(!parseRumBatch({}).ok);
  assert.ok(!parseRumBatch({ samples: [] }).ok);
  assert.ok(!parseRumBatch({ samples: Array.from({ length: RUM_MAX_BATCH + 1 }, () => view()) }).ok);
  assert.ok(parseRumBatch({ samples: Array.from({ length: RUM_MAX_BATCH }, () => view()) }).ok);
});

test("parseRumBatch: per-kind rules", () => {
  const one = (s: Record<string, unknown>) => parseRumBatch({ samples: [{ sessionId: SID, ...s }] }).ok;
  // kind / route / session
  assert.ok(!one({ kind: "bogus", route: "/catalog" }));
  assert.ok(!one({ kind: "page_view", route: "/skills/global/foo" })); // concrete path, not a template
  assert.ok(one({ kind: "page_view", route: RUM_ROUTE_OTHER }));
  assert.ok(!one({ kind: "page_view", route: RUM_ROUTE_ALL }));
  assert.ok(!parseRumBatch({ samples: [{ kind: "page_view", route: "/", sessionId: "short" }] }).ok);
  assert.ok(!parseRumBatch({ samples: [{ kind: "page_view", route: "/", sessionId: "has space 12345" }] }).ok);
  // page_view carries nothing else
  assert.ok(!one({ kind: "page_view", route: "/", value: 1 }));
  // vitals: enum + bounds (60 s for ms metrics, 10 for CLS)
  assert.ok(!one({ kind: "vital", route: "/", name: "fcp", value: 1 }));
  assert.ok(one({ kind: "vital", route: "/", name: "inp", value: RUM_MAX_DURATION_MS }));
  assert.ok(!one({ kind: "vital", route: "/", name: "inp", value: RUM_MAX_DURATION_MS + 1 }));
  assert.ok(one({ kind: "vital", route: "/", name: "cls", value: RUM_MAX_CLS }));
  assert.ok(!one({ kind: "vital", route: "/", name: "cls", value: RUM_MAX_CLS + 0.01 }));
  assert.ok(!one({ kind: "vital", route: "/", name: "lcp", value: Number.NaN }));
  assert.ok(!one({ kind: "vital", route: "/", name: "lcp", value: "12" }));
  // nav
  assert.ok(!one({ kind: "nav", route: "/", name: "x", value: 1 }));
  assert.ok(!one({ kind: "nav", route: "/", value: RUM_MAX_DURATION_MS + 1 }));
  // api: known template only, ok boolean|null
  assert.ok(!one({ kind: "api", route: "/", name: "/api/skills/global/foo", value: 1 }));
  assert.ok(one({ kind: "api", route: "/", name: RUM_ROUTE_OTHER, value: 1 }));
  assert.ok(!one({ kind: "api", route: "/", name: "/api/me", value: 1, ok: "yes" }));
  // error: 64-hex fingerprint + error object, no value
  assert.ok(!one({ kind: "error", route: "/", name: "abc", error: { type: "E", message: "m", frame: "" } }));
  assert.ok(!one({ kind: "error", route: "/", name: FP }));
  assert.ok(!one({ kind: "error", route: "/", name: FP, value: 1, error: { type: "E", message: "m", frame: "" } }));
  assert.ok(one({ kind: "error", route: "/", name: FP, error: { type: "E", message: "m", frame: "" } }));
});

test("parseRumBatch: server re-scrubs and truncates error text", () => {
  const long = "x".repeat(RUM_MAX_MESSAGE + 50);
  const r = parseRumBatch({ samples: [{ kind: "error", route: "/", name: FP, sessionId: SID, error: { type: "E", message: `mail alice@corp.com ${long}`, frame: "f".repeat(400) } }] });
  assert.ok(r.ok);
  if (!r.ok) return;
  const e = r.samples[0]!.error!;
  assert.ok(!e.message.includes("alice@corp.com"));
  assert.ok(e.message.includes("[redacted]"));
  assert.equal(e.message.length, RUM_MAX_MESSAGE);
  assert.equal(e.frame.length, 300);
});

// ---- scrub / frame / fingerprint ----------------------------------------------------------------------

test("scrubMessage: emails and token-like strings go, ordinary words stay", () => {
  assert.equal(scrubMessage("Failed for bob.smith@example.co.uk today"), "Failed for [redacted] today");
  assert.equal(scrubMessage("hash 0123456789abcdef0123456789abcdef"), "hash [redacted]");
  // A real JWT's segments are ≥ 24 base64url chars with digits → redacted segment by segment.
  assert.equal(scrubMessage("token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ here"), "token [redacted].[redacted] here");
  assert.equal(scrubMessage("key sk-A1B2c3D4e5F6g7H8i9J0k1L2m3N4 end"), "key [redacted] end");
  // Below the 24-char threshold (20 + 19 here) the heuristic deliberately leaves the text alone.
  assert.equal(scrubMessage("short eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0 id"), "short eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0 id");
  // A long word with no digits is not a token.
  assert.equal(scrubMessage("internationalization failed"), "internationalization failed");
  assert.equal(scrubMessage("  a   b  "), "a b");
});

test("sanitizeFrame: strips origin/query and 'at fn (…)' wrappers, caps length", () => {
  assert.equal(sanitizeFrame("https://skilly.example:3000/_next/static/chunks/app.js:12:34"), "/_next/static/chunks/app.js:12:34");
  assert.equal(sanitizeFrame("at onClick (https://h/app.js?v=1:1:2)"), "/app.js:1:2");
  assert.equal(sanitizeFrame("    at https://h/x.js:5:6"), "/x.js:5:6");
  assert.equal(sanitizeFrame("z".repeat(400)).length, 300);
});

test("normalizeMessage collapses the varying parts", () => {
  assert.equal(normalizeMessage("Cannot read 'foo' of undefined at index 12"), 'Cannot read "" of undefined at index #');
  assert.equal(normalizeMessage('Item "abc" (id 7)'), 'Item "" (id #)');
});

test("fingerprintFor: stable across routes and varying digits, distinct across types", async () => {
  const a = await fingerprintFor("TypeError", "x is not a function at 12", "/app.js:1:2");
  const b = await fingerprintFor("TypeError", "x is not a function at 99", "/app.js:1:2");
  const c = await fingerprintFor("RangeError", "x is not a function at 12", "/app.js:1:2");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ---- math / bands -----------------------------------------------------------------------------------

test("p75 matches percentile_cont(0.75) semantics", () => {
  assert.equal(p75([]), null);
  assert.equal(p75([5]), 5);
  assert.equal(p75([1, 2, 3, 4]), 3.25);
  assert.equal(p75([4, 1, 3, 2, 5]), 4);
});

test("weightedMean ignores nulls and zero weights", () => {
  assert.equal(weightedMean([]), null);
  assert.equal(weightedMean([{ value: null, weight: 5 }]), null);
  assert.equal(weightedMean([{ value: 100, weight: 1 }, { value: 300, weight: 3 }]), 250);
  assert.equal(weightedMean([{ value: 100, weight: 1 }, { value: 300, weight: 0 }]), 100);
});

test("rumBucketFor: fixed ranges stay daily; All coarsens with the collected span", () => {
  assert.equal(rumBucketFor(7, null), "day");
  assert.equal(rumBucketFor(90, 1000), "day");
  assert.equal(rumBucketFor("all", 40), "day");
  assert.equal(rumBucketFor("all", 200), "week");
  assert.equal(rumBucketFor("all", 800), "month");
});

test("bandFor at the published thresholds", () => {
  assert.equal(bandFor("lcp", 2500), "good");
  assert.equal(bandFor("lcp", 2501), "needs-improvement");
  assert.equal(bandFor("lcp", 4001), "poor");
  assert.equal(bandFor("inp", 200), "good");
  assert.equal(bandFor("inp", 500), "needs-improvement");
  assert.equal(bandFor("cls", 0.1), "good");
  assert.equal(bandFor("cls", 0.26), "poor");
  assert.equal(bandFor("ttfb", 800), "good");
  assert.equal(bandTone("good"), "ok");
  assert.equal(bandTone("needs-improvement"), "warn");
  assert.equal(bandTone("poor"), "danger");
  assert.equal(formatMs(820), "820 ms");
  assert.equal(formatMs(1240), "1.24 s");
});
