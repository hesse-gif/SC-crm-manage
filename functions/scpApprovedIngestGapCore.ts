// Flu/Task-37 — 순수 분류 로직: 승인된 SCP 크리에이터가 왜 Flu ingest(대시보드 스냅샷) 성공
// 이력이 없는지 사유를 매긴다. Firestore/네트워크 의존 없음(테스트: tests/scp-approved-
// ingest-gap.test.mjs).
//
// 사유 판정 근거 — 티켓이 제시한 3갈래 후보 원인 각각의 신호:
//  ① 포털 apply 레인 Flu 신원 미발행 → scp_portal_creator_bindings 문서 부재/비활성
//     (identity_not_provisioned, 결정적 신호 — 코드로 확정 가능).
//  ② 8/25~8/28 시트 싱크 중단 → 코드로 직접 확정할 수단이 없다(시트 싱크와 신원 발행은 별개
//     시스템). identity_not_provisioned 인 행 중 승인 시각이 그 창(KST) 안이면 "의심" 힌트만
//     덧붙인다(suspectedSheetSyncGap) — 사유 자체를 바꾸지 않는다. 추측을 사실처럼 올리지 않는다.
//  ③ 8/27 일괄승인 21건의 flu_http_400 거절 → 원장(scpDashboardIngestLedger)의 마지막 시도가
//     outcome "rejected"(재시도 불가 4xx/5xx 최종 거절)면 command_rejected, "exhausted"(재시도
//     가능 오류를 다 소진)면 delivery_retry_exhausted — 둘 다 원장에 실제 기록이 쌓여야 나온다.
//
// 원장에 아무 시도도 없고 신원도 있으면 ingest_never_attempted — 오늘 기준 프로덕션에 이
// 파이프라인을 트리거하는 곳이 없으므로(functions/scpDashboardIngestLedger.ts 상단 주석) 이
// 값이 압도적 다수일 것으로 예상된다. 그 자체가 이 티켓의 핵심 발견이다.

export const INGEST_GAP_REASON_CODES = [
  "identity_not_provisioned",
  "command_rejected",
  "delivery_retry_exhausted",
  "ingest_never_attempted",
] as const;

export type IngestGapReasonCode = (typeof INGEST_GAP_REASON_CODES)[number];

// 8/25~8/28 KST 시트 싱크 중단 의심 구간. KST = UTC+9 이므로 8/25 00:00 KST == 8/24 15:00 UTC.
export const SHEET_SYNC_OUTAGE_WINDOW_UTC = {
  startIso: "2026-08-24T15:00:00.000Z", // 2026-08-25T00:00:00+09:00
  endIso: "2026-08-28T15:00:00.000Z", // 2026-08-29T00:00:00+09:00 (배타적 상한)
} as const;

export function isWithinSheetSyncOutageWindow(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const start = Date.parse(SHEET_SYNC_OUTAGE_WINDOW_UTC.startIso);
  const end = Date.parse(SHEET_SYNC_OUTAGE_WINDOW_UTC.endIso);
  return t >= start && t < end;
}

export type IngestGapLastAttempt = {
  outcome: "accepted" | "duplicate" | "rejected" | "exhausted";
  atIso: string;
  httpStatus: number;
  code: string;
  requestId: string;
} | null;

export type IngestGapClassificationInput = {
  bindingActive: boolean;
  approvedAtIso: string | null;
  lastSuccessAtIso: string | null;
  lastAttempt: IngestGapLastAttempt;
};

export type IngestGapClassification = {
  reasonCode: IngestGapReasonCode;
  suspectedSheetSyncGap: boolean;
};

// null 반환 = 이 크리에이터는 gap이 아니다(성공 이력이 있음 — 목록에서 제외해야 한다).
export function classifyIngestGap(input: IngestGapClassificationInput): IngestGapClassification | null {
  if (input.lastSuccessAtIso) return null;

  const suspectedSheetSyncGap = isWithinSheetSyncOutageWindow(input.approvedAtIso);

  if (!input.bindingActive) {
    return { reasonCode: "identity_not_provisioned", suspectedSheetSyncGap };
  }

  if (input.lastAttempt) {
    if (input.lastAttempt.outcome === "exhausted") {
      return { reasonCode: "delivery_retry_exhausted", suspectedSheetSyncGap: false };
    }
    if (input.lastAttempt.outcome === "rejected") {
      return { reasonCode: "command_rejected", suspectedSheetSyncGap: false };
    }
  }

  // suspectedSheetSyncGap 힌트는 identity_not_provisioned 에만 붙는다(위 header 주석 ②) — 여기서
  // 계산된 값을 그대로 흘리면 "신원은 있는데 시도만 없다"는 사실과 무관한 시간창 추측이 섞인다.
  return { reasonCode: "ingest_never_attempted", suspectedSheetSyncGap: false };
}
