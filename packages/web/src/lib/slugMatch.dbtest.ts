// Live-DB integration test for the §8 slug match: a NEW-skill submission whose slug a visible
// active skill already uses — in any namespace — must become a new version of it. Gated by
// SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: findSlugMatches (cross-namespace, case-insensitive, active-only with deprecated included,
// invariant #3 incl. §42 grants), the submit gate's 409 shapes (visible matches vs a hidden
// same-namespace skill), resolveUserAccessById, the accept-time re-check at the PROPOSER's
// visibility (and its promotion exemption), and the review-page alert at the VIEWER's visibility.
// Data is committed under a per-run key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { SLUG_EXISTS_CODE, type EffectiveAccess, type Role } from "@skilly/shared";
import { pool } from "./db";
import { createProposal, getProposalDetail, materializeVersion, performProposalAction, type ProposalMetadata } from "./proposals";
import { inTransaction } from "./grants";
import { findSlugMatches, newSkillSlugClash } from "./duplicate";
import { resolveUserAccessById } from "./access";

const enabled = process.env.SKILLY_DB_E2E === "1";
const K = `slm${Date.now().toString(36)}`;

after(async () => {
  if (enabled) await pool.end();
});

const access = (roles: [string, Role][] = []): EffectiveAccess => ({ isPlatformAdmin: false, namespaceRoles: new Map(roles) });

async function mkNs(slug: string): Promise<string> {
  return (await pool.query<{ id: string }>(`insert into namespaces (slug, display_name, require_review) values ($1, $1, true) returning id`, [slug])).rows[0]!.id;
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
function meta(slug: string, visibility: "org" | "namespace", sharedNamespaceIds: string[] = []): ProposalMetadata {
  return { skillSlug: slug, title: `${slug} title`, description: "slug-match fixture", toolHarness: "generic", visibility, categories: [], usageExamples: null, sharedNamespaceIds };
}
async function mkSkill(ns: string, owner: string, m: ProposalMetadata): Promise<string> {
  return inTransaction(async (client) => {
    const r = await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: null, semver: "1.0.0", submittedBy: owner, actorUserId: owner, via: "proposal_accept",
      payload: { metadata: m, artifactObjectKey: `uploads/${owner}/${m.skillSlug}.bundle`, artifactSha256: `a-${m.skillSlug}`, contentSha256: `c-${m.skillSlug}` },
    });
    return r.skillId;
  });
}
async function mkOpenProposal(ns: string, submitter: string, m: ProposalMetadata, extra: { promotedFromSkillVersionId?: string } = {}): Promise<string> {
  const { id } = await createProposal(pool, {
    submittedByUserId: submitter, targetNamespaceId: ns, targetSkillId: null, proposedSemver: "1.0.0",
    payload: { metadata: m, artifactObjectKey: `uploads/${submitter}/${m.skillSlug}-p.bundle`, artifactSha256: `pa-${m.skillSlug}`, contentSha256: `pc-${m.skillSlug}-${Math.random()}`, ...extra },
  });
  await pool.query(`update proposals set state = 'under_review' where id = $1`, [id]);
  return id;
}
async function acceptAs(proposalId: string, actor: string, a: EffectiveAccess) {
  const rev = (await pool.query<{ max: number }>(`select max(revision_no)::int as max from proposal_revisions where proposal_id = $1`, [proposalId])).rows[0]!.max;
  return performProposalAction(pool, { proposalId, action: "accept", actorUserId: actor, access: a, expectedRevisionNo: rev });
}

test("§8 slug match: lookup, submit gate, accept re-check, review alert", { skip: !enabled }, async () => {
  const A = await mkNs(`${K}-a`);
  const B = await mkNs(`${K}-b`);
  const C = await mkNs(`${K}-c`);
  const aAdmin = await mkUserIn(`${K}-aadm`, A, "namespace_admin");
  const bAdmin = await mkUserIn(`${K}-badm`, B, "namespace_admin");
  const cMember = await mkUserIn(`${K}-cmem`, C, "namespace_member");
  const outsider = await mkUserIn(`${K}-out`, null, null);
  const asA = access([[A, "namespace_admin"]]);
  const asB = access([[B, "namespace_admin"]]);
  const asC = access([[C, "namespace_member"]]);
  const asNobody = access();

  // ── 1. findSlugMatches ────────────────────────────────────────────────────────────────────
  const orgSlug = `${K}-org-tool`;
  await mkSkill(A, aAdmin, meta(orgSlug, "org"));
  const hits = await findSlugMatches(asNobody, orgSlug.toUpperCase());
  assert.deepEqual(hits.map((m) => `${m.namespaceSlug}/${m.slug}`), [`${K}-a/${orgSlug}`], "an org skill matches cross-namespace, case-insensitively");
  assert.equal(hits[0]!.type, "hosted");
  assert.equal(hits[0]!.deprecated, false);

  const restrictedSlug = `${K}-secret`;
  const restricted = await mkSkill(A, aAdmin, meta(restrictedSlug, "namespace", [B]));
  assert.equal((await findSlugMatches(asC, restrictedSlug)).length, 0, "a restricted skill never matches for an outsider (invariant #3)");
  assert.equal((await findSlugMatches(asB, restrictedSlug)).length, 1, "a §42 grantee namespace sees it");
  assert.equal((await findSlugMatches(asA, restrictedSlug)).length, 1, "the owning namespace sees it");

  await pool.query(`update skills set deprecated_at = now() where id = $1`, [restricted]);
  const dep = await findSlugMatches(asA, restrictedSlug);
  assert.equal(dep.length, 1, "a deprecated skill still matches (it accepts new versions, §45)");
  assert.equal(dep[0]!.deprecated, true);

  const archivedSlug = `${K}-old`;
  const archived = await mkSkill(A, aAdmin, meta(archivedSlug, "org"));
  await pool.query(`update skills set status = 'archived' where id = $1`, [archived]);
  assert.equal((await findSlugMatches(asNobody, archivedSlug)).length, 0, "an archived skill never matches");

  // Several namespaces: both returned, oldest first.
  await mkSkill(B, bAdmin, meta(orgSlug, "org"));
  assert.deepEqual((await findSlugMatches(asNobody, orgSlug)).map((m) => m.namespaceSlug), [`${K}-a`, `${K}-b`]);

  // ── 2. The submit gate ────────────────────────────────────────────────────────────────────
  const visible = await newSkillSlugClash(asC, C, orgSlug);
  assert.ok(visible);
  assert.equal(visible!.status, 409);
  const vb = await visible!.json();
  assert.equal(vb.code, SLUG_EXISTS_CODE);
  assert.equal(vb.matches.length, 2);
  assert.equal(vb.matches[0].skillId, undefined, "the API never exposes the internal skill id");

  const hiddenSameNs = await newSkillSlugClash(asC, A, restrictedSlug);
  assert.equal(hiddenSameNs?.status, 409, "a hidden skill in the TARGET namespace still 409s (unique key)");
  const hb = await hiddenSameNs!.json();
  assert.equal(hb.code, undefined, "…but without revealing it as a match");
  assert.equal(hb.matches, undefined);

  assert.equal(await newSkillSlugClash(asC, C, restrictedSlug), null, "a hidden skill elsewhere never blocks");
  assert.equal(await newSkillSlugClash(asC, C, `${K}-fresh`), null);

  // ── 3. resolveUserAccessById ──────────────────────────────────────────────────────────────
  const cAccess = await resolveUserAccessById(cMember);
  assert.equal(cAccess.userId, cMember);
  assert.equal(cAccess.namespaceRoles.get(C), "namespace_member", "roles resolve from SCIM membership + role_mappings");
  assert.equal((await resolveUserAccessById(outsider)).namespaceRoles.size, 0);

  // ── 4. Accept re-check at the PROPOSER's visibility ───────────────────────────────────────
  const raceSlug = `${K}-race`;
  const pRace = await mkOpenProposal(C, cMember, meta(raceSlug, "namespace"));
  await mkSkill(A, aAdmin, meta(raceSlug, "org")); // a same-slug skill lands after submit
  const raced = await acceptAs(pRace, aAdmin, { isPlatformAdmin: true, namespaceRoles: new Map() });
  assert.equal(raced.ok, false);
  assert.equal(!raced.ok && raced.status, 409);
  assert.equal(!raced.ok && raced.code, SLUG_EXISTS_CODE);
  assert.deepEqual(!raced.ok && raced.matches?.map((m) => m.namespaceSlug), [`${K}-a`]);
  assert.equal((await pool.query<{ state: string }>(`select state from proposals where id = $1`, [pRace])).rows[0]!.state, "under_review", "nothing changed");

  // The 409 names only what the REVIEWER can see too (invariant #3): a skill visible to the proposer
  // (restricted to C) but not to A's admin blocks the accept without being named.
  const cOnlySlug = `${K}-c-only`;
  const cMemberInC = await mkUserIn(`${K}-cown`, C, "namespace_admin");
  await mkSkill(C, cMemberInC, meta(cOnlySlug, "namespace"));
  const pCOnly = await mkOpenProposal(A, cMember, meta(cOnlySlug, "namespace"));
  const blind = await acceptAs(pCOnly, aAdmin, asA);
  assert.equal(!blind.ok && blind.code, SLUG_EXISTS_CODE, "still blocked — the proposer can see it");
  assert.deepEqual(!blind.ok && blind.matches, [], "…but nothing the reviewer can't see is named");
  assert.doesNotMatch(!blind.ok ? blind.error : "", new RegExp(`${K}-c/`));

  // Hidden from the proposer → never a slug_exists 409 (the reviewer was alerted instead).
  const hiddenSlug = `${K}-hidden`;
  await mkSkill(A, aAdmin, meta(hiddenSlug, "namespace"));
  const pHidden = await mkOpenProposal(C, cMember, meta(hiddenSlug, "namespace"));
  const hiddenAccept = await acceptAs(pHidden, aAdmin, { isPlatformAdmin: true, namespaceRoles: new Map() });
  assert.ok(hiddenAccept.ok || hiddenAccept.code !== SLUG_EXISTS_CODE, "a skill hidden from the proposer never blocks accept");

  // Promotion is exempt: same slug as its source by design.
  const promoSlug = `${K}-promo`;
  const promoSource = await mkSkill(A, aAdmin, meta(promoSlug, "org"));
  const promoVersion = (await pool.query<{ id: string }>(`select id from skill_versions where skill_id = $1`, [promoSource])).rows[0]!.id;
  const pPromo = await mkOpenProposal(C, cMember, meta(promoSlug, "org"), { promotedFromSkillVersionId: promoVersion });
  const promo = await acceptAs(pPromo, aAdmin, { isPlatformAdmin: true, namespaceRoles: new Map() });
  assert.ok(promo.ok || promo.code !== SLUG_EXISTS_CODE, "a promotion is never refused by the slug match");

  // ── 5. Review-page alert at the VIEWER's visibility ───────────────────────────────────────
  const alertSlug = `${K}-alert`;
  await mkSkill(A, aAdmin, meta(alertSlug, "namespace"));
  const pAlert = await mkOpenProposal(C, cMember, meta(alertSlug, "namespace"));
  // A platform admin reviews anything and sees everything; the submitter (a C member) sees neither.
  const platform: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };
  const asReviewer = await getProposalDetail(pool, pAlert, platform, aAdmin);
  assert.deepEqual(asReviewer?.slugMatches.map((m) => `${m.namespaceSlug}/${m.slug}`), [`${K}-a/${alertSlug}`], "a viewer who can see the skill is alerted");
  const asSubmitter = await getProposalDetail(pool, pAlert, asC, cMember);
  assert.deepEqual(asSubmitter?.slugMatches, [], "the submitter still can't see it");
  await pool.query(`update proposals set state = 'rejected' where id = $1`, [pAlert]);
  assert.deepEqual((await getProposalDetail(pool, pAlert, platform, aAdmin))?.slugMatches, [], "closed proposals carry no alert");
});
