"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  IDEA_DESCRIPTION_MAX,
  IDEA_DESCRIPTION_MIN,
  IDEA_LIMIT_MESSAGES,
  IDEA_OUTCOME_LABELS,
  ideaTextLength,
  type ComingSoonItem,
  type IdeaLimitRefusal,
} from "@skilly/shared/ideas";
import { Modal, Pill } from "../../components/ui";
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
}

/** The fragments the §60.7 notification links use: either one opens the section and scrolls to it. */
const ANCHORS = new Set(["#coming-soon", "#your-ideas"]);

/**
 * The "Coming soon" section above the release list (SKILLY_SPEC.md §23, §60.3): every published
 * feature idea, ordered by votes, with an upvote on every row, a "Suggest a feature" button beside the
 * heading for a caller who may suggest, and the caller's own ideas underneath. Nothing renders until
 * the list has loaded, so the count never changes after first paint; if it fails to load the section
 * stays hidden. Collapsed on every visit, except when the URL fragment points into it.
 */
export function ComingSoon() {
  const [data, setData] = useState<ComingSoonData | null>(null);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const r = await fetch("/api/coming-soon");
      if (!r.ok) return false;
      setData((await r.json()) as ComingSoonData);
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === null) return null;
  // Nothing to list, nothing of theirs and no button to offer: hide the section (§60.3).
  if (!data.canSuggest && data.items.length === 0 && data.mine.length === 0) return null;
  return <LiveComingSoon data={data} update={(fn) => setData((d) => (d ? fn(d) : d))} reload={load} />;
}

type DialogState = { mode: "suggest" } | { mode: "edit"; idea: MyIdea } | null;

function LiveComingSoon({
  data,
  update,
  reload,
}: {
  data: ComingSoonData;
  /** Functional update — votes resolve out of order, so each one patches the latest state. */
  update: (fn: (d: ComingSoonData) => ComingSoonData) => void;
  reload: () => Promise<boolean>;
}) {
  const fmt = useDateFmt();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Rows with a vote request in flight: further clicks on them are ignored until it settles, so a
  // double click can never send a PUT and a DELETE that race each other.
  const voting = useRef(new Set<string>());
  // Where to scroll once the list has rendered open: a notification link's fragment, or "Your ideas"
  // after a suggestion.
  const scrollTo = useRef<string | null>(null);

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

  // Optimistic vote: flip in place, revert on failure. Never re-sorts — rows stay put until the next load.
  const vote = async (item: ComingSoonItem) => {
    const id = item.id;
    if (voting.current.has(id)) return;
    voting.current.add(id);
    const next = !item.voted;
    const patch = (voted: boolean, votes: number) =>
      update((d) => ({ ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, voted, votes } : i)) }));
    patch(next, Math.max(0, item.votes + (next ? 1 : -1)));
    try {
      const r = await fetch(`/api/coming-soon/ideas/${item.id}/vote`, { method: next ? "PUT" : "DELETE" });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { votes: number; voted: boolean };
      patch(j.voted, j.votes);
    } catch {
      patch(item.voted, item.votes);
      setToast("Couldn't save your vote. Try again.");
    } finally {
      voting.current.delete(id);
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
          {n === 0 ? (
            <p className="muted coming-soon-empty">{data.canSuggest ? "Nothing here yet. Suggest a feature to get the list started." : "Nothing here yet."}</p>
          ) : (
            <ul aria-label="Coming soon" className="coming-soon-list">
              {data.items.map((item) => (
                <li key={item.id} className="coming-soon-row coming-soon-voted" data-testid="coming-soon-row">
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
      {dialog && <SuggestDialog state={dialog} limits={data.limits} onClose={() => setDialog(null)} onSaved={onSaved} onStale={() => { setDialog(null); void reload(); }} />}
      {toast && typeof document !== "undefined" && createPortal(<div className="toast" role="status">{toast}</div>, document.body)}
    </section>
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
