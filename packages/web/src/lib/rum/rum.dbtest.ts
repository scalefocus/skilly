// Live-DB integration test for real user monitoring (SKILLY_SPEC.md §32.10). Gated behind
// SKILLY_DB_E2E=1; requires a migrated Postgres (0001 … 0075) at DATABASE_URL.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: insertRumSamples writes server-stamped rows and upserts the error index (count +
// last_seen); getRumSummary computes true p75s, the API error rate, the error count and the 'all'
// row over a raw window; getRumRouteUsers ranks people by samples (and 'all' spans routes);
// listRumErrors lists fingerprints with their top routes; the settings setters round-trip through
// getRumSettings and write settings.updated audit rows; GDPR erasure leaves the sample with
// user_id = NULL. Uses its own routes/sessions so it never collides with real dev traffic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db";
import { insertRumSamples, getRumSummary, getRumRouteUsers, listRumErrors } from "./queries";
import type { RumSample } from "./validate";
import { getRumSettings, setRumEnabled, setRumFlushIntervals, setRumSampleRate } from "../settings";
import { eraseUser } from "../eraseUser";

const enabled = process.env.SKILLY_DB_E2E === "1";

const SID_A = "rumtest-session-aaaa";
const SID_B = "rumtest-session-bbbb";
const FP = "f".repeat(63) + "1";
const FP2 = "f".repeat(63) + "2";

async function upsertUser(oid: string, email: string, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ($1, $2, $3, 'active')
     on conflict (entra_object_id) do update set email = excluded.email, display_name = excluded.display_name, status = 'active' returning id`,
    [oid, email, name],
  );
  return rows[0]!.id;
}

async function cleanup(): Promise<void> {
  await pool.query(`delete from rum_samples where session_id in ($1, $2)`, [SID_A, SID_B]);
  await pool.query(`delete from rum_errors where fingerprint in ($1, $2)`, [FP, FP2]);
}

const s = (over: Partial<RumSample> & { kind: RumSample["kind"]; route: string }): RumSample => ({
  name: null, value: null, ok: null, sessionId: SID_A, error: null, ...over,
});

test("rum: insert + summary + drill-down + errors over a raw window", { skip: !enabled }, async () => {
  const userA = await upsertUser("rum-a-oid", "rum-a@org", "Rum A");
  const userB = await upsertUser("rum-b-oid", "rum-b@org", "Rum B");
  await cleanup();
  try {
    // User A: 3 views on /usage, LCP samples 1000/2000/3000/4000 (p75 = 3250), 4 api calls (1 failed), 2 errors (same fingerprint).
    await insertRumSamples(userA, [
      s({ kind: "page_view", route: "/usage" }),
      s({ kind: "page_view", route: "/usage" }),
      s({ kind: "page_view", route: "/usage" }),
      s({ kind: "vital", route: "/usage", name: "lcp", value: 1000 }),
      s({ kind: "vital", route: "/usage", name: "lcp", value: 2000 }),
      s({ kind: "vital", route: "/usage", name: "lcp", value: 3000 }),
      s({ kind: "vital", route: "/usage", name: "lcp", value: 4000 }),
      s({ kind: "api", route: "/usage", name: "/api/usage", value: 50, ok: true }),
      s({ kind: "api", route: "/usage", name: "/api/usage", value: 60, ok: true }),
      s({ kind: "api", route: "/usage", name: "/api/usage", value: 70, ok: true }),
      s({ kind: "api", route: "/usage", name: "/api/usage", value: 900, ok: false }),
      s({ kind: "error", route: "/usage", name: FP, error: { type: "TypeError", message: "boom", frame: "/app.js:1:1" } }),
      s({ kind: "error", route: "/usage", name: FP, error: { type: "TypeError", message: "boom", frame: "/app.js:1:1" } }),
    ]);
    // User B: 1 view on /audit, one error with the SAME fingerprint (so its routes span both), one distinct error.
    await insertRumSamples(userB, [
      s({ kind: "page_view", route: "/audit", sessionId: SID_B }),
      s({ kind: "error", route: "/audit", sessionId: SID_B, name: FP, error: { type: "TypeError", message: "boom", frame: "/app.js:1:1" } }),
      s({ kind: "error", route: "/audit", sessionId: SID_B, name: FP2, error: { type: "RangeError", message: "nope", frame: "" } }),
    ]);

    // Rows are server-stamped and bound to the caller.
    const { rows: raw } = await pool.query<{ n: string; users: string }>(
      `select count(*)::text as n, count(distinct user_id)::text as users from rum_samples where session_id in ($1,$2) and created_at > now() - interval '1 minute'`,
      [SID_A, SID_B],
    );
    assert.equal(raw[0]!.n, "16");
    assert.equal(raw[0]!.users, "2");

    // Error index: upserted counts.
    const { rows: errs } = await pool.query<{ fingerprint: string; count: number; type: string }>(`select fingerprint, count, type from rum_errors where fingerprint in ($1,$2) order by fingerprint`, [FP, FP2]);
    assert.deepEqual(errs.map((e) => [e.fingerprint, Number(e.count), e.type]), [[FP, 3, "TypeError"], [FP2, 1, "RangeError"]]);

    // Summary (7d raw): the /usage row and the 'all' row.
    const sum = await getRumSummary(7);
    assert.equal(sum.bucket, "day");
    assert.equal(sum.routes[0]!.route, "all");
    const usage = sum.routes.find((r) => r.route === "/usage")!;
    assert.ok(usage, "expected a /usage row");
    assert.equal(usage.label, "Usage");
    assert.ok(usage.views >= 3);
    // Real dev traffic may share the route, so assert on what this test wholly owns via a scoped query instead.
    const { rows: own } = await pool.query<{ lcp: number; api_p75: number; api_err: string; api_calls: string; errors: string }>(
      `select percentile_cont(0.75) within group (order by value) filter (where kind='vital' and name='lcp') as lcp,
              percentile_cont(0.75) within group (order by value) filter (where kind='api') as api_p75,
              count(*) filter (where kind='api' and ok=false)::text as api_err,
              count(*) filter (where kind='api')::text as api_calls,
              count(*) filter (where kind='error')::text as errors
         from rum_samples where session_id = $1`,
      [SID_A],
    );
    assert.equal(Number(own[0]!.lcp), 3250);
    assert.equal(Number(own[0]!.api_p75), 277.5);
    assert.equal(own[0]!.api_err, "1");
    assert.equal(own[0]!.api_calls, "4");
    assert.equal(own[0]!.errors, "2");
    assert.ok(usage.apiErrorRate != null && usage.apiErrorRate > 0 && usage.apiErrorRate <= 1);
    assert.ok(usage.errors >= 2);
    assert.ok(sum.series.length >= 1);
    assert.ok(sum.lastSampleAt);

    // Drill-down: A leads /usage; 'all' spans both users.
    const usersUsage = await getRumRouteUsers("/usage", 7);
    assert.equal(usersUsage[0]!.userId, userA);
    assert.equal(usersUsage[0]!.lcpP75, 3250);
    assert.equal(usersUsage[0]!.errors, 2);
    const usersAll = await getRumRouteUsers("all", 7);
    assert.ok(usersAll.some((u) => u.userId === userA) && usersAll.some((u) => u.userId === userB));
    assert.ok(usersAll.length <= 20);

    // Errors list: FP seen on both routes (most occurrences first), FP2 on /audit only.
    const { errors, total } = await listRumErrors(7, 0, 50);
    assert.ok(total >= 2);
    const fp = errors.find((e) => e.fingerprint === FP)!;
    assert.equal(fp.count, 3);
    assert.deepEqual(fp.routes.slice(0, 2), ["/usage", "/audit"]);
    const fp2 = errors.find((e) => e.fingerprint === FP2)!;
    assert.deepEqual(fp2.routes, ["/audit"]);
    // Paging honours offset/limit.
    const page = await listRumErrors("all", 0, 1);
    assert.equal(page.errors.length, 1);
  } finally {
    await cleanup();
  }
});

test("rum: settings round-trip + audit; sample rate is validated", { skip: !enabled }, async () => {
  const admin = await upsertUser("rum-admin-oid", "rum-admin@org", "Rum Admin");
  const before = await getRumSettings();
  try {
    await setRumEnabled(false, admin);
    await setRumSampleRate(25, admin);
    // §32.6 the flush ladder: a string or an array, stored normalised (deduped, ascending).
    assert.deepEqual(await setRumFlushIntervals("23, 5,,5, 7 ", admin), [5, 7, 23]);
    assert.deepEqual(await getRumSettings(), { enabled: false, sampleRate: 25, flushIntervals: [5, 7, 23] });
    assert.deepEqual(await setRumFlushIntervals([11, 7], admin), [7, 11]);
    assert.deepEqual((await getRumSettings()).flushIntervals, [7, 11]);
    await assert.rejects(() => setRumSampleRate(0, admin));
    await assert.rejects(() => setRumSampleRate(101, admin));
    await assert.rejects(() => setRumSampleRate(12.5, admin));
    await assert.rejects(() => setRumSampleRate("abc", admin));
    // Rejected ladders leave the stored set untouched.
    await assert.rejects(() => setRumFlushIntervals("4, 9", admin), /between 5 and 3600/);
    await assert.rejects(() => setRumFlushIntervals("17, 3601", admin), /between 5 and 3600/);
    await assert.rejects(() => setRumFlushIntervals("17, x", admin), /not a whole number/);
    await assert.rejects(() => setRumFlushIntervals("", admin), /at least one interval/);
    assert.deepEqual((await getRumSettings()).flushIntervals, [7, 11]);
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from audit_log where actor_user_id = $1 and action = 'settings.updated' and target_id in ('rum_enabled','rum_sample_rate','rum_flush_intervals') and created_at > now() - interval '1 minute'`,
      [admin],
    );
    assert.ok(Number(rows[0]!.n) >= 4);
  } finally {
    await setRumEnabled(before.enabled, admin);
    await setRumSampleRate(before.sampleRate, admin);
    await setRumFlushIntervals(before.flushIntervals, admin);
  }
});

// §32.3 / §32.10 — the least-privilege app role must be able to WRITE what the web tier writes.
// 0074 created rum_samples with a bigserial but no sequence grant, so production inserts failed with
// "permission denied for sequence" while the reads (table grants) worked; 0075 adds the grant. The
// sequence check deliberately spans EVERY sequence in public so the next serial column that forgets
// its grant fails here instead of in production. Privilege lookups work whatever role runs the test.
test("rum: skilly_app can insert the RUM tables and use every sequence (0075)", { skip: !enabled }, async () => {
  const { rows: tables } = await pool.query<{ t: string; ins: boolean; sel: boolean }>(
    `select t, has_table_privilege('skilly_app', t, 'INSERT') as ins, has_table_privilege('skilly_app', t, 'SELECT') as sel
       from unnest(array['rum_samples', 'rum_errors', 'rum_daily']) as t`,
  );
  for (const r of tables) {
    assert.equal(r.ins, true, `skilly_app lacks INSERT on ${r.t}`);
    assert.equal(r.sel, true, `skilly_app lacks SELECT on ${r.t}`);
  }

  const { rows: seqs } = await pool.query<{ name: string; usage: boolean }>(
    `select c.relname as name, has_sequence_privilege('skilly_app', c.oid, 'USAGE') as usage
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'S' and n.nspname = 'public'
      order by 1`,
  );
  assert.ok(seqs.some((r) => r.name === "rum_samples_id_seq"), "rum_samples_id_seq missing");
  const denied = seqs.filter((r) => !r.usage).map((r) => r.name);
  assert.deepEqual(denied, [], `skilly_app lacks USAGE on sequence(s): ${denied.join(", ")}`);
});

test("rum: GDPR erasure anonymises samples in place (user_id → NULL, row kept)", { skip: !enabled }, async () => {
  const admin = await upsertUser("rum-admin-oid", "rum-admin@org", "Rum Admin");
  // A fresh, unique OID so the tombstone from a previous run never blocks this one.
  const oid = `rum-erase-${Date.now()}`;
  const victim = await upsertUser(oid, `${oid}@org`, "Rum Erase");
  const sid = `rumtest-erase-${Date.now().toString(36)}`;
  try {
    await insertRumSamples(victim, [s({ kind: "page_view", route: "/profile", sessionId: sid })]);
    await eraseUser(admin, victim, null);
    const { rows } = await pool.query<{ user_id: string | null; route: string }>(`select user_id, route from rum_samples where session_id = $1`, [sid]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.user_id, null);
    assert.equal(rows[0]!.route, "/profile");
  } finally {
    await pool.query(`delete from rum_samples where session_id = $1`, [sid]);
  }
});
