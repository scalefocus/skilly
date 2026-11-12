// Live-DB integration test for the agent sync API (SKILLY_SPEC.md §69.13). Gated by SKILLY_DB_E2E=1.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… node --import tsx --test src/lib/agentSync.dbtest.ts
//
// Tokens are signed with a locally generated RSA key and checked against an in-memory JWKS — no
// call to Microsoft. Covers: the skill set for a namespace member and a non-member (org-visible,
// restricted, archived, quarantined, prerelease-only, unpublished, deprecated, pointer with and
// without a mirror), the order and the wire shape; 404 while off; 401 for a session cookie without
// a bearer token and for an agent key presented as a bearer token; user_not_provisioned (no row
// created), user_disabled; the self-heal relink; 429 past 30/hour; the mint (hash only, expiry,
// audit row without the key) and the 5-key cap; the prune; the Installed page's agent rows; the
// gateway's clone recorder (one record, never counted); erasure; and the migration's constraints.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { AGENT_SYNC_RATE_PER_HOUR, hashToken, recordAgentClone } from "@skilly/shared";
import { pool } from "./db";
import { invalidateAccessCaches } from "./access";
import { createEntraTokenVerifier, entraIssuer } from "./entraToken";
import { handleAgentSync, type AgentSkill } from "./agentSync";
import { getInstallRevealSource, listMyInstalls, reactivate, removeAgentInstall, uninstall } from "./installs";
import { resolveUserAccessById } from "./access";
import { eraseUser } from "./eraseUser";
import { POST as usageReport } from "../app/api/usage/reports/route";

const enabled = process.env.SKILLY_DB_E2E === "1";

after(async () => {
  if (enabled) await pool.end();
});

const T = "agentsync";
const TENANT = "5ca1ef0c-0000-4000-8000-000000000001";
const AUD = "5ca1ef0c-0000-4000-8000-0000000000a0";
const BASE = "https://skilly.test";
const ENV = {
  SKILLY_AGENT_API_ENABLED: "true",
  ENTRA_TENANT_ID: TENANT,
  ENTRA_CLIENT_ID: AUD,
  PUBLIC_BASE_URL: BASE,
  SKILLY_AGENT_KEY_TTL_HOURS: "12",
};
// Fixed GUIDs (the `oid` claim must be one), one per role in the test.
const OID = {
  member: "a9e10000-0000-4000-8000-000000000001",
  outsider: "a9e10000-0000-4000-8000-000000000002",
  inactive: "a9e10000-0000-4000-8000-000000000003",
  unknown: "a9e10000-0000-4000-8000-000000000004",
  healed: "a9e10000-0000-4000-8000-000000000005",
  capper: "a9e10000-0000-4000-8000-000000000006",
  limited: "a9e10000-0000-4000-8000-000000000007",
  erasable: "a9e10000-0000-4000-8000-000000000008",
};

async function setup() {
  const pair = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-k1", use: "sig", alg: "RS256" };
  const verifier = createEntraTokenVerifier({ tenantId: TENANT, audience: AUD, requiredScope: "Skills.Sync", fetchJwks: async () => [jwk] });
  const token = (oid: string, extra: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ tid: TENANT, oid, scp: "Skills.Sync", ver: "2.0", ...extra })
      .setProtectedHeader({ alg: "RS256", kid: "test-k1" })
      .setIssuer(entraIssuer(TENANT)).setAudience(AUD).setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 3600)
      .sign(pair.privateKey);
  };
  const sync = (headers: Record<string, string>, env: Record<string, string> = ENV) =>
    handleAgentSync(new Request(`${BASE}/api/agent/v1/sync`, { method: "POST", headers: { "user-agent": "AION/1.0 test", ...headers } }), { env, verifier });
  const syncAs = async (oid: string, extra: Record<string, unknown> = {}) => sync({ authorization: `Bearer ${await token(oid, extra)}` });
  return { token, sync, syncAs };
}

const one = async (sql: string, params: unknown[] = []) => (await pool.query<{ id: string }>(sql, params)).rows[0]!.id;
const mkUser = (oid: string, status = "active", email = `${oid}@org.test`) =>
  one(
    `insert into users (entra_object_id, email, display_name, status) values ($1, $2, $1, $3)
     on conflict (entra_object_id) do update set status = excluded.status, email = excluded.email, erased_at = null returning id`,
    [oid, email, status],
  );
const mkNs = (slug: string) =>
  one(`insert into namespaces (slug, display_name, require_review) values ($1, $1, true) on conflict (slug) do update set display_name = excluded.display_name returning id`, [slug]);

test("agent sync API: skills, errors, key, prune, Installed rows, clone recording, erasure", { skip: !enabled }, async () => {
  const { token, sync, syncAs } = await setup();

  // ── Fixtures (fixed, upserted — versions are immutable, so re-runs reuse them) ───────────────
  const admin = await mkUser(`${T}-admin`);
  const member = await mkUser(OID.member);
  const outsider = await mkUser(OID.outsider);
  await mkUser(OID.inactive, "inactive");
  const capper = await mkUser(OID.capper);
  const nsA = await mkNs(`${T}-a`); // the member's namespace
  const nsB = await mkNs(`${T}-b`); // nobody's
  const group = await one(
    `insert into groups (entra_object_id, display_name) values ($1, $1) on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
    [`${T}-group-a`],
  );
  await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1, $2, 'namespace_member') on conflict do nothing`, [group, nsA]);
  await pool.query(`insert into group_memberships (group_id, user_id) values ($1, $2) on conflict do nothing`, [group, member]);
  invalidateAccessCaches();

  const mkSkill = (ns: string, slug: string, visibility: "org" | "namespace", opts: { status?: string; type?: "hosted" | "pointer" } = {}) =>
    one(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1, $2, $3, 'desc of ' || $2, 'generic', $5, $4, $6)
       on conflict (namespace_id, slug) do update
         set visibility = excluded.visibility, status = excluded.status, title = excluded.title,
             deprecated_at = null, deprecation_note = null, successor_skill_id = null
       returning id`,
      [ns, slug, `Title ${slug}`, visibility, opts.type ?? "hosted", opts.status ?? "active"],
    );
  const mkVersion = (skill: string, semver: string, o: { status?: string; published?: boolean; pointer?: boolean } = {}) =>
    pool.query(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256,
                                   external_ref, external_origin_url, external_commit, created_by, git_published)
       values ($1::uuid, $2::text, $3, $4::version_status,
               case when $5 then null else 'k/' || $1::uuid::text || '/' || $2::text end, case when $5 then null else 'sha' end,
               case when $5 then 'v' || $2::text end, case when $5 then 'https://example.invalid/r.git' end,
               case when $5 then repeat('a', 40) end, $6, $7)
       on conflict (skill_id, semver) do update set status = excluded.status, git_published = excluded.git_published`,
      [skill, semver, semver.includes("-"), o.status ?? "active", o.pointer ?? false, admin, o.published ?? true],
    );

  const org = await mkSkill(nsA, `${T}-org`, "org");
  for (const v of ["1.0.0", "1.2.0", "1.3.0-beta.1"]) await mkVersion(org, v);
  const restricted = await mkSkill(nsA, `${T}-restricted`, "namespace");
  await mkVersion(restricted, "2.0.0");
  const closed = await mkSkill(nsB, `${T}-closed`, "namespace");
  await mkVersion(closed, "1.0.0");
  const archived = await mkSkill(nsA, `${T}-archived`, "org", { status: "archived" });
  await mkVersion(archived, "1.0.0");
  const quarantined = await mkSkill(nsA, `${T}-quarantined`, "org");
  await mkVersion(quarantined, "1.0.0", { status: "quarantined", published: false });
  const betaOnly = await mkSkill(nsA, `${T}-beta-only`, "org");
  await mkVersion(betaOnly, "0.1.0-beta.1");
  const unpublished = await mkSkill(nsA, `${T}-unpublished`, "org");
  await mkVersion(unpublished, "1.0.0", { published: false });
  const yanked = await mkSkill(nsA, `${T}-yanked`, "org");
  await mkVersion(yanked, "1.0.0", { status: "yanked" });
  const deprecated = await mkSkill(nsA, `${T}-deprecated`, "org");
  await mkVersion(deprecated, "3.1.0");
  await pool.query(`update skills set deprecated_at = now(), deprecation_note = 'use the org one', successor_skill_id = $2 where id = $1`, [deprecated, org]);
  const pointerMirrored = await mkSkill(nsA, `${T}-pointer-mirrored`, "org", { type: "pointer" });
  await mkVersion(pointerMirrored, "1.0.0", { pointer: true });
  const pointerUnmirrored = await mkSkill(nsA, `${T}-pointer-unmirrored`, "org", { type: "pointer" });
  await mkVersion(pointerUnmirrored, "1.0.0", { pointer: true, published: false });

  const mine = (skills: AgentSkill[]) => skills.filter((s) => s.slug.startsWith(`${T}-`));

  // ── Off → 404; misconfigured → 404 ────────────────────────────────────────────────────────────
  for (const env of [{ ...ENV, SKILLY_AGENT_API_ENABLED: "" }, { ...ENV, ENTRA_TENANT_ID: "common" }]) {
    const r = await sync({ authorization: `Bearer ${await token(OID.member)}` }, env);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, "not_found");
  }

  // ── A namespace member: the full, ordered, servable set ───────────────────────────────────────
  await pool.query(`delete from agent_installs where user_id = any($1::uuid[])`, [[member, outsider]]);
  // Records the next sync must prune: an archived skill and one the member cannot see.
  await pool.query(
    `insert into agent_installs (user_id, skill_id, source) values ($1, $2, 'aion'), ($1, $3, 'aion'), ($1, $4, 'aion')`,
    [member, org, archived, closed],
  );
  const r1 = await syncAs(OID.member, { preferred_username: `${OID.member}@org.test` });
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get("cache-control"), "no-store");
  assert.match(r1.headers.get("content-type") ?? "", /application\/json/);
  const b1 = (await r1.json()) as { user: { id: string; email: string }; key: string; keyExpiresAt: string; gitBaseUrl: string; skills: AgentSkill[] };
  assert.deepEqual(b1.user, { id: member, email: `${OID.member}@org.test` });
  assert.equal(b1.gitBaseUrl, BASE);
  const s1 = mine(b1.skills);
  assert.deepEqual(
    s1.map((s) => `${s.namespace}/${s.slug}`),
    [`${T}-a/${T}-deprecated`, `${T}-a/${T}-org`, `${T}-a/${T}-pointer-mirrored`, `${T}-a/${T}-restricted`],
    "member: org + own restricted + deprecated + mirrored pointer; never archived/quarantined/beta-only/unpublished/yanked/unmirrored/other-namespace",
  );
  const orgRow = s1.find((s) => s.slug === `${T}-org`)!;
  assert.equal(orgRow.version, "1.2.0", "latest STABLE, the beta never wins");
  assert.equal(orgRow.ref, "v1.2.0");
  assert.equal(orgRow.gitUrl, `${BASE}/${T}-a/${T}-org.git`);
  assert.equal(orgRow.title, `Title ${T}-org`);
  assert.equal(orgRow.description, `desc of ${T}-org`);
  assert.equal(orgRow.deprecation, null);
  assert.ok(!Number.isNaN(Date.parse(orgRow.updatedAt)) && orgRow.updatedAt.endsWith("Z"));
  assert.deepEqual(s1.find((s) => s.slug === `${T}-deprecated`)!.deprecation, {
    note: "use the org one",
    successor: { namespaceSlug: `${T}-a`, skillSlug: `${T}-org`, title: `Title ${T}-org` },
  });
  for (const s of b1.skills) assert.ok(!s.gitUrl.includes("@") && !s.gitUrl.includes(b1.key), "no credentials in any gitUrl");
  // The whole response is sorted (namespace, then slug), not only this test's rows.
  const keys = b1.skills.map((s) => [s.namespace, s.slug] as const);
  assert.deepEqual(keys, [...keys].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));

  // The prune: only the still-listed skill's record survives.
  const left = await pool.query<{ skill_id: string }>(`select skill_id from agent_installs where user_id = $1`, [member]);
  assert.deepEqual(left.rows.map((r) => r.skill_id), [org]);

  // The key: hash only, ~12 h, user-owned, no recoverable copy; one audit row that never holds it.
  const keyRow = (await pool.query<{ id: string; type: string; user_id: string; skill_id: string | null; token_enc: string | null; is_system: boolean; hours: number; client_user_agent: string }>(
    `select id, type, user_id, skill_id, token_enc, is_system, extract(epoch from (expires_at - now())) / 3600 as hours, client_user_agent
       from tokens where hashed_token = $1`,
    [hashToken(b1.key)],
  )).rows[0]!;
  assert.equal(keyRow.type, "agent");
  assert.equal(keyRow.user_id, member);
  assert.equal(keyRow.skill_id, null);
  assert.equal(keyRow.token_enc, null);
  assert.equal(keyRow.is_system, false);
  assert.ok(keyRow.hours > 11.9 && keyRow.hours <= 12, `expires in ~12 h (${keyRow.hours})`);
  assert.equal(keyRow.client_user_agent, "AION/1.0 test");
  assert.ok(Math.abs(Date.parse(b1.keyExpiresAt) - (Date.now() + 12 * 3_600_000)) < 120_000);
  const audit = (await pool.query<{ actor_user_id: string; source: string; target_type: string; after: Record<string, unknown>; raw: string }>(
    `select actor_user_id, source::text, target_type, after, after::text as raw from audit_log where action = 'agent_key.minted' and target_id = $1`,
    [keyRow.id],
  )).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.actor_user_id, member);
  assert.equal(audit[0]!.source, "api");
  assert.equal(audit[0]!.target_type, "agent_key");
  assert.deepEqual(Object.keys(audit[0]!.after).sort(), ["clientIp", "expiresAt", "revokedKeys", "userAgent"]);
  assert.ok(!audit[0]!.raw.includes(b1.key), "the audit row never carries the key");

  // ── A non-member: org-visible only ────────────────────────────────────────────────────────────
  const r2 = await syncAs(OID.outsider);
  assert.equal(r2.status, 200);
  const s2 = mine(((await r2.json()) as { skills: AgentSkill[] }).skills);
  assert.deepEqual(s2.map((s) => s.slug), [`${T}-deprecated`, `${T}-org`, `${T}-pointer-mirrored`]);

  // ── The agent key is not an API credential ────────────────────────────────────────────────────
  const asBearer = await sync({ authorization: `Bearer ${b1.key}` });
  assert.equal(asBearer.status, 401);
  const usage = await usageReport(new Request(`${BASE}/api/usage/reports`, {
    method: "POST",
    headers: { authorization: `Bearer ${b1.key}`, "content-type": "application/json" },
    body: JSON.stringify({ skillId: org, semver: "1.2.0", trigger: "user", eventId: "e1" }),
  }));
  assert.equal(usage.status, 401);

  // ── Token / identity failures ─────────────────────────────────────────────────────────────────
  const cookieOnly = await sync({ cookie: "next-auth.session-token=anything; __Secure-next-auth.session-token=anything" });
  assert.equal(cookieOnly.status, 401);
  assert.equal(cookieOnly.headers.get("www-authenticate"), 'Bearer error="invalid_token"');
  assert.deepEqual(Object.keys(await cookieOnly.json()).sort(), ["error", "message"]);

  const noScope = await syncAs(OID.member, { scp: "User.Read" });
  assert.equal(noScope.status, 403);
  assert.equal((await noScope.json()).error, "insufficient_scope");

  const usersBefore = Number((await pool.query<{ n: string }>(`select count(*) as n from users`)).rows[0]!.n);
  const unknown = await syncAs(OID.unknown, { email: "nobody@org.test", name: "Nobody" });
  assert.equal(unknown.status, 403);
  assert.equal((await unknown.json()).error, "user_not_provisioned");
  assert.equal(Number((await pool.query<{ n: string }>(`select count(*) as n from users`)).rows[0]!.n), usersBefore, "no user is ever created");

  const disabled = await syncAs(OID.inactive);
  assert.equal(disabled.status, 403);
  assert.equal((await disabled.json()).error, "user_disabled");

  // ── The self-heal relink (§5) runs here exactly as at web sign-in ─────────────────────────────
  const healEmail = `${T}-heal@org.test`;
  await pool.query(`update users set entra_object_id = $2 where entra_object_id = $1`, [OID.healed, `${T}-miskeyed`]);
  const healId = await mkUser(`${T}-miskeyed`, "active", healEmail);
  const healed = await syncAs(OID.healed, { preferred_username: healEmail.toUpperCase() });
  assert.equal(healed.status, 200);
  assert.equal(((await healed.json()) as { user: { id: string } }).user.id, healId);
  assert.equal((await pool.query<{ e: string }>(`select entra_object_id as e from users where id = $1`, [healId])).rows[0]!.e, OID.healed);

  // ── The 5-key cap ─────────────────────────────────────────────────────────────────────────────
  const capKeys: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await syncAs(OID.capper);
    assert.equal(r.status, 200);
    capKeys.push(((await r.json()) as { key: string }).key);
  }
  const live = await pool.query<{ hashed_token: string }>(
    `select hashed_token from tokens where type = 'agent' and user_id = $1 and expires_at > now()`,
    [capper],
  );
  assert.equal(live.rows.length, 5, "at most 5 unexpired keys");
  const liveHashes = new Set(live.rows.map((r) => r.hashed_token));
  assert.ok(!liveHashes.has(hashToken(capKeys[0]!)), "the 6th key revoked the oldest");
  for (const k of capKeys.slice(1)) assert.ok(liveHashes.has(hashToken(k)));
  const lastAudit = (await pool.query<{ revoked: number }>(
    `select (after->>'revokedKeys')::int as revoked from audit_log a join tokens t on t.id::text = a.target_id
      where a.action = 'agent_key.minted' and t.hashed_token = $1`,
    [hashToken(capKeys[5]!)],
  )).rows[0]!;
  assert.ok(lastAudit.revoked >= 1);

  // ── 30 per user per hour, then 429 with Retry-After (counted before the user lookup) ──────────
  for (let i = 0; i < AGENT_SYNC_RATE_PER_HOUR; i++) assert.equal((await syncAs(OID.limited)).status, 403);
  const limited = await syncAs(OID.limited);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);

  // ── The Installed page's agent rows ───────────────────────────────────────────────────────────
  await pool.query(`delete from agent_installs where user_id = $1`, [outsider]);
  const visibleRow = await one(
    `insert into agent_installs (user_id, skill_id, source, last_served_semver, client_user_agent, client_ip)
     values ($1, $2, 'aion', '1.0.0', 'git/2.45.0', '10.1.2.3') returning id`,
    [outsider, org],
  );
  await pool.query(`insert into agent_installs (user_id, skill_id, source) values ($1, $2, 'aion')`, [outsider, restricted]);
  const outsiderAccess = await resolveUserAccessById(outsider);
  const rows = (await listMyInstalls(outsider, outsiderAccess)).filter((i) => i.skillSlug.startsWith(`${T}-`));
  assert.equal(rows.length, 1, "a record of a skill the user can no longer see is hidden at read time");
  assert.deepEqual(
    { ...rows[0], installedAt: undefined, lastClonedAt: undefined, icon: undefined },
    {
      id: visibleRow, source: "aion", namespaceSlug: `${T}-a`, skillSlug: `${T}-org`, title: `Title ${T}-org`,
      pinnedSemver: null, installedAt: undefined, expiresAt: null, inactive: false,
      clientUserAgent: "git/2.45.0", clientIp: "10.1.2.3", skillArchived: false, skillDeprecation: null, icon: undefined,
      lastServedSemver: "1.0.0", lastClonedAt: undefined, latestSemver: "1.2.0", freshness: "behind", revealable: false,
    },
  );
  // Not a token: no reactivate, no reveal, no token uninstall — only Remove, owner-only.
  assert.equal(await reactivate(outsider, visibleRow, null), false);
  assert.equal(await getInstallRevealSource(visibleRow), null);
  assert.equal(await uninstall(outsider, visibleRow), false);
  assert.equal(await removeAgentInstall(member, visibleRow), false, "someone else's record");
  assert.equal(await removeAgentInstall(outsider, visibleRow), true);
  assert.equal((await pool.query(`select 1 from agent_installs where id = $1`, [visibleRow])).rowCount, 0);

  // ── The gateway's clone recorder: one record per (user, skill, source), never counted ─────────
  await pool.query(`delete from agent_installs where user_id = $1 and skill_id = $2`, [outsider, org]);
  const counts = async () => (await pool.query<{ ic: string; si: string; cr: string; ctr: string; al: string }>(
    `select (select install_count from skills where id = $1)::text as ic,
            (select count(*) from skill_installs where skill_id = $1 and user_id = $2)::text as si,
            (select count(*) from install_credits c join access_log l on l.id = c.access_log_id where l.skill_id = $1)::text as cr,
            (select coalesce(sum(total), 0) from install_counters)::text as ctr,
            (select count(*) from access_log where skill_id = $1 and actor_user_id = $2 and source = 'aion')::text as al`,
    [org, outsider],
  )).rows[0]!;
  const before = await counts();
  await recordAgentClone(pool, { userId: outsider, skillId: org, userAgent: "git/2.45.0", clientIp: "10.9.9.9" });
  const first = (await pool.query<{ first_cloned_at: Date; client_ip: string }>(`select first_cloned_at, client_ip from agent_installs where user_id = $1 and skill_id = $2`, [outsider, org])).rows[0]!;
  await recordAgentClone(pool, { userId: outsider, skillId: org, userAgent: "git/2.46.0", clientIp: "10.8.8.8" });
  const recs = (await pool.query<{ source: string; first_cloned_at: Date; last_cloned_at: Date; last_served_semver: string; client_ip: string; client_user_agent: string }>(
    `select source, first_cloned_at, last_cloned_at, last_served_semver, client_ip, client_user_agent from agent_installs where user_id = $1 and skill_id = $2`,
    [outsider, org],
  )).rows;
  assert.equal(recs.length, 1, "one record across repeated clones");
  assert.equal(recs[0]!.source, "aion");
  assert.equal(recs[0]!.last_served_semver, "1.2.0");
  assert.equal(recs[0]!.first_cloned_at.getTime(), first.first_cloned_at.getTime(), "first-clone fields stay");
  assert.equal(recs[0]!.client_ip, "10.9.9.9");
  assert.equal(recs[0]!.client_user_agent, "git/2.45.0");
  assert.ok(recs[0]!.last_cloned_at.getTime() >= first.first_cloned_at.getTime());
  const afterCounts = await counts();
  assert.equal(Number(afterCounts.al), Number(before.al) + 2, "one access_log row per clone, source 'aion'");
  assert.deepEqual({ ...afterCounts, al: "" }, { ...before, al: "" }, "no install_count, skill_installs, credits or counters move");

  // ── Erasure removes agent keys and records ────────────────────────────────────────────────────
  const erasable = await mkUser(OID.erasable);
  const er = await syncAs(OID.erasable);
  assert.equal(er.status, 200);
  await pool.query(`insert into agent_installs (user_id, skill_id, source) values ($1, $2, 'aion') on conflict do nothing`, [erasable, org]);
  const erased = await eraseUser(admin, erasable, null);
  assert.equal(erased.ok, true);
  assert.equal((await pool.query(`select 1 from tokens where user_id = $1`, [erasable])).rowCount, 0);
  assert.equal((await pool.query(`select 1 from agent_installs where user_id = $1`, [erasable])).rowCount, 0);
  const afterErase = await syncAs(OID.erasable);
  assert.equal(afterErase.status, 403);
  assert.equal((await afterErase.json()).error, "user_not_provisioned");
});

test("migration 0110: the agent token CHECK and the agent_installs constraints", { skip: !enabled }, async () => {
  const user = await mkUser(`${T}-mig`);
  const ns = await mkNs(`${T}-a`);
  const skill = await one(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1, $2, $2, 'd', 'generic', 'hosted', 'org', 'active')
     on conflict (namespace_id, slug) do update set status = 'active' returning id`,
    [ns, `${T}-mig-skill`],
  );
  const refused = async (sql: string, params: unknown[], constraint: string) => {
    await assert.rejects(pool.query(sql, params), (e: { constraint?: string; message: string }) => {
      assert.equal(e.constraint, constraint, e.message);
      return true;
    });
  };
  const agent = (cols: string, vals: string, params: unknown[]) =>
    refused(`insert into tokens (type, hashed_token, ${cols}) values ('agent', 'h-' || gen_random_uuid(), ${vals})`, params, "tokens_scope_discriminant");
  await agent("user_id", "$1", [user]); // no expiry
  await agent("user_id, expires_at, skill_id", "$1, now() + interval '1 hour', $2", [user, skill]); // skill-scoped
  await agent("expires_at", "now() + interval '1 hour'", []); // no owner
  await agent("user_id, expires_at, is_system", "$1, now() + interval '1 hour', true", [user]); // system
  // The well-formed row is accepted.
  const ok = await one(`insert into tokens (type, hashed_token, user_id, expires_at) values ('agent', 'h-' || gen_random_uuid(), $1, now() + interval '1 hour') returning id`, [user]);
  await pool.query(`delete from tokens where id = $1`, [ok]);
  // Install and marketplace rows are unaffected by the replaced CHECK.
  await refused(`insert into tokens (type, hashed_token, user_id) values ('install', 'h-x', $1)`, [user], "tokens_scope_discriminant");

  await pool.query(`delete from agent_installs where user_id = $1`, [user]);
  await refused(`insert into agent_installs (user_id, skill_id, source) values ($1, $2, 'cursor')`, [user, skill], "agent_installs_source");
  await pool.query(`insert into agent_installs (user_id, skill_id, source) values ($1, $2, 'aion')`, [user, skill]);
  await refused(`insert into agent_installs (user_id, skill_id, source) values ($1, $2, 'aion')`, [user, skill], "agent_installs_one_per_user_skill_source");
  await pool.query(`delete from agent_installs where user_id = $1`, [user]);
});
