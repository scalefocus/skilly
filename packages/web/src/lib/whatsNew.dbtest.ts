// Live-DB integration test for the What's new "seen" marker (SKILLY_SPEC.md §23). Gated behind
// SKILLY_DB_E2E=1 (see presence.dbtest.ts for the run recipe; needs migrations through 0067).
//
// Validates the forward-only contract of stampWhatsNewSeen(): null → set, lower → set, equal or
// higher → unchanged (with previous == current), and a corrupt stored value is overwritten as if
// never stamped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stampWhatsNewSeen } from "./whatsNew";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("stampWhatsNewSeen: only ever moves the marker forward", { skip: !enabled }, async () => {
  const userId = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ('whatsnew-oid','whatsnew@org','Whats New','active')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
  )).rows[0]!.id;
  await pool.query(`update users set whats_new_seen_version = null where id = $1`, [userId]);
  const stored = async () =>
    (await pool.query<{ v: string | null }>(`select whats_new_seen_version as v from users where id = $1`, [userId])).rows[0]!.v;

  try {
    // null → set
    let r = await stampWhatsNewSeen(userId, "1.148.0");
    assert.deepEqual(r, { previous: null, current: "1.148.0" });
    assert.equal(await stored(), "1.148.0");

    // lower → set (a patch advance and a minor toast both land the same way)
    r = await stampWhatsNewSeen(userId, "1.148.2");
    assert.deepEqual(r, { previous: "1.148.0", current: "1.148.2" });
    r = await stampWhatsNewSeen(userId, "1.149.0");
    assert.deepEqual(r, { previous: "1.148.2", current: "1.149.0" });
    assert.equal(await stored(), "1.149.0");

    // equal → unchanged, idempotent
    r = await stampWhatsNewSeen(userId, "1.149.0");
    assert.deepEqual(r, { previous: "1.149.0", current: "1.149.0" });

    // higher stored (a stale tab after a rollback) → never regresses
    r = await stampWhatsNewSeen(userId, "1.100.0");
    assert.deepEqual(r, { previous: "1.149.0", current: "1.149.0" });
    assert.equal(await stored(), "1.149.0");

    // a corrupt stored value is treated as never stamped and overwritten
    await pool.query(`update users set whats_new_seen_version = 'garbage' where id = $1`, [userId]);
    r = await stampWhatsNewSeen(userId, "1.149.0");
    assert.deepEqual(r, { previous: "garbage", current: "1.149.0" });
    assert.equal(await stored(), "1.149.0");
  } finally {
    await pool.query(`delete from users where id = $1`, [userId]).catch(() => {});
    await pool.end().catch(() => {});
  }
});
