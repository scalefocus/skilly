// Live-DB integration test for presence's last-seen-page tracking (SKILLY_SPEC.md §4).
// Gated behind SKILLY_DB_E2E=1.
//
//   start pg + apply db/migrations (0001 … 0055)
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Validates: a labeled touchLastSeen() writes both last_seen and last_seen_page; a second call
// (labeled or not) inside the ~60s throttle window is dropped entirely — the shared-throttle
// contract described in presence.ts and SKILLY_SPEC.md §4 — and never clears a prior label; and
// listOnlineUsers() surfaces lastSeenPage (null when never beaconed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { touchLastSeen, listOnlineUsers } from "./presence";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

// touchLastSeen's write is fire-and-forget (never blocks the caller, by design) — give its
// async pool.query a moment to land before asserting against the row.
const settle = () => new Promise((r) => setTimeout(r, 200));

test("presence: labeled stamp writes last_seen_page; a same-window follow-up is dropped", { skip: !enabled }, async () => {
  const userA = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ('presence-a-oid','presence-a@org','Presence A','active')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
  )).rows[0]!.id;
  const userB = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ('presence-b-oid','presence-b@org','Presence B','active')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
  )).rows[0]!.id;
  // Reset so a prior test run in the same process doesn't leave userA/B pre-throttled.
  await pool.query(`update users set last_seen = null, last_seen_page = null where id in ($1,$2)`, [userA, userB]);

  try {
    // First labeled stamp for a fresh user: goes through.
    touchLastSeen(userA, "Catalog");
    await settle();
    const fetchA = async () =>
      (await pool.query<{ last_seen: string | null; last_seen_page: string | null }>(
        `select last_seen, last_seen_page from users where id = $1`, [userA],
      )).rows[0]!;
    let row = await fetchA();
    assert.ok(row.last_seen, "expected last_seen to be stamped");
    assert.equal(row.last_seen_page, "Catalog");

    // A second call for the SAME user inside the throttle window — labeled differently — is
    // dropped entirely: last_seen_page must NOT change to "Administration".
    touchLastSeen(userA, "Administration");
    await settle();
    row = await fetchA();
    assert.equal(row.last_seen_page, "Catalog", "throttled follow-up must not overwrite the label");

    // A plain (unlabeled) stamp — as currentAccess() sends on every other authenticated request —
    // is also throttled here, and even if it weren't, must never NULL out a prior label.
    touchLastSeen(userA);
    await settle();
    row = await fetchA();
    assert.equal(row.last_seen_page, "Catalog", "a plain stamp must never clear last_seen_page");

    // A DIFFERENT user's throttle is independent — userB's first-ever labeled stamp still lands.
    touchLastSeen(userB, "Review queue");
    await settle();
    const rowB = (await pool.query<{ last_seen_page: string | null }>(`select last_seen_page from users where id = $1`, [userB])).rows[0]!;
    assert.equal(rowB.last_seen_page, "Review queue");

    // listOnlineUsers surfaces lastSeenPage for both.
    const online = await listOnlineUsers(0, 50, undefined, 1440);
    const a = online.find((u) => u.userId === userA);
    const b = online.find((u) => u.userId === userB);
    assert.equal(a?.lastSeenPage, "Catalog");
    assert.equal(b?.lastSeenPage, "Review queue");
  } finally {
    await pool.query(`delete from users where id in ($1,$2)`, [userA, userB]).catch(() => {});
  }
});

test("presence: a user who has never beaconed a page shows lastSeenPage null", { skip: !enabled }, async () => {
  const userC = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ('presence-c-oid','presence-c@org','Presence C','active')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
  )).rows[0]!.id;
  await pool.query(`update users set last_seen = null, last_seen_page = null where id = $1`, [userC]);
  try {
    // Plain stamp only (no page) — mirrors an ordinary currentAccess() call with no beacon yet.
    touchLastSeen(userC);
    await settle();
    const online = await listOnlineUsers(0, 50, undefined, 1440);
    const c = online.find((u) => u.userId === userC);
    assert.ok(c, "expected the freshly-stamped user to be online");
    assert.equal(c!.lastSeenPage, null);
  } finally {
    await pool.query(`delete from users where id = $1`, [userC]).catch(() => {});
  }
});
