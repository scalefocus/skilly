"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import nextDynamic from "next/dynamic";
import { Pill, EmptyState, LoadMoreSentinel, ScrollToTop, formatCount } from "../../components/ui";
import { UserBubble } from "../../components/UserBubble";
import { useDateFmt } from "../../components/DateFormat";
import { readPref, writePref, PREF_DAU_RANGE, PREF_ONLINE_WINDOW, adminCardPrefKey } from "../../lib/prefs";
import { CollapsibleCard } from "./CollapsibleCard";
import { EmailCard } from "./EmailCard";
import { SystemBannerCard } from "./SystemBannerCard";

// recharts is heavy (d3) — code-split it out of the admin route's initial bundle.
const ActiveUsersChart = nextDynamic(() => import("./ActiveUsersChart").then((m) => m.ActiveUsersChart), {
  ssr: false,
  loading: () => <div className="skeleton" style={{ height: 180, borderRadius: "var(--radius)" }} />,
});

type DauRange = 7 | 30 | 90 | "all";
const DAU_RANGES: { key: DauRange; label: string }[] = [
  { key: 7, label: "7d" },
  { key: 30, label: "30d" },
  { key: 90, label: "90d" },
  { key: "all", label: "All" },
];
const toDauRange = (s: string): DauRange => (s === "all" ? "all" : s === "7" ? 7 : s === "90" ? 90 : 30);

// "Online" window choices (§4) — must mirror ONLINE_WINDOW_OPTIONS server-side; anything else the
// server falls back to 5. `long` is for the card's descriptive sentence.
const ONLINE_WINDOWS: { mins: number; label: string; long: string }[] = [
  { mins: 5, label: "5m", long: "5 minutes" },
  { mins: 60, label: "1h", long: "hour" },
  { mins: 480, label: "8h", long: "8 hours" },
  { mins: 1440, label: "24h", long: "24 hours" },
  { mins: 43200, label: "30d", long: "30 days" },
];
const toOnlineWindow = (s: string): number => (ONLINE_WINDOWS.some((w) => w.mins === Number(s)) ? Number(s) : 5);

type Role = "platform_admin" | "namespace_admin" | "namespace_member";
interface Mapping { id: string; role: Role; namespaceId: string | null; groupId: string; groupDisplayName: string; groupExternalId: string }
interface Namespace { id: string; slug: string; displayName: string; requireReview: boolean; maintainerContact: string | null; mappings: Mapping[] }
interface Group { id: string; externalId: string; displayName: string }
interface ScimStatus { groupCount: number; userCount: number; lastGroupSyncAt: string | null }
interface Config { namespaces: Namespace[]; namespacesTotal: number; platformAdminMappings: Mapping[]; groups: Group[]; scim: ScimStatus; settings: { proposalsOpen: boolean; dateFormat: "eu" | "us"; duplicateEnforcement: "block" | "warn"; maxBundleBytes: number; uploadChunkBytes: number; chatPollIntervals: number[]; installMaxTtlMonths: number; maxFeaturedSkills: number } }

// Selectable max hosted-bundle upload sizes — must match BUNDLE_SIZE_OPTIONS in lib/settings.
const BUNDLE_SIZE_CHOICES: { bytes: number; label: string }[] = [
  { bytes: 100 * 1024, label: "100 KB" },
  { bytes: 1024 * 1024, label: "1 MB" },
  { bytes: 10 * 1024 * 1024, label: "10 MB" },
  { bytes: 50 * 1024 * 1024, label: "50 MB" },
  { bytes: 100 * 1024 * 1024, label: "100 MB" },
  { bytes: 200 * 1024 * 1024, label: "200 MB" },
  { bytes: 1024 * 1024 * 1024, label: "1 GB" },
];

const NS_PAGE = 100;

// Every Administration card is collapsible (§5). The page owns each card's open/closed state,
// persists it per-card (localStorage), and drives Expand all / Collapse all. Cards start collapsed.
const ADMIN_CARD_IDS = [
  "contribution", "duplicates", "upload", "dateformat", "chatpoll", "installttl", "featuredcap",
  "systembanner", "email", "scim", "platformadmins", "maintenance", "deleteuser", "online", "namespaces",
] as const;
type CardId = (typeof ADMIN_CARD_IDS)[number];

function useAdminCards() {
  // Safe to read prefs in the initializer — the cards only render after the data gate (client-side),
  // so a stored value can't cause a hydration mismatch (see lib/prefs.ts).
  const [open, setOpen] = useState<Record<CardId, boolean>>(() => {
    const init = {} as Record<CardId, boolean>;
    for (const id of ADMIN_CARD_IDS) init[id] = readPref(adminCardPrefKey(id), "0") === "1";
    return init;
  });
  const toggle = useCallback((id: CardId) => setOpen((m) => {
    const next = !m[id];
    writePref(adminCardPrefKey(id), next ? "1" : "0");
    return { ...m, [id]: next };
  }), []);
  const setAll = useCallback((v: boolean) => setOpen(() => {
    const next = {} as Record<CardId, boolean>;
    for (const id of ADMIN_CARD_IDS) { next[id] = v; writePref(adminCardPrefKey(id), v ? "1" : "0"); }
    return next;
  }), []);
  const allOpen = ADMIN_CARD_IDS.every((id) => open[id]);
  return { open, toggle, setAll, allOpen };
}

const field = { padding: "8px 11px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 13.5 } as const;
const label = { display: "block", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 6 } as const;

// Identity-sync (SCIM) diagnostics: shows whether Entra has provisioned groups/users, since the
// role-mapping pickers can only list groups SCIM has synced. When no groups are present it explains
// the likely cause — distinguishing "users sync but Group provisioning is off" from "nothing synced
// at all" — so an admin can self-diagnose instead of staring at an empty picker (§5).
function ScimSyncStatus({ scim, open, onToggle }: { scim: ScimStatus; open: boolean; onToggle: () => void }) {
  const fmt = useDateFmt();
  // The ok/warn pills ride in the header (as the card accessory) so a broken sync stays visible
  // even while the card is collapsed (answer 2a, §5).
  const pills = (
    <>
      <Pill tone={scim.groupCount > 0 ? "ok" : "warn"}>{scim.groupCount} {scim.groupCount === 1 ? "group" : "groups"} synced</Pill>
      <Pill tone={scim.userCount > 0 ? "ok" : "warn"}>{scim.userCount} {scim.userCount === 1 ? "user" : "users"} synced</Pill>
    </>
  );
  return (
    <CollapsibleCard cardId="scim" title="Identity sync (SCIM)" accessory={pills} open={open} onToggle={onToggle}>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
        The role mappings below bind Entra groups to roles, so the group pickers can only list groups Entra has provisioned to skilly over SCIM.
      </p>
      {scim.lastGroupSyncAt && (
        <div className="muted" style={{ fontSize: 12.5, marginBottom: scim.groupCount === 0 ? 14 : 0 }}>last group sync {fmt.dateTime(scim.lastGroupSyncAt)}</div>
      )}
      {scim.groupCount === 0 && (
        <div style={{ fontSize: 13, color: "var(--warn)", background: "var(--warn-soft)", padding: "10px 12px", borderRadius: "var(--radius-sm)", lineHeight: 1.5 }}>
          {scim.userCount > 0 ? (
            <>Users are syncing, but <strong>no Entra groups have been provisioned</strong> — so there are none to map. In Entra → your skilly Enterprise app → <strong>Provisioning</strong>, assign the security groups to the app, make sure the scope includes <strong>groups</strong> (not “users only”) and the <strong>Groups</strong> mapping is enabled, then run “Provision on demand” and reload this page.</>
          ) : (
            <>Nothing has synced from Entra yet. Confirm <strong>Provisioning is On</strong> and that the SCIM <strong>Tenant URL</strong> points at the worker’s <span className="mono">/scim/v2</span> with a <strong>Secret Token</strong> matching the worker’s <span className="mono">SCIM_BEARER_TOKEN</span>; then assign users and groups and provision.</>
          )}
        </div>
      )}
    </CollapsibleCard>
  );
}

// Smart-polling cadence (§24): a comma-separated set of seconds. The smallest is the floor — the
// open-thread interval and the conversation-list backoff's reset target — and the list walks up the
// set while quiet. Saved through /api/admin/settings, which parses/dedupes/sorts and bounds-checks.
function ChatPollSetting({ value, busy, call, open, onToggle }: { value: number[]; busy: boolean; call: (input: RequestInfo, init: RequestInit) => Promise<boolean>; open: boolean; onToggle: () => void }) {
  const saved = value.join(", ");
  const [draft, setDraft] = useState(saved);
  // Re-sync the field to the server's normalised value after a successful save (or external change).
  useEffect(() => { setDraft(saved); }, [saved]);
  const dirty = draft.trim() !== saved;
  const onSave = async () => {
    const ok = await call(`/api/admin/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatPollIntervals: draft }) });
    if (!ok) setDraft(draft); // keep the user's text on a validation error (the banner shows why)
  };
  return (
    <CollapsibleCard cardId="chatpoll" title="Chat refresh cadence" summary={`${saved}s`} open={open} onToggle={onToggle}>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
        How often the in-app messages refresh (smart polling — no WebSockets, so it works behind any corporate proxy).
        Enter a comma-separated set of seconds. The smallest is the floor: an open conversation refreshes at that rate,
        and the message list starts there too, then eases off through the larger values while quiet — snapping back to
        the floor the moment a new message arrives or you reply. Primes are the default so the polls rarely line up with
        other requests. Saved as whole seconds (1–3600), de-duplicated and sorted; takes effect on each client’s next load.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <input
          aria-label="Chat poll intervals (comma-separated seconds)"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && dirty && !busy) void onSave(); }}
          placeholder="7, 11, 17, 19, 29, 41, 53"
          style={{ ...field, fontFamily: "var(--font-mono)", flex: 1, minWidth: 260, maxWidth: 420 }}
        />
        <button className="btn btn-sm" disabled={busy || !dirty} onClick={() => void onSave()}>Save</button>
      </div>
    </CollapsibleCard>
  );
}

// Install URL expiry horizon (§23): how far ahead (calendar months) a user may set an install
// command's expiry. A positive integer 1–120, default 12. Bounds the ExpiryPicker; the mint +
// extend endpoints re-validate. Mirrors the ChatPollSetting save UX.
// Chunked-upload chunk size (§6): bundles larger than this upload in per-request pieces of this
// size (with a progress bar), so proxy body-size ceilings can't cut a large upload. A whole
// number of MB, 1–50, default 5. Lives inside the "Maximum upload size" card; mirrors the
// InstallTtlSetting save UX (free-form number + Save, server validates + banner shows errors).
function UploadChunkSetting({ valueBytes, busy, call }: { valueBytes: number; busy: boolean; call: (input: RequestInfo, init: RequestInit) => Promise<boolean> }) {
  const saved = String(Math.round(valueBytes / (1024 * 1024)));
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  const dirty = draft.trim() !== saved && draft.trim() !== "";
  const onSave = async () => {
    const ok = await call(`/api/admin/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ uploadChunkMb: Number(draft.trim()) }) });
    if (!ok) setDraft(draft); // keep the user's text on a validation error (the banner shows why)
  };
  return (
    <div style={{ marginTop: 18 }}>
      <span style={label}>Upload chunk size</span>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 10 }}>
        Bundles larger than this upload in pieces of this size (with a progress bar), so a proxy’s
        request-size limit can’t cut off a large upload. Whole megabytes, 1–50; default 5. Uploads
        already in progress keep the size they started with.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <input
          type="number"
          min={1}
          max={50}
          step={1}
          aria-label="Upload chunk size (MB)"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && dirty && !busy) void onSave(); }}
          style={{ ...field, fontFamily: "var(--font-mono)", width: 110 }}
        />
        <span className="muted" style={{ fontSize: 13.5 }}>MB</span>
        <button className="btn btn-sm" disabled={busy || !dirty} onClick={() => void onSave()}>Save</button>
      </div>
    </div>
  );
}

function InstallTtlSetting({ value, busy, call, open, onToggle }: { value: number; busy: boolean; call: (input: RequestInfo, init: RequestInit) => Promise<boolean>; open: boolean; onToggle: () => void }) {
  const saved = String(value);
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  const dirty = draft.trim() !== saved && draft.trim() !== "";
  const onSave = async () => {
    const n = Number(draft.trim());
    const ok = await call(`/api/admin/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ installMaxTtlMonths: n }) });
    if (!ok) setDraft(draft); // keep the user's text on a validation error (the banner shows why)
  };
  return (
    <CollapsibleCard cardId="installttl" title="Install URL expiry" summary={`${value} ${value === 1 ? "month" : "months"}`} open={open} onToggle={onToggle}>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
        How far in the future a user may set an install command’s expiry date — a whole number of calendar months (1–120,
        default 12). This bounds the date picker when minting or extending an install; “Never” stays available and is
        unaffected. Lowering it never shortens install URLs already minted — it only applies to new ones.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <input
          type="number"
          min={1}
          max={120}
          step={1}
          aria-label="Install URL expiry (months)"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && dirty && !busy) void onSave(); }}
          style={{ ...field, fontFamily: "var(--font-mono)", width: 110 }}
        />
        <span className="muted" style={{ fontSize: 13.5 }}>months</span>
        <button className="btn btn-sm" disabled={busy || !dirty} onClick={() => void onSave()}>Save</button>
      </div>
    </CollapsibleCard>
  );
}

// Featured-skills cap (§7): how many skills may be spotlighted in the home page's "Featured skills"
// section at once. A whole number 1–50, default 10. Enforced when an admin spotlights a skill;
// lowering it never un-features skills already pinned. Mirrors the InstallTtlSetting save UX.
function FeaturedCapSetting({ value, busy, call, open, onToggle }: { value: number; busy: boolean; call: (input: RequestInfo, init: RequestInit) => Promise<boolean>; open: boolean; onToggle: () => void }) {
  const saved = String(value);
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  const dirty = draft.trim() !== saved && draft.trim() !== "";
  const onSave = async () => {
    const n = Number(draft.trim());
    const ok = await call(`/api/admin/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxFeaturedSkills: n }) });
    if (!ok) setDraft(draft); // keep the user's text on a validation error (the banner shows why)
  };
  return (
    <CollapsibleCard cardId="featuredcap" title="Featured skills cap" summary={`${value} ${value === 1 ? "skill" : "skills"}`} open={open} onToggle={onToggle}>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
        How many skills can be spotlighted in the home page’s <strong>Featured skills</strong> section at once — a whole
        number (1–50, default 10). When the cap is reached, spotlighting another skill is blocked until one is removed.
        Lowering it never un-features skills already pinned; it only blocks new ones until the count drops back under.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <input
          type="number"
          min={1}
          max={50}
          step={1}
          aria-label="Featured skills cap"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && dirty && !busy) void onSave(); }}
          style={{ ...field, fontFamily: "var(--font-mono)", width: 110 }}
        />
        <span className="muted" style={{ fontSize: 13.5 }}>skills</span>
        <button className="btn btn-sm" disabled={busy || !dirty} onClick={() => void onSave()}>Save</button>
      </div>
    </CollapsibleCard>
  );
}

export default function AdminPage() {
  const [data, setData] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [nsLoading, setNsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Namespace search/filter — server-side (the list is paginated, so client-side
  // filtering of the loaded page would silently miss matches beyond it).
  const [nsQ, setNsQ] = useState("");
  const [nsQDeb, setNsQDeb] = useState("");
  const [nsReview, setNsReview] = useState<"" | "required" | "optional">("");
  const [nsTick, setNsTick] = useState(0); // bumped after mutations to re-apply the active filter
  // Every card is collapsible (§5): collapsed by default, remembered per browser, driven by the
  // Expand all / Collapse all control below.
  const cards = useAdminCards();
  useEffect(() => {
    const t = setTimeout(() => setNsQDeb(nsQ.trim()), 300);
    return () => clearTimeout(t);
  }, [nsQ]);
  const filterActive = nsQDeb !== "" || nsReview !== "";

  // Initial load / post-mutation reload. `nsLimit` re-fetches every namespace the user has
  // already scrolled into view in one request, so mutations don't collapse the list.
  const reload = useCallback(async (nsLimit = NS_PAGE) => {
    try {
      const r = await fetch(`/api/admin/namespaces?nsLimit=${nsLimit}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
      setData((await r.json()) as Config);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const nsFilterQs = useCallback((offset: number) => {
    const qs = new URLSearchParams({ offset: String(offset), list: "1" });
    if (nsQDeb) qs.set("q", nsQDeb);
    if (nsReview) qs.set("review", nsReview);
    return qs;
  }, [nsQDeb, nsReview]);

  // Re-fetch page 0 of the namespace list whenever the search/filter changes (or after a
  // mutation while a filter is active). Skips the very first render — the initial config
  // load already brings the unfiltered first page.
  const firstNsFetch = useRef(true);
  useEffect(() => {
    if (firstNsFetch.current) {
      firstNsFetch.current = false;
      return;
    }
    let live = true;
    setNsLoading(true);
    fetch(`/api/admin/namespaces?${nsFilterQs(0)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { namespaces: Namespace[]; namespacesTotal: number } | null) => {
        if (live && j) setData((prev) => (prev ? { ...prev, namespaces: j.namespaces, namespacesTotal: j.namespacesTotal } : prev));
      })
      .catch(() => {})
      .finally(() => live && setNsLoading(false));
    return () => {
      live = false;
    };
  }, [nsFilterQs, nsTick]);

  // Infinite scroll: append the next slug-ordered page (respecting the active search/filter).
  const loadMoreNs = useCallback(async () => {
    if (!data) return;
    setNsLoading(true);
    try {
      const r = await fetch(`/api/admin/namespaces?${nsFilterQs(data.namespaces.length)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { namespaces: Namespace[] };
      setData((prev) => (prev ? { ...prev, namespaces: [...prev.namespaces, ...j.namespaces] } : prev));
    } finally {
      setNsLoading(false);
    }
  }, [data, nsFilterQs]);

  const call = async (input: RequestInfo, init: RequestInit): Promise<boolean> => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(input, init);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      await reload(Math.max(NS_PAGE, data?.namespaces.length ?? 0));
      // reload() returns the unfiltered list — re-apply the active filter on top of it.
      if (filterActive) setNsTick((t) => t + 1);
      return true;
    } catch (e) {
      setMsg(String((e as Error).message));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    const denied = /platform admin/i.test(error);
    return <EmptyState icon={denied ? "🔒" : "⚠"} title={denied ? "Platform admins only" : "Couldn’t load admin config"} hint={error} />;
  }
  if (loading || !data) return <div className="skeleton" style={{ height: 260, borderRadius: "var(--radius)" }} />;

  const groups = data.groups;

  return (
    <div style={{ maxWidth: 940 }}>
      <ScrollToTop />
      <div className="page-head reveal">
        <div className="eyebrow">Platform administration</div>
        <h1 className="page-title">Run the platform.</h1>
        <p className="page-sub">
          Every platform-wide control lives on this page. Expand a card to work with it.
        </p>
      </div>

      {/* Expand all / Collapse all — sets & persists every card's open state at once (§5). */}
      <div className="admin-bulk reveal">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => cards.setAll(!cards.allOpen)}>
          {cards.allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>

      {msg && <div className="card card-pad reveal" style={{ marginBottom: 20, color: "var(--danger)" }}>{msg}</div>}

      {/* Contribution policy */}
      <CollapsibleCard
        cardId="contribution"
        title="Contribution policy"
        summary={data.settings.proposalsOpen ? "open to all" : "members only"}
        open={cards.open.contribution}
        onToggle={() => cards.toggle("contribution")}
      >
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>Controls who may submit skill proposals across the registry.</p>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => call(`/api/admin/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalsOpen: !data.settings.proposalsOpen }) })}
          >
            Proposals: {data.settings.proposalsOpen ? "open to all" : "members only"}
          </button>
          {data.settings.proposalsOpen
            ? <Pill tone="ok">any signed-in user can propose</Pill>
            : <Pill tone="warn">only namespace members &amp; admins</Pill>}
        </div>
      </CollapsibleCard>

      {/* Duplicate proposals */}
      <CollapsibleCard
        cardId="duplicates"
        title="Duplicate proposals"
        summary={data.settings.duplicateEnforcement === "block" ? "block" : "warn"}
        open={cards.open.duplicates}
        onToggle={() => cards.toggle("duplicates")}
      >
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
          When someone proposes a skill that already exists in the catalog — a pointer to the same repo/folder, or a byte-identical upload — what should happen? They’re always pointed at proposing a new version instead.
        </p>
        <div className="sort-toggle" role="group" aria-label="Duplicate enforcement">
          {([
            ["block", "Block", "refuse the duplicate"],
            ["warn", "Warn", "allow, but flag it"],
          ] as const).map(([v, lbl, hint]) => (
            <button
              key={v}
              type="button"
              className={`sort-opt${data.settings.duplicateEnforcement === v ? " sort-on" : ""}`}
              disabled={busy}
              aria-pressed={data.settings.duplicateEnforcement === v}
              title={hint}
              onClick={() => data.settings.duplicateEnforcement !== v && call(`/api/admin/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ duplicateEnforcement: v }) })}
            >
              {lbl} <span className="muted mono" style={{ fontSize: 11 }}>{hint}</span>
            </button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
          {data.settings.duplicateEnforcement === "block"
            ? "Hard-block: the proposer can’t submit a duplicate; they’re redirected to propose a new version."
            : "Soft-warn: the duplicate is allowed through with a notice, and reviewers are alerted on the review page."}{" "}
          A skill with the same name in the same namespace is always refused, regardless of this setting.
        </p>
      </CollapsibleCard>

      {/* Max upload size + chunk size (§6) */}
      <CollapsibleCard
        cardId="upload"
        title="Maximum upload size"
        summary={`${BUNDLE_SIZE_CHOICES.find((c) => c.bytes === data.settings.maxBundleBytes)?.label ?? ""} · ${Math.round(data.settings.uploadChunkBytes / (1024 * 1024))} MB chunks`}
        open={cards.open.upload}
        onToggle={() => cards.toggle("upload")}
      >
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
          The largest hosted-skill bundle a contributor may upload. Larger uploads are rejected, and the limit is shown on the propose form.
        </p>
        <div className="select-wrap" style={{ maxWidth: 220 }}>
          <select
            style={{ width: "100%", padding: "10px 38px 10px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-mono)", fontSize: 14 }}
            value={data.settings.maxBundleBytes}
            disabled={busy}
            onChange={(e) => call(`/api/admin/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxBundleBytes: Number(e.target.value) }) })}
          >
            {BUNDLE_SIZE_CHOICES.map((c) => (
              <option key={c.bytes} value={c.bytes}>{c.label}</option>
            ))}
          </select>
          <svg className="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
        <UploadChunkSetting valueBytes={data.settings.uploadChunkBytes} busy={busy} call={call} />
      </CollapsibleCard>

      {/* Date & time format */}
      <CollapsibleCard
        cardId="dateformat"
        title="Date & time format"
        summary={data.settings.dateFormat.toUpperCase()}
        open={cards.open.dateformat}
        onToggle={() => cards.toggle("dateformat")}
      >
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
          How timestamps display across the registry. Times always render in each viewer’s own timezone — this only picks the style.
        </p>
        <div className="sort-toggle" role="group" aria-label="Date and time format">
          {([
            ["eu", "EU", "dd/mm/yyyy · 24h"],
            ["us", "US", "mm/dd/yyyy · AM/PM"],
          ] as const).map(([v, lbl, hint]) => (
            <button
              key={v}
              type="button"
              className={`sort-opt${data.settings.dateFormat === v ? " sort-on" : ""}`}
              disabled={busy}
              aria-pressed={data.settings.dateFormat === v}
              title={hint}
              onClick={() => data.settings.dateFormat !== v && call(`/api/admin/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dateFormat: v }) })}
            >
              {lbl} <span className="muted mono" style={{ fontSize: 11 }}>{hint}</span>
            </button>
          ))}
        </div>
      </CollapsibleCard>

      {/* Chat polling cadence */}
      <ChatPollSetting value={data.settings.chatPollIntervals} busy={busy} call={call} open={cards.open.chatpoll} onToggle={() => cards.toggle("chatpoll")} />

      <InstallTtlSetting value={data.settings.installMaxTtlMonths} busy={busy} call={call} open={cards.open.installttl} onToggle={() => cards.toggle("installttl")} />

      <FeaturedCapSetting value={data.settings.maxFeaturedSkills} busy={busy} call={call} open={cards.open.featuredcap} onToggle={() => cards.toggle("featuredcap")} />

      {/* System message (§27) — header announcement banner */}
      <SystemBannerCard open={cards.open.systembanner} onToggle={() => cards.toggle("systembanner")} />

      {/* Email notifications (§12) — collapsible like every card */}
      <EmailCard open={cards.open.email} onToggle={() => cards.toggle("email")} />

      {/* Identity sync (SCIM) diagnostics — explains an empty group picker before the mappings below. */}
      <ScimSyncStatus scim={data.scim} open={cards.open.scim} onToggle={() => cards.toggle("scim")} />

      {/* Platform admins */}
      <CollapsibleCard
        cardId="platformadmins"
        title="Platform admins"
        summary={`${data.platformAdminMappings.length} ${data.platformAdminMappings.length === 1 ? "group" : "groups"}`}
        open={cards.open.platformadmins}
        onToggle={() => cards.toggle("platformadmins")}
      >
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>Groups granted org-wide administration (govern global, approve anywhere, manage this screen).</p>
        <MappingList mappings={data.platformAdminMappings} onRemove={(id) => call(`/api/admin/role-mappings/${id}`, { method: "DELETE" })} busy={busy} />
        <AddMapping
          groups={groups}
          fixedRole="platform_admin"
          onAdd={(groupId) => call(`/api/admin/role-mappings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId, namespaceId: null, role: "platform_admin" }) })}
          busy={busy}
        />
      </CollapsibleCard>

      {/* Maintenance / background jobs */}
      <MaintenanceCard open={cards.open.maintenance} onToggle={() => cards.toggle("maintenance")} />

      {/* Delete User Info */}
      <DeleteUserInfo open={cards.open.deleteuser} onToggle={() => cards.toggle("deleteuser")} />

      {/* Currently online */}
      <OnlineUsers open={cards.open.online} onToggle={() => cards.toggle("online")} />

      {/* Namespaces — collapsible like every card (§5). The body stays mounted while collapsed, so
          loaded pages and the active search/filter survive a collapse (answer 3c). */}
      <CollapsibleCard
        cardId="namespaces"
        title="Namespaces"
        summary={formatCount(data.namespacesTotal)}
        open={cards.open.namespaces}
        onToggle={() => cards.toggle("namespaces")}
      >
        {/* Server-side search + review-policy filter (the list is paginated). */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
              <input
                style={{ ...field, flex: 1, minWidth: 200 }}
                value={nsQ}
                onChange={(e) => setNsQ(e.target.value)}
                placeholder="Search namespaces by slug or name…"
                aria-label="Search namespaces"
              />
              {([
                ["", "All"],
                ["required", "Moderated"],
                ["optional", "Direct publish"],
              ] as const).map(([v, lbl]) => (
                <button key={v || "all"} type="button" className={`facet${nsReview === v ? " facet-on" : ""}`} onClick={() => setNsReview(v)}>
                  {lbl}
                </button>
              ))}
              {filterActive && (
                <button className="btn-ghost mono" style={{ fontSize: 12 }} onClick={() => { setNsQ(""); setNsReview(""); }}>
                  ✕ clear
                </button>
              )}
              <span className="muted mono" style={{ fontSize: 12, marginLeft: "auto" }}>{data.namespaces.length} of {data.namespacesTotal} shown</span>
            </div>

            <CreateNamespace
              onCreate={(b) => call(`/api/admin/namespaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })}
              busy={busy}
            />

            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 18 }}>
              {data.namespaces.length === 0 && filterActive && (
                <div className="card card-pad muted">No namespaces match your search.</div>
              )}
              {data.namespaces.map((ns) => (
                <section key={ns.id} className="card card-pad reveal">
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span className="ns" style={{ fontSize: 17 }}>@{ns.slug}</span>
                    <span className="muted">{ns.displayName}</span>
                    <span style={{ flex: 1 }} />
                    <button
                      className="btn btn-sm"
                      disabled={busy || ns.slug === "global"}
                      title={ns.slug === "global" ? "global always requires review" : ""}
                      onClick={() => call(`/api/admin/namespaces/${ns.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ requireReview: !ns.requireReview }) })}
                    >
                      Review: {ns.requireReview ? "required" : "optional"}
                    </button>
                    {ns.requireReview ? <Pill tone="warn">moderated</Pill> : <Pill tone="ok">direct publish</Pill>}
                  </div>

                  <MaintainerEditor ns={ns} onSave={(v) => call(`/api/admin/namespaces/${ns.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maintainerContact: v }) })} busy={busy} />

                  <hr className="divider" style={{ margin: "16px 0" }} />
                  <div className="nav-label" style={{ padding: "0 0 10px" }}>Role mappings</div>
                  <MappingList mappings={ns.mappings} onRemove={(id) => call(`/api/admin/role-mappings/${id}`, { method: "DELETE" })} busy={busy} />
                  <AddMapping
                    groups={groups}
                    namespaceRoles
                    onAdd={(groupId, role) => call(`/api/admin/role-mappings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId, namespaceId: ns.id, role }) })}
                    busy={busy}
                  />
                </section>
              ))}
            </div>
        <LoadMoreSentinel hasMore={data.namespaces.length < data.namespacesTotal} loading={nsLoading} onLoadMore={() => void loadMoreNs()} />
      </CollapsibleCard>
    </div>
  );
}

function MappingList({ mappings, onRemove, busy }: { mappings: Mapping[]; onRemove: (id: string) => void; busy: boolean }) {
  if (mappings.length === 0) return <div className="muted" style={{ fontSize: 13.5, marginBottom: 10 }}>No groups mapped yet.</div>;
  return (
    <div className="rows" style={{ marginBottom: 12 }}>
      {mappings.map((m) => (
        <div className="row mapping-row" key={m.id}>
          <div className="grow">
            <div className="ttl" title={m.groupDisplayName}>{m.groupDisplayName}</div>
            <div className="sub mono" style={{ fontSize: 11 }} title={m.groupExternalId}>{m.groupExternalId}</div>
          </div>
          <span className="chip">{m.role.replace("_", " ")}</span>
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onRemove(m.id)} title="remove mapping">✕</button>
        </div>
      ))}
    </div>
  );
}

function AddMapping({ groups, onAdd, busy, fixedRole, namespaceRoles }: { groups: Group[]; onAdd: (groupId: string, role: Role) => void; busy: boolean; fixedRole?: Role; namespaceRoles?: boolean }) {
  const [groupId, setGroupId] = useState("");
  const [role, setRole] = useState<Role>(namespaceRoles ? "namespace_member" : (fixedRole ?? "namespace_member"));
  return (
    <div className="add-mapping" style={{ display: "flex", gap: 9, flexWrap: "wrap", alignItems: "center" }}>
      <select style={field} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
        <option value="">Select Entra group…</option>
        {groups.map((g) => <option key={g.id} value={g.id}>{g.displayName}</option>)}
      </select>
      {namespaceRoles && (
        <select style={field} value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="namespace_member">member</option>
          <option value="namespace_admin">admin</option>
        </select>
      )}
      <button className="btn btn-sm" disabled={busy || !groupId} onClick={() => onAdd(groupId, fixedRole ?? role)}>+ Add mapping</button>
      {groups.length === 0 && <span className="muted" style={{ fontSize: 12 }}>No synced groups yet — see “Identity sync (SCIM)” above.</span>}
    </div>
  );
}

function MaintainerEditor({ ns, onSave, busy }: { ns: Namespace; onSave: (v: string) => Promise<boolean>; busy: boolean }) {
  const [v, setV] = useState(ns.maintainerContact ?? "");
  const [saved, setSaved] = useState(false);
  // User typeahead: search as you type and let the admin pick a user (fills their email), while the
  // field stays free-text so a shared mailbox / distribution list is still allowed. Reuses the
  // platform-admin user search (same backend as Delete User Info).
  const [results, setResults] = useState<{ userId: string; displayName: string; email: string }[]>([]);
  const [open, setOpen] = useState(false);
  // Keep the field authoritative to the saved value once a save (and reload) lands.
  useEffect(() => { setV(ns.maintainerContact ?? ""); }, [ns.maintainerContact]);
  useEffect(() => {
    if (v.trim().length < 3) { setResults([]); return; }
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/admin/users/search?q=${encodeURIComponent(v.trim())}`);
        if (r.ok && live) setResults((await r.json()).users ?? []);
      } catch { /* ignore transient search errors */ }
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [v]);
  const save = async () => {
    if (await onSave(v.trim())) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };
  return (
    <div style={{ marginTop: 14 }}>
      <label style={label}>Maintainer contact</label>
      <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 360 }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
          <input
            style={{ ...field, width: "100%" }}
            value={v}
            onChange={(e) => { setV(e.target.value); setOpen(true); }}
            onFocus={() => { if (results.length) setOpen(true); }}
            placeholder="search a user, or type a team email…"
            autoComplete="off"
          />
          {open && results.length > 0 && (
            <ul className="search-ac" role="listbox">
              {results.map((u) => (
                <li key={u.userId} role="option" aria-selected={false}>
                  <button type="button" className="search-ac-item" onClick={() => { setV(u.email); setOpen(false); }}>
                    <span className="search-ac-title">{u.displayName}</span>
                    <span className="search-ac-sub mono">{u.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className="btn btn-sm" disabled={busy || v.trim() === (ns.maintainerContact ?? "")} onClick={save}>Save</button>
        {saved && <span style={{ fontSize: 12, color: "var(--ok)", whiteSpace: "nowrap", alignSelf: "center" }}>✓ Saved</span>}
      </div>
    </div>
  );
}

function CreateNamespace({ onCreate, busy }: { onCreate: (b: { slug: string; displayName: string; requireReview: boolean }) => void; busy: boolean }) {
  const [slug, setSlug] = useState("");
  const [displayName, setName] = useState("");
  const [requireReview, setReq] = useState(true);
  return (
    <div className="card card-pad" style={{ background: "var(--surface-2)", borderStyle: "dashed" }}>
      <div className="nav-label" style={{ padding: "0 0 10px" }}>Create a namespace</div>
      <div className="create-ns-form">
        <input style={{ ...field, fontFamily: "var(--font-mono)" }} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="team-a" />
        <input style={{ ...field, flex: 1, minWidth: 180 }} value={displayName} onChange={(e) => setName(e.target.value)} placeholder="Team A" />
        <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={requireReview} onChange={(e) => setReq(e.target.checked)} /> require review
        </label>
        <button className="btn btn-primary btn-sm" disabled={busy || !slug || !displayName} onClick={() => onCreate({ slug, displayName, requireReview })}>Create</button>
      </div>
    </div>
  );
}

interface OnlineUser { userId: string; displayName: string; email: string; avatar: string | null; lastSeen: string; lastSeenPage: string | null }
const ONLINE_PAGE = 100;

/** Everyone shown is active within the selected window, which can now reach 24h — so up to hours. */
function activeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 15) return "active just now";
  if (s < 60) return `active ${s}s ago`;
  if (s < 3600) return `active ${Math.floor(s / 60)}m ago`;
  return `active ${Math.floor(s / 3600)}h ago`;
}

// Platform-admin "Currently online" section (SKILLY_SPEC.md §4). Presence is activity-window
// based (last_seen within the selected window, default 5 min); reuses the maintainer card. Search + infinite scroll, plus a
// 60s visibility-aware poll that always refreshes the count but only refreshes the list when it's
// safe (no active search and the list hasn't been scrolled past page 1) so it never yanks the view.
function OnlineUsers({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [users, setUsers] = useState<OnlineUser[] | null>(null);
  const [total, setTotal] = useState(0);
  // Rolling-window activity counts (§4) — piggyback on this card's existing poll (see below).
  const [active, setActive] = useState<{ dau: number; wau: number; mau: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [me, setMe] = useState<{ userId: string | null; devAuth?: boolean } | null>(null);
  const [reaching, setReaching] = useState<string | null>(null);
  // Daily-active-users trend chart (§4) — its own range, remembered across visits like every
  // other chart window in the app. Changes at most once a day (the worker snapshot), so it's
  // fetched on mount/range-change only — no polling needed.
  const [dauRange, setDauRange] = useState<DauRange>(() => toDauRange(readPref(PREF_DAU_RANGE, "30")));
  const pickDauRange = (r: DauRange) => { setDauRange(r); writePref(PREF_DAU_RANGE, String(r)); };
  const [dauSeries, setDauSeries] = useState<{ bucket: "day" | "week" | "month"; points: { date: string; count: number }[] } | null>(null);
  // "Online" window (§4) — a per-admin view preference, remembered like the chart ranges.
  const [winMins, setWinMins] = useState<number>(() => toOnlineWindow(readPref(PREF_ONLINE_WINDOW, "5")));
  const pickWindow = (m: number) => { setWinMins(m); writePref(PREF_ONLINE_WINDOW, String(m)); };

  useEffect(() => { fetch("/api/me").then((r) => (r.ok ? r.json() : null)).then((j) => setMe(j)).catch(() => {}); }, []);
  useEffect(() => { const t = setTimeout(() => setQDeb(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    let live = true;
    setDauSeries(null);
    fetch(`/api/admin/users/active-series?range=${dauRange}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { bucket: "day" | "week" | "month"; points: { date: string; count: number }[] } | null) => { if (live && j) setDauSeries(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [dauRange]);

  const qs = useCallback((offset: number) => {
    const p = new URLSearchParams({ offset: String(offset), limit: String(ONLINE_PAGE), window: String(winMins) });
    if (qDeb) p.set("q", qDeb);
    return p.toString();
  }, [qDeb, winMins]);

  // (Re)load page 0 whenever the search or the online window changes.
  useEffect(() => {
    let live = true;
    setLoading(true);
    fetch(`/api/admin/users/online?${qs(0)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { users: OnlineUser[]; total: number; dau: number; wau: number; mau: number } | null) => {
        if (live && j) { setUsers(j.users); setTotal(j.total); setActive({ dau: j.dau, wau: j.wau, mau: j.mau }); }
      })
      .catch(() => {})
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [qs]);

  const loadMore = useCallback(async () => {
    if (!users) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/users/online?${qs(users.length)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { users: OnlineUser[]; total: number; dau: number; wau: number; mau: number };
      setUsers((prev) => (prev ? [...prev, ...j.users] : j.users));
      setTotal(j.total);
      setActive({ dau: j.dau, wau: j.wau, mau: j.mau });
    } finally { setLoading(false); }
  }, [users, qs]);

  // 60s poll: counts always; list only when safe (no search, not scrolled past page 1).
  useEffect(() => {
    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const r = await fetch(`/api/admin/users/online?${qs(0)}`);
        if (!r.ok) return;
        const j = (await r.json()) as { users: OnlineUser[]; total: number; dau: number; wau: number; mau: number };
        setTotal(j.total);
        setActive({ dau: j.dau, wau: j.wau, mau: j.mau });
        setUsers((prev) => (!qDeb && (prev?.length ?? 0) <= ONLINE_PAGE ? j.users : prev));
      } catch { /* best-effort refresh */ }
    };
    const id = setInterval(tick, 60000);
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [qs, qDeb]);

  // "Reach out": open (or reuse) a 1:1 direct conversation in the messages menu.
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

  return (
    <CollapsibleCard
      cardId="online"
      title="Currently online"
      summary={`${total} ${total === 1 ? "user" : "users"}`}
      open={open}
      onToggle={onToggle}
    >
      {/* Active-users trend (§4): one point per day, snapshotted once daily by the worker — a
          history, unlike the live rolling counts below. 90d/All roll the daily counts up into
          weekly/monthly averages for readability; a fresh deployment simply shows a short,
          growing line until enough days have accumulated (no back-filled/manufactured data). */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <span className="muted mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>Active users</span>
        <div className="sort-toggle" role="group" aria-label="Chart range">
          {DAU_RANGES.map((r) => (
            <button key={String(r.key)} type="button" className={`sort-opt${dauRange === r.key ? " sort-on" : ""}`} onClick={() => pickDauRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {dauSeries === null ? (
        <div className="skeleton" style={{ height: 180, borderRadius: "var(--radius)", marginBottom: 16 }} />
      ) : dauSeries.points.length === 0 ? (
        <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>No history yet — the daily snapshot job hasn't run.</div>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <ActiveUsersChart points={dauSeries.points} bucket={dauSeries.bucket} />
        </div>
      )}

      {/* Rolling-window activity (§4) — live counts off the same last_seen signal as the list
          below, not a historical trend: this is "how many right now", not "how many on a past
          date". Each window is a distinct-user count over the trailing period, refreshed on the
          same 60s poll as the online list (no separate fetch). */}
      <div style={{ display: "flex", gap: 20, marginBottom: 16, paddingBottom: 14, borderBottom: "1px solid var(--line)" }}>
        {([
          ["DAU", "last 24h", active?.dau],
          ["WAU", "last 7d", active?.wau],
          ["MAU", "last 30d", active?.mau],
        ] as const).map(([label, caption, n]) => (
          <div key={label}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1 }}>
              {n == null ? <span className="skeleton" style={{ display: "inline-block", width: 30, height: 22, borderRadius: 4 }} /> : n}
            </div>
            <div className="muted mono" style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 4 }}>
              {label} <span style={{ opacity: 0.7 }}>· {caption}</span>
            </div>
          </div>
        ))}
      </div>

      {/* "Online" window (§4): sits just above the search box, right-aligned in a header row that
          mirrors the trend chart's range toggle above — the caption is the row's left-hand label;
          same toggle vocabulary as the chart ranges; per-admin, remembered. */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 13.5 }}>
          Users active within the last {ONLINE_WINDOWS.find((w) => w.mins === winMins)?.long ?? "5 minutes"}. Reach out to start a direct message.
        </span>
        <div className="sort-toggle" role="group" aria-label="Online window">
          {ONLINE_WINDOWS.map((w) => (
            <button key={w.mins} type="button" className={`sort-opt${winMins === w.mins ? " sort-on" : ""}`} onClick={() => pickWindow(w.mins)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <input
        style={{ ...field, width: "100%", marginBottom: 14 }}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search online users by name or email…"
        aria-label="Search online users"
      />

      {users === null ? (
        <div className="skeleton" style={{ height: 120, borderRadius: "var(--radius)" }} />
      ) : users.length === 0 ? (
        <div className="muted" style={{ fontSize: 13.5 }}>{qDeb ? "No online users match your search." : "No one is online right now."}</div>
      ) : (
        <div className="rows">
          {users.map((u) => (
            <div className="maintainer-item has-page" key={u.userId}>
              <div className="m-av"><UserBubble name={u.displayName} avatar={u.avatar} userId={u.userId} /></div>
              <div className="m-name">
                <div className="ttl">{u.displayName}</div>
                <div className="sub mono" style={{ fontSize: 11 }}>{u.email}</div>
              </div>
              <div className="m-page" title={u.lastSeenPage ?? undefined}>{u.lastSeenPage ?? "—"}</div>
              <div className="m-meta">
                <span className="chip">{activeAgo(u.lastSeen)}</span>
                {/* Hidden on your own card — except under dev sign-in (solo-dev testing). */}
                {me?.userId && (u.userId !== me.userId || me.devAuth) && (
                  <button className="btn btn-sm" disabled={reaching === u.userId} onClick={() => reachOut(u.userId)} title={`Message ${u.displayName}`}>
                    {reaching === u.userId ? "…" : "Reach out"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <LoadMoreSentinel hasMore={(users?.length ?? 0) < total} loading={loading} onLoadMore={() => void loadMore()} />
    </CollapsibleCard>
  );
}

interface PickedUser { userId: string; displayName: string; email: string; status: "active" | "inactive"; avatar: string | null }

// Enabled/Disabled status chip for the user pickers (active = Enabled).
function StatusChip({ status }: { status: "active" | "inactive" }) {
  const enabled = status === "active";
  return (
    <span className="chip" style={{ color: enabled ? "var(--accent-2)" : "var(--muted)", borderColor: enabled ? "var(--accent-2)" : "var(--line)" }}>
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}

// Header-search-style closed user picker: typeahead (≥3 chars) over non-erased users; clicking a
// result fills the box with that user (✕ to clear). `excludeId` hides the other box's selection.
function UserPicker({ value, onChange, placeholder, excludeId }: {
  value: PickedUser | null;
  onChange: (u: PickedUser | null) => void;
  placeholder: string;
  excludeId?: string | null;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PickedUser[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (q.trim().length < 3) { setResults([]); return; }
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/admin/users/search?q=${encodeURIComponent(q.trim())}`);
        if (!r.ok || !live) return;
        const j = (await r.json()) as { users: PickedUser[] };
        setResults((j.users ?? []).filter((u) => u.userId !== excludeId));
      } catch { /* ignore transient search errors */ }
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q, excludeId]);

  if (value) {
    return (
      <div className="user-picked" style={{ ...field }}>
        <span className="up-av"><UserBubble name={value.displayName} avatar={value.avatar} userId={value.userId} size={24} /></span>
        <span className="up-name" style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13.5 }}>{value.displayName}</span> <span className="muted mono" style={{ fontSize: 11 }}>{value.email}</span>
        </span>
        <span className="up-status"><StatusChip status={value.status} /></span>
        <button type="button" className="btn btn-sm btn-ghost up-x" onClick={() => { onChange(null); setQ(""); setResults([]); }} title="Clear">✕</button>
      </div>
    );
  }
  return (
    <div style={{ position: "relative" }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <input
        style={{ ...field, width: "100%" }}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      {open && results.length > 0 && (
        <div className="taginput-menu" style={{ maxHeight: 260, overflowY: "auto" }}>
          {results.map((u) => (
            <button key={u.userId} type="button" className="taginput-opt" style={{ display: "flex", alignItems: "center", gap: 8 }} onClick={() => { onChange(u); setOpen(false); setQ(""); }}>
              <UserBubble name={u.displayName} avatar={u.avatar} userId={u.userId} size={24} />
              <span style={{ flex: 1, minWidth: 0 }}>{u.displayName} <span className="muted">· {u.email}</span></span>
              <StatusChip status={u.status} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Maintenance / background jobs (§10). Platform admins can trigger the "Skills you might like"
// recompute on demand (it otherwise runs nightly). The button signals the worker (writes a request
// flag); we poll the status until the worker clears it, then show the new last-run stamp.
function MaintenanceCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const fmt = useDateFmt();
  const [status, setStatus] = useState<{ lastRunAt: string | null; lastRunCount: number | null; running: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/jobs/related-rebuild");
      if (r.ok) setStatus(await r.json());
    } catch { /* transient — the poll retries */ }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // While a rebuild is queued/running, poll until the worker clears the request flag.
  useEffect(() => {
    if (!status?.running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [status?.running, load]);

  const trigger = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/admin/jobs/related-rebuild", { method: "POST" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed to start rebuild");
      await load();
    } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  const running = !!status?.running;
  return (
    <CollapsibleCard cardId="maintenance" title="Maintenance" summary={running ? "rebuilding…" : undefined} open={open} onToggle={onToggle}>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
        Trigger background jobs on demand. They otherwise run on their own schedule; a manual run is handy right after a burst of installs.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>“Skills you might like” index</div>
          <div className="muted mono" style={{ fontSize: 11.5 }}>
            {running
              ? "rebuilding…"
              : status?.lastRunAt
                ? `last rebuilt ${fmt.dateTime(status.lastRunAt)} · ${formatCount(status.lastRunCount ?? 0)} links`
                : "not yet run"}
          </div>
        </div>
        <button type="button" className="btn btn-sm" disabled={busy || running} onClick={trigger} title="Recompute co-install recommendations now">
          {running ? "Rebuilding…" : "Rebuild now"}
        </button>
      </div>
      {err && <div style={{ marginTop: 10, fontSize: 13, color: "var(--danger)" }}>{err}</div>}
    </CollapsibleCard>
  );
}

// Platform-admin GDPR erasure (SKILLY_SPEC.md §4): pick a user to delete (+ optional replacement
// maintainer), confirm by typing their name, then POST the erase.
function DeleteUserInfo({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [target, setTarget] = useState<PickedUser | null>(null);
  const [replacement, setReplacement] = useState<PickedUser | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const erase = async () => {
    if (!target) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/admin/users/${target.userId}/erase`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ transferTo: replacement?.userId ?? null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      const skip = (j.skipped ?? []).length as number;
      const parts = [`Deleted ${target.displayName}.`];
      if (j.transferred) parts.push(`Transferred ${j.transferred} skill${j.transferred === 1 ? "" : "s"}${replacement ? ` to ${replacement.displayName}` : ""}.`);
      if (skip) parts.push(`${skip} restricted skill${skip === 1 ? "" : "s"} couldn't be transferred (target lacks access).`);
      if (j.creditsTransferred) parts.push(`Moved ${j.creditsTransferred} leaderboard install credit${j.creditsTransferred === 1 ? "" : "s"}.`);
      setMsg({ kind: "ok", text: parts.join(" ") });
      setTarget(null); setReplacement(null); setConfirming(false); setConfirmText("");
    } catch (e) { setMsg({ kind: "err", text: String((e as Error).message) }); } finally { setBusy(false); }
  };

  const confirmReady = !!target && confirmText.trim() === target.displayName.trim();

  return (
    <CollapsibleCard cardId="deleteuser" title="Delete User Info" open={open} onToggle={onToggle}>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
        Permanently erase a user’s personal info (GDPR). Their <strong>skills are kept</strong>; they’re removed as a maintainer, and their messages &amp; review comments become “Deleted User”. Optionally transfer the skills they maintain — and their leaderboard install credits — to another user. This can’t be undone — but the person can return later as a new account.
      </p>
      <div className="delete-user-form">
        <div style={{ flex: 1, minWidth: 240 }}>
          <label style={label}>Find a user to delete</label>
          <UserPicker value={target} onChange={(u) => { setTarget(u); setConfirming(false); setConfirmText(""); setMsg(null); }} placeholder="Search by name or email…" excludeId={replacement?.userId} />
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <label style={label}>Replace maintainer to <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--faint)" }}>· optional</span></label>
          <UserPicker value={replacement} onChange={setReplacement} placeholder="Transfer their skills to…" excludeId={target?.userId} />
        </div>
        <button type="button" className="btn btn-sm btn-danger" disabled={!target || busy} onClick={() => setConfirming(true)}>Delete</button>
      </div>

      {confirming && target && (
        <div className="card card-pad" style={{ marginTop: 14, background: "var(--surface-2)", border: "1px solid var(--danger)" }}>
          <p style={{ fontSize: 13.5, marginBottom: 10 }}>
            This permanently erases <strong>{target.displayName}</strong>’s info — PII deleted, removed as a maintainer, and their messages &amp; review comments will show “{target.email ? `${target.email} - Deleted` : "Deleted User"}”. Their skills stay.{" "}
            {replacement ? <>Skills they maintain transfer to <strong>{replacement.displayName}</strong> (where it has access), and their leaderboard install credits move to them (their board standing is retained).</> : "Skills they maintain become unassigned, and their leaderboard stats are removed."}{" "}
            <strong>This can’t be undone.</strong>
          </p>
          <label style={label}>Type <span className="mono" style={{ textTransform: "none", letterSpacing: 0 }}>{target.displayName}</span> to confirm</label>
          <div style={{ display: "flex", gap: 9, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
            <input style={{ ...field, flex: 1, maxWidth: 320 }} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={target.displayName} spellCheck={false} />
            <button type="button" className="btn btn-sm btn-danger" disabled={!confirmReady || busy} onClick={erase}>{busy ? "Working…" : "Erase user"}</button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { setConfirming(false); setConfirmText(""); }}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <div style={{ marginTop: 12, fontSize: 13.5, color: msg.kind === "err" ? "var(--danger)" : "var(--ok)" }}>{msg.text}</div>}
    </CollapsibleCard>
  );
}
