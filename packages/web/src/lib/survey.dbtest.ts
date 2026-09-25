// Live-DB integration test for the feedback survey (SKILLY_SPEC.md §36). Gated behind SKILLY_DB_E2E=1.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: first use vs repeat; ineligible and canShow=false first uses consumed without a roll; a
// won roll opening exactly one offer under concurrency; the visit fallback at 89 vs 90 days and its
// used-feature pick; close bumping the funnel once; submit storing a response with NO user
// reference, clearing the offer, 409 after expiry / opt-out / switch-off and 422 on bad keys; the
// admin summary and comments (filters + the size-5 withholding) on an isolated dataset; the delete
// cascade with a text-free audit row; and the GDPR erasure sweep clearing per-user state while
// leaving responses untouched.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { pool } from "./db";
import {
  checkVisitSurvey,
  closeSurvey,
  deleteSurveyResponse,
  getOpenSurvey,
  getSurveyComments,
  getSurveySummary,
  recordFeatureUse,
  setUserSurveysEnabled,
  submitSurvey,
} from "./survey";
import { eraseUser } from "./eraseUser";

const enabled = process.env.SKILLY_DB_E2E === "1";
const P = "srv";
const WIN = { rng: () => 0 };
const LOSE = { rng: () => 0.99 };

/** Upsert a fresh, eligible user: onboarded 60 days ago, never surveyed, opted in, no history. */
async function mkUser(tag: string): Promise<string> {
  const oid = `${P}-${tag}`;
  const id = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ($1,$2,$3,'active')
     on conflict (entra_object_id) do update set email = excluded.email, status = 'active', erased_at = null
     returning id`,
    [oid, `${oid}@org`, oid],
  )).rows[0]!.id;
  await pool.query(
    `update users set onboarded_at = now() - interval '60 days', surveys_enabled = true, survey_last_shown_at = null, survey_offer = null where id = $1`,
    [id],
  );
  await pool.query(`delete from user_feature_uses where user_id = $1`, [id]);
  return id;
}

// The funnel counters are global: snapshot them and put them back, so a run leaves the admin view of
// a shared dev database as it found it.
let dailySnapshot: Record<string, unknown>[] = [];
before(async () => {
  if (enabled) dailySnapshot = (await pool.query(`select * from survey_daily`)).rows;
});
after(async () => {
  if (!enabled) return;
  await pool.query(`delete from survey_daily`);
  for (const r of dailySnapshot) {
    await pool.query(
      `insert into survey_daily (day, shown, closed, submitted, submitted_from_menu) values ($1, $2, $3, $4, $5)`,
      [r.day, r.shown, r.closed, r.submitted, r.submitted_from_menu],
    );
  }
});

const respondent = (userId: string) => ({ userId, isPlatformAdmin: false, namespaceRoles: new Map<string, string>() });

async function userRow(id: string) {
  return (await pool.query<{ survey_offer: Record<string, unknown> | null; survey_last_shown_at: Date | null; surveys_enabled: boolean }>(
    `select survey_offer, survey_last_shown_at, surveys_enabled from users where id = $1`,
    [id],
  )).rows[0]!;
}

async function withSurveySwitch<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const prev = (await pool.query<{ value: unknown }>(`select value from platform_settings where key = 'survey_enabled'`)).rows[0]?.value;
  await pool.query(
    `insert into platform_settings (key, value) values ('survey_enabled', $1::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(on)],
  );
  try {
    return await fn();
  } finally {
    if (prev === undefined) await pool.query(`delete from platform_settings where key = 'survey_enabled'`);
    else await pool.query(`update platform_settings set value = $1::jsonb where key = 'survey_enabled'`, [JSON.stringify(prev)]);
  }
}

test("first use: recorded once; ineligible and canShow=false uses are consumed without a roll", { skip: !enabled }, async () => {
  await withSurveySwitch(true, async () => {
    const u = await mkUser("first");
    // canShow = false → recorded, never rolled (even with a forced win).
    assert.deepEqual(await recordFeatureUse(u, "search", false, WIN), { firstUse: true, survey: null });
    assert.deepEqual(await recordFeatureUse(u, "search", true, WIN), { firstUse: false, survey: null }); // repeat
    assert.equal((await userRow(u)).survey_last_shown_at, null);

    // A lost roll consumes the trigger too.
    assert.deepEqual(await recordFeatureUse(u, "leaderboard", true, LOSE), { firstUse: true, survey: null });

    // Ineligible (inside the 14-day grace) → consumed.
    await pool.query(`update users set onboarded_at = now() - interval '3 days' where id = $1`, [u]);
    assert.deepEqual(await recordFeatureUse(u, "rating", true, WIN), { firstUse: true, survey: null });
    // Opted out → consumed.
    await pool.query(`update users set onboarded_at = now() - interval '60 days', surveys_enabled = false where id = $1`, [u]);
    assert.deepEqual(await recordFeatureUse(u, "follow", true, WIN), { firstUse: true, survey: null });
    assert.equal((await userRow(u)).survey_offer, null);
  });
});

test("a won roll opens one offer; the 30-day floor blocks a second; the switch gates it", { skip: !enabled }, async () => {
  const u = await mkUser("win");
  await withSurveySwitch(false, async () => {
    assert.equal((await recordFeatureUse(u, "install", true, WIN)).survey, null); // platform off
  });
  await withSurveySwitch(true, async () => {
    const shownBefore = (await pool.query<{ n: number }>(`select coalesce(sum(shown),0)::int as n from survey_daily`)).rows[0]!.n;
    // Two concurrent winning first uses: the guarded UPDATE lets exactly one through.
    const [a, b] = await Promise.all([recordFeatureUse(u, "propose", true, WIN), recordFeatureUse(u, "request", true, WIN)]);
    const offers = [a.survey, b.survey].filter(Boolean);
    assert.equal(offers.length, 1);
    const offer = offers[0]!;
    assert.ok(offer.feature && ["propose", "request"].includes(offer.feature.key));
    assert.equal(offer.questions.length, 7);
    const shownAfter = (await pool.query<{ n: number }>(`select coalesce(sum(shown),0)::int as n from survey_daily`)).rows[0]!.n;
    assert.equal(shownAfter - shownBefore, 1);
    // The floor: another first use right away can't open a new offer.
    assert.equal((await recordFeatureUse(u, "messaging", true, WIN)).survey, null);
    // GET /api/me's openSurvey reads it back.
    assert.equal((await getOpenSurvey(u))?.shownAt, offer.shownAt);
  });
});

test("visit fallback: 89 vs 90 days, with a used feature or general-only", { skip: !enabled }, async () => {
  await withSurveySwitch(true, async () => {
    const u = await mkUser("visit");
    await pool.query(`update users set survey_last_shown_at = now() - interval '89 days' where id = $1`, [u]);
    assert.equal(await checkVisitSurvey(u, true, WIN), null);
    await pool.query(`update users set survey_last_shown_at = now() - interval '90 days' where id = $1`, [u]);
    assert.equal(await checkVisitSurvey(u, false, WIN), null); // canShow = false
    const general = await checkVisitSurvey(u, true, WIN);
    assert.equal(general?.trigger, "visit");
    assert.equal(general?.feature, null); // no recorded feature use → general questions only
    assert.equal(general?.questions.length, 5);

    const v = await mkUser("visit2");
    await pool.query(`update users set onboarded_at = now() - interval '120 days' where id = $1`, [v]); // never shown
    await pool.query(`insert into user_feature_uses (user_id, feature) values ($1, 'follow')`, [v]);
    const withFeature = await checkVisitSurvey(v, true, WIN);
    assert.equal(withFeature?.feature?.key, "follow");
  });
});

test("close and submit: funnel once, no user reference, the offer cleared, 409 / 422", { skip: !enabled }, async () => {
  await withSurveySwitch(true, async () => {
    const u = await mkUser("submit");
    assert.equal(await closeSurvey(u), false); // nothing open → 409 at the route
    const offer = (await recordFeatureUse(u, "search", true, WIN)).survey!;
    assert.ok(offer);

    const closedBefore = (await pool.query<{ n: number }>(`select coalesce(sum(closed),0)::int as n from survey_daily`)).rows[0]!.n;
    assert.equal(await closeSurvey(u), true);
    assert.equal(await closeSurvey(u), true); // second close: ok, no bump
    const closedAfter = (await pool.query<{ n: number }>(`select coalesce(sum(closed),0)::int as n from survey_daily`)).rows[0]!.n;
    assert.equal(closedAfter - closedBefore, 1);
    assert.ok(await getOpenSurvey(u), "a closed offer stays open for the menu");

    // 422 on a key the offer did not ask, and on an empty submission.
    assert.deepEqual(await submitSurvey(respondent(u), { answers: { "feature.useful": 3, "bogus.key": 2 } }), { ok: false, status: 422, error: "unknown question: bogus.key" });
    assert.equal((await submitSurvey(respondent(u), { answers: {} })).ok, false);

    const marker = `srv-marker-${Date.now()}`;
    assert.deepEqual(await submitSurvey(respondent(u), { answers: { "general.overall": 4, "feature.ease": 2 }, freeText: ` ${marker} `, via: "menu" }), { ok: true });
    const row = (await pool.query(`select * from survey_responses where free_text = $1`, [marker])).rows[0] as Record<string, unknown>;
    assert.ok(row);
    // Anonymous by construction: no column references the user, and the stamp is a date.
    assert.deepEqual(Object.keys(row).sort(), ["answered_on", "catalog_version", "feature", "free_text", "id", "segment", "trigger", "via"]);
    assert.equal(row.segment, "consumer");
    assert.equal(row.feature, "search");
    assert.equal(row.via, "menu");
    const answers = (await pool.query<{ question_key: string; stars: number }>(`select question_key, stars from survey_answers where response_id = $1 order by question_key`, [row.id])).rows;
    assert.deepEqual(answers, [{ question_key: "feature.ease", stars: 2 }, { question_key: "general.overall", stars: 4 }]);
    assert.equal((await userRow(u)).survey_offer, null);
    assert.equal(await getOpenSurvey(u), null);
    // A second submit: nothing open.
    assert.deepEqual(await submitSurvey(respondent(u), { answers: { "general.overall": 5 } }), { ok: false, status: 409, error: "no_open_survey" });

    // Delete: cascade, audited without the text.
    const admin = await mkUser("admin");
    assert.equal(await deleteSurveyResponse(row.id as string, admin), true);
    assert.equal((await pool.query(`select 1 from survey_answers where response_id = $1`, [row.id])).rowCount, 0);
    const audit = (await pool.query<{ before: Record<string, unknown> }>(
      `select before from audit_log where action = 'survey.response_deleted' and target_id = $1`,
      [row.id],
    )).rows[0]!;
    assert.equal(audit.before.textLength, marker.length);
    assert.equal(audit.before.answerCount, 2);
    assert.ok(!JSON.stringify(audit.before).includes(marker), "the audit row never carries the text");
    assert.equal(await deleteSurveyResponse(row.id as string, admin), false);
  });
});

test("an offer ends on expiry, opt-out and switch-off", { skip: !enabled }, async () => {
  await withSurveySwitch(true, async () => {
    const u = await mkUser("expire");
    assert.ok((await recordFeatureUse(u, "search", true, WIN)).survey);
    // Opt-out clears it at once; opting back in keeps the 30-day stamp.
    await setUserSurveysEnabled(u, false);
    assert.equal((await userRow(u)).survey_offer, null);
    await setUserSurveysEnabled(u, true);
    assert.ok((await userRow(u)).survey_last_shown_at);
    assert.equal((await recordFeatureUse(u, "install", true, WIN)).survey, null); // floor still applies

    // Expired: shown 30 days ago → reads as none and is cleared lazily; submit is a 409.
    await pool.query(
      `update users set survey_offer = '{"catalogVersion":1,"trigger":"feature","feature":"search","rotating":"rotating.look","closed":false}'::jsonb,
                        survey_last_shown_at = now() - interval '30 days' where id = $1`,
      [u],
    );
    assert.equal((await submitSurvey(respondent(u), { answers: { "general.overall": 3 } })).ok, false);
    assert.equal(await getOpenSurvey(u), null);
    assert.equal((await userRow(u)).survey_offer, null);

    // Switch-off: an open offer reads as none; submissions are refused.
    await pool.query(`update users set survey_last_shown_at = null where id = $1`, [u]);
    const offer = (await recordFeatureUse(u, "rating", true, WIN)).survey;
    assert.ok(offer);
    await withSurveySwitch(false, async () => {
      assert.deepEqual(await submitSurvey(respondent(u), { answers: { "general.overall": 3 } }), { ok: false, status: 409, error: "no_open_survey" });
    });
  });
});

test("admin summary + comments: filters and the size-5 withholding (isolated dataset)", { skip: !enabled }, async () => {
  const client = await pool.connect();
  const db = client as unknown as Pool;
  try {
    await client.query("begin");
    await client.query(`delete from survey_responses`);
    await client.query(`delete from survey_daily`);
    const today = `(now() at time zone 'utc')::date`;
    // 6 consumer responses about search (overall = 4, one with text), 2 admin responses (overall = 1).
    for (let i = 0; i < 6; i++) {
      const id = (await client.query<{ id: string }>(
        `insert into survey_responses (answered_on, catalog_version, trigger, feature, segment, via, free_text)
         values (${today}, 1, 'feature', 'search', 'consumer', 'popup', $1) returning id`,
        [i === 0 ? "consumer comment" : null],
      )).rows[0]!.id;
      await client.query(`insert into survey_answers values ($1, 'general.overall', 4), ($1, 'feature.useful', 5)`, [id]);
    }
    for (let i = 0; i < 2; i++) {
      const id = (await client.query<{ id: string }>(
        `insert into survey_responses (answered_on, catalog_version, trigger, feature, segment, via, free_text)
         values (${today} - 40, 1, 'visit', null, 'admin', 'menu', 'admin comment') returning id`,
      )).rows[0]!.id;
      await client.query(`insert into survey_answers values ($1, 'general.overall', 1)`, [id]);
    }
    await client.query(`insert into survey_daily (day, shown, closed, submitted, submitted_from_menu) values (${today}, 9, 3, 6, 0)`);

    // 30 days: only the 6 consumer responses.
    const s30 = await getSurveySummary({ range: 30, segment: null, feature: null }, db);
    assert.equal(s30.responses, 6);
    assert.deepEqual({ shown: s30.funnel.shown, closed: s30.funnel.closed, submitted: s30.funnel.submitted }, { shown: 9, closed: 3, submitted: 6 });
    const overall = s30.questions.find((q) => q.key === "general.overall")!;
    assert.deepEqual({ n: overall.n, avg: overall.avg, withheld: overall.withheld }, { n: 6, avg: 4, withheld: false });
    assert.deepEqual(overall.distribution, [0, 0, 0, 6, 0]);
    assert.equal(s30.features.find((f) => f.key === "search")?.n, 6);

    // All time, admin segment: 2 responses → every figure withheld.
    const sAdmin = await getSurveySummary({ range: "all", segment: "admin", feature: null }, db);
    const adminOverall = sAdmin.questions.find((q) => q.key === "general.overall")!;
    assert.deepEqual({ n: adminOverall.n, avg: adminOverall.avg, distribution: adminOverall.distribution, withheld: adminOverall.withheld }, { n: null, avg: null, distribution: null, withheld: true });
    assert.ok(sAdmin.series.every((p) => p.withheld && p.n === null && p.overallAvg === null));
    const cAdmin = await getSurveyComments({ range: "all", segment: "admin", feature: null }, 0, 50, db);
    assert.deepEqual(cAdmin, { comments: [], total: 0, hasMore: false, withheld: true });

    // All time, unfiltered: 8 responses → the feed shows both texts, newest date first.
    const cAll = await getSurveyComments({ range: "all", segment: null, feature: null }, 0, 50, db);
    assert.equal(cAll.withheld, false);
    assert.equal(cAll.total, 3);
    assert.equal(cAll.comments[0]!.text, "consumer comment");
    assert.equal(cAll.comments.at(-1)!.segment, "admin");

    // Feature filter: search.
    const sSearch = await getSurveySummary({ range: "all", segment: null, feature: "search" }, db);
    assert.equal(sSearch.questions.find((q) => q.key === "feature.useful")?.avg, 5);
    assert.match(sSearch.questions.find((q) => q.key === "feature.useful")!.text, /catalog search/);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
});

test("GDPR erasure clears the per-user survey state and leaves responses untouched", { skip: !enabled }, async () => {
  await withSurveySwitch(true, async () => {
    const u = await mkUser("erase");
    const admin = await mkUser("erase-admin");
    assert.ok((await recordFeatureUse(u, "search", true, WIN)).survey);
    const marker = `srv-erase-${Date.now()}`;
    assert.deepEqual(await submitSurvey(respondent(u), { freeText: marker }), { ok: true });
    await recordFeatureUse(u, "follow", false);
    await pool.query(`update users set surveys_enabled = false where id = $1`, [u]);

    const r = await eraseUser(admin, u, null);
    assert.equal(r.ok, true);
    assert.equal((await pool.query(`select 1 from user_feature_uses where user_id = $1`, [u])).rowCount, 0);
    const row = await userRow(u);
    assert.deepEqual({ offer: row.survey_offer, shown: row.survey_last_shown_at, enabled: row.surveys_enabled }, { offer: null, shown: null, enabled: true });
    assert.equal((await pool.query(`select 1 from survey_responses where free_text = $1`, [marker])).rowCount, 1);
    await pool.query(`delete from survey_responses where free_text = $1`, [marker]);
  });
});
