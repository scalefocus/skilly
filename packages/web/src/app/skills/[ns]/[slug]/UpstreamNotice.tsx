"use client";
// The upstream notice (SKILLY_SPEC.md §63.7): shown to a pointer skill's effective maintainers and
// platform admins — the API sends `upstream` to nobody else. Four states: a pending release
// (Propose the update · Skip this release), a release an open proposal already covers (View the
// proposal), a skipped release (one muted line with Un-skip), and branch drift (Propose the update).
import { useState } from "react";
import Link from "next/link";
import { useDateFmt } from "../../../../components/DateFormat";

export interface UpstreamView {
  kind: "release" | "branch_drift";
  currentRef: string;
  baselineSemver: string;
  release?: { ref: string; semver: string; bump: "major" | "minor" | "patch" | null; detectedAt: string | null };
  proposal?: { id: string };
  skipped?: { ref: string; byName: string | null; at: string | null };
  proposePath: string;
}

export function UpstreamNotice({ ns, slug, upstream, onChanged }: { ns: string; slug: string; upstream: UpstreamView; onChanged: () => void }) {
  const fmt = useDateFmt();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const call = async (method: "POST" | "DELETE", body?: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/skills/${ns}/${slug}/upstream/skip`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.error === "not_pending" || j.error === "not_skipped" ? "This changed in the meantime — refreshing." : j.error ?? "Couldn’t save that.");
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  // A skipped release: one muted line, reversible.
  if (upstream.kind === "release" && upstream.skipped && upstream.release) {
    return (
      <div className="muted" style={{ fontSize: 12.5, marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }} data-testid="upstream-skipped" id="upstream">
        <span>
          Skipped upstream <span className="mono">{upstream.release.ref}</span>
          {upstream.skipped.byName || upstream.skipped.at ? (
            <> ({[upstream.skipped.byName, upstream.skipped.at ? fmt.date(upstream.skipped.at) : null].filter(Boolean).join(", ")})</>
          ) : null}
          .
        </span>
        <button type="button" className="btn-ghost mono" style={{ fontSize: 12 }} disabled={busy} onClick={() => void call("DELETE")} data-testid="upstream-unskip">
          un-skip
        </button>
        {err && <span style={{ color: "var(--danger)" }}>{err}</span>}
      </div>
    );
  }

  const covered = upstream.proposal;
  const text =
    upstream.kind === "release" && upstream.release ? (
      <>
        Upstream <span className="mono">{upstream.release.ref}</span> is out.{" "}
        {covered ? (
          "An update is already proposed."
        ) : (
          <>
            This skill pins <span className="mono">{upstream.currentRef}</span>
            {upstream.release.bump ? ` (${upstream.release.bump} update)` : ""}.
          </>
        )}
      </>
    ) : (
      <>
        Upstream <span className="mono">{upstream.currentRef}</span> has moved since <span className="mono">v{upstream.baselineSemver}</span> was pinned.
        {covered ? " An update is already proposed." : ""}
      </>
    );

  return (
    <div
      className="card card-pad"
      role="status"
      id="upstream"
      data-testid="upstream-notice"
      style={{ marginTop: 16, borderColor: "var(--accent)", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}
    >
      <div style={{ flex: 1, minWidth: 240, fontSize: 14 }}>
        <div style={{ fontWeight: 600 }}>{text}</div>
        {err && <div style={{ color: "var(--danger)", fontSize: 12.5, marginTop: 4 }}>{err}</div>}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {covered ? (
          <Link href={`/proposals/${covered.id}`} className="btn btn-sm" data-testid="upstream-view-proposal">
            View the proposal
          </Link>
        ) : (
          <>
            <Link href={upstream.proposePath} className="btn btn-sm btn-primary" data-testid="upstream-propose">
              Propose the update
            </Link>
            {upstream.kind === "release" && upstream.release && (
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void call("POST", { ref: upstream.release!.ref })} data-testid="upstream-skip">
                Skip this release
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
