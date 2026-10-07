// Task-94 갭①: YouTube Data API v3 `contentDetails.duration`(ISO8601 "PT#H#M#S")를 초 단위로
// 파싱한다. R5(20초 미만 반려)가 durationSeconds 를 알아야 판정할 수 있는데, 지금까지 아무
// producer 도 이 필드를 채우지 않아 R5 는 항상 unknown 이었다 — 이 모듈이 그 원문 파서다.
// 순수 함수(I/O 없음). youtubeEnrichmentService.parseIso8601DurationSeconds 와 달리 파싱
// 실패/부재를 0 이 아니라 null("모른다")로 구분한다: 자동반려 판정에서 "0초 영상"과
// "duration 필드 자체가 없음"을 섞으면 메타데이터 부재를 20초 미만으로 오판할 수 있다.
const ISO8601_DURATION_PATTERN =
  /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

export function parseYouTubeDurationSecondsOrNull(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = ISO8601_DURATION_PATTERN.exec(trimmed);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  // "P" alone (or any other match with every component group missing) is not a real duration —
  // treat it the same as unparseable rather than inventing a 0-second observation.
  if (days === undefined && hours === undefined && minutes === undefined && seconds === undefined) {
    return null;
  }
  return Math.round(
    (Number(days ?? 0) * 24 * 60 * 60) +
    (Number(hours ?? 0) * 60 * 60) +
    (Number(minutes ?? 0) * 60) +
    Number(seconds ?? 0),
  );
}
