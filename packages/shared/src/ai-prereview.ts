// AI pre-review of proposals (SKILLY_SPEC.md §46): the client-safe vocabulary — categories,
// severities, the result/view shapes and the pure display rules (highest severity, the mismatch
// warning, disposition merging). No node, no I/O: exported via "@skilly/shared/ai-prereview" for
// client components, and from the server barrel. The prompt, validation and fingerprints live in
// ai-prereview-run.ts; persistence in ai-prereview-db.ts.

/** The five finding categories, in display order (§46.6). */
export const PREREVIEW_CATEGORIES = ["prompt_injection", "tool_permissions", "unsafe_shell", "secret_exposure", "spec_compliance"] as const;
export type PrereviewCategory = (typeof PREREVIEW_CATEGORIES)[number];

export const PREREVIEW_CATEGORY_INFO: Record<PrereviewCategory, { label: string; help: string }> = {
  prompt_injection: {
    label: "Prompt injection",
    help: "Text that tries to override the agent's instructions, hide actions from the user, or change behaviour under hidden conditions.",
  },
  tool_permissions: {
    label: "Tool permissions",
    help: "allowed-tools broader than the instructions need, undeclared tool or network use, or instructions that escalate the agent's permissions.",
  },
  unsafe_shell: {
    label: "Unsafe shell",
    help: "Commands that destroy data without confirmation, download and execute, obfuscate, persist, disable security controls, or reach beyond the skill's purpose.",
  },
  secret_exposure: {
    label: "Secret exposure",
    help: "Credentials present in the files, or instructions that read, print, log or transmit them.",
  },
  spec_compliance: {
    label: "Description mismatch",
    help: "The skill does something its description does not mention, claims something its body never does, or contradicts itself.",
  },
};

/** Finding severities, highest first (§46.6). `info` is never used by the pre-review. */
export const PREREVIEW_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type PrereviewSeverity = (typeof PREREVIEW_SEVERITIES)[number];

export function isPrereviewCategory(v: unknown): v is PrereviewCategory {
  return typeof v === "string" && (PREREVIEW_CATEGORIES as readonly string[]).includes(v);
}
export function isPrereviewSeverity(v: unknown): v is PrereviewSeverity {
  return typeof v === "string" && (PREREVIEW_SEVERITIES as readonly string[]).includes(v);
}

/** Rank for sorting: critical first. */
export function prereviewSeverityRank(s: PrereviewSeverity): number {
  return PREREVIEW_SEVERITIES.indexOf(s);
}

export interface PrereviewFinding {
  /** Stable identity across runs and revisions: category | path | collapsed excerpt (§46.6). */
  fingerprint: string;
  category: PrereviewCategory;
  severity: PrereviewSeverity;
  path: string;
  /** Computed by skilly from where the excerpt is found — never the model's. */
  line: number | null;
  excerpt: string;
  rationale: string;
  suggestion: string;
}

/** The validated, stored result of one run. */
export interface PrereviewResult {
  summary: string;
  findings: PrereviewFinding[];
  /** How many of the model's findings were dropped as unverifiable. */
  discarded: number;
}

export type PrereviewCoverageStatus = "reviewed" | "truncated" | "skipped" | "out_of_scope";
export interface PrereviewCoverageEntry {
  path: string;
  status: PrereviewCoverageStatus;
}

export type PrereviewVerdict = "agree" | "dismiss";
export const PREREVIEW_REASON_MAX = 500;

export interface PrereviewDisposition {
  verdict: PrereviewVerdict;
  reason: string | null;
  /** Display name of the decider (null for a former user). */
  by: string | null;
  at: string;
}

export type PrereviewRunStatus = "pending" | "done" | "failed";
/**
 * The section's state (§46.8): a run's status, or why there is none — the switch is off, the
 * integration is unavailable, the per-proposal cap skipped it, or (a version) it was never reviewed.
 */
export type PrereviewStatus = PrereviewRunStatus | "off" | "unavailable" | "skipped" | "none";

export interface PrereviewFindingView extends PrereviewFinding {
  disposition: PrereviewDisposition | null;
}

export interface PrereviewRunView {
  status: PrereviewRunStatus;
  trigger: string;
  model: string | null;
  createdAt: string;
  completedAt: string | null;
  lastError: string | null;
  summary: string | null;
  findings: PrereviewFindingView[];
  discarded: number;
  coverage: PrereviewCoverageEntry[];
  maxSeverity: PrereviewSeverity | null;
}

/** The payload a proposal or the owner card carries (§46.11). */
export interface PrereviewView {
  status: PrereviewStatus;
  /** The current run, when there is one. */
  run: PrereviewRunView | null;
  /** While the current revision's run is pending: the last finished result of an earlier revision. */
  previous: (PrereviewRunView & { revision: number }) | null;
  /** The §46.8 mismatch warning applies. */
  mismatch: boolean;
  canRerun: boolean;
  canDisposition: boolean;
}

/** Highest severity among findings, or null when there are none. */
export function maxPrereviewSeverity(findings: readonly { severity: PrereviewSeverity }[]): PrereviewSeverity | null {
  let best: PrereviewSeverity | null = null;
  for (const f of findings) if (best === null || prereviewSeverityRank(f.severity) < prereviewSeverityRank(best)) best = f.severity;
  return best;
}

/** High and critical are the "flagged" severities (§46.10). */
export function isFlaggingSeverity(s: PrereviewSeverity | null | undefined): boolean {
  return s === "high" || s === "critical";
}

/** The §37 rules whose presence makes "no prompt injection reported" suspicious (§46.8). */
export const PREREVIEW_MISMATCH_RULES = ["cr-instruction-override", "cr-concealment", "cr-hidden-markup"] as const;

/**
 * §46.8 mismatch: the content check found override/concealment wording in a file the run
 * reviewed, yet the run reported no prompt_injection finding. Only meaningful for a finished run.
 */
export function prereviewMismatch(
  run: { status: PrereviewRunStatus; findings: readonly { category: PrereviewCategory }[]; coverage: readonly PrereviewCoverageEntry[] } | null,
  scanFindings: readonly { scanner?: string; rule?: string; path?: string }[],
): boolean {
  if (!run || run.status !== "done") return false;
  if (run.findings.some((f) => f.category === "prompt_injection")) return false;
  const reviewed = new Set(run.coverage.filter((c) => c.status === "reviewed" || c.status === "truncated").map((c) => c.path));
  return scanFindings.some(
    (f) => f.scanner === "content-risk" && (PREREVIEW_MISMATCH_RULES as readonly string[]).includes(f.rule ?? "") && reviewed.has(f.path ?? "SKILL.md"),
  );
}

export interface DispositionRow {
  fingerprint: string;
  verdict: PrereviewVerdict;
  reason: string | null;
  by: string | null;
  at: string;
}

/** Latest disposition per fingerprint (rows are append-only; the newest wins, §46.7). */
export function latestDispositions(rows: readonly DispositionRow[]): Map<string, PrereviewDisposition> {
  const out = new Map<string, PrereviewDisposition>();
  for (const r of [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    out.set(r.fingerprint, { verdict: r.verdict, reason: r.reason, by: r.by, at: r.at });
  }
  return out;
}

/** The always-shown caveat (§46.8). */
export const PREREVIEW_CAVEAT =
  "AI review can be influenced by the content it reads. This is advice for the reviewer, not a check the skill has passed.";
