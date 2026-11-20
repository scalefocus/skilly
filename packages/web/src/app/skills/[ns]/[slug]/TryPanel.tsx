"use client";
// Try a skill before installing (SKILLY_SPEC.md §61.3): the side panel. On open it resolves the
// version (GET …/try) and fills the header — the disclosure, what was loaded, the flagged warning.
// Each message sends the whole transcript (POST …/try); the server rebuilds the skill context from
// the stored artifact and keeps nothing. The transcript lives in this tab's sessionStorage only.
// Every limit comes from the server's responses (`limits`, `daily`), never from constants: a
// platform admin can change them (§40.18), and the panel adopts the values in force as they arrive.
import { useEffect, useRef, useState } from "react";
import {
  AI_TRY_COUNTER_WITHIN,
  AI_TRY_TURNS_WARN,
  tryCanSendMore,
  tryMessageTooLong,
  tryUserTurns,
  type TryContext,
  type TryDaily,
  type TryMessage,
  type TryPanelLimits,
} from "@skilly/shared/ai-try";
import { Modal } from "../../../../components/ui";
import { Markdown } from "../../../../components/Markdown";
import { useAiName } from "../../../../components/AiName";
import { useDateFmt } from "../../../../components/DateFormat";
import { loadTryConversation, saveTryConversation, tryStoreKey } from "../../../../lib/tryStore";

/** A failed call, mapped to the §61.9 message. `stop` disables the composer for good. */
interface TryError {
  text: string;
  retry: boolean;
  stop: boolean;
}

export function TryPanel({
  ns,
  slug,
  title,
  semver,
  userId,
  onClose,
}: {
  ns: string;
  slug: string;
  title: string;
  /** The Install picker's choice; null = latest. */
  semver: string | null;
  userId: string | null;
  onClose: () => void;
}) {
  const aiName = useAiName();
  const fmt = useDateFmt();
  const base = `/api/skills/${ns}/${slug}/try`;
  const [ctx, setCtx] = useState<TryContext | null>(null);
  const [ctxErr, setCtxErr] = useState<string | null>(null);
  // The values in force as of the last response (§61.6): the per-conversation limits and the
  // caller's daily allowance.
  const [limits, setLimits] = useState<TryPanelLimits | null>(null);
  const [daily, setDaily] = useState<TryDaily | null>(null);
  const [messages, setMessages] = useState<TryMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<TryError | null>(null);
  const [full, setFull] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const key = ctx && userId ? tryStoreKey(userId, ns, slug, ctx.semver) : null;

  /** Take the limits and the allowance a response carries; every Try response may (§61.6). */
  const adopt = (j: { limits?: TryPanelLimits; daily?: TryDaily }) => {
    if (j.limits) setLimits(j.limits);
    if (j.daily) setDaily(j.daily);
  };

  // Resolve the version once per open; the version is fixed for the panel's life (§61.3).
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(semver ? `${base}?semver=${encodeURIComponent(semver)}` : base);
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) {
          setCtxErr(
            j.error === "try_unavailable"
              ? "Trying skills is no longer available."
              : j.error === "version_not_found"
                ? "This version can no longer be tried."
                : "Couldn’t load this skill’s files. Try again later.",
          );
          return;
        }
        setCtx(j as TryContext);
        setLimits((j as TryContext).limits);
        setDaily((j as TryContext).daily);
      } catch {
        if (live) setCtxErr("Couldn’t load this skill’s files. Try again later.");
      }
    })();
    return () => {
      live = false;
      abort.current?.abort();
    };
  }, [base, semver]);

  useEffect(() => {
    if (key) setMessages(loadTryConversation(key));
  }, [key]);

  const turnsLeft = limits ? limits.maxTurns - tryUserTurns(messages) : 0;
  const isFull = !!limits && (full || !tryCanSendMore(messages, limits));
  // At 0 messages left today the composer is disabled and the daily-limit message shows, from the
  // moment the panel opens (§61.3). The conversation stays readable.
  const dailyOut = daily?.remaining === 0;
  const dailyText =
    daily && dailyOut
      ? `Daily limit reached (${daily.cap.toLocaleString("en-US")} messages in 24 hours).${daily.retryAt ? ` You can try again after ${fmt.dateTime(daily.retryAt)}.` : ""}`
      : null;
  const stopped = !!err?.stop || !!ctxErr || dailyOut;

  // The composer only renders once the version resolves, and again after Start over on a full
  // conversation — focus it then.
  useEffect(() => {
    if (ctx && !isFull) input.current?.focus();
  }, [ctx, isFull]);

  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [messages, pending, err]);

  const persist = (next: TryMessage[]) => {
    setMessages(next);
    if (key) saveTryConversation(key, next);
  };

  /** A failure puts the unsent message back in the composer, so Retry resends the same transcript. */
  const unsend = (text: string, e: TryError) => {
    setMessages((m) => m.slice(0, -1));
    setDraft((d) => d || text);
    setErr(e);
  };

  const send = async () => {
    const text = draft.trim();
    if (!ctx || !limits || !text || pending || stopped) return;
    // Possible only when the limit was lowered under a draft already typed: the box's maxLength
    // stops anything longer from being entered.
    if (text.length > limits.maxMessageChars) {
      setErr({ text: tryMessageTooLong(limits), retry: false, stop: false });
      return;
    }
    if (!tryCanSendMore(messages, limits, text.length)) {
      setFull(true);
      return;
    }
    const next: TryMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setDraft("");
    setErr(null);
    setPending(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const r = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ semver: ctx.semver, messages: next }),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({}));
      // The limits in force and the allowance, counted after this call when it reached the provider.
      adopt(j);
      if (r.ok && typeof j.reply === "string") {
        persist([...next, { role: "assistant", content: j.reply }]);
        return;
      }
      if (j.error === "conversation_full") {
        setMessages((m) => m.slice(0, -1));
        setDraft((d) => d || text);
        setFull(true);
      } else if (j.error === "invalid_transcript" && j.limits && text.length > j.limits.maxMessageChars) {
        // The per-message limit was lowered since this panel last heard from the server (§61.9).
        unsend(text, { text: tryMessageTooLong(j.limits), retry: false, stop: false });
      } else if (j.error === "try_rate_limited" && j.scope === "day") {
        // The daily-limit message renders from the allowance (adopted above), which also disables
        // the composer; the message goes back into it.
        if (!j.daily) setDaily({ cap: Number(j.cap) || 0, remaining: 0, retryAt: typeof j.retryAt === "string" ? j.retryAt : null });
        setMessages((m) => m.slice(0, -1));
        setDraft((d) => d || text);
      } else if (j.error === "try_rate_limited") {
        unsend(text, { text: "Too many messages in a row. Wait a minute and try again.", retry: false, stop: false });
      } else if (j.error === "try_unavailable") {
        unsend(text, { text: "Trying skills is no longer available.", retry: false, stop: true });
      } else if (j.error === "version_not_found") {
        unsend(text, { text: "This version can no longer be tried.", retry: false, stop: true });
      } else if (j.error === "try_source_failed") {
        unsend(text, { text: "Couldn’t load this skill’s files. Try again later.", retry: true, stop: false });
      } else {
        unsend(text, { text: `Couldn’t get a reply from ${aiName}. Try again.`, retry: true, stop: false });
      }
    } catch {
      // Cancel aborts only the browser's wait: the message goes back in the composer and the server's
      // call still completes and counts (§61.3).
      if (ctrl.signal.aborted) {
        setMessages((m) => m.slice(0, -1));
        setDraft((d) => d || text);
        // The abandoned call still counts: lower the shown allowance at once; the next response
        // corrects it.
        setDaily((d) => d && { ...d, remaining: Math.max(0, d.remaining - 1) });
      } else {
        unsend(text, { text: `Couldn’t get a reply from ${aiName}. Try again.`, retry: true, stop: false });
      }
    } finally {
      abort.current = null;
      setPending(false);
      input.current?.focus();
    }
  };

  const startOver = () => {
    if (messages.length && !window.confirm("Start over? This conversation is cleared.")) return;
    abort.current?.abort();
    persist([]);
    setErr(null);
    setFull(false);
    setDraft("");
    // The button goes disabled on an empty conversation, which would drop focus to <body> (§61.3):
    // move it to the composer first. On a full conversation the composer mounts on this commit and
    // the effect above focuses it.
    input.current?.focus();
  };

  const loadedLine = (() => {
    if (!ctx) return null;
    const loaded = ctx.files.filter((f) => f.state !== "skipped");
    const cut = ctx.files.filter((f) => f.state === "truncated").length;
    const left = ctx.files.filter((f) => f.state === "skipped").length;
    const hasSkillMd = loaded.some((f) => f.path === "SKILL.md");
    const others = loaded.length - (hasSkillMd ? 1 : 0);
    const head = hasSkillMd
      ? `Loaded SKILL.md${others ? ` + ${others} file${others === 1 ? "" : "s"}` : ""}`
      : `Loaded ${loaded.length} file${loaded.length === 1 ? "" : "s"}`;
    return `${head}${cut ? ` · ${cut} cut short` : ""}${left ? ` · ${left} left out` : ""}`;
  })();

  const headExtra = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
      {ctx && <span className="muted mono" style={{ fontSize: 12, padding: "2px 8px", border: "1px solid var(--line)", borderRadius: 999 }} data-testid="try-version">v{ctx.semver}</span>}
      <button type="button" className="btn btn-sm" onClick={startOver} disabled={!messages.length && !draft} data-testid="try-start-over">
        Start over
      </button>
    </div>
  );

  const footer = !ctx || !limits ? null : isFull ? (
    <div className="try-composer" data-testid="try-full">
      <p className="try-notice" style={{ margin: 0 }}>This conversation is full. Start over to keep trying.</p>
      <div className="try-composer-row">
        <button type="button" className="btn btn-primary btn-sm" onClick={startOver}>Start over</button>
      </div>
    </div>
  ) : (
    <div className="try-composer">
      <textarea
        ref={input}
        className="input"
        aria-label={`Message ${aiName}`}
        placeholder={stopped ? "" : `Message ${aiName} with this skill loaded…`}
        value={draft}
        maxLength={limits.maxMessageChars}
        disabled={stopped}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        data-testid="try-input"
      />
      <div className="try-composer-row">
        {turnsLeft <= AI_TRY_TURNS_WARN && (
          <span className="muted" style={{ fontSize: 12 }} data-testid="try-left">
            {turnsLeft} of {limits.maxTurns} messages left in this conversation
          </span>
        )}
        {limits.maxMessageChars - draft.length <= AI_TRY_COUNTER_WITHIN && (
          <span className="muted mono" style={{ fontSize: 12 }} data-testid="try-counter">
            {draft.length.toLocaleString("en-US")} / {limits.maxMessageChars.toLocaleString("en-US")}
          </span>
        )}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={() => void send()}
          disabled={!draft.trim() || pending || stopped}
          data-testid="try-send"
        >
          Send
        </button>
      </div>
    </div>
  );

  return (
    <Modal title={`Try ${title}`} onCancel={onClose} side headExtra={headExtra} footer={footer} bodyClassName="try-body" initialFocusRef={input} testId="try-panel">
      <div className="try-meta" data-testid="try-disclosure">
        {ctx && <p>Preview on <span className="mono">{ctx.model}</span>: no tools, so scripts don’t run, and your agent may behave differently.</p>}
        <p>Messages you type are sent to {aiName}. Don’t paste confidential data.</p>
        {ctx && loadedLine && (
          <p data-testid="try-loaded">
            {loadedLine}{" "}
            {ctx.files.length > 0 && (
              <button type="button" className="btn-ghost mono" style={{ fontSize: 11 }} aria-expanded={showFiles} onClick={() => setShowFiles((s) => !s)}>
                {showFiles ? "hide files" : "show files"}
              </button>
            )}
          </p>
        )}
        {ctx && showFiles && (
          <ul className="try-files">
            {ctx.files.map((f) => (
              <li key={f.path}>
                <span className="mono">{f.path}</span>
                {f.state === "truncated" ? " · cut short" : f.state === "skipped" ? " · left out" : ""}
              </li>
            ))}
          </ul>
        )}
        {daily && (
          <p data-testid="try-daily">
            {daily.remaining.toLocaleString("en-US")} of {daily.cap.toLocaleString("en-US")} messages left today
          </p>
        )}
        {ctx?.contentCheck === "flagged" && (
          <p className="try-flagged" data-testid="try-flagged">
            Content check: flagged, awaiting review. Check any command it suggests before you run it.
          </p>
        )}
      </div>

      <div className="try-scroll" ref={scroll} aria-live="polite">
        {ctxErr && <p className="try-notice" role="alert">{ctxErr}</p>}
        {!ctx && !ctxErr && <div className="skeleton" style={{ height: 80, borderRadius: "var(--radius)" }} />}
        {ctx && messages.length === 0 && !pending && (
          <div data-testid="try-empty">
            {ctx.usage ? (
              <>
                <h3 style={{ fontSize: 14, margin: "0 0 6px" }}>How to use it</h3>
                <div style={{ fontSize: 14 }}>
                  <Markdown source={ctx.usage} />
                </div>
              </>
            ) : (
              <p className="try-notice">Ask what you’d ask an agent that has this skill installed.</p>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`try-msg try-msg-${m.role}`} data-testid="try-message" data-role={m.role}>
            {m.role === "assistant" ? <Markdown source={m.content} /> : m.content}
          </div>
        ))}
        {pending && (
          <div className="try-msg try-msg-assistant" data-testid="try-thinking">
            <span className="muted">Thinking…</span>{" "}
            <button type="button" className="btn-ghost" style={{ fontSize: 12.5 }} onClick={() => abort.current?.abort()}>
              Cancel
            </button>
          </div>
        )}
        {dailyText && (
          <p className="try-notice" role="alert" data-testid="try-daily-reached">
            {dailyText}
          </p>
        )}
        {err?.text && (
          <p className="try-notice" role="alert" data-testid="try-error">
            {err.text}{" "}
            {err.retry && (
              <button type="button" className="btn btn-sm" onClick={() => void send()} disabled={!draft.trim()}>
                Retry
              </button>
            )}
          </p>
        )}
      </div>
    </Modal>
  );
}
