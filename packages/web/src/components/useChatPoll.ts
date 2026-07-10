"use client";
// Smart-polling cadence for chat (§24), read ONCE at mount from /api/me. Open tabs keep the set
// they loaded with; a new page load picks up an admin's change — so clients converge as tabs reload.
import { useEffect, useState } from "react";
import { cachedGet } from "./ui";

// Client-safe fallback mirroring lib/settings → DEFAULT_CHAT_POLL_INTERVALS. Primes, so the polls
// rarely coincide with other periodic requests. Used until /api/me loads (and if it returns nothing).
export const DEFAULT_CHAT_POLL_INTERVALS = [7, 11, 17, 19, 29, 41, 53];

/** The admin-configured ascending interval set (seconds); `[0]` is the floor. */
export function useChatPollIntervals(): number[] {
  const [intervals, setIntervals] = useState<number[]>(DEFAULT_CHAT_POLL_INTERVALS);
  useEffect(() => {
    let live = true;
    cachedGet<{ chatPollIntervals?: number[] }>("/api/me")
      .then((j) => {
        if (live && Array.isArray(j?.chatPollIntervals) && j.chatPollIntervals.length) setIntervals(j.chatPollIntervals);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return intervals;
}
