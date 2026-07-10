"use client";
import { APP_VERSION } from "@skilly/shared/version";
import { ScrollToTop } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { useDateFmt } from "../../components/DateFormat";
import { CHANGELOG } from "./changelog";

function WhatsNew() {
  const fmt = useDateFmt();
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
        {CHANGELOG.map((e) => {
          const current = e.version === APP_VERSION;
          return (
            <li key={e.version} style={{ position: "relative", paddingLeft: 28, paddingBottom: 22 }}>
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
      <WhatsNew />
    </RequireAuth>
  );
}
