// The RUM flush ladder (SKILLY_SPEC.md §32.4) as a pure state machine, plus the parser for the
// `rum_flush_intervals` setting (§32.6). Shared by the browser collector (RumCollector.tsx), the
// server-side settings module and the unit tests — no DOM, no DB, no React.
//
// The ladder is an index into an ascending set of seconds. It starts at the floor (`set[0]`), a
// tick with no user action since the previous tick advances one step and clamps at the last value,
// and a user action snaps it back to index 0 — shortening a pending delay that is longer than the
// floor down to the floor, never below it (the floor is the minimum spacing between beacons).
import { parseIntervalSet } from "../intervalSet";

/** Default flush ladder: primes (like the chat poll set, §24) so beacons rarely coincide with other
 *  periodic requests; 17 s is the floor an active tab beacons at, 251 s the idle ceiling. */
export const DEFAULT_RUM_FLUSH_INTERVALS: readonly number[] = [17, 23, 37, 59, 97, 157, 251];
/** Lower bound (s): the ingest rate limit is 60 batches/min (§32.5), so nothing faster is useful. */
export const RUM_FLUSH_MIN_SECONDS = 5;
export const RUM_FLUSH_MAX_SECONDS = 3600;
export const RUM_FLUSH_MAX_ENTRIES = 20;
/** The collector re-reads its flags from /api/me on a tick once this long has passed (§32.4). */
export const RUM_FLAGS_REREAD_MS = 60_000;

/** Normalise an admin's input into the stored set. Throws with a user-facing message on bad input. */
export function parseRumFlushIntervals(input: string | number[]): number[] {
  return parseIntervalSet(input, { min: RUM_FLUSH_MIN_SECONDS, max: RUM_FLUSH_MAX_SECONDS, maxEntries: RUM_FLUSH_MAX_ENTRIES });
}

/** Client-side sanity check on a set received from /api/me: a non-empty ascending list of positive
 *  integers. The server already normalised it; this only guards against a malformed payload. */
export function isValidFlushSet(v: unknown): v is number[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  let prev = 0;
  for (const n of v) {
    if (typeof n !== "number" || !Number.isInteger(n) || n <= prev) return false;
    prev = n;
  }
  return true;
}

/** Keep an index valid after the set changed length (a new set keeps the step, clamped). */
export function clampIndex(index: number, setLength: number): number {
  if (setLength <= 0) return 0;
  return Math.max(0, Math.min(index, setLength - 1));
}

/** The index the ladder moves to after a tick: back to the floor if the user acted since the last
 *  tick, otherwise one step up, holding at the last value. */
export function nextIndex(index: number, setLength: number, actedSinceLastTick: boolean): number {
  if (actedSinceLastTick) return 0;
  return clampIndex(index + 1, setLength);
}

/** Milliseconds until the next tick for a given step. */
export function delayMs(set: readonly number[], index: number): number {
  const s = set[clampIndex(index, set.length)] ?? DEFAULT_RUM_FLUSH_INTERVALS[0]!;
  return s * 1000;
}

/** On a user action, the pending delay shrinks to the floor when it is longer than the floor — and is
 *  otherwise left alone, so a snap never brings two beacons closer together than `set[0]`. */
export function snappedDelayMs(remainingMs: number, set: readonly number[]): number {
  const floor = delayMs(set, 0);
  return Math.min(Math.max(0, remainingMs), floor);
}
