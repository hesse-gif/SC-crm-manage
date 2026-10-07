// 영상 3축 택소노미 시드 (v1) — 단일 소스(single source of truth).
// 이 파일이 정본이다. 값 추가는 PR로만, 삭제·병합은 마이그레이션(docs/VIDEO-TAXONOMY.md).
// JSON 대신 자기완결형 TS 상수로 두어 tsc(commonjs)·Next/webpack·node --test(ESM type-strip) 전 환경에서
// import attribute 없이 동일하게 로드된다. 타입은 각 소비자(videoTaxonomy.ts)가 부여.
export const videoTaxonomyV1 = {
  "version": 1,
  "axes": {
    "format": [
      {
        "id": "shorts_clip",
        "labelKo": "숏폼 클립",
        "description": "1분 내외의 짧은 게임 클립 영상.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "gameplay_longform",
        "labelKo": "게임플레이 롱폼",
        "description": "실제 플레이 장면을 길게 담은 영상.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "tutorial_guide",
        "labelKo": "튜토리얼/공략",
        "description": "게임 공략이나 사용법을 설명하는 영상.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "review_impression",
        "labelKo": "리뷰/첫인상",
        "description": "게임에 대한 평가나 첫인상을 다루는 영상.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "montage_compilation",
        "labelKo": "몽타주/모음",
        "description": "여러 플레이 장면을 편집해 모은 영상.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "live_stream_vod",
        "labelKo": "라이브 스트리밍 다시보기",
        "description": "실시간 방송을 녹화한 다시보기 영상.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "ad_creative",
        "labelKo": "광고 소재",
        "description": "게임 홍보를 위해 제작된 광고 영상.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "dev_official",
        "labelKo": "개발사 공식 영상",
        "description": "개발사가 직접 제작·배포한 공식 영상.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "reaction_commentary",
        "labelKo": "리액션/해설",
        "description": "플레이나 영상에 대한 반응 및 해설을 담은 영상.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "challenge_run",
        "labelKo": "챌린지/도전 플레이",
        "description": "특정 조건이나 목표에 도전하는 플레이 영상.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "update_news",
        "labelKo": "업데이트/소식",
        "description": "게임 업데이트나 소식을 전하는 영상.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "tierlist_ranking",
        "labelKo": "티어리스트/랭킹",
        "description": "캐릭터나 아이템 등의 순위를 매기는 영상.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      }
    ],
    "genreStyle": [
      {
        "id": "hypercasual_runner",
        "labelKo": "하이퍼캐주얼 러너",
        "description": "단순 조작의 러너형 하이퍼캐주얼 게임.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "idle_incremental",
        "labelKo": "방치형/인크리멘탈",
        "description": "자동 진행과 수치 증가 중심의 방치형 게임.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "merge_puzzle",
        "labelKo": "머지 퍼즐",
        "description": "같은 오브젝트를 합쳐 진행하는 퍼즐 게임.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "match3_puzzle",
        "labelKo": "매치3 퍼즐",
        "description": "같은 모양 3개 이상을 맞추는 퍼즐 게임.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "io_arena",
        "labelKo": "IO 아레나",
        "description": "다수 유저가 실시간으로 경쟁하는 IO류 게임.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "simulation_tycoon",
        "labelKo": "시뮬레이션/타이쿤",
        "description": "경영이나 시설 운영을 시뮬레이션하는 게임.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "arcade_action",
        "labelKo": "아케이드 액션",
        "description": "빠른 반응 속도를 요구하는 아케이드 액션 게임.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "rpg_progression",
        "labelKo": "RPG 성장형",
        "description": "캐릭터 육성과 스토리 진행 중심의 RPG.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "shooter_survivor",
        "labelKo": "슈터/서바이버",
        "description": "총기나 서바이벌 요소가 중심인 슈팅 게임.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "sports_racing",
        "labelKo": "스포츠/레이싱",
        "description": "스포츠 경기나 레이싱을 소재로 한 게임.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "word_trivia",
        "labelKo": "단어/퀴즈",
        "description": "단어 맞추기나 퀴즈 형식의 게임.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "sandbox_creative",
        "labelKo": "샌드박스/창작",
        "description": "자유롭게 제작하고 꾸미는 샌드박스형 게임.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "hybridcasual_other",
        "labelKo": "하이브리드캐주얼/기타",
        "description": "여러 장르 요소가 혼합되었거나 분류 외 캐주얼 게임.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      }
    ],
    "contentNature": [
      {
        "id": "entertainment_fun",
        "labelKo": "재미/엔터테인먼트",
        "description": "웃음이나 재미 요소를 강조하는 콘텐츠.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "skill_showcase",
        "labelKo": "실력 과시",
        "description": "높은 플레이 실력을 보여주는 콘텐츠.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "progression_showcase",
        "labelKo": "성장/진행 과시",
        "description": "캐릭터나 계정의 성장 과정을 보여주는 콘텐츠.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "strategy_meta",
        "labelKo": "전략/메타 분석",
        "description": "게임 전략이나 메타를 분석하는 콘텐츠.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "critique_feedback",
        "labelKo": "비판/피드백",
        "description": "게임의 문제점이나 개선점을 지적하는 콘텐츠.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "praise_recommendation",
        "labelKo": "칭찬/추천",
        "description": "게임의 장점을 칭찬하고 추천하는 콘텐츠.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "monetization_review",
        "labelKo": "과금/BM 리뷰",
        "description": "게임 내 과금 구조나 비즈니스 모델을 다루는 콘텐츠.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "bug_issue_report",
        "labelKo": "버그/이슈 제보",
        "description": "게임 내 버그나 문제 상황을 제보하는 콘텐츠.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "comparison_versus",
        "labelKo": "비교/대결",
        "description": "다른 게임이나 대상과 비교·대결하는 콘텐츠.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "community_event",
        "labelKo": "커뮤니티/이벤트",
        "description": "커뮤니티 활동이나 이벤트를 다루는 콘텐츠.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "paid_promotion",
        "labelKo": "유료 광고/협찬",
        "description": "금전적 대가를 받은 협찬·광고성 콘텐츠.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      },
      {
        "id": "casual_viewing",
        "labelKo": "캐주얼 시청",
        "description": "가볍게 즐기며 시청하는 목적의 콘텐츠.",
        "addedInVersion": 1,
        "goldenSetCount": 0,
        "active": true
      }
    ]
  }
};

export default videoTaxonomyV1;
