// e2e: skill deprecation with a successor (SKILLY_SPEC.md §45). Runs against the dev stack
// (SKILLY_DEV_AUTH=1, a platform-admin dev user). The seeded, installable `global/lint-fixer` is
// deprecated in favour of the seeded `global/pdf-tools`:
//   detail page: Deprecate… → dialog → pick the successor → the banner, the header pill and the
//   install warning appear while the Install button stays; the successor's page shows "Replaces";
//   catalog: the card carries the `deprecated` pill; Installed page: the dev user's lint-fixer row
//   gets the marker, the successor link and **install latest**, which mints pdf-tools' command;
//   notifications: the bell inbox lists "Skill deprecated" (the dev user watches/installs it);
//   un-deprecate from the UI clears everything. Self-cleaning: always un-deprecates in `finally`.
//
// The git-side hint (the `main` commit) needs the worker's publish sweep against real repos, which
// this dev-server suite has no git repos for; it is covered by packages/worker/src/git/mainRef.test.ts.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { awaitApi, gotoLoaded } from "./helpers/ready";

const OLD = "/skills/global/lint-fixer";
const OLD_DETAIL = /\/api\/skills\/global\/lint-fixer$/;
const NEW_DETAIL = /\/api\/skills\/global\/pdf-tools$/;
const undeprecate = (page: Page) => page.request.delete("/api/skills/global/lint-fixer/deprecation");

// Mutates the shared dev catalog's lint-fixer — never interleave with another lint-fixer test.
test.describe.configure({ mode: "serial" });

test.describe("skill deprecation with a successor (@global/lint-fixer → @global/pdf-tools)", () => {
  test("deprecate → marker on detail, catalog, Installed (install latest) and the inbox → un-deprecate clears", async ({ page }) => {
    await devSignIn(page);
    // Known starting state, set server-side (204 either way).
    expect((await undeprecate(page)).status()).toBe(204);

    try {
      await gotoLoaded(page, OLD, OLD_DETAIL);
      const deprecateBtn = page.getByRole("button", { name: "Deprecate…", exact: true });
      // The control is owner-ns/platform-admin only — its presence also asserts the dev user's role.
      await expect(deprecateBtn).toBeVisible();
      await expect(page.getByTestId("deprecation-banner")).toHaveCount(0);

      // Dialog: pick pdf-tools as the successor, add a note, save (PUT → detail refetch).
      await deprecateBtn.click();
      const dialog = page.getByTestId("deprecate-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("successor-search").fill("pdf");
      await dialog.getByRole("option", { name: /PDF Tools/ }).click();
      await expect(dialog.getByTestId("successor-picked")).toContainText("PDF Tools");
      await dialog.getByTestId("deprecation-note").fill("e2e: lint-fixer is retired.");
      let refreshed = awaitApi(page, OLD_DETAIL);
      const put = page.waitForResponse((r) => r.url().includes("/api/skills/global/lint-fixer/deprecation") && r.request().method() === "PUT");
      await dialog.getByTestId("deprecate-save").click();
      expect((await put).ok()).toBeTruthy();
      await refreshed;

      // Detail page: banner (successor + note), header pill, install warning — and Install still offered.
      const banner = page.getByTestId("deprecation-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("This skill is deprecated. Use PDF Tools instead.");
      await expect(banner).toContainText("e2e: lint-fixer is retired.");
      await expect(page.getByTestId("go-to-successor")).toHaveAttribute("href", "/skills/global/pdf-tools");
      await expect(page.getByTestId("deprecated-pill").first()).toBeVisible();
      await expect(page.getByTestId("install-deprecation-warning")).toContainText("consider installing PDF Tools instead");
      await expect(page.getByRole("button", { name: "Install latest", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit deprecation…", exact: true })).toBeVisible();
      // The API payload: successorState ok, canDeprecate, and the sort/visibility-independent fields.
      const detail = (await (await page.request.get("/api/skills/global/lint-fixer")).json()) as { deprecation: { successorState: string; successor: { skillSlug: string } | null; note: string } | null; canFeature: boolean; canPromote: boolean };
      expect(detail.deprecation).toMatchObject({ successorState: "ok", successor: { skillSlug: "pdf-tools" }, note: "e2e: lint-fixer is retired." });
      expect(detail.canFeature).toBe(false);

      // The successor's page says what it replaces.
      await gotoLoaded(page, "/skills/global/pdf-tools", NEW_DETAIL);
      await expect(page.getByTestId("replaces-line")).toContainText("global/lint-fixer");

      // Catalog: the lint-fixer card carries the pill; the list sorts it after live skills.
      await gotoLoaded(page, "/catalog", /\/api\/skills(\?|$)/);
      const card = page.locator('a[href="/skills/global/lint-fixer"]').first();
      await expect(card).toBeVisible();
      await expect(card.getByTestId("deprecated-pill")).toBeVisible();
      const list = (await (await page.request.get("/api/skills?limit=100")).json()) as { skills: Array<{ skillSlug: string; deprecation: unknown }> };
      const lint = list.skills.find((s) => s.skillSlug === "lint-fixer")!;
      expect(lint.deprecation).toMatchObject({ successor: { skillSlug: "pdf-tools" } });
      const firstDeprecated = list.skills.findIndex((s) => s.deprecation);
      expect(list.skills.slice(firstDeprecated).every((s) => s.deprecation)).toBeTruthy();

      // Installed page: the seeded lint-fixer install shows the marker, the successor link and
      // "install latest" → mints pdf-tools' command (lint-fixer's row stays).
      await gotoLoaded(page, "/installed", /\/api\/installs$/);
      const row = page.locator(".installed-row", { has: page.locator('a[href="/skills/global/lint-fixer"]') });
      await expect(row.getByTestId("installed-deprecated-pill")).toBeVisible();
      await expect(row.getByRole("link", { name: "PDF Tools" })).toHaveAttribute("href", "/skills/global/pdf-tools");
      await row.getByTestId("install-latest").click();
      const panel = row.getByTestId("install-latest-panel");
      await expect(panel).toBeVisible();
      const mint = page.waitForResponse((r) => r.url().includes("/api/skills/global/pdf-tools/install") && r.request().method() === "POST");
      await panel.getByTestId("install-latest-generate").click();
      const minted = (await (await mint).json()) as { command: string; semver: string | null };
      expect(minted.semver).toBeNull();
      expect(minted.command).toMatch(/npx skills add .*\/global\/pdf-tools\.git/);
      await expect(panel.getByText(/npx skills add/)).toBeVisible();
      await expect(row.locator('a[href="/skills/global/lint-fixer"]').first()).toBeVisible();

      // (The §45.6 fan-out is asserted in src/lib/deprecation.dbtest.ts — the dev user is the actor
      // here, so their own inbox deliberately gets no `skill.deprecated` row.)

      // Un-deprecate through the UI → everything clears.
      await gotoLoaded(page, OLD, OLD_DETAIL);
      page.once("dialog", (d) => d.accept());
      refreshed = awaitApi(page, OLD_DETAIL);
      const del = page.waitForResponse((r) => r.url().includes("/api/skills/global/lint-fixer/deprecation") && r.request().method() === "DELETE");
      await page.getByRole("button", { name: "Un-deprecate", exact: true }).click();
      expect((await del).status()).toBe(204);
      await refreshed;
      await expect(page.getByTestId("deprecation-banner")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Deprecate…", exact: true })).toBeVisible();
    } finally {
      await undeprecate(page); // never leave the seed deprecated, whatever failed above
    }
  });
});
