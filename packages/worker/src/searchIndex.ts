// Search-index upkeep on the worker (SKILLY_SPEC.md §34.9 / §34.10). Leader-only.
//  - fillSearchText: store a version's SKILL.md text the moment the worker holds its files — the
//    publish sweep (every hosted AND pointer version passes through it) and the pointer mirror.
//    Write-once and advisory: indexing never fails a publish.
//  - sweepSearchIndex: every extraction row still `pending` — the post-migration backfill, retries
//    after a failure, anything a publish path didn't fill — read from object storage in batches.
//  - reindexSearchLanguage: after a search-language switch, rebuild the vectors (and the synonym
//    groups' normalized forms) that were built with another language, in small batches.
import type { Pool } from "pg";
import { skillMdSearchText, bundleContentCap } from "@skilly/shared";
import type { ArtifactStore } from "./storage/objectStore.js";
import { extractBundle } from "./git/bundle.js";
import { getMaxBundleBytes } from "./settings.js";
import { M } from "./metrics.js";

/** Attempts before a row is parked as `failed` (Maintenance → Retry failed re-arms it). */
export const SEARCH_EXTRACT_MAX_ATTEMPTS = 5;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** The searchable text of a bundle — its root SKILL.md, or null when it has none. */
export function searchTextOf(files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): string | null {
  const md = files.find((f) => f.path === "SKILL.md");
  return md ? skillMdSearchText(new TextDecoder().decode(md.bytes)) : null;
}

const oneLine = (err: unknown): string => String(err).replace(/\s+/g, " ").slice(0, 300);

/**
 * Record a version's SKILL.md text if it has none yet (`indexed`, or `absent` without a SKILL.md).
 * Never throws — a failure leaves the row `pending` for the sweep.
 */
export async function fillSearchText(pool: Pool, versionId: string, files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): Promise<void> {
  try {
    const text = searchTextOf(files);
    await pool.query(
      `update skill_version_search
          set body_text = $2, status = $3, last_error = null
        where skill_version_id = $1 and body_text is null and status in ('pending', 'failed')`,
      [versionId, text, text === null ? "absent" : "indexed"],
    );
  } catch (err) {
    console.error(JSON.stringify({ level: "warn", msg: "search text fill failed; the sweep will retry", versionId, err: String(err) }));
  }
}

interface PendingRow {
  id: string;
  artifact_object_key: string | null;
  attempts: number;
}

/**
 * Extract SKILL.md text for pending rows — each skill's INDEXED version first — backing off between
 * attempts (2 min × attempts) and parking a row as `failed` after SEARCH_EXTRACT_MAX_ATTEMPTS.
 */
export async function sweepSearchIndex(
  pool: Pool,
  store: ArtifactStore,
  limit = envInt("SEARCH_INDEX_BATCH", 50),
): Promise<{ indexed: number; failed: number }> {
  const { rows } = await pool.query<PendingRow>(
    `select svs.skill_version_id as id, sv.artifact_object_key, svs.attempts
       from skill_version_search svs
       join skill_versions sv on sv.id = svs.skill_version_id
      where svs.status = 'pending'
        and (svs.attempts = 0 or svs.updated_at < now() - make_interval(mins => svs.attempts * 2))
      order by (skilly_indexed_version(sv.skill_id) = sv.id) desc, sv.created_at desc
      limit $1`,
    [limit],
  );
  let indexed = 0;
  let failed = 0;
  if (rows.length) {
    // Extract against the SAME cap the upload enforced, as the publish sweep does (§6).
    const cap = bundleContentCap(await getMaxBundleBytes(pool));
    for (const r of rows) {
      if (!r.artifact_object_key) {
        // No stored bundle (never happens for a published version; defensive for seeded rows).
        await pool.query(`update skill_version_search set status = 'absent', last_error = null where skill_version_id = $1 and body_text is null`, [r.id]);
        continue;
      }
      try {
        const text = searchTextOf(await extractBundle(await store.get(r.artifact_object_key), cap));
        await pool.query(
          `update skill_version_search set body_text = $2, status = $3, last_error = null
            where skill_version_id = $1 and body_text is null`,
          [r.id, text, text === null ? "absent" : "indexed"],
        );
        indexed++;
      } catch (err) {
        const attempts = r.attempts + 1;
        const parked = attempts >= SEARCH_EXTRACT_MAX_ATTEMPTS;
        if (parked) failed++;
        await pool.query(
          `update skill_version_search set attempts = $2, status = $3, last_error = $4 where skill_version_id = $1`,
          [r.id, attempts, parked ? "failed" : "pending", oneLine(err)],
        );
        console.error(JSON.stringify({ level: parked ? "warn" : "error", msg: parked ? "search text extraction gave up (retry from Maintenance)" : "search text extraction failed", versionId: r.id, attempts, err: String(err) }));
      }
    }
  }
  const { rows: c } = await pool.query<{ pending: string; failed: string }>(
    `select count(*) filter (where status = 'pending')::text as pending,
            count(*) filter (where status = 'failed')::text as failed
       from skill_version_search`,
  );
  M.searchIndexPending.set(Number(c[0]?.pending ?? 0));
  M.searchIndexFailed.set(Number(c[0]?.failed ?? 0));
  return { indexed, failed };
}

/**
 * After a search-language switch (§34.9): rebuild, in batches, every vector built with another
 * language — touching `search_lang` re-fires the vector trigger, which stamps the active language —
 * for up to `budgetMs` per call, and re-normalize the synonym groups the same way. Returns how many
 * skills were rebuilt.
 */
export async function reindexSearchLanguage(
  pool: Pool,
  batch = envInt("SEARCH_REINDEX_BATCH", 100),
  budgetMs = envInt("SEARCH_REINDEX_BUDGET_MS", 5_000),
): Promise<number> {
  await pool.query(`update search_synonym_groups set terms = terms where normalized_lang is distinct from skilly_search_config()::text`);
  const started = Date.now();
  let rebuilt = 0;
  for (;;) {
    const { rows } = await pool.query<{ id: string }>(
      `select id from skills where search_lang is distinct from skilly_search_config()::text order by id limit $1`,
      [batch],
    );
    if (!rows.length) break;
    // One short statement per batch, so install-count updates never queue behind a long rebuild.
    await pool.query(`update skills set search_lang = null where id = any($1::uuid[])`, [rows.map((r) => r.id)]);
    rebuilt += rows.length;
    if (rows.length < batch || Date.now() - started >= budgetMs) break;
  }
  return rebuilt;
}
