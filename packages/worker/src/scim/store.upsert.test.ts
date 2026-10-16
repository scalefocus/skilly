// upsertUser's directory-profile contract (SKILLY_SPEC.md §5, §28). The columns may only be
// touched by a writer that CARRIES them (Graph reconciliation); SCIM, which never sends them, must
// leave whatever Graph wrote intact. That distinction is a single boolean parameter in the SQL, so
// it's worth pinning here with a fake pool rather than only in a live-DB test.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { upsertUser } from "./store.js";

function fakePool(existing: { id: string; status: string } | null = null) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      // §49.7: upsertUser first reads the prior row (for the provisioning audit), then upserts.
      if (/^select id, status from users/.test(sql.trim())) return { rows: existing ? [existing] : [] };
      if (/insert into audit_log/.test(sql)) return { rows: [] };
      return { rows: [{ id: "user-1" }] };
    },
  } as unknown as Pool;
  /** The users upsert statement (never the audit-read or the audit insert). */
  const upsert = () => calls.find((c) => /insert into users/.test(c.sql))!;
  const audits = () => calls.filter((c) => /insert into audit_log/.test(c.sql)).map((c) => c.params[0]);
  return { pool, calls, upsert, audits };
}

test("a caller WITHOUT a directory profile (SCIM) does not write the columns", async () => {
  const { pool, upsert } = fakePool();

  await upsertUser(pool, { externalId: "oid-1", email: "a@org", displayName: "A", active: true });

  const p = upsert().params;
  assert.equal(p[7], false, "the write-directory flag must be off");
  assert.deepEqual([p[4], p[5], p[6]], [null, null, null]);
  // The flag guards each column, so `false` leaves all three at their stored values.
  assert.match(upsert().sql, /job_title = case when \$8::boolean then excluded\.job_title else users\.job_title end/);
});

test("a caller WITH a directory profile (reconciliation) overwrites the columns", async () => {
  const { pool, upsert } = fakePool();

  await upsertUser(pool, {
    externalId: "oid-1",
    email: "a@org",
    displayName: "A",
    active: true,
    directory: { jobTitle: "Delivery Lead", officeLocation: "Sofia", department: "Engineering" },
  });

  const p = upsert().params;
  assert.equal(p[7], true);
  assert.deepEqual([p[4], p[5], p[6]], ["Delivery Lead", "Sofia", "Engineering"]);
});

test("an all-null directory profile still overwrites — that's how a stale title gets cleared", async () => {
  const { pool, upsert } = fakePool();

  await upsertUser(pool, {
    externalId: "oid-1",
    email: "a@org",
    displayName: "A",
    active: true,
    directory: { jobTitle: null, officeLocation: null, department: null },
  });

  // Carrying the key is what matters, not whether the values are non-null: the flag stays true so
  // the NULLs are written through (deliberately unlike `avatar`, which is fill-if-missing only).
  assert.equal(upsert().params[7], true);
});

test("§49.7: a first-seen user is audited as user.provisioned; a status flip as deactivated/reactivated; attribute churn is not", async () => {
  const fresh = fakePool(null);
  await upsertUser(fresh.pool, { externalId: "oid-1", email: "a@org", displayName: "A", active: true });
  assert.deepEqual(fresh.audits(), ["user.provisioned"]);

  const leaver = fakePool({ id: "user-1", status: "active" });
  await upsertUser(leaver.pool, { externalId: "oid-1", email: "a@org", displayName: "A", active: false });
  assert.deepEqual(leaver.audits(), ["user.deactivated"]);

  const back = fakePool({ id: "user-1", status: "inactive" });
  await upsertUser(back.pool, { externalId: "oid-1", email: "a@org", displayName: "A", active: true });
  assert.deepEqual(back.audits(), ["user.reactivated"]);

  const same = fakePool({ id: "user-1", status: "active" });
  await upsertUser(same.pool, { externalId: "oid-1", email: "renamed@org", displayName: "A2", active: true });
  assert.deepEqual(same.audits(), []);
});
