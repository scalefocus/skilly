import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInstallSource, buildInstallCommand, versionTag, parseInstallCommand } from "./external-tool.js";

test("version maps to v-prefixed git tag", () => {
  assert.equal(versionTag("1.2.0"), "v1.2.0");
  assert.equal(versionTag("2.0.0-beta.1"), "v2.0.0-beta.1");
});

test("install source embeds token as basic-auth and pins tag", () => {
  const url = buildInstallSource({
    registryBaseUrl: "https://skilly.example.com",
    namespaceSlug: "team-a",
    skillSlug: "pdf-tools",
    semver: "1.2.0",
    token: "abc123",
  });
  assert.equal(url, "https://x-access-token:abc123@skilly.example.com/team-a/pdf-tools.git#v1.2.0");
});

test("public skill (no token) omits credentials", () => {
  const url = buildInstallSource({
    registryBaseUrl: "https://skilly.example.com",
    namespaceSlug: "global",
    skillSlug: "lint",
    semver: "3.1.4",
  });
  assert.equal(url, "https://skilly.example.com/global/lint.git#v3.1.4");
});

test("a recognized non-generic agent appends --agent at the end", () => {
  const cmd = buildInstallCommand({
    registryBaseUrl: "https://skilly.example.com",
    namespaceSlug: "global",
    skillSlug: "lint",
    semver: "1.0.0",
    agent: "cursor",
  });
  assert.equal(cmd, "npx skills add https://skilly.example.com/global/lint.git#v1.0.0 --agent cursor");
});

test("generic / unknown / missing agent appends no --agent", () => {
  const base = { registryBaseUrl: "https://skilly.example.com", namespaceSlug: "global", skillSlug: "lint", semver: "1.0.0" };
  assert.equal(buildInstallCommand({ ...base, agent: "generic" }), "npx skills add https://skilly.example.com/global/lint.git#v1.0.0");
  assert.equal(buildInstallCommand({ ...base, agent: "totally-made-up" }), "npx skills add https://skilly.example.com/global/lint.git#v1.0.0");
  assert.equal(buildInstallCommand(base), "npx skills add https://skilly.example.com/global/lint.git#v1.0.0");
});

test("parseInstallCommand captures a recognized --agent", () => {
  const p = parseInstallCommand("npx skills add owner/repo#v1 --agent cursor");
  assert.equal(p.ok, true);
  if (p.ok) assert.equal(p.agent, "cursor");
  const p2 = parseInstallCommand("npx skills add owner/repo#v1 --agent=claude-code");
  if (p2.ok) assert.equal(p2.agent, "claude-code");
});

test("full command prefixes npx skills add", () => {
  const cmd = buildInstallCommand({
    registryBaseUrl: "https://skilly.example.com",
    namespaceSlug: "global",
    skillSlug: "lint",
    semver: "3.1.4",
  });
  assert.equal(cmd, "npx skills add https://skilly.example.com/global/lint.git#v3.1.4");
});

test("parseInstallCommand: full URL with #ref", () => {
  assert.deepEqual(parseInstallCommand("npx skills add https://github.com/acme/skill.git#v1.0.0"), {
    ok: true, url: "https://github.com/acme/skill.git", ref: "v1.0.0", subdir: null, agent: null,
  });
});

test("parseInstallCommand: --skill flag on a multi-skill repo", () => {
  assert.deepEqual(parseInstallCommand("npx skills add https://github.com/anthropics/skills --skill frontend-design"), {
    ok: true, url: "https://github.com/anthropics/skills.git", ref: null, subdir: "frontend-design", agent: null,
  });
});

test("parseInstallCommand: owner/repo shorthand + --skill= form + tool noise flags", () => {
  assert.deepEqual(parseInstallCommand("npx skills add anthropics/skills --skill=pdf -y --global"), {
    ok: true, url: "https://github.com/anthropics/skills.git", ref: null, subdir: "pdf", agent: null,
  });
});

test("parseInstallCommand: GitHub /tree/<ref>/<path> URL", () => {
  assert.deepEqual(parseInstallCommand("npx skills add https://github.com/anthropics/skills/tree/main/frontend-design"), {
    ok: true, url: "https://github.com/anthropics/skills.git", ref: "main", subdir: "frontend-design", agent: null,
  });
});

test("parseInstallCommand: prompt noise, quotes, bare source", () => {
  assert.deepEqual(parseInstallCommand("$ npx skills add 'https://github.com/a/b.git#v2'"), {
    ok: true, url: "https://github.com/a/b.git", ref: "v2", subdir: null, agent: null,
  });
  assert.deepEqual(parseInstallCommand("https://github.com/a/b#v2"), {
    ok: true, url: "https://github.com/a/b.git", ref: "v2", subdir: null, agent: null,
  });
});

test("parseInstallCommand: skills-hub install command", () => {
  assert.deepEqual(parseInstallCommand("npx @skills-hub-ai/cli install alirezarezvani-ui-design-system"), {
    ok: true,
    url: "https://skills-hub.ai/api/v1/skills/alirezarezvani-ui-design-system",
    ref: null,
    subdir: null,
    provider: "skills-hub",
    hubSlug: "alirezarezvani-ui-design-system",
  });
  // installed binary form + flag noise
  const r = parseInstallCommand("skills-hub install some-skill --target cursor");
  assert.ok(r.ok && r.provider === "skills-hub" && r.hubSlug === "some-skill");
  // missing slug / bad slug
  assert.equal(parseInstallCommand("npx @skills-hub-ai/cli install").ok, false);
  assert.equal(parseInstallCommand("npx @skills-hub-ai/cli install UPPER_case!").ok, false);
});

test("parseInstallCommand: wrapper CLIs with a git source (owner/repo, --agent noise)", () => {
  // `npx -y skills add owner/repo --skill name --agent claude-code`
  assert.deepEqual(parseInstallCommand("npx -y skills add shadcn/improve --skill improve --agent claude-code"), {
    ok: true, url: "https://github.com/shadcn/improve.git", ref: null, subdir: "improve", agent: "claude-code",
  });
  // a different CLI binary + verb, owner/repo source, no --skill
  assert.deepEqual(parseInstallCommand("npx agent-skills-cli add alirezarezvani/claude-skills"), {
    ok: true, url: "https://github.com/alirezarezvani/claude-skills.git", ref: null, subdir: null, agent: null,
  });
  // full git URL through a wrapper, with --skill
  assert.deepEqual(parseInstallCommand("npx skills add https://github.com/netresearch/agent-skills --skill deploy"), {
    ok: true, url: "https://github.com/netresearch/agent-skills.git", ref: null, subdir: "deploy", agent: null,
  });
});

test("parseInstallCommand: registry-only commands rejected (no git repo to mirror)", () => {
  // lobehub market-cli — proprietary registry slug, no git repo
  assert.equal(parseInstallCommand("npx -y @lobehub/market-cli skills install affaan-m-everything-claude-code-frontend-design --agent claude-code").ok, false);
  // clawhub — registry slug
  assert.equal(parseInstallCommand("npx clawhub@latest install sonoscli").ok, false);
  // agentskill.sh setup — no skill/repo
  assert.equal(parseInstallCommand("npx @agentskill.sh/cli@latest setup").ok, false);
  // agent-skills-hub flag-only
  assert.equal(parseInstallCommand("npx agent-skills-hub --claude").ok, false);
});

test("parseInstallCommand: --all rejected; junk rejected", () => {
  assert.equal(parseInstallCommand("npx skills add anthropics/skills --all").ok, false);
  assert.equal(parseInstallCommand("").ok, false);
  assert.equal(parseInstallCommand("npx skills add").ok, false);
  assert.equal(parseInstallCommand("npx skills add not a url at all !!").ok, false);
});
