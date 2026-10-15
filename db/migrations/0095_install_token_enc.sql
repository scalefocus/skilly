-- Recoverable install commands (SKILLY_SPEC.md §23 "Show install URL", §22).
--
--   tokens.token_enc   the raw `install` token, AES-256-GCM-encrypted under the env
--                      INSTALL_TOKEN_ENC_KEY ("v1:<iv>:<tag>:<ct>", the same format as the §12 email
--                      and §40 AI tokens). Written by the web app at mint time — personal AND system
--                      installs — so the owner (or, for a system install, any platform admin; audited)
--                      can re-show the install command from the Installed page. Never logged, never in
--                      audit payloads, never returned over MCP, and never read by the git gateway:
--                      hashed_token stays the ONLY validation path.
--
-- NULL = not revealable: every row minted before this migration (only its hash exists), every row
-- minted while INSTALL_TOKEN_ENC_KEY was unset, and all `marketplace` tokens (§30, out of scope).
-- No backfill — a hash cannot be reversed.
--
-- No grant changes: the app role already owns INSERT/SELECT/UPDATE on tokens (0029).
BEGIN;

ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS token_enc TEXT;

COMMIT;
