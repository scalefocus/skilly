// Test-only: `node --test` runs the dbtest files in parallel, and several of them rewrite the single
// platform-wide `ai_integration` row (and the AI platform settings) — one file deleting the row
// while another asserts "AI available" fails at random. Every live-DB test that touches it runs its
// body under this advisory lock, on a connection of its own. Never imported by app code.
import { Client } from "pg";

/** Distinct from the worker's leader (855399) and related-skills (855400) locks. */
const AI_INTEGRATION_TEST_LOCK = 855_446;

export async function withAiIntegrationLock<T>(fn: () => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("select pg_advisory_lock($1)", [AI_INTEGRATION_TEST_LOCK]);
    return await fn();
  } finally {
    await c.query("select pg_advisory_unlock($1)", [AI_INTEGRATION_TEST_LOCK]).catch(() => {});
    await c.end().catch(() => {});
  }
}
