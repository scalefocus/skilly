"use client";
import { useState } from "react";
import { useSession } from "next-auth/react";
import { useApi, ScrollToTop } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { UserBubble } from "../../components/UserBubble";

interface Me {
  userId: string | null;
  dateFormat: "eu" | "us";
  dateFormatOverride: "eu" | "us" | null;
  systemDateFormat: "eu" | "us";
  leaderboardHidden: boolean;
  emailNotifications: boolean;
  driftNotifications: boolean;
  newVersionNotifications: boolean;
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

  const patch = async (field: "driftNotifications" | "newVersionNotifications", enabled: boolean) => {
    setBusy(true);
    try {
      await fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ [field]: enabled }) });
      reload();
    } finally { setBusy(false); }
  };

  const rows: { field: "driftNotifications" | "newVersionNotifications"; label: string; offHint: string; value: boolean }[] = [
    { field: "driftNotifications", label: "Upstream drift", offHint: "You won't be alerted when an external skill's pinned source changes.", value: data.driftNotifications },
    { field: "newVersionNotifications", label: "New versions", offHint: "You won't be alerted when a skill you maintain publishes a version. Skills you watch still notify you.", value: data.newVersionNotifications },
  ];
  return (
    <section className="reveal" style={{ marginBottom: 30 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 4 }}>Skills I maintain</h2>
      <p className="page-sub" style={{ marginBottom: 16 }}>
        As a maintainer you’re alerted when a skill you maintain publishes a new version, or when an external (pointer)
        skill’s pinned source drifts upstream. Turning one off stops that alert entirely — in-app and email. Skills you
        explicitly watch keep notifying you of new versions either way.
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

      <DateFormatPref />
      <LeaderboardPref />
      <EmailNotificationsPref />
      <MaintainerNotificationsPref />
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
