// Full HTTP-level test of the git smart server: a real `git clone` over HTTP against the
// running Express server + git http-backend, exercising auth/visibility end-to-end.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { resolveAccess, type RoleMapping } from "@skilly/shared";
import { gitServer, type GitServerDeps, type OwnerInactiveRefusal } from "./server.js";
import { synthesizeVersion } from "./synth.js";
import { repoPath } from "./repoStore.js";
import { synthesizeMarketplace, marketplaceRepoDir, marketplaceHead } from "./marketplace.js";
import type { MarketplaceCredit } from "./server.js";

const exec = promisify(execFile);
const enc = (s: string) => new TextEncoder().encode(s);
const NSID = "nsid-a";
// Disable prompts + system/credential helpers so an unauthorized clone fails FAST
// (no OS credential-manager retries/backoff) and tests don't hang.
const cloneEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", GIT_CONFIG_NOSYSTEM: "1" };
const noCred = ["-c", "credential.helper="];

let workDir: string;
let server: Server;
let port: number;
const used: string[] = [];
const ips: string[] = [];
const logged: { skillId: string; userId: string | null; isSystem: boolean; countInstall: boolean }[] = [];
const refusals: OwnerInactiveRefusal[] = [];
const credits: MarketplaceCredit[] = [];
/** Simulated `tokens.last_served_commit` per marketplace token — the §30.7 attribution cursor.
 *  creditMarketplaceFetch advances it exactly as the real transaction does, so a repeat clone
 *  genuinely exercises the "already at head, credit nothing" branch. */
const cursors = new Map<string, string | null>([["m-pub", null], ["m-ns", null], ["m-out", null]]);

const mappings: RoleMapping[] = [{ id: "m1", groupId: "g-a", namespaceId: NSID, role: "namespace_member" }];

const deps: GitServerDeps = {
  async findSkill(_ns, slug) {
    if (slug === "pdf") return { id: "s-pdf", namespaceId: NSID, visibility: "org", status: "active" };
    if (slug === "secret") return { id: "s-secret", namespaceId: NSID, visibility: "namespace", status: "active" };
    return null;
  },
  async validateToken(raw) {
    // install tokens are skill-scoped; scope must match the requested skill.
    if (raw === "good-pdf") return { userId: "u1", tokenId: "t-pdf", type: "install", scopedSkillId: "s-pdf", isSystem: false };
    if (raw === "good-secret") return { userId: "u1", tokenId: "t1", type: "install", scopedSkillId: "s-secret", isSystem: false };
    // System installation: platform-owned, no user; clones the restricted skill without ns access (§23).
    if (raw === "system-secret") return { userId: null, tokenId: "t-sys", type: "install", scopedSkillId: "s-secret", isSystem: true };
    // Owner-status gate (§5/§23): valid row, but the owning user is inactive.
    if (raw === "inactive-pdf") return { userId: "u-gone", tokenId: "t-gone", type: "install", scopedSkillId: "s-pdf", isSystem: false, ownerInactive: true };
    // Marketplace tokens (§30.4) — scoped to a marketplace, never to a skill.
    if (raw === "mkt-pub") return { userId: "u1", tokenId: "m-pub", type: "marketplace", scopedMarketplace: { kind: "public" }, scopedNamespaceId: null, lastServedCommit: cursors.get("m-pub") ?? null, isSystem: false };
    if (raw === "mkt-ns") return { userId: "u1", tokenId: "m-ns", type: "marketplace", scopedMarketplace: { kind: "namespace", namespaceSlug: "team-a" }, scopedNamespaceId: NSID, lastServedCommit: cursors.get("m-ns") ?? null, isSystem: false };
    if (raw === "mkt-outsider") return { userId: "u2", tokenId: "m-out", type: "marketplace", scopedMarketplace: { kind: "namespace", namespaceSlug: "team-a" }, scopedNamespaceId: NSID, lastServedCommit: null, isSystem: false };
    return null;
  },
  async findMarketplace(scope) {
    if (scope.kind === "public") return { scope, namespaceId: null, enabled: true };
    if (scope.namespaceSlug === "team-a") return { scope, namespaceId: NSID, enabled: true };
    if (scope.namespaceSlug === "team-off") return { scope, namespaceId: "nsid-off", enabled: false };
    return null;
  },
  async markMarketplaceUsed(tokenId, _ua, clientIp) {
    const first = !used.includes(tokenId);
    used.push(tokenId);
    if (clientIp) ips.push(clientIp);
    return first;
  },
  async creditMarketplaceFetch(input) {
    credits.push(input);
    cursors.set(input.tokenId, input.newCommit);
    return input.slugs.length;
  },
  async resolveAccess(userId) {
    return resolveAccess(userId === "u1" ? new Set(["g-a"]) : new Set(), mappings);
  },
  async markInstallUsed(tokenId, _userAgent, clientIp) {
    const first = !used.includes(tokenId);
    used.push(tokenId);
    if (clientIp) ips.push(clientIp);
    return first;
  },
  async logAccess(skillId, userId, isSystem, countInstall) {
    logged.push({ skillId, userId, isSystem, countInstall });
  },
  async recordOwnerInactiveRefusal(e) {
    refusals.push(e);
  },
};

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "skilly-gitsrv-"));
  deps.repoRoot = join(workDir, "repos");

  // Public skill `pdf` with two versions (main -> v2.0.0).
  const pdf = repoPath(deps.repoRoot, "team-a", "pdf");
  await synthesizeVersion({ bareRepoPath: pdf, semver: "1.0.0", isLatestStable: true, files: [{ path: "SKILL.md", bytes: enc("# pdf v1\n") }] });
  await synthesizeVersion({ bareRepoPath: pdf, semver: "2.0.0", isLatestStable: true, files: [{ path: "SKILL.md", bytes: enc("# pdf v2\n") }] });

  // Restricted skill `secret`.
  const secret = repoPath(deps.repoRoot, "team-a", "secret");
  await synthesizeVersion({ bareRepoPath: secret, semver: "1.0.0", isLatestStable: true, files: [{ path: "SKILL.md", bytes: enc("# top secret\n") }] });

  // Marketplaces (§30): the public one lists the org-visible `pdf`; team-a's lists `secret`.
  await synthesizeMarketplace({
    bareRepoPath: marketplaceRepoDir(deps.repoRoot!, { kind: "public" }),
    manifest: { prefix: "skilly", scope: { kind: "public" }, ownerName: "skilly.test", version: "v1" },
    plugins: [
      {
        skillSlug: "pdf",
        title: "PDF",
        description: "pdf things",
        version: "2.0.0",
        files: [
          { path: "SKILL.md", bytes: enc("# pdf v2\n") },
          { path: "hooks.json", bytes: enc("{}\n") },
        ],
      },
    ],
    change: { added: ["pdf"], updated: [], removed: [] },
    date: "2026-01-01T00:00:00Z",
  });
  await synthesizeMarketplace({
    bareRepoPath: marketplaceRepoDir(deps.repoRoot!, { kind: "namespace", namespaceSlug: "team-a" }),
    manifest: { prefix: "skilly", scope: { kind: "namespace", namespaceSlug: "team-a" }, ownerName: "Team A", version: "v1" },
    plugins: [
      { skillSlug: "secret", title: "Secret", description: null, version: "1.0.0", files: [{ path: "SKILL.md", bytes: enc("# top secret\n") }] },
    ],
    change: { added: ["secret"], updated: [], removed: [] },
    date: "2026-01-01T00:00:00Z",
  });

  const app = express();
  app.use(gitServer(deps));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workDir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${port}`;

test("org skill: token + no #ref clones the default branch (main = latest)", async () => {
  const dest = join(workDir, "c-pub");
  await exec("git", ["clone", `http://x-access-token:good-pdf@127.0.0.1:${port}/team-a/pdf.git`, dest], { env: cloneEnv });
  const head = (await exec("git", ["-C", dest, "show", "refs/heads/main:SKILL.md"])).stdout;
  assert.match(head, /pdf v2/);
});

test("org skill: pinned tag clones the exact version", async () => {
  const dest = join(workDir, "c-pin");
  await exec("git", ["clone", "--branch", "v1.0.0", `http://x-access-token:good-pdf@127.0.0.1:${port}/team-a/pdf.git`, dest], { env: cloneEnv });
  const v1 = (await exec("git", ["-C", dest, "show", "v1.0.0:SKILL.md"])).stdout;
  assert.match(v1, /pdf v1/);
});

test("any skill without a token is rejected (org included)", async () => {
  const dest = join(workDir, "c-noauth");
  await assert.rejects(exec("git", ["clone", ...noCred, `${base()}/team-a/pdf.git`, dest], { env: cloneEnv }));
});

test("restricted skill without a token is rejected", async () => {
  const dest = join(workDir, "c-noauth-secret");
  await assert.rejects(exec("git", ["clone", ...noCred, `${base()}/team-a/secret.git`, dest], { env: cloneEnv }));
});

test("token of an inactive owner: generic 401, nothing served, refusal recorded with the owner as subject", async () => {
  used.length = 0;
  logged.length = 0;
  refusals.length = 0;

  // Raw HTTP first: the response must be byte-identical to a plain invalid token's 401 —
  // no hint that the account (rather than the token) is the problem. §5/§23.
  const auth = "Basic " + Buffer.from("x-access-token:inactive-pdf").toString("base64");
  const res = await fetch(`${base()}/team-a/pdf.git/info/refs?service=git-upload-pack`, { headers: { authorization: auth } });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), 'Basic realm="skilly"');
  assert.equal(await res.text(), "invalid or expired token");

  // A real clone attempt fails the same way.
  const dest = join(workDir, "c-inactive");
  await assert.rejects(exec("git", ["clone", ...noCred, `http://x-access-token:inactive-pdf@127.0.0.1:${port}/team-a/pdf.git`, dest], { env: cloneEnv }));

  // The refusal was recorded (once per refused request) with the token OWNER as the subject,
  // the matched route template, and the concrete path — never the query string. §25 carve-out.
  assert.ok(refusals.length >= 1);
  assert.deepEqual(refusals[0], {
    method: "GET",
    route: "/[ns]/[slug].git/info/refs",
    path: "/team-a/pdf.git/info/refs",
    ownerUserId: "u-gone",
    namespaceSlug: "team-a",
    skillSlug: "pdf",
  });

  // Nothing was stamped or counted — the clone never happened.
  assert.equal(used.length, 0);
  assert.equal(logged.length, 0);
});

test("restricted skill with a valid token clones, marks token used once, logs access once", async () => {
  used.length = 0;
  ips.length = 0;
  logged.length = 0;
  const dest = join(workDir, "c-auth");
  await exec("git", ["clone", `http://x-access-token:good-secret@127.0.0.1:${port}/team-a/secret.git`, dest], { env: cloneEnv });
  const md = (await exec("git", ["-C", dest, "show", "refs/heads/main:SKILL.md"])).stdout;
  assert.match(md, /top secret/);
  // Recorded once per clone (on the /info/refs advertisement), not per upload-pack POST,
  // so protocol-v2's multiple POSTs don't double-count.
  assert.deepEqual(used, ["t1"]);
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0], { skillId: "s-secret", userId: "u1", isSystem: false, countInstall: false });
  // The originating client IP is captured on first use (loopback here; ::ffff: prefix stripped).
  assert.equal(ips.length, 1);
  assert.match(ips[0]!, /^(127\.0\.0\.1|::1)$/);
});

test("restricted skill: SYSTEM token clones without namespace access; first clone counts, repeat doesn't", async () => {
  used.length = 0;
  logged.length = 0;
  // First clone: stamps the token (first use) → logged as a system clone that counts the install.
  const dest1 = join(workDir, "c-sys-1");
  await exec("git", ["clone", `http://x-access-token:system-secret@127.0.0.1:${port}/team-a/secret.git`, dest1], { env: cloneEnv });
  assert.deepEqual(logged[0], { skillId: "s-secret", userId: null, isSystem: true, countInstall: true });
  // Second clone with the SAME token: still allowed (reusable), but no longer a first use.
  const dest2 = join(workDir, "c-sys-2");
  await exec("git", ["clone", `http://x-access-token:system-secret@127.0.0.1:${port}/team-a/secret.git`, dest2], { env: cloneEnv });
  assert.equal(logged.length, 2);
  assert.deepEqual(logged[1], { skillId: "s-secret", userId: null, isSystem: true, countInstall: false });
});

// ---------------------------------------------------------------------------
// Plugin marketplaces (SKILLY_SPEC.md §30)
// ---------------------------------------------------------------------------

test("marketplace: a tokened clone serves the manifest and the embedded plugin layout", async () => {
  const dest = join(workDir, "c-mkt-pub");
  await exec("git", ["clone", `http://x-access-token:mkt-pub@127.0.0.1:${port}/_marketplace/_public.git`, dest], { env: cloneEnv });

  const manifest = JSON.parse((await exec("git", ["-C", dest, "show", "main:.claude-plugin/marketplace.json"])).stdout);
  assert.equal(manifest.name, "skilly-public");
  assert.equal(manifest.metadata.pluginRoot, "./plugins");
  assert.equal(manifest.plugins[0].source, "./plugins/pdf");
  assert.equal(manifest.plugins[0].version, "2.0.0");

  // The skill lands under skills/<slug>/, and a bundle-root hooks.json is HOISTED to the plugin
  // root (under skills/<slug>/ Claude Code would never read it) and wired into plugin.json. §30.3
  const skillMd = (await exec("git", ["-C", dest, "show", "main:plugins/pdf/skills/pdf/SKILL.md"])).stdout;
  assert.match(skillMd, /pdf v2/);
  const pluginJson = JSON.parse((await exec("git", ["-C", dest, "show", "main:plugins/pdf/.claude-plugin/plugin.json"])).stdout);
  assert.deepEqual(pluginJson.skills, ["./skills/"]);
  assert.equal(pluginJson.hooks, "./hooks.json");
  await exec("git", ["-C", dest, "show", "main:plugins/pdf/hooks.json"]);
});

test("marketplace: a marketplace repo carries no version tags (§30.3)", async () => {
  const dest = join(workDir, "c-mkt-tags");
  await exec("git", ["clone", `http://x-access-token:mkt-pub@127.0.0.1:${port}/_marketplace/_public.git`, dest], { env: cloneEnv });
  const tags = (await exec("git", ["-C", dest, "tag", "--list"])).stdout.trim();
  assert.equal(tags, "");
});

test("marketplace: the first clone credits every listed skill, a repeat clone credits nothing", async () => {
  credits.length = 0;
  cursors.set("m-ns", null);
  const dir = marketplaceRepoDir(deps.repoRoot!, { kind: "namespace", namespaceSlug: "team-a" });
  const head = await marketplaceHead(dir);

  const first = join(workDir, "c-mkt-ns-1");
  await exec("git", ["clone", `http://x-access-token:mkt-ns@127.0.0.1:${port}/_marketplace/team-a.git`, first], { env: cloneEnv });
  assert.equal(credits.length, 1);
  assert.deepEqual(credits[0]!.slugs, ["secret"]);
  assert.equal(credits[0]!.newCommit, head);
  assert.equal(credits[0]!.userId, "u1");

  // Cursor now at head: a re-clone is a no-op poll and must not re-credit (§30.7).
  const second = join(workDir, "c-mkt-ns-2");
  await exec("git", ["clone", `http://x-access-token:mkt-ns@127.0.0.1:${port}/_marketplace/team-a.git`, second], { env: cloneEnv });
  assert.equal(credits.length, 2);
  assert.deepEqual(credits[1]!.slugs, []);
});

test("marketplace: a namespace marketplace is refused for someone without namespace access", async () => {
  const dest = join(workDir, "c-mkt-outsider");
  await assert.rejects(
    exec("git", ["clone", ...noCred, `http://x-access-token:mkt-outsider@127.0.0.1:${port}/_marketplace/team-a.git`, dest], { env: cloneEnv }),
  );
});

test("marketplace: no token, wrong-scope token, and a disabled marketplace are all refused", async () => {
  const noAuth = await fetch(`${base()}/_marketplace/_public.git/info/refs?service=git-upload-pack`);
  assert.equal(noAuth.status, 401);

  // A skill install token must not open a marketplace.
  const wrong = "Basic " + Buffer.from("x-access-token:good-pdf").toString("base64");
  const wrongRes = await fetch(`${base()}/_marketplace/_public.git/info/refs?service=git-upload-pack`, { headers: { authorization: wrong } });
  assert.equal(wrongRes.status, 403);

  // A disabled marketplace 404s — it never confirms that the namespace exists.
  const auth = "Basic " + Buffer.from("x-access-token:mkt-ns").toString("base64");
  const off = await fetch(`${base()}/_marketplace/team-off.git/info/refs?service=git-upload-pack`, { headers: { authorization: auth } });
  assert.equal(off.status, 404);
});
