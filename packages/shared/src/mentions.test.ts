import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MENTIONS_PER_MESSAGE,
  extractMentions,
  maxRawMentionLength,
  mentionCollapsedLength,
  mentionToken,
  splitMentionSegments,
} from "./mentions.js";

const U1 = "11111111-2222-3333-4444-555555555555";
const U2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("mentionToken builds the canonical lowercase token", () => {
  assert.equal(mentionToken("user", U1.toUpperCase()), `<@${U1}>`);
  assert.equal(mentionToken("skill", U2), `<#${U2}>`);
});

test("splitMentionSegments splits text and mentions, preserving surrounding text", () => {
  const body = `hi <@${U1}> see <#${U2}>!`;
  assert.deepEqual(splitMentionSegments(body), [
    { type: "text", text: "hi " },
    { type: "mention", kind: "user", id: U1, token: `<@${U1}>` },
    { type: "text", text: " see " },
    { type: "mention", kind: "skill", id: U2, token: `<#${U2}>` },
    { type: "text", text: "!" },
  ]);
});

test("splitMentionSegments: plain text passes through; malformed tokens stay text", () => {
  assert.deepEqual(splitMentionSegments("no mentions here"), [{ type: "text", text: "no mentions here" }]);
  for (const bad of ["<@not-a-uuid>", `<@${U1.slice(0, 35)}>`, `<%${U1}>`, `<@ ${U1}>`]) {
    assert.deepEqual(splitMentionSegments(bad), [{ type: "text", text: bad }], bad);
  }
});

test("splitMentionSegments normalizes uppercase-hex uuids to lowercase", () => {
  const segs = splitMentionSegments(`<@${U1.toUpperCase()}>`);
  assert.deepEqual(segs, [{ type: "mention", kind: "user", id: U1, token: `<@${U1}>` }]);
});

test("extractMentions dedupes (case-insensitively) and keeps first-appearance order", () => {
  const body = `<#${U2}> <@${U1}> <@${U1.toUpperCase()}> <#${U2}>`;
  assert.deepEqual(extractMentions(body), [
    { kind: "skill", id: U2 },
    { kind: "user", id: U1 },
  ]);
});

test("extractMentions with markdown:true ignores tokens in code fences and inline backticks", () => {
  const body = ["`<@" + U1 + ">` inline-masked", "```", `<#${U2}> fenced-masked`, "```", `real: <@${U2}>`].join("\n");
  assert.deepEqual(extractMentions(body, { markdown: true }), [{ kind: "user", id: U2 }]);
});

test("extractMentions without markdown counts tokens even between backticks", () => {
  const body = "`<@" + U1 + ">`";
  assert.deepEqual(extractMentions(body), [{ kind: "user", id: U1 }]);
});

test("mentionCollapsedLength counts each token as one character", () => {
  assert.equal(mentionCollapsedLength(`hey <@${U1}>!`), "hey x!".length);
  assert.equal(mentionCollapsedLength("plain"), 5);
  // 500 tokens back-to-back = 500 chars, not 500×39.
  const many = `<@${U1}>`.repeat(500);
  assert.equal(mentionCollapsedLength(many), 500);
});

test("maxRawMentionLength bounds the raw body: cap + full-width slack for the allowed tokens", () => {
  const cap = 500;
  const max = maxRawMentionLength(cap);
  // A body at the collapsed cap with MAX allowed tokens must fit under the raw backstop.
  const tokens = `<@${U1}>`.repeat(MAX_MENTIONS_PER_MESSAGE);
  const body = tokens + "x".repeat(cap - MAX_MENTIONS_PER_MESSAGE);
  assert.equal(mentionCollapsedLength(body), cap);
  assert.ok(body.length <= max, `${body.length} <= ${max}`);
});
