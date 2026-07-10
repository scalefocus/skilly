// Live-DB integration test for the platform-admin flows. Gated behind SKILLY_DB_E2E=1.
// Run via tsx (the admin functions take a Pool and have only type-only external imports):
//
//   start pg + apply db/migrations (0001 …)
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Validates: namespace create/update (incl. global review guard), role-mapping create with
// the platform/namespace invariants, delete, and that each mutation writes an audit row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNamespace, updateNamespace, createRoleMapping, deleteRoleMapping, getAdminConfig } from "./admin";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("admin flows: namespaces + role mappings + audit", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const actor = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('admin-oid','admin@org','Admin')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;
    const group = (await pool.query<{ id: string }>(
      `insert into groups (entra_object_id, display_name) values ('grp-oid','Team Z Admins')
       on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;

    // create namespace (idempotent across local re-runs: the namespace is pinned by
    // append-only audit FKs and can't be deleted, so tolerate a pre-existing 'team-z').
    const created = await createNamespace(pool, { slug: "team-z", displayName: "Team Z", requireReview: true }, actor);
    const nsId = "id" in created
      ? created.id
      : (await pool.query<{ id: string }>(`select id from namespaces where slug = 'team-z'`)).rows[0]!.id;

    // duplicate slug rejected
    assert.ok("error" in (await createNamespace(pool, { slug: "team-z", displayName: "dup", requireReview: true }, actor)));

    // appears in config
    let cfg = await getAdminConfig(pool);
    assert.ok(cfg.namespaces.some((n) => n.slug === "team-z"));

    // toggle review off
    assert.equal(await updateNamespace(pool, nsId, { requireReview: false }, actor), null);
    cfg = await getAdminConfig(pool);
    assert.equal(cfg.namespaces.find((n) => n.slug === "team-z")!.requireReview, false);

    // global review guard
    const globalId = cfg.namespaces.find((n) => n.slug === "global")!.id;
    assert.ok((await updateNamespace(pool, globalId, { requireReview: false }, actor)) !== null, "global guard blocks");

    // role mapping invariants
    assert.ok("error" in (await createRoleMapping(pool, { groupId: group, namespaceId: nsId, role: "platform_admin" }, actor)));
    assert.ok("error" in (await createRoleMapping(pool, { groupId: group, namespaceId: null, role: "namespace_admin" }, actor)));

    // valid namespace mapping
    const map = await createRoleMapping(pool, { groupId: group, namespaceId: nsId, role: "namespace_admin" }, actor);
    assert.ok("id" in map);
    const mapId = (map as { id: string }).id;

    cfg = await getAdminConfig(pool);
    assert.equal(cfg.namespaces.find((n) => n.slug === "team-z")!.mappings.length, 1);

    // delete mapping
    await deleteRoleMapping(pool, mapId, actor);
    cfg = await getAdminConfig(pool);
    assert.equal(cfg.namespaces.find((n) => n.slug === "team-z")!.mappings.length, 0);

    // audit trail recorded
    const actions = (await pool.query<{ action: string }>(
      `select distinct action from audit_log where actor_user_id = $1`,
      [actor],
    )).rows.map((r) => r.action);
    for (const a of ["namespace.created", "namespace.updated", "role_mapping.created", "role_mapping.deleted"]) {
      assert.ok(actions.includes(a), `audit has ${a}`);
    }

    // audit hash chain (migration 0008): every row is hashed and the chain verifies intact.
    const hashed = (await pool.query<{ n: string }>(`select count(*)::text as n from audit_log where entry_hash is not null`)).rows[0]!.n;
    assert.ok(Number(hashed) > 0, "audit rows carry entry_hash");
    const broken = (await pool.query(`select 1 from verify_audit_chain()`)).rowCount ?? 0;
    assert.equal(broken, 0, "audit hash chain is intact");

    // Tamper with one row's content and confirm the verifier flags it (then restore).
    const victim = (await pool.query<{ id: string; action: string }>(
      `select id, action from audit_log order by seq desc limit 1`,
    )).rows[0]!;
    // The append-only trigger blocks UPDATE via the app path; do it as the test (owner) role
    // by temporarily disabling the guard, to prove the chain *detects* out-of-band tampering.
    await pool.query(`alter table audit_log disable trigger trg_audit_append_only`);
    await pool.query(`update audit_log set action = action || '-tampered' where id = $1`, [victim.id]);
    const afterTamper = (await pool.query(`select 1 from verify_audit_chain()`)).rowCount ?? 0;
    assert.ok(afterTamper > 0, "verifier detects tampering");
    await pool.query(`update audit_log set action = $2 where id = $1`, [victim.id, victim.action]);
    await pool.query(`alter table audit_log enable trigger trg_audit_append_only`);
  } finally {
    await pool.end();
  }
});
