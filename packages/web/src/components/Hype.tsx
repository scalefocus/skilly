"use client";
// Hype UI pieces (SKILLY_SPEC.md §50.6), shared by the skill detail page, the Hyped-skills board,
// the catalog cards and the home section: the 🔥 Hyped pill, the 🔥 N count, the hyper strip
// (up to 12 bubbles, then a "+N" chip that expands to the full list), and the Hype button with its
// disabled states. Dates are formatted in the viewer's own timezone and style (never server-side).
import { useState } from "react";
import { UserBubble } from "./UserBubble";
import { useDateFmt } from "./DateFormat";
import { invalidateApi } from "./ui";
import { HYPE_REFUSAL_COPY, type HypeRefusal } from "@skilly/shared/hype";

export interface HyperChip {
  userId: string;
  displayName: string;
  avatar: string | null;
}

/** The 🔥 Hyped pill — a skill in the current top N (as of the last sweep). */
export function HypedPill() {
  return (
    <span className="chip chip-hype" title="Hyped — in this week's top hyped skills" data-testid="hyped-pill">
      <span aria-hidden>🔥</span> Hyped
    </span>
  );
}

/** The small 🔥 N count on catalog cards and list rows. */
export function HypeCount({ count }: { count: number }) {
  if (!count) return null;
  const label = `${count} ${count === 1 ? "hype" : "hypes"} in the last 7 days`;
  return (
    <span className="hype-count" title={label} aria-label={label} data-testid="hype-count">
      <span aria-hidden>🔥</span> {count}
    </span>
  );
}

/**
 * The hyper strip: the given bubbles (already newest first), then "+N" when `total` exceeds them.
 * Clicking "+N" fetches the full list from `/api/skills/<ns>/<slug>/hypers` and shows it inline.
 */
export function HyperStrip({ ns, slug, hypers, total, size = 26 }: { ns: string; slug: string; hypers: HyperChip[]; total: number; size?: number }) {
  const [all, setAll] = useState<HyperChip[] | null>(null);
  const [loading, setLoading] = useState(false);
  const shown = all ?? hypers;
  const more = total - shown.length;
  const expand = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/skills/${ns}/${slug}/hypers`);
      if (r.ok) setAll(((await r.json()) as { hypers: HyperChip[] }).hypers);
    } finally {
      setLoading(false);
    }
  };
  if (shown.length === 0) return null;
  return (
    <div className="hype-strip" data-testid="hyper-strip">
      {shown.map((h) => (
        <UserBubble key={h.userId} name={h.displayName} avatar={h.avatar} userId={h.userId} size={size} />
      ))}
      {more > 0 && (
        <button type="button" className="hype-strip-more" disabled={loading} onClick={() => void expand()} aria-label={`Show all ${total} people who hyped this skill`}>
          {loading ? "…" : `+${more}`}
        </button>
      )}
    </div>
  );
}

export interface HypeButtonState {
  canHype: boolean;
  hypedByMe: boolean;
  remaining: number;
  /** When the viewer's next hype frees up (budget exhausted). */
  nextAt: string | null;
  /** When the viewer's own hype on this skill ages out. */
  myHypeExpiresAt?: string | null;
  /** Soft eligibility — false hides the button (the count still shows). */
  open?: boolean;
  isMaintainer?: boolean;
}

/**
 * The Hype button. Hidden for maintainers and for skills closed to new hypes; otherwise enabled,
 * "✓ Hyped" (disabled) once hyped, or disabled with the next-free date when the budget is spent.
 * `onHyped` runs after a successful post (the caller reloads its data).
 */
export function HypeButton({ ns, slug, state, count, onHyped, onError, compact = false }: {
  ns: string;
  slug: string;
  state: HypeButtonState;
  count?: number;
  onHyped: () => void;
  onError?: (text: string) => void;
  compact?: boolean;
}) {
  const fmt = useDateFmt();
  const [busy, setBusy] = useState(false);
  const [optimistic, setOptimistic] = useState(false);
  if (state.isMaintainer || state.open === false) return null;
  const hyped = state.hypedByMe || optimistic;
  const label = `🔥 ${hyped ? "✓ Hyped" : "Hype"}${count != null ? ` · ${count + (optimistic && !state.hypedByMe ? 1 : 0)}` : ""}`;
  let title = "Hype this skill — push a new skill up the Hyped skills board";
  if (hyped) {
    const until = state.myHypeExpiresAt ? ` — you can again on ${fmt.date(state.myHypeExpiresAt)}` : "";
    title = `You hyped this skill${until}`;
  } else if (!state.canHype && state.remaining === 0) {
    title = `No hypes left${state.nextAt ? ` · next frees ${fmt.dateTime(state.nextAt)}` : ""}`;
  }
  const disabled = busy || hyped || !state.canHype;
  const go = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/skills/${ns}/${slug}/hype`, { method: "POST" });
      if (r.ok) {
        setOptimistic(true);
        invalidateApi("/api/leaderboard/hyped");
        onHyped();
        return;
      }
      const j = (await r.json().catch(() => ({}))) as { reason?: HypeRefusal; nextAt?: string | null; error?: string };
      const copy = j.reason ? HYPE_REFUSAL_COPY[j.reason] : j.error ?? `Failed (${r.status})`;
      onError?.(copy.replace("{date}", j.nextAt ? fmt.dateTime(j.nextAt) : "later"));
      onHyped(); // a refusal means the page was stale — refresh it
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className={`btn btn-sm${hyped ? " btn-primary" : ""}`}
      disabled={disabled}
      onClick={() => void go()}
      title={title}
      data-testid="hype-button"
      style={compact ? { whiteSpace: "nowrap" } : undefined}
    >
      {label}
    </button>
  );
}
