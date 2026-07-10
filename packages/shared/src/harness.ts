// Tool/harness vocabulary — OPEN, not a closed enum (SKILLY_SPEC.md §3, §8). The list is
// derived: seeded defaults (TOOL_HARNESSES in types.ts) ∪ distinct values on accepted skills.
// A proposer may introduce a new value; it enters the vocabulary when the skill is accepted
// (materialized) — until then it exists only in the proposal. Values are normalized to the
// seeded kebab style so near-duplicates ("Cursor", "claude code") collapse by construction.
// This module is pure (no node imports) — it ships to the client via the "./harness" subpath.

/** Normalize a typed harness name: trim, lowercase, internal whitespace → "-". */
export function normalizeHarness(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Validate an already-normalized harness value. Returns an error string or null.
 * Charset allows seeded names plus dotted/plus-suffixed tool names (e.g. "gpt-4.1").
 */
export function validateHarness(normalized: string): string | null {
  if (!normalized) return "tool/harness is required";
  if (normalized.length > 40) return "tool/harness is too long (max 40 chars)";
  if (!/^[a-z0-9][a-z0-9.+-]*$/.test(normalized)) {
    return "tool/harness must start alphanumeric and contain only lowercase letters, digits, and . + -";
  }
  return null;
}
