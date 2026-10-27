// Feature ideas (SKILLY_SPEC.md §60) — the SINGLE SOURCE OF TRUTH for the limits, the status and
// outcome enums, the validators, who may suggest, the "Coming soon" order, the live list's pure steps
// and the notification wording. The web routes, the What's new page, the admin page and the worker email renderer all
// read it, so they can never disagree. Client-safe (no node deps); subpath export `@skilly/shared/ideas`.

// ── Limits (§60.2, §60.4) ──────────────────────────────────────────────────────────────────────

export const IDEA_DESCRIPTION_MIN = 20;
export const IDEA_DESCRIPTION_MAX = 1000;
export const IDEA_TITLE_MIN = 3;
export const IDEA_TITLE_MAX = 80;
/** A rejection reason or a closing note. */
export const IDEA_NOTE_MAX = 500;
/** Ideas awaiting review per author. */
export const IDEA_PENDING_MAX = 3;
/** Submissions per author per rolling 24 h, withdrawn ones included. */
export const IDEA_DAILY_MAX = 5;
export const IDEA_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** "Your ideas" shows at most this many, newest first. */
export const IDEA_MINE_LIMIT = 20;
/** The admin Closed tab's page size. */
export const IDEA_ADMIN_PAGE = 50;
/** A rejected idea's notification quotes this much of the description. */
export const IDEA_EXCERPT_MAX = 140;

// ── Who may suggest (§60.4) ────────────────────────────────────────────────────────────────────

/** Platform admins always; everyone else only while `feature_ideas_enabled` is on (§60.1 decision 12). */
export function maySuggestIdea(viewer: { isPlatformAdmin: boolean }, featureIdeasEnabled: boolean): boolean {
  return viewer.isPlatformAdmin || featureIdeasEnabled;
}

// ── Status and outcome ─────────────────────────────────────────────────────────────────────────

export type IdeaStatus = "pending" | "published" | "rejected" | "closed" | "withdrawn";

/** Every outcome a closed row can carry. `planned` survives only on rows closed before v2.41.0. */
export const IDEA_OUTCOMES = ["planned", "shipped", "duplicate", "wont_do"] as const;
export type IdeaOutcome = (typeof IDEA_OUTCOMES)[number];

/** The outcomes a close accepts now (§60.1 decision 3): being on the list already means "planned". */
export const IDEA_CLOSE_OUTCOMES = ["shipped", "duplicate", "wont_do"] as const;
export type IdeaCloseOutcome = (typeof IDEA_CLOSE_OUTCOMES)[number];

export function isIdeaCloseOutcome(v: unknown): v is IdeaCloseOutcome {
  return typeof v === "string" && (IDEA_CLOSE_OUTCOMES as readonly string[]).includes(v);
}

export const IDEA_OUTCOME_LABELS: Record<IdeaOutcome, string> = {
  planned: "Planned",
  shipped: "Shipped",
  duplicate: "Duplicate",
  wont_do: "Won't do",
};

export function isIdeaOutcome(v: unknown): v is IdeaOutcome {
  return typeof v === "string" && (IDEA_OUTCOMES as readonly string[]).includes(v);
}

// ── Validation ─────────────────────────────────────────────────────────────────────────────────

export type TextValidation = { ok: true; value: string } | { ok: false; error: string };

/**
 * Length in characters (code points), as the database's `char_length` counts it — never `.length`,
 * which counts UTF-16 units, so an emoji would count twice and slip past the database's bounds.
 */
export function ideaTextLength(text: string): number {
  return Array.from(text).length;
}

/** Trimmed, with Windows/old-Mac line endings folded to `\n`. Plain text: nothing else changes. */
export function normalizeIdeaText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").trim();
}

export function validateIdeaDescription(raw: unknown): TextValidation {
  if (typeof raw !== "string") return { ok: false, error: "description is required" };
  const value = normalizeIdeaText(raw);
  const n = ideaTextLength(value);
  if (n < IDEA_DESCRIPTION_MIN) return { ok: false, error: `description must be at least ${IDEA_DESCRIPTION_MIN} characters` };
  if (n > IDEA_DESCRIPTION_MAX) return { ok: false, error: `description must be at most ${IDEA_DESCRIPTION_MAX} characters` };
  return { ok: true, value };
}

/** One line: whitespace runs (line breaks included) collapse to a single space. */
export function validateIdeaTitle(raw: unknown): TextValidation {
  if (typeof raw !== "string") return { ok: false, error: "title is required" };
  const value = raw.replace(/\s+/g, " ").trim();
  const n = ideaTextLength(value);
  if (n < IDEA_TITLE_MIN) return { ok: false, error: `title must be at least ${IDEA_TITLE_MIN} characters` };
  if (n > IDEA_TITLE_MAX) return { ok: false, error: `title must be at most ${IDEA_TITLE_MAX} characters` };
  return { ok: true, value };
}

/** Optional: absent or blank → null. */
export function validateIdeaNote(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "note must be text" };
  const value = normalizeIdeaText(raw);
  if (ideaTextLength(value) > IDEA_NOTE_MAX) return { ok: false, error: `note must be at most ${IDEA_NOTE_MAX} characters` };
  return { ok: true, value: value || null };
}

// ── Submission caps (§60.4) ────────────────────────────────────────────────────────────────────

export type IdeaLimitRefusal = "pending_limit" | "daily_limit";

/** Which cap a new submission would break, the pending cap first; null = it may go in. */
export function ideaLimitRefusal(counts: { pending: number; today: number }): IdeaLimitRefusal | null {
  if (counts.pending >= IDEA_PENDING_MAX) return "pending_limit";
  if (counts.today >= IDEA_DAILY_MAX) return "daily_limit";
  return null;
}

/** Whole seconds (≥ 1) until the oldest submission in the window leaves it. */
export function dailyRetryAfterSeconds(oldestInWindow: Date, now: Date = new Date()): number {
  return Math.max(1, Math.ceil((oldestInWindow.getTime() + IDEA_DAILY_WINDOW_MS - now.getTime()) / 1000));
}

export const IDEA_LIMIT_MESSAGES: Record<IdeaLimitRefusal, string> = {
  pending_limit: `You have ${IDEA_PENDING_MAX} ideas waiting for review. Wait for a decision, or withdraw one.`,
  daily_limit: `You've suggested ${IDEA_DAILY_MAX} features in the last 24 hours. Try again later.`,
};

// ── The Coming soon list (§60.3) ───────────────────────────────────────────────────────────────

/** How often an expanded, visible list re-fetches itself (§60.3 decision 18). Fixed, not a setting. */
export const COMING_SOON_POLL_MS = 15_000;
/** Bubbles in a row's "Upvoted by" strip before the "+N" chip (§60.3 decision 19). */
export const VOTER_STRIP_MAX = 5;
/** Lines in the "Upvoted by" list before "and N more". */
export const VOTER_LIST_MAX = 100;
/** A vote button ignores clicks this long after its row moved, so a second click can't land on a row that slid under the pointer. */
export const VOTE_MOVE_GUARD_MS = 400;

/**
 * One listed voter (§60.3): someone who did not hide their votes, or the viewer themself, who is
 * always listed and marked `onlyYou` while they hide their votes from everyone else.
 */
export interface ComingSoonVoter {
  id: string;
  displayName: string;
  avatar: string | null;
  onlyYou?: true;
}

/** One published item: every Coming soon row is a `feature_ideas` row (§60.1 decision 1). */
export interface ComingSoonItem {
  id: string;
  title: string;
  description: string;
  votes: number;
  voted: boolean;
  /** Null when the proposer opted out, was erased, or there is none (the items migration 0101 seeded). */
  suggestedBy: { id: string; displayName: string; avatar: string | null } | null;
  publishedAt: string;
  /** The strip: the first `VOTER_STRIP_MAX` listed voters, newest vote first. */
  voters: ComingSoonVoter[];
  /** Every listed voter for this viewer; hidden voters count only in `votes`. */
  votersTotal: number;
}

/** §60.1 decision 2: most votes first. Ties: newest published first, then id. */
export function comingSoonOrder(items: readonly ComingSoonItem[]): ComingSoonItem[] {
  const ranked = items.map((item) => ({ item, at: Date.parse(item.publishedAt) || 0 }));
  ranked.sort(
    (a, b) =>
      b.item.votes - a.item.votes ||
      b.at - a.at ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );
  return ranked.map((r) => r.item);
}

// ── The live list (§60.3 decisions 18 and 19) ──────────────────────────────────────────────────

/**
 * The caller's vote, applied optimistically: the count, the ▲ state and their own bubble, which goes
 * first in the strip (theirs is now the newest vote), marked `onlyYou` while they hide their votes.
 * The viewer is always listed to themself while they have voted, so the listed total moves with
 * the vote. Without `me` (not loaded yet) only the count and the ▲ change; the vote route's answer
 * settles the strip. Re-sort the list with `comingSoonOrder` afterwards.
 */
export function applyOwnVote(
  item: ComingSoonItem,
  on: boolean,
  me: { id: string; displayName: string; avatar: string | null } | null,
  votesHidden: boolean,
): ComingSoonItem {
  if (item.voted === on) return item;
  const votes = Math.max(0, item.votes + (on ? 1 : -1));
  if (!me) return { ...item, votes, voted: on };
  const others = item.voters.filter((v) => v.id !== me.id);
  if (!on) return { ...item, votes, voted: false, voters: others, votersTotal: Math.max(0, item.votersTotal - 1) };
  const self: ComingSoonVoter = votesHidden ? { ...me, onlyYou: true } : { ...me };
  return { ...item, votes, voted: true, voters: [self, ...others].slice(0, VOTER_STRIP_MAX), votersTotal: item.votersTotal + 1 };
}

/**
 * A poll answer may replace the list only if nothing of the caller's moved since it was asked for:
 * no vote started after the request (`voteSeqAtRequest` is the counter then), and none in flight.
 * Otherwise it is dropped and the next poll catches up.
 */
export function pollAnswerApplies(voteSeqAtRequest: number, voteSeqNow: number, votesInFlight: number): boolean {
  return voteSeqAtRequest === voteSeqNow && votesInFlight === 0;
}

/** "Upvoted by Ana, Ben, you (only you see this) and 12 others": the strip button's accessible name. */
export function upvotedByLabel(voters: readonly ComingSoonVoter[], votersTotal: number, viewerId: string | null): string {
  const names = voters.map((v) => (v.id === viewerId ? (v.onlyYou ? "you (only you see this)" : "you") : v.displayName));
  const rest = Math.max(0, votersTotal - voters.length);
  if (rest > 0) return `Upvoted by ${names.join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
  if (names.length <= 1) return `Upvoted by ${names.join("")}`;
  return `Upvoted by ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The polite announcement once the caller's own vote settles: where the item now stands. */
export function ownVoteAnnouncement(on: boolean, title: string, votes: number, position: number, of: number): string {
  const count = `${votes} ${votes === 1 ? "vote" : "votes"}, now number ${position} of ${of}.`;
  return on ? `Upvoted ${title}: ${count}` : `Removed your upvote from ${title}: ${count}`;
}

// ── Notifications (§60.7) ──────────────────────────────────────────────────────────────────────

export const IDEA_NOTIFICATION_TYPES = ["idea.submitted", "idea.published", "idea.rejected", "idea.closed", "idea.shipped"] as const;

export function isIdeaNotificationType(type: string): boolean {
  return (IDEA_NOTIFICATION_TYPES as readonly string[]).includes(type);
}

/** The first `max` characters of a description, on one line, with an ellipsis when cut. */
export function ideaExcerpt(text: string, max: number = IDEA_EXCERPT_MAX): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : chars.join("");
}

export interface IdeaNotificationContent {
  sentence: string;
  /** A second line: the reason, the note or the excerpt. */
  detail: string | null;
  ctaLabel: string;
  path: string;
}

/**
 * The §60.7 wording of an `idea.*` row, shared by the in-app inbox and the worker's email renderer.
 * Payload keys: `count` (submitted), `title` (published, closed, shipped), `reason` and `excerpt`
 * (rejected), `outcome` and `adminNote` (closed). Null for any other type.
 */
export function ideaNotificationContent(type: string, payload: Record<string, unknown>): IdeaNotificationContent | null {
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const title = str(payload.title);
  const named = title ? `"${title}"` : "Your feature idea";
  switch (type) {
    case "idea.submitted": {
      const n = typeof payload.count === "number" && payload.count > 0 ? payload.count : 1;
      return {
        sentence: n === 1 ? "A new feature idea is waiting for review." : `${n} new feature ideas are waiting for review.`,
        detail: null,
        ctaLabel: "Review ideas",
        path: "/admin/ideas",
      };
    }
    case "idea.published":
      return {
        sentence: title ? `Your feature idea "${title}" is on the Coming soon list now. Everyone can upvote it.` : "Your feature idea is on the Coming soon list now. Everyone can upvote it.",
        detail: null,
        ctaLabel: "See the list",
        path: "/whats-new#coming-soon",
      };
    case "idea.rejected": {
      const reason = str(payload.reason);
      const excerpt = str(payload.excerpt);
      return {
        sentence: `Your feature idea wasn't published. ${reason ? `Reason: ${reason}` : "No reason was given."}`,
        detail: excerpt ? `"${excerpt}"` : null,
        ctaLabel: "Your ideas",
        path: "/whats-new#your-ideas",
      };
    }
    case "idea.closed": {
      const outcome = isIdeaOutcome(payload.outcome) ? IDEA_OUTCOME_LABELS[payload.outcome] : "closed";
      return {
        sentence: `${named === "Your feature idea" ? named : `Your feature idea ${named}`} was closed: ${outcome}.`,
        detail: str(payload.adminNote),
        ctaLabel: "Your ideas",
        path: "/whats-new#your-ideas",
      };
    }
    case "idea.shipped":
      return {
        sentence: title ? `A feature you suggested has shipped: "${title}" is now part of skilly.` : "A feature you suggested has shipped.",
        detail: null,
        ctaLabel: "What's new",
        path: "/whats-new",
      };
    default:
      return null;
  }
}
