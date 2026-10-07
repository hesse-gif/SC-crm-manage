import type { CurrencyCode, PaymentStatus, ReviewReasonCode, ReviewStatus } from "./review";

// ── 담당자 리포트 (Infly DB 실측치 기반 목업, §10 아웃풋 중심) ──
// 주의: Infly DB의 owner_email이 현재 전부 local-dev → 실제 담당자별 분리는 인증(AUTH-P0) 도입 후 실효.

export type ReportAggregateBackend = "firestore" | "bigquery";
export type ReportAggregateMetric = "count" | "sum_amount_krw" | "avg_cycle_hours" | "efficiency_saved_hours";

export interface ReportAggregateQuery {
  backend: ReportAggregateBackend;
  collection: "raw_ledger" | "behavior_logs" | "cost_logs";
  groupBy: Array<"type" | "owner" | "status" | "channel" | "week" | "gameId">;
  metrics: ReportAggregateMetric[];
  filters: {
    period: string;
    ownerScope: "my" | "team" | "all";
    gameId?: string;
    rawType?: RawType;
  };
  cacheKey: string;
  costPolicy: "cache-before-aggregate";
}

export interface ReportEfficiencyFormula {
  legacyMinutes: number;
  toolMinutes: number;
  runs: number;
  members: number;
  savedHours: number;
  formula: "(기존 시간 - 툴 시간) * 횟수 * 멤버";
}

export interface ReportRawDrilldown {
  title: string;
  source: "firestore" | "bigquery";
  rowRefField: "ref";
  piiPolicy: "sanitized-ref-only";
  allowedTypes: RawType[];
}

export const REPORT = {
  period: "이번 주 · 6/13–6/19",
  scopeNote: "'내 담당' 스코프는 owner 필드 기반 — 실제 분리는 로그인 인증 도입 후 적용",
  partners: { active: 104, paused: 3, ended: 1 },
  outputs: [
    { label: "신규 컨택", value: "5건", sub: "dry-run 37 · 회신 2", tone: "info" as const },
    { label: "성사 딜 / 집행", value: "4건 · $1,900", sub: "payable 45건 $2,100 대기", tone: "ok" as const },
    { label: "콘텐츠 승인", value: "41건", sub: "submitted 5 · rejected 14", tone: "ai" as const },
    { label: "검수 통과", value: "49건", sub: "needs_review 15", tone: "warn" as const },
  ],
  funnel: [
    { stage: "발굴", n: 4776 },
    { stage: "YouTube 매칭", n: 801 },
    { stage: "이메일 확보", n: 523 },
    { stage: "파트너 전환", n: 108 },
  ],
  emailRate: "약 12%",
  videoPerf: { avgViews: 110000, avgLikes: 2981, avgComments: 156 },
  regions: [
    { k: "US", n: 1480 },
    { k: "IN", n: 483 },
    { k: "KR", n: 144 },
    { k: "기타/미상", n: 4950 },
  ],
  gameRelatedPct: 84,
  efficiency: {
    perTaskSavedMin: 35,
    weeklyRuns: 18,
    members: 5,
    monthlySavedHr: 105,
    aiMembers: 0.6,
    legacyMinutes: 45,
    toolMinutes: 10,
    runs: 18,
    formula: "(기존 시간 - 툴 시간) * 횟수 * 멤버" as const,
    savedHours: 52.5,
  } satisfies ReportEfficiencyFormula & {
    perTaskSavedMin: number;
    weeklyRuns: number;
    monthlySavedHr: number;
    aiMembers: number;
  },
  aggregateQuery: {
    backend: "firestore" as const,
    collection: "raw_ledger" as const,
    groupBy: ["type", "owner", "status", "week"],
    metrics: ["count", "sum_amount_krw", "efficiency_saved_hours"],
    filters: { period: "2026-W25", ownerScope: "team" as const },
    cacheKey: "report:2026-W25:team:all",
    costPolicy: "cache-before-aggregate" as const,
  } satisfies ReportAggregateQuery,
  rawDrilldown: {
    title: "원본 원장 드릴다운",
    source: "firestore" as const,
    rowRefField: "ref" as const,
    piiPolicy: "sanitized-ref-only" as const,
    allowedTypes: ["컨택", "회신", "협의", "계약", "검수", "지급"],
  } satisfies ReportRawDrilldown,
  weeklyDraft: [
    "캐주얼 신작 컨택 1차 회신 자동화로 수작업 제거 — 건당 약 35분 단축",
    "성사 딜 4건 · 집행 $1,900, 계약 4건 서명 대기",
    "검수 49건 통과·구조화 적재 — 자동 검수용 데이터 축적 중",
    "다음: 가이드 초과 에스컬레이션 2건 단가 재협의 결정 필요",
  ],
};

// ── 휴먼 피드백 / 놀리지 베이스 (AI 생성물 평가 → fine-tune/RAG 축적) ──
export type FeedbackRating = "up" | "down";
export const DOWN_REASONS = ["톤이 안 맞음", "사실/숫자 오류", "비용 가이드 위반", "너무 김/장황", "맥락 누락", "기타"];
export type FeedbackTarget = "chat" | "email" | "contract" | "priority" | "negotiation" | "mail";

export type FeedbackPipelineDomain = "priority" | "negotiation" | "mail" | "contract" | "chat";

export interface Feedback {
  id: string;
  target: FeedbackTarget;
  model: string;
  excerpt: string; // 평가 대상 내용 요약(원문 prompt/response 미노출)
  rating: FeedbackRating;
  reason?: string; // down일 때 사유
  note?: string;
  user: string;
  time: string;
  artifactRef?: string;
  feedbackRef?: string;
  status?: "review_pending" | "promoted" | "rejected" | "eval_failed";
  kbStatus?: "review_pending" | "promoted" | "rejected" | "eval_failed";
  reviewStatus?: "pending" | "approved" | "rejected";
  retrievalStatus?: "excluded_unreviewed" | "active" | "excluded_rejected" | "excluded_eval_failed";
  evalStatus?: "not_started" | "passed" | "failed";
  promotionStatus?: "not_promoted" | "promoted" | "revoked";
  promptVersion?: string;
  policyVersion?: string;
  reviewRef?: string;
  latestReviewEventRef?: string;
  reviewedExampleRef?: string;
  evalDatasetItemRef?: string;
  evalResultRef?: string;
  promotionRef?: string;
  pipelineDomain?: FeedbackPipelineDomain;
  revision?: number;
  scope?: {
    version: "feedback-scope-v2";
    kind: "campaign" | "global";
    scopeKey: string;
    accountOwnerUid: string | null;
    programId: string | null;
    campaignId: string | null;
    locale: string;
  };
  fineTuneStatus?: "not_requested" | "pending" | "dispatching" | "approved_waiting_for_provider" | "retryable" | "sent_to_aihub" | "cancelled" | "compensation_required";
  fineTuneQueueRef?: string;
  fineTuneRevision?: number;
  /**
   * Manual-reply learning capture (functions/manualReplyLearning.ts). Absent for
   * operator-submitted thumbs up/down; "implicit_manual_reply" for a system-captured
   * candidate — a human reply to a creator, paired to the inbound it answers.
   */
  source?: "implicit_manual_reply" | string;
  replyKind?: "gmail_import" | "flu_chat_reply";
  pairedReplyMessageRef?: string;
  pairedInboundMessageRef?: string;
  pairedReplyExcerpt?: string;
  pairedInboundExcerpt?: string;
  pairedInboundSubject?: string;
  pairedInboundCaseId?: string | null;
  pairedInboundCasebookHash?: string | null;
  pairedInboundCasebookVersion?: string | null;
  mailAccountId?: string;
}
export const FEEDBACK: Feedback[] = [
  { id: "f1", target: "email", model: "Qwen3-32B", excerpt: "가이드 내 단가 제안($2,000–2,400) 자동 회신", rating: "up", user: "헤세", time: "10:03" },
  { id: "f2", target: "chat", model: "Qwen3-32B", excerpt: "하이퍼캐주얼 숏폼 협업 제안(자동 컨택)", rating: "down", reason: "톤이 안 맞음", note: "첫 컨택치곤 너무 캐주얼 — 격식 ↑", user: "시몬", time: "09:20" },
  { id: "f3", target: "contract", model: "Qwen3-235B (MaaS)", excerpt: "독점 조항 14일 → 30일 수정본", rating: "down", reason: "사실/숫자 오류", note: "회사 표준 독점기간은 21일", user: "헤세", time: "어제" },
  { id: "f4", target: "email", model: "Gemma 3 27B", excerpt: "€1,500 상한 근접 — 회신 보류 안내", rating: "up", user: "제오", time: "어제" },
  { id: "f5", target: "chat", model: "Qwen3-32B", excerpt: "$2,300 가이드 이내 확정 — 계약서 초안 준비", rating: "up", user: "헤세", time: "10:04" },
  { id: "f6", target: "email", model: "Solar Pro 3", excerpt: "검수 수정 요청 메시지", rating: "down", reason: "너무 김/장황", note: "3줄로 충분", user: "제오", time: "2일 전" },
];
export interface FeedbackKbEntry {
  id: string;
  feedbackRef: string;
  artifactRef: string;
  target: FeedbackTarget;
  pipelineDomain: FeedbackPipelineDomain;
  rating: FeedbackRating;
  reason?: string;
  sanitizedExcerpt: string;
  tags: string[];
  reviewStatus: "pending" | "approved" | "rejected";
  retrievalStatus: "excluded_unreviewed" | "active" | "excluded_rejected" | "excluded_eval_failed";
  evalStatus: "not_started" | "passed" | "failed";
  promotionStatus: "not_promoted" | "promoted";
  fineTuneStatus: "not_requested" | "requires_release_approval" | "approved_waiting_for_provider" | "sent_to_aihub";
  createdBy: string;
  createdAtIso: string;
}

export interface FeedbackPipelineRoute {
  domain: FeedbackPipelineDomain;
  writesTo: string;
  consumers: string[];
  downReasonSignals: string[];
}

export const FEEDBACK_KB: FeedbackKbEntry[] = [
  {
    id: "kb-f1",
    feedbackRef: "feedback/f1",
    artifactRef: "artifacts/email/OUT-1042",
    target: "email",
    pipelineDomain: "mail",
    rating: "up",
    sanitizedExcerpt: "가이드 내 단가 제안 자동 회신",
    tags: ["mail", "price-guide", "positive"],
    reviewStatus: "pending",
    retrievalStatus: "excluded_unreviewed",
    evalStatus: "not_started",
    promotionStatus: "not_promoted",
    fineTuneStatus: "not_requested",
    createdBy: "헤세",
    createdAtIso: "2026-06-19T01:03:00.000Z",
  },
  {
    id: "kb-f2",
    feedbackRef: "feedback/f2",
    artifactRef: "artifacts/chat/OUT-1041",
    target: "chat",
    pipelineDomain: "chat",
    rating: "down",
    reason: "톤이 안 맞음",
    sanitizedExcerpt: "하이퍼캐주얼 숏폼 협업 제안",
    tags: ["chat", "tone", "negative"],
    reviewStatus: "pending",
    retrievalStatus: "excluded_unreviewed",
    evalStatus: "not_started",
    promotionStatus: "not_promoted",
    fineTuneStatus: "not_requested",
    createdBy: "시몬",
    createdAtIso: "2026-06-19T00:20:00.000Z",
  },
  {
    id: "kb-f3",
    feedbackRef: "feedback/f3",
    artifactRef: "artifacts/contracts/K-1042",
    target: "contract",
    pipelineDomain: "contract",
    rating: "down",
    reason: "사실/숫자 오류",
    sanitizedExcerpt: "독점 조항 기간 수정본",
    tags: ["contract", "facts", "negative"],
    reviewStatus: "pending",
    retrievalStatus: "excluded_unreviewed",
    evalStatus: "not_started",
    promotionStatus: "not_promoted",
    fineTuneStatus: "not_requested",
    createdBy: "헤세",
    createdAtIso: "2026-06-18T08:00:00.000Z",
  },
];

export const FEEDBACK_PIPELINE: FeedbackPipelineRoute[] = [
  {
    domain: "priority",
    writesTo: "feedback_kb/priority",
    consumers: ["retrieveFeedbackKb"],
    downReasonSignals: ["맥락 누락", "사실/숫자 오류"],
  },
  {
    domain: "negotiation",
    writesTo: "feedback_kb/negotiation",
    consumers: ["retrieveFeedbackKb"],
    downReasonSignals: ["비용 가이드 위반", "사실/숫자 오류"],
  },
  {
    domain: "mail",
    writesTo: "feedback_kb/mail",
    consumers: ["retrieveFeedbackKb"],
    downReasonSignals: ["톤이 안 맞음", "너무 김/장황", "맥락 누락"],
  },
];
// ── 원본 데이터(원장) — 집계 이전 RAW 행 (Infly outreach/task/submission/payment 구조) ──
export type RawType = "컨택" | "회신" | "협의" | "계약" | "검수" | "지급";
export const RAW_TYPE_TONE: Record<RawType, "info" | "ai" | "accent" | "warn" | "ok" | "neutral"> = {
  컨택: "info", 회신: "neutral", 협의: "ai", 계약: "accent", 검수: "warn", 지급: "ok",
};
export interface RawRecord {
  id: string;
  time: string;
  type: RawType;
  creatorId: string;
  owner: string;
  status: string;
  amountKRW?: number;
  channel?: string;
  ref: string;
  aggregateKey?: string;
  source?: "firestore" | "bigquery";
  reviewStatus?: ReviewStatus;
  reviewReasonCode?: ReviewReasonCode;
  paymentStatus?: PaymentStatus;
  currency?: CurrencyCode;
  costMeta?: { vatIncluded: boolean; fxRateKRW?: number };
  paidAt?: string;
}
export const RAW_RECORDS: RawRecord[] = [
  { id: "rr1", time: "06-19 10:03", type: "협의", creatorId: "c1", owner: "헤세", status: "ai_auto", amountKRW: 3000000, channel: "email", ref: "OUT-1042", aggregateKey: "2026-W25:협의:ai_auto", source: "firestore" },
  { id: "rr2", time: "06-19 10:04", type: "계약", creatorId: "c1", owner: "헤세", status: "ai_revised", amountKRW: 3000000, channel: "email", ref: "K-1042", aggregateKey: "2026-W25:계약:ai_revised", source: "firestore" },
  { id: "rr3", time: "06-19 09:41", type: "회신", creatorId: "c1", owner: "헤세", status: "received", channel: "email", ref: "IMAP-8841", aggregateKey: "2026-W25:회신:received", source: "firestore" },
  { id: "rr4", time: "06-19 09:20", type: "컨택", creatorId: "c3", owner: "시몬", status: "ai_sent", channel: "email", ref: "OUT-1041", aggregateKey: "2026-W25:컨택:ai_sent", source: "firestore" },
  { id: "rr5", time: "06-19 08:55", type: "협의", creatorId: "c5", owner: "시몬", status: "escalated", amountKRW: 14000000, channel: "email", ref: "OUT-1039", aggregateKey: "2026-W25:협의:escalated", source: "firestore" },
  { id: "rr6", time: "06-18 17:30", type: "계약", creatorId: "c2", owner: "헤세", status: "awaiting_sign", amountKRW: 8500000, channel: "docusign", ref: "K-1038", aggregateKey: "2026-W25:계약:awaiting_sign", source: "firestore" },
  { id: "rr7", time: "06-18 15:10", type: "검수", creatorId: "c4", owner: "헤세", status: "needs_review", channel: "form", ref: "SUB-771", aggregateKey: "2026-W25:검수:needs_review", source: "firestore", reviewStatus: "pending", reviewReasonCode: "missing_hashtag", paymentStatus: "not_payable", amountKRW: 1500000, currency: "KRW", costMeta: { vatIncluded: true } },
  { id: "rr8", time: "06-18 14:02", type: "검수", creatorId: "c10", owner: "시몬", status: "approved", channel: "form", ref: "SUB-770", aggregateKey: "2026-W25:검수:approved", source: "firestore", reviewStatus: "pass", reviewReasonCode: "approved", paymentStatus: "paid", amountKRW: 6200000, currency: "KRW", costMeta: { vatIncluded: true }, paidAt: "06-18 14:30" },
  { id: "rr9", time: "06-18 11:20", type: "협의", creatorId: "c9", owner: "헤세", status: "near_cap", amountKRW: 2100000, channel: "email", ref: "OUT-1035", aggregateKey: "2026-W25:협의:near_cap", source: "firestore" },
  { id: "rr10", time: "06-17 18:40", type: "지급", creatorId: "c6", owner: "헤세", status: "paid", amountKRW: 2800000, channel: "wire", ref: "PAY-512", aggregateKey: "2026-W25:지급:paid", source: "firestore", paymentStatus: "paid", currency: "KRW", costMeta: { vatIncluded: true }, paidAt: "06-17 18:40" },
  { id: "rr11", time: "06-17 16:05", type: "계약", creatorId: "c6", owner: "헤세", status: "signed", amountKRW: 2800000, channel: "docusign", ref: "K-1031", aggregateKey: "2026-W25:계약:signed", source: "firestore" },
  { id: "rr12", time: "06-17 13:22", type: "컨택", creatorId: "c7", owner: "시몬", status: "ai_sent", channel: "email", ref: "OUT-1029", aggregateKey: "2026-W25:컨택:ai_sent", source: "firestore" },
  { id: "rr13", time: "06-16 19:48", type: "지급", creatorId: "c8", owner: "헤세", status: "payable", amountKRW: 6200000, channel: "wire", ref: "PAY-509", aggregateKey: "2026-W25:지급:payable", source: "firestore", paymentStatus: "payable", currency: "KRW", costMeta: { vatIncluded: true } },
  { id: "rr14", time: "06-16 10:15", type: "검수", creatorId: "c6", owner: "헤세", status: "revise", channel: "form", ref: "SUB-765", aggregateKey: "2026-W25:검수:revise", source: "firestore", reviewStatus: "revise", reviewReasonCode: "missing_link", paymentStatus: "not_payable", amountKRW: 2800000, currency: "KRW", costMeta: { vatIncluded: true } },
  { id: "rr15", time: "06-16 09:30", type: "회신", creatorId: "c9", owner: "헤세", status: "received", channel: "email", ref: "IMAP-8810", aggregateKey: "2026-W25:회신:received", source: "firestore" },
  { id: "rr16", time: "06-15 17:00", type: "지급", creatorId: "c4", owner: "시몬", status: "hold", amountKRW: 1500000, channel: "wire", ref: "PAY-505", aggregateKey: "2026-W25:지급:hold", source: "firestore", paymentStatus: "not_payable", currency: "KRW", costMeta: { vatIncluded: true } },
];

export const FEEDBACK_STATS = {
  total: 128,
  up: 96,
  down: 32,
  downRate: 25,
  topReasons: [
    { reason: "톤이 안 맞음", n: 11 },
    { reason: "너무 김/장황", n: 8 },
    { reason: "사실/숫자 오류", n: 7 },
    { reason: "비용 가이드 위반", n: 4 },
    { reason: "맥락 누락", n: 2 },
  ],
  kb: {
    stored: FEEDBACK_KB.length,
    lexicalActive: FEEDBACK_KB.filter((entry) => entry.retrievalStatus === "active").length,
    promoted: FEEDBACK_KB.filter((entry) => entry.promotionStatus === "promoted").length,
    fineTuneReleased: FEEDBACK_KB.filter((entry) => entry.fineTuneStatus === "sent_to_aihub").length,
    domains: FEEDBACK_PIPELINE.map((route) => route.domain),
  },
};
