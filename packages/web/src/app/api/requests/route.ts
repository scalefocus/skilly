// "Request a skill" (§26): list open requests + create one. Auth-required; requests are
// org-visible (no namespace) and TEXT-ONLY — no file attachments. POST stays multipart (the form
// posts FormData) but rejects any file part so the text-only contract is enforced server-side.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { enforceRateLimit } from "../../../lib/ratelimit";
import { listOpenRequests, listMyRequests, createRequest, findSimilar, type RequestState } from "../../../lib/requests";
import { getNavSeen } from "../../../lib/settings";
import { withSystemLog } from "../../../lib/apiLog";

export const dynamic = "force-dynamic";

export const GET = withSystemLog("/api/requests", async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const url = new URL(req.url);
  const access = await resolveUserAccess(oid);
  // Advisory pre-post similar-check (soft-warn, §26): the propose form calls this before posting.
  const similarTo = url.searchParams.get("similarTo");
  if (similarTo) {
    const similar = await findSimilar(similarTo.slice(0, 200), access.isPlatformAdmin ? null : [...access.namespaceRoles.keys()]);
    return Response.json({ similar });
  }
  const isAdmin = access.isPlatformAdmin;
  // "Mine" toggle (§26): the caller's own requests, any state — instead of the org-wide open list.
  if (url.searchParams.get("mine") === "1") {
    if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
    const requests = await listMyRequests(access.userId, {
      q: url.searchParams.get("q")?.slice(0, 200) ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
      tool: url.searchParams.get("tool") ?? undefined,
    });
    return Response.json({ requests, isAdmin });
  }
  // State filter (§26): everyone sees OPEN only; a platform admin may also list `fulfilled` or all
  // (Open | Fulfilled | All). The gate is here — a non-admin `state` param is ignored (→ open).
  let states: RequestState[] | undefined;
  const stateParam = url.searchParams.get("state");
  if (isAdmin && (stateParam === "fulfilled" || stateParam === "all")) {
    states = stateParam === "all" ? ["open", "fulfilled"] : ["fulfilled"];
  }
  // "New to you" per-row flag (§26) — same pattern as /api/skills' catalogSeenAt. Only meaningful on
  // the default open view; listOpenRequests only flags open rows anyway.
  const seenAt = access.userId ? (await getNavSeen(access.userId)).requestsSeenAt : null;
  const requests = await listOpenRequests({
    q: url.searchParams.get("q")?.slice(0, 200) ?? undefined,
    category: url.searchParams.get("category") ?? undefined,
    tool: url.searchParams.get("tool") ?? undefined,
    seenAt,
    states,
  });
  return Response.json({ requests, isAdmin });
});

export const POST = withSystemLog("/api/requests", async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("requests", access.userId, 10);
  if (limited) return limited;

  const form = await req.formData();
  // Requests are text-only (§26): strict-reject any file part rather than silently dropping it.
  if (form.getAll("files").some((f) => f instanceof File)) {
    return Response.json({ error: "skill requests do not accept file attachments" }, { status: 422 });
  }
  const title = String(form.get("title") ?? "");
  const description = String(form.get("description") ?? "");
  const usageExamples = form.get("usageExamples") == null ? null : String(form.get("usageExamples"));
  const toolHarness = String(form.get("toolHarness") ?? "generic");
  let categories: string[] = [];
  try {
    categories = JSON.parse(String(form.get("categories") ?? "[]")) as string[];
    if (!Array.isArray(categories) || categories.some((c) => typeof c !== "string")) throw new Error();
  } catch {
    return Response.json({ error: "categories must be a JSON string array" }, { status: 422 });
  }

  const result = await createRequest(access.userId, { title, description, usageExamples, toolHarness, categories });
  if ("error" in result) return Response.json({ error: result.error }, { status: 422 });

  // Advisory duplicate soft-warn (§26): similar open request / visible catalog skill. Never blocks.
  const similar = await findSimilar(title, access.isPlatformAdmin ? null : [...access.namespaceRoles.keys()]);
  return Response.json({ id: result.id, similar }, { status: 201 });
});
