// Bundle validation — BLOCKING checks run at ingest (hosted upload / pointer mirror).
// A failed validation rejects the bundle. SKILLY_SPEC.md §6, §9 (validation blocks;
// security scans are advisory). Pure + dependency-free so it runs anywhere.

export interface BundleEntry {
  path: string; // repo-relative, forward slashes
  bytes: Uint8Array;
}

export interface ValidateOptions {
  skillSlug: string;
  /** max total bundle size; default ~10 MB (§9) */
  maxBytes?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Minimum decompression headroom above the configured upload limit, so a within-limit bundle
 *  whose UNCOMPRESSED content is a little larger isn't pre-rejected (and small limits keep room). */
export const BUNDLE_CONTENT_FLOOR_BYTES = 20 * 1024 * 1024;

/**
 * The effective cumulative-content cap for extracting/validating a bundle, given the platform's
 * configured `max_bundle_bytes`. Used identically at upload (web), download (web), publish + mirror
 * (worker) so a bundle accepted at upload is never rejected by a stricter cap later. §6.
 */
export function bundleContentCap(configuredMaxBytes: number): number {
  return Math.max(configuredMaxBytes, BUNDLE_CONTENT_FLOOR_BYTES);
}

// Executables/binaries blocked by default (§9). Extension-based allowlist-by-exclusion.
const DISALLOWED_EXT = new Set([
  "exe", "dll", "so", "dylib", "bin", "o", "a", "class", "jar", "msi", "apk", "dmg", "deb", "rpm",
]);

/** Extract `name` and `description` from a SKILL.md YAML frontmatter block (minimal parse). */
export function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    // Manual split on the first ':' (rather than a regex with adjacent \s* quantifiers around
    // it) avoids a polynomial-time backtrack blowup on attacker-controlled SKILL.md content.
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    out[key] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function validateBundle(files: BundleEntry[], opts: ValidateOptions): ValidationResult {
  const errors: string[] = [];
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (!skillMd) {
    errors.push("bundle must contain a top-level SKILL.md");
  } else {
    const fm = parseFrontmatter(new TextDecoder().decode(skillMd.bytes));
    if (!fm.name) errors.push("SKILL.md frontmatter missing required 'name'");
    if (!fm.description) errors.push("SKILL.md frontmatter missing required 'description'");
    if (fm.name && fm.name !== opts.skillSlug) {
      errors.push(`SKILL.md name '${fm.name}' must match the skill slug '${opts.skillSlug}'`);
    }
  }

  let total = 0;
  for (const f of files) {
    total += f.bytes.byteLength;
    const ext = f.path.includes(".") ? f.path.split(".").pop()!.toLowerCase() : "";
    if (DISALLOWED_EXT.has(ext)) errors.push(`disallowed file type: ${f.path}`);
    if (f.path.includes("..")) errors.push(`unsafe path: ${f.path}`);
  }
  if (total > maxBytes) errors.push(`bundle exceeds size limit (${total} > ${maxBytes} bytes)`);

  return { ok: errors.length === 0, errors };
}
