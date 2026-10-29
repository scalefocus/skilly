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
  // §34.15 — counts only; no query text is ever recorded.
  searchRequests: metrics.counter("skilly_search_requests_total", "Registry searches, by surface and match mode (all|any|none)"),
  searchZeroResults: metrics.counter("skilly_search_zero_results_total", "Registry searches with a query that returned nothing, by surface"),
  // §62.12 search gaps — the outcome of each recording attempt; never the query text.
  searchGapHits: metrics.counter("skilly_search_gap_hits_total", "Search-gap hit recordings, by surface and outcome (recorded|secret|tombstoned|failed)"),
  rateLimited: metrics.counter("skilly_rate_limited_total", "Requests rejected by the rate limiter"),
  cspReports: metrics.counter("skilly_csp_reports_total", "CSP violation reports received (§22)"),
  // §37.13 content risk — findings recorded at hosted upload.
  contentRiskFindings: metrics.counter("skilly_content_risk_findings_total", "Content-risk findings recorded at scan time, by rule and severity"),
  // §43.7 — Draft with AI on the propose form, by outcome (ok|failed|rate_limited|source_rejected).
  aiDraftRequests: metrics.counter("skilly_ai_draft_requests_total", "Propose-form AI draft requests, by outcome"),
  aiTryRequests: metrics.counter("skilly_ai_try_requests_total", "Try-a-skill chat messages (§61), by outcome"),
  // §44.10 AI-drafted quality improvements — counts only, never content.
  aiQualityDraftRuns: metrics.counter("skilly_ai_quality_draft_runs_total", "AI quality-draft runs, by outcome (complete|capped|cancelled)"),
  aiQualityDraftFiles: metrics.counter("skilly_ai_quality_draft_files_total", "Files in AI quality-draft runs, by final status"),
  // §64.10 import a whole repository — submits, per-skill outcomes and scans.
  repoImports: metrics.counter("skilly_repo_import_total", "Repository-import submits, by outcome (ok|partial|failed)"),
  repoImportSkills: metrics.counter("skilly_repo_import_skills_total", "Skills in repository-import submits, by outcome (proposed|published|routed|failed)"),
  repoImportScans: metrics.counter("skilly_repo_import_scans_total", "Repository-import scans, by result (ok|error)"),
};
