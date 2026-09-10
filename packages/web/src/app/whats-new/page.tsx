"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { APP_VERSION } from "@skilly/shared/version";
import { countNewSince } from "@skilly/shared/whats-new";
import { ScrollToTop, cachedGet, invalidateApi } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { useDateFmt } from "../../components/DateFormat";
import { CHANGELOG } from "./changelog";

function WhatsNew() {
  const fmt = useDateFmt();
  // `?since=<version>` — set by the update notice's link (§23): the user's marker before they
  // acknowledged this release. Entries newer than it sit above a "New since your last visit"
  // divider. When the param is absent the marker itself (as read BEFORE this page's own stamp) is
  // the fallback, so the divider works from the account menu too. Present-but-invalid or not-lower
  // → the plain timeline.
  const sinceParam = useSearchParams().get("since");
  const [markerSince, setMarkerSince] = useState<string | null>(null);

  // Opening this page is the read receipt (§23): read the marker for the divider fallback, then
  // stamp the running version and tell the shell so an open update notice closes without a second
  // stamp. Best-effort — the page renders regardless.
  useEffect(() => {
    cachedGet<{ whatsNewSeenVersion?: string | null }>("/api/me")
      .then((j) => j.whatsNewSeenVersion ?? null)
      .catch(() => null)
      .then((prev) => {
        setMarkerSince(prev);
        return fetch("/api/me/whats-new-seen", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: APP_VERSION }),
        }).catch(() => null);
      })
      .then(() => {
        invalidateApi("/api/me");
        window.dispatchEvent(new Event("skilly:whats-new-seen"));
      });
  }, []);

  const since = sinceParam ?? markerSince;
  const newCount = countNewSince(CHANGELOG.map((e) => e.version), since, APP_VERSION);
  return (
    <div className="reveal" style={{ maxWidth: 760 }}>
      <ScrollToTop />
      <div className="page-head">
        <div className="eyebrow">Release notes</div>
        <h1 className="page-title">What&rsquo;s new.</h1>
        <p className="page-sub">
          Every change to skilly, newest first. You&rsquo;re on <span className="mono">v{APP_VERSION}</span>.
        </p>
      </div>

      {/* A simple vertical timeline: version + date on the left rail, the change on the right. */}
      <ol style={{ listStyle: "none", margin: 0, padding: 0, position: "relative" }}>
        <span aria-hidden style={{ position: "absolute", left: 5, top: 6, bottom: 6, width: 2, background: "var(--line)" }} />
        {CHANGELOG.map((e, i) => {
          const current = e.version === APP_VERSION;
          const isNew = i < newCount;
          return (
            <li key={e.version} data-new-since={isNew ? "true" : undefined} style={{ position: "relative", paddingLeft: 28, paddingBottom: 22 }}>
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  left: 0,
                  top: 5,
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: current ? "var(--accent)" : "var(--surface)",
                  border: `2px solid ${current ? "var(--accent)" : "var(--line)"}`,
                  boxShadow: "0 0 0 4px var(--bg)",
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
                <span className={`chip${current ? " chip-accent" : ""} mono`} style={{ fontSize: 12 }}>v{e.version}</span>
                <span className="muted mono" style={{ fontSize: 11.5 }}>{fmt.date(e.date)}</span>
                {current && <span className="muted" style={{ fontSize: 11.5 }}>· current</span>}
              </div>
              <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.5 }}>{e.summary}</p>
              {/* The divider sits under the LAST new entry: everything above it is new since the
                  visitor's previous version, everything below they have already been told about. */}
              {newCount > 0 && i === newCount - 1 && (
                <div
                  role="separator"
                  aria-label="New since your last visit"
                  data-testid="whats-new-divider"
                  style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 22, marginBottom: 2 }}
                >
                  <span className="chip chip-accent" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>New since your last visit</span>
                  <span aria-hidden style={{ flex: 1, height: 1, background: "var(--line-strong)" }} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default function WhatsNewPage() {
  return (
    <RequireAuth>
      {/* WhatsNew reads ?since= via useSearchParams — needs a Suspense boundary (like the catalog). */}
      <Suspense fallback={<div className="skeleton" style={{ height: 16, width: "45%" }} />}>
        <WhatsNew />
      </Suspense>
    </RequireAuth>
  );
}
