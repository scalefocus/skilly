// The switch state behind the "not available here" achievement tile (SKILLY_SPEC.md §31.12.4), for
// one caller. Kept out of lib/achievements.ts so the award helper (imported by the hype, proposal
// and AI write paths) does not import those modules back.
import type { EffectiveAccess } from "@skilly/shared";
import type { AchievementFlags } from "@skilly/shared/achievements";
import { aiAvailable } from "./ai";
import { getHypeSettings } from "./hype";
import { marketplaceReachable } from "./marketplaceDirectory";
import { getMarketplacePublicEnabled, getMcpEnabled } from "./settings";

export async function achievementFlagsFor(access: EffectiveAccess): Promise<AchievementFlags> {
  const [hype, ai, mcp, publicEnabled] = await Promise.all([getHypeSettings(), aiAvailable(), getMcpEnabled(), getMarketplacePublicEnabled()]);
  return {
    hypeEnabled: hype.enabled,
    aiAvailable: ai,
    mcpEnabled: mcp,
    marketplaceReachable: await marketplaceReachable(access, publicEnabled),
  };
}
