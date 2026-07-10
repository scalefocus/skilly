"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useApi, useEnterKey, SkeletonGrid, EmptyState, ScrollToTop, formatCount } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { SkillCard, SkillListRow, type CatalogEntry } from "../../components/SkillCard";
import { agentLabel } from "@skilly/shared/agents";

interface Facets {
  categories: { name: string; count: number }[];
  tools: { name: string; count: number }[];
  types: { name: "hosted" | "pointer"; count: number }[];
}

const TYPE_LABEL: Record<string, string> = { hosted: "Hosted", pointer: "External" };

function Catalog() {
  const params = useSearchParams();
  // Press Enter to jump to the header search box (the catalog has no page-local input).
  useEnterKey(() => window.dispatchEvent(new Event("skilly:focus-search")));
  // Search comes from the topbar box (it navigates to /catalog?q=…) — no page-local input.
  const submitted = params.get("q") ?? "";
  // "Maintained by" view (from the leaderboard's Skills action, §21): a focused list of one person's
  // maintained skills (viewer-visibility-scoped). When set, it overrides the other filters and shows
  // a dismissible banner; `by` carries the display name for the banner (no extra lookup).
  const maintainer = params.get("maintainer");
  const maintainerName = params.get("by") ?? "";
  const [category, setCategory] = useState<string | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const [type, setType] = useState<"hosted" | "pointer" | null>(null);
  const [sort, setSort] = useState<"relevance" | "top_rated" | "latest">("relevance");
  const [showArchived, setShowArchived] = useState(false);
  // "My Skills": only skills the current user explicitly maintains (server resolves via skill_maintainers).
  const [mine, setMine] = useState(false);
  // "Official only": platform-endorsed skills (§7).
  const [official, setOfficial] = useState(false);
  // Cards vs list presentation.
  const [view, setView] = useState<"cards" | "list">("cards");
  const pickView = (v: "cards" | "list") => setView(v);

  // The view + filters + sort are remembered across visits (localStorage). Loaded once on mount,
  // then re-saved whenever any of them change. `prefsLoaded` gates the save so the initial
  // defaults don't clobber the stored prefs before they're restored. (Search `q` stays URL-driven.)
  const PREFS_KEY = "skilly.catalogPrefs";
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<{ category: string | null; tool: string | null; type: "hosted" | "pointer" | null; sort: "relevance" | "top_rated" | "latest"; showArchived: boolean; mine: boolean; official: boolean; view: "cards" | "list" }>;
        if ("category" in p) setCategory(p.category ?? null);
        if ("tool" in p) setTool(p.tool ?? null);
        if ("type" in p) setType(p.type ?? null);
        if (p.sort === "relevance" || p.sort === "top_rated" || p.sort === "latest") setSort(p.sort);
        if (typeof p.showArchived === "boolean") setShowArchived(p.showArchived);
        if (typeof p.mine === "boolean") setMine(p.mine);
        if (typeof p.official === "boolean") setOfficial(p.official);
        if (p.view === "cards" || p.view === "list") setView(p.view);
      } else if (localStorage.getItem("skilly.catalogView") === "list") {
        setView("list"); // migrate the older single-key view preference
      }
    } catch { /* private mode / bad JSON — fall back to defaults */ }
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ category, tool, type, sort, showArchived, mine, official, view }));
    } catch { /* private mode etc. */ }
  }, [prefsLoaded, category, tool, type, sort, showArchived, mine, official, view]);
  // Managers (platform/namespace admins or maintainers) may surface archived skills to restore them.
  const { data: me } = useApi<{ isPlatformAdmin: boolean; namespaceRoles: { role: string }[]; maintainsSkills: boolean }>("/api/me");
  const canManage = !!me && (me.isPlatformAdmin || (me.namespaceRoles ?? []).some((r) => r.role === "namespace_admin") || me.maintainsSkills);

  const qs = new URLSearchParams();
  if (maintainer) {
    // Focused maintained-by view — ignore the viewer's other saved filters on arrival. §21
    qs.set("maintainer", maintainer);
  } else {
    if (submitted) qs.set("q", submitted);
    if (category) qs.set("category", category);
    if (tool) qs.set("tool", tool);
    if (type) qs.set("type", type);
    if (showArchived && canManage) qs.set("archived", "1");
    if (mine) qs.set("mine", "1");
    if (official) qs.set("official", "1");
  }
  if (sort === "top_rated") qs.set("sort", "top_rated");
  else if (sort === "latest") qs.set("sort", "latest");

  const { data, loading, error } = useApi<{ skills: CatalogEntry[] }>(`/api/skills${qs.toString() ? `?${qs}` : ""}`);
  const { data: facets } = useApi<Facets>("/api/skills/facets");
  const skills = data?.skills ?? [];

  const Chip = ({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) => (
    <button className={`facet${active ? " facet-on" : ""}`} onClick={onClick} type="button">
      {label} <span className="facet-n">{formatCount(count)}</span>
    </button>
  );

  const hasFacets = (facets?.categories.length ?? 0) > 0 || (facets?.tools.length ?? 0) > 0 || (facets?.types.length ?? 0) > 1;

  return (
    <div>
      <ScrollToTop />
      <div className="page-head reveal">
        <div className="eyebrow">Catalog</div>
        <h1 className="page-title">Discover skills.</h1>
        {submitted && (
          <p className="page-sub" style={{ marginTop: 10 }}>
            Results for <span className="mono">“{submitted}”</span> — search again from the box above.
          </p>
        )}
      </div>

      {/* Maintained-by banner (from the leaderboard Skills action): names whose skills these are
          and offers a one-click return to the full catalog. The facet filters are hidden in this
          focused view. §21 */}
      {maintainer && (
        <div className="reveal" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 20, padding: "10px 14px", borderRadius: "var(--radius-sm)", background: "var(--accent-soft)", fontSize: 13.5 }}>
          <span>Skills maintained by <strong>{maintainerName || "this person"}</strong> — that you can see.</span>
          <span style={{ flex: 1 }} />
          <Link href="/catalog" className="btn-ghost mono" style={{ fontSize: 12 }}>✕ clear</Link>
        </div>
      )}

      {!maintainer && hasFacets && (
        <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 22 }}>
          {facets!.categories.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span className="nav-label" style={{ padding: 0, minWidth: 74 }}>Category</span>
              {facets!.categories.map((c) => (
                <Chip key={c.name} active={category === c.name} label={c.name} count={c.count} onClick={() => setCategory(category === c.name ? null : c.name)} />
              ))}
            </div>
          )}
          {facets!.tools.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span className="nav-label" style={{ padding: 0, minWidth: 74 }}>Harness</span>
              {facets!.tools.map((t) => (
                <Chip key={t.name} active={tool === t.name} label={agentLabel(t.name)} count={t.count} onClick={() => setTool(tool === t.name ? null : t.name)} />
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="nav-label" style={{ padding: 0, minWidth: 74 }}>Source</span>
            {(facets?.types.length ?? 0) > 1 && facets!.types.map((t) => (
              <Chip key={t.name} active={type === t.name} label={TYPE_LABEL[t.name] ?? t.name} count={t.count} onClick={() => setType(type === t.name ? null : t.name)} />
            ))}
            {/* Only skills the current user explicitly maintains (§19). */}
            <button type="button" className={`facet${mine ? " facet-on" : ""}`} aria-pressed={mine} title="Only skills you maintain" onClick={() => setMine((m) => !m)}>
              My Skills
            </button>
            {/* Only platform-endorsed (Official) skills (§7). */}
            <button type="button" className={`facet${official ? " facet-on" : ""}`} aria-pressed={official} title="Only skills marked Official by a platform admin" onClick={() => setOfficial((o) => !o)}>
              ✓ Official
            </button>
          </div>
          {(category || tool || type || mine || official) && (
            <button className="btn-ghost mono" style={{ fontSize: 12, alignSelf: "flex-start" }} onClick={() => { setCategory(null); setTool(null); setType(null); setMine(false); setOfficial(false); }}>
              ✕ clear filters
            </button>
          )}
        </div>
      )}

      {error ? (
        <EmptyState icon="⚠" title="Couldn’t load the catalog" hint={error} />
      ) : loading ? (
        <SkeletonGrid />
      ) : (
        <>
          {/* Toolbar stays visible whenever there are results OR the viewer can manage — so an
              admin can still reach the Archived toggle even when every visible skill is archived
              (the default, non-archived list is then empty). */}
          {(skills.length > 0 || canManage) && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              <div className="muted mono" style={{ fontSize: 12 }}>{formatCount(skills.length)} result{skills.length === 1 ? "" : "s"}</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                {canManage && !maintainer && (
                  <button
                    type="button"
                    className={`facet${showArchived ? " facet-on" : ""}`}
                    style={{ cursor: "pointer" }}
                    aria-pressed={showArchived}
                    title="Show only your archived skills"
                    onClick={() => setShowArchived((v) => !v)}
                  >
                    Archived
                  </button>
                )}
                <div className="sort-toggle" role="group" aria-label="Sort order">
                  <button type="button" className={`sort-opt${sort === "relevance" ? " sort-on" : ""}`} onClick={() => setSort("relevance")}>
                    {submitted ? "◎ Relevance" : "↗ Popular"}
                  </button>
                  <button type="button" className={`sort-opt${sort === "top_rated" ? " sort-on" : ""}`} onClick={() => setSort("top_rated")}>
                    ★ Top rated
                  </button>
                  <button type="button" className={`sort-opt${sort === "latest" ? " sort-on" : ""}`} onClick={() => setSort("latest")}>
                    ↻ Latest
                  </button>
                </div>
                <div className="sort-toggle" role="group" aria-label="View mode">
                  <button type="button" className={`sort-opt${view === "cards" ? " sort-on" : ""}`} onClick={() => pickView("cards")} title="Card grid">
                    ⊞ Cards
                  </button>
                  <button type="button" className={`sort-opt${view === "list" ? " sort-on" : ""}`} onClick={() => pickView("list")} title="Compact list">
                    ☰ List
                  </button>
                </div>
              </div>
            </div>
          )}
          {skills.length === 0 ? (
            maintainer ? (
              <EmptyState title="No skills to show" hint={`${maintainerName || "This person"} maintains no skills you have access to.`} />
            ) : (
            <EmptyState title={showArchived ? "No archived skills" : submitted || category || tool || type ? "No skills match your filters" : "No skills published yet"} hint={showArchived ? "You have no archived skills to restore." : canManage ? "Try a different search, clear filters, or toggle Archived above." : "Try a different search or clear filters."} />
            )
          ) : view === "cards" ? (
            <div className="card-grid">
              {skills.map((s, i) => (
                <SkillCard key={`${s.namespaceSlug}/${s.skillSlug}`} s={s} index={i} />
              ))}
            </div>
          ) : (
            <div className="rows reveal">
              {skills.map((s) => (
                <SkillListRow key={`${s.namespaceSlug}/${s.skillSlug}`} s={s} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function CatalogPage() {
  return (
    <RequireAuth>
      <Suspense fallback={<SkeletonGrid />}>
        <Catalog />
      </Suspense>
    </RequireAuth>
  );
}
