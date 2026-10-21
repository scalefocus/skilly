// Thin Postgres pool. The web service connects as `skilly_app` (least privilege:
// no UPDATE/DELETE on audit_log). SKILLY_SPEC.md §11, db/migrations/0002.
import { Pool, type PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  // Fail fast on misconfig rather than silently degrading.
  console.warn("[skilly] DATABASE_URL is not set");
}

// Bounded pool with explicit timeouts so a slow/runaway query can't wedge a replica or
// exhaust connections under load. statement_timeout kills any single query past the cap.
// 25 by default: one skill page alone issues ~20 reads in parallel, so a pool of 10 queued them.
export const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX ?? 25),
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15_000),
});

// A pool-level error handler prevents an idle-client error from crashing the process.
pool.on("error", (err) => console.error(JSON.stringify({ level: "error", msg: "pg pool error", err: String(err) })));

// Clients checked out of the default pool, so a helper taking `Pool | PoolClient` can tell a
// transaction on the app's own pool from a test's separate pool (e.g. to use cached settings).
const defaultPoolClients = new WeakSet<PoolClient>();
pool.on("connect", (client) => defaultPoolClients.add(client));

/** True for the default pool and any client checked out of it. */
export function usesDefaultPool(db: Pool | PoolClient): boolean {
  return db === pool || defaultPoolClients.has(db as PoolClient);
}
