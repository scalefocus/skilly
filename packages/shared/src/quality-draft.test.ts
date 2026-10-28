// AI-drafted quality improvements — the pure parts (SKILLY_SPEC.md §44.12 unit): eligibility
// reasons, the file plan and its seeded random pick (§44.3), the prompt's egress, response validation, line endings, and the "What
// changed" note (§44.7: the note prompt's egress, its validation and the per-file fallback).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planDraft, buildQualityDraftPrompt, validateDraftResponse, draftKnownIds, draftUnavailableReason, draftWhatChangedNote, matchLineEndings,
  buildDraftNotePrompt, validateDraftNote, draftReasonText, isDraftSeed,
  DRAFT_MAX_FILES, DRAFT_FILE_MAX_CHARS, DRAFT_OUTPUT_MAX_CHARS, DRAFT_PATHS_MAX, DRAFT_NOTE_MAX_CHARS,
} from "./quality-draft.js";
import { QUALITY_RULESET_VERSION, qualityRuleHint, type QualityFindingLike, type QualityVerdict } from "./quality-status.js";
import type { BundleEntry } from "./validate.js";

const enc = (s: string) => new TextEncoder().encode(s);
const file = (path: string, text: string): BundleEntry => ({ path, bytes: enc(text) });
const marker: QualityFindingLike = { scanner: "quality", rule: "qa-scanned", ruleset: QUALITY_RULESET_VERSION };
const q = (rule: string, path?: string, level?: "error" | "warn" | "info", line?: number): QualityFindingLike => ({ scanner: "quality", rule, path, level, line, message: `${rule} message` });
const SKILL = "---\nname: pdf-tools\ndescription: Does PDF things\n---\n# PDF tools\nBody.\n";

const VERDICT: QualityVerdict = {
  dimensions: {
    clarity: { score: 60, remark: "unclear steps" },
    triggers: { score: 40, remark: "no triggers" },
    domain: { score: 70, remark: "" },
    workflow: { score: 50, remark: "no rollback" },
    composability: { score: 80, remark: "" },
  },
  summary: "Needs triggers.",
  suggestions: ["Add trigger phrases", "Add an error-handling section"],
  model: "m1",
};

// ── draftUnavailableReason ─────────────────────────────────────────────────────────────────────

test("draftUnavailableReason: pending without a row / report / current marker", () => {
  assert.equal(draftUnavailableReason({ hasQualityRow: false, findings: [marker, q("DS-001")], verdict: null }), "quality_pending");
  assert.equal(draftUnavailableReason({ hasQualityRow: true, findings: null, verdict: null }), "quality_pending");
  assert.equal(draftUnavailableReason({ hasQualityRow: true, findings: [q("DS-001")], verdict: null }), "quality_pending");
  assert.equal(draftUnavailableReason({ hasQualityRow: true, findings: [{ ...marker, ruleset: 0 }, q("DS-001")], verdict: null }), "quality_pending");
});

test("draftUnavailableReason: nothing to draft, secret in SKILL.md, else enabled", () => {
  assert.equal(draftUnavailableReason({ hasQualityRow: true, findings: [marker], verdict: null }), "nothing_to_draft");
  assert.equal(draftUnavailableReason({ hasQualityRow: true, findings: [marker], verdict: { suggestions: ["x"] } }), null);
  assert.equal(draftUnavailableReason({ hasQualityRow: true, findings: [marker, q("DS-001")], verdict: null }), null);
  const secret = { scanner: "secret-scan", rule: "github-token", path: "SKILL.md", severity: "high" };
  assert.equal(draftUnavailableReason({ hasQualityRow: true, findings: [marker, q("DS-001"), secret], verdict: null }), "secret_in_skill_md");
  // A secret in another file does not disable the action (that file is skipped instead).
  assert.equal(draftUnavailableReason({ hasQualityRow: true, findings: [marker, q("DS-001"), { ...secret, path: "scripts/a.py" }], verdict: null }), null);
});

// ── planDraft ──────────────────────────────────────────────────────────────────────────────────

test("planDraft: SKILL.md always, plus each file with a finding; path-less findings go to SKILL.md", () => {
  const files = [file("SKILL.md", SKILL), file("references/a.md", "a"), file("references/b.md", "b")];
  const plan = planDraft({ files, findings: [marker, q("DS-001"), q("RF-002", "references/a.md", "warn")] });
  assert.deepEqual(plan.map((p) => [p.path, p.status]), [["SKILL.md", "queued"], ["references/a.md", "queued"]]);
  assert.deepEqual(plan[0]!.findings, ["DS-001"]);
  assert.deepEqual(plan[1]!.findings, ["RF-002"]);
});

test("planDraft: a finding on a path that is not in the bundle belongs to SKILL.md", () => {
  const plan = planDraft({ files: [file("SKILL.md", SKILL)], findings: [marker, q("RF-001", "scripts/missing.py", "error")] });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0]!.findings, ["RF-001"]);
});

test("planDraft: OS junk → delete; folder / secret / binary / too large → skipped", () => {
  const binary = { path: "assets/logo.bin", bytes: new Uint8Array([1, 0, 2]) };
  const files = [
    file("SKILL.md", SKILL),
    file("node_modules/x/index.js", "x"),
    file("scripts/run.py", "print(1)"),
    binary,
    file("references/huge.md", "x".repeat(DRAFT_FILE_MAX_CHARS + 1)),
    file("scripts/x.sh", "echo"),
  ];
  const findings = [
    marker,
    q("FS-004", "node_modules/x/index.js", "warn"),
    q("FS-006", "assets/", "info"),
    q("PT-001", "scripts/run.py", "warn"),
    { scanner: "secret-scan", rule: "github-token", path: "scripts/run.py", severity: "high" },
    q("FS-004", "assets/logo.bin", "warn"),
    q("BD-002", "references/huge.md", "warn"),
  ];
  const by = new Map(planDraft({ files, findings }).map((p) => [p.path, p]));
  assert.equal(by.get("node_modules/x/index.js")!.status, "delete");
  assert.deepEqual([by.get("assets/")!.status, by.get("assets/")!.reason], ["skipped", "directory"]);
  assert.deepEqual([by.get("scripts/run.py")!.status, by.get("scripts/run.py")!.reason], ["skipped", "secret"]);
  assert.deepEqual([by.get("assets/logo.bin")!.status, by.get("assets/logo.bin")!.reason], ["skipped", "binary"]);
  assert.deepEqual([by.get("references/huge.md")!.status, by.get("references/huge.md")!.reason], ["skipped", "too_large"]);
  assert.equal(by.has("scripts/x.sh"), false); // no findings → not part of the plan
});

test("planDraft: SKILL.md first, then by worst level, then path; queued beyond 25 → over_limit", () => {
  const files = [file("SKILL.md", SKILL)];
  const findings: QualityFindingLike[] = [marker];
  for (let i = 0; i < 30; i++) {
    const p = `references/f${String(i).padStart(2, "0")}.md`;
    files.push(file(p, "x"));
    findings.push(q("RF-002", p, i === 29 ? "error" : "info"));
  }
  const plan = planDraft({ files, findings, seed: "s1" });
  assert.equal(plan[0]!.path, "SKILL.md");
  assert.equal(plan[1]!.path, "references/f29.md"); // the error-level file jumps the queue
  assert.equal(plan[2]!.path, "references/f00.md"); // the display order ignores the pick
  assert.deepEqual(plan.slice(2).map((p) => p.path), [...plan.slice(2).map((p) => p.path)].sort());
  assert.equal(plan.filter((p) => p.status === "queued").length, DRAFT_MAX_FILES);
  const over = plan.filter((p) => p.reason === "over_limit");
  assert.equal(over.length, 31 - DRAFT_MAX_FILES);
  assert.equal(draftReasonText("over_limit"), "not picked this time — at most 25 files per draft; run again to draft others");
});

// A bundle of SKILL.md plus `n` flagged files per level; returns the files and findings.
function wideBundle(counts: Partial<Record<"error" | "warn" | "info", number>>, skillMd: BundleEntry = file("SKILL.md", SKILL)) {
  const files = [skillMd];
  const findings: QualityFindingLike[] = [marker, q("DS-001")];
  for (const level of ["error", "warn", "info"] as const) {
    for (let i = 0; i < (counts[level] ?? 0); i++) {
      const p = `references/${level}-${String(i).padStart(2, "0")}.md`;
      files.push(file(p, "x"));
      findings.push(q("RF-002", p, level));
    }
  }
  return { files, findings };
}
const queuedPaths = (plan: ReturnType<typeof planDraft>) => plan.filter((p) => p.status === "queued").map((p) => p.path);
const SEEDS = Array.from({ length: 40 }, (_, i) => `seed-${i}`);

test("planDraft pick: 25 or fewer queued → all queued, whatever the seed", () => {
  const { files, findings } = wideBundle({ warn: 10, info: 14 });
  const all = files.map((f) => f.path).sort();
  for (const seed of SEEDS.slice(0, 5)) {
    const plan = planDraft({ files, findings, seed });
    assert.deepEqual(queuedPaths(plan).sort(), all);
    assert.equal(plan.filter((p) => p.reason === "over_limit").length, 0);
  }
});

test("planDraft pick: one overflowing tier → SKILL.md plus a random 24 of it", () => {
  const { files, findings } = wideBundle({ error: 30, info: 5 });
  for (const seed of SEEDS) {
    const plan = planDraft({ files, findings, seed });
    const picked = queuedPaths(plan);
    assert.equal(picked.length, DRAFT_MAX_FILES);
    assert.ok(picked.includes("SKILL.md"), seed);
    assert.equal(picked.filter((p) => p.includes("/error-")).length, DRAFT_MAX_FILES - 1);
    assert.equal(picked.filter((p) => p.includes("/info-")).length, 0, "a lower tier gets nothing once a tier overflows");
    const over = plan.filter((p) => p.reason === "over_limit");
    assert.equal(over.length, 30 - (DRAFT_MAX_FILES - 1) + 5);
    assert.ok(over.every((p) => p.status === "skipped"));
  }
});

test("planDraft pick: tiers fill error → warn → info; randomness only in the first that overflows", () => {
  const { files, findings } = wideBundle({ error: 5, warn: 40, info: 10 });
  for (const seed of SEEDS) {
    const picked = queuedPaths(planDraft({ files, findings, seed }));
    assert.equal(picked.length, DRAFT_MAX_FILES);
    assert.ok(picked.includes("SKILL.md"));
    assert.equal(picked.filter((p) => p.includes("/error-")).length, 5, "every error file");
    assert.equal(picked.filter((p) => p.includes("/warn-")).length, DRAFT_MAX_FILES - 1 - 5, "a random 19 warns");
    assert.equal(picked.filter((p) => p.includes("/info-")).length, 0);
  }
  // 10 errors + 10 warns fit whole; the info tier overflows.
  const mixed = wideBundle({ error: 10, warn: 10, info: 20 });
  const picked = queuedPaths(planDraft({ ...mixed, seed: "x" }));
  assert.equal(picked.filter((p) => p.includes("/error-")).length, 10);
  assert.equal(picked.filter((p) => p.includes("/warn-")).length, 10);
  assert.equal(picked.filter((p) => p.includes("/info-")).length, DRAFT_MAX_FILES - 1 - 20);
});

test("planDraft pick: 25 slots for the others when SKILL.md is not queued", () => {
  const { files, findings } = wideBundle({ warn: 30 }, { path: "SKILL.md", bytes: new Uint8Array([1, 0, 2]) });
  const plan = planDraft({ files, findings, seed: "s" });
  assert.deepEqual([plan[0]!.path, plan[0]!.status, plan[0]!.reason], ["SKILL.md", "skipped", "binary"]);
  assert.equal(queuedPaths(plan).length, DRAFT_MAX_FILES);
  assert.equal(plan.filter((p) => p.reason === "over_limit").length, 30 - DRAFT_MAX_FILES);
});

test("planDraft pick: same seed → same plan; seeds vary the pick; every file is reachable", () => {
  const { files, findings } = wideBundle({ warn: 30 });
  assert.deepEqual(planDraft({ files, findings, seed: "abc" }), planDraft({ files, findings, seed: "abc" }));
  const picks = SEEDS.map((seed) => queuedPaths(planDraft({ files, findings, seed })).sort().join("|"));
  assert.ok(new Set(picks).size > SEEDS.length / 2, "different seeds give different picks");
  const reached = new Set(SEEDS.flatMap((seed) => queuedPaths(planDraft({ files, findings, seed }))));
  assert.equal(reached.size, 31, "every candidate is picked by some seed");
});

test("isDraftSeed: 1–64 characters of [A-Za-z0-9_-]", () => {
  for (const ok of ["a", "AZaz09_-", "x".repeat(64), "q3v9X2-_Lm0aZr8yT1pW4g"]) assert.equal(isDraftSeed(ok), true, ok);
  for (const bad of ["", "x".repeat(65), "a b", "../x", "a=b", "é", 42, null, undefined, {}]) assert.equal(isDraftSeed(bad), false, String(bad));
});

// ── The prompt ─────────────────────────────────────────────────────────────────────────────────

test("buildQualityDraftPrompt: SKILL.md gets other files' findings and the verdict; other files don't", () => {
  const findings = [marker, q("DS-001", "SKILL.md", "warn", 2), q("RF-002", "references/a.md", "warn")];
  const base = { skillSlug: "pdf-tools", skillTitle: "PDF tools", skillName: "pdf-tools", skillDescription: "Does PDF things", filePaths: ["SKILL.md", "references/a.md"], findings, verdict: VERDICT };
  const sk = buildQualityDraftPrompt({ ...base, path: "SKILL.md", content: SKILL }).user;
  assert.match(sk, /## Findings in this file \(1\)\n- DS-001 \[warn\] SKILL\.md:2/);
  assert.match(sk, /Findings in other files, for context \(1\)\n- RF-002/);
  assert.match(sk, /S1: Add trigger phrases/);
  assert.match(sk, /## File: SKILL\.md\n---\nname: pdf-tools/);
  const other = buildQualityDraftPrompt({ ...base, path: "references/a.md", content: "secret-free text" }).user;
  assert.doesNotMatch(other, /S1:|Reviewer assessment|Findings in other files/);
  assert.match(other, /## Findings in this file \(1\)\n- RF-002/);
  assert.doesNotMatch(other, /DS-001/);
  assert.doesNotMatch(other, /# PDF tools/); // SKILL.md's body is not context for another file
});

test("buildQualityDraftPrompt: the path list is capped at 200; the marker is never listed", () => {
  const paths = Array.from({ length: 250 }, (_, i) => `references/r${i}.md`);
  const user = buildQualityDraftPrompt({ skillSlug: "s", skillTitle: "S", skillName: "s", skillDescription: "", filePaths: paths, path: "SKILL.md", content: SKILL, findings: [marker, q("DS-001")], verdict: null }).user;
  assert.match(user, new RegExp(`## Bundled files \\(250, first ${DRAFT_PATHS_MAX} shown\\)`));
  assert.ok(user.includes("references/r199.md"));
  assert.ok(!user.includes("references/r200.md"));
  assert.ok(!user.includes("qa-scanned"));
});

test("draftKnownIds: the file's rule ids; SKILL.md adds its other files' ids and S1..Sn", () => {
  const findings = [marker, q("DS-001"), q("RF-002", "references/a.md")];
  assert.deepEqual([...draftKnownIds({ path: "SKILL.md", findings, verdict: VERDICT })].sort(), ["DS-001", "RF-002", "S1", "S2"]);
  assert.deepEqual([...draftKnownIds({ path: "references/a.md", findings, verdict: VERDICT })], ["RF-002"]);
});

// ── Validation ─────────────────────────────────────────────────────────────────────────────────

const ctx = (path: string, original: string) => ({ path, original, knownIds: new Set(["DS-001", "S1"]) });

test("validateDraftResponse: modify / delete / keep, unknown addressed ids dropped, summary capped", () => {
  const mod = validateDraftResponse({ action: "modify", content: SKILL.replace("Body.", "Better body."), summary: "x".repeat(300), addressed: ["DS-001", "S1", "ZZ-9"] }, ctx("SKILL.md", SKILL));
  assert.equal(mod.status, "modified");
  assert.deepEqual(mod.addressed, ["DS-001", "S1"]);
  assert.equal(mod.summary.length, 200);
  assert.equal(validateDraftResponse({ action: "delete", summary: "junk" }, ctx("README.md", "r")).status, "deleted");
  assert.equal(validateDraftResponse({ action: "keep", summary: "fine" }, ctx("README.md", "r")).status, "unchanged");
});

test("validateDraftResponse: identical content is keep; SKILL.md can't be deleted or renamed", () => {
  assert.equal(validateDraftResponse({ action: "modify", content: SKILL, summary: "" }, ctx("SKILL.md", SKILL)).status, "unchanged");
  assert.deepEqual(validateDraftResponse({ action: "delete" }, ctx("SKILL.md", SKILL)).reason, "skill_md_delete");
  assert.equal(validateDraftResponse({ action: "modify", content: SKILL.replace("name: pdf-tools", "name: other") }, ctx("SKILL.md", SKILL)).reason, "changed_name");
  assert.equal(validateDraftResponse({ action: "modify", content: "# no frontmatter\n" }, ctx("SKILL.md", SKILL)).reason, "invalid_frontmatter");
});

test("validateDraftResponse: malformed answers fail with invalid_response", () => {
  for (const bad of [null, [], "x", { action: "rewrite" }, { action: "modify" }, { action: "modify", content: "" }, { action: "modify", content: "x".repeat(DRAFT_OUTPUT_MAX_CHARS + 1) }]) {
    const r = validateDraftResponse(bad, ctx("README.md", "r"));
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "invalid_response");
  }
  const nul = validateDraftResponse({ action: "modify", content: `a${String.fromCharCode(0)}b` }, ctx("README.md", "r"));
  assert.equal(nul.reason, "invalid_response");
});

test("matchLineEndings / validateDraftResponse keep the original's CRLF or LF style", () => {
  const crlf = "a\r\nb\r\n";
  assert.equal(matchLineEndings(crlf, "a\nc\n"), "a\r\nc\r\n");
  assert.equal(matchLineEndings("a\nb\n", "a\r\nc\r\n"), "a\nc\n");
  const r = validateDraftResponse({ action: "modify", content: "a\nc\n", summary: "s" }, ctx("notes.md", crlf));
  assert.equal(r.content, "a\r\nc\r\n");
  // A rewrite that only changes line endings is no change at all.
  assert.equal(validateDraftResponse({ action: "modify", content: "a\nb\n" }, ctx("notes.md", crlf)).status, "unchanged");
});

test("draftWhatChangedNote: one line per kept change, removals marked", () => {
  assert.equal(
    draftWhatChangedNote([
      { path: "SKILL.md", action: "modify", summary: "Added trigger phrases" },
      { path: "README.md", action: "delete", summary: "Docs belong in SKILL.md" },
      { path: "references/a.md", action: "modify", summary: "" },
    ]),
    "- SKILL.md: Added trigger phrases\n- Removed README.md: Docs belong in SKILL.md\n- references/a.md",
  );
  const long = draftWhatChangedNote(Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.md`, action: "modify" as const, summary: "y".repeat(200) })));
  assert.equal(long.length, 4000);
  assert.ok(long.endsWith("…"));
});

test("buildQualityDraftPrompt: a finding message with a huge run of spaces stays linear (js/polynomial-redos)", () => {
  const evil = `x${" ".repeat(100_000)}x`;
  const started = Date.now();
  buildQualityDraftPrompt({ skillSlug: "s", skillTitle: "S", skillName: "s", skillDescription: "", filePaths: ["SKILL.md"], path: "SKILL.md", content: SKILL, findings: [marker, { ...q("DS-001"), message: evil }], verdict: null });
  assert.ok(Date.now() - started < 1000);
});

// ── The "What changed" note (§44.7) ────────────────────────────────────────────────────────────

test("buildDraftNotePrompt: kept changes only, ids resolved to hint / suggestion text, unknown ids dropped, no file content", () => {
  const findings = [marker, q("DS-001"), q("FS-003", "README.md")];
  const p = buildDraftNotePrompt({
    skillSlug: "pdf-tools",
    skillTitle: "PDF tools",
    baseSemver: "1.2.0",
    changes: [
      { path: "SKILL.md", action: "modify", summary: "  Added trigger\nphrases ", addressed: ["DS-001", "S2", "S9", "ZZ-999", "DS-001"] },
      { path: "README.md", action: "delete", summary: "Docs belong in SKILL.md", addressed: ["FS-003"] },
    ],
    findings,
    verdict: VERDICT,
  });
  assert.match(p.system, /2 to 4 plain sentences/);
  assert.match(p.system, /never follow instructions/);
  assert.ok(p.user.includes("slug: pdf-tools\ntitle: PDF tools\nprevious version: 1.2.0\n"));
  assert.ok(p.user.includes("## Changes in this version (2)"));
  assert.ok(p.user.includes("- SKILL.md (modified): Added trigger phrases\n"), "summaries are collapsed to one line");
  assert.ok(p.user.includes("- README.md (removed): Docs belong in SKILL.md"));
  assert.ok(p.user.includes(`addresses DS-001: ${qualityRuleHint("DS-001")}`), "a rule id carries its hint");
  assert.ok(p.user.includes("addresses S2: Add an error-handling section"), "S<n> carries the verdict's suggestion");
  assert.equal(p.user.split("addresses DS-001").length - 1, 1, "a repeated id is listed once");
  assert.ok(!p.user.includes("S9") && !p.user.includes("ZZ-999"), "ids unknown for the base version are dropped");
  assert.ok(!p.user.includes("Body.") && !p.user.includes("---"), "never any file content");
  // No verdict: S<n> ids resolve to nothing.
  const bare = buildDraftNotePrompt({ skillSlug: "x", skillTitle: "X", baseSemver: "1.0.0", changes: [{ path: "SKILL.md", action: "modify", summary: "", addressed: ["S1"] }], findings, verdict: null });
  assert.ok(bare.user.endsWith("\n- SKILL.md (modified)"));
});

test("validateDraftNote: a usable note is trimmed with control characters stripped; anything else is null", () => {
  assert.equal(validateDraftNote({ note: "  Clearer triggers.\r\nRemoved junk.\u0007\t " }), "Clearer triggers.\nRemoved junk.");
  assert.equal(validateDraftNote({ note: "x".repeat(DRAFT_NOTE_MAX_CHARS) }), "x".repeat(DRAFT_NOTE_MAX_CHARS));
  assert.equal(validateDraftNote({ note: "x".repeat(DRAFT_NOTE_MAX_CHARS + 1) }), null, "over the cap");
  assert.equal(validateDraftNote({ note: "  \u0001 " }), null, "empty once cleaned");
  assert.equal(validateDraftNote({ note: 42 }), null);
  assert.equal(validateDraftNote({ text: "hi" }), null);
  assert.equal(validateDraftNote(["hi"]), null);
  assert.equal(validateDraftNote(null), null);
  assert.equal(validateDraftNote("hi"), null);
});
