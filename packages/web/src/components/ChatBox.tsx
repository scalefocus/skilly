"use client";
// Presentational chat: a scrollable message list + a composer (mention-capable editable + emoji
// picker). Used by the review page, the request page, and the topbar messages dropdown. Bodies
// are plain text (React escapes them) with newlines preserved and native emoji — the ONE markup
// exception is inline mention chips rendered from the per-reader `mentions` map (`#` skills /
// `@` people, SKILLY_SPEC.md §24 Mentions). A muted reminder line under the composer points at
// the `#`/`@` triggers.
import { useEffect, useRef, useState } from "react";
import { useDateFmt } from "./DateFormat";
import { EmojiPicker } from "./EmojiPicker";
import { UserBubble } from "./UserBubble";
import { MentionComposer, type MentionComposerHandle } from "./MentionComposer";
import { MentionHint, MentionText, type MentionMap } from "./MentionChips";

export interface ChatMessage {
  id: string; authorId: string; authorName: string; authorAvatar: string | null; mine: boolean; body: string; createdAt: string;
  /** Optional small label shown under the author's name (e.g. "Original Requester"). */
  authorBadge?: string;
}

export function ChatBox({
  messages, canPost, closed, onSend, listHeight = 280, emptyHint = "No messages yet — start the discussion.",
  closedHint = "This discussion is read-only — the proposal has been decided.",
  mentions, mentionContext,
}: {
  messages: ChatMessage[];
  canPost: boolean;
  closed?: boolean;
  onSend: (body: string) => Promise<void>;
  listHeight?: number;
  emptyHint?: string;
  closedHint?: string;
  /** Per-reader mention resolution for the bodies above (§24) — token → chip data. */
  mentions?: MentionMap;
  /** `@` typeahead context for the composer; null/undefined = whole directory. */
  mentionContext?: string | null;
}) {
  const fmt = useDateFmt();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const composerRef = useRef<MentionComposerHandle>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view as the thread grows.
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onSend(body);
      composerRef.current?.clear();
      setText("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ maxHeight: listHeight, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingRight: 4 }}>
        {messages.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: "8px 0" }}>{emptyHint}</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} style={{ display: "flex", gap: 10, flexDirection: m.mine ? "row-reverse" : "row" }}>
              <UserBubble name={m.authorName} avatar={m.authorAvatar} userId={m.authorId} size={26} />
              <div style={{ maxWidth: "78%" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexDirection: m.mine ? "row-reverse" : "row" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{m.mine ? "You" : m.authorName}</span>
                  <span className="muted mono" style={{ fontSize: 10.5 }}>{fmt.dateTime(m.createdAt)}</span>
                </div>
                {m.authorBadge && (
                  <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 1, textAlign: m.mine ? "right" : "left" }}>
                    {m.authorBadge}
                  </div>
                )}
                <div
                  style={{
                    marginTop: 3, padding: "8px 11px", borderRadius: 12, fontSize: 13.5, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word",
                    background: m.mine ? "var(--accent-soft)" : "var(--surface-2)",
                    color: "var(--ink)", border: "1px solid var(--line)",
                  }}
                >
                  <MentionText body={m.body} mentions={mentions} />
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      {closed ? (
        <p className="muted" style={{ fontSize: 12.5, fontStyle: "italic", margin: 0 }}>{closedHint}</p>
      ) : canPost ? (
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <MentionComposer
                ref={composerRef}
                onChange={setText}
                onSubmit={() => void send()}
                placeholder="Write a message…  (Enter to send, Shift+Enter for a new line)"
                mentionContext={mentionContext}
                minHeight={38}
              />
            </div>
            <EmojiPicker onPick={(e) => composerRef.current?.insertText(e)} />
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void send()} disabled={sending || !text.trim()}>
              {sending ? "…" : "Send"}
            </button>
          </div>
          <MentionHint />
        </div>
      ) : null}
    </div>
  );
}
