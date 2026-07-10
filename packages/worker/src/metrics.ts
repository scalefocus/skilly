// Worker process metrics, surfaced at GET /metrics (Prometheus). SKILLY_SPEC.md §14.
import { metrics } from "@skilly/shared";

export { metrics } from "@skilly/shared";

export const M = {
  leader: metrics.gauge("skilly_worker_leader", "1 if this worker holds the leader lock"),
  versionsPublished: metrics.counter("skilly_versions_published_total", "Skill versions synthesized into git"),
  pointersMirrored: metrics.counter("skilly_pointers_mirrored_total", "Pointer versions mirrored from upstream"),
  notificationsDelivered: metrics.counter("skilly_notifications_delivered_total", "Notifications delivered"),
  notificationsFailed: metrics.counter("skilly_notifications_failed_total", "Notification delivery failures"),
  gitClones: metrics.counter("skilly_git_clones_total", "Authenticated git fetches served"),
  reconcile: metrics.counter("skilly_reconcile_runs_total", "Entra reconciliation sweeps"),
  pointerRefreshChecked: metrics.counter("skilly_pointer_refresh_checked_total", "Pointer refs re-verified"),
  pointerDrift: metrics.counter("skilly_pointer_drift_total", "Pointer refs whose upstream content drifted"),
};
