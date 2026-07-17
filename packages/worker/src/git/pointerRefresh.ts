// Pointer refresh / re-scan (leader-only, scheduled). Mirrored pointer skills pin an
// immutable upstream ref, but upstream could move a tag or rewrite history. This job
// periodically re-clones the pinned ref, re-runs the scan pipeline (so findings stay
// fresh against updated signatures/heuristics), and detects DRIFT by comparing the
// freshly-cloned content against the artifact we stored at mirror time. Drift is recorded
// in the audit log and a `pointer_ref` scan report — the immutable version row is never
// mutated. SKILLY_SPEC.md §13 (Pointer scan-on-fetch caching, "external" trust).
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { maxSeverity, bundleContentCap, type ScanFinding } from "@skilly/shared";
import type { ArtifactStore } from "../storage/objectStore.js";
import { fetchPointerFiles } from "./mirror.js";
import { extractBundle } from "./bundle.js";
import { runScanPipeline } from "../scan/pipeline.js";
import { getMaxBundleBytes } from "../settings.js";

/** Order-independent content digest over a file set (ignores archive framing + file mode). */
function contentDigest(files: { path: string; bytes: Buffer | Uint8Array }[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path);
    h.update("\0");
    h.update(Buffer.from(f.bytes));
  }
  return h.digest("hex");
}

interface PointerVersionRow {
  id: string;
  semver: string;
  external_origin_url: string;
  external_ref: string;
  external_subdir: string | null;
  artifact_object_key: string | null;
  skill_id: string;
  namespace_id: string;
  ns_slug: string;
  skill_slug: string;
}

export interface RefreshResult {
  checked: number;
  rescanned: number;
  drift: number;
}

export interface RefreshOptions {
  /** Only re-check versions whose last pointer_ref scan is older than this (default 23h). */
  minAgeSeconds?: number;
  /** Max versions to process per run (default 25) — bounds load on upstream hosts. */
  limit?: number;
}

export async function refreshPointerVersions(pool: Pool, store: ArtifactStore, opts: RefreshOptions = {}): Promise<RefreshResult> {
  const minAgeSeconds = opts.minAgeSeconds ?? 23 * 3600;
  const limit = opts.limit ?? 25;

  const { rows } = await pool.query<PointerVersionRow>(
    `select sv.id, sv.semver, sv.external_origin_url, sv.external_ref, sv.external_subdir, sv.artifact_object_key,
            sv.skill_id, s.namespace_id, n.slug as ns_slug, s.slug as skill_slug
       from skill_versions sv
       join skills s on s.id = sv.skill_id
       join namespaces n on n.id = s.namespace_id
      where sv.external_ref is not null and sv.status = 'active' and s.status = 'active'
        and not exists (
          select 1 from scan_reports r
           where r.subject_type = 'pointer_ref' and r.subject_id = sv.id::text
             and r.created_at > now() - ($1 || ' seconds')::interval
        )
      order by sv.created_at asc
      limit $2`,
    [String(minAgeSeconds), limit],
  );

  const cap = bundleContentCap(await getMaxBundleBytes(pool));
  let checked = 0;
  let rescanned = 0;
  let drift = 0;

  for (const row of rows) {
    checked++;
    try {
      const { files } = await fetchPointerFiles(row.external_origin_url, row.external_ref, row.external_subdir, row.skill_slug, cap);
      const findings: ScanFinding[] = await runScanPipeline(files);

      // Drift: compare freshly-cloned content to the artifact stored at mirror time.
      let drifted = false;
      if (row.artifact_object_key) {
        try {
          const storedFiles = await extractBundle(await store.get(row.artifact_object_key), cap);
          drifted = contentDigest(files) !== contentDigest(storedFiles);
        } catch {
          /* stored artifact unavailable — skip the comparison, still record the rescan */
        }
      }

      if (drifted) {
        drift++;
        findings.push({
          scanner: "pointer-drift",
          severity: "high",
          rule: "upstream-ref-mutated",
          message: `upstream content at pinned ref ${row.external_ref} changed since it was mirrored`,
          path: "SKILL.md",
        });
        await pool.query(
          `insert into audit_log (actor_user_id, action, target_type, target_id, namespace_id, after, source)
           values (null, 'pointer.drift_detected', 'skill_version', $1, $2, $3::jsonb, 'worker')`,
          [`${row.skill_id}@${row.semver}`, row.namespace_id, JSON.stringify({ ref: row.external_ref, url: row.external_origin_url })],
        );

        // Alert the skill's maintainers (explicit + namespace admins, §19) that upstream
        // drifted — but only at drift ONSET (§12 "Drift notifications fire once per onset"):
        // when the most recent prior pointer_ref report (ignoring unreachable blips) wasn't
        // already drift. Consecutive drifted passes stay silent; a clean pass re-arms. The
        // audit row above and the per-pass scan report below keep recording every detection.
        // Per-user opt-out (users.drift_notifications) is row-level: no row minted at all.
        const prior = await pool.query<{ status: string }>(
          `select status from scan_reports
            where subject_type = 'pointer_ref' and subject_id = $1 and status <> 'unreachable'
            order by created_at desc limit 1`,
          [row.id],
        );
        if (prior.rows[0]?.status !== "drift") {
          await pool.query(
            `insert into notifications (user_id, type, payload)
             select uid, 'skill.drift',
                    jsonb_build_object('namespaceSlug',$2::text,'skillSlug',$3::text,'semver',$4::text,'ref',$5::text)
               from (
                 select sm.user_id as uid from skill_maintainers sm where sm.skill_id = $1
                 union
                 select gm.user_id
                   from role_mappings rm
                   join group_memberships gm on gm.group_id = rm.group_id
                  where rm.namespace_id = $6 and rm.role = 'namespace_admin'
               ) recipients
               join users u on u.id = recipients.uid and u.drift_notifications`,
            [row.skill_id, row.ns_slug, row.skill_slug, row.semver, row.external_ref, row.namespace_id],
          );
        }
      }

      await pool.query(
        `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status, cached_for_ref)
         values ('pointer_ref', $1, 'pointer-refresh', $2::jsonb, $3, $4, $5)`,
        [row.id, JSON.stringify(findings), maxSeverity(findings) ?? "info", drifted ? "drift" : "scanned", row.external_ref],
      );
      rescanned++;
    } catch (err) {
      // Upstream unreachable or the pinned ref vanished — record an advisory report so the
      // condition is visible rather than silently retried forever.
      await pool.query(
        `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status, cached_for_ref)
         values ('pointer_ref', $1, 'pointer-refresh', '[]'::jsonb, 'info', 'unreachable', $2)`,
        [row.id, row.external_ref],
      );
      console.error(JSON.stringify({ level: "warn", msg: "pointer refresh unreachable", versionId: row.id, err: String((err as Error).message ?? err) }));
    }
  }

  return { checked, rescanned, drift };
}
