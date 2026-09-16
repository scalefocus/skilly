// Live-DB integration test for the §29 consent handoff (oauth_pending_authorizations). Gated
// behind SKILLY_DB_E2E=1 (see presence.dbtest.ts for the run recipe; needs migrations through 0073).
//
// The contract this pins down is what the old in-process Map could not give us: the stash survives
// a process boundary (it is a row, not memory), and consuming it is single-use, TTL'd and bound to
// the user it was stashed for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stashAuthorizeRequest, takeAuthorizeRequest, type AuthorizeRequest, type RegisteredClient } from "./mcpOauth";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

async function seedUser(oid: string, email: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ($1, $2, 'Pending Auth', 'active')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
    [oid, email],
  )).rows[0]!.id;
}

async function seedClient(): Promise<RegisteredClient> {
  const clientId = `mcp_dbtest_${Date.now()}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into oauth_clients (client_id, client_name, redirect_uris)
     values ($1, 'Pending Auth Client', $2) returning id`,
    [clientId, ["http://127.0.0.1:8976/callback"]],
  );
  return {
    id: rows[0]!.id,
    clientId,
    clientName: "Pending Auth Client",
    clientUri: null,
    logoUri: null,
    redirectUris: ["http://127.0.0.1:8976/callback"],
    blocked: false,
  };
}

const request: AuthorizeRequest = {
  clientId: "mcp_dbtest",
  redirectUri: "http://127.0.0.1:8976/callback",
  state: "db-state",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  codeChallengeMethod: "S256",
  resource: null,
  scope: null,
};

test("the consent handoff round-trips through the database", { skip: !enabled }, async () => {
  const userId = await seedUser("pending-auth-oid", "pending-auth@org");
  const client = await seedClient();
  try {
    const id = await stashAuthorizeRequest(userId, client, request);
    const taken = await takeAuthorizeRequest(id, userId);
    assert.ok(taken, "a freshly stashed request must be consumable");
    // The opaque client_id (not the uuid PK) comes back, because that is what the consent handler
    // feeds to findClient() when it re-reads the client at submit time.
    assert.equal(taken.clientId, client.clientId);
    assert.deepEqual(taken.request, request);
  } finally {
    await pool.query(`delete from oauth_clients where id = $1`, [client.id]);
  }
});

test("consuming is single-use — a double submit cannot mint two codes", { skip: !enabled }, async () => {
  const userId = await seedUser("pending-auth-oid", "pending-auth@org");
  const client = await seedClient();
  try {
    const id = await stashAuthorizeRequest(userId, client, request);
    assert.ok(await takeAuthorizeRequest(id, userId), "first consume wins");
    assert.equal(await takeAuthorizeRequest(id, userId), null, "second consume must fail closed");
  } finally {
    await pool.query(`delete from oauth_clients where id = $1`, [client.id]);
  }
});

test("a request is bound to the user it was stashed for", { skip: !enabled }, async () => {
  const owner = await seedUser("pending-auth-oid", "pending-auth@org");
  const other = await seedUser("pending-auth-other-oid", "pending-auth-other@org");
  const client = await seedClient();
  try {
    const id = await stashAuthorizeRequest(owner, client, request);
    assert.equal(await takeAuthorizeRequest(id, other), null, "a foreign session must not consume it");
    // …and the failed attempt must not have burned it for the rightful owner.
    assert.ok(await takeAuthorizeRequest(id, owner), "the owner can still consume it");
  } finally {
    await pool.query(`delete from oauth_clients where id = $1`, [client.id]);
  }
});

test("a request older than the 10-minute TTL is refused", { skip: !enabled }, async () => {
  const userId = await seedUser("pending-auth-oid", "pending-auth@org");
  const client = await seedClient();
  try {
    const id = await stashAuthorizeRequest(userId, client, request);
    await pool.query(
      `update oauth_pending_authorizations set created_at = now() - interval '11 minutes' where id = $1`,
      [id],
    );
    assert.equal(await takeAuthorizeRequest(id, userId), null, "an expired consent screen must fail closed");
  } finally {
    await pool.query(`delete from oauth_clients where id = $1`, [client.id]);
  }
});

test("an unknown or malformed id fails closed rather than throwing", { skip: !enabled }, async () => {
  const userId = await seedUser("pending-auth-oid", "pending-auth@org");
  assert.equal(await takeAuthorizeRequest("00000000-0000-0000-0000-000000000000", userId), null);
  // A non-uuid would blow up the uuid cast if it reached Postgres — it must be rejected first.
  assert.equal(await takeAuthorizeRequest("not-a-uuid", userId), null);
  assert.equal(await takeAuthorizeRequest("", userId), null);
});

test("deleting the client cascades its pending handoffs away", { skip: !enabled }, async () => {
  const userId = await seedUser("pending-auth-oid", "pending-auth@org");
  const client = await seedClient();
  const id = await stashAuthorizeRequest(userId, client, request);
  await pool.query(`delete from oauth_clients where id = $1`, [client.id]);
  const { rowCount } = await pool.query(`select 1 from oauth_pending_authorizations where id = $1`, [id]);
  assert.equal(rowCount, 0, "a removed client must not leave consent rows behind");
});
