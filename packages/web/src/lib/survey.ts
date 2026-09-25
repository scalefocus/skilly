// The feedback survey (SKILLY_SPEC.md §36) — the web tier's reads and writes. The catalog and the
// pure rules (eligibility, the roll, offer composition, validation, segment, withholding) live in
// @skilly/shared/survey; this module only moves them in and out of Postgres.
//
// Anonymity (§36.12): survey_responses carries no user reference and only a UTC date. The per-user
// state — the first-use ledger, the 30-day stamp and the open offer — lives on the user's side, and
// the open offer is cleared in the same transaction that stores the response.
import type { Pool, PoolClient } from "pg";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { getPlatformSettings } from "./settings";
import { rumBucketFor } from "./rum/math";
import type { RumRange } from "./rum/queries";
import {
  SURVEY_FEATURES,
  SURVEY_FLOOR_DAYS,
  SURVEY_GRACE_DAYS,
  SURVEY_QUESTION_ORDER,
  SURVEY_SELF_COOLDOWN_DAYS,
  composeSurveyOffer,
  isRetiredQuestion,
  isSurveyEligible,
  isSurveyFallbackDue,
  isSurveyOfferExpired,
  parseStoredOffer,
  pickFallbackFeature,
  selfSurveyGate,
  selfSurveyNextAt,
  surveyFeatureLabel,
  surveyOfferView,
  surveyQuestionText,
  surveyRollWins,
  surveySegment,
  surveyWithheld,
  validateSurveySubmission,
  type StoredSurveyOffer,
  type SurveyFeatureKey,
  type SurveyOfferView,
  type SurveySegment,
  type SurveySource,
  type SurveyTrigger,
} from "@skilly/shared/survey";

/** Today's UTC date — the only time a response or a funnel counter records. */
const TODAY = `(now() at time zone 'utc')::date`;

export interface SurveyRollOptions {
  /** Injectable RNG ([0, 1), like Math.random) for tests and the dev-only forced-win seam. */
  rng?: () => number;
}

interface UserSurveyRow {
  status: string;
  erased_at: Date | null;
  onboarded_at: Date | null;
  surveys_enabled: boolean;
  survey_last_shown_at: Date | null;
  survey_self_shown_at: Date | null;
  survey_offer: unknown;
}

async function loadUser(userId: string, db: Pool | PoolClient = pool, lock = false): Promise<UserSurveyRow | undefined> {
  const { rows } = await db.query<UserSurveyRow>(
    `select status, erased_at, onboarded_at, surveys_enabled, survey_last_shown_at, survey_self_shown_at, survey_offer
       from users where id = $1${lock ? " for update" : ""}`,
    [userId],
  );
  return rows[0];
}

function state(u: UserSurveyRow, platformEnabled: boolean, now: Date) {
  return {
    status: u.status,
    erased: u.erased_at !== null,
    onboardedAt: u.onboarded_at,
    surveysEnabled: u.surveys_enabled,
    lastShownAt: u.survey_last_shown_at,
    selfOfferOpen: liveOffer(u, platformEnabled, now)?.offer.trigger === "self",
  };
}

type DailyCounter = "shown" | "closed" | "submitted" | "submitted_from_menu" | "shown_self" | "submitted_self";

async function bumpDaily(db: Pool | PoolClient, column: DailyCounter, extra?: "submitted_from_menu"): Promise<void> {
  const cols = extra ? [column, extra] : [column];
  await db.query(
    `insert into survey_daily (day, ${cols.join(", ")}) values (${TODAY}, ${cols.map(() => "1").join(", ")})
     on conflict (day) do update set ${cols.map((c) => `${c} = survey_daily.${c} + 1`).join(", ")}`,
  );
}

/**
 * Open an offer in ONE guarded UPDATE: the eligibility predicate is re-checked in its WHERE, so two
 * tabs or two requests can't both win (§36.1). Returns the offer payload, or null when the race was
 * lost. Bumps the funnel's `shown` counter. Never replaces an open on-demand offer (§36.16).
 */
async function openOffer(userId: string, offer: StoredSurveyOffer): Promise<SurveyOfferView | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ shown: Date }>(
      `update users set survey_last_shown_at = now(), survey_offer = $2::jsonb
        where id = $1 and status = 'active' and erased_at is null and surveys_enabled
          and onboarded_at is not null and onboarded_at <= now() - make_interval(days => $3)
          and (survey_last_shown_at is null or survey_last_shown_at <= now() - make_interval(days => $4))
          and not (coalesce(survey_offer->>'trigger', '') = 'self'
                   and survey_self_shown_at > now() - make_interval(days => $5))
        returning survey_last_shown_at as shown`,
      [userId, JSON.stringify(offer), SURVEY_GRACE_DAYS, SURVEY_FLOOR_DAYS, SURVEY_SELF_COOLDOWN_DAYS],
    );
    const shown = rows[0]?.shown;
    if (!shown) {
      await client.query("rollback");
      return null;
    }
    await bumpDaily(client, "shown");
    await client.query("commit");
    return surveyOfferView(offer, shown);
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * §36.10 `POST /api/me/features/used`. Records the first use (a fresh insert is a first use); on a
 * fresh insert with an eligible user and `canShow`, rolls 1 in 3 and opens an offer on a win. The
 * first use is recorded — and so consumed — whatever the outcome (§36.1).
 */
export async function recordFeatureUse(
  userId: string,
  feature: SurveyFeatureKey,
  canShow: boolean,
  opts: SurveyRollOptions = {},
): Promise<{ firstUse: boolean; survey: SurveyOfferView | null }> {
  const ins = await pool.query(
    `insert into user_feature_uses (user_id, feature) values ($1, $2) on conflict do nothing`,
    [userId, feature],
  );
  const firstUse = (ins.rowCount ?? 0) > 0;
  if (!firstUse || !canShow) return { firstUse, survey: null };
  const [u, settings] = await Promise.all([loadUser(userId), getPlatformSettings()]);
  const now = new Date();
  if (!u || !isSurveyEligible(state(u, settings.surveyEnabled, now), settings.surveyEnabled, now)) return { firstUse, survey: null };
  const rng = opts.rng ?? Math.random;
  if (!surveyRollWins(rng)) return { firstUse, survey: null };
  return { firstUse, survey: await openOffer(userId, composeSurveyOffer("feature", feature, rng)) };
}

/**
 * §36.10 `POST /api/me/survey/check` — the long-time-user fallback (§36.1): 90 days without an offer
 * (or since onboarding), eligible, `canShow` → a 1-in-3 roll. The feature questions cover a random
 * feature the user has already used, or are left out.
 */
export async function checkVisitSurvey(userId: string, canShow: boolean, opts: SurveyRollOptions = {}): Promise<SurveyOfferView | null> {
  if (!canShow) return null;
  const [u, settings] = await Promise.all([loadUser(userId), getPlatformSettings()]);
  if (!u) return null;
  const now = new Date();
  const s = state(u, settings.surveyEnabled, now);
  if (!isSurveyEligible(s, settings.surveyEnabled, now) || !isSurveyFallbackDue(s, now)) return null;
  const rng = opts.rng ?? Math.random;
  if (!surveyRollWins(rng)) return null;
  const { rows } = await pool.query<{ feature: string }>(`select feature from user_feature_uses where user_id = $1`, [userId]);
  return openOffer(userId, composeSurveyOffer("visit", pickFallbackFeature(rows.map((r) => r.feature), rng), rng));
}

/**
 * The open offer, parsed, with its shown time; expired / malformed / other-version / switched-off
 * offers read as none. A random offer ends with the opt-out and lives 30 days from
 * `survey_last_shown_at`; an on-demand one ignores the opt-out and lives 7 days from
 * `survey_self_shown_at` (§36.16).
 */
function liveOffer(u: UserSurveyRow, platformEnabled: boolean, now: Date): { offer: StoredSurveyOffer; shownAt: Date } | null {
  if (!platformEnabled) return null;
  const offer = parseStoredOffer(u.survey_offer);
  if (!offer) return null;
  const self = offer.trigger === "self";
  const shownAt = self ? u.survey_self_shown_at : u.survey_last_shown_at;
  if (!shownAt || (!self && !u.surveys_enabled) || isSurveyOfferExpired(shownAt, now, offer.trigger)) return null;
  return { offer, shownAt };
}

/**
 * The open offer for `GET /api/me` (`openSurvey`, §36.5) — the account-menu entry and the profile
 * button. An offer that has ended (§36.1 expiry) is cleared here, lazily; `survey_last_shown_at`
 * is kept.
 */
export async function getOpenSurvey(userId: string, platformEnabled?: boolean): Promise<SurveyOfferView | null> {
  const u = await loadUser(userId);
  if (!u || u.survey_offer == null) return null;
  const enabled = platformEnabled ?? (await getPlatformSettings()).surveyEnabled;
  const live = liveOffer(u, enabled, new Date());
  if (!live) {
    await pool.query(`update users set survey_offer = null where id = $1 and survey_offer is not null`, [userId]);
    return null;
  }
  return surveyOfferView(live.offer, live.shownAt);
}

/**
 * §36.10 `POST /api/me/survey/close` — the first close of an offer bumps the funnel once. An
 * on-demand offer's close is recorded on the offer but counts nowhere (§36.16).
 */
export async function closeSurvey(userId: string): Promise<boolean> {
  const [u, settings] = await Promise.all([loadUser(userId), getPlatformSettings()]);
  const live = u ? liveOffer(u, settings.surveyEnabled, new Date()) : null;
  if (!live) return false;
  const { rowCount } = await pool.query(
    `update users set survey_offer = jsonb_set(survey_offer, '{closed}', 'true'::jsonb)
      where id = $1 and survey_offer is not null and coalesce((survey_offer->>'closed')::boolean, false) = false`,
    [userId],
  );
  if ((rowCount ?? 0) > 0 && live.offer.trigger !== "self") await bumpDaily(pool, "closed");
  return true;
}

/** §36.16 `GET /api/me` `selfSurvey`: null while the platform switch is off, else when it's next available. */
export function selfSurveyStatus(selfShownAt: Date | null, platformEnabled: boolean, now = new Date()): { nextAt: string | null } | null {
  if (!platformEnabled) return null;
  return { nextAt: selfSurveyNextAt(selfShownAt, now)?.toISOString() ?? null };
}

export type StartResult =
  | { ok: true; survey: SurveyOfferView; created: boolean }
  | { ok: false; error: "surveys_off" | "inactive" | "cooldown"; nextAt?: string };

/**
 * §36.10 / §36.16 `POST /api/me/survey/start` — "Give feedback now". An open offer (random or
 * on-demand) is returned unchanged. Otherwise, under the user-row lock (so two concurrent calls
 * stamp and count once), the gates are re-checked, `survey_self_shown_at` is stamped, the `self`
 * offer is stored and `shown_self` is bumped. `survey_last_shown_at` is never touched.
 */
export async function startSelfSurvey(userId: string, opts: SurveyRollOptions = {}): Promise<StartResult> {
  const settings = await getPlatformSettings();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const u = await loadUser(userId, client, true);
    const now = new Date();
    if (!u) {
      await client.query("rollback");
      return { ok: false, error: "inactive" };
    }
    const live = liveOffer(u, settings.surveyEnabled, now);
    if (live) {
      await client.query("rollback");
      return { ok: true, survey: surveyOfferView(live.offer, live.shownAt), created: false };
    }
    const gate = selfSurveyGate({ status: u.status, erased: u.erased_at !== null, selfShownAt: u.survey_self_shown_at }, settings.surveyEnabled, now);
    if (!gate.ok) {
      await client.query("rollback");
      return { ok: false, error: gate.error, ...(gate.nextAt ? { nextAt: gate.nextAt.toISOString() } : {}) };
    }
    const offer = composeSurveyOffer("self", null, opts.rng ?? Math.random);
    const { rows } = await client.query<{ shown: Date }>(
      `update users set survey_self_shown_at = now(), survey_offer = $2::jsonb where id = $1 returning survey_self_shown_at as shown`,
      [userId, JSON.stringify(offer)],
    );
    await bumpDaily(client, "shown_self");
    await client.query("commit");
    return { ok: true, survey: surveyOfferView(offer, rows[0]!.shown), created: true };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface SurveyRespondent {
  userId: string;
  isPlatformAdmin: boolean;
  namespaceRoles: Map<string, string>;
}

export type SubmitResult = { ok: true } | { ok: false; status: 409 | 422; error: string };

/**
 * §36.6 store a response. One transaction: re-read the open offer under a row lock (409 when there
 * is none), validate against it (422), insert the response with no user reference and today's UTC
 * date, clear the offer, bump the funnel. Never audited or logged with an identity (§36.11).
 */
export async function submitSurvey(r: SurveyRespondent, body: unknown): Promise<SubmitResult> {
  const settings = await getPlatformSettings();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const u = await loadUser(r.userId, client, true);
    const offer = u ? liveOffer(u, settings.surveyEnabled, new Date())?.offer : null;
    if (!offer) {
      await client.query("rollback");
      return { ok: false, status: 409, error: "no_open_survey" };
    }
    const v = validateSurveySubmission(offer, body);
    if (!v.ok) {
      await client.query("rollback");
      return { ok: false, status: 422, error: v.error };
    }
    const maintains = await client.query(`select 1 from skill_maintainers where user_id = $1 limit 1`, [r.userId]);
    const segment = surveySegment({
      isPlatformAdmin: r.isPlatformAdmin,
      isNamespaceAdmin: [...r.namespaceRoles.values()].includes("namespace_admin"),
      maintainsSkills: (maintains.rowCount ?? 0) > 0,
    });
    const { rows } = await client.query<{ id: string }>(
      `insert into survey_responses (answered_on, catalog_version, trigger, feature, segment, via, free_text)
       values (${TODAY}, $1, $2, $3, $4, $5, $6) returning id`,
      [offer.catalogVersion, offer.trigger, v.feature, segment, v.via, v.freeText],
    );
    const keys = Object.keys(v.answers);
    if (keys.length > 0) {
      await client.query(
        `insert into survey_answers (response_id, question_key, stars)
         select $1, k, s from unnest($2::text[], $3::smallint[]) as t(k, s)`,
        [rows[0]!.id, keys, keys.map((k) => v.answers[k])],
      );
    }
    await client.query(`update users set survey_offer = null where id = $1`, [r.userId]);
    // An on-demand submission counts only in its own funnel (§36.16).
    if (offer.trigger === "self") await bumpDaily(client, "submitted_self");
    else await bumpDaily(client, "submitted", v.via === "menu" ? "submitted_from_menu" : undefined);
    await client.query("commit");
    return { ok: true };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * §36.7 the profile opt-out. Switching off clears an open RANDOM offer at once; an open on-demand
 * offer survives (§36.16). The 30-day stamp stays.
 */
export async function setUserSurveysEnabled(userId: string, enabled: boolean): Promise<void> {
  await pool.query(
    `update users set surveys_enabled = $2,
            survey_offer = case when $2 or survey_offer->>'trigger' = 'self' then survey_offer else null end,
            updated_at = now()
      where id = $1`,
    [userId, enabled],
  );
}

// ---- admin results (§36.9) -----------------------------------------------------------------------

export interface SurveyFilters {
  range: RumRange;
  segment: SurveySegment | null;
  feature: string | null;
  /** §36.16 the Source filter: prompted (`feature` / `visit`) or self-initiated; null = all. */
  source: SurveySource | null;
}

/** `answered_on` within the last `range` UTC days (today included), plus the segment/feature/source filters. */
function whereFor(f: SurveyFilters, alias = "r"): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (f.range !== "all") {
    params.push(f.range);
    clauses.push(`${alias}.answered_on > ${TODAY} - $${params.length}::int`);
  }
  if (f.segment) {
    params.push(f.segment);
    clauses.push(`${alias}.segment = $${params.length}`);
  }
  if (f.feature) {
    params.push(f.feature);
    clauses.push(`${alias}.feature = $${params.length}`);
  }
  if (f.source) clauses.push(f.source === "self" ? `${alias}.trigger = 'self'` : `${alias}.trigger <> 'self'`);
  return { sql: clauses.length ? `where ${clauses.join(" and ")}` : "", params };
}

export interface SurveyQuestionStat {
  key: string;
  text: string;
  retired: boolean;
  n: number | null;
  avg: number | null;
  distribution: number[] | null;
  withheld: boolean;
}

export interface SurveySummary {
  enabled: boolean;
  lastDate: string | null;
  bucket: "day" | "week" | "month";
  responses: number;
  funnel: { shown: number; closed: number; submitted: number; submittedFromMenu: number; optedOut: number; shownSelf: number; submittedSelf: number };
  series: { date: string; n: number | null; overallAvg: number | null; withheld: boolean }[];
  questions: SurveyQuestionStat[];
  features: { key: string; label: string; n: number | null }[];
}

const round1 = (v: number | null): number | null => (v == null ? null : Math.round(v * 10) / 10);

export async function getSurveySummary(f: SurveyFilters, db: Pool = pool): Promise<SurveySummary> {
  const w = whereFor(f);
  const rangeOnly = whereFor({ ...f, segment: null, feature: null, source: null });
  const settings = await getPlatformSettings(db);

  const [meta, responses, perQuestion, perFeature, funnel, optedOut] = await Promise.all([
    db.query<{ last: string | null; first: string | null }>(
      `select max(answered_on)::text as last, min(answered_on)::text as first from survey_responses`,
    ),
    // The section header's "N responses in range" — unfiltered.
    db.query<{ n: number }>(`select count(*)::int as n from survey_responses r ${rangeOnly.sql}`, rangeOnly.params),
    db.query<{ key: string; n: number; avg: number; d1: number; d2: number; d3: number; d4: number; d5: number }>(
      `select a.question_key as key, count(*)::int as n, avg(a.stars)::float8 as avg,
              count(*) filter (where a.stars = 1)::int as d1, count(*) filter (where a.stars = 2)::int as d2,
              count(*) filter (where a.stars = 3)::int as d3, count(*) filter (where a.stars = 4)::int as d4,
              count(*) filter (where a.stars = 5)::int as d5
         from survey_answers a join survey_responses r on r.id = a.response_id
         ${w.sql}
        group by a.question_key`,
      w.params,
    ),
    // The feature filter's options: features with responses in range (under the segment filter).
    (() => {
      const fw = whereFor({ ...f, feature: null });
      return db.query<{ feature: string; n: number }>(
        `select r.feature, count(*)::int as n from survey_responses r ${fw.sql ? `${fw.sql} and` : "where"} r.feature is not null group by r.feature`,
        fw.params,
      );
    })(),
    db.query<{ shown: number; closed: number; submitted: number; from_menu: number; shown_self: number; submitted_self: number }>(
      `select coalesce(sum(shown), 0)::int as shown, coalesce(sum(closed), 0)::int as closed,
              coalesce(sum(submitted), 0)::int as submitted, coalesce(sum(submitted_from_menu), 0)::int as from_menu,
              coalesce(sum(shown_self), 0)::int as shown_self, coalesce(sum(submitted_self), 0)::int as submitted_self
         from survey_daily d
        ${f.range === "all" ? "" : `where d.day > ${TODAY} - $1::int`}`,
      f.range === "all" ? [] : [f.range],
    ),
    db.query<{ n: number }>(`select count(*)::int as n from users where not surveys_enabled and erased_at is null and status = 'active'`),
  ]);

  const first = meta.rows[0]?.first ?? null;
  const spanDays = first ? Math.max(1, Math.round((Date.now() - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1) : null;
  const bucket = rumBucketFor(f.range, spanDays);
  const series = await db.query<{ date: string; n: number; avg: number | null }>(
    `select date_trunc('${bucket}', r.answered_on)::date::text as date, count(distinct r.id)::int as n,
            avg(a.stars) filter (where a.question_key = 'general.overall')::float8 as avg
       from survey_responses r left join survey_answers a on a.response_id = r.id
       ${w.sql}
      group by 1 order by 1`,
    w.params,
  );

  const stats = new Map(perQuestion.rows.map((r) => [r.key, r]));
  const keys = [...SURVEY_QUESTION_ORDER.filter((k) => stats.has(k)), ...[...stats.keys()].filter((k) => !SURVEY_QUESTION_ORDER.includes(k)).sort()];
  const questions: SurveyQuestionStat[] = keys.map((key) => {
    const s = stats.get(key)!;
    const withheld = surveyWithheld(s.n);
    return {
      key,
      text: surveyQuestionText(key, f.feature),
      retired: isRetiredQuestion(key) || !SURVEY_QUESTION_ORDER.includes(key),
      n: withheld ? null : s.n,
      avg: withheld ? null : round1(s.avg),
      distribution: withheld ? null : [s.d1, s.d2, s.d3, s.d4, s.d5],
      withheld,
    };
  });

  const fn = funnel.rows[0]!;
  return {
    enabled: settings.surveyEnabled,
    lastDate: meta.rows[0]?.last ?? null,
    bucket,
    responses: responses.rows[0]!.n,
    funnel: {
      shown: fn.shown,
      closed: fn.closed,
      submitted: fn.submitted,
      submittedFromMenu: fn.from_menu,
      optedOut: optedOut.rows[0]!.n,
      shownSelf: fn.shown_self,
      submittedSelf: fn.submitted_self,
    },
    series: series.rows.map((r) => {
      const withheld = surveyWithheld(r.n);
      return { date: r.date, n: withheld ? null : r.n, overallAvg: withheld ? null : round1(r.avg), withheld };
    }),
    questions,
    features: SURVEY_FEATURES.filter((x) => perFeature.rows.some((r) => r.feature === x.key)).map((x) => {
      const n = perFeature.rows.find((r) => r.feature === x.key)!.n;
      return { key: x.key, label: surveyFeatureLabel(x.key), n: surveyWithheld(n) ? null : n };
    }),
  };
}

export interface SurveyComment {
  id: string;
  answeredOn: string;
  feature: string | null;
  segment: SurveySegment;
  trigger: SurveyTrigger;
  text: string;
}

/**
 * §36.9 the free-text feed: newest date first, then by the random id within a day (so it never
 * reveals intra-day order). Withheld as a whole when the filtered response set is under 5.
 */
export async function getSurveyComments(
  f: SurveyFilters,
  offset: number,
  limit: number,
  db: Pool = pool,
): Promise<{ comments: SurveyComment[]; total: number; hasMore: boolean; withheld: boolean }> {
  const w = whereFor(f);
  const set = await db.query<{ n: number }>(`select count(*)::int as n from survey_responses r ${w.sql}`, w.params);
  if (surveyWithheld(set.rows[0]!.n)) return { comments: [], total: 0, hasMore: false, withheld: true };
  const textWhere = `${w.sql ? `${w.sql} and` : "where"} r.free_text is not null`;
  const [count, page] = await Promise.all([
    db.query<{ n: number }>(`select count(*)::int as n from survey_responses r ${textWhere}`, w.params),
    db.query<{ id: string; answered_on: string; feature: string | null; segment: SurveySegment; trigger: SurveyTrigger; free_text: string }>(
      `select r.id, r.answered_on::text as answered_on, r.feature, r.segment, r.trigger, r.free_text
         from survey_responses r ${textWhere}
        order by r.answered_on desc, r.id
        offset $${w.params.length + 1} limit $${w.params.length + 2}`,
      [...w.params, offset, limit],
    ),
  ]);
  const total = count.rows[0]!.n;
  return {
    comments: page.rows.map((r) => ({ id: r.id, answeredOn: r.answered_on, feature: r.feature, segment: r.segment, trigger: r.trigger, text: r.free_text })),
    total,
    hasMore: offset + page.rows.length < total,
    withheld: false,
  };
}

/**
 * §36.9 an admin deletes one response (answers cascade). Audited as `survey.response_deleted` —
 * the text itself is NEVER copied into the audit log (§36.11). Returns false for an unknown id.
 */
export async function deleteSurveyResponse(id: string, actorUserId: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ answered_on: string; feature: string | null; segment: string; catalog_version: number; text_length: number; answers: number }>(
      `select r.answered_on::text as answered_on, r.feature, r.segment, r.catalog_version,
              coalesce(char_length(r.free_text), 0)::int as text_length,
              (select count(*)::int from survey_answers a where a.response_id = r.id) as answers
         from survey_responses r where r.id = $1 for update`,
      [id],
    );
    const row = rows[0];
    if (!row) {
      await client.query("rollback");
      return false;
    }
    await client.query(`delete from survey_responses where id = $1`, [id]);
    await appendAudit(client, {
      actorUserId,
      action: "survey.response_deleted",
      targetType: "survey_response",
      targetId: id,
      before: { answeredOn: row.answered_on, feature: row.feature, segment: row.segment, catalogVersion: row.catalog_version, answerCount: row.answers, textLength: row.text_length },
    });
    await client.query("commit");
    return true;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
