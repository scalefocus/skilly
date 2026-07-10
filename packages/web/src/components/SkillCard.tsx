"use client";
import Link from "next/link";
import { agentLabel } from "@skilly/shared/agents";
import { Pill, formatCount } from "./ui";
import { useDateFmt } from "./DateFormat";

// Descriptions support Markdown; the catalog preview is a clamped one/two-liner, so render a
// stripped plain-text version here (full Markdown is rendered on the detail/review screens).
function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export interface CatalogEntry {
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  description: string;
  type: "hosted" | "pointer";
  visibility: "org" | "namespace";
  toolHarness: string;
  categories: string[];
  tags: string[];
  installCount: number;
  ratingAvg: number;
  ratingCount: number;
  watcherCount: number;
  status?: "active" | "archived";
  latest: string | null;
  updatedAt?: string;
  createdAt?: string;
  /** Server-computed: this skill is new TO THIS USER (appeared since their last catalog visit).
   *  Drives the "new" badge — it is NOT a global "updated in the last 30 days" window. §10. */
  isNew?: boolean;
  /** Platform-admin "Official" endorsement (§7) — drives the Official badge. */
  official?: boolean;
}

/** The "Official" badge marks platform-endorsed (first-party / sanctioned) skills (§7). It is an
 *  endorsement, NOT a security claim — every skill is scanned regardless. */
export function OfficialBadge({ official }: { official?: boolean }) {
  if (!official) return null;
  return (
    <span className="chip chip-official" title="Official — endorsed by the platform">
      <span aria-hidden>✓</span> Official
    </span>
  );
}

/** The "new" badge marks skills the viewer hasn't seen before — those that appeared in the
 *  catalog since their last visit (server-computed `isNew`). Tooltip shows when it was added,
 *  in the viewer's tz + chosen style. */
function NewBadge({ s }: { s: CatalogEntry }) {
  const fmt = useDateFmt();
  if (!s.isNew) return null;
  const title = s.createdAt ? `New — added ${fmt.dateTime(s.createdAt)}` : "New since your last visit";
  return (
    <span className="chip chip-new" title={title}>new</span>
  );
}

/** Rating badge shown for EVERY skill — unrated ones show an empty star so the column reads consistently. */
function RatingBadge({ s, withCount = false }: { s: CatalogEntry; withCount?: boolean }) {
  if (s.ratingCount === 0) {
    return (
      <span className="rating-badge" title="No ratings yet" style={{ opacity: 0.55 }}>
        <span className="rating-star" aria-hidden>☆</span>—
      </span>
    );
  }
  return (
    <span className="rating-badge" title={`${s.ratingCount} rating${s.ratingCount === 1 ? "" : "s"}`}>
      <span className="rating-star" aria-hidden>★</span>
      {s.ratingAvg.toFixed(1)}
      {withCount && <span className="rating-n"> · {formatCount(s.ratingCount)}</span>}
    </span>
  );
}

/** "N watching" label — shown only when at least one user follows the skill. */
function WatchBadge({ s }: { s: CatalogEntry }) {
  if (!s.watcherCount) return null;
  return (
    <span className="muted mono" style={{ fontSize: 11 }} title={`${s.watcherCount} ${s.watcherCount === 1 ? "person is" : "people are"} watching this skill`}>
      <span aria-hidden>👁</span> {formatCount(s.watcherCount)} watching
    </span>
  );
}

export function SkillCard({ s, index = 0 }: { s: CatalogEntry; index?: number }) {
  return (
    <Link href={`/skills/${s.namespaceSlug}/${s.skillSlug}`} className="card skill-card reveal" style={{ animationDelay: `${Math.min(index, 11) * 45}ms` }}>
      {/* Absolutely pinned to the card's top-right corner (see .skill-card > .chip-new). */}
      <NewBadge s={s} />
      <div className="meta">
        <span className="ns">@{s.namespaceSlug}</span>
        <OfficialBadge official={s.official} />
        {s.latest && <span className="chip chip-accent">v{s.latest}</span>}
        {s.type === "pointer" && <Pill tone="muted">external</Pill>}
        {s.visibility === "namespace" && <Pill tone="warn">restricted</Pill>}
        {s.status === "archived" && <Pill tone="danger">archived</Pill>}
      </div>
      <h3>{s.title}</h3>
      <p className="desc">{plainText(s.description)}</p>
      <div className="meta" style={{ marginTop: "auto", paddingTop: 6, flexWrap: "wrap" }}>
        <span className="chip">{agentLabel(s.toolHarness)}</span>
        {s.categories.map((c) => <span key={c} className="chip">{c}</span>)}
      </div>
      {/* Ratings + installs live on their own row at the bottom, divided from the chips above. */}
      <div className="meta" style={{ paddingTop: 10, borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
        <RatingBadge s={s} withCount />
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 10, alignItems: "center" }}>
          <WatchBadge s={s} />
          <span className="muted mono" style={{ fontSize: 11 }}>{formatCount(s.installCount)} installs</span>
        </span>
      </div>
    </Link>
  );
}

/** Compact one-line variant for the catalog's list view (same data as SkillCard). */
export function SkillListRow({ s }: { s: CatalogEntry }) {
  // .has-new reserves right padding so the full-height edge tab never overlaps row content.
  return (
    <Link href={`/skills/${s.namespaceSlug}/${s.skillSlug}`} className={`card skill-row${s.isNew ? " has-new" : ""}`}>
      {/* Absolutely pinned to the row's right edge, spanning full height (see .skill-row > .chip-new). */}
      <NewBadge s={s} />
      <div className="skill-row-id">
        <div style={{ fontWeight: 600, fontSize: 15 }}>{s.title}</div>
        <div className="ns mono" style={{ fontSize: 11.5 }}>@{s.namespaceSlug}/{s.skillSlug}</div>
      </div>
      <p className="desc muted skill-row-desc">{plainText(s.description)}</p>
      <div className="skill-row-meta">
        <OfficialBadge official={s.official} />
        {s.latest && <span className="chip chip-accent">v{s.latest}</span>}
        {s.type === "pointer" && <Pill tone="muted">external</Pill>}
        {s.visibility === "namespace" && <Pill tone="warn">restricted</Pill>}
        {s.status === "archived" && <Pill tone="danger">archived</Pill>}
        <span className="chip">{agentLabel(s.toolHarness)}</span>
        {/* Grouped so on mobile (when the row wraps) rating + installs drop to their own bottom row. */}
        <span className="skill-row-stats">
          <RatingBadge s={s} />
          <WatchBadge s={s} />
          <span className="muted mono" style={{ fontSize: 11, minWidth: 72, textAlign: "right" }}>{formatCount(s.installCount)} installs</span>
        </span>
      </div>
    </Link>
  );
}
