// Download-extension resolution for the detail-page download (SKILLY_SPEC.md §6/§10).
// Pure + dependency-free: no node, no byte sniffing here — callers that hold the bytes layer
// magic-byte detection on top of this. One source of truth so the API's Content-Disposition
// filename and the UI's download-button label always agree.

const KNOWN_EXTS = ["tar.gz", "tgz", "tar", "gz", "zip", "skill"] as const;

/** Normalized download extension from an original upload filename, or null when absent/unknown. */
export function downloadExtFromFilename(filename?: string | null): string | null {
  if (!filename) return null;
  const n = filename.trim().toLowerCase();
  if (n.endsWith(".tar.gz")) return "tar.gz"; // compound extension — check before the last-dot split
  const dot = n.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = n.slice(dot + 1);
  return (KNOWN_EXTS as readonly string[]).includes(ext) ? ext : null;
}

/** Best-effort extension when no original filename was recorded (pre-0040 versions / Pointer
 *  mirrors): Pointer mirrors are gzip tarballs; otherwise follow the skill's harness. */
export function fallbackDownloadExt(opts: { isPointer?: boolean; toolHarness?: string | null }): string {
  if (opts.isPointer) return "tar.gz";
  return opts.toolHarness === "claude-code" ? "skill" : "zip";
}

/** Resolve the download extension WITHOUT the bytes (used for UI labels). Prefers the recorded
 *  original filename, then the harness/type fallback. */
export function resolveDownloadExt(opts: { artifactFilename?: string | null; isPointer?: boolean; toolHarness?: string | null }): string {
  return downloadExtFromFilename(opts.artifactFilename) ?? fallbackDownloadExt(opts);
}

/** MIME type for a resolved download extension. `.skill` (zip- or gzip-backed) stays generic. */
export function downloadContentType(ext: string): string {
  switch (ext) {
    case "zip":
      return "application/zip";
    case "tar.gz":
    case "tgz":
    case "gz":
      return "application/gzip";
    case "tar":
      return "application/x-tar";
    default:
      return "application/octet-stream";
  }
}
