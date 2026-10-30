"use client";
// Import a whole repository (SKILLY_SPEC.md §64), the propose page's "I have a repo" tab (§64.2):
// the pick page (repository, ref, folder, scan, namespace, sharing, tool/harness default, the Draft
// with AI option and the list of found skills), the wizard dialog with one step per ticked skill
// (§64.4) and each step's own Draft button, the AI draft queue (§64.5) and the result view (§64.6).
// An unfinished import lives only in this browser tab (§64.1 decision 15).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  IMPORT_MAX_SKILLS,
  importPrefill,
  importReasonText,
  sameNameBlockers,
  tickAllImportable,
  type ImportSubmitResult,
  type ScanResult,
  type ScannedSkill,
} from "@skilly/shared/repo-import";
import { GENERIC_AGENT } from "@skilly/shared/agents";
import { isSkillsHubUrl } from "@skilly/shared/skills-hub";
import { Modal, Pill } from "../../components/ui";
import { useDateFmt } from "../../components/DateFormat";
import { TagInput } from "../../components/TagInput";
import { NamespaceMultiPicker, useShareTargets } from "../../components/NamespaceMultiPicker";
import { MarkdownField } from "../../components/MarkdownField";
import { ToolHarnessPicker } from "../../components/ToolHarnessPicker";
import { EmojiPicker } from "../../components/EmojiPicker";
import { useIconCropFlow } from "../../components/IconCropDialog";
import { useAiName } from "../../components/AiName";
import { DraftQueue, draftReplyFromResponse } from "../../lib/importDraftQueue";
import { applyDraft, canJumpTo, canSubmit, isDrafting, stepErrors, stepState, typedFields, undoDraft, type WizardStep } from "../../lib/importWizard";

const label = { display: "block", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 7 } as const;
const hint = { textTransform: "none", letterSpacing: 0, color: "var(--faint)" } as const;

type NamespaceOption = { slug: string; displayName: string; directPublish?: boolean };
type RefsResult = { ok: true; branches: string[]; tags: string[] } | { ok: false; error: string };
type Draft = { description: string; usage: string; categories: string[] };
/** One draft request in the queue: the skill's pointer source, and how its reply lands (§64.4). */
type DraftRequest = { path: string; url: string; ref: string; subdir: string | null; slug: string; fill: "replace" | "empty" };
type AiState = { available: boolean; remainingToday: number };

/** "(repo root)" for the root SKILL.md, else the folder. */
const where = (s: { subdir: string | null }) => s.subdir ?? "(repo root)";

function newStep(skill: ScannedSkill, toolHarness: string): WizardStep {
  const p = importPrefill(skill, toolHarness);
  return {
    path: skill.path,
    subdir: skill.subdir,
    skillSlug: p.skillSlug,
    title: p.title,
    description: p.description,
    usageExamples: p.usageExamples,
    categories: p.categories,
    toolHarness: p.toolHarness,
    semver: p.semver,
    iconEmoji: "",
    iconSha256: null,
    opened: false,
    draft: "none",
    draftKey: null,
    draftClicked: false,
    draftMessage: null,
    filled: { description: p.description, usageExamples: p.usageExamples },
    beforeDraft: null,
    draftedCategories: [],
    undoable: false,
    submitError: null,
  };
}

/** A request from the propose form to fill Repository and Ref (§64.9); `n` makes each one new. */
export type RepoFill = { url: string; ref: string | null; n: number };

/**
 * The tab's body. `tabs` is the propose page's segmented control, shown at the top of the first
 * card. The propose page keeps this mounted (hidden) once opened, so switching tabs loses nothing.
 */
export function ImportRepository({ tabs, fill }: { tabs: ReactNode; fill: RepoFill | null }) {
  const params = useSearchParams();
  const fmt = useDateFmt();
  const aiName = useAiName();
  const [url, setUrl] = useState(params.get("url") ?? "");
  const [ref, setRef] = useState(params.get("ref") || "main");
  const [folder, setFolder] = useState("");
  // A pasted `--all` command or the no-root-SKILL.md hint fills these. An existing scan just goes
  // stale, and Scan asks before discarding wizard edits.
  useEffect(() => {
    if (!fill) return;
    setUrl(fill.url);
    setRef(fill.ref || "main");
  }, [fill]);
  const [refProbe, setRefProbe] = useState<{ url: string; result: RefsResult } | null>(null);

  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanKey, setScanKey] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());

  const [namespaces, setNamespaces] = useState<NamespaceOption[]>([]);
  const [namespaceSlug, setNamespaceSlug] = useState("");
  const shareTargets = useShareTargets();
  const [sharedNs, setSharedNs] = useState<string[]>([]);
  const [toolDefault, setToolDefault] = useState(GENERIC_AGENT);
  const [categoryOptions, setCategoryOptions] = useState<{ name: string; slug: string }[]>([]);
  const [ai, setAi] = useState<AiState>({ available: false, remainingToday: 0 });
  const [useAi, setUseAi] = useState(false);
  // §64.5: a 409 `ai_unavailable` mid-import, and the daily cap's time from a capped draft.
  const [aiGone, setAiGone] = useState(false);
  const [capAt, setCapAt] = useState<string | null>(null);
  // A step's Draft button over typed text asks first (§64.4).
  const [draftConfirm, setDraftConfirm] = useState<{ path: string; fields: string[] } | null>(null);

  // The wizard (§64.4): steps keyed by SKILL.md path, the current one, and whether the dialog is open.
  const [steps, setSteps] = useState<WizardStep[]>([]);
  const [current, setCurrent] = useState(0);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [stepErr, setStepErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportSubmitResult | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const queue = useRef<DraftQueue<Draft> | null>(null);
  // Queue keys are unique per request, so a reply to a cancelled or superseded draft is ignored.
  const requests = useRef(new Map<string, DraftRequest>());
  const requestSeq = useRef(0);

  useEffect(() => {
    fetch("/api/namespaces")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const list: NamespaceOption[] = j?.namespaces ?? [];
        setNamespaces(list);
        setNamespaceSlug((cur) => cur || list[0]?.slug || "");
      })
      .catch(() => {});
    fetch("/api/categories").then((r) => (r.ok ? r.json() : null)).then((j) => j && setCategoryOptions(j.categories ?? [])).catch(() => {});
    loadAi();
  }, []);

  function loadAi() {
    fetch("/api/propose/ai-draft")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setAi({ available: j.available === true, remainingToday: typeof j.remainingToday === "number" ? j.remainingToday : 0 }))
      .catch(() => {});
  }

  // §64.4: at the daily cap's time, ask again; the steps' Draft buttons come back if drafts are left.
  useEffect(() => {
    if (!capAt) return;
    const t = setTimeout(() => { setCapAt(null); loadAi(); }, Math.max(0, Date.parse(capAt) - Date.now()) + 1000);
    return () => clearTimeout(t);
  }, [capAt]);

  // The live ref pre-check (§8), debounced on the URL.
  useEffect(() => {
    const u = url.trim();
    if (!u || isSkillsHubUrl(u)) { setRefProbe(null); return; }
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/pointer/refs?url=${encodeURIComponent(u)}`)
        .then((r) => r.json().catch(() => null))
        .then((j: RefsResult | null) => { if (live && j) setRefProbe({ url: u, result: j }); })
        .catch(() => {});
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [url]);

  const refs = refProbe && refProbe.url === url.trim() && refProbe.result.ok ? refProbe.result : null;
  const refTrim = ref.trim();
  const altRef = /^v\d/.test(refTrim) ? refTrim.slice(1) : /^\d/.test(refTrim) ? `v${refTrim}` : null;
  const allRefs = refs ? [...refs.tags, ...refs.branches] : [];
  const refMissing = !!refs && !!refTrim && !allRefs.includes(refTrim) && !(altRef && allRefs.includes(altRef));
  const hubUrl = isSkillsHubUrl(url.trim());

  const sourceKey = `${url.trim()}|${refTrim}|${folder.trim()}`;
  const staleScan = !!scan && scanKey !== sourceKey;
  const visibility: "org" | "namespace" = namespaceSlug === "global" ? "org" : "namespace";
  const ownerNamespaceId = shareTargets.find((o) => o.slug === namespaceSlug)?.id ?? null;
  const effectiveShared = visibility === "namespace" ? sharedNs.filter((id) => id !== ownerNamespaceId) : [];
  const directAllowed = namespaces.find((n) => n.slug === namespaceSlug)?.directPublish === true;

  const rows = scan?.skills ?? [];
  const blockers = useMemo(() => sameNameBlockers(rows, ticked), [rows, ticked]);
  const edited = steps.some((s) => s.opened || s.draft !== "none");

  // §64.4 leaving the page with any step edited or drafted asks first.
  useEffect(() => {
    if (!edited || result) return;
    const onBefore = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [edited, result]);

  async function runScan() {
    if (edited && !window.confirm(`Scanning again discards your edits to ${steps.length} skill${steps.length === 1 ? "" : "s"}.`)) return;
    setScanning(true);
    setScanErr(null);
    try {
      const r = await fetch("/api/propose/import/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), ref: refTrim, folder: folder.trim() || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Scan failed (HTTP ${r.status})`);
      setScan(j as ScanResult);
      setScanKey(sourceKey);
      setTicked(new Set());
      setSteps([]);
      setCurrent(0);
      setResult(null);
      setImportId(null);
      queue.current = null;
    } catch (e) {
      setScanErr(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  function toggle(path: string, on: boolean) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
    if (!on) removeStep(path, false);
  }

  const patchStep = useCallback((path: string, fn: (s: WizardStep) => WizardStep) => {
    setSteps((prev) => prev.map((s) => (s.path === path ? fn(s) : s)));
  }, []);

  /** A step's live draft settled: apply `fn` only if `key` is still the step's own request. */
  const settleDraft = useCallback((key: string, fn: (s: WizardStep) => WizardStep) => {
    const path = requests.current.get(key)?.path;
    if (path) patchStep(path, (s) => (s.draftKey === key ? fn(s) : s));
  }, [patchStep]);

  function draftQueue(): DraftQueue<Draft> {
    if (queue.current) return queue.current;
    queue.current = new DraftQueue<Draft>({
      send: async (key) => {
        const q = requests.current.get(key)!;
        const r = await fetch("/api/propose/ai-draft", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "pointer", externalUrl: q.url, externalRef: q.ref, externalSubdir: q.subdir ?? "", skillSlug: q.slug }),
        });
        const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
        return draftReplyFromResponse(r.status, j, (b) => ({
          description: typeof b.description === "string" ? b.description : "",
          usage: typeof b.usage === "string" ? b.usage : "",
          categories: Array.isArray(b.categories) ? (b.categories as { name?: unknown }[]).map((c) => (typeof c?.name === "string" ? c.name : "")).filter(Boolean) : [],
        }));
      },
      onEvent: (e) => {
        const fill = requests.current.get(e.key)?.fill ?? "replace";
        if (e.kind === "started") settleDraft(e.key, (s) => ({ ...s, draft: "drafting" }));
        else if (e.kind === "ok") {
          // Counted whether or not the step still wants it (§64.5: no refund).
          settleDraft(e.key, (s) => applyDraft(s, e.draft, fill));
          setAi((a) => ({ ...a, remainingToday: Math.max(0, a.remainingToday - 1) }));
        } else if (e.kind === "failed") settleDraft(e.key, (s) => ({ ...s, draft: "failed", draftKey: null, draftMessage: e.message }));
        else if (e.kind === "capped") {
          settleDraft(e.key, (s) => ({ ...s, draft: "capped", draftKey: null }));
          setAi((a) => ({ ...a, remainingToday: 0 }));
          if (e.retryAt) setCapAt(e.retryAt);
        } else {
          settleDraft(e.key, (s) => ({ ...s, draft: "skipped", draftKey: null }));
          setAi((a) => ({ ...a, available: false }));
          setAiGone(true);
          setUseAi(false);
        }
        if (e.kind !== "started") requests.current.delete(e.key);
      },
    });
    return queue.current;
  }

  /** A new queue key for one step's draft request, from the scanned source. */
  function newRequest(s: WizardStep, fill: "replace" | "empty"): string {
    const key = `${s.path}#${++requestSeq.current}`;
    requests.current.set(key, { path: s.path, url: url.trim(), ref: refTrim, subdir: s.subdir, slug: s.skillSlug, fill });
    return key;
  }

  /** Next on the pick page: the wizard's steps for the ticked skills, in path order (§64.4). */
  function openWizard() {
    const chosen = rows.filter((r) => ticked.has(r.path));
    const byPath = new Map(steps.map((s) => [s.path, s]));
    const next = chosen.map((r) => byPath.get(r.path) ?? newStep(r, toolDefault));
    const draftAll = useAi && ai.available;
    const toDraft: string[] = [];
    const withQueued = next.map((s) => {
      if (!draftAll || s.draft !== "none") return s;
      const key = newRequest(s, "replace");
      toDraft.push(key);
      return { ...s, draft: "queued" as const, draftKey: key, draftClicked: false };
    });
    const at = Math.min(current, withQueued.length - 1);
    const firstUnopened = withQueued.findIndex((s) => !s.opened);
    const start = withQueued[at]?.opened ? at : firstUnopened >= 0 ? firstUnopened : 0;
    setSteps(withQueued.map((s, i) => (i === start ? { ...s, opened: true } : s)));
    setCurrent(start);
    setStepErr(null);
    setWizardOpen(true);
    if (toDraft.length) draftQueue().enqueue(toDraft);
  }

  /** A step's own Draft button (§64.4): asks first when Description or Usage holds typed text. */
  function startStepDraft(s: WizardStep) {
    const fields = typedFields(s);
    if (fields.length) setDraftConfirm({ path: s.path, fields });
    else requestStepDraft(s.path, "replace");
  }

  /** Queue one step's draft at the front (§64.5); every click is one draft. */
  function requestStepDraft(path: string, fill: "replace" | "empty") {
    setDraftConfirm(null);
    const s = steps.find((x) => x.path === path);
    if (!s || isDrafting(s)) return;
    const key = newRequest(s, fill);
    // Undo stays for the earlier draft (hidden while drafting) until this one succeeds.
    patchStep(path, (x) => ({ ...x, draft: "queued", draftKey: key, draftClicked: true, draftMessage: null }));
    const q = draftQueue();
    q.resume();
    q.enqueueFirst(key);
  }

  /** *Fill it in myself* / *Cancel*: an unsent draft is dropped; one already sent is ignored. */
  function cancelStepDraft(s: WizardStep) {
    if (s.draftKey) queue.current?.drop(s.draftKey);
    patchStep(s.path, (x) => ({ ...x, draft: "skipped", draftKey: null }));
  }

  function removeStep(path: string, untick = true) {
    const key = steps.find((s) => s.path === path)?.draftKey;
    if (key) queue.current?.drop(key);
    if (untick) setTicked((prev) => { const n = new Set(prev); n.delete(path); return n; });
    setSteps((prev) => {
      const idx = prev.findIndex((s) => s.path === path);
      if (idx < 0) return prev;
      const next = prev.filter((s) => s.path !== path);
      if (!next.length) {
        setWizardOpen(false);
        setCurrent(0);
        return next;
      }
      const to = Math.min(idx, next.length - 1);
      setCurrent(to);
      return next.map((s, i) => (i === to ? { ...s, opened: true } : s));
    });
    setStepErr(null);
  }

  function go(to: number) {
    setSteps((prev) => prev.map((s, i) => (i === to ? { ...s, opened: true } : s)));
    setCurrent(to);
    setStepErr(null);
    const key = steps[to]?.draftKey;
    if (key) queue.current?.prioritize(key);
  }

  function next() {
    const s = steps[current];
    if (!s) return;
    const errs = stepErrors(s, categoryOptions);
    if (errs.length) { setStepErr(errs); return; }
    if (current < steps.length - 1) go(current + 1);
  }

  async function submit(mode: "review" | "direct") {
    setBusy(true);
    setSubmitErr(null);
    try {
      const r = await fetch("/api/propose/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          ref: refTrim,
          folder: folder.trim() || null,
          namespaceSlug,
          visibility,
          sharedNamespaceIds: effectiveShared,
          mode,
          importId,
          items: steps.map((s) => ({
            subdir: s.subdir,
            semver: s.semver.trim(),
            metadata: {
              skillSlug: s.skillSlug,
              title: s.title.trim(),
              description: s.description.trim(),
              categories: s.categories,
              toolHarness: s.toolHarness,
              usageExamples: s.usageExamples.trim() || null,
              iconSha256: s.iconSha256,
              iconEmoji: s.iconSha256 ? null : s.iconEmoji.trim() || null,
            },
          })),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Submit failed (HTTP ${r.status})`);
      setResult(j as ImportSubmitResult);
      setImportId((j as ImportSubmitResult).importId);
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  /** Fix and resubmit (§64.6): only the failed skills, each showing its error, not yet opened. */
  function fixAndResubmit() {
    if (!result) return;
    const failed = new Map(result.results.filter((r) => r.outcome === "failed").map((r) => [r.subdir ?? "", r.error ?? "Failed"]));
    const keep = steps.filter((s) => failed.has(s.subdir ?? "")).map((s, i) => ({ ...s, opened: i === 0, submitError: failed.get(s.subdir ?? "") ?? null }));
    setTicked(new Set(keep.map((s) => s.path)));
    setSteps(keep);
    setCurrent(0);
    setResult(null);
  }

  function done() {
    setWizardOpen(false);
    setResult(null);
    setSteps([]);
    setTicked(new Set());
    setScan(null);
    setScanKey(null);
    setImportId(null);
    queue.current = null;
  }

  const step = steps[current];
  const lastStep = current === steps.length - 1;
  const submittable = canSubmit(steps, categoryOptions);
  const tickedCount = ticked.size;

  return (
    <>
      <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {tabs}
        <div>
          <label style={label}>Repository</label>
          <input className="input input-lg input-mono" style={{ width: "100%" }} data-testid="import-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/skills.git" />
          {hubUrl && <p className="field-error" role="alert">skills-hub.ai has one skill per page. Propose it from the propose form.</p>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
          <div>
            <label style={label}>Ref</label>
            <input className="input input-lg input-mono" style={{ width: "100%" }} data-testid="import-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" />
            {refMissing && (
              <p className="field-error" role="alert">
                {refTrim} isn’t a branch or tag in this repo. Pick one that exists
                {allRefs.slice(0, 6).map((r) => (
                  <button key={r} type="button" className="btn btn-ghost btn-sm mono" onClick={() => setRef(r)}>{r}</button>
                ))}
              </p>
            )}
          </div>
          <div>
            <label style={label}>Folder <span style={hint}>· optional</span></label>
            <input className="input input-lg input-mono" style={{ width: "100%" }} data-testid="import-folder" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="skills/" />
          </div>
        </div>
        <div>
          <button className="btn" data-testid="import-scan" disabled={scanning || !url.trim() || !refTrim || hubUrl} onClick={() => void runScan()}>
            {scanning ? "Scanning…" : scan ? "Scan again" : "Scan"}
          </button>
          {staleScan && <span className="muted" style={{ fontSize: 12.5, marginLeft: 10 }}>The repository, ref or folder changed. Scan again to use it.</span>}
          {scanErr && <p className="field-error" role="alert">{scanErr}</p>}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
          <div>
            <label style={label}>Namespace <span style={hint}>· for every skill in this import</span></label>
            <select className="input input-lg input-mono" style={{ width: "100%" }} data-testid="import-namespace" value={namespaceSlug} onChange={(e) => setNamespaceSlug(e.target.value)}>
              {namespaces.map((n) => (
                <option key={n.slug} value={n.slug}>{n.slug} — {n.displayName}</option>
              ))}
            </select>
            <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>
              {visibility === "org" ? <><span className="mono">global</span> — org-wide, visible to everyone.</> : <>Restricted to <span className="mono">{namespaceSlug}</span> — visible only to its members{effectiveShared.length ? " and the namespaces it is shared with" : ""}.</>}
            </p>
          </div>
          <div>
            <label style={label}>Tool / harness <span style={hint}>· default for each skill</span></label>
            <ToolHarnessPicker value={toolDefault} onChange={setToolDefault} className="input input-lg input-mono" style={{ width: "100%" }} />
          </div>
        </div>
        {visibility === "namespace" && (
          <div>
            <label style={label}>Share with namespaces <span style={hint}>· optional</span></label>
            <NamespaceMultiPicker value={effectiveShared} onChange={setSharedNs} options={shareTargets} exclude={ownerNamespaceId ? [ownerNamespaceId] : []} />
          </div>
        )}
        {ai.available && (
          <div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
              <input type="checkbox" data-testid="import-draft-ai" checked={useAi} disabled={ai.remainingToday <= 0} onChange={(e) => setUseAi(e.target.checked)} />
              Draft with {aiName} ({ai.remainingToday} draft{ai.remainingToday === 1 ? "" : "s"} left today)
            </label>
            <p className="muted" style={{ fontSize: 12, margin: "6px 0 0 24px" }}>
              {ai.remainingToday <= 0
                ? capMessage(aiName, capAt, fmt.dateTime)
                : "Clicking Next sends each ticked skill's SKILL.md to the AI provider to draft its description, usage and categories."}
            </p>
          </div>
        )}
        {aiGone && <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>AI drafting is no longer available.</p>}
      </div>

      {scan && (
        <div className="card" style={{ marginTop: 16, padding: 0 }} data-testid="import-list">
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
            <strong>{scan.total} skill{scan.total === 1 ? "" : "s"} found</strong>
            <span className="muted" style={{ fontSize: 12.5 }}>{tickedCount} ticked · up to {IMPORT_MAX_SKILLS}</span>
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} data-testid="import-tick-all" onClick={() => setTicked(new Set(tickAllImportable(rows)))}>
              Tick all importable
            </button>
          </div>
          {scan.total > scan.shown && (
            <p className="muted" style={{ fontSize: 12.5, padding: "8px 16px", margin: 0 }}>Showing the first {scan.shown} of {scan.total}. Narrow it with a folder.</p>
          )}
          {rows.length === 0 && <p className="muted" style={{ padding: 16, margin: 0 }}>No SKILL.md files found in this repository at {scanKey?.split("|")[1]}.</p>}
          <div className="rows">
            {rows.map((r) => {
              const isTicked = ticked.has(r.path);
              const blockedBy = blockers.get(r.path);
              const atCap = !isTicked && tickedCount >= IMPORT_MAX_SKILLS;
              const disabled = !r.importable || !!blockedBy || atCap || staleScan;
              const why = !r.importable && r.reason ? importReasonText(r.reason, { name: r.name, match: r.match }) : blockedBy ? `Same name as ${blockedBy}` : atCap ? "An import holds up to 50 skills. Submit these, then import the rest." : null;
              return (
                <label key={r.path} className="row" data-testid={`import-row-${r.path}`} style={{ alignItems: "flex-start", gap: 12, cursor: disabled ? "default" : "pointer", opacity: !r.importable ? 0.7 : 1 }}>
                  <input type="checkbox" checked={isTicked} disabled={disabled && !isTicked} onChange={(e) => toggle(r.path, e.target.checked)} style={{ marginTop: 4 }} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                      <span className="mono" style={{ fontSize: 13 }}>{where(r)}</span>
                      {r.name && <strong style={{ fontSize: 14 }}>{r.name}</strong>}
                      <span className="muted mono" style={{ fontSize: 11, marginLeft: "auto" }}>
                        {r.lastChangedAt ? `changed ${fmt.date(r.lastChangedAt)}` : r.lastChangedBefore ? `before ${fmt.date(r.lastChangedBefore)}` : "—"}
                      </span>
                    </div>
                    {r.description && <p className="muted" style={{ fontSize: 13, margin: "4px 0 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.description.split("\n")[0]}</p>}
                    {why && (
                      <p style={{ fontSize: 12.5, margin: "4px 0 0" }}>
                        {r.reason === "exists" && r.match ? (
                          <>Already in skilly as <Link href={`/skills/${encodeURIComponent(r.match.ns)}/${encodeURIComponent(r.match.slug)}`}>{r.match.ns}/{r.match.slug}</Link>{r.match.sameSource ? ", imported from this folder" : ""}</>
                        ) : why}
                      </p>
                    )}
                    {r.nestedIn !== undefined && (
                      <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 0" }}>
                        Inside {r.nestedIn || "(repo root)"}. Importing {r.nestedIn || "(repo root)"} also brings this folder’s files.
                      </p>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
          <div style={{ padding: "12px 16px", borderTop: "1px solid var(--line)" }}>
            <button className="btn btn-primary" data-testid="import-next" disabled={!tickedCount || !namespaceSlug || refMissing || staleScan} onClick={openWizard}>
              Next →
            </button>
          </div>
        </div>
      )}

      {wizardOpen && step && (
        <Modal
          title={result ? "Import submitted" : `Skill ${current + 1} of ${steps.length} · ${where(step)}`}
          onCancel={() => (result ? done() : setWizardOpen(false))}
          wide
          testId="import-wizard"
          footer={
            result ? (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {result.results.some((r) => r.outcome === "failed") && (
                  <button className="btn btn-primary" data-testid="import-fix-resubmit" onClick={fixAndResubmit}>Fix and resubmit</button>
                )}
                <button className="btn" data-testid="import-done" onClick={done}>Done</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", width: "100%" }}>
                <button className="btn btn-ghost" data-testid="import-step-remove" onClick={() => removeStep(step.path)}>Remove from proposal</button>
                <span style={{ marginLeft: "auto" }} />
                <button className="btn" data-testid="import-step-prev" disabled={current === 0} onClick={() => go(current - 1)}>← Previous</button>
                {!lastStep && (
                  <button className="btn btn-primary" data-testid="import-step-next" disabled={isDrafting(step)} onClick={next}>Next →</button>
                )}
                {lastStep && (
                  <>
                    {directAllowed && (
                      <button className="btn" data-testid="import-publish" disabled={busy || !submittable} onClick={() => { if (!stepErrors(step, categoryOptions).length) void submit("direct"); else setStepErr(stepErrors(step, categoryOptions)); }}>
                        Publish directly
                      </button>
                    )}
                    <button className="btn btn-primary" data-testid="import-submit" disabled={busy || !submittable} onClick={() => { const errs = stepErrors(step, categoryOptions); if (errs.length) setStepErr(errs); else void submit("review"); }}>
                      {busy ? "Submitting…" : "Submit for review →"}
                    </button>
                  </>
                )}
              </div>
            )
          }
        >
          {result ? (
            <ImportResultView result={result} namespaceSlug={namespaceSlug} steps={steps} />
          ) : (
            <>
              <ol className="mono" style={{ display: "flex", flexWrap: "wrap", gap: 6, listStyle: "none", padding: 0, margin: "0 0 14px" }} data-testid="import-strip">
                {steps.map((s, i) => {
                  const st = stepState(steps, i, current, categoryOptions);
                  return (
                    <li key={s.path}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={!canJumpTo(steps, i) || i === current}
                        aria-current={i === current ? "step" : undefined}
                        title={`${where(s)} — ${st === "not_opened" ? "not yet opened" : st === "needs_attention" ? "needs attention" : st}`}
                        onClick={() => go(i)}
                        style={{ opacity: st === "not_opened" ? 0.55 : 1, borderColor: st === "current" ? "var(--accent)" : st === "needs_attention" ? "var(--danger, #c0392b)" : undefined }}
                      >
                        {st === "done" ? "✓ " : ""}{s.skillSlug}
                      </button>
                    </li>
                  );
                })}
              </ol>
              <WizardStepForm
                key={step.path}
                step={step}
                lastChanged={rows.find((r) => r.path === step.path)?.lastChangedAt ?? null}
                categoryOptions={categoryOptions}
                onChange={(fn) => patchStep(step.path, fn)}
                ai={ai}
                aiGone={aiGone}
                aiName={aiName}
                capAt={capAt}
                onDraft={() => startStepDraft(step)}
                onCancelDraft={() => cancelStepDraft(step)}
              />
              {stepErr && (
                <ul className="field-error" role="alert" style={{ marginTop: 12 }}>
                  {stepErr.map((e) => <li key={e}>{e}</li>)}
                </ul>
              )}
              {lastStep && !submittable && !stepErr && (
                <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>Submit is enabled once every skill has been opened and passes its checks.</p>
              )}
              {submitErr && <p className="field-error" role="alert" style={{ marginTop: 12 }}>{submitErr}</p>}
            </>
          )}
        </Modal>
      )}
      {draftConfirm && (
        <Modal
          title="Replace your text?"
          onCancel={() => setDraftConfirm(null)}
          testId="import-draft-confirm"
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setDraftConfirm(null)}>Cancel</button>
              <button type="button" className="btn" onClick={() => requestStepDraft(draftConfirm.path, "empty")}>Fill empty fields only</button>
              <button type="button" className="btn btn-primary" onClick={() => requestStepDraft(draftConfirm.path, "replace")}>Replace</button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            {draftConfirm.fields.join(" and ")} already {draftConfirm.fields.length > 1 ? "have" : "has"} text you typed. The {aiName} draft can replace it,
            or fill only the empty fields. Suggested categories are added to the ones you picked either way.
          </p>
        </Modal>
      )}
    </>
  );
}

/** The §43.6 daily-cap line, with the time drafting opens again when the server gave one. */
function capMessage(aiName: string, capAt: string | null, dateTime: (iso: string) => string): string {
  return `Daily ${aiName} draft limit reached (50 in 24 hours)${capAt ? ` — you can draft again after ${dateTime(capAt)}.` : "."}`;
}

function WizardStepForm({
  step,
  lastChanged,
  categoryOptions,
  onChange,
  ai,
  aiGone,
  aiName,
  capAt,
  onDraft,
  onCancelDraft,
}: {
  step: WizardStep;
  lastChanged: string | null;
  categoryOptions: { name: string; slug: string }[];
  onChange: (fn: (s: WizardStep) => WizardStep) => void;
  ai: AiState;
  aiGone: boolean;
  aiName: string;
  capAt: string | null;
  onDraft: () => void;
  onCancelDraft: () => void;
}) {
  const fmt = useDateFmt();
  const drafting = isDrafting(step);
  const capped = ai.remainingToday <= 0;
  // What the step's last draft left to say: a background draft's outcome, or a clicked one's failure.
  const draftNote =
    drafting ? null
    : step.draft === "capped" && !step.draftClicked ? "Not drafted: daily AI draft limit reached. The SKILL.md values are filled in."
    : step.draft === "failed" && !step.draftClicked ? "Couldn’t draft this one. The SKILL.md values are filled in."
    : null;
  const draftError = !drafting && step.draft === "failed" && step.draftClicked ? step.draftMessage ?? "Couldn’t draft right now — try again or write it yourself." : null;
  const iconInput = useRef<HTMLInputElement>(null);
  const [iconErr, setIconErr] = useState<string | null>(null);
  // The framed 256×256 PNG uploads as soon as it's applied, so the step keeps only its hash.
  const iconCrop = useIconCropFlow(async (render) => {
    const form = new FormData();
    form.append("icon", render.blob, "icon.png");
    const r = await fetch("/api/icons", { method: "POST", body: form });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? "Could not upload the icon");
    // Only a real content hash ever reaches the preview's <img src>.
    if (typeof j.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(j.sha256)) throw new Error("Could not upload the icon");
    onChange((s) => ({ ...s, iconSha256: j.sha256, iconEmoji: "" }));
    setIconErr(null);
  });
  const set = (k: "title" | "semver") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    onChange((s) => ({ ...s, [k]: v }));
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {step.submitError && <p className="field-error" role="alert" data-testid="import-step-error">{step.submitError}</p>}
      {lastChanged && <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Last changed {fmt.date(lastChanged)}.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        <div>
          <label style={label}>Skill slug <span style={hint}>· the SKILL.md name, locked</span></label>
          <input className="input input-lg input-mono" style={{ width: "100%", opacity: 0.6 }} value={step.skillSlug} disabled readOnly />
        </div>
        <div>
          <label style={label}>Title</label>
          <input className="input input-lg" style={{ width: "100%" }} data-testid="import-step-title" value={step.title} onChange={set("title")} />
        </div>
      </div>
      <div>
        <label style={label}>Icon <span style={hint}>· optional; an icon in the skill’s own files wins</span></label>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {step.iconSha256 && /^[0-9a-f]{64}$/.test(step.iconSha256) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/skill-icons/${step.iconSha256}.png`} alt="" width={40} height={40} style={{ borderRadius: 8 }} />
          ) : step.iconEmoji ? (
            <span style={{ fontSize: 28 }}>{step.iconEmoji}</span>
          ) : null}
          <button type="button" className="filepick-btn" disabled={iconCrop.busy} onClick={() => iconInput.current?.click()}>Upload image…</button>
          <input ref={iconInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; void iconCrop.pick(file); }} />
          <EmojiPicker align="left" triggerLabel="Choose emoji…" disabled={iconCrop.busy} onPick={(em) => { iconCrop.clear(); onChange((s) => ({ ...s, iconEmoji: em, iconSha256: null })); }} />
          {(step.iconSha256 || step.iconEmoji) && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { iconCrop.clear(); onChange((s) => ({ ...s, iconEmoji: "", iconSha256: null })); }}>Remove</button>
          )}
        </div>
        {(iconCrop.error || iconErr) && <p role="alert" className="field-error">{iconCrop.error ?? iconErr}</p>}
        {iconCrop.dialog}
      </div>
      {/* §64.4: the step's own Draft button, directly above Categories as on the propose form. */}
      {(ai.available || aiGone || drafting || step.undoable || draftNote) && (
        <div className="ai-draft-row" data-testid="import-step-ai">
          {ai.available && (
            <button type="button" className="btn btn-sm" data-testid="import-step-draft" disabled={drafting || capped} onClick={onDraft}>
              {drafting ? "Drafting…" : `Draft with ${aiName}`}
            </button>
          )}
          {drafting && (
            <button type="button" className="btn btn-ghost btn-sm" data-testid="import-step-draft-cancel" onClick={onCancelDraft}>
              {step.draftClicked ? "Cancel" : "Fill it in myself"}
            </button>
          )}
          {!drafting && step.undoable && (
            <button type="button" className="btn btn-ghost btn-sm" data-testid="import-step-undo" onClick={() => onChange(undoDraft)}>Undo</button>
          )}
          {ai.available ? (
            <span className="muted ai-draft-help">
              {capped
                ? capMessage(aiName, capAt, fmt.dateTime)
                : `Drafts the description, usage and categories from the SKILL.md. ${ai.remainingToday} draft${ai.remainingToday === 1 ? "" : "s"} left today.`}
            </span>
          ) : aiGone ? (
            <span className="muted ai-draft-help">AI drafting is no longer available.</span>
          ) : null}
          {draftNote && <p className="muted" style={{ flexBasis: "100%", fontSize: 12.5, margin: 0 }}>{draftNote}</p>}
          {draftError && <p role="alert" className="field-error" style={{ flexBasis: "100%", margin: 0 }}>{draftError}</p>}
        </div>
      )}
      <div inert={drafting} className={drafting ? "ai-draft-busy" : undefined}>
        <label style={label}>Categories</label>
        <TagInput value={step.categories} onChange={(v) => onChange((s) => ({ ...s, categories: v }))} suggestions={categoryOptions.map((c) => c.name)} placeholder="Search or create categories…" />
      </div>
      <div inert={drafting} className={drafting ? "ai-draft-busy" : undefined}>
        <label style={label}>Description <span style={hint}>· Markdown</span></label>
        <MarkdownField value={step.description} onChange={(v) => onChange((s) => ({ ...s, description: v, undoable: false }))} rows={3} className="input input-lg" placeholder="What does this skill do?" />
      </div>
      <div inert={drafting} className={drafting ? "ai-draft-busy" : undefined}>
        <label style={label}>Usage <span style={hint}>· how it's triggered, options (Markdown)</span></label>
        <MarkdownField value={step.usageExamples} onChange={(v) => onChange((s) => ({ ...s, usageExamples: v, undoable: false }))} rows={4} mono className="input input-lg" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        <div>
          <label style={label}>Tool / harness</label>
          <ToolHarnessPicker value={step.toolHarness} onChange={(slug) => onChange((s) => ({ ...s, toolHarness: slug }))} className="input input-lg input-mono" style={{ width: "100%" }} />
        </div>
        <div>
          <label style={label}>Version</label>
          <input className="input input-lg input-mono" style={{ width: "100%" }} data-testid="import-step-semver" value={step.semver} onChange={set("semver")} />
        </div>
      </div>
    </div>
  );
}

function ImportResultView({ result, namespaceSlug, steps }: { result: ImportSubmitResult; namespaceSlug: string; steps: WizardStep[] }) {
  const titleOf = (slug: string) => steps.find((s) => s.skillSlug === slug)?.title ?? slug;
  const routedLabel = (r: string | undefined) => (r === "policy" ? "policy rule" : r === "scan_pending" ? "scan pending" : "content risk");
  return (
    <div data-testid="import-result" style={{ display: "grid", gap: 8 }}>
      {result.results.map((r) => (
        <div key={`${r.subdir ?? ""}|${r.slug}`} className="row" style={{ alignItems: "baseline", gap: 10 }}>
          <Pill tone={r.outcome === "failed" ? "danger" : r.outcome === "routed" ? "warn" : "ok"}>
            {r.outcome === "proposed" ? "Proposed" : r.outcome === "published" ? "Published" : r.outcome === "routed" ? "Sent to review" : "Failed"}
          </Pill>
          <strong>{titleOf(r.slug)}</strong>
          <span className="mono muted" style={{ fontSize: 12 }}>{r.subdir ?? "(repo root)"}</span>
          <span style={{ marginLeft: "auto", fontSize: 13 }}>
            {r.proposalId ? (
              <Link href={`/proposals/${encodeURIComponent(r.proposalId)}`}>{r.outcome === "routed" ? `Sent to review: ${routedLabel(r.routedReason)}` : "View the proposal"}</Link>
            ) : r.outcome === "published" ? (
              <Link href={`/skills/${encodeURIComponent(namespaceSlug)}/${encodeURIComponent(r.slug)}`}>View the skill (publishing…)</Link>
            ) : (
              <span className="field-error" style={{ margin: 0 }}>{r.error}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
