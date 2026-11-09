import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  USAGE_HOOK_SOURCE,
  USAGE_HOOK_SCRIPT_PATH,
  USAGE_MANIFEST_PATH,
  USAGE_REPORT_PATH,
  appendUsageHooks,
  buildUsageKeySnippet,
  buildUsageManifest,
  usageHookEvents,
  usageKeyEnvVar,
} from "./usage-hook.js";

test("usageKeyEnvVar derives an instance-specific variable from the marketplace prefix", () => {
  assert.equal(usageKeyEnvVar("skilly"), "SKILLY_USAGE_KEY");
  assert.equal(usageKeyEnvVar("skilly-dev"), "SKILLY_DEV_USAGE_KEY");
  assert.equal(usageKeyEnvVar("  acme-2  "), "ACME_2_USAGE_KEY");
  assert.equal(usageKeyEnvVar(""), "SKILLY_USAGE_KEY");
});

test("buildUsageKeySnippet is the env fragment for ~/.claude/settings.json", () => {
  const s = buildUsageKeySnippet("SKILLY_USAGE_KEY", "abc");
  assert.deepEqual(JSON.parse(s), { env: { SKILLY_USAGE_KEY: "abc" } });
});

test("buildUsageManifest keys members by directory, sorted", () => {
  const m = buildUsageManifest({
    registryBaseUrl: "https://skilly.example.com",
    envVar: "SKILLY_USAGE_KEY",
    marketplaceName: "skilly-team-a",
    pluginSlug: "productivity",
    members: [
      { skillDir: "zeta", skillId: "z", semver: "2.0.0" },
      { skillDir: "alpha", skillId: "a", semver: "1.2.3" },
    ],
  });
  assert.deepEqual(Object.keys(m.skills), ["alpha", "zeta"]);
  assert.deepEqual(m.skills.alpha, { id: "a", semver: "1.2.3" });
  assert.equal(m.plugin, "productivity");
});

test("usageHookEvents: exec form, async, both events", () => {
  const ev = usageHookEvents();
  assert.deepEqual(Object.keys(ev), ["PostToolUse", "UserPromptExpansion"]);
  const post = ev.PostToolUse![0] as { matcher: string; hooks: { command: string; args: string[]; async: boolean }[] };
  assert.equal(post.matcher, "Skill");
  assert.equal(post.hooks[0]!.command, "node");
  assert.deepEqual(post.hooks[0]!.args, [`\${CLAUDE_PLUGIN_ROOT}/${USAGE_HOOK_SCRIPT_PATH}`]);
  assert.equal(post.hooks[0]!.async, true);
});

test("appendUsageHooks: absent file → wrapped shape; member hooks kept and ours appended last", () => {
  const fresh = appendUsageHooks(null) as { hooks: Record<string, unknown[]> };
  assert.deepEqual(Object.keys(fresh), ["hooks"]);
  assert.equal(fresh.hooks.PostToolUse!.length, 1);

  const member = { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }], Stop: [{ hooks: [] }] } };
  const merged = appendUsageHooks(member) as { hooks: Record<string, unknown[]> };
  assert.equal(merged.hooks.PostToolUse!.length, 2);
  assert.deepEqual((merged.hooks.PostToolUse![0] as { matcher: string }).matcher, "Bash");
  assert.deepEqual((merged.hooks.PostToolUse![1] as { matcher: string }).matcher, "Skill");
  assert.equal(merged.hooks.Stop!.length, 1);
  assert.equal(merged.hooks.UserPromptExpansion!.length, 1);
  // the input is not mutated
  assert.equal(member.hooks.PostToolUse.length, 1);
});

test("appendUsageHooks: a member that wrote events at the top level stays in that shape", () => {
  const merged = appendUsageHooks({ PostToolUse: [{ matcher: "Bash", hooks: [] }] }) as Record<string, unknown[]>;
  assert.equal("hooks" in merged, false);
  assert.equal(merged.PostToolUse!.length, 2);
  assert.equal(merged.UserPromptExpansion!.length, 1);
});

// ---------------------------------------------------------------------------
// The reporter itself, run under node (§68.11)
// ---------------------------------------------------------------------------

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

async function withServer(opts: { hang?: boolean }, fn: (base: string, got: Captured[]) => Promise<void>): Promise<void> {
  const got: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      got.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (opts.hang) return; // never answer
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`, got);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function withPlugin(base: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "skilly-usage-hook-"));
  try {
    await writeFile(join(dir, "usage.mjs"), USAGE_HOOK_SOURCE);
    const manifest = buildUsageManifest({
      registryBaseUrl: base,
      envVar: "SKILLY_TEST_USAGE_KEY",
      marketplaceName: "skilly-team-a",
      pluginSlug: "productivity",
      members: [{ skillDir: "deploy", skillId: "11111111-1111-4111-8111-111111111111", semver: "1.4.0" }],
    });
    await writeFile(join(dir, "usage.json"), JSON.stringify(manifest));
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runHook(dir: string, stdin: string, env: Record<string, string | undefined>): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(dir, "usage.mjs")], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

const postToolUse = (skill: string) =>
  JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill, args: "secret args" }, tool_use_id: "toolu_01ABC", session_id: "s1", cwd: "/home/me", transcript_path: "/home/me/t.jsonl" });

test("hook: no key → exits 0 at once, no request", async () => {
  await withServer({}, async (base, got) => {
    await withPlugin(base, async (dir) => {
      const r = await runHook(dir, postToolUse("deploy"), { SKILLY_TEST_USAGE_KEY: "" });
      assert.equal(r.code, 0);
      assert.equal(r.stdout, "");
      assert.equal(got.length, 0);
    });
  });
});

test("hook: PostToolUse Skill for a member → one POST with the right body, bearer and user agent", async () => {
  await withServer({}, async (base, got) => {
    await withPlugin(base, async (dir) => {
      const r = await runHook(dir, postToolUse("deploy"), { SKILLY_TEST_USAGE_KEY: "k-123" });
      assert.equal(r.code, 0);
      assert.equal(r.stdout, "");
      assert.equal(got.length, 1);
      assert.equal(got[0]!.method, "POST");
      assert.equal(got[0]!.url, USAGE_REPORT_PATH);
      assert.equal(got[0]!.headers.authorization, "Bearer k-123");
      assert.match(String(got[0]!.headers["user-agent"]), /^skilly-usage-hook\/\d+$/);
      assert.deepEqual(JSON.parse(got[0]!.body), { skillId: "11111111-1111-4111-8111-111111111111", semver: "1.4.0", trigger: "model", eventId: "toolu_01ABC" });
      assert.equal(got[0]!.body.includes("secret args"), false);
    });
  });
});

test("hook: a plugin-prefixed name is accepted for this plugin and refused for another", async () => {
  await withServer({}, async (base, got) => {
    await withPlugin(base, async (dir) => {
      await runHook(dir, postToolUse("productivity:deploy"), { SKILLY_TEST_USAGE_KEY: "k" });
      assert.equal(got.length, 1);
      await runHook(dir, postToolUse("general:deploy"), { SKILLY_TEST_USAGE_KEY: "k" });
      assert.equal(got.length, 1);
    });
  });
});

test("hook: UserPromptExpansion → trigger user, prompt_id as the event id", async () => {
  await withServer({}, async (base, got) => {
    await withPlugin(base, async (dir) => {
      const input = JSON.stringify({ hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: "productivity:deploy", command_args: "x", command_source: "plugin", prompt: "/productivity:deploy x", prompt_id: "p-9" });
      const r = await runHook(dir, input, { SKILLY_TEST_USAGE_KEY: "k" });
      assert.equal(r.code, 0);
      assert.equal(got.length, 1);
      const body = JSON.parse(got[0]!.body);
      assert.equal(body.trigger, "user");
      assert.equal(body.eventId, "p-9");
    });
  });
});

test("hook: a non-member skill, another tool, another event or garbage → nothing sent, exit 0", async () => {
  await withServer({}, async (base, got) => {
    await withPlugin(base, async (dir) => {
      const env = { SKILLY_TEST_USAGE_KEY: "k" };
      assert.equal((await runHook(dir, postToolUse("other-skill"), env)).code, 0);
      assert.equal((await runHook(dir, JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } }), env)).code, 0);
      assert.equal((await runHook(dir, JSON.stringify({ hook_event_name: "Stop" }), env)).code, 0);
      assert.equal((await runHook(dir, "not json", env)).code, 0);
      assert.equal((await runHook(dir, "", env)).code, 0);
      assert.equal(got.length, 0);
    });
  });
});

test("hook: a missing event id gets a random UUID", async () => {
  await withServer({}, async (base, got) => {
    await withPlugin(base, async (dir) => {
      const input = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { name: "deploy" } });
      await runHook(dir, input, { SKILLY_TEST_USAGE_KEY: "k" });
      assert.equal(got.length, 1);
      assert.match(JSON.parse(got[0]!.body).eventId, /^[0-9a-f-]{36}$/);
    });
  });
});

test("hook: connection refused → exit 0, nothing on stdout", async () => {
  await withPlugin("http://127.0.0.1:9", async (dir) => {
    const r = await runHook(dir, postToolUse("deploy"), { SKILLY_TEST_USAGE_KEY: "k" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

test("hook: a server that hangs → exit 0 within the abort window", async () => {
  await withServer({ hang: true }, async (base) => {
    await withPlugin(base, async (dir) => {
      const r = await runHook(dir, postToolUse("deploy"), { SKILLY_TEST_USAGE_KEY: "k" });
      assert.equal(r.code, 0);
      assert.ok(r.ms < 9000, `took ${r.ms}ms`);
    });
  });
});

test("the manifest path and script path sit together under .skilly/", () => {
  assert.equal(USAGE_HOOK_SCRIPT_PATH, ".skilly/usage.mjs");
  assert.equal(USAGE_MANIFEST_PATH, ".skilly/usage.json");
});
