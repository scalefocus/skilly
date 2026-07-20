// Friendly error mapping for bundle uploads (SKILLY_SPEC.md §6 "Oversize rejection UX").
// Client-safe (pure, no server deps): used by the propose page and the proposal-detail
// replacement upload, and by /api/uploads for its own cap-quoting 413 message.

/** Human-readable size ("100 KB" / "50 MB" / "1 GB"). */
export function fmtSize(bytes: number): string {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  if (bytes >= GB) return `${Math.round(bytes / GB)} GB`;
  return bytes >= MB ? `${Math.round(bytes / MB)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Message for a failed bundle upload. A server-provided `error` string always wins (the app's
 * own 413 quotes the configured cap). A 413 WITHOUT one means a reverse proxy in front of skilly
 * rejected the body before the app saw it — its limit may be lower than the configured cap, so
 * quote the attempted file's size rather than a number we can't stand behind (§6). Never a raw
 * "Upload failed (HTTP 413).".
 */
export function bundleUploadError(status: number, serverError: unknown, fileBytes: number): string {
  if (typeof serverError === "string" && serverError) return serverError;
  if (status === 413) {
    return `This bundle (${fmtSize(fileBytes)}) is too large for the server to accept. Reduce its size and try again — or contact an administrator.`;
  }
  return `Upload failed (HTTP ${status}).`;
}
