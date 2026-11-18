"use client";
// /verify (SKILLY_SPEC.md §73.7): check files against what skilly signed, without knowing which skill
// they are. Any signed-in user. Three tabs:
//   Folder           — hash a folder here, send ONLY its computedHash to /api/verify/lookup, then run
//                      the full check against the match (or let the user pick among several).
//   skills-lock.json — parse the lock here and send ONLY its computedHash values (a lock's sourceUrl
//                      can carry an install token); one row per lock entry.
//   Offline          — the openssl recipe with this instance's registry and the active key.
// A match the viewer can't see is never returned by the lookup (invariant #3).
import Link from "next/link";
import { Suspense, useEffect, useId, useState } from "react";
import { useSearchParams } from "next/navigation";
import { describeVariant, formatFingerprint, type LocalFile } from "@skilly/shared/attestation";
import { CopyCommand, EmptyState, Pill } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { useDateFmt } from "../../components/DateFormat";
import {
  FolderPicker,
  FolderReport,
  StatementStatus,
  WhereSkillsLive,
  useMaxBundleBytes,
  useSignedStatement,
  type FolderInfo,
} from "../../components/VerifyFilesDialog";
import {
  chunk,
  hashFolder,
  lockHashes,
  matchLabel,
  offlineRecipe,
  parseSkillsLock,
  type HashMatch,
  type LockEntry,
  type PickedFile,
  type SigningKeysDocument,
} from "../../lib/verifyFiles";

type Tab = "folder" | "lock" | "offline";
const TABS: { tab: Tab; label: string }[] = [
  { tab: "folder", label: "Folder" },
  { tab: "lock", label: "skills-lock.json" },
  { tab: "offline", label: "Offline" },
];
const LOOKUP_BATCH = 200;

type LookupResults = Map<string, HashMatch[]>;

/** POST the hashes (and nothing else) to the lookup API, 200 at a time. */
async function lookup(hashes: readonly string[]): Promise<LookupResults> {
  const out: LookupResults = new Map();
  for (const batch of chunk(hashes, LOOKUP_BATCH)) {
    const r = await fetch("/api/verify/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hashes: batch }) });
    const j = (await r.json().catch(() => null)) as { results?: { computedHash: string; matches: HashMatch[] }[]; error?: string } | null;
    if (r.status === 429) throw new Error("Too many lookups in a short time. Wait a minute and try again.");
    if (!r.ok || !j?.results) throw new Error(j?.error ?? `The lookup failed (${r.status}).`);
    for (const res of j.results) out.set(res.computedHash.toLowerCase(), res.matches);
  }
  return out;
}

function statusPill(status: string) {
  if (status === "yanked") return <Pill tone="danger">yanked</Pill>;
  if (status === "quarantined") return <Pill tone="danger">quarantined</Pill>;
  return <Pill tone="ok">active</Pill>;
}

function Verify() {
  const params = useSearchParams();
  const initial = params.get("tab");
  const [tab, setTab] = useState<Tab>(initial === "lock" || initial === "offline" ? initial : "folder");
  const tabsId = useId();
  return (
    <div style={{ maxWidth: 860 }}>
      <div className="page-head reveal">
        <div className="eyebrow">Signed versions</div>
        <h1 className="page-title">Verify files.</h1>
        <p className="page-sub">
          Every version skilly publishes carries a signed statement of its exact files. Check a folder or a skills-lock.json against it here.
          Files are read and hashed in your browser; only the installer&rsquo;s <span className="mono">computedHash</span> is sent, to find the version.
        </p>
      </div>
      <div className="srctabs" role="tablist" aria-label="What to verify" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.tab}
            type="button"
            role="tab"
            id={`${tabsId}-${t.tab}`}
            aria-selected={tab === t.tab}
            aria-controls={`${tabsId}-${t.tab}-panel`}
            className={`srctab${tab === t.tab ? " active" : ""}`}
            onClick={() => setTab(t.tab)}
            data-testid={`verify-tab-${t.tab}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${tabsId}-${tab}-panel`} aria-labelledby={`${tabsId}-${tab}`}>
        {tab === "folder" && <FolderTab />}
        {tab === "lock" && <LockTab />}
        {tab === "offline" && <OfflineTab />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Folder
// ---------------------------------------------------------------------------

type FolderState =
  | { kind: "idle" }
  | { kind: "hashing"; count: number }
  | { kind: "error"; message: string }
  | { kind: "done"; local: LocalFile[]; computedHash: string; info: FolderInfo; matches: HashMatch[] };

function FolderTab() {
  const maxBytes = useMaxBundleBytes();
  const [state, setState] = useState<FolderState>({ kind: "idle" });
  const [chosen, setChosen] = useState<HashMatch | null>(null);

  const onFolder = async (files: PickedFile[], info: FolderInfo) => {
    setChosen(null);
    setState({ kind: "hashing", count: files.length });
    try {
      const { local, computedHash } = await hashFolder(files);
      const res = await lookup([computedHash]);
      const matches = res.get(computedHash) ?? [];
      setState({ kind: "done", local, computedHash, info, matches });
      if (matches.length === 1) setChosen(matches[0]!);
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div data-testid="verify-folder-tab">
      {state.kind === "idle" || state.kind === "error" ? (
        <>
          <FolderPicker
            maxBytes={maxBytes}
            onFolder={(files, info) => void onFolder(files, info)}
            bundleHint="To check a bundle file, open the skill's page and use Verify files on its version."
          />
          <WhereSkillsLive />
          {state.kind === "error" && <p role="alert" style={{ color: "var(--danger)", fontSize: 13.5 }}>{state.message}</p>}
        </>
      ) : state.kind === "hashing" ? (
        <div className="muted" style={{ fontSize: 13.5, display: "flex", alignItems: "center", gap: 8 }}>
          <span className="spinner" aria-hidden /> Hashing {state.count} {state.count === 1 ? "file" : "files"} and looking them up…
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <span className="muted mono" style={{ fontSize: 11.5, overflowWrap: "anywhere" }} title="The installer's lock-v2 computedHash of this folder">
              {state.info.top ? `${state.info.top}/ · ` : ""}computedHash {state.computedHash}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => { setState({ kind: "idle" }); setChosen(null); }} data-testid="verify-pick-again">
              Check another folder
            </button>
          </div>
          {state.matches.length === 0 ? (
            <div className="card card-pad" role="status" data-testid="verify-no-match" style={{ fontSize: 13.5 }}>
              No skill you can see has exactly these files. If this is an installed skill, open its page and verify there to see which files changed.
            </div>
          ) : state.matches.length > 1 ? (
            <div className="card card-pad" data-testid="verify-several">
              <p style={{ margin: "0 0 8px", fontSize: 13.5 }}>These files are {state.matches.length} versions. Pick the one you installed:</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {state.matches.map((m) => {
                  const key = `${m.namespaceSlug}/${m.skillSlug}@${m.semver}#${m.variant?.inputsSha256 ?? ""}`;
                  const on = chosen && `${chosen.namespaceSlug}/${chosen.skillSlug}@${chosen.semver}#${chosen.variant?.inputsSha256 ?? ""}` === key;
                  return (
                    <button key={key} type="button" className={`btn btn-sm${on ? " btn-primary" : ""}`} aria-pressed={!!on} onClick={() => setChosen(m)} data-testid="verify-match-option">
                      {matchLabel(m)}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {chosen && <MatchCheck match={chosen} local={state.local} computedHash={state.computedHash} info={state.info} />}
        </>
      )}
    </div>
  );
}

/** The full §73.7 check against one lookup match. */
function MatchCheck({ match, local, computedHash, info }: { match: HashMatch; local: LocalFile[]; computedHash: string; info: FolderInfo }) {
  const statement = useSignedStatement(match.namespaceSlug, match.skillSlug, match.semver);
  const [hashed] = useState(() => ({ local, computedHash }));
  return (
    <div style={{ marginTop: 14 }} data-testid="verify-match">
      <div style={{ fontSize: 14 }}>
        <Link href={`/skills/${match.namespaceSlug}/${match.skillSlug}#version-${match.semver}`} style={{ fontWeight: 600 }}>{match.title}</Link>{" "}
        <span className="muted mono" style={{ fontSize: 12 }}>{match.namespaceSlug}/{match.skillSlug} v{match.semver}</span>
      </div>
      <div style={{ marginTop: 8 }}>
        <StatementStatus state={statement} semver={match.semver} />
      </div>
      {statement.kind === "ready" && (
        <FolderReport ns={match.namespaceSlug} slug={match.skillSlug} semver={match.semver} statement={statement} hashed={hashed} info={info} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// skills-lock.json
// ---------------------------------------------------------------------------

type LockState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "error"; message: string }
  | { kind: "done"; lockVersion: number | null; entries: LockEntry[]; results: LookupResults };

function LockTab() {
  const [text, setText] = useState("");
  const [drag, setDrag] = useState(false);
  const [state, setState] = useState<LockState>({ kind: "idle" });
  const inputId = useId();

  const check = async (raw: string) => {
    const parsed = parseSkillsLock(raw);
    if (!parsed.ok) return setState({ kind: "error", message: parsed.error });
    setState({ kind: "checking" });
    try {
      const hashes = lockHashes(parsed.entries);
      const results = hashes.length ? await lookup(hashes) : new Map<string, HashMatch[]>();
      setState({ kind: "done", lockVersion: parsed.lockVersion, entries: parsed.entries, results });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const loadFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return setState({ kind: "error", message: "This file is too large to be a skills-lock.json." });
    const t = await f.text();
    setText(t);
    void check(t);
  };

  return (
    <div data-testid="verify-lock-tab">
      <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
        Paste or drop a <span className="mono">skills-lock.json</span>. It is read here, and only its <span className="mono">computedHash</span> values are
        sent — a lock&rsquo;s <span className="mono">sourceUrl</span> can carry an install token. This checks the lock; <span className="mono">npx skills check</span>{" "}
        checks the folders against the lock.
      </p>
      <div
        className={`dropzone${drag ? " drag" : ""}`}
        style={{ alignItems: "stretch", textAlign: "left" }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void loadFile(e.dataTransfer.files[0]); }}
      >
        <label htmlFor={inputId} className="field-label" style={{ margin: 0 }}>skills-lock.json</label>
        <textarea
          id={inputId}
          className="input input-mono"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{ "version": 2, "skills": { … } }'
          spellCheck={false}
          style={{ width: "100%", resize: "vertical", fontSize: 12.5 }}
          data-testid="verify-lock-text"
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={!text.trim() || state.kind === "checking"} onClick={() => void check(text)} data-testid="verify-lock-check">
            {state.kind === "checking" ? "Checking…" : "Check"}
          </button>
          <label className="filepick-btn">
            Choose file
            <input type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void loadFile(f); }} />
          </label>
          <span className="dropzone-hint">or drop the file here</span>
        </div>
      </div>
      {state.kind === "error" && <p role="alert" style={{ color: "var(--danger)", fontSize: 13.5 }} data-testid="verify-lock-error">{state.message}</p>}
      {state.kind === "done" && <LockResults state={state} />}
    </div>
  );
}

function LockResults({ state }: { state: Extract<LockState, { kind: "done" }> }) {
  const cell: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--line)", textAlign: "left", verticalAlign: "top" };
  return (
    <div className="card" style={{ marginTop: 14, overflowX: "auto" }}>
      {state.lockVersion !== null && state.lockVersion < 2 && (
        <p className="muted" style={{ fontSize: 13, margin: "12px 14px 0" }}>This is a lock version {state.lockVersion} file, which carries no installer hash.</p>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }} data-testid="verify-lock-results">
        <thead>
          <tr className="muted mono" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em" }}>
            <th style={cell}>Lock entry</th>
            <th style={cell}>Signed version</th>
          </tr>
        </thead>
        <tbody>
          {state.entries.map((e, i) => {
            const matches = e.computedHash ? state.results.get(e.computedHash) ?? [] : null;
            return (
              <tr key={`${e.name}-${i}`} data-testid="verify-lock-row">
                <td className="mono" style={{ ...cell, overflowWrap: "anywhere" }}>{e.name}</td>
                <td style={cell}>
                  {matches === null ? (
                    <span className="muted">
                      No hash in this lock: run <code className="mono">npx skills install</code> with a current <code className="mono">skills</code> release
                    </span>
                  ) : matches.length === 0 ? (
                    <span className="muted">No visible match</span>
                  ) : (
                    <div style={{ display: "grid", gap: 4 }}>
                      {matches.map((m) => (
                        <div key={`${m.namespaceSlug}/${m.skillSlug}@${m.semver}#${m.variant?.inputsSha256 ?? ""}`} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <Link href={`/skills/${m.namespaceSlug}/${m.skillSlug}#version-${m.semver}`} className="mono">
                            {m.namespaceSlug}/{m.skillSlug}@{m.semver}
                          </Link>
                          {m.variant && <span className="muted" style={{ fontSize: 12 }}>{describeVariant(m.variant)}</span>}
                          {statusPill(m.status)}
                        </div>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

function OfflineTab() {
  const fmt = useDateFmt();
  const [doc, setDoc] = useState<SigningKeysDocument | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/.well-known/skilly-signing-keys.json")
      .then((r) => (r.ok ? (r.json() as Promise<SigningKeysDocument>) : Promise.reject(new Error(`Couldn't load the public keys (${r.status}).`))))
      .then((j) => live && setDoc(j))
      .catch((e: unknown) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);
  if (err) return <EmptyState icon="⚠" title="Couldn’t load the public keys" hint={err} />;
  if (!doc) return <div className="skeleton" style={{ height: 160, borderRadius: "var(--radius)" }} />;
  const active = doc.keys.find((k) => !k.retiredAt && !k.revokedAt) ?? null;
  const others = doc.keys.filter((k) => k !== active);
  return (
    <div data-testid="verify-offline-tab">
      <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
        Verify without skilly&rsquo;s help, with OpenSSL 3, <span className="mono">jq</span> and <span className="mono">sha256sum</span>.{" "}
        <span className="mono">statement.json</span> is a version&rsquo;s <em>Download signed statement</em> from its skill page.
      </p>
      <div className="card card-pad" style={{ marginBottom: 14 }} data-testid="verify-active-key">
        {active ? (
          <>
            <div style={{ fontSize: 13.5 }}>
              Active signing key <span className="mono" style={{ fontWeight: 600 }}>{active.keyId}</span>
              <span className="muted" style={{ fontSize: 12.5 }}> · registered {fmt.date(active.createdAt)}</span>
            </div>
            <div className="mono" style={{ fontSize: 12.5, marginTop: 6, overflowWrap: "anywhere" }} data-testid="verify-fingerprint">
              {formatFingerprint(active.fingerprint)}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Compare this fingerprint with the key you fetch in step 1.</div>
          </>
        ) : (
          <div style={{ fontSize: 13.5, color: "var(--warn, #b45309)" }}>No active signing key: publishing is paused until a platform admin configures one.</div>
        )}
        {others.length > 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            Older keys:{" "}
            {others.map((k, i) => (
              <span key={k.keyId}>
                {i > 0 ? ", " : ""}
                <span className="mono">{k.keyId}</span> ({k.revokedAt ? `revoked ${fmt.date(k.revokedAt)}` : `retired ${fmt.date(k.retiredAt)}`})
              </span>
            ))}
            . A statement signed by a retired key stays valid; one signed by a revoked key does not.
          </div>
        )}
      </div>
      <CopyCommand command={offlineRecipe(doc.registry, active?.keyId ?? null)} prompt={false} pin ariaLabel="Copy the offline verification recipe" />
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.55 }} data-testid="verify-autocrlf">
        On Windows with git&rsquo;s <span className="mono">core.autocrlf</span>, step 3 reports text files as failed, because their line endings were
        rewritten. Compare <span className="mono">lfSha256</span> there instead: build <span className="mono">SHA256SUMS</span> from{" "}
        <span className="mono">.lfSha256</span> and check a copy of the folder with LF line endings. The Folder tab and the Verify files dialog do this for you.
      </p>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <RequireAuth>
      {/* Verify reads ?tab= via useSearchParams — needs a Suspense boundary. */}
      <Suspense fallback={<div className="skeleton" style={{ height: 260, borderRadius: "var(--radius)" }} />}>
        <Verify />
      </Suspense>
    </RequireAuth>
  );
}
