// Live-DB integration test for the search-gap decisions and Platform requests (SKILLY_SPEC.md §62.6,
// §62.8, §62.10, §62.12). Gated by SKILLY_DB_E2E=1. Covers: accepting a gap as a Platform request
// (no requester, tombstone, counts deleted, audit without the query text, the restricted skill's
// owners notified), a stale version (409), dismissing (tombstone, row gone), accepting as a synonym
// (the §34.8 422 leaves the gap untouched; success links the group), the settings bounds (422) and
// their audit, and the Platform request lifecycle: listed as "Platform", edited only by platform
// admins, fulfilled with credit to the fulfiller and no requester notification.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { gapQueryHash } from "@skilly/shared";
import { pool } from "./db";
import { acceptGapAsRequest, acceptGapAsSynonym, dismissGap, getSearchGapSettings, updateSearchGapSettings } from "./searchGaps";
import { closeRequest, fulfilWithExistingSkill, getRequest, listMyRequests, updateRequest } from "./requests";

const enabled = process.env.SKILLY_DB_E2E === "1";

after(async () => {
  if (enabled) await pool.end();
});

// Fixed actors: audit_log rows reference them and are append-only, so they are never deleted.
async function mkUser(oid: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ($1, $1 || '@org', $1, 'active')
     on conflict (entra_object_id) do update set status = 'active' returning id`,
    [oid],
  )).rows[0]!.id;
}

async function mkGap(query: string, restricted: string[] = []): Promise<{ id: string; version: string }> {
  await pool.query(`delete from search_gaps where query_norm = $1`, [query]);
  await pool.query(`delete from search_gap_tombstones where query_hash = $1`, [gapQueryHash(query)]);
  await pool.query(
    `insert into search_gap_daily (day, query_norm, surface, mode, hits, searchers)
     values ((now() at time zone 'UTC')::date - 1, $1, 'web', 'none', 5, 3) on conflict do nothing`,
    [query],
  );
  return (await pool.query<{ id: string; version: string }>(
    `insert into search_gaps (query_norm, query_hash, mode, surfaces, hits, searchers, first_day, last_day, state, restricted_matches)
     values ($1, $2, 'none', '{web}', 5, 3, current_date - 1, current_date - 1, 'new', $3::jsonb)
     returning id, updated_at::text as version`,
    [query, gapQueryHash(query), JSON.stringify(restricted.map((skillId) => ({ skillId })))],
  )).rows[0]!;
}

const REQUEST = { title: "A skill that merges PDFs", description: "Merge several PDFs into one.", usageExamples: "Merge a.pdf and b.pdf", toolHarness: "generic", categories: [] };

test("search gaps: accept as a Platform request, then its lifecycle", { skip: !enabled }, async () => {
  const tag = `sgdb${Date.now().toString(36)}`;
  const admin = await mkUser("sgdb-admin");
  const maint = await mkUser("sgdb-maint");
  const someone = await mkUser("sgdb-someone");
  const linker = await mkUser("sgdb-linker");
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('sgdb-ns', 'SGDB NS', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const mkSkill = async (slug: string, visibility: "org" | "namespace") => (await pool.query<{ id: string }>(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1, $2, $2, 'd', 'generic', 'hosted', $3, 'active')
     on conflict (namespace_id, slug) do update set visibility = excluded.visibility, status = 'active' returning id`,
    [ns, slug, visibility],
  )).rows[0]!.id;
  const hidden = await mkSkill("sgdb-hidden", "namespace");
  const open = await mkSkill("sgdb-open", "org");
  await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1, $2) on conflict do nothing`, [hidden, maint]);

  const query = `${tag} merge pdfs`;
  const gap = await mkGap(query, [hidden]);
  let requestId: string | null = null;
  try {
    // A stale version is refused and changes nothing.
    assert.equal((await acceptGapAsRequest(admin, gap.id, REQUEST, "1999-01-01")).ok, false);

    const r = await acceptGapAsRequest(admin, gap.id, REQUEST, gap.version);
    assert.ok(r.ok, JSON.stringify(r));
    requestId = r.ok ? r.requestId : null;

    const row = (await pool.query<{ requester_user_id: string | null; origin: string }>(`select requester_user_id, origin from skill_requests where id = $1`, [requestId])).rows[0]!;
    assert.deepEqual(row, { requester_user_id: null, origin: "search_gap" });
    const view = await getRequest(requestId!);
    assert.equal(view?.requesterName, "Platform");
    assert.equal(view?.requesterUserId, null);
    assert.ok(!(await listMyRequests(admin)).some((x) => x.id === requestId), "a Platform request is nobody's own");

    const g = (await pool.query<{ state: string; outcome: string; outcome_request_id: string }>(`select state, outcome, outcome_request_id from search_gaps where id = $1`, [gap.id])).rows[0]!;
    assert.deepEqual(g, { state: "accepted", outcome: "request", outcome_request_id: requestId });
    assert.equal((await pool.query(`select 1 from search_gap_tombstones where query_hash = $1`, [gapQueryHash(query)])).rows.length, 1);
    assert.equal((await pool.query(`select 1 from search_gap_daily where query_norm = $1`, [query])).rows.length, 0, "its counts are deleted");

    const audit = (await pool.query<{ after: unknown }>(`select after from audit_log where action = 'search_gap.accepted' and target_id = $1`, [gap.id])).rows[0]!;
    assert.ok(!JSON.stringify(audit.after).includes(tag), "the audit row never holds the query text");
    assert.equal((audit.after as { queryHash: string }).queryHash, gapQueryHash(query).toString("hex"));

    const hiddenNote = (await pool.query<{ payload: { skillSlug: string; query: string } }>(
      `select payload from notifications where user_id = $1 and type = 'skill.search_gap_hidden_match' and payload->>'skillId' = $2`,
      [maint, hidden],
    )).rows;
    assert.equal(hiddenNote.length, 1, "the restricted skill's maintainer is told");
    assert.equal(hiddenNote[0]!.payload.skillSlug, "sgdb-hidden");

    // Accepting twice is a conflict.
    assert.equal((await acceptGapAsRequest(admin, gap.id, REQUEST, gap.version)).ok, false);

    // Editing: platform admins only. Nobody withdraws it.
    assert.deepEqual(await updateRequest(someone, requestId!, { ...REQUEST, title: "x" }, false), { error: "only platform admins can edit a Platform request", status: 403 });
    assert.deepEqual(await updateRequest(admin, requestId!, { ...REQUEST, title: "Merge PDF files" }, true), { ok: true });
    assert.equal((await getRequest(requestId!))?.title, "Merge PDF files");
    assert.equal((await closeRequest(someone, false, requestId!) as { status: number }).status, 403);

    // Fulfilment: credit to the fulfiller, no requester notification, nothing throws on the null.
    assert.deepEqual(await fulfilWithExistingSkill(linker, requestId!, "sgdb-ns", "sgdb-open"), { ok: true });
    const genie = (await pool.query(`select 1 from user_achievements where user_id = $1 and key = 'first_fulfilment'`, [linker])).rows.length;
    assert.equal(genie, 1, "the fulfiller earns Genie");
    const fulfilledNotes = (await pool.query(`select 1 from notifications where type = 'request.fulfilled' and payload->>'requestId' = $1`, [requestId])).rows.length;
    assert.equal(fulfilledNotes, 0, "no requester to notify");
    void open;
  } finally {
    await pool.query(`delete from search_gaps where id = $1`, [gap.id]);
    await pool.query(`delete from search_gap_tombstones where query_hash = $1`, [gapQueryHash(query)]);
    if (requestId) await pool.query(`delete from skill_requests where id = $1`, [requestId]);
    await pool.query(`delete from notifications where type = 'skill.search_gap_hidden_match' and payload->>'skillId' = $1`, [hidden]);
    // Leave no searchable skill behind for the suites that run after this one.
    await pool.query(`delete from skills where id = any($1::uuid[])`, [[hidden, open]]);
  }
});

test("search gaps: dismiss tombstones; synonym accept respects the §34.8 rules", { skip: !enabled }, async () => {
  const tag = `sgdc${Date.now().toString(36)}`;
  const admin = await mkUser("sgdb-admin");
  const dq = `${tag} dismissme`;
  const sq = `${tag}syn`;
  const d = await mkGap(dq);
  const s = await mkGap(sq);
  let groupId: string | null = null;
  try {
    assert.deepEqual(await dismissGap(admin, d.id, d.version), { ok: true });
    assert.equal((await pool.query(`select 1 from search_gaps where id = $1`, [d.id])).rows.length, 0);
    assert.equal((await pool.query<{ outcome: string }>(`select outcome from search_gap_tombstones where query_hash = $1`, [gapQueryHash(dq)])).rows[0]?.outcome, "dismissed");
    const audit = (await pool.query<{ after: unknown }>(`select after from audit_log where action = 'search_gap.dismissed' and target_id = $1`, [d.id])).rows[0]!;
    assert.ok(!JSON.stringify(audit.after).includes(tag));

    // One term only: the synonym write refuses (422) and the gap is untouched.
    const bad = await acceptGapAsSynonym(admin, s.id, { groupId: null, terms: [sq] }, s.version);
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.status, 422);
    assert.equal((await pool.query<{ state: string }>(`select state from search_gaps where id = $1`, [s.id])).rows[0]!.state, "new");

    const ok = await acceptGapAsSynonym(admin, s.id, { groupId: null, terms: [sq, `${tag}alias`] }, s.version);
    assert.ok(ok.ok, JSON.stringify(ok));
    groupId = ok.ok ? ok.groupId : null;
    const g = (await pool.query<{ state: string; outcome_synonym_group_id: string }>(`select state, outcome_synonym_group_id from search_gaps where id = $1`, [s.id])).rows[0]!;
    assert.deepEqual(g, { state: "accepted", outcome_synonym_group_id: groupId });
  } finally {
    await pool.query(`delete from search_gaps where query_norm = any($1::text[])`, [[dq, sq]]);
    await pool.query(`delete from search_gap_tombstones where query_hash = any($1::bytea[])`, [[gapQueryHash(dq), gapQueryHash(sq)]]);
    await pool.query(`delete from search_gap_daily where query_norm = any($1::text[])`, [[dq, sq]]);
    if (groupId) await pool.query(`delete from search_synonym_groups where id = $1`, [groupId]);
  }
});

test("search gaps: the settings are bounded and audited", { skip: !enabled }, async () => {
  const admin = await mkUser("sgdb-admin");
  const before = await getSearchGapSettings();
  try {
    assert.equal((await updateSearchGapSettings(admin, { searchGapsSweepHours: 0 })).ok, false);
    assert.equal((await updateSearchGapSettings(admin, { searchGapsLookbackDays: 91 })).ok, false);
    assert.equal((await updateSearchGapSettings(admin, { searchGapsEnabled: "yes" })).ok, false);
    assert.deepEqual(await updateSearchGapSettings(admin, { searchGapsSweepHours: before.sweepHours === 12 ? 13 : 12 }), { ok: true });
    const audit = (await pool.query(`select 1 from audit_log where action = 'settings.updated' and target_id = 'search_gaps_sweep_hours' and created_at > now() - interval '1 minute'`)).rows.length;
    assert.ok(audit >= 1);
  } finally {
    await updateSearchGapSettings(admin, { searchGapsSweepHours: before.sweepHours });
  }
});
