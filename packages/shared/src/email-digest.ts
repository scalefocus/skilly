// Email digests (SKILLY_SPEC.md §48) — the SINGLE SOURCE OF TRUTH for which notification types a
// digest may carry, the admin settings and their validation, the effective-mode rule, the send-slot
// clock and the digest renderer. The worker (deferral + digest sweep), the Profile page and the
// Administration card all read this module, so they can never disagree. Client-safe (no node
// deps); exported via the barrel and the `@skilly/shared/email-digest` subpath.
import { followNotificationContent, isFollowNotificationType } from "./follows.js";
import { NOTIFICATION_LABELS, notificationTitle } from "./notifications.js";
import { formatStars } from "./quality-status.js";
import { textToHtmlFragment } from "./email-template.js";

// ── Tiers (§48.3) ─────────────────────────────────────────────────────────────────────────────

/** The floor: people-to-people messages and the review queue. Always immediate; not configurable. */
export const DIGEST_FLOOR_TYPES = [
  "message.new",
  "message.mention",
  "proposal.needs_review",
  "proposal.revise",
  "proposal.resubmit",
] as const;

/** Awareness types: digestible by default; the admin can switch each one off. */
export const DIGEST_DEFAULT_TYPES = [
  "skill.new_version",
  "skill.discussion",
  "skill.shared",
  "skill.shared_new_version",
  "skill.marked_official",
  "skill.quality_low",
  "skill.hyped",
  "follow.new_skill",
  "follow.new_version",
  "follow.achievement",
  "follow.request_created",
  "follow.request_fulfilled",
  "follow.collection_created",
] as const;

/** Proposer lifecycle, safety flags, deprecations, fulfilled requests: immediate by default; the
 *  admin can switch each one on. */
export const DIGEST_OPTIONAL_TYPES = [
  "proposal.submitted",
  "proposal.start_review",
  "proposal.request_changes",
  "proposal.accept",
  "proposal.reject",
  "proposal.policy_violation",
  "skill.drift",
  "skill.content_risk",
  "skill.policy_flag",
  "skill.ai_prereview_flagged",
  "skill.deprecated",
  "request.fulfilled",
] as const;

/** Never emailed at all, so never digest candidates. */
export const DIGEST_NEVER_EMAILED_TYPES = ["system.error", "achievement.earned"] as const;

/**
 * The CLOSED candidate list: the only keys `email_digest_types` may hold. A notification type a
 * later section adds is immediate until that section classifies it here (§48.3).
 */
export const DIGEST_CANDIDATE_TYPES: readonly string[] = [...DIGEST_DEFAULT_TYPES, ...DIGEST_OPTIONAL_TYPES];

export function isDigestCandidate(type: string): boolean {
  return DIGEST_CANDIDATE_TYPES.includes(type);
}

/** The Administration checklist (§48.11): the two changeable tiers, each type with its §12 label. */
export const DIGEST_TYPE_GROUPS: { title: string; types: { type: string; label: string }[] }[] = [
  { title: "Following and skills", types: DIGEST_DEFAULT_TYPES.map((t) => ({ type: t, label: notificationTitle(t) })) },
  { title: "Proposals, requests and alerts", types: DIGEST_OPTIONAL_TYPES.map((t) => ({ type: t, label: notificationTitle(t) })) },
];

/** The floor as the Administration card lists it read-only ("Always sent right away"). The two
 *  `message.new` contexts share one key, so the direct-message case is named explicitly. */
export const DIGEST_FLOOR_LABELS: readonly string[] = [
  "Direct messages and messages on proposals and requests",
  NOTIFICATION_LABELS["message.mention"]!.title,
  NOTIFICATION_LABELS["proposal.needs_review"]!.title,
  NOTIFICATION_LABELS["proposal.revise"]!.title,
  NOTIFICATION_LABELS["proposal.resubmit"]!.title,
];

// ── Modes + settings (§48.2) ──────────────────────────────────────────────────────────────────

export type DigestMode = "immediate" | "daily" | "weekly";
export const DIGEST_MODES: readonly DigestMode[] = ["immediate", "daily", "weekly"];

export function isDigestMode(v: unknown): v is DigestMode {
  return v === "immediate" || v === "daily" || v === "weekly";
}

/** The user-facing name of each mode (Profile select, Administration default). */
export const DIGEST_MODE_LABELS: Record<DigestMode, string> = {
  immediate: "Each update",
  daily: "Daily digest",
  weekly: "Weekly digest",
};

/** ISO weekday names, index 0 = Monday (= weekday 1). */
export const DIGEST_WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** The send hour in the viewer's date style (the DateFormat rule): EU `08:00`, US `8:00 AM`. */
export function formatDigestHour(hour: number, style: "eu" | "us"): string {
  if (style === "eu") return `${String(hour).padStart(2, "0")}:00`;
  return `${hour % 12 === 0 ? 12 : hour % 12}:00 ${hour < 12 ? "AM" : "PM"}`;
}

export interface DigestSettings {
  /** The kill switch — off is dormant (choices kept, unused), not destructive. */
  enabled: boolean;
  defaultMode: DigestMode;
  /** Local wall-clock hour, 0–23. */
  hour: number;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** The enabled candidates, in canonical order. */
  types: string[];
}

/** The platform_settings key behind each field. All optional; absent ⇒ the default. */
export const DIGEST_SETTING_KEYS = {
  enabled: "email_digests_enabled",
  defaultMode: "email_digest_default_mode",
  hour: "email_digest_hour",
  weekday: "email_digest_weekday",
  types: "email_digest_types",
} as const satisfies Record<keyof DigestSettings, string>;

export const DEFAULT_DIGEST_SETTINGS: Readonly<DigestSettings> = Object.freeze({
  enabled: true,
  defaultMode: "immediate",
  hour: 8,
  weekday: 1,
  types: [...DIGEST_DEFAULT_TYPES],
});

/** Thrown by the parsers below; the admin API maps it to 422. */
export class DigestSettingError extends Error {}

export function parseDigestMode(v: unknown): DigestMode {
  if (!isDigestMode(v)) throw new DigestSettingError("frequency must be 'immediate', 'daily' or 'weekly'");
  return v;
}

export function parseDigestHour(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 23) throw new DigestSettingError("send hour must be a whole number from 0 to 23");
  return v;
}

export function parseDigestWeekday(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 7) throw new DigestSettingError("weekly digest day must be a whole number from 1 (Monday) to 7 (Sunday)");
  return v;
}

/** Validate a type list: every key must be a candidate (§48.3). Returns it deduped, in canonical order. */
export function parseDigestTypes(v: unknown): string[] {
  if (!Array.isArray(v)) throw new DigestSettingError("digest types must be a list of notification types");
  for (const t of v) {
    if (typeof t !== "string" || !isDigestCandidate(t)) throw new DigestSettingError(`not a digestible notification type: ${String(t)}`);
  }
  return DIGEST_CANDIDATE_TYPES.filter((t) => v.includes(t));
}

/** Read the five keys defensively: anything missing or malformed falls back to its default. */
export function coerceDigestSettings(get: (key: string) => unknown): DigestSettings {
  const enabled = get(DIGEST_SETTING_KEYS.enabled);
  const mode = get(DIGEST_SETTING_KEYS.defaultMode);
  const hour = get(DIGEST_SETTING_KEYS.hour);
  const weekday = get(DIGEST_SETTING_KEYS.weekday);
  const types = get(DIGEST_SETTING_KEYS.types);
  const ok = <T>(fn: () => T, fallback: T): T => {
    try { return fn(); } catch { return fallback; }
  };
  return {
    enabled: enabled !== false,
    defaultMode: isDigestMode(mode) ? mode : DEFAULT_DIGEST_SETTINGS.defaultMode,
    hour: ok(() => parseDigestHour(hour), DEFAULT_DIGEST_SETTINGS.hour),
    weekday: ok(() => parseDigestWeekday(weekday), DEFAULT_DIGEST_SETTINGS.weekday),
    // A stored list keeps its valid entries (an unknown key from a newer or older build is ignored).
    types: Array.isArray(types) ? DIGEST_CANDIDATE_TYPES.filter((t) => types.includes(t)) : [...DEFAULT_DIGEST_SETTINGS.types],
  };
}

// ── Effective mode (§48.4) ────────────────────────────────────────────────────────────────────

export interface DigestUser {
  emailNotifications: boolean;
  /** `users.email_digest`; null / undefined = follow the organization default. */
  emailDigest?: string | null;
  /** When given, a non-active user or a missing address gets no email of any kind. */
  status?: string;
  email?: string | null;
}

/** `"off"` = no email at all; otherwise how this user's digestible email goes out. */
export function effectiveDigestMode(user: DigestUser, settings: Pick<DigestSettings, "enabled" | "defaultMode">): DigestMode | "off" {
  if (!user.emailNotifications) return "off";
  if (user.status !== undefined && user.status !== "active") return "off";
  if (user.email !== undefined && !(user.email ?? "").trim()) return "off";
  if (!settings.enabled) return "immediate";
  return isDigestMode(user.emailDigest) ? user.emailDigest : settings.defaultMode;
}

/** §48.5: is this row's email deferred to a digest, given the recipient's effective mode? */
export function isDigestDeferred(type: string, mode: DigestMode | "off", settings: Pick<DigestSettings, "types">): boolean {
  return (mode === "daily" || mode === "weekly") && settings.types.includes(type);
}

// ── Send slots (§48.6) ────────────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** A usable IANA zone, or "UTC" for null / unknown zones. */
function zoneOrUtc(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    formatterFor(timeZone);
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** The wall clock of instant `t` in `timeZone`, expressed as if it were a UTC timestamp. */
function wallClockMs(t: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(t))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

/**
 * The instant at which the wall clock in `timeZone` reads `wall` (a UTC-encoded local time). A
 * time skipped by a spring-forward change resolves to the next instant that exists; a repeated
 * one (fall-back) to its first occurrence.
 */
function instantForWallClock(wall: number, timeZone: string): number {
  const candidates = [wall - (wallClockMs(wall - 14 * HOUR_MS, timeZone) - (wall - 14 * HOUR_MS)), wall - (wallClockMs(wall + 14 * HOUR_MS, timeZone) - (wall + 14 * HOUR_MS))];
  const exact = candidates.filter((c) => wallClockMs(c, timeZone) === wall);
  if (exact.length) return Math.min(...exact);
  // In a gap: the earliest candidate whose wall clock is already past the requested time is the
  // transition instant itself (the clock jumped over `wall` there).
  const after = candidates.filter((c) => wallClockMs(c, timeZone) > wall);
  return after.length ? Math.min(...after) : Math.max(...candidates);
}

/**
 * The most recent scheduled slot at or before `now` for a daily or weekly digest: `hour`:00 local
 * time in the user's zone (null → UTC), on ISO `weekday` for weekly. Wall-clock, so it follows DST.
 */
export function digestSlot(now: Date, mode: "daily" | "weekly", hour: number, weekday: number, timeZone: string | null | undefined): Date {
  const tz = zoneOrUtc(timeZone);
  const nowMs = now.getTime();
  const local = new Date(wallClockMs(nowMs, tz));
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const isoToday = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
  let back = mode === "weekly" ? (isoToday - weekday + 7) % 7 : 0;
  const step = mode === "weekly" ? 7 : 1;
  for (;;) {
    const slot = instantForWallClock(Date.UTC(y, m, d - back, hour), tz);
    if (slot <= nowMs) return new Date(slot);
    back += step;
    if (back > 15) return new Date(nowMs - step * DAY_MS); // unreachable guard
  }
}

/**
 * The due rule (§48.6). `first_sight` (no stamp yet — new to digests or just changed their choice)
 * stamps the slot without sending; `due` sends one digest however many slots were missed.
 */
export function digestDue(lastRunAt: Date | null, slot: Date): "first_sight" | "due" | "not_due" {
  if (!lastRunAt) return "first_sight";
  return lastRunAt.getTime() < slot.getTime() ? "due" : "not_due";
}

// ── Rendering (§48.9) ─────────────────────────────────────────────────────────────────────────

export const DIGEST_SUBJECTS: Record<"daily" | "weekly", string> = {
  daily: "Skilly - Daily digest",
  weekly: "Skilly - Weekly digest",
};

/** Lines across all sections before the overflow line. */
export const DIGEST_LINE_CAP = 50;

export interface DigestRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date | string;
}

export interface RenderDigestOptions {
  mode: "daily" | "weekly";
  /** PUBLIC_BASE_URL; empty → links degrade to bare labels (§12). */
  baseUrl: string;
  /**
   * The §12 body sentence of a row, without its call-to-action — injected by the worker, whose
   * per-update renderer owns those sentences. Used for types with no digest phrase of their own
   * (safety flags, deprecations, proposals, requests). Defaults to the type's title.
   */
  bodySentence?: (row: DigestRow) => string;
}

export interface RenderedDigest {
  subject: string;
  /** The message as plain text with `[label](url)` links — flattened by the text transport. */
  text: string;
  /** The message as an HTML fragment, for the §12 wrapper in place of [SYSTEM MESSAGE]. */
  html: string;
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));
/** Interpolated names never open or close a `[label](url)` link. */
const safe = (v: string): string => v.replace(/\[/g, "(").replace(/\]/g, ")");
const vprefix = (semver: string): string => (/^v/i.test(semver) ? semver : `v${semver}`);

interface Line {
  /** Newest row in the line — lines sort on it. */
  at: number;
  /** Rows the line stands for (the overflow count). */
  rows: number;
  text: string;
}

function isProposalOrRequest(type: string): boolean {
  return type.startsWith("proposal.") || type.startsWith("request.");
}

/** Pure: pending rows in → subject, text and HTML out. Rows may come in any order. */
export function renderDigest(rows: readonly DigestRow[], opts: RenderDigestOptions): RenderedDigest {
  const base = opts.baseUrl.replace(/\/$/, "");
  const link = (label: string, path: string): string => (base ? `[${safe(label)}](${base}${path})` : safe(label));
  const sentence = (r: DigestRow): string => {
    const raw = opts.bodySentence ? opts.bodySentence(r) : notificationTitle(r.type);
    return raw.split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").trim();
  };
  const sorted = [...rows].sort((a, b) => ms(a.createdAt) - ms(b.createdAt)); // oldest first

  // 1. Skills — one line per skill.
  const skills = new Map<string, DigestRow[]>();
  // 2. People you follow — one line per person.
  const people = new Map<string, DigestRow[]>();
  // 3. Your proposals and requests — one line per proposal or request.
  const mine = new Map<string, DigestRow[]>();
  const push = (m: Map<string, DigestRow[]>, k: string, r: DigestRow) => (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  for (const r of sorted) {
    const p = r.payload ?? {};
    if (isFollowNotificationType(r.type)) push(people, s(p.actorId) ?? s(p.actorName) ?? "?", r);
    else if (isProposalOrRequest(r.type)) push(mine, s(p.proposalId) ? `p:${p.proposalId}` : s(p.requestId) ? `r:${p.requestId}` : `x:${r.id}`, r);
    else push(skills, s(p.namespaceSlug) && s(p.skillSlug) ? `${p.namespaceSlug}/${p.skillSlug}` : `x:${r.id}`, r);
  }

  const skillLines: Line[] = [...skills.entries()].map(([key, rs]) => {
    const at = ms(rs[rs.length - 1]!.createdAt);
    if (key.startsWith("x:")) return { at, rows: rs.length, text: link(sentence(rs[0]!), "/notifications") };
    const parts: string[] = [];
    const versions = rs.filter((r) => r.type === "skill.new_version" || r.type === "skill.shared_new_version");
    if (versions.length) {
      const semvers = [...new Set(versions.map((r) => s(r.payload.semver)).filter((v): v is string => v !== null))];
      const latest = s(versions[versions.length - 1]!.payload.semver);
      if (semvers.length > 1 && latest) parts.push(`${semvers.length} new versions (latest ${vprefix(latest)})`);
      else parts.push(latest ? `new version ${vprefix(latest)}` : "new version");
    }
    const comments = rs.filter((r) => r.type === "skill.discussion");
    if (comments.length) {
      const from = s(comments[comments.length - 1]!.payload.fromName);
      parts.push(from ? `new comments (latest from ${safe(from)})` : "new comments");
    }
    if (rs.some((r) => r.type === "skill.marked_official")) parts.push("marked official");
    if (rs.some((r) => r.type === "skill.shared")) parts.push("shared with your namespace");
    const quality = rs.filter((r) => r.type === "skill.quality_low");
    if (quality.length) {
      const stars = quality[quality.length - 1]!.payload.stars;
      parts.push(typeof stars === "number" ? `scored ${formatStars(stars)} ★` : "low quality score");
    }
    // §50.7 one phrase however many times the skill re-entered the top N in the period.
    const hyped = rs.filter((r) => r.type === "skill.hyped");
    if (hyped.length) {
      const topN = hyped[hyped.length - 1]!.payload.topN;
      parts.push(typeof topN === "number" ? `entered the top ${topN} hyped skills` : "entered the top hyped skills");
    }
    const handled = new Set(["skill.new_version", "skill.shared_new_version", "skill.discussion", "skill.marked_official", "skill.shared", "skill.quality_low", "skill.hyped"]);
    for (const r of rs) if (!handled.has(r.type)) parts.push(safe(sentence(r)));
    const onlyComments = rs.every((r) => r.type === "skill.discussion");
    const path = `/skills/${key}${onlyComments ? "#discussion" : ""}`;
    return { at, rows: rs.length, text: [link(key, path), ...parts].join(" · ") };
  });

  const peopleLines: Line[] = [...people.values()].map((rs) => {
    const newest = rs[rs.length - 1]!;
    const actor = s(newest.payload.actorName) ?? "Someone you follow";
    const fragments = rs.map((r) => {
      const p = r.payload ?? {};
      const content = followNotificationContent(r.type, p);
      const path = content?.path ?? "/notifications";
      const skillRef = s(p.namespaceSlug) && s(p.skillSlug) ? `${p.namespaceSlug}/${p.skillSlug}` : "a skill";
      let label: string;
      switch (r.type) {
        case "follow.new_skill": label = `published ${skillRef}`; break;
        case "follow.new_version": label = s(p.semver) ? `published ${vprefix(s(p.semver)!)} of ${skillRef}` : `published a new version of ${skillRef}`; break;
        case "follow.achievement": label = `earned the ${s(p.badgeName) ?? "a new"} badge`; break;
        case "follow.request_created": label = `requested "${s(p.requestTitle) ?? "a skill"}"`; break;
        case "follow.request_fulfilled": label = `fulfilled "${s(p.requestTitle) ?? "a skill request"}"`; break;
        case "follow.collection_created": label = `created the collection ${s(p.collectionName) ?? "a new collection"}`; break;
        default: label = content?.sentence ?? notificationTitle(r.type);
      }
      return link(label, path);
    });
    return { at: ms(newest.createdAt), rows: rs.length, text: [safe(actor), ...fragments].join(" · ") };
  });

  const mineLines: Line[] = [...mine.entries()].map(([key, rs]) => {
    const path = key.startsWith("p:") ? `/proposals/${key.slice(2)}` : key.startsWith("r:") ? `/requests/${key.slice(2)}` : "/notifications";
    return { at: ms(rs[rs.length - 1]!.createdAt), rows: rs.length, text: link(rs.map(sentence).join(" "), path) };
  });

  const sections = [
    { title: "Skills", lines: skillLines },
    { title: "People you follow", lines: peopleLines },
    { title: "Your proposals and requests", lines: mineLines },
  ].map((sec) => ({ ...sec, lines: sec.lines.sort((a, b) => b.at - a.at) }));

  // The cap fills in section order; whatever falls past it is counted in updates.
  let budget = DIGEST_LINE_CAP;
  let overflow = 0;
  const shown = sections.map((sec) => {
    const keep = sec.lines.slice(0, Math.max(0, budget));
    for (const l of sec.lines.slice(keep.length)) overflow += l.rows;
    budget -= keep.length;
    return { title: sec.title, lines: keep };
  }).filter((sec) => sec.lines.length > 0);

  const n = rows.length;
  const opening = `Here is your ${opts.mode} summary from skilly: ${n} update${n === 1 ? "" : "s"}.`;
  const more = overflow > 0 ? `…and ${overflow} more update${overflow === 1 ? "" : "s"}.` : null;
  const seeAll = link("See everything in skilly", "/notifications");

  const text = [
    opening,
    ...shown.map((sec) => `${sec.title}\n${sec.lines.map((l) => `- ${l.text}`).join("\n")}`),
    ...(more ? [`${more}\n${seeAll}`] : []),
  ].join("\n\n");

  const html = [
    `<p>${textToHtmlFragment(opening)}</p>`,
    ...shown.map((sec) => `<p><strong>${textToHtmlFragment(sec.title)}</strong></p>\n<ul>\n${sec.lines.map((l) => `<li>${textToHtmlFragment(l.text)}</li>`).join("\n")}\n</ul>`),
    ...(more ? [`<p>${textToHtmlFragment(more)}<br>\n${textToHtmlFragment(seeAll)}</p>`] : []),
  ].join("\n");

  return { subject: DIGEST_SUBJECTS[opts.mode], text, html };
}
