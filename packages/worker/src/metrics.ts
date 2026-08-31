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
  // §29 MCP server.
  mcpToolCalls: metrics.counter("skilly_mcp_tool_calls_total", "MCP tool calls, by tool and outcome"),
  mcpResourceReads: metrics.counter("skilly_mcp_resource_reads_total", "Skill content reads served over MCP"),
  mcpAdoptions: metrics.counter("skilly_mcp_adoptions_total", "First-read adoptions recorded from MCP"),
  mcpTokensIssued: metrics.counter("skilly_mcp_tokens_issued_total", "OAuth access+refresh pairs issued"),
  mcpRefreshReuse: metrics.counter("skilly_mcp_refresh_reuse_total", "Rotated refresh tokens replayed (grant revoked)"),
  mcpRateLimited: metrics.counter("skilly_mcp_rate_limited_total", "MCP calls refused by the rate limiter"),
  mcpAuthFailures: metrics.counter("skilly_mcp_auth_failures_total", "MCP requests refused at authentication"),
  mcpInstallsMinted: metrics.counter("skilly_mcp_installs_minted_total", "Install commands minted through MCP"),
  mcpWrites: metrics.counter("skilly_mcp_writes_total", "Content created through MCP, by kind"),
};
