// Mint a copy-paste install command for a skill (SKILLY_SPEC.md §9, §23). Every skill — org or
// namespace — gets a skill-scoped `install` token embedded in the URL. Body: { semver?, expiresAt?, system? }
//   semver  : a specific active version to pin (#v<semver>); omitted/null = "latest" (no #ref).
//   expiresAt: ISO instant when the install expires; omitted/null = never. Capped at the
//   admin-configured horizon (install_max_ttl_months, default 12). §23.
//   system  : true mints a SYSTEM installation — platform-owned (no user), for CI/org tools.
//   Platform-admin only, re-verified here (hiding the checkbox is not authorization), and
//   audited (install.system_minted) — §23 "System installations".
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill, listVersions } from "../../../../../../lib/catalog";
import { mintInstallToken } from "../../../../../../lib/installs";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { withSystemLog } from "../../../../../../lib/apiLog";
import { getInstallMaxTtlMonths, installExpiryCeiling } from "../../../../../../lib/settings";
import { appendAudit } from "../../../../../../lib/audit";
import { pool } from "../../../../../../lib/db";
import { buildInstallCommand, isSkillVisible, resolveLatest } from "@skilly/shared";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/skills/[ns]/[slug]/install", async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("install", oid, 30);
  if (limited) return limited;

  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill || skill.status === "archived") {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const access = await resolveUserAccess(oid);
  if (!isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
    // Do not reveal existence of restricted skills to outsiders.
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { semver?: string | null; expiresAt?: string | null; system?: boolean };

  // System installation: platform-admin only, verified against SCIM-resolved roles (invariant #1)
  // regardless of what the UI showed. §23 "System installations".
  const system = body.system === true;
  if (system && !access.isPlatformAdmin) {
    return Response.json({ error: "only platform admins can mint a system install" }, { status: 403 });
  }

  // Version gating: a version is only installable once its serving git repo is synthesized
  // (git_published) — minting a command before the publish sweep runs would hand the user a URL
  // that 404s. A specific pin must be ACTIVE + git_published; "latest" needs ≥1 git_published
  // stable version. SKILLY_SPEC.md §6/§9/§23.
  const versions = await listVersions(skill.id);
  let pinned: string | null = null;
  if (body.semver) {
    const v = versions.find((x) => x.semver === body.semver && x.status === "active");
    if (!v) return Response.json({ error: "that version isn’t installable (unknown or yanked)" }, { status: 422 });
    if (!v.gitPublished) return Response.json({ error: "that version is still being published — try again in a moment" }, { status: 409 });
    pinned = body.semver;
  } else if (!resolveLatest(versions.filter((v) => v.status === "active" && v.gitPublished).map((v) => v.semver))) {
    return Response.json({ error: "no installable version yet — the skill is still being published" }, { status: 409 });
  }

  // Expiry: future and within the admin-configured horizon (calendar months). null/omitted = never.
  let expiresAt: Date | null = null;
  if (body.expiresAt) {
    const d = new Date(body.expiresAt);
    if (Number.isNaN(d.getTime())) return Response.json({ error: "invalid expiry date" }, { status: 422 });
    if (d.getTime() <= Date.now()) return Response.json({ error: "expiry must be in the future" }, { status: 422 });
    const months = await getInstallMaxTtlMonths();
    if (d.getTime() > installExpiryCeiling(months).getTime()) {
      return Response.json({ error: `expiry can be at most ${months} month${months === 1 ? "" : "s"} out — or choose “Never”` }, { status: 422 });
    }
    expiresAt = d;
  }

  const { raw } = await mintInstallToken(access.userId, skill.id, pinned, expiresAt, { system });
  if (system) {
    // Audited (exception to "install tokens are not audited") — the compensating control for a
    // shared, visibility-bypassing credential. §11/§23.
    await appendAudit(pool, {
      actorUserId: access.userId,
      action: "install.system_minted",
      targetType: "skill",
      targetId: skill.id,
      namespaceId: skill.namespaceId,
      after: { skill: `${skill.namespaceSlug}/${skill.slug}`, semver: pinned ?? "latest", expiresAt: expiresAt?.toISOString() ?? "never" },
    });
  }
  const command = buildInstallCommand({
    registryBaseUrl: process.env.SKILLY_REGISTRY_URL ?? "",
    namespaceSlug: skill.namespaceSlug,
    skillSlug: skill.slug,
    semver: pinned, // null => latest => no #ref
    token: raw,
    agent: skill.toolHarness, // recognized non-generic agent => appends `--agent <slug>` (§9)
  });

  return Response.json({ command, semver: pinned, expiresAt: expiresAt?.toISOString() ?? null, system });
});
