// Published per-version file changes for the skill detail page (SKILLY_SPEC.md §10) — the public
// counterpart to the reviewer view (§8, GET /api/proposals/:id/changes). Same engine, same
// statuses, same diffs; baselined on the version's IMMEDIATE PREDECESSOR (any channel, any status)
// instead of "latest stable", and gated by the SKILL's own visibility instead of reviewer access.
//
//   GET .../versions/:semver/changes        -> { available, baselineSemver, added, modified,
//                                                removed, unchanged, files } | { available:false, reason }
//   GET .../versions/:semver/changes?path=X -> that file's unified line diff, or a binary/too-large marker.
//
// This grants no new access to bytes: any caller who can open the detail page can already download
// every active version's artifact (§10) and diff them locally — this only saves them the work.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../../../lib/access";
import { findSkill } from "../../../../../../../../lib/catalog";
import { canManageMaintainers } from "../../../../../../../../lib/maintainers";
import { pool } from "../../../../../../../../lib/db";
import { enforceRateLimit } from "../../../../../../../../lib/ratelimit";
import { getVersionChangeSummary, getVersionFileDiff } from "../../../../../../../../lib/versionDiff";
import { isSkillVisible, isValidSemver } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ ns: string; slug: string; semver: string }> }): Promise<Response> {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  // Each cold call re-fetches + re-extracts two artifacts — limited like the other byte-touching
  // governed routes (readme, download).
  const limited = enforceRateLimit("download", access.userId, 120);
  if (limited) return limited;

  const { ns, slug, semver } = await ctx.params;
  if (!isValidSemver(semver)) return Response.json({ error: "not found" }, { status: 404 });

  const skill = await findSkill(ns, slug);
  if (!skill) return Response.json({ error: "not found" }, { status: 404 });
  if (skill.status === "archived") {
    // Archived skills are owner-only (§7) — same rule as the detail route and the trend chart.
    const owner = await canManageMaintainers(access, skill, access.userId);
    if (!owner) return Response.json({ error: "not found" }, { status: 404 });
  } else if (!isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
    return Response.json({ error: "not found" }, { status: 404 }); // no leak (invariant #3)
  }

  const { rowCount } = await pool.query(`select 1 from skill_versions where skill_id = $1 and semver = $2`, [skill.id, semver]);
  if (!rowCount) return Response.json({ error: "not found" }, { status: 404 });

  const path = new URL(req.url).searchParams.get("path");
  try {
    if (path) {
      const result = await getVersionFileDiff(skill.id, semver, path);
      if (!result) return Response.json({ error: "file not part of this change set" }, { status: 404 });
      return Response.json({ path, ...result });
    }
    const summary = await getVersionChangeSummary(skill.id, semver);
    if ("unavailableReason" in summary) return Response.json({ available: false, reason: summary.unavailableReason });
    if (summary.unavailable) return Response.json({ available: false, reason: "error", detail: summary.unavailable });
    return Response.json({ available: true, ...summary });
  } catch (e) {
    return Response.json({ available: false, reason: "error", detail: String((e as Error).message ?? e) });
  }
}
