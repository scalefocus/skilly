// e2e: skill icons (SKILLY_SPEC.md §33). A skill is proposed with an uploaded icon, reviewed and
// accepted (global always requires review), and the icon shows up on both the catalog card and
// the skill detail header. A follow-up new-version proposal removes the icon and the detail
// header falls back to the default skilly lockup.
//
// API-driven for the propose/review/accept mechanics (page.request shares the signed-in cookie
// jar) with UI assertions for the actual rendered <img>. Self-cleaning.
import { test, expect, devSignIn } from "./fixtures";
import { buildSkillBundle, deleteSkillFully } from "./helpers/skills";

/** A genuine 120x120 solid-navy PNG (well clear of the §33.3 64px floor), produced once with
 *  sharp during test authoring and frozen here as a base64 literal — no image library needed
 *  at test-run time. */
function tinyPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4CAIAAAC2BqGFAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABmElEQVR4nO3UwYlDARDD0Bx/JylQ/UMayDXrYXngCoSs1/POnt9DeKH8/IlqQAd0/+ltjA7o5hoyujk46ejmNDqgm2vI6ObgpKOb0+iAbq4ho5uDk45uTqMDurmGjG4OTjq6OY0O6OYaMro5OOno5jQ6oJtryOjm4KSjm9PogG6uIaObg5OObk6jA7q5hoxuDk46ujmNDujmGjK6OTjp6OY0OqCba8jo5uCko5vT6IBuriGjm4OTjm5OowO6uYaMbg5OOro5jQ7o5hoyujk46ejmNDqgm2vI6ObgpKOb0+iAbq4ho5uDk45uTqMDurmGjG4OTjq6OY0O6OYaMro5OOno5jQ6oJtryOjm4KSjm9PogG6uIaObg5OObk6jA7q5hoxuDk46ujmNDujmGjK6OTjp6OY0OqCba8jo5uCko5vT6IBuriGjm4OTjm5OowO6uYaMbg5OOro5jQ7o5hoyujk46ejmNDqgm2vI6ObgpKOb0+iAbq4ho5uDk45uTqMDurmGjG4OTjq6OY0O6OYaMro5OOlozvTrPpVkmo5hpk7ZAAAAAElFTkSuQmCC",
    "base64",
  );
}

async function uploadIcon(page: import("@playwright/test").Page): Promise<string> {
  const res = await page.request.post("/api/icons", {
    multipart: { icon: { name: "icon.png", mimeType: "image/png", buffer: tinyPng() } },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).sha256 as string;
}

async function acceptLatest(page: import("@playwright/test").Page, id: string): Promise<void> {
  const started = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "start_review" } });
  expect(started.ok(), await started.text()).toBeTruthy();
  const detail = await (await page.request.get(`/api/proposals/${id}`)).json();
  const last = detail.revisions.at(-1);
  const revisionNo: number = last.revisionNo ?? last.revision_no ?? detail.revisions.length;
  let accept = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo } });
  if (accept.status() === 409 && (await accept.json()).requiresOverride) {
    accept = await page.request.post(`/api/proposals/${id}/actions`, {
      data: { action: "accept", revisionNo, override: true, overrideReason: "e2e fixture" },
    });
  }
  expect(accept.ok(), await accept.text()).toBeTruthy();
}

test.describe.serial("skill icons (§33)", () => {
  test("an uploaded icon shows on the catalog card and the detail header; removing it falls back to the default", async ({ page }) => {
    await devSignIn(page);
    const slug = `e2e-icon-${Date.now().toString(36)}`;
    const title = "E2E Icon Journey";

    const iconSha = await uploadIcon(page);

    const upload = await page.request.post("/api/uploads", {
      multipart: {
        bundle: {
          name: `${slug}.skill`,
          mimeType: "application/zip",
          buffer: buildSkillBundle(slug),
        },
        skillSlug: slug,
      },
    });
    expect(upload.ok(), await upload.text()).toBeTruthy();
    const uploadJson = await upload.json();

    const created = await page.request.post("/api/proposals", {
      data: {
        namespaceSlug: "global",
        semver: "1.0.0",
        metadata: {
          skillSlug: slug, title, description: "e2e icon fixture (safe to delete)",
          toolHarness: "generic", visibility: "org", categories: [],
          iconSha256: iconSha, iconSource: "upload",
        },
        artifactObjectKey: uploadJson.artifactObjectKey,
        artifactSha256: uploadJson.artifactSha256,
        contentSha256: uploadJson.contentSha256,
        artifactFilename: uploadJson.artifactFilename,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const id = (await created.json()).id as string;

    try {
      await acceptLatest(page, id);

      // ── Catalog card shows the icon tile. ──
      await page.goto(`/catalog?q=${encodeURIComponent(title)}`);
      const card = page.locator(".skill-card", { hasText: title }).first();
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card.locator(`img[src="/skill-icons/${iconSha}.png"]`)).toBeVisible();

      // ── Detail header shows the same icon. ──
      await page.goto(`/skills/global/${slug}`);
      await expect(page.getByRole("heading", { name: title }).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(`img[src="/skill-icons/${iconSha}.png"]`).first()).toBeVisible();

      // ── New-version proposal that REMOVES the icon → auto-accept (global always reviews). ──
      const nv = await page.request.post("/api/proposals", {
        data: {
          namespaceSlug: "global", targetSkillSlug: slug, semver: "1.1.0",
          metadata: {
            skillSlug: slug, title, description: "e2e icon fixture (safe to delete)",
            toolHarness: "generic", visibility: "org", categories: [],
            whatChanged: "removed the icon",
            iconSha256: null, iconEmoji: null, iconSource: null,
          },
          reuseCurrentFiles: true,
        },
      });
      expect(nv.status(), await nv.text()).toBe(201);
      const nvId = (await nv.json()).id as string;
      await acceptLatest(page, nvId);

      // ── The header falls back to the default skilly wordmark lockup (no per-skill <img>). ──
      await page.goto(`/skills/global/${slug}`);
      await expect(page.getByRole("heading", { name: title }).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(`img[src="/skill-icons/${iconSha}.png"]`)).toHaveCount(0);
    } finally {
      await deleteSkillFully(page, "global", slug);
    }
  });
});
