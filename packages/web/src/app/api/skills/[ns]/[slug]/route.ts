// Skill detail (visibility-enforced). Returns metadata + versions + resolved latest.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../lib/access";
import { findSkill, listVersions, latestStableSemver, latestVersionUsage, pointerSource, skillFormDefaults, pendingMirrorStatus } from "../../../../../lib/catalog";
import { isWatching, watcherCount } from "../../../../../lib/watch";
import { getRating } from "../../../../../lib/ratings";
import { getEffectiveMaintainers, canManageMaintainers } from "../../../../../lib/maintainers";
import { skillDiscussionCount } from "../../../../../lib/messages";
import { logView } from "../../../../../lib/usage";
import { withSystemLog } from "../../../../../lib/apiLog";
import { skillContentRiskSummary } from "../../../../../lib/contentRisk";
import { skillPolicySummary } from "../../../../../lib/policy";
import { skillQualityDetail, skillVersionQualities } from "../../../../../lib/quality";
import { qualitySummary } from "../../../../../lib/catalog";
import { aiDraftAvailability } from "../../../../../lib/qualityDraft";
import { listGrants, isExplicitMaintainer } from "../../../../../lib/grants";
import { deprecationDetail, listReplaces } from "../../../../../lib/deprecation";
import { isSkillVisible, canYankOrArchive, canInitiatePromotion, canShareSkill, seesViaGrantOnly, resolveLatest } from "@skilly/shared";

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
  } else if (!isSkillVisible(access, skill)) {
    return Response.json({ error: "not found" }, { status: 404 }); // no leak
  }

  // Record the view only for live consumption — not an owner inspecting an archived skill. §21.
  if (!archived && access.userId) logView(skill.id, skill.namespaceId, access.userId);

  const [policy, versions0, latest, watching, watchers, rating, usageExamples, maintainers, pointer, meta, pendingMirror, discussionCount, contentRisk, isOwner, versionQuality, grants, explicitMaintainer, replaces] = await Promise.all([
    // §47.9: the displayed version's policy-check status for every viewer — never results.
    skillPolicySummary({ id: skill.id, namespaceId: skill.namespaceId }),
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
    skillDiscussionCount(skill.id),
    // §37.7: the displayed version's content-check status for every viewer — never findings.
    skillContentRiskSummary(skill.id),
    // §37.8: owners (maintainers, namespace admins, platform admins) also get the full card.
    access.userId ? canManageMaintainers(access, { id: skill.id, namespaceId: skill.namespaceId, visibility: skill.visibility }, access.userId) : Promise.resolve(false),
    // §41.7: each version's own stars for the Versions list.
    skillVersionQualities(skill.id),
    // §42: the shared-with list (chips + the propose form's new-version pre-fill).
    skill.visibility === "namespace" ? listGrants(skill.id) : Promise.resolve([]),
    isExplicitMaintainer(skill.id, access.userId ?? null),
    // §45.5: "Replaces <ns>/<slug>" — the visible, active skills that name THIS one as successor.
    listReplaces(access, skill.id),
  ]);
  const versions = versions0.map((v) => ({ ...v, quality: versionQuality.get(v.semver) ?? null }));
  // §41.11: the latest stable version's full Quality card payload (findings + verdict), or null.
  const qualityDetail0 = latest ? await skillQualityDetail(access, skill, latest) : null;
  // §44.2: whether this viewer may draft improvements with AI (hidden = available:false, reason:null).
  const qualityDetail = qualityDetail0 && !archived
    ? { ...qualityDetail0, aiDraft: await aiDraftAvailability(access, skill.namespaceSlug, skill.slug) }
    : qualityDetail0 && { ...qualityDetail0, aiDraft: { available: false, reason: null } };
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
  const deprecated = skill.deprecatedAt != null;
  const canDeprecate = !archived && canYankOrArchive(access, skill.namespaceId);
  return Response.json({
    // §38.3 the Add-to-collection popup addresses the skill by id; `collectible` gates the button
    // (org-visible, active, installable — the shared eligibility rule).
    skillId: skill.id,
    collectible: skill.visibility === "org" && !archived && latestInstallable != null,
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
    // Live comment count for the collapsed Discussion card header ("Discussion (N)") — §24.
    discussionCount,
    contentRisk,
    canSeeContentRisk: isOwner,
    policy,
    canSeePolicy: isOwner,
    quality: qualitySummary(skill.qualityScore, skill.qualityMode),
    qualityDetail,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    archived,
    // Official endorsement (§7): the badge + provenance line; toggle shown only to platform admins.
    official: skill.official,
    officialAt: skill.officialAt,
    officialByName: skill.officialByName,
    icon: skill.icon,
    // §42 sharing: the grantee namespaces, whether THIS viewer sees the skill only through a grant
    // (drives the "Shared with your namespace by <owner>" marker), and the share right.
    sharedNamespaces: grants.map((g) => ({ namespaceId: g.namespaceId, slug: g.slug, displayName: g.displayName })),
    sharedWithViewer: seesViaGrantOnly(access, skill),
    ownerNamespaceName: skill.namespaceDisplayName,
    canManageGrants: !archived && skill.visibility === "namespace" && canShareSkill(access, skill.namespaceId, explicitMaintainer),
    canMarkOfficial: access.isPlatformAdmin && !archived,
    // Featured homepage spotlight (§7): current state + whether this caller can toggle it. The
    // Spotlight control is platform-admin only and only on an active, installable skill.
    featured: skill.featured,
    canFeature: access.isPlatformAdmin && !archived && !deprecated && latestInstallable != null,
    // §45: the deprecation marker (successor only when THIS viewer can see it), the reverse
    // "Replaces …" list, and the deprecate/edit/un-deprecate right (= archive's authority).
    deprecation: deprecationDetail(access, skill, canDeprecate),
    replaces,
    canDeprecate,
    // capability flags for the UI
    canManage: canYankOrArchive(access, skill.namespaceId), // yank / archive / restore
    // Permanent deletion is platform-admin only and only for archived skills (§7).
    canDelete: access.isPlatformAdmin && archived,
    // "Retry mirroring" — platform admin only, shown only when this skill's mirror dead-lettered. §6.
    canRetryMirror: access.isPlatformAdmin && !!pendingMirror?.failed,
    canPromote: !archived && !deprecated && !isGlobal && latest != null && canInitiatePromotion(access, skill.namespaceId),
    isGlobal,
  });
});
