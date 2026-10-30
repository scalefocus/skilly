// Unit tests for the propose page's tabs and their address (SKILLY_SPEC.md §64.2, §64.12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyImportRedirect, proposeTabFromAddress, proposeTabQuery, repoTabHref } from "./proposeTab";

test("proposeTabFromAddress: mode=repo and mode=want open their tabs; anything else is I have a skill", () => {
  assert.equal(proposeTabFromAddress("repo", false), "repo");
  assert.equal(proposeTabFromAddress("want", false), "want");
  assert.equal(proposeTabFromAddress(null, false), "have");
  assert.equal(proposeTabFromAddress("have", false), "have");
  assert.equal(proposeTabFromAddress("REPO", false), "have");
  assert.equal(proposeTabFromAddress("", false), "have");
});

test("proposeTabFromAddress: a new-version link wins over mode", () => {
  assert.equal(proposeTabFromAddress("repo", true), "have");
  assert.equal(proposeTabFromAddress("want", true), "have");
});

test("proposeTabQuery: rewrites mode and keeps every other parameter", () => {
  assert.equal(proposeTabQuery("", "repo"), "?mode=repo");
  assert.equal(proposeTabQuery("?mode=repo", "want"), "?mode=want");
  assert.equal(proposeTabQuery("?mode=want", "have"), "");
  assert.equal(proposeTabQuery("?url=https%3A%2F%2Fgit.example.test%2Fa.git&mode=repo&ref=v1", "have"), "?url=https%3A%2F%2Fgit.example.test%2Fa.git&ref=v1");
  assert.equal(proposeTabQuery("?fromRequest=abc", "want"), "?fromRequest=abc&mode=want");
});

test("repoTabHref: the repo tab with Repository and Ref, ref left out when absent", () => {
  assert.equal(repoTabHref("https://github.com/acme/skills.git", "v2.0.0"), "/propose?mode=repo&url=https%3A%2F%2Fgithub.com%2Facme%2Fskills.git&ref=v2.0.0");
  assert.equal(repoTabHref("https://github.com/acme/skills.git", null), "/propose?mode=repo&url=https%3A%2F%2Fgithub.com%2Facme%2Fskills.git");
});

test("legacyImportRedirect: /propose/import lands on the repo tab with its query kept", () => {
  assert.equal(legacyImportRedirect({}), "/propose?mode=repo");
  assert.equal(
    legacyImportRedirect({ url: "https://github.com/acme/skills.git", ref: "main" }),
    "/propose?url=https%3A%2F%2Fgithub.com%2Facme%2Fskills.git&ref=main&mode=repo",
  );
  // A stray mode is overridden, and repeated values survive.
  assert.equal(legacyImportRedirect({ mode: "want", x: ["1", "2"], skip: undefined }), "/propose?mode=repo&x=1&x=2");
});
