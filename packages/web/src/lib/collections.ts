// Skill collections (SKILLY_SPEC.md §38) — the web tier's reads and writes. The limits, the
// validation, the eligibility predicate, the eviction statement and the matcher live in
// @skilly/shared/collections so the worker's MCP `get_collections` runs the same rules.
//
// A collection is a user-owned list of ORG-VISIBLE, active, installable skills. Owning one grants no
// authority (invariant #1); every read re-applies the eligibility predicate (and the catalog view
// additionally applies the viewer's visibility filter), so a restricted skill can never surface.
import type { PoolClient } from "pg";
import type { EffectiveAccess } from "@skilly/shared";
import {
  COLLECTION_QUERY_MIN_CHARS,
  COLLECTION_SUGGEST_LIMIT,
  MAX_COLLECTIONS_PER_OWNER,
  MAX_SKILLS_PER_COLLECTION,
  collectionEligibleSql,
  collectionMatchSql,
  collectionMemberCountSql,
  isCollectionId,
  validateCollectionDescription,
  validateCollectionName,
} from "@skilly/shared/collections";
import { fanOutToFollowers } from "@skilly/shared/follows";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { tryAward } from "./achievements";
import { nameSql } from "./userLabel";

export type CollectionError = { ok: false; status: 403 | 404 | 409 | 422; error: string };
export type CollectionResult<T> = { ok: true; value: T } | CollectionError;

const fail = (status: CollectionError["status"], error: string): CollectionError => ({ ok: false, status, error });

export interface CollectionSummary {
  id: string;
  name: string;
  description: string | null;
  skillCount: number;
  createdAt: string;
  /** Only on the popup's read (`?skillId=`): whether that skill is already a member. */
  contains?: boolean;
  /** Only on the popup's read: the raw item count, so a full collection can be disabled. */
  itemCount?: number;
}

export interface CollectionView extends CollectionSummary {
  owner: { id: string; name: string; avatar: string | null; active: boolean };
}

const OWNER_NAME = nameSql("u.display_name", "u.email");

/** Postgres unique-violation on the per-owner name index (§38.1). */
function isNameTaken(e: unknown): boolean {
  return (e as { code?: string; constraint?: string })?.code === "23505";
}

async function isEligibleSkill(db: PoolClient | typeof pool, skillId: string): Promise<boolean> {
  if (!isCollectionId(skillId)) return false;
  const { rowCount } = await db.query(`select 1 from skills s where s.id = $1 and ${collectionEligibleSql("s")}`, [skillId]);
  return (rowCount ?? 0) > 0;
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The caller's own collections, newest first (the profile card, §38.7). With `skillId`, each row
 * also says whether that skill is a member and how many items it holds (the popup, §38.3).
 */
export async function listMyCollections(ownerId: string, skillId?: string | null): Promise<CollectionSummary[]> {
  const withSkill = skillId && isCollectionId(skillId) ? skillId : null;
  const { rows } = await pool.query<{
    id: string; name: string; description: string | null; skill_count: number; created_at: Date;
    contains: boolean | null; item_count: number;
  }>(
    `select c.id, c.name, c.description, ${collectionMemberCountSql("c")} as skill_count, c.created_at,
            case when $2::uuid is null then null
                 else exists (select 1 from skill_collection_items x where x.collection_id = c.id and x.skill_id = $2::uuid) end as contains,
            (select count(*) from skill_collection_items y where y.collection_id = c.id)::int as item_count
       from skill_collections c
      where c.owner_id = $1
      order by c.created_at desc, c.id`,
    [ownerId, withSkill],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    skillCount: r.skill_count,
    createdAt: r.created_at.toISOString(),
    ...(withSkill ? { contains: r.contains === true, itemCount: r.item_count } : {}),
  }));
}

/** One collection, any owner (the catalog banner, §38.5). Null for an unknown id. */
export async function getCollection(id: string): Promise<CollectionView | null> {
  if (!isCollectionId(id)) return null;
  const { rows } = await pool.query<{
    id: string; name: string; description: string | null; skill_count: number; created_at: Date;
    owner_id: string; owner_name: string; owner_avatar: string | null; owner_active: boolean;
  }>(
    `select c.id, c.name, c.description, ${collectionMemberCountSql("c")} as skill_count, c.created_at,
            u.id as owner_id, ${OWNER_NAME} as owner_name, u.avatar as owner_avatar,
            (u.status = 'active' and u.erased_at is null) as owner_active
       from skill_collections c
       join users u on u.id = c.owner_id
      where c.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    skillCount: r.skill_count,
    createdAt: r.created_at.toISOString(),
    owner: { id: r.owner_id, name: r.owner_name, avatar: r.owner_avatar, active: r.owner_active },
  };
}

/** A person's NON-EMPTY collections, for the `?collectionsBy=` banner chips (§38.5), newest first. */
export async function listNonEmptyCollectionsOf(ownerId: string): Promise<{ id: string; name: string; skillCount: number }[]> {
  if (!isCollectionId(ownerId)) return [];
  const { rows } = await pool.query<{ id: string; name: string; skill_count: number }>(
    `select * from (
        select c.id, c.name, ${collectionMemberCountSql("c")} as skill_count, c.created_at
          from skill_collections c where c.owner_id = $1
     ) m where m.skill_count > 0 order by m.created_at desc, m.id`,
    [ownerId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, skillCount: r.skill_count }));
}

export interface CollectionSuggestion {
  id: string;
  name: string;
  skillCount: number;
  owner: { id: string; name: string; avatar: string | null };
}

/** The header dropdown's Collections group (§38.6): the shared matcher, top 3. */
export async function suggestCollections(q: string, limit = COLLECTION_SUGGEST_LIMIT): Promise<CollectionSuggestion[]> {
  if (q.trim().length < COLLECTION_QUERY_MIN_CHARS) return [];
  const { text, values } = collectionMatchSql(q, limit);
  const { rows } = await pool.query<{ id: string; name: string; skill_count: number; owner_id: string; owner_name: string; owner_avatar: string | null }>(text, values);
  return rows.map((r) => ({ id: r.id, name: r.name, skillCount: r.skill_count, owner: { id: r.owner_id, name: r.owner_name, avatar: r.owner_avatar } }));
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────

/**
 * Create a collection with its first member (§38.3). 422 for an invalid name or an ineligible
 * skill, 409 `collection_limit` at 50, 409 `name_taken` for a duplicate (ignoring case). In the same
 * transaction the owner's followers hear about it (§38.8, no visibility gate: every member is
 * org-visible); after commit the creator earns Mixtape (best-effort, a Habits event).
 */
export async function createCollection(ownerId: string, rawName: unknown, skillId: unknown): Promise<CollectionResult<CollectionSummary>> {
  const name = validateCollectionName(rawName);
  if (!name.ok) return fail(422, name.error);
  if (typeof skillId !== "string" || !(await isEligibleSkill(pool, skillId))) {
    return fail(422, "only an org-visible, installable skill can be added to a collection");
  }
  const client = await pool.connect();
  let created: CollectionSummary;
  try {
    await client.query("begin");
    // Serialise one owner's creates so two racing requests can't both slip under the cap.
    await client.query(`select id from users where id = $1 for update`, [ownerId]);
    const { rows: cnt } = await client.query<{ n: number }>(`select count(*)::int as n from skill_collections where owner_id = $1`, [ownerId]);
    if ((cnt[0]?.n ?? 0) >= MAX_COLLECTIONS_PER_OWNER) {
      await client.query("rollback");
      return fail(409, "collection_limit");
    }
    let row: { id: string; created_at: Date };
    try {
      row = (await client.query<{ id: string; created_at: Date }>(
        `insert into skill_collections (owner_id, name) values ($1, $2) returning id, created_at`,
        [ownerId, name.value],
      )).rows[0]!;
    } catch (e) {
      if (!isNameTaken(e)) throw e;
      await client.query("rollback");
      return fail(409, "name_taken");
    }
    await client.query(`insert into skill_collection_items (collection_id, skill_id) values ($1, $2)`, [row.id, skillId]);
    await fanOutToFollowers(client, {
      type: "follow.collection_created",
      actorId: ownerId,
      payload: { collectionId: row.id, collectionName: name.value },
      skill: null,
    });
    await client.query("commit");
    created = { id: row.id, name: name.value, description: null, skillCount: 1, createdAt: row.created_at.toISOString() };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  await tryAward(pool, ownerId, "first_collection"); // §38.8 Mixtape
  return { ok: true, value: created };
}

async function ownedCollection(actorId: string, id: string): Promise<CollectionResult<{ id: string; ownerId: string }>> {
  if (!isCollectionId(id)) return fail(404, "not found");
  const { rows } = await pool.query<{ owner_id: string }>(`select owner_id from skill_collections where id = $1`, [id]);
  const r = rows[0];
  if (!r) return fail(404, "not found");
  // Collections are not secret (every member is org-visible), so a 403 here is no oracle (§38.11).
  if (r.owner_id !== actorId) return fail(403, "only the owner can change this collection");
  return { ok: true, value: { id, ownerId: r.owner_id } };
}

/** Owner-only rename / description edit (§38.7). */
export async function updateCollection(
  actorId: string,
  id: string,
  patch: { name?: unknown; description?: unknown },
): Promise<CollectionResult<{ name: string; description: string | null }>> {
  const owned = await ownedCollection(actorId, id);
  if (!owned.ok) return owned;
  const sets: string[] = [];
  const values: unknown[] = [id];
  if (patch.name !== undefined) {
    const name = validateCollectionName(patch.name);
    if (!name.ok) return fail(422, name.error);
    values.push(name.value);
    sets.push(`name = $${values.length}`);
  }
  if (patch.description !== undefined) {
    const d = validateCollectionDescription(patch.description);
    if (!d.ok) return fail(422, d.error);
    values.push(d.value);
    sets.push(`description = $${values.length}`);
  }
  try {
    const { rows } = await pool.query<{ name: string; description: string | null }>(
      `update skill_collections set ${[...sets, "updated_at = now()"].join(", ")} where id = $1 returning name, description`,
      values,
    );
    return { ok: true, value: rows[0]! };
  } catch (e) {
    if (isNameTaken(e)) return fail(409, "name_taken");
    throw e;
  }
}

/**
 * Hard-delete a collection and its items (§38.7). The owner, or any platform admin (moderation);
 * an admin deleting SOMEONE ELSE's collection is audited as `collection.deleted` (§38.10).
 */
export async function deleteCollection(access: EffectiveAccess, actorId: string, id: string): Promise<CollectionResult<null>> {
  if (!isCollectionId(id)) return fail(404, "not found");
  const view = await getCollection(id);
  if (!view) return fail(404, "not found");
  const isOwner = view.owner.id === actorId;
  if (!isOwner && !access.isPlatformAdmin) return fail(403, "only the owner or a platform admin can delete this collection");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from skill_collections where id = $1`, [id]);
    if (!isOwner) {
      await appendAudit(client, {
        actorUserId: actorId,
        action: "collection.deleted",
        targetType: "skill_collection",
        targetId: id,
        before: { ownerId: view.owner.id, name: view.name, skillCount: view.skillCount },
      });
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return { ok: true, value: null };
}

/** Owner-only add (§38.3). Idempotent; 422 for an ineligible skill, 409 `collection_full` at 50. */
export async function addSkillToCollection(actorId: string, id: string, skillId: string): Promise<CollectionResult<null>> {
  const owned = await ownedCollection(actorId, id);
  if (!owned.ok) return owned;
  if (!(await isEligibleSkill(pool, skillId))) return fail(422, "only an org-visible, installable skill can be added to a collection");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select id from skill_collections where id = $1 for update`, [id]);
    const { rows } = await client.query<{ n: number; has: boolean }>(
      `select count(*)::int as n, bool_or(skill_id = $2) as has from skill_collection_items where collection_id = $1`,
      [id, skillId],
    );
    if (rows[0]?.has) {
      await client.query("rollback");
      return { ok: true, value: null }; // already a member — idempotent
    }
    if ((rows[0]?.n ?? 0) >= MAX_SKILLS_PER_COLLECTION) {
      await client.query("rollback");
      return fail(409, "collection_full");
    }
    await client.query(`insert into skill_collection_items (collection_id, skill_id) values ($1, $2) on conflict do nothing`, [id, skillId]);
    await client.query(`update skill_collections set updated_at = now() where id = $1`, [id]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return { ok: true, value: null };
}

/** Owner-only remove (§38.3 untick / §38.5 card ✕). Idempotent. */
export async function removeSkillFromCollection(actorId: string, id: string, skillId: string): Promise<CollectionResult<null>> {
  const owned = await ownedCollection(actorId, id);
  if (!owned.ok) return owned;
  if (!isCollectionId(skillId)) return { ok: true, value: null };
  const { rowCount } = await pool.query(`delete from skill_collection_items where collection_id = $1 and skill_id = $2`, [id, skillId]);
  if (rowCount) await pool.query(`update skill_collections set updated_at = now() where id = $1`, [id]);
  return { ok: true, value: null };
}
