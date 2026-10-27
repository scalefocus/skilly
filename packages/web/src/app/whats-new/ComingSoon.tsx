"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useSession } from "next-auth/react";
import {
  COMING_SOON_POLL_MS,
  IDEA_DESCRIPTION_MAX,
  IDEA_DESCRIPTION_MIN,
  IDEA_LIMIT_MESSAGES,
  IDEA_OUTCOME_LABELS,
  VOTE_MOVE_GUARD_MS,
  applyOwnVote,
  comingSoonOrder,
  ideaTextLength,
  ownVoteAnnouncement,
  pollAnswerApplies,
  upvotedByLabel,
  type ComingSoonItem,
  type ComingSoonVoter,
  type IdeaLimitRefusal,
} from "@skilly/shared/ideas";
import { cachedGet, Modal, Pill } from "../../components/ui";
import { UserBubble } from "../../components/UserBubble";
import { useDateFmt } from "../../components/DateFormat";

/** `GET /api/coming-soon` (SKILLY_SPEC.md §60.11). */
interface MyIdea {
  id: string;
  status: "pending" | "published" | "rejected" | "closed";
  description: string;
  title: string | null;
  outcome: keyof typeof IDEA_OUTCOME_LABELS | null;
  adminNote: string | null;
  createdAt: string;
  votes: number;
}
interface ComingSoonData {
  items: ComingSoonItem[];
  mine: MyIdea[];
  limits: { pending: number; pendingMax: number; today: number; dailyMax: number };
  /** Platform admins always; everyone else while the feature-ideas switch is on (§60.4). */
  canSuggest: boolean;
  /** The caller hides their own bubble from everyone else (§60.9); they still see it, marked "only you". */
  votesHidden: boolean;
}

/** A row that left the list, kept a moment at its old place so it can fade out (§60.3). */
interface LeavingRow {
  item: ComingSoonItem;
  index: number;
}

interface ListState {
  data: ComingSoonData;
  leaving: LeavingRow[];
}

/** The fragments the §60.7 notification links use: either one opens the section and scrolls to it. */
const ANCHORS = new Set(["#coming-soon", "#your-ideas"]);
/** A removed row's fade, a new row's fade-in, and a moved row's slide (§60.3). */
const FADE_MS = 200;
const SLIDE_MS = 250;
const SLIDE_ID = "coming-soon-slide";

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** New data in: the rows re-sorted (§60.3 decision 18), and the rows that left kept for their fade. */
function nextListState(prev: ListState | null, data: ComingSoonData, animate: boolean): ListState {
  const items = comingSoonOrder(data.items);
  if (!prev || !animate) return { data: { ...data, items }, leaving: [] };
  const ids = new Set(items.map((i) => i.id));
  const gone = prev.data.items.flatMap((item, index) => (ids.has(item.id) ? [] : [{ item, index }]));
  const still = prev.leaving.filter((l) => !ids.has(l.item.id) && !gone.some((g) => g.item.id === l.item.id));
  return { data: { ...data, items }, leaving: [...still, ...gone] };
}

/** The rows to render: the live items, with the leaving ones back at their old places. */
function withLeaving(items: ComingSoonItem[], leaving: LeavingRow[]): { item: ComingSoonItem; out: boolean }[] {
  const rows = items.map((item) => ({ item, out: false }));
  for (const l of [...leaving].sort((a, b) => a.index - b.index)) rows.splice(Math.min(l.index, rows.length), 0, { item: l.item, out: true });
  return rows;
}

/**
 * The "Coming soon" section above the release list (SKILLY_SPEC.md §23, §60.3): every published
 * feature idea, ordered by votes and kept in that order live, with an upvote and an "Upvoted by"
 * strip on every row, a "Suggest a feature" button beside the heading for a caller who may suggest,
 * and the caller's own ideas underneath. Nothing renders until the list has loaded, so the first
 * paint already shows the real counts; if it fails to load the section stays hidden. Once shown, it
 * stays for the visit. Collapsed on every visit, except when the URL fragment points into it.
 */
export function ComingSoon() {
  const [state, setState] = useState<ListState | null>(null);
  // The last body's tag: polls send it, and an unchanged list answers 304 with no body (§60.11).
  const etag = useRef<string | null>(null);
  const shown = useRef(false);
  // The open list registers its "just before the rows change" measurement here (the slide, §60.3).
  const beforeChange = useRef<() => void>(() => {});

  const update = useCallback((fn: (d: ComingSoonData) => ComingSoonData) => {
    beforeChange.current();
    const animate = !reducedMotion();
    setState((s) => (s ? nextListState(s, fn(s.data), animate) : s));
  }, []);

  // One fetch of the list. `conditional` sends the last tag; `accepts` decides on arrival whether the
  // answer may still replace the list (a poll that the caller's own vote overtook may not, §60.3).
  const fetchList = useCallback(async (opts: { conditional?: boolean; accepts?: () => boolean } = {}): Promise<boolean> => {
    try {
      const headers: Record<string, string> = opts.conditional && etag.current ? { "if-none-match": etag.current } : {};
      const r = await fetch("/api/coming-soon", { cache: "no-store", headers });
      if (r.status === 304) return true;
      if (!r.ok) return false;
      const body = (await r.json()) as ComingSoonData;
      if (opts.accepts && !opts.accepts()) return false;
      etag.current = r.headers.get("etag");
      beforeChange.current();
      const animate = !reducedMotion();
      setState((s) => nextListState(s, body, animate));
      return true;
    } catch {
      return false;
    }
  }, []);
  const load = useCallback(() => fetchList(), [fetchList]);
  const poll = useCallback((accepts: () => boolean) => fetchList({ conditional: true, accepts }), [fetchList]);

  useEffect(() => {
    void load();
  }, [load]);

  // A row that left fades for FADE_MS, then goes for good (and the rows below slide up).
  const leaving = state?.leaving;
  useEffect(() => {
    if (!leaving?.length) return;
    const t = window.setTimeout(() => {
      beforeChange.current();
      setState((s) => (s ? { ...s, leaving: [] } : s));
    }, FADE_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);

  if (state === null) return null;
  // Nothing to list, nothing of theirs and no button to offer: hide the section (§60.3). That is
  // decided on the first load only: once shown, a list a poll emptied says so instead.
  if (!shown.current && !state.data.canSuggest && state.data.items.length === 0 && state.data.mine.length === 0) return null;
  shown.current = true;
  return <LiveComingSoon data={state.data} leaving={state.leaving} update={update} reload={load} poll={poll} beforeChange={beforeChange} />;
}

type DialogState = { mode: "suggest" } | { mode: "edit"; idea: MyIdea } | null;

/** Who the caller is, for their own optimistic bubble: the id from /api/me, the name and picture from the session. */
function useMe(): { id: string; displayName: string; avatar: string | null } | null {
  const { data: session } = useSession();
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    cachedGet<{ userId?: string | null }>("/api/me")
      .then((j) => {
        if (live && j?.userId) setId(j.userId);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return id ? { id, displayName: session?.user?.name ?? "You", avatar: session?.user?.image ?? null } : null;
}

function LiveComingSoon({
  data,
  leaving,
  update,
  reload,
  poll,
  beforeChange,
}: {
  data: ComingSoonData;
  leaving: LeavingRow[];
  /** Functional update — votes resolve out of order, so each one patches the latest state. */
  update: (fn: (d: ComingSoonData) => ComingSoonData) => void;
  reload: () => Promise<boolean>;
  /** A conditional re-fetch; `accepts` is asked on arrival whether the answer may still apply. */
  poll: (accepts: () => boolean) => Promise<boolean>;
  beforeChange: RefObject<() => void>;
}) {
  const fmt = useDateFmt();
  const listId = useId();
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState<string | null>(null);
  // The item whose "Upvoted by" list is open, if any.
  const [votersOf, setVotersOf] = useState<string | null>(null);
  const [announceFor, setAnnounceFor] = useState<{ id: string; on: boolean } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // Rows with a vote request in flight: further clicks on them are ignored until it settles, so a
  // double click can never send a PUT and a DELETE that race each other.
  const voting = useRef(new Set<string>());
  // Bumped when one of the caller's votes starts and when it settles: a poll asked for before that
  // may not overwrite the list (§60.3 "the caller's votes win").
  const voteSeq = useRef(0);
  // Where to scroll once the list has rendered open: a notification link's fragment, or "Your ideas"
  // after a suggestion.
  const scrollTo = useRef<string | null>(null);
  const latest = useRef(data);
  latest.current = data;

  // ── The slide (FLIP): measure every row just before a change, then play each move after it ─────
  const listRef = useRef<HTMLUListElement>(null);
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  const first = useRef<Map<string, number> | null>(null);
  const focusBefore = useRef<HTMLElement | null>(null);
  // When each row last moved: its vote button ignores clicks for VOTE_MOVE_GUARD_MS after.
  const movedAt = useRef(new Map<string, number>());

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const top = list.getBoundingClientRect().top;
    first.current = new Map([...rowEls.current].map(([id, el]) => [id, el.getBoundingClientRect().top - top]));
    const active = document.activeElement;
    focusBefore.current = active instanceof HTMLElement && list.contains(active) ? active : null;
  }, []);
  useLayoutEffect(() => {
    beforeChange.current = measure;
    return () => {
      beforeChange.current = () => {};
    };
  }, [beforeChange, measure]);

  useLayoutEffect(() => {
    const was = first.current;
    first.current = null;
    const list = listRef.current;
    if (!was || !list) return;
    // React moves a reordered row by re-inserting it, which drops the focus inside it: put it back,
    // or on the list when its row has gone.
    const focused = focusBefore.current;
    focusBefore.current = null;
    if (focused && document.activeElement !== focused) {
      if (focused.isConnected && !focused.closest("[data-leaving]")) focused.focus({ preventScroll: true });
      else list.focus({ preventScroll: true });
    }
    const animate = !reducedMotion();
    const top = list.getBoundingClientRect().top;
    const now = performance.now();
    for (const [id, el] of rowEls.current) {
      for (const a of el.getAnimations()) if (a.id === SLIDE_ID) a.cancel();
      const y = el.getBoundingClientRect().top - top;
      const from = was.get(id);
      if (from === undefined) {
        if (animate) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "ease-out" });
        continue;
      }
      if (Math.abs(from - y) < 1) continue;
      movedAt.current.set(id, now);
      if (animate) {
        const slide = el.animate([{ transform: `translateY(${from - y}px)` }, { transform: "translateY(0)" }], { duration: SLIDE_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
        slide.id = SLIDE_ID;
      }
    }
  });

  // ── Polling (§60.3): every 15 s while expanded and visible, and at once on expand / return ─────
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let busy = false;
    const tick = () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      const asked = voteSeq.current;
      void poll(() => !stopped && pollAnswerApplies(asked, voteSeq.current, voting.current.size)).finally(() => {
        busy = false;
      });
    };
    tick();
    const timer = window.setInterval(tick, COMING_SOON_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [open, poll]);

  useEffect(() => {
    const hash = window.location.hash;
    if (ANCHORS.has(hash)) {
      scrollTo.current = hash.slice(1);
      setOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!open || !scrollTo.current) return;
    const el = document.getElementById(scrollTo.current);
    if (!el) return;
    scrollTo.current = null;
    el.scrollIntoView({ block: "start" });
  });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // The polite announcement of the caller's own vote, read once it settles (§60.3 "Screen readers").
  useEffect(() => {
    if (!announceFor) return;
    const items = latest.current.items;
    const k = items.findIndex((i) => i.id === announceFor.id);
    if (k >= 0) setAnnouncement(ownVoteAnnouncement(announceFor.on, items[k]!.title, items[k]!.votes, k + 1, items.length));
  }, [announceFor]);

  // Optimistic vote: count, ▲ and the caller's own bubble flip at once and the list re-sorts; the
  // route's answer settles them; a failure reverts and says so.
  const vote = async (item: ComingSoonItem) => {
    const id = item.id;
    if (voting.current.has(id)) return;
    // A row that just slid under the pointer ignores clicks a moment (VOTE_MOVE_GUARD_MS, §60.3).
    if (performance.now() - (movedAt.current.get(id) ?? -Infinity) < VOTE_MOVE_GUARD_MS) return;
    voting.current.add(id);
    voteSeq.current += 1;
    const on = !item.voted;
    const patch = (fn: (i: ComingSoonItem) => ComingSoonItem) => update((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? fn(i) : i)) }));
    patch((i) => applyOwnVote(i, on, me, data.votesHidden));
    try {
      const r = await fetch(`/api/coming-soon/ideas/${id}/vote`, { method: on ? "PUT" : "DELETE" });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as Pick<ComingSoonItem, "votes" | "voted" | "voters" | "votersTotal">;
      patch((i) => ({ ...i, votes: j.votes, voted: j.voted, voters: j.voters, votersTotal: j.votersTotal }));
      setAnnounceFor({ id, on: j.voted });
    } catch {
      patch((i) => ({ ...i, votes: item.votes, voted: item.voted, voters: item.voters, votersTotal: item.votersTotal }));
      setToast("Couldn't save your vote. Try again.");
    } finally {
      voting.current.delete(id);
      voteSeq.current += 1;
    }
  };

  const withdraw = async (idea: MyIdea) => {
    if (!window.confirm("Withdraw this idea? It won't be reviewed, and it still counts toward today's limit.")) return;
    const r = await fetch(`/api/coming-soon/ideas/${idea.id}`, { method: "DELETE" }).catch(() => null);
    setToast(r?.ok ? "Idea withdrawn" : "Couldn't withdraw the idea. It may already have been reviewed.");
    await reload();
  };

  const onSaved = async (message: string) => {
    setDialog(null);
    setToast(message);
    scrollTo.current = "your-ideas";
    setOpen(true);
    await reload();
  };

  const n = data.items.length;
  const rows = withLeaving(data.items, leaving);
  return (
    <section className="coming-soon" id="coming-soon" data-testid="coming-soon">
      <div className="coming-soon-headrow">
        <button type="button" className="coming-soon-head" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
          <CompassGlyph />
          <span className="coming-soon-text">
            <span className="coming-soon-title">Coming soon · {n}</span>
            <span className="muted coming-soon-sub">Most-voted first: the most wanted are next in line. Nothing here is available yet, and plans can change.</span>
          </span>
          <Chevron open={open} />
        </button>
        {data.canSuggest && (
          <button type="button" className="btn coming-soon-suggest" onClick={() => setDialog({ mode: "suggest" })} data-testid="suggest-feature">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            Suggest a feature
          </button>
        )}
      </div>
      {open && (
        <div id={listId}>
          {rows.length === 0 ? (
            <p className="muted coming-soon-empty">{data.canSuggest ? "Nothing here yet. Suggest a feature to get the list started." : "Nothing here yet."}</p>
          ) : (
            <ul aria-label="Coming soon" className="coming-soon-list" ref={listRef} tabIndex={-1}>
              {rows.map(({ item, out }) => (
                <li
                  key={item.id}
                  ref={(el) => {
                    if (el) rowEls.current.set(item.id, el);
                    else rowEls.current.delete(item.id);
                  }}
                  className={`coming-soon-row coming-soon-voted${out ? " coming-soon-row-out" : ""}`}
                  data-testid={out ? undefined : "coming-soon-row"}
                  data-leaving={out || undefined}
                  aria-hidden={out || undefined}
                  inert={out || undefined}
                >
                  <div className="coming-soon-row-main">
                    <span className="chip" style={{ fontSize: 12 }}>Coming soon</span>
                    <div className="coming-soon-row-title">{item.title}</div>
                    <p className="coming-soon-row-teaser" style={{ whiteSpace: "pre-line" }}>{item.description}</p>
                    {item.suggestedBy && (
                      <div className="coming-soon-row-by" data-testid="suggested-by">
                        Suggested by
                        <UserBubble name={item.suggestedBy.displayName} avatar={item.suggestedBy.avatar} userId={item.suggestedBy.id} size={18} />
                        <span>{item.suggestedBy.displayName}</span>
                      </div>
                    )}
                    {item.votersTotal > 0 && (
                      <UpvotedBy
                        item={item}
                        viewerId={me?.id ?? null}
                        open={votersOf === item.id && !out}
                        onToggle={() => setVotersOf((v) => (v === item.id ? null : item.id))}
                        onClose={() => setVotersOf(null)}
                      />
                    )}
                  </div>
                  <button
                    type="button"
                    className={`vote-btn${item.voted ? " vote-on" : ""}`}
                    aria-pressed={item.voted}
                    aria-label={`Upvote ${item.title}, ${item.votes} ${item.votes === 1 ? "vote" : "votes"}`}
                    onClick={() => void vote(item)}
                    data-testid="vote-button"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M12 5 20 17H4z" />
                    </svg>
                    <span className="vote-count">{item.votes}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data.mine.length > 0 && (
            <div id="your-ideas" className="your-ideas" data-testid="your-ideas">
              <h3 className="your-ideas-title">Your ideas</h3>
              <ul className="your-ideas-list">
                {data.mine.map((idea) => (
                  <li key={idea.id} className="your-idea" data-testid="your-idea" data-status={idea.status}>
                    <div className="your-idea-head">
                      <IdeaStatusPill idea={idea} />
                      <span className="muted mono" style={{ fontSize: 11.5 }}>{fmt.date(idea.createdAt)}</span>
                      {idea.status === "published" && (
                        <span className="muted" style={{ fontSize: 12 }}>{idea.votes} {idea.votes === 1 ? "vote" : "votes"}</span>
                      )}
                    </div>
                    {idea.title && <div className="your-idea-title">{idea.title}</div>}
                    <p className="your-idea-text">{idea.description}</p>
                    {idea.adminNote && (
                      <p className="muted your-idea-note">{idea.status === "rejected" ? "Reason: " : "Note: "}{idea.adminNote}</p>
                    )}
                    {idea.status === "pending" && (
                      <div className="your-idea-actions">
                        <button type="button" className="btn btn-ghost" onClick={() => setDialog({ mode: "edit", idea })} data-testid="idea-edit">Edit</button>
                        <button type="button" className="btn btn-ghost" onClick={() => void withdraw(idea)} data-testid="idea-withdraw">Withdraw</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="sr-only" aria-live="polite" data-testid="vote-announcement">{announcement}</div>
      {dialog && <SuggestDialog state={dialog} limits={data.limits} onClose={() => setDialog(null)} onSaved={onSaved} onStale={() => { setDialog(null); void reload(); }} />}
      {toast && typeof document !== "undefined" && createPortal(<div className="toast" role="status">{toast}</div>, document.body)}
    </section>
  );
}

/**
 * §60.3 decision 19: "Upvoted by", up to five overlapping bubbles (newest vote first) and "+N". The
 * whole strip is one button that opens the full list, so a row adds one tab stop; the bubbles in it
 * are decorative (a name tooltip, no hover card). The viewer's own bubble, while they hide their
 * votes, is dimmed with a dashed ring and marked "only you".
 */
function UpvotedBy({
  item,
  viewerId,
  open,
  onToggle,
  onClose,
}: {
  item: ComingSoonItem;
  viewerId: string | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const strip = useRef<HTMLButtonElement>(null);
  const more = item.votersTotal - item.voters.length;
  const close = useCallback(() => {
    onClose();
    strip.current?.focus();
  }, [onClose]);
  return (
    <div className="coming-soon-row-by upvoted-by" data-testid="upvoted-by">
      Upvoted by
      <span className="upvoted-by-anchor" ref={anchor}>
        <button
          ref={strip}
          type="button"
          className="voter-strip"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={upvotedByLabel(item.voters, item.votersTotal, viewerId)}
          onClick={onToggle}
          data-testid="voter-strip"
        >
          {item.voters.map((v) => (
            <span
              key={v.id}
              className={`voter-face${v.onlyYou ? " voter-only-you" : ""}`}
              title={v.onlyYou ? "You: only you see this" : v.id === viewerId ? "You" : v.displayName}
              data-testid="voter-face"
              data-voter={v.id}
              data-only-you={v.onlyYou ? "true" : undefined}
            >
              <UserBubble name={v.displayName} avatar={v.avatar} size={20} />
            </span>
          ))}
          {more > 0 && <span className="voter-more" data-testid="voter-more">+{more}</span>}
        </button>
        {open && <VotersPopover ideaId={item.id} votes={item.votes} viewerId={viewerId} anchor={anchor} onClose={close} />}
      </span>
    </div>
  );
}

type VotersAnswer = { voters: ComingSoonVoter[]; votersTotal: number; hiddenCount: number };

/** The full "Upvoted by" list (§60.3): a snapshot loaded on open, not polled. */
function VotersPopover({
  ideaId,
  votes,
  viewerId,
  anchor,
  onClose,
}: {
  ideaId: string;
  votes: number;
  viewerId: string | null;
  anchor: RefObject<HTMLSpanElement | null>;
  onClose: () => void;
}) {
  const [list, setList] = useState<VotersAnswer | "gone" | "failed" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let live = true;
    fetch(`/api/coming-soon/ideas/${ideaId}/voters`)
      .then(async (r) => {
        if (!live) return;
        if (r.status === 404) setList("gone");
        else if (!r.ok) setList("failed");
        else setList((await r.json()) as VotersAnswer);
      })
      .catch(() => {
        if (live) setList("failed");
      });
    return () => {
      live = false;
    };
  }, [ideaId]);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    // A press anywhere outside the strip and the list closes it; the strip itself toggles it.
    const onDown = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [anchor]);

  return (
    <div ref={ref} role="dialog" aria-labelledby={titleId} tabIndex={-1} className="voters-pop" data-testid="voters-list">
      <div id={titleId} className="voters-pop-title">
        Upvoted by <span className="muted">· ▲ {votes}</span>
      </div>
      {list === null ? (
        <p className="muted voters-pop-note">Loading…</p>
      ) : list === "gone" ? (
        <p className="muted voters-pop-note">This item is no longer on the list.</p>
      ) : list === "failed" ? (
        <p className="muted voters-pop-note">Couldn&rsquo;t load who upvoted. Try again.</p>
      ) : (
        <>
          <ul className="voters-pop-list">
            {list.voters.map((v) => (
              <li key={v.id} data-testid="voters-list-row">
                <UserBubble name={v.displayName} avatar={v.avatar} userId={v.id} size={22} />
                <span>
                  {v.id === viewerId ? "You" : v.displayName}
                  {v.onlyYou && <span className="muted"> · only you see this</span>}
                </span>
              </li>
            ))}
          </ul>
          {list.votersTotal > list.voters.length && (
            <p className="muted voters-pop-note">and {list.votersTotal - list.voters.length} more</p>
          )}
          {list.hiddenCount > 0 && (
            <p className="muted voters-pop-note" data-testid="voters-hidden">
              {list.hiddenCount} more {list.hiddenCount === 1 ? "keeps their upvote" : "keep their upvotes"} private
            </p>
          )}
        </>
      )}
    </div>
  );
}

function IdeaStatusPill({ idea }: { idea: MyIdea }) {
  if (idea.status === "pending") return <Pill tone="warn">Pending review</Pill>;
  if (idea.status === "published") return <Pill tone="ok">Published</Pill>;
  if (idea.status === "rejected") return <Pill tone="danger">Not published</Pill>;
  const outcome = idea.outcome ?? "planned";
  return <Pill tone={outcome === "shipped" ? "ok" : outcome === "planned" ? "accent" : "muted"}>{IDEA_OUTCOME_LABELS[outcome]}</Pill>;
}

/** §60.4 the "Suggest a feature" dialog — or, for a pending idea, its edit form. */
function SuggestDialog({
  state,
  limits,
  onClose,
  onSaved,
  onStale,
}: {
  state: NonNullable<DialogState>;
  limits: ComingSoonData["limits"];
  onClose: () => void;
  onSaved: (message: string) => void;
  onStale: () => void;
}) {
  const editing = state.mode === "edit";
  const [text, setText] = useState(editing ? state.idea.description : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const helpId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  // At a cap already: say so instead of offering a form that can only fail (§60.4).
  const cap: IdeaLimitRefusal | null = editing ? null : limits.pending >= limits.pendingMax ? "pending_limit" : limits.today >= limits.dailyMax ? "daily_limit" : null;
  const length = ideaTextLength(text.trim());
  const valid = length >= IDEA_DESCRIPTION_MIN && length <= IDEA_DESCRIPTION_MAX;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = editing
        ? await fetch(`/api/coming-soon/ideas/${state.idea.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: text }) })
        : await fetch("/api/coming-soon/ideas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: text }) });
      if (r.ok) {
        onSaved(editing ? "Your idea was updated" : "Thanks, your idea is waiting for review");
        return;
      }
      if (editing && r.status === 409) {
        onStale();
        return;
      }
      // 429 at a cap, or 403 when suggestions were switched off since the page loaded (§60.4).
      const j = (await r.json().catch(() => ({}))) as { error?: string; reason?: string };
      const capped = j.reason === "pending_limit" || j.reason === "daily_limit" ? IDEA_LIMIT_MESSAGES[j.reason] : null;
      setError(capped ?? j.error ?? `Couldn't save (${r.status}).`);
    } catch {
      setError("Couldn't save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? "Edit your idea" : "Suggest a feature"}
      onCancel={onClose}
      initialFocusRef={cap ? undefined : ref}
      footer={
        cap ? (
          <button type="button" className="btn" onClick={onClose}>Close</button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={!valid || busy} data-testid="idea-submit">
              {editing ? "Save" : "Submit"}
            </button>
          </>
        )
      }
    >
      {cap ? (
        <p data-testid="idea-cap" style={{ margin: 0 }}>{IDEA_LIMIT_MESSAGES[cap]}</p>
      ) : (
        <>
          <label htmlFor={fieldId} style={{ display: "block", fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Describe the feature</label>
          <textarea
            ref={ref}
            id={fieldId}
            className="input"
            aria-describedby={helpId}
            rows={6}
            maxLength={IDEA_DESCRIPTION_MAX}
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ width: "100%", resize: "vertical", fontSize: 14 }}
            data-testid="idea-text"
          />
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 6 }}>
            <p id={helpId} className="muted" style={{ fontSize: 12.5, margin: 0 }}>
              What should skilly do, and what problem would it solve? A platform admin reviews every suggestion before it&rsquo;s published for voting.
            </p>
            <span className={`mono${length > 0 && !valid ? "" : " muted"}`} style={{ fontSize: 11.5, whiteSpace: "nowrap", color: length > 0 && !valid ? "var(--danger)" : undefined }} aria-live="polite">
              {length} / {IDEA_DESCRIPTION_MAX}
            </span>
          </div>
          {length > 0 && length < IDEA_DESCRIPTION_MIN && (
            <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>At least {IDEA_DESCRIPTION_MIN} characters.</p>
          )}
          {error && <p role="alert" style={{ color: "var(--danger)", fontSize: 13, margin: "10px 0 0" }} data-testid="idea-error">{error}</p>}
        </>
      )}
    </Modal>
  );
}

function CompassGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="coming-soon-glyph">
      <circle cx="12" cy="12" r="10" />
      <path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="admin-card-chevron" data-open={open}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
