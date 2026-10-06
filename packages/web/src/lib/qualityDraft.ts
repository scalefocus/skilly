// AI-drafted quality improvements (SKILLY_SPEC.md §43) on the web side: eligibility, the file plan,
// the streamed run (one §40 call per file, bounded concurrency, a whole-run cap), the stateless
// run/draft tokens, and assembling the kept changes into a staged hosted bundle through the
// ordinary upload pipeline. Nothing here stores AI output — the browser holds the results until the
// user opens the propose form; the tokens prove provenance without server-side state.
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import AdmZip from "adm-zip";
import {
  canReviewNamespace, isSkillVisible, latestArtifactFindings, loadVersionQuality, bundleContentCap, diffLines,
  planDraft, buildDraftPrompt, validateDraftResponse, draftKnownIds, draftUnavailableReason, draftReasonText, draftWhatChangedNote,
  parseFrontmatter, decodeScanText, resolveLatest,
  DRAFT_AI_FEATURE, DRAFT_MAX_TOKENS, DRAFT_CONCURRENCY, DRAFT_RUN_CAP_MS, DRAFT_HEARTBEAT_MS, DRAFT_TOKEN_TTL_MS,
  type EffectiveAccess, type BundleEntry, type ScanFinding, type QualityVerdict, type DraftPlanFile, type DraftFileResult,
  type DraftUnavailableReason,
} from "@skilly/shared";
import { AiError, AI_BUDGET_EXHAUSTED_MESSAGE } from "@skilly/shared/ai";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { aiAvailable, aiComplete } from "./ai";
import { isExplicitMaintainer } from "./grants";
import { s3ArtifactStore, type ArtifactStore } from "./objectStore";
import { extractBundle } from "./bundle";
import { getMaxBundleBytes } from "./settings";
import { processBundleUpload } from "./uploadPipeline";
import { M } from "./metrics";

// ── Context & eligibility (§43.2) ───────────────────────────────────────────────────────────────

/** The caller: resolved access plus (when known) the user id. */
type Viewer = EffectiveAccess & { userId?: string | null };

export interface DraftSkill {
  id: string;
  namespaceId: string;
  namespaceSlug: string;
  slug: string;
  title: string;
  type: "hosted" | "pointer";
  status: "active" | "archived";
  visibility: "org" | "namespace";
  sharedNamespaceIds: string[];
}

export interface DraftContext {
  skill: DraftSkill;
  semver: string;
  versionId: string;
  artifactKey: string;
  findings: ScanFinding[];
  verdict: QualityVerdict | null;
}

/** Why the action is hidden (no reason shown) — the 409 `reason` of the run/plan routes. */
export type DraftHiddenReason = "ai_unavailable" | "not_hosted" | "archived" | "no_stable_version";

export type DraftContextResult =
  | { ok: true; ctx: DraftContext }
  | { ok: false; status: number; error: string; reason?: DraftHiddenReason | DraftUnavailableReason };

async function loadSkill(ns: string, slug: string): Promise<DraftSkill | null> {
  const { rows } = await pool.query<{
    id: string; namespace_id: string; namespace_slug: string; slug: string; title: string; type: "hosted" | "pointer";
    status: "active" | "archived"; visibility: "org" | "namespace"; shared: string[];
  }>(
    `select s.id, s.namespace_id, n.slug as namespace_slug, s.slug, s.title, s.type, s.status, s.visibility,
            coalesce((select array_agg(g.namespace_id::text) from skill_namespace_grants g where g.skill_id = s.id), '{}') as shared
       from skills s join namespaces n on n.id = s.namespace_id
      where n.slug = $1 and s.slug = $2`,
    [ns, slug],
  );
  const r = rows[0];
  return r
    ? { id: r.id, namespaceId: r.namespace_id, namespaceSlug: r.namespace_slug, slug: r.slug, title: r.title, type: r.type, status: r.status, visibility: r.visibility, sharedNamespaceIds: r.shared ?? [] }
    : null;
}

/** The latest stable active version (§7 `latest`) with its artifact key. */
async function latestStable(skillId: string): Promise<{ id: string; semver: string; artifactKey: string | null } | null> {
  const { rows } = await pool.query<{ id: string; semver: string; artifact_object_key: string | null }>(
    `select id, semver, artifact_object_key from skill_versions where skill_id = $1 and status = 'active' and not is_prerelease`,
    [skillId],
  );
  const latest = resolveLatest(rows.map((r) => r.semver));
  const v = rows.find((r) => r.semver === latest);
  return v ? { id: v.id, semver: v.semver, artifactKey: v.artifact_object_key } : null;
}

/** Platform admin, a namespace admin of the owning namespace, or an explicit maintainer (§43.2). */
export async function mayDraft(access: Viewer, skill: Pick<DraftSkill, "id" | "namespaceId">): Promise<boolean> {
  if (canReviewNamespace(access, skill.namespaceId)) return true;
  return access.userId ? isExplicitMaintainer(skill.id, access.userId) : false;
}

/**
 * Resolve everything a plan / run / assemble needs, enforcing §43.2 in order: visibility (404),
 * role (403), the hidden conditions and the disabled reasons (409 `ai_draft_unavailable`).
 */
export async function loadDraftContext(access: Viewer, ns: string, slug: string): Promise<DraftContextResult> {
  const skill = await loadSkill(ns, slug);
  if (!skill || !isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility, sharedNamespaceIds: skill.sharedNamespaceIds })) {
    return { ok: false, status: 404, error: "not found" };
  }
  if (!(await mayDraft(access, skill))) {
    return { ok: false, status: 403, error: "only this skill's maintainers, its namespace admins and platform admins can draft improvements" };
  }
  const unavailable = (reason: DraftHiddenReason | DraftUnavailableReason, error: string): DraftContextResult => ({ ok: false, status: 409, error, reason });
  if (!(await aiAvailable())) return unavailable("ai_unavailable", "the AI integration is not operational");
  if (skill.type !== "hosted") return unavailable("not_hosted", "AI drafts are available for hosted skills only — fix an external skill upstream");
  if (skill.status !== "active") return unavailable("archived", "this skill is archived");
  const v = await latestStable(skill.id);
  if (!v || !v.artifactKey) return unavailable("no_stable_version", "this skill has no published stable version");
  const row = await loadVersionQuality(pool, v.id);
  const report = await latestArtifactFindings(pool, v.artifactKey);
  const verdict = row?.aiVerdict ?? null;
  const reason = draftUnavailableReason({ hasQualityRow: !!row, findings: report?.findings ?? null, verdict });
  if (reason) return unavailable(reason, draftReasonText(reason));
  return { ok: true, ctx: { skill, semver: v.semver, versionId: v.id, artifactKey: v.artifactKey, findings: (report?.findings ?? []) as ScanFinding[], verdict } };
}

/** `qualityDetail.aiDraft` on the skill payload (§43.2): `available:false, reason:null` = hidden. */
export async function aiDraftAvailability(access: Viewer, ns: string, slug: string): Promise<{ available: boolean; reason: DraftUnavailableReason | null }> {
  const r = await loadDraftContext(access, ns, slug);
  if (r.ok) return { available: true, reason: null };
  const disabled: DraftUnavailableReason[] = ["quality_pending", "nothing_to_draft", "secret_in_skill_md"];
  return { available: false, reason: r.reason && (disabled as string[]).includes(r.reason) ? (r.reason as DraftUnavailableReason) : null };
}

/** `canAiDraft` for My Skills rows (§43.9): AI operational and the skill hosted, active and scored. */
export async function canAiDraftFlags(items: { type?: string; status?: string; quality?: unknown }[]): Promise<boolean[]> {
  const on = items.length > 0 && (await aiAvailable());
  return items.map((s) => on && s.type === "hosted" && (s.status ?? "active") === "active" && s.quality != null);
}

// ── Plan (§43.3) ────────────────────────────────────────────────────────────────────────────────

export interface PlanFileView extends DraftPlanFile {
  reasonText?: string;
}

async function readBundle(ctx: DraftContext, store: ArtifactStore): Promise<BundleEntry[]> {
  return extractBundle(await store.get(ctx.artifactKey), undefined, bundleContentCap(await getMaxBundleBytes()));
}

export async function draftPlan(ctx: DraftContext, deps: { store?: ArtifactStore } = {}): Promise<{ files: BundleEntry[]; plan: PlanFileView[] }> {
  const files = await readBundle(ctx, deps.store ?? s3ArtifactStore());
  const plan = planDraft({ files, findings: ctx.findings }).map((p) => (p.reason ? { ...p, reasonText: draftReasonText(p.reason) } : p));
  return { files, plan };
}

// ── Tokens (§43.5 / §43.7) ──────────────────────────────────────────────────────────────────────

// HMAC key: the Auth.js secret (always set in a real deployment); a per-process random key keeps
// dev/test working — tokens then simply don't survive a restart.
const fallbackKey = randomBytes(32);
function tokenKey(): Buffer {
  const s = process.env.NEXTAUTH_SECRET;
  return s ? createHash("sha256").update(`skilly-ai-draft:${s}`).digest() : fallbackKey;
}

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString("base64url");
}

function sign(payload: object): string {
  const body = b64url(JSON.stringify(payload));
  const mac = createHmac("sha256", tokenKey()).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

function verify<T extends { iat: number; k: string }>(token: unknown, kind: string, now = Date.now()): T | null {
  if (typeof token !== "string" || token.length > 64_000) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), "base64url");
  const want = createHmac("sha256", tokenKey()).update(body).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    if (p.k !== kind || typeof p.iat !== "number" || now - p.iat > DRAFT_TOKEN_TTL_MS || p.iat > now + 60_000) return null;
    return p;
  } catch {
    return null;
  }
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

interface RunTokenPayload {
  k: "run";
  iat: number;
  u: string;
  s: string;
  v: string;
  m: string | null;
  /** [path, action, sha256(content) | ""] for every modified/deleted result. */
  c: [string, "modify" | "delete", string][];
}

export function signRunToken(p: Omit<RunTokenPayload, "k" | "iat">, now = Date.now()): string {
  return sign({ k: "run", iat: now, ...p });
}

export function verifyRunToken(token: unknown, now = Date.now()): RunTokenPayload | null {
  return verify<RunTokenPayload>(token, "run", now);
}

interface DraftTokenPayload {
  k: "draft";
  iat: number;
  u: string;
  s: string;
  a: string;
  m: string;
}

export function signDraftToken(p: Omit<DraftTokenPayload, "k" | "iat">, now = Date.now()): string {
  return sign({ k: "draft", iat: now, ...p });
}

/**
 * §43.8: the model a valid aiDraftToken vouches for — only when it was issued to this user for
 * this skill and names exactly the submitted artifact. Anything else is null (silently ignored).
 */
export function aiDraftModelFromToken(token: unknown, expect: { userId: string; skillId: string | null; artifactKey: string | null | undefined }, now = Date.now()): string | null {
  if (!token || !expect.skillId || !expect.artifactKey) return null;
  const p = verify<DraftTokenPayload>(token, "draft", now);
  if (!p || p.u !== expect.userId || p.s !== expect.skillId || p.a !== expect.artifactKey) return null;
  return typeof p.m === "string" && p.m ? p.m.slice(0, 200) : null;
}

// ── The run (§43.5) ─────────────────────────────────────────────────────────────────────────────

export type DraftEvent =
  | { type: "plan"; baseSemver: string; files: PlanFileView[] }
  | { type: "start"; path: string }
  | {
      type: "file";
      path: string;
      status: DraftFileResult["status"];
      summary: string;
      addressed: string[];
      reason?: string;
      reasonText?: string;
      content?: string;
      diff?: { hunks: unknown[]; added: number; removed: number } | null;
    }
  | { type: "heartbeat" }
  | { type: "done"; model: string | null; calls: number; runToken: string; outcome: "complete" | "capped" | "cancelled" };

/** Refused before the network — not a provider call. */
const REFUSED = new Set(["ai_not_configured", "ai_disabled", "ai_key_missing", "ai_unknown_feature"]);

function failReason(err: unknown, capped: boolean): string {
  if (err instanceof AiError) {
    if (err.code === "ai_cancelled") return capped ? "timed_out" : "cancelled";
    if (err.code === "ai_provider_error" && err.message === AI_BUDGET_EXHAUSTED_MESSAGE) return "too_large_to_rewrite";
    return err.code;
  }
  return "invalid_response";
}

/**
 * Run one draft: emit the plan, the deterministic deletes, then one AI call per queued file (at
 * most DRAFT_CONCURRENCY at a time) as each settles, a heartbeat every 15 s, and `done` with the
 * run token. Ends early (unfinished files `timed_out` / `cancelled`) at the run cap or when
 * `signal` aborts. Audits `skill.ai_draft_generated` once, however it ends.
 */
export async function runDraft(
  access: EffectiveAccess & { userId: string },
  ctx: DraftContext,
  emit: (e: DraftEvent) => void,
  opts: { signal?: AbortSignal; store?: ArtifactStore; capMs?: number; heartbeatMs?: number } = {},
): Promise<void> {
  const { files, plan } = await draftPlan(ctx, { store: opts.store });
  emit({ type: "plan", baseSemver: ctx.semver, files: plan });
  const heartbeat = setInterval(() => emit({ type: "heartbeat" }), opts.heartbeatMs ?? DRAFT_HEARTBEAT_MS);

  const stop = new AbortController();
  let capped = false;
  const cap = setTimeout(() => {
    capped = true;
    stop.abort();
  }, opts.capMs ?? DRAFT_RUN_CAP_MS);
  const onClientAbort = () => stop.abort();
  if (opts.signal) {
    if (opts.signal.aborted) stop.abort();
    else opts.signal.addEventListener("abort", onClientAbort, { once: true });
  }

  const byPath = new Map(files.map((f) => [f.path, f]));
  const skillMd = byPath.get("SKILL.md");
  const fm = skillMd ? parseFrontmatter(new TextDecoder().decode(skillMd.bytes)) : {};
  const counts: Record<string, number> = { queued: 0, modified: 0, deleted: 0, unchanged: 0, failed: 0, skipped: 0 };
  const signed: RunTokenPayload["c"] = [];
  let model: string | null = null;
  let calls = 0;

  for (const p of plan) {
    if (p.status === "skipped") counts.skipped!++;
    if (p.status === "delete") {
      counts.deleted!++;
      signed.push([p.path, "delete", ""]);
      emit({ type: "file", path: p.path, status: "deleted", summary: "Removed OS / tooling junk", addressed: ["FS-004"] });
    }
  }

  const queue = plan.filter((p) => p.status === "queued");
  counts.queued = queue.length;
  const allPaths = files.map((f) => f.path);

  const draftOne = async (p: PlanFileView): Promise<void> => {
    const entry = byPath.get(p.path)!;
    const original = decodeScanText(entry.bytes) ?? "";
    if (stop.signal.aborted) {
      const reason = capped ? "timed_out" : "cancelled";
      counts.failed!++;
      emit({ type: "file", path: p.path, status: "failed", summary: "", addressed: [], reason, reasonText: draftReasonText(reason) });
      return;
    }
    emit({ type: "start", path: p.path });
    const prompt = buildDraftPrompt({
      skillSlug: ctx.skill.slug,
      skillTitle: ctx.skill.title,
      skillName: fm.name ?? ctx.skill.slug,
      skillDescription: fm.description ?? "",
      filePaths: allPaths,
      path: p.path,
      content: original,
      findings: ctx.findings,
      verdict: p.path === "SKILL.md" ? ctx.verdict : null,
    });
    let result: DraftFileResult;
    try {
      const res = await aiComplete({
        feature: DRAFT_AI_FEATURE,
        userId: access.userId,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        maxTokens: DRAFT_MAX_TOKENS,
        json: true,
        signal: stop.signal,
      });
      calls++;
      model = model ?? res.model;
      result = validateDraftResponse(res.json, { path: p.path, original, knownIds: draftKnownIds({ path: p.path, findings: ctx.findings, verdict: ctx.verdict }) });
    } catch (err) {
      if (!(err instanceof AiError && REFUSED.has(err.code))) calls++;
      result = { path: p.path, status: "failed", summary: "", addressed: [], reason: failReason(err, capped) };
    }
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    if (result.status === "modified") {
      signed.push([p.path, "modify", sha256Hex(result.content!)]);
      const d = diffLines(original, result.content!);
      emit({ type: "file", path: p.path, status: "modified", summary: result.summary, addressed: result.addressed, content: result.content, diff: d.ok ? d.diff : null });
    } else if (result.status === "deleted") {
      signed.push([p.path, "delete", ""]);
      emit({ type: "file", path: p.path, status: "deleted", summary: result.summary, addressed: result.addressed });
    } else {
      emit({ type: "file", path: p.path, status: result.status, summary: result.summary, addressed: result.addressed, ...(result.reason ? { reason: result.reason, reasonText: draftReasonText(result.reason) } : {}) });
    }
  };

  try {
    let next = 0;
    const workers = Array.from({ length: Math.min(DRAFT_CONCURRENCY, queue.length) }, async () => {
      while (next < queue.length) {
        const p = queue[next++]!;
        await draftOne(p);
      }
    });
    await Promise.all(workers);
  } finally {
    clearInterval(heartbeat);
    clearTimeout(cap);
    opts.signal?.removeEventListener("abort", onClientAbort);
  }

  const outcome: "complete" | "capped" | "cancelled" = capped ? "capped" : opts.signal?.aborted ? "cancelled" : "complete";
  const runToken = signRunToken({ u: access.userId, s: ctx.skill.id, v: ctx.semver, m: model, c: signed });
  M.aiDraftRuns.inc({ outcome });
  for (const st of ["modified", "deleted", "unchanged", "failed", "skipped"]) if (counts[st]) M.aiDraftFiles.add(counts[st]!, { status: st });
  await appendAudit(pool, {
    actorUserId: access.userId,
    action: "skill.ai_draft_generated",
    targetType: "skill",
    targetId: ctx.skill.id,
    namespaceId: ctx.skill.namespaceId,
    after: { skill: ctx.skill.slug, baseSemver: ctx.semver, model, outcome, calls, files: counts },
  }).catch((err) => console.error(JSON.stringify({ level: "error", msg: "ai draft audit failed", err: String(err) })));
  emit({ type: "done", model, calls, runToken, outcome });
}

// ── Assemble (§43.7) ────────────────────────────────────────────────────────────────────────────

export interface AssembleChange {
  path: string;
  action: "modify" | "delete";
  content?: string;
  summary?: string;
}

export function parseAssembleChanges(raw: unknown): AssembleChange[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) return null;
  const out: AssembleChange[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (!c || typeof c !== "object") return null;
    const x = c as Record<string, unknown>;
    if (typeof x.path !== "string" || !x.path || seen.has(x.path)) return null;
    seen.add(x.path);
    const summary = typeof x.summary === "string" ? x.summary.slice(0, 200) : "";
    if (x.action === "delete") out.push({ path: x.path, action: "delete", summary });
    else if (x.action === "modify" && typeof x.content === "string") out.push({ path: x.path, action: "modify", content: x.content, summary });
    else return null;
  }
  return out;
}

/**
 * Turn the kept changes into a staged bundle: verify every change against the run token, apply
 * them to the base version's files, zip, and run the ordinary upload pipeline. The 201 response
 * gains `aiDraftToken` and the pre-filled `whatChanged` note.
 */
export async function assembleDraft(
  access: EffectiveAccess & { userId: string },
  ctx: DraftContext,
  input: { runToken: unknown; baseSemver: unknown; changes: AssembleChange[] },
  deps: { store?: ArtifactStore } = {},
): Promise<Response> {
  const tok = verifyRunToken(input.runToken);
  if (!tok || tok.u !== access.userId || tok.s !== ctx.skill.id) {
    return Response.json({ error: "this draft has expired or doesn't belong to you — generate a new one" }, { status: 422 });
  }
  if (input.baseSemver !== tok.v || tok.v !== ctx.semver) {
    return Response.json({ error: `v${ctx.semver} was published since this draft was made — generate a new draft`, reason: "base_changed" }, { status: 409 });
  }
  const allowed = new Set(tok.c.map(([p, a, h]) => `${p}\u0000${a}\u0000${h}`));
  for (const c of input.changes) {
    const key = `${c.path}\u0000${c.action}\u0000${c.action === "modify" ? sha256Hex(c.content!) : ""}`;
    if (!allowed.has(key)) return Response.json({ error: `the change to ${c.path} is not part of this draft` }, { status: 422 });
  }

  const files = await readBundle(ctx, deps.store ?? s3ArtifactStore());
  const map = new Map(files.map((f) => [f.path, f.bytes]));
  for (const c of input.changes) {
    if (!map.has(c.path)) return Response.json({ error: `${c.path} is not in v${ctx.semver}` }, { status: 422 });
    if (c.action === "delete") map.delete(c.path);
    else map.set(c.path, new TextEncoder().encode(c.content!));
  }
  const zip = new AdmZip();
  for (const [path, bytes] of [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) zip.addFile(path, Buffer.from(bytes));
  const bundle = zip.toBuffer();

  const res = await processBundleUpload(access, bundle, `${ctx.skill.slug}-draft.zip`, ctx.skill.slug, await getMaxBundleBytes(), { store: deps.store });
  if (res.status !== 201) return res;
  const j = (await res.json()) as Record<string, unknown>;
  const aiDraftToken = signDraftToken({ u: access.userId, s: ctx.skill.id, a: String(j.artifactObjectKey), m: tok.m ?? "unknown" });
  const whatChanged = draftWhatChangedNote(input.changes.map((c) => ({ path: c.path, action: c.action, summary: c.summary ?? "" })));
  return Response.json({ ...j, aiDraftToken, whatChanged, model: tok.m, baseSemver: tok.v }, { status: 201 });
}
