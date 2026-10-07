// "Draft with AI" on the propose form (SKILLY_SPEC.md §43): fetch the source's SKILL.md (hosted
// bundle extracted and discarded, pointer folder fetched, or the Keep-current-files artifact read),
// enforce the per-minute and rolling-daily limits, call the §40 helper with the §43.8 prompt and
// map the answer onto the category vocabulary. Nothing is persisted except the helper's own
// ai_usage row; nothing is audited (§43.7). The route only parses the request and authenticates.
import {
  AI_DRAFT_DAILY_CAP,
  AI_DRAFT_FEATURE,
  AI_DRAFT_MAX_TOKENS,
  AI_DRAFT_PER_MINUTE,
  AI_DRAFT_WINDOW_MS,
  buildDraftPrompt,
  bundleContentCap,
  draftDailyCapDecision,
  isSecretLikeLine,
  isSkillVisible,
  validateDraftOutput,
  type BundleEntry,
  type EffectiveAccess,
} from "@skilly/shared";
import { AiError } from "@skilly/shared/ai";
import { pool } from "./db";
import { aiAvailable, aiComplete } from "./ai";
import { extractBundle } from "./bundle";
import { findSkill, listAllCategories } from "./catalog";
import { fetchPointerContentForCheck, type PointerFetchResult } from "./pointerFetch";
import { resolveReuseSource } from "./proposals";
import { s3ArtifactStore } from "./objectStore";
import { getMaxBundleBytes, getUploadChunkBytes } from "./settings";
import { rateLimit } from "./ratelimit";
import { M } from "./metrics";

export type DraftSource =
  | { kind: "hosted"; bytes: Buffer; filename?: string }
  | { kind: "pointer"; externalUrl: string; externalRef: string; externalSubdir: string | null; skillSlug: string }
  | { kind: "reuse"; namespace: string; skill: string };

export interface DraftOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** I/O seams, so the integration test can stand in for the network and object storage. */
export interface DraftDeps {
  fetchPointer?: (url: string, ref: string, subdir: string | null, skillSlug: string, maxBytes: number) => Promise<PointerFetchResult>;
  getArtifact?: (key: string) => Promise<Buffer>;
  now?: () => Date;
}

/** Errors the helper raises before reaching the provider: AI went away between page load and click. */
const UNAVAILABLE_CODES = new Set(["ai_not_configured", "ai_disabled", "ai_key_missing", "ai_token_undecryptable"]);

function outcome(status: number, body: Record<string, unknown>, metric: "ok" | "failed" | "rate_limited" | "source_rejected" | null): DraftOutcome {
  if (metric) M.aiDraftRequests.inc({ outcome: metric });
  return { status, body };
}

/** The caller's skill_draft calls in the rolling window (only calls that reached the provider are rows). */
async function recentDraftCalls(userId: string, now: Date): Promise<Date[]> {
  const { rows } = await pool.query<{ created_at: Date }>(
    `select created_at from ai_usage
      where feature = $1 and user_id = $2 and created_at > $3
      order by created_at asc`,
    [AI_DRAFT_FEATURE, userId, new Date(now.getTime() - AI_DRAFT_WINDOW_MS)],
  );
  return rows.map((r) => r.created_at);
}

const skillMdOf = (entries: BundleEntry[]): string | null => {
  const f = entries.find((e) => e.path === "SKILL.md");
  return f ? new TextDecoder().decode(f.bytes) : null;
};

type SkillMdResult = { ok: true; skillMd: string } | { ok: false; outcome: DraftOutcome };

const noSkillMd = (): SkillMdResult => ({
  ok: false,
  outcome: outcome(422, { error: "draft_no_skill_md", message: "No SKILL.md at the bundle root." }, "source_rejected"),
});

async function loadSkillMd(access: EffectiveAccess, source: DraftSource, deps: DraftDeps): Promise<SkillMdResult> {
  const maxBundleBytes = await getMaxBundleBytes();
  if (source.kind === "hosted") {
    const chunkBytes = await getUploadChunkBytes();
    if (source.bytes.length > chunkBytes) {
      return { ok: false, outcome: outcome(413, { error: "draft_bundle_too_large", message: "Bundle too large to draft from." }, "source_rejected") };
    }
    let entries: BundleEntry[];
    try {
      // The same safe extraction as POST /api/uploads (§6); it works in a temp dir it removes.
      entries = await extractBundle(source.bytes, source.filename, bundleContentCap(maxBundleBytes));
    } catch {
      return { ok: false, outcome: outcome(422, { error: "draft_bundle_unreadable", message: "Couldn’t read this bundle." }, "source_rejected") };
    }
    const md = skillMdOf(entries);
    return md === null ? noSkillMd() : { ok: true, skillMd: md };
  }

  if (source.kind === "pointer") {
    const fetchPointer = deps.fetchPointer ?? fetchPointerContentForCheck;
    const r = await fetchPointer(source.externalUrl, source.externalRef, source.externalSubdir, source.skillSlug, maxBundleBytes);
    if (!r.ok) return { ok: false, outcome: outcome(422, { error: "draft_source_failed", message: r.error }, "source_rejected") };
    const md = skillMdOf(r.entries);
    return md === null ? noSkillMd() : { ok: true, skillMd: md };
  }

  // Keep current files: the skill the new-version form targets, visibility re-checked (#3).
  const skill = await findSkill(source.namespace, source.skill);
  if (!skill || skill.status === "archived" || !isSkillVisible(access, skill)) {
    return { ok: false, outcome: outcome(404, { error: "not found" }, "source_rejected") };
  }
  const reuse = await resolveReuseSource(pool, skill.id);
  if (!reuse.ok) return { ok: false, outcome: outcome(422, { error: "draft_source_failed", message: reuse.error }, "source_rejected") };
  let entries: BundleEntry[];
  try {
    const bytes = await (deps.getArtifact ?? ((k: string) => s3ArtifactStore().get(k)))(reuse.reuse.artifactObjectKey);
    entries = await extractBundle(bytes, reuse.reuse.artifactFilename ?? undefined, bundleContentCap(maxBundleBytes));
  } catch {
    return { ok: false, outcome: outcome(422, { error: "draft_bundle_unreadable", message: "Couldn’t read this skill’s current files." }, "source_rejected") };
  }
  const md = skillMdOf(entries);
  return md === null ? noSkillMd() : { ok: true, skillMd: md };
}

/**
 * Run one draft for `access.userId` (§43.5 order of checks): AI available → per-minute limit →
 * rolling daily cap → source size/fetch/extract → one provider call (no retry) → validation.
 */
export async function draftWithAi(access: EffectiveAccess & { userId: string }, source: DraftSource, deps: DraftDeps = {}): Promise<DraftOutcome> {
  if (!(await aiAvailable())) {
    return outcome(409, { error: "ai_unavailable", message: "AI drafting is no longer available." }, null);
  }

  const minute = rateLimit(`ai-draft:${access.userId}`, AI_DRAFT_PER_MINUTE, 60_000);
  if (!minute.ok) {
    M.rateLimited.inc({ route: "ai-draft" });
    return outcome(429, { error: "draft_rate_limited", scope: "minute", message: "Too many drafts in a row — wait a minute and try again." }, "rate_limited");
  }
  const now = deps.now?.() ?? new Date();
  const daily = draftDailyCapDecision(await recentDraftCalls(access.userId, now), now);
  if (!daily.ok) {
    return outcome(
      429,
      { error: "draft_rate_limited", scope: "day", cap: AI_DRAFT_DAILY_CAP, retryAt: daily.retryAt.toISOString(), message: `Daily AI draft limit reached (${AI_DRAFT_DAILY_CAP} in 24 hours).` },
      "rate_limited",
    );
  }

  const md = await loadSkillMd(access, source, deps);
  if (!md.ok) return md.outcome;

  const known = await listAllCategories();
  const prompt = buildDraftPrompt({ skillMd: md.skillMd, categories: known.map((c) => c.name), isSecretLine: isSecretLikeLine });
  let json: unknown;
  try {
    const res = await aiComplete({
      feature: AI_DRAFT_FEATURE,
      userId: access.userId,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      maxTokens: AI_DRAFT_MAX_TOKENS,
      json: true,
      retry: false,
    });
    json = res.json;
  } catch (e) {
    if (e instanceof AiError && UNAVAILABLE_CODES.has(e.code)) {
      return outcome(409, { error: "ai_unavailable", message: "AI drafting is no longer available." }, null);
    }
    // Provider detail never reaches the browser (§40.7); admins see it on the AI card / System log.
    return outcome(502, { error: "draft_failed", message: "Couldn’t draft right now — try again or write it yourself." }, "failed");
  }

  const draft = validateDraftOutput(json, known);
  if (!draft) return outcome(502, { error: "draft_failed", message: "Couldn’t draft right now — try again or write it yourself." }, "failed");
  return outcome(200, { description: draft.description, usage: draft.usage, categories: draft.categories }, "ok");
}
