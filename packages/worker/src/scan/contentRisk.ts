// Content-risk re-scan sweep and onset handling (SKILLY_SPEC.md §37.5, §37.9). Leader-only.
//
// The sweep finds active versions whose artifact's latest scan report has no `cr-scanned` marker at
// the current ruleset — every version published before §37 shipped, and every version after a
// ruleset bump — re-runs ONLY the content-risk scanner on the stored artifact, and writes a
// SUPERSEDING report: the prior report's non-content findings carried forward verbatim, the
// content findings replaced. Rows are never mutated. A newly flagged version is an "onset": one
// audit row and one notification per maintainer. A scanner never yanks, archives or hides anything.
import type { Pool } from "pg";
import {
  contentRiskScanner, maxSeverity, contentRiskTripsGate, deriveContentRiskStatus, contentRiskPairKey,
  gateTrippingPairs, countContentRiskFindings, CONTENT_RISK_SCANNER, CONTENT_RULESET_VERSION,
  type ScanFinding,
} from "@skilly/shared";
import type { ArtifactStore } from "../storage/objectStore.js";
import { extractAny } from "../git/contentBackfill.js";
import { M } from "../metrics.js";

export const CONTENT_SWEEP_BATCH = Number(process.env.CONTENT_RISK_SWEEP_BATCH ?? 50);

/** Artifacts that failed to read/extract in this process — skipped so they can't starve the batch. */
const failed = new Set<string>();

const markerFilter = () => JSON.stringify([{ rule: "cr-scanned", ruleset: CONTENT_RULESET_VERSION }]);

interface Candidate {
  artifact_object_key: string;
  report_id: string | null;
  findings: ScanFinding[] | null;
  status: string | null;
}

/** Acknowledged (rule, path) keys for one version (§37.6). */
async function ackedKeys(pool: Pool, skillId: string, semver: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ pairs: { rule: string; path: string | null }[] }>(
    `select pairs from content_risk_acknowledgements where skill_id = $1 and semver = $2`,
    [skillId, semver],
  );
  const keys = new Set<string>();
  for (const r of rows) for (const p of r.pairs ?? []) keys.add(contentRiskPairKey(p.rule, p.path));
  return keys;
}

/**
 * Onset (§37.5): the version is now flagged and its previous report had no gate-tripping content
 * findings. Records `skill.content_risk_detected` and notifies the effective maintainers who haven't
 * opted out (users.content_risk_notifications), once. Returns true when it fired.
 */
export async function recordContentRiskOnset(
  pool: Pool,
  v: { skillId: string; semver: string; namespaceId: string; nsSlug: string; skillSlug: string },
  findings: ScanFinding[],
  priorFindings: ScanFinding[] | null,
): Promise<boolean> {
  if (!contentRiskTripsGate(findings)) return false;
  if (priorFindings && contentRiskTripsGate(priorFindings)) return false;
  if (deriveContentRiskStatus(findings, await ackedKeys(pool, v.skillId, v.semver)) !== "flagged") return false;
  const rules = [...new Set(gateTrippingPairs(findings).map((p) => p.rule))];
  await pool.query(
    `insert into audit_log (actor_user_id, action, target_type, target_id, namespace_id, after, source)
     values (null, 'skill.content_risk_detected', 'skill_version', $1, $2, $3::jsonb, 'worker')`,
    [`${v.skillId}@${v.semver}`, v.namespaceId, JSON.stringify({ skill: v.skillSlug, semver: v.semver, rules, ruleset: CONTENT_RULESET_VERSION })],
  );
  // Same recipient set as skill.drift (explicit maintainers ∪ namespace admins), filtered by the
  // §37.9 opt-out at insert time — an opted-out user gets no row at all.
  await pool.query(
    `insert into notifications (user_id, type, payload)
     select uid, 'skill.content_risk',
            jsonb_build_object('namespaceSlug',$2::text,'skillSlug',$3::text,'semver',$4::text,'rules',$5::jsonb)
       from (
         select sm.user_id as uid from skill_maintainers sm where sm.skill_id = $1
         union
         select gm.user_id
           from role_mappings rm
           join group_memberships gm on gm.group_id = rm.group_id
          where rm.namespace_id = $6 and rm.role = 'namespace_admin'
       ) recipients
       join users u on u.id = recipients.uid and u.status = 'active' and u.content_risk_notifications`,
    [v.skillId, v.nsSlug, v.skillSlug, v.semver, JSON.stringify(rules), v.namespaceId],
  );
  return true;
}

/** Active versions that share an artifact (Keep current files reuses the same object). */
async function versionsForArtifact(pool: Pool, key: string) {
  const { rows } = await pool.query<{ skill_id: string; semver: string; namespace_id: string; ns_slug: string; skill_slug: string }>(
    `select sv.skill_id, sv.semver, s.namespace_id, n.slug as ns_slug, s.slug as skill_slug
       from skill_versions sv
       join skills s on s.id = sv.skill_id and s.status = 'active'
       join namespaces n on n.id = s.namespace_id
      where sv.artifact_object_key = $1 and sv.status = 'active'`,
    [key],
  );
  return rows;
}

/** One pass of the sweep. Returns how many artifacts were re-scanned. */
export async function sweepContentRisk(pool: Pool, store: ArtifactStore, limit = CONTENT_SWEEP_BATCH): Promise<number> {
  const { rows } = await pool.query<Candidate>(
    `select distinct on (sv.artifact_object_key) sv.artifact_object_key, r.id as report_id, r.findings, r.status
       from skill_versions sv
       join skills s on s.id = sv.skill_id and s.status = 'active'
       left join lateral (
         select id, findings, status from scan_reports
          where subject_type = 'artifact' and subject_id = sv.artifact_object_key
          order by created_at desc limit 1
       ) r on true
      where sv.status = 'active' and sv.artifact_object_key is not null
        and not coalesce(r.findings @> $1::jsonb, false)
        and not (sv.artifact_object_key = any($2::text[]))
      order by sv.artifact_object_key
      limit $3`,
    [markerFilter(), [...failed], limit],
  );
  let scanned = 0;
  for (const c of rows) {
    let content: ScanFinding[];
    try {
      const files = await extractAny(await store.get(c.artifact_object_key));
      content = contentRiskScanner.scan(files) as ScanFinding[];
    } catch (err) {
      failed.add(c.artifact_object_key);
      console.error(JSON.stringify({ level: "warn", msg: "content-risk sweep skipped an artifact", key: c.artifact_object_key, err: String(err) }));
      continue;
    }
    countContentRiskFindings(M.contentRiskFindings, content);
    const prior = Array.isArray(c.findings) ? c.findings : [];
    const merged = [...prior.filter((f) => f.scanner !== CONTENT_RISK_SCANNER), ...content];
    await pool.query(
      `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status)
       values ('artifact', $1, 'content-rescan', $2::jsonb, $3, $4)`,
      [c.artifact_object_key, JSON.stringify(merged), maxSeverity(merged) ?? "info", c.status ?? "scanned"],
    );
    for (const v of await versionsForArtifact(pool, c.artifact_object_key)) {
      await recordContentRiskOnset(
        pool,
        { skillId: v.skill_id, semver: v.semver, namespaceId: v.namespace_id, nsSlug: v.ns_slug, skillSlug: v.skill_slug },
        merged,
        c.report_id ? prior : null,
      );
    }
    scanned++;
  }
  await refreshPendingGauge(pool);
  return scanned;
}

async function refreshPendingGauge(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n
       from skill_versions sv
       join skills s on s.id = sv.skill_id and s.status = 'active'
       left join lateral (
         select findings from scan_reports
          where subject_type = 'artifact' and subject_id = sv.artifact_object_key
          order by created_at desc limit 1
       ) r on true
      where sv.status = 'active' and sv.artifact_object_key is not null
        and not coalesce(r.findings @> $1::jsonb, false)`,
    [markerFilter()],
  );
  M.contentRiskSweepPending.set(Number(rows[0]?.n ?? 0));
}

/** Test seam: forget artifacts that failed in this process. */
export function resetContentRiskSweepFailures(): void {
  failed.clear();
}
