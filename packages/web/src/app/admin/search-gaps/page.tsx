"use client";
// The Search gaps page (SKILLY_SPEC.md §62.7) — searches that found nothing, with no one's identity
// attached. To review (most people first): Create request… (a Platform request, §62.10), Add
// synonym… (the §34.8 group editor, prefilled) or Dismiss… (never suggested again); Redraft asks the
// AI again. Probably noise: the gaps the AI called noise, same actions. Accepted: the last 90 days,
// read-only. Every write answers 409 when a sweep or another admin changed the gap; the list reloads.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import type { GapTab, SearchGapStatus, SearchGapView } from "@skilly/shared/search-gaps";
import { EmptyState, Modal, Pill, useApi } from "../../../components/ui";
import { RequireAuth } from "../../../components/RequireAuth";
import { useDateFmt } from "../../../components/DateFormat";
import { useAiName } from "../../../components/AiName";

interface ListResponse {
  gaps: SearchGapView[];
  counts: Record<GapTab, number>;
  status: SearchGapStatus;
}

type DialogState = { kind: "request" | "synonym" | "dismiss"; gap: SearchGapView } | null;
type Similar = { openRequest: { id: string; title: string } | null; catalogSkill: { namespaceSlug: string; skillSlug: string; title: string } | null };
type Act = (url: string, method: string, body?: unknown, success?: string) => Promise<boolean>;
/** After a dialog write: reload the list, with a toast on success or the server's message on a 409. */
type Done = (success?: string, notice?: string) => Promise<void>;

const TABS: { tab: GapTab; label: string }[] = [
  { tab: "review", label: "To review" },
  { tab: "noise", label: "Probably noise" },
  { tab: "accepted", label: "Accepted" },
];

/** A day (YYYY-MM-DD, UTC) shown in the viewer's date style, never with a time (§62.7). */
function useDay(): (day: string) => string {
  const fmt = useDateFmt();
  return (day) => fmt.date(`${day}T12:00:00Z`);
}

function SearchGaps() {
  const fmt = useDateFmt();
  const day = useDay();
  const aiName = useAiName();
  const { data: me, loading: meLoading } = useApi<{ isPlatformAdmin?: boolean }>("/api/me");
  const [tab, setTab] = useState<GapTab>("review");
  const [list, setList] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async (t: GapTab) => {
    try {
      const r = await fetch(`/api/admin/search-gaps?tab=${t}`);
      const j = (await r.json().catch(() => ({}))) as ListResponse & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
      setError(null);
      setList(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (me?.isPlatformAdmin) void load(tab);
  }, [me?.isPlatformAdmin, tab, load]);

  const act: Act = async (url, method, body, success) => {
    const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
    if (r?.ok) {
      setNotice(null);
      if (success) setToast(success);
      await load(tab);
      return true;
    }
    const j = (await r?.json().catch(() => ({}))) as { error?: string } | undefined;
    if (r?.status === 409 || r?.status === 404) {
      setNotice(j?.error ?? "This search gap changed since you opened it.");
      setDialog(null);
      await load(tab);
      return false;
    }
    setNotice(j?.error ?? "Something went wrong. Try again.");
    return false;
  };

  const done: Done = async (success, msg) => {
    if (success) setToast(success);
    setNotice(msg ?? null);
    await load(tab);
  };

  if (!meLoading && me && !me.isPlatformAdmin) {
    return <EmptyState icon="🔒" title="Platform admins only" hint="Search gaps are reviewed by platform administrators." />;
  }

  const st = list?.status;
  const disabled = !list;
  return (
    <div style={{ maxWidth: 980 }}>
      <div className="page-head reveal">
        <div className="eyebrow">Administration</div>
        <h1 className="page-title">Search gaps.</h1>
        <p className="page-sub">Searches that found nothing, with no one&rsquo;s identity attached. Turn them into a synonym or a skill request, or dismiss them.</p>
      </div>

      {st && (
        <div className="card card-pad" role="status" style={{ marginBottom: 14, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }} data-testid="search-gaps-status">
          <span style={{ fontSize: 13.5 }}>
            {st.enabled
              ? <>Collecting · every {st.sweepHours} h · at least {st.minSearchers} {st.minSearchers === 1 ? "person" : "people"} in the last {st.lookbackDays} days
                  {st.lastRun ? <> · last run {fmt.dateTime(st.lastRun.startedAt)}{st.lastRun.ok ? ` (${st.lastRun.newGaps} new)` : " (failed)"}</> : " · not run yet"}
                  {st.runRequested ? " · run requested" : ""}</>
              : "Collection is off."}
          </span>
          <Link href="/admin#search" style={{ fontSize: 13 }}>Settings</Link>
          <button
            type="button"
            className="btn"
            style={{ marginLeft: "auto" }}
            disabled={!st.enabled || st.runRequested}
            onClick={() => void act("/api/admin/search-gaps/run", "POST", undefined, "The sweep starts within a minute")}
            data-testid="search-gaps-run-now"
          >
            Run now
          </button>
          {!st.aiOperational && (
            <p className="muted" style={{ fontSize: 12.5, margin: 0, flexBasis: "100%" }} data-testid="search-gaps-ai-off">
              {aiName} is unavailable, so new gaps get no drafts. You can still act on them.
            </p>
          )}
        </div>
      )}

      <div className="sort-toggle" role="group" aria-label="Search gap list" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.tab}
            type="button"
            className={`sort-opt${tab === t.tab ? " sort-on" : ""}`}
            aria-pressed={tab === t.tab}
            onClick={() => { setTab(t.tab); setList(null); setNotice(null); }}
            data-testid={`search-gaps-tab-${t.tab}`}
          >
            {t.label} <span className="muted mono" style={{ fontSize: 11 }}>{list?.counts[t.tab] ?? ""}</span>
          </button>
        ))}
      </div>

      {notice && <p role="alert" style={{ color: "var(--danger)", fontSize: 13.5, marginBottom: 12 }} data-testid="search-gaps-notice">{notice}</p>}
      {error && !list && <EmptyState icon="⚠" title="Couldn’t load search gaps" hint={error} />}
      {!list && !error && <div className="skeleton" style={{ height: 140, borderRadius: "var(--radius)" }} />}
      {list && list.gaps.length === 0 && (
        <EmptyState
          title={tab === "review" ? "Nothing to review" : tab === "noise" ? "No noise" : "Nothing accepted yet"}
          hint={tab === "review" ? (st?.enabled ? "Searches that keep finding nothing show up here after the next run." : "Turn on collection in Administration → Search.") : undefined}
        />
      )}

      {list && list.gaps.length > 0 && (
        <div style={{ display: "grid", gap: 12 }}>
          {list.gaps.map((g) => (
            <article key={g.id} className="card card-pad" data-testid="search-gap" data-state={g.state}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <code className="chip mono" style={{ fontSize: 13 }} data-testid="search-gap-query">{g.query}</code>
                <Pill tone={g.mode === "none" ? "danger" : "muted"}>{g.mode === "none" ? "No results" : "Partial matches only"}</Pill>
                {g.surfaces.map((s) => <span key={s} className="chip" style={{ fontSize: 11.5 }}>{s === "web" ? "Web" : "MCP"}</span>)}
                {g.outcome && <Pill tone="ok">{g.outcome === "request" ? "Request created" : "Synonym added"}</Pill>}
              </div>
              <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
                <span title="Counted per day: one person searching on three days counts three times.">up to {g.searchers} {g.searchers === 1 ? "person" : "people"}</span>
                {" · "}{g.hits} {g.hits === 1 ? "search" : "searches"} · last searched {day(g.lastDay)}
              </p>
              {g.restrictedMatches.length > 0 && (
                <p style={{ margin: "6px 0 0", fontSize: 13 }} data-testid="search-gap-restricted">
                  Would have matched:{" "}
                  {g.restrictedMatches.map((m, i) => (
                    <span key={`${m.ns}/${m.slug}`}>{i > 0 && ", "}<Link href={`/skills/${m.ns}/${m.slug}`}>{m.ns}/{m.slug}</Link></span>
                  ))}{" "}
                  <span className="muted">(visible only in their namespaces)</span>
                </p>
              )}
              <DraftView gap={g} aiOperational={!!st?.aiOperational} aiName={aiName} />
              {g.state === "accepted" ? (
                <p className="muted" style={{ margin: "10px 0 0", fontSize: 12.5 }}>
                  {g.outcomeRequestId && <><Link href={`/requests/${g.outcomeRequestId}`}>Open the request</Link> · </>}
                  {g.outcome === "synonym" && <><Link href="/admin#search">Synonym groups</Link> · </>}
                  {g.decidedBy ? `${g.decidedBy.displayName}, ` : ""}{g.decidedAt ? fmt.dateTime(g.decidedAt) : ""}
                </p>
              ) : (
                <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                  <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => setDialog({ kind: "request", gap: g })} data-testid="search-gap-request">Create request…</button>
                  <button type="button" className="btn" disabled={disabled} onClick={() => setDialog({ kind: "synonym", gap: g })} data-testid="search-gap-synonym">Add synonym…</button>
                  {st?.aiOperational && (g.draft || g.state === "failed") && (
                    <button type="button" className="btn" disabled={disabled} onClick={() => void act(`/api/admin/search-gaps/${g.id}/redraft`, "POST", { expectedUpdatedAt: g.version }, "Drafted again on the next run")} data-testid="search-gap-redraft">Redraft</button>
                  )}
                  <button type="button" className="btn btn-danger" style={{ marginLeft: "auto" }} disabled={disabled} onClick={() => setDialog({ kind: "dismiss", gap: g })} data-testid="search-gap-dismiss">Dismiss…</button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {dialog && <GapDialog state={dialog} onClose={() => setDialog(null)} act={act} done={done} />}
      {toast && typeof document !== "undefined" && createPortal(<div className="toast" role="status">{toast}</div>, document.body)}
    </div>
  );
}

function DraftView({ gap, aiOperational, aiName }: { gap: SearchGapView; aiOperational: boolean; aiName: string }) {
  const d = gap.draft;
  if (!d) {
    const text = gap.state === "failed" ? `Drafting failed: ${gap.aiLastError ?? "unknown error"}` : gap.state === "accepted" ? null : aiOperational ? "Drafting…" : "No draft";
    return text ? <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }} data-testid="search-gap-no-draft">{text}</p> : null;
  }
  return (
    <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, background: "var(--surface-2)", fontSize: 13.5 }} data-testid="search-gap-draft" data-kind={d.kind}>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>
        {aiName} suggests: <strong>{d.kind === "synonym" ? "a synonym" : d.kind === "request" ? "a skill request" : "noise"}</strong>
        {gap.aiModel ? ` · ${gap.aiModel}` : ""}
      </div>
      {d.kind === "synonym" && <div>Terms: {d.terms.join(", ")} → <Link href={`/skills/${d.targetSkill}`}>{d.targetSkill}</Link>{d.groupId ? " (extends an existing group)" : ""}</div>}
      {d.kind === "request" && (
        <div>
          <strong>{d.title}</strong>
          <p style={{ margin: "4px 0 0", whiteSpace: "pre-line" }}>{d.description}</p>
          {d.categories.length > 0 && <div style={{ marginTop: 4 }}>{d.categories.map((c) => <span key={c} className="chip" style={{ marginRight: 4 }}>{c}</span>)}</div>}
        </div>
      )}
      {d.rationale && <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>{d.rationale}</p>}
    </div>
  );
}

function GapDialog({ state, onClose, act, done }: { state: NonNullable<DialogState>; onClose: () => void; act: Act; done: Done }) {
  const { kind, gap } = state;
  const d = gap.draft;
  const reqDraft = d?.kind === "request" ? d : null;
  const synDraft = d?.kind === "synonym" ? d : null;
  const [title, setTitle] = useState(reqDraft?.title ?? gap.query.replace(/"/g, ""));
  const [description, setDescription] = useState(reqDraft?.description ?? "");
  const [usage, setUsage] = useState(reqDraft?.usage ?? "");
  const [categories, setCategories] = useState((reqDraft?.categories ?? []).join(", "));
  const [tool, setTool] = useState(reqDraft?.tool ?? "generic");
  const [terms, setTerms] = useState("");
  const [groupId, setGroupId] = useState<string | null>(synDraft?.groupId ?? null);
  const [similar, setSimilar] = useState<Similar | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const ids = { title: useId(), desc: useId(), usage: useId(), cats: useId(), tool: useId(), terms: useId() };

  // The synonym editor starts from the draft's group (its current terms plus the new ones) or a new
  // group of the draft's terms; the query's own words are always members (§62.6).
  useEffect(() => {
    if (kind !== "synonym") return;
    const queryWords = gap.query.replace(/"/g, "").split(" ").filter((w) => w && w !== "OR" && !w.startsWith("-")).join(" ");
    const base = synDraft ? synDraft.terms : [queryWords];
    if (!synDraft?.groupId) { setTerms([...new Set([queryWords, ...base])].join(", ")); return; }
    let live = true;
    fetch("/api/admin/search/synonyms")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { groups?: { id: string; terms: string[] }[] } | null) => {
        if (!live) return;
        const grp = j?.groups?.find((x) => x.id === synDraft.groupId);
        if (!grp) setGroupId(null);
        setTerms([...new Set([...(grp?.terms ?? []), queryWords, ...base])].join(", "));
      })
      .catch(() => { if (live) setTerms([...new Set([queryWords, ...base])].join(", ")); });
    return () => { live = false; };
  }, [kind, gap.query, synDraft]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const base = `/api/admin/search-gaps/${gap.id}`;
    if (kind === "dismiss") {
      const ok = await act(base, "DELETE", { expectedUpdatedAt: gap.version }, "Search gap dismissed");
      setBusy(false);
      if (ok) onClose();
      return;
    }
    if (kind === "request" && !similar) {
      // §26 advisory similar-check on the first click; the second click posts anyway.
      const r = await fetch(`/api/requests?similarTo=${encodeURIComponent(title.trim())}`).catch(() => null);
      const j = r?.ok ? ((await r.json()) as { similar?: Similar }) : null;
      if (j?.similar && (j.similar.openRequest || j.similar.catalogSkill)) {
        setSimilar(j.similar);
        setBusy(false);
        return;
      }
    }
    const url = kind === "request" ? `${base}/request` : `${base}/synonym`;
    const payload = kind === "request"
      ? { title, description, usage, categories: categories.split(",").map((c) => c.trim()).filter(Boolean), tool, expectedUpdatedAt: gap.version }
      : { groupId, terms: terms.split(",").map((t) => t.trim()).filter(Boolean), expectedUpdatedAt: gap.version };
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null);
    if (r?.ok) {
      await done(kind === "request" ? "Request posted by Platform" : "Synonym saved");
      setBusy(false);
      onClose();
      return;
    }
    const j = (await r?.json().catch(() => ({}))) as { error?: string } | undefined;
    setBusy(false);
    if (r?.status === 409 || r?.status === 404) {
      await done(undefined, j?.error ?? "This search gap changed since you opened it.");
      onClose();
      return;
    }
    setError(j?.error ?? "Something went wrong. Try again.");
  };

  const heading = kind === "request" ? "Create a skill request" : kind === "synonym" ? "Add a synonym" : "Dismiss this search?";
  const action = kind === "request" ? (similar ? "Post anyway" : "Post request") : kind === "synonym" ? "Save synonym" : "Dismiss";
  const valid = kind === "request" ? !!title.trim() && !!description.trim() : kind === "synonym" ? terms.split(",").filter((t) => t.trim()).length >= 2 : true;
  const label = { display: "block", fontWeight: 600, fontSize: 14, margin: "10px 0 6px" } as const;
  return (
    <Modal
      title={heading}
      onCancel={onClose}
      initialFocusRef={first}
      wide={kind === "request"}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={kind === "dismiss" ? "btn btn-danger" : "btn btn-primary"} onClick={() => void submit()} disabled={!valid || busy} data-testid="search-gap-dialog-submit">{busy ? "Working…" : action}</button>
        </>
      }
    >
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Search: <code className="mono">{gap.query}</code></p>
      {kind === "request" && (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            This request is public to every signed-in user and is posted by Platform. Remove names of people, customers, and restricted skills or namespaces.
          </p>
          {gap.restrictedMatches.length > 0 && (
            <p style={{ fontSize: 13 }} data-testid="search-gap-restricted-notice">
              {gap.restrictedMatches.length} restricted {gap.restrictedMatches.length === 1 ? "skill matches" : "skills match"} this search. Their maintainers and namespace admins will be told that people looked for them, and will see the search text.
            </p>
          )}
          {similar && (
            <div className="card card-pad" role="status" style={{ fontSize: 13, marginBottom: 8 }} data-testid="search-gap-similar">
              {similar.openRequest && <div>Someone already asked for this: <Link href={`/requests/${similar.openRequest.id}`}>{similar.openRequest.title}</Link></div>}
              {similar.catalogSkill && <div>This may already exist: <Link href={`/skills/${similar.catalogSkill.namespaceSlug}/${similar.catalogSkill.skillSlug}`}>{similar.catalogSkill.title}</Link></div>}
            </div>
          )}
          <label htmlFor={ids.title} style={label}>Title</label>
          <input ref={first} id={ids.title} className="input" value={title} maxLength={200} onChange={(e) => { setTitle(e.target.value); setSimilar(null); }} style={{ width: "100%" }} data-testid="search-gap-title" />
          <label htmlFor={ids.desc} style={label}>Description</label>
          <textarea id={ids.desc} className="input" rows={5} value={description} onChange={(e) => { setDescription(e.target.value); setSimilar(null); }} style={{ width: "100%", resize: "vertical", fontSize: 14 }} data-testid="search-gap-description" />
          <label htmlFor={ids.usage} style={label}>Usage</label>
          <textarea id={ids.usage} className="input" rows={3} value={usage} onChange={(e) => setUsage(e.target.value)} style={{ width: "100%", resize: "vertical", fontSize: 14 }} />
          <label htmlFor={ids.cats} style={label}>Categories (comma-separated)</label>
          <input id={ids.cats} className="input" value={categories} onChange={(e) => setCategories(e.target.value)} style={{ width: "100%" }} />
          <label htmlFor={ids.tool} style={label}>Tool/harness</label>
          <input id={ids.tool} className="input input-mono" value={tool} maxLength={40} onChange={(e) => setTool(e.target.value)} style={{ width: 220 }} />
        </>
      )}
      {kind === "synonym" && (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            {groupId ? "Adds the terms to an existing synonym group." : "Creates a new synonym group."} Every term then finds what the others find, for everyone, right away.
          </p>
          <label htmlFor={ids.terms} style={label}>Terms (comma-separated)</label>
          <input ref={first} id={ids.terms} className="input" value={terms} onChange={(e) => setTerms(e.target.value)} style={{ width: "100%" }} data-testid="search-gap-terms" />
        </>
      )}
      {kind === "dismiss" && <p style={{ fontSize: 14 }}>It&rsquo;s deleted and never suggested again.</p>}
      {error && <p role="alert" style={{ color: "var(--danger)", fontSize: 13, marginBottom: 0 }} data-testid="search-gap-dialog-error">{error}</p>}
    </Modal>
  );
}

export default function SearchGapsPage() {
  return (
    <RequireAuth>
      <SearchGaps />
    </RequireAuth>
  );
}
