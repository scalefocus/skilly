// Static route → human-readable label map for the presence page beacon (SKILLY_SPEC.md §4).
// Pure and framework-free so it's unit-testable without React. The three dynamic-title routes
// (/skills/[ns]/[slug], /requests/[id], /proposals/[id]) get a generic default here and are
// overridden client-side (see components/PageLabelOverride.tsx) once the page has fetched its
// own title — e.g. "Skill: <display name>".
const STATIC_ROUTES: { prefix: string; label: string; exact?: boolean }[] = [
  { prefix: "/", label: "Overview", exact: true },
  { prefix: "/catalog", label: "Catalog" },
  { prefix: "/propose", label: "Propose a skill" },
  { prefix: "/requests", label: "Requested skills" },
  { prefix: "/proposals", label: "Review queue" },
  { prefix: "/leaderboard", label: "Leaderboard" },
  { prefix: "/installed", label: "Installed skills" },
  { prefix: "/notifications", label: "Notifications" },
  { prefix: "/profile", label: "Profile" },
  { prefix: "/usage", label: "Usage" },
  { prefix: "/audit", label: "Audit log" },
  { prefix: "/system-log", label: "System log" },
  { prefix: "/admin", label: "Administration" },
  { prefix: "/quick-start", label: "Quick start" },
  { prefix: "/whats-new", label: "What's new" },
  { prefix: "/skills", label: "Skill" },
];

/** Resolve a pathname to its default human-readable label, or null if unrecognized (e.g. `/tokens`). */
export function resolveStaticPageLabel(pathname: string): string | null {
  const exact = STATIC_ROUTES.find((r) => r.exact && pathname === r.prefix);
  if (exact) return exact.label;
  // Longest-prefix match, so e.g. a future `/system-logs` addition can't shadow `/system-log`.
  let best: { prefix: string; label: string } | null = null;
  for (const r of STATIC_ROUTES) {
    if (r.exact || !pathname.startsWith(r.prefix)) continue;
    if (!best || r.prefix.length > best.prefix.length) best = r;
  }
  return best?.label ?? null;
}
