// Hype — the web tier (SKILLY_SPEC.md §50): placing a hype under the rolling budget, the per-skill
// detail block, the hyper list, the Hyped-skills board (cached 60 s), the catalog's per-card counts,
// the home feed's top-N ids, and the five admin settings. The pure rules and the SQL both tiers run
// live in `@skilly/shared/hype`; the worker's sweep (packages/worker/src/hype.ts) owns the top-N
// state (`skill_hype_top`), the `skill.hyped` notification and the two awards.
//
// Hypes are ordinary personal rows — never audited (§50.1 decision 12). Only the settings are.
import type { Pool, PoolClient } from "pg";
import {
  DEFAULT_HYPE_SETTINGS,
  HYPE_SETTING_KEYS,
  HYPE_STRIP_LIMIT,
  HYPE_WINDOW_SQL,
  HypeSettingError,
  coerceHypeSettings,
  effectiveMaintainerIdsSql,
  hypeBoardSql,
  hypeExpiresAt,
  hypeHardEligibleSql,
  hypePointsFor,
  isHypeEligible,
  isHypeOpen,
  parseHypeSettingsPatch,
  type HypeRefusal,
  type HypeSettings,
} from "@skilly/shared/hype";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { awardAchievement } from "./achievements";
import { createTtlCache } from "./ttlCache";
import type { SkillIconView } from "./catalog";
import { nameSql } from "./userLabel";
import { LEADERBOARD_LIMIT } from "./leaderboard";

type Db = Pool | PoolClient;

// ── Settings (§50.8) ───────────────────────────────────────────────────────────────────────────

// Read by the skill page, /api/me and every hype route, so the default-pool read is cached briefly
// per replica; updateHypeSettings invalidates it. A non-default `db` (tests, a transaction) bypasses it.
const HYPE_SETTINGS_TTL_MS = 5_000;
const settingsCache = createTtlCache<HypeSettings>(HYPE_SETTINGS_TTL_MS);

/** Drop the cached hype settings — call after any write to the hype keys. */
export function invalidateHypeSettings(): void {
  settingsCache.clear();
}

export async function getHypeSettings(db: Db = pool): Promise<HypeSettings> {
  if (db !== pool) return loadHypeSettings(db);
  return { ...(await settingsCache.get("all", () => loadHypeSettings(pool))) };
}

async function loadHypeSettings(db: Db): Promise<HypeSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `select key, value from platform_settings where key = any($1::text[])`,
    [Object.values(HYPE_SETTING_KEYS)],
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return coerceHypeSettings((k) => map.get(k));
}

export type HypeSettingsResult = { ok: true; settings: HypeSettings } | { ok: false; status: number; error: string };

/**
 * Save the hype fields of a PATCH /api/admin/settings body. Platform admin only (re-verified).
 * Every present field is validated before anything is written (422 on the first bad one); each
 * CHANGED key is then written and audited as `settings.updated` (before → after), like §48.11.
 */
export async function updateHypeSettings(
  access: { userId: string | null; isPlatformAdmin: boolean } | null,
  body: Record<string, unknown>,
  db: Pool = pool,
): Promise<HypeSettingsResult> {
  if (!access?.userId || !access.isPlatformAdmin) return { ok: false, status: 403, error: "platform admin required" };
  let next: Partial<HypeSettings>;
  try {
    next = parseHypeSettingsPatch(body);
  } catch (e) {
    if (e instanceof HypeSettingError) return { ok: false, status: 422, error: e.message };
    throw e;
  }
  const before = await loadHypeSettings(db);
  for (const k of Object.keys(next) as (keyof HypeSettings)[]) {
    const after = next[k]!;
    if (after === before[k]) continue;
    const key = HYPE_SETTING_KEYS[k];
    await db.query(
      `insert into platform_settings (key, value, updated_by, updated_at)
       values ($1, $2::jsonb, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [key, JSON.stringify(after), access.userId],
    );
    await appendAudit(db, {
      actorUserId: access.userId,
      action: "settings.updated",
      targetType: "platform_settings",
      targetId: key,
      before: { [key]: before[k] },
      after: { [key]: after },
    });
  }
  invalidateHypeSettings();
  invalidateHypeBoard();
  return { ok: true, settings: await getHypeSettings(db) };
}

// ── The viewer's rolling budget (§50.2) ────────────────────────────────────────────────────────

export interface HypeBudget {
  budget: number;
  used: number;
  remaining: number;
  /** When the next hype frees up (UTC ISO) — only while none remain; null otherwise. */
  nextAt: string | null;
}

/** The caller's in-window hypes vs the budget. A lowered budget can leave `used > budget`; the
 *  slot then frees when enough of the oldest rows have aged out (`rows[used - budget]`). */
export async function viewerHypeBudget(db: Db, userId: string, budget: number): Promise<HypeBudget> {
  const { rows } = await db.query<{ created_at: Date }>(
    `select created_at from skill_hypes where user_id = $1 and created_at > now() - ${HYPE_WINDOW_SQL} order by created_at asc`,
    [userId],
  );
  const used = rows.length;
  const remaining = Math.max(0, budget - used);
  const nextAt = remaining > 0 || used === 0 ? null : hypeExpiresAt(rows[Math.max(0, used - budget)]!.created_at).toISOString();
  return { budget, used, remaining, nextAt };
}

// ── Facts about one skill ──────────────────────────────────────────────────────────────────────

interface SkillHypeFacts {
  id: string;
  namespaceId: string;
  visibility: "org" | "namespace";
  status: "active" | "archived";
  deprecatedAt: Date | null;
  createdAt: Date;
  installCount: number;
  installable: boolean;
}

async function skillHypeFacts(db: Db, skillId: string): Promise<SkillHypeFacts | null> {
  const { rows } = await db.query<{
    id: string; namespace_id: string; visibility: "org" | "namespace"; status: "active" | "archived";
    deprecated_at: Date | null; created_at: Date; install_count: string; installable: boolean;
  }>(
    `select s.id, s.namespace_id, s.visibility, s.status, s.deprecated_at, s.created_at, s.install_count::text as install_count,
            exists (select 1 from skill_versions v where v.skill_id = s.id and v.status = 'active' and v.git_published) as installable
       from skills s where s.id = $1`,
    [skillId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, namespaceId: r.namespace_id, visibility: r.visibility, status: r.status, deprecatedAt: r.deprecated_at,
    createdAt: r.created_at, installCount: Number(r.install_count), installable: r.installable,
  };
}

/** Is `userId` an effective maintainer (§19) of the skill? The self-hype rule (§50.2). */
export async function isEffectiveMaintainer(db: Db, skillId: string, namespaceId: string, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ yes: boolean }>(
    `select exists (select 1 from (${effectiveMaintainerIdsSql("$1", "$2")}) em where em.user_id = $3) as yes`,
    [skillId, namespaceId, userId],
  );
  return rows[0]?.yes === true;
}

// ── Placing a hype (§50.2) ─────────────────────────────────────────────────────────────────────

export type PlaceHypeResult =
  | { ok: true; points: number; score: number; hypeCount: number; remaining: number; nextAt: string | null }
  | { ok: false; status: 404 }
  | { ok: false; status: 409; reason: HypeRefusal; nextAt: string | null };

/**
 * Place one hype by `userId` on `skillId`. The caller has already checked visibility and that the
 * feature is on. Every rule is re-verified inside ONE transaction under a per-user advisory lock,
 * so two tabs can never double-spend the budget or double-hype a skill (§50.2 Concurrency).
 */
export async function placeHype(userId: string, skillId: string, settings: HypeSettings): Promise<PlaceHypeResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext('hype:' || $1::text))`, [userId]);

    const facts = await skillHypeFacts(client, skillId);
    if (!facts) {
      await client.query("rollback");
      return { ok: false, status: 404 };
    }
    const refuse = async (reason: HypeRefusal, nextAt: string | null = null): Promise<PlaceHypeResult> => {
      await client.query("rollback");
      return { ok: false, status: 409, reason, nextAt };
    };
    if (!isHypeEligible(facts) || !isHypeOpen(facts, settings)) return refuse("not_eligible");
    if (await isEffectiveMaintainer(client, facts.id, facts.namespaceId, userId)) return refuse("self_hype");

    const mine = await client.query<{ created_at: Date }>(
      `select created_at from skill_hypes
        where user_id = $1 and skill_id = $2 and created_at > now() - ${HYPE_WINDOW_SQL}
        order by created_at desc limit 1`,
      [userId, skillId],
    );
    if (mine.rows[0]) return refuse("already_hyped", hypeExpiresAt(mine.rows[0].created_at).toISOString());

    const before = await viewerHypeBudget(client, userId, settings.budget);
    if (before.remaining === 0) return refuse("budget_exhausted", before.nextAt);

    const existing = await client.query<{ n: number }>(
      `select count(*)::int as n from skill_hypes where skill_id = $1 and created_at > now() - ${HYPE_WINDOW_SQL}`,
      [skillId],
    );
    const points = hypePointsFor(existing.rows[0]?.n ?? 0);
    await client.query(`insert into skill_hypes (skill_id, user_id, points) values ($1, $2, $3)`, [skillId, userId, points]);
    // §31.12 Hype Squad — the act of hyping, in the hype's own transaction (a refusal never gets here).
    await awardAchievement(client, userId, "first_hype");

    const totals = await client.query<{ score: number; hype_count: number }>(
      `select coalesce(sum(points), 0)::int as score, count(*)::int as hype_count
         from skill_hypes where skill_id = $1 and created_at > now() - ${HYPE_WINDOW_SQL}`,
      [skillId],
    );
    const after = await viewerHypeBudget(client, userId, settings.budget);
    await client.query("commit");
    invalidateHypeBoard();
    return { ok: true, points, score: totals.rows[0]!.score, hypeCount: totals.rows[0]!.hype_count, remaining: after.remaining, nextAt: after.nextAt };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Hypers (§50.6) ─────────────────────────────────────────────────────────────────────────────

export interface HyperView {
  userId: string;
  displayName: string;
  avatar: string | null;
  createdAt: string;
}

/** The skill's in-window hypers, newest first. `limit` null = all of them. */
export async function listHypers(skillId: string, limit: number | null = null, db: Db = pool): Promise<HyperView[]> {
  const { rows } = await db.query<{ user_id: string; display_name: string; avatar: string | null; created_at: Date }>(
    `select h.user_id, ${nameSql("u.display_name", "u.email")} as display_name, u.avatar, h.created_at
       from skill_hypes h join users u on u.id = h.user_id
      where h.skill_id = $1 and h.created_at > now() - ${HYPE_WINDOW_SQL}
      order by h.created_at desc, h.id desc
      ${limit == null ? "" : "limit $2"}`,
    limit == null ? [skillId] : [skillId, limit],
  );
  return rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, avatar: r.avatar, createdAt: new Date(r.created_at).toISOString() }));
}

// ── The detail page block (§50.6) ──────────────────────────────────────────────────────────────

export interface HypeDetail {
  /** Hard eligibility — false ⇒ the page renders no hype UI at all. */
  eligible: boolean;
  /** Soft eligibility — open to NEW hypes (young and small). */
  open: boolean;
  isMaintainer: boolean;
  hypedByMe: boolean;
  /** When the viewer's hype on this skill ages out (they may hype it again), or null. */
  myHypeExpiresAt: string | null;
  canHype: boolean;
  budget: number;
  remaining: number;
  /** When the viewer's next hype frees up, while none remain. */
  nextAt: string | null;
  score: number;
  hypeCount: number;
  /** Hyped as of the last sweep (§50.5). */
  isTop: boolean;
  hypers: HyperView[];
  hyperTotal: number;
}

/**
 * The detail payload's `hype` block, or null when the feature is off or the skill is hard-ineligible
 * (§50.6: nothing renders). The caller has already enforced visibility.
 */
export async function hypeDetail(skillId: string, viewerUserId: string | null, db: Db = pool): Promise<HypeDetail | null> {
  const settings = await getHypeSettings(db);
  if (!settings.enabled) return null;
  const facts = await skillHypeFacts(db, skillId);
  if (!facts || !isHypeEligible(facts)) return null;

  const [totals, top, hypers, mine, budget, isMaintainer] = await Promise.all([
    db.query<{ score: number; hype_count: number }>(
      `select coalesce(sum(points), 0)::int as score, count(*)::int as hype_count
         from skill_hypes where skill_id = $1 and created_at > now() - ${HYPE_WINDOW_SQL}`,
      [skillId],
    ),
    db.query<{ yes: boolean }>(`select exists (select 1 from skill_hype_top where skill_id = $1 and left_at is null) as yes`, [skillId]),
    listHypers(skillId, HYPE_STRIP_LIMIT, db),
    viewerUserId
      ? db.query<{ created_at: Date }>(
          `select created_at from skill_hypes where user_id = $1 and skill_id = $2 and created_at > now() - ${HYPE_WINDOW_SQL}
            order by created_at desc limit 1`,
          [viewerUserId, skillId],
        )
      : Promise.resolve({ rows: [] as { created_at: Date }[] }),
    viewerUserId ? viewerHypeBudget(db, viewerUserId, settings.budget) : Promise.resolve({ budget: settings.budget, used: 0, remaining: 0, nextAt: null }),
    viewerUserId ? isEffectiveMaintainer(db, facts.id, facts.namespaceId, viewerUserId) : Promise.resolve(false),
  ]);
  const open = isHypeOpen(facts, settings);
  const myHype = mine.rows[0] ?? null;
  const hypedByMe = myHype != null;
  return {
    eligible: true,
    open,
    isMaintainer,
    hypedByMe,
    myHypeExpiresAt: myHype ? hypeExpiresAt(myHype.created_at).toISOString() : null,
    canHype: !!viewerUserId && open && !isMaintainer && !hypedByMe && budget.remaining > 0,
    budget: settings.budget,
    remaining: budget.remaining,
    nextAt: budget.nextAt,
    score: totals.rows[0]!.score,
    hypeCount: totals.rows[0]!.hype_count,
    isTop: top.rows[0]?.yes === true,
    hypers,
    hyperTotal: totals.rows[0]!.hype_count,
  };
}

// ── The board (§50.5) ──────────────────────────────────────────────────────────────────────────

export interface HypeBoardRow {
  rank: number;
  skillId: string;
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  icon: SkillIconView | null;
  score: number;
  hypeCount: number;
  firstHypeAt: string;
  /** Hyped as of the last sweep (`skill_hype_top.left_at IS NULL`) — not the live rank (§50.5). */
  isTop: boolean;
  hypers: Omit<HyperView, "createdAt">[];
  hyperTotal: number;
  /** Soft eligibility and the namespace, kept server-side for the per-viewer overlay. */
  open: boolean;
  namespaceId: string;
}

export interface HypeBoardViewerRow extends Omit<HypeBoardRow, "namespaceId"> {
  canHype: boolean;
  hypedByMe: boolean;
  /** The viewer maintains this skill — the button is hidden, like on the detail page. */
  isMaintainer: boolean;
}

const boardCache = createTtlCache<HypeBoardRow[]>(60_000);

/** The catalog's `iconView` (§33), repeated here because catalog.ts imports this module. */
function iconOf(sha256: string | null, emoji: string | null): SkillIconView | null {
  return sha256 || emoji ? { url: sha256 ? `/skill-icons/${sha256}.png` : null, emoji: emoji ?? null } : null;
}

export function invalidateHypeBoard(): void {
  boardCache.clear();
}

/** The viewer-independent board, cached 60 s. Empty while the feature is off. */
export async function getHypeBoard(db: Db = pool): Promise<HypeBoardRow[]> {
  return boardCache.get("board", () => loadHypeBoard(db));
}

async function loadHypeBoard(db: Db): Promise<HypeBoardRow[]> {
  const settings = await getHypeSettings(db);
  if (!settings.enabled) return [];
  const { rows } = await db.query<{
    skill_id: string; namespace_slug: string; skill_slug: string; score: number; hype_count: number; first_hype_at: Date;
  }>(hypeBoardSql(1), [LEADERBOARD_LIMIT]);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.skill_id);

  const [meta, strips] = await Promise.all([
    db.query<{
      id: string; title: string; icon_sha256: string | null; icon_emoji: string | null; namespace_id: string;
      created_at: Date; install_count: string; top: boolean;
    }>(
      `select s.id, s.title, s.icon_sha256, s.icon_emoji, s.namespace_id, s.created_at, s.install_count::text as install_count,
              exists (select 1 from skill_hype_top t where t.skill_id = s.id and t.left_at is null) as top
         from skills s where s.id = any($1::uuid[])`,
      [ids],
    ),
    db.query<{ skill_id: string; user_id: string; display_name: string; avatar: string | null }>(
      `select skill_id, user_id, display_name, avatar from (
         select h.skill_id, h.user_id, ${nameSql("u.display_name", "u.email")} as display_name, u.avatar,
                row_number() over (partition by h.skill_id order by h.created_at desc, h.id desc) as rn
           from skill_hypes h join users u on u.id = h.user_id
          where h.skill_id = any($1::uuid[]) and h.created_at > now() - ${HYPE_WINDOW_SQL}
       ) x where rn <= $2
       order by skill_id, rn`,
      [ids, HYPE_STRIP_LIMIT],
    ),
  ]);
  const byId = new Map(meta.rows.map((m) => [m.id, m]));
  const stripBy = new Map<string, Omit<HyperView, "createdAt">[]>();
  for (const s of strips.rows) {
    const list = stripBy.get(s.skill_id) ?? [];
    list.push({ userId: s.user_id, displayName: s.display_name, avatar: s.avatar });
    stripBy.set(s.skill_id, list);
  }
  return rows.flatMap((r, i): HypeBoardRow[] => {
    const m = byId.get(r.skill_id);
    if (!m) return [];
    return [{
      rank: i + 1,
      skillId: r.skill_id,
      namespaceSlug: r.namespace_slug,
      skillSlug: r.skill_slug,
      title: m.title,
      icon: iconOf(m.icon_sha256, m.icon_emoji),
      score: r.score,
      hypeCount: r.hype_count,
      firstHypeAt: new Date(r.first_hype_at).toISOString(),
      isTop: m.top,
      hypers: stripBy.get(r.skill_id) ?? [],
      hyperTotal: r.hype_count,
      open: isHypeOpen({ createdAt: m.created_at, installCount: Number(m.install_count) }, settings),
      namespaceId: m.namespace_id,
    }];
  });
}

/** The board with the two per-viewer flags overlaid after the cache read (§50.5). */
export async function getHypeBoardForViewer(viewerUserId: string | null, db: Db = pool): Promise<{ rows: HypeBoardViewerRow[]; budget: HypeBudget | null; settings: HypeSettings }> {
  const settings = await getHypeSettings(db);
  if (!settings.enabled) return { rows: [], budget: null, settings };
  const board = await getHypeBoard(db);
  const budget = viewerUserId ? await viewerHypeBudget(db, viewerUserId, settings.budget) : null;
  let mine = new Set<string>();
  let maintained = new Set<string>();
  if (viewerUserId && board.length > 0) {
    const ids = board.map((r) => r.skillId);
    const [h, m] = await Promise.all([
      db.query<{ skill_id: string }>(
        `select distinct skill_id from skill_hypes where user_id = $1 and skill_id = any($2::uuid[]) and created_at > now() - ${HYPE_WINDOW_SQL}`,
        [viewerUserId, ids],
      ),
      db.query<{ id: string }>(
        `select s.id from skills s
          where s.id = any($2::uuid[])
            and exists (select 1 from (${effectiveMaintainerIdsSql("s.id", "s.namespace_id")}) em where em.user_id = $1)`,
        [viewerUserId, ids],
      ),
    ]);
    mine = new Set(h.rows.map((r) => r.skill_id));
    maintained = new Set(m.rows.map((r) => r.id));
  }
  const rows = board.map(({ namespaceId: _ns, ...r }): HypeBoardViewerRow => {
    const hypedByMe = mine.has(r.skillId);
    const isMaintainer = maintained.has(r.skillId);
    return {
      ...r,
      hypedByMe,
      isMaintainer,
      canHype: !!viewerUserId && r.open && !hypedByMe && !isMaintainer && (budget?.remaining ?? 0) > 0,
    };
  });
  return { rows, budget, settings };
}

/** The current Hyped set (as of the last sweep) in board order — the home section's ids (§50.6). */
export async function topHypedSkillIds(db: Db = pool): Promise<string[]> {
  return (await getHypeBoard(db)).filter((r) => r.isTop).map((r) => r.skillId);
}

// ── Catalog cards (§50.6) ──────────────────────────────────────────────────────────────────────

export interface HypeCardStat {
  count: number;
  top: boolean;
}

/**
 * One batched query for a page of catalog cards: the in-window hype count and the Hyped flag of each
 * hard-eligible skill that has either. Skills with neither are absent from the map. Empty while off.
 */
export async function hypeCardStats(skillIds: string[], db: Db = pool): Promise<Map<string, HypeCardStat>> {
  const out = new Map<string, HypeCardStat>();
  if (skillIds.length === 0) return out;
  const settings = await getHypeSettings(db);
  if (!settings.enabled) return out;
  const { rows } = await db.query<{ id: string; n: number; top: boolean }>(
    `select s.id,
            (select count(*) from skill_hypes h where h.skill_id = s.id and h.created_at > now() - ${HYPE_WINDOW_SQL})::int as n,
            exists (select 1 from skill_hype_top t where t.skill_id = s.id and t.left_at is null) as top
       from skills s
      where s.id = any($1::uuid[]) and ${hypeHardEligibleSql("s")}`,
    [skillIds],
  );
  for (const r of rows) if (r.n > 0 || r.top) out.set(r.id, { count: r.n, top: r.top });
  return out;
}

export { DEFAULT_HYPE_SETTINGS };
