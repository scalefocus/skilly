// Client-side hosted-bundle uploader (§6). One entry point for both upload surfaces (the propose
// form and the proposal page's replacement upload): a bundle AT OR BELOW the configured chunk
// size goes as today's single multipart POST /api/uploads; a larger one goes through the chunked
// flow (start → sequential raw-body parts with per-part retry → complete), which bounds every
// HTTP request to the chunk size so proxy body caps can't cut the upload — and reports progress.
//
// Browser-only module (fetch/File); pure part arithmetic lives in ./chunkMath, shared with the
// server so the slicer and the enforcement can never disagree.
import { partCount, partRange } from "./chunkMath";

export interface UploadOutcome {
  ok: boolean;
  status: number;
  /** Parsed JSON body ({} when the body wasn't JSON). */
  json: Record<string, unknown>;
}

const PART_ATTEMPTS = 3;

async function outcome(r: Response): Promise<UploadOutcome> {
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, status: r.status, json };
}

/**
 * Upload a bundle, chunking when it exceeds `chunkBytes` (the /api/me `uploadChunkBytes` value).
 * `onProgress(sentBytes, totalBytes)` fires as parts land (chunked path only — a single-shot
 * upload has no browser-visible upload progress). The returned outcome carries the SAME response
 * contract for both paths (the chunked complete step answers with the /api/uploads shape).
 */
export async function uploadBundle(
  file: File,
  skillSlug: string,
  chunkBytes: number,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
): Promise<UploadOutcome> {
  if (!(chunkBytes > 0) || file.size <= chunkBytes) {
    const fd = new FormData();
    fd.append("bundle", file);
    fd.append("skillSlug", skillSlug);
    return outcome(await fetch("/api/uploads", { method: "POST", body: fd }));
  }
  return uploadChunked(file, skillSlug, onProgress);
}

async function uploadChunked(file: File, skillSlug: string, onProgress?: (sent: number, total: number) => void): Promise<UploadOutcome> {
  // Start — the server sweeps orphans, opens the session, and returns the AUTHORITATIVE chunk
  // size (an admin may have changed the setting since /api/me was read).
  const started = await outcome(
    await fetch("/api/uploads/chunked", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skillSlug, filename: file.name, totalBytes: file.size }),
    }),
  );
  if (!started.ok) return started;
  const uploadId = String(started.json.uploadId ?? "");
  const chunkBytes = Number(started.json.chunkBytes ?? 0);
  if (!uploadId || !(chunkBytes > 0)) return { ok: false, status: 500, json: { error: "chunked upload could not be started" } };

  onProgress?.(0, file.size);
  const count = partCount(file.size, chunkBytes);
  for (let i = 0; i < count; i++) {
    const { start, end } = partRange(file.size, chunkBytes, i);
    const part = file.slice(start, end);
    let last: UploadOutcome | null = null;
    for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
      try {
        last = await outcome(
          await fetch(`/api/uploads/chunked/${uploadId}/parts/${i}`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: part,
          }),
        );
        if (last.ok) break;
        // 4xx re-PUTs won't change the answer — bail; 5xx/network get the remaining attempts.
        if (last.status < 500) break;
      } catch {
        last = { ok: false, status: 0, json: { error: "network error while uploading — check your connection and try again" } };
      }
      if (attempt < PART_ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    if (!last?.ok) {
      void abortUpload(uploadId); // best-effort; the 2 h sweep collects it regardless
      return last ?? { ok: false, status: 0, json: { error: "upload failed" } };
    }
    onProgress?.(end, file.size);
  }

  // Complete — assembles server-side and runs the identical validate/scan/store pipeline.
  return outcome(await fetch(`/api/uploads/chunked/${uploadId}/complete`, { method: "POST" }));
}

/** Best-effort session abort (fire-and-forget from UIs when a staged upload is discarded). */
export async function abortUpload(uploadId: string): Promise<void> {
  try {
    await fetch(`/api/uploads/chunked/${uploadId}`, { method: "DELETE" });
  } catch {
    // the 2 h sweep collects it
  }
}
