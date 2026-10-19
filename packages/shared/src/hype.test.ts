// Unit tests for the pure hype rules (SKILLY_SPEC.md §50): the early-hype bonus tiers, the five
// settings (defaults, ranges, coercion, PATCH validation), hard/soft eligibility, the board order,
// and the shared SQL fragments.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HYPE_TIERS,
  HYPE_WINDOW_MS,
  DEFAULT_HYPE_SETTINGS,
  HYPE_SETTING_KEYS,
  HYPE_SETTING_RANGES,
  HypeSettingError,
  coerceHypeSettings,
  compareHypeRows,
  hasHypeSettings,
  hypeBoardSql,
  hypeExpiresAt,
  hypeHardEligibleSql,
  hypePointsFor,
  hypeSettingsSummary,
  isHypeEligible,
  isHypeOpen,
  parseHypeSettingsPatch,
  HYPE_REFUSAL_COPY,
  effectiveMaintainerIdsSql,
  type HypeRankable,
} from "./hype.js";

test("hypePointsFor: 3 points for the first five, 2 for the next ten, then 1", () => {
  assert.equal(hypePointsFor(0), 3);
  assert.equal(hypePointsFor(4), 3);
  assert.equal(hypePointsFor(5), 2);
  assert.equal(hypePointsFor(14), 2);
  assert.equal(hypePointsFor(15), 1);
  assert.equal(hypePointsFor(1000), 1);
  // Defensive: garbage counts are treated as zero.
  assert.equal(hypePointsFor(-3), 3);
  assert.equal(hypePointsFor(Number.NaN), 3);
  assert.equal(HYPE_TIERS.length, 3);
});

test("defaults match §50.8", () => {
  assert.deepEqual(DEFAULT_HYPE_SETTINGS, { enabled: true, budget: 3, recencyDays: 90, installThreshold: 25, topN: 5 });
  assert.deepEqual(HYPE_SETTING_RANGES.budget, { min: 1, max: 10, label: "Hypes per week" });
  assert.equal(HYPE_SETTING_RANGES.recencyDays.min, 7);
  assert.equal(HYPE_SETTING_RANGES.recencyDays.max, 365);
  assert.equal(HYPE_SETTING_RANGES.installThreshold.max, 10_000);
  assert.equal(HYPE_SETTING_RANGES.topN.max, 20);
});

test("coerceHypeSettings: absent ⇒ defaults; malformed ⇒ the field's default; valid values kept", () => {
  assert.deepEqual(coerceHypeSettings(() => undefined), DEFAULT_HYPE_SETTINGS);
  const stored: Record<string, unknown> = {
    [HYPE_SETTING_KEYS.enabled]: false,
    [HYPE_SETTING_KEYS.budget]: 5,
    [HYPE_SETTING_KEYS.recencyDays]: 3, // below the minimum → default
    [HYPE_SETTING_KEYS.installThreshold]: "40", // a numeric string is accepted
    [HYPE_SETTING_KEYS.topN]: 2.5, // not whole → default
  };
  assert.deepEqual(coerceHypeSettings((k) => stored[k]), { enabled: false, budget: 5, recencyDays: 90, installThreshold: 40, topN: 5 });
  // Only an explicit false switches it off.
  assert.equal(coerceHypeSettings((k) => (k === HYPE_SETTING_KEYS.enabled ? "false" : undefined)).enabled, true);
});

test("parseHypeSettingsPatch: validates every present field, returns only those", () => {
  assert.deepEqual(parseHypeSettingsPatch({}), {});
  assert.deepEqual(parseHypeSettingsPatch({ hypeBudget: 1, hypeTopN: 20 }), { budget: 1, topN: 20 });
  assert.deepEqual(parseHypeSettingsPatch({ hypeEnabled: false }), { enabled: false });
  assert.deepEqual(parseHypeSettingsPatch({ hypeRecencyDays: 365, hypeInstallThreshold: 10_000 }), { recencyDays: 365, installThreshold: 10_000 });
  assert.throws(() => parseHypeSettingsPatch({ hypeBudget: 0 }), HypeSettingError);
  assert.throws(() => parseHypeSettingsPatch({ hypeBudget: 11 }), /between 1 and 10/);
  assert.throws(() => parseHypeSettingsPatch({ hypeRecencyDays: 6 }), HypeSettingError);
  assert.throws(() => parseHypeSettingsPatch({ hypeInstallThreshold: 10_001 }), HypeSettingError);
  assert.throws(() => parseHypeSettingsPatch({ hypeTopN: 0 }), HypeSettingError);
  assert.throws(() => parseHypeSettingsPatch({ hypeTopN: 1.5 }), HypeSettingError);
  assert.throws(() => parseHypeSettingsPatch({ hypeEnabled: "yes" }), /true or false/);
  assert.equal(hasHypeSettings({ hypeTopN: 3 }), true);
  assert.equal(hasHypeSettings({ maxFeaturedSkills: 3 }), false);
});

test("hypeSettingsSummary: the admin card header", () => {
  assert.equal(hypeSettingsSummary(DEFAULT_HYPE_SETTINGS), "on · 3 / week · ≤ 90 d · < 25 installs · top 5");
  assert.equal(hypeSettingsSummary({ ...DEFAULT_HYPE_SETTINGS, enabled: false }), "off");
});

test("isHypeEligible: only org-visible, active, not deprecated, installable", () => {
  const ok = { visibility: "org" as const, status: "active" as const, deprecatedAt: null, installable: true };
  assert.equal(isHypeEligible(ok), true);
  assert.equal(isHypeEligible({ ...ok, visibility: "namespace" }), false);
  assert.equal(isHypeEligible({ ...ok, status: "archived" }), false);
  assert.equal(isHypeEligible({ ...ok, deprecatedAt: "2026-10-01T00:00:00Z" }), false);
  assert.equal(isHypeEligible({ ...ok, installable: false }), false);
});

test("isHypeOpen: young AND small, both thresholds inclusive/exclusive as specified", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const s = { recencyDays: 90, installThreshold: 25 };
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
  assert.equal(isHypeOpen({ createdAt: daysAgo(10), installCount: 0 }, s, now), true);
  assert.equal(isHypeOpen({ createdAt: daysAgo(90), installCount: 24 }, s, now), true, "exactly 90 days and 24 installs is still open");
  assert.equal(isHypeOpen({ createdAt: daysAgo(90.01), installCount: 0 }, s, now), false, "older than the window");
  assert.equal(isHypeOpen({ createdAt: daysAgo(1), installCount: 25 }, s, now), false, "reached the install threshold");
  assert.equal(isHypeOpen({ createdAt: "not a date", installCount: 0 }, s, now), false);
});

test("hypeExpiresAt: exactly seven days after the hype", () => {
  const at = "2026-10-12T14:00:00.000Z";
  assert.equal(hypeExpiresAt(at).toISOString(), "2026-10-19T14:00:00.000Z");
  assert.equal(HYPE_WINDOW_MS, 7 * 86_400_000);
});

test("compareHypeRows: score, then count, then earliest hype, then namespace and slug", () => {
  const row = (o: Partial<HypeRankable>): HypeRankable => ({ score: 9, hypeCount: 3, firstHypeAt: "2026-10-15T00:00:00Z", namespaceSlug: "a", skillSlug: "x", ...o });
  const sorted = [
    row({ skillSlug: "low", score: 3 }),
    row({ skillSlug: "late", firstHypeAt: "2026-10-16T00:00:00Z" }),
    row({ skillSlug: "more", hypeCount: 4 }),
    row({ skillSlug: "b" }),
    row({ skillSlug: "a" }),
    row({ namespaceSlug: "a-b", skillSlug: "a" }),
    row({ skillSlug: "top", score: 12 }),
  ].sort(compareHypeRows);
  assert.deepEqual(sorted.map((r) => `${r.namespaceSlug}/${r.skillSlug}`), ["a/top", "a/more", "a/a", "a/b", "a-b/a", "a/late", "a/low"]);
});

test("shared SQL: the hard predicate and the board query carry the window and the order", () => {
  const hard = hypeHardEligibleSql("s");
  assert.match(hard, /s\.visibility = 'org'/);
  assert.match(hard, /s\.status = 'active'/);
  assert.match(hard, /s\.deprecated_at is null/);
  assert.match(hard, /hv\.git_published/);
  const board = hypeBoardSql(2);
  assert.match(board, /now\(\) - interval '7 days'/);
  assert.match(board, /limit \$2/);
  assert.match(board, /order by score desc, hype_count desc, first_hype_at asc, n\.slug collate "C" asc, s\.slug collate "C" asc/);
});

test("every refusal reason has copy", () => {
  for (const r of ["not_eligible", "self_hype", "already_hyped", "budget_exhausted"] as const) assert.ok(HYPE_REFUSAL_COPY[r].length > 0);
  assert.match(HYPE_REFUSAL_COPY.budget_exhausted, /\{date\}/);
});

test("effectiveMaintainerIdsSql: explicit maintainers union the namespace's admins", () => {
  const sql = effectiveMaintainerIdsSql("$1", "$2");
  assert.match(sql, /from skill_maintainers em_sm where em_sm\.skill_id = \$1/);
  assert.match(sql, /union/);
  assert.match(sql, /em_rm\.namespace_id = \$2 and em_rm\.role = 'namespace_admin'/);
});
