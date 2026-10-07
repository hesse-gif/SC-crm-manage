// A3(functions/chat-ai.ts CAMPAIGN_LIVE_SENT_COUNT_FIELD)이 매 라이브 발송마다 갱신하는 캡
// 판정용 카운터 — campaigns/{id}.liveSentCount. 폴더 카운터 합(sent+replied+...)이나 folders.sent
// 는 배포 전 과거분 미반영·표본 절단 등으로 정체될 수 있어, 2026-09-06 프로드 실측에서 카드는
// 4,770을 보여줬지만 실제 라이브 발송은 9,361이었다(liveSentCount로 확인) — 캠페인 미귀속 발송이
// 아니라 이 카운터 자체가 낡았던 것이 근본 원인이었다.
//
// liveSentCount가 이미 정본이므로, 백필 마커(liveSentCountBackfilledAtIso)가 있는 문서에서는
// 그쪽을 그대로 쓴다. 마커 없는(아직 백필 전) 문서는 liveSentCount가 검증되지 않았을 수 있어
// 기존 폴백(폴더 합계)을 그대로 쓴다. 화면마다 같은 판단을 따로 만들지 않도록 여기 하나로 모은다
// (src/lib/campaign-folders.ts, src/lib/campaign-status.ts 공용).
export function preferLiveSentCount(
  campaign: { liveSentCount?: number; liveSentCountBackfilledAtIso?: string },
  fallback: number,
): number {
  if (!campaign.liveSentCountBackfilledAtIso) return fallback;
  const live = campaign.liveSentCount;
  return typeof live === "number" && Number.isFinite(live) && live >= 0 ? Math.round(live) : fallback;
}
