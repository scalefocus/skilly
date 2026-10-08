// AI pre-review on the web side (SKILLY_SPEC.md §46): the proposal section's payload, the skill
// page's owner card, re-runs, per-finding dispositions and the admin switch. Runs are created and
// executed by the worker; web only reads them, queues re-runs and records dispositions.
// Advisory only — nothing here is read by the accept gate or direct-publish routing.
import type { Pool, PoolClient } from "pg";
import {
  canReviewNamespace, compareSemver, resolveLatest,
  loadPrereviewView, loadPrereviewSetting, savePrereviewSetting, prereviewCounts, requestPrereviewRerun, insertPrereviewDisposition,
  currentPrereviewRun, prereviewSourceOfPayload, isFlaggingSeverity,
  PREREVIEW_OPEN_STATES, PREREVIEW_REASON_MAX,
  type EffectiveAccess, type PrereviewView, type PrereviewSubject, type PrereviewVerdict,
} from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { aiAvailable } from "./ai";

type Db = Pool | PoolClient;
type ScanLike = { scanner?: string; rule?: string; path?: string };

export type PrereviewApiResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

function isOpen(state: string): boolean {
  return (PREREVIEW_OPEN_STATES as readonly string[]).includes(state);
}

/** The proposal section (§46.8): the current revision's run under the proposal's own gate. */
export async function proposalPrereview(
  db: Db,
  p: { id: string; state: string; targetNamespaceId: string; revision: number | null; scanFindings: unknown },
  access: EffectiveAccess,
): Promise<PrereviewView | null> {
  if (p.revision === null) return null;
  return loadPrereviewView(db, {
    subject: { kind: "proposal", proposalId: p.id, revision: p.revision },
    scanFindings: Array.isArray(p.scanFindings) ? (p.scanFindings as ScanLike[]) : [],
    aiOn: await aiAvailable(),
    canAct: canReviewNamespace(access, p.targetNamespaceId),
    open: isOpen(p.state),
  });
}

async function proposalCtx(id: string): Promise<{ id: string; state: string; namespaceId: string; revision: number; payload: unknown } | null> {
  const { rows } = await pool.query<{ id: string; state: string; target_namespace_id: string; revision_no: number; payload: unknown }>(
    `select p.id, p.state, p.target_namespace_id, pr.revision_no, pr.payload
       from proposals p
       join lateral (select revision_no, payload from proposal_revisions where proposal_id = p.id order by revision_no desc limit 1) pr on true
      where p.id = $1`,
    [id],
  );
  const r = rows[0];
  return r ? { id: r.id, state: r.state, namespaceId: r.target_namespace_id, revision: r.revision_no, payload: r.payload } : null;
}

async function effective(): Promise<boolean> {
  return (await loadPrereviewSetting(pool)).enabled && (await aiAvailable());
}

/** POST /api/proposals/:id/ai-prereview/rerun (§46.11). */
export async function rerunProposalPrereview(access: EffectiveAccess, userId: string, proposalId: string): Promise<PrereviewApiResult<{ runId: string }>> {
  const p = await proposalCtx(proposalId);
  if (!p) return { ok: false, status: 404, error: "not found" };
  if (!canReviewNamespace(access, p.namespaceId)) {
    // A submitter may see the proposal but not re-run; anyone else learns nothing.
    const { rows } = await pool.query(`select 1 from proposals where id = $1 and submitted_by = $2`, [proposalId, userId]);
    return rows.length ? { ok: false, status: 403, error: "only a reviewer of this proposal can re-run the pre-review" } : { ok: false, status: 404, error: "not found" };
  }
  if (!isOpen(p.state)) return { ok: false, status: 409, error: "the proposal is closed" };
  if (!(await effective())) return { ok: false, status: 409, error: "ai_prereview_unavailable" };
  const r = await requestPrereviewRerun(pool, { kind: "proposal", proposalId, revision: p.revision }, userId, prereviewSourceOfPayload(p.payload));
  if (!r.ok) return { ok: false, status: 409, error: r.code };
  await appendAudit(pool, {
    actorUserId: userId,
    action: "ai_prereview.rerun_requested",
    targetType: "proposal",
    targetId: proposalId,
    namespaceId: p.namespaceId,
    after: { revision: p.revision, runId: r.runId },
  });
  return { ok: true, value: { runId: r.runId } };
}

function parseDisposition(body: Record<string, unknown>): { fingerprint: string; verdict: PrereviewVerdict; reason: string | null } | string {
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
  if (!fingerprint) return "fingerprint is required";
  if (body.verdict !== "agree" && body.verdict !== "dismiss") return "verdict must be agree or dismiss";
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
  if (reason && reason.length > PREREVIEW_REASON_MAX) return `the reason can be at most ${PREREVIEW_REASON_MAX} characters`;
  return { fingerprint, verdict: body.verdict, reason };
}

async function findingOf(subject: PrereviewSubject, fingerprint: string) {
  const run = await currentPrereviewRun(pool, subject);
  if (!run || run.status !== "done") return null;
  return run.result?.findings.find((f) => f.fingerprint === fingerprint) ?? null;
}

/** POST /api/proposals/:id/ai-prereview/dispositions (§46.7). */
export async function dispositionProposalFinding(
  access: EffectiveAccess,
  userId: string,
  proposalId: string,
  body: Record<string, unknown>,
): Promise<PrereviewApiResult<{ ok: true }>> {
  const p = await proposalCtx(proposalId);
  if (!p) return { ok: false, status: 404, error: "not found" };
  if (!canReviewNamespace(access, p.namespaceId)) {
    const { rows } = await pool.query(`select 1 from proposals where id = $1 and submitted_by = $2`, [proposalId, userId]);
    return rows.length ? { ok: false, status: 403, error: "only a reviewer of this proposal can agree with or dismiss a finding" } : { ok: false, status: 404, error: "not found" };
  }
  if (!isOpen(p.state)) return { ok: false, status: 409, error: "the proposal is closed" };
  const d = parseDisposition(body);
  if (typeof d === "string") return { ok: false, status: 422, error: d };
  const finding = await findingOf({ kind: "proposal", proposalId, revision: p.revision }, d.fingerprint);
  if (!finding) return { ok: false, status: 422, error: "unknown_finding" };
  await insertPrereviewDisposition(pool, { target: { proposalId }, fingerprint: d.fingerprint, verdict: d.verdict, reason: d.reason, userId });
  await appendAudit(pool, {
    actorUserId: userId,
    action: "ai_prereview.finding_dispositioned",
    targetType: "proposal",
    targetId: proposalId,
    namespaceId: p.namespaceId,
    after: { fingerprint: d.fingerprint, category: finding.category, severity: finding.severity, verdict: d.verdict, reason: d.reason },
  });
  return { ok: true, value: { ok: true } };
}

// ── The skill page's owner card ────────────────────────────────────────────────────────────────

interface VersionRow { id: string; semver: string; artifact_object_key: string | null; content_sha256: string | null }

async function activeVersions(skillId: string): Promise<VersionRow[]> {
  const { rows } = await pool.query<VersionRow>(
    `select id, semver, artifact_object_key, content_sha256 from skill_versions where skill_id = $1 and status = 'active'`,
    [skillId],
  );
  return rows;
}

/** The version the card describes: latest stable, else the highest active version (as §37.8). */
function displayed(versions: VersionRow[]): VersionRow | null {
  if (versions.length === 0) return null;
  const stable = resolveLatest(versions.map((v) => v.semver));
  if (stable) return versions.find((v) => v.semver === stable) ?? null;
  return [...versions].sort((a, b) => compareSemver(b.semver, a.semver))[0] ?? null;
}

async function versionScanFindings(artifactKey: string | null): Promise<ScanLike[]> {
  if (!artifactKey) return [];
  const { rows } = await pool.query<{ findings: unknown }>(
    `select findings from scan_reports where subject_type = 'artifact' and subject_id = $1 order by created_at desc limit 1`,
    [artifactKey],
  );
  return Array.isArray(rows[0]?.findings) ? (rows[0]!.findings as ScanLike[]) : [];
}

export interface SkillPrereviewDetail extends PrereviewView {
  semver: string;
  /** Other active versions whose current run has a high or critical finding. */
  otherFlagged: string[];
}

/** GET /api/skills/:ns/:slug/ai-prereview (§46.8). The caller has already checked "owner". */
export async function skillPrereviewDetail(access: EffectiveAccess, skill: { id: string; namespaceId: string }, semver: string | null): Promise<SkillPrereviewDetail | null> {
  const versions = await activeVersions(skill.id);
  const target = semver ? versions.find((v) => v.semver === semver) ?? null : displayed(versions);
  if (!target) return null;
  const view = await loadPrereviewView(pool, {
    subject: { kind: "version", versionId: target.id },
    scanFindings: await versionScanFindings(target.artifact_object_key),
    aiOn: await aiAvailable(),
    canAct: canReviewNamespace(access, skill.namespaceId),
    open: true,
  });
  // "Not reviewed" can be run by hand only while the feature is effective.
  if (view.status === "none") view.canRerun = view.canRerun && (await effective());
  const { rows } = await pool.query<{ semver: string }>(
    `select sv.semver
       from skill_versions sv
       join lateral (
         select r.max_severity from ai_prereview_links l join ai_prereviews r on r.id = l.run_id
          where l.skill_version_id = sv.id order by l.id desc limit 1
       ) cur on true
      where sv.skill_id = $1 and sv.status = 'active' and sv.id <> $2 and cur.max_severity in ('high', 'critical')`,
    [skill.id, target.id],
  );
  return { ...view, semver: target.semver, otherFlagged: rows.map((r) => r.semver).sort((a, b) => compareSemver(b, a)) };
}

async function versionFor(skillId: string, semver: unknown): Promise<VersionRow | null> {
  if (typeof semver !== "string" || !semver) return null;
  return (await activeVersions(skillId)).find((v) => v.semver === semver) ?? null;
}

/** POST /api/skills/:ns/:slug/ai-prereview/rerun (§46.11). */
export async function rerunVersionPrereview(
  access: EffectiveAccess,
  userId: string,
  skill: { id: string; namespaceId: string; slug: string },
  semver: unknown,
): Promise<PrereviewApiResult<{ runId: string }>> {
  if (!canReviewNamespace(access, skill.namespaceId)) {
    return { ok: false, status: 403, error: "only a namespace admin of this skill's namespace or a platform admin can run the pre-review" };
  }
  const v = await versionFor(skill.id, semver);
  if (!v) return { ok: false, status: 404, error: "version not found" };
  if (!(await effective())) return { ok: false, status: 409, error: "ai_prereview_unavailable" };
  const fallback = v.artifact_object_key ? { source: { kind: "artifact" as const, objectKey: v.artifact_object_key }, contentSha256: v.content_sha256 } : null;
  const r = await requestPrereviewRerun(pool, { kind: "version", versionId: v.id }, userId, fallback);
  if (!r.ok) return { ok: false, status: 409, error: r.code };
  await appendAudit(pool, {
    actorUserId: userId,
    action: "ai_prereview.rerun_requested",
    targetType: "skill_version",
    targetId: `${skill.id}@${v.semver}`,
    namespaceId: skill.namespaceId,
    after: { skill: skill.slug, semver: v.semver, runId: r.runId },
  });
  return { ok: true, value: { runId: r.runId } };
}

/** POST /api/skills/:ns/:slug/ai-prereview/dispositions (§46.7). */
export async function dispositionVersionFinding(
  access: EffectiveAccess,
  userId: string,
  skill: { id: string; namespaceId: string; slug: string },
  body: Record<string, unknown>,
): Promise<PrereviewApiResult<{ ok: true }>> {
  if (!canReviewNamespace(access, skill.namespaceId)) {
    return { ok: false, status: 403, error: "only a namespace admin of this skill's namespace or a platform admin can agree with or dismiss a finding" };
  }
  const v = await versionFor(skill.id, body.semver);
  if (!v) return { ok: false, status: 404, error: "version not found" };
  const d = parseDisposition(body);
  if (typeof d === "string") return { ok: false, status: 422, error: d };
  const finding = await findingOf({ kind: "version", versionId: v.id }, d.fingerprint);
  if (!finding) return { ok: false, status: 422, error: "unknown_finding" };
  await insertPrereviewDisposition(pool, { target: { versionId: v.id }, fingerprint: d.fingerprint, verdict: d.verdict, reason: d.reason, userId });
  await appendAudit(pool, {
    actorUserId: userId,
    action: "ai_prereview.finding_dispositioned",
    targetType: "skill_version",
    targetId: `${skill.id}@${v.semver}`,
    namespaceId: skill.namespaceId,
    after: { skill: skill.slug, semver: v.semver, fingerprint: d.fingerprint, category: finding.category, severity: finding.severity, verdict: d.verdict, reason: d.reason },
  });
  return { ok: true, value: { ok: true } };
}

// ── The admin switch (§46.2) ───────────────────────────────────────────────────────────────────

export interface PrereviewAdminState {
  enabled: boolean;
  /** On and the integration operational. */
  effective: boolean;
  pending: number;
  failed24h: number;
}

export async function getPrereviewAdmin(): Promise<PrereviewAdminState> {
  const [setting, aiOn, counts] = await Promise.all([loadPrereviewSetting(pool), aiAvailable(), prereviewCounts(pool)]);
  return { enabled: setting.enabled, effective: setting.enabled && aiOn, pending: counts.pending, failed24h: counts.failed24h };
}

/** PUT /api/admin/ai/prereview. Unchanged ⇒ no write, no audit. */
export async function setPrereviewEnabled(enabled: boolean, userId: string): Promise<PrereviewAdminState> {
  const r = await savePrereviewSetting(pool, enabled, userId);
  if (r.changed) {
    await appendAudit(pool, {
      actorUserId: userId,
      action: "settings.updated",
      targetType: "platform_settings",
      targetId: "ai_prereview_enabled",
      before: { aiPrereviewEnabled: r.before },
      after: { aiPrereviewEnabled: enabled },
    });
  }
  return getPrereviewAdmin();
}

/** True when the version's current run flags it (for tests and callers that only need the bit). */
export async function versionPrereviewFlagged(versionId: string): Promise<boolean> {
  const run = await currentPrereviewRun(pool, { kind: "version", versionId });
  return !!run && run.status === "done" && isFlaggingSeverity(run.maxSeverity);
}
