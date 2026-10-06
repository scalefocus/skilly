// "Draft with AI" on the propose form (SKILLY_SPEC.md §43.5). GET → { available } (the button
// renders only when true); POST drafts the description, usage and categories from the SKILL.md of
// a hosted bundle (multipart `file`, extracted and discarded), a pointer source (JSON) or the
// Keep-current-files artifact (JSON). Any authenticated user — the implicit propose right (§4).
// Nothing is stored or audited; bodies are never logged.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { withSystemLog } from "../../../../lib/apiLog";
import { aiAvailable } from "../../../../lib/ai";
import { draftWithAi, type DraftSource } from "../../../../lib/aiDraft";
import type { EffectiveAccess } from "@skilly/shared";
import { getUploadChunkBytes } from "../../../../lib/settings";

export const dynamic = "force-dynamic";

async function authenticate(): Promise<{ error: Response } | { access: EffectiveAccess & { userId: string } }> {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return { error: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  const access = await resolveUserAccess(oid);
  if (!access.userId) return { error: Response.json({ error: "unknown user" }, { status: 403 }) };
  return { access: { ...access, userId: access.userId } };
}

export const GET = withSystemLog("/api/propose/ai-draft", async function GET() {
  const a = await authenticate();
  if ("error" in a) return a.error;
  return Response.json({ available: await aiAvailable() });
});

/** Multipart framing headroom over the single-request size before we refuse to buffer the body. */
const MULTIPART_SLACK_BYTES = 1024 * 1024;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export const POST = withSystemLog("/api/propose/ai-draft", async function POST(req: Request) {
  const a = await authenticate();
  if ("error" in a) return a.error;

  let source: DraftSource;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    // Refuse to buffer a body far above the single-request size (the exact cap is checked on the file).
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > (await getUploadChunkBytes()) + MULTIPART_SLACK_BYTES) {
      return Response.json({ error: "draft_bundle_too_large", message: "Bundle too large to draft from." }, { status: 413 });
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: "the upload didn’t arrive intact — try again" }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof Blob)) return Response.json({ error: "multipart 'file' required" }, { status: 400 });
    source = { kind: "hosted", bytes: Buffer.from(await file.arrayBuffer()), filename: file instanceof File ? file.name : undefined };
  } else {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body?.source === "pointer") {
      const externalUrl = str(body.externalUrl);
      const externalRef = str(body.externalRef);
      const skillSlug = str(body.skillSlug);
      if (!externalUrl || !externalRef || !skillSlug) {
        return Response.json({ error: "externalUrl, externalRef and skillSlug are required" }, { status: 400 });
      }
      source = { kind: "pointer", externalUrl, externalRef, externalSubdir: str(body.externalSubdir) || null, skillSlug };
    } else if (body?.source === "reuse") {
      const namespace = str(body.namespace);
      const skill = str(body.skill);
      if (!namespace || !skill) return Response.json({ error: "namespace and skill are required" }, { status: 400 });
      source = { kind: "reuse", namespace, skill };
    } else {
      return Response.json({ error: "send a multipart 'file', or JSON with source 'pointer' or 'reuse'" }, { status: 400 });
    }
  }

  const r = await draftWithAi(a.access, source);
  return Response.json(r.body, { status: r.status });
});
