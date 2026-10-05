// Live-DB integration test for installed-version freshness (SKILLY_SPEC.md §23, §39.3). Gated
// behind SKILLY_DB_E2E=1.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: migration 0083's columns + the gateway stamp SQL (as pgGitDeps.stampInstallServed
// writes it — pinned → pinned_semver, latest → latest stable, never touching used_at/UA/IP);
// listInstalls / listSystemInstalls returning the four freshness fields in every state (current,
// behind, withdrawn after a yank, unknown with no stamp, unknown when only betas are active);
// and the backfill rule (a pre-0083 pinned install reads its pin, a latest-tracking one unknown).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { resolveLatest } from "@skilly/shared";
import { pool } from "./db";
import { listInstalls, listSystemInstalls } from "./installs";

const enabled = process.env.SKILLY_DB_E2E === "1";
const P = "fresh";

after(async () => {
  if (enabled) await pool.end();
});

/** The exact statement pgGitDeps.stampInstallServed runs (worker/src/git/pgDeps.ts), replayed here. */
async function stamp(tokenId: string, skillId: string): Promise<void> {
  const { rows } = await pool.query<{ semver: string }>(`select semver from skill_versions where skill_id = $1 and status = 'active'`, [skillId]);
  const latest = resolveLatest(rows.map((r) => r.semver));
  await pool.query(
    `update tokens set last_served_semver = coalesce(pinned_semver, $2), last_cloned_at = now() where id = $1 and type = 'install'`,
    [tokenId, latest],
  );
}

test("installs: freshness fields across current / behind / withdrawn / unknown, personal and system", { skip: !enabled }, async () => {
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('${P}-ns','Fresh NS', false)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const user = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ('${P}-u','fresh@org','Fresh U','active')
     on conflict (entra_object_id) do update set status = 'active' returning id`,
  )).rows[0]!.id;
  const admin = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ('${P}-admin','fresh-admin@org','Fresh Admin','active')
     on conflict (entra_object_id) do update set status = 'active' returning id`,
  )).rows[0]!.id;

  const mkSkill = async (slug: string, versions: Array<[string, boolean]>) => {
    const id = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1,$2,$2,'d','claude','hosted','org','active')
       on conflict (namespace_id, slug) do update set title = excluded.title returning id`,
      [ns, slug],
    )).rows[0]!.id;
    await pool.query(`delete from skill_versions where skill_id = $1`, [id]);
    for (const [semver, pre] of versions) {
      await pool.query(
        `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by)
         values ($1,$2,$3,'active',$4,'sha',$5)`,
        [id, semver, pre, `k-${slug}-${semver}`, admin],
      );
    }
    return id;
  };
  const mkToken = async (skillId: string, pinned: string | null, opts: { system?: boolean; used?: boolean } = {}) =>
    (await pool.query<{ id: string }>(
      `insert into tokens (user_id, type, hashed_token, skill_id, pinned_semver, scope, used_at, client_user_agent, client_ip, is_system, created_by_user_id)
       values ($1,'install',$2,$3,$4,'{}'::jsonb, case when $5 then now() - interval '1 day' end, 'git/2.43.0', '10.0.0.1', $6, $7)
       returning id`,
      [opts.system ? null : user, `${P}-${skillId}-${pinned ?? "latest"}-${opts.system ? "sys" : "me"}-${Math.random()}`, skillId, pinned, opts.used !== false, opts.system ?? false, opts.system ? admin : null],
    )).rows[0]!.id;

  const skillA = await mkSkill(`${P}-a`, [["1.0.0", false], ["1.1.0", false], ["1.2.0", false], ["1.3.0-beta.1", true]]);
  const skillBeta = await mkSkill(`${P}-beta-only`, [["0.1.0-beta.1", true]]);
  await pool.query(`delete from tokens where skill_id in ($1,$2)`, [skillA, skillBeta]);

  const tLatest = await mkToken(skillA, null);          // latest-tracking → stamped 1.2.0 → current
  const tPinnedOld = await mkToken(skillA, "1.0.0");    // pinned old → behind
  const tPinnedBeta = await mkToken(skillA, "1.3.0-beta.1"); // pinned beta newer than latest → current
  const tWillYank = await mkToken(skillA, "1.1.0");     // pinned; its version is yanked below → withdrawn
  const tNoStamp = await mkToken(skillA, null);         // never stamped → unknown
  const tBetaOnly = await mkToken(skillBeta, null);     // no latest stable → unknown
  const tSystem = await mkToken(skillA, "1.0.0", { system: true }); // system, behind

  // The stamp: every clone — pinned → pin, latest → latest stable; first-clone fields untouched.
  const before = (await pool.query<{ used_at: string; client_ip: string }>(`select used_at, client_ip from tokens where id = $1`, [tLatest])).rows[0]!;
  for (const t of [tLatest, tPinnedOld, tPinnedBeta, tWillYank, tBetaOnly, tSystem]) await stamp(t, t === tBetaOnly ? skillBeta : skillA);
  await stamp(tLatest, skillA); // a repeat clone re-stamps (idempotent on content here)
  const after = (await pool.query<{ used_at: string; client_ip: string; last_served_semver: string | null; last_cloned_at: string | null }>(
    `select used_at, client_ip, last_served_semver, last_cloned_at from tokens where id = $1`, [tLatest])).rows[0]!;
  assert.equal(after.last_served_semver, "1.2.0", "latest-tracking stamps the latest STABLE (not the beta)");
  assert.ok(after.last_cloned_at, "last_cloned_at set");
  assert.equal(String(after.used_at), String(before.used_at), "used_at is first-clone only");
  assert.equal(after.client_ip, before.client_ip, "client_ip is first-clone only");
  assert.equal((await pool.query<{ s: string | null }>(`select last_served_semver as s from tokens where id = $1`, [tBetaOnly])).rows[0]!.s, null, "no stable → stamp NULL");

  // Yank 1.1.0 → the install that holds it is withdrawn.
  await pool.query(`update skill_versions set status = 'yanked' where skill_id = $1 and semver = '1.1.0'`, [skillA]);

  const mine = await listInstalls(user);
  const by = (id: string) => mine.find((i) => i.id === id)!;
  assert.deepEqual(
    [tLatest, tPinnedOld, tPinnedBeta, tWillYank, tNoStamp, tBetaOnly].map((t) => by(t).freshness),
    ["current", "behind", "current", "withdrawn", "unknown", "unknown"],
  );
  assert.equal(by(tLatest).latestSemver, "1.2.0");
  assert.equal(by(tPinnedOld).lastServedSemver, "1.0.0");
  assert.equal(by(tWillYank).lastServedSemver, "1.1.0", "the withdrawn version string survives the yank");
  assert.equal(by(tNoStamp).lastClonedAt, null);
  assert.equal(by(tBetaOnly).latestSemver, null, "only betas active → no latest");
  assert.ok(!mine.some((i) => i.id === tSystem), "system rows never list under Mine");

  // System installs carry the same fields (the admin view IS the system scope + the filter).
  const sys = (await listSystemInstalls()).find((i) => i.id === tSystem)!;
  assert.equal(sys.freshness, "behind");
  assert.equal(sys.latestSemver, "1.2.0");
  assert.equal(sys.mintedBy, "Fresh Admin");

  // Backfill rule (0083), replayed: a pre-0083 pinned install reads its pin, a latest one stays unknown.
  const tLegacyPinned = await mkToken(skillA, "1.0.0");
  const tLegacyLatest = await mkToken(skillA, null);
  await pool.query(
    `update tokens set last_served_semver = pinned_semver
      where type = 'install' and used_at is not null and pinned_semver is not null and last_served_semver is null and id in ($1,$2)`,
    [tLegacyPinned, tLegacyLatest],
  );
  const mine2 = await listInstalls(user);
  assert.equal(mine2.find((i) => i.id === tLegacyPinned)!.freshness, "behind");
  assert.equal(mine2.find((i) => i.id === tLegacyLatest)!.freshness, "unknown");

  // cleanup (skill delete cascades tokens + versions)
  await pool.query(`delete from skills where id in ($1,$2)`, [skillA, skillBeta]);
});
