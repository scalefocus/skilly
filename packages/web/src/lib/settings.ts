// Platform-wide settings (key/value in platform_settings). Currently just the contribution
// policy. SKILLY_SPEC.md §4.
import type { Pool } from "pg";
import { coerceMaxFeatured, assertMaxFeatured } from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";

/** How timestamps are presented org-wide. EU = dd/mm/yyyy + 24h, US = mm/dd/yyyy + AM/PM.
 *  Storage is always UTC; the *style* and the viewer's timezone are display concerns. */
export type DateFormat = "eu" | "us";

/** How hard a duplicate proposal is stopped: hard-block (409 + disabled submit) or soft-warn
 *  (advisory notice; the submission still goes through). The slug-uniqueness 409 is always hard. */
export type DuplicateEnforcement = "block" | "warn";

/** Selectable maximum sizes for an uploaded hosted-skill bundle (bytes). The admin picks one;
 *  the upload endpoint rejects anything larger. Default 200 MB. */
export const BUNDLE_SIZE_OPTIONS = [100 * 1024, 1024 * 1024, 10 * 1024 * 1024, 50 * 1024 * 1024, 100 * 1024 * 1024, 200 * 1024 * 1024, 1024 * 1024 * 1024] as const;
const DEFAULT_MAX_BUNDLE_BYTES = 200 * 1024 * 1024;

/** Chunked-upload chunk size (§6): bundles larger than this upload in per-request pieces of this
 *  size, bounding every HTTP request so proxy body caps can't cut a large upload. Admin-set as a
 *  free-form whole number of MB (1–50), stored in bytes. Default 5 MB. */
export const UPLOAD_CHUNK_MB_MIN = 1;
export const UPLOAD_CHUNK_MB_MAX = 50;
export const DEFAULT_UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;

/** Parse an admin-entered chunk size (whole MB, 1–50) into bytes. Throws a clear error on
 *  anything else so the admin save surfaces why. */
export function parseUploadChunkMb(input: unknown): number {
  const n = typeof input === "string" ? Number(input.trim()) : input;
  if (typeof n !== "number" || !Number.isInteger(n) || n < UPLOAD_CHUNK_MB_MIN || n > UPLOAD_CHUNK_MB_MAX) {
    throw new Error(`upload chunk size must be a whole number of MB between ${UPLOAD_CHUNK_MB_MIN} and ${UPLOAD_CHUNK_MB_MAX}`);
  }
  return n * 1024 * 1024;
}

/** Coerce a stored value into valid chunk bytes, falling back to the default on anything
 *  malformed (non-integer, out of the MB bounds, or not a whole MB). */
function coerceUploadChunkBytes(value: unknown): number {
  const MB = 1024 * 1024;
  return typeof value === "number" && Number.isInteger(value) && value % MB === 0 && value >= UPLOAD_CHUNK_MB_MIN * MB && value <= UPLOAD_CHUNK_MB_MAX * MB
    ? value
    : DEFAULT_UPLOAD_CHUNK_BYTES;
}

/** Smart-polling cadence for chat (§24). An ascending, deduped list of integer seconds; `set[0]`
 *  is the floor (open-thread interval + the conversation-list backoff reset target). Default is a
 *  prime sequence so the polls rarely coincide with other periodic requests. */
export const DEFAULT_CHAT_POLL_INTERVALS = [7, 11, 17, 19, 29, 41, 53] as const;
const CHAT_POLL_MIN = 1;
const CHAT_POLL_MAX = 3600;
const CHAT_POLL_MAX_ENTRIES = 20;

/** Normalise an interval set (array of numbers, or a comma-separated string) into a clean, stored
 *  form: integer seconds in `[1, 3600]`, deduped, sorted ascending, 1..20 entries. Throws on any
 *  invalid token / empty input / out-of-bounds value so the admin save surfaces a clear error. */
export function parseChatPollIntervals(input: string | number[]): number[] {
  const tokens = Array.isArray(input) ? input.map((n) => String(n)) : input.split(",");
  const out: number[] = [];
  for (const raw of tokens) {
    const t = String(raw).trim();
    if (t === "") continue; // tolerate trailing/empty commas
    if (!/^\d+$/.test(t)) throw new Error(`"${t}" is not a whole number of seconds`);
    const n = Number(t);
    if (!Number.isInteger(n) || n < CHAT_POLL_MIN || n > CHAT_POLL_MAX) {
      throw new Error(`each interval must be a whole number of seconds between ${CHAT_POLL_MIN} and ${CHAT_POLL_MAX}`);
    }
    out.push(n);
  }
  const cleaned = [...new Set(out)].sort((a, b) => a - b);
  if (cleaned.length === 0) throw new Error("provide at least one interval");
  if (cleaned.length > CHAT_POLL_MAX_ENTRIES) throw new Error(`at most ${CHAT_POLL_MAX_ENTRIES} intervals`);
  return cleaned;
}

/** Coerce a stored value into a valid set, falling back to the default on anything malformed. */
function coerceChatPollIntervals(value: unknown): number[] {
  try {
    if (!Array.isArray(value)) return [...DEFAULT_CHAT_POLL_INTERVALS];
    return parseChatPollIntervals(value as number[]);
  } catch {
    return [...DEFAULT_CHAT_POLL_INTERVALS];
  }
}

/** How far ahead (calendar months) a user may set an install URL's expiry (§23). Global-admin
 *  setting; a positive integer in [MIN, MAX], default 12. "Never" is unbounded and separate. */
export const INSTALL_TTL_MONTHS_DEFAULT = 12;
export const INSTALL_TTL_MONTHS_MIN = 1;
export const INSTALL_TTL_MONTHS_MAX = 120;

/** Add `n` calendar months to `d`, clamping a day that overflows a shorter month (Jan 31 +1mo →
 *  Feb 28/29). Used by the install-expiry ceiling (server) — the picker mirrors it client-side. */
export function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  const day = r.getDate();
  r.setMonth(r.getMonth() + n);
  if (r.getDate() < day) r.setDate(0); // rolled into the next month → back up to the intended month's last day
  return r;
}

/** Latest allowable install-expiry instant: `now + months` calendar months, plus a 2-day grace so
 *  an end-of-day-in-user-tz pick exactly at the horizon isn't rejected. */
export function installExpiryCeiling(months: number, from: Date = new Date()): Date {
  return new Date(addMonths(from, months).getTime() + 2 * 86_400_000);
}

/** Coerce a stored value into a valid month count, falling back to the default on anything malformed. */
function coerceInstallTtlMonths(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= INSTALL_TTL_MONTHS_MIN && (value as number) <= INSTALL_TTL_MONTHS_MAX
    ? (value as number)
    : INSTALL_TTL_MONTHS_DEFAULT;
}

export interface PlatformSettings {
  /** true = any authenticated user may propose; false = only namespace members/admins (+ platform admins). */
  proposalsOpen: boolean;
  /** org-wide date/time display style. */
  dateFormat: DateFormat;
  /** what happens when a NEW-skill proposal duplicates an existing visible skill (§8). */
  duplicateEnforcement: DuplicateEnforcement;
  /** maximum allowed size (bytes) of an uploaded hosted-skill bundle (§6). */
  maxBundleBytes: number;
  /** chunked-upload chunk size (bytes) — bundles larger than this upload in pieces (§6). */
  uploadChunkBytes: number;
  /** chat smart-polling cadence — ascending seconds; set[0] is the floor (§24). */
  chatPollIntervals: number[];
  /** how far ahead (calendar months) a user may set an install URL's expiry (§23). */
  installMaxTtlMonths: number;
  /** max number of skills that may be Featured (homepage spotlight) at once (§7). */
  maxFeaturedSkills: number;
}

const DEFAULTS: PlatformSettings = { proposalsOpen: true, dateFormat: "eu", duplicateEnforcement: "block", maxBundleBytes: DEFAULT_MAX_BUNDLE_BYTES, uploadChunkBytes: DEFAULT_UPLOAD_CHUNK_BYTES, chatPollIntervals: [...DEFAULT_CHAT_POLL_INTERVALS], installMaxTtlMonths: INSTALL_TTL_MONTHS_DEFAULT, maxFeaturedSkills: coerceMaxFeatured(undefined) };

export async function getPlatformSettings(db: Pool = pool): Promise<PlatformSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(`select key, value from platform_settings`);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const open = map.get("proposals_open");
  const df = map.get("date_format");
  const dup = map.get("duplicate_proposal_enforcement");
  const mbb = map.get("max_bundle_bytes");
  return {
    proposalsOpen: typeof open === "boolean" ? open : DEFAULTS.proposalsOpen,
    dateFormat: df === "eu" || df === "us" ? df : DEFAULTS.dateFormat,
    duplicateEnforcement: dup === "block" || dup === "warn" ? dup : DEFAULTS.duplicateEnforcement,
    maxBundleBytes: (BUNDLE_SIZE_OPTIONS as readonly number[]).includes(mbb as number) ? (mbb as number) : DEFAULTS.maxBundleBytes,
    uploadChunkBytes: coerceUploadChunkBytes(map.get("upload_chunk_bytes")),
    chatPollIntervals: coerceChatPollIntervals(map.get("chat_poll_intervals")),
    installMaxTtlMonths: coerceInstallTtlMonths(map.get("install_max_ttl_months")),
    maxFeaturedSkills: coerceMaxFeatured(map.get("max_featured_skills")),
  };
}

export async function getMaxFeaturedSkills(db: Pool = pool): Promise<number> {
  return (await getPlatformSettings(db)).maxFeaturedSkills;
}

export async function getInstallMaxTtlMonths(db: Pool = pool): Promise<number> {
  return (await getPlatformSettings(db)).installMaxTtlMonths;
}

export async function getDuplicateEnforcement(db: Pool = pool): Promise<DuplicateEnforcement> {
  return (await getPlatformSettings(db)).duplicateEnforcement;
}

export async function getMaxBundleBytes(db: Pool = pool): Promise<number> {
  return (await getPlatformSettings(db)).maxBundleBytes;
}

export async function getUploadChunkBytes(db: Pool = pool): Promise<number> {
  return (await getPlatformSettings(db)).uploadChunkBytes;
}

export async function getProposalsOpen(db: Pool = pool): Promise<boolean> {
  return (await getPlatformSettings(db)).proposalsOpen;
}

/** A user's personal date-format override, or null when they follow the platform default. */
export async function getUserDateFormat(userId: string, db: Pool = pool): Promise<DateFormat | null> {
  const { rows } = await db.query<{ date_format: string | null }>(`select date_format from users where id = $1`, [userId]);
  const v = rows[0]?.date_format;
  return v === "eu" || v === "us" ? v : null;
}

/** Set (or clear, with null) the user's personal date-format override. Self-service — no audit. */
export async function setUserDateFormat(userId: string, format: DateFormat | null): Promise<void> {
  await pool.query(`update users set date_format = $2, updated_at = now() where id = $1`, [userId, format]);
}

/** Whether the user is hidden from the contributor leaderboard (profile preference). */
export async function getUserLeaderboardHidden(userId: string, db: Pool = pool): Promise<boolean> {
  const { rows } = await db.query<{ leaderboard_hidden: boolean }>(`select leaderboard_hidden from users where id = $1`, [userId]);
  return rows[0]?.leaderboard_hidden ?? false;
}

/** Show/hide the user on the leaderboard. Self-service — no audit. */
export async function setUserLeaderboardHidden(userId: string, hidden: boolean): Promise<void> {
  await pool.query(`update users set leaderboard_hidden = $2, updated_at = now() where id = $1`, [userId, hidden]);
}

/** The §12 email-channel opt-out: on = receive notification email (default), off = in-app
 *  only. Governs email as a channel — both transports respect it. Self-service — no audit. */
export async function setUserEmailNotifications(userId: string, enabled: boolean): Promise<void> {
  await pool.query(`update users set email_notifications = $2, updated_at = now() where id = $1`, [userId, enabled]);
}

/** The §12 per-type maintainer-notification opt-outs. Row-level, unlike the email toggle:
 *  the worker filters an opted-out user out of the recipient set at insert time, so no
 *  in-app row and no email exist at all. Self-service — no audit. */
export async function setUserDriftNotifications(userId: string, enabled: boolean): Promise<void> {
  await pool.query(`update users set drift_notifications = $2, updated_at = now() where id = $1`, [userId, enabled]);
}

export async function setUserNewVersionNotifications(userId: string, enabled: boolean): Promise<void> {
  await pool.query(`update users set new_version_notifications = $2, updated_at = now() where id = $1`, [userId, enabled]);
}

/** When the user last opened the Catalog / Review queue / System log / Requested skills — drives
 *  the nav badges. */
export interface NavSeen {
  catalogSeenAt: string;
  reviewSeenAt: string;
  systemLogSeenAt: string;
  requestsSeenAt: string;
}

export type NavSurface = "catalog" | "review" | "system-log" | "requests";

const NAV_SEEN_COL: Record<NavSurface, string> = {
  catalog: "catalog_seen_at",
  review: "review_seen_at",
  "system-log": "system_log_seen_at",
  requests: "requests_seen_at",
};

export async function getNavSeen(userId: string, db: Pool = pool): Promise<NavSeen> {
  const { rows } = await db.query<{ catalog_seen_at: string; review_seen_at: string; system_log_seen_at: string; requests_seen_at: string }>(
    `select catalog_seen_at, review_seen_at, system_log_seen_at, requests_seen_at from users where id = $1`,
    [userId],
  );
  const r = rows[0];
  // Fall back to epoch if somehow absent so a missing row never hides genuinely new items.
  return {
    catalogSeenAt: r?.catalog_seen_at ?? "1970-01-01T00:00:00Z",
    reviewSeenAt: r?.review_seen_at ?? "1970-01-01T00:00:00Z",
    systemLogSeenAt: r?.system_log_seen_at ?? "1970-01-01T00:00:00Z",
    requestsSeenAt: r?.requests_seen_at ?? "1970-01-01T00:00:00Z",
  };
}

/** Mark a nav surface as just-viewed (clears its badge). Self-service — no audit. */
export async function markNavSeen(userId: string, surface: NavSurface): Promise<void> {
  await pool.query(`update users set ${NAV_SEEN_COL[surface]} = now(), updated_at = now() where id = $1`, [userId]);
}

export async function setDateFormat(format: DateFormat, actorUserId: string): Promise<void> {
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ('date_format', $1::jsonb, $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(format), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "settings.updated",
    targetType: "platform_settings",
    targetId: "date_format",
    after: { dateFormat: format },
  });
}

export async function setMaxBundleBytes(bytes: number, actorUserId: string): Promise<void> {
  if (!(BUNDLE_SIZE_OPTIONS as readonly number[]).includes(bytes)) throw new Error("invalid bundle size");
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ('max_bundle_bytes', $1::jsonb, $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(bytes), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "settings.updated",
    targetType: "platform_settings",
    targetId: "max_bundle_bytes",
    after: { maxBundleBytes: bytes },
  });
}

/** Set the chunked-upload chunk size from an admin-entered whole number of MB (1–50). Throws on
 *  invalid input (surfaced by the admin save); stores bytes. Audited. §6. */
export async function setUploadChunkMb(mbInput: unknown, actorUserId: string): Promise<number> {
  const bytes = parseUploadChunkMb(mbInput); // throws on invalid input
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ('upload_chunk_bytes', $1::jsonb, $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(bytes), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "settings.updated",
    targetType: "platform_settings",
    targetId: "upload_chunk_bytes",
    after: { uploadChunkBytes: bytes },
  });
  return bytes;
}

export async function setInstallMaxTtlMonths(months: number, actorUserId: string): Promise<void> {
  if (!Number.isInteger(months) || months < INSTALL_TTL_MONTHS_MIN || months > INSTALL_TTL_MONTHS_MAX) {
    throw new Error(`install URL expiry must be a whole number of months between ${INSTALL_TTL_MONTHS_MIN} and ${INSTALL_TTL_MONTHS_MAX}`);
  }
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ('install_max_ttl_months', $1::jsonb, $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(months), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "settings.updated",
    targetType: "platform_settings",
    targetId: "install_max_ttl_months",
    after: { installMaxTtlMonths: months },
  });
}

/** Set the Featured-skills homepage cap (§7). Platform-admin action; validated + audited. Lowering
 *  it never evicts skills already Featured — it only blocks new spotlights until the count drops. */
export async function setMaxFeaturedSkills(count: number, actorUserId: string): Promise<void> {
  assertMaxFeatured(count); // throws on out-of-range / non-integer
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ('max_featured_skills', $1::jsonb, $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(count), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "settings.updated",
    targetType: "platform_settings",
    targetId: "max_featured_skills",
    after: { maxFeaturedSkills: count },
  });
}

export async function setDuplicateEnforcement(mode: DuplicateEnforcement, actorUserId: string): Promise<void> {
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ('duplicate_proposal_enforcement', $1::jsonb, $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(mode), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "settings.updated",
    targetType: "platform_settings",
    targetId: "duplicate_proposal_enforcement",
    after: { duplicateEnforcement: mode },
  });
}

export async function setChatPollIntervals(input: string | number[], actorUserId: string): Promise<number[]> {
  const intervals = parseChatPollIntervals(input); // throws on invalid input
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ('chat_poll_intervals', $1::jsonb, $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(intervals), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "settings.updated",
    targetType: "platform_settings",
    targetId: "chat_poll_intervals",
    after: { chatPollIntervals: intervals },
  });
  return intervals;
}

// ── "Skills you might like" rebuild job (§10) ──────────────────────────────────────────────────
// The batch recompute lives in the worker; the web tier only signals it (sets a request flag) and
// reads the status the worker writes back. Three platform_settings keys: the request signal
// (`related_rebuild_requested_at`, JSON null when idle) and the worker's last-run stamps
// (`related_last_run_at`, `related_last_run_count`).
export interface RelatedJobStatus {
  lastRunAt: string | null;
  lastRunCount: number | null;
  /** A rebuild has been requested and the worker hasn't cleared it yet (queued or running). */
  running: boolean;
}

export async function getRelatedJobStatus(db: Pool = pool): Promise<RelatedJobStatus> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `select key, value from platform_settings
      where key in ('related_last_run_at', 'related_last_run_count', 'related_rebuild_requested_at')`,
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const lastRunAt = map.get("related_last_run_at");
  const lastRunCount = map.get("related_last_run_count");
  const requested = map.get("related_rebuild_requested_at"); // JSON string when pending, JSON null when idle
  return {
    lastRunAt: typeof lastRunAt === "string" ? lastRunAt : null,
    lastRunCount: typeof lastRunCount === "number" ? lastRunCount : null,
    running: requested != null,
  };
}

/** Signal the worker to rebuild the related-skills index (platform-admin action; audited). */
export async function requestRelatedRebuild(actorUserId: string): Promise<void> {
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ('related_rebuild_requested_at', to_jsonb(now()::text), $1, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "job.related_rebuild_requested",
    targetType: "job",
    targetId: "related_skills",
  });
}

// ── System banner (§27) ─────────────────────────────────────────────────────────────────────────
// A single, platform-wide, ephemeral header announcement. Stored as one more platform_settings key
// (not a dedicated table) — same singleton-row convention as every other setting above. Deliberately
// separate from `messages`/`conversations`/`notifications`: it never creates a notification row,
// never triggers email, and is never rendered in the messages menu.
export const SYSTEM_BANNER_MAX_LEN = 100;
// Whole-hour spans: 1h/4h/8h, 1d=24h, 1w=168h (7d), 1m=720h (a fixed 30-day span, not a calendar month).
export const SYSTEM_BANNER_DURATIONS_HOURS = [1, 4, 8, 24, 168, 720] as const;

export interface SystemBanner {
  message: string;
  expiresAt: string;
}

/** The active header banner, or null if none is set or it has lazily expired. There is no worker
 *  sweep — the row can linger in the DB past its expiry until the next Save/Clear overwrites it;
 *  every reader (this function) treats a past `expiresAt` as "no active banner". */
export async function getSystemBanner(db: Pool = pool): Promise<SystemBanner | null> {
  const { rows } = await db.query<{ value: { message?: unknown; expiresAt?: unknown } }>(
    `select value from platform_settings where key = 'system_banner'`,
  );
  const v = rows[0]?.value;
  if (!v || typeof v.message !== "string" || typeof v.expiresAt !== "string") return null;
  if (new Date(v.expiresAt).getTime() <= Date.now()) return null;
  return { message: v.message, expiresAt: v.expiresAt };
}

/** Set (or replace) the header banner. Platform-admin only — enforced by the caller. Every save is
 *  an unconditional upsert: the message and the newly-picked duration always replace whatever was
 *  previously active, and the countdown always restarts from now, regardless of whether the new
 *  duration is longer or shorter than whatever time was left. Audited. */
export async function setSystemBanner(message: string, durationHours: number, actorUserId: string): Promise<SystemBanner> {
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > SYSTEM_BANNER_MAX_LEN) {
    throw new Error(`message must be 1-${SYSTEM_BANNER_MAX_LEN} characters`);
  }
  if (!(SYSTEM_BANNER_DURATIONS_HOURS as readonly number[]).includes(durationHours)) {
    throw new Error(`duration must be one of ${SYSTEM_BANNER_DURATIONS_HOURS.join(", ")} hours`);
  }
  const expiresAt = new Date(Date.now() + durationHours * 3_600_000).toISOString();
  const value: SystemBanner = { message: trimmed, expiresAt };
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ('system_banner', $1::jsonb, $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(value), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "system_banner.set",
    targetType: "platform_settings",
    targetId: "system_banner",
    after: { message: trimmed, durationHours, expiresAt },
  });
  return value;
}

/** Clear the header banner immediately, before natural expiry. Platform-admin only — enforced by
 *  the caller. Audited with whatever was active (if anything) at clear time. */
export async function clearSystemBanner(actorUserId: string): Promise<void> {
  const { rows } = await pool.query<{ value: unknown }>(
    `delete from platform_settings where key = 'system_banner' returning value`,
  );
  await appendAudit(pool, {
    actorUserId,
    action: "system_banner.cleared",
    targetType: "platform_settings",
    targetId: "system_banner",
    before: rows[0]?.value ?? null,
  });
}

export async function setProposalsOpen(open: boolean, actorUserId: string): Promise<void> {
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ('proposals_open', $1::jsonb, $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(open), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "settings.updated",
    targetType: "platform_settings",
    targetId: "proposals_open",
    after: { proposalsOpen: open },
  });
}
