// Content risk on the web side (SKILLY_SPEC.md §37): per-version status, the owner panel, the
// acknowledgement action, the Administration list and the Maintenance progress line. The scanner
// itself is in @skilly/shared; reports are ordinary scan_reports rows keyed by artifact.
import type { Pool, PoolClient } from "pg";
import {
  CONTENT_RULESET_VERSION, contentRiskFindings, contentRiskPairKey, deriveContentRiskStatus,
  gateTrippingPairs, canReviewNamespace, compareSemver, resolveLatest,
  type ContentRiskStatus, type EffectiveAccess, type ScanFinding,
} from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";

type Db = Pool | PoolClient;

export interface ContentReport { id: string; findings: ScanFinding[]; createdAt: string }

/** The latest artifact-keyed report — the same row the accept gate and the review page read. */
export async function latestArtifactReport(db: Db, artifactKey: string | null | undefined): Promise<ContentReport | null> {
  if (!artifactKey) return null;
  const { rows } = await db.query<{ id: string; findings: ScanFinding[] | null; created_at: string }>(
    `select id, findings, created_at from scan_reports
      where subject_type = 'artifact' and subject_id = $1 order by created_at desc limit 1`,
    [artifactKey],
  );
  const r = rows[0];
  return r ? { id: r.id, findings: Array.isArray(r.findings) ? r.findings : [], createdAt: r.created_at } : null;
}

export interface AckView {
  at: string;
  byName: string | null;
  note: string | null;
  source: "override" | "manual";
}

async function versionAcks(db: Db, skillId: string, semver: string): Promise<{ keys: Set<string>; views: AckView[] }> {
  const { rows } = await db.query<{ pairs: { rule: string; path: string | null }[]; acknowledged_at: string; note: string | null; source: "override" | "manual"; by_name: string | null }>(
    `select a.pairs, a.acknowledged_at, a.note, a.source, u.display_name as by_name
       from content_risk_acknowledgements a
       left join users u on u.id = a.acknowledged_by
      where a.skill_id = $1 and a.semver = $2
      order by a.acknowledged_at desc`,
    [skillId, semver],
  );
  const keys = new Set<string>();
  for (const r of rows) for (const p of r.pairs ?? []) keys.add(contentRiskPairKey(p.rule, p.path));
  return { keys, views: rows.map((r) => ({ at: r.acknowledged_at, byName: r.by_name, note: r.note, source: r.source })) };
}

/** Record an acknowledgement (§37.6). Append-only; the caller audits a manual one. */
export async function recordAcknowledgement(
  db: Db,
  input: { skillId: string; semver: string; reportId: string | null; findings: ScanFinding[]; byUserId: string | null; note?: string | null; source: "override" | "manual" },
): Promise<void> {
  const pairs = gateTrippingPairs(input.findings);
  if (pairs.length === 0) return;
  await db.query(
    `insert into content_risk_acknowledgements (skill_id, semver, scan_report_id, pairs, acknowledged_by, note, source)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [input.skillId, input.semver, input.reportId, JSON.stringify(pairs), input.byUserId, input.note?.trim() || null, input.source],
  );
}

interface VersionRow { semver: string; artifact_object_key: string | null; is_prerelease: boolean }

async function activeVersions(db: Db, skillId: string): Promise<VersionRow[]> {
  const { rows } = await db.query<VersionRow>(
    `select semver, artifact_object_key, is_prerelease from skill_versions where skill_id = $1 and status = 'active'`,
    [skillId],
  );
  return rows;
}

/** The version the skill page describes: latest stable, else the highest active version (§37.8). */
function displayedVersion(versions: VersionRow[]): VersionRow | null {
  if (versions.length === 0) return null;
  const stable = resolveLatest(versions.map((v) => v.semver));
  if (stable) return versions.find((v) => v.semver === stable) ?? null;
  return [...versions].sort((a, b) => compareSemver(b.semver, a.semver))[0] ?? null;
}

export interface VersionContentRisk {
  semver: string;
  status: ContentRiskStatus;
  ruleset: number;
  report: ContentReport | null;
  acks: AckView[];
}

async function versionContentRisk(db: Db, skillId: string, v: VersionRow): Promise<VersionContentRisk> {
  const [report, acks] = await Promise.all([latestArtifactReport(db, v.artifact_object_key), versionAcks(db, skillId, v.semver)]);
  return {
    semver: v.semver,
    status: deriveContentRiskStatus(report?.findings ?? [], acks.keys),
    ruleset: CONTENT_RULESET_VERSION,
    report,
    acks: acks.views,
  };
}

/** What every viewer gets on the skill page: the displayed version's status, no findings (§37.11). */
export async function skillContentRiskSummary(skillId: string): Promise<{ semver: string; status: ContentRiskStatus; ruleset: number } | null> {
  const v = displayedVersion(await activeVersions(pool, skillId));
  if (!v) return null;
  const r = await versionContentRisk(pool, skillId, v);
  return { semver: r.semver, status: r.status, ruleset: r.ruleset };
}

export interface ContentRiskDetail {
  semver: string;
  status: ContentRiskStatus;
  ruleset: number;
  /** Content-risk findings only, from the version's latest artifact report. */
  findings: ScanFinding[];
  reportCreatedAt: string | null;
  acknowledgements: AckView[];
  /** Other active versions currently flagged (§37.8). */
  otherFlagged: string[];
  canAcknowledge: boolean;
}

/** The owner panel (§37.8): full findings for one version plus the other flagged versions. */
export async function skillContentRiskDetail(
  access: EffectiveAccess,
  skill: { id: string; namespaceId: string },
  semver: string | null,
): Promise<ContentRiskDetail | null> {
  const versions = await activeVersions(pool, skill.id);
  const target = semver ? versions.find((v) => v.semver === semver) ?? null : displayedVersion(versions);
  if (!target) return null;
  const all = await Promise.all(versions.map((v) => versionContentRisk(pool, skill.id, v)));
  const mine = all.find((r) => r.semver === target.semver)!;
  return {
    semver: mine.semver,
    status: mine.status,
    ruleset: mine.ruleset,
    findings: contentRiskFindings(mine.report?.findings ?? []),
    reportCreatedAt: mine.report?.createdAt ?? null,
    acknowledgements: mine.acks,
    otherFlagged: all.filter((r) => r.semver !== mine.semver && r.status === "flagged").map((r) => r.semver).sort((a, b) => compareSemver(b, a)),
    canAcknowledge: mine.status === "flagged" && canReviewNamespace(access, skill.namespaceId),
  };
}

export type AcknowledgeResult = { ok: true } | { ok: false; status: number; error: string };

/** Acknowledge a flagged version (§37.6). Override authority only; 409 unless flagged. Audited. */
export async function acknowledgeContentRisk(
  access: EffectiveAccess,
  actorUserId: string,
  skill: { id: string; namespaceId: string; slug: string },
  semver: string,
  note: string | null,
): Promise<AcknowledgeResult> {
  if (!canReviewNamespace(access, skill.namespaceId)) {
    return { ok: false, status: 403, error: "only a namespace admin of this skill's namespace or a platform admin can acknowledge" };
  }
  if (note && note.trim().length > 500) return { ok: false, status: 422, error: "the note can be at most 500 characters" };
  const client = await pool.connect();
  try {
    await client.query("begin");
    const v = (await activeVersions(client, skill.id)).find((x) => x.semver === semver);
    if (!v) { await client.query("rollback"); return { ok: false, status: 404, error: "version not found" }; }
    const r = await versionContentRisk(client, skill.id, v);
    if (r.status !== "flagged" || !r.report) { await client.query("rollback"); return { ok: false, status: 409, error: "this version is not flagged" }; }
    await recordAcknowledgement(client, { skillId: skill.id, semver, reportId: r.report.id, findings: r.report.findings, byUserId: actorUserId, note, source: "manual" });
    await appendAudit(client, {
      actorUserId,
      action: "skill.content_risk_acknowledged",
      targetType: "skill_version",
      targetId: `${skill.id}@${semver}`,
      namespaceId: skill.namespaceId,
      after: { skill: skill.slug, semver, reportId: r.report.id, rules: [...new Set(gateTrippingPairs(r.report.findings).map((p) => p.rule))], note: note?.trim() || null },
    });
    await client.query("commit");
    return { ok: true };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export interface AdminContentRiskRow {
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  semver: string;
  status: ContentRiskStatus;
  rules: string[];
  detectedAt: string;
}

/** Administration → Content risk (§37.8): active versions that are flagged (default) or noted. */
export async function listContentRisk(q: { status?: "flagged" | "noted" | "all"; ns?: string | null; rule?: string | null }): Promise<AdminContentRiskRow[]> {
  const { rows } = await pool.query<{ skill_id: string; ns_slug: string; skill_slug: string; title: string; semver: string; findings: ScanFinding[]; created_at: string }>(
    `select s.id as skill_id, n.slug as ns_slug, s.slug as skill_slug, s.title, sv.semver, r.findings, r.created_at
       from skill_versions sv
       join skills s on s.id = sv.skill_id and s.status = 'active'
       join namespaces n on n.id = s.namespace_id
       join lateral (
         select findings, created_at from scan_reports
          where subject_type = 'artifact' and subject_id = sv.artifact_object_key
          order by created_at desc limit 1
       ) r on true
      where sv.status = 'active'
        and ($1::text is null or n.slug = $1)
        and exists (
          select 1 from jsonb_array_elements(r.findings) f
           where f->>'scanner' = 'content-risk' and f->>'severity' in ('medium', 'high', 'critical')
             and ($2::text is null or f->>'rule' = $2)
        )
      order by r.created_at desc
      limit 500`,
    [q.ns || null, q.rule || null],
  );
  const out: AdminContentRiskRow[] = [];
  for (const r of rows) {
    const acks = await versionAcks(pool, r.skill_id, r.semver);
    const status = deriveContentRiskStatus(r.findings, acks.keys);
    const want = q.status ?? "flagged";
    if (want !== "all" && status !== want) continue;
    if (want === "all" && status !== "flagged" && status !== "noted") continue;
    const notable = contentRiskFindings(r.findings).filter((f) => f.severity !== "info" && f.severity !== "low");
    out.push({
      namespaceSlug: r.ns_slug,
      skillSlug: r.skill_slug,
      title: r.title,
      semver: r.semver,
      status,
      rules: [...new Set(notable.map((f) => f.rule))],
      detectedAt: r.created_at,
    });
  }
  return out;
}

/** Maintenance line (§37.8): how many active versions have been checked at the current ruleset. */
export async function contentRiskProgress(): Promise<{ total: number; checked: number; ruleset: number }> {
  const { rows } = await pool.query<{ total: string; checked: string }>(
    `select count(*)::text as total,
            count(*) filter (where r.findings @> $1::jsonb)::text as checked
       from skill_versions sv
       join skills s on s.id = sv.skill_id and s.status = 'active'
       left join lateral (
         select findings from scan_reports
          where subject_type = 'artifact' and subject_id = sv.artifact_object_key
          order by created_at desc limit 1
       ) r on true
      where sv.status = 'active' and sv.artifact_object_key is not null`,
    [JSON.stringify([{ rule: "cr-scanned", ruleset: CONTENT_RULESET_VERSION }])],
  );
  return { total: Number(rows[0]?.total ?? 0), checked: Number(rows[0]?.checked ?? 0), ruleset: CONTENT_RULESET_VERSION };
}
