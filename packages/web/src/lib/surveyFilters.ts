// Query-string parsing for the admin survey results endpoints (SKILLY_SPEC.md §36.10).
import { isSurveyFeature, isSurveySegment } from "@skilly/shared/survey";
import { parseRumRange } from "./rum/queries";
import type { SurveyFilters } from "./survey";

export function parseSurveyFilters(sp: URLSearchParams): SurveyFilters {
  const segment = sp.get("segment");
  const feature = sp.get("feature");
  return {
    range: parseRumRange(sp.get("range"), 30),
    segment: isSurveySegment(segment) ? segment : null,
    feature: isSurveyFeature(feature) ? feature : null,
  };
}
