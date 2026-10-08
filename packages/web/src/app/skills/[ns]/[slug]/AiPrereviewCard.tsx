"use client";
// The skill page's owner-only AI pre-review card (SKILLY_SPEC.md §46.8). Shown to effective
// maintainers, namespace admins of the skill's namespace and platform admins — the §37.8 owner
// audience. Consumers never see it. A `#ai-prereview` fragment (the skill.ai_prereview_flagged
// notification's link) opens it. Starts expanded when the version is flagged. Hidden when the
// version was never reviewed and the viewer can't run it (nothing to show).
import { useCallback, useEffect, useRef, useState } from "react";
import { useAiName } from "../../../../components/AiName";
import { AiPrereviewBody, AiPrereviewStatusPill, useLivePrereview } from "../../../../components/AiPrereview";
import { isFlaggingSeverity, type PrereviewView } from "@skilly/shared/ai-prereview";

type Detail = PrereviewView & { semver: string; otherFlagged: string[] };

export function AiPrereviewCard({ ns, slug }: { ns: string; slug: string }) {
  const aiName = useAiName();
  const [semver, setSemver] = useState<string | null>(null);
  const [initial, setInitial] = useState<Detail | null>(null);
  const [open, setOpen] = useState(false);
  const [settled, setSettled] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const fromHash = useRef(false);

  const fetchView = useCallback(async (): Promise<Detail | null> => {
    const r = await fetch(`/api/skills/${ns}/${slug}/ai-prereview${semver ? `?semver=${encodeURIComponent(semver)}` : ""}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as Detail) : null;
  }, [ns, slug, semver]);
  useEffect(() => {
    let live = true;
    void fetchView().then((d) => {
      if (!live) return;
      setInitial(d);
      if (d && !fromHash.current) setOpen(isFlaggingSeverity(d.run?.maxSeverity));
    });
    return () => { live = false; };
  }, [fetchView]);
  const { view, refresh } = useLivePrereview(initial, fetchView);

  useEffect(() => {
    if (window.location.hash === "#ai-prereview") {
      fromHash.current = true;
      setOpen(true);
      window.setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }
  }, []);
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    const t = window.setTimeout(() => setSettled(true), 220);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!view) return null;
  if (view.status === "none" && !view.canRerun && !semver) return null;
  const bodyId = "skill-ai-prereview-body";
  return (
    <section ref={cardRef} id="ai-prereview" className="card reveal" style={{ marginTop: 20, scrollMarginTop: 80 }} data-testid="ai-prereview-card">
      <button type="button" className="admin-card-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={bodyId}>
        <h2 className="admin-card-title" style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{aiName} pre-review</h2>
        <span className="admin-card-summary"><AiPrereviewStatusPill view={view} /></span>
        <span style={{ flex: 1 }} />
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="admin-card-chevron" data-open={open}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div className="admin-card-body" data-open={open} data-settled={settled} id={bodyId} role="region" aria-hidden={!open}>
        <div className="admin-card-body-inner">
          <div className="admin-card-body-pad">
            <p className="muted" style={{ fontSize: 13.5, marginTop: 0, marginBottom: 12 }}>
              What {aiName} found when it read <span className="mono">v{view.semver}</span>’s SKILL.md, scripts and references before
              publish. Only maintainers and admins see this.
            </p>
            <AiPrereviewBody
              view={view}
              aiName={aiName}
              rerunUrl={`/api/skills/${ns}/${slug}/ai-prereview/rerun`}
              rerunBody={{ semver: view.semver }}
              dispositionUrl={`/api/skills/${ns}/${slug}/ai-prereview/dispositions`}
              dispositionExtra={{ semver: view.semver }}
              onChanged={refresh}
            />
            {view.otherFlagged.length > 0 && (
              <div style={{ marginTop: 16, fontSize: 13 }}>
                Other active versions with high or critical findings:{" "}
                {view.otherFlagged.map((v, i) => (
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
          </div>
        </div>
      </div>
    </section>
  );
}
