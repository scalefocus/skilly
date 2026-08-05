"use client";
// The skill detail page's Discussion card (SKILLY_SPEC.md §24 "Skill discussion"). A collapsible,
// per-skill comment thread below the Maintainers card. EXPANDED by default, with one GLOBAL
// client-side collapse preference (localStorage `skilly.discussionCollapsed`) shared by every
// skill's card — collapsing any card sets it, expanding clears it; no localStorage → expanded.
// Each comment renders the author's avatar, a clickable version pill (the version it's about),
// viewer-local date/time, and a sanitized-markdown body with `#`/`@` mention chips (§24 Mentions).
// Newest-first, 100 per page with "Show more"; a 500-char (mention tokens count as 1) emoji +
// mention composer with a version picker. While expanded it polls on the BACKOFF walk over the
// chat interval set — stepping up on quiet polls, resetting to the floor only when a poll returns
// new messages or the viewer posts (§24 Smart polling); collapsed = no polling. The read action
// is the VIEWPORT rule: the viewer's skill.discussion + mention alerts clear when the expanded
// thread actually enters the viewport — never on mere page load. Effective maintainers / platform
// admins can hard-delete any comment. A `#discussion` fragment auto-expands the card for that
// view (without touching the stored preference) and scrolls it into view.
import { useCallback, useEffect, useRef, useState } from "react";
import { Pill } from "../../../../components/ui";
import { UserBubble } from "../../../../components/UserBubble";
import { Markdown } from "../../../../components/Markdown";
import { EmojiPicker } from "../../../../components/EmojiPicker";
import { useDateFmt } from "../../../../components/DateFormat";
import { useChatPollIntervals } from "../../../../components/useChatPoll";
import { MentionComposer, type MentionComposerHandle } from "../../../../components/MentionComposer";
import { MentionHint, type MentionMap } from "../../../../components/MentionChips";
import { mentionCollapsedLength } from "@skilly/shared/mentions"; // subpath: keep node-only shared code out of the client bundle

const MAX_LEN = 500;
/** One GLOBAL collapse preference for every skill's Discussion card (§24). */
const COLLAPSE_KEY = "skilly.discussionCollapsed";

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
  mentions?: MentionMap;
  mentionContext?: string | null;
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

/** The stored global preference — safe under private mode / SSR (fallback: expanded, §24). */
function storedCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
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
  // Expanded by default; the stored collapse preference (or a #discussion deep link, which always
  // expands FOR THIS VIEW without overwriting the preference) is applied on mount — client-only
  // state, so start expanded (the no-localStorage fallback) and settle in the effect below.
  const [open, setOpen] = useState(true);
  const [settled, setSettled] = useState(false);
  const [thread, setThread] = useState<Thread | null>(null);
  const [draft, setDraft] = useState("");
  const [selVersion, setSelVersion] = useState<string | null>(null);
  const [verOpen, setVerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const composerRef = useRef<MentionComposerHandle>(null);
  const threadBodyRef = useRef<HTMLDivElement>(null);
  const verRef = useRef<HTMLDivElement>(null);
  const yankedSet = new Set(versions.filter((v) => v.status === "yanked").map((v) => v.semver));

  // Composer version picker: active versions only (yanked excluded), default the latest stable
  // (or the newest active version when no stable exists). Null when nothing active to reference.
  const activeVersions = versions.filter((v) => v.status === "active");
  const defaultSemver = latest && activeVersions.some((v) => v.semver === latest) ? latest : activeVersions[0]?.semver ?? null;
  const chosenSemver = selVersion ?? defaultSemver;

  const count = thread?.count ?? initialCount;
  const draftLen = mentionCollapsedLength(draft);

  // Backoff walk (§24 Smart polling): the step index into the interval set, and what the newest
  // message was on the last poll — a changed head resets the walk to the floor.
  const pollStep = useRef(0);
  const newestSeen = useRef<string | null>(null);

  const load = useCallback(async (offset = 0) => {
    const res = await fetch(`/api/skills/${ns}/${slug}/discussion?offset=${offset}`);
    if (!res.ok) return;
    const t = (await res.json()) as Thread;
    if (offset === 0) {
      const newest = t.messages[0]?.id ?? null;
      if (newestSeen.current !== null && newest !== newestSeen.current) pollStep.current = 0; // new activity → floor
      newestSeen.current = newest;
    }
    setThread((prev) => (offset > 0 && prev ? { ...t, messages: [...prev.messages, ...t.messages], mentions: { ...prev.mentions, ...t.mentions } } : t));
  }, [ns, slug]);

  // Apply the stored collapse preference on mount; a #discussion deep link overrides it for this
  // view (and scrolls to the card) without writing anything back.
  useEffect(() => {
    if (window.location.hash === "#discussion") {
      setOpen(true);
      window.setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
      return;
    }
    if (storedCollapsed()) setOpen(false);
  }, []);

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      // The one global preference: collapsing any card remembers it; expanding any card clears it.
      try {
        if (next) window.localStorage.removeItem(COLLAPSE_KEY);
        else window.localStorage.setItem(COLLAPSE_KEY, "1");
      } catch { /* private mode etc. — the view still toggles */ }
      return next;
    });
  };

  // Fetch on first expand; while expanded, poll on the backoff walk (§24) — each quiet poll steps
  // one interval up the set, holding at the top; new activity (detected in load) or the viewer
  // posting resets to the floor. Collapsed = no polling. Hidden tab → the timer keeps ticking but
  // skips the fetch AND the step advance (freeze), resuming where it left off.
  const pollIntervals = useChatPollIntervals();
  useEffect(() => {
    if (!open) return;
    if (!thread) void load(0);
    let timer = 0;
    let cancelled = false;
    const schedule = () => {
      const secs = pollIntervals[Math.min(pollStep.current, pollIntervals.length - 1)] ?? 7;
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        if (!document.hidden) {
          const before = newestSeen.current;
          await load(0);
          // Quiet poll (head unchanged) → advance the walk; load() already reset it on activity.
          if (newestSeen.current === before) pollStep.current = Math.min(pollStep.current + 1, pollIntervals.length - 1);
        }
        if (!cancelled) schedule();
      }, secs * 1000);
    };
    schedule();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, thread, load, pollIntervals]);

  // The read action (§24): clear the viewer's skill.discussion + mention alerts when the EXPANDED
  // thread actually enters the viewport — never on mere page load. Re-fires when the newest
  // message changes while visible (a refreshed coalesced row must clear again).
  const visibleRef = useRef(false);
  const lastReadHead = useRef<string | null>(null);
  const maybeMarkRead = useCallback(() => {
    if (!visibleRef.current || !thread) return;
    const head = thread.messages[0]?.id ?? "empty";
    if (lastReadHead.current === head) return;
    lastReadHead.current = head;
    fetch(`/api/skills/${ns}/${slug}/discussion/read`, { method: "POST" }).catch(() => {});
  }, [ns, slug, thread]);
  useEffect(() => {
    if (!open) { visibleRef.current = false; return; }
    const el = threadBodyRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      visibleRef.current = entries.some((e) => e.isIntersecting);
      maybeMarkRead();
    }, { threshold: 0.15 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [open, thread === null, maybeMarkRead]); // eslint-disable-line react-hooks/exhaustive-deps -- re-observe once the thread body exists
  useEffect(() => { maybeMarkRead(); }, [maybeMarkRead]);

  // Release overflow clipping ~after the open animation, so the version-picker menu isn't clipped.
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    const t = window.setTimeout(() => setSettled(true), 220);
    return () => window.clearTimeout(t);
  }, [open]);

  // Dismiss the version-picker menu on outside click.
  useEffect(() => {
    if (!verOpen) return;
    const onDoc = (e: MouseEvent) => { if (verRef.current && !verRef.current.contains(e.target as Node)) setVerOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [verOpen]);

  const send = async () => {
    const body = draft.trim();
    if (!body || busy || draftLen > MAX_LEN) return;
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
      composerRef.current?.clear();
      setDraft("");
      pollStep.current = 0; // posting resets the backoff walk to the floor (§24)
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
        onClick={toggle}
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
                <MentionComposer
                  ref={composerRef}
                  onChange={setDraft}
                  onSubmit={() => void send()}
                  placeholder="Add to the discussion…  (Enter to post, Shift+Enter for a new line)"
                  mentionContext={thread.mentionContext}
                  minHeight={64}
                  ariaLabel="Add to the discussion"
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <EmojiPicker onPick={(e) => composerRef.current?.insertText(e)} align="left" />
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
                  <span className="muted mono" style={{ fontSize: 11, marginLeft: "auto", color: draftLen > MAX_LEN ? "var(--danger)" : undefined }}>{draftLen}/{MAX_LEN}</span>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy || !draft.trim() || draftLen > MAX_LEN} onClick={() => void send()}>
                    {busy ? "Posting…" : "Post"}
                  </button>
                </div>
                <MentionHint markdown />
                {err && <p className="mono" style={{ color: "var(--danger)", fontSize: 12, marginTop: 6 }}>{err}</p>}
              </div>
            )}

            {/* Thread (newest-first). */}
            {!thread ? (
              <div className="skeleton" style={{ height: 80, borderRadius: "var(--radius)" }} />
            ) : thread.messages.length === 0 ? (
              <div ref={threadBodyRef}>
                <p className="muted" style={{ fontSize: 13.5 }}>No comments yet — start the discussion.</p>
              </div>
            ) : (
              <div ref={threadBodyRef} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
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
                        <Markdown source={m.body} mentions={thread.mentions ?? {}} />
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
