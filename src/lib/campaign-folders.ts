import type { Campaign } from "@/lib/mock/campaigns";
import { preferLiveSentCount } from "@/lib/campaign-live-sent";

/**
 * 콜드 아웃리치 "폴더" 카운트 — 백엔드 syncCampaignFunnel의 folders 뷰를 클라이언트에서 미러한다.
 *
 * 라이브(동기화된) campaign 문서의 버킷은 상호배타다(각 outreach 행이 정확히 하나):
 *   queued / sent(=발송됐으나 무회신) / replied / negotiating / contracted / live, 그리고 dropped(별도).
 * 따라서:
 *   - responded(반응)   = replied + negotiating + contracted + live   (회신 이후 단계 전부)
 *   - noResponse(무반응) = sent                                        (발송됐으나 회신 없음)
 *   - sent(발송)         = noResponse + responded                      (발송 받은 전체, 대기·제외 제외)
 *   - dropped(제외)      = dropped ?? bounced                          (억제/차단/중복/반송)
 *
 * 주의: mock 폴백 데이터의 `sent`는 "총 발송" 의미라 라이브 의미(무회신 버킷)와 다르다 —
 * 라이브 데이터가 canonical이며, mock 폴백 표시는 근사치다(syncCampaignFunnel 동기화 후 정확).
 */
export type CampaignFolderCounts = {
  sent: number;
  responded: number;
  noResponse: number;
  dropped: number;
};

const nonNeg = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

export function campaignFolders(
  campaign: Pick<Campaign, "sent" | "replied" | "negotiating" | "contracted" | "live" | "bounced" | "dropped" | "liveSentCount" | "liveSentCountBackfilledAtIso">,
): CampaignFolderCounts {
  const responded = nonNeg(campaign.replied) + nonNeg(campaign.negotiating) + nonNeg(campaign.contracted) + nonNeg(campaign.live);
  const noResponse = nonNeg(campaign.sent);
  const dropped = nonNeg(campaign.dropped) || nonNeg(campaign.bounced);
  // 백필 마커가 있으면 폴더 합계 대신 liveSentCount(canonical)를 쓴다 — 무반응 버킷은 그
  // 새 총량에 맞춰 다시 뺀다(둘 다 회신 이후 상태와의 합이 총 발송이라는 불변식을 유지).
  const sent = preferLiveSentCount(campaign, noResponse + responded);
  return {
    sent,
    responded,
    noResponse: Math.max(0, sent - responded),
    dropped,
  };
}

/** UI 폴더 라벨(한국어) — 화면 간 일관 표기. */
export const CAMPAIGN_FOLDER_LABELS: ReadonlyArray<{ key: keyof CampaignFolderCounts; label: string }> = [
  { key: "sent", label: "발송" },
  { key: "responded", label: "반응" },
  { key: "noResponse", label: "무반응" },
  { key: "dropped", label: "제외" },
];
