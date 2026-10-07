"use client";
// The §44.6 draft dialog: the plan (what will be sent, removed, skipped) → a streamed run with
// per-file progress → per-file results with a diff and an Include checkbox → "Open in propose
// form", which assembles the kept changes into a staged bundle (§44.7) and hands it to the
// new-version propose form through sessionStorage. Results live only in this component: closing
// discards them (after a confirm). All model output is rendered as escaped plain text.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Pill } from "../../../../components/ui";
import { DiffView, type DiffHunkJ } from "../../../../components/FileChanges";

export const AI_DRAFT_HANDOFF_KEY = "skilly.aiDraft";

interface PlanFile {
  path: string;
  status: "queued" | "delete" | "skipped";
  reason?: string;
  reasonText?: string;
  findings: string[];
}

interface FileResult {
  path: string;
  status: "modified" | "deleted" | "unchanged" | "failed";
  summary: string;
  addressed: string[];
  reason?: string;
  reasonText?: string;
  content?: string;
  diff?: { hunks: DiffHunkJ[]; added: number; removed: number } | null;
}

type Phase = "loading" | "plan" | "running" | "results" | "assembling";

const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "muted" | "accent"> = {
  modified: "accent",
  deleted: "warn",
  unchanged: "muted",
  failed: "danger",
  skipped: "muted",
};
const STATUS_LABEL: Record<string, string> = { modified: "Modified", deleted: "Remove", unchanged: "Unchanged", failed: "Failed", skipped: "Skipped" };

export function AiDraftDialog({
  ns,
  slug,
  base,
  semver,
  aiName,
  onClose,
}: {
  ns: string;
  slug: string;
  /** `/api/skills/<ns>/<slug>` */
  base: string;
  semver: string;
  aiName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [plan, setPlan] = useState<PlanFile[]>([]);
  const [baseSemver, setBaseSemver] = useState(semver);
  const [results, setResults] = useState<Map<string, FileResult>>(new Map());
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [include, setInclude] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<{ model: string | null; calls: number; runToken: string; outcome: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const abort = useRef<AbortController | null>(null);

  // Load the plan (no AI call).
  useEffect(() => {
    let live = true;
    fetch(`${base}/quality/draft/plan`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
        setPlan(j.files ?? []);
        setBaseSemver(j.baseSemver ?? semver);
        setPhase("plan");
      })
      .catch((e) => {
        if (!live) return;
        setErr(String((e as Error).message ?? e));
        setPhase("plan");
      });
    return () => {
      live = false;
    };
  }, [base, semver]);

  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => () => abort.current?.abort(), []);

  const generate = useCallback(async () => {
    setErr(null);
    setResults(new Map());
    setInclude(new Set());
    setDone(null);
    setPhase("running");
    setStarted(Date.now());
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const r = await fetch(`${base}/quality/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseSemver }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as { type: string } & Record<string, unknown>;
          if (ev.type === "plan") setPlan((ev.files as PlanFile[]) ?? []);
          else if (ev.type === "start") setWorking((w) => new Set(w).add(String(ev.path)));
          else if (ev.type === "file") {
            const f = ev as unknown as FileResult;
            if (!f.path) {
              setErr(f.reasonText ?? "the draft could not be completed");
              continue;
            }
            setWorking((w) => {
              const n = new Set(w);
              n.delete(f.path);
              return n;
            });
            setResults((m) => new Map(m).set(f.path, f));
            if (f.status === "modified" || f.status === "deleted") setInclude((s) => new Set(s).add(f.path));
          } else if (ev.type === "done") {
            setDone({ model: (ev.model as string | null) ?? null, calls: Number(ev.calls ?? 0), runToken: String(ev.runToken ?? ""), outcome: String(ev.outcome ?? "complete") });
          }
        }
      }
      setPhase("results");
    } catch (e) {
      if (ctrl.signal.aborted) {
        setErr("Cancelled — files already sent may still count as requests.");
      } else {
        setErr(String((e as Error).message ?? e));
      }
      setPhase("results");
    } finally {
      abort.current = null;
    }
  }, [base, baseSemver]);

  const kept = [...results.values()].filter((f) => (f.status === "modified" || f.status === "deleted") && include.has(f.path));
  const requests = done?.calls ?? [...results.values()].filter((f) => f.status !== "deleted" || f.summary !== "Removed OS / tooling junk").length;

  const close = () => {
    if (phase === "running") {
      if (!confirm(`Stop the ${aiName} draft? Files already sent may still count as requests.`)) return;
      abort.current?.abort();
    } else if (results.size > 0 && phase !== "assembling") {
      if (!confirm(`Discard the ${aiName} draft? It used ${requests} request${requests === 1 ? "" : "s"}.`)) return;
    }
    onClose();
  };

  const openInPropose = async () => {
    if (!done?.runToken || kept.length === 0) return;
    setPhase("assembling");
    setErr(null);
    try {
      const r = await fetch(`${base}/quality/draft/assemble`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runToken: done.runToken,
          baseSemver,
          changes: kept.map((f) => (f.status === "modified" ? { path: f.path, action: "modify", content: f.content, summary: f.summary } : { path: f.path, action: "delete", summary: f.summary })),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const details = Array.isArray(j.details) ? `: ${j.details.join("; ")}` : "";
        throw new Error(`${j.error ?? `HTTP ${r.status}`}${details}`);
      }
      const { aiDraftToken, whatChanged, model, ...upload } = j;
      try {
        sessionStorage.setItem(
          AI_DRAFT_HANDOFF_KEY,
          JSON.stringify({ ns, slug, baseSemver, aiDraftToken, whatChanged, model, upload }),
        );
      } catch {
        throw new Error("Your browser blocked session storage, so the draft can't be handed to the propose form.");
      }
      router.push(`/propose?newVersion=1&ns=${encodeURIComponent(ns)}&slug=${encodeURIComponent(slug)}&aiDraft=1`);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setPhase("results");
    }
  };

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, path: string) => {
    const n = new Set(set);
    if (n.has(path)) n.delete(path);
    else n.add(path);
    setter(n);
  };

  const sent = plan.filter((p) => p.status === "queued");
  const removed = plan.filter((p) => p.status === "delete");
  const skipped = plan.filter((p) => p.status === "skipped");
  const elapsed = started ? Math.round((now - started) / 1000) : 0;

  const footer =
    phase === "plan" ? (
      <>
        <button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!!err || (sent.length === 0 && removed.length === 0)} onClick={() => void generate()} data-testid="ai-draft-generate">
          Generate draft
        </button>
      </>
    ) : phase === "running" ? (
      <>
        <span className="muted mono modal-foot-start" style={{ fontSize: 12 }}>{results.size} / {sent.length + removed.length} files · {elapsed}s</span>
        <button type="button" className="btn btn-ghost" onClick={() => abort.current?.abort()}>Cancel</button>
      </>
    ) : phase === "results" || phase === "assembling" ? (
      <>
        <span className="muted mono modal-foot-start" style={{ fontSize: 12 }} data-testid="ai-draft-included">
          {kept.length} change{kept.length === 1 ? "" : "s"} included{done?.model ? ` · ${done.model}` : ""}
        </span>
        <button type="button" className="btn btn-ghost" onClick={close}>Discard</button>
        <button type="button" className="btn btn-primary" disabled={kept.length === 0 || phase === "assembling" || !done?.runToken} onClick={() => void openInPropose()} data-testid="ai-draft-open-propose">
          {phase === "assembling" ? "preparing…" : "Open in propose form"}
        </button>
      </>
    ) : null;

  return (
    <Modal title={`Draft improvements with ${aiName}`} onCancel={close} footer={footer} wide>
      <div data-testid="ai-draft-dialog">
        {err && <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 0 }} role="alert">{err}</p>}
        {phase === "loading" && <div className="skeleton" style={{ height: 120, borderRadius: "var(--radius)" }} />}

        {phase === "plan" && !err && (
          <>
            <p style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 0 }}>
              {aiName} will rewrite the files of <span className="mono">v{baseSemver}</span> that carry quality findings. You review every change
              before anything becomes a proposal. These files will be sent to {aiName}. Each file is one request.
            </p>
            <PlanList title={`Sent to ${aiName} (${sent.length})`} files={sent} testid="ai-draft-plan-sent" />
            {removed.length > 0 && <PlanList title={`Removed without a request (${removed.length})`} files={removed} testid="ai-draft-plan-removed" />}
            {skipped.length > 0 && <PlanList title={`Not drafted (${skipped.length})`} files={skipped} testid="ai-draft-plan-skipped" />}
          </>
        )}

        {(phase === "running" || phase === "results" || phase === "assembling") && (
          <div className="rows" data-testid="ai-draft-results">
            {[...sent, ...removed].map((p) => {
              const r = results.get(p.path);
              const isWorking = working.has(p.path);
              const keepable = r && (r.status === "modified" || r.status === "deleted");
              return (
                <div className="row" key={p.path} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }} data-testid="ai-draft-file" data-path={p.path} data-status={r?.status ?? (isWorking ? "working" : "queued")}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {keepable && (
                      <input
                        type="checkbox"
                        aria-label={`Include the change to ${p.path}`}
                        checked={include.has(p.path)}
                        disabled={phase !== "results"}
                        onChange={() => toggle(include, setInclude, p.path)}
                        data-testid="ai-draft-include"
                      />
                    )}
                    <span className="mono" style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>{p.path}</span>
                    {r ? (
                      <Pill tone={STATUS_TONE[r.status] ?? "muted"}>{STATUS_LABEL[r.status] ?? r.status}{r.status === "failed" && r.reasonText ? ` — ${r.reasonText}` : ""}</Pill>
                    ) : (
                      <Pill tone="muted">{isWorking ? "working…" : "queued"}</Pill>
                    )}
                    {r?.addressed?.length ? <span className="muted mono" style={{ fontSize: 11 }}>{r.addressed.join(" · ")}</span> : p.findings.length ? <span className="muted mono" style={{ fontSize: 11 }}>{p.findings.join(" · ")}</span> : null}
                    {r?.status === "modified" && r.diff && (
                      <button type="button" className="btn-ghost mono" style={{ fontSize: 11, marginLeft: "auto" }} aria-expanded={open.has(p.path)} onClick={() => toggle(open, setOpen, p.path)}>
                        {open.has(p.path) ? "▾ hide diff" : `▸ diff +${r.diff.added} −${r.diff.removed}`}
                      </button>
                    )}
                  </div>
                  {r?.summary && <p style={{ fontSize: 13, margin: 0, whiteSpace: "pre-wrap" }}>{r.summary}</p>}
                  {r?.status === "modified" && !r.diff && <p className="muted" style={{ fontSize: 12, margin: 0 }}>Too large to show a diff here.</p>}
                  {r?.status === "modified" && r.diff && open.has(p.path) && <DiffView diff={r.diff} />}
                </div>
              );
            })}
            {skipped.length > 0 && <PlanList title={`Not drafted (${skipped.length})`} files={skipped} testid="ai-draft-plan-skipped" />}
          </div>
        )}
      </div>
    </Modal>
  );
}

function PlanList({ title, files, testid }: { title: string; files: PlanFile[]; testid: string }) {
  return (
    <div style={{ marginTop: 12 }} data-testid={testid}>
      <div className="nav-label" style={{ padding: "0 0 6px" }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
        {files.map((f) => (
          <li key={f.path}>
            <span className="mono">{f.path}</span>
            {f.findings.length > 0 && <span className="muted mono" style={{ fontSize: 11 }}> · {f.findings.join(", ")}</span>}
            {f.reasonText && <span className="muted"> — {f.reasonText}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
