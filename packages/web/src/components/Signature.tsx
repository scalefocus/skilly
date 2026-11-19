"use client";
// A version's signature on the skill page (SKILLY_SPEC.md §73.8): the badge in the versions list
// (Signed · Signed (backfill) · Signature pending · Signed by a revoked key: re-signing) and the
// details under it — the copyable installer `computedHash` with its keyId, Download signed statement,
// and the version's variants, each named by its rewrites with its own download.
import { useEffect, useState } from "react";
import { Pill } from "./ui";
import { CopyLine } from "./CopyLine";
import { useDateFmt } from "./DateFormat";
import {
  kindNote,
  signatureBadge,
  statementDownloadUrl,
  statementFileName,
  statementUrl,
  variantName,
  type StatementEntry,
  type StatementResponse,
  type VersionSignature,
} from "../lib/verifyFiles";

export function SignatureBadge({ sig }: { sig: VersionSignature | null }) {
  const fmt = useDateFmt();
  const b = signatureBadge(sig, fmt.date);
  const state = !sig ? "pending" : sig.keyStatus === "revoked" ? "revoked" : sig.kind;
  return (
    <span title={b.title} data-testid="signature-badge" data-state={state}>
      <Pill tone={b.tone}>{b.label}</Pill>
    </span>
  );
}

/** The expanded signature details of one version row. Variants are fetched only when there are some. */
export function SignatureDetails({ ns, slug, semver, sig }: { ns: string; slug: string; semver: string; sig: VersionSignature }) {
  const fmt = useDateFmt();
  const [variants, setVariants] = useState<StatementEntry[] | null>(null);
  const [variantsErr, setVariantsErr] = useState(false);
  useEffect(() => {
    if (sig.variants <= 0) return;
    let live = true;
    fetch(statementUrl(ns, slug, semver), { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<StatementResponse>) : null))
      .then((j) => {
        if (!live) return;
        if (j) setVariants(j.statements.filter((s) => s.variant));
        else setVariantsErr(true);
      })
      .catch(() => live && setVariantsErr(true));
    return () => {
      live = false;
    };
  }, [ns, slug, semver, sig.variants]);

  const note = kindNote(sig.kind, fmt.date(sig.signedAt));
  return (
    <div data-testid="signature-details">
      <CopyLine
        label={`computedHash · key ${sig.keyId}`}
        value={sig.computedHash}
        hint={`${note ?? `Signed on ${fmt.date(sig.signedAt)}.`} Compare it with the computedHash in your skills-lock.json.`}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
        <a className="btn btn-sm" href={statementDownloadUrl(ns, slug, semver)} download={statementFileName(slug, semver)} data-testid="download-statement">
          ↓ Download signed statement
        </a>
        <span className="muted mono" style={{ fontSize: 11 }}>{statementFileName(slug, semver)}</span>
      </div>
      {sig.variants > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="muted mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>
            Variants skilly served
          </div>
          {variantsErr ? (
            <div className="muted" style={{ fontSize: 12.5 }}>Couldn&rsquo;t load the variants.</div>
          ) : !variants ? (
            <div className="skeleton" style={{ height: 14, width: "60%" }} />
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
              {variants.map((v) => (
                <li key={v.variant!.inputsSha256} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12.5 }} data-testid="signature-variant">
                  <span>{variantName(v.variant!)}</span>
                  <span className="muted mono" style={{ fontSize: 11 }}>signed {fmt.date(v.signedAt)}</span>
                  <a className="btn-ghost mono" style={{ fontSize: 11.5 }} href={statementDownloadUrl(ns, slug, semver, v.variant)} download={statementFileName(slug, semver, v.variant)}>
                    ↓ {statementFileName(slug, semver, v.variant)}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
