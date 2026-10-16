// AV sweep (SKILLY_SPEC.md §49.2). Leader-only, every 60 s.
//
// Finds artifact-keyed scan reports whose latest row has NO ClamAV engine result — either the
// `scanner-unavailable` marker (the engine was down when the bundle was ingested) or no `clamav`
// finding at all (every artifact scanned before this release, hosted or mirrored) — reads the
// artifact, runs ONLY ClamAV, and writes a SUPERSEDING report in the §37.5 shape: prior non-AV
// findings carried forward verbatim, the AV findings replaced, severity recomputed, status kept.
// Rows are never mutated. A `malware` hit on a published version is an onset (loud alert, no
// automatic state change). Only runs when CLAMAV_HOST is configured on the worker.
import type { Pool } from "pg";
import { maxSeverity, runScanners, type ScanFinding } from "@skilly/shared";
import { clamavScannerFromEnv, CLAMAV_SCANNER, AV_UNAVAILABLE_RULE } from "@skilly/shared/clamav";
import type { ArtifactStore } from "../storage/objectStore.js";
import { extractAny } from "../git/contentBackfill.js";
import { recordMalwareOnset } from "./malware.js";

export const AV_SWEEP_BATCH = Number(process.env.AV_SWEEP_BATCH ?? 20);

/** Artifacts that failed to read/extract in this process — skipped so they can't starve the batch. */
const failed = new Set<string>();

interface Candidate {
  artifact_object_key: string;
  report_id: string | null;
  findings: ScanFinding[] | null;
  status: string | null;
}

/** Reports that need an engine pass: no clamav finding, or only the unavailable marker. */
export function needsAvPass(findings: readonly ScanFinding[] | null | undefined): boolean {
  const av = (findings ?? []).filter((f) => f.scanner === CLAMAV_SCANNER);
  return av.length === 0 || av.every((f) => f.rule === AV_UNAVAILABLE_RULE);
}

/** One pass. Returns how many artifacts were AV-scanned (0 when ClamAV is not configured). */
export async function sweepAv(pool: Pool, store: ArtifactStore, limit = AV_SWEEP_BATCH): Promise<number> {
  const av = clamavScannerFromEnv();
  if (!av) return 0;
  // Candidates: the latest artifact report of (a) any proposal-staged upload still referenced by an
  // open proposal, and (b) any active version's artifact — whose findings lack an engine result.
  const { rows } = await pool.query<Candidate>(
    `select distinct on (k.key) k.key as artifact_object_key, r.id as report_id, r.findings, r.status
       from (
         select sv.artifact_object_key as key
           from skill_versions sv join skills s on s.id = sv.skill_id and s.status = 'active'
          where sv.status in ('active','quarantined') and sv.artifact_object_key is not null
         union
         select pr.payload->>'artifactObjectKey'
           from proposals p
           join lateral (select payload from proposal_revisions where proposal_id = p.id order by revision_no desc limit 1) pr on true
          where p.state in ('proposed','under_review','changes_requested')
            and pr.payload->>'artifactObjectKey' is not null
       ) k
       left join lateral (
         select id, findings, status from scan_reports
          where subject_type = 'artifact' and subject_id = k.key
          order by created_at desc limit 1
       ) r on true
      where not (k.key = any($1::text[]))
        and (r.id is null
             or not exists (
               select 1 from jsonb_array_elements(coalesce(r.findings, '[]'::jsonb)) f
                where f->>'scanner' = 'clamav' and f->>'rule' <> 'scanner-unavailable'))
      order by k.key
      limit $2`,
    [[...failed], limit],
  );
  let scanned = 0;
  for (const c of rows) {
    const prior = Array.isArray(c.findings) ? c.findings : [];
    if (!needsAvPass(prior)) continue;
    let avFindings: ScanFinding[];
    try {
      const files = await extractAny(await store.get(c.artifact_object_key));
      avFindings = await runScanners(files, [av]);
    } catch (err) {
      failed.add(c.artifact_object_key);
      console.error(JSON.stringify({ level: "warn", msg: "av sweep skipped an artifact", key: c.artifact_object_key, err: String(err) }));
      continue;
    }
    // Engine still down: nothing to supersede with — leave the report alone, retry next pass.
    if (avFindings.some((f) => f.rule === AV_UNAVAILABLE_RULE)) continue;
    const merged = [...prior.filter((f) => f.scanner !== CLAMAV_SCANNER), ...avFindings];
    await pool.query(
      `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status)
       values ('artifact', $1, 'av-rescan', $2::jsonb, $3, $4)`,
      [c.artifact_object_key, JSON.stringify(merged), maxSeverity(merged) ?? "info", c.status ?? "scanned"],
    );
    const { rows: versions } = await pool.query<{ skill_id: string; semver: string; namespace_id: string; ns_slug: string; skill_slug: string }>(
      `select sv.skill_id, sv.semver, s.namespace_id, n.slug as ns_slug, s.slug as skill_slug
         from skill_versions sv
         join skills s on s.id = sv.skill_id and s.status = 'active'
         join namespaces n on n.id = s.namespace_id
        where sv.artifact_object_key = $1 and sv.status = 'active'`,
      [c.artifact_object_key],
    );
    for (const v of versions) {
      await recordMalwareOnset(pool, { skillId: v.skill_id, semver: v.semver, namespaceId: v.namespace_id, nsSlug: v.ns_slug, skillSlug: v.skill_slug }, merged, c.report_id ? prior : null);
    }
    scanned++;
  }
  return scanned;
}
