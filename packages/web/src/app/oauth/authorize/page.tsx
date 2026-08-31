// §29 OAuth authorize + consent. A SERVER component, because this is the one leg of the flow that
// needs the Auth.js/Entra session — which is why the authorization endpoint lives in `web` while
// the token endpoint and the MCP endpoint live on the worker.
//
// Flow: validate the request → if signed out, bounce through sign-in and come back here → show the
// consent screen naming the client, its origin and exactly what it will be able to do → the user
// approves or declines, and we redirect back to the client either way.
//
// Security notes that matter on this page:
//   - an unverifiable client_id / redirect_uri is NEVER redirected to (that would make skilly an
//     open redirector); the user sees an error instead (RFC 6749 §4.1.2.1);
//   - the consent form carries only an opaque request id — the validated request is held
//     server-side, so no hidden field can be tampered with between render and submit;
//   - the page is never cached.
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { getMcpEnabled } from "../../../lib/settings";
import { checkAuthorizeRequest, stashAuthorizeRequest, publicBaseUrl } from "../../../lib/mcpOauth";

export const dynamic = "force-dynamic";

const shell: React.CSSProperties = {
  maxWidth: 520,
  margin: "48px auto",
  padding: "28px 30px",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-lg, 14px)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-body)",
};

function ErrorCard({ message }: { message: string }) {
  return (
    <div style={shell}>
      <h1 style={{ fontSize: 19, margin: "0 0 10px", fontFamily: "var(--font-display, var(--font-body))" }}>
        This connection request isn&rsquo;t valid
      </h1>
      <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--muted)", margin: "0 0 14px" }}>{message}</p>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--faint)", margin: 0 }}>
        Nothing was authorized. This is usually a misconfigured client — check the MCP server URL in
        its settings, or start again from the <a href="/mcp">MCP page</a>.
      </p>
    </div>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await getMcpEnabled())) {
    return <ErrorCard message="A platform administrator has turned the MCP server off on this registry." />;
  }

  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") params.set(k, v);
    else if (Array.isArray(v) && v[0] != null) params.set(k, v[0]);
  }

  const check = await checkAuthorizeRequest(params);
  if (!check.ok) {
    // A verified redirect_uri gets the protocol error; an unverifiable one gets a page.
    if ("redirect" in check) redirect(check.redirect);
    return <ErrorCard message={check.error} />;
  }

  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) {
    // Sign in first, then come straight back to this exact authorize URL.
    const callbackUrl = `/oauth/authorize?${params.toString()}`;
    redirect(`/api/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }
  const access = await resolveUserAccess(oid);
  if (!access.userId) {
    return <ErrorCard message="Your account isn't provisioned in this registry yet — ask an administrator to check your directory sync." />;
  }

  const requestId = stashAuthorizeRequest(access.userId, check.client, check.request);
  const { client } = check;
  const origin = (() => {
    try {
      return new URL(client.redirectUris[0] ?? "").host;
    } catch {
      return null;
    }
  })();

  const row: React.CSSProperties = { fontSize: 13.5, lineHeight: 1.7, margin: 0, color: "var(--ink)" };
  return (
    <div style={shell}>
      <h1 style={{ fontSize: 19, margin: "0 0 6px", fontFamily: "var(--font-display, var(--font-body))" }}>
        Connect <strong>{client.clientName}</strong> to skilly?
      </h1>
      <p style={{ fontSize: 13, color: "var(--faint)", margin: "0 0 18px", fontFamily: "var(--font-mono)" }}>
        {client.clientUri ?? origin ?? client.clientId}
      </p>

      <p style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.6, margin: "0 0 10px" }}>
        Signed in as <strong style={{ color: "var(--ink)" }}>{session?.user?.name ?? "you"}</strong>. If you approve, this
        client will be able to act as you — with exactly your permissions, nothing more:
      </p>
      <ul style={{ margin: "0 0 16px", padding: "0 0 0 20px", display: "grid", gap: 6 }}>
        <li style={row}>read the catalog you can already see, including skill contents</li>
        <li style={row}>create install commands for skills you can access</li>
        <li style={row}>submit proposals, comments, ratings and skill requests as you</li>
      </ul>
      <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, margin: "0 0 4px" }}>It will not be able to:</p>
      <ul style={{ margin: "0 0 18px", padding: "0 0 0 20px", display: "grid", gap: 6 }}>
        <li style={row}>approve or reject proposals — review decisions stay in the browser</li>
        <li style={row}>administer the platform, or delete anything permanently</li>
      </ul>

      <p style={{ fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6, margin: "0 0 20px" }}>
        Anything it creates is marked as coming from an agent, and you can revoke this connection at
        any time from the <a href="/mcp">MCP page</a>.
      </p>

      <form method="post" action="/oauth/consent" style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <input type="hidden" name="requestId" value={requestId} />
        <button type="submit" name="decision" value="deny" className="btn btn-sm">
          Decline
        </button>
        <button type="submit" name="decision" value="approve" className="btn btn-sm btn-primary">
          Approve
        </button>
      </form>

      <p style={{ fontSize: 11.5, color: "var(--faint)", margin: "18px 0 0", fontFamily: "var(--font-mono)" }}>
        {publicBaseUrl()}/mcp
      </p>
    </div>
  );
}
