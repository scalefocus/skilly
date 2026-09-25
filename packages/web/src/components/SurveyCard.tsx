"use client";
// The floating feedback-survey card (SKILLY_SPEC.md §36.4). Owned by AppShell and portaled to
// <body> like the What's new notice, so it survives client-side navigation. A NON-modal dialog: the
// page stays usable, nothing is focused on appearance, and Escape closes it only while focus is
// inside it. Height-capped (80vh, CSS) with the header and footer pinned and the question list the
// only scrolling child.
import { useEffect, useState } from "react";
import { SURVEY_FREE_TEXT_MAX, type SurveyOfferView, type SurveyVia } from "@skilly/shared/survey";
import { StarInput } from "./StarInput";

type Phase = "form" | "sending" | "thanks" | "expired";

const qid = (key: string) => `survey-q-${key.replace(/[^a-z0-9]/gi, "-")}`;
const chars = (s: string) => [...s].length;

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
  /** "Don't ask me again". */
  onOptOut: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);

  // The thank-you / expired states close themselves after ~4 s.
  useEffect(() => {
    if (phase !== "thanks" && phase !== "expired") return;
    const t = setTimeout(() => onFinished(phase === "thanks"), 4000);
    return () => clearTimeout(t);
  }, [phase, onFinished]);

  const answered = Object.keys(answers).length > 0 || text.trim().length > 0;
  const general = offer.questions.filter((q) => q.section === "general");
  const feature = offer.questions.filter((q) => q.section === "feature");

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
        body: JSON.stringify({ answers, freeText: text, via }),
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
            <fieldset className="survey-section">
              <legend>skilly overall</legend>
              {general.map((q) => (
                <div className="survey-q" key={q.key} data-question={q.key}>
                  <div className="survey-q-text" id={qid(q.key)}>{q.text}</div>
                  <StarInput value={answers[q.key] ?? null} onChange={(v) => setAnswer(q.key, v)} labelledBy={qid(q.key)} disabled={phase === "sending"} />
                </div>
              ))}
            </fieldset>
            {offer.feature && feature.length > 0 && (
              <fieldset className="survey-section">
                <legend>About {offer.feature.label}</legend>
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
            <button type="button" className="survey-optout" onClick={onOptOut} disabled={phase === "sending"}>
              Don’t ask me again
            </button>
          </div>
        </>
      )}
    </div>
  );
}
