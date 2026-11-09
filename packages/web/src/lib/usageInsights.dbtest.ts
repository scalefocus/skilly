// Live-DB integration test for Usage insights (SKILLY_SPEC.md §68.4–§68.7). Gated by SKILLY_DB_E2E=1.
//
// Validates: the ingest endpoint — 401 for an unknown, deleted and inactive-owner key; 204 + recorded
// for a valid report, 204 + duplicate for the same event twice, 204 + dropped for an invisible skill
// and an unknown semver, 204 + discarded while the switch is off, 400 for a bad body, 429 past the
// limit. Keys — mint, 409 on a second mint, regenerate invalidates the old key, delete refuses the
// next report, the sharing state. The dashboard — `uses` windows and deltas, `sort=uses`, the
// breakdown's versions and triggers, everything absent while the switch is off. Erasure deletes the
// key row.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { type EffectiveAccess, findUsageKeyOwner, resetUsageSaltCache } from "@skilly/shared";
import { pool } from "./db";
import { getUsageDashboard, getBreakdown } from "./usage";
import { invalidatePlatformSettings } from "./settings";
import { deleteCallerUsageKey, mintCallerUsageKey, regenerateCallerUsageKey, usageSharingState } from "./usageKey";
import { eraseUser } from "./eraseUser";
import { POST as ingest, USAGE_REPORT_RATE_LIMIT_PER_MINUTE } from "../app/api/usage/reports/route";

const enabled = process.env.SKILLY_DB_E2E === "1";

after(async () => {
  if (enabled) await pool.end();
});

const setSetting = (key: string, value: unknown) =>
  pool.query(
    `insert into platform_settings (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  ).then(() => invalidatePlatformSettings());

function report(key: string | null, body: unknown): Promise<Response> {
  return ingest(
    new Request("http://localhost/api/usage/reports", {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

test("usage insights: ingest, keys, dashboard, breakdown, erasure", { skip: !enabled }, async () => {
  // Fixed fixtures, upserted: skill_versions are immutable (no delete), so re-runs reuse the rows and
  // only the usage rows are wiped. Event ids carry a per-run nonce so duplicates are real duplicates.
  const tag = "ui-fixed";
  const run = Date.now().toString(36);
  const one = async (sql: string, params: unknown[] = []) => (await pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  const mkUser = (oid: string, status = "active") =>
    one(
      `insert into users (entra_object_id, email, display_name, status) values ($1, $2, $1, $3)
       on conflict (entra_object_id) do update set status = excluded.status, erased_at = null, email = excluded.email returning id`,
      [oid, `${oid}@org`, status],
    );
  const sharer = await mkUser(`${tag}-sharer`);
  const inactive = await mkUser(`${tag}-inactive`, "inactive");
  const erasable = await mkUser(`${tag}-erasable`);
  const admin = await mkUser(`${tag}-admin`);
  const nsOpen = await one(`insert into namespaces (slug, display_name, require_review) values ($1, $1, true) on conflict (slug) do update set display_name = excluded.display_name returning id`, [`${tag}-ns`]);
  const nsClosed = await one(`insert into namespaces (slug, display_name, require_review) values ($1, $1, true) on conflict (slug) do update set display_name = excluded.display_name returning id`, [`${tag}-closed`]);
  const mkSkill = (ns: string, slug: string, visibility: "org" | "namespace") =>
    one(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1, $2, $2, 'd', 'claude', 'hosted', $3, 'active')
       on conflict (namespace_id, slug) do update set visibility = excluded.visibility, status = 'active' returning id`,
      [ns, slug, visibility],
    );
  const skill = await mkSkill(nsOpen, `${tag}-skill`, "org");
  const hidden = await mkSkill(nsClosed, `${tag}-hidden`, "namespace");
  for (const [s, v] of [[skill, "1.0.0"], [skill, "1.1.0"], [hidden, "1.0.0"]] as const) {
    await pool.query(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
       values ($1, $2, false, 'active', $3, 'h', $4, true) on conflict do nothing`,
      [s, v, `k/${tag}/${s}/${v}`, sharer],
    );
  }
  const wipeUsage = async () => {
    for (const t of ["skill_usage_hits", "skill_usage_daily", "skill_usage_daily_detail"]) await pool.query(`delete from ${t} where skill_id = any($1::uuid[])`, [[skill, hidden]]);
  };
  // A platform admin for the dashboard + the erasure actor.
  const platform: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };

  try {
    await setSetting("usage_insights_enabled", true);
    resetUsageSaltCache();
    await wipeUsage();
    for (const u of [sharer, inactive, erasable]) await deleteCallerUsageKey(u);

    // ── Keys ──
    const minted = (await mintCallerUsageKey(sharer))!;
    assert.ok(minted?.key, "a key is minted");
    assert.equal(minted.envVar, "SKILLY_USAGE_KEY");
    assert.deepEqual(JSON.parse(minted.snippet), { env: { SKILLY_USAGE_KEY: minted.key } });
    assert.equal(await mintCallerUsageKey(sharer), null, "a second mint is refused (409 at the route)");
    const state = await usageSharingState(sharer);
    assert.equal(state.enabled, true);
    assert.ok(state.key?.createdAt);
    assert.equal(state.key?.lastUsedAt, null);
    assert.deepEqual(await findUsageKeyOwner(pool, minted.key), { userId: sharer });
    const inactiveKey = (await mintCallerUsageKey(inactive))!;
    assert.equal(await findUsageKeyOwner(pool, inactiveKey.key), null, "an inactive owner's key resolves to nobody");

    // ── Ingest ──
    const good = { skillId: skill, semver: "1.1.0", trigger: "model", eventId: `${run}-e1` };
    assert.equal((await report(null, good)).status, 401, "no key");
    assert.equal((await report("nope", good)).status, 401, "unknown key");
    assert.equal((await report(inactiveKey.key, good)).status, 401, "inactive owner");
    assert.equal((await report(minted.key, "{not json")).status, 400);
    assert.equal((await report(minted.key, { skillId: "x" })).status, 400);
    assert.equal((await report(minted.key, good)).status, 204, "recorded");
    assert.equal((await report(minted.key, good)).status, 204, "duplicate (same event id)");
    assert.equal((await report(minted.key, { ...good, eventId: `${run}-e2`, semver: "9.9.9" })).status, 204, "unknown semver → dropped, still 204");
    assert.equal((await report(minted.key, { skillId: hidden, semver: "1.0.0", trigger: "user", eventId: `${run}-e3` })).status, 204, "invisible skill → dropped, still 204");
    assert.equal((await report(minted.key, { ...good, eventId: `${run}-e4`, trigger: "user", semver: "1.0.0" })).status, 204);
    const { rows: hits } = await pool.query<{ semver: string; trigger: string }>(`select semver, trigger from skill_usage_hits where skill_id = $1 order by semver, trigger`, [skill]);
    assert.deepEqual(hits, [{ semver: "1.0.0", trigger: "user" }, { semver: "1.1.0", trigger: "model" }], "two hits: the duplicate folded, the drops never stored");
    assert.equal((await pool.query(`select 1 from skill_usage_hits where skill_id = $1`, [hidden])).rows.length, 0, "nothing stored for the invisible skill");
    const touched = await usageSharingState(sharer);
    assert.ok(touched.key?.lastUsedAt, "last_used_at stamped");

    // ── Dashboard: uses as the third metric, today = the UTC day so far ──
    const dash = await getUsageDashboard(platform, admin, 30, `${tag}-skill`, "uses");
    assert.equal(dash.usageInsightsEnabled, true);
    const row = dash.skills.find((s) => s.skillSlug === `${tag}-skill`)!;
    assert.ok(row.uses, "uses present");
    assert.deepEqual([row.uses!.d1, row.uses!.d7, row.uses!.d30, row.uses!.all], [2, 2, 2, 2]);
    assert.equal(row.uses!.d1Prev, 0);
    assert.ok(row.daily.uses, "uses series present");
    assert.equal(row.daily.uses!.reduce((x, y) => x + y, 0), 2, "today's live hits land in the series");
    assert.ok(dash.aggregate?.uses, "platform aggregate carries uses");
    assert.ok((dash.aggregate!.uses!.d1 ?? 0) >= 2);
    assert.ok(dash.aggregate!.series.uses, "aggregate series carries uses");

    // ── Breakdown: versions newest first, the trigger split, people per day ──
    const bd = await getBreakdown(skill, new Date().toISOString(), "7d");
    assert.ok(bd.uses, "breakdown carries uses");
    assert.deepEqual(bd.uses!.versions, [{ semver: "1.1.0", uses: 1 }, { semver: "1.0.0", uses: 1 }]);
    assert.deepEqual(bd.uses!.triggers, { user: 1, model: 1 });
    assert.equal(bd.uses!.total, 2);
    const today = bd.uses!.series[bd.uses!.series.length - 1]!;
    assert.equal(today.uses, 2);
    assert.equal(today.people, 1, "one reporter today");

    // ── Regenerate: the old key dies at once; delete: the next report is refused ──
    const regenerated = await regenerateCallerUsageKey(sharer);
    assert.notEqual(regenerated.key, minted.key);
    assert.equal(await findUsageKeyOwner(pool, minted.key), null, "old key refused after regenerate");
    assert.deepEqual(await findUsageKeyOwner(pool, regenerated.key), { userId: sharer });
    assert.equal(await deleteCallerUsageKey(sharer), true);
    assert.equal(await findUsageKeyOwner(pool, regenerated.key), null, "deleted key refused");
    assert.equal((await usageSharingState(sharer)).key, null);
    assert.equal(await deleteCallerUsageKey(sharer), false, "nothing left to delete");

    // ── Switch off: ingest discards, the dashboard carries no uses at all ──
    const offKey = (await mintCallerUsageKey(sharer))!;
    await setSetting("usage_insights_enabled", false);
    assert.equal((await report(offKey.key, { ...good, eventId: `${run}-off` })).status, 204, "accept-and-discard");
    assert.equal((await pool.query(`select 1 from skill_usage_hits where skill_id = $1 and event_hash = sha256($2::bytea)`, [skill, Buffer.from(`${run}-off`)])).rows.length, 0);
    const off = await getUsageDashboard(platform, admin, 30, `${tag}-skill`);
    assert.equal(off.usageInsightsEnabled, false);
    const offRow = off.skills.find((s) => s.skillSlug === `${tag}-skill`)!;
    assert.equal("uses" in offRow, false, "no uses field while off");
    assert.equal("uses" in offRow.daily, false);
    assert.equal("uses" in (off.aggregate ?? {}), false);
    assert.equal("uses" in (await getBreakdown(skill, new Date().toISOString(), "7d")), false);
    assert.equal((await usageSharingState(sharer)).enabled, false);

    // ── Erasure deletes the key row ──
    await setSetting("usage_insights_enabled", true);
    const erasableKey = (await mintCallerUsageKey(erasable))!;
    assert.deepEqual(await findUsageKeyOwner(pool, erasableKey.key), { userId: erasable });
    const erased = await eraseUser(admin, erasable, null);
    assert.equal(erased.ok, true, JSON.stringify(erased));
    assert.equal((await pool.query(`select 1 from usage_report_keys where user_id = $1`, [erasable])).rows.length, 0, "key row gone");
    assert.equal(await findUsageKeyOwner(pool, erasableKey.key), null);

    const rlKey = (await regenerateCallerUsageKey(sharer));
    // ── Rate limit: the per-key window (last — it is keyed by user and would starve the checks above) ──
    let limited = false;
    for (let i = 0; i < USAGE_REPORT_RATE_LIMIT_PER_MINUTE + 2 && !limited; i++) {
      const r = await report(rlKey.key, { ...good, eventId: `${run}-rl-${i}` });
      if (r.status === 429) limited = true;
    }
    assert.ok(limited, "429 past the per-key limit");

  } finally {
    await setSetting("usage_insights_enabled", false);
    for (const u of [sharer, inactive]) await deleteCallerUsageKey(u);
    await wipeUsage();
  }
});
