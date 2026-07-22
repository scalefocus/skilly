// Pointer-skill mirroring. Clones an external repo at a PINNED immutable ref, packs the
// SKILL.md bundle, validates it, stores it as the canonical artifact, and creates an
// (unpublished) skill_version. The existing publish sweep then scans + synthesizes it —
// so Pointer and Hosted share ONE serving path. SKILLY_SPEC.md §6, §7, §9.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { lookup } from "node:dns/promises";
import { create } from "tar";
import { validateBundle, validatePointerUrl, validateGitRef, validateSubdir, isSkillsHubUrl, isBlockedIp, contentDigest, bundleContentCap, type BundleEntry } from "@skilly/shared";
import { getMaxBundleBytes } from "../settings.js";
import type { Pool } from "pg";
import type { ArtifactStore } from "../storage/objectStore.js";
import { runScanPipeline } from "../scan/pipeline.js";
import { writeArtifactScanReport } from "../scan/report.js";
import { fetchSkillsHubBundle } from "./skillsHub.js";

const GIT_CLONE_TIMEOUT_MS = Number(process.env.MIRROR_CLONE_TIMEOUT_MS ?? 120_000);

/**
 * Resolve the URL's host and return a blocked address if ANY resolution is private/loopback/
 * link-local (SSRF via DNS / rebinding). Returns null when all resolved addresses are public,
 * or when the host can't be resolved (the clone will then simply fail — not our concern here).
 */
async function resolvesToBlockedIp(rawUrl: string): Promise<string | null> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    return null;
  }
  // Literal IPs were already screened by validatePointerUrl; resolve names only.
  if (isBlockedIp(host)) return host;
  try {
    const addrs = await lookup(host, { all: true });
    for (const a of addrs) if (isBlockedIp(a.address)) return a.address;
  } catch {
    return null; // unresolvable → let the clone fail naturally
  }
  return null;
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
    });
    let err = "";
    let timedOut = false;
    // Kill a stuck clone so it can't block the leader sweep or leak a child process.
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, GIT_CLONE_TIMEOUT_MS);
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${cmd} timed out after ${GIT_CLONE_TIMEOUT_MS}ms`));
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${err}`));
    });
  });
}

// Fallback cap when a caller doesn't pass the configured max_bundle_bytes (e.g. tests). The mirror
// pipeline passes the platform cap (bundleContentCap(getMaxBundleBytes)) so a pointer skill up to
// the admin's limit mirrors successfully. §6.
const DEFAULT_MIRROR_MAX_BYTES = 50 * 1024 * 1024;
const MIRROR_MAX_ENTRIES = 5000;

async function walk(dir: string, base: string, out: BundleEntry[], acc: { total: number; count: number }, maxBytes: number): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, base, out, acc, maxBytes);
    else if (entry.isFile()) {
      const st = await stat(abs);
      if (st.size > maxBytes) throw new Error(`mirrored file too large: ${entry.name}`);
      acc.total += st.size;
      acc.count += 1;
      if (acc.total > maxBytes || acc.count > MIRROR_MAX_ENTRIES) {
        throw new Error("mirrored repo exceeds size/entry limits");
      }
      out.push({ path: relative(base, abs).split(sep).join("/"), bytes: await readFile(abs) });
    }
    // Non-regular entries (symlinks etc.) are skipped — only files/dirs are packed.
  }
}

const hasSkillMd = async (dir: string): Promise<boolean> => (await stat(join(dir, "SKILL.md")).catch(() => null))?.isFile() ?? false;

/**
 * Locate a skill folder by name when the pinned subdir isn't a literal top-level path. Skill
 * repos commonly nest the skill under a harness folder (e.g. `.claude/skills/<name>/SKILL.md`),
 * while the proposer pins just the skill name — mirror the way `npx skills add --skill <name>`
 * resolves it. Bounded BFS (depth-capped, .git skipped), deterministic (sorted), returns the
 * absolute path of the first folder named `name` that contains a SKILL.md, or null.
 */
async function findSkillDir(root: string, name: string, maxDepth: number): Promise<string | null> {
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level.sort()) {
      const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && e.name !== ".git");
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = join(dir, e.name);
        if (e.name === name && (await hasSkillMd(abs))) return abs;
        next.push(abs);
      }
    }
    level = next;
  }
  return null;
}

/**
 * Shallow-clone an external repo at a pinned ref and pack its bundle (no .git). When `subdir`
 * is given, ONLY that folder is packed, rebased so `<subdir>/SKILL.md` becomes `SKILL.md` at
 * the bundle root — so a skill inside a multi-skill repo mirrors into a clean single-skill repo
 * (skilly's "one skill = one repo, SKILL.md at root" model). The skill must be self-contained
 * within its subdir; files outside it are dropped. SKILLY_SPEC.md §6.
 */
export async function cloneAndPack(externalUrl: string, ref: string, subdir?: string | null, maxBytes: number = DEFAULT_MIRROR_MAX_BYTES): Promise<{ files: BundleEntry[]; targz: Buffer }> {
  // Defense-in-depth: the web layer always validates user-submitted URLs at the API boundary;
  // this re-check guards the actual SSRF/RCE sink (the worker holds DB + object-store creds).
  // SKILLY_MIRROR_ALLOW_INSECURE=1 relaxes ONLY this worker-side scheme/host check + git
  // protocol allowlist — for integration tests and trusted air-gapped local mirrors. It does
  // NOT open the user-facing API (the web validator has no such flag). SKILLY_SPEC.md §6.
  const allowInsecure = process.env.SKILLY_MIRROR_ALLOW_INSECURE === "1";
  if (!allowInsecure) {
    const urlErr = validatePointerUrl(externalUrl);
    if (urlErr) throw new Error(`unsafe pointer URL: ${urlErr}`);
    // DNS-rebinding / DNS-based SSRF defense: validatePointerUrl only checks the literal host,
    // but git resolves DNS itself at fetch time. Resolve here and reject if ANY resolved
    // address is private/loopback/link-local. (TOCTOU vs git's own later resolution is narrowed
    // by also disabling redirects below; a hardened deployment should additionally pin egress.)
    const blocked = await resolvesToBlockedIp(externalUrl);
    if (blocked) throw new Error(`unsafe pointer URL: host resolves to a private/loopback address (${blocked})`);
  }
  const refErr = validateGitRef(ref); // ref is always validated (flag value of --branch)
  if (refErr) throw new Error(`unsafe pointer ref: ${refErr}`);
  // Subdir is a path-traversal sink (it's joined onto the clone dir) — always validate it,
  // regardless of the insecure-transport opt-in.
  const cleanSubdir = subdir?.trim() || null;
  if (cleanSubdir) {
    const subErr = validateSubdir(cleanSubdir);
    if (subErr) throw new Error(`unsafe pointer subdir: ${subErr}`);
  }

  // Pin the allowed git transports. Strict (default): https only — the ext:: helper (arbitrary
  // command execution) and file:// are disabled. Insecure opt-in ADDS local file:// but STILL
  // disables ext:: (RCE) — relaxing transport must never re-enable command execution.
  const protocolArgs = allowInsecure
    ? ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=always", "-c", "protocol.https.allow=always"]
    : ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always"];
  // Never follow redirects: a 30x to an internal host would side-step the resolved-IP check.
  protocolArgs.push("-c", "http.followRedirects=false");

  // Tolerate the `v`-prefix convention mismatch: a proposer often pins "1.0.0" while the repo
  // tags releases "v1.0.0" (or vice-versa). Try the given ref, then the toggled form ONLY when
  // git reports the ref doesn't exist — any other failure (network, auth, transport) propagates
  // immediately. Still a single pinned ref; we just resolve the user's intent across conventions.
  const alt = /^v\d/.test(ref) ? ref.slice(1) : /^\d/.test(ref) ? `v${ref}` : null;
  const refCandidates = alt && !validateGitRef(alt) ? [ref, alt] : [ref];

  const tmp = await mkdtemp(join(tmpdir(), "skilly-mirror-"));
  try {
    const src = join(tmp, "src");
    // Pinned ref only: --branch accepts a tag or branch; reject moving targets upstream.
    let cloned = false;
    let lastErr: unknown;
    for (const candidate of refCandidates) {
      try {
        await run("git", [
          ...protocolArgs,
          "clone", "--depth", "1", "--branch", candidate, "-c", "credential.helper=", "--", externalUrl, src,
        ]);
        cloned = true;
        break;
      } catch (err) {
        lastErr = err;
        // Only fall through to the alternate ref form on a genuine "ref not found".
        if (!/not found in upstream|Could not find remote branch|remote branch .* not found/i.test(String(err))) throw err;
      }
    }
    if (!cloned) throw lastErr;

    // Mirror only the requested subdir (validated above), rebased so SKILL.md lands at root.
    // Resolve + containment-check defends against any traversal that slipped past validation.
    let base = cleanSubdir ? resolve(src, cleanSubdir) : src;
    const srcRoot = resolve(src);
    if (base !== srcRoot && !base.startsWith(srcRoot + sep)) {
      throw new Error(`pointer subdir escapes the repository: ${cleanSubdir}`);
    }
    if (cleanSubdir && !(await hasSkillMd(base))) {
      // The literal path didn't hold a SKILL.md. Skill repos routinely nest the skill under a
      // harness folder (e.g. .claude/skills/<name>/SKILL.md) while the proposer pins just the
      // name — search for it the way the consumer's `--skill <name>` does before giving up.
      const name = cleanSubdir.split("/").filter(Boolean).pop() ?? "";
      const found = name ? await findSkillDir(srcRoot, name, 5) : null;
      if (!found) throw new Error(`no SKILL.md found for '${cleanSubdir}' in ${externalUrl} at ${ref}`);
      base = found;
    }

    const files: BundleEntry[] = [];
    await walk(base, base, files, { total: 0, count: 0 }, maxBytes);

    const out = join(tmp, "bundle.tgz");
    await create({ gzip: true, file: out, cwd: base }, files.map((f) => f.path));
    const targz = await readFile(out);
    return { files, targz };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export interface MirrorInput {
  skillId: string;
  skillSlug: string;
  semver: string;
  externalUrl: string;
  ref: string;
  /** Folder inside a multi-skill upstream repo where SKILL.md lives; null/undefined = repo root. */
  subdir?: string | null;
  createdBy: string | null;
  isPrerelease: boolean;
  /** Per-version "What changed" note carried from the proposal (§8); null for a first version. */
  whatChanged?: string | null;
}

/**
 * Fetch a pointer's files at its pinned ref — git clone for git origins, the registry API for
 * skills-hub origins (§6). One entry point so mirror + refresh stay in lockstep.
 */
export async function fetchPointerFiles(
  externalUrl: string,
  ref: string,
  subdir: string | null | undefined,
  skillSlug: string,
  maxBytes: number = DEFAULT_MIRROR_MAX_BYTES,
): Promise<{ files: BundleEntry[]; targz: Buffer }> {
  return isSkillsHubUrl(externalUrl)
    ? fetchSkillsHubBundle(externalUrl, ref, skillSlug)
    : cloneAndPack(externalUrl, ref, subdir, maxBytes);
}

/** Mirror an external pointer ref into a stored, unpublished skill_version. */
export async function mirrorPointerVersion(pool: Pool, store: ArtifactStore, input: MirrorInput): Promise<{ versionId: string; artifactKey: string }> {
  // Honor the platform's configured max so a pointer skill up to the admin's limit mirrors. §6.
  const cap = bundleContentCap(await getMaxBundleBytes(pool));
  const { files, targz } = await fetchPointerFiles(input.externalUrl, input.ref, input.subdir, input.skillSlug, cap);

  // Blocking validation at ingest (before we store/publish).
  const v = validateBundle(files, { skillSlug: input.skillSlug, maxBytes: cap });
  if (!v.ok) throw new Error(`pointer bundle invalid: ${v.errors.join("; ")}`);

  const artifactKey = `pointers/${input.skillId}/v${input.semver}.tgz`;
  await store.put(artifactKey, targz);
  const sha = createHash("sha256").update(targz).digest("hex");
  // Packaging-independent content digest for duplicate detection (§8) — matches what the upload
  // route computes for hosted bundles, so a mirrored pointer and an identical hosted upload share it.
  const contentSha = contentDigest(files);

  // Advisory scan at ingest (mirror time) so reviewers see findings pre-accept.
  const findings = await runScanPipeline(files);
  await writeArtifactScanReport(pool, artifactKey, findings);

  const { rows } = await pool.query<{ id: string }>(
    `insert into skill_versions
       (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, content_sha256,
        external_ref, external_origin_url, external_subdir, what_changed, created_by, git_published)
     values ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11,false)
     returning id`,
    [input.skillId, input.semver, input.isPrerelease, artifactKey, sha, contentSha, input.ref, input.externalUrl, input.subdir?.trim() || null, input.whatChanged ?? null, input.createdBy],
  );
  return { versionId: rows[0]!.id, artifactKey };
}
