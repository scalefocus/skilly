// Unit tests for the quality scanner, score maths, verdict validation and prompt builder (§41.13).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  qualityScanner, scanQuality, splitSkillMd, parseFrontmatterYaml, qualityRuleCatalogFingerprint,
  buildQualityPrompt, QUALITY_PROMPT_BODY_MAX, QUALITY_PROMPT_PATHS_MAX,
} from "./quality.js";
import {
  QUALITY_AI_MAX_TOKENS,
  QUALITY_RULESET_VERSION, QUALITY_FINDINGS_PER_RULE, QUALITY_COUNTED_PER_RULE, QUALITY_LEVEL_OF, QUALITY_RULES,
  scoreQuality, qualityStars, finalQualityScore, validateQualityVerdict, aiScoreOf, qualityFindings, qualityRulesetOf,
  groupQualityFindings, qualityModeLine, formatStars, type QualityRule,
} from "./quality-status.js";
import { PURE_SCANNERS, runScanners, maxSeverity, requiresOverride, isSecretLikeLine, type ScanFinding } from "./scan.js";
import type { BundleEntry } from "./validate.js";

const enc = (s: string) => new TextEncoder().encode(s);
const file = (path: string, text: string): BundleEntry => ({ path, bytes: enc(text) });
const rules = (fs: ScanFinding[]) => fs.map((f) => f.rule);
const has = (fs: ScanFinding[], r: string) => fs.some((f) => f.rule === r);

/** A skill the guide would call complete: every rule passes. */
const GOOD_FM = `---
name: pdf-tools
description: Processes PDF legal documents for contract review. Use this when the user says "review this contract" or "extract clauses from a PDF". Do not use for spreadsheets.
license: MIT
compatibility: Requires Python 3 with pypdf
metadata:
  version: 1.2.0
  author: Legal Ops
---
`;
const GOOD_BODY = `# PDF Tools

## Instructions

1. Run \`python scripts/extract.py --input {filename}\`
   Expected output: a JSON list of clauses.
2. Review references/clauses.md for the clause taxonomy.

## Examples

User says: "review this contract"

## Troubleshooting

If the extraction fails, retry with --ocr.
`;
const good = (): BundleEntry[] => [
  file("SKILL.md", GOOD_FM + GOOD_BODY),
  file("scripts/extract.py", "import json\nprint(json.dumps([]))\n"),
  file("references/clauses.md", "# Clauses\n"),
];

test("a complete skill is clean: only the qa-scanned marker, severity info, score 100 / 5 stars", () => {
  const out = qualityScanner.scan(good()) as ScanFinding[];
  assert.deepEqual(rules(out), ["qa-scanned"]);
  assert.ok(out.every((f) => f.severity === "info"));
  assert.equal(out[0]!.ruleset, QUALITY_RULESET_VERSION);
  assert.equal(scoreQuality(out), 100);
  assert.equal(qualityStars(scoreQuality(out)), 5);
  assert.equal(qualityRulesetOf(out), QUALITY_RULESET_VERSION);
});

test("every quality finding carries severity info and never trips the override gate", async () => {
  const bundle = [file("SKILL.md", "---\nname: my-claude-skill\ndescription: Helps with projects.\nweird: <b>\n---\n"), file("README.md", "x")];
  const out = await runScanners(bundle, PURE_SCANNERS);
  const q = out.filter((f) => f.scanner === "quality");
  assert.ok(q.length > 5);
  assert.ok(q.every((f) => f.severity === "info" && f.level !== undefined));
  assert.equal(maxSeverity(q), "info");
  assert.equal(requiresOverride(maxSeverity(q)), false);
  assert.equal(q.filter((f) => f.rule === "qa-scanned").length, 1);
});

// ── FS ──
test("FS-003: README at the root is error, in a sub-folder a warn; FS-004/FS-005 for other entries", () => {
  const out = scanQuality([...good(), file("README.md", "x"), file("references/readme.txt", "x"), file("notes.md", "x"), file("extra/x.bin", "x"), file(".DS_Store", "x")]);
  const readme = out.filter((f) => f.rule === "FS-003");
  assert.deepEqual(readme.map((f) => [f.path, f.level]), [["README.md", "error"], ["references/readme.txt", "error"]]);
  assert.ok(out.some((f) => f.rule === "FS-005" && f.path === "notes.md"));
  assert.ok(out.some((f) => f.rule === "FS-004" && f.path === "extra/"));
  assert.ok(out.some((f) => f.rule === "FS-004" && f.path === ".DS_Store"));
  assert.ok(!out.some((f) => f.rule === "FS-004" && f.path === "README.md"));
});

test("FS-004: skilly's auto-detected icon.png at the root is a recognised entry", () => {
  const out = scanQuality([...good(), file("icon.png", "x")]);
  assert.ok(!has(out, "FS-004"));
});

// ── FM ──
test("FM-001 BOM, FM-005 tags, FM-006 brackets, FM-007 anchors", () => {
  const out = scanQuality([file("SKILL.md", "\uFEFF---\nname: pdf-tools\ndescription: " + GOOD_FM.split("\n")[2]!.slice(13) + "\nextra: !!python/object x\nbase: &b 1\nother: *b\n<<: *b\ntool: <generic>\n---\n" + GOOD_BODY)]);
  assert.ok(has(out, "FM-001"));
  assert.equal(out.find((f) => f.rule === "FM-001")!.level, "warn");
  assert.ok(has(out, "FM-005"));
  assert.ok(out.some((f) => f.rule === "FM-006" && f.excerpt === "tool: <generic>"));
  assert.equal(out.filter((f) => f.rule === "FM-007").length, 2);
});

test("FD-007 owns the description's brackets; FM-006 is not repeated for them", () => {
  const out = scanQuality([file("SKILL.md", "---\nname: pdf-tools\ndescription: Processes <PDF> files. Use when the user says \"review\" and more words here to pass.\n---\n" + GOOD_BODY)]);
  assert.ok(has(out, "FD-007"));
  assert.ok(!has(out, "FM-006"));
});

// ── FD: the guide's names ──
test("FD-003: 'claude' or 'anthropic' anywhere in name (contains, not prefix)", () => {
  for (const name of ["claude-helper", "my-claude-skill", "anthropic-tools", "AnthropicX"]) {
    const out = scanQuality([file("SKILL.md", `---\nname: ${name}\ndescription: x\n---\n# T\n`)]);
    assert.ok(has(out, "FD-003"), name);
  }
  for (const name of ["pdf-tools", "my-cool-skill", "notion-project-setup"]) {
    const out = scanQuality([file("SKILL.md", `---\nname: ${name}\ndescription: x\n---\n# T\n`)]);
    assert.ok(!has(out, "FD-003"), name);
  }
});

test("FD-006 over 1024 code points; FD-008 compatibility; FD-009 license; FD-010 metadata mapping", () => {
  const long = "é".repeat(1025);
  const out = scanQuality([file("SKILL.md", `---\nname: a\ndescription: ${long}\ncompatibility: 3\nlicense: ""\nmetadata: just-a-string\n---\n# T\n`)]);
  assert.ok(has(out, "FD-006"));
  assert.ok(has(out, "FD-008"));
  assert.ok(out.some((f) => f.rule === "FD-009" && f.level === "warn"));
  assert.ok(has(out, "FD-010"));
  const ok = scanQuality([file("SKILL.md", `---\nname: a\ndescription: ${"x".repeat(1024)}\ncompatibility: "Python 3"\nlicense: WTFPL\n---\n# T\n`)]);
  assert.ok(!has(ok, "FD-006"));
  assert.ok(!has(ok, "FD-008"));
  assert.ok(ok.some((f) => f.rule === "FD-009" && /SPDX/.test(f.message)));
});

test("FD-011/012/013/014/015 and skilly's own keys are known", () => {
  const out = scanQuality([file("SKILL.md", `---\nname: a\ndescription: Talks to an MCP server.\nallowed-tools: Bash(python:*) Web-Fetch\nmetadata:\n  version: v1\ncustom: 1\ncategory: tools\nusage_examples: x\nicon: assets/i.png\n---\n# T\nCall MCP tool: list\n`), file("assets/i.png", "x")]);
  assert.ok(out.some((f) => f.rule === "FD-011" && /not x\.y\.z/.test(f.message)));
  assert.ok(has(out, "FD-012"));
  assert.ok(has(out, "FD-013"));
  assert.ok(out.some((f) => f.rule === "FD-014" && /Web-Fetch/.test(f.message)));
  const unknown = out.filter((f) => f.rule === "FD-015");
  assert.deepEqual(unknown.map((f) => f.message.match(/"([^"]+)"/)![1]), ["custom"]);
});

// ── DS: the guide's descriptions ──
const GOOD_DESCRIPTIONS = [
  'Creates and manages Notion workspaces, pages and databases. Use this when the user says "set up a Notion project" or "create a Notion page".',
  'Generates sales forecasts from CRM exports. Use when the user asks for "pipeline forecast" or "quarterly projection". Do not use for raw data exploration.',
  'Processes PDF legal documents for contract review. Use when the user says "review this contract". Not for spreadsheets or presentations.',
  'Runs the Acme deployment checklist. Trigger when the user mentions "deploy to staging" or "release checklist".',
  'Analyzes Figma design files and produces accessibility reports. Use when the user asks to "audit this design" or "check contrast".',
  'Onboards new customers in ProjectHub by creating the workspace, inviting members and seeding tasks. Use when the user says "onboard new customer".',
];
const BAD_DESCRIPTIONS: Record<string, string[]> = {
  "Helps with projects.": ["DS-001", "DS-003", "DS-007"],
  "Processes documents": ["DS-001", "DS-003", "DS-007"],
  "Creates sophisticated multi-page documentation systems.": ["DS-001", "DS-003"],
  "Processes PDF legal documents for contract review": ["DS-001", "DS-003"],
  "Use when the user asks for help with anything related to their projects or tasks.": ["DS-004", "DS-007"],
};
const withDesc = (d: string) => scanQuality([file("SKILL.md", `---\nname: a\ndescription: ${d}\n---\n# T\n`)]);

test("DS: the guide's good descriptions raise no DS warn; its bad ones raise the expected rules", () => {
  for (const d of GOOD_DESCRIPTIONS) {
    const warns = withDesc(d).filter((f) => f.rule.startsWith("DS-") && f.level === "warn");
    assert.deepEqual(rules(warns), [], d);
  }
  for (const [d, expected] of Object.entries(BAD_DESCRIPTIONS)) {
    const got = rules(withDesc(d)).filter((r) => r.startsWith("DS-"));
    for (const r of expected) assert.ok(got.includes(r), `${d} → ${r} (got ${got.join(",")})`);
  }
});

test("DS-002 / DS-005 / DS-006 are info; DS-006 ignores SKILL.md itself", () => {
  const noQuote = withDesc("Processes PDF legal documents for contract review. Use when the user asks about contracts.");
  assert.ok(noQuote.some((f) => f.rule === "DS-002" && f.level === "info"));
  assert.ok(noQuote.some((f) => f.rule === "DS-005" && f.level === "info"));
  const out = scanQuality([file("SKILL.md", `---\nname: a\ndescription: Reviews Acme contracts. Use when the user says "review".\n---\n# T\nOpen the .docx and SKILL.md\n`)]);
  assert.ok(has(out, "DS-006"));
  const only = scanQuality([file("SKILL.md", `---\nname: a\ndescription: Reviews Acme contracts. Use when the user says "review".\n---\n# T\nSee SKILL.md\n`)]);
  assert.ok(!has(only, "DS-006"));
});

// ── BD ──
test("BD rules on a bare body", () => {
  const out = scanQuality([file("SKILL.md", GOOD_FM + "# T\n# Second\nMake sure to validate things properly.\nTake your time.\n")]);
  for (const r of ["BD-003", "BD-004", "BD-005", "BD-006", "BD-007", "BD-009", "BD-010", "BD-011"]) assert.ok(has(out, r), r);
  const vague = out.find((f) => f.rule === "BD-010")!;
  assert.equal(vague.line, 12);
  assert.match(vague.excerpt!, /validate things/);
  assert.ok(!has(scanQuality(good()), "BD-010"));
});

test("BD-002 / RF-003 word thresholds; BD-008 critical heading past 40 %; BD-012 lookahead", () => {
  const many = "word ".repeat(2600);
  const out = scanQuality([file("SKILL.md", GOOD_FM + "# T\n" + many + "\n")]);
  assert.ok(has(out, "RF-003"));
  assert.ok(!has(out, "BD-002"));
  const more = scanQuality([file("SKILL.md", GOOD_FM + "# T\n" + "word ".repeat(5100) + "\n"), file("references/a.md", "x")]);
  assert.ok(has(more, "BD-002"));
  assert.ok(!has(more, "RF-003"));
  const late = scanQuality([file("SKILL.md", GOOD_FM + "# T\n" + "line\n".repeat(20) + "## Important\n" + "line\n".repeat(5))]);
  assert.ok(has(late, "BD-008"));
  const early = scanQuality([file("SKILL.md", GOOD_FM + "# T\n## Critical\n" + "line\n".repeat(20))]);
  assert.ok(!has(early, "BD-008"));
  const noOut = scanQuality([file("SKILL.md", GOOD_FM + "# T\n1. python scripts/extract.py\n2. go on\n"), ...good().slice(1)]);
  assert.ok(has(noOut, "BD-012"));
  assert.ok(!has(scanQuality(good()), "BD-012"));
});

test("fenced code is excluded from prose rules (BD-010, PT-003) but counts for BD-009", () => {
  const out = scanQuality([file("SKILL.md", GOOD_FM + "# T\n```\nmake sure to do things <tag>\n```\n1. step\n")]);
  assert.ok(!has(out, "BD-010"));
  assert.ok(!has(out, "PT-003"));
  assert.ok(!has(out, "BD-009"));
});

// ── RF ──
test("RF-001 missing reference (trailing punctuation stripped), RF-002 orphan, RF-004 link, RF-005 wrong folder", () => {
  const out = scanQuality([
    file("SKILL.md", GOOD_FM + "# T\nRun scripts/missing.py.\nSee [doc](references/none.md) and [ok](references/clauses.md)\n1. python scripts/extract.py\n   Returns JSON\n"),
    file("scripts/extract.py", "x"), file("references/clauses.md", "x"),
    file("references/helper.py", "x"), file("scripts/notes.md", "x"), file("assets/orphan.png", "x"), file("references/.hidden", "x"), file("scripts/__init__.py", ""),
  ]);
  assert.ok(out.some((f) => f.rule === "RF-001" && /scripts\/missing\.py$/.test(f.message) && f.line === 11));
  assert.ok(!out.some((f) => f.rule === "RF-001" && /clauses/.test(f.message)));
  assert.ok(out.some((f) => f.rule === "RF-004" && /none\.md/.test(f.message)));
  const orphans = out.filter((f) => f.rule === "RF-002").map((f) => f.path).sort();
  assert.deepEqual(orphans, ["assets/orphan.png", "references/helper.py", "scripts/notes.md"]);
  assert.ok(out.some((f) => f.rule === "RF-005" && f.path === "references/helper.py"));
  assert.ok(out.some((f) => f.rule === "RF-005" && f.path === "scripts/notes.md"));
});

// ── SC / PT ──
test("SC-004 third-party import without compatibility; stdlib is fine", () => {
  const fm = "---\nname: a\ndescription: x\n---\n# T\nscripts/x.py\n";
  assert.ok(has(scanQuality([file("SKILL.md", fm), file("scripts/x.py", "import requests\n")]), "SC-004"));
  assert.ok(!has(scanQuality([file("SKILL.md", fm), file("scripts/x.py", "import json\nfrom pathlib import Path\n")]), "SC-004"));
  assert.ok(has(scanQuality([file("SKILL.md", fm), file("scripts/requirements.txt", "requests\n")]), "SC-004"));
  assert.ok(!has(scanQuality([file("SKILL.md", fm.replace("description: x", "description: x\ncompatibility: requests")), file("scripts/x.py", "import requests\n")]), "SC-004"));
});

test("PT-001 absolute paths, PT-002 secrets, PT-003 XML-like tags; a bare > and 'Settings > Extensions' are clean", () => {
  const out = scanQuality([file("SKILL.md", GOOD_FM + "# T\nOpen /Users/me/file and C:\\work\\x\napi_key = abcdefghijklmnop123\n<thinking>plan</thinking>\nCheck Settings > Extensions\n"), file("scripts/run.sh", "#!/bin/sh\ncd /home/bob/app\nexport TOKEN=sk-abcdefghijklmnopqrstuvwxyz1234\n")]);
  assert.equal(out.filter((f) => f.rule === "PT-001").length, 2);
  assert.equal(out.filter((f) => f.rule === "PT-002").length, 2);
  const xml = out.filter((f) => f.rule === "PT-003");
  assert.equal(xml.length, 1);
  assert.match(xml[0]!.message, /<thinking>/);
});

// ── caps, markers, binaries ──
test("at most 5 findings per rule per file; the fifth says how many more; binaries are skipped", () => {
  const body = "# T\n" + "do things\n".repeat(12);
  const out = scanQuality([file("SKILL.md", GOOD_FM + body), { path: "assets/x.bin", bytes: new Uint8Array([0, 1, 2]) }]);
  const vague = out.filter((f) => f.rule === "BD-010");
  assert.equal(vague.length, QUALITY_FINDINGS_PER_RULE);
  assert.match(vague[4]!.message, /7 more not shown/);
});

// ── frontmatter parser ──
test("frontmatter subset: nested mappings, block scalars, lists, quotes, comments", () => {
  const { value, keyLines } = parseFrontmatterYaml(`name: "a"
description: >
  Folded first
  line continues

  New paragraph
license: MIT # comment
metadata:
  version: 1.0.0
  nested:
    deep: true
tags:
  - one
  - "two"
inline: [a, b]
empty:
`);
  assert.equal(value.name, "a");
  assert.equal(value.description, "Folded first line continues\nNew paragraph");
  assert.equal(value.license, "MIT");
  assert.deepEqual(value.metadata, { version: "1.0.0", nested: { deep: true } });
  assert.deepEqual(value.tags, ["one", "two"]);
  assert.deepEqual(value.inline, ["a", "b"]);
  assert.equal(value.empty, null);
  assert.equal(keyLines.license, 7);
  const split = splitSkillMd("\uFEFF---\na: 1\n---\nbody\n");
  assert.deepEqual(split, { bom: true, raw: "a: 1", rawStartLine: 2, body: "body\n", bodyStartLine: 4 });
  assert.equal(splitSkillMd("no frontmatter").raw, null);
});

// ── score maths ──
test("scoreQuality: deductions 20/6/2, at most 3 per rule count, floor 0; markers cost nothing", () => {
  const f = (rule: QualityRule, n: number): ScanFinding[] =>
    Array.from({ length: n }, () => ({ scanner: "quality", severity: "info", level: QUALITY_LEVEL_OF[rule], rule, message: "" }));
  const marker: ScanFinding = { scanner: "quality", severity: "info", rule: "qa-scanned", message: "", ruleset: 1 };
  assert.equal(scoreQuality([marker]), 100);
  assert.equal(scoreQuality([...f("FS-003", 1)]), 80);
  assert.equal(scoreQuality([...f("DS-001", 1), ...f("DS-002", 1)]), 92);
  assert.equal(scoreQuality(f("RF-001", 5)), 100 - 20 * QUALITY_COUNTED_PER_RULE);
  assert.equal(scoreQuality([...f("RF-001", 3), ...f("FS-003", 3), ...f("FM-005", 3)]), 0);
  // A content-risk finding is not a quality finding.
  assert.equal(scoreQuality([{ scanner: "content-risk", severity: "high", rule: "cr-hidden-unicode", message: "" }]), 100);
  assert.equal(qualityFindings([marker, ...f("DS-001", 1)]).length, 1);
});

test("qualityStars at every band edge; 2 stars or below means score < 40", () => {
  const cases: [number, number][] = [[100, 5], [90, 5], [89, 4.5], [80, 4.5], [79, 4], [70, 4], [60, 3.5], [50, 3], [40, 2.5], [39, 2], [30, 2], [20, 1.5], [19, 1], [10, 1], [9, 0.5], [0, 0.5]];
  for (const [score, stars] of cases) assert.equal(qualityStars(score), stars, `score ${score}`);
  assert.equal(formatStars(4.5), "4.5");
  assert.equal(formatStars(4), "4");
});

test("finalQualityScore: rules only without AI; 60/40 blend rounded with AI", () => {
  assert.equal(finalQualityScore(73, null), 73);
  assert.equal(finalQualityScore(100, 50), 80);
  assert.equal(finalQualityScore(80, 90), 84);
  assert.equal(finalQualityScore(75, 60), 69);
});

test("ruleset fingerprint is pinned: change a rule or threshold, bump QUALITY_RULESET_VERSION and this hash", () => {
  assert.deepEqual({ version: QUALITY_RULESET_VERSION, fingerprint: qualityRuleCatalogFingerprint() }, { version: 1, fingerprint: "be296738" });
});

test("every rule has a label, a hint and a level", () => {
  for (const rule of Object.keys(QUALITY_RULES) as QualityRule[]) {
    assert.ok(QUALITY_RULES[rule].label && QUALITY_RULES[rule].hint, rule);
    assert.ok(QUALITY_LEVEL_OF[rule], rule);
  }
});

test("groupQualityFindings: errors first, markers excluded; qualityModeLine", () => {
  const fs: ScanFinding[] = [
    { scanner: "quality", severity: "info", level: "info", rule: "DS-002", message: "" },
    { scanner: "quality", severity: "info", level: "error", rule: "FS-003", message: "" },
    { scanner: "quality", severity: "info", rule: "qa-scanned", message: "", ruleset: 1 },
  ];
  assert.deepEqual(groupQualityFindings(fs).map((g) => [g.level, g.findings.length]), [["error", 1], ["info", 1]]);
  assert.equal(qualityModeLine("rules+ai", "done", "m1"), "Rules + AI assessment (m1)");
  assert.equal(qualityModeLine("rules", "pending", null), "Rules only — AI assessment pending");
  assert.equal(qualityModeLine("rules", "failed", null), "Rules only — AI assessment unavailable");
  assert.equal(qualityModeLine("rules", "off", null), "Rules only");
});

// ── verdict ──
test("validateQualityVerdict: all five integer dimensions required; strings capped; fenced numbers rejected", () => {
  const ok = validateQualityVerdict({
    clarity: { score: 80, remark: "r".repeat(400) }, triggers: 70, domain: { score: 90 }, workflow: { score: 60, remark: "w" }, composability: { score: 100 },
    summary: "s".repeat(600), suggestions: ["a", "", "b".repeat(400), "c", "d", "e", "f"], extra: 1,
  }, "model-x");
  assert.ok(ok);
  assert.equal(ok!.dimensions.clarity.remark.length, 300);
  assert.equal(ok!.dimensions.triggers.remark, "");
  assert.equal(ok!.summary.length, 500);
  assert.deepEqual(ok!.suggestions.map((s) => s.length), [1, 300, 1, 1, 1]);
  assert.equal(ok!.model, "model-x");
  assert.equal(aiScoreOf(ok!), 80);
  assert.equal(validateQualityVerdict({ clarity: 80, triggers: 70, domain: 90, workflow: 60 }, "m"), null);
  assert.equal(validateQualityVerdict({ clarity: 80, triggers: 70, domain: 90, workflow: 60, composability: 101 }, "m"), null);
  assert.equal(validateQualityVerdict({ clarity: 80.5, triggers: 70, domain: 90, workflow: 60, composability: 1 }, "m"), null);
  assert.equal(validateQualityVerdict({ clarity: "80", triggers: 70, domain: 90, workflow: 60, composability: 1 }, "m"), null);
  assert.equal(validateQualityVerdict([1], "m"), null);
  assert.equal(validateQualityVerdict(null, "m"), null);
});

// ── prompt / egress ──
test("buildQualityPrompt: redacts secret-like lines, caps body and paths, lists findings, never script bodies", () => {
  const skillMd = "---\nname: a\n---\n# T\napi_key = \"abcdefghijklmnop1234\"\n" + "x".repeat(QUALITY_PROMPT_BODY_MAX);
  const paths = Array.from({ length: 250 }, (_, i) => `scripts/s${i}.py`);
  const p = buildQualityPrompt({
    skillMd,
    filePaths: paths,
    findings: [
      { scanner: "quality", rule: "DS-001", level: "warn", path: "SKILL.md", line: 3, message: "no trigger" },
      { scanner: "quality", rule: "qa-scanned", ruleset: 1 },
      { scanner: "content-risk", rule: "cr-hidden-unicode" },
    ],
    isSecretLine: isSecretLikeLine,
  });
  assert.ok(p.truncated);
  assert.ok(p.user.includes("[redacted]"));
  assert.ok(!p.user.includes("abcdefghijklmnop1234"));
  assert.ok(p.user.includes(`first ${QUALITY_PROMPT_PATHS_MAX} shown`));
  assert.ok(p.user.includes("scripts/s199.py") && !p.user.includes("scripts/s200.py"));
  assert.ok(p.user.includes("DS-001 [warn] SKILL.md:3 no trigger"));
  assert.ok(!p.user.includes("qa-scanned") && !p.user.includes("cr-hidden"));
  assert.ok(p.user.includes(`truncated at ${QUALITY_PROMPT_BODY_MAX}`));
  assert.ok(p.system.includes("JSON"));
  assert.ok(/composability/.test(p.system));
});

test("the AI scoring call asks for the aiComplete ceiling, 8192 tokens (§41.5 — room for a reasoning model)", () => {
  assert.equal(QUALITY_AI_MAX_TOKENS, 8192);
});
