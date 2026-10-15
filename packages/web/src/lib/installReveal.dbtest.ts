// Live-DB integration test for recoverable install commands and the already-installed prompt
// (SKILLY_SPEC.md §23 "Show install URL" / "Already-installed prompt", migration 0095). Gated behind
// SKILLY_DB_E2E=1.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: the sealed token copy at mint (and none without INSTALL_TOKEN_ENC_KEY); the revealable
// flag on listInstalls (copy AND key; hash-only rows never); the claimed-install lookup that triggers
// the prompt (unclaimed never, active and inactive both); Override's replace — atomic (a failing
// insert uninstalls nothing) and scoped to the caller's own claimed personal installs (another
// user's and a system install survive; a system mint never replaces); and the reveal source the
// GET /api/installs/:id/command route authorizes on (used rows only).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { hashToken } from "@skilly/shared";
import { INSTALL_TOKEN_ENC_KEY_ENV, openInstallToken } from "@skilly/shared/install-crypto";
import { pool } from "./db";
import { getInstallRevealSource, listClaimedInstallsForSkill, listInstalls, mintInstallToken } from "./installs";

const enabled = process.env.SKILLY_DB_E2E === "1";
const R = "reveal";

after(async () => {
  if (enabled) await pool.end();
});

test("installs: recoverable copy, already-installed lookup, Override replace, reveal source (§23)", { skip: !enabled }, async () => {
  const keyB64 = randomBytes(32).toString("base64");
  const prevKey = process.env[INSTALL_TOKEN_ENC_KEY_ENV];
  process.env[INSTALL_TOKEN_ENC_KEY_ENV] = keyB64;
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('${R}-ns','Reveal NS', false)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const mkUser = async (oid: string) => (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ($1, $1 || '@org', $1, 'active')
     on conflict (entra_object_id) do update set status = 'active' returning id`,
    [oid],
  )).rows[0]!.id;
  const user = await mkUser(`${R}-u`);
  const other = await mkUser(`${R}-other`);
  const admin = await mkUser(`${R}-admin`);
  const skill = (await pool.query<{ id: string }>(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1,'${R}-s','Reveal Skill','d','claude','hosted','org','active')
     on conflict (namespace_id, slug) do update set title = excluded.title returning id`,
    [ns],
  )).rows[0]!.id;
  await pool.query(`delete from tokens where skill_id = $1`, [skill]);
  const idOf = async (raw: string) => (await pool.query<{ id: string }>(`select id from tokens where hashed_token = $1`, [hashToken(raw)])).rows[0]!.id;
  const encOf = async (raw: string) => (await pool.query<{ token_enc: string | null }>(`select token_enc from tokens where hashed_token = $1`, [hashToken(raw)])).rows[0]!.token_enc;
  // What the gateway does on first clone (used_at), optionally leaving the install expired (inactive).
  const claim = (raw: string, expired = false) => pool.query(
    `update tokens set used_at = now(), expires_at = case when $2 then now() - interval '1 day' else expires_at end where hashed_token = $1`,
    [hashToken(raw), expired],
  );
  const access = { isPlatformAdmin: false, namespaceRoles: new Map() };

  try {
    // Mint with the key: the copy is sealed (never the plaintext) and opens back to the raw token;
    // validation stays hash-only.
    const first = await mintInstallToken(user, skill, null, null);
    const enc = await encOf(first.raw);
    assert.ok(enc && enc.startsWith("v1:"), "token_enc stored in the v1: format");
    assert.ok(!enc.includes(first.raw), "never the plaintext");
    assert.equal(openInstallToken(enc), first.raw);
    assert.equal(first.replaced, 0);

    // Unclaimed commands never count as "already installed"; claimed ones (active or inactive) do.
    assert.deepEqual(await listClaimedInstallsForSkill(user, skill), []);
    await claim(first.raw);
    const pinned = await mintInstallToken(user, skill, "1.0.0", null);
    await claim(pinned.raw, true);
    const existing = await listClaimedInstallsForSkill(user, skill);
    assert.equal(existing.length, 2);
    assert.equal(existing.find((e) => e.pinnedSemver === "1.0.0")!.inactive, true);
    assert.equal(existing.find((e) => e.pinnedSemver === null)!.inactive, false);
    assert.deepEqual(await listClaimedInstallsForSkill(other, skill), [], "owner-scoped");

    // Reveal source: used rows only, carrying the ownership the route authorizes on.
    const firstId = await idOf(first.raw);
    const src = await getInstallRevealSource(firstId);
    assert.ok(src);
    assert.equal(src.userId, user);
    assert.equal(src.isSystem, false);
    assert.equal(src.namespaceSlug, `${R}-ns`);
    assert.equal(src.skillSlug, `${R}-s`);
    assert.equal(src.toolHarness, "claude");
    assert.equal(src.pinnedSemver, null);
    assert.equal(openInstallToken(src.tokenEnc), first.raw);
    const unclaimed = await mintInstallToken(user, skill, null, null);
    assert.equal(await getInstallRevealSource(await idOf(unclaimed.raw)), null, "a never-claimed command has no installed row to reveal");

    // revealable = a stored copy AND a configured key; a hash-only (pre-0095) row never is.
    const legacy = (await pool.query<{ id: string }>(
      `insert into tokens (user_id, type, hashed_token, skill_id, scope, used_at) values ($1,'install',$2,$3,'{}'::jsonb, now()) returning id`,
      [user, `${R}-legacy-${Math.random()}`, skill],
    )).rows[0]!.id;
    let mine = await listInstalls(user, access);
    assert.equal(mine.find((i) => i.id === firstId)!.revealable, true);
    assert.equal(mine.find((i) => i.id === legacy)!.revealable, false);
    delete process.env[INSTALL_TOKEN_ENC_KEY_ENV];
    mine = await listInstalls(user, access);
    assert.equal(mine.find((i) => i.id === firstId)!.revealable, false, "no key → nothing revealable");
    const keyless = await mintInstallToken(user, skill, null, null);
    assert.equal(await encOf(keyless.raw), null, "no key → no copy stored");
    process.env[INSTALL_TOKEN_ENC_KEY_ENV] = keyB64;

    // Override (replaceClaimed) is atomic: a failing insert leaves every claimed install in place.
    await assert.rejects(mintInstallToken(user, skill, null, new Date(Number.NaN), { replaceClaimed: true }));
    assert.equal((await listClaimedInstallsForSkill(user, skill)).length, 3, "rolled back — nothing uninstalled");

    // Override replaces ONLY the caller's claimed personal installs of this skill: another user's
    // install and a system install survive, and the new command is a fresh unclaimed token.
    const othersRaw = (await mintInstallToken(other, skill, null, null)).raw;
    await claim(othersRaw);
    const sysRaw = (await mintInstallToken(admin, skill, null, null, { system: true })).raw;
    await claim(sysRaw);
    const replaced = await mintInstallToken(user, skill, null, null, { replaceClaimed: true });
    assert.equal(replaced.replaced, 3);
    assert.deepEqual(await listClaimedInstallsForSkill(user, skill), []);
    assert.equal((await listClaimedInstallsForSkill(other, skill)).length, 1);
    assert.equal((await pool.query(`select 1 from tokens where hashed_token = $1`, [hashToken(sysRaw)])).rowCount, 1, "system install untouched");
    const fresh = (await pool.query<{ used_at: string | null; user_id: string }>(`select used_at, user_id from tokens where hashed_token = $1`, [hashToken(replaced.raw)])).rows[0]!;
    assert.equal(fresh.used_at, null);
    assert.equal(fresh.user_id, user);

    // replaceClaimed never applies to a system mint, and a system mint stores a copy too.
    await claim(replaced.raw);
    const sys2 = await mintInstallToken(admin, skill, null, null, { system: true, replaceClaimed: true });
    assert.equal(sys2.replaced, 0);
    assert.equal((await listClaimedInstallsForSkill(user, skill)).length, 1);
    assert.equal(openInstallToken(await encOf(sys2.raw)), sys2.raw);
    const sysSrc = await getInstallRevealSource(await idOf(sysRaw));
    assert.equal(sysSrc!.isSystem, true);
    assert.equal(sysSrc!.userId, null);
  } finally {
    if (prevKey === undefined) delete process.env[INSTALL_TOKEN_ENC_KEY_ENV];
    else process.env[INSTALL_TOKEN_ENC_KEY_ENV] = prevKey;
    await pool.query(`delete from tokens where skill_id = $1`, [skill]);
    await pool.query(`delete from skills where id = $1`, [skill]);
  }
});
