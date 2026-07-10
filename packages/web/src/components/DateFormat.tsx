"use client";
// Display formatting for timestamps. INVARIANT: every timestamp is stored UTC in Postgres
// (timestamptz) and the API serializes it as a UTC ISO string; we convert to the VIEWER'S
// OWN timezone here, at render. The date/time *style* (EU vs US) is a platform setting
// chosen by admins (lib/settings.ts → /api/me → this provider):
//   EU → dd/mm/yyyy, 24-hour clock   (en-GB)
//   US → mm/dd/yyyy, 12-hour AM/PM   (en-US)
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { cachedGet, invalidateApi } from "./ui";

export type DateStyle = "eu" | "us";

const LOCALE: Record<DateStyle, string> = { eu: "en-GB", us: "en-US" };

const DateStyleContext = createContext<DateStyle>("eu");

/** Fetches the platform date/time style once and provides it to the tree. Defaults to EU
 *  until the setting loads (and for anonymous users, who see few timestamps). */
export function DateFormatProvider({ children }: { children: ReactNode }) {
  const [style, setStyle] = useState<DateStyle>("eu");
  useEffect(() => {
    let live = true;
    const refresh = (force: boolean) => {
      if (force) invalidateApi("/api/me"); // a just-saved override must bypass the shared cache
      cachedGet<{ dateFormat?: string }>("/api/me")
        .then((j) => {
          if (live && (j?.dateFormat === "eu" || j?.dateFormat === "us")) setStyle(j.dateFormat);
        })
        .catch(() => {});
    };
    refresh(false);
    // The profile page fires this after the user changes their override, so the whole app
    // re-renders dates in the new style without a reload.
    const onChange = () => refresh(true);
    window.addEventListener("skilly:dateformat-changed", onChange);
    return () => {
      live = false;
      window.removeEventListener("skilly:dateformat-changed", onChange);
    };
  }, []);
  return <DateStyleContext.Provider value={style}>{children}</DateStyleContext.Provider>;
}

export interface DateFormatter {
  style: DateStyle;
  /** date only — 12/06/2026 (EU) / 06/12/2026 (US) */
  date(iso: string | null | undefined): string;
  /** date + time in the viewer's timezone */
  dateTime(iso: string | null | undefined): string;
  /** time only — 18:47 (EU) / 6:47 PM (US) */
  time(iso: string | null | undefined): string;
}

export function useDateFmt(): DateFormatter {
  const style = useContext(DateStyleContext);
  return useMemo(() => {
    const loc = LOCALE[style];
    const us = style === "us";
    // No explicit timeZone → Intl uses the runtime (browser) timezone = the viewer's.
    const dateF = new Intl.DateTimeFormat(loc, { day: "2-digit", month: "2-digit", year: "numeric" });
    const dateTimeF = new Intl.DateTimeFormat(loc, {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: us,
    });
    const timeF = new Intl.DateTimeFormat(loc, { hour: "2-digit", minute: "2-digit", hour12: us });
    const fmt = (iso: string | null | undefined, f: Intl.DateTimeFormat) => {
      if (!iso) return "—";
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? "—" : f.format(d);
    };
    return {
      style,
      date: (iso) => fmt(iso, dateF),
      dateTime: (iso) => fmt(iso, dateTimeF),
      time: (iso) => fmt(iso, timeF),
    };
  }, [style]);
}
