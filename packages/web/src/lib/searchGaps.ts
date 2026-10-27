// Search gaps (SKILLY_SPEC.md §62): the platform-admin side — the gap list, the four settings, Run
// now, and the three decisions (create a Platform request, add a synonym, dismiss). Recording lives in
// @skilly/shared (search-gaps-db) and the sweep in the worker.
//
// Every decision re-reads the gap FOR UPDATE and checks the card's `expectedUpdatedAt` (409 when a
// sweep or another admin changed it), runs in one transaction with the request or synonym write,
// tombstones the query (never recorded or suggested again), deletes its stored counts and notifies the
// owners of any restricted match. The audit rows carry a hash of the query, never its text (§62.12).
import type { Pool, PoolClient } from "pg";
import {
  SEARCH_GAP_LOOKBACK_DAYS,
  SEARCH_GAP_MIN_SEARCHERS,
  SEARCH_GAP_SETTING_KEYS,
  SEARCH_GAP_SWEEP_HOURS,
  deleteGapCounts,
  effectiveMaintainerIdsSql,
  gapQueryHash,
  readSearchGapSettings,
  storedGapDraft,
  validateIntSetting,
  type GapKind,
  type GapMode,
  type GapOutcome,
  type GapState,
  type GapSurface,
  type GapTab,
  type SearchGapLastRun,
  type SearchGapSettings,
  type SearchGapStatus,
  type SearchGapView,
} from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { aiOperational } from "./ai";
import { createPlatformRequest, type RequestInput } from "./requests";
import { createSynonymGroup, updateSynonymGroup, SearchAdminError } from "./searchAdmin";

type Db = Pool | PoolClient;

export type GapResult<T = object> = ({ ok: true } & T) | { ok: false; status: 404 | 409 | 422; error: string };

const conflict = { ok: false as const, status: 409 as const, error: "This search gap changed since you opened it." };
const notFound = { ok: false as const, status: 404 as const, error: "not found" };

// ── Settings (§62.8) ───────────────────────────────────────────────────────────────────────────

/** The API field names of the four admin settings on GET|PATCH /api/admin/settings. */
export const SEARCH_GAP_FIELDS = {
  enabled: "searchGapsEnabled",
  sweepHours: "searchGapsSweepHours",
  minSearchers: "searchGapsMinSearchers",
  lookbackDays: "searchGapsLookbackDays",
} as const;

async function readSettingsMap(db: Db): Promise<Map<string, unknown>> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `select key, value from platform_settings where key = any($1::text[])`,
    [Object.values(SEARCH_GAP_SETTING_KEYS)],
  );
  return new Map(rows.map((r) => [r.key, r.value]));
}

export async function getSearchGapSettings(db: Db = pool): Promise<SearchGapSettings> {
  const map = await readSettingsMap(db);
  return readSearchGapSettings((k) => map.get(k));
}

export function searchGapSettingFields(s: SearchGapSettings): Record<string, unknown> {
  return {
    [SEARCH_GAP_FIELDS.enabled]: s.enabled,
    [SEARCH_GAP_FIELDS.sweepHours]: s.sweepHours,
    [SEARCH_GAP_FIELDS.minSearchers]: s.minSearchers,
    [SEARCH_GAP_FIELDS.lookbackDays]: s.lookbackDays,
  };
}

export function hasSearchGapSettings(body: Record<string, unknown>): boolean {
  return Object.values(SEARCH_GAP_FIELDS).some((f) => f in body);
}

/** Save the search-gap fields of a PATCH body: all validated first (422), each change audited. */
export async function updateSearchGapSettings(
  actorUserId: string,
  body: Record<string, unknown>,
  db: Pool = pool,
): Promise<{ ok: true } | { ok: false; status: 422; error: string }> {
  const next: Partial<SearchGapSettings> = {};
  if (SEARCH_GAP_FIELDS.enabled in body) {
    const v = body[SEARCH_GAP_FIELDS.enabled];
    if (typeof v !== "boolean") return { ok: false, status: 422, error: "searchGapsEnabled must be true or false" };
    next.enabled = v;
  }
  const ints: [keyof SearchGapSettings, string, typeof SEARCH_GAP_SWEEP_HOURS, string][] = [
    ["sweepHours", SEARCH_GAP_FIELDS.sweepHours, SEARCH_GAP_SWEEP_HOURS, "Run every (hours)"],
    ["minSearchers", SEARCH_GAP_FIELDS.minSearchers, SEARCH_GAP_MIN_SEARCHERS, "Minimum people"],
    ["lookbackDays", SEARCH_GAP_FIELDS.lookbackDays, SEARCH_GAP_LOOKBACK_DAYS, "Look back (days)"],
  ];
  for (const [k, field, range, label] of ints) {
    if (!(field in body)) continue;
    const v = validateIntSetting(body[field], range, label);
    if (!v.ok) return { ok: false, status: 422, error: v.error };
    (next as Record<string, number>)[k] = v.value;
  }
  const before = await getSearchGapSettings(db);
  for (const k of Object.keys(next) as (keyof SearchGapSettings)[]) {
    const after = next[k];
    if (after === before[k]) continue;
    const key = SEARCH_GAP_SETTING_KEYS[k];
    await db.query(
      `insert into platform_settings (key, value, updated_by, updated_at)
       values ($1, $2::jsonb, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [key, JSON.stringify(after), actorUserId],
    );
    await appendAudit(db, {
      actorUserId,
      action: "settings.updated",
      targetType: "platform_settings",
      targetId: key,
      before: { [key]: before[k] },
      after: { [key]: after },
    });
  }
  return { ok: true };
}

export async function getSearchGapStatus(db: Pool = pool): Promise<SearchGapStatus> {
  const map = await readSettingsMap(db);
  const s = readSearchGapSettings((k) => map.get(k));
  const last = map.get(SEARCH_GAP_SETTING_KEYS.lastRun);
  const lastRun = last && typeof last === "object" ? (last as SearchGapLastRun) : null;
  const req = map.get(SEARCH_GAP_SETTING_KEYS.runRequestedAt);
  const runRequested = typeof req === "string" && (!lastRun || Date.parse(req) > Date.parse(lastRun.startedAt));
  return { ...s, lastRun, runRequested, aiOperational: await aiOperational().catch(() => false) };
}

/** *Run now* (§62.8): the sweep picks the marker up within a minute. 409 while collection is off. */
export async function requestSearchGapRun(actorUserId: string, db: Pool = pool): Promise<{ ok: true } | { ok: false; status: 409; error: string }> {
  const s = await getSearchGapSettings(db);
  if (!s.enabled) return { ok: false, status: 409, error: "Search-gap collection is off." };
  await db.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ($1, to_jsonb(now()::text), $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [SEARCH_GAP_SETTING_KEYS.runRequestedAt, actorUserId],
  );
  await appendAudit(db, { actorUserId, action: "job.search_gaps_run_requested", targetType: "search_gap", after: {} });
  return { ok: true };
}

// ── The list (§62.7) ───────────────────────────────────────────────────────────────────────────

const TAB_WHERE: Record<GapTab, string> = {
  review: `(g.state in ('new', 'failed') or (g.state = 'suggested' and g.ai_kind is distinct from 'noise'))`,
  noise: `(g.state = 'suggested' and g.ai_kind = 'noise')`,
  accepted: `g.state = 'accepted'`,
};
const TAB_ORDER: Record<GapTab, string> = {
  review: `g.searchers desc, g.hits desc, g.last_day desc, g.id`,
  noise: `g.searchers desc, g.hits desc, g.last_day desc, g.id`,
  accepted: `g.decided_at desc, g.id`,
};

export function isGapTab(v: unknown): v is GapTab {
  return v === "review" || v === "noise" || v === "accepted";
}

interface GapRow {
  id: string; query_norm: string; mode: GapMode; surfaces: string[]; hits: number; searchers: number;
  first_day: string; last_day: string; state: GapState; ai_kind: GapKind | null; ai_draft: unknown;
  ai_model: string | null; ai_attempts: number; ai_last_error: string | null; restricted_matches: unknown;
  outcome: GapOutcome | null; outcome_request_id: string | null; outcome_synonym_group_id: string | null;
  decided_by_id: string | null; decided_by_name: string | null; decided_at: string | null; version: string;
}

export async function listSearchGaps(tab: GapTab, db: Pool = pool): Promise<{ gaps: SearchGapView[]; counts: Record<GapTab, number> }> {
  const { rows } = await db.query<GapRow>(
    `select g.id, g.query_norm, g.mode, g.surfaces, g.hits, g.searchers,
            to_char(g.first_day, 'YYYY-MM-DD') as first_day, to_char(g.last_day, 'YYYY-MM-DD') as last_day,
            g.state, g.ai_kind, g.ai_draft, g.ai_model, g.ai_attempts, g.ai_last_error, g.restricted_matches,
            g.outcome, g.outcome_request_id, g.outcome_synonym_group_id,
            u.id as decided_by_id, u.display_name as decided_by_name, g.decided_at, g.updated_at::text as version
       from search_gaps g left join users u on u.id = g.decided_by_user_id
      where ${TAB_WHERE[tab]}
      order by ${TAB_ORDER[tab]}
      limit 200`,
  );
  const ids = [...new Set(rows.flatMap((r) => restrictedIds(r.restricted_matches)))];
  const { rows: skills } = ids.length
    ? await db.query<{ id: string; ns: string; slug: string; title: string }>(
        `select s.id, n.slug as ns, s.slug, s.title from skills s join namespaces n on n.id = s.namespace_id where s.id = any($1::uuid[])`,
        [ids],
      )
    : { rows: [] as { id: string; ns: string; slug: string; title: string }[] };
  const byId = new Map(skills.map((s) => [s.id, { ns: s.ns, slug: s.slug, title: s.title }]));
  const { rows: c } = await db.query<{ review: number; noise: number; accepted: number }>(
    `select count(*) filter (where ${TAB_WHERE.review.replace(/g\./g, "")})::int as review,
            count(*) filter (where ${TAB_WHERE.noise.replace(/g\./g, "")})::int as noise,
            count(*) filter (where ${TAB_WHERE.accepted.replace(/g\./g, "")})::int as accepted
       from search_gaps`,
  );
  return {
    gaps: rows.map((r) => ({
      id: r.id,
      query: r.query_norm,
      mode: r.mode,
      surfaces: r.surfaces.filter((s): s is GapSurface => s === "web" || s === "mcp"),
      hits: r.hits,
      searchers: r.searchers,
      firstDay: r.first_day,
      lastDay: r.last_day,
      state: r.state,
      aiKind: r.ai_kind,
      draft: storedGapDraft(r.ai_draft),
      aiModel: r.ai_model,
      aiAttempts: r.ai_attempts,
      aiLastError: r.ai_last_error,
      restrictedMatches: restrictedIds(r.restricted_matches).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
      outcome: r.outcome,
      outcomeRequestId: r.outcome_request_id,
      outcomeSynonymGroupId: r.outcome_synonym_group_id,
      decidedBy: r.decided_by_id ? { id: r.decided_by_id, displayName: r.decided_by_name ?? "" } : null,
      decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
      version: r.version,
    })),
    counts: c[0] ?? { review: 0, noise: 0, accepted: 0 },
  };
}

function restrictedIds(v: unknown): string[] {
  return Array.isArray(v) ? v.flatMap((x) => (x && typeof (x as { skillId?: unknown }).skillId === "string" ? [(x as { skillId: string }).skillId] : [])) : [];
}

/** Gaps waiting for an admin — the nav badge (§62.7). */
export async function reviewableGapCount(db: Db = pool): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from search_gaps g where ${TAB_WHERE.review}`);
  return rows[0]?.n ?? 0;
}

// ── Decisions (§62.6) ──────────────────────────────────────────────────────────────────────────

interface LockedGap { id: string; query_norm: string; state: GapState; ai_kind: GapKind | null; searchers: number; restricted_matches: unknown }

/** Lock the gap and check the version. Null = proceed; a refusal otherwise. */
async function lockGap(client: PoolClient, id: string, expected: unknown): Promise<LockedGap | typeof notFound | typeof conflict> {
  const { rows } = await client.query<LockedGap & { version: string }>(
    `select id, query_norm, state, ai_kind, searchers, restricted_matches, updated_at::text as version
       from search_gaps where id = $1 for update`,
    [id],
  );
  const g = rows[0];
  if (!g) return notFound;
  if (g.state === "accepted" || typeof expected !== "string" || expected !== g.version) return conflict;
  return g;
}

/** Accept: mark, tombstone, forget the counts, audit (hash only), notify restricted owners. */
async function settle(client: PoolClient, g: LockedGap, adminId: string, outcome: GapOutcome, target: { requestId?: string; groupId?: string }): Promise<void> {
  const hash = gapQueryHash(g.query_norm);
  await client.query(
    `update search_gaps set state = 'accepted', outcome = $2, outcome_request_id = $3, outcome_synonym_group_id = $4,
            decided_by_user_id = $5, decided_at = now(), updated_at = now()
      where id = $1`,
    [g.id, outcome, target.requestId ?? null, target.groupId ?? null, adminId],
  );
  await client.query(`insert into search_gap_tombstones (query_hash, outcome) values ($1, $2) on conflict (query_hash) do nothing`, [hash, outcome]);
  await deleteGapCounts(client, g.query_norm);
  const restricted = restrictedIds(g.restricted_matches);
  await appendAudit(client, {
    actorUserId: adminId,
    action: "search_gap.accepted",
    targetType: "search_gap",
    targetId: g.id,
    after: { outcome, requestId: target.requestId ?? null, groupId: target.groupId ?? null, queryHash: hash.toString("hex"), searchers: g.searchers, restrictedMatchCount: restricted.length },
  });
  if (restricted.length) await notifyRestrictedOwners(client, g, adminId, restricted);
}

/** §62.9 `skill.search_gap_hidden_match` to each restricted match's effective maintainers. */
async function notifyRestrictedOwners(client: PoolClient, g: LockedGap, adminId: string, skillIds: string[]): Promise<void> {
  const { rows: lb } = await client.query<{ days: number }>(
    `select coalesce((select (value #>> '{}')::int from platform_settings where key = $1), $2)::int as days`,
    [SEARCH_GAP_SETTING_KEYS.lookbackDays, SEARCH_GAP_LOOKBACK_DAYS.default],
  );
  const days = lb[0]?.days ?? SEARCH_GAP_LOOKBACK_DAYS.default;
  for (const skillId of skillIds) {
    await client.query(
      `insert into notifications (user_id, type, payload)
       select distinct u.id, 'skill.search_gap_hidden_match',
              jsonb_build_object('query', $2::text, 'namespaceSlug', n.slug, 'skillSlug', s.slug,
                                 'skillId', s.id, 'searchers', $3::int, 'days', $4::int)
         from skills s join namespaces n on n.id = s.namespace_id
         join users u on u.id in (${effectiveMaintainerIdsSql("s.id", "s.namespace_id")})
        where s.id = $1 and u.status = 'active' and u.erased_at is null and u.id <> $5`,
      [skillId, g.query_norm, g.searchers, days, adminId],
    );
  }
}

async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

class Refusal extends Error {
  constructor(readonly r: { ok: false; status: 404 | 409 | 422; error: string }) {
    super(r.error);
  }
}

export async function acceptGapAsRequest(
  adminId: string,
  id: string,
  input: RequestInput,
  expectedUpdatedAt: unknown,
): Promise<GapResult<{ requestId: string }>> {
  try {
    return await inTx(async (client) => {
      const g = await lockGap(client, id, expectedUpdatedAt);
      if ("ok" in g) throw new Refusal(g);
      const created = await createPlatformRequest(client, adminId, input, g.id);
      if ("error" in created) throw new Refusal({ ok: false, status: 422, error: created.error });
      await settle(client, g, adminId, "request", { requestId: created.id });
      return { ok: true as const, requestId: created.id };
    });
  } catch (e) {
    if (e instanceof Refusal) return e.r;
    throw e;
  }
}

export async function acceptGapAsSynonym(
  adminId: string,
  id: string,
  input: { groupId: string | null; terms: unknown },
  expectedUpdatedAt: unknown,
): Promise<GapResult<{ groupId: string }>> {
  const hook = async (client: PoolClient, groupId: string) => {
    const g = await lockGap(client, id, expectedUpdatedAt);
    if ("ok" in g) throw new Refusal(g);
    await settle(client, g, adminId, "synonym", { groupId });
  };
  try {
    const group = input.groupId
      ? await updateSynonymGroup(input.groupId, input.terms, adminId, hook)
      : await createSynonymGroup(input.terms, adminId, hook);
    return { ok: true, groupId: group.id };
  } catch (e) {
    if (e instanceof Refusal) return e.r;
    if (e instanceof SearchAdminError) return { ok: false, status: e.status, error: e.message };
    throw e;
  }
}

export async function dismissGap(adminId: string, id: string, expectedUpdatedAt: unknown): Promise<GapResult> {
  try {
    return await inTx(async (client) => {
      const g = await lockGap(client, id, expectedUpdatedAt);
      if ("ok" in g) throw new Refusal(g);
      const hash = gapQueryHash(g.query_norm);
      await appendAudit(client, {
        actorUserId: adminId,
        action: "search_gap.dismissed",
        targetType: "search_gap",
        targetId: g.id,
        after: { queryHash: hash.toString("hex"), aiKind: g.ai_kind },
      });
      await client.query(`insert into search_gap_tombstones (query_hash, outcome) values ($1, 'dismissed') on conflict (query_hash) do nothing`, [hash]);
      await deleteGapCounts(client, g.query_norm);
      await client.query(`delete from search_gaps where id = $1`, [g.id]);
      return { ok: true as const };
    });
  } catch (e) {
    if (e instanceof Refusal) return e.r;
    throw e;
  }
}

/** Redraft (§62.6): clear the draft and attempts; the next run drafts it again. Not audited. */
export async function redraftGap(id: string, expectedUpdatedAt: unknown): Promise<GapResult | { ok: false; status: 409; error: string }> {
  if (!(await aiOperational().catch(() => false))) return { ok: false, status: 409, error: "The AI integration is not operational." };
  try {
    return await inTx(async (client) => {
      const g = await lockGap(client, id, expectedUpdatedAt);
      if ("ok" in g) throw new Refusal(g);
      await client.query(
        `update search_gaps set state = 'new', ai_kind = null, ai_draft = null, ai_model = null, ai_attempts = 0,
                ai_last_error = null, ai_next_attempt_at = null, updated_at = now()
          where id = $1`,
        [g.id],
      );
      return { ok: true as const };
    });
  } catch (e) {
    if (e instanceof Refusal) return e.r;
    throw e;
  }
}
