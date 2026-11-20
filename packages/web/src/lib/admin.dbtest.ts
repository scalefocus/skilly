// Live-DB integration test for the platform-admin flows. Gated behind SKILLY_DB_E2E=1.
// Run via tsx (the admin functions take a Pool and have only type-only external imports):
//
//   start pg + apply db/migrations (0001 …)
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Validates: namespace create/update (incl. global review guard), role-mapping create with
// the platform/namespace invariants, delete, and that each mutation writes an audit row. Also the
// Administration → Namespaces card's review target (§75.5): the list carries the target and the
// live proposal counts, and the admin PATCH saves, clears, refuses and audits it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { addBusinessDays, type EffectiveAccess } from "@skilly/shared";
import {
  createNamespace, updateNamespace, createRoleMapping, deleteRoleMapping, getAdminConfig,
  listNamespacePage, patchNamespaceFromAdministration,
} from "./admin";

const enabled = process.env.SKILLY_DB_E2E === "1";

// The §75.5 test goes through lib/namespaceAdmin's writer, which uses the app's own pool.
after(async () => {
  if (enabled) {
    const { pool } = await import("./db");
    await pool.end();
  }
});

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

    // maintainer contact (§30.6): the same shared check the editors run, on this write path too.
    const contactOf = async () => (await pool.query<{ maintainer_contact: string | null }>(
      `select maintainer_contact from namespaces where id = $1`, [nsId],
    )).rows[0]!.maintainer_contact;

    assert.equal(await updateNamespace(pool, nsId, { maintainerContact: "team-z@example.com" }, actor), null);
    assert.equal(await contactOf(), "team-z@example.com");

    // Malformed values are refused and leave the stored value untouched.
    for (const bad of ["ask the team", "team-z", "team-z@", "team-z@example.c", "team-z@org"]) {
      assert.ok((await updateNamespace(pool, nsId, { maintainerContact: bad }, actor)) !== null, `refuses ${bad}`);
      assert.equal(await contactOf(), "team-z@example.com", `a refused write must not change the row (${bad})`);
    }

    // Clearing must reach the column: this path used to `coalesce` the contact, so an explicit
    // null read as "not supplied" and silently kept the old address.
    assert.equal(await updateNamespace(pool, nsId, { maintainerContact: "" }, actor), null);
    assert.equal(await contactOf(), null, "empty clears the contact");
    assert.equal(await updateNamespace(pool, nsId, { maintainerContact: "team-z@example.com" }, actor), null);
    assert.equal(await updateNamespace(pool, nsId, { maintainerContact: null }, actor), null);
    assert.equal(await contactOf(), null, "an explicit null clears the contact");

    // A patch that omits the contact still leaves it alone.
    assert.equal(await updateNamespace(pool, nsId, { maintainerContact: "keep-z@example.com" }, actor), null);
    assert.equal(await updateNamespace(pool, nsId, { requireReview: true }, actor), null);
    assert.equal(await contactOf(), "keep-z@example.com", "an unrelated patch must not touch the contact");

    // A namespace cannot be BORN with a contact the editors would refuse to save.
    assert.ok("error" in (await createNamespace(
      pool, { slug: "team-bad-contact", displayName: "Bad", requireReview: true, maintainerContact: "nope" }, actor,
    )), "create refuses a malformed contact");

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

// §75.5 — the Administration → Namespaces card. Per-run rows (namespace, submitter, proposals) are
// never deleted: audit_log is append-only and references the namespace. Every exact assertion is
// scoped to this run's own namespace, since the DB test files share one database.
test("§75.5 Administration card: review target and live proposal counts", { skip: !enabled }, async () => {
  const { pool } = await import("./db");
  const tag = `adm75${Date.now().toString(36)}`;
  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await pool.query(sql, params)).rows[0] as T;

  // A fixed, upserted actor: its audit rows pin it forever (FK + append-only).
  const actor = (await one<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ('admin-oid','admin@org','Admin')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
  )).id;
  const submitter = (await one<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ($1, $2, $3) returning id`,
    [`${tag}-submitter`, `${tag}-submitter@org`, `${tag} submitter`],
  )).id;
  const nsSlug = `${tag}-ns`;
  const ns = (await one<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ($1, $1, true) returning id`,
    [nsSlug],
  )).id;

  const platform: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };
  const nsAdmin: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_admin"]]) };

  const mkProposal = async (slug: string, state = "proposed") => {
    const id = (await one<{ id: string }>(
      `insert into proposals (target_namespace_id, proposed_semver, state, submitted_by)
       values ($1, '1.0.0', $2, $3) returning id`,
      [ns, state, submitter],
    )).id;
    await pool.query(
      `insert into proposal_revisions (proposal_id, revision_no, payload, author) values ($1, 1, $2::jsonb, $3)`,
      [id, JSON.stringify({ metadata: { skillSlug: slug, title: slug, description: "d", categories: [], toolHarness: "generic" } }), submitter],
    );
    return id;
  };
  const turn = (id: string) =>
    one<{ turn_started_at: Date; turn_due_at: Date | null }>(`select turn_started_at, turn_due_at from proposals where id = $1`, [id]);
  // The card's row for this namespace, through the paged-list form (the search narrows to it).
  const row = async () => {
    const page = await listNamespacePage(pool, 0, 200, nsSlug);
    const mine = page.find((n) => n.id === ns);
    assert.ok(mine, "the namespace is listed");
    return mine;
  };
  const patch = (access: EffectiveAccess, id: string, body: Parameters<typeof patchNamespaceFromAdministration>[3]) =>
    patchNamespaceFromAdministration(pool, access, id, body, actor);

  // ── a namespace with nothing open ───────────────────────────────────────────────────────
  let v = await row();
  assert.equal(v.reviewTargetDays, null);
  assert.deepEqual([v.openProposals, v.unassignedProposals, v.overdueProposals], [0, 0, 0]);

  // ── the three counts ────────────────────────────────────────────────────────────────────
  // Three open proposals (one of them assigned) and a decided one, which never counts.
  const pWaiting = await mkProposal(`${tag}-waiting`);
  const pAssigned = await mkProposal(`${tag}-assigned`, "under_review");
  await mkProposal(`${tag}-changes`, "changes_requested");
  await mkProposal(`${tag}-rejected`, "rejected");
  await pool.query(`update proposals set assignee_id = $2 where id = $1`, [pAssigned, actor]);
  v = await row();
  assert.deepEqual([v.openProposals, v.unassignedProposals, v.overdueProposals], [3, 2, 0], "open, unassigned, overdue");

  // ── saving the target: stored, and the namespace's open proposals re-dated (§65.3) ──────
  assert.equal((await turn(pWaiting)).turn_due_at, null, "no target, no due date");
  assert.deepEqual(await patch(platform, ns, { reviewTargetDays: 2 }), { ok: true, tokensRevoked: 0 });
  v = await row();
  assert.equal(v.reviewTargetDays, 2);
  let t = await turn(pWaiting);
  assert.equal(t.turn_due_at?.toISOString(), addBusinessDays(t.turn_started_at, 2).toISOString(), "the save re-dated the open proposal");
  // A reviewer-turn proposal past its due instant is the one overdue.
  await pool.query(`update proposals set turn_started_at = now() - interval '30 days' where id = $1`, [pWaiting]);
  assert.ok((await turn(pWaiting)).turn_due_at!.getTime() < Date.now());
  v = await row();
  assert.deepEqual([v.openProposals, v.unassignedProposals, v.overdueProposals], [3, 2, 1]);
  // The full-config form carries the same fields on every namespace it returns.
  const cfg = await getAdminConfig(pool);
  assert.ok(cfg.namespaces.length > 0);
  for (const n of cfg.namespaces) {
    assert.ok(n.reviewTargetDays === null || Number.isInteger(n.reviewTargetDays), `${n.slug}: reviewTargetDays`);
    for (const k of ["openProposals", "unassignedProposals", "overdueProposals"] as const) {
      assert.ok(Number.isInteger(n[k]) && n[k] >= 0, `${n.slug}: ${k}`);
    }
  }

  // ── refused values: 422 with the shared validator's message, and the row untouched ──────
  for (const bad of [0, 31, 2.5, "soon", true]) {
    const res = await patch(platform, ns, { reviewTargetDays: bad });
    assert.ok(!res.ok && res.status === 422, `expected 422 for ${JSON.stringify(bad)}`);
    if (!res.ok) assert.match(res.error, /whole number of business days from 1 to 30/);
    assert.equal((await row()).reviewTargetDays, 2, `a refused write must not change the row (${JSON.stringify(bad)})`);
  }

  // ── authority: platform admins only, even for an admin of this very namespace ───────────
  const refused = await patch(nsAdmin, ns, { reviewTargetDays: 5 });
  assert.deepEqual(refused, { ok: false, status: 403, error: "platform admin required" });
  assert.equal((await row()).reviewTargetDays, 2);
  const unknown = await patch(platform, randomUUID(), { reviewTargetDays: 5 });
  assert.ok(!unknown.ok && unknown.status === 404);

  // ── clearing: null stored, and the due dates gone with it ───────────────────────────────
  assert.deepEqual(await patch(platform, ns, { reviewTargetDays: null }), { ok: true, tokensRevoked: 0 });
  v = await row();
  assert.equal(v.reviewTargetDays, null);
  assert.equal(v.overdueProposals, 0, "no target, nothing overdue");
  t = await turn(pWaiting);
  assert.equal(t.turn_due_at, null);

  // ── audit: one `namespace.updated` per accepted change, none for a refusal ──────────────
  const audits = (await pool.query<{ before: { reviewTargetDays?: number | null }; after: { reviewTargetDays?: number | null } }>(
    `select before, after from audit_log
      where action = 'namespace.updated' and namespace_id = $1 and actor_user_id = $2 order by seq`,
    [ns, actor],
  )).rows;
  assert.deepEqual(
    audits.map((a) => [a.before.reviewTargetDays ?? null, a.after.reviewTargetDays ?? null]),
    [[null, 2], [2, null]],
  );

  // ── the card's other writes still land through the same PATCH ───────────────────────────
  assert.deepEqual(await patch(platform, ns, { requireReview: false }), { ok: true });
  assert.equal((await row()).requireReview, false);
  assert.deepEqual(await patch(platform, ns, { maintainerContact: `${tag}@example.com` }), { ok: true });
  assert.equal((await row()).maintainerContact, `${tag}@example.com`);
  const badContact = await patch(platform, ns, { maintainerContact: "not an email" });
  assert.ok(!badContact.ok && badContact.status === 422);
  assert.equal((await row()).reviewTargetDays, null, "an unrelated write leaves the target alone");
});
