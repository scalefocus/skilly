// Unit test for the leader-badge map (SKILLY_SPEC.md §21 extension) — the tie/prefix logic over
// already-sorted boards, with the board reader stubbed so no database is involved. Covers the
// fifth metric, "requested" (§26): a pure requester (zero everywhere else) is Request leader; a
// tie at the top awards everyone; a metric with nobody above zero has no leader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLeaderBadges, type BoardReader } from "./leaders";
import { leaderboardOrderBy, type LeaderboardEntry, type LeaderboardSort, type LeaderboardWindow } from "./leaderboard";

function entry(userId: string, over: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    userId, displayName: userId, email: `${userId}@org`, avatar: null,
    skillCount: 0, installs: 0, requestsFulfilled: 0, skillsWatched: 0, skillsRequested: 0,
    followers: 0, followable: true,
    ...over,
  };
}

const VALUE: Record<LeaderboardSort, (e: LeaderboardEntry) => number> = {
  installs: (e) => e.installs,
  skills: (e) => e.skillCount,
  requests: (e) => e.requestsFulfilled,
  watched: (e) => e.skillsWatched,
  requested: (e) => e.skillsRequested,
  followed: (e) => e.followers,
};

/** A fake board: the same rows for every window, sorted desc by the requested metric — exactly the
 *  contract computeLeaderBadges relies on (each sort lists its own metric non-increasing). */
function reader(rows: LeaderboardEntry[], rows30d: LeaderboardEntry[] = rows): BoardReader {
  return async (window: LeaderboardWindow, sort: LeaderboardSort) =>
    [...(window === "all" ? rows : rows30d)].sort((a, b) => VALUE[sort](b) - VALUE[sort](a));
}

test("a pure requester is Request leader in both windows and nothing else", async () => {
  const map = await computeLeaderBadges(reader([
    entry("asker", { skillsRequested: 5 }),
    entry("builder", { installs: 20, skillCount: 3 }),
  ]));
  assert.deepEqual(map["asker"], [
    { metric: "requested", window: "all" },
    { metric: "requested", window: "30d" },
  ]);
  // The builder leads installs + adoption only — never "requested", never a zero-valued metric.
  assert.deepEqual(
    map["builder"]!.map((b) => b.metric).sort(),
    ["installs", "installs", "skills", "skills"],
  );
});

test("a tie at the top of 'requested' awards every tied user", async () => {
  const map = await computeLeaderBadges(reader([
    entry("a", { skillsRequested: 2 }),
    entry("b", { skillsRequested: 2 }),
    entry("c", { skillsRequested: 1 }),
  ]));
  assert.ok(map["a"]!.some((b) => b.metric === "requested" && b.window === "all"));
  assert.ok(map["b"]!.some((b) => b.metric === "requested" && b.window === "all"));
  assert.equal(map["c"], undefined, "runner-up gets nothing");
});

test("a metric with nobody above zero has no leader, per window", async () => {
  // All-time: one request. Last 30 days: none — so the 30d Request badge must not be awarded.
  const map = await computeLeaderBadges(reader(
    [entry("asker", { skillsRequested: 1 })],
    [entry("asker", { skillsRequested: 0 })],
  ));
  assert.deepEqual(map["asker"], [{ metric: "requested", window: "all" }]);
});

test("empty boards produce an empty map", async () => {
  assert.deepEqual(await computeLeaderBadges(reader([])), {});
});

test("followers (§35.7): the most-followed person leads 'followed' per window — Influencer-in-Chief / Trendsetter", async () => {
  const map = await computeLeaderBadges(reader(
    [entry("star", { followers: 12 }), entry("newcomer", { followers: 3 })],
    [entry("star", { followers: 1 }), entry("newcomer", { followers: 3 })],
  ));
  assert.deepEqual(map["star"], [{ metric: "followed", window: "all" }]);
  assert.deepEqual(map["newcomer"], [{ metric: "followed", window: "30d" }]);
});

test("leaderboardOrderBy: the existing five chains are unchanged plus followers last; Followed leads with followers (§35.7)", () => {
  assert.equal(leaderboardOrderBy("installs"), "installs desc, skill_count desc, requests_fulfilled desc, skills_watched desc, skills_requested desc, followers desc, display_name asc");
  assert.equal(leaderboardOrderBy("requested"), "skills_requested desc, installs desc, skill_count desc, requests_fulfilled desc, skills_watched desc, followers desc, display_name asc");
  assert.equal(leaderboardOrderBy("watched"), "skills_watched desc, installs desc, skill_count desc, requests_fulfilled desc, skills_requested desc, followers desc, display_name asc");
  assert.equal(leaderboardOrderBy("followed"), "followers desc, installs desc, skill_count desc, requests_fulfilled desc, skills_watched desc, skills_requested desc, display_name asc");
});
