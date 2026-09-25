"use client";
// Browser side of the feedback survey's trigger (SKILLY_SPEC.md §36.1 / §36.3). A page calls
// `reportFeatureUse(key)` right after a feature's defining action SUCCEEDS. The call carries
// `canShow` — whether this tab could display a survey this instant — which the app shell provides
// (What's new wins, the Quick start gate, a card already open). When the server opens an offer,
// the shell hears it through the `skilly:survey-offer` window event and shows the card.
import type { SurveyFeatureKey, SurveyOfferView } from "@skilly/shared/survey";

export const SURVEY_OFFER_EVENT = "skilly:survey-offer";
/** The account menu / profile button asking the shell to reopen the open offer. */
export const SURVEY_REOPEN_EVENT = "skilly:survey-reopen";
/** The survey opt-out changed (detail `{ enabled }`) — the shell drops any open offer on `false`. */
export const SURVEY_PREF_EVENT = "skilly:surveys-pref-changed";

let canShow: () => boolean = () => false;

/** Registered by AppShell: can this tab show a survey card right now? */
export function setSurveyCanShow(fn: () => boolean): void {
  canShow = fn;
}

// Features already reported from this tab. The server records a first use only once anyway; this
// just saves a request for repeat actions (every leaderboard visit, every search).
const REPORTED_KEY = "skilly.survey.reported";
const reported = new Set<string>();
function alreadyReported(feature: string): boolean {
  if (reported.has(feature)) return true;
  try {
    return (sessionStorage.getItem(REPORTED_KEY) ?? "").split(",").includes(feature);
  } catch {
    return false;
  }
}
function markReported(feature: string): void {
  reported.add(feature);
  try {
    const cur = (sessionStorage.getItem(REPORTED_KEY) ?? "").split(",").filter(Boolean);
    if (!cur.includes(feature)) sessionStorage.setItem(REPORTED_KEY, [...cur, feature].join(","));
  } catch { /* storage blocked — the in-memory set still dedupes this page's lifetime */ }
}

// Page-view features (the leaderboard, a hall, a search from the URL) report on mount — before the
// shell has read /api/me and decided about What's new. Until it has, reports wait here so `canShow`
// is evaluated against the real state instead of consuming the trigger on a blind "no".
let ready = false;
const queued: SurveyFeatureKey[] = [];

/** Called by AppShell once `/api/me` has resolved and the What's new decision is made. */
export function setSurveyReady(): void {
  if (ready) return;
  ready = true;
  for (const f of queued.splice(0)) send(f);
}

/** Fire-and-forget: record a feature's use and maybe receive a survey offer. Never throws. */
export function reportFeatureUse(feature: SurveyFeatureKey): void {
  if (typeof window === "undefined" || alreadyReported(feature)) return;
  markReported(feature);
  if (!ready) {
    queued.push(feature);
    return;
  }
  send(feature);
}

function send(feature: SurveyFeatureKey): void {
  fetch("/api/me/features/used", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feature, canShow: canShow() }),
  })
    .then((r) => (r.ok ? (r.json() as Promise<{ survey: SurveyOfferView | null }>) : null))
    .then((j) => {
      if (j?.survey) window.dispatchEvent(new CustomEvent<SurveyOfferView>(SURVEY_OFFER_EVENT, { detail: j.survey }));
    })
    .catch(() => {});
}

/** Ask the shell to reopen the currently open offer (the "Take the survey" entries, §36.5). */
export function reopenSurvey(): void {
  window.dispatchEvent(new Event(SURVEY_REOPEN_EVENT));
}

/** The profile's "Give feedback now" asking the shell to start an on-demand survey (§36.16). */
export const SURVEY_START_EVENT = "skilly:survey-start";
/** The shell's survey state changed (an offer opened or ended, the cooldown moved): re-read /api/me. */
export const SURVEY_STATE_EVENT = "skilly:survey-state";

/** Ask the shell to start an on-demand survey ("Give feedback now", §36.16). */
export function startFeedback(): void {
  window.dispatchEvent(new Event(SURVEY_START_EVENT));
}
