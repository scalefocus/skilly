"use client";
// The profile's "Skill collections (N)" card (SKILLY_SPEC.md §37.7): the owner's own collections,
// newest first, each with an inline-editable name and description, its eligible skill count and
// created date, and View skills / Copy link / Delete. Collapsed by default, remembered per browser,
// like "People I follow". N counts every collection, empty ones included.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { COLLECTION_DESCRIPTION_MAX, COLLECTION_NAME_MAX, collectionPath } from "@skilly/shared/collections";
import { CollapsibleCard } from "../app/admin/CollapsibleCard";
import { useDateFmt } from "./DateFormat";

interface Collection {
  id: string;
  name: string;
  description: string | null;
  skillCount: number;
  createdAt: string;
}

const PANE_KEY = "skilly.profile.collections.open";

const ERRORS: Record<string, string> = { name_taken: "You already have a collection with that name." };

/** Click-to-edit text: Enter (or blur) saves, Escape cancels. A save error keeps the editor open. */
function InlineEdit({
  value,
  placeholder,
  maxLength,
  multiline,
  label,
  onSave,
  className,
}: {
  value: string;
  placeholder: string;
  maxLength: number;
  multiline?: boolean;
  label: string;
  onSave: (next: string) => Promise<string | null>;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const commit = async () => {
    if (busy) return;
    if (draft.trim() === value.trim()) { setEditing(false); setErr(null); return; }
    setBusy(true);
    const e = await onSave(draft);
    setBusy(false);
    if (e) { setErr(e); return; }
    setErr(null);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className={`inline-edit${value ? "" : " is-empty"}${className ? ` ${className}` : ""}`}
        onClick={() => { setDraft(value); setEditing(true); }}
        title={`Edit the ${label}`}
        aria-label={`Edit the ${label}${value ? `: ${value}` : ""}`}
      >
        {value || placeholder}
      </button>
    );
  }
  const common = {
    ref,
    value: draft,
    maxLength,
    disabled: busy,
    "aria-label": label,
    placeholder,
    className: "input inline-edit-input",
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => void commit(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setDraft(value); setErr(null); setEditing(false); }
      else if (e.key === "Enter" && !(multiline && e.shiftKey)) { e.preventDefault(); void commit(); }
    },
  };
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
      {multiline ? <textarea rows={2} {...common} /> : <input {...common} />}
      {err && <span className="collection-popup-err" role="alert">{err}</span>}
    </span>
  );
}

export function CollectionsCard() {
  const fmt = useDateFmt();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Collection[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    const r = await fetch("/api/collections/mine");
    setRows(r.ok ? ((await r.json()) as { collections: Collection[] }).collections : []);
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    try { setOpen(window.localStorage.getItem(PANE_KEY) === "1"); } catch { /* storage blocked → collapsed */ }
  }, []);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const toggle = () => {
    setOpen((o) => {
      try { window.localStorage.setItem(PANE_KEY, o ? "0" : "1"); } catch { /* per-browser convenience only */ }
      return !o;
    });
  };

  const patch = async (id: string, body: { name?: string; description?: string }): Promise<string | null> => {
    const r = await fetch(`/api/collections/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => null)) as { error?: string; collection?: { name: string; description: string | null } } | null;
    if (!r.ok) return (j?.error && ERRORS[j.error]) || j?.error || "Couldn’t save — try again.";
    setRows((rs) => (rs ?? []).map((c) => (c.id === id ? { ...c, ...j!.collection! } : c)));
    return null;
  };

  const remove = async (c: Collection) => {
    if (!window.confirm(`Delete the collection “${c.name}”? This can’t be undone. Anyone with its link will see that it no longer exists.`)) return;
    setBusy(c.id);
    try {
      const r = await fetch(`/api/collections/${c.id}`, { method: "DELETE" });
      if (r.ok) setRows((rs) => (rs ?? []).filter((x) => x.id !== c.id));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (c: Collection) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${collectionPath(c.id)}`);
      setCopied(true);
    } catch { /* clipboard blocked — nothing to show */ }
  };

  return (
    <section className="reveal" style={{ marginBottom: 30 }} id="collections" data-testid="collections-card">
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 4 }}>Skill collections</h2>
      <p className="page-sub" style={{ marginBottom: 16 }}>
        Lists of skills you put together, like an onboarding pack. Anyone signed in can open a collection from its link.
      </p>
      {/* No count until the list has loaded — a transient "(0)" would be a lie. */}
      <CollapsibleCard cardId="collections" title={rows ? `Skill collections (${rows.length})` : "Skill collections"} open={open} onToggle={toggle}>
        {!rows ? (
          <div className="skeleton" style={{ height: 60, borderRadius: "var(--radius)" }} />
        ) : rows.length === 0 ? (
          <div className="muted" style={{ fontSize: 13.5 }} data-testid="collections-empty">
            No collections yet. Use <strong>Add to collection</strong> on any skill page.
          </div>
        ) : (
          <div className="rows">
            {rows.map((c) => (
              <div className="row collection-row" key={c.id} data-testid="collection-row" data-collection-id={c.id}>
                <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  <InlineEdit
                    value={c.name}
                    placeholder="Collection name"
                    maxLength={COLLECTION_NAME_MAX}
                    label="collection name"
                    className="ttl"
                    onSave={(name) => patch(c.id, { name })}
                  />
                  <InlineEdit
                    value={c.description ?? ""}
                    placeholder="Add a description"
                    maxLength={COLLECTION_DESCRIPTION_MAX}
                    multiline
                    label="description"
                    className="sub"
                    onSave={(description) => patch(c.id, { description })}
                  />
                  <div className="muted mono" style={{ fontSize: 11 }}>
                    {c.skillCount} skill{c.skillCount === 1 ? "" : "s"} · created {fmt.date(c.createdAt)}
                  </div>
                </div>
                <div className="collection-row-actions">
                  <Link href={collectionPath(c.id)} className="btn btn-sm" data-testid="collection-view">View skills</Link>
                  <button type="button" className="btn btn-sm" onClick={() => void copy(c)} title="Copy a link anyone signed in can open">Copy link</button>
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy === c.id} onClick={() => void remove(c)} data-testid="collection-delete">
                    {busy === c.id ? "…" : "Delete"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CollapsibleCard>
      {copied && createPortal(<div className="toast" role="status">✓ Link copied</div>, document.body)}
    </section>
  );
}
