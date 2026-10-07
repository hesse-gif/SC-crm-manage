// R17-3③: 캠페인 자동 보충(refill) pass 의 마지막 결과를 카드 표면용으로 투영한다.
//
// T4 가 campaigns 문서에 `lastRefillAtIso` · `lastRefillCounts` · `lastRefillErrorCode` 를 남기게
// 만들었지만 **UI 소비자가 0건**이었다 — 운영자 화면에서는 여전히 "왜 안 차는지"를 볼 수 없었고,
// 그게 T4 를 만든 이유 자체였다. 새 데이터셋 키를 만들지 않고 기존 campaigns 문서 읽기 경로에
// 이미 실려 오는 필드만 쓴다.
//
// 표시 판정을 순수함수로 뽑는 이유: 표면 존재를 소스 문자열로 검사하는 가드는 이 레포에서 세 번
// 우회됐다. 판정은 진리표로, 표시값은 이 함수의 반환값에 묶어 단정한다.

export type CampaignRefillOutcome = "ok" | "error";

export type CampaignRefillStage = "none" | "refill" | "approval";

export type CampaignRefillStatus = {
  /** 보충이 한 번도 돌지 않았으면 표면을 내지 않는다(빈 카드 = 노이즈). */
  visible: boolean;
  atIso: string;
  outcome: CampaignRefillOutcome;
  /** 실패 사유. 성공이면 빈 문자열. */
  reason: string;
  /**
   * R18: 어느 단계에서 막혔는지. 보충은 성공했는데 **승인이 매 tick 튕겨** 행이 영구 잼인 상태가
   * 실재한다(R17-4 회귀). 그때 lastRefillErrorCode 는 null 이라, 보충 사유만 보면 카드가 "성공"
   * 배지를 띄운다 — 관측 표면이 잼을 성공으로 보고하면 없느니만 못하다.
   */
  stage: CampaignRefillStage;
  counts: { key: string; label: string; value: number }[];
  /**
   * R21-3: 발굴 쿼터 수확 상태. 전 키 소진이면 발굴이 **다음 리셋까지 대기**하는데, 그 사실이 화면에
   * 없으면 운영자에게는 또 "조용한 정체" 다(R20 과 같은 결).
   */
  quota: null | {
    waitingForReset: boolean;
    remainingUnitsEstimate: number;
    nextResetIso: string;
    resultLimit: number | null;
    label: string;
  };
  /**
   * R23-2d: 발굴 잡별 신선율(newUnique) 텔레메트리 — R20 lastRefillCounts 패턴과 같은 이유다.
   * candidatesWritten(merge 포함)만 보이면 "24건 적재했다"는 숫자가 전부 이미 알려진 후보 재적재여도
   * 성공처럼 보인다(R23-2b 가 고친 근인과 같은 클래스의 오판). 마지막 완료된 발굴 잡의 newUnique 를
   * candidatesWritten 과 나란히 보여줘 그 차이를 값으로 드러낸다.
   */
  discovery: null | {
    atIso: string;
    newUnique: number;
    candidatesWritten: number;
    label: string;
  };
};

/** T4 가 쓰는 단계 카운트의 표시 이름. 모르는 키는 키 그대로 보여준다(삼키지 않는다). */
const REFILL_COUNT_LABELS: Record<string, string> = {
  scannedRaw: "스캔",
  emailReady: "이메일 확보",
  sendable: "발송 가능",
  alreadyTouchedSkipped: "기접촉 제외",
  safetyQuarantinedSkipped: "안전 격리 제외",
  safetyQuarantineReadBatches: "격리 조회 배치",
  safetyQuarantineFallbackFailed: "격리 폴백 실패",
  safetyQuarantineLoopDetected: "격리 루프 감지",
  emailIncapableDeprioritized: "이메일불가 후순위",
  suppressedSkipped: "suppression 제외",
  duplicateRecipientSkipped: "중복 수신자 제외",
  deliverabilityCachedSkipped: "도달성 캐시 제외",
  selected: "선별",
  shortfall: "부족",
};

const EMPTY: CampaignRefillStatus = { visible: false, atIso: "", outcome: "ok", reason: "", stage: "none", counts: [], quota: null, discovery: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function campaignRefillStatus(campaign: unknown): CampaignRefillStatus {
  if (!isRecord(campaign)) return EMPTY;
  const refillAtIso = typeof campaign.lastRefillAtIso === "string" ? campaign.lastRefillAtIso.trim() : "";
  const approvalAtIso = typeof campaign.lastApprovalAtIso === "string" ? campaign.lastApprovalAtIso.trim() : "";
  // R19-3: 가시성 게이트를 보충 시각 하나에만 걸면, persistRefillOutcome 이 돌지 않는 캠페인
  // (autoRefillEnabled=false 인 자동승인 캠페인)은 문서에 승인 잼이 남아 있어도 카드가 통째로 숨는다.
  // 어느 단계든 기록이 있으면 표시한다.
  const quotaAtIso = isRecord(campaign.shortfallDiscoveryQuota) && typeof campaign.shortfallDiscoveryQuota.atIso === "string"
    ? campaign.shortfallDiscoveryQuota.atIso.trim()
    : "";
  // R23-2d: 완료된 발굴 잡(ytDlpWorkflow.status === "complete")도 독립적인 관측 채널이다 — 보충·승인·
  // 쿼터 기록이 전부 없어도(예: 아직 refill 이 한 번도 못 돈 신규 캠페인) 발굴만 완료됐다면 그 결과는
  // 보여줘야 한다(R19-3 과 같은 결의 관대함).
  const ytDlpWorkflow = isRecord(campaign.ytDlpWorkflow) ? campaign.ytDlpWorkflow : {};
  const discoveryAtIso = ytDlpWorkflow.status === "complete" && typeof ytDlpWorkflow.completedAtIso === "string"
    ? ytDlpWorkflow.completedAtIso.trim()
    : "";
  if (refillAtIso.length === 0 && approvalAtIso.length === 0 && quotaAtIso.length === 0 && discoveryAtIso.length === 0) return EMPTY;

  const refillReason = typeof campaign.lastRefillErrorCode === "string" ? campaign.lastRefillErrorCode.trim() : "";
  const approvalReason = typeof campaign.lastApprovalErrorCode === "string" ? campaign.lastApprovalErrorCode.trim() : "";
  // 보충 사유를 먼저 본다(더 앞 단계). 보충이 깨끗해도 승인이 막혀 있으면 그것이 현재 상태다.
  const stage: CampaignRefillStage = refillReason.length > 0 ? "refill" : approvalReason.length > 0 ? "approval" : "none";
  const reason = stage === "refill" ? refillReason : stage === "approval" ? approvalReason : "";
  const outcome: CampaignRefillOutcome = stage === "none" ? "ok" : "error";

  const rawCounts = isRecord(campaign.lastRefillCounts) ? campaign.lastRefillCounts : {};
  const counts = Object.entries(rawCounts)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    .map(([key, value]) => ({ key, label: REFILL_COUNT_LABELS[key] ?? key, value }));

  // 표시 시각은 보고하는 단계의 것이어야 한다 — 승인 잼을 보여주면서 보충 시각을 띄우면 오도다.
  // discovery 는 stage 판정에 관여하지 않는 독립 채널이라 다른 시각이 전부 없을 때만 최후 폴백으로 쓴다.
  const atIso = stage === "approval"
    ? (approvalAtIso || refillAtIso || quotaAtIso || discoveryAtIso)
    : (refillAtIso || approvalAtIso || quotaAtIso || discoveryAtIso);
  const rawQuota = isRecord(campaign.shortfallDiscoveryQuota) ? campaign.shortfallDiscoveryQuota : null;
  const quota = rawQuota
    ? (() => {
      const waitingForReset = rawQuota.state === "waiting_for_reset";
      const remainingUnitsEstimate = typeof rawQuota.remainingUnitsEstimate === "number" && Number.isFinite(rawQuota.remainingUnitsEstimate)
        ? Math.max(0, Math.round(rawQuota.remainingUnitsEstimate))
        : 0;
      const nextResetIso = typeof rawQuota.nextResetIso === "string" ? rawQuota.nextResetIso : "";
      const resultLimit = typeof rawQuota.resultLimit === "number" && Number.isFinite(rawQuota.resultLimit)
        ? Math.max(0, Math.round(rawQuota.resultLimit))
        : null;
      return {
        waitingForReset,
        remainingUnitsEstimate,
        nextResetIso,
        resultLimit,
        label: waitingForReset
          ? `쿼터 소진 · 리셋 대기 ${nextResetIso}`
          : `쿼터 잔여 ${remainingUnitsEstimate.toLocaleString()}유닛${resultLimit === null ? "" : ` · 이번 잡 ${resultLimit}건`}`,
      };
    })()
    : null;
  // R23-2d: ytDlpWorkflow 가 완료 상태고 newUnique 가 숫자로 실려 있을 때만 낸다 — R23-2b 이전에
  // 완료된 잡(newUnique 필드 자체가 없음)까지 0으로 단정하면 "신규 0명"이라는 거짓 신호가 된다.
  const discovery = discoveryAtIso.length > 0 && typeof ytDlpWorkflow.newUnique === "number" && Number.isFinite(ytDlpWorkflow.newUnique)
    ? (() => {
      const newUnique = Math.max(0, Math.round(ytDlpWorkflow.newUnique as number));
      const candidatesWritten = typeof ytDlpWorkflow.candidatesWritten === "number" && Number.isFinite(ytDlpWorkflow.candidatesWritten)
        ? Math.max(0, Math.round(ytDlpWorkflow.candidatesWritten))
        : newUnique;
      return {
        atIso: discoveryAtIso,
        newUnique,
        candidatesWritten,
        label: newUnique > 0
          ? `발굴 신규 ${newUnique}명 (적재 ${candidatesWritten}건 중)`
          : `발굴 신규 0명 · 적재 ${candidatesWritten}건 전부 재적재(merge)`,
      };
    })()
    : null;
  return { visible: true, atIso, outcome, reason, stage, counts, quota, discovery };
}
