// renderNotification for §72.6: a platform admin deleted a namespace the recipient administered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNotification, notificationBodySentence } from "./deliver.js";

test("renderNotification: namespace.deleted names the actor, the namespace and the reason, with no CTA", () => {
  process.env.PUBLIC_BASE_URL = "https://skilly.test";
  const r = renderNotification({
    type: "namespace.deleted",
    payload: { namespaceSlug: "team-a", displayName: "Team A", actorName: "Pat Admin", reason: "Merged into team-b." },
  });
  assert.equal(r.subject, "Skilly - Namespace deleted");
  assert.equal(
    r.text,
    "Pat Admin deleted the namespace Team A (@team-a). Its role mappings, shares and marketplace were removed. Reason: Merged into team-b.",
  );
  // No call-to-action: the namespace has no page any more.
  assert.doesNotMatch(r.text, /\[|https?:/);
  assert.equal(r.webhook.namespace, "team-a");
  assert.equal(r.webhook.reason, "Merged into team-b.");
  assert.equal(r.webhook.event, "namespace.deleted");
});

test("renderNotification: namespace.deleted without a reason omits the reason sentence", () => {
  const text = notificationBodySentence({ type: "namespace.deleted", payload: { namespaceSlug: "team-a", displayName: "Team A", actorName: "Pat Admin", reason: null } });
  assert.equal(text, "Pat Admin deleted the namespace Team A (@team-a). Its role mappings, shares and marketplace were removed.");
});
