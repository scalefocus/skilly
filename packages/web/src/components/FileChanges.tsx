"use client";
// Shared file-change renderer: the added / modified / removed / unchanged list plus click-to-expand
// unified line diffs. ONE component behind both surfaces (SKILLY_SPEC.md §8/§10):
//   - the reviewer view of a pending proposal   (/api/proposals/:id/changes)
//   - the published per-version view on a skill (/api/skills/:ns/:slug/versions/:semver/changes)
// Both endpoints speak the same wire shape; the differences (what an unavailable result means, what
// an unchanged file can show, whether per-file download exists) ride in as props.
//
// Mounting triggers the fetch, so a caller that renders this only when a row is expanded pays
// nothing until then.
import { useCallback, useState, type ReactNode } from "react";
import { useApi, Pill } from "./ui";

export type ChangeStatus = "added" | "modified" | "removed" | "unchanged";
export interface ChangeFile { path: string; status: ChangeStatus; isText: boolean; size: number }
export interface ChangesResp {
  available: boolean;
  /** Reviewer view: why the proposed side couldn't be read. Published view: "first" | "pending" | "error". */
  kind?: string;
  reason?: string;
  detail?: string;
  baselineSemver?: string | null;
  added?: number; modified?: number; removed?: number; unchanged?: number;
  files?: ChangeFile[];
}
export interface DiffLineJ { type: "context" | "add" | "del"; text: string; oldLine: number | null; newLine: number | null }
export interface DiffHunkJ { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLineJ[] }
export interface FileDiffResp { path: string; status: ChangeStatus; isText: boolean; diff?: { hunks: DiffHunkJ[]; added: number; removed: number }; tooLarge?: boolean; binary?: boolean }

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function StatusBadge({ status }: { status: ChangeStatus }) {
  if (status === "added") return <Pill tone="ok">added</Pill>;
  if (status === "modified") return <Pill tone="warn">modified</Pill>;
  if (status === "removed") return <Pill tone="danger">removed</Pill>;
  return <span className="muted mono" style={{ fontSize: 10.5 }}>unchanged</span>;
}

/** Unified line diff: hunk headers + colored +/- lines (React escapes the text). */
export function DiffView({ diff }: { diff: { hunks: DiffHunkJ[]; added: number; removed: number } }) {
  if (!diff.hunks.length) return <p className="muted" style={{ fontSize: 13, margin: 0 }}>No line changes.</p>;
  return (
    <pre className="mono" style={{ fontSize: 12, lineHeight: 1.5, padding: 0, background: "var(--surface-2)", borderRadius: "var(--radius-sm)", overflow: "auto", maxHeight: 460, margin: 0 }}>
      {diff.hunks.map((h, hi) => (
        <div key={hi}>
          <div style={{ color: "var(--faint)", padding: "2px 10px", background: "var(--surface)" }}>@@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</div>
          {h.lines.map((l, li) => (
            <div key={li} style={{ background: l.type === "add" ? "rgba(46,160,67,0.16)" : l.type === "del" ? "rgba(248,81,73,0.18)" : "transparent", color: l.type === "context" ? "var(--muted)" : "var(--ink)", padding: "0 10px", whiteSpace: "pre" }}>
              {l.type === "add" ? "+" : l.type === "del" ? "-" : " "}{l.text}
            </div>
          ))}
        </div>
      ))}
    </pre>
  );
}

interface FileChangeListProps {
  /** Endpoint returning the summary; `?path=` is appended for a single file's diff. */
  changesUrl: string;
  /** Raw contents of an UNCHANGED file, when the surface can serve them (review bundle browser). */
  rawUrl?: (path: string) => string;
  /** Per-file download link, when the surface has one. */
  downloadUrl?: (path: string) => string;
  /** Shown when an unchanged file is opened but `rawUrl` isn't available. */
  unchangedNote?: string;
  /** What to say when the endpoint reports `available: false`. */
  unavailableNote: (data: ChangesResp | null) => ReactNode;
  /** Right-hand baseline caption; defaults to "vs v<baseline>". */
  baselineLabel?: (baselineSemver: string | null) => string;
  /** Line shown when nothing was added/modified/removed. */
  allUnchangedNote?: (baselineSemver: string) => string;
}

export function FileChangeList({ changesUrl, rawUrl, downloadUrl, unchangedNote, unavailableNote, baselineLabel, allUnchangedNote }: FileChangeListProps) {
  const { data, loading, error } = useApi<ChangesResp>(changesUrl);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ kind: "diff"; body: FileDiffResp } | { kind: "raw"; body: string } | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewErr, setViewErr] = useState<string | null>(null);

  const open = useCallback(async (f: ChangeFile) => {
    if (openPath === f.path) { setOpenPath(null); setDetail(null); setViewErr(null); return; }
    setOpenPath(f.path); setDetail(null); setViewErr(null); setViewLoading(true);
    try {
      if (f.status === "unchanged") {
        if (!rawUrl) { setViewErr(unchangedNote ?? "Unchanged."); return; }
        const r = await fetch(rawUrl(f.path));
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`);
        setDetail({ kind: "raw", body: await r.text() });
      } else {
        const r = await fetch(`${changesUrl}${changesUrl.includes("?") ? "&" : "?"}path=${encodeURIComponent(f.path)}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`);
        setDetail({ kind: "diff", body: (await r.json()) as FileDiffResp });
      }
    } catch (e) {
      setViewErr(String((e as Error).message ?? e));
    } finally {
      setViewLoading(false);
    }
  }, [changesUrl, rawUrl, unchangedNote, openPath]);

  if (loading) return <p className="muted" style={{ fontSize: 13 }}>Loading changes…</p>;
  if (error) return <p className="muted" style={{ fontSize: 13 }}>Couldn’t load changes: {error}</p>;
  if (!data?.available) return <p className="muted" style={{ fontSize: 13.5 }}>{unavailableNote(data ?? null)}</p>;

  const rank = (s: ChangeStatus) => (s === "unchanged" ? 1 : 0);
  const files = [...(data.files ?? [])].sort((a, b) => rank(a.status) - rank(b.status) || a.path.localeCompare(b.path));
  const anyChange = (data.added ?? 0) + (data.modified ?? 0) + (data.removed ?? 0) > 0;
  const baseline = data.baselineSemver ?? null;
  const caption = baselineLabel ? baselineLabel(baseline) : baseline ? `vs v${baseline}` : "";
  // An unchanged file is only clickable where its contents can actually be shown.
  const canOpen = (f: ChangeFile) => f.isText && (f.status !== "unchanged" || !!rawUrl);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12, fontSize: 13 }}>
        <span style={{ color: "var(--ok)" }}>+{data.added ?? 0} added</span>
        <span style={{ color: "var(--warn)" }}>~{data.modified ?? 0} modified</span>
        <span style={{ color: "var(--danger)" }}>−{data.removed ?? 0} removed</span>
        <span className="muted">· {data.unchanged ?? 0} unchanged</span>
        <span style={{ flex: 1 }} />
        <span className="muted mono" style={{ fontSize: 11.5 }}>{caption}</span>
      </div>
      {!anyChange && baseline && (
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          {allUnchangedNote ? allUnchangedNote(baseline) : `Files unchanged — this version reuses v${baseline}’s files.`}
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 2, border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", padding: 6 }}>
        {files.map((f) => {
          const isOpen = openPath === f.path;
          return (
            <div key={f.path}>
              <div
                onClick={() => canOpen(f) && open(f)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderRadius: "var(--radius-sm)", cursor: canOpen(f) ? "pointer" : "default", background: isOpen ? "var(--surface-2)" : "transparent" }}
              >
                <StatusBadge status={f.status} />
                <span className="mono" style={{ fontSize: 12.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: f.status === "removed" ? "line-through" : undefined, opacity: f.status === "removed" ? 0.75 : 1 }}>{f.path}</span>
                {!f.isText && <span className="muted mono" style={{ fontSize: 10 }}>binary</span>}
                <span className="muted mono" style={{ fontSize: 10.5 }}>{humanSize(f.size)}</span>
                {downloadUrl && f.status !== "removed" && (
                  <a href={downloadUrl(f.path)} onClick={(e) => e.stopPropagation()} className="btn-ghost mono" style={{ fontSize: 10.5, padding: "1px 6px" }} title="Download this file">↓</a>
                )}
              </div>
              {isOpen && (
                <div style={{ padding: "6px 8px 10px" }}>
                  {viewLoading ? (
                    <p className="muted" style={{ fontSize: 13, margin: 0 }}>Loading…</p>
                  ) : viewErr ? (
                    <p className="muted" style={{ fontSize: 13, margin: 0 }}>{viewErr}</p>
                  ) : detail?.kind === "raw" ? (
                    <pre className="mono" style={{ fontSize: 12, lineHeight: 1.5, padding: "10px 12px", background: "var(--surface-2)", borderRadius: "var(--radius-sm)", overflow: "auto", maxHeight: 460, margin: 0, whiteSpace: "pre", color: "var(--ink)" }}>{detail.body}</pre>
                  ) : detail?.kind === "diff" ? (
                    detail.body.binary ? (
                      <p className="muted" style={{ fontSize: 13, margin: 0 }}>Binary file — download to compare.</p>
                    ) : detail.body.tooLarge ? (
                      <p className="muted" style={{ fontSize: 13, margin: 0 }}>Too large to diff — download to compare.</p>
                    ) : detail.body.diff ? (
                      <DiffView diff={detail.body.diff} />
                    ) : (
                      <p className="muted" style={{ fontSize: 13, margin: 0 }}>No diff available.</p>
                    )
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
