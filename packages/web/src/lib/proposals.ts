// Proposal service — CRUD + lifecycle transitions + materialize-on-accept.
// Governance rules come from shared/proposal.ts (state machine + actor perms); this layer
// is the DB-backed orchestration. SKILLY_SPEC.md §8.
//
// Artifact handling: the proposer's uploaded bundle is stored ONCE at an immutable object
// key recorded in the proposal revision. Materialize simply references that key in the new
// skill_version — no object-store copy — and the worker's publish sweep synthesizes the
// git repo/tag from it.
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  canPerform,
  channelOf,
  assertStrictlyIncreasing,
  canReviewNamespace,
  canDirectPublish,
  canInitiatePromotion,
  requiresOverride,
  resolveLatest,
  validatePointerUrl,
  validateGitRef,
  validateSubdir,
  isSkillsHubUrl,
  validateSkillsHubRef,
  normalizeHarness,
  isAllowedToolHarness,
  TRANSITIONS,
  type EffectiveAccess,
  type ProposalAction,
  type ProposalState,
} from "@skilly/shared";
import { appendAudit } from "./audit";
import { autoAddSubmitter, autoAddSubmitterOnNewVersion } from "./maintainers";
import { findDuplicateSkill, type DuplicateMatch } from "./duplicate";
import { fulfilOriginRequest } from "./requests";
import { M } from "./metrics";

export interface ProposalMetadata {
  skillSlug: string;
  title: string;
  description: string;
  /** Zero or more category labels (tag-style; created on the fly). */
  categories?: string[];
  toolHarness: string;
  tags?: string[];
  usageExamples?: string | null;
  visibility: "org" | "namespace";
}

/**
 * Set a skill's categories to EXACTLY `names`: upsert + link the desired labels, then unlink any
 * that are no longer present. Normalizes (trim/lowercase/de-dupe, cap 12). Used both for a brand-new
 * skill (where the unlink is a no-op) and to re-categorize on a new-version proposal (§8) — the only
 * skill-level metadata a re-version may change.
 */
async function syncCategories(client: PoolClient, skillId: string, names: string[]): Promise<void> {
  const clean = [...new Set((names ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  const ids: string[] = [];
  for (const name of clean) {
    const { rows } = await client.query<{ id: string }>(
      `insert into categories (name) values ($1)
         on conflict (name) do update set name = excluded.name
       returning id`,
      [name],
    );
    ids.push(rows[0]!.id);
    await client.query(
      `insert into skill_categories (skill_id, category_id) values ($1, $2) on conflict do nothing`,
      [skillId, rows[0]!.id],
    );
  }
  // Drop links no longer in the desired set (full sync, so a removed category is removed).
  if (ids.length) {
    await client.query(`delete from skill_categories where skill_id = $1 and category_id <> all($2::uuid[])`, [skillId, ids]);
  } else {
    await client.query(`delete from skill_categories where skill_id = $1`, [skillId]);
  }
}

export interface RevisionPayload {
  metadata: ProposalMetadata;
  /** Hosted: immutable object-store key + sha of the uploaded bundle. Absent for pointer. */
  artifactObjectKey?: string;
  artifactSha256?: string;
  /** Hosted: the original uploaded filename (e.g. `my-skill.skill`) — persisted on the version so
   *  the detail-page download serves the bundle back with its original extension (§6/§10). */
  artifactFilename?: string | null;
  /**
   * Hosted: packaging-independent content-set digest (see @skilly/shared contentDigest), computed
   * at upload and persisted on the version for duplicate detection (§8). Absent for pointer —
   * the worker computes it from the mirrored files at mirror time.
   */
  contentSha256?: string;
  /**
   * Pointer: external git source mirrored by the worker on accept. `subdir` (optional) is the
   * folder *inside* the upstream repo where the skill's SKILL.md lives (multi-skill repos);
   * absent/null = repo root. §6.
   */
  pointer?: { url: string; ref: string; subdir?: string | null };
  /**
   * Keep current files (§8): this new version reuses, byte-for-byte, the artifact of the target
   * skill's latest stable version — snapshotted at submit time into the artifact fields above.
   * Resolved SERVER-SIDE (resolveReuseSource), never trusted from the client. `external` carries
   * the pointer provenance (origin/ref/subdir) onto the new version row so a pointer reuse keeps
   * its source identity WITHOUT re-mirroring (no pending_mirrors row, no upstream contact).
   */
  reuse?: {
    fromVersionId: string;
    fromSemver: string;
    external?: { url: string; ref: string; subdir?: string | null } | null;
  };
  /** Provenance: set when this version was promoted from another skill's version. */
  promotedFromSkillVersionId?: string | null;
}

export interface CreateProposalInput {
  submittedByUserId: string;
  targetNamespaceId: string;
  targetSkillId?: string | null;
  proposedSemver: string;
  payload: RevisionPayload;
  /** Skill request this proposal was started from (§26) — the explicit fulfilment link. */
  originRequestId?: string | null;
}

/**
 * Validate a submission payload at the API boundary (proposals + direct publish + reviewer
 * edits/resubmits):
 *  - pointer URL/ref pass the SSRF/transport allowlist (§6),
 *  - a hosted artifact key actually belongs to the caller AND was uploaded+scanned — so a user
 *    can't publish a version pointing at someone else's or an unscanned artifact (#3 integrity),
 *  - tool/harness is NORMALIZED IN PLACE (open vocabulary, §3/§8 — trim/lowercase/kebab) and
 *    validated, so every persistence path stores the canonical form.
 * Returns an error message, or null when the payload is acceptable.
 */
export async function verifySubmissionPayload(
  db: Pool | PoolClient,
  callerUserId: string,
  payload: RevisionPayload,
  opts: {
    /**
     * Skip the artifact-ownership check for THIS key (it was already gated when first
     * submitted). Used by reviewer edits/resubmits that carry the existing revision's
     * artifact forward — a reviewer is not the uploader, so the ownership check would
     * wrongly reject them. A DIFFERENT key still gets the full check.
     */
    preapprovedArtifactKey?: string | null;
    /**
     * Target namespace slug. When provided, enforces that a `namespace`-visibility skill is
     * NOT filed under `global` — global IS the org-wide namespace, so restricting to it is
     * self-contradictory (#7, per-skill visibility). The UI blocks this too; this is the
     * server-side backstop covering both proposals and direct publish.
     */
    namespaceSlug?: string;
    /**
     * Target skill id for new-version proposals / reviewer edits. Enables the legacy tool/harness
     * carve-out (§8): a value UNCHANGED from the target skill's stored `tool_harness` passes even
     * when it's not in the closed list — new-version mode resends the field, and rejecting the
     * untouched stored value would block every re-version of a pre-closed-vocabulary skill.
     */
    targetSkillId?: string | null;
  } = {},
): Promise<string | null> {
  if (
    opts.namespaceSlug !== undefined &&
    payload.metadata?.visibility === "namespace" &&
    opts.namespaceSlug.trim().toLowerCase() === "global"
  ) {
    return "a skill restricted to a namespace can’t live in the global namespace — choose a specific namespace, or set visibility to org-wide";
  }
  if (payload.metadata?.toolHarness != null) {
    // Closed vocabulary (§8): the picker submits a slug; normalize defensively, then require it to
    // be `generic` or a known agent — EXCEPT a grandfathered legacy value carried forward verbatim
    // on the target skill (see opts.targetSkillId above), which passes unchanged.
    payload.metadata.toolHarness = normalizeHarness(payload.metadata.toolHarness);
    if (!isAllowedToolHarness(payload.metadata.toolHarness)) {
      const unchangedLegacy = opts.targetSkillId
        ? (await db.query(`select 1 from skills where id = $1 and tool_harness = $2`, [opts.targetSkillId, payload.metadata.toolHarness])).rowCount
        : 0;
      if (!unchangedLegacy) return "choose a tool/harness from the list";
    }
  }
  if (payload.pointer) {
    const urlErr = validatePointerUrl(payload.pointer.url);
    if (urlErr) return urlErr;
    const refErr = validateGitRef(payload.pointer.ref);
    if (refErr) return refErr;
    if (isSkillsHubUrl(payload.pointer.url)) {
      // A branch-like ref would 404 on the registry's version endpoint and dead-letter the
      // mirror after all attempts — reject it here instead (§6/§8).
      const hubRefErr = validateSkillsHubRef(payload.pointer.ref);
      if (hubRefErr) return hubRefErr;
    }
    const subdir = payload.pointer.subdir?.trim();
    if (subdir) {
      const subErr = validateSubdir(subdir);
      if (subErr) return subErr;
    }
  }
  if (payload.artifactObjectKey && payload.artifactObjectKey !== opts.preapprovedArtifactKey) {
    if (!payload.artifactObjectKey.startsWith(`uploads/${callerUserId}/`)) {
      return "artifact does not belong to you — upload it via /api/uploads first";
    }
    const { rowCount } = await db.query(
      `select 1 from scan_reports where subject_type = 'artifact' and subject_id = $1`,
      [payload.artifactObjectKey],
    );
    if (!rowCount) return "artifact was not uploaded/scanned — upload it via /api/uploads first";
  }
  return null;
}

/** Trimmed, de-duped, sorted copy of a string list — for order-insensitive set comparison. */
function normSet(xs: readonly string[] | null | undefined, lower = false): string[] {
  return [...new Set((xs ?? []).map((x) => (lower ? x.trim().toLowerCase() : x.trim())).filter(Boolean))].sort();
}
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * §8 no-op guard for "Keep current files": with reused files, at least one field must actually
 * differ from the skill's current state (title, description, categories, tags, tool/harness) or
 * the reused version's usage — a bare semver bump is not a version. Returns the rejection
 * message, or null when something genuinely changes. `meta.toolHarness` is expected normalized
 * (verifySubmissionPayload runs first on every path).
 */
async function reuseNoopError(
  db: Pool | PoolClient,
  skillId: string,
  meta: ProposalMetadata,
  reusedUsage: string | null,
): Promise<string | null> {
  const { rows } = await db.query<{
    title: string; description: string; tool_harness: string; tags: string[] | null; categories: string[] | null;
  }>(
    `select s.title, s.description, s.tool_harness, s.tags,
            coalesce((select array_agg(c.name) from skill_categories sc
                        join categories c on c.id = sc.category_id
                       where sc.skill_id = s.id), '{}') as categories
       from skills s where s.id = $1`,
    [skillId],
  );
  const cur = rows[0];
  if (!cur) return "target skill not found";
  const changed =
    (meta.title ?? "").trim() !== cur.title.trim() ||
    (meta.description ?? "").trim() !== cur.description.trim() ||
    (meta.toolHarness ?? "").trim() !== cur.tool_harness ||
    !sameSet(normSet(meta.tags), normSet(cur.tags)) ||
    !sameSet(normSet(meta.categories, true), normSet(cur.categories, true)) ||
    ((meta.usageExamples ?? "").trim() || null) !== ((reusedUsage ?? "").trim() || null);
  return changed
    ? null
    : "nothing changed — edit at least one field (title, description, categories, tags, tool/harness, or usage), or provide a new source";
}

/** The server-resolved "Keep current files" snapshot (§8). */
export interface ReuseSource {
  fromVersionId: string;
  fromSemver: string;
  artifactObjectKey: string;
  artifactSha256: string | null;
  contentSha256: string | null;
  artifactFilename: string | null;
  /** The reused version's usage — the baseline the no-op guard compares against. */
  usageExamples: string | null;
  /** Pointer provenance re-pinned onto the new version row; null for hosted skills. */
  external: { url: string; ref: string; subdir: string | null } | null;
}

/**
 * Resolve the "Keep current files" source (§8): the target skill's LATEST STABLE active version —
 * the exact bytes an unpinned "latest" install serves — snapshotted NOW (submit time), so the
 * reviewer approves exactly what they inspected even if other versions land mid-review. When
 * `metadata` is provided, also enforces the no-op guard (at least one field must differ).
 * Fails when there is no stable active version, or its artifact isn't in storage yet
 * (a pointer whose mirror is still pending).
 */
export async function resolveReuseSource(
  db: Pool | PoolClient,
  skillId: string,
  metadata?: ProposalMetadata,
): Promise<{ ok: true; reuse: ReuseSource } | { ok: false; error: string }> {
  const { rows } = await db.query<{
    id: string; semver: string; artifact_object_key: string | null; artifact_sha256: string | null;
    content_sha256: string | null; artifact_filename: string | null; usage_examples: string | null;
    external_origin_url: string | null; external_ref: string | null; external_subdir: string | null;
  }>(
    `select id, semver, artifact_object_key, artifact_sha256, content_sha256, artifact_filename,
            usage_examples, external_origin_url, external_ref, external_subdir
       from skill_versions where skill_id = $1 and status = 'active'`,
    [skillId],
  );
  const latest = resolveLatest(rows.map((r) => r.semver));
  if (!latest) {
    return { ok: false, error: "this skill has no published stable version to reuse — attach a bundle or provide a source" };
  }
  const v = rows.find((r) => r.semver === latest)!;
  if (!v.artifact_object_key) {
    return { ok: false, error: `v${latest}'s files aren't in storage yet (mirror pending) — try again shortly, or provide a source` };
  }
  if (metadata) {
    const noop = await reuseNoopError(db, skillId, metadata, v.usage_examples);
    if (noop) return { ok: false, error: noop };
  }
  return {
    ok: true,
    reuse: {
      fromVersionId: v.id,
      fromSemver: v.semver,
      artifactObjectKey: v.artifact_object_key,
      artifactSha256: v.artifact_sha256,
      contentSha256: v.content_sha256,
      artifactFilename: v.artifact_filename,
      usageExamples: v.usage_examples,
      external: v.external_origin_url && v.external_ref
        ? { url: v.external_origin_url, ref: v.external_ref, subdir: v.external_subdir }
        : null,
    },
  };
}

/**
 * Apply a resolved reuse snapshot to a revision payload: pin the reused artifact fields, record
 * the reuse marker, and drop any client-sent pointer (the server is the only source of truth for
 * reused bytes). Shared by submit, direct publish, and resubmit.
 */
export function applyReuseToPayload(payload: RevisionPayload, reuse: ReuseSource): RevisionPayload {
  return {
    ...payload,
    artifactObjectKey: reuse.artifactObjectKey,
    artifactSha256: reuse.artifactSha256 ?? undefined,
    contentSha256: reuse.contentSha256 ?? undefined,
    artifactFilename: reuse.artifactFilename,
    pointer: undefined,
    reuse: { fromVersionId: reuse.fromVersionId, fromSemver: reuse.fromSemver, external: reuse.external },
  };
}

/**
 * Notify on proposal creation: the submitter gets a confirmation, and every reviewer of the
 * target namespace (platform admins anywhere + that namespace's admins + the bootstrap admin
 * group) gets an actionable "needs review" — excluding the submitter so nobody is asked to
 * review their own submission. SKILLY_SPEC.md §12.
 */
async function notifyProposalCreated(
  client: PoolClient,
  input: { proposalId: string; namespaceId: string; submitterId: string; skillSlug: string; semver: string },
): Promise<void> {
  const base = { proposalId: input.proposalId, skillSlug: input.skillSlug, semver: input.semver };

  // Submitter confirmation (so the author always gets feedback their proposal landed).
  await client.query(
    `insert into notifications (user_id, type, payload) values ($1, 'proposal.submitted', $2::jsonb)`,
    [input.submitterId, JSON.stringify(base)],
  );

  // Reviewers (deduped via UNION); bootstrap admin group included when configured.
  await notifyReviewersNeedsReview(client, { ...input, ...base });
}

/**
 * Fan out a "needs review" notification to every reviewer of a namespace — platform admins
 * anywhere + that namespace's admins + the bootstrap admin group — excluding the submitter.
 * Used on first submission AND on proposer resubmit (so a resubmitted proposal doesn't
 * silently re-enter the queue). SKILLY_SPEC.md §8/§12.
 */
async function notifyReviewersNeedsReview(
  client: PoolClient,
  input: { proposalId: string; namespaceId: string; submitterId: string; skillSlug: string; semver: string },
): Promise<void> {
  const bootstrap = process.env.SKILLY_BOOTSTRAP_ADMIN_GROUP?.trim() || null;
  await client.query(
    `with reviewers as (
       select distinct u.id
         from role_mappings rm
         join group_memberships gm on gm.group_id = rm.group_id
         join users u on u.id = gm.user_id
        where u.status = 'active'
          and (rm.role = 'platform_admin' or (rm.role = 'namespace_admin' and rm.namespace_id = $1))
       union
       select u.id
         from groups g
         join group_memberships gm on gm.group_id = g.id
         join users u on u.id = gm.user_id
        where u.status = 'active' and $4::text is not null and g.entra_object_id = $4
     )
     insert into notifications (user_id, type, payload)
     select id, 'proposal.needs_review', $2::jsonb from reviewers where id <> $3`,
    [input.namespaceId, JSON.stringify({ proposalId: input.proposalId, skillSlug: input.skillSlug, semver: input.semver }), input.submitterId, bootstrap],
  );
}

export async function createProposal(pool: Pool, input: CreateProposalInput): Promise<{ id: string }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      // origin_request_id: set when the proposal was started from a skill request's "Propose a
      // skill" button (§26) — the explicit fulfilment link, advisory until acceptance.
      `insert into proposals (target_namespace_id, target_skill_id, proposed_semver, state, submitted_by, origin_request_id)
       values ($1,$2,$3,'proposed',$4,$5) returning id`,
      [input.targetNamespaceId, input.targetSkillId ?? null, input.proposedSemver, input.submittedByUserId, input.originRequestId ?? null],
    );
    const proposalId = rows[0]!.id;
    await client.query(
      `insert into proposal_revisions (proposal_id, revision_no, payload, author, note)
       values ($1, 1, $2::jsonb, $3, 'initial submission')`,
      [proposalId, JSON.stringify(input.payload), input.submittedByUserId],
    );
    await appendAudit(client, {
      actorUserId: input.submittedByUserId,
      action: "proposal.created",
      targetType: "proposal",
      targetId: proposalId,
      namespaceId: input.targetNamespaceId,
      after: { state: "proposed", semver: input.proposedSemver },
    });
    await notifyProposalCreated(client, {
      proposalId,
      namespaceId: input.targetNamespaceId,
      submitterId: input.submittedByUserId,
      skillSlug: input.payload.metadata.skillSlug,
      semver: input.proposedSemver,
    });
    await client.query("commit");
    M.proposalsCreated.inc();
    return { id: proposalId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

interface ProposalRow {
  id: string;
  target_namespace_id: string;
  target_skill_id: string | null;
  proposed_semver: string;
  state: ProposalState;
  submitted_by: string;
  origin_request_id: string | null;
}

async function loadProposal(db: Pool | PoolClient, id: string): Promise<ProposalRow | null> {
  const { rows } = await db.query<ProposalRow>(
    `select id, target_namespace_id, target_skill_id, proposed_semver, state, submitted_by, origin_request_id
       from proposals where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function latestPayload(db: Pool | PoolClient, proposalId: string): Promise<RevisionPayload> {
  const { rows } = await db.query<{ payload: RevisionPayload }>(
    `select payload from proposal_revisions where proposal_id = $1 order by revision_no desc limit 1`,
    [proposalId],
  );
  if (!rows[0]) throw new Error("proposal has no revisions");
  return rows[0].payload;
}

export interface ActionInput {
  proposalId: string;
  action: ProposalAction;
  actorUserId: string;
  access: EffectiveAccess;
  /** decision reason (reject) or change request note */
  note?: string | null;
  /** new revision payload (resubmit, or reviewer edit before accept) */
  newPayload?: RevisionPayload;
  /** updated proposed semver (proposer resubmit only — §8); validated strictly-increasing at accept. */
  newSemver?: string | null;
  /** explicit reviewer override required to accept over high/critical scan findings (§9) */
  override?: boolean;
  overrideReason?: string | null;
}

export type ActionResult =
  | { ok: true; state: ProposalState; materializedVersionId?: string }
  | { ok: false; status: number; error: string; requiresOverride?: boolean; severity?: string };

/** Latest revision's artifact scan severity + findings, for the override gate. */
async function loadArtifactScan(
  db: PoolClient,
  proposalId: string,
): Promise<{ severity: string | null; findings: unknown } | null> {
  const { rows: rev } = await db.query<{ payload: RevisionPayload }>(
    `select payload from proposal_revisions where proposal_id = $1 order by revision_no desc limit 1`,
    [proposalId],
  );
  const key = rev[0]?.payload.artifactObjectKey;
  if (!key) return null;
  const { rows } = await db.query<{ severity: string | null; findings: unknown }>(
    `select severity, findings from scan_reports where subject_type = 'artifact' and subject_id = $1 order by created_at desc limit 1`,
    [key],
  );
  return rows[0] ?? null;
}

export async function performProposalAction(pool: Pool, input: ActionInput): Promise<ActionResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const p = await loadProposal(client, input.proposalId);
    if (!p) {
      await client.query("rollback");
      return { ok: false, status: 404, error: "proposal not found" };
    }

    const caps = {
      isReviewer: canReviewNamespace(input.access, p.target_namespace_id),
      isSubmitter: p.submitted_by === input.actorUserId,
    };
    const decision = canPerform(input.action, p.state, caps);
    if (!decision.ok) {
      await client.query("rollback");
      return { ok: false, status: 403, error: decision.reason };
    }

    // Optionally append a new revision (resubmit / reviewer edit).
    if (input.newPayload) {
      await client.query(
        `insert into proposal_revisions (proposal_id, revision_no, payload, author, note)
         select $1, coalesce(max(revision_no),0)+1, $2::jsonb, $3, $4 from proposal_revisions where proposal_id = $1`,
        [input.proposalId, JSON.stringify(input.newPayload), input.actorUserId, input.note ?? null],
      );
    }

    let materializedVersionId: string | undefined;
    if (input.action === "accept") {
      // Override gate: high/critical scan findings require an explicit, logged decision.
      const scan = await loadArtifactScan(client, input.proposalId);
      if (scan && requiresOverride(scan.severity as never)) {
        if (!input.override) {
          await client.query("rollback");
          return {
            ok: false,
            status: 409,
            error: `scan findings (severity ${scan.severity}) require an explicit override to accept`,
            requiresOverride: true,
            severity: scan.severity ?? undefined,
          };
        }
        await appendAudit(client, {
          actorUserId: input.actorUserId,
          action: "proposal.scan_override",
          targetType: "proposal",
          targetId: input.proposalId,
          namespaceId: p.target_namespace_id,
          after: { severity: scan.severity, reason: input.overrideReason ?? null, findings: scan.findings },
        });
      }
      const payload = await latestPayload(client, input.proposalId);
      const result = await materializeVersion(client, {
        targetNamespaceId: p.target_namespace_id,
        targetSkillId: p.target_skill_id,
        semver: p.proposed_semver,
        submittedBy: p.submitted_by,
        payload,
      });
      materializedVersionId = result.versionId; // undefined for pointer (worker mirrors it)
      // Skill-request fulfilment (§26): a proposal started from a request fulfils it on
      // acceptance — same transaction, first accepted linked proposal wins (stale links no-op).
      // Credit goes to the proposal's SUBMITTER (the fulfiller), not the accepting reviewer.
      if (p.origin_request_id) {
        await fulfilOriginRequest(client, {
          originRequestId: p.origin_request_id,
          skillId: result.skillId,
          fulfilledByUserId: p.submitted_by,
          actorUserId: input.actorUserId,
          via: "proposal",
        });
      }
    }

    // Proposer resubmit may also revise the proposed semver (§8); only honored on resubmit.
    const newSemver = input.action === "resubmit" ? input.newSemver ?? null : null;
    await client.query(
      `update proposals
          set state = $2,
              decision_reason = coalesce($3, decision_reason),
              materialized_version_id = coalesce($4, materialized_version_id),
              proposed_semver = coalesce($5, proposed_semver),
              updated_at = now()
        where id = $1`,
      [input.proposalId, decision.to, input.note ?? null, materializedVersionId ?? null, newSemver],
    );

    await appendAudit(client, {
      actorUserId: input.actorUserId,
      action: `proposal.${input.action}`,
      targetType: "proposal",
      targetId: input.proposalId,
      namespaceId: p.target_namespace_id,
      before: { state: p.state },
      after: { state: decision.to, materializedVersionId },
    });

    // Notify the submitter of the outcome.
    await client.query(
      `insert into notifications (user_id, type, payload)
       values ($1, $2, $3::jsonb)`,
      [p.submitted_by, `proposal.${input.action}`, JSON.stringify({ proposalId: input.proposalId, state: decision.to, note: input.note ?? null })],
    );

    // On resubmit, alert the namespace's reviewers that it's back and needs another look (§8) —
    // the submitter outcome notification above only reaches the proposer.
    if (input.action === "resubmit") {
      const pl = await latestPayload(client, input.proposalId);
      await notifyReviewersNeedsReview(client, {
        proposalId: input.proposalId,
        namespaceId: p.target_namespace_id,
        submitterId: p.submitted_by,
        skillSlug: pl.metadata.skillSlug,
        semver: newSemver ?? p.proposed_semver,
      });
    }

    await client.query("commit");
    M.proposalActions.inc({ action: input.action });
    return { ok: true, state: decision.to, materializedVersionId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export type DeleteProposalResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Permanently delete a proposal — reviewer housekeeping (spam / duplicates / test / mistakes),
 * distinct from `reject` (a recorded, submitter-notified decision that keeps the row). Silent (no
 * submitter notification), audited (`proposal.deleted`). Deletable in every state EXCEPT `accepted`
 * (an accepted proposal is the provenance of a live, immutable skill_version — locked; remove the
 * skill/version itself instead, §7). Authority = reviewer of the target namespace (namespace admin
 * there, or any platform admin). One transaction removes the proposal (revisions cascade) and
 * hand-cleans the polymorphic, no-FK dependents exactly like deleteSkill: the review-discussion
 * conversation (messages + participants cascade) + its message.new alerts, the proposal's pointer
 * scan reports (hosted-artifact scans keyed to the object key are shared with any eventual version —
 * left intact), and any dangling proposal.* notifications. audit_log is preserved (invariant #5).
 * SKILLY_SPEC.md §8.
 */
export async function deleteProposal(
  pool: Pool,
  input: { proposalId: string; actorUserId: string; access: EffectiveAccess },
): Promise<DeleteProposalResult> {
  const p = await loadProposal(pool, input.proposalId);
  if (!p) return { ok: false, status: 404, error: "proposal not found" };
  if (!canReviewNamespace(input.access, p.target_namespace_id)) {
    return { ok: false, status: 403, error: "only a reviewer of this proposal's namespace may delete it" };
  }
  if (p.state === "accepted") {
    return { ok: false, status: 409, error: "an accepted proposal can't be deleted — it's the provenance of a published version; delete the skill/version instead" };
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    // Review-discussion conversation (polymorphic context, no FK — won't cascade): delete it
    // (messages + participants cascade) and the dangling message.new alerts pointing at it, so no
    // "@null/?" orphan thread lingers in the messages UI (§24, migration 0037's original bug).
    const { rows: convs } = await client.query<{ id: string }>(
      `delete from conversations where subject_type = 'proposal' and subject_id = $1 returning id`,
      [input.proposalId],
    );
    const convIds = convs.map((c) => c.id);
    if (convIds.length) {
      await client.query(
        `delete from notifications where type = 'message.new' and payload->>'conversationId' = any($1::text[])`,
        [convIds],
      );
    }
    // Pointer pre-scan reports keyed to the proposal (hosted-artifact scans are keyed to the object
    // key and shared with any eventual version — left intact).
    await client.query(`delete from scan_reports where subject_type = 'proposal' and subject_id = $1`, [input.proposalId]);
    // Dangling proposal.* alerts (needs_review / submitted / accept / reject / …) — they'd 404.
    await client.query(`delete from notifications where payload->>'proposalId' = $1`, [input.proposalId]);
    // The proposal itself — proposal_revisions cascade (FK ON DELETE CASCADE).
    await client.query(`delete from proposals where id = $1`, [input.proposalId]);
    await appendAudit(client, {
      actorUserId: input.actorUserId,
      action: "proposal.deleted",
      targetType: "proposal",
      targetId: input.proposalId,
      namespaceId: p.target_namespace_id,
      before: { state: p.state, semver: p.proposed_semver, submittedBy: p.submitted_by },
    });
    await client.query("commit");
    return { ok: true };
  } catch (e) {
    await client.query("rollback");
    return { ok: false, status: 500, error: (e as Error).message };
  } finally {
    client.release();
  }
}

export interface MaterializeInput {
  targetNamespaceId: string;
  targetSkillId: string | null;
  semver: string;
  submittedBy: string;
  payload: RevisionPayload;
}
export interface MaterializeResult {
  skillId: string;
  /** set for hosted (version inserted now); undefined for pointer (worker mirrors it) */
  versionId?: string;
  pendingMirror?: boolean;
}

/**
 * Create the skill (if new) + the new version from a payload. HOSTED inserts an immutable
 * skill_version referencing the stored artifact (publish sweep synthesizes the git tag).
 * POINTER enqueues a pending_mirror (the worker clones the pinned ref, scans, then inserts
 * the version). Reused by proposal-accept, direct-publish, and promotion. SKILLY_SPEC.md §6,§8.
 */
export async function materializeVersion(client: PoolClient, input: MaterializeInput): Promise<MaterializeResult> {
  const { payload } = input;
  const meta = payload.metadata;
  const isPointer = !!payload.pointer;

  let skillId = input.targetSkillId;
  if (!skillId) {
    const { rows } = await client.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, tags, type, visibility, promoted_from_skill_version_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning id`,
      [
        input.targetNamespaceId,
        meta.skillSlug,
        meta.title,
        meta.description,
        meta.toolHarness,
        meta.tags ?? [],
        isPointer ? "pointer" : "hosted",
        meta.visibility,
        payload.promotedFromSkillVersionId ?? null,
      ],
    );
    skillId = rows[0]!.id;
    // Categories are multi-valued tags; created on the fly and linked via skill_categories.
    await syncCategories(client, skillId, meta.categories ?? []);
    // The submitter becomes the first explicit maintainer of a brand-new skill (if eligible). §19.
    await autoAddSubmitter(client, { id: skillId, namespaceId: input.targetNamespaceId, visibility: meta.visibility }, input.submittedBy);
  } else {
    // New version of an EXISTING skill: sync every skill-level field a re-version may change
    // (§8) — title, description, categories, tags, and tool/harness — to the submitted values.
    // Each is guarded (coalesce / `!== undefined`) so a caller that omits one leaves the skill's
    // existing value untouched; the update re-fires the FTS trigger so search stays current.
    // VISIBILITY stays frozen (a skill-management action, never a re-version); the slug is
    // immutable, period. Applies on accept regardless of channel — a prerelease re-version still
    // updates the skill-level metadata even though `latest` never moves.
    if (meta.categories !== undefined) await syncCategories(client, skillId, meta.categories);
    await client.query(
      `update skills
          set title        = coalesce($2, title),
              description  = coalesce($3, description),
              tool_harness = coalesce($4, tool_harness),
              tags         = coalesce($5::text[], tags)
        where id = $1`,
      [
        skillId,
        meta.title?.trim() || null, // never wipe a title to blank
        meta.description !== undefined ? meta.description : null,
        meta.toolHarness?.trim() || null,
        meta.tags ?? null, // [] is meaningful (clears tags); only undefined keeps the current value
      ],
    );
    // Version-acceptance maintainer auto-add (§19): gated against the skill's CURRENT
    // namespace/visibility — never touched by a re-version (visibility stays frozen above) — not
    // the submitted payload's meta.visibility, which only ever applies to a brand-new skill.
    const { rows: curRows } = await client.query<{ namespace_id: string; visibility: "org" | "namespace" }>(
      `select namespace_id, visibility from skills where id = $1`,
      [skillId],
    );
    const cur = curRows[0]!;
    await autoAddSubmitterOnNewVersion(client, { id: skillId, namespaceId: cur.namespace_id, visibility: cur.visibility }, input.submittedBy);
  }

  const isPrerelease = channelOf(input.semver) !== "stable";

  if (isPointer) {
    // Enqueue a mirror; the worker inserts the immutable version after cloning + scanning.
    await client.query(
      `insert into pending_mirrors (skill_id, semver, external_url, external_ref, external_subdir, is_prerelease, usage_examples, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (skill_id, semver) do nothing`,
      [skillId, input.semver, payload.pointer!.url, payload.pointer!.ref, payload.pointer!.subdir?.trim() || null, isPrerelease, meta.usageExamples ?? null, input.submittedBy],
    );
    return { skillId, pendingMirror: true };
  }

  // Hosted (or a "Keep current files" reuse, §8 — the artifact is already in storage, so it
  // inserts directly whatever the skill's delivery type; a pointer reuse carries its external
  // provenance onto the row WITHOUT a pending_mirrors round-trip). Enforce strictly-increasing
  // immutable semver, then insert the version; the publish sweep synthesizes the git tag.
  const ext = payload.reuse?.external ?? null;
  const { rows: existing } = await client.query<{ semver: string }>(`select semver from skill_versions where skill_id = $1`, [skillId]);
  assertStrictlyIncreasing(input.semver, existing.map((r) => r.semver));
  const { rows: vrows } = await client.query<{ id: string }>(
    `insert into skill_versions
       (skill_id, semver, is_prerelease, status, usage_examples, artifact_object_key, artifact_sha256, artifact_filename, content_sha256,
        external_origin_url, external_ref, external_subdir, created_by, git_published)
     values ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11,$12,false)
     returning id`,
    [
      skillId, input.semver, isPrerelease, meta.usageExamples ?? null,
      payload.artifactObjectKey, payload.artifactSha256, payload.artifactFilename ?? null, payload.contentSha256 ?? null,
      ext?.url ?? null, ext?.ref ?? null, ext?.subdir?.trim() || null,
      input.submittedBy,
    ],
  );
  return { skillId, versionId: vrows[0]!.id };
}

/**
 * Direct publish (no review) — only when the namespace has require_review=false AND the
 * caller is a Member/Admin there. Reuses materializeVersion. SKILLY_SPEC.md §4.
 */
export async function directPublish(
  pool: Pool,
  input: { access: EffectiveAccess; actorUserId: string; namespaceSlug: string; semver: string; payload: RevisionPayload; originRequestId?: string | null },
): Promise<{ ok: true; skillId: string; versionId?: string; pending?: boolean } | { ok: false; status: number; error: string }> {
  const ns = (await pool.query<{ id: string; require_review: boolean }>(`select id, require_review from namespaces where slug = $1`, [input.namespaceSlug])).rows[0];
  if (!ns) return { ok: false, status: 404, error: "namespace not found" };
  if (!canDirectPublish(input.access, ns.id, ns.require_review)) {
    return { ok: false, status: 403, error: "direct publish not permitted here — submit a proposal for review instead" };
  }
  const existing = (await pool.query<{ id: string }>(`select id from skills where namespace_id = $1 and slug = $2`, [ns.id, input.payload.metadata.skillSlug])).rows[0];

  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await materializeVersion(client, {
      targetNamespaceId: ns.id,
      targetSkillId: existing?.id ?? null,
      semver: input.semver,
      submittedBy: input.actorUserId,
      payload: input.payload,
    });
    await appendAudit(client, {
      actorUserId: input.actorUserId,
      action: "skill.published",
      targetType: "skill",
      targetId: result.skillId,
      namespaceId: ns.id,
      after: { semver: input.semver, slug: input.payload.metadata.skillSlug, pending: result.pendingMirror ?? false },
    });
    // Skill-request fulfilment (§26): a direct publish IS an immediate acceptance — same as the
    // review-accept path, fulfil any request this was started from, in the same transaction.
    if (input.originRequestId) {
      await fulfilOriginRequest(client, {
        originRequestId: input.originRequestId,
        skillId: result.skillId,
        fulfilledByUserId: input.actorUserId,
        actorUserId: input.actorUserId,
        via: "direct_publish",
      });
    }
    await client.query("commit");
    return { ok: true, skillId: result.skillId, versionId: result.versionId, pending: result.pendingMirror };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Promote a skill into the `global` namespace by creating a proposal there (always reviewed
 * by platform admins). Any member of the owning namespace may initiate. The new global skill
 * reuses the source artifact / external ref and records provenance. SKILLY_SPEC.md §8.
 */
export async function promoteToGlobal(
  pool: Pool,
  input: { access: EffectiveAccess; actorUserId: string; sourceNamespaceSlug: string; sourceSkillSlug: string },
): Promise<{ ok: true; proposalId: string } | { ok: false; status: number; error: string }> {
  const skill = (
    await pool.query<{
      id: string; namespace_id: string; slug: string; title: string; description: string;
      tool_harness: string; tags: string[]; categories: string[];
    }>(
      `select s.id, s.namespace_id, s.slug, s.title, s.description, s.tool_harness, s.tags,
              coalesce((select array_agg(c.name order by c.name)
                          from skill_categories sc join categories c on c.id = sc.category_id
                         where sc.skill_id = s.id), '{}') as categories
         from skills s join namespaces n on n.id = s.namespace_id
        where n.slug = $1 and s.slug = $2 and s.status = 'active'`,
      [input.sourceNamespaceSlug, input.sourceSkillSlug],
    )
  ).rows[0];
  if (!skill) return { ok: false, status: 404, error: "skill not found" };
  if (input.sourceNamespaceSlug === "global") return { ok: false, status: 422, error: "skill is already global" };
  if (!canInitiatePromotion(input.access, skill.namespace_id)) {
    return { ok: false, status: 403, error: "only a member of the owning namespace may promote it" };
  }

  const vers = (
    await pool.query<{ id: string; semver: string; artifact_object_key: string | null; artifact_sha256: string | null; content_sha256: string | null; external_ref: string | null; external_origin_url: string | null; external_subdir: string | null; usage_examples: string | null }>(
      `select id, semver, artifact_object_key, artifact_sha256, content_sha256, external_ref, external_origin_url, external_subdir, usage_examples
         from skill_versions where skill_id = $1 and status = 'active'`,
      [skill.id],
    )
  ).rows;
  const latest = resolveLatest(vers.map((v) => v.semver));
  if (!latest) return { ok: false, status: 409, error: "skill has no published stable version to promote" };
  const lv = vers.find((v) => v.semver === latest)!;

  const globalNs = (await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`)).rows[0]!;
  const existingGlobal = (await pool.query<{ id: string }>(`select id from skills where namespace_id = $1 and slug = $2`, [globalNs.id, skill.slug])).rows[0];

  const metadata: ProposalMetadata = {
    skillSlug: skill.slug,
    title: skill.title,
    description: skill.description,
    categories: skill.categories ?? [],
    toolHarness: skill.tool_harness,
    tags: skill.tags,
    usageExamples: lv.usage_examples,
    visibility: "org",
  };
  const payload: RevisionPayload = lv.external_ref
    ? { metadata, pointer: { url: lv.external_origin_url!, ref: lv.external_ref, subdir: lv.external_subdir }, promotedFromSkillVersionId: lv.id }
    : { metadata, artifactObjectKey: lv.artifact_object_key ?? undefined, artifactSha256: lv.artifact_sha256 ?? undefined, contentSha256: lv.content_sha256 ?? undefined, promotedFromSkillVersionId: lv.id };

  const { id } = await createProposal(pool, {
    submittedByUserId: input.actorUserId,
    targetNamespaceId: globalNs.id,
    targetSkillId: existingGlobal?.id ?? null,
    proposedSemver: latest,
    payload,
  });
  return { ok: true, proposalId: id };
}

export interface ReviewQueueItem {
  id: string;
  state: ProposalState;
  proposedSemver: string;
  isNewSkill: boolean;
  namespaceSlug: string;
  /** Skill identity: from the existing skill (new version) or the latest revision (new skill). */
  skillSlug: string | null;
  title: string | null;
  /** When the proposal was submitted (UTC ISO) + who submitted it. */
  createdAt: string;
  submittedBy: string;
}

interface QueueRow {
  id: string;
  state: ProposalState;
  proposed_semver: string;
  target_skill_id: string | null;
  namespace_slug: string;
  skill_slug: string | null;
  title: string | null;
  created_at: string;
  /** Full-microsecond UTC rendering of created_at, for the keyset cursor (review queue only). */
  created_at_us: string;
  submitted_by_name: string;
}

// Resolve a display name even for not-yet-materialized skills by reading the latest revision.
// `created_at_us` is the full-microsecond UTC rendering of created_at used for the keyset cursor
// (the JS driver truncates timestamptz to milliseconds, which would make the cursor lossy).
const QUEUE_BASE_SELECT = `
    select p.id, p.state, p.proposed_semver, p.target_skill_id, p.created_at, n.slug as namespace_slug,
           to_char(p.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_us,
           coalesce(s.slug,  lr.payload->'metadata'->>'skillSlug') as skill_slug,
           coalesce(s.title, lr.payload->'metadata'->>'title')     as title,
           su.display_name as submitted_by_name
      from proposals p
      join namespaces n on n.id = p.target_namespace_id
      join users su on su.id = p.submitted_by
      left join skills s on s.id = p.target_skill_id
      left join lateral (
        select payload from proposal_revisions where proposal_id = p.id order by revision_no desc limit 1
      ) lr on true`;

function toQueueItem(r: QueueRow): ReviewQueueItem {
  return {
    id: r.id,
    state: r.state,
    proposedSemver: r.proposed_semver,
    isNewSkill: r.target_skill_id == null,
    namespaceSlug: r.namespace_slug,
    skillSlug: r.skill_slug,
    title: r.title,
    createdAt: r.created_at,
    submittedBy: r.submitted_by_name,
  };
}

/** True if the caller has review authority anywhere (platform admin or any namespace admin). */
export function hasReviewScope(access: EffectiveAccess): boolean {
  return access.isPlatformAdmin || [...access.namespaceRoles.values()].includes("namespace_admin");
}

/** Batch size for the review queue's server-side pagination / infinite scroll (§8). */
export const REVIEW_PAGE_SIZE = 100;

const PROPOSAL_STATES: ProposalState[] = ["proposed", "under_review", "changes_requested", "accepted", "rejected"];
function emptyStateCounts(): Record<ProposalState, number> {
  return { proposed: 0, under_review: 0, changes_requested: 0, accepted: 0, rejected: 0 };
}

export interface ReviewQueuePage {
  items: ReviewQueueItem[];
  /** Opaque cursor for the next batch (`created_at_us|id`); null when there are no more. */
  nextCursor: string | null;
  /** Per-state totals across the caller's FULL review scope — independent of filter/cursor. */
  counts: Record<ProposalState, number>;
  /** Sum of `counts` (every proposal in scope, all states). */
  total: number;
}

/**
 * Reviewer queue: proposals the caller may review, scoped to their namespaces, **newest-first**
 * and **paginated** (a batch of `REVIEW_PAGE_SIZE`) so the UI can infinite-scroll any backlog (§8).
 * State filtering happens HERE (server-side) so each batch is N *matching* proposals — never N raw
 * rows then thinned client-side, which would make batches arrive partial/empty. `counts` is computed
 * over the unfiltered scope so the filter chips show real totals regardless of the active filter.
 */
export async function listReviewQueue(
  pool: Pool,
  access: EffectiveAccess,
  opts: { states?: readonly string[]; cursor?: string | null; limit?: number } = {},
): Promise<ReviewQueuePage> {
  const limit = Math.min(Math.max(opts.limit ?? REVIEW_PAGE_SIZE, 1), REVIEW_PAGE_SIZE);

  // Scope: platform admins review everything; otherwise only namespaces the caller administers.
  const scopeConds: string[] = [];
  const scopeParams: unknown[] = [];
  if (!access.isPlatformAdmin) {
    const nsIds = [...access.namespaceRoles.entries()].filter(([, r]) => r === "namespace_admin").map(([id]) => id);
    if (nsIds.length === 0) return { items: [], nextCursor: null, counts: emptyStateCounts(), total: 0 };
    scopeParams.push(nsIds);
    scopeConds.push(`p.target_namespace_id = any($${scopeParams.length})`);
  }

  // Page query = scope + optional state filter + keyset cursor, NEWEST first.
  const conds = [...scopeConds];
  const params = [...scopeParams];
  const states = (opts.states ?? []).filter((s): s is ProposalState => (PROPOSAL_STATES as string[]).includes(s));
  if (states.length) {
    params.push(states);
    conds.push(`p.state = any($${params.length})`);
  }
  if (opts.cursor) {
    const sep = opts.cursor.lastIndexOf("|");
    if (sep > 0) {
      params.push(opts.cursor.slice(0, sep));
      const a = params.length;
      params.push(opts.cursor.slice(sep + 1));
      const b = params.length;
      // Strictly older than the cursor in (created_at desc, id desc) order — row-value comparison.
      conds.push(`(p.created_at, p.id) < ($${a}::timestamptz, $${b}::uuid)`);
    }
  }
  params.push(limit + 1); // +1 sentinel row tells us whether another batch exists.
  const where = conds.length ? `where ${conds.join(" and ")}` : "";
  const { rows } = await pool.query<QueueRow>(
    `${QUEUE_BASE_SELECT} ${where} order by p.created_at desc, p.id desc limit $${params.length}`,
    params,
  );
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  const nextCursor = hasMore && last ? `${last.created_at_us}|${last.id}` : null;

  // Per-state totals across the full reviewer scope (no state filter, no cursor) for the chips.
  const scopeWhere = scopeConds.length ? `where ${scopeConds.join(" and ")}` : "";
  const { rows: countRows } = await pool.query<{ state: ProposalState; n: string }>(
    `select p.state, count(*)::text as n from proposals p ${scopeWhere} group by p.state`,
    scopeParams,
  );
  const counts = emptyStateCounts();
  let total = 0;
  for (const r of countRows) {
    counts[r.state] = Number(r.n);
    total += Number(r.n);
  }

  return { items: pageRows.map(toQueueItem), nextCursor, counts, total };
}

/** A user's own submissions, all states, across all namespaces — NEWEST first (personal history,
 *  unlike the review queue's oldest-first action ordering). Powers the "Mine" tab (§8). */
export async function listMySubmissions(pool: Pool, userId: string): Promise<ReviewQueueItem[]> {
  const rows = (await pool.query<QueueRow>(`${QUEUE_BASE_SELECT} where p.submitted_by = $1 order by p.created_at desc`, [userId])).rows;
  return rows.map(toQueueItem);
}

/** sha256 hex of bundle bytes (used by the upload endpoint when recording the artifact). */
export function bundleSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ProposalRevisionView {
  revisionNo: number;
  payload: RevisionPayload;
  author: string;
  note: string | null;
  createdAt: string;
}

export interface ProposalDetail {
  id: string;
  state: ProposalState;
  targetNamespaceId: string;
  targetNamespaceSlug: string;
  targetSkillId: string | null;
  proposedSemver: string;
  submittedBy: string;
  decisionReason: string | null;
  materializedVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  revisions: ProposalRevisionView[];
  scanReport: { severity: string | null; status: string; findings: unknown; createdAt: string } | null;
  caps: { isReviewer: boolean; isSubmitter: boolean };
  allowedActions: ProposalAction[];
  /**
   * Set when this NEW-skill proposal duplicates an existing skill the VIEWER can see (§8) — the
   * review page warns and links to it. Evaluated at the viewer's visibility, so a reviewer may see
   * a duplicate the proposer couldn't (and was therefore allowed to submit). Null for new versions.
   */
  duplicate: DuplicateMatch | null;
  /**
   * NEW-VERSION proposals only: the target skill's CURRENT state (skill-level metadata + the
   * latest stable version's usage), so the review page can show an explicit old → new diff of
   * what accepting would change (§8). Null for new-skill proposals.
   */
  targetSkillCurrent: TargetSkillCurrent | null;
}

/** The target skill's live state, for the review page's old → new metadata diff (§8). */
export interface TargetSkillCurrent {
  title: string;
  description: string;
  toolHarness: string;
  tags: string[];
  categories: string[];
  /** The latest stable version's usage examples (the re-version baseline); null if none. */
  usageExamples: string | null;
  /** Latest stable semver — what "Keep current files" reuses; null when nothing stable is live. */
  latestStable: string | null;
}

/**
 * Full proposal view for the detail page / review dashboard, including revisions and the
 * ingest-time scan report (looked up by the latest revision's artifact key). Returns null
 * if the proposal does not exist OR the caller may not view it (reviewer or submitter only)
 * — callers should 404 either way to avoid leaking existence of restricted proposals.
 */
export async function getProposalDetail(
  pool: Pool,
  id: string,
  access: EffectiveAccess,
  actorUserId: string,
): Promise<ProposalDetail | null> {
  const { rows } = await pool.query<{
    id: string;
    state: ProposalState;
    target_namespace_id: string;
    namespace_slug: string;
    target_skill_id: string | null;
    proposed_semver: string;
    submitted_by: string;
    decision_reason: string | null;
    materialized_version_id: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `select p.id, p.state, p.target_namespace_id, n.slug as namespace_slug, p.target_skill_id,
            p.proposed_semver, p.submitted_by, p.decision_reason, p.materialized_version_id,
            p.created_at, p.updated_at
       from proposals p join namespaces n on n.id = p.target_namespace_id
      where p.id = $1`,
    [id],
  );
  const p = rows[0];
  if (!p) return null;

  const caps = {
    isReviewer: canReviewNamespace(access, p.target_namespace_id),
    isSubmitter: p.submitted_by === actorUserId,
  };
  if (!caps.isReviewer && !caps.isSubmitter) return null; // not authorized to view

  const { rows: revRows } = await pool.query<{
    revision_no: number;
    payload: RevisionPayload;
    author: string;
    note: string | null;
    created_at: string;
  }>(
    `select revision_no, payload, author, note, created_at
       from proposal_revisions where proposal_id = $1 order by revision_no asc`,
    [id],
  );
  const revisions = revRows.map((r) => ({
    revisionNo: r.revision_no,
    payload: r.payload,
    author: r.author,
    note: r.note,
    createdAt: r.created_at,
  }));

  // Scan report. Hosted: keyed to the uploaded artifact (recorded at upload, pre-accept).
  // Pointer: keyed to the proposal by the worker's pre-scan loop (no artifact exists pre-accept);
  // until that runs it's reported as `pending` so the UI doesn't say a misleading "not scanned".
  let scanReport: ProposalDetail["scanReport"] = null;
  const latest = revisions.at(-1);
  const latestKey = latest?.payload.artifactObjectKey;
  if (latestKey) {
    const { rows: srows } = await pool.query<{ severity: string | null; status: string; findings: unknown; created_at: string }>(
      `select severity, status, findings, created_at from scan_reports
        where subject_type = 'artifact' and subject_id = $1 order by created_at desc limit 1`,
      [latestKey],
    );
    if (srows[0]) scanReport = { severity: srows[0].severity, status: srows[0].status, findings: srows[0].findings, createdAt: srows[0].created_at };
  } else if (latest?.payload.pointer) {
    const { rows: srows } = await pool.query<{ severity: string | null; status: string; findings: unknown; created_at: string }>(
      `select severity, status, findings, created_at from scan_reports
        where subject_type = 'proposal' and subject_id = $1 order by created_at desc limit 1`,
      [p.id],
    );
    scanReport = srows[0]
      ? { severity: srows[0].severity, status: srows[0].status, findings: srows[0].findings, createdAt: srows[0].created_at }
      : { severity: null, status: "pending", findings: [], createdAt: p.created_at };
  }

  const allowedActions = (Object.keys(TRANSITIONS) as ProposalAction[]).filter(
    (a) => canPerform(a, p.state, caps).ok,
  );

  // Duplicate alert (§8): only for NEW-skill proposals, evaluated at the VIEWER's visibility so a
  // reviewer is warned even about a duplicate the proposer couldn't see (and was allowed to submit).
  let duplicate: DuplicateMatch | null = null;
  {
    const lp = latest?.payload;
    if (lp) {
      // New skill: full identity. New version: content-only, excluding the target skill (it
      // legitimately reuses its own identity) — flags only content identical to a DIFFERENT skill.
      duplicate = await findDuplicateSkill(
        access,
        p.target_skill_id
          ? { contentSha256: lp.contentSha256, excludeSkillId: p.target_skill_id }
          : {
              slug: lp.metadata?.skillSlug,
              pointer: lp.pointer ? { url: lp.pointer.url, subdir: lp.pointer.subdir } : null,
              contentSha256: lp.contentSha256,
            },
        pool,
      );
    }
  }

  // New-version proposals: the target skill's current state, for the review page's
  // old → new diff of what accepting would change (§8).
  let targetSkillCurrent: TargetSkillCurrent | null = null;
  if (p.target_skill_id) {
    const { rows: srows } = await pool.query<{
      title: string; description: string; tool_harness: string; tags: string[] | null; categories: string[] | null;
    }>(
      `select s.title, s.description, s.tool_harness, s.tags,
              coalesce((select array_agg(c.name order by c.name) from skill_categories sc
                          join categories c on c.id = sc.category_id
                         where sc.skill_id = s.id), '{}') as categories
         from skills s where s.id = $1`,
      [p.target_skill_id],
    );
    const s = srows[0];
    if (s) {
      const { rows: vrows } = await pool.query<{ semver: string; usage_examples: string | null }>(
        `select semver, usage_examples from skill_versions where skill_id = $1 and status = 'active'`,
        [p.target_skill_id],
      );
      const latestStable = resolveLatest(vrows.map((v) => v.semver));
      targetSkillCurrent = {
        title: s.title,
        description: s.description,
        toolHarness: s.tool_harness,
        tags: s.tags ?? [],
        categories: s.categories ?? [],
        usageExamples: latestStable ? vrows.find((v) => v.semver === latestStable)?.usage_examples ?? null : null,
        latestStable,
      };
    }
  }

  return {
    id: p.id,
    state: p.state,
    targetNamespaceId: p.target_namespace_id,
    targetNamespaceSlug: p.namespace_slug,
    targetSkillId: p.target_skill_id,
    proposedSemver: p.proposed_semver,
    submittedBy: p.submitted_by,
    decisionReason: p.decision_reason,
    materializedVersionId: p.materialized_version_id,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    revisions,
    scanReport,
    caps,
    allowedActions,
    duplicate,
    targetSkillCurrent,
  };
}
