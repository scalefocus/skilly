"use client";
// Deprecate / edit a skill's deprecation (SKILLY_SPEC.md §45.3, §45.5). A small modal: a successor
// typeahead over ELIGIBLE candidates (`/api/skills/suggest?scope=successor&for=<ns>/<slug>` — active,
// not deprecated, audience ⊇ this skill's; the server re-validates on save), an explicit
// "no successor" state, and a plain-text note (≤ DEPRECATION_NOTE_MAX). Save → PUT …/deprecation.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEPRECATION_NOTE_MAX } from "@skilly/shared/deprecation";
import { SkillIcon } from "../../../../components/SkillIcon";

export interface DeprecationView {
  deprecatedAt: string;
  deprecatedBy: { id: string; displayName: string } | null;
  note: string | null;
  successor: { namespaceSlug: string; skillSlug: string; title: string; icon: { url: string | null; emoji: string | null } | null; installable: boolean } | null;
  successorState: "ok" | "hidden" | "archived" | "deprecated" | "none";
}

interface Candidate {
  id: string;
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  icon: { url: string | null; emoji: string | null } | null;
}

export function DeprecateDialog({
  ns,
  slug,
  current,
  onClose,
  onSaved,
}: {
  ns: string;
  slug: string;
  /** The existing deprecation when editing, null when deprecating afresh. */
  current: DeprecationView | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [picked, setPicked] = useState<Candidate | null>(
    current?.successor ? { id: "", namespaceSlug: current.successor.namespaceSlug, skillSlug: current.successor.skillSlug, title: current.successor.title, icon: current.successor.icon } : null,
  );
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<Candidate[]>([]);
  const [note, setNote] = useState(current?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  // Debounced candidate lookup (2-char floor like the other pickers).
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || picked) { setOptions([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/skills/suggest?scope=successor&for=${encodeURIComponent(`${ns}/${slug}`)}&q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
        const j = r.ok ? ((await r.json()) as { suggestions: Candidate[] }) : { suggestions: [] };
        setOptions(j.suggestions);
      } catch { /* aborted or offline — keep the last list */ }
    }, 200);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, picked, ns, slug]);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/skills/${ns}/${slug}/deprecation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ successor: picked ? `${picked.namespaceSlug}/${picked.skillSlug}` : null, note: note.trim() || null }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      onSaved(current ? "Deprecation updated." : picked ? `Skill deprecated — users are pointed at ${picked.title}.` : "Skill deprecated.");
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="deprecate-title" data-testid="deprecate-dialog" style={{ maxWidth: 520 }}>
        <div className="modal-head">
          <h2 className="modal-title" id="deprecate-title">{current ? "Edit deprecation" : "Deprecate this skill"}</h2>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body" style={{ display: "grid", gap: 14 }}>
          <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
            The skill keeps serving and installing, but every surface marks it, it sorts after live skills, and
            watchers, maintainers and current installers are notified once. Agents see a hint in the served <span className="mono">SKILL.md</span>.
          </p>
          <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
            <span>Successor <span className="muted">· optional — "use X instead"</span></span>
            {picked ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="chip" style={{ display: "inline-flex", alignItems: "center", gap: 6 }} data-testid="successor-picked">
                  <SkillIcon icon={picked.icon} title={picked.title} size={16} />
                  {picked.title} <span className="muted mono">@{picked.namespaceSlug}/{picked.skillSlug}</span>
                </span>
                <button type="button" className="btn btn-sm" onClick={() => { setPicked(null); setQ(""); }}>change</button>
              </div>
            ) : (
              <div style={{ position: "relative" }}>
                <input
                  ref={inputRef}
                  className="input"
                  placeholder="Search skills by name… (leave empty for no successor)"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  aria-label="Successor skill"
                  data-testid="successor-search"
                />
                {options.length > 0 && (
                  <div role="listbox" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 5, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow)", padding: 4, maxHeight: 220, overflowY: "auto" }}>
                    {options.map((o) => (
                      <button key={o.id} type="button" role="option" aria-selected={false} className="ver-opt" style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }} onClick={() => { setPicked(o); setOptions([]); }}>
                        <SkillIcon icon={o.icon} title={o.title} size={16} />
                        <span>{o.title}</span>
                        <span className="muted mono" style={{ fontSize: 11 }}>@{o.namespaceSlug}/{o.skillSlug}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <span className="muted" style={{ fontSize: 12 }}>
              Only skills everyone who can see this one can also see are offered (an org-wide skill, or a restricted skill shared with the same namespaces).
            </span>
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
            <span>Note <span className="muted">· optional, plain text, shown with the marker and in the served SKILL.md</span></span>
            <textarea className="input" rows={3} maxLength={DEPRECATION_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} data-testid="deprecation-note" />
            <span className="muted mono" style={{ fontSize: 11, justifySelf: "end" }}>{note.length}/{DEPRECATION_NOTE_MAX}</span>
          </label>
          {err && <div role="alert" style={{ fontSize: 13, color: "var(--danger)" }}>{err}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={busy} data-testid="deprecate-save">
            {busy ? "Saving…" : current ? "Save" : "Deprecate"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
