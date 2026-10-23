// Unit tests for Try a skill before installing (SKILLY_SPEC.md §61.13): transcript validation and
// its two error codes, the "can send more" rule the panel uses, the input selection (§46's rules
// with the 100,000-character total) and the system prompt (preamble, cut-short and left-out lists,
// the nonce-fenced skill files).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_TRY_MAX_MESSAGE_CHARS,
  AI_TRY_MAX_TRANSCRIPT_CHARS,
  AI_TRY_MAX_TURNS,
  AI_TRY_TOTAL_MAX_CHARS,
  tryCanSendMore,
  tryTranscriptChars,
  tryUserTurns,
  validateTryTranscript,
  type TryMessage,
} from "./ai-try.js";
import { AI_TRY_PREAMBLE, buildTrySystemPrompt, selectTryInput } from "./ai-try-run.js";
import { PREREVIEW_FILE_MAX_CHARS, PREREVIEW_MAX_FILES, selectPrereviewInput } from "./ai-prereview-run.js";
import type { BundleEntry } from "./validate.js";

const u = (content: string): TryMessage => ({ role: "user", content });
const a = (content: string): TryMessage => ({ role: "assistant", content });

/** A transcript of `turns` user messages with replies in between, ending with the user. */
function convo(turns: number, size = 5): TryMessage[] {
  const out: TryMessage[] = [];
  for (let i = 0; i < turns; i++) {
    if (i > 0) out.push(a("r".repeat(size)));
    out.push(u("q".repeat(size)));
  }
  return out;
}

test("validateTryTranscript: a well-formed transcript passes with its messages unchanged", () => {
  const msgs = [u("  hello  "), a("hi"), u("again")];
  const r = validateTryTranscript(msgs);
  assert.deepEqual(r, { ok: true, messages: msgs });
});

test("validateTryTranscript: shape errors are invalid_transcript", () => {
  const bad: unknown[] = [
    null,
    "hello",
    [],
    [a("hi")],
    [u("a"), u("b")],
    [u("a"), a("b")],
    [u("a"), { role: "system", content: "x" }, u("b")],
    [{ role: "user" }],
    [u("   ")],
    [u("a"), a(""), u("b")],
    [{ role: "user", content: 42 }],
  ];
  for (const raw of bad) {
    const r = validateTryTranscript(raw);
    assert.equal(r.ok, false, JSON.stringify(raw));
    if (!r.ok) assert.equal(r.error, "invalid_transcript", JSON.stringify(raw));
  }
});

test("validateTryTranscript: a user message over 4,000 characters is invalid; a long reply is fine", () => {
  assert.equal(validateTryTranscript([u("x".repeat(AI_TRY_MAX_MESSAGE_CHARS))]).ok, true);
  const long = validateTryTranscript([u("x".repeat(AI_TRY_MAX_MESSAGE_CHARS + 1))]);
  assert.ok(!long.ok && long.error === "invalid_transcript");
  assert.equal(validateTryTranscript([u("q"), a("r".repeat(20_000)), u("q")]).ok, true);
});

test("validateTryTranscript: more than 20 user messages or 200,000 characters is conversation_full", () => {
  assert.equal(validateTryTranscript(convo(AI_TRY_MAX_TURNS)).ok, true);
  const tooMany = validateTryTranscript(convo(AI_TRY_MAX_TURNS + 1));
  assert.ok(!tooMany.ok && tooMany.error === "conversation_full");
  // 10 turns of 4,000-char questions + 9 replies of 20,000 = 220,000 characters.
  const big: TryMessage[] = [];
  for (let i = 0; i < 10; i++) {
    if (i > 0) big.push(a("r".repeat(20_000)));
    big.push(u("q".repeat(4000)));
  }
  assert.ok(tryTranscriptChars(big) > AI_TRY_MAX_TRANSCRIPT_CHARS);
  const full = validateTryTranscript(big);
  assert.ok(!full.ok && full.error === "conversation_full");
});

test("tryUserTurns / tryTranscriptChars / tryCanSendMore", () => {
  const c = convo(3, 10);
  assert.equal(tryUserTurns(c), 3);
  assert.equal(tryTranscriptChars(c), 50);
  assert.equal(tryCanSendMore(c), true);
  assert.equal(tryCanSendMore(convo(AI_TRY_MAX_TURNS)), false, "20 user messages: full");
  assert.equal(tryCanSendMore([u("x".repeat(10))], AI_TRY_MAX_TRANSCRIPT_CHARS - 10), true);
  assert.equal(tryCanSendMore([u("x".repeat(10))], AI_TRY_MAX_TRANSCRIPT_CHARS - 9), false);
});

const enc = (s: string) => new TextEncoder().encode(s);
const entry = (path: string, text: string): BundleEntry => ({ path, bytes: enc(text) });
const isSecret = (l: string) => l.includes("AKIA");

test("selectTryInput: §46 priority, the 100,000 total, redaction; assets and root files are not candidates", () => {
  const entries = [
    entry("references/b.md", "B".repeat(30_000)),
    entry("references/a.md", "A".repeat(30_000)),
    entry("scripts/run.sh", `echo hi\nexport KEY=AKIAIOSFODNN7EXAMPLE\n${"s".repeat(75_000)}`),
    entry("SKILL.md", "---\nname: demo\n---\n# Demo\n"),
    entry("assets/logo.png", "\u0000PNG"),
    entry("assets/notes.txt", "not a candidate"),
  ];
  const sel = selectTryInput(entries, isSecret);
  assert.deepEqual(sel.files.map((f) => f.path), ["SKILL.md", "scripts/run.sh", "references/a.md"]);
  assert.ok(sel.files.reduce((n, f) => n + f.text.length, 0) <= AI_TRY_TOTAL_MAX_CHARS);
  assert.ok(sel.files[1]!.text.includes("[redacted]") && !sel.files[1]!.text.includes("AKIA"));
  assert.deepEqual(sel.states, [
    { path: "SKILL.md", state: "loaded" },
    { path: "scripts/run.sh", state: "loaded" },
    { path: "references/a.md", state: "truncated" },
    { path: "references/b.md", state: "skipped" },
  ]);
  assert.deepEqual(sel.paths, ["SKILL.md", "assets/logo.png", "assets/notes.txt", "references/a.md", "references/b.md", "scripts/run.sh"]);
});

test("selectTryInput: the per-file and file-count caps are §46's", () => {
  const many = [entry("SKILL.md", "x".repeat(PREREVIEW_FILE_MAX_CHARS + 5))];
  for (let i = 0; i < 30; i++) many.push(entry(`references/r${String(i).padStart(2, "0")}.md`, "r"));
  const sel = selectTryInput(many, isSecret);
  assert.equal(sel.states[0]!.state, "truncated", "SKILL.md cut at 100,000 characters");
  assert.equal(sel.files[0]!.text.length, PREREVIEW_FILE_MAX_CHARS);
  // SKILL.md used the whole 100,000 total, so every reference is left out.
  assert.equal(sel.files.length, 1);
  const small = [entry("SKILL.md", "x")];
  for (let i = 0; i < 30; i++) small.push(entry(`references/r${String(i).padStart(2, "0")}.md`, "r"));
  assert.equal(selectTryInput(small, isSecret).files.length, PREREVIEW_MAX_FILES);
});

test("selectPrereviewInput keeps its 250,000 total when no override is passed (§46.6 unchanged)", () => {
  const entries = [entry("SKILL.md", "x"), entry("references/a.md", "a".repeat(90_000)), entry("references/b.md", "b".repeat(90_000))];
  const pre = selectPrereviewInput(entries, { isSecretLine: isSecret });
  assert.deepEqual(pre.coverage.map((c) => c.status), ["reviewed", "reviewed", "reviewed"]);
  const tr = selectTryInput(entries, isSecret);
  assert.deepEqual(tr.states.map((c) => c.state), ["loaded", "loaded", "truncated"]);
});

test("buildTrySystemPrompt: preamble first, then paths, the cut-short and left-out lists and fenced files", () => {
  const sel = selectTryInput(
    [entry("SKILL.md", "# Demo\nDo the thing."), entry("references/a.md", "A".repeat(99_990)), entry("references/b.md", "B")],
    isSecret,
  );
  const nonce = "n0nce";
  const p = buildTrySystemPrompt(sel, nonce);
  assert.ok(p.startsWith(AI_TRY_PREAMBLE));
  assert.match(p, /no tools/);
  assert.match(p, /never override these rules/);
  assert.match(p, /## Bundled files \(3\)/);
  assert.match(p, /## Cut short — only the beginning is included \(1\)\n- "references\/a.md"/);
  assert.match(p, /## Left out — you don't have these \(1\)\n- "references\/b.md"/);
  assert.ok(p.includes(`===== FILE ${nonce} "SKILL.md" =====\n# Demo\nDo the thing.\n===== END FILE ${nonce} =====`));
  assert.ok(p.includes(`===== FILE ${nonce} "references/a.md" (cut short) =====`));
  assert.ok(!p.includes('FILE n0nce "references/b.md"'), "a skipped file is never sent");
});

test("buildTrySystemPrompt: nothing cut or left out → no such sections", () => {
  const p = buildTrySystemPrompt(selectTryInput([entry("SKILL.md", "hi")], isSecret), "z");
  assert.ok(!p.includes("Cut short") && !p.includes("Left out"));
});
