// Live-DB integration test for presence's last-seen-page tracking (SKILLY_SPEC.md §4).
// Gated behind SKILLY_DB_E2E=1.
//
//   start pg + apply db/migrations (0001 … 0055)
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Validates: a labeled touchLastSeen() writes both last_seen and last_seen_page; a second call
// (labeled or not) inside the ~60s throttle window is dropped entirely — the shared-throttle
// contract described in presence.ts and SKILLY_SPEC.md §4 — and never clears a prior label; and
// listOnlineUsers() surfaces lastSeenPage (null when never beaconed). Also covers the
// active-users trend series' span-adaptive bucketing (getActiveUserSeries, §4) at the bottom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { touchLastSeen, listOnlineUsers, getActiveUserSeries } from "./presence";
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

// --- Active-users trend series: span-adaptive bucketing (§4) -------------------------------------
// `getActiveUserSeries` reads min(day) across the WHOLE daily_active_users table to size the span,
// so these tests own the table: they snapshot it, replace it with fixtures, and restore it in a
// finally. Gated behind SKILLY_DB_E2E=1 like the rest of this file.

interface DauRow { day: string; count: number }

async function withDauFixture(rows: DauRow[], fn: () => Promise<void>): Promise<void> {
  const saved = (await pool.query<DauRow>(`select day::text as day, count from daily_active_users`)).rows;
  const restore = async (into: DauRow[]) => {
    await pool.query(`delete from daily_active_users`);
    for (const r of into) await pool.query(`insert into daily_active_users (day, count) values ($1::date, $2)`, [r.day, r.count]);
  };
  try {
    await restore(rows);
    await fn();
  } finally {
    await restore(saved);
  }
}

/** `n` consecutive days ending `endAgo` days back from today, all with the same count. */
const daysAgo = (n: number, endAgo: number, count: number): DauRow[] =>
  Array.from({ length: n }, (_, i) => ({ day: `today-${endAgo + n - 1 - i}`, count }));

// The fixture days above are symbolic; resolve them against the DB's current_date so the test
// never drifts from the server's notion of "today".
async function resolveDays(rows: DauRow[]): Promise<DauRow[]> {
  const out: DauRow[] = [];
  for (const r of rows) {
    const ago = Number(r.day.replace("today-", ""));
    const { rows: d } = await pool.query<{ day: string }>(`select (current_date - make_interval(days => $1))::date::text as day`, [ago]);
    out.push({ day: d[0]!.day, count: r.count });
  }
  return out;
}

test("active-series: a young history (one calendar month) buckets by DAY for all-time", { skip: !enabled }, async () => {
  // The reported regression: ~30 days of history all inside one calendar month used to collapse
  // into a single monthly bucket — one point, no line.
  const fixture = await resolveDays(daysAgo(30, 0, 10));
  await withDauFixture(fixture, async () => {
    const s = await getActiveUserSeries("all");
    assert.equal(s.bucket, "day");
    assert.equal(s.points.length, 30);
    assert.ok(s.points.every((p) => p.count === 10), "raw daily counts pass through unaveraged");
    const dates = s.points.map((p) => p.date);
    assert.deepEqual(dates, [...dates].sort(), "points are ordered oldest-first");
  });
});

test("active-series: an empty table yields a daily, empty series", { skip: !enabled }, async () => {
  await withDauFixture([], async () => {
    for (const r of [7, 30, 90, "all"] as const) {
      const s = await getActiveUserSeries(r);
      assert.equal(s.bucket, "day", `range ${r}`);
      assert.deepEqual(s.points, [], `range ${r}`);
    }
  });
});

test("active-series: all-time steps up to WEEK past ~3 months of history", { skip: !enabled }, async () => {
  // One lone old day 400 days back (count 7) + 30 recent days (count 10) → span 401 → week.
  const fixture = await resolveDays([{ day: "today-400", count: 7 }, ...daysAgo(30, 0, 10)]);
  await withDauFixture(fixture, async () => {
    const s = await getActiveUserSeries("all");
    assert.equal(s.bucket, "week");
    // The lone old day is alone in its week → its average is exactly its own count.
    assert.equal(s.points[0]!.count, 7);
    assert.ok(s.points.length >= 5 && s.points.length <= 8, `expected ~5-7 weekly points, got ${s.points.length}`);
    assert.ok(s.points.slice(1).every((p) => p.count === 10), "weekly averages of a flat 10 are 10");

    // ...while the fixed 90d range over the SAME data stays daily and excludes the old day.
    const d90 = await getActiveUserSeries(90);
    assert.equal(d90.bucket, "day");
    assert.equal(d90.points.length, 30);
    assert.ok(d90.points.every((p) => p.count === 10));
  });
});

test("active-series: all-time steps up to MONTH past ~2 years of history", { skip: !enabled }, async () => {
  const fixture = await resolveDays([{ day: "today-800", count: 7 }, ...daysAgo(30, 0, 10)]);
  await withDauFixture(fixture, async () => {
    const s = await getActiveUserSeries("all");
    assert.equal(s.bucket, "month");
    assert.equal(s.points[0]!.count, 7, "the lone old month averages to its single day's count");
    assert.ok(s.points.slice(1).every((p) => p.count === 10), "monthly averages of a flat 10 are 10");
  });
});

test("active-series: a numeric range is a trailing window, not the whole table", { skip: !enabled }, async () => {
  // 40 days of history: 7d sees 7 points, 30d sees 30 — all daily, none averaged.
  const fixture = await resolveDays(daysAgo(40, 0, 10));
  await withDauFixture(fixture, async () => {
    const d7 = await getActiveUserSeries(7);
    assert.equal(d7.bucket, "day");
    assert.equal(d7.points.length, 7);
    const d30 = await getActiveUserSeries(30);
    assert.equal(d30.bucket, "day");
    assert.equal(d30.points.length, 30);
  });
});
