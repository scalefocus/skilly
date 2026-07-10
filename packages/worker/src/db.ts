// Shared Postgres pool for the worker. Connects as skilly_app (least privilege).
import { Pool } from "pg";

// Bounded like the web pool so a clone/scan storm can't open unbounded connections and exhaust
// Postgres. (The main worker entrypoint builds its own bounded pool; this stays consistent.)
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 30_000),
});
