// Tests for the worker's RUM jobs (SKILLY_SPEC.md §32.3 / §32.10). `rollupDays` is pure and always
// runs; the rollup + prune tests need a migrated Postgres and are gated behind SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… node --test dist/rum.test.js
//
// Covers: the sweep upserts today + yesterday (UTC) idempotently, writes per-route rows PLUS an
// exact 'all' row, a re-run after a "missed" run heals the same figures, and the prune removes raw
// samples > 30 d and error fingerprints idle > 90 d while leaving rum_daily untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { rollupDays, rollupRum, rollupRumDay, pruneRum } from "./rum.js";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("rollupDays: today and yesterday as UTC dates", () => {
  const [today, yesterday] = rollupDays(new Date("2026-09-16T00:30:00Z"));
  assert.equal(today, "2026-09-16");
  assert.equal(yesterday, "2026-09-15");
});

const SID = "rumworker-session-01";
const FP_OLD = "e".repeat(63) + "9";
const ROUTE = "/leaderboard";

async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function cleanup(pool: Pool): Promise<void> {
  await pool.query(`delete from rum_samples where session_id = $1`, [SID]);
  await pool.query(`delete from rum_errors where fingerprint = $1`, [FP_OLD]);
}

test("rollupRum: per-route + 'all' rows, idempotent upsert, self-healing re-run", { skip: !enabled }, async () => {
  await withPool(async (pool) => {
    await cleanup(pool);
    try {
      const [today] = rollupDays();
      // Seed today's samples on a route real dev traffic rarely touches (owned via the session id).
      await pool.query(
        `insert into rum_samples (user_id, session_id, route, kind, name, value, ok) values
           (null, $1, $2, 'page_view', null, null, null),
           (null, $1, $2, 'page_view', null, null, null),
           (null, $1, $2, 'vital', 'lcp', 1000, null),
           (null, $1, $2, 'vital', 'lcp', 3000, null),
           (null, $1, $2, 'api', '/api/leaderboard', 100, true),
           (null, $1, $2, 'api', '/api/leaderboard', 500, false)`,
        [SID, ROUTE],
      );

      const n1 = await rollupRum(pool);
      assert.ok(n1 >= 2, "expected at least the route row and the all row");
      const read = async () =>
        (await pool.query<{ route: string; views: number; lcp_p75: number; api_calls: number; api_errors: number }>(
          `select route, views, lcp_p75, api_calls, api_errors from rum_daily where day = $1 and route in ($2, 'all') order by route`,
          [today, ROUTE],
        )).rows;
      const first = await read();
      const routeRow = first.find((r) => r.route === ROUTE)!;
      assert.ok(routeRow, "route row written");
      assert.ok(routeRow.views >= 2);
      assert.ok(Number(routeRow.lcp_p75) >= 1000);
      assert.ok(routeRow.api_calls >= 2 && routeRow.api_errors >= 1);
      const allRow = first.find((r) => r.route === "all")!;
      assert.ok(allRow, "'all' row written");
      assert.ok(allRow.views >= routeRow.views);

      // Idempotent: a second run (as after a "missed" hour) rewrites the same figures, no duplicates.
      await rollupRumDay(pool, today);
      const second = await read();
      assert.deepEqual(second, first);
      const { rows: dup } = await pool.query<{ n: string }>(`select count(*)::text as n from rum_daily where day = $1 and route = $2`, [today, ROUTE]);
      assert.equal(dup[0]!.n, "1");
    } finally {
      await cleanup(pool);
    }
  });
});

test("pruneRum: raw > 30 d and errors idle > 90 d go; rum_daily stays", { skip: !enabled }, async () => {
  await withPool(async (pool) => {
    await cleanup(pool);
    try {
      await pool.query(
        `insert into rum_samples (session_id, route, kind, created_at) values ($1, $2, 'page_view', now() - interval '31 days'), ($1, $2, 'page_view', now() - interval '1 day')`,
        [SID, ROUTE],
      );
      await pool.query(
        `insert into rum_errors (fingerprint, type, message, frame, count, first_seen, last_seen) values ($1, 'E', 'old', '', 1, now() - interval '120 days', now() - interval '91 days')`,
        [FP_OLD],
      );
      const { rows: dailyBefore } = await pool.query<{ n: string }>(`select count(*)::text as n from rum_daily`);

      const r = await pruneRum(pool);
      assert.ok(r.samples >= 1);
      assert.ok(r.errors >= 1);
      const { rows: left } = await pool.query<{ n: string }>(`select count(*)::text as n from rum_samples where session_id = $1`, [SID]);
      assert.equal(left[0]!.n, "1");
      const { rows: err } = await pool.query<{ n: string }>(`select count(*)::text as n from rum_errors where fingerprint = $1`, [FP_OLD]);
      assert.equal(err[0]!.n, "0");
      const { rows: dailyAfter } = await pool.query<{ n: string }>(`select count(*)::text as n from rum_daily`);
      assert.equal(dailyAfter[0]!.n, dailyBefore[0]!.n);
    } finally {
      await cleanup(pool);
    }
  });
});
