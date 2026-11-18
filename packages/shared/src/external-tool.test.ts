import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInstallSource,
  buildInstallCommand,
  buildRepoUrl,
  versionTag,
  parseInstallCommand,
  normalizeSubdir,
  normalizeOriginUrl,
} from "./external-tool.js";

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

test("repo URL (§69.4 gitUrl) carries no credentials and no ref", () => {
  const url = buildRepoUrl({ registryBaseUrl: "https://skilly.example.com/", namespaceSlug: "global", skillSlug: "case-study-creator" });
  assert.equal(url, "https://skilly.example.com/global/case-study-creator.git");
  assert.ok(!url.includes("@") && !url.includes("#"));
  // The same repo an install source names — only the credential and the tag differ.
  const install = buildInstallSource({ registryBaseUrl: "https://skilly.example.com", namespaceSlug: "global", skillSlug: "case-study-creator", semver: "1.0.1", token: "k" });
  assert.equal(install, `https://x-access-token:k@skilly.example.com/global/case-study-creator.git#${versionTag("1.0.1")}`);
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

test("parseInstallCommand: --all is a whole-repository import (§64.9) for each source form", () => {
  const short = parseInstallCommand("npx skills add anthropics/skills --all");
  assert.ok(short.ok);
  assert.equal(short.importAll, true);
  assert.equal(short.url, "https://github.com/anthropics/skills.git");
  assert.equal(short.subdir, null);
  assert.equal(short.ref, null);

  const full = parseInstallCommand("npx skills add https://git.example.com/acme/skills.git#v2.0.0 -a");
  assert.ok(full.ok);
  assert.equal(full.importAll, true);
  assert.equal(full.url, "https://git.example.com/acme/skills.git");
  assert.equal(full.ref, "v2.0.0");

  // A /tree/ URL keeps its ref but --all drops the folder; so does an explicit --skill.
  const tree = parseInstallCommand("npx skills add https://github.com/acme/skills/tree/main/skills/pdf --all");
  assert.ok(tree.ok);
  assert.equal(tree.importAll, true);
  assert.equal(tree.ref, "main");
  assert.equal(tree.subdir, null);
  const both = parseInstallCommand("npx skills add acme/skills --skill pdf --all --agent claude-code");
  assert.ok(both.ok);
  assert.equal(both.importAll, true);
  assert.equal(both.subdir, null);
  assert.equal(both.agent, "claude-code");

  // Without --all nothing changes.
  const one = parseInstallCommand("npx skills add acme/skills --skill pdf");
  assert.ok(one.ok);
  assert.equal(one.importAll, undefined);
});

test("parseInstallCommand: junk rejected", () => {
  assert.equal(parseInstallCommand("").ok, false);
  assert.equal(parseInstallCommand("npx skills add").ok, false);
  assert.equal(parseInstallCommand("npx skills add not a url at all !!").ok, false);
});

test("normalizeSubdir strips leading/trailing slashes, trims, lowercases", () => {
  assert.equal(normalizeSubdir("/Docs/Skill/"), "docs/skill");
  assert.equal(normalizeSubdir("  //nested//path//  "), "nested//path");
  assert.equal(normalizeSubdir(null), "");
  assert.equal(normalizeSubdir(undefined), "");
  assert.equal(normalizeSubdir("///"), "");
});

test("normalizeSubdir stays fast on an adversarial run of slashes (ReDoS regression)", () => {
  const adversarial = "/".repeat(200_000) + "x";
  const start = performance.now();
  normalizeSubdir(adversarial);
  assert.ok(performance.now() - start < 1000, "normalizeSubdir must run in linear time, not blow up on many slashes");
});

test("normalizeOriginUrl: strips wrapped/mixed quote and backtick chars", () => {
  assert.equal(normalizeOriginUrl('`https://github.com/team/skill`'), "https://github.com/team/skill");
  assert.equal(normalizeOriginUrl(`"'https://github.com/team/skill'"`), "https://github.com/team/skill");
  assert.equal(normalizeOriginUrl(null), "");
  assert.equal(normalizeOriginUrl("   "), "");
  // adversarial input that made the old /^[`'"]+|[`'"]+$/g pattern polynomial-time
  const adversarial = "`".repeat(50_000) + "x";
  assert.equal(normalizeOriginUrl(adversarial), "x".toLowerCase());
});

test("parseInstallCommand resists ReDoS on adversarial quote runs (js/polynomial-redos)", () => {
  const evilPrefix = '"'.repeat(200_000);
  const start = Date.now();
  const r = parseInstallCommand(`${evilPrefix}npx skills add owner/repo#v1`);
  assert.ok(Date.now() - start < 1000, "parseInstallCommand must run in linear time on adversarial quote runs");
  assert.ok(r.ok && r.url === "https://github.com/owner/repo.git" && r.ref === "v1");
});

// §73.4 — the installer's lock-v2 computedHash, checked against the three vectors the
// vercel-labs/skills README publishes, plus the exclusion and line-ending rules.
import {
  skillsLockComputedHash,
  skillsLockHashInput,
  isInstallerExcludedPath,
  normalizeLockLineEndings,
  sortByPathBytes,
} from "./external-tool.js";

const enc = (s: string) => new TextEncoder().encode(s);

test("lock hash: the installer README test vectors", async () => {
  assert.equal(await skillsLockComputedHash([]), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(await skillsLockComputedHash([{ path: "SKILL.md", bytes: enc("# hi\n") }]), "93c36952d8843b33e68ae970ebabcc03e1687c9bb0dd1ecaf357060318952f55");
  assert.equal(
    await skillsLockComputedHash([{ path: "docs/b.md", bytes: enc("b\n") }, { path: "SKILL.md", bytes: enc("a\n") }]),
    "b22c4d22aa319d2924312fa18fcbfedc88fa89c74dbd8f298c683e1caf7b7f24",
  );
});

test("lock hash: the input stream is path NUL length NUL content, sorted by path bytes", () => {
  const input = skillsLockHashInput([{ path: "docs/b.md", bytes: enc("b\n") }, { path: "SKILL.md", bytes: enc("a\n") }]);
  assert.equal(new TextDecoder().decode(input), "SKILL.md\u00002\u0000a\ndocs/b.md\u00002\u0000b\n");
});

test("lock hash: CRLF in a text file hashes like LF; a binary file is untouched", async () => {
  const lf = await skillsLockComputedHash([{ path: "SKILL.md", bytes: enc("a\nb\n") }]);
  const crlf = await skillsLockComputedHash([{ path: "SKILL.md", bytes: enc("a\r\nb\r\n") }]);
  assert.equal(crlf, lf);
  const bin = new Uint8Array([0, 13, 10, 65]);
  assert.equal(normalizeLockLineEndings(bin), bin);
  assert.deepEqual([...normalizeLockLineEndings(enc("x\r\ny\rz"))], [...enc("x\ny\rz")]);
});

test("lock hash: installer exclusions are skipped and backslashes become slashes", async () => {
  const base = await skillsLockComputedHash([{ path: "SKILL.md", bytes: enc("# hi\n") }]);
  const withJunk = await skillsLockComputedHash([
    { path: "SKILL.md", bytes: enc("# hi\n") },
    { path: "metadata.json", bytes: enc("{}") },
    { path: "sub/metadata.json", bytes: enc("{}") },
    { path: ".git/config", bytes: enc("x") },
    { path: "scripts/__pycache__/a.pyc", bytes: enc("x") },
    { path: "__pypackages__/x/y.py", bytes: enc("x") },
  ]);
  assert.equal(withJunk, base);
  assert.equal(isInstallerExcludedPath("metadata.json/inner.txt"), false, "a metadata.json FOLDER is not excluded");
  assert.equal(isInstallerExcludedPath("docs/.git"), false, "a .git FILE is not excluded");
  assert.equal(isInstallerExcludedPath(["a", "__pycache__", "b.pyc"].join(String.fromCharCode(92))), true, "backslash separators");
});

test("sortByPathBytes orders by UTF-8 bytes, not locale", () => {
  const sorted = sortByPathBytes([{ path: "b" }, { path: "B" }, { path: "a" }, { path: "é" }, { path: "Z" }]).map((x) => x.path);
  assert.deepEqual(sorted, ["B", "Z", "a", "b", "é"]);
});
