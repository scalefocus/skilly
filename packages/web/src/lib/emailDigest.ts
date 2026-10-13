// Email digests on the web tier (SKILLY_SPEC.md §48.10–§48.12): the user's frequency choice
// (PATCH /api/me) and the five platform settings (PATCH /api/admin/settings). The tiers, defaults
// and validation live in @skilly/shared/email-digest, which the worker reads too.
import type { Pool } from "pg";
import {
  coerceDigestSettings,
  DIGEST_SETTING_KEYS,
  DigestSettingError,
  isDigestMode,
  parseDigestHour,
  parseDigestMode,
  parseDigestTypes,
  parseDigestWeekday,
  type DigestSettings,
} from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";

/** The five §48.2 keys, defaults applied. */
export async function getDigestSettings(db: Pool = pool): Promise<DigestSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `select key, value from platform_settings where key = any($1::text[])`,
    [Object.values(DIGEST_SETTING_KEYS)],
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return coerceDigestSettings((k) => map.get(k));
}

export type DigestResult = { ok: true } | { ok: false; status: 400 | 403 | 422; error: string };

/**
 * §48.10 the user's "Email frequency": `null` (organization default) or a mode; anything else is a
 * 400. Silent (a profile preference, never audited). A CHANGED value resets the slot stamp to first
 * sight — so switching into digest mode never fires a near-empty digest at once — and the failure
 * counter. Accepted while the kill switch is off: the choice is stored, dormant.
 */
export async function setUserEmailDigest(userId: string, raw: unknown, db: Pool = pool): Promise<DigestResult> {
  if (raw !== null && !isDigestMode(raw)) return { ok: false, status: 400, error: "emailDigest must be null, 'immediate', 'daily' or 'weekly'" };
  await db.query(
    `update users
        set email_digest = $2::text,
            email_digest_last_run_at = case when email_digest is distinct from $2::text then null else email_digest_last_run_at end,
            email_digest_failures = case when email_digest is distinct from $2::text then 0 else email_digest_failures end,
            updated_at = now()
      where id = $1`,
    [userId, raw],
  );
  return { ok: true };
}

/** The admin API's field for each setting (the GET /api/admin/settings shape). */
const FIELDS = {
  enabled: "emailDigestsEnabled",
  defaultMode: "emailDigestDefaultMode",
  hour: "emailDigestHour",
  weekday: "emailDigestWeekday",
  types: "emailDigestTypes",
} as const satisfies Record<keyof DigestSettings, string>;

/** Does a PATCH body touch any digest setting? */
export function hasDigestSettings(body: Record<string, unknown>): boolean {
  return Object.values(FIELDS).some((f) => body[f] !== undefined);
}

/**
 * §48.11 / §48.12 save the digest settings in a PATCH body. Platform admin only (403 otherwise,
 * re-verified here). Every present field is validated BEFORE anything is written (422 on the first
 * bad one), then each CHANGED key is written and audited as `settings.updated` (before → after).
 */
export async function updateDigestSettings(
  access: { userId: string | null; isPlatformAdmin: boolean } | null,
  body: Record<string, unknown>,
  db: Pool = pool,
): Promise<DigestResult> {
  if (!access?.userId || !access.isPlatformAdmin) return { ok: false, status: 403, error: "platform admin required" };
  const next: Partial<DigestSettings> = {};
  try {
    const v = (f: string) => body[f];
    if (v(FIELDS.enabled) !== undefined) {
      if (typeof v(FIELDS.enabled) !== "boolean") throw new DigestSettingError("emailDigestsEnabled must be true or false");
      next.enabled = v(FIELDS.enabled) as boolean;
    }
    if (v(FIELDS.defaultMode) !== undefined) next.defaultMode = parseDigestMode(v(FIELDS.defaultMode));
    if (v(FIELDS.hour) !== undefined) next.hour = parseDigestHour(v(FIELDS.hour));
    if (v(FIELDS.weekday) !== undefined) next.weekday = parseDigestWeekday(v(FIELDS.weekday));
    if (v(FIELDS.types) !== undefined) next.types = parseDigestTypes(v(FIELDS.types));
  } catch (e) {
    if (e instanceof DigestSettingError) return { ok: false, status: 422, error: e.message };
    throw e;
  }

  const before = await getDigestSettings(db);
  for (const k of Object.keys(next) as (keyof DigestSettings)[]) {
    const after = next[k]!;
    if (JSON.stringify(after) === JSON.stringify(before[k])) continue;
    const key = DIGEST_SETTING_KEYS[k];
    await db.query(
      `insert into platform_settings (key, value, updated_by, updated_at)
       values ($1, $2::jsonb, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [key, JSON.stringify(after), access.userId],
    );
    await appendAudit(db, {
      actorUserId: access.userId,
      action: "settings.updated",
      targetType: "platform_settings",
      targetId: key,
      before: { [FIELDS[k]]: before[k] },
      after: { [FIELDS[k]]: after },
    });
  }
  return { ok: true };
}
