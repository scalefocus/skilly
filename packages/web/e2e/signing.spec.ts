// e2e: signed skill versions in the browser (SKILLY_SPEC.md §73.7, §73.8). Against the seeded,
// org-visible `global/pdf-tools`, whose versions the stack's publish step (worker
// scripts/publish-once.mjs) signs: the versions list carries a signature badge and its details; Verify
// files with the version's own files says Unchanged; one edited file says Modified and offers Report
// to platform admins; /verify renders its three tabs, and its Folder and skills-lock.json tabs find
// the version by computedHash.
//
// Read-only: the mismatch report POST is answered by a route stub, so no platform admin is notified
// and no audit row is written (a real report notifies every admin, which other specs could see).
// The folders are written under this test's own output directory and handed to the
// `<input webkitdirectory>` with setInputFiles(dir) — Playwright uploads a directory with
// `webkitRelativePath`s, exactly like a user picking the folder.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, devSignIn, type Page } from "./fixtures";
import { awaitApi, clickAndAwait, gotoLoaded, gotoReady, NAV_TIMEOUT } from "./helpers/ready";

const NS = "global";
const SLUG = "pdf-tools";
const SEMVER = "1.1.0";
const SKILL = `/skills/${NS}/${SLUG}`;
const DETAIL = new RegExp(`/api/skills/${NS}/${SLUG}$`);
const STATEMENT = `/api/skills/${NS}/${SLUG}/versions/${SEMVER}/statement`;
// An attribute selector needs no CSS escaping for the dots in the semver.
const versionRow = (page: Page) => page.locator(`[id="version-${SEMVER}"]`);

interface SignedFile { path: string; sha256: string; installed: boolean }

/**
 * The version's signed statement (polled: the stack signs seeded versions before the suite starts,
 * but a slow sweep must not read as a product bug), its installed files and its computedHash — plus
 * the SKILL.md bytes, so the spec can rebuild the exact folder skilly served.
 */
async function signedVersion(page: Page): Promise<{ files: SignedFile[]; computedHash: string; skillMd: string }> {
  const got: { body: { statements: { variant: unknown; computedHash: string; envelope: { payload: string } }[] } | null } = { body: null };
  await expect
    .poll(async () => {
      const r = await page.request.get(STATEMENT);
      if (r.ok()) got.body = await r.json();
      return r.status();
    }, { timeout: 60_000, message: `${STATEMENT} never answered 200 — is the e2e stack signing seeded versions (publish-once + a signing key)?` })
    .toBe(200);
  const own = got.body!.statements.find((s) => !s.variant)!;
  const statement = JSON.parse(Buffer.from(own.envelope.payload, "base64").toString("utf8")) as { predicate: { files: SignedFile[] } };
  const files = statement.predicate.files.filter((f) => f.installed);
  const readme = await page.request.get(`/api/skills/${NS}/${SLUG}/readme?semver=${SEMVER}`);
  expect(readme.ok(), await readme.text()).toBeTruthy();
  const skillMd = ((await readme.json()) as { content: string }).content;
  // The seeded bundles hold SKILL.md alone; the folder below is only the served one if that holds.
  expect(files.map((f) => f.path), "the seeded version serves SKILL.md alone").toEqual(["SKILL.md"]);
  expect(createHash("sha256").update(skillMd, "utf8").digest("hex"), "the readme is the signed SKILL.md").toBe(files[0]!.sha256);
  return { files, computedHash: own.computedHash, skillMd };
}

/** A folder named after the skill holding `skillMd`, under this test's own output directory. */
function writeFolder(name: string, skillMd: string): string {
  const dir = test.info().outputPath(name, SLUG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd, "utf8");
  return dir;
}

/** Open Verify files on the version row and wait for the dialog's statement fetch. */
async function openVerify(page: Page): Promise<void> {
  await clickAndAwait(page, () => versionRow(page).getByTestId("version-verify").click(), STATEMENT, { timeout: NAV_TIMEOUT });
  await expect(page.getByTestId("verify-files-dialog")).toBeVisible();
  await expect(page.getByTestId("verify-dropzone")).toBeVisible({ timeout: NAV_TIMEOUT });
}

test.describe("signed versions (§73) on @global/pdf-tools", () => {
  test("the versions list shows a signature badge and the signed statement's details", async ({ page }) => {
    await devSignIn(page);
    const { computedHash } = await signedVersion(page);
    await gotoLoaded(page, SKILL, DETAIL);
    const row = versionRow(page);
    await expect(row.getByTestId("signature-badge")).toHaveText(/^Signed/);
    await row.getByTestId("version-signature-toggle").click();
    const details = row.getByTestId("signature-details");
    await expect(details).toBeVisible();
    await expect(details.getByText(computedHash)).toBeVisible();
    await expect(details.getByTestId("download-statement")).toHaveAttribute("href", `${STATEMENT}?download=1`);
    // The Install card's one line opens the same dialog for the version the card targets.
    await expect(page.getByTestId("install-verify-line")).toHaveText(/Signed · verify after install/);
  });

  test("Verify files: the version's own folder is Unchanged; an edited file is Modified and can be reported", async ({ page }) => {
    await devSignIn(page);
    const { skillMd } = await signedVersion(page);
    await gotoLoaded(page, SKILL, DETAIL);

    // ── The folder skilly served → Unchanged. ──
    await openVerify(page);
    const dialog = page.getByTestId("verify-files-dialog");
    await dialog.getByTestId("verify-folder-input").setInputFiles(writeFolder("same", skillMd));
    const verdict = dialog.getByTestId("verify-verdict");
    await expect(verdict).toHaveText(`Unchanged: v${SEMVER}`, { timeout: NAV_TIMEOUT });
    await expect(verdict).toHaveAttribute("data-overall", "match");
    await expect(dialog.getByTestId("verify-signature")).toBeVisible();
    await expect(dialog.getByTestId("verify-file").filter({ hasText: "SKILL.md" })).toHaveAttribute("data-status", "unchanged");
    await expect(dialog.getByTestId("verify-report-open")).toHaveCount(0);

    // ── One edited file → Modified, and the report carries paths, statuses and hashes only. ──
    await dialog.getByTestId("verify-pick-again").click();
    await dialog.getByTestId("verify-folder-input").setInputFiles(writeFolder("edited", `${skillMd}\nEdited after install.\n`));
    await expect(verdict).toHaveAttribute("data-overall", "changed", { timeout: NAV_TIMEOUT });
    const row = dialog.getByTestId("verify-file").filter({ hasText: "SKILL.md" });
    await expect(row).toHaveAttribute("data-status", "modified");
    await expect(row).toContainText("Modified");

    const sent: { body: { files: Record<string, unknown>[]; note?: string; verdict: string } | null } = { body: null };
    await page.route("**/statement/report", async (route) => {
      sent.body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await dialog.getByTestId("verify-report-open").click();
    await dialog.getByTestId("verify-report-note").fill("e2e: edited on purpose");
    await clickAndAwait(page, () => dialog.getByTestId("verify-report-send").click(), `${STATEMENT}/report`, { method: "POST" });
    await expect(dialog.getByTestId("verify-report-sent")).toBeVisible();
    const body = sent.body!;
    expect(body.verdict).toBe("changed");
    expect(body.note).toBe("e2e: edited on purpose");
    expect(body.files).toEqual([expect.objectContaining({ path: "SKILL.md", status: "modified" })]);
    for (const f of body.files) expect(Object.keys(f).every((k) => k === "path" || k === "status" || k === "sha256")).toBe(true);
  });

  test("/verify: three tabs; the Folder and skills-lock.json tabs find the version by computedHash", async ({ page }) => {
    await devSignIn(page);
    const { skillMd, computedHash } = await signedVersion(page);
    await gotoReady(page, "/verify");
    await expect(page.getByRole("tab")).toHaveText(["Folder", "skills-lock.json", "Offline"]);

    // ── Folder: only the computedHash goes to the lookup; the matched version is then checked. ──
    const lookup = awaitApi(page, "/api/verify/lookup", { method: "POST" });
    await page.getByTestId("verify-folder-input").setInputFiles(writeFolder("lookup", skillMd));
    const res = await lookup;
    expect(res.request().postDataJSON()).toEqual({ hashes: [computedHash] });
    // The seeded 1.0.0 and 1.1.0 hold the same files, so the user may have to pick.
    await expect(page.getByTestId("verify-several").or(page.getByTestId("verify-match"))).toBeVisible();
    const option = page.getByTestId("verify-match-option").filter({ hasText: `${NS}/${SLUG}@${SEMVER}` }).first();
    if (await page.getByTestId("verify-several").isVisible()) await option.click();
    await expect(page.getByTestId("verify-verdict")).toHaveText(/^Unchanged: v\d/, { timeout: NAV_TIMEOUT });

    // ── skills-lock.json: one row per entry; an entry without a hash says so. ──
    await page.getByRole("tab", { name: "skills-lock.json" }).click();
    const lock = { version: 2, skills: { [SLUG]: { sourceUrl: "https://x-access-token:not-sent@example.invalid/x.git", computedHash }, "no-hash": { sourceUrl: "https://example.invalid/y.git" } } };
    await page.getByTestId("verify-lock-text").fill(JSON.stringify(lock));
    const lockLookup = await clickAndAwait(page, () => page.getByTestId("verify-lock-check").click(), "/api/verify/lookup", { method: "POST" });
    expect(lockLookup.request().postDataJSON()).toEqual({ hashes: [computedHash] });
    const rows = page.getByTestId("verify-lock-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(`${NS}/${SLUG}@${SEMVER}`);
    await expect(rows.nth(1)).toContainText("No hash in this lock");

    // ── Offline: the recipe with this instance's registry and the active key. ──
    await page.getByRole("tab", { name: "Offline" }).click();
    await expect(page.getByTestId("verify-offline-tab")).toBeVisible({ timeout: NAV_TIMEOUT });
    await expect(page.getByText(/openssl pkeyutl -verify -pubin -inkey skilly\.pem/)).toBeVisible();
    await expect(page.getByTestId("verify-autocrlf")).toContainText("core.autocrlf");
  });
});
