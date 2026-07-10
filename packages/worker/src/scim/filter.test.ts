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
