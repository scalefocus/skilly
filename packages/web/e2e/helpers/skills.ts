// Shared bundle/proposal/cleanup helpers for the skilly e2e suite. Lifted from the original
// per-spec copies in chunked-upload.spec.ts / proposal-revise.spec.ts so every spec builds
// fixtures and cleans up the dev catalog the same way. All calls go through `page.request`,
// which shares the signed-in cookie jar (call devSignIn first).
import { randomBytes } from "node:crypto";
import AdmZip from "adm-zip";
import { expect, type Page } from "@playwright/test";

/** A tiny valid .skill (zip) bundle whose SKILL.md name matches `slug`. A random salt makes the
 *  content digest unique per build so duplicate detection never trips across repeated runs. */
export function buildSkillBundle(slug: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "SKILL.md",
    Buffer.from(
      `---\nname: ${slug}\ndescription: e2e fixture (safe to delete)\n---\n\n# ${slug}\n\nFixture bundle for the skilly e2e suite. salt=${randomBytes(8).toString("hex")}\n`,
    ),
  );
  return zip.toBuffer();
}

/** The subset of the /api/uploads contract a proposal needs (SKILLY_SPEC.md §6). */
export interface UploadResult {
  artifactObjectKey: string;
  artifactSha256: string;
  contentSha256: string;
  artifactFilename: string | null;
}

/** Single-shot upload of a fixture bundle → the upload contract fields a proposal carries. */
export async function uploadBundle(page: Page, slug: string): Promise<UploadResult> {
  const res = await page.request.post("/api/uploads", {
    multipart: {
      bundle: { name: `${slug}.skill`, mimeType: "application/zip", buffer: buildSkillBundle(slug) },
      skillSlug: slug,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

/** Create a NEW-skill hosted proposal in `namespaceSlug`. Returns the proposal id. */
export async function createHostedProposal(
  page: Page,
  opts: {
    namespaceSlug: string;
    skillSlug: string;
    semver?: string;
    title?: string;
    visibility?: "org" | "namespace";
    /** Overridable so a caller can seed a deliberately long description (§14 card geometry). */
    description?: string;
    categories?: string[];
  },
): Promise<string> {
  const upload = await uploadBundle(page, opts.skillSlug);
  const res = await page.request.post("/api/proposals", {
    data: {
      namespaceSlug: opts.namespaceSlug,
      semver: opts.semver ?? "1.0.0",
      metadata: {
        skillSlug: opts.skillSlug,
        title: opts.title ?? opts.skillSlug,
        description: opts.description ?? "e2e fixture proposal (safe to delete)",
        toolHarness: "generic",
        visibility: opts.visibility ?? "org",
        categories: opts.categories ?? [],
        tags: [],
      },
      ...upload,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id as string;
}

/** Archive-then-permanently-delete a hosted skill so the catalog is left clean. Platform-admin
 *  only (the dev user qualifies), and delete requires the skill be archived first (manage.ts).
 *  Best-effort so it is safe in a `finally`: tolerates an already-gone skill. */
export async function deleteSkillFully(page: Page, ns: string, slug: string): Promise<void> {
  await page.request.post(`/api/skills/${ns}/${slug}/archive`, { data: { archived: true } });
  const del = await page.request.post(`/api/skills/${ns}/${slug}/delete`);
  // 200 = deleted; 404 = already gone. Anything ≥ 500 is a real failure worth surfacing.
  expect(del.status(), await del.text()).toBeLessThan(500);
}
