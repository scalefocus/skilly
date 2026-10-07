import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenMentions, mentionPlainText } from "./mentionPlainText";
import type { MentionMap } from "./mentions";

const U = "dd073f3f-e129-4955-be1d-07087230bfa7";
const E = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";
const S_ORG = "11111111-2222-3333-4444-555555555555";
const S_NS = "22222222-3333-4444-5555-666666666666";
const S_HIDDEN = "33333333-4444-5555-6666-777777777777";
const S_GONE = "44444444-5555-6666-7777-888888888888";
const S_GONE_NOLABEL = "55555555-6666-7777-8888-999999999999";

const map: MentionMap = {
  [`<@${U}>`]: { kind: "user", id: U, name: "Maya Ivanova", erased: false },
  [`<@${E}>`]: { kind: "user", id: E, name: "Deleted User", erased: true },
  [`<#${S_ORG}>`]: { kind: "skill", id: S_ORG, state: "ok", title: "PDF Tools", ns: "global", slug: "pdf-tools", restricted: false, icon: null },
  [`<#${S_NS}>`]: { kind: "skill", id: S_NS, state: "ok", title: "Payroll Audit", ns: "finance", slug: "payroll-audit", restricted: true, icon: null },
  [`<#${S_HIDDEN}>`]: { kind: "skill", id: S_HIDDEN, state: "restricted" },
  [`<#${S_GONE}>`]: { kind: "skill", id: S_GONE, state: "gone", label: "finance/old-skill" },
  [`<#${S_GONE_NOLABEL}>`]: { kind: "skill", id: S_GONE_NOLABEL, state: "gone", label: null },
};

test("flattenMentions: a person renders as @Display Name", () => {
  assert.equal(flattenMentions(`<@${U}> could we make this faster?`, map), "@Maya Ivanova could we make this faster?");
});

test("flattenMentions: an erased person renders the bare tombstone label (no @)", () => {
  assert.equal(flattenMentions(`ask <@${E}>`, map), "ask Deleted User");
});

test("flattenMentions: a visible org skill renders as #Title", () => {
  assert.equal(flattenMentions(`try <#${S_ORG}>`, map), "try #PDF Tools");
});

test("flattenMentions: a visible namespace-restricted skill is ns-prefixed like its chip", () => {
  assert.equal(flattenMentions(`see <#${S_NS}>`, map), "see #finance / Payroll Audit");
});

test("flattenMentions: a skill the reader can't see is redacted — no title, slug or namespace", () => {
  const out = flattenMentions(`see <#${S_HIDDEN}> now`, map);
  assert.equal(out, "see a restricted skill now");
  assert.ok(!out.includes(S_HIDDEN), "the uuid never survives");
});

test("flattenMentions: a hard-deleted skill renders its stored label, else 'a deleted skill'", () => {
  assert.equal(flattenMentions(`<#${S_GONE}>`, map), "finance/old-skill");
  assert.equal(flattenMentions(`<#${S_GONE_NOLABEL}>`, map), "a deleted skill");
});

test("flattenMentions: a token with no resolution stays literal (thread parity)", () => {
  const stray = "<@99999999-aaaa-bbbb-cccc-dddddddddddd>";
  assert.equal(flattenMentions(`hi ${stray}`, map), `hi ${stray}`);
});

test("flattenMentions: tokens match case-insensitively and repeat; plain text passes through", () => {
  assert.equal(flattenMentions(`<@${U.toUpperCase()}> & <@${U}>: <#${S_ORG}>`, map), "@Maya Ivanova & @Maya Ivanova: #PDF Tools");
  assert.equal(flattenMentions("no tokens here, <@not-a-uuid>", map), "no tokens here, <@not-a-uuid>");
  assert.equal(flattenMentions("", map), "");
});

test("mentionPlainText: undefined resolution returns the token", () => {
  assert.equal(mentionPlainText("<#x>", undefined), "<#x>");
});
