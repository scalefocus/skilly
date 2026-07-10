// Entra reconciliation. SCIM push keeps us live; this periodic sweep corrects drift by
// pulling authoritative membership from Graph for the groups skilly maps to roles, and
// converging local group_memberships to match. SKILLY_SPEC.md §5.
//
// Scope: ONLY groups referenced by role_mappings (+ bootstrap admin group) — never the
// whole directory. Deprovisioning of departed users is SCIM's job; reconciliation only
// fixes membership accuracy for authorization-relevant groups.
import type { GraphPort } from "./graph.js";
import type { ScimUser, ScimGroup } from "../scim/store.js";

/** The store surface reconciliation needs (satisfied structurally by the SCIM pgStore). */
export interface ReconcilePort {
  mappedGroupExternalIds(): Promise<string[]>;
  groupMemberExternalIds(groupExternalId: string): Promise<string[]>;
  upsertUser(u: ScimUser): Promise<{ id: string }>;
  upsertGroup(g: ScimGroup): Promise<{ id: string }>;
  addMembership(groupExternalId: string, userExternalId: string): Promise<void>;
  removeMembership(groupExternalId: string, userExternalId: string): Promise<void>;
  externalIdsMissingAvatar(externalIds: string[]): Promise<string[]>;
  setUserAvatarIfMissing(externalId: string, dataUri: string): Promise<void>;
}

export interface ReconcileStats {
  groups: number;
  groupsMissing: number;
  usersUpserted: number;
  membershipsAdded: number;
  membershipsRemoved: number;
  avatarsFetched: number;
}

// SCIM doesn't carry profile photos and a synced user may never sign in, so reconciliation also
// back-fills avatars from Graph for members still missing one. Bounded per cycle so a large org
// converges over several cycles instead of bursting Graph on the first run. SKILLY_SPEC.md §5.
const AVATAR_FETCH_PER_CYCLE = Number(process.env.RECONCILE_AVATAR_FETCH_PER_CYCLE ?? 100);

export async function reconcile(graph: GraphPort, store: ReconcilePort): Promise<ReconcileStats> {
  const stats: ReconcileStats = { groups: 0, groupsMissing: 0, usersUpserted: 0, membershipsAdded: 0, membershipsRemoved: 0, avatarsFetched: 0 };
  const groupOids = await store.mappedGroupExternalIds();
  const seenMembers = new Set<string>(); // every member oid we touched this cycle (for avatar back-fill)

  for (const oid of groupOids) {
    const meta = await graph.getGroup(oid);
    if (!meta) {
      stats.groupsMissing++;
      continue; // group gone/inaccessible upstream; leave local state for SCIM/admin to resolve
    }
    stats.groups++;
    await store.upsertGroup({ externalId: oid, displayName: meta.displayName });

    const members = await graph.getGroupMembers(oid);
    for (const m of members) {
      await store.upsertUser({ externalId: m.oid, email: m.email, displayName: m.displayName, active: m.active });
      seenMembers.add(m.oid);
      stats.usersUpserted++;
    }

    const remote = new Set(members.map((m) => m.oid));
    const local = new Set(await store.groupMemberExternalIds(oid));
    for (const oidM of remote) {
      if (!local.has(oidM)) {
        await store.addMembership(oid, oidM);
        stats.membershipsAdded++;
      }
    }
    for (const oidM of local) {
      if (!remote.has(oidM)) {
        await store.removeMembership(oid, oidM);
        stats.membershipsRemoved++;
      }
    }
  }

  // Back-fill avatars for members that still have none (new/never-signed-in users), capped per run.
  const missing = (await store.externalIdsMissingAvatar([...seenMembers])).slice(0, AVATAR_FETCH_PER_CYCLE);
  for (const oid of missing) {
    const photo = await graph.getUserPhoto(oid);
    if (photo) {
      await store.setUserAvatarIfMissing(oid, photo);
      stats.avatarsFetched++;
    }
  }

  return stats;
}
