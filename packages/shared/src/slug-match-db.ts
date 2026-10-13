// The slug-match query (SKILLY_SPEC.md §8), shared by web (propose/publish/accept, the live lookup,
// the review-page alert) and worker (the MCP propose tools + check_duplicate) so who-matches-what is
// decided once. Plain SQL over a minimal query interface; no pg import.
import type { EffectiveAccess } from "./rbac.js";
import { skillVisibilityWhere } from "./visibility.js";
import { normalizeMatchSlug, type SlugMatch } from "./slug-match.js";

/**
 * Serialize new-skill creation per slug for the rest of the transaction (§8): two accepts (or an
 * accept and a direct publish) of the same new slug in different namespaces would otherwise both
 * pass the slug-match check before either commits — the unique key is only per namespace. Take it
 * BEFORE the check; it is released at commit/rollback.
 */
export async function lockSlugForCreate(db: SlugMatchDb, slug: unknown): Promise<void> {
  await db.query(`select pg_advisory_xact_lock(hashtext($1))`, [`slugmatch:${normalizeMatchSlug(slug)}`]);
}

export interface SlugMatchDb {
  query(text: string, params?: any[]): Promise<{ rows: any[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * Every ACTIVE skill (deprecated included, archived never) with this slug, across all namespaces,
 * that `access` can see — through the one shared visibility predicate (invariant #3), so a hidden
 * skill is never returned, counted or hinted at. Oldest first (a stable order for the chooser).
 */
export async function findSlugMatches(
  db: SlugMatchDb,
  access: Pick<EffectiveAccess, "isPlatformAdmin" | "namespaceRoles">,
  slug: unknown,
  opts: { excludeSkillId?: string | null } = {},
): Promise<SlugMatch[]> {
  const want = normalizeMatchSlug(slug);
  if (!want) return [];
  const params: unknown[] = [want];
  const where = ["lower(s.slug) = $1", "s.status = 'active'"];
  const vis = skillVisibilityWhere(access, params, "s");
  if (vis) where.push(vis);
  if (opts.excludeSkillId) {
    params.push(opts.excludeSkillId);
    where.push(`s.id <> $${params.length}`);
  }
  const { rows } = await db.query(
    `select s.id, n.slug as namespace_slug, s.slug, s.title, s.type, (s.deprecated_at is not null) as deprecated
       from skills s join namespaces n on n.id = s.namespace_id
      where ${where.join(" and ")}
      order by s.created_at asc, s.id asc`,
    params,
  );
  return (rows as { id: string; namespace_slug: string; slug: string; title: string; type: string; deprecated: boolean }[]).map((r) => ({
    skillId: r.id,
    namespaceSlug: r.namespace_slug,
    slug: r.slug,
    title: r.title,
    type: r.type === "pointer" ? "pointer" : "hosted",
    deprecated: !!r.deprecated,
  }));
}
