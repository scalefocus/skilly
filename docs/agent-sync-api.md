# Agent sync API

A desktop agent that signs its user in with Microsoft Entra ID can keep that user's skills in step
with skilly, with no key handling by the user. The first client is **AION**. The agent sends one
request with the user's Entra access token and gets back:

- every skill the user can see in the catalog, each with the exact git tag to clone, and
- one **agent key**, valid for a few hours, that the skilly git gateway accepts for cloning any of
  those skills.

The agent then clones, updates and removes its local copies to match the list. The authoritative
specification is `SKILLY_SPEC.md` §69.

Skills only: the MCP server and the Claude plugin marketplaces are not involved.

## Endpoint

`POST /api/agent/v1/sync`

```http
POST /api/agent/v1/sync HTTP/1.1
Host: skilly.example.com
Authorization: Bearer <Entra access token for scope <Application ID URI>/Skills.Sync>
```

There is no request body. The route accepts **only** a bearer token: session cookies are ignored,
so a browser that is signed in to skilly but sends no token gets a 401.

### Response `200`

`Content-Type: application/json`, `Cache-Control: no-store`.

```json
{
  "user": { "id": "3f0c…", "email": "ada@example.com" },
  "key": "q2Y9…",
  "keyExpiresAt": "2026-11-12T20:00:00.000Z",
  "gitBaseUrl": "https://skilly.example.com",
  "skills": [
    {
      "namespace": "global",
      "slug": "case-study-creator",
      "title": "Case Study Creator",
      "description": "Creates a one-slide case study from project notes.",
      "version": "1.0.1",
      "ref": "v1.0.1",
      "gitUrl": "https://skilly.example.com/global/case-study-creator.git",
      "updatedAt": "2026-10-01T10:00:00.000Z",
      "deprecation": null
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `key` | The agent key. Returned once; skilly stores only its hash. |
| `keyExpiresAt` | When the key stops working (12 hours by default, never more than 24). |
| `gitBaseUrl` | The registry's base URL. |
| `skills[].version` | The latest **stable** published version: the one an unpinned install gets. |
| `skills[].ref` | That version's immutable git tag. `git clone --branch <ref>` works. |
| `skills[].gitUrl` | The skill's repo. **Never contains credentials.** |
| `skills[].updatedAt` | When `version` was published (UTC). |
| `skills[].deprecation` | `null`, or `{ "note", "successor": { "namespaceSlug", "skillSlug", "title" } \| null }`. Deprecated skills are still listed. |

**Which skills.** Org-visible skills, restricted skills of the user's namespaces, and restricted
skills shared with those namespaces: the same set the user sees in the catalog. Archived skills,
skills with no stable published version (only yanked, quarantined or prerelease versions, or not
yet tagged), and pointer skills without a working mirror are left out. Sorted by `namespace`, then
`slug`; no pagination.

**A skill is identified by `namespace` + `slug`.** Two namespaces can each have a skill with the
same slug, and both can appear in one response, so a client must not key local folders on `slug`
alone.

### Cloning with the key

```bash
git clone --depth 1 --branch v1.0.1 "https://x-access-token:${KEY}@skilly.example.com/global/case-study-creator.git"
```

The key goes in the URL as the basic-auth password, exactly like an install token. It is valid for
any skill the user can see **at the moment of the git request**: if the user loses access to a
skill, the next clone or fetch of it fails at once. A skill the user cannot see answers the same
404 as one that does not exist. The key is refused by every HTTP API route; only the git gateway
accepts it.

Prefer not to persist the key: if it was passed in the clone URL, git stores it in the clone's
`.git/config`. Fetch updates with a fresh key from the latest sync.

### Errors

Every error is JSON `{ "error": "<code>", "message": "<human text>" }`. A 401 also carries
`WWW-Authenticate: Bearer error="invalid_token"`.

| Status | `error` | When |
|---|---|---|
| 401 | `invalid_token` | Missing, malformed, badly signed or expired token; wrong issuer, tenant or audience; no `oid` claim. |
| 403 | `insufficient_scope` | The token's `scp` lacks `Skills.Sync` (app-only tokens included). |
| 403 | `user_not_provisioned` | The user has no skilly account. Accounts come only from SCIM provisioning; the API never creates one. |
| 403 | `user_disabled` | The skilly account is disabled. |
| 404 | `not_found` | The API is not enabled on this registry. |
| 429 | `rate_limited` | More than 30 requests per user per hour. Honor `Retry-After`. |
| 500 | `internal_error` | Anything else. Details are logged server-side only. |

### Client behaviour (AION)

1. Get an Entra access token for `<Application ID URI>/Skills.Sync`.
2. `POST /api/agent/v1/sync`.
3. For each skill, clone `gitUrl` at `ref` with the key, or fetch and check out `ref` when the local
   copy exists and `ref` changed.
4. Remove local skills it installed earlier that are no longer in the response.
5. Repeat at start and every 60 minutes.

On a first sync each skill costs two to three git requests. A whole office behind one NAT starting
at once can hit the git per-IP limit (`GIT_IP_RATE_MAX`, 600 per minute); retry on 429.

## What users see

Skills the agent clones appear on the user's **Installed skills** page with **AION** as the client,
the usual freshness line, and a single **Remove** action. Remove deletes the entry only; AION keeps
its copy, and the entry returns the next time AION fetches the skill. Each sync also removes the
entries for skills that left the list.

Agent installs are **not counted** as adoption: they add nothing to install counts, the contributor
leaderboard, *Popular in your department*, related skills, achievements or deprecation notices.
Clones are logged to the access log with source `aion`.

## Audit and limits

- Every key mint writes an `agent_key.minted` audit entry: the user, the key's row id, its expiry,
  the client IP and user agent, and how many older keys were removed. Never the key itself. Expect
  about ten entries per agent user per working day.
- A user keeps at most **5** unexpired agent keys; a new one removes the oldest.
- Agent keys are deleted when they expire, when the user is deprovisioned by SCIM, and on GDPR
  erasure. A key whose owner is disabled is refused even before that.
- Rate limit: 30 sync requests per user per hour (per web replica).

## Configuration

Set on the **web** service (the worker needs nothing new):

| Variable | Default | Meaning |
|---|---|---|
| `SKILLY_AGENT_API_ENABLED` | off | `true` turns the endpoint on. Anything else: the route answers 404. |
| `SKILLY_AGENT_API_AUDIENCE` | `ENTRA_CLIENT_ID` | The `aud` a token must carry: the application (client) ID of skilly's Entra app registration. |
| `SKILLY_AGENT_KEY_TTL_HOURS` | `12` | Agent key lifetime in whole hours, 1 to 24. Above 24 is treated as 24. |

The tenant is the existing `ENTRA_TENANT_ID` and must be the tenant GUID (not `common` or
`organizations`). With the flag on and a setting missing, the route stays 404 and the web log says
which setting is missing, the first time the endpoint is called.

Compose: set them in `deploy/.env`. Helm: `web.agentApi.enabled`, `web.agentApi.audience`,
`web.agentApi.keyTtlHours`.

## Ops checklist (Entra admin)

On **skilly's existing app registration**:

1. **Expose an API.** Keep the Application ID URI if one is set, else use
   `api://<skilly-client-id>`. Add the delegated scope **`Skills.Sync`** (admin consent display
   name: "Sync your skilly skills to AION"), and grant admin consent.
2. **Manifest:** set `requestedAccessTokenVersion: 2` (older manifests call it
   `accessTokenAcceptedVersion: 2`). This only changes access tokens issued *for skilly as an
   API*; the web sign-in and the email service account are unaffected.
3. **Authorized client applications:** add the AION Desktop client ID (from the AION team) for
   `Skills.Sync`.
4. **SCIM scope:** every AION user must be in the Enterprise App's provisioning scope, or their
   sync answers `user_not_provisioned`.
5. **No `groups` claim is needed.** Roles and namespace membership come from SCIM-synced groups,
   never from the token.

Then set `SKILLY_AGENT_API_ENABLED=true` on web and restart it.

### Check it

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" https://skilly.example.com/api/agent/v1/sync | jq '.skills | length'
```

```bash
KEY=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" https://skilly.example.com/api/agent/v1/sync | jq -r .key)
```

```bash
git clone --depth 1 --branch v1.0.1 "https://x-access-token:$KEY@skilly.example.com/global/case-study-creator.git"
```

The skill count matches what the user sees in the catalog, the clone succeeds, and the skill appears
under **Installed skills** with client **AION**.
