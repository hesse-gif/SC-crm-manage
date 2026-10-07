// Task-100 §4 "일일 슬랙 백로그 리포트에 한 줄 추가" — videoReviewBacklogReport.ts 와 같은 채널·
// 같은 실패 격리 규약(집계 쿼리만, 문서 미열람, 절대 던지지 않음)으로 한 줄만 덧붙인다.
// 별도 파일인 이유: formatVideoReviewBacklogSection 은 순수 함수라 시그니처를 넓히면 그 함수를
// 직접 쓰는 기존 테스트/호출부가 전부 갈린다 — 호출부(slackScheduledReportsHandler)에서 문자열
// 뒤에 이어 붙이는 쪽이 더 작은 변경이다.

import { adminDb } from "./firebaseAdmin";
import { VIDEO_RESUBMISSION_CYCLE_COLLECTION } from "./videoResubmissionCycleCore";

export async function resubmissionCycleAwaitingCount(
  db: FirebaseFirestore.Firestore = adminDb,
): Promise<number> {
  const snapshot = await db
    .collection(VIDEO_RESUBMISSION_CYCLE_COLLECTION)
    .where("status", "==", "awaiting_resubmission")
    .count()
    .get();
  return Number(snapshot.data().count ?? 0);
}

export function formatResubmissionCycleBacklogLine(awaitingCount: number): string {
  return `• 재제출 대기(반려 후 미재제출): ${awaitingCount.toLocaleString("ko-KR")}건`;
}

/** 실패 격리: 이 한 줄 산출이 죽어도 백로그 섹션 나머지는 그대로 나가야 한다. */
export async function buildResubmissionCycleBacklogLineSafe(
  db?: FirebaseFirestore.Firestore,
): Promise<string> {
  try {
    const count = await resubmissionCycleAwaitingCount(db);
    return formatResubmissionCycleBacklogLine(count);
  } catch {
    return "• 재제출 대기(반려 후 미재제출): 측정 불가";
  }
}
