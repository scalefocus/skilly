// e2e: search gaps (SKILLY_SPEC.md §62). With collection on, a nonsense search submitted with Enter
// in the header box is recorded as a hit (a hash, no user id); a live-filter keystroke on the catalog
// is not. The dev-server suite runs no worker, so the sweep's result — a gap for that query — is
// seeded straight into the database (DATABASE_URL in the launching shell; skipped otherwise). The
// gap then shows on /admin/search-gaps, Create request… posts a Platform request, and the request
// page reads "Requested by Platform".
//
// EXCLUSIVE (groups.ts): it flips the platform-wide collection switch and posts an org-visible
// request. The switch is turned back off at the end.
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { test, expect, devSignIn } from "./fixtures";
import { NAV_TIMEOUT, clickAndAwait, gotoLoaded, gotoReady } from "./helpers/ready";

const dbUrl = process.env.DATABASE_URL;

test.describe.configure({ mode: "serial" });

test("search gaps: an explicit search is recorded, a seeded gap becomes a Platform request", async ({ page }) => {
  test.skip(!dbUrl, "DATABASE_URL not set — cannot seed the worker's result");
  const pool = new Pool({ connectionString: dbUrl });
  const word = `zqx${Date.now().toString(36)}`;
  const hash = createHash("sha256").update(word, "utf8").digest();
  let requestId: string | null = null;
  try {
    await devSignIn(page);
    const on = await page.request.patch("/api/admin/settings", { data: { searchGapsEnabled: true, searchGapsMinSearchers: 1 } });
    expect(on.ok()).toBeTruthy();

    // ── Recording: Enter in the header box is explicit; the catalog then drops `gap=1` from the URL ──
    await gotoReady(page, "/");
    // The header <form> carries role=combobox; the editable element is the textbox inside it.
    const box = page.getByRole("textbox", { name: "Search skills" });
    await box.fill(word);
    await clickAndAwait(page, () => box.press("Enter"), /\/api\/skills\?.*gap=1/);
    await expect(page).toHaveURL(new RegExp(`/catalog\\?q=${word}$`));
    await expect.poll(async () => (await pool.query(`select count(*)::int as n from search_gap_hits where query_norm = $1`, [word])).rows[0].n).toBe(1);
    const cols = (await pool.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'search_gap_hits'`)).rows.map((r) => r.column_name);
    expect(cols).not.toContain("user_id");

    // ── Seed what the sweep would write: one gap with a request draft ──
    await pool.query(`delete from search_gaps where query_norm = $1`, [word]);
    await pool.query(
      `insert into search_gaps (query_norm, query_hash, mode, surfaces, hits, searchers, first_day, last_day, state, ai_kind, ai_draft, ai_model)
       values ($1, $2, 'none', '{web}', 1, 1, current_date, current_date, 'suggested', 'request', $3::jsonb, 'stub-model')`,
      [word, hash, JSON.stringify({ kind: "request", title: `Do ${word} things`, description: `A skill that does ${word} things.`, usage: "Ask for it.", categories: [], tool: null, rationale: "Nothing matches." })],
    );

    // ── Review it on /admin/search-gaps ──
    await gotoLoaded(page, "/admin/search-gaps", "/api/admin/search-gaps?tab=review");
    const card = page.getByTestId("search-gap").filter({ hasText: word });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("search-gap-draft")).toHaveAttribute("data-kind", "request");
    await card.getByTestId("search-gap-request").click();
    const dialog = page.getByRole("dialog", { name: "Create a skill request" });
    await expect(dialog.getByTestId("search-gap-title")).toHaveValue(`Do ${word} things`);
    // The first click runs the §26 similar-check; when that warns, the second click posts anyway.
    // Race the POST against the warning instead of peeking at it once: on a slow agent the warning
    // lands after an immediate isVisible() has already answered no, and the POST never happens.
    const posted = page.waitForResponse(
      (r) => /\/api\/admin\/search-gaps\/[^/]+\/request$/.test(r.url()) && r.request().method() === "POST",
      { timeout: NAV_TIMEOUT },
    );
    const similar = dialog.getByTestId("search-gap-similar");
    await dialog.getByTestId("search-gap-dialog-submit").click();
    const first = await Promise.race([
      posted.then(() => "posted" as const),
      similar.waitFor({ state: "visible", timeout: NAV_TIMEOUT }).then(() => "similar" as const, () => "gone" as const),
    ]);
    if (first === "similar") await dialog.getByTestId("search-gap-dialog-submit").click();
    const res = await posted;
    expect(res.ok()).toBeTruthy();
    // The id comes from the row the POST settled, not from the response body: on the Jenkins agent
    // `res.json()` hung until the test timeout on both attempts (Chromium never reported the body of
    // this response as finished) while the page had long closed the dialog. The handler commits
    // before it answers, so the row is final once `posted` resolves.
    requestId = (await pool.query<{ id: string | null }>(`select outcome_request_id as id from search_gaps where query_norm = $1`, [word])).rows[0]?.id ?? null;
    expect(requestId).toBeTruthy();
    await expect(dialog).toHaveCount(0);

    // ── The request is posted by Platform ──
    await gotoLoaded(page, `/requests/${requestId}`, `/api/requests/${requestId}`);
    await expect(page.getByTestId("request-requester")).toHaveText("Requested by Platform");
    await expect(page.getByTestId("platform-requester-mark")).toBeVisible();

    // The query is tombstoned: searching it again records nothing.
    expect((await pool.query(`select count(*)::int as n from search_gap_tombstones where query_hash = $1`, [hash])).rows[0].n).toBe(1);
  } finally {
    await page.request.patch("/api/admin/settings", { data: { searchGapsEnabled: false, searchGapsMinSearchers: 2 } }).catch(() => {});
    await pool.query(`delete from search_gaps where query_norm = $1`, [word]);
    await pool.query(`delete from search_gap_hits where query_norm = $1`, [word]);
    await pool.query(`delete from search_gap_daily where query_norm = $1`, [word]);
    await pool.query(`delete from search_gap_tombstones where query_hash = $1`, [hash]);
    if (requestId) await pool.query(`delete from skill_requests where id = $1`, [requestId]);
    await pool.end();
  }
});
