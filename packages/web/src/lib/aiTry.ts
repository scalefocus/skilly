// Try a skill before installing (SKILLY_SPEC.md §61): the web half. Resolves the tried version the
// way the Install card does (latest, or any active git-published version), loads its stored
// artifact through the §46 selection with the lower total, enforces the per-minute and rolling-daily
// limits, and sends the validated transcript to the §40 helper with the skill in the system prompt.
// Nothing is persisted except the helper's own ai_usage row; nothing is audited (§61.5). The routes
// only authenticate and parse.
import { randomUUID } from "node:crypto";
import {
  AI_TRY_DAILY_CAP,
  AI_TRY_FEATURE,
  AI_TRY_MAX_TOKENS,
  AI_TRY_PER_MINUTE,
  AI_TRY_WINDOW_MS,
  buildTrySystemPrompt,
  bundleContentCap,
  draftDailyCapDecision,
  isSecretLikeLine,
  isSkillVisible,
  resolveLatest,
  selectTryInput,
  validateTryTranscript,
  type EffectiveAccess,
  type TryContext,
  type TrySelection,
} from "@skilly/shared";
import { AiError, loadAiConfig } from "@skilly/shared/ai";
import { pool } from "./db";
import { aiComplete, aiOperational } from "./ai";
import { extractBundle } from "./bundle";
import { findSkill } from "./catalog";
import { versionContentRiskStatus } from "./contentRisk";
import { s3ArtifactStore } from "./objectStore";
import { getAiTryEnabled, getMaxBundleBytes } from "./settings";
import { rateLimit } from "./ratelimit";
import { M } from "./metrics";

export interface TryOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** I/O seams, so the integration test can stand in for object storage and the clock. */
export interface TryDeps {
  getArtifact?: (key: string) => Promise<Buffer>;
  now?: () => Date;
}

/** Errors the helper raises before reaching the provider: AI went away after the panel opened. */
const UNAVAILABLE_CODES = new Set(["ai_not_configured", "ai_disabled", "ai_key_missing", "ai_token_undecryptable"]);

const UNAVAILABLE = { error: "try_unavailable", message: "Trying skills is no longer available." };
const VERSION_GONE = { error: "version_not_found", message: "This version can no longer be tried." };
const SOURCE_FAILED = { error: "try_source_failed", message: "Couldn’t load this skill’s files. Try again later." };
const FAILED = { error: "try_failed", message: "Couldn’t get a reply. Try again." };

type Metric = "ok" | "failed" | "rate_limited" | "rejected";

function outcome(status: number, body: Record<string, unknown>, metric: Metric | null): TryOutcome {
  if (metric) M.aiTryRequests.inc({ outcome: metric });
  return { status, body };
}

/** §61.2: the switch is on and the integration's status is Operational (Failing hides Try). */
export async function tryEffective(): Promise<boolean> {
  return (await getAiTryEnabled()) && (await aiOperational());
}

/**
 * The detail payload's `tryAvailable` (§61.2): Try follows Install — an active skill with an
 * installable version — and the feature is effective. The caller has already applied visibility.
 */
export async function tryAvailability(skill: { archived: boolean; latestInstallable: string | null }): Promise<boolean> {
  if (skill.archived || skill.latestInstallable == null) return false;
  return tryEffective();
}

type Skill = NonNullable<Awaited<ReturnType<typeof findSkill>>>;

/** The skill, when it exists and the caller can see it (#3); else null → 404, like a missing skill. */
async function visibleSkill(access: EffectiveAccess, ns: string, slug: string): Promise<Skill | null> {
  const skill = await findSkill(ns, slug);
  return skill && isSkillVisible(access, skill) ? skill : null;
}

interface TryVersion {
  semver: string;
  artifactKey: string | null;
  artifactFilename: string | null;
  usage: string | null;
}

/**
 * What the Install picker offers (§61.1 #4): an active, git-published version of an active skill.
 * `semver` null = latest (the highest stable of those). Yanked, quarantined and unpublished
 * versions, and every version of an archived skill, resolve to null.
 */
async function installableVersion(skill: Skill, semver: string | null): Promise<TryVersion | null> {
  if (skill.status === "archived") return null;
  const { rows } = await pool.query<{ semver: string; artifact_object_key: string | null; artifact_filename: string | null; usage_examples: string | null }>(
    `select semver, artifact_object_key, artifact_filename, usage_examples from skill_versions
      where skill_id = $1 and status = 'active' and git_published`,
    [skill.id],
  );
  const target = semver ?? resolveLatest(rows.map((r) => r.semver));
  const r = rows.find((x) => x.semver === target);
  return r ? { semver: r.semver, artifactKey: r.artifact_object_key, artifactFilename: r.artifact_filename, usage: r.usage_examples } : null;
}

/** The §61.4 selection from the version's stored artifact (a pointer's mirror); null when unreadable. */
async function loadSelection(v: TryVersion, deps: TryDeps): Promise<TrySelection | null> {
  if (!v.artifactKey) return null;
  try {
    const bytes = await (deps.getArtifact ?? ((k: string) => s3ArtifactStore().get(k)))(v.artifactKey);
    // The same safe extraction as the other artifact readers (§6 guards); it works in a temp dir it removes.
    const entries = await extractBundle(bytes, v.artifactFilename ?? undefined, bundleContentCap(await getMaxBundleBytes()));
    return selectTryInput(entries, isSecretLikeLine);
  } catch {
    return null;
  }
}

/**
 * `GET /api/skills/:ns/:slug/try?semver=` (§61.6): resolve the version and fill the panel header.
 * No provider call. Order: visible (404) → effective (409) → version (404) → artifact (422).
 */
export async function tryContext(access: EffectiveAccess, ns: string, slug: string, semver: string | null, deps: TryDeps = {}): Promise<TryOutcome> {
  const skill = await visibleSkill(access, ns, slug);
  if (!skill) return outcome(404, { error: "not found" }, null);
  if (!(await tryEffective())) return outcome(409, UNAVAILABLE, null);
  const v = await installableVersion(skill, semver);
  if (!v) return outcome(404, VERSION_GONE, null);
  const sel = await loadSelection(v, deps);
  if (!sel) return outcome(422, SOURCE_FAILED, null);
  const [contentCheck, config] = await Promise.all([versionContentRiskStatus(skill.id, v.semver), loadAiConfig(pool)]);
  const body: TryContext = { semver: v.semver, model: config?.model ?? "", usage: v.usage, contentCheck: contentCheck ?? "pending", files: sel.states };
  return outcome(200, body as unknown as Record<string, unknown>, null);
}

/** The caller's skill_try calls in the rolling window (only calls that reached the provider are rows). */
async function recentTryCalls(userId: string, now: Date): Promise<Date[]> {
  const { rows } = await pool.query<{ created_at: Date }>(
    `select created_at from ai_usage
      where feature = $1 and user_id = $2 and created_at > $3
      order by created_at asc`,
    [AI_TRY_FEATURE, userId, new Date(now.getTime() - AI_TRY_WINDOW_MS)],
  );
  return rows.map((r) => r.created_at);
}

/**
 * `POST /api/skills/:ns/:slug/try` (§61.6): one message. Order: visible (404) → effective (409) →
 * per-minute limit → rolling daily cap (429) → transcript (422) → version (404) and artifact (422)
 * → one provider call, no retry (§43.9) → the reply, or 502 with no provider detail (§40.7).
 */
export async function trySend(access: EffectiveAccess & { userId: string }, ns: string, slug: string, body: unknown, deps: TryDeps = {}): Promise<TryOutcome> {
  const b = (body && typeof body === "object" ? body : {}) as { semver?: unknown; messages?: unknown };
  const skill = await visibleSkill(access, ns, slug);
  if (!skill) return outcome(404, { error: "not found" }, "rejected");
  if (!(await tryEffective())) return outcome(409, UNAVAILABLE, "rejected");

  const minute = rateLimit(`ai-try:${access.userId}`, AI_TRY_PER_MINUTE, 60_000);
  if (!minute.ok) {
    M.rateLimited.inc({ route: "ai-try" });
    return outcome(429, { error: "try_rate_limited", scope: "minute", message: "Too many messages in a row. Wait a minute and try again." }, "rate_limited");
  }
  const now = deps.now?.() ?? new Date();
  const daily = draftDailyCapDecision(await recentTryCalls(access.userId, now), now, AI_TRY_DAILY_CAP, AI_TRY_WINDOW_MS);
  if (!daily.ok) {
    return outcome(
      429,
      { error: "try_rate_limited", scope: "day", cap: AI_TRY_DAILY_CAP, retryAt: daily.retryAt.toISOString(), message: `Daily limit reached (${AI_TRY_DAILY_CAP} messages in 24 hours).` },
      "rate_limited",
    );
  }

  const t = validateTryTranscript(b.messages);
  if (!t.ok) return outcome(422, { error: t.error, message: t.message }, "rejected");
  const semver = typeof b.semver === "string" ? b.semver.trim() : "";
  if (!semver) return outcome(422, { error: "invalid_transcript", message: "semver is required" }, "rejected");

  const v = await installableVersion(skill, semver);
  if (!v) return outcome(404, VERSION_GONE, "rejected");
  const sel = await loadSelection(v, deps);
  if (!sel) return outcome(422, SOURCE_FAILED, "rejected");

  try {
    const res = await aiComplete({
      feature: AI_TRY_FEATURE,
      userId: access.userId,
      system: buildTrySystemPrompt(sel, randomUUID()),
      messages: t.messages,
      maxTokens: AI_TRY_MAX_TOKENS,
      retry: false,
    });
    const reply = res.text.trim();
    // An empty reply is a provider failure (§61.4).
    if (!reply) return outcome(502, FAILED, "failed");
    return outcome(200, { reply, model: res.model }, "ok");
  } catch (e) {
    if (e instanceof AiError && UNAVAILABLE_CODES.has(e.code)) return outcome(409, UNAVAILABLE, "rejected");
    return outcome(502, FAILED, "failed");
  }
}
