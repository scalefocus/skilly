"use client";
import { useEffect, useRef, useState } from "react";
// Subpath import: the root barrel pulls node:crypto (tokens.ts), which can't ship to the client.
import { maintainerContactError, normalizeMaintainerContact } from "@skilly/shared/contact";

/**
 * The namespace `maintainer_contact` editor (SKILLY_SPEC.md §30.6).
 *
 * ONE component serves both surfaces — the Namespace administration page (`/namespaces`) and the
 * platform Administration → Namespaces card — so they cannot drift on typeahead, validation, or
 * the input's styling. Only the label placement differs, and that is a property of the surface:
 * a form-style card stacks an uppercase-mono micro-label above the field, while a settings row
 * inside a card keeps the inline sentence-case label its sibling rows use.
 *
 * Typeahead source is `GET /api/users/suggest` (§10/§24), NOT the platform-admin-only
 * `/api/admin/users/search` — that endpoint 403s a namespace admin, which would leave the
 * typeahead permanently empty on `/namespaces`. `users/suggest` is already open to any signed-in
 * user (people have no per-user visibility model, §28), is rate-limited and bounded, and excludes
 * non-active users, so a leaver can no longer be picked as a maintainer contact.
 */

/** `/api/users/suggest` row shape. */
interface Suggestion {
  id: string;
  name: string;
  email: string;
}

const MIN_QUERY = 2; // the endpoint's own floor — below it, it returns nothing
const DEBOUNCE_MS = 200;
/** Id root for the input's `aria-describedby`; suffixed per layout so the two surfaces never
 *  collide if both ever render on one page. */
const MSG_ID = "maintainer-contact-msg";

export function MaintainerContactField({
  value,
  onSave,
  busy = false,
  layout,
  labelStyle,
}: {
  /** The saved value; the field resets to it once a save (and reload) lands. */
  value: string | null;
  /** Persist the value (`null` clears it). Resolves true on success. */
  onSave: (value: string | null) => Promise<boolean>;
  busy?: boolean;
  /** `stacked` = micro-label above (form-style cards); `inline` = label beside (settings rows). */
  layout: "stacked" | "inline";
  /** The surface's own micro-label style, so a stacked field matches its neighbours exactly. */
  labelStyle?: React.CSSProperties;
}) {
  const [v, setV] = useState(value ?? "");
  const [saved, setSaved] = useState(false);
  const [results, setResults] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  // Only search once the user has actually typed. Without this, every mounted field fires a
  // suggest request for its ALREADY-SAVED value — and /namespaces mounts one per administered
  // namespace, so a platform admin's page load spent ~16 requests against a rate-limited
  // endpoint to search for addresses nobody was editing.
  const [typed, setTyped] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the field authoritative to the saved value once a save (and reload) lands.
  useEffect(() => { setV(value ?? ""); setTyped(false); }, [value]);

  useEffect(() => {
    const q = v.trim();
    if (!typed || q.length < MIN_QUERY) { setResults([]); return; }
    let live = true;
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/users/suggest?q=${encodeURIComponent(q)}`);
        if (r.ok && live) setResults(((await r.json()) as { users?: Suggestion[] }).users ?? []);
      } catch { /* ignore transient search errors — the field stays free-text */ }
    }, DEBOUNCE_MS);
    return () => { live = false; if (timer.current) clearTimeout(timer.current); };
  }, [v, typed]);

  const err = maintainerContactError(v);
  const normalized = normalizeMaintainerContact(v);
  const unchanged = normalized === (value ?? null);
  const canSave = !busy && !err && !unchanged;

  const save = async () => {
    if (!canSave) return;
    if (await onSave(normalized)) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  // The input + its typeahead dropdown. `.ns-contact-field` carries the flex + width cap (in
  // globals.css, so the narrow-viewport rule can lift it) and is the hook for that rule (§14).
  const control = (
    <div
      className="ns-contact-field"
      style={{ position: "relative" }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}
    >
      <input
        className="input"
        style={{ width: "100%" }}
        value={v}
        onChange={(e) => { setV(e.target.value); setTyped(true); setOpen(true); }}
        onFocus={() => { if (results.length) setOpen(true); }}
        onKeyDown={(e) => { if (e.key === "Enter" && canSave) { setOpen(false); void save(); } }}
        placeholder="search a user, or type a team email…"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={err ? true : undefined}
        aria-describedby={`${MSG_ID}-${layout}`}
      />
      {open && results.length > 0 && (
        <ul className="search-ac" role="listbox">
          {results.map((u) => (
            <li key={u.id} role="option" aria-selected={false}>
              <button type="button" className="search-ac-item" onClick={() => { setV(u.email); setOpen(false); }}>
                <span className="search-ac-title">{u.name}</span>
                <span className="search-ac-sub mono">{u.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const saveButton = (
    <button className="btn btn-sm" disabled={!canSave} onClick={save}>Save</button>
  );
  const savedTick = saved
    ? <span style={{ fontSize: 12, color: "var(--ok)", whiteSpace: "nowrap", alignSelf: "center" }}>✓ Saved</span>
    : null;

  // Either the validation error or the help line — never both, and the same slot, so the row
  // doesn't jump as the user types. The help line exists because the value is outward-facing:
  // it is published as `owner.email` in the namespace's plugin-marketplace manifest (§30.3).
  const message = (
    <p
      id={`${MSG_ID}-${layout}`}
      className={err ? undefined : "muted"}
      style={{ fontSize: 12, marginTop: 6, marginBottom: 0, color: err ? "var(--danger)" : undefined }}
    >
      {err ?? "Published as the marketplace owner’s email when this namespace publishes a Claude plugin marketplace."}
    </p>
  );

  if (layout === "stacked") {
    return (
      <div style={{ marginTop: 14 }}>
        <label style={labelStyle}>Maintainer contact</label>
        <div className="ns-contact-row" style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
          {control}
          {saveButton}
          {savedTick}
        </div>
        {message}
      </div>
    );
  }

  return (
    <div>
      <div className="ns-contact-row" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 12.5, minWidth: 130 }}>Maintainer contact</span>
        {control}
        {saveButton}
        {savedTick}
      </div>
      {message}
    </div>
  );
}
