import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, type ReconcilePort } from "./reconcile.js";
import type { GraphPort, GraphUser } from "./graph.js";

// In-memory store implementing exactly the ReconcilePort surface.
function memStore(initial: Record<string, string[]>): ReconcilePort & { members: Map<string, Set<string>>; users: Set<string> } {
  const members = new Map<string, Set<string>>(Object.entries(initial).map(([g, m]) => [g, new Set(m)]));
  const users = new Set<string>();
  return {
    members,
    users,
    async mappedGroupExternalIds() {
      return [...members.keys()];
    },
    async groupMemberExternalIds(g) {
      return [...(members.get(g) ?? new Set())];
    },
    async upsertUser(u) {
      users.add(u.externalId);
      return { id: u.externalId };
    },
    async upsertGroup(g) {
      if (!members.has(g.externalId)) members.set(g.externalId, new Set());
      return { id: g.externalId };
    },
    async addMembership(g, u) {
      (members.get(g) ?? members.set(g, new Set()).get(g)!).add(u);
    },
    async removeMembership(g, u) {
      members.get(g)?.delete(u);
    },
    async externalIdsMissingAvatar() {
      return [];
    },
    async setUserAvatarIfMissing() {
      /* no-op for membership tests */
    },
  };
}

function fakeGraph(groups: Record<string, GraphUser[] | null>): GraphPort {
  return {
    async getGroup(oid) {
      return groups[oid] === null ? null : { displayName: `Group ${oid}` };
    },
    async getGroupMembers(oid) {
      return groups[oid] ?? [];
    },
    async getUserPhoto() {
      return null;
    },
  };
}

const u = (oid: string): GraphUser => ({ oid, email: `${oid}@org`, displayName: oid, active: true });

test("adds missing and removes stale memberships to match Graph", async () => {
  // local: group A has [x, stale]; Graph says A has [x, y]
  const store = memStore({ "grp-a": ["x", "stale"] });
  const graph = fakeGraph({ "grp-a": [u("x"), u("y")] });

  const stats = await reconcile(graph, store);

  assert.deepEqual([...store.members.get("grp-a")!].sort(), ["x", "y"]);
  assert.equal(stats.membershipsAdded, 1); // y added
  assert.equal(stats.membershipsRemoved, 1); // stale removed
  assert.ok(store.users.has("x") && store.users.has("y"));
  assert.equal(stats.groups, 1);
});

test("missing upstream group is skipped, not wiped", async () => {
  const store = memStore({ "grp-gone": ["keep"] });
  const graph = fakeGraph({ "grp-gone": null });

  const stats = await reconcile(graph, store);

  assert.equal(stats.groupsMissing, 1);
  assert.equal(stats.groups, 0);
  assert.deepEqual([...store.members.get("grp-gone")!], ["keep"]); // untouched
});

test("idempotent when already in sync", async () => {
  const store = memStore({ "grp-a": ["x", "y"] });
  const graph = fakeGraph({ "grp-a": [u("x"), u("y")] });
  const stats = await reconcile(graph, store);
  assert.equal(stats.membershipsAdded, 0);
  assert.equal(stats.membershipsRemoved, 0);
});
