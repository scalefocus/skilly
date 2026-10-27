// Unit tests for the feature-ideas rules (SKILLY_SPEC.md §60): validators, who may suggest, the
// submission caps, the close outcomes, the Coming soon order and the notification wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMING_SOON_POLL_MS,
  IDEA_DAILY_MAX,
  IDEA_DAILY_WINDOW_MS,
  IDEA_DESCRIPTION_MAX,
  IDEA_NOTIFICATION_TYPES,
  IDEA_PENDING_MAX,
  IDEA_TITLE_MAX,
  VOTER_LIST_MAX,
  VOTER_STRIP_MAX,
  VOTE_MOVE_GUARD_MS,
  applyOwnVote,
  comingSoonOrder,
  ownVoteAnnouncement,
  pollAnswerApplies,
  upvotedByLabel,
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
  type ComingSoonVoter,
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
  id, title: id, description: "d", votes, voted: false, suggestedBy: null, publishedAt, voters: [], votersTotal: 0,
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

// ── The live list (§60.3 decisions 18 and 19) ──────────────────────────────────────────────────

const ME = { id: "me", displayName: "Me Myself", avatar: null };
const voter = (id: string): ComingSoonVoter => ({ id, displayName: id.toUpperCase(), avatar: null });

test("live: an optimistic vote re-sorts the list at once", () => {
  const list = comingSoonOrder([item("a", 1, "2026-10-05T00:00:00Z"), item("b", 1, "2026-10-01T00:00:00Z")]);
  assert.deepEqual(list.map((i) => i.id), ["a", "b"], "a tie: the newer first");
  const voted = comingSoonOrder(list.map((i) => (i.id === "b" ? applyOwnVote(i, true, ME, false) : i)));
  assert.deepEqual(voted.map((i) => i.id), ["b", "a"]);
  assert.equal(voted[0]!.votes, 2);
  assert.equal(voted[0]!.voted, true);
  const undone = comingSoonOrder(voted.map((i) => (i.id === "b" ? applyOwnVote(i, false, ME, false) : i)));
  assert.deepEqual(undone.map((i) => i.id), ["a", "b"]);
});

test("live: a poll answer replaces the list, re-sorted", () => {
  // The server already orders it, but the page re-sorts whatever it holds with the same function.
  const polled = [item("a", 1, "2026-10-05T00:00:00Z"), item("b", 3, "2026-10-01T00:00:00Z"), item("c", 2, "2026-10-02T00:00:00Z")];
  assert.deepEqual(comingSoonOrder(polled).map((i) => i.id), ["b", "c", "a"]);
});

test("live: a poll answer asked for before the caller's latest vote, or during one, is dropped", () => {
  assert.equal(pollAnswerApplies(3, 3, 0), true);
  assert.equal(pollAnswerApplies(3, 4, 0), false, "the caller voted after the request");
  assert.equal(pollAnswerApplies(3, 3, 1), false, "a vote is in flight");
  assert.equal(pollAnswerApplies(3, 4, 1), false);
});

test("live: the caller's own bubble goes first on an upvote and leaves on an un-vote", () => {
  const base: ComingSoonItem = { ...item("x", 6, "2026-10-01T00:00:00Z"), voters: ["a", "b", "c", "d", "e"].map(voter), votersTotal: 6 };
  const up = applyOwnVote(base, true, ME, false);
  assert.deepEqual(up.voters.map((v) => v.id), ["me", "a", "b", "c", "d"], "newest first, still five");
  assert.equal(up.voters[0]!.onlyYou, undefined);
  assert.equal(up.votersTotal, 7);
  assert.equal(up.votes, 7);
  const down = applyOwnVote(up, false, ME, false);
  assert.deepEqual(down.voters.map((v) => v.id), ["a", "b", "c", "d"]);
  assert.equal(down.votersTotal, 6);
  assert.equal(down.votes, 6);
  assert.equal(applyOwnVote(up, true, ME, false), up, "a vote already in place changes nothing");
});

test("live: while the caller hides their votes, their bubble is marked only you", () => {
  const base: ComingSoonItem = { ...item("x", 2, "2026-10-01T00:00:00Z"), voters: [voter("a")], votersTotal: 1 };
  const up = applyOwnVote(base, true, ME, true);
  assert.deepEqual(up.voters[0], { ...ME, onlyYou: true });
  assert.equal(up.votersTotal, 2, "the viewer is always listed to themself");
});

test("live: an un-vote whose bubble is past the strip still drops the listed total", () => {
  // The caller voted long ago: their bubble is listed (to them) but not among the newest five.
  const base: ComingSoonItem = { ...item("x", 8, "2026-10-01T00:00:00Z"), voted: true, voters: ["a", "b", "c", "d", "e"].map(voter), votersTotal: 8 };
  const down = applyOwnVote(base, false, ME, false);
  assert.equal(down.votes, 7);
  assert.deepEqual(down.voters.map((v) => v.id), ["a", "b", "c", "d", "e"]);
  assert.equal(down.votersTotal, 7);
});

test("live: without the caller's identity only the count and the ▲ change", () => {
  const base: ComingSoonItem = { ...item("x", 1, "2026-10-01T00:00:00Z"), voters: [voter("a")], votersTotal: 1 };
  const up = applyOwnVote(base, true, null, false);
  assert.equal(up.votes, 2);
  assert.equal(up.voted, true);
  assert.deepEqual(up.voters, base.voters);
});

test("live: the Upvoted by accessible name", () => {
  assert.equal(upvotedByLabel([voter("ana")], 1, "me"), "Upvoted by ANA");
  assert.equal(upvotedByLabel([voter("ana"), voter("ben")], 2, "me"), "Upvoted by ANA and BEN");
  assert.equal(upvotedByLabel([voter("ana"), { ...ME, onlyYou: true }, voter("ben")], 3, "me"), "Upvoted by ANA, you (only you see this) and BEN");
  assert.equal(upvotedByLabel([ME, voter("ana")], 2, "me"), "Upvoted by you and ANA");
  assert.equal(upvotedByLabel(["a", "b", "c", "d", "e"].map(voter), 17, "me"), "Upvoted by A, B, C, D, E and 12 others");
  assert.equal(upvotedByLabel(["a", "b", "c", "d", "e"].map(voter), 6, "me"), "Upvoted by A, B, C, D, E and 1 other");
});

test("live: the own-vote announcement", () => {
  assert.equal(ownVoteAnnouncement(true, "CSV export", 5, 2, 9), "Upvoted CSV export: 5 votes, now number 2 of 9.");
  assert.equal(ownVoteAnnouncement(false, "CSV export", 1, 4, 9), "Removed your upvote from CSV export: 1 vote, now number 4 of 9.");
});

test("live: the constants the page and the server share", () => {
  assert.equal(COMING_SOON_POLL_MS, 15_000);
  assert.equal(VOTER_STRIP_MAX, 5);
  assert.equal(VOTER_LIST_MAX, 100);
  assert.equal(VOTE_MOVE_GUARD_MS, 400);
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
