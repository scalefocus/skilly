// Policy rules persistence (SKILLY_SPEC.md §47): rules and their revisions; the per-rule results
// of §46 pre-review runs read for the gate and the surfaces; dismissals; the two notifications;
// the rule-change re-checks (reconcile) and the admin lists. Shared by web (rules API, gate,
// publish, surfaces) and worker (the §46 sweep, MCP). Plain SQL over a minimal query interface —
// no pg import. Server-only by convention (reachable from the root index, never from
// "@skilly/shared/policy").
import { compareSemver, resolveLatest } from "./semver.js";
import {
  PREREVIEW_PROPOSAL_DAILY_CAP,
  loadPrereviewSetting,
  prereviewSourceOfPayload,
  proposalAutoRunsLast24h,
  type PrereviewSource,
} from "./ai-prereview-db.js";
import {
  POLICY_CATALOG_RECHECKS_PER_WINDOW,
  POLICY_CATALOG_RECHECK_WINDOW,
  policyGateTrips,
  policyVersionStatus,
  sortPolicyResults,
  type PolicyDismissalKey,
  type PolicyDismissalKind,
  type PolicyGateRule,
  type PolicyGateVerdict,
  type PolicyNoVerdictReason,
  type PolicyOutcome,
  type PolicyRuleState,
  type PolicyScope,
  type PolicyTrip,
  type PolicyVerdictStatus,
  type PolicyVersionStatus,
} from "./policy.js";
import type { PolicyEvidence } from "./policy-prompt.js";

export interface PolicyDb {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

const OPEN_STATES = `('proposed', 'under_review', 'changes_requested')`;
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

// ── Rules ──────────────────────────────────────────────────────────────────────────────────────

export interface PolicyRuleRow {
  id: string;
  scope: PolicyScope;
  namespaceId: string | null;
  namespaceSlug: string | null;
  state: PolicyRuleState;
  revisionId: string;
  revisionNo: number;
  title: string;
  body: string;
  context: string | null;
  createdAt: string;
  updatedAt: string;
  stateChangedAt: string;
  /** Who wrote the current revision. */
  updatedBy: { id: string; displayName: string } | null;
}

const RULE_SELECT = `
  select r.id, r.scope, r.namespace_id, n.slug as ns_slug, r.state, r.created_at, r.updated_at, r.state_changed_at,
         rv.id as revision_id, rv.revision_no, rv.title, rv.body, rv.context, rv.author, au.display_name as author_name
    from policy_rules r
    left join namespaces n on n.id = r.namespace_id
    join lateral (select * from policy_rule_revisions x where x.rule_id = r.id order by x.revision_no desc limit 1) rv on true
    left join users au on au.id = rv.author`;

function toRule(r: any): PolicyRuleRow {
  return {
    id: r.id,
    scope: r.scope,
    namespaceId: r.namespace_id ?? null,
    namespaceSlug: r.ns_slug ?? null,
    state: r.state,
    revisionId: r.revision_id,
    revisionNo: Number(r.revision_no),
    title: r.title,
    body: r.body,
    context: r.context ?? null,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    stateChangedAt: iso(r.state_changed_at)!,
    updatedBy: r.author ? { id: r.author, displayName: r.author_name ?? "" } : null,
  };
}

/** One rule at its current revision. */
export async function loadPolicyRule(db: PolicyDb, ruleId: string): Promise<PolicyRuleRow | null> {
  const { rows } = await db.query(`${RULE_SELECT} where r.id = $1`, [ruleId]);
  return rows[0] ? toRule(rows[0]) : null;
}

/** Every rule of ONE scope (platform when namespaceId is null), in title order. */
export async function listPolicyRules(db: PolicyDb, namespaceId: string | null, opts: { includeDisabled?: boolean; enforcedOnly?: boolean } = {}): Promise<PolicyRuleRow[]> {
  const filter = opts.enforcedOnly ? `and r.state = 'enforced'` : opts.includeDisabled ? `` : `and r.state <> 'disabled'`;
  const { rows } = await db.query(
    `${RULE_SELECT} where ${namespaceId ? `r.namespace_id = $1` : `r.scope = 'platform' and $1::uuid is null`} ${filter}
      order by lower(rv.title), r.created_at`,
    [namespaceId],
  );
  return rows.map(toRule);
}

/** §46.4: every non-disabled platform rule + every non-disabled rule of the namespace. */
export async function applicablePolicyRules(db: PolicyDb, namespaceId: string): Promise<PolicyRuleRow[]> {
  const { rows } = await db.query(
    `${RULE_SELECT} where r.state <> 'disabled' and (r.scope = 'platform' or r.namespace_id = $1)
      order by (r.scope = 'platform') desc, lower(rv.title), r.created_at`,
    [namespaceId],
  );
  return rows.map(toRule);
}

export function toGateRules(rules: readonly PolicyRuleRow[]): PolicyGateRule[] {
  return rules.map((r) => ({ id: r.id, scope: r.scope, state: r.state, revisionId: r.revisionId, title: r.title }));
}

/** Non-disabled rules of one scope (the §46.3 25-rule cap). */
export async function countActivePolicyRules(db: PolicyDb, namespaceId: string | null, excludeRuleId?: string): Promise<number> {
  const { rows } = await db.query(
    `select count(*)::int as n from policy_rules
      where state <> 'disabled' and ${namespaceId ? `namespace_id = $1` : `scope = 'platform' and $1::uuid is null`}
        and ($2::uuid is null or id <> $2)`,
    [namespaceId, excludeRuleId ?? null],
  );
  return Number(rows[0]?.n ?? 0);
}

/** True when another non-disabled rule of the scope already uses this title (case-insensitive). */
export async function policyTitleTaken(db: PolicyDb, namespaceId: string | null, title: string, excludeRuleId?: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from policy_rules r
       join lateral (select title from policy_rule_revisions x where x.rule_id = r.id order by x.revision_no desc limit 1) rv on true
      where r.state <> 'disabled' and ${namespaceId ? `r.namespace_id = $1` : `r.scope = 'platform' and $1::uuid is null`}
        and lower(regexp_replace(trim(rv.title), '\\s+', ' ', 'g')) = lower(regexp_replace(trim($2), '\\s+', ' ', 'g'))
        and ($3::uuid is null or r.id <> $3)
      limit 1`,
    [namespaceId, title, excludeRuleId ?? null],
  );
  return rows.length > 0;
}

export async function createPolicyRule(
  db: PolicyDb,
  input: { namespaceId: string | null; state: PolicyRuleState; title: string; body: string; context: string | null; authorId: string },
): Promise<string> {
  const { rows } = await db.query(
    `insert into policy_rules (scope, namespace_id, state, created_by) values ($1, $2, $3, $4) returning id`,
    [input.namespaceId ? "namespace" : "platform", input.namespaceId, input.state, input.authorId],
  );
  const id = rows[0]!.id as string;
  await db.query(
    `insert into policy_rule_revisions (rule_id, revision_no, title, body, context, author) values ($1, 1, $2, $3, $4, $5)`,
    [id, input.title, input.body, input.context, input.authorId],
  );
  return id;
}

/** A text edit: a new immutable revision (callers skip no-op edits). Returns the new revision no. */
export async function revisePolicyRule(db: PolicyDb, ruleId: string, input: { title: string; body: string; context: string | null; authorId: string }): Promise<number> {
  const { rows } = await db.query(
    `insert into policy_rule_revisions (rule_id, revision_no, title, body, context, author)
     select $1, coalesce(max(revision_no), 0) + 1, $2, $3, $4, $5 from policy_rule_revisions where rule_id = $1
     returning revision_no`,
    [ruleId, input.title, input.body, input.context, input.authorId],
  );
  await db.query(`update policy_rules set updated_at = now() where id = $1`, [ruleId]);
  return Number(rows[0]!.revision_no);
}

export async function setPolicyRuleState(db: PolicyDb, ruleId: string, state: PolicyRuleState): Promise<void> {
  await db.query(`update policy_rules set state = $2, state_changed_at = now(), updated_at = now() where id = $1`, [ruleId, state]);
}

/** True when any verdict result or dismissal cites any revision of the rule (⇒ not deletable). */
export async function policyRuleCited(db: PolicyDb, ruleId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select (exists (select 1 from ai_prereview_policy_results where rule_id = $1)
             or exists (select 1 from policy_flag_dismissals where rule_id = $1)) as cited`,
    [ruleId],
  );
  return rows[0]?.cited === true;
}

export async function policyRuleRevisions(db: PolicyDb, ruleId: string): Promise<{ revisionNo: number; title: string; body: string; context: string | null; author: string | null; createdAt: string }[]> {
  const { rows } = await db.query(
    `select rv.revision_no, rv.title, rv.body, rv.context, u.display_name as author, rv.created_at
       from policy_rule_revisions rv left join users u on u.id = rv.author
      where rv.rule_id = $1 order by rv.revision_no desc`,
    [ruleId],
  );
  return rows.map((r) => ({ revisionNo: Number(r.revision_no), title: r.title, body: r.body, context: r.context ?? null, author: r.author ?? null, createdAt: iso(r.created_at)! }));
}

/** Catalog violation counts per rule (active versions' CURRENT runs only), for the editor list. */
export async function policyRuleViolationCounts(db: PolicyDb, ruleIds: readonly string[]): Promise<Map<string, number>> {
  if (ruleIds.length === 0) return new Map();
  const { rows } = await db.query(
    `select res.rule_id, count(distinct sv.id)::int as n
       from skill_versions sv
       join skills s on s.id = sv.skill_id and s.status = 'active'
       join lateral (select l.run_id from ai_prereview_links l where l.skill_version_id = sv.id order by l.id desc limit 1) cur on true
       join ai_prereview_policy_results res on res.run_id = cur.run_id
      where sv.status = 'active' and res.rule_id = any($1::uuid[]) and res.outcome = 'violates'
      group by res.rule_id`,
    [ruleIds],
  );
  return new Map(rows.map((r) => [r.rule_id as string, Number(r.n)]));
}

// ── Verdicts: a subject's current §46 run and its per-rule results ────────────────────────────

/** A §47 subject — the same subjects §46 links runs to. */
export type PolicySubject = { kind: "proposal"; proposalId: string; revision: number } | { kind: "version"; versionId: string };

export interface PolicyResultView {
  ruleId: string;
  revisionId: string;
  revisionNo: number;
  scope: PolicyScope;
  namespaceSlug: string | null;
  /** The judged revision's text — the exact wording enforced. */
  title: string;
  body: string;
  context: string | null;
  /** The rule's state when judged, and now. */
  judgedState: "shadow" | "enforced";
  currentState: PolicyRuleState;
  currentRevisionId: string;
  outcome: PolicyOutcome;
  explanation: string;
  evidence: PolicyEvidence[];
  evidenceRejected: boolean;
}

export interface PolicyVerdictView {
  runId: string;
  status: PolicyVerdictStatus;
  attempts: number;
  model: string | null;
  /** §46 coverage was not complete (a file skipped, truncated or out of scope). */
  partial: boolean;
  createdAt: string;
  completedAt: string | null;
  results: PolicyResultView[];
}

async function loadRunResults(db: PolicyDb, runId: string): Promise<PolicyResultView[]> {
  const { rows } = await db.query(
    `select res.rule_id, res.revision_id, res.rule_state, res.outcome, res.explanation, res.evidence, res.evidence_rejected,
            rv.revision_no, rv.title, rv.body, rv.context, r.scope, r.state as current_state, n.slug as ns_slug,
            (select x.id from policy_rule_revisions x where x.rule_id = r.id order by x.revision_no desc limit 1) as current_revision_id
       from ai_prereview_policy_results res
       join policy_rule_revisions rv on rv.id = res.revision_id
       join policy_rules r on r.id = res.rule_id
       left join namespaces n on n.id = r.namespace_id
      where res.run_id = $1`,
    [runId],
  );
  return rows.map((r) => ({
    ruleId: r.rule_id,
    revisionId: r.revision_id,
    revisionNo: Number(r.revision_no),
    scope: r.scope,
    namespaceSlug: r.ns_slug ?? null,
    title: r.title,
    body: r.body,
    context: r.context ?? null,
    judgedState: r.rule_state,
    currentState: r.current_state,
    currentRevisionId: r.current_revision_id,
    outcome: r.outcome,
    explanation: r.explanation ?? "",
    evidence: Array.isArray(r.evidence) ? r.evidence : [],
    evidenceRejected: r.evidence_rejected === true,
  }));
}

const RUN_COLS = `r.id, r.status, r.attempts, r.model, r.coverage, r.created_at, r.completed_at`;

async function toVerdictView(db: PolicyDb, r: any): Promise<PolicyVerdictView> {
  const coverage = Array.isArray(r.coverage) ? (r.coverage as { status?: string }[]) : [];
  return {
    runId: r.id,
    status: r.status,
    attempts: Number(r.attempts ?? 0),
    model: r.model ?? null,
    partial: coverage.some((c) => c.status && c.status !== "reviewed"),
    createdAt: iso(r.created_at)!,
    completedAt: iso(r.completed_at),
    results: r.status === "done" ? await loadRunResults(db, r.id) : [],
  };
}

/** The subject's current §46 run (its newest link, §46.9) with its §47 results. */
export async function loadSubjectPolicyVerdict(db: PolicyDb, subject: PolicySubject): Promise<PolicyVerdictView | null> {
  const { rows } =
    subject.kind === "proposal"
      ? await db.query(
          `select ${RUN_COLS} from ai_prereview_links l join ai_prereviews r on r.id = l.run_id
            where l.proposal_id = $1 and l.revision = $2 order by l.id desc limit 1`,
          [subject.proposalId, subject.revision],
        )
      : await db.query(
          `select ${RUN_COLS} from ai_prereview_links l join ai_prereviews r on r.id = l.run_id
            where l.skill_version_id = $1 order by l.id desc limit 1`,
          [subject.versionId],
        );
  return rows[0] ? toVerdictView(db, rows[0]) : null;
}

export function toGateVerdict(v: PolicyVerdictView | null): PolicyGateVerdict | null {
  return v ? { status: v.status, results: v.results.map((r) => ({ ruleId: r.ruleId, revisionId: r.revisionId, outcome: r.outcome })) } : null;
}

export async function latestRevisionNo(db: PolicyDb, proposalId: string): Promise<number | null> {
  const { rows } = await db.query(`select max(revision_no)::int as n from proposal_revisions where proposal_id = $1`, [proposalId]);
  return rows[0]?.n == null ? null : Number(rows[0].n);
}

/**
 * Why a proposal's current revision has no run yet (§46.8's statuses): the switch is off, the
 * integration is unavailable, the §46.3 daily cap was hit, or the worker simply hasn't linked it.
 */
export async function proposalNoVerdictReason(db: PolicyDb, proposalId: string, aiOn: boolean): Promise<PolicyNoVerdictReason> {
  const setting = await loadPrereviewSetting(db);
  if (!setting.enabled) return "off";
  if (!aiOn) return "unavailable";
  if ((await proposalAutoRunsLast24h(db, proposalId)) >= PREREVIEW_PROPOSAL_DAILY_CAP) return "skipped";
  return "pending";
}

/** A version's id by skill + semver (null: not materialized yet — a pointer before its mirror). */
export async function versionIdOf(db: PolicyDb, skillId: string, semver: string): Promise<string | null> {
  const { rows } = await db.query(`select id from skill_versions where skill_id = $1 and semver = $2`, [skillId, semver]);
  return rows[0]?.id ?? null;
}

// ── The proposal's Policy block (web payload + MCP get_proposal, §47.9, §47.11) ───────────────

export interface PolicyResultPayload {
  ruleId: string;
  revisionId: string;
  revisionNo: number;
  scope: PolicyScope;
  namespaceSlug: string | null;
  title: string;
  body: string;
  context: string | null;
  /** The rule's CURRENT state (enforced | shadow — disabled rules are never listed). */
  state: "enforced" | "shadow";
  /** True when the rule has been edited since this result was judged (a re-check is queued). */
  stale: boolean;
  outcome: PolicyOutcome;
  explanation: string;
  evidence: PolicyEvidence[];
  evidenceRejected: boolean;
}

export interface ProposalPolicyPayload {
  /** none = no rule applies; pending / off / unavailable / skipped = no verdict yet; failed = gave up; done = judged. */
  status: "none" | PolicyNoVerdictReason | "failed" | "done";
  partial: boolean;
  model: string | null;
  checkedAt: string | null;
  /** Applicable rules shown to this viewer (enforced, plus shadow for reviewers). */
  rulesChecked: number;
  results: PolicyResultPayload[];
  /** What the accept gate would trip on right now (enforced rules only). */
  trips: PolicyTrip[];
}

/**
 * Build the §47.9 Policy block for a proposal's current revision. `includeShadow` for reviewers
 * (proposers and MCP see enforced rules only).
 */
export async function proposalPolicyPayload(
  db: PolicyDb,
  proposal: { id: string; namespaceId: string },
  opts: { includeShadow: boolean; aiOn: boolean },
): Promise<ProposalPolicyPayload> {
  const rules = await applicablePolicyRules(db, proposal.namespaceId);
  const visible = rules.filter((r) => r.state === "enforced" || (opts.includeShadow && r.state === "shadow"));
  const revision = await latestRevisionNo(db, proposal.id);
  const verdict = revision === null ? null : await loadSubjectPolicyVerdict(db, { kind: "proposal", proposalId: proposal.id, revision });
  const noVerdict = verdict ? "pending" : await proposalNoVerdictReason(db, proposal.id, opts.aiOn);
  const trips = policyGateTrips(toGateRules(rules), toGateVerdict(verdict), { noVerdict });
  const base = { partial: false, model: null, checkedAt: null, rulesChecked: visible.length, results: [] as PolicyResultPayload[], trips };
  if (visible.length === 0) return { ...base, status: "none" };
  if (!verdict) return { ...base, status: noVerdict };
  if (verdict.status === "pending") return { ...base, status: "pending" };
  if (verdict.status === "failed") return { ...base, status: "failed" };
  const byId = new Map(visible.map((r) => [r.id, r]));
  const results: PolicyResultPayload[] = [];
  for (const res of verdict.results) {
    const cur = byId.get(res.ruleId);
    if (!cur) continue; // disabled since, or shadow hidden from this viewer
    results.push({
      ruleId: res.ruleId,
      revisionId: res.revisionId,
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
    });
  }
  return { ...base, status: "done", partial: verdict.partial, model: verdict.model, checkedAt: verdict.completedAt, results: sortPolicyResults(results) };
}

// ── Dismissals ─────────────────────────────────────────────────────────────────────────────────

export interface PolicyDismissalView {
  ruleId: string;
  revisionId: string;
  kind: PolicyDismissalKind;
  reason: string;
  source: "override" | "manual";
  dismissedBy: string | null;
  dismissedAt: string;
}

export async function loadPolicyDismissals(db: PolicyDb, skillId: string, semver: string): Promise<PolicyDismissalView[]> {
  const { rows } = await db.query(
    `select d.rule_id, d.revision_id, d.kind, d.reason, d.source, u.display_name as by_name, d.dismissed_at
       from policy_flag_dismissals d left join users u on u.id = d.dismissed_by
      where d.skill_id = $1 and d.semver = $2 order by d.dismissed_at`,
    [skillId, semver],
  );
  return rows.map((r) => ({
    ruleId: r.rule_id,
    revisionId: r.revision_id,
    kind: r.kind,
    reason: r.reason,
    source: r.source,
    dismissedBy: r.by_name ?? null,
    dismissedAt: iso(r.dismissed_at)!,
  }));
}

export async function insertPolicyDismissal(
  db: PolicyDb,
  d: { skillId: string; semver: string; ruleId: string; revisionId: string; kind: PolicyDismissalKind; reason: string; source: "override" | "manual"; byUserId: string },
): Promise<void> {
  await db.query(
    `insert into policy_flag_dismissals (skill_id, semver, rule_id, revision_id, kind, reason, source, dismissed_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [d.skillId, d.semver, d.ruleId, d.revisionId, d.kind, d.reason.slice(0, 500), d.source, d.byUserId],
  );
}

/** Everything the skill-page chip and owner card need for one version (§47.8). */
export async function loadVersionPolicyState(
  db: PolicyDb,
  skill: { id: string; namespaceId: string },
  semver: string,
): Promise<{ rules: PolicyRuleRow[]; verdict: PolicyVerdictView | null; dismissals: PolicyDismissalView[]; status: PolicyVersionStatus; violated: PolicyGateRule[] }> {
  const rules = await applicablePolicyRules(db, skill.namespaceId);
  const versionId = await versionIdOf(db, skill.id, semver);
  const verdict = versionId ? await loadSubjectPolicyVerdict(db, { kind: "version", versionId }) : null;
  const dismissals = await loadPolicyDismissals(db, skill.id, semver);
  const { status, violated } = policyVersionStatus(toGateRules(rules), toGateVerdict(verdict), dismissals);
  return { rules, verdict, dismissals, status, violated };
}

// ── The worker side: which rules a run judges ──────────────────────────────────────────────────

/** The namespace whose rules a subject is judged against (§47.4). */
export async function subjectNamespace(db: PolicyDb, subject: PolicySubject): Promise<string | null> {
  const { rows } =
    subject.kind === "proposal"
      ? await db.query(`select target_namespace_id as ns from proposals where id = $1`, [subject.proposalId])
      : await db.query(`select s.namespace_id as ns from skill_versions sv join skills s on s.id = sv.skill_id where sv.id = $1`, [subject.versionId]);
  return rows[0]?.ns ?? null;
}

/**
 * The rules a run judges: those applicable to the subject of its OLDEST link. Another subject that
 * linked to the same run through the cache had an identical fingerprint when it linked; if rules
 * have changed since, its result is stale and the reconcile gives it its own run.
 */
export async function policyRulesForRun(db: PolicyDb, runId: string): Promise<PolicyRuleRow[]> {
  const { rows } = await db.query(
    `select coalesce(p.target_namespace_id, s.namespace_id) as ns
       from ai_prereview_links l
       left join proposals p on p.id = l.proposal_id
       left join skill_versions sv on sv.id = l.skill_version_id
       left join skills s on s.id = sv.skill_id
      where l.run_id = $1
      order by l.id asc limit 1`,
    [runId],
  );
  const ns = rows[0]?.ns as string | undefined;
  return ns ? applicablePolicyRules(db, ns) : [];
}

/** The fingerprint input of a rule set. */
export function policyFingerprintInput(rules: readonly PolicyRuleRow[]): { ruleId: string; revisionId: string }[] {
  return rules.map((r) => ({ ruleId: r.id, revisionId: r.revisionId }));
}

// ── Notifications (§47.10) ─────────────────────────────────────────────────────────────────────

/**
 * `proposal.policy_violation` → the proposer, when a freshly judged run is the CURRENT run of an
 * open proposal's LATEST revision (not a cache link, not superseded) and violates an enforced rule.
 * Returns how many proposals were notified.
 */
export async function notifyProposalPolicyViolations(db: PolicyDb, runId: string): Promise<number> {
  const { rows } = await db.query(
    `select p.id as proposal_id, p.submitted_by, p.proposed_semver, pr.payload->'metadata'->>'skillSlug' as skill_slug, n.slug as ns_slug
       from ai_prereview_links l
       join proposals p on p.id = l.proposal_id and p.state in ${OPEN_STATES}
       join proposal_revisions pr on pr.proposal_id = p.id and pr.revision_no = l.revision
       join namespaces n on n.id = p.target_namespace_id
      where l.run_id = $1 and not l.cached
        and l.revision = (select max(x.revision_no) from proposal_revisions x where x.proposal_id = p.id)
        and l.id = (select max(y.id) from ai_prereview_links y where y.proposal_id = p.id and y.revision = l.revision)`,
    [runId],
  );
  if (rows.length === 0) return 0;
  const violations = (await loadRunResults(db, runId)).filter((r) => r.outcome === "violates" && r.judgedState === "enforced");
  if (violations.length === 0) return 0;
  let n = 0;
  for (const p of rows) {
    const ins = await db.query(
      `insert into notifications (user_id, type, payload)
       select u.id, 'proposal.policy_violation', $2::jsonb from users u where u.id = $1 and u.status = 'active'`,
      [
        p.submitted_by,
        JSON.stringify({
          proposalId: p.proposal_id,
          namespaceSlug: p.ns_slug,
          skillSlug: p.skill_slug,
          semver: p.proposed_semver,
          rules: violations.map((r) => ({ title: r.title, explanation: r.explanation })),
        }),
      ],
    );
    n += ins.rowCount ?? 0;
  }
  return n;
}

export interface PolicyOnset {
  versionId: string;
  skillId: string;
  semver: string;
  namespaceId: string;
  skillSlug: string;
  rules: { ruleId: string; revisionId: string; title: string; scope: PolicyScope }[];
}

/**
 * §47.8 onset, for every version whose CURRENT run is this (done) run: the violated rule revisions
 * (enforced now and when judged, current wording, undismissed) that the version's PREVIOUS done run
 * did not flag. Notifies `skill.policy_flag` to the effective maintainers (+ platform admins for a
 * platform rule), minus opt-outs, and returns the onsets for the caller to audit.
 */
export async function settleVersionPolicyRun(db: PolicyDb, runId: string): Promise<PolicyOnset[]> {
  const { rows } = await db.query(
    `select l.id as link_id, sv.id as version_id, sv.semver, s.id as skill_id, s.slug as skill_slug, s.namespace_id, n.slug as ns_slug
       from ai_prereview_links l
       join ai_prereviews r on r.id = l.run_id and r.status = 'done'
       join skill_versions sv on sv.id = l.skill_version_id
       join skills s on s.id = sv.skill_id
       join namespaces n on n.id = s.namespace_id
      where l.run_id = $1
        and l.id = (select max(y.id) from ai_prereview_links y where y.skill_version_id = sv.id)`,
    [runId],
  );
  if (rows.length === 0) return [];
  const results = await loadRunResults(db, runId);
  const out: PolicyOnset[] = [];
  for (const v of rows) {
    const dismissals: PolicyDismissalKey[] = await loadPolicyDismissals(db, v.skill_id, v.semver);
    const { rows: prev } = await db.query(
      `select r.id from ai_prereview_links l join ai_prereviews r on r.id = l.run_id
        where l.skill_version_id = $1 and l.id < $2 and r.status = 'done' and r.id <> $3
        order by l.id desc limit 1`,
      [v.version_id, v.link_id, runId],
    );
    const prevViolations = new Set<string>();
    if (prev[0]) {
      const { rows: pr } = await db.query(`select rule_id, revision_id from ai_prereview_policy_results where run_id = $1 and outcome = 'violates'`, [prev[0].id]);
      for (const x of pr) prevViolations.add(`${x.rule_id}|${x.revision_id}`);
    }
    const onset = results.filter(
      (r) =>
        r.outcome === "violates" &&
        r.judgedState === "enforced" &&
        r.currentState === "enforced" &&
        r.currentRevisionId === r.revisionId &&
        !prevViolations.has(`${r.ruleId}|${r.revisionId}`) &&
        !dismissals.some((d) => d.ruleId === r.ruleId && d.revisionId === r.revisionId),
    );
    if (onset.length === 0) continue;
    const anyPlatform = onset.some((r) => r.scope === "platform");
    await db.query(
      `insert into notifications (user_id, type, payload)
       select uid, 'skill.policy_flag', $2::jsonb
         from (
           select sm.user_id as uid from skill_maintainers sm where sm.skill_id = $1
           union
           select gm.user_id from role_mappings rm join group_memberships gm on gm.group_id = rm.group_id
            where (rm.namespace_id = $3 and rm.role = 'namespace_admin') or ($4 and rm.role = 'platform_admin')
         ) recipients
         join users u on u.id = recipients.uid and u.status = 'active' and u.policy_notifications`,
      [v.skill_id, JSON.stringify({ namespaceSlug: v.ns_slug, skillSlug: v.skill_slug, semver: v.semver, rules: onset.map((r) => r.title) }), v.namespace_id, anyPlatform],
    );
    out.push({
      versionId: v.version_id,
      skillId: v.skill_id,
      semver: v.semver,
      namespaceId: v.namespace_id,
      skillSlug: v.skill_slug,
      rules: onset.map((r) => ({ ruleId: r.ruleId, revisionId: r.revisionId, title: r.title, scope: r.scope })),
    });
  }
  return out;
}

// ── Reconcile: rule-change re-checks (§47.6) ───────────────────────────────────────────────────

/** True when a done run has a result for every given rule at its current revision. */
async function runCovers(db: PolicyDb, runId: string, rules: readonly PolicyRuleRow[]): Promise<boolean> {
  if (rules.length === 0) return true;
  const { rows } = await db.query(`select rule_id, revision_id from ai_prereview_policy_results where run_id = $1`, [runId]);
  const have = new Set(rows.map((r) => `${r.rule_id}|${r.revision_id}`));
  return rules.every((r) => have.has(`${r.id}|${r.revisionId}`));
}

/**
 * The §47.6 re-checks, run by the §46 sweep while the pre-review is effective. A subject's CURRENT
 * run is `done` but lacks a result for a rule's current revision (a rule was added, edited or
 * enabled, or a run landed stale):
 *  - an open proposal's current revision gets a fresh run — ENFORCED rules only, so a new Shadow
 *    rule never knocks a proposal back to pending;
 *  - the displayed (latest stable, else highest active) version of every active skill in a rule's
 *    scope gets a run — enforced and shadow rules (the Shadow preview) — at most
 *    POLICY_CATALOG_RECHECKS_PER_WINDOW per window, also when the version has no run at all.
 * `makeRun` creates or reuses (cache) a run for the subject; it is the §46 machinery, injected.
 */
export async function policyReconcile(
  db: PolicyDb,
  makeRun: (subject: PolicySubject, src: { source: PrereviewSource; contentSha256: string | null }, rules: PolicyRuleRow[]) => Promise<void>,
  opts: { limit?: number } = {},
): Promise<{ proposals: number; versions: number }> {
  const { rows: any } = await db.query(`select exists (select 1 from policy_rules where state <> 'disabled') as any`);
  if (!any[0]?.any) return { proposals: 0, versions: 0 };
  const limit = opts.limit ?? 25;
  const rulesByNs = new Map<string, PolicyRuleRow[]>();
  const rulesOf = async (ns: string) => {
    let r = rulesByNs.get(ns);
    if (!r) { r = await applicablePolicyRules(db, ns); rulesByNs.set(ns, r); }
    return r;
  };

  // (a) Open proposals whose current run is done but stale for an ENFORCED rule.
  let proposals = 0;
  const { rows: props } = await db.query(
    `select p.id, p.target_namespace_id, pr.revision_no, pr.payload, r.id as run_id
       from proposals p
       join lateral (select revision_no, payload from proposal_revisions where proposal_id = p.id order by revision_no desc limit 1) pr on true
       join lateral (select l.run_id from ai_prereview_links l where l.proposal_id = p.id and l.revision = pr.revision_no order by l.id desc limit 1) cur on true
       join ai_prereviews r on r.id = cur.run_id and r.status = 'done'
      where p.state in ${OPEN_STATES}
        and exists (select 1 from policy_rules pr2 where pr2.state = 'enforced' and (pr2.scope = 'platform' or pr2.namespace_id = p.target_namespace_id))
        and (select count(*) from ai_prereview_links l join ai_prereviews r2 on r2.id = l.run_id
              where l.proposal_id = p.id and not l.cached and r2.trigger <> 'rerun' and l.created_at > now() - interval '24 hours') < $1
      order by p.created_at
      limit 200`,
    [PREREVIEW_PROPOSAL_DAILY_CAP],
  );
  for (const p of props) {
    if (proposals >= limit) break;
    const rules = await rulesOf(p.target_namespace_id);
    if (await runCovers(db, p.run_id, rules.filter((r) => r.state === "enforced"))) continue;
    const src = prereviewSourceOfPayload(p.payload);
    if (!src) continue;
    await makeRun({ kind: "proposal", proposalId: p.id, revision: Number(p.revision_no) }, src, rules);
    proposals++;
  }

  // (b) The published catalog: displayed versions in a rule's scope, rate-limited.
  const { rows: used } = await db.query(
    `select count(*)::int as n from ai_prereview_links l join ai_prereviews r on r.id = l.run_id
      where r.trigger = 'policy' and l.skill_version_id is not null and l.created_at > now() - $1::interval`,
    [POLICY_CATALOG_RECHECK_WINDOW],
  );
  let budget = POLICY_CATALOG_RECHECKS_PER_WINDOW - Number(used[0]?.n ?? 0);
  let versions = 0;
  if (budget <= 0) return { proposals, versions };
  const { rows: vers } = await db.query(
    `select sv.id, sv.semver, sv.skill_id, sv.artifact_object_key, sv.content_sha256, s.namespace_id,
            (select l.run_id from ai_prereview_links l where l.skill_version_id = sv.id order by l.id desc limit 1) as run_id
       from skill_versions sv
       join skills s on s.id = sv.skill_id and s.status = 'active'
      where sv.status = 'active' and sv.artifact_object_key is not null
        and exists (select 1 from policy_rules r where r.state <> 'disabled' and (r.scope = 'platform' or r.namespace_id = s.namespace_id))`,
  );
  const bySkill = new Map<string, any[]>();
  for (const v of vers) bySkill.set(v.skill_id, [...(bySkill.get(v.skill_id) ?? []), v]);
  for (const list of bySkill.values()) {
    if (budget <= 0) break;
    const semvers = list.map((v) => v.semver as string);
    const shown = resolveLatest(semvers) ?? [...semvers].sort((a, b) => compareSemver(b, a))[0];
    const v = list.find((x) => x.semver === shown);
    if (!v) continue;
    const rules = await rulesOf(v.namespace_id);
    if (v.run_id) {
      const { rows: st } = await db.query(`select status from ai_prereviews where id = $1`, [v.run_id]);
      if (st[0]?.status !== "done") continue; // pending: wait; failed: an owner re-runs
      if (await runCovers(db, v.run_id, rules)) continue;
    }
    await makeRun({ kind: "version", versionId: v.id }, { source: { kind: "artifact", objectKey: v.artifact_object_key }, contentSha256: v.content_sha256 ?? null }, rules);
    versions++;
    budget--;
  }
  return { proposals, versions };
}

// ── Admin lists ────────────────────────────────────────────────────────────────────────────────

export interface PolicyFlagRow {
  skillId: string;
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  semver: string;
  status: "flagged" | "noted";
  rules: { ruleId: string; title: string; scope: PolicyScope; dismissed: boolean }[];
  checkedAt: string | null;
}

/**
 * Active versions whose CURRENT run violates a currently ENFORCED rule at its current wording
 * (flagged / noted), or — with `shadow` — what each SHADOW rule would flag. `namespaceId` scopes to
 * one namespace. Platform admins and the namespace's own admins can see every skill of it.
 */
export async function listPolicyFlags(
  db: PolicyDb,
  opts: { namespaceId?: string | null; ruleId?: string | null; status?: "flagged" | "noted" | null; shadow?: boolean },
): Promise<PolicyFlagRow[]> {
  const { rows } = await db.query(
    `select sv.skill_id, sv.semver, r.completed_at, s.slug as skill_slug, s.title, n.slug as ns_slug,
            res.rule_id, res.revision_id, rv.title as rule_title, pr.scope,
            (select x.id from policy_rule_revisions x where x.rule_id = pr.id order by x.revision_no desc limit 1) as current_revision_id,
            exists (select 1 from policy_flag_dismissals d where d.skill_id = sv.skill_id and d.semver = sv.semver
                     and d.rule_id = res.rule_id and d.revision_id = res.revision_id) as dismissed
       from skill_versions sv
       join skills s on s.id = sv.skill_id and s.status = 'active'
       join namespaces n on n.id = s.namespace_id
       join lateral (select l.run_id from ai_prereview_links l where l.skill_version_id = sv.id order by l.id desc limit 1) cur on true
       join ai_prereviews r on r.id = cur.run_id and r.status = 'done'
       join ai_prereview_policy_results res on res.run_id = r.id and res.outcome = 'violates'
       join policy_rules pr on pr.id = res.rule_id
       join policy_rule_revisions rv on rv.id = res.revision_id
      where sv.status = 'active' and pr.state = $1
        and ($2::uuid is null or s.namespace_id = $2)
        and ($3::uuid is null or res.rule_id = $3)
      order by n.slug, s.slug, sv.semver`,
    [opts.shadow ? "shadow" : "enforced", opts.namespaceId ?? null, opts.ruleId ?? null],
  );
  const byVersion = new Map<string, PolicyFlagRow>();
  for (const r of rows) {
    if (r.revision_id !== r.current_revision_id) continue; // judged at an older wording — a re-check is queued
    const key = `${r.skill_id}|${r.semver}`;
    let row = byVersion.get(key);
    if (!row) {
      row = { skillId: r.skill_id, namespaceSlug: r.ns_slug, skillSlug: r.skill_slug, title: r.title, semver: r.semver, status: "noted", rules: [], checkedAt: iso(r.completed_at) };
      byVersion.set(key, row);
    }
    const dismissed = opts.shadow ? false : r.dismissed === true;
    row.rules.push({ ruleId: r.rule_id, title: r.rule_title, scope: r.scope, dismissed });
    if (!dismissed) row.status = "flagged";
  }
  const out = [...byVersion.values()];
  return opts.shadow || !opts.status ? out : out.filter((r) => r.status === opts.status);
}

/** Published versions currently flagged by an enforced rule (the gauge). */
export async function countPolicyFlaggedVersions(db: PolicyDb): Promise<number> {
  return (await listPolicyFlags(db, { status: "flagged" })).length;
}
