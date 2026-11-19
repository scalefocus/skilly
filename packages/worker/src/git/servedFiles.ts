// The files a version's tag serves, derived from its stored artifact — ONE definition used by the
// publish sweep, the self-heal re-synthesis, the marketplace sync and the signing sweeps, so a tag
// re-synthesized from the artifact is byte-identical to the one first published, and a signed
// statement (SKILLY_SPEC.md §73) describes exactly what a clone receives.
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
export function ensureSkillName(files: SkillFile[], skillSlug: string): SkillFile[] {
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

/** The served file set of a stored artifact: extracted, with `name: <slug>` ensured in SKILL.md. */
export async function servedFilesFromArtifact(bytes: Buffer, skillSlug: string, cap: number): Promise<SkillFile[]> {
  return ensureSkillName(await extractBundle(bytes, cap), skillSlug);
}
