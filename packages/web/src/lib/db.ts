// Thin Postgres pool. The web service connects as `skilly_app` (least privilege:
// no UPDATE/DELETE on audit_log). SKILLY_SPEC.md §11, db/migrations/0002.
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  // Fail fast on misconfig rather than silently degrading.
  console.warn("[skilly] DATABASE_URL is not set");
}

// Bounded pool with explicit timeouts so a slow/runaway query can't wedge a replica or
// exhaust connections under load. statement_timeout kills any single query past the cap.
export const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15_000),
});

// A pool-level error handler prevents an idle-client error from crashing the process.
pool.on("error", (err) => console.error(JSON.stringify({ level: "error", msg: "pg pool error", err: String(err) })));
