// Live-DB integration test for Try a skill before installing (SKILLY_SPEC.md §61.13). Gated behind
// SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL. The provider is a local HTTP stub
// speaking the Anthropic Messages shape; object storage is stood in for through the lib's deps.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… node --import tsx --test src/lib/aiTry.dbtest.ts
//
// Covers: tryAvailability across the switch, AI off / Failing / undecryptable, an archived skill and
// no installable version; GET context (latest resolution, a prerelease by name, 404 for yanked,
// quarantined and unpublished versions and for a restricted skill the caller can't see, 409 when
// not effective, usage/model/content check/file states); POST (one ai_usage row for the caller, no
// audit row, the exact §61.5 egress), the transcript 422s, the per-minute and daily 429s, 502
// without provider text in one attempt, an empty reply, a version yanked mid-conversation; the
// switch (audited, unchanged = no-op, survives Remove integration). And the §40.18 limits: `limits`
// and `daily` on GET and on every POST from the daily-cap check onward (a failed reply still lowers
// the allowance; the per-minute 429 carries neither); the admin save (422 naming the field, no-op
// when unchanged, only overrides stored, audited, works without the key, survives Remove
// integration, null restores the defaults and deletes the row, a hand-edited row is clamped); and
// each limit taking effect on the next message — a lowered and a raised daily cap, the per-minute
// number, messages per conversation and a lowered per-message limit.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import AdmZip from "adm-zip";
import type { EffectiveAccess } from "@skilly/shared";
import { withAiIntegrationLock } from "./aiTestLock";

// The stub provider listens on loopback, which §49.11 refuses by default: opt in exactly as an
// operator with an on-network provider would (the check reads the env per call).
process.env.AI_ALLOW_PRIVATE_BASE_URL = "1";

const enabled = process.env.SKILLY_DB_E2E === "1";
const GOOD = "sk-dbtest-try-token-7781";
const AI_KEY_B64 = Buffer.alloc(32, 11).toString("base64");
const OTHER_KEY_B64 = Buffer.alloc(32, 12).toString("base64");
const K = `atry${Date.now().toString(36)}`;

type Mode = "ok" | "500" | "empty";
interface StubState { mode: Mode; hits: number; bodies: string[] }

function startStub(): Promise<{ server: Server; url: string; state: StubState }> {
  const state: StubState = { mode: "ok", hits: 0, bodies: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url !== "/v1/messages" || req.headers["x-api-key"] !== GOOD) {
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      state.hits++;
      state.bodies.push(body);
      if (state.mode === "500") {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: "stub overloaded secret-detail" } }));
        return;
      }
      const text = state.mode === "empty" ? "   " : "I would run `scripts/review.sh contract.pdf` and expect a list of risky clauses.";
      res.end(JSON.stringify({ model: "stub-model", content: [{ type: "text", text }], usage: { input_tokens: 40, output_tokens: 12 } }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state })),
  );
}

function zipOf(files: Record<string, string>): Buffer {
  const z = new AdmZip();
  for (const [p, c] of Object.entries(files)) z.addFile(p, Buffer.from(c));
  return z.toBuffer();
}

const BUNDLE = zipOf({
  "SKILL.md": "---\nname: contract-review\ndescription: Use when the user asks to review a PDF contract.\n---\n# Contract review\n\naws_secret_access_key = AKIAIOSFODNN7EXAMPLE\n\n1. Run scripts/review.sh.\n",
  "scripts/review.sh": "#!/bin/sh\necho SCRIPT_BODY_MARKER\n",
  "references/clauses.md": "REFERENCE_BODY_MARKER indemnity\n",
  "assets/notes.txt": "ASSET_BODY_MARKER\n",
});

after(async () => {
  if (enabled) {
    const { pool } = await import("./db");
    await pool.end();
  }
});

test("§61 Try a skill: availability, context, egress, failures, limits and the switch", { skip: !enabled }, () => withAiIntegrationLock(async () => {
  process.env.AI_TOKEN_ENC_KEY = AI_KEY_B64;
  const { pool } = await import("./db");
  const { tryAvailability, tryContext, trySend } = await import("./aiTry");
  const ai = await import("./ai");
  const { setAiTryEnabled, invalidatePlatformSettings } = await import("./settings");
  const { encryptAiToken, parseAiTokenKey } = await import("@skilly/shared/ai");
  const stub = await startStub();

  const started = new Date();
  const savedAi = (await pool.query(`select * from ai_integration where id = 1`)).rows[0] ?? null;
  const savedSwitch = (await pool.query(`select value from platform_settings where key = 'ai_try_enabled'`)).rows[0]?.value ?? null;
  // §40.18: the limits are a platform setting — the test starts from the defaults and puts any stored value back.
  const LIMITS = "ai_try_limits";
  const storedLimits = async () => (await pool.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [LIMITS])).rows[0]?.value;
  const savedLimits = await storedLimits();
  const DEFAULT_PANEL = { maxTurns: 20, maxMessageChars: 4000, maxTranscriptChars: 200_000 };
  type Daily = { cap: number; remaining: number; retryAt: string | null };
  // A fixed actor: the switch writes audit rows, which are append-only — never delete it.
  const admin = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ('aitry-admin', 'aitry-admin@org', 'aitry-admin')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
  )).rows[0]!.id;
  const userIds: string[] = [];
  const skillIds: string[] = [];
  const mkUser = async (key: string) => {
    const id = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ($1, $2, $1) returning id`,
      [`${K}-${key}`, `${K}-${key}@org`],
    )).rows[0]!.id;
    userIds.push(id);
    return id;
  };
  const who = (userId: string, roles: [string, "namespace_member"][] = []): EffectiveAccess & { userId: string } =>
    ({ isPlatformAdmin: false, namespaceRoles: new Map(roles), userId });
  const usageRows = async (userId: string) =>
    (await pool.query<{ ok: boolean; error_code: string | null }>(`select ok, error_code from ai_usage where feature = 'skill_try' and user_id = $1 order by id`, [userId])).rows;
  const store = new Map<string, Buffer>();
  const deps = { getArtifact: async (k: string) => store.get(k) ?? Promise.reject(new Error("missing")) };
  const auditCount = async () =>
    Number((await pool.query<{ n: string }>(`select count(*)::text as n from audit_log where action = 'settings.updated' and target_id = 'ai_try_enabled' and created_at >= $1`, [started])).rows[0]!.n);
  const operational = async () => {
    await pool.query(`delete from ai_integration`);
    await pool.query(
      `insert into ai_integration (id, enabled, provider, base_url, model, token_enc, token_last4, last_test_at, last_test_ok)
       values (1, true, 'anthropic', $1, 'stub-model', $2, '7781', now(), true)`,
      [stub.url, encryptAiToken(GOOD, parseAiTokenKey(AI_KEY_B64)!)],
    );
  };
  const msgs = (q = "Review this contract") => [{ role: "user", content: q }];

  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('aitry-ns', 'aitry-ns', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const author = await mkUser("author");
  const mkSkill = async (slug: string, visibility: "org" | "namespace", status: "active" | "archived" = "active") => {
    const id = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1, $2, $2, 'd', 'generic', 'hosted', $3, $4) returning id`,
      [ns, slug, visibility, status],
    )).rows[0]!.id;
    skillIds.push(id);
    return id;
  };
  const mkVersion = async (skillId: string, semver: string, o: { status?: string; published?: boolean; usage?: string | null } = {}) => {
    const key = `${K}/${skillId}/${semver}.skill`;
    store.set(key, BUNDLE);
    await pool.query(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published, usage_examples)
       values ($1, $2, $3, $4, $5, 'sha', $6, $7, $8)`,
      [skillId, semver, semver.includes("-"), o.status ?? "active", key, author, o.published ?? true, o.usage ?? null],
    );
  };

  try {
    await pool.query(`delete from platform_settings where key = $1`, [LIMITS]);
    const orgSkill = await mkSkill(`${K}-org`, "org");
    await mkVersion(orgSkill, "1.0.0", { usage: "Ask it to **review this contract**." });
    await mkVersion(orgSkill, "1.1.0-beta.1");
    await mkVersion(orgSkill, "0.9.0", { status: "yanked" });
    await mkVersion(orgSkill, "0.8.0", { status: "quarantined" });
    await mkVersion(orgSkill, "2.0.0", { published: false });
    const restricted = await mkSkill(`${K}-secret`, "namespace");
    await mkVersion(restricted, "1.0.0");
    const archived = await mkSkill(`${K}-old`, "org", "archived");
    await mkVersion(archived, "1.0.0");
    const u1 = await mkUser("u1");
    const orgSlug = `${K}-org`;

    // ── Availability: switch off, AI off, then both on; Failing and undecryptable hide it ───
    await pool.query(`delete from ai_integration`);
    await setAiTryEnabled(false, admin);
    const live = { archived: false, latestInstallable: "1.0.0" };
    assert.equal(await tryAvailability(live), false, "switch off");
    await setAiTryEnabled(true, admin);
    assert.equal(await tryAvailability(live), false, "AI not configured");
    await operational();
    assert.equal(await tryAvailability(live), true, "switch on + Operational");
    assert.equal(await tryAvailability({ archived: true, latestInstallable: "1.0.0" }), false, "archived");
    assert.equal(await tryAvailability({ archived: false, latestInstallable: null }), false, "nothing installable");
    await pool.query(`update ai_integration set last_call_at = now(), last_call_ok = false, last_call_error = 'ai_timeout: x'`);
    assert.equal(await tryAvailability(live), false, "§61.1 #1: Failing hides Try");
    const failingGet = await tryContext(who(u1), "aitry-ns", orgSlug, null, deps);
    assert.equal(failingGet.status, 409);
    assert.equal(failingGet.body.error, "try_unavailable");
    await operational();
    process.env.AI_TOKEN_ENC_KEY = OTHER_KEY_B64;
    assert.equal(await tryAvailability(live), false, "token can't be decrypted");
    process.env.AI_TOKEN_ENC_KEY = AI_KEY_B64;

    // ── GET context ─────────────────────────────────────────────────────────────────────────
    const ctx = await tryContext(who(u1), "aitry-ns", orgSlug, null, deps);
    assert.equal(ctx.status, 200, JSON.stringify(ctx.body));
    assert.equal(ctx.body.semver, "1.0.0", "latest = the highest stable active, git-published version");
    assert.equal(ctx.body.model, "stub-model");
    assert.equal(ctx.body.usage, "Ask it to **review this contract**.");
    assert.equal(ctx.body.contentCheck, "pending");
    assert.deepEqual(ctx.body.files, [
      { path: "SKILL.md", state: "loaded" },
      { path: "scripts/review.sh", state: "loaded" },
      { path: "references/clauses.md", state: "loaded" },
    ]);
    assert.deepEqual(ctx.body.limits, DEFAULT_PANEL, "§40.18: the per-conversation limits in force");
    assert.deepEqual(ctx.body.daily, { cap: 100, remaining: 100, retryAt: null }, "the caller's daily allowance");
    assert.equal((await tryContext(who(u1), "aitry-ns", orgSlug, "1.1.0-beta.1", deps)).body.semver, "1.1.0-beta.1", "a prerelease by name");
    for (const gone of ["0.9.0", "0.8.0", "2.0.0", "9.9.9"]) {
      const r = await tryContext(who(u1), "aitry-ns", orgSlug, gone, deps);
      assert.equal(r.status, 404, gone);
      assert.equal(r.body.error, "version_not_found", gone);
    }
    const outsider = await tryContext(who(u1), "aitry-ns", `${K}-secret`, null, deps);
    assert.deepEqual([outsider.status, outsider.body.error], [404, "not found"], "#3: a restricted skill the caller can't see");
    assert.equal((await tryContext(who(u1, [[ns, "namespace_member"]]), "aitry-ns", `${K}-secret`, null, deps)).status, 200, "a member can try it");
    const arch = await tryContext(who(u1, [[ns, "namespace_member"]]), "aitry-ns", `${K}-old`, null, deps);
    assert.equal(arch.status, 404, "an archived skill can't be tried");
    assert.equal(stub.state.hits, 0, "GET never calls the provider");

    // ── POST happy path: one usage row, no audit, the exact egress ─────────────────────────
    const transcript = [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Review this contract" },
    ];
    const ok = await trySend(who(u1), "aitry-ns", orgSlug, { semver: "1.0.0", messages: transcript }, deps);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(String(ok.body.reply), /scripts\/review\.sh/);
    assert.equal(ok.body.model, "stub-model");
    assert.deepEqual(ok.body.limits, DEFAULT_PANEL);
    assert.deepEqual(ok.body.daily, { cap: 100, remaining: 99, retryAt: null }, "the allowance already counts this call");
    assert.deepEqual(await usageRows(u1), [{ ok: true, error_code: null }]);
    assert.equal((await pool.query(`select 1 from audit_log where actor_user_id = $1`, [u1])).rowCount, 0, "Try is not audited");
    const sent = JSON.parse(stub.state.bodies.at(-1)!) as { system: string; messages: { role: string; content: string }[]; max_tokens: number };
    assert.deepEqual(sent.messages, transcript, "the transcript is sent as is");
    assert.equal(sent.max_tokens, 8192);
    assert.ok(sent.system.includes("Contract review"), "SKILL.md is in the system prompt");
    assert.ok(sent.system.includes("SCRIPT_BODY_MARKER") && sent.system.includes("REFERENCE_BODY_MARKER"), "scripts and references are loaded");
    assert.ok(sent.system.includes("[redacted]") && !sent.system.includes("AKIAIOSFODNN7EXAMPLE"), "secret lines are redacted");
    assert.ok(!sent.system.includes("ASSET_BODY_MARKER"), "files outside the selection are never sent");
    assert.ok(sent.system.includes('"assets/notes.txt"'), "but the bundle's paths are");
    assert.ok(!sent.system.includes(u1) && !sent.system.includes(`${K}-u1`), "nothing about the user");

    // ── Transcript 422s ───────────────────────────────────────────────────────────────────
    const u2 = await mkUser("u2");
    const bad = await trySend(who(u2), "aitry-ns", orgSlug, { semver: "1.0.0", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] }, deps);
    assert.deepEqual([bad.status, bad.body.error], [422, "invalid_transcript"]);
    const long = await trySend(who(u2), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs("x".repeat(4001)) }, deps);
    assert.deepEqual([long.status, long.body.error], [422, "invalid_transcript"]);
    const many: { role: string; content: string }[] = [];
    for (let i = 0; i < 21; i++) {
      if (i) many.push({ role: "assistant", content: "a" });
      many.push({ role: "user", content: "q" });
    }
    const full = await trySend(who(u2), "aitry-ns", orgSlug, { semver: "1.0.0", messages: many }, deps);
    assert.deepEqual([full.status, full.body.error], [422, "conversation_full"]);
    assert.deepEqual([full.body.limits, full.body.daily], [DEFAULT_PANEL, { cap: 100, remaining: 100, retryAt: null }], "a 422 tells the panel the values in force");
    assert.deepEqual(await usageRows(u2), [], "refused messages never reach the provider");

    // ── Version yanked mid-conversation; restricted skill on POST ─────────────────────────
    const u3 = await mkUser("u3");
    await pool.query(`update skill_versions set status = 'yanked' where skill_id = $1 and semver = '1.1.0-beta.1'`, [orgSkill]);
    const yanked = await trySend(who(u3), "aitry-ns", orgSlug, { semver: "1.1.0-beta.1", messages: msgs() }, deps);
    assert.deepEqual([yanked.status, yanked.body.error], [404, "version_not_found"]);
    assert.equal((await trySend(who(u3), "aitry-ns", `${K}-secret`, { semver: "1.0.0", messages: msgs() }, deps)).status, 404);
    const noArtifact = await trySend(who(u3), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, { getArtifact: async () => { throw new Error("gone"); } });
    assert.deepEqual([noArtifact.status, noArtifact.body.error], [422, "try_source_failed"]);

    // ── Provider failure → 502, no provider text, one attempt; an empty reply → 502 ────────
    const u4 = await mkUser("u4");
    stub.state.mode = "500";
    const hits = stub.state.hits;
    const fail = await trySend(who(u4), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, deps);
    assert.deepEqual([fail.status, fail.body.error], [502, "try_failed"]);
    assert.ok(!JSON.stringify(fail.body).includes("secret-detail"), "provider text never reaches the caller");
    assert.equal(stub.state.hits - hits, 1, "retry: false — exactly one attempt");
    assert.deepEqual(fail.body.daily, { cap: 100, remaining: 99, retryAt: null }, "§61.7: a failed reply still counts");
    // §61.11: that failed call turned the pill Failing, which hides Try until a later success.
    assert.equal(await tryAvailability(live), false, "a failed Try call hides Try");
    const hidden = await trySend(who(u4), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, deps);
    assert.deepEqual([hidden.status, hidden.body.error], [409, "try_unavailable"]);
    await operational();
    stub.state.mode = "empty";
    const empty = await trySend(who(u4), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, deps);
    assert.deepEqual([empty.status, empty.body.error], [502, "try_failed"]);
    assert.equal((empty.body.daily as Daily).remaining, 98, "the 409 before it reached no provider and cost nothing; this call did");
    assert.equal(await tryAvailability(live), true, "an empty reply is a 502 to the user, but the provider answered — the pill stays Operational");
    stub.state.mode = "ok";

    // ── Per-minute limit: the 11th message in a minute is a 429 ────────────────────────────
    const uMin = await mkUser("umin");
    for (let i = 0; i < 10; i++) {
      const r = await trySend(who(uMin), "aitry-ns", orgSlug, { semver: "1.0.0", messages: [] }, deps);
      assert.equal(r.status, 422);
    }
    const limited = await trySend(who(uMin), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, deps);
    assert.deepEqual([limited.status, limited.body.error, limited.body.scope], [429, "try_rate_limited", "minute"]);
    assert.deepEqual([limited.body.limits, limited.body.daily], [undefined, undefined], "answered before the count is read");

    // ── Rolling daily cap: 100 calls in the last 24 h → 429 with retryAt ──────────────────
    const uDay = await mkUser("uday");
    await pool.query(
      `insert into ai_usage (created_at, feature, user_id, provider, model, latency_ms, ok)
       select now() - (g || ' minutes')::interval, 'skill_try', $1, 'anthropic', 'stub-model', 5, true from generate_series(1, 100) g`,
      [uDay],
    );
    const capped = await trySend(who(uDay), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, deps);
    assert.deepEqual([capped.status, capped.body.scope, capped.body.cap], [429, "day", 100]);
    const retryAt = new Date(String(capped.body.retryAt)).getTime();
    assert.ok(Math.abs(retryAt - (Date.now() - 100 * 60_000 + 24 * 3600_000)) < 120_000, "retryAt = when the oldest counted call ages out");
    assert.deepEqual(capped.body.daily, { cap: 100, remaining: 0, retryAt: capped.body.retryAt });
    // The panel opens blocked: GET already says 0 left and when to come back (§61.3).
    const cappedGet = await tryContext(who(uDay), "aitry-ns", orgSlug, null, deps);
    assert.equal(cappedGet.status, 200);
    assert.deepEqual([(cappedGet.body.daily as Daily).remaining, (cappedGet.body.daily as Daily).retryAt], [0, capped.body.retryAt]);
    await pool.query(`update ai_usage set created_at = created_at - interval '1 day' where user_id = $1 and feature = 'skill_try'`, [uDay]);
    assert.equal((await trySend(who(uDay), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, deps)).status, 200);

    // ── §40.18 the Try limits: their own save, independent of the provider config and the switch ──
    const limitAudits = async () =>
      (await pool.query<{ before: unknown; after: unknown }>(
        `select before, after from audit_log where action = 'settings.updated' and target_id = $1 and created_at >= $2 order by created_at`,
        [LIMITS, started],
      )).rows;
    const NONE = { dailyCap: null, perMinute: null, maxTurns: null, maxMessageChars: null, maxTranscriptChars: null };
    const DEFAULT_VIEW = {
      dailyCap: { default: 100, override: null, effective: 100, min: 1, max: 1000 },
      perMinute: { default: 10, override: null, effective: 10, min: 1, max: 60 },
      maxTurns: { default: 20, override: null, effective: 20, min: 1, max: 100 },
      maxMessageChars: { default: 4000, override: null, effective: 4000, min: 500, max: 20_000 },
      maxTranscriptChars: { default: 200_000, override: null, effective: 200_000, min: 20_000, max: 400_000 },
    };
    assert.deepEqual((await ai.getAiAdminStatus()).tryLimits, DEFAULT_VIEW);
    // Invalid input → 422 invalid_try_limit naming the field; nothing stored, nothing audited.
    const refused = async (body: unknown) => {
      const r = await ai.saveAiTryLimits(body, admin);
      return ai.isAiApiError(r) ? [r.error, r.status, r.field] : null;
    };
    const invalid: [unknown, string][] = [
      [null, "body"],
      [{}, "dailyCap"],
      [{ ...NONE, dailyCap: 0 }, "dailyCap"],
      [{ ...NONE, perMinute: 61 }, "perMinute"],
      [{ ...NONE, maxTurns: 1.5 }, "maxTurns"],
      [{ ...NONE, maxMessageChars: "500" }, "maxMessageChars"],
      [{ ...NONE, maxTranscriptChars: 400_001 }, "maxTranscriptChars"],
    ];
    for (const [body, field] of invalid) assert.deepEqual(await refused(body), ["invalid_try_limit", 422, field], JSON.stringify(body));
    // Restoring defaults that are already in force is a no-op.
    assert.deepEqual(await ai.saveAiTryLimits(NONE, admin), DEFAULT_VIEW);
    assert.equal(await storedLimits(), undefined);
    assert.equal((await limitAudits()).length, 0);
    // Saved without AI_TOKEN_ENC_KEY (not subject to ai_key_missing): only the overrides are stored; audited.
    delete process.env.AI_TOKEN_ENC_KEY;
    const tightened = await ai.saveAiTryLimits({ ...NONE, dailyCap: 3, perMinute: 2 }, admin);
    process.env.AI_TOKEN_ENC_KEY = AI_KEY_B64;
    assert.deepEqual(tightened, {
      ...DEFAULT_VIEW,
      dailyCap: { default: 100, override: 3, effective: 3, min: 1, max: 1000 },
      perMinute: { default: 10, override: 2, effective: 2, min: 1, max: 60 },
    });
    assert.deepEqual(await storedLimits(), { dailyCap: 3, perMinute: 2 });
    assert.deepEqual((await ai.getAiAdminStatus()).tryLimits, tightened);
    // Saving the values already stored writes and audits nothing.
    assert.deepEqual(await ai.saveAiTryLimits({ ...NONE, dailyCap: 3, perMinute: 2 }, admin), tightened);
    assert.deepEqual(await limitAudits(), [{ before: { aiTryLimits: {} }, after: { aiTryLimits: { dailyCap: 3, perMinute: 2 } } }]);

    // A lowered daily cap applies to the next message: 3 calls in the last 24 hours → 429 naming the cap in force.
    const seedCalls = (userId: string, count: number) =>
      pool.query(
        `insert into ai_usage (created_at, feature, user_id, provider, model, latency_ms, ok)
         select now() - (g || ' minutes')::interval, 'skill_try', $1, 'anthropic', 'stub-model', 5, true from generate_series(1, $2::int) g`,
        [userId, count],
      );
    const uLow = await mkUser("ulow");
    await seedCalls(uLow, 3);
    const low = await trySend(who(uLow), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, deps);
    assert.deepEqual([low.status, low.body.scope, low.body.cap], [429, "day", 3]);
    assert.deepEqual([(low.body.daily as Daily).cap, (low.body.daily as Daily).remaining], [3, 0]);
    assert.ok(Math.abs(new Date(String(low.body.retryAt)).getTime() - (Date.now() - 3 * 60_000 + 24 * 3600_000)) < 120_000, "retryAt is computed against the new cap");
    // perMinute 2: this person's third POST in a minute is refused, whatever the first two were.
    assert.equal((await trySend(who(uLow), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, deps)).body.scope, "day");
    const third = await trySend(who(uLow), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, deps);
    assert.deepEqual([third.status, third.body.scope], [429, "minute"]);

    // A raised daily cap lets the same history through at once; the allowance counts the new call.
    const uRaise = await mkUser("uraise");
    await seedCalls(uRaise, 3);
    assert.equal((await trySend(who(uRaise), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, deps)).status, 429);
    await ai.saveAiTryLimits({ ...NONE, dailyCap: 5 }, admin);
    const raised = await trySend(who(uRaise), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, deps);
    assert.equal(raised.status, 200, JSON.stringify(raised.body));
    assert.deepEqual(raised.body.daily, { cap: 5, remaining: 1, retryAt: null });

    // Per conversation: with maxTurns 1 a second user message is conversation_full; a message over
    // a lowered per-message limit is invalid_transcript when it is the one being sent…
    await ai.saveAiTryLimits({ ...NONE, maxTurns: 1, maxMessageChars: 500 }, admin);
    const uConv = await mkUser("uconv");
    const tight = { maxTurns: 1, maxMessageChars: 500, maxTranscriptChars: 200_000 };
    assert.deepEqual((await tryContext(who(uConv), "aitry-ns", orgSlug, null, deps)).body.limits, tight, "GET returns the limits in force");
    const second = await trySend(who(uConv), "aitry-ns", orgSlug, { semver: "1.0.0", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }, { role: "user", content: "q" }] }, deps);
    assert.deepEqual([second.status, second.body.error, second.body.limits], [422, "conversation_full", tight]);
    const tooLong = await trySend(who(uConv), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs("x".repeat(501)) }, deps);
    assert.deepEqual([tooLong.status, tooLong.body.error, tooLong.body.limits], [422, "invalid_transcript", tight]);
    // …and conversation_full when it is an earlier one: the conversation was within the old limit.
    await ai.saveAiTryLimits({ ...NONE, maxMessageChars: 500 }, admin);
    const older = await trySend(who(uConv), "aitry-ns", orgSlug, { semver: "1.0.0", messages: [{ role: "user", content: "x".repeat(600) }, { role: "assistant", content: "a" }, { role: "user", content: "q" }] }, deps);
    assert.deepEqual([older.status, older.body.error], [422, "conversation_full"]);
    assert.deepEqual(await usageRows(uConv), [], "none of them reached the provider");

    // A hand-edited row: out of range is clamped, a non-number falls back to the default, an unknown key is ignored.
    await pool.query(`update platform_settings set value = $2::jsonb where key = $1`, [LIMITS, JSON.stringify({ dailyCap: 0, perMinute: 9999, maxTurns: "many", bogus: 1 })]);
    assert.deepEqual(await ai.aiTryLimits(), { dailyCap: 1, perMinute: 60, maxTurns: 20, maxMessageChars: 4000, maxTranscriptChars: 200_000 });

    // The limits survive Remove integration; null restores every default and deletes the row.
    await ai.saveAiTryLimits({ ...NONE, dailyCap: 250 }, admin);
    assert.deepEqual(await ai.removeAiIntegration(admin), { ok: true });
    assert.deepEqual(await storedLimits(), { dailyCap: 250 }, "Remove integration keeps the limits");
    assert.equal((await ai.getAiAdminStatus()).tryLimits.dailyCap.effective, 250);
    assert.deepEqual(await ai.saveAiTryLimits(NONE, admin), DEFAULT_VIEW);
    assert.equal(await storedLimits(), undefined);
    assert.deepEqual((await limitAudits()).at(-1), { before: { aiTryLimits: { dailyCap: 250 } }, after: { aiTryLimits: {} } });
    await operational();

    // ── The switch: off → 409 on an open panel; audited; unchanged = no-op; survives removal ─
    const before = await auditCount();
    await setAiTryEnabled(false, admin);
    const off = await trySend(who(u1), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, deps);
    assert.deepEqual([off.status, off.body.error], [409, "try_unavailable"]);
    await setAiTryEnabled(false, admin);
    assert.equal(await auditCount(), before + 1, "a change is audited once; an unchanged save is a no-op");
    await setAiTryEnabled(true, admin);
    await pool.query(`delete from ai_integration`);
    invalidatePlatformSettings();
    assert.equal((await pool.query(`select value from platform_settings where key = 'ai_try_enabled'`)).rows[0]?.value, true, "Remove integration keeps the switch");
    const gone = await trySend(who(u1), "aitry-ns", orgSlug, { semver: "1.0.0", messages: msgs() }, deps);
    assert.equal(gone.status, 409, "no integration → not effective");
  } finally {
    stub.server.close();
    await pool.query(`delete from ai_usage where user_id = any($1::uuid[])`, [userIds]);
    if (skillIds.length) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("set local skilly.allow_version_delete = 'on'");
        await c.query(`delete from skills where id = any($1::uuid[])`, [skillIds]);
        await c.query("commit");
      } finally {
        c.release();
      }
    }
    await pool.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    await pool.query(`delete from ai_integration`);
    if (savedAi) {
      const cols = Object.keys(savedAi);
      await pool.query(`insert into ai_integration (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((k) => savedAi[k]));
    }
    if (savedSwitch === null) await pool.query(`delete from platform_settings where key = 'ai_try_enabled'`);
    else await pool.query(`update platform_settings set value = $1::jsonb where key = 'ai_try_enabled'`, [JSON.stringify(savedSwitch)]);
    await pool.query(`delete from platform_settings where key = $1`, [LIMITS]);
    if (savedLimits !== undefined) {
      await pool.query(`insert into platform_settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [LIMITS, JSON.stringify(savedLimits)]);
    }
    invalidatePlatformSettings();
  }
}));
