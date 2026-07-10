// Pre-accept scan for POINTER proposals. Hosted proposals are scanned at upload (the artifact
// exists pre-accept); pointer proposals have no artifact until they're mirrored on accept, so
// without this they show "not scanned" in review and reviewers approve blind. This loop clones
// each open pointer proposal's pinned ref, runs the advisory scanners, and writes a
// proposal-keyed scan report (subject_type='proposal') that the proposal detail surfaces.
// SKILLY_SPEC.md §6, §8, §9.
import type { Pool } from "pg";
import { maxSeverity, bundleContentCap } from "@skilly/shared";
import { fetchPointerFiles } from "./mirror.js";
import { runScanPipeline } from "../scan/pipeline.js";
import { sweepBatchSize } from "./publish.js";
import { getMaxBundleBytes } from "../settings.js";

interface PreScanRow {
  id: string;
  url: string;
  ref: string;
  subdir: string | null;
  skill_slug: string;
}

/**
 * Scan open pointer proposals whose pinned ref hasn't been pre-scanned yet. Keyed by the ref
 * (`cached_for_ref`) and deduped to one report per proposal, so each ref is attempted once and a
 * re-proposal at a new ref re-scans. Returns the number scanned (success or recorded-unreachable).
 */
export async function preScanPointerProposals(pool: Pool): Promise<number> {
  const { rows } = await pool.query<PreScanRow>(
    `select p.id,
            pr.payload->'pointer'->>'url'     as url,
            pr.payload->'pointer'->>'ref'     as ref,
            pr.payload->'pointer'->>'subdir'  as subdir,
            pr.payload->'metadata'->>'skillSlug' as skill_slug
       from proposals p
       join lateral (
         select payload from proposal_revisions
          where proposal_id = p.id order by revision_no desc limit 1
       ) pr on true
      where p.state in ('proposed','under_review','changes_requested')
        and pr.payload->'pointer' is not null
        and coalesce(pr.payload->'pointer'->>'ref', '') <> ''
        and not exists (
          select 1 from scan_reports r
           where r.subject_type = 'proposal' and r.subject_id = p.id::text
             and r.cached_for_ref = pr.payload->'pointer'->>'ref'
        )
      order by p.created_at asc
      limit ${sweepBatchSize()}`,
  );

  const cap = bundleContentCap(await getMaxBundleBytes(pool));
  let scanned = 0;
  for (const r of rows) {
    // One report per proposal: drop any prior (older-ref) report, then write the current one.
    try {
      const { files } = await fetchPointerFiles(r.url, r.ref, r.subdir, r.skill_slug, cap);
      const findings = await runScanPipeline(files);
      const severity = maxSeverity(findings) ?? "info";
      await pool.query(`delete from scan_reports where subject_type = 'proposal' and subject_id = $1`, [r.id]);
      await pool.query(
        `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status, cached_for_ref)
         values ('proposal', $1, 'pointer-prescan', $2::jsonb, $3, 'scanned', $4)`,
        [r.id, JSON.stringify(findings), severity, r.ref],
      );
      scanned++;
    } catch (err) {
      // Unreachable/bad ref: record it (so reviewers see *why* there are no findings) and so this
      // ref isn't retried every loop. A re-proposal at a different ref re-attempts.
      await pool.query(`delete from scan_reports where subject_type = 'proposal' and subject_id = $1`, [r.id]);
      await pool.query(
        `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status, cached_for_ref)
         values ('proposal', $1, 'pointer-prescan', '[]'::jsonb, 'info', 'unreachable', $2)`,
        [r.id, r.ref],
      );
      console.error(JSON.stringify({ level: "warn", msg: "proposal pre-scan unreachable", proposalId: r.id, ref: r.ref, err: String(err) }));
    }
  }
  return scanned;
}
