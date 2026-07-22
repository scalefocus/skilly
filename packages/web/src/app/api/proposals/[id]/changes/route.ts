// Reviewer file-change view (SKILLY_SPEC.md §8). Gated EXACTLY like the bundle file browser
// (reviewer of the namespace or the submitter — 404 otherwise, so restricted proposals never leak).
//
//   GET /api/proposals/:id/changes          -> { available, baselineSemver, summary, files } — the
//                                              added/modified/removed/unchanged classification vs the
//                                              target skill's latest stable version.
//   GET /api/proposals/:id/changes?path=X    -> that file's unified line diff (text), or a
//                                              binary/too-large marker.
//
// New-version proposals only carry a meaningful baseline; a new-skill proposal has none, so every
// file classifies as "added". A fresh pointer proposal's proposed bytes are fetched on demand.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../lib/access";
import { pool } from "../../../../../lib/db";
import { getProposalDetail } from "../../../../../lib/proposals";
import { enforceRateLimit } from "../../../../../lib/ratelimit";
import { getChangeSummary, getFileDiff } from "../../../../../lib/versionDiff";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("download", access.userId, 120);
  if (limited) return limited;

  const detail = await getProposalDetail(pool, (await ctx.params).id, access, access.userId);
  if (!detail) return Response.json({ error: "not found" }, { status: 404 });

  const latest = detail.revisions.at(-1);
  if (!latest) return Response.json({ available: false, kind: "none" });
  // Cache key pins the exact revision — a proposer revise / reviewer edit invalidates the view.
  const cacheKey = `${detail.id}:${latest.revisionNo}`;
  const url = new URL(req.url);
  const path = url.searchParams.get("path");

  try {
    if (path) {
      const result = await getFileDiff(cacheKey, detail.targetSkillId, latest.payload, path);
      if (!result) return Response.json({ error: "file not part of this change set" }, { status: 404 });
      return Response.json({ path, ...result });
    }
    const summary = await getChangeSummary(cacheKey, detail.targetSkillId, latest.payload);
    if (summary.unavailable) {
      return Response.json({ available: false, kind: latest.payload.pointer ? "pointer" : "unavailable", reason: summary.unavailable });
    }
    return Response.json({ available: true, ...summary });
  } catch (e) {
    return Response.json({ available: false, kind: "error", reason: String((e as Error).message ?? e) });
  }
}
