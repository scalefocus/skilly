// AI pre-review persistence (SKILLY_SPEC.md §46.2–§46.11): the switch, runs, links to subjects,
// dispositions, the per-subject view and the skill.ai_prereview_flagged notification. Shared by web
// (proposal page, owner card, re-run, dispositions, the admin row) and worker (the sweep, MCP
// get_proposal). Plain SQL over a minimal query interface; no pg import, no node.
import { coerceAiDisplayName } from "./ai-name.js";
import {
  PREREVIEW_CATEGORY_INFO, PREREVIEW_REASON_MAX, isFlaggingSeverity, latestDispositions, prereviewMismatch,
  type DispositionRow, type PrereviewCategory, type PrereviewDisposition, type PrereviewCoverageEntry, type PrereviewResult, type PrereviewRunStatus,
  type PrereviewRunView, type PrereviewSeverity, type PrereviewVerdict, type PrereviewView,
} from "./ai-prereview.js";

export interface PrereviewDb {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/** The prompt version runs are stamped with — duplicated here (not imported from the node-only
 *  run module) so this file stays importable anywhere. A unit test pins the two equal. */
export const PREREVIEW_DB_PROMPT_VERSION = 2;
export const PREREVIEW_SETTING_KEY = "ai_prereview_enabled";
/** Automatic (non-cached, non-re-run) runs per proposal per rolling 24 h (§46.3). */
export const PREREVIEW_PROPOSAL_DAILY_CAP = 10;
/** Attempts per run, and their spacing (§46.5). */
export const PREREVIEW_MAX_ATTEMPTS = 3;
export const PREREVIEW_RETRY_INTERVAL = "5 minutes";
export const PREREVIEW_OPEN_STATES = ["proposed", "under_review", "changes_requested"] as const;

/** Where a run's bytes come from. Never credentials. */
export type PrereviewSource =
  | { kind: "artifact"; objectKey: string }
  | { kind: "pointer"; url: string; ref: string; subdir: string | null; slug: string };

export type PrereviewSubject = { kind: "proposal"; proposalId: string; revision: number } | { kind: "version"; versionId: string };

export type PrereviewTrigger = "submit" | "revision" | "enable" | "direct_publish" | "mirror" | "rerun" | "policy";

// ── The switch (§46.2) ─────────────────────────────────────────────────────────────────────────

export interface PrereviewSetting {
  enabled: boolean;
  /** When the switch was last turned on — direct publishes before it are never reviewed. */
  since: string | null;
}

export function coercePrereviewSetting(v: unknown): PrereviewSetting {
  if (v === true) return { enabled: true, since: null };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return { enabled: o.enabled === true, since: typeof o.since === "string" ? o.since : null };
  }
  return { enabled: false, since: null };
}

export async function loadPrereviewSetting(db: PrereviewDb): Promise<PrereviewSetting> {
  const { rows } = await db.query(`select value from platform_settings where key = $1`, [PREREVIEW_SETTING_KEY]);
  return coercePrereviewSetting(rows[0]?.value);
}

/** Turn the switch on or off. Turning it on stamps `since`. Returns whether anything changed. */
export async function savePrereviewSetting(db: PrereviewDb, enabled: boolean, userId: string | null): Promise<{ changed: boolean; before: boolean }> {
  const before = await loadPrereviewSetting(db);
  if (before.enabled === enabled) return { changed: false, before: before.enabled };
  const value = enabled ? { enabled: true, since: new Date().toISOString() } : { enabled: false, since: before.since };
  await db.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [PREREVIEW_SETTING_KEY, JSON.stringify(value), userId],
  );
  return { changed: true, before: before.enabled };
}

// ── Runs & links ───────────────────────────────────────────────────────────────────────────────

export interface PrereviewRunRow {
  id: string;
  status: PrereviewRunStatus;
  contentSha256: string | null;
  promptVersion: number;
  /** §47.2: the fingerprint of the policy-rule revisions judged (null: none applied). */
  rulesFingerprint: string | null;
  source: PrereviewSource;
  trigger: PrereviewTrigger;
  requestedBy: string | null;
  attempts: number;
  lastError: string | null;
  model: string | null;
  result: PrereviewResult | null;
  coverage: PrereviewCoverageEntry[] | null;
  maxSeverity: PrereviewSeverity | null;
  createdAt: string;
  completedAt: string | null;
}

const RUN_COLUMNS = `r.id, r.status, r.content_sha256, r.prompt_version, r.rules_fingerprint, r.source, r.trigger, r.requested_by, r.attempts, r.last_error,
  r.model, r.result, r.coverage, r.max_severity, r.created_at, r.completed_at`;

function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

export function toRunRow(r: any): PrereviewRunRow {
  return {
    id: r.id,
    status: r.status,
    contentSha256: r.content_sha256 ?? null,
    promptVersion: Number(r.prompt_version),
    rulesFingerprint: r.rules_fingerprint ?? null,
    source: r.source,
    trigger: r.trigger,
    requestedBy: r.requested_by ?? null,
    attempts: Number(r.attempts ?? 0),
    lastError: r.last_error ?? null,
    model: r.model ?? null,
    result: (r.result as PrereviewResult | null) ?? null,
    coverage: (r.coverage as PrereviewCoverageEntry[] | null) ?? null,
    maxSeverity: r.max_severity ?? null,
    createdAt: iso(r.created_at)!,
    completedAt: iso(r.completed_at),
  };
}

export async function createPrereviewRun(
  db: PrereviewDb,
  input: { source: PrereviewSource; contentSha256: string | null; trigger: PrereviewTrigger; requestedBy?: string | null; rulesFingerprint?: string | null },
): Promise<string> {
  const { rows } = await db.query(
    `insert into ai_prereviews (content_sha256, prompt_version, source, trigger, requested_by, rules_fingerprint)
     values ($1, $2, $3::jsonb, $4, $5, $6) returning id`,
    [input.contentSha256, PREREVIEW_DB_PROMPT_VERSION, JSON.stringify(input.source), input.trigger, input.requestedBy ?? null, input.rulesFingerprint ?? null],
  );
  return rows[0].id as string;
}

export async function linkPrereviewRun(db: PrereviewDb, runId: string, subject: PrereviewSubject, cached: boolean): Promise<void> {
  if (subject.kind === "proposal") {
    await db.query(`insert into ai_prereview_links (run_id, proposal_id, revision, cached) values ($1, $2, $3, $4)`, [runId, subject.proposalId, subject.revision, cached]);
  } else {
    await db.query(`insert into ai_prereview_links (run_id, skill_version_id, cached) values ($1, $2, $3)`, [runId, subject.versionId, cached]);
  }
}

/**
 * A run that can be reused for these bytes: pending or done, at the current prompt version (§46.4),
 * judged against exactly the same policy-rule revisions (§47.5 — `rulesFingerprint` null means "no
 * rule applies" and only matches runs that judged none).
 */
export async function findReusableRun(
  db: PrereviewDb,
  contentSha256: string | null | undefined,
  rulesFingerprint: string | null,
  excludeRunId?: string,
): Promise<PrereviewRunRow | null> {
  if (!contentSha256) return null;
  const { rows } = await db.query(
    `select ${RUN_COLUMNS} from ai_prereviews r
      where r.content_sha256 = $1 and r.prompt_version = $2 and r.status in ('pending', 'done')
        and r.rules_fingerprint is not distinct from $4
        and ($3::uuid is null or r.id <> $3::uuid)
      order by (r.status = 'done') desc, r.created_at desc limit 1`,
    [contentSha256, PREREVIEW_DB_PROMPT_VERSION, excludeRunId ?? null, rulesFingerprint],
  );
  return rows[0] ? toRunRow(rows[0]) : null;
}

/** The subject's current run: its newest link. */
export async function currentPrereviewRun(db: PrereviewDb, subject: PrereviewSubject): Promise<PrereviewRunRow | null> {
  const { rows } =
    subject.kind === "proposal"
      ? await db.query(
          `select ${RUN_COLUMNS} from ai_prereview_links l join ai_prereviews r on r.id = l.run_id
            where l.proposal_id = $1 and l.revision = $2 order by l.id desc limit 1`,
          [subject.proposalId, subject.revision],
        )
      : await db.query(
          `select ${RUN_COLUMNS} from ai_prereview_links l join ai_prereviews r on r.id = l.run_id
            where l.skill_version_id = $1 order by l.id desc limit 1`,
          [subject.versionId],
        );
  return rows[0] ? toRunRow(rows[0]) : null;
}

/** Automatic runs started for a proposal in the last 24 h — the §46.3 cap counts these. */
export async function proposalAutoRunsLast24h(db: PrereviewDb, proposalId: string): Promise<number> {
  const { rows } = await db.query(
    `select count(*)::int as n from ai_prereview_links l join ai_prereviews r on r.id = l.run_id
      where l.proposal_id = $1 and not l.cached and r.trigger <> 'rerun' and l.created_at > now() - interval '24 hours'`,
    [proposalId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** The bytes a proposal revision proposes (§46.3): its artifact (hosted or Keep current files), else its pointer. */
export function prereviewSourceOfPayload(payload: unknown): { source: PrereviewSource; contentSha256: string | null } | null {
  const p = (payload ?? {}) as Record<string, any>;
  if (typeof p.artifactObjectKey === "string" && p.artifactObjectKey) {
    return { source: { kind: "artifact", objectKey: p.artifactObjectKey }, contentSha256: typeof p.contentSha256 === "string" && p.contentSha256 ? p.contentSha256 : null };
  }
  const ptr = p.pointer;
  if (ptr && typeof ptr.url === "string" && typeof ptr.ref === "string" && ptr.ref) {
    const slug = typeof p.metadata?.skillSlug === "string" ? p.metadata.skillSlug : "";
    return { source: { kind: "pointer", url: ptr.url, ref: ptr.ref, subdir: typeof ptr.subdir === "string" && ptr.subdir.trim() ? ptr.subdir : null, slug }, contentSha256: null };
  }
  return null;
}

export function samePrereviewSource(a: PrereviewSource, b: PrereviewSource): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "artifact" && b.kind === "artifact") return a.objectKey === b.objectKey;
  if (a.kind === "pointer" && b.kind === "pointer") return a.url === b.url && a.ref === b.ref && (a.subdir ?? null) === (b.subdir ?? null);
  return false;
}

// ── Worker bookkeeping ─────────────────────────────────────────────────────────────────────────

/** One §47 per-rule result as stored with a run. */
export interface PrereviewPolicyResultRow {
  ruleId: string;
  revisionId: string;
  ruleState: "shadow" | "enforced";
  outcome: string;
  explanation: string;
  evidence: unknown[];
  evidenceRejected: boolean;
}

/**
 * Store a finished run. The §47 policy results go in FIRST (any left by an earlier failed attempt
 * are replaced) and the `done` flip is last, so a run is never `done` with missing results: a
 * failure part-way leaves it `pending` for an ordinary retry.
 */
export async function recordPrereviewSuccess(
  db: PrereviewDb,
  runId: string,
  input: {
    result: PrereviewResult;
    coverage: PrereviewCoverageEntry[];
    model: string | null;
    contentSha256: string;
    maxSeverity: PrereviewSeverity | null;
    policy?: { fingerprint: string | null; results: readonly PrereviewPolicyResultRow[] };
  },
): Promise<void> {
  await db.query(`delete from ai_prereview_policy_results where run_id = $1`, [runId]);
  for (const r of input.policy?.results ?? []) {
    await db.query(
      `insert into ai_prereview_policy_results (run_id, rule_id, revision_id, rule_state, outcome, explanation, evidence, evidence_rejected)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [runId, r.ruleId, r.revisionId, r.ruleState, r.outcome, r.explanation.slice(0, 700), JSON.stringify(r.evidence), r.evidenceRejected],
    );
  }
  await db.query(
    `update ai_prereviews
        set status = 'done', result = $2::jsonb, coverage = $3::jsonb, model = $4, content_sha256 = coalesce(content_sha256, $5),
            max_severity = $6, last_error = null, next_attempt_at = null, completed_at = now(),
            rules_fingerprint = case when $7::boolean then $8 else rules_fingerprint end
      where id = $1`,
    [runId, JSON.stringify(input.result), JSON.stringify(input.coverage), input.model, input.contentSha256, input.maxSeverity, input.policy !== undefined, input.policy?.fingerprint ?? null],
  );
}

/** Copy a finished run's result into this one (identical bytes found after a pointer clone, §46.4). */
export async function copyPrereviewResult(db: PrereviewDb, runId: string, from: PrereviewRunRow, contentSha256: string): Promise<void> {
  // The §47 per-rule results travel with the copy (the cache only matches identical rule sets).
  await db.query(`delete from ai_prereview_policy_results where run_id = $1`, [runId]);
  await db.query(
    `insert into ai_prereview_policy_results (run_id, rule_id, revision_id, rule_state, outcome, explanation, evidence, evidence_rejected)
     select $1, rule_id, revision_id, rule_state, outcome, explanation, evidence, evidence_rejected
       from ai_prereview_policy_results where run_id = $2`,
    [runId, from.id],
  );
  await db.query(
    `update ai_prereviews
        set status = 'done', result = $2::jsonb, coverage = $3::jsonb, model = $4, content_sha256 = $5, max_severity = $6,
            rules_fingerprint = $7, last_error = null, next_attempt_at = null, completed_at = now()
      where id = $1`,
    [runId, JSON.stringify(from.result), JSON.stringify(from.coverage ?? []), from.model, contentSha256, from.maxSeverity, from.rulesFingerprint],
  );
}

/** An attempt failed: retry after 5 minutes, give up after three (§46.5). */
export async function recordPrereviewFailure(db: PrereviewDb, runId: string, error: string, opts: { contentSha256?: string | null } = {}): Promise<PrereviewRunStatus> {
  const { rows } = await db.query(
    `update ai_prereviews
        set attempts = attempts + 1,
            last_error = $2,
            content_sha256 = coalesce(content_sha256, $5),
            status = case when attempts + 1 >= $3 then 'failed' else 'pending' end,
            next_attempt_at = case when attempts + 1 >= $3 then null else now() + $4::interval end,
            completed_at = case when attempts + 1 >= $3 then now() else null end
      where id = $1
      returning status`,
    [runId, error.replace(/\s+/g, " ").trim().slice(0, 300), PREREVIEW_MAX_ATTEMPTS, PREREVIEW_RETRY_INTERVAL, opts.contentSha256 ?? null],
  );
  return (rows[0]?.status as PrereviewRunStatus | undefined) ?? "failed";
}

/** Due runs, proposal-linked first, then version-linked, oldest first (§46.5). */
export async function duePrereviewRuns(db: PrereviewDb, limit: number): Promise<PrereviewRunRow[]> {
  const { rows } = await db.query(
    `select ${RUN_COLUMNS},
            exists (select 1 from ai_prereview_links l where l.run_id = r.id and l.proposal_id is not null) as for_proposal
       from ai_prereviews r
      where r.status = 'pending' and (r.next_attempt_at is null or r.next_attempt_at <= now())
        -- Still worth a call: linked to an open proposal or to a published version.
        and exists (
          select 1 from ai_prereview_links l left join proposals p on p.id = l.proposal_id
           where l.run_id = r.id and (l.skill_version_id is not null or p.state::text in ('proposed', 'under_review', 'changes_requested')))
      order by for_proposal desc, r.created_at asc
      limit $1`,
    [limit],
  );
  return rows.map(toRunRow);
}

// ── Notification (§46.10) ──────────────────────────────────────────────────────────────────────

/**
 * A run with a high or critical finding is done: notify the namespace admins of every published
 * version it covers that no reviewer saw this result for (`ai_prereview_notified_at` null), once
 * per version. `onlyVersionId` restricts it to one version (a version just linked to an
 * already-finished run). Returns how many versions notified.
 */
export async function settlePrereviewNotification(db: PrereviewDb, runId: string, onlyVersionId?: string): Promise<number> {
  const { rows } = await db.query(
    `select l.skill_version_id, sv.semver, sv.created_by, s.id as skill_id, s.slug as skill_slug, s.namespace_id, n.slug as ns_slug,
            r.result, r.requested_by
       from ai_prereview_links l
       join ai_prereviews r on r.id = l.run_id
       join skill_versions sv on sv.id = l.skill_version_id
       join skills s on s.id = sv.skill_id
       join namespaces n on n.id = s.namespace_id
      where l.run_id = $1 and r.status = 'done' and r.max_severity in ('high', 'critical')
        and sv.ai_prereview_notified_at is null
        and ($2::uuid is null or l.skill_version_id = $2::uuid)`,
    [runId, onlyVersionId ?? null],
  );
  if (rows.length === 0) return 0;
  const aiName = coerceAiDisplayName((await db.query(`select value from platform_settings where key = 'ai_display_name'`)).rows[0]?.value);
  let notified = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.skill_version_id)) continue;
    seen.add(r.skill_version_id);
    const findings = ((r.result as PrereviewResult | null)?.findings ?? []).filter((f) => isFlaggingSeverity(f.severity));
    const categories = [...new Set(findings.map((f) => f.category))] as PrereviewCategory[];
    const claim = await db.query(
      `update skill_versions set ai_prereview_notified_at = now() where id = $1 and ai_prereview_notified_at is null`,
      [r.skill_version_id],
    );
    if (!claim.rowCount) continue;
    const payload = {
      namespaceSlug: r.ns_slug,
      skillSlug: r.skill_slug,
      semver: r.semver,
      count: findings.length,
      categories: categories.map((c) => PREREVIEW_CATEGORY_INFO[c]?.label ?? c),
      aiName,
    };
    // The namespace's admins, minus the publisher and the re-run requester, minus opt-outs (§46.10).
    await db.query(
      `insert into notifications (user_id, type, payload)
       select distinct gm.user_id, 'skill.ai_prereview_flagged', $2::jsonb
         from role_mappings rm
         join group_memberships gm on gm.group_id = rm.group_id
         join users u on u.id = gm.user_id and u.status = 'active' and u.ai_prereview_notifications
        where rm.namespace_id = $1 and rm.role = 'namespace_admin'
          and gm.user_id is distinct from $3::uuid and gm.user_id is distinct from $4::uuid`,
      [r.namespace_id, JSON.stringify(payload), r.created_by ?? null, r.requested_by ?? null],
    );
    notified++;
  }
  return notified;
}

// ── Dispositions (§46.7) ───────────────────────────────────────────────────────────────────────

export type DispositionTarget = { proposalId: string } | { versionId: string };

export async function insertPrereviewDisposition(
  db: PrereviewDb,
  input: { target: DispositionTarget; fingerprint: string; verdict: PrereviewVerdict; reason: string | null; userId: string },
): Promise<void> {
  const reason = input.reason?.trim() ? input.reason.trim().slice(0, PREREVIEW_REASON_MAX) : null;
  const t = input.target;
  await db.query(
    `insert into ai_prereview_dispositions (proposal_id, skill_version_id, fingerprint, verdict, reason, decided_by)
     values ($1, $2, $3, $4, $5, $6)`,
    ["proposalId" in t ? t.proposalId : null, "versionId" in t ? t.versionId : null, input.fingerprint, input.verdict, reason, input.userId],
  );
}

async function dispositionRows(db: PrereviewDb, proposalIds: string[], versionId: string | null): Promise<DispositionRow[]> {
  if (proposalIds.length === 0 && !versionId) return [];
  const { rows } = await db.query(
    `select d.fingerprint, d.verdict, d.reason, d.decided_at, u.display_name as by_name
       from ai_prereview_dispositions d left join users u on u.id = d.decided_by
      where d.proposal_id = any($1::uuid[]) or ($2::uuid is not null and d.skill_version_id = $2::uuid)`,
    [proposalIds, versionId],
  );
  return rows.map((r) => ({ fingerprint: r.fingerprint, verdict: r.verdict, reason: r.reason ?? null, by: r.by_name ?? null, at: iso(r.decided_at)! }));
}

/**
 * The accepted proposal a version was materialized from, if any: the materialized link for a
 * hosted accept, else (a pointer, mirrored after accept) the accepted proposal for the same
 * namespace, slug and semver.
 */
export async function sourceProposalOfVersion(db: PrereviewDb, versionId: string): Promise<string | null> {
  const { rows } = await db.query(
    `select p.id
       from skill_versions sv
       join skills s on s.id = sv.skill_id
       join proposals p on p.state = 'accepted'
        and (p.materialized_version_id = sv.id
             or (p.materialized_version_id is null and p.target_namespace_id = s.namespace_id and p.proposed_semver = sv.semver
                 and (p.target_skill_id = s.id or exists (
                   select 1 from proposal_revisions pr where pr.proposal_id = p.id and pr.payload->'metadata'->>'skillSlug' = s.slug))))
      where sv.id = $1
      order by (p.materialized_version_id = sv.id) desc nulls last, p.updated_at desc
      limit 1`,
    [versionId],
  );
  return rows[0]?.id ?? null;
}

// ── The view (§46.8, §46.11) ───────────────────────────────────────────────────────────────────

function runView(run: PrereviewRunRow, disp: Map<string, PrereviewDisposition>): PrereviewRunView {
  const findings = (run.result?.findings ?? []).map((f) => ({ ...f, disposition: disp.get(f.fingerprint) ?? null }));
  return {
    status: run.status,
    trigger: run.trigger,
    model: run.model,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    lastError: run.lastError,
    summary: run.result?.summary ?? null,
    findings,
    discarded: run.result?.discarded ?? 0,
    coverage: run.coverage ?? [],
    maxSeverity: run.maxSeverity,
  };
}

export interface PrereviewViewInput {
  subject: PrereviewSubject;
  /** The subject's deterministic scan findings, for the mismatch warning. */
  scanFindings: readonly { scanner?: string; rule?: string; path?: string }[];
  /** `aiAvailable()` right now. */
  aiOn: boolean;
  /** The viewer holds the override authority (re-run, dispositions). */
  canAct: boolean;
  /** Re-run and dispositions are offered on open proposals only (versions: always). */
  open: boolean;
}

/** Everything a section or the owner card shows for one subject. */
export async function loadPrereviewView(db: PrereviewDb, input: PrereviewViewInput): Promise<PrereviewView> {
  const { subject } = input;
  const setting = await loadPrereviewSetting(db);
  const effective = setting.enabled && input.aiOn;
  const cur = await currentPrereviewRun(db, subject);

  const proposalIds: string[] = [];
  let versionId: string | null = null;
  if (subject.kind === "proposal") proposalIds.push(subject.proposalId);
  else {
    versionId = subject.versionId;
    const src = await sourceProposalOfVersion(db, subject.versionId);
    if (src) proposalIds.push(src);
  }
  const disp = latestDispositions(await dispositionRows(db, proposalIds, versionId));

  let status: PrereviewView["status"];
  if (cur) status = cur.status;
  else if (subject.kind === "version") status = "none";
  else if (!setting.enabled) status = "off";
  else if (!input.aiOn) status = "unavailable";
  else if ((await proposalAutoRunsLast24h(db, subject.proposalId)) >= PREREVIEW_PROPOSAL_DAILY_CAP) status = "skipped";
  else status = "pending"; // the worker links it on its next pass

  let previous: PrereviewView["previous"] = null;
  if (subject.kind === "proposal" && (!cur || cur.status === "pending")) {
    const { rows } = await db.query(
      `select ${RUN_COLUMNS}, l.revision as link_revision from ai_prereview_links l join ai_prereviews r on r.id = l.run_id
        where l.proposal_id = $1 and l.revision < $2 and r.status = 'done'
        order by l.revision desc, l.id desc limit 1`,
      [subject.proposalId, subject.revision],
    );
    if (rows[0]) previous = { ...runView(toRunRow(rows[0]), disp), revision: Number(rows[0].link_revision) };
  }

  const run = cur ? runView(cur, disp) : null;
  return {
    status,
    run,
    previous,
    mismatch: prereviewMismatch(run, input.scanFindings),
    canRerun: input.canAct && input.open && effective && status !== "pending",
    canDisposition: input.canAct && input.open && !!run && run.status === "done",
  };
}

// ── Re-run (§46.11) ────────────────────────────────────────────────────────────────────────────

export type RerunResult = { ok: true; runId: string } | { ok: false; code: "already_pending" | "no_source" };

/**
 * Queue a fresh run for a subject, bypassing the cache. The source is the current run's, else
 * `fallback` (the revision's payload or the version's artifact). The caller checks authority,
 * effectiveness and the rate limit, and audits.
 */
export async function requestPrereviewRerun(
  db: PrereviewDb,
  subject: PrereviewSubject,
  userId: string,
  fallback: { source: PrereviewSource; contentSha256: string | null } | null,
): Promise<RerunResult> {
  const cur = await currentPrereviewRun(db, subject);
  if (cur?.status === "pending") return { ok: false, code: "already_pending" };
  const src = cur ? { source: cur.source, contentSha256: cur.contentSha256 } : fallback;
  if (!src) return { ok: false, code: "no_source" };
  const runId = await createPrereviewRun(db, { source: src.source, contentSha256: src.contentSha256, trigger: "rerun", requestedBy: userId });
  await linkPrereviewRun(db, runId, subject, false);
  return { ok: true, runId };
}

// ── Admin counts (§46.2) ───────────────────────────────────────────────────────────────────────

export async function prereviewCounts(db: PrereviewDb): Promise<{ pending: number; failed24h: number }> {
  const { rows } = await db.query(
    `select count(*) filter (where status = 'pending')::int as pending,
            count(*) filter (where status = 'failed' and completed_at > now() - interval '24 hours')::int as failed
       from ai_prereviews`,
  );
  return { pending: Number(rows[0]?.pending ?? 0), failed24h: Number(rows[0]?.failed ?? 0) };
}

/** Housekeeping (§46.9): runs no subject links any more, older than a day. */
export async function pruneOrphanPrereviews(db: PrereviewDb): Promise<number> {
  const r = await db.query(
    `delete from ai_prereviews r
      where r.created_at < now() - interval '1 day'
        and not exists (select 1 from ai_prereview_links l where l.run_id = r.id)`,
  );
  return r.rowCount ?? 0;
}
