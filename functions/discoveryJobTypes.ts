/**
 * W63 델타 M6 — 발굴 잡 타입 정본 (의존 없는 리프 모듈)
 *
 * 왜 파일을 나누는가: 종전에는 이 상수들이 `discovery.ts` 안에 있었고, 섀도 프로듀서가
 * 거기서 import 하는 순간 **firebase-admin·Firestore 를 통째로 끌고 왔다**.
 * "프로듀서는 순수 함수다"라는 단정을 소스 텍스트(`adminDb` 문자열 부재)로 확인하고 있었는데,
 * 그건 **전이 의존을 못 본다** — import 한 줄이면 순수성이 깨지는데 테스트는 green 이었다.
 *
 * 이 모듈은 import 가 하나도 없다. 그래서 여기서 무엇을 가져가든 의존이 늘지 않고,
 * 순수성 단정을 텍스트가 아니라 **모듈 그래프**로 확인할 수 있다.
 */

/**
 * W112 F-A — hydration 채널 조회 상한의 **단일 정본**.
 *
 * 왜 여기인가: discovery.ts 가 ytdlpPromotionCore 를 import 하므로 역방향 import 는 순환이 된다.
 * 그래서 ytdlpPromotionCore 는 이 값을 **하드코딩 100 으로 따로** 들고 있었고, 상한을 300 으로
 * 올렸을 때 그쪽만 옛 값에 남아 "상수 하나가 전부를 통제한다"는 단정이 조용히 거짓이 됐다
 * (적대 리뷰가 실행으로 잡았다: channelsPerBatch=200 이 100 기준으론 위반, 300 기준으론 합법).
 * 이 모듈은 import 가 하나도 없어 어느 쪽이 가져가도 의존이 늘지 않는다 — 정본을 여기 둔다.
 */
// 26-08-27 [헤세 지시 "상세조회 100% · 버리는 애들 없게" → 상한 1만]: 1,000 → 10,000.
// recency 게이트를 신호로 낮추면서(ytdlpPromotionCore) hydration 대상이 관측 전량으로 늘었다 —
// 종전 상한은 관측 300~476 기준으로는 여유였지만, 키워드 복구 후 관측이 배로 뛰면 이 자리가
// 새 병목이 된다. 쿼터 실측(2026-08-27): channels 399유닛/일 = 전체 소비의 1.1%,
// search 32,800유닛(94%)이 쿼터를 태운다 — 조회 상한을 3배로 열어도 비용축은 사실상 불변이다.
export const YOUTUBE_CHANNEL_LOOKUP_LIMIT = 10_000;

/**
 * W115 A1 — hydration 이 한 런에서 태울 수 있는 **유닛 예산의 명시적 상한**.
 *
 * 왜 상한을 따로 두는가: `YOUTUBE_CHANNEL_LOOKUP_LIMIT` 은 "채널 몇 명까지 볼 것인가"이고
 * 이 값은 "그 조회가 몇 유닛까지 써도 되는가"다. 종전에는 후자가 전자에서 **암묵적으로 유도**됐고
 * (limit/50), 그래서 상한을 올릴 때 비용 쪽 결정이 아무 데도 기록되지 않았다 — 상향의 비용 근거를
 * 값으로 남겨야 COST-P0-006 결의 로그가 "예산 대비 얼마"를 말할 수 있다.
 *
 * 산식: channels.list 는 50개/콜·1유닛이므로 1,000명 = 20콜 = **20유닛/런**.
 * 같은 런의 search.list 지출(최대 20페이지 × 100유닛 = 2,000유닛)의 1% 다 —
 * 검색이 이미 지불하고 관측한 채널의 57%를 버리던 것(2일 hydrationSeen 10,444 / dropped 5,948)을
 * 회수하는 대가로 타당하다.
 */
// 26-08-27: 10,000명 = 200콜 = 200유닛/런. 상한이지 지출이 아니다 — 실지출은 그 런이 실제로
// 관측한 채널 수에 비례한다(현재 관측 300~476/런, 하이드레이션 실지출 399유닛/일 = 전체의 1.1%).
// 최악의 경우(매 런 상한을 꽉 채움) 하루 4,800유닛으로 키 4개 총예산 40,000의 12% 다.
// 상한을 여기까지 여는 근거: 쿼터를 태우는 축은 search(32,800유닛/일 = 94%)이고, 이 상한이
// 조여져 있으면 키워드 복구로 관측이 늘어날 때 그 물량이 조회도 못 받고 버려진다.
export const YOUTUBE_HYDRATION_UNIT_BUDGET_PER_RUN = 200;

/** channels.list 한 콜이 받는 채널 수(=1유닛의 단위). 배치 크기를 코드 곳곳에 다시 적지 않는다. */
export const YOUTUBE_CHANNELS_LIST_BATCH_SIZE = 50;

export const COMMUNITY_DISCOVERY_JOB_TYPE = "community_discovery" as const;

/**
 * 섀도 잡 타입. 라이브 소비자가 청구하는 목록에 **절대 들어가면 안 된다**.
 * 레거시 라벨(yt_dlp_discovery · ytdlp_worker_discovery)은 재사용하지 않는다(PRD §5.1).
 */
export const SHADOW_DISCOVERY_JOB_TYPE = "ytdlp_shadow_discovery_v1" as const;

/** 라이브 Functions 소비자가 청구하는 잡 타입의 유일한 정본. */
export const LIVE_DISCOVERY_JOB_TYPES: readonly string[] = Object.freeze([
  COMMUNITY_DISCOVERY_JOB_TYPE,
  "yt_dlp_discovery",
]);

// 로드 시점 가드. 섀도 타입이 라이브 목록에 섞이면 모듈이 뜨지 않는다 —
// 테스트를 안 돌리는 환경에서도 배포가 막힌다.
if (LIVE_DISCOVERY_JOB_TYPES.includes(SHADOW_DISCOVERY_JOB_TYPE)) {
  throw new Error(
    "FLU_DISCOVERY_LANE_GUARD: shadow job type must never be claimable by the live discovery consumer",
  );
}
