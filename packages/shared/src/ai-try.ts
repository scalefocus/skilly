// Try a skill before installing (SKILLY_SPEC.md §61): the client-safe half — the feature key, the
// limits, the panel's shapes and the transcript validation both the panel (before sending) and the
// route (before calling the provider) run. No node, no I/O: exported via "@skilly/shared/ai-try"
// for client components, and from the server barrel. The input selection and the system prompt
// live in ai-try-run.ts; the I/O in the web tier.

/** The §40.7 feature key (registered in AI_FEATURES). */
export const AI_TRY_FEATURE = "skill_try";
/** Output-token ceiling per reply (§61.4) — the registry default. */
export const AI_TRY_MAX_TOKENS = 8192;
/** The registered per-attempt timeout (§61.4); admin-tunable (§40.15). */
export const AI_TRY_TIMEOUT_MS = 120_000;
/** The skill content sent with every message: §46's selection with this lower total (§61.4). */
export const AI_TRY_TOTAL_MAX_CHARS = 100_000;
/** Limits (§61.7). */
export const AI_TRY_PER_MINUTE = 10;
export const AI_TRY_DAILY_CAP = 100;
export const AI_TRY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AI_TRY_MAX_TURNS = 20;
export const AI_TRY_MAX_MESSAGE_CHARS = 4000;
export const AI_TRY_MAX_TRANSCRIPT_CHARS = 200_000;
/** The panel shows "N of 20 messages left" once this many or fewer remain (§61.3). */
export const AI_TRY_TURNS_WARN = 5;
/** The composer's counter appears from this many characters (§61.3). */
export const AI_TRY_COUNTER_FROM = 3500;

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
}

export type TryTranscriptError = "invalid_transcript" | "conversation_full";

export type TryTranscriptResult =
  | { ok: true; messages: TryMessage[] }
  | { ok: false; error: TryTranscriptError; message: string };

/** Characters across every message, as the 200,000 cap counts them (§61.7). */
export function tryTranscriptChars(messages: readonly TryMessage[]): number {
  return messages.reduce((n, m) => n + m.content.length, 0);
}

/** How many messages the user has sent in this conversation. */
export function tryUserTurns(messages: readonly TryMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
}

const invalid = (message: string): TryTranscriptResult => ({ ok: false, error: "invalid_transcript", message });

/**
 * Validate a transcript about to be sent (§61.6 step 3): a non-empty array that starts and ends with
 * a `user` message and alternates; every content non-empty after trimming; a user message at most
 * 4,000 characters (`invalid_transcript`); at most 20 user messages and 200,000 characters in total
 * (`conversation_full`). Returns the messages with their content as given (not trimmed).
 */
export function validateTryTranscript(raw: unknown): TryTranscriptResult {
  if (!Array.isArray(raw) || raw.length === 0) return invalid("messages must be a non-empty array");
  const messages: TryMessage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i] as { role?: unknown; content?: unknown } | null;
    const role = m?.role;
    if (role !== "user" && role !== "assistant") return invalid(`message ${i + 1} has no valid role`);
    if (role !== (i % 2 === 0 ? "user" : "assistant")) return invalid("messages must alternate, starting with the user");
    if (typeof m?.content !== "string" || !m.content.trim()) return invalid(`message ${i + 1} is empty`);
    if (role === "user" && m.content.length > AI_TRY_MAX_MESSAGE_CHARS) {
      return invalid(`a message may be at most ${AI_TRY_MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters`);
    }
    messages.push({ role, content: m.content });
  }
  if (messages[messages.length - 1]!.role !== "user") return invalid("the last message must be the user's");
  if (tryUserTurns(messages) > AI_TRY_MAX_TURNS || tryTranscriptChars(messages) > AI_TRY_MAX_TRANSCRIPT_CHARS) {
    return { ok: false, error: "conversation_full", message: "This conversation is full. Start over to keep trying." };
  }
  return { ok: true, messages };
}

/**
 * Whether the panel can take one more message (§61.3): fewer than 20 user messages so far, and the
 * transcript plus a message of `nextChars` stays within 200,000 characters.
 */
export function tryCanSendMore(messages: readonly TryMessage[], nextChars = 1): boolean {
  return tryUserTurns(messages) < AI_TRY_MAX_TURNS && tryTranscriptChars(messages) + nextChars <= AI_TRY_MAX_TRANSCRIPT_CHARS;
}
