// Append-only governance audit. SKILLY_SPEC.md §11. The app DB role cannot UPDATE/DELETE
// this table (migration 0002 + trigger); we only ever INSERT.
import type { Pool, PoolClient } from "pg";
import { pool } from "./db";
import type { EffectiveAccess } from "@skilly/shared";

export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  namespaceId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

export async function appendAudit(db: Pool | PoolClient, e: AuditEntry): Promise<void> {
  await db.query(
    `insert into audit_log
       (actor_user_id, action, target_type, target_id, namespace_id, before, after, source, request_id)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'web',$8)`,
    [
      e.actorUserId,
      e.action,
      e.targetType,
      e.targetId ?? null,
      e.namespaceId ?? null,
      e.before == null ? null : JSON.stringify(e.before),
      e.after == null ? null : JSON.stringify(e.after),
      e.requestId ?? null,
    ],
  );
}

export interface AuditView {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  namespaceId: string | null;
  namespaceSlug: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  before: unknown;
  after: unknown;
  source: string;
  createdAt: string;
}

export interface AuditScope {
  /** true => can read all audit (platform admin) */
  all: boolean;
  /** namespace ids a namespace_admin may read (their administered namespaces) */
  namespaceIds: string[];
}

/** Derive the audit read scope from effective access (platform admin = all; else own ns). */
export function auditScope(access: EffectiveAccess): AuditScope {
  if (access.isPlatformAdmin) return { all: true, namespaceIds: [] };
  const namespaceIds = [...access.namespaceRoles.entries()].filter(([, r]) => r === "namespace_admin").map(([id]) => id);
  return { all: false, namespaceIds };
}

export interface AuditQuery {
  namespaceId?: string;
  action?: string; // prefix match (e.g. "proposal.")
  /** substring search over action/target/namespace/actor (NOT the before/after JSON) */
  q?: string;
  /** inclusive date range on created_at (ISO instants); each end optional */
  from?: string;
  to?: string;
  limit?: number;
  /** pagination offset for the viewer's infinite scroll (newest-first pages) */
  offset?: number;
}

/**
 * Shared WHERE-clause builder for listAudit / countAudit / exportAuditRows, so all three stay in
 * lockstep on exactly what a filter means. `empty: true` signals the caller should short-circuit
 * (a non-platform-admin scope that administers no namespace) without ever query the table.
 */
function auditFilter(scope: AuditScope, q: AuditQuery): { where: string[]; params: unknown[]; empty: boolean } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!scope.all) {
    if (scope.namespaceIds.length === 0) return { where, params, empty: true };
    params.push(scope.namespaceIds);
    where.push(`a.namespace_id = any($${params.length}::uuid[])`);
  }
  if (q.namespaceId) {
    params.push(q.namespaceId);
    where.push(`a.namespace_id = $${params.length}`);
  }
  if (q.action) {
    params.push(`${q.action}%`);
    where.push(`a.action like $${params.length}`);
  }
  // Substring search over the human-meaningful fields (joined actor/namespace included); the
  // before/after JSON is intentionally excluded. Plain cross-table ILIKE — audit_log is
  // append-only + lower-volume, and the query is bounded by ORDER BY created_at DESC LIMIT.
  if (q.q && q.q.trim()) {
    params.push(`%${q.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const i = params.length;
    where.push(
      `(a.action ilike $${i} escape '\\' or a.target_type ilike $${i} escape '\\'` +
        ` or a.target_id ilike $${i} escape '\\' or n.slug ilike $${i} escape '\\'` +
        ` or u.display_name ilike $${i} escape '\\' or u.email ilike $${i} escape '\\')`,
    );
  }
  // Inclusive date range on created_at (each end optional; ISO instants from the From/To pickers).
  if (q.from) {
    params.push(q.from);
    where.push(`a.created_at >= $${params.length}`);
  }
  if (q.to) {
    params.push(q.to);
    where.push(`a.created_at <= $${params.length}`);
  }
  return { where, params, empty: false };
}

async function queryAuditRows(where: string[], params: unknown[], limit: number, offset: number): Promise<AuditView[]> {
  const p = [...params, limit, offset];
  const limitIdx = p.length - 1;
  const offsetIdx = p.length;
  const { rows } = await pool.query<{
    id: string; action: string; target_type: string; target_id: string | null;
    namespace_id: string | null; namespace_slug: string | null;
    actor_user_id: string | null; actor_name: string | null; actor_email: string | null;
    before: unknown; after: unknown; source: string; created_at: string;
  }>(
    `select a.id, a.action, a.target_type, a.target_id, a.namespace_id, n.slug as namespace_slug,
            a.actor_user_id, u.display_name as actor_name, u.email as actor_email,
            a.before, a.after, a.source, a.created_at
       from audit_log a
       left join namespaces n on n.id = a.namespace_id
       left join users u on u.id = a.actor_user_id
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by a.created_at desc
      limit $${limitIdx} offset $${offsetIdx}`,
    p,
  );

  return rows.map((r) => ({
    id: r.id, action: r.action, targetType: r.target_type, targetId: r.target_id,
    namespaceId: r.namespace_id, namespaceSlug: r.namespace_slug,
    actorUserId: r.actor_user_id, actorName: r.actor_name, actorEmail: r.actor_email,
    before: r.before, after: r.after, source: r.source, createdAt: r.created_at,
  }));
}

/**
 * Read the audit log within the caller's scope. Platform admins see everything; namespace
 * admins see only entries tagged to a namespace they administer. Returns [] when the caller
 * administers nothing (and is not a platform admin) — never leaks other namespaces.
 */
export async function listAudit(scope: AuditScope, q: AuditQuery = {}): Promise<AuditView[]> {
  const { where, params, empty } = auditFilter(scope, q);
  if (empty) return [];
  return queryAuditRows(where, params, Math.min(500, q.limit ?? 100), Math.max(0, q.offset ?? 0));
}

/** Hard cap on a CSV export (see exportAuditRows) — bounds a single query/response regardless of
 *  how wide the admin's filter is (audit_log retention defaults to indefinite). SKILLY_SPEC.md §11. */
export const AUDIT_EXPORT_CAP = 50_000;

/** Total rows matching the SAME filter as listAudit/exportAuditRows — lets the export route tell
 *  the caller whether the capped download is complete or was truncated. */
export async function countAudit(scope: AuditScope, q: AuditQuery = {}): Promise<number> {
  const { where, params, empty } = auditFilter(scope, q);
  if (empty) return 0;
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n
       from audit_log a
       left join namespaces n on n.id = a.namespace_id
       left join users u on u.id = a.actor_user_id
      ${where.length ? `where ${where.join(" and ")}` : ""}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Rows for CSV export: the SAME filter as listAudit, newest-first, capped at AUDIT_EXPORT_CAP
 *  (no pagination offset — an export is always "from the top"). SKILLY_SPEC.md §11. */
export async function exportAuditRows(scope: AuditScope, q: AuditQuery = {}): Promise<AuditView[]> {
  const { where, params, empty } = auditFilter(scope, q);
  if (empty) return [];
  return queryAuditRows(where, params, AUDIT_EXPORT_CAP, 0);
}

/**
 * Trim audit events older than `olderThan` (default 1 year) — platform-admin retention, §11.
 * Relaxes the append-only invariant for this one explicit, transaction-scoped operation
 * (migration 0024). Records an `audit.trimmed` entry, deletes the old rows, then re-baselines
 * the tamper-evident hash chain over the survivors so verify_audit_chain() passes again.
 * Returns how many rows were deleted. Irreversible.
 */
export async function trimAuditLog(actorUserId: string, olderThan = "1 year"): Promise<{ deleted: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local skilly.allow_audit_trim = 'on'");
    // now() is fixed for the transaction, so the count and the delete use the same cutoff.
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from audit_log where created_at < now() - $1::interval`,
      [olderThan],
    );
    const deleted = Number(rows[0]?.n ?? 0);
    // Record the trim FIRST (newest row, chained normally) so the action itself is audited;
    // it post-dates the cutoff, so it survives the delete below.
    await appendAudit(client, {
      actorUserId,
      action: "audit.trimmed",
      targetType: "audit_log",
      after: { deletedCount: deleted, olderThan },
    });
    if (deleted > 0) {
      await client.query(`delete from audit_log where created_at < now() - $1::interval`, [olderThan]);
      await client.query(`select rebaseline_audit_chain()`);
    }
    await client.query("commit");
    return { deleted };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export interface ChainVerification {
  ok: boolean;
  entries: number;
  mismatches: { seq: number; reason: string }[];
}

/**
 * Verify the tamper-evident audit hash chain (migration 0008). Recomputation happens in the
 * DB (verify_audit_chain) so it can never drift from the insert trigger's hashing. Platform
 * admins only — the route enforces that.
 */
export async function verifyAuditChain(): Promise<ChainVerification> {
  const [{ rows: bad }, { rows: cnt }] = await Promise.all([
    pool.query<{ bad_seq: string; reason: string }>(`select bad_seq, reason from verify_audit_chain()`),
    pool.query<{ n: string }>(`select count(*)::text as n from audit_log`),
  ]);
  return {
    ok: bad.length === 0,
    entries: Number(cnt[0]?.n ?? 0),
    mismatches: bad.map((b) => ({ seq: Number(b.bad_seq), reason: b.reason })),
  };
}
