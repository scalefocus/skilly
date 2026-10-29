// e2e: Import a whole repository (SKILLY_SPEC.md §64.12). The git-facing endpoints — the ref
// pre-check, the scan and the submit — and the AI draft endpoint are answered by Playwright route
// stubs, so the spec covers the page and the wizard without reaching any git host or AI provider;
// the server side is covered by repoImport.dbtest.ts. Write-free: nothing reaches the database.
//
// Covers: scan → tick three → Next opens the wizard; Submit appears only on the last step and only
// once every step is opened; a failing step blocks Next; Remove from proposal unticks the row on
// the page; the result view shows a failed skill and Fix and resubmit reopens only that step. With
// Draft with AI on, a step is filled from the draft and Undo restores the SKILL.md values.
import { authedTest as test, expect, type Page } from "./fixtures";
import { gotoLoaded, clickAndAwait } from "./helpers/ready";

const URL_ = "https://git.example.test/acme/skills.git";
const row = (path: string, name: string | null, extra: Record<string, unknown> = {}) => ({
  path,
  subdir: path.replace(/\/?SKILL\.md$/, "") || null,
  name,
  description: name ? `${name} from SKILL.md` : null,
  lastChangedAt: "2026-10-01T10:00:00Z",
  lastChangedBefore: null,
  importable: true,
  frontmatter: { usageExamples: null, category: null, version: null },
  ...extra,
});
const SCAN = {
  commit: "a".repeat(40),
  total: 4,
  shown: 4,
  historyCommits: 12,
  historyComplete: true,
  skills: [
    row("skills/docx/SKILL.md", "e2e-imp-docx"),
    row("skills/noname/SKILL.md", null, { importable: false, reason: "no_name" }),
    row("skills/pdf/SKILL.md", "e2e-imp-pdf"),
    row("skills/xlsx/SKILL.md", "e2e-imp-xlsx"),
  ],
};

async function stubSources(page: Page, opts: { ai?: boolean } = {}) {
  await page.route("**/api/pointer/refs?**", (r) => r.fulfill({ json: { ok: true, branches: ["main"], tags: [] } }));
  await page.route("**/api/propose/import/scan", (r) => r.fulfill({ json: SCAN }));
  await page.route("**/api/propose/import", (r) =>
    r.fulfill({
      json: {
        importId: "00000000-0000-4000-8000-000000000001",
        commit: SCAN.commit,
        results: [
          { subdir: "skills/docx", slug: "e2e-imp-docx", outcome: "proposed", proposalId: "00000000-0000-4000-8000-000000000002" },
          { subdir: "skills/xlsx", slug: "e2e-imp-xlsx", outcome: "failed", error: "slug taken a minute ago", code: "slug_exists" },
        ],
      },
    }),
  );
  await page.route("**/api/propose/ai-draft", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ json: { available: !!opts.ai, remainingToday: 38 } })
      : r.fulfill({ json: { description: "Drafted description.", usage: "Ask it to read a PDF.", categories: [{ name: "documents", isNew: false }] } }),
  );
}

async function scanAndTick(page: Page, paths: string[]) {
  await gotoLoaded(page, "/propose/import", "/api/namespaces");
  await page.getByTestId("import-url").fill(URL_);
  await clickAndAwait(page, () => page.getByTestId("import-scan").click(), "/api/propose/import/scan", { method: "POST" });
  for (const p of paths) await page.getByTestId(`import-row-${p}`).getByRole("checkbox").check();
}

test("pick, review every step, remove one, submit, fix and resubmit the failed one", async ({ page }) => {
  await stubSources(page);
  await scanAndTick(page, ["skills/docx/SKILL.md", "skills/pdf/SKILL.md", "skills/xlsx/SKILL.md"]);
  await expect(page.getByTestId("import-row-skills/noname/SKILL.md").getByRole("checkbox")).toBeDisabled();
  await expect(page.getByText("Can't import: SKILL.md has no name")).toBeVisible();

  await page.getByTestId("import-next").click();
  const wizard = page.getByTestId("import-wizard");
  await expect(wizard.getByText("Skill 1 of 3 · skills/docx")).toBeVisible();
  await expect(wizard.getByTestId("import-submit")).toHaveCount(0);

  // A failing step blocks Next.
  await wizard.getByTestId("import-step-title").fill("");
  await wizard.getByTestId("import-step-next").click();
  await expect(wizard.getByText("Give the skill a title.")).toBeVisible();
  await expect(wizard.getByText("Skill 1 of 3 · skills/docx")).toBeVisible();
  await wizard.getByTestId("import-step-title").fill("Docx");
  await wizard.getByTestId("import-step-next").click();
  await expect(wizard.getByText("Skill 2 of 3 · skills/pdf")).toBeVisible();

  // Remove from proposal unticks the row on the page underneath and moves on.
  await wizard.getByTestId("import-step-remove").click();
  await expect(wizard.getByText("Skill 2 of 2 · skills/xlsx")).toBeVisible();
  await expect(page.getByTestId("import-row-skills/pdf/SKILL.md").getByRole("checkbox")).not.toBeChecked();

  // Every remaining step has been opened, so the last one can submit.
  await expect(wizard.getByTestId("import-submit")).toBeEnabled();
  await clickAndAwait(page, () => wizard.getByTestId("import-submit").click(), "/api/propose/import", { method: "POST" });
  await expect(wizard.getByTestId("import-result")).toContainText("slug taken a minute ago");
  await expect(wizard.getByTestId("import-result")).toContainText("View the proposal");

  await wizard.getByTestId("import-fix-resubmit").click();
  await expect(wizard.getByText("Skill 1 of 1 · skills/xlsx")).toBeVisible();
  await expect(wizard.getByTestId("import-step-error")).toHaveText("slug taken a minute ago");
});

test("Draft with AI fills each step and Undo restores the SKILL.md values", async ({ page }) => {
  await stubSources(page, { ai: true });
  await scanAndTick(page, ["skills/pdf/SKILL.md"]);
  await expect(page.getByText("Draft with AI (38 drafts left today)")).toBeVisible();
  await page.getByTestId("import-draft-ai").check();
  await clickAndAwait(page, () => page.getByTestId("import-next").click(), "/api/propose/ai-draft", { method: "POST" });
  const wizard = page.getByTestId("import-wizard");
  // The first textarea in a step is Description (Categories is a tag input).
  const description = wizard.locator("textarea").first();
  await expect(description).toHaveValue("Drafted description.");
  await wizard.getByTestId("import-step-undo").click();
  await expect(description).toHaveValue("e2e-imp-pdf from SKILL.md");
});
