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
// admins can delete any comment. A `#discussion` fragment auto-expands the card for that view
// (without touching the stored preference) and scrolls it into view.
//
// Replies (§24 "Replies to discussion comments"): one level. Each top-level comment carries its
// replies oldest-first under a single indent; the first 3 show, "Show N more replies" expands the
// rest for this view. Every comment and reply has a Reply action that opens ONE inline composer at
// the foot of that thread (no version picker — a reply inherits its root's version and renders no
// pill); answering someone else's reply pre-inserts a removable @mention chip for them. A comment a
// moderator removed while it had replies renders as a muted tombstone. `#discussion-<rootId>`
// (the reply notification's deep link) expands that thread, scrolls to it and flashes its newest
// reply; each thread's unread reply alert clears when that thread enters the viewport.
import { useCallback, useEffect, useRef, useState } from "react";
import { Pill, ViaMcp } from "../../../../components/ui";
import { UserBubble } from "../../../../components/UserBubble";
import { Markdown } from "../../../../components/Markdown";
import { EmojiPicker } from "../../../../components/EmojiPicker";
import { useDateFmt } from "../../../../components/DateFormat";
import { useChatPollIntervals } from "../../../../components/useChatPoll";
import { MentionComposer, type MentionComposerHandle } from "../../../../components/MentionComposer";
import { MentionHint, type MentionMap } from "../../../../components/MentionChips";
import { mentionCollapsedLength } from "@skilly/shared/mentions"; // subpath: keep node-only shared code out of the client bundle
import { reportFeatureUse } from "../../../../lib/surveyClient";

const MAX_LEN = 500;
/** One GLOBAL collapse preference for every skill's Discussion card (§24). */
const COLLAPSE_KEY = "skilly.discussionCollapsed";
/** Replies shown per thread before "Show N more replies" (§24 Replies). */
const REPLIES_SHOWN = 3;
const THREAD_HASH = "#discussion-";

interface VersionOpt {
  semver: string;
  channel: "stable" | "beta";
  status: "active" | "yanked" | "quarantined";
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
  /** The thread root for a reply; null for a top-level comment. */
  parentId: string | null;
  /** The author can be @mentioned here right now (the reply chip is pre-inserted only then). */
  authorMentionable: boolean;
  /** §29: the MCP client that posted this on the author's behalf, or null when a person did. */
  viaMcpClient?: string | null;
}
interface Tombstone {
  id: string;
  removed: true;
  parentId: null;
}
type TopLevel = (DiscussionMessage | Tombstone) & { replyCount: number; replies: DiscussionMessage[] };
interface Thread {
  conversationId: string | null;
  count: number;
  archived: boolean;
  canPost: boolean;
  canModerate: boolean;
  messages: TopLevel[];
  hasMore: boolean;
  unreadThreads?: string[];
  mentions?: MentionMap;
  mentionContext?: string | null;
}

const isTombstone = (m: DiscussionMessage | Tombstone): m is Tombstone => "removed" in m && m.removed === true;

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
  // Replies: which threads show all their replies (per view, never persisted), and the ONE open
  // reply composer — the thread it posts into and the message being answered.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [replyTo, setReplyTo] = useState<{ rootId: string; target: DiscussionMessage } | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyErr, setReplyErr] = useState<string | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const composerRef = useRef<MentionComposerHandle>(null);
  const replyRef = useRef<MentionComposerHandle>(null);
  const threadBodyRef = useRef<HTMLDivElement>(null);
  const verRef = useRef<HTMLDivElement>(null);
  /** A `#discussion-<rootId>` deep link waiting for the thread to load. */
  const pendingThread = useRef<string | null>(null);
  const yankedSet = new Set(versions.filter((v) => v.status === "yanked").map((v) => v.semver));

  // Composer version picker: active versions only (yanked excluded), default the latest stable
  // (or the newest active version when no stable exists). Null when nothing active to reference.
  const activeVersions = versions.filter((v) => v.status === "active");
  const defaultSemver = latest && activeVersions.some((v) => v.semver === latest) ? latest : activeVersions[0]?.semver ?? null;
  const chosenSemver = selVersion ?? defaultSemver;

  const count = thread?.count ?? initialCount;
  const draftLen = mentionCollapsedLength(draft);
  const replyLen = mentionCollapsedLength(replyDraft);

  // Backoff walk (§24 Smart polling): the step index into the interval set, and the activity
  // signature on the last poll (count + newest top-level id — a new reply bumps the count without
  // changing the head) — a changed signature resets the walk to the floor.
  const pollStep = useRef(0);
  const newestSeen = useRef<string | null>(null);

  const load = useCallback(async (offset = 0) => {
    const res = await fetch(`/api/skills/${ns}/${slug}/discussion?offset=${offset}`);
    if (!res.ok) return;
    const t = (await res.json()) as Thread;
    if (offset === 0) {
      const sig = `${t.count}:${t.messages[0]?.id ?? ""}`;
      if (newestSeen.current !== null && sig !== newestSeen.current) pollStep.current = 0; // new activity → floor
      newestSeen.current = sig;
    }
    setThread((prev) => (offset > 0 && prev ? { ...t, messages: [...prev.messages, ...t.messages], mentions: { ...prev.mentions, ...t.mentions } } : t));
  }, [ns, slug]);

  // Apply the stored collapse preference on mount; a #discussion (or #discussion-<rootId>) deep
  // link overrides it for this view (and scrolls to the card) without writing anything back.
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith(THREAD_HASH) && hash.length > THREAD_HASH.length) {
      setOpen(true);
      pendingThread.current = decodeURIComponent(hash.slice(THREAD_HASH.length));
      return;
    }
    if (hash === "#discussion") {
      setOpen(true);
      window.setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
      return;
    }
    if (storedCollapsed()) setOpen(false);
  }, []);

  // Land a `#discussion-<rootId>` deep link once the thread has loaded: expand that thread's
  // replies, scroll it into view and briefly flash its newest reply. A thread that no longer
  // exists (or isn't on the first page) falls back to plain #discussion.
  useEffect(() => {
    const rootId = pendingThread.current;
    if (!rootId || !thread) return;
    pendingThread.current = null;
    const root = thread.messages.find((m) => m.id === rootId);
    if (!root) {
      window.setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
      return;
    }
    setExpanded((prev) => new Set(prev).add(rootId));
    window.setTimeout(() => {
      document.getElementById(`discussion-${rootId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      const newest = root.replies[root.replies.length - 1];
      const el = newest ? document.getElementById(`discussion-msg-${newest.id}`) : null;
      if (el) {
        el.classList.add("row-flash");
        window.setTimeout(() => el.classList.remove("row-flash"), 1800);
      }
    }, 260); // after the card's open animation
  }, [thread]);

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
          // Quiet poll (signature unchanged) → advance the walk; load() already reset it on activity.
          if (newestSeen.current === before) pollStep.current = Math.min(pollStep.current + 1, pollIntervals.length - 1);
        }
        if (!cancelled) schedule();
      }, secs * 1000);
    };
    schedule();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, thread, load, pollIntervals]);

  // The read action (§24): clear the viewer's skill.discussion + mention alerts when the EXPANDED
  // thread actually enters the viewport — never on mere page load. Re-fires when the activity
  // signature changes while visible (a refreshed coalesced row must clear again).
  const visibleRef = useRef(false);
  const lastReadHead = useRef<string | null>(null);
  const maybeMarkRead = useCallback(() => {
    if (!visibleRef.current || !thread) return;
    const head = `${thread.count}:${thread.messages[0]?.id ?? "empty"}`;
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

  // The per-thread read (§24 Replies): each thread holding an unread reply alert for the viewer
  // clears it when THAT thread enters the viewport of the expanded card — seeing one thread never
  // clears another's. A thread is posted once per unread episode (re-armed when a poll no longer
  // lists it, so a later refreshed row clears again).
  const readSent = useRef<Set<string>>(new Set());
  const unreadKey = (thread?.unreadThreads ?? []).join(",");
  useEffect(() => {
    const unread = new Set(thread?.unreadThreads ?? []);
    for (const id of [...readSent.current]) if (!unread.has(id)) readSent.current.delete(id);
    if (!open || unread.size === 0) return;
    const body = threadBodyRef.current;
    if (!body) return;
    const obs = new IntersectionObserver((entries) => {
      const seen = entries
        .filter((e) => e.isIntersecting)
        .map((e) => (e.target as HTMLElement).dataset.threadRoot ?? "")
        .filter((id) => id && unread.has(id) && !readSent.current.has(id));
      if (!seen.length) return;
      for (const id of seen) readSent.current.add(id);
      fetch(`/api/skills/${ns}/${slug}/discussion/read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rootIds: seen }),
      }).catch(() => {});
    }, { threshold: 0.15 });
    body.querySelectorAll<HTMLElement>("[data-thread-root]").forEach((el) => {
      if (unread.has(el.dataset.threadRoot ?? "")) obs.observe(el);
    });
    return () => obs.disconnect();
  }, [open, unreadKey, thread?.messages, ns, slug]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on the unread list's contents

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

  // Opening a reply composer focuses it and, when answering SOMEONE ELSE's reply, pre-inserts a
  // removable @mention chip for that reply's author — only if they can still be mentioned (§24).
  useEffect(() => {
    if (!replyTo) return;
    const t = replyTo.target;
    const id = window.setTimeout(() => {
      // Re-targeting within the same thread reuses the open editor — start it fresh.
      replyRef.current?.clear();
      if (t.parentId && !t.mine && t.authorMentionable) replyRef.current?.insertMention("user", t.authorId, `@${t.authorName}`);
      else replyRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [replyTo]);

  const openReply = (rootId: string, target: DiscussionMessage) => {
    setReplyErr(null);
    setReplyDraft("");
    setReplyTo({ rootId, target });
  };
  const closeReply = () => {
    setReplyTo(null);
    setReplyDraft("");
    setReplyErr(null);
  };

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
      reportFeatureUse("messaging"); // §36.3
      composerRef.current?.clear();
      setDraft("");
      pollStep.current = 0; // posting resets the backoff walk to the floor (§24)
      await load(0);
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async () => {
    const body = replyDraft.trim();
    if (!replyTo || !body || replyBusy || replyLen > MAX_LEN) return;
    setReplyBusy(true);
    setReplyErr(null);
    try {
      const res = await fetch(`/api/skills/${ns}/${slug}/discussion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, parentId: replyTo.target.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setReplyErr(j.error ?? `Failed (${res.status})`); return; }
      reportFeatureUse("messaging"); // §36.3
      const rootId = replyTo.rootId;
      setExpanded((prev) => new Set(prev).add(rootId)); // keep the new reply in view
      closeReply();
      pollStep.current = 0;
      await load(0);
    } finally {
      setReplyBusy(false);
    }
  };

  const remove = async (m: DiscussionMessage) => {
    if (!window.confirm("Delete this comment? This can't be undone.")) return;
    const res = await fetch(`/api/skills/${ns}/${slug}/discussion/${m.id}`, { method: "DELETE" });
    if (!res.ok) return;
    const r = (await res.json().catch(() => ({}))) as { outcome?: "deleted" | "tombstoned"; tombstoneRemoved?: boolean };
    if (replyTo && (replyTo.target.id === m.id || (r.outcome === "tombstoned" && replyTo.rootId === m.id))) closeReply();
    setThread((t) => {
      if (!t) return t;
      const messages = t.messages.flatMap((root): TopLevel[] => {
        if (root.id === m.id) {
          // A top-level comment: tombstoned in place (its replies stay), or gone.
          return r.outcome === "tombstoned" ? [{ id: root.id, removed: true, parentId: null, replyCount: root.replyCount, replies: root.replies }] : [];
        }
        if (m.parentId !== root.id) return [root];
        if (r.tombstoneRemoved) return []; // the last reply under a tombstone sweeps the tombstone too
        const replies = root.replies.filter((x) => x.id !== m.id);
        return [{ ...root, replies, replyCount: replies.length }];
      });
      return { ...t, messages, count: Math.max(0, t.count - 1) };
    });
  };

  /** One comment or reply row. `rootId` is its thread (itself for a top-level comment). */
  const renderMessage = (m: DiscussionMessage, rootId: string, opts: { reply: boolean; canReply: boolean }) => (
    <div key={m.id} id={`discussion-msg-${m.id}`} style={{ display: "flex", gap: 10, borderRadius: "var(--radius-sm)" }}>
      <UserBubble name={m.authorName} avatar={m.authorAvatar} userId={m.authorId} size={opts.reply ? 26 : 30} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{m.mine ? "You" : m.authorName}</span>
          {/* Replies render no pill: the root's pill covers the thread (§24). */}
          {!opts.reply && m.contextSemver && <VersionPill semver={m.contextSemver} yanked={yankedSet.has(m.contextSemver)} />}
          <span className="muted mono" style={{ fontSize: 11 }}>{fmt.dateTime(m.createdAt)}</span>
          <ViaMcp client={m.viaMcpClient} />
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 10 }}>
            {opts.canReply && (
              <button type="button" className="btn-ghost mono" style={{ fontSize: 11 }} onClick={() => openReply(rootId, m)} data-testid="discussion-reply">
                reply
              </button>
            )}
            {thread?.canModerate && (
              <button type="button" className="btn-ghost mono" style={{ fontSize: 11 }} onClick={() => void remove(m)}>
                delete
              </button>
            )}
          </span>
        </div>
        <div className="md" style={{ fontSize: 13.5, marginTop: 2 }}>
          <Markdown source={m.body} mentions={thread?.mentions ?? {}} />
        </div>
      </div>
    </div>
  );

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

            {/* Thread (top-level newest-first; replies oldest-first under each). */}
            {!thread ? (
              <div className="skeleton" style={{ height: 80, borderRadius: "var(--radius)" }} />
            ) : thread.messages.length === 0 ? (
              <div ref={threadBodyRef}>
                <p className="muted" style={{ fontSize: 13.5 }}>No comments yet — start the discussion.</p>
              </div>
            ) : (
              <div ref={threadBodyRef} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {thread.messages.map((root) => {
                  const tomb = isTombstone(root);
                  // No replies into a tombstoned thread or a read-only discussion (§24).
                  const canReply = thread.canPost && !tomb;
                  const showAll = expanded.has(root.id);
                  const shown = showAll ? root.replies : root.replies.slice(0, REPLIES_SHOWN);
                  const hidden = root.replies.length - shown.length;
                  const composerHere = replyTo?.rootId === root.id;
                  return (
                    <div key={root.id} id={`discussion-${root.id}`} data-thread-root={root.id} style={{ display: "flex", flexDirection: "column", gap: 10, scrollMarginTop: 90 }}>
                      {tomb ? (
                        <p className="muted" style={{ fontSize: 13, fontStyle: "italic", margin: 0 }} data-testid="discussion-tombstone">
                          Comment removed by a moderator
                        </p>
                      ) : (
                        renderMessage(root as DiscussionMessage, root.id, { reply: false, canReply })
                      )}
                      {(shown.length > 0 || composerHere) && (
                        // A single indent: a small left inset plus a thin guide line. It never widens
                        // the card on narrow viewports (minWidth 0 lets the replies shrink).
                        <div style={{ marginLeft: 14, paddingLeft: 12, borderLeft: "2px solid var(--line)", display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
                          {shown.map((r) => renderMessage(r, root.id, { reply: true, canReply }))}
                          {hidden > 0 && (
                            <button
                              type="button"
                              className="btn-ghost mono"
                              style={{ fontSize: 12, alignSelf: "flex-start" }}
                              onClick={() => setExpanded((prev) => new Set(prev).add(root.id))}
                            >
                              Show {hidden} more {hidden === 1 ? "reply" : "replies"}
                            </button>
                          )}
                          {composerHere && replyTo && (
                            <div data-testid="discussion-reply-composer">
                              <MentionComposer
                                ref={replyRef}
                                onChange={setReplyDraft}
                                onSubmit={() => void sendReply()}
                                onEscape={closeReply}
                                placeholder={`Reply to ${replyTo.target.mine ? "yourself" : replyTo.target.authorName}…  (Enter to post, Esc to cancel)`}
                                mentionContext={thread.mentionContext}
                                minHeight={48}
                                ariaLabel="Write a reply"
                              />
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                                <EmojiPicker onPick={(e) => replyRef.current?.insertText(e)} align="left" />
                                <span className="muted mono" style={{ fontSize: 11, marginLeft: "auto", color: replyLen > MAX_LEN ? "var(--danger)" : undefined }}>{replyLen}/{MAX_LEN}</span>
                                <button type="button" className="btn btn-sm" onClick={closeReply}>Cancel</button>
                                <button type="button" className="btn btn-primary btn-sm" disabled={replyBusy || !replyDraft.trim() || replyLen > MAX_LEN} onClick={() => void sendReply()}>
                                  {replyBusy ? "Posting…" : "Reply"}
                                </button>
                              </div>
                              {replyErr && <p className="mono" style={{ color: "var(--danger)", fontSize: 12, marginTop: 6 }}>{replyErr}</p>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
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
