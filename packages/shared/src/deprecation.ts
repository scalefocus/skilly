// Skill deprecation with a successor — the pure domain core (SKILLY_SPEC.md §45).
//
// Three things live here because three callers must agree on them:
//   • successorEligibility — the §45.3 audience rule (web PUT endpoint, the successor picker, tests);
//   • buildDeprecationHint  — the §45.4 SKILL.md rewrite the worker commits on `main` (and embeds in
//                             marketplace plugins); deterministic + idempotent so the self-heal sweep
//                             can recompute and compare instead of tracking state;
//   • deprecationWarning    — the one sentence the UI, the MCP `install_skill` warning and the
//                             notification body share.
// Client-safe: no node deps. Exported via the `@skilly/shared/deprecation` subpath and the barrel.

import type { Visibility } from "./types.js";
import { isSkillVisible, type EffectiveAccess } from "./rbac.js";

/** Plain-text note cap (§45.2). */
export const DEPRECATION_NOTE_MAX = 1000;

export type SuccessorIneligibleReason = "not_found" | "self" | "archived" | "deprecated" | "audience";

/** What the audience rule needs to know about either side. */
export interface DeprecationAudienceSubject {
  id: string;
  visibility: Visibility;
  namespaceId: string;
  /** §42 grantee namespace ids (owner excluded); `[]`/undefined when none. */
  sharedNamespaceIds?: readonly string[] | null;
}

export interface SuccessorCandidate extends DeprecationAudienceSubject {
  status: "active" | "archived";
  deprecatedAt: string | Date | null;
}

export type SuccessorEligibility = { ok: true } | { ok: false; reason: SuccessorIneligibleReason };

/**
 * §45.3 — may `successor` be named as the "use X instead" of `skill`?
 *   self        the same skill
 *   archived    successor.status !== 'active'
 *   deprecated  the successor is itself deprecated (no chains at set time)
 *   audience    the successor's audience does not cover the deprecated skill's: an `org` successor
 *               always does; a `namespace` successor does only if the skill is also `namespace`
 *               and (owner ∪ grants)(skill) ⊆ (owner ∪ grants)(successor).
 * A `null` successor is always fine ("deprecated, no replacement").
 */
export function successorEligibility(skill: DeprecationAudienceSubject, successor: SuccessorCandidate | null): SuccessorEligibility {
  if (!successor) return { ok: true };
  if (successor.id === skill.id) return { ok: false, reason: "self" };
  if (successor.status !== "active") return { ok: false, reason: "archived" };
  if (successor.deprecatedAt) return { ok: false, reason: "deprecated" };
  if (successor.visibility === "org") return { ok: true };
  if (skill.visibility !== "namespace") return { ok: false, reason: "audience" };
  const covered = new Set<string>([successor.namespaceId, ...(successor.sharedNamespaceIds ?? [])]);
  const needed = [skill.namespaceId, ...(skill.sharedNamespaceIds ?? [])];
  return needed.every((id) => covered.has(id)) ? { ok: true } : { ok: false, reason: "audience" };
}

/** Human message per reason — the 422 body and the picker's hint share it. */
export function successorIneligibleMessage(reason: SuccessorIneligibleReason): string {
  switch (reason) {
    case "not_found":
      return "No such skill.";
    case "self":
      return "A skill cannot be its own successor.";
    case "archived":
      return "The successor is archived.";
    case "deprecated":
      return "The successor is itself deprecated.";
    case "audience":
      return "Everyone who can see this skill must be able to see the successor (an org-visible skill, or a restricted skill shared with the same namespaces).";
  }
}

/** Validate a note: trimmed plain text ≤ DEPRECATION_NOTE_MAX, or null when empty. */
export function normalizeDeprecationNote(raw: unknown): { ok: true; note: string | null } | { ok: false; error: string } {
  if (raw == null) return { ok: true, note: null };
  if (typeof raw !== "string") return { ok: false, error: "note must be a string" };
  const note = raw.replace(/\r\n?/g, "\n").trim();
  if (!note) return { ok: true, note: null };
  if (note.length > DEPRECATION_NOTE_MAX) return { ok: false, error: `note must be at most ${DEPRECATION_NOTE_MAX} characters` };
  return { ok: true, note };
}

/** The one sentence shared by the UI warning line, the MCP `install_skill` warning and the notification body. */
export function deprecationWarning(skillRef: string, successorRef: string | null): string {
  return successorRef ? `${skillRef} is deprecated — use ${successorRef} instead.` : `${skillRef} is deprecated.`;
}

// ── The SKILL.md hint (§45.4) ────────────────────────────────────────────────────────────────────

export interface DeprecationHintInput {
  /** `<ns>/<slug>` of an ACTIVE successor, or null (absent, archived or none). */
  successor: string | null;
  /** The admin's plain-text note, or null. */
  note: string | null;
  /** The successor's catalog URL (`<APP_URL>/skills/<ns>/<slug>`) — never a clone URL, never a token. */
  successorUrl: string | null;
}

const BANNER_OPEN = "<!-- skilly:deprecation -->";
const BANNER_CLOSE = "<!-- /skilly:deprecation -->";
const PREFIX_RE = /^DEPRECATED(?: — use \S+ instead)?\.\s*/;

/** The `description` prefix triggering-time agents read. */
export function deprecationDescriptionPrefix(successor: string | null): string {
  return successor ? `DEPRECATED — use ${successor} instead. ` : "DEPRECATED. ";
}

function stripPrefix(value: string): string {
  return value.replace(PREFIX_RE, "");
}

/** Rewrite one `description:` line (inline scalar); block scalars are handled by the caller. */
function prefixInlineDescription(line: string, prefix: string): string {
  const idx = line.indexOf(":");
  const key = line.slice(0, idx + 1);
  const rest = line.slice(idx + 1);
  const lead = rest.match(/^\s*/)![0];
  let value = rest.slice(lead.length);
  // trailing comment / whitespace are kept verbatim after the value
  const m = /^(["'])([\s\S]*?)\1(\s*(?:#.*)?)$/.exec(value);
  if (m) {
    const q = m[1]!;
    const inner = stripPrefix(m[2]!);
    return `${key}${lead}${q}${prefix}${inner}${q}${m[3]}`;
  }
  const trail = value.match(/\s*$/)![0];
  value = stripPrefix(value.slice(0, value.length - trail.length));
  return `${key}${lead}${prefix}${value}${trail}`;
}

/**
 * Rewrite a SKILL.md so agents see the deprecation (§45.4). Line-based, so every untouched
 * frontmatter line stays byte-identical:
 *   1. frontmatter: `deprecated: true` (+ `superseded_by: "<ns>/<slug>"` when a successor is set)
 *      inserted right after the opening `---`; `description` prefixed with
 *      `DEPRECATED — use <ns>/<slug> instead. ` / `DEPRECATED. ` (inline scalars in place; block
 *      scalars get the prefix as their first content line); `name` is never touched.
 *   2. body: a blockquote banner right after the frontmatter (wrapped in HTML-comment markers so a
 *      re-run can find and replace it), then the note.
 * Idempotent: applying it to already-hinted content yields the same bytes. Without a parsable
 * frontmatter block only the banner is prepended.
 */
export function buildDeprecationHint(skillMd: string, input: DeprecationHintInput): string {
  const nl = skillMd.includes("\r\n") ? "\r\n" : "\n";
  const lines = stripExistingBanner(skillMd).split(/\r?\n/);
  const prefix = deprecationDescriptionPrefix(input.successor);

  // Locate the frontmatter block: `---` on line 0, closing `---` later.
  let fmEnd = -1;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === "---") {
        fmEnd = i;
        break;
      }
    }
  }

  const banner = buildBanner(input);
  if (fmEnd < 0) return [...banner, ...separate(lines)].join(nl);

  const fm = lines.slice(1, fmEnd).filter((l) => {
    const key = l.slice(0, l.indexOf(":")).trim();
    return !(l.indexOf(":") > 0 && (key === "deprecated" || key === "superseded_by"));
  });

  // description — inline or block scalar
  for (let i = 0; i < fm.length; i++) {
    const l = fm[i]!;
    if (!/^description\s*:/.test(l)) continue;
    const value = l.slice(l.indexOf(":") + 1).trim();
    if (/^[|>][+-]?\d*$/.test(value)) {
      // block scalar: the prefix becomes the first content line at the block's indentation
      let j = i + 1;
      while (j < fm.length && fm[j]!.trim() === "") j++;
      const indent = j < fm.length ? fm[j]!.match(/^\s*/)![0] : "  ";
      if (j < fm.length && PREFIX_RE.test(fm[j]!.trim()) && fm[j]!.trim().replace(PREFIX_RE, "") === "") fm.splice(j, 1);
      fm.splice(i + 1, 0, `${indent}${prefix.trimEnd()}`);
    } else {
      fm[i] = prefixInlineDescription(l, prefix);
    }
    break;
  }

  const header = ["deprecated: true"];
  if (input.successor) header.push(`superseded_by: "${input.successor}"`);
  const body = lines.slice(fmEnd + 1);
  return ["---", ...header, ...fm, "---", ...banner, ...separate(body)].join(nl);
}

/** One blank line between the banner and the body — without stacking blanks on a re-run. */
function separate(body: string[]): string[] {
  return body.length === 0 || body[0]!.trim() !== "" ? ["", ...body] : body;
}

function buildBanner(input: DeprecationHintInput): string[] {
  const out = [BANNER_OPEN];
  if (input.successor) {
    out.push(`> **Deprecated.** Use \`${input.successor}\` instead${input.successorUrl ? ` — ${input.successorUrl}` : ""}`);
  } else {
    out.push("> **Deprecated.**");
  }
  if (input.note) {
    out.push(">");
    for (const l of neutralizeComments(input.note).split(/\r?\n/)) out.push(l ? `> ${l}` : ">");
  }
  out.push(BANNER_CLOSE);
  return out;
}

/**
 * A note is plain text, but it is emitted between two HTML-comment markers that a re-run locates by
 * string search. Break every comment opener and BOTH comment terminators (`-->` and the legacy
 * `--!>`) so no note can forge or close a marker: `<!--` → `<!- -`, `-->` → `- ->`, `--!>` → `- -!>`.
 */
function neutralizeComments(note: string): string {
  return note.replace(/<!--|--!?>/g, (m) => m.replace("--", "- -"));
}

function stripExistingBanner(md: string): string {
  const start = md.indexOf(BANNER_OPEN);
  if (start < 0) return md;
  const end = md.indexOf(BANNER_CLOSE, start);
  if (end < 0) return md;
  let after = end + BANNER_CLOSE.length;
  // swallow the blank separator line the banner adds
  if (md.startsWith("\r\n", after)) after += 2;
  else if (md.startsWith("\n", after)) after += 1;
  return md.slice(0, start) + md.slice(after);
}

/** Does this SKILL.md already carry the hint (frontmatter `deprecated: true` or the banner)? */
export function hasDeprecationHint(skillMd: string): boolean {
  return skillMd.includes(BANNER_OPEN) || /^deprecated\s*:\s*true\s*$/m.test(skillMd.split(/\r?\n---/)[0] ?? "");
}

// ── Read-side shaping shared by the web tier and the worker's MCP server (§45.5/§45.7) ──────────

/** The light `deprecation` object every list/hit/row surface carries (§45.8). */
export interface DeprecationLite {
  note: string | null;
  /** Named ONLY when the viewer can see the successor and it is active (§45.1 #5). */
  successor: { namespaceSlug: string; skillSlug: string; title: string } | null;
}

/** What `successorJsonSql` returns per row (jsonb → parsed), or null without a successor. */
export interface SuccessorJson {
  id: string;
  namespaceId: string;
  namespaceSlug: string;
  slug: string;
  title: string;
  visibility: Visibility;
  status: "active" | "archived";
  deprecatedAt: string | null;
  sharedNamespaceIds: string[];
  iconSha256: string | null;
  iconEmoji: string | null;
  /** has an active, git-published STABLE version */
  installable: boolean;
}

/**
 * SQL (jsonb scalar subquery) selecting the successor row of the skill at `alias`, with everything
 * the per-viewer filter needs — one column, so it slots into GROUP BY queries that group by `s.id`.
 * NULL when the skill names no successor. The caller passes the parsed value to `visibleSuccessor`.
 */
export function successorJsonSql(alias = "s"): string {
  return `(select jsonb_build_object(
      'id', x.id, 'namespaceId', x.namespace_id, 'namespaceSlug', xn.slug, 'slug', x.slug, 'title', x.title,
      'visibility', x.visibility, 'status', x.status, 'deprecatedAt', x.deprecated_at,
      'sharedNamespaceIds', coalesce((select array_agg(g.namespace_id) from skill_namespace_grants g where g.skill_id = x.id), '{}'::uuid[]),
      'iconSha256', x.icon_sha256, 'iconEmoji', x.icon_emoji,
      'installable', exists (select 1 from skill_versions xv where xv.skill_id = x.id and xv.status = 'active' and xv.git_published and not xv.is_prerelease))
    from skills x join namespaces xn on xn.id = x.namespace_id
   where x.id = ${alias}.successor_skill_id)`;
}

/** The successor as this viewer may see it: the row when active AND visible, else null (§45.1 #5). */
export function visibleSuccessor(access: EffectiveAccess, succ: SuccessorJson | null | undefined): SuccessorJson | null {
  if (!succ || succ.status !== "active") return null;
  return isSkillVisible(access, { namespaceId: succ.namespaceId, visibility: succ.visibility, sharedNamespaceIds: succ.sharedNamespaceIds }) ? succ : null;
}

/** The light object for list surfaces — null when the skill is not deprecated. */
export function deprecationLite(
  access: EffectiveAccess,
  row: { deprecatedAt: string | Date | null; note: string | null; successor: SuccessorJson | null | undefined },
): DeprecationLite | null {
  if (!row.deprecatedAt) return null;
  const s = visibleSuccessor(access, row.successor);
  return { note: row.note, successor: s ? { namespaceSlug: s.namespaceSlug, skillSlug: s.slug, title: s.title } : null };
}

/** `<ns>/<slug>` of a successor for messages and the git hint. */
export function skillRef(namespaceSlug: string, slug: string): string {
  return `${namespaceSlug}/${slug}`;
}
