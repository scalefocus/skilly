// When the search-gap sweep is due (SKILLY_SPEC.md §62.4): never while collection is off; a pending
// Run now; otherwise the admin-set interval since the last run started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchGapRunDue, type SearchGapState } from "./searchGaps.js";

const NOW = new Date("2026-10-27T12:00:00Z");
const state = (over: Partial<SearchGapState> = {}): SearchGapState => ({
  enabled: true,
  sweepHours: 6,
  minSearchers: 2,
  lookbackDays: 30,
  lastRun: null,
  runRequestedAt: null,
  ...over,
});
const run = (startedAt: string) => ({ startedAt, finishedAt: startedAt, ok: true, gaps: 0, newGaps: 0, drafted: 0, error: null });

test("searchGapRunDue: never while collection is off, even with Run now pending", () => {
  assert.equal(searchGapRunDue(state({ enabled: false }), NOW), false);
  assert.equal(searchGapRunDue(state({ enabled: false, runRequestedAt: NOW.toISOString() }), NOW), false);
});

test("searchGapRunDue: the first run happens at once", () => {
  assert.equal(searchGapRunDue(state(), NOW), true);
});

test("searchGapRunDue: waits for the interval since the last run started", () => {
  assert.equal(searchGapRunDue(state({ lastRun: run("2026-10-27T07:00:00Z") }), NOW), false);
  assert.equal(searchGapRunDue(state({ lastRun: run("2026-10-27T06:00:00Z") }), NOW), true);
  assert.equal(searchGapRunDue(state({ sweepHours: 1, lastRun: run("2026-10-27T11:00:00Z") }), NOW), true);
});

test("searchGapRunDue: a Run now pressed after the last run starts one; an older one does not", () => {
  const last = run("2026-10-27T11:00:00Z");
  assert.equal(searchGapRunDue(state({ lastRun: last, runRequestedAt: "2026-10-27T11:30:00Z" }), NOW), true);
  assert.equal(searchGapRunDue(state({ lastRun: last, runRequestedAt: "2026-10-27T10:30:00Z" }), NOW), false);
});
