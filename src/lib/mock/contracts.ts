import type { GuideStatus } from "./core";

// ── 계약서 ─────────────────────────────────────────────────
export type ContractStatus = "draft" | "ai_revised" | "awaiting_sign" | "signed";
export const CONTRACT_STATUS: Record<ContractStatus, { label: string; tone: "info" | "ai" | "warn" | "ok" }> = {
  draft: { label: "초안", tone: "info" },
  ai_revised: { label: "AI 수정본", tone: "ai" },
  awaiting_sign: { label: "서명 대기", tone: "warn" },
  signed: { label: "서명 완료", tone: "ok" },
};

export type ContractTemplateGateStatus = "attached" | "blocked" | "needs_review";
export interface ContractTemplateGate {
  status: ContractTemplateGateStatus;
  templateRef: string;
  required: true;
  reason: string;
}

export interface Contract {
  id: string;
  creatorId: string;
  title: string;
  status: ContractStatus;
  valueKRW: number;
  updatedAt: string;
  template: string;
  templateRef?: string;
  templateGate?: ContractTemplateGate;
  archivedAt?: string;
  deletedAt?: string;
  humanGate?: "auto_reply" | "needs_review" | "blocked" | "auto_close";
  manualIntervention?: {
    status: "open" | "resolved";
    reason?: string;
    requestedAt?: string;
    requestedBy?: string;
  };
}
export const CONTRACTS: Contract[] = [
  {
    id: "k1",
    creatorId: "c1",
    title: "MrBeast Gaming — 전용 영상 1편",
    status: "ai_revised",
    valueKRW: 3000000,
    updatedAt: "10분 전",
    template: "표준 인플루언서 계약서 v3",
    templateRef: "tpl-influencer-v3",
    templateGate: { status: "attached", templateRef: "tpl-influencer-v3", required: true, reason: "standard_template_attached" },
  },
  {
    id: "k2",
    creatorId: "c2",
    title: "Total Gaming — 분기 패키지",
    status: "awaiting_sign",
    valueKRW: 8500000,
    updatedAt: "1시간 전",
    template: "표준 에이전시 계약서 v2",
    templateRef: "tpl-agency-v2",
    templateGate: { status: "attached", templateRef: "tpl-agency-v2", required: true, reason: "standard_template_attached" },
  },
  {
    id: "k3",
    creatorId: "c8",
    title: "Pokémon Indonesia — 숏폼 3편",
    status: "draft",
    valueKRW: 6200000,
    updatedAt: "5시간 전",
    template: "표준 에이전시 계약서 v2",
    templateRef: "tpl-agency-v2",
    templateGate: { status: "needs_review", templateRef: "tpl-agency-v2", required: true, reason: "draft_requires_template_validation" },
  },
  {
    id: "k4",
    creatorId: "c6",
    title: "Ali-A — 운영 영상",
    status: "signed",
    valueKRW: 2800000,
    updatedAt: "어제",
    template: "표준 인플루언서 계약서 v3",
    templateRef: "tpl-influencer-v3",
    templateGate: { status: "attached", templateRef: "tpl-influencer-v3", required: true, reason: "standard_template_attached" },
  },
  {
    id: "k5",
    creatorId: "c4",
    title: "DanTDM — 퍼즐 리뷰",
    status: "awaiting_sign",
    valueKRW: 1500000,
    updatedAt: "3시간 전",
    template: "표준 인플루언서 계약서 v3",
    templateRef: "tpl-influencer-v3",
    templateGate: { status: "attached", templateRef: "tpl-influencer-v3", required: true, reason: "standard_template_attached" },
  },
];

// ── 비용 가이드 & 에스컬레이션 ──────────────────────────────
export interface GuideRule {
  tier: string;
  basis: string;
  startRate: string;
  maxRate: string;
  autoRange: string;
  humanRange: string;
  guideStatus?: GuideStatus;
  startRatio?: number;
  targetRatio?: number;
  maxRounds?: number;
  cadenceDays?: number;
  walkAwayPct?: number;
}
export const GUIDE_RULES: GuideRule[] = [
  { tier: "Nano (≤1만)", basis: "고정", startRate: "₩150,000", maxRate: "₩400,000", autoRange: "시작가 ~ 상한 100%", humanRange: "상한 초과", guideStatus: "within", startRatio: 60, targetRatio: 80, maxRounds: 4, cadenceDays: 3, walkAwayPct: 110 },
  { tier: "Micro (1–10만)", basis: "CPM", startRate: "₩8 / view", maxRate: "₩14 / view", autoRange: "상한 90% 이내", humanRange: "상한 90% 초과", guideStatus: "within", startRatio: 60, targetRatio: 80, maxRounds: 4, cadenceDays: 3, walkAwayPct: 110 },
  { tier: "Mid (10–50만)", basis: "CPM", startRate: "₩10 / view", maxRate: "₩18 / view", autoRange: "상한 85% 이내", humanRange: "상한 85% 초과", guideStatus: "near", startRatio: 60, targetRatio: 80, maxRounds: 4, cadenceDays: 3, walkAwayPct: 110 },
  { tier: "Macro (50만+)", basis: "패키지", startRate: "₩3,000,000", maxRate: "₩11,000,000", autoRange: "상한 80% 이내", humanRange: "상한 80% 초과 / 전건 검수", guideStatus: "near", startRatio: 60, targetRatio: 80, maxRounds: 4, cadenceDays: 3, walkAwayPct: 110 },
];

export interface Escalation {
  id: string;
  creatorId: string;
  reason: string;
  requestedKRW: number;
  guideMaxKRW: number;
  overPct: number;
  time: string;
  contractRef?: string;
  round?: number;
  guideDelta?: {
    targetPct: number;
    requestedPct: number;
    walkAwayPct: number;
  };
  archivedAt?: string;
  deletedAt?: string;
  humanGate?: "needs_review" | "resolved";
  manualIntervention?: {
    requestedAt?: string;
    requestedBy?: string;
    reason?: string;
    status?: "open" | "resolved";
  };
}
export const ESCALATIONS: Escalation[] = [
  { id: "e1", creatorId: "c5", reason: "협의가 가이드 상한 초과", requestedKRW: 14000000, guideMaxKRW: 11000000, overPct: 28, time: "25분 전", contractRef: "contract/k6", round: 3, guideDelta: { targetPct: 80, requestedPct: 127, walkAwayPct: 110 } },
  { id: "e2", creatorId: "c9", reason: "제안가 상한 92% 근접", requestedKRW: 2100000, guideMaxKRW: 2280000, overPct: -8, time: "40분 전", contractRef: "contract/k7", round: 4, guideDelta: { targetPct: 80, requestedPct: 92, walkAwayPct: 110 } },
];

export interface NegotiationStep {
  round: number;
  offerRatio: number;
  offerKRW: number;
  cadenceDays: number;
  action: "offer" | "accept" | "follow_up" | "escalate";
}

// ── 협상 가이드라인 (사람이 관리, AI가 이대로 운영) ──
// 사람은 목표가/cap만 설정 → AI는 시작가부터 최고 효율로 협상. 범위 밖이면 사람.
export const NEGO_GUIDE = {
  startRatio: 60, // 목표가 대비 첫 제안 비율 (cap $500 → 시작 $300)
  targetRatio: 80, // 타결 목표 (cap의 80% 이내면 자동 수락)
  maxRounds: 4, // AI 자동 협상 최대 라운드
  cadenceDays: 3, // 무응답 시 자동 팔로업 주기(일)
  walkAwayPct: 110, // cap의 110% 초과 요구 = 어처구니없음 → 에스컬
  templateGate: {
    required: true,
    hardRule: "standard_template_required_before_signature",
    allowedTemplateRefs: ["tpl-influencer-v3", "tpl-agency-v2"],
  },
  aiRange: [
    "가이드 범위 내 단가 자동 회신",
    "시작가 → 목표가 자동 협상(최고 효율)",
    "무응답 시 주기적 자동 팔로업",
    "표준 계약서 작성·수정본 회신",
    "합의 시 온보딩 자료·혜택 자동 발송",
  ],
  humanRange: [
    "목표가/cap 금액 설정 (담당자)",
    "가이드 상한 초과·근접 승인",
    "비표준 계약 조건",
    "신규 에이전시 첫 거래",
    "최대 협상 라운드 초과 / 어처구니없는 역제안",
    "계약 최종 서명",
  ],
  buildPlan(capKRW: number, requestedKRW?: number): NegotiationStep[] {
    const firstOffer = Math.round((capKRW * this.startRatio) / 100);
    const targetOffer = Math.round((capKRW * this.targetRatio) / 100);
    const requestedRatio = requestedKRW ? Math.round((requestedKRW / capKRW) * 100) : undefined;

    if (requestedRatio && requestedRatio > this.walkAwayPct) {
      return [{ round: 1, offerRatio: requestedRatio, offerKRW: requestedKRW ?? firstOffer, cadenceDays: this.cadenceDays, action: "escalate" }];
    }

    const steps: NegotiationStep[] = [{ round: 1, offerRatio: this.startRatio, offerKRW: firstOffer, cadenceDays: this.cadenceDays, action: "offer" }];
    if (requestedRatio && requestedRatio <= this.targetRatio) {
      steps.push({ round: 2, offerRatio: requestedRatio, offerKRW: requestedKRW ?? targetOffer, cadenceDays: this.cadenceDays, action: "accept" });
      return steps;
    }

    const roundSpan = Math.max(1, this.maxRounds - 1);
    for (let round = 2; round <= this.maxRounds; round += 1) {
      const ratio = Math.round(this.startRatio + ((this.targetRatio - this.startRatio) * (round - 1)) / roundSpan);
      steps.push({ round, offerRatio: ratio, offerKRW: Math.round((capKRW * ratio) / 100), cadenceDays: this.cadenceDays, action: round === this.maxRounds ? "follow_up" : "offer" });
    }
    return steps;
  },
};
