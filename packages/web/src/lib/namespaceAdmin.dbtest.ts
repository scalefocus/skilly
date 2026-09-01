// Live-DB integration test for the Namespace administration writer (SKILLY_SPEC.md §30.6).
// Gated behind SKILLY_DB_E2E=1:
//
//   start pg + apply db/migrations (0001 …)
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Validates the `maintainer_contact` contract both surfaces share: a malformed value is refused
// with 422, a valid address (including a shared mailbox that is nobody's user account) is stored,
// clearing writes NULL, and a refused write leaves the stored value untouched. Also covers the
// authority check and the `global.require_review` guard on this path.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";

const enabled = process.env.SKILLY_DB_E2E === "1";

/** A platform admin — authority is orthogonal to what this test exercises. */
const PLATFORM_ADMIN: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };
/** Someone with no role anywhere: every write must be refused before it reaches the DB. */
const NOBODY: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };

test("namespace settings: maintainer_contact validation, clearing, and authority", { skip: !enabled }, async () => {
  const { pool } = await import("./db");
  const { updateNamespaceSettings, listAdministeredNamespaces, GLOBAL_SLUG } = await import("./namespaceAdmin");
  const prefix = "skilly";

  const actor = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ('ns-admin-oid','ns-admin@org','NS Admin')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
  )).rows[0]!.id;

  // Idempotent across local re-runs: a namespace is pinned by append-only audit FKs and can't
  // be deleted, so tolerate a pre-existing row.
  const nsId = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('team-contact','Team Contact', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;

  const contactOf = async () =>
    (await pool.query<{ maintainer_contact: string | null }>(
      `select maintainer_contact from namespaces where id = $1`, [nsId],
    )).rows[0]!.maintainer_contact;

  // --- a good address is stored -------------------------------------------------------------
  let r = await updateNamespaceSettings(PLATFORM_ADMIN, nsId, { maintainerContact: "team@example.com" }, actor, prefix);
  assert.equal(r.ok, true);
  assert.equal(await contactOf(), "team@example.com");

  // A shared mailbox / distribution list is legitimate — the check is on address SHAPE, never
  // on the value naming a registered user (§30.6).
  r = await updateNamespaceSettings(PLATFORM_ADMIN, nsId, { maintainerContact: "dl-platform-emea@example.com" }, actor, prefix);
  assert.equal(r.ok, true);
  assert.equal(await contactOf(), "dl-platform-emea@example.com");

  // Surrounding whitespace is trimmed, not stored.
  r = await updateNamespaceSettings(PLATFORM_ADMIN, nsId, { maintainerContact: "  team@example.com  " }, actor, prefix);
  assert.equal(r.ok, true);
  assert.equal(await contactOf(), "team@example.com");

  // --- a malformed value is refused, and the stored value is untouched -----------------------
  for (const bad of ["ask the team", "team", "team@", "team@example", "<team@example.com>"]) {
    const res = await updateNamespaceSettings(PLATFORM_ADMIN, nsId, { maintainerContact: bad }, actor, prefix);
    assert.equal(res.ok, false, `expected refusal for ${bad}`);
    if (!res.ok) {
      assert.equal(res.status, 422, `expected 422 for ${bad}`);
      assert.match(res.error, /email address/);
    }
    assert.equal(await contactOf(), "team@example.com", `a refused write must not change the row (${bad})`);
  }

  // --- clearing writes NULL (empty is always allowed) ---------------------------------------
  r = await updateNamespaceSettings(PLATFORM_ADMIN, nsId, { maintainerContact: "" }, actor, prefix);
  assert.equal(r.ok, true);
  assert.equal(await contactOf(), null);

  r = await updateNamespaceSettings(PLATFORM_ADMIN, nsId, { maintainerContact: "   " }, actor, prefix);
  assert.equal(r.ok, true);
  assert.equal(await contactOf(), null, "whitespace-only clears too");

  r = await updateNamespaceSettings(PLATFORM_ADMIN, nsId, { maintainerContact: "team@example.com" }, actor, prefix);
  assert.equal(r.ok, true);
  r = await updateNamespaceSettings(PLATFORM_ADMIN, nsId, { maintainerContact: null }, actor, prefix);
  assert.equal(r.ok, true);
  assert.equal(await contactOf(), null, "an explicit null clears the contact");

  // --- a patch that omits the contact leaves it alone ----------------------------------------
  await updateNamespaceSettings(PLATFORM_ADMIN, nsId, { maintainerContact: "keep@example.com" }, actor, prefix);
  r = await updateNamespaceSettings(PLATFORM_ADMIN, nsId, { requireReview: false }, actor, prefix);
  assert.equal(r.ok, true);
  assert.equal(await contactOf(), "keep@example.com", "an unrelated patch must not touch the contact");

  // --- authority: no role anywhere → refused before any write -------------------------------
  const refused = await updateNamespaceSettings(NOBODY, nsId, { maintainerContact: "hijack@example.com" }, actor, prefix);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.status, 403);
  assert.equal(await contactOf(), "keep@example.com");

  // A namespace admin for THIS namespace may write it.
  const nsAdmin: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[nsId, "namespace_admin"]]) };
  r = await updateNamespaceSettings(nsAdmin, nsId, { maintainerContact: "own-ns@example.com" }, actor, prefix);
  assert.equal(r.ok, true);
  assert.equal(await contactOf(), "own-ns@example.com");
  // …and their malformed write is refused the same way a platform admin's is.
  const nsAdminBad = await updateNamespaceSettings(nsAdmin, nsId, { maintainerContact: "not an email" }, actor, prefix);
  assert.equal(nsAdminBad.ok, false);
  if (!nsAdminBad.ok) assert.equal(nsAdminBad.status, 422);

  // --- the global review guard still fires on this path -------------------------------------
  const globalId = (await pool.query<{ id: string }>(
    `select id from namespaces where slug = $1`, [GLOBAL_SLUG],
  )).rows[0]?.id;
  if (globalId) {
    const guarded = await updateNamespaceSettings(PLATFORM_ADMIN, globalId, { requireReview: false }, actor, prefix);
    assert.equal(guarded.ok, false);
    if (!guarded.ok) assert.equal(guarded.status, 422);
  }

  // --- the view a caller reads back reflects the stored value --------------------------------
  const view = (await listAdministeredNamespaces(PLATFORM_ADMIN, prefix)).find((n) => n.id === nsId);
  assert.equal(view?.maintainerContact, "own-ns@example.com");

  // Every accepted contact change is audited under the existing action (§30.8).
  const audited = (await pool.query<{ n: string }>(
    `select count(*)::text as n from audit_log
      where actor_user_id = $1 and action = 'namespace.updated' and namespace_id = $2`,
    [actor, nsId],
  )).rows[0]!.n;
  assert.ok(Number(audited) > 0, "contact edits are audited as namespace.updated");

  await pool.end();
});
