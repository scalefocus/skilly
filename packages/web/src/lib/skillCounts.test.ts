// The Overview tiles' summing rule (SKILLY_SPEC.md §10). The visibility-filtered counts themselves
// are covered against a real database in catalog.dbtest.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { skillCountsFromTypes } from "./skillCounts";

test("skillCountsFromTypes: the total is hosted + pointer, well past the listing's 60-row cap", () => {
  assert.deepEqual(
    skillCountsFromTypes([{ name: "pointer", count: 142 }, { name: "hosted", count: 37 }]),
    { total: 179, hosted: 37, pointer: 142 },
  );
});

test("skillCountsFromTypes: a type the viewer sees none of has no facet row and counts 0", () => {
  assert.deepEqual(skillCountsFromTypes([{ name: "hosted", count: 4 }]), { total: 4, hosted: 4, pointer: 0 });
  assert.deepEqual(skillCountsFromTypes([{ name: "pointer", count: 9 }]), { total: 9, hosted: 0, pointer: 9 });
  assert.deepEqual(skillCountsFromTypes([]), { total: 0, hosted: 0, pointer: 0 });
});

test("skillCountsFromTypes: an unknown type never inflates the total", () => {
  assert.deepEqual(
    skillCountsFromTypes([{ name: "hosted", count: 2 }, { name: "mystery", count: 50 }]),
    { total: 2, hosted: 2, pointer: 0 },
  );
});
