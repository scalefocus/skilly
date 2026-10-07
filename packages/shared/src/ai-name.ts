// The end-user display name of the AI (SKILLY_SPEC.md §40.14): a platform setting that replaces
// the word "AI" on every end-user surface (an organization may brand its assistant, e.g. "Aria").
// Admin surfaces keep "AI". Client-safe (pure): exported via "@skilly/shared/ai-name".

/** Shown when the setting is absent or empty. */
export const AI_DISPLAY_NAME_DEFAULT = "AI";
export const AI_DISPLAY_NAME_MAX = 24;

/**
 * Validate an admin-entered display name. Returns the trimmed value ("" = restore the default),
 * or an error. Printable text only — no control characters or line breaks.
 */
export function validateAiDisplayName(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: "" };
  if (typeof raw !== "string") return { ok: false, error: "the display name must be text" };
  const v = raw.trim();
  if ([...v].length > AI_DISPLAY_NAME_MAX) return { ok: false, error: `the display name must be at most ${AI_DISPLAY_NAME_MAX} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)) return { ok: false, error: "the display name must not contain control characters or line breaks" };
  return { ok: true, value: v };
}

/** A stored value as served: a valid non-empty name, else the default. */
export function coerceAiDisplayName(stored: unknown): string {
  const r = validateAiDisplayName(stored);
  return r.ok && r.value ? r.value : AI_DISPLAY_NAME_DEFAULT;
}
