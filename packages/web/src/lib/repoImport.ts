// Import a whole repository (SKILLY_SPEC.md §64): the scan that lists a git repository's skills at
// a ref (§64.3) and the bulk submit that turns the chosen folders into one ordinary pointer proposal
// (or direct publish) each, outcome per skill (§64.6). The routes only authenticate, rate-limit and
// parse; everything else is here.
//
// Git transport is the posture of submit-time verification (lib/pointerVerify.ts) and the worker
// mirror: the shared URL validator, a DNS-rebind private-IP re-check, https only, no redirects, no
// ext::/file:: helpers, no credential prompt, a per-command timeout — plus `core.symlinks=false`
// and a regular-file check, because the scan reads the found SKILL.md files from a working tree.
import { spawn } from "node:child_process";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import type { Pool, PoolClient } from "pg";
import {
  IMPORT_HISTORY_MAX_COMMITS,
  IMPORT_MAX_SKILLS,
  IMPORT_NEEDS_REVIEW,
  IMPORT_SKILL_MD_MAX_BYTES,
  IMPORT_SUBMITTED,
  PURE_SCANNERS,
  bundleContentCap,
  canDirectPublish,
  discoverSkillPaths,
  frontmatterImportReason,
  isBlockedIp,
  isImportableName,
  isSkillsHubUrl,
  isValidSemver,
  lastChangedByFolder,
  nestedSkillFolders,
  normalizeImportFolder,
  normalizeOriginUrl,
  normalizeSubdir,
  parseFrontmatter,
  parseNameOnlyLog,
  repoLabel,
  runScanners,
  skillVisibilityWhere,
  slugExistsMessage,
  validateGitRef,
  validatePointerUrl,
  validateSubdir,
  SLUG_EXISTS_CODE,
  type EffectiveAccess,
  type ImportItemResult,
  type ImportSubmitResult,
  type ScanResult,
  type ScannedSkill,
} from "@skilly/shared";
import { appendAudit } from "./audit";
import { createProposal, directPublish, notifyNamespaceReviewers, verifySubmissionPayload, type ProposalMetadata, type RevisionPayload } from "./proposals";
import { findDuplicateSkill, findSlugMatches } from "./duplicate";
import { fetchPointerContentForCheck, type PointerFetchResult } from "./pointerFetch";
import { getDuplicateEnforcement, getMaxBundleBytes, getProposalsOpen } from "./settings";
import { M } from "./metrics";

const GIT_TIMEOUT_MS = Number(process.env.POINTER_VERIFY_TIMEOUT_MS ?? 30_000);

// https-only transport, no redirects, no ext::/file:: helpers, no credential prompt — identical to
// the verify clone — and symlinks checked out as plain files, so a SKILL.md can never point the
// reader at a file outside the clone.
const PROTO = ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", "-c", "core.symlinks=false"];

export type GitRunner = (args: string[], opts?: { cwd?: string }) => Promise<string>;

/** The real git, bounded by the per-command timeout. */
export const runGit: GitRunner = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" } });
    let out = "";
    let err = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error("timed out"));
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `git failed (${code})`));
    });
  });

/** I/O seams, so the integration test can run git against a local fixture repository. */
export interface ImportDeps {
  git?: GitRunner;
  /** Direct publish's §37.4 content check fetch (one folder at the import's ref). */
  fetchContent?: (url: string, ref: string, subdir: string | null, skillSlug: string, maxBytes: number) => Promise<PointerFetchResult>;
}

/** Reject when the host resolves to any private/loopback/link-local address (DNS rebinding / SSRF). */
async function resolvesToBlockedIp(rawUrl: string): Promise<string | null> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    return null;
  }
  if (isBlockedIp(host)) return host;
  try {
    const addrs = await lookup(host, { all: true });
    for (const a of addrs) if (isBlockedIp(a.address)) return a.address;
  } catch {
    return null;
  }
  return null;
}

/** The validation every import request runs on its source, or a user-facing error. */
export function importSourceError(url: string, ref: string, folder: string | null): string | null {
  if (!url) return "enter a git repository URL";
  if (isSkillsHubUrl(url)) return "skills-hub.ai has one skill per page. Propose it from the propose form.";
  const urlErr = validatePointerUrl(url);
  if (urlErr) return urlErr;
  const refErr = validateGitRef(ref);
  if (refErr) return refErr;
  if (folder) {
    const subErr = validateSubdir(folder);
    if (subErr) return subErr;
  }
  return null;
}

type Checkout = { ok: true; dir: string; commit: string | null; paths: string[]; shallow: boolean } | { ok: false; error: string };

/**
 * A partial clone with no file contents of `url@ref` into `tmp`, `depth` commits deep (the
 * `v`-prefix ref toggle tolerated, like the mirror), and the tip's tree: blob paths only — no
 * symlinks, no submodules.
 */
async function cloneTree(git: GitRunner, tmp: string, url: string, ref: string, depth: number): Promise<Checkout> {
  const blocked = await resolvesToBlockedIp(url);
  if (blocked) return { ok: false, error: `host resolves to a private/loopback address (${blocked})` };
  const alt = /^v\d/.test(ref) ? ref.slice(1) : /^\d/.test(ref) ? `v${ref}` : null;
  const candidates = alt && !validateGitRef(alt) ? [ref, alt] : [ref];
  const dir = join(tmp, "src");
  let cloned = false;
  for (const candidate of candidates) {
    try {
      await git([...PROTO, "clone", "--depth", String(depth), "--no-checkout", "--filter=blob:none", "--branch", candidate, "-c", "credential.helper=", "--", url, dir]);
      cloned = true;
      break;
    } catch (err) {
      if (!/not found in upstream|Could not find remote branch|remote branch .* not found/i.test(String(err))) {
        return { ok: false, error: "couldn’t read this repository at that ref — check the URL is a public git repo and the pinned ref exists" };
      }
    }
  }
  if (!cloned) return { ok: false, error: `ref '${ref}' was not found in ${url}` };
  // `-z`: NUL-terminated records, so no file name is ever quoted or split.
  const listing = await git(["-C", dir, "ls-tree", "-r", "-z", "HEAD"]);
  const paths: string[] = [];
  for (const rec of listing.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type] = rec.slice(0, tab).split(" ");
    if (type === "blob" && (mode === "100644" || mode === "100755")) paths.push(rec.slice(tab + 1));
  }
  let commit: string | null = null;
  try {
    const head = (await git(["-C", dir, "rev-parse", "HEAD"])).trim();
    commit = /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    commit = null;
  }
  let shallow = false;
  try {
    shallow = (await git(["-C", dir, "rev-parse", "--is-shallow-repository"])).trim() === "true";
  } catch {
    shallow = false;
  }
  return { ok: true, dir, commit, paths, shallow };
}

/** Check out only the SKILL.md files named and read each one's first 64 KB (regular files only). */
async function readSkillMds(git: GitRunner, dir: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!paths.length) return out;
  // Both may fetch the missing blobs from the origin, so they carry the clone's transport posture
  // (top-level `-c` settings don't persist into the clone's config).
  await git(["-C", dir, ...PROTO, "sparse-checkout", "set", "--no-cone", "SKILL.md"]);
  await git(["-C", dir, ...PROTO, "read-tree", "-mu", "HEAD"]);
  for (const p of paths) {
    const abs = join(dir, ...p.split("/"));
    try {
      const st = await lstat(abs);
      if (!st.isFile()) continue;
      const fh = await open(abs, "r");
      try {
        const buf = Buffer.alloc(Math.min(st.size, IMPORT_SKILL_MD_MAX_BYTES));
        await fh.read(buf, 0, buf.length, 0);
        out.set(p, buf.toString("utf8"));
      } finally {
        await fh.close();
      }
    } catch {
      // unreadable → treated as having no frontmatter
    }
  }
  return out;
}

/** Visible active skills (deprecated included) named like any of `names`, with whether the latest
 *  stable version pins `origin` + the same folder (§64.3 matches; invariant #3 via the shared predicate). */
async function visibleMatches(
  db: Pool,
  access: EffectiveAccess,
  names: readonly string[],
): Promise<Map<string, { ns: string; slug: string; origin: string | null; subdir: string | null }>> {
  const out = new Map<string, { ns: string; slug: string; origin: string | null; subdir: string | null }>();
  if (!names.length) return out;
  const params: unknown[] = [names.map((n) => n.toLowerCase())];
  const where = ["lower(s.slug) = any($1::text[])", "s.status = 'active'"];
  const vis = skillVisibilityWhere(access, params, "s");
  if (vis) where.push(vis);
  const { rows } = await db.query<{ ns: string; slug: string; origin: string | null; subdir: string | null }>(
    `select n.slug as ns, s.slug, lv.external_origin_url as origin, lv.external_subdir as subdir
       from skills s join namespaces n on n.id = s.namespace_id
       left join lateral (
         select v.external_origin_url, v.external_subdir from skill_versions v
          where v.skill_id = s.id and v.status = 'active' and v.is_prerelease = false
          order by v.created_at desc limit 1
       ) lv on true
      where ${where.join(" and ")}
      order by s.created_at asc, s.id asc`,
    params,
  );
  for (const r of rows) {
    const key = r.slug.toLowerCase();
    if (!out.has(key)) out.set(key, r);
  }
  return out;
}

export type ScanOutcome = { ok: true; result: ScanResult } | { ok: false; status: number; error: string };

/** §64.3: list the repository's skills at `ref` (under `folder`), with dates, matches and reasons. */
export async function scanRepository(
  db: Pool,
  access: EffectiveAccess,
  input: { url: string; ref: string; folder?: string | null },
  deps: ImportDeps = {},
): Promise<ScanOutcome> {
  const url = input.url.trim();
  const ref = input.ref.trim();
  const folder = normalizeImportFolder(input.folder);
  const srcErr = importSourceError(url, ref, folder);
  if (srcErr) return { ok: false, status: 422, error: srcErr };
  const git = deps.git ?? runGit;
  const tmp = await mkdtemp(join(tmpdir(), "skilly-import-"));
  try {
    let co: Checkout;
    try {
      co = await cloneTree(git, tmp, url, ref, IMPORT_HISTORY_MAX_COMMITS);
    } catch {
      co = { ok: false, error: "couldn’t read this repository — check it’s a public git URL and the ref exists" };
    }
    if (!co.ok) {
      M.repoImportScans.inc({ result: "error" });
      return { ok: false, status: 422, error: co.error };
    }
    const { found, total } = discoverSkillPaths(co.paths, folder);
    let mds = new Map<string, string>();
    try {
      mds = await readSkillMds(git, co.dir, found.map((f) => f.path));
    } catch {
      // the list still comes back; every row then reads "no name"
    }

    // Last changed: one walk of the fetched history. A truncated (shallow) history's oldest commit
    // diffs against nothing — every file looks added — so it only marks the window's edge.
    let commits: ReturnType<typeof parseNameOnlyLog> = [];
    let historyOk = true;
    try {
      commits = parseNameOnlyLog(
        await git(["-C", co.dir, "log", "--format=%x00%cI", "--name-only", "--no-renames", "-n", String(IMPORT_HISTORY_MAX_COMMITS), "HEAD"]),
      );
    } catch {
      historyOk = false;
    }
    const oldest = commits.length ? commits[commits.length - 1]!.date : null;
    const attributable = co.shallow ? commits.slice(0, -1) : commits;
    const changed = historyOk ? lastChangedByFolder(attributable, found.map((f) => f.subdir)) : new Map<string, string>();
    const nested = nestedSkillFolders(found.map((f) => f.subdir));

    const fms = found.map((f) => parseFrontmatter(mds.get(f.path) ?? ""));
    const names = fms.map((fm) => fm.name?.trim()).filter((n): n is string => !!n && isImportableName(n));
    const matches = await visibleMatches(db, access, [...new Set(names)]);
    const origin = normalizeOriginUrl(url);

    const skills: ScannedSkill[] = found.map((f, i) => {
      const fm = fms[i]!;
      const name = fm.name?.trim() || null;
      const key = f.subdir ?? "";
      const row: ScannedSkill = {
        path: f.path,
        subdir: f.subdir,
        name,
        description: fm.description?.trim() || null,
        lastChangedAt: historyOk ? changed.get(key) ?? null : null,
        lastChangedBefore: historyOk && !changed.has(key) && co.shallow ? oldest : null,
        importable: true,
        frontmatter: { usageExamples: fm.usage_examples?.trim() || null, category: fm.category?.trim() || null, version: fm.version?.trim() || null },
      };
      const reason = frontmatterImportReason(fm);
      const match = name ? matches.get(name.toLowerCase()) : undefined;
      if (reason) {
        row.importable = false;
        row.reason = reason;
      } else if (match) {
        row.importable = false;
        row.reason = "exists";
        row.match = {
          ns: match.ns,
          slug: match.slug,
          sameSource: !!match.origin && normalizeOriginUrl(match.origin) === origin && normalizeSubdir(match.subdir) === normalizeSubdir(f.subdir),
        };
      }
      const outer = nested.get(key);
      if (outer !== undefined) row.nestedIn = outer;
      return row;
    });
    M.repoImportScans.inc({ result: "ok" });
    return {
      ok: true,
      result: { commit: co.commit, total, shown: skills.length, historyCommits: commits.length, historyComplete: historyOk && !co.shallow, skills },
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ── Submit (§64.6) ────────────────────────────────────────────────────────────────────────────

export interface ImportItemInput {
  subdir: string | null;
  semver: string;
  metadata: Pick<ProposalMetadata, "skillSlug" | "title" | "description" | "categories" | "toolHarness" | "usageExamples" | "iconSha256" | "iconEmoji" | "iconSource">;
}

export interface ImportSubmitInput {
  url: string;
  ref: string;
  folder?: string | null;
  namespaceSlug: string;
  visibility: "org" | "namespace";
  sharedNamespaceIds?: string[];
  mode: "review" | "direct";
  importId?: string | null;
  items: ImportItemInput[];
}

export type SubmitOutcome = { ok: true; result: ImportSubmitResult } | { ok: false; status: number; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The per-skill checks the wizard's Next already ran, again on the server (§64.4, §64.6). */
function itemError(item: ImportItemInput, paths: ReadonlySet<string>): string | null {
  const slug = str(item.metadata?.skillSlug);
  if (!isImportableName(slug)) return `‹${slug}› isn't a valid skill slug`;
  if (!str(item.metadata?.title)) return "give the skill a title";
  if (!str(item.metadata?.description)) return "give the skill a description";
  if (!isValidSemver(str(item.semver))) return `‹${str(item.semver)}› isn't a valid version (use semver, e.g. 1.0.0)`;
  const subdir = item.subdir ? normalizeImportFolder(item.subdir) : null;
  if (subdir) {
    const subErr = validateSubdir(subdir);
    if (subErr) return subErr;
  }
  if (!paths.has(subdir ? `${subdir}/SKILL.md` : "SKILL.md")) {
    return `no SKILL.md found in ${subdir ? `folder '${subdir}'` : "the repository root"} at this ref`;
  }
  return null;
}

/**
 * §64.6: the whole-import checks (any failure answers for the whole request and nothing is
 * created), one verification clone, then each skill on its own — a proposal or a direct publish in
 * its own transaction — then the import's one notification pair and its audit row.
 */
export async function submitImport(
  db: Pool,
  access: EffectiveAccess & { userId: string },
  input: ImportSubmitInput,
  deps: ImportDeps = {},
): Promise<SubmitOutcome> {
  const url = str(input.url);
  const ref = str(input.ref);
  const folder = normalizeImportFolder(input.folder);
  const items = Array.isArray(input.items) ? input.items : [];
  const mode = input.mode === "direct" ? "direct" : "review";
  const srcErr = importSourceError(url, ref, folder);
  if (srcErr) return { ok: false, status: 422, error: srcErr };

  // A continued import (*Fix and resubmit*) counts what it already created toward the cap.
  let prior: { id: string; items_created: number } | null = null;
  const continuing = input.importId != null && input.importId !== "";
  if (continuing) {
    if (!UUID_RE.test(String(input.importId))) return { ok: false, status: 404, error: "import not found" };
    prior = (await db.query<{ id: string; items_created: number; submitted_by: string | null; target_namespace_id: string; origin_url: string; ns: string }>(
      `select pi.id, pi.items_created, pi.submitted_by, pi.target_namespace_id, pi.origin_url, n.slug as ns
         from proposal_imports pi join namespaces n on n.id = pi.target_namespace_id where pi.id = $1`,
      [input.importId],
    )).rows.filter((r) => r.submitted_by === access.userId && r.ns === str(input.namespaceSlug) && r.origin_url === normalizeOriginUrl(url))[0] ?? null;
  }
  if (items.length < 1) return { ok: false, status: 422, error: "tick at least one skill" };
  if (items.length + (prior?.items_created ?? 0) > IMPORT_MAX_SKILLS) {
    return { ok: false, status: 422, error: `an import holds up to ${IMPORT_MAX_SKILLS} skills — submit these, then import the rest` };
  }
  const slugs = items.map((i) => str(i.metadata?.skillSlug).toLowerCase());
  if (new Set(slugs).size !== slugs.length) return { ok: false, status: 422, error: "two skills in this import have the same name" };

  const ns = (await db.query<{ id: string; slug: string; require_review: boolean }>(`select id, slug, require_review from namespaces where slug = $1`, [str(input.namespaceSlug)])).rows[0];
  if (!ns) return { ok: false, status: 404, error: "namespace not found" };
  if (!(await getProposalsOpen(db)) && !access.isPlatformAdmin && !access.namespaceRoles.has(ns.id)) {
    return { ok: false, status: 403, error: "proposals are restricted to members of this namespace — ask an admin for access" };
  }
  if (mode === "direct" && !canDirectPublish(access, ns.id, ns.require_review)) {
    return { ok: false, status: 403, error: "direct publish not permitted here — submit for review instead" };
  }
  if (continuing && !prior) return { ok: false, status: 404, error: "import not found" };

  const git = deps.git ?? runGit;
  const tmp = await mkdtemp(join(tmpdir(), "skilly-import-"));
  let co: Checkout;
  try {
    try {
      co = await cloneTree(git, tmp, url, ref, 1);
    } catch {
      co = { ok: false, error: "couldn’t verify the repository — check it’s a public git URL and the pinned ref exists" };
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  if (!co.ok) return { ok: false, status: 422, error: co.error };
  const paths = new Set(co.paths);
  const commit = co.commit;

  const origin = normalizeOriginUrl(url);
  let importId: string;
  if (prior) {
    importId = prior.id;
  } else {
    importId = (await db.query<{ id: string }>(
      `insert into proposal_imports (submitted_by, target_namespace_id, origin_url, ref, commit, folder, mode)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [access.userId, ns.id, origin, ref, commit, folder, mode],
    )).rows[0]!.id;
  }

  const enforcement = await getDuplicateEnforcement(db);
  const maxBytes = bundleContentCap(await getMaxBundleBytes());
  const visibility = input.visibility === "org" ? "org" : "namespace";
  const results: ImportItemResult[] = [];
  for (const item of items) {
    const slug = str(item.metadata?.skillSlug);
    const subdir = item.subdir ? normalizeImportFolder(item.subdir) : null;
    const fail = (error: string, code?: string): ImportItemResult => ({ subdir, slug, outcome: "failed", error, ...(code ? { code } : {}) });
    try {
      const err = itemError(item, paths);
      if (err) { results.push(fail(err)); continue; }
      const matches = await findSlugMatches(access, slug, db);
      if (matches.length) { results.push(fail(slugExistsMessage(matches), SLUG_EXISTS_CODE)); continue; }
      if ((await db.query(`select 1 from skills where namespace_id = $1 and lower(slug) = lower($2)`, [ns.id, slug])).rowCount) {
        results.push(fail(`a skill named '${slug}' already exists in this namespace`, SLUG_EXISTS_CODE));
        continue;
      }
      let payload: RevisionPayload = {
        metadata: {
          skillSlug: slug,
          title: str(item.metadata.title),
          description: str(item.metadata.description),
          categories: Array.isArray(item.metadata.categories) ? item.metadata.categories.filter((c): c is string => typeof c === "string") : [],
          toolHarness: str(item.metadata.toolHarness) || "generic",
          usageExamples: str(item.metadata.usageExamples) || null,
          visibility,
          sharedNamespaceIds: Array.isArray(input.sharedNamespaceIds) ? input.sharedNamespaceIds : [],
          ...(item.metadata.iconSha256 ? { iconSha256: item.metadata.iconSha256, iconSource: "upload" as const } : {}),
          ...(item.metadata.iconEmoji ? { iconEmoji: item.metadata.iconEmoji } : {}),
        },
        pointer: { url, ref, subdir, commit },
      };
      const payloadErr = await verifySubmissionPayload(db, access.userId, payload, { namespaceSlug: ns.slug, targetSkillId: null, access });
      if (payloadErr) { results.push(fail(payloadErr)); continue; }
      const dup = await findDuplicateSkill(access, { slug, pointer: { url, subdir } }, db);
      if (dup && enforcement === "block") {
        results.push(fail(`this skill is already in the catalog as ${dup.namespaceSlug}/${dup.skillSlug} — propose a new version of it instead`));
        continue;
      }
      const semver = str(item.semver);
      if (mode === "review") {
        const { id } = await createProposal(db, { submittedByUserId: access.userId, targetNamespaceId: ns.id, targetSkillId: null, proposedSemver: semver, payload, importId });
        results.push({ subdir, slug, outcome: "proposed", proposalId: id });
        continue;
      }
      // Direct publish: the §37.4 content check reads the folder's files; a failed fetch routes to review.
      const fetched = await (deps.fetchContent ?? fetchPointerContentForCheck)(url, ref, subdir, slug, maxBytes);
      const contentCheck = fetched.ok
        ? { findings: await runScanners(fetched.entries, PURE_SCANNERS), reportId: null, unreachable: false }
        : { findings: [], reportId: null, unreachable: true };
      const r = await directPublish(db, {
        access, actorUserId: access.userId, namespaceSlug: ns.slug, semver, payload, contentCheck, importId, routeOverrides: true,
      });
      if (!r.ok) results.push(fail(r.error, r.code));
      else if ("routed" in r) results.push({ subdir, slug, outcome: "routed", proposalId: r.proposalId, routedReason: r.routedReason });
      else results.push({ subdir, slug, outcome: "published" });
    } catch {
      results.push(fail("couldn’t create this one — try again"));
    }
  }

  const count = (o: ImportItemResult["outcome"]) => results.filter((r) => r.outcome === o).length;
  const proposed = count("proposed");
  const routed = count("routed");
  const published = count("published");
  const failed = count("failed");
  const created = proposed + routed + published;
  for (const r of results) M.repoImportSkills.inc({ outcome: r.outcome });
  M.repoImports.inc({ outcome: failed === 0 ? "ok" : created > 0 ? "partial" : "failed" });

  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query(
      `update proposal_imports set items_submitted = items_submitted + $2, items_created = items_created + $3, commit = $4, updated_at = now() where id = $1`,
      [importId, items.length, created, commit],
    );
    await notifyImport(client, { importId, namespaceId: ns.id, ns: ns.slug, repo: repoLabel(origin), submitterId: access.userId, count: proposed + routed });
    await appendAudit(client, {
      actorUserId: access.userId,
      action: "proposal.import",
      targetType: "proposal_import",
      targetId: importId,
      namespaceId: ns.id,
      after: { importId, originUrl: origin, ref, commit, folder, mode, submitted: items.length, proposed, published, routed, failed, slugs: results.filter((r) => r.outcome !== "failed").map((r) => r.slug) },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  return { ok: true, result: { importId, commit, results } };
}

/** §64.7: one notification to the namespace's reviewers and one to the submitter, per submit that
 *  created at least one proposal (a direct-published skill is not counted). */
async function notifyImport(
  client: PoolClient,
  input: { importId: string; namespaceId: string; ns: string; repo: string; submitterId: string; count: number },
): Promise<void> {
  if (input.count < 1) return;
  const fromName = (await client.query<{ display_name: string | null }>(`select display_name from users where id = $1`, [input.submitterId])).rows[0]?.display_name ?? null;
  const base = { importId: input.importId, ns: input.ns, repo: input.repo, count: input.count };
  await notifyNamespaceReviewers(client, { namespaceId: input.namespaceId, submitterId: input.submitterId, type: IMPORT_NEEDS_REVIEW, payload: { ...base, fromName } });
  await client.query(`insert into notifications (user_id, type, payload) values ($1, $2, $3::jsonb)`, [input.submitterId, IMPORT_SUBMITTED, JSON.stringify(base)]);
}
