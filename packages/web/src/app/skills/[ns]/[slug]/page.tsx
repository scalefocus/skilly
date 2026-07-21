"use client";
import { useEffect, useRef, useState } from "react";
import nextDynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useApi, Pill, CopyCommand, EmptyState, ScrollToTop, formatCount, ShareButton } from "../../../../components/ui";
import { ExpiryPicker } from "../../../../components/ExpiryPicker";
import { useDateFmt } from "../../../../components/DateFormat";
import { Markdown } from "../../../../components/Markdown";
import { UserBubble } from "../../../../components/UserBubble";
import { OfficialBadge, SkillCard, type CatalogEntry } from "../../../../components/SkillCard";
import { readPref, writePref, PREF_SKILL_RANGE } from "../../../../lib/prefs";
import { usePageLabelOverride } from "../../../../components/PageLabelOverride";
import { SkillDiscussion } from "./SkillDiscussion";

// recharts is heavy (d3) and owner-only — code-split it out of the route's initial bundle.
// ssr:false since the chart measures the DOM; a skeleton holds its height while it loads.
const UsageTrendChart = nextDynamic(() => import("./UsageTrendChart").then((m) => m.UsageTrendChart), {
  ssr: false,
  loading: () => <div className="skeleton" style={{ height: 200, borderRadius: "var(--radius)" }} />,
});

type SeriesRange = "7d" | "30d" | "90d" | "all";
const SERIES_RANGES: { key: SeriesRange; label: string }[] = [
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "90d", label: "90d" },
  { key: "all", label: "All" },
];
// Coerce a remembered (localStorage) string back to a valid range, defaulting to 30d.
const toSeriesRange = (s: string): SeriesRange => (s === "7d" || s === "90d" || s === "all" ? s : "30d");
interface SkillSeries { range: SeriesRange; bucket: "day" | "week" | "month"; points: { date: string; views: number; installs: number }[] }

interface VersionView { semver: string; channel: "stable" | "beta"; status: "active" | "yanked"; createdAt: string; gitPublished: boolean; downloadExt: string }
interface RatingView { avg: number; count: number; distribution: number[]; mine: number | null }
interface MaintainerView { userId: string; displayName: string; email: string; avatar: string | null; source: "admin" | "explicit" }

/** Profile bubble: Entra photo (captured at the user's own sign-in) or initials when absent. */
function MaintainerBubble({ m }: { m: MaintainerView }) {
  return <UserBubble name={m.displayName} avatar={m.avatar} userId={m.userId} />;
}

/** Markdown clamped to a collapsed height (≈ the Install card) with a fade + Show more/less toggle.
 *  The toggle only appears when the rendered content actually overflows the cap. */
function CollapsibleMarkdown({ source, collapsedHeight = 240 }: { source: string; collapsedHeight?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // scrollHeight is the full content height regardless of the maxHeight clamp, so this detects
    // overflow even while collapsed. Re-measured on content change + viewport resize (reflow).
    const measure = () => setOverflows(el.scrollHeight > collapsedHeight + 8);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [source, collapsedHeight]);
  const clamp = !expanded && overflows;
  return (
    <div>
      <div ref={ref} style={{ position: "relative", maxHeight: clamp ? collapsedHeight : undefined, overflow: clamp ? "hidden" : undefined }}>
        <Markdown source={source} />
        {clamp && (
          <div aria-hidden style={{ position: "absolute", insetInline: 0, bottom: 0, height: 72, background: "linear-gradient(to bottom, transparent, var(--surface))", pointerEvents: "none" }} />
        )}
      </div>
      {overflows && (
        <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: 12 }} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
interface Detail {
  namespaceSlug: string; skillSlug: string; visibility: "org" | "namespace";
  versions: VersionView[]; latest: string | null; latestInstallable: string | null; publishing: boolean; watching: boolean; watchers: number; rating: RatingView;
  usageExamples: string | null; archived: boolean;
  pointer: { originUrl: string; subdir: string | null } | null;
  meta: { toolHarness: string; title: string; description: string } | null;
  pendingMirror: { semver: string; attempts: number; failed: boolean; lastError: string | null } | null;
  createdAt: string; updatedAt: string;
  official: boolean; officialAt: string | null; officialByName: string | null; canMarkOfficial: boolean;
  featured: boolean; canFeature: boolean;
  canManage: boolean; canDelete: boolean; canPromote: boolean; isGlobal: boolean; canRetryMirror: boolean;
  discussionCount: number;
}

export default function SkillDetail() {
  const fmt = useDateFmt();
  const { ns, slug } = useParams<{ ns: string; slug: string }>();
  const router = useRouter();
  const { data, loading, error, reload } = useApi<Detail>(ns && slug ? `/api/skills/${ns}/${slug}` : null);
  usePageLabelOverride(data ? `Skill: ${data.meta?.title || data.skillSlug}` : null);
  const { data: readme } = useApi<{ semver: string; content: string }>(ns && slug ? `/api/skills/${ns}/${slug}/readme` : null);
  // Admin-configured install-expiry horizon (calendar months) — bounds the picker; server re-validates. §23
  const { data: me } = useApi<{ installMaxTtlMonths?: number; isPlatformAdmin?: boolean }>("/api/me");
  const [install, setInstall] = useState<{ command: string; semver: string | null; expiresAt: string | null; system?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "err" | "ok"; text: string } | null>(null);
  // Split-button install: chosen version (null = latest) + chosen expiry (null = never).
  const [selVersion, setSelVersion] = useState<string | null>(null);
  const [verOpen, setVerOpen] = useState(false);
  // Pointer download split-button: format menu (.skill default / .tar.gz). §6, §10.
  const [dlOpen, setDlOpen] = useState(false);
  // Split-button dropdown containers — an outside click or Escape dismisses whichever is open. §23.
  const verRef = useRef<HTMLDivElement>(null);
  const dlRef = useRef<HTMLDivElement>(null);
  const [expiresIso, setExpiresIso] = useState<string | null>(null);
  // "On a date" picked but no date chosen yet — minting is blocked and, once the user clicks
  // Install, `expiryAlert` explains why right at the controls.
  const [expiryPending, setExpiryPending] = useState(false);
  const [expiryAlert, setExpiryAlert] = useState(false);
  // "System install" (platform admins only, §23): mints a platform-owned token for CI/org tools —
  // not tied to any user, listed under Installed skills → System installs for all platform admins.
  const [systemInstall, setSystemInstall] = useState(false);
  // Usage trend chart — visible to anyone who can view the (active) skill; fetched lazily once it
  // loads (gating on `data` ensures the skill is viewable before we ask for its series).
  // Shares the per-skill chart window with the Usage page, remembered across visits (SKILLY_SPEC.md §21).
  const [seriesRange, setSeriesRange] = useState<SeriesRange>(() => toSeriesRange(readPref(PREF_SKILL_RANGE, "30d")));
  const pickSeriesRange = (r: SeriesRange) => { setSeriesRange(r); writePref(PREF_SKILL_RANGE, r); };
  const { data: series, loading: seriesLoading } = useApi<SkillSeries>(
    data && !data.archived && ns && slug ? `/api/skills/${ns}/${slug}/usage-series?range=${seriesRange}` : null,
  );

  const base = `/api/skills/${ns}/${slug}`;

  // A generated command is tied to the version + expiry + system-install mode it was minted with
  // (and its token). Changing the version, toggling/picking the expiry, or toggling "System
  // install" makes the shown command stale — hide it (and its caption) until the user clicks
  // Install again. Mint doesn't touch these deps, so a freshly minted command survives. §23.
  useEffect(() => { setInstall(null); }, [selVersion, expiresIso, expiryPending, systemInstall]);

  // Dismiss the split-button dropdowns (version picker · Pointer download format) on an outside
  // click — anywhere off the open menu and its ▾ toggle — or on Escape, matching the app's other
  // dismissible menus (EmojiPicker, ToolHarnessPicker). onBlur alone misses clicks on non-focusable
  // page areas, so we listen on the document instead. §23, §6/§10.
  useEffect(() => {
    if (!verOpen && !dlOpen) return;
    const onDown = (e: MouseEvent) => {
      if (verOpen && verRef.current && !verRef.current.contains(e.target as Node)) setVerOpen(false);
      if (dlOpen && dlRef.current && !dlRef.current.contains(e.target as Node)) setDlOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setVerOpen(false); setDlOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [verOpen, dlOpen]);

  const mint = async () => {
    // "On a date" is selected but no date was picked yet. Keep the button clickable (rather than
    // silently disabled) so this click tells the user WHY no command appears and what to do —
    // shown inline at the controls, right where they clicked.
    if (expiryPending) {
      setExpiryAlert(true);
      return;
    }
    setExpiryAlert(false);
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${base}/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ semver: selVersion, expiresAt: expiresIso, system: systemInstall }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed to mint command");
      setInstall(await r.json());
    } catch (e) { setMsg({ kind: "err", text: String((e as Error).message) }); } finally { setBusy(false); }
  };

  const rate = async (stars: number | null) => {
    setBusy(true); setMsg(null);
    try {
      const r = stars == null
        ? await fetch(`${base}/rating`, { method: "DELETE" })
        : await fetch(`${base}/rating`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ stars }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      setMsg({ kind: "ok", text: stars == null ? "Rating cleared." : `Rated ${stars} ★.` });
      reload();
    } catch (e) { setMsg({ kind: "err", text: String((e as Error).message) }); } finally { setBusy(false); }
  };

  // Platform-admin retry of a dead-lettered mirror: resets the pending row so the worker makes
  // up to MIRROR_MAX_ATTEMPTS fresh attempts. The page then flips back to the "Mirroring…" state. §6.
  const retryMirror = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${base}/retry-mirror`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      setMsg({ kind: "ok", text: "Retrying — mirroring will run again within a minute." });
      reload();
    } catch (e) { setMsg({ kind: "err", text: String((e as Error).message) }); } finally { setBusy(false); }
  };

  const act = async (path: string, body: unknown, okText: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      if (path === "promote" && j.proposalId) { router.push(`/proposals/${j.proposalId}`); return; }
      setMsg({ kind: "ok", text: okText });
      reload();
    } catch (e) { setMsg({ kind: "err", text: String((e as Error).message) }); } finally { setBusy(false); }
  };

  // Permanent, irreversible deletion (platform admin). Confirm, then navigate away on success
  // (reloading a deleted skill would 404).
  const del = async () => {
    if (!data) return;
    const ok = window.confirm(
      `Permanently delete ${data.namespaceSlug}/${data.skillSlug}?\n\nThis removes the skill and ALL of its versions, ratings, watchers, and usage stats. This cannot be undone.`,
    );
    if (!ok) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${base}/delete`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      router.push("/catalog"); // gone — leave the (now 404) detail page
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message) });
      setBusy(false);
    }
  };

  if (error) return <EmptyState icon="⚠" title="Skill unavailable" hint={error} />;
  if (loading || !data) return <div className="skeleton" style={{ height: 180, borderRadius: "var(--radius)" }} />;

  // Download format = the version's ORIGINAL uploaded extension (.skill/.zip/.tar.gz), provided
  // per-version by the API. The top "Download" button serves the latest stable, so label it with
  // that version's ext; fall back to the harness heuristic if the version isn't found. §6/§10.
  const dlExt = data.versions.find((v) => v.semver === data.latest)?.downloadExt ?? (data.meta?.toolHarness === "claude-code" ? "skill" : "zip");

  return (
    <div className="reveal" style={{ maxWidth: 820 }}>
      <ScrollToTop />
      <Link href="/catalog" className="btn-ghost mono" style={{ fontSize: 12, marginBottom: 18, display: "inline-block" }}>← catalog</Link>

      <div className="meta" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <span className="ns" style={{ fontSize: 15 }}>@{data.namespaceSlug}</span>
        <OfficialBadge official={data.official} />
        {data.latest && <span className="chip chip-accent">v{data.latest}</span>}
        {data.visibility === "namespace" ? <Pill tone="warn">restricted</Pill> : <Pill tone="ok">org-wide</Pill>}
        {data.archived && <Pill tone="danger">archived</Pill>}
        <span className="grow" style={{ flex: 1 }} />
        {data.watchers > 0 && (
          <span className="muted mono" style={{ fontSize: 12 }} title={`${data.watchers} ${data.watchers === 1 ? "person is" : "people are"} watching this skill`}>
            <span aria-hidden>👁</span> {formatCount(data.watchers)} watching
          </span>
        )}
      </div>

      {/* Action buttons live on their OWN row, below the identity chips (@ns · Official · version ·
          visibility), so a skill with many controls doesn't crowd the metadata line. */}
      <div className="meta" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <ShareButton />
        {!data.archived && (
          <button
            className={`btn btn-sm${data.watching ? " btn-primary" : ""}`}
            disabled={busy}
            onClick={() => act("watch", { watch: !data.watching }, data.watching ? "Unwatched." : "Watching — you’ll be notified of new versions.")}
            title={data.watching ? "stop watching this skill" : "get notified when a new version is published"}
          >
            {data.watching ? "★ Watching" : "☆ Watch"}
          </button>
        )}
        {data.latest && (data.pointer ? (
          // Pointer skills: split-button download with a format choice — .skill (default,
          // re-packed from the mirrored tarball) or .tar.gz (the stored mirror verbatim). §6, §10.
          <div ref={dlRef} style={{ position: "relative", display: "inline-flex" }}>
            <a
              className="btn btn-sm"
              href={`${base}/download?format=skill`}
              title="Download the latest version as a .skill bundle (re-packed from the mirrored tarball)"
              style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
            >
              ↓ Download .skill
            </a>
            <button
              type="button"
              className="btn btn-sm"
              aria-label="Choose a download format"
              aria-expanded={dlOpen}
              onClick={() => setDlOpen((o) => !o)}
              style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: "1px solid var(--line)", padding: "0 9px" }}
            >
              ▾
            </button>
            {dlOpen && (
              <div role="menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20, minWidth: 160, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow)", padding: 4 }}>
                <a className="ver-opt" href={`${base}/download?format=skill`} onClick={() => setDlOpen(false)}>.skill (default)</a>
                <a className="ver-opt" href={`${base}/download?format=tar.gz`} onClick={() => setDlOpen(false)}>.tar.gz</a>
              </div>
            )}
          </div>
        ) : (
          <a className="btn btn-sm" href={`${base}/download`} title={`Download the latest version (.${dlExt})`}>
            ↓ Download .{dlExt}
          </a>
        ))}
        {!data.archived && (
          <Link
            href={`/propose?ns=${data.namespaceSlug}&slug=${data.skillSlug}&newVersion=1`}
            className="btn btn-sm"
            title="Propose a new version of this skill (slug and skill details stay the same)"
          >
            + New version
          </Link>
        )}
        {data.canPromote && (
          <button className="btn btn-sm" disabled={busy} onClick={() => act("promote", {}, "")} title="Open a global-namespace proposal">
            Promote to global →
          </button>
        )}
        {data.canMarkOfficial && (
          data.official ? (
            <button className="btn btn-sm" disabled={busy} onClick={() => act("official", { official: false }, "Official mark removed.")} title="Remove the Official endorsement">
              Unmark Official
            </button>
          ) : (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act("official", { official: true }, "Marked Official.")} title="Endorse this skill as Official (first-party / sanctioned)">
              ✓ Mark Official
            </button>
          )
        )}
        {data.canFeature && (
          // Featured homepage spotlight (§7): platform-admin only, shown only on an active,
          // installable skill. A full cap or lost installability is rejected server-side; the
          // error surfaces in the message row below.
          data.featured ? (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act("feature", { featured: false }, "Removed from Featured.")} title="Remove this skill from the home page’s Featured section">
              ✓ Spotlighted
            </button>
          ) : (
            <button className="btn btn-sm" disabled={busy} onClick={() => act("feature", { featured: true }, "Added to Featured — it now appears on the home page.")} title="Feature this skill in the home page’s Featured section">
              Spotlight
            </button>
          )
        )}
        {data.canManage && (
          data.archived ? (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act("archive", { archived: false }, "Skill restored.")}>
              Restore skill
            </button>
          ) : (
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => act("archive", { archived: true }, "Skill archived.")}>
              Archive skill
            </button>
          )
        )}
        {data.canDelete && (
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={del} title="Permanently delete this skill and all its data — cannot be undone">
            Delete skill
          </button>
        )}
      </div>
      <h1 className="page-title" style={{ fontSize: "clamp(30px,4vw,44px)" }}>{data.meta?.title || data.skillSlug}</h1>
      <div className="muted mono" style={{ fontSize: 14, marginTop: 6 }}>{data.skillSlug}</div>
      <div className="muted mono" style={{ fontSize: 11.5, marginTop: 8 }}>
        created {fmt.date(data.createdAt)} · last updated {fmt.date(data.updatedAt)}
      </div>
      {data.official && data.officialAt && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
          <span className="chip chip-official"><span aria-hidden>✓</span> Official</span>
          <span>Endorsed by the platform{data.officialByName ? ` · marked by ${data.officialByName}` : ""} · {fmt.date(data.officialAt)}</span>
        </div>
      )}
      {!data.archived && (
        <div className="card card-pad" style={{ marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 16, margin: 0 }}>
              Installs &amp; views
            </h2>
            <div className="sort-toggle" role="group" aria-label="Trend range">
              {SERIES_RANGES.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={`sort-opt${seriesRange === r.key ? " sort-on" : ""}`}
                  onClick={() => pickSeriesRange(r.key)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          {series && series.points.length > 0 ? (
            <UsageTrendChart points={series.points} bucket={series.bucket} />
          ) : seriesLoading || !series ? (
            <div className="skeleton" style={{ height: 200, marginTop: 14, borderRadius: "var(--radius)" }} />
          ) : (
            <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>No installs or views recorded in this range yet.</p>
          )}
        </div>
      )}
      {data.meta?.description && (
        <div style={{ marginTop: 14 }}>
          <Markdown source={data.meta.description} />
        </div>
      )}
      {msg && <div style={{ marginTop: 12, fontSize: 13.5, color: msg.kind === "err" ? "var(--danger)" : "var(--ok)" }}>{msg.text}</div>}

      <div className="card card-pad" style={{ marginTop: 24 }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, marginBottom: 4 }}>Install</h2>
        {data.archived ? (
          <p className="muted" style={{ fontSize: 14 }}>This skill is <strong>archived</strong> — it can’t be installed. Restore it to make it installable again.</p>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 14, marginBottom: 14 }}>
              Pick a version and an expiry, then generate a personal install command. Every install
              carries a unique key you can revoke any time from <span className="mono">Installed skills</span>.
            </p>
            {data.latestInstallable ? (
              <>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: install ? 14 : 0 }}>
                  <div ref={verRef} style={{ position: "relative", display: "inline-flex" }}>
                    <button className="btn btn-primary" onClick={mint} disabled={busy} title={expiryPending ? "Pick an expiry date first" : undefined} style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>
                      {busy ? "Working…" : selVersion ? `Install v${selVersion}` : "Install latest"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      aria-label="Choose a version"
                      aria-expanded={verOpen}
                      onClick={() => setVerOpen((o) => !o)}
                      style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: "1px solid color-mix(in oklab, var(--accent-ink) 35%, transparent)", padding: "0 11px" }}
                    >
                      ▾
                    </button>
                    {verOpen && (
                      <div role="menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20, minWidth: 180, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow)", padding: 4, maxHeight: 280, overflowY: "auto" }}>
                        <button type="button" className="ver-opt" onClick={() => { setSelVersion(null); setVerOpen(false); }}>Install latest</button>
                        {data.versions.filter((v) => v.status === "active" && v.gitPublished).map((v) => (
                          <button key={v.semver} type="button" className="ver-opt" onClick={() => { setSelVersion(v.semver); setVerOpen(false); }}>
                            v{v.semver}{v.channel === "beta" ? " · beta" : ""}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="muted" style={{ fontSize: 12.5 }}>expires</span>
                  <ExpiryPicker maxMonths={me?.installMaxTtlMonths ?? 12} onChange={setExpiresIso} onPendingChange={(p) => { setExpiryPending(p); if (!p) setExpiryAlert(false); }} />
                  {me?.isPlatformAdmin && (
                    // System installation (§23): platform-owned token for CI/org tools. Rendered for
                    // platform admins only; the server re-verifies the role on mint.
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: "pointer" }} title="Mint a platform-owned install for CI pipelines and org tools — not tied to any user; all platform admins can manage it from Installed skills">
                      <input type="checkbox" checked={systemInstall} onChange={(e) => setSystemInstall(e.target.checked)} />
                      System install
                    </label>
                  )}
                </div>
                {expiryAlert && (
                  <div role="alert" style={{ marginTop: 10, fontSize: 13, color: "var(--danger)" }}>
                    No install command yet — choose an <strong>expiration date</strong> above, or switch the expiry to <span className="mono">Never</span>.
                  </div>
                )}
                {systemInstall && !expiresIso && !expiryPending && (
                  // A Never system token is an eternal shared credential — say so before it's minted. §23
                  <div style={{ marginTop: 10, fontSize: 13, color: "var(--warn, #b45309)" }}>
                    This system install <strong>never expires</strong> — a shared credential that stays valid until a platform admin uninstalls it.
                  </div>
                )}
                {install && (
                  <>
                    <CopyCommand command={install.command} autoCopy />
                    <div className="muted mono" style={{ fontSize: 11, marginTop: 10 }}>
                      {install.system ? "system install · " : ""}{install.semver ? `pinned v${install.semver}` : "latest"} · {install.expiresAt ? `expires ${fmt.dateTime(install.expiresAt)}` : "never expires"} · manage in Installed skills{install.system ? " → System installs" : ""}
                    </div>
                  </>
                )}
              </>
            ) : data.pendingMirror && !data.pendingMirror.failed ? (
              // Pointer skill just published — the worker is mirroring it. No version yet.
              <div className="muted" style={{ fontSize: 13.5, display: "flex", alignItems: "center", gap: 10 }}>
                <span className="spinner" aria-hidden />
                Mirroring <span className="mono">v{data.pendingMirror.semver}</span> from the external source — the installable version appears here once it completes. Refresh in a moment.
              </div>
            ) : data.pendingMirror && data.pendingMirror.failed ? (
              // Dead-lettered: the mirror failed permanently. Show why so the owner can fix the ref/URL.
              <div style={{ fontSize: 13.5 }}>
                <div style={{ color: "var(--danger)", fontWeight: 500, marginBottom: 6 }}>
                  ✕ Mirroring <span className="mono">v{data.pendingMirror.semver}</span> failed after {data.pendingMirror.attempts} attempts.
                </div>
                <div className="muted">The external source couldn’t be fetched, so no installable version was created. Check the pinned ref and URL, then propose a new version.</div>
                {data.pendingMirror.lastError && (
                  <pre className="mono" style={{ fontSize: 11, marginTop: 8, padding: "8px 10px", background: "var(--surface-2)", borderRadius: "var(--radius-sm)", overflowX: "auto", color: "var(--muted)", whiteSpace: "pre-wrap" }}>
                    {data.pendingMirror.lastError}
                  </pre>
                )}
                {/* Platform admins can re-arm the mirror (5 fresh attempts) — e.g. after a transient
                    upstream/network fault. A genuinely wrong ref/URL still needs a new version. §6. */}
                {data.canRetryMirror && (
                  <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={retryMirror} disabled={busy}>
                    ↻ Retry mirroring
                  </button>
                )}
              </div>
            ) : data.publishing ? (
              // Version is active but its serving git repo isn't synthesized yet — the publish
              // sweep builds it within ~60s. Don't offer an install command that would 404. §6/§9.
              <div className="muted" style={{ fontSize: 13.5, display: "flex", alignItems: "center", gap: 10 }}>
                <span className="spinner" aria-hidden />
                Publishing this skill — the install command appears here once its repository is built (usually within a minute). Refresh shortly.
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 13.5 }}>No published version yet.</div>
            )}
          </>
        )}
        {data.pointer && (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <span className="mono" style={{ textTransform: "uppercase", letterSpacing: "0.1em", fontSize: 10.5, color: "var(--faint)", marginRight: 8 }}>External source</span>
            mirrored from <a href={data.pointer.originUrl} target="_blank" rel="noreferrer noopener" className="mono">{data.pointer.originUrl}</a>
            {data.pointer.subdir && <> · folder <span className="mono">{data.pointer.subdir}/</span></>}
          </div>
        )}
      </div>

      {data.usageExamples && (
        <div className="card card-pad" style={{ marginTop: 20 }}>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, marginBottom: 8 }}>Usage</h2>
          <Markdown source={data.usageExamples} />
        </div>
      )}

      {readme && (
        <div className="card card-pad" style={{ marginTop: 20 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>SKILL.md</h2>
            <span className="muted mono" style={{ fontSize: 11 }}>v{readme.semver}</span>
          </div>
          <CollapsibleMarkdown source={readme.content} />
        </div>
      )}

      <RatingPanel rating={data.rating} busy={busy} onRate={rate} readOnly={data.archived} />

      <MaintainersPanel ns={ns} slug={slug} />

      <SkillDiscussion ns={ns} slug={slug} versions={data.versions} latest={data.latest} initialCount={data.discussionCount} />

      <hr className="divider" />

      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 14 }}>Versions</h2>
      {data.versions.length === 0 ? (
        <div className="muted">No versions published.</div>
      ) : (
        <div className="rows">
          {data.versions.map((v) => (
            <div className="row version-row" id={`version-${v.semver}`} key={v.semver} style={{ scrollMarginTop: 80 }}>
              <div className="version-head">
                <span className="mono" style={{ fontWeight: 500 }}>v{v.semver}</span>
                {v.channel === "beta" ? <Pill tone="warn">beta</Pill> : <Pill tone="ok">stable</Pill>}
                {v.status === "yanked" && <Pill tone="danger">yanked</Pill>}
              </div>
              <span className="grow" />
              <span className="muted mono version-date" style={{ fontSize: 12 }}>{fmt.date(v.createdAt)}</span>
              <div className="version-actions">
                {v.status === "active" && (
                  <a className="btn btn-sm" href={`${base}/download?semver=${encodeURIComponent(v.semver)}`} title={`Download v${v.semver} (.${v.downloadExt})${data.pointer ? " — pointer skills download as .tar.gz" : ""}`}>
                    ↓ .{v.downloadExt}
                  </a>
                )}
                {data.canManage && (
                  <button
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => act("yank", { semver: v.semver, yanked: v.status !== "yanked" }, v.status === "yanked" ? "Version restored." : "Version yanked.")}
                    title={v.status === "yanked" ? "restore this version" : "yank this version"}
                  >
                    {v.status === "yanked" ? "restore" : "yank"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <RelatedSkills ns={ns} slug={slug} />
    </div>
  );
}

/** "Skills you might like" (§10): up to 3 skills most often installed together with this one
 *  (co-install signal, precomputed nightly; visibility-filtered server-side) that the viewer hasn't
 *  installed yet. When there were related skills but the viewer has them all, shows a note instead;
 *  hidden entirely when there were no visible neighbours to begin with. */
function RelatedSkills({ ns, slug }: { ns: string; slug: string }) {
  const { data } = useApi<{ related: CatalogEntry[]; allInstalled: boolean }>(ns && slug ? `/api/skills/${ns}/${slug}/related` : null);
  if (!data) return null;
  const { related, allInstalled } = data;
  // Nothing to show and it's not the "you've installed them all" case → omit the section.
  if (related.length === 0 && !allInstalled) return null;
  return (
    <section className="reveal" style={{ marginTop: 30 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 4 }}>Skills you might like</h2>
      {related.length > 0 ? (
        <>
          <p className="page-sub" style={{ marginBottom: 16 }}>Often installed together with this one — that you haven’t installed yet.</p>
          <div className="card-grid">
            {related.map((s, i) => <SkillCard key={`${s.namespaceSlug}/${s.skillSlug}`} s={s} index={i} />)}
          </div>
        </>
      ) : (
        <p className="muted" style={{ fontSize: 13.5 }}>You have all related skills.</p>
      )}
    </section>
  );
}

// Star control + distribution histogram (SKILLY_SPEC.md §18). Module scope so it isn't
// remounted on every parent render. Hover previews the prospective rating.
function RatingPanel({ rating, busy, onRate, readOnly = false }: { rating: RatingView; busy: boolean; onRate: (stars: number | null) => void; readOnly?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? rating.mine ?? 0;
  const max = Math.max(1, ...rating.distribution);

  return (
    <div className="card card-pad" style={{ marginTop: 20 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, marginBottom: 4 }}>Ratings</h2>
      <p className="muted" style={{ fontSize: 14, marginBottom: 16 }}>
        {rating.count === 0 ? "Not rated yet — be the first." : `${rating.avg.toFixed(1)} average from ${rating.count} rating${rating.count === 1 ? "" : "s"}.`}
      </p>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        {rating.count > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 44, lineHeight: 1 }}>{rating.avg.toFixed(1)}</div>
            <div className="rating-hist" aria-hidden>
              {[5, 4, 3, 2, 1].map((star) => (
                <div className="rating-hist-row" key={star}>
                  <span className="rating-hist-label">{star}★</span>
                  <span className="rating-hist-track"><span className="rating-hist-fill" style={{ width: `${((rating.distribution[star - 1] ?? 0) / max) * 100}%` }} /></span>
                  <span className="rating-hist-n">{rating.distribution[star - 1] ?? 0}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {readOnly ? (
          // Archived skills are read-only: ratings can be viewed but not changed (the API
          // also rejects rating an archived skill). Show the caller's existing rating, if any.
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div className="nav-label" style={{ padding: "0 0 8px" }}>Your rating</div>
            <div className="star-input" aria-hidden style={{ opacity: 0.5 }}>
              {[1, 2, 3, 4, 5].map((star) => (
                <span key={star} className={`star${rating.mine != null && star <= rating.mine ? " star-on" : ""}`}>★</span>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 8, maxWidth: 180 }}>
              Archived — rating is closed. {rating.mine != null ? "Your past rating still counts." : ""}
            </div>
          </div>
        ) : (
          <div style={{ marginLeft: "auto" }}>
            <div className="nav-label" style={{ padding: "0 0 8px" }}>Your rating</div>
            <div className="star-input" onMouseLeave={() => setHover(null)}>
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  disabled={busy}
                  className={`star${star <= shown ? " star-on" : ""}`}
                  onMouseEnter={() => setHover(star)}
                  onClick={() => onRate(star)}
                  aria-label={`${star} star${star === 1 ? "" : "s"}`}
                >
                  ★
                </button>
              ))}
            </div>
            {rating.mine != null && (
              <button className="btn-ghost mono" style={{ fontSize: 11, marginTop: 8 }} disabled={busy} onClick={() => onRate(null)}>
                ✕ clear my rating
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Maintainers list + management (SKILLY_SPEC.md §19). Self-contained: fetches the effective
// list + the caller's manage permission, with a debounced eligible-user typeahead for adding.
function MaintainersPanel({ ns, slug }: { ns: string; slug: string }) {
  const { data, reload } = useApi<{ maintainers: MaintainerView[]; canManage: boolean; canRemoveOthers: boolean }>(ns && slug ? `/api/skills/${ns}/${slug}/maintainers` : null);
  const { data: me } = useApi<{ userId: string | null; devAuth?: boolean }>("/api/me");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ userId: string; displayName: string; email: string; avatar: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const [reaching, setReaching] = useState<string | null>(null);

  // "Reach out": open (or reuse) a 1:1 direct conversation with this maintainer in the messages menu.
  const reachOut = async (userId: string) => {
    setReaching(userId);
    try {
      const r = await fetch("/api/messages/direct", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
      if (r.ok) {
        const { conversationId } = await r.json();
        window.dispatchEvent(new CustomEvent("skilly:open-conversation", { detail: { id: conversationId } }));
      }
    } finally { setReaching(null); }
  };

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/skills/${ns}/${slug}/maintainers/candidates?q=${encodeURIComponent(q)}`);
        if (r.ok) setResults((await r.json()).candidates ?? []);
      } catch { /* ignore transient search errors */ }
    }, 200);
    return () => clearTimeout(t);
  }, [q, ns, slug]);

  const mutate = async (method: "PUT" | "DELETE", userId: string) => {
    setBusy(true);
    try {
      await fetch(`/api/skills/${ns}/${slug}/maintainers`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
      setQ(""); setResults([]); reload();
    } finally { setBusy(false); }
  };

  if (!data) return null;
  const inputStyle = { width: "100%", padding: "9px 11px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 13.5 } as const;

  return (
    <div className="card card-pad" style={{ marginTop: 20 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, marginBottom: 4 }}>Maintainers</h2>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 14 }}>Owners of this skill — notified of new versions and drift. Namespace admins are maintainers automatically.</p>

      {data.maintainers.length === 0 ? (
        <div className="muted" style={{ fontSize: 13.5 }}>No maintainers yet.</div>
      ) : (
        <div className="rows">
          {data.maintainers.map((m) => (
            // Responsive: on desktop one row [avatar | name | tag+reach | ✕]; on mobile the
            // tag + Reach out wrap to a second row below the name, and the ✕ stays vertically
            // centered on the right (see .maintainer-item in globals.css).
            <div className="maintainer-item" key={m.userId}>
              <div className="m-av"><MaintainerBubble m={m} /></div>
              <div className="m-name">
                <div className="ttl">{m.displayName}</div>
                <div className="sub mono" style={{ fontSize: 11 }}>{m.email}</div>
              </div>
              <div className="m-meta">
                <span className="chip">{m.source === "admin" ? "ns admin" : "maintainer"}</span>
                {/* Hidden on your own card — except under dev sign-in, so a solo dev can test the flow. */}
                {me?.userId && (m.userId !== me.userId || me.devAuth) && (
                  <button className="btn btn-sm" disabled={reaching === m.userId} onClick={() => reachOut(m.userId)} title={m.userId === me.userId ? "Message yourself (dev test)" : `Message ${m.displayName}`}>
                    {reaching === m.userId ? "…" : "Reach out"}
                  </button>
                )}
              </div>
              {/* Remove: a platform admin, the namespace admin, or any of the skill's maintainers
                  can remove an explicit maintainer; self-removal always allowed (§19). */}
              {m.source === "explicit" && (data.canRemoveOthers || m.userId === me?.userId) && (
                <button className="btn btn-sm btn-ghost m-del" disabled={busy} onClick={() => mutate("DELETE", m.userId)} title={m.userId === me?.userId ? "remove yourself as a maintainer" : "remove maintainer"}>✕</button>
              )}
            </div>
          ))}
        </div>
      )}

      {data.canManage && (
        <div style={{ marginTop: 14, position: "relative" }}>
          <input style={inputStyle} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a maintainer — search by name or email…" />
          {results.length > 0 && (
            <div className="taginput-menu">
              {results.map((u) => (
                <button key={u.userId} type="button" className="taginput-opt" disabled={busy} onClick={() => mutate("PUT", u.userId)} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <UserBubble name={u.displayName} avatar={u.avatar} size={22} />
                  <span>{u.displayName} <span className="muted">· {u.email}</span></span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
