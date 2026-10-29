// Upstream release alerts — the web side (SKILLY_SPEC.md §63.7, §63.8, §63.11): the skill page's
// `upstream` block and the catalog pill for effective maintainers and platform admins, and Skip /
// Un-skip. The worker's sweep writes `skill_upstream_releases`; what is *pending* is derived here on
// every read from the skill's CURRENT baseline through the shared rules, so publishing the update
// clears the notice and the pill at once.
import type { Pool, PoolClient } from "pg";
import {
  OPEN_POINTER_PROPOSALS_SQL,
  isUpstreamBump,
  openPointerProposalsSql,
  proposeUpdatePath,
  skillVisibilityWhere,
  upstreamCardUpdate,
  upstreamNotice,
  upstreamReleaseState,
  type EffectiveAccess,
  type OpenProposalPointer,
  type UpstreamBump,
  type UpstreamCardUpdate,
  type UpstreamPinKind,
  type UpstreamReleaseState,
} from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { nameSql } from "./userLabel";
import { getUpstreamReleasesEnabled } from "./settings";

type Db = Pool | PoolClient;

/** The §63.11 `upstream` field of `GET /api/skills/:ns/:slug`. */
export interface UpstreamView {
  kind: "release" | "branch_drift";
  /** The baseline's pinned ref. */
  currentRef: string;
  /** The baseline's semver, for the branch-drift wording ("since v1.2.0 was pinned"). */
  baselineSemver: string;
  release?: { ref: string; semver: string; bump: UpstreamBump | null; detectedAt: string | null };
  /** An open proposal that already covers it (§63.5): the notice links to it instead. */
  proposal?: { id: string };
  skipped?: { ref: string; byName: string | null; at: string | null };
  /** The pre-filled propose form (§63.9). */
  proposePath: string;
}

interface Baseline {
  id: string;
  semver: string;
  origin_url: string;
  ref: string;
  subdir: string | null;
}

interface StoredRow {
  baseline_version_id: string;
  origin_url: string;
  subdir: string | null;
  pin_kind: UpstreamPinKind;
  release_ref: string | null;
  release_semver: string | null;
  release_bump: string | null;
  files_changed: boolean | null;
  detected_at: Date | null;
  skipped_ref: string | null;
  skipped_at: Date | null;
  skipped_by_name: string | null;
}

/** The skill's baseline (§63.2): its latest stable active version, when that is a pointer pin. */
async function loadBaseline(db: Db, skillId: string): Promise<Baseline | null> {
  const { rows } = await db.query<Baseline & { ref: string | null; origin_url: string | null }>(
    `select sv.id, sv.semver, sv.external_origin_url as origin_url, sv.external_ref as ref, sv.external_subdir as subdir
       from skill_versions sv
      where sv.skill_id = $1 and sv.status = 'active' and not sv.is_prerelease
      order by skilly_semver_key(sv.semver) desc nulls last, sv.created_at desc
      limit 1`,
    [skillId],
  );
  const b = rows[0];
  return b && b.ref && b.origin_url ? { ...b, ref: b.ref, origin_url: b.origin_url } : null;
}

async function loadRow(db: Db, skillId: string): Promise<StoredRow | null> {
  const { rows } = await db.query<StoredRow>(
    `select r.baseline_version_id, r.origin_url, r.subdir, r.pin_kind, r.release_ref, r.release_semver, r.release_bump,
            r.files_changed, r.detected_at, r.skipped_ref, r.skipped_at,
            case when u.id is null then null else ${nameSql("u.display_name", "u.email")} end as skipped_by_name
       from skill_upstream_releases r
       left join users u on u.id = r.skipped_by
      where r.skill_id = $1`,
    [skillId],
  );
  return rows[0] ?? null;
}

interface SkillFacts {
  id: string;
  status: string;
  deprecatedAt: string | Date | null;
}

async function releaseStateOf(db: Db, skill: SkillFacts, baseline: Baseline | null, row: StoredRow | null): Promise<UpstreamReleaseState> {
  return upstreamReleaseState({
    enabled: await getUpstreamReleasesEnabled(),
    eligible: skill.status === "active" && skill.deprecatedAt == null,
    row: row && {
      originUrl: row.origin_url,
      subdir: row.subdir,
      pinKind: row.pin_kind,
      releaseRef: row.release_ref,
      releaseSemver: row.release_semver,
      filesChanged: row.files_changed,
      skippedRef: row.skipped_ref,
    },
    baseline: baseline && { originUrl: baseline.origin_url, subdir: baseline.subdir, ref: baseline.ref },
  });
}

type ProposalRow = { id: string; url: string | null; ref: string | null; subdir: string | null };

/** Open proposals with a usable pointer source — the covering-proposal candidates (§63.5). */
function openProposalPointers(rows: ProposalRow[]): OpenProposalPointer[] {
  return rows.flatMap((r) => (r.url && r.ref ? [{ id: r.id, originUrl: r.url, subdir: r.subdir, ref: r.ref }] : []));
}

async function loadOpenProposals(db: Db, skillId: string): Promise<OpenProposalPointer[]> {
  const { rows } = await db.query<ProposalRow>(OPEN_POINTER_PROPOSALS_SQL, [skillId]);
  return openProposalPointers(rows);
}

/** The baseline's most recent pointer_ref report, ignoring unreachable blips (§63.6).
 *  `scan_reports.subject_id` is text, so a uuid expression is cast. */
const LAST_POINTER_REF_STATUS_SQL = (versionExpr: string) => `
  select status from scan_reports
   where subject_type = 'pointer_ref' and subject_id = (${versionExpr})::text and status <> 'unreachable'
   order by created_at desc limit 1`;

/** Is the baseline's most recent pointer_ref report a drift? (§63.6) */
async function baselineDrifted(db: Db, versionId: string): Promise<boolean> {
  const { rows } = await db.query<{ status: string }>(LAST_POINTER_REF_STATUS_SQL("$1"), [versionId]);
  return rows[0]?.status === "drift";
}

/**
 * The skill page's upstream notice (§63.7), or null. The caller decides the audience — effective
 * maintainers and platform admins only — and passes `isOwner`; everyone else gets null. The notice
 * itself is the shared `upstreamNotice`, the same rule the catalog pill is derived from.
 */
export async function upstreamDetail(skill: SkillFacts & { namespaceSlug: string; slug: string }, isOwner: boolean, db: Db = pool): Promise<UpstreamView | null> {
  if (!isOwner || skill.status !== "active") return null;
  const baseline = await loadBaseline(db, skill.id);
  if (!baseline) return null;
  const row = await loadRow(db, skill.id);
  if (!row) return null;
  const [enabled, drifted, openProposals] = await Promise.all([
    getUpstreamReleasesEnabled(),
    baselineDrifted(db, baseline.id),
    loadOpenProposals(db, skill.id),
  ]);
  const notice = upstreamNotice({
    enabled,
    active: true,
    deprecated: skill.deprecatedAt != null,
    row: noticeRow(row),
    baseline: { id: baseline.id, semver: baseline.semver, originUrl: baseline.origin_url, subdir: baseline.subdir, ref: baseline.ref },
    baselineDrifted: drifted,
    openProposals,
  });
  if (!notice) return null;

  if (notice.kind === "release" && row.release_ref && row.release_semver) {
    const bump = isUpstreamBump(row.release_bump) ? row.release_bump : null;
    return {
      kind: "release",
      currentRef: baseline.ref,
      baselineSemver: baseline.semver,
      release: { ref: row.release_ref, semver: row.release_semver, bump, detectedAt: row.detected_at ? new Date(row.detected_at).toISOString() : null },
      ...(notice.state === "pending"
        ? { proposal: notice.proposalId ? { id: notice.proposalId } : undefined }
        : { skipped: { ref: row.skipped_ref!, byName: row.skipped_by_name, at: row.skipped_at ? new Date(row.skipped_at).toISOString() : null } }),
      proposePath: proposeUpdatePath({ ns: skill.namespaceSlug, slug: skill.slug, ref: row.release_ref, kind: "release", bump }),
    };
  }
  if (notice.kind === "branch_drift") {
    return {
      kind: "branch_drift",
      currentRef: baseline.ref,
      baselineSemver: baseline.semver,
      proposal: notice.proposalId ? { id: notice.proposalId } : undefined,
      proposePath: proposeUpdatePath({ ns: skill.namespaceSlug, slug: skill.slug, ref: baseline.ref, kind: "branch" }),
    };
  }
  return null;
}

/** The shared rules' view of a stored row. */
function noticeRow(row: Pick<StoredRow, "baseline_version_id" | "origin_url" | "subdir" | "pin_kind" | "release_ref" | "release_semver" | "release_bump" | "files_changed" | "skipped_ref">) {
  return {
    baselineVersionId: row.baseline_version_id,
    originUrl: row.origin_url,
    subdir: row.subdir,
    pinKind: row.pin_kind,
    releaseRef: row.release_ref,
    releaseSemver: row.release_semver,
    releaseBump: row.release_bump,
    filesChanged: row.files_changed,
    skippedRef: row.skipped_ref,
  };
}

/**
 * The §63.7 catalog pill for the skills that show one to this viewer, keyed by skill id — in ONE
 * query, never one per card (the §50.6 hype-stats pattern). `skillIds` narrows it to a page of
 * cards; `null` covers everything the viewer can see (the *Updates available* facet's set and
 * count). Only active, non-deprecated pointer skills the viewer owns are considered: a platform
 * admin, an admin of the owning namespace, or an explicit maintainer — the skill page's `isOwner`
 * (`managesMaintainers`). Everyone else gets an empty map. `access` is the caller's resolved access
 * (`resolveUserAccess`), whose `userId` names the explicit maintainer.
 */
export async function upstreamCardUpdates(
  access: EffectiveAccess & { userId?: string | null },
  skillIds: string[] | null,
  db: Db = pool,
): Promise<Map<string, UpstreamCardUpdate>> {
  const out = new Map<string, UpstreamCardUpdate>();
  if (skillIds && skillIds.length === 0) return out;
  const adminNs = [...access.namespaceRoles.entries()].filter(([, r]) => r === "namespace_admin").map(([ns]) => ns);
  if (!access.isPlatformAdmin && adminNs.length === 0 && !access.userId) return out;

  const params: unknown[] = [];
  const where = ["s.type = 'pointer'", "s.status = 'active'", "s.deprecated_at is null"];
  if (!access.isPlatformAdmin) {
    params.push(adminNs, access.userId ?? null);
    where.push(
      `(s.namespace_id = any($${params.length - 1}::uuid[])` +
        ` or exists (select 1 from skill_maintainers sm where sm.skill_id = s.id and sm.user_id = $${params.length}::uuid))`,
    );
  }
  const vis = skillVisibilityWhere(access, params);
  if (vis) where.push(vis);
  if (skillIds) {
    params.push(skillIds);
    where.push(`s.id = any($${params.length}::uuid[])`);
  }
  const [enabled, { rows }] = await Promise.all([
    getUpstreamReleasesEnabled(),
    db.query<
      Pick<StoredRow, "baseline_version_id" | "origin_url" | "subdir" | "pin_kind" | "release_ref" | "release_semver" | "release_bump" | "files_changed" | "skipped_ref"> & {
        skill_id: string;
        b_id: string;
        b_semver: string;
        b_origin_url: string | null;
        b_ref: string | null;
        b_subdir: string | null;
        drifted: boolean;
        proposals: ProposalRow[];
      }
    >(
      `select s.id as skill_id, r.baseline_version_id, r.origin_url, r.subdir, r.pin_kind, r.release_ref, r.release_semver,
              r.release_bump, r.files_changed, r.skipped_ref,
              b.id as b_id, b.semver as b_semver, b.external_origin_url as b_origin_url, b.external_ref as b_ref,
              b.external_subdir as b_subdir,
              coalesce((select d.status = 'drift' from (${LAST_POINTER_REF_STATUS_SQL("b.id")}) d), false) as drifted,
              coalesce((select json_agg(op) from (${openPointerProposalsSql("s.id")}) op), '[]'::json) as proposals
         from skills s
         join skill_upstream_releases r on r.skill_id = s.id
         join lateral (
           select sv.id, sv.semver, sv.external_origin_url, sv.external_ref, sv.external_subdir
             from skill_versions sv
            where sv.skill_id = s.id and sv.status = 'active' and not sv.is_prerelease
            order by skilly_semver_key(sv.semver) desc nulls last, sv.created_at desc
            limit 1
         ) b on true
        where ${where.join(" and ")}`,
      params,
    ),
  ]);
  for (const r of rows) {
    if (!r.b_origin_url || !r.b_ref) continue;
    const update = upstreamCardUpdate({
      enabled,
      active: true,
      deprecated: false,
      row: noticeRow(r),
      baseline: { id: r.b_id, semver: r.b_semver, originUrl: r.b_origin_url, subdir: r.b_subdir, ref: r.b_ref },
      baselineDrifted: r.drifted,
      openProposals: openProposalPointers(r.proposals),
    });
    if (update) out.set(r.skill_id, update);
  }
  return out;
}

export type SkipResult = { ok: true; ref: string } | { ok: false; status: 409; error: "not_pending" | "not_skipped" };

/**
 * Skip the pending release (§63.8). The caller has already checked visibility (404) and authority
 * (403). `ref` must name the currently pending release, else 409 `not_pending`. Audited.
 */
export async function skipUpstreamRelease(
  skill: SkillFacts & { namespaceId: string },
  ref: string,
  actorUserId: string,
): Promise<SkipResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Serialize with the sweep's upsert and a concurrent skip of the same skill.
    await client.query(`select 1 from skill_upstream_releases where skill_id = $1 for update`, [skill.id]);
    const [baseline, row] = await Promise.all([loadBaseline(client, skill.id), loadRow(client, skill.id)]);
    const state = await releaseStateOf(client, skill, baseline, row);
    if (state !== "pending" || !row?.release_ref || row.release_ref !== ref.trim()) {
      await client.query("rollback");
      return { ok: false, status: 409, error: "not_pending" };
    }
    await client.query(
      `update skill_upstream_releases set skipped_ref = release_ref, skipped_by = $2, skipped_at = now() where skill_id = $1`,
      [skill.id, actorUserId],
    );
    await appendAudit(client, {
      actorUserId,
      action: "skill.upstream_release_skipped",
      targetType: "skill",
      targetId: skill.id,
      namespaceId: skill.namespaceId,
      after: { ref: row.release_ref },
    });
    await client.query("commit");
    return { ok: true, ref: row.release_ref };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Un-skip (§63.8): clears the skip; 409 `not_skipped` when there is none. Not re-notified. Audited. */
export async function unskipUpstreamRelease(skill: { id: string; namespaceId: string }, actorUserId: string): Promise<SkipResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ skipped_ref: string | null }>(
      `select skipped_ref from skill_upstream_releases where skill_id = $1 for update`,
      [skill.id],
    );
    const ref = rows[0]?.skipped_ref ?? null;
    if (!ref) {
      await client.query("rollback");
      return { ok: false, status: 409, error: "not_skipped" };
    }
    await client.query(`update skill_upstream_releases set skipped_ref = null, skipped_by = null, skipped_at = null where skill_id = $1`, [skill.id]);
    await appendAudit(client, {
      actorUserId,
      action: "skill.upstream_release_unskipped",
      targetType: "skill",
      targetId: skill.id,
      namespaceId: skill.namespaceId,
      after: { ref },
    });
    await client.query("commit");
    return { ok: true, ref };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
