// Live-DB integration test for the audit trim (SKILLY_SPEC.md §11, §49.6; migration 0096). Gated
// behind SKILLY_DB_E2E=1 (see admin.dbtest.ts for the run recipe; needs migrations through 0096).
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… node --import tsx --test src/lib/audit.dbtest.ts
//
// Covers: the one-year floor (`audit_trim_floor`), a real trim through trimAuditLog() (old rows
// gone, the `audit.trimmed` row kept with its count, verify_audit_chain() clean afterwards), and
// invariant #5 under the app role: a plain UPDATE/DELETE on audit_log raises even with
// `skilly.allow_audit_trim` set, while trim_audit_log() still succeeds. The app-role part needs
// the `skilly_app` role (created by 0002 / the CI bootstrap); without it the test proves the
// guard raises without the GUC and logs that the GUC case was skipped.
//
// Optional: SKILLY_APP_DATABASE_URL=postgres://skilly_app:…@… runs the same app-role checks over a
// REAL skilly_app login (the `current_user <> session_user` branch of audit_guard()); never printed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "./db";
import { trimAuditLog, verifyAuditChain, AUDIT_TRIM_FLOOR } from "./audit";

const enabled = process.env.SKILLY_DB_E2E === "1";
const FIXTURE = "test.audit_trim_fixture";

after(async () => {
  if (enabled) await pool.end();
});

// Fixed actor: audit_log.actor_user_id is an FK and the table is append-only, so the actor is
// upserted and left in place (never deleted in cleanup).
async function fixedActor(): Promise<string> {
  return (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ('audit-trim-oid','audit-trim@org','Audit Trim')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
  )).rows[0]!.id;
}

async function appRoleExists(): Promise<boolean> {
  return ((await pool.query(`select 1 from pg_roles where rolname = 'skilly_app'`)).rowCount ?? 0) > 0;
}

/** Message of a rejected query, or null when it unexpectedly succeeded. */
async function failure(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

const appendOnlyOrDenied = (msg: string | null, what: string) => {
  assert.ok(msg !== null, `${what} must be refused`);
  assert.ok(/audit_log is append-only|permission denied/.test(msg!), `${what}: refused by the guard or the grants, got: ${msg}`);
};

// The verifier is shared with every other live-DB test file (admin.dbtest.ts deliberately tampers a
// row for a moment); a couple of retries keep a parallel run honest without hiding a real break.
async function chainVerifies(): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    if ((await verifyAuditChain()).ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return (await verifyAuditChain()).ok;
}

test("trim_audit_log: the one-year floor raises audit_trim_floor", { skip: !enabled }, async () => {
  const actor = await fixedActor();
  const trimmedRows = async () =>
    (await pool.query(`select 1 from audit_log where action = 'audit.trimmed' and actor_user_id = $1`, [actor])).rowCount ?? 0;
  const before = await trimmedRows();
  for (const under of ["11 months", "364 days", "1 day", "0 seconds"]) {
    const msg = await failure(pool.query(`select trim_audit_log($1::uuid, $2::interval)`, [actor, under]));
    assert.equal(msg, AUDIT_TRIM_FLOOR, `${under} is under the floor`);
  }
  // The lib maps the DB error to the same message the route turns into 422.
  await assert.rejects(trimAuditLog(actor, "6 months"), (e: unknown) => e instanceof Error && e.message === AUDIT_TRIM_FLOOR);
  assert.equal(await trimmedRows(), before, "a refused trim leaves no audit.trimmed row");
});

test("trim_audit_log: deletes old rows, keeps the audit.trimmed row, chain re-verifies", { skip: !enabled }, async () => {
  const actor = await fixedActor();
  // Backdated fixture rows (the chain hashes created_at as given; seq order is chain order).
  const ids: string[] = [];
  for (const age of ["2 years", "18 months", "400 days"]) {
    ids.push((await pool.query<{ id: string }>(
      `insert into audit_log (actor_user_id, action, target_type, target_id, after, source, created_at)
       values ($1, $2, 'test', 'fixture', '{"fixture":true}'::jsonb, 'web', now() - $3::interval) returning id`,
      [actor, FIXTURE, age],
    )).rows[0]!.id);
  }
  // A recent fixture row must survive.
  const recent = (await pool.query<{ id: string }>(
    `insert into audit_log (actor_user_id, action, target_type, target_id, source) values ($1, $2, 'test', 'recent', 'web') returning id`,
    [actor, FIXTURE],
  )).rows[0]!.id;
  assert.ok(await chainVerifies(), "chain intact before the trim");

  const expectedOld = Number((await pool.query<{ n: string }>(`select count(*)::text as n from audit_log where created_at < now() - interval '1 year'`)).rows[0]!.n);
  assert.ok(expectedOld >= ids.length);

  const { deleted } = await trimAuditLog(actor, "1 year");
  assert.equal(deleted, expectedOld, "returns the number of rows older than the cutoff");

  const survivors = (await pool.query(`select id from audit_log where id = any($1::uuid[])`, [ids])).rowCount ?? 0;
  assert.equal(survivors, 0, "backdated fixture rows are gone");
  assert.equal((await pool.query(`select 1 from audit_log where id = $1`, [recent])).rowCount, 1, "a recent row survives");
  assert.equal((await pool.query(`select 1 from audit_log where created_at < now() - interval '1 year'`)).rowCount, 0, "nothing older than a year remains");

  const trimmed = (await pool.query<{ after: { deletedCount: number; olderThan: string; cutoff: string }; source: string }>(
    `select after, source from audit_log where action = 'audit.trimmed' and actor_user_id = $1 order by seq desc limit 1`,
    [actor],
  )).rows[0];
  assert.ok(trimmed, "the trim is audited");
  assert.equal(trimmed!.after.deletedCount, deleted);
  assert.equal(trimmed!.after.olderThan, "1 year");
  assert.ok(trimmed!.after.cutoff, "the cutoff is recorded");
  assert.equal(trimmed!.source, "web");

  assert.ok(await chainVerifies(), "verify_audit_chain() reports no bad rows after the re-baseline");

  // A second trim right away finds nothing and is still audited.
  const again = await trimAuditLog(actor, "1 year");
  assert.equal(again.deleted, 0);
  assert.ok(await chainVerifies(), "chain intact after a no-op trim");
});

test("invariant #5: a plain UPDATE/DELETE raises even with the GUC set; only trim_audit_log() may delete", { skip: !enabled }, async () => {
  const actor = await fixedActor();
  const victim = (await pool.query<{ id: string }>(
    `insert into audit_log (actor_user_id, action, target_type, target_id, source) values ($1, $2, 'test', 'guard', 'web') returning id`,
    [actor, FIXTURE],
  )).rows[0]!.id;

  // Without the GUC the guard raises for everyone — owner included (the trigger is the second lock).
  appendOnlyOrDenied(await failure(pool.query(`delete from audit_log where id = $1`, [victim])), "DELETE without the GUC");
  appendOnlyOrDenied(await failure(pool.query(`update audit_log set action = 'x' where id = $1`, [victim])), "UPDATE without the GUC");

  if (!(await appRoleExists())) {
    console.log("[audit.dbtest] skilly_app role absent: the GUC-under-app-role case is skipped (no privilege separation to prove)");
    return;
  }

  // Under the app role (SET ROLE from the owner session, each case in a rolled-back transaction):
  // the grants refuse the write even with the GUC set. Note a SET ROLE session still has
  // session_user = owner, so this proves the grant layer; the trigger layer under a real app login
  // is the optional case below.
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role skilly_app");
    await c.query("set local skilly.allow_audit_trim = 'on'");
    let msg = await failure(c.query(`delete from audit_log where id = $1`, [victim]));
    assert.ok(msg && /permission denied/.test(msg), `grants refuse an app-role DELETE with the GUC: ${msg}`);
    await c.query("rollback");

    await c.query("begin");
    await c.query("set local role skilly_app");
    await c.query("set local skilly.allow_audit_trim = 'on'");
    msg = await failure(c.query(`update audit_log set action = 'x' where id = $1`, [victim]));
    assert.ok(msg && /permission denied/.test(msg), `grants refuse an app-role UPDATE with the GUC: ${msg}`);
    await c.query("rollback");

    // rebaseline_audit_chain() is not callable by the app role; trim_audit_log() is.
    await c.query("begin");
    await c.query("set local role skilly_app");
    msg = await failure(c.query(`select rebaseline_audit_chain()`));
    assert.ok(msg && /permission denied/.test(msg), `app role cannot re-baseline the chain directly: ${msg}`);
    await c.query("rollback");

    await c.query("begin");
    await c.query("set local role skilly_app");
    const n = Number((await c.query<{ n: number }>(`select trim_audit_log($1::uuid, '1 year'::interval) as n`, [actor])).rows[0]!.n);
    assert.ok(n >= 0, "the app role may run the definer trim");
    await c.query("rollback");
  } finally {
    c.release();
  }
  assert.equal((await pool.query(`select 1 from audit_log where id = $1`, [victim])).rowCount, 1, "the victim row is untouched");

  // The strongest form, when a real app-role login is available: session_user is skilly_app.
  const appUrl = process.env.SKILLY_APP_DATABASE_URL;
  if (!appUrl) {
    console.log("[audit.dbtest] SKILLY_APP_DATABASE_URL not set: the real skilly_app-login case is skipped");
    return;
  }
  const { Pool } = await import("pg");
  const app = new Pool({ connectionString: appUrl, max: 1 });
  try {
    const who = (await app.query<{ s: string; c: string }>(`select session_user::text as s, current_user::text as c`)).rows[0]!;
    assert.equal(who.s, "skilly_app");
    assert.equal(who.c, "skilly_app");
    const ac = await app.connect();
    try {
      await ac.query("begin");
      await ac.query("set local skilly.allow_audit_trim = 'on'");
      appendOnlyOrDenied(await failure(ac.query(`delete from audit_log where id = $1`, [victim])), "real app login DELETE with the GUC");
      await ac.query("rollback");
      await ac.query("begin");
      await ac.query("set local skilly.allow_audit_trim = 'on'");
      appendOnlyOrDenied(await failure(ac.query(`update audit_log set action = 'x' where id = $1`, [victim])), "real app login UPDATE with the GUC");
      await ac.query("rollback");
      await ac.query("begin");
      const n = Number((await ac.query<{ n: number }>(`select trim_audit_log($1::uuid, '1 year'::interval) as n`, [actor])).rows[0]!.n);
      assert.ok(n >= 0, "the real app login may run the definer trim");
      assert.equal((await ac.query(`select 1 from audit_log where action = 'audit.trimmed' and actor_user_id = $1 and created_at >= now()`, [actor])).rowCount, 1, "the trim is audited inside the definer");
      await ac.query("rollback");
    } finally {
      ac.release();
    }
  } finally {
    await app.end();
  }
});
