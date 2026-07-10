// Microsoft Graph client for reconciliation. Client-credentials flow (app registration
// with Directory.Read.All / GroupMember.Read.All). Only group membership is read.
// SKILLY_SPEC.md §5, §16 (Phase 1). Network-bound; the reconciler depends on GraphPort
// so it can be tested with a fake.

export interface GraphUser {
  oid: string;
  email: string;
  displayName: string;
  active: boolean;
}

export interface GraphPort {
  getGroup(oid: string): Promise<{ displayName: string } | null>;
  getGroupMembers(oid: string): Promise<GraphUser[]>;
  /** The user's Entra profile photo as a small data URI, or null if they have none / it's too big.
   *  Lets reconciliation populate avatars for users who haven't signed in yet (SKILLY_SPEC.md §5). */
  getUserPhoto(oid: string): Promise<string | null>;
}

// Cap the stored data URI like the web sign-in path (auth.ts) so a huge photo never bloats the row.
const PHOTO_MAX_DATAURI_LEN = Number(process.env.GRAPH_PHOTO_MAX_DATAURI_LEN ?? 200_000);

interface GraphMemberRaw {
  id: string;
  mail?: string | null;
  userPrincipalName?: string | null;
  displayName?: string | null;
  accountEnabled?: boolean | null;
  "@odata.type"?: string;
}

export function graphClient(): GraphPort {
  const tenant = process.env.ENTRA_TENANT_ID ?? "";
  const clientId = process.env.ENTRA_CLIENT_ID ?? "";
  const clientSecret = process.env.ENTRA_CLIENT_SECRET ?? "";
  const base = process.env.GRAPH_BASE_URL ?? "https://graph.microsoft.com/v1.0";

  let token: { value: string; expiresAt: number } | null = null;
  async function getToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
    });
    if (!res.ok) throw new Error(`graph token failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return token.value;
  }

  async function graphGet<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${await getToken()}` } });
    if (!res.ok) throw new Error(`graph GET ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  /** Binary GET (profile photo). Returns a data URI, or null on any non-2xx / empty / oversized. */
  async function graphGetPhoto(oid: string): Promise<string | null> {
    // Prefer a small fixed size (ideal for the bubble); fall back to the default if that size
    // isn't materialized. A user with no photo 404s on both → null.
    for (const path of [`/users/${oid}/photos/96x96/$value`, `/users/${oid}/photo/$value`]) {
      try {
        const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${await getToken()}` } });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength === 0) continue;
        const ct = res.headers.get("content-type") ?? "image/jpeg";
        const dataUri = `data:${ct};base64,${buf.toString("base64")}`;
        if (dataUri.length > PHOTO_MAX_DATAURI_LEN) continue; // too big at this size; try the next/none
        return dataUri;
      } catch {
        /* network error → try next path, else null */
      }
    }
    return null;
  }

  return {
    async getGroup(oid) {
      try {
        const g = await graphGet<{ displayName?: string }>(`/groups/${oid}?$select=id,displayName`);
        return { displayName: g.displayName ?? oid };
      } catch {
        return null; // group deleted / inaccessible
      }
    },
    async getGroupMembers(oid) {
      const members: GraphUser[] = [];
      let path: string | null = `/groups/${oid}/members/microsoft.graph.user?$select=id,mail,userPrincipalName,displayName,accountEnabled&$top=999`;
      while (path) {
        const page: { value: GraphMemberRaw[]; "@odata.nextLink"?: string } = await graphGet(path);
        for (const m of page.value) {
          members.push({
            oid: m.id,
            email: m.mail ?? m.userPrincipalName ?? "",
            // Never use the raw Entra object id as a human name — fall back to UPN/email, else
            // blank (upsertUser keeps any existing real name rather than clobbering it with "").
            displayName: m.displayName ?? m.userPrincipalName ?? m.mail ?? "",
            active: m.accountEnabled ?? true,
          });
        }
        const next = page["@odata.nextLink"];
        path = next ? next.replace(base, "") : null;
      }
      return members;
    },
    getUserPhoto(oid) {
      return graphGetPhoto(oid);
    },
  };
}
