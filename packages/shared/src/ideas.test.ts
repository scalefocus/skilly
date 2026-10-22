// Unit tests for the feature-ideas rules (SKILLY_SPEC.md §60): validators, who may suggest, the
// submission caps, the close outcomes, the Coming soon order and the notification wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IDEA_DAILY_MAX,
  IDEA_DAILY_WINDOW_MS,
  IDEA_DESCRIPTION_MAX,
  IDEA_NOTIFICATION_TYPES,
  IDEA_PENDING_MAX,
  IDEA_TITLE_MAX,
  comingSoonOrder,
  dailyRetryAfterSeconds,
  ideaExcerpt,
  ideaLimitRefusal,
  ideaTextLength,
  ideaNotificationContent,
  isIdeaCloseOutcome,
  isIdeaNotificationType,
  isIdeaOutcome,
  maySuggestIdea,
  validateIdeaDescription,
  validateIdeaNote,
  validateIdeaTitle,
  type ComingSoonItem,
} from "./ideas.js";
import { NOTIFICATION_LABELS } from "./notifications.js";

test("description: trimmed, line endings folded, 20–1,000 characters", () => {
  assert.deepEqual(validateIdeaDescription("  Let me export my installed skills as CSV.\r\nPlease.  "), {
    ok: true,
    value: "Let me export my installed skills as CSV.\nPlease.",
  });
  assert.equal(validateIdeaDescription("too short").ok, false);
  assert.equal(validateIdeaDescription(`   ${"x".repeat(19)}   `).ok, false, "whitespace does not count toward the minimum");
  assert.equal(validateIdeaDescription("x".repeat(20)).ok, true);
  assert.equal(validateIdeaDescription("x".repeat(IDEA_DESCRIPTION_MAX)).ok, true);
  assert.equal(validateIdeaDescription("x".repeat(IDEA_DESCRIPTION_MAX + 1)).ok, false);
  assert.equal(validateIdeaDescription(undefined).ok, false);
  assert.equal(validateIdeaDescription(42).ok, false);
});

test("lengths count characters (code points), as the database does — not UTF-16 units", () => {
  // Ten emoji are 20 UTF-16 units but 10 characters: below the 20-character minimum.
  assert.equal(ideaTextLength("😀".repeat(10)), 10);
  assert.equal(validateIdeaDescription("😀".repeat(10)).ok, false);
  assert.equal(validateIdeaDescription("😀".repeat(20)).ok, true);
  assert.equal(validateIdeaDescription("😀".repeat(IDEA_DESCRIPTION_MAX)).ok, true, "1,000 emoji fit, though they are 2,000 units");
  assert.equal(validateIdeaTitle("😀😀").ok, false, "two emoji are 2 characters, below the 3 minimum");
  assert.equal(validateIdeaNote("😀".repeat(500)).ok, true);
  const cut = ideaExcerpt("😀".repeat(30), 10);
  assert.equal(Array.from(cut).length, 10);
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut.slice(0, -1)), "never splits a surrogate pair");
});

test("title: one line, 3–80 characters", () => {
  assert.deepEqual(validateIdeaTitle("  CSV\n export  "), { ok: true, value: "CSV export" });
  assert.equal(validateIdeaTitle("ab").ok, false);
  assert.equal(validateIdeaTitle("x".repeat(IDEA_TITLE_MAX)).ok, true);
  assert.equal(validateIdeaTitle("x".repeat(IDEA_TITLE_MAX + 1)).ok, false);
  assert.equal(validateIdeaTitle(null).ok, false);
});

test("note: optional, blank → null, ≤ 500 characters", () => {
  assert.deepEqual(validateIdeaNote(undefined), { ok: true, value: null });
  assert.deepEqual(validateIdeaNote("   "), { ok: true, value: null });
  assert.deepEqual(validateIdeaNote(" Already on the roadmap. "), { ok: true, value: "Already on the roadmap." });
  assert.equal(validateIdeaNote("x".repeat(501)).ok, false);
  assert.equal(validateIdeaNote(7).ok, false);
});

test("outcomes: every stored one is known, but a new close never takes Planned (§60.1 decision 3)", () => {
  for (const o of ["planned", "shipped", "duplicate", "wont_do"]) assert.equal(isIdeaOutcome(o), true, o);
  assert.equal(isIdeaOutcome("done"), false);
  for (const o of ["shipped", "duplicate", "wont_do"]) assert.equal(isIdeaCloseOutcome(o), true, o);
  for (const bad of ["planned", "done", "", null, 3]) assert.equal(isIdeaCloseOutcome(bad), false, String(bad));
});

test("who may suggest: platform admins always, everyone else while the switch is on", () => {
  assert.equal(maySuggestIdea({ isPlatformAdmin: false }, true), true);
  assert.equal(maySuggestIdea({ isPlatformAdmin: false }, false), false);
  assert.equal(maySuggestIdea({ isPlatformAdmin: true }, true), true);
  assert.equal(maySuggestIdea({ isPlatformAdmin: true }, false), true);
});

test("caps: the pending cap first, then the daily cap", () => {
  assert.equal(ideaLimitRefusal({ pending: 0, today: 0 }), null);
  assert.equal(ideaLimitRefusal({ pending: IDEA_PENDING_MAX - 1, today: IDEA_DAILY_MAX - 1 }), null);
  assert.equal(ideaLimitRefusal({ pending: IDEA_PENDING_MAX, today: 0 }), "pending_limit");
  assert.equal(ideaLimitRefusal({ pending: 0, today: IDEA_DAILY_MAX }), "daily_limit");
  assert.equal(ideaLimitRefusal({ pending: IDEA_PENDING_MAX, today: IDEA_DAILY_MAX }), "pending_limit");
});

test("caps: Retry-After counts down to when the oldest row leaves the 24 h window", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  assert.equal(dailyRetryAfterSeconds(new Date(now.getTime() - IDEA_DAILY_WINDOW_MS + 90_000), now), 90);
  assert.equal(dailyRetryAfterSeconds(new Date(now.getTime() - IDEA_DAILY_WINDOW_MS - 5_000), now), 1, "never below 1");
});

const item = (id: string, votes: number, publishedAt: string): ComingSoonItem => ({
  id, title: id, description: "d", votes, voted: false, suggestedBy: null, publishedAt,
});

test("order: most votes first", () => {
  const out = comingSoonOrder([item("a", 1, "2026-10-03T00:00:00Z"), item("b", 4, "2026-10-01T00:00:00Z"), item("x", 3, "2026-10-01T00:00:00Z"), item("y", 0, "2026-10-02T00:00:00Z")]);
  assert.deepEqual(out.map((i) => i.id), ["b", "x", "a", "y"]);
});

test("order: ties → newest published first, then id", () => {
  const out = comingSoonOrder([
    item("old", 2, "2026-10-01T00:00:00Z"),
    item("new", 2, "2026-10-05T00:00:00Z"),
    item("b-same", 2, "2026-10-03T00:00:00Z"),
    item("a-same", 2, "2026-10-03T00:00:00Z"),
  ]);
  assert.deepEqual(out.map((i) => i.id), ["new", "a-same", "b-same", "old"]);
  assert.deepEqual(comingSoonOrder([]), []);
});

test("notifications: every idea type has a label and wording; others get null", () => {
  for (const t of IDEA_NOTIFICATION_TYPES) {
    assert.ok(NOTIFICATION_LABELS[t], `${t} has a label`);
    assert.equal(isIdeaNotificationType(t), true);
    const c = ideaNotificationContent(t, { title: "CSV export", count: 2, reason: "Out of scope.", excerpt: "Let me export…", outcome: "planned", adminNote: "Next quarter." });
    assert.ok(c && c.sentence && c.path.startsWith("/"), t);
    assert.ok(!c!.sentence.includes("undefined") && !c!.sentence.includes("null"), t);
  }
  assert.equal(isIdeaNotificationType("skill.hyped"), false);
  assert.equal(ideaNotificationContent("skill.hyped", {}), null);
});

test("notifications: the §60.7 wording", () => {
  assert.equal(ideaNotificationContent("idea.submitted", { count: 1 })!.sentence, "A new feature idea is waiting for review.");
  assert.deepEqual(ideaNotificationContent("idea.submitted", { count: 3 }), {
    sentence: "3 new feature ideas are waiting for review.", detail: null, ctaLabel: "Review ideas", path: "/admin/ideas",
  });
  assert.equal(ideaNotificationContent("idea.published", { title: "CSV export" })!.path, "/whats-new#coming-soon");
  assert.deepEqual(ideaNotificationContent("idea.rejected", { excerpt: "Let me export" }), {
    sentence: "Your feature idea wasn't published. No reason was given.", detail: "\"Let me export\"", ctaLabel: "Your ideas", path: "/whats-new#your-ideas",
  });
  assert.equal(ideaNotificationContent("idea.rejected", { reason: "Already possible." })!.sentence, "Your feature idea wasn't published. Reason: Already possible.");
  assert.deepEqual(ideaNotificationContent("idea.closed", { title: "CSV export", outcome: "wont_do", adminNote: "Use the API." }), {
    sentence: "Your feature idea \"CSV export\" was closed: Won't do.", detail: "Use the API.", ctaLabel: "Your ideas", path: "/whats-new#your-ideas",
  });
  assert.equal(ideaNotificationContent("idea.shipped", { title: "CSV export" })!.sentence, "A feature you suggested has shipped: \"CSV export\" is now part of skilly.");
});

test("excerpt: one line, cut with an ellipsis", () => {
  assert.equal(ideaExcerpt("a\n\nb   c"), "a b c");
  const long = ideaExcerpt("word ".repeat(60), 20);
  assert.ok(long.length <= 20 && long.endsWith("…"), long);
});
