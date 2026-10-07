// Skill quality persistence (SKILLY_SPEC.md §41.6, §41.9): the `skill_version_quality` row, the
// denormalized `skills.quality_*` columns, the AI bookkeeping and the low-score notification.
// Shared by web (publish, re-assess, detail) and worker (mirror, the sweep). Plain SQL over a
// minimal query interface — no pg import, so the module stays dependency-free.
import { resolveLatest } from "./semver.js";
import {
  QUALITY_AI_MAX_ATTEMPTS, QUALITY_AI_RETRY_INTERVAL, QUALITY_AI_WEIGHT, QUALITY_LOW_THRESHOLD, QUALITY_RULES_WEIGHT,
  QUALITY_RULESET_VERSION, QUALITY_SCANNER, aiScoreOf, qualityFindings, qualityStars, scoreQuality,
  type QualityAiStatus, type QualityFindingLike, type QualityLevel, type QualityMode, type QualityVerdict,
} from "./quality-status.js";
import { coerceAiDisplayName } from "./ai-name.js";

export interface QualityDb {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/** One `skill_version_quality` row. */
export interface QualityRow {
  versionId: string;
  skillId: string;
  semver: string;
  ruleset: number;
  rulesScore: number;
  aiStatus: QualityAiStatus;
  aiScore: number | null;
  aiModel: string | null;
  aiVerdict: QualityVerdict | null;
  aiAttempts: number;
  aiLastError: string | null;
  finalScore: number;
  mode: QualityMode;
  scoredAt: string;
}

const ROW_COLUMNS = `q.skill_version_id, q.skill_id, sv.semver, q.ruleset, q.rules_score, q.ai_status, q.ai_score, q.ai_model, q.ai_verdict,
  q.ai_attempts, q.ai_last_error, q.final_score, q.mode, q.scored_at`;

function toRow(r: any): QualityRow {
  return {
    versionId: r.skill_version_id,
    skillId: r.skill_id,
    semver: r.semver,
    ruleset: Number(r.ruleset),
    rulesScore: Number(r.rules_score),
    aiStatus: r.ai_status,
    aiScore: r.ai_score === null || r.ai_score === undefined ? null : Number(r.ai_score),
    aiModel: r.ai_model ?? null,
    aiVerdict: (r.ai_verdict as QualityVerdict | null) ?? null,
    aiAttempts: Number(r.ai_attempts),
    aiLastError: r.ai_last_error ?? null,
    finalScore: Number(r.final_score),
    mode: r.mode,
    scoredAt: typeof r.scored_at === "string" ? r.scored_at : new Date(r.scored_at).toISOString(),
  };
}

export async function loadVersionQuality(db: QualityDb, versionId: string): Promise<QualityRow | null> {
  const { rows } = await db.query(
    `select ${ROW_COLUMNS} from skill_version_quality q join skill_versions sv on sv.id = q.skill_version_id where q.skill_version_id = $1`,
    [versionId],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** Every scored version of a skill, keyed by semver (the detail page's Versions list). */
export async function loadSkillQualityBySemver(db: QualityDb, skillId: string): Promise<Map<string, QualityRow>> {
  const { rows } = await db.query(
    `select ${ROW_COLUMNS} from skill_version_quality q join skill_versions sv on sv.id = q.skill_version_id where q.skill_id = $1`,
    [skillId],
  );
  return new Map(rows.map((r) => [r.semver as string, toRow(r)]));
}

/** The latest artifact-keyed scan report (the row the gate and the review page read). */
export async function latestArtifactFindings(db: QualityDb, artifactKey: string | null | undefined): Promise<{ reportId: string; findings: QualityFindingLike[] } | null> {
  if (!artifactKey) return null;
  const { rows } = await db.query(
    `select id, findings from scan_reports where subject_type = 'artifact' and subject_id = $1 order by created_at desc limit 1`,
    [artifactKey],
  );
  const r = rows[0];
  return r ? { reportId: r.id, findings: Array.isArray(r.findings) ? r.findings : [] } : null;
}

/**
 * Write (or rewrite) a version's rules part (§41.6). A rewrite — a ruleset bump or a re-assess —
 * drops the AI part so the blend is recomputed on the current rules, and clears the low-score
 * guard so a new assessment can notify again. Returns the rules score.
 */
export async function upsertQualityRules(
  db: QualityDb,
  input: { versionId: string; skillId: string; findings: QualityFindingLike[]; aiOn: boolean },
): Promise<number> {
  const rulesScore = scoreQuality(input.findings);
  await db.query(
    `insert into skill_version_quality
       (skill_version_id, skill_id, ruleset, rules_score, ai_status, final_score, mode)
     values ($1, $2, $3, $4, $5, $4, 'rules')
     on conflict (skill_version_id) do update
       set ruleset = excluded.ruleset, rules_score = excluded.rules_score, ai_status = excluded.ai_status,
           ai_score = null, ai_model = null, ai_verdict = null, ai_attempts = 0, ai_last_error = null, ai_next_attempt_at = null,
           final_score = excluded.rules_score, mode = 'rules', low_notified_at = null, rescore_requested_at = null,
           scored_at = now(), updated_at = now()`,
    [input.versionId, input.skillId, QUALITY_RULESET_VERSION, rulesScore, input.aiOn ? "pending" : "off"],
  );
  return rulesScore;
}

/** The AI verdict landed (§41.6): store it, blend, mark done. */
export async function recordQualityAiSuccess(db: QualityDb, versionId: string, verdict: QualityVerdict): Promise<void> {
  const ai = aiScoreOf(verdict);
  await db.query(
    `update skill_version_quality
        set ai_status = 'done', ai_score = $2::smallint, ai_model = $3, ai_verdict = $4::jsonb, ai_last_error = null, ai_next_attempt_at = null,
            ai_attempts = ai_attempts + 1,
            final_score = least(100, greatest(0, round(${QUALITY_RULES_WEIGHT} * rules_score + ${QUALITY_AI_WEIGHT} * $2::numeric)))::smallint,
            mode = 'rules+ai', updated_at = now()
      where skill_version_id = $1`,
    [versionId, ai, verdict.model, JSON.stringify(verdict)],
  );
}

/** An attempt that reached the provider failed (§41.5): retry after an hour, give up after three. */
export async function recordQualityAiFailure(db: QualityDb, versionId: string, error: string): Promise<QualityAiStatus> {
  const { rows } = await db.query(
    `update skill_version_quality
        set ai_attempts = ai_attempts + 1,
            ai_last_error = $2,
            ai_status = case when ai_attempts + 1 >= $3 then 'failed' else 'pending' end,
            ai_next_attempt_at = case when ai_attempts + 1 >= $3 then null else now() + $4::interval end,
            updated_at = now()
      where skill_version_id = $1
      returning ai_status`,
    [versionId, error.slice(0, 300), QUALITY_AI_MAX_ATTEMPTS, QUALITY_AI_RETRY_INTERVAL],
  );
  return (rows[0]?.ai_status as QualityAiStatus | undefined) ?? "failed";
}

/** AI became available: queue every `off` row again (the sweep then picks latest versions, §41.6). */
export async function requeueQualityAi(db: QualityDb): Promise<number> {
  const r = await db.query(`update skill_version_quality set ai_status = 'pending', updated_at = now() where ai_status = 'off'`);
  return r.rowCount ?? 0;
}

/**
 * Recompute `skills.quality_score` / `quality_mode` from the latest stable active version (§41.6).
 * The only writer of those two columns. Null when the skill has no scored latest version.
 */
export async function refreshSkillQuality(db: QualityDb, skillId: string): Promise<void> {
  const { rows } = await db.query(
    `select sv.id, sv.semver from skill_versions sv where sv.skill_id = $1 and sv.status = 'active' and not sv.is_prerelease`,
    [skillId],
  );
  const latest = resolveLatest(rows.map((r) => r.semver as string));
  const versionId = rows.find((r) => r.semver === latest)?.id as string | undefined;
  const q = versionId
    ? (await db.query(`select final_score, mode from skill_version_quality where skill_version_id = $1`, [versionId])).rows[0]
    : undefined;
  await db.query(`update skills set quality_score = $2, quality_mode = $3 where id = $1`, [skillId, q?.final_score ?? null, q?.mode ?? null]);
}

export interface QualityLowPayloadFinding { rule: string; level: QualityLevel | null; path: string | null; line: number | null; message: string }

/** The §40.14 AI display name as stored in `platform_settings` (default "AI"). */
export async function loadAiDisplayName(db: QualityDb): Promise<string> {
  const { rows } = await db.query(`select value from platform_settings where key = 'ai_display_name'`);
  return coerceAiDisplayName(rows[0]?.value);
}

/**
 * §41.9: once a version's assessment has settled at 2 stars or below, notify the effective
 * maintainers (minus opt-outs) with the full findings and the AI recommendations. Once per
 * assessment: `low_notified_at` is set here and cleared only by a rewrite of the rules part.
 * `aiOn` (AI operational at settle time) together with a hosted skill adds the §44.9 draft CTA;
 * the §40.14 display name is captured into the payload. Returns true when a notification was created.
 */
export async function settleQualityLow(
  db: QualityDb,
  versionId: string,
  findingsSource?: QualityFindingLike[],
  opts: { aiOn?: boolean } = {},
): Promise<boolean> {
  const { rows } = await db.query(
    `select q.skill_id, q.final_score, q.mode, q.ai_status, q.ai_verdict, sv.semver, sv.artifact_object_key,
            s.namespace_id, s.slug as skill_slug, s.type as skill_type, n.slug as ns_slug
       from skill_version_quality q
       join skill_versions sv on sv.id = q.skill_version_id
       join skills s on s.id = q.skill_id
       join namespaces n on n.id = s.namespace_id
      where q.skill_version_id = $1 and q.low_notified_at is null and q.final_score < $2
        and q.ai_status in ('done', 'failed', 'off')`,
    [versionId, QUALITY_LOW_THRESHOLD],
  );
  const r = rows[0];
  if (!r) return false;
  const findings = findingsSource ?? (await latestArtifactFindings(db, r.artifact_object_key))?.findings ?? [];
  const list: QualityLowPayloadFinding[] = qualityFindings(findings).slice(0, 50).map((f) => ({
    rule: f.rule,
    level: f.level ?? null,
    path: f.path ?? null,
    line: f.line ?? null,
    message: f.message ?? "",
  }));
  const verdict = (r.ai_verdict as QualityVerdict | null) ?? null;
  const payload = {
    namespaceSlug: r.ns_slug,
    skillSlug: r.skill_slug,
    semver: r.semver,
    score: Number(r.final_score),
    stars: qualityStars(Number(r.final_score)),
    mode: r.mode,
    findings: list,
    summary: verdict?.summary ?? null,
    suggestions: verdict?.suggestions ?? [],
    aiName: await loadAiDisplayName(db),
    aiDraft: opts.aiOn === true && r.skill_type === "hosted",
  };
  // Claim first so two processes can never notify twice for one assessment.
  const claim = await db.query(
    `update skill_version_quality set low_notified_at = now() where skill_version_id = $1 and low_notified_at is null`,
    [versionId],
  );
  if (!claim.rowCount) return false;
  // Same recipient set as skill.content_risk (explicit maintainers ∪ namespace admins), filtered by
  // the §41.9 opt-out at insert time — an opted-out user gets no row at all.
  await db.query(
    `insert into notifications (user_id, type, payload)
     select uid, 'skill.quality_low', $2::jsonb
       from (
         select sm.user_id as uid from skill_maintainers sm where sm.skill_id = $1
         union
         select gm.user_id
           from role_mappings rm
           join group_memberships gm on gm.group_id = rm.group_id
          where rm.namespace_id = $3 and rm.role = 'namespace_admin'
       ) recipients
       join users u on u.id = recipients.uid and u.status = 'active' and u.quality_notifications`,
    [r.skill_id, JSON.stringify(payload), r.namespace_id],
  );
  return true;
}

/** Maintenance line counts (§41.7). */
export async function qualityProgress(db: QualityDb): Promise<{ active: number; scored: number; aiDone: number; aiFailed: number; aiPending: number; ruleset: number }> {
  const { rows } = await db.query(
    `select count(*)::text as active,
            count(q.skill_version_id) filter (where q.ruleset = $1 and q.rescore_requested_at is null)::text as scored,
            count(q.skill_version_id) filter (where q.ai_status = 'done')::text as ai_done,
            count(q.skill_version_id) filter (where q.ai_status = 'failed')::text as ai_failed,
            count(q.skill_version_id) filter (where q.ai_status = 'pending')::text as ai_pending
       from skill_versions sv
       join skills s on s.id = sv.skill_id and s.status = 'active'
       left join skill_version_quality q on q.skill_version_id = sv.id
      where sv.status = 'active' and sv.artifact_object_key is not null`,
    [QUALITY_RULESET_VERSION],
  );
  const r = rows[0] ?? {};
  return {
    active: Number(r.active ?? 0),
    scored: Number(r.scored ?? 0),
    aiDone: Number(r.ai_done ?? 0),
    aiFailed: Number(r.ai_failed ?? 0),
    aiPending: Number(r.ai_pending ?? 0),
    ruleset: QUALITY_RULESET_VERSION,
  };
}

/** "Re-run quality assessment" (§41.7): mark every scored row stale; the sweep re-scans them. */
export async function requestQualityRescore(db: QualityDb): Promise<number> {
  const r = await db.query(`update skill_version_quality set rescore_requested_at = now(), updated_at = now() where rescore_requested_at is null`);
  return r.rowCount ?? 0;
}

/**
 * The marker filter a report must satisfy to count as scanned at the current ruleset — the
 * jsonb `@>` argument the sweep and the progress line share.
 */
export function qualityMarkerFilter(): string {
  return JSON.stringify([{ scanner: QUALITY_SCANNER, rule: "qa-scanned", ruleset: QUALITY_RULESET_VERSION }]);
}
