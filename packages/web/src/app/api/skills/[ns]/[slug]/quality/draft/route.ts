// Run an AI quality draft (SKILLY_SPEC.md §44.5): one §40 call per planned file, streamed back as
// NDJSON (plan → start/file events → heartbeat every 15 s → done with the run token). Nothing is
// stored; closing the connection cancels the files not yet finished. Effective maintainers and
// platform admins only; 10 runs per user per 10 minutes.
import { currentAccess } from "../../../../../../../lib/guard";
import { loadDraftContext, runDraft, type DraftEvent } from "../../../../../../../lib/qualityDraft";
import { enforceRateLimit } from "../../../../../../../lib/ratelimit";
import { DRAFT_RATE_LIMIT, DRAFT_RATE_WINDOW_MS } from "@skilly/shared";

export const dynamic = "force-dynamic";
// The run may take up to the 30-minute cap; never let the platform cut it short.
export const maxDuration = 1800;

export async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { ns, slug } = await ctx.params;
  const r = await loadDraftContext(access, ns, slug);
  if (!r.ok) return Response.json({ error: r.status === 409 ? "ai_draft_unavailable" : r.error, reason: r.reason ?? null, message: r.error }, { status: r.status });
  const body = (await req.json().catch(() => null)) as { baseSemver?: unknown } | null;
  if (!body || body.baseSemver !== r.ctx.semver) {
    return Response.json({ error: "base_changed", message: `the latest version is now v${r.ctx.semver} — reload the page`, baseSemver: r.ctx.semver }, { status: 409 });
  }
  const limited = enforceRateLimit("quality-draft", access.userId, DRAFT_RATE_LIMIT, DRAFT_RATE_WINDOW_MS);
  if (limited) return limited;

  const user = { ...access, userId: access.userId };
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const emit = (e: DraftEvent) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`));
        } catch {
          open = false;
        }
      };
      runDraft(user, r.ctx, emit, { signal: req.signal })
        .catch((err) => {
          console.error(JSON.stringify({ level: "error", msg: "ai draft run failed", err: String((err as Error)?.message ?? err) }));
          emit({ type: "file", path: "", status: "failed", summary: "", addressed: [], reason: "run_failed", reasonText: "the draft could not be completed" });
        })
        .finally(() => {
          if (!open) return;
          open = false;
          try {
            controller.close();
          } catch {
            /* already closed by a disconnect */
          }
        });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
