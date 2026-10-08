// Policy rules — policy-as-prompt (SKILLY_SPEC.md §47), judged inside the §46 pre-review run. The
// client-safe half: types, limits, labels, rule validation, the accept-gate predicate, override
// authority, direct-publish routing and the published-version status. Pure — exported via
// "@skilly/shared/policy". The prompt pieces and the DB layer live in policy-prompt.ts /
// policy-db.ts (server-only).

export type PolicyScope = "platform" | "namespace";
export type PolicyRuleState = "shadow" | "enforced" | "disabled";
export type PolicyOutcome = "complies" | "not_applicable" | "uncertain" | "violates";
export type PolicyVerdictStatus = "pending" | "done" | "failed";
export type PolicyDismissalKind = "false_positive" | "accepted_exception";

export const POLICY_SCOPES: readonly PolicyScope[] = ["platform", "namespace"];
export const POLICY_RULE_STATES: readonly PolicyRuleState[] = ["shadow", "enforced", "disabled"];
export const POLICY_OUTCOMES: readonly PolicyOutcome[] = ["complies", "not_applicable", "uncertain", "violates"];
export const POLICY_DISMISSAL_KINDS: readonly PolicyDismissalKind[] = ["false_positive", "accepted_exception"];

// ── Limits (§47.2, §47.3, §47.5) ──────────────────────────────────────────────────────────────
export const POLICY_TITLE_MAX = 80;
export const POLICY_BODY_MAX = 1000;
export const POLICY_CONTEXT_MAX = 4000;
/** Non-disabled rules per scope (so at most 50 apply to any submission). */
export const POLICY_RULES_PER_SCOPE = 25;
export const POLICY_EXPLANATION_MAX = 600;
export const POLICY_EXCERPT_MAX = 300;
export const POLICY_EXCERPT_MIN = 8;
export const POLICY_EVIDENCE_MAX = 5;
export const POLICY_DISMISS_REASON_MAX = 500;

// ── Rule-change re-checks of the published catalog (§47.6) ───────────────────────────────────
/** At most this many catalog re-check runs are queued per window, after the proposal runs. */
export const POLICY_CATALOG_RECHECKS_PER_WINDOW = 10;
export const POLICY_CATALOG_RECHECK_WINDOW = "10 minutes";

// ── Labels ────────────────────────────────────────────────────────────────────────────────────
export const POLICY_STATE_LABEL: Record<PolicyRuleState, string> = { shadow: "Shadow", enforced: "Enforced", disabled: "Disabled" };
export const POLICY_OUTCOME_LABEL: Record<PolicyOutcome, string> = {
  violates: "Violates",
  uncertain: "Uncertain",
  complies: "Complies",
  not_applicable: "Not applicable",
};
export const POLICY_DISMISSAL_LABEL: Record<PolicyDismissalKind, string> = {
  false_positive: "False positive",
  accepted_exception: "Accepted exception",
};
/** Display order on the Policy sections: violations, then uncertain, complies, not applicable. */
export const POLICY_OUTCOME_ORDER: Record<PolicyOutcome, number> = { violates: 0, uncertain: 1, complies: 2, not_applicable: 3 };

export const POLICY_MISSING_ANSWER = "The pre-reviewer returned no usable answer for this rule.";
export const POLICY_DOWNGRADED_PREFIX = "Downgraded: the cited evidence was not found in the bundle.";

export function isPolicyRuleState(v: unknown): v is PolicyRuleState {
  return typeof v === "string" && (POLICY_RULE_STATES as readonly string[]).includes(v);
}
export function isPolicyDismissalKind(v: unknown): v is PolicyDismissalKind {
  return typeof v === "string" && (POLICY_DISMISSAL_KINDS as readonly string[]).includes(v);
}

// ── Rule validation (§47.3) ───────────────────────────────────────────────────────────────────

export interface PolicyRuleText {
  title: string;
  body: string;
  context: string | null;
}

export type PolicyRuleValidation =
  | { ok: true; value: PolicyRuleText }
  | { ok: false; code: "title_required" | "title_too_long" | "body_required" | "body_too_long" | "context_too_long"; error: string };

/** Normalize line endings and trim; the shared browser + server validator. */
export function validatePolicyRuleText(input: { title?: unknown; body?: unknown; context?: unknown }): PolicyRuleValidation {
  const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "");
  const title = clean(input.title).replace(/\s+/g, " ");
  const body = clean(input.body);
  const context = clean(input.context);
  if (!title) return { ok: false, code: "title_required", error: "A title is required." };
  if ([...title].length > POLICY_TITLE_MAX) return { ok: false, code: "title_too_long", error: `The title must be at most ${POLICY_TITLE_MAX} characters.` };
  if (!body) return { ok: false, code: "body_required", error: "The rule is required." };
  if ([...body].length > POLICY_BODY_MAX) return { ok: false, code: "body_too_long", error: `The rule must be at most ${POLICY_BODY_MAX} characters.` };
  if ([...context].length > POLICY_CONTEXT_MAX) return { ok: false, code: "context_too_long", error: `The context must be at most ${POLICY_CONTEXT_MAX} characters.` };
  return { ok: true, value: { title, body, context: context || null } };
}

/** Title uniqueness key (§47.3: case-insensitive, among non-disabled rules of one scope). */
export function policyTitleKey(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

// ── The gate (§47.7) ──────────────────────────────────────────────────────────────────────────

/** One applicable rule at its CURRENT state and revision. */
export interface PolicyGateRule {
  id: string;
  scope: PolicyScope;
  state: PolicyRuleState;
  revisionId: string;
  title: string;
}

export interface PolicyGateResult {
  ruleId: string;
  revisionId: string;
  outcome: PolicyOutcome;
}

export interface PolicyGateVerdict {
  status: PolicyVerdictStatus;
  results: readonly PolicyGateResult[];
}

/**
 * Why a rule trips the gate. `pending` / `off` / `unavailable` / `skipped` / `failed` / `stale` are
 * all "no verdict" (§47.7): the §46 run is queued, the pre-review switch is off, the AI integration
 * is not operational, the §46.3 per-proposal cap was hit, the run gave up, or the run predates the
 * rule's current wording.
 */
export type PolicyTripReason = "violates" | "pending" | "off" | "unavailable" | "skipped" | "failed" | "stale";
/** Why there is no verdict yet, when the subject has no done run (§46.8 statuses). */
export type PolicyNoVerdictReason = "pending" | "off" | "unavailable" | "skipped";

export interface PolicyTrip {
  ruleId: string;
  title: string;
  scope: PolicyScope;
  reason: PolicyTripReason;
}

export const POLICY_TRIP_LABEL: Record<PolicyTripReason, string> = {
  violates: "violates",
  pending: "no verdict — check pending",
  off: "no verdict — the pre-review is off",
  unavailable: "no verdict — the AI integration is unavailable",
  skipped: "no verdict — skipped (too many revisions today)",
  failed: "no verdict — check failed",
  stale: "no verdict — re-check queued",
};

/**
 * The accept gate (§47.7). Only currently ENFORCED rules can trip it: a rule since disabled or moved
 * to Shadow never does, whatever it was judged. No enforced rule ⇒ never trips, AI on or off.
 * `noVerdict` says why there is no done run (a pending run reads `pending` whatever it says).
 */
export function policyGateTrips(
  rules: readonly PolicyGateRule[],
  verdict: PolicyGateVerdict | null,
  opts: { noVerdict: PolicyNoVerdictReason },
): PolicyTrip[] {
  const enforced = rules.filter((r) => r.state === "enforced");
  if (enforced.length === 0) return [];
  const trip = (r: PolicyGateRule, reason: PolicyTripReason): PolicyTrip => ({ ruleId: r.id, title: r.title, scope: r.scope, reason });
  if (!verdict) return enforced.map((r) => trip(r, opts.noVerdict));
  if (verdict.status === "pending") return enforced.map((r) => trip(r, "pending"));
  if (verdict.status === "failed") return enforced.map((r) => trip(r, "failed"));
  const out: PolicyTrip[] = [];
  for (const r of enforced) {
    const res = verdict.results.find((x) => x.ruleId === r.id && x.revisionId === r.revisionId);
    if (!res) out.push(trip(r, "stale"));
    else if (res.outcome === "violates") out.push(trip(r, "violates"));
  }
  return out;
}

export interface PolicyActor {
  platformAdmin: boolean;
  /** Admin of the subject's (target / owning) namespace. */
  namespaceAdmin: boolean;
}

/** §47.1 #11: platform rules → Platform Admins only; namespace rules → namespace override holders. */
export function canOverridePolicyScope(scope: PolicyScope, actor: PolicyActor): boolean {
  return scope === "platform" ? actor.platformAdmin : actor.platformAdmin || actor.namespaceAdmin;
}

/**
 * §47.7 direct publish: straight through only when the publisher could override EVERY applicable
 * enforced rule; otherwise routed to review. No enforced rule ⇒ straight through.
 */
export function policyPublishRoute(rules: readonly Pick<PolicyGateRule, "scope" | "state">[], actor: PolicyActor): "through" | "route" {
  const enforced = rules.filter((r) => r.state === "enforced");
  return enforced.every((r) => canOverridePolicyScope(r.scope, actor)) ? "through" : "route";
}

// ── Published-version status (§47.8) ──────────────────────────────────────────────────────────

export type PolicyVersionStatus = "none" | "pending" | "clear" | "noted" | "flagged";

export const POLICY_STATUS_LABEL: Record<Exclude<PolicyVersionStatus, "none">, string> = {
  pending: "Policy check pending",
  clear: "Policy check passed",
  noted: "Policy check: exceptions noted",
  flagged: "Policy check: flagged",
};
export const POLICY_STATUS_HINT: Record<Exclude<PolicyVersionStatus, "none">, string> = {
  pending: "skilly's policy pre-reviewer hasn't finished checking this version against the namespace's rules.",
  clear: "This version was checked against every enforced policy rule and none was violated.",
  noted: "The policy check found violations, and an admin recorded each one as an exception or a false positive.",
  flagged: "The policy check found a violation of an enforced rule that no admin has reviewed yet.",
};

export interface PolicyDismissalKey {
  ruleId: string;
  revisionId: string;
}

/**
 * The derived status of a published version. An undismissed violation wins (flagged); then any
 * missing / stale verdict (pending); then dismissed violations (noted); else clear.
 */
export function policyVersionStatus(
  rules: readonly PolicyGateRule[],
  verdict: PolicyGateVerdict | null,
  dismissals: readonly PolicyDismissalKey[],
): { status: PolicyVersionStatus; violated: PolicyGateRule[] } {
  const enforced = rules.filter((r) => r.state === "enforced");
  if (enforced.length === 0) return { status: "none", violated: [] };
  if (!verdict || verdict.status !== "done") return { status: "pending", violated: [] };
  const violated: PolicyGateRule[] = [];
  let stale = false;
  let undismissed = false;
  for (const r of enforced) {
    const res = verdict.results.find((x) => x.ruleId === r.id && x.revisionId === r.revisionId);
    if (!res) { stale = true; continue; }
    if (res.outcome !== "violates") continue;
    violated.push(r);
    if (!dismissals.some((d) => d.ruleId === r.id && d.revisionId === r.revisionId)) undismissed = true;
  }
  if (undismissed) return { status: "flagged", violated };
  if (stale) return { status: "pending", violated };
  return { status: violated.length ? "noted" : "clear", violated };
}

/** Sort results for display (§47.9): violations, uncertain, complies, not applicable; then title. */
export function sortPolicyResults<T extends { outcome: PolicyOutcome; title: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => POLICY_OUTCOME_ORDER[a.outcome] - POLICY_OUTCOME_ORDER[b.outcome] || a.title.localeCompare(b.title));
}
