// Coding-agent vocabulary for a skill's `tool_harness` (SKILLY_SPEC.md §3, §8). CLOSED list: the
// agents the consumer tool (`vercel-labs/skills` — `npx skills add --agent <slug>`) supports. A
// skill's chosen agent drives the `--agent` flag in its generated install command (§9). `generic`
// is the default and emits NO flag. Pure module (no node deps) — shipped to the client via the
// "./agents" subpath export. The slug is stored; the label is what we display.

export interface Agent {
  /** the `--agent` value passed to the consumer tool (also the stored tool_harness slug) */
  slug: string;
  /** human-facing name shown in the picker / chips */
  label: string;
}

/** The default tool/harness: a tool-agnostic skill. Emits NO `--agent` in the install command. */
export const GENERIC_AGENT = "generic";

/**
 * Supported coding agents (slug = the `--agent` value). Order here is irrelevant — the picker
 * presents `Generic` first, then these sorted by label (TOOL_OPTIONS below).
 */
export const AGENTS: readonly Agent[] = [
  { slug: "aider-desk", label: "AiderDesk" },
  { slug: "amp", label: "Amp" },
  { slug: "replit", label: "Replit" },
  { slug: "universal", label: "Universal" },
  { slug: "antigravity", label: "Antigravity" },
  { slug: "antigravity-cli", label: "Antigravity CLI" },
  { slug: "astrbot", label: "AstrBot" },
  { slug: "autohand-code", label: "Autohand Code CLI" },
  { slug: "augment", label: "Augment" },
  { slug: "bob", label: "IBM Bob" },
  { slug: "claude-code", label: "Claude Code" },
  { slug: "openclaw", label: "OpenClaw" },
  { slug: "cline", label: "Cline" },
  { slug: "dexto", label: "Dexto" },
  { slug: "kimi-code-cli", label: "Kimi Code CLI" },
  { slug: "loaf", label: "Loaf" },
  { slug: "warp", label: "Warp" },
  { slug: "zed", label: "Zed" },
  { slug: "codearts-agent", label: "CodeArts Agent" },
  { slug: "codebuddy", label: "CodeBuddy" },
  { slug: "codemaker", label: "Codemaker" },
  { slug: "codestudio", label: "Code Studio" },
  { slug: "codex", label: "Codex" },
  { slug: "command-code", label: "Command Code" },
  { slug: "continue", label: "Continue" },
  { slug: "cortex", label: "Cortex Code" },
  { slug: "crush", label: "Crush" },
  { slug: "cursor", label: "Cursor" },
  { slug: "deepagents", label: "Deep Agents" },
  { slug: "devin", label: "Devin for Terminal" },
  { slug: "droid", label: "Droid" },
  { slug: "firebender", label: "Firebender" },
  { slug: "forgecode", label: "ForgeCode" },
  { slug: "gemini-cli", label: "Gemini CLI" },
  { slug: "github-copilot", label: "GitHub Copilot" },
  { slug: "goose", label: "Goose" },
  { slug: "hermes-agent", label: "Hermes Agent" },
  { slug: "inference-sh", label: "inference.sh" },
  { slug: "jazz", label: "Jazz" },
  { slug: "junie", label: "Junie" },
  { slug: "iflow-cli", label: "iFlow CLI" },
  { slug: "kilo", label: "Kilo Code" },
  { slug: "kiro-cli", label: "Kiro CLI" },
  { slug: "kode", label: "Kode" },
  { slug: "lingma", label: "Lingma" },
  { slug: "mcpjam", label: "MCPJam" },
  { slug: "mistral-vibe", label: "Mistral Vibe" },
  { slug: "moxby", label: "Moxby" },
  { slug: "mux", label: "Mux" },
  { slug: "opencode", label: "OpenCode" },
  { slug: "openhands", label: "OpenHands" },
  { slug: "ona", label: "Ona" },
  { slug: "pi", label: "Pi" },
  { slug: "qoder", label: "Qoder" },
  { slug: "qoder-cn", label: "Qoder CN" },
  { slug: "qwen-code", label: "Qwen Code" },
  { slug: "reasonix", label: "Reasonix" },
  { slug: "rovodev", label: "Rovo Dev" },
  { slug: "roo", label: "Roo Code" },
  { slug: "tabnine-cli", label: "Tabnine CLI" },
  { slug: "terramind", label: "Terramind" },
  { slug: "tinycloud", label: "Tinycloud" },
  { slug: "trae", label: "Trae" },
  { slug: "trae-cn", label: "Trae CN" },
  { slug: "windsurf", label: "Windsurf" },
  { slug: "zencoder", label: "Zencoder" },
  { slug: "zenflow", label: "Zenflow" },
  { slug: "neovate", label: "Neovate" },
  { slug: "pochi", label: "Pochi" },
  { slug: "promptscript", label: "PromptScript" },
  { slug: "adal", label: "AdaL" },
] as const;

const BY_SLUG = new Map(AGENTS.map((a) => [a.slug, a.label]));

/** True when `slug` is a recognized agent that should emit `--agent` (i.e. not generic/unknown). */
export function isAgentSlug(slug: string | null | undefined): boolean {
  return !!slug && slug !== GENERIC_AGENT && BY_SLUG.has(slug);
}

/** Display label for a stored tool_harness slug. `generic`/empty → "Generic"; an unrecognized
 *  legacy slug falls back to the raw slug. */
export function agentLabel(slug: string | null | undefined): string {
  if (!slug || slug === GENERIC_AGENT) return "Generic";
  return BY_SLUG.get(slug) ?? slug;
}

/** Closed-vocabulary membership for validation: `generic` ∪ known agent slugs. */
export function isAllowedToolHarness(slug: string): boolean {
  return slug === GENERIC_AGENT || BY_SLUG.has(slug);
}

/** Picker options: `Generic` first (the default), then agents alphabetical by label. */
export const TOOL_OPTIONS: readonly Agent[] = [
  { slug: GENERIC_AGENT, label: "Generic" },
  ...[...AGENTS].sort((a, b) => a.label.localeCompare(b.label)),
];
