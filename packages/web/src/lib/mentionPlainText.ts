// Plain-text mention flattening for the conversation-list preview (SKILLY_SPEC.md §24
// "Conversation-list previews"). The topbar messages list shows a one-line `<author>: <body>`
// preview where chips don't belong and a raw `<@uuid>` token must never reach the reader, so the
// server flattens each token using the SAME per-reader resolution map a thread gets — every rule
// below mirrors the thread chip for that state (components/MentionChips.tsx). Kept free of the DB
// so it can be unit-tested directly.
import { splitMentionSegments } from "@skilly/shared/mentions";
import type { MentionMap, ResolvedMention } from "./mentions";

/** One resolved mention as preview text. `undefined` (no row behind the token) → the literal token. */
export function mentionPlainText(token: string, resolved: ResolvedMention | undefined): string {
  if (!resolved) return token;
  if (resolved.kind === "user") return resolved.erased ? resolved.name : `@${resolved.name}`;
  if (resolved.state === "ok") return `#${resolved.restricted ? `${resolved.ns} / ${resolved.title}` : resolved.title}`;
  // Redacted (invariant #3/#7): never the title, slug or namespace.
  if (resolved.state === "restricted") return "a restricted skill";
  return resolved.label ?? "a deleted skill";
}

/** A message body with every mention token replaced by its reader-scoped plain text. */
export function flattenMentions(body: string, mentions: MentionMap): string {
  return splitMentionSegments(body)
    .map((s) => (s.type === "text" ? s.text : mentionPlainText(s.token, mentions[s.token])))
    .join("");
}
