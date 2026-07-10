// skills-hub.ai pointer-origin adapter — PINNED from source (SKILLY_SPEC.md §6).
// Verified against @skills-hub-ai/cli@0.4.1 (dist/commands/install.js) and the live API:
//   - `npx @skills-hub-ai/cli install <slug>` calls GET https://skills-hub.ai/api/v1/skills/<slug>
//     (JSON: name, description, latestVersion, versions[{version,createdAt}], instructions,
//     githubRepoUrl, updatedAt) and SYNTHESIZES a single SKILL.md locally from `instructions`.
//     There is NO git clone and NO tarball — the registry serves the body over its API.
//   - A pinned version is at GET .../skills/<slug>/versions/<version>
//     (JSON: version, instructions, contentHash, createdAt).
// skilly therefore mirrors a skills-hub pointer by FETCHING the pinned version's instructions
// and building the SKILL.md bundle itself (frontmatter name = the skilly slug, so the §6
// name==slug contract holds), then storing/scanning/serving it exactly like any other pointer.
// This module is pure (no node imports / no fetch) — the worker owns the HTTP.

export const SKILLS_HUB_HOST = "skills-hub.ai";
const API_PREFIX = "/api/v1/skills/";

/** Slug charset on skills-hub (creator-skillname). */
export function validateSkillsHubSlug(slug: string): string | null {
  if (!slug || slug.length > 120) return "skills-hub slug is required (max 120 chars)";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return "skills-hub slug must be lowercase kebab (letters, digits, -)";
  return null;
}

/**
 * Ref validator for skills-hub pointers: the registry has no branches — a pinned ref must be a
 * registry VERSION, bare semver ("1.0.0") or v-prefixed ("v1.0.0", stripped by the worker).
 * Anything branch-like ("main", "HEAD") would 404 on the version endpoint and burn every mirror
 * attempt, so it's rejected here at submit time (SKILLY_SPEC.md §6/§8).
 */
export function validateSkillsHubRef(ref: string): string | null {
  if (/^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(ref.trim())) return null;
  return `a skills-hub pointer pins a registry version (e.g. 1.0.0) — "${ref.trim() || "(empty)"}" is not one. Branches like "main" don't exist on the registry.`;
}

/** Canonical pointer origin URL stored for a skills-hub skill. */
export function skillsHubApiUrl(slug: string): string {
  return `https://${SKILLS_HUB_HOST}${API_PREFIX}${slug}`;
}

/** True when a pointer origin URL is a skills-hub API origin (the worker branches on this). */
export function isSkillsHubUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === SKILLS_HUB_HOST && u.pathname.startsWith(API_PREFIX);
  } catch {
    return false;
  }
}

/** Extract the hub slug back out of a canonical origin URL, or null. */
export function parseSkillsHubApiUrl(url: string): string | null {
  if (!isSkillsHubUrl(url)) return null;
  const slug = new URL(url).pathname.slice(API_PREFIX.length).split("/")[0] ?? "";
  return validateSkillsHubSlug(slug) ? null : slug;
}

/**
 * Build the mirrored SKILL.md from the registry's instructions. Frontmatter `name` is the
 * SKILLY slug (validateBundle enforces name==slug); description is flattened to one line.
 */
export function buildSkillsHubSkillMd(skillSlug: string, description: string, instructions: string): string {
  const desc = (description || "Mirrored from skills-hub.ai").replace(/\s+/g, " ").trim();
  return `---\nname: ${skillSlug}\ndescription: ${desc}\n---\n\n${instructions.trim()}\n`;
}
