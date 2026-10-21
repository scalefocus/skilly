// Live-DB integration test for §48 email digests on the web tier: the user's frequency choice
// (PATCH /api/me — validation, the first-sight reset) and the five platform settings (PATCH
// /api/admin/settings — 403 for non-admins, 422 validation before any write, per-key audit).
// Gated behind SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… node --import tsx --test src/lib/emailDigest.dbtest.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DIGEST_SETTING_KEYS } from "@skilly/shared";
import { getDigestSettings, setUserEmailDigest, updateDigestSettings } from "./emailDigest";
import { getPlatformSettings, invalidatePlatformSettings } from "./settings";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("§48: email frequency choice + digest admin settings", { skip: !enabled }, async () => {
  // A fixed actor (audit_log is append-only and references users — never delete it).
  const admin = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ('digest-admin-oid', 'digest-admin@t', 'Digest Admin')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
  )).rows[0]!.id;
  const user = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ('digest-user-oid', 'digest-user@t', 'Digest User')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
  )).rows[0]!.id;
  const keys = Object.values(DIGEST_SETTING_KEYS);
  const saved = (await pool.query<{ key: string; value: unknown }>(`select key, value from platform_settings where key = any($1::text[])`, [keys])).rows;
  try {
    await pool.query(`delete from platform_settings where key = any($1::text[])`, [keys]);
    invalidatePlatformSettings();
    const userRow = async () =>
      (await pool.query<{ email_digest: string | null; last: Date | null; failures: number }>(
        `select email_digest, email_digest_last_run_at as last, email_digest_failures as failures from users where id = $1`, [user],
      )).rows[0]!;

    // ── The user's choice ──
    await pool.query(`update users set email_digest = null, email_digest_last_run_at = now(), email_digest_failures = 2 where id = $1`, [user]);
    for (const bad of ["monthly", "", 1, true, {}]) {
      const r = await setUserEmailDigest(user, bad);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.status, 400, `rejects ${JSON.stringify(bad)}`);
    }
    assert.notEqual((await userRow()).last, null, "a rejected value changes nothing");

    assert.deepEqual(await setUserEmailDigest(user, "weekly"), { ok: true });
    let u = await userRow();
    assert.equal(u.email_digest, "weekly");
    assert.equal(u.last, null, "a changed value resets to first sight");
    assert.equal(u.failures, 0);

    await pool.query(`update users set email_digest_last_run_at = now() where id = $1`, [user]);
    await setUserEmailDigest(user, "weekly");
    assert.notEqual((await userRow()).last, null, "re-saving the same value keeps the stamp");

    await setUserEmailDigest(user, null);
    u = await userRow();
    assert.equal(u.email_digest, null, "null = organization default");
    assert.equal(u.last, null);

    // ── Admin settings ──
    const member = { userId: user, isPlatformAdmin: false };
    const adm = { userId: admin, isPlatformAdmin: true };
    const forbidden = await updateDigestSettings(member, { emailDigestHour: 9 });
    assert.equal(!forbidden.ok && forbidden.status, 403);
    assert.equal((await updateDigestSettings(null, { emailDigestHour: 9 }) as { status: number }).status, 403);

    for (const bad of [
      { emailDigestHour: 24 },
      { emailDigestHour: -1 },
      { emailDigestWeekday: 0 },
      { emailDigestWeekday: 8 },
      { emailDigestDefaultMode: "monthly" },
      { emailDigestTypes: ["message.new"] },
      { emailDigestTypes: ["achievement.earned"] },
      { emailDigestsEnabled: "yes" },
      // A valid key alongside an invalid one: nothing is written.
      { emailDigestHour: 9, emailDigestTypes: ["proposal.needs_review"] },
    ]) {
      const r = await updateDigestSettings(adm, bad);
      assert.equal(!r.ok && r.status, 422, `422 for ${JSON.stringify(bad)}`);
    }
    assert.equal((await getDigestSettings()).hour, 8, "nothing written by a rejected PATCH");

    const auditBefore = Number((await pool.query<{ n: string }>(
      `select count(*) as n from audit_log where action = 'settings.updated' and target_id = any($1::text[])`, [keys],
    )).rows[0]!.n);
    assert.deepEqual(
      await updateDigestSettings(adm, {
        emailDigestsEnabled: false,
        emailDigestDefaultMode: "daily",
        emailDigestHour: 17,
        emailDigestWeekday: 5,
        emailDigestTypes: ["request.fulfilled", "skill.new_version"],
      }),
      { ok: true },
    );
    const s = await getPlatformSettings(pool);
    assert.equal(s.emailDigestsEnabled, false);
    assert.equal(s.emailDigestDefaultMode, "daily");
    assert.equal(s.emailDigestHour, 17);
    assert.equal(s.emailDigestWeekday, 5);
    assert.deepEqual(s.emailDigestTypes, ["skill.new_version", "request.fulfilled"], "canonical order");

    const audits = (await pool.query<{ target_id: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
      `select target_id, before, after from audit_log
        where action = 'settings.updated' and target_id = any($1::text[]) and actor_user_id = $2
        order by created_at desc limit 5`,
      [keys, admin],
    )).rows;
    const hourAudit = audits.find((a) => a.target_id === "email_digest_hour")!;
    assert.deepEqual(hourAudit.before, { emailDigestHour: 8 });
    assert.deepEqual(hourAudit.after, { emailDigestHour: 17 });

    // An unchanged value is not re-audited.
    await updateDigestSettings(adm, { emailDigestHour: 17 });
    const auditAfter = Number((await pool.query<{ n: string }>(
      `select count(*) as n from audit_log where action = 'settings.updated' and target_id = any($1::text[])`, [keys],
    )).rows[0]!.n);
    assert.equal(auditAfter - auditBefore, 5, "one audit row per changed key, none for a no-op");
  } finally {
    await pool.query(`delete from platform_settings where key = any($1::text[])`, [keys]);
    for (const r of saved) {
      await pool.query(`insert into platform_settings (key, value) values ($1, $2::jsonb)`, [r.key, JSON.stringify(r.value)]);
    }
    await pool.query(`update users set email_digest = null, email_digest_last_run_at = null, email_digest_failures = 0 where id = $1`, [user]);
    await pool.end();
  }
});
