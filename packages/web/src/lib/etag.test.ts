// Unit tests for the polled-JSON ETags (SKILLY_SPEC.md §60.3, §60.11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionalJson, ifNoneMatchHits, weakEtag } from "./etag";

test("weakEtag: stable for the same body, different for another", () => {
  const a = weakEtag('{"items":[]}');
  assert.match(a, /^W\/"[A-Za-z0-9_-]+"$/);
  assert.equal(weakEtag('{"items":[]}'), a);
  assert.notEqual(weakEtag('{"items":[1]}'), a);
});

test("ifNoneMatchHits: weak comparison, lists and *", () => {
  const tag = weakEtag("x");
  assert.equal(ifNoneMatchHits(null, tag), false);
  assert.equal(ifNoneMatchHits("", tag), false);
  assert.equal(ifNoneMatchHits(tag, tag), true);
  assert.equal(ifNoneMatchHits(tag.replace(/^W\//, ""), tag), true, "W/ ignored");
  assert.equal(ifNoneMatchHits(`W/"other", ${tag}`, tag), true, "one of several");
  assert.equal(ifNoneMatchHits("*", tag), true);
  assert.equal(ifNoneMatchHits('W/"other"', tag), false);
});

test("conditionalJson: 200 with the body and tag, then 304 with no body", async () => {
  const value = { items: [{ id: "a", votes: 2 }] };
  const first = conditionalJson(new Request("http://x/api/coming-soon"), value);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), value);
  const etag = first.headers.get("etag")!;
  assert.equal(first.headers.get("content-type"), "application/json");
  const again = conditionalJson(new Request("http://x/api/coming-soon", { headers: { "if-none-match": etag } }), value);
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  assert.equal(again.headers.get("etag"), etag);
  const changed = conditionalJson(new Request("http://x/api/coming-soon", { headers: { "if-none-match": etag } }), { items: [] });
  assert.equal(changed.status, 200);
});
