// ── 권한 / 멤버 (RBAC 5단계, §8 AUTH-P0 / §14) ─────────────
export type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";
export const ROLES: Record<Role, { label: string; rank: number; tone: "danger" | "accent" | "ai" | "info" | "neutral" }> = {
  super_admin: { label: "Super Admin", rank: 5, tone: "danger" },
  admin: { label: "Admin", rank: 4, tone: "accent" },
  manager: { label: "Manager", rank: 3, tone: "ai" },
  viewer: { label: "Viewer", rank: 2, tone: "info" },
  guest: { label: "Guest", rank: 1, tone: "neutral" },
};

export interface Member {
  id: string;
  name: string;
  email: string;
  avatar: string;
  role: Role;
  team: string;
  assigned: number; // 담당 인플루언서/에이전시 수
  status: "active" | "pending";
  lastActive: string;
  /** Server-owned explicit mailbox view grants; never inferred from role or domain. */
  mailAccountIds?: string[];
}
export const MEMBERS: Member[] = [
  { id: "u1", name: "헤세", email: "hesse@supercent.io", avatar: "https://yt3.ggpht.com/gf0wAEnwry8iGHxxMSusiFzcqbcj8nzX3k7S8rQMv4BoNJgP7KN9yLu7K9bBMof_PfuuIoDY9A=s800-c-k-c0x00ffffff-no-rj", role: "manager", team: "AIX", assigned: 6, status: "active", lastActive: "방금" },
  { id: "u2", name: "시몬", email: "simon@supercent.io", avatar: "시", role: "admin", team: "AIX", assigned: 4, status: "active", lastActive: "10분 전" },
  { id: "u3", name: "티코", email: "tico@supercent.io", avatar: "티", role: "super_admin", team: "AIX", assigned: 0, status: "active", lastActive: "1시간 전" },
  { id: "u4", name: "루비", email: "ruby@supercent.io", avatar: "루", role: "viewer", team: "Growth", assigned: 0, status: "active", lastActive: "어제" },
  { id: "u5", name: "제오", email: "geo@supercent.io", avatar: "제", role: "manager", team: "Growth", assigned: 3, status: "active", lastActive: "2시간 전" },
  { id: "u6", name: "신규 가입자", email: "newbie@supercent.io", avatar: "N", role: "guest", team: "—", assigned: 0, status: "pending", lastActive: "방금" },
];
export const CURRENT_USER_ID = "u1"; // 데모 기본 = Manager(헤세)
export const currentUser = MEMBERS.find((m) => m.id === CURRENT_USER_ID)!;

// ── 행동 로그 (감사 필드 9개 + UI 식별자 id, §14) ───────────────
export interface BehaviorLog {
  id: string;
  userId: string;
  role: Role;
  team: string;
  gameId: string;
  action: string;
  time: string;
  ip: string;
  result: "success" | "denied" | "error";
  costKRW: number;
}
export type BehaviorLogPayload = Omit<BehaviorLog, "id">;
export const BEHAVIOR_LOGS: BehaviorLog[] = [
  { id: "l1", userId: "헤세", role: "manager", team: "AIX", gameId: "casual-01", action: "ai.auto_reply", time: "10:03", ip: "10.0.2.11", result: "success", costKRW: 18 },
  { id: "l2", userId: "Flu AI", role: "manager", team: "AIX", gameId: "casual-01", action: "contract.draft", time: "10:04", ip: "10.0.2.11", result: "success", costKRW: 240 },
  { id: "l3", userId: "시몬", role: "admin", team: "AIX", gameId: "midcore-02", action: "escalation.review", time: "09:40", ip: "10.0.2.20", result: "success", costKRW: 0 },
  { id: "l4", userId: "신규 가입자", role: "guest", team: "—", gameId: "—", action: "inbox.open", time: "09:32", ip: "211.x.x.x", result: "denied", costKRW: 0 },
  { id: "l5", userId: "제오", role: "manager", team: "Growth", gameId: "puzzle-03", action: "review.submit", time: "어제", ip: "10.0.3.7", result: "success", costKRW: 0 },
  { id: "l6", userId: "헤세", role: "manager", team: "AIX", gameId: "casual-01", action: "model.call(qwen3-32b)", time: "10:02", ip: "10.0.2.11", result: "success", costKRW: 12 },
  { id: "l7", userId: "티코", role: "super_admin", team: "AIX", gameId: "—", action: "rbac.update(u6→viewer)", time: "08:55", ip: "10.0.1.2", result: "success", costKRW: 0 },
];

// ── LLM 사용/비용 모니터링 (§8 COST, Gateway 경유) ──────────
export interface LlmUsageByTool {
  calls: number;
  tokensK: number;
  costMilliKRW: number;
}
export interface LlmUsage {
  model: string;
  tier: "빠른" | "품질" | "정밀";
  source?: string;
  provider?: string;
  transport?: "ai_hub_gateway" | "vertex_direct" | "cache" | "unverified";
  schemaVersion?: "llm-usage-v2" | "legacy-unverified";
  aggregationIdentity?: string;
  calls: number;
  tokensK: number;
  costKRW: number;
  costMilliKRW?: number;
  estimatedCostUsdMicro?: number;
  share: number;
  byTool?: Record<string, LlmUsageByTool>;
  lastToolId?: string;
  updatedAtIso?: string;
}
export interface LlmCostLog {
  id: string;
  model: string;
  tier: LlmUsage["tier"];
  cacheKey: string;
  cacheHit: boolean;
  tokensK: number;
  costKRW: number;
  recordedAt: string;
}
export const LLM_USAGE: LlmUsage[] = [
  { model: "Qwen3-32B", tier: "빠른", calls: 1840, tokensK: 920, costKRW: 41000, share: 58 },
  { model: "Gemma 3 27B", tier: "빠른", calls: 610, tokensK: 280, costKRW: 12000, share: 17 },
  { model: "Qwen3-235B (MaaS)", tier: "품질", calls: 220, tokensK: 410, costKRW: 26000, share: 22 },
  { model: "Solar Pro 3 (self-host)", tier: "품질", calls: 40, tokensK: 60, costKRW: 5000, share: 3 },
];

// ── 데이터 시드 (Admin+ — 예시 데이터 생성/삭제, cascade 메타데이터 포함) ──
export interface SeedEntity {
  entity: string;
  count: number;
  meta: string;
}
export interface SeedCascadeStep {
  collection: string;
  strategy: "create" | "delete" | "cascade-delete";
  metadataRefs: string[];
}
export const SEED_MANIFEST: SeedEntity[] = [
  { entity: "멤버 (app_users)", count: 6, meta: "role·team·status·email·last_login" },
  { entity: "인플루언서·파트너", count: 10, meta: "platform·followers·views·stage·owner·guideStatus" },
  { entity: "캠페인", count: 4, meta: "목표·발송·퍼널·priority·source" },
  { entity: "대화·메일", count: 14, meta: "from(AI/사람)·요약(KR)·전문(EN)·time" },
  { entity: "계약", count: 5, meta: "status·valueKRW·template_file·diff" },
  { entity: "검수", count: 3, meta: "checks·result·reviewer" },
  { entity: "정산", count: 5, meta: "pay_status·amount·currency" },
  { entity: "행동 로그", count: 7, meta: "9필드(userId·role·team·gameId·action·time·IP·result·cost)" },
  { entity: "피드백·KB", count: 128, meta: "rating·reason·model·area" },
  { entity: "추천·후보", count: 17, meta: "matchScore·tier·emailStatus·confidence" },
  { entity: "영상·콘텐츠", count: 12, meta: "videoId·views·likes·tag·thumb" },
];
export const SEED_CASCADE: SeedCascadeStep[] = [
  { collection: "app_users", strategy: "create", metadataRefs: ["role", "team", "status", "last_login"] },
  { collection: "creators", strategy: "cascade-delete", metadataRefs: ["owner", "guideStatus", "campaignIds"] },
  { collection: "campaigns", strategy: "cascade-delete", metadataRefs: ["priority", "source", "funnelStats"] },
  { collection: "conversations", strategy: "cascade-delete", metadataRefs: ["summaryRef", "trackingId", "messageRefs"] },
  { collection: "contracts", strategy: "cascade-delete", metadataRefs: ["template_file", "diff", "submissionIds"] },
  { collection: "reviews", strategy: "cascade-delete", metadataRefs: ["reviewer", "paymentIds"] },
  { collection: "behavior_logs", strategy: "delete", metadataRefs: ["auditIndex", "costRollup"] },
  { collection: "llm_usage", strategy: "delete", metadataRefs: ["cacheKey", "costRollup"] },
];
