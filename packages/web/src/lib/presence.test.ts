// Unit tests for the pure parts of presence.ts (SKILLY_SPEC.md §4) — no DB. The throttled
// touchLastSeen/listOnlineUsers DB behavior is covered in presence.dbtest.ts.
// Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizePageLabel, MAX_PAGE_LABEL_LEN, dauBucketFor } from "./presence";

test("sanitizePageLabel: trims whitespace", () => {
  assert.equal(sanitizePageLabel("  Catalog  "), "Catalog");
});

test("sanitizePageLabel: non-string input resolves to null", () => {
  assert.equal(sanitizePageLabel(undefined), null);
  assert.equal(sanitizePageLabel(null), null);
  assert.equal(sanitizePageLabel(42), null);
  assert.equal(sanitizePageLabel({ label: "Catalog" }), null);
});

test("sanitizePageLabel: empty or whitespace-only resolves to null", () => {
  assert.equal(sanitizePageLabel(""), null);
  assert.equal(sanitizePageLabel("   "), null);
});

test("sanitizePageLabel: caps to MAX_PAGE_LABEL_LEN", () => {
  const huge = "x".repeat(500);
  const out = sanitizePageLabel(huge);
  assert.equal(out?.length, MAX_PAGE_LABEL_LEN);
  assert.equal(out, "x".repeat(MAX_PAGE_LABEL_LEN));
});

test("sanitizePageLabel: passes a normal resolved label through unchanged", () => {
  const label = "Skill: SEO Checklist";
  assert.equal(sanitizePageLabel(label), label);
});

// dauBucketFor — span-adaptive bucketing for the active-users trend chart (§4).

test("dauBucketFor: an empty daily_active_users table buckets by day", () => {
  for (const r of [7, 30, 90, "all"] as const) assert.equal(dauBucketFor(r, null), "day");
});

test("dauBucketFor: the fixed ranges always bucket by day (90 <= 92)", () => {
  // Whatever the history, a 7/30/90-day window can never exceed the daily threshold — this is the
  // rule that made the old 90d weekly-average mapping unnecessary.
  for (const span of [1, 30, 92, 93, 400, 5000]) {
    assert.equal(dauBucketFor(7, span), "day", `7d @ span ${span}`);
    assert.equal(dauBucketFor(30, span), "day", `30d @ span ${span}`);
    assert.equal(dauBucketFor(90, span), "day", `90d @ span ${span}`);
  }
});

test("dauBucketFor: all-time steps day → week → month at the §21 thresholds", () => {
  assert.equal(dauBucketFor("all", 92), "day");
  assert.equal(dauBucketFor("all", 93), "week");
  assert.equal(dauBucketFor("all", 730), "week");
  assert.equal(dauBucketFor("all", 731), "month");
});

test("dauBucketFor: the regression — a history inside one calendar month is NOT monthly", () => {
  // The reported bug: ~30 days of collected history, all within one calendar month, rendered
  // all-time as a single monthly bucket — one dot, no line. It must bucket by day now.
  for (const span of [1, 2, 30, 31]) assert.equal(dauBucketFor("all", span), "day", `span ${span}`);
});

test("dauBucketFor: all-time never coarsens past the collected history", () => {
  // A one-day-old deployment asking for all-time gets a daily bucket, not a monthly one.
  assert.equal(dauBucketFor("all", 1), "day");
  // And the span is what's collected — not the calendar span the buckets would imply.
  assert.equal(dauBucketFor("all", 60), "day");
});
