// List the branches/tags a pointer (external git) repo publishes, for the propose form's
// "is the pinned ref real?" pre-check. This shells out to `git ls-remote`, so it is an
// SSRF-sensitive sink and reuses the EXACT same guards as the worker's mirror (git/mirror.ts):
// the shared URL validator, a DNS-resolution private-IP re-check, the https-only transport
// allowlist, no-redirects, no credential prompt, and a hard timeout. ls-remote only reads refs
// (no clone/checkout/hooks), so it's strictly less powerful than the mirror's clone. §6.
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { validatePointerUrl, isBlockedIp, isSkillsHubUrl, parseSkillsHubApiUrl } from "@skilly/shared";

const LS_REMOTE_TIMEOUT_MS = Number(process.env.POINTER_REFS_TIMEOUT_MS ?? 15_000);
// Generous cap so a valid ref is never missed (which would mis-fire the "ref not found" warning);
// the output-byte ceiling is the real bound. The UI only quick-picks the first dozen of each.
const MAX_REFS = 5000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

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
    return null; // unresolvable → ls-remote will just fail
  }
  return null;
}

function runLsRemote(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-c", "protocol.ext.allow=never",
        "-c", "protocol.file.allow=never",
        "-c", "protocol.allow=never",
        "-c", "protocol.https.allow=always",
        "-c", "http.followRedirects=false",
        "-c", "credential.helper=", // top-level: ls-remote has no -c of its own (unlike clone)
        "ls-remote", "--heads", "--tags", "--", url,
      ],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" } },
    );
    let out = "";
    let err = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, LS_REMOTE_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > MAX_OUTPUT_BYTES) { killed = true; child.kill("SIGKILL"); }
    });
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error("timed out reading the repository’s refs"));
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `git ls-remote failed (${code})`));
    });
  });
}

export type PointerRefsResult =
  | { ok: true; branches: string[]; tags: string[]; latest?: string }
  | { ok: false; error: string };

// skills-hub origins have no git refs — the "refs" are the registry's published VERSIONS,
// read from the skill's root API document (§6: versions[{version}], latestVersion). Returned
// as `tags` (+ `latest`) so the form's exists-upstream check and quick-picks work unchanged.
const HUB_FETCH_TIMEOUT_MS = Number(process.env.POINTER_REFS_TIMEOUT_MS ?? 15_000);
const HUB_MAX_RESPONSE_BYTES = 1024 * 1024;

async function listSkillsHubVersions(apiUrl: string): Promise<PointerRefsResult> {
  const hubSlug = parseSkillsHubApiUrl(apiUrl);
  if (!hubSlug) return { ok: false, error: "not a valid skills-hub skill URL" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HUB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, { signal: ctl.signal, headers: { accept: "application/json" }, redirect: "error" });
    if (res.status === 404) return { ok: false, error: `skills-hub has no skill “${hubSlug}” — check the slug` };
    if (!res.ok) return { ok: false, error: `skills-hub API answered ${res.status}` };
    const text = await res.text();
    if (text.length > HUB_MAX_RESPONSE_BYTES) return { ok: false, error: "skills-hub API response exceeds size limit" };
    const j = JSON.parse(text) as { versions?: Array<{ version?: unknown }>; latestVersion?: unknown };
    const tags: string[] = [];
    for (const v of j.versions ?? []) {
      if (typeof v?.version === "string" && !tags.includes(v.version)) tags.push(v.version);
      if (tags.length >= MAX_REFS) break;
    }
    const latest = typeof j.latestVersion === "string" ? j.latestVersion : tags[0];
    return { ok: true, branches: [], tags, ...(latest ? { latest } : {}) };
  } catch {
    return { ok: false, error: "couldn’t reach the skills-hub registry" };
  } finally {
    clearTimeout(timer);
  }
}

export async function listRemoteRefs(rawUrl: string): Promise<PointerRefsResult> {
  const url = rawUrl.trim();
  if (!url) return { ok: false, error: "enter a repository URL" };
  if (isSkillsHubUrl(url)) return listSkillsHubVersions(url);
  const urlErr = validatePointerUrl(url);
  if (urlErr) return { ok: false, error: urlErr };
  const blocked = await resolvesToBlockedIp(url);
  if (blocked) return { ok: false, error: `host resolves to a private/loopback address (${blocked})` };

  let raw: string;
  try {
    raw = await runLsRemote(url);
  } catch {
    // Don't surface raw git stderr (noisy / may name temp paths) — a concise hint is enough.
    return { ok: false, error: "couldn’t read this repository’s refs — check it’s a public git URL" };
  }

  const branches: string[] = [];
  const tags: string[] = [];
  for (const line of raw.split("\n")) {
    const m = /^[0-9a-f]{40}\s+refs\/(heads|tags)\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (!m || m[3]) continue; // skip dereferenced "^{}" peel lines (annotated-tag duplicates)
    const name = m[2]!;
    if (m[1] === "heads") {
      if (!branches.includes(name)) branches.push(name);
    } else if (!tags.includes(name)) {
      tags.push(name);
    }
    if (branches.length + tags.length >= MAX_REFS) break;
  }
  return { ok: true, branches, tags };
}
