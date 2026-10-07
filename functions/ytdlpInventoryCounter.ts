/**
 * W77-⑤ — **미발송 상비 재고 관측.**
 *
 * 목표는 "이메일 보유 + 콜드 미발송" 후보 **1만 명 상시 유지**다.
 *
 * ■ R1 REJECT 를 받고 설계를 바꿨다 — 증분 카운터를 버렸다
 *   처음에는 델타 원장(+이메일 생성 / −발송)을 직접 굴렸다. 리뷰가 실측으로 무너뜨렸다:
 *     · +1 이 **주 경로**(About 이메일 → campaign_candidates persist)에 없어 거의 안 오른다.
 *     · −1 이 creatorKey 루프 안이라 발송 1회에 최대 3회 깎인다.
 *     · 감소 축이 6종(수신거부·반송·영구실패·CRM 삭제·archive·demo) 빠지고,
 *       발송 우회 경로도 3종(sent_evidence_pending 조기반환·admin 인라인 dedup·scpOutreach 콜드) 빠졌다.
 *     · `Math.max(0, ...)` 이 음수 표류를 은닉해 "영구 0" 보고를 만들었다.
 *   즉 전이를 **전수 배선하는 방식 자체**가 이 시스템에서 성립하지 않는다. 배선 하나 빠질 때마다
 *   숫자가 조용히 틀리고, 틀렸다는 사실조차 안 보인다.
 *
 * ■ 그래서 이미 같은 문제에 도달한 SoT 를 재사용한다
 *   `measureCandidatePoolInventory`(admin.ts)는 R23-1 → BLOCKER-1 → BLOCKER-A 를 거치며
 *   **액추에이터가 실제로 쓰는 컬렉션**과 **발송 경로가 실제로 쓰는 dedup 키**에 맞춰진 센서다:
 *     이 캠페인의 campaign_candidates(이메일 보유) − 이 프로그램의 dedup 이메일 컨택 − blocked 타깃
 *   aggregate count 3회로 끝나 문서를 훑지 않는다(전수 대조 비용 문제도 같이 해결된다).
 *   같은 축을 두 번 만들면 반드시 갈라진다 — 새 원장을 만들지 않고 이걸 읽는다.
 *
 * ■ 이 파일이 하는 일
 *   목표(1만) 대비 진행률로 환산하고, 스윕이 매 pass 구조화 로그로 남길 형태를 만든다.
 *   상태를 저장하지 않으므로 표류가 없고, 따라서 "언제 기준인지"도 항상 지금이다.
 */

/** 헤세 확정 목표 — 진행률 분모다. */
export const YTDLP_UNSENT_INVENTORY_TARGET = 10_000;

export type YtdlpUnsentInventory = {
  /** 이메일 보유 + 콜드 미발송 추정치(SoT sendableEstimate). */
  readonly unsentWithEmail: number;
  /** 목표 대비 진행률(0~1). */
  readonly progress: number;
  /** 분해값 — 진행률이 왜 그 값인지 설명 없이 숫자만 보고하지 않는다. */
  readonly emailCapable: number;
  readonly contactedByEmail: number;
  readonly blockedTargets: number;
};

/**
 * SoT 측정값을 재고 보고 형태로 환산한다(순수 함수).
 *
 * 클램프를 여기서 다시 걸지 않는다 — SoT 가 이미 음수를 0으로 접는다. 이중 클램프는
 * "왜 0인지"를 두 곳에 흩어 놓아 원인 추적을 어렵게 만든다.
 */
export function toUnsentInventory(measurement: {
  readonly emailCapable: number;
  readonly contactedByEmail: number;
  readonly blockedTargets: number;
  readonly sendableEstimate: number;
}): YtdlpUnsentInventory {
  const unsentWithEmail = Math.trunc(Number(measurement.sendableEstimate) || 0);
  return {
    unsentWithEmail,
    progress: Math.min(1, Math.max(0, unsentWithEmail / YTDLP_UNSENT_INVENTORY_TARGET)),
    emailCapable: Math.trunc(Number(measurement.emailCapable) || 0),
    contactedByEmail: Math.trunc(Number(measurement.contactedByEmail) || 0),
    blockedTargets: Math.trunc(Number(measurement.blockedTargets) || 0),
  };
}
