"use client";
// The already-installed prompt (SKILLY_SPEC.md §23): shown when a personal mint finds the caller
// already holds a claimed install of the skill. Three choices — Go to skill (highlight it on
// Installed skills; mints nothing), Override (uninstall those installs and mint, one transaction),
// Install anyway (mint alongside, today's behavior) — plus Esc / ✕ / backdrop to cancel (mints
// nothing). Used by the skill detail page and the Installed page's successor panel (§45.5).
import { Modal } from "./ui";
import { useDateFmt } from "./DateFormat";
import type { ExistingInstall } from "../lib/installMint";

export function AlreadyInstalledDialog({
  title,
  installs,
  busy,
  error,
  onGoTo,
  onOverride,
  onInstallAnyway,
  onCancel,
}: {
  /** The skill's display title. */
  title: string;
  installs: ExistingInstall[];
  busy: boolean;
  error: string | null;
  onGoTo: () => void;
  onOverride: () => void;
  onInstallAnyway: () => void;
  onCancel: () => void;
}) {
  const fmt = useDateFmt();
  const many = installs.length > 1;
  return (
    <Modal
      title={`You already have ${title} installed`}
      // Not while a choice is in flight — its result (a new command, or an error) must stay on screen.
      onCancel={() => { if (!busy) onCancel(); }}
      dismissOnBackdrop
      footer={
        <>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onGoTo} data-testid="already-installed-goto">
            Go to skill
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onOverride} data-testid="already-installed-override">
            Override
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onInstallAnyway} data-testid="already-installed-anyway">
            Install anyway
          </button>
        </>
      }
    >
      <div data-testid="already-installed-dialog" style={{ display: "grid", gap: 12, fontSize: 13.5 }}>
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
          {installs.map((i) => (
            <li key={i.id} className="mono" style={{ fontSize: 12.5 }}>
              {i.pinnedSemver ? `pinned v${i.pinnedSemver}` : "latest"} · installed {fmt.date(i.installedAt)} · {i.inactive ? "inactive" : "active"}
            </li>
          ))}
        </ul>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          <strong>Go to skill</strong> shows {many ? "them" : "it"} in Installed skills.{" "}
          <strong>Override</strong> uninstalls {many ? `all ${installs.length}` : "it"} and generates a new command — the
          existing URL{many ? "s stop" : " stops"} working immediately, so an agent using {many ? "them" : "it"} must re-run
          the new command. <strong>Install anyway</strong> generates a new command and keeps {many ? "them" : "it"}.
        </div>
        {error && <div role="alert" style={{ fontSize: 13, color: "var(--danger)" }}>{error}</div>}
      </div>
    </Modal>
  );
}
