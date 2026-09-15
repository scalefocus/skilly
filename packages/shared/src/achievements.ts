// Achievements — the badge catalog and the pure rules behind it (SKILLY_SPEC.md §31).
// Client-safe (subpath export `@skilly/shared/achievements`): the profile card, the hall page and
// the notification renderer import the catalog from here; the server imports the evaluators.
// Keys are stable identifiers — renaming a badge never changes its key (§31.1).

export type AchievementGroup = "Consume" | "Ask" | "Contribute" | "Talk" | "Explore" | "Habits";

export interface AchievementDef {
  key: string;
  name: string;
  /** One line shown on an earned tile and in the notification body. */
  blurb: string;
  /** The exploration hint shown on a LOCKED tile (owner only). */
  howToEarn: string;
  /** Emoji glyph, rendered in a coloured circle (the leader-badge visual language, §21). */
  glyph: string;
  group: AchievementGroup;
}

export const ACHIEVEMENT_GROUPS: AchievementGroup[] = ["Consume", "Ask", "Contribute", "Talk", "Explore", "Habits"];

/** Catalog order is display order (§31.5). */
export const ACHIEVEMENTS: AchievementDef[] = [
  // Consume
  { key: "first_install", name: "Hello, Skill", blurb: "You brought your first skill home.", howToEarn: "Install a skill — clone it, download it, or read it over MCP.", glyph: "👋", group: "Consume" },
  { key: "first_marketplace", name: "Bulk Buyer", blurb: "Why take one skill when you can take a whole marketplace?", howToEarn: "Add a Claude plugin marketplace and let Claude Code fetch it.", glyph: "🛒", group: "Consume" },
  { key: "first_mcp", name: "Ghost in the Machine", blurb: "An agent spoke to skilly on your behalf.", howToEarn: "Connect an MCP client and let it make its first tool call.", glyph: "👻", group: "Consume" },
  { key: "triple_threat", name: "Three Doors Down", blurb: "Install, marketplace and MCP — you have used every door.", howToEarn: "Earn Hello, Skill, Bulk Buyer and Ghost in the Machine.", glyph: "🚪", group: "Consume" },
  // Ask
  { key: "first_request", name: "Wishful Thinker", blurb: "You asked the org for a skill that did not exist yet.", howToEarn: "Post a skill request from the Propose page (\"I want a skill\").", glyph: "🌠", group: "Ask" },
  { key: "request_fulfilled", name: "Wish Granted", blurb: "Someone built the skill you asked for.", howToEarn: "Post a request and wait for a colleague to fulfil it.", glyph: "🎁", group: "Ask" },
  // Contribute
  { key: "first_fulfilment", name: "Genie", blurb: "You granted someone else's wish.", howToEarn: "Fulfil another person's skill request.", glyph: "🧞", group: "Contribute" },
  { key: "first_hosted_proposal", name: "Homegrown", blurb: "You proposed a skill built and hosted right here.", howToEarn: "Propose a hosted skill (upload a bundle).", glyph: "🌱", group: "Contribute" },
  { key: "first_pointer_proposal", name: "Finger Pointer", blurb: "You pointed skilly at a skill living elsewhere.", howToEarn: "Propose a pointer skill (an external git source).", glyph: "👉", group: "Contribute" },
  { key: "first_published", name: "Shipped It", blurb: "A version you submitted went live in the catalog.", howToEarn: "Get a proposal accepted and published.", glyph: "🚀", group: "Contribute" },
  { key: "first_new_version", name: "Sequel", blurb: "You published a follow-up version of a skill.", howToEarn: "Publish a new version of a skill that already has one.", glyph: "🎬", group: "Contribute" },
  { key: "maintainer_added", name: "Adopted", blurb: "Someone trusted you with a skill they created.", howToEarn: "Be added as a maintainer of a skill you did not propose.", glyph: "🤝", group: "Contribute" },
  // Talk
  { key: "first_message", name: "Icebreaker", blurb: "You said something. It counts.", howToEarn: "Send a message — a direct chat, a review thread, a request or skill discussion.", glyph: "🧊", group: "Talk" },
  { key: "first_reply", name: "Conversationalist", blurb: "You joined a conversation someone else started.", howToEarn: "Reply in a thread that another person opened.", glyph: "💬", group: "Talk" },
  { key: "first_mention", name: "Name Dropper", blurb: "You @mentioned a person or #mentioned a skill.", howToEarn: "Use @person or #skill in a message.", glyph: "📣", group: "Talk" },
  // Explore
  { key: "first_watch", name: "Stalker, but Nicely", blurb: "You are keeping an eye on a skill.", howToEarn: "Watch a skill to be told about new versions.", glyph: "👀", group: "Explore" },
  { key: "first_rating", name: "Critic", blurb: "You told the org what a skill is worth.", howToEarn: "Rate a skill on its page.", glyph: "⭐", group: "Explore" },
  { key: "onboarded", name: "Read the Manual", blurb: "You actually read Quick start. Respect.", howToEarn: "Complete the Quick start guide.", glyph: "📖", group: "Explore" },
  // Habits
  { key: "night_shift", name: "Night Shift", blurb: "Skilly at an hour when sensible people sleep.", howToEarn: "Do anything badge-worthy between midnight and 5 am, your time.", glyph: "🦉", group: "Habits" },
  { key: "weekend_warrior", name: "Weekend Warrior", blurb: "Saturday or Sunday, and here you are.", howToEarn: "Do anything badge-worthy on a weekend, your time.", glyph: "🏕️", group: "Habits" },
];

export const ACHIEVEMENT_KEYS: string[] = ACHIEVEMENTS.map((a) => a.key);
const BY_KEY = new Map(ACHIEVEMENTS.map((a) => [a.key, a]));

export function achievementDef(key: string): AchievementDef | undefined {
  return BY_KEY.get(key);
}

export function isAchievementKey(key: unknown): key is string {
  return typeof key === "string" && BY_KEY.has(key);
}

/** The three consumption-channel badges whose union earns `triple_threat` (§31.1). */
export const TRIPLE_THREAT_PARTS = ["first_install", "first_marketplace", "first_mcp"] as const;

/** `triple_threat` is due when every part is held (§31.2 combo rule). */
export function tripleThreatDue(held: Iterable<string>): boolean {
  const s = new Set(held);
  return TRIPLE_THREAT_PARTS.every((k) => s.has(k));
}

/**
 * Validate a browser-reported IANA timezone (§31.3). Returns the canonical string or null when the
 * value is not a string, is over-long, or `Intl` refuses it. Never throws.
 */
export function validateTimeZone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 64) return null;
  try {
    // Intl.DateTimeFormat throws RangeError on an unknown zone; resolvedOptions canonicalises case.
    return new Intl.DateTimeFormat("en-US", { timeZone: s }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

interface LocalParts { hour: number; weekday: number /* 0 = Sunday … 6 = Saturday */ }

/** The wall-clock hour and weekday of an instant in a zone, via Intl (DST-safe). Null on a bad zone. */
export function localParts(at: Date, timeZone: string): LocalParts | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23", weekday: "short" });
    const parts = fmt.formatToParts(at);
    const hourStr = parts.find((p) => p.type === "hour")?.value;
    const wd = parts.find((p) => p.type === "weekday")?.value;
    if (hourStr == null || wd == null) return null;
    const hour = Number(hourStr) % 24; // some engines emit "24" for midnight under h23 quirks
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
    if (!Number.isInteger(hour) || weekday < 0) return null;
    return { hour, weekday };
  } catch {
    return null;
  }
}

/** Night Shift: local hour 0–4 (00:00:00 through 04:59:59). False for a null/invalid zone. */
export function isNightShift(at: Date, timeZone: string | null | undefined): boolean {
  if (!timeZone) return false;
  const p = localParts(at, timeZone);
  return !!p && p.hour >= 0 && p.hour < 5;
}

/** Weekend Warrior: local weekday Saturday or Sunday. False for a null/invalid zone. */
export function isWeekend(at: Date, timeZone: string | null | undefined): boolean {
  if (!timeZone) return false;
  const p = localParts(at, timeZone);
  return !!p && (p.weekday === 0 || p.weekday === 6);
}

/** The Habits keys an event at `at` earns for a user in `timeZone` (§31.3). */
export function habitKeysFor(at: Date, timeZone: string | null | undefined): string[] {
  const out: string[] = [];
  if (isNightShift(at, timeZone)) out.push("night_shift");
  if (isWeekend(at, timeZone)) out.push("weekend_warrior");
  return out;
}
