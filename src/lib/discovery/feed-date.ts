// P8 N/10 "오늘 생성" 배지(A10): UI 노출 규칙(diversifyFeedItems) 적용 후 남은 피드
// 항목 중 오늘(KST) createdAtIso로 처음 생성된 항목만 센다. activityRefresh/scpApprovedFeed
// 쓰기 경로가 createdAt(Iso)을 문서 최초 생성 시 1회만 스탬프하므로, updatedAtIso만 오늘인
// 재기록(merge refresh) 항목은 여기서 자연스럽게 제외된다 — 소스 정규식이 아니라 실제
// write 계약에 의존하는 행위 기반 판정.
//
// 이 파일은 (feed-order.ts와 마찬가지로) path-alias import가 없는 순수 모듈이다 —
// Node 테스트 러너의 타입 스트리핑으로 직접 import해 행위 기반 단위 테스트가 가능하게
// feed.ts에서 분리했다.
const SEOUL_TIME_ZONE = "Asia/Seoul";
const SEOUL_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: SEOUL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function seoulDateKey(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : SEOUL_DATE_FORMATTER.format(date);
}

export function isFeedItemNewOnDate(createdAtIso: string | undefined, targetDateKey: string): boolean {
  if (!createdAtIso || !targetDateKey) return false;
  return seoulDateKey(createdAtIso) === targetDateKey;
}

export function countNewFeedItems<T>(
  items: readonly T[],
  getCreatedAtIso: (item: T) => string | undefined,
  now: Date | string | number = new Date(),
): number {
  const todayKey = seoulDateKey(now);
  return items.reduce((count, item) => count + (isFeedItemNewOnDate(getCreatedAtIso(item), todayKey) ? 1 : 0), 0);
}
