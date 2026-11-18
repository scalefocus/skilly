"use client";
// Delete a namespace — the Administration → Namespaces card's dialog (SKILLY_SPEC.md §72.5). It opens
// on the preflight (`GET /api/admin/namespaces/:id/deletion`) and shows one of two states:
//  - Blocked: the live skills and open proposals that must go first, each linking to its page;
//  - Ready: what the delete will do, an optional reason, and a type-the-slug confirmation.
// A 409 on Delete (a blocker appeared meanwhile) swaps the dialog into Blocked with the fresh lists.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Modal } from "../../components/ui";
import { NAMESPACE_DELETE_REASON_MAX, namespaceDeleteEffectLines, type NamespaceDeleteEffects } from "@skilly/shared/namespace-delete";

interface Blockers {
  skills: { slug: string; title: string; deprecated: boolean }[];
  skillsTotal: number;
  proposals: { id: string; title: string; state: string }[];
  proposalsTotal: number;
}

interface Preflight {
  namespace: { id: string; slug: string; displayName: string };
  deletable: boolean;
  blockers: Blockers;
  effects: NamespaceDeleteEffects & { archivedSkills: string[]; roleMappings: { groupDisplayName: string; role: string }[] };
}

const STATE_LABEL: Record<string, string> = {
  proposed: "proposed",
  under_review: "under review",
  changes_requested: "changes requested",
  awaiting_destination: "awaiting destination",
};

export function DeleteNamespaceDialog({
  ns,
  onClose,
  onDeleted,
}: {
  ns: { id: string; slug: string; displayName: string };
  onClose: () => void;
  onDeleted: (slug: string) => void;
}) {
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/admin/namespaces/${ns.id}/deletion`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) setLoadError(j.error ?? `Couldn’t check the namespace (${r.status})`);
        else setPreflight(j as Preflight);
      })
      .catch(() => { if (live) setLoadError("Couldn’t check the namespace — try again."); });
    return () => { live = false; };
  }, [ns.id]);

  const ready = preflight?.deletable === true;
  const canDelete = ready && confirm === ns.slug && !busy && reason.length <= NAMESPACE_DELETE_REASON_MAX;

  const submit = async () => {
    if (!canDelete) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/namespaces/${ns.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmSlug: confirm, reason: reason.trim() || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j.blockers && preflight) {
        setPreflight({ ...preflight, deletable: false, blockers: j.blockers as Blockers });
        return;
      }
      if (!r.ok) throw new Error(j.error ?? `Delete failed (${r.status})`);
      onDeleted(ns.slug);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const footer = ready ? (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="btn btn-danger" onClick={() => void submit()} disabled={!canDelete} data-testid="ns-delete-confirm">
        {busy ? "Deleting…" : "Delete namespace"}
      </button>
    </>
  ) : (
    <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
  );

  return (
    <Modal title={`Delete @${ns.slug}`} onCancel={onClose} footer={footer} initialFocusRef={ready ? confirmRef : undefined} testId="ns-delete-dialog">
      {loadError && <p style={{ color: "var(--danger)", margin: 0 }}>{loadError}</p>}
      {!loadError && !preflight && <p className="muted" style={{ margin: 0 }}>Checking what this namespace still holds…</p>}

      {preflight && !preflight.deletable && (
        <div data-testid="ns-delete-blocked">
          <p style={{ marginTop: 0 }}><strong>{ns.displayName}</strong> can’t be deleted yet.</p>
          {preflight.blockers.skillsTotal > 0 && (
            <section style={{ marginBottom: 14 }}>
              <div className="nav-label" style={{ padding: "0 0 6px" }}>Live skills ({preflight.blockers.skillsTotal})</div>
              <p className="muted" style={{ fontSize: 13, margin: "0 0 6px" }}>Move each one to another namespace or archive it.</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {preflight.blockers.skills.map((s) => (
                  <li key={s.slug}>
                    <Link href={`/skills/${ns.slug}/${s.slug}`}>{s.title}</Link>{" "}
                    <span className="muted mono" style={{ fontSize: 12 }}>{ns.slug}/{s.slug}{s.deprecated ? " · deprecated" : ""}</span>
                  </li>
                ))}
              </ul>
              {preflight.blockers.skillsTotal > preflight.blockers.skills.length && (
                <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>and {preflight.blockers.skillsTotal - preflight.blockers.skills.length} more</p>
              )}
            </section>
          )}
          {preflight.blockers.proposalsTotal > 0 && (
            <section>
              <div className="nav-label" style={{ padding: "0 0 6px" }}>Open proposals ({preflight.blockers.proposalsTotal})</div>
              <p className="muted" style={{ fontSize: 13, margin: "0 0 6px" }}>Accept, reject or delete each one.</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {preflight.blockers.proposals.map((p) => (
                  <li key={p.id}>
                    <Link href={`/proposals/${p.id}`}>{p.title}</Link>{" "}
                    <span className="muted mono" style={{ fontSize: 12 }}>{STATE_LABEL[p.state] ?? p.state}</span>
                  </li>
                ))}
              </ul>
              {preflight.blockers.proposalsTotal > preflight.blockers.proposals.length && (
                <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>and {preflight.blockers.proposalsTotal - preflight.blockers.proposals.length} more</p>
              )}
            </section>
          )}
        </div>
      )}

      {preflight && ready && (
        <div data-testid="ns-delete-ready">
          <p style={{ marginTop: 0 }}>
            Deleting <strong>{ns.displayName}</strong> (<span className="mono">@{ns.slug}</span>) is permanent.
          </p>
          {(() => {
            const lines = namespaceDeleteEffectLines(preflight.effects);
            if (lines.length === 0) return <p className="muted" style={{ fontSize: 13.5 }}>It holds nothing else.</p>;
            return (
              <ul style={{ margin: "0 0 14px", paddingLeft: 18, fontSize: 13.5 }} data-testid="ns-delete-effects">
                {lines.map((line) => (
                  <li key={line}>
                    {line}
                    {line.includes("archived skill") && preflight.effects.archivedSkills.length > 0 && (
                      <span className="muted mono" style={{ fontSize: 12 }}>: {preflight.effects.archivedSkills.join(", ")}</span>
                    )}
                    {line.includes("role mapping") && preflight.effects.roleMappings.length > 0 && (
                      <span className="muted" style={{ fontSize: 12 }}>
                        : {preflight.effects.roleMappings.map((m) => `${m.groupDisplayName} (${m.role.replace("namespace_", "")})`).join(", ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            );
          })()}
          <label style={{ display: "block", marginBottom: 12 }}>
            <span className="nav-label" style={{ padding: "0 0 6px", display: "block" }}>Reason (optional)</span>
            <textarea
              className="input"
              rows={3}
              maxLength={NAMESPACE_DELETE_REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Shown to the namespace's admins in their notification"
              style={{ width: "100%", resize: "vertical" }}
            />
            <span className="muted mono" style={{ fontSize: 11 }}>{reason.length}/{NAMESPACE_DELETE_REASON_MAX}</span>
          </label>
          <label style={{ display: "block" }}>
            <span className="nav-label" style={{ padding: "0 0 6px", display: "block" }}>Type <span className="mono">{ns.slug}</span> to confirm</span>
            <input
              ref={confirmRef}
              className="input mono"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
              autoComplete="off"
              spellCheck={false}
              aria-label={`Type ${ns.slug} to confirm`}
              data-testid="ns-delete-slug"
              style={{ width: "100%" }}
            />
          </label>
          {err && <p style={{ color: "var(--danger)", margin: "10px 0 0", fontSize: 13.5 }}>{err}</p>}
        </div>
      )}
    </Modal>
  );
}
