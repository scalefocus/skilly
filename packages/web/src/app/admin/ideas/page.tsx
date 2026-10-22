"use client";
// The Feature ideas page (SKILLY_SPEC.md §60.5) — platform admins run the What's new Coming soon list.
// Pending (oldest first): Publish… (adds the title, may tidy the text) or Reject… (optional reason).
// Published (most-voted first) is everything on Coming soon, the items with no proposer included:
// Edit… or Close… as Shipped, Duplicate or Won't do. Closed: rejected and closed ideas, read-only,
// with Mark shipped on an idea closed as Planned before v2.41.0. Every write answers 409 when someone
// else got there first; the list then reloads. While suggestions are off for everyone else, a notice
// says so; every action stays available.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  IDEA_DESCRIPTION_MAX,
  IDEA_DESCRIPTION_MIN,
  IDEA_CLOSE_OUTCOMES,
  IDEA_NOTE_MAX,
  IDEA_OUTCOME_LABELS,
  IDEA_TITLE_MAX,
  IDEA_TITLE_MIN,
  ideaTextLength,
  type IdeaCloseOutcome,
  type IdeaOutcome,
} from "@skilly/shared/ideas";
import { EmptyState, Modal, Pill, useApi } from "../../../components/ui";
import { RequireAuth } from "../../../components/RequireAuth";
import { UserBubble } from "../../../components/UserBubble";
import { useDateFmt } from "../../../components/DateFormat";

type Tab = "pending" | "published" | "closed";

interface AdminIdea {
  id: string;
  status: "pending" | "published" | "rejected" | "closed";
  title: string | null;
  description: string;
  submittedDescription: string;
  outcome: IdeaOutcome | null;
  adminNote: string | null;
  author: { id: string; displayName: string; nameHidden: boolean; erased: boolean } | null;
  votes: number;
  createdAt: string;
  decidedAt: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  version: string;
}

interface ListResponse {
  tab: Tab;
  ideas: AdminIdea[];
  counts: Record<Tab, number>;
  hasMore: boolean;
  enabled: boolean;
}

type DialogState =
  | { kind: "publish" | "reject" | "edit" | "close"; idea: AdminIdea }
  | null;

const TABS: { tab: Tab; label: string }[] = [
  { tab: "pending", label: "Pending" },
  { tab: "published", label: "Published" },
  { tab: "closed", label: "Closed" },
];

function AdminIdeas() {
  const fmt = useDateFmt();
  const { data: me, loading: meLoading } = useApi<{ isPlatformAdmin?: boolean }>("/api/me");
  const [tab, setTab] = useState<Tab>("pending");
  const [list, setList] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (t: Tab, offset = 0) => {
    try {
      const r = await fetch(`/api/admin/ideas?status=${t}&offset=${offset}`);
      const j = (await r.json().catch(() => ({}))) as ListResponse & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
      setError(null);
      setList((prev) => (offset > 0 && prev && prev.tab === t ? { ...j, ideas: [...prev.ideas, ...j.ideas] } : j));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (me?.isPlatformAdmin) void load(tab);
  }, [me?.isPlatformAdmin, tab, load]);

  // One write: 204 → reload; anything else → the server's message, then reload (409 means stale).
  const act = async (url: string, method: string, body?: unknown): Promise<boolean> => {
    const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
    if (r?.ok) {
      setNotice(null);
      await load(tab);
      return true;
    }
    const j = (await r?.json().catch(() => ({}))) as { error?: string } | undefined;
    setNotice(j?.error ?? "Something went wrong. Try again.");
    if (r?.status === 409 || r?.status === 404) {
      setDialog(null);
      await load(tab);
    }
    return false;
  };

  if (!meLoading && me && !me.isPlatformAdmin) {
    return <EmptyState icon="🔒" title="Platform admins only" hint="Feature ideas are reviewed by platform administrators." />;
  }

  const disabled = !list;
  return (
    <div style={{ maxWidth: 980 }}>
      <div className="page-head reveal">
        <div className="eyebrow">Administration</div>
        <h1 className="page-title">Feature ideas.</h1>
        <p className="page-sub">What&rsquo;s on Coming soon, and the ideas waiting to join it. Publish the good ones for voting, then close them once they ship or are settled.</p>
      </div>

      {list && !list.enabled && (
        <div className="card card-pad" role="status" style={{ marginBottom: 18 }} data-testid="ideas-off">
          Only platform admins can suggest features right now.{" "}
          <Link href="/admin">Change it in Administration</Link>.
        </div>
      )}

      <div className="sort-toggle" role="group" aria-label="Idea status" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.tab}
            type="button"
            className={`sort-opt${tab === t.tab ? " sort-on" : ""}`}
            aria-pressed={tab === t.tab}
            onClick={() => { setTab(t.tab); setList(null); setNotice(null); }}
            data-testid={`ideas-tab-${t.tab}`}
          >
            {t.label} <span className="muted mono" style={{ fontSize: 11 }}>{list?.counts[t.tab] ?? ""}</span>
          </button>
        ))}
      </div>

      {notice && <p role="alert" style={{ color: "var(--danger)", fontSize: 13.5, marginBottom: 12 }} data-testid="ideas-notice">{notice}</p>}
      {error && !list && <EmptyState icon="⚠" title="Couldn’t load feature ideas" hint={error} />}
      {!list && !error && <div className="skeleton" style={{ height: 140, borderRadius: "var(--radius)" }} />}
      {list && list.ideas.length === 0 && (
        <EmptyState
          title={tab === "pending" ? "Nothing to review" : tab === "published" ? "No published ideas" : "No closed ideas yet"}
          hint={tab === "pending" ? "New suggestions from the What's new page show up here." : undefined}
        />
      )}

      {list && list.ideas.length > 0 && (
        <div style={{ display: "grid", gap: 12 }}>
          {list.ideas.map((idea) => (
            <article key={idea.id} className="card card-pad" data-testid="admin-idea" data-status={idea.status}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {idea.status === "published" && (
                  <span className="chip mono" style={{ fontSize: 12 }} data-testid="admin-idea-votes">▲ {idea.votes}</span>
                )}
                {idea.status === "rejected" && <Pill tone="danger">Not published</Pill>}
                {idea.status === "closed" && idea.outcome && <Pill tone={idea.outcome === "shipped" ? "ok" : "muted"}>{IDEA_OUTCOME_LABELS[idea.outcome]}</Pill>}
                {idea.author ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                    <UserBubble name={idea.author.displayName} avatar={null} userId={idea.author.id} size={20} />
                    {idea.author.displayName}
                    {idea.author.nameHidden && <span className="muted" style={{ fontSize: 12 }}>(name hidden from users)</span>}
                  </span>
                ) : (
                  <span className="muted" style={{ fontSize: 13 }} data-testid="admin-idea-no-proposer">No proposer</span>
                )}
                <span className="muted mono" style={{ fontSize: 11.5, marginLeft: "auto" }}>
                  {fmt.dateTime(idea.status === "pending" ? idea.createdAt : idea.closedAt ?? idea.decidedAt ?? idea.publishedAt ?? idea.createdAt)}
                </span>
              </div>
              {idea.title && <h2 style={{ fontSize: 16, margin: "10px 0 0" }}>{idea.title}</h2>}
              <p style={{ margin: "6px 0 0", fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{idea.description}</p>
              {idea.status !== "pending" && idea.submittedDescription !== idea.description && (
                <details style={{ marginTop: 8 }}>
                  <summary className="muted" style={{ fontSize: 12.5, cursor: "pointer" }}>Show original</summary>
                  <p className="muted" style={{ margin: "6px 0 0", fontSize: 13, whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{idea.submittedDescription}</p>
                </details>
              )}
              {idea.adminNote && (
                <p className="muted" style={{ margin: "8px 0 0", fontSize: 13, whiteSpace: "pre-line" }}>
                  {idea.status === "rejected" ? "Reason: " : "Note: "}{idea.adminNote}
                </p>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                {idea.status === "pending" && (
                  <>
                    <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => setDialog({ kind: "publish", idea })} data-testid="idea-publish">Publish…</button>
                    <button type="button" className="btn" disabled={disabled} onClick={() => setDialog({ kind: "reject", idea })} data-testid="idea-reject">Reject…</button>
                  </>
                )}
                {idea.status === "published" && (
                  <>
                    <button type="button" className="btn" disabled={disabled} onClick={() => setDialog({ kind: "edit", idea })} data-testid="idea-admin-edit">Edit…</button>
                    <button type="button" className="btn" disabled={disabled} onClick={() => setDialog({ kind: "close", idea })} data-testid="idea-close">Close…</button>
                  </>
                )}
                {idea.status === "closed" && idea.outcome === "planned" && (
                  <button
                    type="button"
                    className="btn"
                    disabled={disabled}
                    onClick={() => {
                      if (window.confirm(`Mark "${idea.title ?? "this idea"}" as shipped? This can't be undone, and the proposer is told.`)) void act(`/api/admin/ideas/${idea.id}/ship`, "POST");
                    }}
                    data-testid="idea-ship"
                  >
                    Mark shipped
                  </button>
                )}
              </div>
            </article>
          ))}
          {list.hasMore && (
            <button type="button" className="btn" style={{ justifySelf: "center" }} onClick={() => void load(tab, list.ideas.length)}>Load more</button>
          )}
        </div>
      )}

      {dialog && <IdeaDialog state={dialog} onClose={() => setDialog(null)} act={act} />}
    </div>
  );
}

function IdeaDialog({ state, onClose, act }: { state: NonNullable<DialogState>; onClose: () => void; act: (url: string, method: string, body?: unknown) => Promise<boolean> }) {
  const { kind, idea } = state;
  const [title, setTitle] = useState(idea.title ?? "");
  const [description, setDescription] = useState(idea.description);
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<IdeaCloseOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const descId = useId();
  const noteId = useId();
  const first = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  const titleLength = ideaTextLength(title.replace(/\s+/g, " ").trim());
  const descLength = ideaTextLength(description.trim());
  const titleOk = titleLength >= IDEA_TITLE_MIN && titleLength <= IDEA_TITLE_MAX;
  const descOk = descLength >= IDEA_DESCRIPTION_MIN && descLength <= IDEA_DESCRIPTION_MAX;
  const valid = kind === "publish" || kind === "edit" ? titleOk && descOk : kind === "close" ? outcome !== null : true;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const base = `/api/admin/ideas/${idea.id}`;
    const ok =
      kind === "publish" ? await act(`${base}/publish`, "POST", { title, description, expectedUpdatedAt: idea.version })
      : kind === "reject" ? await act(`${base}/reject`, "POST", { reason: note, expectedUpdatedAt: idea.version })
      : kind === "edit" ? await act(base, "PATCH", { title, description })
      : await act(`${base}/close`, "POST", { outcome, note });
    setBusy(false);
    if (ok) onClose();
  };

  const heading = kind === "publish" ? "Publish idea" : kind === "reject" ? "Reject idea" : kind === "edit" ? "Edit idea" : "Close idea";
  const action = kind === "publish" ? "Publish" : kind === "reject" ? "Reject" : kind === "edit" ? "Save" : "Close idea";
  return (
    <Modal
      title={heading}
      onCancel={onClose}
      initialFocusRef={first}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={`btn ${kind === "reject" ? "" : "btn-primary"}`} onClick={() => void submit()} disabled={!valid || busy} data-testid="idea-dialog-submit">{action}</button>
        </>
      }
    >
      {(kind === "publish" || kind === "edit") && (
        <>
          {kind === "publish" && (
            <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
              Published ideas are visible to every signed-in user. Remove names of people, restricted skills and namespaces.
            </p>
          )}
          <label htmlFor={titleId} style={{ display: "block", fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Title</label>
          <input ref={first} id={titleId} className="input" value={title} maxLength={IDEA_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} style={{ width: "100%" }} data-testid="idea-title" />
          <p className="muted mono" style={{ fontSize: 11.5, margin: "4px 0 12px" }}>{titleLength} / {IDEA_TITLE_MAX}</p>
          <label htmlFor={descId} style={{ display: "block", fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Description</label>
          <textarea id={descId} className="input" rows={6} value={description} maxLength={IDEA_DESCRIPTION_MAX} onChange={(e) => setDescription(e.target.value)} style={{ width: "100%", resize: "vertical", fontSize: 14 }} data-testid="idea-description" />
          <p className="muted mono" style={{ fontSize: 11.5, margin: "4px 0 0" }}>{descLength} / {IDEA_DESCRIPTION_MAX}</p>
        </>
      )}
      {kind === "close" && (
        <fieldset style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
          <legend style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Outcome</legend>
          {IDEA_CLOSE_OUTCOMES.map((o) => (
            <label key={o} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, marginBottom: 6 }}>
              <input type="radio" name="idea-outcome" value={o} checked={outcome === o} onChange={() => setOutcome(o)} data-testid={`idea-outcome-${o}`} />
              {IDEA_OUTCOME_LABELS[o]}
            </label>
          ))}
          <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
            Closing removes the item from Coming soon and deletes its votes. The proposer, if there is one, is told the outcome.
          </p>
        </fieldset>
      )}
      {(kind === "reject" || kind === "close") && (
        <>
          <label htmlFor={noteId} style={{ display: "block", fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
            {kind === "reject" ? "Reason (optional)" : "Note (optional)"}
          </label>
          <textarea
            ref={kind === "reject" ? first : undefined}
            id={noteId}
            className="input"
            rows={3}
            value={note}
            maxLength={IDEA_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            style={{ width: "100%", resize: "vertical", fontSize: 14 }}
            data-testid="idea-note"
          />
          <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 0" }}>{idea.author ? "The proposer sees this." : "Only platform admins see this."}</p>
        </>
      )}
    </Modal>
  );
}

export default function AdminIdeasPage() {
  return (
    <RequireAuth>
      <AdminIdeas />
    </RequireAuth>
  );
}
