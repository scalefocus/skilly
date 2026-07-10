// Propose a skill (any authenticated user) + reviewer queue. SKILLY_SPEC.md §8.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { pool } from "../../../lib/db";
import { createProposal, listReviewQueue, listMySubmissions, hasReviewScope, verifySubmissionPayload, resolveReuseSource, applyReuseToPayload, type RevisionPayload } from "../../../lib/proposals";
import { enforceRateLimit } from "../../../lib/ratelimit";
import { getProposalsOpen, getDuplicateEnforcement } from "../../../lib/settings";
import { findDuplicateSkill } from "../../../lib/duplicate";
import { verifyPointerSkill } from "../../../lib/pointerVerify";
import { withSystemLog } from "../../../lib/apiLog";

export const dynamic = "force-dynamic";

async function requireUser() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return null;
  return resolveUserAccess(oid);
}

interface CreateBody {
  namespaceSlug: string;
  targetSkillSlug?: string;
  semver: string;
  metadata: RevisionPayload["metadata"];
  // HOSTED: bundle uploaded via POST /api/uploads, which returns { key, sha256, contentSha256 }.
  artifactObjectKey?: string;
  artifactSha256?: string;
  contentSha256?: string;
  artifactFilename?: string | null;
  // POINTER: external git source mirrored by the worker on accept (no upload).
  // `subdir` (optional) = folder inside a multi-skill upstream repo where SKILL.md lives.
  pointer?: { url: string; ref: string; subdir?: string | null };
  /**
   * Keep current files (§8): new-version proposals only — reuse the target skill's latest stable
   * artifact byte-for-byte (server-resolved snapshot; any client-sent artifact/pointer is ignored).
   */
  reuseCurrentFiles?: boolean;
  /** Skill request this proposal was started from (§26) — the explicit fulfilment link. */
  originRequestId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withSystemLog("/api/proposals", async function POST(req: Request) {
  const access = await requireUser();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("proposals", access.userId, 30);
  if (limited) return limited;

  const body = (await req.json()) as CreateBody;
  const ns = (await pool.query<{ id: string }>(`select id from namespaces where slug = $1`, [body.namespaceSlug])).rows[0];
  if (!ns) return Response.json({ error: "namespace not found" }, { status: 404 });

  // Contribution policy: when proposals aren't "open", only members/admins of the target
  // namespace (and platform admins) may propose. SKILLY_SPEC.md §4.
  if (!(await getProposalsOpen())) {
    const mayPropose = access.isPlatformAdmin || access.namespaceRoles.has(ns.id);
    if (!mayPropose) {
      return Response.json(
        { error: "proposals are restricted to members of this namespace — ask an admin for access" },
        { status: 403 },
      );
    }
  }

  let targetSkillId: string | null = null;
  if (body.targetSkillSlug) {
    const s = (await pool.query<{ id: string }>(`select id from skills where namespace_id = $1 and slug = $2`, [ns.id, body.targetSkillSlug])).rows[0];
    if (!s) return Response.json({ error: "target skill not found" }, { status: 404 });
    targetSkillId = s.id;
  } else if (body.metadata?.skillSlug) {
    // NEW-skill proposal: fail fast on a slug collision instead of surfacing a unique-key
    // violation at accept time. Disclosing slug-taken on a write conflict is standard
    // creation semantics (the DB error would reveal it anyway); no other metadata leaks.
    const clash = (await pool.query(`select 1 from skills where namespace_id = $1 and slug = $2`, [ns.id, body.metadata.skillSlug])).rowCount;
    if (clash) {
      return Response.json(
        { error: `a skill named '${body.metadata.skillSlug}' already exists in this namespace — propose a new version of it instead` },
        { status: 409 },
      );
    }
  }

  // Keep current files (§8) is only meaningful when re-versioning an existing skill; the server
  // resolves the snapshot itself (below), so client-sent artifact/pointer fields are ignored then.
  const reuse = !!body.reuseCurrentFiles && !!targetSkillId;
  if (body.reuseCurrentFiles && !targetSkillId) {
    return Response.json({ error: "keep-current-files applies only when proposing a new version of an existing skill" }, { status: 422 });
  }
  if (!reuse && !body.pointer && !body.artifactObjectKey) {
    return Response.json({ error: "provide an uploaded bundle (hosted) or a pointer { url, ref }" }, { status: 422 });
  }

  // SSRF/transport allowlist for pointer URLs + artifact ownership/scan check (#3, §6). Runs
  // FIRST so the metadata (tool/harness) is normalized before the reuse no-op comparison below.
  let payload: RevisionPayload = {
    metadata: body.metadata,
    artifactObjectKey: reuse ? undefined : body.artifactObjectKey,
    artifactSha256: reuse ? undefined : body.artifactSha256,
    contentSha256: reuse ? undefined : body.contentSha256,
    artifactFilename: reuse ? undefined : body.artifactFilename,
    pointer: reuse ? undefined : body.pointer,
  };
  const payloadErr = await verifySubmissionPayload(pool, access.userId, payload, {
    namespaceSlug: body.namespaceSlug,
    targetSkillId,
  });
  if (payloadErr) return Response.json({ error: payloadErr }, { status: 422 });

  // Keep current files (§8): snapshot the latest stable version's artifact NOW (the reviewer
  // approves exactly these bytes) + enforce the no-op guard (at least one field must differ).
  // The reused bytes were already verified/scanned when first published, so the pointer
  // verification and duplicate checks below are skipped for reuse.
  if (reuse) {
    const r = await resolveReuseSource(pool, targetSkillId!, payload.metadata);
    if (!r.ok) return Response.json({ error: r.error }, { status: 422 });
    payload = applyReuseToPayload(payload, r.reuse);
  }

  // Pointer proposals: verify the source actually resolves to a SKILL.md at the pinned ref/folder
  // BEFORE creating the proposal — so a wrong URL/ref/folder is rejected here instead of
  // dead-lettering at mirror time (§6, §8). skills-hub URLs skip this (verified internally).
  if (payload.pointer) {
    const v = await verifyPointerSkill(payload.pointer.url, payload.pointer.ref, payload.pointer.subdir);
    if (!v.ok) return Response.json({ error: v.error }, { status: 422 });
  }

  // Duplicate detection (§8). NEW skill: full identity (cross-namespace same-slug pointer, or
  // identical content). NEW version: content only — a new version legitimately reuses its own
  // pointer/slug, but its uploaded content must not be byte-identical to a DIFFERENT existing
  // skill (so we exclude the target skill). When enforcement is "block" we 409 with the match so
  // the form can redirect to "propose a new version"; "warn" lets it through (reviewer is alerted).
  // Keep-current-files is EXEMPT: the content is already published under this very skill.
  const dup = reuse
    ? null
    : await findDuplicateSkill(
        access,
        targetSkillId
          ? { contentSha256: body.contentSha256, excludeSkillId: targetSkillId }
          : {
              slug: body.metadata?.skillSlug,
              pointer: body.pointer ? { url: body.pointer.url, subdir: body.pointer.subdir } : null,
              contentSha256: body.contentSha256,
            },
      );
  if (dup && (await getDuplicateEnforcement()) === "block") {
    return Response.json(
      {
        error: `this skill is already in the catalog as ${dup.namespaceSlug}/${dup.skillSlug} — propose a new version of it instead`,
        duplicate: dup,
      },
      { status: 409 },
    );
  }

  // Fulfilment link (§26): only accept a syntactically valid id that points at an OPEN request —
  // a bogus/closed link is dropped silently (the proposal itself is unaffected; the link is advisory).
  let originRequestId: string | null = null;
  if (body.originRequestId && UUID_RE.test(body.originRequestId)) {
    const open = (await pool.query(`select 1 from skill_requests where id = $1 and state = 'open'`, [body.originRequestId])).rowCount;
    if (open) originRequestId = body.originRequestId;
  }

  const { id } = await createProposal(pool, {
    submittedByUserId: access.userId,
    targetNamespaceId: ns.id,
    targetSkillId,
    proposedSemver: body.semver,
    originRequestId,
    payload,
  });
  return Response.json({ id }, { status: 201 });
});

export const GET = withSystemLog("/api/proposals", async function GET(req: Request) {
  const access = await requireUser();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const canReview = hasReviewScope(access);
  const url = new URL(req.url);

  // `?tab=review` → one paginated batch of the reviewer queue (newest-first, 100/batch), for the
  // UI's infinite scroll. State filtering + cursor + per-state counts all resolve server-side. §8.
  if (url.searchParams.get("tab") === "review") {
    if (!canReview) {
      return Response.json({ review: { items: [], nextCursor: null, counts: {}, total: 0 } });
    }
    const statesParam = url.searchParams.get("states");
    const states = statesParam ? statesParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const review = await listReviewQueue(pool, access, { states, cursor: url.searchParams.get("cursor") });
    return Response.json({ review });
  }

  // Initial load: the caller's own submissions (everyone, whole) + whether to show the review tab.
  // `canReview` drives the "To review" tab; the page then fetches the first review batch itself. §8.
  const mine = access.userId ? await listMySubmissions(pool, access.userId) : [];
  return Response.json({ mine, canReview });
});
