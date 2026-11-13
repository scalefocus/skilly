"use client";
// The shared marketplace add-command panel (SKILLY_SPEC.md §30.4 / §30.6): rendered identically by
// the Marketplaces directory's inline Install panel and by Namespace administration once a mint has
// happened. A tab strip offers the three routes of §30.4 — Terminal · Claude CLI · Settings file —
// each with a Copy button that copies ONLY that route's runnable text. Switching tabs never mints:
// every route's text was composed server-side from the one token the Generate click minted.
//
// Terminal is the default because it is the one route that works everywhere (the Claude desktop
// app's Code tab cannot run `/plugin`). The chosen tab is remembered per browser under ONE key
// shared by both pages — a consumer has a preferred tooling.
import { useState } from "react";
import {
  DEFAULT_MARKETPLACE_ADD_ROUTE,
  MARKETPLACE_ADD_ROUTES,
  MARKETPLACE_ADD_ROUTE_LABELS,
  parseMarketplaceAddRoute,
  type MarketplaceAddRoute,
} from "@skilly/shared/plugin-marketplace"; // client-safe subpath: the root export pulls in node-only modules
import { CopyLine } from "./CopyLine";
import { UsageKeyBlock, type MintedUsageKey } from "./UsageShare";
import { PREF_MARKETPLACE_ADD_ROUTE, readPref, writePref } from "../lib/prefs";
import { reportFeatureUse } from "../lib/surveyClient";

/** §21 "Plugin deliveries are not adoption": said wherever a marketplace's add command is shown,
 *  and on the Added marketplaces page, so nobody expects their leaderboard numbers to move. */
export const MARKETPLACE_LEADERBOARD_NOTE =
  "Adding a marketplace delivers every skill in it. Those deliveries do not count on the leaderboard; install a skill on its own to count it.";

/** §36.3 copying a marketplace add command is the `marketplaces` feature's first use. */
const reportMarketplaceUse = () => reportFeatureUse("marketplaces");

/** The mint response (`POST /api/marketplaces/tokens`, §30.8) — every route's text for one token. */
export interface MarketplaceMint {
  name: string;
  /** Claude CLI route: `/plugin marketplace add <token-in-URL>`. */
  command: string;
  /** Terminal route: `claude plugin marketplace add <token-in-URL>`. */
  shellCommand: string;
  /** Settings-file route: `extraKnownMarketplaces` JSON with the credential-free URL. */
  settingsSnippet: string;
  /** The `git config … insteadOf` rewrite carrying the token. */
  gitConfigCommand: string;
  /** Credential-free twins the disclosures pair with the rewrite. */
  plainCommand: string;
  plainShellCommand: string;
  expiresAt: string | null;
  /** §68.4 — present only when Share usage was ticked and the caller held no key. */
  usageKey?: MintedUsageKey;
}

const DISCLOSURE_HINT =
  "Claude Code turns off git credential helpers for background marketplace updates, so a URL rewrite carries the key instead.";

export function MarketplaceAddCommand({ minted }: { minted: MarketplaceMint }) {
  // Read synchronously: this panel only ever renders after a client-side mint, never during SSR,
  // so the stored value cannot cause a hydration mismatch.
  const [route, setRoute] = useState<MarketplaceAddRoute>(
    () => parseMarketplaceAddRoute(readPref(PREF_MARKETPLACE_ADD_ROUTE, "")) ?? DEFAULT_MARKETPLACE_ADD_ROUTE,
  );
  const pick = (r: MarketplaceAddRoute) => {
    setRoute(r);
    writePref(PREF_MARKETPLACE_ADD_ROUTE, r);
  };

  return (
    <div className="mk-add" data-route={route}>
      <div className="srctabs" role="tablist" aria-label="How to add this marketplace" style={{ marginTop: 10 }}>
        {MARKETPLACE_ADD_ROUTES.map((r) => (
          <button
            key={r}
            type="button"
            role="tab"
            aria-selected={route === r}
            className={`srctab${route === r ? " active" : ""}`}
            style={{ padding: "7px 12px", fontSize: 13 }}
            onClick={() => pick(r)}
          >
            {MARKETPLACE_ADD_ROUTE_LABELS[r]}
          </button>
        ))}
      </div>

      {route === "terminal" && (
        <>
          <CopyLine onCopied={reportMarketplaceUse}
            label="Run in any terminal — including the Claude desktop app's Terminal panel"
            value={minted.shellCommand}
          />
          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ fontSize: 12.5, cursor: "pointer" }}>If background updates fail</summary>
            <CopyLine onCopied={reportMarketplaceUse}
              label="Run the git config line once, then add with the credential-free URL"
              value={`${minted.gitConfigCommand}\n${minted.plainShellCommand}`}
              hint={DISCLOSURE_HINT}
            />
          </details>
        </>
      )}

      {route === "cli" && (
        <>
          <CopyLine onCopied={reportMarketplaceUse} label="Run inside an interactive Claude Code session" value={minted.command} />
          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ fontSize: 12.5, cursor: "pointer" }}>If background updates fail</summary>
            <CopyLine onCopied={reportMarketplaceUse}
              label="Run the git config line once, then add with the credential-free URL"
              value={`${minted.gitConfigCommand}\n${minted.plainCommand}`}
              hint={DISCLOSURE_HINT}
            />
          </details>
        </>
      )}

      {route === "settings" && (
        <CopyLine onCopied={reportMarketplaceUse}
          label="Run the git config line once, then add the entry to your settings file"
          value={`${minted.gitConfigCommand}\n${minted.settingsSnippet}`}
          hint="The entry carries no key on purpose — settings files get committed. Put it in ~/.claude/settings.json for yourself, or in the project's .claude/settings.json to share it with the team; the git config line supplies the key on this machine."
        />
      )}

      {/* §21 — plugin deliveries are reach, not adoption: say so next to the command. */}
      <p className="muted" data-testid="mk-leaderboard-note" style={{ fontSize: 12.5, marginTop: 10 }}>
        {MARKETPLACE_LEADERBOARD_NOTE}
      </p>

      {/* §68.4 — the second block: the usage key, once, when Share usage was ticked. */}
      {minted.usageKey && <UsageKeyBlock usageKey={minted.usageKey} />}
    </div>
  );
}
