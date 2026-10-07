import { programIdBelongsToProgram } from "../modules/programs/programScope.ts";
import type { Campaign, Program, ProgramApplication } from "../modules/programs/types.ts";
import type { ProgramFunnelPerson } from "../modules/programs/funnel.ts";

export type CampaignApplicationMetric = {
  readonly count: number | null;
  readonly label: string;
  readonly rateLabel: string;
  readonly unknown: boolean;
  /** 운영자가 수동 등록한 캠페인 — 콜드메일 발송→신청 퍼널이 애초에 성립하지 않는다. */
  readonly operatorRegistered: boolean;
};

/** 분모가 0이면 비율은 0%가 아니라 정의되지 않는다. 0% 로 적으면 "아무도 반응하지 않았다"로 읽힌다. */
export const UNDEFINED_RATE_LABEL = "해당 없음";

export function campaignRateLabel(part: number, total: number): string {
  if (total <= 0) return UNDEFINED_RATE_LABEL;
  return `${Math.round((part / total) * 100).toLocaleString("ko-KR")}%`;
}

/**
 * 운영자 수동 등록 캠페인 판정 — 문서 형태로 가른다(`sent === 0` 추측이 아니라).
 *
 * 프로드 실측(2026-09-05) `campaigns/operator-reviewed-pilot-7jHkz1liyHg`:
 * `dedicatedPilot: true` · `pilotPromotionTag` 보유 · `status`/`sent`/`queued`/`source` 필드 자체가
 * 없음 · `provenance.note = "Dedicated pilot promotion; not historical campaign attribution."`.
 * 이 캠페인은 콜드메일을 한 통도 보내지 않았는데 신청 1건이 귀속돼 있어, 화면이
 * "발송 0 · 신청 1 · 0%" 라는 성립 불가능한 퍼널을 그렸다.
 */
export function isOperatorRegisteredCampaign(campaign: Campaign): boolean {
  const row = campaign as Campaign & {
    dedicatedPilot?: unknown;
    operatorReviewed?: unknown;
    pilotPromotionTag?: unknown;
  };
  if (row.dedicatedPilot === true || row.operatorReviewed === true) return true;
  return typeof row.pilotPromotionTag === "string" && row.pilotPromotionTag.trim().length > 0;
}

export function campaignApplicationMetric(input: {
  readonly program: Program;
  readonly campaign: Campaign;
  readonly applications: readonly ProgramApplication[];
  readonly funnelPeople: readonly ProgramFunnelPerson[];
  readonly sentCount: number;
  /**
   * Program-wide symmetric check to `programHasUnattributedResponses` (ProgramCampaignBoard.tsx):
   * true when the program's funnel has at least one applied person with no campaign attribution
   * at all (campaignIds.length === 0). `funnelPeople` above is already scoped to this campaign, so
   * it can never see those people — without this flag an empty campaign-scoped sample reads as a
   * confirmed "0 · 0%" even when the program has applicants that just never got attributed here.
   */
  readonly programHasUnattributedApplications?: boolean;
}): CampaignApplicationMetric {
  const operatorRegistered = isOperatorRegisteredCampaign(input.campaign);
  const count = input.applications.filter((application) => (
    application.campaignId === input.campaign.id
    && programIdBelongsToProgram(application.programId, input.program, input.program.id)
  )).length;
  if (count > 0) {
    const rate = campaignRateLabel(count, input.sentCount);
    return { count, label: `${count.toLocaleString("ko-KR")} · ${rate}`, rateLabel: rate, unknown: false, operatorRegistered };
  }

  const sampledAppliedWithoutAuthoritativeAttribution = input.funnelPeople.some((person) => person.stages.applied);
  if (sampledAppliedWithoutAuthoritativeAttribution || input.programHasUnattributedApplications) {
    return { count: null, label: "귀속 미확인", rateLabel: "귀속 미확인", unknown: true, operatorRegistered };
  }

  const rate = campaignRateLabel(0, input.sentCount);
  return { count: 0, label: `0 · ${rate}`, rateLabel: rate, unknown: false, operatorRegistered };
}
