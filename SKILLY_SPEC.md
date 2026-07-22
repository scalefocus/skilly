# Skilly — Complete Build Spec

> An enterprise-grade, open-source, self-hosted registry for governing Anthropic-style
> `SKILL.md` agent skills across an organization and its business units, with identity
> and access anchored in Microsoft Entra ID.

This document is the authoritative build spec produced from a full design interview.
It is written to be handed to Claude Code (or any engineering team) as the source of truth.
Every decision below was explicitly confirmed.

---

## 0. TL;DR decisions

| Area | Decision |
|---|---|
| Build approach | **Greenfield**, SKILL.md-compatible. SkillHub is a reference, not a base. |
| Name | **skilly** |
| Stack | **TypeScript monorepo**: Next.js (UI+API), separate SCIM/sync worker, Postgres, S3/MinIO |
| Client | **No custom CLI.** Consumption via `vercel-labs/skills` (`npx skills add`); skilly serves an **authenticated git smart server** (skill=repo, version=git tag), token-in-URL basic auth |
| Publishing | **Web UI only** + REST+PAT for scripted publish |
| Identity | **Real SCIM 2.0** (worker-hosted) + **OIDC-only SSO** (Entra). Roles resolved from SCIM-synced groups |
| RBAC | Explicit Entra-group→(namespace, role) mapping. Roles: Platform Admin / Namespace Admin / Namespace Member + implicit propose/consume |
| Visibility | **Per-skill**: org-wide OR scoped to one namespace. No per-individual private, no per-version visibility |
| Skills | **Hybrid**: Hosted (bundle in skilly) and Pointer (external, pinned ref). Both proxied through skilly |
| Versioning | Proposer-supplied semver, validated strictly-increasing, immutable; beta/stable via semver prerelease; `latest`=highest stable |
| Review | Moderated proposal pipeline; review is a **per-namespace policy flag**; global namespace always requires review |
| Deployment | **docker compose** (6 core services + git-perms init + dev proxy); **Helm/K8s now shipped** (§16 #19) |
| License | **Apache 2.0** |

---

## 1. Goals & non-goals

### Goals
- Centralized registry to **publish, version, discover, govern, and distribute** agent skills org-wide and per business unit.
- Compatible with the **Anthropic Agent Skills (`SKILL.md`) standard** — skills built for Claude Code work without translation.
- **Moderated contribution pipeline** with an admin review dashboard.
- **Identity anchored in Microsoft Entra ID** — SCIM provisioning, group-based RBAC, OIDC SSO.
- **Self-hosted, container-native, permissively licensed (Apache 2.0).**
- Complete **audit/provenance trail** for all governance actions.

### Non-goals (v1)
*(Several original v1 non-goals were intentionally delivered later as "Tier 4 — strategic/infra"; those are annotated **✅ SHIPPED** below — see §16.)*
- Not a public marketplace. *(still true)*
- No custom CLI shipped by skilly (rely on the external `npx skills add` tool). *(still true)*
- No SAML (OIDC only). *(still true)*
- No per-individual "private" skills; no per-version visibility. *(still true — pinned invariant #7)*
- ~~No Kubernetes/Helm in v1 (docker compose only).~~ **✅ SHIPPED** — Helm chart at `deploy/helm/skilly` (§16 #19).
- ~~No "watch/follow skill for new versions" notifications.~~ **✅ SHIPPED** — `skill_watches` + new-version notifications (§16 #22, §12).
- ~~No cryptographic hash-chaining of the audit log.~~ **✅ SHIPPED** — tamper-evident chain (§16 #21, §11).
- No multi-language UI (English only, strings externalized). *(still true)*
- ~~No built-in HA (stateless design enables it later).~~ **✅ SHIPPED (core)** — stateless web + HPA, leader-locked worker (§16 #20).

---

## 2. Architecture & stack

**TypeScript monorepo.** Three runtime processes + two stateful backends + a scanner.

```
┌─────────────────────────────────────────────────────────────┐
│  Org reverse proxy (TLS termination)                          │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP
        ┌───────▼────────┐         ┌───────────────────────┐
        │ Next.js app    │         │ SCIM / sync worker     │
        │ (UI + REST API)│         │ - SCIM 2.0 endpoints   │
        │ - catalog      │         │ - Entra reconciliation │
        │ - proposal flow│         │ - scan pipeline runner │
        │ - admin board  │         │ - singleton (leader)   │
        │ - OIDC (Auth.js)│        └─────────┬──────────────┘
        └───┬────────┬───┘                   │
            │        │                        │
      ┌─────▼──┐  ┌──▼────────┐        ┌──────▼──────┐
      │Postgres│  │ S3/MinIO  │        │  ClamAV     │
      │(meta + │  │ (artifact │        │ (scanner)   │
      │ FTS +  │  │  tarballs)│        └─────────────┘
      │ audit) │  └───────────┘
      └────────┘
```

### Stack choices
- **Backend/UI:** Next.js (App Router, Route Handlers, Server Actions) running as a **long-running standalone Node server** (`output: "standalone"`). **Never Vercel.**
- **Auth:** Auth.js (`next-auth`) with the **Entra ID (Azure AD) OIDC** provider. OIDC for authentication only.
- **Worker:** standalone Node service. Hosts the SCIM 2.0 HTTP endpoints, runs Entra reconciliation, and executes the scan pipeline. Runs as a **singleton with leader lock** (advisory lock in Postgres) to avoid double-processing.
- **Datastore:** **PostgreSQL** — relational metadata + **built-in full-text search (`tsvector`)** + append-only audit log. No Elasticsearch/OpenSearch in v1.
- **Artifact storage:** **S3-compatible object store** (bundled **MinIO** for on-prem; real S3 supported). Skill versions stored as **immutable tarballs**.
- **Scanner:** **ClamAV** container + secret-scanning + static heuristics, behind a pluggable interface.

### Repo layout (monorepo `skilly/`)
```
skilly/
  packages/
    web/        # Next.js app + REST API + admin dashboard
    worker/     # SCIM/sync + scan pipeline runner
    shared/     # domain types, RBAC resolution, semver logic, validation
  deploy/       # docker-compose.yml, .env.example, sample reverse proxy
  docs/         # operator + developer docs
```

---

## 3. Data model

Core entities (Postgres). Field lists are indicative, not exhaustive.

### `users`
- `id`, `entra_object_id` (unique, **nullable** — erasure detaches it to NULL, §4; the unique index permits many NULLs), `email`, `display_name`, `status` (active|inactive), `created_at`, `updated_at`, `avatar`, `last_seen`, `last_seen_page`.
- Per-user preferences/state: `date_format` (`eu`|`us`, nullable — overrides the platform default, §13), `leaderboard_hidden` (opt-out of the contributor leaderboard, §21), `email_notifications` (BOOLEAN NOT NULL DEFAULT true — the email-channel opt-out, §12; migration 0053), `drift_notifications` / `new_version_notifications` (both BOOLEAN NOT NULL DEFAULT true — the per-type maintainer-notification opt-outs, §12; migration 0057), `catalog_seen_at` / `review_seen_at` / `system_log_seen_at` / `requests_seen_at` (nav "last viewed" markers for the new-since-last-visit badges, §10/§25/§26), `erased_at` (GDPR tombstone marker, §4).
- Provisioned/updated via **SCIM**. JIT may backfill the *own* profile on first login if SCIM hasn't synced yet.
- `last_seen` (nullable `timestamptz`, indexed `DESC`) records the user's most recent authenticated activity; `last_seen_page` (nullable `text`) records a human-readable label of the page they were last on — see **Currently online** (§4).

### `groups`
- `id`, `entra_object_id` (unique), `display_name`, `created_at`, `updated_at`.
- Provisioned via SCIM (including membership).

### `group_memberships`
- `group_id`, `user_id`. Synced via SCIM. **Authoritative source of "who is in a group."**

### `namespaces`
- `id`, `slug` (e.g. `team-a`, plus reserved `global`), `display_name`, `require_review` (bool), `maintainer_contact` (set by Platform Admin — **free-text**, but the admin editor offers a **user-search typeahead** that fills a picked user's email; a shared mailbox / distribution list is still allowed), `created_at`.
- Created explicitly by Platform Admins. `global` is special: `require_review` always true.

### `role_mappings` (the explicit Entra-group→role binding table)
- `id`, `group_id`, `namespace_id` (nullable for platform-level), `role` (`platform_admin` | `namespace_admin` | `namespace_member`).
- Supports **N groups → one namespace** and **one group → N namespaces**.
- `platform_admin` rows have `namespace_id = null`.

### `skills`
- `id`, `namespace_id`, `slug`, `title`, `description`, `category_id` (nullable FK to `categories` — **back-compat shadow**; since migration 0010 the authoritative skill↔category mapping is the **`skill_categories`** join, supporting multiple categories), `tool_harness` (TEXT — the skill's **coding agent**, a **closed vocabulary**: `generic` (default) ∪ the agents the consumer tool supports; drives the install command's `--agent` flag, §6/§9), `tags` (free-form array), `type` (`hosted` | `pointer`), `visibility` (`org` | `namespace`), `status` (`active` | `archived`), `promoted_from_skill_version_id` (nullable, provenance), `install_count`, `featured_at` (nullable timestamptz; non-null ⇒ **Featured** homepage spotlight, §7), `featured_by` (nullable FK `users`, provenance), `created_at`.
- Denormalized/derived columns (trigger-maintained): `search_tsv` (FTS `tsvector`, §10), `usage_search` (latest active version's usage examples, folded into `search_tsv` at weight D, §10/§20), `watcher_count` (count of `skill_watches` rows), plus `rating_sum` / `rating_count` (below).

#### Tool/harness = coding agent (closed vocabulary)
- `tool_harness` names the **coding agent** the skill targets, chosen from a **closed, curated list** (the agents `npx skills add --agent <slug>` supports — e.g. `claude-code`, `cursor`, `gemini-cli`, `windsurf`, …). The single source of truth is `shared/agents.ts` (`{ slug, label }[]`); the slug is stored, the label is displayed.
- The default is **`generic`** — a tool-agnostic skill that emits **no** `--agent` flag.
- The propose form's tool picker is **closed but searchable** (filter by label or slug), `generic` first then alphabetical by label. Server-side, `verifySubmissionPayload` enforces **closed membership** (`generic` ∪ known agent slugs); the old open-vocabulary derivation is removed.
- **Legacy values** stored before this list (not in it) are **grandfathered for display**: shown as their raw slug and emit no `--agent` (`agentLabel`/`isAgentSlug`). **Write-path carve-out (REQUIRED):** `verifySubmissionPayload` skips the closed-list check when the submitted `tool_harness` equals the target skill's stored value — a legacy slug carried forward verbatim (new-version proposal, reviewer edit, resubmit) must pass; only a **changed** value must be in the closed list. This carve-out used to be a nice-to-have shielded by new-version mode not resending the field; since new-version mode now sends tool/harness (§8), it is load-bearing.
- **Ratings (denormalized, §18):** `rating_sum` (sum of star values) + `rating_count` (number of live ratings), maintained by a DB trigger on `skill_ratings`. Average = `rating_sum / rating_count`; ranking uses a Bayesian-smoothed score.

### `skill_ratings` (§18)
- `user_id`, `skill_id` (composite PK — one live rating per user per skill), `stars` (smallint 1–5), `rated_semver` (the version the rater was on — provenance, not an aggregation key), `created_at`, `updated_at`.
- Ordinary **mutable** rows (editable/revocable) — **never** audit data. `ON DELETE CASCADE` on both FKs (user deprovision removes the vote; trigger recomputes the aggregate).

### `skill_versions`
- `id`, `skill_id`, `semver`, `is_prerelease` (BOOLEAN — the stored column; `channel` = `beta` when true else `stable` is **derived in the app layer**, not a column), `status` (`active` | `yanked`), `usage_examples`, `created_by`, `created_at`.
- `git_published` (BOOLEAN — set true once the worker has synthesized this version's serving tag, §6 install-gating), `content_sha256` (nullable — packaging-independent content-set digest for duplicate detection, distinct from `artifact_sha256`; §8).
- **Hosted:** `artifact_object_key` (immutable tarball in object store), `artifact_sha256`, `artifact_filename` (nullable — the original uploaded filename, e.g. `my-skill.skill`, so the detail-page download serves the bundle back with its original extension; §6/§10. Null for pre-0040 versions and Pointer mirrors).
- **Pointer:** `external_ref` (pinned immutable ref — tag/commit/package version), `external_origin_url`, `external_subdir` (nullable — folder inside a multi-skill upstream repo where `SKILL.md` lives; null = repo root). All three are per-version and immutable with the ref (§6).
- Immutable once published. `latest` = highest **stable** semver among `active` versions.
- `usage_examples` (per-version, surfaced in the UI as a Markdown "Usage" block, §20) — frozen with the version (a change is a new version, invariant #2).

### `skill_maintainers` (§19)
- `skill_id`, `user_id` (composite PK — one row per maintained user), `added_by`, `created_at`. Both FKs `ON DELETE CASCADE`.
- The **explicit** maintainer list. **Effective maintainers = (namespace admins of the skill's namespace, resolved live from `role_mappings`) ∪ this explicit list.** Informational + notification target; grants no authority except curating the co-maintainer list (§4, §19).

### `usage_events` (§21)
- `id` (bigserial), `skill_id`, `namespace_id` (denormalized for the namespace aggregate), `actor_user_id` (always set — views are authenticated), `created_at`. Append-only analytics of **skill-detail views**. Installs are NOT duplicated here — they're read from `access_log` (the git clone). Both FKs cascade (user → SET NULL).

### `proposals`
- `id`, `target_namespace_id`, `target_skill_id` (nullable — null = new skill), `proposed_semver`, `state` (`proposed` | `under_review` | `changes_requested` | `accepted` | `rejected`), `submitted_by`, `materialized_version_id` (nullable, set on accept), `decision_reason`, `created_at`, `updated_at`.
- **Original submission stored immutably**; reviewer edits tracked as revisions.

### `proposal_revisions`
- `id`, `proposal_id`, `revision_no`, `payload` (metadata + artifact reference for that revision), `author`, `note`, `created_at`.
- Captures proposer resubmissions and reviewer edits (with diff for audit).

### `scan_reports`
- `id`, `subject_type` (`skill_version` | `pointer_ref`), `subject_id`, `scanner`, `findings` (json), `severity`, `status`, `cached_for_ref` (for pointer caching), `created_at`.

### `audit_log` (append-only)
- `id`, `actor_user_id` (nullable — null for SCIM/system actions, §5), `action`, `target_type`, `target_id`, `namespace_id`, `before` (json), `after` (json), `source` (`web` | `api` | `scim` | `worker`), `request_id`, `created_at`.
- Tamper-evidence (migration 0008): `seq` (BIGSERIAL), `prev_hash`, `entry_hash` (each row's hash covers its content + the previous hash; verified via `verify_audit_chain()` / `GET /api/audit/verify`, §11). **Seq order = chain order** (migration 0056): the append trigger assigns `seq` *inside* the advisory lock that serializes the chain — previously the BIGSERIAL default was drawn before the lock, so two concurrent appends could invert seq vs chain order, and the verifier (which walks seq order) would flag the inverted pair as tampered **permanently**. 0056 also re-baselines existing chains (via the 0024 trim helper) to repair any inversions already recorded.
- **Append-only is trigger-enforced, not purely grant-based.** Migration 0002 revoked UPDATE/DELETE from the app role, but migration 0024 **re-granted** them and replaced the guard with `audit_guard()`, which still rejects any UPDATE/DELETE *except* inside an explicit, audited admin **trim** transaction that opts in via `SET LOCAL skilly.allow_audit_trim = 'on'` (which then re-baselines the hash chain). So the invariant "audit rows are immutable on every normal path" holds, but the literal "DB role lacks UPDATE/DELETE" is no longer true (§11).

### `access_log` (separate, high-volume; restricted-skill fetches)
- `id`, `actor_user_id`, `skill_version_id`, `skill_id` (nullable FK, `ON DELETE SET NULL` — links a fetch to its skill even when the exact version isn't resolved; powers install analytics, §21), `source`, `created_at`, `is_system` (BOOLEAN default false — the clone presented a **system installation** token, §23; distinguishes system clones from legacy anonymous/tokenless rows, both of which have `actor_user_id = NULL`).

### `tokens`
- `id`, `user_id` (**NULL for system installations**, §23), `type` (`install`; `pat`/`one_time` are dormant legacy enum values — their **rows were purged** by migration 0029, but the enum labels can't be dropped so they persist), `hashed_token`, `skill_id` (FK → `skills`, `ON DELETE CASCADE`), `pinned_semver` (`null` = latest), `scope`, `label` (optional human label, legacy PAT field still present), `expires_at` (`null` = never), `used_at` (first install / `null` = generated-unused), `client_user_agent` (captured at first use), `is_system` (BOOLEAN default false — a **system installation**, §23; a CHECK enforces `is_system = (user_id IS NULL)` for `install` rows), `created_by_user_id` (nullable FK → `users`, `ON DELETE SET NULL` — the platform admin who minted a system install, provenance only), `created_at`.
- **`install` tokens are the durable "installation" handle** (§9, §23): long-lived, **reusable**, skill-scoped, owner-revocable (**system** installations are platform-admin-revocable instead, §23). They are **NOT** deleted on use or expiry — an expired install is *inactive* (reactivatable), an uninstall is a hard delete. Random + scoped; see the invariant-#6 carve-out in §23.

### `categories`
- Controlled vocabulary, admin-managed: `id`, `name`, `description`.

### `notifications`
- `id`, `user_id`, `type`, `payload`, `read_at`, `created_at`, plus delivery bookkeeping (migration 0006): `delivered_at`, `delivery_attempts`, `delivery_error` (drive the leader-only email/webhook delivery sweep, §12).
- A **partial unique index** (migration 0053) pins **one unread coalesced `message.new` row per (user, conversation)** — the §24 coalescing is an atomic upsert (`ON CONFLICT DO UPDATE`), so concurrent posts can never produce duplicate rows (= duplicate emails, §12).

### `email_service_account` (migration 0053)
- **Single row** (enforced) — the §12 Graph email sender: `id`, `account_upn`, `account_display_name`, `account_oid`, `refresh_token_enc`, `access_token_enc`, `access_token_expires_at`, `connected_by_user_id` (FK → `users`, provenance-only — survives GDPR erasure rendering the tombstone label, like `tokens.created_by_user_id`), `connected_at`, `last_refresh_at`, `last_refresh_error`, `updated_at`.
- Token columns are AES-256-GCM-encrypted with the env `EMAIL_TOKEN_ENC_KEY` (§13) — never logged, never in audit payloads (§12/§22). Disconnect hard-deletes the row.

### `skill_categories` (migration 0010)
- `skill_id`, `category_id` (composite PK). The **authoritative** many-to-many skill↔category mapping (`skills.category_id` is a back-compat shadow).

### `skill_watches` (migration 0009)
- `user_id`, `skill_id`, `created_at` (composite PK). Watch/follow list; the publish sweep notifies watchers of new versions (`skill.new_version`, §12). Maintains `skills.watcher_count`.

### `skill_maintainers` is documented above (§19); `skill_ratings` above (§18).

### `pending_mirrors` (migration 0005)
- Pointer-mirror work queue: `id`, `skill_id`, `semver`, `external_url`, `external_ref`, `is_prerelease`, `usage_examples`, `external_subdir`, `created_by`, `attempts`, `last_error`, `created_at`. The leader worker drains it (clone → scan → store → synth, §6), retrying up to `MIRROR_MAX_ATTEMPTS` (default 5) before dead-lettering; a Platform Admin's **Retry mirroring** resets `attempts → 0` / `last_error → null` to re-arm it (§6).

### `platform_settings` (migration 0011)
- Key/value platform config: `key`, `value` (jsonb), `updated_by`, `updated_at`. Holds `proposals_open`, `date_format` (§13), `duplicate_proposal_enforcement` (§8), `max_bundle_bytes` (§6), `upload_chunk_bytes` (chunked-upload chunk size, §6), `chat_poll_intervals` (smart-polling cadence, §24), `max_featured_skills` (Featured-skills homepage cap, §7), `system_log_notify_at` watermark (§25), `email_wrapper_html` (the sanitized §12 email wrapper), etc.

### `upload_sessions` (migration 0058 — chunked hosted-bundle upload staging, §6)
- `id` (uuid PK), `user_id` (FK → `users`, `ON DELETE CASCADE`), `skill_slug`, `filename`, `total_bytes`, `chunk_bytes` (frozen from the `upload_chunk_bytes` setting at session start), `created_at`.
- Pure staging bookkeeping — the part bytes live in object storage under `uploads/staging/<id>/<index>`. Row + parts are deleted on complete/abort, and any session **older than 2 h** is swept (with its parts) at the start of every new chunked upload (§6). Never referenced by catalog tables; staged parts are never servable.

### `install_counters` (migration 0018)
- Monthly install rollup: `month` (date PK), `total` (bigint). Feeds catalog/usage aggregates without scanning `access_log`.

### `skill_downloads` (migration 0040)
- Per-user first-download ledger: `skill_id`, `user_id` (PK pair), `first_at`. One row the first time a user downloads a skill from the detail page (§10). Its purpose is **dedupe**: the `record_skill_download()` function inserts on conflict-do-nothing and only on a fresh insert bumps `skills.install_count` + the current month's `install_counters` + an `access_log` row (`source='download'`). Subsequent downloads by the same user are no-ops for counting. Downloads are **never** listed as installations (those come from used `install` tokens, §23).

### `usage_events` is documented above (§21).

### `related_skills` (migration 0046)
- Precomputed "Skills you might like" neighbours: `skill_id`, `related_skill_id` (PK pair), `shared_count`. Rebuilt **nightly** by the leader-locked worker (`recomputeRelatedSkills`) from the co-install ledger `skill_installs`: `shared_count` = number of users who adopted both skills. Stores a wider top-N candidate list per skill (top ~12 by shared adopters, active skills only) so the read path can drop any the viewer can't see and still fill the top 3 visible. Purely derived/advisory — rebuilt wholesale each run. Surfaced on the detail page (§10).

### `skill_requests` (+ `skill_request_categories`) (migration 0048; `skill_request_files` dropped in 0049; detailed in §26)
- "Request a skill": org-visible wishes for skills that don't exist yet. `skill_requests`: `id`, `requester_user_id`, `title`, `description`, `usage_examples`, `tool_harness`, `state` (`open` | `fulfilled` | `withdrawn` | `removed`), `fulfilled_skill_id`, `fulfilled_by_user_id`, `fulfilled_at`, `created_at`, `updated_at`. Categories via `skill_request_categories` (FK to the shared `categories` vocabulary). Requests are **text-only** — no file attachments (the original `skill_request_files` table was dropped in migration 0049). Fulfilment fields are set once (a snapshot) when a linked proposal is accepted; the row is never deleted on fulfilment (state flips). §26.

### Messaging tables (migration 0031, detailed in §24)
- **`conversations`** — `id`, `subject_type`, `subject_id` (polymorphic; partial unique on `(subject_type, subject_id)`), `created_at`, `updated_at`.
- **`conversation_participants`** — `conversation_id`, `user_id`, `last_read_at`, `created_at` (PK first two).
- **`messages`** — `id`, `conversation_id`, `author_id`, `body`, `context_semver` (nullable TEXT, migration 0059 — **skill-discussion context only**: the skill version the comment is about, §24), `created_at`. Immutable — no edits for anyone; the **only** delete is the skill-discussion **moderator delete** (§24).

### `system_event` (migration 0032, detailed in §25)
- Operational/system-log telemetry (NOT audit — mutable, no hash chain, cheap inserts/retention): `id`, `created_at`, `status`, `method`, `route` (template), `path` (concrete, no query string), `user_id`, `actor_name`/`actor_email` (point-in-time snapshot), `error_code`, `message` (one line, no stack), `request_id`, `duration_ms`, `source`. Trigram GIN index for substring search.

---

## 4. RBAC model & permission matrix

Two role scopes. Roles derive **only** from `role_mappings` against SCIM-synced group membership — **never from OIDC token claims** (avoids Entra's ~200-group claim overage).

### Roles
- **Platform Admin** (platform-level): create namespaces + role mappings, govern `global`, approve in any namespace, see all audit logs, set namespace maintainer, yank/archive anywhere.
- **Namespace Admin** (per namespace): approve/reject proposals targeting the namespace, manage namespace skills, publish versions, yank/archive in-namespace, edit namespace settings.
- **Namespace Member** (per namespace): direct-publish/version into the namespace **only if** `require_review = false`; otherwise their submissions become proposals.
- **Implicit (any authenticated Entra user):** **propose** to any namespace; **consume** (browse/search/install) any skill *visible* to them.

### Permission matrix

| Action | Plat. Admin | NS Admin (own) | NS Member (own) | Auth user |
|---|---|---|---|---|
| Create namespace / role mapping | ✅ | ❌ | ❌ | ❌ |
| Approve/reject proposal | ✅ (any) | ✅ (own ns) | ❌ | ❌ |
| Edit proposal in review | ✅ | ✅ (own ns) | ❌ | ❌ |
| Direct publish/version | ✅ | ✅ (own ns) | ✅ if `require_review=false` | ❌ |
| Propose (new skill / new version) | ✅ | ✅ | ✅ | ✅ |
| Initiate promotion to global | ✅ | ✅ (own ns) | ✅ (own ns) | ❌ |
| Approve promotion to global | ✅ | ❌ | ❌ | ❌ |
| Yank version / archive skill | ✅ (any) | ✅ (own ns) | ❌ | ❌ |
| Override security finding on publish | ✅ | ✅ (own ns) | ❌ | ❌ |
| View audit log | ✅ (all) | ✅ (own ns) | own proposals | own proposals |
| Consume (search/install visible) | ✅ | ✅ | ✅ | ✅ |
| Mint / manage **system installs** (§23) | ✅ | ❌ | ❌ | ❌ |
| Rate a visible skill (§18) | ✅ | ✅ | ✅ | ✅ |
| Manage skill maintainers (§19) | ✅ (any) | ✅ (own ns) | maintainers of that skill | maintainers of that skill |

> **Maintainers (§19)** are an ownership + notification concept and grant **no authority** (invariant #1 — all power stays in SCIM groups + `role_mappings`). The *single* exception is the row above: a skill's own maintainers may curate its co-maintainer list, bounded by the visibility eligibility gate (they can never add anyone who couldn't already see the skill).

### Currently online (presence)
- The **Administration** page has a **"Currently online"** section, **platform-admins only**, listing the users active right now.
- **Presence is activity-window based, not session-based** (sessions are stateless JWTs with no server-side store, so there is nothing to enumerate). Every authenticated request resolves the user through the single `currentAccess()` choke point, which **stamps `users.last_seen = now()`** as a **fire-and-forget, best-effort** write: it never blocks or fails the request, and is **throttled in-process per user (~60s)** so the high call volume (page renders + the app's 60s background polls) doesn't translate into a write per request. A backgrounded tab stops refreshing (client polling pauses when hidden), which is the intended semantics.
- **Last-seen page.** Alongside `last_seen`, presence also tracks **which page the user was last on**, shown in the online list between the identity block and the "active … ago" pill (below). Captured **client-side**: the app shell watches the route (`usePathname`) and fires on every navigation (and on initial mount), resolving the current route to a short **human-readable label** — never a raw pathname or query string (invariant #6) — via a **static route→label map** for fixed pages (Overview, Catalog, Propose a skill, Requests, Proposals, Leaderboard, Installed skills, Notifications, Profile, Usage, Audit, System log, Admin, Quick start, What's new), while the three dynamic-title pages **override** that default label once they've fetched their own data: `/skills/[ns]/[slug]` → `"Skill: <display name>"`, `/requests/[id]` → `"Request: <title>"`, `/proposals/[id]` → `"Proposal: <skill title>"`. The resolved label is POSTed to `POST /api/presence/page {label}` (auth required; a no-op — silent 401, no error surfaced — for a signed-out caller), which calls `touchLastSeen(userId, label)`, the **same choke point and same ~60s per-user throttle** `currentAccess()` uses: a beacon call inside another call's throttle window is dropped just like an extra plain stamp, so the shown page can lag the real navigation by up to the throttle window — an accepted trade-off, consistent with `last_seen`'s existing staleness. Plain `currentAccess()` stamps (no label) update `last_seen` only and never clear a previously-stamped `last_seen_page`. Rows with no page yet (pre-upgrade or never-beaconed) show **"—"** in that slot.
- **Online = `last_seen` within a selectable activity window.** A **window selector** — **5 min (default) / 1 h / 8 h / 24 h / 30 d** — sits **just above the search box**, right-aligned in a header row that mirrors the trend chart's range toggle (the "Users active within the last …; reach out to start a direct message" caption is that row's left-hand label), so the viewing admin decides how generous "online" is (5 min comfortably absorbs the 60s poll cadence; the long windows turn the card into "active today"/"active this month"). The choice is a **per-admin view preference, remembered in the browser** (`skilly.online-window`, same localStorage mechanism as the chart windows) — it is *not* a platform setting and never affects other admins. The server accepts the window as a `window=<minutes>` query param but **validates it against the fixed option set** (anything else falls back to 5) — never an arbitrary interval from the client. Changing the window re-queries the list and count; the **DAU/WAU/MAU counters and the trend chart are unaffected** (their windows are fixed by definition). Only `status = 'active'` users appear (SCIM-deprovisioned users never show). The viewing admin sees themselves.
- The section reuses the **maintainer card** (avatar + name + email), with the **last-seen page** label inserted between the name/email block and the tag slot — same row, muted/secondary text, truncated with an ellipsis (full value on hover via `title`) so a long resolved label never pushes the pill or breaks the row — then the relative activity ("active … ago") in the tag slot and the **"Reach out"** DM action kept; there is no remove control. It shows a **live count**, a **search box** (ILIKE over name/email, debounced), and loads **100 at a time with infinite scroll**, ordered most-recently-active first. It polls every **60s** (visibility-aware): the count always refreshes, and the list refreshes only when it's safe to (scrolled to top, no active search) so it never yanks the admin's view mid-scroll/search.
- **DAU / WAU / MAU counters** sit directly above the online list, inside the same card. Three **rolling** trailing-window counts — `last_seen` within the last **24h / 7d / 30d** respectively — computed live off the **same `last_seen` signal** as presence above (deliberately not a narrower "real navigation only" signal, for consistency) and the same `status = 'active'` filter. They are a **live snapshot only, not a historical trend**: `last_seen` holds each user's most-recent activity, not a log, so there is no way to ask "what was DAU on a past date" — only "how many right now". They **piggyback on the same 60s poll** as the online list (one round trip, not a second endpoint) and always reflect the platform-wide total regardless of the list's search/pagination state.
- Backed by `GET /api/admin/users/online?offset=&limit=&q=&window=` → `{ users, total, hasMore, dau, wau, mau }` (403 for non-platform-admins), each user now also carrying `lastSeenPage: string | null`. `window` is minutes from the fixed option set above; omitted/invalid → 5.
- The page beacon is a separate, narrowly-scoped endpoint: `POST /api/presence/page {label}` — any authenticated user (not platform-admin-gated; every signed-in user beacons their own presence), 401 if unauthenticated, silently ignores a missing/oversized `label` rather than erroring.
- **Active-users trend chart** sits above the DAU/WAU/MAU row, inside the same card — a genuine
  **history**, unlike the live rolling counts below it. Backed by a **dedicated table**,
  `daily_active_users` (migration 0047, `day date primary key, count integer`), written **once a
  day** by a **leader-only worker sweep** (`recordDailyActiveUsers`, mirroring the existing
  interval-sweep pattern — fires once at boot, then every 24h, `DAU_SNAPSHOT_INTERVAL_MS`
  override): `count(*)` of `status = 'active'` users with `last_seen` in the **trailing 25 hours**
  (a 1h buffer over 24h so a slightly-late run still catches a full day), **upserted** on today's
  UTC date so a restart or re-run the same day never double-counts. **No back-fill and no
  missed-day catch-up are possible or attempted** — `last_seen` only ever holds each user's most
  recent activity, never a log, so there is no way to reconstruct a past day's count; a gap in the
  chart from a missed run is simply a gap, and a fresh deployment starts with an empty table that
  grows one point per day.
- **Chart window**: the same **7d / 30d / 90d / All** vocabulary as the Usage page, remembered
  across visits (`skilly.chart.dau-range`). Bucketing is a **fixed mapping** per range (not
  span-adaptive): 7d/30d plot raw daily points; 90d rolls the daily counts into **weekly averages**
  over the trailing 90 days; All rolls into **monthly averages** across the whole collected
  history — an average, not a sum, since summing a "how many people" metric across days is
  meaningless. Sparse history (e.g. the weeks right after this ships) simply renders however many
  points have accumulated — no manufactured zero-filling, no "not enough history" placeholder.
  Backed by `GET /api/admin/users/active-series?range=7|30|90|all` → `{ range, bucket, points }`
  (403 for non-platform-admins); fetched on mount/range-change only (no poll — the data changes at
  most once a day).

### Delete user info (GDPR erasure)
- The **Administration** page has a **"Delete User Info"** section (platform-admins only), between **Platform admins** and **Currently online**. Two header-style typeahead pickers (≥3 chars, debounced, the selection stays in the box with an ✕ to clear): **"Find a user to delete"** and an optional **"Replace maintainer to"**. **Both pickers** render each result (and the selected chip) as a card with the user's **avatar bubble**, name, email, and an **Enabled / Disabled** status chip (active vs. inactive `status`) — so an admin can see at a glance whether the account is already disabled. A right-side **Delete** button enables once a delete-target is selected; clicking it opens a **typed-to-confirm** panel (type the user's display name) summarizing the effects + transfer target + skill count — including, when a transfer target is set, that the user's leaderboard install credits move to the target (§21).
- **Erasure is anonymize-in-place (a tombstone), not a row delete** — a hard `DELETE FROM users` is impossible (`messages.author_id`, `proposals.submitted_by`, `proposal_revisions.author` are `NOT NULL` with no `ON DELETE`; `audit_log` is append-only). The `users` row is **kept and scrubbed**: `display_name = '<their email> - Deleted'` (the former email is **retained inside the display label** so deleted authors stay identifiable in message/proposal threads — e.g. `alice@corp.com - Deleted`; falls back to `Deleted User` if the row had no email), `email = ''`, `avatar = null`, `entra_object_id = null` (**detached** from Entra), `status = 'inactive'`, `erased_at = now()`. *(Trade-off: this favours traceability over strict anonymization — the structured `email` column is cleared, but the former email survives in the human label.)*
- **Deleted (personal data):** `group_memberships` (also strips implicit namespace-admin/maintainer status), `skill_ratings` (aggregate recomputes), `skill_watches`, `notifications`, `tokens` (their install keys — **system installations are exempt** (§23): they have no `user_id`, so the sweep never matches them; if the erased user minted any, `created_by_user_id` stays and renders the tombstone label), and the user's explicit `skill_maintainers` rows.
- **Kept but de-identified** — they now render as **"`<their email> - Deleted`"** because the scrub set `users.display_name` to that label, and every view of authored content joins the live `users` row (via `userLabel`/`nameSql`), so **no edits to the child rows are needed**: their authored `messages` (general chat **and** review comments), `conversation_participants`, `proposals`, `proposal_revisions`, `skill_versions`. **Their skills remain.**
- **`audit_log` is untouched** (immutable, invariant #5) — it retains the actor reference and any name in `before/after`. A new `user.erased` audit row records who erased whom + the transfer summary. (CLAUDE.md's "audit retains actor PII" assumption stands; full audit-PII erasure is explicitly out of scope.)
- **Maintainer transfer (optional):** with a "Replace maintainer to" target, each skill the user **explicitly** maintains gets the target added as an explicit maintainer (`added_by` = the acting admin) **where the target is eligible** (visibility — invariant #3); ineligible/restricted skills are **skipped and reported**, and the erased user's row is removed regardless. Implicit (namespace-admin) maintainerships aren't transferable — they're role-based, and erasure removes the user's group memberships anyway.
- **Leaderboard credit transfer (same optional target):** with a "Replace maintainer to" target, the erased user's `install_credits` rows are **reassigned to the target** instead of deleted, so their contributor-leaderboard standing (installs + "skills adopted", §21) is retained under the successor. Two classes of row are **excepted and deleted** (as plain erasure would): **would-be self-credits** — credits for installs the *target* performed themselves; the no-self-credit rule (§21) holds even through transfer — and **duplicates** — the target already holds a credit for the same install (they co-maintained the skill); one install never counts twice for one person. Credit transfer is **independent of the maintainer-transfer eligibility check**: **all** remaining credits move, including those on restricted skills the target can't see — no leak, because the board exposes only per-person aggregates and never skill identities (invariant #3 holds); the target's "skills adopted" may therefore count skills their leaderboard "Skills" catalog link won't show (that link visibility-filters independently). Reassigned rows keep their original `access_log` timestamps, so both windows stay faithful (the target's 30d numbers may jump). **"Requests fulfilled" is deliberately NOT transferred** — `fulfilled_by_user_id` records who actually did the work, and rewriting it would misattribute history on the request record itself; it stays on the tombstone, hidden from the board as today. **"Skills watched" needs no transfer** — it derives from *current* explicit maintainership, so it already follows the maintainer transfer for eligible skills. With **no target** (including the SCIM erasure path, which never has one), credits are deleted exactly as before (§21 "Erasure removes credit").
- **Re-access:** because the Entra link is **detached** (not blocked), if the erased person still exists in Entra they are re-provisioned as a **brand-new, empty account** (a fresh `users` row) on the next sign-in / SCIM sync — with **no link** to the erased history (which stays "`<email> - Deleted`"). So a deleted user can use the system again later; erasure is best applied to already-offboarded users but is correct either way. `entra_object_id` is made **nullable** to allow the detach (its unique index permits many NULLs).
- **Endpoints:** `GET /api/admin/users/search?q=` (≥3 chars, excludes already-erased tombstones) → `{ users: [{ userId, displayName, email, status, avatar }] }`; `POST /api/admin/users/[id]/erase` `{ transferTo? }` → `{ ok, transferred, skipped, creditsTransferred, creditsSkipped }` (`creditsTransferred` = install-credit rows reassigned to `transferTo`; `creditsSkipped` = self-credit/duplicate rows deleted instead; both `0` with no `transferTo`), all in one transaction. The `user.erased` audit row's `after` carries the same credit counts alongside the maintainer-transfer summary. Guards: platform-admin; not self; `transferTo` ≠ the target; not already erased.

---

## 5. Identity & access (Microsoft Entra ID)

### SSO
- **OIDC only** via Auth.js + Entra provider. Authentication only. No SAML.
- The §12 **email service-account connect** flow reuses this same app registration (authorization-code + `Mail.Send`/`offline_access`) but is **not** a sign-in: it creates no skilly session and grants no roles (invariant #1).
- **Sign-out clears all auth cookies.** Beyond Auth.js's `signOut()` (which drops the session
  token), the sign-out flow calls `POST /api/auth/clear-cookies`, a server route that expires every
  remaining auth cookie (the httpOnly CSRF token and any abandoned transient OAuth cookies — they
  can't be removed by client JS), then redirects to the public home. So nothing skilly set lingers
  in the browser after logout.

### Provisioning — real SCIM 2.0
- Worker hosts `/scim/v2/Users` and `/scim/v2/Groups` (create/update/delete, PATCH semantics, filtering, pagination, bearer-token auth) for an **Entra Enterprise App → Provisioning** integration.
- Delivers real **joiner/mover/leaver** reflection and **pre-assignment** of namespaces before users log in.
- **Roles resolved from synced `group_memberships` + `role_mappings`**, not token claims.
- **Admin sync diagnostics.** The Administration page surfaces an **Identity sync (SCIM)** panel above the role-mapping editors: the count of provisioned **groups** and **users** and the most recent group-sync time. The group→role pickers can only list groups SCIM has provisioned (the `groups` table), so when that count is **0** the panel explains why — and distinguishes the two common causes: **users syncing but no groups** (Entra is provisioning Users but Group provisioning is off / no groups assigned to the app → enable Groups in the Enterprise App's provisioning scope) vs **nothing synced at all** (provisioning off, or wrong SCIM URL/token). This turns the previously bare "No synced groups yet" picker into an actionable self-diagnosis.
- **Every Administration card is collapsible.** The Administration page is the platform admin's single console, and its cards grow over time, so **every** card is a collapsible panel (not just Namespaces): Contribution policy, Duplicate proposals, Maximum upload size, Date & time format, Chat refresh cadence, Install URL expiry, Email notifications (§12), Identity sync (SCIM), Platform admins, Maintenance, Delete User Info, Currently online, and Namespaces. **Card order and the per-card body content are unchanged** — only the header/collapse chrome is added. (Namespaces and Email notifications, previously collapsible on their own, now use this same shared mechanism.)
  - **Header.** Each card's always-visible header shows the card **title**, a **compact live summary** of its current value where that value is already loaded (e.g. Contribution policy → `open to all` / `members only`; Duplicate proposals → `block` / `warn`; Maximum upload size → the selected size · the chunk size; Date & time format → `EU` / `US`; Install URL expiry → `12 months`; Platform admins → mapped-group count; Currently online → the user count; Namespaces → the total namespace count), and a chevron. **Identity sync (SCIM)** additionally shows its **`N groups synced` / `N users synced` ok/warn pills in the header**, and **Email notifications** shows its **status pill** (operational / SMTP fallback / down), so a broken sync or channel stays visible while collapsed (answer 2a). Clicking anywhere on the header toggles the card. The **Currently online** window toggle (`5m/1h/8h/24h/30d`) **moves out of the header into the top of the card body**, so the header is purely the collapse control.
  - **Default + persistence.** Every card starts **collapsed**. Each card's open/closed choice is **remembered per browser** under its own key (`skilly.admin.card.<id>-open`, same localStorage mechanism as the remembered chart windows; `"1"` = open, anything else = collapsed). The legacy `skilly.admin.ns-open` and `skilly.admin.email-open` keys are **retired** — no migration; all admins get a one-time reset to all-collapsed (answer 4).
  - **Animation.** Expand/collapse animates the body open/closed via a height transition (~200ms ease) with the chevron rotating as today; `prefers-reduced-motion` gets an instant toggle with no height animation.
  - **Data & polling unchanged (answer 3c).** Collapsing only hides a card's body — it does **not** stop that card's data fetching or polling. Currently online keeps its 60s poll and trend-chart fetch, Maintenance keeps polling a running rebuild, and Namespaces keeps its loaded pages and active search/filter, all regardless of collapse state. Reopening a card shows current data with no reload flash.
  - **Expand all / Collapse all.** A small **Expand all / Collapse all** control sits at the top of the page (near the page header). It sets every card's open/closed state at once and writes each card's persisted preference, so the bulk choice sticks per browser like an individual toggle.
- **Administration page framing.** The page is the platform-management console, not a namespaces-only screen. Its header reads — eyebrow **"Platform administration"**, title **"Run the platform."**, subtitle *"Every platform-wide control lives on this page. Expand a card to work with it."* The subtitle deliberately does **not** enumerate individual functions (they change often), so no per-feature list needs maintaining as cards are added.

### Identity key — `entra_object_id` MUST be the Entra objectId
- Users are keyed on `users.entra_object_id`, which **must equal the directory objectId GUID** — the value the OIDC `oid` claim carries at sign-in (login resolves the user via `entra_object_id = oid`).
- SCIM writes `entra_object_id` from the SCIM **`externalId`**. Entra's **default** Users mapping sets `externalId = mailNickname` (a username, not the objectId), which would NOT match the `oid` claim — so the Enterprise App's Users mapping **must map `externalId → objectId`** (see deployment manual §7.4). Graph reconciliation already uses the objectId, so it is unaffected.
- **Self-heal:** on sign-in, if no row owns the authenticated `oid`, login relinks the row matched by email/UPN (excluding erased users, at most one row, idempotent) to the real `oid`. This recovers users provisioned under a wrong `externalId` mapping without manual DB surgery; the correct mapping remains the real fix.

### Leaver handling
- **Disable (reversible) — `PATCH active:false`:** SCIM deprovision → user `status = inactive`, **all PATs/tokens revoked**. Entra can re-enable the user; their data survives. Unchanged.
- **Serve-time owner-status gate (belt-and-suspenders):** independently of the deletion above, the
  git gateway **refuses any personal install token whose owning user is not `status = 'active'`**
  (§23 Gateway). This covers every path that can flip a user inactive *without* the token-deleting
  deprovision transaction: a SCIM **`PUT /Users/:id` replace** carrying `active:false` (routes
  through `upsertUser`, which writes `status` but never touches tokens), **Graph reconciliation**
  (maps `accountEnabled → status` on upsert), and any other drift. The PATCH path keeps
  hard-deleting tokens (defense in depth); the gate is what guarantees an inactive user's minted
  URLs stop serving even when deletion didn't happen.
- **Permanent removal — `DELETE /Users/:id`:** runs the **full GDPR erasure** (the same as the admin "Delete User Info" flow, §4) **without a maintainer transfer** — scrub + detach the row (`entra_object_id → null`, so a later re-provision yields a fresh account), delete the user's personal data (group memberships, ratings, watches, notifications, tokens, explicit maintainerships), and de-identify messages/proposals/reviews to "`<email> - Deleted`". **Idempotent** (no-op if already erased) and still returns **204**. Records a `user.erased` audit row with a **null actor** and **`source = 'scim'`**. The worker's `eraseUserByExternalId` mirrors web's `lib/eraseUser.ts` (kept in sync).
- **Authored skills remain** (owned by the namespace, not the individual).
- **Audit log preserves identity** (provenance survives personnel changes; immutable per invariant #5 — deliberately exempt from erasure, §4).

### Bootstrap (first-admin chicken-and-egg)
- `SKILLY_BOOTSTRAP_ADMIN_GROUP=<Entra group object ID>` → members are Platform Admins from first boot. This is the **only** implemented bootstrap mechanism (honored by both web `lib/access.ts` and the worker SCIM store).
- ~~`SKILLY_BOOTSTRAP_ADMIN=<email>` escape hatch~~ — **not implemented** (no code reads it, no doc ships it). Reserved name only.

---

## 6. Skill artifact model

### Hybrid: two types, unified git-serving gateway
- **Hosted** — proposer uploads a `SKILL.md` bundle; skilly stores it as the canonical
  immutable artifact and serves it from its **git smart server** (version = git tag).
- **Pointer** — metadata + a **pinned immutable external ref** (tag/commit/version, never a
  branch). At ingest, skilly **mirrors that exact ref into a skilly-hosted git repo**
  (clone-once + scan), then serves it identically to a Hosted skill.
  - **Optional source subdirectory (multi-skill repos).** A proposer may supply an optional
    **"skill name" = a subfolder** of the upstream repo (e.g. `frontend-design` in a mono-repo
    like `anthropics/skills`). skilly then mirrors **only that folder**, rebased so
    `<subdir>/SKILL.md` becomes `SKILL.md` at the mirror root — yielding a clean single-skill
    repo, so the model stays *one skill = one repo, `SKILL.md` at root*. Blank = the upstream
    `SKILL.md` is at the repo root (skilly's original behavior). The slug is derived from the
    subfolder's last path segment, and the existing `name == slug` rule (§6 format contract)
    is enforced against the mirrored `SKILL.md` so identity can't drift. The skill **must be
    self-contained within its subfolder** (files outside it are dropped); if no `SKILL.md`
    exists at that path at the pinned ref, the mirror **fails loudly** with a clear error.
    The subfolder is validated as a safe relative path (no `..`, no leading `/`, bounded
    charset). **The install command is unchanged** — it still targets skilly's gateway URL
    for that single skill; no `--skill`/`--all` flags appear (those are consumer-side flags for
    repos that contain multiple skills, which a skilly mirror never does). One proposal still
    produces **exactly one** skill — bulk-importing every skill in an upstream repo is out of
    scope.
  - **skills-hub.ai origin (API-mirrored, not git).** A pointer may also originate from the
    skills-hub.ai registry (`npx @skills-hub-ai/cli install <slug>`). **Pinned from the CLI's
    source (v0.4.1)**: that tool does **no git clone and fetches no tarball** — it calls
    `GET https://skills-hub.ai/api/v1/skills/<slug>` (JSON; a pinned version's body is at
    `…/versions/<version>`, returning `instructions` + `contentHash`) and synthesizes a single
    `SKILL.md` locally. skilly mirrors the same way: `external_origin_url` = the canonical API
    URL, `external_ref` = the **registry version** (pinned, e.g. `1.0.0`); the worker fetches
    the pinned version's `instructions` (https-only, timeout + size-capped, SSRF-validated like
    any pointer URL), **builds the `SKILL.md` itself** (frontmatter `name` = the skilly slug, so
    the `name == slug` contract holds; description from the registry), and hands the bundle to
    the **identical** validate → scan → store → synthesize path. Serving, drift re-checks
    (refresh re-fetches the pinned version and compares content), yank/archive, and the install
    command are all unchanged — consumers still clone only skilly's gateway. The adapter
    knowledge lives in `shared/skills-hub.ts` (beside the pinned consumer contract) and the
    worker's `git/skillsHub.ts`; nothing else knows the registry's wire format.
    **The ref of a skills-hub pointer MUST be a registry version** — bare semver (`1.0.0`) or its
    `v`-prefixed twin (`v1.0.0`, tolerated for symmetry with git tags; the worker strips it).
    Branch-like refs (`main`, `HEAD`, …) don't exist on the registry — its version endpoint 404s
    on them, which would burn all mirror attempts and dead-letter the version. So they are
    **rejected at submit time** (`validateSkillsHubRef` in `shared/skills-hub.ts`, enforced by
    proposal/publish payload validation with a clear 422), never left to fail at mirror time.
    The propose form's ref pre-check (`GET /api/pointer/refs`) recognizes skills-hub origins and
    lists the registry's **published versions** (from the skill's root API document) instead of
    git refs, plus its `latestVersion` — feeding the same exists-upstream check and quick-picks.
    **SSRF hardening — the fetched URL is rebuilt, never the raw input.** Both skills-hub HTTP
    sinks (the web ref pre-check `lib/pointerRefs.ts` and the worker mirror `git/skillsHub.ts`)
    first extract the slug with `parseSkillsHubApiUrl` (which enforces exact host `skills-hub.ai`
    + the `/api/v1/skills/` prefix + the kebab slug charset), then fetch a URL **reconstructed
    from the constant host + the validated slug** via `skillsHubApiUrl(slug)` — the user-supplied
    string is used only to derive the slug, never as the request target. Combined with the
    existing https-only + `redirect: "error"` + timeout + size cap, a caller cannot steer the
    request at an arbitrary or internal host (defends the `js/request-forgery` sink; behaviour is
    identical for a canonical origin URL — only trailing query/path noise is dropped).

**Unified rules (both types):**
- Users always `npx skills add` **only skilly's git URL** (single gateway). No direct
  external clone; no direct-URL bypass — Pointer bytes are mirrored, not redirected.
- Visibility scoping, audit, versioning (git tags), and scanning apply identically.
- Pointer skills are **labeled "external"** in the catalog; scanned at mirror time; scan
  results cached per pinned ref.
- **Mirror retries + dead-letter, with an admin retry.** The leader worker retries a failing
  mirror each sweep up to `MIRROR_MAX_ATTEMPTS` (default **5**), recording `attempts` + `last_error`
  on the `pending_mirrors` row; at the cap the row is **dead-lettered** (left in place, never
  re-selected) and the skill's detail page shows *"✕ Mirroring v<semver> failed after N attempts"*
  with the last error. A **Platform Admin** can then **Retry mirroring** from that page
  (`POST /api/skills/:ns/:slug/retry-mirror`, platform-admin only, audited as
  `skill.mirror_retry`): it resets the row's `attempts → 0` and clears `last_error`, so the next
  sweep makes up to `MIRROR_MAX_ATTEMPTS` fresh attempts. No new proposal/version is created — the
  same pinned ref/URL/subdir is re-attempted (use it after fixing a transient upstream/network
  fault; a genuinely wrong ref/URL still needs a new version).
- **Serving architecture:** the canonical immutable artifact (uploaded bundle / mirrored
  ref) lives in object storage; the git smart server synthesizes a per-skill bare repo
  where each published version is an immutable tag built from that artifact. Tag rewrite
  is forbidden (immutability, §7).
- **Install is gated on `git_published`, not just an active version.** A freshly published
  version is `active` immediately, but its serving repo isn't synthesized until the next publish
  sweep (≤60s; the worker's `PUBLISH_SWEEP_INTERVAL_MS`). Offering an install command before then
  hands the user a URL that 404s. So the detail API exposes `latestInstallable` (latest stable
  version with `git_published = true`) and `publishing` (a latest version exists but nothing is
  servable yet); the UI shows a "Publishing…" state until then and the version picker lists only
  `git_published` versions. The install endpoint enforces the same: it refuses to mint a command
  for a not-yet-published version (`409`). §23.
- **`SKILL.md` is synthesized at the repo ROOT** (the artifact's files are committed as-is,
  unwrapped). `npx skills add` installs a single-skill repo by reading a **root-level**
  `SKILL.md` (EXTERNAL_TOOL_CONTRACT `skillMdLocation = "repo-root"`); it scans the root and
  `skills/<name>/`, but NOT an arbitrary top-level `<slug>/` directory — wrapping files under
  `<slug>/` makes the tool report "No skills found". The wire-format layout lives ONLY in
  `packages/shared/src/external-tool.ts`; synthesis must match it.
- **A repo counts as "provisioned" only when it has ≥1 ref — not merely a `HEAD` file.**
  `git init --bare` writes `HEAD` *before* any tag/branch exists, so synthesis that creates
  the bare repo and then fails before `update-ref` (e.g. a transient object-storage outage
  mid-sweep) leaves an **empty repo with `HEAD` but zero refs**. Such a repo must never be
  treated as serviceable: the git server returns **"repository not provisioned" (404)** for
  it (rather than serving a successful but empty clone — which makes `npx skills add` report a
  misleading "No skills found"), and the self-heal sweep treats a ref-less repo as **missing**
  and **re-synthesizes** it from object storage. Provisioning = repo dir exists **and** carries
  at least one ref (loose under `refs/` or in `packed-refs`).
- **The self-heal sweep reconciles the FULL expected ref set against the DB, not just "has ≥1
  ref."** "Has any ref" is too weak — it leaves partial repos broken: a repo missing a specific
  version tag fails a pinned `…#v1.2.0` clone ("Remote branch v1.2.0 not found"), and a repo whose
  tags exist but whose `main` is unborn/stale returns an empty fragment-less ("latest") clone.
  Each sweep therefore, per `git_published` skill: (1) re-synthesizes any active version whose
  `v<semver>` tag is absent (idempotent — an existing tag is left untouched), then (2) repoints
  `refs/heads/main` at the latest-stable tag's commit when it has drifted or was never written.
  This converges any partial state (lost volume, crash mid-sweep, tag-missing, main-missing) back
  to the canonical artifact store within one sweep.

### Format contract (Hosted)
- **Accepted upload formats: `.tar.gz`/`.tgz`, `.zip`, and `.skill`.** The format is detected
  by **magic bytes** (gzip `1f 8b`, zip `50 4b`), not the extension — so `.skill` works whether
  it wraps a gzipped tar or a zip. Unrecognized archives are rejected.
- A **single common top-level wrapper directory is stripped** on extraction (so a bundle
  zipped as `pdf-tools/SKILL.md` normalizes to `SKILL.md` at root).
- Top-level `SKILL.md` with YAML frontmatter: `name` (required, **must match skill slug**), `description` (required), plus `category`, `tool/harness`, `usage_examples`, `version`. Optional `scripts/`, `references/`, `assets/`.
- **Hard validation (blocking):** frontmatter schema + required fields + name==slug.
- **Limits:** **~200 MB bundle cap by default, configurable platform-wide** (admin setting `max_bundle_bytes`: 100 KB / 1 MB / 10 MB / 50 MB / 100 MB / 200 MB / 1 GB; §13). The configured cap is the **single source of truth honored at every stage** — upload, publish re-validation, pointer mirror, pre-scan/refresh, and the download/readme/file-browser extract — via a shared `bundleContentCap(maxBytes)` (the cap with a ≥20 MB decompression-headroom floor). So a bundle accepted at upload can never be rejected by a stricter default later (the web tier reads the setting directly; the worker reads it from `platform_settings`). **Large-upload caveats:** the web tier buffers the whole upload in memory, and **ClamAV's `clamd` refuses streams over its `StreamMaxLength`** — so for the larger tiers (200 MB / 1 GB) raise `clamd`'s `StreamMaxLength` (and web/worker memory) accordingly, or AV will error on oversized bundles (deployment manual). **Block executables/binaries** via a **denylist** of known binary extensions (`exe, dll, so, dylib, bin, o, a, class, jar, msi, apk, dmg, deb, rpm`) — any other extension passes (block-by-exclusion, not a strict text allowlist).
- **Oversize rejection UX (HTTP 413).** The upload route rejects an over-cap body with **413** and
  an error message quoting the configured cap ("the bundle is bigger than the allowed size of
  50 MB") — checked against `Content-Length` before buffering, then against the parsed blob size.
  The bundle-upload surfaces (the propose page and the proposal page's bundle upload — resubmit
  and mid-review `revise`, §8) must
  render a friendly message for **any** 413 — including one generated by a reverse proxy **in
  front of** skilly (e.g. nginx's 1 MB default `client_max_body_size`), whose response carries no
  JSON `error` body because the request never reached the app. For such body-less 413s the client
  falls back to generic copy quoting the attempted file's size — *"This bundle (34 MB) is too
  large for the server to accept. Reduce its size and try again — or contact an administrator."* —
  deliberately **without** quoting `max_bundle_bytes` (a proxy limit lower than the configured cap
  would make that number misleading). A raw `Upload failed (HTTP 413).` must never surface.
  **Deployment caveat** (manual, alongside the ClamAV `StreamMaxLength` note): the org reverse
  proxy's request-body limit must be **≥ the configured `max_bundle_bytes`**, otherwise the proxy
  pre-empts skilly's friendlier app-origin 413 and its rejections are invisible to the System
  log (§25).
- Extraction normalizes both formats to the same in-memory file list; everything downstream
  (validation, scanning, synthesis into the git repo) is format-agnostic.
- **Original upload preserved verbatim for download.** The bundle is stored byte-for-byte at
  ingest, and its **original filename is recorded on the version** (`skill_versions.artifact_filename`).
  The detail-page download (§10) streams those exact bytes back **with the original extension** —
  a `.skill` upload downloads as `.skill`, a `.zip` as `.zip`, a `.tar.gz` as `.tar.gz` — instead
  of re-packing by harness. For versions ingested before this column existed (and for Pointer
  mirrors, which have no upload), the extension is inferred: magic-byte sniff (zip → `.zip`/`.skill`,
  gzip → `.tar.gz`) with a final fall back to the skill's harness (`claude-code` → `.skill`, else `.zip`).
- **Pointer download format choice.** A Pointer mirror is stored as a gzip tarball, but consumers
  often want the zip-based `.skill` bundle format. The download route accepts an optional
  **`format=skill|tar.gz`** query param: `tar.gz` (and no param) streams the stored bytes verbatim;
  **`skill` re-packs on the fly** — the tarball is extracted with the same decompression-bomb guards
  as upload ingest (size/entry caps, symlinks refused, wrapper dir + junk entries stripped) and
  zipped into `<slug>-<semver>.skill`. `format=skill` on an already-zip-backed artifact just serves
  the bytes verbatim under the `.skill` name (a `.skill` IS a zip); `format=tar.gz` on a zip-backed
  artifact is rejected (400 — no zip→tar conversion). On the detail page the primary Download control
  for a **Pointer** skill is a **split-button dropdown** offering **`.skill` (default)** and
  **`.tar.gz`**; Hosted skills keep the single verbatim-download button. Like the install
  version picker (§23), this dropdown **dismisses on an outside click (anywhere off the menu
  and its ▾ toggle) and on Escape**, in addition to closing when a format is chosen.

### Chunked upload (large hosted bundles)
- **Why.** The app imposes no request-body ceiling of its own, but real deployments sit behind
  reverse proxies/gateways whose body-size or timeout limits can silently cut a large multipart
  POST — observed as an opaque `Failed to parse body as FormData` 500 at `/api/uploads`. Chunking
  bounds every HTTP request to the configured chunk size, so any bundle within `max_bundle_bytes`
  uploads reliably regardless of intermediary caps — and gives the uploader a real progress bar.
- **When.** Client-side rule: a bundle **strictly larger than the configured chunk size** uses the
  chunked flow; anything at or below it keeps the existing single multipart `POST /api/uploads`
  (that contract is unchanged). Applies to **both** hosted-upload surfaces — the propose form and
  the proposal page's bundle upload (resubmit and mid-review `revise`, §8).
- **Chunk size (admin setting).** `upload_chunk_bytes` in `platform_settings` — Administration →
  the **Maximum upload size** card gains an **Upload chunk size** control: a **free-form integer
  megabyte input, 1–50 MB, default 5 MB** (a malformed/out-of-range stored value coerces to the
  default; the save validates and rejects out-of-range input with a clear error; audited like the
  other settings). Surfaced to the client alongside the max-bundle limit (`/api/me`), and the card
  header summary shows both (e.g. `200 MB · 5 MB chunks`). Changing it never affects in-flight
  sessions — each session freezes its `chunk_bytes` at start.
- **Flow** (all session-authenticated, same actor requirements as `/api/uploads`; `start` shares
  the `uploads` rate bucket; part PUTs are **not** count-rate-limited — they are bounded by session
  ownership + exact byte accounting instead):
  1. **`POST /api/uploads/chunked`** `{ skillSlug, filename, totalBytes }` — rejects
     `totalBytes > max_bundle_bytes` (413, same message as the single-shot path). **Sweeps orphans
     first:** every staging session (row + parts) **older than 2 h** is deleted before the new
     session is created. Enforces **≤ 3 open sessions per user** (409 otherwise). Returns
     `{ uploadId, chunkBytes }` — the server-authoritative chunk size; the client slices by the
     returned value.
  2. **`PUT /api/uploads/chunked/:id/parts/:index`** — **raw `application/octet-stream`** body (no
     multipart anywhere in this flow). Owner-checked; `0 ≤ index < ceil(totalBytes / chunkBytes)`;
     the received length must be **exactly** `chunkBytes` (non-final part) or the exact remainder
     (final part). Stored at the dedicated staging prefix `uploads/staging/<uploadId>/<index>` in
     the artifact bucket. Re-PUT of the same index overwrites — retry-safe/idempotent.
  3. **`POST /api/uploads/chunked/:id/complete`** — owner-checked; verifies every part is present
     with its expected size, assembles in index order, then runs the **identical** single-shot
     pipeline (extract → blocking validation → advisory scan → verbatim store at an immutable
     artifact key → artifact-keyed scan report → advisory duplicate pre-check) and returns the
     **same response shape** as `POST /api/uploads` (§15). The session row + staging parts are
     deleted on completion **whatever the outcome** (success, 422 validation failure, 503 storage
     failure) — a retry starts a fresh session.
  4. **`DELETE /api/uploads/chunked/:id`** — abort; owner-checked; deletes the session + parts.
     The upload UI calls it best-effort when the user removes/replaces a staged file mid-upload.
- **Resilience: session-only.** Parts are sent **sequentially**, each retried client-side (3
  attempts, short backoff) on network failure. A page reload/navigation abandons the session — no
  cross-session resume; the 2 h sweep collects the leftovers.
- **Progress.** Chunked uploads show a **determinate progress bar** (bytes-uploaded / total,
  advancing per part) on both surfaces; single-request uploads keep today's indeterminate busy
  state.
- **Isolation & invariants.** Staged parts live only under `uploads/staging/…` — never a catalog
  artifact, never servable, invisible to every download/serving path (invariant #4 untouched).
  Nothing lands at a real artifact key until the complete-step pipeline has run, so the
  "validate + scan before store" semantics are identical to the single-shot path. Assembly buffers
  the full bundle in memory (the §6 large-upload caveat above is unchanged). Staging works across
  web replicas because parts live in the shared artifact bucket, not pod-local disk/memory.
- **Single-shot hardening (same change).** `POST /api/uploads` answers an unparseable multipart
  body with a clear **400** (wording indicative: *"the upload didn't arrive intact — a proxy
  between your browser and skilly may have cut it off"*) instead of an opaque 500 in the System
  log.

### Security scanning — pluggable pipeline
- Default scanners: **(a) secret scanning**, **(b) ClamAV malware/AV**, **(c) static risk heuristics** (`curl | bash`, `rm -rf`, exfil/obfuscation patterns).
- **Pre-accept, for both types** (so reviewers never approve blind): **Hosted** is scanned at upload (artifact-keyed report); **Pointer** is scanned by a worker loop that clones the proposal's pinned ref while it sits in review (proposal-keyed report, deduped per ref). Until that loop runs a pointer proposal reads as **`scan pending`** (not "not scanned"); a ref that can't be fetched reads **`source unreachable`**. Pointer versions are scanned again at mirror time on accept (artifact-keyed) and periodically refreshed.
- Report attached to proposal, surfaced in review dashboard.
- **Validation blocks; security findings are advisory** — a reviewer may publish over a finding, **explicitly and audit-logged**.
- **AV transparency:** the ClamAV engine records **every file's result, including clean ones** (clean = an advisory `info`/`av-clean` entry that never raises severity or trips the override gate; a detection is a `critical` `malware` finding). The review page's Security scan section has an **expandable “Anti-virus (ClamAV)” panel** showing the exact per-file engine output even when nothing is flagged — or “not run” when no AV engine is configured (`CLAMAV_HOST` unset, or the hosted-upload path, which runs the pure scanners only).
- Interface is pluggable so orgs can wire Snyk/internal AV.

---

## 7. Versioning, channels, withdrawal

- **Semver, proposer-supplied**, validated **well-formed + strictly increasing**; duplicates/downgrades rejected. No auto-increment.
- **Immutable** versions; a fix = a new version.
- A version need not change the content: a **metadata-only re-version** (§8 *Keep current files*) reuses the previous latest-stable artifact byte-for-byte under a new semver — a normal version in every way (own immutable tag, `latest` repoint if highest stable, watcher notifications, no special marker).
- **Channels via semver prerelease tags:** `1.2.0-beta.1` (beta) vs `1.2.0` (stable). `latest` = highest **stable**; `@beta`/explicit opt-in for prereleases.
- **Each version is published as an immutable git tag** `v<semver>` on the skill's repo
  (consumed via `npx skills add ...#v<semver>`). The default branch points at `latest`
  (highest stable). Tag rewrite is forbidden server-side.
- **Yank a version:** hidden from search/`latest` **and withdrawn from serving**. A leader sweep deletes the version's git tag from the served repo, so a pinned `npx skills add …#v<semver>` fails with *"remote branch not found"*. If it was the latest stable, the default branch repoints to the next stable. Authority: NS Admin (own) / Platform Admin (any). Yanking a skill's **last remaining version** (all versions yanked) also clears its **Featured** spotlight (§7).
- **Restore re-publishes** the identical tag — synthesis is deterministic (fixed author/date), so the re-created tag points at the same commit; the version row/artifact are never mutated (invariant #2).
- **Archive a skill:** soft-delete + audit. Withdrawn from the catalog, search, and the git server (clone → 404). **Reversible:** owners (platform/namespace admin or a maintainer) can still open an archived skill read-only via the detail page and **restore** it (admins); a manager-only **"Archived"** catalog toggle switches the catalog to show **only** the caller's owned archived skills (ownership-scoped, so it can't leak). Consumers get 404. Same authority for archive/restore. Archiving also **clears any Featured spotlight** — restoring does **not** re-pin it (§7).
- **Pinned-to-yanked install is BLOCKED** (the tag is removed). This deliberately favors governance/safety over strict reproducibility — a yanked version is meant to be un-consumable; restore it if a pin must keep working. (A plain `git clone` has no channel to emit a "deprecated but proceed" warning, so the choice is binary: served or withdrawn.)
- Pointer versions pin an immutable external ref + a skilly semver label.

### Official skills (endorsement badge)
- A **platform-admin-only**, **skill-level** flag marking **first-party / sanctioned** skills so users
  can distinguish endorsed from experimental. It is an **endorsement, NOT a security claim** — every
  skill is scanned and (where required) reviewed regardless — hence the label **"Official"**, never
  "Verified". It **changes no gate**: scanning, review, visibility, and install are all unaffected.
- **Data:** `skills.official_at` (timestamptz; non-null ⇒ Official) + `skills.official_by` (the admin
  who set it, for provenance). Nullable, no back-fill — nothing is Official until marked.
- **Authority & lifecycle:** only **platform admins** toggle it (any namespace), via
  `POST /api/skills/:ns/:slug/official { official }` → `manage.setSkillOfficial`. **Skill-level and
  persistent** across future versions (it reflects origin/ownership, not per-release vetting); a
  malicious new version is a review problem, not a badge problem. Every toggle is **audit-logged**
  (`skill.marked_official` / `skill.unmarked_official`); a **fresh** mark **notifies the skill's
  explicit maintainers** (`skill.marked_official`, unmarking is silent).
- **Surfaces:** an "Official" badge (✓, green — distinct from the cyan version chip) on catalog
  **cards**, **list rows**, the **detail page** header, and the **header search dropdown**. The
  detail page also shows provenance — *"Endorsed by the platform · marked by &lt;admin&gt; · &lt;date&gt;"* —
  and, for platform admins, a **Mark / Unmark Official** toggle by the manage controls.
- **Discovery:** an **"Official only"** catalog facet (`?official=1` → `searchSkills.officialOnly`),
  and Official as a **gentle final tiebreaker** in the default sort — after relevance → popularity →
  smoothed rating — so it nudges without burying a better match. Non-official skills are never hidden.
- **Invariant #3:** the badge is extra metadata on **already visibility-filtered** results, so it can
  never reveal a restricted skill.

### Featured skills (homepage spotlight)
- A **platform-admin-only**, **skill-level** pin that surfaces a hand-picked set of skills in a
  **"Featured skills"** section on the **home page**. Deliberately distinct from **Official** (above):
  Official is a **provenance pill** (endorsed origin) that travels with the skill in every surface;
  Featured is a **placement** — a curated homepage spotlight with **no badge** and **no
  catalog/search/sort influence** anywhere else. The two are **independent axes** — a skill may be
  Featured, Official, both, or neither. It **changes no gate**: scanning, review, visibility, and
  install are all unaffected.
- **Data:** `skills.featured_at` (timestamptz; non-null ⇒ Featured — also the **ordering key**,
  most-recent first) + `skills.featured_by` (the admin who pinned it, for provenance). Nullable, no
  back-fill — nothing is Featured until pinned.
- **Invariant — Featured ⟹ installable & active.** A skill can be Featured only while it is **not
  archived** and has **≥ 1 installable version** (a published, git-served version — `latestInstallable`).
  Any transition that breaks this **auto-clears** `featured_at`: **archiving** the skill, or **yanking
  its last remaining version** (all versions yanked). Publishing a later version or restoring a
  yanked one **never re-features** — an admin must re-pin explicitly. Both auto-clears are **audit-logged** as
  `skill.unfeatured` (actor = the archiver/yanker).
- **Authority & lifecycle:** only **platform admins** toggle it (any namespace), via
  `POST /api/skills/:ns/:slug/feature { featured }` → `manage.setSkillFeatured`, re-verified
  server-side. The action is rejected for a non-installable / archived skill (defends the invariant
  above). Every toggle is **audit-logged** (`skill.featured` / `skill.unfeatured`). It is **silent** —
  featuring or un-featuring **never notifies** anyone (unlike a fresh Official mark).
- **Cap (`max_featured_skills`, platform setting, §13).** Integer in **[1, 50], default 10**. Enforced
  at feature time against the **global** Featured set (a namespace-restricted Featured skill still
  counts toward the cap, even though most users can't see it). At the cap, a feature attempt is
  **rejected (409)** and the detail page shows the inline banner *"N skills are already featured.
  Remove one before spotlighting another."* **Lowering** the cap **never evicts** existing pins — they
  remain (and keep rendering) until manually removed; new pins are blocked until the count drops
  below the cap.
- **Surfaces.**
  - **Detail page:** for platform admins only, on an **active, installable** skill, a toggle in the
    action-button row (beside Share/Archive) — **"Spotlight"** to pin, **"✓ Spotlighted"** when pinned
    (click to remove). Hidden on archived / not-yet-installable skills and for everyone who is not a
    platform admin.
  - **Home page:** a **"Featured skills"** card section placed **immediately below the stats row**
    (and **above the "installing is one command" explainer**). **Authenticated users only**
    (signed-out visitors never see it). Cards are **visibility-filtered per viewer** (invariant #3),
    ordered **most-recently-featured first**, and include **only skills with a live published
    version**. The section **renders every currently-Featured skill the viewer may see** — it is
    **not** sliced to the cap, so a just-lowered cap can briefly show more. When the viewer has **zero**
    visible Featured skills the **section is omitted entirely** (no empty state, no admin hint).
    Overlap with "Recently published" is allowed — the two sections are independent.
- **Invariant #3:** the home-page feed is **built from already visibility-filtered results**, so a
  restricted Featured skill is silently absent for anyone outside its namespace — Featured can never
  reveal a restricted skill, its title, or its existence.

---

## 8. Proposal & review workflow

### State machine
```
Proposed ──► Under review ──► Changes requested ⇄ Under review ──► Accepted (→ materialized version)
                  │
                  └──────────────────────────────────────────────► Rejected (with reason)
```

- A proposal targets **a new skill OR a new version of an existing skill**, scoped to a namespace.
- **Closed tool/harness (coding-agent) vocabulary → install `--agent`.** The propose form's tool/harness is a **closed but searchable** picker over the curated agent list (`shared/agents.ts`; label shown, slug stored) — filter by label or slug, `Generic` first then alphabetical. The chosen agent **drives the install command**: a recognized non-generic slug appends `--agent <slug>` at the end of `npx skills add <url>` (§9); `Generic` (the default) appends nothing. Server-side, `verifySubmissionPayload` enforces **closed membership** (`generic` ∪ known agent slugs) — gating propose, direct publish, and reviewer edits/resubmits (`newPayload`). The old open vocabulary (type-a-new-value + derived suggestions) is removed; pre-existing values not in the list are **grandfathered** (shown raw, no `--agent`, **re-validated only when changed** — an unchanged value equal to the target skill's stored `tool_harness` passes even if it's a legacy slug; this carve-out is load-bearing now that new-version mode resends the field). The propose form's **paste-to-fill** preselects the agent when a pasted command carries a recognized `--agent <slug>`. **New-version mode:** the tool/harness picker stays **active** — a re-version may re-target the skill's coding agent (synced to the skill on accept, §8 below). Since `tool_harness` is skill-level, a change updates the `--agent` flag of the install command for **every** version, including already-published ones.
- **Paste-to-fill for pointer proposals.** The propose form offers a paste box (the first field **inside the Pointer / external-git tab**, since it's pointer-specific; the Hosted/Pointer tab strip itself sits at the top of the form) that accepts a consumer-tool install command and fills the pointer fields from it — an **accelerator, not a third source type**: submission, validation, and review are unchanged, and every filled field stays editable. Parsing is a pure shared function (`parseInstallCommand`, beside the pinned wire-format adapter) covering the tool's source forms: full git URL (with optional `#ref`), GitHub `owner/repo` shorthand (normalized to `https://github.com/owner/repo.git`), GitHub `/tree/<ref>/<path>` URLs (split into URL + ref + folder), `--skill <name>` (→ the §6 skill folder; slug derived from its last segment), and the **skills-hub.ai install command** (`npx @skills-hub-ai/cli install <slug>` → the §6 API origin; the skilly slug is suggested from the registry slug and the ref must be a registry **version** — the command names none, so the form pins the registry's **latest version** via the ref pre-check, editable and quick-pickable from the published versions). Rules: for a **git** source, a command without a ref leaves the `main` default in charge (§8 below); `--all` is **rejected** with guidance (one skill per proposal, §6); URL schemes are never rewritten (the §6 SSRF validator remains the gate). **New-version mode:** the paste fills URL/ref/folder but **never changes the locked slug** (and cannot flip the locked source type); pasting a source counts as **explicitly supplying it**, so it switches the form off *Keep current files* (§8 below). A folder whose last segment differs from the slug shows a **soft warning** — submission is allowed, and the mirror-time `name == slug` validation stays the hard gate.
- **Propose a new version from the skill detail page.** Any authenticated user can open the propose flow pre-filled from an existing skill (button on the detail page). In this mode only the **identity and access surface is LOCKED**: the **slug** (the install/repo identity — unique, read-only), the **visibility**, and the **delivery type** (hosted vs pointer). **Everything else is editable**, pre-filled with the skill's current values: the skill-level metadata — **title, description, categories, tags, and tool/harness** — and the version-level inputs — the semver (pre-filled with the next patch above the current latest stable), the usage examples, and the **source**, which is now **optional** (default **Keep current files**, below; or a fresh hosted bundle / a new pinned ref+subdir for a pointer). Anyone who may propose may edit any of these — including retitling the skill — applied at the same accept/publish gate as the version (so in a `require_review = false` namespace, a member's direct publish retitles instantly; that is intended). It targets the existing skill and goes through the **normal review/approval** path (or direct publish where permitted). On accept, a new `skill_version` is created **and the skill's title, description, categories, tags, and tool/harness are synced to the submitted values** (categories/tags added/removed to match; all are skill-level metadata, not version content, so this is allowed — the sync re-fires the FTS trigger so search stays current, and it applies **on accept regardless of channel**: a prerelease re-version still updates the skill-level metadata immediately even though `latest` never moves). Only **visibility** stays frozen (a visibility change remains a skill-management action, never a re-version); the slug is immutable, period.
- **Keep current files — metadata-only re-versions.** In new-version mode the source defaults to **Keep current files**: the new version carries forward, byte-for-byte, the artifact of the skill's **latest stable active version** — the exact bytes an unpinned "latest" install serves. Attaching a bundle (hosted) or explicitly supplying the pointer source (typing or pasting URL/ref/folder — even the *same* URL) switches to the normal fresh-source path with all its gates. Mechanics:
  - **Snapshot at submit.** The proposal payload pins the reused version's `artifact_object_key` / `artifact_sha256` / `content_sha256` / `artifact_filename` (and, for pointers, its `external_origin_url` / `external_ref` / `external_subdir`) at submit time — the reviewer approves exactly the bytes they inspected, even if other versions land mid-review. If the skill has **no stable active version** (nothing published, all yanked, or prereleases only), reuse is unavailable: the form requires a source and the API rejects a reuse submission with **422**.
  - **Hosted:** the materialized `skill_version` **references the same object** — no copy (safe: versions are never hard-deleted individually, objects die with the skill). Scan reports are keyed by object key, so the existing scan verdict carries over — **no re-scan**.
  - **Pointer:** reuse re-pins the same origin+ref+subdir **and reuses the previous version's mirrored artifact directly** — no `pending_mirrors` row, no upstream contact; the submit-time pointer verification (below) is **skipped** (nothing new to verify — the bytes are already in the object store). The scan cache (`cached_for_ref`) carries over the same way. An explicitly supplied source takes the normal path instead: submit-time verification + fresh mirror + worker re-scan.
  - **No-op guard.** With reused files, **at least one field must actually differ** from the current state — title, description, categories, tags, or tool/harness vs the skill row, or usage examples vs the reused version's — otherwise submit is blocked in the form and rejected with **422** by `POST /api/proposals` / `/api/publish` (a bare semver bump is not a version). A fresh source needs no metadata change, as today.
  - **Stale frontmatter is accepted.** The carried-forward `SKILL.md` keeps its old frontmatter and body — its `description` (and optional `version`, and any old-title mentions) may disagree with the new catalog metadata. The catalog is authoritative for display; skilly **never rewrites the file** (bytes, `content_sha256`, and the git tree stay identical). Duplicate detection stays exempt for new-version proposals, so the reused digest matching the predecessor is expected and harmless.
  - **A normal version in every way.** Deterministic tag synthesis from the reused artifact (the `git_published` sweep, §6/§7), `latest`/`main` repoint if it becomes the highest stable, watchers get the standard `skill.new_version` notification, and it appears in the version list like any other — **no special "metadata-only" marker**.
  - **Review presentation.** The review page shows an explicit **old → new diff** of every changed metadata field and a clear *"Files: unchanged — reuses v\<semver\>'s bundle"* note; the **bundle file browser works over the reused artifact** — for pointer reuse too (the mirror is a skilly-stored tarball, so it browses exactly like a hosted bundle instead of only linking upstream).
  - Applies identically to the **direct-publish** path (`require_review = false` namespace members): same reuse semantics, same snapshot, same no-op guard.
- **Duplicate detection → redirect to a new version.** A NEW-skill submission that duplicates a skill the submitter can already see is steered to **propose a new version** of the existing one instead of creating a second copy. Two identities, both **active-only** and **visibility-scoped** (invariant #3 — a duplicate the submitter can't see never blocks them, but is surfaced to the reviewer who can): **pointer** = same slug + same **normalized origin URL** (`normalizeOriginUrl`) + same subdir, cross-namespace (a *different* slug for the same repo is allowed — a deliberate fork/rename); **hosted** = a byte-identical **content set** — `content_sha256`, a packaging-independent digest (`contentDigest`: sha256 over the sorted per-file sha256 of raw bytes, filenames/layout/junk disregarded), so a re-exported bundle still matches even though its whole-archive `artifact_sha256` differs. `content_sha256` is computed at upload (hosted) and mirror (pointer), stored on `skill_versions`, and **backfilled** from object storage by a leader-only worker sweep. The same-namespace+same-slug case is handled earlier by the slug-uniqueness 409; this catches the cross-namespace and identical-content cases it misses. New-**version** proposals are exempt (they intentionally target an existing skill). **Enforcement** is a platform setting `duplicate_proposal_enforcement` (Administration → Duplicate proposals), default **`block`**: the propose form disables submit and `POST /api/proposals`/`/api/publish` return **409** with the match; **`warn`** lets it through with an advisory notice. The slug-uniqueness 409 is always hard regardless. The redirect **carries over** the source the submitter already provided — the staged bundle / pointer fields transition in place into the (slug-locked) new-version flow as an **explicitly supplied source** (so *Keep current files* is off), no re-upload. Reviewers are alerted on the review page (with a link to the existing skill) in both modes, evaluated at the reviewer's own visibility.
- **Pointer proposals are verified at submit time.** Before a pointer (external-git) proposal or direct publish is accepted by the API, skilly confirms the source actually resolves to a `SKILL.md` at the pinned ref + folder — the same resolution the mirror uses (the literal `<subdir>/SKILL.md`, else a folder named after the skill containing one). If it doesn't (wrong URL/ref/folder, or a repo with no `SKILL.md`), the submission is **rejected with 422** and a clear message *before* the proposal is created — rather than dead-lettering at mirror time (the worker's `cloneAndPack` only throws "no SKILL.md found …" on accept). The check is a lightweight, SSRF-hardened partial clone (`--depth 1 --no-checkout --filter=blob:none` + `ls-tree`, identical transport/DNS-rebind guards to the §6 mirror and the ref pre-check) in the web tier; skills-hub registry URLs (fetched via the registry API, not git) skip it. Deeper validation (frontmatter, `name == slug`, scan) still runs at mirror/accept.
- **Pinned-ref default is source-aware.** For a **git** origin the pinned ref defaults to the **`main` branch** — the conventional default branch, and the common case for a repo that publishes no version tags — rather than the proposed version. For a **skills-hub origin** the `main` default never applies (the registry has no branches — §6): the form pins the registry's **latest version** as soon as the pre-check resolves it, and the field's label/placeholder switch to version language. The live ref pre-check (`GET /api/pointer/refs`) validates either way: for git it lists the repo's real branches/tags, for skills-hub the registry's **published versions**; if the typed ref doesn't exist upstream the form warns (`<ref> isn't a branch or tag in this repo — mirroring will fail. Pick one that exists` / the version-flavored equivalent) and offers quick-picks. A ref the proposer typed **deliberately** is never overridden; clearing the field restores the source's default. Server-side, a skills-hub pointer whose ref is not a version is rejected with **422** (§6 `validateSkillsHubRef`).
- **Separate `proposals` and `skills`/`skill_versions` tables.** On accept, skilly **materializes** a new `skill_version` (and a `skill` if new) from the proposal's final revision. Proposal persists in terminal state, linked to the materialized version.
- **Maintainer auto-add on acceptance (§19).** Accepting a version — new-skill or new-version, via review or direct publish — auto-adds the submitter as an explicit maintainer of the skill, eligibility-gated; full rule in §19.
- **Original submission immutable**; every subsequent edit — reviewer edits, proposer mid-review **`revise`**s (below), resubmits — is captured as a new revision with diffs (audit).
- **Changes-requested** loops on the **same proposal thread** (revision history).
- **Proposer edit-on-resubmit.** When a reviewer **requests changes** (`changes_requested`), the **submitter** can revise and **resubmit** (`resubmit` → `under_review`) from the proposal page — not just re-trigger review. The resubmit carries a **new revision** (`newPayload`) and may change, per proposal type:
  - **New-skill proposal:** every field — title, description, **tool/harness**, **visibility**, categories, tags, usage, and the **files** (a fresh hosted bundle, or new pointer url/ref/subdir).
  - **New-version proposal:** the same fields a re-version may otherwise change — **title**, **description**, **categories**, **tags**, **tool/harness**, usage, and the **files** (including switching between *Keep current files* and a fresh bundle/pointer source, in either direction — a switch to reuse re-snapshots the then-latest stable artifact) — plus the **proposed semver**. Only the **slug** (immutable) and **visibility** remain frozen; a visibility change is a separate skill-management action, never a re-version. The no-op guard (§8 above) applies on resubmit too.
  - **Files are proposer-only on resubmit** (a reviewer edit stays metadata-only — the proposer owns the bytes). The **delivery type is locked** (a hosted proposal stays hosted; a pointer stays pointer). A changed artifact/pointer re-runs the **same gates as the initial submission**: `verifySubmissionPayload` (artifact ownership + scan, SSRF/transport allowlist), pointer **`verifyPointerSkill`**, and **duplicate detection** (warn/block policy). A new hosted bundle's scan flows into the accept-time override gate automatically; a changed pointer is re-scanned by the worker.
  - **Reviewers are notified on resubmit** (the namespace's reviewers get a "needs review" notification, excluding the proposer) so a resubmitted proposal doesn't silently re-enter the queue.
  - The **`resubmit` verb** is gated to `changes_requested`; a proposal sitting in `proposed` or actively `under_review` is proposer-edited via the **`revise`** verb instead (next bullet) — same field set, **no state transition**, files replaceable on hosted proposals only.
- **Proposer mid-review edits (`revise`).** Until a decision lands, the proposal stays the proposer's to improve: in **`proposed` and `under_review`** the **submitter** may update the proposal in place via a dedicated lifecycle verb **`revise`** (`POST /api/proposals/:id/actions`). No state change (`proposed` stays `proposed`, `under_review` stays `under_review`); each revise appends one `proposal_revision` (`newPayload`, author = proposer). Applies to **both proposal types** (new skill and new version).
  - **Metadata:** the same field set as resubmit — title, description, categories, tags, tool/harness, usage examples; **visibility** editable only on new-skill proposals (frozen on new-version proposals, as everywhere). Slug and delivery type locked, as always.
  - **Files — hosted proposals only.** The proposer may upload a **replacement bundle**, superseding the staged one; the proposal still materializes exactly **one** `skill_version` on accept. For hosted **new-version** proposals this includes switching between *Keep current files* and a fresh bundle in either direction (a switch to reuse re-snapshots the then-latest stable artifact, §8 above). **Pointer proposals' files are frozen mid-review** — url/ref/subdir are untouchable via revise; changing a pointer source still requires the reviewer to request changes → resubmit.
  - **The proposed semver is LOCKED mid-review.** A revise never changes the version number, for either proposal type. (Changing the semver remains possible only on **resubmit** after `changes_requested`, where it was already allowed.)
  - **Same gates as initial submission.** A replacement bundle runs the full §6 upload path (validation + ClamAV scan) and `verifySubmissionPayload` (artifact ownership + scan verdict — the new scan flows into the accept-time override gate automatically), and the revise re-runs **duplicate detection** under the platform warn/block policy. The **no-op guard** applies: at least one metadata field or the bundle must actually differ from the current revision, else **422**.
  - **Reviewers are notified on every revise** — edits can be impactful and must be visible. A `proposal.revise` notification goes to the namespace's reviewers (excluding the proposer), and the Review-queue badge re-arms naturally (`updated_at` bump, §10). The review page shows the standard revision **diff** (old → new per changed field) plus a *"bundle replaced"* marker with the old/new artifact digests + filenames when the files changed.
  - **Revision-pinned accept (anti-swap).** `accept` carries the **revision number the reviewer inspected**; if the proposal has gained a newer revision, accept fails with **409** ("the proposal changed since you reviewed it") and the reviewer re-reviews the current revision. This closes the inspect→accept race where a proposer could swap bytes between the reviewer's inspection and their accept click. `request-changes` and `reject` are **not** pinned (they materialize nothing).
  - **Last-writer-wins with reviewer edits.** The reviewer metadata-edit capability (dashboard, below) is unchanged and coexists; a proposer's revise may overwrite a reviewer's edit — and vice versa. Every write is its own attributed revision with a diff, so the sequence stays fully auditable.
  - **Superseded staged artifacts are deleted eagerly.** Replacing the bundle deletes the previous **staged upload object** from the object store (and its object-keyed scan rows) once the new revision commits — staged objects are proposal-only, never shared with a live version, so this is safe. A *Keep current files* snapshot references a **published version's** object and is never deleted by a revise. Consequence: the **bundle file browser always browses the current revision's bundle only**; earlier revisions keep their recorded digests/filenames in the history, but their bytes are gone.
  - Audited as **`proposal.revise`** (actor, revision number, field diff, artifact digest change when the bundle was replaced).
- **"My submissions" queue.** The `/proposals` page has **two tabs sharing the same state-filter chips** (Proposed / Under review / Changes requested / Accepted / Rejected): **Mine** — every authenticated user's own proposals (`submitted_by = me`, all namespaces, all states); and **To review** — the reviewer queue (namespaces you administer; platform admins see all), shown only when the caller has review authority. **Both lists are ordered newest-first** (most-recently-submitted on top), **regardless of the filters applied**. The **To review** queue is **paginated server-side** so it scales to any backlog: `GET /api/proposals?tab=review&states=<csv>&cursor=<c>` returns one **batch of 100** as `{ review: { items, nextCursor, counts, total } }`, ordered newest-first by **keyset on `(created_at, id)`** and **filtered by state on the server** — so each batch is 100 *matching* proposals, and the page **infinite-scrolls** the next batch (`cursor = nextCursor`) as the user nears the bottom (`nextCursor = null` ⇒ no more). `counts` is the per-state total across the caller's **full review scope** (independent of the active filter and scroll position), so the filter chips and the **To review** tab badge always show real totals — not just what's been scrolled into view. The initial `GET /api/proposals` (no `tab`) returns `{ mine, canReview }`; **Mine** is returned whole (a person's own submissions are few) and filtered client-side. The default tab is the caller's action-relevant one (To review for reviewers, else Mine); Mine opens with **no state filter** (all the caller's submissions, every state), while To review opens to the three open states. A submitter may always view/act on their own proposal regardless of namespace (mirrors `getProposalDetail`'s submitter-or-reviewer rule).
- Review requirement = **per-namespace `require_review` flag**. If `false`, Namespace Members publish directly (bypass proposal); non-members still go through proposals. `global` always `true`.

### Admin review dashboard
- Gated by namespace-scoped reviewer authority: **Namespace Admins review their namespace; Platform Admins review anything.**
- Reviewers can: inspect (instructions, metadata, bundled scripts, scan report), edit (metadata, SKILL.md, target namespace, visibility), request changes, accept (publish), reject (notify with reason).
- **Bundle file browser (hosted uploads):** the review page shows the uploaded bundle's full directory tree (`GET /api/proposals/:id/files`); a reviewer can read any **text** file inline and **download** the rest, to inspect every file before approving. Same access gate as the proposal detail (reviewer of the namespace or the submitter). Content is served `text/plain`/attachment with `nosniff` so a stored `.html`/`.svg` can never execute, and paths must match a real extracted entry (no traversal). Pointer proposals with a **fresh** source have no skilly-stored bundle pre-accept, so they link out to the upstream repo instead; a pointer **Keep-current-files** proposal (§8) *does* have one — the reused mirror tarball — and gets the same file browser as a hosted upload.
- **Delete a proposal (housekeeping).** A **reviewer** of the proposal's target namespace (namespace admin there, or any platform admin — the same authority that acts on the queue) can **permanently delete** a proposal, to purge spam, duplicates, test submissions, or mistakes that shouldn't clutter the queue. This is distinct from **reject** (a recorded, submitter-notified *decision* that keeps the proposal in terminal `rejected` state) — delete removes the record entirely and is **silent** (the submitter is **not** notified). **Guardrails:** deletable in **every state except `accepted`** — an accepted proposal is the provenance of a now-live, immutable `skill_version`, so it's locked (to remove one, delete the skill/version itself, §7). The submitter has no delete power from this surface (withdrawing one's own submission is not a v1 capability). **Cascade:** `DELETE /api/proposals/:id` runs one transaction that removes the proposal (its `proposal_revisions` cascade), and hand-cleans the polymorphic non-FK dependents exactly as `deleteSkill` does — the review-discussion **conversation** (its messages + participants cascade) and dangling **`message.new`** alerts, the proposal's **pointer scan reports** (`scan_reports` where `subject_type='proposal'`; hosted-artifact scan rows keyed to the object key are **left intact**, shared with any eventual version), and any dangling **`proposal.*` notifications** (`payload->>'proposalId'` now gone). The append-only **`audit_log` is preserved** (invariant #5) and gains a **`proposal.deleted`** entry recording who deleted what. **UI:** an inline **✕** delete button on each **To review** queue row (the same small ghost ✕ used by other inline remove/clear controls, e.g. the admin user-picker; never navigates — its click is isolated from the row link) and a **Delete** button on the proposal detail page, both behind a confirm dialog ("permanently deletes the proposal, its revisions, and its review discussion; the audit record is kept; can't be undone"); on success the row is removed and the state counts + tab badge decremented. A concurrent delete (already gone) resolves as 404 → just drop it from the list; an `accepted` proposal returns 409.

### Promotion to global
- **Re-propose to global:** any member of the owning namespace initiates a proposal targeting `global`; **Platform Admins approve**.
- On accept, materialized as an independent global skill with **provenance link** (`promoted_from_skill_version_id`). Team copy and global copy version independently (possible divergence; manual re-promotion to sync).

---

## 9. Consumption & installation

> **Contract PINNED** (was implementation task #1). Consumer = **`vercel-labs/skills`**
> (`npx skills add <source>`), verified from source v1.5.10. The tool resolves **git
> repositories** (GitHub/GitLab/any clone-able git URL/local) or an unauthenticated
> `.well-known` HTTP index — there is **no tarball-from-registry-URL-with-token path**.
> For git sources it runs `git clone --depth 1 --branch <ref>` and passes the URL to git
> verbatim, so **credentials embedded in the URL flow to git as HTTP basic auth**. The
> `.well-known` path is unauthenticated and therefore unusable for restricted skills.

- **No skilly CLI.** Consumption uses **`npx skills add <source>`**.
- **skilly serves each skill as a git repository over an authenticated HTTP git smart
  server** (decision locked). One skill = one repo; **each version = an immutable git
  tag** (`v<semver>`); `SKILL.md` at repo root (the tool walks depth ~1–2).
- **Install form:** `npx skills add https://x-access-token:<token>@skilly.../<ns>/<skill>.git#v1.2.0`
  - The **token is the git basic-auth password** (username is a placeholder). This is the
    "token-in-URL" model, now as git credentials rather than a query string.
  - **Interactive (the only path):** the detail page's split **Install** button mints an
    **`install` token** (§23) embedded as the basic-auth password. Version is the user's
    choice — **"latest"** omits the `#ref` (serves `main` = latest stable, auto-updating on
    re-clone); a **pinned** version sends `#v<semver>`. The user picks a TTL — an expiry
    **date** (within the platform-configured horizon, default 12 months) or **Never** (`null`). The token is **reusable** (re-clones for
    updates just work) and is the durable installation, not a one-shot window.
  - **Every clone carries a token — org included.** Anonymous/tokenless org clones are
    removed; the unique key is how an install is attributed, listed, and revoked.
  - **No CI/PAT path** — personal access tokens are removed; the install token is the only
    consumer credential. The sanctioned machine path is a **system installation** (§23): a
    platform-admin-minted install token with no owning user — still skill-scoped, still an
    `install` token, audited at mint/revoke.
- **The git smart server is the single gateway:** it validates the token, resolves the
  user, enforces per-skill visibility, logs the fetch to `access_log`. No bypass.
- **Versioning maps to git tags:** `#v<semver>` pins an exact immutable version; the
  default branch tracks `latest` (highest stable). **A tokened URL with NO `#ref` clones
  the default branch = the "latest" install.** Yanked versions keep their tag but are
  excluded from `latest`/search (clone-by-exact-tag still works → warn-and-proceed).
- **Mitigations (mandatory):** install tokens are random + skill-scoped + **owner-
  revocable** (uninstall = hard delete) + bounded by a user TTL (explicit dates capped at
  the platform-configured horizon, **default 12 months**; "Never" is an explicit unbounded opt-in). They are deliberately **reusable**
  (invariant #6 relaxed — see §23); the git server **must never log credentials** (strip
  basic-auth from access logs).
- **No OAuth device flow** (redundant). Install target/lockfile/symlink-vs-copy are owned
  by the external tool (`.agents/skills/` canonical, symlinked into `.claude/skills/` etc.).
- **Coupling risk to `vercel-labs/skills` is accepted** and isolated in
  `packages/shared/src/external-tool.ts` (the only place that knows the wire format).

---

## 10. Search, discovery, taxonomy

- **Free-text search is substring `ILIKE`** over title, slug, description, tags, **and the latest active version's usage examples** (the denormalized `skills.usage_search`, migration 0020) — the **same predicate** for the header dropdown and the catalog grid, so they match identically and respond to **partial words as you type** (a true type-ahead filter). The `search_tsv` `tsvector` (title=A/description=B/tags=C/usage=D) is still trigger-maintained but is **no longer the query path**: we deliberately trade full-text relevance ranking for consistent, responsive substring matching (a conscious choice — revisit if catalog scale makes ranking quality matter; the FTS machinery is retained so that's reversible). Maintainer names remain **not** matched (low value).
- **Two search surfaces, one matcher:**
  - **Header dropdown (every page *except* the catalog):** a typeahead showing the **top 5** matches (name-matches first), opening at **2+ characters**; clicking a result opens that skill, and a keyboard-navigable **"See all results in catalog →"** footer jumps to the full results (same as pressing Enter). Cheap/bounded (no joins or aggregates), rate-limited, visibility-filtered.
  - **Catalog page:** the dropdown is **suppressed**; the same top-bar box becomes a **live filter of the card/row grid** — typing (2+ chars, debounced ~250ms) writes `?q=` via `router.replace` (merged with the other filters, kept out of history) and the grid re-queries + re-ranks on each keystroke, exactly like choosing a category or tool. The box is **seeded from `?q=`** on arrival, and **clearing it restores the full catalog**.
- **Strictly visibility-filtered, auth-required.** A restricted skill must **never** appear in search, autocomplete, or counts for users outside its namespace. **No anonymous browsing.**
- **Facets (implemented):** category, tool/harness, hosted-vs-pointer. The hosted-vs-pointer facet is labelled **"Source"** in the catalog UI with options **"Hosted"** and **"External"** — "External" being the one user-facing name for pointer skills, matching the `external` pill on catalog cards and the "External source" panel on the detail page (never "Mirrored"; mirroring is the internal mechanism, not the user-facing name). (Namespace, channel/stable-vs-beta, and scan-status facets are **deferred** — not computed or surfaced in v1.)
- **"My Skills" toggle** (`?mine=1`): narrows the catalog to skills the caller is an **explicit maintainer** of (`skill_maintainers`, §19) — the same definition as `maintainsSkills` in `/api/me`. Implicit (namespace-admin) maintainership is **not** included: "My Skills" means skills named to you, not every skill in a namespace you administer. Visibility-filtered like everything else.
- **Maintained-by view** (`?maintainer=<userId>&by=<name>`): the same explicit-maintainer filter for an **arbitrary** person (used by the leaderboard's per-row "Skills" action, §21). The catalog shows a **dismissible "Skills maintained by &lt;name&gt;" banner** (the name is carried in the URL, no extra lookup) and, on arrival, **ignores the viewer's other saved filters** (category/tool/type/My-Skills) to show everything by that maintainer the viewer can see. Both surfaces share one server filter (`searchSkills.maintainerUserId`); the `maintainer` value is validated as a UUID and the result is **still viewer-visibility-scoped** (invariant #3), so it never reveals a restricted skill to someone who couldn't already see it.
- **Presentation:** the catalog offers a **cards / list toggle** (card grid vs a compact one-line list; same data + visibility filtering, pure view preference persisted client-side). The skill detail page shows **created** (skill row) and **last updated** (newest version — versions are immutable, so the latest version's timestamp IS the last content update) dates.
- **"New to you" discovery (per-user, not a global window):** each user has a `catalog_seen_at` marker. The Catalog nav item shows a **superscript "new items" count** (1–9, then `9+`) of skills that became visible to *that user* since they last opened the catalog (`created_at > catalog_seen_at`, visibility-filtered — a new *version* of an existing skill is not a new skill and isn't counted). The same predicate flags individual catalog entries with a **"new" edge badge** (cards and list rows), so the badged rows are exactly the ones the count refers to. The marker is **advanced when the user leaves the catalog**, not on entry, so the count, the badges, and any in-visit filtering/sorting stay stable for the whole visit; the next visit only flags genuinely newer skills. This is explicitly **not** an "updated in the last N days" window — a skill the user has already seen never shows as new, and a skill older than any window still shows as new on its first sighting. The Review queue badge works the same way (`review_seen_at`), without per-row badges — and it is a **combined** count of everything needing the user on the Proposals page since they last opened it, both halves matched on the proposal's **`updated_at`** against the same `review_seen_at` (so a single visit clears both, and the state transition that makes an item actionable re-arms it):
  - **Reviewer half** — proposals in their review scope that need a reviewer: state `proposed` (a first look) or `under_review`. Because it keys on `updated_at`, a **resubmit** (`changes_requested → under_review`, which leaves `created_at` unchanged) re-arms the badge — so reviewers are re-notified when a proposer submits changes — and a mid-review **`revise`** (§8) re-arms it the same way (it bumps `updated_at` without changing state).
  - **Proposer half** — the caller's own proposals returned as **`changes_requested`** (their turn to revise & resubmit). So a pure proposer who never reviews still gets a 1–9+ badge when changes are requested on their submission.
  - `changes_requested` is deliberately the **proposer's** signal, not the reviewer's (it's waiting on the proposer), so it counts only in the proposer half.
  - **Proposals page default filters:** the **To review** tab opens with the three open states selected (Proposed + Under review + Changes requested) — everything still in flight; **My submissions** opens with **no filter selected** (all your submissions, every state).
- **Requested skills mirrors the Catalog's "new to you" mechanic exactly (§26):** each user has a `requests_seen_at` marker; the **Requested skills** nav item shows the same superscript **1–9 / 9+** count of **open** requests posted since they last opened the page, and the same predicate flags individual request cards/rows with the **"new" edge badge**. Keyed strictly on `created_at` — editing an already-seen request never re-flags it (matching the Catalog's "a new version isn't a new skill" rule, not the Review queue's `updated_at` re-arm rule). **No visibility filter** (requests have no namespace) and **no distinction by who posted a request** — a requester sees their own just-posted request flagged "new" too, same as anyone else. The marker advances **on leaving** `/requests` (including its detail pages, which share the surface — opening one request and navigating away marks every currently-open request seen, the same blast radius the Review queue already has for `/proposals/:id`), not on entry.
- **Download** (`GET /api/skills/:ns/:slug/download?semver=&format=`): the detail page can download a skill version as a file — a **primary button** for the latest stable version and a **per-row** button on each active version. A **governed, visibility-checked** path (same posture as the SKILL.md `readme` route; rate-limited) — NOT a consumer install (the git gateway is that, per invariant #4). The stored artifact is served **verbatim with its original extension** (`.skill`/`.zip`/`.tar.gz`; §6), named `<slug>-<semver>.<ext>`. The optional **`format=skill|tar.gz`** param (§6 *Pointer download format choice*) lets Pointer downloads re-pack the mirrored tarball as a `.skill` zip; the detail page renders the Pointer primary Download as a **split-button dropdown** (`.skill` default, `.tar.gz` alternative). Only **active (non-yanked)** versions are downloadable; **archived** skills only by owners.
- **Taxonomy:** `category` = controlled vocabulary (admin-managed) + optional free-form `tags`; `tool/harness` = controlled enum.
- **Ranking:** with a query active, **name matches first** — a skill whose **title or slug** contains the term sorts ahead of one matched only in its description/tags/usage — then popularity (`install_count`), then the **Bayesian-smoothed rating (§18)** as the final tiebreaker. This is the **"Relevance"** sort (the default); with no query, popularity leads. A dedicated **"Top rated"** sort orders by the smoothed rating directly, **"Latest"** by most-recent version. A star value is never a match term.
- **"Skills you might like" (related skills):** the skill **detail page** ends with a *"Skills you might like"* section — up to **3** other skills **most often installed together** with this one (pure **co-install** signal, no content similarity). Computed **nightly** by the leader-locked worker (`recomputeRelatedSkills`) from the per-`(user, skill)` adoption ledger `skill_installs` (§21): two skills are related when the same users adopted both; `shared_count` = number of shared adopters. Stored in **`related_skills`** (migration 0046) as a wider top-N candidate list per skill so the read path (`relatedSkills` → `GET /api/skills/:ns/:slug/related`) can **visibility-filter per viewer** (invariant #3 — restricted skills never surface to outsiders) and still fill the **top 3 the viewer can see** **and hasn't adopted yet**, ranked by shared adopters then `install_count`. Active skills only. **Already-installed exclusion:** a neighbour the viewer has adopted (a `skill_installs` row — git install **or** first download, uninstall-agnostic) is dropped. **Empty-state:** if there were visible neighbours but the viewer has installed **all** of them, the section shows *"You have all related skills."*; if there were **no** visible neighbours to begin with (a new/low-adoption skill, or all its neighbours restricted-invisible), the section is **hidden** entirely. (`relatedSkills` returns `{ related, allInstalled }` to tell those two empty cases apart; the nightly rebuild means a brand-new skill won't appear as a neighbour until the next run.)
- **On-demand rebuild (Administration → Maintenance):** a **platform admin** can trigger the recompute without waiting for the nightly run, via a **"Rebuild now"** button in a **Maintenance / background jobs** card. Because the batch job lives on the worker, the button doesn't run it inline — it **signals** the worker: the route (`POST /api/admin/jobs/related-rebuild`, platform-admin only, **audited** as `job.related_rebuild_requested`) sets `platform_settings.related_rebuild_requested_at`; the worker's short **signal poll** (leader-only) picks it up, runs `recomputeRelatedSkills`, and **clears** the flag. The recompute takes a **Postgres advisory lock** so a manual run and the nightly sweep never collide (the second caller skips). Both runs stamp `related_last_run_at` + `related_last_run_count` into `platform_settings`, which the card shows ("last rebuilt … · N links"); `GET /api/admin/jobs/related-rebuild` returns that status and whether a run is in flight, and the button polls it (idle → *Rebuilding…* → done).

---

## 11. Audit logging

- **Governance audit** (`audit_log`, append-only — enforced by the `audit_guard()` trigger; see the §3 note on the migration-0024 admin-trim carve-out, which is the only path that may UPDATE/DELETE and is itself audited):
  - Proposal lifecycle (incl. reviewer edits and proposer mid-review `revise`s with diff, decision reasons, accept→version link).
  - Catalog mutations (publish, new version, yank, archive, **mark/unmark Official** (§7), **feature/un-feature** (`skill.featured` / `skill.unfeatured` — incl. the automatic un-feature on archive or last-version yank, §7), visibility change, namespace reassignment).
  - **Scan overrides** (`proposal.scan_override`).
  - **Discussion moderation** (`skill.discussion_message_deleted` — moderator, comment author id, skill, message id; **never the body** — §24 *Skill discussion*). Posting a comment is not audited (the immutable message row is its own provenance).
  - Governance/identity (namespace create/delete, role-mapping changes, SCIM sync results, **`user.erased`** (§4/§5), **`settings.updated`**, **`audit.trimmed`**, and the §12 email channel: **`email.account_connected`** / **`email.account_disconnected`** / **`email.template_updated`** — account UPN + actor, never tokens). *(Personal install tokens are not audited; **system installations ARE** — `install.system_minted` / `install.system_uninstalled` / `install.system_reactivated` (§23), the compensating control for a shared, visibility-bypassing credential. PAT/one-time-token actions are gone with the install-token model, §23.)*
- **Access/fetch logging** split into a separate high-volume `access_log` (restricted-skill fetches) so the provenance view stays readable.
- **Read access (`/api/audit`):** Platform Admin → all; Namespace Admin → own namespace; **everyone else → 403** (the endpoint is admin-only). A regular user's view of *their own proposals' lifecycle* is surfaced on the proposal detail page, not through the audit-log endpoint — so the §4 matrix's "own proposals" cell is a proposal-detail capability, not audit-log access.
- **Retention:** configurable, **default indefinite**. **SIEM export via syslog/stdout** (structured JSON).
- **Hash-chaining deferred.**
- **Viewer filtering (`/audit`):** the default view is unchanged — the newest 100 entries, infinite-scroll
  in pages of 100 over **all** history within the viewer's scope. Layered on top, all optional and
  composable (each an additional `AND`, never widening scope — invariant #3):
  - **Action category** chips (All / Proposals / Skills / Versions) — `action LIKE 'prefix%'`.
  - **Search box** (debounced) — a **plain cross-table `ILIKE`** over the human-meaningful fields:
    `action‖target_type‖target_id‖namespace_slug‖actor_name‖actor_email` (joined live; the
    `before`/`after` JSON is deliberately **not** searched). No denormalization and no trigram index:
    `audit_log` is append-only + hash-chained and lower-volume than the system log, and the query is
    bounded by `ORDER BY created_at DESC LIMIT 100` against the `created_at` index, so a sequential
    ILIKE is acceptable.
  - **Date range** — two native `<input type="date">` From/To fields (the [ExpiryPicker](packages/web/src/components/ExpiryPicker.tsx) widget pattern; the OS renders the calendar). Each end is
    independent and optional; the picked **local** day is resolved to UTC instants — From = start-of-day,
    To = **inclusive** end-of-day (`23:59:59.999` local) — and compared against `created_at`. With no
    date set, search/browse span all history.
  - **`✕ clear filters`** (catalog pattern) — shown only when any filter is active; resets action → All,
    search → empty, From/To → empty (back to the default newest-100 view).
  - Filters are **view-only**: Trim and Verify-integrity operate on the full chain regardless, and the
    filter bar is kept visually separate from those admin actions.
  - **`GET /api/audit`** gains `q`, `from`, `to` (ISO) alongside the existing `action`, `namespaceId`,
    `limit`, `offset`.
- **CSV export (`GET /api/audit/export`), platform admins ONLY** (namespace admins keep their
  in-app read scope but get no bulk-download button — a namespace admin exporting a CSV would
  otherwise be a quiet way to exfiltrate actor names/emails at scale). Honors the **same active
  filters** as the on-screen list (action/search/date range) — export downloads exactly what's on
  screen, unlike Trim/Verify which always act on the full chain regardless of filters. Capped at
  **`AUDIT_EXPORT_CAP` = 50,000 rows**, newest-first; a filtered set larger than the cap still
  downloads (the most recent 50,000), with `X-Total-Matching`/`X-Exported-Count` response headers
  driving an in-app "exported N of M — narrow the range" notice. Columns: `id, created_at, action,
  target_type, target_id, namespace_slug, actor_name, actor_email, source, before, after` —
  `before`/`after` as their raw JSON string (lossless; matches the in-app viewer). RFC 4180
  quoting, UTF-8 BOM (Excel-friendly).

---

## 12. Notifications

- **Channels (v1):** in-app notification center (always-on) + **email** (two transports — the admin-connected **Graph service account** preferred, env-configured **SMTP** as fallback; see *Email channel* below) + **pluggable outbound webhook** channel (Teams/Slack integration itself deferred). Email/webhook are fanned out by the leader-only worker delivery sweep (§16 #14): each undelivered row is rendered, sent over the configured channels, and marked delivered exactly once with retry/back-off; when no external channel is operational, in-app **is** the delivery and rows are marked delivered immediately.
- **Read semantics:** opening the in-app inbox **is** the read action — all of the user's notifications are marked read server-side on load (no per-item or "mark all read" buttons). The just-opened visit keeps the "new" highlight on items that were unread so the user can see what arrived; the topbar bell badge clears immediately.
- **Events:**
  - To namespace reviewers/admins: new proposal / resubmission / mid-review revision (§8 `revise`) in their namespace queue.
  - To proposer: under-review started, changes requested (with note), accepted/published, rejected (with reason).
  - To **maintainers (§19)**: they are implicit watchers of their skill — `skill.new_version` on publish (deduped against explicit watchers) and `skill.drift` when the pointer-refresh job detects upstream drift (**once per drift onset**, not per refresh pass — see *Drift notifications fire once per onset* below). Both maintainer pings honor the per-user **maintainer notification preferences** (below). No review-queue notifications (they hold no review power).
  - To **watchers ∪ effective maintainers** (minus the author, minus opt-outs, visibility-filtered at insert): `skill.discussion` when someone comments on the skill's Discussion card — **coalesced per skill per recipient until read**, exactly like `message.new` (§24 *Skill discussion*). Gated by the per-user `discussion_notifications` toggle (below); unlike `skill.new_version`, an explicit watch does **not** outrank this opt-out.
- **Out of scope:** the header **system banner (§27)** is a separate, dedicated mechanism — it
  never creates a `notifications` row and never triggers email/webhook delivery.
- **Deferred:** —

### Notification content (human-readable subject + body)

**Principle.** Every notification is human-readable — **never** a raw event key or a JSON dump. One
uniform voice across **all** types, both email transports (Graph HTML + SMTP plain-text), and the
in-app center. This **supersedes the old generic fallback** that emitted `skilly: <type>` as the
subject and `JSON.stringify(payload)` as the body; the fallback is now a human sentence too, so no
current or future type can ever leak JSON to a user.

- **Subject** — `Skilly - <Title>`, where `<Title>` is a **short, fixed, human label per type** (not
  the event key, not per-instance detail — names/skill/version live in the body). Capital-S
  **"Skilly"** is deliberate here (an email-sender-style prefix) even though product prose elsewhere
  styles the name lowercase "skilly". The `<Title>` is the **single source of truth shared with the
  in-app center's per-type label** — one map in `@skilly/shared`, consumed by both the worker email
  renderer and the web notifications page — so the inbox pill and the email subject stay in lockstep.
- **Body** — one plain sentence stating what happened, with the concrete names / skill / version /
  reviewer-note inline, followed by a **clickable call-to-action phrase** linking to the relevant
  place. The renderer authors links in a lightweight **`[label](url)`** form; that link form is the
  **only** markup it emits (everything else is plain text).
- **Links — both transports carry the same link as the in-app row (§12 invariant).**
  - **HTML part:** `[label](url)` → `<a href="url">label</a>` (escaped; only `http(s)` URLs pass the
    existing safe-URL check). Bare `http(s)://` URLs still auto-link (unchanged), so the
    manage-preferences footer keeps working.
  - **Plain-text part:** `[label](url)` → `label: url` (the URL stays visible so text clients keep it
    clickable).
  - **No `PUBLIC_BASE_URL` configured:** the CTA degrades to the **bare label with no link** — the
    sentence still stands on its own (this replaces the old "proposal `<id>`" text degrade).
- **Per-type content** (Subject shown without the `Skilly - ` prefix; links are absolute via
  `PUBLIC_BASE_URL`):

  | Type | Subject | Body sentence | CTA → link |
  |---|---|---|---|
  | `message.new` — direct | Direct message | You have a new direct message from {fromName}. | See the message → `/?conversation={conversationId}` |
  | `message.new` — proposal/request thread | New message | {fromName} posted a new message in "{title}". | View the discussion → `/proposals/{proposalId}` or `/requests/{requestId}` |
  | `skill.new_version` | New version published | {ns}/{slug} published version {semver}. | View the skill → `/skills/{ns}/{slug}` |
  | `skill.discussion` | New discussion comment | {fromName} commented on {ns}/{slug}. | View the discussion → `/skills/{ns}/{slug}#discussion` |
  | `skill.drift` | Upstream drift detected | {ns}/{slug} has drifted from its pinned upstream ref ({ref}). | Review it → `/skills/{ns}/{slug}` |
  | `skill.marked_official` | Skill marked official | {ns}/{slug} was marked official. | View the skill → `/skills/{ns}/{slug}` |
  | `request.fulfilled` | Skill request fulfilled | Your skill request "{requestTitle}" was fulfilled by {byName} with {ns}/{slug}. | View the skill → `/skills/{ns}/{slug}` |
  | `proposal.submitted` | Proposal submitted | Your skill proposal was submitted and is awaiting review. | View it → `/proposals/{proposalId}` |
  | `proposal.needs_review` | New proposal to review | A new skill proposal is awaiting your review. | Review it → `/proposals/{proposalId}` |
  | `proposal.start_review` | Proposal under review | Your skill proposal is now under review. | View it → `/proposals/{proposalId}` |
  | `proposal.request_changes` | Changes requested | Your skill proposal needs changes. *(+ `Reviewer note: "{note}"` when a note is present)* | View it → `/proposals/{proposalId}` |
  | `proposal.resubmit` | Proposal resubmitted | Your skill proposal was resubmitted. | View it → `/proposals/{proposalId}` |
  | `proposal.revise` | Proposal updated | A skill proposal in your review queue was updated by the proposer. | Review it → `/proposals/{proposalId}` |
  | `proposal.accept` | Proposal accepted | Your skill proposal was accepted. *(+ reviewer note when present)* | View it → `/proposals/{proposalId}` |
  | `proposal.reject` | Proposal rejected | Your skill proposal was rejected. *(+ reviewer note when present)* | View it → `/proposals/{proposalId}` |
  | `system.error` † | System log events | There are {count} new system log events. | View the system log → `/system-log` |
  | *fallback (any other type)* | Notification | You have a new notification in skilly. | Open skilly → base URL *(CTA omitted when no base URL)* |

  † `system.error` stays **in-app only** (never emailed, §25); its row exists so the renderer is
  **total** and no path can emit JSON even if delivery rules later change.

- **No schema change.** Every field above already lives in the notification `payload` (§3
  `notifications`; §24 `message.new` coalescing) — this is a **rendering** change (plus the §24
  `?conversation=` deep link and the shared label map), **not** a migration.

### Maintainer notification preferences (per-type opt-outs)

- **Three per-user toggles** on the **Profile** page (`/profile`), grouped with the email-channel
  toggle below: **"Upstream drift on skills I maintain"** (`users.drift_notifications`) and
  **"New versions of skills I maintain"** (`users.new_version_notifications`) — both
  `BOOLEAN NOT NULL DEFAULT true` (migration 0057; existing users backfilled ON) — plus
  **"Discussion comments on skills I maintain or watch"** (`users.discussion_notifications`,
  `BOOLEAN NOT NULL DEFAULT true`, migration 0059; gates `skill.discussion` — §24 *Skill
  discussion*). `GET /api/me` returns them; `PATCH /api/me { driftNotifications,
  newVersionNotifications, discussionNotifications }` updates them.
  Toggling is **silent** (not audited), matching the other profile prefs.
- **Row-level, not channel-level (contrast `email_notifications`).** An opted-out user is
  filtered out of the recipient set **at insert time** in the worker (the publish sweep's
  `skill.new_version` insert; the pointer-refresh `skill.drift` insert) — no in-app row, no bell
  badge, no email, no webhook. The email toggle below stays channel-level and orthogonal
  (it suppresses email for rows that *do* exist).
- **What each gates:**
  - `drift_notifications` gates `skill.drift` entirely — drift only ever targets effective
    maintainers, so there is no other route to preserve.
  - `new_version_notifications` gates only the **maintainer-derived** recipients of
    `skill.new_version`. **An explicit watch always wins:** a `skill_watches` row keeps notifying
    regardless of the toggle (watching is its own per-skill opt-in; its off-switch is unwatch).
    The recipient set becomes: watchers ∪ ((explicit maintainers ∪ namespace admins) minus
    opted-out users).
  - `discussion_notifications` gates `skill.discussion` for **every** recipient route —
    maintainer-derived **and** watcher-derived (deliberate contrast with `new_version`: it is the
    only way to keep watching a skill for versions while muting its chatter). Recipient set:
    (watchers ∪ effective maintainers) minus the author, minus opted-out users, visibility-filtered
    at insert time (§24 *Skill discussion*).
- **No safety floor — deliberately.** Namespace admins can opt out like anyone, so a skill whose
  effective maintainers have all opted out drifts with **no one pinged**. Accepted: the toggle
  silences the *ping*, never the *record* — the `pointer.drift_detected` audit row, the
  `pointer_ref` scan report (status `drift`, high-severity `upstream-ref-mutated` finding), and
  the skill page's scan surface remain regardless of anyone's preference.
- **Forward-only.** Flipping OFF deletes no already-created notification rows; flipping ON
  backfills nothing missed while off.
- **GDPR erasure:** nothing new — the columns live on `users` and are scrubbed with the row (§4).

### Drift notifications fire once per onset (dedup)

- **Problem this fixes:** the pointer-refresh job re-checks each pointer version roughly daily
  (default `minAgeSeconds` 23h) and previously re-inserted `skill.drift` on **every** pass while
  the drift persisted — a persistently-drifted version pinged its maintainers daily until
  re-versioned.
- **Rule:** on detecting drift, the job inserts `skill.drift` notifications **only at drift
  onset** — when the version's most recent prior `pointer_ref` scan report, **ignoring
  `unreachable` rows**, is not already `status = 'drift'`. Consecutive drift passes stay silent;
  a pass that observes the content matching again (`scanned`) re-arms the notification, so a
  later re-drift pings anew. An `unreachable` blip between two drift passes does **not** re-arm.
- **Notification-only.** The audit row (`pointer.drift_detected`) and the per-pass `pointer_ref`
  scan report keep recording **every** detection, unchanged — dedup narrows who gets *pinged*,
  not what gets *recorded*.
- Composed with the opt-outs above: recipients = effective maintainers minus
  `drift_notifications = false` users, evaluated at onset time.

### Email channel (per-user opt-out + two transports)

- **Per-user toggle.** `users.email_notifications` (BOOLEAN NOT NULL DEFAULT **true** — migration 0053; existing users default ON via the migration). Surfaced on the **Profile** page (`/profile`) alongside the Date-format / Leaderboard preferences; `GET /api/me` returns it, `PATCH /api/me { emailNotifications }` updates it. The toggle governs **email as a channel**: a user who turns it off receives no notification email over **either** transport — the mechanism of sending is invisible to the user. In-app and the org webhook are unaffected. The delivery sweep checks the flag per recipient at send time; recipients **without an email address** are skipped the same way (the row is still marked delivered on schedule).
- **Transport selection (exactly one fires per email):** the email **channel** has two **transports**. The **Graph service account** sends when *operational* (connected + token refreshable + wrapper saved + `EMAIL_TOKEN_ENC_KEY` present — below); otherwise **env SMTP** (`SMTP_HOST` et al.), exactly as before — plain-text, no wrapper; with neither, no email (in-app only). A non-operational Graph transport therefore degrades to SMTP where configured. A notification that fires while **no transport is operational** is marked delivered on schedule and is simply in-app only (same contract as SMTP-unconfigured today) — **emails are never queued to burst-send later** when a transport recovers. Distinct from that: a **transient send error on an operational transport** (Graph 5xx, SMTP connection failure) follows the existing per-row retry/back-off (`delivery_attempts` up to the max) — retrying a real send failure is not burst-sending. **Graph throttling (429) is special-cased**: it consumes **no** attempt — the sweep records the error, stops its batch, and pauses delivery until the `Retry-After` window elapses (default one sweep interval) — so sustained throttling can never park rows or drop their email.
- **Coalescing carve-outs:** `message.new` is one coalesced row per conversation, refreshed until read — and the refresh **must preserve the row's delivery bookkeeping** (update-in-place; a delete+reinsert would reset `delivered_at` and re-email on every new message — §24 amended to match) → **at most one email per conversation until the recipient reads it**. `system.error` platform-admin alerts stay **in-app only** (rows are pre-stamped `delivered_at`, §25) — no email even when the channel is up.
- **Opt-out discoverability:** both transports append a **"Manage email notifications"** pointer to `<PUBLIC_BASE_URL>/profile` — an HTML footer link on wrapped Graph mail, a trailing plain-text line on SMTP mail.

### Email service account (Graph `sendMail`)

- **What it is:** a platform-admin-connected Entra account — expected practice a **dedicated service mailbox** (e.g. `skilly-notifications@…`) — whose **delegated** token skilly uses to send notification email via **Microsoft Graph `POST /me/sendMail`** (Exchange Online / Outlook). Sent mail accumulates in that mailbox's Sent Items.
- **Connect flow:** the Administration page's **Email notifications** card (below) has a **"Set email service account"** button → standard **authorization-code** OAuth against the **existing skilly Entra app registration** (`ENTRA_CLIENT_ID`), scopes `openid profile email offline_access Mail.Send`, dedicated redirect URI `/api/admin/email/callback`. The admin signs in **as the service account** in that window; the callback (guarded by the initiating platform-admin's session) exchanges the code, stores the account identity (UPN, display name, `oid`) + encrypted tokens, and the card re-renders as connected. Connecting while an account is already connected **atomically replaces** the single row (the previous tokens are destroyed); the `email.account_connected` audit payload records the **replaced UPN** — no separate disconnected event. **This flow is not SSO** — it creates no skilly session and grants no roles (invariant #1 untouched; §5). Deployment prerequisites (§13): delegated `Mail.Send` + `offline_access` admin-consented on the app registration, plus the extra redirect URI.
- **Storage & encryption (invariant #6 extended, §22):** the single-row `email_service_account` table (§3, migration 0053) holds the account identity + `refresh_token_enc` / `access_token_enc` / `access_token_expires_at`. Token columns are **AES-256-GCM-encrypted** with the env-provided **`EMAIL_TOKEN_ENC_KEY`** (32-byte base64, shared by web + worker; §13). Tokens are **never logged and never appear in audit payloads**. Without the key, the connect button is disabled with a config hint (and a previously stored account can't be decrypted → the Graph transport is non-operational).
- **Refresh:** the worker renews the access token silently via the refresh token when expired (Entra **rotates** refresh tokens on use — the rotated token is re-stored each time). Refresh is **serialized through the single `email_service_account` row** (`SELECT … FOR UPDATE`; the rotated token is re-stored before commit) so exactly one refresher runs at a time — uncoordinated concurrent refreshes would invalidate the rotated token family; the **web test-send path refreshes under the same lock**. The sweep validates/refreshes on its regular cadence **even when no email is pending**, keeping the status pill current and the rotating refresh token alive through quiet periods. "Token set and not expired" therefore means **refresh still succeeds**: the account stays connected indefinitely until Entra revokes it (password change, conditional access, revocation) or an admin disconnects. On refresh failure the sweep records `last_refresh_error` + `last_refresh_at` and the Graph transport goes non-operational; the next successful refresh clears it. **Network-level failures (DNS/egress/timeout) are recorded exactly like HTTP failures**, and a non-operational Graph transport never blocks the sweep's SMTP/webhook/in-app work. **Failures raise no notifications** (that would overwhelm admins one email-not-sent at a time) — surfacing is the admin card's status pill only.
- **Admin card:** a **collapsible "Email notifications" card** on the Administration page, **collapsed by default**, open/closed remembered per browser (localStorage — the Namespaces-card pattern, §5). Contents: a **status pill** tracking the email channel — **Operational** (Graph sending), **"SMTP fallback"** (Graph transport down but env SMTP configured, so emails still flow plain-text), or **"Email notifications down"** (no transport operational) — with the two non-Operational states showing the Graph-side reason (not connected / token refresh failing / no wrapper saved / encryption key missing); the connected account (display name, UPN, connected-by + when); and actions: **Set email service account** (connect / re-connect), **Disconnect** (hard-deletes the row incl. tokens), **Send test email** (sends the current wrapper around a sample message to the clicking admin's own address via Graph; requires the channel operational; unaudited — it mails only the actor), plus the wrapper editor (below).
- **Audit (§11):** `email.account_connected` / `email.account_disconnected` (account UPN + actor — never tokens) and `email.template_updated`. All of it platform-admin-only, server-re-verified.

### HTML message wrapper (WYSIWYG)

- **What it is:** a platform-admin-authored HTML template wrapped around every Graph-sent notification email. Stored in `platform_settings` under `email_wrapper_html`. **No saved wrapper → the Graph transport is not operational** (degrades to SMTP/none, above) — there is deliberately **no built-in default wrapper**.
- **Editor:** a true **WYSIWYG rich-text editor** inside the admin card (new dependency — e.g. TipTap) with common formatting controls (headings, bold/italic/underline, lists, links, alignment, text color), **usable in the mobile viewport** (responsive toolbar) and WCAG 2.1 AA like the rest of the UI (§14).
- **Placeholder contract:** the literal, case-sensitive token **`[SYSTEM MESSAGE]`** must appear **exactly once** — save is rejected with an inline error on zero *or* multiple occurrences, validated server-side after sanitization.
- **Sanitization:** wrapper HTML is sanitized server-side on save (allowlist-based: strip `script`/`iframe`/`object`/`embed`/`form`, `on*` handlers) — primarily so the in-app editor/preview renders it safely. URL-bearing attributes (`href`/`src`/`action`/`formaction`/`xlink:href`/`background`) are **allowlisted by scheme/type**, not denylisted: `http:`/`https:`/`mailto:` pass through, and `data:` URIs pass through **only** for the raster image subtypes `data:image/png`, `data:image/jpeg`, `data:image/gif`, `data:image/webp` (inline images in the template); every other scheme — `javascript:`, `vbscript:`, and every other `data:` subtype (notably `data:image/svg+xml` and `data:application/xhtml+xml`, both of which can carry executable script) — is stripped. This closes a prior gap where only the `data:text/html` subtype was denylisted, leaving other script-capable `data:` subtypes to pass through unchecked.
- **Rendering a notification email:** subject and body follow the **Notification content** contract above. The rendered body becomes the system message — HTML-escaped, newlines → `<br>`, its **`[label](url)`** call-to-action turned into a clickable anchor, and any bare `http(s)://` URL still auto-linked (absolute via `PUBLIC_BASE_URL`) — so **every email carries the same link as the in-app notification**. That fragment replaces `[SYSTEM MESSAGE]`; the "Manage email notifications" footer link is appended after the wrapper output even when the template omits it. Emails are sent **multipart/alternative**: plain-text part = the body with each `[label](url)` flattened to `label: url` (+ the manage-preferences line), HTML part = the wrapped output — deliverability plus a faithful fallback.

---

## 13. Configuration, secrets, deployment

### Configuration (env / mounted config; secrets external, never in images)
- Postgres URL; object-store endpoint+creds; OIDC (tenant, client id/secret); SCIM bearer token; SMTP; registry base URL; scan config; retention policy; `SKILLY_BOOTSTRAP_ADMIN_GROUP`; **`EMAIL_TOKEN_ENC_KEY`** (32-byte base64 — encrypts the §12 email service-account tokens; shared by web + worker; required only for the Graph email transport). *(The **install-token max TTL** is no longer an env var — it's the global-admin `install_max_ttl_months` platform setting, §23. The legacy `ONE_TIME_TOKEN_TTL_SECONDS` still ships in `.env.example`/compose but is vestigial — install tokens don't use it.)*
- **Entra app prerequisites for the §12 Graph email transport** (documented deployment step): the existing skilly app registration needs delegated **`Mail.Send`** + **`offline_access`** admin-consented and the extra redirect URI **`/api/admin/email/callback`** registered. Env-SMTP remains the consent-free fallback.
- **`CSP_MODE`** (`enforce` default | `report-only` | `off`) selects the Content-Security-Policy posture the web middleware emits (§22 *Content-Security-Policy*): ships **enforcing**; `report-only` is a no-block shakedown; `off` reverts to the legacy `unsafe-inline` policy. Production-only — development always uses the lenient dev policy.
- Ship a documented `.env.example`.

### Deployment — docker compose (v1)
Six core services: **Next.js app**, **SCIM/sync worker**, **Postgres**, **MinIO**, **ClamAV**, **DB migrations** (run on startup) — plus, in `deploy/docker-compose.yml`, a one-shot **`git-perms`** init job (chowns the git volume) and a dev-only **`proxy`** (Caddy sample), for **eight** compose services total. TLS terminated at the **org reverse proxy** (the bundled `proxy` is for dev). **Helm/K8s** are now **shipped** (chart at `deploy/helm/skilly`, §16 Tier 4), not deferred.

### Assumption to revisit
- **Outbound network assumed available** (Pointer proxying + ClamAV signature updates). **Air-gapped operation would change both** — revisit if required.

---

## 14. Non-functional requirements

- **Scale target:** ~low-thousands users, hundreds–low-thousands skills, tens of namespaces (Postgres FTS + single worker sufficient).
- **Availability:** single-instance v1, but **stateless app** (horizontal-scalable later); worker is **singleton, leader-locked**. HA not day-one.
- **Testing:** unit (domain, RBAC resolution, semver), integration (API + DB + **SCIM endpoint conformance against Entra payloads**), e2e (propose→review→publish→install happy path).
- **Observability:** structured JSON logs, `/healthz` + `/readyz`, Prometheus `/metrics`, request IDs threaded into audit. OpenTelemetry deferred.
- **UI:** WCAG 2.1 AA; English-only with externalized strings; evergreen browsers. **Visual identity
  follows the Scalefocus brand book** (2021): primaries Navy `#082773` (heading/display anchor) +
  Cyan `#14ABE3` (the single interactive accent), Black/Grey/Light-grey neutrals; semantic
  ok/warn/danger map to the brand's secondary Green `#05CC91` / Orange `#FFA652` / Red `#FF5961`;
  **Montserrat** (display) + **Open Sans** (body) via self-hosted `@fontsource-variable`, with
  **JetBrains Mono** kept as a deliberate technical extension for commands/metadata (the brand book
  defines no monospace). Both **light and dark themes** implement the same palette — dark uses the
  brand Black `#131313` base with navy-tinted surfaces and a contrast-lifted cyan. skilly carries its
  **own wordmark/mark** (lowercase Montserrat-bold navy wordmark whose terminal dot is a **cyan
  diamond**, echoed by the favicon's diamond-in-navy-tile) — deliberately NOT the Scalefocus eye
  logo, which stays reserved for Scalefocus corporate collateral (documents, decks).
  - **Social share card (Open Graph / Twitter).** A **single static, app-wide** card — `og:image`
    + `twitter:image` (`twitter:card = summary_large_image`), **1200×630** — surfaced on **every**
    route via the root-layout `metadata` (`openGraph` / `twitter`) plus Next's **`opengraph-image`
    file convention rendered with `ImageResponse`** (code-generated from brand tokens — **no binary
    committed**, stays in sync with the palette). Text renders in **`next/og`'s bundled default
    typeface (Geist)**: the vendored Montserrat ships only as **woff2**, which **Satori (behind
    `next/og`) cannot consume**, and vendoring a separate TTF was judged unnecessary weight for one
    card — the card's identity is carried by the **navy field + cyan diamond + layout**, not the
    typeface. Artwork = the skilly
    wordmark + mark (navy `#082773` field, cyan `#14ABE3` diamond) over the existing title/tagline
    (`skilly — agent skills registry` and the §14 description). **`metadataBase` derives from
    `PUBLIC_BASE_URL`** (an og:image URL must be absolute); **unset → the card degrades to a
    relative reference** (same graceful-degradation posture as the §12 email CTA) — no absolute
    social preview is emitted, nothing breaks. One card only: OG images are not theme-responsive, so
    the single navy treatment serves both light and dark. The generated image route (Next 16 serves
    it extension-less, e.g. `/opengraph-image?<hash>` / `/twitter-image?<hash>`) needs no auth and
    carries no per-skill data; whatever CSP the §22 middleware applies to it is inert for an image
    response.
  - **Deliberately NOT per-skill / dynamic (invariant #3).** Auth gating is **client-side** (§2), so
    the server returns **200 HTML for every route** and an unauthenticated unfurl crawler receives
    whatever `<head>` metadata is generated. A per-skill/dynamic card (`generateMetadata` on
    `/skills/[ns]/[slug]`) would stamp skill name/namespace/description into `og:*` and into the
    rendered image for **anyone**, leaking **restricted (`namespace`-visibility) skills** and
    creating an existence oracle — a direct **invariant #3** violation. The static app-wide card
    carries **no per-skill data**, so it is safe to serve unauthenticated. Per-skill social cards are
    **out of scope** and must not be re-introduced without an authenticated, visibility-filtered
    metadata path. **App/browser icons** (apple-touch, PWA manifest) are likewise **out of scope**
    here — the existing `icon.svg` favicon is unchanged.
- **Backup/DR:** documented Postgres + object-store backup/restore; skilly stateless beyond those.
- **Abuse/rate-limiting:** sensible defaults on proposal submission, token minting, search; size caps per §6. The **worker's** HTTP surfaces — the git smart server (§9), the SCIM provisioning target (§5), and the operational `/healthz` `/readyz` `/metrics` endpoints — are additionally rate-limited **app-wide** via `express-rate-limit` (see §22 *Rate limiting (worker HTTP surfaces)*).

---

## 15. API surface (indicative)

REST under `/api`, **session-authenticated** (Auth.js/Entra — there is **no PAT auth path**; PATs were removed with the install-token model, §9/§23). SCIM under `/scim/v2` on the worker. This inventory is indicative; the route handlers are the source of truth.

**Catalog & skills**
- `GET /api/skills` — search/list (visibility-filtered, faceted).
- `GET /api/skills/featured` — the **Featured skills** home-page feed (§7): visibility-filtered, **live-published only**, most-recent-featured first, **not** sliced to the cap; an empty result ⇒ the section is omitted.
- `GET /api/skills/:ns/:slug` — detail + versions + rating aggregate & caller's own rating (§18) + maintainer/watch flags + `latestInstallable`/`publishing` (§6) + `featured`/`canFeature` (§7).
- `GET /api/skills/:ns/:slug/readme` — rendered `SKILL.md`. `GET .../download?semver=` — governed, visibility-checked download: streams the **original uploaded bundle verbatim** with its original extension (§6/§10). It is **not** a git-clone install, but a user's **first** download of a skill **does** count toward `install_count` (and the monthly `install_counters`) — deduped per `(skill, user)` via `skill_downloads`, recorded once, and **never listed as an installation** on the Installed Skills page (§23).
- `POST /api/skills/:ns/:slug/install` — mint a **reusable** skill-scoped install command (interactive); body `{ semver?, expiresAt?, system? }` — `system: true` mints a **system installation** (§23), **platform-admin only, re-verified server-side**; **409** for a not-yet-`git_published` version (§6/§23). *(Endpoint is `install`, not `install-url`; tokens are reusable, not one-time.)*
- `PUT|DELETE /api/skills/:ns/:slug/rating` (§18). `GET|PUT|DELETE /api/skills/:ns/:slug/maintainers` + `GET .../maintainers/candidates?q=` (§19). `POST /api/skills/:ns/:slug/watch` (watch/follow).
- `GET /api/skills/:ns/:slug/usage-series?range=<7d|30d|90d|all>` — aggregate installs+views over time (visibility-gated; §21).
- `POST /api/skills/:ns/:slug/promote` — initiate promotion to global. `POST /api/skills/:ns/:slug/yank`, `.../archive`, `.../delete` (permanent; platform-admin, archived-only).
- `POST /api/skills/:ns/:slug/feature { featured }` — Featured spotlight toggle (platform-admin, re-verified; **409** at the `max_featured_skills` cap; rejected for a non-installable/archived skill), §7.

**Proposals & publishing**
- `POST /api/proposals` — submit (new skill or new version). `GET /api/proposals` — queue (scoped by reviewer authority). `GET /api/proposals/:id` — detail.
- `POST /api/proposals/:id/actions` — start-review / request-changes / accept / reject / resubmit / **revise** (proposer mid-review edit, no state change, §8) (the lifecycle verb; *not* `PATCH /api/proposals/:id`). **`accept` carries the inspected `revisionNo`** and returns **409** if a newer revision landed (revision-pinned accept, §8).
- `DELETE /api/proposals/:id` — permanently delete a proposal (reviewer of its namespace; any state except `accepted`). Housekeeping, silent, audited (`proposal.deleted`); cleans the review conversation + pointer scan + dangling notifications. §8.
- `GET /api/proposals/:id/files` (bundle browser, §8), `.../artifact`, `.../duplicate-check`, `GET|POST /api/proposals/:id/messages` (review discussion, §24).
- `POST /api/publish` — direct publish (Member when `require_review=false`, or admins). Hosted or pointer. *(No `/api/skills/:ns/:slug/versions`; no scripted/PAT publish.)*
- `POST /api/uploads` — hosted bundle upload (validate + scan + store, §6); an unparseable multipart body is a clear 400, not a 500 (§6). **Chunked variant** for bundles larger than the configured chunk size (§6): `POST /api/uploads/chunked` (start; sweeps ≥2h-old orphans, returns `{uploadId, chunkBytes}`), `PUT /api/uploads/chunked/:id/parts/:index` (raw octet-stream part), `POST /api/uploads/chunked/:id/complete` (assemble → identical validate/scan/store; same response shape as the single-shot upload), `DELETE /api/uploads/chunked/:id` (abort). `GET /api/pointer/refs` — upstream ref autocomplete. `GET /api/harnesses`, `GET /api/categories`.

**Consumption (git gateway — on the worker, NOT `/api/fetch`)**
- The authenticated **git smart server** serves `/<ns>/<slug>.git/{info/refs,git-upload-pack}` with token-in-URL basic auth; validates the token (including, for personal tokens, that the **owning user is `status='active'`** — §23 Gateway), enforces visibility, logs to `access_log` (never credentials), stamps install-token use. There is **no `/api/fetch`** route.

**Installs (§23)**
- `GET /api/installs` (+ `?scope=system` — all system installations, **platform-admin only**), `DELETE /api/installs/:id` (uninstall), `PATCH /api/installs/:id {expiresAt}` (reactivate) — owner-checked for personal rows; on **system** rows the DELETE/PATCH check is **platform admin** instead (any admin). *(Replaces the old `POST /api/tokens` PAT path.)*

**Messaging (§24)**
- `GET /api/messages` (list + unread), `GET|POST /api/messages/:id`, `POST /api/messages/:id/read`, `POST /api/messages/direct {userId}`.
- `GET|POST /api/skills/:ns/:slug/discussion` (lazy get-or-create; GET paginated newest-first, 100/page; POST `{body, contextSemver}`) and `DELETE /api/skills/:ns/:slug/discussion/:messageId` (moderator hard delete, audited `skill.discussion_message_deleted`) — the skill Discussion card, §24.

**Presence**
- `POST /api/presence/page {label}` — any authenticated user (401 if not); stamps `users.last_seen_page` (+ `last_seen`) via the throttled `touchLastSeen`, §4.

**Usage analytics (§21)**
- `GET /api/usage?days=<7|30|90|all>` — dashboard (entitled skills + windows + deltas + allowed aggregate + series). `GET /api/usage/:ns/:slug/breakdown?range=<7d|30d|90d|all>` — owner-only drill-down. *(Param is `range`, not `window`.)*

**Audit & system log**
- `GET /api/audit` (`q`, `from`, `to`, `action`, `namespaceId`, `limit`, `offset`; admin-only, §11). `GET /api/audit/verify` (hash-chain integrity), `POST /api/audit/trim` (platform-admin).
- `GET /api/system-log` (`q`, `status`, `from`, `to`, `limit`, `offset`; **platform-admin only**, §25).

**Administration**
- `GET/POST /api/admin/namespaces` (+ `:id`), `GET/POST /api/admin/role-mappings` (+ `:id`) — platform-admin.
- `GET /api/admin/users/online` (presence, §4), `GET /api/admin/users/search?q=`, `POST /api/admin/users/:id/erase` (GDPR, §4).
- `GET/PATCH /api/admin/settings` (platform settings: duplicate enforcement, max upload size, **upload chunk size** (`upload_chunk_bytes`, §6), date format, **install URL expiry horizon** (`install_max_ttl_months`), **Featured-skills cap** (`max_featured_skills`, §7), …).
- **Email channel (§12, all platform-admin):** `GET /api/admin/email` (status: connected account, token state, wrapper present), `GET /api/admin/email/connect` (starts the Entra authorization-code redirect), `GET /api/admin/email/callback` (completes it; stores account + encrypted tokens), `DELETE /api/admin/email` (disconnect), `PUT /api/admin/email/wrapper` (sanitize + validate `[SYSTEM MESSAGE]` + save), `POST /api/admin/email/test` (test send to the actor).

**Misc**
- `GET|PATCH /api/me` (profile prefs incl. `emailNotifications`, `driftNotifications`, `newVersionNotifications`, §12), `GET /api/stats`, `GET /api/leaderboard`, `GET /api/notifications` (+ read), `GET /api/nav-badges`, `POST /api/auth/clear-cookies` (sign-out, §5).
- `POST /api/csp-report` — CSP violation sink (§22): **unauthenticated** (browsers post without a session), rate-limited, body-size-capped; accepts `application/csp-report` + `application/reports+json`; structured-logs + increments `skilly_csp_reports_total`; **never** writes `audit_log` and never echoes credentials/query strings.
- `/scim/v2/Users`, `/scim/v2/Groups` (worker).

---

## 16. Phased build plan

**Phase 0 — Foundations & the critical dependency**
1. ~~Reverse-engineer & pin the external `npx skills add` fetch contract~~ **DONE** —
   consumer is `vercel-labs/skills`; skilly serves skills via an **authenticated HTTP git
   smart server**, versions = git tags, auth = token-in-URL (git basic auth). Pinned in
   `packages/shared/src/external-tool.ts`.
2. Monorepo scaffold (`web`, `worker`, `shared`, `deploy`), Postgres schema + migrations, docker-compose skeleton. **DONE.**

**Phase 1 — Identity**
3. OIDC SSO (Auth.js + Entra). Bootstrap admin group.
4. SCIM 2.0 endpoints in worker; users/groups/memberships sync; leaver deprovisioning. **DONE:** User/Group create/update/PATCH/delete, membership add/remove, deprovision (inactive + token revoke), **GET list with `eq` filter + startIndex/count pagination + GET /:id** (Entra-shaped ListResponse). Tested via supertest + a fake store.
4b. **Entra reconciliation sweep** (`worker/reconcile/`). **DONE:** Graph client (client-credentials, paged member fetch) + reconciler that pulls authoritative membership for **only the role_mapped groups (+ bootstrap group)** and converges local `group_memberships` (add/remove), upserting users; missing-upstream groups skipped (not wiped). Leader-only, runs when Graph creds set, configurable `RECONCILE_INTERVAL_MS` (default 15 min). Tested with a fake Graph + in-memory store. **Avatar back-fill:** SCIM carries no profile photo and a synced user may never sign in, so the sweep also fetches each still-avatar-less member's Graph profile photo (small data URI, capped) and fills `users.avatar` **only when null** (never clobbering a self-set sign-in photo); bounded per cycle (`RECONCILE_AVATAR_FETCH_PER_CYCLE`, default 100) so a large org converges over several cycles. Needs the app to have a user-photo read permission (`User.Read.All` / `ProfilePhoto.Read.All`).
5. Namespaces + `role_mappings` + RBAC resolution from synced groups.

**Phase 2 — Catalog core**
6. Skills + versions (Hosted): immutable artifact in object storage, semver validation, `latest` resolution, version→git-tag publishing. **DONE:** repo synthesis (`synth.ts`), publish sweep (`publish.ts`, object store → bundle extract → synth), `git_published` flag (migration 0003).
7. **Authenticated HTTP git smart server** (the gateway): serves per-skill repos with version tags; validates token-in-URL basic auth; enforces visibility; logs to `access_log` (never credentials). **DONE:** `git/server.ts` + `authorize.ts` + `httpBackend.ts`, install-token minting (`web/lib/installs.ts`) + install-command generation (`buildInstallCommand`). *(Originally one-time/PAT minting; superseded by the reusable install-token model, §23.)* Verified by a real HTTP `git clone` test. *(All former TODOs — pointer-skill mirroring, web upload UI, web search/catalog UI — are now **DONE**; see #13 and Phase 2/3 below.)*
8. Visibility-filtered search + taxonomy + facets. **DONE:** FTS search + `category`/`tool` filters (`web/lib/catalog.ts`), **visibility-filtered facet counts** (`listFacets`, surfaced as catalog facet chips), and **rendered SKILL.md** on the skill detail page (`web/lib/readme.ts` extracts the artifact; a dependency-free, XSS-safe `Markdown` component renders it).

**Phase 3 — Governance**
9. Proposal pipeline + state machine + admin review dashboard. **DONE:** pure state machine +
   actor permissions in `shared/proposal.ts` (tested); DB-backed proposal CRUD + materialize-on-accept
   (`web/lib/proposals.ts`), the review dashboard UI, and the lifecycle API routes
   (`/api/proposals`, `/api/proposals/:id/actions`) all shipped. See §8.
10. Scan pipeline (validation blocking; ClamAV + secret + heuristics advisory) + report surfacing + override logging. **DONE:** blocking validation (`shared/validate.ts`) + pure secret/heuristic scanners (`shared/scan.ts`) + **ClamAV clamd INSTREAM client** (`worker/scan/clamav.ts`, included when `CLAMAV_HOST` set); scanning runs at **ingest** (hosted upload `POST /api/uploads`; pointer mirror) writing artifact-keyed `scan_reports`; surfaced via `GET /api/proposals/[id]`. Reviewer override-on-publish is captured and audited (`proposal.scan_override`). **DONE.**
11. Audit log (governance) + access log; SIEM export. **DONE (viewer):** append-only capture (`web/lib/audit.ts`) + a **scoped audit-log viewer** (`/audit`, platform admin = all, namespace admin = own namespaces) with action filters. SIEM export still TODO.
12. Yank/archive; promotion-to-global. **DONE** (Tier 1).

**Phase 4 — Pointer skills & polish**
13. Pointer type: pinned refs, proxy-through, scan-on-fetch caching, "external" labeling. **DONE:** mirror-at-ingest (`worker/git/mirror.ts`) + "external" labels in the UI; a leader-only **pointer refresh** job (`worker/git/pointerRefresh.ts`) periodically re-clones the pinned ref, re-scans, writes `pointer_ref` scan reports, and **detects upstream drift** (content digest vs the stored artifact) — recorded in the audit log (`source = 'worker'`, migration 0007) without mutating the immutable version.
14. Notifications (in-app + SMTP + webhook channel). **DONE:** rows written on governance events; **in-app notification center** (`/notifications` + topbar bell + unread count) and a **leader-only delivery sweep** (`worker/notify/`) that fans each undelivered notification out over **SMTP** (nodemailer) and an **outbound webhook** (Teams/Slack), marking it delivered exactly once with retry/back-off. Channels are env-configured; in-app always works.
15. Observability, rate limiting, WCAG pass, docs, `.env.example`, backup/restore runbook. **DONE (core):** **Prometheus `/metrics`** on web + worker (dependency-free registry in `shared/metrics.ts`, optional `METRICS_TOKEN` bearer) instrumenting proposals/actions/tokens/searches/clones/publishes/mirrors/notifications/drift; **in-memory rate limiting** on propose / token-mint / install-mint / search (`web/lib/ratelimit.ts`); **CI** (GitHub Actions, `.github/workflows/ci.yml`); docs + `.env.example`. Remaining: distributed (Redis) rate limiting, full WCAG pass, backup/restore runbook.
16. ~~**Personal Access Token management** (`/tokens`)~~ **SUPERSEDED** — PATs and the CI-token UI were removed and replaced by the reusable, owner-revocable **install-token** model and the Installed Skills page (`/installed`, §23). `/tokens` now redirects to `/profile`.
17. **Install analytics:** `skills.install_count` is incremented from the authenticated git-fetch access log (`worker/git/pgDeps.logAccess`, once per clone) **and from each user's first detail-page download** (deduped per `(skill, user)` via `skill_downloads`; §10), and surfaced in the catalog. **DONE.**
18. **UI e2e (Playwright):** scaffolded in `packages/web/e2e/` (smoke specs + config), run opt-in against a live stack; the gated publish e2e now also covers a **.zip** hosted bundle and the **pointer-refresh** path. Broader journeys TODO.

**Tier 4 — strategic / infra**
19. **Helm / Kubernetes:** chart at `deploy/helm/skilly` — stateless web (Deployment + Service + **HPA**), leader-locked worker (Deployment + git PVC), migrations Job (pre-install/upgrade hook over a `skilly-migrations` ConfigMap), Ingress (routes `/scim` + `*.git` → worker, else web), Secret/values, and bundled Postgres/MinIO/ClamAV gated by `enabled` flags (point at managed services to disable). `helm lint` + both value sets render in CI. **DONE.**
20. **HA:** web is stateless (JWT sessions) and scales horizontally (HPA, 2–6 replicas); the worker is leader-locked (advisory lock) so replicas are safe (needs RWX git storage to scale >1). Rate limiting is per-instance (documented; a shared store is the next upgrade). **DONE (core).**
21. **Audit hash-chaining:** tamper-evident append-only log — each row's `entry_hash` covers its content + the previous hash (migration 0008, `audit_chain` trigger + `verify_audit_chain()`), surfaced via `GET /api/audit/verify` + a "Verify integrity" control. **DONE.**
22. **Watch / follow:** users watch a skill (`skill_watches`, migration 0009) and the publish sweep notifies watchers of new versions (`skill.new_version`). **DONE.**

**Phase 5 — Email notifications v2**
23. **Graph email service account + HTML wrapper + per-user opt-out (§12):** platform-admin-connected Entra service mailbox (delegated `Mail.Send` + `offline_access` on the existing app registration; AES-256-GCM-encrypted refresh-token storage under `EMAIL_TOKEN_ENC_KEY`; silent renewal), a WYSIWYG-authored `[SYSTEM MESSAGE]` HTML wrapper that gates the Graph transport, a per-user `users.email_notifications` toggle (default on) governing the email channel across both transports, a collapsed-by-default admin card (status pill / connect / disconnect / test send / wrapper editor), audited connect/disconnect/template events, and the `message.new` coalescing refresh made delivery-preserving (update-in-place, §12/§24). *(Spec'd 2026-07-07; not yet built.)*

**Phase 6 — Maintainer notification preferences**
24. **Per-type notification opt-outs + drift-onset dedup (§12):** two per-user Profile toggles (`users.drift_notifications`, `users.new_version_notifications`, both default ON — migration 0057) that filter the **implicit-maintainer** recipients at insert time in the worker (row-level: no in-app row, no email — unlike the channel-level `email_notifications`); an explicit `skill_watches` row always outranks the new-version opt-out; **no safety floor** (namespace admins may opt out too — audit rows, scan reports, and the skill page keep recording drift regardless); and the pointer-refresh job notifying `skill.drift` **only at drift onset** (most recent non-`unreachable` `pointer_ref` report not already `drift`) instead of on every ~daily pass. *(Spec'd 2026-07-17; not yet built.)*

**Explicitly deferred / out of scope (with rationale):**
- **Per-version visibility** — *not implemented by design*: it contradicts the pinned invariant "visibility is per-skill, no per-version visibility" (CLAUDE.md #7). Revisit only with an explicit spec change.
- **SAML** — identity is anchored on Entra **OIDC** (+ SCIM). A second federation protocol is a large auth surface with no current requirement.
- **OpenTelemetry tracing** — Prometheus `/metrics` covers v1 observability; OTel adds a heavy dependency tree. Deferred.
- **i18n / multi-language UI** — large cross-cutting change; English-only for v1.

---

## 17. Open risks & accepted trade-offs

1. **External-tool coupling** — consumption depends on `vercel-labs/skills`; contract pinned (git smart server, tags, token-in-URL basic auth) and isolated in `external-tool.ts`. If the tool changes its git/`.well-known` behavior, only that adapter + the git server change. Accepted.
2. **Token-in-URL** — now git HTTP basic-auth credentials in the clone URL; leaks into shell history/logs. Mitigated by single-use, scoped, short-TTL tokens and never logging credentials server-side.
8. **Git smart server is now a first-class component** — more build/ops surface than a plain HTTP endpoint (repo synthesis from artifacts, tag immutability enforcement, auth on the git transport). This replaced the originally-assumed HTTP proxy gateway after the contract was pinned.
3. **Hybrid trust** — Pointer skills depend on external origins remaining reachable and refs staying immutable. Mitigated by proxy-through + pinned refs + scan-on-fetch + "external" labeling.
4. **SCIM correctness** — Entra's SCIM quirks (PATCH, filtering) are the highest-effort/highest-risk piece; budget conformance testing.
5. **Air-gap assumption** — outbound network assumed at *runtime* for Pointer mirroring + ClamAV signature updates (build also fetches npm). UI **fonts are vendored** (self-hosted variable woff2 via `@fontsource-variable`, served from `/_next/static/media`) — no Google Fonts/CDN dependency at runtime. Revisit Pointer/ClamAV for fully air-gapped orgs.
6. **Promotion divergence** — global and team copies can drift; resolved by manual re-promotion + visible provenance.
7. **Audit vs PII erasure** — audit retains actor identity by default; switch to pseudonymization if GDPR erasure is mandated.

---

## 18. Skill ratings

A lightweight quality signal layered on top of the catalog. Designed v1 to be **minimal, abuse-resistant, and additive** — it never weakens the visibility invariant and never touches the audit log.

### Primitive
- **1–5 integer stars, scalar only.** No free-text reviews in v1 (a future `skill_reviews` table can layer on without reworking the scalar).

### Eligibility
- **Any authenticated user who can *see* the skill** may rate it. The rating endpoint runs the **identical visibility predicate** as search; a restricted skill returns the same `404 not found` it would in search — never a `403` (no leak, invariant #3).
- Self-ratings are allowed (no clean single-author concept to gate on; one self-vote washes out).

### Unit & mutability
- **Aggregate is per skill.** Each rating row is stamped with `rated_semver` (the version the rater was on) for provenance and as a future lever (e.g. decay or "current-major only") — it is **not** an aggregation key.
- **One rating per `(user_id, skill_id)`**, **editable** (upsert) and **revocable** (`DELETE`).
- Ratings are ordinary mutable rows. They live in `skill_ratings`, which the app role *may* UPDATE/DELETE — they are **never** written to `audit_log` (invariant #5). Normal user edits are not audited; a future *admin* moderation path would be.

### Aggregation, ranking & display
- **Denormalized** `rating_sum` + `rating_count` on `skills`, maintained by a `BEFORE/AFTER` trigger on `skill_ratings` that applies deltas on INSERT / UPDATE / DELETE. This keeps `searchSkills` a clean scalar read with no join fan-out.
- **Sort** uses a **Bayesian-smoothed** score `(rating_sum + C·m) / (rating_count + C)` where `m` = global mean rating and `C` ≈ 5 prior votes, so a single 5★ skill does not outrank a well-established 4.6★ one. Raw average (`sum/count`) is shown to users; the smoothed score drives ordering.
- **Default ranking** stays `install_count`-led with the smoothed rating as the **final tiebreaker**; a dedicated **"Top rated"** sort orders by the smoothed score directly.
- **UI (v1):** catalog card badge (`4.6 ★ · 23`), a detail-page **distribution histogram** + the caller's own clickable star control, and the "Top rated" sort. **No star facet-filter** yet (low value until there's volume).

### Moderation & notifications
- **No moderation surface in v1** — users manage only their own rating. Admin-delete is a deliberately deferred, *audited* code path. Non-anonymous SSO identity + scalar-only (no abusive free-text) removes most of the abuse vector.
- **No notifications** — ratings are silent, pull-only signal surfaced on the skill page.

### Lifecycle
- **Archived skills:** reject new ratings (not in the catalog); existing ratings retained, hidden with the skill.
- **Yanked versions:** ratings survive (the rating is about the skill; the version stamp is provenance only).
- **Pointer skills:** rated identically to hosted skills — no special-casing.
- **User deprovision / GDPR:** `ON DELETE CASCADE` removes the vote and the trigger recomputes the aggregate (ratings carry no provenance obligation, unlike audit).

### API
- `PUT /api/skills/:ns/:slug/rating` `{ stars: 1–5 }` — upsert; `DELETE` — revoke.
- The caller's own rating + the aggregate (`avg`, `count`, distribution) are folded into the existing `GET /api/skills/:ns/:slug` payload (mirrors the `watching` flag) — no separate read endpoint.
- `stars` must be an integer 1–5 (else `422`); skill is visibility-checked first; rate-limited via `enforceRateLimit("rating", userId, 60/min)`.

---

## 19. Skill maintainers

Per-skill **ownership + notification** layer. Designed to name accountable owners and route owner-relevant notifications **without** opening a second authorization path (invariant #1).

### Semantics & composition
- **No authority granted** — publish/approve/yank/archive stay entirely with SCIM groups + `role_mappings`. The lone capability a maintainer holds is curating the co-maintainer list (§4).
- **Effective maintainers = (namespace admins of the skill's namespace, resolved live from `role_mappings`) ∪ the explicit `skill_maintainers` user list.** Admins are always implicit owners (auto-updates with Entra group membership); the join table holds the extra named users. *Platform admins* can manage the list but are **not** implicit maintainers (they'd be auto-watchers of every skill).

### Identity, eligibility & management
- Explicit maintainers are picked from **SCIM-synced `users`** (typeahead on name/email) — the web tier stays Graph-free; "loaded through AD" is already satisfied via SCIM provisioning.
- **Eligibility gate (invariant #3):** a user may be added only if they can already *see* the skill (`isSkillVisible`). Org skills → any synced user; restricted skills → namespace members/admins (+ platform admins). "Can see it" == "can maintain it" — so adding a maintainer never exposes a restricted skill.
- **Who manages:** platform admins, the namespace's admins, and the skill's own **explicit maintainers** may **add and remove** maintainers — any of them can remove any *explicit* maintainer (not just themselves). Implicit namespace-admin entries are role-derived and can't be removed from the list (change the Entra group/role instead). Every add/remove is audited. *(This supersedes the earlier rule that limited a plain maintainer to self-removal.)*
- **At creation:** the proposal submitter is auto-added as a maintainer iff eligible; an ineligible cross-namespace proposer falls back to admin-only coverage.
- **At version acceptance (new versions of an already-existing skill, not just creation):** every accepted version of an existing skill — reviewed-proposal accept, direct publish (`require_review=false`), or a metadata-only *Keep current files* re-version (§8) alike, no distinction between them — auto-adds its submitter (`skill_versions.created_by`) as an explicit maintainer, under the **same eligibility gate as creation**: added iff they can currently see the skill (`isSkillVisible`), checked **at accept time** against the final namespace/visibility (so a reviewer's mid-review namespace/visibility edit is what's evaluated, not the submission-time state); an ineligible cross-namespace submitter is skipped, same admin-only-coverage fallback as creation. **No-op** if already an effective maintainer (explicit, or implicit via namespace-admin role) — no duplicate row, no duplicate audit entry. **Full parity** with any other explicit maintainer once added — the usual co-maintainer curation rights above, no cap on how many a skill accumulates over its lifetime, permanent until manually removed. **Global and unconditional**, not a per-namespace setting (unlike `require_review`). **Silent** — no dedicated notification (matches the creation-time rule); the new maintainer discovers their status via the skill detail page, **My Skills**, or the audit log. **Forward-only** — versions accepted before this shipped are not backfilled. **Audited** as a distinct action, `skill.maintainer_auto_added` (actor = the submitter), so it stays distinguishable from an admin's manual add/remove. **Out of scope: promotion to global** (§8) — it materializes an independent, brand-new skill, so it's already covered by the *At creation* rule above, not this one.

### Notifications, display & lifecycle
- Maintainers are **implicit watchers** of their skill: `skill.new_version` on publish (deduped vs explicit watchers) and `skill.drift` on detected pointer drift. Both are gated by the per-user **maintainer notification preferences** (§12) — suppressed at insert time for opted-out users, with an explicit `skill_watches` row always outranking the new-version opt-out — and drift pings fire **once per drift onset**, not per refresh pass (§12). No un-actionable review notifications.
- The skill detail page shows maintainers as `display_name` + `email` to **anyone who can see the skill** (not only admins/maintainers) — the list is read-only for viewers, who can **Reach out** (direct message) to a maintainer; only platform admins, namespace admins, and the skill's own maintainers see the add field and the remove (✕) control. Coexists with the namespace `maintainer_contact` (namespace scope vs skill scope). Maintainer names are **not** in FTS (§10).
- **Deprovision:** `ON DELETE CASCADE` (the implicit-admin half self-heals from live `role_mappings`).
- **Visibility downgrade (`org→namespace`):** the effective-maintainer resolver always re-filters through `isSkillVisible` (defense-in-depth, so a stale row can never leak); a future visibility-downgrade path must additionally prune now-ineligible explicit rows (audited). v1 has no downgrade path, so read-filtering fully covers it.

---

## 20. Usage example

- **Reuses the existing per-version `usage_examples`** field on `skill_versions` (already captured in proposal metadata; v1 only adds the missing UI). Per-version is intentional: triggering/options can change per release, so usage stays version-accurate and immutability (invariant #2) holds — a change is a new version.
- **Authored in the proposal**, frozen with the version. The detail page renders the **latest stable version's** usage as a **Markdown "Usage" quick-start block above the rendered `SKILL.md`** (curated how-to-trigger first, full spec below), via the existing XSS-safe renderer.
- **Indexed in FTS** at weight D (below title/description/tags), via the denormalized `skills.usage_search` column (migration 0020) — §10. (Earlier drafts left usage out of FTS; it is now included.)

---

## 21. Usage analytics dashboard

A simple, owner-facing dashboard of **view** and **install** tendencies per skill, plus a platform-wide aggregate for global admins.

### Data sources
- **Installs** = the git **clone**, recorded in `access_log` (`source='git'`, `skill_id`, `created_at`, `actor_user_id` — null for tokenless org clones). Every clone is logged (raw activity), but the **adoption** metric is de-duplicated: **`skills.install_count` counts each `(user, skill)` at most once — a user's FIRST install only, forever, version-agnostic** (so the popularity number can't be inflated by re-cloning; §21 "unique installs"). A user's first **download** counts the same way and shares the same ledger (`skill_installs`), so download-then-install counts once. Tokenless (null-`actor_user_id`, `is_system=false`) clones are activity-only — they never touch `install_count`. **System-installation clones** (§23; null actor + `is_system=true`) count in trends/`install_counters` like any clone, and each system installation increments `install_count` **once, at first clone** (`used_at` stamping — the per-token analogue of the per-user first-install rule); they never touch the per-user `skill_installs` ledger (no related-skills co-install signal) and **never write `install_credits`**. Time-series **trends** still come from the full `access_log` (every clone), and the monthly `install_counters` stays a per-clone activity total.
- **Views** = an authenticated load of `GET /api/skills/:ns/:slug`, newly logged into append-only `usage_events` **fire-and-forget after the visibility check** (never blocks/breaks the page; never logs a view of an unseen skill, so the table can't itself leak). Raw rows, no write-time dedupe; `actor_user_id` retained for the drill-down and future unique-counts.

### Metrics & periods
- Per skill, per metric: **24h / 7d / 30d / all-time** **raw** counts (no "unique" in v1 — tokenless org installs make unique-installers unreliable). Each rolling window carries a **trend delta vs the immediately-preceding equal window** (↑/↓ %; **"new"** when prior=0 & current>0; **"—"** when both 0). All-time has no delta.
- Computed **on-the-fly** with `date_trunc`/range filters over `(skill_id, created_at)` / `(namespace_id, created_at)` indexes. A `usage_daily` rollup + retention prune are the documented scale upgrades.

### Authorization (ownership matrix — subsumes invariant #3)
- **Platform admin** → every skill + the **platform-wide aggregate**.
- **Namespace admin** → skills in their administered namespaces + a **per-namespace aggregate**.
- **Maintainer (explicit, non-admin)** → only the skills they maintain, **no aggregate**.
- **Members / others** → no access.
- Entitlement is "can you govern/own it" (reusing §19), strictly narrower than "can see it", so a consumer can't read a skill's trends.

### Privacy & drill-down
- The dashboard shows **counts + trend only**. The **platform aggregate is counts-only** — no "top users by what they install" ranking here. (The separate **contributor leaderboard** below ranks maintainers by installs of skills they maintain, exposing aggregates only.)
- A **per-user drill-down** (top ~20 named viewers/installers for a window) is **on-demand per skill**, visible only to that skill's owners. Org installs surface an **"anonymous (tokenless)"** bucket since they have no actor; **system-installation clones** (§23) surface a separate **"System install"** bucket (told apart from the legacy tokenless rows by `access_log.is_system`). The breakdown endpoint re-checks ownership of that skill.
- **Display is truncated at 5 with an expand toggle, independently per list.** The Top installers and Top viewers lists each render only their first 5 people by default; if a list has more than 5, a **"Show more" / "Show less"** control appears at its bottom and expands/collapses that list alone (up to the full ~20 the breakdown endpoint already returned — no extra fetch). The other list's expand state is unaffected. Collapsing always drops back to the top 5 (already the sort order — highest count first). Purely client-side UI state (no new endpoint, no persistence across reopen).

### Graphs
- The dashboard is **graphical, not just numeric** — the number strips + trend deltas stay; charts complement them. Two levels:
  - **Aggregate time-series chart** in the top card: **views and installs per day** as two series, scoped exactly like the existing aggregate (platform-wide for global admins; the namespace aggregate for namespace admins; maintainers have no aggregate, hence no chart).
  - **Per-skill sparkline** on each skill row (installs/day, views as a faint second series) so a skill's tendency is visible at a glance without expanding the row. **Expanding a row** swaps the sparkline for a full chart bound to the **breakdown window** (24h hourly / 7d / 30d daily / all-time adaptive) — the SAME period as the top-viewers/installers lists below it, returned together by the breakdown endpoint so the chart and the lists never disagree.
- **Range & granularity:** a range picker — **7d / 30d / 90d / all-time, default 30d** — applied to the aggregate chart and the sparklines alike (one shared time axis). Fixed ranges bucket by day; **all-time** spans from the earliest event in the caller's scope and **steps the bucket up as the span grows** (day ≤ ~3mo, week ≤ ~2y, else month) so the point count stays bounded (same approach as the per-skill detail chart). 24h remains **number-only** (hourly buckets aren't worth their cost in a governance dashboard).
- **Rendering:** **recharts** (SVG, declarative React) — an accepted client dependency, installed from npm at build time, so the §17 air-gap posture (no CDN/runtime fetches) is preserved.
- **Data shape:** no new endpoint or table — `GET /api/usage?days=<7|30|90|all>` grows a `series` field: per-bucket `{ date, views, installs }` on the aggregate plus a compact per-skill `daily` array for sparklines, computed by grouped `date_trunc(<bucket>)` queries over the same indexes (the bucket is a trusted literal), with the same server-side entitlement filtering as the rest of the dashboard.

### Listing & surface
- Lists entitled skills, default sort **30d installs desc**, sortable, **capped at ~100** (pagination/search deferred). **Active skills only** in v1 (archived behind a future toggle).
- New `/usage` page, nav-gated to entitled users; `GET /api/usage` (list + aggregate) and `GET /api/usage/:ns/:slug/breakdown?range=<7d|30d|90d|all>` (drill-down; the query param is `range`). Both resolve entitlement server-side.
- **Skill-detail trend chart:** the skill detail page shows an **installs + views time-series chart** directly under the created/last-updated line, with a **7d / 30d / 90d / all-time** range toggle (default 30d). **Visible to anyone who can open the skill** — it follows the detail page's own access rules (an active skill needs only visibility per #3; an archived skill is owner-only per §7). This is **aggregate counts over time only** — install totals are already public on catalog cards, and per-day view totals carry no PII; the **named viewer/installer breakdown stays owner-only** on the `/usage` dashboard. Served by `GET /api/skills/:ns/:slug/usage-series?range=`. Unlike the dashboard's number-only all-time rule, this chart **does** offer all-time by stepping the bucket up as the span grows (**day ≤ ~3mo, week ≤ ~2y, month beyond**), keeping the point count bounded.

### Contributor leaderboard

A separate `/leaderboard` surface (distinct from the usage dashboard's counts-only platform aggregate above) that recognizes the people who **maintain** widely-installed skills. Served by `GET /api/leaderboard`, computed in `lib/leaderboard.ts`.

- **Attribution = current explicit maintainers, point-in-time, once per adopter.** A user's **first** install of a skill (a git clone or first download) is credited to **each explicit maintainer (`skill_maintainers`) of the skill at that moment, EXCEPT the installer themselves** — so re-installing never re-credits, and a maintainer earns **no self-credit** for installing a skill they maintain (a solo maintainer installing their own skill earns nothing). Namespace admins' *implicit* maintainership earns **nothing** (they must add themselves to the explicit list). One first-install with three (other) maintainers produces **+1 for each of the three** (equal credit, not split). A skill with no eligible explicit maintainers at that moment credits **no one** (forfeited, never reassigned). **System-installation clones credit no one, ever** (§23) — no user means no `skill_installs` first-install gate and no `install_credits` row, so a CI job cloning on a schedule can never manufacture leaderboard standing.
- **Snapshot model (`install_credits`).** Attribution is frozen at first-install time into `install_credits (access_log_id, user_id)` — written **inside `record_git_access()` / `record_skill_download()`** only on the user's first install (gated by the shared `skill_installs` ledger). Because credit is captured when the adoption happens, **changing a skill's maintainers never moves existing credit**: removal stops only *future* credit; additions earn only *future* first-installs. This is the mechanism behind "new installs follow the current maintainers; old installs stay put."
- **Backfill.** Installs that predate `install_credits` are seeded **once** (in the creating migration) to the skill's **original proposer(s)** — the prior attribution model — excluding already-erased users (`erased_at IS NULL`). This keeps the board continuous across the cutover and faithful to point-in-time (the proposer was, by default, the sole maintainer then). After the backfill the old proposer-based query is retired.
- **Metrics.** Both displayed numbers derive from `install_credits` (so they are always mutually consistent): `installs` = count of the user's credit rows in the window; `skillCount` = distinct skills among them — displayed as **"skills adopted"**, deliberately not "skills proposed": a skill this user proposed/maintains with zero credited installs in the window (too new, or only ever self-installed) contributes zero, even though they proposed or maintain it. That's intentional — the metric stays adoption-weighted for the anti-gaming reasons above — but the label must say what the number actually measures, so it never reads as "skills submitted/published by this user." Windows are **all-time** and **30d** (by the install's `access_log.created_at`). Because each install fans out to every maintainer, the board's summed installs **exceed** the real clone count — the number is "installs credited to you", not a global clone total.
- **Erasure removes credit — unless transferred.** GDPR erasure (§4, both the admin and SCIM paths) **deletes the erased user's `install_credits`** — credits-only: the shared `access_log` row, `skills.install_count`, and co-maintainers' credit are untouched (the install still happened and still counts for everyone else). **Exception:** the admin erasure path with a "Replace maintainer to" target **reassigns** the credits to that target instead of deleting them (§4 — would-be self-credits and duplicates excepted; those are deleted as usual), so the standing survives on the board under the successor. Either way, a deleted user holds zero credits and never appears. A reversible **deprovision** (leaver → `status='inactive'`) does **not** delete credits — the board's `status='active'` filter hides them, and re-enabling restores their standing.
- **Privacy (invariant #3).** The board exposes only per-person aggregates (display name, avatar, total installs, skill count) — **never skill identities, slugs, or namespaces** — so it cannot enumerate or identify restricted skills, and is identical for every viewer. Users may opt out via `leaderboard_hidden` (§13).
- **Display cap (top 100).** The board shows at most the **top 100** eligible contributors for the selected metric+window. 100 is a **fixed platform constant** (`LEADERBOARD_LIMIT`), **not** a caller-supplied value — neither `GET /api/leaderboard` nor the page can request more (or fewer). The cutoff is deterministic: `ORDER BY` ranks by the selected metric descending, then the other three metrics descending, then `display_name` ascending, so exactly which ≤100 rows appear is stable across requests (a tie straddling rank 100 is broken by that same deterministic order). Contributors ranked 101+ simply don't appear; the board publishes no total-contributor count, so nothing signals that truncation happened (consistent with the aggregate-only privacy stance above). **Leader badges** (§21 extension) are unaffected — a badge marks whoever is tied for the single highest value of a metric, always the leading rows of the list and far inside the top 100, and the badge computation reads the same already-cached per-(window,sort) results.
- **Row actions.** Each row offers two actions: **Skills** and **Reach out**.
  - **Skills** links to the catalog scoped to the skills that person **maintains** — `/catalog?maintainer=<userId>&by=<name>` for another person (the catalog shows a dismissible "Skills maintained by &lt;name&gt;" banner), or `/catalog?mine=1` for **your own** row (reuses the "My Skills" filter). This does **not** break invariant #3: the catalog independently visibility-filters to what the *viewer* may see (`searchSkills`), so it only ever lists skills the viewer could already browse — the leaderboard itself still reveals no skill identities. On arrival the maintainer view **ignores the viewer's other saved filters** (category/tool/type/My-Skills) and shows everything by that maintainer the viewer can see.
  - **Reach out** opens a 1:1 direct chat (`POST /api/messages/direct` → `skilly:open-conversation`), the same mechanism as the skill-detail maintainer list and the admin online-users list. It is **hidden on the viewer's own row** (you can't message yourself).

### Leader badges

A small marker under a user's avatar bubble — **everywhere one appears** — showing they currently
top a leaderboard metric. Purely derived from the leaderboard's own data; no new user action.

- **Four metrics, matching the leaderboard's own sort options** — Installs leader, Adoption
  leader (skills adopted), Fulfillment leader (requests fulfilled), Watch leader (skills watched)
  — each in **two windows**, all-time and last-30-days, for up to 8 badges per user.
- **Who's a leader:** whoever is **tied for the single highest value** of a metric in a window. A
  tie is a tie — everyone at the top value gets the badge, not just one canonical winner. A metric
  with nobody above zero in that window has **no leader** (nobody gets it). Computed in
  `lib/leaders.ts` by reusing the leaderboard's own already-cached per-(window,sort) query results
  (each sort orders by its metric first, so the tied-for-first rows are exactly the contiguous
  prefix matching the top row's value) — no new SQL, no new heavy aggregate.
- **Visual:** each badge is a small colored circle with a glyph, sized proportionally to the avatar
  it sits under (floored so it stays legible on the smallest bubbles): 📥 installs (accent), 📝
  adoption (accent-2), 🎁 fulfillment (ok/green), 👁 watched (warn/orange). The **all-time**
  variant is the identical icon with a small crown overlaid on top; the **30-day** variant has no
  crown. **Every badge a user currently holds renders** (no cap, wrapping if needed) — most users
  have zero; a dominant contributor may show several.
- **Placement:** directly **below** the avatar bubble, never beside it — the bubble+badges stack is
  one visual unit. Tooltip/aria-label on each badge: `"<Metric> leader — all time"` or
  `"<Metric> leader — last 30 days"`.
- **Everywhere an avatar renders.** All user-avatar rendering across the app was consolidated onto
  the single shared `UserBubble` component (previously duplicated independently in chat message
  bubbles, the messages-menu peer avatar, the leaderboard's own rows, the proposal submitter card,
  the profile page, and the topbar account menu) specifically so a badge added once shows up
  everywhere, permanently — including the two spots that didn't carry a user id in their payload
  before this (chat messages gained `authorId`; the messages-menu peer avatar gained `peerUserId`).
- **Data:** `GET /api/leaders` returns `{ [userId]: [{ metric, window }] }` for every current
  leader — same audience as the leaderboard itself (any signed-in user), no more information than
  it already exposes publicly. `UserBubble` takes an optional `userId` prop and looks itself up in
  this map (via the shared client-side GET cache, so every bubble on a page dedupes onto one
  request); omitting `userId` renders the bubble with no badges and no extra request, unchanged
  from before this feature. The map itself is cached for ~30s server-side, layered on top of the
  leaderboard's own 60s per-(window,sort) cache.

---

## 22. Security hardening

A dedicated **`SECURITY.md`** records the security model, the June 2026 audit, and operator
responsibilities. Hardening that pins or clarifies invariants here:

- **SSRF boundary** (§6 pointer ingest): pointer URLs are https-only to a public host; the
  validator rejects IP literals in all encodings **including IPv4-mapped IPv6 and trailing-dot
  hosts**, and the worker additionally **resolves the host and rejects any private/loopback/
  link-local address** and disables HTTP redirects (DNS-rebinding defense). `ext::` is never an
  allowed git transport, even under `SKILLY_MIRROR_ALLOW_INSECURE`.
- **Version immutability** (invariant #2): the DB guard (`skill_versions_guard()`) blocks DELETE
  (except inside an explicit, audited permanent-delete transaction, §7) and pins the **full**
  immutable content set on UPDATE — `semver`, `skill_id`, `artifact_sha256`, `artifact_object_key`,
  `artifact_filename`, `external_ref`, `external_origin_url`, `external_subdir`, `is_prerelease`; only `status`
  (yank/restore) and `git_published` may change post-insert. (Migration 0017 introduced the full
  set; 0022 added the delete carve-out but regressed the UPDATE checks to a subset; migration
  **0039** restores the full set inside the delete-aware guard; **0040** adds `artifact_filename` to the pinned set.)
- **Install tokens** (invariant #6 carve-out, §23): they are random + **skill-scoped** +
  **reusable** (no single-use grace) + **user-TTL'd** (explicit dates within the admin-configured horizon — `install_max_ttl_months`, default 12 — or an explicit "Never")
  + **not deleted on use/expiry**; the gateway **rejects a token presented against a different
  skill** than it was minted for, and **rejects a personal token whose owning user is not
  `status = 'active'`** (deprovisioned/disabled users can't clone with pre-minted URLs — §5
  Leaver handling, §23 Gateway). Revocation is via uninstall (owner hard-delete) or a passing TTL
  (inactive). **System installations** (§23) relax two further terms — no owning user
  (platform-admin-managed, provenance via `created_by_user_id`) and **no clone-time
  visibility/namespace re-check** (a deliberate admin grant) — compensated by admin-only minting
  and mandatory audit of mint/uninstall/reactivate. The original
  single-use/short-TTL/delete-on-use rule still governs any residual
  legacy `one_time`/`pat` rows.
- **Email service-account tokens** (§12): the delegated Graph refresh/access tokens are stored
  only AES-256-GCM-encrypted under the env-provided `EMAIL_TOKEN_ENC_KEY`, are never written to
  logs or audit payloads (invariant #6's "never log credentials" extends to them), and are
  hard-deleted on disconnect. The connect callback is guarded by the initiating platform-admin's
  session (state-bound), and the flow grants no skilly session or role (invariant #1, §5).
- **Decompression limits**: archive extraction caps cumulative *actual* (not declared) bytes +
  entry count on both the upload and the publish/mirror paths.
- **Rate limiting (worker HTTP surfaces)**: every worker HTTP endpoint — the git smart server
  (§9), the SCIM provisioning target (§5), and the operational `/healthz` `/readyz` `/metrics`
  endpoints — is fronted by a single **`express-rate-limit`** middleware mounted **app-wide** in
  `buildServer()` (`worker/src/index.ts`), immediately after the baseline security-headers
  middleware and **before** the git handler and any body parser. Mounting it there is safe because
  the limiter only reads `req.ip`/headers and never touches the raw request stream the git backend
  consumes (the same reason the security-headers middleware precedes the git handler). This closes
  CodeQL `js/missing-rate-limiting` (CWE-307/400/770) on **all three** worker surfaces: the
  authorization-bearing handlers (SCIM bearer auth, git token-in-URL basic auth) and the DB-touching
  handlers no longer accept unbounded request volume. Configuration:
  - **Keyed by client IP**, honoring the already-configured `trust proxy` (§ worker `buildServer`)
    so the real client is counted behind the edge proxy rather than the proxy itself.
  - **Limits match the `express-rate-limit` example: `windowMs: 15 * 60 * 1000` (15 min), `max: 100`
    requests per window per IP.**
  - Standard `RateLimit-*` + `Retry-After` response headers; **`429`** when exceeded.
  - **Health/ops endpoints are NOT exempt** — `/healthz`, `/readyz`, and `/metrics` are covered by
    the same app-wide limit (a deliberate choice; operators whose probe/scrape cadence approaches
    100 requests / 15 min per source IP must widen the limit or place probes on an unthrottled path).
  This is the worker analogue of the web app's in-memory limiter (`web/lib/ratelimit.ts`, §14/§15);
  both remain **per-instance** — the HA note (§14, build-plan #20) applies, and a shared store is the
  next upgrade.
- **SCIM filter parsing (ReDoS hardening)**: `parseScimFilter` (`worker/src/scim/filter.ts`) parses
  the single `eq` filter grammar Entra issues (`<attr> eq "<value>"` or bare `<attr> eq <value>`)
  against the `filter` query string on `GET /scim/v2/Users` and `GET /scim/v2/Groups` (§5) —
  bearer-token-gated but the token is a shared provisioning secret, not per-user, and the string is
  otherwise unbounded and attacker-shaped. The original regex's independently-optional leading/
  trailing quote markers around a whitespace-permissive capture created three quantifiers (`\s+`,
  the capture, and the trailing `\s*$`) that could all match the same run of whitespace, giving
  **O(n²)** catastrophic-backtracking behavior on crafted input (confirmed empirically: a ~16KB
  crafted filter string blocks the regex engine for over a minute) — CodeQL `js/polynomial-redos`
  (CWE-1333/400/730), high severity. Because the worker is a **singleton, leader-locked,
  single-threaded** process (§2), one such request stalls SCIM reconciliation, the git gateway, and
  health checks simultaneously. Fix:
  - **Regex rewritten to remove the overlap**: the quoted-value and bare-value cases become disjoint
    alternatives (`"([^"]*)"` vs `\S+`) instead of independently-optional quote markers around a
    whitespace-inclusive capture, so there is exactly one way to match any given input — no
    backtracking ambiguity, linear-time parsing.
  - **Length cap on the incoming filter, as defense in depth**: `parseScimFilter` rejects (returns
    `null` — i.e. "no filter applied", the same outcome an unparseable filter already produces
    today) any `filter` string over **200 characters** before it ever reaches the regex. Entra's
    real `eq` filters (one attribute + operator + one value) are always far shorter; 200 characters
    comfortably covers any legitimate value while foreclosing the input length an attacker would
    need even against the now-linear regex.
  - No change to the supported filter grammar or to legitimate Entra provisioning traffic — this is
    parser hardening only, closing code-scanning alert
    [#10](https://github.com/scalefocus/skilly/security/code-scanning/10).
- **Transport/headers**: a **nonce-based, per-request CSP** on document responses (`frame-ancestors
  'none'`, `object-src 'none'`, `base-uri 'self'`, `default-src 'self'`), plus `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy: no-referrer`, HSTS, and `Cache-Control: no-store` on `/api/*`. The
  **worker** (SCIM + git gateway) sets the same baseline `nosniff` / `X-Frame-Options: DENY` /
  `Referrer-Policy: no-referrer` on every response so no protocol/JSON response can be MIME-sniffed
  into active content or framed (the sample Caddyfile mirrors these with replace-semantics for
  operators whose edge is the enforcement point; production edge enforcement remains an operator
  responsibility — `SECURITY.md`). `/metrics` fails closed in production. Policy modes, the nonce
  mechanism, and violation reporting: **§22 *Content-Security-Policy*** below.
- **Deploy**: non-root containers, dropped capabilities, frozen-lockfile builds, and a Helm
  chart that refuses placeholder secrets. See `SECURITY.md` for operator must-dos (scoped
  object-store creds, egress pinning, TLS termination).

### Content-Security-Policy (nonce-based)

The script-execution policy is **nonce-based**, so a stray inline-script injection can't run — the
`'unsafe-inline'` script fallback that the original audit policy carried is dropped. This is the one
substantive tightening over the June-2026 audit CSP; the other directives are unchanged.

- **Nonce per request.** `packages/web/src/middleware.ts` generates a fresh cryptographically-random
  nonce per request (Web Crypto), exposes it to the render via an `x-nonce` request header, and emits
  the CSP response header. The root layout reads `x-nonce` and sets it on the inline **theme-bootstrap**
  `<script nonce>` (§2, no-flash theme); Next.js applies the same nonce to its own framework/hydration
  inline scripts. Production `script-src` is **`'nonce-<value>' 'strict-dynamic' 'self'`** — the nonce
  authorizes the bootstrap, `'strict-dynamic'` propagates trust to the chunks it loads (CSP3), and
  `'self'` is the CSP2 fallback for browsers that ignore `'strict-dynamic'`. CSP moves **out of**
  `next.config` `headers()` (static — can't carry a per-request nonce) into the middleware; the static
  headers (`X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS, `/api` `no-store`) stay in
  `next.config`. Exactly one CSP header is emitted per response.
- **Unchanged directives:** `style-src 'self' 'unsafe-inline'` stays (React/recharts inline styles;
  style injection is low-risk and can't be nonced without breaking them), as do `img-src 'self' data:`
  (data-URI avatars, §5/§19), `connect-src 'self'`, `font-src 'self'` (self-hosted fonts), `object-src
  'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `form-action 'self'`.
- **`CSP_MODE` env toggle** (§13; default **`enforce`**): `enforce` sends `Content-Security-Policy`;
  `report-only` sends the identical policy as `Content-Security-Policy-Report-Only` (nothing blocked —
  a shakedown mode so an operator can validate their own edge proxy / customizations before committing);
  `off` falls back to the **legacy** policy (`script-src 'self' 'unsafe-inline'`, no nonce/middleware
  path) as an escape hatch. The default ships the hardened posture out of the box.
- **Development** always uses the legacy lenient policy (`script-src 'self' 'unsafe-inline'
  'unsafe-eval'`, no nonce) regardless of `CSP_MODE`, because `next dev` serves eval-wrapped chunks
  (without `'unsafe-eval'` React never hydrates); the nonce path is **production-only**. `/api/*`
  responses (which execute nothing) get a resource-free `default-src 'none'` CSP in every mode.
- **Violation reporting.** The policy carries a `report-to` group (and legacy `report-uri`) pointing at
  **`POST /api/csp-report`** (§15) — a self-hosted, **unauthenticated** (browsers post without a
  session), **rate-limited**, body-size-capped sink that accepts `application/csp-report` +
  `application/reports+json`, emits a **structured JSON log line** and increments a Prometheus counter
  (`skilly_csp_reports_total`), and **never** writes `audit_log` (operational telemetry, not
  security provenance) nor echoes credentials/query strings (invariant #6). Required for a meaningful
  `report-only` rollout; still useful under `enforce` to catch field breakage.
- **Trade-off (accepted):** the middleware runs on every matched request and pages that read the nonce
  render dynamically (no full static optimization) — negligible here, since the catalog is auth-gated
  and already renders dynamically per-user.

---

## 23. Installations & the Installed Skills page

An **installation** is a single `install` token (one table; the token IS the installation).
Generating an install command on a skill's detail page mints one; using it (the first git
clone) turns it into a recorded installation the user can see, expire, reactivate, or uninstall.

### Install token model
- **Type `install`** on `tokens` (the `pat`/`one_time` enum values are retired; PATs and the
  CI-token UI are removed). Columns: `skill_id` (cascade FK), `pinned_semver` (`null` = latest),
  `expires_at` (`null` = never), `used_at` (`null` until first clone), `client_user_agent`,
  `client_ip` (the originating client IP captured on first clone; `null` if unknown/unresolved),
  `is_system` (**system installation** flag — see below; `user_id` is NULL iff set, enforced by a
  CHECK), `created_by_user_id` (nullable FK → `users`, `ON DELETE SET NULL` — provenance: the
  platform admin who minted a system install; NULL on personal installs).
- **Reusable**, skill-scoped, owner-revocable. **Every** clone (org *and* namespace) must
  present a valid install token — anonymous org clones are removed. Namespace skills
  additionally require the token's user to have namespace access at clone time
  (**system installations excepted** — see *System installations* below).
- **Latest vs pinned:** "latest" → URL omits `#ref` (serves `main`); pinned → `#v<semver>`
  (any active version, stable or beta; yanked excluded).
- **TTL:** an absolute `expires_at` = end of the user-selected day in the user's timezone,
  re-validated server-side; explicit dates are capped at the **platform-configured horizon**
  — a global-admin setting `install_max_ttl_months` (Administration → Install URL expiry), a
  positive integer **1–120 months, default 12**, interpreted as **calendar months** (`now +
  N months`, clamped for short months). The cap governs **both** minting and extending/
  reactivating an install, is **forward-only** (lowering it never retroactively shortens
  already-minted tokens — they live out their set expiry), and is surfaced to the picker via
  `/api/me` (UX bound; the endpoints re-validate authoritatively). **Never** = `null`,
  unbounded (this cap governs dated expiries only). *(Replaces the former
  `INSTALL_MAX_TTL_DAYS` env var.)*

### Derived state (never stored)
- *generated-unused* `used_at IS NULL` · *active* `used_at NOT NULL AND (expires_at IS NULL OR
  expires_at > now())` · *inactive* used but `expires_at <= now()` · *uninstalled* = row deleted.

### Lifecycle
- **Generate** → mints a new unused token, and in the same step **deletes the user's prior
  *unclaimed* (`used_at IS NULL`) install tokens for that skill** — re-generating (changed
  version/expiry, or just re-clicking Install) supersedes any earlier command that was never
  claimed by `npx skills`, so unused valid tokens don't pile up. Claimed installs survive.
  **Purge scopes never cross the system boundary:** a personal mint purges only the minting
  user's unclaimed personal tokens; a **system** mint purges prior unclaimed **system** tokens
  for that skill (across all admins — the last generated system command is the live one) and
  never touches anyone's personal tokens, and vice versa.
- **UI staleness:** on the detail page, changing the selected version or the expiry
  (Never ⇄ a date, or picking a date) — **or toggling the "System install" checkbox** —
  **hides the previously generated command and its caption**
  (e.g. *"pinned v1.0.0 · never expires · …"*) until the user clicks Install again — the shown
  command was minted for the old selection and no longer matches.
- **Version picker (split-button):** the Install control is a split button — the primary face
  mints for the current selection (*"Install latest"* / *"Install v‹x›"*) and the ▾ caret opens a
  dropdown listing **latest** plus each active, git-published version. The dropdown **dismisses on
  an outside click (anywhere off the menu and its ▾ toggle) and on Escape**, in addition to closing
  when a version is picked or the caret is re-clicked — matching the app's other dismissible menus
  (search autocomplete, emoji/harness pickers). The Pointer download split-button (§6/§10) behaves
  identically.
- **First clone (install):** the gateway stamps `used_at`, captures the `User-Agent` **and the
  originating client IP** (`client_ip`), and — in the same transaction — **deletes the user's
  other *unused* install tokens for that same skill** (per-skill purge; used ones always survive;
  for a **system** token the purge deletes the other unused **system** tokens for that skill,
  same boundary rule as Generate). Subsequent clones don't re-stamp/re-purge, so the IP reflects
  **where the install was first made from**, not the latest fetch.
- **Expiry → inactive:** install tokens are **exempt from the expiry sweep**; the gateway
  simply refuses an expired token (`expires_at > now()`), so it's listed-but-refused.
- **Reactivate** (inactive only): set a new `expires_at` (date or Never) on the **same** token
  — the existing URL works again; no new token is minted.
- **Uninstall:** **hard-delete** the token → the URL is refused. The skill is untouched and
  **install counts / usage / leaderboard history are preserved** (an uninstall is not a
  retro-erasure of past clones).

### Gateway
- `validateToken` accepts only `type='install'`, valid while `expires_at` is null-or-future, the
  row exists, **and — for personal tokens (`user_id` set) — the owning user is `status = 'active'`**
  (one query; the users join rides the token lookup). **No one-time-use grace** — reuse is
  intentional. Per-clone analytics (`access_log`, `install_count`, `install_counters`) are unchanged.
- **Owner-status refusals are client-indistinguishable:** a token whose owner is inactive gets the
  **same 401 "invalid or expired token"** as a deleted/expired token — the response never reveals
  that the account was disabled (no account-state oracle for whoever holds a leaked URL).
  Internally the gateway *does* distinguish the case and records a **`system_event`** row
  (§25): `source='worker'`, `status=401`, `error_code='install_token_owner_inactive'`,
  `method`/`route` (the matched git endpoint template) / `path` (concrete, never the query string),
  `user_id` + actor snapshot = the **token owner** (the forensic subject — the requester is an
  anonymous machine), and a short message naming `@ns/slug`. One event per refused request, no
  dedup (high-volume, trimmable telemetry per §25); fire-and-forget, a logging failure never
  changes the response. This is a deliberate **carve-out from §25's "401 is excluded" rule** and
  the first `source='worker'` event.
- **System installations are exempt** from the owner-status gate — `user_id` is NULL, there is no
  owner to check, and `created_by_user_id` going inactive (or being erased) never invalidates the
  token: it is provenance only, no authority attaches (§23 System installations). Revocation of a
  system install remains explicit (any platform admin, one click).
- **Client IP** is the originating client address (the consumer running `npx skills add`), not the
  reverse proxy in front of the git server. The worker Express app sets `trust proxy` from the
  **`TRUST_PROXY`** env var (number of hops, `true`/`false`, a preset like `loopback`, or a
  comma-separated subnet list — passed through to Express verbatim) so `req.ip` resolves from
  `X-Forwarded-For`. **Default unset = don't trust**, so behind a proxy the IP records `null`
  rather than the proxy's address until `TRUST_PROXY` is configured. IPv4-mapped IPv6 (`::ffff:`)
  is normalized to the bare IPv4. The IP is **never** logged with the request and only the
  resolved address is persisted on the token (never credentials/query strings — invariant #6).

### Installed Skills page (`/installed`)
- Reached from the bottom-left account menu, **above Profile**; **owner-scoped** (personal view;
  platform admins additionally get the **System installs** view below).
- Lists the user's **used** installs (one row each — a user may have several for one skill):
  skill (`@ns/slug` + title), `latest`/pinned version, installed-at (`used_at`), expiry (date
  or "Never"), client label (from `User-Agent`), **the client IP the install was made from**
  (`client_ip`, shown when known), and active/inactive. The IP is **owner-scoped** (visible only
  on the user's own Installed page), not surfaced to admins — **except on system-install rows**
  (see below). Rows are ordered **alphabetically by
  skill title** (case-insensitive, ascending; ties broken by most-recent `used_at`).
- Edge actions (styled like the detail-page version buttons): **Uninstall** always; **Activate**
  (date/Never picker) only when inactive. `GET /api/installs`, `DELETE /api/installs/[id]`,
  `PATCH /api/installs/[id] {expiresAt}` — owner-checked for personal rows; on **system** rows
  the check is **platform admin** instead (any admin, not just the minter).
- **System installs view (platform admins only):** a **"Mine / System installs" toggle filter**
  at the top of the page, **default Mine** (the personal view above, unchanged; non-admins never
  see the toggle). The **System installs** view lists all **used** system installations
  platform-wide, same columns plus: a **"System install" pill** on each row, **minted-by** (the
  `created_by_user_id` label — renders the tombstone name if that admin was since erased), and
  the **client IP** (a deliberate exception to the owner-only-IP rule: it is the only forensic
  handle a system install has, and every viewer here is a platform admin). Uninstall / Activate
  edge actions work identically for any platform admin. Served by `GET /api/installs?scope=system`
  (403 for non-admins).

### System installations (platform-admin)
An install token owned by the **platform, not a person** — for CI pipelines and other org tools
that consume skills and are persisted in skilly. This is the **sanctioned replacement for the
removed CI/PAT path** (§9), deliberately admin-gated: it is still a single `install` token —
skill-scoped, reusable, TTL'd, hard-deletable — with the *user* dimension removed and audit added.

- **Minting:** the skill-detail install form gains a **"System install" checkbox** (next to the
  version dropdown), rendered **only for platform admins**. `POST /api/skills/:ns/:slug/install`
  takes `system: true` and **re-verifies platform admin server-side** (SCIM-resolved roles,
  invariant #1 — hiding the checkbox is not authorization). Toggling the checkbox is a staleness
  event like changing version/expiry (the previously generated command hides).
- **Ownership:** `user_id = NULL`, `is_system = true` (CHECK-enforced pairing),
  `created_by_user_id` = the minting admin — **provenance only**, no authority attaches to it:
  **any platform admin** may uninstall, reactivate, or extend any system install regardless of
  who minted it. GDPR erasure (§4) does **not** touch system installs — its token sweep deletes
  the user's *own* keys (`user_id`), and a system token has none; an erased minter simply renders
  as the tombstone label via the live `users` join. The gateway's **owner-status gate** (Gateway
  above) likewise never applies to system tokens — a minter going `inactive` doesn't stop the CI
  credential.
- **Visibility bypass (deliberate):** the gateway **skips the clone-time namespace-access
  re-check** for system tokens — there is no user to check, and the mint itself is a platform
  admin deliberately granting machine access to that skill. The grant survives later visibility
  changes (`org` ⇄ `namespace`). Compensating controls: platform-admin-only minting, the audit
  trail below, per-skill scope, and one-click revocation. (Invariant #3 governs what *users* can
  discover/see; a system install is an explicit admin grant, not a discovery path — the skill
  still never leaks into search/counts.)
- **TTL:** identical rules — dated expiries capped by `install_max_ttl_months`, **Never**
  allowed. Because a Never system token is an **eternal shared credential**, the mint UI's
  caption/confirmation must say so explicitly when Never is selected.
- **Audit (exception to "install tokens are not audited", §11):** minting
  (`install.system_minted`), uninstalling (`install.system_uninstalled`), and
  reactivating/extending (`install.system_reactivated`) a system install are written to
  `audit_log` with actor, skill, pinned/latest, and expiry. This is the compensating control
  that makes a shared, visibility-bypassing credential defensible. Personal install tokens
  remain unaudited.
- **Analytics (§21):** system clones log `access_log.actor_user_id = NULL` +
  `access_log.is_system = true` (distinguishing them from legacy anonymous/tokenless rows).
  They count in trends and `install_counters` like any clone; `skills.install_count` increments
  **once per system installation, at first clone** (the `used_at` stamping — the per-token
  analogue of the per-user first-install rule). They **never** touch the per-user
  `skill_installs` ledger (no related-skills co-install signal, no already-installed exclusion)
  and **never write `install_credits`** — a CI job cloning hourly can never manufacture
  leaderboard standing. The per-skill drill-down surfaces them as a **"System install"** bucket.

### Quick start (first-login onboarding) — `/quick-start`
- A short, **screenshot-driven** getting-started guide for new users, focused on the
  **consumer journey**: an unnumbered **"If you're new to the AI skill
  game"** prerequisites section (below) → find a skill → open it → install it → manage installed
  skills → stay in the loop, plus a "want to contribute?" pointer and a closing CTA. Reached any
  time from the **account menu, above What's new** (the menu's first item).
- **"If you're new to the AI skill game"** (fixed, unnumbered — sits right after the intro, before
  Step 1): explains that skills run on the **user's own machine**, not skilly's servers, so three
  free local tools matter before installing a first skill — **Node.js** (runs the `npx skills add`
  command used in the install step), **Git** (the command it shells out to: per the pinned
  external-tool contract, `npx skills add` runs `git clone --depth 1 --branch <ref>` against the
  minted install URL — Node.js runs the command, Git is what actually fetches the skill's files),
  and **Python** (many skills, including several in skilly's own catalog, run Python scripts when
  used). Covers, at a beginner level: downloading the installer for the user's OS (Windows/macOS/
  Linux; 64-bit on Windows) from the official Node.js, Git, and Python download pages (linked as
  buttons — Git's links to the OS-detecting `git-scm.com/downloads`, matching how the Node.js and
  Python links behave), running the installer (Windows Python install must tick "Add python.exe to
  PATH"), a note that **macOS and Linux ship with Git already installed or one prompt/package-manager
  step away** (unlike Node.js/Python, which need a real installer there too) — so the Git button
  mainly matters for Windows users or the rare machine where it's missing — how to open a command
  line on **Windows** (Win key → `cmd`/`PowerShell`/"Windows Terminal"), **macOS** (Cmd+Space →
  `Terminal`), and **Linux** (terminal app / Ctrl+Alt+T), and verifying with `node -v` / `git
  --version` / `python --version` (`python3 --version` on macOS/Linux).
- **Content** is a hand-authored module (`app/quick-start/content.ts`) rendered by the page.
  **Screenshots** are served from `packages/web/public/quickstart/` (Next only serves images from
  `public/`); they are a curated subset of the screenshots captured by **`e2e/shots.mjs`** (which
  writes to an untracked `docs/manual/shots/` scratch dir and syncs the Quick-start subset into
  `public/quickstart/` on every re-capture — a `QUICKSTART` map mirrors the content module).
- **First-login auto-display (global gate, once).** `users.onboarded_at` (timestamptz, **nullable,
  no back-fill** — so on roll-out EVERY existing user is taken through it once on their next login).
  `/api/me` returns `onboardedAt`; **AppShell** redirects any authenticated page load to
  `/quick-start` while it is null (excluding `/quick-start` itself, and only once the value is known
  — never on the `null`-unknown pre-load state, so a user is never bounced mid-load). The page
  **stamps `onboarded_at = now()` on mount** (`POST /api/me/onboarded`, idempotent via
  `coalesce(onboarded_at, now())`) and fires a `skilly:onboarded` event so the gate releases
  immediately — navigating away (e.g. the "Got it — go to the catalog" CTA) never loops back, and
  later logins skip it. The page stays reachable from the menu afterward.

### Account menu (presentation)
- The bottom-left account menu (name/avatar trigger in the sidebar) lists, top to bottom:
  **Quick start**, **What's new**, **Installed skills**, **Profile**, **Sign out**.
- **Opens and closes with a brief animation** (fade + slight scale/translate from the trigger,
  ~150ms) rather than appearing/disappearing instantly; the close reverses the same transition
  before the menu unmounts. Uses the shared `.menu-pop` animation classes (also used by the
  topbar messages dropdown, §24) so all popover menus in the app animate consistently.

### Invariant #6 carve-out (explicit)
Invariant #6 ("tokens random + single-use/scoped + short-TTL + deleted on use/expiry") is
**amended** for `install` tokens: they are random + **skill-scoped** + **user-TTL'd (≤1y, or an
explicit Never)** + **reusable** + **not deleted on use/expiry**. Revocation is via **uninstall**
(owner hard-delete) or a passing TTL (inactive), not single-use. The contract still holds for any
residual `one_time`/`pat` rows. Rationale: a clone is read-only and skill-scoped, every install is
attributable + listed + one-click revocable, so the consumer-grade reusable handle is the right
trade for usability while keeping the blast radius (one skill, one user, read-only) tight.

**System installations relax the carve-out further** (two more terms): no owning user ("one
user" in the blast radius becomes "the platform" — managed collectively by platform admins,
provenance via `created_by_user_id`), and **no clone-time visibility re-check** (a deliberate
admin grant that survives visibility changes). The compensating controls are platform-admin-only
minting, mandatory **audit** of mint/uninstall/reactivate (the personal-token "not audited" rule
does not extend here), unchanged per-skill scope, and the same one-click hard-delete revocation
— now exercisable by any platform admin.

---

## 24. Messaging

A **general** conversation/message layer. Its first use is **review discussion** between a
proposal's submitter and its reviewers; the model is deliberately context-polymorphic, and a second
context — a **skill request's discussion** — was added in §26 without changing the review-discussion
context's own access rules or lifecycle. A third context — the **skill discussion** (the skill
detail page's Discussion card, below) — follows the same pattern.

### Data model
- **`conversations`** — `subject_type` + `subject_id` (polymorphic context: `'proposal'`→`proposals.id`; `'request'`→`skill_requests.id` (§26); `'skill'`→`skills.id` (the **skill discussion**, below); `'direct'` with `subject_id` NULL = a **1:1 direct conversation**, e.g. "Reach out" to a maintainer), `created_at`, `updated_at` (bumped per message, for list ordering). One conversation per concrete subject (partial unique index); direct conversations are deduped by their exact two-participant set.
- **`conversation_participants`** — `(conversation_id, user_id, last_read_at)`. Created when a user first opens/posts; `last_read_at` is their personal read clock. **Skill discussions use no participant rows** — they are open forums, not participant-scoped threads (below).
- **`messages`** — `author_id`, `body` (plain UTF-8 text → **native emoji**), `context_semver` (nullable, migration 0059 — skill-discussion only: the version the comment is about, stamped at post time), `created_at`. **Immutable** — no edits for anyone, and no deletes except the skill-discussion **moderator delete** (below). Bodies are escaped on render; newlines preserved; no markdown — **except** skill-discussion messages, which render **sanitized markdown** (the shared renderer used for descriptions/usage).

### Access
- **Proposal context:** see/post = **submitter ∪ namespace reviewers (platform/ns admin) ∪ target-skill maintainers**, checked **dynamically** (so it tracks admin-group changes). A non-member 404s (no leak, like the proposal itself). Threads are created **lazily** on the first message, by either side.
- **Request context (§26):** see/post = **any authenticated user** — a skill request has no namespace or reviewers and is already org-visible to everyone, so its discussion is correspondingly open. The requester's own messages carry an **"Original Requester"** tag under their name (in both the request's Discussion card and the topbar messages window).
- **Skill context:** see/post = **any authenticated user who can see the skill** — the discussion inherits the skill's own visibility exactly (invariant #3): an `org` skill's discussion is open to everyone signed in; a `namespace`-restricted skill's discussion is open only to that namespace's members/admins + platform admins. A non-viewer 404s with the skill. Threads are created **lazily** on the first message.
- **Direct context:** access = **being one of the two participants**. A **"Reach out"** button on each maintainer card (skill detail page → Maintainers) get-or-creates the direct conversation with that maintainer and opens it in the messages menu (`POST /api/messages/direct {userId}`; not offered for yourself).

### Lifecycle
Postable while the proposal is open (proposed / under_review / changes_requested); **read-only once
accepted or rejected** — the discussion stays as part of the review record. A **request's** discussion
is postable while the request is `open`; **read-only once `fulfilled`** (withdrawn/removed requests
are hard-deleted — §26 — so their threads are deleted with them, not merely locked). A **skill's**
discussion is postable while the skill is `active`; **read-only while archived** (which, per §7, only
owners can see anyway) and postable again on restore.

**Deletion follows the subject.** A proposal thread is bound to its proposal; if the proposal is
deleted (which happens when its skill is permanently deleted — §7), the conversation and its messages
are deleted with it. A request thread is bound to its request; withdrawing or removing a request
(both hard-delete the row — §26) deletes its conversation the same way. Because the context is
polymorphic (no DB foreign key on `subject_id`), these cascades are enforced in application code:
`deleteSkill` removes conversations for the proposals it deletes **and the skill's own discussion
conversation** (its messages cascade) plus dangling `skill.discussion` notifications, and
`closeRequest` removes the conversation for the request it deletes — both also purge the dangling
`message.new` alerts. As belt-and-suspenders, a conversation whose proposal/request/skill no longer
exists is treated as **not found** everywhere (never listed, never opened) so a stale thread can
never render as `@null/?`.

### Surfaces
- **Review page**: a rich **submitter card** (avatar, name, role-in-namespace, prior-submission count, email mailto + copy, Message button) for reviewers/maintainers, plus the **thread embedded inline**.
- **Request detail page** (§26): a **Discussion card** with the thread embedded inline — same composer/read/lock behavior as the review discussion, no submitter card (the requester is already shown in the page header).
- **Skill detail page**: a **collapsible Discussion card** (dedicated subsection below). Skill discussions do **not** appear in the topbar messages dropdown — they are page-anchored open forums with no participant rows, so the messages menu (a participant surface) never lists them.
- **Topbar messages icon (left of the bell)**: an unread badge + a **full inline chat dropdown** — conversation list that opens into a thread with a composer (emoji picker), read & reply in place. Request threads appear here exactly like proposal threads (title `Request: <title>`, opens to `/requests/[id]`). **Desktop:** opens/closes with the shared `.menu-pop` fade+scale animation (§23, Account menu). **Mobile (full-screen sheet):** instead slides up from the bottom edge on open and slides back down on close, matching native sheet/modal conventions.
- **General notifications**: one **coalesced** `message.new` per conversation per recipient, refreshed until read, so the bell/inbox reflect chat without flooding. Its **email** (§12 *Notification content*) reads "You have a new direct message from {name}" (direct) or "{name} posted a new message in "{title}"" (proposal/request thread). The call-to-action links to the **proposal/request page** for a context thread, or — for a **direct** conversation, which has **no page of its own** — to **`<PUBLIC_BASE_URL>/?conversation=<id>`**. Loading any page with a `?conversation=<id>` query param **auto-opens that thread** in the topbar Messages panel (via the existing `skilly:open-conversation` event) and then strips the param (`history.replaceState`) so a refresh doesn't reopen it.

### Read model & unread
**Opening a thread is the read action**: it advances `last_read_at` AND clears that conversation's
`message.new` notification. The inbox's "mark all read" clears the bell (including message alerts)
but does **not** advance `last_read_at` — the messages icon stays lit until the thread is actually
opened ("saw the alert" ≠ "read the chat"). The notify audience is engaged participants ∪ the
submitter/requester (minus the author), so a whole admin group — or, for a request, every
authenticated user — isn't blasted on every message; only people who have actually engaged, plus
the submitter/requester, are notified.

### Delivery & limits
**Polling** — no realtime/WebSocket infra (deliberately, so it works behind any corporate proxy and
under HA). Chat messages themselves have no external fan-out, but the coalesced `message.new`
**bell rows ride the standard §12 channels** (email/webhook); the coalescing refresh **preserves
the row's delivery bookkeeping** (an atomic update-in-place upsert against the migration-0053
partial unique index — a delete+reinsert would reset `delivered_at` and re-email every new
message, and a non-atomic path could race duplicates), so chat emails **at most once per
conversation until read** (§12). Bodies capped (~4000 chars; **500 chars for skill-discussion
messages**, below) and posting is rate-limited. Endpoints: `GET /api/messages` (list + unread),
`GET|POST /api/messages/:id`, `POST /api/messages/:id/read`, `GET|POST /api/proposals/:id/messages`
(lazy get-or-create), `GET|POST /api/requests/:id/messages` (lazy get-or-create, §26), and
`GET|POST /api/skills/:ns/:slug/discussion` + `DELETE /api/skills/:ns/:slug/discussion/:messageId`
(the skill discussion, below).

**Smart polling (the poll cadence).** The two poll surfaces are driven by one admin-configurable
interval set — `chat_poll_intervals`, a platform setting holding an **ascending, deduped list of
integer seconds** (each `1..3600`, ≤20 entries). Default (and the fallback if the stored value is
absent/invalid): **`[7, 11, 17, 19, 29, 41, 53]`** — primes, to minimise coincidence with other
periodic requests. The smallest element `set[0]` (7s by default) is the **floor**:
- **Open thread** (the messages-menu thread, the proposal review-discussion thread, a request's
  Discussion card, *and* a skill's Discussion card **while expanded** — collapsed = no polling) polls
  at a **fixed `set[0]`** while open — no backoff.
- **Conversation list + unread badge** uses a **backoff that walks the set**: it starts at `set[0]`,
  and each poll that sees **no new activity** advances one step up the set, clamping at the last value
  (53s) and **holding there indefinitely** until something resets it. It **resets to `set[0]`** when
  the poll observes **`unreadConversations` increase**, when the user **sends** a message, or when the
  user **opens the messages menu** (clicks the topbar messages button). While the tab is **hidden** the poller freezes (no
  fetch, backoff position held); on becoming visible it does one immediate refresh and **resumes at
  the same step** (a genuine new-unread on that refresh still snaps it to the floor via the reset rule).

The set is delivered to the client via `/api/me` and **read once at session/app mount** — open tabs
keep the set they loaded with; new page loads pick up an admin's change, so all clients converge as
tabs reload. Edited in the Administration settings card as a comma-separated field (parsed, deduped,
sorted ascending, bounds-checked on save); platform-admin only; audited like the other settings.

### Skill discussion (the skill detail page's Discussion card)

An open, per-skill comment thread on the skill detail page — the third messaging context
(`subject_type='skill'`). One conversation per skill, created lazily on the first comment. Access,
lifecycle, and deletion cascade are specified in the sections above; this subsection specifies the
card and the skill-specific message semantics.

**The card.**
- **Placement:** on the skill detail page, **directly below the Maintainers card** (above the
  `<hr>`/Versions divider).
- **Collapsed by default** on every page load (state is not persisted). The collapsed header reads
  **"Discussion (N)"** — N = the live comment count, returned by the detail API
  (`GET /api/skills/:ns/:slug` gains a `discussionCount` field) so the count shows without expanding.
  Expanding fetches the thread (`GET /api/skills/:ns/:slug/discussion`); the collapse/expand
  interaction reuses the existing collapsible-card pattern (chevron, `aria-expanded`, animated
  grid-rows transition).
- **Deep link:** loading the page with a **`#discussion`** fragment auto-expands the card and scrolls
  to it (used by the notification CTA below).

**Messages.**
- **Each comment renders:** the author's **`UserBubble`** avatar (Entra photo / initials — the shared
  component), the author's display name, a **version pill** (below), and the comment's **date + time**
  (viewer-local via the shared `useDateFmt()` formatter, per the timestamp convention).
- **Ordering & pagination:** **newest-first**. The card shows the most recent **100**; a **"Show
  more"** control appends the next 100 (offset paging on the GET endpoint).
- **Composer:** the same textarea + emoji-picker composer as `ChatBox`, plus the **version picker**
  (below). Body limit **500 characters** (client-counted, server-enforced — tighter than the general
  ~4000 message cap). Bodies render as **sanitized markdown** (the shared renderer used for
  descriptions/usage) — the one messaging context that renders markdown. Posting is rate-limited like
  other message posting. Hidden (thread read-only) while the skill is archived.
- **Live updates:** while the card is **expanded**, the thread polls via the shared smart-polling
  hook at the fixed open-thread cadence (`set[0]`, §24 above); collapsed = no polling.

**The version pill (`context_semver`).**
- The composer includes a **version picker** listing the skill's **active versions** (stable *and*
  beta; **yanked excluded**), **defaulting to the latest stable** — or the highest active version when
  no stable exists. The selected semver is **stamped into the message at post time**
  (`messages.context_semver`) and never changes afterwards.
- The server **validates on post** that the submitted semver is an existing **active** version of
  this skill; if the skill has **no active versions**, posting is still allowed and the message
  carries no version (`context_semver` NULL → no pill).
- Each comment renders its version as a **pill** (`v1.2.0`). If that version is **later yanked**, the
  pill stays and takes the **yanked styling** (matching the Versions list). The pill is **clickable**:
  it scrolls to that version's row in the Versions section (briefly highlighted). A dangling pill
  cannot occur — versions are immutable and only leave the system via skill deletion, which deletes
  the discussion with them.
- Beta versions are commentable like any active version (the pill shows the prerelease semver).

**Moderation (the only message delete in the system).**
- **Who:** the skill's **effective maintainers** (explicit maintainers ∪ the namespace's admins, §19)
  **∪ platform admins** can delete **any** comment in that skill's discussion. Authors have **no**
  self-delete; nobody can edit.
- **How:** **hard delete** of the `messages` row (`DELETE /api/skills/:ns/:slug/discussion/:messageId`,
  authority re-verified server-side), behind a confirm dialog. The thread count decrements; no
  placeholder row remains.
- **Audit:** the deletion writes a **`skill.discussion_message_deleted`** audit row — actor
  (moderator), the comment's author id, the skill, the message id, and timestamp. **The body is not
  recorded** in the payload. Posting itself is **not** audited — the immutable message row is its own
  provenance (and GDPR erasure de-identifies, never deletes, per §4).

**Notifications (`skill.discussion`, §12).**
- On each new comment the recipients are the skill's **watchers ∪ effective maintainers**, minus the
  comment's author, minus users who opted out (below), **filtered against current visibility at
  insert time** (a watcher who has since lost access to a now-restricted skill is skipped —
  invariant #3).
- **Coalesced like `message.new`:** one `skill.discussion` row per skill per recipient, refreshed
  until read (same atomic update-in-place upsert, preserving delivery bookkeeping) — so email fires
  **at most once per skill's discussion until read**. Expanding the Discussion card clears the
  viewer's `skill.discussion` row for that skill (the read action), in addition to the standard
  inbox read semantics.
- **Per-user opt-out:** a third Profile toggle, **"Discussion comments on skills I maintain or
  watch"** (`users.discussion_notifications`, BOOLEAN NOT NULL DEFAULT true — migration 0059),
  grouped with the drift/new-version toggles (§12) and filtered the same way — **row-level, at
  insert time**. **Deliberate contrast with `skill.new_version`:** here the opt-out silences
  **watcher-derived recipients too** (an explicit watch does *not* outrank it) — it is the only way
  to keep watching a skill for versions while muting its chatter; the watch's own off-switch remains
  unwatch.

**Schema (migration 0059).** `messages.context_semver TEXT NULL` +
`users.discussion_notifications BOOLEAN NOT NULL DEFAULT true`. No new tables.

## 25. System log

An operational view, for **platform admins only**, of the **user-facing HTTP errors** the platform
returned — primarily the web tier, plus the worker's git-gateway refusal event below — the issues
the platform encountered, with the user who hit them. Linked in the sidebar
directly under **Audit log** (but, unlike Audit log, *not* shown to namespace admins).

This is **not** the audit log: it is high-volume, mutable operational telemetry, so it deliberately
has **no** tamper-evident hash chain and **no** append-only trigger (cheap inserts, easy retention).

### What is recorded
- **5XX always.** Of 4XX, only the meaningful ones: **403 / 409 / 413 / 422 / 429**. A recorded
  **413** is an **app-origin** oversize rejection (an upload over the configured `max_bundle_bytes`,
  §6); a 413 generated by a reverse proxy in front of skilly never reaches the app and therefore
  **cannot** appear here (§6 deployment caveat). **401 is excluded**
  (constant noise from expired/anonymous polling) and `/api/*` **404**s are polling noise —
  with **one deliberate 401 carve-out**: the worker's git gateway records
  **`install_token_owner_inactive`** (a clone refused because the install token's owning user is
  not `status='active'`, §23 Gateway) as a `source='worker'`, `status=401` event. It is the only
  401 in the log and the first worker-sourced event; an ex-employee's token still being tried is a
  signal worth surfacing, not polling noise.
- **Capture path (primary):** a `withSystemLog(routeTemplate, handler)` wrapper records, **in the
  route's own context**, both the error **responses** a handler returns *and* errors it **throws**
  (logging the stack to stdout, recording a 500, and answering with a JSON 500). This is the reliable
  path — it does not depend on framework error hooks. Wrapped (indicative): proposals submit +
  actions + list, skill detail, install, publish, **uploads**, direct messages, usage, leaderboard,
  and **user-erase**.
- **Capture path (net):** Next's `instrumentation.ts` **`onRequestError`** records uncaught 500s on
  routes that are *not* wrapped. It loads once at boot (no hot-reload) and is best-effort. No overlap:
  a wrapped handler's throw is caught and answered there, so it never reaches the hook.
- **Fire-and-forget:** the insert is never awaited and a logging failure can never turn a response
  into a 500. The 2xx/3xx happy path pays nothing.

### Data model — `system_event` (migration 0032)
`status`, `method`, `route` (matched **template**), `path` (concrete, **no query string**), `user_id`
(null = anonymous) + a **point-in-time `actor_name`/`actor_email` snapshot** (denormalized at insert),
`error_code`, sanitized one-line `message` (**no stack trace**), `request_id`, `duration_ms`,
`source` (`web`, or `worker` — used by the git gateway's `install_token_owner_inactive` event,
§23; for that event `user_id`/actor snapshot identify the **token owner**, not the anonymous git
client). **Privacy:** never the query string, body,
headers, or a stack (CLAUDE.md #6). A **trigram (`pg_trgm`) GIN index** over
`path‖error_code‖message‖user_id‖actor_email‖actor_name` powers fast substring search.

### Surface & API
- **`/system-log`**: status-class chips (All / 5XX / 403 / 413 / 422 / 429 — note **409** and the
  gateway's **401** carve-out events are recorded but have no dedicated chip; they appear under
  All; **413** renders with the same muted client-error tone as 422) + a search box + a **From/To
  date range** (same native-date-input widget as `/audit`; local day → UTC, To inclusive end-of-day)
  + a **`✕ clear filters`** button (shown when status/search/dates are non-default; resets all),
  **infinite scroll** in pages of 100, rows showing a color-coded status pill, `METHOD path`, error
  code, the user (click to filter by their id), and a relative time; click a row to expand full detail.
- **`GET /api/system-log`** (`q`, `status`, `from`, `to`, `limit`, `offset`) — **hard-gated to platform
  admins** (403 for anyone else, not just a hidden link). **Retention:** the worker trims events older
  than **90 days** (so the date range only ever spans that window).
- **CSV export (`GET /api/system-log/export`)**, same hard platform-admin gate as the rest of the
  surface. Honors the same active filters (status/search/date range) as the on-screen list — exports
  what's on screen, not a separate full dump. Capped at **`SYSTEM_EVENT_EXPORT_CAP` = 50,000 rows**,
  newest-first; `X-Total-Matching`/`X-Exported-Count` response headers drive an in-app "exported N of
  M — narrow the range" notice when the filtered set exceeds the cap. Columns: `id, created_at,
  status, method, route, path, user_id, actor_name, actor_email, error_code, message, request_id,
  duration_ms, source`. RFC 4180 quoting, UTF-8 BOM (Excel-friendly) — same writer as the audit
  export (§11).
- **Nav badge:** the System log sidebar link shows a 1–9+ superscript of events recorded since the
  admin last opened it (`users.system_log_seen_at`, migration 0033) — same mechanism as Catalog /
  Review queue (§10), platform-admin only, cleared on visit.
- **Alerts:** a leader-only worker sweep posts a **coalesced** `system.error` bell notification to
  each platform admin when new events appear — one unread item per admin, its count accumulating
  until read, watermark-tracked (`platform_settings.system_log_notify_at`) so events aren't
  double-counted. In-app only (no email/webhook fan-out).

---

## 26. Request a skill

Users can post a **request** for a skill that doesn't exist yet; anyone can pick a request up,
propose the skill through the normal pipeline, and — on acceptance — the request is fulfilled,
the requester is notified, and the fulfiller earns leaderboard credit.

### Posting a request (the propose-page toggle)
- The **Propose a skill** page gains a two-state toggle at the top: **"I have a skill"** (default —
  the page behaves exactly as today) / **"I want a skill"**.
- In **"I want a skill"** mode the form reduces to: **Title**, **Categories**, **Description**,
  **Usage** and **Tool/harness** — namespace, visibility, slug, version and the bundle/pointer
  sources are hidden (a request has no namespace: it is **org-visible to every authenticated
  user**). Requests are **text-only**: there is no file upload. `POST /api/requests` **rejects**
  any file part (422) so the text-only contract is enforced server-side.
- Submitting creates a `skill_requests` row (state **`open`**) — it does **not** enter the proposal
  review pipeline; requests are lightweight and unreviewed. Audited as `request.created`.
- **Duplicate soft-warn:** on submit, the duplicate detector (§8) checks the title/description
  against **open requests** ("someone already asked for this") and **visible catalog skills**
  ("this may already exist") and shows an advisory warning — the user may post anyway. Never a
  hard block, regardless of the platform duplicate-enforcement setting (that setting governs
  proposals, not requests). The first **Post request** click runs the similar-check and, if
  anything matches, surfaces the banner and flips the button to **Post anyway**; the next click
  posts regardless. **Editing any request field after the warning (title, description, usage,
  categories, or tool) invalidates the acknowledgement** — the banner clears and
  the next click re-runs the similar-check, so a changed request is never posted as "Post anyway"
  without being checked.
- **Read-only while posting:** pressing **Post request** puts the whole form into a read-only
  state — a scrim overlays and dims the fields so nothing can be edited while a network call is in
  flight; the primary button remains visible above the scrim showing **"Working…"** as the only
  feedback (no separate spinner or cancel control). The lock is scoped to the request flow ("I
  want a skill") only. It releases the instant control must return to the user — when the
  similar-check surfaces its warning, or on any error (the error shows and the form is editable
  again). On a **successful** post the form **stays locked through the navigation** to the new
  request page, so there is no editable gap between the successful POST and the route transition.

### The Requested skills page
- New nav item **"Requested skills"**, directly **below "Propose a skill"** — lists **open**
  requests in the catalog's card/row visual language (cards ⇄ list toggle, same persisted view
  preference pattern): title, categories, tool chip, requester (name + avatar), and posted date.
  Search + category/tool filtering mirror the
  catalog's live-filter behavior. Auth-required; org-visible (no visibility filtering — requests
  have no namespace). The nav item carries the same superscript **"new items" badge** and the
  cards/rows carry the same **"new" corner tag** as the Catalog (§10) — one request created since
  the user's last visit is enough to light both up.
- **"Mine" toggle** beside the search bar: switches the list from the org-wide open list to **the
  caller's own requests, in any state** (`open` or `fulfilled` — withdrawn/removed hard-delete the
  row, so there is nothing left to show for those). Search/category/tool filters still apply within
  either mode. In "Mine" mode each card/row also shows a **state pill** (open / fulfilled) — the
  pill is hidden in the org-wide list, where every result is always `open`. No "new" badges in
  "Mine" mode (these are the caller's own posts). `GET /api/requests?mine=1`.
- **State filter (platform admins only).** The org-wide list shows **open** requests to everyone.
  A **platform admin** additionally gets a state selector beside the "Mine" toggle — **Open**
  (default) · **Fulfilled** · **All** — so admins can review requests in any state, e.g. see what's
  already been **fulfilled**, not just what's still open. `GET /api/requests?state=fulfilled|all`;
  the authority is enforced **server-side** (a non-admin `state` param is ignored → open only), and
  the GET returns `isAdmin` so the client knows whether to render the selector. When the filter
  admits non-open rows (Fulfilled/All), each card/row shows the same **state pill** as "Mine". The
  selector is not shown in "Mine" mode (which already spans every state). Only `open`/`fulfilled`
  ever persist (withdrawn/removed hard-delete), so those are the only states the filter can surface;
  the per-row "new" tag is only ever applied to open rows.
- **Request detail page**: full description + usage, categories, tool, requester, posted/updated
  dates, the primary action — **"Propose a skill"** (default) or **"Propose an existing skill"**
  once a skill is picked from the adjacent search dropdown (below) — and a **Discussion** card.

### Discussion (§24 extension)
- Every request gets a **Discussion** card on its detail page — a group chat, not a 1:1: **any
  authenticated user** may read and post (the request is already org-visible to everyone; there is
  no submitter/reviewer/maintainer gate like a proposal's review thread). Same widget, composer,
  read/notify/poll behavior as a proposal's review discussion (§24) — a separate, additive
  conversation context (`subject_type = 'request'`) that does **not** change the proposal review
  flow's own access rules or lifecycle.
- The **requester's own messages** carry an **"Original Requester"** tag under their name, so it's
  always clear whose wish is being discussed even once other people join in.
- **Postable while `open`; read-only once `fulfilled`.** Withdrawing or removing the request hard-
  deletes it (below), which deletes its conversation with it — there is no "locked, withdrawn"
  state to view, since the row (and thread) are simply gone.
- **Notifications:** posting fans out a coalesced `message.new` to everyone who has engaged in the
  thread, plus the **requester** (always, even before they've opened it) — minus the author. Appears
  in the **topbar messages window** exactly like a proposal thread (title `Request: <title>`, "open
  →" links to `/requests/[id]`) and in the **notifications page** ("view request →").
- `GET|POST /api/requests/[id]/messages` (lazy get-or-create, mirrors `/api/proposals/[id]/messages`).

### Fulfilment via a proposal (explicit link only)
This is one of **two independent fulfilment paths** — the other, immediate one is below. Whichever
happens first on a given request wins; the other simply no-ops once the request is no longer `open`.
- The request page's **"Propose a skill"** button opens the propose form (in "I have a skill"
  mode) **pre-filled** with every field the request can supply — title, categories, description,
  usage, tool — and **carries the request id** through submission (`?fromRequest=<id>` → a
  `origin_request_id` column on `proposals`). The proposer can edit anything before submitting.
- **Only a proposal carrying the request's id can fulfil it** (explicit link only — an
  independently proposed identical skill leaves the request open). The link is advisory until
  acceptance: a rejected/withdrawn proposal leaves the request open; multiple proposals may carry
  the same request id and the **first accepted** one fulfils it (later ones proceed as normal
  proposals, their link a no-op). If the request was withdrawn/removed/already fulfilled by
  acceptance time, the link no-ops.
- **On acceptance** of a linked proposal (same instant the skill/version materializes) — **or on a
  direct publish carrying the link** (a direct publish, in a `require_review = false` namespace, IS
  an immediate acceptance, so it fulfils in the same transaction as the publish, credited to the
  publisher):
  - the request flips to **`fulfilled`** with `fulfilled_skill_id`, `fulfilled_by_user_id` (the
    proposal's submitter, or the direct publisher) and `fulfilled_at` — it disappears from the
    Requested-skills open list (fulfilled/withdrawn/removed states are never listed there; a
    fulfilled request stays visible in the requester's own **"Mine"** view, above) — **the request
    row is deliberately NOT deleted on fulfilment** (unlike withdraw/remove), since its survival is
    what powers the fulfilled request's own page — a **"Fulfilled by ‹name›" credit banner** plus a
    prominent **"Open the skill →" primary button** (in the top action row, the slot the open state's
    "Propose a skill" button occupies) that links straight to `/skills/‹ns›/‹slug›` — the Discussion
    history, and the leaderboard's "requests fulfilled" stat below;
  - the **requester is notified** (bell + standard delivery, §12): *"Your request '<title>' was
    fulfilled by <name>"* with a link to the new skill's page — **unless the fulfiller is the
    requester** (self-fulfilment: silent, no notification). This is the **only** fulfilment
    notification — nothing fires earlier, at proposal-submission time, before it's accepted.
  - audited as `request.fulfilled` with `via: "proposal"` (direct publish: `via: "direct_publish"`)
    in the audit detail, distinguishing this path from the existing-skill path below.
- **No early notification.** Submitting a proposal linked to a request (`?fromRequest=<id>`) does
  **not** notify the requester by itself — only a proposal's or direct publish's actual acceptance
  does (above). A proposal can sit in review indefinitely, get rejected, or be withdrawn without the
  requester ever hearing about the attempt.

### Fulfilment via an existing skill (immediate, no review)
The second fulfilment path: instead of building something new, any user can point a request at a
skill that **already** satisfies it.
- On an **open** request's detail page, next to **"Propose a skill →"**, an inline search-and-select
  control lets the user look up a skill by name. It searches **org-visible skills only**
  (`visibility = 'org'`) — namespace-restricted skills are excluded even if the searching user has
  access to them, so the resulting link is always openable by the requester and everyone else.
  Reuses the existing header-search autocomplete (`GET /api/skills/suggest`) with a new
  `scope=org` mode — same auth requirement, 2-char floor, result cap, and per-user rate limit as
  today's header search.
- **Selecting a skill swaps the button**: the default **"Propose a skill →"** becomes
  **"Propose an existing skill"**; clearing the selection reverts it. Only one button is shown —
  the dropdown's selection state decides which action fires. This mirrors the layout the open
  state already uses (single primary action slot).
- Clicking **"Propose an existing skill"** is **immediate — no proposal, no review, no requester
  confirmation** (the skill is already published/vetted). A confirm dialog — *"Fulfil this request
  with '‹skill title›'? This can't be undone."* — guards the action, matching the Withdraw/Remove
  pattern. **Any authenticated user** may do this (same implicit right as proposing).
  `POST /api/requests/[id]/fulfil { namespaceSlug, skillSlug }` — identifying the skill by its
  public slug pair (not an internal id) so the server re-resolves and re-validates eligibility
  (active + org-visible) at write time, regardless of what the dropdown showed.
- Server-side this succeeds **only if the request is still `open`** at write time (same guard as
  proposal-acceptance fulfilment, atomically checked) — otherwise it 409s with an error the client
  surfaces ("This request was already fulfilled/withdrawn/removed"). On success, the request
  transitions exactly as a proposal-based fulfilment does: `fulfilled_skill_id` (the selected
  skill), `fulfilled_by_user_id` (the linker), `fulfilled_at` are set; the same credit banner and
  "Open the skill →" action render on reload; the Discussion history is retained.
- **Requester notification**: identical to the proposal path — *"Your request '<title>' was
  fulfilled by <name>"* — **unless the linker is the requester** (self-fulfilment: silent).
- **Leaderboard credit**: counts toward "requests fulfilled" (§21) exactly like a proposal-based
  fulfilment — same no-self-credit rule (only counts when `fulfilled_by_user_id` ≠ the requester).
  Linking an existing skill is treated as equivalent credit to building one, since it closes out
  the requester's need either way.
- Audited as `request.fulfilled` with `via: "existing_skill"` in the audit detail (plus the
  selected skill's namespace/slug), so the append-only log distinguishes this path from a
  proposal/direct-publish fulfilment.

### Lifecycle & moderation
- The **requester** can **edit** their open request (all fields) and **withdraw** it — requester
  only, enforced server-side. A **platform admin** can **remove** any open request as
  **moderation**. **Both withdraw and remove permanently delete the row**
  (categories cascade; a linked proposal's `origin_request_id` is set null) — neither is a state
  change, and neither is reversible. Both are audited (`request.withdrawn` / `request.removed`)
  with a full snapshot of the deleted request (title, description, usage, tool, requester) in the
  audit entry, since the row itself won't exist afterwards to inspect. Only an `open` request can
  be withdrawn or removed; fulfilled requests are immutable.
- Requests never expire in v1 (revisit if the list goes stale).
- GDPR erasure (§4): an erased requester's open requests are deleted, same as a self-withdrawal.

### Leaderboard (§21 extension)
- A third stat per row: **"requests fulfilled"** — the number of `fulfilled` requests where
  `fulfilled_by_user_id` = the user **and the requester is someone else** (no self-credit,
  consistent with install credits). Snapshotted at acceptance (`fulfilled_at`), so later user
  changes never move past credit; the all/30d window filters on `fulfilled_at`.
- A fourth stat per row: **"skills watched"** — the count of **distinct skills this user
  explicitly maintains (`skill_maintainers`, not implicit namespace-admin maintainership —
  consistent with install-credit attribution) that have at least one watcher (`skill_watches`)
  OTHER than the maintainer themselves.** Self-watch exclusion is evaluated **per maintainer**:
  if a skill has co-maintainers A and B and A watches their own skill, that watch does not count
  toward A's stat but still counts toward B's (each maintainer is independently checked against
  every *other* watcher row, mirroring how a maintainer earns no self-credit for their own
  installs). The all/30d window filters on the watch's `created_at` (a skill watched more than
  30 days ago and not since drops out of the 30d view, consistent with how the other three stats
  window on their own event timestamp).
- A **sort toggle** above the board: **Installs** (default) / **Skills adopted** / **Requests
  fulfilled** / **Watched** — re-ranks rows by the chosen stat (ties broken by the other stats,
  then name). All four stats stay visible on every row regardless of sort.

### API surface (indicative)
- `POST /api/requests` (create; text-only — rejects file parts) · `GET /api/requests` (open list;
  `q`/`category`/`tool`; add `mine=1` for the caller's own requests in any state) ·
  `GET /api/requests/[id]` · `PATCH /api/requests/[id]` (requester edit)
  · `DELETE /api/requests/[id]` (requester withdraw / platform-admin remove) — all auth-required.
- Propose page reads `?fromRequest=<id>` to pre-fill; `POST /api/proposals` accepts
  `originRequestId` (the accept path performs the fulfilment side-effects atomically, §8); so does
  `POST /api/publish` for a direct publish, which fulfils immediately in the same transaction.

## 27. System banner (header announcement)

A single, platform-wide, ephemeral text banner a Platform Admin can post, shown as an accent-color
pill in the header topbar between the search box and the messages button (`<MessagesMenu />`).
Deliberately **not** built on the `messages`/`conversations`/`notifications` tables (§12, §24) —
those are immutable, per-subject, and drive email/webhook fan-out, none of which fit a mutable,
deletable, no-notification broadcast. It gets its own table and never touches those pipes, so the
"excluded from notifications and email" requirement is structural, not a filter bolted on elsewhere.

### Data & lifecycle
- Stored as **one more `platform_settings` key** (`system_banner`, §3) — not a dedicated table —
  holding `{ message, expiresAt }` (`message`: plain UTF-8, ≤100 chars, escaped on render, no
  markdown/links, consistent with chat message bodies, §24). No migration needed; the existing
  `updated_by`/`updated_at` columns record who set it and when.
- **Setting/replacing (`PUT /api/admin/system-banner`, platform-admin only):** every save is an
  **unconditional upsert** — new message text and the newly-picked duration always replace whatever
  is currently active, and the countdown **always restarts from the moment of save**
  (`expires_at = now() + duration`), regardless of whether the new duration is longer or shorter
  than whatever time was left. There is no "only extends if greater" special case. Audited
  (`system_banner.set`, with actor + message + duration).
- **Duration:** exactly one of **1h / 4h / 8h / 1d / 1w / 1m**, selected per save — no custom
  durations. Modeled in whole hours (`expires_at = now() + N h`): **1d** = 24h, **1w** = 7 days =
  168h, **1m** = 30 days = 720h (a fixed 30-day span, *not* a variable calendar month; the label
  stays "1m").
- **Clearing (`DELETE /api/admin/system-banner`, platform-admin only):** removes the active banner
  immediately, before natural expiry. Audited (`system_banner.cleared`).
- **Expiry is lazy — no worker sweep.** The row is treated as **active** only while
  `expires_at > now()`; every reader (the header pill's poll and the admin card's own GET) computes
  this at read time. Once expired: the header pill stops rendering it on the next poll, and the
  Administration card's "currently active" summary clears back to its empty/default state — even
  though the row may still physically exist in the DB until the next Save or Clear overwrites it.
  No leader-locked cron job is introduced for this feature (unlike the pointer-mirror/notify
  sweeps, §16).
- **Singleton:** at most one banner is ever active. Saving while one is already active replaces it
  in place (text and timer both) — there is no queue or history of banners.
- **No per-user dismiss.** Visibility is purely global: every authenticated user, in every
  namespace, sees the same pill until it expires or a platform admin clears it. There is no
  namespace-scoped variant and no per-user hidden/dismissed state.

### Header rendering
- An accent-tone `Pill` (the existing shared `Pill` component, `tone="accent"` — the theme's active
  color, `components/ui.tsx`) rendered in the topbar on the **right**, immediately left of
  `<MessagesMenu />` — i.e. in the gap between the search box and the messages/bell/theme-toggle
  control cluster. Hidden entirely when there is no active banner (never an empty row). Plain text
  only.
- **Desktop (wide) — truncate, never overflow.** The pill is width-capped and its text truncates
  with an ellipsis on a single line; a `title` tooltip carries the full message on hover. It must
  **never** grow past its cap or slide under the control cluster — a clear gap always separates the
  two. (A message well under the 100-char cap already exceeds the pill's width cap — only ~35–40
  uppercase mono characters fit at ~280px — so *truncate + hover-tooltip* is the contract,
  correcting the earlier, incorrect "50 characters is expected to fit without truncation"
  assumption, which let the pill overflow behind the header buttons. Mechanically the cause is the
  inner `.pill` flex child lacking `min-width: 0`, so it refused to shrink inside the capped
  `.system-banner`.)
- **Mobile (≤880px — the existing topbar reflow) — own line, full text.** When the topbar wraps to
  its narrow layout (control cluster on the first row, full-width search on the second), the banner
  pill drops onto its **own full-width line below the search row**. Final vertical order:
  **control cluster → search → banner pill** (the pill is the bottom-most row, and only present when
  a banner is active). On this line the pill is **not** truncated: its text **wraps** across as many
  lines as needed to show the whole message, because touch has no hover and an ellipsis would
  permanently hide the announcement. This also removes the current mobile defect where the pill is
  squeezed onto the icon row and collides with the buttons.
- **Delivery:** the active banner (`{ message, expiresAt } | null`) is folded into an endpoint the
  client already polls (the existing nav-badges/messages poll, §24) rather than a new
  transport — so an open tab picks up a new message, a replaced message, or a clear within that
  existing adaptive polling cadence. `GET /api/system-banner` — any authenticated user.

### Administration page
- A new **collapsible card** (the existing per-card collapsed/expanded + Expand/Collapse-all
  pattern, `admin/page.tsx`), **platform-admin only**: a text input (maxlength 100, live character
  counter), a duration selector (1h / 4h / 8h / 1d / 1w / 1m), and a **Save** button. When a banner is
  currently active, the card also shows the live message + remaining time and a **Clear now**
  button; once expired, that summary reverts to the empty/default state (above) without requiring
  any action.

### Authority & audience
- **Set/clear: Platform Admin only** — matches "system-wide" scope and the fact this admin-page
  section is already platform-admin-scoped (SCIM, namespaces, platform admins, §5). Namespace
  Admins have no authority here.
- **See: every authenticated user, org-wide** — no visibility filtering by namespace (unlike skill
  visibility, invariant #7).
