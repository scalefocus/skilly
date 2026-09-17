// Skill icon upload (§33.3). The proposer uploads an image BEFORE creating a proposal, mirroring
// the hosted-bundle upload flow: validate (format/size/dimensions) → normalize (re-encode to a
// 256×256 PNG, metadata stripped — this IS the sanitizer, so icons deliberately skip ClamAV, §22)
// → store content-addressed. The returned sha256 is referenced from the proposal/publish payload,
// where verifySubmissionPayload enforces ownership.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { enforceRateLimit } from "../../../lib/ratelimit";
import { withSystemLog } from "../../../lib/apiLog";
import { ingestIcon, iconUrl } from "../../../lib/icons";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/icons", async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("icons", access.userId, 30);
  if (limited) return limited;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "the upload didn’t arrive intact — try again" }, { status: 400 });
  }
  const file = form.get("icon");
  if (!(file instanceof Blob)) {
    return Response.json({ error: "multipart 'icon' (PNG, JPEG, or WebP) required" }, { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await ingestIcon(bytes, access.userId);
  if (!result.ok) return Response.json({ error: result.error.error }, { status: result.error.status });
  return Response.json({ sha256: result.sha256, url: iconUrl(result.sha256) }, { status: 201 });
});
