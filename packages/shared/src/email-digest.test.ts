import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DIGEST_SETTINGS,
  DIGEST_CANDIDATE_TYPES,
  DIGEST_DEFAULT_TYPES,
  DIGEST_FLOOR_TYPES,
  DIGEST_LINE_CAP,
  DIGEST_NEVER_EMAILED_TYPES,
  DIGEST_OPTIONAL_TYPES,
  DigestSettingError,
  coerceDigestSettings,
  digestDue,
  digestSlot,
  effectiveDigestMode,
  formatDigestHour,
  isDigestCandidate,
  isDigestDeferred,
  parseDigestHour,
  parseDigestMode,
  parseDigestTypes,
  parseDigestWeekday,
  renderDigest,
  type DigestRow,
} from "./email-digest.js";
import { NOTIFICATION_LABELS } from "./notifications.js";

// ── Tiers ─────────────────────────────────────────────────────────────────────

test("tiers: the floor and never-emailed types are not candidates; the two changeable tiers are", () => {
  for (const t of [...DIGEST_FLOOR_TYPES, ...DIGEST_NEVER_EMAILED_TYPES]) assert.equal(isDigestCandidate(t), false, t);
  for (const t of [...DIGEST_DEFAULT_TYPES, ...DIGEST_OPTIONAL_TYPES]) assert.equal(isDigestCandidate(t), true, t);
  assert.equal(DIGEST_CANDIDATE_TYPES.length, DIGEST_DEFAULT_TYPES.length + DIGEST_OPTIONAL_TYPES.length);
});

test("tiers: the candidate list is closed — an unclassified type (even a known one) is never a candidate", () => {
  assert.equal(isDigestCandidate("skill.discussion_reply"), false);
  assert.equal(isDigestCandidate("skill.brand_new_type"), false);
});

test("tiers: every classified type is a real notification type, in exactly one tier", () => {
  const all = [...DIGEST_FLOOR_TYPES, ...DIGEST_DEFAULT_TYPES, ...DIGEST_OPTIONAL_TYPES, ...DIGEST_NEVER_EMAILED_TYPES];
  assert.equal(new Set(all).size, all.length);
  for (const t of all) assert.ok(NOTIFICATION_LABELS[t], `${t} has a §12 label`);
});

// ── Settings validation ───────────────────────────────────────────────────────

test("settings: parsers accept the documented ranges and reject the rest", () => {
  assert.equal(parseDigestMode("weekly"), "weekly");
  assert.throws(() => parseDigestMode("monthly"), DigestSettingError);
  assert.equal(parseDigestHour(0), 0);
  assert.equal(parseDigestHour(23), 23);
  for (const bad of [-1, 24, 8.5, "8", null]) assert.throws(() => parseDigestHour(bad), DigestSettingError);
  assert.equal(parseDigestWeekday(1), 1);
  assert.equal(parseDigestWeekday(7), 7);
  for (const bad of [0, 8, 1.5, "1"]) assert.throws(() => parseDigestWeekday(bad), DigestSettingError);
});

test("settings: types must be candidates; result is deduped and in canonical order", () => {
  assert.deepEqual(parseDigestTypes(["request.fulfilled", "skill.new_version", "skill.new_version"]), ["skill.new_version", "request.fulfilled"]);
  assert.deepEqual(parseDigestTypes([]), []);
  assert.throws(() => parseDigestTypes(["message.new"]), DigestSettingError, "the floor is not configurable");
  assert.throws(() => parseDigestTypes(["achievement.earned"]), DigestSettingError);
  assert.throws(() => parseDigestTypes(["nope"]), DigestSettingError);
  assert.throws(() => parseDigestTypes("skill.new_version"), DigestSettingError);
});

test("settings: coerce falls back per key and keeps only valid stored types", () => {
  assert.deepEqual(coerceDigestSettings(() => undefined), { ...DEFAULT_DIGEST_SETTINGS, types: [...DEFAULT_DIGEST_SETTINGS.types] });
  const stored: Record<string, unknown> = {
    email_digests_enabled: false,
    email_digest_default_mode: "daily",
    email_digest_hour: 99,
    email_digest_weekday: 5,
    email_digest_types: ["skill.drift", "message.new", "bogus"],
  };
  const s = coerceDigestSettings((k) => stored[k]);
  assert.equal(s.enabled, false);
  assert.equal(s.defaultMode, "daily");
  assert.equal(s.hour, 8, "out-of-range hour falls back");
  assert.equal(s.weekday, 5);
  assert.deepEqual(s.types, ["skill.drift"]);
});

test("formatDigestHour: EU 24 h, US AM/PM", () => {
  assert.equal(formatDigestHour(8, "eu"), "08:00");
  assert.equal(formatDigestHour(17, "eu"), "17:00");
  assert.equal(formatDigestHour(0, "us"), "12:00 AM");
  assert.equal(formatDigestHour(8, "us"), "8:00 AM");
  assert.equal(formatDigestHour(12, "us"), "12:00 PM");
  assert.equal(formatDigestHour(23, "us"), "11:00 PM");
});

// ── Effective mode ────────────────────────────────────────────────────────────

test("effectiveDigestMode: email off wins, then the kill switch, then choice ?? default", () => {
  const on = { enabled: true, defaultMode: "daily" as const };
  const off = { enabled: false, defaultMode: "daily" as const };
  assert.equal(effectiveDigestMode({ emailNotifications: false, emailDigest: "weekly" }, on), "off");
  assert.equal(effectiveDigestMode({ emailNotifications: false, emailDigest: "weekly" }, off), "off");
  assert.equal(effectiveDigestMode({ emailNotifications: true, emailDigest: "weekly" }, off), "immediate");
  assert.equal(effectiveDigestMode({ emailNotifications: true, emailDigest: "weekly" }, on), "weekly");
  assert.equal(effectiveDigestMode({ emailNotifications: true, emailDigest: "immediate" }, on), "immediate");
  assert.equal(effectiveDigestMode({ emailNotifications: true, emailDigest: null }, on), "daily");
  assert.equal(effectiveDigestMode({ emailNotifications: true }, { enabled: true, defaultMode: "immediate" }), "immediate");
  assert.equal(effectiveDigestMode({ emailNotifications: true, emailDigest: "daily", status: "inactive" }, on), "off");
  assert.equal(effectiveDigestMode({ emailNotifications: true, emailDigest: "daily", email: "" }, on), "off");
});

test("isDigestDeferred: only digest modes and enabled types", () => {
  const settings = { types: ["skill.new_version"] };
  assert.equal(isDigestDeferred("skill.new_version", "daily", settings), true);
  assert.equal(isDigestDeferred("skill.new_version", "weekly", settings), true);
  assert.equal(isDigestDeferred("skill.new_version", "immediate", settings), false);
  assert.equal(isDigestDeferred("skill.new_version", "off", settings), false);
  assert.equal(isDigestDeferred("skill.discussion", "daily", settings), false);
});

// ── Slots ─────────────────────────────────────────────────────────────────────

const iso = (d: Date) => d.toISOString();

test("digestSlot: daily in UTC (null zone) — today's hour once passed, else yesterday's", () => {
  assert.equal(iso(digestSlot(new Date("2026-10-13T09:30:00Z"), "daily", 8, 1, null)), "2026-10-13T08:00:00.000Z");
  assert.equal(iso(digestSlot(new Date("2026-10-13T07:59:59Z"), "daily", 8, 1, null)), "2026-10-12T08:00:00.000Z");
  assert.equal(iso(digestSlot(new Date("2026-10-13T08:00:00Z"), "daily", 8, 1, null)), "2026-10-13T08:00:00.000Z");
});

test("digestSlot: daily in several zones (wall-clock 08:00 local)", () => {
  // Sofia is UTC+3 in October (EEST).
  assert.equal(iso(digestSlot(new Date("2026-10-13T06:00:00Z"), "daily", 8, 1, "Europe/Sofia")), "2026-10-13T05:00:00.000Z");
  // New York is UTC-4 in October (EDT); 11:00Z = 07:00 local, so yesterday's slot.
  assert.equal(iso(digestSlot(new Date("2026-10-13T11:00:00Z"), "daily", 8, 1, "America/New_York")), "2026-10-12T12:00:00.000Z");
  // Tokyo (UTC+9, no DST) — local date already the 14th.
  assert.equal(iso(digestSlot(new Date("2026-10-13T23:30:00Z"), "daily", 8, 1, "Asia/Tokyo")), "2026-10-13T23:00:00.000Z");
  // An unknown zone falls back to UTC.
  assert.equal(iso(digestSlot(new Date("2026-10-13T09:30:00Z"), "daily", 8, 1, "Mars/Olympus")), "2026-10-13T08:00:00.000Z");
});

test("digestSlot: weekly — the most recent chosen weekday at the hour", () => {
  // 2026-10-13 is a Tuesday. Monday 08:00 UTC = the 12th.
  assert.equal(iso(digestSlot(new Date("2026-10-13T09:00:00Z"), "weekly", 8, 1, null)), "2026-10-12T08:00:00.000Z");
  // On Monday before the hour → the previous Monday.
  assert.equal(iso(digestSlot(new Date("2026-10-12T07:00:00Z"), "weekly", 8, 1, null)), "2026-10-05T08:00:00.000Z");
  // Friday (5) 17:00 in Berlin (UTC+2 in October).
  assert.equal(iso(digestSlot(new Date("2026-10-13T09:00:00Z"), "weekly", 17, 5, "Europe/Berlin")), "2026-10-09T15:00:00.000Z");
  // Sunday (7).
  assert.equal(iso(digestSlot(new Date("2026-10-13T09:00:00Z"), "weekly", 0, 7, null)), "2026-10-11T00:00:00.000Z");
});

test("digestSlot: follows DST, and a slot hour skipped by spring-forward fires at the next instant that exists", () => {
  // Berlin: winter UTC+1, summer UTC+2 — 08:00 local moves from 07:00Z to 06:00Z.
  assert.equal(iso(digestSlot(new Date("2026-03-28T12:00:00Z"), "daily", 8, 1, "Europe/Berlin")), "2026-03-28T07:00:00.000Z");
  assert.equal(iso(digestSlot(new Date("2026-03-30T12:00:00Z"), "daily", 8, 1, "Europe/Berlin")), "2026-03-30T06:00:00.000Z");
  // 2026-03-29 02:00 does not exist in Berlin (01:00Z jumps 02:00 → 03:00): the slot is 01:00Z.
  assert.equal(iso(digestSlot(new Date("2026-03-29T05:00:00Z"), "daily", 2, 1, "Europe/Berlin")), "2026-03-29T01:00:00.000Z");
  // Fall-back: 02:00 happens twice on 2026-10-25 — the first occurrence (00:00Z) is the slot.
  assert.equal(iso(digestSlot(new Date("2026-10-25T05:00:00Z"), "daily", 2, 1, "Europe/Berlin")), "2026-10-25T00:00:00.000Z");
});

test("digestDue: first sight stamps without sending; missed slots give one digest", () => {
  const slot = new Date("2026-10-13T08:00:00Z");
  assert.equal(digestDue(null, slot), "first_sight");
  assert.equal(digestDue(new Date("2026-10-12T08:00:00Z"), slot), "due");
  assert.equal(digestDue(new Date("2026-10-01T08:00:00Z"), slot), "due", "a week of missed slots is still one 'due'");
  assert.equal(digestDue(slot, slot), "not_due");
});

// ── Renderer ──────────────────────────────────────────────────────────────────

const BASE = "https://skilly.test";
let seq = 0;
const row = (type: string, payload: Record<string, unknown>, minute: number): DigestRow => ({
  id: `r${++seq}`,
  type,
  payload,
  createdAt: new Date(Date.UTC(2026, 9, 12, 10, minute)),
});

test("renderDigest: subject, opening line, and the three sections in order", () => {
  const rows = [
    row("proposal.accept", { proposalId: "p1" }, 1),
    row("follow.new_skill", { actorId: "u1", actorName: "Ada", namespaceSlug: "eng", skillSlug: "lint" }, 2),
    row("skill.new_version", { namespaceSlug: "eng", skillSlug: "pdf", semver: "1.2.0" }, 3),
  ];
  const r = renderDigest(rows, { mode: "daily", baseUrl: BASE, bodySentence: (x) => (x.type === "proposal.accept" ? "Your skill proposal was accepted." : "?") });
  assert.equal(r.subject, "Skilly - Daily digest");
  assert.match(r.text, /^Here is your daily summary from skilly: 3 updates\./);
  const iSkills = r.text.indexOf("\nSkills\n");
  const iPeople = r.text.indexOf("\nPeople you follow\n");
  const iMine = r.text.indexOf("\nYour proposals and requests\n");
  assert.ok(iSkills > 0 && iSkills < iPeople && iPeople < iMine, r.text);
  assert.match(r.text, /- \[eng\/pdf\]\(https:\/\/skilly\.test\/skills\/eng\/pdf\) · new version v1\.2\.0/);
  assert.match(r.text, /- Ada · \[published eng\/lint\]\(https:\/\/skilly\.test\/skills\/eng\/lint\)/);
  assert.match(r.text, /- \[Your skill proposal was accepted\.\]\(https:\/\/skilly\.test\/proposals\/p1\)/);
  assert.equal(renderDigest(rows, { mode: "weekly", baseUrl: BASE }).subject, "Skilly - Weekly digest");
  assert.match(renderDigest(rows.slice(0, 1), { mode: "weekly", baseUrl: BASE }).text, /weekly summary from skilly: 1 update\./);
});

test("renderDigest: one line per skill merges its rows (versions aggregated, comments, official, shared, stars)", () => {
  const rows = [
    row("skill.new_version", { namespaceSlug: "eng", skillSlug: "pdf", semver: "1.0.0" }, 1),
    row("skill.shared_new_version", { namespaceSlug: "eng", skillSlug: "pdf", semver: "1.1.0" }, 2),
    row("skill.new_version", { namespaceSlug: "eng", skillSlug: "pdf", semver: "1.2.0" }, 3),
    row("skill.discussion", { namespaceSlug: "eng", skillSlug: "pdf", fromName: "Bo" }, 4),
    row("skill.marked_official", { namespaceSlug: "eng", skillSlug: "pdf" }, 5),
    row("skill.shared", { namespaceSlug: "eng", skillSlug: "pdf" }, 6),
    row("skill.quality_low", { namespaceSlug: "eng", skillSlug: "pdf", stars: 1.5 }, 7),
    row("skill.drift", { namespaceSlug: "eng", skillSlug: "pdf", ref: "main" }, 8),
  ];
  const r = renderDigest(rows, { mode: "daily", baseUrl: BASE, bodySentence: () => "eng/pdf has drifted from its pinned upstream ref (main)." });
  const lines = r.text.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 1);
  assert.equal(
    lines[0],
    "- [eng/pdf](https://skilly.test/skills/eng/pdf) · 3 new versions (latest v1.2.0) · new comments (latest from Bo) · marked official · shared with your namespace · scored 1.5 ★ · eng/pdf has drifted from its pinned upstream ref (main).",
  );
});

test("renderDigest: a comments-only skill line links to #discussion; lines run newest first", () => {
  const rows = [
    row("skill.discussion", { namespaceSlug: "a", skillSlug: "old", fromName: "X" }, 1),
    row("skill.new_version", { namespaceSlug: "a", skillSlug: "new", semver: "2.0.0" }, 9),
  ];
  const lines = renderDigest(rows, { mode: "daily", baseUrl: BASE }).text.split("\n").filter((l) => l.startsWith("- "));
  assert.match(lines[0]!, /a\/new/);
  assert.match(lines[1]!, /\(https:\/\/skilly\.test\/skills\/a\/old#discussion\) · new comments \(latest from X\)/);
});

test("renderDigest: people you follow — one line per person, one linked fragment per event", () => {
  const rows = [
    row("follow.new_version", { actorId: "u1", actorName: "Ada", namespaceSlug: "eng", skillSlug: "pdf", semver: "1.2.0" }, 1),
    row("follow.achievement", { actorId: "u1", actorName: "Ada", badgeName: "Pioneer", badgeKey: "pioneer" }, 2),
    row("follow.request_created", { actorId: "u1", actorName: "Ada", requestTitle: "OCR", requestId: "q1" }, 3),
    row("follow.request_fulfilled", { actorId: "u2", actorName: "Bo", requestTitle: "Diff", namespaceSlug: "x", skillSlug: "diff" }, 4),
    row("follow.collection_created", { actorId: "u2", actorName: "Bo", collectionName: "Starter", collectionId: "c1" }, 5),
  ];
  const lines = renderDigest(rows, { mode: "weekly", baseUrl: BASE }).text.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(lines, [
    "- Bo · [fulfilled \"Diff\"](https://skilly.test/skills/x/diff) · [created the collection Starter](https://skilly.test/catalog?collection=c1)",
    "- Ada · [published v1.2.0 of eng/pdf](https://skilly.test/skills/eng/pdf) · [earned the Pioneer badge](https://skilly.test/achievements/u1?badge=pioneer) · [requested \"OCR\"](https://skilly.test/requests/q1)",
  ]);
});

test("renderDigest: proposals and requests — one line per item, its sentences in order", () => {
  const rows = [
    row("proposal.start_review", { proposalId: "p1" }, 1),
    row("request.fulfilled", { requestId: "q1", requestTitle: "OCR" }, 2),
    row("proposal.accept", { proposalId: "p1" }, 3),
  ];
  const sentences: Record<string, string> = {
    "proposal.start_review": "Your skill proposal is now under review.",
    "proposal.accept": "Your skill proposal was accepted.\n\nSecond paragraph never shown.",
    "request.fulfilled": "Your skill request \"OCR\" was fulfilled.",
  };
  const lines = renderDigest(rows, { mode: "daily", baseUrl: BASE, bodySentence: (r) => sentences[r.type]! }).text.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(lines, [
    "- [Your skill proposal is now under review. Your skill proposal was accepted.](https://skilly.test/proposals/p1)",
    "- [Your skill request \"OCR\" was fulfilled.](https://skilly.test/requests/q1)",
  ]);
});

test("renderDigest: the cap fills in section order and counts the rest as updates", () => {
  const rows: DigestRow[] = [];
  for (let i = 0; i < DIGEST_LINE_CAP + 3; i++) rows.push(row("skill.new_version", { namespaceSlug: "ns", skillSlug: `s${i}`, semver: "1.0.0" }, i));
  rows.push(row("follow.new_skill", { actorId: "u", actorName: "Ada", namespaceSlug: "ns", skillSlug: "z" }, 0));
  rows.push(row("follow.new_skill", { actorId: "u", actorName: "Ada", namespaceSlug: "ns", skillSlug: "y" }, 1));
  const r = renderDigest(rows, { mode: "daily", baseUrl: BASE });
  assert.equal(r.text.split("\n").filter((l) => l.startsWith("- ")).length, DIGEST_LINE_CAP);
  assert.ok(!r.text.includes("People you follow"), "the section past the cap is omitted");
  assert.match(r.text, /…and 5 more updates\.\n\[See everything in skilly\]\(https:\/\/skilly\.test\/notifications\)$/);
  assert.match(r.html, /…and 5 more updates\.<br>\n<a href="https:\/\/skilly\.test\/notifications">See everything in skilly<\/a>/);
});

test("renderDigest: no base URL → bare labels, no links", () => {
  const r = renderDigest([row("skill.new_version", { namespaceSlug: "eng", skillSlug: "pdf", semver: "1.0.0" }, 1)], { mode: "daily", baseUrl: "" });
  assert.match(r.text, /^- eng\/pdf · new version v1\.0\.0$/m);
  assert.ok(!r.text.includes("]("));
  assert.ok(!r.html.includes("<a "));
});

test("renderDigest: HTML — bold section titles, lists, escaped names, anchors", () => {
  const r = renderDigest(
    [
      row("skill.discussion", { namespaceSlug: "eng", skillSlug: "pdf", fromName: "<b>Eve</b> [x](https://evil.test)" }, 1),
    ],
    { mode: "daily", baseUrl: BASE },
  );
  assert.match(r.html, /<p><strong>Skills<\/strong><\/p>\n<ul>\n<li><a href="https:\/\/skilly\.test\/skills\/eng\/pdf#discussion">eng\/pdf<\/a>/);
  assert.ok(r.html.includes("&lt;b&gt;Eve&lt;/b&gt;"), "names are escaped");
  assert.ok(!r.text.includes("[x](https://evil.test)"), "a name cannot open a markdown link");
});
