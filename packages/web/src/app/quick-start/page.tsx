"use client";
import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ScrollToTop, invalidateApi } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { QUICK_START, type QuickStartStep } from "./content";

function StepImage({ src, alt }: { src: string; alt: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static asset in /public; next/image adds no value here
    <img
      src={src}
      alt={alt}
      loading="lazy"
      style={{
        display: "block",
        width: "100%",
        height: "auto",
        marginTop: 16,
        borderRadius: 10,
        border: "1px solid var(--line)",
        boxShadow: "0 6px 24px rgba(0,0,0,.10)",
      }}
    />
  );
}

function Card({ step }: { step: QuickStartStep }) {
  const accent = step.kind === "contribute";
  return (
    <section
      className="card reveal"
      style={{
        padding: 22,
        marginBottom: 18,
        ...(accent ? { borderColor: "var(--accent)", background: "var(--accent-soft)" } : {}),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        {typeof step.n === "number" && (
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              width: 30,
              height: 30,
              borderRadius: "50%",
              background: "var(--accent)",
              color: "#fff",
              display: "grid",
              placeItems: "center",
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              fontWeight: 700,
            }}
          >
            {step.n}
          </span>
        )}
        <h2 style={{ margin: 0, fontSize: 19 }}>{step.title}</h2>
      </div>
      <p style={{ margin: "0 0 4px", fontSize: 14.5, lineHeight: 1.55, color: "var(--text)" }}>{step.lead}</p>
      {step.points && step.points.length > 0 && (
        <ul style={{ margin: "10px 0 0", paddingLeft: 20, fontSize: 13.5, lineHeight: 1.6, color: "var(--muted)" }}>
          {step.points.map((pt) => (
            <li key={pt}>{pt}</li>
          ))}
        </ul>
      )}
      {step.code && (
        <pre
          style={{
            margin: "12px 0 0",
            padding: "10px 12px",
            background: "var(--surface-2, var(--surface))",
            border: "1px solid var(--line)",
            borderRadius: 8,
            overflowX: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
          }}
        >
          {step.code}
        </pre>
      )}
      {step.links && step.links.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
          {step.links.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className="btn btn-sm">{l.label}</a>
          ))}
        </div>
      )}
      {step.image && <StepImage src={step.image} alt={step.alt ?? step.title} />}
    </section>
  );
}

function QuickStart() {
  const router = useRouter();

  // Mark the user onboarded the moment they land here — this releases AppShell's first-login
  // redirect gate (via the event) so navigating away never loops back, and persists it so later
  // logins skip Quick start. Best-effort; the page renders regardless. SKILLY_SPEC.md §8.
  useEffect(() => {
    fetch("/api/me/onboarded", { method: "POST" })
      .catch(() => {})
      .finally(() => {
        invalidateApi("/api/me");
        window.dispatchEvent(new Event("skilly:onboarded"));
      });
  }, []);

  const intro = QUICK_START.find((s) => s.kind === "intro");
  const body = QUICK_START.filter((s) => s.kind !== "intro" && s.kind !== "closing");
  const closing = QUICK_START.find((s) => s.kind === "closing");

  return (
    <div className="reveal" style={{ maxWidth: 760 }}>
      <ScrollToTop />
      <div className="page-head">
        <div className="eyebrow">Getting started</div>
        <h1 className="page-title">{intro?.title ?? "Quick start"}.</h1>
        {intro && <p className="page-sub">{intro.lead}</p>}
      </div>

      {body.map((step, i) => (
        <Card key={step.title + i} step={step} />
      ))}

      {closing && (
        <section className="card reveal" style={{ padding: 24, marginTop: 4, textAlign: "center" }}>
          <h2 style={{ margin: "0 0 6px", fontSize: 19 }}>{closing.title}</h2>
          <p style={{ margin: "0 auto 16px", maxWidth: 540, fontSize: 14.5, lineHeight: 1.55, color: "var(--muted)" }}>{closing.lead}</p>
          <div className="qs-cta" style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary" onClick={() => router.push("/catalog")}>
              Got it — go to the catalog →
            </button>
            <Link href="/whats-new" className="btn btn-sm">What&rsquo;s new</Link>
            <Link href="/installed" className="btn btn-sm">Installed skills</Link>
          </div>
        </section>
      )}
    </div>
  );
}

export default function QuickStartPage() {
  return (
    <RequireAuth>
      <QuickStart />
    </RequireAuth>
  );
}
