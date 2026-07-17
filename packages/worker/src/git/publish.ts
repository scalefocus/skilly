// Publish runner — turns stored artifacts into served git repos. Runs on the leader.
// For each active, not-yet-published version: fetch the artifact from object storage,
// extract it, synthesize the immutable version tag, and (if it's the latest stable)
// point `main` at it. Idempotent: an already-existing tag is treated as published.
// SKILLY_SPEC.md §6, §7, §16 (Phase 2 step 6/7).
import type { Pool } from "pg";
import { resolveLatest, validateBundle, versionTag, bundleContentCap } from "@skilly/shared";
import { getMaxBundleBytes } from "../settings.js";
import type { ArtifactStore } from "../storage/objectStore.js";
import { repoPath } from "./repoStore.js";
import { synthesizeVersion, listTags, pointMainAtTag } from "./synth.js";
import { extractBundle } from "./bundle.js";
import type { SkillFile } from "./synth.js";

/**
 * Ensure SKILL.md frontmatter contains `name: <skillSlug>`.
 *
 * Claude Code skills only carry `description` in frontmatter — `name` comes from the directory
 * name at install time. The vercel-labs/skills CLI (and our own validateBundle) require an
 * explicit `name` field that matches the slug, so we inject it here before validation and
 * synthesis rather than rejecting every skill that omits it.
 */
function ensureSkillName(files: SkillFile[], skillSlug: string): SkillFile[] {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  return files.map((f) => {
    if (f.path !== "SKILL.md") return f;
    const content = dec.decode(f.bytes);
    const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!fmMatch) {
      // No frontmatter at all: prepend a minimal one.
      return { ...f, bytes: enc.encode(`---\nname: ${skillSlug}\n---\n${content}`) };
    }
    const fmBody = fmMatch[1]!;
    const correctNameRe = new RegExp(`^name\\s*:\\s*${skillSlug}\\s*$`, "m");
    if (correctNameRe.test(fmBody)) return f; // already correct
    const hasName = /^name\s*:/m.test(fmBody);
    const newFmBody = hasName
      ? fmBody.replace(/^name\s*:.*$/m, `name: ${skillSlug}`)
      : `name: ${skillSlug}\n${fmBody}`;
    const before = content.slice(0, fmMatch.index);
    const after = content.slice(fmMatch.index + fmMatch[0].length);
    return { ...f, bytes: enc.encode(`${before}---\n${newFmBody}\n---${after}`) };
  });
}

export interface PublishDeps {
  store: ArtifactStore;
  repoRoot: string;
}

// Cap how many versions a single sweep processes — a backlog drains over successive sweeps
// instead of one sweep running unboundedly long (and holding that many artifacts in memory).
export function sweepBatchSize(): number {
  const n = Number(process.env.WORKER_SWEEP_BATCH ?? 50);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 50;
}
const SWEEP_BATCH = sweepBatchSize();

interface PendingRow {
  id: string;
  skill_id: string;
  semver: string;
  artifact_object_key: string;
  ns_slug: string;
  skill_slug: string;
}

export async function publishPendingVersions(pool: Pool, deps: PublishDeps): Promise<number> {
  const { rows } = await pool.query<PendingRow>(
    `select sv.id, sv.skill_id, sv.semver, sv.artifact_object_key,
            n.slug as ns_slug, s.slug as skill_slug
       from skill_versions sv
       join skills s on s.id = sv.skill_id
       join namespaces n on n.id = s.namespace_id
      where sv.status = 'active'
        and sv.git_published = false
        and sv.artifact_object_key is not null
      order by sv.created_at asc
      limit ${SWEEP_BATCH}`,
  );

  // Extract/validate against the SAME cap the upload enforced, so a within-limit bundle is never
  // rejected here by a stricter default. §6.
  const cap = bundleContentCap(await getMaxBundleBytes(pool));
  let published = 0;
  for (const row of rows) {
    // Latest-stable check is computed against ALL active versions, so it's order-independent.
    const { rows: activeRows } = await pool.query<{ semver: string }>(
      `select semver from skill_versions where skill_id = $1 and status = 'active'`,
      [row.skill_id],
    );
    const isLatestStable = resolveLatest(activeRows.map((r) => r.semver)) === row.semver;
    const bareRepoPath = repoPath(deps.repoRoot, row.ns_slug, row.skill_slug);

    try {
      const targz = await deps.store.get(row.artifact_object_key);
      // Inject `name: <slug>` into SKILL.md frontmatter if missing — Claude Code skills only carry
      // `description`, but the vercel-labs/skills CLI (and our own validateBundle) require `name`.
      const files = ensureSkillName(await extractBundle(targz, cap), row.skill_slug);

      // Security scanning happens at INGEST (hosted upload / pointer mirror) so reviewers
      // see findings pre-accept. Here we only re-run BLOCKING validation as a safety net —
      // a malformed bundle is never synthesized (left git_published=false so it surfaces
      // as unpublished).
      const validation = validateBundle(files, { skillSlug: row.skill_slug, maxBytes: cap });
      if (!validation.ok) {
        console.error(JSON.stringify({ level: "warn", msg: "validation failed; skipping", versionId: row.id, errors: validation.errors }));
        continue;
      }

      await synthesizeVersion({ bareRepoPath, semver: row.semver, files, isLatestStable });
    } catch (err) {
      // If the tag already exists (e.g. a prior crash after synth but before flag flip),
      // treat as published and move on; otherwise re-throw to retry next sweep.
      if (!(err instanceof Error && /already exists/.test(err.message))) {
        console.error(JSON.stringify({ level: "error", msg: "publish failed", versionId: row.id, err: String(err) }));
        continue;
      }
    }

    await pool.query(`update skill_versions set git_published = true where id = $1`, [row.id]);

    // Notify everyone watching this skill that a new version is live, plus its maintainers
    // (explicit maintainers + the namespace's admins — implicit watchers, §19). UNION dedupes.
    // Single point covering both hosted and pointer, since both reach git_published here. §12.
    // The per-user new_version_notifications opt-out gates ONLY the maintainer-derived half —
    // an explicit watch always wins (its off-switch is unwatch), so a maintainer who watches
    // keeps getting notified with the toggle off. Row-level: opted-out users get no row at all.
    await pool.query(
      `insert into notifications (user_id, type, payload)
       select uid, 'skill.new_version',
              jsonb_build_object('namespaceSlug',$2::text,'skillSlug',$3::text,'semver',$4::text)
         from (
           select w.user_id as uid from skill_watches w where w.skill_id = $1
           union
           select m.uid
             from (
               select sm.user_id as uid from skill_maintainers sm where sm.skill_id = $1
               union
               select gm.user_id
                 from skills s
                 join role_mappings rm on rm.namespace_id = s.namespace_id and rm.role = 'namespace_admin'
                 join group_memberships gm on gm.group_id = rm.group_id
                where s.id = $1
             ) m
             join users u on u.id = m.uid and u.new_version_notifications
         ) recipients`,
      [row.skill_id, row.ns_slug, row.skill_slug, row.semver],
    );

    published++;
  }
  return published;
}

/**
 * Self-heal: reconcile each `git_published = true` skill's serving repo against the DB so it
 * always carries the FULL expected ref set — a tag per active version AND `main` pointed at the
 * latest stable. The repo root is served state (the canonical artifact lives in object storage),
 * so this recovers from a lost/recreated volume, a synthesis crash mid-sweep, AND every partial
 * state in between. Each of these is served as a successful-but-broken clone unless repaired:
 *   - repo missing / ref-less (HEAD only)  → `npx skills add` clones empty ("No skills found");
 *   - a specific version tag missing       → a pinned `…#v1.2.0` clone fails "branch not found";
 *   - tags present but `main` missing/stale → a fragment-less ("latest") clone comes back empty.
 * The OLD check ("repo has ≥1 ref → healthy") missed the last two: a repo with ANY ref was deemed
 * provisioned and never repaired. We now drive off the DB: re-synthesize any version whose tag is
 * absent, then repoint `main` at the latest-stable tag. Re-synthesis is idempotent (an existing
 * tag throws "already exists" and is skipped) and does NOT re-notify watchers (already announced).
 * If an artifact is gone from object storage we cannot heal — logged ONCE then skipped (see
 * `unhealable`) so a permanently missing artifact doesn't spam the log or re-fetch every sweep.
 * SKILLY_SPEC.md §6.
 */
// Versions whose artifact is permanently absent (NoSuchKey) or whose bundle fails validation —
// re-synthesis is impossible, so we give up (logged once). Cleared only by a worker restart;
// the exceptional "artifact restored" case is rare and a restart re-attempts it.
const unhealable = new Set<string>();

export async function reprovisionMissingRepos(pool: Pool, deps: PublishDeps): Promise<number> {
  const { rows } = await pool.query<PendingRow>(
    `select sv.id, sv.skill_id, sv.semver, sv.artifact_object_key,
            n.slug as ns_slug, s.slug as skill_slug
       from skill_versions sv
       join skills s on s.id = sv.skill_id
       join namespaces n on n.id = s.namespace_id
      where sv.status = 'active' and s.status = 'active'
        and sv.git_published = true
        and sv.artifact_object_key is not null
      order by n.slug, s.slug, sv.created_at asc
      limit ${SWEEP_BATCH}`,
  );

  const cap = bundleContentCap(await getMaxBundleBytes(pool));
  // Group active+published versions by skill so we reconcile each repo's whole ref set in one pass.
  const bySkill = new Map<string, PendingRow[]>();
  for (const row of rows) {
    const key = `${row.ns_slug}/${row.skill_slug}`;
    let arr = bySkill.get(key);
    if (!arr) { arr = []; bySkill.set(key, arr); }
    arr.push(row);
  }

  let healed = 0;
  for (const skillRows of bySkill.values()) {
    const first = skillRows[0]!;
    const bareRepoPath = repoPath(deps.repoRoot, first.ns_slug, first.skill_slug);
    // Expected: a tag per active version; `main` at the latest stable (null if none stable).
    const latestStable = resolveLatest(skillRows.map((r) => r.semver));
    const present = new Set(await listTags(bareRepoPath));

    // 1) Re-synthesize any version whose tag is absent. Covers a missing/empty repo and a repo
    //    that's missing only some version tags. synthesizeVersion creates the repo if needed,
    //    writes the tag, and points main at it when it's the latest stable.
    for (const row of skillRows) {
      if (present.has(versionTag(row.semver))) continue; // tag already present
      if (unhealable.has(row.id)) continue; // already determined we can't recover this one
      const isLatestStable = latestStable === row.semver;
      try {
        const files = await extractBundle(await deps.store.get(row.artifact_object_key), cap);
        const validation = validateBundle(files, { skillSlug: row.skill_slug, maxBytes: cap });
        if (!validation.ok) {
          unhealable.add(row.id); // a malformed stored bundle won't fix itself; stop retrying
          console.error(JSON.stringify({ level: "warn", msg: "reprovision: validation failed; giving up", versionId: row.id, errors: validation.errors }));
          continue;
        }
        await synthesizeVersion({ bareRepoPath, semver: row.semver, files, isLatestStable });
        healed++;
        console.log(JSON.stringify({ level: "warn", msg: "reprovisioned missing version tag (self-heal)", ns: row.ns_slug, slug: row.skill_slug, semver: row.semver }));
      } catch (err) {
        if (err instanceof Error && /already exists/.test(err.message)) continue;
        // A genuinely-absent artifact (NoSuchKey) can't be re-synthesized — give up (logged once)
        // so it doesn't spam the log / re-fetch every sweep. Other (transient) errors keep retrying.
        const permanent = err instanceof Error && /NoSuchKey|NoSuchBucket|does not exist|not found/i.test(err.message);
        if (permanent) unhealable.add(row.id);
        console.error(JSON.stringify({ level: "error", msg: permanent ? "reprovision: artifact missing; giving up" : "reprovision failed (transient?)", ns: row.ns_slug, slug: row.skill_slug, semver: row.semver, err: String(err) }));
      }
    }

    // 2) Ensure `main` tracks the latest stable even when that tag already existed — the
    //    "tags present but main unborn/stale" case that a fragment-less clone surfaces as empty.
    if (latestStable) {
      try {
        if (await pointMainAtTag(bareRepoPath, versionTag(latestStable))) {
          healed++;
          console.log(JSON.stringify({ level: "warn", msg: "repointed main at latest stable (self-heal)", ns: first.ns_slug, slug: first.skill_slug, semver: latestStable }));
        }
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "reprovision: could not repoint main", ns: first.ns_slug, slug: first.skill_slug, err: String(err) }));
      }
    }
  }
  return healed;
}
