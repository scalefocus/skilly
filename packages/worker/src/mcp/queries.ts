// Worker-side catalog reads for the §29 MCP tools.
//
// These are a SECOND implementation of shaping the web tier also does — the accepted trade-off of
// implementing the tools directly on the worker rather than proxying into `/api` with an "act as
// user" credential (§29 "The shared-code decision"). What is NOT duplicated is the access
// decision: every query below takes its visibility predicate from the shared
// `skillVisibilityWhere` (invariant #3) and its roles from the shared resolver (invariant #1).
//
// If you add a query here and hand-write `visibility = 'org' or namespace_id = ...`, you have
// re-introduced exactly the divergence this file's header exists to prevent. Don't.
import type { Pool } from "pg";
import {
  resolveLatest,
  skillVisibilityWhere,
  canReviewNamespace,
  buildSkillResourceUri,
  TOOL_OPTIONS,
  type EffectiveAccess,
} from "@skilly/shared";

export interface SkillHit {
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  description: string;
  type: "hosted" | "pointer";
  visibility: "org" | "namespace";
  toolHarness: string;
  categories: string[];
  tags: string[];
  installCount: number;
  ratingAvg: number;
  ratingCount: number;
  official: boolean;
  latest: string | null;
  updatedAt: string;
  /** The MCP resource URI for this skill's latest stable SKILL.md — saves the agent a guess. */
  resourceUri: string;
}

const HIT_COLUMNS = `n.slug as namespace_slug, s.slug as skill_slug, s.title, s.description, s.type,
        s.visibility, s.tool_harness, s.tags, s.install_count::text as install_count,
        s.rating_sum::text as rating_sum, s.rating_count::text as rating_count,
        (s.official_at is not null) as official,
        coalesce(max(sv.created_at), s.created_at) as updated_at,
        coalesce((select array_agg(c.name order by c.name)
                    from skill_categories sc join categories c on c.id = sc.category_id
                   where sc.skill_id = s.id), '{}') as categories,
        array_remove(array_agg(sv.semver) filter (where sv.status = 'active'), null) as versions`;

const HIT_GROUP_BY = `group by n.slug, s.slug, s.title, s.description, s.type, s.visibility,
        s.tool_harness, s.tags, s.install_count, s.rating_sum, s.rating_count, s.official_at, s.created_at, s.id`;

interface HitRow {
  namespace_slug: string;
  skill_slug: string;
  title: string;
  description: string;
  type: "hosted" | "pointer";
  visibility: "org" | "namespace";
  tool_harness: string;
  categories: string[] | null;
  tags: string[] | null;
  install_count: string;
  rating_sum: string;
  rating_count: string;
  official: boolean;
  updated_at: string;
  versions: string[] | null;
}

function toHit(r: HitRow): SkillHit {
  const ratingCount = Number(r.rating_count);
  return {
    namespaceSlug: r.namespace_slug,
    skillSlug: r.skill_slug,
    title: r.title,
    description: r.description,
    type: r.type,
    visibility: r.visibility,
    toolHarness: r.tool_harness,
    categories: r.categories ?? [],
    tags: r.tags ?? [],
    installCount: Number(r.install_count),
    ratingAvg: ratingCount ? Math.round((Number(r.rating_sum) / ratingCount) * 100) / 100 : 0,
    ratingCount,
    official: r.official,
    latest: resolveLatest(r.versions ?? []),
    updatedAt: r.updated_at,
    resourceUri: buildSkillResourceUri(r.namespace_slug, r.skill_slug),
  };
}

export interface SearchOpts {
  q?: string | null;
  category?: string | null;
  tool?: string | null;
  type?: "hosted" | "pointer" | null;
  sort?: "relevance" | "top_rated" | "latest" | null;
  limit?: number;
  offset?: number;
}

/**
 * The §10 catalog search: the SAME substring predicate (title/slug/description/tags/usage), the
 * same facets, the same name-matches-first ranking — visibility-filtered per invariant #3. Active
 * skills only; archived skills are owner-only and not part of the MCP read surface.
 */
export async function searchSkills(
  pool: Pool,
  access: EffectiveAccess,
  opts: SearchOpts,
): Promise<{ skills: SkillHit[]; total: number }> {
  const params: unknown[] = [];
  const where: string[] = ["s.status = 'active'"];

  const vis = skillVisibilityWhere(access, params);
  if (vis) where.push(vis);

  let titleMatch = "";
  const q = opts.q?.trim();
  if (q) {
    params.push(`%${q}%`);
    const p = params.length;
    titleMatch = `(s.title ilike $${p} or s.slug ilike $${p})`;
    where.push(
      `(${titleMatch} or s.description ilike $${p} or coalesce(s.usage_search, '') ilike $${p}` +
        ` or exists (select 1 from unnest(s.tags) t where t ilike $${p}))`,
    );
  }
  if (opts.category) {
    params.push(opts.category);
    where.push(
      `exists (select 1 from skill_categories sc join categories c on c.id = sc.category_id` +
        ` where sc.skill_id = s.id and c.name = $${params.length})`,
    );
  }
  if (opts.tool) {
    params.push(opts.tool);
    where.push(`s.tool_harness = $${params.length}`);
  }
  if (opts.type) {
    params.push(opts.type);
    where.push(`s.type = $${params.length}`);
  }

  const bayes =
    `((s.rating_sum + 5 * (select coalesce(sum(rating_sum)::numeric / nullif(sum(rating_count), 0), 0) from skills))` +
    ` / (s.rating_count + 5))`;
  const rankOrder = titleMatch ? `case when ${titleMatch} then 0 else 1 end asc,` : "";
  const orderBy =
    opts.sort === "top_rated"
      ? `${bayes} desc, s.rating_count desc, s.install_count desc, s.title asc`
      : opts.sort === "latest"
        ? `coalesce(max(sv.created_at), s.created_at) desc, s.install_count desc, s.title asc`
        : `${rankOrder} s.install_count desc, ${bayes} desc, (s.official_at is not null) desc, s.title asc`;

  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);
  params.push(limit, offset);

  const [hits, count] = await Promise.all([
    pool.query<HitRow>(
      `select ${HIT_COLUMNS}
         from skills s
         join namespaces n on n.id = s.namespace_id
         left join skill_versions sv on sv.skill_id = s.id
        where ${where.join(" and ")}
        ${HIT_GROUP_BY}
        order by ${orderBy}
        limit $${params.length - 1} offset $${params.length}`,
      params,
    ),
    pool.query<{ total: string }>(
      `select count(*)::text as total from skills s join namespaces n on n.id = s.namespace_id where ${where.join(" and ")}`,
      params.slice(0, params.length - 2),
    ),
  ]);
  return { skills: hits.rows.map(toHit), total: Number(count.rows[0]?.total ?? 0) };
}

export interface SkillRef {
  id: string;
  namespaceId: string;
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  status: "active" | "archived";
  visibility: "org" | "namespace";
  type: "hosted" | "pointer";
  toolHarness: string;
}

/**
 * Resolve `ns/slug` to a skill the caller may SEE. Returns null both for "doesn't exist" and for
 * "exists but is invisible to you" — a restricted skill must never be distinguishable from a
 * missing one (invariant #3). Archived skills are owner-only and are not resolved here at all.
 */
export async function findVisibleSkill(
  pool: Pool,
  access: EffectiveAccess,
  namespaceSlug: string,
  skillSlug: string,
): Promise<SkillRef | null> {
  const params: unknown[] = [namespaceSlug, skillSlug];
  const where = ["n.slug = $1", "s.slug = $2", "s.status = 'active'"];
  const vis = skillVisibilityWhere(access, params);
  if (vis) where.push(vis);
  const { rows } = await pool.query<{
    id: string;
    namespace_id: string;
    namespace_slug: string;
    slug: string;
    title: string;
    status: "active" | "archived";
    visibility: "org" | "namespace";
    type: "hosted" | "pointer";
    tool_harness: string;
  }>(
    `select s.id, s.namespace_id, n.slug as namespace_slug, s.slug, s.title, s.status, s.visibility, s.type, s.tool_harness
       from skills s join namespaces n on n.id = s.namespace_id
      where ${where.join(" and ")}`,
    params,
  );
  const r = rows[0];
  return r
    ? {
        id: r.id,
        namespaceId: r.namespace_id,
        namespaceSlug: r.namespace_slug,
        skillSlug: r.slug,
        title: r.title,
        status: r.status,
        visibility: r.visibility,
        type: r.type,
        toolHarness: r.tool_harness,
      }
    : null;
}

export interface VersionRow {
  semver: string;
  status: "active" | "yanked";
  /** Derived from `is_prerelease` — there is no stored channel column (§7). */
  channel: "stable" | "beta";
  gitPublished: boolean;
  createdAt: string;
  whatChanged: string | null;
  artifactObjectKey: string | null;
}

export async function listVersions(pool: Pool, skillId: string): Promise<VersionRow[]> {
  const { rows } = await pool.query<{
    semver: string;
    status: "active" | "yanked";
    is_prerelease: boolean;
    git_published: boolean;
    created_at: string;
    what_changed: string | null;
    artifact_object_key: string | null;
  }>(
    `select semver, status, is_prerelease, git_published, created_at, what_changed, artifact_object_key
       from skill_versions where skill_id = $1 order by created_at desc`,
    [skillId],
  );
  return rows.map((r) => ({
    semver: r.semver,
    status: r.status,
    channel: r.is_prerelease ? ("beta" as const) : ("stable" as const),
    gitPublished: r.git_published,
    createdAt: r.created_at,
    whatChanged: r.what_changed,
    artifactObjectKey: r.artifact_object_key,
  }));
}

/** The highest stable, non-yanked semver — the "latest" a tokenless clone or `latest` ref serves. */
export function latestStable(versions: readonly VersionRow[]): string | null {
  return resolveLatest(versions.filter((v) => v.status === "active").map((v) => v.semver));
}

/**
 * Resolve which version a read refers to. `null` semver = latest stable. A YANKED version is
 * readable only by EXACT pin (matching the git path's warn-and-proceed, §9) and never as `latest`.
 */
export function resolveReadVersion(
  versions: readonly VersionRow[],
  semver: string | null,
): { version: VersionRow; yanked: boolean } | { error: string } {
  if (semver) {
    const v = versions.find((x) => x.semver === semver);
    if (!v) return { error: `version ${semver} not found` };
    return { version: v, yanked: v.status === "yanked" };
  }
  const latest = latestStable(versions);
  if (!latest) return { error: "this skill has no published version yet" };
  const v = versions.find((x) => x.semver === latest)!;
  return { version: v, yanked: false };
}

export interface SkillDetail extends SkillHit {
  maintainers: Array<{ userId: string; name: string }>;
  versions: Array<{ semver: string; status: string; channel: string; createdAt: string; whatChanged: string | null; installable: boolean }>;
  external: { url: string; ref: string; subdir: string | null } | null;
  requiresReview: boolean;
}

export async function getSkillDetail(pool: Pool, skill: SkillRef): Promise<SkillDetail | null> {
  const [hit, versions, maintainers, ns, ext] = await Promise.all([
    pool.query<HitRow>(
      `select ${HIT_COLUMNS}
         from skills s join namespaces n on n.id = s.namespace_id
         left join skill_versions sv on sv.skill_id = s.id
        where s.id = $1 ${HIT_GROUP_BY}`,
      [skill.id],
    ),
    listVersions(pool, skill.id),
    pool.query<{ user_id: string; display_name: string }>(
      `select sm.user_id, u.display_name from skill_maintainers sm join users u on u.id = sm.user_id
        where sm.skill_id = $1 order by lower(u.display_name)`,
      [skill.id],
    ),
    pool.query<{ require_review: boolean }>(`select require_review from namespaces where id = $1`, [skill.namespaceId]),
    pool.query<{ external_origin_url: string | null; external_ref: string | null; external_subdir: string | null }>(
      `select external_origin_url, external_ref, external_subdir from skill_versions
        where skill_id = $1 and external_origin_url is not null order by created_at desc limit 1`,
      [skill.id],
    ),
  ]);
  const base = hit.rows[0];
  if (!base) return null;
  const e = ext.rows[0];
  return {
    ...toHit(base),
    maintainers: maintainers.rows.map((m) => ({ userId: m.user_id, name: m.display_name })),
    versions: versions.map((v) => ({
      semver: v.semver,
      status: v.status,
      channel: v.channel,
      createdAt: v.createdAt,
      whatChanged: v.whatChanged,
      installable: v.status === "active" && v.gitPublished,
    })),
    external: e?.external_origin_url ? { url: e.external_origin_url, ref: e.external_ref ?? "", subdir: e.external_subdir } : null,
    requiresReview: ns.rows[0]?.require_review ?? true,
  };
}

/** Categories, harnesses, visible namespaces and the limits an agent needs before proposing. */
export async function registryMetadata(
  pool: Pool,
  access: EffectiveAccess,
): Promise<{
  categories: string[];
  namespaces: Array<{ slug: string; name: string; requiresReview: boolean; canPropose: boolean; canReview: boolean }>;
  toolHarnesses: string[];
}> {
  const [cats, namespaces] = await Promise.all([
    pool.query<{ name: string }>(`select name from categories order by name asc`),
    pool.query<{ id: string; slug: string; display_name: string; require_review: boolean }>(
      `select id, slug, display_name, require_review from namespaces order by slug asc`,
    ),
  ]);
  return {
    categories: cats.rows.map((r) => r.name),
    // Every authenticated user may propose (§4 implicit capability) — the namespace list is about
    // where a proposal LANDS and who will review it, not about gating the tool.
    namespaces: namespaces.rows.map((n) => ({
      slug: n.slug,
      name: n.display_name,
      requiresReview: n.require_review,
      canPropose: true,
      canReview: canReviewNamespace(access, n.id),
    })),
    // The closed tool/harness vocabulary (§8) — an agent needs it before it can fill a proposal.
    toolHarnesses: TOOL_OPTIONS.map((a) => a.slug),
  };
}

/** Resolve a namespace slug to its id + review flag. */
export async function findNamespace(
  pool: Pool,
  slug: string,
): Promise<{ id: string; slug: string; requiresReview: boolean } | null> {
  const { rows } = await pool.query<{ id: string; slug: string; require_review: boolean }>(
    `select id, slug, require_review from namespaces where slug = $1`,
    [slug],
  );
  const r = rows[0];
  return r ? { id: r.id, slug: r.slug, requiresReview: r.require_review } : null;
}
