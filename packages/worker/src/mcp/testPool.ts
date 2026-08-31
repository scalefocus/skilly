// A scriptable fake `pg` Pool for the MCP tests. Matches on a substring of the SQL, which keeps
// tests readable and — importantly — lets them ASSERT ON THE SQL ITSELF: the invariant-#3 tests
// check that the visibility predicate and the caller's namespace ids actually reach the query,
// which is the thing that would silently break if someone hand-wrote a predicate in queries.ts.
import type { Pool } from "pg";

export interface Recorded {
  sql: string;
  params: unknown[];
}

export interface FakePool {
  pool: Pool;
  /** Every query the code under test issued, in order. */
  calls: Recorded[];
  /** Queries whose SQL contains `needle` (case-insensitive). */
  matching(needle: string): Recorded[];
  /** Register a canned response for queries containing `needle`. Later rules win ties by order. */
  on(needle: string, rows: unknown[] | ((r: Recorded) => unknown[])): void;
  reset(): void;
}

export function fakePool(): FakePool {
  const rules: Array<{ needle: string; rows: unknown[] | ((r: Recorded) => unknown[]) }> = [];
  const calls: Recorded[] = [];

  const query = async (sql: unknown, params?: unknown[]) => {
    const text = typeof sql === "string" ? sql : String((sql as { text?: string } | undefined)?.text ?? "");
    const rec: Recorded = { sql: text, params: params ?? [] };
    calls.push(rec);
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i]!;
      if (text.toLowerCase().includes(rule.needle.toLowerCase())) {
        const rows = typeof rule.rows === "function" ? rule.rows(rec) : rule.rows;
        return { rows, rowCount: rows.length };
      }
    }
    return { rows: [], rowCount: 0 };
  };

  const client = {
    query,
    release: () => {},
  };

  const pool = {
    query,
    connect: async () => client,
  } as unknown as Pool;

  return {
    pool,
    calls,
    matching: (needle) => calls.filter((c) => c.sql.toLowerCase().includes(needle.toLowerCase())),
    on: (needle, rows) => rules.push({ needle, rows }),
    reset: () => {
      calls.length = 0;
      rules.length = 0;
    },
  };
}

/** The rows `authenticate()` needs to accept a bearer token, for a given user + client. */
export function authRows(opts: {
  userId?: string;
  grantId?: string;
  clientName?: string;
  expired?: boolean;
  grantRevoked?: boolean;
  clientBlocked?: boolean;
  userActive?: boolean;
} = {}) {
  return [
    {
      grant_id: opts.grantId ?? "g-1",
      user_id: opts.userId ?? "11111111-1111-1111-1111-111111111111",
      client_db_id: "c-1",
      client_name: opts.clientName ?? "Test Client",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      expired: opts.expired ?? false,
      grant_revoked: opts.grantRevoked ?? false,
      client_blocked: opts.clientBlocked ?? false,
      user_active: opts.userActive ?? true,
    },
  ];
}
