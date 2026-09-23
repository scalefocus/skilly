// Search administration (SKILLY_SPEC.md §34.8–§34.10): the search language, the synonym groups and
// the index status behind the Administration → Search and Maintenance cards. Platform-admin only —
// the routes enforce that. Every write is audited.
import type { Pool, PoolClient } from "pg";
import { parseSynonymTerms, searchLanguageLabel, SYNONYM_MAX_GROUPS } from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";

/** A rejected write, carrying the HTTP status the route answers with (422 validation, 404 unknown). */
export class SearchAdminError extends Error {
  constructor(readonly status: 404 | 422, message: string) {
    super(message);
  }
}

// ── Language (§34.9) ───────────────────────────────────────────────────────────────────────────

export interface SearchLanguage { value: string; label: string }

/** The server's built-in text-search configurations; "No stemming" (`simple`) listed last. */
export async function listSearchLanguages(db: Pool = pool): Promise<SearchLanguage[]> {
  const { rows } = await db.query<{ cfgname: string }>(
    `select c.cfgname from pg_catalog.pg_ts_config c
       join pg_catalog.pg_namespace n on n.oid = c.cfgnamespace
      where n.nspname = 'pg_catalog'
      order by (c.cfgname = 'simple'), c.cfgname`,
  );
  return rows.map((r) => ({ value: r.cfgname, label: searchLanguageLabel(r.cfgname) }));
}

/** The configuration search actually runs with — the same resolution the database uses (§34.9). */
export async function getActiveSearchLanguage(db: Pool = pool): Promise<string> {
  const { rows } = await db.query<{ cfg: string }>(`select skilly_search_config()::text as cfg`);
  return rows[0]?.cfg ?? "english";
}

/**
 * Switch the search language. Validated against the server's built-in configurations (422
 * otherwise) and audited as `settings.updated` (from → to). The query side switches at once; the
 * worker's reindex job rebuilds the vectors behind it (§34.9).
 */
export async function setSearchLanguage(value: unknown, actorUserId: string): Promise<string> {
  const languages = await listSearchLanguages();
  if (typeof value !== "string" || !languages.some((l) => l.value === value)) {
    throw new SearchAdminError(422, "unknown search language");
  }
  const before = await getActiveSearchLanguage();
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ('search_language', $1::jsonb, $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(value), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "settings.updated",
    targetType: "platform_settings",
    targetId: "search_language",
    before: { searchLanguage: before },
    after: { searchLanguage: value },
  });
  return value;
}

// ── Synonym groups (§34.8) ─────────────────────────────────────────────────────────────────────

export interface SynonymGroupView {
  id: string;
  terms: string[];
  updatedAt: string;
  /** Other groups sharing a normalized term under the current language (after a language change). */
  collidesWith: string[];
}

export async function listSynonymGroups(db: Pool = pool): Promise<SynonymGroupView[]> {
  const { rows } = await db.query<{ id: string; terms: string[]; normalized: string[]; updated_at: string }>(
    `select id, terms, normalized, updated_at from search_synonym_groups order by created_at, id`,
  );
  const owners = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const n of r.normalized) {
      if (!n) continue;
      const set = owners.get(n) ?? new Set<string>();
      set.add(r.id);
      owners.set(n, set);
    }
  }
  return rows.map((r) => {
    const others = new Set<string>();
    for (const n of r.normalized) for (const id of owners.get(n) ?? []) if (id !== r.id) others.add(id);
    return { id: r.id, terms: r.terms, updatedAt: r.updated_at, collidesWith: [...others] };
  });
}

// Writes are serialized so two admins can't both slip the same term into different groups.
const SYNONYM_WRITE_LOCK = "hashtext('skilly.search_synonyms')";

/** Validate terms against the language and the other groups (the shape was checked already). */
async function checkTerms(db: Pool | PoolClient, terms: string[], excludeId: string | null): Promise<void> {
  const { rows } = await db.query<{ t: string; n: string }>(
    `select u.t, skilly_search_normalize(u.t) as n from unnest($1::text[]) with ordinality as u(t, o) order by u.o`,
    [terms],
  );
  const ignored = rows.find((r) => !r.n);
  if (ignored) throw new SearchAdminError(422, `‘${ignored.t}’ is ignored by search (a stop word or punctuation only), so it can't be a synonym.`);
  const seen = new Map<string, string>();
  for (const r of rows) if (!seen.has(r.n)) seen.set(r.n, r.t);
  if (seen.size < 2) {
    throw new SearchAdminError(422, `${rows.map((r) => `‘${r.t}’`).join(" and ")} are the same word to search — a group needs at least two different terms.`);
  }
  const norms = rows.map((r) => r.n);
  const { rows: clash } = await db.query<{ terms: string[]; normalized: string[] }>(
    `select terms, normalized from search_synonym_groups
      where normalized && $1::text[] and ($2::uuid is null or id <> $2::uuid)
      order by created_at limit 1`,
    [norms, excludeId],
  );
  const other = clash[0];
  if (other) {
    const hit = rows.find((r) => other.normalized.includes(r.n))!;
    throw new SearchAdminError(422, `‘${hit.t}’ is already in the group “${other.terms.join(", ")}” — a term can belong to one group only.`);
  }
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(${SYNONYM_WRITE_LOCK})`);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function createSynonymGroup(input: unknown, actorUserId: string): Promise<SynonymGroupView> {
  const parsed = parseSynonymTerms(input);
  if (!parsed.ok) throw new SearchAdminError(422, parsed.error);
  return inTransaction(async (client) => {
    const { rows: cnt } = await client.query<{ n: string }>(`select count(*)::text as n from search_synonym_groups`);
    if (Number(cnt[0]?.n ?? 0) >= SYNONYM_MAX_GROUPS) {
      throw new SearchAdminError(422, `The synonym list is full (${SYNONYM_MAX_GROUPS} groups) — remove a group first.`);
    }
    await checkTerms(client, parsed.terms, null);
    const { rows } = await client.query<{ id: string; terms: string[]; updated_at: string }>(
      `insert into search_synonym_groups (terms, created_by, updated_by) values ($1::text[], $2, $2)
       returning id, terms, updated_at`,
      [parsed.terms, actorUserId],
    );
    const g = rows[0]!;
    await appendAudit(client, {
      actorUserId,
      action: "search.synonym_group_created",
      targetType: "search_synonym_group",
      targetId: g.id,
      after: { terms: g.terms },
    });
    return { id: g.id, terms: g.terms, updatedAt: g.updated_at, collidesWith: [] };
  });
}

export async function updateSynonymGroup(id: string, input: unknown, actorUserId: string): Promise<SynonymGroupView> {
  const parsed = parseSynonymTerms(input);
  if (!parsed.ok) throw new SearchAdminError(422, parsed.error);
  return inTransaction(async (client) => {
    const { rows: cur } = await client.query<{ terms: string[] }>(`select terms from search_synonym_groups where id = $1 for update`, [id]);
    if (!cur[0]) throw new SearchAdminError(404, "no such synonym group");
    await checkTerms(client, parsed.terms, id);
    const { rows } = await client.query<{ id: string; terms: string[]; updated_at: string }>(
      `update search_synonym_groups set terms = $2::text[], updated_by = $3, updated_at = now()
        where id = $1 returning id, terms, updated_at`,
      [id, parsed.terms, actorUserId],
    );
    const g = rows[0]!;
    await appendAudit(client, {
      actorUserId,
      action: "search.synonym_group_updated",
      targetType: "search_synonym_group",
      targetId: id,
      before: { terms: cur[0].terms },
      after: { terms: g.terms },
    });
    return { id: g.id, terms: g.terms, updatedAt: g.updated_at, collidesWith: [] };
  });
}

export async function deleteSynonymGroup(id: string, actorUserId: string): Promise<void> {
  await inTransaction(async (client) => {
    const { rows } = await client.query<{ terms: string[] }>(`delete from search_synonym_groups where id = $1 returning terms`, [id]);
    if (!rows[0]) throw new SearchAdminError(404, "no such synonym group");
    await appendAudit(client, {
      actorUserId,
      action: "search.synonym_group_deleted",
      targetType: "search_synonym_group",
      targetId: id,
      before: { terms: rows[0].terms },
    });
  });
}

// ── Index status + retry (§34.10) ──────────────────────────────────────────────────────────────

export interface SearchIndexStatus {
  /** SKILL.md extraction over ACTIVE versions: `indexed` and `absent` both count as done. */
  versions: { total: number; done: number; pending: number; failed: number };
  /** The language rebuild: skills whose vector was built with the active language. */
  rebuild: { language: string; label: string; total: number; current: number; running: boolean };
}

export async function getSearchIndexStatus(db: Pool = pool): Promise<SearchIndexStatus> {
  const [{ rows: v }, { rows: s }] = await Promise.all([
    db.query<{ total: string; done: string; pending: string; failed: string }>(
      `select count(*)::text as total,
              count(*) filter (where svs.status in ('indexed', 'absent'))::text as done,
              count(*) filter (where svs.status = 'pending' or svs.status is null)::text as pending,
              count(*) filter (where svs.status = 'failed')::text as failed
         from skill_versions sv
         left join skill_version_search svs on svs.skill_version_id = sv.id
        where sv.status = 'active'`,
    ),
    db.query<{ language: string; total: string; current: string }>(
      `select skilly_search_config()::text as language,
              count(*)::text as total,
              count(*) filter (where search_lang = skilly_search_config()::text)::text as current
         from skills`,
    ),
  ]);
  const language = s[0]?.language ?? "english";
  const total = Number(s[0]?.total ?? 0);
  const current = Number(s[0]?.current ?? 0);
  return {
    versions: {
      total: Number(v[0]?.total ?? 0),
      done: Number(v[0]?.done ?? 0),
      pending: Number(v[0]?.pending ?? 0),
      failed: Number(v[0]?.failed ?? 0),
    },
    rebuild: { language, label: searchLanguageLabel(language), total, current, running: current < total },
  };
}

/** Re-arm every failed extraction; the worker's sweep retries them on its next pass (§34.10). */
export async function retryFailedSearchIndex(actorUserId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `update skill_version_search set status = 'pending', attempts = 0, last_error = null where status = 'failed'`,
  );
  const count = rowCount ?? 0;
  await appendAudit(pool, {
    actorUserId,
    action: "job.search_retry_requested",
    targetType: "job",
    targetId: "search_index",
    after: { count },
  });
  return count;
}
