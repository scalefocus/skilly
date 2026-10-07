// Live-DB integration test for skill deprecation with a successor (SKILLY_SPEC.md §45). Gated by
// SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: the authority matrix (platform / owner-ns admin 200; grantee admin, maintainer, member 403;
// invisible 404; archived 409), every 422 successor reason, idempotent edit + clear, the audit rows
// (incl. the automatic skill.unfeatured), the §45.6 recipient set (watcher, explicit maintainer, ns
// admin, ACTIVE installer; inactive installer excluded; system-install minter; actor excluded; one
// row for a watcher-who-installed; successor omitted for a recipient who cannot see it; re-fire on
// successor change only), the read shaping (detail successorState: hidden for an outsider, catalog
// `deprecation`, deprecated-last ordering, installs rows, suggest + successor picker), the related
// neighbour exclusion, the feature/promote/fulfil 409s and the migration's CHECKs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess, Role } from "@skilly/shared";
import { pool } from "./db";
import { setSkillDeprecation, clearSkillDeprecation, deprecationDetail, listReplaces, suggestSuccessors } from "./deprecation";
import { findSkill, searchSkills, suggestSkillsResult } from "./catalog";
import { setSkillFeatured } from "./manage";
import { listInstalls } from "./installs";

const enabled = process.env.SKILLY_DB_E2E === "1";
const K = `dep${Date.now().toString(36)}`;

after(async () => {
  if (enabled) await pool.end();
});

const access = (roles: [string, Role][] = [], platform = false): EffectiveAccess => ({ isPlatformAdmin: platform, namespaceRoles: new Map(roles) });

async function mkNs(slug: string, name: string): Promise<string> {
  return (await pool.query<{ id: string }>(`insert into namespaces (slug, display_name, require_review) values ($1, $2, true) returning id`, [slug, name])).rows[0]!.id;
}
async function mkUserIn(key: string, ns: string | null, role: Role | null): Promise<string> {
  const user = (await pool.query<{ id: string }>(`insert into users (entra_object_id, email, display_name) values ($1, $2, $1) returning id`, [key, `${key}@org`])).rows[0]!.id;
  if (ns && role) {
    const g = (await pool.query<{ id: string }>(`insert into groups (entra_object_id, display_name) values ($1, $1) returning id`, [`${key}-grp`])).rows[0]!.id;
    await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1, $2, $3)`, [g, ns, role]);
    await pool.query(`insert into group_memberships (group_id, user_id) values ($1, $2)`, [g, user]);
  }
  return user;
}
async function mkSkill(ns: string, slug: string, visibility: "org" | "namespace", by: string, opts: { status?: "active" | "archived"; version?: boolean } = {}): Promise<string> {
  const id = (await pool.query<{ id: string }>(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1,$2,$3,'d','generic','hosted',$4,$5) returning id`,
    [ns, slug, `Title ${slug}`, visibility, opts.status ?? "active"],
  )).rows[0]!.id;
  if (opts.version !== false) {
    await pool.query(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
       values ($1,'1.0.0',false,'active','k/'||$3,'h',$2,true)`,
      [id, by, id],
    );
  }
  return id;
}
async function mkInstall(skillId: string, userId: string | null, opts: { used?: boolean; expired?: boolean; system?: boolean; mintedBy?: string } = {}): Promise<string> {
  return (await pool.query<{ id: string }>(
    `insert into tokens (user_id, type, hashed_token, skill_id, scope, used_at, expires_at, is_system, created_by_user_id)
     values ($1,'install',md5(random()::text),$2,'{}'::jsonb, case when $3 then now() - interval '1 day' end,
             case when $4 then now() - interval '1 hour' end, $5, $6) returning id`,
    [userId, skillId, opts.used !== false, opts.expired === true, opts.system === true, opts.mintedBy ?? null],
  )).rows[0]!.id;
}
const notified = async (slug: string) =>
  (await pool.query<{ user_id: string; payload: Record<string, unknown> }>(`select user_id, payload from notifications where type = 'skill.deprecated' and payload->>'skillSlug' = $1 order by created_at`, [slug])).rows;

test("§45 deprecation: authority, successor rules, audit, fan-out, read shaping, side effects", { skip: !enabled }, async () => {
  const A = await mkNs(`${K}-a`, "Alpha");
  const B = await mkNs(`${K}-b`, "Bravo");
  const C = await mkNs(`${K}-c`, "Charlie");
  const platformAdmin = await mkUserIn(`${K}-plat`, null, null);
  const aAdmin = await mkUserIn(`${K}-aadm`, A, "namespace_admin");
  const aMember = await mkUserIn(`${K}-amem`, A, "namespace_member");
  const bAdmin = await mkUserIn(`${K}-badm`, B, "namespace_admin");
  const cMember = await mkUserIn(`${K}-cmem`, C, "namespace_member");
  const watcher = await mkUserIn(`${K}-watch`, null, null);
  const installer = await mkUserIn(`${K}-inst`, null, null);
  const expiredInstaller = await mkUserIn(`${K}-expinst`, null, null);
  const maintainer = await mkUserIn(`${K}-maint`, null, null);

  const platform = access([], true);
  const asAAdmin = access([[A, "namespace_admin"]]);
  const asAMember = access([[A, "namespace_member"]]);
  const asBAdmin = access([[B, "namespace_admin"]]);
  const asCMember = access([[C, "namespace_member"]]);
  const outsider = access();

  // Skills: OLD (org, in A, featured, watched/installed) — the one we deprecate; NEW (org) the successor;
  // RESTRICTED-B (namespace B) an ineligible successor for an org skill; ARCH (archived).
  const oldSlug = `${K}-old`;
  const old = await mkSkill(A, oldSlug, "org", aAdmin);
  const newer = await mkSkill(A, `${K}-new`, "org", aAdmin);
  const restrictedB = await mkSkill(B, `${K}-rb`, "namespace", bAdmin);
  await mkSkill(A, `${K}-arch`, "org", aAdmin, { status: "archived" });
  await pool.query(`update skills set featured_at = now(), featured_by = $2 where id = $1`, [old, platformAdmin]);
  await pool.query(`insert into skill_watches (user_id, skill_id) values ($1, $2), ($3, $2)`, [watcher, old, installer]); // installer ALSO watches → one row
  await pool.query(`insert into skill_maintainers (skill_id, user_id, added_by) values ($1, $2, $3)`, [old, maintainer, aAdmin]);
  await mkInstall(old, installer);
  await mkInstall(old, expiredInstaller, { expired: true });
  await mkInstall(old, null, { system: true, mintedBy: platformAdmin });
  await mkInstall(old, cMember, { used: false }); // generated-unused → not an installer

  const dep = (a: EffectiveAccess, actor: string, slug: string, successor: string | null, note: unknown = null) =>
    setSkillDeprecation(pool, { access: a, actorUserId: actor, namespaceSlug: `${K}-a`, skillSlug: slug, successor, note });

  // ── Authority ─────────────────────────────────────────────────────────────────────────────
  assert.equal((await dep(asAMember, aMember, oldSlug, null)).ok, false, "member cannot deprecate");
  assert.equal((await dep(asAMember, aMember, oldSlug, null) as { status: number }).status, 403);
  assert.equal((await dep(access([], false), maintainer, oldSlug, null) as { status: number }).status, 403, "explicit maintainer has no authority");
  assert.equal((await dep(asBAdmin, bAdmin, oldSlug, null) as { status: number }).status, 403, "another namespace's admin has no authority");
  assert.equal((await dep(outsider, cMember, `${K}-rb`, null) as { status: number }).status, 404, "an invisible skill is 404, not 403");
  assert.equal((await dep(platform, platformAdmin, `${K}-arch`, null) as { status: number }).status, 409, "archived → 409");

  // ── Successor eligibility (422 reasons) ───────────────────────────────────────────────────
  const reason = async (succ: string | null) => { const r = await dep(asAAdmin, aAdmin, oldSlug, succ); return r.ok ? "ok" : r.reason; };
  assert.equal(await reason(`${K}-a/${oldSlug}`), "self");
  assert.equal(await reason(`${K}-a/${K}-arch`), "archived");
  assert.equal(await reason(`${K}-a/nope`), "not_found");
  assert.equal(await reason(`${K}-b/${K}-rb`), "not_found", "a successor the ACTOR cannot see reads as not found");
  assert.equal((await dep(platform, platformAdmin, oldSlug, `${K}-b/${K}-rb`) as { reason: string }).reason, "audience", "org skill → restricted successor refused");
  assert.equal((await dep(asAAdmin, aAdmin, oldSlug, null, "x".repeat(1001)) as { reason: string }).reason, "note_too_long");

  // ── Deprecate for real (owner-ns admin) ───────────────────────────────────────────────────
  const r1 = await dep(asAAdmin, aAdmin, oldSlug, `${K}-a/${K}-new`, "  Use the new one.  ");
  assert.ok(r1.ok && r1.changedSuccessor);
  const row = (await findSkill(`${K}-a`, oldSlug))!;
  assert.ok(row.deprecatedAt);
  assert.equal(row.deprecationNote, "Use the new one.");
  assert.equal(row.successor?.id, newer);
  assert.equal(row.featured, false, "deprecating clears Featured");
  const audits = (await pool.query<{ action: string; after: Record<string, unknown> }>(`select action, after from audit_log where target_id = $1 order by created_at`, [old])).rows;
  assert.deepEqual(audits.map((a) => a.action), ["skill.deprecated", "skill.unfeatured"]);
  assert.equal(audits[0]!.after.successorSlug, `${K}-a/${K}-new`);
  assert.equal(audits[1]!.after.reason, "deprecated");

  // ── Fan-out (§45.6) ───────────────────────────────────────────────────────────────────────
  const n1 = await notified(oldSlug);
  const ids = n1.map((n) => n.user_id).sort();
  assert.deepEqual(ids, [watcher, installer, maintainer, platformAdmin].sort(), "watcher ∪ maintainer ∪ ACTIVE installer ∪ system minter; actor, inactive & unused excluded; one row per user");
  assert.ok(n1.every((n) => n.payload.successorSlug === `${K}-new`), "org successor named for everyone");

  // Note-only edit: no new rows. Successor change: re-fires.
  const r2 = await dep(asAAdmin, aAdmin, oldSlug, `${K}-a/${K}-new`, "Different note.");
  assert.ok(r2.ok && !r2.changedSuccessor);
  assert.equal((await notified(oldSlug)).length, n1.length, "a note-only edit notifies nobody");
  const r3 = await dep(asAAdmin, aAdmin, oldSlug, null, "No replacement.");
  assert.ok(r3.ok && r3.changedSuccessor);
  assert.equal((await notified(oldSlug)).length, n1.length * 2, "a successor change re-notifies");
  assert.equal((await findSkill(`${K}-a`, oldSlug))!.deprecatedBy?.id, aAdmin, "edit keeps the original deprecator");
  // back to the real successor for the read-shaping checks below
  await dep(asAAdmin, aAdmin, oldSlug, `${K}-a/${K}-new`, "Use the new one.");

  // ── Read shaping ──────────────────────────────────────────────────────────────────────────
  const detailFor = async (a: EffectiveAccess, canDep: boolean) => deprecationDetail(a, (await findSkill(`${K}-a`, oldSlug))!, canDep)!;
  assert.equal((await detailFor(asAAdmin, true)).successorState, "ok");
  assert.equal((await detailFor(asAAdmin, true)).successor?.skillSlug, `${K}-new`);
  assert.equal((await detailFor(asAAdmin, true)).successor?.installable, true);
  assert.deepEqual((await listReplaces(asCMember, newer)).map((r) => r.skillSlug), [oldSlug], "the successor's 'Replaces' line");

  // Restricted → restricted, same owner: eligible; then an outsider to that namespace sees `hidden`.
  const rOld = await mkSkill(B, `${K}-rold`, "namespace", bAdmin);
  await mkSkill(B, `${K}-rnew`, "namespace", bAdmin);
  const rr = await setSkillDeprecation(pool, { access: asBAdmin, actorUserId: bAdmin, namespaceSlug: `${K}-b`, skillSlug: `${K}-rold`, successor: `${K}-b/${K}-rnew`, note: null });
  assert.ok(rr.ok, "namespace → namespace with the same owner is eligible");
  const rRow = (await findSkill(`${K}-b`, `${K}-rold`))!;
  assert.equal(deprecationDetail(platform, rRow, true)!.successorState, "ok");
  assert.equal(deprecationDetail(asCMember, rRow, false)!.successorState, "hidden", "a viewer who cannot see the successor gets no name");
  assert.equal(deprecationDetail(asCMember, rRow, false)!.successor, null);
  void rOld;

  // Catalog: `deprecation` present, deprecated skill sorts AFTER the live ones in every sort.
  const cat = await searchSkills(asAMember, { q: K, limit: 50 });
  const oldEntry = cat.find((s) => s.skillSlug === oldSlug)!;
  assert.equal(oldEntry.deprecation?.successor?.skillSlug, `${K}-new`);
  assert.equal(cat.find((s) => s.skillSlug === `${K}-new`)!.deprecation, null);
  const liveIdx = cat.findIndex((s) => s.skillSlug === `${K}-new`);
  const depIdx = cat.findIndex((s) => s.skillSlug === oldSlug);
  assert.ok(liveIdx >= 0 && depIdx > liveIdx, "deprecated sorts after live");
  for (const sort of ["top_rated", "latest", "quality"] as const) {
    const rows = await searchSkills(asAMember, { q: K, limit: 50, sort });
    const live = rows.filter((s) => !s.deprecation).length;
    assert.ok(rows.slice(live).every((s) => s.deprecation), `deprecated last under ${sort}`);
  }
  // Suggest: header dropdown lists it (marked); the org (fulfilment) scope hides it.
  const sug = await suggestSkillsResult(asAMember, oldSlug, 5);
  assert.equal(sug.suggestions.find((s) => s.skillSlug === oldSlug)?.deprecation?.successor?.skillSlug, `${K}-new`);
  const org = await suggestSkillsResult(asAMember, oldSlug, 5, { orgOnly: true, excludeDeprecated: true });
  assert.equal(org.suggestions.length, 0, "the fulfilment picker never offers a deprecated skill");
  // Successor picker: eligible only (not self, not deprecated, audience ⊇).
  const picks = await suggestSuccessors(asAAdmin, (await findSkill(`${K}-a`, oldSlug))!, K);
  assert.deepEqual(picks.map((p) => p.skillSlug).sort(), [`${K}-new`], "only the live org skill qualifies (restricted B and the archived one do not)");
  // Installs rows carry the marker.
  const inst = await listInstalls(installer, access());
  assert.equal(inst.find((i) => i.skillSlug === oldSlug)?.skillDeprecation?.successor?.skillSlug, `${K}-new`);

  // ── Side effects / guards ────────────────────────────────────────────────────────────────
  const feat = await setSkillFeatured(pool, { access: platform, actorUserId: platformAdmin, namespaceSlug: `${K}-a`, skillSlug: oldSlug, featured: true });
  assert.equal(!feat.ok && feat.status, 409, "a deprecated skill can't be featured");
  await assert.rejects(
    pool.query(`update skills set deprecation_note = 'orphan' where id = $1`, [newer]),
    /skills_deprecation_shape/,
    "the migration's CHECK rejects a note on a live skill",
  );
  await assert.rejects(pool.query(`update skills set successor_skill_id = id where id = $1`, [old]), /skills_successor_not_self/);

  // ── Clear ─────────────────────────────────────────────────────────────────────────────────
  assert.equal((await clearSkillDeprecation(pool, { access: asAMember, actorUserId: aMember, namespaceSlug: `${K}-a`, skillSlug: oldSlug }) as { status: number }).status, 403);
  const cleared = await clearSkillDeprecation(pool, { access: asAAdmin, actorUserId: aAdmin, namespaceSlug: `${K}-a`, skillSlug: oldSlug });
  assert.ok(cleared.ok && cleared.cleared);
  const after1 = (await findSkill(`${K}-a`, oldSlug))!;
  assert.equal(after1.deprecatedAt, null);
  assert.equal(after1.successor, null);
  assert.equal(after1.deprecationNote, null);
  const again = await clearSkillDeprecation(pool, { access: asAAdmin, actorUserId: aAdmin, namespaceSlug: `${K}-a`, skillSlug: oldSlug });
  assert.ok(again.ok && !again.cleared, "idempotent");
  assert.ok((await pool.query(`select 1 from audit_log where target_id = $1 and action = 'skill.undeprecated'`, [old])).rowCount === 1);
  // Three batches so far: the initial deprecation, successor → null, null → successor (restored above).
  assert.equal((await notified(oldSlug)).length, n1.length * 3, "un-deprecating notifies nobody");
  assert.equal((await findSkill(`${K}-a`, oldSlug))!.featured, false, "Featured is not re-pinned");
});
