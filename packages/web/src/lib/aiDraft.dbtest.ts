// Live-DB integration test for "Draft with AI" on the propose form (SKILLY_SPEC.md §43.12). Gated
// behind SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL. The provider is a local
// HTTP stub speaking the Anthropic Messages shape; pointer fetches and object storage are stood in
// for through draftWithAi's deps.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: AI off → 409 ai_unavailable; the hosted path drafts, maps categories onto the vocabulary,
// writes one ai_usage row for the caller and stores/scans/audits nothing; the egress (redacted
// SKILL.md, no other bundle file); 413 above the single-request size; 422 for a missing SKILL.md
// and an unreadable archive; an invalid-but-present SKILL.md still drafts; the pointer path and its
// 422; the reuse path's 404 for a restricted skill the caller can't see, 422 without a stable
// version, and 200 from the stored artifact; provider failure → 502 without provider text and no
// retry; invalid JSON → 502; the per-minute 429; the rolling daily cap's 429 with retryAt, with
// refused (413/422) calls not counted.
import { test, after } from "node:test";
import { withAiIntegrationLock } from "./aiTestLock";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import AdmZip from "adm-zip";
import type { EffectiveAccess } from "@skilly/shared";

const enabled = process.env.SKILLY_DB_E2E === "1";
const GOOD = "sk-dbtest-draft-token-1234";
const AI_KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const K = `aid${Date.now().toString(36)}`;

type Mode = "ok" | "500" | "garbage";
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
      const text = state.mode === "garbage"
        ? "I'd rather not."
        : JSON.stringify({
            description: "Reviews PDF contracts and flags risky clauses.",
            usage: "Ask: \"review this contract\".\n\n- \"summarize clause 4\"\n- \"flag indemnities\"",
            categories: [`${K.toUpperCase()} PDF`, `${K}_pdf`, `${K} brand new`, "general"],
          });
      res.end(JSON.stringify({ model: "stub-model", content: [{ type: "text", text }], usage: { input_tokens: 11, output_tokens: 5 } }));
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

const SKILL_MD = (slug: string) =>
  `---\nname: ${slug}\ndescription: Use when the user asks to review a PDF contract.\n---\n# Contract review\n\naws_secret_access_key = AKIAIOSFODNN7EXAMPLE\n\n1. Read the PDF.\n`;

after(async () => {
  if (enabled) {
    const { pool } = await import("./db");
    await pool.end();
  }
});

test("§43 Draft with AI: availability, sources, egress, failures and limits", { skip: !enabled }, () => withAiIntegrationLock(async () => {
  process.env.AI_TOKEN_ENC_KEY = AI_KEY_B64;
  const { pool } = await import("./db");
  const { draftWithAi } = await import("./aiDraft");
  const { getUploadChunkBytes } = await import("./settings");
  const { encryptAiToken, parseAiTokenKey } = await import("@skilly/shared/ai");
  const stub = await startStub();

  const savedAi = (await pool.query(`select * from ai_integration where id = 1`)).rows[0] ?? null;
  const userIds: string[] = [];
  const skillIds: string[] = [];
  const nsIds: string[] = [];
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
    (await pool.query<{ ok: boolean; error_code: string | null }>(`select ok, error_code from ai_usage where feature = 'skill_draft' and user_id = $1 order by id`, [userId])).rows;
  const hosted = (files: Record<string, string>) => ({ kind: "hosted" as const, bytes: zipOf(files), filename: "bundle.zip" });

  try {
    // ── AI off → 409, nothing reaches the provider ─────────────────────────────────────────
    await pool.query(`delete from ai_integration`);
    const u1 = await mkUser("u1");
    const off = await draftWithAi(who(u1), hosted({ "SKILL.md": SKILL_MD("x") }));
    assert.equal(off.status, 409);
    assert.equal(off.body.error, "ai_unavailable");

    // ── Enable the integration against the stub ────────────────────────────────────────────
    await pool.query(
      `insert into ai_integration (id, enabled, provider, base_url, model, token_enc, token_last4, last_test_at, last_test_ok)
       values (1, true, 'anthropic', $1, 'stub-model', $2, '1234', now(), true)`,
      [stub.url, encryptAiToken(GOOD, parseAiTokenKey(AI_KEY_B64)!)],
    );
    await pool.query(`insert into categories (name, slug) values ($1, $2)`, [`${K} pdf`, `${K}-pdf`]);

    // ── Hosted happy path: draft, category mapping, one usage row, nothing stored ─────────
    const ok = await draftWithAi(who(u1), hosted({ "SKILL.md": SKILL_MD("contract-review"), "scripts/zz-marker.py": "SCRIPT_BODY_MARKER = 1\n" }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.description, "Reviews PDF contracts and flags risky clauses.");
    assert.match(String(ok.body.usage), /review this contract/);
    assert.deepEqual(
      ok.body.categories,
      [{ name: `${K} pdf`, isNew: false }, { name: `${K} brand new`, isNew: true }],
      "case-folded name and same-slug name both map to the existing category; reserved general dropped",
    );
    assert.deepEqual(await usageRows(u1), [{ ok: true, error_code: null }]);
    const sent = stub.state.bodies.at(-1)!;
    assert.ok(sent.includes("Contract review"), "the SKILL.md is sent");
    assert.ok(sent.includes("[redacted]") && !sent.includes("AKIAIOSFODNN7EXAMPLE"), "secret-scanner lines are redacted");
    assert.ok(!sent.includes("SCRIPT_BODY_MARKER") && !sent.includes("zz-marker.py"), "no other bundle file or path leaves skilly");
    assert.ok(sent.includes(`- ${K} pdf`), "the category vocabulary is sent");
    assert.equal((await pool.query(`select 1 from scan_reports where subject_id like $1`, [`uploads/${u1}/%`])).rowCount, 0, "nothing scanned or stored");
    assert.equal((await pool.query(`select 1 from audit_log where actor_user_id = $1`, [u1])).rowCount, 0, "drafts are not audited");

    // ── Hosted refusals (413 / 422) — not counted toward the daily cap ────────────────────
    const u2 = await mkUser("u2");
    const chunkBytes = await getUploadChunkBytes();
    const big = await draftWithAi(who(u2), { kind: "hosted", bytes: Buffer.alloc(chunkBytes + 1), filename: "big.zip" });
    assert.equal(big.status, 413);
    assert.equal(big.body.error, "draft_bundle_too_large");
    const noMd = await draftWithAi(who(u2), hosted({ "README.md": "hi" }));
    assert.equal(noMd.status, 422);
    assert.equal(noMd.body.error, "draft_no_skill_md");
    const junk = await draftWithAi(who(u2), { kind: "hosted", bytes: Buffer.from("not an archive at all"), filename: "x.zip" });
    assert.equal(junk.status, 422);
    assert.equal(junk.body.error, "draft_bundle_unreadable");
    assert.deepEqual(await usageRows(u2), [], "refused calls never reach the provider");
    // An invalid-but-present SKILL.md (no frontmatter name) still drafts.
    const loose = await draftWithAi(who(u2), hosted({ "SKILL.md": "# Just a body\n\nDo the thing.\n" }));
    assert.equal(loose.status, 200);

    // ── Pointer path (fetch stood in) ──────────────────────────────────────────────────────
    const u3 = await mkUser("u3");
    const pointer = { kind: "pointer" as const, externalUrl: "https://example.com/r.git", externalRef: "main", externalSubdir: null, skillSlug: "contract-review" };
    const pOk = await draftWithAi(who(u3), pointer, {
      fetchPointer: async () => ({ ok: true, entries: [{ path: "SKILL.md", bytes: new TextEncoder().encode(SKILL_MD("contract-review")) }] }),
    });
    assert.equal(pOk.status, 200);
    const pBad = await draftWithAi(who(u3), pointer, { fetchPointer: async () => ({ ok: false, error: "ref 'main' was not found" }) });
    assert.equal(pBad.status, 422);
    assert.equal(pBad.body.error, "draft_source_failed");
    assert.match(String(pBad.body.message), /not found/);

    // ── Reuse path: visibility 404, no stable version 422, stored artifact 200 ────────────
    const ownerNs = (await pool.query<{ id: string }>(`insert into namespaces (slug, display_name, require_review) values ($1, $1, true) returning id`, [`${K}-own`])).rows[0]!.id;
    nsIds.push(ownerNs);
    const mkSkill = async (slug: string, visibility: "org" | "namespace") => {
      const id = (await pool.query<{ id: string }>(
        `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
         values ($1, $2, $2, 'd', 'generic', 'hosted', $3, 'active') returning id`,
        [ownerNs, slug, visibility],
      )).rows[0]!.id;
      skillIds.push(id);
      return id;
    };
    const restricted = await mkSkill(`${K}-secret`, "namespace");
    const empty = await mkSkill(`${K}-empty`, "org");
    await pool.query(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
       values ($1, '1.0.0', false, 'active', $2, 'sha', $3, true)`,
      [restricted, `${K}/secret.skill`, u3],
    );
    const store = new Map([[`${K}/secret.skill`, zipOf({ "SKILL.md": SKILL_MD(`${K}-secret`) })]]);
    const getArtifact = async (k: string) => store.get(k) ?? Promise.reject(new Error("missing"));
    const outsider = await draftWithAi(who(u3), { kind: "reuse", namespace: `${K}-own`, skill: `${K}-secret` }, { getArtifact });
    assert.equal(outsider.status, 404, "a restricted skill the caller can't see is a 404 (#3)");
    const noStable = await draftWithAi(who(u3), { kind: "reuse", namespace: `${K}-own`, skill: `${K}-empty` }, { getArtifact });
    assert.equal(noStable.status, 422);
    const member = await draftWithAi(who(u3, [[ownerNs, "namespace_member"]]), { kind: "reuse", namespace: `${K}-own`, skill: `${K}-secret` }, { getArtifact });
    assert.equal(member.status, 200, JSON.stringify(member.body));
    void empty;

    // ── Provider failure → 502, generic message, one attempt, usage(error) ────────────────
    const u4 = await mkUser("u4");
    stub.state.mode = "500";
    const hits = stub.state.hits;
    const fail = await draftWithAi(who(u4), hosted({ "SKILL.md": SKILL_MD("x") }));
    assert.equal(fail.status, 502);
    assert.equal(fail.body.error, "draft_failed");
    assert.ok(!JSON.stringify(fail.body).includes("secret-detail"), "provider text never reaches the caller");
    assert.equal(stub.state.hits - hits, 1, "retry: false — exactly one attempt");
    stub.state.mode = "garbage";
    const garbage = await draftWithAi(who(u4), hosted({ "SKILL.md": SKILL_MD("x") }));
    assert.equal(garbage.status, 502);
    assert.equal((await usageRows(u4)).length, 2);
    stub.state.mode = "ok";

    // ── Per-minute limit: the 11th request in a minute is a 429 ──────────────────────────
    const uMin = await mkUser("umin");
    for (let i = 0; i < 10; i++) {
      const r = await draftWithAi(who(uMin), { kind: "hosted", bytes: Buffer.from("junk"), filename: "x.zip" });
      assert.equal(r.status, 422);
    }
    const limited = await draftWithAi(who(uMin), hosted({ "SKILL.md": SKILL_MD("x") }));
    assert.equal(limited.status, 429);
    assert.deepEqual([limited.body.error, limited.body.scope], ["draft_rate_limited", "minute"]);

    // ── Rolling daily cap: 50 calls in the last 24 h → 429 with retryAt ───────────────────
    const uDay = await mkUser("uday");
    await pool.query(
      `insert into ai_usage (created_at, feature, user_id, provider, model, latency_ms, ok)
       select now() - (g || ' minutes')::interval, 'skill_draft', $1, 'anthropic', 'stub-model', 5, true from generate_series(1, 50) g`,
      [uDay],
    );
    const capped = await draftWithAi(who(uDay), hosted({ "SKILL.md": SKILL_MD("x") }));
    assert.equal(capped.status, 429);
    assert.deepEqual([capped.body.error, capped.body.scope, capped.body.cap], ["draft_rate_limited", "day", 50]);
    const retryAt = new Date(String(capped.body.retryAt)).getTime();
    const expect = Date.now() - 50 * 60_000 + 24 * 3600_000;
    assert.ok(Math.abs(retryAt - expect) < 120_000, "retryAt = when the oldest counted call ages out");
    // Calls older than 24 h don't count.
    await pool.query(`update ai_usage set created_at = created_at - interval '1 day' where user_id = $1 and feature = 'skill_draft'`, [uDay]);
    assert.equal((await draftWithAi(who(uDay), hosted({ "SKILL.md": SKILL_MD("x") }))).status, 200);
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
    await pool.query(`delete from namespaces where id = any($1::uuid[])`, [nsIds]);
    await pool.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    await pool.query(`delete from categories where name like $1`, [`${K} %`]);
    await pool.query(`delete from ai_integration`);
    if (savedAi) {
      const cols = Object.keys(savedAi);
      await pool.query(`insert into ai_integration (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((k) => savedAi[k]));
    }
  }
}));
