"use client";
// The floating feedback-survey card (SKILLY_SPEC.md §36.4). Owned by AppShell and portaled to
// <body> like the What's new notice, so it survives client-side navigation. A NON-modal dialog: the
// page stays usable, nothing is focused on appearance, and Escape closes it only while focus is
// inside it. Height-capped (80vh, CSS) with the header and footer pinned and the question list the
// only scrolling child.
//
// An on-demand ("Give feedback now", §36.16) card heads its questions with a feature picker, and
// has no "Don't ask me again": the user asked for it.
//
// Bug mode (§36.17): the picker's Bug category hides every star question and turns the text box
// into a required "Describe the problem you found". The sidebar's bug button opens this card with Bug
// selected — with no offer behind it unless an on-demand one is already open. Picking another
// category on an offer-less card asks the shell to start an on-demand survey (`onNeedOffer`), unless
// the cooldown or a waiting random survey blocks it.
import { useEffect, useRef, useState } from "react";
import {
  SURVEY_BUG_CATEGORY,
  SURVEY_FREE_TEXT_MAX,
  isSurveyFeature,
  sanitizeBugPagePath,
  surveyFeatureLabel,
  surveyFeatureQuestions,
  surveyPickerOptions,
  type BugCardBlock,
  type SurveyOfferView,
  type SurveyVia,
} from "@skilly/shared/survey";
import { StarInput } from "./StarInput";
import { useDateFmt } from "./DateFormat";

type Phase = "form" | "starting" | "sending" | "thanks" | "expired";

const qid = (key: string) => `survey-q-${key.replace(/[^a-z0-9]/gi, "-")}`;
const chars = (s: string) => [...s].length;
const currentPath = () => (typeof window === "undefined" ? null : sanitizeBugPagePath(window.location.pathname));

/** What the shell's on-demand start gave an offer-less Bug card: the offer, or why it can't. */
export type NeedOfferResult = { ok: true } | { ok: false; block: BugCardBlock };

export function SurveyCard({
  offer,
  via,
  hidden,
  bugReports,
  initialBug = false,
  bugBlock = null,
  bugNonce = 0,
  onNeedOffer,
  onDismiss,
  onFinished,
  onOptOut,
}: {
  /** The open offer behind the card; null for a Bug card opened by the bug button with none (§36.17). */
  offer: SurveyOfferView | null;
  via: SurveyVia;
  /** Hidden (not unmounted) while the mobile nav drawer is open. */
  hidden: boolean;
  /** §36.17 bug reports are on: the picker lists Bug. */
  bugReports: boolean;
  /** §36.17 open with Bug selected. */
  initialBug?: boolean;
  /** §36.17 why an offer-less Bug card can't switch to another category (null = it can). */
  bugBlock?: BugCardBlock;
  /** §36.17 bumped by the shell when the bug button is clicked while this card is open: switch to Bug. */
  bugNonce?: number;
  /** §36.17 an offer-less card wants another category: start an on-demand survey. */
  onNeedOffer?: () => Promise<NeedOfferResult>;
  /** ✕ / Escape — "not now". The offer (if any) stays open behind the account menu. */
  onDismiss: () => void;
  /** The card is done: submitted, or the offer turned out to have expired. `endedOffer` = an offer was used up. */
  onFinished: (submitted: boolean, endedOffer: boolean) => void;
  /** "Don't ask me again" (not offered on an on-demand card). */
  onOptOut: () => void;
}) {
  const fmt = useDateFmt();
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  // The picker shows on an on-demand card and on an offer-less Bug card; a random offer has none.
  const self = offer === null || offer.trigger === "self";
  // §36.16 the picker's value: "" = skilly in general, "bug" = Bug (§36.17), else a feature key.
  const [picked, setPicked] = useState<string>(initialBug && bugReports ? SURVEY_BUG_CATEGORY : "");
  const bug = self && picked === SURVEY_BUG_CATEGORY;
  // §36.17 the page the problem was found on: captured when the card enters Bug mode.
  const [pagePath, setPagePath] = useState<string | null>(() => (initialBug ? currentPath() : null));
  // A start that lost a race (409 cooldown, or a random offer turned up) blocks switching from here on.
  const [blockOverride, setBlockOverride] = useState<BugCardBlock>(null);
  const block = offer === null ? (blockOverride ?? bugBlock) : null;
  const textRef = useRef<HTMLTextAreaElement>(null);
  // The offer this card's text belongs to when it was sent: a Bug report from an on-demand card ends it.
  const offerRef = useRef(offer);
  offerRef.current = offer;

  // The thank-you / expired states close themselves after ~4 s.
  const endedOffer = useRef(false);
  useEffect(() => {
    if (phase !== "thanks" && phase !== "expired") return;
    const t = setTimeout(() => onFinished(phase === "thanks", endedOffer.current), 4000);
    return () => clearTimeout(t);
  }, [phase, onFinished]);

  const enterBug = () => {
    setPicked(SURVEY_BUG_CATEGORY);
    setAnswers({}); // Bug hides every star question: switching to it discards them all.
    setPagePath(currentPath());
  };

  // §36.17 the bug button clicked while this card is open: switch to Bug (if not already) and focus.
  const lastNonce = useRef(bugNonce);
  useEffect(() => {
    if (bugNonce === lastNonce.current) return;
    lastNonce.current = bugNonce;
    if (!bugReports || !self) return;
    if (picked !== SURVEY_BUG_CATEGORY) enterBug();
    requestAnimationFrame(() => textRef.current?.focus());
  }, [bugNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bug reports switched off meanwhile: an on-demand card snaps back to "skilly in general".
  useEffect(() => {
    if (!bugReports && picked === SURVEY_BUG_CATEGORY) setPicked("");
  }, [bugReports, picked]);

  const answered = bug ? text.trim().length > 0 : Object.keys(answers).length > 0 || text.trim().length > 0;
  const general = bug || !offer ? [] : offer.questions.filter((q) => q.section === "general");
  const featureKey = self && isSurveyFeature(picked) ? picked : null;
  const feature = bug ? [] : self ? (featureKey ? surveyFeatureQuestions(featureKey) : []) : offer!.questions.filter((q) => q.section === "feature");
  const featureLabel = self ? (featureKey ? surveyFeatureLabel(featureKey) : null) : (offer?.feature?.label ?? null);

  // Changing or clearing the picked feature discards the stars of its questions.
  const pick = async (v: string) => {
    if (v === SURVEY_BUG_CATEGORY) {
      enterBug();
      return;
    }
    if (offer === null) {
      // §36.17 leaving Bug on an offer-less card starts an on-demand survey, if it may.
      if (block || !onNeedOffer) return;
      setPicked(v);
      setPhase("starting");
      const r = await onNeedOffer().catch((): NeedOfferResult => ({ ok: false, block: null }));
      setPhase("form");
      if (!r.ok) {
        setBlockOverride(r.block);
        setPicked(SURVEY_BUG_CATEGORY);
        if (!r.block) setError("Couldn’t start the survey. Try again.");
      }
      return;
    }
    setPicked(v);
    setAnswers((a) => Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith("feature."))));
  };

  const setAnswer = (key: string, v: number | null) =>
    setAnswers((a) => {
      const next = { ...a };
      if (v == null) delete next[key];
      else next[key] = v;
      return next;
    });

  const sendBug = async (fromOffer: boolean): Promise<Response> =>
    fetch("/api/me/survey/bug", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: text, pagePath, fromOffer }),
    });

  const submit = async () => {
    if (!answered || phase !== "form") return;
    setPhase("sending");
    setError(null);
    try {
      if (bug) {
        const fromOffer = offerRef.current?.trigger === "self";
        let r = await sendBug(fromOffer);
        // The on-demand offer ended meanwhile: the report still goes in, offer-less.
        if (r.status === 409 && fromOffer && (await r.clone().json().catch(() => ({}))).error === "no_open_survey") {
          endedOffer.current = true;
          r = await sendBug(false);
        } else if (r.ok) {
          endedOffer.current = fromOffer;
        }
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`);
        setPhase("thanks");
        return;
      }
      const r = await fetch("/api/me/survey/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(self ? { answers, freeText: text, via, feature: featureKey } : { answers, freeText: text, via }),
      });
      endedOffer.current = true;
      if (r.status === 409) { setPhase("expired"); return; }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`);
      setPhase("thanks");
    } catch (e) {
      setError(`Couldn’t send ${bug ? "your report" : "your answers"} — ${String((e as Error).message ?? e)}. Try again.`);
      setPhase("form");
    }
  };

  const done = phase === "thanks" || phase === "expired";
  const busy = phase === "sending" || phase === "starting";
  const close = () => (done ? onFinished(phase === "thanks", endedOffer.current) : onDismiss());
  const options = surveyPickerOptions(bugReports);

  return (
    <div
      className={`survey-card${hidden ? " update-notice-hidden" : ""}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby="survey-title"
      data-testid="survey-card"
      data-mode={bug ? "bug" : "survey"}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); close(); }
      }}
    >
      <div className="survey-card-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id="survey-title" className="update-notice-title">{bug ? "Report a bug" : "How are we doing?"}</h2>
          {!done && (
            <p className="survey-card-sub">
              {bug
                ? "Anonymous: your name isn’t stored with your report. We attach the page you were on and the app version."
                : "About a minute. Anonymous: your name isn’t stored with your answers. Answer as many as you like."}
            </p>
          )}
        </div>
        <button type="button" className="update-notice-close" aria-label="Close survey" onClick={close}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M2 2l10 10M12 2L2 12" />
          </svg>
        </button>
      </div>

      {done ? (
        <p className="survey-card-done" role="status" data-testid="survey-done">
          {phase === "expired"
            ? "This survey has expired. Thanks anyway!"
            : bug
              ? "Thanks, we’ll look into it."
              : "Thanks, your feedback helps shape skilly."}
        </p>
      ) : (
        <>
          <div className="survey-card-body">
            {self && (
              <label className="survey-picker">
                <span className="survey-q-text" id="survey-feature-pick">What would you like to tell us about?</span>
                <select
                  className="input"
                  aria-labelledby="survey-feature-pick"
                  aria-describedby={block ? "survey-pick-hint" : undefined}
                  value={picked}
                  disabled={busy}
                  onChange={(e) => void pick(e.target.value)}
                  data-testid="survey-feature-picker"
                >
                  {options.map((o) => (
                    <option key={o.value} value={o.value} disabled={!!block && o.value !== SURVEY_BUG_CATEGORY}>{o.label}</option>
                  ))}
                </select>
                {block && (
                  <span className="survey-pick-hint" id="survey-pick-hint" data-testid="survey-pick-hint">
                    {block.reason === "cooldown"
                      ? `You can share other feedback again on ${fmt.date(block.nextAt)}.`
                      : "A survey is waiting for you: open Take the survey from the account menu."}
                  </span>
                )}
              </label>
            )}
            {general.length > 0 && (
              <fieldset className="survey-section">
                <legend>skilly overall</legend>
                {general.map((q) => (
                  <div className="survey-q" key={q.key} data-question={q.key}>
                    <div className="survey-q-text" id={qid(q.key)}>{q.text}</div>
                    <StarInput value={answers[q.key] ?? null} onChange={(v) => setAnswer(q.key, v)} labelledBy={qid(q.key)} disabled={busy} />
                  </div>
                ))}
              </fieldset>
            )}
            {featureLabel && feature.length > 0 && (
              <fieldset className="survey-section" data-testid="survey-feature-section">
                <legend>About {featureLabel}</legend>
                {feature.map((q) => (
                  <div className="survey-q" key={q.key} data-question={q.key}>
                    <div className="survey-q-text" id={qid(q.key)}>{q.text}</div>
                    <StarInput value={answers[q.key] ?? null} onChange={(v) => setAnswer(q.key, v)} labelledBy={qid(q.key)} disabled={busy} />
                  </div>
                ))}
              </fieldset>
            )}
            <label className="survey-text">
              <span className="survey-q-text" id="survey-free-text">{bug ? "Describe the problem you found" : "Anything you’d change, fix or add?"}</span>
              <textarea
                ref={textRef}
                className="input"
                aria-labelledby="survey-free-text"
                aria-required={bug || undefined}
                rows={bug ? 5 : 3}
                placeholder={bug ? "What did you do, what did you expect, and what happened instead?" : undefined}
                value={text}
                disabled={busy}
                onChange={(e) => setText([...e.target.value].slice(0, SURVEY_FREE_TEXT_MAX).join(""))}
                data-testid="survey-free-text"
              />
              <span className="survey-count mono" aria-live="off">{chars(text)} / {SURVEY_FREE_TEXT_MAX}</span>
            </label>
            {error && <div className="survey-error" role="alert">{error}</div>}
          </div>
          <div className="survey-card-foot">
            <button type="button" className="btn btn-primary btn-sm" disabled={!answered || busy} onClick={() => void submit()}>
              {phase === "sending" ? "Sending…" : "Submit"}
            </button>
            {!self && (
              <button type="button" className="survey-optout" onClick={onOptOut} disabled={busy}>
                Don’t ask me again
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
