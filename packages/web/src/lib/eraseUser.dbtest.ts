// Live-DB integration test for GDPR erasure + leaderboard credit transfer (SKILLY_SPEC.md §4/§21).
// Gated by SKILLY_DB_E2E=1. Covers: with a "Replace maintainer to" target, install_credits are
// reassigned to the target instead of deleted — EXCEPT would-be self-credits (the install was
// performed by the target) and duplicates (the target already holds credit for the same install),
// which are deleted as plain erasure would. Credit transfer is independent of maintainer-transfer
// eligibility (a restricted skill's credit still moves even when the maintainership is skipped).
// Without a target, credits are deleted as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eraseUser } from "./eraseUser";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("eraseUser: transfers install credits to the replacement (self-credits/duplicates skipped; restricted skills' credits move)", { skip: !enabled }, async () => {
  try {
    const ns = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ('erase-ns','erase-ns',true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;

    const mkUser = async (oid: string) => (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ($1,$2,$3)
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
      [oid, `${oid}@org`, oid],
    )).rows[0]!.id;
    const actor = await mkUser("erase-admin");
    const target = await mkUser("erase-target");
    // The victim gets a FRESH row each run (a prior run's victim was erased => its
    // entra_object_id is null, so the upsert's conflict never fires).
    const victim = await mkUser("erase-victim");

    const mkSkill = async (slug: string, visibility: string) => (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1,$2,$2,'d','claude','hosted',$3)
       on conflict (namespace_id, slug) do update set visibility = excluded.visibility returning id`,
      [ns, slug, visibility],
    )).rows[0]!.id;
    const s1 = await mkSkill("erase-s1", "org");
    const s2 = await mkSkill("erase-s2", "namespace"); // target has NO role in erase-ns => ineligible

    // Clean prior rows so counts are deterministic across re-runs (credits cascade from access_log).
    await pool.query(`delete from access_log where skill_id = any($1::uuid[])`, [[s1, s2]]);
    await pool.query(`delete from skill_maintainers where skill_id = any($1::uuid[])`, [[s1, s2]]);
    for (const sk of [s1, s2]) {
      await pool.query(`insert into skill_maintainers (skill_id, user_id, added_by) values ($1,$2,$3)`, [sk, victim, actor]);
    }

    // One install event + its credit rows (snapshot model, §21).
    const install = async (skillId: string, actorUserId: string | null, creditedTo: string[]) => {
      const id = (await pool.query<{ id: string }>(
        `insert into access_log (actor_user_id, skill_id, source) values ($1,$2,'git') returning id`,
        [actorUserId, skillId],
      )).rows[0]!.id;
      for (const uid of creditedTo) {
        await pool.query(`insert into install_credits (access_log_id, user_id) values ($1,$2)`, [id, uid]);
      }
      return id;
    };
    await install(s1, null, [victim]);            // plain credit — transfers
    await install(s1, target, [victim]);          // target's own install — would-be self-credit, skipped
    await install(s1, null, [victim, target]);    // target already credited (co-maintainer) — duplicate, skipped
    await install(s2, null, [victim]);            // restricted skill — credit still transfers

    const r = await eraseUser(actor, victim, target);
    assert.equal(r.ok, true, `erase succeeded: ${JSON.stringify(r)}`);
    if (!r.ok) return;
    assert.equal(r.transferred, 1, "only the org skill's maintainership transferred");
    assert.deepEqual(r.skipped, [{ ns: "erase-ns", slug: "erase-s2" }], "restricted skill's maintainership skipped");
    assert.equal(r.creditsTransferred, 2, "plain + restricted-skill credits moved");
    assert.equal(r.creditsSkipped, 2, "self-credit + duplicate deleted, not transferred");

    const count = async (uid: string) => Number((await pool.query<{ n: string }>(
      `select count(*)::text as n from install_credits where user_id = $1`, [uid],
    )).rows[0]!.n);
    assert.equal(await count(victim), 0, "the erased user holds zero credits");
    assert.equal(await count(target), 3, "target: 2 transferred + their 1 pre-existing co-maintainer credit");

    // The self-credit invariant survives the transfer: no credit row for an install the
    // credited user performed themselves.
    const selfCredits = Number((await pool.query<{ n: string }>(
      `select count(*)::text as n from install_credits ic
        join access_log al on al.id = ic.access_log_id
       where ic.user_id = $1 and al.actor_user_id = $1`, [target],
    )).rows[0]!.n);
    assert.equal(selfCredits, 0, "no self-credit manufactured by the transfer");

    // The audit row carries the credit counts alongside the maintainer-transfer summary.
    const audit = (await pool.query<{ after: { creditsTransferred: number; creditsSkipped: number } }>(
      `select after from audit_log where action = 'user.erased' and target_id = $1
       order by created_at desc limit 1`, [victim],
    )).rows[0];
    assert.ok(audit, "user.erased audit row written");
    assert.equal(audit!.after.creditsTransferred, 2);
    assert.equal(audit!.after.creditsSkipped, 2);

    // No transfer target => credits deleted as before (both counts 0).
    const victim2 = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('erase-victim2','erase-victim2@org','erase-victim2')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;
    await install(s1, null, [victim2]);
    const r2 = await eraseUser(actor, victim2, null);
    assert.equal(r2.ok, true, `no-target erase succeeded: ${JSON.stringify(r2)}`);
    if (!r2.ok) return;
    assert.equal(r2.creditsTransferred, 0);
    assert.equal(r2.creditsSkipped, 0);
    assert.equal(await count(victim2), 0, "no-target erasure still deletes credits");

    // cleanup (install_credits cascade with access_log; users/namespace stay — erased tombstones
    // are referenced by audit_log, which is append-only)
    await pool.query(`delete from access_log where skill_id = any($1::uuid[])`, [[s1, s2]]);
    await pool.query(`delete from skill_maintainers where skill_id = any($1::uuid[])`, [[s1, s2]]);
    await pool.query(`delete from skills where id = any($1::uuid[])`, [[s1, s2]]);
  } finally {
    await pool.end();
  }
});
