// Unit tests for the §66 department-row core (SKILLY_SPEC.md §66.9).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEPARTMENT_POPULAR_CACHE_MS,
  DEPARTMENT_POPULAR_LIMIT,
  DEPARTMENT_POPULAR_MIN_COLLEAGUES,
  DEPARTMENT_POPULAR_WINDOW_DAYS,
  colleaguesLabel,
  colleaguesTitle,
  departmentKey,
  departmentLabel,
} from "./department-popular.js";

test("the fixed rules (§66.1 #4, #7, #12, §66.4)", () => {
  assert.equal(DEPARTMENT_POPULAR_WINDOW_DAYS, 90);
  assert.equal(DEPARTMENT_POPULAR_MIN_COLLEAGUES, 2);
  assert.equal(DEPARTMENT_POPULAR_LIMIT, 6);
  assert.equal(DEPARTMENT_POPULAR_CACHE_MS, 600_000);
});

test("departmentKey trims and lower-cases, keeps inner spaces, and treats blank as none", () => {
  assert.equal(departmentKey("Engineering"), "engineering");
  assert.equal(departmentKey("  engineering "), "engineering");
  assert.equal(departmentKey("ENGINEERING"), "engineering");
  assert.equal(departmentKey("Engineering\t"), "engineering\t", "only spaces are trimmed, like SQL btrim()");
  assert.equal(departmentKey("Engineering  Ops"), "engineering  ops", "inner spaces are kept as they are");
  assert.notEqual(departmentKey("Engineering Ops"), departmentKey("Engineering"));
  assert.equal(departmentKey(""), null);
  assert.equal(departmentKey("   "), null);
  assert.equal(departmentKey(null), null);
  assert.equal(departmentKey(undefined), null);
});

test("trimming is linear on long runs of spaces (no regex backtracking)", () => {
  const spaces = " ".repeat(200_000);
  const started = Date.now();
  assert.equal(departmentKey(`${spaces}Eng${spaces}`), "eng");
  assert.equal(departmentKey(`${spaces}x y${spaces}z`), `x y${spaces}z`, "inner runs are kept");
  assert.equal(departmentLabel(spaces), null);
  assert.ok(Date.now() - started < 1_000, "a 400k-character value trims in well under a second");
});

test("departmentLabel trims but keeps the capitals", () => {
  assert.equal(departmentLabel("  Research & Development "), "Research & Development");
  assert.equal(departmentLabel(" "), null);
  assert.equal(departmentLabel(null), null);
});

test("the chip copy", () => {
  assert.equal(colleaguesLabel(2), "2 colleagues");
  assert.equal(colleaguesLabel(12), "12 colleagues");
  assert.equal(colleaguesTitle(3), "3 people in your department adopted this in the last 90 days");
});
