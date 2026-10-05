// Skill collections (SKILLY_SPEC.md §37). The rules both tiers must agree on:
//
//   - the limits and the name/description validation (§37.1);
//   - the ELIGIBILITY predicate — a member must be org-visible, active and installable — and the
//     ONE eviction statement every lifecycle path runs when a skill stops qualifying (§37.4);
//   - the eligible-member count, which every read uses so a missed eviction can never surface;
//   - the collection matcher behind the header dropdown and the MCP `get_collections` query
//     (§37.6) — a substring ILIKE over name, description and owner name, NOT the §34 engine.
//
// Client-safe (no node deps); exported via the barrel and the `@skilly/shared/collections` subpath.

/** Collections one person may own (§37.1). */
export const MAX_COLLECTIONS_PER_OWNER = 50;
/** Skills one collection may hold (§37.1). */
export const MAX_SKILLS_PER_COLLECTION = 50;
/** Name length bounds, in characters, after trimming (§37.1). */
export const COLLECTION_NAME_MIN = 1;
export const COLLECTION_NAME_MAX = 60;
/** Description bound, in characters (§37.1). */
export const COLLECTION_DESCRIPTION_MAX = 500;
/** A collection counts toward the leaderboard stat only with at least this many eligible skills (§37.8). */
export const COLLECTION_LEADERBOARD_MIN_SKILLS = 3;
/** The header dropdown's Collections group size (§37.6). */
export const COLLECTION_SUGGEST_LIMIT = 3;
/** The MCP `get_collections` query result size (§37.9). */
export const COLLECTION_MCP_QUERY_LIMIT = 10;
/** The query floor shared with the skill dropdown (§37.6). */
export const COLLECTION_QUERY_MIN_CHARS = 2;
/** Per-user write budget for the collection endpoints (the watch/follow budget). */
export const COLLECTION_WRITE_RATE_LIMIT_PER_MIN = 120;

/** Characters as Postgres `char_length` counts them (code points, not UTF-16 units). */
function charLength(s: string): number {
  return Array.from(s).length;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** Trim and bound a collection name (§37.1). */
export function validateCollectionName(raw: unknown): Validated<string> {
  if (typeof raw !== "string") return { ok: false, error: "a collection name is required" };
  const name = raw.trim();
  const n = charLength(name);
  if (n < COLLECTION_NAME_MIN) return { ok: false, error: "a collection name is required" };
  if (n > COLLECTION_NAME_MAX) return { ok: false, error: `a collection name can be at most ${COLLECTION_NAME_MAX} characters` };
  return { ok: true, value: name };
}

/** Trim and bound a description; blank becomes null (§37.1). Plain text, stored as typed. */
export function validateCollectionDescription(raw: unknown): Validated<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "the description must be text" };
  const d = raw.trim();
  if (!d) return { ok: true, value: null };
  if (charLength(d) > COLLECTION_DESCRIPTION_MAX) {
    return { ok: false, error: `a description can be at most ${COLLECTION_DESCRIPTION_MAX} characters` };
  }
  return { ok: true, value: d };
}

/** Case-insensitive name equality, the rule behind the per-owner unique index (§37.1). */
export function sameCollectionName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ── Eligibility & eviction (§37.1 / §37.4) ────────────────────────────────────────────────────

/**
 * The eligibility predicate for a `skills` alias: org-visible, not archived, and at least one
 * active, git-served version (the Featured predicate plus the org requirement). Trusted alias only.
 */
export function collectionEligibleSql(alias = "s"): string {
  return `(${alias}.visibility = 'org' and ${alias}.status = 'active'` +
    ` and exists (select 1 from skill_versions ev where ev.skill_id = ${alias}.id and ev.status = 'active' and ev.git_published))`;
}

/** The pure twin of {@link collectionEligibleSql} for an already-loaded skill. */
export function isCollectionEligible(s: { visibility: string; archived: boolean; hasInstallableVersion: boolean }): boolean {
  return s.visibility === "org" && !s.archived && s.hasInstallableVersion;
}

/**
 * The ONE eviction statement (§37.4): remove skill `$1` from every collection unless it is still
 * eligible. Safe to run after any lifecycle change; a no-op for a still-eligible skill. Every path
 * that archives a skill, yanks its last installable version or narrows its visibility runs this.
 */
export const COLLECTION_EVICT_SQL = `delete from skill_collection_items i
  where i.skill_id = $1::uuid
    and not exists (select 1 from skills s where s.id = i.skill_id and ${collectionEligibleSql("s")})`;

/** Minimal query surface so the helper runs on a pg Pool or PoolClient without importing pg. */
export interface CollectionQueryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/** Run {@link COLLECTION_EVICT_SQL} for one skill (inside the caller's transaction when `db` is a client). */
export async function evictFromCollections(db: CollectionQueryable, skillId: string): Promise<void> {
  await db.query(COLLECTION_EVICT_SQL, [skillId]);
}

/** The eligible-member count for a `skill_collections` alias — every read uses it (§37.4). */
export function collectionMemberCountSql(alias = "c"): string {
  return `(select count(*) from skill_collection_items ci join skills s on s.id = ci.skill_id` +
    ` where ci.collection_id = ${alias}.id and ${collectionEligibleSql("s")})::int`;
}

// ── The matcher (§37.6) ──────────────────────────────────────────────────────────────────────

/** Escape `%`, `_` and `\` for an ILIKE pattern with `escape '\'`. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

/** The owner label used by the matcher and its results: display name, else email. */
export const COLLECTION_OWNER_NAME_SQL = "coalesce(nullif(u.display_name, ''), u.email)";

/**
 * The collection matcher: non-empty collections whose owner is active and not erased, matched by a
 * case-insensitive substring over name, description and owner name. Ranked name-match first, then
 * member count desc, then newest. Returns the statement and its values; columns are `id`, `name`,
 * `description`, `owner_id`, `owner_name`, `owner_avatar`, `skill_count`, `created_at`.
 */
export function collectionMatchSql(q: string, limit: number): { text: string; values: unknown[] } {
  const values: unknown[] = [likePattern(q.trim()), Math.max(1, Math.min(50, Math.floor(limit)))];
  const text = `select * from (
      select c.id, c.name, c.description, c.owner_id, ${COLLECTION_OWNER_NAME_SQL} as owner_name, u.avatar as owner_avatar,
             ${collectionMemberCountSql("c")} as skill_count, c.created_at,
             (c.name ilike $1 escape '\\') as name_hit
        from skill_collections c
        join users u on u.id = c.owner_id and u.status = 'active' and u.erased_at is null
       where c.name ilike $1 escape '\\'
          or coalesce(c.description, '') ilike $1 escape '\\'
          or ${COLLECTION_OWNER_NAME_SQL} ilike $1 escape '\\'
    ) m
   where m.skill_count > 0
   order by m.name_hit desc, m.skill_count desc, m.created_at desc, m.id
   limit $2`;
  return { text, values };
}

/** A UUID check for path and query parameters (ids are random UUIDs, §37.1). */
export function isCollectionId(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** The shareable link for a collection — the catalog filtered to it (§37.5). */
export function collectionPath(id: string): string {
  return `/catalog?collection=${encodeURIComponent(id)}`;
}
