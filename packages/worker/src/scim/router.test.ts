// SCIM router integration tests — validate the Entra-payload -> action mapping
// (the conformance-prone part) without a live DB, via an injected fake store.
// SKILLY_SPEC.md §5, §14.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { scimRouter } from "./router.js";
import type { ScimStore, ScimUser, ScimGroup } from "./store.js";

const BEARER = "test-scim-token";

interface Recorder {
  upserts: ScimUser[];
  deprovisions: string[];
  erasures: string[];
  groupUpserts: ScimGroup[];
  added: [string, string][];
  removed: [string, string][];
}

const SEED_USERS = [
  { id: "u1", externalId: "e1", email: "jane@org", displayName: "Jane", active: true },
  { id: "u2", externalId: "e2", email: "bob@org", displayName: "Bob", active: true },
  { id: "u3", externalId: "e3", email: "amy@org", displayName: "Amy", active: false },
];
const SEED_GROUPS = [{ id: "g1", externalId: "gg1", displayName: "Team A" }];

const USER_ATTR: Record<string, keyof (typeof SEED_USERS)[number]> = {
  username: "email", externalid: "externalId", displayname: "displayName", email: "email",
};
const GROUP_ATTR: Record<string, keyof (typeof SEED_GROUPS)[number]> = {
  displayname: "displayName", externalid: "externalId",
};

function makeFakeStore(rec: Recorder): ScimStore {
  return {
    async upsertUser(u) {
      rec.upserts.push(u);
      return { id: `id-${u.externalId}` };
    },
    async deprovisionUser(id) {
      rec.deprovisions.push(id);
    },
    async eraseUserByExternalId(id) {
      rec.erasures.push(id);
    },
    async upsertGroup(g) {
      rec.groupUpserts.push(g);
      return { id: `gid-${g.externalId}` };
    },
    async addMembership(g, u) {
      rec.added.push([g, u]);
    },
    async removeMembership(g, u) {
      rec.removed.push([g, u]);
    },
    async findUserByExternalId(externalId) {
      return SEED_USERS.find((u) => u.externalId === externalId) ?? null;
    },
    async listUsers(q) {
      let arr = SEED_USERS;
      if (q.filter) {
        const key = USER_ATTR[q.filter.attr.toLowerCase()];
        arr = key ? SEED_USERS.filter((u) => String(u[key]) === q.filter!.value) : [];
      }
      return { total: arr.length, resources: arr.slice(q.startIndex - 1, q.startIndex - 1 + q.count) };
    },
    async findGroupByExternalId(externalId) {
      return SEED_GROUPS.find((g) => g.externalId === externalId) ?? null;
    },
    async listGroups(q) {
      let arr = SEED_GROUPS;
      if (q.filter) {
        const key = GROUP_ATTR[q.filter.attr.toLowerCase()];
        arr = key ? SEED_GROUPS.filter((g) => String(g[key]) === q.filter!.value) : [];
      }
      return { total: arr.length, resources: arr.slice(q.startIndex - 1, q.startIndex - 1 + q.count) };
    },
    async mappedGroupExternalIds() {
      return SEED_GROUPS.map((g) => g.externalId);
    },
    async groupMemberExternalIds() {
      return [];
    },
    async externalIdsMissingAvatar() {
      return [];
    },
    async setUserAvatarIfMissing() {
      /* unused by router tests */
    },
  };
}

let rec: Recorder;
function app() {
  const a = express();
  a.use(express.json());
  a.use("/scim/v2", scimRouter(makeFakeStore(rec)));
  return a;
}

beforeEach(() => {
  process.env.SCIM_BEARER_TOKEN = BEARER;
  rec = { upserts: [], deprovisions: [], erasures: [], groupUpserts: [], added: [], removed: [] };
});

const auth = (r: request.Test) => r.set("authorization", `Bearer ${BEARER}`);

test("rejects unauthenticated requests", async () => {
  await request(app()).post("/scim/v2/Users").send({}).expect(401);
});

test("creates a user, mapping primary email", async () => {
  await auth(
    request(app())
      .post("/scim/v2/Users")
      .send({
        externalId: "entra-1",
        userName: "jane@org.com",
        displayName: "Jane",
        active: true,
        emails: [
          { value: "alt@org.com", primary: false },
          { value: "jane@org.com", primary: true },
        ],
      }),
  ).expect(201);

  assert.equal(rec.upserts.length, 1);
  assert.deepEqual(rec.upserts[0], {
    externalId: "entra-1",
    email: "jane@org.com",
    displayName: "Jane",
    active: true,
  });
});

test("PATCH active:false deprovisions the user", async () => {
  await auth(
    request(app())
      .patch("/scim/v2/Users/entra-1")
      .send({ Operations: [{ op: "replace", path: "active", value: false }] }),
  ).expect(204);
  assert.deepEqual(rec.deprovisions, ["entra-1"]);
});

test("DELETE erases the user (full GDPR erasure, not a soft deprovision)", async () => {
  await auth(request(app()).delete("/scim/v2/Users/entra-2")).expect(204);
  assert.deepEqual(rec.erasures, ["entra-2"]);
  assert.deepEqual(rec.deprovisions, []); // DELETE must NOT go through the reversible leaver path
});

test("Group member add/remove maps to store calls", async () => {
  await auth(
    request(app())
      .patch("/scim/v2/Groups/grp-1")
      .send({
        Operations: [
          { op: "add", path: "members", value: [{ value: "entra-1" }, { value: "entra-2" }] },
          { op: "remove", path: "members", value: [{ value: "entra-3" }] },
        ],
      }),
  ).expect(204);

  assert.deepEqual(rec.added, [
    ["grp-1", "entra-1"],
    ["grp-1", "entra-2"],
  ]);
  assert.deepEqual(rec.removed, [["grp-1", "entra-3"]]);
});

test("creates a group", async () => {
  await auth(
    request(app()).post("/scim/v2/Groups").send({ externalId: "grp-9", displayName: "Team Nine" }),
  ).expect(201);
  assert.deepEqual(rec.groupUpserts, [{ externalId: "grp-9", displayName: "Team Nine" }]);
});

test("GET /Users with userName filter returns the match in a ListResponse", async () => {
  const res = await auth(request(app()).get(`/scim/v2/Users?filter=${encodeURIComponent('userName eq "bob@org"')}`)).expect(200);
  assert.equal(res.body.schemas[0], "urn:ietf:params:scim:api:messages:2.0:ListResponse");
  assert.equal(res.body.totalResults, 1);
  assert.equal(res.body.Resources[0].userName, "bob@org");
  assert.equal(res.body.Resources[0].externalId, "e2");
});

test("GET /Users paginates with startIndex + count", async () => {
  const res = await auth(request(app()).get("/scim/v2/Users?startIndex=2&count=1")).expect(200);
  assert.equal(res.body.totalResults, 3);
  assert.equal(res.body.itemsPerPage, 1);
  assert.equal(res.body.startIndex, 2);
  assert.equal(res.body.Resources[0].externalId, "e2"); // second seeded user
});

test("GET /Users/:id returns the user, or 404", async () => {
  const ok = await auth(request(app()).get("/scim/v2/Users/e1")).expect(200);
  assert.equal(ok.body.userName, "jane@org");
  await auth(request(app()).get("/scim/v2/Users/missing")).expect(404);
});

test("GET /Groups with displayName filter", async () => {
  const res = await auth(request(app()).get(`/scim/v2/Groups?filter=${encodeURIComponent('displayName eq "Team A"')}`)).expect(200);
  assert.equal(res.body.totalResults, 1);
  assert.equal(res.body.Resources[0].displayName, "Team A");
});
