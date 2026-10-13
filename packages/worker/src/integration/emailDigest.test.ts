// Live-DB integration test for §48 email digests: deferral in the delivery sweep, and the digest
// sweep's first sight, send, re-checks, switch-out, kill switch, transport failures and the
// coalesced discussion row. Gated behind SKILLY_DB_E2E=1; requires a migrated Postgres at
// DATABASE_URL (migration 0093 included).
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://... node --test dist/integration/emailDigest.test.js
//
// Settings are passed to the sweeps directly — the test never writes platform_settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DIGEST_SETTINGS, type DigestSettings } from "@skilly/shared";
import { GraphSendError } from "@skilly/shared/email";
import { deliverPendingNotifications, type EmailTransport, type RenderedNotification } from "../notify/deliver.js";
import { runDigestSweep } from "../notify/digest.js";

const enabled = process.env.SKILLY_DB_E2E === "1";
const SETTINGS: DigestSettings = { ...DEFAULT_DIGEST_SETTINGS, types: [...DEFAULT_DIGEST_SETTINGS.types] };
const BASE = "https://skilly.test";

function capture(to: string): EmailTransport & { mine: RenderedNotification[] } {
  const mine: RenderedNotification[] = [];
  return { kind: "graph", mine, send: async (addr, msg) => { if (addr === to) mine.push(msg); } };
}

test("§48: deferral, then the digest sweep end to end", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const K = `dig${Date.now().toString(36)}`;
  const userIds: string[] = [];
  const nsIds: string[] = [];
  try {
    const q = <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) => pool.query<T>(text, values);
    const mkUser = async (key: string, digest: string | null) => {
      const id = (await q<{ id: string }>(
        `insert into users (entra_object_id, email, display_name, email_digest) values ($1, $2, $1, $3) returning id`,
        [`${K}-${key}`, `${K}-${key}@org.test`, digest],
      )).rows[0]!.id;
      userIds.push(id);
      return id;
    };
    const mkNs = async (s: string) => {
      const id = (await q<{ id: string }>(`insert into namespaces (slug, display_name, require_review) values ($1, $1, false) returning id`, [`${K}-${s}`])).rows[0]!.id;
      nsIds.push(id);
      return id;
    };
    const mkSkill = async (ns: string, slug: string, visibility: "org" | "namespace") =>
      (await q(`insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
                values ($1, $2, $2, 'd', 'generic', 'hosted', $3)`, [ns, slug, visibility]));
    const notify = async (user: string, type: string, payload: Record<string, unknown>, extra: { state?: string | null; read?: boolean; old?: boolean } = {}) =>
      (await q<{ id: string }>(
        `insert into notifications (user_id, type, payload, digest_state, read_at, delivered_at, created_at)
         values ($1, $2, $3::jsonb, $4, case when $5 then now() end, case when $4::text is null then null else now() end,
                 case when $6 then timestamptz '2000-01-01' else now() end)
         returning id`,
        [user, type, JSON.stringify(payload), extra.state ?? null, extra.read === true, extra.old === true],
      )).rows[0]!.id;
    const state = async (id: string) => (await q<{ digest_state: string | null }>(`select digest_state from notifications where id = $1`, [id])).rows[0]!.digest_state;
    const userRow = async (id: string) =>
      (await q<{ email_digest: string | null; last: Date | null; failures: number }>(
        `select email_digest, email_digest_last_run_at as last, email_digest_failures as failures from users where id = $1`, [id],
      )).rows[0]!;
    const setLast = (id: string, iso: string | null, failures = 0) =>
      q(`update users set email_digest_last_run_at = $2, email_digest_failures = $3 where id = $1`, [id, iso, failures]);

    const nsA = await mkNs("a");
    const nsB = await mkNs("b");
    await mkSkill(nsA, `${K}-open`, "org");
    await mkSkill(nsB, `${K}-secret`, "namespace");
    const open = { namespaceSlug: `${K}-a`, skillSlug: `${K}-open` };
    const secret = { namespaceSlug: `${K}-b`, skillSlug: `${K}-secret` };

    const u = await mkUser("u", "daily");
    const perUpdate = await mkUser("v", "immediate");
    const followee = await mkUser("f", null);
    const uEmail = `${K}-u@org.test`;

    // ── Deferral (§48.5): only digestible types, only for digest-mode recipients ──
    const dA = await notify(u, "skill.new_version", { ...open, semver: "1.0.0" }, { old: true });
    const dB = await notify(u, "message.new", { conversationId: "c" }, { old: true });
    const dC = await notify(perUpdate, "skill.new_version", { ...open, semver: "1.0.0" }, { old: true });
    const dD = await notify(u, "follow.new_skill", { ...open, actorId: followee, actorName: "Fay" }, { old: true });
    await deliverPendingNotifications(pool, {}, SETTINGS);
    assert.equal(await state(dA), "pending");
    assert.equal(await state(dB), null, "the floor is never deferred");
    assert.equal(await state(dC), null, "a per-update user is never deferred");
    assert.equal(await state(dD), "pending", "follow.* waits for the digest");

    // ── First sight stamps without sending ──
    const T1 = new Date("2026-10-13T09:00:00Z");
    let mail = capture(uEmail);
    await runDigestSweep(pool, { email: mail, settings: SETTINGS, now: T1, baseUrl: BASE });
    assert.equal(mail.mine.length, 0);
    assert.equal((await userRow(u)).last?.toISOString(), "2026-10-13T08:00:00.000Z");
    assert.equal(await state(dA), "pending");

    // ── Not due again before the next slot ──
    await runDigestSweep(pool, { email: mail, settings: SETTINGS, now: new Date("2026-10-14T07:59:00Z"), baseUrl: BASE });
    assert.equal(mail.mine.length, 0);

    // ── Due: one digest; read and invisible rows dropped; an erased actor reads "Deleted User" ──
    const read = await notify(u, "skill.marked_official", open, { state: "pending", read: true });
    const hidden = await notify(u, "skill.new_version", { ...secret, semver: "2.0.0" }, { state: "pending" });
    await q(`update users set erased_at = now() where id = $1`, [followee]);
    const T2 = new Date("2026-10-14T09:00:00Z");
    await runDigestSweep(pool, { email: mail, settings: SETTINGS, now: T2, baseUrl: BASE });
    assert.equal(mail.mine.length, 1, "exactly one digest");
    const sent = mail.mine[0]!;
    assert.equal(sent.subject, "Skilly - Daily digest");
    assert.match(sent.text, /2 updates/);
    assert.match(sent.text, new RegExp(`\\[${K}-a/${K}-open\\]\\(${BASE}/skills/${K}-a/${K}-open\\) · new version v1\\.0\\.0`));
    assert.match(sent.text, /- Deleted User · \[published /);
    assert.ok(!sent.text.includes(`${K}-secret`), "a skill the user can no longer see never appears");
    assert.match(sent.htmlBody ?? "", /<strong>Skills<\/strong>/);
    assert.equal(await state(dA), "sent");
    assert.equal(await state(dD), "sent");
    assert.equal(await state(read), "dropped");
    assert.equal(await state(hidden), "dropped");
    assert.equal((await userRow(u)).last?.toISOString(), "2026-10-14T08:00:00.000Z");

    // ── Missed slots → one digest; empty → stamped, no email ──
    await setLast(u, "2026-10-01T08:00:00Z");
    const late = await notify(u, "skill.new_version", { ...open, semver: "1.1.0" }, { state: "pending" });
    mail = capture(uEmail);
    await runDigestSweep(pool, { email: mail, settings: SETTINGS, now: T2, baseUrl: BASE });
    assert.equal(mail.mine.length, 1);
    assert.equal(await state(late), "sent");
    await setLast(u, "2026-10-13T08:00:00Z");
    await runDigestSweep(pool, { email: mail, settings: SETTINGS, now: T2, baseUrl: BASE });
    assert.equal(mail.mine.length, 1, "nothing pending → no email");
    assert.equal((await userRow(u)).last?.toISOString(), "2026-10-14T08:00:00.000Z", "the slot is stamped either way");

    // ── No transport at the slot: dropped, stamped, nothing queued ──
    await setLast(u, "2026-10-13T08:00:00Z");
    const noTransport = await notify(u, "skill.new_version", { ...open, semver: "1.2.0" }, { state: "pending" });
    await runDigestSweep(pool, { email: undefined, settings: SETTINGS, now: T2, baseUrl: BASE });
    assert.equal(await state(noTransport), "dropped");
    assert.equal((await userRow(u)).last?.toISOString(), "2026-10-14T08:00:00.000Z");

    // ── Transient failure: retried, then given up after the max attempts ──
    await setLast(u, "2026-10-13T08:00:00Z");
    const flaky = await notify(u, "skill.new_version", { ...open, semver: "1.3.0" }, { state: "pending" });
    const failing: EmailTransport = { kind: "smtp", send: async (to) => { if (to === uEmail) throw new Error("connection refused"); } };
    await runDigestSweep(pool, { email: failing, settings: SETTINGS, now: T2, baseUrl: BASE });
    assert.equal(await state(flaky), "pending");
    assert.equal((await userRow(u)).failures, 1);
    assert.equal((await userRow(u)).last?.toISOString(), "2026-10-13T08:00:00.000Z", "not stamped");
    const max = Number(process.env.NOTIFY_MAX_ATTEMPTS ?? 5);
    await setLast(u, "2026-10-13T08:00:00Z", max - 1);
    await runDigestSweep(pool, { email: failing, settings: SETTINGS, now: T2, baseUrl: BASE });
    assert.equal(await state(flaky), "dropped");
    assert.equal((await userRow(u)).failures, 0);
    assert.equal((await userRow(u)).last?.toISOString(), "2026-10-14T08:00:00.000Z");

    // ── Graph 429: no attempt consumed, not stamped, Retry-After returned ──
    await setLast(u, "2026-10-13T08:00:00Z");
    const throttled = await notify(u, "skill.new_version", { ...open, semver: "1.4.0" }, { state: "pending" });
    const throttling: EmailTransport = { kind: "graph", send: async (to) => { if (to === uEmail) throw new GraphSendError(429, "graph sendMail failed: 429", 42); } };
    const r429 = await runDigestSweep(pool, { email: throttling, settings: SETTINGS, now: T2, baseUrl: BASE });
    assert.equal(r429.retryAfterSeconds, 42);
    assert.equal(await state(throttled), "pending");
    assert.equal((await userRow(u)).failures, 0);
    assert.equal((await userRow(u)).last?.toISOString(), "2026-10-13T08:00:00.000Z");

    // ── Leaving digest mode is forward-only: pending → dropped, nothing emailed ──
    await q(`update users set email_digest = 'immediate' where id = $1`, [u]);
    mail = capture(uEmail);
    await runDigestSweep(pool, { email: mail, settings: SETTINGS, now: T2, baseUrl: BASE });
    assert.equal(await state(throttled), "dropped");
    assert.equal(mail.mine.length, 0);

    // ── Kill switch: drops pending rows, keeps the user's choice ──
    await q(`update users set email_digest = 'weekly' where id = $1`, [u]);
    const killed = await notify(u, "skill.new_version", { ...open, semver: "1.5.0" }, { state: "pending" });
    await runDigestSweep(pool, { email: mail, settings: { ...SETTINGS, enabled: false }, now: T2, baseUrl: BASE });
    assert.equal(await state(killed), "dropped");
    assert.equal((await userRow(u)).email_digest, "weekly", "the saved choice is dormant, not erased");

    // ── The coalesced discussion row keeps its digest bookkeeping through the in-place refresh ──
    const conv = `${K}-conv`;
    const upsert = (fromName: string) =>
      q(`insert into notifications (user_id, type, payload)
         values ($1, 'skill.discussion', $2::jsonb)
         on conflict (user_id, (payload->>'conversationId')) where type = 'skill.discussion' and read_at is null
         do update set payload = excluded.payload, created_at = now()`,
        [u, JSON.stringify({ conversationId: conv, ...open, fromName })]);
    await upsert("Ann");
    const disc = (await q<{ id: string }>(`select id from notifications where user_id = $1 and payload->>'conversationId' = $2`, [u, conv])).rows[0]!.id;
    await q(`update notifications set delivered_at = now(), digest_state = 'pending' where id = $1`, [disc]);
    await upsert("Bea");
    assert.equal(await state(disc), "pending", "the refresh preserves digest_state");
    await setLast(u, "2026-10-01T08:00:00Z");
    mail = capture(uEmail);
    await runDigestSweep(pool, { email: mail, settings: SETTINGS, now: T2, baseUrl: BASE });
    assert.equal(mail.mine.length, 1);
    assert.match(mail.mine[0]!.text, /new comments \(latest from Bea\)/, "the latest payload rides into the digest");
    assert.equal(await state(disc), "sent");
    await upsert("Cid");
    const after = (await q<{ digest_state: string; delivered: boolean }>(
      `select digest_state, delivered_at is not null as delivered from notifications where id = $1`, [disc],
    )).rows[0]!;
    assert.deepEqual(after, { digest_state: "sent", delivered: true }, "never emailed again until read");
  } finally {
    await pool.query(`delete from notifications where user_id = any($1::uuid[])`, [userIds]).catch(() => {});
    await pool.query(`delete from skills where namespace_id = any($1::uuid[])`, [nsIds]).catch(() => {});
    await pool.query(`delete from namespaces where id = any($1::uuid[])`, [nsIds]).catch(() => {});
    await pool.query(`delete from users where id = any($1::uuid[])`, [userIds]).catch(() => {});
    await pool.end();
  }
});
