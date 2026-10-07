// Skill quality rating — the client-safe half (SKILLY_SPEC.md §41). Rule labels and hints, the
// score and star maths, the AI verdict shape and its validation. No node deps and no regexes
// over skill content, so the web UI imports it via the `@skilly/shared/quality` subpath. The
// scanner itself (regexes, frontmatter parsing, the prompt builder) lives in quality.ts.

/** Bump on ANY change to a quality rule, threshold, deduction or cap (§41.2). */
export const QUALITY_RULESET_VERSION = 1;

/** The scanner name every quality finding carries. */
export const QUALITY_SCANNER = "quality";

/** The guide's levels. They are NOT scan severities: every quality finding is `severity: 'info'`. */
export type QualityLevel = "error" | "warn" | "info";

/** Points subtracted per counted finding (§41.4). */
export const QUALITY_DEDUCTIONS: Record<QualityLevel, number> = { error: 20, warn: 6, info: 2 };
/** Per rule, at most this many findings count toward the score (§41.4). */
export const QUALITY_COUNTED_PER_RULE = 3;
/** The scanner reports at most this many findings per rule per file (§41.2). */
export const QUALITY_FINDINGS_PER_RULE = 5;
/** 60 % rules + 40 % AI when an AI verdict exists (§41.4). */
export const QUALITY_RULES_WEIGHT = 0.6;
export const QUALITY_AI_WEIGHT = 0.4;
/** "2 stars or below" (§41.4): final_score < 40. */
export const QUALITY_LOW_THRESHOLD = 40;
/** AI attempts per version and the spacing between them (§41.5). */
export const QUALITY_AI_MAX_ATTEMPTS = 3;
export const QUALITY_AI_RETRY_INTERVAL = "1 hour";
/** Sweep batch sizes (§41.6). */
export const QUALITY_SWEEP_RULES_BATCH = 50;
export const QUALITY_SWEEP_AI_BATCH = 3;
/** The §40.7 feature key. */
export const QUALITY_AI_FEATURE = "skill_quality";
/** §41.5: the scoring call's token budget — the aiComplete ceiling, so a reasoning model can think and still return the verdict. */
export const QUALITY_AI_MAX_TOKENS = 8192;

export type QualityRule =
  | "FS-003" | "FS-004" | "FS-005" | "FS-006"
  | "FM-001" | "FM-005" | "FM-006" | "FM-007"
  | "FD-003" | "FD-006" | "FD-007" | "FD-008" | "FD-009" | "FD-010" | "FD-011" | "FD-012" | "FD-013" | "FD-014" | "FD-015"
  | "DS-001" | "DS-002" | "DS-003" | "DS-004" | "DS-005" | "DS-006" | "DS-007"
  | "BD-002" | "BD-003" | "BD-004" | "BD-005" | "BD-006" | "BD-007" | "BD-008" | "BD-009" | "BD-010" | "BD-011" | "BD-012"
  | "RF-001" | "RF-002" | "RF-003" | "RF-004" | "RF-005"
  | "SC-004"
  | "PT-001" | "PT-002" | "PT-003"
  | "qa-scanned";

/** The rule catalog as the UI shows it: a short label and the guide's hint (§41.2, §41.7). */
export const QUALITY_RULES: Record<QualityRule, { label: string; hint: string }> = {
  "FS-003": { label: "README in the skill folder", hint: "All documentation goes in SKILL.md or references/. Remove the README." },
  "FS-004": { label: "Unexpected top-level entry", hint: "Only SKILL.md, scripts/, references/ and assets/ belong at the root. Remove OS junk before packaging." },
  "FS-005": { label: "Stray documentation at the root", hint: "Move extra .md / .txt files to references/." },
  "FS-006": { label: "Empty optional folder", hint: "scripts/, references/ and assets/ should contain at least one file or be removed." },
  "FM-001": { label: "Byte-order mark before the frontmatter", hint: "Save SKILL.md as UTF-8 without a BOM." },
  "FM-005": { label: "YAML tag in the frontmatter", hint: "Code execution in YAML is forbidden. Remove the !tag." },
  "FM-006": { label: "Angle brackets in the frontmatter", hint: "The frontmatter is injected into the system prompt; < and > are a prompt-injection vector. Remove them." },
  "FM-007": { label: "Non-standard YAML", hint: "Anchors, aliases and merge keys are not allowed. Use plain strings, numbers, booleans, lists and objects." },
  "FD-003": { label: "Reserved word in name", hint: "A skill name must not contain 'claude' or 'anthropic'." },
  "FD-006": { label: "Description too long", hint: "Keep the description at 1024 characters or fewer." },
  "FD-007": { label: "Angle brackets in the description", hint: "Remove < and > from the description." },
  "FD-008": { label: "Invalid compatibility", hint: "compatibility must be a string of 1–500 characters." },
  "FD-009": { label: "License", hint: "license should be a non-empty SPDX identifier such as MIT or Apache-2.0." },
  "FD-010": { label: "metadata is not a mapping", hint: "metadata must be a key/value mapping." },
  "FD-011": { label: "metadata.version", hint: "Add metadata.version as x.y.z and update it on every change." },
  "FD-012": { label: "metadata.author", hint: "Add metadata.author so consumers know who maintains the skill." },
  "FD-013": { label: "MCP server not declared", hint: "The skill talks about MCP. Declare the server in metadata.mcp-server." },
  "FD-014": { label: "allowed-tools format", hint: "allowed-tools is a space-separated string of patterns such as Bash(python:*) WebFetch." },
  "FD-015": { label: "Unknown frontmatter key", hint: "Custom fields belong under metadata." },
  "DS-001": { label: "No trigger clause", hint: "Say WHEN to use the skill: 'Use this when…', 'Trigger when the user…'." },
  "DS-002": { label: "No quoted trigger phrase", hint: "Include specific tasks users might say, in quotes, e.g. \"onboard new customer\"." },
  "DS-003": { label: "Description too short", hint: "A description needs at least 10 words to say what the skill does and when to use it." },
  "DS-004": { label: "Description leads with WHEN", hint: "Lead with WHAT the skill does, then when to use it, then key capabilities." },
  "DS-005": { label: "No negative trigger", hint: "Consider adding 'Do not use for…' if the skill over-triggers." },
  "DS-006": { label: "File types not mentioned", hint: "The skill handles specific file types; name them in the description." },
  "DS-007": { label: "Generic description", hint: "Name a product, domain, quoted phrase or file type so the description is specific." },
  "BD-002": { label: "SKILL.md over 5,000 words", hint: "Keep SKILL.md under 5,000 words; move detail to references/." },
  "BD-003": { label: "H1 count", hint: "Use exactly one top-level heading: '# Your Skill Name'." },
  "BD-004": { label: "No instructions section", hint: "Add an '## Instructions' (or Workflow / Steps) section, '### Step' headings or a numbered list." },
  "BD-005": { label: "No examples", hint: "Add an '## Examples' section or 'User says:' examples." },
  "BD-006": { label: "No error handling", hint: "Add a Troubleshooting / Error handling section or describe what to do when a step fails." },
  "BD-007": { label: "No lists", hint: "Use bullet or numbered lists for steps and options." },
  "BD-008": { label: "Critical instructions buried", hint: "Move Important / Critical sections near the top of the body." },
  "BD-009": { label: "No runnable instruction", hint: "Give concrete commands, e.g. 'python scripts/validate.py --input {filename}', not 'validate the data'." },
  "BD-010": { label: "Vague phrasing", hint: "Replace 'properly', 'as needed', 'things', 'etc.' with concrete instructions." },
  "BD-011": { label: "Encouragement boilerplate", hint: "'Take your time' and similar lines belong in the user prompt, not in SKILL.md." },
  "BD-012": { label: "No expected output after a script call", hint: "After each script invocation, state what it returns or prints." },
  "RF-001": { label: "Referenced file not found", hint: "Every references/, scripts/ or assets/ path mentioned in SKILL.md must exist in the bundle." },
  "RF-002": { label: "Unreferenced bundled file", hint: "Mention the file in SKILL.md, or Claude will not know it exists." },
  "RF-003": { label: "Long SKILL.md without references/", hint: "Move detailed documentation to references/ and link to it." },
  "RF-004": { label: "Broken relative link", hint: "The Markdown link target does not exist in the bundle." },
  "RF-005": { label: "File in the wrong folder", hint: "references/ holds documents; scripts/ holds code." },
  "SC-004": { label: "Undeclared dependencies", hint: "A script imports third-party packages. Declare them in compatibility." },
  "PT-001": { label: "Machine-specific path", hint: "Absolute /Users/, /home/ or C:\\ paths will not exist on another machine." },
  "PT-002": { label: "Embedded secret", hint: "Keep credentials out of the skill; authentication belongs in the MCP server." },
  "PT-003": { label: "XML-like tag in the body", hint: "Avoid XML-like tags in the body; a bare > is fine." },
  "qa-scanned": { label: "Quality check ran", hint: "Records which quality ruleset produced this report." },
};

export const QUALITY_LEVEL_OF: Record<QualityRule, QualityLevel> = {
  "FS-003": "error", "FS-004": "warn", "FS-005": "warn", "FS-006": "info",
  "FM-001": "warn", "FM-005": "error", "FM-006": "error", "FM-007": "warn",
  "FD-003": "error", "FD-006": "error", "FD-007": "error", "FD-008": "error", "FD-009": "warn", "FD-010": "warn",
  "FD-011": "info", "FD-012": "info", "FD-013": "info", "FD-014": "warn", "FD-015": "warn",
  "DS-001": "warn", "DS-002": "info", "DS-003": "warn", "DS-004": "info", "DS-005": "info", "DS-006": "info", "DS-007": "info",
  "BD-002": "warn", "BD-003": "info", "BD-004": "warn", "BD-005": "warn", "BD-006": "warn", "BD-007": "info", "BD-008": "info",
  "BD-009": "info", "BD-010": "info", "BD-011": "info", "BD-012": "info",
  "RF-001": "error", "RF-002": "warn", "RF-003": "warn", "RF-004": "info", "RF-005": "info",
  "SC-004": "info",
  "PT-001": "warn", "PT-002": "warn", "PT-003": "info",
  "qa-scanned": "info",
};

export function qualityRuleLabel(rule: string): string {
  return (QUALITY_RULES as Record<string, { label: string }>)[rule]?.label ?? rule;
}
export function qualityRuleHint(rule: string): string {
  return (QUALITY_RULES as Record<string, { hint: string }>)[rule]?.hint ?? "";
}

/** The subset of a scan finding the score logic needs (structurally compatible with ScanFinding). */
export interface QualityFindingLike {
  scanner: string;
  severity?: string;
  rule: string;
  level?: QualityLevel;
  path?: string;
  line?: number;
  message?: string;
  ruleset?: number;
}

/** Only the quality findings of a report, markers excluded. */
export function qualityFindings<T extends QualityFindingLike>(findings: T[]): T[] {
  return findings.filter((f) => f.scanner === QUALITY_SCANNER && f.rule !== "qa-scanned");
}

/** The ruleset a report's quality marker carries, or null when the quality scanner never ran. */
export function qualityRulesetOf(findings: QualityFindingLike[]): number | null {
  const m = findings.find((f) => f.scanner === QUALITY_SCANNER && f.rule === "qa-scanned");
  return m?.ruleset ?? null;
}

const LEVEL_ORDER: QualityLevel[] = ["error", "warn", "info"];

/** The rules score (§41.4): 100 minus deductions, at most QUALITY_COUNTED_PER_RULE per rule, floored at 0. */
export function scoreQuality(findings: QualityFindingLike[]): number {
  const counted = new Map<string, number>();
  let score = 100;
  for (const f of qualityFindings(findings)) {
    const level = f.level ?? QUALITY_LEVEL_OF[f.rule as QualityRule];
    if (!level) continue;
    const n = counted.get(f.rule) ?? 0;
    if (n >= QUALITY_COUNTED_PER_RULE) continue;
    counted.set(f.rule, n + 1);
    score -= QUALITY_DEDUCTIONS[level];
  }
  return Math.max(0, score);
}

/** Half-star stars for a 0–100 score (§41.4): 90+ → 5 … 10–19 → 1, under 10 → 0.5. */
export function qualityStars(score: number): number {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  return Math.min(5, Math.max(0.5, 0.5 * (Math.floor(s / 10) + 1)));
}

/** The blended final score (§41.4). */
export function finalQualityScore(rulesScore: number, aiScore: number | null): number {
  if (aiScore === null) return rulesScore;
  return Math.max(0, Math.min(100, Math.round(QUALITY_RULES_WEIGHT * rulesScore + QUALITY_AI_WEIGHT * aiScore)));
}

export type QualityMode = "rules" | "rules+ai";
export type QualityAiStatus = "off" | "pending" | "done" | "failed";

/** Group quality findings by level, errors first, for display and the notification body. */
export function groupQualityFindings<T extends QualityFindingLike>(findings: T[]): { level: QualityLevel; findings: T[] }[] {
  const qf = qualityFindings(findings);
  return LEVEL_ORDER.map((level) => ({
    level,
    findings: qf.filter((f) => (f.level ?? QUALITY_LEVEL_OF[f.rule as QualityRule]) === level),
  })).filter((g) => g.findings.length > 0);
}

// ── The AI verdict (§41.5) ───────────────────────────────────────────────────────────────────

export type QualityDimension = "clarity" | "triggers" | "domain" | "workflow" | "composability";
export const QUALITY_DIMENSIONS: readonly QualityDimension[] = ["clarity", "triggers", "domain", "workflow", "composability"];
export const QUALITY_DIMENSION_LABELS: Record<QualityDimension, string> = {
  clarity: "Clear and actionable instructions",
  triggers: "Realistic trigger phrases",
  domain: "Correct domain knowledge",
  workflow: "Coherent workflow",
  composability: "Works alongside other skills",
};
export const QUALITY_REMARK_MAX = 300;
export const QUALITY_SUMMARY_MAX = 500;
export const QUALITY_SUGGESTION_MAX = 300;
export const QUALITY_SUGGESTIONS_MAX = 5;

export interface QualityVerdict {
  dimensions: Record<QualityDimension, { score: number; remark: string }>;
  summary: string;
  suggestions: string[];
  /** The model that answered. */
  model: string;
}

function trimTo(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * Validate the model's JSON (§41.5): all five dimensions must be integers 0–100; strings are
 * trimmed to their caps. Anything else is null — the caller records an invalid-JSON attempt.
 */
export function validateQualityVerdict(json: unknown, model: string): QualityVerdict | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const dims = {} as QualityVerdict["dimensions"];
  for (const d of QUALITY_DIMENSIONS) {
    const raw = o[d];
    let score: unknown;
    let remark: unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      score = (raw as Record<string, unknown>).score;
      remark = (raw as Record<string, unknown>).remark;
    } else {
      score = raw;
    }
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) return null;
    dims[d] = { score, remark: trimTo(remark, QUALITY_REMARK_MAX) };
  }
  const suggestionsRaw = Array.isArray(o.suggestions) ? o.suggestions : [];
  const suggestions = suggestionsRaw
    .map((s) => trimTo(s, QUALITY_SUGGESTION_MAX))
    .filter((s) => s.length > 0)
    .slice(0, QUALITY_SUGGESTIONS_MAX);
  return { dimensions: dims, summary: trimTo(o.summary, QUALITY_SUMMARY_MAX), suggestions, model: model.slice(0, 200) };
}

/** The AI score: the rounded mean of the five dimensions (§41.4). */
export function aiScoreOf(v: Pick<QualityVerdict, "dimensions">): number {
  const sum = QUALITY_DIMENSIONS.reduce((acc, d) => acc + v.dimensions[d].score, 0);
  return Math.round(sum / QUALITY_DIMENSIONS.length);
}

/** The mode line on the Quality card (§41.7). */
/** The Quality card's mode line (§41.7); `aiName` is the §40.14 display name. */
export function qualityModeLine(mode: QualityMode, aiStatus: QualityAiStatus, aiModel: string | null, aiName = "AI"): string {
  if (mode === "rules+ai") return `Rules + ${aiName} assessment${aiModel ? ` (${aiModel})` : ""}`;
  if (aiStatus === "pending") return `Rules only — ${aiName} assessment pending`;
  if (aiStatus === "failed") return `Rules only — ${aiName} assessment unavailable`;
  return "Rules only";
}

/** Format stars for display: 4.5 → "4.5", 4 → "4". */
export function formatStars(stars: number): string {
  return Number.isInteger(stars) ? String(stars) : stars.toFixed(1);
}
