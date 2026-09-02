import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAINTAINER_CONTACT_MAX,
  normalizeMaintainerContact,
  isMaintainerContact,
  maintainerContactError,
} from "./contact.js";

test("normalize trims, and empty becomes null (clearing the contact)", () => {
  assert.equal(normalizeMaintainerContact("  team@example.com "), "team@example.com");
  assert.equal(normalizeMaintainerContact(""), null);
  assert.equal(normalizeMaintainerContact("   "), null);
  assert.equal(normalizeMaintainerContact(null), null);
  assert.equal(normalizeMaintainerContact(undefined), null);
});

test("clearing is always allowed — §30.6", () => {
  assert.equal(maintainerContactError(""), null);
  assert.equal(maintainerContactError("   "), null);
  assert.equal(maintainerContactError(null), null);
  assert.equal(maintainerContactError(undefined), null);
});

test("accepts real addresses, including shared mailboxes and distribution lists", () => {
  for (const ok of [
    "team@example.com",
    "platform-engineering@example.com",
    "skills.owners@example.co.uk",
    "a@b.io",
    "first.last+skilly@sub.domain.example.org",
    "KRASIMIR.KOSTADINOV@Example.COM",
    "dl_platform_emea@corp.example.com",
    "o'brien@example.com",
    "user!name#tag$%&'*+-/=?^_`{|}~@example.com",
  ]) {
    assert.equal(isMaintainerContact(ok), true, `expected valid: ${ok}`);
    assert.equal(maintainerContactError(ok), null, `expected no error: ${ok}`);
  }
});

test("rejects what would land in a marketplace manifest as an invalid owner.email", () => {
  for (const bad of [
    "ask the team",           // prose — the case this exists to stop
    "team",                   // bare word
    "team@",                  // no domain
    "@example.com",           // no local part
    "team@example",           // no TLD
    // Single-label domains are deliberately refused: `team@corp` is RFC-valid and does route on
    // some intranets, but it is indistinguishable from the far commoner typo (`team@exampl`), and
    // as `owner.email` in a marketplace manifest (§30.3) it would publish an address most clients
    // outside that intranet cannot reach. A documented trade-off, not an oversight.
    "team@org",
    "team@example.c",         // 1-char TLD
    "team@example..com",      // empty domain label
    "team@.example.com",      // leading dot
    "a b@example.com",        // whitespace in the local part
    "team@exa mple.com",      // whitespace in the domain
    "team@@example.com",      // two @
    "team@example.com, other@example.com", // a list, not an address
    "team@example.com; other@example.com",
    "<team@example.com>",     // angle-bracketed display form
    "Team <team@example.com>",
    "mailto:team@example.com",
  ]) {
    assert.equal(isMaintainerContact(bad), false, `expected invalid: ${bad}`);
    assert.equal(maintainerContactError(bad), "maintainer contact must be an email address, or empty", `expected error: ${bad}`);
  }
});

test("length is capped at the RFC 5321 forward-path limit", () => {
  const domain = "@example.com";
  const atLimit = "a".repeat(MAINTAINER_CONTACT_MAX - domain.length) + domain;
  assert.equal(atLimit.length, MAINTAINER_CONTACT_MAX);
  assert.equal(maintainerContactError(atLimit), null);

  const overLimit = "a".repeat(MAINTAINER_CONTACT_MAX - domain.length + 1) + domain;
  assert.equal(isMaintainerContact(overLimit), false);
  assert.equal(maintainerContactError(overLimit), `maintainer contact must be at most ${MAINTAINER_CONTACT_MAX} characters`);
});

test("the error message is the one both the browser and the API surface", () => {
  // The client disables Save on this string and the API returns it verbatim in a 422 body,
  // so it must stay a single shared constant expression — not two similar sentences.
  assert.equal(maintainerContactError("nope"), maintainerContactError("also nope"));
});
