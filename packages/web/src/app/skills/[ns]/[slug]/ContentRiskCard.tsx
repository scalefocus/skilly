"use client";
// The skill page's owner-only "Content risk" card (SKILLY_SPEC.md §37.8). Shown to effective
// maintainers, namespace admins of the skill's namespace and platform admins. Collapsible like
// the Discussion card; a `#content-risk` fragment (the skill.content_risk notification's link)
// opens it. Starts expanded when the version is flagged, collapsed otherwise.
import { useCallback, useEffect, useRef, useState } from "react";
import { Pill } from "../../../../components/ui";
import { useDateFmt } from "../../../../components/DateFormat";
import { ContentRiskFindingsList, ContentRiskStatusPill, type ContentRiskFinding } from "../../../../components/ContentRisk";
import type { ContentRiskStatus } from "@skilly/shared/content-risk-status";

interface Detail {
  semver: string;
  status: ContentRiskStatus;
  ruleset: number;
  findings: ContentRiskFinding[];
  reportCreatedAt: string | null;
  acknowledgements: { at: string; byName: string | null; note: string | null; source: "override" | "manual" }[];
  otherFlagged: string[];
  canAcknowledge: boolean;
}

export function ContentRiskCard({ ns, slug, initialStatus, onChanged }: { ns: string; slug: string; initialStatus: ContentRiskStatus | null; onChanged: () => void }) {
  const fmt = useDateFmt();
  const [semver, setSemver] = useState<string | null>(null);
  const [data, setData] = useState<Detail | null>(null);
  const [open, setOpen] = useState(initialStatus === "flagged");
  const [settled, setSettled] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cardRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/skills/${ns}/${slug}/content-risk${semver ? `?semver=${encodeURIComponent(semver)}` : ""}`);
    if (r.ok) setData((await r.json()) as Detail);
  }, [ns, slug, semver]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (window.location.hash === "#content-risk") {
      setOpen(true);
      window.setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  }, []);
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    const t = window.setTimeout(() => setSettled(true), 220);
    return () => window.clearTimeout(t);
  }, [open]);

  const acknowledge = async () => {
    if (!data) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/skills/${ns}/${slug}/content-risk/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ semver: data.semver, note: note.trim() || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Could not acknowledge");
      setNote("");
      await load();
      onChanged();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const issues = (data?.findings ?? []).filter((f) => f.severity !== "info");
  const bodyId = "skill-content-risk-body";
  return (
    <section ref={cardRef} id="content-risk" className="card reveal" style={{ marginTop: 20, scrollMarginTop: 80 }} data-testid="content-risk-card">
      <button type="button" className="admin-card-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={bodyId}>
        <h2 className="admin-card-title" style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>Content risk</h2>
        {data && <span className="admin-card-summary"><ContentRiskStatusPill status={data.status} /></span>}
        <span style={{ flex: 1 }} />
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="admin-card-chevron" data-open={open}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div className="admin-card-body" data-open={open} data-settled={settled} id={bodyId} role="region" aria-hidden={!open}>
        <div className="admin-card-body-inner">
          <div className="admin-card-body-pad">
            {!data ? (
              <div className="skeleton" style={{ height: 60, borderRadius: "var(--radius-sm)" }} />
            ) : (
              <>
                <p className="muted" style={{ fontSize: 13.5, marginTop: 0, marginBottom: 14 }}>
                  What the content check found in <span className="mono">v{data.semver}</span>, read as instructions an agent will follow.
                  Only maintainers and admins see this; everyone else sees the status line.
                  {data.reportCreatedAt ? ` Checked ${fmt.dateTime(data.reportCreatedAt)} at ruleset ${data.ruleset}.` : ""}
                </p>

                {data.status === "pending" ? (
                  <p className="muted" style={{ fontSize: 13 }}>This version hasn’t been through the current content check yet. It is checked automatically in the background.</p>
                ) : issues.length === 0 ? (
                  <p className="muted" style={{ fontSize: 13 }}>No content risks found.</p>
                ) : (
                  <ContentRiskFindingsList findings={issues} />
                )}

                {data.acknowledgements.length > 0 && (
                  <div style={{ marginTop: 14, display: "grid", gap: 6 }}>
                    {data.acknowledgements.map((a, i) => (
                      <div key={i} style={{ fontSize: 13 }}>
                        <Pill tone="muted">{a.source === "override" ? "acknowledged at accept" : "acknowledged"}</Pill>{" "}
                        <span>{a.byName ?? "a former user"} · {fmt.dateTime(a.at)}</span>
                        {a.note && <div className="muted" style={{ fontSize: 12.5, marginTop: 2, whiteSpace: "pre-wrap" }}>{a.note}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {data.canAcknowledge && (
                  <div style={{ marginTop: 16 }}>
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value.slice(0, 500))}
                      placeholder="Optional note — why these findings are acceptable…"
                      rows={2}
                      aria-label="Acknowledgement note"
                      style={{ width: "100%", padding: 10, borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 13.5, resize: "vertical" }}
                    />
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
                      <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void acknowledge()}>
                        Acknowledge
                      </button>
                      <span className="muted" style={{ fontSize: 12 }}>Records that you reviewed these findings (audit-logged). The version stays installable either way.</span>
                    </div>
                  </div>
                )}
                {err && <div style={{ marginTop: 10, fontSize: 13, color: "var(--danger)" }}>{err}</div>}

                {data.otherFlagged.length > 0 && (
                  <div style={{ marginTop: 16, fontSize: 13 }}>
                    Other active versions flagged:{" "}
                    {data.otherFlagged.map((v, i) => (
                      <span key={v}>
                        {i > 0 && ", "}
                        <button type="button" className="btn-ghost mono" style={{ padding: 0, fontSize: 13, textDecoration: "underline" }} onClick={() => setSemver(v)}>v{v}</button>
                      </span>
                    ))}
                  </div>
                )}
                {semver && (
                  <button type="button" className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => setSemver(null)}>Back to the latest version</button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
