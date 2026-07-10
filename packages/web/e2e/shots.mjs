// One-off screenshot capture for the user manual. Signs in via the dev credentials
// provider (SKILLY_DEV_AUTH=1), then visits each surface and writes a PNG.
// Run from packages/web: node e2e/shots.mjs
import { chromium } from "@playwright/test";
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

async function shot(page, name, { full = false } = {}) {
  await prep(page);
  await page.screenshot({ path: path.join(OUT, name + ".png"), animations: "disabled", fullPage: full });
  console.log("shot:", name, full ? "(full)" : "");
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
  const { command } = await installRes.json();
  const m = command.match(/^npx skills add (\S+)/);
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
  ];

  for (const [url, name, wait, full] of steps) {
    await go(page, url, wait);

    // Special interactions per page.
    if (name === "02-catalog-list") {
      for (const sel of ['button:has-text("List")', '[aria-label="List"]', 'button[title*="List"]']) {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click().catch(() => {}); break; }
      }
      await page.waitForTimeout(500);
    }
    if (name === "05-propose-hosted") {
      for (const sel of ['button:has-text("Hosted upload")', 'button:has-text("Hosted")', '[role="tab"]:has-text("Hosted")']) {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click().catch(() => {}); break; }
      }
      await page.waitForTimeout(500);
    }

    try { await shot(page, name, { full }); log.push(name + " OK"); }
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
