// Visit frequency and new users (SKILLY_SPEC.md §66). Pure and client-safe: the server classifies a
// person's recent visit days into one coarse label for the directory hover card (§28), and the
// browser maps that label to its copy. Day counts and dates never leave the server — only the label.
//
// All days are UTC calendar days as `YYYY-MM-DD` strings (the shape Postgres `date::text` returns),
// which compare correctly as plain strings.

/** The trailing window Visits looks at, in UTC days (§66.1 decision 1). */
export const VISIT_WINDOW_DAYS = 28;
/** Fewer observed days than this and the Visits row stays hidden (§66.1 decision 3). */
export const VISIT_MIN_OBSERVED_DAYS = 7;
/** Someone counts as a New user for this many days after their first visit (§66.1 decision 5). */
export const NEW_USER_DAYS = 30;

export const VISIT_FREQUENCIES = ["daily", "weekly", "monthly", "rare", "never"] as const;
export type VisitFrequency = (typeof VISIT_FREQUENCIES)[number];

/** The card copy for each frequency (§66.2). */
export const VISIT_LABELS: Record<VisitFrequency, string> = {
  daily: "Once a day",
  weekly: "Once a week",
  monthly: "Once a month",
  rare: "In a blue moon",
  never: "Never",
};

export function isVisitFrequency(v: unknown): v is VisitFrequency {
  return typeof v === "string" && (VISIT_FREQUENCIES as readonly string[]).includes(v);
}

/** The card label for a frequency, or null when there is nothing to show. */
export function visitLabel(f: VisitFrequency | null | undefined): string | null {
  return f && isVisitFrequency(f) ? VISIT_LABELS[f] : null;
}

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A Date (or ISO timestamp) as its UTC calendar day, `YYYY-MM-DD`. */
export function utcDay(d: Date | string): string {
  if (typeof d === "string" && ISO_DAY.test(d)) return d;
  return new Date(d).toISOString().slice(0, 10);
}

/** Days since the epoch for a `YYYY-MM-DD` UTC day — integer arithmetic for the window. */
function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

function fromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export interface VisitWindow {
  /** The first UTC day the window counts (inclusive). */
  start: string;
  /** Days observed, today included: 1 … VISIT_WINDOW_DAYS. */
  observed: number;
}

/**
 * The window §66.2 counts over: it starts at the latest of the day collection began
 * (`visits_since`), the person's first visit, and `today − 27`. Null for someone who has never
 * visited. A missing `visitsSince` (no setting row) simply drops that floor.
 */
export function visitWindow(input: { firstSeen: Date | string | null; visitsSince: string | null; today: string }): VisitWindow | null {
  if (input.firstSeen == null) return null;
  const today = dayNumber(input.today);
  const floors = [today - (VISIT_WINDOW_DAYS - 1), dayNumber(utcDay(input.firstSeen))];
  if (input.visitsSince && ISO_DAY.test(input.visitsSince)) floors.push(dayNumber(input.visitsSince));
  // A first visit stamped "after today" (clock skew between replicas and the DB) still observes
  // today, never zero or negative days.
  const start = Math.min(today, Math.max(...floors));
  return { start: fromDayNumber(start), observed: today - start + 1 };
}

/**
 * The person's visit frequency (§66.2), or null when the row must stay hidden because fewer than
 * VISIT_MIN_OBSERVED_DAYS have been observed. `activeDays` may hold days outside the window (the
 * caller passes the last 28 days); only days on or after the window's start count, and duplicates
 * count once.
 *
 * Integer arithmetic only, so every boundary is exact: with a full 28-day window that is 15–28
 * active days → daily, 4–14 → weekly, 1–3 → monthly, 0 → rare.
 */
export function classifyVisits(input: {
  firstSeen: Date | string | null;
  visitsSince: string | null;
  today: string;
  activeDays: readonly string[];
}): VisitFrequency | null {
  const w = visitWindow(input);
  if (!w) return "never";
  if (w.observed < VISIT_MIN_OBSERVED_DAYS) return null;
  const active = new Set(input.activeDays.filter((d) => d >= w.start && d <= input.today)).size;
  if (active * VISIT_WINDOW_DAYS >= w.observed * 15) return "daily";
  if (active * VISIT_WINDOW_DAYS >= w.observed * 4) return "weekly";
  if (active >= 1) return "monthly";
  return "rare";
}

/** First visit within the last NEW_USER_DAYS days (§66.3). Status, opt-out and the platform switch
 *  are the caller's to check. */
export function isNewUser(firstSeen: Date | string | null, now: Date = new Date()): boolean {
  if (firstSeen == null) return false;
  return new Date(firstSeen).getTime() > now.getTime() - NEW_USER_DAYS * DAY_MS;
}
