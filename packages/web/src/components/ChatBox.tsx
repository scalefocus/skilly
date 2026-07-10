"use client";
// Presentational chat: a scrollable message list + a composer (textarea + emoji picker). Used by
// the review page and the topbar messages dropdown. Plain-text bodies (React escapes them) with
// newlines preserved; native emoji render as-is. SKILLY_SPEC.md §24.
import { useEffect, useRef, useState } from "react";
import { useDateFmt } from "./DateFormat";
import { EmojiPicker } from "./EmojiPicker";
import { UserBubble } from "./UserBubble";

export interface ChatMessage {
  id: string; authorId: string; authorName: string; authorAvatar: string | null; mine: boolean; body: string; createdAt: string;
  /** Optional small label shown under the author's name (e.g. "Original Requester"). */
  authorBadge?: string;
}

export function ChatBox({
  messages, canPost, closed, onSend, listHeight = 280, emptyHint = "No messages yet — start the discussion.",
  closedHint = "This discussion is read-only — the proposal has been decided.",
}: {
  messages: ChatMessage[];
  canPost: boolean;
  closed?: boolean;
  onSend: (body: string) => Promise<void>;
  listHeight?: number;
  emptyHint?: string;
  closedHint?: string;
}) {
  const fmt = useDateFmt();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view as the thread grows.
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onSend(body);
      setText("");
    } finally {
      setSending(false);
    }
  };

  const insertEmoji = (e: string) => {
    const ta = taRef.current;
    if (!ta) { setText((t) => t + e); return; }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    setText(text.slice(0, start) + e + text.slice(end));
    requestAnimationFrame(() => { ta.focus(); const p = start + e.length; ta.setSelectionRange(p, p); });
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
                  {m.body}
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
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder="Write a message…  (Enter to send, Shift+Enter for a new line)"
            rows={2}
            style={{ flex: 1, resize: "vertical", minHeight: 38, padding: "8px 11px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 13.5 }}
          />
          <EmojiPicker onPick={insertEmoji} />
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void send()} disabled={sending || !text.trim()}>
            {sending ? "…" : "Send"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
