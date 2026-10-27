// The search-gap sweep (SKILLY_SPEC.md §62.4) — leader-only. It wakes every minute and runs when
// collection is on and either `search_gaps_sweep_hours` have passed since the last run started or a
// platform admin pressed *Run now*. Each run:
//   1. counts every normalized query in the lookback window (today's raw hits + folded days);
//   2. turns the queries with enough people into gaps, refreshes their counts, and drops open gaps
//      that fell below the threshold;
//   3. re-checks each open gap against the catalog: deleted when an org-visible skill now answers it
//      for everyone, and its top restricted (namespace-visible) matches stored;
//   4. drafts suggestions with the AI integration while it is Operational (§62.5);
//   5. tells platform admins when gaps became reviewable (coalesced `search_gaps.ready`, §62.9);
//   6. records the run in `search_gaps_last_run`.
// Housekeeping (folding finished days, retention) is separate and runs whatever the switch says.
import type { Pool, PoolClient } from "pg";
import {
  SEARCH_GAP_DRAFT_CONCURRENCY,
  SEARCH_GAP_DRAFTS_PER_RUN,
  SEARCH_GAP_FEATURE,
  SEARCH_GAP_MAX_ATTEMPTS,
  SEARCH_GAP_RESTRICTED_MAX,
  SEARCH_GAP_RETRY_MS,
  SEARCH_GAP_SETTING_KEYS,
  SEARCH_GAP_SHORTLIST_MAX,
  SEARCH_GAP_SYSTEM_PROMPT,
  TOOL_HARNESSES,
  buildGapPrompt,
  catalogOrderBy,
  gapQueryHash,
  readSearchGapSettings,
  resolveSkillSearch,
  validateGapDraft,
  type GapMode,
  type GapPromptInput,
  type SearchGapLastRun,
  type SearchGapSettings,
} from "@skilly/shared";
import { AiError, aiComplete, aiOperational, type AiEnv } from "@skilly/shared/ai";
import { workerAiEnv } from "./scan/aiEnv.js";

/** How often the loop wakes to check whether a run is due (§62.4). */
export const SEARCH_GAP_TICK_MS = 60_000;
const LOCK_KEY = "search-gap-sweep";
/** AI refusals that are not attempts (§62.4): the gap stays `new` and the batch stops. */
const REFUSALS = new Set(["ai_disabled", "ai_not_configured", "ai_key_missing"]);

export interface SearchGapState extends SearchGapSettings {
  lastRun: SearchGapLastRun | null;
  runRequestedAt: string | null;
}

export async function getSearchGapState(db: Pool | PoolClient): Promise<SearchGapState> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `select key, value from platform_settings where key = any($1::text[])`,
    [Object.values(SEARCH_GAP_SETTING_KEYS)],
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const last = map.get(SEARCH_GAP_SETTING_KEYS.lastRun);
  const req = map.get(SEARCH_GAP_SETTING_KEYS.runRequestedAt);
  return {
    ...readSearchGapSettings((k) => map.get(k)),
    lastRun: last && typeof last === "object" ? (last as SearchGapLastRun) : null,
    runRequestedAt: typeof req === "string" ? req : null,
  };
}

/** Whether a run is due now: never while off; a pending Run now; else the interval since the last start. */
export function searchGapRunDue(s: SearchGapState, now: Date): boolean {
  if (!s.enabled) return false;
  const lastStart = s.lastRun ? Date.parse(s.lastRun.startedAt) : NaN;
  if (s.runRequestedAt && (!Number.isFinite(lastStart) || Date.parse(s.runRequestedAt) > lastStart)) return true;
  if (!Number.isFinite(lastStart)) return true;
  return now.getTime() - lastStart >= s.sweepHours * 3_600_000;
}

export interface SearchGapSweepDeps {
  env?: AiEnv;
  now?: () => Date;
  /** Run even when not due (tests). */
  force?: boolean;
}

export interface SearchGapSweepResult {
  ran: boolean;
  gaps: number;
  newGaps: number;
  answered: number;
  drafted: number;
  failed: number;
  notified: number;
}

const SKIPPED: SearchGapSweepResult = { ran: false, gaps: 0, newGaps: 0, answered: 0, drafted: 0, failed: 0, notified: 0 };

/** One tick: run the sweep when due, under an advisory lock so a second replica skips. */
export async function sweepSearchGaps(pool: Pool, deps: SearchGapSweepDeps = {}): Promise<SearchGapSweepResult> {
  const now = deps.now ?? (() => new Date());
  const state = await getSearchGapState(pool);
  if (!state.enabled) return SKIPPED;
  if (!deps.force && !searchGapRunDue(state, now())) return SKIPPED;

  const lockClient = await pool.connect();
  try {
    const { rows: lock } = await lockClient.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext($1)) as ok`, [LOCK_KEY]);
    if (!lock[0]?.ok) return SKIPPED;
    const startedAt = now().toISOString();
    try {
      const r = await runSweep(pool, state, deps.env ?? workerAiEnv());
      await writeLastRun(pool, { startedAt, finishedAt: now().toISOString(), ok: true, gaps: r.gaps, newGaps: r.newGaps, drafted: r.drafted, error: null });
      return r;
    } catch (err) {
      await writeLastRun(pool, { startedAt, finishedAt: now().toISOString(), ok: false, gaps: 0, newGaps: 0, drafted: 0, error: String(err).slice(0, 300) }).catch(() => {});
      throw err;
    } finally {
      await lockClient.query(`select pg_advisory_unlock(hashtext($1))`, [LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}

async function writeLastRun(db: Pool, run: SearchGapLastRun): Promise<void> {
  await db.query(
    `insert into platform_settings (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SEARCH_GAP_SETTING_KEYS.lastRun, JSON.stringify(run)],
  );
}

interface CountRow {
  query_norm: string;
  hits: number;
  searchers: number;
  first_day: string;
  last_day: string;
  any_none: boolean;
  surfaces: string[];
}

async function runSweep(pool: Pool, s: SearchGapState, env: AiEnv): Promise<SearchGapSweepResult> {
  // 1. Count over the lookback window, today included.
  const { rows: counts } = await pool.query<CountRow>(
    `with w as (select (now() at time zone 'UTC')::date - ($1::int - 1) as since),
     h as (
       select query_norm, surface, mode, day, sum(hits)::int as hits, count(*)::int as searchers
         from search_gap_hits, w where day >= w.since group by query_norm, surface, mode, day
       union all
       select query_norm, surface, mode, day, hits, searchers from search_gap_daily, w where day >= w.since
     )
     select query_norm, sum(hits)::int as hits, sum(searchers)::int as searchers,
            to_char(min(day), 'YYYY-MM-DD') as first_day, to_char(max(day), 'YYYY-MM-DD') as last_day,
            bool_or(mode = 'none') as any_none, array_agg(distinct surface order by surface) as surfaces
       from h group by query_norm`,
    [s.lookbackDays],
  );

  // 2. Threshold, minus tombstoned queries.
  const qualifying = counts.filter((c) => c.searchers >= s.minSearchers);
  const hashes = qualifying.map((c) => gapQueryHash(c.query_norm));
  const { rows: tombs } = hashes.length
    ? await pool.query<{ query_hash: Buffer }>(`select query_hash from search_gap_tombstones where query_hash = any($1::bytea[])`, [hashes])
    : { rows: [] as { query_hash: Buffer }[] };
  const dead = new Set(tombs.map((t) => t.query_hash.toString("hex")));
  const kept = qualifying.filter((_, i) => !dead.has(hashes[i]!.toString("hex")));

  const inserted: string[] = [];
  for (const c of kept) {
    const mode: GapMode = c.any_none ? "none" : "any";
    const { rows } = await pool.query<{ inserted: boolean }>(
      `insert into search_gaps (query_norm, query_hash, mode, surfaces, hits, searchers, first_day, last_day)
       values ($1, $2, $3, $4::text[], $5, $6, $7::date, $8::date)
       on conflict (query_norm) do update
          set mode = excluded.mode, surfaces = excluded.surfaces, hits = excluded.hits, searchers = excluded.searchers,
              first_day = excluded.first_day, last_day = excluded.last_day, updated_at = now()
        where search_gaps.state <> 'accepted'
          and (search_gaps.mode, search_gaps.surfaces, search_gaps.hits, search_gaps.searchers, search_gaps.first_day, search_gaps.last_day)
              is distinct from (excluded.mode, excluded.surfaces, excluded.hits, excluded.searchers, excluded.first_day, excluded.last_day)
       returning (xmax = 0) as inserted`,
      [c.query_norm, gapQueryHash(c.query_norm), mode, c.surfaces, c.hits, c.searchers, c.first_day, c.last_day],
    );
    if (rows[0]?.inserted) inserted.push(c.query_norm);
  }
  // Open gaps whose hits aged out of the window (or fell under a raised threshold) go; they can return.
  await pool.query(
    `delete from search_gaps where state in ('new', 'suggested', 'failed') and query_norm <> all($1::text[])`,
    [kept.map((c) => c.query_norm)],
  );

  // 3. Re-check the catalog.
  const { rows: open } = await pool.query<{ id: string; query_norm: string; restricted_matches: unknown }>(
    `select id, query_norm, restricted_matches from search_gaps where state in ('new', 'suggested', 'failed')`,
  );
  let answered = 0;
  for (const g of open) {
    if (await answeredForEveryone(pool, g.query_norm)) {
      await pool.query(`delete from search_gaps where id = $1 and state <> 'accepted'`, [g.id]);
      answered++;
      continue;
    }
    const restricted = await restrictedMatches(pool, g.query_norm);
    if (JSON.stringify(restricted) !== JSON.stringify(g.restricted_matches ?? [])) {
      await pool.query(`update search_gaps set restricted_matches = $2::jsonb, updated_at = now() where id = $1`, [g.id, JSON.stringify(restricted)]);
    }
  }
  // 4. Draft while the integration is Operational.
  let drafted = 0;
  let failed = 0;
  if (await aiOperational(pool, env).catch(() => false)) {
    const r = await draftGaps(pool, env);
    drafted = r.drafted;
    failed = r.failed;
  }

  // 5. Tell platform admins about gaps that became reviewable this run: those inserted now that the
  //    re-check kept and the model did not call noise (a `new` gap is reviewable at once — it shows
  //    as "Drafting…" or "No draft").
  let notified = 0;
  let newGaps = 0;
  if (inserted.length > 0) {
    const { rows: still } = await pool.query<{ n: number }>(
      `select count(*)::int as n from search_gaps
        where query_norm = any($1::text[])
          and (state in ('new', 'failed') or (state = 'suggested' and ai_kind is distinct from 'noise'))`,
      [inserted],
    );
    newGaps = still[0]?.n ?? 0;
    if (newGaps > 0) notified = await notifyAdmins(pool, newGaps);
  }

  const { rows: total } = await pool.query<{ n: number }>(`select count(*)::int as n from search_gaps where state <> 'accepted'`);
  return { ran: true, gaps: total[0]?.n ?? 0, newGaps, answered, drafted, failed, notified };
}

/** True when the strict (all-words) match finds an active, org-visible skill: the catalog answers
 *  this query for everyone now. Substring and typo tiers count, as they do for a searcher. */
export async function answeredForEveryone(db: Pool | PoolClient, queryNorm: string): Promise<boolean> {
  const params: unknown[] = [];
  const where = ["s.status = 'active'", "s.visibility = 'org'"];
  const r = await resolveSkillSearch(db, queryNorm, where, params);
  if (!r || r.matchMode !== "all") return false;
  const { rows } = await db.query(
    `select 1 from skills s join namespaces n on n.id = s.namespace_id where ${where.join(" and ")} limit 1`,
    params.slice(0, r.whereParamCount),
  );
  return rows.length > 0;
}

/** The top restricted (not org-visible) skills the strict match finds, best first (§62.4). */
export async function restrictedMatches(db: Pool | PoolClient, queryNorm: string): Promise<{ skillId: string }[]> {
  const params: unknown[] = [];
  const where = ["s.status = 'active'", "s.visibility <> 'org'"];
  const r = await resolveSkillSearch(db, queryNorm, where, params);
  if (!r || r.matchMode !== "all") return [];
  params.push(SEARCH_GAP_RESTRICTED_MAX);
  const { rows } = await db.query<{ id: string }>(
    `select s.id from skills s join namespaces n on n.id = s.namespace_id
      where ${where.join(" and ")}
      order by ${catalogOrderBy("relevance", r.relevance)} limit $${params.length}`,
    params,
  );
  return rows.map((x) => ({ skillId: x.id }));
}

/** The model's input for one gap (§62.5): org-visible skills only, never a restricted one. */
export async function gapPromptInput(
  db: Pool | PoolClient,
  g: { query_norm: string; mode: GapMode; searchers: number; hits: number },
): Promise<GapPromptInput> {
  const params: unknown[] = [];
  const where = ["s.status = 'active'", "s.visibility = 'org'"];
  const r = await resolveSkillSearch(db, g.query_norm, where, params);
  let skills: GapPromptInput["skills"] = [];
  if (r) {
    params.push(SEARCH_GAP_SHORTLIST_MAX);
    const { rows } = await db.query<{ ns: string; slug: string; title: string; description: string; categories: string[] | null }>(
      `select n.slug as ns, s.slug, s.title, s.description,
              (select array_agg(c.name order by c.name) from skill_categories sc join categories c on c.id = sc.category_id
                where sc.skill_id = s.id) as categories
         from skills s join namespaces n on n.id = s.namespace_id
        where ${where.join(" and ")}
        order by ${catalogOrderBy("relevance", r.relevance)} limit $${params.length}`,
      params,
    );
    skills = rows.map((x) => ({ ref: `${x.ns}/${x.slug}`, title: x.title, description: x.description ?? "", categories: x.categories ?? [] }));
  }
  const words = g.query_norm
    .replace(/"/g, " ")
    .split(" ")
    .filter((w) => w && w !== "OR" && !w.startsWith("-"));
  const { rows: groups } = await db.query<{ id: string; terms: string[] }>(
    `select g.id, g.terms from search_synonym_groups g
      where g.normalized && (select coalesce(array_agg(skilly_search_normalize(w)), '{}') from unnest($1::text[]) w)
      order by g.created_at limit 20`,
    [words],
  );
  const { rows: cats } = await db.query<{ name: string }>(`select name from categories order by name limit 300`);
  const { rows: tools } = await db.query<{ t: string }>(
    `select distinct tool_harness as t from skills where status = 'active' and tool_harness is not null`,
  );
  return {
    query: g.query_norm,
    mode: g.mode,
    searchers: g.searchers,
    hits: g.hits,
    skills,
    groups,
    categories: cats.map((c) => c.name),
    tools: [...new Set([...TOOL_HARNESSES, ...tools.map((t) => t.t)])].sort(),
  };
}

async function draftGaps(pool: Pool, env: AiEnv): Promise<{ drafted: number; failed: number }> {
  const { rows: due } = await pool.query<{ id: string; query_norm: string; mode: GapMode; searchers: number; hits: number; ai_attempts: number }>(
    `select id, query_norm, mode, searchers, hits, ai_attempts from search_gaps
      where state = 'new' and (ai_next_attempt_at is null or ai_next_attempt_at <= now())
      order by searchers desc, hits desc, last_day desc limit $1`,
    [SEARCH_GAP_DRAFTS_PER_RUN],
  );
  let drafted = 0;
  let failed = 0;
  let refused = false;
  for (let i = 0; i < due.length && !refused; i += SEARCH_GAP_DRAFT_CONCURRENCY) {
    const batch = due.slice(i, i + SEARCH_GAP_DRAFT_CONCURRENCY);
    const outcomes = await Promise.all(batch.map((g) => draftOne(pool, env, g)));
    for (const o of outcomes) {
      if (o === "drafted") drafted++;
      else if (o === "failed") failed++;
      else refused = true;
    }
  }
  return { drafted, failed };
}

export async function draftOne(
  pool: Pool,
  env: AiEnv,
  g: { id: string; query_norm: string; mode: GapMode; searchers: number; hits: number; ai_attempts: number },
): Promise<"drafted" | "failed" | "refused"> {
  const input = await gapPromptInput(pool, g);
  let error: string;
  try {
    const res = await aiComplete(pool, env, {
      feature: SEARCH_GAP_FEATURE,
      userId: null,
      system: SEARCH_GAP_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildGapPrompt(input) }],
      maxTokens: 8192,
      json: true,
    });
    const v = validateGapDraft(res.json, {
      skillRefs: input.skills.map((x) => x.ref),
      groupIds: input.groups.map((x) => x.id),
      categories: input.categories,
      tools: input.tools,
    });
    if (v.ok) {
      await pool.query(
        `update search_gaps set state = 'suggested', ai_kind = $2, ai_draft = $3::jsonb, ai_model = $4,
                ai_last_error = null, ai_next_attempt_at = null, updated_at = now()
          where id = $1 and state = 'new'`,
        [g.id, v.draft.kind, JSON.stringify(v.draft), res.model],
      );
      return "drafted";
    }
    error = `ai_invalid_output: ${v.error}`;
  } catch (err) {
    if (err instanceof AiError && REFUSALS.has(err.code)) return "refused";
    error = err instanceof AiError ? err.code : "ai_error";
  }
  const attempts = g.ai_attempts + 1;
  await pool.query(
    `update search_gaps
        set ai_attempts = $2, ai_last_error = $3,
            state = case when $2 >= $4 then 'failed' else state end,
            ai_next_attempt_at = case when $2 >= $4 then null else now() + make_interval(secs => $5::double precision / 1000) end,
            updated_at = now()
      where id = $1 and state = 'new'`,
    [g.id, attempts, error.slice(0, 300), SEARCH_GAP_MAX_ATTEMPTS, SEARCH_GAP_RETRY_MS],
  );
  return "failed";
}

/** §62.9 `search_gaps.ready`, coalesced per platform admin until read (migration 0103's index). */
async function notifyAdmins(db: Pool, n: number): Promise<number> {
  const bootstrap = process.env.SKILLY_BOOTSTRAP_ADMIN_GROUP?.trim() || null;
  const { rowCount } = await db.query(
    `with admins as (
       select gm.user_id as id
         from role_mappings rm join group_memberships gm on gm.group_id = rm.group_id
        where rm.role = 'platform_admin'
       union
       select gm.user_id
         from groups g join group_memberships gm on gm.group_id = g.id
        where $2::text is not null and g.entra_object_id = $2
     )
     insert into notifications (user_id, type, payload)
     select u.id, 'search_gaps.ready', jsonb_build_object('count', $1::int)
       from admins a join users u on u.id = a.id
      where u.status = 'active' and u.erased_at is null
      order by u.id
     on conflict (user_id) where type = 'search_gaps.ready' and read_at is null
     do update set payload = jsonb_build_object('count', coalesce((notifications.payload->>'count')::int, 0) + $1::int),
                   created_at = now()`,
    [n, bootstrap],
  );
  return rowCount ?? 0;
}

/** Gaps waiting for an admin — the nav badge, the gauge. */
export async function reviewableGapCount(db: Pool | PoolClient): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from search_gaps
      where state in ('new', 'failed') or (state = 'suggested' and ai_kind is distinct from 'noise')`,
  );
  return rows[0]?.n ?? 0;
}
