// Unit test for the holders line on a skill's expanded usage row (SKILLY_SPEC.md §21 "Plugin
// deliveries are not adoption").
import { test } from "node:test";
import assert from "node:assert/strict";
import { holdersLine } from "./holders";

test("holdersLine: total holders, then how many hold it by plugin only", () => {
  assert.equal(holdersLine({ total: 45, pluginOnly: 40 }), "Held by 45 people · 40 by plugin only");
  assert.equal(holdersLine({ total: 3, pluginOnly: 0 }), "Held by 3 people", "no plugin-only part when none");
  assert.equal(holdersLine({ total: 1, pluginOnly: 1 }), "Held by 1 person · 1 by plugin only");
});
