// The feedback survey (SKILLY_SPEC.md §36) — the versioned question catalog, the feature catalog
// and the pure rules both the API and the browser apply: eligibility, the roll, offer composition,
// submission validation, the respondent segment and the minimum-group withholding. Client-safe
// (no node imports): the survey card and the admin results section import it via
// `@skilly/shared/survey`.

/** Bumped on ANY catalog change (§36.3). An open offer for another version is dropped on read. */
export const SURVEY_CATALOG_VERSION = 1;

/** §36.1 an eligible trigger wins 1 time in this many. */
export const SURVEY_ROLL_ODDS = 3;
/** §36.1 no new offer sooner than this after the last one was shown. */
export const SURVEY_FLOOR_DAYS = 30;
/** §36.1 no survey in a user's first days after onboarding. */
export const SURVEY_GRACE_DAYS = 14;
/** §36.1 with no offer for this long, any full page load may roll (the long-time-user fallback). */
export const SURVEY_FALLBACK_DAYS = 90;
/** §36.3 the free-text cap, in characters (code points — what Postgres char_length counts). */
export const SURVEY_FREE_TEXT_MAX = 2000;
/** §36.9 any figure over fewer than this many responses is withheld. */
export const SURVEY_MIN_GROUP = 5;

/** §36.10 per-user, per-minute request budgets. */
export const SURVEY_FEATURE_USED_RATE_PER_MIN = 120;
export const SURVEY_CHECK_RATE_PER_MIN = 30;
export const SURVEY_SUBMIT_RATE_PER_MIN = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export type SurveyTrigger = "feature" | "visit";
export type SurveySegment = "consumer" | "maintainer" | "admin";
export type SurveyVia = "popup" | "menu";
export const SURVEY_SEGMENTS: readonly SurveySegment[] = ["consumer", "maintainer", "admin"];

// ---- the feature catalog (§36.3) -----------------------------------------------------------------

export const SURVEY_FEATURES = [
  { key: "search", label: "catalog search" },
  { key: "install", label: "installing a skill" },
  { key: "propose", label: "proposing a skill" },
  { key: "review", label: "reviewing proposals" },
  { key: "request", label: "requesting a skill" },
  { key: "messaging", label: "messaging" },
  { key: "mcp", label: "the MCP server" },
  { key: "marketplaces", label: "plugin marketplaces" },
  { key: "rating", label: "rating skills" },
  { key: "share_link", label: "share links" },
  { key: "achievements", label: "achievements" },
  { key: "leaderboard", label: "the leaderboard" },
  { key: "follow", label: "following people" },
] as const;

export type SurveyFeatureKey = (typeof SURVEY_FEATURES)[number]["key"];

const FEATURE_KEYS = new Set<string>(SURVEY_FEATURES.map((f) => f.key));

export function isSurveyFeature(v: unknown): v is SurveyFeatureKey {
  return typeof v === "string" && FEATURE_KEYS.has(v);
}

export function surveyFeatureLabel(key: string): string {
  return SURVEY_FEATURES.find((f) => f.key === key)?.label ?? key;
}

// ---- the question catalog (§36.3) ----------------------------------------------------------------

export interface SurveyQuestionDef {
  key: string;
  /** `{feature}` is substituted with the feature label for the feature questions. */
  text: string;
}

export const SURVEY_GENERAL_QUESTIONS: readonly SurveyQuestionDef[] = [
  { key: "general.overall", text: "Overall, how satisfied are you with skilly?" },
  { key: "general.discovery", text: "How easy is it to find the skills you need?" },
  { key: "general.trust", text: "How much do you trust the quality of the skills in the catalog?" },
  { key: "general.recommend", text: "How likely are you to recommend skilly to a colleague?" },
];

export const SURVEY_ROTATING_QUESTIONS: readonly SurveyQuestionDef[] = [
  { key: "rotating.performance", text: "How happy are you with how fast skilly feels?" },
  { key: "rotating.look", text: "How much do you like the way skilly looks and feels?" },
  { key: "rotating.docs", text: "How helpful are Quick start and the in-app guidance?" },
  { key: "rotating.install", text: "How smooth is getting a skill into your tools?" },
];

export const SURVEY_FEATURE_QUESTIONS: readonly SurveyQuestionDef[] = [
  { key: "feature.useful", text: "How useful is {feature} for your work?" },
  { key: "feature.ease", text: "How easy was {feature} to use?" },
];

/** Keys no longer asked. Their answers stay in the results, tagged "retired" (§36.9). */
export const SURVEY_RETIRED_QUESTIONS: readonly SurveyQuestionDef[] = [];

/** Every current key, in catalog order: general, rotating, feature. */
export const SURVEY_QUESTION_ORDER: readonly string[] = [
  ...SURVEY_GENERAL_QUESTIONS,
  ...SURVEY_ROTATING_QUESTIONS,
  ...SURVEY_FEATURE_QUESTIONS,
].map((q) => q.key);

const ALL_DEFS = new Map<string, SurveyQuestionDef>(
  [...SURVEY_GENERAL_QUESTIONS, ...SURVEY_ROTATING_QUESTIONS, ...SURVEY_FEATURE_QUESTIONS, ...SURVEY_RETIRED_QUESTIONS].map((q) => [q.key, q]),
);

export function isRetiredQuestion(key: string): boolean {
  return SURVEY_RETIRED_QUESTIONS.some((q) => q.key === key);
}

/** A question's display text. Without a feature, a feature question reads "this feature". */
export function surveyQuestionText(key: string, feature?: string | null): string {
  const def = ALL_DEFS.get(key);
  if (!def) return key;
  return def.text.replace("{feature}", feature ? surveyFeatureLabel(feature) : "this feature");
}

// ---- eligibility and the roll (§36.1) ------------------------------------------------------------

export interface SurveyUserState {
  status: string;
  erased: boolean;
  onboardedAt: Date | null;
  surveysEnabled: boolean;
  lastShownAt: Date | null;
}

/** Every §36.1 eligibility condition except `canShow`, which only the browser knows. */
export function isSurveyEligible(u: SurveyUserState, platformEnabled: boolean, now: Date): boolean {
  if (!platformEnabled || u.status !== "active" || u.erased || !u.surveysEnabled) return false;
  if (!u.onboardedAt || now.getTime() - u.onboardedAt.getTime() < SURVEY_GRACE_DAYS * DAY_MS) return false;
  return !u.lastShownAt || now.getTime() - u.lastShownAt.getTime() >= SURVEY_FLOOR_DAYS * DAY_MS;
}

/** §36.1 the visit fallback: 90 days since the last offer, or since onboarding when there was none. */
export function isSurveyFallbackDue(u: Pick<SurveyUserState, "onboardedAt" | "lastShownAt">, now: Date): boolean {
  const since = u.lastShownAt ?? u.onboardedAt;
  return !!since && now.getTime() - since.getTime() >= SURVEY_FALLBACK_DAYS * DAY_MS;
}

/** One 1-in-3 roll. `rng` returns [0, 1) like Math.random (injectable for tests). */
export function surveyRollWins(rng: () => number = Math.random): boolean {
  return rng() * SURVEY_ROLL_ODDS < 1;
}

// ---- offers (§36.2 / §36.10) ---------------------------------------------------------------------

/** The open offer as stored in `users.survey_offer`. Its shown time is `survey_last_shown_at`. */
export interface StoredSurveyOffer {
  catalogVersion: number;
  trigger: SurveyTrigger;
  feature: SurveyFeatureKey | null;
  rotating: string;
  closed: boolean;
}

/** The offer as the browser receives it (questions resolved server-side). */
export interface SurveyOfferView {
  catalogVersion: number;
  trigger: SurveyTrigger;
  feature: { key: string; label: string } | null;
  questions: { key: string; text: string; section: "general" | "feature" }[];
  shownAt: string;
  expiresAt: string;
}

function pick<T>(items: readonly T[], rng: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))]!;
}

export function composeSurveyOffer(trigger: SurveyTrigger, feature: SurveyFeatureKey | null, rng: () => number = Math.random): StoredSurveyOffer {
  return { catalogVersion: SURVEY_CATALOG_VERSION, trigger, feature, rotating: pick(SURVEY_ROTATING_QUESTIONS, rng).key, closed: false };
}

/** §36.1 the fallback's feature: a random one the user has already used, or none. */
export function pickFallbackFeature(used: readonly string[], rng: () => number = Math.random): SurveyFeatureKey | null {
  const known = used.filter(isSurveyFeature);
  return known.length > 0 ? pick(known, rng) : null;
}

/** Parse a stored offer; null for anything malformed or from another catalog version. */
export function parseStoredOffer(raw: unknown): StoredSurveyOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.catalogVersion !== SURVEY_CATALOG_VERSION) return null;
  if (o.trigger !== "feature" && o.trigger !== "visit") return null;
  if (o.feature !== null && !isSurveyFeature(o.feature)) return null;
  if (typeof o.rotating !== "string" || !SURVEY_ROTATING_QUESTIONS.some((q) => q.key === o.rotating)) return null;
  return { catalogVersion: SURVEY_CATALOG_VERSION, trigger: o.trigger, feature: o.feature as SurveyFeatureKey | null, rotating: o.rotating, closed: o.closed === true };
}

export function surveyOfferExpiresAt(shownAt: Date): Date {
  return new Date(shownAt.getTime() + SURVEY_FLOOR_DAYS * DAY_MS);
}

export function isSurveyOfferExpired(shownAt: Date, now: Date): boolean {
  return now.getTime() >= surveyOfferExpiresAt(shownAt).getTime();
}

/** The keys an offer asks, in display order. */
export function surveyOfferKeys(offer: StoredSurveyOffer): string[] {
  return [
    ...SURVEY_GENERAL_QUESTIONS.map((q) => q.key),
    offer.rotating,
    ...(offer.feature ? SURVEY_FEATURE_QUESTIONS.map((q) => q.key) : []),
  ];
}

export function surveyOfferView(offer: StoredSurveyOffer, shownAt: Date): SurveyOfferView {
  return {
    catalogVersion: offer.catalogVersion,
    trigger: offer.trigger,
    feature: offer.feature ? { key: offer.feature, label: surveyFeatureLabel(offer.feature) } : null,
    questions: surveyOfferKeys(offer).map((key) => ({
      key,
      text: surveyQuestionText(key, offer.feature),
      section: key.startsWith("feature.") ? "feature" : "general",
    })),
    shownAt: shownAt.toISOString(),
    expiresAt: surveyOfferExpiresAt(shownAt).toISOString(),
  };
}

// ---- submissions (§36.6) -------------------------------------------------------------------------

export type SurveySubmission =
  | { ok: true; answers: Record<string, number>; freeText: string | null; via: SurveyVia }
  | { ok: false; error: string };

/** Trimmed free text, or null when empty. Does not enforce the cap. */
export function normalizeSurveyText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

/** Validate a submission body against the open offer. Nothing answered is an error. */
export function validateSurveySubmission(offer: StoredSurveyOffer, body: unknown): SurveySubmission {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const allowed = new Set(surveyOfferKeys(offer));
  const answers: Record<string, number> = {};
  const raw = b.answers ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "answers must be an object" };
  for (const [key, stars] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) return { ok: false, error: `unknown question: ${key}` };
    if (typeof stars !== "number" || !Number.isInteger(stars) || stars < 1 || stars > 5) return { ok: false, error: `stars for ${key} must be 1-5` };
    answers[key] = stars;
  }
  if (b.freeText !== undefined && b.freeText !== null && typeof b.freeText !== "string") return { ok: false, error: "freeText must be a string" };
  const freeText = normalizeSurveyText(b.freeText);
  if (freeText && [...freeText].length > SURVEY_FREE_TEXT_MAX) return { ok: false, error: `freeText is limited to ${SURVEY_FREE_TEXT_MAX} characters` };
  if (Object.keys(answers).length === 0 && !freeText) return { ok: false, error: "answer at least one question" };
  const via: SurveyVia = b.via === "menu" ? "menu" : "popup";
  return { ok: true, answers, freeText, via };
}

// ---- segment and withholding (§36.6 / §36.9) -----------------------------------------------------

export function surveySegment(a: { isPlatformAdmin: boolean; isNamespaceAdmin: boolean; maintainsSkills: boolean }): SurveySegment {
  if (a.isPlatformAdmin || a.isNamespaceAdmin) return "admin";
  return a.maintainsSkills ? "maintainer" : "consumer";
}

export function isSurveySegment(v: unknown): v is SurveySegment {
  return v === "consumer" || v === "maintainer" || v === "admin";
}

/** §36.9 is a figure over `n` responses withheld? */
export function surveyWithheld(n: number): boolean {
  return n < SURVEY_MIN_GROUP;
}
