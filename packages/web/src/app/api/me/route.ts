// Returns the signed-in user's identity + resolved effective access.
// Proves the end-to-end identity loop: OIDC session -> Entra oid -> SCIM-synced
// groups + role_mappings -> EffectiveAccess. SKILLY_SPEC.md §4, §5.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { pool } from "../../../lib/db";
import {
  getPlatformSettings,
  setUserDateFormat,
  setUserLeaderboardHidden,
  setUserEmailNotifications,
  setUserDriftNotifications,
  setUserNewVersionNotifications,
  setUserDiscussionNotifications,
  setUserDirectoryHidden,
  setUserAchievementsHidden,
  setUserAllowFollows,
} from "../../../lib/settings";
import { invalidateLeaderboard } from "../../../lib/leaderboard";
import { invalidateLevels } from "../../../lib/levels";
import { setUserTimeZone } from "../../../lib/achievements";
import { validateTimeZone } from "@skilly/shared/achievements";
import { getOpenSurvey, setUserSurveysEnabled } from "../../../lib/survey";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const access = await resolveUserAccess(oid);

  // Fetch the three remaining bits concurrently (and read the user's prefs row ONCE):
  //  - maintainsSkills: is the user an explicit maintainer of ≥1 skill (shows the usage nav). §21
  //  - prefs: the user's date-format override + leaderboard opt-out, in a single users row read
  //  - platform settings: the org-wide date-format default
  // Date/time: the EFFECTIVE style (`dateFormat`) is the override if set, else the system default;
  // we also return the override + system default so the profile page can show "System (xx)".
  const [maintainsSkills, prefs, settings] = await Promise.all([
    access.userId
      ? pool.query(`select 1 from skill_maintainers where user_id = $1 limit 1`, [access.userId]).then((r) => (r.rowCount ?? 0) > 0)
      : Promise.resolve(false),
    access.userId
      ? pool
          .query<{
            date_format: string | null;
            leaderboard_hidden: boolean;
            email_notifications: boolean;
            drift_notifications: boolean;
            new_version_notifications: boolean;
            discussion_notifications: boolean;
            directory_hidden: boolean;
            achievements_hidden: boolean;
            allow_follows: boolean;
            surveys_enabled: boolean;
            has_survey_offer: boolean;
            time_zone: string | null;
            onboarded_at: string | null;
            whats_new_seen_version: string | null;
          }>(
            `select date_format, leaderboard_hidden, email_notifications, drift_notifications, new_version_notifications, discussion_notifications, directory_hidden, achievements_hidden, allow_follows, surveys_enabled, survey_offer is not null as has_survey_offer, time_zone, onboarded_at, whats_new_seen_version
               from users where id = $1`,
            [access.userId],
          )
          .then((r) => r.rows[0])
      : Promise.resolve(undefined),
    getPlatformSettings(pool),
  ]);
  const systemDateFormat = settings.dateFormat;
  const dfo = prefs?.date_format;
  const dateFormatOverride = dfo === "eu" || dfo === "us" ? dfo : null;
  const leaderboardHidden = prefs?.leaderboard_hidden ?? false;
  // §36.5 the open feedback-survey offer behind the account-menu entry (read only when one is
  // stored; an ended offer is cleared there, lazily).
  const openSurvey = access.userId && prefs?.has_survey_offer ? await getOpenSurvey(access.userId, settings.surveyEnabled) : null;

  return Response.json({
    userId: access.userId,
    isPlatformAdmin: access.isPlatformAdmin,
    // First-login onboarding marker (UTC ISO, or null = never seen). When null, the app forces the
    // Quick start page once on the next page load (AppShell's global gate). SKILLY_SPEC.md §8.
    onboardedAt: prefs?.onboarded_at ?? null,
    // What's new marker (§23): the highest app version whose release notes this user has been shown
    // (null = never). AppShell compares it with the client bundle's APP_VERSION to decide whether to
    // show the once-per-minor/major "Version X updated — see what's new" toast.
    whatsNewSeenVersion: prefs?.whats_new_seen_version ?? null,
    // Dev passwordless sign-in is active — lets the UI offer dev-only affordances (e.g. "Reach out"
    // to yourself, to exercise messaging with a single account). Never true in production.
    devAuth: process.env.SKILLY_DEV_AUTH === "1",
    maintainsSkills,
    dateFormat: dateFormatOverride ?? systemDateFormat,
    dateFormatOverride,
    systemDateFormat,
    leaderboardHidden,
    // §12 email-channel opt-out: on = notification email over whichever transport is active.
    emailNotifications: prefs?.email_notifications ?? true,
    // §12 per-type maintainer opt-outs (row-level — the worker skips the user at insert time):
    // upstream drift on skills they maintain, and new versions of skills they maintain
    // (an explicit watch always outranks the latter).
    driftNotifications: prefs?.drift_notifications ?? true,
    newVersionNotifications: prefs?.new_version_notifications ?? true,
    // §24 skill-discussion opt-out (gates watcher- AND maintainer-derived recipients).
    discussionNotifications: prefs?.discussion_notifications ?? true,
    // §28 directory opt-out: hide job title / office / department from other people's hover cards.
    directoryHidden: prefs?.directory_hidden ?? false,
    // §31 achievements opt-out: hide earned badges from other people (the hall + hover card).
    achievementsHidden: prefs?.achievements_hidden ?? false,
    // §35.3 "Allow others to follow me" — off pauses every follow on the user.
    allowFollows: prefs?.allow_follows ?? true,
    // §36.7 the feedback-survey opt-out, and §36.5 the open offer (resolved questions, or null —
    // always null while the platform switch is off).
    surveysEnabled: prefs?.surveys_enabled ?? true,
    openSurvey,
    // §31.3 the browser-reported IANA zone (null until the web UI reports one). The app shell
    // compares it with the browser's own zone and PATCHes when they differ.
    timeZone: prefs?.time_zone ?? null,
    // §31.7 platform toggle — the profile hides its Achievements card while off.
    achievementsEnabled: settings.achievementsEnabled,
    // §32.6 real user monitoring — the browser collector reads both on mount and re-reads them on
    // its 60s poll, so flipping the switch stops collection within a minute.
    rumEnabled: settings.rumEnabled,
    rumSampleRate: settings.rumSampleRate,
    // §32.4 the flush ladder the collector walks (ascending seconds; [0] is the floor).
    rumFlushIntervals: settings.rumFlushIntervals,
    // Max uploaded hosted-bundle size (bytes) — surfaced on the propose form so the limit is
    // explicit and a too-large bundle is rejected client-side before upload. §6.
    maxBundleBytes: settings.maxBundleBytes,
    // Chunked-upload chunk size (bytes) — bundles above it upload in per-request pieces with a
    // progress bar; the server re-issues the authoritative value at session start. §6.
    uploadChunkBytes: settings.uploadChunkBytes,
    // Chat smart-polling cadence — read once at mount; drives the messages poller backoff (§24).
    chatPollIntervals: settings.chatPollIntervals,
    // How far ahead (calendar months) an install URL's expiry may be set — bounds the ExpiryPicker
    // (server re-validates authoritatively). §23.
    installMaxTtlMonths: settings.installMaxTtlMonths,
    // Map -> array of { namespaceId, role } for JSON.
    namespaceRoles: [...access.namespaceRoles.entries()].map(([namespaceId, role]) => ({
      namespaceId,
      role,
    })),
  });
}

// Self-service profile preferences. Currently just the personal date-format override:
//   { dateFormat: "eu" | "us" } sets it; { dateFormat: null } clears it (follow the system).
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    dateFormat?: string | null;
    leaderboardHidden?: boolean;
    emailNotifications?: boolean;
    driftNotifications?: boolean;
    newVersionNotifications?: boolean;
    discussionNotifications?: boolean;
    directoryHidden?: boolean;
    achievementsHidden?: boolean;
    allowFollows?: boolean;
    surveysEnabled?: boolean;
    timeZone?: string;
  };
  if ("dateFormat" in body) {
    const v = body.dateFormat;
    if (v !== "eu" && v !== "us" && v !== null) {
      return Response.json({ error: "dateFormat must be 'eu', 'us', or null" }, { status: 422 });
    }
    await setUserDateFormat(access.userId, v);
  }
  if (typeof body.leaderboardHidden === "boolean") {
    await setUserLeaderboardHidden(access.userId, body.leaderboardHidden);
    // Membership of the board changed — drop the cached boards (both windows) so the user
    // (re)appears on the next request instead of after the per-window TTL lapses.
    invalidateLeaderboard();
  }
  if (typeof body.emailNotifications === "boolean") {
    await setUserEmailNotifications(access.userId, body.emailNotifications);
  }
  if (typeof body.driftNotifications === "boolean") {
    await setUserDriftNotifications(access.userId, body.driftNotifications);
  }
  if (typeof body.newVersionNotifications === "boolean") {
    await setUserNewVersionNotifications(access.userId, body.newVersionNotifications);
  }
  if (typeof body.discussionNotifications === "boolean") {
    await setUserDiscussionNotifications(access.userId, body.discussionNotifications);
  }
  if (typeof body.directoryHidden === "boolean") {
    await setUserDirectoryHidden(access.userId, body.directoryHidden);
  }
  if (typeof body.achievementsHidden === "boolean") {
    await setUserAchievementsHidden(access.userId, body.achievementsHidden);
    // Membership of the level map changed (§31.10) — drop it so the ring disappears from, or
    // returns to, other people's views on their next page load instead of after the TTL.
    invalidateLevels();
  }
  if (typeof body.allowFollows === "boolean") {
    await setUserAllowFollows(access.userId, body.allowFollows);
    // The followers stat reads 0 while paused (§35.7) — drop the cached boards and badges.
    invalidateLeaderboard();
  }
  // §36.7 the feedback-survey opt-out. Off clears any open offer at once; the 30-day stamp stays.
  if (typeof body.surveysEnabled === "boolean") {
    await setUserSurveysEnabled(access.userId, body.surveysEnabled);
  }
  // §31.3 timezone capture: validated as a real IANA zone; an invalid value is ignored, never an
  // error. The FIRST capture also runs the deferred Night Shift / Weekend Warrior backfill.
  if (body.timeZone !== undefined) {
    const tz = validateTimeZone(body.timeZone);
    if (tz) await setUserTimeZone(access.userId, tz);
  }
  return Response.json({ ok: true });
}
