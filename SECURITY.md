# Security

skilly is an enterprise, self-hosted registry that governs AI agent skills. This document
records the security model, the hardening applied after the June 2026 audit, and the
operator responsibilities that no code change can satisfy.

## Reporting

Report vulnerabilities **privately via GitHub**: open the repository's **Security tab →
"Report a vulnerability"** (GitHub private vulnerability reporting). Never open a public
issue or pull request for a suspected vulnerability. Include a reproduction and the affected
component (web / worker / git gateway / SCIM / deploy).

## Security model (invariants)

These are enforced in code and must never regress (see `CLAUDE.md`):

1. **Roles resolve from SCIM-synced group membership + `role_mappings`, never from OIDC token claims.**
2. **Skill versions are immutable** — a fix is a new version (DB trigger + least-privilege role).
3. **All catalog access is auth-required and strictly visibility-filtered** — restricted skills never leak via search / autocomplete / counts; detail/API return **404 (not 403)** for both restricted and archived skills.
4. **The authenticated git gateway is the only path to skill bytes** — pointer skills are mirrored, not redirected.
5. **`audit_log` is append-only** — the app DB role lacks UPDATE/DELETE, a trigger enforces it, and entries are hash-chained + verifiable.
6. **Tokens** are random, hashed-at-rest (SHA-256), and skill-scoped. **Install tokens** (the consumer install handle, SKILLY_SPEC.md §23) are deliberately **reusable**, with a user-chosen expiry (explicit dates ≤ 1 year, or "Never") and revocation by uninstall; **system installations** are minted by platform admins only and audited on mint/uninstall/reactivate. Query strings / credentials are never logged.
7. **Visibility is per-skill** (`org` | `namespace`).

## Audit (June 2026) — fixes applied

A three-surface audit (web API/auth; worker/git/SCIM; shared/DB/deploy) was performed. All
**P0** and **P1** findings, and most **P2** findings, are fixed:

### P0
- **SSRF allowlist hardening** (`packages/shared/src/net.ts`): added an `isBlockedIp` classifier covering **IPv4-mapped/-compatible IPv6** (`::ffff:a.b.c.d`, hex-packed), stripped the **trailing FQDN-root dot** bypass, and category-classified IPv6 (loopback/link-local/ULA). The worker (`git/mirror.ts`) now **resolves the host and rejects if any A/AAAA record is private/loopback/link-local** (DNS-rebinding defense) and passes `-c http.followRedirects=false` so a 30x can't pivot to an internal host.
- **`ext::` transport stays disabled even in `SKILLY_MIRROR_ALLOW_INSECURE` mode** (`git/mirror.ts`) — the insecure opt-in now only *adds* `file://`, never re-enables command execution.
- **Version immutability completed** (`db/migrations/0017`): the `skill_versions` guard now pins `artifact_object_key`, `external_origin_url`, `external_subdir`, and `is_prerelease` in addition to `semver`/`sha256`/`external_ref`; only `status` and `git_published` may change post-insert.
- **Markdown renderer infinite-loop fixed** (`components/Markdown.tsx`) — a code fence in a (proposer-controlled) `SKILL.md` no longer hangs every viewer's browser.

### P1
- **One-time install tokens are now effectively single-use and skill-scoped** (`worker/git/pgDeps.ts`, `authorize.ts`): validity ends `ONE_TIME_USE_GRACE_SECONDS` (default 60) after first use — wide enough for one clone's multiple protocol-v2 requests, but replay later within the TTL is rejected — and a token presented against a **different skill than it was minted for** is refused. *(Historical note: the one-time token model was later **superseded** by the reusable, owner-revocable install token — SKILLY_SPEC.md §23; the skill-scoping check carries over to the install-token validator.)*
- **Decompression-bomb ceilings during extraction** on both the web upload path (`web/lib/bundle.ts`) and the worker publish/reprovision/refresh path (`worker/git/bundle.ts`); the zip path caps on **actual** decompressed bytes (the declared header size is attacker-controlled).
- **SCIM deprovision** (`worker/scim/router.ts`) now recognizes all common Entra `active:false` PATCH shapes (boolean / stringified / path-less), so a disabled leaver can't retain access + tokens.
- **HTTP security headers**: a **nonce-based CSP** emitted per-request by `web/src/middleware.ts` — `script-src 'nonce-… ' 'strict-dynamic' 'self'` (no `'unsafe-inline'` for scripts), `frame-ancestors 'none'`, `object-src 'none'`, scoped `default-src` — with the static headers (`X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS) in `web/next.config.mjs` and `Cache-Control: no-store` on `/api/*` (the install-token response must never be cached). The posture is operator-selectable via **`CSP_MODE`** (`enforce` default / `report-only` / `off`) and violations POST to `/api/csp-report`. The **worker** (SCIM + git gateway) sets baseline `nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy` on every response. *(The original audit shipped a static CSP with `'unsafe-inline'` for scripts; the nonce upgrade replaced it — the one substantive tightening over the audited policy.)*
- **`/metrics` fails closed in production** when `METRICS_TOKEN` is unset (web + worker) instead of serving openly.
- **Container/deploy hardening**: images build with `--frozen-lockfile` (+ the lockfile is copied in); web runs as the unprivileged `node` user; Helm web/worker pods get `runAsNonRoot`, dropped capabilities, `seccompProfile: RuntimeDefault`, web `readOnlyRootFilesystem`, worker `fsGroup` for the git PVC; Helm refuses to render `change-me*` placeholder secrets.

### P2
- Rate limits added to `promote` (notifies all platform admins), `proposal-action`, `archive`, `yank`, `watch`, and `readme` (re-extracts on each call).
- Catalog full-text `ts_rank` now uses the query parameter's real index (a hard-coded `$2` had fed the limit integer to `plainto_tsquery` for platform admins).
- Helm git-ingress regex tightened to the smart-HTTP endpoints; skills-hub fetch rejects oversized `Content-Length` before buffering.

## Operator responsibilities (not solvable in code)

- **Provide real secrets.** Set strong, unique values for `NEXTAUTH_SECRET`, `SCIM_BEARER_TOKEN`, DB and S3 passwords (Helm now refuses `change-me*`). Prefer `secrets.existingSecret`.
- **Use a scoped object-store account.** The sample compose/Helm wire the **MinIO root** credentials into the app; in production, provision a service account limited to the `skilly-artifacts` bucket and inject those instead (audit M-6).
- **Restrict `/metrics`.** Set `METRICS_TOKEN` (now required in production) and/or scrape it only on an internal port; don't expose it through the public ingress.
- **Pin egress for the worker.** The in-process DNS-resolution + redirect checks narrow SSRF, but a TOCTOU window remains between our resolution and git's; for high-assurance deployments, route worker egress through an allowlisted forward proxy or network egress policy (audit H-2/F1).
- **Set the `skilly_app` DB password via the deploy step.** `db/migrations/0002` creates the role with a placeholder that `migrate.sh` / the Helm migrate-job overwrites — ensure that step runs (audit M-9).
- **Terminate TLS** at your org reverse proxy / ingress; the sample Caddyfile is dev-only.

## Known accepted limitations (v1)

- **In-memory rate limiter** — per-replica; the only truly sensitive path it fronts (install-token minting) is independently bounded by skill scope, user-set expiry, and owner revocation. A shared store is a documented HA upgrade.
- **DB default privileges** grant the app role DML on future tables; append-only intent for new tables relies on triggers/code review. Consider narrowing `ALTER DEFAULT PRIVILEGES` (audit L-1).
- **Direct `git-upload-pack` POST** (without the preceding `info/refs`) is authorized but not access-logged / install-counted (audit F5) — audit completeness, not an authz bypass.
