// Catalog read helpers (web). SKILLY_SPEC.md §6, §7, §10.
import { pool } from "./db";
import { resolveLatest, resolveDownloadExt, type EffectiveAccess } from "@skilly/shared";
import { M } from "./metrics";
import { createTtlCache } from "./ttlCache";

export interface SkillRow {
  id: string;
  namespaceId: string;
  namespaceSlug: string;
  slug: string;
  visibility: "org" | "namespace";
  status: "active" | "archived";
  /** the skill's coding-agent slug; drives the install command's `--agent` flag (§9) */
  toolHarness: string;
  createdAt: string;
  /** newest version's created_at (versions are immutable, so this IS the last update) — falls back to createdAt */
  updatedAt: string;
  /** Platform-admin "Official" endorsement (§7): true when official_at is set. */
  official: boolean;
  /** When it was marked Official (UTC ISO), or null. */
  officialAt: string | null;
  /** Display name of the admin who marked it Official, or null. */
  officialByName: string | null;
  /** Platform-admin "Featured" homepage spotlight (§7): true when featured_at is set. */
  featured: boolean;
  /** When it was Featured (UTC ISO), or null. */
  featuredAt: string | null;
}

export async function findSkill(namespaceSlug: string, skillSlug: string): Promise<SkillRow | null> {
  const { rows } = await pool.query<{
    id: string;
    namespace_id: string;
    namespace_slug: string;
    slug: string;
    visibility: "org" | "namespace";
    status: "active" | "archived";
    tool_harness: string;
    created_at: string;
    updated_at: string;
    official_at: string | null;
    official_by_name: string | null;
    featured_at: string | null;
  }>(
    `select s.id, s.namespace_id, n.slug as namespace_slug, s.slug, s.visibility, s.status, s.tool_harness, s.created_at,
            s.official_at, ob.display_name as official_by_name, s.featured_at,
            coalesce((select max(sv.created_at) from skill_versions sv where sv.skill_id = s.id), s.created_at) as updated_at
       from skills s join namespaces n on n.id = s.namespace_id
       left join users ob on ob.id = s.official_by
      where n.slug = $1 and s.slug = $2`,
    [namespaceSlug, skillSlug],
  );
  const r = rows[0];
  return r
    ? {
        id: r.id,
        namespaceId: r.namespace_id,
        namespaceSlug: r.namespace_slug,
        slug: r.slug,
        visibility: r.visibility,
        status: r.status,
        toolHarness: r.tool_harness,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        official: r.official_at != null,
        officialAt: r.official_at,
        officialByName: r.official_by_name,
        featured: r.featured_at != null,
        featuredAt: r.featured_at,
      }
    : null;
}

/** Highest stable, non-yanked version of a skill, or null if none published. */
export async function latestStableSemver(skillId: string): Promise<string | null> {
  const { rows } = await pool.query<{ semver: string }>(
    `select semver from skill_versions where skill_id = $1 and status = 'active'`,
    [skillId],
  );
  return resolveLatest(rows.map((r) => r.semver));
}

export interface CatalogEntry {
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
  ratingAvg: number; // raw average (0 when unrated)
  ratingCount: number;
  watcherCount: number; // # of users watching/following this skill
  status: "active" | "archived";
  latest: string | null;
  /** Newest version's created_at (publishing a version IS the update), else the skill's
   *  created_at. UTC ISO — the UI converts/styles it for the detail page. */
  updatedAt: string;
  /** The skill row's own created_at (UTC ISO) — when it first appeared in the catalog. */
  createdAt: string;
  /** Platform-admin "Official" endorsement (§7) — drives the catalog badge + facet. */
  official: boolean;
  /** True when this skill became visible to the CALLER after their last catalog visit, i.e. it's
   *  "new to you" (created_at > the user's catalog_seen_at). NOT a global 30-day window — it's
   *  per-user and matches the Catalog nav "new items" count. False when the caller has no
   *  last-seen marker passed (e.g. non-catalog callers). §10. */
  isNew: boolean;
}

/** All known category names (labels) — powers the propose form's category combobox. */
export async function listAllCategories(): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(`select name from categories order by name asc`);
  return rows.map((r) => r.name);
}

/**
 * Append the shared free-text predicate (substring ILIKE over title/slug/description/usage/tags)
 * to `where`, pushing the escaped `%term%` onto `params`. Returns a SQL expression that is true
 * when the match is on the NAME (title or slug) — used to sort name matches first (§10). LIKE
 * metacharacters in `q` are escaped so "%"/"_" can't widen the match or scan-bomb. Shared by the
 * catalog grid (searchSkills) and the header dropdown (suggestSkills) so they match identically.
 */
function ilikeSearch(params: unknown[], q: string, where: string[]): string {
  const term = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  params.push(term);
  const t = params.length;
  where.push(
    `(s.title ilike $${t} escape '\\' or s.slug ilike $${t} escape '\\'` +
      ` or s.description ilike $${t} escape '\\'` +
      ` or coalesce(s.usage_search, '') ilike $${t} escape '\\'` +
      ` or array_to_string(s.tags, ' ') ilike $${t} escape '\\')`,
  );
  return `(s.title ilike $${t} escape '\\' or s.slug ilike $${t} escape '\\')`;
}

/**
 * Visibility-filtered catalog search. INVARIANT (#3): restricted skills never appear for
 * users outside their namespace. Substring ILIKE over title/slug/description/usage/tags when
 * `q` is set (name matches ranked first; §10).
 */
export async function searchSkills(
  access: EffectiveAccess,
  opts: { q?: string; category?: string; tool?: string; type?: "hosted" | "pointer"; sort?: "top_rated" | "latest"; limit?: number; archivedOnly?: boolean; officialOnly?: boolean; featuredOnly?: boolean; ownerUserId?: string | null; maintainerUserId?: string | null; catalogSeenAt?: string | null },
): Promise<CatalogEntry[]> {
  M.searches.inc();
  const params: unknown[] = [];
  const where: string[] = [];

  // Status: by default only `active` is shown (visibility-filtered below). The archived toggle
  // flips to showing ONLY archived skills, and only those the caller OWNS (platform admin → all;
  // namespace admin → their namespaces; maintainer → maintained) — so "listed in the archived
  // view" always equals "openable + restorable". §7, ownership matrix §19/§21.
  if (opts.archivedOnly) {
    if (access.isPlatformAdmin) {
      where.push("s.status = 'archived'");
    } else {
      const adminNs = [...access.namespaceRoles.entries()].filter(([, r]) => r === "namespace_admin").map(([ns]) => ns);
      params.push(adminNs);
      const a = params.length;
      params.push(opts.ownerUserId ?? null);
      const u = params.length;
      where.push(
        `s.status = 'archived' and (s.namespace_id = any($${a}::uuid[])` +
          ` or exists (select 1 from skill_maintainers sm where sm.skill_id = s.id and sm.user_id = $${u}))`,
      );
    }
  } else {
    where.push("s.status = 'active'");
  }

  if (!access.isPlatformAdmin) {
    const nsIds = [...access.namespaceRoles.keys()];
    params.push(nsIds);
    where.push(`(s.visibility = 'org' or s.namespace_id = any($${params.length}::uuid[]))`);
  }
  // Free-text search is substring ILIKE (NOT full-text), so the catalog grid and the header
  // dropdown match IDENTICALLY and respond to partial words as you type (§10). Trade-off: no
  // ts_rank relevance score — ordering instead surfaces name matches first (titleMatch below),
  // then popularity. Shared with suggestSkills via ilikeSearch so the two can't drift.
  let titleMatch = "";
  if (opts.q) {
    titleMatch = ilikeSearch(params, opts.q, where);
  }
  if (opts.category) {
    params.push(opts.category);
    where.push(`exists (select 1 from skill_categories sc join categories c on c.id = sc.category_id where sc.skill_id = s.id and c.name = $${params.length})`);
  }
  if (opts.tool) {
    params.push(opts.tool);
    where.push(`s.tool_harness = $${params.length}`);
  }
  if (opts.type) {
    params.push(opts.type);
    where.push(`s.type = $${params.length}`);
  }
  // "Official only" facet (§7): platform-endorsed skills. No param needed — a static predicate.
  if (opts.officialOnly) {
    where.push(`s.official_at is not null`);
  }
  // "Featured" homepage feed (§7): currently-Featured skills that are ALSO installable (have an
  // active, git-served version). A Featured-but-not-yet-installable skill (e.g. mid-publish, or
  // all versions yanked) is filtered out here even though its flag persists. Ordered
  // most-recently-featured first (orderBy below). Static predicates — no params.
  if (opts.featuredOnly) {
    where.push(`s.featured_at is not null`);
    where.push(`exists (select 1 from skill_versions sv2 where sv2.skill_id = s.id and sv2.status = 'active' and sv2.git_published)`);
  }
  // "My Skills": only skills the caller is an EXPLICIT maintainer of (skill_maintainers, §19) —
  // matching the `maintainsSkills` definition in /api/me. Namespace-admin (implicit) maintainership
  // is intentionally NOT included here: "My Skills" means skills named to me, not every skill in a
  // namespace I administer. (Visibility is still enforced by the predicate above.)
  if (opts.maintainerUserId) {
    params.push(opts.maintainerUserId);
    where.push(`exists (select 1 from skill_maintainers sm where sm.skill_id = s.id and sm.user_id = $${params.length})`);
  }
  params.push(Math.min(100, opts.limit ?? 60));
  const limitIdx = params.length;
  // Relevance proxy when searching: name (title/slug) matches sort ahead of description/tag-only
  // matches; popularity (install_count) breaks the tie below. Only the default ("relevance") sort
  // uses it — Top rated / Latest stay explicit, popularity/recency-first.
  const rankOrder = titleMatch ? `case when ${titleMatch} then 0 else 1 end asc,` : "";

  // Bayesian-smoothed rating (§18): (sum + C*m)/(count + C), C=5 prior votes, m=global mean.
  // m is an uncorrelated scalar subquery (evaluated once); rating_sum/count ride on s.id (PK,
  // already in GROUP BY), so this is valid in ORDER BY without extra grouping. A lone 5★ skill
  // can't outrank an established 4.6★ one.
  const bayes =
    `((s.rating_sum + 5 * (select coalesce(sum(rating_sum)::numeric / nullif(sum(rating_count), 0), 0) from skills))` +
    ` / (s.rating_count + 5))`;
  // "Top rated" sorts by the smoothed score directly; "Latest" by most-recently-updated;
  // default keeps install_count primary with the smoothed rating as the final tiebreaker.
  const orderBy = opts.featuredOnly
    ? // Featured feed (§7): most-recently-featured first (s.id is in GROUP BY, so s.featured_at is valid here).
      `s.featured_at desc, s.title asc`
    : opts.sort === "top_rated"
      ? `${bayes} desc, s.rating_count desc, s.install_count desc, s.title asc`
      : opts.sort === "latest"
        ? // "last update" = newest version's created_at (publishing a version is the update),
          // falling back to the skill's own created_at. Mirrors findSkill's updatedAt.
          `coalesce(max(sv.created_at), s.created_at) desc, s.install_count desc, s.title asc`
        : // Default ("relevance"/popular): name-match → popularity → smoothed rating, then Official
          // as a GENTLE final tiebreaker (§7) so it nudges without overriding a better match.
          `${rankOrder} s.install_count desc, ${bayes} desc, (s.official_at is not null) desc, s.title asc`;

  // Categories are aggregated via a correlated subquery so the join doesn't inflate the
  // version array_agg below.
  const { rows } = await pool.query<{
    namespace_slug: string; skill_slug: string; title: string; description: string;
    type: "hosted" | "pointer"; visibility: "org" | "namespace"; tool_harness: string;
    categories: string[] | null; tags: string[]; install_count: string;
    rating_sum: string; rating_count: string; watcher_count: string; status: "active" | "archived";
    created_at: string; updated_at: string; versions: string[] | null; official: boolean;
  }>(
    `select n.slug as namespace_slug, s.slug as skill_slug, s.title, s.description, s.type,
            s.visibility, s.tool_harness, s.tags, s.install_count::text as install_count,
            s.rating_sum::text as rating_sum, s.rating_count::text as rating_count, s.status,
            (s.official_at is not null) as official,
            s.created_at as created_at,
            coalesce(max(sv.created_at), s.created_at) as updated_at,
            s.watcher_count::text as watcher_count,
            coalesce((select array_agg(c.name order by c.name)
                        from skill_categories sc join categories c on c.id = sc.category_id
                       where sc.skill_id = s.id), '{}') as categories,
            array_remove(array_agg(sv.semver) filter (where sv.status = 'active'), null) as versions
       from skills s
       join namespaces n on n.id = s.namespace_id
       left join skill_versions sv on sv.skill_id = s.id
      where ${where.join(" and ")}
      group by n.slug, s.slug, s.title, s.description, s.type, s.visibility, s.tool_harness, s.tags, s.install_count, s.status, s.id
      order by ${orderBy}
      limit $${limitIdx}`,
    params,
  );

  // "New to you": the skill row was created after the caller last opened the catalog. Compared in
  // epoch-ms so it's tz-agnostic; absent a seen marker (non-catalog callers) nothing is flagged.
  const seenMs = opts.catalogSeenAt ? new Date(opts.catalogSeenAt).getTime() : NaN;
  return rows.map((r) => {
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
      ratingAvg: ratingCount ? Number(r.rating_sum) / ratingCount : 0,
      ratingCount,
      watcherCount: Number(r.watcher_count),
      status: r.status,
      latest: resolveLatest(r.versions ?? []),
      updatedAt: r.updated_at,
      createdAt: r.created_at,
      official: r.official,
      isNew: !Number.isNaN(seenMs) && new Date(r.created_at).getTime() > seenMs,
    };
  });
}

/**
 * The homepage "Featured skills" feed (§7): platform-admin-pinned skills, visibility-filtered per
 * viewer (invariant #3, enforced inside searchSkills), restricted to those with a live installable
 * version, ordered most-recently-featured first. NOT sliced to the cap — every currently-Featured
 * skill the viewer may see is returned (a just-lowered cap can briefly exceed it). Empty ⇒ the
 * caller hides the section.
 */
export async function listFeaturedSkills(access: EffectiveAccess): Promise<CatalogEntry[]> {
  // limit 100 ≥ the cap ceiling (FEATURED_MAX_MAX = 50), so the feed is never truncated below the set.
  return searchSkills(access, { featuredOnly: true, limit: 100 });
}

export interface RelatedSkillsResult {
  /** Up to `show` neighbours the viewer can see and hasn't adopted yet (catalog-card shaped). */
  related: CatalogEntry[];
  /** True when there WERE visible neighbours but the viewer has installed every one — drives the
   *  "You have all related skills" message. False when there were none to show at all (hide). */
  allInstalled: boolean;
}

/**
 * "Skills you might like" (§10): the top co-installed skills for `skillId`, from the nightly
 * precompute (related_skills, migration 0046). Pure co-install signal — skills most-often adopted
 * by the same users. Visibility-filtered per viewer (INVARIANT #3: restricted skills never surface
 * to outsiders), active only, AND excluding skills the viewer has **already adopted** (a
 * `skill_installs` row — git install OR download, uninstall-agnostic, so one they installed then
 * removed stays excluded). Returns up to `show` (default 3) not-yet-installed neighbours plus
 * `allInstalled` (see the interface). The precompute stores a wider candidate list per skill so
 * this still fills after dropping ones the viewer can't see or has installed.
 */
export async function relatedSkills(access: EffectiveAccess, skillId: string, viewerUserId: string | null, show = 3): Promise<RelatedSkillsResult> {
  const params: unknown[] = [skillId];
  const where: string[] = ["rs.skill_id = $1", "s.status = 'active'"];
  if (!access.isPlatformAdmin) {
    params.push([...access.namespaceRoles.keys()]);
    where.push(`(s.visibility = 'org' or s.namespace_id = any($${params.length}::uuid[]))`);
  }
  params.push(viewerUserId);
  const viewerIdx = params.length;
  // Fetch the whole VISIBLE candidate set (the precompute already caps at the top-N per skill, so
  // no LIMIT is needed), each flagged with whether the viewer has adopted it. That lets us drop
  // installed ones AND distinguish "all installed" (message) from "nothing to show" (hide).
  const { rows } = await pool.query<{
    namespace_slug: string; skill_slug: string; title: string; description: string;
    type: "hosted" | "pointer"; visibility: "org" | "namespace"; tool_harness: string;
    categories: string[] | null; tags: string[]; install_count: string;
    rating_sum: string; rating_count: string; watcher_count: string; status: "active" | "archived";
    created_at: string; updated_at: string; versions: string[] | null; official: boolean; installed: boolean;
  }>(
    `select n.slug as namespace_slug, s.slug as skill_slug, s.title, s.description, s.type,
            s.visibility, s.tool_harness, s.tags, s.install_count::text as install_count,
            s.rating_sum::text as rating_sum, s.rating_count::text as rating_count, s.status,
            (s.official_at is not null) as official, s.created_at as created_at,
            coalesce(max(sv.created_at), s.created_at) as updated_at,
            s.watcher_count::text as watcher_count,
            exists (select 1 from skill_installs si where si.skill_id = s.id and si.user_id = $${viewerIdx}) as installed,
            coalesce((select array_agg(c.name order by c.name)
                        from skill_categories sc join categories c on c.id = sc.category_id
                       where sc.skill_id = s.id), '{}') as categories,
            array_remove(array_agg(sv.semver) filter (where sv.status = 'active'), null) as versions
       from related_skills rs
       join skills s on s.id = rs.related_skill_id
       join namespaces n on n.id = s.namespace_id
       left join skill_versions sv on sv.skill_id = s.id
      where ${where.join(" and ")}
      group by n.slug, s.slug, s.id, rs.shared_count
      order by rs.shared_count desc, s.install_count desc, s.title asc`,
    params,
  );
  const toEntry = (r: (typeof rows)[number]): CatalogEntry => {
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
      ratingAvg: ratingCount ? Number(r.rating_sum) / ratingCount : 0,
      ratingCount,
      watcherCount: Number(r.watcher_count),
      status: r.status,
      latest: resolveLatest(r.versions ?? []),
      updatedAt: r.updated_at,
      createdAt: r.created_at,
      official: r.official,
      isNew: false, // not a catalog listing — the "new to you" badge doesn't apply here
    };
  };
  const related = rows.filter((r) => !r.installed).slice(0, Math.max(1, show)).map(toEntry);
  // "You have all related skills" only when there were visible neighbours but none remain after
  // dropping the ones the viewer has installed. No visible neighbours at all ⇒ allInstalled false ⇒ hide.
  const allInstalled = rows.length > 0 && related.length === 0;
  return { related, allInstalled };
}

export interface PendingMirrorStatus { semver: string; attempts: number; failed: boolean; lastError: string | null }

/**
 * Status of a pointer skill's outstanding mirror, if any. The worker DELETES the
 * pending_mirrors row on success, so a lingering row means the version hasn't materialized
 * yet: still being attempted (`failed: false`) or dead-lettered after the attempt cap
 * (`failed: true`). Lets the detail page explain why a freshly-published pointer skill has
 * no installable version yet, instead of a bare "No published version".
 */
export async function pendingMirrorStatus(skillId: string): Promise<PendingMirrorStatus | null> {
  const max = Number(process.env.MIRROR_MAX_ATTEMPTS ?? 5);
  const { rows } = await pool.query<{ semver: string; attempts: number; last_error: string | null }>(
    `select semver, attempts, last_error from pending_mirrors where skill_id = $1 order by created_at desc limit 1`,
    [skillId],
  );
  const r = rows[0];
  if (!r) return null;
  return { semver: r.semver, attempts: r.attempts, failed: r.attempts >= max, lastError: r.last_error };
}

export interface SkillSuggestion { namespaceSlug: string; skillSlug: string; title: string; official: boolean }

/**
 * Lightweight autocomplete for the header search box. Visibility-filtered like the catalog
 * (#3 — restricted skills never surface). Deliberately cheap to bound DoS exposure:
 *  - the caller requires q.length >= 3 and caps it (the route does both),
 *  - substring ILIKE on title/slug only — NO ranking, NO joins, NO aggregates,
 *  - returns at most `limit` (≤10) minimal rows, active skills only.
 */
export async function suggestSkills(access: EffectiveAccess, q: string, limit = 5, opts: { orgOnly?: boolean } = {}): Promise<SkillSuggestion[]> {
  const params: unknown[] = [];
  const where: string[] = ["s.status = 'active'"];
  if (opts.orgOnly) {
    // Requested-skill "propose an existing skill" fulfilment (§26): the picked skill must be
    // openable by everyone, including the requester, so it's restricted to org-visible skills
    // regardless of the searching user's own namespace access.
    where.push(`s.visibility = 'org'`);
  } else if (!access.isPlatformAdmin) {
    params.push([...access.namespaceRoles.keys()]);
    where.push(`(s.visibility = 'org' or s.namespace_id = any($${params.length}::uuid[]))`);
  }
  // Same substring predicate + name-match expression as the catalog grid (§10) so the dropdown's
  // 5 results are a true prefix of what the catalog shows for the same query.
  const titleMatch = ilikeSearch(params, q, where);
  params.push(Math.min(10, Math.max(1, limit)));
  const { rows } = await pool.query<{ namespace_slug: string; skill_slug: string; title: string; official: boolean }>(
    `select n.slug as namespace_slug, s.slug as skill_slug, s.title, (s.official_at is not null) as official
       from skills s join namespaces n on n.id = s.namespace_id
      where ${where.join(" and ")}
      order by case when ${titleMatch} then 0 else 1 end asc, s.install_count desc, s.title asc
      limit $${params.length}`,
    params,
  );
  return rows.map((r) => ({ namespaceSlug: r.namespace_slug, skillSlug: r.skill_slug, title: r.title, official: r.official }));
}

export interface Facets {
  categories: { name: string; count: number }[];
  tools: { name: string; count: number }[];
  /** Source type: "hosted" vs "pointer" (shown as Hosted / External). */
  types: { name: "hosted" | "pointer"; count: number }[];
}

/**
 * Facet counts (category + tool/harness) over the skills VISIBLE to the caller. Reuses the
 * same visibility predicate as searchSkills so restricted skills never inflate counts (#3).
 */
// Facet counts change only on publish/archive, so cache per visibility scope for a short window.
// Key = "admin" (sees all) or the sorted namespace-id list (what the visibility predicate uses).
const FACETS_TTL_MS = Number(process.env.FACETS_CACHE_TTL_MS ?? 30_000);
const facetsCache = createTtlCache<Facets>(FACETS_TTL_MS);

export async function listFacets(access: EffectiveAccess): Promise<Facets> {
  const key = access.isPlatformAdmin ? "admin" : [...access.namespaceRoles.keys()].sort().join(",");
  return facetsCache.get(key, () => computeFacets(access));
}

async function computeFacets(access: EffectiveAccess): Promise<Facets> {
  const params: unknown[] = [];
  const where: string[] = ["s.status = 'active'"];
  if (!access.isPlatformAdmin) {
    params.push([...access.namespaceRoles.keys()]);
    where.push(`(s.visibility = 'org' or s.namespace_id = any($${params.length}::uuid[]))`);
  }
  const clause = where.join(" and ");

  const [cats, tools, types] = await Promise.all([
    pool.query<{ name: string; count: string }>(
      `select c.name, count(distinct s.id)::text as count
         from skills s
         join skill_categories sc on sc.skill_id = s.id
         join categories c on c.id = sc.category_id
        where ${clause}
        group by c.name order by count(distinct s.id) desc, c.name asc`,
      params,
    ),
    pool.query<{ name: string; count: string }>(
      `select s.tool_harness as name, count(*)::text as count
         from skills s
        where ${clause}
        group by s.tool_harness order by count(*) desc, s.tool_harness asc`,
      params,
    ),
    pool.query<{ name: "hosted" | "pointer"; count: string }>(
      `select s.type as name, count(*)::text as count
         from skills s
        where ${clause}
        group by s.type order by count(*) desc, s.type asc`,
      params,
    ),
  ]);

  return {
    categories: cats.rows.map((r) => ({ name: r.name, count: Number(r.count) })),
    tools: tools.rows.map((r) => ({ name: r.name, count: Number(r.count) })),
    types: types.rows.map((r) => ({ name: r.name, count: Number(r.count) })),
  };
}

/** Usage examples of the latest stable active version (the one the detail page features). §20. */
export async function latestVersionUsage(skillId: string): Promise<string | null> {
  const { rows } = await pool.query<{ semver: string; usage_examples: string | null }>(
    `select semver, usage_examples from skill_versions where skill_id = $1 and status = 'active'`,
    [skillId],
  );
  const latest = resolveLatest(rows.map((r) => r.semver));
  return rows.find((r) => r.semver === latest)?.usage_examples ?? null;
}

export interface SkillVersionView {
  semver: string;
  channel: "stable" | "beta";
  status: "active" | "yanked";
  createdAt: string;
  /** True once the serving git repo has this version's tag synthesized (the publish sweep ran).
   *  A version is only INSTALLABLE when this is true — until then `npx skills add` would 404. */
  gitPublished: boolean;
  /** Extension the detail-page download serves for this version (original upload's ext, else a
   *  harness/type fallback) — drives the download button's label. §6/§10. */
  downloadExt: string;
  /** Per-version "What changed" note (plain text; §8/§10). Null on first versions / promotions. */
  whatChanged: string | null;
}

export async function listVersions(skillId: string): Promise<SkillVersionView[]> {
  const { rows } = await pool.query<{ semver: string; is_prerelease: boolean; status: "active" | "yanked"; created_at: string; git_published: boolean; artifact_filename: string | null; external_ref: string | null; tool_harness: string; what_changed: string | null }>(
    `select sv.semver, sv.is_prerelease, sv.status, sv.created_at, sv.git_published,
            sv.artifact_filename, sv.external_ref, sv.what_changed, s.tool_harness
       from skill_versions sv join skills s on s.id = sv.skill_id
      where sv.skill_id = $1 order by sv.created_at desc`,
    [skillId],
  );
  return rows.map((r) => ({
    semver: r.semver,
    channel: r.is_prerelease ? "beta" : "stable",
    status: r.status,
    createdAt: r.created_at,
    gitPublished: r.git_published,
    downloadExt: resolveDownloadExt({ artifactFilename: r.artifact_filename, isPointer: !!r.external_ref, toolHarness: r.tool_harness }),
    whatChanged: r.what_changed,
  }));
}

export interface PointerSource {
  originUrl: string;
  /** Folder inside the upstream repo that was mirrored (multi-skill repos); null = repo root. §6. */
  subdir: string | null;
}

/** Upstream provenance for a Pointer skill (latest active version), or null for Hosted skills. */
export async function pointerSource(skillId: string): Promise<PointerSource | null> {
  const { rows } = await pool.query<{ external_origin_url: string | null; external_subdir: string | null }>(
    `select external_origin_url, external_subdir from skill_versions
       where skill_id = $1 and status = 'active' and external_ref is not null
       order by created_at desc limit 1`,
    [skillId],
  );
  const r = rows[0];
  if (!r?.external_origin_url) return null;
  return { originUrl: r.external_origin_url, subdir: r.external_subdir };
}

export interface SkillFormDefaults {
  title: string;
  description: string;
  toolHarness: string;
  tags: string[];
  categories: string[];
  type: "hosted" | "pointer";
}

/** Skill-level metadata used to pre-fill the "propose new version" form (locked fields). */
export async function skillFormDefaults(skillId: string): Promise<SkillFormDefaults | null> {
  const { rows } = await pool.query<{
    title: string; description: string; tool_harness: string; tags: string[] | null;
    type: "hosted" | "pointer"; categories: string[] | null;
  }>(
    `select s.title, s.description, s.tool_harness, s.tags, s.type,
            coalesce((select array_agg(c.name order by c.name)
                        from skill_categories sc join categories c on c.id = sc.category_id
                       where sc.skill_id = s.id), '{}') as categories
       from skills s where s.id = $1`,
    [skillId],
  );
  const r = rows[0];
  if (!r) return null;
  return { title: r.title, description: r.description, toolHarness: r.tool_harness, tags: r.tags ?? [], categories: r.categories ?? [], type: r.type };
}
