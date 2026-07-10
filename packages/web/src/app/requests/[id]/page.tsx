"use client";
// Skill request detail (§26): the full wish + example files, and the primary action — "Propose a
// skill" (build new, pre-fills the propose form) or "Propose an existing skill" (immediate,
// no-review fulfilment via the adjacent search dropdown).
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useApi, Pill, EmptyState, ScrollToTop } from "../../../components/ui";
import { RequireAuth } from "../../../components/RequireAuth";
import { UserBubble } from "../../../components/UserBubble";
import { useDateFmt } from "../../../components/DateFormat";
import { Markdown } from "../../../components/Markdown";
import { ChatBox, type ChatMessage } from "../../../components/ChatBox";
import { useChatPollIntervals } from "../../../components/useChatPoll";
import { agentLabel } from "@skilly/shared/agents";
import { usePageLabelOverride } from "../../../components/PageLabelOverride";

interface RequestView {
  id: string;
  title: string;
  description: string;
  usageExamples: string | null;
  toolHarness: string;
  categories: string[];
  state: "open" | "fulfilled" | "withdrawn" | "removed";
  requesterUserId: string;
  requesterName: string;
  requesterAvatar: string | null;
  createdAt: string;
  updatedAt: string;
  fulfilled: { namespaceSlug: string; skillSlug: string; byName: string | null } | null;
}

function RequestDetailInner() {
  const fmt = useDateFmt();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { data, loading, error, reload } = useApi<{ request: RequestView; isRequester: boolean; isPlatformAdmin: boolean }>(id ? `/api/requests/${id}` : null);
  usePageLabelOverride(data ? `Request: ${data.request.title}` : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // "Propose an existing skill" (§26): once a skill is picked from the search dropdown, the
  // primary button swaps from "Propose a skill →" to this immediate, no-review fulfilment.
  const [existingSkill, setExistingSkill] = useState<{ namespaceSlug: string; skillSlug: string; title: string } | null>(null);

  if (error) return <EmptyState icon="⚠" title="Couldn’t load this request" hint={error} />;
  if (loading || !data) return <div className="skeleton" style={{ height: 260, borderRadius: "var(--radius)" }} />;
  const r = data.request;
  const closed = r.state !== "open";

  const close = async () => {
    // Both withdraw (own request only) and admin removal (moderation) permanently DELETE the row
    // (§26) — so both warn it can't be undone, and always navigate away (there's nothing left to
    // reload once the row is gone).
    const confirmMsg = data.isRequester
      ? "Withdraw this request? It'll be permanently deleted — this can't be undone."
      : "Permanently delete this request? This can't be undone.";
    if (!window.confirm(confirmMsg)) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/requests/${r.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed");
      router.push("/requests");
    } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  // Immediate, no-review fulfilment (§26): links the request straight to an already-published
  // skill. Irreversible, so it's confirm-gated like Withdraw/Remove above.
  const fulfilExisting = async () => {
    if (!existingSkill) return;
    if (!window.confirm(`Fulfil this request with '${existingSkill.title}'? This can't be undone.`)) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/requests/${r.id}/fulfil`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ namespaceSlug: existingSkill.namespaceSlug, skillSlug: existingSkill.skillSlug }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed");
      setExistingSkill(null);
      reload();
    } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  return (
    <div className="reveal" style={{ maxWidth: 860 }}>
      <ScrollToTop />
      <div className="page-head">
        <div className="eyebrow"><Link href="/requests" style={{ color: "inherit" }}>Requested skills</Link></div>
        <h1 className="page-title">{r.title}</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          <span className="chip">{agentLabel(r.toolHarness)}</span>
          {r.categories.map((c) => <span key={c} className="chip">{c}</span>)}
          {r.state === "open" && <Pill tone="ok">open</Pill>}
          {r.state === "fulfilled" && <Pill tone="muted">fulfilled</Pill>}
          {(r.state === "withdrawn" || r.state === "removed") && <Pill tone="danger">{r.state}</Pill>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 13 }}>
          <UserBubble name={r.requesterName} avatar={r.requesterAvatar} userId={r.requesterUserId} size={24} />
          <span>{r.requesterName}</span>
          <span className="muted mono" style={{ fontSize: 11.5 }}>· asked {fmt.date(r.createdAt)}</span>
        </div>
      </div>

      {r.state === "fulfilled" && r.fulfilled && (
        <>
          {/* "Who built it" credit — the primary "Open the skill" CTA now lives in the action row
              below (mirrors the open state's "Propose a skill" button position). */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 16, padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--accent-soft)", fontSize: 13.5 }}>
            <span aria-hidden>✓</span>
            <span>Fulfilled{r.fulfilled.byName ? <> by <strong>{r.fulfilled.byName}</strong></> : null}.</span>
          </div>
          {/* Primary action for a fulfilled request: jump straight to the skill that satisfied it. */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
            <Link href={`/skills/${r.fulfilled.namespaceSlug}/${r.fulfilled.skillSlug}`} className="btn btn-primary">Open the skill →</Link>
          </div>
        </>
      )}

      {/* Primary action: build this (default) or fulfil it immediately with a skill that already
          exists (§26) — the search dropdown swaps which primary button is shown. */}
      {r.state === "open" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
          {existingSkill ? (
            <button className="btn btn-primary" disabled={busy} onClick={fulfilExisting}>Propose an existing skill</button>
          ) : (
            <Link href={`/propose?fromRequest=${r.id}`} className="btn btn-primary">Propose a skill →</Link>
          )}
          <ExistingSkillPicker selected={existingSkill} onSelect={setExistingSkill} onClear={() => setExistingSkill(null)} />
          {(data.isRequester || data.isPlatformAdmin) && (
            <button className="btn" disabled={busy} onClick={close} title={data.isRequester ? "Withdraw your request — permanently deletes it, can't be undone" : "Permanently delete this request (moderation) — can't be undone"}>
              {data.isRequester ? "Withdraw" : "Delete"}
            </button>
          )}
        </div>
      )}
      {err && <div style={{ color: "var(--danger)", fontSize: 13.5, marginBottom: 14 }}>{err}</div>}

      <section className="card card-pad" style={{ marginBottom: 20 }}>
        <div className="nav-label" style={{ padding: "0 0 10px" }}>What’s wanted</div>
        <Markdown source={r.description} />
      </section>

      {r.usageExamples && (
        <section className="card card-pad" style={{ marginBottom: 20 }}>
          <div className="nav-label" style={{ padding: "0 0 10px" }}>How it should be used</div>
          <Markdown source={r.usageExamples} />
        </section>
      )}

      <RequestDiscussion requestId={r.id} />

      {closed && r.state !== "fulfilled" && (
        <p className="muted" style={{ fontSize: 13 }}>This request was {r.state} and no longer appears in the Requested skills list.</p>
      )}
    </div>
  );
}

interface ExistingSkillSuggestion { namespaceSlug: string; skillSlug: string; title: string; official?: boolean }

/** "Propose an existing skill" search dropdown (§26) — org-visible skills only (`scope=org` on the
 *  header-search autocomplete), so the resulting fulfilment link is always openable by the
 *  requester and everyone else. Once a skill is selected it collapses into a clearable chip; the
 *  parent swaps its primary button while a selection is present. */
function ExistingSkillPicker({
  selected, onSelect, onClear,
}: {
  selected: { namespaceSlug: string; skillSlug: string; title: string } | null;
  onSelect: (s: ExistingSkillSuggestion) => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState("");
  const [suggestions, setSuggestions] = useState<ExistingSkillSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hi, setHi] = useState(-1);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setSuggestions([]); setOpen(false); setLoading(false); return; }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      fetch(`/api/skills/suggest?scope=org&q=${encodeURIComponent(term)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((j) => {
          if (!live) return;
          setSuggestions(j?.suggestions ?? []);
          setOpen(true);
          setHi(-1);
          setLoading(false);
        })
        .catch(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  if (selected) {
    return (
      <span className="chip" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        Fulfil with <strong>{selected.title}</strong>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selected skill"
          style={{ border: 0, background: "transparent", cursor: "pointer", color: "inherit", fontSize: 15, lineHeight: 1, padding: 0 }}
        >
          ×
        </button>
      </span>
    );
  }

  return (
    <div
      className="search"
      style={{ maxWidth: 280 }}
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
      </svg>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
        onKeyDown={(e) => {
          if (!open || suggestions.length === 0) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => (i + 1) % suggestions.length); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => (i <= 0 ? suggestions.length - 1 : i - 1)); }
          else if (e.key === "Enter" && hi >= 0 && suggestions[hi]) { e.preventDefault(); onSelect(suggestions[hi]); setQ(""); setOpen(false); }
          else if (e.key === "Escape") { setOpen(false); setHi(-1); }
        }}
        placeholder="Fulfil with an existing skill…"
        aria-label="Search existing skills"
        aria-autocomplete="list"
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <ul className="search-ac" role="listbox">
          {suggestions.map((s, i) => (
            <li key={`${s.namespaceSlug}/${s.skillSlug}`} role="option" aria-selected={i === hi}>
              <button
                type="button"
                className={`search-ac-item${i === hi ? " hi" : ""}`}
                onMouseEnter={() => setHi(i)}
                onClick={() => { onSelect(s); setQ(""); setOpen(false); }}
              >
                <span className="search-ac-title">{s.title}</span>
                <span className="search-ac-sub mono">@{s.namespaceSlug}/{s.skillSlug}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && !loading && suggestions.length === 0 && q.trim().length >= 2 && (
        <div className="search-ac search-ac-empty" role="status">Nothing found for <span className="mono">“{q.trim()}”</span></div>
      )}
    </div>
  );
}

/** The request's discussion (§26, §24) — any authenticated user may read/post, since the request
 *  itself is org-visible; the requester's own messages carry an "Original Requester" tag. Locks
 *  once the request is fulfilled (withdrawn/removed requests are hard-deleted, so this page 404s
 *  before ever reaching a locked "withdrawn"/"removed" state). Same flow as a proposal's review
 *  discussion (topbar Messages window, bell notifications) — separate code path; the proposal
 *  review flow itself is untouched. */
function RequestDiscussion({ requestId }: { requestId: string }) {
  const [thread, setThread] = useState<{ conversationId: string | null; canPost: boolean; closed: boolean; messages: ChatMessage[] } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/requests/${requestId}/messages`);
    if (!res.ok) return;
    const t = await res.json();
    setThread(t);
    if (t.conversationId) fetch(`/api/messages/${t.conversationId}/read`, { method: "POST" }).catch(() => {});
  }, [requestId]);

  useEffect(() => { void load(); }, [load]);
  // Poll for new replies at the chat floor interval set[0] while the page is open (§24) — same
  // cadence as a proposal's review discussion.
  const pollIntervals = useChatPollIntervals();
  useEffect(() => {
    const secs = pollIntervals[0] ?? 7;
    const id = setInterval(() => { if (!document.hidden) void load(); }, secs * 1000);
    return () => clearInterval(id);
  }, [load, pollIntervals]);

  const send = async (body: string) => {
    const res = await fetch(`/api/requests/${requestId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
    if (res.ok) {
      const { message } = await res.json();
      setThread((t) => (t ? { ...t, messages: [...t.messages, message] } : t));
      void load();
    }
  };

  if (!thread) return null;

  return (
    <section className="card card-pad" style={{ marginBottom: 20 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, marginBottom: 14 }}>Discussion</h2>
      <ChatBox
        messages={thread.messages}
        canPost={thread.canPost}
        closed={thread.closed}
        onSend={send}
        emptyHint="No messages yet — ask a question or offer to build this."
        closedHint="This discussion is read-only — the request has been fulfilled."
      />
    </section>
  );
}

export default function RequestDetailPage() {
  return (
    <RequireAuth>
      <RequestDetailInner />
    </RequireAuth>
  );
}
