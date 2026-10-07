import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_CALL_TIMEOUT_MAX_MS,
  AI_CALL_TIMEOUT_MIN_MS,
  AI_DRAFT_RUN_CAP_DEFAULT_MS,
  AI_DRAFT_RUN_CAP_MAX_MS,
  AI_DRAFT_RUN_CAP_MIN_MS,
  aiFeatureDefaultTimeoutMs,
  aiTimeoutOverridesEmpty,
  aiTimeoutsView,
  effectiveAiCallTimeoutMs,
  effectiveAiDraftRunCapMs,
  parseAiTimeoutOverrides,
  validateAiTimeoutsInput,
  type AiTimeoutFeature,
} from "./ai-timeouts.js";

const FEATURES: AiTimeoutFeature[] = [
  { key: "skill_quality", label: "Skill quality assessment" },
  { key: "skill_quality_draft", label: "Draft quality improvements", timeoutMs: 360_000 },
];
const KEYS = FEATURES.map((f) => f.key);

test("aiFeatureDefaultTimeoutMs: declared value, 60 s fallback, 900 s ceiling", () => {
  assert.equal(aiFeatureDefaultTimeoutMs({}), 60_000);
  assert.equal(aiFeatureDefaultTimeoutMs({ timeoutMs: 360_000 }), 360_000);
  assert.equal(aiFeatureDefaultTimeoutMs({ timeoutMs: 5_000_000 }), AI_CALL_TIMEOUT_MAX_MS);
  assert.equal(aiFeatureDefaultTimeoutMs({ timeoutMs: 0 }), 60_000);
});

test("effective timeouts: override → registered default → 60 s; run cap override → 30 min", () => {
  const none = parseAiTimeoutOverrides(undefined, KEYS);
  assert.equal(effectiveAiCallTimeoutMs(FEATURES[0]!, none), 60_000);
  assert.equal(effectiveAiCallTimeoutMs(FEATURES[1]!, none), 360_000);
  assert.equal(effectiveAiDraftRunCapMs(none), AI_DRAFT_RUN_CAP_DEFAULT_MS);
  const set = parseAiTimeoutOverrides({ calls: { skill_quality: 120_000, skill_quality_draft: 600_000 }, draftRunCapMs: 45 * 60_000 }, KEYS);
  assert.equal(effectiveAiCallTimeoutMs(FEATURES[0]!, set), 120_000);
  assert.equal(effectiveAiCallTimeoutMs(FEATURES[1]!, set), 600_000);
  assert.equal(effectiveAiDraftRunCapMs(set), 45 * 60_000);
});

test("parseAiTimeoutOverrides: unknown keys ignored, junk ignored, out-of-range values clamped", () => {
  assert.deepEqual(parseAiTimeoutOverrides(null, KEYS), { calls: {} });
  assert.deepEqual(parseAiTimeoutOverrides("x", KEYS), { calls: {} });
  assert.deepEqual(
    parseAiTimeoutOverrides({ calls: { gone_feature: 30_000, skill_quality: "60", skill_quality_draft: 1 }, draftRunCapMs: 10 * 24 * 3600_000 }, KEYS),
    { calls: { skill_quality_draft: AI_CALL_TIMEOUT_MIN_MS }, draftRunCapMs: AI_DRAFT_RUN_CAP_MAX_MS },
  );
  assert.deepEqual(parseAiTimeoutOverrides({ calls: { skill_quality: 9e9 }, draftRunCapMs: 1 }, KEYS), {
    calls: { skill_quality: AI_CALL_TIMEOUT_MAX_MS },
    draftRunCapMs: AI_DRAFT_RUN_CAP_MIN_MS,
  });
});

test("aiTimeoutsView: default / override / effective per feature and for the run cap", () => {
  const v = aiTimeoutsView(FEATURES, parseAiTimeoutOverrides({ calls: { skill_quality: 90_000 } }, KEYS));
  assert.deepEqual(v.features, [
    { key: "skill_quality", label: "Skill quality assessment", defaultMs: 60_000, overrideMs: 90_000, effectiveMs: 90_000 },
    { key: "skill_quality_draft", label: "Draft quality improvements", defaultMs: 360_000, overrideMs: null, effectiveMs: 360_000 },
  ]);
  assert.deepEqual(v.draftRunCap, { defaultMs: AI_DRAFT_RUN_CAP_DEFAULT_MS, overrideMs: null, effectiveMs: AI_DRAFT_RUN_CAP_DEFAULT_MS });
});

test("validateAiTimeoutsInput: accepts a full set, nulls mean default", () => {
  const r = validateAiTimeoutsInput({ calls: { skill_quality: 120_000, skill_quality_draft: null }, draftRunCapMs: 60 * 60_000 }, FEATURES);
  assert.deepEqual(r, { ok: true, value: { calls: { skill_quality: 120_000 }, draftRunCapMs: 60 * 60_000 } });
  const empty = validateAiTimeoutsInput({}, FEATURES);
  assert.ok(empty.ok && aiTimeoutOverridesEmpty(empty.value));
  assert.ok(validateAiTimeoutsInput({ calls: null, draftRunCapMs: null }, FEATURES).ok);
});

test("validateAiTimeoutsInput: bounds, whole units, unknown feature, shape", () => {
  const field = (raw: unknown) => {
    const r = validateAiTimeoutsInput(raw, FEATURES);
    return r.ok ? null : r.field;
  };
  assert.equal(field(null), "body");
  assert.equal(field({ calls: [] }), "calls");
  assert.equal(field({ calls: { nope: 60_000 } }), "calls.nope");
  assert.equal(field({ calls: { skill_quality: 9_000 } }), "calls.skill_quality");
  assert.equal(field({ calls: { skill_quality: 901_000 } }), "calls.skill_quality");
  assert.equal(field({ calls: { skill_quality: 60_500 } }), "calls.skill_quality");
  assert.equal(field({ calls: { skill_quality: "60000" } }), "calls.skill_quality");
  assert.equal(field({ calls: { skill_quality: 10_000 } }), null);
  assert.equal(field({ calls: { skill_quality: 900_000 } }), null);
  assert.equal(field({ draftRunCapMs: 4 * 60_000 }), "draftRunCapMs");
  assert.equal(field({ draftRunCapMs: 121 * 60_000 }), "draftRunCapMs");
  assert.equal(field({ draftRunCapMs: 30 * 60_000 + 1000 }), "draftRunCapMs");
  assert.equal(field({ draftRunCapMs: 120 * 60_000 }), null);
});

test("validateAiTimeoutsInput: the run cap may not be shorter than the effective draft call timeout", () => {
  // 5 min < the 360 s default draft timeout.
  const r = validateAiTimeoutsInput({ draftRunCapMs: 5 * 60_000 }, FEATURES);
  assert.ok(!r.ok && r.field === "draftRunCapMs" && /360 s/.test(r.error));
  assert.ok(validateAiTimeoutsInput({ draftRunCapMs: 5 * 60_000, calls: { skill_quality_draft: 300_000 } }, FEATURES).ok);
  // A 15-minute draft timeout against the default 30-minute cap is fine; against a 10-minute cap it isn't.
  assert.ok(validateAiTimeoutsInput({ calls: { skill_quality_draft: 900_000 } }, FEATURES).ok);
  assert.ok(!validateAiTimeoutsInput({ calls: { skill_quality_draft: 900_000 }, draftRunCapMs: 10 * 60_000 }, FEATURES).ok);
});
