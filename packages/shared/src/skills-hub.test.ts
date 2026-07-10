import { test } from "node:test";
import assert from "node:assert/strict";
import { skillsHubApiUrl, isSkillsHubUrl, parseSkillsHubApiUrl, buildSkillsHubSkillMd, validateSkillsHubSlug, validateSkillsHubRef } from "./skills-hub.js";

test("skills-hub URL round-trip", () => {
  const url = skillsHubApiUrl("acme-pdf-tools");
  assert.equal(url, "https://skills-hub.ai/api/v1/skills/acme-pdf-tools");
  assert.ok(isSkillsHubUrl(url));
  assert.equal(parseSkillsHubApiUrl(url), "acme-pdf-tools");
});

test("isSkillsHubUrl rejects non-hub and lookalike URLs", () => {
  for (const u of [
    "https://github.com/a/b.git",
    "https://evil.example/api/v1/skills/x",
    "http://skills-hub.ai/api/v1/skills/x", // not https
    "https://skills-hub.ai/skills/x", // wrong path
    "not a url",
  ]) {
    assert.equal(isSkillsHubUrl(u), false, u);
  }
});

test("validateSkillsHubSlug enforces kebab", () => {
  assert.equal(validateSkillsHubSlug("acme-skill-1"), null);
  assert.ok(validateSkillsHubSlug(""));
  assert.ok(validateSkillsHubSlug("Upper"));
  assert.ok(validateSkillsHubSlug("-lead"));
  assert.ok(validateSkillsHubSlug("a_b"));
});

test("validateSkillsHubRef accepts registry versions, rejects branch-like refs", () => {
  assert.equal(validateSkillsHubRef("1.0.0"), null);
  assert.equal(validateSkillsHubRef("v1.0.0"), null);
  assert.equal(validateSkillsHubRef("2.10.3-beta.1"), null);
  assert.equal(validateSkillsHubRef(" 1.0.0 "), null); // whitespace tolerated
  for (const r of ["main", "HEAD", "master", "1.0", "v1", "", "latest"]) {
    assert.ok(validateSkillsHubRef(r), `should reject "${r}"`);
  }
});

test("buildSkillsHubSkillMd: skilly slug in frontmatter, one-line description", () => {
  const md = buildSkillsHubSkillMd("my-skill", "Multi\nline   desc", "# Body\n\ncontent");
  assert.match(md, /^---\nname: my-skill\ndescription: Multi line desc\n---\n\n# Body\n\ncontent\n$/);
});
