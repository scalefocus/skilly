// Try a skill before installing (SKILLY_SPEC.md §61.3): the conversation lives only in this tab's
// sessionStorage, keyed by user, skill and resolved version, so it survives closing the panel and a
// reload, and is gone when the tab closes. Sign-out clears every Try key. Every access is wrapped:
// storage can be blocked (private windows, policies) and the panel must still work without it.
import type { TryMessage } from "@skilly/shared/ai-try";

const PREFIX = "skilly.try.";

export function tryStoreKey(userId: string, ns: string, slug: string, semver: string): string {
  return `${PREFIX}${userId}:${ns}/${slug}@${semver}`;
}

/** A stored transcript: alternating, starting with the user and ending with a reply. */
function isStoredTranscript(v: unknown): v is TryMessage[] {
  if (!Array.isArray(v) || v.length % 2 !== 0) return false;
  return v.every((m, i) => {
    const o = m as { role?: unknown; content?: unknown } | null;
    return o?.role === (i % 2 === 0 ? "user" : "assistant") && typeof o.content === "string";
  });
}

export function loadTryConversation(key: string): TryMessage[] {
  try {
    const raw = sessionStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return isStoredTranscript(v) ? v : [];
  } catch {
    return [];
  }
}

/** Save a finished exchange (an empty transcript removes the key). */
export function saveTryConversation(key: string, messages: readonly TryMessage[]): void {
  try {
    if (messages.length) sessionStorage.setItem(key, JSON.stringify(messages));
    else sessionStorage.removeItem(key);
  } catch {
    /* storage blocked or full: the conversation just won't survive a reload */
  }
}

/** Sign-out: drop every Try conversation in this tab, whoever it belonged to. */
export function clearTryConversations(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    /* nothing to clear */
  }
}
