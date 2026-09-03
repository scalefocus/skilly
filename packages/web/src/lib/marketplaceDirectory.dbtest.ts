// Live-DB integration test for the Marketplaces directory (SKILLY_SPEC.md §30.6 Page 3) and the
// catalog namespace view (§10). Gated by SKILLY_DB_E2E=1.
//
// What must hold (invariant #3 first):
//   - a namespace row appears ONLY for callers holding a role in it (platform admins: all);
//   - a DISABLED marketplace never appears, even to its own members;
//   - the public row appears iff the platform switch is on;
//   - the count is the marketplace PAYLOAD (namespace-visibility skills with a git-published
//     active version), not the namespace's catalog size;
//   - the contact resolves to none / user / email by the three-state rule (active users only);
//   - `added` reflects the caller's own USED tokens (active / expired / none);
//   - the catalog `?ns=` view is visibility-scoped: an outsider sees only org-visible skills.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import { listMarketplaceDirectory } from "./marketplaceDirectory";
import { searchSkills } from "./catalog";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

after(async () => {
  if (enabled) await pool.end();
});

const P = "mkd"; // seed prefix — every row this test creates carries it

async function mkNs(slug: string, opts: { enabled: boolean; contact: string | null; syncedAt?: string | null }): Promise<string> {
  return (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review, maintainer_contact, marketplace_enabled, marketplace_synced_at)
     values ($1, $2, true, $3, $4, $5)
     on conflict (slug) do update
       set display_name = excluded.display_name, maintainer_contact = excluded.maintainer_contact,
           marketplace_enabled = excluded.marketplace_enabled, marketplace_synced_at = excluded.marketplace_synced_at
     returning id`,
    [slug, `NS ${slug}`, opts.contact, opts.enabled, opts.syncedAt ?? null],
  )).rows[0]!.id;
}

async function mkUser(oid: string, email: string, status: "active" | "inactive" = "active"): Promise<string> {
  return (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ($1, $2, $3, $4)
     on conflict (entra_object_id) do update set email = excluded.email, status = excluded.status, erased_at = null
     returning id`,
    [oid, email, oid, status],
  )).rows[0]!.id;
}

async function mkSkill(ns: string, slug: string, visibility: "org" | "namespace", published: boolean): Promise<string> {
  const id = (await pool.query<{ id: string }>(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1, $2, $2, 'd', 'claude', 'hosted', $3, 'active')
     on conflict (namespace_id, slug) do update set visibility = excluded.visibility, status = 'active'
     returning id`,
    [ns, slug, visibility],
  )).rows[0]!.id;
  await pool.query(
    `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, git_published)
     values ($1, '1.0.0', false, 'active', $2, $3)
     on conflict (skill_id, semver) do update set git_published = excluded.git_published, status = 'active'`,
    [id, `${P}/${slug}/1.0.0.tgz`, published],
  );
  return id;
}

test("marketplace directory: row set, counts, contacts, added state, and the catalog namespace view", { skip: !enabled }, async () => {
  // --- namespaces --------------------------------------------------------------------------
  const contactUser = await mkUser(`${P}-contact`, `${P}-contact@org`);
  await mkUser(`${P}-leaver`, `${P}-leaver@org`, "inactive");
  const viewer = await mkUser(`${P}-viewer`, `${P}-viewer@org`);

  const nsOn = await mkNs(`${P}-on`, { enabled: true, contact: `${P.toUpperCase()}-Contact@ORG`, syncedAt: "2026-09-03T10:00:00Z" }); // case-insensitive match
  const nsOff = await mkNs(`${P}-off`, { enabled: false, contact: `${P}-contact@org` });
  const nsList = await mkNs(`${P}-list`, { enabled: true, contact: `${P}-team@org` }); // nobody has this address
  const nsGone = await mkNs(`${P}-gone`, { enabled: true, contact: `${P}-leaver@org` }); // an INACTIVE user → email state
  const nsNone = await mkNs(`${P}-none`, { enabled: true, contact: null });

  // Payload vs catalog size: two org-visible + one namespace-visible published + one namespace-
  // visible UNpublished. The marketplace publishes exactly ONE.
  await mkSkill(nsOn, `${P}-org-1`, "org", true);
  await mkSkill(nsOn, `${P}-org-2`, "org", true);
  await mkSkill(nsOn, `${P}-restricted`, "namespace", true);
  await mkSkill(nsOn, `${P}-restricted-draft`, "namespace", false);

  // --- tokens: viewer has an EXPIRED used token for -on and an ACTIVE one for -none ------------
  await pool.query(`delete from tokens where user_id = $1 and type = 'marketplace'`, [viewer]);
  await pool.query(
    `insert into tokens (user_id, type, hashed_token, marketplace_scope, namespace_id, scope, expires_at, used_at, is_system)
     values ($1, 'marketplace', $2, 'namespace', $3, '{}'::jsonb, now() - interval '1 day', now() - interval '2 days', false),
            ($1, 'marketplace', $4, 'namespace', $5, '{}'::jsonb, null, now() - interval '1 hour', false)`,
    [viewer, `${P}-hash-expired-${Date.now()}`, nsOn, `${P}-hash-active-${Date.now()}`, nsNone],
  );

  const member: EffectiveAccess = {
    isPlatformAdmin: false,
    namespaceRoles: new Map([[nsOn, "namespace_member"], [nsOff, "namespace_member"], [nsList, "namespace_member"], [nsGone, "namespace_member"], [nsNone, "namespace_member"]]),
  };
  const outsider: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };
  const platform: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };

  const mine = <T extends { namespaceSlug: string | null }>(rows: T[]): T[] => rows.filter((r) => r.namespaceSlug?.startsWith(`${P}-`));

  // --- member -----------------------------------------------------------------------------
  const rows = await listMarketplaceDirectory(member, viewer, "skilly", false);
  assert.ok(!rows.some((r) => r.scope === "public"), "public switch off → no public row");
  const seen = mine(rows);
  assert.deepEqual(
    seen.map((r) => r.namespaceSlug),
    [`${P}-gone`, `${P}-list`, `${P}-none`, `${P}-on`],
    "enabled marketplaces the member may mint for, alphabetical; the DISABLED one is absent",
  );

  const on = seen.find((r) => r.namespaceSlug === `${P}-on`)!;
  assert.equal(on.skillCount, 1, "payload count: one published namespace-visibility skill, not the 4-skill catalog");
  assert.equal(on.name, `skilly-${P}-on`);
  assert.equal(on.displayName, `NS ${P}-on`);
  assert.equal(on.syncedAt, "2026-09-03T10:00:00.000Z", "freshness stamp round-trips as ISO");
  assert.deepEqual(on.contact, { kind: "user", userId: contactUser, displayName: `${P}-contact`, avatar: null }, "contact resolves case-insensitively to the active user");
  assert.equal(on.added, "expired", "only an expired used token → expired");

  const list = seen.find((r) => r.namespaceSlug === `${P}-list`)!;
  assert.deepEqual(list.contact, { kind: "email", email: `${P}-team@org` }, "an address nobody holds → email state");
  assert.equal(list.skillCount, 0, "zero-skill marketplaces are listed");
  assert.equal(list.syncedAt, null, "never swept → null");
  assert.equal(list.added, "none");

  const gone = seen.find((r) => r.namespaceSlug === `${P}-gone`)!;
  assert.deepEqual(gone.contact, { kind: "email", email: `${P}-leaver@org` }, "an INACTIVE user never resolves — a leaver becomes a plain address");

  const none = seen.find((r) => r.namespaceSlug === `${P}-none`)!;
  assert.deepEqual(none.contact, { kind: "none" });
  assert.equal(none.added, "active", "a never-expiring used token → active");

  // --- outsider: none of these namespaces exist, as far as they can tell ---------------------
  const outsiderRows = await listMarketplaceDirectory(outsider, viewer, "skilly", true);
  assert.equal(mine(outsiderRows).length, 0, "no role → no namespace row, not even the enabled ones (invariant #3)");
  assert.equal(outsiderRows[0]?.scope, "public", "public switch on → public row, pinned first");
  assert.deepEqual(outsiderRows[0]!.contact, { kind: "none" }, "the platform owns the public marketplace");
  assert.equal(outsiderRows[0]!.namespaceSlug, null);
  assert.equal(outsiderRows[0]!.name, "skilly-public");
  assert.ok(outsiderRows[0]!.skillCount >= 2, "public count spans org-visible skills across namespaces");

  // --- platform admin: every enabled namespace, still never the disabled one -----------------
  const adminRows = mine(await listMarketplaceDirectory(platform, viewer, "skilly", false));
  assert.ok(adminRows.some((r) => r.namespaceSlug === `${P}-on`));
  assert.ok(!adminRows.some((r) => r.namespaceSlug === `${P}-off`), "disabled is hidden for admins too — there is no repo to add");

  // --- catalog namespace view (§10): scoped by the viewer's visibility -----------------------
  const slugs = (rows: { skillSlug: string }[]) => rows.map((r) => r.skillSlug).filter((s) => s.startsWith(`${P}-`)).sort();
  assert.deepEqual(
    slugs(await searchSkills(member, { namespaceSlug: `${P}-on`, limit: 100 })),
    [`${P}-org-1`, `${P}-org-2`, `${P}-restricted`, `${P}-restricted-draft`],
    "a member sees the namespace's whole visible catalog (org + namespace visibility)",
  );
  assert.deepEqual(
    slugs(await searchSkills(outsider, { namespaceSlug: `${P}-on`, limit: 100 })),
    [`${P}-org-1`, `${P}-org-2`],
    "an outsider filtering on a namespace they don't belong to sees only its org-visible skills",
  );
  assert.deepEqual(slugs(await searchSkills(platform, { namespaceSlug: `${P}-no-such-ns`, limit: 100 })), [], "unknown slug → empty, not an error");

  // Cleanup the tokens we minted (namespaces/skills stay as idempotent seed rows).
  await pool.query(`delete from tokens where user_id = $1 and type = 'marketplace'`, [viewer]);
});
