// Security scanning — ADVISORY findings surfaced to reviewers (§6, §9). Pluggable: orgs
// can add their own Scanner (e.g. ClamAV in the worker, Snyk, internal AV). The pure
// scanners (secret, static heuristics, content risk §37) are the bundled defaults and need no I/O.
import type { BundleEntry } from "./validate.js";
import { decodeScanText } from "./scan-text.js";
import { contentRiskScanner } from "./content-risk.js";
import { qualityScanner } from "./quality.js";
import type { QualityLevel } from "./quality-status.js";

export { decodeScanText };

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface ScanFinding {
  scanner: string;
  severity: Severity;
  rule: string;
  message: string;
  path?: string;
  /** 1-based line of the match (content-risk findings, §37.3). */
  line?: number;
  /** At most 200 chars of the matched line, hidden characters shown as ⟨U+XXXX⟩ (§37.3). */
  excerpt?: string;
  /** The content-check ruleset that produced this finding (content-risk only, §37.2). */
  ruleset?: number;
  /** The guide's level of a quality finding (quality only, §41.2) — never a scan severity. */
  level?: QualityLevel;
}

export interface Scanner {
  name: string;
  scan(files: BundleEntry[]): ScanFinding[] | Promise<ScanFinding[]>;
}


interface Pattern {
  rule: string;
  severity: Severity;
  re: RegExp;
  message: string;
}

const SECRET_PATTERNS: Pattern[] = [
  { rule: "aws-access-key", severity: "critical", re: /AKIA[0-9A-Z]{16}/, message: "possible AWS access key id" },
  { rule: "private-key", severity: "critical", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, message: "embedded private key" },
  { rule: "slack-token", severity: "high", re: /xox[abprs]-[0-9A-Za-z-]{10,}/, message: "possible Slack token" },
  { rule: "github-token", severity: "high", re: /gh[pousr]_[0-9A-Za-z]{36,}/, message: "possible GitHub token" },
  { rule: "generic-secret", severity: "medium", re: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{12,}['"]/i, message: "hardcoded secret-like assignment" },
];

const HEURISTIC_PATTERNS: Pattern[] = [
  { rule: "pipe-to-shell", severity: "high", re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/, message: "remote script piped to a shell" },
  { rule: "rm-rf-root", severity: "high", re: /\brm\s+-rf\s+(?:\/|\$HOME|~)\s*(?:\s|$)/, message: "destructive recursive remove" },
  { rule: "fork-bomb", severity: "high", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, message: "shell fork bomb" },
  { rule: "base64-pipe-shell", severity: "high", re: /base64\s+-d[^\n|]*\|\s*(?:ba)?sh\b/, message: "base64-decoded payload piped to shell" },
  { rule: "eval-download", severity: "medium", re: /eval\s*\(\s*(?:require|fetch|exec)/, message: "eval of dynamic/remote content" },
];

function scanWith(name: string, patterns: Pattern[], files: BundleEntry[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const f of files) {
    const text = decodeScanText(f.bytes);
    if (text == null) continue;
    for (const p of patterns) {
      if (p.re.test(text)) {
        findings.push({ scanner: name, severity: p.severity, rule: p.rule, message: p.message, path: f.path });
      }
    }
  }
  return findings;
}

export const secretScanner: Scanner = {
  name: "secret-scan",
  scan: (files) => scanWith("secret-scan", SECRET_PATTERNS, files),
};

export const heuristicScanner: Scanner = {
  name: "static-heuristics",
  scan: (files) => scanWith("static-heuristics", HEURISTIC_PATTERNS, files),
};

export const PURE_SCANNERS: Scanner[] = [secretScanner, heuristicScanner, contentRiskScanner, qualityScanner];

/** True when a line matches one of the §6 secret patterns — the §41.5 prompt redaction predicate. */
export function isSecretLikeLine(line: string): boolean {
  return SECRET_PATTERNS.some((p) => p.re.test(line));
}

export async function runScanners(files: BundleEntry[], scanners: Scanner[]): Promise<ScanFinding[]> {
  const results = await Promise.all(scanners.map((s) => s.scan(files)));
  return results.flat();
}

/** Highest severity in a finding set, or null if clean. */
export function maxSeverity(findings: ScanFinding[]): Severity | null {
  const order: Severity[] = ["info", "low", "medium", "high", "critical"];
  let idx = -1;
  for (const f of findings) idx = Math.max(idx, order.indexOf(f.severity));
  return idx < 0 ? null : order[idx]!;
}

/**
 * Whether publishing over this severity requires an explicit, audit-logged reviewer
 * override (§9: validation blocks; security findings are advisory, but high/critical
 * findings demand a recorded decision).
 */
export function requiresOverride(severity: Severity | null): boolean {
  return severity === "high" || severity === "critical";
}

// ── The gate verdict (§49.2) ───────────────────────────────────────────────────────────────

/** Why a proposal's scan verdict is not complete. */
export type ScanVerdictReason = "pending" | "unreachable" | "changed" | "av_missing";

export interface GateReportLike {
  /** `scanned` | `unreachable` | `source_changed` | … (scan_reports.status). */
  status: string;
  findings: ScanFinding[];
}

export type ScanVerdict = { complete: true } | { complete: false; reason: ScanVerdictReason };

/** True when the report carries a real engine result (not the unavailable marker). */
export function hasAvResult(findings: readonly ScanFinding[]): boolean {
  return findings.some((f) => f.scanner === "clamav" && f.rule !== "scanner-unavailable");
}

/**
 * Decide whether a gate report is a COMPLETE verdict the accept/direct-publish gate may act on.
 * Missing report ⇒ `pending`; a pointer pre-scan that could not fetch ⇒ `unreachable`; one whose
 * pinned commit moved ⇒ `changed`; and, when the AV engine is configured on this tier
 * (`avRequired`), a report with no ClamAV result ⇒ `av_missing`. Anything else is complete and
 * the severity-based override rule (`requiresOverride`) applies as before.
 */
export function scanVerdict(report: GateReportLike | null | undefined, opts: { avRequired: boolean }): ScanVerdict {
  if (!report) return { complete: false, reason: "pending" };
  if (report.status === "unreachable") return { complete: false, reason: "unreachable" };
  if (report.status === "source_changed") return { complete: false, reason: "changed" };
  if (report.status !== "scanned") return { complete: false, reason: "pending" };
  if (opts.avRequired && !hasAvResult(report.findings)) return { complete: false, reason: "av_missing" };
  return { complete: true };
}

/** User-facing wording for a missing verdict (review page, 409 bodies). */
export function scanVerdictText(reason: ScanVerdictReason): string {
  switch (reason) {
    case "pending": return "the security scan has not run yet";
    case "unreachable": return "the pinned source could not be fetched for scanning";
    case "changed": return "the upstream ref moved since this was submitted — ask the proposer to resubmit";
    case "av_missing": return "the anti-virus engine has not returned a result yet";
  }
}
