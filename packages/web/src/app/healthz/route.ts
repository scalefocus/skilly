// Liveness probe. SKILLY_SPEC.md §14.
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ status: "ok" });
}
