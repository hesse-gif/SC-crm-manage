// W120 [적대 리뷰 C2]: 반려/변경요청 메일 문안 드래프트의 순수 상태 계산기.
//
// 편집창 구현(현재는 자유 텍스트 textarea, 향후 사유 태그 조립 검토 중)이 바뀌어도 이 규칙은
// 그대로 재사용된다. **와이어 포맷은 계속 문자열 하나**다 — 여기서 문장을 파싱하거나 텍스트로
// 분기하지 않는다(서버·아웃박스·렌더가 자유 텍스트 전제를 더 깊게 굳히지 않게).
import {
  REVIEW_REASON_CODE_MAIL_PRESETS,
  reviewReasonCodeMailPreset,
} from "./statusLabels";

/** 손대지 않은 프리셋 문안 집합. 이 안의 값은 사유 코드가 바뀌면 갈아끼워도 잃는 게 없다. */
export const PRESET_MAIL_MESSAGES: ReadonlySet<string> = new Set(
  Object.values(REVIEW_REASON_CODE_MAIL_PRESETS).filter((text) => text.length > 0),
);

/**
 * W121: 사유 태그 트레이 재정렬(드래그한 키 → 목표 자리). 메일 불릿 순서가 곧 이 배열 순서다.
 *
 * 순수 함수로 둔 이유는 위 규칙들과 같다 — 네이티브 HTML5 드래그 이벤트 배선이 바뀌어도 "무엇이
 * 어디로 가는가"는 이 규칙 하나이고, 노드 레인이 React 없이 직접 검증한다.
 * 없는 키·범위 밖 인덱스는 배열을 흔들지 않는다(드롭 타깃이 사라진 뒤 도착한 이벤트).
 */
export function moveReasonTagKey(
  keys: readonly string[],
  fromKey: string,
  toIndex: number,
): string[] {
  const next = [...keys];
  const from = next.indexOf(fromKey);
  if (from < 0) return next;
  const bounded = Math.max(0, Math.min(next.length - 1, Math.trunc(toIndex)));
  if (from === bounded) return next;
  next.splice(from, 1);
  next.splice(bounded, 0, fromKey);
  return next;
}

/**
 * 사유 코드가 바뀔 때 남아야 하는 문안.
 * 운영자가 직접 쓴 문장(프리셋과 다른 값)은 지키고, 비었거나 프리셋 그대로면 새 프리셋으로 간다.
 */
export function nextDraftMessage(currentMessage: string, nextReasonCode: string): string {
  const trimmed = currentMessage.trim();
  if (trimmed && !PRESET_MAIL_MESSAGES.has(trimmed)) return currentMessage;
  return reviewReasonCodeMailPreset(nextReasonCode);
}

/**
 * 검수 대상이 바뀌었을 때(행 선택·판정 확정 직후)의 초기 드래프트.
 *
 * **무조건** 초기화다 — 이전 크리에이터에게 쓰던 값이 다음 검수 대상에 남으면 그대로 발송된다.
 *   · 문장이 남으면 A 의 문안이 B 에게 나간다(적대 리뷰 C2).
 *   · 발송 스위치가 남으면 A 에서 끈 상태가 B 까지 이어져 **B 는 통지를 아예 못 받는다**
 *     (적대 리뷰 R2 — 같은 계열, 방향만 반대). 그래서 스위치도 여기서 함께 복원한다.
 *   · W121: 사유 태그도 같은 계열이다 — A 의 AI 판정 근거로 고른 태그가 B 에게 남으면
 *     **B 와 무관한 사유**가 그대로 발송된다(C2 와 완전히 같은 사고, 축만 다르다).
 */
export function resetDraftForRow(reasonCode: string): {
  reasonCode: string;
  message: string;
  notifyCreator: boolean;
  reasonTagKeys: string[];
} {
  return {
    reasonCode,
    message: reviewReasonCodeMailPreset(reasonCode),
    notifyCreator: true,
    reasonTagKeys: [],
  };
}
