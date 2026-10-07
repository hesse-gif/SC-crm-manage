// R15-3: 자격심사 판정 상태 해석의 **정본**. 예전에는 검수 화면(ReviewWorkspace)과 대시보드
// (dashboard-pipeline)가 각자 다른 규칙을 들고 있었다 — 화면은 10개 필드 + 한국어 정규화, 대시보드는
// 3개 필드 + 정규화 없음. 그래서 한국어("합격"/"불합격")로 판정됐거나 `decision`/`판정` 필드에 판정이
// 저장된 리드가 대시보드에서만 **영구히 "판정 대기"** 로 잡혔다(배지 숫자도 함께 틀렸다).
// 규칙을 한 곳에 두고 양쪽이 import 한다 — 주석으로 "같다"고 적는 것과 실제로 같은 것은 다르다.
export type QualificationStatus = "pass" | "fail" | "hold" | "unreviewed";

/**
 * 판정이 저장될 수 있는 필드 — **순서가 우선순위**다(앞의 필드가 비어 있을 때만 다음을 본다).
 * 시트 유입 리드는 한국어 헤더(`비고`/`판정`/`결과`)에 판정이 들어오는 경우가 있어 함께 본다.
 */
export const QUALIFICATION_STATUS_FIELDS = [
  "qualificationStatus",
  "finalVerdict",
  "qualificationResult",
  "result",
  "decision",
  "status",
  "reviewStatus",
  "비고",
  "판정",
  "결과",
] as const;

function statusText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function normalizeQualificationStatus(raw: unknown): QualificationStatus {
  // 런타임 입력은 문서에서 오므로 문자열이 아닐 수 있다 — 판정기가 throw 하면 화면 전체가 죽는다.
  const value = statusText(raw).toLowerCase();
  if (!value) return "unreviewed";
  if (value === "pass" || value === "approved" || /^(합격|통과|승인|pass|approved)$/i.test(value)) return "pass";
  if (value === "fail" || value === "rejected" || /불합격|탈락|반려|거절|모집대상아님|fail|reject/i.test(value)) return "fail";
  if (value === "hold" || /보류|대기|pending|hold|needs[_ -]?review/i.test(value)) return "hold";
  return "unreviewed";
}

/** 행(리드 문서·투영 레코드)에서 판정 상태를 읽는다. 필드가 하나도 없으면 `unreviewed`. */
export function qualificationStatusOf(row: Record<string, unknown>): QualificationStatus {
  const raw = QUALIFICATION_STATUS_FIELDS.map((field) => statusText(row[field])).find(Boolean) ?? "";
  return normalizeQualificationStatus(raw);
}

/**
 * 사람 판단이 남아 있는가. 확정은 합격/불합격 둘뿐이고 `hold`·`unreviewed` 는 대기다
 * (검수 화면의 `isQualificationPending` 과 같은 경계).
 */
export function isQualificationPendingStatus(status: QualificationStatus): boolean {
  return status !== "pass" && status !== "fail";
}
