// The §29 MCP write paths: proposals, review-thread and discussion messages, ratings and skill
// requests. Everything an AGENT can create on its user's behalf.
//
// Three rules hold across every function here:
//   1. AUTHORITY IS THE USER'S. Nothing in this file grants access the caller doesn't already have;
//      the visibility/RBAC decision always comes from the shared helpers before we get here.
//   2. THE MARKER IS WRITTEN. Every row carries `via_mcp_client` = the registered client's name, so
//      a human reading a proposal, message, rating or request can see how it arrived (§29). Audit
//      rows are written with `source = 'mcp'`.
//   3. NO REVIEW DECISIONS. There is no accept/reject/request-changes path in this file, and no
//      direct publish. An agent may author and revise; a human decides. This closes the
//      author-and-self-approve hole (§29 Excluded surface) at the code level, not in a doc.
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  MAX_MENTIONS_PER_MESSAGE,
  PURE_SCANNERS,
  WHAT_CHANGED_MAX_LEN,
  bundleContentCap,
  canPerform,
  canReviewNamespace,
  contentDigest,
  extractMentions,
  isAllowedToolHarness,
  isSkillsHubUrl,
  maxSeverity,
  nextState,
  normalizeHarness,
  normalizeOriginUrl,
  normalizeSubdir,
  parseSemver,
  runScanners,
  validateBundle,
  validateGitRef,
  validatePointerUrl,
  validateSkillsHubRef,
  validateSubdir,
  type EffectiveAccess,
  type ProposalAction,
  type ProposalState,
} from "@skilly/shared";
import { s3ArtifactStore } from "../storage/objectStore.js";
import { extractBundle } from "../git/bundle.js";
import { getMaxBundleBytesSetting } from "./settings.js";
import { M } from "../metrics.js";

export type WriteFailure = { ok: false; error: string };
export const fail = (error: string): WriteFailure => ({ ok: false, error });

/** Audit rows written from the MCP surface. Same ACTION names as the browser — an MCP-submitted
 *  proposal is a proposal — with `source = 'mcp'` and the client recorded in the payload. */
async function auditMcp(
  db: Pool | PoolClient,
  e: {
    actorUserId: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    namespaceId?: string | null;
    after?: Record<string, unknown>;
    clientName: string;
  },
): Promise<void> {
  await db.query(
    `insert into audit_log (actor_user_id, action, target_type, target_id, namespace_id, before, after, source)
     values ($1,$2,$3,$4,$5,null,$6::jsonb,'mcp')`,
    [
      e.actorUserId,
      e.action,
      e.targetType,
      e.targetId ?? null,
      e.namespaceId ?? null,
      JSON.stringify({ ...(e.after ?? {}), via: "mcp", mcpClient: e.clientName }),
    ],
  );
}

// ── Mentions (§24) ──────────────────────────────────────────────────────────────────────────────

export interface PreparedMention {
  kind: "user" | "skill";
  id: string;
  label: string | null;
}

/**
 * Validate the mention tokens in an agent-composed body against the thread's audience, using the
 * SHARED parser so the token grammar can't drift from the web composer. Rules mirror §24: at most
 * 10 distinct mentions; a mentioned user must be live AND able to see this thread; a mentioned
 * skill must be visible to the author.
 */
async function validateMentionsWorker(
  pool: Pool,
  access: EffectiveAccess,
  body: string,
  audience: { visibleNamespaceId: string | null; orgWide: boolean },
  opts: { markdown?: boolean } = {},
): Promise<{ ok: true; mentions: PreparedMention[] } | WriteFailure> {
  const refs = extractMentions(body, { markdown: opts.markdown });
  if (refs.length === 0) return { ok: true, mentions: [] };
  if (refs.length > MAX_MENTIONS_PER_MESSAGE) return fail(`too many mentions (max ${MAX_MENTIONS_PER_MESSAGE})`);

  const prepared: PreparedMention[] = [];
  const userIds = refs.filter((r) => r.kind === "user").map((r) => r.id);
  const skillIds = refs.filter((r) => r.kind === "skill").map((r) => r.id);

  if (userIds.length) {
    const { rows } = await pool.query<{ id: string; in_audience: boolean }>(
      `select u.id,
              ($3::boolean or exists (
                 select 1 from group_memberships gm
                 join role_mappings rm on rm.group_id = gm.group_id
                where gm.user_id = u.id and (rm.role = 'platform_admin' or rm.namespace_id = $2)
              )) as in_audience
         from users u
        where u.id = any($1::uuid[]) and u.status = 'active' and u.erased_at is null`,
      [userIds, audience.visibleNamespaceId, audience.orgWide],
    );
    const byId = new Map(rows.map((r) => [r.id, r.in_audience]));
    for (const id of userIds) {
      const inAudience = byId.get(id);
      if (inAudience === undefined) return fail("mentioned user not found");
      if (!inAudience) return fail("mentioned user can't see this discussion");
      prepared.push({ kind: "user", id, label: null });
    }
  }

  if (skillIds.length) {
    const { rows } = await pool.query<{ id: string; visibility: "org" | "namespace"; namespace_id: string; ns_slug: string; slug: string }>(
      `select s.id, s.visibility, s.namespace_id, n.slug as ns_slug, s.slug
         from skills s join namespaces n on n.id = s.namespace_id where s.id = any($1::uuid[])`,
      [skillIds],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of skillIds) {
      const s = byId.get(id);
      if (!s) return fail("mentioned skill not found");
      const visible = s.visibility === "org" || access.isPlatformAdmin || access.namespaceRoles.has(s.namespace_id);
      if (!visible) return fail("mentioned skill isn't visible to you");
      prepared.push({ kind: "skill", id, label: `${s.ns_slug}/${s.slug}` });
    }
  }
  return { ok: true, mentions: prepared };
}

async function insertMentionRows(pool: Pool, messageId: string, mentions: readonly PreparedMention[]): Promise<void> {
  for (const m of mentions) {
    await pool.query(
      `insert into message_mentions (message_id, kind, target_id, label) values ($1,$2,$3,$4)
         on conflict do nothing`,
      [messageId, m.kind, m.id, m.label],
    );
  }
}

/** Un-coalesced `message.mention` pings (§12). Returns the ids notified, which the coalesced
 *  fan-out then skips. */
async function notifyMentions(
  pool: Pool,
  mentions: readonly PreparedMention[],
  authorId: string,
  ctx: { conversationId: string; messageId: string; fromName: string; proposalId?: string | null; namespaceSlug?: string | null; skillSlug?: string | null },
): Promise<string[]> {
  const targets = [...new Set(mentions.filter((m) => m.kind === "user").map((m) => m.id))].filter((id) => id !== authorId);
  if (!targets.length) return [];
  const payload = JSON.stringify({
    conversationId: ctx.conversationId,
    messageId: ctx.messageId,
    fromName: ctx.fromName,
    proposalId: ctx.proposalId ?? null,
    requestId: null,
    namespaceSlug: ctx.namespaceSlug ?? null,
    skillSlug: ctx.skillSlug ?? null,
    title: null,
  });
  const { rows } = await pool.query<{ id: string }>(
    `insert into notifications (user_id, type, payload)
     select u.id, 'message.mention', $2::jsonb
       from users u
      where u.id = any($1::uuid[]) and u.status = 'active' and u.erased_at is null and u.discussion_notifications
     returning user_id as id`,
    [targets, payload],
  );
  return rows.map((r) => r.id);
}

async function displayName(pool: Pool, userId: string): Promise<string> {
  const { rows } = await pool.query<{ display_name: string }>(`select display_name from users where id = $1`, [userId]);
  return rows[0]?.display_name ?? "Someone";
}

async function getOrCreateConversation(pool: Pool, subjectType: string, subjectId: string): Promise<string> {
  await pool.query(
    `insert into conversations (subject_type, subject_id) values ($1, $2)
       on conflict (subject_type, subject_id) where subject_id is not null do nothing`,
    [subjectType, subjectId],
  );
  const { rows } = await pool.query<{ id: string }>(
    `select id from conversations where subject_type = $1 and subject_id = $2`,
    [subjectType, subjectId],
  );
  return rows[0]!.id;
}

/** Insert a message carrying the via-MCP marker. Mirrors the web tier's insertMessage. */
async function insertMcpMessage(
  pool: Pool,
  conversationId: string,
  authorId: string,
  body: string,
  clientName: string,
  opts: { contextSemver?: string | null; trackParticipant?: boolean; mentions?: PreparedMention[] },
): Promise<{ id: string; createdAt: string }> {
  const { rows } = await pool.query<{ id: string; created_at: string }>(
    `insert into messages (conversation_id, author_id, body, context_semver, via_mcp_client)
     values ($1,$2,$3,$4,$5) returning id, created_at`,
    [conversationId, authorId, body, opts.contextSemver ?? null, clientName],
  );
  const msg = rows[0]!;
  if (opts.mentions?.length) await insertMentionRows(pool, msg.id, opts.mentions);
  await pool.query(`update conversations set updated_at = now() where id = $1`, [conversationId]);
  if (opts.trackParticipant !== false) {
    await pool.query(
      `insert into conversation_participants (conversation_id, user_id, last_read_at) values ($1,$2,now())
         on conflict (conversation_id, user_id) do update set last_read_at = now()`,
      [conversationId, authorId],
    );
  }
  return { id: msg.id, createdAt: msg.created_at };
}

const MAX_MESSAGE_LEN = 4000;
const MAX_DISCUSSION_LEN = 500;

// ── Ratings (§18) ───────────────────────────────────────────────────────────────────────────────

/**
 * Set (1–5) or clear (`null`) the caller's own rating. Marked via-MCP; the §18 Bayesian aggregate
 * is maintained by the existing rollup trigger, so an agent rating is weighted exactly like a
 * person's — an accepted trade-off, made visible rather than silently corrected for.
 */
export async function rateSkill(
  pool: Pool,
  userId: string,
  skillId: string,
  stars: number | null,
  clientName: string,
): Promise<{ ok: true; stars: number | null } | WriteFailure> {
  if (stars === null) {
    await pool.query(`delete from skill_ratings where user_id = $1 and skill_id = $2`, [userId, skillId]);
    return { ok: true, stars: null };
  }
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return fail("stars must be an integer between 1 and 5");
  const { rows } = await pool.query<{ semver: string }>(
    `select semver from skill_versions where skill_id = $1 and status = 'active' order by created_at desc limit 1`,
    [skillId],
  );
  await pool.query(
    `insert into skill_ratings (user_id, skill_id, stars, rated_semver, via_mcp_client)
       values ($1,$2,$3,$4,$5)
     on conflict (user_id, skill_id)
       do update set stars = excluded.stars, rated_semver = excluded.rated_semver,
                     via_mcp_client = excluded.via_mcp_client, updated_at = now()`,
    [userId, skillId, stars, rows[0]?.semver ?? null, clientName],
  );
  M.mcpWrites.inc({ kind: "rating" });
  return { ok: true, stars };
}

// ── Skill discussion (§24) ──────────────────────────────────────────────────────────────────────

export interface DiscussionSkill {
  id: string;
  namespaceId: string;
  namespaceSlug: string;
  skillSlug: string;
  visibility: "org" | "namespace";
}

export async function postSkillComment(
  pool: Pool,
  access: EffectiveAccess,
  userId: string,
  skill: DiscussionSkill,
  rawBody: string,
  contextSemver: string | null,
  clientName: string,
): Promise<{ ok: true; messageId: string } | WriteFailure> {
  const body = rawBody.trim();
  if (!body) return fail("message is empty");
  if (body.length > MAX_DISCUSSION_LEN) return fail(`message too long (max ${MAX_DISCUSSION_LEN})`);

  const mentions = await validateMentionsWorker(
    pool,
    access,
    body,
    { visibleNamespaceId: skill.namespaceId, orgWide: skill.visibility === "org" },
    { markdown: true },
  );
  if (!mentions.ok) return mentions;

  const { rows: active } = await pool.query<{ semver: string }>(
    `select semver from skill_versions where skill_id = $1 and status = 'active'`,
    [skill.id],
  );
  let semver: string | null = null;
  if (contextSemver != null) {
    if (!active.some((v) => v.semver === contextSemver)) return fail("unknown or inactive version");
    semver = contextSemver;
  }

  const conversationId = await getOrCreateConversation(pool, "skill", skill.id);
  const message = await insertMcpMessage(pool, conversationId, userId, body, clientName, {
    contextSemver: semver,
    trackParticipant: false, // skill discussions are open forums with no participant rows (§24)
    mentions: mentions.mentions,
  });
  const fromName = await displayName(pool, userId);
  const mentioned = await notifyMentions(pool, mentions.mentions, userId, {
    conversationId,
    messageId: message.id,
    fromName,
    namespaceSlug: skill.namespaceSlug,
    skillSlug: skill.skillSlug,
  });
  // Coalesced skill.discussion fan-out to watchers ∪ maintainers ∪ namespace admins — the same
  // predicate the web tier uses, including the visibility gate on restricted skills.
  await pool.query(
    `insert into notifications (user_id, type, payload)
     select r.uid, 'skill.discussion', $2::jsonb
       from (
         select w.user_id as uid from skill_watches w where w.skill_id = $1
         union
         select sm.user_id from skill_maintainers sm where sm.skill_id = $1
         union
         select gm.user_id
           from role_mappings rm
           join group_memberships gm on gm.group_id = rm.group_id
          where rm.namespace_id = $3 and rm.role = 'namespace_admin'
       ) r
       join users u on u.id = r.uid and u.status = 'active' and u.discussion_notifications
      where r.uid <> $4
        and r.uid <> all($6::uuid[])
        and (
          $5 = 'org'
          or exists (
            select 1 from group_memberships gm2
            join role_mappings rm2 on rm2.group_id = gm2.group_id
            where gm2.user_id = r.uid and (rm2.role = 'platform_admin' or rm2.namespace_id = $3)
          )
        )
     on conflict do nothing`,
    [
      skill.id,
      JSON.stringify({ conversationId, namespaceSlug: skill.namespaceSlug, skillSlug: skill.skillSlug, fromName }),
      skill.namespaceId,
      userId,
      skill.visibility,
      mentioned,
    ],
  );
  M.mcpWrites.inc({ kind: "discussion" });
  return { ok: true, messageId: message.id };
}

// ── Proposal review thread (§24) ────────────────────────────────────────────────────────────────

export async function postProposalMessage(
  pool: Pool,
  access: EffectiveAccess,
  userId: string,
  proposalId: string,
  rawBody: string,
  clientName: string,
): Promise<{ ok: true; messageId: string } | WriteFailure> {
  const p = await loadProposalCtx(pool, proposalId);
  if (!p) return fail("proposal not found");
  const isReviewer = canReviewNamespace(access, p.namespaceId);
  if (p.submittedBy !== userId && !isReviewer) return fail("proposal not found");
  if (p.state === "accepted" || p.state === "rejected") return fail("this proposal is closed — the discussion is read-only");

  const body = rawBody.trim();
  if (!body) return fail("message is empty");
  if (body.length > MAX_MESSAGE_LEN) return fail(`message too long (max ${MAX_MESSAGE_LEN})`);

  const mentions = await validateMentionsWorker(pool, access, body, {
    visibleNamespaceId: p.namespaceId,
    orgWide: false, // a review thread's membership must not leak (§24)
  });
  if (!mentions.ok) return mentions;

  const conversationId = await getOrCreateConversation(pool, "proposal", proposalId);
  const message = await insertMcpMessage(pool, conversationId, userId, body, clientName, { mentions: mentions.mentions });
  const fromName = await displayName(pool, userId);
  const mentioned = await notifyMentions(pool, mentions.mentions, userId, {
    conversationId,
    messageId: message.id,
    fromName,
    proposalId,
  });
  // Coalesced message.new to the thread's other participants (submitter ∪ reviewers).
  await pool.query(
    `insert into notifications (user_id, type, payload)
     select r.uid, 'message.new', $1::jsonb
       from (
         select $2::uuid as uid
         union
         select gm.user_id
           from role_mappings rm
           join group_memberships gm on gm.group_id = rm.group_id
          where rm.namespace_id = $3 and rm.role = 'namespace_admin'
       ) r
       join users u on u.id = r.uid and u.status = 'active'
      where r.uid <> $4 and r.uid <> all($5::uuid[])
     on conflict do nothing`,
    [JSON.stringify({ conversationId, proposalId, fromName }), p.submittedBy, p.namespaceId, userId, mentioned],
  );
  M.mcpWrites.inc({ kind: "proposal_message" });
  return { ok: true, messageId: message.id };
}

interface ProposalCtx {
  id: string;
  namespaceId: string;
  namespaceSlug: string;
  targetSkillId: string | null;
  proposedSemver: string;
  state: ProposalState;
  submittedBy: string;
}

export async function loadProposalCtx(pool: Pool, id: string): Promise<ProposalCtx | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await pool.query<{
    id: string;
    target_namespace_id: string;
    ns_slug: string;
    target_skill_id: string | null;
    proposed_semver: string;
    state: ProposalState;
    submitted_by: string;
  }>(
    `select p.id, p.target_namespace_id, n.slug as ns_slug, p.target_skill_id, p.proposed_semver, p.state, p.submitted_by
       from proposals p join namespaces n on n.id = p.target_namespace_id where p.id = $1`,
    [id],
  );
  const r = rows[0];
  return r
    ? {
        id: r.id,
        namespaceId: r.target_namespace_id,
        namespaceSlug: r.ns_slug,
        targetSkillId: r.target_skill_id,
        proposedSemver: r.proposed_semver,
        state: r.state,
        submittedBy: r.submitted_by,
      }
    : null;
}

// ── Skill requests (§26) ────────────────────────────────────────────────────────────────────────

export interface RequestInput {
  title: string;
  description: string;
  usageExamples?: string | null;
  toolHarness: string;
  categories?: string[];
}

export async function createSkillRequest(
  pool: Pool,
  userId: string,
  input: RequestInput,
  clientName: string,
): Promise<{ ok: true; id: string } | WriteFailure> {
  const title = (input.title ?? "").trim();
  const description = (input.description ?? "").trim();
  if (title.length < 3 || title.length > 120) return fail("title must be between 3 and 120 characters");
  if (description.length < 10 || description.length > 4000) return fail("description must be between 10 and 4000 characters");
  const harness = normalizeHarness(input.toolHarness ?? "generic");
  if (!isAllowedToolHarness(harness)) return fail("choose a tool/harness from the list (see get_registry_metadata)");
  const categories = [...new Set((input.categories ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean))].slice(0, 12);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      `insert into skill_requests (requester_user_id, title, description, usage_examples, tool_harness, via_mcp_client)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [userId, title, description, input.usageExamples?.trim() || null, harness, clientName],
    );
    const id = rows[0]!.id;
    for (const name of categories) {
      const { rows: cat } = await client.query<{ id: string }>(
        `insert into categories (name) values ($1) on conflict (name) do update set name = excluded.name returning id`,
        [name],
      );
      await client.query(
        `insert into skill_request_categories (request_id, category_id) values ($1,$2) on conflict do nothing`,
        [id, cat[0]!.id],
      );
    }
    await auditMcp(client, {
      actorUserId: userId,
      action: "request.created",
      targetType: "skill_request",
      targetId: id,
      after: { title, toolHarness: harness, categories },
      clientName,
    });
    await client.query("commit");
    M.mcpWrites.inc({ kind: "request" });
    return { ok: true, id };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

// ── Proposals (§8) ──────────────────────────────────────────────────────────────────────────────

export interface ProposalMetadataInput {
  skillSlug: string;
  title: string;
  description: string;
  toolHarness: string;
  visibility: "org" | "namespace";
  categories?: string[];
  tags?: string[];
  usageExamples?: string | null;
  whatChanged?: string | null;
}

interface BuiltPayload {
  metadata: ProposalMetadataInput;
  pointer?: { url: string; ref: string; subdir: string | null };
  artifactObjectKey?: string;
  artifactSha256?: string;
  artifactFilename?: string | null;
  contentSha256?: string;
}

/** Shared metadata validation for both propose tools. Normalizes in place, like the web boundary. */
function validateMetadata(
  meta: ProposalMetadataInput,
  namespaceSlug: string,
  isNewVersion: boolean,
): WriteFailure | null {
  if (!meta) return fail("metadata is required");
  const slug = (meta.skillSlug ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return fail("skillSlug must be kebab-case (a-z, 0-9, dashes)");
  meta.skillSlug = slug;
  const title = (meta.title ?? "").trim();
  if (title.length < 3 || title.length > 120) return fail("title must be between 3 and 120 characters");
  meta.title = title;
  const description = (meta.description ?? "").trim();
  if (description.length < 10 || description.length > 2000) return fail("description must be between 10 and 2000 characters");
  meta.description = description;
  if (meta.visibility !== "org" && meta.visibility !== "namespace") return fail('visibility must be "org" or "namespace"');
  if (meta.visibility === "namespace" && namespaceSlug.toLowerCase() === "global") {
    return fail("a skill restricted to a namespace can't live in the global namespace — choose a specific namespace, or set visibility to org");
  }
  meta.toolHarness = normalizeHarness(meta.toolHarness ?? "generic");
  if (!isAllowedToolHarness(meta.toolHarness)) return fail("choose a tool/harness from the list (see get_registry_metadata)");
  const wc = meta.whatChanged == null ? null : String(meta.whatChanged).trim() || null;
  meta.whatChanged = wc;
  if (wc && wc.length > WHAT_CHANGED_MAX_LEN) return fail(`"whatChanged" is too long (${wc.length}/${WHAT_CHANGED_MAX_LEN})`);
  if (isNewVersion && !wc) return fail('describe what changed in this version — "whatChanged" is required for a new version');
  meta.categories = [...new Set((meta.categories ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  meta.tags = [...new Set((meta.tags ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, 20);
  meta.usageExamples = meta.usageExamples?.trim() || null;
  return null;
}

function validatePointerFields(p: { url: string; ref: string; subdir?: string | null }): { ok: true; value: { url: string; ref: string; subdir: string | null } } | WriteFailure {
  const urlErr = validatePointerUrl(p.url);
  if (urlErr) return fail(urlErr);
  const refErr = validateGitRef(p.ref);
  if (refErr) return fail(refErr);
  if (isSkillsHubUrl(p.url)) {
    const hubErr = validateSkillsHubRef(p.ref);
    if (hubErr) return fail(hubErr);
  }
  const subdir = p.subdir?.trim() || null;
  if (subdir) {
    const subErr = validateSubdir(subdir);
    if (subErr) return fail(subErr);
  }
  return { ok: true, value: { url: p.url, ref: p.ref, subdir } };
}

/** Resolve the target: an existing skill (new version) or a brand-new one, with semver checks. */
async function resolveTarget(
  pool: Pool,
  namespaceId: string,
  skillSlug: string,
  proposedSemver: string,
): Promise<{ ok: true; targetSkillId: string | null; isNewVersion: boolean } | WriteFailure> {
  if (!parseSemver(proposedSemver)) return fail(`"${proposedSemver}" is not a valid semver (e.g. 1.0.0)`);
  const { rows } = await pool.query<{ id: string; status: string }>(
    `select id, status from skills where namespace_id = $1 and slug = $2`,
    [namespaceId, skillSlug],
  );
  const existing = rows[0];
  if (!existing) return { ok: true, targetSkillId: null, isNewVersion: false };
  if (existing.status === "archived") return fail("that skill is archived — restore it before proposing a new version");
  const { rows: vs } = await pool.query<{ semver: string }>(`select semver from skill_versions where skill_id = $1`, [existing.id]);
  if (vs.some((v) => v.semver === proposedSemver)) {
    return fail(`version ${proposedSemver} already exists for that skill — versions are immutable, choose a higher one`);
  }
  return { ok: true, targetSkillId: existing.id, isNewVersion: true };
}

/**
 * Ingest an inline hosted bundle. BYTE-IDENTICAL to the web upload path: extract → BLOCKING
 * validation → ADVISORY scan → store the original bytes at an immutable key → artifact-keyed scan
 * report. There is no MCP scan carve-out, and there never will be (§22).
 */
async function ingestHostedBundle(
  pool: Pool,
  userId: string,
  bundleBytes: Buffer,
  skillSlug: string,
  filename: string,
): Promise<{ ok: true; artifactObjectKey: string; artifactSha256: string; contentSha256: string; artifactFilename: string; scanSeverity: string } | WriteFailure> {
  const maxBytes = await getMaxBundleBytesSetting(pool);
  if (bundleBytes.length > maxBytes) return fail(`the bundle is bigger than this registry's limit of ${maxBytes} bytes`);
  const contentCap = bundleContentCap(maxBytes);

  let files;
  try {
    files = await extractBundle(bundleBytes, contentCap);
  } catch (e) {
    return fail(`could not read bundle: ${(e as Error).message}`);
  }
  const validation = validateBundle(files, { skillSlug, maxBytes: contentCap });
  if (!validation.ok) return fail(`invalid bundle: ${validation.errors.join("; ")}`);

  const findings = await runScanners(files, PURE_SCANNERS);
  const severity = maxSeverity(findings) ?? "info";
  const contentSha256 = contentDigest(files);
  const { createHash } = await import("node:crypto");
  const artifactSha256 = createHash("sha256").update(bundleBytes).digest("hex");
  const artifactObjectKey = `uploads/${userId}/${randomUUID()}.bundle`;
  try {
    await s3ArtifactStore().put(artifactObjectKey, bundleBytes);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "mcp artifact put failed", err: String(e instanceof Error ? e.message : e) }));
    return fail("couldn't store the bundle — object storage is unavailable. Try again shortly.");
  }
  // Identical row to the web upload path (`scanner = 'pipeline'`, `status = 'scanned'`) so a
  // reviewer sees the same artifact-keyed report whichever door the bundle came through.
  await pool.query(
    `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status)
     values ('artifact', $1, 'pipeline', $2::jsonb, $3, 'scanned')`,
    [artifactObjectKey, JSON.stringify(findings), severity],
  );
  return { ok: true, artifactObjectKey, artifactSha256, contentSha256, artifactFilename: filename, scanSeverity: severity };
}

/** Notify the namespace's reviewers that a proposal needs them (mirrors the web fan-out). */
async function notifyProposalCreated(
  db: PoolClient,
  input: { proposalId: string; namespaceId: string; submitterId: string; skillSlug: string; semver: string },
): Promise<void> {
  const bootstrap = process.env.SKILLY_BOOTSTRAP_ADMIN_GROUP?.trim() ?? null;
  await db.query(
    `with reviewers as (
       select distinct gm.user_id as id
         from role_mappings rm
         join group_memberships gm on gm.group_id = rm.group_id
        where (rm.role = 'platform_admin' or (rm.role = 'namespace_admin' and rm.namespace_id = $1))
       union
       select gm.user_id
         from groups g join group_memberships gm on gm.group_id = g.id
        where $4::text is not null and g.entra_object_id = $4
     )
     insert into notifications (user_id, type, payload)
     select id, 'proposal.created', $2::jsonb from reviewers where id <> $3`,
    [input.namespaceId, JSON.stringify({ proposalId: input.proposalId, skillSlug: input.skillSlug, semver: input.semver }), input.submitterId, bootstrap],
  );
}

export interface ProposeResult {
  ok: true;
  proposalId: string;
  state: "proposed";
  targetNamespace: string;
  skillSlug: string;
  semver: string;
  newSkill: boolean;
  scanSeverity?: string;
}

/**
 * Create a proposal (pointer or hosted). ALWAYS lands in `proposed` — the MCP surface has no direct
 * publish, even for a member of a `require_review = false` namespace: an agent authors, a human
 * decides. The tool description says so, so nobody is surprised.
 */
export async function createMcpProposal(
  pool: Pool,
  userId: string,
  namespace: { id: string; slug: string },
  proposedSemver: string,
  payload: BuiltPayload,
  clientName: string,
  scanSeverity?: string,
): Promise<ProposeResult | WriteFailure> {
  const target = await resolveTarget(pool, namespace.id, payload.metadata.skillSlug, proposedSemver);
  if (!target.ok) return target;
  const metaErr = validateMetadata(payload.metadata, namespace.slug, target.isNewVersion);
  if (metaErr) return metaErr;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      `insert into proposals (target_namespace_id, target_skill_id, proposed_semver, state, submitted_by, via_mcp_client)
       values ($1,$2,$3,'proposed',$4,$5) returning id`,
      [namespace.id, target.targetSkillId, proposedSemver, userId, clientName],
    );
    const proposalId = rows[0]!.id;
    await client.query(
      `insert into proposal_revisions (proposal_id, revision_no, payload, author, note)
       values ($1, 1, $2::jsonb, $3, 'initial submission (via MCP)')`,
      [proposalId, JSON.stringify(payload), userId],
    );
    await auditMcp(client, {
      actorUserId: userId,
      action: "proposal.created",
      targetType: "proposal",
      targetId: proposalId,
      namespaceId: namespace.id,
      after: { state: "proposed", semver: proposedSemver },
      clientName,
    });
    await notifyProposalCreated(client, {
      proposalId,
      namespaceId: namespace.id,
      submitterId: userId,
      skillSlug: payload.metadata.skillSlug,
      semver: proposedSemver,
    });
    await client.query("commit");
    M.mcpWrites.inc({ kind: "proposal" });
    return {
      ok: true,
      proposalId,
      state: "proposed",
      targetNamespace: namespace.slug,
      skillSlug: payload.metadata.skillSlug,
      semver: proposedSemver,
      newSkill: target.targetSkillId === null,
      scanSeverity,
    };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export { validateMetadata, validatePointerFields, ingestHostedBundle, auditMcp, type BuiltPayload };

/**
 * Proposer-side revise / resubmit (§8). Reviewer decisions are NOT reachable from MCP, so the only
 * actions this accepts are `revise` (mid-review edit, no state change) and `resubmit`
 * (changes_requested → under_review). The state machine and actor caps come from
 * `@skilly/shared/proposal`, so the rules are the same ones the browser obeys.
 */
export async function proposerAction(
  pool: Pool,
  access: EffectiveAccess,
  userId: string,
  proposalId: string,
  action: Extract<ProposalAction, "revise" | "resubmit">,
  newPayload: BuiltPayload,
  note: string | null,
  clientName: string,
): Promise<{ ok: true; state: ProposalState; revisionNo: number } | WriteFailure> {
  const p = await loadProposalCtx(pool, proposalId);
  if (!p) return fail("proposal not found");
  const caps = { isReviewer: canReviewNamespace(access, p.namespaceId), isSubmitter: p.submittedBy === userId };
  if (!caps.isSubmitter) return fail("only the proposal's submitter can revise or resubmit it");
  const decision = canPerform(action, p.state, caps);
  if (!decision.ok) return fail(decision.reason);

  const metaErr = validateMetadata(newPayload.metadata, p.namespaceSlug, p.targetSkillId !== null);
  if (metaErr) return metaErr;

  const { rows: prevRows } = await pool.query<{ payload: BuiltPayload; revision_no: number }>(
    `select payload, revision_no from proposal_revisions where proposal_id = $1 order by revision_no desc limit 1`,
    [proposalId],
  );
  const prev = prevRows[0];
  if (!prev) return fail("proposal has no revisions");
  if (JSON.stringify(prev.payload) === JSON.stringify(newPayload)) {
    return fail("nothing changed — edit at least one field, or provide a new source");
  }
  // §8 revise file-freeze: a POINTER proposal's files can't change mid-review.
  if (action === "revise" && prev.payload.pointer) {
    const before = prev.payload.pointer;
    const after = newPayload.pointer;
    const changed =
      !after ||
      normalizeOriginUrl(before.url) !== normalizeOriginUrl(after.url) ||
      before.ref !== after.ref ||
      normalizeSubdir(before.subdir) !== normalizeSubdir(after.subdir);
    if (changed) {
      return fail("this is a pointer proposal — its files can't change while it's in review; ask the reviewer to request changes, then resubmit with the new source");
    }
  }

  const to = nextState(action, p.state);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: revIns } = await client.query<{ revision_no: number }>(
      `insert into proposal_revisions (proposal_id, revision_no, payload, author, note)
       select $1, coalesce(max(revision_no),0)+1, $2::jsonb, $3, $4 from proposal_revisions where proposal_id = $1
       returning revision_no`,
      [proposalId, JSON.stringify(newPayload), userId, note ?? (action === "revise" ? "revised via MCP" : "resubmitted via MCP")],
    );
    // `revise` keeps the state; `resubmit` moves it. Either way updated_at moves, which is what
    // re-arms the reviewer's queue badge (§10).
    await client.query(`update proposals set state = $2, updated_at = now() where id = $1`, [proposalId, to ?? p.state]);
    await auditMcp(client, {
      actorUserId: userId,
      action: `proposal.${action}d`,
      targetType: "proposal",
      targetId: proposalId,
      namespaceId: p.namespaceId,
      after: { state: to ?? p.state, revisionNo: revIns[0]?.revision_no ?? null },
      clientName,
    });
    await client.query("commit");
    M.mcpWrites.inc({ kind: `proposal_${action}` });
    return { ok: true, state: (to ?? p.state) as ProposalState, revisionNo: revIns[0]!.revision_no };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
