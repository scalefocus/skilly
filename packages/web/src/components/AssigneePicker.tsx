"use client";
// The §65.2 assignee picker: the eligible reviewers of one proposal's namespace — its namespace
// admins first, then platform admins — searchable by name. Never lists the proposer (the server
// leaves them out). Used by the proposal page and by the queue's *Assign all open* (§65.5).
import { useMemo, useRef, useState } from "react";
import { Modal, useApi } from "./ui";

export interface AssignableReviewer {
  id: string;
  name: string;
  avatar: string | null;
  namespaceAdmin: boolean;
}

export function AssigneePicker({
  proposalId,
  currentId,
  title = "Assign a reviewer",
  busy = false,
  error,
  onPick,
  onCancel,
}: {
  /** Any proposal of the namespace — its `assignable` list is the namespace's. */
  proposalId: string;
  currentId?: string | null;
  title?: string;
  busy?: boolean;
  error?: string | null;
  onPick: (r: AssignableReviewer) => void;
  onCancel: () => void;
}) {
  const { data, loading, error: loadError } = useApi<{ reviewers: AssignableReviewer[] }>(`/api/proposals/${proposalId}/assignable`);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.reviewers ?? []).filter((r) => !needle || r.name.toLowerCase().includes(needle));
  }, [data, q]);

  return (
    <Modal title={title} onCancel={onCancel} initialFocusRef={inputRef} dismissOnBackdrop testId="assignee-picker">
      <input
        ref={inputRef}
        className="input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search reviewers"
        aria-label="Search reviewers"
        style={{ width: "100%" }}
      />
      {(error || loadError) && (
        <div role="alert" style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{error ?? loadError}</div>
      )}
      <div className="rows" style={{ marginTop: 10, maxHeight: 360, overflowY: "auto" }}>
        {loading ? (
          <div className="muted" style={{ fontSize: 13, padding: 8 }}>Loading…</div>
        ) : list.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, padding: 8 }}>{q.trim() ? "No reviewer matches." : "No one else can review this namespace."}</div>
        ) : (
          list.map((r) => (
            <button
              type="button"
              key={r.id}
              className="row"
              style={{ width: "100%", textAlign: "left", cursor: busy || r.id === currentId ? "default" : "pointer" }}
              disabled={busy || r.id === currentId}
              onClick={() => onPick(r)}
              data-testid="assignee-option"
            >
              <span className="grow" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
              <span className="muted mono" style={{ fontSize: 11, flexShrink: 0 }}>
                {r.id === currentId ? "assigned" : r.namespaceAdmin ? "namespace admin" : "platform admin"}
              </span>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
