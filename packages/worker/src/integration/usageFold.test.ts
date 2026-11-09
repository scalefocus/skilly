// Live-DB integration test for the usage-insights fold (SKILLY_SPEC.md §68.6).
// Gated behind SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL.
//
// Validates: recording stores a day-salted hash and no user id; the same event twice is a duplicate;
// an unknown semver is dropped; the fold turns yesterday's hits into per-skill (uses + people) and
// per-version/trigger rows, deletes the hits and the salt, and leaves today's rows alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldSkillUsageDays, recordUsageHit, resetUsageSaltCache } from "@skilly/shared";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("usage insights: hits, duplicates, drops and the daily fold", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;
  // Fixed fixtures, upserted: skill_versions are immutable (no delete), so re-runs reuse the rows and
  // only the usage rows are wiped.
  const tag = "uf-fixed";
  let skill: string | null = null;
  const wipe = async () => {
    if (!skill) return;
    for (const t of ["skill_usage_hits", "skill_usage_daily", "skill_usage_daily_detail"]) await q(`delete from ${t} where skill_id = $1`, [skill]);
  };
  try {
    const user = await one(
      `insert into users (entra_object_id, email, display_name, status) values ('uf-user', 'uf-user@org', 'UF User', 'active')
       on conflict (entra_object_id) do update set status = 'active' returning id`,
    );
    const ns = await one(
      `insert into namespaces (slug, display_name, require_review) values ('uf-ns', 'UF NS', true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    );
    skill = await one(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1, $2, 'UF skill', 'd', 'generic', 'hosted', 'org', 'active')
       on conflict (namespace_id, slug) do update set status = 'active' returning id`,
      [ns, `${tag}-skill`],
    );
    for (const v of ["1.0.0", "1.1.0"]) {
      await q(
        `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
         values ($1, $2, false, 'active', $3, 'h', $4, true) on conflict do nothing`,
        [skill, v, `k/uf/${v}`, user],
      );
    }
    await wipe();

    // ── Recording ──
    resetUsageSaltCache();
    assert.equal(await recordUsageHit(pool, { userId: user, skillId: skill, semver: "1.1.0", trigger: "model", eventId: "ev-1" }), "recorded");
    assert.equal(await recordUsageHit(pool, { userId: user, skillId: skill, semver: "1.1.0", trigger: "model", eventId: "ev-1" }), "duplicate", "the dual-plugin case");
    assert.equal(await recordUsageHit(pool, { userId: user, skillId: skill, semver: "9.9.9", trigger: "model", eventId: "ev-2" }), "dropped", "unknown semver");
    assert.equal(await recordUsageHit(pool, { userId: user, skillId: skill, semver: "1.0.0", trigger: "user", eventId: "ev-3" }), "recorded");
    const { rows: hits } = await q<{ reporter_hash: Buffer; event_hash: Buffer }>(`select reporter_hash, event_hash from skill_usage_hits where skill_id = $1`, [skill]);
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.reporter_hash.length, 32);
    const cols = (await q<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'skill_usage_hits'`)).rows.map((r) => r.column_name);
    assert.ok(!cols.some((c) => /user|created|time|session|ip/.test(c)), "no user id, timestamp, session or ip column");

    // ── The fold: yesterday's rows become daily counts; hits and salt go; today stays ──
    await q(`insert into skill_usage_salts (day, salt) values ((now() at time zone 'UTC')::date - 1, $1) on conflict do nothing`, [Buffer.alloc(32, 3)]);
    const y = `(now() at time zone 'UTC')::date - 1`;
    const ins = (semver: string, trigger: string, reporter: number, ev: number) =>
      q(`insert into skill_usage_hits (day, skill_id, semver, trigger, reporter_hash, event_hash) values (${y}, $1, $2, $3, $4, $5) on conflict do nothing`, [skill, semver, trigger, Buffer.alloc(32, reporter), Buffer.alloc(32, ev)]);
    await ins("1.1.0", "model", 1, 1);
    await ins("1.1.0", "model", 1, 2);
    await ins("1.1.0", "user", 2, 3);
    await ins("1.0.0", "model", 2, 4);
    await ins("1.0.0", "model", 3, 5);
    const client = await pool.connect();
    try {
      const r = await foldSkillUsageDays(client);
      assert.ok(r.foldedDays >= 1);
    } finally {
      client.release();
    }
    const daily = (await q<{ uses: number; people: number }>(`select uses, people from skill_usage_daily where skill_id = $1 and day = ${y}`, [skill])).rows[0];
    assert.deepEqual(daily, { uses: 5, people: 3 });
    const detail = (await q<{ semver: string; trigger: string; uses: number }>(`select semver, trigger, uses from skill_usage_daily_detail where skill_id = $1 and day = ${y} order by semver, trigger`, [skill])).rows;
    assert.deepEqual(detail, [
      { semver: "1.0.0", trigger: "model", uses: 2 },
      { semver: "1.1.0", trigger: "model", uses: 2 },
      { semver: "1.1.0", trigger: "user", uses: 1 },
    ]);
    assert.equal((await q(`select 1 from skill_usage_hits where day < (now() at time zone 'UTC')::date`)).rows.length, 0);
    assert.equal((await q(`select 1 from skill_usage_salts where day < (now() at time zone 'UTC')::date`)).rows.length, 0);
    assert.equal((await q(`select 1 from skill_usage_hits where skill_id = $1`, [skill])).rows.length, 2, "today's hits stay until their day ends");
  } finally {
    await wipe();
    await pool.end();
  }
});
