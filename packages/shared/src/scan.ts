// Security scanning — ADVISORY findings surfaced to reviewers (§6, §9). Pluggable: orgs
// can add their own Scanner (e.g. ClamAV in the worker, Snyk, internal AV). These two
// pure scanners (secret + static heuristics) are the bundled defaults and need no I/O.
import type { BundleEntry } from "./validate.js";

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface ScanFinding {
  scanner: string;
  severity: Severity;
  rule: string;
  message: string;
  path?: string;
}

export interface Scanner {
  name: string;
  scan(files: BundleEntry[]): ScanFinding[] | Promise<ScanFinding[]>;
}

// Skip files that look binary (lots of NUL bytes) — scanners are text-oriented.
function asText(bytes: Uint8Array): string | null {
  const sample = bytes.subarray(0, 8000);
  for (const b of sample) if (b === 0) return null;
  return new TextDecoder().decode(bytes);
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
    const text = asText(f.bytes);
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

export const PURE_SCANNERS: Scanner[] = [secretScanner, heuristicScanner];

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
