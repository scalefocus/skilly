// Unit tests for Try a skill before installing (SKILLY_SPEC.md §61.13): transcript validation and
// its two error codes, the "can send more" rule the panel uses, the input selection (§46's rules
// with the 100,000-character total) and the system prompt (preamble, cut-short and left-out lists,
// the nonce-fenced skill files). And the admin-adjustable limits (§40.18): resolving the stored
// setting, validating the admin's input, the transcript rules under non-default limits, the daily
// allowance and the worst-case estimate with its wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_TRY_LIMIT_DEFAULTS,
  AI_TRY_LIMIT_KEYS,
  AI_TRY_LIMIT_RANGES,
  AI_TRY_TOTAL_MAX_CHARS,
  AI_TRY_WINDOW_MS,
  formatTryWorstCase,
  parseTryLimitOverrides,
  resolveTryLimits,
  tryCanSendMore,
  tryDailyAllowance,
  tryLimitOverridesEmpty,
  tryLimitsView,
  tryPanelLimits,
  tryTranscriptChars,
  tryUserTurns,
  tryWorstCaseInputTokens,
  validateTryLimitsInput,
  validateTryTranscript,
  type TryMessage,
  type TryPanelLimits,
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

/** The limits Try shipped with: 20 messages, 4,000 characters each, 200,000 in total. */
const D: TryPanelLimits = tryPanelLimits(AI_TRY_LIMIT_DEFAULTS);

test("validateTryTranscript: a well-formed transcript passes with its messages unchanged", () => {
  const msgs = [u("  hello  "), a("hi"), u("again")];
  const r = validateTryTranscript(msgs, D);
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
    const r = validateTryTranscript(raw, D);
    assert.equal(r.ok, false, JSON.stringify(raw));
    if (!r.ok) assert.equal(r.error, "invalid_transcript", JSON.stringify(raw));
  }
});

test("validateTryTranscript: a user message over 4,000 characters is invalid; a long reply is fine", () => {
  assert.equal(validateTryTranscript([u("x".repeat(D.maxMessageChars))], D).ok, true);
  const long = validateTryTranscript([u("x".repeat(D.maxMessageChars + 1))], D);
  assert.ok(!long.ok && long.error === "invalid_transcript");
  assert.equal(validateTryTranscript([u("q"), a("r".repeat(20_000)), u("q")], D).ok, true);
});

test("validateTryTranscript: more than 20 user messages or 200,000 characters is conversation_full", () => {
  assert.equal(validateTryTranscript(convo(D.maxTurns), D).ok, true);
  const tooMany = validateTryTranscript(convo(D.maxTurns + 1), D);
  assert.ok(!tooMany.ok && tooMany.error === "conversation_full");
  // 10 turns of 4,000-char questions + 9 replies of 20,000 = 220,000 characters.
  const big: TryMessage[] = [];
  for (let i = 0; i < 10; i++) {
    if (i > 0) big.push(a("r".repeat(20_000)));
    big.push(u("q".repeat(4000)));
  }
  assert.ok(tryTranscriptChars(big) > D.maxTranscriptChars);
  const full = validateTryTranscript(big, D);
  assert.ok(!full.ok && full.error === "conversation_full");
});

test("tryUserTurns / tryTranscriptChars / tryCanSendMore", () => {
  const c = convo(3, 10);
  assert.equal(tryUserTurns(c), 3);
  assert.equal(tryTranscriptChars(c), 50);
  assert.equal(tryCanSendMore(c, D), true);
  assert.equal(tryCanSendMore(convo(D.maxTurns), D), false, "20 user messages: full");
  assert.equal(tryCanSendMore([u("x".repeat(10))], D, D.maxTranscriptChars - 10), true);
  assert.equal(tryCanSendMore([u("x".repeat(10))], D, D.maxTranscriptChars - 9), false);
});

// ── The admin-adjustable limits (§40.18) ─────────────────────────────────────────────────────

test("§40.18 defaults and ranges: every combination is valid, so there is no cross-field rule", () => {
  assert.deepEqual(AI_TRY_LIMIT_DEFAULTS, { dailyCap: 100, perMinute: 10, maxTurns: 20, maxMessageChars: 4000, maxTranscriptChars: 200_000 });
  assert.deepEqual(AI_TRY_LIMIT_RANGES, {
    dailyCap: { min: 1, max: 1000 },
    perMinute: { min: 1, max: 60 },
    maxTurns: { min: 1, max: 100 },
    maxMessageChars: { min: 500, max: 20_000 },
    maxTranscriptChars: { min: 20_000, max: 400_000 },
  });
  const outside = AI_TRY_LIMIT_KEYS.filter((k) => AI_TRY_LIMIT_DEFAULTS[k] < AI_TRY_LIMIT_RANGES[k].min || AI_TRY_LIMIT_DEFAULTS[k] > AI_TRY_LIMIT_RANGES[k].max);
  assert.deepEqual(outside, [], "every default is inside its range");
  // The smallest conversation total still holds the largest message.
  assert.ok(AI_TRY_LIMIT_RANGES.maxTranscriptChars.min >= AI_TRY_LIMIT_RANGES.maxMessageChars.max);
});

test("§40.18 resolveTryLimits: override → default; out of range clamped; non-integers and unknown keys ignored", () => {
  assert.deepEqual(resolveTryLimits(undefined), AI_TRY_LIMIT_DEFAULTS);
  for (const junk of [null, "lots", 7, [], [50]]) assert.deepEqual(resolveTryLimits(junk), AI_TRY_LIMIT_DEFAULTS, JSON.stringify(junk));
  assert.deepEqual(resolveTryLimits({ dailyCap: 250, maxTurns: 5 }), { ...AI_TRY_LIMIT_DEFAULTS, dailyCap: 250, maxTurns: 5 });
  // A hand-edited row can never switch Try off or lift a limit.
  assert.deepEqual(parseTryLimitOverrides({ dailyCap: 0, perMinute: 999, maxMessageChars: 10, maxTranscriptChars: 9_000_000 }), {
    dailyCap: 1,
    perMinute: 60,
    maxMessageChars: 500,
    maxTranscriptChars: 400_000,
  });
  assert.deepEqual(parseTryLimitOverrides({ dailyCap: 12.5, perMinute: "20", maxTurns: null, maxMessageChars: Number.NaN, bogus: 3 }), {});
  assert.equal(tryLimitOverridesEmpty({}), true);
  assert.equal(tryLimitOverridesEmpty({ maxTurns: 3 }), false);
});

test("§40.18 tryLimitsView: default, override, effective and the range per field", () => {
  const view = tryLimitsView({ dailyCap: 250 });
  assert.deepEqual(Object.keys(view), [...AI_TRY_LIMIT_KEYS]);
  assert.deepEqual(view.dailyCap, { default: 100, override: 250, effective: 250, min: 1, max: 1000 });
  assert.deepEqual(view.maxTranscriptChars, { default: 200_000, override: null, effective: 200_000, min: 20_000, max: 400_000 });
});

test("§40.18 validateTryLimitsInput: bounds, whole numbers, null clears, a missing key, the field named", () => {
  const all = { dailyCap: null, perMinute: null, maxTurns: null, maxMessageChars: null, maxTranscriptChars: null };
  assert.deepEqual(validateTryLimitsInput(all), { ok: true, value: {} }, "all null = every default");
  assert.deepEqual(validateTryLimitsInput({ ...all, dailyCap: 1000, maxMessageChars: 500 }), { ok: true, value: { dailyCap: 1000, maxMessageChars: 500 } });
  // Both ends of every range are accepted; one step outside is refused, naming the field.
  /** The field a refused input names, or null when it was accepted. */
  const refusedField = (raw: unknown): string | null => {
    const r = validateTryLimitsInput(raw);
    return r.ok ? null : r.field;
  };
  for (const key of AI_TRY_LIMIT_KEYS) {
    const range: { min: number; max: number } = AI_TRY_LIMIT_RANGES[key];
    for (const v of [range.min, range.max]) assert.deepEqual(validateTryLimitsInput({ ...all, [key]: v }), { ok: true, value: { [key]: v } }, `${key}=${v}`);
    for (const v of [range.min - 1, range.max + 1, 0, range.min + 0.5, String(range.min), true]) {
      assert.equal(refusedField({ ...all, [key]: v }), key, `${key}=${JSON.stringify(v)} is refused and named`);
    }
    const missing: Record<string, unknown> = { ...all };
    delete missing[key];
    assert.equal(refusedField(missing), key, `a missing ${key} is refused`);
  }
  for (const junk of [null, undefined, "x", 5, [all]]) assert.equal(refusedField(junk), "body", JSON.stringify(junk));
});

test("§40.18 transcript rules follow the limits in force", () => {
  const tight: TryPanelLimits = { maxTurns: 2, maxMessageChars: 600, maxTranscriptChars: 20_000 };
  assert.equal(validateTryTranscript(convo(2), tight).ok, true);
  const third = validateTryTranscript(convo(3), tight);
  assert.ok(!third.ok && third.error === "conversation_full", "a third message is over maxTurns 2");
  assert.equal(tryCanSendMore(convo(1), tight), true);
  assert.equal(tryCanSendMore(convo(2), tight), false);
  const overTotal = validateTryTranscript([u("q"), a("r".repeat(20_000)), u("q")], tight);
  assert.ok(!overTotal.ok && overTotal.error === "conversation_full", "over maxTranscriptChars 20,000");
  // The defaults would have refused these; raised limits let them through.
  const roomy: TryPanelLimits = { maxTurns: 100, maxMessageChars: 20_000, maxTranscriptChars: 400_000 };
  assert.equal(validateTryTranscript(convo(21), roomy).ok, true);
  assert.equal(validateTryTranscript([u("x".repeat(20_000))], roomy).ok, true);
});

test("§40.18 a lowered per-message limit: an earlier long message is conversation_full, the one being sent is invalid_transcript", () => {
  const lowered: TryPanelLimits = { ...D, maxMessageChars: 1000 };
  // The conversation was within the old limit (4,000) and is over the new one.
  const older = validateTryTranscript([u("x".repeat(3000)), a("ok"), u("short")], lowered);
  assert.ok(!older.ok && older.error === "conversation_full");
  assert.equal(tryCanSendMore([u("x".repeat(3000)), a("ok")], lowered), false, "the panel shows the full state at once");
  const sending = validateTryTranscript([u("short"), a("ok"), u("x".repeat(1001))], lowered);
  assert.ok(!sending.ok && sending.error === "invalid_transcript");
  assert.match(!sending.ok ? sending.message : "", /at most 1,000 characters/);
  // When both apply, the conversation is full: shortening the message would not help.
  const both = validateTryTranscript([u("x".repeat(3000)), a("ok"), u("x".repeat(1001))], lowered);
  assert.ok(!both.ok && both.error === "conversation_full");
  // A long reply never trips the per-message limit.
  assert.equal(validateTryTranscript([u("q"), a("r".repeat(5000)), u("q")], lowered).ok, true);
});

test("§61.7 tryDailyAllowance: remaining never below 0; retryAt against the cap in force", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  assert.deepEqual(tryDailyAllowance([], now, 100), { cap: 100, remaining: 100, retryAt: null });
  const three = [ago(30), ago(20), ago(10)];
  assert.deepEqual(tryDailyAllowance(three, now, 5), { cap: 5, remaining: 2, retryAt: null });
  // At the cap: the oldest counted call ageing out frees one message.
  assert.deepEqual(tryDailyAllowance(three, now, 3), { cap: 3, remaining: 0, retryAt: new Date(ago(30).getTime() + AI_TRY_WINDOW_MS).toISOString() });
  // A cap lowered below what was already sent: wait until enough calls age out to fall below it.
  assert.deepEqual(tryDailyAllowance(three, now, 1), { cap: 1, remaining: 0, retryAt: new Date(ago(10).getTime() + AI_TRY_WINDOW_MS).toISOString() });
  // A cap raised above it: the same history has room again.
  assert.equal(tryDailyAllowance(three, now, 4).remaining, 1);
  // Calls older than the rolling 24 hours don't count, whatever order they arrive in.
  const aged = [ago(10), ago(25 * 60), ago(24 * 60 + 1)];
  assert.deepEqual(tryDailyAllowance(aged, now, 2), { cap: 2, remaining: 1, retryAt: null });
});

test("§40.18 the worst case: daily cap × (skill + conversation) ÷ 4, and its wording", () => {
  assert.equal(tryWorstCaseInputTokens(AI_TRY_LIMIT_DEFAULTS), 7_500_000);
  assert.equal(tryWorstCaseInputTokens({ dailyCap: 1000, maxTranscriptChars: 400_000 }), 125_000_000);
  assert.equal(tryWorstCaseInputTokens({ dailyCap: 1, maxTranscriptChars: 20_000 }), 30_000);
  assert.equal(formatTryWorstCase(30_000), "30,000");
  assert.equal(formatTryWorstCase(7_500_000), "7.5 million");
  assert.equal(formatTryWorstCase(125_000_000), "125 million");
  // Below one million: the nearest thousand. From 10 million: whole millions.
  assert.equal(formatTryWorstCase(75_400), "75,000");
  assert.equal(formatTryWorstCase(999_400), "999,000");
  assert.equal(formatTryWorstCase(999_600), "1 million");
  assert.equal(formatTryWorstCase(2_000_000), "2 million");
  assert.equal(formatTryWorstCase(9_960_000), "10 million");
  assert.equal(formatTryWorstCase(12_400_000), "12 million");
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
