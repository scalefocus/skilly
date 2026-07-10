// skills-hub.ai pointer mirroring (SKILLY_SPEC.md §6). The registry serves a skill's body over
// its JSON API (no git, no tarball — pinned from @skills-hub-ai/cli source; see
// shared/skills-hub.ts). Mirroring = fetch the PINNED version's instructions + the skill's
// description, build the SKILL.md bundle ourselves (frontmatter name = skilly slug), and hand
// the same {files, targz} shape to the existing validate→scan→store→synthesize path.
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { validatePointerUrl, parseSkillsHubApiUrl, buildSkillsHubSkillMd, type BundleEntry } from "@skilly/shared";

const FETCH_TIMEOUT_MS = Number(process.env.SKILLS_HUB_FETCH_TIMEOUT_MS ?? 30_000);
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // a SKILL.md body, not an artifact — 5MB is generous

async function getJson(url: string): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" }, redirect: "error" });
    if (!res.ok) throw new Error(`skills-hub API ${res.status} for ${url}`);
    // Reject before buffering when the server declares an oversized body (audit F7).
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_RESPONSE_BYTES) throw new Error("skills-hub API response exceeds size limit");
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error("skills-hub API response exceeds size limit");
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a pinned skills-hub version and pack it as a one-file SKILL.md bundle.
 * `ref` is the registry VERSION (e.g. "1.0.0") — it must exist upstream; a missing version
 * fails loudly (404), mirroring the pinned-ref discipline of git pointers (§6/§7).
 */
export async function fetchSkillsHubBundle(apiUrl: string, ref: string, skillSlug: string): Promise<{ files: BundleEntry[]; targz: Buffer }> {
  // Same boundary as the git path: the worker re-validates the user-supplied origin URL.
  const urlErr = validatePointerUrl(apiUrl);
  if (urlErr) throw new Error(`unsafe pointer URL: ${urlErr}`);
  const hubSlug = parseSkillsHubApiUrl(apiUrl);
  if (!hubSlug) throw new Error(`not a skills-hub origin URL: ${apiUrl}`);

  // Pointer refs follow the git-tag convention ("v1.0.0") but skills-hub version ids are
  // bare semver ("1.0.0") — normalize so either stored form resolves upstream.
  const hubVersion = ref.replace(/^v(?=\d)/, "");

  // Pinned version's instructions + the skill's description (root metadata).
  const [meta, version] = await Promise.all([getJson(apiUrl), getJson(`${apiUrl}/versions/${encodeURIComponent(hubVersion)}`)]);
  const instructions = typeof version.instructions === "string" ? version.instructions : null;
  if (!instructions) throw new Error(`skills-hub version ${hubVersion} of '${hubSlug}' has no instructions`);
  const description = typeof meta.description === "string" ? meta.description : "";

  const md = buildSkillsHubSkillMd(skillSlug, description, instructions);
  const bytes = Buffer.from(md, "utf8");
  const files: BundleEntry[] = [{ path: "SKILL.md", bytes }];

  // Pack via tar-on-disk like cloneAndPack, so everything downstream stays format-identical.
  const tmp = await mkdtemp(join(tmpdir(), "skilly-hub-"));
  try {
    await writeFile(join(tmp, "SKILL.md"), bytes);
    const out = join(tmp, "bundle.tgz");
    await create({ gzip: true, file: out, cwd: tmp }, ["SKILL.md"]);
    return { files, targz: await readFile(out) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
