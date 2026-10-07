// Flu — enrollment journey 근거 수집 정본 (U7 P4, 2026-07-27). 순수 함수만, **신규 읽기 0**.
//
// 배경(실측): 같은 인물의 Journey 가 관리 상세 6건 vs 파트너 상세 2건으로 갈렸다. 원인은 두 화면이
// "어떤 타임스탬프가 어떤 단계의 근거인가"를 각자 정해 두었기 때문이다:
//   - 관리 상세(`managementProfileTabsPorts.fetchJourney`)는 `onboarding_sent` / `content_submitted` /
//     `video_reviewed` 를 어휘로 **선언만** 하고 실제로는 한 건도 발행하지 않았다.
//   - 파트너 상세는 온보딩/검수 근거를 자체 폴백 체인으로 읽어 `onboarding` / `video_submitted` /
//     `video_approved` 를 발행했다.
//
// 그래서 근거 **수집 규칙**(어떤 문서의 어떤 필드를 어떤 순서로 읽는지)만 여기 한 벌로 모은다.
// 단계 이름(어휘)은 각 화면의 기존 계약을 그대로 둔다 — 어휘 확장 금지.
//
// 이 모듈은 Firestore 를 읽지 않는다. 호출자가 이미 읽어 둔 행을 넘긴다.

export interface JourneyEvidence {
  /** 근거 시각(ISO). 없으면 근거가 없는 것이며 호출자는 이벤트를 만들지 않는다. */
  readonly occurredAtIso: string;
  /** 근거 컬렉션/문서 출처. 화면이 "무엇 때문에 이 단계가 찍혔는지" 밝힐 때 쓴다. */
  readonly sourceRef: string;
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function firstIso(row: Record<string, unknown> | null | undefined, fields: readonly string[]): string {
  if (!row) return "";
  for (const field of fields) {
    const value = text(row[field]);
    if (value) return value;
  }
  return "";
}

/** 온보딩 발송 근거: 발송 시각 → 갱신 시각. 세대(generation) 행 중 가장 이른 근거를 쓴다. */
export function onboardingSentEvidence(
  onboardingRows: readonly (Record<string, unknown> | null | undefined)[],
): JourneyEvidence | null {
  const candidates = onboardingRows
    .map((row) => firstIso(row, ["sentAtIso", "deliveredAtIso", "updatedAtIso", "createdAtIso"]))
    .filter((value) => value.length > 0)
    .sort();
  const occurredAtIso = candidates[0] ?? "";
  return occurredAtIso ? { occurredAtIso, sourceRef: "scp_onboarding_outbox" } : null;
}

/** 콘텐츠 제출 근거: 리비전 제출 시각 정본 → 생성 시각. 판정으로 바뀌는 updatedAtIso 는 쓰지 않는다. */
export function contentSubmittedEvidence(
  review: Record<string, unknown> | null | undefined,
): JourneyEvidence | null {
  const occurredAtIso = firstIso(review, ["currentRevisionSubmittedAtIso", "submittedAtIso", "createdAtIso"]);
  return occurredAtIso ? { occurredAtIso, sourceRef: "scp_video_review_state" } : null;
}

/** 검수 판정 근거: 판정 시각이 있을 때만. 제출 시각을 판정 시각으로 승격하지 않는다. */
export function videoReviewedEvidence(
  review: Record<string, unknown> | null | undefined,
): JourneyEvidence | null {
  const occurredAtIso = firstIso(review, ["reviewedAtIso", "decidedAtIso", "approvedAtIso"]);
  return occurredAtIso ? { occurredAtIso, sourceRef: "scp_video_review_state" } : null;
}

/** 활성화 증거의 승인 시각(파트너 상세가 쓰던 근거) — 같은 규칙을 관리 상세도 쓸 수 있게 노출한다. */
export function videoApprovedEvidence(
  activationEvidence: Record<string, unknown> | null | undefined,
): JourneyEvidence | null {
  const occurredAtIso = firstIso(activationEvidence, ["approvedAtIso", "decidedAtIso"]);
  return occurredAtIso ? { occurredAtIso, sourceRef: "scp_partner_activations" } : null;
}
