"use client";
// "Shared with" card on the skill detail page (SKILLY_SPEC.md §42.5). Restricted skills only.
// Lists the namespaces the skill is shared with as chips. Those who may share (platform admin,
// owning-namespace admin, an explicit maintainer) get the namespace picker — adding a namespace
// shares immediately, removing a chip revokes. A RECEIVING namespace's admin who is not a sharer
// sees plain chips with a remove (×) on their own namespace's chip only. Archived ⇒ read-only.
import { useState } from "react";
import { useApi } from "../../../../components/ui";
import { NamespaceMultiPicker, useShareTargets } from "../../../../components/NamespaceMultiPicker";

interface GrantView { namespaceId: string; slug: string; displayName: string; grantedAt: string; grantedBy: string | null }
interface GrantsResponse { grants: GrantView[]; canManage: boolean; canRevoke: string[] }

export function SharedWithPanel({ ns, slug, ownerNamespaceSlug, onChanged }: { ns: string; slug: string; ownerNamespaceSlug: string; onChanged?: () => void }) {
  const { data, reload } = useApi<GrantsResponse>(ns && slug ? `/api/skills/${ns}/${slug}/grants` : null);
  const targets = useShareTargets();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!data) return null;
  const ownerId = targets.find((t) => t.slug === ownerNamespaceSlug)?.id ?? null;
  const current = data.grants.map((g) => g.namespaceId);
  const nameOf = (id: string) => data.grants.find((g) => g.namespaceId === id)?.displayName ?? targets.find((t) => t.id === id)?.displayName ?? "this namespace";

  const call = async (method: "PUT" | "DELETE", namespaceId: string) => {
    if (method === "DELETE" && !window.confirm(`Stop sharing with ${nameOf(namespaceId)}? Its members lose access — their next install or update of this skill will fail.`)) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/skills/${ns}/${slug}/grants/${namespaceId}`, { method });
      if (!r.ok) setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't update sharing.");
      reload();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  // Picker change ⇒ exactly one add or one remove (a click or a × at a time).
  const onPick = (next: string[]) => {
    const added = next.find((id) => !current.includes(id));
    const removed = current.find((id) => !next.includes(id));
    if (added) void call("PUT", added);
    else if (removed) void call("DELETE", removed);
  };

  // Nothing to show to a viewer when there are no grants and they can't add any.
  if (data.grants.length === 0 && !data.canManage) return null;

  return (
    <div className="card card-pad" style={{ marginTop: 20 }} data-testid="shared-with-card">
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, marginBottom: 4 }}>Shared with</h2>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 14 }}>
        Members of these namespaces can find, install and discuss this restricted skill. Review and management stay with <span className="mono">{ownerNamespaceSlug}</span>.
      </p>
      {data.canManage ? (
        <div aria-busy={busy || undefined} style={busy ? { opacity: 0.6, pointerEvents: "none" } : undefined}>
          <NamespaceMultiPicker value={current} onChange={onPick} options={targets} exclude={ownerId ? [ownerId] : []} placeholder="Share with a namespace…" />
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {data.grants.map((g) => (
            <span key={g.namespaceId} className="chip taginput-chip" title={`@${g.slug}${g.grantedBy ? ` · shared by ${g.grantedBy}` : ""}`}>
              {g.displayName}
              {data.canRevoke.includes(g.namespaceId) && (
                <button type="button" disabled={busy} aria-label={`stop sharing with ${g.displayName}`} onClick={() => void call("DELETE", g.namespaceId)}>×</button>
              )}
            </span>
          ))}
        </div>
      )}
      {err && <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 10 }}>{err}</p>}
    </div>
  );
}
