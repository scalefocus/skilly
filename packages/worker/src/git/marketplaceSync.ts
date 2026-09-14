// Marketplace synthesis sweep — leader-only, interval-driven. SKILLY_SPEC.md §30.5.
//
// Marketplaces are EVENTUALLY CONSISTENT by design: rebuilding one rewrites a whole repo, which
// must not sit in the publish path. Each pass rebuilds only the marketplaces whose content
// actually changed, decided by a content hash carried in the manifest's own `version` field —
// so the repo is its own state store. The one bookkeeping table is `marketplace_plugins`: the
// per-plugin `1.0.<n>` counters (§30.3), which must survive a rebuild and never go backwards.
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  DEFAULT_MARKETPLACE_NAME_PREFIX,
  PUBLIC_SCOPE,
  bundleContentCap,
  groupSkillsIntoPlugins,
  isComponentPath,
  marketplaceName,
  planPluginLayout,
  pluginDescription,
  pluginHomepage,
  pluginKeywords,
  pluginVersion,
  resolveLatest,
  validateMarketplacePrefix,
  GENERAL_PLUGIN_SLUG,
  type MarketplaceScope,
} from "@skilly/shared";
import { getMaxBundleBytes } from "../settings.js";
import type { ArtifactStore } from "../storage/objectStore.js";
import { extractBundle } from "./bundle.js";
import { runGit, type SkillFile } from "./synth.js";
import {
  marketplaceRepoDir,
  removeMarketplaceRepo,
  servedSkills,
  synthesizeMarketplace,
  type ComponentCollision,
  type MarketplaceChange,
  type MarketplacePluginBuild,
  type ServedSkill,
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
  artifact_object_key: string | null;
  content_sha256: string | null;
  semver: string;
  /** Category slugs, sorted — plugin membership (§30.3) and part of the hash. */
  category_slugs: string[] | null;
  ns_slug: string;
}

interface CategoryRow {
  slug: string;
  name: string;
  description: string | null;
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

/** The `marketplace_plugins.marketplace_key` for a target (§3). */
export function marketplaceKey(scope: MarketplaceScope, namespaceId: string | null): string {
  return scope.kind === "public" ? "public" : `ns:${namespaceId}`;
}

/**
 * Content hash of a marketplace's qualifying skill set (§30.5). Covers everything that appears in
 * the manifest or the served bytes — including the category slugs that decide plugin membership —
 * so a change to any of them forces a rebuild, and nothing else does. Stored as the manifest's
 * `version`, read back on the next pass. Merged component files are a function of the bundle
 * content (`content_sha256`), so they are covered transitively.
 */
export function contentHash(rows: readonly SkillRow[]): string {
  const h = createHash("sha256");
  const sorted = [...rows].sort((a, b) => a.ns_slug.localeCompare(b.ns_slug) || a.slug.localeCompare(b.slug));
  for (const r of sorted) {
    // Fields and rows are delimited by distinct separators: a single shared separator
    // would let ("a b", "c") and ("a", "b c") hash identically, so an edit that merely
    // moved a word between two fields could go unrebuilt.
    h.update([r.ns_slug, r.slug, r.title, r.description ?? "", (r.category_slugs ?? []).join(","), r.semver, r.content_sha256 ?? r.artifact_object_key ?? ""].join("\u001f"));
    h.update("\u001e");
  }
  return h.digest("hex").slice(0, 16);
}

/**
 * Per-plugin fingerprint (§30.3): the delivered bytes of that plugin — members by directory with
 * their version and content digest, plus the merged component files. Unchanged ⇒ the plugin's
 * `1.0.<n>` stays; changed ⇒ it bumps. Title/description edits are deliberately NOT in here.
 */
export function pluginFingerprint(
  members: readonly { skillDir: string; skillId: string; semver: string; contentSha256: string | null }[],
  componentFiles: readonly string[],
): string {
  const h = createHash("sha256");
  for (const m of [...members].sort((a, b) => a.skillDir.localeCompare(b.skillDir))) {
    h.update([m.skillDir, m.skillId, m.semver, m.contentSha256 ?? ""].join("\u001f"));
    h.update("\u001e");
  }
  h.update([...componentFiles].sort().join("\u001f"));
  return h.digest("hex").slice(0, 16);
}

/** The previous manifest's synthesis serial, read straight out of the repo. Null when never synthesized. */
async function previousHash(dir: string): Promise<string | null> {
  try {
    const raw = await runGit(["show", "main:.claude-plugin/marketplace.json"], { gitDir: dir });
    const parsed = JSON.parse(raw) as { version?: string };
    return String(parsed.version ?? "");
  } catch {
    return null;
  }
}

/** added / updated / removed SKILL slugs between the previously served set and the new one (§30.5). */
export function diffChange(prev: readonly ServedSkill[] | null, next: readonly ServedSkill[]): MarketplaceChange {
  const change: MarketplaceChange = { added: [], updated: [], removed: [] };
  const prevMap = new Map((prev ?? []).map((s) => [s.skillSlug, s.semver]));
  const nextMap = new Map(next.map((s) => [s.skillSlug, s.semver]));
  for (const [slug, semver] of nextMap) {
    const before = prevMap.get(slug);
    if (before === undefined) change.added.push(slug);
    else if (before !== semver) change.updated.push(slug);
  }
  for (const slug of prevMap.keys()) if (!nextMap.has(slug)) change.removed.push(slug);
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
    `select s.id as skill_id, s.slug, s.title, s.description, n.slug as ns_slug,
            coalesce((select array_agg(c.slug order by c.slug) from skill_categories sc
                        join categories c on c.id = sc.category_id
                       where sc.skill_id = s.id), '{}') as category_slugs,
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
    const { rows: keyRows } = await pool.query<{ artifact_object_key: string | null; content_sha256: string | null }>(
      `select artifact_object_key, content_sha256 from skill_versions where skill_id = $1 and semver = $2`,
      [r.skill_id, latest],
    );
    const key = keyRows[0]?.artifact_object_key ?? null;
    if (!key) continue; // nothing to serve
    out.push({ ...r, semver: latest, artifact_object_key: key, content_sha256: keyRows[0]?.content_sha256 ?? null });
  }
  return out.sort((a, b) => a.ns_slug.localeCompare(b.ns_slug) || a.slug.localeCompare(b.slug));
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
 * Read-or-bump the `1.0.<n>` counter for one plugin (§30.3). Same fingerprint ⇒ same n; a
 * different one ⇒ n+1; a new plugin ⇒ 1. Runs inside the rebuild transaction so a failed
 * synthesis rolls the bump back. Never decrements, never deletes.
 */
async function pluginCounter(client: PoolClient, key: string, pluginSlug: string, fingerprint: string): Promise<{ n: number; bumped: boolean; previous: number | null }> {
  const { rows } = await client.query<{ version_n: number; fingerprint: string }>(
    `select version_n, fingerprint from marketplace_plugins where marketplace_key = $1 and plugin_slug = $2 for update`,
    [key, pluginSlug],
  );
  const cur = rows[0];
  if (!cur) {
    await client.query(
      `insert into marketplace_plugins (marketplace_key, plugin_slug, version_n, fingerprint) values ($1, $2, 1, $3)`,
      [key, pluginSlug, fingerprint],
    );
    return { n: 1, bumped: true, previous: null };
  }
  if (cur.fingerprint === fingerprint) return { n: cur.version_n, bumped: false, previous: cur.version_n };
  const n = cur.version_n + 1;
  await client.query(
    `update marketplace_plugins set version_n = $3, fingerprint = $4, updated_at = now() where marketplace_key = $1 and plugin_slug = $2`,
    [key, pluginSlug, n, fingerprint],
  );
  return { n, bumped: true, previous: cur.version_n };
}

/** Self-heal (§3): counters keyed to a namespace that no longer exists are dropped. */
async function sweepOrphanCounters(pool: Pool): Promise<void> {
  await pool.query(
    `delete from marketplace_plugins
      where marketplace_key like 'ns:%'
        and not exists (select 1 from namespaces n where 'ns:' || n.id::text = marketplace_key)`,
  );
}

/** §25 system event, `source='worker'` — the two synthesis collision codes (§30.8). Never silent. */
async function recordSweepEvent(db: Pool | PoolClient, scope: MarketplaceScope, errorCode: string, message: string): Promise<void> {
  const path = `/_marketplace/${scope.kind === "public" ? "_public" : scope.namespaceSlug}.git`;
  await db.query(
    `insert into system_event (status, method, route, path, user_id, error_code, message, source)
     values (409, 'SWEEP', '/_marketplace/[key].git', $1, null, $2, $3, 'worker')`,
    [path, errorCode, message.slice(0, 300)],
  );
}

function describeComponentCollision(c: ComponentCollision): string {
  return `plugin ${c.pluginSlug}: ${c.component} ${c.key} claimed by @${c.winner.namespaceSlug}/${c.winner.skillSlug} (kept) and @${c.skipped.namespaceSlug}/${c.skipped.skillSlug} (skipped)`;
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
  const { rows: categories } = await pool.query<CategoryRow>(`select slug, name, description from categories`);
  await sweepOrphanCounters(pool);
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
      const prevHash = await previousHash(dir);
      if (prevHash !== null && prevHash === hash) {
        // Nothing changed — no commit, no consumer churn. Still "synced": the catalog was checked
        // and the repo matches it, which is what the Marketplaces page's freshness line reports.
        await stampMarketplaceSynced(pool, target.scope, target.namespaceId);
        continue;
      }
      const prevServed = prevHash === null ? null : await servedSkills(dir);

      // Bundles once per skill, whatever number of plugins carry it.
      const bundles = new Map<string, SkillFile[]>();
      for (const s of skills) {
        const targz = await deps.store.get(s.artifact_object_key!);
        bundles.set(s.skill_id, await extractBundle(targz, cap));
      }

      const grouped = groupSkillsIntoPlugins(
        target.scope,
        skills.map((s) => ({ namespaceSlug: s.ns_slug, skillSlug: s.slug, title: s.title, categorySlugs: s.category_slugs ?? [], row: s })),
        categories,
      );
      const nsDisplayName = target.scope.kind === "namespace" ? target.ownerName : null;
      const key = marketplaceKey(target.scope, target.namespaceId);

      const client = await pool.connect();
      try {
        await client.query("begin");
        const builds: MarketplacePluginBuild[] = [];
        const notes: string[] = [];
        for (const g of grouped.plugins) {
          const members = g.members.map((m) => ({ ...m, files: bundles.get(m.row.skill_id) ?? [] }));
          const componentFiles = new Set<string>();
          for (const m of members) {
            for (const mv of planPluginLayout(m.skillDir, m.files.map((f) => f.path)).moves) if (isComponentPath(mv.to)) componentFiles.add(mv.to);
          }
          const fp = pluginFingerprint(
            members.map((m) => ({ skillDir: m.skillDir, skillId: m.row.skill_id, semver: m.row.semver, contentSha256: m.row.content_sha256 })),
            [...componentFiles],
          );
          const counter = await pluginCounter(client, key, g.slug, fp);
          if (counter.bumped) notes.push(`plugin ${g.slug} ${counter.previous === null ? "new" : pluginVersion(counter.previous)} -> ${pluginVersion(counter.n)}`);
          builds.push({
            entry: {
              slug: g.slug,
              displayName: g.displayName,
              description: pluginDescription(g, target.ownerName),
              version: pluginVersion(counter.n),
              keywords: pluginKeywords(g.members),
              category: g.slug === GENERAL_PLUGIN_SLUG ? null : g.slug,
              homepage: pluginHomepage(registryBase, target.scope, g, nsDisplayName),
            },
            members: members.map((m) => ({ namespaceSlug: m.namespaceSlug, skillSlug: m.skillSlug, skillDir: m.skillDir, files: m.files })),
          });
        }

        const served: ServedSkill[] = skills.map((s) => ({ namespaceSlug: s.ns_slug, skillSlug: s.slug, semver: s.semver }));
        const { collisions } = await synthesizeMarketplace({
          bareRepoPath: dir,
          manifest: { prefix, scope: target.scope, ownerName: target.ownerName, ownerEmail: target.ownerEmail, version: hash },
          plugins: builds,
          served,
          change: diffChange(prevServed, served),
          notes,
        });

        for (const c of grouped.collisions) {
          await recordSweepEvent(
            client,
            target.scope,
            "marketplace_skill_dir_collision",
            `plugin ${c.pluginSlug}: skills/${c.skillDir} claimed by @${c.winner.namespaceSlug}/${c.winner.skillSlug} (kept) and @${c.skipped.namespaceSlug}/${c.skipped.skillSlug} (skipped)`,
          );
        }
        for (const c of collisions) await recordSweepEvent(client, target.scope, "marketplace_component_collision", describeComponentCollision(c));
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      rebuilt++;
      // Stamped only after the rebuild succeeded: a failed synthesis is not "synced" (§30.5).
      await stampMarketplaceSynced(pool, target.scope, target.namespaceId);
      console.log(JSON.stringify({ level: "info", msg: "marketplace synthesized", marketplace: marketplaceName(prefix, target.scope), skills: skills.length, plugins: grouped.plugins.length }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "marketplace sync failed", scope: target.scope, err: String(err) }));
    }
  }
  return rebuilt;
}
