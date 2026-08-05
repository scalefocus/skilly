"use client";
// Mention rendering (SKILLY_SPEC.md §24 "Mentions"). Turns `<@uuid>`/`<#uuid>` tokens into inline
// chips using the PER-READER resolution map the message APIs return — the client never resolves
// ids itself, so a restricted skill's name is never in the payload (invariant #3). A token with no
// map entry renders as literal text (e.g. a pre-feature body that happened to contain one).
//  - @user  → neutral chip; hover/focus opens the §28 directory card; click → their maintained
//             skills (/catalog?maintainer=…). An erased user renders as plain tombstone text.
//  - #skill → accent chip (the version-pill tone) linking to the skill page; the namespace slug
//             prefixes the title when the skill is namespace-restricted. A skill the reader can't
//             see renders an unnamed "a restricted skill" chip; a deleted one its plain-text label.
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
// NB: the SUBPATH import — client components must never pull the @skilly/shared barrel (it
// reaches node:crypto via the token/digest modules and breaks the client bundle).
import { splitMentionSegments } from "@skilly/shared/mentions";
import { useApi } from "./ui";
import { useDirectoryCard } from "./DirectoryCard";
import type { LeaderBadgeInfo } from "./leaderBadges";

// Client mirror of the server's per-reader resolution (lib/mentions.ts → ResolvedMention).
export type ResolvedMention =
  | { kind: "user"; id: string; name: string; erased: boolean }
  | { kind: "skill"; id: string; state: "ok"; title: string; ns: string; slug: string; restricted: boolean }
  | { kind: "skill"; id: string; state: "restricted" }
  | { kind: "skill"; id: string; state: "gone"; label: string | null };

export type MentionMap = Record<string, ResolvedMention>;

const NO_BADGES: LeaderBadgeInfo[] = [];

function UserChip({ m }: { m: ResolvedMention & { kind: "user" } }) {
  // Badges come from the page-wide /api/leaders map every UserBubble already shares (§28).
  const { data } = useApi<Record<string, LeaderBadgeInfo[]>>("/api/leaders");
  const { triggerProps, card } = useDirectoryCard(m.id, m.name, data?.[m.id] ?? NO_BADGES);
  const { className, ...trigger } = triggerProps;
  return (
    <>
      <Link
        {...trigger}
        className={`${className} mention-chip mention-chip-user`}
        href={`/catalog?maintainer=${m.id}&by=${encodeURIComponent(m.name)}`}
        title={`${m.name} — view their skills`}
      >
        @{m.name}
      </Link>
      {card}
    </>
  );
}

/** One resolved mention as an inline chip (or the §24 fallback rendering). */
export function MentionChip({ token, resolved }: { token: string; resolved: ResolvedMention | undefined }) {
  if (!resolved) return <>{token}</>; // no row behind it → literal text
  if (resolved.kind === "user") {
    // Erased → the app's tombstone label as plain de-identified text: no chip, no card, no link.
    if (resolved.erased) return <span className="muted">{resolved.name}</span>;
    return <UserChip m={resolved} />;
  }
  if (resolved.state === "ok") {
    return (
      <Link className="mention-chip mention-chip-skill" href={`/skills/${resolved.ns}/${resolved.slug}`}>
        {resolved.restricted ? `${resolved.ns} / ${resolved.title}` : resolved.title}
      </Link>
    );
  }
  if (resolved.state === "restricted") {
    // Redacted (§24): the reader can't see this skill — no name, no link (invariant #3).
    return <span className="mention-chip mention-chip-redacted">a restricted skill</span>;
  }
  // Deleted skill: the post-time ns/slug label as plain muted text.
  return <span className="muted mono" style={{ fontSize: "0.95em" }}>{resolved.label ?? "a deleted skill"}</span>;
}

/** A plain-text body with its mention tokens rendered as chips (the ChatBox contexts — the one
 *  markup exception; everything else stays escaped text with newlines preserved). */
export function MentionText({ body, mentions }: { body: string; mentions: MentionMap | undefined }) {
  const segs = splitMentionSegments(body);
  if (segs.length === 1 && segs[0]?.type === "text") return <>{body}</>;
  return (
    <>
      {segs.map((s, i) =>
        s.type === "text" ? (
          <Fragment key={i}>{s.text}</Fragment>
        ) : (
          <MentionChip key={i} token={s.token} resolved={mentions?.[s.token]} />
        ),
      )}
    </>
  );
}

/** Shared muted reminder line under every mention-capable composer (§24). */
export function MentionHint({ markdown }: { markdown?: boolean }): ReactNode {
  return (
    <p className="muted mention-hint" style={{ fontSize: 11.5, margin: "4px 0 0" }}>
      {markdown ? "markdown supported · " : ""}# to mention a skill · @ to mention someone
    </p>
  );
}
