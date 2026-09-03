// Marketplace freshness stamp (SKILLY_SPEC.md §30.5). The sweep records WHEN it last evaluated each
// enabled marketplace — whether or not the content hash changed — so the Marketplaces page can say
// "synced N min ago" next to a live skill count (§30.6 Page 3). "Synced" means "checked against the
// catalog", not "committed": an unchanged marketplace is still up to date.
//
// A namespace marketplace stamps `namespaces.marketplace_synced_at`; the public marketplace, having
// no namespace row, stamps the platform_settings key `marketplace_public_synced_at` — worker-written
// state in platform_settings, exactly like `related_last_run_at`. The value is an ISO-8601 string so
// the web tier parses it without depending on Postgres' text rendering of a timestamp.
import type { MarketplaceScope } from "@skilly/shared";

/** The subset of `pg.Pool` / `pg.PoolClient` this module needs — lets tests pass a recorder. */
export interface StampDb {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

export const PUBLIC_SYNCED_AT_KEY = "marketplace_public_synced_at";

export async function stampMarketplaceSynced(
  db: StampDb,
  scope: MarketplaceScope,
  namespaceId: string | null,
  at: Date = new Date(),
): Promise<void> {
  if (scope.kind === "public") {
    await db.query(
      `insert into platform_settings (key, value, updated_at) values ($1, to_jsonb($2::text), now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [PUBLIC_SYNCED_AT_KEY, at.toISOString()],
    );
    return;
  }
  if (!namespaceId) throw new Error("stampMarketplaceSynced: a namespace marketplace needs its namespace id");
  await db.query(`update namespaces set marketplace_synced_at = $2 where id = $1`, [namespaceId, at]);
}
