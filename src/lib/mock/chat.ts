// ── 채팅 인박스 ─────────────────────────────────────────────
export interface Msg {
  id: string;
  from: "ai" | "human" | "creator";
  author: string;
  text: string;
  time: string;
  createdAtIso?: string;
  sentAtIso?: string;
  receivedAtIso?: string;
  mailEventAtIso?: string;
  messageRef?: string;
  trackingId?: string;
  deliveryState?: "queued_for_review" | "queued_for_send" | "sent" | "mock_sent" | "received" | "blocked";
  humanGate?: "auto_reply" | "needs_review" | "blocked" | "auto_close";
  campaignId?: string;
  programId?: string;
  /** 2026-10-05: which stored field the shown text came from ("summary" = 요약본, not the original). */
  textSource?: "text" | "summary" | "preview" | "body";
}
export interface Conversation {
  id: string;
  threadId?: string;
  threadConversationIds?: string[];
  uiThreadKey?: string;
  contextKey?: string;
  type?: string;
  creatorId: string;
  creatorName?: string;
  creatorAvatar?: string;
  creatorEmail?: string;
  creatorHandle?: string;
  creatorPlatform?: string;
  creatorFollowers?: number;
  programId?: string;
  canonicalProgramId?: string;
  programTitle?: string;
  campaignId?: string;
  campaignTitle?: string;
  applicationId?: string;
  applicationRef?: string;
  participationActive?: boolean;
  participationStatus?: "pending" | "hold" | "active" | "retracted";
  participationStage?: "contact" | "negotiation" | "contract" | "review" | "live";
  participationUpdatedAtIso?: string;
  source?: string;
  /** PLAN-ORG-MAIL-IDENTITY Slice 5: read by the admin-only org filter in /chat (functions/
   * read.ts PUBLIC_CONVERSATION_RECORD_KEYS). Absent for legacy/unresolved-org rows. */
  orgId?: string;
  protected?: boolean;
  archivedAt?: string;
  deletedAt?: string;
  humanGate?: "auto_reply" | "needs_review" | "blocked" | "auto_close";
  manualIntervention?: {
    status: "open" | "resolved";
    reason?: string;
    requestedAt?: string;
    requestedBy?: string;
  };
  unread: number;
  aiActive: boolean;
  alert?: string;
  messages: Msg[];
}

export const CONVERSATIONS: Conversation[] = [
  {
    id: "v-hesse",
    creatorId: "rc-hesse",
    creatorName: "Sample Studio Channel",
    creatorAvatar: "https://example.test/avatar.png",
    creatorEmail: "operator@example.test",
    creatorHandle: "@sample-studio-channel",
    creatorPlatform: "YouTube",
    creatorFollowers: 2800000,
    contextKey: "mail:v-hesse",
    source: "mvp-live-test",
    protected: true,
    unread: 0,
    aiActive: true,
    messages: [
      { id: "m1", from: "human", author: "헤세", time: "13:11", createdAtIso: "2026-06-23T04:11:00.000Z", text: "MVP 테스트 컨택 발송 — operator@example.test", trackingId: "flu-hesse-out-001", messageRef: "mailref_hesse_out_001", humanGate: "auto_reply" },
      { id: "m2", from: "ai", author: "Flu AI", time: "13:12", createdAtIso: "2026-06-23T04:12:00.000Z", text: "추천 후보 저장 후 협업 제안 메일이 발송 대기열에 기록됨", trackingId: "flu-hesse-out-001", messageRef: "summary_hesse_out_001", humanGate: "auto_reply" },
      { id: "m3", from: "creator", author: "op***@example.test", time: "13:16", createdAtIso: "2026-06-23T04:16:00.000Z", text: "테스트 수신자가 협업 워크플로우 확인을 위해 회신 가능 상태", trackingId: "flu-hesse-in-001", messageRef: "mailref_hesse_in_001", humanGate: "auto_reply" },
    ],
  },
  {
    id: "v1", creatorId: "c1", unread: 0, aiActive: true,
    messages: [
      { id: "m1", from: "human", author: "헤세", time: "09:12", text: "첫 컨택 — 신작 협업 제안", trackingId: "flu-v1-out-001", messageRef: "msgref_v1_m1", humanGate: "auto_reply" },
      { id: "m2", from: "creator", author: "Nova Play Studio", time: "09:40", text: "관심 있음 — 전용 영상 단가 문의", trackingId: "flu-v1-in-001", messageRef: "msgref_v1_m2", humanGate: "auto_reply" },
      { id: "m3", from: "ai", author: "Flu AI", time: "09:41", text: "가이드 내 단가 제안($2,000–2,400) 자동 회신", trackingId: "flu-v1-out-002", messageRef: "draftref_v1_m3", humanGate: "auto_reply" },
      { id: "m4", from: "creator", author: "Nova Play Studio", time: "10:02", text: "$2,300 / 다음 주 진행 희망", trackingId: "flu-v1-in-002", messageRef: "msgref_v1_m4", humanGate: "auto_reply" },
      { id: "m5", from: "ai", author: "Flu AI", time: "10:03", text: "$2,300 가이드 이내 확정 — 계약서 초안 준비", trackingId: "flu-v1-out-003", messageRef: "draftref_v1_m5", humanGate: "auto_reply" },
    ],
  },
  {
    id: "v2", creatorId: "c5", unread: 2, aiActive: false,
    alert: "협의 금액(₩14,000,000)이 비용 가이드 상한을 28% 초과 — 사람 검수 필요",
    messages: [
      { id: "m1", from: "human", author: "시몬", time: "어제", text: "5인 패키지 단가 협의 시작", trackingId: "flu-v2-out-001", messageRef: "msgref_v2_m1", humanGate: "auto_reply" },
      { id: "m2", from: "creator", author: "Desert Arcade Network", time: "어제", text: "5인 패키지 총 $10,500 요청", trackingId: "flu-v2-in-001", messageRef: "msgref_v2_m2", humanGate: "needs_review" },
      { id: "m3", from: "ai", author: "Flu AI", time: "어제", text: "⚠️ 가이드 상한(₩11.0M) 초과 — 자동 회신 중단·담당자 에스컬레이션", messageRef: "gateref_v2_m3", humanGate: "blocked" },
    ],
  },
  {
    id: "v3", creatorId: "c3", unread: 1, aiActive: true,
    messages: [
      { id: "m1", from: "ai", author: "Flu AI", time: "10:18", createdAtIso: "2026-06-23T01:18:00.000Z", text: "신작 협업 제안 (자동 컨택)", trackingId: "flu-v3-out-001", messageRef: "draftref_v3_m1", humanGate: "auto_reply" },
      { id: "m2", from: "creator", author: "Pixel Turbo", time: "10:22", createdAtIso: "2026-06-23T01:22:00.000Z", text: "관심 있음 — 상세 요청", trackingId: "flu-v3-in-001", messageRef: "msgref_v3_m2", humanGate: "auto_reply" },
    ],
  },
  {
    id: "v4", creatorId: "c9", unread: 0, aiActive: true,
    alert: "제안가(₩2,100,000)가 가이드 상한의 92% — 근접 경고",
    messages: [
      { id: "m1", from: "human", author: "헤세", time: "11:20", text: "퍼즐 신작 단가 조율", trackingId: "flu-v4-out-001", messageRef: "msgref_v4_m1", humanGate: "auto_reply" },
      { id: "m2", from: "creator", author: "Breeze Arcade", time: "11:35", text: "€1,500 요청", trackingId: "flu-v4-in-001", messageRef: "msgref_v4_m2", humanGate: "needs_review" },
      { id: "m3", from: "ai", author: "Flu AI", time: "11:36", text: "€1,500 ≈ ₩2.1M, 상한 92% 근접 — 회신 전 담당자 확인 권장", messageRef: "gateref_v4_m3", humanGate: "needs_review" },
    ],
  },
];

// ── Chat: 메시지 템플릿 ─────────────────────────────────────
export type TemplateStage = "contact" | "negotiation" | "contract" | "review" | "thanks";
export const TEMPLATE_STAGE: Record<TemplateStage, { label: string; tone: "info" | "ai" | "accent" | "warn" | "ok" }> = {
  contact: { label: "컨택", tone: "info" },
  negotiation: { label: "협의", tone: "ai" },
  contract: { label: "계약", tone: "accent" },
  review: { label: "검수", tone: "warn" },
  thanks: { label: "마무리", tone: "ok" },
};
export interface MessageTemplate {
  id: string;
  title: string;
  stage: TemplateStage;
  channel: "이메일" | "DM";
  body: string;
  vars: string[];
  aiManaged: boolean;
  usage: number;
  fixed?: boolean;
  personalizationHints?: Record<string, string>;
}
export const TEMPLATES: MessageTemplate[] = [
  { id: "t1", title: "첫 컨택 — 캐주얼 게임", stage: "contact", channel: "이메일", aiManaged: true, usage: 128, vars: ["name", "game"], body: "안녕하세요 {{name}}님, Supercent의 신작 {{game}} 협업을 제안드립니다. 전용 영상 1편 기준으로 함께하고 싶어요. 관심 있으실까요?" },
  { id: "t2", title: "단가 협의 — 가이드 내 자동", stage: "negotiation", channel: "이메일", aiManaged: true, usage: 86, vars: ["price"], body: "제안 주신 단가는 내부 가이드 범위 내라 {{price}}로 확정 가능합니다. 진행 원하시면 표준 계약서를 보내드릴게요." },
  { id: "t3", title: "계약서 송부", stage: "contract", channel: "이메일", aiManaged: true, usage: 54, vars: ["name"], body: "{{name}}님, 표준 계약서 초안을 첨부드립니다. 내용 확인 후 회신 부탁드립니다. 수정 필요 사항 있으면 말씀 주세요." },
  { id: "t4", title: "검수 결과 — 수정 요청", stage: "review", channel: "DM", aiManaged: false, usage: 22, vars: ["point"], body: "영상 잘 받았습니다! {{point}} 부분만 수정해주시면 바로 게시 가능합니다 🙏" },
  { id: "t5", title: "마무리 감사", stage: "thanks", channel: "DM", aiManaged: false, usage: 71, vars: ["name"], body: "{{name}}님, 이번 협업 정말 감사했습니다. 다음에 또 좋은 기회로 함께해요 🙌" },
  {
    id: "t-infly-intake",
    title: "Infly 폼 제출 안내 — 고정",
    stage: "review",
    channel: "이메일",
    aiManaged: true,
    fixed: true,
    usage: 0,
    vars: ["name", "game", "formUrl", "deadline"],
    personalizationHints: {
      name: "Sample Studio Channel",
      game: "XPHERO",
      formUrl: "https://infly.supercent.io/forms/xphero-submit",
      deadline: "2026-06-30",
    },
    body: "{{name}}님, {{game}} 협업 창작물 제출은 아래 Infly 고정 폼으로 부탁드립니다.\n\n제출 폼: {{formUrl}}\n마감일: {{deadline}}\n\n영상 URL, 썸네일, 게시 예정일, 원본 파일 링크를 함께 입력해주시면 검수와 정산이 바로 이어집니다.",
  },
];

// ── Chat: AI 자동응답 설정 ─────────────────────────────────
export interface AutoRule {
  id: string;
  label: string;
  desc: string;
  enabled: boolean;
  scope: "ai" | "human";
}
export const AUTO_REPLY: {
  enabled: boolean;
  model: string;
  tone: string;
  workingHours: string;
  rules: AutoRule[];
} = {
  enabled: true,
  model: "Claude (내부 Gateway 경유)",
  tone: "정중·간결",
  workingHours: "평시 즉시 회신 / 야간 대기열",
  rules: [
    { id: "a1", label: "가이드 범위 내 단가 자동 회신", desc: "시작가~상한 이내 협의는 AI가 즉시 회신", enabled: true, scope: "ai" },
    { id: "a2", label: "표준 계약서 초안·수정본 자동 작성", desc: "표준 템플릿이 있으면 AI가 작성/수정해 회신", enabled: true, scope: "ai" },
    { id: "a3", label: "가이드 초과 시 자동 회신 중단", desc: "상한 초과·근접 시 사람에게 에스컬레이션", enabled: true, scope: "human" },
    { id: "a4", label: "신규 에이전시 첫 거래는 사람 확인", desc: "첫 계약은 항상 담당자 검토 후 진행", enabled: true, scope: "human" },
    { id: "a5", label: "계약 최종 서명은 사람", desc: "서명 단계는 AI 자동화에서 제외", enabled: true, scope: "human" },
    { id: "a6", label: "야간(22:00–08:00) 자동 회신", desc: "야간에도 가이드 내 회신 자동 발송", enabled: false, scope: "ai" },
  ],
};
