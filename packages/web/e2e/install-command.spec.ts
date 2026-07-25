// e2e: the consumer install path (SKILLY_SPEC.md §9, §23). Minting an install produces a
// copy-paste `npx skills add <git-url>` command whose URL embeds the skill-scoped install token as
// git basic-auth — the ONLY wire format skilly serves (external-tool.ts). We assert the minted
// command against the seeded, git-published `global/web-scraper` skill, and that the Installed
// skills page lists the seeded installs with a revoke control.
//
// NOTE (documented boundary): a fresh mint's token is `used_at = null` and only flips to "used"
// when the git gateway actually clones it — which needs the worker + git smart server, out of
// scope here. So this spec asserts the mint command + the (seeded) Installed list read-only; it
// does not click uninstall (that would mutate the seed) nor drive a real clone. The one token it
// mints is never surfaced and is harmless in the ephemeral CI DB.
import { test, expect, devSignIn } from "./fixtures";

test.describe("install command + installed list (§9, §23)", () => {
  test("minting global/web-scraper yields an authenticated npx skills add command", async ({ page }) => {
    await devSignIn(page);

    // Mint via the API (deterministic — the UI mint depends on the expiry-picker state). An omitted
    // /explicit-null expiry means "Never", which is an allowed install TTL (§23).
    const res = await page.request.post("/api/skills/global/web-scraper/install", { data: { expiresAt: null } });
    expect(res.ok(), await res.text()).toBeTruthy();
    const body = await res.json();

    // Wire format: <scheme>://x-access-token:<token>@<host>/global/web-scraper.git — the scheme
    // follows SKILLY_REGISTRY_URL (https in prod; http on a local/CI dev server). A "latest" mint
    // carries no #ref and reports semver:null.
    expect(body.command).toMatch(/^npx skills add https?:\/\/x-access-token:[^@]+@.+\/global\/web-scraper\.git/);
    expect(body.command).not.toContain("x-access-token:@"); // the token is actually embedded
    expect(body.expiresAt).toBeNull(); // omitted/null expiry ⇒ never expires (§23)

    // The detail page surfaces the Install affordance (proves the skill is installable in the UI).
    await page.goto("/skills/global/web-scraper");
    // exact — the page also has an "Installs & views" heading that a substring match would catch.
    await expect(page.getByRole("heading", { name: "Install", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Install latest" })).toBeVisible();
  });

  test("Installed skills lists the seeded installs with a revoke control", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/installed");
    await expect(page.getByRole("heading", { name: "Installed skills." })).toBeVisible({ timeout: 20_000 });
    // The dev user is seeded with used installs (pdf-tools, lint-fixer, secret-helper), so at least
    // one active row exposes an `uninstall` control. Read-only — we do not click it.
    await expect(page.getByRole("button", { name: "uninstall" }).first()).toBeVisible();
    await expect(page.getByText("PDF Tools").first()).toBeVisible();
  });
});
