// Task-91 확장 ②: 분류된 SCP 문의 유형별로 "시스템 정본 값"만 골라 채운다. 값이 없거나 확신이
// 안 서면 절대 지어내지 않고 facts:null 로 사람에게 넘긴다(하드 룰: fail-closed).
//
// 이 파일은 순수 함수만 담는다 — firebase-admin 등 런타임 의존성이 전혀 없다
// (tests/scp-inquiry-fact-resolver.test.mjs 가 에뮬레이터 없이 ts.transpileModule 로 직접
// 로드한다). Firestore 조회(scp_application_management / scp_video_review_state)는 여기서
// 하지 않는다 — 호출부(functions/chat-ai.ts, "wire into the casebook/permit path" 작업)가
// 이미 알고 있는 컬렉션 상수·순수 요약 함수(videoReviewHistorySummary.summarizeVideoReviewLedger
// 등)를 그대로 써서 스냅샷을 읽어온 뒤 이 모듈의 resolveScpInquiryFactsFromSnapshots 에 넘긴다 —
// 같은 Firestore 조회 로직이 두 곳에 따로 생기는 것을 피한다.
//
// `import type` 만 쓰는 이유: scpInquiryClassifier.ts 도 런타임 의존성이 없는 순수 모듈이라
// type-only import 는 트랜스파일 시 완전히 지워진다(ts.transpileModule 의 isolatedModules
// 동작) — data: URL import 가 상대 경로를 못 찾는 문제를 피한다.

import { createHash } from "node:crypto";
import type { ScpInquiryType } from "./scpInquiryClassifier";

export type ScpInquiryFacts = Readonly<Record<string, string>>;

export type ScpInquiryFactResolverResult = {
  readonly facts: ScpInquiryFacts | null;
  readonly sourceRefs: readonly string[];
  readonly resolvedAtIso: string;
  readonly fingerprint: string;
  /** facts 가 null 일 때만 채워진다 — 사람에게 "왜 자동화하지 않았는지" 설명하는 용도. */
  readonly reason: string | null;
};

export type ScpApplicationClassification = "managed" | "unclassified" | "ambiguous" | "conflict";

// 호출부가 scp_application_management/{applicationId} 문서에서 이미 뽑아온 값만 받는다 —
// Firestore 필드명을 여기서 다시 해석하지 않는다.
export type ResolvedApplicationSnapshot = {
  readonly ref: string;
  readonly classification: ScpApplicationClassification;
  readonly manageInbox: boolean;
  readonly revoked: boolean;
  readonly currentProgramId: string | null;
  readonly submittedAtIso: string | null;
};

export type ScpVideoReviewState =
  | "queued"
  | "in_review"
  | "changes_requested"
  | "human_review_required"
  | "rejected"
  | "approved";

// 호출부가 scp_video_review_state/{docId} 문서 + videoReviewHistorySummary.summarizeVideoReviewLedger
// 결과에서 이미 뽑아온 값만 받는다.
export type ResolvedReviewSnapshot = {
  readonly ref: string;
  readonly state: ScpVideoReviewState;
  readonly lastDeclineReasonCode: string | null;
  readonly declines: number;
  readonly approvals: number;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// 지문 스킴 버전. facts/sourceRefs 해시 페이로드가 바뀌면 반드시 올린다 — 이전 버전으로 큐에
// 쌓인 지문은 새 스킴과 절대 일치하지 않으므로 발송 직전 재검증이 fail-closed 로 멈춘다
// (조용히 리셋/재발송하지 않는다).
const FINGERPRINT_VERSION = "scp_inquiry_facts:v2";

/** sourceRefs 를 canonical 화한다: 중복 제거 후 사전순 정렬. 순서·중복에 흔들리지 않는다. */
function canonicalSourceRefs(sourceRefs: readonly string[]): string[] {
  return Array.from(new Set(sourceRefs)).sort();
}

const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** 값이 실재하는 ISO-8601 타임스탬프인지 구조+달력 범위까지 검사한다(지어내지 않기 위한 게이트).
 * 오프셋 표기까지 허용하되 2월 30일 같은 롤오버 값은 거부한다. */
function isIsoTimestamp(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return false;
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > lastDayOfMonth) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (!Number.isFinite(Date.parse(value))) return false;
  return true;
}

/** facts(키 정렬) + sourceRefs(canonical 정렬·중복제거) 를 버전 태그와 함께 해시한다.
 * - facts:null 은 "값 없음" 마커로 해시해 안정적인 지문을 갖는다(발송 시점 재검증이
 *   "null → null" 을 "변경 없음"으로 구분할 수 있게).
 * - sourceRefs 기본값은 빈 배열이라 facts:null 경로는 빈 refs 로 안정적으로 유지된다.
 * - 같은 facts 라도 근거 문서(ref)가 달라지면 지문이 달라진다 — 동일 facts 치환 레코드가
 *   재검증을 통과해 버리는 구멍을 막는다. */
export function scpInquiryFactFingerprint(
  facts: ScpInquiryFacts | null,
  sourceRefs: readonly string[] = [],
): string {
  const canonicalFacts = facts
    ? Object.keys(facts)
        .sort()
        .map((key) => [key, facts[key]] as const)
    : null;
  return sha256Hex(
    JSON.stringify({
      version: FINGERPRINT_VERSION,
      facts: canonicalFacts,
      sourceRefs: canonicalSourceRefs(sourceRefs),
    }),
  );
}

function applicationStatusFacts(application: ResolvedApplicationSnapshot): ScpInquiryFacts {
  return {
    classification: application.classification,
    manageInbox: String(application.manageInbox),
    revoked: String(application.revoked),
    ...(application.currentProgramId ? { currentProgramId: application.currentProgramId } : {}),
    // submittedAtIso 는 스냅샷에 실재하는 값일 때만 싣는다 — 지어내지 않는다. 유효하지
    // 않거나 없으면 키 자체를 생략해 verified/received 상태가 근거 시각을 대조할 수 있게 한다.
    ...(isIsoTimestamp(application.submittedAtIso)
      ? { submittedAtIso: application.submittedAtIso }
      : {}),
  };
}

function reviewResultFacts(review: ResolvedReviewSnapshot): ScpInquiryFacts {
  return {
    state: review.state,
    lastDeclineReasonCode: review.lastDeclineReasonCode ?? "none",
    declines: String(review.declines),
    approvals: String(review.approvals),
  };
}

/**
 * 유형별로 시스템 정본 스냅샷 → facts 매핑. **절대 값을 지어내지 않는다**:
 * - application_status: application 스냅샷이 없으면 facts:null.
 * - review_result: review 스냅샷이 없으면 facts:null.
 * - creator_code: Task-92(코드 시트 동기화) 선행 전까지 Flu 에 코드 정본이 없다 — 항상 facts:null.
 * - settlement: Flu 는 정산 원장을 보유하지 않는다(정산 마트는 외부 inhouse-tool 소유) — 항상 facts:null.
 * - other: 지원하지 않는 문의 유형 — 항상 facts:null.
 */
export function resolveScpInquiryFactsFromSnapshots(input: {
  readonly type: ScpInquiryType;
  readonly nowIso: string;
  readonly application: ResolvedApplicationSnapshot | null;
  readonly review: ResolvedReviewSnapshot | null;
}): ScpInquiryFactResolverResult {
  const resolvedAtIso = input.nowIso;

  if (input.type === "application_status") {
    if (!input.application) {
      return {
        facts: null,
        sourceRefs: [],
        resolvedAtIso,
        fingerprint: scpInquiryFactFingerprint(null),
        reason: "application_record_not_found",
      };
    }
    const facts = applicationStatusFacts(input.application);
    return {
      facts,
      sourceRefs: [input.application.ref],
      resolvedAtIso,
      fingerprint: scpInquiryFactFingerprint(facts, [input.application.ref]),
      reason: null,
    };
  }

  if (input.type === "review_result") {
    if (!input.review) {
      return {
        facts: null,
        sourceRefs: [],
        resolvedAtIso,
        fingerprint: scpInquiryFactFingerprint(null),
        reason: "review_result_source_unavailable",
      };
    }
    const facts = reviewResultFacts(input.review);
    return {
      facts,
      sourceRefs: [input.review.ref],
      resolvedAtIso,
      fingerprint: scpInquiryFactFingerprint(facts, [input.review.ref]),
      reason: null,
    };
  }

  if (input.type === "creator_code") {
    return {
      facts: null,
      sourceRefs: [],
      resolvedAtIso,
      fingerprint: scpInquiryFactFingerprint(null),
      reason: "code_source_pending_task_92",
    };
  }

  if (input.type === "settlement") {
    return {
      facts: null,
      sourceRefs: [],
      resolvedAtIso,
      fingerprint: scpInquiryFactFingerprint(null),
      reason: "no_source_of_truth_in_flu",
    };
  }

  return {
    facts: null,
    sourceRefs: [],
    resolvedAtIso,
    fingerprint: scpInquiryFactFingerprint(null),
    reason: "unsupported_inquiry_type",
  };
}
