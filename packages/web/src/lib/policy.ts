// Policy rules on the web side (SKILLY_SPEC.md §47): the rules API (authority, validation, caps,
// revisions, audit), the skill page's chip + owner card, flag dismissal and the admin lists. The
// gate and publish routing live in proposals.ts; verdicts are §46 pre-review runs (judged by the
// worker, which also re-checks subjects after a rule change) read through @skilly/shared policy-db.
import type { Pool, PoolClient } from "pg";
import {
  POLICY_DISMISS_REASON_MAX,
  POLICY_RULES_PER_SCOPE,
  applicablePolicyRules,
  canOverridePolicyScope,
  canReviewNamespace,
  compareSemver,
  countActivePolicyRules,
  createPolicyRule,
  insertPolicyDismissal,
  isPolicyDismissalKind,
  isPolicyRuleState,
  listPolicyFlags,
  listPolicyRules,
  loadPolicyRule,
  loadVersionPolicyState,
  policyRuleCited,
  policyRuleRevisions,
  policyRuleViolationCounts,
  policyTitleTaken,
  resolveLatest,
  revisePolicyRule,
  setPolicyRuleState,
  sortPolicyResults,
  validatePolicyRuleText,
  type EffectiveAccess,
  type PolicyDismissalKind,
  type PolicyEvidence,
  type PolicyFlagRow,
  type PolicyOutcome,
  type PolicyRuleRow,
  type PolicyRuleState,
  type PolicyScope,
  type PolicyVersionStatus,
} from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { aiAvailable } from "./ai";
import { loadPrereviewSetting } from "@skilly/shared";

/** §47.1 #7: rules are judged only while the §46 pre-review is effective (switch on + AI operational). */
export async function prereviewEffective(): Promise<boolean> {
  return (await loadPrereviewSetting(pool)).enabled && (await aiAvailable());
}

type Db = Pool | PoolClient;
interface TxErr { status: number; error: string; code?: string }
export type PolicyResult<T = unknown> = ({ ok: true } & T) | { ok: false; status: number; error: string; code?: string };

const isPlatformAdmin = (a: EffectiveAccess) => a.isPlatformAdmin;
const isNsAdmin = (a: EffectiveAccess, nsId: string) => a.isPlatformAdmin || a.namespaceRoles.get(nsId) === "namespace_admin";
/** Who may write / edit / change the state of rules in a scope (§4 matrix). */
export function canManagePolicyScope(access: EffectiveAccess, namespaceId: string | null): boolean {
  return namespaceId ? isNsAdmin(access, namespaceId) : isPlatformAdmin(access);
}
const actorOf = (access: EffectiveAccess, namespaceId: string) => ({ platformAdmin: access.isPlatformAdmin, namespaceAdmin: access.namespaceRoles.get(namespaceId) === "namespace_admin" });

async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function namespaceBySlug(db: Db, slug: string): Promise<{ id: string; slug: string } | null> {
  const { rows } = await db.query<{ id: string; slug: string }>(`select id, slug from namespaces where slug = $1`, [slug]);
  return rows[0] ?? null;
}

// ── Reading rules ──────────────────────────────────────────────────────────────────────────────

/** A rule as the public list shows it (enforced rules, any signed-in user — §47.1 #5). */
export interface PublicRuleView {
  id: string;
  scope: PolicyScope;
  namespaceSlug: string | null;
  title: string;
  body: string;
  context: string | null;
}

/** A rule as its scope's admins see it in the editor. */
export interface AdminRuleView extends PublicRuleView {
  state: PolicyRuleState;
  revisionNo: number;
  updatedAt: string;
  updatedBy: string | null;
  /** Current published versions violating it (enforced or shadow). */
  violations: number;
  /** Cited by a check or a dismissal — can only be disabled, never deleted (§47.3). */
  cited: boolean;
}

const publicView = (r: PolicyRuleRow): PublicRuleView => ({ id: r.id, scope: r.scope, namespaceSlug: r.namespaceSlug, title: r.title, body: r.body, context: r.context });

export interface RulesListing {
  platform: (PublicRuleView | AdminRuleView)[];
  namespace: (PublicRuleView | AdminRuleView)[] | null;
  namespaceSlug: string | null;
  canManagePlatform: boolean;
  canManageNamespace: boolean;
  /** §47.3 editor notice: false ⇒ the §46 pre-review is off or unavailable, so nothing is judged. */
  prereviewEffective: boolean;
}

/**
 * GET /api/policy/rules (§47.11): the enforced platform rules + (with `ns`) that namespace's enforced
 * rules. `all` adds shadow + disabled rules, state and history — honoured per scope for its admins.
 */
export async function listRulesForViewer(access: EffectiveAccess, nsSlug: string | null, all: boolean): Promise<PolicyResult<{ listing: RulesListing }>> {
  const ns = nsSlug ? await namespaceBySlug(pool, nsSlug) : null;
  if (nsSlug && !ns) return { ok: false, status: 404, error: "namespace not found" };
  const canManagePlatform = canManagePolicyScope(access, null);
  const canManageNamespace = ns ? canManagePolicyScope(access, ns.id) : false;
  const scopeRules = async (nsId: string | null, admin: boolean) => {
    if (!(all && admin)) return (await listPolicyRules(pool, nsId, { enforcedOnly: true })).map(publicView);
    const rules = await listPolicyRules(pool, nsId, { includeDisabled: true });
    const counts = await policyRuleViolationCounts(pool, rules.map((r) => r.id));
    const cited = new Map(await Promise.all(rules.map(async (r) => [r.id, await policyRuleCited(pool, r.id)] as const)));
    return rules.map(
      (r): AdminRuleView => ({
        ...publicView(r),
        state: r.state,
        revisionNo: r.revisionNo,
        updatedAt: r.updatedAt,
        updatedBy: r.updatedBy?.displayName ?? null,
        violations: counts.get(r.id) ?? 0,
        cited: cited.get(r.id) ?? true,
      }),
    );
  };
  return {
    ok: true,
    listing: {
      platform: await scopeRules(null, canManagePlatform),
      namespace: ns ? await scopeRules(ns.id, canManageNamespace) : null,
      namespaceSlug: ns?.slug ?? null,
      canManagePlatform,
      canManageNamespace,
      prereviewEffective: await prereviewEffective(),
    },
  };
}

export async function ruleRevisionsForViewer(access: EffectiveAccess, ruleId: string): Promise<PolicyResult<{ revisions: Awaited<ReturnType<typeof policyRuleRevisions>> }>> {
  const rule = await loadPolicyRule(pool, ruleId);
  if (!rule) return { ok: false, status: 404, error: "rule not found" };
  if (!canManagePolicyScope(access, rule.namespaceId)) return { ok: false, status: 403, error: "only this rule's admins can see its history" };
  return { ok: true, revisions: await policyRuleRevisions(pool, ruleId) };
}

// ── Writing rules ──────────────────────────────────────────────────────────────────────────────

const ruleAudit = (r: PolicyRuleRow | { title: string; body: string; context: string | null; state?: PolicyRuleState; revisionNo?: number }) => ({
  title: r.title,
  body: r.body,
  context: r.context,
  ...("state" in r && r.state ? { state: r.state } : {}),
  ...("revisionNo" in r && r.revisionNo ? { revisionNo: r.revisionNo } : {}),
});

/** POST /api/policy/rules. */
export async function createRule(
  access: EffectiveAccess,
  actorUserId: string,
  body: { scope?: unknown; namespaceSlug?: unknown; title?: unknown; body?: unknown; context?: unknown; state?: unknown },
): Promise<PolicyResult<{ id: string }>> {
  if (body.scope !== "platform" && body.scope !== "namespace") return { ok: false, status: 422, error: "scope must be platform or namespace" };
  let namespaceId: string | null = null;
  if (body.scope === "namespace") {
    if (typeof body.namespaceSlug !== "string") return { ok: false, status: 422, error: "namespaceSlug is required for a namespace rule" };
    const ns = await namespaceBySlug(pool, body.namespaceSlug);
    if (!ns) return { ok: false, status: 404, error: "namespace not found" };
    namespaceId = ns.id;
  }
  if (!canManagePolicyScope(access, namespaceId)) {
    return { ok: false, status: 403, error: namespaceId ? "only this namespace's admins can write its rules" : "only platform admins can write platform rules" };
  }
  const state: PolicyRuleState = body.state === undefined ? "shadow" : isPolicyRuleState(body.state) ? body.state : ("invalid" as PolicyRuleState);
  if (!isPolicyRuleState(state)) return { ok: false, status: 422, error: "state must be shadow, enforced or disabled" };
  const v = validatePolicyRuleText(body);
  if (!v.ok) return { ok: false, status: 422, error: v.error, code: v.code };
  const id = await withTx<{ err: TxErr } | { id: string }>(async (c) => {
    if (state !== "disabled") {
      if ((await countActivePolicyRules(c, namespaceId)) >= POLICY_RULES_PER_SCOPE) return { err: { status: 422, error: `at most ${POLICY_RULES_PER_SCOPE} active rules per scope — disable one first`, code: "too_many_rules" } };
      if (await policyTitleTaken(c, namespaceId, v.value.title)) return { err: { status: 422, error: "another active rule already has this title", code: "title_taken" } };
    }
    const ruleId = await createPolicyRule(c, { namespaceId, state, ...v.value, authorId: actorUserId });
    await appendAudit(c, {
      actorUserId,
      action: "policy.rule_created",
      targetType: "policy_rule",
      targetId: ruleId,
      namespaceId,
      after: { scope: body.scope, ...ruleAudit({ ...v.value, state, revisionNo: 1 }) },
    });
    return { id: ruleId };
  });
  if ("err" in id) return { ok: false, ...id.err };
  return { ok: true, id: id.id };
}

/** PATCH /api/policy/rules/:id — a text edit writes a new revision (a no-op edit writes nothing). */
export async function updateRule(
  access: EffectiveAccess,
  actorUserId: string,
  ruleId: string,
  body: { title?: unknown; body?: unknown; context?: unknown },
): Promise<PolicyResult<{ revisionNo: number; changed: boolean }>> {
  const rule = await loadPolicyRule(pool, ruleId);
  if (!rule) return { ok: false, status: 404, error: "rule not found" };
  if (!canManagePolicyScope(access, rule.namespaceId)) return { ok: false, status: 403, error: "you can't edit this rule" };
  const v = validatePolicyRuleText({
    title: body.title === undefined ? rule.title : body.title,
    body: body.body === undefined ? rule.body : body.body,
    context: body.context === undefined ? rule.context : body.context,
  });
  if (!v.ok) return { ok: false, status: 422, error: v.error, code: v.code };
  if (v.value.title === rule.title && v.value.body === rule.body && (v.value.context ?? null) === (rule.context ?? null)) {
    return { ok: true, revisionNo: rule.revisionNo, changed: false };
  }
  const out = await withTx<{ err: TxErr } | { revisionNo: number }>(async (c) => {
    if (rule.state !== "disabled" && (await policyTitleTaken(c, rule.namespaceId, v.value.title, rule.id))) {
      return { err: { status: 422, error: "another active rule already has this title", code: "title_taken" } };
    }
    const revisionNo = await revisePolicyRule(c, rule.id, { ...v.value, authorId: actorUserId });
    await appendAudit(c, {
      actorUserId,
      action: "policy.rule_updated",
      targetType: "policy_rule",
      targetId: rule.id,
      namespaceId: rule.namespaceId,
      before: ruleAudit(rule),
      after: ruleAudit({ ...v.value, revisionNo }),
    });
    return { revisionNo };
  });
  if ("err" in out) return { ok: false, ...out.err };
  return { ok: true, revisionNo: out.revisionNo, changed: true };
}

/** PUT /api/policy/rules/:id/state. Re-enabling counts toward the cap and the title rule. */
export async function changeRuleState(access: EffectiveAccess, actorUserId: string, ruleId: string, state: unknown): Promise<PolicyResult<{ state: PolicyRuleState }>> {
  if (!isPolicyRuleState(state)) return { ok: false, status: 422, error: "state must be shadow, enforced or disabled" };
  const rule = await loadPolicyRule(pool, ruleId);
  if (!rule) return { ok: false, status: 404, error: "rule not found" };
  if (!canManagePolicyScope(access, rule.namespaceId)) return { ok: false, status: 403, error: "you can't change this rule" };
  if (rule.state === state) return { ok: true, state };
  const out = await withTx<{ err?: TxErr }>(async (c) => {
    if (rule.state === "disabled") {
      if ((await countActivePolicyRules(c, rule.namespaceId)) >= POLICY_RULES_PER_SCOPE) return { err: { status: 422, error: `at most ${POLICY_RULES_PER_SCOPE} active rules per scope — disable one first`, code: "too_many_rules" } };
      if (await policyTitleTaken(c, rule.namespaceId, rule.title, rule.id)) return { err: { status: 422, error: "another active rule already has this title", code: "title_taken" } };
    }
    await setPolicyRuleState(c, rule.id, state);
    await appendAudit(c, {
      actorUserId,
      action: "policy.rule_state_changed",
      targetType: "policy_rule",
      targetId: rule.id,
      namespaceId: rule.namespaceId,
      before: { state: rule.state, title: rule.title },
      after: { state, title: rule.title },
    });
    return {};
  });
  if (out.err) return { ok: false, ...out.err };
  return { ok: true, state };
}

/** DELETE /api/policy/rules/:id — only a rule nothing ever cited (§47.3); otherwise disable it. */
export async function deleteRule(access: EffectiveAccess, actorUserId: string, ruleId: string): Promise<PolicyResult> {
  const rule = await loadPolicyRule(pool, ruleId);
  if (!rule) return { ok: false, status: 404, error: "rule not found" };
  if (!canManagePolicyScope(access, rule.namespaceId)) return { ok: false, status: 403, error: "you can't delete this rule" };
  const out = await withTx<{ err?: TxErr }>(async (c) => {
    if (await policyRuleCited(c, rule.id)) return { err: { status: 409, error: "this rule has been cited by a policy check — disable it instead", code: "cited" } };
    // Pending verdicts that never judged it cite nothing; the cascade removes the revisions.
    await c.query(`delete from policy_rules where id = $1`, [rule.id]);
    await appendAudit(c, { actorUserId, action: "policy.rule_deleted", targetType: "policy_rule", targetId: rule.id, namespaceId: rule.namespaceId, before: ruleAudit(rule) });
    return {};
  });
  if (out.err) return { ok: false, ...out.err };
  return { ok: true };
}

// ── The skill page (§47.8, §47.9) ──────────────────────────────────────────────────────────────

async function activeSemvers(skillId: string): Promise<string[]> {
  const { rows } = await pool.query<{ semver: string }>(`select semver from skill_versions where skill_id = $1 and status = 'active'`, [skillId]);
  return rows.map((r) => r.semver);
}

/** The version the skill page describes: latest stable, else the highest active (§37.8 rule). */
function displayed(semvers: string[]): string | null {
  return resolveLatest(semvers) ?? ([...semvers].sort((a, b) => compareSemver(b, a))[0] ?? null);
}

export interface SkillPolicySummary {
  semver: string;
  status: Exclude<PolicyVersionStatus, "none">;
  violatedTitles: string[];
}

/** The chip every viewer sees (§47.9) — null when no enforced rule applies. */
export async function skillPolicySummary(skill: { id: string; namespaceId: string }): Promise<SkillPolicySummary | null> {
  const semver = displayed(await activeSemvers(skill.id));
  if (!semver) return null;
  const st = await loadVersionPolicyState(pool, skill, semver);
  if (st.status === "none") return null;
  return { semver, status: st.status, violatedTitles: st.status === "flagged" || st.status === "noted" ? st.violated.map((r) => r.title) : [] };
}

export interface PolicyCardResult {
  ruleId: string;
  revisionNo: number;
  scope: PolicyScope;
  namespaceSlug: string | null;
  title: string;
  body: string;
  context: string | null;
  state: "enforced" | "shadow";
  stale: boolean;
  outcome: PolicyOutcome;
  explanation: string;
  evidence: PolicyEvidence[];
  evidenceRejected: boolean;
  dismissal: { kind: PolicyDismissalKind; reason: string; source: "override" | "manual"; by: string | null; at: string } | null;
  canDismiss: boolean;
}

export interface PolicyCardDetail {
  semver: string;
  status: PolicyVersionStatus;
  verdict: { status: "pending" | "done" | "failed"; model: string | null; checkedAt: string | null; partial: boolean; attempts: number } | null;
  /** The §46 pre-review is effective (otherwise nothing is judged and re-runs are refused). */
  prereviewEffective: boolean;
  results: PolicyCardResult[];
  otherFlagged: string[];
  canRecheck: boolean;
}

/** The owner card (§47.9). Shadow results only for namespace / platform admins. */
export async function skillPolicyDetail(access: EffectiveAccess, skill: { id: string; namespaceId: string }, semver: string | null): Promise<PolicyCardDetail | null> {
  const semvers = await activeSemvers(skill.id);
  const target = semver ? (semvers.includes(semver) ? semver : null) : displayed(semvers);
  if (!target) return null;
  const st = await loadVersionPolicyState(pool, skill, target);
  const admin = canReviewNamespace(access, skill.namespaceId);
  const effective = await prereviewEffective();
  const actor = actorOf(access, skill.namespaceId);
  const byId = new Map(st.rules.map((r) => [r.id, r]));
  const results: PolicyCardResult[] = [];
  for (const res of st.verdict?.status === "done" ? st.verdict.results : []) {
    const cur = byId.get(res.ruleId);
    if (!cur || (cur.state === "shadow" && !admin)) continue;
    const d = st.dismissals.find((x) => x.ruleId === res.ruleId && x.revisionId === res.revisionId) ?? null;
    const live = cur.state === "enforced" && res.revisionId === cur.revisionId;
    results.push({
      ruleId: res.ruleId,
      revisionNo: res.revisionNo,
      scope: res.scope,
      namespaceSlug: res.namespaceSlug,
      title: res.title,
      body: res.body,
      context: res.context,
      state: cur.state === "enforced" ? "enforced" : "shadow",
      stale: res.revisionId !== cur.revisionId,
      outcome: res.outcome,
      explanation: res.explanation,
      evidence: res.evidence,
      evidenceRejected: res.evidenceRejected,
      dismissal: d ? { kind: d.kind, reason: d.reason, source: d.source, by: d.dismissedBy, at: d.dismissedAt } : null,
      canDismiss: live && res.outcome === "violates" && !d && canOverridePolicyScope(res.scope, actor),
    });
  }
  const otherFlagged: string[] = [];
  for (const sv of semvers) {
    if (sv === target) continue;
    if ((await loadVersionPolicyState(pool, skill, sv)).status === "flagged") otherFlagged.push(sv);
  }
  return {
    semver: target,
    status: st.status,
    verdict: st.verdict ? { status: st.verdict.status, model: st.verdict.model, checkedAt: st.verdict.completedAt, partial: st.verdict.partial, attempts: st.verdict.attempts } : null,
    prereviewEffective: effective,
    results: sortPolicyResults(results),
    otherFlagged: otherFlagged.sort((a, b) => compareSemver(b, a)),
    // Re-check = the §46 owner re-run (override holders, while the pre-review is effective).
    canRecheck: admin && effective && st.rules.length > 0,
  };
}

/** POST /api/skills/:ns/:slug/policy/dismiss (§47.8). */
export async function dismissPolicyFlag(
  access: EffectiveAccess,
  actorUserId: string,
  skill: { id: string; namespaceId: string; slug: string },
  body: { semver?: unknown; ruleId?: unknown; kind?: unknown; reason?: unknown },
): Promise<PolicyResult> {
  if (typeof body.semver !== "string" || typeof body.ruleId !== "string") return { ok: false, status: 422, error: "semver and ruleId are required" };
  if (!isPolicyDismissalKind(body.kind)) return { ok: false, status: 422, error: "kind must be false_positive or accepted_exception" };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return { ok: false, status: 422, error: "a reason is required" };
  if ([...reason].length > POLICY_DISMISS_REASON_MAX) return { ok: false, status: 422, error: `the reason can be at most ${POLICY_DISMISS_REASON_MAX} characters` };
  const st = await loadVersionPolicyState(pool, skill, body.semver);
  const rule = st.rules.find((r) => r.id === body.ruleId);
  if (!rule) return { ok: false, status: 404, error: "rule not found for this skill" };
  if (!canOverridePolicyScope(rule.scope, actorOf(access, skill.namespaceId))) {
    return { ok: false, status: 403, error: rule.scope === "platform" ? "only a platform admin can dismiss a platform rule's flag" : "only admins of this namespace can dismiss this flag" };
  }
  const res = st.verdict?.status === "done" ? st.verdict.results.find((r) => r.ruleId === rule.id && r.revisionId === rule.revisionId) : undefined;
  const dismissed = st.dismissals.some((d) => d.ruleId === rule.id && d.revisionId === rule.revisionId);
  if (rule.state !== "enforced" || !res || res.outcome !== "violates" || dismissed) {
    return { ok: false, status: 409, error: "this rule isn't currently flagged for this version" };
  }
  await withTx(async (c) => {
    await insertPolicyDismissal(c, { skillId: skill.id, semver: body.semver as string, ruleId: rule.id, revisionId: rule.revisionId, kind: body.kind as PolicyDismissalKind, reason, source: "manual", byUserId: actorUserId });
    await appendAudit(c, {
      actorUserId,
      action: "skill.policy_flag_dismissed",
      targetType: "skill_version",
      targetId: `${skill.id}@${body.semver}`,
      namespaceId: skill.namespaceId,
      after: { skill: skill.slug, semver: body.semver, ruleId: rule.id, revisionId: rule.revisionId, title: rule.title, scope: rule.scope, kind: body.kind, reason },
    });
  });
  return { ok: true };
}

// ── Admin lists & progress ─────────────────────────────────────────────────────────────────────

export async function listFlagsForAdmin(q: { status?: string | null; ns?: string | null; rule?: string | null; shadow?: boolean }): Promise<PolicyResult<{ rows: PolicyFlagRow[] }>> {
  let namespaceId: string | null = null;
  if (q.ns) {
    const ns = await namespaceBySlug(pool, q.ns);
    if (!ns) return { ok: true, rows: [] };
    namespaceId = ns.id;
  }
  const ruleId = q.rule && /^[0-9a-f-]{36}$/i.test(q.rule) ? q.rule : null;
  const status = q.status === "noted" ? "noted" : q.status === "all" ? null : "flagged";
  return { ok: true, rows: await listPolicyFlags(pool, { namespaceId, ruleId, status: q.shadow ? null : status, shadow: q.shadow === true }) };
}

export async function listFlagsForNamespace(namespaceId: string, q: { status?: string | null; rule?: string | null; shadow?: boolean }): Promise<PolicyFlagRow[]> {
  const ruleId = q.rule && /^[0-9a-f-]{36}$/i.test(q.rule) ? q.rule : null;
  const status = q.status === "noted" ? "noted" : q.status === "all" ? null : "flagged";
  return listPolicyFlags(pool, { namespaceId, ruleId, status: q.shadow ? null : status, shadow: q.shadow === true });
}
