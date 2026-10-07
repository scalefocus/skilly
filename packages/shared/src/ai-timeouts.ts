// Admin-tunable AI timeouts (SKILLY_SPEC.md §40.15): a per-call timeout for every registered AI
// feature and the §44 draft run cap. Stored as overrides only in the `ai_timeouts` platform
// setting; unset ⇒ the code default. Client-safe (pure): exported via "@skilly/shared/ai-timeouts".

/** The default per-attempt timeout of a feature that declares none (§40.7). */
export const AI_CALL_TIMEOUT_DEFAULT_MS = 60_000;
/** The admin range for a per-call timeout — also the ceiling a registry entry may declare. */
export const AI_CALL_TIMEOUT_MIN_MS = 10_000;
export const AI_CALL_TIMEOUT_MAX_MS = 900_000;
/** The §44.5 whole-run cap: default and admin range. */
export const AI_DRAFT_RUN_CAP_DEFAULT_MS = 30 * 60_000;
export const AI_DRAFT_RUN_CAP_MIN_MS = 5 * 60_000;
export const AI_DRAFT_RUN_CAP_MAX_MS = 120 * 60_000;
/** The §44 feature whose call timeout the run cap may not undercut. */
export const AI_DRAFT_FEATURE_KEY = "skill_quality_draft";
/** The platform_settings key. */
export const AI_TIMEOUTS_SETTING = "ai_timeouts";

/** The stored overrides (only what an admin set). */
export interface AiTimeoutOverrides {
  calls: Record<string, number>;
  draftRunCapMs?: number;
}

/** The registry fields this module needs (an `AiFeature` satisfies it). */
export interface AiTimeoutFeature {
  key: string;
  label: string;
  timeoutMs?: number;
}

export interface AiTimeoutsView {
  features: { key: string; label: string; defaultMs: number; overrideMs: number | null; effectiveMs: number }[];
  draftRunCap: { defaultMs: number; overrideMs: number | null; effectiveMs: number };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A feature's code default: its declared `timeoutMs` (capped at 900 s), else 60 s. */
export function aiFeatureDefaultTimeoutMs(f: Pick<AiTimeoutFeature, "timeoutMs">): number {
  return Number.isInteger(f.timeoutMs) && f.timeoutMs! > 0 ? Math.min(f.timeoutMs!, AI_CALL_TIMEOUT_MAX_MS) : AI_CALL_TIMEOUT_DEFAULT_MS;
}

/**
 * The stored setting as served: keys that are not registered features are ignored and values outside
 * their range are clamped into it (a hand-edited row can never produce a 0 s or a day-long wait).
 */
export function parseAiTimeoutOverrides(stored: unknown, featureKeys: readonly string[]): AiTimeoutOverrides {
  const out: AiTimeoutOverrides = { calls: {} };
  if (!isObj(stored)) return out;
  if (isObj(stored.calls)) {
    for (const key of featureKeys) {
      const v = stored.calls[key];
      if (typeof v === "number" && Number.isFinite(v)) out.calls[key] = clamp(Math.round(v), AI_CALL_TIMEOUT_MIN_MS, AI_CALL_TIMEOUT_MAX_MS);
    }
  }
  const cap = stored.draftRunCapMs;
  if (typeof cap === "number" && Number.isFinite(cap)) out.draftRunCapMs = clamp(Math.round(cap), AI_DRAFT_RUN_CAP_MIN_MS, AI_DRAFT_RUN_CAP_MAX_MS);
  return out;
}

/** The per-attempt timeout a call uses: the admin override, else the feature's code default. */
export function effectiveAiCallTimeoutMs(f: AiTimeoutFeature, o: AiTimeoutOverrides): number {
  return o.calls[f.key] ?? aiFeatureDefaultTimeoutMs(f);
}

/** The §44.5 run cap a draft run uses. */
export function effectiveAiDraftRunCapMs(o: AiTimeoutOverrides): number {
  return o.draftRunCapMs ?? AI_DRAFT_RUN_CAP_DEFAULT_MS;
}

/** Default / override / effective for every feature and the run cap — what the admin card shows. */
export function aiTimeoutsView(features: readonly AiTimeoutFeature[], o: AiTimeoutOverrides): AiTimeoutsView {
  return {
    features: features.map((f) => ({
      key: f.key,
      label: f.label,
      defaultMs: aiFeatureDefaultTimeoutMs(f),
      overrideMs: o.calls[f.key] ?? null,
      effectiveMs: effectiveAiCallTimeoutMs(f, o),
    })),
    draftRunCap: { defaultMs: AI_DRAFT_RUN_CAP_DEFAULT_MS, overrideMs: o.draftRunCapMs ?? null, effectiveMs: effectiveAiDraftRunCapMs(o) },
  };
}

/** True when nothing is overridden — the setting row is then deleted. */
export function aiTimeoutOverridesEmpty(o: AiTimeoutOverrides): boolean {
  return Object.keys(o.calls).length === 0 && o.draftRunCapMs === undefined;
}

export type AiTimeoutsValidation = { ok: true; value: AiTimeoutOverrides } | { ok: false; field: string; error: string };

/**
 * Validate a `PUT /api/admin/ai/timeouts` body — `{ calls?: { <featureKey>: ms | null }, draftRunCapMs?:
 * ms | null }` — as the complete set of overrides (an absent or null value = the default). Calls are
 * whole seconds 10–900 s; the run cap whole minutes 5–120 min and never shorter than the effective
 * draft call timeout.
 */
export function validateAiTimeoutsInput(raw: unknown, features: readonly AiTimeoutFeature[]): AiTimeoutsValidation {
  if (!isObj(raw)) return { ok: false, field: "body", error: "expected an object" };
  const value: AiTimeoutOverrides = { calls: {} };
  if (raw.calls !== undefined && raw.calls !== null) {
    if (!isObj(raw.calls)) return { ok: false, field: "calls", error: "calls must be an object keyed by feature" };
    for (const [key, v] of Object.entries(raw.calls)) {
      const field = `calls.${key}`;
      if (!features.some((f) => f.key === key)) return { ok: false, field, error: `"${key}" is not a registered AI feature` };
      if (v === null) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v % 1000 !== 0) return { ok: false, field, error: "the timeout must be a whole number of seconds" };
      if (v < AI_CALL_TIMEOUT_MIN_MS || v > AI_CALL_TIMEOUT_MAX_MS) {
        return { ok: false, field, error: `the timeout must be between ${AI_CALL_TIMEOUT_MIN_MS / 1000} and ${AI_CALL_TIMEOUT_MAX_MS / 1000} seconds` };
      }
      value.calls[key] = v;
    }
  }
  const cap = raw.draftRunCapMs;
  if (cap !== undefined && cap !== null) {
    const field = "draftRunCapMs";
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap % 60_000 !== 0) return { ok: false, field, error: "the run cap must be a whole number of minutes" };
    if (cap < AI_DRAFT_RUN_CAP_MIN_MS || cap > AI_DRAFT_RUN_CAP_MAX_MS) {
      return { ok: false, field, error: `the run cap must be between ${AI_DRAFT_RUN_CAP_MIN_MS / 60_000} and ${AI_DRAFT_RUN_CAP_MAX_MS / 60_000} minutes` };
    }
    value.draftRunCapMs = cap;
  }
  const draft = features.find((f) => f.key === AI_DRAFT_FEATURE_KEY);
  if (draft) {
    const callMs = effectiveAiCallTimeoutMs(draft, value);
    if (effectiveAiDraftRunCapMs(value) < callMs) {
      return { ok: false, field: "draftRunCapMs", error: `the run cap must not be shorter than the ${draft.label} timeout (${callMs / 1000} s)` };
    }
  }
  return { ok: true, value };
}
