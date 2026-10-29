// Import a whole repository (SKILLY_SPEC.md §64) — the pure rules the scan endpoint, the submit
// endpoint, the import page and both notification renderers share: which tree paths are skills, the
// last-changed date of each skill folder, which found skills can be imported, the wizard's pre-fill
// from the SKILL.md frontmatter, Tick all, and the notification wording and links.
// Client-safe (no node deps); exported via the barrel and the `@skilly/shared/repo-import` subpath.
import { isSafeRelativePath } from "./validate.js";
import { categoryNameError } from "./category.js";
import { isValidSemver } from "./semver.js";

/** At most this many skills ticked per import (§64.1 decision 14) — equal to the daily AI draft cap. */
export const IMPORT_MAX_SKILLS = 50;
/** The scan lists at most this many found skills, in path order (§64.3). */
export const IMPORT_SCAN_MAX_LISTED = 500;
/** The scan's history walk for last-changed dates reaches this many commits back (§64.3). */
export const IMPORT_HISTORY_MAX_COMMITS = 2000;
/** Each found SKILL.md is read up to this many bytes for its frontmatter (§64.3). */
export const IMPORT_SKILL_MD_MAX_BYTES = 64 * 1024;

/**
 * A SKILL.md `name` an import can use as the skill slug: lowercase letters, digits and hyphens,
 * starting with a letter or digit, at most 64 characters (the slug shape the MCP tools enforce).
 */
const IMPORT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isImportableName(name: string | null | undefined): boolean {
  return typeof name === "string" && IMPORT_NAME_RE.test(name);
}

// ── Discovery (§64.3) ─────────────────────────────────────────────────────────────────────────

export interface FoundSkillPath {
  /** The SKILL.md's path in the tree (`skills/pdf/SKILL.md`, or `SKILL.md` at the root). */
  path: string;
  /** The skill's folder: the path's parent, or null for the repository root. */
  subdir: string | null;
}

/** Strip slashes at either end; empty → null. An index scan, not a regex, so a run of slashes in
 *  user input can never make it backtrack (js/polynomial-redos). */
export function normalizeImportFolder(raw: string | null | undefined): string | null {
  const v = trimSlashes((raw ?? "").trim());
  return v || null;
}

function trimSlashes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === "/") start++;
  while (end > start && s[end - 1] === "/") end--;
  return s.slice(start, end);
}

/**
 * Every tree path whose last segment is exactly `SKILL.md` and that passes the shared safe-path
 * predicate, under `folder` when given, sorted by path. The first `max` are returned with `total`.
 */
export function discoverSkillPaths(
  paths: readonly string[],
  folder?: string | null,
  max: number = IMPORT_SCAN_MAX_LISTED,
): { found: FoundSkillPath[]; total: number } {
  const under = normalizeImportFolder(folder);
  const all = paths
    .filter((p) => (p === "SKILL.md" || p.endsWith("/SKILL.md")) && isSafeRelativePath(p))
    .filter((p) => !under || p.startsWith(`${under}/`))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const found = all.slice(0, Math.max(0, max)).map((path) => {
    const parent = path.slice(0, Math.max(0, path.length - "SKILL.md".length)).replace(/\/$/, "");
    return { path, subdir: parent || null };
  });
  return { found, total: all.length };
}

/** True when `path` lies inside `folder` (whole segments; the root folder `null` holds everything). */
export function isInFolder(path: string, folder: string | null): boolean {
  if (!folder) return true;
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * For each found skill folder, the nearest OTHER found folder that contains it — importing that one
 * also brings this folder's files (§64.2 warning). The repository root contains every other folder.
 * Keyed by subdir ("" for the root); a value of "" means the root.
 */
export function nestedSkillFolders(subdirs: readonly (string | null)[]): Map<string, string> {
  const set = new Set(subdirs.map((s) => s ?? ""));
  const out = new Map<string, string>();
  for (const raw of set) {
    if (raw === "") continue;
    const segs = raw.split("/");
    for (let i = segs.length - 1; i >= 0; i--) {
      const ancestor = segs.slice(0, i).join("/");
      if (set.has(ancestor)) {
        out.set(raw, ancestor);
        break;
      }
    }
  }
  return out;
}

// ── Last changed (§64.3) ──────────────────────────────────────────────────────────────────────

export interface LogCommit {
  /** The commit date, ISO 8601 as git prints it (`%cI`). */
  date: string;
  paths: string[];
}

/**
 * Parse `git log --format=%x00%cI --name-only --no-renames` output: each record starts with a NUL,
 * then the date line, then one changed path per line. Newest commit first, as git prints it.
 */
export function parseNameOnlyLog(out: string): LogCommit[] {
  const commits: LogCommit[] = [];
  for (const rec of out.split("\0")) {
    const lines = rec.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const [date, ...paths] = lines;
    if (!date || Number.isNaN(Date.parse(date))) continue;
    commits.push({ date, paths });
  }
  return commits;
}

/**
 * The newest commit date that touched each folder (`null` = the root), walking `commits` newest
 * first. Prefixes match on whole segments, so `skills/pdf` never takes a change to
 * `skills/pdf-tools`. A folder no commit touched is absent from the result.
 */
export function lastChangedByFolder(commits: readonly LogCommit[], folders: readonly (string | null)[]): Map<string, string> {
  const wanted = new Set(folders.map((f) => f ?? ""));
  const out = new Map<string, string>();
  for (const c of commits) {
    if (out.size === wanted.size) break;
    for (const p of c.paths) {
      if (wanted.has("") && !out.has("")) out.set("", c.date);
      const segs = p.split("/");
      for (let i = 1; i < segs.length; i++) {
        const prefix = segs.slice(0, i).join("/");
        if (wanted.has(prefix) && !out.has(prefix)) out.set(prefix, c.date);
      }
    }
  }
  return out;
}

// ── Importability (§64.1 decisions 5–6) ───────────────────────────────────────────────────────

export type ImportReason = "no_name" | "no_description" | "invalid_name" | "exists";

/** Why a found SKILL.md can't be imported from its frontmatter alone, or null when it can. */
export function frontmatterImportReason(fm: Record<string, string>): Exclude<ImportReason, "exists"> | null {
  if (!fm.name?.trim()) return "no_name";
  if (!fm.description?.trim()) return "no_description";
  if (!isImportableName(fm.name.trim())) return "invalid_name";
  return null;
}

/** The pick page's sentence for a row that can't be ticked (§64.2). */
export function importReasonText(reason: ImportReason, opts: { name?: string | null; match?: { ns: string; slug: string } | null } = {}): string {
  switch (reason) {
    case "no_name":
      return "Can't import: SKILL.md has no name";
    case "no_description":
      return "Can't import: SKILL.md has no description";
    case "invalid_name":
      return `Can't import: name ‹${opts.name ?? ""}› isn't a valid skill slug`;
    case "exists":
      return opts.match ? `Already in skilly as ${opts.match.ns}/${opts.match.slug}` : "Already in skilly";
  }
}

/** One row of the scan response (§64.3). */
export interface ScannedSkill {
  path: string;
  subdir: string | null;
  name: string | null;
  description: string | null;
  /** The newest commit date that touched the folder, or null when not found / unknown. */
  lastChangedAt: string | null;
  /** Set when the folder wasn't touched within the fetched history: the oldest fetched commit's date. */
  lastChangedBefore: string | null;
  importable: boolean;
  reason?: ImportReason;
  match?: { ns: string; slug: string; sameSource: boolean };
  /** The nearest other found folder that contains this one ("" = the repository root). */
  nestedIn?: string;
  /** Frontmatter fields the wizard pre-fills from (§64.4). */
  frontmatter?: { usageExamples: string | null; category: string | null; version: string | null };
}

export interface ScanResult {
  commit: string | null;
  total: number;
  shown: number;
  historyCommits: number;
  historyComplete: boolean;
  skills: ScannedSkill[];
}

/**
 * Tick all importable (§64.2): the first `max` importable rows in path order, never two with the
 * same name (the first one in path order wins). Returns the ticked paths.
 */
export function tickAllImportable(rows: readonly Pick<ScannedSkill, "path" | "name" | "importable">[], max: number = IMPORT_MAX_SKILLS): string[] {
  const out: string[] = [];
  const names = new Set<string>();
  for (const r of [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (out.length >= max) break;
    if (!r.importable || !r.name || names.has(r.name)) continue;
    names.add(r.name);
    out.push(r.path);
  }
  return out;
}

/** For each unticked importable row, the ticked row with the same name that disables it (§64.2). */
export function sameNameBlockers(rows: readonly Pick<ScannedSkill, "path" | "name">[], ticked: ReadonlySet<string>): Map<string, string> {
  const tickedByName = new Map<string, string>();
  for (const r of rows) if (r.name && ticked.has(r.path)) tickedByName.set(r.name, r.path);
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!r.name || ticked.has(r.path)) continue;
    const other = tickedByName.get(r.name);
    if (other && other !== r.path) out.set(r.path, other);
  }
  return out;
}

// ── Wizard pre-fill (§64.4) ───────────────────────────────────────────────────────────────────

/** A kebab/snake slug as a title: separators → spaces, each word capitalized
 *  ("case-study-creator" → "Case Study Creator"). */
export function titleize(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

export interface ImportPrefill {
  skillSlug: string;
  title: string;
  description: string;
  usageExamples: string;
  categories: string[];
  semver: string;
  toolHarness: string;
}

/** The wizard step's values from the SKILL.md frontmatter, before any AI draft (§64.4). */
export function importPrefill(
  skill: Pick<ScannedSkill, "name" | "description" | "frontmatter">,
  toolHarness: string,
): ImportPrefill {
  const name = (skill.name ?? "").trim();
  const category = skill.frontmatter?.category?.trim() ?? "";
  const version = skill.frontmatter?.version?.trim() ?? "";
  return {
    skillSlug: name,
    title: titleize(name),
    description: (skill.description ?? "").trim(),
    usageExamples: skill.frontmatter?.usageExamples?.trim() ?? "",
    categories: category && !categoryNameError(category) ? [category.toLowerCase()] : [],
    semver: version && isValidSemver(version) ? version : "1.0.0",
    toolHarness,
  };
}

// ── Submit (§64.6) ────────────────────────────────────────────────────────────────────────────

export type ImportOutcome = "proposed" | "published" | "routed" | "failed";

export interface ImportItemResult {
  subdir: string | null;
  slug: string;
  outcome: ImportOutcome;
  proposalId?: string;
  routedReason?: "content_risk" | "policy" | "scan_pending";
  error?: string;
  code?: string;
}

export interface ImportSubmitResult {
  importId: string;
  commit: string | null;
  results: ImportItemResult[];
}

/** The repository as people read it: `owner/repo` from a git URL (host dropped, `.git` trimmed). */
export function repoLabel(originUrl: string): string {
  const raw = originUrl.trim();
  // String scanning, not one regex over the whole URL (js/polynomial-redos on runs of `/`).
  const scheme = raw.indexOf("://");
  if (scheme <= 0 || !/^[a-z]+$/i.test(raw.slice(0, scheme))) return raw;
  const rest = raw.slice(scheme + 3);
  const slash = rest.indexOf("/");
  if (slash <= 0) return raw;
  let path = trimSlashes(rest.slice(slash + 1));
  if (path.toLowerCase().endsWith(".git")) path = path.slice(0, -4);
  return path || raw;
}

// ── Notifications (§64.7) ─────────────────────────────────────────────────────────────────────

export const IMPORT_NEEDS_REVIEW = "proposal.import_needs_review";
export const IMPORT_SUBMITTED = "proposal.import_submitted";

export interface ImportNotificationContent {
  sentence: string;
  ctaLabel: string;
  path: string;
}

/**
 * The §12 wording of the two import notifications, shared by the in-app inbox, the email renderer
 * and the digest. Payload keys: `importId`, `ns`, `repo`, `count`, `fromName`. Null for any other type.
 */
export function importNotificationContent(type: string, payload: Record<string, unknown>): ImportNotificationContent | null {
  if (type !== IMPORT_NEEDS_REVIEW && type !== IMPORT_SUBMITTED) return null;
  const importId = typeof payload.importId === "string" ? payload.importId : "";
  const repo = typeof payload.repo === "string" && payload.repo ? payload.repo : "a repository";
  const ns = typeof payload.ns === "string" && payload.ns ? payload.ns : "a namespace";
  const count = typeof payload.count === "number" ? payload.count : 0;
  const skills = `${count} skill${count === 1 ? "" : "s"}`;
  if (type === IMPORT_NEEDS_REVIEW) {
    const from = typeof payload.fromName === "string" && payload.fromName ? payload.fromName : "Someone";
    return {
      sentence: `${from} imported ${skills} from ${repo} into ${ns}. ${count === 1 ? "It is" : "They are"} awaiting your review.`,
      ctaLabel: count === 1 ? "Review it" : "Review them",
      path: `/proposals?tab=review&import=${encodeURIComponent(importId)}`,
    };
  }
  return {
    sentence: `Your import of ${skills} from ${repo} was submitted and is awaiting review.`,
    ctaLabel: count === 1 ? "View it" : "View them",
    path: `/proposals?tab=mine&import=${encodeURIComponent(importId)}`,
  };
}
