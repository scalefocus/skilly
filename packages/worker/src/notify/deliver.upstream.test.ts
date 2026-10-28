// renderNotification for upstream release alerts (SKILLY_SPEC.md §63.5, §63.6): the new
// `skill.upstream_release` type, and the second "Propose the update" CTA on branch drift only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationBodySentence, renderNotification } from "./deliver.js";

const BASE = "https://skilly.test";

test("renderNotification: skill.upstream_release names both refs and opens the pre-filled form", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "skill.upstream_release",
    payload: { namespaceSlug: "team-a", skillSlug: "pdf", currentRef: "v1.2.0", releaseRef: "v2.0.0", bump: "major" },
  });
  assert.equal(r.subject, "Skilly - Upstream release available");
  assert.equal(
    r.text,
    `team-a/pdf pins v1.2.0. Upstream has released v2.0.0. [Propose the update](${BASE}/propose?newVersion=1&ns=team-a&slug=pdf&upstreamRef=v2.0.0&upstreamKind=release&bump=major)`,
  );
  assert.equal(r.webhook.releaseRef, "v2.0.0");
  assert.equal(
    notificationBodySentence({ type: "skill.upstream_release", payload: { namespaceSlug: "team-a", skillSlug: "pdf", currentRef: "v1.2.0", releaseRef: "v2.0.0" } }),
    "team-a/pdf pins v1.2.0. Upstream has released v2.0.0.",
  );
});

test("renderNotification: branch drift adds Propose the update; tag drift and pre-§63 rows don't", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const branch = renderNotification({ type: "skill.drift", payload: { namespaceSlug: "team-a", skillSlug: "pdf", ref: "main", pinKind: "branch" } });
  assert.match(branch.text, /\[Review it\]\(https:\/\/skilly\.test\/skills\/team-a\/pdf\) \[Propose the update\]\(https:\/\/skilly\.test\/propose\?newVersion=1&ns=team-a&slug=pdf&upstreamRef=main&upstreamKind=branch\)$/);
  assert.equal(branch.webhook.proposeUrl, `${BASE}/propose?newVersion=1&ns=team-a&slug=pdf&upstreamRef=main&upstreamKind=branch`);

  const tag = renderNotification({ type: "skill.drift", payload: { namespaceSlug: "team-a", skillSlug: "pdf", ref: "v1.0.0", pinKind: "semver_tag" } });
  assert.doesNotMatch(tag.text, /Propose the update/);
  assert.equal(tag.webhook.proposeUrl, undefined);

  const legacy = renderNotification({ type: "skill.drift", payload: { namespaceSlug: "team-a", skillSlug: "pdf", ref: "main" } });
  assert.doesNotMatch(legacy.text, /Propose the update/);
});
