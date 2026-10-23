"use client";
// Try a skill before installing (SKILLY_SPEC.md §61.3): the side panel. On open it resolves the
// version (GET …/try) and fills the header — the disclosure, what was loaded, the flagged warning.
// Each message sends the whole transcript (POST …/try); the server rebuilds the skill context from
// the stored artifact and keeps nothing. The transcript lives in this tab's sessionStorage only.
import { useEffect, useRef, useState } from "react";
import {
  AI_TRY_COUNTER_FROM,
  AI_TRY_DAILY_CAP,
  AI_TRY_MAX_MESSAGE_CHARS,
  AI_TRY_MAX_TURNS,
  AI_TRY_TURNS_WARN,
  tryCanSendMore,
  tryUserTurns,
  type TryContext,
  type TryMessage,
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

  // The composer only renders once the version resolves — focus it then.
  useEffect(() => {
    if (ctx) input.current?.focus();
  }, [ctx]);

  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [messages, pending, err]);

  const turnsLeft = AI_TRY_MAX_TURNS - tryUserTurns(messages);
  const isFull = full || !tryCanSendMore(messages);
  const stopped = !!err?.stop || !!ctxErr;

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
    if (!ctx || !text || pending || stopped) return;
    if (!tryCanSendMore(messages, text.length)) {
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
      if (r.ok && typeof j.reply === "string") {
        persist([...next, { role: "assistant", content: j.reply }]);
        return;
      }
      if (j.error === "conversation_full") {
        setMessages((m) => m.slice(0, -1));
        setDraft((d) => d || text);
        setFull(true);
      } else if (j.error === "try_rate_limited") {
        unsend(text, {
          text:
            j.scope === "day"
              ? `Daily limit reached (${AI_TRY_DAILY_CAP} messages in 24 hours). You can try again after ${fmt.dateTime(j.retryAt)}.`
              : "Too many messages in a row. Wait a minute and try again.",
          retry: false,
          stop: false,
        });
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

  const footer = !ctx ? null : isFull ? (
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
        maxLength={AI_TRY_MAX_MESSAGE_CHARS}
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
            {turnsLeft} of {AI_TRY_MAX_TURNS} messages left
          </span>
        )}
        {draft.length >= AI_TRY_COUNTER_FROM && (
          <span className="muted mono" style={{ fontSize: 12 }}>
            {draft.length.toLocaleString("en-US")} / {AI_TRY_MAX_MESSAGE_CHARS.toLocaleString("en-US")}
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
