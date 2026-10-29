// Live-DB integration test for importing a whole repository (SKILLY_SPEC.md §64.3, §64.6, §64.7,
// §64.12). Gated by SKILLY_DB_E2E=1. Git runs for real against a local fixture repository through
// the module's injectable runner, which swaps the https test URL for the fixture's file:// path and
// drops the https-only transport flags (those guards keep their own unit tests).
//
// Verifies: the scan's rows, dates, reasons and nesting; an org skill and a §42-shared restricted
// skill are reported as matches, a restricted skill the caller can't see is not, an archived skill
// never matches and a deprecated one does. Submit: one proposal per item with import_id, all pinning
// one commit; a slug-taken item and a folder-gone item fail without stopping the others; the
// whole-import checks (>50 counting a continued import, duplicate slugs, the contribution policy,
// direct without authority, someone else's importId); one proposal.import_needs_review per reviewer
// and one proposal.import_submitted, no per-proposal needs_review/submitted; the audit row; direct
// mode publishes and routes an unreachable content check to review; the queue's import filter and
// the proposal detail's import block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveAccess } from "@skilly/shared";
import { pool } from "./db";
import { runGit, scanRepository, submitImport, type GitRunner, type ImportItemInput } from "./repoImport";
import { getProposalDetail, listMySubmissions, listReviewQueue } from "./proposals";
import { invalidatePlatformSettings } from "./settings";

const enabled = process.env.SKILLY_DB_E2E === "1";
const URL_ = "https://git.example.test/acme/rimp-skills.git";

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rimp-fixture-"));
  const g = (args: string[], date: string) =>
    execFileSync("git", ["-C", dir, ...args], { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  g(["init", "-q", "-b", "main"], "2026-01-01T00:00:00Z");
  g(["config", "user.email", "t@example.test"], "2026-01-01T00:00:00Z");
  g(["config", "user.name", "t"], "2026-01-01T00:00:00Z");
  g(["config", "core.autocrlf", "false"], "2026-01-01T00:00:00Z");
  const skill = (folder: string, fm: string) => {
    mkdirSync(join(dir, ...folder.split("/")), { recursive: true });
    writeFileSync(join(dir, ...folder.split("/"), "SKILL.md"), `---\n${fm}\n---\nBody.\n`);
  };
  skill("skills/rimp-pdf", "name: rimp-pdf\ndescription: Reads PDFs\nversion: 2.0.0\ncategory: documents");
  skill("skills/rimp-docx", "name: rimp-docx\ndescription: Writes Word files");
  g(["add", "-A"], "2026-03-01T10:00:00Z");
  g(["commit", "-qm", "first"], "2026-03-01T10:00:00Z");
  skill("skills/rimp-pdf/examples/rimp-mini", "name: rimp-mini\ndescription: Tiny");
  skill("skills/rimp-existing", "name: rimp-existing\ndescription: d");
  skill("skills/rimp-hidden", "name: rimp-hidden\ndescription: d");
  skill("skills/rimp-shared", "name: rimp-shared\ndescription: d");
  skill("skills/rimp-archived", "name: rimp-archived\ndescription: d");
  skill("skills/rimp-depr", "name: rimp-depr\ndescription: d");
  skill("skills/noname", "description: no name here");
  g(["add", "-A"], "2026-04-01T10:00:00Z");
  g(["commit", "-qm", "second"], "2026-04-01T10:00:00Z");
  return dir.replace(/\\/g, "/");
}

/** Real git against the fixture: the test URL becomes its file:// path; https-only flags dropped. */
function fixtureGit(fixture: string): GitRunner {
  return (args, opts) => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-c" && /^(protocol\.|http\.)/.test(args[i + 1] ?? "")) { i++; continue; }
      out.push(args[i] === URL_ ? `file://${fixture.startsWith("/") ? "" : "/"}${fixture}` : args[i]!);
    }
    return runGit(out, opts);
  };
}

test("import a whole repository: scan, submit, notifications, audit, direct, filters", { skip: !enabled }, async () => {
  const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;
  const nsRow = (slug: string, requireReview: boolean) =>
    one(
      `insert into namespaces (slug, display_name, require_review) values ($1, $1, $2)
       on conflict (slug) do update set require_review = excluded.require_review returning id`,
      [slug, requireReview],
    );
  const ns = await nsRow("rimp-ns", true);
  const nsDirect = await nsRow("rimp-direct", false);
  const other = await nsRow("rimp-other-ns", true);
  // Fixed actors (audit_log FK — never deleted).
  const mkUser = (oid: string) =>
    one(
      `insert into users (entra_object_id, email, display_name, status) values ($1, $1 || '@org', $1, 'active')
       on conflict (entra_object_id) do update set status = 'active', erased_at = null returning id`,
      [oid],
    );
  const sub = await mkUser("rimp-submitter");
  const rev = await mkUser("rimp-reviewer");
  const outsider = await mkUser("rimp-outsider");
  const grp = await one(
    `insert into groups (entra_object_id, display_name) values ('rimp-reviewers','rimp-reviewers')
     on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
  );
  await q(`delete from role_mappings where group_id = $1`, [grp]);
  await q(`insert into role_mappings (group_id, namespace_id, role) values ($1, $2, 'namespace_admin')`, [grp, ns]);
  await q(`insert into group_memberships (group_id, user_id) values ($1, $2) on conflict do nothing`, [grp, rev]);

  // Clean slate for this test's rows.
  await q(`delete from proposals where submitted_by = $1`, [sub]);
  await q(`delete from proposal_imports where submitted_by = $1`, [sub]);
  await q(`delete from notifications where user_id = any($1::uuid[])`, [[sub, rev]]);
  await q(`delete from skills where slug like 'rimp-%'`);

  const skill = (nsId: string, slug: string, visibility: "org" | "namespace") =>
    one(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1, $2, $2, 'd', 'generic', 'pointer', $3, 'active') returning id`,
      [nsId, slug, visibility],
    );
  await skill(other, "rimp-existing", "org");
  await skill(other, "rimp-hidden", "namespace");
  const shared = await skill(other, "rimp-shared", "namespace");
  await q(`insert into skill_namespace_grants (skill_id, namespace_id) values ($1, $2) on conflict do nothing`, [shared, ns]);
  await q(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1, 'rimp-archived', 'a', 'd', 'generic', 'pointer', 'org', 'archived')`,
    [other],
  );
  await q(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status, deprecated_at)
     values ($1, 'rimp-depr', 'a', 'd', 'generic', 'pointer', 'org', 'active', now())`,
    [other],
  );

  const access: EffectiveAccess & { userId: string } = {
    isPlatformAdmin: false,
    namespaceRoles: new Map([[ns, "namespace_member"], [nsDirect, "namespace_member"]]),
    userId: sub,
  };
  const fixture = fixtureRepo();
  const git = fixtureGit(fixture);

  // ── Scan ──────────────────────────────────────────────────────────────────────────────────
  const scan = await scanRepository(pool, access, { url: URL_, ref: "main" }, { git });
  assert.ok(scan.ok, JSON.stringify(scan));
  const rows = new Map(scan.result.skills.map((s) => [s.subdir, s]));
  assert.equal(scan.result.total, 9);
  assert.ok(scan.result.commit && /^[0-9a-f]{40}$/.test(scan.result.commit));
  assert.equal(scan.result.historyComplete, true);
  assert.equal(rows.get("skills/rimp-docx")!.importable, true);
  assert.equal(Date.parse(rows.get("skills/rimp-docx")!.lastChangedAt!), Date.parse("2026-03-01T10:00:00Z"));
  assert.equal(Date.parse(rows.get("skills/rimp-pdf")!.lastChangedAt!), Date.parse("2026-04-01T10:00:00Z"), "its nested example changed later");
  assert.equal(rows.get("skills/rimp-pdf")!.frontmatter?.version, "2.0.0");
  assert.equal(rows.get("skills/rimp-pdf/examples/rimp-mini")!.nestedIn, "skills/rimp-pdf");
  assert.equal(rows.get("skills/noname")!.reason, "no_name");
  assert.deepEqual(rows.get("skills/rimp-existing")!.match, { ns: "rimp-other-ns", slug: "rimp-existing", sameSource: false });
  assert.equal(rows.get("skills/rimp-shared")!.reason, "exists", "a §42 grant makes it visible");
  assert.equal(rows.get("skills/rimp-depr")!.reason, "exists", "deprecated still matches");
  assert.equal(rows.get("skills/rimp-hidden")!.importable, true, "a skill the caller can't see is never reported");
  assert.equal(rows.get("skills/rimp-hidden")!.match, undefined);
  assert.equal(rows.get("skills/rimp-archived")!.importable, true, "archived never matches");

  const bad = await scanRepository(pool, access, { url: URL_, ref: "no-such-ref" }, { git });
  assert.ok(!bad.ok && bad.status === 422);
  const hub = await scanRepository(pool, access, { url: "https://skills-hub.ai/api/v1/skills/x", ref: "1.0.0" }, { git });
  assert.ok(!hub.ok && hub.status === 422);

  // ── Submit (review) ───────────────────────────────────────────────────────────────────────
  const item = (subdir: string, slug: string): ImportItemInput => ({
    subdir,
    semver: "1.0.0",
    metadata: { skillSlug: slug, title: slug, description: "d", categories: [], toolHarness: "generic", usageExamples: null },
  });
  const base = { url: URL_, ref: "main", namespaceSlug: "rimp-ns", visibility: "namespace" as const, sharedNamespaceIds: [], mode: "review" as const };
  const sent = await submitImport(pool, access, { ...base, items: [item("skills/rimp-pdf", "rimp-pdf"), item("skills/rimp-docx", "rimp-docx"), item("skills/rimp-gone", "rimp-gone"), item("skills/rimp-depr", "rimp-depr")] }, { git });
  assert.ok(sent.ok, JSON.stringify(sent));
  const outcomes = Object.fromEntries(sent.result.results.map((r) => [r.slug, r]));
  assert.equal(outcomes["rimp-pdf"]!.outcome, "proposed");
  assert.equal(outcomes["rimp-docx"]!.outcome, "proposed");
  assert.equal(outcomes["rimp-gone"]!.outcome, "failed");
  assert.equal(outcomes["rimp-depr"]!.outcome, "failed");
  assert.equal(outcomes["rimp-depr"]!.code, "slug_exists");
  const importId = sent.result.importId;
  const { rows: props } = await q<{ id: string; import_id: string; commit: string }>(
    `select p.id, p.import_id, r.payload->'pointer'->>'commit' as commit
       from proposals p join proposal_revisions r on r.proposal_id = p.id and r.revision_no = 1
      where p.submitted_by = $1 order by p.created_at`,
    [sub],
  );
  assert.equal(props.length, 2);
  assert.ok(props.every((p) => p.import_id === importId && p.commit === sent.result.commit), "one import, one pinned commit");

  // Notifications: one each for the import; none per proposal.
  const notes = async (user: string) => (await q<{ type: string; payload: Record<string, unknown> }>(`select type, payload from notifications where user_id = $1`, [user])).rows;
  const revNotes = await notes(rev);
  assert.deepEqual(revNotes.map((n) => n.type), ["proposal.import_needs_review"]);
  assert.equal(revNotes[0]!.payload.count, 2);
  assert.equal(revNotes[0]!.payload.repo, "acme/rimp-skills");
  assert.deepEqual((await notes(sub)).map((n) => n.type), ["proposal.import_submitted"]);

  const audit = (await q<{ after: Record<string, unknown> }>(`select after from audit_log where action = 'proposal.import' and target_id = $1`, [importId])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.after.proposed, 2);
  assert.equal(audit[0]!.after.failed, 2);

  // Queue filter + detail block.
  const reviewerAccess: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_admin"]]) };
  const queue = await listReviewQueue(pool, reviewerAccess, { importId });
  assert.equal(queue.total, 2);
  assert.ok(queue.items.every((i) => i.importId === importId && i.importRepo === "acme/rimp-skills"));
  assert.equal((await listMySubmissions(pool, sub, { importId })).length, 2);
  const detail = await getProposalDetail(pool, props[0]!.id, reviewerAccess, rev);
  assert.equal(detail?.import?.id, importId);
  assert.equal(detail?.import?.others, 1);

  // ── Whole-import checks ───────────────────────────────────────────────────────────────────
  const many = Array.from({ length: 51 }, (_, i) => item(`skills/x${i}`, `rimp-x${i}`));
  const tooMany = await submitImport(pool, access, { ...base, items: many }, { git });
  assert.ok(!tooMany.ok && tooMany.status === 422);
  const fortyNine = Array.from({ length: 49 }, (_, i) => item(`skills/x${i}`, `rimp-x${i}`));
  const continued = await submitImport(pool, access, { ...base, importId, items: fortyNine }, { git });
  assert.ok(!continued.ok && continued.status === 422, "the 2 already created count toward 50");
  const dupes = await submitImport(pool, access, { ...base, items: [item("skills/rimp-pdf", "rimp-a"), item("skills/rimp-docx", "rimp-a")] }, { git });
  assert.ok(!dupes.ok && dupes.status === 422);
  const outsiderAccess: EffectiveAccess & { userId: string } = { isPlatformAdmin: false, namespaceRoles: new Map(), userId: outsider };
  const theirs = await submitImport(pool, outsiderAccess, { ...base, importId, items: [item("skills/rimp-hidden", "rimp-hidden")] }, { git });
  assert.ok(!theirs.ok && theirs.status === 404, "someone else's import");
  await q(`insert into platform_settings (key, value) values ('proposals_open', 'false'::jsonb) on conflict (key) do update set value = excluded.value`);
  invalidatePlatformSettings();
  try {
    const closed = await submitImport(pool, outsiderAccess, { ...base, items: [item("skills/rimp-hidden", "rimp-hidden")] }, { git });
    assert.ok(!closed.ok && closed.status === 403);
  } finally {
    await q(`delete from platform_settings where key = 'proposals_open'`);
    invalidatePlatformSettings();
  }
  const noDirect = await submitImport(pool, access, { ...base, mode: "direct", items: [item("skills/rimp-hidden", "rimp-hidden")] }, { git });
  assert.ok(!noDirect.ok && noDirect.status === 403, "require_review namespace");

  // ── Direct mode ───────────────────────────────────────────────────────────────────────────
  const direct = await submitImport(
    pool,
    access,
    { ...base, namespaceSlug: "rimp-direct", mode: "direct", items: [item("skills/rimp-hidden", "rimp-hidden"), item("skills/rimp-archived", "rimp-archived")] },
    {
      git,
      fetchContent: async (_u, _r, subdir) =>
        subdir === "skills/rimp-archived"
          ? { ok: false, error: "unreachable" }
          : { ok: true, entries: [{ path: "SKILL.md", bytes: new TextEncoder().encode("---\nname: rimp-hidden\ndescription: d\n---\nBody.\n") }] },
    },
  );
  assert.ok(direct.ok, JSON.stringify(direct));
  const d = Object.fromEntries(direct.result.results.map((r) => [r.slug, r]));
  assert.equal(d["rimp-hidden"]!.outcome, "published");
  assert.equal(d["rimp-archived"]!.outcome, "routed");
  assert.equal(d["rimp-archived"]!.routedReason, "content_risk");
  const routedImport = (await q<{ import_id: string }>(`select import_id from proposals where id = $1`, [d["rimp-archived"]!.proposalId])).rows[0]!;
  assert.equal(routedImport.import_id, direct.result.importId, "a routed skill joins the import");
});
