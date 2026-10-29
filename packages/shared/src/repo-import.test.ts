// Unit tests for the §64 repository-import rules (SKILLY_SPEC.md §64.12).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMPORT_MAX_SKILLS,
  discoverSkillPaths,
  frontmatterImportReason,
  importNotificationContent,
  importPrefill,
  importReasonText,
  isImportableName,
  isInFolder,
  lastChangedByFolder,
  nestedSkillFolders,
  parseNameOnlyLog,
  repoLabel,
  sameNameBlockers,
  tickAllImportable,
  titleize,
} from "./repo-import.js";
import { DIGEST_FLOOR_TYPES, DIGEST_OPTIONAL_TYPES, renderDigest } from "./email-digest.js";

test("discoverSkillPaths: exact-case SKILL.md anywhere, root included, unsafe paths skipped, path order", () => {
  const paths = [
    "README.md",
    "skills/pdf/SKILL.md",
    "skills/pdf/scripts/run.sh",
    "SKILL.md",
    ".claude/skills/review/SKILL.md",
    "skills/docx/skill.md", // wrong case: not a skill
    "skills/pdf-tools/SKILL.md",
    "notSKILL.md",
    "a/../b/SKILL.md", // unsafe
    "plugins/p/skills/s/SKILL.md",
  ];
  const { found, total } = discoverSkillPaths(paths);
  assert.equal(total, 5);
  assert.deepEqual(
    found.map((f) => [f.path, f.subdir]),
    [
      [".claude/skills/review/SKILL.md", ".claude/skills/review"],
      ["SKILL.md", null],
      ["plugins/p/skills/s/SKILL.md", "plugins/p/skills/s"],
      ["skills/pdf-tools/SKILL.md", "skills/pdf-tools"],
      ["skills/pdf/SKILL.md", "skills/pdf"],
    ],
  );
});

test("discoverSkillPaths: a folder narrows the scan on whole segments; the cut keeps the total", () => {
  const paths = ["skills/a/SKILL.md", "skills/b/SKILL.md", "skillset/c/SKILL.md", "SKILL.md"];
  assert.deepEqual(discoverSkillPaths(paths, "/skills/").found.map((f) => f.subdir), ["skills/a", "skills/b"]);
  const cut = discoverSkillPaths(paths, null, 2);
  assert.equal(cut.found.length, 2);
  assert.equal(cut.total, 4);
});

test("isInFolder and nestedSkillFolders: whole segments; the nearest containing skill wins; the root holds all", () => {
  assert.ok(isInFolder("skills/pdf/x.md", "skills/pdf"));
  assert.ok(!isInFolder("skills/pdf-tools/x.md", "skills/pdf"));
  assert.ok(isInFolder("anything", null));
  const nested = nestedSkillFolders(["skills/pdf", "skills/pdf/examples/mini", "skills/pdf-tools", null, "skills/pdf/examples/mini/deeper"]);
  assert.equal(nested.get("skills/pdf/examples/mini"), "skills/pdf");
  assert.equal(nested.get("skills/pdf/examples/mini/deeper"), "skills/pdf/examples/mini");
  assert.equal(nested.get("skills/pdf"), "", "the repository root contains it");
  assert.equal(nested.get("skills/pdf-tools"), "");
  assert.equal(nested.has(""), false);
  assert.equal(nestedSkillFolders(["a", "b"]).size, 0);
});

test("parseNameOnlyLog + lastChangedByFolder: newest touch per folder, whole-segment prefixes", () => {
  const out =
    "\u00002026-10-20T10:00:00+00:00\n\nskills/pdf-tools/SKILL.md\n" +
    "\u00002026-10-10T10:00:00+00:00\n\nskills/pdf/scripts/run.sh\nREADME.md\n" +
    "\u00002026-09-01T10:00:00+00:00\n\nskills/pdf/SKILL.md\nskills/docx/SKILL.md\n" +
    "\u0000not-a-date\n\nx\n";
  const commits = parseNameOnlyLog(out);
  assert.equal(commits.length, 3);
  assert.deepEqual(commits[1]!.paths, ["skills/pdf/scripts/run.sh", "README.md"]);
  const m = lastChangedByFolder(commits, ["skills/pdf", "skills/pdf-tools", "skills/docx", "skills/xlsx", null]);
  assert.equal(m.get("skills/pdf"), "2026-10-10T10:00:00+00:00", "skills/pdf-tools' change is not skills/pdf's");
  assert.equal(m.get("skills/pdf-tools"), "2026-10-20T10:00:00+00:00");
  assert.equal(m.get("skills/docx"), "2026-09-01T10:00:00+00:00");
  assert.equal(m.has("skills/xlsx"), false, "untouched in the window");
  assert.equal(m.get(""), "2026-10-20T10:00:00+00:00", "the root takes the newest commit");
});

test("importability: no name, no description, invalid name; the reason sentences", () => {
  assert.equal(frontmatterImportReason({ description: "d" }), "no_name");
  assert.equal(frontmatterImportReason({ name: "pdf" }), "no_description");
  assert.equal(frontmatterImportReason({ name: "PDF Tools", description: "d" }), "invalid_name");
  assert.equal(frontmatterImportReason({ name: "pdf-tools", description: "d" }), null);
  assert.ok(isImportableName("a"));
  assert.ok(isImportableName("x".repeat(64)));
  assert.ok(!isImportableName("x".repeat(65)));
  assert.ok(!isImportableName("-pdf"));
  assert.ok(!isImportableName("pdf_tools"));
  assert.equal(importReasonText("no_name"), "Can't import: SKILL.md has no name");
  assert.equal(importReasonText("invalid_name", { name: "PDF" }), "Can't import: name ‹PDF› isn't a valid skill slug");
  assert.equal(importReasonText("exists", { match: { ns: "team", slug: "pdf" } }), "Already in skilly as team/pdf");
});

test("tickAllImportable: path order, importable only, one per name, capped", () => {
  const rows = [
    { path: "z/SKILL.md", name: "z", importable: true },
    { path: "b/SKILL.md", name: "dup", importable: true },
    { path: "a/SKILL.md", name: "dup", importable: true },
    { path: "c/SKILL.md", name: "c", importable: false },
    { path: "d/SKILL.md", name: null, importable: true },
  ];
  assert.deepEqual(tickAllImportable(rows), ["a/SKILL.md", "z/SKILL.md"]);
  const many = Array.from({ length: 60 }, (_, i) => ({ path: `s${String(i).padStart(2, "0")}/SKILL.md`, name: `s${i}`, importable: true }));
  const ticked = tickAllImportable(many);
  assert.equal(ticked.length, IMPORT_MAX_SKILLS);
  assert.equal(ticked[0], "s00/SKILL.md");
});

test("sameNameBlockers: an unticked row with a ticked row's name is disabled by it", () => {
  const rows = [
    { path: "a/SKILL.md", name: "pdf" },
    { path: "b/SKILL.md", name: "pdf" },
    { path: "c/SKILL.md", name: "docx" },
  ];
  const m = sameNameBlockers(rows, new Set(["a/SKILL.md"]));
  assert.equal(m.get("b/SKILL.md"), "a/SKILL.md");
  assert.equal(m.has("a/SKILL.md"), false);
  assert.equal(m.has("c/SKILL.md"), false);
  assert.equal(sameNameBlockers(rows, new Set()).size, 0);
});

test("importPrefill: titleized name, frontmatter fields, semver fallback, invalid category dropped", () => {
  const p = importPrefill(
    { name: "case-study_creator", description: "  Makes case studies.  ", frontmatter: { usageExamples: "Ask it", category: "Writing", version: "2.1.0" } },
    "claude-code",
  );
  assert.deepEqual(p, {
    skillSlug: "case-study_creator",
    title: "Case Study Creator",
    description: "Makes case studies.",
    usageExamples: "Ask it",
    categories: ["writing"],
    semver: "2.1.0",
    toolHarness: "claude-code",
  });
  const q = importPrefill({ name: "pdf", description: "d", frontmatter: { usageExamples: null, category: "general", version: "1.0" } }, "generic");
  assert.deepEqual(q.categories, [], "a reserved category is dropped");
  assert.equal(q.semver, "1.0.0", "an invalid version falls back to 1.0.0");
  assert.equal(importPrefill({ name: "pdf", description: "d" }, "generic").semver, "1.0.0");
  assert.equal(titleize("social-media-manager"), "Social Media Manager");
});

test("repoLabel: owner/repo from a git URL", () => {
  assert.equal(repoLabel("https://github.com/anthropics/skills.git"), "anthropics/skills");
  assert.equal(repoLabel("https://git.example.com/group/sub/repo"), "group/sub/repo");
  assert.equal(repoLabel("not a url"), "not a url");
});

test("importNotificationContent: both types' wording and links; other types null", () => {
  const review = importNotificationContent("proposal.import_needs_review", { importId: "abc", ns: "team", repo: "acme/skills", count: 3, fromName: "Ana" });
  assert.deepEqual(review, {
    sentence: "Ana imported 3 skills from acme/skills into team. They are awaiting your review.",
    ctaLabel: "Review them",
    path: "/proposals?tab=review&import=abc",
  });
  const mine = importNotificationContent("proposal.import_submitted", { importId: "abc", ns: "team", repo: "acme/skills", count: 1 });
  assert.deepEqual(mine, {
    sentence: "Your import of 1 skill from acme/skills was submitted and is awaiting review.",
    ctaLabel: "View it",
    path: "/proposals?tab=mine&import=abc",
  });
  assert.equal(importNotificationContent("proposal.needs_review", {}), null);
});

test("digest tiers and line: the reviewer notification is never digested; the submitter's links to its import", () => {
  assert.ok((DIGEST_FLOOR_TYPES as readonly string[]).includes("proposal.import_needs_review"));
  assert.ok((DIGEST_OPTIONAL_TYPES as readonly string[]).includes("proposal.import_submitted"));
  const d = renderDigest(
    [{ id: "n1", type: "proposal.import_submitted", payload: { importId: "imp-1", ns: "team", repo: "acme/skills", count: 2 }, createdAt: "2026-10-29T10:00:00Z" }],
    { mode: "daily", baseUrl: "https://skilly.example", bodySentence: () => "Your import of 2 skills from acme/skills was submitted and is awaiting review." },
  );
  assert.match(d.text, /https:\/\/skilly\.example\/proposals\?tab=mine&import=imp-1/);
});
