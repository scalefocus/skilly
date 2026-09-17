// Shared parser for the admin-configurable "interval set" settings (SKILLY_SPEC.md §24 chat poll
// cadence, §32.6 RUM flush ladder): a comma-separated string or an array of numbers → an ascending,
// deduped list of integer seconds within the caller's bounds. Pure and isomorphic (no DB, no DOM),
// so both settings parsers and the unit tests share ONE definition of what a valid set is.
//
// Throws on any invalid token / empty input / out-of-bounds value so an admin save surfaces a clear
// error; callers that read a STORED value wrap it and fall back to their default instead.
export interface IntervalSetBounds {
  /** Smallest accepted value, in seconds. */
  min: number;
  /** Largest accepted value, in seconds. */
  max: number;
  /** Most entries after dedupe. */
  maxEntries: number;
}

export function parseIntervalSet(input: string | number[], bounds: IntervalSetBounds): number[] {
  const tokens = Array.isArray(input) ? input.map((n) => String(n)) : input.split(",");
  const out: number[] = [];
  for (const raw of tokens) {
    const t = String(raw).trim();
    if (t === "") continue; // tolerate trailing/empty commas
    if (!/^\d+$/.test(t)) throw new Error(`"${t}" is not a whole number of seconds`);
    const n = Number(t);
    if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) {
      throw new Error(`each interval must be a whole number of seconds between ${bounds.min} and ${bounds.max}`);
    }
    out.push(n);
  }
  const cleaned = [...new Set(out)].sort((a, b) => a - b);
  if (cleaned.length === 0) throw new Error("provide at least one interval");
  if (cleaned.length > bounds.maxEntries) throw new Error(`at most ${bounds.maxEntries} intervals`);
  return cleaned;
}
