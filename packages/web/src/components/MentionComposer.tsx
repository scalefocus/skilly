"use client";
// The mention-capable message composer (SKILLY_SPEC.md §24 "Mentions"). A contentEditable box
// that behaves like the plain textarea it replaces — plain text, Enter to send, Shift+Enter for
// a newline, native emoji — plus the `#`/`@` pickers:
//  - typing `@`/`#` at a word boundary opens a caret-anchored suggestion picker (2+ chars after
//    the trigger, ~180 ms debounce, ≤6 rows); ↑/↓ navigate, Enter/Tab select, Escape dismisses —
//    while the picker is open Enter SELECTS and never sends;
//  - a picked mention is inserted as an ATOMIC chip (contentEditable=false, so Backspace removes
//    it whole and the caret never lands inside it) that serializes to its `<@uuid>`/`<#uuid>`
//    token — the value reported to the parent is always the token-form body;
//  - the picker renders in a portal above everything (like the §28 hover card) and flips above
//    the composer when there is no room below — usable inside the topbar dropdown and the
//    mobile full-screen sheet (rows are tap-sized).
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UserBubble } from "./UserBubble";

interface UserSuggestion { id: string; name: string; email: string; avatar: string | null }
interface SkillSuggestion { id: string; namespaceSlug: string; skillSlug: string; title: string }

type PickerItem =
  | { kind: "user"; id: string; label: string; sub: string; avatar: string | null }
  | { kind: "skill"; id: string; label: string; sub: string };

interface PickerState {
  kind: "user" | "skill";
  /** Query typed after the trigger char (may span a single space for names). */
  query: string;
  items: PickerItem[];
  sel: number;
  /** Viewport-fixed anchor (caret position at the trigger). */
  rect: { left: number; top: number; bottom: number };
}

export interface MentionComposerHandle {
  /** Insert plain text at the caret (the emoji picker). */
  insertText(text: string): void;
  clear(): void;
  focus(): void;
}

const DEBOUNCE_MS = 180;
const MIN_QUERY = 2;
const MAX_QUERY = 40;
const PICKER_MAX_H = 264;

/** The trailing `@…`/`#…` run before the caret, if the trigger sits at a word boundary. */
function matchTrigger(textBefore: string): { kind: "user" | "skill"; query: string; start: number } | null {
  const m = /(^|[\s ])([@#])([^\n]{0,60})$/.exec(textBefore);
  if (!m) return null;
  const query = m[3] ?? "";
  // A double space (or a fresh trigger char inside the run) ends the mention attempt.
  if (query.length > MAX_QUERY || /\s\s/.test(query) || /[@#]/.test(query)) return null;
  return { kind: m[2] === "@" ? "user" : "skill", query, start: textBefore.length - query.length - 1 };
}

/** Build the DOM chip for an inserted mention — serialized back via data-mention. */
function chipEl(kind: "user" | "skill", id: string, label: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.setAttribute("data-mention", `<${kind === "user" ? "@" : "#"}${id}>`);
  el.setAttribute("contenteditable", "false");
  el.className = `mention-chip mention-chip-input ${kind === "user" ? "mention-chip-user" : "mention-chip-skill"}`;
  el.textContent = label;
  return el;
}

/** Serialize the editable's DOM back to the token-form body. */
function serialize(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.nodeValue ?? "";
      } else if (child instanceof HTMLElement) {
        const token = child.getAttribute("data-mention");
        if (token) out += token;
        else if (child.tagName === "BR") out += "\n";
        else {
          // A block element a browser slipped in (paste/IME edge): treat as a line break.
          if (out && !out.endsWith("\n") && /^(DIV|P)$/.test(child.tagName)) out += "\n";
          walk(child);
        }
      }
    }
  };
  walk(root);
  return out;
}

export const MentionComposer = forwardRef<
  MentionComposerHandle,
  {
    onChange: (body: string) => void;
    onSubmit: () => void;
    placeholder: string;
    /** `/api/users/suggest` context (`proposal:<id>` / `skill:<ns>/<slug>`); null/undefined = whole directory. */
    mentionContext?: string | null;
    disabled?: boolean;
    minHeight?: number;
    ariaLabel?: string;
  }
>(function MentionComposer({ onChange, onSubmit, placeholder, mentionContext, disabled, minHeight = 38, ariaLabel }, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const pickerRef = useRef<PickerState | null>(null);
  pickerRef.current = picker;
  const debounceRef = useRef<number | null>(null);
  const fetchSeq = useRef(0);
  // After Escape (or a no-result run) the same trigger run stays dismissed until it changes.
  const dismissedRef = useRef<string | null>(null);
  const [empty, setEmpty] = useState(true);

  const report = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const body = serialize(root);
    setEmpty(body.trim().length === 0 && !root.querySelector("[data-mention]"));
    onChange(body);
  }, [onChange]);

  const closePicker = useCallback(() => setPicker(null), []);

  /** Text of the caret's line up to the caret, staying inside the editable. */
  const textBeforeCaret = (): { text: string; node: Text; offset: number } | null => {
    const root = rootRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (!(node instanceof Text) || !root.contains(node)) return null;
    return { text: (node.nodeValue ?? "").slice(0, range.startOffset), node, offset: range.startOffset };
  };

  const runSuggest = useCallback((kind: "user" | "skill", query: string) => {
    const seq = ++fetchSeq.current;
    const url =
      kind === "user"
        ? `/api/users/suggest?q=${encodeURIComponent(query)}${mentionContext ? `&context=${encodeURIComponent(mentionContext)}` : ""}`
        : `/api/skills/suggest?q=${encodeURIComponent(query)}&scope=mention`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { users?: UserSuggestion[]; suggestions?: SkillSuggestion[] }) => {
        if (seq !== fetchSeq.current) return; // stale
        const cur = pickerRef.current;
        if (!cur || cur.kind !== kind) return;
        const items: PickerItem[] =
          kind === "user"
            ? (j.users ?? []).map((u) => ({ kind: "user" as const, id: u.id, label: u.name, sub: u.email, avatar: u.avatar }))
            : (j.suggestions ?? []).slice(0, 6).map((s) => ({ kind: "skill" as const, id: s.id, label: s.title, sub: `${s.namespaceSlug}/${s.skillSlug}` }));
        if (items.length === 0) {
          setPicker(null);
          return;
        }
        setPicker((p) => (p && p.kind === kind ? { ...p, items, sel: Math.min(p.sel, items.length - 1) } : p));
      })
      .catch(() => {
        if (seq === fetchSeq.current) setPicker(null);
      });
  }, [mentionContext]);

  /** Re-evaluate the trigger under the caret (on input and caret moves). */
  const evaluateTrigger = useCallback(() => {
    const at = textBeforeCaret();
    const trig = at ? matchTrigger(at.text) : null;
    if (!trig || trig.query.length < MIN_QUERY) {
      if (trig) dismissedRef.current = null; // fresh short run re-arms
      closePicker();
      return;
    }
    const runKey = `${trig.kind}:${trig.start}`;
    if (dismissedRef.current === runKey) return;
    const sel = window.getSelection();
    const rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    const anchor = rect && (rect.left || rect.top) ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null;
    if (!anchor) return;
    setPicker((p) => ({
      kind: trig.kind,
      query: trig.query,
      items: p && p.kind === trig.kind ? p.items : [],
      sel: p && p.kind === trig.kind ? p.sel : 0,
      rect: anchor,
    }));
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => runSuggest(trig.kind, trig.query), DEBOUNCE_MS);
  }, [closePicker, runSuggest]);

  /** Replace the live trigger run with an atomic chip + a trailing space. */
  const pick = useCallback((item: PickerItem) => {
    const at = textBeforeCaret();
    const trig = at ? matchTrigger(at.text) : null;
    if (!at || !trig) {
      closePicker();
      return;
    }
    const { node, offset } = at;
    const range = document.createRange();
    range.setStart(node, trig.start);
    range.setEnd(node, offset);
    range.deleteContents();
    const chip = chipEl(item.kind, item.id, item.kind === "user" ? `@${item.label}` : item.label);
    const space = document.createTextNode(" ");
    range.insertNode(space);
    range.insertNode(chip);
    // Caret after the trailing space, ready to keep typing.
    const sel = window.getSelection();
    if (sel) {
      const after = document.createRange();
      after.setStart(space, 1);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
    dismissedRef.current = null;
    closePicker();
    report();
    rootRef.current?.focus();
  }, [closePicker, report]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const p = pickerRef.current;
    if (p && p.items.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setPicker((cur) => (cur ? { ...cur, sel: (cur.sel + d + cur.items.length) % cur.items.length } : cur));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        // Picker open → Enter SELECTS, never sends (§24).
        e.preventDefault();
        const item = p.items[p.sel];
        if (item) pick(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        const at = textBeforeCaret();
        const trig = at ? matchTrigger(at.text) : null;
        if (trig) dismissedRef.current = `${trig.kind}:${trig.start}`;
        closePicker();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertLineBreak");
      report();
    }
  };

  // Close the picker on outside press / caret leaving the run / scroll of anything above us.
  useEffect(() => {
    if (!picker) return;
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (rootRef.current?.contains(t) || document.getElementById("mention-picker")?.contains(t))) return;
      closePicker();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", closePicker);
    document.addEventListener("scroll", closePicker, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", closePicker);
      document.removeEventListener("scroll", closePicker, true);
    };
  }, [picker, closePicker]);

  useEffect(() => () => { if (debounceRef.current !== null) window.clearTimeout(debounceRef.current); }, []);

  useImperativeHandle(ref, () => ({
    insertText(text: string) {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      document.execCommand("insertText", false, text);
      report();
    },
    clear() {
      const root = rootRef.current;
      if (!root) return;
      root.innerHTML = "";
      setEmpty(true);
      onChange("");
      closePicker();
    },
    focus() {
      rootRef.current?.focus();
    },
  }), [report, onChange, closePicker]);

  // Flip the picker above the caret when there's no room below (topbar dropdown, mobile sheet).
  const pickerStyle = (): React.CSSProperties => {
    if (!picker) return {};
    const below = window.innerHeight - picker.rect.bottom;
    const openUp = below < PICKER_MAX_H + 12;
    const left = Math.min(Math.max(8, picker.rect.left), Math.max(8, window.innerWidth - 288));
    return openUp
      ? { position: "fixed", left, bottom: window.innerHeight - picker.rect.top + 6, zIndex: 400 }
      : { position: "fixed", left, top: picker.rect.bottom + 6, zIndex: 400 };
  };

  return (
    <>
      <div
        ref={rootRef}
        className="mention-composer"
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel ?? placeholder}
        data-empty={empty}
        data-placeholder={placeholder}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck
        onInput={() => {
          report();
          evaluateTrigger();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          // Caret moves (arrows/home/end) re-evaluate the trigger without an input event.
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) evaluateTrigger();
        }}
        onClick={evaluateTrigger}
        onBlur={() => {
          // Give a picker-row mousedown time to land (rows preventDefault, so normally no blur).
          window.setTimeout(() => {
            if (!document.getElementById("mention-picker")?.contains(document.activeElement)) closePicker();
          }, 120);
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          if (text) document.execCommand("insertText", false, text);
          report();
          evaluateTrigger();
        }}
        style={{ minHeight }}
      />
      {picker && picker.items.length > 0 &&
        createPortal(
          <div id="mention-picker" role="listbox" aria-label={picker.kind === "user" ? "People" : "Skills"} className="mention-picker" style={pickerStyle()}>
            {picker.items.map((it, i) => (
              <button
                key={`${it.kind}:${it.id}`}
                type="button"
                role="option"
                aria-selected={i === picker.sel}
                className={`mention-picker-row${i === picker.sel ? " mention-picker-row-sel" : ""}`}
                onMouseDown={(e) => e.preventDefault() /* keep composer focus */}
                onClick={() => pick(it)}
                onMouseEnter={() => setPicker((p) => (p ? { ...p, sel: i } : p))}
              >
                {it.kind === "user" ? (
                  <UserBubble name={it.label} avatar={it.avatar} size={22} />
                ) : (
                  <span aria-hidden className="mono muted" style={{ width: 22, textAlign: "center", flexShrink: 0 }}>#</span>
                )}
                <span style={{ minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.label}</span>
                  <span className="muted mono" style={{ fontSize: 10.5, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.sub}</span>
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
});
