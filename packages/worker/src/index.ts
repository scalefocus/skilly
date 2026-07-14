// skilly worker — singleton process hosting SCIM 2.0 endpoints, Entra reconciliation,
// and the scan pipeline runner. SKILLY_SPEC.md §2, §5, §6.
//
// Singleton via a Postgres advisory lock (leader election) so multiple replicas are
// safe: only the leader runs reconciliation / scans. SCIM HTTP endpoints can serve
// from any replica (they're idempotent writes), but background loops are leader-only.
import express from "express";
import { Pool, type PoolClient } from "pg";
import { scimRouter } from "./scim/router.js";
import { pgStore } from "./scim/store.js";
import { gitServer } from "./git/server.js";
import { workerRateLimiter } from "./rateLimit.js";
import { pgGitDeps } from "./git/pgDeps.js";
import { publishPendingVersions, reprovisionMissingRepos } from "./git/publish.js";
import { withdrawYankedVersions } from "./git/withdraw.js";
import { mirrorPendingVersions } from "./git/mirrorPending.js";
import { s3ArtifactStore } from "./storage/objectStore.js";
import { defaultRepoRoot } from "./git/repoStore.js";
import { sweepExpiredTokens } from "./tokens.js";
import { reconcile } from "./reconcile/reconcile.js";
import { graphClient } from "./reconcile/graph.js";
import { deliverPendingNotifications } from "./notify/deliver.js";
import { channelsFromEnv } from "./notify/channels.js";
import { resolveGraphTransport } from "./notify/graphChannel.js";
import { notifyNewSystemEvents } from "./notify/systemLog.js";
import { refreshPointerVersions } from "./git/pointerRefresh.js";
import { recomputeRelatedSkills } from "./related.js";
import { recordDailyActiveUsers } from "./dau.js";
import { preScanPointerProposals } from "./git/proposalPreScan.js";
import { backfillContentDigests } from "./git/contentBackfill.js";
import { metrics, METRICS_CONTENT_TYPE, constantTimeEqual } from "@skilly/shared";
import { M } from "./metrics.js";

const PORT = Number(process.env.WORKER_PORT ?? 4000);
const LEADER_LOCK_KEY = 855399; // arbitrary stable advisory-lock key ("skilly")
const LEADER_POLL_MS = Number(process.env.LEADER_POLL_MS ?? 30000);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 30_000),
});

// Leadership is held on a DEDICATED long-lived connection. A session-scoped advisory lock is
// released automatically if that connection drops, so holding it on a pooled (reapable)
// connection would silently lose leadership. We also re-attempt periodically so a standby
// promotes itself when the current leader dies. SKILLY_SPEC.md §14 (HA, leader-locked worker).
let isLeader = false;
let leaderClient: PoolClient | null = null;
let loopsStarted = false;

async function attemptLeadership(): Promise<void> {
  if (isLeader) return;
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    const { rows } = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [LEADER_LOCK_KEY]);
    if (rows[0]?.locked !== true) {
      client.release(); // another replica leads — return the connection to the pool
      return;
    }
    isLeader = true;
    leaderClient = client;
    M.leader.set(1);
    // If the dedicated connection errors/drops, the advisory lock is released by Postgres —
    // step down so the sweeps pause and the next poll (here or on a standby) re-acquires.
    client.on("error", (err) => {
      console.error(JSON.stringify({ level: "warn", msg: "leader connection lost; stepping down", err: String(err) }));
      isLeader = false;
      leaderClient = null;
      M.leader.set(0);
    });
    console.log(JSON.stringify({ level: "info", msg: "became leader" }));
    if (!loopsStarted) {
      loopsStarted = true; // register the interval loops exactly once; each sweep is gated on isLeader
      await leaderLoops();
    }
  } catch (err) {
    if (client) client.release();
    console.error(JSON.stringify({ level: "error", msg: "leadership attempt failed", err: String(err) }));
  }
}

async function leaderLoops(): Promise<void> {
  console.log(JSON.stringify({ level: "info", msg: "leader loops started" }));

  // Sweep: (1) mirror pending pointer skills (clone+scan+store), then (2) synthesize git
  // repos/tags for any version not yet published. Order matters — mirror creates versions.
  const store = s3ArtifactStore();
  const publishDeps = { store, repoRoot: defaultRepoRoot() };
  const sweep = async () => {
    if (!isLeader) return;
    try {
      const m = await mirrorPendingVersions(pool, { store });
      if (m > 0) { M.pointersMirrored.add(m); console.log(JSON.stringify({ level: "info", msg: "mirrored pointer versions", count: m })); }
      const n = await publishPendingVersions(pool, publishDeps);
      if (n > 0) { M.versionsPublished.add(n); console.log(JSON.stringify({ level: "info", msg: "published versions", count: n })); }
      // Self-heal repos flagged published but missing on disk (e.g. recreated git volume).
      const h = await reprovisionMissingRepos(pool, publishDeps);
      if (h > 0) console.log(JSON.stringify({ level: "warn", msg: "self-healed missing repos", count: h }));
      // Reflect yanks at the git layer: drop tags for yanked versions so they stop cloning.
      const w = await withdrawYankedVersions(pool, publishDeps.repoRoot);
      if (w > 0) console.log(JSON.stringify({ level: "info", msg: "withdrew yanked versions", count: w }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "publish sweep failed", err: String(err) }));
    }
  };
  await sweep();
  setInterval(sweep, Number(process.env.PUBLISH_SWEEP_INTERVAL_MS ?? 60000));

  // Token reaper: delete expired one-time/PAT tokens.
  const reap = async () => {
    if (!isLeader) return;
    try {
      const n = await sweepExpiredTokens(pool);
      if (n > 0) console.log(JSON.stringify({ level: "info", msg: "reaped expired tokens", count: n }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "token reap failed", err: String(err) }));
    }
  };
  await reap();
  setInterval(reap, Number(process.env.TOKEN_SWEEP_INTERVAL_MS ?? 60000));

  // System-log retention (SKILLY_SPEC.md §25): system_event is high-volume operational telemetry
  // (every recorded 5XX/403/422/…), so trim to the last 90 days. Error telemetry has a short
  // useful life; a long interval is plenty.
  const purgeSystemLog = async () => {
    if (!isLeader) return;
    try {
      const { rowCount } = await pool.query(
        `delete from system_event where created_at < now() - $1::interval`,
        [process.env.SYSTEM_LOG_RETENTION ?? "90 days"],
      );
      if (rowCount && rowCount > 0) console.log(JSON.stringify({ level: "info", msg: "purged old system events", count: rowCount }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "system log purge failed", err: String(err) }));
    }
  };
  await purgeSystemLog();
  setInterval(purgeSystemLog, Number(process.env.SYSTEM_LOG_PURGE_INTERVAL_MS ?? 21_600_000)); // 6h

  // Notification delivery: fan undelivered notifications out over email (Graph service
  // account preferred, env SMTP fallback) + webhook (if configured); in-app only otherwise.
  // Marks each delivered exactly once. Resolving the Graph transport every sweep is also the
  // §12 keep-alive: the token refreshes on this cadence even when nothing is pending, so the
  // admin pill stays current and the rotating refresh token never lapses from inactivity.
  const envChannels = channelsFromEnv();
  const externalCount = Number(Boolean(envChannels.email)) + Number(Boolean(envChannels.webhook));
  console.log(JSON.stringify({ level: "info", msg: "notification channels", external: externalCount }));
  let lastEmailKind: string | null = null;
  let notifyPausedUntil = 0; // Graph 429 Retry-After honor (§12): sweeps skip until this instant
  const deliver = async () => {
    if (!isLeader) return;
    // While throttled, nothing is marked delivered, so no email is skipped or burst-sent later —
    // the queue simply resumes where it left off once the Retry-After window passes.
    if (Date.now() < notifyPausedUntil) return;
    try {
      // Never let Graph transport resolution kill the sweep: on ANY unexpected failure the
      // channel degrades to SMTP/in-app exactly like a non-operational account (§12).
      let graph;
      try {
        graph = await resolveGraphTransport(pool);
      } catch (err) {
        console.error(JSON.stringify({ level: "warn", msg: "graph transport resolution failed", err: String(err) }));
        graph = undefined;
      }
      const channels = { email: graph ?? envChannels.email, webhook: envChannels.webhook };
      const kind = channels.email?.kind ?? "none";
      if (kind !== lastEmailKind) {
        console.log(JSON.stringify({ level: "info", msg: "email transport", kind }));
        lastEmailKind = kind;
      }
      const r = await deliverPendingNotifications(pool, channels);
      if (r.retryAfterSeconds) {
        notifyPausedUntil = Date.now() + r.retryAfterSeconds * 1000;
        console.log(JSON.stringify({ level: "warn", msg: "graph throttled; pausing notification delivery", seconds: r.retryAfterSeconds }));
      }
      if (r.delivered > 0) M.notificationsDelivered.add(r.delivered);
      if (r.failed > 0) M.notificationsFailed.add(r.failed);
      if (r.delivered > 0 || r.failed > 0) console.log(JSON.stringify({ level: "info", msg: "notifications delivered", ...r }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "notification delivery failed", err: String(err) }));
    }
  };
  await deliver();
  setInterval(deliver, Number(process.env.NOTIFY_SWEEP_INTERVAL_MS ?? 30000));

  // System-log alerts: coalesced bell notification to platform admins when new error events
  // appear in the System log (§25). In-app only; watermark-tracked so events aren't double-counted.
  const alertSystemLog = async () => {
    if (!isLeader) return;
    try {
      const admins = await notifyNewSystemEvents(pool);
      if (admins > 0) console.log(JSON.stringify({ level: "info", msg: "system-log alert sent", admins }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "system-log alert failed", err: String(err) }));
    }
  };
  await alertSystemLog();
  setInterval(alertSystemLog, Number(process.env.SYSTEM_LOG_ALERT_INTERVAL_MS ?? 60000));

  // Entra reconciliation: pull Graph membership for mapped groups and correct drift.
  // Only runs when Graph app credentials are configured.
  if (process.env.ENTRA_CLIENT_ID && process.env.ENTRA_CLIENT_SECRET && process.env.ENTRA_TENANT_ID) {
    const graph = graphClient();
    const scimStore = pgStore(pool);
    const reconcileSweep = async () => {
      if (!isLeader) return;
      try {
        const stats = await reconcile(graph, scimStore);
        M.reconcile.inc();
        console.log(JSON.stringify({ level: "info", msg: "entra reconcile", ...stats }));
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "reconcile failed", err: String(err) }));
      }
    };
    await reconcileSweep();
    setInterval(reconcileSweep, Number(process.env.RECONCILE_INTERVAL_MS ?? 900000)); // 15 min
  } else {
    console.log(JSON.stringify({ level: "info", msg: "entra reconcile disabled (no Graph credentials)" }));
  }

  // Pointer refresh: periodically re-clone + re-scan mirrored pointer refs to refresh scan
  // findings and detect upstream drift on supposedly-immutable pinned refs. Long interval.
  const refresh = async () => {
    if (!isLeader) return;
    try {
      const r = await refreshPointerVersions(pool, store);
      if (r.checked > 0) M.pointerRefreshChecked.add(r.checked);
      if (r.drift > 0) M.pointerDrift.add(r.drift);
      if (r.checked > 0) console.log(JSON.stringify({ level: "info", msg: "pointer refresh", ...r }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "pointer refresh failed", err: String(err) }));
    }
  };
  await refresh();
  setInterval(refresh, Number(process.env.POINTER_REFRESH_INTERVAL_MS ?? 86_400_000)); // 24h

  // Pointer proposal pre-scan: clone + scan open pointer proposals' pinned refs so reviewers see
  // findings BEFORE accepting (hosted proposals get this at upload). Short interval so a freshly
  // submitted pointer proposal is scanned promptly.
  const preScan = async () => {
    if (!isLeader) return;
    try {
      const n = await preScanPointerProposals(pool);
      if (n > 0) console.log(JSON.stringify({ level: "info", msg: "pre-scanned pointer proposals", count: n }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "proposal pre-scan failed", err: String(err) }));
    }
  };
  await preScan();
  setInterval(preScan, Number(process.env.PROPOSAL_PRESCAN_INTERVAL_MS ?? 60_000)); // 1 min

  // Content-digest backfill (§8): fill content_sha256 for versions created before the column
  // existed so duplicate detection can match them. Self-limiting — does nothing once drained;
  // runs on a long interval so it eventually catches anything missed (e.g. a transient S3 error).
  const backfill = async () => {
    if (!isLeader) return;
    try {
      const n = await backfillContentDigests(pool, store);
      if (n > 0) console.log(JSON.stringify({ level: "info", msg: "backfilled content digests", count: n }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "content backfill failed", err: String(err) }));
    }
  };
  await backfill();
  setInterval(backfill, Number(process.env.CONTENT_BACKFILL_INTERVAL_MS ?? 3_600_000)); // 1h

  // "Skills you might like" (§10): nightly rebuild of per-skill co-install neighbours from
  // skill_installs. Derived/advisory, rebuilt wholesale each run; long (daily) interval.
  const relatedSweep = async () => {
    if (!isLeader) return;
    try {
      const n = await recomputeRelatedSkills(pool);
      console.log(JSON.stringify({ level: "info", msg: "recomputed related skills", rows: n }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "related-skills recompute failed", err: String(err) }));
    }
  };
  await relatedSweep();
  setInterval(relatedSweep, Number(process.env.RELATED_SKILLS_INTERVAL_MS ?? 86_400_000)); // 24h

  // On-demand rebuild (§10): a platform admin can request a "Skills you might like" rebuild from the
  // Administration page. The web tier records platform_settings.related_rebuild_requested_at; we pick
  // it up here (leader-only) on a short poll, run the same recompute, then clear the request. The
  // recompute's advisory lock serializes it with the nightly run; a -1 means one was already running,
  // so we leave the request set and retry on the next tick.
  const relatedSignal = async () => {
    if (!isLeader) return;
    try {
      const { rows } = await pool.query<{ requested: boolean }>(
        `select exists (select 1 from platform_settings
                         where key = 'related_rebuild_requested_at' and value <> 'null'::jsonb) as requested`,
      );
      if (!rows[0]?.requested) return;
      const n = await recomputeRelatedSkills(pool);
      if (n < 0) return; // a rebuild is already running — retry next tick
      await pool.query(`update platform_settings set value = 'null'::jsonb, updated_at = now() where key = 'related_rebuild_requested_at'`);
      console.log(JSON.stringify({ level: "info", msg: "on-demand related-skills rebuild", rows: n }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "on-demand related rebuild failed", err: String(err) }));
    }
  };
  await relatedSignal();
  setInterval(relatedSignal, Number(process.env.RELATED_REBUILD_POLL_MS ?? 15_000)); // 15s

  // Daily active-user snapshot (§4): once a day, upsert today's active-user count into
  // daily_active_users for the Administration trend chart. Idempotent (upsert on date) — a
  // restart or a slightly-late run the same day never double-counts.
  const dauSweep = async () => {
    if (!isLeader) return;
    try {
      const count = await recordDailyActiveUsers(pool);
      console.log(JSON.stringify({ level: "info", msg: "recorded daily active users", count }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "daily active-user snapshot failed", err: String(err) }));
    }
  };
  await dauSweep();
  setInterval(dauSweep, Number(process.env.DAU_SNAPSHOT_INTERVAL_MS ?? 86_400_000)); // 24h
}

/**
 * Express `trust proxy` value from TRUST_PROXY, so `req.ip` resolves the real client from
 * X-Forwarded-For behind a reverse proxy (used to record an install's originating IP — §9/§23).
 * Accepts a hop count ("1"), boolean ("true"/"false"), a preset ("loopback"), or a comma-separated
 * subnet list — passed to Express verbatim. Unset = don't trust (records the socket peer / null).
 */
function trustProxySetting(): boolean | number | string {
  const v = process.env.TRUST_PROXY?.trim();
  if (!v) return false;
  if (v === "true") return true;
  if (v === "false") return false;
  return /^\d+$/.test(v) ? Number(v) : v;
}

function buildServer() {
  const app = express();
  app.set("trust proxy", trustProxySetting());

  // Baseline security headers on EVERY worker response (SCIM + git smart-HTTP). These are
  // protocol/JSON responses, not HTML, so there is no CSP — but nosniff / DENY-frame / no-referrer
  // are cheap defense-in-depth so a response can't be MIME-sniffed into active content or framed
  // (SKILLY_SPEC.md §22). Mounted before the git handler: it only sets response headers and never
  // touches the raw request stream the git backend reads.
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  // App-wide rate limit (SKILLY_SPEC.md §22): caps request volume on every worker surface — the
  // git smart server, SCIM, and the /healthz /readyz /metrics endpoints — before any auth or
  // DB-touching handler runs. Mounted here (after the security headers, before the git handler and
  // any body parser) because it only reads req.ip/headers and never touches the raw request stream
  // the git backend consumes.
  app.use(workerRateLimiter());

  // Git smart-HTTP must read the RAW request stream — mount before any body parser.
  // Non-git paths fall through via next(). SKILLY_SPEC.md §9.
  app.use(gitServer(pgGitDeps(pool)));

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/metrics", (req, res) => {
    const required = process.env.METRICS_TOKEN;
    // Fail closed in production when no token is set (audit P1); open only outside production.
    if (!required) {
      if (process.env.NODE_ENV === "production") return res.status(403).type("text/plain").send("metrics disabled (set METRICS_TOKEN)");
    } else if (!constantTimeEqual(req.header("authorization") ?? "", `Bearer ${required}`)) {
      return res.status(401).type("text/plain").send("unauthorized");
    }
    res.type(METRICS_CONTENT_TYPE).send(metrics.render());
  });
  app.get("/readyz", async (_req, res) => {
    try {
      await pool.query("select 1");
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "not-ready" });
    }
  });

  // SCIM 2.0 — Entra Enterprise App provisioning target. JSON-parsed; bearer auth inside.
  // Entra sends SCIM requests as "application/scim+json"; accept both to avoid body
  // going unparsed (req.body undefined) and crashing all PATCH/POST/PUT handlers.
  app.use("/scim/v2", express.json({ limit: "1mb", type: ["application/json", "application/scim+json"] }), scimRouter(pgStore(pool)));

  return app;
}

// Fail fast on missing required secrets in production rather than degrading at first use.
function assertEnv(): void {
  if (process.env.NODE_ENV !== "production") return;
  const required = ["DATABASE_URL", "SCIM_BEARER_TOKEN", "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`missing required env: ${missing.join(", ")}`);
}

async function main() {
  assertEnv();
  const app = buildServer();
  app.listen(PORT, () =>
    console.log(JSON.stringify({ level: "info", msg: `worker listening on :${PORT}` })),
  );

  // Attempt leadership now, then poll so a standby promotes itself if the leader dies.
  await attemptLeadership();
  if (!isLeader) console.log(JSON.stringify({ level: "info", msg: "not leader; serving SCIM only (will retry)" }));
  setInterval(() => { void attemptLeadership(); }, LEADER_POLL_MS);
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", msg: String(err) }));
  process.exit(1);
});
