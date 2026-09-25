import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SURVEY_CATALOG_VERSION,
  SURVEY_FEATURES,
  SURVEY_FEATURE_QUESTIONS,
  SURVEY_GENERAL_QUESTIONS,
  SURVEY_QUESTION_ORDER,
  SURVEY_RETIRED_QUESTIONS,
  SURVEY_ROTATING_QUESTIONS,
  SURVEY_FREE_TEXT_MAX,
  SURVEY_SELF_COOLDOWN_DAYS,
  composeSurveyOffer,
  isSurveyEligible,
  isSurveyFallbackDue,
  isSurveyFeature,
  isSurveyOfferExpired,
  isSurveySource,
  parseStoredOffer,
  pickFallbackFeature,
  selfSurveyGate,
  selfSurveyNextAt,
  surveyFeatureQuestions,
  surveyOfferKeys,
  surveyOfferView,
  surveyQuestionText,
  surveyRollWins,
  surveySegment,
  surveyWithheld,
  validateSurveySubmission,
  type StoredSurveyOffer,
  type SurveyUserState,
} from "./survey.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-25T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const user = (over: Partial<SurveyUserState> = {}): SurveyUserState => ({
  status: "active",
  erased: false,
  onboardedAt: ago(60),
  surveysEnabled: true,
  lastShownAt: null,
  ...over,
});

test("catalog integrity: unique keys, labelled features, resolvable retired keys", () => {
  const keys = [...SURVEY_GENERAL_QUESTIONS, ...SURVEY_ROTATING_QUESTIONS, ...SURVEY_FEATURE_QUESTIONS, ...SURVEY_RETIRED_QUESTIONS].map((q) => q.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(SURVEY_GENERAL_QUESTIONS.length, 4);
  assert.equal(SURVEY_FEATURE_QUESTIONS.length, 2);
  assert.equal(SURVEY_QUESTION_ORDER[0], "general.overall");
  const fkeys = SURVEY_FEATURES.map((f) => f.key);
  assert.equal(new Set(fkeys).size, fkeys.length);
  assert.equal(SURVEY_FEATURES.length, 13);
  for (const f of SURVEY_FEATURES) assert.ok(f.label.length > 0);
  for (const q of SURVEY_RETIRED_QUESTIONS) assert.notEqual(surveyQuestionText(q.key), q.key);
  assert.ok(isSurveyFeature("mcp"));
  assert.ok(!isSurveyFeature("nope"));
});

test("question text substitutes the feature label", () => {
  assert.equal(surveyQuestionText("feature.useful", "mcp"), "How useful is the MCP server for your work?");
  assert.equal(surveyQuestionText("feature.ease"), "How easy was this feature to use?");
  assert.equal(surveyQuestionText("unknown.key"), "unknown.key");
});

test("eligibility: switch, status, opt-out, grace period and the 30-day floor", () => {
  assert.equal(isSurveyEligible(user(), true, NOW), true);
  assert.equal(isSurveyEligible(user(), false, NOW), false); // platform switch off
  assert.equal(isSurveyEligible(user({ status: "inactive" }), true, NOW), false);
  assert.equal(isSurveyEligible(user({ erased: true }), true, NOW), false);
  assert.equal(isSurveyEligible(user({ surveysEnabled: false }), true, NOW), false);
  assert.equal(isSurveyEligible(user({ onboardedAt: null }), true, NOW), false); // not onboarded
  assert.equal(isSurveyEligible(user({ onboardedAt: ago(13) }), true, NOW), false); // grace
  assert.equal(isSurveyEligible(user({ onboardedAt: ago(14) }), true, NOW), true);
  assert.equal(isSurveyEligible(user({ lastShownAt: ago(29) }), true, NOW), false); // floor
  assert.equal(isSurveyEligible(user({ lastShownAt: ago(30) }), true, NOW), true);
});

test("fallback: 90 days since the last offer, or since onboarding without one", () => {
  assert.equal(isSurveyFallbackDue(user({ lastShownAt: ago(89) }), NOW), false);
  assert.equal(isSurveyFallbackDue(user({ lastShownAt: ago(90) }), NOW), true);
  assert.equal(isSurveyFallbackDue(user({ lastShownAt: null, onboardedAt: ago(89) }), NOW), false);
  assert.equal(isSurveyFallbackDue(user({ lastShownAt: null, onboardedAt: ago(91) }), NOW), true);
  assert.equal(isSurveyFallbackDue(user({ lastShownAt: null, onboardedAt: null }), NOW), false);
});

test("the roll wins one time in three", () => {
  assert.equal(surveyRollWins(() => 0), true);
  assert.equal(surveyRollWins(() => 0.33), true);
  assert.equal(surveyRollWins(() => 0.34), false);
  assert.equal(surveyRollWins(() => 0.99), false);
});

test("offer composition: general + rotating + feature, and the no-feature fallback", () => {
  const withFeature = composeSurveyOffer("feature", "install", () => 0);
  assert.equal(withFeature.catalogVersion, SURVEY_CATALOG_VERSION);
  assert.equal(withFeature.rotating, SURVEY_ROTATING_QUESTIONS[0]!.key);
  assert.deepEqual(surveyOfferKeys(withFeature), ["general.overall", "general.discovery", "general.trust", "general.recommend", withFeature.rotating, "feature.useful", "feature.ease"]);
  const last = composeSurveyOffer("visit", null, () => 0.9999);
  assert.equal(last.rotating, SURVEY_ROTATING_QUESTIONS[SURVEY_ROTATING_QUESTIONS.length - 1]!.key);
  assert.equal(surveyOfferKeys(last).length, 5);

  const shownAt = ago(1);
  const view = surveyOfferView(withFeature, shownAt);
  assert.deepEqual(view.feature, { key: "install", label: "installing a skill" });
  assert.equal(view.questions.filter((q) => q.section === "feature").length, 2);
  assert.match(view.questions.at(-1)!.text, /installing a skill/);
  assert.equal(view.expiresAt, new Date(shownAt.getTime() + 30 * DAY).toISOString());
});

test("fallback feature: a used catalog feature, or none", () => {
  assert.equal(pickFallbackFeature([], () => 0), null);
  assert.equal(pickFallbackFeature(["bogus"], () => 0), null);
  assert.equal(pickFallbackFeature(["search", "follow"], () => 0.99), "follow");
});

test("stored offers: parse round-trip, other catalog versions dropped, expiry at 30 days", () => {
  const o = composeSurveyOffer("feature", "mcp", () => 0.5);
  assert.deepEqual(parseStoredOffer(JSON.parse(JSON.stringify(o))), o);
  assert.equal(parseStoredOffer({ ...o, catalogVersion: SURVEY_CATALOG_VERSION + 1 }), null);
  assert.equal(parseStoredOffer({ ...o, feature: "bogus" }), null);
  assert.equal(parseStoredOffer({ ...o, rotating: "general.overall" }), null);
  assert.equal(parseStoredOffer(null), null);
  assert.equal(isSurveyOfferExpired(ago(29), NOW), false);
  assert.equal(isSurveyOfferExpired(ago(30), NOW), true);
});

test("submission validation: keys against the offer, star range, empty and the text cap", () => {
  const offer: StoredSurveyOffer = composeSurveyOffer("feature", "search", () => 0);
  const ok = validateSurveySubmission(offer, { answers: { "general.overall": 4, "feature.ease": 2 }, freeText: "  nice  ", via: "menu" });
  assert.deepEqual(ok, { ok: true, answers: { "general.overall": 4, "feature.ease": 2 }, freeText: "nice", via: "menu", feature: "search" });
  // Text alone is enough; via defaults to popup.
  assert.deepEqual(validateSurveySubmission(offer, { freeText: "just text" }), { ok: true, answers: {}, freeText: "just text", via: "popup", feature: "search" });
  assert.equal(validateSurveySubmission(offer, { answers: {}, freeText: "   " }).ok, false); // nothing answered
  assert.equal(validateSurveySubmission(offer, { answers: { "general.overall": 0 } }).ok, false);
  assert.equal(validateSurveySubmission(offer, { answers: { "general.overall": 6 } }).ok, false);
  assert.equal(validateSurveySubmission(offer, { answers: { "general.overall": 2.5 } }).ok, false);
  // A rotating key the offer did not pick, and a feature key on a no-feature offer.
  const other = SURVEY_ROTATING_QUESTIONS.find((q) => q.key !== offer.rotating)!.key;
  assert.equal(validateSurveySubmission(offer, { answers: { [other]: 3 } }).ok, false);
  const noFeature = composeSurveyOffer("visit", null, () => 0);
  assert.equal(validateSurveySubmission(noFeature, { answers: { "feature.useful": 3 } }).ok, false);
  assert.equal(validateSurveySubmission(offer, { answers: [] }).ok, false);
  // The cap counts characters (code points), not UTF-16 units.
  assert.equal(validateSurveySubmission(offer, { freeText: "😀".repeat(SURVEY_FREE_TEXT_MAX) }).ok, true);
  assert.equal(validateSurveySubmission(offer, { freeText: "x".repeat(SURVEY_FREE_TEXT_MAX + 1) }).ok, false);
});

test("eligibility: no random roll while an on-demand offer is open (§36.16)", () => {
  assert.equal(isSurveyEligible(user({ selfOfferOpen: true }), true, NOW), false);
  assert.equal(isSurveyEligible(user({ selfOfferOpen: false }), true, NOW), true);
});

test("on-demand gate: platform switch, status and the 7-day cooldown; nothing else (§36.16)", () => {
  const u = (over: Partial<{ status: string; erased: boolean; selfShownAt: Date | null }> = {}) => ({ status: "active", erased: false, selfShownAt: null, ...over });
  assert.deepEqual(selfSurveyGate(u(), true, NOW), { ok: true });
  assert.deepEqual(selfSurveyGate(u(), false, NOW), { ok: false, error: "surveys_off" });
  assert.deepEqual(selfSurveyGate(u({ status: "inactive" }), true, NOW), { ok: false, error: "inactive" });
  assert.deepEqual(selfSurveyGate(u({ erased: true }), true, NOW), { ok: false, error: "inactive" });
  const six = selfSurveyGate(u({ selfShownAt: ago(6) }), true, NOW);
  assert.equal(six.ok, false);
  assert.equal(!six.ok && six.error, "cooldown");
  assert.equal(!six.ok && six.nextAt?.toISOString(), new Date(ago(6).getTime() + SURVEY_SELF_COOLDOWN_DAYS * DAY).toISOString());
  assert.deepEqual(selfSurveyGate(u({ selfShownAt: ago(7) }), true, NOW), { ok: true });
  // The gate has no opt-out / grace / 30-day-floor inputs at all: those are bypassed by design.
  assert.equal(selfSurveyNextAt(null, NOW), null);
  assert.equal(selfSurveyNextAt(ago(8), NOW), null);
});

test("on-demand offers: no feature, general questions only, 7-day expiry (§36.16)", () => {
  const o = composeSurveyOffer("self", null, () => 0);
  assert.deepEqual(parseStoredOffer(JSON.parse(JSON.stringify(o))), o);
  assert.equal(parseStoredOffer({ ...o, feature: "search" }), null); // a self offer never stores a feature
  const shownAt = ago(1);
  const view = surveyOfferView(o, shownAt);
  assert.equal(view.trigger, "self");
  assert.equal(view.feature, null);
  assert.equal(view.questions.length, 5);
  assert.ok(view.questions.every((q) => q.section === "general"));
  assert.equal(view.expiresAt, new Date(shownAt.getTime() + 7 * DAY).toISOString());
  assert.equal(isSurveyOfferExpired(ago(6), NOW, "self"), false);
  assert.equal(isSurveyOfferExpired(ago(7), NOW, "self"), true);
  assert.deepEqual(surveyFeatureQuestions("mcp").map((q) => q.text), ["How useful is the MCP server for your work?", "How easy was the MCP server to use?"]);
});

test("submission validation with a picked feature (§36.16)", () => {
  const self = composeSurveyOffer("self", null, () => 0);
  // Required for a self offer.
  assert.equal(validateSurveySubmission(self, { answers: { "general.overall": 3 } }).ok, false);
  // General only.
  assert.deepEqual(validateSurveySubmission(self, { answers: { "general.overall": 3 }, feature: null }), { ok: true, answers: { "general.overall": 3 }, freeText: null, via: "popup", feature: null });
  // Feature keys are accepted only once a feature is picked.
  assert.equal(validateSurveySubmission(self, { answers: { "feature.useful": 3 }, feature: null }).ok, false);
  const picked = validateSurveySubmission(self, { answers: { "feature.useful": 3 }, feature: "follow" });
  assert.equal(picked.ok && picked.feature, "follow");
  // Unknown feature.
  assert.equal(validateSurveySubmission(self, { answers: { "general.overall": 3 }, feature: "bogus" }).ok, false);
  // Rejected for the random triggers, even as null.
  const random = composeSurveyOffer("feature", "search", () => 0);
  assert.equal(validateSurveySubmission(random, { answers: { "general.overall": 3 }, feature: "search" }).ok, false);
  assert.equal(validateSurveySubmission(random, { answers: { "general.overall": 3 }, feature: null }).ok, false);
  assert.equal(validateSurveySubmission(composeSurveyOffer("visit", null, () => 0), { answers: { "general.overall": 3 }, feature: null }).ok, false);
});

test("source filter values", () => {
  assert.ok(isSurveySource("prompted"));
  assert.ok(isSurveySource("self"));
  assert.ok(!isSurveySource("all"));
});

test("segment: admin outranks maintainer outranks consumer", () => {
  assert.equal(surveySegment({ isPlatformAdmin: true, isNamespaceAdmin: false, maintainsSkills: true }), "admin");
  assert.equal(surveySegment({ isPlatformAdmin: false, isNamespaceAdmin: true, maintainsSkills: false }), "admin");
  assert.equal(surveySegment({ isPlatformAdmin: false, isNamespaceAdmin: false, maintainsSkills: true }), "maintainer");
  assert.equal(surveySegment({ isPlatformAdmin: false, isNamespaceAdmin: false, maintainsSkills: false }), "consumer");
});

test("withholding: fewer than 5 responses", () => {
  assert.equal(surveyWithheld(0), true);
  assert.equal(surveyWithheld(4), true);
  assert.equal(surveyWithheld(5), false);
});
