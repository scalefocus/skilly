// Unit tests for the RUM flush ladder + the rum_flush_intervals parser (SKILLY_SPEC.md §32.4, §32.6, §32.10).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RUM_FLUSH_INTERVALS,
  RUM_FLUSH_MAX_ENTRIES,
  clampIndex,
  delayMs,
  isValidFlushSet,
  nextIndex,
  parseRumFlushIntervals,
  snappedDelayMs,
} from "./ladder";

const SET = [5, 7, 11];

test("ladder: the default set is ascending primes with a 17 s floor", () => {
  assert.equal(DEFAULT_RUM_FLUSH_INTERVALS[0], 17);
  const isPrime = (n: number) => n > 1 && Array.from({ length: n - 2 }, (_, i) => i + 2).every((d) => n % d !== 0);
  for (const n of DEFAULT_RUM_FLUSH_INTERVALS) assert.ok(isPrime(n), `${n} is not prime`);
  for (let i = 1; i < DEFAULT_RUM_FLUSH_INTERVALS.length; i++) assert.ok(DEFAULT_RUM_FLUSH_INTERVALS[i]! > DEFAULT_RUM_FLUSH_INTERVALS[i - 1]!);
  assert.ok(isValidFlushSet([...DEFAULT_RUM_FLUSH_INTERVALS]));
});

test("ladder: starts at the floor, a tick without an action climbs one step and holds at the top", () => {
  let i = 0;
  assert.equal(delayMs(SET, i), 5000);
  i = nextIndex(i, SET.length, false);
  assert.equal(i, 1);
  assert.equal(delayMs(SET, i), 7000);
  i = nextIndex(i, SET.length, false);
  assert.equal(i, 2);
  i = nextIndex(i, SET.length, false);
  assert.equal(i, 2, "clamps at the last value");
  assert.equal(delayMs(SET, i), 11000);
});

test("ladder: a user action since the last tick snaps the next step back to the floor", () => {
  assert.equal(nextIndex(2, SET.length, true), 0);
  assert.equal(nextIndex(0, SET.length, true), 0);
});

test("ladder: a snap shortens a pending delay longer than the floor to the floor, never below", () => {
  assert.equal(snappedDelayMs(9000, SET), 5000, "9 s pending → 5 s");
  assert.equal(snappedDelayMs(3000, SET), 3000, "3 s pending stays 3 s (already under the floor)");
  assert.equal(snappedDelayMs(5000, SET), 5000);
  assert.equal(snappedDelayMs(-50, SET), 0, "an overdue timer fires now");
});

test("ladder: a new set keeps the step index, clamped to its length", () => {
  assert.equal(clampIndex(6, 3), 2);
  assert.equal(clampIndex(1, 3), 1);
  assert.equal(clampIndex(-1, 3), 0);
  assert.equal(clampIndex(4, 0), 0);
  assert.equal(delayMs([13], 5), 13000, "a one-entry set always uses that entry");
});

test("ladder: isValidFlushSet accepts ascending positive integers only", () => {
  assert.ok(isValidFlushSet([5, 7]));
  assert.ok(!isValidFlushSet([]));
  assert.ok(!isValidFlushSet([7, 5]));
  assert.ok(!isValidFlushSet([5, 5]));
  assert.ok(!isValidFlushSet([0, 5]));
  assert.ok(!isValidFlushSet([5, 7.5]));
  assert.ok(!isValidFlushSet("5, 7"));
  assert.ok(!isValidFlushSet(null));
});

test("parser: normalises strings and arrays — trims, dedupes, sorts, tolerates blank tokens", () => {
  assert.deepEqual(parseRumFlushIntervals("23, 17,,17, 37 ,"), [17, 23, 37]);
  assert.deepEqual(parseRumFlushIntervals([59, 17, 23]), [17, 23, 59]);
  assert.deepEqual(parseRumFlushIntervals("17"), [17]);
});

test("parser: rejects out-of-bounds, non-numeric, empty and oversized input with clear messages", () => {
  assert.throws(() => parseRumFlushIntervals("4, 9"), /between 5 and 3600/);
  assert.throws(() => parseRumFlushIntervals("17, 3601"), /between 5 and 3600/);
  assert.throws(() => parseRumFlushIntervals("17, abc"), /"abc" is not a whole number/);
  assert.throws(() => parseRumFlushIntervals("17.5"), /not a whole number/);
  assert.throws(() => parseRumFlushIntervals("-17"), /not a whole number/);
  assert.throws(() => parseRumFlushIntervals(""), /at least one interval/);
  assert.throws(() => parseRumFlushIntervals(" , , "), /at least one interval/);
  const tooMany = Array.from({ length: RUM_FLUSH_MAX_ENTRIES + 1 }, (_, i) => 5 + i);
  assert.throws(() => parseRumFlushIntervals(tooMany), new RegExp(`at most ${RUM_FLUSH_MAX_ENTRIES} intervals`));
  assert.deepEqual(parseRumFlushIntervals(tooMany.slice(0, RUM_FLUSH_MAX_ENTRIES)).length, RUM_FLUSH_MAX_ENTRIES);
});
