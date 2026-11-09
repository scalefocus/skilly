// The caller's usage key — the consent handle behind §68 Usage insights (SKILLY_SPEC.md §68.4).
// One per user, no expiry, hashed at rest; the raw key is returned exactly once, by the mint, with
// the `~/.claude/settings.json` fragment the person pastes. Not audited: a personal credential, like
// install and marketplace tokens (§11).
import { buildUsageKeySnippet, deleteUsageKey, getUsageKeyState, mintUsageKey, regenerateUsageKey, usageKeyEnvVar, type UsageKeyState } from "@skilly/shared";
import { pool } from "./db";
import { getMarketplaceNamePrefix, getUsageInsightsEnabled } from "./settings";

/** What the mint response carries (§68.8): the raw key, its variable name and the paste-ready fragment. */
export interface MintedUsageKey {
  key: string;
  envVar: string;
  snippet: string;
  createdAt: string;
}

/** The variable name for this instance (§68.4) — derived from the marketplace name prefix. */
export async function usageKeyVariable(): Promise<string> {
  return usageKeyEnvVar(await getMarketplaceNamePrefix());
}

/** Mint the caller's key; null when they already hold one (the route answers 409 `usage_key_exists`). */
export async function mintCallerUsageKey(userId: string): Promise<MintedUsageKey | null> {
  const minted = await mintUsageKey(pool, userId);
  if (!minted) return null;
  return await describe(minted);
}

/** Replace the caller's key (or mint one when none exists). The old key stops working at once. */
export async function regenerateCallerUsageKey(userId: string): Promise<MintedUsageKey> {
  return await describe(await regenerateUsageKey(pool, userId));
}

/** Stop sharing. True when a key was deleted. */
export async function deleteCallerUsageKey(userId: string): Promise<boolean> {
  return deleteUsageKey(pool, userId);
}

/** The `usageSharing` block of `GET /api/marketplaces` (§68.8). */
export async function usageSharingState(userId: string): Promise<{ enabled: boolean; envVar: string; key: UsageKeyState | null }> {
  const [enabled, envVar, key] = await Promise.all([getUsageInsightsEnabled(), usageKeyVariable(), getUsageKeyState(pool, userId)]);
  return { enabled, envVar, key };
}

async function describe(minted: { raw: string; createdAt: string }): Promise<MintedUsageKey> {
  const envVar = await usageKeyVariable();
  return { key: minted.raw, envVar, snippet: buildUsageKeySnippet(envVar, minted.raw), createdAt: minted.createdAt };
}
