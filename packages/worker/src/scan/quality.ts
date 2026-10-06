// Quality sweep (SKILLY_SPEC.md §41.6) and the mirror-time write. Leader-only.
//
// Phase 1 — rules: active versions whose artifact's latest report has no `qa-scanned` marker at
// the current ruleset, whose quality row is missing or stale, or whose rescore was requested:
// re-run ONLY the quality scanner on the stored artifact, write a SUPERSEDING report (every other
// finding carried forward verbatim), rewrite the row's rules part. The first run after deploy is
// the backfill; a ruleset bump re-runs it automatically.
//
// Phase 2 — AI: when the §40 integration is operational, up to QUALITY_SWEEP_AI_BATCH rows that
// are pending (or `off` from before AI was enabled), due, and either their skill's latest stable
// active version or published in the last 7 days. One §41.5 call each; success blends, failure
// counts an attempt. Then the §41.9 low-score notification settles.
import type { Pool } from "pg";
import {
  qualityScanner, maxSeverity, buildQualityPrompt, isSecretLikeLine, qualityRulesetOf, resolveLatest,
  upsertQualityRules, refreshSkillQuality, settleQualityLow, recordQualityAiSuccess, recordQualityAiFailure,
  latestArtifactFindings, qualityMarkerFilter, validateQualityVerdict,
  QUALITY_SCANNER, QUALITY_RULESET_VERSION, QUALITY_SWEEP_RULES_BATCH, QUALITY_SWEEP_AI_BATCH, QUALITY_AI_FEATURE, QUALITY_AI_MAX_TOKENS,
  type ScanFinding, type BundleEntry,
} from "@skilly/shared";
import { aiAvailable, aiComplete, parseAiTokenKey, AiError, type AiEnv } from "@skilly/shared/ai";
import type { ArtifactStore } from "../storage/objectStore.js";
import { extractAny } from "../git/contentBackfill.js";
import { M } from "../metrics.js";

/** Artifacts that failed to read/extract in this process — skipped so they can't starve the batch. */
const failed = new Set<string>();

function aiEnv(): AiEnv {
  return { key: parseAiTokenKey(process.env.AI_TOKEN_ENC_KEY), source: "worker" };
}

interface RulesCandidate {
  version_id: string;
  skill_id: string;
  artifact_object_key: string;
  report_id: string | null;
  findings: ScanFinding[] | null;
  status: string | null;
  marker_current: boolean;
}

/**
 * Mirror-time write (§41.6): the pointer version's artifact report was just written, so score it.
 * Advisory — the caller wraps it.
 */
export async function recordQualityAtMirror(pool: Pool, v: { versionId: string; skillId: string; artifactKey: string }, findings: ScanFinding[]): Promise<void> {
  if (qualityRulesetOf(findings) === null) return;
  const aiOn = await aiAvailable(pool, aiEnv());
  await upsertQualityRules(pool, { versionId: v.versionId, skillId: v.skillId, findings, aiOn });
  await refreshSkillQuality(pool, v.skillId);
  if (!aiOn) await settleQualityLow(pool, v.versionId, findings);
}

/** Phase 1. Returns how many versions were (re)scored. */
export async function sweepQualityRules(pool: Pool, store: ArtifactStore, limit = QUALITY_SWEEP_RULES_BATCH): Promise<number> {
  const { rows } = await pool.query<RulesCandidate>(
    `select sv.id as version_id, sv.skill_id, sv.artifact_object_key, r.id as report_id, r.findings, r.status,
            coalesce(r.findings @> $1::jsonb, false) as marker_current
       from skill_versions sv
       join skills s on s.id = sv.skill_id and s.status = 'active'
       left join lateral (
         select id, findings, status from scan_reports
          where subject_type = 'artifact' and subject_id = sv.artifact_object_key
          order by created_at desc limit 1
       ) r on true
       left join skill_version_quality q on q.skill_version_id = sv.id
      where sv.status = 'active' and sv.artifact_object_key is not null
        and (not coalesce(r.findings @> $1::jsonb, false) or q.skill_version_id is null or q.ruleset <> $2 or q.rescore_requested_at is not null)
        and not (sv.artifact_object_key = any($3::text[]))
      order by sv.created_at desc
      limit $4`,
    [qualityMarkerFilter(), QUALITY_RULESET_VERSION, [...failed], limit],
  );
  if (rows.length === 0) return 0;
  const aiOn = await aiAvailable(pool, aiEnv());
  let scored = 0;
  // Several versions can share one artifact (Keep current files): scan each artifact once per pass.
  const scannedArtifacts = new Map<string, ScanFinding[]>();
  for (const c of rows) {
    if (failed.has(c.artifact_object_key)) continue; // a sibling version of an artifact that just failed
    let merged: ScanFinding[];
    const cached = scannedArtifacts.get(c.artifact_object_key);
    if (cached) {
      merged = cached;
    } else if (c.marker_current && c.findings) {
      merged = c.findings;
    } else {
      let quality: ScanFinding[];
      try {
        const files: BundleEntry[] = await extractAny(await store.get(c.artifact_object_key));
        quality = qualityScanner.scan(files) as ScanFinding[];
      } catch (err) {
        failed.add(c.artifact_object_key);
        console.error(JSON.stringify({ level: "warn", msg: "quality sweep skipped an artifact", key: c.artifact_object_key, err: String(err) }));
        continue;
      }
      const prior = Array.isArray(c.findings) ? c.findings : [];
      merged = [...prior.filter((f) => f.scanner !== QUALITY_SCANNER), ...quality];
      await pool.query(
        `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status)
         values ('artifact', $1, 'quality-rescan', $2::jsonb, $3, $4)`,
        [c.artifact_object_key, JSON.stringify(merged), maxSeverity(merged) ?? "info", c.status ?? "scanned"],
      );
      scannedArtifacts.set(c.artifact_object_key, merged);
    }
    await upsertQualityRules(pool, { versionId: c.version_id, skillId: c.skill_id, findings: merged, aiOn });
    await refreshSkillQuality(pool, c.skill_id);
    if (!aiOn) await settleQualityLow(pool, c.version_id, merged);
    scored++;
  }
  M.qualitySweepRuns.inc({ phase: "rules" });
  return scored;
}

interface AiCandidate {
  version_id: string;
  skill_id: string;
  semver: string;
  artifact_object_key: string;
  is_recent: boolean;
  candidates: string[] | null;
}

/** Phase 2. Returns how many AI calls were attempted. */
export async function sweepQualityAi(pool: Pool, store: ArtifactStore, limit = QUALITY_SWEEP_AI_BATCH, deps: { env?: AiEnv } = {}): Promise<number> {
  const env = deps.env ?? aiEnv();
  if (!(await aiAvailable(pool, env))) return 0;
  // Due rows: pending (or off from before AI was enabled), not waiting out a retry, and worth the
  // call — the skill's latest stable active version, or anything published in the last 7 days.
  const { rows } = await pool.query<AiCandidate>(
    `select q.skill_version_id as version_id, q.skill_id, sv.semver, sv.artifact_object_key, sv.created_at >= now() - interval '7 days' as is_recent,
            (select array_agg(x.semver) from skill_versions x where x.skill_id = q.skill_id and x.status = 'active' and not x.is_prerelease) as candidates
       from skill_version_quality q
       join skill_versions sv on sv.id = q.skill_version_id and sv.status = 'active'
       join skills s on s.id = q.skill_id and s.status = 'active'
      where q.ai_status in ('pending', 'off')
        and (q.ai_next_attempt_at is null or q.ai_next_attempt_at <= now())
        and sv.artifact_object_key is not null
      order by sv.created_at desc
      limit $1`,
    [limit * 4],
  );
  const due = rows.filter((r) => r.is_recent || resolveLatest(r.candidates ?? []) === r.semver).slice(0, limit);
  let attempted = 0;
  for (const c of due) {
    attempted++;
    let outcome: "ok" | "failed" | "invalid" = "failed";
    try {
      const files: BundleEntry[] = await extractAny(await store.get(c.artifact_object_key));
      const skillMd = files.find((f) => f.path === "SKILL.md");
      const report = await latestArtifactFindings(pool, c.artifact_object_key);
      const prompt = buildQualityPrompt({
        skillMd: skillMd ? new TextDecoder().decode(skillMd.bytes) : "",
        filePaths: files.map((f) => f.path),
        findings: report?.findings ?? [],
        isSecretLine: isSecretLikeLine,
      });
      const res = await aiComplete(pool, env, {
        feature: QUALITY_AI_FEATURE,
        userId: null,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        maxTokens: QUALITY_AI_MAX_TOKENS,
        json: true,
      });
      const verdict = validateQualityVerdict(res.json, res.model);
      if (!verdict) {
        outcome = "invalid";
        await recordQualityAiFailure(pool, c.version_id, "ai_invalid_json: the verdict did not have five integer dimensions");
      } else {
        outcome = "ok";
        await recordQualityAiSuccess(pool, c.version_id, verdict);
      }
    } catch (err) {
      // Refused before the network (disabled / not configured / key missing) is not an attempt:
      // leave the row for a later pass. Anything else counts.
      if (err instanceof AiError && (err.code === "ai_disabled" || err.code === "ai_not_configured" || err.code === "ai_key_missing" || err.code === "ai_unknown_feature")) {
        M.qualityAiAttempts.inc({ outcome: "refused" });
        break;
      }
      const msg = err instanceof AiError ? `${err.code}: ${err.message}` : String((err as Error)?.message ?? err);
      await recordQualityAiFailure(pool, c.version_id, msg);
    }
    M.qualityAiAttempts.inc({ outcome });
    await refreshSkillQuality(pool, c.skill_id);
    await settleQualityLow(pool, c.version_id, undefined, { aiOn: true });
  }
  M.qualitySweepRuns.inc({ phase: "ai" });
  return attempted;
}

/** One pass: rules, then AI. Returns both counts. */
export async function sweepQuality(pool: Pool, store: ArtifactStore): Promise<{ scored: number; aiAttempted: number }> {
  const scored = await sweepQualityRules(pool, store);
  const aiAttempted = await sweepQualityAi(pool, store);
  await refreshQualityGauge(pool);
  return { scored, aiAttempted };
}

async function refreshQualityGauge(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ active: string; scored: string; ai_done: string; ai_failed: string }>(
    `select count(*)::text as active,
            count(q.skill_version_id)::text as scored,
            count(q.skill_version_id) filter (where q.ai_status = 'done')::text as ai_done,
            count(q.skill_version_id) filter (where q.ai_status = 'failed')::text as ai_failed
       from skill_versions sv
       join skills s on s.id = sv.skill_id and s.status = 'active'
       left join skill_version_quality q on q.skill_version_id = sv.id
      where sv.status = 'active' and sv.artifact_object_key is not null`,
  );
  const r = rows[0];
  if (!r) return;
  M.qualityVersions.set(Number(r.scored), { status: "scored" });
  M.qualityVersions.set(Number(r.ai_done), { status: "ai_done" });
  M.qualityVersions.set(Number(r.ai_failed), { status: "ai_failed" });
  M.qualityVersions.set(Number(r.active) - Number(r.scored), { status: "unscored" });
}

/** Test seam: forget artifacts that failed in this process. */
export function resetQualitySweepFailures(): void {
  failed.clear();
}
