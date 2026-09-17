// Unauthenticated, content-addressed skill icon bytes (§33.6/§15). The sha256 in the URL is an
// unguessable 256-bit address handed out only through visibility-filtered API responses (or the
// signed share card), so serving it without auth leaks nothing beyond "this exact image exists".
// Immutable — the content hash IS the cache key — so a long, public max-age is safe.
import { getIconBytes } from "../../../lib/icons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHA256_RE = /^[0-9a-f]{64}$/;

export async function GET(_req: Request, ctx: { params: Promise<{ filename: string }> }) {
  const { filename } = await ctx.params;
  const sha256 = filename.endsWith(".png") ? filename.slice(0, -4) : filename;
  if (!SHA256_RE.test(sha256)) return new Response("not found", { status: 404 });
  const bytes = await getIconBytes(sha256);
  if (!bytes) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
