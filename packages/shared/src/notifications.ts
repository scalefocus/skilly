// Per-type notification presentation — the SINGLE SOURCE OF TRUTH shared by the worker email
// renderer (§12: subject = `Skilly - <title>`) and the web in-app center (the pill label + tone),
// so the inbox pill and the email subject can never drift apart. Client-safe (no node deps);
// exported via the `@skilly/shared` barrel. SKILLY_SPEC.md §12 (Notification content).

export type NotificationTone = "ok" | "warn" | "danger" | "muted";

export interface NotificationLabel {
  /** In-app pill text AND the email subject title (email subject = `Skilly - <title>`). */
  title: string;
  tone: NotificationTone;
}

/**
 * The per-type label. `message.new` keys the proposal/request-thread variant ("New message");
 * the direct-message subject ("Direct message") is derived in the email renderer from the payload
 * (a DM has no proposalId/requestId), because one notification type carries two contexts.
 */
export const NOTIFICATION_LABELS: Record<string, NotificationLabel> = {
  "proposal.submitted": { title: "Proposal submitted", tone: "ok" },
  "proposal.needs_review": { title: "New proposal to review", tone: "warn" },
  "proposal.accept": { title: "Proposal accepted", tone: "ok" },
  "proposal.reject": { title: "Proposal rejected", tone: "danger" },
  "proposal.request_changes": { title: "Changes requested", tone: "warn" },
  "proposal.start_review": { title: "Proposal under review", tone: "muted" },
  "proposal.resubmit": { title: "Proposal resubmitted", tone: "muted" },
  "proposal.revise": { title: "Proposal updated", tone: "warn" },
  "skill.new_version": { title: "New version published", tone: "ok" },
  "skill.marked_official": { title: "Skill marked official", tone: "ok" },
  "skill.drift": { title: "Upstream drift detected", tone: "danger" },
  "message.new": { title: "New message", tone: "warn" },
  "system.error": { title: "System log events", tone: "danger" },
  "request.fulfilled": { title: "Skill request fulfilled", tone: "ok" },
};

/** The subject-line title for a type; a generic fallback so no unknown type ever leaks its key. */
export function notificationTitle(type: string): string {
  return NOTIFICATION_LABELS[type]?.title ?? "Notification";
}
