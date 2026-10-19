// Live-DB integration test for Hype (SKILLY_SPEC.md §50). Gated by SKILLY_DB_E2E=1.
// Verifies: the rolling budget (a 6-day-old hype counts, an 8-day-old one does not), one hype per
// skill per window, the self-hype refusal for an explicit maintainer AND a namespace admin, hard and
// soft eligibility (restricted, old, big, deprecated), the early-hype tiers frozen per row, the
// score ageing out exactly, concurrency (two parallel posts → one hype), the board's total order and
// per-viewer flags, the detail block, the catalog card counts, the admin settings (403 / 422 /
// audited), and GDPR erasure deleting the user's hypes.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import { DEFAULT_HYPE_SETTINGS } from "@skilly/shared/hype";
import { pool } from "./db";
import {
  getHypeBoard,
  getHypeBoardForViewer,
  getHypeSettings,
  hypeCardStats,
  hypeDetail,
  invalidateHypeBoard,
  listHypers,
  placeHype,
  updateHypeSettings,
} from "./hype";
import { searchSkills } from "./catalog";
import { eraseUser } from "./eraseUser";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("hype: budget, eligibility, tiers, ageing, concurrency, board, detail, settings, erasure", { skip: !enabled }, async () => {
  const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;

  const ns = await one(
    `insert into namespaces (slug, display_name, require_review) values ('hype-ns','Hype NS', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  );
  const mkUser = (oid: string) =>
    one(
      `insert into users (entra_object_id, email, display_name, status) values ($1, $1 || '@org', $1, 'active')
       on conflict (entra_object_id) do update set status = 'active', erased_at = null returning id`,
      [oid],
    );
  // Fixed actors (audit_log FK — never deleted, see the dbtest memory note).
  const admin = await mkUser("hype-platform-admin");
  const maint = await mkUser("hype-maint");
  const nsAdmin = await mkUser("hype-nsadmin");
  const users: string[] = [];
  for (let i = 1; i <= 8; i++) users.push(await mkUser(`hype-user-${i}`));
  const [u1, u2, u3, u4, u5, u6, u7, u8] = users as [string, string, string, string, string, string, string, string];

  const grp = await one(
    `insert into groups (entra_object_id, display_name) values ('hype-admin-grp','Hype Admins')
     on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
  );
  await q(`insert into role_mappings (group_id, namespace_id, role) values ($1,$2,'namespace_admin') on conflict do nothing`, [grp, ns]);
  await q(`insert into group_memberships (group_id, user_id) values ($1,$2) on conflict do nothing`, [grp, nsAdmin]);

  const mkSkill = async (slug: string, o: { visibility?: "org" | "namespace"; ageDays?: number; installs?: number; installable?: boolean } = {}) => {
    const id = await one(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status, created_at, install_count)
       values ($1,$2,$2,'d','claude','hosted',$3,'active', now() - ($4 || ' days')::interval, $5)
       on conflict (namespace_id, slug) do update set visibility = excluded.visibility, status = 'active', deprecated_at = null,
         deprecated_by = null, successor_skill_id = null, deprecation_note = null,
         created_at = excluded.created_at, install_count = excluded.install_count returning id`,
      [ns, slug, o.visibility ?? "org", String(o.ageDays ?? 1), o.installs ?? 0],
    );
    await q(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
       values ($1,'1.0.0',false,'active',$4,'h',$2,$3)
       on conflict (skill_id, semver) do update set status = 'active', git_published = excluded.git_published`,
      [id, admin, o.installable ?? true, `k/hype/${id}`],
    );
    return id;
  };
  const a = await mkSkill("hype-a");
  const b = await mkSkill("hype-b");
  const c = await mkSkill("hype-c");
  const d = await mkSkill("hype-d");
  const restricted = await mkSkill("hype-restricted", { visibility: "namespace" });
  const old = await mkSkill("hype-old", { ageDays: 200 });
  const big = await mkSkill("hype-big", { installs: 30 });
  const unpublished = await mkSkill("hype-unpublished", { installable: false });
  const all = [a, b, c, d, restricted, old, big, unpublished];
  await q(`insert into skill_maintainers (skill_id, user_id) values ($1,$2) on conflict do nothing`, [a, maint]);

  // Clean slate for every run.
  await q(`delete from skill_hypes where skill_id = any($1::uuid[]) or user_id = any($2::uuid[])`, [all, [...users, maint, nsAdmin]]);
  await q(`delete from skill_hype_top where skill_id = any($1::uuid[])`, [all]);

  const platform = { userId: admin, isPlatformAdmin: true };
  // Reset the settings to the defaults (a prior run may have changed them).
  const reset = await updateHypeSettings(platform, { hypeEnabled: true, hypeBudget: 3, hypeRecencyDays: 90, hypeInstallThreshold: 25, hypeTopN: 5 });
  assert.equal(reset.ok, true);
  const settings = await getHypeSettings();
  assert.deepEqual(settings, DEFAULT_HYPE_SETTINGS);

  try {
    // — First hype: 3 points, budget 3 → 2 left —
    const first = await placeHype(u1, a, settings);
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.points, 3);
      assert.equal(first.score, 3);
      assert.equal(first.hypeCount, 1);
      assert.equal(first.remaining, 2);
      assert.equal(first.nextAt, null);
    }

    // — One per skill per window —
    const again = await placeHype(u1, a, settings);
    assert.equal(again.ok, false);
    if (!again.ok && again.status === 409) {
      assert.equal(again.reason, "already_hyped");
      const days = (new Date(again.nextAt!).getTime() - Date.now()) / 86_400_000;
      assert.ok(days > 6.9 && days <= 7, `nextAt is ~7 days out (${days})`);
    }

    // — Self-hype: explicit maintainer and namespace admin —
    for (const who of [maint, nsAdmin]) {
      const r = await placeHype(who, a, settings);
      assert.equal(r.ok, false);
      if (!r.ok && r.status === 409) assert.equal(r.reason, "self_hype");
    }

    // — Eligibility: restricted, old, big, not installable —
    for (const s of [restricted, old, big, unpublished]) {
      const r = await placeHype(u2, s, settings);
      assert.equal(r.ok, false, "ineligible skill refused");
      if (!r.ok && r.status === 409) assert.equal(r.reason, "not_eligible");
    }

    // — Budget: u1 spends the remaining two, the fourth is refused with the oldest hype's expiry —
    assert.equal((await placeHype(u1, b, settings)).ok, true);
    assert.equal((await placeHype(u1, c, settings)).ok, true);
    const fourth = await placeHype(u1, d, settings);
    assert.equal(fourth.ok, false);
    if (!fourth.ok && fourth.status === 409) {
      assert.equal(fourth.reason, "budget_exhausted");
      assert.ok(fourth.nextAt);
    }

    // — Rolling window: a 6-day-old hype still counts; an 8-day-old one frees the slot —
    await q(`update skill_hypes set created_at = now() - interval '6 days' where user_id = $1 and skill_id = $2`, [u1, a]);
    const stillOut = await placeHype(u1, d, settings);
    assert.equal(stillOut.ok, false, "a 6-day-old hype still uses budget");
    await q(`update skill_hypes set created_at = now() - interval '8 days' where user_id = $1 and skill_id = $2`, [u1, a]);
    const freed = await placeHype(u1, d, settings);
    assert.equal(freed.ok, true, "an 8-day-old hype no longer counts");
    // …and u1 may hype `a` again: the aged-out row is inert history.
    await q(`update skill_hypes set created_at = now() - interval '8 days' where user_id = $1 and skill_id = $2`, [u1, b]);
    assert.equal((await placeHype(u1, a, settings)).ok, true, "re-hype after the old one aged out");

    // — Tiers: skill b gets five more 3-point hypes, then a 2-point one; points are frozen —
    // (u1's aged-out hype on b does not count toward the tier.)
    const pointsOnB: number[] = [];
    for (const u of [u2, u3, u4, u5, u6, u7]) {
      const r = await placeHype(u, b, settings);
      assert.equal(r.ok, true);
      if (r.ok) pointsOnB.push(r.points);
    }
    assert.deepEqual(pointsOnB, [3, 3, 3, 3, 3, 2]);
    const scoreB = (await q<{ s: number }>(`select sum(points)::int as s from skill_hypes where skill_id = $1 and created_at > now() - interval '7 days'`, [b])).rows[0]!.s;
    assert.equal(scoreB, 17);

    // — Concurrency: two parallel posts by the same user on the same skill → exactly one hype —
    const [p1, p2] = await Promise.all([placeHype(u8, c, settings), placeHype(u8, c, settings)]);
    assert.equal([p1, p2].filter((r) => r.ok).length, 1, "one of two parallel hypes succeeds");
    const failed = [p1, p2].find((r) => !r.ok);
    if (failed && !failed.ok && failed.status === 409) assert.equal(failed.reason, "already_hyped");

    // — Board: b (17) > c (u1 3 + u8 3 = 6) > a (3) = d (3) by earliest hype; restricted never listed —
    invalidateHypeBoard();
    const board = (await getHypeBoard()).filter((r) => all.includes(r.skillId));
    assert.deepEqual(board.map((r) => r.skillSlug), ["hype-b", "hype-c", "hype-d", "hype-a"]);
    assert.equal(board[0]!.score, 17);
    assert.equal(board[0]!.hypeCount, 6);
    assert.equal(board[0]!.hypers.length, 6);
    assert.equal(board[0]!.hypers[0]!.userId, u7, "newest hyper first");
    assert.equal(board.every((r) => r.isTop === false), true, "nobody is Hyped before the first sweep");

    // Per-viewer flags: u2 hyped b; maint maintains a; u8 has budget left.
    const asU2 = await getHypeBoardForViewer(u2);
    const rowB = asU2.rows.find((r) => r.skillId === b)!;
    assert.equal(rowB.hypedByMe, true);
    assert.equal(rowB.canHype, false);
    assert.equal(asU2.rows.find((r) => r.skillId === c)!.canHype, true);
    const asMaint = await getHypeBoardForViewer(maint);
    assert.equal(asMaint.rows.find((r) => r.skillId === a)!.canHype, false, "a maintainer can't hype their own skill");

    // — Detail block —
    const det = await hypeDetail(b, u2);
    assert.ok(det);
    assert.equal(det.hypedByMe, true);
    assert.equal(det.canHype, false);
    assert.equal(det.score, 17);
    assert.equal(det.hypeCount, 6);
    assert.equal(det.hyperTotal, 6);
    const detMaint = await hypeDetail(a, maint);
    assert.equal(detMaint?.isMaintainer, true);
    assert.equal(detMaint?.canHype, false);
    assert.equal(await hypeDetail(restricted, u2), null, "restricted ⇒ no hype block");
    assert.equal((await listHypers(b)).length, 6);

    // Soft-ineligible with in-window hypes: still listed, closed to new hypes.
    await q(`update skills set install_count = 40 where id = $1`, [c]);
    invalidateHypeBoard();
    const detC = await hypeDetail(c, u3);
    assert.equal(detC?.open, false);
    assert.equal(detC?.canHype, false);
    assert.ok((await getHypeBoard()).some((r) => r.skillId === c), "outgrown skill stays on the board");
    await q(`update skills set install_count = 0 where id = $1`, [c]);

    // Hard-ineligible: deprecating d drops it from the board at once.
    await q(`update skills set deprecated_at = now() where id = $1`, [d]);
    invalidateHypeBoard();
    assert.equal((await getHypeBoard()).some((r) => r.skillId === d), false, "deprecated skill leaves the board");
    await q(`update skills set deprecated_at = null where id = $1`, [d]);

    // — Catalog card counts (one batched query) —
    const stats = await hypeCardStats([a, b, restricted]);
    assert.equal(stats.get(b)?.count, 6);
    assert.equal(stats.has(restricted), false);
    const member: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };
    const listed = await searchSkills(member, { skillIds: [b] });
    assert.equal(listed[0]?.hype?.count, 6);

    // — Ageing: backdating b's hypes past the window removes its score entirely —
    await q(`update skill_hypes set created_at = now() - interval '7 days 1 minute' where skill_id = $1`, [b]);
    invalidateHypeBoard();
    assert.equal((await getHypeBoard()).some((r) => r.skillId === b), false, "aged-out skill leaves the board");

    // — Settings: 403 for non-admins, 422 out of range, audited change —
    const denied = await updateHypeSettings({ userId: u1, isPlatformAdmin: false }, { hypeTopN: 3 });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.status, 403);
    const bad = await updateHypeSettings(platform, { hypeTopN: 0, hypeBudget: 4 });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.status, 422);
    assert.equal((await getHypeSettings()).budget, 3, "nothing written when one field is invalid");
    const auditBefore = (await q<{ n: number }>(`select count(*)::int as n from audit_log where action = 'settings.updated' and target_id = 'hype_top_n'`)).rows[0]!.n;
    const good = await updateHypeSettings(platform, { hypeTopN: 3 });
    assert.equal(good.ok, true);
    assert.equal((await getHypeSettings()).topN, 3);
    const auditAfter = (await q<{ n: number }>(`select count(*)::int as n from audit_log where action = 'settings.updated' and target_id = 'hype_top_n'`)).rows[0]!.n;
    assert.equal(auditAfter, auditBefore + 1);

    // Feature off ⇒ empty board, null detail, no card stats.
    await updateHypeSettings(platform, { hypeEnabled: false });
    invalidateHypeBoard();
    assert.deepEqual(await getHypeBoard(), []);
    assert.equal(await hypeDetail(a, u2), null);
    assert.equal((await hypeCardStats([a])).size, 0);
    await updateHypeSettings(platform, { hypeEnabled: true, hypeTopN: 5 });

    // — Erasure deletes the user's hypes; the skill's score drops —
    const victim = await mkUser("hype-victim");
    await q(`delete from skill_hypes where user_id = $1`, [victim]);
    assert.equal((await placeHype(victim, a, settings)).ok, true);
    const er = await eraseUser(admin, victim, null);
    assert.equal(er.ok, true);
    assert.equal((await q<{ n: number }>(`select count(*)::int as n from skill_hypes where user_id = $1`, [victim])).rows[0]!.n, 0);
  } finally {
    await q(`delete from skill_hypes where skill_id = any($1::uuid[])`, [all]);
    await q(`delete from skill_hype_top where skill_id = any($1::uuid[])`, [all]);
    await updateHypeSettings(platform, { hypeEnabled: true, hypeBudget: 3, hypeRecencyDays: 90, hypeInstallThreshold: 25, hypeTopN: 5 });
    invalidateHypeBoard();
  }
});
