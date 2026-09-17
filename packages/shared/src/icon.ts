// Skill icon resolution — pure, dependency-free (no sharp; that lives in web/worker where the
// bytes are actually normalized). SKILLY_SPEC.md §33.
import type { BundleEntry } from "./validate.js";

export const ICON_MAX_SOURCE_BYTES = 512 * 1024;
export const ICON_MIN_DIMENSION = 64;
export const ICON_MAX_DIMENSION = 4096;
export const ICON_OUTPUT_SIZE = 256;

export type IconImageFormat = "png" | "jpeg" | "webp";

/** Detect PNG/JPEG/WebP by magic bytes — never by extension. SVG and GIF are refused (§33.3). */
export function detectImageFormat(bytes: Uint8Array): IconImageFormat | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "webp";
  return null;
}

/**
 * True when `s` is exactly one emoji grapheme cluster (with optional variation selector / ZWJ
 * sequence) — not a run of letters, not several emoji concatenated. Deliberately conservative:
 * rejects anything that doesn't look like a single pictographic cluster.
 */
export function isSingleEmoji(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  const segments = [...trimmed];
  // Reject if plain-ASCII (never an emoji) or clearly multiple visual characters wide.
  if (/^[\x00-\x7f]+$/.test(trimmed)) return false;
  // A single grapheme cluster via Intl.Segmenter when available; otherwise fall back to a
  // regex covering the common emoji ranges + ZWJ/variation-selector joins.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Segmenter = (Intl as any).Segmenter;
    if (Segmenter) {
      const seg = new Segmenter("en", { granularity: "grapheme" });
      const parts = [...seg.segment(trimmed)];
      return parts.length === 1;
    }
  } catch {
    // fall through to the regex heuristic
  }
  const emojiClusterRe = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\u200d(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}))*[\ufe0e\ufe0f]?$/u;
  return emojiClusterRe.test(trimmed) || segments.length <= 2;
}

export type BundleIconSource = "frontmatter" | "bundle";

export interface BundleIconResult {
  /** The resolved image file, when the icon is a path (frontmatter path or root icon.*). */
  entry?: BundleEntry;
  /** The resolved emoji, when the frontmatter `icon:` value is itself a single emoji. */
  emoji?: string;
  source: BundleIconSource;
  warnings: string[];
}

const ROOT_ICON_CANDIDATES = ["icon.png", "icon.jpg", "icon.jpeg", "icon.webp"];

/**
 * Resolve a bundle-borne icon per §33.2 precedence: SKILL.md frontmatter `icon:` (a relative
 * bundle path, or a single emoji) beats a root-level `icon.png`/`.jpg`/`.jpeg`/`.webp`. Never
 * throws — an unresolvable/oversize/malformed icon is a warning, and resolution returns null
 * (falls through to the proposer's upload/emoji/default, §33.2). Never follows a URL.
 */
export function resolveBundleIcon(files: BundleEntry[], frontmatterIcon: string | undefined): BundleIconResult | null {
  const warnings: string[] = [];
  const raw = frontmatterIcon?.trim();
  if (raw) {
    if (isSingleEmoji(raw)) {
      return { emoji: raw, source: "frontmatter", warnings };
    }
    // Treat as a relative bundle path — no URLs, nothing is fetched (§6/§33.3).
    if (/^[a-z]+:\/\//i.test(raw) || raw.startsWith("//")) {
      warnings.push(`icon: '${raw}' looks like a URL — icons must be a file inside the bundle or a single emoji; ignoring`);
    } else {
      const normalized = raw.replace(/^\.?\//, "");
      const entry = files.find((f) => f.path === normalized);
      if (!entry) {
        warnings.push(`icon: '${raw}' was not found in the bundle; falling back`);
      } else {
        const format = detectImageFormat(entry.bytes);
        if (!format) {
          warnings.push(`icon: '${raw}' is not a recognized PNG/JPEG/WebP image; falling back`);
        } else if (entry.bytes.byteLength > ICON_MAX_SOURCE_BYTES) {
          warnings.push(`icon: '${raw}' is larger than 512 KB; falling back`);
        } else {
          return { entry, source: "frontmatter", warnings };
        }
      }
    }
  }
  for (const name of ROOT_ICON_CANDIDATES) {
    const entry = files.find((f) => f.path === name);
    if (!entry) continue;
    const format = detectImageFormat(entry.bytes);
    if (!format) {
      warnings.push(`${name} is not a recognized PNG/JPEG/WebP image; ignoring`);
      continue;
    }
    if (entry.bytes.byteLength > ICON_MAX_SOURCE_BYTES) {
      warnings.push(`${name} is larger than 512 KB; ignoring`);
      continue;
    }
    return { entry, source: "bundle", warnings };
  }
  return warnings.length ? { warnings, source: "bundle" } : null;
}
