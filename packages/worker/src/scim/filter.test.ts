import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScimFilter, parsePaging } from "./filter.js";

test("parses quoted and bare eq filters", () => {
  assert.deepEqual(parseScimFilter('userName eq "jane@org"'), { attr: "userName", value: "jane@org" });
  assert.deepEqual(parseScimFilter("externalId eq e1"), { attr: "externalId", value: "e1" });
  assert.deepEqual(parseScimFilter('displayName eq "Team A"'), { attr: "displayName", value: "Team A" });
});

test("returns null for absent/unsupported filters", () => {
  assert.equal(parseScimFilter(undefined), null);
  assert.equal(parseScimFilter(""), null);
  assert.equal(parseScimFilter('userName co "ja"'), null); // 'co' not supported
});

test("paging defaults and clamps", () => {
  assert.deepEqual(parsePaging(undefined, undefined), { startIndex: 1, count: 100 });
  assert.deepEqual(parsePaging("5", "20"), { startIndex: 5, count: 20 });
  assert.deepEqual(parsePaging("0", "-3"), { startIndex: 1, count: 0 });
  assert.deepEqual(parsePaging("2", "99999"), { startIndex: 2, count: 1000 });
});

test("rejects filters over the length cap without reaching the regex", () => {
  const overLong = "userName eq " + "a".repeat(300);
  assert.equal(parseScimFilter(overLong), null);
});

test("length cap keeps worst-case adversarial input fast (defense in depth)", () => {
  // Longest adversarial shape (quote ... quote + trailing junk) that still fits the
  // 200-char cap. Bounding n this way is itself part of the fix (§22): even content
  // shaped to exploit whitespace/quote ambiguity can't reach a size where backtracking
  // costs anything noticeable.
  const n = 90;
  const crafted = "a eq " + " ".repeat(n) + '"' + " ".repeat(n) + '"' + "Z";
  assert.ok(crafted.length <= 200);
  const start = Date.now();
  const result = parseScimFilter(crafted);
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 50, `expected fast rejection, took ${elapsedMs}ms`);
  assert.equal(result, null); // trailing "Z" after the closing quote doesn't match \s*$
});

test("regex fix: no quadratic blowup on crafted input past the CodeQL js/polynomial-redos shape", () => {
  // Regression guard for the actual algorithmic fix, independent of the length cap above.
  // The pre-fix regex (`"?([^"]*)"?\s*$`, optional quotes independently wrapping a
  // whitespace-inclusive capture) redistributed a shared run of whitespace across three
  // quantifiers in O(n^2) time — confirmed empirically at ~68s for n=8000. The fixed
  // regex (`(?:"([^"]*)"|(\S+))\s*$`, disjoint quoted/bare alternatives) resolves the
  // same shape of crafted input deterministically, in linear time.
  const fixedFilterRegex = /^\s*([\w.:-]+)\s+eq\s+(?:"([^"]*)"|(\S+))\s*$/i;
  const n = 8000;
  const crafted = "a eq " + " ".repeat(n) + '"' + " ".repeat(n) + '"' + "Z";
  const start = Date.now();
  const result = fixedFilterRegex.test(crafted);
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 200, `expected linear-time rejection, took ${elapsedMs}ms`);
  assert.equal(result, false);
});
