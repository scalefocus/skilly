// Propose-time verification that a pointer (external git) source actually resolves to a SKILL.md
// at the pinned ref + folder — so a wrong URL/ref/folder (or a repo with no SKILL.md) is rejected
// BEFORE the proposal is created, instead of dead-lettering at mirror time (the worker's
// cloneAndPack throws "no SKILL.md found …" only on accept). SKILLY_SPEC.md §6, §8.
//
// SSRF-hardened identically to the ref pre-check (lib/pointerRefs.ts) and the worker mirror
// (worker/git/mirror.ts): the shared URL validator + a DNS-rebind private-IP re-check + an
// https-only transport allowlist + no-redirects + no credential prompt + a hard timeout. The
// resolution mirrors the worker's (literal <subdir>/SKILL.md, else a folder named after the skill
// that contains one); the canonical version lives in worker/git/mirror.ts (cloneAndPack).
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { validatePointerUrl, validateGitRef, validateSubdir, isBlockedIp, isSkillsHubUrl } from "@skilly/shared";

const VERIFY_TIMEOUT_MS = Number(process.env.POINTER_VERIFY_TIMEOUT_MS ?? 30_000);

// https-only transport, no redirects, no ext::/file:: helpers, no credential prompt — identical
// posture to the mirror's clone.
const PROTO = ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false"];

/** Reject when the host resolves to any private/loopback/link-local address (DNS-rebinding/SSRF). */
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
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, VERIFY_TIMEOUT_MS);
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

export type PointerVerifyResult = { ok: true } | { ok: false; error: string };

/**
 * Confirm `<url>@<ref>` contains a SKILL.md for `subdir` (or repo root). Returns ok, or a
 * user-facing error. skills-hub registry URLs are fetched via the registry API (not git), so they
 * skip this check.
 */
export async function verifyPointerSkill(rawUrl: string, ref: string, subdir: string | null | undefined): Promise<PointerVerifyResult> {
  const url = rawUrl.trim();
  if (isSkillsHubUrl(url)) return { ok: true };

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

  // Tolerate the v-prefix convention mismatch like the mirror (try the ref, then its toggle).
  const alt = /^v\d/.test(ref) ? ref.slice(1) : /^\d/.test(ref) ? `v${ref}` : null;
  const refCandidates = alt && !validateGitRef(alt) ? [ref, alt] : [ref];

  const tmp = await mkdtemp(join(tmpdir(), "skilly-verify-"));
  try {
    const dir = join(tmp, "src");
    let cloned = false;
    for (const candidate of refCandidates) {
      try {
        // Partial, treeless-of-blobs, no working tree — fetches just the commit + trees so
        // `ls-tree` can list paths without downloading file contents.
        await git([...PROTO, "clone", "--depth", "1", "--no-checkout", "--filter=blob:none", "--branch", candidate, "-c", "credential.helper=", "--", url, dir]);
        cloned = true;
        break;
      } catch (err) {
        if (!/not found in upstream|Could not find remote branch|remote branch .* not found/i.test(String(err))) {
          return { ok: false, error: "couldn’t read this repository at that ref — check the URL is a public git repo and the pinned ref exists" };
        }
      }
    }
    if (!cloned) return { ok: false, error: `ref '${ref}' was not found in ${url}` };

    const paths = (await git(["-C", dir, "ls-tree", "-r", "--name-only", "HEAD"]))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const found = clean
      ? paths.includes(`${clean}/SKILL.md`) || matchesByName(paths, clean)
      : paths.includes("SKILL.md");

    if (!found) {
      const where = clean ? `folder '${clean}'` : "the repository root";
      return { ok: false, error: `no SKILL.md found in ${where} of ${url} at ${ref} — check the repository, the pinned ref, and the skill folder` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "couldn’t verify the repository — check it’s a public git URL and the pinned ref exists" };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Mirror fallback: a folder named like the skill's last path segment that holds a SKILL.md (e.g.
 *  `.claude/skills/<name>/SKILL.md`). */
function matchesByName(paths: string[], subdir: string): boolean {
  const name = subdir.split("/").filter(Boolean).pop() ?? "";
  if (!name) return false;
  const re = new RegExp(`(^|/)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/SKILL\\.md$`);
  return paths.some((p) => re.test(p));
}
