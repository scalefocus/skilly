"use client";
// Following people (SKILLY_SPEC.md §35.4) — the ONE Follow / Unfollow button every surface renders,
// plus the page-wide store behind it. The viewer's followed set is loaded once from
// `GET /api/me/following` and shared by every button on the page, so a leaderboard row and its open
// hover card always agree; a click updates the store optimistically and reverts on failure.
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cachedGet } from "./ui";
import { reportFeatureUse } from "../lib/surveyClient";

export type FollowState = "active" | "paused" | "inactive";

export interface FollowedUser {
  userId: string;
  displayName: string;
  avatar: string | null;
  since: string;
  state: FollowState;
}

interface Snapshot {
  loaded: boolean;
  meId: string | null;
  list: FollowedUser[];
  ids: ReadonlySet<string>;
  /** People who turned out to be unfollowable mid-page (a 409 race with a pause) — hide their button. */
  blocked: ReadonlySet<string>;
}

let snap: Snapshot = { loaded: false, meId: null, list: [], ids: new Set(), blocked: new Set() };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function set(next: Partial<Snapshot>): void {
  snap = { ...snap, ...next };
  if (next.list) snap.ids = new Set(next.list.map((f) => f.userId));
  for (const l of listeners) l();
}

async function fetchList(): Promise<FollowedUser[]> {
  const r = await fetch("/api/me/following");
  if (!r.ok) throw new Error(`following failed (${r.status})`);
  return ((await r.json()) as { following: FollowedUser[] }).following ?? [];
}

/** Load (once per page session) the viewer's id and followed list. `force` re-reads the list. */
export function loadFollowing(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const [me, list] = await Promise.all([
        snap.meId ? Promise.resolve({ userId: snap.meId }) : cachedGet<{ userId: string | null }>("/api/me").catch(() => ({ userId: null })),
        fetchList(),
      ]);
      set({ loaded: true, meId: me.userId ?? null, list });
    } catch {
      set({ loaded: true }); // a failed read leaves buttons at "Follow"; the server stays authoritative
    }
  })();
  return loading;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const SERVER_SNAP: Snapshot = { loaded: false, meId: null, list: [], ids: new Set(), blocked: new Set() };

/** The shared follow store, loading it on first use. */
export function useFollowStore(): Snapshot {
  const s = useSyncExternalStore(subscribe, () => snap, () => SERVER_SNAP);
  useEffect(() => {
    void loadFollowing();
  }, []);
  return s;
}

export type FollowError = "follows_disabled" | "failed";

/**
 * Follow (`on`) or unfollow `userId`. Optimistic: the store flips first and reverts on failure. A
 * `409 follows_disabled` also hides that person's button for the rest of the page (§35.4).
 */
export async function setFollow(userId: string, on: boolean): Promise<{ ok: true } | { ok: false; error: FollowError }> {
  const before = snap.list;
  if (on && !snap.ids.has(userId)) {
    set({ list: [{ userId, displayName: "", avatar: null, since: new Date().toISOString(), state: "active" }, ...before] });
  } else if (!on) {
    set({ list: before.filter((f) => f.userId !== userId) });
  }
  try {
    const r = await fetch(`/api/users/${encodeURIComponent(userId)}/follow`, { method: on ? "PUT" : "DELETE" });
    if (!r.ok) {
      set({ list: before });
      if (r.status === 409) {
        set({ blocked: new Set([...snap.blocked, userId]) });
        return { ok: false, error: "follows_disabled" };
      }
      return { ok: false, error: "failed" };
    }
    // Re-read so the list rows (name, avatar, since, state) are the server's, not the placeholder.
    void loadFollowing(true);
    if (on) reportFeatureUse("follow"); // §36.3
    return { ok: true };
  } catch {
    set({ list: before });
    return { ok: false, error: "failed" };
  }
}

/**
 * The button. Renders nothing for your own id, for someone who isn't followable (paused, inactive,
 * erased — the payload's `followable`), or before the store has loaded (so it never flickers from
 * "Follow" to "Unfollow"). Label: Follow ↔ Unfollow, no confirmation (§35.4).
 */
export function FollowButton({
  userId,
  followable,
  name,
  className = "btn btn-sm",
  style,
}: {
  userId: string;
  followable: boolean;
  /** For the tooltip and the "isn't accepting followers" toast. */
  name?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const s = useFollowStore();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const hidden = !s.loaded || !followable || s.blocked.has(userId) || (s.meId !== null && s.meId === userId);
  const following = s.ids.has(userId);
  const who = name?.trim() || "This person";

  const toastEl = toast && typeof document !== "undefined" ? createPortal(<div className="toast" role="status">{toast}</div>, document.body) : null;
  if (hidden) return toastEl;

  const onClick = async (ev: React.MouseEvent) => {
    // Many buttons sit inside a row link or a hover card — the click is this button's alone.
    ev.stopPropagation();
    setBusy(true);
    const r = await setFollow(userId, !following);
    setBusy(false);
    if (!r.ok) setToast(r.error === "follows_disabled" ? `${who} isn’t accepting followers.` : "Couldn’t update — try again.");
  };

  return (
    <>
      <button
        type="button"
        className={className}
        style={style}
        disabled={busy}
        aria-pressed={following}
        data-follow={following ? "following" : "not-following"}
        onClick={onClick}
        title={following ? `Stop following ${who}` : `Follow ${who} — get notified when they publish, request or earn a badge`}
      >
        {following ? "Unfollow" : "Follow"}
      </button>
      {toastEl}
    </>
  );
}
