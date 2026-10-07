// 댓글 의도 카테고리 택소노미 시드 (v1) — 단일 소스(single source of truth).
// video-taxonomy.v1.ts 거버넌스 미러: 값 추가는 PR로만, 삭제·병합은 마이그레이션(docs/VIDEO-TAXONOMY.md 규범 준용).
// 자기완결형 TS 상수 — tsc(commonjs)·Next/webpack·node --test(ESM type-strip) 전 환경에서 import attribute 없이 동일 로드.
export const commentCategoryV1 = {
  version: 1,
  categories: [
    {
      id: "praise_anticipation",
      labelKo: "칭찬·기대",
      description: "게임/영상에 대한 칭찬, 호평, 기대·응원 표현.",
      addedInVersion: 1,
      goldenSetCount: 0,
      active: true,
    },
    {
      id: "complaint_criticism",
      labelKo: "불만·비판",
      description: "게임/영상에 대한 불만, 비판, 부정적 피드백.",
      addedInVersion: 1,
      goldenSetCount: 0,
      active: true,
    },
    {
      id: "question_inquiry",
      labelKo: "질문·문의",
      description: "게임 방법·출시·기능 등에 대한 질문이나 문의.",
      addedInVersion: 1,
      goldenSetCount: 0,
      active: true,
    },
    {
      id: "bug_issue_report",
      labelKo: "버그·이슈제보",
      description: "버그, 크래시, 결제·접속 오류 등 문제 제보.",
      addedInVersion: 1,
      goldenSetCount: 0,
      active: true,
    },
    {
      id: "purchase_play_intent",
      labelKo: "구매·플레이의향",
      description: "다운로드·플레이·구매 의향이나 실제 플레이 언급.",
      addedInVersion: 1,
      goldenSetCount: 0,
      active: true,
    },
    {
      id: "spam_irrelevant",
      labelKo: "스팸·무관",
      description: "광고·홍보·봇·게임과 무관한 잡담.",
      addedInVersion: 1,
      goldenSetCount: 0,
      active: true,
    },
    {
      id: "other",
      labelKo: "기타",
      description: "위 어느 카테고리에도 해당하지 않는 댓글.",
      addedInVersion: 1,
      goldenSetCount: 0,
      active: true,
    },
  ],
} as const;

export default commentCategoryV1;
