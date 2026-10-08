// AI pre-review sweep (SKILLY_SPEC.md §46.3–§46.5). Leader-only; every 30 s while the switch is on
// and the §40 integration is operational.
//
// 1. Enqueue — every open proposal whose current revision has no run gets one: linked to an
//    existing run when the bytes are the same (a metadata-only revision, identical content), else a
//    fresh run, within the per-proposal daily cap. Every active version published since the switch
//    was turned on gets its source proposal's run when the bytes match, else its own run (a direct
//    publish, or a pointer whose mirror differs from what was reviewed).
// 2. Run — up to 3 due runs concurrently: fetch the bytes (artifact or pointer clone), reuse an
//    identical finished result if one exists, else call the model, validate, store; then settle the
//    skill.ai_prereview_flagged notification. §46's findings are advisory: nothing gates on them.
//
// §47 policy rules ride in the same call: the run judges the rules applicable to its subject, the
// per-rule results are stored with the run (the only AI output the accept gate reads), the rules
// fingerprint joins the cache key, and a reconcile step re-checks subjects whose current run
// predates a rule's current wording (open proposals: enforced rules; the latest published version
// of each skill in scope: every non-disabled rule, rate-limited).
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import {
  PURE_SCANNERS, runScanners, contentDigest, isSecretLikeLine, bundleContentCap,
  selectPrereviewInput, buildPrereviewPrompt, validatePrereviewResponse, maxPrereviewSeverity,
  loadPrereviewSetting, duePrereviewRuns, recordPrereviewSuccess, recordPrereviewFailure, copyPrereviewResult, findReusableRun,
  settlePrereviewNotification, createPrereviewRun, linkPrereviewRun, currentPrereviewRun, prereviewSourceOfPayload, samePrereviewSource,
  sourceProposalOfVersion, pruneOrphanPrereviews,
  applicablePolicyRules, policyRulesForRun, policyFingerprintInput, policyRulesFingerprint, keyPolicyRules, parsePolicyResponse, verifyPolicyResults,
  notifyProposalPolicyViolations, settleVersionPolicyRun, policyReconcile, countPolicyFlaggedVersions,
  PREREVIEW_FEATURE, PREREVIEW_MAX_TOKENS, PREREVIEW_PROPOSAL_DAILY_CAP, PREREVIEW_OPEN_STATES,
  type BundleEntry, type PrereviewRunRow, type PrereviewSetting, type PrereviewTrigger, type PolicyRuleRow, type PolicySubject, type PrereviewSource,
} from "@skilly/shared";
import { aiAvailable, aiComplete, parseAiTokenKey, AiError, type AiEnv } from "@skilly/shared/ai";
import type { ArtifactStore } from "../storage/objectStore.js";
import { extractAny } from "../git/contentBackfill.js";
import { fetchPointerFiles } from "../git/mirror.js";
import { getMaxBundleBytes } from "../settings.js";
import { M } from "../metrics.js";

/** Runs started per pass, concurrently (§46.5). */
export const PREREVIEW_SWEEP_BATCH = 3;
/** Subjects enqueued per pass. */
const ENQUEUE_BATCH = 25;

function aiEnv(): AiEnv {
  return { key: parseAiTokenKey(process.env.AI_TOKEN_ENC_KEY), source: "worker" };
}

const REFUSED = new Set(["ai_disabled", "ai_not_configured", "ai_key_missing", "ai_unknown_feature"]);

/** §47.2: the fingerprint of the rules applicable in a namespace (null: none). */
async function namespaceRulesFingerprint(pool: Pool, namespaceId: string): Promise<string | null> {
  return policyRulesFingerprint(policyFingerprintInput(await applicablePolicyRules(pool, namespaceId)));
}

/** §47.8: audit each version that just entered `flagged` (the notification is already sent). */
async function settleVersionPolicy(pool: Pool, runId: string): Promise<void> {
  for (const o of await settleVersionPolicyRun(pool, runId)) {
    await pool.query(
      `insert into audit_log (actor_user_id, action, target_type, target_id, namespace_id, after, source)
       values (null, 'skill.policy_flagged', 'skill_version', $1, $2, $3::jsonb, 'worker')`,
      [`${o.skillId}@${o.semver}`, o.namespaceId, JSON.stringify({ skill: o.skillSlug, semver: o.semver, runId, rules: o.rules })],
    );
  }
}

// ── Enqueue ────────────────────────────────────────────────────────────────────────────────────

/** Give every open proposal's current revision a run (§46.3). Returns how many were linked. */
export async function enqueueProposalPrereviews(pool: Pool, setting: PrereviewSetting, limit = ENQUEUE_BATCH): Promise<number> {
  const { rows } = await pool.query<{ id: string; revision_no: number; payload: unknown; rev_created_at: Date; target_namespace_id: string }>(
    `select p.id, pr.revision_no, pr.payload, pr.created_at as rev_created_at, p.target_namespace_id
       from proposals p
       join lateral (
         select revision_no, payload, created_at from proposal_revisions
          where proposal_id = p.id order by revision_no desc limit 1
       ) pr on true
      where p.state::text = any($1::text[])
        and not exists (select 1 from ai_prereview_links l where l.proposal_id = p.id and l.revision = pr.revision_no)
        and (select count(*) from ai_prereview_links l join ai_prereviews r on r.id = l.run_id
              where l.proposal_id = p.id and not l.cached and r.trigger <> 'rerun' and l.created_at > now() - interval '24 hours') < $2
      order by pr.created_at asc
      limit $3`,
    [[...PREREVIEW_OPEN_STATES], PREREVIEW_PROPOSAL_DAILY_CAP, limit],
  );
  let linked = 0;
  for (const r of rows) {
    try {
      const src = prereviewSourceOfPayload(r.payload);
      if (!src) continue;
      const subject = { kind: "proposal" as const, proposalId: r.id, revision: r.revision_no };
      // §47.5: a run is only reused under exactly the same policy-rule revisions.
      const fp = await namespaceRulesFingerprint(pool, r.target_namespace_id);
      // Same bytes as an existing run (a metadata-only revision, or identical content elsewhere).
      let reuse = await findReusableRun(pool, src.contentSha256, fp);
      if (!reuse && r.revision_no > 1) {
        const prev = await currentPrereviewRun(pool, { kind: "proposal", proposalId: r.id, revision: r.revision_no - 1 });
        if (prev && prev.status !== "failed" && samePrereviewSource(prev.source, src.source) && prev.rulesFingerprint === fp) reuse = prev;
      }
      if (reuse) {
        await linkPrereviewRun(pool, reuse.id, subject, true);
      } else {
        const trigger: PrereviewTrigger =
          setting.since && new Date(r.rev_created_at).getTime() < Date.parse(setting.since) ? "enable" : r.revision_no === 1 ? "submit" : "revision";
        const runId = await createPrereviewRun(pool, { source: src.source, contentSha256: src.contentSha256, trigger, rulesFingerprint: fp });
        await linkPrereviewRun(pool, runId, subject, false);
      }
      linked++;
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", msg: "ai pre-review enqueue failed", proposalId: r.id, err: String((err as Error)?.message ?? err) }));
    }
  }
  return linked;
}

/**
 * Give every active version published since the switch was turned on a run (§46.3): its source
 * proposal's run when the bytes match, else its own. Returns how many were linked.
 */
export async function enqueueVersionPrereviews(pool: Pool, since: string, limit = ENQUEUE_BATCH): Promise<number> {
  const { rows } = await pool.query<{ id: string; artifact_object_key: string; content_sha256: string | null; namespace_id: string }>(
    `select sv.id, sv.artifact_object_key, sv.content_sha256, s.namespace_id
       from skill_versions sv
       join skills s on s.id = sv.skill_id and s.status = 'active'
      where sv.created_at >= $1::timestamptz and sv.status = 'active' and sv.artifact_object_key is not null
        and not exists (select 1 from ai_prereview_links l where l.skill_version_id = sv.id)
      order by sv.created_at asc
      limit $2`,
    [since, limit],
  );
  let linked = 0;
  for (const v of rows) {
    try {
      const subject = { kind: "version" as const, versionId: v.id };
      const proposalId = await sourceProposalOfVersion(pool, v.id);
      let proposalRun: PrereviewRunRow | null = null;
      if (proposalId) {
        const { rows: lr } = await pool.query<{ revision_no: number }>(
          `select max(revision_no)::int as revision_no from proposal_revisions where proposal_id = $1`,
          [proposalId],
        );
        if (lr[0]?.revision_no) proposalRun = await currentPrereviewRun(pool, { kind: "proposal", proposalId, revision: lr[0].revision_no });
      }
      if (proposalRun) {
        // A pointer run learns its digest only once it has cloned: wait for it before comparing.
        if (proposalRun.status === "pending" && !proposalRun.contentSha256) continue;
        if (!v.content_sha256 || !proposalRun.contentSha256 || proposalRun.contentSha256 === v.content_sha256) {
          // The reviewer's run covers these bytes. If it is still pending, the notification
          // settles when it finishes (the reviewer never saw it).
          await linkPrereviewRun(pool, proposalRun.id, subject, true);
          // §47.8: a done run's policy results become the version's now (an override at accept
          // already recorded its exceptions, so only a genuinely new violation is an onset).
          if (proposalRun.status === "done") await settleVersionPolicy(pool, proposalRun.id);
          linked++;
          continue;
        }
        // The upstream ref moved between review and mirror: these bytes were never reviewed.
        const runId = await createPrereviewRun(pool, {
          source: { kind: "artifact", objectKey: v.artifact_object_key },
          contentSha256: v.content_sha256,
          trigger: "mirror",
          rulesFingerprint: await namespaceRulesFingerprint(pool, v.namespace_id),
        });
        await linkPrereviewRun(pool, runId, subject, false);
        linked++;
        continue;
      }
      // A direct publish (or an accept the pre-review never saw).
      const fp = await namespaceRulesFingerprint(pool, v.namespace_id);
      const reuse = await findReusableRun(pool, v.content_sha256, fp);
      if (reuse) {
        await linkPrereviewRun(pool, reuse.id, subject, true);
        if (reuse.status === "done") {
          await settlePrereviewNotification(pool, reuse.id, v.id);
          await settleVersionPolicy(pool, reuse.id);
        }
      } else {
        const runId = await createPrereviewRun(pool, { source: { kind: "artifact", objectKey: v.artifact_object_key }, contentSha256: v.content_sha256, trigger: "direct_publish", rulesFingerprint: fp });
        await linkPrereviewRun(pool, runId, subject, false);
      }
      linked++;
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", msg: "ai pre-review version enqueue failed", versionId: v.id, err: String((err as Error)?.message ?? err) }));
    }
  }
  return linked;
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────

export interface PrereviewDeps {
  env?: AiEnv;
  /** Test seam: fetch a pointer source's files. */
  fetchPointer?: (src: { url: string; ref: string; subdir: string | null; slug: string }, cap: number) => Promise<BundleEntry[]>;
}

type RunOutcome = "done" | "failed" | "cached" | "refused";

async function loadFiles(pool: Pool, store: ArtifactStore, run: PrereviewRunRow, deps: PrereviewDeps): Promise<BundleEntry[]> {
  if (run.source.kind === "artifact") return extractAny(await store.get(run.source.objectKey));
  const cap = bundleContentCap(await getMaxBundleBytes(pool));
  const s = run.source;
  if (deps.fetchPointer) return deps.fetchPointer(s, cap);
  return (await fetchPointerFiles(s.url, s.ref, s.subdir, s.slug, cap)).files;
}

/** One run: fetch, reuse or call, validate, store, notify. */
export async function executePrereviewRun(pool: Pool, store: ArtifactStore, run: PrereviewRunRow, deps: PrereviewDeps = {}): Promise<RunOutcome> {
  const env = deps.env ?? aiEnv();
  let files: BundleEntry[];
  try {
    files = await loadFiles(pool, store, run, deps);
  } catch (err) {
    await recordPrereviewFailure(pool, run.id, `source_unreachable: ${String((err as Error)?.message ?? err)}`);
    return "failed";
  }
  const digest = contentDigest(files);
  // §47: the rules this run judges (those of its oldest link's subject) and their fingerprint.
  const rules: PolicyRuleRow[] = await policyRulesForRun(pool, run.id);
  const fingerprint = policyRulesFingerprint(policyFingerprintInput(rules));
  // Identical bytes already reviewed under the same rules (a pointer clone, or an artifact with no
  // stored digest): copy that result instead of calling again. A re-run always calls.
  if (run.trigger !== "rerun") {
    const done = await findReusableRun(pool, digest, fingerprint, run.id);
    if (done?.status === "done" && done.result) {
      await copyPrereviewResult(pool, run.id, done, digest);
      await settlePrereviewNotification(pool, run.id);
      await settleVersionPolicy(pool, run.id);
      return "cached";
    }
  }
  const selection = selectPrereviewInput(files, { isSecretLine: isSecretLikeLine });
  // Deterministic context: the pure scanners over the same files (§46.6) — never their excerpts.
  const context = await runScanners(files, PURE_SCANNERS);
  const promptRules = keyPolicyRules(rules.map((r) => ({ ruleId: r.id, revisionId: r.revisionId, title: r.title, body: r.body, context: r.context })));
  const prompt = buildPrereviewPrompt({ selection, findings: context, rules: promptRules, nonce: randomBytes(9).toString("hex") });
  try {
    const res = await aiComplete(pool, env, {
      feature: PREREVIEW_FEATURE,
      userId: run.trigger === "rerun" ? run.requestedBy : null,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      maxTokens: PREREVIEW_MAX_TOKENS,
      json: true,
    });
    const result = validatePrereviewResponse(res.json, selection);
    if (!result) {
      await recordPrereviewFailure(pool, run.id, "ai_invalid_json: the answer did not have a findings list", { contentSha256: digest });
      return "failed";
    }
    // §47.5: per-rule validation and the server-side evidence check against the text actually sent.
    const included = new Map(selection.files.map((f) => [f.path, f.text]));
    const policyResults = promptRules.length
      ? verifyPolicyResults(parsePolicyResponse((res.json as { policy?: unknown } | null)?.policy, promptRules), promptRules, included)
      : [];
    const stateOf = new Map(rules.map((r) => [r.id, r.state]));
    await recordPrereviewSuccess(pool, run.id, {
      result,
      coverage: selection.coverage,
      model: res.model,
      contentSha256: digest,
      maxSeverity: maxPrereviewSeverity(result.findings),
      policy: {
        fingerprint,
        results: policyResults.map((r) => ({
          ruleId: r.ruleId,
          revisionId: r.revisionId,
          ruleState: stateOf.get(r.ruleId) === "enforced" ? "enforced" : "shadow",
          outcome: r.outcome,
          explanation: r.explanation,
          evidence: r.evidence,
          evidenceRejected: r.evidenceRejected,
        })),
      },
    });
    for (const f of result.findings) M.aiPrereviewFindings.inc({ category: f.category, severity: f.severity });
    for (const r of policyResults) {
      M.policyResults.inc({ outcome: r.outcome, state: stateOf.get(r.ruleId) ?? "shadow" });
      if (r.evidenceRejected) M.policyEvidenceRejected.inc();
    }
    await settlePrereviewNotification(pool, run.id);
    await notifyProposalPolicyViolations(pool, run.id);
    await settleVersionPolicy(pool, run.id);
    return "done";
  } catch (err) {
    if (err instanceof AiError && REFUSED.has(err.code)) return "refused";
    const msg = err instanceof AiError ? `${err.code}: ${err.message}` : String((err as Error)?.message ?? err);
    await recordPrereviewFailure(pool, run.id, msg, { contentSha256: digest });
    return "failed";
  }
}

/** One pass: enqueue, then run up to PREREVIEW_SWEEP_BATCH due runs. Returns the counts. */
export async function sweepAiPrereview(pool: Pool, store: ArtifactStore, deps: PrereviewDeps = {}): Promise<{ enqueued: number; ran: number }> {
  const setting = await loadPrereviewSetting(pool);
  if (!setting.enabled) return { enqueued: 0, ran: 0 };
  const env = deps.env ?? aiEnv();
  if (!(await aiAvailable(pool, env))) return { enqueued: 0, ran: 0 };
  let enqueued = await enqueueProposalPrereviews(pool, setting);
  if (setting.since) enqueued += await enqueueVersionPrereviews(pool, setting.since);
  // §47.6: re-check subjects whose current run predates a rule's current wording.
  const rc = await policyReconcile(pool, (subject, src, rules) => makePolicyRun(pool, subject, src, rules));
  enqueued += rc.proposals + rc.versions;
  const due = await duePrereviewRuns(pool, PREREVIEW_SWEEP_BATCH);
  const outcomes = await Promise.all(
    due.map((run) =>
      executePrereviewRun(pool, store, run, { ...deps, env }).catch((err) => {
        console.error(JSON.stringify({ level: "error", msg: "ai pre-review run crashed", runId: run.id, err: String((err as Error)?.message ?? err) }));
        return "failed" as RunOutcome;
      }),
    ),
  );
  for (const o of outcomes) if (o !== "refused") M.aiPrereviewRuns.inc({ outcome: o });
  const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from ai_prereviews where status = 'pending'`);
  M.aiPrereviewPending.set(Number(rows[0]?.n ?? 0));
  M.policyFlaggedVersions.set(await countPolicyFlaggedVersions(pool));
  return { enqueued, ran: outcomes.filter((o) => o !== "refused").length };
}

/** §47.6: one reconcile pass on its own (the sweep runs it after enqueueing; tests call it directly). */
export async function reconcilePolicyRuns(pool: Pool): Promise<{ proposals: number; versions: number }> {
  return policyReconcile(pool, (subject, src, rules) => makePolicyRun(pool, subject, src, rules));
}

/**
 * §47.6: give a subject a run for the current rules — linked to an identical run (same bytes, same
 * rule revisions) when one exists, else a fresh `policy` run.
 */
async function makePolicyRun(pool: Pool, subject: PolicySubject, src: { source: PrereviewSource; contentSha256: string | null }, rules: PolicyRuleRow[]): Promise<void> {
  const fp = policyRulesFingerprint(policyFingerprintInput(rules));
  const reuse = await findReusableRun(pool, src.contentSha256, fp);
  if (reuse) {
    await linkPrereviewRun(pool, reuse.id, subject, true);
    if (reuse.status === "done" && subject.kind === "version") await settleVersionPolicy(pool, reuse.id);
    return;
  }
  const runId = await createPrereviewRun(pool, { source: src.source, contentSha256: src.contentSha256, trigger: "policy", rulesFingerprint: fp });
  await linkPrereviewRun(pool, runId, subject, false);
}

/** Housekeeping: drop runs no subject links any more (§46.9). */
export async function pruneAiPrereviews(pool: Pool): Promise<number> {
  return pruneOrphanPrereviews(pool);
}
