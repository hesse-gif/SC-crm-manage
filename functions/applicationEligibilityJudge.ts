// Task-95 §3 자격 판정 코어 — 신청자 YouTube 구독자 수 기반 승인/반려/사람검토 순수 판정.
// Deterministic, no I/O(네트워크·Firestore 호출 없음) — downstreamEligibilityCore.ts /
// contentSubmissionEligibilityCore.ts 와 같은 스타일(버전 상수 + 순수 함수 + reasonCode).
//
// 자동 승인은 이 파일 밖(설정 플래그, applicationEligibilityJudgeSweep.ts)에서 하드 OFF 다 —
// approve = 코드 발급이 한 트랜잭션이라(TICKET-MAP §3 결정 #5), 코드 발급 시점이 확정되기 전엔
// verdict:"approve" 를 그대로 적용해선 안 된다. 이 파일은 판정만 하고 적용은 호출자 책임이다.

export const APPLICATION_ELIGIBILITY_JUDGE_VERSION = "application_eligibility_judge.v1" as const;

// 26-08-27 운영 확정 100명 기준(REJECT_REASON_OPTIONS/재신청 안내 메일 카피와 동일) — 호출자가
// 넘기는 기본값일 뿐, 순수 함수 자체는 여전히 입력으로만 받는다(하드코딩 없음, 테스트/호출자가
// 자유롭게 오버라이드할 수 있다).
export const APPLICATION_ELIGIBILITY_DEFAULT_MINIMUM_SUBSCRIBERS = 100;

export type ApplicationEligibilityLookupStatus = "ok" | "hidden" | "not_found" | "api_error" | "timeout";

export type ApplicationEligibilityVerdict = "approve" | "reject" | "human_review";

export type ApplicationEligibilityReasonCode =
  | "subscriber_minimum_met"
  // 반려 사유는 기존 포털 반려 사유 3종과 정확히 같은 문자열이다(REJECT_REASON_OPTIONS,
  // login_rejected_subscriber_minimum 메일 매핑이 이 값을 그대로 키로 쓴다) — 이 판정 코어가
  // 만드는 reject verdict 는 언제나 이 코드 하나뿐이다.
  | "subscriber_below_minimum"
  // 아래 5개는 human_review 전용 — 메일 파이프라인과 무관한, 이 판정 코어 내부 코드다.
  | "subscriber_count_hidden"
  | "channel_not_found_pending_review"
  | "subscriber_lookup_api_error"
  | "subscriber_lookup_timeout"
  | "subscriber_count_unavailable"
  // AR-1 [적대적 리뷰 2026-09-17, MEDIUM]: applicationEligibilityJudgeSweep.ts 의 재시도 상한
  // (MAX_TRANSIENT_LOOKUP_ATTEMPTS) 소진 후에만 쓰는 종결 코드. 이 판정 코어(순수 함수)는 여전히
  // 이 코드를 직접 만들지 않는다 — lookupStatus 5종 계약은 그대로이고, 스윕이 재시도 횟수라는
  // 자기(스윕) 상태를 보고 이 코드로 직접 human_review 결과를 조립해 원장에 쓴다.
  | "subscriber_lookup_unavailable_after_retries";

export interface ApplicationEligibilityJudgeInput {
  subscriberCount: number | null;
  hiddenSubscriberCount: boolean;
  lookupStatus: ApplicationEligibilityLookupStatus;
  minimumSubscribers: number;
}

export interface ApplicationEligibilityJudgeEvidence {
  subscriberCount: number | null;
  hiddenSubscriberCount: boolean;
  lookupStatus: ApplicationEligibilityLookupStatus;
  minimumSubscribers: number;
}

export interface ApplicationEligibilityJudgeResult {
  version: typeof APPLICATION_ELIGIBILITY_JUDGE_VERSION;
  verdict: ApplicationEligibilityVerdict;
  reasonCode: ApplicationEligibilityReasonCode;
  evidence: ApplicationEligibilityJudgeEvidence;
}

function result(
  verdict: ApplicationEligibilityVerdict,
  reasonCode: ApplicationEligibilityReasonCode,
  evidence: ApplicationEligibilityJudgeEvidence,
): ApplicationEligibilityJudgeResult {
  return { version: APPLICATION_ELIGIBILITY_JUDGE_VERSION, verdict, reasonCode, evidence };
}

export function judgeApplicationEligibility(
  input: ApplicationEligibilityJudgeInput,
): ApplicationEligibilityJudgeResult {
  const evidence: ApplicationEligibilityJudgeEvidence = {
    subscriberCount: input.subscriberCount,
    hiddenSubscriberCount: input.hiddenSubscriberCount === true,
    lookupStatus: input.lookupStatus,
    minimumSubscribers: input.minimumSubscribers,
  };

  if (input.lookupStatus === "not_found") {
    return result("human_review", "channel_not_found_pending_review", evidence);
  }
  if (input.lookupStatus === "api_error") {
    return result("human_review", "subscriber_lookup_api_error", evidence);
  }
  if (input.lookupStatus === "timeout") {
    return result("human_review", "subscriber_lookup_timeout", evidence);
  }
  // lookupStatus === "hidden" 이거나, (드물게) "ok" 인데 hiddenSubscriberCount 플래그가 선 경우
  // 모두 비공개로 취급한다 — 두 신호가 어긋나면 더 보수적인(사람 검토) 쪽을 따른다.
  if (input.lookupStatus === "hidden" || evidence.hiddenSubscriberCount) {
    return result("human_review", "subscriber_count_hidden", evidence);
  }
  if (input.subscriberCount === null || !Number.isFinite(input.subscriberCount)) {
    return result("human_review", "subscriber_count_unavailable", evidence);
  }
  if (input.subscriberCount >= input.minimumSubscribers) {
    return result("approve", "subscriber_minimum_met", evidence);
  }
  return result("reject", "subscriber_below_minimum", evidence);
}
