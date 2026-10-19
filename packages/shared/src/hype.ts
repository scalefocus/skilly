// Hype — a weekly boost for new and small skills (SKILLY_SPEC.md §50). The pure rules: the
// early-hype bonus tiers, the five platform settings (ranges, defaults, validation), the hard/soft
// eligibility rules, the board's total order, the refusal copy, and the SQL fragments the web tier
// and the worker sweep both run — so the two tiers can never disagree about what "eligible" or
// "rank 3" means. Client-safe (subpath export `@skilly/shared/hype`): strings and pure functions only.

// ── The window ─────────────────────────────────────────────────────────────────────────────────

/** The rolling window (§50.1 decision 6): a hype counts for exactly this long, then ages out. */
export const HYPE_WINDOW_DAYS = 7;
export const HYPE_WINDOW_MS = HYPE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** The same window as a Postgres interval literal, for the SQL below. */
export const HYPE_WINDOW_SQL = `interval '${HYPE_WINDOW_DAYS} days'`;

/** How many hypers the board row and the detail page show before the "+N" chip (§50.6). */
export const HYPE_STRIP_LIMIT = 12;

// ── Scoring — the early-hype bonus (§50.4) ─────────────────────────────────────────────────────

/** In-window hypes the skill ALREADY has → the points the next hype earns. A code constant, not
 *  a setting (§50.4). Ordered; the first tier whose `upTo` covers the count wins. */
export const HYPE_TIERS: readonly { upTo: number; points: 1 | 2 | 3 }[] = [
  { upTo: 4, points: 3 },
  { upTo: 14, points: 2 },
  { upTo: Number.POSITIVE_INFINITY, points: 1 },
];

/** The points a new hype earns when the skill already has `existing` in-window hypes. */
export function hypePointsFor(existing: number): 1 | 2 | 3 {
  const n = Number.isFinite(existing) && existing > 0 ? Math.floor(existing) : 0;
  for (const t of HYPE_TIERS) if (n <= t.upTo) return t.points;
  return 1;
}

// ── Settings (§50.8) ───────────────────────────────────────────────────────────────────────────

export interface HypeSettings {
  enabled: boolean;
  /** Hypes per user per trailing 7 days. */
  budget: number;
  /** A skill is open to new hypes while its first publication is at most this many days old. */
  recencyDays: number;
  /** …and while it has fewer than this many installs. */
  installThreshold: number;
  /** How many skills count as Hyped (marker, home section, notification). */
  topN: number;
}

/** The platform_settings key behind each field. */
export const HYPE_SETTING_KEYS: Record<keyof HypeSettings, string> = {
  enabled: "hype_enabled",
  budget: "hype_budget",
  recencyDays: "hype_recency_days",
  installThreshold: "hype_install_threshold",
  topN: "hype_top_n",
};

/** The API field (GET/PATCH /api/admin/settings) behind each field. */
export const HYPE_SETTING_FIELDS: Record<keyof HypeSettings, string> = {
  enabled: "hypeEnabled",
  budget: "hypeBudget",
  recencyDays: "hypeRecencyDays",
  installThreshold: "hypeInstallThreshold",
  topN: "hypeTopN",
};

export const DEFAULT_HYPE_SETTINGS: HypeSettings = { enabled: true, budget: 3, recencyDays: 90, installThreshold: 25, topN: 5 };

/** Inclusive whole-number ranges for the four numeric settings (§50.8). */
export const HYPE_SETTING_RANGES: Record<Exclude<keyof HypeSettings, "enabled">, { min: number; max: number; label: string }> = {
  budget: { min: 1, max: 10, label: "Hypes per week" },
  recencyDays: { min: 7, max: 365, label: "Recency window (days)" },
  installThreshold: { min: 1, max: 10_000, label: "Install threshold" },
  topN: { min: 1, max: 20, label: "Top N" },
};

export class HypeSettingError extends Error {}

function parseRanged(field: Exclude<keyof HypeSettings, "enabled">, raw: unknown): number {
  const r = HYPE_SETTING_RANGES[field];
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < r.min || n > r.max) {
    throw new HypeSettingError(`${r.label} must be a whole number between ${r.min} and ${r.max}`);
  }
  return n;
}

/** Read the five settings from a key getter, falling back to the default on anything malformed. */
export function coerceHypeSettings(get: (key: string) => unknown): HypeSettings {
  const ranged = (f: Exclude<keyof HypeSettings, "enabled">): number => {
    try {
      return parseRanged(f, get(HYPE_SETTING_KEYS[f]));
    } catch {
      return DEFAULT_HYPE_SETTINGS[f];
    }
  };
  return {
    enabled: get(HYPE_SETTING_KEYS.enabled) !== false,
    budget: ranged("budget"),
    recencyDays: ranged("recencyDays"),
    installThreshold: ranged("installThreshold"),
    topN: ranged("topN"),
  };
}

/** True when the PATCH body carries at least one hype field. */
export function hasHypeSettings(body: Record<string, unknown>): boolean {
  return Object.values(HYPE_SETTING_FIELDS).some((f) => body[f] !== undefined);
}

/**
 * Validate every hype field present in a PATCH body BEFORE anything is written (§50.8: 422 on the
 * first bad one). Returns only the fields that were present. Throws HypeSettingError.
 */
export function parseHypeSettingsPatch(body: Record<string, unknown>): Partial<HypeSettings> {
  const out: Partial<HypeSettings> = {};
  const enabled = body[HYPE_SETTING_FIELDS.enabled];
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") throw new HypeSettingError("hypeEnabled must be true or false");
    out.enabled = enabled;
  }
  for (const f of ["budget", "recencyDays", "installThreshold", "topN"] as const) {
    const v = body[HYPE_SETTING_FIELDS[f]];
    if (v !== undefined) out[f] = parseRanged(f, v);
  }
  return out;
}

/** The Administration card header's live summary (§50.8), e.g. `on · 3 / week · ≤ 90 d · < 25 installs · top 5`. */
export function hypeSettingsSummary(s: HypeSettings): string {
  if (!s.enabled) return "off";
  return `on · ${s.budget} / week · ≤ ${s.recencyDays} d · < ${s.installThreshold} installs · top ${s.topN}`;
}

// ── Eligibility (§50.2) ────────────────────────────────────────────────────────────────────────

export interface HypeHardFacts {
  visibility: "org" | "namespace";
  status: "active" | "archived";
  deprecatedAt: string | Date | null;
  /** ≥ 1 active, git-served version (the `latestInstallable` rule Featured uses, §7). */
  installable: boolean;
}

/** Hard eligibility: failing it drops the skill from EVERY hype surface at once (§50.1 decision 8). */
export function isHypeEligible(s: HypeHardFacts): boolean {
  return s.visibility === "org" && s.status === "active" && s.deprecatedAt == null && s.installable;
}

export interface HypeSoftFacts {
  /** `skills.created_at` — a skill row exists only once its first version materialises (§8). */
  createdAt: string | Date;
  installCount: number;
}

/** Soft eligibility: open to NEW hypes (young and small). Outgrowing it never removes existing hypes. */
export function isHypeOpen(s: HypeSoftFacts, settings: Pick<HypeSettings, "recencyDays" | "installThreshold">, now: Date = new Date()): boolean {
  const created = new Date(s.createdAt).getTime();
  if (Number.isNaN(created)) return false;
  const ageMs = now.getTime() - created;
  return ageMs <= settings.recencyDays * 24 * 60 * 60 * 1000 && s.installCount < settings.installThreshold;
}

/** When a hype placed at `at` ages out of the window. */
export function hypeExpiresAt(at: string | Date): Date {
  return new Date(new Date(at).getTime() + HYPE_WINDOW_MS);
}

// ── Refusals (§50.2 / §50.6) ───────────────────────────────────────────────────────────────────

export type HypeRefusal = "not_eligible" | "self_hype" | "already_hyped" | "budget_exhausted";

/** The inline toast a stale page shows for each 409 reason. `{date}` is replaced by the caller
 *  with `nextAt` formatted in the viewer's own timezone and style (never server-side). */
export const HYPE_REFUSAL_COPY: Record<HypeRefusal, string> = {
  not_eligible: "This skill is no longer open to hypes.",
  self_hype: "You maintain this skill, so you can't hype it.",
  already_hyped: "You already hyped this skill this week.",
  budget_exhausted: "You're out of hypes until {date}.",
};

// ── The board's total order (§50.5) ────────────────────────────────────────────────────────────

export interface HypeRankable {
  score: number;
  hypeCount: number;
  /** The earliest in-window hype on the skill. */
  firstHypeAt: string | Date;
  namespaceSlug: string;
  skillSlug: string;
}

/** Score desc, hype count desc, earliest in-window hype asc, then namespace slug and skill slug asc — total and deterministic. */
export function compareHypeRows(a: HypeRankable, b: HypeRankable): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.hypeCount !== b.hypeCount) return b.hypeCount - a.hypeCount;
  const fa = new Date(a.firstHypeAt).getTime();
  const fb = new Date(b.firstHypeAt).getTime();
  if (fa !== fb) return fa - fb;
  // Byte order (the SQL uses COLLATE "C"), namespace first, so the two tiers sort identically.
  if (a.namespaceSlug !== b.namespaceSlug) return a.namespaceSlug < b.namespaceSlug ? -1 : 1;
  return a.skillSlug < b.skillSlug ? -1 : a.skillSlug > b.skillSlug ? 1 : 0;
}

// ── Shared SQL (web + worker) ──────────────────────────────────────────────────────────────────

/** Hard eligibility as a predicate on a `skills` alias (§50.2) — org-visible, active, not
 *  deprecated, with an installable version. */
export function hypeHardEligibleSql(s: string): string {
  return (
    `${s}.visibility = 'org' and ${s}.status = 'active' and ${s}.deprecated_at is null` +
    ` and exists (select 1 from skill_versions hv where hv.skill_id = ${s}.id and hv.status = 'active' and hv.git_published)`
  );
}

/**
 * The board (§50.5): every hard-eligible skill with ≥ 1 in-window hype, in the §50.5 total order,
 * limited by the bound parameter `$<limitParam>`. Columns: skill_id, namespace_slug, skill_slug,
 * score, hype_count, first_hype_at.
 */
export function hypeBoardSql(limitParam: number): string {
  return `select h.skill_id, n.slug as namespace_slug, s.slug as skill_slug,
                 sum(h.points)::int as score, count(*)::int as hype_count, min(h.created_at) as first_hype_at
            from skill_hypes h
            join skills s on s.id = h.skill_id
            join namespaces n on n.id = s.namespace_id
           where h.created_at > now() - ${HYPE_WINDOW_SQL}
             and ${hypeHardEligibleSql("s")}
           group by h.skill_id, n.slug, s.slug
           order by score desc, hype_count desc, first_hype_at asc, n.slug collate "C" asc, s.slug collate "C" asc
           limit $${limitParam}`;
}

/**
 * A skill's EFFECTIVE maintainers (§19) as a one-column `user_id` set: the explicit
 * `skill_maintainers` rows ∪ the owning namespace's admins (resolved live from role_mappings).
 * The self-hype rule (§50.2), the `skill.hyped` recipients (§50.7) and the `hype_train` award (§50.9)
 * all read this one definition. `skillExpr` / `namespaceExpr` are trusted SQL (columns or `$n`).
 */
export function effectiveMaintainerIdsSql(skillExpr: string, namespaceExpr: string): string {
  return `select em_sm.user_id from skill_maintainers em_sm where em_sm.skill_id = ${skillExpr}
          union
          select em_gm.user_id
            from role_mappings em_rm
            join group_memberships em_gm on em_gm.group_id = em_rm.group_id
           where em_rm.namespace_id = ${namespaceExpr} and em_rm.role = 'namespace_admin'`;
}
