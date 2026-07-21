"use client";
// The skill detail page's Discussion card (SKILLY_SPEC.md §24 "Skill discussion"). A collapsible,
// per-skill comment thread below the Maintainers card. Collapsed by default (not persisted); the
// header shows the live count. Each comment renders the author's avatar, a clickable version pill
// (the version it's about), viewer-local date/time, and a sanitized-markdown body. Newest-first,
// 100 per page with "Show more"; a 500-char emoji composer with a version picker. Polls at the
// chat floor cadence while expanded. Effective maintainers / platform admins can hard-delete any
// comment. A `#discussion` fragment auto-expands and scrolls the card into view.
import { useCallback, useEffect, useRef, useState } from "react";
import { Pill } from "../../../../components/ui";
import { UserBubble } from "../../../../components/UserBubble";
import { Markdown } from "../../../../components/Markdown";
import { EmojiPicker } from "../../../../components/EmojiPicker";
import { useDateFmt } from "../../../../components/DateFormat";
import { useChatPollIntervals } from "../../../../components/useChatPoll";

const MAX_LEN = 500;

interface VersionOpt {
  semver: string;
  channel: "stable" | "beta";
  status: "active" | "yanked";
}
interface DiscussionMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  mine: boolean;
  body: string;
  createdAt: string;
  contextSemver: string | null;
}
interface Thread {
  conversationId: string | null;
  count: number;
  archived: boolean;
  canPost: boolean;
  canModerate: boolean;
  messages: DiscussionMessage[];
  hasMore: boolean;
}

/** Scroll to (and briefly flash) a version's row in the Versions section. */
function scrollToVersion(semver: string) {
  const el = document.getElementById(`version-${semver}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("row-flash");
  window.setTimeout(() => el.classList.remove("row-flash"), 1600);
}

function VersionPill({ semver, yanked }: { semver: string; yanked: boolean }) {
  return (
    <button
      type="button"
      className="version-pill-btn"
      title={`About v${semver}${yanked ? " (yanked)" : ""} — jump to it`}
      onClick={() => scrollToVersion(semver)}
    >
      <Pill tone={yanked ? "danger" : "accent"}>v{semver}</Pill>
    </button>
  );
}

export function SkillDiscussion({
  ns,
  slug,
  versions,
  latest,
  initialCount,
}: {
  ns: string;
  slug: string;
  versions: VersionOpt[];
  latest: string | null;
  initialCount: number;
}) {
  const fmt = useDateFmt();
  const [open, setOpen] = useState(false);
  const [settled, setSettled] = useState(false);
  const [thread, setThread] = useState<Thread | null>(null);
  const [draft, setDraft] = useState("");
  const [selVersion, setSelVersion] = useState<string | null>(null);
  const [verOpen, setVerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const verRef = useRef<HTMLDivElement>(null);
  const yankedSet = new Set(versions.filter((v) => v.status === "yanked").map((v) => v.semver));

  // Composer version picker: active versions only (yanked excluded), default the latest stable
  // (or the newest active version when no stable exists). Null when nothing active to reference.
  const activeVersions = versions.filter((v) => v.status === "active");
  const defaultSemver = latest && activeVersions.some((v) => v.semver === latest) ? latest : activeVersions[0]?.semver ?? null;
  const chosenSemver = selVersion ?? defaultSemver;

  const count = thread?.count ?? initialCount;

  const load = useCallback(async (offset = 0) => {
    const res = await fetch(`/api/skills/${ns}/${slug}/discussion?offset=${offset}`);
    if (!res.ok) return;
    const t = (await res.json()) as Thread;
    setThread((prev) => (offset > 0 && prev ? { ...t, messages: [...prev.messages, ...t.messages] } : t));
  }, [ns, slug]);

  // Fetch on first expand; poll at the chat floor while expanded (§24) — collapsed = no polling.
  const pollIntervals = useChatPollIntervals();
  useEffect(() => {
    if (!open) return;
    if (!thread) void load(0);
    const secs = pollIntervals[0] ?? 7;
    const id = window.setInterval(() => { if (!document.hidden) void load(0); }, secs * 1000);
    return () => window.clearInterval(id);
  }, [open, thread, load, pollIntervals]);

  // Release overflow clipping ~after the open animation, so the version-picker menu isn't clipped.
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    const t = window.setTimeout(() => setSettled(true), 220);
    return () => window.clearTimeout(t);
  }, [open]);

  // Deep link: /skills/ns/slug#discussion auto-expands and scrolls the card into view.
  useEffect(() => {
    if (window.location.hash === "#discussion") {
      setOpen(true);
      window.setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }
  }, []);

  // Dismiss the version-picker menu on outside click.
  useEffect(() => {
    if (!verOpen) return;
    const onDoc = (e: MouseEvent) => { if (verRef.current && !verRef.current.contains(e.target as Node)) setVerOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [verOpen]);

  const insertEmoji = (emoji: string) => {
    const ta = taRef.current;
    if (!ta) { setDraft((d) => (d + emoji).slice(0, MAX_LEN)); return; }
    const start = ta.selectionStart ?? draft.length;
    const end = ta.selectionEnd ?? draft.length;
    const next = (draft.slice(0, start) + emoji + draft.slice(end)).slice(0, MAX_LEN);
    setDraft(next);
    requestAnimationFrame(() => { ta.focus(); const pos = Math.min(start + emoji.length, MAX_LEN); ta.setSelectionRange(pos, pos); });
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/skills/${ns}/${slug}/discussion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, contextSemver: chosenSemver }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.error ?? `Failed (${res.status})`); return; }
      setDraft("");
      await load(0);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: DiscussionMessage) => {
    if (!window.confirm("Delete this comment? This can't be undone.")) return;
    const res = await fetch(`/api/skills/${ns}/${slug}/discussion/${m.id}`, { method: "DELETE" });
    if (res.ok) setThread((t) => (t ? { ...t, messages: t.messages.filter((x) => x.id !== m.id), count: Math.max(0, t.count - 1) } : t));
  };

  const bodyId = "skill-discussion-body";
  return (
    <section ref={cardRef} id="discussion" className="card reveal" style={{ marginTop: 20, scrollMarginTop: 80 }}>
      <button
        type="button"
        className="admin-card-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <h2 className="admin-card-title" style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>Discussion</h2>
        <span className="admin-card-summary muted mono">({count})</span>
        <span style={{ flex: 1 }} />
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="admin-card-chevron" data-open={open}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div className="admin-card-body" data-open={open} data-settled={settled} id={bodyId} role="region" aria-hidden={!open}>
        <div className="admin-card-body-inner">
          <div className="admin-card-body-pad">
            {thread?.archived && (
              <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>This skill is archived — the discussion is read-only.</p>
            )}

            {/* Composer (hidden when read-only). */}
            {thread && thread.canPost && (
              <div style={{ marginBottom: thread.messages.length ? 20 : 4 }}>
                <textarea
                  ref={taRef}
                  value={draft}
                  maxLength={MAX_LEN}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                  placeholder="Add to the discussion…  (markdown supported · Enter to post, Shift+Enter for a new line)"
                  rows={3}
                  style={{ width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 64, padding: "8px 11px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 13.5 }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <EmojiPicker onPick={insertEmoji} />
                  {/* Version picker — which version this comment is about. */}
                  {activeVersions.length > 0 && (
                    <div ref={verRef} style={{ position: "relative", display: "inline-flex" }}>
                      <button type="button" className="btn btn-sm" aria-haspopup="menu" aria-expanded={verOpen} onClick={() => setVerOpen((o) => !o)}>
                        {chosenSemver ? `v${chosenSemver}` : "no version"}{" "}▾
                      </button>
                      {verOpen && (
                        <div role="menu" style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, zIndex: 20, minWidth: 160, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow)", padding: 4, maxHeight: 240, overflowY: "auto" }}>
                          {activeVersions.map((v) => (
                            <button key={v.semver} type="button" className="ver-opt" onClick={() => { setSelVersion(v.semver); setVerOpen(false); }}>
                              v{v.semver}{v.channel === "beta" ? " · beta" : ""}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <span className="muted mono" style={{ fontSize: 11, marginLeft: "auto" }}>{draft.length}/{MAX_LEN}</span>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy || !draft.trim()} onClick={() => void send()}>
                    {busy ? "Posting…" : "Post"}
                  </button>
                </div>
                {err && <p className="mono" style={{ color: "var(--danger)", fontSize: 12, marginTop: 6 }}>{err}</p>}
              </div>
            )}

            {/* Thread (newest-first). */}
            {!thread ? (
              <div className="skeleton" style={{ height: 80, borderRadius: "var(--radius)" }} />
            ) : thread.messages.length === 0 ? (
              <p className="muted" style={{ fontSize: 13.5 }}>No comments yet — start the discussion.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {thread.messages.map((m) => (
                  <div key={m.id} style={{ display: "flex", gap: 10 }}>
                    <UserBubble name={m.authorName} avatar={m.authorAvatar} userId={m.authorId} size={30} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{m.mine ? "You" : m.authorName}</span>
                        {m.contextSemver && <VersionPill semver={m.contextSemver} yanked={yankedSet.has(m.contextSemver)} />}
                        <span className="muted mono" style={{ fontSize: 11 }}>{fmt.dateTime(m.createdAt)}</span>
                        {thread.canModerate && (
                          <button type="button" className="btn-ghost mono" style={{ fontSize: 11, marginLeft: "auto" }} onClick={() => void remove(m)}>
                            delete
                          </button>
                        )}
                      </div>
                      <div className="md" style={{ fontSize: 13.5, marginTop: 2 }}>
                        <Markdown source={m.body} />
                      </div>
                    </div>
                  </div>
                ))}
                {thread.hasMore && (
                  <button type="button" className="btn btn-sm" style={{ alignSelf: "center" }} onClick={() => void load(thread.messages.length)}>
                    Show more
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
