import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FOLLOW_NOTIFICATION_TYPES,
  followFanOutSql,
  followNotificationContent,
  followState,
  followableSql,
  isFollowNotificationType,
  isFollowable,
} from "./follows.js";
import { NOTIFICATION_LABELS } from "./notifications.js";
import { achievementDef } from "./achievements.js";

test("isFollowable: active, not erased, allowing follows", () => {
  assert.equal(isFollowable({ status: "active", erasedAt: null, allowFollows: true }), true);
  assert.equal(isFollowable({ status: "active", erasedAt: null, allowFollows: false }), false); // paused
  assert.equal(isFollowable({ status: "inactive", erasedAt: null, allowFollows: true }), false);
  assert.equal(isFollowable({ status: "inactive", erasedAt: new Date(), allowFollows: true }), false);
  assert.equal(followableSql("x"), "(x.status = 'active' and x.erased_at is null and x.allow_follows)");
});

test("followState: inactive outranks paused", () => {
  assert.equal(followState({ status: "active", allowFollows: true }), "active");
  assert.equal(followState({ status: "active", allowFollows: false }), "paused");
  assert.equal(followState({ status: "inactive", allowFollows: false }), "inactive");
});

test("every follow.* type has a shared label and renders a sentence", () => {
  for (const t of FOLLOW_NOTIFICATION_TYPES) {
    assert.ok(NOTIFICATION_LABELS[t], t);
    const c = followNotificationContent(t, { actorName: "Ada", namespaceSlug: "ns", skillSlug: "s", semver: "1.2.0", requestTitle: "R", requestId: "r1", actorId: "u1", badgeKey: "first_follow", badgeName: "Right Behind You" });
    assert.ok(c && c.sentence.startsWith("Ada "), t);
    assert.ok(c.path.startsWith("/"), t);
  }
  assert.equal(isFollowNotificationType("skill.new_version"), false);
  assert.equal(followNotificationContent("skill.new_version", {}), null);
});

test("content: the per-type sentences and links (§35.6)", () => {
  assert.deepEqual(followNotificationContent("follow.new_version", { actorName: "Ada", namespaceSlug: "ns", skillSlug: "s", semver: "2.0.0" }), {
    sentence: "Ada published version 2.0.0 of ns/s.",
    ctaLabel: "View the skill",
    path: "/skills/ns/s",
  });
  assert.equal(followNotificationContent("follow.achievement", { actorName: "Ada", actorId: "u1", badgeKey: "first_watch", badgeName: "X" })!.path, "/achievements/u1?badge=first_watch");
  assert.equal(followNotificationContent("follow.request_created", { actorName: "Ada", requestId: "r9", requestTitle: "PDF tools" })!.sentence, 'Ada requested a skill: "PDF tools".');
  // Odd payloads never throw and never leak JSON.
  const c = followNotificationContent("follow.new_skill", null)!;
  assert.equal(c.sentence, "Someone you follow published a new skill, a skill.");
});

test("fan-out SQL: status + pause filters always; visibility gate only with a skill", () => {
  const plain = followFanOutSql({ type: "follow.achievement", actorId: "a", payload: { badgeKey: "k" }, skill: null });
  assert.match(plain.text, /insert into notifications/);
  assert.match(plain.text, /fu\.status = 'active' and fu\.erased_at is null/);
  assert.match(plain.text, /au\.allow_follows/);
  assert.doesNotMatch(plain.text, /role_mappings/);
  assert.deepEqual(plain.values.slice(0, 4), ["follow.achievement", JSON.stringify({ badgeKey: "k" }), "a", []]);

  const gated = followFanOutSql({ type: "follow.new_skill", actorId: "a", payload: {}, skill: { namespaceId: "ns-1", visibility: "namespace" }, excludeUserIds: ["w1", "w2"] });
  assert.match(gated.text, /\$5::text = 'org'/);
  assert.match(gated.text, /rm\.role = 'platform_admin' or rm\.namespace_id = \$6::uuid/);
  assert.match(gated.text, /f\.follower_id <> all\(\$4::uuid\[\]\)/);
  assert.deepEqual(gated.values.slice(3), [["w1", "w2"], "namespace", "ns-1"]);
});

test("fan-out SQL rejects a non-follow type", () => {
  assert.throws(() => followFanOutSql({ type: "skill.new_version" as never, actorId: "a", payload: {}, skill: null }));
});

test("catalog: the two follow badges exist (§35.8)", () => {
  assert.equal(achievementDef("first_follow")?.name, "Right Behind You");
  assert.equal(achievementDef("first_follow")?.group, "Explore");
  assert.equal(achievementDef("followers_10")?.name, "Cult Following");
  assert.equal(achievementDef("followers_10")?.group, "Talk");
});
