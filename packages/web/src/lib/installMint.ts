// Client-side helper for minting an install command through POST /api/skills/:ns/:slug/install
// (SKILLY_SPEC.md §23), shared by the skill detail page and the Installed page's successor panel.
// Both send `onExisting: "ask"` first; a 409 `already_installed` is not an error but the trigger for
// the already-installed prompt, whose choices re-post with "replace" (Override) or "keep" (Install
// anyway). The response interpretation is a pure function so it is unit-testable.

/** One of the caller's existing installs, as the 409 lists it. */
export interface ExistingInstall {
  id: string;
  pinnedSemver: string | null;
  installedAt: string;
  expiresAt: string | null;
  inactive: boolean;
}

export interface MintedInstall {
  command: string;
  semver: string | null;
  expiresAt: string | null;
  system?: boolean;
}

export type MintOutcome =
  | { kind: "minted"; install: MintedInstall }
  | { kind: "already_installed"; installs: ExistingInstall[] }
  | { kind: "error"; message: string };

export type OnExisting = "keep" | "ask" | "replace";

/** Map the install endpoint's status + JSON body to what the UI does next. */
export function interpretInstallResponse(status: number, body: unknown, fallback = "Failed to generate the install command"): MintOutcome {
  const j = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status === 409 && j.error === "already_installed" && Array.isArray(j.installs)) {
    return { kind: "already_installed", installs: j.installs as ExistingInstall[] };
  }
  if (status >= 200 && status < 300 && typeof j.command === "string") {
    return {
      kind: "minted",
      install: {
        command: j.command,
        semver: typeof j.semver === "string" ? j.semver : null,
        expiresAt: typeof j.expiresAt === "string" ? j.expiresAt : null,
        system: j.system === true,
      },
    };
  }
  return { kind: "error", message: typeof j.error === "string" ? j.error : fallback };
}

/** POST the mint and interpret the answer. Never throws for an HTTP error — it comes back as `error`. */
export async function requestInstall(
  namespaceSlug: string,
  skillSlug: string,
  body: { semver: string | null; expiresAt: string | null; system?: boolean; onExisting: OnExisting },
): Promise<MintOutcome> {
  const r = await fetch(`/api/skills/${namespaceSlug}/${skillSlug}/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return interpretInstallResponse(r.status, await r.json().catch(() => ({})));
}
