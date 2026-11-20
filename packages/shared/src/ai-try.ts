// Try a skill before installing (SKILLY_SPEC.md §61): the client-safe half — the feature key, the
// admin-adjustable limits (§40.18: defaults, ranges, resolution, validation and the worst-case
// estimate), the panel's shapes and the transcript validation both the panel (before sending) and
// the route (before calling the provider) run. No node, no I/O: exported via
// "@skilly/shared/ai-try" for client components, and from the server barrel. The input selection
// and the system prompt live in ai-try-run.ts; the I/O in the web tier.

/** The §40.7 feature key (registered in AI_FEATURES). */
export const AI_TRY_FEATURE = "skill_try";
/** Output-token ceiling per reply (§61.4) — the registry default. */
export const AI_TRY_MAX_TOKENS = 8192;
/** The registered per-attempt timeout (§61.4); admin-tunable (§40.15). */
export const AI_TRY_TIMEOUT_MS = 120_000;
/** The skill content sent with every message: §46's selection with this lower total (§61.4). */
export const AI_TRY_TOTAL_MAX_CHARS = 100_000;
/** The rolling window of the daily cap (§61.7) — fixed, not adjustable (§40.18). */
export const AI_TRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The panel shows "N of 20 messages left in this conversation" once this many or fewer remain (§61.3). */
export const AI_TRY_TURNS_WARN = 5;
/** The composer's counter appears once this many characters or fewer remain (§61.3). */
export const AI_TRY_COUNTER_WITHIN = 500;

// ── The five admin-adjustable limits (§40.18) ────────────────────────────────────────────────

/** The limits in force: the code defaults with the platform admin's overrides applied. */
export interface TryLimits {
  /** Messages one person may send in any rolling 24 hours, across all skills. */
  dailyCap: number;
  /** Messages one person may send in a minute, counted per web instance. */
  perMinute: number;
  /** User messages in one conversation. */
  maxTurns: number;
  /** The length of one typed message. */
  maxMessageChars: number;
  /** The messages and replies of one conversation together. */
  maxTranscriptChars: number;
}

export type TryLimitKey = keyof TryLimits;

/** Field order on the Administration card and in every listing. */
export const AI_TRY_LIMIT_KEYS: readonly TryLimitKey[] = ["dailyCap", "perMinute", "maxTurns", "maxMessageChars", "maxTranscriptChars"];

/** The limits Try shipped with (§61.7); what applies while nothing is overridden. */
export const AI_TRY_LIMIT_DEFAULTS: Readonly<TryLimits> = {
  dailyCap: 100,
  perMinute: 10,
  maxTurns: 20,
  maxMessageChars: 4000,
  maxTranscriptChars: 200_000,
};

/**
 * The admin range of each limit (§40.18). The smallest conversation total still holds the largest
 * message, so every combination is valid; the largest conversation plus the skill stays inside a
 * 200,000-token context window.
 */
export const AI_TRY_LIMIT_RANGES: Readonly<Record<TryLimitKey, { min: number; max: number }>> = {
  dailyCap: { min: 1, max: 1000 },
  perMinute: { min: 1, max: 60 },
  maxTurns: { min: 1, max: 100 },
  maxMessageChars: { min: 500, max: 20_000 },
  maxTranscriptChars: { min: 20_000, max: 400_000 },
};

/** The field labels of the Try limits row (§40.18). */
export const AI_TRY_LIMIT_LABELS: Readonly<Record<TryLimitKey, string>> = {
  dailyCap: "Messages per person per day",
  perMinute: "Messages per person per minute",
  maxTurns: "Messages per conversation",
  maxMessageChars: "Characters per message",
  maxTranscriptChars: "Characters per conversation",
};

/** The platform_settings key holding the overrides (§40.18). */
export const AI_TRY_LIMITS_SETTING = "ai_try_limits";

/** Only the limits a platform admin changed; an absent key means the default. */
export type TryLimitOverrides = Partial<TryLimits>;

/**
 * The stored `ai_try_limits` setting as served: an unknown key is dropped, a value that is not a
 * whole number is ignored (the default applies) and one outside its range is clamped into it, so a
 * hand-edited row can never switch Try off or lift a limit.
 */
export function parseTryLimitOverrides(stored: unknown): TryLimitOverrides {
  const out: TryLimitOverrides = {};
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return out;
  for (const key of AI_TRY_LIMIT_KEYS) {
    const v = (stored as Record<string, unknown>)[key];
    if (typeof v !== "number" || !Number.isInteger(v)) continue;
    const { min, max } = AI_TRY_LIMIT_RANGES[key];
    out[key] = Math.min(max, Math.max(min, v));
  }
  return out;
}

/** The five limits in force for a stored setting (or its parsed overrides). */
export function resolveTryLimits(stored: unknown): TryLimits {
  return { ...AI_TRY_LIMIT_DEFAULTS, ...parseTryLimitOverrides(stored) };
}

export function tryLimitOverridesEmpty(o: TryLimitOverrides): boolean {
  return AI_TRY_LIMIT_KEYS.every((k) => o[k] === undefined);
}

/** Default / override / effective and the admin range of one limit — what the card shows. */
export interface TryLimitView {
  default: number;
  override: number | null;
  effective: number;
  min: number;
  max: number;
}
export type TryLimitsView = Record<TryLimitKey, TryLimitView>;

export function tryLimitsView(overrides: TryLimitOverrides): TryLimitsView {
  const view = {} as TryLimitsView;
  for (const key of AI_TRY_LIMIT_KEYS) {
    const override = overrides[key] ?? null;
    view[key] = { default: AI_TRY_LIMIT_DEFAULTS[key], override, effective: override ?? AI_TRY_LIMIT_DEFAULTS[key], ...AI_TRY_LIMIT_RANGES[key] };
  }
  return view;
}

export type TryLimitsValidation = { ok: true; value: TryLimitOverrides } | { ok: false; field: TryLimitKey | "body"; error: string };

/**
 * Validate a `PUT /api/admin/ai/try-limits` body: all five keys, each a whole number inside its
 * range or `null` for the default. Returns the overrides to store (nulls left out).
 */
export function validateTryLimitsInput(raw: unknown): TryLimitsValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, field: "body", error: "send the five limits, each a whole number or null for the default" };
  }
  const value: TryLimitOverrides = {};
  for (const key of AI_TRY_LIMIT_KEYS) {
    if (!(key in raw)) return { ok: false, field: key, error: "is required (a whole number, or null for the default)" };
    const v = (raw as Record<string, unknown>)[key];
    if (v === null) continue;
    if (typeof v !== "number" || !Number.isInteger(v)) return { ok: false, field: key, error: "must be a whole number" };
    const { min, max } = AI_TRY_LIMIT_RANGES[key];
    if (v < min || v > max) return { ok: false, field: key, error: `must be between ${min} and ${max}` };
    value[key] = v;
  }
  return { ok: true, value };
}

/**
 * The worst case the Try limits row shows (§40.18): input tokens one person can send in a day when
 * every message carries a full skill and a full conversation, at 4 characters per token.
 */
export function tryWorstCaseInputTokens(limits: Pick<TryLimits, "dailyCap" | "maxTranscriptChars">): number {
  return Math.round((limits.dailyCap * (AI_TRY_TOTAL_MAX_CHARS + limits.maxTranscriptChars)) / 4);
}

/**
 * A worst-case token count as the row words it: "7.5 million" (one decimal below 10 million),
 * "125 million" (whole millions from 10 million) or, below one million, the nearest thousand
 * ("30,000").
 */
export function formatTryWorstCase(tokens: number): string {
  const thousands = Math.round(tokens / 1000) * 1000;
  if (thousands < 1_000_000) return thousands.toLocaleString("en-US");
  const millions = Math.round(tokens / 100_000) / 10;
  return `${millions >= 10 ? Math.round(tokens / 1_000_000) : millions} million`;
}

// ── What the panel receives (§61.6) ──────────────────────────────────────────────────────────

/** The per-conversation limits in force; the panel enforces them before sending. */
export type TryPanelLimits = Pick<TryLimits, "maxTurns" | "maxMessageChars" | "maxTranscriptChars">;

export function tryPanelLimits(l: TryLimits): TryPanelLimits {
  return { maxTurns: l.maxTurns, maxMessageChars: l.maxMessageChars, maxTranscriptChars: l.maxTranscriptChars };
}

/** The caller's daily allowance; `retryAt` (ISO) is set only when nothing remains. */
export interface TryDaily {
  cap: number;
  remaining: number;
  retryAt: string | null;
}

/**
 * The daily allowance (§61.7) from the caller's `skill_try` usage timestamps: the cap minus the
 * calls inside the rolling window, never below 0. At 0, `retryAt` is when enough calls age out for
 * one more (the §43.7 rule), so it is right for a cap lowered below what was already sent.
 */
export function tryDailyAllowance(timestamps: readonly Date[], now: Date, cap: number): TryDaily {
  const inWindow = timestamps
    .filter((t) => now.getTime() - t.getTime() < AI_TRY_WINDOW_MS)
    .sort((a, b) => a.getTime() - b.getTime());
  const remaining = Math.max(0, cap - inWindow.length);
  if (remaining > 0) return { cap, remaining, retryAt: null };
  const pivot = inWindow[inWindow.length - cap]!;
  return { cap, remaining: 0, retryAt: new Date(pivot.getTime() + AI_TRY_WINDOW_MS).toISOString() };
}

export type TryRole = "user" | "assistant";
export interface TryMessage {
  role: TryRole;
  content: string;
}

/** What happened to each candidate file (§61.3's "Loaded …" line). */
export type TryFileState = "loaded" | "truncated" | "skipped";
export interface TryFile {
  path: string;
  state: TryFileState;
}

export type TryContentCheck = "pending" | "passed" | "noted" | "flagged";

/** `GET /api/skills/:ns/:slug/try` (§61.6). */
export interface TryContext {
  semver: string;
  model: string;
  usage: string | null;
  contentCheck: TryContentCheck;
  files: TryFile[];
  /** The per-conversation limits in force (§40.18). */
  limits: TryPanelLimits;
  /** The caller's daily allowance. */
  daily: TryDaily;
}

export type TryTranscriptError = "invalid_transcript" | "conversation_full";

export type TryTranscriptResult =
  | { ok: true; messages: TryMessage[] }
  | { ok: false; error: TryTranscriptError; message: string };

/** Characters across every message, as the conversation total counts them (§61.7). */
export function tryTranscriptChars(messages: readonly TryMessage[]): number {
  return messages.reduce((n, m) => n + m.content.length, 0);
}

/** How many messages the user has sent in this conversation. */
export function tryUserTurns(messages: readonly TryMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
}

/** Whether any of these user messages is longer than the per-message limit in force. */
function hasOverlongUserMessage(messages: readonly TryMessage[], limits: TryPanelLimits): boolean {
  return messages.some((m) => m.role === "user" && m.content.length > limits.maxMessageChars);
}

const invalid = (message: string): TryTranscriptResult => ({ ok: false, error: "invalid_transcript", message });

/** The §61.9 text for a message over the per-message limit in force. */
export function tryMessageTooLong(limits: TryPanelLimits): string {
  return `A message can be at most ${limits.maxMessageChars.toLocaleString("en-US")} characters. Shorten it and send again.`;
}

/**
 * Validate a transcript about to be sent against the limits in force (§61.6 step 3), in this order:
 * its shape — a non-empty array that starts and ends with a `user` message and alternates, every
 * content non-empty after trimming (`invalid_transcript`); the conversation — at most `maxTurns`
 * user messages and `maxTranscriptChars` in total, and no earlier user message over
 * `maxMessageChars`, which a conversation can hold only after the limit was lowered
 * (`conversation_full`); then the message being sent, at most `maxMessageChars`
 * (`invalid_transcript`). Returns the messages with their content as given (not trimmed).
 */
export function validateTryTranscript(raw: unknown, limits: TryPanelLimits): TryTranscriptResult {
  if (!Array.isArray(raw) || raw.length === 0) return invalid("messages must be a non-empty array");
  const messages: TryMessage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i] as { role?: unknown; content?: unknown } | null;
    const role = m?.role;
    if (role !== "user" && role !== "assistant") return invalid(`message ${i + 1} has no valid role`);
    if (role !== (i % 2 === 0 ? "user" : "assistant")) return invalid("messages must alternate, starting with the user");
    if (typeof m?.content !== "string" || !m.content.trim()) return invalid(`message ${i + 1} is empty`);
    messages.push({ role, content: m.content });
  }
  const last = messages[messages.length - 1]!;
  if (last.role !== "user") return invalid("the last message must be the user's");
  if (
    tryUserTurns(messages) > limits.maxTurns ||
    tryTranscriptChars(messages) > limits.maxTranscriptChars ||
    hasOverlongUserMessage(messages.slice(0, -1), limits)
  ) {
    return { ok: false, error: "conversation_full", message: "This conversation is full. Start over to keep trying." };
  }
  if (last.content.length > limits.maxMessageChars) return invalid(tryMessageTooLong(limits));
  return { ok: true, messages };
}

/**
 * Whether the panel can take one more message under the limits in force (§61.3): fewer than
 * `maxTurns` user messages so far, the transcript plus a message of `nextChars` within
 * `maxTranscriptChars`, and no message already in it over `maxMessageChars`.
 */
export function tryCanSendMore(messages: readonly TryMessage[], limits: TryPanelLimits, nextChars = 1): boolean {
  return (
    tryUserTurns(messages) < limits.maxTurns &&
    tryTranscriptChars(messages) + nextChars <= limits.maxTranscriptChars &&
    !hasOverlongUserMessage(messages, limits)
  );
}
