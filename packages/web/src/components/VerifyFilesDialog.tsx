"use client";
// Verify files (SKILLY_SPEC.md §73.7, §73.8): check an installed folder, or a downloaded bundle,
// against a version's signed statement. Opened from the skill page (each version row and the Install
// card) and from Installed skills; /verify reuses the picker and the report below.
//
// Everything is read and hashed HERE with WebCrypto — no file and no hash is sent to skilly, except
// a mismatch report the user chooses to send (paths, statuses and hashes only, §73.11). The
// signature is checked in the browser with Ed25519; a browser without it shows skilly's own result
// ("Signature checked by skilly"). The decisions live in lib/verifyFiles.ts (unit-tested).
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ed25519Supported, MAX_VERIFY_FILES, type LocalFile, type Verdict } from "@skilly/shared/attestation";
import { isInstallerExcludedPath, sha256Hex } from "@skilly/shared/external-tool";
import { Modal, useApi } from "./ui";
import { useDateFmt } from "./DateFormat";
import { fmtSize } from "../lib/uploadError";
import {
  baseStatement,
  bundleMessage,
  bundleVerdict,
  checkStatements,
  countsLine,
  decideVerification,
  fileNote,
  hashFolder,
  isBundleName,
  kindNote,
  movedNote,
  prepareFolder,
  reportBody,
  signatureLine,
  statementUrl,
  statusNote,
  verdictHeadline,
  FILE_STATUS_LABEL,
  FILE_STATUS_TONE,
  MAX_REPORT_NOTE,
  type BundleResult,
  type CheckedStatement,
  type PickedFile,
  type SignatureCheckedBy,
  type SigningKeysDocument,
  type StatementResponse,
  type Tone,
} from "../lib/verifyFiles";

/** The propose page's fallback until /api/me answers (the platform default bundle cap, §6). */
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const EXCLUDED_DIRS = new Set([".git", "__pycache__", "__pypackages__"]);

export const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--ok)",
  warn: "var(--warn, #b45309)",
  danger: "var(--danger)",
  muted: "var(--muted)",
};

/** The platform bundle cap from /api/me (the same number the propose page enforces). */
export function useMaxBundleBytes(): number {
  const { data } = useApi<{ maxBundleBytes?: number }>("/api/me");
  return typeof data?.maxBundleBytes === "number" ? data.maxBundleBytes : DEFAULT_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// The statement (fetched once per dialog / per /verify match)
// ---------------------------------------------------------------------------

export type StatementState =
  | { kind: "loading" }
  | { kind: "pending" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; resp: StatementResponse; checked: CheckedStatement[]; checkedBy: SignatureCheckedBy };

export type ReadyStatement = Extract<StatementState, { kind: "ready" }>;

/** Fetch a version's statements and the public keys, and check every signature. */
export function useSignedStatement(ns: string, slug: string, semver: string): StatementState {
  const [state, setState] = useState<StatementState>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    (async () => {
      const r = await fetch(statementUrl(ns, slug, semver), { cache: "no-store" });
      if (r.status === 409) return void (live && setState({ kind: "pending" }));
      if (r.status === 404) return void (live && setState({ kind: "missing" }));
      const resp = (await r.json().catch(() => null)) as (StatementResponse & { error?: string }) | null;
      if (!r.ok || !resp) throw new Error(resp?.error ?? `Couldn't load the signed statement (${r.status}).`);
      // The public keys are only needed when this browser can verify Ed25519 itself.
      let keys: SigningKeysDocument | null = null;
      if (await ed25519Supported()) {
        const kr = await fetch("/.well-known/skilly-signing-keys.json").catch(() => null);
        keys = kr?.ok ? ((await kr.json().catch(() => null)) as SigningKeysDocument | null) : null;
      }
      const checked = await checkStatements(resp, keys);
      if (live) setState({ kind: "ready", resp, checked, checkedBy: keys ? "browser" : "server" });
    })().catch((e: unknown) => {
      if (live) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      live = false;
    };
  }, [ns, slug, semver]);
  return state;
}

/** The non-ready states, in words. Null when ready. */
export function StatementStatus({ state, semver }: { state: StatementState; semver: string }) {
  if (state.kind === "ready") return null;
  if (state.kind === "loading") {
    return (
      <div className="muted" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
        <span className="spinner" aria-hidden /> Loading the signed statement…
      </div>
    );
  }
  if (state.kind === "pending") {
    return (
      <div className="card card-pad" role="status" data-testid="verify-pending" style={{ fontSize: 13.5 }}>
        <strong>Signature pending.</strong> v{semver} has no signed statement yet, so there is nothing to check against. skilly signs it shortly; try again later.
      </div>
    );
  }
  return (
    <div role="alert" style={{ fontSize: 13.5, color: "var(--danger)" }} data-testid="verify-error">
      {state.kind === "missing" ? `v${semver} doesn't exist, or you can't see it.` : state.message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Picking a folder or a bundle
// ---------------------------------------------------------------------------

export interface FolderInfo {
  top: string | null;
  skipped: number;
  hasSkillMd: boolean;
  totalBytes: number;
}

type Item = { path: string; size: number; file: File };

/** `<input webkitdirectory>` is not in React's attribute types; a plain lowercase attribute passes through. */
const DIRECTORY_ATTRS = { webkitdirectory: "", directory: "" } as Record<string, string>;

function fileFrom(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/**
 * Walk dropped entries into a flat file list. The installer's excluded folders are not entered, and
 * the walk stops as soon as the caps are passed, so dropping a huge folder by mistake is refused
 * quickly instead of being listed in full.
 */
async function walkEntries(entries: FileSystemEntry[], maxBytes: number): Promise<{ items: Item[] } | { error: string }> {
  const items: Item[] = [];
  let bytes = 0;
  const visit = async (entry: FileSystemEntry): Promise<string | null> => {
    if (entry.isFile) {
      const file = await fileFrom(entry as FileSystemFileEntry);
      items.push({ path: entry.fullPath, size: file.size, file });
      if (!isInstallerExcludedPath(entry.fullPath)) bytes += file.size;
      if (items.length > MAX_VERIFY_FILES * 2) return `This folder has more than ${MAX_VERIFY_FILES.toLocaleString("en")} files, so it wasn't checked. Pick the skill's own folder.`;
      if (bytes > maxBytes) return `This folder is bigger than the allowed size of ${fmtSize(maxBytes)}, so it wasn't checked.`;
      return null;
    }
    if (!entry.isDirectory || EXCLUDED_DIRS.has(entry.name)) return null;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await readBatch(reader);
      if (batch.length === 0) return null;
      for (const e of batch) {
        const stop = await visit(e);
        if (stop) return stop;
      }
    }
  };
  for (const e of entries) {
    const stop = await visit(e);
    if (stop) return { error: stop };
  }
  return { items };
}

/**
 * The folder picker + drop zone. A folder is capped and filtered (lib/verifyFiles `prepareFolder`)
 * before any byte is read; a single bundle file goes to `onBundle` when the caller checks bundles.
 */
export function FolderPicker({
  onFolder,
  onBundle,
  maxBytes,
  bundleHint,
}: {
  onFolder: (files: PickedFile[], info: FolderInfo) => void;
  /** Accept a dropped/picked bundle (.zip, .tar.gz/.tgz, .skill) — the dialog does, /verify doesn't. */
  onBundle?: (file: File) => void;
  maxBytes: number;
  /** What to say when a bundle is dropped and `onBundle` is not set. */
  bundleHint?: string;
}) {
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const acceptItems = async (items: Item[]) => {
    const prepared = prepareFolder(items, { maxBytes });
    if (!prepared.ok) return setErr(prepared.error);
    setReading(true);
    try {
      const files = await Promise.all(prepared.files.map(async (f) => ({ path: f.path, bytes: new Uint8Array(await f.file.arrayBuffer()) })));
      onFolder(files, { top: prepared.top, skipped: prepared.skipped, hasSkillMd: prepared.hasSkillMd, totalBytes: prepared.totalBytes });
    } catch {
      setErr("Couldn't read every file in this folder. Check that you can open them, then pick it again.");
    } finally {
      setReading(false);
    }
  };

  const acceptBundle = (file: File) => {
    if (!onBundle) return setErr(bundleHint ?? "Pick or drop the skill's folder, not a bundle file.");
    if (file.size > maxBytes) return setErr(`This file is ${fmtSize(file.size)}, bigger than the allowed size of ${fmtSize(maxBytes)}, so it wasn't checked.`);
    onBundle(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    setErr(null);
    // Entries must be taken while the drop event is live; the walk itself is async.
    const list = Array.from(e.dataTransfer.items).filter((i) => i.kind === "file");
    const entries = list.map((i) => (typeof i.webkitGetAsEntry === "function" ? i.webkitGetAsEntry() : null));
    const files = Array.from(e.dataTransfer.files);
    if (entries.length === 0) return;
    // One file (or a browser that can't describe entries): a bundle, or a mistake.
    if (entries.length === 1 && (entries[0]?.isFile || (!entries[0] && files.length === 1))) {
      const f = files[0];
      if (f && isBundleName(f.name)) return acceptBundle(f);
      if (entries[0]?.isFile) return setErr(onBundle ? "Drop the skill's folder, or a bundle file (.zip, .tar.gz, .tgz or .skill)." : "Drop the skill's folder.");
    }
    if (entries.some((x) => !x)) return setErr("This browser can't read a dropped folder. Use Choose folder instead.");
    setReading(true);
    void walkEntries(entries as FileSystemEntry[], maxBytes)
      .then((r) => {
        setReading(false);
        if ("error" in r) setErr(r.error);
        else void acceptItems(r.items);
      })
      .catch(() => {
        setReading(false);
        setErr("Couldn't read the dropped folder. Use Choose folder instead.");
      });
  };

  return (
    <div
      className={`dropzone${drag ? " drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
      data-testid="verify-dropzone"
    >
      <svg className="dropzone-ico" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
      <div className="dropzone-lead">{reading ? "Reading the files…" : onBundle ? "Drag & drop the skill's folder, or a bundle file, here" : "Drag & drop the skill's folder here"}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
        <label className="filepick-btn">
          Choose folder
          <input
            type="file"
            multiple
            {...DIRECTORY_ATTRS}
            hidden
            disabled={reading}
            data-testid="verify-folder-input"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = ""; // picking the same folder again still fires
              setErr(null);
              if (picked.length === 0) return setErr("This folder is empty.");
              void acceptItems(picked.map((f) => ({ path: f.webkitRelativePath || f.name, size: f.size, file: f })));
            }}
          />
        </label>
        {onBundle && (
          <label className="filepick-btn">
            Choose bundle file
            <input
              type="file"
              accept=".zip,.tgz,.gz,.skill"
              hidden
              disabled={reading}
              data-testid="verify-bundle-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                setErr(null);
                if (f) acceptBundle(f);
              }}
            />
          </label>
        )}
      </div>
      {err ? (
        <span role="alert" style={{ color: "var(--danger)", fontSize: 12.5 }} data-testid="verify-pick-error">{err}</span>
      ) : (
        <span className="dropzone-hint">read and hashed in your browser · up to {fmtSize(maxBytes)}</span>
      )}
    </div>
  );
}

/** Where installed skills usually live (§73.7). */
export function WhereSkillsLive() {
  return (
    <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0", lineHeight: 1.55 }}>
      Installed skills usually live in <code className="mono">.agents/skills/&lt;name&gt;</code> or{" "}
      <code className="mono">.claude/skills/&lt;name&gt;</code> inside a project, or in{" "}
      <code className="mono">~/.claude/skills/&lt;name&gt;</code> for your user. A symlinked agent folder can be picked
      directly. Folders starting with a dot may be hidden in the picker (on macOS, Cmd+Shift+. shows them).
    </p>
  );
}

// ---------------------------------------------------------------------------
// The report for a folder
// ---------------------------------------------------------------------------

type Hashed = { local: LocalFile[]; computedHash: string };

/** Hash a picked folder once (raw + LF digests and the installer computedHash). */
export function useHashedFolder(files: PickedFile[] | null): Hashed | { error: string } | null {
  const [out, setOut] = useState<Hashed | { error: string } | null>(null);
  useEffect(() => {
    setOut(null);
    if (!files) return;
    let live = true;
    hashFolder(files)
      .then((h) => live && setOut(h))
      // WebCrypto exists only in a secure context (https, or localhost).
      .catch(() => live && setOut({ error: "This browser couldn't hash the files. Open skilly over https and try again." }));
    return () => {
      live = false;
    };
  }, [files]);
  return out;
}

function Line({ tone, children, testId }: { tone: Tone; children: React.ReactNode; testId?: string }) {
  return (
    <div style={{ fontSize: 13, color: TONE_COLOR[tone], marginTop: 6 }} data-testid={testId}>
      {children}
    </div>
  );
}

/** Status beside the verdict, with a link to the latest stable version (§73.7). */
function StatusBeside({ ns, slug, semver, status, matched, latest }: { ns: string; slug: string; semver: string; status: string; matched: boolean; latest: string | null | undefined }) {
  const note = statusNote(status, semver, matched);
  // /verify doesn't know the latest version — ask the skill page's API, only for a withdrawn version.
  const { data } = useApi<{ latest: string | null }>(note && latest === undefined ? `/api/skills/${encodeURIComponent(ns)}/${encodeURIComponent(slug)}` : null);
  if (!note) return null;
  const target = latest === undefined ? data?.latest ?? null : latest;
  return (
    <Line tone="warn" testId="verify-status">
      {note}{" "}
      {target && target !== semver && (
        <Link href={`/skills/${ns}/${slug}#version-${target}`} style={{ fontWeight: 600 }}>
          Go to the latest stable version, v{target} →
        </Link>
      )}
    </Line>
  );
}

/** The statement-level notes: signature, backfill/re-sign, moved since. */
function StatementNotes({ statement, checkedBy, ns, slug }: { statement: CheckedStatement | null; checkedBy: SignatureCheckedBy; ns: string; slug: string }) {
  const fmt = useDateFmt();
  if (!statement) return null;
  const sig = signatureLine(statement.signature, checkedBy);
  const kind = kindNote(statement.entry.kind, fmt.date(statement.entry.signedAt));
  const moved = movedNote(statement, ns, slug);
  return (
    <>
      <Line tone={sig.tone} testId="verify-signature">
        {sig.text} · key <span className="mono">{statement.entry.keyId}</span>
      </Line>
      {kind && <Line tone="muted">{kind}</Line>}
      {moved && <Line tone="muted" testId="verify-moved">{moved}</Line>}
    </>
  );
}

/**
 * The verdict for a hashed folder against one version (§73.7): the headline, the signature and the
 * status beside it, the notes, the per-file table, and Report to platform admins on a change.
 */
export function FolderReport({
  ns,
  slug,
  semver,
  statement,
  hashed,
  info,
  latest,
}: {
  ns: string;
  slug: string;
  semver: string;
  statement: ReadyStatement;
  hashed: { local: LocalFile[]; computedHash: string };
  info: FolderInfo;
  /** The latest stable version, when the caller knows it (undefined = look it up if needed). */
  latest?: string | null;
}) {
  const outcome = useMemo(
    () => decideVerification(hashed.local, hashed.computedHash, statement.resp, statement.checked),
    [hashed, statement],
  );
  const { verdict } = outcome;
  const head = verdictHeadline(outcome, semver);
  return (
    <div className="card card-pad" style={{ marginTop: 14 }} data-testid="verify-report">
      <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 600, color: TONE_COLOR[head.tone] }} data-testid="verify-verdict" data-overall={verdict.overall}>
        {head.text}
      </div>
      <StatementNotes statement={outcome.statement} checkedBy={statement.checkedBy} ns={ns} slug={slug} />
      <StatusBeside ns={ns} slug={slug} semver={semver} status={statement.resp.status} matched={verdict.overall === "match"} latest={latest} />
      {outcome.otherVersion && outcome.otherVersion.status !== "active" && (
        <Line tone="warn">{statusNote(outcome.otherVersion.status, outcome.otherVersion.semver, true)}</Line>
      )}
      {!info.hasSkillMd && <Line tone="warn">There is no SKILL.md at the top of this folder. Did you pick the skill&rsquo;s own folder?</Line>}
      <div className="muted mono" style={{ fontSize: 11.5, marginTop: 10 }}>
        {info.top ? `${info.top}/ · ` : ""}
        {countsLine(verdict.counts)}
        {info.skipped > 0 ? ` · ${info.skipped} skipped (the installer never copies metadata.json, .git, __pycache__ or __pypackages__)` : ""}
      </div>
      <FileTable verdict={verdict} />
      {verdict.overall === "changed" && <ReportToAdmins ns={ns} slug={slug} semver={semver} verdict={verdict} />}
    </div>
  );
}

function FileTable({ verdict }: { verdict: Verdict }) {
  const cell: React.CSSProperties = { padding: "6px 10px", borderBottom: "1px solid var(--line)", textAlign: "left", verticalAlign: "top" };
  return (
    <div style={{ marginTop: 10, maxHeight: 320, overflow: "auto", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }} data-testid="verify-files">
        <thead>
          <tr className="muted mono" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em" }}>
            <th style={cell}>File</th>
            <th style={cell}>Status</th>
          </tr>
        </thead>
        <tbody>
          {verdict.files.map((f) => {
            const note = fileNote(f);
            return (
              <tr key={f.path} data-testid="verify-file" data-status={f.status}>
                <td className="mono" style={{ ...cell, overflowWrap: "anywhere" }}>{f.path}</td>
                <td style={{ ...cell, whiteSpace: "nowrap", color: TONE_COLOR[FILE_STATUS_TONE[f.status]] }}>
                  {FILE_STATUS_LABEL[f.status]}
                  {note && <div className="muted" style={{ fontSize: 11.5, whiteSpace: "normal" }}>{note}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** §73.11: an opt-in report to the platform admins — paths, statuses and hashes, never contents. */
function ReportToAdmins({ ns, slug, semver, verdict }: { ns: string; slug: string; semver: string; verdict: Verdict }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch(`${statementUrl(ns, slug, semver)}/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reportBody(verdict, note)),
      });
      if (r.ok) {
        setResult({ ok: true, text: "Reported. The platform admins were notified." });
        setOpen(false);
      } else if (r.status === 429) {
        setResult({ ok: false, text: "You've sent 10 reports in the last hour, the most allowed. Try again later." });
      } else {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setResult({ ok: false, text: j.error ?? `Couldn't send the report (${r.status}).` });
      }
    } catch {
      setResult({ ok: false, text: "Couldn't send the report. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  };
  if (result?.ok) {
    return <div role="status" style={{ marginTop: 12, fontSize: 13, color: "var(--ok)" }} data-testid="verify-report-sent">{result.text}</div>;
  }
  return (
    <div style={{ marginTop: 12 }}>
      {!open ? (
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)} data-testid="verify-report-open">
          Report to platform admins…
        </button>
      ) : (
        <div style={{ padding: "10px 12px", background: "var(--surface-2)", borderRadius: "var(--radius-sm)" }}>
          <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>
            Sends {`v${semver}`}, the verdict and each file&rsquo;s path, status and hash to the platform admins. Never the files&rsquo; contents. Most mismatches are local edits; report one when you didn&rsquo;t expect it.
          </p>
          <label className="field-label" htmlFor="verify-report-note" style={{ fontSize: 12.5 }}>Note (optional)</label>
          <textarea
            id="verify-report-note"
            className="input"
            rows={3}
            maxLength={MAX_REPORT_NOTE}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ width: "100%", resize: "vertical", fontSize: 13 }}
            data-testid="verify-report-note"
          />
          <div className="muted mono" style={{ fontSize: 10.5, textAlign: "right" }}>{note.length} / {MAX_REPORT_NOTE}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void send()} data-testid="verify-report-send">
              {busy ? "Sending…" : "Send report"}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
      {result && !result.ok && <div role="alert" style={{ marginTop: 8, fontSize: 13, color: "var(--danger)" }} data-testid="verify-report-error">{result.text}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The report for a bundle file
// ---------------------------------------------------------------------------

function BundleReport({ semver, statement, file }: { semver: string; statement: ReadyStatement; file: File }) {
  const [res, setRes] = useState<{ sha: string; result: BundleResult } | { error: string } | null>(null);
  const base = baseStatement(statement.checked);
  useEffect(() => {
    let live = true;
    setRes(null);
    file
      .arrayBuffer()
      .then((b) => sha256Hex(new Uint8Array(b)))
      .then((sha) => live && setRes({ sha, result: bundleVerdict(sha, base) }))
      .catch(() => live && setRes({ error: "Couldn't read this file." }));
    return () => {
      live = false;
    };
  }, [file, base]);
  if (!res) {
    return (
      <div className="muted" style={{ fontSize: 13, marginTop: 14, display: "flex", alignItems: "center", gap: 8 }}>
        <span className="spinner" aria-hidden /> Hashing {file.name}…
      </div>
    );
  }
  if ("error" in res) return <div role="alert" style={{ marginTop: 14, fontSize: 13, color: "var(--danger)" }}>{res.error}</div>;
  const msg = bundleMessage(res.result, semver);
  const sig = base ? signatureLine(base.signature, statement.checkedBy) : null;
  return (
    <div className="card card-pad" style={{ marginTop: 14 }} data-testid="verify-bundle-report" data-result={res.result}>
      <div style={{ fontSize: 14.5, fontWeight: 600, color: TONE_COLOR[msg.tone] }} data-testid="verify-bundle-verdict">{msg.text}</div>
      {sig && <Line tone={sig.tone} testId="verify-signature">{sig.text}</Line>}
      <div className="muted mono" style={{ fontSize: 11, marginTop: 8, overflowWrap: "anywhere" }}>
        {file.name} · sha256 {res.sha}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

type Picked = { kind: "folder"; files: PickedFile[]; info: FolderInfo } | { kind: "bundle"; file: File };

export function VerifyFilesDialog({
  ns,
  slug,
  semver,
  title,
  latest,
  onClose,
}: {
  /** The skill's CURRENT namespace and slug (the statement may name an older owner, §73.3). */
  ns: string;
  slug: string;
  semver: string;
  title?: string;
  /** The latest stable version, linked when the checked one is yanked or quarantined. */
  latest?: string | null;
  onClose: () => void;
}) {
  const maxBytes = useMaxBundleBytes();
  const statement = useSignedStatement(ns, slug, semver);
  const [picked, setPicked] = useState<Picked | null>(null);
  const folderFiles = picked?.kind === "folder" ? picked.files : null;
  const hashed = useHashedFolder(folderFiles);
  const fmt = useDateFmt();
  const base = statement.kind === "ready" ? baseStatement(statement.checked) : null;

  return (
    <Modal
      title={`Verify files: ${title ?? slug} v${semver}`}
      onCancel={onClose}
      wide
      testId="verify-files-dialog"
      footer={
        <>
          <span className="muted modal-foot-start" style={{ fontSize: 12.5 }}>
            Not sure which skill or version a folder is? <Link href="/verify" onClick={onClose}>Open Verify</Link>
          </span>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </>
      }
    >
      <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
        Check a copy of <strong className="mono">{ns}/{slug}</strong> against the statement skilly signed for v{semver}. Every file is read and
        hashed here, in your browser: no file and no hash is sent to skilly.
      </p>
      <StatementStatus state={statement} semver={semver} />
      {statement.kind === "ready" && (
        <>
          {base && !picked && (
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }} data-testid="verify-statement-summary">
              {signatureLine(base.signature, statement.checkedBy).text} · signed {fmt.date(base.entry.signedAt)} · key <span className="mono">{base.entry.keyId}</span>
              {statement.checked.length > 1 ? ` · ${statement.checked.length - 1} ${statement.checked.length === 2 ? "variant" : "variants"}` : ""}
            </div>
          )}
          {picked ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: 13 }}>
                {picked.kind === "folder" ? `${picked.info.top ?? "Folder"} · ${picked.files.length} ${picked.files.length === 1 ? "file" : "files"} · ${fmtSize(picked.info.totalBytes)}` : picked.file.name}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setPicked(null)} data-testid="verify-pick-again">Check another folder or file</button>
            </div>
          ) : (
            <>
              <FolderPicker
                maxBytes={maxBytes}
                onFolder={(files, info) => setPicked({ kind: "folder", files, info })}
                onBundle={(file) => setPicked({ kind: "bundle", file })}
              />
              <WhereSkillsLive />
            </>
          )}
          {picked?.kind === "folder" &&
            (hashed && "error" in hashed ? (
              <div role="alert" style={{ marginTop: 14, fontSize: 13, color: "var(--danger)" }}>{hashed.error}</div>
            ) : hashed ? (
              <FolderReport ns={ns} slug={slug} semver={semver} statement={statement} hashed={hashed} info={picked.info} latest={latest} />
            ) : (
              <div className="muted" style={{ fontSize: 13, marginTop: 14, display: "flex", alignItems: "center", gap: 8 }}>
                <span className="spinner" aria-hidden /> Hashing {picked.files.length} {picked.files.length === 1 ? "file" : "files"}…
              </div>
            ))}
          {picked?.kind === "bundle" && <BundleReport semver={semver} statement={statement} file={picked.file} />}
        </>
      )}
    </Modal>
  );
}
