// "Request a skill" service (SKILLY_SPEC.md §26): org-visible wishes for skills that don't exist
// yet. Lightweight and unreviewed — NOT proposals. Two independent fulfilment paths: the
// proposal-accept transaction (fulfilOriginRequest) when a proposal explicitly linked via
// origin_request_id lands, or an immediate link to an already-published skill
// (fulfilWithExistingSkill, "Propose an existing skill"). Whichever happens first wins.
import type { PoolClient } from "pg";
import { pool } from "./db";
import { appendAudit } from "./audit";

export type RequestState = "open" | "fulfilled" | "withdrawn" | "removed";

export interface SkillRequestView {
  id: string;
  title: string;
  description: string;
  usageExamples: string | null;
  toolHarness: string;
  categories: string[];
  state: RequestState;
  requesterUserId: string;
  requesterName: string;
  requesterAvatar: string | null;
  createdAt: string;
  updatedAt: string;
  /** Set on fulfilled requests: where the built skill lives + who built it. */
  fulfilled: { namespaceSlug: string; skillSlug: string; byName: string | null } | null;
  /** List only (listOpenRequests): this request is new to the caller — posted since they last
   *  opened Requested skills. Keyed on created_at only (like the catalog's "new" tag) — editing an
   *  already-seen request never re-flags it. No distinction by who posted it (§26). Undefined from
   *  getRequest (the detail page has no "new" tag to show). */
  isNew?: boolean;
}

const VIEW_SELECT = `
  select r.id, r.title, r.description, r.usage_examples, r.tool_harness, r.state,
         r.requester_user_id, u.display_name as requester_name, u.avatar as requester_avatar,
         r.created_at, r.updated_at,
         fs.slug as fulfilled_slug, fn.slug as fulfilled_ns, fu.display_name as fulfilled_by_name,
         coalesce((select array_agg(c.name order by c.name)
                     from skill_request_categories rc join categories c on c.id = rc.category_id
                    where rc.request_id = r.id), '{}') as categories
    from skill_requests r
    join users u on u.id = r.requester_user_id
    left join skills fs on fs.id = r.fulfilled_skill_id
    left join namespaces fn on fn.id = fs.namespace_id
    left join users fu on fu.id = r.fulfilled_by_user_id`;

interface Row {
  id: string; title: string; description: string; usage_examples: string | null; tool_harness: string;
  state: RequestState; requester_user_id: string; requester_name: string; requester_avatar: string | null;
  created_at: string; updated_at: string; categories: string[] | null;
  fulfilled_slug: string | null; fulfilled_ns: string | null; fulfilled_by_name: string | null;
}

function toView(r: Row): SkillRequestView {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    usageExamples: r.usage_examples,
    toolHarness: r.tool_harness,
    categories: r.categories ?? [],
    state: r.state,
    requesterUserId: r.requester_user_id,
    requesterName: r.requester_name,
    requesterAvatar: r.requester_avatar,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    fulfilled: r.fulfilled_slug && r.fulfilled_ns
      ? { namespaceSlug: r.fulfilled_ns, skillSlug: r.fulfilled_slug, byName: r.fulfilled_by_name }
      : null,
  };
}

/** Appends the shared live-filter vocabulary (search/category/tool) to a WHERE clause + params
 *  array in place — used by both listOpenRequests and listMyRequests so the two stay consistent. */
function applyLiveFilters(where: string[], params: unknown[], opts: { q?: string; category?: string; tool?: string }): void {
  if (opts.q) {
    params.push(`%${opts.q.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`(r.title ilike $${params.length} escape '\\' or r.description ilike $${params.length} escape '\\')`);
  }
  if (opts.category) {
    params.push(opts.category);
    where.push(`exists (select 1 from skill_request_categories rc join categories c on c.id = rc.category_id
                         where rc.request_id = r.id and c.name = $${params.length})`);
  }
  if (opts.tool) {
    params.push(opts.tool);
    where.push(`r.tool_harness = $${params.length}`);
  }
}

/** Org-wide requests, newest first, with optional live filters (same vocabulary as the catalog).
 *  Defaults to OPEN only (the everyone view). `states` widens it to other states — used by the
 *  platform-admin state filter to also list `fulfilled` (or all); the route gates who may pass it,
 *  since only open+fulfilled ever persist (withdrawn/removed hard-delete the row). `seenAt` (the
 *  caller's requests_seen_at, §26) drives the per-row `isNew` flag for OPEN rows when supplied. */
export async function listOpenRequests(opts: { q?: string; category?: string; tool?: string; limit?: number; seenAt?: string | null; states?: readonly RequestState[] } = {}): Promise<SkillRequestView[]> {
  const states = opts.states && opts.states.length ? [...opts.states] : (["open"] as RequestState[]);
  const params: unknown[] = [states];
  const where: string[] = [`r.state = any($1::text[])`];
  applyLiveFilters(where, params, opts);
  params.push(Math.min(200, opts.limit ?? 100));
  const { rows } = await pool.query<Row>(
    `${VIEW_SELECT} where ${where.join(" and ")} order by r.created_at desc limit $${params.length}`,
    params,
  );
  // "New to you": same rule as the catalog's chip — compared in epoch-ms, tz-agnostic. Absent a
  // seen marker, nothing is flagged (isNew stays undefined). Only OPEN rows can be "new" — a
  // fulfilled request an admin is browsing is never flagged as new.
  const seenMs = opts.seenAt ? new Date(opts.seenAt).getTime() : NaN;
  return rows.map((r) => {
    const v = toView(r);
    if (!Number.isNaN(seenMs) && r.state === "open") v.isNew = new Date(r.created_at).getTime() > seenMs;
    return v;
  });
}

/** One user's OWN requests, any state — open or fulfilled (withdrawn/removed hard-delete the row,
 *  so no state to show for those). The "Mine" toggle on Requested skills (§26); same live-filter
 *  vocabulary as listOpenRequests. Newest first; no "new" badge (these are the caller's own posts). */
export async function listMyRequests(requesterUserId: string, opts: { q?: string; category?: string; tool?: string; limit?: number } = {}): Promise<SkillRequestView[]> {
  const params: unknown[] = [requesterUserId];
  const where: string[] = [`r.requester_user_id = $1`];
  applyLiveFilters(where, params, opts);
  params.push(Math.min(200, opts.limit ?? 100));
  const { rows } = await pool.query<Row>(
    `${VIEW_SELECT} where ${where.join(" and ")} order by r.created_at desc limit $${params.length}`,
    params,
  );
  return rows.map(toView);
}

export async function getRequest(id: string): Promise<SkillRequestView | null> {
  const { rows } = await pool.query<Row>(`${VIEW_SELECT} where r.id = $1`, [id]);
  return rows[0] ? toView(rows[0]) : null;
}

export interface RequestInput {
  title: string;
  description: string;
  usageExamples?: string | null;
  toolHarness: string;
  categories: string[];
}

function validate(input: RequestInput): string | null {
  if (!input.title.trim()) return "title is required";
  if (input.title.length > 200) return "title too long (max 200)";
  if (!input.description.trim()) return "description is required";
  if (input.description.length > 20_000) return "description too long";
  if ((input.usageExamples ?? "").length > 20_000) return "usage too long";
  if (input.categories.length > 10) return "at most 10 categories";
  return null;
}

/** Upsert category names into the shared vocabulary and link them to the request. */
async function setCategories(client: PoolClient, requestId: string, names: string[]): Promise<void> {
  await client.query(`delete from skill_request_categories where request_id = $1`, [requestId]);
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const { rows } = await client.query<{ id: string }>(
      `insert into categories (name) values ($1)
       on conflict (name) do update set name = excluded.name
       returning id`,
      [name],
    );
    await client.query(
      `insert into skill_request_categories (request_id, category_id) values ($1, $2) on conflict do nothing`,
      [requestId, rows[0]!.id],
    );
  }
}

export async function createRequest(
  requesterUserId: string,
  input: RequestInput,
): Promise<{ id: string } | { error: string }> {
  const err = validate(input);
  if (err) return { error: err };
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      `insert into skill_requests (requester_user_id, title, description, usage_examples, tool_harness)
       values ($1, $2, $3, $4, $5) returning id`,
      [requesterUserId, input.title.trim(), input.description, input.usageExamples ?? null, input.toolHarness],
    );
    const id = rows[0]!.id;
    await setCategories(client, id, input.categories);
    await appendAudit(client, {
      actorUserId: requesterUserId,
      action: "request.created",
      targetType: "skill_request",
      targetId: id,
      after: { title: input.title.trim(), toolHarness: input.toolHarness, categories: input.categories },
    });
    await client.query("commit");
    return { id };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Requester-only edit of an OPEN request (fulfilled/withdrawn/removed are immutable). §26. */
export async function updateRequest(
  actorUserId: string,
  id: string,
  input: RequestInput,
): Promise<{ ok: true } | { error: string; status: number }> {
  const err = validate(input);
  if (err) return { error: err, status: 422 };
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ requester_user_id: string; state: RequestState }>(
      `select requester_user_id, state from skill_requests where id = $1 for update`,
      [id],
    );
    const r = rows[0];
    if (!r) { await client.query("rollback"); return { error: "not found", status: 404 }; }
    if (r.requester_user_id !== actorUserId) { await client.query("rollback"); return { error: "only the requester can edit", status: 403 }; }
    if (r.state !== "open") { await client.query("rollback"); return { error: "only open requests can be edited", status: 409 }; }
    await client.query(
      `update skill_requests set title = $2, description = $3, usage_examples = $4, tool_harness = $5, updated_at = now()
        where id = $1`,
      [id, input.title.trim(), input.description, input.usageExamples ?? null, input.toolHarness],
    );
    await setCategories(client, id, input.categories);
    await appendAudit(client, {
      actorUserId,
      action: "request.updated",
      targetType: "skill_request",
      targetId: id,
      after: { title: input.title.trim(), toolHarness: input.toolHarness, categories: input.categories },
    });
    await client.query("commit");
    return { ok: true };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Requester withdraw (own request only) or platform-admin remove (moderation, any request) —
 *  both permanently DELETE the row (categories cascade; a linked proposal's origin_request_id is
 *  set null via the existing FKs). Open requests only. §26. */
export async function closeRequest(
  actorUserId: string,
  isPlatformAdmin: boolean,
  id: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{
      requester_user_id: string; state: RequestState; title: string; description: string;
      usage_examples: string | null; tool_harness: string;
    }>(
      `select requester_user_id, state, title, description, usage_examples, tool_harness
         from skill_requests where id = $1 for update`,
      [id],
    );
    const r = rows[0];
    if (!r) { await client.query("rollback"); return { error: "not found", status: 404 }; }
    if (r.state !== "open") { await client.query("rollback"); return { error: "request is not open", status: 409 }; }
    const isRequester = r.requester_user_id === actorUserId;
    if (!isRequester && !isPlatformAdmin) { await client.query("rollback"); return { error: "not allowed", status: 403 }; }
    // Snapshot the request in the audit entry first — the row won't exist afterwards to inspect.
    await appendAudit(client, {
      actorUserId,
      action: isRequester ? "request.withdrawn" : "request.removed",
      targetType: "skill_request",
      targetId: id,
      before: {
        title: r.title, description: r.description, usageExamples: r.usage_examples,
        toolHarness: r.tool_harness, requesterUserId: r.requester_user_id,
      },
    });
    await client.query(`delete from skill_requests where id = $1`, [id]);
    // The discussion (§24/§26) is a polymorphic context with no FK, so it doesn't cascade — delete
    // it (messages + participants cascade) and any dangling message.new alert, same as skill delete
    // does for orphaned proposal threads (0037_orphan_proposal_conversations.sql).
    const { rows: doomedConvs } = await client.query<{ id: string }>(
      `delete from conversations where subject_type = 'request' and subject_id = $1 returning id`,
      [id],
    );
    if (doomedConvs.length) {
      await client.query(
        `delete from notifications where type = 'message.new' and payload->>'conversationId' = any($1::text[])`,
        [doomedConvs.map((c) => c.id)],
      );
    }
    await client.query("commit");
    return { ok: true };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Fulfil the request a just-accepted proposal is linked to (called INSIDE the accept transaction,
 * §26). First accepted linked proposal wins: only an `open` request flips (a stale link no-ops).
 * Notifies the requester with the new skill + who built it — unless self-fulfilled (silent).
 */
export async function fulfilOriginRequest(
  client: PoolClient,
  opts: { originRequestId: string; skillId: string; fulfilledByUserId: string; actorUserId: string; via: "proposal" | "direct_publish" },
): Promise<void> {
  const { rows } = await client.query<{ requester_user_id: string; title: string }>(
    `update skill_requests
        set state = 'fulfilled', fulfilled_skill_id = $2, fulfilled_by_user_id = $3,
            fulfilled_at = now(), updated_at = now()
      where id = $1 and state = 'open'
      returning requester_user_id, title`,
    [opts.originRequestId, opts.skillId, opts.fulfilledByUserId],
  );
  const r = rows[0];
  if (!r) return; // already fulfilled / withdrawn / removed — the link no-ops
  await appendAudit(client, {
    actorUserId: opts.actorUserId,
    action: "request.fulfilled",
    targetType: "skill_request",
    targetId: opts.originRequestId,
    after: { skillId: opts.skillId, fulfilledBy: opts.fulfilledByUserId, via: opts.via },
  });
  if (r.requester_user_id !== opts.fulfilledByUserId) {
    const { rows: sk } = await client.query<{ slug: string; ns: string; by_name: string }>(
      `select s.slug, n.slug as ns, (select display_name from users where id = $2) as by_name
         from skills s join namespaces n on n.id = s.namespace_id where s.id = $1`,
      [opts.skillId, opts.fulfilledByUserId],
    );
    if (sk[0]) {
      await client.query(
        `insert into notifications (user_id, type, payload) values ($1, 'request.fulfilled', $2::jsonb)`,
        [r.requester_user_id, JSON.stringify({
          requestId: opts.originRequestId,
          requestTitle: r.title,
          namespaceSlug: sk[0].ns,
          skillSlug: sk[0].slug,
          byName: sk[0].by_name,
        })],
      );
    }
  }
}

/**
 * Second, independent fulfilment path (§26): "Propose an existing skill" — any authenticated user
 * points an OPEN request at a skill that already satisfies it. Immediate — no review, no requester
 * confirmation, since the skill is already published/vetted. Own transaction (unlike
 * fulfilOriginRequest, this isn't nested inside a proposal-accept/direct-publish transaction).
 * Restricted server-side to ACTIVE, ORG-visible skills only — even if the linker themselves has
 * access to a namespace-restricted skill, it's rejected, since the request (and its fulfilment
 * link) must stay openable by the requester and everyone else. Atomically guarded on the request
 * still being `open`, mirroring fulfilOriginRequest's race protection.
 */
export async function fulfilWithExistingSkill(
  actorUserId: string,
  requestId: string,
  namespaceSlug: string,
  skillSlug: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: reqRows } = await client.query<{ state: RequestState; requester_user_id: string; title: string }>(
      `select state, requester_user_id, title from skill_requests where id = $1 for update`,
      [requestId],
    );
    const r = reqRows[0];
    if (!r) { await client.query("rollback"); return { error: "not found", status: 404 }; }
    if (r.state !== "open") { await client.query("rollback"); return { error: "This request was already fulfilled, withdrawn, or removed.", status: 409 }; }
    const { rows: skillRows } = await client.query<{ id: string }>(
      `select s.id from skills s join namespaces n on n.id = s.namespace_id
        where n.slug = $1 and s.slug = $2 and s.status = 'active' and s.visibility = 'org'`,
      [namespaceSlug, skillSlug],
    );
    const sk = skillRows[0];
    if (!sk) { await client.query("rollback"); return { error: "That skill isn't eligible (must be an active, org-visible skill).", status: 422 }; }
    await client.query(
      `update skill_requests set state = 'fulfilled', fulfilled_skill_id = $2, fulfilled_by_user_id = $3,
              fulfilled_at = now(), updated_at = now()
        where id = $1`,
      [requestId, sk.id, actorUserId],
    );
    await appendAudit(client, {
      actorUserId,
      action: "request.fulfilled",
      targetType: "skill_request",
      targetId: requestId,
      after: { skillId: sk.id, fulfilledBy: actorUserId, via: "existing_skill", namespaceSlug, skillSlug },
    });
    if (r.requester_user_id !== actorUserId) {
      const { rows: byRows } = await client.query<{ display_name: string }>(
        `select display_name from users where id = $1`,
        [actorUserId],
      );
      await client.query(
        `insert into notifications (user_id, type, payload) values ($1, 'request.fulfilled', $2::jsonb)`,
        [r.requester_user_id, JSON.stringify({
          requestId,
          requestTitle: r.title,
          namespaceSlug,
          skillSlug,
          byName: byRows[0]?.display_name ?? null,
        })],
      );
    }
    await client.query("commit");
    return { ok: true };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export interface RequestDuplicateWarning {
  openRequest: { id: string; title: string } | null;
  catalogSkill: { namespaceSlug: string; skillSlug: string; title: string } | null;
}

/** Advisory soft-warn (§26): similar open request / visible catalog skill by title substring. */
export async function findSimilar(title: string, visibleNamespaceIds: string[] | null): Promise<RequestDuplicateWarning> {
  const t = title.trim();
  if (t.length < 3) return { openRequest: null, catalogSkill: null };
  const term = `%${t.replace(/[\\%_]/g, "\\$&")}%`;
  const [reqs, skills] = await Promise.all([
    pool.query<{ id: string; title: string }>(
      `select id, title from skill_requests
        where state = 'open' and (title ilike $1 escape '\\' or $2 ilike '%' || title || '%')
        order by created_at desc limit 1`,
      [term, t],
    ),
    pool.query<{ namespace_slug: string; skill_slug: string; title: string }>(
      `select n.slug as namespace_slug, s.slug as skill_slug, s.title
         from skills s join namespaces n on n.id = s.namespace_id
        where s.status = 'active' and (s.title ilike $1 escape '\\' or $2 ilike '%' || s.title || '%')
          and ${visibleNamespaceIds === null ? "true" : "(s.visibility = 'org' or s.namespace_id = any($3::uuid[]))"}
        order by s.install_count desc limit 1`,
      visibleNamespaceIds === null ? [term, t] : [term, t, visibleNamespaceIds],
    ),
  ]);
  return {
    openRequest: reqs.rows[0] ?? null,
    catalogSkill: skills.rows[0]
      ? { namespaceSlug: skills.rows[0].namespace_slug, skillSlug: skills.rows[0].skill_slug, title: skills.rows[0].title }
      : null,
  };
}
