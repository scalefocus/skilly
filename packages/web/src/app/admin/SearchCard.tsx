"use client";
// Administration → Search (SKILLY_SPEC.md §34.8/§34.9): the search language and the synonym groups.
// Changing the language asks first — the worker then rebuilds every vector behind it, which the
// Maintenance card tracks. Synonym groups are equivalence sets: any member a searcher types expands
// to the whole group. Every save is validated server-side (its 422 message shows inline) and audited.
import { useState } from "react";
import { Pill, useApi, formatCount } from "../../components/ui";
import { CollapsibleCard } from "./CollapsibleCard";

interface Languages { current: string; languages: { value: string; label: string }[]; skillCount: number }
interface Group { id: string; terms: string[]; updatedAt: string; collidesWith: string[] }

const EXAMPLES = ["k8s, kubernetes", "js, javascript", "ppt, pptx, powerpoint, slides"];

async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  try {
    const r = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.ok) return null;
    return ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Failed (${r.status})`;
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}

function GroupRow({ g, onChanged }: { g: Group; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(g.terms.join(", "));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    const e = await send(`/api/admin/search/synonyms/${g.id}`, "PUT", { terms: text });
    setBusy(false);
    setErr(e);
    if (!e) { setEditing(false); onChanged(); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the synonym group “${g.terms.join(", ")}”? Searches stop expanding these terms right away.`)) return;
    setBusy(true);
    const e = await send(`/api/admin/search/synonyms/${g.id}`, "DELETE");
    setBusy(false);
    setErr(e);
    if (!e) onChanged();
  };

  return (
    <div className="synonym-row" style={{ padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
      {editing ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            aria-label="Synonym terms"
            className="input"
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) void save(); if (e.key === "Escape") { setEditing(false); setText(g.terms.join(", ")); setErr(null); } }}
            style={{ flex: 1, minWidth: 240 }}
          />
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save()}>Save</button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { setEditing(false); setText(g.terms.join(", ")); setErr(null); }}>Cancel</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
            {g.terms.map((t) => <Pill key={t} tone="muted">{t}</Pill>)}
          </div>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void remove()} style={{ color: "var(--danger)" }}>Delete</button>
        </div>
      )}
      {g.collidesWith.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--warn)" }}>
          Shares a word with another group under the current search language — searching it expands to both. Merge them.
        </div>
      )}
      {err && <div role="alert" style={{ marginTop: 6, fontSize: 13, color: "var(--danger)" }}>{err}</div>}
    </div>
  );
}

export function SearchCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { data: langs, reload: reloadLangs } = useApi<Languages>("/api/admin/search/languages");
  const { data: syn, reload: reloadSyn } = useApi<{ groups: Group[] }>("/api/admin/search/synonyms");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [langErr, setLangErr] = useState<string | null>(null);

  const groups = syn?.groups ?? [];
  const current = langs?.languages.find((l) => l.value === langs.current);

  const changeLanguage = async (value: string) => {
    if (!langs || value === langs.current) return;
    const label = langs.languages.find((l) => l.value === value)?.label ?? value;
    const ok = window.confirm(
      `Switch search to ${label}?\n\nRebuilds the search index for ${formatCount(langs.skillCount)} skills; results are briefly less precise while it runs.`,
    );
    if (!ok) return;
    setBusy(true);
    const e = await send("/api/admin/settings", "PATCH", { searchLanguage: value });
    setBusy(false);
    setLangErr(e);
    reloadLangs();
    reloadSyn(); // normalized forms change with the language
  };

  const add = async () => {
    setBusy(true);
    const e = await send("/api/admin/search/synonyms", "POST", { terms: text });
    setBusy(false);
    setAddErr(e);
    if (!e) { setText(""); reloadSyn(); }
  };

  return (
    <CollapsibleCard
      cardId="search"
      title="Search"
      summary={langs && syn ? `${current?.label ?? langs.current} · ${formatCount(groups.length)} synonym ${groups.length === 1 ? "group" : "groups"}` : undefined}
      open={open}
      onToggle={onToggle}
    >
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
        Registry search (the catalog, the header search and MCP) is PostgreSQL full-text search: it matches word forms
        and ranks by where words match. It does not know that different words mean the same thing — that is what
        synonym groups are for.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 22 }}>
        <label htmlFor="search-language" style={{ fontWeight: 600, fontSize: 14 }}>Search language</label>
        <select
          id="search-language"
          className="input"
          style={{ minWidth: 220, maxWidth: 320 }}
          disabled={busy || !langs}
          value={langs?.current ?? ""}
          onChange={(e) => void changeLanguage(e.target.value)}
        >
          {(langs?.languages ?? []).map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
        {langs?.current === "simple" && (
          <span className="muted" style={{ fontSize: 12.5 }}>
            No stop words — sentence-style searches lean on the “some words” fallback.
          </span>
        )}
      </div>
      {langErr && <div role="alert" style={{ marginTop: -12, marginBottom: 16, fontSize: 13, color: "var(--danger)" }}>{langErr}</div>}

      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Synonym groups</div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
        Each group is a set of interchangeable terms (1–4 words each). Searching any term also finds skills that use
        the others. A term can belong to one group only; quoted phrases and excluded words are never expanded.
      </p>
      {groups.length === 0 ? (
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          No synonym groups yet. For example:{" "}
          {EXAMPLES.map((ex, i) => (
            <span key={ex}>{i > 0 && " · "}<span className="mono">{ex}</span></span>
          ))}
        </div>
      ) : (
        <div style={{ marginBottom: 12 }}>
          {groups.map((g) => <GroupRow key={`${g.id}:${g.updatedAt}`} g={g} onChanged={reloadSyn} />)}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          aria-label="New synonym group"
          className="input"
          placeholder="Comma-separated terms, e.g. k8s, kubernetes"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && text.trim() && !busy) void add(); }}
          style={{ flex: 1, minWidth: 260, maxWidth: 520 }}
        />
        <button type="button" className="btn btn-sm" disabled={busy || !text.trim()} onClick={() => void add()}>Add group</button>
      </div>
      {addErr && <div role="alert" style={{ marginTop: 8, fontSize: 13, color: "var(--danger)" }}>{addErr}</div>}
    </CollapsibleCard>
  );
}
