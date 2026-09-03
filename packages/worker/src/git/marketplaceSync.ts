// Marketplace synthesis sweep — leader-only, interval-driven. SKILLY_SPEC.md §30.5.
//
// Marketplaces are EVENTUALLY CONSISTENT by design: rebuilding one rewrites a whole repo, which
// must not sit in the publish path. Each pass rebuilds only the marketplaces whose content
// actually changed, decided by a content hash carried in the manifest's own `version` field —
// so the repo is its own state store and there is no separate bookkeeping table to drift.
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  DEFAULT_MARKETPLACE_NAME_PREFIX,
  PUBLIC_SCOPE,
  bundleContentCap,
  marketplaceName,
  resolveLatest,
  validateMarketplacePrefix,
  type MarketplaceScope,
} from "@skilly/shared";
import { getMaxBundleBytes } from "../settings.js";
import type { ArtifactStore } from "../storage/objectStore.js";
import { extractBundle } from "./bundle.js";
import { runGit } from "./synth.js";
import {
  marketplaceRepoDir,
  removeMarketplaceRepo,
  synthesizeMarketplace,
  type MarketplaceChange,
  type MarketplacePlugin,
} from "./marketplace.js";
import { stampMarketplaceSynced } from "./syncStamp.js";

export interface MarketplaceSyncDeps {
  store: ArtifactStore;
  repoRoot: string;
}

/** One marketplace's identity + settings, as resolved for a sweep pass. */
interface Target {
  scope: MarketplaceScope;
  namespaceId: string | null;
  ownerName: string;
  ownerEmail: string | null;
  enabled: boolean;
}

interface SkillRow {
  skill_id: string;
  slug: string;
  title: string;
  description: string | null;
  tags: string[] | null;
  artifact_object_key: string | null;
  semver: string;
  category: string | null;
  ns_slug: string;
}

/** Platform settings this sweep reads (§30.2, §30.5). Falls back to the shipped defaults. */
export async function marketplaceSettings(pool: Pool): Promise<{ publicEnabled: boolean; syncMinutes: number; prefix: string }> {
  const { rows } = await pool.query<{ key: string; value: unknown }>(
    `select key, value from platform_settings
      where key in ('marketplace_public_enabled', 'marketplace_sync_minutes', 'marketplace_name_prefix')`,
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const minutes = map.get("marketplace_sync_minutes");
  const prefix = map.get("marketplace_name_prefix");
  return {
    publicEnabled: map.get("marketplace_public_enabled") === true,
    syncMinutes: Number.isInteger(minutes) && (minutes as number) >= 1 && (minutes as number) <= 1440 ? (minutes as number) : 30,
    prefix: typeof prefix === "string" && validateMarketplacePrefix(prefix) === null ? prefix : DEFAULT_MARKETPLACE_NAME_PREFIX,
  };
}

/**
 * Content hash of a marketplace's qualifying skill set (§30.5). Covers everything that appears in
 * the manifest or the served bytes, so a change to any of them forces a rebuild — and nothing
 * else does. Stored as the manifest's `version`, read back on the next pass.
 */
function contentHash(rows: readonly SkillRow[]): string {
  const h = createHash("sha256");
  for (const r of [...rows].sort((a, b) => a.slug.localeCompare(b.slug))) {
    // Fields and rows are delimited by distinct separators: a single shared separator
    // would let ("a b", "c") and ("a", "b c") hash identically, so an edit that merely
    // moved a word between two fields could go unrebuilt.
    h.update([r.slug, r.title, r.description ?? "", (r.tags ?? []).join(","), r.category ?? "", r.semver, r.artifact_object_key ?? ""].join("\u001f"));
    h.update("\u001e");
  }
  return h.digest("hex").slice(0, 16);
}

/** The previous manifest, read straight out of the repo. Null when never synthesized. */
async function previousManifest(dir: string): Promise<{ version: string; versions: Map<string, string> } | null> {
  try {
    const raw = await runGit(["show", "main:.claude-plugin/marketplace.json"], { gitDir: dir });
    const parsed = JSON.parse(raw) as { version?: string; plugins?: { name?: string; version?: string }[] };
    const versions = new Map<string, string>();
    for (const p of parsed.plugins ?? []) if (p.name && p.version) versions.set(p.name, p.version);
    return { version: String(parsed.version ?? ""), versions };
  } catch {
    return null;
  }
}

/** added / updated / removed between the previous manifest and the new skill set (§30.5). */
function diffChange(prev: Map<string, string> | null, next: readonly SkillRow[]): MarketplaceChange {
  const change: MarketplaceChange = { added: [], updated: [], removed: [] };
  const nextMap = new Map(next.map((r) => [r.slug, r.semver]));
  for (const [slug, semver] of nextMap) {
    const before = prev?.get(slug);
    if (before === undefined) change.added.push(slug);
    else if (before !== semver) change.updated.push(slug);
  }
  for (const slug of prev?.keys() ?? []) if (!nextMap.has(slug)) change.removed.push(slug);
  return change;
}

/**
 * The skills a marketplace publishes (§30.1). The two sets are DISJOINT by construction:
 * the public marketplace takes org-visible skills across all namespaces; a namespace
 * marketplace takes only that namespace's namespace-visibility skills. Only active skills with
 * at least one git-published active version qualify, and the listed version is the latest STABLE
 * one — a skill whose only versions are prereleases is not listed at all.
 */
async function qualifyingSkills(pool: Pool, scope: MarketplaceScope, namespaceId: string | null): Promise<SkillRow[]> {
  const { rows } = await pool.query<SkillRow & { semvers: string[] }>(
    `select s.id as skill_id, s.slug, s.title, s.description, s.tags, n.slug as ns_slug,
            (select c.name from skill_categories sc join categories c on c.id = sc.category_id
              where sc.skill_id = s.id order by c.name limit 1) as category,
            array_agg(sv.semver order by sv.created_at) as semvers
       from skills s
       join namespaces n on n.id = s.namespace_id
       join skill_versions sv on sv.skill_id = s.id and sv.status = 'active' and sv.git_published
      where s.status = 'active'
        and ${scope.kind === "public" ? `s.visibility = 'org'` : `s.visibility = 'namespace' and s.namespace_id = $1`}
      group by s.id, n.slug`,
    scope.kind === "public" ? [] : [namespaceId],
  );

  const out: SkillRow[] = [];
  for (const r of rows) {
    const latest = resolveLatest(r.semvers);
    if (!latest) continue; // prerelease-only skill: no stable version to publish
    const { rows: keyRows } = await pool.query<{ artifact_object_key: string | null }>(
      `select artifact_object_key from skill_versions where skill_id = $1 and semver = $2`,
      [r.skill_id, latest],
    );
    const key = keyRows[0]?.artifact_object_key ?? null;
    if (!key) continue; // nothing to serve
    out.push({ ...r, semver: latest, artifact_object_key: key });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Every marketplace this platform could serve, enabled or not. */
async function targets(pool: Pool, publicEnabled: boolean): Promise<Target[]> {
  const { rows } = await pool.query<{ id: string; slug: string; display_name: string; maintainer_contact: string | null; marketplace_enabled: boolean }>(
    `select id, slug, display_name, maintainer_contact, marketplace_enabled from namespaces order by slug`,
  );
  const registryHost = hostOf(process.env.SKILLY_REGISTRY_URL);
  return [
    { scope: PUBLIC_SCOPE, namespaceId: null, ownerName: registryHost, ownerEmail: null, enabled: publicEnabled },
    ...rows.map((n) => ({
      scope: { kind: "namespace" as const, namespaceSlug: n.slug },
      namespaceId: n.id,
      ownerName: n.display_name,
      ownerEmail: n.maintainer_contact,
      enabled: n.marketplace_enabled,
    })),
  ];
}

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").host || "skilly";
  } catch {
    return "skilly";
  }
}

/**
 * One sweep pass. Rebuilds every enabled marketplace whose content changed, and removes the repo
 * of every disabled one. Returns how many were rebuilt. Never throws for one bad marketplace —
 * a failure is logged and the next pass retries it.
 */
export async function syncMarketplaces(pool: Pool, deps: MarketplaceSyncDeps): Promise<number> {
  const { publicEnabled, prefix } = await marketplaceSettings(pool);
  const cap = bundleContentCap(await getMaxBundleBytes(pool));
  const registryBase = process.env.SKILLY_REGISTRY_URL ?? "";
  let rebuilt = 0;

  for (const target of await targets(pool, publicEnabled)) {
    const dir = marketplaceRepoDir(deps.repoRoot, target.scope);
    try {
      if (!target.enabled) {
        // Disable = the repo is gone, not merely unadvertised (§30.6). Idempotent.
        await removeMarketplaceRepo(deps.repoRoot, target.scope);
        continue;
      }

      const skills = await qualifyingSkills(pool, target.scope, target.namespaceId);
      const hash = contentHash(skills);
      const prev = await previousManifest(dir);
      if (prev && prev.version === hash) {
        // Nothing changed — no commit, no consumer churn. Still "synced": the catalog was checked
        // and the repo matches it, which is what the Marketplaces page's freshness line reports.
        await stampMarketplaceSynced(pool, target.scope, target.namespaceId);
        continue;
      }

      const plugins: MarketplacePlugin[] = [];
      for (const s of skills) {
        const targz = await deps.store.get(s.artifact_object_key!);
        plugins.push({
          skillSlug: s.slug,
          title: s.title,
          description: s.description,
          version: s.semver,
          tags: s.tags ?? [],
          category: s.category,
          homepage: registryBase ? `${registryBase.replace(/\/+$/, "")}/skills/${s.ns_slug}/${s.slug}` : null,
          files: await extractBundle(targz, cap),
        });
      }

      await synthesizeMarketplace({
        bareRepoPath: dir,
        manifest: {
          prefix,
          scope: target.scope,
          ownerName: target.ownerName,
          ownerEmail: target.ownerEmail,
          version: hash,
        },
        plugins,
        change: diffChange(prev?.versions ?? null, skills),
      });
      rebuilt++;
      // Stamped only after the rebuild succeeded: a failed synthesis is not "synced" (§30.5).
      await stampMarketplaceSynced(pool, target.scope, target.namespaceId);
      console.log(JSON.stringify({ level: "info", msg: "marketplace synthesized", marketplace: marketplaceName(prefix, target.scope), skills: skills.length }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "marketplace sync failed", scope: target.scope, err: String(err) }));
    }
  }
  return rebuilt;
}
