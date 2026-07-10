// Skill detail (visibility-enforced). Returns metadata + versions + resolved latest.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../lib/access";
import { findSkill, listVersions, latestStableSemver, latestVersionUsage, pointerSource, skillFormDefaults, pendingMirrorStatus } from "../../../../../lib/catalog";
import { isWatching, watcherCount } from "../../../../../lib/watch";
import { getRating } from "../../../../../lib/ratings";
import { getEffectiveMaintainers, canManageMaintainers } from "../../../../../lib/maintainers";
import { logView } from "../../../../../lib/usage";
import { withSystemLog } from "../../../../../lib/apiLog";
import { isSkillVisible, canYankOrArchive, canInitiatePromotion, resolveLatest } from "@skilly/shared";

export const dynamic = "force-dynamic";

export const GET = withSystemLog("/api/skills/[ns]/[slug]", async function GET(_req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);

  const skill = await findSkill((await ctx.params).ns, (await ctx.params).slug);
  if (!skill) return Response.json({ error: "not found" }, { status: 404 });

  const archived = skill.status === "archived";
  if (archived) {
    // Archived skills are withdrawn from the catalog: only OWNERS (platform/ns admin or a
    // maintainer) may open them — read-only, to view history and restore. Everyone else 404s
    // (no leak, same as a non-existent skill). §7, §19.
    const owner = access.userId ? await canManageMaintainers(access, { id: skill.id, namespaceId: skill.namespaceId, visibility: skill.visibility }, access.userId) : false;
    if (!owner) return Response.json({ error: "not found" }, { status: 404 });
  } else if (!isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
    return Response.json({ error: "not found" }, { status: 404 }); // no leak
  }

  // Record the view only for live consumption — not an owner inspecting an archived skill. §21.
  if (!archived && access.userId) logView(skill.id, skill.namespaceId, access.userId);

  const [versions, latest, watching, watchers, rating, usageExamples, maintainers, pointer, meta, pendingMirror] = await Promise.all([
    listVersions(skill.id),
    latestStableSemver(skill.id),
    access.userId ? isWatching(access.userId, skill.id) : Promise.resolve(false),
    watcherCount(skill.id),
    getRating(skill.id, access.userId ?? null),
    latestVersionUsage(skill.id),
    getEffectiveMaintainers({ id: skill.id, namespaceId: skill.namespaceId, visibility: skill.visibility }),
    pointerSource(skill.id),
    skillFormDefaults(skill.id),
    pendingMirrorStatus(skill.id),
  ]);
  const isGlobal = skill.namespaceSlug === "global";
  // INSTALLABLE = latest stable version whose serving git repo is actually synthesized
  // (git_published). A freshly published version is `active` (so `latest` is set) but its repo
  // isn't built until the publish sweep runs (≤60s later) — until then `npx skills add` 404s,
  // so the UI must NOT offer an install command yet. `publishing` = there's a latest version but
  // nothing servable yet (the just-uploaded, sweep-pending window). SKILLY_SPEC.md §6/§9.
  const latestInstallable = resolveLatest(
    versions.filter((v) => v.status === "active" && v.gitPublished).map((v) => v.semver),
  );
  const publishing = latest != null && latestInstallable == null;
  return Response.json({
    namespaceSlug: skill.namespaceSlug,
    skillSlug: skill.slug,
    visibility: skill.visibility,
    versions,
    latest,
    latestInstallable,
    publishing,
    watching,
    watchers,
    rating,
    usageExamples,
    maintainers,
    pointer,
    meta,
    pendingMirror,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    archived,
    // Official endorsement (§7): the badge + provenance line; toggle shown only to platform admins.
    official: skill.official,
    officialAt: skill.officialAt,
    officialByName: skill.officialByName,
    canMarkOfficial: access.isPlatformAdmin && !archived,
    // Featured homepage spotlight (§7): current state + whether this caller can toggle it. The
    // Spotlight control is platform-admin only and only on an active, installable skill.
    featured: skill.featured,
    canFeature: access.isPlatformAdmin && !archived && latestInstallable != null,
    // capability flags for the UI
    canManage: canYankOrArchive(access, skill.namespaceId), // yank / archive / restore
    // Permanent deletion is platform-admin only and only for archived skills (§7).
    canDelete: access.isPlatformAdmin && archived,
    // "Retry mirroring" — platform admin only, shown only when this skill's mirror dead-lettered. §6.
    canRetryMirror: access.isPlatformAdmin && !!pendingMirror?.failed,
    canPromote: !archived && !isGlobal && latest != null && canInitiatePromotion(access, skill.namespaceId),
    isGlobal,
  });
});
