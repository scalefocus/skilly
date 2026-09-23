// Platform-admin: read/update platform settings (e.g. contribution policy). SKILLY_SPEC.md §4.
import { currentAccess } from "../../../../lib/guard";
import { pool } from "../../../../lib/db";
import { setSearchLanguage, SearchAdminError } from "../../../../lib/searchAdmin";
import { getPlatformSettings, setProposalsOpen, setDateFormat, setDuplicateEnforcement, setMaxBundleBytes, setUploadChunkMb, setChatPollIntervals, setInstallMaxTtlMonths, setMaxFeaturedSkills, setMcpEnabled, setMcpAccessTtlMinutes, setMcpRefreshTtlDays, setMcpMaxInlineUploadBytes, setMcpMaxResourceBytes, setMarketplacePublicEnabled, setMarketplaceSyncMinutes, setMarketplaceNamePrefix, setAchievementsEnabled, setRumEnabled, setRumSampleRate, setRumFlushIntervals, BUNDLE_SIZE_OPTIONS } from "../../../../lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access?.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  return Response.json(await getPlatformSettings(pool));
}

export async function PATCH(req: Request) {
  const access = await currentAccess();
  if (!access?.userId || !access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { proposalsOpen?: boolean; dateFormat?: string; duplicateEnforcement?: string; maxBundleBytes?: number; uploadChunkMb?: number; chatPollIntervals?: string | number[]; installMaxTtlMonths?: number; maxFeaturedSkills?: number; mcpEnabled?: boolean; mcpAccessTtlMinutes?: number; mcpRefreshTtlDays?: number; mcpMaxInlineUploadBytes?: number; mcpMaxResourceBytes?: number; marketplacePublicEnabled?: boolean; marketplaceSyncMinutes?: number; marketplaceNamePrefix?: string; achievementsEnabled?: boolean; rumEnabled?: boolean; rumSampleRate?: number; rumFlushIntervals?: string | number[]; searchLanguage?: string };
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
  // §29 MCP server: the on/off toggle plus the two token lifetimes.
  if (typeof body.mcpEnabled === "boolean") await setMcpEnabled(body.mcpEnabled, access.userId);
  // §31 achievements: dormant-not-destructive on/off.
  if (typeof body.achievementsEnabled === "boolean") await setAchievementsEnabled(body.achievementsEnabled, access.userId);
  // §32 real user monitoring: the collect switch + the per-session sample rate.
  if (typeof body.rumEnabled === "boolean") await setRumEnabled(body.rumEnabled, access.userId);
  if (body.rumSampleRate !== undefined) {
    try {
      await setRumSampleRate(body.rumSampleRate, access.userId);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "invalid RUM sample rate" }, { status: 422 });
    }
  }
  // §32.4/§32.6 the collector's flush ladder — a comma-separated string or an array of seconds.
  if (body.rumFlushIntervals !== undefined) {
    try {
      await setRumFlushIntervals(body.rumFlushIntervals, access.userId);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "invalid RUM flush intervals" }, { status: 422 });
    }
  }
  if (body.mcpAccessTtlMinutes !== undefined) {
    try {
      await setMcpAccessTtlMinutes(body.mcpAccessTtlMinutes, access.userId);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "invalid MCP access-token lifetime" }, { status: 422 });
    }
  }
  if (body.mcpRefreshTtlDays !== undefined) {
    try {
      await setMcpRefreshTtlDays(body.mcpRefreshTtlDays, access.userId);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "invalid MCP refresh-token lifetime" }, { status: 422 });
    }
  }
  // The two byte caps: same shape, so a small table keeps the handler readable.
  for (const [key, setter, label] of [
    ["mcpMaxInlineUploadBytes", setMcpMaxInlineUploadBytes, "invalid MCP inline upload limit"],
    ["mcpMaxResourceBytes", setMcpMaxResourceBytes, "invalid MCP single-read limit"],
  ] as const) {
    const v = (body as Record<string, number | undefined>)[key];
    if (v !== undefined) {
      try {
        await setter(v, access.userId);
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : label }, { status: 422 });
      }
    }
  }
  // Plugin marketplaces (§30). Disabling the public marketplace revokes its tokens, so the
  // response reports how many went — the UI states that up front in its confirm dialog.
  let publicTokensRevoked: number | undefined;
  if (typeof body.marketplacePublicEnabled === "boolean") {
    publicTokensRevoked = await setMarketplacePublicEnabled(body.marketplacePublicEnabled, access.userId);
  }
  if (body.marketplaceSyncMinutes !== undefined) {
    try {
      await setMarketplaceSyncMinutes(body.marketplaceSyncMinutes, access.userId);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "invalid marketplace sync interval" }, { status: 422 });
    }
  }
  if (body.marketplaceNamePrefix !== undefined) {
    try {
      await setMarketplaceNamePrefix(body.marketplaceNamePrefix, access.userId);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "invalid marketplace name prefix" }, { status: 422 });
    }
  }
  // §34.9 search language — one of the server's built-in text-search configurations. The worker
  // rebuilds the vectors behind the switch; search itself switches at once.
  if (body.searchLanguage !== undefined) {
    try {
      await setSearchLanguage(body.searchLanguage, access.userId);
    } catch (e) {
      if (e instanceof SearchAdminError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  }
  return Response.json({ ...(await getPlatformSettings(pool)), publicTokensRevoked });
}
