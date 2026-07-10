// Direct publish (no review) for trusted Namespace Members in require_review=false
// namespaces. Hosted (uploaded artifact) or pointer (external ref). SKILLY_SPEC.md §4.
import { currentAccess } from "../../../lib/guard";
import { pool } from "../../../lib/db";
import { directPublish, verifySubmissionPayload, resolveReuseSource, applyReuseToPayload, type RevisionPayload } from "../../../lib/proposals";
import { enforceRateLimit } from "../../../lib/ratelimit";
import { findDuplicateSkill } from "../../../lib/duplicate";
import { verifyPointerSkill } from "../../../lib/pointerVerify";
import { getDuplicateEnforcement } from "../../../lib/settings";
import { withSystemLog } from "../../../lib/apiLog";

export const dynamic = "force-dynamic";

interface Body {
  namespaceSlug: string;
  semver: string;
  metadata: RevisionPayload["metadata"];
  // hosted
  artifactObjectKey?: string;
  artifactSha256?: string;
  contentSha256?: string;
  artifactFilename?: string | null;
  // pointer (subdir = optional folder inside a multi-skill upstream repo)
  pointer?: { url: string; ref: string; subdir?: string | null };
  /**
   * Keep current files (§8): new-version publishes only — reuse the target skill's latest stable
   * artifact byte-for-byte (server-resolved snapshot; any client-sent artifact/pointer is ignored).
   */
  reuseCurrentFiles?: boolean;
  // Fulfilment link (§26): a direct publish is an immediate acceptance, so it fulfils too.
  originRequestId?: string | null;
}

export const POST = withSystemLog("/api/publish", async function POST(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("publish", access.userId, 30);
  if (limited) return limited;

  const b = (await req.json()) as Body;
  // Target skill (new-version publish) — also gates keep-current-files (§8), which only makes
  // sense when re-versioning an existing skill.
  const existing = (
    await pool.query<{ id: string }>(`select s.id from skills s join namespaces n on n.id = s.namespace_id where n.slug = $1 and s.slug = $2`, [b.namespaceSlug, b.metadata?.skillSlug])
  ).rows[0];
  const reuse = !!b.reuseCurrentFiles && !!existing;
  if (b.reuseCurrentFiles && !existing) {
    return Response.json({ error: "keep-current-files applies only when publishing a new version of an existing skill" }, { status: 422 });
  }
  if (!reuse && !b.pointer && !b.artifactObjectKey) {
    return Response.json({ error: "provide an uploaded bundle (hosted) or a pointer { url, ref }" }, { status: 422 });
  }

  let payload: RevisionPayload = {
    metadata: b.metadata,
    artifactObjectKey: reuse ? undefined : b.artifactObjectKey,
    artifactSha256: reuse ? undefined : b.artifactSha256,
    contentSha256: reuse ? undefined : b.contentSha256,
    artifactFilename: reuse ? undefined : b.artifactFilename,
    pointer: reuse ? undefined : b.pointer,
  };
  const payloadErr = await verifySubmissionPayload(pool, access.userId, payload, {
    namespaceSlug: b.namespaceSlug,
    targetSkillId: existing?.id ?? null,
  });
  if (payloadErr) return Response.json({ error: payloadErr }, { status: 422 });

  // Keep current files (§8): snapshot the latest stable artifact now + enforce the no-op guard.
  // The reused bytes were already verified/scanned when first published, so the pointer
  // verification and duplicate checks below are skipped for reuse.
  if (reuse) {
    const r = await resolveReuseSource(pool, existing!.id, payload.metadata);
    if (!r.ok) return Response.json({ error: r.error }, { status: 422 });
    payload = applyReuseToPayload(payload, r.reuse);
  }

  // Pointer publishes: verify the source resolves to a SKILL.md at the pinned ref/folder before
  // publishing — reject a wrong URL/ref/folder here instead of dead-lettering at mirror time (§6).
  if (payload.pointer) {
    const v = await verifyPointerSkill(payload.pointer.url, payload.pointer.ref, payload.pointer.subdir);
    if (!v.ok) return Response.json({ error: v.error }, { status: 422 });
  }

  // Duplicate detection (§8). A BRAND-NEW skill gets the full identity check; a new VERSION of an
  // existing same-namespace skill gets a content-only check that EXCLUDES that skill (it
  // legitimately reuses its own pointer/identity, but its content must not be byte-identical to a
  // DIFFERENT existing skill). Block mode 409s with the match; warn lets it through.
  // Keep-current-files is EXEMPT: the content is already published under this very skill.
  const dup = reuse
    ? null
    : await findDuplicateSkill(
        access,
        existing
          ? { contentSha256: b.contentSha256, excludeSkillId: existing.id }
          : {
              slug: b.metadata?.skillSlug,
              pointer: b.pointer ? { url: b.pointer.url, subdir: b.pointer.subdir } : null,
              contentSha256: b.contentSha256,
            },
      );
  if (dup && (await getDuplicateEnforcement()) === "block") {
    return Response.json(
      {
        error: `this skill is already in the catalog as ${dup.namespaceSlug}/${dup.skillSlug} — publish a new version of it instead`,
        duplicate: dup,
      },
      { status: 409 },
    );
  }

  const r = await directPublish(pool, { access, actorUserId: access.userId, namespaceSlug: b.namespaceSlug, semver: b.semver, payload, originRequestId: b.originRequestId });
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ skillId: r.skillId, versionId: r.versionId, pending: r.pending ?? false }, { status: 201 });
});
