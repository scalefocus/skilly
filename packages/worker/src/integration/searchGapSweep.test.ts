// Live-DB integration test for search gaps (SKILLY_SPEC.md §62.3–§62.5, §62.9).
// Gated behind SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL.
//
// Validates: recording stores a hash and no user id; housekeeping folds a finished day into daily
// counts and deletes its hits and salt; the sweep turns queries with enough people into gaps, skips
// tombstoned queries, deletes a gap an org-visible skill now answers, stores a restricted match,
// drafts with a stubbed provider (and never sends the restricted skill), notifies platform admins once
// (coalesced) and records the run; with the switch off nothing runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptAiToken } from "@skilly/shared/ai";
import { foldSearchGapDays, gapQueryHash, maybeRecordGapHit, resetGapSaltCache } from "@skilly/shared";
import { sweepSearchGaps } from "../searchGaps.js";

const enabled = process.env.SKILLY_DB_E2E === "1";
const KEY = Buffer.alloc(32, 7);

test("search gaps: recording, folding, the sweep, drafting and the admin notification", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;
  const setSetting = (key: string, value: unknown) =>
    q(
      `insert into platform_settings (key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  // Made-up words, unique to this run: the database is shared with other suites (search.dbtest.ts
  // uses its own fixture words), so nothing here may match another test's queries.
  const tag = `sgw${Date.now().toString(36)}`;
  const qAnswered = `${tag} sgwanswered`;
  const qRestricted = `${tag} sgwhidden`;
  const qOpen = `${tag} sgwopen`;
  const qTomb = `${tag} sgwtomb`;
  const queries = [qAnswered, qRestricted, qOpen, qTomb];

  let ns: string | null = null;
  try {
    // A platform admin to notify.
    const admin = await one(
      `insert into users (entra_object_id, email, display_name, status) values ('sgw-admin', 'sgw-admin@org', 'SGW Admin', 'active')
       on conflict (entra_object_id) do update set status = 'active' returning id`,
    );
    const grp = await one(
      `insert into groups (entra_object_id, display_name) values ('sgw-pa-grp', 'SGW Platform Admins')
       on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
    );
    await q(`insert into role_mappings (group_id, namespace_id, role) select $1, null, 'platform_admin' where not exists (select 1 from role_mappings where group_id = $1 and role = 'platform_admin')`, [grp]);
    await q(`insert into group_memberships (group_id, user_id) values ($1, $2) on conflict do nothing`, [grp, admin]);
    await q(`delete from notifications where user_id = $1 and type = 'search_gaps.ready'`, [admin]);

    // Skills: one org-visible that answers qAnswered, one namespace-visible that matches qRestricted.
    ns = await one(
      `insert into namespaces (slug, display_name, require_review) values ('sgw-ns', 'SGW NS', true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    );
    const mkSkill = (slug: string, title: string, visibility: "org" | "namespace") =>
      one(
        `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
         values ($1, $2, $3, $3, 'generic', 'hosted', $4, 'active')
         on conflict (namespace_id, slug) do update set title = excluded.title, description = excluded.description, visibility = excluded.visibility, status = 'active'
         returning id`,
        [ns, slug, title, visibility],
      );
    await mkSkill(`${tag}-pub`, `${tag} sgwanswered helper`, "org");
    const hidden = await mkSkill(`${tag}-hid`, `${tag} sgwhidden helper`, "namespace");

    // ── Recording: the switch gates it, and a hit stores a hash, never the user ──
    await setSetting("search_gaps_enabled", false);
    const facts = { userId: admin, surface: "web" as const, rawQuery: qOpen, explicit: true, narrowed: false, total: 0, matchMode: "all" as const };
    assert.equal(await maybeRecordGapHit(pool, facts), "skipped");
    await setSetting("search_gaps_enabled", true);
    resetGapSaltCache();
    assert.equal(await maybeRecordGapHit(pool, facts), "recorded");
    assert.equal(await maybeRecordGapHit(pool, facts), "recorded");
    const { rows: hitRows } = await q<{ hits: number; searcher_hash: Buffer }>(`select hits, searcher_hash from search_gap_hits where query_norm = $1`, [qOpen]);
    assert.equal(hitRows.length, 1, "one row per searcher per day");
    assert.equal(hitRows[0]!.hits, 2);
    assert.equal(hitRows[0]!.searcher_hash.length, 32);
    const cols = (await q<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'search_gap_hits'`)).rows.map((r) => r.column_name);
    assert.ok(!cols.some((c) => /user|created|time/.test(c)), "no user id and no timestamp column");

    // ── Housekeeping: yesterday's hits fold into daily counts; hits and salt go ──
    await q(`insert into search_gap_salts (day, salt) values ((now() at time zone 'UTC')::date - 1, $1) on conflict do nothing`, [Buffer.alloc(32, 3)]);
    for (const query of queries) {
      for (let i = 0; i < 3; i++) {
        await q(
          `insert into search_gap_hits (day, query_norm, surface, mode, searcher_hash, hits)
           values ((now() at time zone 'UTC')::date - 1, $1, 'web', 'none', $2, 2) on conflict do nothing`,
          [query, Buffer.alloc(32, 10 + i)],
        );
      }
    }
    const client = await pool.connect();
    try {
      await foldSearchGapDays(client);
    } finally {
      client.release();
    }
    const daily = (await q<{ hits: number; searchers: number }>(`select hits, searchers from search_gap_daily where query_norm = $1`, [qOpen])).rows[0];
    assert.deepEqual(daily, { hits: 6, searchers: 3 });
    assert.equal((await q(`select 1 from search_gap_hits where day < (now() at time zone 'UTC')::date and query_norm = any($1::text[])`, [queries])).rows.length, 0);
    assert.equal((await q(`select 1 from search_gap_salts where day < (now() at time zone 'UTC')::date`)).rows.length, 0);

    // ── The sweep ──
    await q(`insert into search_gap_tombstones (query_hash, outcome) values ($1, 'dismissed') on conflict do nothing`, [gapQueryHash(qTomb)]);
    await setSetting("search_gaps_min_searchers", 2);
    await setSetting("search_gaps_lookback_days", 30);
    await q(`delete from ai_integration`);
    await q(
      `insert into ai_integration (id, enabled, provider, base_url, model, token_enc, token_last4, last_test_at, last_test_ok)
       values (1, true, 'anthropic', 'https://api.anthropic.com', 'stub-model', $1, 'tok9', now(), true)`,
      [encryptAiToken("stubtok9", KEY)],
    );
    const prompts: string[] = [];
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body ?? "{}")) as { messages: { content: string }[] };
      const content = req.messages[0]!.content;
      prompts.push(content);
      const draft = { kind: "request", title: "A flumoxer skill", description: "Flumoxes things.", usage: "Flumox it", categories: [], tool: null, rationale: "Nothing does this." };
      return new Response(JSON.stringify({ model: "stub-model", content: [{ type: "text", text: JSON.stringify(draft) }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const env = { key: KEY, source: "worker" as const, fetchImpl, sleep: async () => {} };

    const r = await sweepSearchGaps(pool, { env, force: true });
    assert.equal(r.ran, true);
    const gaps = (await q<{ query_norm: string; state: string; ai_kind: string | null; restricted_matches: { skillId: string }[]; searchers: number }>(
      `select query_norm, state, ai_kind, restricted_matches, searchers from search_gaps where query_norm = any($1::text[])`,
      [queries],
    )).rows;
    const by = new Map(gaps.map((g) => [g.query_norm, g]));
    assert.ok(!by.has(qAnswered), "an org-visible skill answers it: no gap");
    assert.ok(!by.has(qTomb), "a tombstoned query is never a gap");
    assert.ok(by.has(qOpen), "the open query is a gap");
    assert.equal(by.get(qOpen)!.searchers, 4, "3 yesterday + 1 today, counted per day");
    assert.equal(by.get(qOpen)!.state, "suggested");
    assert.equal(by.get(qOpen)!.ai_kind, "request");
    assert.deepEqual(by.get(qRestricted)!.restricted_matches, [{ skillId: hidden }]);
    assert.ok(prompts.length > 0);
    assert.ok(!prompts.some((p) => p.includes(`${tag}-hid`)), "a restricted skill is never sent to the provider");

    const note = (await q<{ payload: { count: number } }>(`select payload from notifications where user_id = $1 and type = 'search_gaps.ready' and read_at is null`, [admin])).rows;
    assert.equal(note.length, 1, "one coalesced row");
    assert.ok(note[0]!.payload.count >= 2);
    const last = (await q<{ value: { ok: boolean } }>(`select value from platform_settings where key = 'search_gaps_last_run'`)).rows[0]!.value;
    assert.equal(last.ok, true);

    // A second run soon after is not due; nothing changes.
    assert.equal((await sweepSearchGaps(pool, { env })).ran, false);

    // ── Switch off: nothing runs ──
    await setSetting("search_gaps_enabled", false);
    assert.equal((await sweepSearchGaps(pool, { env, force: true })).ran, false);
  } finally {
    await setSetting("search_gaps_enabled", false);
    await q(`delete from search_gaps where query_norm like $1`, [`${tag}%`]);
    await q(`delete from search_gap_hits where query_norm like $1`, [`${tag}%`]);
    await q(`delete from search_gap_daily where query_norm like $1`, [`${tag}%`]);
    await q(`delete from search_gap_tombstones where query_hash = $1`, [gapQueryHash(qTomb)]);
    await q(`delete from ai_integration`);
    // Leave no searchable skill behind for the suites that run after this one.
    if (ns) await q(`delete from skills where namespace_id = $1 and slug like $2`, [ns, `${tag}-%`]);
    await pool.end();
  }
});
