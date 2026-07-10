"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useApi, Pill, EmptyState, ScrollToTop } from "../../../components/ui";
import { RequireAuth } from "../../../components/RequireAuth";
import { TagInput } from "../../../components/TagInput";
import { Markdown } from "../../../components/Markdown";
import { MarkdownField } from "../../../components/MarkdownField";
import { ToolHarnessPicker } from "../../../components/ToolHarnessPicker";
import { useDateFmt } from "../../../components/DateFormat";
import { ChatBox, type ChatMessage } from "../../../components/ChatBox";
import { UserBubble } from "../../../components/UserBubble";
import { useChatPollIntervals } from "../../../components/useChatPoll";
import { usePageLabelOverride } from "../../../components/PageLabelOverride";

interface Finding { scanner: string; severity: string; rule: string; message: string; path?: string }
interface Meta {
  skillSlug: string;
  title: string;
  description: string;
  toolHarness: string;
  visibility: "org" | "namespace";
  categories?: string[];
  tags?: string[];
  usageExamples?: string | null;
}
interface Revision {
  revisionNo: number;
  payload: {
    metadata: Meta;
    artifactObjectKey?: string;
    artifactSha256?: string;
    contentSha256?: string;
    artifactFilename?: string | null;
    pointer?: { url: string; ref: string; subdir?: string | null };
    /** Keep current files (§8): this revision reuses an existing version's artifact verbatim. */
    reuse?: { fromVersionId: string; fromSemver: string; external?: { url: string; ref: string; subdir?: string | null } | null };
  };
  author: string;
  note: string | null;
  createdAt: string;
}
/** The target skill's live state — the review page's old → new diff baseline (§8). */
interface TargetSkillCurrent {
  title: string; description: string; toolHarness: string; tags: string[]; categories: string[];
  usageExamples: string | null; latestStable: string | null;
}
interface Detail {
  id: string; state: string; targetNamespaceSlug: string; targetSkillId: string | null; proposedSemver: string;
  decisionReason: string | null; materializedVersionId: string | null; createdAt: string;
  revisions: Revision[]; scanReport: { severity: string | null; status: string; findings: Finding[]; createdAt: string } | null;
  caps: { isReviewer: boolean; isSubmitter: boolean }; allowedActions: string[];
  submitterCard: SubmitterCard | null;
  conversationId: string | null;
  duplicate: { namespaceSlug: string; skillSlug: string; title: string } | null;
  targetSkillCurrent: TargetSkillCurrent | null;
}
interface SubmitterCard { userId: string; displayName: string; email: string; avatar: string | null; role: string; priorSubmissions: number }

const ACTION_LABEL: Record<string, string> = {
  start_review: "Start review",
  request_changes: "Request changes",
  resubmit: "Resubmit",
  accept: "Accept & publish",
  reject: "Reject",
};
const SEV_TONE: Record<string, "ok" | "warn" | "danger" | "muted"> = { critical: "danger", high: "danger", medium: "warn", low: "muted", info: "muted" };
const STATE_TONE: Record<string, "ok" | "warn" | "danger" | "muted"> = { proposed: "muted", under_review: "warn", changes_requested: "warn", accepted: "ok", rejected: "danger" };

const fieldStyle = { width: "100%", padding: "9px 11px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 13.5 } as const;
const labelStyle = { display: "block", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 6 } as const;

/** Editable copy of the submitted metadata (same controls as the propose form). Used by reviewer
 *  edits AND proposer resubmits; the proposer-only extras (semver, files) ride along. */
interface NewArtifact { artifactObjectKey: string; artifactSha256: string; contentSha256: string; artifactFilename: string | null }
interface EditDraft {
  title: string; description: string; toolHarness: string; visibility: "org" | "namespace";
  categories: string[]; tags: string[]; usageExamples: string;
  /** proposer resubmit: revised proposed semver. */
  semver: string;
  /** proposer resubmit: replacement hosted bundle (null = keep current). */
  newArtifact: NewArtifact | null;
  /** proposer resubmit: editable pointer fields (null for hosted proposals). */
  pointer: { url: string; ref: string; subdir: string } | null;
  /** proposer resubmit, new-version only (§8): switch the files to "Keep current files" —
   *  the server re-snapshots the then-latest stable artifact on resubmit. */
  reuseFiles: boolean;
}

/**
 * Link to a pointer's upstream for the reviewer: the repository URL from the original
 * install command (".git" stripped for the browser). A pinned ref/subdir is NOT folded in —
 * refs aren't guaranteed to be real branches/tags, and a wrong guess 404s. The one
 * exception: a skills-hub API origin maps to its public skill page (the API URL is JSON).
 */
function repoLinkFor(p: { url: string; ref: string; subdir?: string | null }): string {
  const hub = p.url.match(/^https:\/\/skills-hub\.ai\/api\/v1\/skills\/([^/]+)\/?$/i);
  if (hub) return `https://skills-hub.ai/skills/${hub[1]}`;
  return p.url.replace(/\.git$/i, "");
}

// ── Bundle file browser (review): tree of the uploaded bundle, view text / download binary. ──────
interface BundleFileMeta { path: string; size: number; isText: boolean }
interface TreeNode { name: string; path: string; dir: boolean; size: number; isText: boolean; children: TreeNode[] }

function buildFileTree(files: BundleFileMeta[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, size: 0, isText: false, children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const name = parts[i]!;
      let child = node.children.find((c) => c.name === name && c.dir === !isLeaf);
      if (!child) {
        child = { name, path: parts.slice(0, i + 1).join("/"), dir: !isLeaf, size: isLeaf ? f.size : 0, isText: isLeaf ? f.isText : false, children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function TreeRows({ nodes, depth, selectedPath, onOpen, proposalId }: { nodes: TreeNode[]; depth: number; selectedPath: string | null; onOpen: (f: BundleFileMeta) => void; proposalId: string }) {
  return (
    <>
      {nodes.map((n) => (n.dir ? <FolderRow key={n.path} node={n} depth={depth} selectedPath={selectedPath} onOpen={onOpen} proposalId={proposalId} /> : (
        <div
          key={n.path}
          onClick={() => n.isText && onOpen({ path: n.path, size: n.size, isText: n.isText })}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", paddingLeft: 8 + depth * 16, borderRadius: "var(--radius-sm)", cursor: n.isText ? "pointer" : "default", background: selectedPath === n.path ? "var(--surface-2)" : "transparent" }}
        >
          <span aria-hidden style={{ opacity: 0.6 }}>{n.isText ? "📄" : "📦"}</span>
          <span className="mono" style={{ fontSize: 12.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.name}</span>
          <span className="muted mono" style={{ fontSize: 10.5 }}>{humanSize(n.size)}</span>
          <a
            href={`/api/proposals/${proposalId}/files?path=${encodeURIComponent(n.path)}&download=1`}
            onClick={(e) => e.stopPropagation()}
            className="btn-ghost mono"
            style={{ fontSize: 10.5, padding: "1px 6px" }}
            title="Download this file"
          >↓</a>
        </div>
      )))}
    </>
  );
}

function FolderRow({ node, depth, selectedPath, onOpen, proposalId }: { node: TreeNode; depth: number; selectedPath: string | null; onOpen: (f: BundleFileMeta) => void; proposalId: string }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", paddingLeft: 8 + depth * 16, cursor: "pointer", borderRadius: "var(--radius-sm)" }}
      >
        <span aria-hidden style={{ fontSize: 10, width: 10, color: "var(--faint)" }}>{open ? "▾" : "▸"}</span>
        <span aria-hidden style={{ opacity: 0.7 }}>📁</span>
        <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{node.name}</span>
      </div>
      {open && <TreeRows nodes={node.children} depth={depth + 1} selectedPath={selectedPath} onOpen={onOpen} proposalId={proposalId} />}
    </>
  );
}

function BundleFiles({ proposalId }: { proposalId: string }) {
  const { data, loading, error } = useApi<{ available: boolean; kind?: string; error?: string; files?: BundleFileMeta[] }>(`/api/proposals/${proposalId}/files`);
  const [selected, setSelected] = useState<BundleFileMeta | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewErr, setViewErr] = useState<string | null>(null);

  const openFile = useCallback(async (f: BundleFileMeta) => {
    setSelected(f);
    setContent(null);
    setViewErr(null);
    setViewLoading(true);
    try {
      const r = await fetch(`/api/proposals/${proposalId}/files?path=${encodeURIComponent(f.path)}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`);
      setContent(await r.text());
    } catch (e) {
      setViewErr(String((e as Error).message ?? e));
    } finally {
      setViewLoading(false);
    }
  }, [proposalId]);

  if (loading) return <p className="muted" style={{ fontSize: 13 }}>Loading files…</p>;
  if (error) return <p className="muted" style={{ fontSize: 13 }}>Couldn’t load files: {error}</p>;
  if (!data?.available) {
    const note =
      data?.kind === "pointer"
        ? "This is a pointer skill — its files are mirrored from the upstream repository on acceptance, so there’s no uploaded bundle to browse. Use “View repository” above to inspect the source."
        : data?.kind === "error"
          ? `The uploaded bundle couldn’t be read: ${data.error}`
          : "No uploaded bundle for this proposal.";
    return <p className="muted" style={{ fontSize: 13.5 }}>{note}</p>;
  }
  const files = data.files ?? [];
  const tree = buildFileTree(files);

  return (
    <div className="bundle-files">
      <div style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", padding: 6, maxHeight: 460, overflow: "auto" }}>
        <TreeRows nodes={tree} depth={0} selectedPath={selected?.path ?? null} onOpen={openFile} proposalId={proposalId} />
      </div>
      <div style={{ minWidth: 0 }}>
        {!selected ? (
          <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>Select a text file to view its contents. Use the ↓ on any file to download it.</p>
        ) : (
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected.path}</span>
              <span className="muted mono" style={{ fontSize: 10.5 }}>{humanSize(selected.size)}</span>
              <span style={{ flex: 1 }} />
              <a className="btn btn-sm" href={`/api/proposals/${proposalId}/files?path=${encodeURIComponent(selected.path)}&download=1`}>↓ Download</a>
            </div>
            {viewLoading ? (
              <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
            ) : viewErr ? (
              <p className="muted" style={{ fontSize: 13 }}>Couldn’t load: {viewErr}</p>
            ) : content != null ? (
              <pre className="mono" style={{ fontSize: 12, lineHeight: 1.5, padding: "10px 12px", background: "var(--surface-2)", borderRadius: "var(--radius-sm)", overflow: "auto", maxHeight: 460, margin: 0, whiteSpace: "pre", color: "var(--ink)" }}>{content}</pre>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

// ── "Changes on accept" (§8): old → new diff of a new-version proposal vs the skill's live state ──
const diffNormSet = (xs: readonly string[] | null | undefined, lower = false): string[] =>
  [...new Set((xs ?? []).map((x) => (lower ? x.trim().toLowerCase() : x.trim())).filter(Boolean))].sort();
const diffSameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** One old → new diff row; long text stacks "was"/"now" blocks, short values render inline. */
function DiffRow({ label, oldNode, newNode, block = false }: { label: string; oldNode: ReactNode; newNode: ReactNode; block?: boolean }) {
  return (
    <div className="detail-row detail-row-wide">
      <span className="detail-row-label">{label}</span>
      <span className="detail-row-value" style={block ? { display: "flex", flexDirection: "column", gap: 6 } : undefined}>
        {block ? (
          <>
            <span style={{ display: "block" }}>
              <span className="muted mono" style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase" }}>was</span>
              <span className="muted" style={{ display: "block", maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap", textDecoration: "line-through", opacity: 0.75 }}>{oldNode}</span>
            </span>
            <span style={{ display: "block" }}>
              <span className="mono" style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ok)" }}>now</span>
              <span style={{ display: "block", maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap" }}>{newNode}</span>
            </span>
          </>
        ) : (
          <>
            <span className="muted" style={{ textDecoration: "line-through", opacity: 0.75 }}>{oldNode}</span>
            <span aria-hidden style={{ margin: "0 8px", color: "var(--faint)" }}>→</span>
            <span style={{ fontWeight: 600 }}>{newNode}</span>
          </>
        )}
      </span>
    </div>
  );
}

/**
 * New-version proposals only: what accepting would change on the live skill — an explicit
 * old → new diff of every changed metadata field, plus the files line ("unchanged — reuses
 * v<x>'s bundle" for a Keep-current-files proposal). SKILLY_SPEC.md §8.
 */
function ChangesOnAccept({ meta, cur, payload }: { meta: Meta; cur: TargetSkillCurrent; payload: Revision["payload"] }) {
  const chips = (xs: string[]) => (xs.length ? xs.map((x) => <span key={x} className="chip" style={{ marginRight: 6 }}>{x}</span>) : <span className="muted">none</span>);
  const rows: ReactNode[] = [];
  if (meta.title.trim() !== cur.title.trim()) {
    rows.push(<DiffRow key="title" label="Title" oldNode={cur.title} newNode={meta.title.trim()} />);
  }
  if (meta.description.trim() !== cur.description.trim()) {
    rows.push(<DiffRow key="desc" label="Description" block oldNode={cur.description} newNode={meta.description.trim()} />);
  }
  if (!diffSameSet(diffNormSet(meta.categories, true), diffNormSet(cur.categories, true))) {
    rows.push(<DiffRow key="cats" label="Categories" oldNode={chips(cur.categories)} newNode={chips(diffNormSet(meta.categories, true))} />);
  }
  if (!diffSameSet(diffNormSet(meta.tags), diffNormSet(cur.tags))) {
    rows.push(<DiffRow key="tags" label="Tags" oldNode={chips(cur.tags)} newNode={chips(diffNormSet(meta.tags))} />);
  }
  if (meta.toolHarness.trim() !== cur.toolHarness.trim()) {
    rows.push(<DiffRow key="harness" label="Harness" oldNode={<span className="chip">{cur.toolHarness}</span>} newNode={<span className="chip">{meta.toolHarness.trim()}</span>} />);
  }
  if (((meta.usageExamples ?? "").trim() || null) !== ((cur.usageExamples ?? "").trim() || null)) {
    rows.push(<DiffRow key="usage" label="Usage" block oldNode={cur.usageExamples ?? "—"} newNode={(meta.usageExamples ?? "").trim() || "—"} />);
  }
  return (
    <div className="card card-pad" style={{ marginTop: 26 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 19 }}>Changes on accept</h2>
        <span className="muted" style={{ fontSize: 12.5 }}>vs the skill’s current state</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {rows.length ? rows : <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>No skill-level metadata changes — this version only ships new files.</p>}
        <div className="detail-row detail-row-wide">
          <span className="detail-row-label">Files</span>
          <span className="detail-row-value">
            {payload.reuse ? (
              <><strong>unchanged</strong> — reuses <span className="mono">v{payload.reuse.fromSemver}</span>’s {payload.reuse.external ? "mirrored files" : "bundle"} byte-for-byte</>
            ) : payload.pointer ? (
              <>new pinned source · <span className="mono">{payload.pointer.url}</span> @ <span className="mono">{payload.pointer.ref}</span></>
            ) : (
              <>new bundle uploaded{payload.artifactSha256 && <> · sha256 <span className="mono">{payload.artifactSha256.slice(0, 16)}…</span></>}</>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function ProposalDetailInner() {
  const fmt = useDateFmt();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { data, loading, error, reload } = useApi<Detail>(id ? `/api/proposals/${id}` : null);
  usePageLabelOverride(data ? `Proposal: ${data.revisions.at(-1)?.payload.metadata.title ?? "Proposal"}` : null);
  const [note, setNote] = useState("");
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "err" | "ok"; text: string } | null>(null);
  // Edit mode: null = read view. Edits travel as a new revision with the decision (reviewer) or
  // the resubmit (proposer).
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [uploading, setUploading] = useState(false);
  // Same option source as the propose form (existing categories; the tool/harness picker is the
  // closed shared TOOL_OPTIONS list — §8).
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  // Anti-virus (ClamAV) raw result — collapsed by default; reviewers expand to see the exact
  // per-file engine output, even when nothing was flagged.
  const [avOpen, setAvOpen] = useState(false);
  useEffect(() => {
    fetch("/api/categories")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setCategoryOptions(j.categories ?? []))
      .catch(() => {});
  }, []);

  const findings = data?.scanReport?.findings ?? [];
  const sev = data?.scanReport?.severity ?? null;
  const needsOverride = sev === "high" || sev === "critical";
  // Real issues (the "N findings" count) vs. the anti-virus engine's per-file output. ClamAV
  // records every file — including clean ones (severity `info`) — so reviewers can expand and see
  // exactly what it returned; only genuine detections (`malware`, critical) count as findings.
  const issues = findings.filter((f) => f.severity !== "info");
  const avFindings = findings.filter((f) => f.scanner === "clamav");
  const avRan = avFindings.length > 0;
  const avUnavailable = avFindings.some((f) => f.rule === "scanner-unavailable");
  const avThreats = avFindings.filter((f) => f.rule === "malware");
  const avStatus = !avRan
    ? "not run"
    : avUnavailable
      ? "engine unavailable"
      : avThreats.length > 0
        ? `${avThreats.length} threat${avThreats.length === 1 ? "" : "s"}`
        : `clean · ${avFindings.length} file${avFindings.length === 1 ? "" : "s"}`;

  // Build the edited revision payload (latest payload + metadata changes + proposer file/pointer
  // replacement).
  const editedPayload = () => {
    const latestRev = data?.revisions.at(-1);
    if (!edit || !latestRev) return undefined;
    const base = {
      ...latestRev.payload,
      metadata: {
        ...latestRev.payload.metadata,
        title: edit.title.trim(),
        description: edit.description.trim(),
        toolHarness: edit.toolHarness.trim(),
        visibility: edit.visibility,
        categories: edit.categories,
        tags: edit.tags,
        usageExamples: edit.usageExamples.trim() || null,
      },
    };
    // Proposer replaced the hosted bundle: swap in the freshly-uploaded artifact (keeps the same
    // delivery type — a hosted proposal stays hosted). Ignored when switching to "Keep current
    // files" — the server strips client files and resolves the reuse snapshot itself (§8).
    if (edit.newArtifact && !edit.reuseFiles) {
      base.artifactObjectKey = edit.newArtifact.artifactObjectKey;
      base.artifactSha256 = edit.newArtifact.artifactSha256;
      base.contentSha256 = edit.newArtifact.contentSha256;
      base.artifactFilename = edit.newArtifact.artifactFilename;
    }
    // Proposer edited the pointer source.
    if (edit.pointer && base.pointer && !edit.reuseFiles) {
      base.pointer = { url: edit.pointer.url.trim(), ref: edit.pointer.ref.trim(), subdir: edit.pointer.subdir.trim() || null };
    }
    return base;
  };

  // Re-upload a replacement bundle (hosted, proposer only). Mirrors the propose form: POST the file
  // to /api/uploads (which validates + scans) and stage the returned key on the draft.
  const uploadReplacement = async (file: File) => {
    const skillSlug = data?.revisions.at(-1)?.payload.metadata.skillSlug ?? "";
    setUploading(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("bundle", file);
      fd.append("skillSlug", skillSlug);
      const r = await fetch("/api/uploads", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Upload failed (${r.status})`);
      setEdit((e) => (e ? { ...e, newArtifact: { artifactObjectKey: j.artifactObjectKey, artifactSha256: j.artifactSha256, contentSha256: j.contentSha256, artifactFilename: j.artifactFilename ?? file.name } } : e));
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message) });
    } finally {
      setUploading(false);
    }
  };

  const act = async (action: string) => {
    setBusy(action);
    setMsg(null);
    try {
      const r = await fetch(`/api/proposals/${id}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          note: note || undefined,
          newPayload: editedPayload(),
          // Proposer resubmit may revise the semver (only honored server-side on resubmit).
          newSemver: edit && data?.caps.isSubmitter ? edit.semver.trim() || undefined : undefined,
          // Keep current files (§8): only honored server-side on resubmit of a new-version proposal.
          reuseCurrentFiles: action === "resubmit" && edit?.reuseFiles ? true : undefined,
          override: action === "accept" ? override : undefined,
          overrideReason: override ? note || undefined : undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Action failed (${r.status})`);
      setMsg({ kind: "ok", text: `Proposal is now “${j.state}”.${edit ? " Your edits were recorded as a new revision." : ""}` });
      setNote("");
      setOverride(false);
      setEdit(null);
      reload();
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message) });
    } finally {
      setBusy(null);
    }
  };

  // Reviewer housekeeping: permanently delete this proposal (spam/dupes/test/mistakes) — distinct
  // from reject. Silent + audited server-side; a 404 (already gone) is treated as success. Locked
  // for accepted (provenance of a live version). On success, back to the queue. §8.
  const del = async () => {
    const title = data?.revisions.at(-1)?.payload.metadata.title ?? "this proposal";
    if (!window.confirm(
      `Permanently delete ${title} v${data?.proposedSemver}?\n\n` +
      "This removes the proposal, its revisions, and its review discussion. The audit record is kept. This can't be undone.",
    )) return;
    setDeleting(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/proposals/${id}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Delete failed (${r.status})`);
      router.push("/proposals");
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message) });
      setDeleting(false);
    }
  };

  if (error) return <EmptyState icon="⚠" title="Proposal unavailable" hint={error} />;
  if (loading || !data) return <div className="skeleton" style={{ height: 220, borderRadius: "var(--radius)" }} />;

  const latest = data.revisions.at(-1);

  return (
    <div className="reveal" style={{ maxWidth: 860 }}>
      <ScrollToTop />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
        <Link href="/proposals" className="btn-ghost mono" style={{ fontSize: 12 }}>← review queue</Link>
        <span style={{ flex: 1 }} />
        {/* Reviewer-only housekeeping delete — any state except accepted (locked: provenance of a live version). */}
        {data.caps.isReviewer && data.state !== "accepted" && (
          <button type="button" className="btn btn-sm btn-danger" disabled={deleting} onClick={() => void del()} title="Permanently delete this proposal (housekeeping)">
            {deleting ? "…" : "🗑 Delete proposal"}
          </button>
        )}
      </div>

      <div className="meta" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <span className="ns" style={{ fontSize: 15 }}>@{data.targetNamespaceSlug}</span>
        <span className="chip chip-accent">v{data.proposedSemver}</span>
        <Pill tone={STATE_TONE[data.state] ?? "muted"}>{data.state.replace("_", " ")}</Pill>
        <span className="chip">{data.targetSkillId ? "new version" : "new skill"}</span>
      </div>
      <h1 className="page-title" style={{ fontSize: "clamp(28px,4vw,40px)" }}>{latest?.payload.metadata.title ?? "Proposal"}</h1>

      {/* Duplicate alert (§8): this new-skill proposal matches an existing skill the reviewer can
          see. Shown regardless of enforcement mode — it may have slipped past a "warn" gate, or
          past "block" because the proposer couldn't see the (restricted) match that the reviewer can. */}
      {data.duplicate && (
        <div
          className="card card-pad"
          style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "var(--warn-soft)", borderColor: "color-mix(in oklab, var(--warn) 35%, var(--line))" }}
        >
          <span aria-hidden style={{ fontSize: 18 }}>⚠</span>
          <span style={{ fontSize: 13.5, flex: 1, minWidth: 220 }}>
            This looks like a duplicate of an existing skill:{" "}
            <Link className="mono" href={`/skills/${data.duplicate.namespaceSlug}/${data.duplicate.skillSlug}`} style={{ fontWeight: 600, textDecoration: "underline" }}>
              {data.duplicate.namespaceSlug}/{data.duplicate.skillSlug}
            </Link>
            . Consider whether this should be a new version of it rather than a separate skill.
          </span>
          <Link className="btn btn-sm" href={`/skills/${data.duplicate.namespaceSlug}/${data.duplicate.skillSlug}`}>View existing →</Link>
        </div>
      )}

      {/* Submitted details — everything from the propose form; reviewers may edit before deciding. */}
      {latest && (() => {
        const m = latest.payload.metadata;
        const isNewSkill = !data.targetSkillId;
        const isSubmitter = data.caps.isSubmitter;
        const canResubmit = data.allowedActions.includes("resubmit");
        // Who can open the edit form: a reviewer with available actions, or the proposer when they
        // may resubmit (changes_requested). Field rules below differ by actor/type (§8).
        const canEdit = data.allowedActions.length > 0 && (data.caps.isReviewer || canResubmit);
        // Editable sets (§8): title, description, categories, tags, and tool/harness are editable
        // on BOTH proposal types — a re-version syncs them to the skill on accept. Only VISIBILITY
        // stays locked on a new-version proposal (skill-level frozen; a skill-management action).
        // Files + semver remain proposer-only.
        const editVisibility = isNewSkill;
        // `wide` rows (usage, source) stack the label ABOVE the value on mobile so the
        // content gets the full card width instead of fighting the label column.
        const ReadRow = ({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) => (
          <div className={`detail-row${wide ? " detail-row-wide" : ""}`}>
            <span className="detail-row-label">{label}</span>
            <span className="detail-row-value">{children}</span>
          </div>
        );
        return (
          <div className="card card-pad" style={{ marginTop: 26 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 19 }}>Submitted details</h2>
              <span style={{ flex: 1 }} />
              {latest.payload.pointer && (
                <a
                  className="btn btn-sm"
                  href={repoLinkFor(latest.payload.pointer)}
                  target="_blank"
                  rel="noreferrer noopener"
                  title="Open the upstream source (pinned ref/folder) in a new tab"
                >
                  ↗ View repository
                </a>
              )}
              {latest.payload.artifactObjectKey && (
                <a className="btn btn-sm" href={`/api/proposals/${id}/artifact`} title="Download the uploaded bundle to review its contents">
                  ↓ Download bundle
                </a>
              )}
              {canEdit && (
                edit ? (
                  <button className="btn btn-sm" onClick={() => setEdit(null)}>✕ Discard edits</button>
                ) : (
                  <button
                    className="btn btn-sm"
                    onClick={() => setEdit({
                      title: m.title,
                      description: m.description,
                      toolHarness: m.toolHarness,
                      visibility: m.visibility,
                      categories: m.categories ?? [],
                      tags: m.tags ?? [],
                      usageExamples: m.usageExamples ?? "",
                      semver: data.proposedSemver,
                      newArtifact: null,
                      pointer: latest.payload.pointer
                        ? { url: latest.payload.pointer.url, ref: latest.payload.pointer.ref, subdir: latest.payload.pointer.subdir ?? "" }
                        : null,
                      // Start from the revision's current files mode (§8).
                      reuseFiles: !!latest.payload.reuse,
                    })}
                  >
                    ✎ Edit
                  </button>
                )
              )}
            </div>

            {edit ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {!isNewSkill && (
                  <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                    New-version proposal — the slug and visibility are locked to the existing skill; title, description,
                    categories, tags, tool/harness and usage are editable and sync to the skill on accept (§8).
                    {isSubmitter ? " You can also revise the files and the version below." : ""}
                  </p>
                )}
                <div><label style={labelStyle}>Title</label><input style={fieldStyle} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></div>
                <div>
                  <label style={labelStyle}>Description <span style={{ textTransform: "none", letterSpacing: 0 }}>· Markdown</span></label>
                  <MarkdownField value={edit.description} onChange={(v) => setEdit({ ...edit, description: v })} rows={3} style={fieldStyle} />
                </div>
                {/* Same responsive two-up as the propose form: stacks once columns can't fit 220px. */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                  <div>
                    <label style={labelStyle}>Tool / harness <span style={{ textTransform: "none", letterSpacing: 0 }}>· the coding agent</span></label>
                    {/* Closed picker (§8) — same list as the propose form. An unchanged legacy value
                        passes server-side; a changed one must come from this list. */}
                    <ToolHarnessPicker
                      value={edit.toolHarness}
                      onChange={(slug) => setEdit({ ...edit, toolHarness: slug })}
                      style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Visibility</label>
                    <select style={fieldStyle} value={edit.visibility} onChange={(e) => setEdit({ ...edit, visibility: e.target.value as "org" | "namespace" })} disabled={!editVisibility}>
                      <option value="org">org-wide</option>
                      <option value="namespace">restricted to namespace</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>Categories</label>
                  <TagInput value={edit.categories} onChange={(next) => setEdit({ ...edit, categories: next })} suggestions={categoryOptions} placeholder="Search or create categories…" />
                </div>
                <div>
                  <label style={labelStyle}>Tags</label>
                  <TagInput value={edit.tags} onChange={(next) => setEdit({ ...edit, tags: next })} placeholder="Add tags…" />
                </div>
                <div>
                  <label style={labelStyle}>Usage <span style={{ textTransform: "none", letterSpacing: 0 }}>· Markdown</span></label>
                  <MarkdownField value={edit.usageExamples} onChange={(v) => setEdit({ ...edit, usageExamples: v })} rows={4} mono style={fieldStyle} />
                </div>

                {/* Proposer-only: revise the version + the files (delivery type is locked). */}
                {isSubmitter && (
                  <>
                    <div>
                      <label style={labelStyle}>Version <span style={{ textTransform: "none", letterSpacing: 0 }}>· semver</span></label>
                      <input style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }} value={edit.semver} onChange={(e) => setEdit({ ...edit, semver: e.target.value })} spellCheck={false} placeholder="1.2.3" />
                    </div>
                    {/* New-version proposals: switch between "Keep current files" (§8 — the server
                        re-snapshots the then-latest stable artifact on resubmit) and a fresh source. */}
                    {!isNewSkill && (
                      <div>
                        <label style={labelStyle}>Files</label>
                        <div className="sort-toggle" role="group" aria-label="Files for this version">
                          <button
                            type="button"
                            className={`sort-opt${edit.reuseFiles ? " sort-on" : ""}`}
                            aria-pressed={edit.reuseFiles}
                            disabled={!data.targetSkillCurrent?.latestStable}
                            title={data.targetSkillCurrent?.latestStable ? undefined : "This skill has no published stable version to reuse"}
                            onClick={() => setEdit({ ...edit, reuseFiles: true })}
                          >
                            Keep current files{data.targetSkillCurrent?.latestStable ? ` (v${data.targetSkillCurrent.latestStable})` : ""}
                          </button>
                          <button
                            type="button"
                            className={`sort-opt${!edit.reuseFiles ? " sort-on" : ""}`}
                            aria-pressed={!edit.reuseFiles}
                            onClick={() => setEdit({ ...edit, reuseFiles: false })}
                          >
                            {edit.pointer ? "Point at a new ref" : "Upload a new bundle"}
                          </button>
                        </div>
                        {edit.reuseFiles && (
                          <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>
                            The version reuses the latest stable version’s files byte-for-byte — at least one metadata field must differ.
                          </p>
                        )}
                      </div>
                    )}
                    {!isNewSkill && edit.reuseFiles ? null : edit.pointer ? (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                        <div style={{ gridColumn: "1 / -1" }}>
                          <label style={labelStyle}>Repository URL</label>
                          <input style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }} value={edit.pointer.url} onChange={(e) => setEdit({ ...edit, pointer: { ...edit.pointer!, url: e.target.value } })} spellCheck={false} />
                        </div>
                        <div>
                          <label style={labelStyle}>Pinned ref</label>
                          <input style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }} value={edit.pointer.ref} onChange={(e) => setEdit({ ...edit, pointer: { ...edit.pointer!, ref: e.target.value } })} spellCheck={false} />
                        </div>
                        <div>
                          <label style={labelStyle}>Subfolder <span style={{ textTransform: "none", letterSpacing: 0 }}>· optional</span></label>
                          <input style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }} value={edit.pointer.subdir} onChange={(e) => setEdit({ ...edit, pointer: { ...edit.pointer!, subdir: e.target.value } })} spellCheck={false} placeholder="path/in/repo" />
                        </div>
                      </div>
                    ) : (
                      <div>
                        <label style={labelStyle}>Replace bundle <span style={{ textTransform: "none", letterSpacing: 0 }}>· optional — leave empty to keep the current files</span></label>
                        <input type="file" accept=".zip,.tar.gz,.tgz,.skill" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadReplacement(f); }} style={{ fontSize: 13 }} />
                        {uploading && <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>Uploading &amp; scanning…</p>}
                        {edit.newArtifact && (
                          <p style={{ fontSize: 12.5, color: "var(--ok)", marginTop: 6 }}>
                            New bundle staged{edit.newArtifact.artifactFilename ? `: ${edit.newArtifact.artifactFilename}` : ""} ✓ — it'll replace the current files on resubmit.
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}

                <p style={{ fontSize: 12.5, color: "var(--accent-2)", margin: 0 }}>
                  {isSubmitter
                    ? "Your changes are saved as a new revision when you resubmit below."
                    : "Edits are recorded as a new revision together with your decision below (accept publishes the edited details)."}
                </p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <ReadRow label="Skill">
                  <span className="mono">@{data.targetNamespaceSlug}/{m.skillSlug}</span> · v{data.proposedSemver}
                </ReadRow>
                <ReadRow label="Harness"><span className="chip">{m.toolHarness}</span></ReadRow>
                <ReadRow label="Visibility">{m.visibility === "namespace" ? <Pill tone="warn">restricted</Pill> : <Pill tone="ok">org-wide</Pill>}</ReadRow>
                {m.description && (
                  <ReadRow label="Description" wide><Markdown source={m.description} /></ReadRow>
                )}
                {(m.categories?.length ?? 0) > 0 && (
                  <ReadRow label="Categories">{m.categories!.map((c) => <span key={c} className="chip" style={{ marginRight: 6 }}>{c}</span>)}</ReadRow>
                )}
                {(m.tags?.length ?? 0) > 0 && (
                  <ReadRow label="Tags">{m.tags!.map((t) => <span key={t} className="chip" style={{ marginRight: 6 }}>{t}</span>)}</ReadRow>
                )}
                {m.usageExamples && (
                  <ReadRow label="Usage" wide><Markdown source={m.usageExamples} /></ReadRow>
                )}
                {latest.payload.reuse ? (
                  <ReadRow label="Source" wide>
                    <strong>Files: unchanged</strong> — reuses <span className="mono">v{latest.payload.reuse.fromSemver}</span>’s {latest.payload.reuse.external ? "mirrored files" : "bundle"} byte-for-byte
                    {latest.payload.reuse.external && (
                      <> · pointer <a className="mono" href={latest.payload.reuse.external.url} target="_blank" rel="noreferrer noopener">{latest.payload.reuse.external.url}</a>
                        {" "}@ <span className="mono">{latest.payload.reuse.external.ref}</span>
                        {latest.payload.reuse.external.subdir && <> · folder <span className="mono">{latest.payload.reuse.external.subdir}/</span></>}
                      </>
                    )}
                  </ReadRow>
                ) : latest.payload.pointer ? (
                  <ReadRow label="Source" wide>
                    pointer · <a className="mono" href={latest.payload.pointer.url} target="_blank" rel="noreferrer noopener">{latest.payload.pointer.url}</a>
                    {" "}@ <span className="mono">{latest.payload.pointer.ref}</span>
                    {latest.payload.pointer.subdir && <> · folder <span className="mono">{latest.payload.pointer.subdir}/</span></>}
                  </ReadRow>
                ) : latest.payload.artifactObjectKey ? (
                  <ReadRow label="Source" wide>
                    hosted bundle{latest.payload.artifactSha256 && <> · sha256 <span className="mono">{latest.payload.artifactSha256.slice(0, 16)}…</span></>}
                  </ReadRow>
                ) : null}
              </div>
            )}
          </div>
        );
      })()}

      {/* New-version proposals: explicit old → new diff of what accepting changes on the live
          skill, plus the files line ("unchanged — reuses vX" for Keep-current-files). §8. */}
      {data.targetSkillId && data.targetSkillCurrent && latest && !edit && (
        <ChangesOnAccept meta={latest.payload.metadata} cur={data.targetSkillCurrent} payload={latest.payload} />
      )}

      {/* Bundle file browser — review the skill's files one by one before deciding. A
          Keep-current-files proposal browses the REUSED artifact (hosted or pointer mirror). */}
      <div className="card card-pad" style={{ marginTop: 26 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 19 }}>Files</h2>
          {latest?.payload.reuse && (
            <span className="muted" style={{ fontSize: 12.5 }}>
              unchanged — <span className="mono">v{latest.payload.reuse.fromSemver}</span>’s files, reused byte-for-byte
            </span>
          )}
        </div>
        <BundleFiles proposalId={id} />
      </div>

      {/* Scan report */}
      <div className="card card-pad" style={{ marginTop: 26 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 19 }}>Security scan</h2>
          {!data.scanReport ? (
            <Pill tone="muted">not scanned</Pill>
          ) : data.scanReport.status === "pending" ? (
            <Pill tone="muted">scan pending</Pill>
          ) : data.scanReport.status === "unreachable" ? (
            <Pill tone="warn">source unreachable</Pill>
          ) : (
            <Pill tone={SEV_TONE[sev ?? "info"] ?? "muted"}>{sev ?? "clean"}</Pill>
          )}
          <span className="muted mono" style={{ fontSize: 11, marginLeft: "auto" }}>{issues.length} finding{issues.length === 1 ? "" : "s"}</span>
        </div>
        {data.scanReport?.status === "pending" && (
          <p className="muted" style={{ fontSize: 13 }}>This pointer skill is queued for a scan of its pinned ref — findings appear here once the worker fetches it (usually within a minute).</p>
        )}
        {data.scanReport?.status === "unreachable" && (
          <p className="muted" style={{ fontSize: 13 }}>The pinned ref couldn’t be fetched for scanning (bad URL/ref, or the source was unavailable). It’s re-scanned automatically if the proposal’s ref changes.</p>
        )}
        {issues.map((f, i) => (
          <div key={i} className="row" style={{ borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", marginBottom: 8, background: "var(--surface-2)" }}>
            <Pill tone={SEV_TONE[f.severity] ?? "muted"}>{f.severity}</Pill>
            <div className="grow">
              <div style={{ fontWeight: 500, fontSize: 13 }}>{f.message}</div>
              <div className="sub mono" style={{ fontSize: 11 }}>{f.scanner} · {f.rule}{f.path ? ` · ${f.path}` : ""}</div>
            </div>
          </div>
        ))}

        {/* Anti-virus (ClamAV): expandable raw result, shown even when nothing was flagged so the
            reviewer can see exactly what the engine returned per file. */}
        {data.scanReport && data.scanReport.status !== "pending" && data.scanReport.status !== "unreachable" && (
          <div style={{ marginTop: issues.length ? 8 : 0, border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
            <button
              type="button"
              onClick={() => setAvOpen((o) => !o)}
              aria-expanded={avOpen}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", background: "var(--surface-2)", border: 0, cursor: "pointer", textAlign: "left", color: "var(--ink)" }}
            >
              <span aria-hidden className="muted" style={{ fontSize: 11, width: 12 }}>{avOpen ? "▾" : "▸"}</span>
              <span style={{ fontWeight: 500, fontSize: 13 }}>Anti-virus (ClamAV)</span>
              <Pill tone={avThreats.length ? "danger" : avUnavailable || !avRan ? "muted" : "ok"}>{avStatus}</Pill>
            </button>
            {avOpen && (
              <div style={{ padding: "10px 14px", borderTop: "1px solid var(--line)", fontSize: 12.5 }}>
                {avRan ? (
                  <div className="rows" style={{ border: 0 }}>
                    {avFindings.map((f, i) => (
                      <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "4px 0" }}>
                        <span className="mono" style={{ color: f.rule === "malware" ? "var(--danger)" : "var(--faint)", fontSize: 11, flexShrink: 0 }}>
                          {f.rule === "malware" ? "FOUND" : f.rule === "scanner-unavailable" ? "ERROR" : "OK"}
                        </span>
                        <span className="mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>{f.path ?? "—"}</span>
                        <span className="muted" style={{ fontSize: 11.5, marginLeft: "auto", textAlign: "right" }}>{f.message}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted" style={{ margin: 0 }}>
                    ClamAV did not run for this scan — no anti-virus engine is configured on this instance. Set
                    <span className="mono"> CLAMAV_HOST</span> on the worker to enable per-file AV scanning.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Discussion: who submitted + the review chat (submitter ∪ reviewers ∪ maintainers). */}
      <ReviewDiscussion proposalId={data.id} card={data.submitterCard} initialConversationId={data.conversationId} />

      {/* Revisions */}
      <hr className="divider" />
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, marginBottom: 14 }}>History</h2>
      <div className="rows">
        {data.revisions.map((r) => (
          <div className="row" key={r.revisionNo}>
            <span className="chip mono">rev {r.revisionNo}</span>
            <div className="grow"><div className="sub">{r.note ?? "—"}</div></div>
            <span className="muted mono" style={{ fontSize: 11 }}>{fmt.dateTime(r.createdAt)}</span>
          </div>
        ))}
      </div>
      {data.decisionReason && (
        <div className="card card-pad" style={{ marginTop: 16, borderColor: "color-mix(in oklab, var(--danger) 30%, var(--line))" }}>
          <div className="nav-label" style={{ padding: 0, marginBottom: 6 }}>Decision reason</div>
          {data.decisionReason}
        </div>
      )}

      {/* Actions */}
      {data.caps.isReviewer && data.allowedActions.length > 0 && (
        <>
          <hr className="divider" />
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, marginBottom: 12 }}>Decision</h2>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note / reason (required for reject & change requests)…"
            rows={3}
            style={{ width: "100%", padding: 12, borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 14, resize: "vertical" }}
          />
          {data.allowedActions.includes("accept") && needsOverride && (
            <label style={{ display: "flex", gap: 9, alignItems: "flex-start", marginTop: 12, fontSize: 13.5, color: "var(--danger)" }}>
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} style={{ marginTop: 2 }} />
              Override the <strong style={{ margin: "0 4px" }}>{sev}</strong> scan finding and publish anyway (audit-logged).
            </label>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            {data.allowedActions.map((a) => (
              <button
                key={a}
                className={`btn ${a === "accept" ? "btn-primary" : a === "reject" ? "btn-danger" : ""}`}
                disabled={busy !== null || (a === "accept" && needsOverride && !override)}
                onClick={() => act(a)}
              >
                {busy === a ? "…" : ACTION_LABEL[a] ?? a}
              </button>
            ))}
          </div>
          {msg && <div style={{ marginTop: 14, fontSize: 13.5, color: msg.kind === "err" ? "var(--danger)" : "var(--ok)" }}>{msg.text}</div>}
        </>
      )}

      {/* Proposer resubmit — when a reviewer requested changes, the submitter revises (✎ Edit above:
          details, files, version) and resubmits for another review. §8. Shown only to a non-reviewer
          submitter (a reviewer-submitter uses the Decision block above, which already lists resubmit). */}
      {!data.caps.isReviewer && data.caps.isSubmitter && data.allowedActions.includes("resubmit") && (
        <>
          <hr className="divider" />
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, marginBottom: 12 }}>Update &amp; resubmit</h2>
          <p className="muted" style={{ fontSize: 13.5, marginBottom: 12 }}>
            Address the requested changes — use <span className="mono">✎ Edit</span> above to revise the details, replace the files, or bump the version — then resubmit for review.
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for the reviewers (what you changed)… optional"
            rows={3}
            style={{ width: "100%", padding: 12, borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 14, resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            <button className="btn btn-primary" disabled={busy !== null || uploading} onClick={() => act("resubmit")}>
              {busy === "resubmit" ? "…" : "Resubmit for review"}
            </button>
          </div>
          {msg && <div style={{ marginTop: 14, fontSize: 13.5, color: msg.kind === "err" ? "var(--danger)" : "var(--ok)" }}>{msg.text}</div>}
        </>
      )}
    </div>
  );
}

/** Rich "who submitted this" card for reviewers/maintainers — contact + context. §24 */
function SubmitterCardView({ card, onMessage }: { card: SubmitterCard; onMessage: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(card.email).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  return (
    <div className="card card-pad" style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
      <UserBubble name={card.displayName} avatar={card.avatar} userId={card.userId} size={40} />
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontWeight: 600 }}>{card.displayName} <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>· submitted by</span></div>
        <div className="muted" style={{ fontSize: 12.5 }}>{card.role} · {card.priorSubmissions} submission{card.priorSubmissions === 1 ? "" : "s"} to date</div>
        <div className="mono" style={{ fontSize: 12, marginTop: 4, display: "flex", alignItems: "center", gap: 8 }}>
          <a href={`mailto:${card.email}`}>{card.email}</a>
          <button type="button" className="btn-ghost" onClick={copy} style={{ fontSize: 11 }}>{copied ? "copied ✓" : "copy"}</button>
        </div>
      </div>
      <button type="button" className="btn btn-sm" onClick={onMessage}>Message</button>
    </div>
  );
}

/** Submitter card + the review chat thread (submitter ∪ reviewers ∪ maintainers). §24 */
function ReviewDiscussion({ proposalId, card, initialConversationId }: { proposalId: string; card: SubmitterCard | null; initialConversationId: string | null }) {
  const [thread, setThread] = useState<{ conversationId: string | null; canPost: boolean; closed: boolean; messages: ChatMessage[] } | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/proposals/${proposalId}/messages`);
    if (!r.ok) return;
    const t = await r.json();
    setThread(t);
    if (t.conversationId) fetch(`/api/messages/${t.conversationId}/read`, { method: "POST" }).catch(() => {});
  }, [proposalId]);

  useEffect(() => { void load(); }, [load]);
  // Poll for new replies at the chat floor interval set[0] while the page is open (§24).
  const pollIntervals = useChatPollIntervals();
  useEffect(() => {
    const secs = pollIntervals[0] ?? 7;
    const id = setInterval(() => { if (!document.hidden) void load(); }, secs * 1000);
    return () => clearInterval(id);
  }, [load, pollIntervals]);

  const send = async (body: string) => {
    const r = await fetch(`/api/proposals/${proposalId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
    if (r.ok) { const { message } = await r.json(); setThread((t) => (t ? { ...t, messages: [...t.messages, message] } : t)); void load(); }
  };

  // Hide the whole section only when there's genuinely nothing to show (no card AND no thread access).
  if (!card && !thread) return null;
  void initialConversationId; // server hint; the GET above is authoritative

  return (
    <>
      <hr className="divider" />
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, marginBottom: 14 }}>Discussion</h2>
      {card && <SubmitterCardView card={card} onMessage={() => threadRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })} />}
      <div ref={threadRef} className="card card-pad" style={{ marginTop: 14 }}>
        <div className="nav-label" style={{ padding: 0, marginBottom: 10 }}>Review chat</div>
        {thread ? (
          <ChatBox messages={thread.messages} canPost={thread.canPost} closed={thread.closed} onSend={send} emptyHint="No messages yet — start the discussion about this proposal." />
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
        )}
      </div>
    </>
  );
}

export default function ProposalDetailPage() {
  return (
    <RequireAuth>
      <ProposalDetailInner />
    </RequireAuth>
  );
}
