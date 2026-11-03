// Review assignments and targets (SKILLY_SPEC.md §65) — the pure core shared by the web (assign
// API, queue pills, the Namespace administration page), the worker (the reminder sweep and the
// notification wording) and the tests. Client-safe (no node deps); exported via the barrel and the
// `@skilly/shared/review-target` subpath.
import type { ProposalState } from "./types.js";

// ── The setting (§65.3) ───────────────────────────────────────────────────────────────────────

export const REVIEW_TARGET_MIN_DAYS = 1;
export const REVIEW_TARGET_MAX_DAYS = 30;

/**
 * Why a review-target value can't be saved, or null when it can. Empty (`null`, `undefined`, `""`)
 * means "no target". The browser and `PATCH /api/namespaces/:id/settings` both call this, so they
 * can never disagree on what is acceptable.
 */
export function reviewTargetError(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < REVIEW_TARGET_MIN_DAYS || n > REVIEW_TARGET_MAX_DAYS) {
    return `the review target must be a whole number of business days from ${REVIEW_TARGET_MIN_DAYS} to ${REVIEW_TARGET_MAX_DAYS}, or empty for no target`;
  }
  return null;
}

/** The stored value of a valid input: a number of business days, or null for no target. */
export function normalizeReviewTarget(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  return typeof v === "string" ? Number(v.trim()) : (v as number);
}

// ── Turns (§65.3) ─────────────────────────────────────────────────────────────────────────────

export type ReviewTurn = "reviewer" | "proposer";

/** Whose turn an open proposal is: reviewers while `proposed`/`under_review`, the proposer while
 *  `changes_requested`; null once decided. Mirrors the migration-0106 trigger. */
export function reviewTurn(state: ProposalState): ReviewTurn | null {
  if (state === "proposed" || state === "under_review") return "reviewer";
  if (state === "changes_requested") return "proposer";
  return null;
}

// ── Business time (§65.3) ─────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function utcDow(ms: number): number {
  return new Date(ms).getUTCDay(); // 0 = Sunday … 6 = Saturday
}

/**
 * `n` business days after `start`: Monday–Friday in UTC, no holiday calendar. A start on a weekend
 * counts from the following Monday 00:00 UTC; otherwise the time of day is kept and each weekend
 * crossed is skipped. Friday 15:00 + 1 → Monday 15:00; Saturday 10:00 + 1 → Tuesday 00:00;
 * Wednesday 09:00 + 3 → Monday 09:00. The SQL function `skilly_add_business_days` (migration 0106)
 * is the same algorithm, and a DB test pins the two together.
 */
export function addBusinessDays(start: Date, n: number): Date {
  let t = start.getTime();
  const dow = utcDow(t);
  if (dow === 6 || dow === 0) t = Math.floor(t / DAY_MS) * DAY_MS + (dow === 6 ? 2 : 1) * DAY_MS;
  t += Math.floor(n / 5) * 7 * DAY_MS;
  for (let i = 0; i < n % 5; i++) {
    t += DAY_MS;
    if (utcDow(t) === 6) t += 2 * DAY_MS;
  }
  return new Date(t);
}

/** Business milliseconds in [a, b): the parts of the interval that fall on a UTC weekday. 0 when b ≤ a. */
export function businessMsBetween(a: Date, b: Date): number {
  const from = a.getTime();
  const to = b.getTime();
  if (to <= from) return 0;
  let total = 0;
  for (let day = Math.floor(from / DAY_MS) * DAY_MS; day < to; day += DAY_MS) {
    const dow = utcDow(day);
    if (dow === 0 || dow === 6) continue;
    total += Math.min(to, day + DAY_MS) - Math.max(from, day);
  }
  return total;
}

/** Whole business days elapsed between two instants (rounded down). */
export function businessDaysBetween(a: Date, b: Date): number {
  return Math.floor(businessMsBetween(a, b) / DAY_MS);
}

// ── The due pill (§65.5) ──────────────────────────────────────────────────────────────────────

export type DuePill =
  | { kind: "due"; days: number }
  | { kind: "due_today" }
  | { kind: "overdue"; days: number };

/** The queue/proposal-page pill for a reviewer-turn due instant, as seen at `now`. */
export function duePill(dueAt: Date, now: Date): DuePill {
  if (now.getTime() < dueAt.getTime()) {
    const left = businessDaysBetween(now, dueAt);
    return left >= 1 ? { kind: "due", days: left } : { kind: "due_today" };
  }
  return { kind: "overdue", days: businessDaysBetween(dueAt, now) };
}

/** The pill's text: *Due in 2d*, *Due today*, *Overdue*, *Overdue 3d*. */
export function duePillLabel(p: DuePill): string {
  if (p.kind === "due") return `Due in ${p.days}d`;
  if (p.kind === "due_today") return "Due today";
  return p.days >= 1 ? `Overdue ${p.days}d` : "Overdue";
}

/** The pill's tone: muted while due, warn on the last day, danger once overdue. */
export function duePillTone(p: DuePill): "muted" | "warn" | "danger" {
  return p.kind === "due" ? "muted" : p.kind === "due_today" ? "warn" : "danger";
}

// ── The reviewer pool, as SQL (§65.2) ─────────────────────────────────────────────────────────

/**
 * SQL that selects the ids (`id`) of the ACTIVE reviewers a §65 rule needs — the same audience as
 * `proposal.needs_review`: platform admins and the bootstrap admin group (`who: "platform"`), the
 * namespace's admins (`"namespace"`), or both (`"all"`). `ns` / `boot` are the placeholders for the
 * namespace id and the bootstrap group's Entra object id (nullable); `ns` is only referenced when
 * the namespace's admins are included. Shared so the web (eligibility, the picker, notifications)
 * and the worker sweep can never disagree on who is a reviewer.
 */
export function reviewerIdsSql(opts: { who: "all" | "namespace" | "platform"; ns?: string; boot: string }): string {
  const parts: string[] = [];
  if (opts.who !== "platform") {
    if (!opts.ns) throw new Error("reviewerIdsSql: the namespace placeholder is required");
    parts.push(
      `select gm.user_id from role_mappings rm join group_memberships gm on gm.group_id = rm.group_id
        where rm.role = 'namespace_admin' and rm.namespace_id = ${opts.ns}`,
    );
  }
  if (opts.who !== "namespace") {
    parts.push(
      `select gm.user_id from role_mappings rm join group_memberships gm on gm.group_id = rm.group_id
        where rm.role = 'platform_admin'`,
      `select gm.user_id from groups g join group_memberships gm on gm.group_id = g.id
        where ${opts.boot}::text is not null and g.entra_object_id = ${opts.boot}`,
    );
  }
  return `select u.id from users u
           where u.status = 'active' and u.erased_at is null
             and u.id in (${parts.join(" union ")})`;
}

// ── Notifications (§65.8) ─────────────────────────────────────────────────────────────────────

export const REVIEW_ASSIGNED = "proposal.assigned";
export const REVIEW_OVERDUE = "proposal.review_overdue";
export const REVIEW_ESCALATED = "proposal.review_escalated";
export const REVIEW_CHANGES_REMINDER = "proposal.changes_reminder";

/** The three reminder types the sweep folds per recipient, type and namespace (§65.4). */
export const REVIEW_REMINDER_TYPES = [REVIEW_OVERDUE, REVIEW_ESCALATED, REVIEW_CHANGES_REMINDER] as const;

export interface ReviewNotificationContent {
  sentence: string;
  ctaLabel: string;
  path: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * The §65.8 wording of the four review-assignment notifications, shared by the in-app inbox, the
 * email renderer and the digest. Payloads: `proposal.assigned` carries `{ proposalId, ns, slug,
 * byName }` or, for a whole import, `{ importId, ns, repo, count, byName }`; the reminders carry
 * `{ ns, days, count, proposalIds, slug }` (`slug` = the first proposal's, used when `count` is 1).
 * Null for any other type.
 */
export function reviewNotificationContent(type: string, payload: Record<string, unknown>): ReviewNotificationContent | null {
  const ns = str(payload.ns) ?? "a namespace";
  const slug = str(payload.slug);
  const target = slug ? `${ns}/${slug}` : ns;
  const by = str(payload.byName) ?? "Someone";
  const count = typeof payload.count === "number" ? payload.count : 1;
  const days = typeof payload.days === "number" ? payload.days : null;
  const daysText = days == null ? "" : ` of ${days} business day${days === 1 ? "" : "s"}`;
  const ids = Array.isArray(payload.proposalIds) ? payload.proposalIds.filter((x): x is string => typeof x === "string") : [];
  const firstId = str(payload.proposalId) ?? ids[0] ?? null;
  const one = count <= 1 && firstId != null;
  const enc = encodeURIComponent;

  if (type === REVIEW_ASSIGNED) {
    const importId = str(payload.importId);
    if (importId) {
      const repo = str(payload.repo) ?? "a repository";
      return {
        sentence: `${by} assigned you ${count} proposal${count === 1 ? "" : "s"} imported from ${repo} into ${ns}.`,
        ctaLabel: count === 1 ? "Review it" : "Review them",
        path: `/proposals?tab=review&import=${enc(importId)}&assignee=me`,
      };
    }
    return {
      sentence: `${by} assigned you the proposal for ${target}.`,
      ctaLabel: "Review it",
      path: firstId ? `/proposals/${enc(firstId)}` : "/proposals?tab=review&assignee=me",
    };
  }
  if (type === REVIEW_OVERDUE || type === REVIEW_ESCALATED) {
    const escalated = type === REVIEW_ESCALATED;
    const sentence = one
      ? escalated
        ? `The proposal for ${target} has waited twice ${ns}'s review target${daysText}.`
        : `The proposal for ${target} is past ${ns}'s review target${daysText}.`
      : escalated
        ? `${count} proposals in ${ns} have waited twice the review target${daysText}.`
        : `${count} proposals are past ${ns}'s review target${daysText}.`;
    return {
      sentence,
      ctaLabel: one ? "Review it" : "Review them",
      path: one ? `/proposals/${enc(firstId!)}` : `/proposals?tab=review&ns=${enc(ns)}&overdue=1`,
    };
  }
  if (type === REVIEW_CHANGES_REMINDER) {
    return one
      ? {
          sentence: `Your proposal for ${target} is still waiting on the changes the reviewer asked for.`,
          ctaLabel: "Update it",
          path: `/proposals/${enc(firstId!)}`,
        }
      : {
          sentence: `${count} of your proposals in ${ns} are still waiting on your changes.`,
          ctaLabel: "View them",
          path: "/proposals?tab=mine&states=changes_requested",
        };
  }
  return null;
}
