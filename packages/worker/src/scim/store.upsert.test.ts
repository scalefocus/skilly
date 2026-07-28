// upsertUser's directory-profile contract (SKILLY_SPEC.md §5, §28). The columns may only be
// touched by a writer that CARRIES them (Graph reconciliation); SCIM, which never sends them, must
// leave whatever Graph wrote intact. That distinction is a single boolean parameter in the SQL, so
// it's worth pinning here with a fake pool rather than only in a live-DB test.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { upsertUser } from "./store.js";

function fakePool() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return { rows: [{ id: "user-1" }] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

test("a caller WITHOUT a directory profile (SCIM) does not write the columns", async () => {
  const { pool, calls } = fakePool();

  await upsertUser(pool, { externalId: "oid-1", email: "a@org", displayName: "A", active: true });

  const p = calls[0]!.params;
  assert.equal(p[7], false, "the write-directory flag must be off");
  assert.deepEqual([p[4], p[5], p[6]], [null, null, null]);
  // The flag guards each column, so `false` leaves all three at their stored values.
  assert.match(calls[0]!.sql, /job_title = case when \$8::boolean then excluded\.job_title else users\.job_title end/);
});

test("a caller WITH a directory profile (reconciliation) overwrites the columns", async () => {
  const { pool, calls } = fakePool();

  await upsertUser(pool, {
    externalId: "oid-1",
    email: "a@org",
    displayName: "A",
    active: true,
    directory: { jobTitle: "Delivery Lead", officeLocation: "Sofia", department: "Engineering" },
  });

  const p = calls[0]!.params;
  assert.equal(p[7], true);
  assert.deepEqual([p[4], p[5], p[6]], ["Delivery Lead", "Sofia", "Engineering"]);
});

test("an all-null directory profile still overwrites — that's how a stale title gets cleared", async () => {
  const { pool, calls } = fakePool();

  await upsertUser(pool, {
    externalId: "oid-1",
    email: "a@org",
    displayName: "A",
    active: true,
    directory: { jobTitle: null, officeLocation: null, department: null },
  });

  // Carrying the key is what matters, not whether the values are non-null: the flag stays true so
  // the NULLs are written through (deliberately unlike `avatar`, which is fill-if-missing only).
  assert.equal(calls[0]!.params[7], true);
});
