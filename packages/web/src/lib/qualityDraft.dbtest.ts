// Live-DB integration test for AI-drafted quality improvements (SKILLY_SPEC.md §43.12) and the AI
// display name (§40.14). Gated by SKILLY_DB_E2E=1. The provider is a local Anthropic-shaped stub
// that answers per file; the object store is in memory.
//
// Covers: eligibility (403 for a non-maintainer member, 409 not_hosted for a pointer, available for
// an explicit maintainer and a platform admin), the file plan (OS junk → delete, a flagged secret
// → skipped), the streamed run (plan → file events → done; one failing file leaves the others; a
// file with a secret is never sent; one ai_usage row per call under the requester; the audit row),
// the run cap (timed_out), assemble (the changes vouched for by the run token become a staged
// bundle through the upload pipeline; a tampered change or another user's token is refused), the
// proposal provenance (ai_draft_model only with a matching aiDraftToken), the My Skills flags and
// the display-name setting (validation, audit, the served value, survives removing the config).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import AdmZip from "adm-zip";

const enabled = process.env.SKILLY_DB_E2E === "1";
const GOOD = "sk-draft-dbtest-token-1234";
const AI_KEY_B64 = Buffer.alloc(32, 23).toString("base64");
const SECRET = `ghp_${"a".repeat(36)}`;

const SKILL_MD = (slug: string) => `---\nname: ${slug}\ndescription: Helps.\n---\n# Draft me\nmake sure to do things properly\n`;
const BETTER_MD = (slug: string) =>
  `---\nname: ${slug}\ndescription: Reviews contracts. Use when the user says "review this contract". Do not use for spreadsheets.\n---\n# Draft me\n\n## Instructions\n\n1. Read the contract.\n`;

type StubMode = "ok" | "slow";
function startStub(slug: string): Promise<{ server: Server; url: string; state: { mode: StubMode; bodies: string[] } }> {
  const state = { mode: "ok" as StubMode, bodies: [] as string[] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.headers["x-api-key"] !== GOOD) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: "bad key" } }));
        return;
      }
      if (req.url !== "/v1/messages") {
        res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
        return;
      }
      state.bodies.push(body);
      const user = String((JSON.parse(body) as { messages: { content: string }[] }).messages[0]?.content ?? "");
      const answer = (text: string) => res.end(JSON.stringify({ model: "stub-model", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } }));
      const reply = () => {
        if (user.includes("## File: SKILL.md")) answer(JSON.stringify({ action: "modify", content: BETTER_MD(slug), summary: "Added triggers and steps", addressed: ["DS-001", "BD-004"] }));
        else if (user.includes("## File: README.md")) answer(JSON.stringify({ action: "delete", summary: "Docs belong in SKILL.md", addressed: ["FS-003"] }));
        else if (user.includes("## File: references/notes.md")) answer("this is not json");
        else answer(JSON.stringify({ action: "keep", summary: "fine" }));
      };
      if (state.mode === "slow") setTimeout(reply, 400);
      else reply();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state })));
}

let poolRef: { end(): Promise<void> } | null = null;
after(async () => { if (enabled && poolRef) await poolRef.end(); });

test("AI quality drafts: eligibility, plan, run, cap, assemble, provenance, My Skills, display name", { skip: !enabled }, async () => {
  process.env.AI_TOKEN_ENC_KEY = AI_KEY_B64;
  const { pool } = await import("./db");
  poolRef = pool;
  const ai = await import("./ai");
  const draft = await import("./qualityDraft");
  const { createProposal, getProposalDetail } = await import("./proposals");
  const { setAiDisplayName, getPlatformSettings } = await import("./settings");
  const shared = await import("@skilly/shared");

  const tag = `qd${Date.now().toString(36)}`;
  const slug = `${tag}-skill`;
  const stub = await startStub(slug);
  const savedAi = (await pool.query(`select * from ai_integration where id = 1`)).rows[0] ?? null;
  const savedName = (await pool.query(`select value from platform_settings where key = 'ai_display_name'`)).rows[0]?.value ?? null;
  const mem = new Map<string, Buffer>();
  const store = {
    get: async (k: string) => { const b = mem.get(k); if (!b) throw new Error("missing " + k); return b; },
    put: async (k: string, b: Buffer) => { mem.set(k, b); },
    delete: async () => {},
    list: async () => [],
  };
  const skillIds: string[] = [];

  // Fixed, upserted actors: audit rows reference them and audit_log is append-only.
  const upsertUser = async (oid: string, name: string) =>
    (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name, status) values ($1, $1 || '@org', $2, 'active')
       on conflict (entra_object_id) do update set status = 'active' returning id`,
      [oid, name],
    )).rows[0]!.id;

  try {
    const maintainer = await upsertUser("qd-dbtest-maintainer", "QD maintainer");
    const member = await upsertUser("qd-dbtest-member", "QD member");
    const nsId = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ($1, $1, true) returning id`,
      [`${tag}-ns`],
    )).rows[0]!.id;
    const asMaintainer = { isPlatformAdmin: false, namespaceRoles: new Map(), userId: maintainer } as never;
    const asMember = { isPlatformAdmin: false, namespaceRoles: new Map([[nsId, "namespace_member"]]), userId: member } as never;
    const asAdmin = { isPlatformAdmin: true, namespaceRoles: new Map(), userId: member } as never;

    // AI on, against the stub.
    await pool.query(`delete from ai_integration`);
    const saved = await ai.saveFromForm({ provider: "anthropic", baseUrl: stub.url, model: "stub-model", token: GOOD }, maintainer);
    assert.ok(!ai.isAiApiError(saved), JSON.stringify(saved));
    const en = await ai.setAiEnabled(true, maintainer);
    assert.ok(!ai.isAiApiError(en), JSON.stringify(en));

    // A hosted skill whose latest version has quality findings in four files, a junk file and a secret.
    const files: Record<string, string> = {
      "SKILL.md": SKILL_MD(slug),
      "README.md": "# readme\n",
      "references/notes.md": "notes\n",
      "node_modules/x/index.js": "module.exports = 1;\n",
      "scripts/leak.py": `TOKEN = "${SECRET}"\nprint(open("/Users/bob/data.txt").read())\n`,
    };
    const zip = new AdmZip();
    for (const [p, c] of Object.entries(files)) zip.addFile(p, Buffer.from(c));
    const artifactKey = `${tag}/v1.bundle`;
    mem.set(artifactKey, zip.toBuffer());
    const entries = Object.entries(files).map(([path, c]) => ({ path, bytes: new TextEncoder().encode(c) }));
    const findings = await shared.runScanners(entries, shared.PURE_SCANNERS);
    assert.ok(findings.some((f) => f.scanner === "secret-scan" && f.path === "scripts/leak.py"), "the fixture's secret is flagged");
    await pool.query(
      `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status) values ('artifact', $1, 'pipeline', $2::jsonb, 'info', 'scanned')`,
      [artifactKey, JSON.stringify(findings)],
    );
    const skillId = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1, $2, $2, 'd', 'generic', 'hosted', 'org', 'active') returning id`,
      [nsId, slug],
    )).rows[0]!.id;
    skillIds.push(skillId);
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1, $2)`, [skillId, maintainer]);
    const versionId = (await pool.query<{ id: string }>(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
       values ($1, '1.0.0', false, 'active', $2, 'sha', $3, true) returning id`,
      [skillId, artifactKey, maintainer],
    )).rows[0]!.id;
    await shared.upsertQualityRules(pool, { versionId, skillId, findings, aiOn: false });
    await shared.refreshSkillQuality(pool, skillId);

    // A pointer skill: hidden (409 not_hosted).
    const pointerId = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1, $2, $2, 'd', 'generic', 'pointer', 'org', 'active') returning id`,
      [nsId, `${tag}-ptr`],
    )).rows[0]!.id;
    skillIds.push(pointerId);
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1, $2)`, [pointerId, maintainer]);

    // ── Eligibility ──
    const denied = await draft.loadDraftContext(asMember, `${tag}-ns`, slug);
    assert.equal(denied.ok, false);
    assert.equal(!denied.ok && denied.status, 403, "a plain namespace member who is not a maintainer may not draft");
    const ptr = await draft.loadDraftContext(asMaintainer, `${tag}-ns`, `${tag}-ptr`);
    assert.ok(!ptr.ok && ptr.status === 409 && ptr.reason === "not_hosted");
    assert.deepEqual(await draft.aiDraftAvailability(asMaintainer, `${tag}-ns`, `${tag}-ptr`), { available: false, reason: null });
    assert.deepEqual(await draft.aiDraftAvailability(asAdmin, `${tag}-ns`, slug), { available: true, reason: null });
    const r = await draft.loadDraftContext(asMaintainer, `${tag}-ns`, slug);
    assert.ok(r.ok, JSON.stringify(r));
    const ctx = r.ok ? r.ctx : (null as never);
    assert.equal(ctx.semver, "1.0.0");

    // ── Plan ──
    const { plan } = await draft.draftPlan(ctx, { store });
    const by = new Map(plan.map((p) => [p.path, p]));
    assert.equal(plan[0]!.path, "SKILL.md");
    assert.equal(by.get("SKILL.md")!.status, "queued");
    assert.equal(by.get("README.md")!.status, "queued");
    assert.equal(by.get("node_modules/x/index.js")!.status, "delete");
    assert.deepEqual([by.get("scripts/leak.py")!.status, by.get("scripts/leak.py")!.reason], ["skipped", "secret"]);

    // ── Run ──
    stub.state.bodies.length = 0; // drop the connectivity test from saving the config
    const since = new Date(Date.now() - 1000);
    const events: Array<Record<string, unknown>> = [];
    await draft.runDraft({ ...(asMaintainer as object), userId: maintainer } as never, ctx, (e) => events.push(e as never), { store, heartbeatMs: 10 });
    assert.equal(events[0]!.type, "plan");
    const fileEv = (p: string) => events.find((e) => e.type === "file" && e.path === p)!;
    assert.equal(fileEv("SKILL.md").status, "modified");
    assert.equal(fileEv("SKILL.md").content, BETTER_MD(slug));
    assert.ok((fileEv("SKILL.md").diff as { added: number }).added > 0);
    assert.deepEqual(fileEv("SKILL.md").addressed, ["DS-001", "BD-004"]);
    assert.equal(fileEv("README.md").status, "deleted");
    assert.equal(fileEv("node_modules/x/index.js").status, "deleted");
    assert.equal(fileEv("references/notes.md")?.status ?? "absent", by.has("references/notes.md") ? "failed" : "absent");
    const done = events.at(-1)!;
    assert.equal(done.type, "done");
    assert.equal(done.outcome, "complete");
    assert.equal(done.model, "stub-model");
    // The secret file is never sent; no request carries the secret.
    assert.ok(stub.state.bodies.every((b) => !b.includes(SECRET) && !b.includes("## File: scripts/leak.py")));
    const usage = await pool.query<{ user_id: string; ok: boolean }>(`select user_id, ok from ai_usage where feature = 'skill_quality_draft' and created_at >= $1`, [since]);
    assert.equal(usage.rowCount, stub.state.bodies.length, "one ai_usage row per provider call");
    assert.ok(usage.rows.every((u) => u.user_id === maintainer));
    const audit = await pool.query<{ after: Record<string, unknown> }>(
      `select after from audit_log where action = 'skill.ai_draft_generated' and target_id = $1 and created_at >= $2`, [skillId, since],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0]!.after.baseSemver, "1.0.0");
    assert.ok(!JSON.stringify(audit.rows[0]!.after).includes("Reviews contracts"), "audit never carries AI output");

    // ── Assemble ──
    const runToken = String(done.runToken);
    const keep = [
      { path: "SKILL.md", action: "modify" as const, content: BETTER_MD(slug), summary: "Added triggers and steps" },
      { path: "README.md", action: "delete" as const, summary: "Docs belong in SKILL.md" },
      { path: "node_modules/x/index.js", action: "delete" as const, summary: "Removed OS / tooling junk" },
    ];
    const tampered = await draft.assembleDraft({ ...(asMaintainer as object), userId: maintainer } as never, ctx, { runToken, baseSemver: "1.0.0", changes: [{ ...keep[0]!, content: BETTER_MD(slug) + "\nrm -rf /\n" }] }, { store });
    assert.equal(tampered.status, 422, "a change the run did not produce is refused");
    const stolen = await draft.assembleDraft({ ...(asAdmin as object), userId: member } as never, ctx, { runToken, baseSemver: "1.0.0", changes: keep }, { store });
    assert.equal(stolen.status, 422, "another user's run token is refused");
    const stale = await draft.assembleDraft({ ...(asMaintainer as object), userId: maintainer } as never, ctx, { runToken, baseSemver: "0.9.0", changes: keep }, { store });
    assert.equal(stale.status, 409);
    const res = await draft.assembleDraft({ ...(asMaintainer as object), userId: maintainer } as never, ctx, { runToken, baseSemver: "1.0.0", changes: keep }, { store });
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 201, JSON.stringify(j));
    assert.ok(typeof j.aiDraftToken === "string");
    assert.match(String(j.whatChanged), /- SKILL\.md: Added triggers and steps\n- Removed README\.md: Docs belong in SKILL\.md/);
    const staged = new AdmZip(mem.get(String(j.artifactObjectKey))!);
    const names = staged.getEntries().map((e) => e.entryName).sort();
    assert.deepEqual(names, ["SKILL.md", "references/notes.md", "scripts/leak.py"]);
    assert.equal(staged.getEntry("SKILL.md")!.getData().toString("utf8"), BETTER_MD(slug));
    assert.ok((j.quality as { rulesScore: number }).rulesScore > shared.scoreQuality(findings), "the draft scores better");

    // ── Provenance ──
    const artifactObjectKey = String(j.artifactObjectKey);
    assert.equal(draft.aiDraftModelFromToken(j.aiDraftToken, { userId: maintainer, skillId, artifactKey: artifactObjectKey }), "stub-model");
    assert.equal(draft.aiDraftModelFromToken(j.aiDraftToken, { userId: maintainer, skillId, artifactKey: "uploads/other.bundle" }), null);
    assert.equal(draft.aiDraftModelFromToken(j.aiDraftToken, { userId: member, skillId, artifactKey: artifactObjectKey }), null);
    assert.equal(draft.aiDraftModelFromToken("garbage.token", { userId: maintainer, skillId, artifactKey: artifactObjectKey }), null);
    assert.equal(draft.aiDraftModelFromToken(runToken, { userId: maintainer, skillId, artifactKey: artifactObjectKey }), null, "a run token is not a draft token");
    const { id: proposalId } = await createProposal(pool, {
      submittedByUserId: maintainer, targetNamespaceId: nsId, targetSkillId: skillId, proposedSemver: "1.0.1",
      payload: { metadata: { skillSlug: slug, title: slug, description: "d", toolHarness: "generic", visibility: "org", categories: [], usageExamples: null, whatChanged: String(j.whatChanged) }, artifactObjectKey, artifactSha256: String(j.artifactSha256) },
      aiDraftModel: draft.aiDraftModelFromToken(j.aiDraftToken, { userId: maintainer, skillId, artifactKey: artifactObjectKey }),
    });
    const detail = await getProposalDetail(pool, proposalId, asAdmin, member);
    assert.equal(detail?.aiDraftModel, "stub-model");
    const created = await pool.query<{ after: Record<string, unknown> }>(`select after from audit_log where action = 'proposal.created' and target_id = $1`, [proposalId]);
    assert.equal(created.rows[0]!.after.aiDraftModel, "stub-model");

    // ── The run cap ──
    stub.state.mode = "slow";
    const capped: Array<Record<string, unknown>> = [];
    await draft.runDraft({ ...(asMaintainer as object), userId: maintainer } as never, ctx, (e) => capped.push(e as never), { store, capMs: 50, heartbeatMs: 10_000 });
    const cappedFiles = capped.filter((e) => e.type === "file" && e.path !== "node_modules/x/index.js");
    assert.ok(cappedFiles.length > 0 && cappedFiles.every((e) => e.status === "failed" && e.reason === "timed_out"), JSON.stringify(cappedFiles));
    assert.equal(capped.at(-1)!.outcome, "capped");

    // ── My Skills flags ──
    assert.deepEqual(await draft.canAiDraftFlags([{ type: "hosted", status: "active", quality: { score: 50 } }, { type: "pointer", quality: { score: 50 } }, { type: "hosted", quality: null }]), [true, false, false]);
    await ai.setAiEnabled(false, maintainer);
    assert.deepEqual(await draft.canAiDraftFlags([{ type: "hosted", status: "active", quality: { score: 50 } }]), [false]);
    const off = await draft.loadDraftContext(asMaintainer, `${tag}-ns`, slug);
    assert.ok(!off.ok && off.reason === "ai_unavailable");

    // ── The display name (§40.14) ──
    await pool.query(`delete from platform_settings where key = 'ai_display_name'`);
    assert.equal((await getPlatformSettings()).aiDisplayName, "AI");
    assert.deepEqual(await setAiDisplayName("x".repeat(25), maintainer), { ok: false, error: "the display name must be at most 24 characters" });
    const nameSince = new Date(Date.now() - 1000);
    assert.deepEqual(await setAiDisplayName("  Aria ", maintainer), { ok: true, displayName: "Aria" });
    assert.equal((await getPlatformSettings()).aiDisplayName, "Aria");
    assert.equal((await ai.getAiAdminStatus()).displayName, "Aria");
    await ai.removeAiIntegration(maintainer);
    assert.equal((await getPlatformSettings()).aiDisplayName, "Aria", "the name survives removing the provider config");
    const nameAudit = await pool.query<{ before: unknown; after: unknown }>(
      `select before, after from audit_log where action = 'settings.updated' and target_id = 'ai_display_name' and created_at >= $1 order by created_at`, [nameSince],
    );
    assert.deepEqual(nameAudit.rows.map((x) => x.after), [{ aiDisplayName: "Aria" }]);
    assert.deepEqual(await setAiDisplayName("", maintainer), { ok: true, displayName: "AI" });
    assert.equal((await pool.query(`select 1 from platform_settings where key = 'ai_display_name'`)).rowCount, 0);
  } finally {
    stub.server.close();
    if (skillIds.length) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("set local skilly.allow_version_delete = 'on'");
        await c.query(`delete from proposals where target_skill_id = any($1::uuid[])`, [skillIds]);
        await c.query(`delete from skills where id = any($1::uuid[])`, [skillIds]);
        await c.query("commit");
      } finally {
        c.release();
      }
    }
    await pool.query(`delete from ai_integration`);
    if (savedAi) {
      const cols = Object.keys(savedAi);
      await pool.query(`insert into ai_integration (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) on conflict (id) do nothing`, cols.map((k) => savedAi[k]));
    }
    if (savedName !== null) {
      await pool.query(`insert into platform_settings (key, value) values ('ai_display_name', $1::jsonb) on conflict (key) do update set value = excluded.value`, [JSON.stringify(savedName)]);
    } else {
      await pool.query(`delete from platform_settings where key = 'ai_display_name'`);
    }
  }
});
