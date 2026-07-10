// Live-DB integration test for the §27 system banner: validation, unconditional-replace semantics,
// lazy expiry (no worker sweep — a past expiresAt reads as inactive but the row isn't deleted),
// immediate clear, and audit rows. Gated behind SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
import { test } from "node:test";
import assert from "node:assert/strict";
import { getSystemBanner, setSystemBanner, clearSystemBanner } from "./settings";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("system banner: validation, replace semantics, lazy expiry, clear, audit", { skip: !enabled }, async () => {
  try {
    const actor = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('sysbanner-admin-oid','sbadmin@t','SBAdmin')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;

    // Clean slate for local re-runs. audit_log is append-only (invariant #5) — nothing to clean
    // there; each run just appends its own rows, which is fine since there's no dedup constraint.
    await pool.query(`delete from platform_settings where key = 'system_banner'`);

    // Nothing set yet.
    assert.equal(await getSystemBanner(pool), null, "no banner initially");

    // Validation: message length (1-100) and duration are both checked.
    await assert.rejects(() => setSystemBanner("", 1, actor), /1-100 characters/);
    await assert.rejects(() => setSystemBanner("x".repeat(101), 1, actor), /1-100 characters/);
    await assert.rejects(() => setSystemBanner("ok", 2 as never, actor), /duration must be one of/);

    // Boundary + new durations are accepted: a full 100-char message and the 1m (720h) span.
    const maxMsg = await setSystemBanner("x".repeat(100), 1, actor);
    assert.equal(maxMsg.message.length, 100, "100-char message accepted");
    const beforeMonth = Date.now();
    const monthly = await setSystemBanner("Quarterly platform freeze", 720, actor);
    const monthlyMs = new Date(monthly.expiresAt).getTime() - beforeMonth;
    assert.ok(monthlyMs > 719 * 3_600_000 && monthlyMs < 721 * 3_600_000, "1m ≈ 720h out");

    // Set — active, expiresAt ~1h out.
    const before = Date.now();
    const first = await setSystemBanner("Scheduled maintenance tonight", 1, actor);
    assert.equal(first.message, "Scheduled maintenance tonight");
    const firstMs = new Date(first.expiresAt).getTime() - before;
    assert.ok(firstMs > 55 * 60_000 && firstMs < 65 * 60_000, "expiresAt ~1h out");
    assert.deepEqual(await getSystemBanner(pool), first);

    // Replace: ANY save unconditionally overwrites text + restarts the countdown from now — even
    // with a SHORTER duration than the ~1h that was left (§27 "no only-extends-if-greater" rule).
    const before2 = Date.now();
    const second = await setSystemBanner("New message", 1, actor);
    assert.equal(second.message, "New message");
    const secondMs = new Date(second.expiresAt).getTime() - before2;
    assert.ok(secondMs > 55 * 60_000 && secondMs < 65 * 60_000, "countdown restarted from now, not extended from the first save");
    assert.deepEqual(await getSystemBanner(pool), second);

    // Lazy expiry: force expiresAt into the past directly — getSystemBanner treats it as inactive,
    // but the row itself is untouched (no worker sweep deletes it).
    await pool.query(
      `update platform_settings set value = jsonb_set(value, '{expiresAt}', to_jsonb((now() - interval '1 minute')::text)) where key = 'system_banner'`,
    );
    assert.equal(await getSystemBanner(pool), null, "past expiresAt reads as no active banner");
    const stillThere = await pool.query(`select 1 from platform_settings where key = 'system_banner'`);
    assert.equal(stillThere.rowCount, 1, "the row still physically exists — no sweep deleted it");

    // Clear: removes the row immediately.
    await setSystemBanner("About to be cleared", 4, actor);
    assert.notEqual(await getSystemBanner(pool), null);
    await clearSystemBanner(actor);
    assert.equal(await getSystemBanner(pool), null);
    const gone = await pool.query(`select 1 from platform_settings where key = 'system_banner'`);
    assert.equal(gone.rowCount, 0, "clear hard-deletes the row");

    // Audit: both set and clear are recorded against the actor.
    const setAudit = await pool.query(`select 1 from audit_log where action = 'system_banner.set' and actor_user_id = $1`, [actor]);
    assert.ok((setAudit.rowCount ?? 0) >= 1, "set is audited");
    const clearAudit = await pool.query(`select 1 from audit_log where action = 'system_banner.cleared' and actor_user_id = $1`, [actor]);
    assert.ok((clearAudit.rowCount ?? 0) >= 1, "clear is audited");
  } finally {
    await pool.end();
  }
});
