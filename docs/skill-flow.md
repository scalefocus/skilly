# Skill flow — from upload to `npx skills add`

> Technical walkthrough of a **hosted** skill's full lifecycle: upload → review/approve →
> git synthesis → install. Grounded in the code; file paths are relative to the repo root
> and carry line numbers where useful. The authoritative design is
> [`../SKILLY_SPEC.md`](../SKILLY_SPEC.md) (esp. §6–§9, §23); this doc traces how it is
> actually implemented.

A hosted skill crosses two processes and three backends:

- **`web`** — Next.js route handlers (upload, proposal, review, install-command minting).
- **`worker`** — a leader-locked singleton that runs the publish sweep, **and** serves the
  authenticated git smart-HTTP gateway on every replica.
- **Postgres** (`skill_versions`, `proposals`, `tokens`, `scan_reports`, `access_log`, …),
  **S3/MinIO** (the immutable bundle artifact), **on-disk git** (`/data/git/<ns>/<slug>.git`).

```
 user            web tier                         worker (leader)         git gateway (worker)
  │   upload      │                                 │                          │
  ├──────────────►│ POST /api/uploads               │                          │
  │               │  extract→validate→scan→S3 put   │                          │
  │               │  scan_reports(subject='artifact')                          │
  │   propose     │                                 │                          │
  ├──────────────►│ POST /api/proposals             │                          │
  │               │  proposals(state='proposed')                               │
  │   review      │                                 │                          │
  ├──────────────►│ POST /api/proposals/:id/actions │                          │
  │               │  accept → materializeVersion                               │
  │               │  skill_versions(git_published=false)                       │
  │               │                                 │ publish sweep (≤60s)     │
  │               │                                 │  S3 get→synthesize git   │
  │               │                                 │  tag v<semver>, main      │
  │               │                                 │  git_published=true      │
  │               │                                 │  notify watchers         │
  │   install     │                                 │                          │
  ├──────────────►│ POST .../install                │                          │
  │               │  mint install token + command   │                          │
  │   clone       │                                 │                          │
  ├───────────────┴─────────────────────────────────────────────────────────►│ git-upload-pack
  │                              npx skills add (git clone)                     │  validate token,
  │◄───────────────────────────────────────────────────────────────────────── │  visibility, stream
```

---

## Phase 1 — Upload (`POST /api/uploads`)

Handler: `packages/web/src/app/api/uploads/route.ts:25` (wrapped in `withSystemLog`). Runs
**before** any proposal exists; returns the keys/hashes the propose form carries forward.

1. **Gate** — session `oid` (401 if none) → `resolveUserAccess(oid)` (roles from SCIM groups,
   never token claims); `enforceRateLimit("uploads", userId, 20)`.
2. **Size guard** — `getMaxBundleBytes()` reads the `max_bundle_bytes` platform setting
   (default 10 MB); rejects on `Content-Length` then parsed blob size (413).
3. **Extraction** — `extractBundle` (`packages/web/src/lib/bundle.ts:96`,
   `packages/shared/src/archive.ts`): **magic-byte** detection (gzip `1f 8b`, zip `PK…`;
   `.skill` falls back to zip), a single common wrapper directory stripped, decompression
   bounded (**≤2000 entries, ≤20 MB actual bytes**), symlinks/`..`/junk rejected.
4. **Blocking validation** — `validateBundle` (`packages/shared/src/validate.ts:40`):
   top-level `SKILL.md`; frontmatter parses; `name` + `description` required;
   **`name === skillSlug`**; no disallowed binary extensions; under size cap. Fail → **422**.
5. **Advisory scan** — `runScanners(files, PURE_SCANNERS)` (`packages/shared/src/scan.ts`):
   `secret-scan` + `static-heuristics` only. **ClamAV runs in the worker, not here.** Findings
   never block at upload.
6. **Two hashes** — `artifactSha256` (whole-archive SHA-256) and `contentSha256`
   (`contentDigest`, `packages/shared/src/content-digest.ts`: SHA-256 over the *sorted per-file*
   hashes — packaging-independent, drives duplicate detection).
7. **Store** — original bytes `put` to S3 at `uploads/<userId>/<uuid>.bundle`
   (`packages/web/src/lib/objectStore.ts`; bucket `skilly-artifacts`). Failure → 503.
8. **Artifact-keyed scan report**:
   ```sql
   insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status)
   values ('artifact', $1, 'pipeline', $2::jsonb, $3, 'scanned')
   ```
9. **201** → `{ artifactObjectKey, artifactSha256, contentSha256, scan, duplicate, duplicateEnforcement }`.

**State:** bytes in S3 + an artifact-keyed scan report. No skill / version / proposal yet.

---

## Phase 2 — Proposal (`POST /api/proposals`)

Handler: `packages/web/src/app/api/proposals/route.ts`. If the namespace has
`require_review=false` and the user `canDirectPublish`, they instead hit `POST /api/publish` →
`directPublish`, which **skips this phase** and calls `materializeVersion` directly. The `global`
namespace always requires review.

1. Auth + `enforceRateLimit("proposals", userId, 30)`; resolve namespace; contribution-policy check.
2. **Slug-uniqueness 409** — a new-skill submission whose `(namespace, slug)` exists is bounced
   to "propose a new version instead".
3. **`verifySubmissionPayload`** (`packages/web/src/lib/proposals.ts:103`):
   visibility backstop (`namespace` visibility can't live in `global`); **closed tool/harness
   vocab** (`normalizeHarness` → `isAllowedToolHarness`); **hosted ownership + scan gate** (the
   artifact key must start with `uploads/<thisUser>/` and have a scan report).
4. **Duplicate detection** (`packages/web/src/lib/duplicate.ts`) — matches an existing active,
   visible version by `content_sha256`; `duplicate_proposal_enforcement='block'` (default) → 409,
   `'warn'` → through (reviewer alerted).
5. **`createProposal`** (transaction):
   - `insert into proposals (target_namespace_id, target_skill_id, proposed_semver, state, submitted_by) values (…, 'proposed', …)`
   - `insert into proposal_revisions (…, revision_no=1, payload, author, 'initial submission')` —
     `payload` = `{metadata, artifactObjectKey, artifactSha256, contentSha256, pointer:null}`.
   - Audit `proposal.created`; notify submitter (`proposal.submitted`) + reviewers
     (`proposal.needs_review` → platform admins ∪ namespace admins ∪ bootstrap admins).
6. **201** `{ id }`.

**State:** proposal in `proposed`, immutable revision 1. Still no skill/version.

---

## Phase 3 — Review → Accept → Materialize

Handler: `packages/web/src/app/api/proposals/[id]/actions/route.ts` → `performProposalAction`
(`packages/web/src/lib/proposals.ts:308`); state machine in `packages/shared/src/proposal.ts`.

- **State machine** (`TRANSITIONS`): `proposed → under_review → (changes_requested ⇄
  under_review) → accepted | rejected`. `accept` is legal only from `under_review` and requires a
  reviewer (`canReviewNamespace`).
- **Reviewer edits** — a `newPayload` is re-validated and appended as a new `proposal_revisions`
  row; `materializeVersion` reads the *latest* revision.
- **Scan-override gate on accept** — if the artifact scan severity `requiresOverride` (high/critical)
  and no `override`, → **409**; an override writes a `proposal.scan_override` audit row.

**`materializeVersion`** (`packages/web/src/lib/proposals.ts:430`), in the accept transaction:

1. `skills` row (new skill only) with `type='hosted'`; categories attached; submitter auto-added
   to `skill_maintainers` if eligible.
2. `is_prerelease = channelOf(semver) !== 'stable'`.
3. `assertStrictlyIncreasing(semver, existing)` — rolls back if not strictly greater (immutability).
4. The key insert:
   ```sql
   insert into skill_versions
     (skill_id, semver, is_prerelease, status, usage_examples,
      artifact_object_key, artifact_sha256, content_sha256, created_by, git_published)
   values ($1,$2,$3,'active',$4,$5,$6,$7,$8, false)
   ```
   Note **`git_published = false`**; `created_by` = the original submitter.
5. `proposals` → `state='accepted'`, `materialized_version_id` linked; audit `proposal.accept`;
   notify submitter.

`latest` is **never stored** — it's computed by `resolveLatest()` (highest *stable* semver among
active versions).

**State:** an `active`, `git_published=false` version pointing at the S3 artifact — published in
the data model but **not yet servable** (the UI shows "Publishing…", the install endpoint refuses
it).

> The `skill.published` audit row is emitted only on the **direct-publish** path; the review path
> records `proposal.accept` (+ optional `proposal.scan_override`). The `skill.new_version`
> watcher/maintainer notifications fire later, from the worker (Phase 4).

---

## Phase 4 — Worker publish sweep → git synthesis

The worker (`packages/worker/src/index.ts`) is the leader via
`pg_try_advisory_lock(855399)` on a dedicated connection. The `sweep` runs immediately then every
`PUBLISH_SWEEP_INTERVAL_MS` (**default 60s**) → `publishPendingVersions`
(`packages/worker/src/git/publish.ts:35`).

1. **Select pending** (batch ≤50, oldest first):
   ```sql
   select … from skill_versions sv …
   where sv.status='active' and sv.git_published=false and sv.artifact_object_key is not null
   order by sv.created_at asc limit 50
   ```
2. `isLatestStable` via `resolveLatest` over all active semvers (order-independent).
3. **S3 get** the artifact → **extract** (worker `bundle.ts`: ≤50 MB / ≤5000 entries, symlinks
   blocked) → **`ensureSkillName`** (see note) → **re-run `validateBundle`** (invalid → skip,
   stays unpublished).
4. **`synthesizeVersion`** (`packages/worker/src/git/synth.ts:116`) on the bare repo at
   `/data/git/<ns>/<slug>.git`:
   - `git init --bare --initial-branch=main` (if absent); refuse if `v<semver>` tag exists.
   - Build the tree **at the repo root, unwrapped** (`SKILL.md` at root — what `npx skills add`
     reads): `git hash-object -w --stdin` per blob, `git mktree` (preserving `100755`).
   - **Deterministic root commit**: `git commit-tree <tree> -m "skilly: publish v<semver>"` with
     author+committer pinned to `skilly <skilly@localhost>` at `2026-01-01T00:00:00Z` (reproducible
     SHA → restore re-creates the identical commit).
   - `git update-ref refs/tags/v<semver> <commit>` (immutable tag); if latest stable,
     `git update-ref refs/heads/main <commit>`.
5. **Flip** `update skill_versions set git_published = true where id = $1`. (The
   `skill_versions_guard` trigger — migration 0039 — allows only `status` and `git_published` to
   change post-insert.)
6. **Notify** — one INSERT…SELECT over a deduped `UNION` of `skill_watches` ∪
   `skill_maintainers` ∪ the namespace's `namespace_admin` group members (`type='skill.new_version'`).

> **Note — SKILL.md may be rewritten at synthesis.** Just before validation, `ensureSkillName`
> (`packages/worker/src/git/publish.ts`) injects/corrects `name: <skillSlug>` in the SKILL.md
> frontmatter (prepending frontmatter if absent). Claude Code skills carry only `description` (the
> name comes from the install directory), but `vercel-labs/skills` and `validateBundle` require an
> explicit `name` matching the slug. So the synthesized git tree is the artifact files **with this
> one normalization**, not always byte-identical to the uploaded SKILL.md. The stored artifact in
> S3 is untouched; only the served tree differs. The same step runs in the self-heal path below.

**Self-heal** (`reprovisionMissingRepos`, same sweep): reconcile each published skill's full ref
set against the DB — re-synthesize missing `v<semver>` tags, repoint `main` if drifted/unborn. A
repo is **provisioned** only when `repoProvisioned()` finds ≥1 real ref (not just a `HEAD` file),
so a crash mid-synthesis is healed rather than served empty.

**State:** a bare git repo with an immutable `v<semver>` tag and `main` at latest-stable;
`git_published=true`. The skill is now installable.

---

## Phase 5 — Minting the install command (`POST /api/skills/[ns]/[slug]/install`)

Handler: `packages/web/src/app/api/skills/[ns]/[slug]/install/route.ts`.

1. Auth + `enforceRateLimit("install", oid, 30)`; `findSkill` (404 if archived); `isSkillVisible`
   (restricted → 404, never 403, so it can't be probed).
2. **Publish gate** — pinned: version must be `active`, `!gitPublished` → **409**; latest:
   `resolveLatest` over `active && gitPublished` stable versions, none → **409**.
3. **TTL** — `null` = Never; else end-of-day, must be future, capped at `INSTALL_MAX_TTL_DAYS`
   (default 365, +2-day grace).
4. **`mintInstallToken`** (`packages/web/src/lib/installs.ts`):
   - `raw = randomBytes(32).base64url` (only the SHA-256 **hash** is stored).
   - Supersede unclaimed: `delete from tokens where user_id=$1 and skill_id=$2 and type='install' and used_at is null`.
   - `insert into tokens (user_id, type, hashed_token, skill_id, pinned_semver, scope, expires_at) values ($1,'install',$2,$3,$4,$5::jsonb,$6)`.
5. **`buildInstallCommand`** (`packages/shared/src/external-tool.ts` — the single place that knows
   the wire format):
   ```
   npx skills add https://x-access-token:<raw>@<host>/<ns>/<slug>.git[#v<semver>] [--agent <slug>]
   ```
   `<host>` from `SKILLY_REGISTRY_URL`; `#v…` only when pinned (latest omits it → clones `main`);
   `--agent` only for a recognized non-generic harness.

---

## Phase 6 — The clone (`npx skills add` → git smart server)

`npx skills add` runs `git clone --depth 1 --branch <ref>`, sending the embedded credentials as
HTTP Basic auth. The worker git server (`packages/worker/src/git/server.ts`) handles
`GET …/info/refs?service=git-upload-pack` and `POST …/git-upload-pack` (push is always 403).

1. **Auth** — `tokenFromAuthHeader` decodes Basic and takes the password (the token).
2. **`authorizeGitRequest`** (`packages/worker/src/git/authorize.ts:85`):
   - `findSkill` — archived → 404.
   - **`validateToken`** (`pgDeps.ts`): `select … from tokens where hashed_token=$1 and
     type='install' and skill_id is not null and (expires_at is null or expires_at > now())`. Only
     `install`; reusable; expired → rejected.
   - **Scope check** — `scopedSkillId !== skill.id` → 403 (a token for skill A can't clone B).
   - **Namespace visibility** — for `visibility='namespace'`, `resolveAccess(userId)` (groups +
     role_mappings) must satisfy `isSkillVisible`, else 403. **System installations** (SKILLY_SPEC.md
     §23) skip this re-check — no user to check; the platform-admin mint is the deliberate grant.
3. **Provisioned gate** — `repoProvisioned` (≥1 real ref) else **404 "repository not provisioned"**.
4. **Transport** (`packages/worker/src/git/httpBackend.ts`) — spawns the canonical
   **`git http-backend`** CGI, pipes the request body in, streams stdout back; stderr swallowed
   (no credential leakage).
5. **Side effects — on the `/info/refs` advertisement only** (once per clone), when OK:
   - **`markInstallUsed`** (first clone only, via a CTE): stamps `used_at = now()` +
     `client_user_agent` + client IP, deletes the *other unused* install tokens for that skill on
     the same side of the system boundary (personal ↔ personal, system ↔ system). Later clones are
     no-ops (the token stays reusable). Returns whether this was the first use.
   - **`logAccess`** → `select record_git_access($skillId, $userId, $isSystem, $countInstall)`
     (migration 0052): inserts an `access_log` row (`source='git'`, `is_system` for system clones,
     **never credentials**), bumps the adoption/activity counters, and upserts monthly
     `install_counters`. A system installation bumps `install_count` once, on its first clone
     (`$countInstall`), and never writes leaderboard credits.

The files land in the consumer's agent skills folder (e.g. `.agents/skills/`), owned by the
external tool.

---

## State transitions at a glance

| Moment | `skill_versions` | git repo | install token |
|---|---|---|---|
| After upload | — | — | — |
| After accept / direct publish | `active`, `git_published=false` | none | — |
| After worker sweep (~≤60s) | `active`, `git_published=true` | `v<semver>` tag + `main` | — |
| After Install clicked | unchanged | unchanged | `install`, `used_at=null` |
| After first clone | unchanged | unchanged | `used_at` + UA stamped; siblings purged; `install_count++` |

## Invariants enforced along the way

- **Versions are immutable** — strict-increasing semver at materialize; `skill_versions_guard`
  freezes content post-insert (only `status`/`git_published` mutable). See
  [`../SKILLY_SPEC.md`](../SKILLY_SPEC.md) §7/§22 and migration `0039`.
- **The gateway is the only path to bytes** — every clone needs a valid, skill-scoped `install`
  token; restricted skills additionally re-check namespace access at clone time.
- **No credentials in logs** — `access_log` stores `(user, skill, source)` only; git stderr is discarded.
- **Visibility never leaks** — restricted skills return 404 (not 403) at every touchpoint.
- **Roles from SCIM groups, never token claims** — both the web `resolveUserAccess` and the worker
  `resolveAccess`.

---

## Pointer skills (the difference)

A **pointer** skill follows the same path from Phase 3 onward, with one addition: instead of an
uploaded bundle, accept enqueues a `pending_mirrors` row, and the worker's `mirrorPendingVersions`
(run just before `publishPendingVersions`) clones the pinned external ref (or fetches the
skills-hub.ai registry version), scans it, stores it as the canonical artifact, and creates the
`skill_versions` row — after which Phases 4–6 are identical. See
[`../SKILLY_SPEC.md`](../SKILLY_SPEC.md) §6.
