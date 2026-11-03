// The assignee picker for one proposal (SKILLY_SPEC.md §65.2): the eligible reviewers — the
// namespace's admins first, then platform admins and the bootstrap group — never the proposer.
// Reviewers of the proposal's namespace only; anyone else gets 404.
import { canReviewNamespace } from "@skilly/shared";
import { currentAccess } from "../../../../../lib/guard";
import { pool } from "../../../../../lib/db";
import { listAssignableReviewers } from "../../../../../lib/reviewAssign";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const id = (await ctx.params).id;
  if (!UUID.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const { rows } = await pool.query<{ target_namespace_id: string; submitted_by: string }>(
    `select target_namespace_id, submitted_by from proposals where id = $1`,
    [id],
  );
  const p = rows[0];
  if (!p || !canReviewNamespace(access, p.target_namespace_id)) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ reviewers: await listAssignableReviewers(pool, p.target_namespace_id, p.submitted_by) });
}
