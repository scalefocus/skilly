// Usage insights — the hook skilly ships in every marketplace plugin (SKILLY_SPEC.md §68.3).
// PINNED alongside the marketplace contract in plugin-marketplace.ts: the artefact paths, the
// hooks.json entries and the reporter script below are the ONLY place this shape may change.
//
// What Claude Code gives us (§68.2): a model-invoked skill fires `PostToolUse` with
// `tool_name = "Skill"` and a `tool_use_id`; a skill a person types as `/<plugin>:<skill>` fires
// `UserPromptExpansion` (`expansion_type = "slash_command"`, `command_name`, `prompt_id`) and
// bypasses the Skill tool. Plugin hooks fire in every session the plugin is enabled in, for every
// matching event — so the script filters by its own plugin's members. Exec form (`command` +
// `args`) spawns without a shell on every OS; `node` must resolve on PATH.

/** Contract metadata for the hook itself (the pin note lives with MARKETPLACE_CONTRACT). */
export const USAGE_HOOK_CONTRACT = {
  /** Bumped whenever the script or the hooks.json entries change shape. Sent as the User-Agent. */
  version: "1",
  /** The `tool_input` fields tried, in order, for the skill's name — undocumented by Claude Code,
   *  so the reporter matches tolerantly (§68.2). */
  skillNameFields: ["skill", "name", "skill_name"] as const,
  /** Abort the report after this many milliseconds (§68.3 step 5). */
  timeoutMs: 5000,
} as const;

/** Plugin-relative path of the reporter script. */
export const USAGE_HOOK_SCRIPT_PATH = ".skilly/usage.mjs";
/** Plugin-relative path of the member manifest the script reads. */
export const USAGE_MANIFEST_PATH = ".skilly/usage.json";
/** Where the reporter POSTs, relative to the registry base URL (§68.5). */
export const USAGE_REPORT_PATH = "/api/usage/reports";

/** The two trigger kinds a report may carry (§68.1 decision 6). */
export const USAGE_TRIGGERS = ["user", "model"] as const;
export type UsageTrigger = (typeof USAGE_TRIGGERS)[number];

/** Body of `POST /api/usage/reports` (§68.5). */
export interface UsageReport {
  skillId: string;
  semver: string;
  trigger: UsageTrigger;
  eventId: string;
}

/** Per-plugin member manifest, `.skilly/usage.json` (§68.3). */
export interface UsageManifest {
  /** Registry base URL — the one outbound destination. */
  base: string;
  /** Environment variable the reporter reads the usage key from. */
  envVar: string;
  marketplace: string;
  plugin: string;
  /** Keyed by the consumer-visible skill directory (§30.3). */
  skills: Record<string, { id: string; semver: string }>;
}

/**
 * The environment variable carrying a person's usage key: the instance's marketplace name prefix
 * (§30.2) upper-cased with `-` → `_`, plus `_USAGE_KEY` — `SKILLY_USAGE_KEY` by default,
 * `SKILLY_DEV_USAGE_KEY` on a dev instance, so one machine can hold a key per instance (§68.4).
 */
export function usageKeyEnvVar(marketplaceNamePrefix: string): string {
  const p = marketplaceNamePrefix.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${p || "SKILLY"}_USAGE_KEY`;
}

/** The `~/.claude/settings.json` fragment a sharer pastes (§68.4). Never the project's settings. */
export function buildUsageKeySnippet(envVar: string, key: string): string {
  return JSON.stringify({ env: { [envVar]: key } }, null, 2);
}

/** Build one plugin's `.skilly/usage.json`. Members sorted by directory for a stable fingerprint. */
export function buildUsageManifest(input: {
  registryBaseUrl: string;
  envVar: string;
  marketplaceName: string;
  pluginSlug: string;
  members: readonly { skillDir: string; skillId: string; semver: string }[];
}): UsageManifest {
  const skills: UsageManifest["skills"] = {};
  for (const m of [...input.members].sort((a, b) => a.skillDir.localeCompare(b.skillDir))) {
    skills[m.skillDir] = { id: m.skillId, semver: m.semver };
  }
  return { base: input.registryBaseUrl, envVar: input.envVar, marketplace: input.marketplaceName, plugin: input.pluginSlug, skills };
}

/** One hook handler entry, exec form, async, never blocking (§68.3). */
function usageHookHandler(): Record<string, unknown> {
  return {
    type: "command",
    command: "node",
    args: [`\${CLAUDE_PLUGIN_ROOT}/${USAGE_HOOK_SCRIPT_PATH}`],
    async: true,
    timeout: 10,
  };
}

/** The two event entries skilly adds to a plugin's hooks.json: model-invoked and user-typed. */
export function usageHookEvents(): Record<string, unknown[]> {
  return {
    PostToolUse: [{ matcher: "Skill", hooks: [usageHookHandler()] }],
    UserPromptExpansion: [{ hooks: [usageHookHandler()] }],
  };
}

const EVENT_KEY = /^[A-Z][A-Za-z]+$/;

/**
 * Append the usage hook to a plugin's (possibly merged, possibly absent) hooks.json — AFTER any
 * member-hoisted hooks, by array concatenation, so it can never collide with them (§30.3/§68.3).
 * Claude Code reads a plugin hooks file with its events under a top-level `hooks` key; a member
 * that wrote the events at the top level is respected (the entries are appended in that form)
 * so a file never carries both shapes.
 */
export function appendUsageHooks(existing: unknown): Record<string, unknown> {
  const events = usageHookEvents();
  const base = isPlainObject(existing) ? { ...existing } : {};
  const topLevelEvents = Object.keys(base).some((k) => EVENT_KEY.test(k) && Array.isArray(base[k]));
  const wrapped = isPlainObject(base.hooks);
  if (topLevelEvents && !wrapped) {
    for (const [ev, list] of Object.entries(events)) base[ev] = [...(Array.isArray(base[ev]) ? (base[ev] as unknown[]) : []), ...list];
    return base;
  }
  const hooks: Record<string, unknown> = wrapped ? { ...(base.hooks as Record<string, unknown>) } : {};
  for (const [ev, list] of Object.entries(events)) hooks[ev] = [...(Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : []), ...list];
  base.hooks = hooks;
  return base;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The reporter, `.skilly/usage.mjs` — byte-identical in every plugin (§68.3). Dependency-free,
 * Node ≥ 18 (global fetch). It reads the key, reads stdin, matches the skill against its own
 * manifest, POSTs one small JSON body, and exits 0 whatever happens. It never reads the
 * transcript, cwd, prompt or arguments, writes nothing to stdout or disk, and runs nothing from
 * its input.
 */
export const USAGE_HOOK_SOURCE = `// skilly usage hook — generated by skilly (SKILLY_SPEC.md §68.3). Do not edit.
// Reports which skill of this plugin Claude Code invoked, to the registry that published it —
// only when you set the usage key (see the plugin's usage.json for the variable name). Sends the
// skill id, its version, whether you or Claude invoked it, and an opaque event id. Nothing else.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const TIMEOUT_MS = ${USAGE_HOOK_CONTRACT.timeoutMs};
const SKILL_FIELDS = ${JSON.stringify([...USAGE_HOOK_CONTRACT.skillNameFields])};

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(readFileSync(join(here, "usage.json"), "utf8"));
  const key = str(process.env[manifest.envVar]);
  if (!key) return;

  const input = JSON.parse(await readStdin());
  let trigger = "";
  let name = "";
  let eventId = "";
  if (input.hook_event_name === "PostToolUse" && input.tool_name === "Skill") {
    trigger = "model";
    const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
    for (const f of SKILL_FIELDS) {
      if (str(ti[f])) { name = str(ti[f]); break; }
    }
    eventId = str(input.tool_use_id);
  } else if (input.hook_event_name === "UserPromptExpansion" && input.expansion_type === "slash_command") {
    trigger = "user";
    name = str(input.command_name);
    eventId = str(input.prompt_id);
  } else {
    return;
  }
  if (!name) return;
  name = name.replace(/^\\/+/, "");
  const colon = name.lastIndexOf(":");
  if (colon >= 0) {
    if (name.slice(0, colon) !== manifest.plugin) return;
    name = name.slice(colon + 1);
  }
  const member = manifest.skills && manifest.skills[name];
  if (!member) return;

  const body = JSON.stringify({ skillId: member.id, semver: member.semver, trigger, eventId: eventId || randomUUID() });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    await fetch(new URL("${USAGE_REPORT_PATH}", manifest.base), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + key,
        "user-agent": "skilly-usage-hook/${USAGE_HOOK_CONTRACT.version}",
      },
      body,
      signal: ctrl.signal,
    });
  } catch {
    // dropped (§68.1 decision 7)
  } finally {
    clearTimeout(timer);
  }
}

main().then(() => process.exit(0), () => process.exit(0));
`;
