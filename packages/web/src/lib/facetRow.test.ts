// Unit tests for the collapsible facet row's mount-time rules (SKILLY_SPEC.md §10/§26). The point
// of these is the DIVERGENCE: an auto-expanded row must not leave a trace in the stored preference.
import test from "node:test";
import assert from "node:assert/strict";
import { initialFacetRowOpen, storedFacetRowOpen } from "./facetRow";

test("collapsed by default: nothing stored, no active filter", () => {
  assert.equal(initialFacetRowOpen(undefined, null), false);
  assert.equal(storedFacetRowOpen(undefined), false);
});

test("a stored preference of open reopens the row", () => {
  assert.equal(initialFacetRowOpen(true, null), true);
  assert.equal(storedFacetRowOpen(true), true);
});

test("an active filter force-opens the row even with nothing stored", () => {
  assert.equal(initialFacetRowOpen(undefined, "devops"), true);
});

test("auto-expand leaves the stored preference collapsed", () => {
  // The row opens...
  assert.equal(initialFacetRowOpen(false, "devops"), true);
  // ...but what we persist is still the user's own (collapsed) choice.
  assert.equal(storedFacetRowOpen(false), false);
});

test("junk in localStorage reads as collapsed, never as open", () => {
  for (const junk of ["1", "true", 1, 0, null, {}, []]) {
    assert.equal(storedFacetRowOpen(junk), false, `junk: ${JSON.stringify(junk)}`);
    assert.equal(initialFacetRowOpen(junk, null), false, `junk: ${JSON.stringify(junk)}`);
  }
});

test("an empty-string filter value is not an active filter", () => {
  assert.equal(initialFacetRowOpen(undefined, ""), false);
});
