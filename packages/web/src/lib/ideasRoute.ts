// Shared guards for the feature-ideas routes (SKILLY_SPEC.md §60.11): who the caller is, whether
// the feature is on, and how a refusal from lib/ideas.ts becomes a response.
import { currentAccess } from "./guard";
import { getFeatureIdeasEnabled } from "./settings";
import type { AdminIdeaResult, IdeaViewer, OwnIdeaResult } from "./ideas";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isIdeaId(id: string): boolean {
  return UUID_RE.test(id);
}

export const notFound = (): Response => Response.json({ error: "not found" }, { status: 404 });

/**
 * A signed-in caller of the user routes. While the switch is off the routes do not exist (404), so
 * Coming soon falls back to the §23 list (§60.9).
 */
export async function ideasCaller(): Promise<{ ok: true; viewer: IdeaViewer } | { ok: false; res: Response }> {
  const access = await currentAccess();
  if (!access) return { ok: false, res: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  if (!access.userId) return { ok: false, res: Response.json({ error: "unknown user" }, { status: 403 }) };
  if (!(await getFeatureIdeasEnabled())) return { ok: false, res: notFound() };
  return {
    ok: true,
    viewer: {
      userId: access.userId,
      isPlatformAdmin: access.isPlatformAdmin,
      administersNamespace: [...access.namespaceRoles.values()].includes("namespace_admin"),
    },
  };
}

/**
 * A platform admin on the admin routes (403 otherwise). Reads work while the switch is off (the page
 * stays readable); writes answer 409 then (§60.5, §60.11).
 */
export async function ideasAdminCaller(write: boolean): Promise<{ ok: true; userId: string; enabled: boolean } | { ok: false; res: Response }> {
  const access = await currentAccess();
  if (!access) return { ok: false, res: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  if (!access.userId || !access.isPlatformAdmin) return { ok: false, res: Response.json({ error: "platform admin required" }, { status: 403 }) };
  const enabled = await getFeatureIdeasEnabled();
  if (write && !enabled) return { ok: false, res: Response.json({ error: "feature ideas are switched off" }, { status: 409 }) };
  return { ok: true, userId: access.userId, enabled };
}

/** A lib/ideas.ts result as a response: 204 on success, the refusal's status and error otherwise. */
export function ideaResultResponse(r: AdminIdeaResult | OwnIdeaResult): Response {
  if (r.ok) return new Response(null, { status: 204 });
  return Response.json({ error: r.error }, { status: r.status });
}

/** The request's JSON object body, or {} for anything else. */
export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => ({}));
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
