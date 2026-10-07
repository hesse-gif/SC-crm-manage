import type { Campaign } from "../modules/programs/types.ts";
import { preferLiveSentCount } from "./campaign-live-sent.ts";

// 캠페인 "취소" 상태 판정 정본.
//
// `Campaign["status"]` 유니온(대기/발송중/완료/예약/탐색중/일시정지/확인 필요)에는 취소가 없는데
// 프로덕션 `campaigns` 문서에는 취소 상태가 실제로 들어 있다(2026-09-05 실측:
// `cancelled` 4건 · `cancelled_preapproval_failed` 1건, 모두 programId=pg-super-creator-partners).
// 타입에 없는 값이라 화면이 이 상태를 인식하지 못했고, 취소된 웨이브가 `sent==0 && queued>0`
// 이라는 이유로 "발송 대기" 폴백에 걸려 **곧 발송될 캠페인처럼** 보였다(대기열 249명 포함).
//
// 접두 판정을 쓰는 이유: 서버가 쓰는 취소 계열 값이 한 벌이 아니다
// (`cancelled` · `canceled` · `cancelling` · `cancelled_preapproval_failed`,
// functions/admin.ts INVENTORY_FLOOR_EXCLUDED_CAMPAIGN_STATES 참고).
export const CANCELLED_CAMPAIGN_LABEL = "취소";

export function isCancelledCampaignStatus(status: unknown): boolean {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (!normalized) return false;
  return normalized.startsWith("cancel") || normalized.startsWith("취소");
}

function isCancelledOperationalState(state: unknown): boolean {
  return typeof state === "string" && state.trim().toLowerCase() === "cancelled";
}

export function isCancelledCampaign(c: Campaign): boolean {
  return isCancelledCampaignStatus(c.status) || isCancelledOperationalState((c as { operationalState?: unknown }).operationalState);
}

export function queuedCount(c: Campaign): number {
  return Math.max(0, c.queued ?? c.targeting?.queued ?? 0);
}

export function contactedCount(c: Campaign): number {
  const folderTotal = Math.max(0, c.sent + c.replied + c.negotiating + c.contracted + c.live + c.bounced);
  // 2026-09-06 헤세 결정: campaigns/{id}.liveSentCount 백필 마커가 있으면 그 canonical 값을
  // 우선한다 — 폴더 합계는 배포 전 과거분 미반영 등으로 실제보다 낮게 정체될 수 있다
  // (campaign-live-sent.ts 참고, campaign-folders.ts와 공유하는 단일 판단).
  return preferLiveSentCount(c, folderTotal);
}

/** 아직 한 통도 안 나갔고 대기열만 남은 캠페인 — 화면에서 "발송 대기"로 그린다. */
export function isQueuedOnlyCampaign(c: Campaign): boolean {
  // 취소된 웨이브는 대기열이 남아 있어도 "발송 대기"가 아니다 — 영영 발송되지 않는다.
  // 서버는 operationalState="cancelled" 도 터미널로 쓰므로 status 가 비어 있거나 "대기"여도 먼저 닫는다.
  // 이 가드가 없으면 라벨뿐 아니라 상단 "발송 대기" 집계·정렬 우선순위까지 취소분을 센다.
  if (isCancelledCampaign(c)) return false;
  return queuedCount(c) > 0 && contactedCount(c) === 0;
}

export function effectiveCampaignOperationalState(c: Campaign): "active" | "paused" | "completed" | "cancelled" {
  if (isCancelledCampaign(c)) return "cancelled";
  if (c.operationalState) return c.operationalState;
  if (c.status === "완료") return "completed";
  if (c.status === "일시정지") return "paused";
  return "active";
}

export function campaignStatusLabel(c: Campaign): Campaign["status"] | "발송 대기" | typeof CANCELLED_CAMPAIGN_LABEL {
  // 취소는 operationalState 폴백보다 먼저 본다 — 취소된 문서에는 operationalState 가 없거나
  // status 가 여전히 "대기"인 채 operationalState="cancelled" 만 들어온다.
  if (isCancelledCampaign(c)) return CANCELLED_CAMPAIGN_LABEL;
  const operationalState = effectiveCampaignOperationalState(c);
  if (operationalState === "paused") return "일시정지";
  if (operationalState === "completed") return "완료";
  return isQueuedOnlyCampaign(c) ? "발송 대기" : c.status;
}

function statusTone(s: Campaign["status"]): "info" | "ok" | "neutral" | "warn" | "danger" {
  if (s === "발송중") return "info";
  if (s === "완료") return "ok";
  if (s === "탐색중") return "info";
  if (s === "일시정지") return "warn";
  if (s === "확인 필요") return "danger";
  return "neutral";
}

export function campaignStatusTone(c: Campaign): "info" | "ok" | "neutral" | "warn" | "danger" {
  const label = campaignStatusLabel(c);
  if (label === CANCELLED_CAMPAIGN_LABEL) return "danger";
  return label === "발송 대기" ? "neutral" : statusTone(label);
}

export function actualSentCount(c: Campaign): number {
  return isQueuedOnlyCampaign(c) ? 0 : contactedCount(c);
}
