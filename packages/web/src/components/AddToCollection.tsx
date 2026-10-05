"use client";
// "Add to collection" (SKILLY_SPEC.md §37.3): the detail page's button + popup. The popup lists the
// caller's own collections as checkboxes (ticked where this skill is already a member), filtered by
// the name box; a "Create "‹name›"" row appears when the typed name matches none of them. Ticking
// adds and unticking removes immediately — one request per change, a short toast, no Save button.
// Dismissed by an outside click, Escape, or the button again, like the app's other menus.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  COLLECTION_NAME_MAX,
  MAX_COLLECTIONS_PER_OWNER,
  MAX_SKILLS_PER_COLLECTION,
  sameCollectionName,
} from "@skilly/shared/collections";

interface Row {
  id: string;
  name: string;
  contains?: boolean;
  itemCount?: number;
}

const ERRORS: Record<string, string> = {
  name_taken: "You already have a collection with that name.",
  collection_limit: `You have ${MAX_COLLECTIONS_PER_OWNER} collections, the maximum. Delete one to create another.`,
  collection_full: `That collection is full (${MAX_SKILLS_PER_COLLECTION} skills).`,
};

async function errorText(r: Response): Promise<string> {
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  return (j?.error && ERRORS[j.error]) || j?.error || "Something went wrong — try again.";
}

export function AddToCollection({ skillId }: { skillId: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const r = await fetch(`/api/collections/mine?skillId=${encodeURIComponent(skillId)}`);
    const j = r.ok ? ((await r.json()) as { collections: Row[] }) : { collections: [] };
    setRows(j.collections);
  };

  useEffect(() => {
    if (!open) return;
    setText("");
    setErr(null);
    void load();
    // Focus once the popup is in the DOM.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Outside click / Escape dismiss (§37.3, the §23 split-button behavior).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const sorted = useMemo(() => [...(rows ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })), [rows]);
  const typed = text.trim();
  const visible = typed ? sorted.filter((r) => r.name.toLowerCase().includes(typed.toLowerCase())) : sorted;
  const exact = typed ? sorted.find((r) => sameCollectionName(r.name, typed)) : undefined;
  const atLimit = (rows?.length ?? 0) >= MAX_COLLECTIONS_PER_OWNER;
  const showCreate = !!typed && !exact && rows !== null;

  const toggle = async (row: Row) => {
    setErr(null);
    setBusy(row.id);
    try {
      const r = await fetch(`/api/collections/${row.id}/skills/${skillId}`, { method: row.contains ? "DELETE" : "PUT" });
      if (!r.ok) { setErr(await errorText(r)); return; }
      setToast(row.contains ? `Removed from ${row.name}` : `Added to ${row.name}`);
      setRows((rs) => (rs ?? []).map((x) => (x.id === row.id ? { ...x, contains: !row.contains, itemCount: (x.itemCount ?? 0) + (row.contains ? -1 : 1) } : x)));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!typed || atLimit) return;
    setErr(null);
    setBusy("new");
    try {
      const r = await fetch("/api/collections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: typed, skillId }),
      });
      if (!r.ok) { setErr(await errorText(r)); return; }
      const { collection } = (await r.json()) as { collection: { id: string; name: string } };
      setRows((rs) => [...(rs ?? []), { id: collection.id, name: collection.name, contains: true, itemCount: 1 }]);
      setText("");
      setToast(`Added to ${collection.name}`);
    } finally {
      setBusy(null);
    }
  };

  const onEnter = () => {
    if (exact) {
      if (!exact.contains) void toggle(exact); // Enter on an exact existing name ticks it, never duplicates
      return;
    }
    void create();
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className="btn btn-sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        title="Add this skill to one of your collections, or start a new one"
        data-testid="add-to-collection"
      >
        + Add to collection
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Add to collection"
          className="collection-popup"
          data-testid="collection-popup"
        >
          <input
            ref={inputRef}
            value={text}
            maxLength={COLLECTION_NAME_MAX}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onEnter(); } }}
            placeholder="Collection name"
            aria-label="Collection name"
            className="input collection-popup-input"
            data-testid="collection-name-input"
          />
          <div className="collection-popup-list">
            {rows === null ? (
              <div className="muted" style={{ fontSize: 12.5, padding: "6px 4px" }}>Loading…</div>
            ) : (
              <>
                {visible.map((r) => {
                  const full = !r.contains && (r.itemCount ?? 0) >= MAX_SKILLS_PER_COLLECTION;
                  return (
                    <label key={r.id} className={`collection-opt${full ? " is-disabled" : ""}`} data-testid="collection-option">
                      <input
                        type="checkbox"
                        checked={!!r.contains}
                        disabled={full || busy !== null}
                        onChange={() => void toggle(r)}
                      />
                      <span className="collection-opt-name">{r.name}</span>
                      {full && <span className="muted mono" style={{ fontSize: 11 }}>Full ({MAX_SKILLS_PER_COLLECTION} skills)</span>}
                    </label>
                  );
                })}
                {rows.length === 0 && !typed && (
                  <div className="muted" style={{ fontSize: 12.5, padding: "6px 4px" }}>No collections yet — type a name to start one.</div>
                )}
                {showCreate && (
                  <button
                    type="button"
                    className="collection-opt collection-create"
                    disabled={atLimit || busy !== null}
                    onClick={() => void create()}
                    data-testid="collection-create"
                  >
                    {atLimit ? ERRORS.collection_limit : <>Create “<strong>{typed}</strong>”</>}
                  </button>
                )}
              </>
            )}
          </div>
          {err && <div className="collection-popup-err" role="alert">{err}</div>}
        </div>
      )}
      {toast && createPortal(<div className="toast" role="status">✓ {toast}</div>, document.body)}
    </div>
  );
}
