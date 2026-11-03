// Unit tests for the §65 review-target core (SKILLY_SPEC.md §65.12).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_ASSIGNED,
  REVIEW_CHANGES_REMINDER,
  REVIEW_ESCALATED,
  REVIEW_OVERDUE,
  addBusinessDays,
  businessDaysBetween,
  businessMsBetween,
  duePill,
  duePillLabel,
  duePillTone,
  normalizeReviewTarget,
  reviewNotificationContent,
  reviewTargetError,
  reviewTurn,
  reviewerIdsSql,
} from "./review-target.js";
import { DIGEST_CANDIDATE_TYPES, DIGEST_FLOOR_TYPES, DIGEST_OPTIONAL_TYPES } from "./email-digest.js";
import { NOTIFICATION_LABELS } from "./notifications.js";

const d = (iso: string) => new Date(iso);
const iso = (x: Date) => x.toISOString();

test("reviewTargetError: empty means no target; 1–30 whole days pass; anything else fails", () => {
  for (const ok of [null, undefined, "", 1, 30, "7", " 12 "]) assert.equal(reviewTargetError(ok), null, String(ok));
  for (const bad of [0, 31, 1.5, -1, "abc", "1.5", true, {}]) assert.match(reviewTargetError(bad) ?? "", /whole number of business days/, String(bad));
  assert.equal(normalizeReviewTarget(""), null);
  assert.equal(normalizeReviewTarget(null), null);
  assert.equal(normalizeReviewTarget(" 5 "), 5);
  assert.equal(normalizeReviewTarget(3), 3);
});

test("reviewTurn: reviewers while proposed/under_review, the proposer while changes_requested, none once decided", () => {
  assert.equal(reviewTurn("proposed"), "reviewer");
  assert.equal(reviewTurn("under_review"), "reviewer");
  assert.equal(reviewTurn("changes_requested"), "proposer");
  assert.equal(reviewTurn("accepted"), null);
  assert.equal(reviewTurn("rejected"), null);
});

test("addBusinessDays: the spec's examples", () => {
  // 2026-11-06 is a Friday.
  assert.equal(iso(addBusinessDays(d("2026-11-06T15:00:00Z"), 1)), "2026-11-09T15:00:00.000Z"); // Fri → Mon
  assert.equal(iso(addBusinessDays(d("2026-11-07T10:00:00Z"), 1)), "2026-11-10T00:00:00.000Z"); // Sat → Tue 00:00
  assert.equal(iso(addBusinessDays(d("2026-11-04T09:00:00Z"), 3)), "2026-11-09T09:00:00.000Z"); // Wed + 3 → Mon
});

test("addBusinessDays: weekday starts, a Sunday start, two weekends and a 30-day target", () => {
  assert.equal(iso(addBusinessDays(d("2026-11-02T08:30:00Z"), 1)), "2026-11-03T08:30:00.000Z"); // Mon → Tue
  assert.equal(iso(addBusinessDays(d("2026-11-02T08:30:00Z"), 5)), "2026-11-09T08:30:00.000Z"); // a full week
  assert.equal(iso(addBusinessDays(d("2026-11-08T23:00:00Z"), 1)), "2026-11-10T00:00:00.000Z"); // Sun → Tue 00:00
  assert.equal(iso(addBusinessDays(d("2026-11-05T12:00:00Z"), 7)), "2026-11-16T12:00:00.000Z"); // Thu + 7 crosses two weekends
  assert.equal(iso(addBusinessDays(d("2026-11-02T00:00:00Z"), 30)), "2026-12-14T00:00:00.000Z"); // six weeks
  // Friday midnight + 1 lands on Saturday, which is skipped to Monday.
  assert.equal(iso(addBusinessDays(d("2026-11-06T00:00:00Z"), 1)), "2026-11-09T00:00:00.000Z");
});

test("addBusinessDays never lands on a weekend", () => {
  for (let h = 0; h < 24 * 14; h += 5) {
    const start = new Date(Date.UTC(2026, 10, 2) + h * 3_600_000);
    for (let n = 1; n <= 12; n++) {
      const dow = addBusinessDays(start, n).getUTCDay();
      assert.ok(dow !== 0 && dow !== 6, `${start.toISOString()} + ${n}`);
    }
  }
});

test("businessDaysBetween / businessMsBetween count only weekday time", () => {
  assert.equal(businessDaysBetween(d("2026-11-06T15:00:00Z"), d("2026-11-09T15:00:00Z")), 1); // Fri → Mon
  assert.equal(businessDaysBetween(d("2026-11-02T00:00:00Z"), d("2026-11-09T00:00:00Z")), 5);
  assert.equal(businessMsBetween(d("2026-11-07T00:00:00Z"), d("2026-11-09T00:00:00Z")), 0); // a weekend
  assert.equal(businessMsBetween(d("2026-11-09T00:00:00Z"), d("2026-11-02T00:00:00Z")), 0); // reversed
  assert.equal(businessDaysBetween(d("2026-11-02T10:00:00Z"), d("2026-11-03T09:59:00Z")), 0);
  // addBusinessDays and businessDaysBetween agree for weekday starts.
  const start = d("2026-11-04T13:00:00Z");
  for (let n = 1; n <= 30; n++) assert.equal(businessDaysBetween(start, addBusinessDays(start, n)), n);
});

test("duePill: due, due today, overdue and overdue N days", () => {
  const due = d("2026-11-11T12:00:00Z"); // a Wednesday
  assert.deepEqual(duePill(due, d("2026-11-09T11:00:00Z")), { kind: "due", days: 2 });
  assert.deepEqual(duePill(due, d("2026-11-11T08:00:00Z")), { kind: "due_today" });
  assert.deepEqual(duePill(due, d("2026-11-11T12:00:00Z")), { kind: "overdue", days: 0 });
  assert.deepEqual(duePill(due, d("2026-11-13T13:00:00Z")), { kind: "overdue", days: 2 });
  assert.equal(duePillLabel({ kind: "due", days: 2 }), "Due in 2d");
  assert.equal(duePillLabel({ kind: "due_today" }), "Due today");
  assert.equal(duePillLabel({ kind: "overdue", days: 0 }), "Overdue");
  assert.equal(duePillLabel({ kind: "overdue", days: 3 }), "Overdue 3d");
  assert.equal(duePillTone({ kind: "due", days: 2 }), "muted");
  assert.equal(duePillTone({ kind: "due_today" }), "warn");
  assert.equal(duePillTone({ kind: "overdue", days: 1 }), "danger");
});

test("reviewerIdsSql: placeholders only where they are needed", () => {
  const all = reviewerIdsSql({ who: "all", ns: "$1", boot: "$2" });
  assert.match(all, /namespace_admin' and rm.namespace_id = \$1/);
  assert.match(all, /platform_admin/);
  assert.match(all, /entra_object_id = \$2/);
  assert.match(all, /u.status = 'active' and u.erased_at is null/);
  const platform = reviewerIdsSql({ who: "platform", boot: "$1" });
  assert.doesNotMatch(platform, /namespace_admin/);
  const ns = reviewerIdsSql({ who: "namespace", ns: "$3", boot: "$9" });
  assert.doesNotMatch(ns, /platform_admin|\$9/);
  assert.throws(() => reviewerIdsSql({ who: "all", boot: "$1" }));
});

test("reviewNotificationContent: assigned (one proposal and a whole import)", () => {
  const one = reviewNotificationContent(REVIEW_ASSIGNED, { proposalId: "p1", ns: "team-a", slug: "pdf", byName: "Ana" })!;
  assert.equal(one.sentence, "Ana assigned you the proposal for team-a/pdf.");
  assert.equal(one.path, "/proposals/p1");
  const imp = reviewNotificationContent(REVIEW_ASSIGNED, { importId: "i1", ns: "team-a", repo: "acme/skills", count: 3, byName: "Ana" })!;
  assert.equal(imp.sentence, "Ana assigned you 3 proposals imported from acme/skills into team-a.");
  assert.equal(imp.ctaLabel, "Review them");
  assert.equal(imp.path, "/proposals?tab=review&import=i1&assignee=me");
});

test("reviewNotificationContent: the reminders, folded and single", () => {
  const single = reviewNotificationContent(REVIEW_OVERDUE, { ns: "team-a", days: 3, count: 1, proposalIds: ["p1"], slug: "pdf" })!;
  assert.equal(single.sentence, "The proposal for team-a/pdf is past team-a's review target of 3 business days.");
  assert.equal(single.path, "/proposals/p1");
  const many = reviewNotificationContent(REVIEW_OVERDUE, { ns: "team-a", days: 1, count: 4, proposalIds: ["p1", "p2", "p3", "p4"], slug: "pdf" })!;
  assert.equal(many.sentence, "4 proposals are past team-a's review target of 1 business day.");
  assert.equal(many.path, "/proposals?tab=review&ns=team-a&overdue=1");
  const esc = reviewNotificationContent(REVIEW_ESCALATED, { ns: "team-a", days: 2, count: 2, proposalIds: ["p1", "p2"] })!;
  assert.equal(esc.sentence, "2 proposals in team-a have waited twice the review target of 2 business days.");
  const escOne = reviewNotificationContent(REVIEW_ESCALATED, { ns: "team-a", days: 2, count: 1, proposalIds: ["p1"], slug: "pdf" })!;
  assert.equal(escOne.sentence, "The proposal for team-a/pdf has waited twice team-a's review target of 2 business days.");
  const mine = reviewNotificationContent(REVIEW_CHANGES_REMINDER, { ns: "team-a", days: 2, count: 1, proposalIds: ["p9"], slug: "pdf" })!;
  assert.equal(mine.sentence, "Your proposal for team-a/pdf is still waiting on the changes the reviewer asked for.");
  assert.equal(mine.path, "/proposals/p9");
  const mineMany = reviewNotificationContent(REVIEW_CHANGES_REMINDER, { ns: "team-a", count: 2, proposalIds: ["p8", "p9"] })!;
  assert.equal(mineMany.path, "/proposals?tab=mine&states=changes_requested");
  assert.equal(reviewNotificationContent("proposal.accept", {}), null);
});

test("§48.3: the reviewer-side types are floor, the proposer reminder is optional; all have labels", () => {
  for (const t of [REVIEW_ASSIGNED, REVIEW_OVERDUE, REVIEW_ESCALATED]) {
    assert.ok((DIGEST_FLOOR_TYPES as readonly string[]).includes(t), t);
    assert.ok(!DIGEST_CANDIDATE_TYPES.includes(t), t);
  }
  assert.ok((DIGEST_OPTIONAL_TYPES as readonly string[]).includes(REVIEW_CHANGES_REMINDER));
  for (const t of [REVIEW_ASSIGNED, REVIEW_OVERDUE, REVIEW_ESCALATED, REVIEW_CHANGES_REMINDER]) assert.ok(NOTIFICATION_LABELS[t], t);
});
