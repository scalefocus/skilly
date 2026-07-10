// Web process metrics. Domain counters surfaced at GET /metrics (Prometheus). The registry
// is a module singleton, so all route handlers in this Next.js server share it. §14.
import { metrics } from "@skilly/shared";

export { metrics } from "@skilly/shared";

export const M = {
  proposalsCreated: metrics.counter("skilly_proposals_created_total", "Proposals created"),
  proposalActions: metrics.counter("skilly_proposal_actions_total", "Proposal lifecycle actions performed"),
  tokensMinted: metrics.counter("skilly_tokens_minted_total", "Tokens minted (install)"),
  installCommands: metrics.counter("skilly_install_commands_total", "Install commands generated"),
  searches: metrics.counter("skilly_catalog_searches_total", "Catalog searches served"),
  rateLimited: metrics.counter("skilly_rate_limited_total", "Requests rejected by the rate limiter"),
  cspReports: metrics.counter("skilly_csp_reports_total", "CSP violation reports received (§22)"),
};
