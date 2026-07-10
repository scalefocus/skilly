"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
// Subpath imports: the root barrel pulls node:crypto (tokens.ts), which can't ship to the
// client bundle. Both modules are pure.
import { parseInstallCommand } from "@skilly/shared/external-tool";
import { isAgentSlug, GENERIC_AGENT } from "@skilly/shared/agents";
import { isSkillsHubUrl, validateSkillsHubRef } from "@skilly/shared/skills-hub";
import { Pill, ScrollToTop } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { TagInput } from "../../components/TagInput";
import { MarkdownField } from "../../components/MarkdownField";
import { ToolHarnessPicker } from "../../components/ToolHarnessPicker";

// Defined at MODULE scope (stable identity). Previously these lived inside the component, so
// every keystroke created a new `Row` component type and React remounted the inputs — which
// stole focus on each character. Hoisting them fixes that.
const field = { width: "100%", padding: "10px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 14 } as const;
const label = { display: "block", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 7 } as const;
// Two-up on desktop, but auto-collapses to a single stacked column on narrow/mobile viewports
// (each field keeps a sane min width) — fixes the external-URL / pinned-tag misalignment. §10.
const lockedStyle = { opacity: 0.6, cursor: "not-allowed" } as const;
// Accepted bundle extensions — kept in sync with the file input's `accept`.
const BUNDLE_EXTS = [".tar.gz", ".tgz", ".gz", ".tar", ".zip", ".skill"];
const isBundleFile = (name: string) => BUNDLE_EXTS.some((ext) => name.toLowerCase().endsWith(ext));
/** Human-readable size ("100 KB" / "50 MB" / "1 GB") for the upload limit + over-limit message. */
const fmtSize = (bytes: number) =>
  bytes >= 1024 * 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024 * 1024))} GB`
    : bytes >= 1024 * 1024
      ? `${Math.round(bytes / (1024 * 1024))} MB`
      : `${Math.round(bytes / 1024)} KB`;
/** Derive a skill slug from an uploaded bundle's filename: drop the bundle extension, then
 *  slugify (lowercase, separators → '-', strip the rest) — "Case Study Creator.skill" → "case-study-creator". */
const slugFromFilename = (name: string): string => {
  let base = name;
  for (const ext of BUNDLE_EXTS) if (base.toLowerCase().endsWith(ext)) { base = base.slice(0, -ext.length); break; }
  return base.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
};

// Rotating placeholder examples for the install-command paste box — each is a form the parser
// actually handles, so the animation doubles as documentation of what's accepted.
const PASTE_EXAMPLES = [
  "npx skills add owner/repo --skill name",
  "npx -y skills add shadcn/improve --skill improve --agent claude-code",
  "npx agent-skills-cli add alirezarezvani/claude-skills",
  "npx skills add https://github.com/anthropics/skills --skill pdf",
  "npx @skills-hub-ai/cli install ui-design-system",
  "https://github.com/owner/repo.git#v1.0.0",
];

/** Suggest the next patch version above the current latest stable (proposer can change it). */
function bumpPatch(v: string | null): string {
  const m = v ? /^(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "1.0.0";
}

/** Turn a kebab/snake slug into a title: separators → spaces, each word capitalized
 *  ("case-study-creator" → "Case Study Creator"). */
function titleize(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function ProposeForm() {
  const router = useRouter();
  const params = useSearchParams();
  // New-version mode: pre-fill from an existing skill and LOCK the identity/access surface only —
  // slug, visibility (namespace-derived), and delivery type. Title, description, categories, tags,
  // tool/harness, usage, and the semver are all editable (synced to the skill on accept, §8); the
  // source is optional (default "Keep current files"). It's entered either by URL
  // (?newVersion=1&ns=&slug=) OR in-place when a duplicate is detected and the user accepts the
  // redirect (carry-over): `forcedNV` keeps the already-entered source (the staged bundle /
  // pointer fields) so they don't re-do it.
  const [forcedNV, setForcedNV] = useState<{ ns: string; slug: string } | null>(null);
  const nvNs = forcedNV?.ns ?? params.get("ns");
  const nvSlug = forcedNV?.slug ?? params.get("slug");
  const isNewVersion = !!forcedNV || (params.get("newVersion") === "1" && !!nvNs && !!nvSlug);

  // "Request a skill" (§26): the page-top toggle flips between "I have a skill" (the normal
  // propose flow) and "I want a skill" (post a request: title/categories/description/usage/tool
  // Never shown in new-version mode. Requests are text-only (§26) — no file uploads.
  const [mode, setMode] = useState<"have" | "want">("have");
  // Advisory similar-match (soft-warn): shown once before posting; the next click posts anyway.
  const [reqSimilar, setReqSimilar] = useState<{ openRequest: { id: string; title: string } | null; catalogSkill: { namespaceSlug: string; skillSlug: string; title: string } | null } | null>(null);
  const [reqAck, setReqAck] = useState(false);
  // Fulfilment link (§26): arriving via a request's "Propose a skill" button pre-fills the form
  // and carries the request id through submission.
  const fromRequest = params.get("fromRequest");
  const [originRequestId, setOriginRequestId] = useState<string | null>(null);
  useEffect(() => {
    if (!fromRequest || isNewVersion) return;
    fetch(`/api/requests/${fromRequest}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { request?: { id: string; title: string; description: string; usageExamples: string | null; toolHarness: string; categories: string[]; state: string } } | null) => {
        const rq = j?.request;
        if (!rq || rq.state !== "open") return;
        setOriginRequestId(rq.id);
        const slug = rq.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
        setF((prev) => ({
          ...prev,
          title: rq.title,
          description: rq.description,
          usageExamples: rq.usageExamples ?? "",
          toolHarness: rq.toolHarness,
          skillSlug: prev.skillSlug || slug,
        }));
        setCategories(rq.categories);
      })
      .catch(() => { /* prefill is best-effort */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromRequest, isNewVersion]);

  const [f, setF] = useState({
    namespaceSlug: "global",
    skillSlug: "",
    title: "",
    description: "",
    usageExamples: "",
    toolHarness: "generic", // least-presumptuous default; proposers pick or type the real one

    semver: "1.0.0",
    externalUrl: "",
    externalRef: "",
    externalSubdir: "",
  });
  const [categories, setCategories] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  // Namespaces the user can file into (global + their namespaces) — feeds the namespace combobox.
  const [namespaceOptions, setNamespaceOptions] = useState<{ slug: string; displayName: string }[]>([]);
  // Pointer (external git) is the first tab and the default for a NEW proposal; new-version mode
  // overrides this from the existing skill's type once it loads.
  const [sourceType, setSourceType] = useState<"hosted" | "pointer">("pointer");
  const [file, setFile] = useState<File | null>(null);
  // Admin-configured max hosted-bundle size (bytes); shown below the upload box and enforced
  // client-side before upload (the server re-enforces). Default 200 MB until /api/me loads.
  const [maxBundleBytes, setMaxBundleBytes] = useState(200 * 1024 * 1024);
  // §26: any edit to the request fields invalidates a prior similar-check acknowledgement, so
  // "Post anyway" can never post a changed request that was never checked against the catalog.
  // Clearing reqSimilar also retires the now-stale similar-match banner.
  useEffect(() => {
    setReqAck(false);
    setReqSimilar(null);
  }, [f.title, f.description, f.usageExamples, f.toolHarness, categories]);
  // Drag-and-drop bundle: a file dropped ANYWHERE on the page lands in the upload box. `dragOver`
  // drives a full-page overlay; the latest drop logic lives in a ref so the window listeners
  // (bound once) never go stale.
  const [dragOver, setDragOver] = useState(false);
  const [dropErr, setDropErr] = useState<string | null>(null);
  const dragStateRef = useRef<{ canDrop: boolean; accept: (f: File | null) => void }>({ canDrop: false, accept: () => {} });
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState<{ severity: string; findings: unknown[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // On a submit issue we smooth-scroll to the error banner and pulse-highlight it. `key` bumps so
  // re-submitting the same issue re-triggers the animation.
  const errRef = useRef<HTMLDivElement>(null);
  // The duplicate "propose a new version instead" banner — scrolled to + pulsed on a blocked
  // submit so the user can't miss that they must re-version rather than re-propose.
  const dupRef = useRef<HTMLDivElement>(null);
  const pasteRef = useRef<HTMLInputElement>(null);
  const [flash, setFlash] = useState<{ key: number; target: "err" | "dup" } | null>(null);
  useEffect(() => {
    if (!flash) return;
    const el = (flash.target === "dup" ? dupRef : errRef).current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("field-flash");
    // Force reflow so the class re-adds even when the same element flashed a moment ago.
    void el.offsetWidth;
    el.classList.add("field-flash");
    const t = setTimeout(() => el.classList.remove("field-flash"), 1300);
    return () => clearTimeout(t);
  }, [flash]);
  const flashIssue = () => setFlash((p) => ({ key: (p?.key ?? 0) + 1, target: "err" }));
  const flashDup = () => setFlash((p) => ({ key: (p?.key ?? 0) + 1, target: "dup" }));
  // Paste-to-fill accelerator: an `npx skills add …` command parsed into the pointer fields. §8
  const [pasteCmd, setPasteCmd] = useState("");
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  // Typewriter placeholder: while the box is empty, cycle through accepted example commands —
  // type one out, hold, erase, advance. Pauses entirely once the user has typed/pasted.
  const [phText, setPhText] = useState(PASTE_EXAMPLES[0]!);
  useEffect(() => {
    if (pasteCmd) return; // user has content — keep the placeholder still
    let ex = 0, char = 0, deleting = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const full = PASTE_EXAMPLES[ex]!;
      char += deleting ? -1 : 1;
      setPhText(full.slice(0, char));
      if (!deleting && char === full.length) {
        deleting = true;
        timer = setTimeout(tick, 2000); // hold the full command
      } else if (deleting && char === 0) {
        deleting = false;
        ex = (ex + 1) % PASTE_EXAMPLES.length;
        timer = setTimeout(tick, 450);
      } else {
        timer = setTimeout(tick, deleting ? 18 : 42);
      }
    };
    timer = setTimeout(tick, 700);
    return () => clearTimeout(timer);
  }, [pasteCmd]);
  // The pinned ref's default is SOURCE-AWARE (§8): a git origin defaults to `main` (the
  // conventional default branch — the common case for a repo that publishes no version tags);
  // a skills-hub origin has no branches, so it defaults to the registry's LATEST VERSION once
  // the ref pre-check below resolves it. A manual edit or a pasted ref takes over, and clearing
  // the field hands control back to the default. If the default doesn't exist upstream the form
  // warns to pick a real ref (the refMissingUpstream block below). §6.
  const [refAuto, setRefAuto] = useState(true);

  // Pointer ref pre-check: when an external git URL is entered, fetch the repo's branches/tags so
  // we can warn (with a quick-pick) if the pinned ref doesn't exist upstream — the #1 cause of a
  // mirror dead-lettering. Debounced; keyed to the URL it was fetched for. §6.
  type RefsResult = { ok: true; branches: string[]; tags: string[]; latest?: string } | { ok: false; error: string };
  const [refProbe, setRefProbe] = useState<{ url: string; result: RefsResult } | null>(null);
  const [refProbing, setRefProbing] = useState(false);
  // skills-hub origin? The "refs" are registry versions (no branches, no `main`) — §6/§8.
  const hubSource = sourceType === "pointer" && isSkillsHubUrl(f.externalUrl.trim());
  const hubLatest = hubSource && refProbe && refProbe.url === f.externalUrl.trim() && refProbe.result.ok ? refProbe.result.latest ?? "" : "";
  useEffect(() => {
    if (!refAuto) return;
    const def = hubSource ? hubLatest : "main"; // hub default is empty until the probe resolves
    setF((prev) => (prev.externalRef === def ? prev : { ...prev, externalRef: def }));
  }, [refAuto, hubSource, hubLatest]);
  useEffect(() => {
    if (sourceType !== "pointer") return;
    const url = f.externalUrl.trim();
    if (!url) { setRefProbe(null); setRefProbing(false); return; }
    let live = true;
    setRefProbing(true);
    const t = setTimeout(() => {
      fetch(`/api/pointer/refs?url=${encodeURIComponent(url)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: RefsResult | null) => { if (live && j) setRefProbe({ url, result: j }); })
        .catch(() => {})
        .finally(() => { if (live) setRefProbing(false); });
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [f.externalUrl, sourceType]);
  // Slug-collision hint: when proposing a NEW skill whose namespace/slug already exists (and is
  // visible to the caller — the detail endpoint 404s otherwise, so nothing restricted leaks),
  // point the user at the new-version flow instead of letting them hit the 409 on submit.
  const [existingSkill, setExistingSkill] = useState<{ ns: string; slug: string } | null>(null);
  // Duplicate match (§8): a DIFFERENT existing skill this new-skill proposal would duplicate — a
  // pointer to the same repo/folder under the same slug, or a byte-identical upload. `block` mode
  // disables submit (the only way forward is "propose a new version"); `warn` is advisory.
  const [dup, setDup] = useState<{ ns: string; slug: string; mode: "block" | "warn" } | null>(null);
  // In new-version mode the form is hidden until pre-fill loads (so we never flash blank defaults).
  const [ready, setReady] = useState(!isNewVersion);
  // Keep current files (§8): default ON in new-version mode when the skill has a latest stable
  // version to reuse — the new version carries its artifact forward byte-for-byte and only the
  // metadata/usage change. Explicitly supplying a source (upload / pointer / paste) switches it off.
  const [reuseFiles, setReuseFiles] = useState(false);
  const [nvLatest, setNvLatest] = useState<string | null>(null);
  // Snapshot of the skill's current metadata at pre-fill, for the client-side §8 no-op guard
  // (with reused files, at least one field must differ; the server re-enforces with a 422).
  const nvBaseline = useRef<{ title: string; description: string; toolHarness: string; tags: string[]; categories: string[]; usageExamples: string } | null>(null);

  // Carry-over: turn the current draft into a NEW-VERSION proposal of the matched skill, keeping
  // the source the proposer already provided (staged bundle / pointer fields). Pre-fill + lock are
  // driven by the new-version effect once `forcedNV` is set.
  function enterNewVersion(ns: string, slug: string) {
    setDup(null);
    setErr(null);
    setRefAuto(true);
    setForcedNV({ ns, slug });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // On opening the propose form, put the cursor in the "paste an install command" field.
  useEffect(() => {
    if (ready) pasteRef.current?.focus();
  }, [ready]);

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setCategoryOptions(j.categories ?? []))
      .catch(() => {});
    fetch("/api/namespaces")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.namespaces?.length && setNamespaceOptions(j.namespaces))
      .catch(() => {});
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (typeof j?.maxBundleBytes === "number") setMaxBundleBytes(j.maxBundleBytes);
      })
      .catch(() => {});
  }, []);

  // Pre-fill from the existing skill when proposing a new version.
  useEffect(() => {
    if (!isNewVersion) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/skills/${nvNs}/${nvSlug}`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? "Could not load the skill");
        if (cancelled) return;
        setF((prev) => ({
          ...prev,
          namespaceSlug: nvNs!,
          skillSlug: nvSlug!,
          title: j.meta?.title ?? "",
          description: j.meta?.description ?? "",
          usageExamples: j.usageExamples ?? "",
          toolHarness: j.meta?.toolHarness ?? prev.toolHarness,
          semver: bumpPatch(j.latest ?? null),
          externalUrl: j.pointer?.originUrl ?? "",
          externalSubdir: j.pointer?.subdir ?? "",
          externalRef: "",
        }));
        setCategories(j.meta?.categories ?? []);
        setTags(j.meta?.tags ?? []);
        setSourceType(j.meta?.type ?? "hosted");
        setNvLatest(j.latest ?? null);
        // Baseline for the §8 no-op guard (reuse mode: at least one field must differ from this).
        nvBaseline.current = {
          title: j.meta?.title ?? "",
          description: j.meta?.description ?? "",
          toolHarness: j.meta?.toolHarness ?? "generic",
          tags: j.meta?.tags ?? [],
          categories: j.meta?.categories ?? [],
          usageExamples: j.usageExamples ?? "",
        };
        // Default to "Keep current files" when there's a stable version to reuse — EXCEPT on a
        // duplicate carry-over (`forcedNV`), where the proposer already provided a fresh source.
        setReuseFiles(!forcedNV && j.latest != null);
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isNewVersion, nvNs, nvSlug]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const lock = isNewVersion; // slug + namespace (→ visibility) + delivery type are locked when re-versioning

  // Debounced existing-slug probe (new-skill mode only).
  useEffect(() => {
    if (lock) return;
    setExistingSkill(null);
    const ns = f.namespaceSlug.trim();
    const slug = f.skillSlug.trim();
    if (!ns || !slug) return;
    const t = setTimeout(() => {
      fetch(`/api/skills/${encodeURIComponent(ns)}/${encodeURIComponent(slug)}`)
        .then((r) => {
          if (r.ok) setExistingSkill({ ns, slug });
        })
        .catch(() => {});
    }, 450);
    return () => clearTimeout(t);
  }, [f.namespaceSlug, f.skillSlug, lock]);

  // Live duplicate pre-check for POINTER sources (§8): the same repo+folder under the same slug
  // already in the catalog (visible to me). Hosted is checked at upload time (in submit). Skipped
  // in new-version mode — that's intentionally targeting an existing skill.
  useEffect(() => {
    if (lock || sourceType !== "pointer") { setDup(null); return; }
    const url = f.externalUrl.trim();
    const slug = f.skillSlug.trim();
    if (!url || !slug) { setDup(null); return; }
    let live = true;
    const t = setTimeout(() => {
      fetch("/api/proposals/duplicate-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, pointer: { url, subdir: f.externalSubdir.trim() || null } }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!live) return;
          if (j?.duplicate) setDup({ ns: j.duplicate.namespaceSlug, slug: j.duplicate.skillSlug, mode: j.enforcement === "warn" ? "warn" : "block" });
          else setDup(null);
        })
        .catch(() => {});
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [f.externalUrl, f.externalSubdir, f.skillSlug, sourceType, lock]);

  // Parse a pasted `npx skills add …` command and fill the pointer fields. The slug is derived
  // from the skill folder ONLY when proposing a NEW skill — in new-version mode it stays locked
  // (a mismatched folder soft-warns below; mirror-time name==slug is the hard gate). §8.
  function applyPaste(raw: string) {
    setPasteCmd(raw);
    setPasteHint(null);
    if (!raw.trim()) {
      setPasteErr(null);
      return;
    }
    const p = parseInstallCommand(raw);
    if (!p.ok) {
      setPasteErr(p.error);
      return;
    }
    setPasteErr(null);
    if (!lock) setSourceType("pointer"); // in new-version mode the source type is fixed
    setReuseFiles(false); // pasting a source = explicitly supplying one → not "Keep current files" (§8)
    // Slug suggestion: the upstream folder's last segment (git), or the registry slug (skills-hub).
    const derived = !lock ? (p.provider === "skills-hub" ? p.hubSlug ?? "" : p.subdir ? p.subdir.split("/").filter(Boolean).pop() ?? "" : "") : "";
    // Title suggestion from the derived slug: dashes → spaces, words capitalized
    // ("social-media-manager" → "Social Media Manager").
    const titleized = titleize(derived);
    if (p.provider === "skills-hub" && !p.ref) {
      setPasteHint("skills-hub skill detected — the version field below pins the registry’s latest; change it there if you want another.");
    }
    // A pasted ref pins the field; without one the default (= proposed version) stays in charge.
    if (p.ref) setRefAuto(false);
    setF((prev) => ({
      ...prev,
      externalUrl: p.url,
      ...(p.ref ? { externalRef: p.ref } : {}),
      externalSubdir: p.subdir ?? "",
      ...(derived ? { skillSlug: derived } : {}),
      ...(titleized ? { title: titleized } : {}),
      // Preselect the tool/harness from a recognized `--agent <slug>` (§8); ignore unknown ones,
      // and never override the locked slug's skill in new-version mode.
      ...(!lock && isAgentSlug(p.agent) ? { toolHarness: p.agent! } : {}),
    }));
  }

  // New-version soft warning: pasted/edited folder looks like a different skill than the locked slug.
  const subdirLast = f.externalSubdir.trim().split("/").filter(Boolean).pop() ?? "";
  const subdirMismatch = lock && sourceType === "pointer" && !!subdirLast && subdirLast !== f.skillSlug;

  // Pointer ref pre-check derivations (only meaningful once the probe matches the current URL).
  const refTrim = f.externalRef.trim();
  const refsForUrl = refProbe && refProbe.url === f.externalUrl.trim() && refProbe.result.ok ? refProbe.result : null;
  const allRemoteRefs = refsForUrl ? [...refsForUrl.tags, ...refsForUrl.branches] : [];
  // Accept the ref OR its v-prefix toggle (matches the mirror's own tolerance).
  const altRef = /^v\d/.test(refTrim) ? refTrim.slice(1) : /^\d/.test(refTrim) ? `v${refTrim}` : null;
  const refFoundUpstream = !!refsForUrl && !!refTrim && (allRemoteRefs.includes(refTrim) || (!!altRef && allRemoteRefs.includes(altRef)));
  const refMissingUpstream = !!refsForUrl && !!refTrim && !refFoundUpstream;
  const refProbeError = refProbe && refProbe.url === f.externalUrl.trim() && !refProbe.result.ok ? refProbe.result.error : null;
  const pickRef = (r: string) => { setRefAuto(false); setF((prev) => ({ ...prev, externalRef: r })); };

  // Page-wide drag-and-drop: a bundle dropped anywhere on the page goes into the upload box.
  // Bound once; reads dragStateRef for the current source-type/lock so it never goes stale.
  // Always preventDefault on dragover/drop so the browser doesn't navigate to a file dropped
  // outside the box; only highlight + accept when a drop is actually actionable.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    let depth = 0;
    const onEnter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth += 1; if (dragStateRef.current.canDrop) setDragOver(true); };
    const onOver = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); };
    const onLeave = (e: DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (depth === 0) setDragOver(false); };
    const onDropWin = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      if (dragStateRef.current.canDrop) dragStateRef.current.accept(e.dataTransfer?.files?.[0] ?? null);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDropWin);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDropWin);
    };
  }, []);

  // Visibility is DERIVED from the namespace — there is no separate toggle. `global` is itself the
  // org-wide namespace, so skills there are org-wide; anything in a specific namespace is
  // restricted to it. (The server still re-validates.)
  const visibility: "org" | "namespace" = f.namespaceSlug.trim().toLowerCase() === "global" ? "org" : "namespace";

  // Accept a dropped/chosen bundle: soft-validate the extension, then stage it.
  function acceptBundle(picked: File | null) {
    if (!picked) return;
    if (!isBundleFile(picked.name)) {
      setDropErr("Unsupported file — use a .tar.gz, .zip, or .skill bundle.");
      return;
    }
    if (picked.size > maxBundleBytes) {
      setDropErr(`This bundle is ${fmtSize(picked.size)} — bigger than the allowed size of ${fmtSize(maxBundleBytes)}.`);
      return;
    }
    setDropErr(null);
    setDup(null); // a new bundle invalidates any prior content-duplicate verdict (re-checked on submit)
    setReuseFiles(false); // attaching a bundle = explicitly supplying a source (§8)
    setFile(picked);
    // Convenience pre-fill (new-skill mode only; never overwrites what's already typed): an empty
    // slug is taken from the filename (extension dropped, slugified), and an empty title from the
    // resulting slug via the same titleize rule as the slug-blur fill.
    if (!lock) {
      setF((prev) => {
        const skillSlug = prev.skillSlug.trim() || slugFromFilename(picked.name);
        const title = prev.title.trim() ? prev.title : titleize(skillSlug);
        return { ...prev, skillSlug, title };
      });
    }
  }

  // Keep the page-wide drop handler current: a drop is actionable as a hosted upload unless this
  // is a locked new-version of a pointer skill (source type can't change). A drop while on the
  // Pointer tab of a NEW skill switches to Hosted and stages the file.
  dragStateRef.current = {
    canDrop: !lock || sourceType === "hosted",
    accept: (picked: File | null) => {
      if (!picked) return;
      if (sourceType !== "hosted") setSourceType("hosted");
      acceptBundle(picked);
    },
  };

  // Upload a hosted bundle, returning the stored key + sha + content digest (and showing the scan
  // result). Also surfaces any content-duplicate the server detected (so submit can gate on it).
  async function uploadBundle(): Promise<{
    artifactObjectKey: string;
    artifactSha256: string;
    contentSha256: string;
    artifactFilename: string | null;
    duplicate: { namespaceSlug: string; skillSlug: string } | null;
    enforcement: "block" | "warn";
  }> {
    if (!file) throw new Error("Attach a SKILL.md bundle (.tar.gz, .zip, or .skill).");
    const fd = new FormData();
    fd.append("bundle", file);
    fd.append("skillSlug", f.skillSlug);
    const up = await fetch("/api/uploads", { method: "POST", body: fd });
    const j = await up.json().catch(() => ({}));
    if (!up.ok) {
      // Tell the user EXACTLY what's wrong. `details` holds the specific validation failures
      // (no top-level SKILL.md, missing/mismatched frontmatter name, disallowed file type, size
      // overflow, …) — lead with those. Otherwise use the server's error string, and only as a
      // last resort a status-coded message. Never a bare generic "validation failed".
      const details = Array.isArray(j.details) ? j.details.filter((d: unknown): d is string => typeof d === "string" && d.length > 0) : [];
      if (details.length) throw new Error(`This bundle didn’t pass validation: ${details.join("; ")}`);
      if (typeof j.error === "string" && j.error) throw new Error(j.error);
      throw new Error(`Upload failed (HTTP ${up.status}).`);
    }
    setScan(j.scan);
    return {
      artifactObjectKey: j.artifactObjectKey,
      artifactSha256: j.artifactSha256,
      contentSha256: j.contentSha256,
      // Prefer the server's recorded name; fall back to the local File name so the version always
      // records what was uploaded (drives the original-extension download, §6/§10).
      artifactFilename: j.artifactFilename ?? file?.name ?? null,
      duplicate: j.duplicate ?? null,
      enforcement: j.duplicateEnforcement === "warn" ? "warn" : "block",
    };
  }

  async function submit(mode: "review" | "direct") {
    setErr(null);
    setScan(null);
    setBusy(true);
    try {
      const metadata = {
        skillSlug: f.skillSlug,
        title: f.title,
        description: f.description,
        categories,
        tags,
        toolHarness: f.toolHarness, // a slug from the closed picker; server validates membership (§8)

        usageExamples: f.usageExamples || null,
        visibility,
      };

      const reusing = isNewVersion && reuseFiles;
      let artifact: { artifactObjectKey?: string; artifactSha256?: string; contentSha256?: string; artifactFilename?: string | null } = {};
      let pointer: { url: string; ref: string; subdir?: string | null } | undefined;
      if (reusing) {
        // Keep current files (§8): no upload, no pointer — the server snapshots the latest stable
        // version's artifact. Client-side no-op guard first (the server re-enforces with a 422):
        // with reused files, at least one field must actually differ.
        const b = nvBaseline.current;
        const norm = (xs: string[], lower = false) => [...new Set(xs.map((x) => (lower ? x.trim().toLowerCase() : x.trim())).filter(Boolean))].sort();
        const setEq = (a: string[], c: string[], lower = false) => {
          const A = norm(a, lower); const C = norm(c, lower);
          return A.length === C.length && A.every((x, i) => x === C[i]);
        };
        if (
          b &&
          f.title.trim() === b.title.trim() &&
          f.description.trim() === b.description.trim() &&
          f.toolHarness.trim() === b.toolHarness.trim() &&
          setEq(tags, b.tags) &&
          setEq(categories, b.categories, true) &&
          f.usageExamples.trim() === b.usageExamples.trim()
        ) {
          throw new Error("Nothing changed — edit at least one field (title, description, categories, tags, tool/harness, or usage), or provide a new source.");
        }
      } else if (sourceType === "hosted") {
        const up = await uploadBundle();
        // Hosted duplicate gate (§8): block stops here and offers "propose a new version"; warn
        // surfaces a notice but proceeds. Never gates a new-version proposal (it's intentional).
        if (up.duplicate && !isNewVersion) {
          setDup({ ns: up.duplicate.namespaceSlug, slug: up.duplicate.skillSlug, mode: up.enforcement });
          if (up.enforcement === "block") { flashDup(); return; }
        }
        artifact = { artifactObjectKey: up.artifactObjectKey, artifactSha256: up.artifactSha256, contentSha256: up.contentSha256, artifactFilename: up.artifactFilename };
      } else {
        if (!f.externalUrl || !f.externalRef) throw new Error(hubSource ? "Provide the skills-hub skill and a pinned registry version (e.g. 1.0.0)." : "Provide the external git URL and a pinned ref (tag/commit).");
        if (hubSource) {
          const hubRefErr = validateSkillsHubRef(f.externalRef);
          if (hubRefErr) throw new Error(hubRefErr);
        }
        pointer = { url: f.externalUrl, ref: f.externalRef, subdir: f.externalSubdir.trim() || null };
      }

      // In new-version mode, target the existing skill so this becomes a new version of it. On
      // accept the skill's title/description/categories/tags/tool-harness are SYNCED to the
      // submitted values (§8) — only the slug and visibility stay frozen.
      const body = {
        namespaceSlug: f.namespaceSlug,
        ...(isNewVersion ? { targetSkillSlug: f.skillSlug } : {}),
        semver: f.semver,
        metadata,
        ...artifact,
        pointer,
        // Keep current files (§8): the server resolves the reuse snapshot itself.
        ...(reusing ? { reuseCurrentFiles: true } : {}),
        // Fulfilment link (§26): accepted proposal → the originating request is fulfilled.
        ...(originRequestId && !isNewVersion ? { originRequestId } : {}),
      };

      if (mode === "review") {
        const r = await fetch("/api/proposals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          // Server-side duplicate backstop (block mode) — surface the redirect-to-new-version UI
          // (scrolled to + pulsed) instead of a plain error, so the next step is unmissable.
          if (r.status === 409 && j.duplicate) {
            setDup({ ns: j.duplicate.namespaceSlug, slug: j.duplicate.skillSlug, mode: "block" });
            flashDup();
            return;
          }
          throw new Error(j.error ?? "Could not create proposal");
        }
        router.push(`/proposals/${j.id}`);
      } else {
        const r = await fetch("/api/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (r.status === 409 && j.duplicate) {
            setDup({ ns: j.duplicate.namespaceSlug, slug: j.duplicate.skillSlug, mode: "block" });
            flashDup();
            return;
          }
          throw new Error(j.error ?? "Could not publish");
        }
        router.push(`/skills/${f.namespaceSlug}/${f.skillSlug}`);
      }
    } catch (e2) {
      setErr(String((e2 as Error).message));
      flashIssue();
    } finally {
      setBusy(false);
    }
  }

  // Post a skill request ("I want a skill", §26). First click runs the advisory similar-check
  // (soft-warn: similar open request / existing catalog skill); if something turns up, a banner
  // shows and the button becomes "Post anyway" — the next click posts regardless.
  async function submitRequest() {
    setErr(null);
    // Validate before locking so an empty field never flashes the read-only scrim.
    if (!f.title.trim()) { setErr("Give the request a title."); flashIssue(); return; }
    if (!f.description.trim()) { setErr("Describe the skill you want."); flashIssue(); return; }
    // §26: the form goes read-only (scrim) while a network call is in flight. `busy` is cleared
    // only when control must return to the user — the similar-check warning branch and errors.
    // On a successful post we intentionally leave it set so the form stays locked through the
    // navigation to the new request (no editable gap).
    setBusy(true);
    try {
      if (!reqAck) {
        const r = await fetch(`/api/requests?similarTo=${encodeURIComponent(f.title.trim())}`);
        const j = r.ok ? ((await r.json()) as { similar?: { openRequest: { id: string; title: string } | null; catalogSkill: { namespaceSlug: string; skillSlug: string; title: string } | null } }) : null;
        if (j?.similar && (j.similar.openRequest || j.similar.catalogSkill)) {
          setReqSimilar(j.similar);
          setReqAck(true);
          setBusy(false); // release the lock so the warning can be read and acted on
          return;
        }
      }
      const fd = new FormData();
      fd.append("title", f.title.trim());
      fd.append("description", f.description);
      fd.append("usageExamples", f.usageExamples);
      fd.append("toolHarness", f.toolHarness);
      fd.append("categories", JSON.stringify(categories));
      const r = await fetch("/api/requests", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Could not post the request");
      router.push(`/requests/${j.id}`);
      // Intentionally leave busy=true: keep the form read-only through the route transition.
    } catch (e2) {
      setBusy(false);
      setErr(String((e2 as Error).message));
      flashIssue();
    }
  }

  if (!ready) {
    return (
      <div className="reveal" style={{ maxWidth: 720 }}>
        <div className="page-head"><div className="eyebrow">Contribute</div><h1 className="page-title">Propose a new version.</h1></div>
        <p className="muted">Loading the current skill…</p>
        {err && <div style={{ color: "var(--danger)", fontSize: 13.5, marginTop: 12 }}>{err}</div>}
      </div>
    );
  }

  return (
    <div className="reveal" style={{ maxWidth: 720 }}>
      {/* Full-page drop target feedback: drag a bundle anywhere on the page to upload it. */}
      {dragOver && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 100, background: "color-mix(in oklab, var(--accent) 14%, transparent)", border: "3px dashed var(--accent)", display: "grid", placeItems: "center", pointerEvents: "none" }}
          aria-hidden
        >
          <div style={{ background: "var(--surface)", color: "var(--ink)", padding: "18px 28px", borderRadius: "var(--radius)", boxShadow: "var(--shadow, 0 10px 40px rgba(0,0,0,.25))", fontFamily: "var(--font-display)", fontSize: 18, display: "flex", alignItems: "center", gap: 12 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            Drop your skill bundle to upload
          </div>
        </div>
      )}
      <div className="page-head">
        <div className="eyebrow">Contribute</div>
        <h1 className="page-title">{lock ? "Propose a new version." : mode === "want" ? "Request a skill." : "Propose a skill."}</h1>
        {lock ? (
          <p className="page-sub">
            New version of <span className="mono">{f.namespaceSlug}/{f.skillSlug}</span>. The slug is locked — everything else (title, description, categories, tags, tool/harness, usage) is editable, and you can keep the current files or provide a fresh source. It enters the normal review/approval flow.
          </p>
        ) : mode === "want" ? (
          <p className="page-sub">Describe the skill you wish existed. Your request appears on the Requested skills page, where anyone can pick it up and build it — you’ll be notified when it’s fulfilled.</p>
        ) : (
          <p className="page-sub">Upload a <span className="mono">SKILL.md</span> bundle, or point at an external git repo. It’s validated and scanned, then enters review — or publishes directly if you’re permitted.</p>
        )}
      </div>

      <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 18, position: "relative" }}>
        {/* §26: read-only scrim while a request is posting. Dims + blocks the whole form; the
            "Working…" button is raised above it (below) so it stays visible as the sole feedback. */}
        {mode === "want" && busy && (
          <div
            aria-hidden
            style={{ position: "absolute", inset: 0, zIndex: 5, borderRadius: "var(--radius)", background: "color-mix(in oklab, var(--surface) 55%, transparent)", backdropFilter: "blur(1.5px)", cursor: "progress" }}
          />
        )}
        {/* "I have / I want" toggle (§26) — new-skill flow only (a new version is always "have"). */}
        {!lock && (
          <div className="sort-toggle" role="group" aria-label="Propose or request" style={{ alignSelf: "flex-start" }}>
            <button type="button" className={`sort-opt${mode === "have" ? " sort-on" : ""}`} aria-pressed={mode === "have"} onClick={() => { setMode("have"); setErr(null); }}>
              I have a skill
            </button>
            <button type="button" className={`sort-opt${mode === "want" ? " sort-on" : ""}`} aria-pressed={mode === "want"} onClick={() => { setMode("want"); setErr(null); setDup(null); }}>
              I want a skill
            </button>
          </div>
        )}
        {/* Source type first: choose hosted vs pointer, with the matching panel directly below it;
            the descriptive metadata (namespace, title, …) follows. Hidden in "I want a skill" mode. */}
        {mode === "have" && (
        <div>
          <label style={label}>Source</label>
          {/* New-version mode: "Keep current files" (§8) is the default — the new version reuses
              the latest stable version's artifact byte-for-byte; only metadata/usage change.
              Switching to the second option reveals the normal source panel below. */}
          {lock && (
            <>
              <div className="sort-toggle" role="group" aria-label="Files for this version">
                <button
                  type="button"
                  className={`sort-opt${reuseFiles ? " sort-on" : ""}`}
                  aria-pressed={reuseFiles}
                  disabled={!nvLatest}
                  title={nvLatest ? undefined : "This skill has no published stable version to reuse"}
                  onClick={() => setReuseFiles(true)}
                >
                  Keep current files{nvLatest ? ` (v${nvLatest})` : ""}
                </button>
                <button
                  type="button"
                  className={`sort-opt${!reuseFiles ? " sort-on" : ""}`}
                  aria-pressed={!reuseFiles}
                  onClick={() => setReuseFiles(false)}
                >
                  {sourceType === "hosted" ? "Upload a new bundle" : "Point at a new ref"}
                </button>
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                {reuseFiles ? (
                  <>The new version reuses <span className="mono">v{nvLatest}</span>’s files byte-for-byte — only the metadata and usage change (the file itself, including its frontmatter, stays as-is). At least one field must differ.</>
                ) : nvLatest ? (
                  <>Provide a fresh source below — the source type is locked to {sourceType === "hosted" ? "a hosted upload" : "an external git pointer"} for a new version.</>
                ) : (
                  <>This skill has no published stable version to reuse — {sourceType === "hosted" ? "upload the bundle" : "provide the pinned ref"} below.</>
                )}
              </p>
            </>
          )}
          {/* Tab strip — the matching panel (upload box / pointer fields) renders immediately
              below. Hidden in new-version mode (the source type is fixed; the toggle above
              already names it). */}
          {!lock && (
            <div className="srctabs" role="tablist" aria-label="Skill source">
              <button
                type="button"
                role="tab"
                aria-selected={sourceType === "pointer"}
                className={`srctab${sourceType === "pointer" ? " active" : ""}`}
                onClick={() => setSourceType("pointer")}
              >
                Pointer (external git)
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sourceType === "hosted"}
                className={`srctab${sourceType === "hosted" ? " active" : ""}`}
                onClick={() => setSourceType("hosted")}
              >
                Hosted upload
              </button>
            </div>
          )}
        </div>
        )}

        {/* Active source panel — directly under its tab. Hidden while "Keep current files" (§8). */}
        {mode === "have" && !(lock && reuseFiles) && (sourceType === "hosted" ? (
          <div>
            <label style={label}>SKILL.md bundle (.tar.gz, .zip, or .skill)</label>
            {/* Drops are handled page-wide (see the window listeners above); this box keeps the
                highlight + the click-to-choose affordance. */}
            <div className={`dropzone${dragOver ? " drag" : ""}`}>
              <svg className="dropzone-ico" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              {file ? (
                <span className="dropzone-file">
                  <span className="mono">{file.name}</span>
                  <button type="button" className="dropzone-clear" onClick={() => { setFile(null); setDropErr(null); }} title="Remove file">✕ remove</button>
                </span>
              ) : (
                <div className="dropzone-lead">Drag &amp; drop your skill bundle here</div>
              )}
              <label className="filepick-btn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
                {file ? "Choose a different file" : "Choose file"}
                <input type="file" accept=".tgz,.gz,.tar,.zip,.skill" onChange={(e) => acceptBundle(e.target.files?.[0] ?? null)} hidden />
              </label>
              {dropErr ? (
                <span style={{ color: "var(--danger)", fontSize: 12 }}>{dropErr}</span>
              ) : (
                <span className="dropzone-hint">.tar.gz · .zip · .skill</span>
              )}
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>Maximum size: {fmtSize(maxBundleBytes)}. Larger bundles are rejected.</p>
          </div>
        ) : (
          <>
            <div>
              <label style={label}>
                Paste an install command <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--faint)" }}>· optional · fills the pointer fields</span>
              </label>
              <input
                ref={pasteRef}
                style={{ ...field, fontFamily: "var(--font-mono)", fontSize: 13, ...(pasteErr ? { border: "1px solid var(--danger)" } : {}) }}
                value={pasteCmd}
                onChange={(e) => applyPaste(e.target.value)}
                placeholder={phText}
                spellCheck={false}
              />
              {pasteErr ? (
                <p style={{ color: "var(--danger)", fontSize: 12, marginTop: 7 }}>{pasteErr}</p>
              ) : pasteHint ? (
                <p style={{ color: "var(--accent-2)", fontSize: 12, marginTop: 7 }}>{pasteHint}</p>
              ) : (
                <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>
                  Accepts most agent-skill install commands (<span className="mono">npx skills add</span>, <span className="mono">agent-skills-cli</span>, …) that name a git repo: a git URL (with <span className="mono">#ref</span>), a GitHub <span className="mono">owner/repo</span>, a <span className="mono">/tree/…</span> link, <span className="mono">--skill &lt;name&gt;</span>, or a skills-hub.ai command. The URL, ref, and skill folder{lock ? "" : " (and slug)"} below are filled from it.
                </p>
              )}
            </div>
            <div><label style={label}>External git URL</label><input style={{ ...field, fontFamily: "var(--font-mono)" }} value={f.externalUrl} onChange={set("externalUrl")} placeholder="https://github.com/anthropics/skills.git" /></div>
            <div>
              <label style={label}>{hubSource ? "Pinned version" : "Pinned ref (branch/tag/commit)"} <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--faint)" }}>{hubSource ? "· registry version · defaults to the latest" : "· defaults to main"}</span></label>
              <input
                style={{ ...field, fontFamily: "var(--font-mono)" }}
                value={f.externalRef}
                onChange={(e) => {
                  const v = e.target.value;
                  setRefAuto(v.trim() === ""); // clearing resumes the source's default
                  setF((prev) => ({ ...prev, externalRef: v }));
                }}
                placeholder={hubSource ? "1.0.0" : "v1.0.0"}
                list="ref-options"
                spellCheck={false}
              />
              {/* Autocomplete of the upstream's real branches/tags (tags first) — fetched by the
                  ref pre-check above, so it works the same whether proposing a new skill or a new
                  version. The user can browse/pick an existing ref instead of guessing. */}
              <datalist id="ref-options">
                {refsForUrl?.tags.map((t) => <option key={`t-${t}`} value={t} />)}
                {refsForUrl?.branches.map((b) => <option key={`b-${b}`} value={b} />)}
              </datalist>
              {refProbing && <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>{hubSource ? "checking the registry’s versions…" : "checking the repository’s refs…"}</p>}
              {refFoundUpstream && <p style={{ color: "var(--ok)", fontSize: 12, marginTop: 6 }}>✓ <span className="mono">{refTrim}</span> exists upstream</p>}
              {refProbeError && !refProbing && <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>couldn’t verify refs: {refProbeError}</p>}
              {refMissingUpstream && (
                <div style={{ marginTop: 8, padding: "10px 12px", borderRadius: "var(--radius-sm)", background: "var(--warn-soft)", color: "var(--warn)", fontSize: 12.5 }}>
                  <div style={{ marginBottom: allRemoteRefs.length ? 8 : 0 }}>
                    <span className="mono">{refTrim}</span> {hubSource ? "isn’t a published version of this skills-hub skill" : "isn’t a branch or tag in this repo"} — mirroring will fail.{allRemoteRefs.length ? " Pick one that exists:" : hubSource ? " This skill publishes no versions." : " This repo publishes no branches or tags."}
                  </div>
                  {allRemoteRefs.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {refsForUrl!.tags.slice(0, 12).map((t) => (
                        <button key={`t-${t}`} type="button" className="chip" style={{ cursor: "pointer" }} onClick={() => pickRef(t)}>
                          <span className="muted">{hubSource ? "version" : "tag"}</span> {t}
                        </button>
                      ))}
                      {refsForUrl!.branches.slice(0, 12).map((b) => (
                        <button key={`b-${b}`} type="button" className="chip" style={{ cursor: "pointer" }} onClick={() => pickRef(b)}>
                          <span className="muted">branch</span> {b}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div>
              <label style={label}>Skill name <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--faint)" }}>· optional · subfolder in the repo</span></label>
              <input
                style={{ ...field, fontFamily: "var(--font-mono)", ...(subdirMismatch ? { border: "1px solid var(--warn, #b58900)" } : {}) }}
                value={f.externalSubdir}
                onChange={(e) => {
                  const subdir = e.target.value;
                  // Model (a): the skill name = the upstream subfolder; the slug is its last
                  // segment — but NEVER re-derived in new-version mode (slug is locked; the
                  // folder is per-version so upstream may move it between releases). §6, §8.
                  const derived = !lock ? subdir.trim().split("/").filter(Boolean).pop() ?? "" : "";
                  setF((prev) => ({ ...prev, externalSubdir: subdir, ...(derived ? { skillSlug: derived } : {}) }));
                }}
                placeholder="frontend-design"
              />
              {subdirMismatch ? (
                <p style={{ color: "var(--warn, #b58900)", fontSize: 12, marginTop: 7 }}>
                  ⚠ This folder looks like a different skill — <span className="mono">{subdirLast}</span> ≠ <span className="mono">{f.skillSlug}</span>. You can still submit; the mirror will fail unless the folder’s <span className="mono">SKILL.md</span> is named <span className="mono">{f.skillSlug}</span>.
                </p>
              ) : (
                <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>
                  Leave blank if <span className="mono">SKILL.md</span> is at the repo root. For a multi-skill repo (e.g. <span className="mono">anthropics/skills</span>), enter the skill’s folder — skilly mirrors only that folder{lock ? "" : ", and the slug above is filled from it"}.
                </p>
              )}
            </div>
          </>
        ))}

        {/* Namespace then Skill slug, stacked (slug below namespace) — same order in new-skill and
            new-version flows. Hidden in "I want a skill" mode (a request has no namespace/slug). */}
        {mode === "have" && (<>
        <div>
            <label style={label}>Namespace{!lock && <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--faint)" }}> · pick one you can contribute to</span>}</label>
            <div className={`select-wrap${lock ? " is-disabled" : ""}`}>
              <select
                style={{ ...field, fontFamily: "var(--font-mono)", padding: "10px 38px 10px 12px", ...(lock ? lockedStyle : {}) }}
                value={f.namespaceSlug}
                onChange={set("namespaceSlug")}
                disabled={lock}
              >
                {/* Always render the current value so a locked/not-yet-loaded namespace shows. */}
                {!namespaceOptions.some((n) => n.slug === f.namespaceSlug) && f.namespaceSlug && (
                  <option value={f.namespaceSlug}>{f.namespaceSlug}</option>
                )}
                {namespaceOptions.map((n) => (
                  <option key={n.slug} value={n.slug}>{n.slug} — {n.displayName}</option>
                ))}
              </select>
              <svg className="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>
              {visibility === "org" ? (
                <><span className="mono">global</span> — org-wide, visible to everyone.</>
              ) : (
                <>Restricted to <span className="mono">{f.namespaceSlug}</span> — visible only to its members.</>
              )}
            </p>
          </div>
          <div><label style={label}>Skill slug{lock && <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--faint)" }}> · locked</span>}</label><input style={{ ...field, ...(lock ? lockedStyle : {}) }} value={f.skillSlug} onChange={set("skillSlug")} onBlur={() => { const slug = f.skillSlug.trim(); if (!lock && slug && !f.title.trim()) setF((prev) => ({ ...prev, title: titleize(slug) })); }} placeholder="pdf-tools" disabled={lock} /></div>
        {!lock && existingSkill && existingSkill.ns === f.namespaceSlug.trim() && existingSkill.slug === f.skillSlug.trim() && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: "var(--radius-sm)", background: "var(--accent-soft)", fontSize: 13.5 }}>
            <span aria-hidden>ℹ</span>
            <span>
              <span className="mono">{existingSkill.ns}/{existingSkill.slug}</span> already exists —{" "}
              <Link href={`/propose?ns=${encodeURIComponent(existingSkill.ns)}&slug=${encodeURIComponent(existingSkill.slug)}&newVersion=1`} style={{ fontWeight: 600, textDecoration: "underline" }}>
                propose a new version of it
              </Link>{" "}
              instead.
            </span>
          </div>
        )}
        {dup && (
          <div
            ref={dupRef}
            style={{
              display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "12px 14px", borderRadius: "var(--radius-sm)", fontSize: 13.5,
              background: dup.mode === "block" ? "var(--danger-soft, color-mix(in oklab, var(--danger) 12%, transparent))" : "var(--warn-soft)",
              color: dup.mode === "block" ? "var(--danger)" : "var(--warn)",
              border: `1px solid color-mix(in oklab, ${dup.mode === "block" ? "var(--danger)" : "var(--warn)"} 35%, var(--line))`,
            }}
          >
            <span aria-hidden style={{ fontSize: 16 }}>{dup.mode === "block" ? "⛔" : "⚠"}</span>
            <span style={{ flex: 1, minWidth: 220 }}>
              {dup.mode === "block"
                ? <>This skill is already in the catalog as <span className="mono">{dup.ns}/{dup.slug}</span>. You can’t propose it again — propose a new version of it instead.</>
                : <>This looks like a duplicate of <span className="mono">{dup.ns}/{dup.slug}</span>. Consider proposing a new version of it instead — you can still submit as a new skill.</>}
            </span>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => enterNewVersion(dup.ns, dup.slug)}>Propose a new version →</button>
          </div>
        )}
        </>)}
        <div>
          <label style={label}>Title</label>
          {/* Editable in new-version mode too (§8): a re-version may retitle the skill — synced on
              accept. The slug stays the immutable identity. */}
          <input style={field} value={f.title} onChange={set("title")} placeholder="PDF Tools" />
          {lock && <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>Editing the title renames the skill when this version is accepted (the slug never changes).</p>}
        </div>
        <div>
          <label style={label}>Categories</label>
          {/* Editable in new-version mode too — synced to the skill on accept (§8). */}
          <TagInput value={categories} onChange={setCategories} suggestions={categoryOptions} placeholder="Search or create categories…" />
          <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>
            {lock
              ? "Pre-filled with the skill's current categories. Editing them updates the skill's categories when this version is accepted."
              : "Type to search existing categories, or enter a new one and press Enter. Add as many as fit."}
          </p>
        </div>
        {mode === "have" && (
          <div>
            <label style={label}>Tags <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--faint)" }}>· optional, free-form</span></label>
            {/* Free-form tags (§3 taxonomy) — editable in new-version mode too, synced on accept (§8). */}
            <TagInput value={tags} onChange={setTags} placeholder="Add tags…" />
            {lock && <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>Pre-filled with the skill's current tags. Editing them updates the skill's tags when this version is accepted.</p>}
          </div>
        )}
        <div>
          <label style={label}>Description <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--faint)" }}>· Markdown</span></label>
          {/* Description stays editable in new-version mode (like categories) — on accept the skill's
              description is updated to match. Other skill-level metadata stays locked. §8. */}
          <MarkdownField value={f.description} onChange={(v) => setF((prev) => ({ ...prev, description: v }))} rows={3} placeholder="What does this skill do?" style={field} />
          {lock && <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>Editing the description updates the skill's description when this version is accepted.</p>}
        </div>
        <div>
          <label style={label}>Usage <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--faint)" }}>· how it's triggered, options (Markdown)</span></label>
          <MarkdownField value={f.usageExamples} onChange={(v) => setF((prev) => ({ ...prev, usageExamples: v }))} rows={4} mono style={field} placeholder={"Shown as a quick-start above SKILL.md. e.g.\n\nTrigger by asking to \"summarize a PDF\".\n\nOptions:\n- `pages`: page range"} />
        </div>
        <div>
          <label style={label}>Tool / harness <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--faint)" }}>· the coding agent this skill targets</span></label>
          {/* Editable in new-version mode too (§8) — synced to the skill on accept. tool_harness is
              skill-level, so a change updates the install command's --agent for EVERY version. */}
          <ToolHarnessPicker
            value={f.toolHarness}
            onChange={(slug) => setF((prev) => ({ ...prev, toolHarness: slug }))}
            style={{ ...field, fontFamily: "var(--font-mono)" }}
          />
          <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>
            {f.toolHarness && f.toolHarness !== GENERIC_AGENT ? (
              <>Install command will include <span className="mono">--agent {f.toolHarness}</span>.</>
            ) : (
              <>No <span className="mono">--agent</span> flag — installs anywhere (Generic).</>
            )}
            {lock && <> Changing it updates the install command for every version of this skill.</>}
          </p>
        </div>
        {mode === "have" && (
          <div><label style={label}>Version</label><input style={{ ...field, fontFamily: "var(--font-mono)" }} value={f.semver} onChange={set("semver")} placeholder="1.0.0" /></div>
        )}

        {/* Advisory similar-match (soft-warn, §26): something like this already exists — the
            request can still be posted (the button below now reads "Post anyway"). */}
        {mode === "want" && reqSimilar && (reqSimilar.openRequest || reqSimilar.catalogSkill) && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--warn-soft)", color: "var(--warn)", fontSize: 13.5 }}>
            <span aria-hidden>⚠</span>
            <span style={{ flex: 1 }}>
              {reqSimilar.catalogSkill && (
                <>A similar skill may already exist: <Link href={`/skills/${reqSimilar.catalogSkill.namespaceSlug}/${reqSimilar.catalogSkill.skillSlug}`} style={{ fontWeight: 600, textDecoration: "underline" }}>{reqSimilar.catalogSkill.title}</Link>. </>
              )}
              {reqSimilar.openRequest && (
                <>Someone already asked for something similar: <Link href={`/requests/${reqSimilar.openRequest.id}`} style={{ fontWeight: 600, textDecoration: "underline" }}>{reqSimilar.openRequest.title}</Link>. </>
              )}
              You can still post your request.
            </span>
          </div>
        )}

        {scan && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Pill tone={scan.severity === "info" ? "ok" : scan.severity === "high" || scan.severity === "critical" ? "danger" : "warn"}>scan: {scan.severity}</Pill>
            <span className="muted" style={{ fontSize: 13 }}>{scan.findings.length} finding{scan.findings.length === 1 ? "" : "s"}</span>
          </div>
        )}
        {err && <div ref={errRef} style={{ color: "var(--danger)", fontSize: 13.5, borderRadius: "var(--radius-sm)" }}>{err}</div>}

        {mode === "want" ? (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", position: "relative", zIndex: 6 }}>
            <button className="btn btn-primary" disabled={busy} onClick={() => void submitRequest()}>
              {busy ? "Working…" : reqAck && reqSimilar && (reqSimilar.openRequest || reqSimilar.catalogSkill) ? "Post anyway →" : "Post request →"}
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="btn btn-primary" disabled={busy || dup?.mode === "block"} onClick={() => submit("review")}>{busy ? "Working…" : "Submit for review →"}</button>
              <button className="btn" disabled={busy || dup?.mode === "block"} onClick={() => submit("direct")} title="Only where you may publish without review">Publish directly</button>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
              “Publish directly” works only in namespaces that don’t require review and where you’re a member/admin — otherwise it’s declined and you can submit for review.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default function ProposePage() {
  return (
    <RequireAuth>
      <ScrollToTop />
      <Suspense fallback={<div className="reveal" style={{ maxWidth: 720 }}><p className="muted">Loading…</p></div>}>
        <ProposeForm />
      </Suspense>
    </RequireAuth>
  );
}
