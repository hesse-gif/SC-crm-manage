// 캠페인 화면으로 들어오는 딥링크 파라미터 체계 — 만드는 쪽과 받는 쪽이 같은 규칙을 쓴다.
//
// 진입 두 곳:
//  - 검수 화면의 프로그램 캠페인 칩 → `campaignId`
//  - 관리 목록의 대량 선택 "캠페인 대상 관리" → `creatorIds`
// 예전에는 앞은 파라미터를 아무도 읽지 않았고, 뒤는 파라미터를 아예 싣지 않아 둘 다 무반응이었다.

/** 링크 길이를 묶는다. 이보다 많이 고르면 앞에서부터 이만큼만 넘어간다. */
export const MAX_CAMPAIGN_TARGET_CREATOR_IDS = 50;

export function parseRequestedCreatorIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of raw.split(",")) {
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_CAMPAIGN_TARGET_CREATOR_IDS) break;
  }
  return ids;
}

export function buildCampaignTargetsHref(input: {
  creatorIds?: readonly string[];
  campaignId?: string;
  programId?: string;
}): string {
  const params = new URLSearchParams();
  const programId = (input.programId ?? "").trim();
  const campaignId = (input.campaignId ?? "").trim();
  if (programId) params.set("programId", programId);
  if (campaignId) params.set("campaignId", campaignId);
  const creatorIds = parseRequestedCreatorIds((input.creatorIds ?? []).join(","));
  if (creatorIds.length > 0) params.set("creatorIds", creatorIds.join(","));
  const query = params.toString();
  return query ? `/flu/campaigns?${query}` : "/flu/campaigns";
}

// 프로드 호스팅은 RSC 페이로드 요청(?_rsc=)에 HTML을 돌려줘 뒤로/앞으로가기가 bfcache 문서 복원으로
// 떨어진다(programs/page.tsx 0.6.67 pageshow 수리와 같은 함정). bfcache 복원 시 popstate의 URL 효과가
// Next 라우터 훅(useSearchParams)까지 반영되지 않아, 캠페인 화면이 얼어 있던 이전 programId(또는
// 프로그램 미지정 상태)를 계속 들고 있으면서 주소창은 이미 다른 프로그램을 가리키는 상태가 된다 —
// 그 결과가 "프로그램 캠페인만 보여야 하는데 전체가 보이는" 증상이다. 주소창(window.location.search)이
// 정본이므로 pageshow(persisted)에서 이 순수 함수로 다시 읽어 라우터 훅 값을 덮어쓴다.
export function programIdFromLocationSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("programId");
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
