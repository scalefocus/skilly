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
// The SAME-namespace+same-slug case is handled earlier by the slug-uniqueness 409; this catches
// the cross-namespace and identical-content cases that slug-uniqueness misses.
import type { Pool } from "pg";
import { normalizeOriginUrl, normalizeSubdir, type EffectiveAccess } from "@skilly/shared";
import { pool } from "./db";

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

/** Visibility predicate mirroring searchSkills (#3): admins see all; others see org + own ns. */
function visibilityClause(access: EffectiveAccess, params: unknown[]): string {
  if (access.isPlatformAdmin) return "true";
  params.push([...access.namespaceRoles.keys()]);
  return `(s.visibility = 'org' or s.namespace_id = any($${params.length}::uuid[]))`;
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
