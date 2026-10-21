// Why a `PUT /api/admin/ai` pointing at a spec's loopback stub provider cannot be taken by this dev
// server — the AI specs skip with that reason instead of failing the save. Two causes are expected:
//   - no AI_TOKEN_ENC_KEY on the server (409 ai_key_missing — the card is disabled, §40);
//   - the §49.11 egress guard refusing a private/loopback base URL (422 ai_base_url_private) because
//     AI_ALLOW_PRIVATE_BASE_URL=1 is not set — ci/e2e-run.sh and the Playwright webServer set it.
import type { APIResponse } from "@playwright/test";

export const AI_KEY_MISSING = "AI_TOKEN_ENC_KEY is not set on the dev server";
export const AI_STUB_PRIVATE =
  "the stub provider listens on 127.0.0.1 and the dev server refuses private base URLs — set AI_ALLOW_PRIVATE_BASE_URL=1 on it";

/** The skip reason for a refused stub save, or null when the server took it (or failed for another reason). */
export async function aiSaveSkipReason(saved: APIResponse): Promise<string | null> {
  if (saved.status() === 409) return AI_KEY_MISSING;
  if (saved.status() === 422 && (await saved.text()).includes('"ai_base_url_private"')) return AI_STUB_PRIVATE;
  return null;
}
