// Platform-admin: read/update platform settings (e.g. contribution policy). SKILLY_SPEC.md §4.
import { currentAccess } from "../../../../lib/guard";
import { pool } from "../../../../lib/db";
import { getPlatformSettings, setProposalsOpen, setDateFormat, setDuplicateEnforcement, setMaxBundleBytes, setUploadChunkMb, setChatPollIntervals, setInstallMaxTtlMonths, setMaxFeaturedSkills, BUNDLE_SIZE_OPTIONS } from "../../../../lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access?.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  return Response.json(await getPlatformSettings(pool));
}

export async function PATCH(req: Request) {
  const access = await currentAccess();
  if (!access?.userId || !access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { proposalsOpen?: boolean; dateFormat?: string; duplicateEnforcement?: string; maxBundleBytes?: number; uploadChunkMb?: number; chatPollIntervals?: string | number[]; installMaxTtlMonths?: number; maxFeaturedSkills?: number };
  if (typeof body.proposalsOpen === "boolean") await setProposalsOpen(body.proposalsOpen, access.userId);
  if (body.dateFormat === "eu" || body.dateFormat === "us") await setDateFormat(body.dateFormat, access.userId);
  if (body.duplicateEnforcement === "block" || body.duplicateEnforcement === "warn") await setDuplicateEnforcement(body.duplicateEnforcement, access.userId);
  if (typeof body.maxBundleBytes === "number" && (BUNDLE_SIZE_OPTIONS as readonly number[]).includes(body.maxBundleBytes)) await setMaxBundleBytes(body.maxBundleBytes, access.userId);
  if (body.uploadChunkMb !== undefined) {
    try {
      await setUploadChunkMb(body.uploadChunkMb, access.userId);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "invalid upload chunk size" }, { status: 422 });
    }
  }
  if (body.chatPollIntervals !== undefined) {
    try {
      await setChatPollIntervals(body.chatPollIntervals, access.userId);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "invalid chat poll intervals" }, { status: 422 });
    }
  }
  if (body.installMaxTtlMonths !== undefined) {
    try {
      await setInstallMaxTtlMonths(body.installMaxTtlMonths, access.userId);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "invalid install URL expiry" }, { status: 422 });
    }
  }
  if (body.maxFeaturedSkills !== undefined) {
    try {
      await setMaxFeaturedSkills(body.maxFeaturedSkills, access.userId);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "invalid featured-skills cap" }, { status: 422 });
    }
  }
  return Response.json(await getPlatformSettings(pool));
}
