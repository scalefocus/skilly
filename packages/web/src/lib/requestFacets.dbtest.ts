// Live-DB integration test for the Requested-skills facet vocabulary (SKILLY_SPEC.md §26).
// Gated by SKILLY_DB_E2E=1. The two properties under test are the ones the spec turns on:
//   * FILTER-INDEPENDENT — narrowing the list by category/tool/q must NOT narrow the vocabulary,
//     so the Category row's "· <n>" header count can never read "· 1" while many categories exist.
//   * SCOPE-AWARE — it still honours the caller's Mine / state scope, so no chip is offered that
//     would yield an empty list.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { listRequestFacets, listOpenRequests, listMyRequests, clearRequestFacetsCache } from "./requests";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

after(async () => {
  if (enabled) await pool.end();
});

async function mkUser(key: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ($1, $2, $1)
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
    [key, `${key}@org`],
  )).rows[0]!.id;
}

async function mkRequest(
  requesterUserId: string,
  title: string,
  opts: { tool?: string; state?: "open" | "fulfilled"; categories?: string[] } = {},
): Promise<string> {
  const id = (await pool.query<{ id: string }>(
    `insert into skill_requests (requester_user_id, title, description, tool_harness, state)
     values ($1, $2, 'd', $3, $4) returning id`,
    [requesterUserId, title, opts.tool ?? "claude", opts.state ?? "open"],
  )).rows[0]!.id;
  for (const name of opts.categories ?? []) {
    const cat = (await pool.query<{ id: string }>(
      `insert into categories (name) values ($1) on conflict (name) do update set name = excluded.name returning id`,
      [name],
    )).rows[0]!.id;
    await pool.query(
      `insert into skill_request_categories (request_id, category_id) values ($1, $2) on conflict do nothing`,
      [id, cat],
    );
  }
  return id;
}

/** Only this fixture's own categories — the table is shared with every other request in the DB. */
function only(facets: { name: string; count: number }[], names: string[]): { name: string; count: number }[] {
  return facets.filter((f) => names.includes(f.name));
}

const CATS = ["rqf-alpha", "rqf-beta", "rqf-gamma"];

test("listRequestFacets: the vocabulary is filter-independent", { skip: !enabled }, async () => {
  clearRequestFacetsCache();
  const asker = await mkUser("rqf-asker");
  const ids = [
    await mkRequest(asker, "rqf one", { categories: ["rqf-alpha"], tool: "claude" }),
    await mkRequest(asker, "rqf two", { categories: ["rqf-alpha", "rqf-beta"], tool: "cursor" }),
    await mkRequest(asker, "rqf three", { categories: ["rqf-gamma"], tool: "claude" }),
  ];
  try {
    // Selecting a category really does narrow the LIST...
    const listed = await listOpenRequests({ category: "rqf-gamma" });
    assert.equal(listed.filter((r) => ids.includes(r.id)).length, 1);

    // ...but the facets take no q/category/tool at all, so the vocabulary is the whole scope.
    const facets = await listRequestFacets({ states: ["open"] });
    assert.deepEqual(only(facets.categories, CATS).map((c) => c.name).sort(), [...CATS].sort());

    // Counts are per-request, deduped across a request's multiple categories.
    const byName = new Map(facets.categories.map((c) => [c.name, c.count]));
    assert.equal(byName.get("rqf-alpha"), 2);
    assert.equal(byName.get("rqf-beta"), 1);
    assert.equal(byName.get("rqf-gamma"), 1);

    // Tools likewise: both harnesses stay on offer even though a category filter would hide one.
    const tools = facets.tools.map((t) => t.name);
    assert.ok(tools.includes("claude") && tools.includes("cursor"));
  } finally {
    await pool.query(`delete from skill_requests where id = any($1::uuid[])`, [ids]);
  }
});

test("listRequestFacets: the state scope is honoured", { skip: !enabled }, async () => {
  clearRequestFacetsCache();
  const asker = await mkUser("rqf-asker");
  const openId = await mkRequest(asker, "rqf open one", { categories: ["rqf-alpha"] });
  const doneId = await mkRequest(asker, "rqf done one", { categories: ["rqf-gamma"], state: "fulfilled" });
  try {
    // Default (everyone's view) is open-only — a fulfilled request's category is not on offer.
    const openOnly = await listRequestFacets();
    assert.deepEqual(only(openOnly.categories, CATS).map((c) => c.name), ["rqf-alpha"]);

    // The admin "All" scope widens the vocabulary to match the wider list.
    const all = await listRequestFacets({ states: ["open", "fulfilled"] });
    assert.deepEqual(only(all.categories, CATS).map((c) => c.name).sort(), ["rqf-alpha", "rqf-gamma"]);

    // And "Fulfilled" alone offers only what a fulfilled row actually carries.
    const done = await listRequestFacets({ states: ["fulfilled"] });
    assert.deepEqual(only(done.categories, CATS).map((c) => c.name), ["rqf-gamma"]);
  } finally {
    await pool.query(`delete from skill_requests where id = any($1::uuid[])`, [[openId, doneId]]);
  }
});

test("listRequestFacets: Mine is per-requester and spans every state", { skip: !enabled }, async () => {
  clearRequestFacetsCache();
  const mine = await mkUser("rqf-mine");
  const other = await mkUser("rqf-other");
  const myOpen = await mkRequest(mine, "rqf mine open", { categories: ["rqf-alpha"] });
  const myDone = await mkRequest(mine, "rqf mine done", { categories: ["rqf-beta"], state: "fulfilled" });
  const theirs = await mkRequest(other, "rqf theirs", { categories: ["rqf-gamma"] });
  try {
    const facets = await listRequestFacets({ requesterUserId: mine });
    // Mine spans open AND fulfilled (matching listMyRequests, which carries no state clause)...
    assert.deepEqual(only(facets.categories, CATS).map((c) => c.name).sort(), ["rqf-alpha", "rqf-beta"]);
    // ...and never leaks another person's categories into my chips.
    assert.ok(!facets.categories.some((c) => c.name === "rqf-gamma"));

    // The list it describes agrees: every chip on offer yields at least one row.
    for (const c of only(facets.categories, CATS)) {
      const rows = await listMyRequests(mine, { category: c.name });
      assert.ok(rows.length > 0, `chip ${c.name} yielded an empty list`);
    }
  } finally {
    await pool.query(`delete from skill_requests where id = any($1::uuid[])`, [[myOpen, myDone, theirs]]);
  }
});
