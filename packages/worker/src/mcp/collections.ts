// `get_collections` (SKILLY_SPEC.md §38.9) — the read-only MCP view of skill collections. Agents
// read collections; people curate them, so there is no write here at all. The matcher, the
// eligibility predicate and the member count come from @skilly/shared/collections, and member lists
// additionally run the caller's visibility predicate (invariant #3, belt and braces — §38.4).
import type { Pool } from "pg";
import {
  COLLECTION_MCP_QUERY_LIMIT,
  COLLECTION_OWNER_NAME_SQL,
  COLLECTION_QUERY_MIN_CHARS,
  collectionEligibleSql,
  collectionMatchSql,
  collectionMemberCountSql,
  collectionPath,
  isCollectionId,
  resolveLatest,
  skillVisibilityWhere,
  type EffectiveAccess,
} from "@skilly/shared";
import { publicBaseUrl } from "./url.js";

export interface CollectionOut {
  id: string;
  name: string;
  description: string | null;
  skillCount: number;
  createdAt: string;
  link: string;
  owner?: string;
}

const link = (id: string) => `${publicBaseUrl()}${collectionPath(id)}`;
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** No argument: the caller's own collections, newest first. */
export async function listOwnCollections(pool: Pool, userId: string): Promise<CollectionOut[]> {
  const { rows } = await pool.query<{ id: string; name: string; description: string | null; skill_count: number; created_at: Date }>(
    `select c.id, c.name, c.description, ${collectionMemberCountSql("c")} as skill_count, c.created_at
       from skill_collections c where c.owner_id = $1 order by c.created_at desc, c.id`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, skillCount: r.skill_count, createdAt: iso(r.created_at), link: link(r.id) }));
}

/** `query`: up to 10 non-empty collections by the shared matcher (§38.6). */
export async function matchCollections(pool: Pool, q: string): Promise<CollectionOut[] | { error: string }> {
  if (q.trim().length < COLLECTION_QUERY_MIN_CHARS) return { error: `query must be at least ${COLLECTION_QUERY_MIN_CHARS} characters` };
  const { text, values } = collectionMatchSql(q.slice(0, 64), COLLECTION_MCP_QUERY_LIMIT);
  const { rows } = await pool.query<{ id: string; name: string; description: string | null; skill_count: number; created_at: Date; owner_name: string }>(text, values);
  return rows.map((r) => ({
    id: r.id, name: r.name, description: r.description, skillCount: r.skill_count, createdAt: iso(r.created_at), link: link(r.id), owner: r.owner_name,
  }));
}

export interface CollectionDetail extends CollectionOut {
  owner: string;
  skills: { namespace: string; slug: string; title: string; latestInstallable: string | null }[];
}

/** `id`: one collection (any owner) with its eligible, visibility-filtered members. Null if unknown. */
export async function getCollectionDetail(pool: Pool, access: EffectiveAccess, id: string): Promise<CollectionDetail | null> {
  if (!isCollectionId(id)) return null;
  const { rows } = await pool.query<{ id: string; name: string; description: string | null; skill_count: number; created_at: Date; owner_name: string }>(
    `select c.id, c.name, c.description, ${collectionMemberCountSql("c")} as skill_count, c.created_at, ${COLLECTION_OWNER_NAME_SQL} as owner_name
       from skill_collections c join users u on u.id = c.owner_id
      where c.id = $1`,
    [id],
  );
  const c = rows[0];
  if (!c) return null;
  const params: unknown[] = [id];
  const where = [`ci.collection_id = $1`, collectionEligibleSql("s")];
  const vis = skillVisibilityWhere(access, params);
  if (vis) where.push(vis);
  const { rows: members } = await pool.query<{ namespace_slug: string; slug: string; title: string; versions: string[] | null }>(
    `select n.slug as namespace_slug, s.slug, s.title,
            array(select v.semver from skill_versions v where v.skill_id = s.id and v.status = 'active' and v.git_published) as versions
       from skill_collection_items ci
       join skills s on s.id = ci.skill_id
       join namespaces n on n.id = s.namespace_id
      where ${where.join(" and ")}
      order by lower(s.title), s.slug`,
    params,
  );
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    skillCount: c.skill_count,
    createdAt: iso(c.created_at),
    link: link(c.id),
    owner: c.owner_name,
    skills: members.map((m) => ({ namespace: m.namespace_slug, slug: m.slug, title: m.title, latestInstallable: resolveLatest(m.versions ?? []) })),
  };
}
