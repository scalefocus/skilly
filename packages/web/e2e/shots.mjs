// One-off screenshot capture for the user manual. Signs in via the dev credentials
// provider (SKILLY_DEV_AUTH=1), then visits each surface and writes a PNG.
// Run from packages/web: node e2e/shots.mjs
//
// Seeding note for `18-achievements` (the Quick start achievements card, §23): the shot is only
// useful when the signed-in account holds SOME but not ALL badges, so earned and locked tiles
// appear together. A freshly seeded dev account holds just `onboarded`; before capturing, give it
// a few more (install a skill, post a request, rate and watch something, or insert the rows
// directly) or the card will photograph as a near-empty shelf.
import { chromium } from "@playwright/test";
import { APP_VERSION } from "@skilly/shared/version";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = path.resolve(process.cwd(), "../../docs/manual/shots");
fs.mkdirSync(OUT, { recursive: true });

const FREEZE = `*{animation:none!important;transition:none!important;
  backdrop-filter:none!important;-webkit-backdrop-filter:none!important;
  scroll-behavior:auto!important;caret-color:transparent!important}`;

async function prep(page) {
  await page.addStyleTag({ content: FREEZE }).catch(() => {});
  await page.evaluate(() => {
    document.querySelector("nextjs-portal")?.remove();
    document.querySelectorAll("[data-nextjs-toast],[data-nextjs-dialog-overlay]").forEach((e) => e.remove());
    // Reveal animations are CSS keyframes that start at opacity:0; with animation disabled
    // they freeze hidden. Finish any live animations, then force still-invisible content
    // (cards/sections in <main>) to its visible end state.
    document.getAnimations?.().forEach((a) => { try { a.finish(); } catch {} });
    document.querySelectorAll("main *").forEach((el) => {
      const cs = getComputedStyle(el);
      if (parseFloat(cs.opacity) < 0.08) el.style.setProperty("opacity", "1", "important");
      if (cs.transform && cs.transform !== "none") el.style.setProperty("transform", "none", "important");
    });
  }).catch(() => {});
  await page.waitForTimeout(400);
}

// `el` clips the capture to one element instead of the viewport (Playwright scrolls it into view
// first) — used for the Quick start achievements card, which sits well below the profile fold.
async function shot(page, name, { full = false, el = null } = {}) {
  await prep(page);
  const target = el ? page.locator(el).first() : page;
  const opts = { path: path.join(OUT, name + ".png"), animations: "disabled" };
  await (el ? target.screenshot(opts) : target.screenshot({ ...opts, fullPage: full }));
  console.log("shot:", name, el ? `(element ${el})` : full ? "(full)" : "");
}

const log = [];
async function go(page, url, waitSel) {
  try {
    await page.goto(BASE + url, { waitUntil: "networkidle", timeout: 25000 });
  } catch { /* networkidle can hang on polling pages (dev HMR ws); fall through */ }
  if (waitSel) { try { await page.waitForSelector(waitSel, { timeout: 8000 }); } catch {} }
  // Data-loaded gate: the UI renders .skeleton placeholders while its API fetches are in flight
  // (slow on a cold dev-server compile), and networkidle alone doesn't cover that — wait until
  // no skeletons remain so shots never capture the loading state. Best-effort with a cap.
  try { await page.waitForFunction(() => !document.querySelector("main .skeleton"), { timeout: 20000 }); } catch {}
  await page.waitForTimeout(600);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  // 0) Landing page, logged OUT (capture before signing in).
  await go(page, "/");
  await shot(page, "00-landing", { full: true });

  // Dev sign-in via the next-auth credentials callback (no form fields).
  const csrf = await (await ctx.request.get(BASE + "/api/auth/csrf")).json();
  const res = await ctx.request.post(BASE + "/api/auth/callback/dev", {
    form: { csrfToken: csrf.csrfToken, json: "true" },
  });
  console.log("signin status:", res.status());
  // Pre-stamp the What's new marker so the once-per-release update notice (§23) never lands in a screenshot.
  await ctx.request.post(BASE + "/api/me/whats-new-seen", { data: { version: APP_VERSION } }).catch(() => {});
  // Likewise keep the feedback-survey card (§36) out of every screenshot.
  await ctx.request.patch(BASE + "/api/me", { data: { surveysEnabled: false } }).catch(() => {});

  // Clear any installs left over from a prior run of this script (claimed installs are durable
  // and would otherwise pile up as duplicate "PDF Tools" rows on every re-capture). Uninstall is
  // gated behind a window.confirm(), so auto-accept it.
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE + "/installed", { waitUntil: "networkidle" }).catch(() => {});
  for (;;) {
    const btn = page.locator('button:has-text("uninstall")').first();
    if (!(await btn.count())) break;
    await btn.click().catch(() => {});
    // The click disables the button while its DELETE is in flight (can take several seconds on
    // a cold dev-server compile) — wait for THIS element to detach rather than a fixed sleep, so
    // a slow request can't be mistaken for "nothing left to remove".
    await btn.waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  }

  // Mint a real install so "07-installed" shows an actual row instead of the empty state, then
  // claim it exactly like `npx skills add` would: a GET against the git smart-HTTP advertisement
  // is what flips the token to "used" (see worker/src/git/server.ts markInstallUsed).
  const installRes = await ctx.request.post(BASE + "/api/skills/global/pdf-tools/install", { data: {} });
  console.log("install mint status:", installRes.status());
  // A failed mint (401/404 against a DB that has no global/pdf-tools, say) used to throw here and
  // abort the whole run before a single page was captured. It is a nice-to-have for one shot, so
  // degrade to the empty state and carry on.
  const command = installRes.ok() ? (await installRes.json().catch(() => ({})))?.command : null;
  const m = typeof command === "string" ? command.match(/^npx skills add (\S+)/) : null;
  if (!m) console.log("install mint unusable — 07-installed will show the empty state");
  if (m) {
    const gitUrl = new URL(m[1]);
    const auth = Buffer.from(`${decodeURIComponent(gitUrl.username)}:${decodeURIComponent(gitUrl.password)}`).toString("base64");
    gitUrl.username = ""; gitUrl.password = ""; gitUrl.hash = "";
    const claimRes = await ctx.request.get(gitUrl.toString().replace(/\.git$/, ".git/info/refs?service=git-upload-pack"), {
      headers: { Authorization: `Basic ${auth}` },
    });
    console.log("install claim status:", claimRes.status());
  }

  const steps = [
    ["/catalog", "01-catalog-cards", "main", false],
    ["/catalog", "02-catalog-list", "main", false],   // toggled below
    ["/skills/global/pdf-tools", "03-skill-detail", "main", false],
    ["/propose", "04-propose-pointer", "main", false],
    ["/propose", "05-propose-hosted", "main", false],  // tab switched below
    ["/proposals", "06-review-queue", "main", false],
    ["/installed", "07-installed", "main", false],
    ["/usage", "08-usage", "main", false],
    ["/notifications", "09-notifications", "main", false],
    ["/audit", "10-audit", "main", false],
    ["/system-log", "11-system-log", "main", false],
    ["/admin", "12-admin", "main", false],
    ["/profile", "13-profile", "main", false],
    ["/whats-new", "14-whats-new", "main", false],
    ["/leaderboard", "15-leaderboard", "main", false],
    ["/catalog/marketplaces", "16-marketplaces", "main", false],
    ["/mcp", "17-mcp", "main", false],
    // Quick start's achievements card (§23): the Achievements section on the profile page, framed
    // so EARNED and LOCKED tiles are visible together — the locked how-to-earn hints are the whole
    // point of the nudge, so a capture of an empty (or a full) shelf would miss it. The capture
    // account must already hold several badges; see the seeding note in the header of this file.
    ["/profile", "18-achievements", '[data-testid="achievements-card"]', false, '[data-testid="achievements-card"]'],
  ];

  for (const [url, name, wait, full, el] of steps) {
    await go(page, url, wait);

    // Special interactions per page.
    if (name === "02-catalog-list") {
      for (const sel of ['button:has-text("List")', '[aria-label="List"]', 'button[title*="List"]']) {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click().catch(() => {}); break; }
      }
      await page.waitForTimeout(500);
    }
    // The sticky topbar floats above the page and paints over whatever an element-clipped shot
    // has scrolled under it — here, the card's progress line and its Share row. Drop it for this
    // capture only; the shot is of the card, not the chrome.
    if (name === "18-achievements") {
      // Hide, don't remove: the topbar is fixed, so hiding it reflows nothing and the clipped
      // element stays still. Removing it (and its spacer) reflowed the page enough that
      // locator.screenshot() never saw a stable box and timed out.
      await page.addStyleTag({ content: "header.topbar{visibility:hidden!important}" }).catch(() => {});
      await page.waitForTimeout(300);
    }
    if (name === "05-propose-hosted") {
      for (const sel of ['button:has-text("Hosted upload")', 'button:has-text("Hosted")', '[role="tab"]:has-text("Hosted")']) {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click().catch(() => {}); break; }
      }
      await page.waitForTimeout(500);
    }

    try { await shot(page, name, { full, el }); log.push(name + " OK"); }
    catch (e) { log.push(name + " FAIL " + e.message); }
  }

  // Sync the curated subset used by the in-app Quick start page (served from web/public, since
  // Next only serves images from there). Keep this map in step with app/quick-start/content.ts.
  const QUICKSTART = {
    "01-catalog-cards": "find",
    "03-skill-detail": "skill-detail",
    "07-installed": "installed",
    "09-notifications": "notifications",
    "05-propose-hosted": "propose",
    "16-marketplaces": "connect",
    "18-achievements": "achievements",
  };
  const PUB = path.resolve(process.cwd(), "public/quickstart");
  fs.mkdirSync(PUB, { recursive: true });
  for (const [src, dest] of Object.entries(QUICKSTART)) {
    const from = path.join(OUT, src + ".png");
    if (fs.existsSync(from)) { fs.copyFileSync(from, path.join(PUB, dest + ".png")); console.log("quickstart:", dest); }
  }

  console.log("DONE\n" + log.join("\n"));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
