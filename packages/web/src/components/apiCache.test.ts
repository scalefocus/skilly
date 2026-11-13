// The shared GET cache behind useApi / useSharedApi (components/apiCache.ts).
//
// Regression guard for the level-ring mismatch (SKILLY_SPEC.md §31.10): the sidebar's account bubble
// is mounted once for the whole visit, so it fetched /api/levels on first load and kept that level
// forever, while each page's own bubble of the same person fetched the current one — two rings of
// one person, two different arcs. Subscribers now take every later fetch of the URL.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { API_TTL_MS, fetchJson, invalidateApi, refreshApi, resetApiCacheForTests, subscribeApi } from "./apiCache";

const LEVELS = "/api/levels";
const ME = "00000000-0000-0000-0000-0000000000aa";

const realFetch = globalThis.fetch;
const realNow = Date.now;
let clock = 1_000_000;
let calls: string[] = [];
let bodies: Record<string, { status: number; body: unknown }> = {};

function serve(url: string, body: unknown, status = 200): void {
  bodies[url] = { status, body };
}
function levelMap(level: number): { levels: Record<string, number>; heroes: string[] } {
  return { levels: { [ME]: level }, heroes: [] };
}

beforeEach(() => {
  resetApiCacheForTests();
  calls = [];
  bodies = {};
  clock = 1_000_000;
  Date.now = () => clock;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = bodies[url] ?? { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  resetApiCacheForTests();
});

test("the sidebar bubble takes the level a page fetched later — the two rings never disagree", async () => {
  // First load: the sidebar's account bubble mounts, subscribes and fetches level 3.
  serve(LEVELS, levelMap(3));
  const sidebar: unknown[] = [];
  subscribeApi(LEVELS, (d) => sidebar.push(d));
  assert.deepEqual(await fetchJson(LEVELS, false), levelMap(3));

  // Badges are earned; minutes later the user opens their hall. Its bubble mounts and fetches.
  serve(LEVELS, levelMap(10));
  clock += API_TTL_MS + 1;
  assert.deepEqual(await fetchJson(LEVELS, false), levelMap(10));

  // The sidebar bubble was not remounted, yet it holds the hall's level, not the first-load one.
  assert.deepEqual(sidebar.at(-1), levelMap(10));
  assert.equal(sidebar.length, 2);
});

test("refreshApi bypasses a still-fresh cache and pushes to every subscriber (the badge toast)", async () => {
  serve(LEVELS, levelMap(3));
  const a: unknown[] = [];
  const b: unknown[] = [];
  subscribeApi(LEVELS, (d) => a.push(d));
  subscribeApi(LEVELS, (d) => b.push(d));
  await fetchJson(LEVELS, false);

  serve(LEVELS, levelMap(4));
  // Well inside the TTL: a plain read would still be served from the cache…
  assert.deepEqual(await fetchJson(LEVELS, false), levelMap(3));
  // …but the toast's refresh goes to the network and reaches both bubbles.
  await refreshApi(LEVELS);
  assert.deepEqual(a.at(-1), levelMap(4));
  assert.deepEqual(b.at(-1), levelMap(4));
  // And the refreshed body is what the next plain read gets.
  assert.deepEqual(await fetchJson(LEVELS, false), levelMap(4));
});

test("a body is pushed only to subscribers of its own URL", async () => {
  serve(LEVELS, levelMap(5));
  serve("/api/leaders", {});
  const leaders: unknown[] = [];
  subscribeApi("/api/leaders", (d) => leaders.push(d));
  await fetchJson(LEVELS, true);
  assert.equal(leaders.length, 0);
});

test("unsubscribing stops the pushes — an unmounted bubble is never written to", async () => {
  serve(LEVELS, levelMap(2));
  const seen: unknown[] = [];
  const off = subscribeApi(LEVELS, (d) => seen.push(d));
  await fetchJson(LEVELS, true);
  off();
  off(); // idempotent
  serve(LEVELS, levelMap(9));
  await fetchJson(LEVELS, true);
  assert.deepEqual(seen, [levelMap(2)]);
});

test("a failed fetch pushes nothing: subscribers keep the level they had, and refreshApi never throws", async () => {
  serve(LEVELS, levelMap(6));
  const seen: unknown[] = [];
  subscribeApi(LEVELS, (d) => seen.push(d));
  await fetchJson(LEVELS, true);
  serve(LEVELS, { error: "boom" }, 500);
  await assert.doesNotReject(refreshApi(LEVELS));
  await assert.rejects(fetchJson(LEVELS, true), /boom/);
  assert.deepEqual(seen, [levelMap(6)]);
});

test("the cache still dedupes: concurrent reads share one request, and a fresh body is served without one", async () => {
  serve(LEVELS, levelMap(1));
  const [x, y] = await Promise.all([fetchJson(LEVELS, false), fetchJson(LEVELS, false)]);
  assert.deepEqual(x, y);
  assert.equal(calls.length, 1);
  clock += API_TTL_MS - 1;
  await fetchJson(LEVELS, false);
  assert.equal(calls.length, 1);
  clock += 2;
  await fetchJson(LEVELS, false);
  assert.equal(calls.length, 2);
  // invalidateApi drops the body, so the next read refetches.
  invalidateApi(LEVELS);
  await fetchJson(LEVELS, false);
  assert.equal(calls.length, 3);
});

test("UserBubble reads its three page-wide maps through useSharedApi, never the unsubscribed useApi", () => {
  // The sidebar bubble is the one bubble that is never remounted. If any of these maps is read with
  // plain useApi again, its ring / leader badges / hat freeze at first load (§31.10, §21, §67.3).
  const src = readFileSync(new URL("./UserBubble.tsx", import.meta.url), "utf8");
  for (const url of ["/api/levels", "/api/leaders", "/api/newcomers"]) {
    assert.match(src, new RegExp(`useSharedApi<[^(]*\\(userId \\? "${url}"`), `${url} must be read with useSharedApi`);
  }
  assert.doesNotMatch(src, /\buseApi\s*[<(]/, "UserBubble must not call the unsubscribed useApi");
  assert.doesNotMatch(src, /import\s*\{[^}]*\buseApi\b[^}]*\}/, "UserBubble must not import the unsubscribed useApi");
});
