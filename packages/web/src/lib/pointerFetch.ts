// On-demand fetch of a FRESH pointer proposal's proposed files, for the reviewer file-change view
// (SKILLY_SPEC.md §8). A fresh pointer proposal has no skilly-stored bundle before accept, so to
// diff its files we check out the pinned ref AT REVIEW TIME — a bounded, SSRF-hardened shallow
// clone with a working tree (unlike the blobless verify clone in pointerVerify.ts) — and read the
// skill folder's files. Identical transport / DNS-rebind / timeout guards to pointerVerify.ts and
// the worker mirror (worker/git/mirror.ts). Git sources only; skills-hub registry sources are not
// git-cloneable, so they degrade to "no file diff" at the call site.
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { lookup } from "node:dns/promises";
import { validatePointerUrl, validateGitRef, validateSubdir, isBlockedIp, isSkillsHubUrl, type BundleEntry } from "@skilly/shared";

const FETCH_TIMEOUT_MS = Number(process.env.POINTER_FETCH_TIMEOUT_MS ?? 60_000);
// Bounds so a huge upstream repo can never exhaust the web tier's memory/disk while a reviewer looks.
const MAX_TOTAL_BYTES = Number(process.env.POINTER_FETCH_MAX_BYTES ?? 25 * 1024 * 1024);
const MAX_ENTRIES = 5000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// https-only, no redirects, no ext::/file:: helpers, no credential prompt — same posture as the
// verify clone.
const PROTO = ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false"];

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

function git(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" } });
    let out = "";
    let err = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, FETCH_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error("timed out"));
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `git failed (${code})`));
    });
  });
}

const hasSkillMd = async (dir: string): Promise<boolean> => (await stat(join(dir, "SKILL.md")).catch(() => null))?.isFile() ?? false;

/** Bounded BFS for a folder named `name` that holds a SKILL.md — mirror's findSkillDir, so review
 *  resolves the skill folder exactly as the mirror will on accept. */
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

async function walk(dir: string, base: string, out: BundleEntry[], acc: { total: number; count: number }): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, base, out, acc);
    else if (entry.isFile()) {
      const st = await stat(abs);
      if (st.size > MAX_FILE_BYTES) throw new Error(`file too large to review-diff: ${entry.name}`);
      acc.total += st.size;
      acc.count += 1;
      if (acc.total > MAX_TOTAL_BYTES || acc.count > MAX_ENTRIES) throw new Error("upstream repo exceeds review-diff size/entry limits");
      out.push({ path: relative(base, abs).split(sep).join("/"), bytes: await readFile(abs) });
    }
  }
}

export type PointerFetchResult = { ok: true; entries: BundleEntry[] } | { ok: false; error: string };

/**
 * Check out `<url>@<ref>` and return the skill folder's files (rebased so `<subdir>/SKILL.md`
 * becomes `SKILL.md` at the root), matching how the worker mirror packs them — so a review diff
 * lines up with what will be published on accept. Git origins only.
 */
export async function fetchPointerReviewEntries(rawUrl: string, ref: string, subdir: string | null | undefined): Promise<PointerFetchResult> {
  const url = rawUrl.trim();
  if (isSkillsHubUrl(url)) return { ok: false, error: "file diff isn’t available for skills-hub sources — the files are verified on accept" };

  const urlErr = validatePointerUrl(url);
  if (urlErr) return { ok: false, error: urlErr };
  const refErr = validateGitRef(ref);
  if (refErr) return { ok: false, error: refErr };
  const clean = subdir?.trim().replace(/^\/+|\/+$/g, "") || null;
  if (clean) {
    const subErr = validateSubdir(clean);
    if (subErr) return { ok: false, error: subErr };
  }
  const blocked = await resolvesToBlockedIp(url);
  if (blocked) return { ok: false, error: `host resolves to a private/loopback address (${blocked})` };

  // Tolerate the v-prefix convention mismatch like the mirror/verify (try the ref, then its toggle).
  const alt = /^v\d/.test(ref) ? ref.slice(1) : /^\d/.test(ref) ? `v${ref}` : null;
  const refCandidates = alt && !validateGitRef(alt) ? [ref, alt] : [ref];

  const tmp = await mkdtemp(join(tmpdir(), "skilly-review-"));
  try {
    const src = join(tmp, "src");
    let cloned = false;
    for (const candidate of refCandidates) {
      try {
        await git([...PROTO, "clone", "--depth", "1", "--branch", candidate, "-c", "credential.helper=", "--", url, src]);
        cloned = true;
        break;
      } catch (err) {
        if (!/not found in upstream|Could not find remote branch|remote branch .* not found/i.test(String(err))) {
          return { ok: false, error: "couldn’t read this repository at that ref — check the URL and the pinned ref" };
        }
      }
    }
    if (!cloned) return { ok: false, error: `ref '${ref}' was not found in ${url}` };

    // Resolve the skill folder the way the mirror does (literal subdir, else a folder named after
    // the skill's last path segment that holds a SKILL.md), with a containment check.
    const srcRoot = resolve(src);
    let base = clean ? resolve(src, clean) : src;
    if (base !== srcRoot && !base.startsWith(srcRoot + sep)) return { ok: false, error: "subdir escapes the repository" };
    if (clean && !(await hasSkillMd(base))) {
      const name = clean.split("/").filter(Boolean).pop() ?? "";
      const found = name ? await findSkillDir(srcRoot, name, 5) : null;
      if (!found) return { ok: false, error: `no SKILL.md found for '${clean}' at ${ref}` };
      base = found;
    }

    const entries: BundleEntry[] = [];
    await walk(base, base, entries, { total: 0, count: 0 });
    return { ok: true, entries };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
