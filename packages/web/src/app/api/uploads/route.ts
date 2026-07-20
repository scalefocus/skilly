// Bundle upload (hosted skills). The proposer uploads a tar.gz BEFORE creating a proposal.
// We extract, BLOCKING-validate, ADVISORY-scan (writing an artifact-keyed scan report so
// reviewers see findings pre-accept), store the bundle, and return the key + sha + scan
// summary for the subsequent POST /api/proposals. SKILLY_SPEC.md §6, §8, §9.
//
// This is the SINGLE-SHOT path (bundles at or below the configured chunk size, or clients that
// don't chunk). Bundles above the chunk size go through /api/uploads/chunked (§6), which ends in
// the same processBundleUpload pipeline.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { enforceRateLimit } from "../../../lib/ratelimit";
import { getMaxBundleBytes } from "../../../lib/settings";
import { withSystemLog } from "../../../lib/apiLog";
import { processBundleUpload, fmtSize } from "../../../lib/uploadPipeline";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/uploads", async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("uploads", access.userId, 20);
  if (limited) return limited;

  // The admin-configured maximum bundle size (§6) is the user-facing limit. Route Handlers have
  // NO default body limit (next.config bodySizeLimit only covers Server Actions), so cap
  // explicitly — first by Content-Length (before buffering), then by the parsed blob size.
  const maxBytes = await getMaxBundleBytes();

  // Reject oversized bodies before reading/parsing them into memory.
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    return Response.json({ error: `the bundle is bigger than the allowed size of ${fmtSize(maxBytes)}` }, { status: 413 });
  }

  // An unparseable multipart body is a CLIENT/TRANSPORT problem, not a server fault (§6): the
  // classic cause is a proxy between the browser and skilly cutting the body short (a size or
  // timeout ceiling), which leaves the multipart stream without its closing boundary. Answer a
  // clear 400 instead of letting the TypeError surface as an opaque 500 in the System log.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json(
      { error: "the upload didn’t arrive intact — a proxy between your browser and skilly may have cut it off. Try again; large bundles upload in pieces automatically from the propose form." },
      { status: 400 },
    );
  }
  const file = form.get("bundle");
  const skillSlug = String(form.get("skillSlug") ?? "");
  if (!(file instanceof Blob) || !skillSlug) {
    return Response.json({ error: "multipart 'bundle' (.tar.gz, .zip, or .skill) and 'skillSlug' required" }, { status: 400 });
  }

  const bundleBytes = Buffer.from(await file.arrayBuffer());
  // Pass the original filename so a `.skill`/`.zip` export whose magic bytes don't sniff cleanly
  // still extracts as a zip instead of being rejected as an unsupported archive. §6.
  const filename = file instanceof File ? file.name : undefined;
  return processBundleUpload({ ...access, userId: access.userId }, bundleBytes, filename, skillSlug, maxBytes);
});
