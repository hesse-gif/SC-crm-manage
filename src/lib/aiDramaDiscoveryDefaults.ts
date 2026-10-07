export const AI_DRAMA_DISCOVERY_KEYWORDS = [
  "ai microdrama",
  "ai micro drama",
  "ai short drama",
  "ai drama series",
  "ai vertical drama",
  "ai animation",
  "ai anime",
  "ai revenge drama",
  "ai rebirth drama",
  "ai fantasy romance",
  "ai romance fantasy",
  "ai romance drama",
  "ai fantasy drama",
  "ai isekai",
  "ai BL",
  "ai yaoi",
] as const;

export const AI_DRAMA_DISCOVERY_COUNTRIES = ["KR", "CN", "US", "JP"] as const;

export const AI_DRAMA_DISCOVERY_CATEGORIES = [
  "AI microdrama",
  "AI short drama",
  "AI vertical drama",
  "AI animation",
  "AI anime",
  "AI romance fantasy",
] as const;

export const AI_DRAMA_DISCOVERY_TAGS = [
  "AI Drama",
  "Microdrama",
  "Vertical",
  "YouTube",
] as const;

export const AI_DRAMA_MIN_QUALIFYING_VIDEO_VIEWS = 50_000;
export const AI_DRAMA_MIN_QUALIFYING_VIDEO_COUNT = 1;

export function isAiDramaProgramRecord(program: {
  readonly discoveryVertical?: string | null;
  readonly candidateCriteria?: Record<string, unknown> | null;
} | null | undefined): boolean {
  if (program?.discoveryVertical === "ai_drama") return true;
  if (program?.discoveryVertical) return false;
  return program?.candidateCriteria?.discoveryVertical === "ai_drama";
}
