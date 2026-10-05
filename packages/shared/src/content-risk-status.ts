// Content-risk status, labels and acknowledgement matching (SKILLY_SPEC.md §37.6, §37.7).
// Client-safe: no node deps and no regexes, so the web UI imports it via the
// `@skilly/shared/content-risk-status` subpath. The scanner itself lives in content-risk.ts.

/** Bump on ANY change to a content-risk pattern, exemption or severity (§37.2). */
export const CONTENT_RULESET_VERSION = 1;

/** The scanner name every content-risk finding carries. */
export const CONTENT_RISK_SCANNER = "content-risk";

export type ContentRiskRule =
  | "cr-hidden-unicode"
  | "cr-hidden-markup"
  | "cr-homoglyph"
  | "cr-credential-exfil"
  | "cr-credential-access"
  | "cr-instruction-override"
  | "cr-concealment"
  | "cr-prompt-reference"
  | "cr-scanned"
  | "cr-truncated";

/** One short label and a one-sentence explanation per rule, shown on the review page (§37.8). */
export const CONTENT_RISK_RULES: Record<ContentRiskRule, { label: string; help: string }> = {
  "cr-hidden-unicode": {
    label: "Hidden characters",
    help: "Invisible or direction-changing Unicode characters can hide text from a reviewer while an agent still reads it.",
  },
  "cr-hidden-markup": {
    label: "Hidden instructions",
    help: "An HTML comment is invisible on the rendered page, but an agent reads it. This one contains instruction-like text.",
  },
  "cr-homoglyph": {
    label: "Look-alike letters",
    help: "A word mixes Latin letters with Cyrillic, Greek or Armenian look-alikes, which can disguise a command or a name.",
  },
  "cr-credential-exfil": {
    label: "Credential exfiltration",
    help: "The file reads a credential store and also sends data to a remote destination.",
  },
  "cr-credential-access": {
    label: "Credential access",
    help: "The file refers to a credential store or dumps environment variables.",
  },
  "cr-instruction-override": {
    label: "Instruction override",
    help: "Phrasing that tells an agent to drop or replace the instructions it was given.",
  },
  "cr-concealment": {
    label: "Concealment from the user",
    help: "Phrasing that tells an agent to hide what it does from the person using it.",
  },
  "cr-prompt-reference": {
    label: "Prompt reference",
    help: "Mentions system prompts, developer messages or jailbreaks. Often harmless, worth a look.",
  },
  "cr-scanned": {
    label: "Content check ran",
    help: "Records which content-check ruleset produced this report.",
  },
  "cr-truncated": {
    label: "File partly checked",
    help: "The file was longer than the content check's size limit, so only its beginning was checked.",
  },
};

export function contentRiskRuleLabel(rule: string): string {
  return (CONTENT_RISK_RULES as Record<string, { label: string }>)[rule]?.label ?? rule;
}

/** The subset of a scan finding the status logic needs (structurally compatible with ScanFinding). */
export interface ContentRiskFindingLike {
  scanner: string;
  severity: string;
  rule: string;
  path?: string;
  ruleset?: number;
}

export type ContentRiskStatus = "pending" | "passed" | "noted" | "flagged";

/** The consumer-facing label for each status (§37.7). */
export const CONTENT_RISK_STATUS_LABEL: Record<ContentRiskStatus, string> = {
  pending: "Content check pending",
  passed: "Content check passed",
  noted: "Content check: findings noted",
  flagged: "Content check: flagged, awaiting review",
};

/** One sentence per status, for the hover / tap explanation on the skill page chip. */
export const CONTENT_RISK_STATUS_HINT: Record<ContentRiskStatus, string> = {
  pending: "This version hasn't been through the current content check yet.",
  passed: "The content check found nothing that needs attention in this version.",
  noted: "The content check found things a reviewer has looked at and accepted.",
  flagged: "The content check found something no reviewer has looked at yet.",
};

const GATE = new Set(["high", "critical"]);
const NOTABLE = new Set(["medium", "high", "critical"]);

/** Increment a metrics counter once per recorded content-risk finding, by rule and severity (§37.13). */
export function countContentRiskFindings(
  counter: { inc(labels?: Record<string, string>): void },
  findings: readonly ContentRiskFindingLike[],
): void {
  for (const f of findings) {
    if (f.scanner === CONTENT_RISK_SCANNER && f.rule !== "cr-scanned") counter.inc({ rule: f.rule, severity: f.severity });
  }
}

/** Only the content-risk findings of a report (the review page shows them in their own section). */
export function contentRiskFindings<T extends ContentRiskFindingLike>(findings: readonly T[] | null | undefined): T[] {
  return (findings ?? []).filter((f) => f.scanner === CONTENT_RISK_SCANNER);
}

/** The ruleset a report's content check ran at, or null if it never ran. */
export function contentRulesetOf(findings: readonly ContentRiskFindingLike[] | null | undefined): number | null {
  const marker = (findings ?? []).find((f) => f.scanner === CONTENT_RISK_SCANNER && f.rule === "cr-scanned");
  return typeof marker?.ruleset === "number" ? marker.ruleset : null;
}

/** Stable key for an acknowledged (rule, path) pair (§37.6). */
export function contentRiskPairKey(rule: string, path: string | null | undefined): string {
  return `${rule}\u0000${path ?? ""}`;
}

/** The distinct gate-tripping (rule, path) pairs among a report's content-risk findings. */
export function gateTrippingPairs(findings: readonly ContentRiskFindingLike[] | null | undefined): { rule: string; path: string | null }[] {
  const seen = new Map<string, { rule: string; path: string | null }>();
  for (const f of contentRiskFindings(findings)) {
    if (!GATE.has(f.severity)) continue;
    const key = contentRiskPairKey(f.rule, f.path);
    if (!seen.has(key)) seen.set(key, { rule: f.rule, path: f.path ?? null });
  }
  return [...seen.values()];
}

/** True when a report's content-risk findings alone trip the override gate (§37.4). */
export function contentRiskTripsGate(findings: readonly ContentRiskFindingLike[] | null | undefined): boolean {
  return gateTrippingPairs(findings).length > 0;
}

/**
 * Derive a version's status from its artifact's latest report and the (rule, path) pairs
 * acknowledged for that version (§37.6, §37.7). Never stored.
 */
export function deriveContentRiskStatus(
  findings: readonly ContentRiskFindingLike[] | null | undefined,
  acknowledgedPairKeys: ReadonlySet<string>,
  currentRuleset: number = CONTENT_RULESET_VERSION,
): ContentRiskStatus {
  if (contentRulesetOf(findings) !== currentRuleset) return "pending";
  const content = contentRiskFindings(findings);
  if (!content.some((f) => NOTABLE.has(f.severity))) return "passed";
  const unacked = gateTrippingPairs(content).some((p) => !acknowledgedPairKeys.has(contentRiskPairKey(p.rule, p.path)));
  return unacked ? "flagged" : "noted";
}
