// W62e [독립 델타 구조 권고] — chat 읽음 처리 "무장 판정"의 정본.
//
// 왜 모듈로 뺐나: W62c 의 렌더 기반 테스트가 **판정 로직을 테스트 안에 복제**해서 검증했다.
// 복제 모델은 페이지와 갈릴 수 있고, 갈리는 순간 테스트는 green 인데 화면은 틀린다 —
// 이 라운드가 고친 결함(소스 계약이 green 인 채로 stale closure 를 통과시킨 것)과 같은 형상이다.
// 페이지와 테스트가 **같은 함수를 import** 하면 그 갭이 원리적으로 사라진다.
//
// 이 모듈은 순수하다: Firestore·React·전역 시각에 의존하지 않는다.

export type ChatReadArmingConversation = {
  readonly unread: number;
  readonly updatedAtIso?: string | null;
};

/**
 * 대화의 **세대 키**. 안읽음 수와 갱신 시각으로 만든다.
 *
 * 영구 Set 을 쓰면 한 번 읽음 처리한 대화에 **새 메시지가 와도 다시 안 찍는다** — 안읽음이 다시
 * 쌓였는데 화면만 조용해진다. 세대가 바뀌면 다시 무장하는 것이 목적이고, 그래서 키는 반드시
 * **대화 상태에서 파생**돼야 한다(상수면 영구 Set 과 같아진다).
 */
export function chatReadGenerationKey(conversation: ChatReadArmingConversation): string {
  return `${conversation.unread}:${String(conversation.updatedAtIso ?? "")}`;
}

/**
 * 지금 이 대화를 읽음 처리해야 하는가.
 *
 * 세 조건이 모두 참일 때만 참이다:
 *   ① 대화가 실재한다 — 클릭 시점의 key 로 찾은 결과다(이전 렌더의 값이 아니다)
 *   ② 안읽음이 남아 있다 — 없으면 무의미한 쓰기다
 *   ③ 이 세대에서 아직 처리하지 않았다 — 같은 세대 중복 호출을 막는다
 *
 * ①이 핵심이다: 종전에는 렌더 시점의 conv 를 클로저로 잡아, 선택이 없던 첫 클릭에서 undefined 로
 * 이탈하면서도 "처리함" 기록만 남겨 **그 대화가 영영 안 찍혔다.**
 */
export function shouldArmChatRead(
  conversation: ChatReadArmingConversation | undefined,
  recordedGeneration: string | undefined,
): boolean {
  if (!conversation) return false;
  if (conversation.unread <= 0) return false;
  return recordedGeneration !== chatReadGenerationKey(conversation);
}
