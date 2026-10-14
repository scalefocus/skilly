// Unit tests for the survey routes' shared plumbing (SKILLY_SPEC.md §36.17): the bug report's own
// rate limits — 3 / min and 20 / day per user, independent of the survey cooldowns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bugReportRateLimited } from "./surveyRoute";
import { BUG_REPORT_RATE_PER_DAY, BUG_REPORT_RATE_PER_MIN } from "@skilly/shared/survey";

test("bug reports: 3 per minute per user, then 429 with Retry-After; other users unaffected", () => {
  const user = `bug-rl-${Date.now()}-a`;
  for (let i = 0; i < BUG_REPORT_RATE_PER_MIN; i++) assert.equal(bugReportRateLimited(user), null);
  const r = bugReportRateLimited(user);
  assert.ok(r);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) >= 1);
  assert.equal(bugReportRateLimited(`bug-rl-${Date.now()}-b`), null);
});

test("bug reports: 20 per day per user, even when spread over minutes", (t) => {
  // Advance the clock a minute between bursts so only the day window is in play.
  let now = Date.parse("2026-10-14T08:00:00Z");
  t.mock.method(Date, "now", () => now);
  const user = `bug-rl-day-${Math.random()}`;
  let accepted = 0;
  for (let burst = 0; burst < 10; burst++) {
    for (let i = 0; i < BUG_REPORT_RATE_PER_MIN; i++) if (bugReportRateLimited(user) === null) accepted++;
    now += 61_000;
  }
  assert.equal(accepted, BUG_REPORT_RATE_PER_DAY);
  // The next day it opens again.
  now += 24 * 60 * 60 * 1000;
  assert.equal(bugReportRateLimited(user), null);
});
