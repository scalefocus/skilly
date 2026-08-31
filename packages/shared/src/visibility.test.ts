import { test } from "node:test";
import assert from "node:assert/strict";
import { skillVisibilityWhere, accessFromRows, roleMappingsFromRows, userGroupsFromRows } from "./visibility.js";
import { resolveAccess, isSkillVisible } from "./rbac.js";
import type { RoleMapping } from "./types.js";

const NS_A = "11111111-1111-1111-1111-111111111111";
const NS_B = "22222222-2222-2222-2222-222222222222";

test("platform admin needs no predicate (sees everything)", () => {
  const params: unknown[] = [];
  const sql = skillVisibilityWhere({ isPlatformAdmin: true, namespaceRoles: new Map() }, params);
  assert.equal(sql, null);
  assert.equal(params.length, 0);
});

test("a member gets the org-or-my-namespaces predicate with their namespace ids bound", () => {
  const params: unknown[] = ["existing"];
  const sql = skillVisibilityWhere(
    { isPlatformAdmin: false, namespaceRoles: new Map([[NS_A, "namespace_member"]]) },
    params,
  );
  assert.equal(sql, "(s.visibility = 'org' or s.namespace_id = any($2::uuid[]))");
  assert.deepEqual(params[1], [NS_A]);
});

test("a user with NO namespaces still gets the predicate — an empty array, not a missing filter", () => {
  const params: unknown[] = [];
  const sql = skillVisibilityWhere({ isPlatformAdmin: false, namespaceRoles: new Map() }, params);
  assert.ok(sql, "a non-admin must always be filtered");
  assert.deepEqual(params[0], []);
});

test("the alias is honored so the predicate can be used in a joined query", () => {
  const params: unknown[] = [];
  const sql = skillVisibilityWhere({ isPlatformAdmin: false, namespaceRoles: new Map() }, params, "sk");
  assert.equal(sql, "(sk.visibility = 'org' or sk.namespace_id = any($1::uuid[]))");
});

test("the SQL predicate agrees with the in-memory isSkillVisible check", () => {
  // Same access, both gates: whatever the predicate would select is what isSkillVisible allows.
  const access = resolveAccess(new Set(["g-a"]), [
    { id: "m1", groupId: "g-a", namespaceId: NS_A, role: "namespace_member" } satisfies RoleMapping,
  ]);
  assert.equal(isSkillVisible(access, { namespaceId: NS_A, visibility: "namespace" }), true);
  assert.equal(isSkillVisible(access, { namespaceId: NS_B, visibility: "namespace" }), false);
  assert.equal(isSkillVisible(access, { namespaceId: NS_B, visibility: "org" }), true);

  const params: unknown[] = [];
  skillVisibilityWhere(access, params);
  assert.deepEqual(params[0], [NS_A]);
});

test("row folding: user + group ids, tolerating the left-join null", () => {
  const { userId, groupEntraIds } = userGroupsFromRows([
    { user_id: "u1", group_oid: "g1" },
    { user_id: "u1", group_oid: null },
    { user_id: "u1", group_oid: "g2" },
  ]);
  assert.equal(userId, "u1");
  assert.deepEqual([...groupEntraIds].sort(), ["g1", "g2"]);

  const empty = userGroupsFromRows([]);
  assert.equal(empty.userId, null);
  assert.equal(empty.groupEntraIds.size, 0);
});

test("role mappings are keyed by the Entra group oid, not the internal group id", () => {
  const { mappings, groupOidById } = roleMappingsFromRows([
    { id: "m1", namespace_id: NS_A, role: "namespace_admin", group_id: "internal-1", group_oid: "oid-1" },
  ]);
  assert.equal(mappings[0]?.groupId, "oid-1");
  assert.equal(groupOidById.get("internal-1"), "oid-1");
});

test("accessFromRows resolves roles from group membership, never from a claim", () => {
  const a = accessFromRows(
    [{ user_id: "u1", group_oid: "oid-admin" }],
    [{ id: "m1", namespace_id: NS_A, role: "namespace_admin", group_id: "g", group_oid: "oid-admin" }],
  );
  assert.equal(a.userId, "u1");
  assert.equal(a.isPlatformAdmin, false);
  assert.equal(a.namespaceRoles.get(NS_A), "namespace_admin");
});

test("accessFromRows honors the bootstrap admin group (and ignores it when unset/absent)", () => {
  const rows = [{ user_id: "u1", group_oid: "oid-boot" }];
  assert.equal(accessFromRows(rows, [], "oid-boot").isPlatformAdmin, true);
  assert.equal(accessFromRows(rows, [], "  oid-boot  ").isPlatformAdmin, true);
  assert.equal(accessFromRows(rows, [], "oid-other").isPlatformAdmin, false);
  assert.equal(accessFromRows(rows, [], null).isPlatformAdmin, false);
  assert.equal(accessFromRows(rows, []).isPlatformAdmin, false);
});

test("an unknown/inactive user (no rows) resolves to no user and no access", () => {
  const a = accessFromRows([], [{ id: "m1", namespace_id: NS_A, role: "namespace_admin", group_id: "g", group_oid: "oid" }]);
  assert.equal(a.userId, null);
  assert.equal(a.isPlatformAdmin, false);
  assert.equal(a.namespaceRoles.size, 0);
});
