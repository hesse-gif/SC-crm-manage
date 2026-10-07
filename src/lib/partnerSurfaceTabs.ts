// Flu — 파트너 상세 표면 공용 상수 (U6(c), 2026-07-27).
//
// 파트너 상세는 탭별 최상위 셸이 3종 공존한다(PartnerDetailCloneView / PartnerSettlementView /
// 공통 셸). 셸 통합은 제품 결정 사항이라 이번 웨이브에서 건드리지 않지만, 탭바 top-offset 이
// 셸마다 달라(18px vs 32px) 탭을 바꿀 때 탭바가 위아래로 튀었다. **offset 만** 한 값으로 맞춘다 —
// gap·폰트·배경 등 픽셀 클론 값은 그대로 둔다.
export const PARTNER_TAB_BAR_TOP_OFFSET = 24;
