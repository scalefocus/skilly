"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { reportFeatureUse } from "../../lib/surveyClient";
import Link from "next/link";
import { useApi, useEnterKey, SkeletonGrid, EmptyState, ScrollToTop, formatCount } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { SkillCard, SkillListRow, type CatalogEntry } from "../../components/SkillCard";
import { CollapsibleFacetRow, FacetRow } from "../../components/CollapsibleFacetRow";
import { initialFacetRowOpen, storedFacetRowOpen } from "../../lib/facetRow";
import { agentLabel } from "@skilly/shared/agents";
import { collectionPath } from "@skilly/shared/collections";
import { UserBubble } from "../../components/UserBubble";
import { useAiName } from "../../components/AiName";

/** §38.5 the collection banner's data (GET /api/collections/:id). */
interface CollectionInfo {
  collection: { id: string; name: string; description: string | null; skillCount: number; owner: { id: string; name: string; avatar: string | null } };
  isOwner: boolean;
  canDelete: boolean;
}

interface Facets {
  categories: { name: string; count: number }[];
  tools: { name: string; count: number }[];
  types: { name: "hosted" | "pointer"; count: number }[];
}

const TYPE_LABEL: Record<string, string> = { hosted: "Hosted", pointer: "External" };

// The §34.4 query syntax, shown only when a search needs help: the partial-matches notice and the
// no-results empty state (§34.12). The top bar stays as it is.
const SEARCH_TIP = "Tip: use \"quotes\" for an exact phrase, -word to exclude, and OR between alternatives.";

function Catalog() {
  const params = useSearchParams();
  const aiName = useAiName();
  // Press Enter to jump to the header search box (the catalog has no page-local input).
  useEnterKey(() => window.dispatchEvent(new Event("skilly:focus-search")));
  // Search comes from the topbar box (it navigates to /catalog?q=…) — no page-local input.
  const submitted = params.get("q") ?? "";
  // §36.3 a non-empty search is the `search` feature's first use.
  useEffect(() => { if (submitted.trim()) reportFeatureUse("search"); }, [submitted]);
  // "Maintained by" view (from the leaderboard's Skills action, §21): a focused list of one person's
  // maintained skills (viewer-visibility-scoped). When set, it overrides the other filters and shows
  // a dismissible banner; `by` carries the display name for the banner (no extra lookup).
  const maintainer = params.get("maintainer");
  const maintainerName = params.get("by") ?? "";
  // Namespace view (from the Marketplaces page's Skills action, §30.6): one namespace's skills the
  // viewer can see. On arrival it ignores the viewer's saved filters, but — unlike the maintained-by
  // view — the facet rows stay usable, since a namespace can hold many skills. `nsName` carries the
  // display name for the banner (no extra lookup).
  const nsView = params.get("ns");
  const nsViewName = params.get("nsName") ?? "";
  // Collection views (§38.5): `?collection=<id>` — one collection, the shareable link — or
  // `?collectionsBy=<userId>&by=<name>` — every skill across one person's non-empty collections (the
  // leaderboard's Collections action). Like the namespace view, arrival ignores the viewer's saved
  // filters but the facets stay usable and compose with it; picks inside the view aren't persisted.
  const collectionParam = params.get("collection");
  const collectionsBy = collectionParam ? null : params.get("collectionsBy");
  const collectionsByName = params.get("by") ?? "";
  // "loading" until the banner data arrives; "missing" for an unknown/deleted id, which shows the
  // "no longer exists" banner over the normal, unfiltered catalog.
  const [collection, setCollection] = useState<CollectionInfo | "loading" | "missing" | null>(null);
  const [collectionTick, setCollectionTick] = useState(0);
  useEffect(() => {
    if (!collectionParam) { setCollection(null); return; }
    let live = true;
    setCollection("loading");
    fetch(`/api/collections/${encodeURIComponent(collectionParam)}`)
      .then(async (r) => (r.ok ? ((await r.json()) as CollectionInfo) : "missing" as const))
      .then((c) => { if (live) setCollection(c); })
      .catch(() => { if (live) setCollection("missing"); });
    return () => { live = false; };
  }, [collectionParam, collectionTick]);
  const collectionView = !!collectionParam || !!collectionsBy;
  const activeCollection = collection && typeof collection === "object" ? collection : null;
  const [category, setCategory] = useState<string | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const [type, setType] = useState<"hosted" | "pointer" | null>(null);
  const [sort, setSort] = useState<"relevance" | "top_rated" | "latest" | "quality">("relevance");
  // §41.7 minimum-quality facet (stars): 3 | 4 | 4.5, or null for no floor.
  const [minQuality, setMinQuality] = useState<3 | 4 | 4.5 | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // "My Skills": only skills the current user explicitly maintains (server resolves via skill_maintainers).
  const [mine, setMine] = useState(false);
  // "Official only": platform-endorsed skills (§7).
  const [official, setOfficial] = useState(false);
  // Cards vs list presentation.
  const [view, setView] = useState<"cards" | "list">("cards");
  // The Category chip row is collapsible and starts COLLAPSED (§10). Two pieces of state, not one:
  // `categoryOpen` is what the row actually does, `categoryOpenPref` is what gets persisted. They
  // diverge on arrival — a restored category filter force-opens the row so the viewer can see why
  // the catalog is filtered, but that auto-expand must NOT rewrite the stored preference.
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [categoryOpenPref, setCategoryOpenPref] = useState(false);
  const toggleCategory = () => { const next = !categoryOpen; setCategoryOpen(next); setCategoryOpenPref(next); };
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
        const p = JSON.parse(raw) as Partial<{ category: string | null; tool: string | null; type: "hosted" | "pointer" | null; sort: "relevance" | "top_rated" | "latest" | "quality"; minQuality: 3 | 4 | 4.5 | null; showArchived: boolean; mine: boolean; official: boolean; view: "cards" | "list"; categoryOpen: boolean }>;
        if ("category" in p) setCategory(p.category ?? null);
        if ("tool" in p) setTool(p.tool ?? null);
        if ("type" in p) setType(p.type ?? null);
        if (p.sort === "relevance" || p.sort === "top_rated" || p.sort === "latest" || p.sort === "quality") setSort(p.sort);
        if (p.minQuality === 3 || p.minQuality === 4 || p.minQuality === 4.5) setMinQuality(p.minQuality);
        if (typeof p.showArchived === "boolean") setShowArchived(p.showArchived);
        if (typeof p.mine === "boolean") setMine(p.mine);
        if (typeof p.official === "boolean") setOfficial(p.official);
        if (p.view === "cards" || p.view === "list") setView(p.view);
        setCategoryOpenPref(storedFacetRowOpen(p.categoryOpen));
        // Auto-expand (effective state only) when a category filter is restored alongside it.
        setCategoryOpen(initialFacetRowOpen(p.categoryOpen, p.category));
      } else if (localStorage.getItem("skilly.catalogView") === "list") {
        setView("list"); // migrate the older single-key view preference
      }
    } catch { /* private mode / bad JSON — fall back to defaults */ }
    setPrefsLoaded(true);
  }, []);
  // Namespace view arrival: start from an unfiltered view of that namespace (declared after the
  // prefs restore so it wins on mount). Filters picked inside the view are not persisted (below).
  useEffect(() => {
    if (!nsView && !collectionParam && !collectionsBy) return;
    setCategory(null); setTool(null); setType(null); setMine(false); setOfficial(false); setShowArchived(false);
  }, [nsView, collectionParam, collectionsBy]);
  // `?category=<name>` arrival (§10): select that chip exactly as a click would — it overrides the
  // remembered category for this visit and composes with `?ns=`. Marketplace plugin homepages
  // (§30.3) land here. Declared after the prefs restore and the namespace reset so it wins on mount.
  const arrivalCategory = params.get("category");
  useEffect(() => {
    if (!arrivalCategory) return;
    setCategory(arrivalCategory);
    setCategoryOpen(true);
  }, [arrivalCategory]);
  useEffect(() => {
    if (!prefsLoaded || nsView || collectionView) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ category, tool, type, sort, minQuality, showArchived, mine, official, view, categoryOpen: categoryOpenPref }));
    } catch { /* private mode etc. */ }
  }, [prefsLoaded, nsView, collectionView, category, tool, type, sort, minQuality, showArchived, mine, official, view, categoryOpenPref]);
  // Managers (platform/namespace admins or maintainers) may surface archived skills to restore them.
  const { data: me } = useApi<{ isPlatformAdmin: boolean; namespaceRoles: { role: string }[]; maintainsSkills: boolean }>("/api/me");
  const canManage = !!me && (me.isPlatformAdmin || (me.namespaceRoles ?? []).some((r) => r.role === "namespace_admin") || me.maintainsSkills);

  const qs = new URLSearchParams();
  if (maintainer) {
    // Focused maintained-by view — ignore the viewer's other saved filters on arrival. §21
    qs.set("maintainer", maintainer);
  } else {
    if (nsView) qs.set("ns", nsView); // namespace view (§10) — combines with the facets below
    // §38.5 collection views — only once the collection is known to exist (a missing one leaves the
    // catalog unfiltered under its "no longer exists" banner).
    if (activeCollection) qs.set("collection", activeCollection.collection.id);
    else if (collectionsBy) qs.set("collectionsBy", collectionsBy);
    if (submitted) qs.set("q", submitted);
    if (category) qs.set("category", category);
    if (tool) qs.set("tool", tool);
    if (type) qs.set("type", type);
    if (showArchived && canManage) qs.set("archived", "1");
    if (mine) qs.set("mine", "1");
    if (official) qs.set("official", "1");
    if (minQuality) qs.set("minQuality", String(minQuality));
  }
  if (sort === "top_rated") qs.set("sort", "top_rated");
  else if (sort === "latest") qs.set("sort", "latest");
  else if (sort === "quality") qs.set("sort", "quality");

  // Hold the grid while a `?collection=` banner is still resolving, so it never flashes the full catalog.
  const skillsUrl = collection === "loading" ? null : `/api/skills${qs.toString() ? `?${qs}` : ""}`;
  const { data, loading, error, reload } = useApi<{ skills: CatalogEntry[]; matchMode?: "all" | "any" | null; collections?: { id: string; name: string; skillCount: number }[] }>(skillsUrl);
  // The owner's "Remove from collection" (§38.5): the same request as the popup's untick.
  const [removing, setRemoving] = useState<string | null>(null);
  const removeFromCollection = async (s: CatalogEntry) => {
    if (!activeCollection || !s.skillId) return;
    setRemoving(s.skillId);
    try {
      const r = await fetch(`/api/collections/${activeCollection.collection.id}/skills/${s.skillId}`, { method: "DELETE" });
      if (r.ok) { reload(); setCollectionTick((t) => t + 1); }
    } finally {
      setRemoving(null);
    }
  };
  const [linkCopied, setLinkCopied] = useState(false);
  useEffect(() => {
    if (!linkCopied) return;
    const t = setTimeout(() => setLinkCopied(false), 1800);
    return () => clearTimeout(t);
  }, [linkCopied]);
  const copyCollectionLink = async () => {
    if (!activeCollection) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${collectionPath(activeCollection.collection.id)}`);
      setLinkCopied(true);
    } catch { /* clipboard blocked */ }
  };
  const deleteActiveCollection = async () => {
    if (!activeCollection) return;
    const c = activeCollection.collection;
    const whose = activeCollection.isOwner ? "" : ` by ${c.owner.name}`;
    if (!window.confirm(`Delete the collection “${c.name}”${whose}? This can’t be undone.`)) return;
    const r = await fetch(`/api/collections/${c.id}`, { method: "DELETE" });
    if (r.ok) setCollectionTick((t) => t + 1); // re-reads as missing → the "no longer exists" banner
  };
  const isCollectionOwner = !!activeCollection?.isOwner;
  const { data: facets } = useApi<Facets>("/api/skills/facets");
  const skills = data?.skills ?? [];
  // §34.5: no skill matched every word, so the grid shows skills matching some of them.
  const partialMatches = !maintainer && !!submitted && data?.matchMode === "any" && skills.length > 0;

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

      {/* Collection banners (§38.5): one collection (the shareable link), or one person's collections. */}
      {!maintainer && collectionParam && collection === "missing" && (
        <div className="reveal collection-banner" data-testid="collection-banner" role="status">
          <div className="collection-banner-head">
            <span>This collection no longer exists.</span>
            <span style={{ flex: 1 }} />
            <Link href="/catalog" className="btn-ghost mono" style={{ fontSize: 12 }}>✕ clear</Link>
          </div>
        </div>
      )}
      {!maintainer && activeCollection && (
        <div className="reveal collection-banner" data-testid="collection-banner">
          <div className="collection-banner-head">
            <UserBubble name={activeCollection.collection.owner.name} avatar={activeCollection.collection.owner.avatar} userId={activeCollection.collection.owner.id} size={26} />
            <span>
              Collection: <strong>{activeCollection.collection.name}</strong> by {activeCollection.collection.owner.name}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-sm" onClick={() => void copyCollectionLink()} title="Copy a link anyone signed in can open">Copy link</button>
            {activeCollection.canDelete && (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void deleteActiveCollection()} data-testid="collection-banner-delete">Delete collection</button>
            )}
            <Link href="/catalog" className="btn-ghost mono" style={{ fontSize: 12 }}>✕ clear</Link>
          </div>
          {activeCollection.collection.description && <p className="collection-banner-desc">{activeCollection.collection.description}</p>}
        </div>
      )}
      {!maintainer && collectionsBy && (
        <div className="reveal collection-banner" data-testid="collections-by-banner">
          <div className="collection-banner-head">
            <span>Skills in collections by <strong>{collectionsByName || "this person"}</strong></span>
            <span style={{ flex: 1 }} />
            <Link href="/catalog" className="btn-ghost mono" style={{ fontSize: 12 }}>✕ clear</Link>
          </div>
          {(data?.collections?.length ?? 0) > 0 && (
            <div className="collection-chips">
              {data!.collections!.map((c) => (
                <Link key={c.id} href={collectionPath(c.id)} className="facet">
                  {c.name} <span className="facet-n">{formatCount(c.skillCount)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
      {linkCopied && <div className="toast" role="status">✓ Link copied</div>}

      {/* Namespace-view banner (from the Marketplaces page's Skills action, §30.6): names the
          namespace and offers a one-click return to the full catalog. Facets stay available. */}
      {!maintainer && !collectionView && nsView && (
        <div className="reveal ns-view-banner" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 20, padding: "10px 14px", borderRadius: "var(--radius-sm)", background: "var(--accent-soft)", fontSize: 13.5 }}>
          <span>Skills in <strong>{nsViewName || nsView}</strong> — that you can see.</span>
          <span style={{ flex: 1 }} />
          <Link href="/catalog" className="btn-ghost mono" style={{ fontSize: 12 }}>✕ clear</Link>
        </div>
      )}

      {!maintainer && hasFacets && (
        <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 22 }}>
          {/* The category vocabulary is unbounded, so this is the one row that can wrap to several
              ragged lines — it collapses, and starts collapsed (§10). The header count is the whole
              visible vocabulary (/api/skills/facets is filter-independent), so it never wobbles. */}
          {facets!.categories.length > 0 && (
            <CollapsibleFacetRow id="catalog-category" label="Category" count={facets!.categories.length} open={categoryOpen} onToggle={toggleCategory}>
              {facets!.categories.map((c) => (
                <Chip key={c.name} active={category === c.name} label={c.name} count={c.count} onClick={() => setCategory(category === c.name ? null : c.name)} />
              ))}
            </CollapsibleFacetRow>
          )}
          {facets!.tools.length > 0 && (
            <FacetRow label="Harness">
              {facets!.tools.map((t) => (
                <Chip key={t.name} active={tool === t.name} label={agentLabel(t.name)} count={t.count} onClick={() => setTool(tool === t.name ? null : t.name)} />
              ))}
            </FacetRow>
          )}
          <FacetRow label="Source">
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
          </FacetRow>
          {/* §41.7 minimum-quality facet: single-select stars floor; unscored skills drop out while active. */}
          <FacetRow label="Quality">
            {([3, 4, 4.5] as const).map((q) => (
              <button
                key={q}
                type="button"
                className={`facet${minQuality === q ? " facet-on" : ""}`}
                aria-pressed={minQuality === q}
                title={`Only skills with a system quality rating of ${q} stars or more`}
                data-testid={`min-quality-${q}`}
                onClick={() => setMinQuality(minQuality === q ? null : q)}
              >
                ⛨ {q}+
              </button>
            ))}
          </FacetRow>
          {(category || tool || type || mine || official || minQuality) && (
            <button className="btn-ghost mono" style={{ fontSize: 12, alignSelf: "flex-start" }} onClick={() => { setCategory(null); setTool(null); setType(null); setMine(false); setOfficial(false); setMinQuality(null); }}>
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
                  <button type="button" className={`sort-opt${sort === "quality" ? " sort-on" : ""}`} onClick={() => setSort("quality")} title="Highest system quality score first" data-testid="sort-quality">
                    ⛨ Highest quality
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
          {partialMatches && (
            <p className="search-partial" role="status">
              No skills match all of your words — showing skills that match some of them.{" "}
              <span className="muted">{SEARCH_TIP}</span>
            </p>
          )}
          {skills.length === 0 ? (
            maintainer ? (
              <EmptyState title="No skills to show" hint={`${maintainerName || "This person"} maintains no skills you have access to.`} />
            ) : activeCollection && !(submitted || category || tool || type || mine || official) ? (
              <EmptyState title="No skills to show" hint="This collection has no skills yet." />
            ) : collectionsBy && !(submitted || category || tool || type || mine || official) ? (
              <EmptyState title="No skills to show" hint={`${collectionsByName || "This person"} has no collections with skills yet.`} />
            ) : nsView && !(submitted || category || tool || type || mine || official) ? (
              <EmptyState title="No skills to show" hint={`${nsViewName || nsView} has no skills you have access to yet.`} />
            ) : (
            <EmptyState
              title={showArchived ? "No archived skills" : submitted || category || tool || type ? "No skills match your filters" : "No skills published yet"}
              hint={
                showArchived
                  ? "You have no archived skills to restore."
                  : `${canManage ? "Try a different search, clear filters, or toggle Archived above." : "Try a different search or clear filters."}${submitted ? ` ${SEARCH_TIP}` : ""}`
              }
            />
            )
          ) : view === "cards" ? (
            <div className="card-grid">
              {skills.map((s, i) =>
                isCollectionOwner ? (
                  <div className="collection-item" key={`${s.namespaceSlug}/${s.skillSlug}`}>
                    <SkillCard s={s} index={i} />
                    <RemoveFromCollection s={s} busy={removing === s.skillId} onRemove={removeFromCollection} />
                  </div>
                ) : s.canAiDraft ? (
                  <div className="collection-item" key={`${s.namespaceSlug}/${s.skillSlug}`}>
                    <SkillCard s={s} index={i} />
                    <AiDraftAction s={s} aiName={aiName} />
                  </div>
                ) : (
                  <SkillCard key={`${s.namespaceSlug}/${s.skillSlug}`} s={s} index={i} />
                ),
              )}
            </div>
          ) : (
            <div className="rows reveal">
              {skills.map((s) =>
                isCollectionOwner ? (
                  <div className="collection-item is-row" key={`${s.namespaceSlug}/${s.skillSlug}`}>
                    <SkillListRow s={s} />
                    <RemoveFromCollection s={s} busy={removing === s.skillId} onRemove={removeFromCollection} />
                  </div>
                ) : s.canAiDraft ? (
                  <div className="collection-item is-row" key={`${s.namespaceSlug}/${s.skillSlug}`}>
                    <SkillListRow s={s} />
                    <AiDraftAction s={s} aiName={aiName} />
                  </div>
                ) : (
                  <SkillListRow key={`${s.namespaceSlug}/${s.skillSlug}`} s={s} />
                ),
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** §44.9 My Skills: "Draft improvements with <AI>" — opens the skill's Quality card with the draft dialog. */
function AiDraftAction({ s, aiName }: { s: CatalogEntry; aiName: string }) {
  return (
    <Link href={`/skills/${s.namespaceSlug}/${s.skillSlug}?draft=ai#quality`} className="collection-remove ai-draft-action" data-testid="ai-draft-action">
      ✦ Draft improvements with {aiName}
    </Link>
  );
}

/** §38.5 the collection owner's per-skill remove control (outside the card, so nothing is covered). */
function RemoveFromCollection({ s, busy, onRemove }: { s: CatalogEntry; busy: boolean; onRemove: (s: CatalogEntry) => void }) {
  return (
    <button
      type="button"
      className="collection-remove"
      disabled={busy}
      onClick={() => onRemove(s)}
      aria-label={`Remove ${s.title} from this collection`}
      data-testid="collection-remove"
    >
      {busy ? "…" : "✕ Remove from collection"}
    </button>
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
