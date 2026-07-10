// Archive format detection + path normalization for uploaded skill bundles.
// Pure + dependency-free; the actual extraction (tar/zip libs) lives in web/worker.
// Accepted: .tar.gz/.tgz (gzip), .zip, and .skill (sniffed — gzip or zip). SKILLY_SPEC.md §6.
import type { BundleEntry } from "./validate.js";

export type ArchiveKind = "gzip" | "zip";

/** Detect archive type by magic bytes (ignore the file extension). */
export function detectArchive(bytes: Uint8Array): ArchiveKind | null {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  // PK\x03\x04 (normal), PK\x05\x06 (empty), PK\x07\x08 (spanned)
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  ) {
    return "zip";
  }
  return null;
}

/**
 * If every entry lives under a single common top-level directory, strip it. Makes uploads
 * forgiving of archives created with a wrapping folder (e.g. `pdf-tools/SKILL.md`).
 */
export function stripCommonPrefix(files: BundleEntry[]): BundleEntry[] {
  if (files.length === 0) return files;
  const firstSegments = new Set(files.map((f) => f.path.split("/")[0]));
  if (firstSegments.size !== 1) return files;
  const prefix = [...firstSegments][0]!;
  // Only strip when the shared segment is a *directory* wrapping everything (each path has
  // content after `prefix/`), not when a file named `prefix` sits at the root.
  if (!files.every((f) => f.path.startsWith(prefix + "/"))) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(prefix.length + 1) }));
}

/** Junk entries archives commonly carry that should be dropped. */
export function isJunkEntry(path: string): boolean {
  return path.startsWith("__MACOSX/") || path.endsWith("/.DS_Store") || path === ".DS_Store" || path.includes("..");
}
