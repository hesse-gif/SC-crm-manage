// ── 검수 ───────────────────────────────────────────────────
export type ReviewStatus = "pending" | "pass" | "revise" | "blocked" | "human_handled";
export type ReviewReasonCode = "missing_link" | "missing_hashtag" | "brand_mismatch" | "quality_issue" | "approved";
export type PaymentStatus = "not_payable" | "payable" | "paid";
export type CurrencyCode = "KRW" | "USD";
export interface CostMetadata {
  currency: CurrencyCode;
  amount: number;
  vatIncluded: boolean;
  fxRateKRW?: number;
}
export const REVIEW_STATUS: Record<ReviewStatus, { label: string; tone: "warn" | "ok" | "danger" }> = {
  pending: { label: "검수 대기", tone: "warn" },
  pass: { label: "통과", tone: "ok" },
  revise: { label: "수정 요청", tone: "danger" },
  blocked: { label: "차단", tone: "danger" },
  human_handled: { label: "사람 처리", tone: "warn" },
};
export const REVIEW_REASON_LABEL: Record<ReviewReasonCode, string> = {
  missing_link: "다운로드 링크 누락",
  missing_hashtag: "필수 해시태그 누락",
  brand_mismatch: "브랜드/게임명 불일치",
  quality_issue: "품질 기준 미달",
  approved: "승인",
};

export interface ReviewItem {
  id: string;
  creatorId: string;
  creatorName?: string;
  creatorEmail?: string;
  deliverable: string;
  submittedAt: string;
  status: ReviewStatus;
  reviewer: string;
  checks: { label: string; ok: boolean }[];
  submissionId?: string;
  reasonCode?: ReviewReasonCode | string;
  payableStatus?: PaymentStatus;
  payableAmountKRW?: number;
  cost?: CostMetadata;
  transitionedAt?: string;
  archivedAt?: string;
  deletedAt?: string;
  source?: string;
  sourceRefs?: { ref: string; type: string; summary?: string }[];
  reason?: string;
  actionReason?: string;
  recommendedResponse?: string;
  reviewTrigger?: string;
  programId?: string;
  programTitle?: string;
  campaignId?: string;
  campaignTitle?: string;
  conversationId?: string;
  messageRef?: string;
  humanGate?: "auto_reply" | "needs_review" | "blocked" | "auto_close" | {
    decision?: "auto_reply" | "needs_review" | "blocked" | "auto_close";
    reason?: string;
    ruleIds?: string[];
  };
  guidance?: {
    why?: string;
    recommendedAction?: string;
    nextAction?: string;
    sourceSummary?: string;
  };
  manualIntervention?: {
    status: "open" | "resolved";
    reason?: string;
    requestedAt?: string;
    requestedBy?: string;
  };
}
export const REVIEW_ITEMS: ReviewItem[] = [
  { id: "r1", creatorId: "c4", submissionId: "s4", deliverable: "퍼즐 리뷰 영상 (4:32)", submittedAt: "3시간 전", status: "pending", reviewer: "헤세", reasonCode: "missing_hashtag", payableStatus: "not_payable", payableAmountKRW: 1500000, cost: { currency: "KRW", amount: 1500000, vatIncluded: true }, checks: [{ label: "게임명 정확 노출", ok: true }, { label: "다운로드 링크 포함", ok: true }, { label: "필수 해시태그", ok: false }, { label: "가이드 문구", ok: true }] },
  { id: "r2", creatorId: "c10", submissionId: "s5", deliverable: "Mid-core 플레이 영상 (8:10)", submittedAt: "어제", status: "pass", reviewer: "시몬", reasonCode: "approved", payableStatus: "paid", payableAmountKRW: 6200000, cost: { currency: "KRW", amount: 6200000, vatIncluded: true }, transitionedAt: "06-18 14:02", checks: [{ label: "게임명 정확 노출", ok: true }, { label: "다운로드 링크 포함", ok: true }, { label: "필수 해시태그", ok: true }, { label: "가이드 문구", ok: true }] },
  { id: "r3", creatorId: "c6", submissionId: "s3", deliverable: "운영 영상 #2 (2:40)", submittedAt: "어제", status: "revise", reviewer: "헤세", reasonCode: "missing_link", payableStatus: "not_payable", payableAmountKRW: 2800000, cost: { currency: "KRW", amount: 2800000, vatIncluded: true }, transitionedAt: "06-16 10:15", checks: [{ label: "게임명 정확 노출", ok: true }, { label: "다운로드 링크 포함", ok: false }, { label: "필수 해시태그", ok: true }, { label: "가이드 문구", ok: false }] },
];
