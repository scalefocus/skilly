// The upstream-release sweep (SKILLY_SPEC.md §63.3, §63.5) — leader-only, hourly plus once at start.
// For up to 25 eligible pointer skills a pass, least recently checked first (each at most once per
// 23 h), it lists the baseline's upstream once per origin, classifies the baseline's pin, picks the
// highest stable release above it and, for a git origin, fetches that release's copy of the skill's
// folder to see whether its files changed. It then notifies the skill's effective maintainers once
// per release (`skill.upstream_release`), unless an open proposal already covers it. It never
// mirrors, scans or stores bytes, and it never touches a version.
//
// The rules (pin kind, candidate, pending, covering proposal) come from
// `@skilly/shared/upstream-releases`, so the sweep and the web tier agree on what "pending" means.
import type { Pool, PoolClient } from "pg";
import {
  OPEN_POINTER_PROPOSALS_SQL,
  UPSTREAM_RELEASES_SETTING_KEY,
  bundleContentCap,
  classifyPin,
  compareSemver,
  contentDigest,
  effectiveMaintainerIdsSql,
  isSkillsHubUrl,
  listRemoteRefCommits,
  listRemoteRefs,
  normalizeOriginUrl,
  pickCandidate,
  proposalCovers,
  upstreamReleaseState,
  upstreamSemver,
  type BundleEntry,
  type PointerRefsResult,
  type RemoteRefCommitsResult,
  type UpstreamPinKind,
} from "@skilly/shared";
import { fetchPointerFiles } from "./git/mirror.js";
import { getMaxBundleBytes } from "./settings.js";
import { M } from "./metrics.js";

/** Default cadence (§63.3). `UPSTREAM_RELEASES_INTERVAL_MS` overrides it. */
export const UPSTREAM_RELEASES_INTERVAL_MS = 60 * 60 * 1000;

/** The advisory-lock key, so an overlapping run (a second replica, a manual run) skips. */
const LOCK_KEY = "upstream-release-sweep";

/** The upstream calls, injectable so the integration test can stub the network. */
export interface UpstreamDeps {
  listGit: (url: string) => Promise<RemoteRefCommitsResult>;
  listRegistry: (url: string) => Promise<PointerRefsResult>;
  fetchFiles: (url: string, ref: string, subdir: string | null, skillSlug: string, maxBytes: number) => Promise<{ files: BundleEntry[] }>;
}

const DEFAULT_DEPS: UpstreamDeps = {
  listGit: listRemoteRefCommits,
  listRegistry: listRemoteRefs,
  fetchFiles: (url, ref, subdir, slug, cap) => fetchPointerFiles(url, ref, subdir, slug, cap),
};

export interface UpstreamSweepOptions {
  /** Max skills per pass (default 25, the pointer refresh's bound). */
  limit?: number;
  /** Only re-check skills last checked longer ago than this (default 23 h). */
  minAgeSeconds?: number;
  /** Restrict the pass to these skills (tests, manual runs). */
  skillIds?: string[];
}

export interface UpstreamSweepResult {
  skipped: boolean;
  checked: number;
  /** Checks that found a newer release that changed the skill's files (or any registry release). */
  releases: number;
  /** Checks whose newest release left the skill's folder unchanged. */
  unchanged: number;
  errors: number;
  notified: number;
}

/** Is the §63.10 switch on? Absent ⇒ on. */
export async function upstreamReleasesEnabled(db: Pool | PoolClient): Promise<boolean> {
  const { rows } = await db.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [UPSTREAM_RELEASES_SETTING_KEY]);
  return rows[0]?.value !== false;
}

interface SkillRow {
  skill_id: string;
  skill_slug: string;
  skill_title: string;
  namespace_id: string;
  ns_slug: string;
  version_id: string;
  origin_url: string;
  ref: string;
  subdir: string | null;
  content_sha256: string | null;
}

interface StoredRow {
  baseline_version_id: string;
  release_ref: string | null;
  release_commit: string | null;
  files_changed: boolean | null;
  notified_ref: string | null;
  skipped_ref: string | null;
}

type Listing =
  | { ok: true; registry: boolean; branches: string[]; tags: string[]; commits: Map<string, string> }
  | { ok: false; registry: boolean; error: string };

/** One pass. */
export async function sweepUpstreamReleases(pool: Pool, deps: Partial<UpstreamDeps> = {}, opts: UpstreamSweepOptions = {}): Promise<UpstreamSweepResult> {
  const none: UpstreamSweepResult = { skipped: true, checked: 0, releases: 0, unchanged: 0, errors: 0, notified: 0 };
  if (!(await upstreamReleasesEnabled(pool))) return none;

  const lockClient = await pool.connect();
  try {
    const { rows: lock } = await lockClient.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext($1)) as ok`, [LOCK_KEY]);
    if (!lock[0]?.ok) return none;
    try {
      return await runSweep(pool, { ...DEFAULT_DEPS, ...deps }, opts);
    } finally {
      await lockClient.query(`select pg_advisory_unlock(hashtext($1))`, [LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}

async function runSweep(pool: Pool, deps: UpstreamDeps, opts: UpstreamSweepOptions): Promise<UpstreamSweepResult> {
  const limit = opts.limit ?? 25;
  const minAgeSeconds = opts.minAgeSeconds ?? 23 * 3600;
  // Eligible (§63.2): an active, non-deprecated pointer skill, and its baseline — the latest stable
  // active version (skilly_semver_key orders exactly like compareSemver).
  const { rows } = await pool.query<SkillRow>(
    `select s.id as skill_id, s.slug as skill_slug, s.title as skill_title, s.namespace_id, n.slug as ns_slug,
            b.id as version_id, b.external_origin_url as origin_url, b.external_ref as ref,
            b.external_subdir as subdir, b.content_sha256
       from skills s
       join namespaces n on n.id = s.namespace_id
       join lateral (
         select sv.id, sv.external_origin_url, sv.external_ref, sv.external_subdir, sv.content_sha256
           from skill_versions sv
          where sv.skill_id = s.id and sv.status = 'active' and not sv.is_prerelease
          order by skilly_semver_key(sv.semver) desc nulls last, sv.created_at desc
          limit 1
       ) b on true
       left join skill_upstream_releases r on r.skill_id = s.id
      where s.status = 'active' and s.deprecated_at is null and s.type = 'pointer'
        and b.external_ref is not null and b.external_origin_url is not null
        and (r.checked_at is null or r.checked_at < now() - ($1 || ' seconds')::interval)
        and ($3::uuid[] is null or s.id = any($3::uuid[]))
      order by r.checked_at asc nulls first, s.created_at asc
      limit $2`,
    [String(minAgeSeconds), limit, opts.skillIds ?? null],
  );

  const result: UpstreamSweepResult = { skipped: false, checked: 0, releases: 0, unchanged: 0, errors: 0, notified: 0 };
  if (rows.length === 0) return result;
  const cap = bundleContentCap(await getMaxBundleBytes(pool));
  // One listing per origin per pass (§63.3): a monorepo with ten mirrored skills costs one call.
  const listings = new Map<string, Promise<Listing>>();
  const listingFor = (url: string): Promise<Listing> => {
    const key = normalizeOriginUrl(url) || url;
    let p = listings.get(key);
    if (!p) {
      p = listOrigin(url, deps);
      listings.set(key, p);
    }
    return p;
  };

  for (const skill of rows) {
    result.checked++;
    try {
      const outcome = await checkSkill(pool, deps, skill, await listingFor(skill.origin_url), cap);
      if (outcome.result === "release") result.releases++;
      else if (outcome.result === "unchanged") result.unchanged++;
      else if (outcome.result === "error") result.errors++;
      result.notified += outcome.notified;
      M.upstreamReleaseChecks.add(1, { result: outcome.result });
    } catch (err) {
      result.errors++;
      M.upstreamReleaseChecks.add(1, { result: "error" });
      console.error(JSON.stringify({ level: "warn", msg: "upstream release check failed", skillId: skill.skill_id, err: String((err as Error).message ?? err) }));
    }
  }
  if (result.notified > 0) M.upstreamReleaseNotifications.add(result.notified);
  return result;
}

async function listOrigin(url: string, deps: UpstreamDeps): Promise<Listing> {
  if (isSkillsHubUrl(url)) {
    const r = await deps.listRegistry(url);
    return r.ok ? { ok: true, registry: true, branches: [], tags: r.tags, commits: new Map() } : { ok: false, registry: true, error: r.error };
  }
  const r = await deps.listGit(url);
  return r.ok
    ? { ok: true, registry: false, branches: [...r.heads.keys()], tags: [...r.tags.keys()], commits: r.tags }
    : { ok: false, registry: false, error: r.error };
}

type CheckResult = "none" | "release" | "unchanged" | "error";

async function checkSkill(pool: Pool, deps: UpstreamDeps, skill: SkillRow, listing: Listing, cap: number): Promise<{ result: CheckResult; notified: number }> {
  const { rows: prior } = await pool.query<StoredRow>(
    `select baseline_version_id, release_ref, release_commit, files_changed, notified_ref, skipped_ref
       from skill_upstream_releases where skill_id = $1`,
    [skill.skill_id],
  );
  const stored = prior[0] ?? null;

  // A failed listing keeps the previous release state; only the error and the check time move.
  if (!listing.ok) {
    await recordFailure(pool, skill, listing.registry ? "registry" : "commit", listing.error);
    return { result: "error", notified: 0 };
  }

  const pinKind = classifyPin(skill.ref, { branches: listing.branches, tags: listing.tags }, listing.registry);
  const candidate = pinKind === "semver_tag" || pinKind === "registry" ? pickCandidate(skill.ref, listing.tags) : null;
  const releaseCommit = candidate && !listing.registry ? listing.commits.get(candidate.ref) ?? null : null;

  // The folder check (§63.3, git only): cached per (release, commit, baseline).
  let filesChanged: boolean | null = null;
  if (candidate && !listing.registry) {
    const cached = stored && stored.release_ref === candidate.ref && stored.release_commit === releaseCommit
      && stored.baseline_version_id === skill.version_id && stored.files_changed !== null;
    if (cached) {
      filesChanged = stored.files_changed;
    } else if (skill.content_sha256) {
      try {
        const { files } = await deps.fetchFiles(skill.origin_url, candidate.ref, skill.subdir, skill.skill_slug, cap);
        filesChanged = contentDigest(files) !== skill.content_sha256;
      } catch (err) {
        await recordFailure(pool, skill, pinKind, String((err as Error).message ?? err));
        return { result: "error", notified: 0 };
      }
    }
    // No content_sha256 yet (the §8 backfill hasn't reached the baseline): leave it unchecked —
    // files_changed stays null, nothing is pending, and the next check (23 h on) tries again.
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: up } = await client.query<{ notified_ref: string | null; skipped_ref: string | null }>(
      `insert into skill_upstream_releases
         (skill_id, baseline_version_id, origin_url, subdir, pin_kind, release_ref, release_semver, release_commit,
          release_bump, files_changed, detected_at, checked_at, last_error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, case when $6::text is null then null else now() end, now(), null)
       on conflict (skill_id) do update set
         baseline_version_id = excluded.baseline_version_id,
         origin_url = excluded.origin_url,
         subdir = excluded.subdir,
         pin_kind = excluded.pin_kind,
         detected_at = case
           when excluded.release_ref is null then null
           when skill_upstream_releases.release_ref is not distinct from excluded.release_ref then skill_upstream_releases.detected_at
           else now() end,
         release_ref = excluded.release_ref,
         release_semver = excluded.release_semver,
         release_commit = excluded.release_commit,
         release_bump = excluded.release_bump,
         files_changed = excluded.files_changed,
         checked_at = now(),
         last_error = null
       returning notified_ref, skipped_ref`,
      [skill.skill_id, skill.version_id, skill.origin_url, skill.subdir, pinKind, candidate?.ref ?? null, candidate?.semver ?? null,
        releaseCommit, candidate?.bump ?? null, filesChanged],
    );
    const notifiedRef = up[0]?.notified_ref ?? null;

    const state = upstreamReleaseState({
      enabled: true,
      eligible: true,
      row: {
        originUrl: skill.origin_url,
        subdir: skill.subdir,
        pinKind,
        releaseRef: candidate?.ref ?? null,
        releaseSemver: candidate?.semver ?? null,
        filesChanged,
        skippedRef: up[0]?.skipped_ref ?? null,
      },
      baseline: { originUrl: skill.origin_url, subdir: skill.subdir, ref: skill.ref },
    });

    let notified = 0;
    const notifiedSemver = upstreamSemver(notifiedRef);
    if (candidate && state === "pending" && (!notifiedSemver || compareSemver(candidate.semver, notifiedSemver) > 0)) {
      // §63.5: an open proposal for this release (or a higher one) silences it for good.
      if (!(await coveredByOpenProposal(client, skill, candidate.semver))) {
        const payload = {
          skillId: skill.skill_id,
          namespaceSlug: skill.ns_slug,
          skillSlug: skill.skill_slug,
          skillTitle: skill.skill_title,
          currentRef: skill.ref,
          releaseRef: candidate.ref,
          bump: candidate.bump,
        };
        const ins = await client.query(
          `insert into notifications (user_id, type, payload)
           select u.id, 'skill.upstream_release', $3::jsonb
             from (${effectiveMaintainerIdsSql("$1", "$2")}) em
             join users u on u.id = em.user_id and u.status = 'active' and u.upstream_release_notifications`,
          [skill.skill_id, skill.namespace_id, JSON.stringify(payload)],
        );
        notified = ins.rowCount ?? 0;
      }
      await client.query(`update skill_upstream_releases set notified_ref = $2 where skill_id = $1`, [skill.skill_id, candidate.ref]);
    }
    await client.query("commit");

    const result: CheckResult = !candidate ? "none"
      : listing.registry || filesChanged === true ? "release"
      : filesChanged === false ? "unchanged"
      : "none";
    return { result, notified };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** A failed check: record the error and the time, keep everything else (§63.3 *Failures*). */
async function recordFailure(pool: Pool, skill: SkillRow, pinKind: UpstreamPinKind, error: string): Promise<void> {
  await pool.query(
    `insert into skill_upstream_releases (skill_id, baseline_version_id, origin_url, subdir, pin_kind, checked_at, last_error)
     values ($1, $2, $3, $4, $5, now(), $6)
     on conflict (skill_id) do update set checked_at = now(), last_error = excluded.last_error`,
    [skill.skill_id, skill.version_id, skill.origin_url, skill.subdir, pinKind, error.slice(0, 500)],
  );
}

/** Is there an open new-version proposal for this skill pinning this release or a higher one? */
async function coveredByOpenProposal(db: PoolClient, skill: SkillRow, releaseSemver: string): Promise<boolean> {
  const { rows } = await db.query<{ url: string | null; ref: string | null; subdir: string | null }>(OPEN_POINTER_PROPOSALS_SQL, [skill.skill_id]);
  return rows.some((r) => r.url && r.ref && proposalCovers(
    { originUrl: r.url, subdir: r.subdir, ref: r.ref },
    { originUrl: skill.origin_url, subdir: skill.subdir, releaseSemver },
  ));
}
