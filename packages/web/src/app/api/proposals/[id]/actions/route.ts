// Perform a proposal lifecycle action (start_review/request_changes/resubmit/revise/accept/reject).
// Legality + actor permissions enforced by the shared state machine. SKILLY_SPEC.md §8.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../lib/access";
import { pool } from "../../../../../lib/db";
import { performProposalAction, verifySubmissionPayload, resolveReuseSource, applyReuseToPayload, reviseFileFreezeError, type RevisionPayload } from "../../../../../lib/proposals";
import { enforceRateLimit } from "../../../../../lib/ratelimit";
import { withSystemLog } from "../../../../../lib/apiLog";
import { findDuplicateSkill } from "../../../../../lib/duplicate";
import { verifyPointerSkill } from "../../../../../lib/pointerVerify";
import { getDuplicateEnforcement } from "../../../../../lib/settings";
import { isValidSemver, type ProposalAction } from "@skilly/shared";

export const dynamic = "force-dynamic";

interface ActionBody {
  action: ProposalAction;
  note?: string;
  newPayload?: RevisionPayload;
  /** proposer resubmit: revised proposed semver (§8; a mid-review `revise` never changes it) */
  newSemver?: string;
  /**
   * Proposer resubmit or mid-review revise (§8): switch the files to "Keep current files" — the
   * server re-resolves the snapshot against the THEN-latest stable version (any client-sent
   * artifact/pointer in `newPayload` is ignored). New-version proposals only; on `revise`,
   * hosted proposals only (a pointer proposal's files are frozen mid-review).
   */
  reuseCurrentFiles?: boolean;
  /** Revision-pinned accept (§8): the revision number the reviewer inspected — required on accept;
   *  409 when the proposal has since gained a newer revision. */
  revisionNo?: number;
  /** explicit override to accept over high/critical scan findings (§9) */
  override?: boolean;
  overrideReason?: string;
}

export const POST = withSystemLog("/api/proposals/[id]/actions", async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("proposal-action", access.userId, 60);
  if (limited) return limited;

  const body = (await req.json()) as ActionBody;
  const proposalId = (await ctx.params).id;

  // A revised semver is only meaningful on resubmit (§8); validate format here, strict-increase
  // is enforced at accept (assertStrictlyIncreasing).
  if (body.newSemver != null && body.action === "resubmit" && !isValidSemver(body.newSemver)) {
    return Response.json({ error: "the version must be a valid semver (e.g. 1.2.3)" }, { status: 422 });
  }

  const isRevise = body.action === "revise";

  // Reviewer edits / resubmits / mid-review revises carry a fresh payload — gate it like an
  // original submission (SSRF allowlist, harness normalization; previously unchecked here). The
  // artifact key carried forward from the latest revision is pre-approved (it was gated at
  // submission and the editor may not be its uploader); a NEW key still requires caller
  // ownership + scan.
  if (body.newPayload) {
    const { rows } = await pool.query<{
      payload: RevisionPayload; target_skill_id: string | null; ns_slug: string; proposed_semver: string;
    }>(
      `select pr.payload, p.target_skill_id, n.slug as ns_slug, p.proposed_semver
         from proposal_revisions pr
         join proposals p on p.id = pr.proposal_id
         join namespaces n on n.id = p.target_namespace_id
        where pr.proposal_id = $1 order by pr.revision_no desc limit 1`,
      [proposalId],
    );
    const prev = rows[0];
    const existingKey = prev?.payload.artifactObjectKey ?? null;

    // §8 revise locks: the proposed semver never changes mid-review (tolerate an echoed
    // unchanged value), and a POINTER proposal's files are fully frozen — url/ref/subdir,
    // the staged artifact, and the reuse snapshot are all untouchable until the reviewer
    // requests changes and the proposer resubmits.
    if (isRevise) {
      if (body.newSemver != null && prev && body.newSemver !== prev.proposed_semver) {
        return Response.json({ error: "the proposed version can’t change while the proposal is in review — it can only be revised after changes are requested" }, { status: 422 });
      }
      const freezeErr = prev ? reviseFileFreezeError(prev.payload, body.newPayload, !!body.reuseCurrentFiles) : null;
      if (freezeErr) return Response.json({ error: freezeErr }, { status: 422 });
    }

    // Switch to "Keep current files" on resubmit or (hosted) revise (§8): drop any client-sent
    // files — the server resolves the snapshot itself after the payload is verified/normalized
    // below. (A pointer revise never reaches here — rejected above.)
    const reuse = (body.action === "resubmit" || isRevise) && !!body.reuseCurrentFiles && !!prev?.target_skill_id;
    if ((body.action === "resubmit" || isRevise) && body.reuseCurrentFiles && !prev?.target_skill_id) {
      return Response.json({ error: "keep-current-files applies only to new-version proposals" }, { status: 422 });
    }
    if (reuse) {
      body.newPayload = { ...body.newPayload, artifactObjectKey: undefined, artifactSha256: undefined, contentSha256: undefined, artifactFilename: undefined, pointer: undefined };
    }
    const payloadErr = await verifySubmissionPayload(pool, access.userId, body.newPayload, {
      preapprovedArtifactKey: existingKey,
      namespaceSlug: prev?.ns_slug,
      targetSkillId: prev?.target_skill_id ?? null,
    });
    if (payloadErr) return Response.json({ error: payloadErr }, { status: 422 });

    if (reuse) {
      // Re-snapshot against the THEN-latest stable version + the §8 no-op guard. The reused
      // bytes were already gated when first published, so the changed-content gates below are
      // skipped (artifact/pointer fields were stripped above, so both `changed` flags are false).
      const r = await resolveReuseSource(pool, prev!.target_skill_id!, body.newPayload.metadata);
      if (!r.ok) return Response.json({ error: r.error }, { status: 422 });
      body.newPayload = applyReuseToPayload(body.newPayload, r.reuse);
    } else if (body.newPayload.reuse && (body.action === "resubmit" || isRevise) && (body.newPayload.artifactObjectKey !== existingKey || body.newPayload.pointer)) {
      // A fresh source replaces a prior reuse snapshot: drop the stale marker.
      body.newPayload = { ...body.newPayload, reuse: undefined };
    }

    // When a resubmit or revise CHANGES the content (new artifact, or new pointer url/ref/subdir),
    // re-run the same gates the initial submission does (§8): pointer resolves to a real SKILL.md,
    // and the content doesn't duplicate another visible skill. Unchanged content (reviewer
    // metadata edit) skips these — the artifact was already gated. Keep-current-files skips too
    // (the reused artifact key differs from the previous revision's, but its bytes are already live).
    const np = body.newPayload;
    const artifactChanged = !reuse && !!np.artifactObjectKey && np.artifactObjectKey !== existingKey;
    const ptr = np.pointer;
    const prevPtr = prev?.payload.pointer;
    const pointerChanged = !!ptr && (!prevPtr || ptr.url !== prevPtr.url || ptr.ref !== prevPtr.ref || (ptr.subdir ?? null) !== (prevPtr.subdir ?? null));
    if ((body.action === "resubmit" || isRevise) && (artifactChanged || pointerChanged)) {
      if (pointerChanged && ptr) {
        const v = await verifyPointerSkill(ptr.url, ptr.ref, ptr.subdir);
        if (!v.ok) return Response.json({ error: v.error }, { status: 422 });
      }
      const dup = await findDuplicateSkill(
        access,
        prev?.target_skill_id
          ? { contentSha256: np.contentSha256, excludeSkillId: prev.target_skill_id }
          : { slug: np.metadata?.skillSlug, pointer: ptr ? { url: ptr.url, subdir: ptr.subdir } : null, contentSha256: np.contentSha256 },
      );
      if (dup && (await getDuplicateEnforcement()) === "block") {
        return Response.json(
          { error: `this skill is already in the catalog as ${dup.namespaceSlug}/${dup.skillSlug} — propose a new version of it instead`, duplicate: dup },
          { status: 409 },
        );
      }
    }
  }
  // Revision-pinned accept (§8): the client must pin the revision it inspected.
  if (body.action === "accept" && body.revisionNo != null && !Number.isInteger(body.revisionNo)) {
    return Response.json({ error: "revisionNo must be an integer" }, { status: 422 });
  }

  const result = await performProposalAction(pool, {
    proposalId,
    action: body.action,
    actorUserId: access.userId,
    access,
    note: body.note ?? null,
    newPayload: body.newPayload,
    newSemver: body.newSemver ?? null,
    expectedRevisionNo: body.action === "accept" ? body.revisionNo ?? null : null,
    override: body.override,
    overrideReason: body.overrideReason ?? null,
  });

  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
});
