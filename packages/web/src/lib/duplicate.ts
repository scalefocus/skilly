// Duplicate-skill detection for proposals / direct publish (SKILLY_SPEC.md §8).
//
// A NEW-skill submission shouldn't create a second copy of something already in the catalog —
// the contributor should propose a NEW VERSION of the existing skill instead. We match on two
// identities, both scoped to skills the actor can SEE (so nothing restricted ever leaks) and
// both ACTIVE-only:
//   - POINTER: same slug + same normalized upstream origin URL + same subdir. (A different slug
//     for the same repo is allowed — that's a deliberate fork/rename.) Cross-namespace.
//   - HOSTED: a byte-identical content set — any active version whose content_sha256 matches.
//     Filenames/packaging are disregarded (see contentDigest), so a re-exported bundle still
//     matches. Slug-independent.
// Both run AFTER the slug match (findSlugMatches below), which already redirects every same-slug
// case the submitter can see — so the pointer identity mainly adds the reviewer-side alert for a
// same-slug pointer hidden from the submitter, and the hosted identity catches identical content
// under a DIFFERENT slug.
import type { Pool, PoolClient } from "pg";
import { normalizeOriginUrl, normalizeSubdir, skillVisibilityWhere, findSlugMatches as findSlugMatchesShared, slugExistsMessage, SLUG_EXISTS_CODE, type EffectiveAccess, type SlugMatch, type SlugMatchView } from "@skilly/shared";
import { pool } from "./db";

/**
 * Slug match (§8): every ACTIVE skill (deprecated included) with this slug, in any namespace, that
 * `access` can see. A non-empty result means a NEW-skill submission must become a new version of
 * one of them. Promotions are exempt — callers skip this for a payload with promotedFromSkillVersionId.
 */
export function findSlugMatches(
  access: EffectiveAccess,
  slug: unknown,
  db: Pool | PoolClient = pool,
): Promise<SlugMatch[]> {
  return findSlugMatchesShared(db, access, slug);
}

/**
 * The submit-time gate for a NEW-skill payload (propose + direct publish), or null when it may
 * proceed. Visible slug matches → 409 `slug_exists` with the matches (the form redirects into the
 * new-version flow). A same-namespace skill the submitter can't see still 409s — creating it would
 * hit the (namespace, slug) unique key anyway, and disclosing slug-taken on a write conflict is
 * standard creation semantics (nothing else about it leaks).
 */
export async function newSkillSlugClash(
  access: EffectiveAccess,
  namespaceId: string,
  slug: string,
  db: Pool = pool,
): Promise<Response | null> {
  const matches = await findSlugMatches(access, slug, db);
  if (matches.length > 0) {
    return Response.json({ error: slugExistsMessage(matches), code: SLUG_EXISTS_CODE, matches: matches.map(publicMatch) }, { status: 409 });
  }
  const sameNs = (await db.query(`select 1 from skills where namespace_id = $1 and lower(slug) = lower($2)`, [namespaceId, slug])).rowCount;
  if (sameNs) {
    return Response.json({ error: `a skill named '${slug}' already exists in this namespace — propose a new version of it instead` }, { status: 409 });
  }
  return null;
}

/** A slug match as the API exposes it (no internal skill id). */
export function publicMatch(m: SlugMatch): SlugMatchView {
  return { namespaceSlug: m.namespaceSlug, slug: m.slug, title: m.title, type: m.type, deprecated: m.deprecated };
}

export interface DuplicateMatch {
  namespaceSlug: string;
  skillSlug: string;
  title: string;
}

export interface DuplicateQuery {
  /** Proposed slug — required for the pointer identity. */
  slug?: string | null;
  /** Pointer source being proposed (hosted submissions omit this). */
  pointer?: { url: string; subdir?: string | null } | null;
  /** Content-set digest of the uploaded bundle (hosted submissions only). */
  contentSha256?: string | null;
  /** Skill to exclude from the match (the target of a new-version proposal) — so a new version
   *  legitimately reusing its own skill's content/identity isn't flagged as a duplicate of itself. */
  excludeSkillId?: string | null;
}

/** Invariant #3 via the ONE shared predicate (org ∪ own namespaces ∪ §42 grants); admins see all. */
function visibilityClause(access: EffectiveAccess, params: unknown[]): string {
  return skillVisibilityWhere(access, params, "s") ?? "true";
}

/**
 * Find an existing skill the actor can see that the submission would duplicate, or null. Pointer
 * and hosted are checked independently; the first match wins (hosted first — it's an exact hash).
 */
export async function findDuplicateSkill(
  access: EffectiveAccess,
  q: DuplicateQuery,
  db: Pool = pool,
): Promise<DuplicateMatch | null> {
  // HOSTED: exact content-set match on any active version of a visible, active skill.
  if (q.contentSha256) {
    const params: unknown[] = [q.contentSha256];
    const vis = visibilityClause(access, params);
    let exclude = "";
    if (q.excludeSkillId) { params.push(q.excludeSkillId); exclude = ` and s.id <> $${params.length}`; }
    const { rows } = await db.query<{ namespace_slug: string; skill_slug: string; title: string }>(
      `select n.slug as namespace_slug, s.slug as skill_slug, s.title
         from skill_versions sv
         join skills s on s.id = sv.skill_id
         join namespaces n on n.id = s.namespace_id
        where sv.content_sha256 = $1 and sv.status = 'active' and s.status = 'active' and ${vis}${exclude}
        order by s.created_at asc
        limit 1`,
      params,
    );
    if (rows[0]) return { namespaceSlug: rows[0].namespace_slug, skillSlug: rows[0].skill_slug, title: rows[0].title };
  }

  // POINTER: same slug → cheap candidate set, then compare normalized origin URL + subdir in JS
  // (stored URLs are "as submitted", so canonicalize both sides identically).
  if (q.pointer?.url && q.slug) {
    const wantUrl = normalizeOriginUrl(q.pointer.url);
    const wantSub = normalizeSubdir(q.pointer.subdir);
    const params: unknown[] = [q.slug];
    const vis = visibilityClause(access, params);
    let exclude = "";
    if (q.excludeSkillId) { params.push(q.excludeSkillId); exclude = ` and s.id <> $${params.length}`; }
    const { rows } = await db.query<{ namespace_slug: string; skill_slug: string; title: string; external_origin_url: string | null; external_subdir: string | null }>(
      `select n.slug as namespace_slug, s.slug as skill_slug, s.title,
              sv.external_origin_url, sv.external_subdir
         from skills s
         join namespaces n on n.id = s.namespace_id
         join lateral (
           select external_origin_url, external_subdir
             from skill_versions
            where skill_id = s.id and status = 'active' and external_ref is not null
            order by created_at desc limit 1
         ) sv on true
        where s.status = 'active' and s.type = 'pointer' and s.slug = $1 and ${vis}${exclude}`,
      params,
    );
    for (const r of rows) {
      if (normalizeOriginUrl(r.external_origin_url) === wantUrl && normalizeSubdir(r.external_subdir) === wantSub) {
        return { namespaceSlug: r.namespace_slug, skillSlug: r.skill_slug, title: r.title };
      }
    }
  }

  return null;
}
