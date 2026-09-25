// The known-route table for real user monitoring (SKILLY_SPEC.md §32.3). Pure and framework-free
// so the browser collector and the ingest validator share ONE source of truth: every page route
// with its human label, plus every API route template the browser may call. A pathname that
// matches nothing collapses into the single `other` bucket — concrete paths, ids, slugs and query
// strings are never sent and never stored (invariant #6).
//
// Dynamic pages report their TEMPLATE only (`/skills/[ns]/[slug]`), never the skill title the
// presence beacon shows (§4), so a restricted skill's existence is not inferable from RUM by any
// future non-admin surface (invariant #3).

/** The pseudo-route for platform-wide aggregates — never stored in rum_samples, only in rum_daily. */
export const RUM_ROUTE_ALL = "all";
/** The catch-all bucket for anything the table doesn't know. */
export const RUM_ROUTE_OTHER = "other";

export interface RumPageRoute {
  template: string;
  label: string;
}

/** Every page in the app (packages/web/src/app/**\/page.tsx) with the label the RUM table shows. */
export const RUM_PAGE_ROUTES: readonly RumPageRoute[] = [
  { template: "/", label: "Overview" },
  { template: "/catalog", label: "Catalog" },
  { template: "/catalog/marketplaces", label: "Marketplaces" },
  { template: "/marketplaces", label: "My marketplaces" },
  { template: "/mcp", label: "MCP" },
  { template: "/oauth/authorize", label: "MCP consent" },
  { template: "/propose", label: "Propose a skill" },
  { template: "/proposals", label: "Review queue" },
  { template: "/proposals/[id]", label: "Proposal" },
  { template: "/requests", label: "Requested skills" },
  { template: "/requests/[id]", label: "Request" },
  { template: "/skills/[ns]/[slug]", label: "Skill" },
  { template: "/leaderboard", label: "Leaderboard" },
  { template: "/installed", label: "Installed skills" },
  { template: "/notifications", label: "Notifications" },
  { template: "/profile", label: "Profile" },
  { template: "/achievements/[userId]", label: "Achievements" },
  { template: "/usage", label: "Usage" },
  { template: "/audit", label: "Audit log" },
  { template: "/system-log", label: "System log" },
  { template: "/namespaces", label: "Namespace administration" },
  { template: "/admin", label: "Administration" },
  { template: "/admin/rum", label: "Real user monitoring" },
  { template: "/quick-start", label: "Quick start" },
  { template: "/whats-new", label: "What's new" },
];

/**
 * Every API route template the browser may call (packages/web/src/app/api/**\/route.ts), minus the
 * ones RUM must never measure: its own beacon, the presence beacon, the CSP sink, and the
 * next-auth catch-all (only the session poll is worth a row).
 */
export const RUM_API_ROUTES: readonly string[] = [
  "/api/admin/email",
  "/api/admin/email/callback",
  "/api/admin/email/connect",
  "/api/admin/email/test",
  "/api/admin/email/wrapper",
  "/api/admin/jobs/related-rebuild",
  "/api/admin/mcp",
  "/api/admin/mcp/clients/[id]",
  "/api/admin/namespaces",
  "/api/admin/namespaces/[id]",
  "/api/admin/role-mappings",
  "/api/admin/role-mappings/[id]",
  "/api/admin/rum/errors",
  "/api/admin/rum/routes/[route]/users",
  "/api/admin/rum/summary",
  "/api/admin/settings",
  "/api/admin/survey/comments",
  "/api/admin/survey/responses/[id]",
  "/api/admin/survey/summary",
  "/api/admin/system-banner",
  "/api/admin/users/[id]/erase",
  "/api/admin/users/active-series",
  "/api/admin/users/online",
  "/api/admin/users/search",
  "/api/audit",
  "/api/audit/export",
  "/api/audit/trim",
  "/api/audit/verify",
  "/api/auth/session",
  "/api/auth/clear-cookies",
  "/api/categories",
  "/api/harnesses",
  "/api/installs",
  "/api/installs/[id]",
  "/api/leaderboard",
  "/api/leaders",
  "/api/levels",
  "/api/marketplaces",
  "/api/marketplaces/directory",
  "/api/marketplaces/tokens",
  "/api/marketplaces/tokens/[id]",
  "/api/mcp/connections",
  "/api/mcp/connections/[grantId]",
  "/api/me",
  "/api/me/features/used",
  "/api/me/onboarded",
  "/api/me/survey/check",
  "/api/me/survey/close",
  "/api/me/survey/start",
  "/api/me/whats-new-seen",
  "/api/messages",
  "/api/messages/[id]",
  "/api/messages/[id]/read",
  "/api/messages/direct",
  "/api/namespaces",
  "/api/namespaces/[id]/settings",
  "/api/namespaces/administered",
  "/api/nav-badges",
  "/api/notifications",
  "/api/notifications/read",
  "/api/pointer/refs",
  "/api/proposals",
  "/api/proposals/[id]",
  "/api/proposals/[id]/actions",
  "/api/proposals/[id]/artifact",
  "/api/proposals/[id]/changes",
  "/api/proposals/[id]/files",
  "/api/proposals/[id]/messages",
  "/api/proposals/duplicate-check",
  "/api/publish",
  "/api/requests",
  "/api/requests/[id]",
  "/api/requests/[id]/fulfil",
  "/api/requests/[id]/messages",
  "/api/skills",
  "/api/skills/[ns]/[slug]",
  "/api/skills/[ns]/[slug]/archive",
  "/api/skills/[ns]/[slug]/delete",
  "/api/skills/[ns]/[slug]/discussion",
  "/api/skills/[ns]/[slug]/discussion/[messageId]",
  "/api/skills/[ns]/[slug]/discussion/read",
  "/api/skills/[ns]/[slug]/download",
  "/api/skills/[ns]/[slug]/feature",
  "/api/skills/[ns]/[slug]/install",
  "/api/skills/[ns]/[slug]/maintainers",
  "/api/skills/[ns]/[slug]/maintainers/candidates",
  "/api/skills/[ns]/[slug]/official",
  "/api/skills/[ns]/[slug]/promote",
  "/api/skills/[ns]/[slug]/rating",
  "/api/skills/[ns]/[slug]/readme",
  "/api/skills/[ns]/[slug]/related",
  "/api/skills/[ns]/[slug]/retry-mirror",
  "/api/skills/[ns]/[slug]/usage-series",
  "/api/skills/[ns]/[slug]/versions/[semver]/changes",
  "/api/skills/[ns]/[slug]/watch",
  "/api/skills/[ns]/[slug]/yank",
  "/api/skills/facets",
  "/api/skills/featured",
  "/api/skills/suggest",
  "/api/stats",
  "/api/system-banner",
  "/api/system-log",
  "/api/system-log/export",
  "/api/uploads",
  "/api/uploads/chunked",
  "/api/uploads/chunked/[id]",
  "/api/uploads/chunked/[id]/complete",
  "/api/uploads/chunked/[id]/parts/[index]",
  "/api/usage",
  "/api/usage/[ns]/[slug]/breakdown",
  "/api/users/[id]/achievements",
  "/api/users/[id]/card",
  "/api/users/suggest",
];

/** API paths the collector must never measure — the monitor must not measure itself (§32.4) — and
 *  the feedback-survey submit, whose user-attributed, timestamped sample would de-anonymize the
 *  response (§36.11). */
export const RUM_API_EXCLUDED: readonly string[] = ["/api/rum", "/api/presence/page", "/api/csp-report", "/api/me/survey/responses"];

const PAGE_TEMPLATES = new Set(RUM_PAGE_ROUTES.map((r) => r.template));
const API_TEMPLATES = new Set(RUM_API_ROUTES);
const PAGE_LABELS = new Map(RUM_PAGE_ROUTES.map((r) => [r.template, r.label] as const));

function segments(path: string): string[] {
  // Drop query/hash, trailing slashes, and empty segments; a bare "/" is zero segments.
  const clean = path.split(/[?#]/)[0] ?? "";
  return clean.split("/").filter((s) => s.length > 0);
}

/** Does a concrete path fit a template? Same segment count; `[x]` segments match any non-empty segment. */
function matches(pathSegs: string[], template: string): boolean {
  const tSegs = segments(template);
  if (tSegs.length !== pathSegs.length) return false;
  for (let i = 0; i < tSegs.length; i++) {
    const t = tSegs[i]!;
    if (t.startsWith("[") && t.endsWith("]")) continue;
    if (t !== pathSegs[i]) return false;
  }
  return true;
}

function templateFor(path: string, templates: readonly string[]): string {
  const segs = segments(path);
  for (const t of templates) if (matches(segs, t)) return t;
  return RUM_ROUTE_OTHER;
}

/** Resolve a page pathname to its route template, or `other` when unknown (e.g. `/tokens`). */
export function templateForPath(pathname: string): string {
  return templateFor(pathname, RUM_PAGE_ROUTES.map((r) => r.template));
}

/**
 * Resolve an API request URL to its route template. Returns `null` when the URL is not a
 * same-origin `/api/` call or is one RUM must not measure; `other` for an unknown API path.
 */
export function templateForApiUrl(url: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(url, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  if (!u.pathname.startsWith("/api/")) return null;
  const clean = u.pathname.replace(/\/+$/, "");
  if (RUM_API_EXCLUDED.some((x) => clean === x || clean.startsWith(`${x}/`))) return null;
  return templateFor(u.pathname, RUM_API_ROUTES);
}

/** Is `route` a value the ingest endpoint accepts in a sample? (A page template, or `other`.) */
export function isKnownPageRoute(route: string): boolean {
  return route === RUM_ROUTE_OTHER || PAGE_TEMPLATES.has(route);
}

/** Is `name` a value the ingest endpoint accepts as an `api` sample's route template? */
export function isKnownApiRoute(name: string): boolean {
  return name === RUM_ROUTE_OTHER || API_TEMPLATES.has(name);
}

/** The human label the RUM table shows for a stored route value. */
export function labelForRoute(route: string): string {
  if (route === RUM_ROUTE_ALL) return "All routes";
  if (route === RUM_ROUTE_OTHER) return "Other";
  return PAGE_LABELS.get(route) ?? route;
}
