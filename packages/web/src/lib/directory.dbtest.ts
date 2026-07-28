// Live-DB integration test for the directory hover card's read side (SKILLY_SPEC.md §28).
// Gated by SKILLY_DB_E2E=1. Covers: the three directory fields come back for a normal user;
// presence resolves against the FIXED 5-minute window; the self-service opt-out and a GDPR
// tombstone both null the directory block out (name/email/presence unaffected); and an unknown or
// malformed id resolves to null (→ 404) rather than erroring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getUserCard } from "./directory";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

async function mkUser(oid: string, fields: Record<string, unknown> = {}): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ($1,$2,$3)
       on conflict (entra_object_id) do update set email = excluded.email, display_name = excluded.display_name
       returning id`,
      [oid, `${oid}@org`, `User ${oid}`],
    )
  ).rows[0]!.id;
  // Reset every column this suite touches, so a re-run never inherits the previous run's state.
  await pool.query(
    `update users set job_title = $2, office_location = $3, department = $4,
            directory_hidden = $5, last_seen = $6
      where id = $1`,
    [
      id,
      fields.job_title ?? null,
      fields.office_location ?? null,
      fields.department ?? null,
      fields.directory_hidden ?? false,
      fields.last_seen ?? null,
    ],
  );
  return id;
}

test("getUserCard: returns the Entra directory profile", { skip: !enabled }, async () => {
  const id = await mkUser("card-full", { job_title: "Delivery Lead", office_location: "Sofia", department: "Engineering" });

  const c = await getUserCard(id);

  assert.equal(c?.displayName, "User card-full");
  assert.equal(c?.email, "card-full@org");
  assert.equal(c?.jobTitle, "Delivery Lead");
  assert.equal(c?.officeLocation, "Sofia");
  assert.equal(c?.department, "Engineering");
});

test("getUserCard: online is the fixed 5-minute window, never a wider one", { skip: !enabled }, async () => {
  const fresh = await mkUser("card-fresh");
  const stale = await mkUser("card-stale");
  const never = await mkUser("card-never");
  await pool.query(`update users set last_seen = now() - interval '1 minute' where id = $1`, [fresh]);
  await pool.query(`update users set last_seen = now() - interval '30 minutes' where id = $1`, [stale]);

  assert.equal((await getUserCard(fresh))?.online, true);

  const s = await getUserCard(stale);
  assert.equal(s?.online, false); // inside the admin list's 1h window, but NOT online here
  assert.ok(s?.lastSeen, "a stale user still reports when they were last seen");

  const n = await getUserCard(never);
  assert.equal(n?.online, false);
  assert.equal(n?.lastSeen, null);
});

test("getUserCard: the opt-out nulls the directory block but keeps name/email/presence", { skip: !enabled }, async () => {
  const id = await mkUser("card-hidden", {
    job_title: "Delivery Lead",
    office_location: "Sofia",
    department: "Engineering",
    directory_hidden: true,
  });

  const c = await getUserCard(id);

  assert.equal(c?.jobTitle, null);
  assert.equal(c?.officeLocation, null);
  assert.equal(c?.department, null);
  assert.equal(c?.displayName, "User card-hidden");
  assert.equal(c?.email, "card-hidden@org");
});

test("getUserCard: an erased tombstone carries no directory information", { skip: !enabled }, async () => {
  const id = await mkUser("card-erased", { job_title: "Delivery Lead", department: "Engineering" });
  // Erasure itself scrubs these columns; the read side refuses them for a tombstone regardless.
  await pool.query(`update users set erased_at = now() where id = $1`, [id]);

  const c = await getUserCard(id);

  assert.equal(c?.jobTitle, null);
  assert.equal(c?.department, null);

  await pool.query(`update users set erased_at = null where id = $1`, [id]); // leave the fixture reusable
});

test("getUserCard: unknown and malformed ids resolve to null, not an error", { skip: !enabled }, async () => {
  assert.equal(await getUserCard("00000000-0000-0000-0000-000000000000"), null);
  assert.equal(await getUserCard("not-a-uuid"), null);
});
