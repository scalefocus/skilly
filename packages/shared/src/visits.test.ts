import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NEW_USER_DAYS,
  VISIT_FREQUENCIES,
  VISIT_LABELS,
  classifyVisits,
  isNewUser,
  isVisitFrequency,
  utcDay,
  visitLabel,
  visitWindow,
} from "./visits.js";

const TODAY = "2026-11-28";

/** The `n` UTC days ending `end` (inclusive), newest first. */
function lastDays(n: number, end = TODAY): string[] {
  const base = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(base - i * 86_400_000).toISOString().slice(0, 10));
}

/** `n` days before `end`, as a UTC day. */
function daysAgo(n: number, end = TODAY): string {
  return new Date(Date.parse(`${end}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

// A long-standing user with a full 28-day window: first seen and collection both long ago.
const full = (activeDays: string[]) =>
  classifyVisits({ firstSeen: "2025-01-01T09:00:00Z", visitsSince: "2025-06-01", today: TODAY, activeDays });

test("never: someone with no first visit reads Never, even during the first week", () => {
  assert.equal(classifyVisits({ firstSeen: null, visitsSince: null, today: TODAY, activeDays: [] }), "never");
  // Collection began today, so everyone else is hidden — Never needs no history and still shows.
  assert.equal(classifyVisits({ firstSeen: null, visitsSince: TODAY, today: TODAY, activeDays: [] }), "never");
});

test("full window cut-offs: 15/14, 4/3 and 1/0 active days", () => {
  assert.equal(full(lastDays(28)), "daily");
  assert.equal(full(lastDays(15)), "daily");
  assert.equal(full(lastDays(14)), "weekly");
  assert.equal(full(lastDays(4)), "weekly");
  assert.equal(full(lastDays(3)), "monthly");
  assert.equal(full(lastDays(1)), "monthly");
  assert.equal(full([]), "rare");
});

test("observed 6 is hidden, observed 7 shows", () => {
  const since6 = daysAgo(5); // today − 5 … today = 6 days
  const since7 = daysAgo(6);
  assert.equal(visitWindow({ firstSeen: "2025-01-01T00:00:00Z", visitsSince: since6, today: TODAY })?.observed, 6);
  assert.equal(classifyVisits({ firstSeen: "2025-01-01T00:00:00Z", visitsSince: since6, today: TODAY, activeDays: lastDays(6) }), null);
  assert.equal(classifyVisits({ firstSeen: "2025-01-01T00:00:00Z", visitsSince: since7, today: TODAY, activeDays: lastDays(7) }), "daily");
});

test("pro-rated window of 11 days: 6 daily, 5 and 2 weekly, 1 monthly, 0 rare", () => {
  const since = daysAgo(10); // observed = 11
  const at = (n: number) => classifyVisits({ firstSeen: "2025-01-01T00:00:00Z", visitsSince: since, today: TODAY, activeDays: lastDays(n) });
  assert.equal(at(6), "daily"); // 168 ≥ 165
  assert.equal(at(5), "weekly"); // 140 < 165, ≥ 44
  assert.equal(at(2), "weekly"); // 56 ≥ 44
  assert.equal(at(1), "monthly"); // 28 < 44
  assert.equal(at(0), "rare");
});

test("the spec's examples: a new hire on day 5 is hidden, on day 9 with 8 visits reads daily", () => {
  const day5 = classifyVisits({ firstSeen: `${daysAgo(4)}T08:00:00Z`, visitsSince: "2025-06-01", today: TODAY, activeDays: lastDays(5) });
  assert.equal(day5, null);
  const visited = lastDays(9).filter((d) => d !== daysAgo(3)); // 8 of 9
  const day9 = classifyVisits({ firstSeen: `${daysAgo(8)}T08:00:00Z`, visitsSince: "2025-06-01", today: TODAY, activeDays: visited });
  assert.equal(day9, "daily");
});

test("the window start is clamped by visits_since, by first_seen and by today − 27", () => {
  const old = "2025-01-01T00:00:00Z";
  assert.deepEqual(visitWindow({ firstSeen: old, visitsSince: daysAgo(9), today: TODAY }), { start: daysAgo(9), observed: 10 });
  assert.deepEqual(visitWindow({ firstSeen: `${daysAgo(12)}T23:59:00Z`, visitsSince: "2025-06-01", today: TODAY }), { start: daysAgo(12), observed: 13 });
  assert.deepEqual(visitWindow({ firstSeen: old, visitsSince: "2025-06-01", today: TODAY }), { start: daysAgo(27), observed: 28 });
  assert.deepEqual(visitWindow({ firstSeen: old, visitsSince: null, today: TODAY }), { start: daysAgo(27), observed: 28 });
  assert.equal(visitWindow({ firstSeen: null, visitsSince: null, today: TODAY }), null);
  // A first visit stamped after "today" (clock skew) still observes one day, never zero.
  assert.deepEqual(visitWindow({ firstSeen: "2026-11-29T00:01:00Z", visitsSince: null, today: TODAY }), { start: TODAY, observed: 1 });
});

test("only days inside the window count, and duplicates count once", () => {
  const since = daysAgo(13); // observed = 14
  const outside = lastDays(10, daysAgo(20)); // all before the window start
  const r = classifyVisits({ firstSeen: "2025-01-01T00:00:00Z", visitsSince: since, today: TODAY, activeDays: [...outside, TODAY, TODAY] });
  assert.equal(r, "monthly"); // one active day in 14: 28 < 56
  // A day "in the future" is ignored too.
  assert.equal(classifyVisits({ firstSeen: "2025-01-01T00:00:00Z", visitsSince: since, today: TODAY, activeDays: ["2026-12-01"] }), "rare");
});

test("utcDay: a timestamp near midnight lands on its UTC day; a plain day passes through", () => {
  assert.equal(utcDay("2026-11-28T23:59:59Z"), "2026-11-28");
  assert.equal(utcDay("2026-11-29T00:30:00+02:00"), "2026-11-28");
  assert.equal(utcDay(new Date("2026-11-28T00:00:00Z")), "2026-11-28");
  assert.equal(utcDay("2026-11-28"), "2026-11-28");
});

test("isNewUser: within 30 days of the first visit", () => {
  const now = new Date("2026-11-28T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  assert.equal(NEW_USER_DAYS, 30);
  assert.equal(isNewUser(ago(0), now), true);
  assert.equal(isNewUser(ago(29), now), true);
  assert.equal(isNewUser(ago(31), now), false);
  assert.equal(isNewUser(null, now), false);
});

test("every frequency has a label; visitLabel rejects anything else", () => {
  assert.deepEqual(
    VISIT_FREQUENCIES.map((f) => VISIT_LABELS[f]),
    ["Once a day", "Once a week", "Once a month", "In a blue moon", "Never"],
  );
  for (const f of VISIT_FREQUENCIES) assert.equal(visitLabel(f), VISIT_LABELS[f]);
  assert.equal(visitLabel(null), null);
  assert.equal(visitLabel(undefined), null);
  assert.equal(isVisitFrequency("sometimes"), false);
});
