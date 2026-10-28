// Unit tests for the skill page's Quality card arrival rule (SKILLY_SPEC.md §41.7).
import test from "node:test";
import assert from "node:assert/strict";
import { initialQualityCardOpen } from "./qualityCard";

test("collapsed by default: nothing stored, no fragment", () => {
  assert.equal(initialQualityCardOpen(null, ""), false);
  assert.equal(initialQualityCardOpen(undefined, ""), false);
});

test("the stored preference reopens the card", () => {
  assert.equal(initialQualityCardOpen("1", ""), true);
});

test("junk in localStorage reads as collapsed, never as open", () => {
  for (const junk of ["0", "true", "open", " 1", ""]) {
    assert.equal(initialQualityCardOpen(junk, ""), false, `junk: ${JSON.stringify(junk)}`);
  }
});

test("a #quality deep link opens the card whatever is stored", () => {
  assert.equal(initialQualityCardOpen(null, "#quality"), true);
  assert.equal(initialQualityCardOpen("0", "#quality"), true);
});

test("other fragments leave the stored preference in charge", () => {
  assert.equal(initialQualityCardOpen(null, "#discussion"), false);
  assert.equal(initialQualityCardOpen(null, "#quality-x"), false);
  assert.equal(initialQualityCardOpen("1", "#discussion"), true);
});
