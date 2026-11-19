// The platform's public signing keys (SKILLY_SPEC.md §73.9) — deliberately UNAUTHENTICATED, like
// /skill-icons/*: keys only (keyId, algorithm, PEM, fingerprint, created / retired / revoked), no
// skill names, counts, hashes or revocation reasons. Offline and CI verifiers pin it.
import { publicKeysDocument } from "../../../lib/signing";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(await publicKeysDocument(), { headers: { "Cache-Control": "public, max-age=300" } });
}
