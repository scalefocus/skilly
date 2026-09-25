"use client";
// The floating feedback-survey card (SKILLY_SPEC.md §36.4). Owned by AppShell and portaled to
// <body> like the What's new notice, so it survives client-side navigation. A NON-modal dialog: the
// page stays usable, nothing is focused on appearance, and Escape closes it only while focus is
// inside it. Height-capped (80vh, CSS) with the header and footer pinned and the question list the
// only scrolling child.
//
// An on-demand ("Give feedback now", §36.16) card heads its questions with a feature picker, and
// has no "Don't ask me again": the user asked for it.
import { useEffect, useState } from "react";
import {
  SURVEY_FEATURES,
  SURVEY_FREE_TEXT_MAX,
  isSurveyFeature,
  surveyFeatureLabel,
  surveyFeatureQuestions,
  type SurveyFeatureKey,
  type SurveyOfferView,
  type SurveyVia,
} from "@skilly/shared/survey";
import { StarInput } from "./StarInput";

type Phase = "form" | "sending" | "thanks" | "expired";

const qid = (key: string) => `survey-q-${key.replace(/[^a-z0-9]/gi, "-")}`;
const chars = (s: string) => [...s].length;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function SurveyCard({
  offer,
  via,
  hidden,
  onDismiss,
  onFinished,
  onOptOut,
}: {
  offer: SurveyOfferView;
  via: SurveyVia;
  /** Hidden (not unmounted) while the mobile nav drawer is open. */
  hidden: boolean;
  /** ✕ / Escape — "not now". The offer stays open behind the account menu. */
  onDismiss: () => void;
  /** The card is done: submitted, or the offer turned out to have expired. */
  onFinished: (submitted: boolean) => void;
  /** "Don't ask me again" (not offered on an on-demand card). */
  onOptOut: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  const self = offer.trigger === "self";
  // §36.16 the on-demand card's feature: null = "skilly in general". Always starts blank.
  const [picked, setPicked] = useState<SurveyFeatureKey | null>(null);

  // The thank-you / expired states close themselves after ~4 s.
  useEffect(() => {
    if (phase !== "thanks" && phase !== "expired") return;
    const t = setTimeout(() => onFinished(phase === "thanks"), 4000);
    return () => clearTimeout(t);
  }, [phase, onFinished]);

  const answered = Object.keys(answers).length > 0 || text.trim().length > 0;
  const general = offer.questions.filter((q) => q.section === "general");
  const feature = self ? (picked ? surveyFeatureQuestions(picked) : []) : offer.questions.filter((q) => q.section === "feature");
  const featureLabel = self ? (picked ? surveyFeatureLabel(picked) : null) : (offer.feature?.label ?? null);

  // Changing or clearing the picked feature discards the stars of its questions.
  const pick = (v: string) => {
    setPicked(isSurveyFeature(v) ? v : null);
    setAnswers((a) => Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith("feature."))));
  };

  const setAnswer = (key: string, v: number | null) =>
    setAnswers((a) => {
      const next = { ...a };
      if (v == null) delete next[key];
      else next[key] = v;
      return next;
    });

  const submit = async () => {
    if (!answered || phase !== "form") return;
    setPhase("sending");
    setError(null);
    try {
      const r = await fetch("/api/me/survey/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(self ? { answers, freeText: text, via, feature: picked } : { answers, freeText: text, via }),
      });
      if (r.status === 409) { setPhase("expired"); return; }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`);
      setPhase("thanks");
    } catch (e) {
      setError(`Couldn’t send your answers — ${String((e as Error).message ?? e)}. Try again.`);
      setPhase("form");
    }
  };

  const done = phase === "thanks" || phase === "expired";
  const close = () => (done ? onFinished(phase === "thanks") : onDismiss());

  return (
    <div
      className={`survey-card${hidden ? " update-notice-hidden" : ""}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby="survey-title"
      data-testid="survey-card"
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); close(); }
      }}
    >
      <div className="survey-card-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id="survey-title" className="update-notice-title">How are we doing?</h2>
          {!done && (
            <p className="survey-card-sub">
              About a minute. Anonymous: your name isn’t stored with your answers. Answer as many as you like.
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
          {phase === "thanks" ? "Thanks, your feedback helps shape skilly." : "This survey has expired. Thanks anyway!"}
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
                  value={picked ?? ""}
                  disabled={phase === "sending"}
                  onChange={(e) => pick(e.target.value)}
                  data-testid="survey-feature-picker"
                >
                  <option value="">skilly in general</option>
                  {SURVEY_FEATURES.map((f) => (
                    <option key={f.key} value={f.key}>{capitalize(f.label)}</option>
                  ))}
                </select>
              </label>
            )}
            <fieldset className="survey-section">
              <legend>skilly overall</legend>
              {general.map((q) => (
                <div className="survey-q" key={q.key} data-question={q.key}>
                  <div className="survey-q-text" id={qid(q.key)}>{q.text}</div>
                  <StarInput value={answers[q.key] ?? null} onChange={(v) => setAnswer(q.key, v)} labelledBy={qid(q.key)} disabled={phase === "sending"} />
                </div>
              ))}
            </fieldset>
            {featureLabel && feature.length > 0 && (
              <fieldset className="survey-section" data-testid="survey-feature-section">
                <legend>About {featureLabel}</legend>
                {feature.map((q) => (
                  <div className="survey-q" key={q.key} data-question={q.key}>
                    <div className="survey-q-text" id={qid(q.key)}>{q.text}</div>
                    <StarInput value={answers[q.key] ?? null} onChange={(v) => setAnswer(q.key, v)} labelledBy={qid(q.key)} disabled={phase === "sending"} />
                  </div>
                ))}
              </fieldset>
            )}
            <label className="survey-text">
              <span className="survey-q-text" id="survey-free-text">Anything you’d change, fix or add?</span>
              <textarea
                className="input"
                aria-labelledby="survey-free-text"
                rows={3}
                value={text}
                disabled={phase === "sending"}
                onChange={(e) => setText([...e.target.value].slice(0, SURVEY_FREE_TEXT_MAX).join(""))}
              />
              <span className="survey-count mono" aria-live="off">{chars(text)} / {SURVEY_FREE_TEXT_MAX}</span>
            </label>
            {error && <div className="survey-error" role="alert">{error}</div>}
          </div>
          <div className="survey-card-foot">
            <button type="button" className="btn btn-primary btn-sm" disabled={!answered || phase === "sending"} onClick={() => void submit()}>
              {phase === "sending" ? "Sending…" : "Submit"}
            </button>
            {!self && (
              <button type="button" className="survey-optout" onClick={onOptOut} disabled={phase === "sending"}>
                Don’t ask me again
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
