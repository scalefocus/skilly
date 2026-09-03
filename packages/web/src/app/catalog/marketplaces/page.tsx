"use client";
// Marketplaces — the consumer-facing directory of the Claude plugin marketplaces the caller can
// add (SKILLY_SPEC.md §30.6, Page 3). The leaderboard's idiom (§21): one row per marketplace, a
// bubble for the namespace's contact, per-row actions. The row set is the visibility boundary
// (lib/marketplaceDirectory.ts) — nothing here decides who may see what.
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useApi, Pill, EmptyState, ScrollToTop, LoadMoreSentinel, formatCount } from "../../../components/ui";
import { RequireAuth } from "../../../components/RequireAuth";
import { UserBubble } from "../../../components/UserBubble";
import { ExpiryPicker } from "../../../components/ExpiryPicker";
import { CopyLine } from "../../../components/CopyLine";
import { useDateFmt } from "../../../components/DateFormat";
import { filterDirectory, syncedLabel, type AddedState, type DirectoryContact } from "../../../lib/marketplaceDirectoryFilter";

interface Row {
  scope: "public" | "namespace";
  namespaceSlug: string | null;
  displayName: string;
  name: string;
  skillCount: number;
  syncedAt: string | null;
  contact: DirectoryContact;
  added: AddedState;
}

interface MintResult {
  name: string;
  command: string;
  gitConfigCommand: string;
  plainCommand: string;
  expiresAt: string | null;
}

/** Client-side infinite scroll page size — the pattern /usage and the admin online list use. */
const PAGE = 100;

const keyOf = (r: Row) => (r.scope === "public" ? "public" : `ns:${r.namespaceSlug}`);

/**
 * The contact bubble's three states (§30.6 Page 3). A resolved user gets the real `UserBubble`
 * (avatar, badges, §28 hover card). The other two are inert: a dashed `N/A` disc when no contact is
 * set, and a two-person glyph when the address belongs to nobody in skilly — a distribution list,
 * an external mailbox, or a leaver — because there is no person whose initials could stand in.
 */
function ContactBubble({ contact, size = 34 }: { contact: DirectoryContact; size?: number }) {
  if (contact.kind === "user") {
    return <UserBubble name={contact.displayName} avatar={contact.avatar} userId={contact.userId} size={size} />;
  }
  const base = { width: size, height: size, borderRadius: "50%", display: "grid", placeItems: "center", flexShrink: 0 } as const;
  if (contact.kind === "email") {
    return (
      <span
        className="contact-bubble contact-group"
        role="img"
        aria-label={`Group contact ${contact.email}`}
        title={contact.email}
        style={{ ...base, background: "var(--accent-soft)", color: "var(--accent-2)" }}
      >
        <svg width={Math.round(size * 0.58)} height={Math.round(size * 0.58)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M2.5 19.5c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5" />
          <circle cx="17" cy="9" r="2.6" />
          <path d="M16 14.2c3 .2 5.5 2.2 5.5 5.3" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className="contact-bubble contact-none"
      role="img"
      aria-label="No contact"
      style={{ ...base, background: "var(--surface-2)", color: "var(--faint)", border: "1px dashed var(--line)", fontFamily: "var(--font-mono)", fontSize: Math.round(size * 0.3), fontWeight: 600 }}
    >
      N/A
    </span>
  );
}

/**
 * The inline Install panel: the same two-step the skill detail page uses (§23) — pick an expiry,
 * then Generate — because the click MINTS a reusable credential, so the TTL is the user's decision.
 * The auto-update fallback sits behind a disclosure (§30.4).
 */
function InstallPanel({ row, maxMonths }: { row: Row; maxMonths: number }) {
  const fmt = useDateFmt();
  const [expiry, setExpiry] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintResult | null>(null);

  const mint = async () => {
    if (pending) {
      setErr("Choose an expiration date, or switch the expiry to Never.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body = row.scope === "public"
        ? { scope: "public", expiresAt: expiry }
        : { scope: "namespace", namespaceSlug: row.namespaceSlug, expiresAt: expiry };
      const r = await fetch("/api/marketplaces/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as MintResult & { error?: string };
      if (!r.ok) throw new Error(j.error ?? "Failed to generate");
      setMinted(j);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mk-panel" style={{ flexBasis: "100%", marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 12.5 }}>key expiry</span>
        <ExpiryPicker maxMonths={maxMonths} onChange={setExpiry} onPendingChange={setPending} />
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void mint()}>
          {busy ? "Working…" : "Generate add command"}
        </button>
      </div>
      {err && <div role="alert" style={{ marginTop: 8, fontSize: 13, color: "var(--danger)" }}>{err}</div>}
      {minted && (
        <>
          <CopyLine label="Run in Claude Code" value={minted.command} />
          <div className="muted mono" style={{ fontSize: 11, marginTop: 6 }}>
            {minted.expiresAt ? `key expires ${fmt.date(minted.expiresAt)}` : "key never expires"} · manage it in Added marketplaces
          </div>
          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ fontSize: 12.5, cursor: "pointer" }}>If background updates fail</summary>
            <CopyLine
              label="Run the git config line once, then add with the credential-free URL"
              value={`${minted.gitConfigCommand}\n${minted.plainCommand}`}
              hint="Claude Code turns off git credential helpers for background marketplace updates, so a URL rewrite carries the key instead."
            />
          </details>
        </>
      )}
    </div>
  );
}

function MarketplacesInner() {
  const q = (useSearchParams().get("q") ?? "").trim();
  // Own id → hide "Reach out" on a row whose contact is you (mirrors the leaderboard, §21).
  const { data: me } = useApi<{ userId: string | null; installMaxTtlMonths?: number }>("/api/me");
  const { data, loading, error } = useApi<{ rows: Row[]; syncMinutes: number }>("/api/marketplaces/directory");
  const rows = data?.rows ?? [];
  const filtered = filterDirectory(rows, q);

  // Infinite scroll over the loaded rows, reset to the top whenever the filter changes.
  const [visible, setVisible] = useState(PAGE);
  useEffect(() => { setVisible(PAGE); }, [q]);

  // Which row's Install panel is open — one at a time keeps the list scannable.
  const [openKey, setOpenKey] = useState<string | null>(null);

  // "Reach out": open (or reuse) a 1:1 chat — the leaderboard's flow (§21).
  const [reaching, setReaching] = useState<string | null>(null);
  const reachOut = async (userId: string) => {
    setReaching(userId);
    try {
      const r = await fetch("/api/messages/direct", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
      if (r.ok) {
        const { conversationId } = await r.json();
        window.dispatchEvent(new CustomEvent("skilly:open-conversation", { detail: { id: conversationId } }));
      }
    } finally {
      setReaching(null);
    }
  };

  return (
    <div style={{ maxWidth: 860 }}>
      <ScrollToTop />
      <div className="page-head reveal">
        <div className="eyebrow">Catalog</div>
        <h1 className="page-title">Marketplaces.</h1>
        <p className="page-sub">
          Claude Code plugin marketplaces you can add. A namespace marketplace publishes that namespace’s restricted
          skills; the public marketplace carries every skill anyone in the organization can see.
          {data && <> Marketplaces refresh from the catalog every {data.syncMinutes} min.</>}
        </p>
      </div>

      {error ? (
        <EmptyState icon="⚠" title="Couldn’t load marketplaces" hint={error} />
      ) : loading && !data ? (
        <div className="rows">
          {Array.from({ length: 3 }).map((_, i) => (
            <div className="row" key={i}>
              <div className="skeleton" style={{ height: 16, width: "45%" }} />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No marketplaces are available to you yet"
          hint="A namespace admin switches a marketplace on from Namespace administration, and a platform admin switches on the public one. As soon as one you can access is enabled, it appears here."
        />
      ) : filtered.length === 0 ? (
        <EmptyState title={`No marketplaces match “${q}”`} hint="Clear the search to see every marketplace you can add." />
      ) : (
        <>
          <div className="rows reveal">
            {filtered.slice(0, visible).map((r) => {
              const key = keyOf(r);
              const open = openKey === key;
              const skillsHref = r.scope === "public"
                ? "/catalog"
                : `/catalog?ns=${encodeURIComponent(r.namespaceSlug ?? "")}&nsName=${encodeURIComponent(r.displayName)}`;
              const isSelf = r.contact.kind === "user" && !!me?.userId && me.userId === r.contact.userId;
              const contactLine =
                r.contact.kind === "user" ? `contact: ${r.contact.displayName}`
                : r.contact.kind === "email" ? `contact: ${r.contact.email}`
                : "no contact";
              return (
                <div className="row lb-row mk-row" key={key} style={{ alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <ContactBubble contact={r.contact} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 600, fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.displayName}</span>
                      {r.added === "active" && (
                        <Link href="/marketplaces" title="You’ve added this marketplace — manage its key in Added marketplaces" style={{ textDecoration: "none" }}>
                          <Pill tone="ok">added</Pill>
                        </Link>
                      )}
                      {r.added === "expired" && (
                        <Link href="/marketplaces" title="Your key for this marketplace expired — reactivate it in Added marketplaces" style={{ textDecoration: "none" }}>
                          <Pill tone="danger">expired</Pill>
                        </Link>
                      )}
                    </div>
                    {/* The count is the marketplace PAYLOAD, not the namespace's catalog size — the verb
                        is there because the bare number would be misread (§30.6). */}
                    <div className="muted mono" style={{ fontSize: 11.5 }}>
                      {r.name} · publishes {r.skillCount} skill{r.skillCount === 1 ? "" : "s"} · {syncedLabel(r.syncedAt)}
                    </div>
                    <div className="muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{contactLine}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600 }}>{formatCount(r.skillCount)}</div>
                    <div className="muted mono" style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase" }}>published</div>
                  </div>
                  <div className="lb-actions" style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <Link href={skillsHref} className="btn btn-sm" title={r.scope === "public" ? "Browse the whole catalog" : `Skills in ${r.displayName} that you can see`}>
                      Skills
                    </Link>
                    <button
                      type="button"
                      className={`btn btn-sm${open ? "" : " btn-primary"}`}
                      aria-expanded={open}
                      onClick={() => setOpenKey(open ? null : key)}
                      title={r.added === "active" ? "Mint a fresh key — your existing one keeps working" : "Generate a Claude Code add command"}
                    >
                      {r.added === "active" ? "Add again" : "Install"}
                    </button>
                    {r.contact.kind === "user" && !isSelf && (
                      <button type="button" className="btn btn-sm" disabled={reaching === r.contact.userId} onClick={() => reachOut(r.contact.kind === "user" ? r.contact.userId : "")} title={`Message ${r.contact.displayName}`}>
                        {reaching === r.contact.userId ? "…" : "Reach out"}
                      </button>
                    )}
                    {r.contact.kind === "email" && (
                      <a className="btn btn-sm" href={`mailto:${r.contact.email}`} title={`Email ${r.contact.email}`}>Reach out</a>
                    )}
                    {r.contact.kind === "none" && (
                      <button type="button" className="btn btn-sm" disabled title="No contact is set for this marketplace">Reach out</button>
                    )}
                  </div>
                  {open && <InstallPanel row={r} maxMonths={me?.installMaxTtlMonths ?? 12} />}
                </div>
              );
            })}
          </div>
          <LoadMoreSentinel onLoadMore={() => setVisible((v) => v + PAGE)} hasMore={visible < filtered.length} loading={false} />
        </>
      )}
    </div>
  );
}

export default function MarketplacesDirectoryPage() {
  return (
    <RequireAuth>
      {/* MarketplacesInner reads ?q= via useSearchParams — needs a Suspense boundary. */}
      <Suspense
        fallback={
          <div className="rows">
            {Array.from({ length: 3 }).map((_, i) => (
              <div className="row" key={i}>
                <div className="skeleton" style={{ height: 16, width: "45%" }} />
              </div>
            ))}
          </div>
        }
      >
        <MarketplacesInner />
      </Suspense>
    </RequireAuth>
  );
}
