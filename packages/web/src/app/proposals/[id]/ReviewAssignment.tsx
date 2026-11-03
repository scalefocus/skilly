"use client";
// The proposal page's *Reviewer* and *Review target* lines (SKILLY_SPEC.md §65.6). Reviewers of
// the namespace can assign, reassign, unassign and assign themselves; the proposer reads both
// lines. A decided proposal keeps its reviewer as read-only history.
import { useState } from "react";
import { UserBubble } from "../../../components/UserBubble";
import { AssigneePicker } from "../../../components/AssigneePicker";
import { DuePill } from "../../../components/DuePill";
import { useDateFmt } from "../../../components/DateFormat";

export interface AssignmentView {
  assignee: { id: string; name: string; avatar: string | null } | null;
  assignedAt: string | null;
  canAssign: boolean;
  canSelfAssign: boolean;
  viewerId: string;
}
export interface ReviewTargetView {
  days: number;
  dueAt: string;
  overdue: boolean;
}

export function ReviewAssignment({
  proposalId,
  assignment,
  reviewTarget,
  onChanged,
}: {
  proposalId: string;
  assignment: AssignmentView;
  reviewTarget: ReviewTargetView | null;
  onChanged: () => void;
}) {
  const fmt = useDateFmt();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const a = assignment.assignee;

  const assign = async (assigneeId: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/proposals/${proposalId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeId }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      setPicking(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div data-testid="proposal-reviewer" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13, marginTop: 10 }}>
        <span className="muted">Reviewer:</span>
        {a ? (
          <>
            <UserBubble name={a.name} avatar={a.avatar} size={22} userId={a.id} />
            <strong data-testid="proposal-reviewer-name">{a.name}</strong>
          </>
        ) : (
          <span className="muted" data-testid="proposal-reviewer-name">Unassigned</span>
        )}
        {assignment.canAssign && (
          <button type="button" className="btn-ghost mono" style={{ fontSize: 12 }} disabled={busy} onClick={() => { setErr(null); setPicking(true); }} data-testid="assign-open">
            {a ? "change" : "assign…"}
          </button>
        )}
        {assignment.canSelfAssign && (
          <button type="button" className="btn-ghost mono" style={{ fontSize: 12 }} disabled={busy} onClick={() => void assign(assignment.viewerId)} data-testid="assign-me">
            assign to me
          </button>
        )}
        {assignment.canAssign && a && (
          <button type="button" className="btn-ghost mono" style={{ fontSize: 12 }} disabled={busy} onClick={() => void assign(null)} data-testid="assign-clear">
            unassign
          </button>
        )}
        {err && !picking && <span role="alert" style={{ color: "var(--danger)" }}>{err}</span>}
      </div>
      {reviewTarget && (
        <div data-testid="proposal-review-target" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13, marginTop: 6 }}>
          <span className="muted">
            Review target: {reviewTarget.days} business day{reviewTarget.days === 1 ? "" : "s"} · due <span className="mono">{fmt.dateTime(reviewTarget.dueAt)}</span>
          </span>
          <DuePill dueAt={reviewTarget.dueAt} />
        </div>
      )}
      {picking && (
        <AssigneePicker
          proposalId={proposalId}
          currentId={a?.id ?? null}
          busy={busy}
          error={err}
          onPick={(r) => void assign(r.id)}
          onCancel={() => setPicking(false)}
        />
      )}
    </>
  );
}
