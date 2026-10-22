import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_GROUPS,
  ACHIEVEMENT_KEYS,
  ACHIEVEMENT_TOTAL,
  levelAriaLabel,
  levelFraction,
  levelLabel,
  achievementDef,
  isAchievementKey,
  tripleThreatDue,
  validateTimeZone,
  localParts,
  isNightShift,
  isWeekend,
  habitKeysFor,
  AI_NAME_TOKEN,
  UNAVAILABLE_HINT,
  achievementCopy,
  achievementNamesAi,
  unavailableAchievements,
  submissionChoosesIcon,
  isForwardUpdate,
  type AchievementFlags,
} from "./achievements.js";

test("catalog: 33 badges, unique keys, every field populated, known groups", () => {
  assert.equal(ACHIEVEMENTS.length, 33);
  assert.equal(new Set(ACHIEVEMENTS.map((a) => a.glyph)).size, ACHIEVEMENTS.length, "glyphs are unique");
  assert.equal(new Set(ACHIEVEMENT_KEYS).size, ACHIEVEMENTS.length);
  for (const a of ACHIEVEMENTS) {
    assert.match(a.key, /^[a-z][a-z0-9_]*$/, a.key); // `…_10` count-tier keys allowed (§31.1, §35.8)
    for (const f of ["name", "blurb", "howToEarn", "glyph"] as const) assert.ok(a[f].trim().length > 0, `${a.key}.${f}`);
    assert.ok(ACHIEVEMENT_GROUPS.includes(a.group), `${a.key}.group`);
  }
});

test("catalog: lookup helpers", () => {
  assert.equal(achievementDef("first_install")?.name, "Hello, Skill");
  assert.equal(achievementDef("nope"), undefined);
  assert.equal(isAchievementKey("night_shift"), true);
  assert.equal(isAchievementKey("installs_10"), false);
  assert.equal(isAchievementKey(42), false);
});

test("catalog: Encore sits in Contribute directly after Sequel (§31.11)", () => {
  const def = achievementDef("first_version_proposal");
  assert.equal(def?.name, "Encore");
  assert.equal(def?.group, "Contribute");
  assert.equal(ACHIEVEMENT_KEYS.indexOf("first_version_proposal"), ACHIEVEMENT_KEYS.indexOf("first_new_version") + 1);
});

test("catalog: the five §31.12 badges, in their groups and positions", () => {
  const after = (key: string, prev: string) => assert.equal(ACHIEVEMENT_KEYS.indexOf(key), ACHIEVEMENT_KEYS.indexOf(prev) + 1, `${key} follows ${prev}`);
  const expect: [string, string, string, string][] = [
    ["first_update", "Fresh Coat", "Consume", "🖌️"],
    ["first_icon", "Glow Up", "Contribute", "✨"],
    ["first_ai_draft", "Robot Sidekick", "Contribute", "🤖"],
    ["first_share", "Word of Mouth", "Talk", "🔗"],
    ["first_hype", "Hype Squad", "Explore", "🙌"],
  ];
  for (const [key, name, group, glyph] of expect) {
    const def = achievementDef(key);
    assert.equal(def?.name, name);
    assert.equal(def?.group, group);
    assert.equal(def?.glyph, glyph);
  }
  after("first_update", "first_install");
  after("first_icon", "first_pointer_proposal");
  after("first_ai_draft", "first_version_proposal");
  after("first_share", "first_mention");
  after("talent_scout", "first_hype");
});

test("catalog: the two §60.8 feature-idea badges sit in Ask after Wish Granted", () => {
  const after = (key: string, prev: string) => assert.equal(ACHIEVEMENT_KEYS.indexOf(key), ACHIEVEMENT_KEYS.indexOf(prev) + 1, `${key} follows ${prev}`);
  assert.deepEqual([achievementDef("idea_published")?.name, achievementDef("idea_published")?.group, achievementDef("idea_published")?.glyph], ["Bright Idea", "Ask", "💡"]);
  assert.deepEqual([achievementDef("idea_shipped")?.name, achievementDef("idea_shipped")?.group, achievementDef("idea_shipped")?.glyph], ["Made It Real", "Ask", "🛠️"]);
  after("idea_published", "request_fulfilled");
  after("idea_shipped", "idea_published");
});

test("AI display name: {name} only in Robot Sidekick's blurb/hint, never in a name (§31.12.5)", () => {
  for (const a of ACHIEVEMENTS) {
    assert.ok(!a.name.includes(AI_NAME_TOKEN), `${a.key}.name`);
    assert.equal(achievementNamesAi(a), a.key === "first_ai_draft", a.key);
  }
  const robot = achievementDef("first_ai_draft")!;
  assert.deepEqual(achievementCopy(robot, "Aria"), {
    blurb: "You let Aria write the first draft.",
    howToEarn: "Use Draft with Aria on the propose form, or Draft improvements with Aria on a skill you maintain.",
  });
  // Any other entry passes through untouched.
  const hello = achievementDef("first_install")!;
  assert.deepEqual(achievementCopy(hello, "Aria"), { blurb: hello.blurb, howToEarn: hello.howToEarn });
});

test("unavailableAchievements: locked switch-gated keys only, in catalog order (§31.12.4)", () => {
  const on: AchievementFlags = { hypeEnabled: true, aiAvailable: true, mcpEnabled: true, marketplaceReachable: true, featureIdeasEnabled: true };
  assert.deepEqual(unavailableAchievements([], on), []);
  assert.deepEqual(unavailableAchievements([], { ...on, hypeEnabled: false }), ["hype_train", "first_hype", "talent_scout"]);
  assert.deepEqual(unavailableAchievements([], { ...on, aiAvailable: false }), ["first_ai_draft"]);
  assert.deepEqual(unavailableAchievements([], { ...on, featureIdeasEnabled: false }), ["idea_published", "idea_shipped"]);
  // A missing MCP or marketplace door also closes Three Doors Down…
  assert.deepEqual(unavailableAchievements([], { ...on, mcpEnabled: false }), ["first_mcp", "triple_threat"]);
  assert.deepEqual(unavailableAchievements([], { ...on, marketplaceReachable: false }), ["first_marketplace", "triple_threat"]);
  // …unless that door is already held.
  assert.deepEqual(unavailableAchievements(["first_mcp"], { ...on, mcpEnabled: false }), []);
  // Earned keys are never listed, whatever the switches say.
  const off: AchievementFlags = { hypeEnabled: false, aiAvailable: false, mcpEnabled: false, marketplaceReachable: false, featureIdeasEnabled: false };
  assert.deepEqual(unavailableAchievements(["first_hype", "first_ai_draft", "triple_threat", "first_mcp", "first_marketplace", "hype_train", "talent_scout", "idea_published", "idea_shipped"], off), []);
  assert.equal(unavailableAchievements([], off).length, 9);
  assert.ok(UNAVAILABLE_HINT.startsWith("Not available here yet"));
});

test("submissionChoosesIcon: a chosen image or emoji that differs from the current icon (§31.12.3)", () => {
  // New skill: any icon counts.
  assert.equal(submissionChoosesIcon({ iconSha256: "a".repeat(64) }, null), true);
  assert.equal(submissionChoosesIcon({ iconEmoji: "🦊" }, null), true);
  assert.equal(submissionChoosesIcon({}, null), false);
  assert.equal(submissionChoosesIcon({ iconSha256: null, iconEmoji: null }, null), false);
  assert.equal(submissionChoosesIcon({ iconEmoji: "  " }, null), false);
  // New version: keeping (undefined) or echoing the current icon does not; a change does.
  const cur = { iconSha256: "b".repeat(64), iconEmoji: "🦊" };
  assert.equal(submissionChoosesIcon({}, cur), false);
  assert.equal(submissionChoosesIcon({ iconSha256: "b".repeat(64), iconEmoji: "🦊" }, cur), false);
  assert.equal(submissionChoosesIcon({ iconSha256: null, iconEmoji: null }, cur), false); // remove
  assert.equal(submissionChoosesIcon({ iconSha256: "c".repeat(64) }, cur), true);
  assert.equal(submissionChoosesIcon({ iconEmoji: "🐙" }, cur), true);
});

test("isForwardUpdate: a recorded install moving to a higher stable version (§31.12.3)", () => {
  assert.equal(isForwardUpdate(null, "1.2.0"), false); // first clone / unknown install
  assert.equal(isForwardUpdate("1.2.0", null), false); // empty repo
  assert.equal(isForwardUpdate("1.2.0", "1.2.0"), false);
  assert.equal(isForwardUpdate("1.2.0", "1.1.0"), false);
  assert.equal(isForwardUpdate("1.2.0", "1.3.0-beta.1"), false); // prerelease
  assert.equal(isForwardUpdate("1.2.0", "1.10.0"), true); // semver order, not string order
  assert.equal(isForwardUpdate("1.3.0-beta.1", "1.3.0"), true);
  assert.equal(isForwardUpdate("junk", "1.3.0"), false);
});

test("triple_threat: due only when all three channel badges are held", () => {
  assert.equal(tripleThreatDue([]), false);
  assert.equal(tripleThreatDue(["first_install", "first_mcp"]), false);
  assert.equal(tripleThreatDue(["first_install", "first_marketplace", "first_mcp"]), true);
  assert.equal(tripleThreatDue(["first_mcp", "first_rating", "first_marketplace", "first_install"]), true);
});

test("validateTimeZone: accepts real IANA zones, canonicalises, rejects junk", () => {
  assert.equal(validateTimeZone("Europe/Sofia"), "Europe/Sofia");
  assert.equal(validateTimeZone("  UTC "), "UTC");
  assert.equal(validateTimeZone("america/new_york"), "America/New_York");
  assert.equal(validateTimeZone("Mars/Olympus_Mons"), null);
  assert.equal(validateTimeZone(""), null);
  assert.equal(validateTimeZone("x".repeat(65)), null);
  assert.equal(validateTimeZone(123), null);
  assert.equal(validateTimeZone(null), null);
});

test("localParts: converts with DST awareness", () => {
  // 2026-07-01T00:30Z = 03:30 in Sofia (EEST, UTC+3), Wednesday.
  const summer = new Date("2026-07-01T00:30:00Z");
  assert.deepEqual(localParts(summer, "Europe/Sofia"), { hour: 3, weekday: 3 });
  // 2026-01-14T00:30Z = 02:30 in Sofia (EET, UTC+2), Wednesday.
  const winter = new Date("2026-01-14T00:30:00Z");
  assert.deepEqual(localParts(winter, "Europe/Sofia"), { hour: 2, weekday: 3 });
  // Same instant is Tuesday 19:30 in New York (EST).
  assert.deepEqual(localParts(winter, "America/New_York"), { hour: 19, weekday: 2 });
  assert.equal(localParts(winter, "Not/AZone"), null);
});

test("isNightShift: 00:00–04:59 local, inclusive of midnight, exclusive of 05:00", () => {
  // 21:00Z on a Tuesday = 00:00 Sofia (+3) in summer.
  assert.equal(isNightShift(new Date("2026-06-30T21:00:00Z"), "Europe/Sofia"), true);
  assert.equal(isNightShift(new Date("2026-07-01T01:59:59Z"), "Europe/Sofia"), true); // 04:59:59
  assert.equal(isNightShift(new Date("2026-07-01T02:00:00Z"), "Europe/Sofia"), false); // 05:00:00
  assert.equal(isNightShift(new Date("2026-06-30T20:59:59Z"), "Europe/Sofia"), false); // 23:59:59
  // The same instant is daytime in Los Angeles.
  assert.equal(isNightShift(new Date("2026-07-01T01:00:00Z"), "America/Los_Angeles"), false);
  assert.equal(isNightShift(new Date("2026-07-01T01:00:00Z"), null), false);
  assert.equal(isNightShift(new Date("2026-07-01T01:00:00Z"), undefined), false);
  assert.equal(isNightShift(new Date("2026-07-01T01:00:00Z"), "Bogus/Zone"), false);
});

test("isWeekend: Saturday/Sunday in the user's zone, not UTC", () => {
  // 2026-09-12 is a Saturday. 22:00Z Friday 11th = 01:00 Saturday in Sofia.
  assert.equal(isWeekend(new Date("2026-09-11T22:00:00Z"), "Europe/Sofia"), true);
  assert.equal(isWeekend(new Date("2026-09-11T22:00:00Z"), "UTC"), false);
  // 2026-09-14 (Monday) 01:00Z = Sunday 18:00 in Los Angeles.
  assert.equal(isWeekend(new Date("2026-09-14T01:00:00Z"), "America/Los_Angeles"), true);
  assert.equal(isWeekend(new Date("2026-09-14T01:00:00Z"), "Europe/Sofia"), false);
  assert.equal(isWeekend(new Date("2026-09-12T12:00:00Z"), null), false);
});

test("habitKeysFor: both, one, or none", () => {
  // Saturday 03:00 Sofia = Saturday 00:00Z.
  assert.deepEqual(habitKeysFor(new Date("2026-09-12T00:00:00Z"), "Europe/Sofia"), ["night_shift", "weekend_warrior"]);
  // Wednesday 03:00 Sofia.
  assert.deepEqual(habitKeysFor(new Date("2026-09-16T00:00:00Z"), "Europe/Sofia"), ["night_shift"]);
  // Saturday noon Sofia.
  assert.deepEqual(habitKeysFor(new Date("2026-09-12T09:00:00Z"), "Europe/Sofia"), ["weekend_warrior"]);
  // Wednesday noon.
  assert.deepEqual(habitKeysFor(new Date("2026-09-16T09:00:00Z"), "Europe/Sofia"), []);
  assert.deepEqual(habitKeysFor(new Date("2026-09-12T00:00:00Z"), null), []);
});

// --------------------------------------------------------------------------------------------
// Level (§31.10)
// --------------------------------------------------------------------------------------------

test("ACHIEVEMENT_TOTAL is the catalog size — the level's denominator", () => {
  assert.equal(ACHIEVEMENT_TOTAL, ACHIEVEMENTS.length);
  assert.equal(ACHIEVEMENT_TOTAL, 33);
});

test("levelLabel / levelAriaLabel: the level is the count, Hero is the stamp", () => {
  assert.equal(levelLabel(0, false), "Level 0 — 0 of 33");
  assert.equal(levelLabel(7, false), "Level 7 — 7 of 33");
  assert.equal(levelLabel(33, true), "Hero — 33 of 33");
  assert.equal(levelAriaLabel(7, false), "Level 7 of 33");
  assert.equal(levelAriaLabel(33, true), "Hero — 33 of 33");
});

test("a grown catalog never demotes a Hero (§31.10 'never demote')", () => {
  // The catalog gained five badges since this person completed it. They hold 20 of 25 — and the
  // stored stamp, not the arithmetic, is what says Hero. The ring stays full, the label stays Hero.
  assert.equal(levelLabel(20, true, 25), "Hero — 20 of 25");
  assert.equal(levelFraction(20, true, 25), 1);
  // Without the stamp the same tally is just a high level, correctly short of the new total.
  assert.equal(levelLabel(20, false, 25), "Level 20 — 20 of 25");
  assert.equal(levelFraction(20, false, 25), 0.8);
});

test("levelFraction: clamped, and safe on a degenerate total", () => {
  assert.equal(levelFraction(0, false), 0);
  assert.equal(levelFraction(10, false, 20), 0.5);
  assert.equal(levelFraction(20, false, 20), 1);
  assert.equal(levelFraction(99, false, 20), 1); // clamped, never > 1
  assert.equal(levelFraction(-3, false, 20), 0); // clamped, never < 0
  assert.equal(levelFraction(5, false, 0), 0); // no divide-by-zero
});
