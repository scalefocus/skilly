// Search gaps (SKILLY_SPEC.md §62): the server half shared by the web tier (catalog) and the worker
// (MCP search_skills, the sweep, housekeeping). Node-only (crypto) — never imported by client code.
//
// Privacy by construction (§62.2–§62.3): a hit row holds the UTC day, the normalized query, the
// surface, the mode and HMAC-SHA256(day salt, user id). No timestamp, no serial id, no user id. The
// day comes from the database clock in the same statement, and a salt is only created for today.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isSecretLikeLine } from "./scan.js";
import type { Queryable } from "./search.js";
import {
  SEARCH_GAP_RETENTION_DAYS,
  gapRecordMode,
  normalizeGapQuery,
  type GapCandidate,
  type GapMode,
  type GapSurface,
} from "./search-gaps.js";

/** The tombstone / gap key: unsalted SHA-256 of the normalized query, stable forever (§62.3). */
export function gapQueryHash(queryNorm: string): Buffer {
  return createHash("sha256").update(queryNorm, "utf8").digest();
}

/** HMAC-SHA256(salt, user id) — the only form a searcher is ever stored in (§62.2). */
export function gapSearcherHash(salt: Buffer, userId: string): Buffer {
  return createHmac("sha256", salt).update(userId, "utf8").digest();
}

// Today's salt may be cached in memory, keyed by the day, and is dropped when the day changes.
let saltCache: { day: string; salt: Buffer } | null = null;

/** Test hook: forget the in-memory salt. */
export function resetGapSaltCache(): void {
  saltCache = null;
}

async function todaysSalt(db: Queryable): Promise<{ day: string; salt: Buffer }> {
  const { rows } = await db.query(`select to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD') as day`);
  const day = (rows[0] as { day: string }).day;
  if (saltCache?.day === day) return saltCache;
  await db.query(
    // Only ever for the current day: a statement that crosses midnight creates nothing for the day
    // housekeeping may already have folded (the read below then fails and the hit is not stored).
    `insert into search_gap_salts (day, salt)
     select $1::date, $2 where $1::date = (now() at time zone 'UTC')::date
     on conflict (day) do nothing`,
    [day, randomBytes(32)],
  );
  const r = await db.query(`select salt from search_gap_salts where day = $1::date`, [day]);
  const salt = (r.rows[0] as { salt: Buffer } | undefined)?.salt;
  if (!salt) throw new Error("search gap salt missing");
  saltCache = { day, salt };
  return saltCache;
}

export type GapRecordOutcome = "recorded" | "secret" | "tombstoned" | "skipped";

export interface GapHitInput extends GapCandidate {
  db: Queryable;
  userId: string;
  surface: GapSurface;
  rawQuery: string;
}

/**
 * Record one search-gap hit when §62.2 says so. Callers run it fire-and-forget AFTER computing the
 * response and never await it on the request path; it throws only on database errors, which the
 * caller counts. Returns what happened, for the metric.
 */
export async function recordGapHit(input: GapHitInput): Promise<GapRecordOutcome> {
  const mode = gapRecordMode(input);
  if (!mode) return "skipped";
  const norm = normalizeGapQuery(input.rawQuery);
  if (!norm) return "skipped";
  if (isSecretLikeLine(input.rawQuery)) return "secret";
  const tomb = await input.db.query(`select 1 from search_gap_tombstones where query_hash = $1`, [gapQueryHash(norm)]);
  if (tomb.rows.length) return "tombstoned";
  const { day, salt } = await todaysSalt(input.db);
  await upsertGapHit(input.db, day, norm, input.surface, mode, gapSearcherHash(salt, input.userId));
  return "recorded";
}

async function upsertGapHit(db: Queryable, day: string, norm: string, surface: GapSurface, mode: GapMode, hash: Buffer): Promise<void> {
  // The row's day is the database's own UTC day; a statement that straddles midnight lands on the
  // new day with no salt for it only in theory — the salt is re-read per day above.
  await db.query(
    `insert into search_gap_hits (day, query_norm, surface, mode, searcher_hash, hits)
     values ($1::date, $2, $3, $4, $5, 1)
     on conflict (day, query_norm, surface, mode, searcher_hash) do update set hits = search_gap_hits.hits + 1`,
    [day, norm, surface, mode, hash],
  );
}

/** Read the collection switch (absent ⇒ off) — one indexed row, no cache (§62.8). */
export async function searchGapsEnabled(db: Queryable): Promise<boolean> {
  const { rows } = await db.query(`select value from platform_settings where key = 'search_gaps_enabled'`);
  return (rows[0] as { value?: unknown } | undefined)?.value === true;
}

/**
 * Housekeeping (§62.3), run whatever the switch says: fold every finished day's hits into daily
 * counts and delete those hits and that day's salt in one transaction, prune daily counts and
 * decided gaps past retention. `begin`/`commit` need a dedicated client (pg PoolClient).
 */
export async function foldSearchGapDays(client: Queryable): Promise<{ foldedDays: number; prunedDaily: number; prunedGaps: number }> {
  await client.query("begin");
  try {
    const today = `(now() at time zone 'UTC')::date`;
    const days = await client.query(
      `select count(distinct day)::int as n from (
         select day from search_gap_hits where day < ${today}
         union select day from search_gap_salts where day < ${today}) d`,
    );
    await client.query(
      `insert into search_gap_daily (day, query_norm, surface, mode, hits, searchers)
       select day, query_norm, surface, mode, sum(hits)::int, count(*)::int
         from search_gap_hits where day < ${today}
        group by day, query_norm, surface, mode
       on conflict (day, query_norm, surface, mode) do update
         set hits = search_gap_daily.hits + excluded.hits,
             searchers = search_gap_daily.searchers + excluded.searchers`,
    );
    await client.query(`delete from search_gap_hits where day < ${today}`);
    await client.query(`delete from search_gap_salts where day < ${today}`);
    const daily = await client.query(
      `with d as (delete from search_gap_daily where day < ${today} - $1::int returning 1) select count(*)::int as n from d`,
      [SEARCH_GAP_RETENTION_DAYS],
    );
    const gaps = await client.query(
      `with d as (delete from search_gaps where state = 'accepted' and decided_at < now() - make_interval(days => $1::int) returning 1)
       select count(*)::int as n from d`,
      [SEARCH_GAP_RETENTION_DAYS],
    );
    await client.query("commit");
    return {
      foldedDays: (days.rows[0] as { n: number }).n,
      prunedDaily: (daily.rows[0] as { n: number }).n,
      prunedGaps: (gaps.rows[0] as { n: number }).n,
    };
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}

/** Delete every stored count of one query — after an admin accepts or dismisses it (§62.6). */
export async function deleteGapCounts(db: Queryable, queryNorm: string): Promise<void> {
  await db.query(`delete from search_gap_hits where query_norm = $1`, [queryNorm]);
  await db.query(`delete from search_gap_daily where query_norm = $1`, [queryNorm]);
}

export interface GapSearchFacts {
  userId: string | null;
  surface: GapSurface;
  rawQuery: string | null | undefined;
  explicit: boolean;
  narrowed: boolean;
  total: number;
  matchMode: "all" | "any" | null;
}

/**
 * The one hook every recording surface calls after it has its result (§62.2). Cheap when the search
 * is not a gap (no database read at all); otherwise it reads the switch and records. Never throws:
 * a database error comes back as "failed" for the caller's metric.
 */
export async function maybeRecordGapHit(db: Queryable, f: GapSearchFacts): Promise<GapRecordOutcome | "failed"> {
  if (!f.userId || typeof f.rawQuery !== "string") return "skipped";
  const facts = { explicit: f.explicit, narrowed: f.narrowed, total: f.total, matchMode: f.matchMode };
  if (!gapRecordMode({ ...facts, enabled: true })) return "skipped";
  try {
    const enabled = await searchGapsEnabled(db);
    return await recordGapHit({ db, userId: f.userId, surface: f.surface, rawQuery: f.rawQuery, enabled, ...facts });
  } catch {
    return "failed";
  }
}
