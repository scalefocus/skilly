"use client";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { useApi, ScrollToTop, ShareButton } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { UserBubble } from "../../components/UserBubble";
import { AchievementGrid, type AchievementsView } from "../../components/AchievementGrid";
import { LevelBar } from "../../components/LevelBar";
import { CollapsibleCard } from "../admin/CollapsibleCard";
import { useFollowStore, setFollow, loadFollowing } from "../../components/FollowButton";
import { useDateFmt } from "../../components/DateFormat";
import { SURVEY_PREF_EVENT, reopenSurvey } from "../../lib/surveyClient";

interface Me {
  userId: string | null;
  dateFormat: "eu" | "us";
  dateFormatOverride: "eu" | "us" | null;
  systemDateFormat: "eu" | "us";
  leaderboardHidden: boolean;
  emailNotifications: boolean;
  driftNotifications: boolean;
  newVersionNotifications: boolean;
  discussionNotifications: boolean;
  directoryHidden: boolean;
  achievementsHidden: boolean;
  achievementsEnabled: boolean;
  allowFollows: boolean;
  surveysEnabled: boolean;
  openSurvey: { shownAt: string } | null;
}

const FORMAT_HINT: Record<"eu" | "us", string> = { eu: "dd/mm/yyyy · 24h", us: "mm/dd/yyyy · AM/PM" };

function DateFormatPref() {
  const { data, reload } = useApi<Me>("/api/me");
  if (!data) return <div className="skeleton" style={{ height: 90, borderRadius: "var(--radius)" }} />;

  const choose = async (value: "eu" | "us" | null) => {
    await fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dateFormat: value }) });
    reload();
    // Re-render dates across the whole app immediately (the provider listens for this).
    window.dispatchEvent(new Event("skilly:dateformat-changed"));
  };

  const current = data.dateFormatOverride; // null = following the system default
  const sys = data.systemDateFormat;
  const opts: { key: "system" | "eu" | "us"; label: string; hint: string; value: "eu" | "us" | null }[] = [
    { key: "system", label: "System default", hint: `${sys.toUpperCase()} · ${FORMAT_HINT[sys]}`, value: null },
    { key: "eu", label: "EU", hint: FORMAT_HINT.eu, value: "eu" },
    { key: "us", label: "US", hint: FORMAT_HINT.us, value: "us" },
  ];
  const isActive = (value: "eu" | "us" | null) => current === value;

  return (
    <section className="reveal" style={{ marginBottom: 30 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 4 }}>Date &amp; time format</h2>
      <p className="page-sub" style={{ marginBottom: 16 }}>
        How timestamps display for you, in your own timezone. Choose <span className="mono">System default</span> to follow the
        org-wide setting, or override it just for your account.
      </p>
      <div className="sort-toggle" role="group" aria-label="Date and time format">
        {opts.map((o) => (
          <button
            key={o.key}
            type="button"
            className={`sort-opt${isActive(o.value) ? " sort-on" : ""}`}
            aria-pressed={isActive(o.value)}
            title={o.hint}
            onClick={() => !isActive(o.value) && choose(o.value)}
          >
            {o.label} <span className="muted mono" style={{ fontSize: 11 }}>{o.hint}</span>
          </button>
        ))}
      </div>
      {current && current !== sys && (
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          You’re overriding the org default (<span className="mono">{sys.toUpperCase()}</span>) with <span className="mono">{current.toUpperCase()}</span>.
        </p>
      )}
    </section>
  );
}

function LeaderboardPref() {
  const { data, reload } = useApi<Me>("/api/me");
  const [busy, setBusy] = useState(false);
  if (!data) return <div className="skeleton" style={{ height: 70, borderRadius: "var(--radius)" }} />;

  const choose = async (hidden: boolean) => {
    if (hidden === data.leaderboardHidden) return;
    setBusy(true);
    try {
      await fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaderboardHidden: hidden }) });
      reload();
    } finally { setBusy(false); }
  };

  const visible = !data.leaderboardHidden;
  const opts: { label: string; hint: string; hidden: boolean }[] = [
    { label: "Shown", hint: "appear on the board", hidden: false },
    { label: "Hidden", hint: "stay off the board", hidden: true },
  ];
  return (
    <section className="reveal" style={{ marginBottom: 30 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 4 }}>Leaderboard</h2>
      <p className="page-sub" style={{ marginBottom: 16 }}>
        The contributor leaderboard ranks people by installs of the skills they’ve proposed. You can hide yourself from it.
      </p>
      <div className="sort-toggle" role="group" aria-label="Leaderboard visibility">
        {opts.map((o) => {
          const active = o.hidden === data.leaderboardHidden;
          return (
            <button
              key={o.label}
              type="button"
              className={`sort-opt${active ? " sort-on" : ""}`}
              aria-pressed={active}
              disabled={busy}
              title={o.hint}
              onClick={() => choose(o.hidden)}
            >
              {o.label} <span className="muted mono" style={{ fontSize: 11 }}>{o.hint}</span>
            </button>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        {visible ? "You appear on the leaderboard." : "You won’t appear on the leaderboard."}
      </p>
    </section>
  );
}

// §28 directory opt-out: hide the Entra job title / office / department from the hover card other
// people see on your avatar. Your name, email and online dot are unaffected — they're already
// visible across the app — so this hides the directory block only.
function DirectoryPref() {
  const { data, reload } = useApi<Me>("/api/me");
  const [busy, setBusy] = useState(false);
  if (!data) return <div className="skeleton" style={{ height: 70, borderRadius: "var(--radius)" }} />;

  const choose = async (hidden: boolean) => {
    if (hidden === data.directoryHidden) return;
    setBusy(true);
    try {
      await fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ directoryHidden: hidden }) });
      reload();
    } finally { setBusy(false); }
  };

  const opts: { label: string; hint: string; hidden: boolean }[] = [
    { label: "Shown", hint: "on your hover card", hidden: false },
    { label: "Hidden", hint: "keep them private", hidden: true },
  ];
  return (
    <section className="reveal" style={{ marginBottom: 30 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 4 }}>Directory details</h2>
      <p className="page-sub" style={{ marginBottom: 16 }}>
        Hovering your avatar anywhere in skilly shows a small card with your job title, department and office, taken
        from Entra ID. You can keep those three private.
      </p>
      <div className="sort-toggle" role="group" aria-label="Directory details visibility">
        {opts.map((o) => {
          const active = o.hidden === data.directoryHidden;
          return (
            <button
              key={o.label}
              type="button"
              className={`sort-opt${active ? " sort-on" : ""}`}
              aria-pressed={active}
              disabled={busy}
              title={o.hint}
              onClick={() => choose(o.hidden)}
            >
              {o.label} <span className="muted mono" style={{ fontSize: 11 }}>{o.hint}</span>
            </button>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        {data.directoryHidden
          ? "Your card reads “No directory information”. Your name, email and online status still show."
          : "Your job title, department and office show on your card."}
      </p>
    </section>
  );
}

// §12 email-channel opt-out: on by default; off = in-app (and webhook) only. The user
// doesn't pick a transport — email either arrives or it doesn't.
function EmailNotificationsPref() {
  const { data, reload } = useApi<Me>("/api/me");
  const [busy, setBusy] = useState(false);
  if (!data) return <div className="skeleton" style={{ height: 70, borderRadius: "var(--radius)" }} />;

  const choose = async (enabled: boolean) => {
    if (enabled === data.emailNotifications) return;
    setBusy(true);
    try {
      await fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ emailNotifications: enabled }) });
      reload();
    } finally { setBusy(false); }
  };

  const opts: { label: string; hint: string; enabled: boolean }[] = [
    { label: "On", hint: "email + in-app", enabled: true },
    { label: "Off", hint: "in-app only", enabled: false },
  ];
  return (
    <section className="reveal" style={{ marginBottom: 30 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 4 }}>Email notifications</h2>
      <p className="page-sub" style={{ marginBottom: 16 }}>
        Receive your notifications by email as well as in the in-app inbox. Turning this off stops all notification
        email to you; nothing else changes.
      </p>
      <div className="sort-toggle" role="group" aria-label="Email notifications">
        {opts.map((o) => {
          const active = o.enabled === data.emailNotifications;
          return (
            <button
              key={o.label}
              type="button"
              className={`sort-opt${active ? " sort-on" : ""}`}
              aria-pressed={active}
              disabled={busy}
              title={o.hint}
              onClick={() => choose(o.enabled)}
            >
              {o.label} <span className="muted mono" style={{ fontSize: 11 }}>{o.hint}</span>
            </button>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        {data.emailNotifications
          ? "You'll get an email for each notification (when the platform has email delivery configured)."
          : "You won't receive notification email. Your in-app inbox keeps working as usual."}
      </p>
    </section>
  );
}

// §12 per-type maintainer opt-outs: row-level — off means the notification is never created
// for you (no in-app row, no email), unlike the email toggle above which only mutes email.
// Skills you explicitly watch still notify you of new versions regardless (unwatch to stop).
function MaintainerNotificationsPref() {
  const { data, reload } = useApi<Me>("/api/me");
  const [busy, setBusy] = useState(false);
  if (!data) return <div className="skeleton" style={{ height: 120, borderRadius: "var(--radius)" }} />;

  const patch = async (field: "driftNotifications" | "newVersionNotifications" | "discussionNotifications", enabled: boolean) => {
    setBusy(true);
    try {
      await fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ [field]: enabled }) });
      reload();
    } finally { setBusy(false); }
  };

  const rows: { field: "driftNotifications" | "newVersionNotifications" | "discussionNotifications"; label: string; offHint: string; value: boolean }[] = [
    { field: "driftNotifications", label: "Upstream drift", offHint: "You won't be alerted when an external skill's pinned source changes.", value: data.driftNotifications },
    { field: "newVersionNotifications", label: "New versions", offHint: "You won't be alerted when a skill you maintain publishes a version. Skills you watch still notify you.", value: data.newVersionNotifications },
    { field: "discussionNotifications", label: "Discussion comments and @mentions", offHint: "You won't be alerted about new comments on skills you maintain or watch, or when someone @mentions you.", value: data.discussionNotifications },
  ];
  return (
    <section className="reveal" style={{ marginBottom: 30 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 4 }}>Skills I maintain or watch</h2>
      <p className="page-sub" style={{ marginBottom: 16 }}>
        As a maintainer you’re alerted when a skill you maintain publishes a new version, or when an external (pointer)
        skill’s pinned source drifts upstream. You’re also alerted about new discussion comments on skills you maintain
        or watch. Turning one off stops that alert entirely — in-app and email. Skills you explicitly watch keep notifying
        you of new versions either way (except discussion comments, which the toggle above silences for watched skills too).
      </p>
      {rows.map((r) => (
        <div key={r.field} style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ minWidth: 130, fontWeight: 600, fontSize: 14 }}>{r.label}</div>
          <div className="sort-toggle" role="group" aria-label={`${r.label} notifications`}>
            {[{ label: "On", enabled: true }, { label: "Off", enabled: false }].map((o) => {
              const active = o.enabled === r.value;
              return (
                <button
                  key={o.label}
                  type="button"
                  className={`sort-opt${active ? " sort-on" : ""}`}
                  aria-pressed={active}
                  disabled={busy}
                  onClick={() => !active && patch(r.field, o.enabled)}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          {!r.value && <span className="muted" style={{ fontSize: 12 }}>{r.offHint}</span>}
        </div>
      ))}
    </section>
  );
}

// §31.5 — the owner's Achievements card: every badge in catalog order, earned ones dated, locked
// ones greyed with their how-to-earn hint (the exploration nudge), the level bar (§31.10, in place
// of the old "N of M earned" text line), Share, and a link to the hall as others see it. Hidden
// entirely while the platform toggle is off.
function AchievementsCard() {
  const { data: me } = useApi<Me>("/api/me");
  const { data } = useApi<AchievementsView | { disabled: true }>(me?.userId ? `/api/users/${me.userId}/achievements` : null);
  if (!me || me.achievementsEnabled === false) return null;
  if (!data) return <div className="skeleton" style={{ height: 120, borderRadius: "var(--radius)", marginBottom: 30 }} />;
  if ("disabled" in data) return null;
  const hallUrl = typeof window !== "undefined" ? `${window.location.origin}/achievements/${data.userId}` : `/achievements/${data.userId}`;
  return (
    <section id="achievements" className="card card-pad reveal" style={{ marginBottom: 30 }} data-testid="achievements-card">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        {/* A basis, not `flex: 1` — "Achievements" is a single unbreakable word, so a shrink-to-zero
            item lets the buttons ride over it at phone widths instead of wrapping below it. */}
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, flex: "1 1 180px", minWidth: 0 }}>Achievements</h2>
        <ShareButton url={hallUrl} label="Share" title="Copy a link to your achievements" />
        <Link href={`/achievements/${data.userId}`} className="btn-ghost mono" style={{ fontSize: 12 }}>View as others see it →</Link>
      </div>
      {/* The bar IS the progress line now — it states the same fact better (§31.10). Its own
          full-width row, not a flex sibling of the buttons: a bar squeezed into a shared row
          collapses to a stub at phone widths. It renders at level 0 too — the locked badges and
          their hints sit right underneath it, and that pairing is the exploration nudge the whole
          feature exists for. */}
      <div data-testid="achievements-progress" style={{ marginBottom: 16 }}>
        <LevelBar level={data.earned.length} total={data.total} heroAt={data.heroAt} />
      </div>
      <AchievementGrid earned={data.earned} showLocked shareBase={hallUrl} />
    </section>
  );
}

// §31.5 — Shown/Hidden: whether other people can open your hall / see the hover-card count.
function AchievementsPref() {
  const { data, reload } = useApi<Me>("/api/me");
  const [busy, setBusy] = useState(false);
  if (!data) return <div className="skeleton" style={{ height: 70, borderRadius: "var(--radius)" }} />;
  if (data.achievementsEnabled === false) return null;
  const choose = async (hidden: boolean) => {
    if (hidden === data.achievementsHidden) return;
    setBusy(true);
    try {
      await fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ achievementsHidden: hidden }) });
      reload();
    } finally { setBusy(false); }
  };
  const opts: { label: string; hint: string; hidden: boolean }[] = [
    { label: "Shown", hint: "others can open your hall", hidden: false },
    { label: "Hidden", hint: "keep your trophies private", hidden: true },
  ];
  return (
    <section className="reveal" style={{ marginBottom: 30 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 4 }}>Achievements visibility</h2>
      <p className="page-sub">Whether other signed-in people can see the badges you have earned — on your shared hall, as your level on your hover card, and as the ring around your avatar. You always see your own.</p>
      <div className="sort-toggle" role="group" aria-label="Achievements visibility">
        {opts.map((o) => {
          const on = o.hidden === data.achievementsHidden;
          return (
            <button
              key={o.label}
              type="button"
              className={`sort-opt${on ? " sort-on" : ""}`}
              aria-pressed={on}
              disabled={busy}
              title={o.hint}
              onClick={() => void choose(o.hidden)}
            >
              {o.label} <span className="muted mono" style={{ fontSize: 11 }}>{o.hint}</span>
            </button>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        {data.achievementsHidden ? "Your hall shows others only that you keep your trophies private, and your level ring is hidden from them." : "Anyone signed in can open your hall from your hover card or a shared link."}
      </p>
    </section>
  );
}

// §35.3 — "Allow others to follow me". Off PAUSES every follow on you: your Follow button is hidden
// everywhere and your followers get no notifications about you, but the follows are kept and resume
// when you turn it back on. Your own ability to follow others is unaffected.
function FollowingPref() {
  const { data, reload } = useApi<Me>("/api/me");
  const [busy, setBusy] = useState(false);
  if (!data) return <div className="skeleton" style={{ height: 120, borderRadius: "var(--radius)" }} />;
  const choose = async (allow: boolean) => {
    if (allow === data.allowFollows) return;
    setBusy(true);
    try {
      await fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ allowFollows: allow }) });
      reload();
    } finally { setBusy(false); }
  };
  return (
    <section className="reveal" style={{ marginBottom: 30 }} id="following">
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 4 }}>Following</h2>
      <p className="page-sub" style={{ marginBottom: 16 }}>
        Colleagues can follow you to be told, in-app, when you publish a skill or a new version, earn a badge, or post or
        fulfil a skill request. Only you see whom you follow; nobody sees who follows them.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ minWidth: 130, fontWeight: 600, fontSize: 14 }}>Allow others to follow me</div>
        <div className="sort-toggle" role="group" aria-label="Allow others to follow me">
          {[{ label: "On", allow: true }, { label: "Off", allow: false }].map((o) => {
            const active = o.allow === data.allowFollows;
            return (
              <button key={o.label} type="button" className={`sort-opt${active ? " sort-on" : ""}`} aria-pressed={active} disabled={busy} onClick={() => void choose(o.allow)}>
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 16px" }}>
        {data.allowFollows
          ? "People can follow you and get notified when you publish, request or earn a badge."
          : "Your Follow button is hidden and your followers get no notifications about you. They’re kept, and resume if you turn this back on."}
      </p>
      <FollowingPane />
    </section>
  );
}

// §36.7 the feedback-survey opt-out: on by default; off ends any open offer at once, and turning it
// back on does not reset the 30-day floor. While an offer is open, the section also offers "Take
// the survey" (§36.5), which reopens the card through the app shell.
function SurveysPref() {
  const { data, reload } = useApi<Me>("/api/me");
  const [busy, setBusy] = useState(false);
  // The card's "Don't ask me again" flips the same setting from the shell.
  useEffect(() => {
    window.addEventListener(SURVEY_PREF_EVENT, reload);
    return () => window.removeEventListener(SURVEY_PREF_EVENT, reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!data) return <div className="skeleton" style={{ height: 90, borderRadius: "var(--radius)" }} />;
  const choose = async (enabled: boolean) => {
    if (enabled === data.surveysEnabled) return;
    setBusy(true);
    try {
      await fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveysEnabled: enabled }) });
      window.dispatchEvent(new CustomEvent(SURVEY_PREF_EVENT, { detail: { enabled } }));
    } finally { setBusy(false); }
  };
  return (
    <section className="reveal" style={{ marginBottom: 30 }} id="surveys" data-testid="surveys-pref">
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 4 }}>Feedback surveys</h2>
      <p className="page-sub" style={{ marginBottom: 16 }}>
        A short, anonymous survey about skilly and a feature you’ve just started using.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ minWidth: 130, fontWeight: 600, fontSize: 14 }}>Ask me for feedback</div>
        <div className="sort-toggle" role="group" aria-label="Feedback surveys">
          {[{ label: "On", enabled: true }, { label: "Off", enabled: false }].map((o) => {
            const active = o.enabled === data.surveysEnabled;
            return (
              <button key={o.label} type="button" className={`sort-opt${active ? " sort-on" : ""}`} aria-pressed={active} disabled={busy} onClick={() => void choose(o.enabled)}>
                {o.label}
              </button>
            );
          })}
        </div>
        {data.surveysEnabled && data.openSurvey && (
          <button type="button" className="btn btn-sm" onClick={() => reopenSurvey()} data-testid="profile-take-survey">Take the survey</button>
        )}
      </div>
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        {data.surveysEnabled
          ? "Now and then, at most once a month, skilly asks how it’s doing. Answers are anonymous."
          : "You won’t be asked to take surveys."}
      </p>
    </section>
  );
}

const FOLLOWING_PANE_KEY = "skilly.profile.following.open";

// §35.5 — "People I follow (N)": a single collapsible pane, collapsed by default and remembered per
// browser. Newest follow first; Paused / Inactive tags; Unfollow removes the row immediately.
function FollowingPane() {
  const store = useFollowStore();
  const fmt = useDateFmt();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Always re-read on mount: the page-wide store may have been loaded before a follow elsewhere.
  useEffect(() => { void loadFollowing(true); }, []);
  useEffect(() => {
    try { setOpen(window.localStorage.getItem(FOLLOWING_PANE_KEY) === "1"); } catch { /* storage blocked → collapsed */ }
  }, []);
  const toggle = () => {
    setOpen((o) => {
      try { window.localStorage.setItem(FOLLOWING_PANE_KEY, o ? "0" : "1"); } catch { /* per-browser convenience only */ }
      return !o;
    });
  };
  const list = store.list;
  const unfollow = async (userId: string) => {
    setBusy(userId);
    try { await setFollow(userId, false); } finally { setBusy(null); }
  };
  return (
    // No count until the list has loaded — a transient "(0)" would be a lie.
    <CollapsibleCard cardId="following" title={store.loaded ? `People I follow (${list.length})` : "People I follow"} open={open} onToggle={toggle}>
      {!store.loaded ? (
        <div className="skeleton" style={{ height: 60, borderRadius: "var(--radius)" }} />
      ) : list.length === 0 ? (
        <div className="muted" style={{ fontSize: 13.5 }} data-testid="following-empty">
          You’re not following anyone yet — look for the Follow button on the leaderboard, a hover card or someone’s achievements.
        </div>
      ) : (
        <div className="rows">
          {list.map((f) => (
            <div className="maintainer-item" key={f.userId} data-testid="following-row">
              <div className="m-av"><UserBubble name={f.displayName} avatar={f.avatar} userId={f.userId} /></div>
              <div className="m-name">
                <div className="ttl">
                  {f.state === "inactive" ? f.displayName : <Link href={`/achievements/${f.userId}`}>{f.displayName}</Link>}
                </div>
                <div className="sub mono" style={{ fontSize: 11 }}>Following since {fmt.date(f.since)}</div>
              </div>
              <div className="m-meta">
                {f.state === "paused" && <span className="chip" title="They’ve turned follows off — you get no notifications about them for now.">Paused</span>}
                {f.state === "inactive" && <span className="chip" title="Their account is inactive.">Inactive</span>}
                <button type="button" className="btn btn-sm" disabled={busy === f.userId} onClick={() => void unfollow(f.userId)} title={`Stop following ${f.displayName}`}>
                  {busy === f.userId ? "…" : "Unfollow"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </CollapsibleCard>
  );
}

function ProfileInner() {
  const { data: session } = useSession();
  const { data: me } = useApi<Me>("/api/me");
  const name = session?.user?.name ?? "Your account";
  const email = session?.user?.email ?? null;
  const image = session?.user?.image ?? null;

  return (
    <div className="reveal" style={{ maxWidth: 760 }}>
      <ScrollToTop />
      <div className="page-head">
        <div className="eyebrow">Account</div>
        <h1 className="page-title">Profile.</h1>
      </div>

      <section className="card card-pad reveal" style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 30 }}>
        <UserBubble name={name} avatar={image} userId={me?.userId} size={52} />
        <div className="profile-id" style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 600 }} title={name}>{name}</div>
          {email && <div className="muted mono" style={{ fontSize: 13 }} title={email}>{email}</div>}
        </div>
      </section>

      <AchievementsCard />

      <DateFormatPref />
      <DirectoryPref />
      <LeaderboardPref />
      <AchievementsPref />
      <EmailNotificationsPref />
      <MaintainerNotificationsPref />
      <FollowingPref />
      <SurveysPref />
    </div>
  );
}

export default function ProfilePage() {
  return (
    <RequireAuth>
      <ProfileInner />
    </RequireAuth>
  );
}
