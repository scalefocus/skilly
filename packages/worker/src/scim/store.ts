// SCIM persistence layer. Phase 1 (SKILLY_SPEC.md §5).
// Authoritative source of users/groups/memberships. Roles are NOT stored here; they
// derive from role_mappings joined to these tables (see web/src/lib/access.ts).
//
// Leaver handling: deprovision => users.status='inactive' AND revoke all tokens.
// Authored skills are intentionally left intact (owned by namespace, not the user).
import type { Pool } from "pg";

export interface ScimUser {
  externalId: string; // Entra object id
  email: string;
  displayName: string;
  active: boolean;
}

export interface ScimGroup {
  externalId: string; // Entra object id
  displayName: string;
}

/**
 * Storage operations the SCIM router depends on. Injected into the router so the
 * Entra-payload -> action mapping can be tested without a live database, and so a
 * real Postgres-backed implementation (`pgStore`) is used in production.
 */
export interface ScimUserRecord extends ScimUser {
  id: string;
}
export interface ScimGroupRecord extends ScimGroup {
  id: string;
}
export interface ListQuery {
  filter?: { attr: string; value: string } | null;
  startIndex: number; // 1-based
  count: number;
}
export interface ListResult<T> {
  total: number;
  resources: T[];
}

export interface ScimStore {
  upsertUser(u: ScimUser): Promise<{ id: string }>;
  deprovisionUser(externalId: string): Promise<void>;
  /** Full GDPR erasure for SCIM DELETE /Users/:id (permanent). Idempotent. SKILLY_SPEC.md §4/§5. */
  eraseUserByExternalId(externalId: string): Promise<void>;
  upsertGroup(g: ScimGroup): Promise<{ id: string }>;
  addMembership(groupExternalId: string, userExternalId: string): Promise<void>;
  removeMembership(groupExternalId: string, userExternalId: string): Promise<void>;
  findUserByExternalId(externalId: string): Promise<ScimUserRecord | null>;
  listUsers(q: ListQuery): Promise<ListResult<ScimUserRecord>>;
  findGroupByExternalId(externalId: string): Promise<ScimGroupRecord | null>;
  listGroups(q: ListQuery): Promise<ListResult<ScimGroupRecord>>;
  /** Entra group object ids skilly cares about (referenced by role_mappings). */
  mappedGroupExternalIds(): Promise<string[]>;
  /** Current local member Entra object ids of a group. */
  groupMemberExternalIds(groupExternalId: string): Promise<string[]>;
  /** Of the given Entra object ids, the active/non-erased ones whose avatar is still missing —
   *  so reconciliation only fetches photos it actually needs. */
  externalIdsMissingAvatar(externalIds: string[]): Promise<string[]>;
  /** Fill a user's avatar IFF it's currently null (never clobbers a self-set sign-in photo). */
  setUserAvatarIfMissing(externalId: string, dataUri: string): Promise<void>;
}

// SCIM attribute -> DB column whitelists (prevents SQL injection via filter attr).
const USER_FILTER_COLUMNS: Record<string, string> = {
  username: "email",
  externalid: "entra_object_id",
  displayname: "display_name",
  email: "email",
};
const GROUP_FILTER_COLUMNS: Record<string, string> = {
  displayname: "display_name",
  externalid: "entra_object_id",
};

function filterColumn(map: Record<string, string>, attr: string | undefined): string | null {
  if (!attr) return null;
  return map[attr.toLowerCase()] ?? null;
}

/** Production store backed by Postgres. */
export function pgStore(pool: Pool): ScimStore {
  return {
    upsertUser: (u) => upsertUser(pool, u),
    deprovisionUser: (id) => deprovisionUser(pool, id),
    eraseUserByExternalId: (id) => eraseUserByExternalId(pool, id),
    upsertGroup: (g) => upsertGroup(pool, g),
    addMembership: (g, u) => addMembership(pool, g, u),
    removeMembership: (g, u) => removeMembership(pool, g, u),

    async findUserByExternalId(externalId) {
      const { rows } = await pool.query<{ id: string; entra_object_id: string; email: string; display_name: string; status: string }>(
        `select id, entra_object_id, email, display_name, status from users where entra_object_id = $1`,
        [externalId],
      );
      const r = rows[0];
      return r ? { id: r.id, externalId: r.entra_object_id, email: r.email, displayName: r.display_name, active: r.status === "active" } : null;
    },

    async listUsers(q) {
      const col = q.filter ? filterColumn(USER_FILTER_COLUMNS, q.filter.attr) : null;
      if (q.filter && !col) return { total: 0, resources: [] }; // unknown filter attr -> no leak
      const where = col ? `where ${col} = $1` : "";
      const params = col ? [q.filter!.value] : [];
      const total = Number((await pool.query<{ c: string }>(`select count(*)::text as c from users ${where}`, params)).rows[0]!.c);
      const { rows } = await pool.query<{ id: string; entra_object_id: string; email: string; display_name: string; status: string }>(
        `select id, entra_object_id, email, display_name, status from users ${where} order by created_at asc limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, q.count, q.startIndex - 1],
      );
      return { total, resources: rows.map((r) => ({ id: r.id, externalId: r.entra_object_id, email: r.email, displayName: r.display_name, active: r.status === "active" })) };
    },

    async findGroupByExternalId(externalId) {
      const { rows } = await pool.query<{ id: string; entra_object_id: string; display_name: string }>(
        `select id, entra_object_id, display_name from groups where entra_object_id = $1`,
        [externalId],
      );
      const r = rows[0];
      return r ? { id: r.id, externalId: r.entra_object_id, displayName: r.display_name } : null;
    },

    async listGroups(q) {
      const col = q.filter ? filterColumn(GROUP_FILTER_COLUMNS, q.filter.attr) : null;
      if (q.filter && !col) return { total: 0, resources: [] };
      const where = col ? `where ${col} = $1` : "";
      const params = col ? [q.filter!.value] : [];
      const total = Number((await pool.query<{ c: string }>(`select count(*)::text as c from groups ${where}`, params)).rows[0]!.c);
      const { rows } = await pool.query<{ id: string; entra_object_id: string; display_name: string }>(
        `select id, entra_object_id, display_name from groups ${where} order by created_at asc limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, q.count, q.startIndex - 1],
      );
      return { total, resources: rows.map((r) => ({ id: r.id, externalId: r.entra_object_id, displayName: r.display_name })) };
    },

    async mappedGroupExternalIds() {
      const { rows } = await pool.query<{ oid: string }>(
        `select distinct g.entra_object_id as oid
           from role_mappings rm join groups g on g.id = rm.group_id`,
      );
      const ids = new Set(rows.map((r) => r.oid));
      // Include the bootstrap admin group even if it has no role_mapping / isn't synced yet.
      const bootstrap = process.env.SKILLY_BOOTSTRAP_ADMIN_GROUP?.trim();
      if (bootstrap) ids.add(bootstrap);
      return [...ids];
    },

    async groupMemberExternalIds(groupExternalId) {
      const { rows } = await pool.query<{ oid: string }>(
        `select u.entra_object_id as oid
           from group_memberships gm
           join groups g on g.id = gm.group_id
           join users u on u.id = gm.user_id
          where g.entra_object_id = $1`,
        [groupExternalId],
      );
      return rows.map((r) => r.oid);
    },

    async externalIdsMissingAvatar(externalIds) {
      if (externalIds.length === 0) return [];
      const { rows } = await pool.query<{ oid: string }>(
        `select entra_object_id as oid from users
          where entra_object_id = any($1::text[]) and avatar is null and erased_at is null and status = 'active'`,
        [externalIds],
      );
      return rows.map((r) => r.oid);
    },

    async setUserAvatarIfMissing(externalId, dataUri) {
      await pool.query(
        `update users set avatar = $2, updated_at = now() where entra_object_id = $1 and avatar is null`,
        [externalId, dataUri],
      );
    },
  };
}

export async function upsertUser(pool: Pool, u: ScimUser): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status)
       values ($1, $2, $3, $4)
     on conflict (entra_object_id) do update
       -- Don't clobber real values with blanks (e.g. a reconcile where Graph returned no
       -- email/displayName because of a missing directory-read permission); keep what we have
       -- until a non-empty value arrives. status always reflects the latest active/inactive.
       set email = coalesce(nullif(excluded.email, ''), users.email),
           display_name = coalesce(nullif(excluded.display_name, ''), users.display_name),
           status = excluded.status,
           updated_at = now()
     returning id`,
    [u.externalId, u.email, u.displayName, u.active ? "active" : "inactive"],
  );
  return { id: rows[0]!.id };
}

/** Deprovision (leaver): mark inactive + revoke tokens. Skills are preserved. Reversible — Entra
 *  can re-enable the user (PATCH active:true / re-sync). This is the PATCH active:false path. */
export async function deprovisionUser(pool: Pool, externalId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      `update users set status = 'inactive', updated_at = now()
         where entra_object_id = $1 returning id`,
      [externalId],
    );
    const userId = rows[0]?.id;
    if (userId) {
      await client.query(`delete from tokens where user_id = $1`, [userId]);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Full GDPR erasure for a SCIM `DELETE /Users/:id` (a permanent removal, vs. the reversible
 * `active:false` deprovision above). Same effect as the admin "Delete User Info" flow (SKILLY_SPEC.md
 * §4) but WITHOUT a maintainer transfer: anonymize-in-place — scrub the row + detach the Entra link
 * (so the person can return later as a fresh account), delete the user's personal data, and remove
 * their explicit maintainerships. Skills stay; messages/proposals/reviews de-identify to "Deleted
 * User" via userLabel. Idempotent: a no-op if no live row matches the externalId (it was already
 * erased — entra_object_id is null — or never existed). Writes a SCIM-sourced `user.erased` audit
 * row (null actor). NOTE: kept in sync with web's lib/eraseUser.ts (the transfer-capable variant);
 * change both together.
 */
export async function eraseUserByExternalId(pool: Pool, externalId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const row = (
      await client.query<{ id: string; email: string | null }>(`select id, email from users where entra_object_id = $1 and erased_at is null for update`, [externalId])
    ).rows[0];
    const userId = row?.id;
    if (!userId) {
      await client.query("rollback"); // no live match → idempotent no-op
      return;
    }
    // Delete the user's personal data (group_memberships also strips implicit admin/maintainer
    // status; explicit maintainerships are removed — no transfer on the SCIM path). install_credits
    // goes too — leaderboard attribution is erased (credits-only; shared clone events untouched).
    // Mirrors web's lib/eraseUser.ts. SKILLY_SPEC.md §21/§4.
    for (const tbl of ["skill_maintainers", "install_credits", "group_memberships", "skill_ratings", "skill_watches", "notifications", "tokens"]) {
      await client.query(`delete from ${tbl} where user_id = $1`, [userId]);
    }
    // Scrub + detach the row (tombstone). Display label retains the former email
    // ("<email> - Deleted") so deleted authors stay identifiable; mirrors web's lib/eraseUser.ts.
    const deletedLabel = row?.email && row.email.trim() ? `${row.email.trim()} - Deleted` : "Deleted User";
    await client.query(
      `update users set display_name = $2, email = '', avatar = null,
              entra_object_id = null, status = 'inactive', erased_at = now()
        where id = $1`,
      [userId, deletedLabel],
    );
    // Audit (append-only, hash-chained): mirror web appendAudit's columns; system actor, source scim.
    await client.query(
      `insert into audit_log (actor_user_id, action, target_type, target_id, namespace_id, before, after, source, request_id)
       values (null, 'user.erased', 'user', $1, null, null, $2::jsonb, 'scim', null)`,
      [userId, JSON.stringify({ via: "scim", skillsTransferred: 0 })],
    );
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertGroup(pool: Pool, g: ScimGroup): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into groups (entra_object_id, display_name)
       values ($1, $2)
     on conflict (entra_object_id) do update
       set display_name = excluded.display_name, updated_at = now()
     returning id`,
    [g.externalId, g.displayName],
  );
  return { id: rows[0]!.id };
}

/** Add a membership by Entra object ids (idempotent). */
export async function addMembership(pool: Pool, groupExternalId: string, userExternalId: string): Promise<void> {
  await pool.query(
    `insert into group_memberships (group_id, user_id)
       select g.id, u.id from groups g, users u
        where g.entra_object_id = $1 and u.entra_object_id = $2
     on conflict do nothing`,
    [groupExternalId, userExternalId],
  );
}

export async function removeMembership(pool: Pool, groupExternalId: string, userExternalId: string): Promise<void> {
  await pool.query(
    `delete from group_memberships gm
       using groups g, users u
      where gm.group_id = g.id and gm.user_id = u.id
        and g.entra_object_id = $1 and u.entra_object_id = $2`,
    [groupExternalId, userExternalId],
  );
}
