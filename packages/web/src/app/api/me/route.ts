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
} from "../../../lib/settings";
import { invalidateLeaderboard } from "../../../lib/leaderboard";

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
            onboarded_at: string | null;
          }>(
            `select date_format, leaderboard_hidden, email_notifications, drift_notifications, new_version_notifications, onboarded_at
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

  return Response.json({
    userId: access.userId,
    isPlatformAdmin: access.isPlatformAdmin,
    // First-login onboarding marker (UTC ISO, or null = never seen). When null, the app forces the
    // Quick start page once on the next page load (AppShell's global gate). SKILLY_SPEC.md §8.
    onboardedAt: prefs?.onboarded_at ?? null,
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
  return Response.json({ ok: true });
}
