// Skill quality on the web side (SKILLY_SPEC.md §41): the publish-time write, the detail payload,
// the per-version re-assess, the Maintenance progress line and the catalog-wide rescore. The
// scanner and the score maths are in @skilly/shared; rows are written through the shared
// quality-db helpers so web and worker agree byte-for-byte.
import type { Pool, PoolClient } from "pg";
import {
  canReviewNamespace, qualityScanner, maxSeverity, qualityFindings, qualityStars, qualityRulesetOf, scoreQuality,
  latestArtifactFindings, upsertQualityRules, refreshSkillQuality, settleQualityLow, loadVersionQuality,
  loadSkillQualityBySemver, qualityProgress as sharedQualityProgress, requestQualityRescore, QUALITY_SCANNER,
  QUALITY_RULESET_VERSION, bundleContentCap,
  type EffectiveAccess, type ScanFinding, type QualityRow, type QualityVerdict, type QualityLevel, type QualityMode, type QualityAiStatus,
} from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { aiAvailable } from "./ai";
import { s3ArtifactStore, type ArtifactStore } from "./objectStore";
import { extractBundle } from "./bundle";
import { getMaxBundleBytes } from "./settings";

type Db = Pool | PoolClient;

/** The skill-level summary every catalog surface carries (§41.11). */
export interface QualitySummary { score: number; stars: number; mode: QualityMode; scoredAt?: string }

/** One finding as the API serves it (§41.11). */
export interface QualityFindingView { rule: string; level: QualityLevel | null; path: string | null; line: number | null; message: string; excerpt: string | null }

/** The detail payload for one version (§41.11). */
export interface QualityDetail {
  semver: string;
  ruleset: number;
  rulesScore: number;
  aiStatus: QualityAiStatus;
  aiScore: number | null;
  aiModel: string | null;
  finalScore: number;
  stars: number;
  mode: QualityMode;
  scoredAt: string;
  findings: QualityFindingView[];
  verdict: QualityVerdict | null;
  canReassess: boolean;
}

export function qualityFindingViews(findings: ScanFinding[]): QualityFindingView[] {
  return qualityFindings(findings).map((f) => ({
    rule: f.rule,
    level: f.level ?? null,
    path: f.path ?? null,
    line: f.line ?? null,
    message: f.message,
    excerpt: f.excerpt ?? null,
  }));
}

/** A proposal's rules-only quality, computed on read from its report (§41.3). Null when the quality scanner never ran. */
export function proposalQuality(findings: unknown): { rulesScore: number; stars: number; findings: QualityFindingView[] } | null {
  const list = Array.isArray(findings) ? (findings as ScanFinding[]) : [];
  if (qualityRulesetOf(list) === null) return null;
  const rulesScore = scoreQuality(list);
  return { rulesScore, stars: qualityStars(rulesScore), findings: qualityFindingViews(list) };
}

/**
 * Publish-time write (§41.6): score the version from its artifact's latest report, refresh the
 * skill columns, and — when no AI judgement is coming — settle the low-score notification now.
 * Advisory: the caller wraps it so a quality failure never fails a publish.
 */
export async function writeQualityForVersion(db: Db, input: { versionId: string; skillId: string; artifactKey: string | null }): Promise<void> {
  const report = await latestArtifactFindings(db, input.artifactKey);
  if (!report || qualityRulesetOf(report.findings) === null) return; // the sweep will score it
  const aiOn = await aiAvailable();
  await upsertQualityRules(db, { versionId: input.versionId, skillId: input.skillId, findings: report.findings, aiOn });
  await refreshSkillQuality(db, input.skillId);
  if (!aiOn) await settleQualityLow(db, input.versionId, report.findings);
}

/** `refreshSkillQuality` on the web pool — after yank / restore / archive / un-archive. */
export async function refreshSkillQualityColumns(skillId: string): Promise<void> {
  await refreshSkillQuality(pool, skillId);
}

function toDetail(row: QualityRow, findings: ScanFinding[], canReassess: boolean): QualityDetail {
  return {
    semver: row.semver,
    ruleset: row.ruleset,
    rulesScore: row.rulesScore,
    aiStatus: row.aiStatus,
    aiScore: row.aiScore,
    aiModel: row.aiModel,
    finalScore: row.finalScore,
    stars: qualityStars(row.finalScore),
    mode: row.mode,
    scoredAt: row.scoredAt,
    findings: qualityFindingViews(findings),
    verdict: row.aiVerdict,
    canReassess,
  };
}

async function versionRow(skillId: string, semver: string): Promise<{ id: string; artifact_object_key: string | null } | null> {
  const { rows } = await pool.query<{ id: string; artifact_object_key: string | null }>(
    `select id, artifact_object_key from skill_versions where skill_id = $1 and semver = $2`,
    [skillId, semver],
  );
  return rows[0] ?? null;
}

/** The Quality card's payload for one version, or null when unscored (§41.11). */
export async function skillQualityDetail(
  access: EffectiveAccess,
  skill: { id: string; namespaceId: string },
  semver: string,
): Promise<QualityDetail | null> {
  const v = await versionRow(skill.id, semver);
  if (!v) return null;
  const row = await loadVersionQuality(pool, v.id);
  if (!row) return null;
  const report = await latestArtifactFindings(pool, v.artifact_object_key);
  return toDetail(row, (report?.findings ?? []) as ScanFinding[], canReviewNamespace(access, skill.namespaceId));
}

/** Per-version summaries for the Versions list (§41.7). */
export async function skillVersionQualities(skillId: string): Promise<Map<string, QualitySummary>> {
  const rows = await loadSkillQualityBySemver(pool, skillId);
  const out = new Map<string, QualitySummary>();
  for (const [semver, r] of rows) out.set(semver, { score: r.finalScore, stars: qualityStars(r.finalScore), mode: r.mode, scoredAt: r.scoredAt });
  return out;
}

export type ReassessResult = { ok: true; detail: QualityDetail } | { ok: false; status: number; error: string };

/**
 * Re-assess one version (§41.8): re-run the rules scanner on the stored artifact right now
 * (superseding report, prior non-quality findings carried forward verbatim), rewrite the rules
 * part (which drops the AI part and queues it again when AI is on), audit. The AI call lands
 * through the worker sweep.
 */
export async function reassessQuality(
  access: EffectiveAccess,
  actorUserId: string,
  skill: { id: string; namespaceId: string; slug: string },
  semver: string,
  deps: { store?: ArtifactStore } = {},
): Promise<ReassessResult> {
  if (!canReviewNamespace(access, skill.namespaceId)) {
    return { ok: false, status: 403, error: "only a namespace admin of this skill's namespace or a platform admin can re-assess" };
  }
  const v = await versionRow(skill.id, semver);
  if (!v) return { ok: false, status: 404, error: "version not found" };
  if (!v.artifact_object_key) return { ok: false, status: 409, error: "this version has no stored bundle yet" };
  const store = deps.store ?? s3ArtifactStore();
  let files;
  try {
    files = await extractBundle(await store.get(v.artifact_object_key), undefined, bundleContentCap(await getMaxBundleBytes()));
  } catch (err) {
    return { ok: false, status: 503, error: `couldn't read the stored bundle: ${String((err as Error)?.message ?? err)}` };
  }
  const quality = qualityScanner.scan(files) as ScanFinding[];
  const prior = (await latestArtifactFindings(pool, v.artifact_object_key))?.findings ?? [];
  const merged = [...(prior as ScanFinding[]).filter((f) => f.scanner !== QUALITY_SCANNER), ...quality];
  await pool.query(
    `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status)
     values ('artifact', $1, 'quality-rescan', $2::jsonb, $3, 'scanned')`,
    [v.artifact_object_key, JSON.stringify(merged), maxSeverity(merged) ?? "info"],
  );
  const aiOn = await aiAvailable();
  await upsertQualityRules(pool, { versionId: v.id, skillId: skill.id, findings: merged, aiOn });
  await refreshSkillQuality(pool, skill.id);
  if (!aiOn) await settleQualityLow(pool, v.id, merged);
  await appendAudit(pool, {
    actorUserId,
    action: "skill.quality_reassess_requested",
    targetType: "skill_version",
    targetId: `${skill.id}@${semver}`,
    namespaceId: skill.namespaceId,
    after: { skill: skill.slug, semver, ruleset: QUALITY_RULESET_VERSION, aiRequested: aiOn },
  });
  const row = (await loadVersionQuality(pool, v.id))!;
  return { ok: true, detail: toDetail(row, merged, true) };
}

/** Maintenance line (§41.7). */
export function qualityProgress() {
  return sharedQualityProgress(pool);
}

/** "Re-run quality assessment" (§41.7): marks every row stale and audits. */
export async function requestCatalogRescore(actorUserId: string): Promise<number> {
  const n = await requestQualityRescore(pool);
  await appendAudit(pool, { actorUserId, action: "job.quality_rescore_requested", targetType: "job", targetId: "quality", after: { rows: n, ruleset: QUALITY_RULESET_VERSION } });
  return n;
}
