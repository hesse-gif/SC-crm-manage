/**
 * W75 — observation-only yt-dlp 섀도 런의 별도 승격 소비자.
 *
 * 경계:
 * - discovery_shadow_runs는 읽기만 한다. 섀도 워커 계약은 한 글자도 열지 않는다.
 * - 채널 hydration/이메일 추출/프로그램 정책/프로그램 후보 writer는 discovery.ts 기존 경로를 쓴다.
 * - 이미 접촉한 채널·이메일은 program_outreach_dedup + scp_coldmail_history로 전역 차단한다.
 * - 다음 queryPlan은 admin.ts의 기존 base∪expanded 우주/회전 창만 읽는다. LLM 호출·캐시·모델 설정 0.
 */
import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { expireAt180DaysFromIso } from "./firestoreTtl";
import { toUnsentInventory, YTDLP_UNSENT_INVENTORY_TARGET } from "./ytdlpInventoryCounter";
import { measureCampaignCandidateInventory } from "./admin";
import {
  resolveYtdlpPromotionKeywordPlan,
} from "./admin";
import {
  backfillCandidateEmailsFromDescriptions,
  CANDIDATE_EMAIL_BACKFILL_CAPS,
} from "./candidateEmailBackfill";
import {
  isBusinessEmail,
  mineBusinessEmailFromText,
  readVideoDescriptionsForBackfill,
  hydrateYtdlpPromotionObservations,
  persistYtdlpPromotionCandidates,
  resolveProgramDiscoveryCriteria,
  type CandidateResult,
  type YtdlpPromotionObservedChannel,
} from "./discovery";
import { buildShadowDiscoveryJob } from "./ytdlpShadowDiscovery";
import { dispatchYtdlpShadowWorker } from "./ytdlpPromotionWorkerTrigger";
import { resolveCanonicalProgramId } from "./programCanonical";
import {
  readCreatorKeysSentInAnyProgram,
  readEmailsSentInColdmailHistory,
  readYoutubeUrlsSentInColdmailHistory,
} from "./programOutreachDedup";
import {
  attributeKeywordCorpusPerformance,
  readKeywordCorpus,
  syncKeywordCorpusWithUniverse,
} from "./keywordCorpus";
import {
  AI_DRAMA_YTDLP_PRIMARY_LANE_APPROVAL_REF,
  YTDLP_PROMOTION_CODE_CAPS,
  YTDLP_PROMOTION_CONFIG_PATH,
  YTDLP_PROMOTION_DAILY_COLLECTION,
  YTDLP_PROMOTION_PRIMARY_LANE_ALLOWED_VERTICALS,
  YTDLP_PROMOTION_RECEIPT_COLLECTION,
  classifyPromotionCandidateEvidence,
  claimRunsWithinBudget,
  mergeQueryPromotionChannelSets,
  metricsFromQueryPromotionChannelSets,
  promotionObservationBatch,
  queryPromotionChannelSets,
  resolvePromotableShadowRun,
  resolveYtdlpPromotionConfig,
  selectEligiblePromotionObservations,
  selectEmailDedupedPromotionCandidates,
  seoulDayKey,
  withinObservationStepUp,
  type PromotableShadowRun,
  type QueryPromotionChannelSets,
  type QueryPromotionMetric,
  type PromotionCandidateEvidence,
  type YtdlpPromotionConfig,
} from "./ytdlpPromotionCore";

/**
 * W84 [R1-P0]: 보충용 설명란 조회의 페이지 상한(1페이지 = 50 videoId = 1유닛).
 *   실측 기준 배치당 고유 videoId ≈ 270(대상 200 × 평균 1.34) → 6페이지면 충분하고,
 *   최악(채널당 다수 관측)을 감안해 8로 둔다. 캐시 적중분은 유닛을 쓰지 않는다.
 */
const EMAIL_BACKFILL_VIDEO_LIST_PAGE_CAP = 8;

const SHADOW_RUN_COLLECTION = "discovery_shadow_runs";
const SHADOW_JOB_COLLECTION = "workflow_jobs";
const DISCOVERY_RUN_COLLECTION = "discovery_runs";
const GLOBAL_CANDIDATE_COLLECTION = "candidate_pool";
const CANDIDATE_COLLECTION = "campaign_candidates";
const PROMOTION_VERSION = "w75-ytdlp-promotion-v1";
// 인시던트 2026-09-29 Codex 리뷰 라운드3: "deferred" 는 쿼터 유예 종단(recordQuotaDeferral) 의
// 상태다 — 이 목록에 없으면 readPendingRuns 의 열린-receipt 쿼리가 아예 못 찾아 영구 미재청구된다.
const OPEN_PROMOTION_RECEIPT_STATUSES = ["awaiting_shadow", "queued", "failed", "processing", "deferred"] as const;
// 인시던트 2026-09-29 Codex 리뷰 라운드3: 일일 쿼터 소진 유예의 다음 재시도 시각 하한. 정확한 PT
// 자정 계산(DST 오프셋 보정) 대신 **+25시간**을 쓴다 — PT 하루 길이는 DST 전환일에도 23~25시간
// 이므로 +25시간이면 항상 다음 PT 쿼터일로 넘어간 뒤다(최대 1시간 늦게 재개될 뿐, 절대 이르게
// 재개되지 않는다). 이 값은 "언제부터 재시도해도 되는가"의 하한선이지 정산 시각이 아니라 이
// 근사가 안전하다.
const QUOTA_DAILY_DEFERRAL_MS = 25 * 60 * 60 * 1000;
// 인시던트 2026-09-29 Codex 리뷰 라운드4 #1: 아직 재청구 불가능한(nextEligibleAtIso 미래) 유예
// receipt 는 오래된 순 윈도우를 점유해도 이번 스윕에서 어차피 아무 일도 못 한다 — 창을 넓혀
// 그 뒤(더 신선한) receipt 들도 같은 스윕에서 볼 기회를 준다(신규 인덱스 없이 기존
// {status, createdAtIso} 복합 인덱스 그대로 재사용).
const OPEN_RECEIPT_READ_LIMIT = 150;

type ReceiptClaim = {
  run: PromotableShadowRun;
  offset: number;
  attempt: number;
  leaseOwner: string;
  leaseToken: string;
  priorMetricChannels: Record<string, QueryPromotionChannelSets>;
  priorCounters: Record<string, number>;
};

type ShadowJobPlanResult = {
  queued: boolean;
  dispatchNeeded: boolean;
  reason: string;
};

export type YtdlpPromotionSweepResult = {
  enabled: boolean;
  reasonCode: string;
  runsExamined: number;
  runsRejected: number;
  runsClaimed: number;
  runsCompleted: number;
  /** 인시던트 2026-09-29 Codex 리뷰 라운드3: 쿼터 유예(quota_deferred) 로 끝난 claim 수 — 실패가
   * 아니므로 runsRejected/firstFailure 와 분리해서 센다(스테이지 실패로 새지 않는다). */
  runsDeferred: number;
  observedUnique: number;
  eligibleUnique: number;
  promotedCandidates: number;
  emailResolved: number;
  /** W75-R1 P1-4: 이 sweep 이 쓴 YouTube 유닛 회계(recency videos.list 호출 수 + 추정 비용). */
  youtubeRecencyCalls: number;
  shadowJobQueued: boolean;
  shadowJobReason: string;
  shadowWorkerDispatched: boolean;
  shadowWorkerReason: string;
  /** W77-⑤ 미발송 상비 재고(이메일 보유 + 콜드 미발송)와 1만 목표 진행률. */
  unsentInventory?: number;
  unsentInventoryProgress?: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, max = 300): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 180);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function channelIdFromCandidate(candidate: CandidateResult): string {
  return candidate.candidateRef.replace(/^candidate_pool\//, "");
}

function emailOf(candidate: CandidateResult): string {
  return text(candidate.email, 320).toLowerCase();
}

function queryMetricChannels(value: unknown): Record<string, QueryPromotionChannelSets> {
  const input = record(value);
  const channelSetCap = YTDLP_PROMOTION_CODE_CAPS.itemsPerQuery;
  const output: Record<string, QueryPromotionChannelSets> = {};
  for (const [query, raw] of Object.entries(input).slice(0, YTDLP_PROMOTION_CODE_CAPS.queriesPerJob)) {
    const item = record(raw);
    const strings = (child: unknown): string[] => Array.isArray(child)
      ? [...new Set(child.filter((value): value is string => typeof value === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(value)))]
        .sort()
        .slice(0, channelSetCap)
      : [];
    output[query] = {
      observedChannelIds: strings(item.observedChannelIds),
      eligibleChannelIds: strings(item.eligibleChannelIds),
      promotedChannelIds: strings(item.promotedChannelIds),
      emailResolvedChannelIds: strings(item.emailResolvedChannelIds),
    };
  }
  return output;
}

async function readConfig(): Promise<ReturnType<typeof resolveYtdlpPromotionConfig>> {
  const snapshot = await adminDb.doc(YTDLP_PROMOTION_CONFIG_PATH).get();
  return resolveYtdlpPromotionConfig(snapshot.data());
}

async function rejectPromotionReceipt(receiptId: string, reasonCode: string, nowIso: string): Promise<boolean> {
  const receiptRef = adminDb.collection(YTDLP_PROMOTION_RECEIPT_COLLECTION).doc(receiptId);
  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(receiptRef);
    const current = snapshot.data() ?? {};
    if (!snapshot.exists || !OPEN_PROMOTION_RECEIPT_STATUSES.includes(text(current.status) as typeof OPEN_PROMOTION_RECEIPT_STATUSES[number])) {
      return false;
    }
    // R2-P0: **여기에 진행 중 가드를 두면 안 된다.**
    //   R1 수리에서 offset>0 / 유효 lease 를 이 공용 종단 함수 안에서 막았는데, 이 함수는
    //   TTL 만이 아니라 **정당한 종단 전부**(범위 불일치 · 소스 terminal · resolve 실패)를
    //   처리한다. 그래서 한 번이라도 배치를 처리한 receipt 는 활성화 로테이션·consumeAfterIso
    //   전진·dead_letter 회수 중 무엇이 와도 **영구 불멸**이 되고, createdAtIso asc 50칸 창의
    //   맨 앞을 계속 점유해 신규 런이 한 번도 안 읽히는 단조 래칫이 된다(리뷰어 에뮬 재현).
    //   진행 중 보호는 TTL 호출부에서만 한다(readPendingRuns 의 !partiallyProcessed && !leaseActive).
    transaction.set(receiptRef, {
      status: "rejected",
      reasonCode: reasonCode.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160),
      rejectedAtIso: nowIso,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAtIso: null,
      updatedAtIso: nowIso,
    }, { merge: true });
    return true;
  });
}

/** R1-P0-1: 누락 인덱스 판별 — chat-ai/conversationAttribution 과 같은 형상. */
function isMissingIndexError(error: unknown): boolean {
  const row = record(error);
  const code = row.code;
  return (code === 9 || code === "failed-precondition" || code === "9")
    && text(row.message, 400).toLowerCase().includes("requires an index");
}

async function readPendingRuns(config: YtdlpPromotionConfig, nowIso: string): Promise<{
  runs: PromotableShadowRun[];
  examined: number;
  rejected: number;
  workerDispatchNeeded: boolean;
  /** W75-R1 P1-6: 깨워도 소비되지 않는 잡이 있어 신호를 멈춘 상태(소비자 부재 의심). */
  /** R1-P1-2: 소비자 부재로 판정된 **그 receipt 들만**. 전역 스칼라는 1건이 전 런을 막았다. */
  workerUnconsumedReceiptIds: readonly string[];
}> {
  // enqueue와 같은 transaction에서 만든 receipt가 durable 소비 큐다. discovery_shadow_runs를 시간순
  // limit로 훑으면 완료 receipt 50개가 쌓인 뒤 새 런이 영구 기아하므로, 열린 receipt만 단일-field
  // 인덱스로 읽고 정확한 run/job 문서를 join한다. 섀도 컬렉션 자체에는 계속 쓰지 않는다.
  // W75-R1 P1-2: **열린 receipt 기아 차단.**
  //   종전에는 정렬 없이 50개만 읽었다. Firestore `in` 쿼리는 순서를 보장하지 않으므로
  //   정지한 receipt(워커가 영영 안 끝내는 awaiting_shadow 등)가 50칸을 채우면 신규 런이
  //   **영구히 안 읽힌다**. 오래된 것부터 읽어 정지분이 먼저 TTL 로 정리되게 한다.
  // R1-P0-1: 이 쿼리는 {status ASC, createdAtIso ASC} 복합 인덱스를 요구한다
  //   (firestore.indexes.json 에 등재했다. 64차는 firestore:indexes 를 functions 보다 먼저 배포).
  //   인덱스가 아직 안 깔린 순간에도 **스윕 전체가 죽지는 않게** 정렬 없이 한 번 물러선다 —
  //   기존 관례(chat-ai.ts)와 같은 폴백이다. 에뮬레이터는 인덱스를 강제하지 않으므로
  //   이 경로는 계약 테스트로 잡히지 않는다(그래서 프로드에서 매 60분 전사할 뻔했다).
  const openReceiptQuery = adminDb.collection(YTDLP_PROMOTION_RECEIPT_COLLECTION)
    .where("status", "in", [...OPEN_PROMOTION_RECEIPT_STATUSES]);
  let snapshot: FirebaseFirestore.QuerySnapshot;
  try {
    snapshot = await openReceiptQuery.orderBy("createdAtIso", "asc").limit(OPEN_RECEIPT_READ_LIMIT).get();
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;
    // 정렬을 잃으면 기아 방지가 약해지지만 스윕이 죽는 것보다 낫다.
    //   TTL 정리가 여전히 자리를 비우므로 적체 자체는 풀린다.
    console.warn(JSON.stringify({
      event: "ytdlp_promotion.receipt_index_missing",
      reasonCode: "promotion_receipt_order_index_missing",
      hint: "firestore.indexes.json 의 ytdlp_shadow_promotions 인덱스를 functions 보다 먼저 배포하라.",
    }));
    snapshot = await openReceiptQuery.limit(OPEN_RECEIPT_READ_LIMIT).get();
  }
  if (snapshot.empty) return {
    runs: [],
    examined: 0,
    rejected: 0,
    workerDispatchNeeded: false,
    workerUnconsumedReceiptIds: [],
  };
  // 인시던트 2026-09-29 Codex 리뷰 라운드4 #1: 아직 재청구 불가능한 유예 receipt 는 이번 스윕에서
  // 어차피 claimRun 이 거절할 것들이다(nextEligibleAtIso 게이트) — run/job 조인 비용을 내기 전에
  // 미리 걸러, 오래된 순으로 읽는 이 창을 채워 버리지 않게 한다(신규 receipt 기아 방지).
  const nowMs = Date.parse(nowIso);
  const actionableDocs = snapshot.docs.filter((doc) => {
    const receipt = doc.data();
    if (text(receipt.status) !== "deferred") return true;
    const eligibleMs = Date.parse(text(receipt.nextEligibleAtIso, 80));
    return !(Number.isFinite(eligibleMs) && eligibleMs > nowMs);
  });
  if (actionableDocs.length === 0) return {
    runs: [],
    examined: snapshot.size,
    rejected: 0,
    workerDispatchNeeded: false,
    workerUnconsumedReceiptIds: [],
  };
  const runSnapshots = await adminDb.getAll(...actionableDocs.map((doc) => (
    adminDb.collection(SHADOW_RUN_COLLECTION).doc(doc.id)
  )));
  const jobSnapshots = await adminDb.getAll(...actionableDocs.map((doc) => (
    adminDb.collection(SHADOW_JOB_COLLECTION).doc(doc.id)
  )));
  const runs: PromotableShadowRun[] = [];
  let rejected = 0;
  let workerDispatchNeeded = false;
  const workerUnconsumedReceiptIds: string[] = [];
  for (const [index, doc] of actionableDocs.entries()) {
    const receipt = doc.data();
    const runSnapshot = runSnapshots[index];
    const jobSnapshot = jobSnapshots[index];
    const runStatus = text(runSnapshot?.data()?.status, 40);
    const jobStatus = text(jobSnapshot?.data()?.status, 40);
    if (
      text(receipt.campaignId, 180) !== config.campaignId
      || text(receipt.activationId, 180) !== config.activationId
    ) {
      if (await rejectPromotionReceipt(doc.id, "promotion_receipt_scope_mismatch", nowIso)) rejected += 1;
      continue;
    }
    // W75-R1 P1-2: **정지 receipt TTL.** 섀도 워커가 영영 끝내지 않은 receipt 는 스스로
    //   비켜나지 않으면 50칸을 점유해 신규 런을 영구 기아시킨다(정렬만으로는 자리가 안 난다).
    //
    // R1-P1-1 재설계: 기준을 **생성 시각이 아니라 마지막 진행**으로 바꾼다.
    //   종전 sourceProgressing(run/job 이 processing|queued) 은 승격 대상 조건과 정면으로
    //   어긋난다 — 승격은 run==complete && job==complete 일 때만 하므로, **다회 배치를
    //   정상 진행 중인 receipt 는 언제나 비보호**였다. 1000채널 런이면 10배치, runsPerSweep 2,
    //   열린 런 10개면 50시간이 걸리는데 TTL 이 24시간이라 정확히 적체 상황에서 발동해
    //   남은 배치 관측을 영구히 버린다.
    //
    //   그래서 (a) 마지막으로 실제 진행이 있었던 시각을 본다(updatedAt/claimedAt/created),
    //   (b) 이미 일부를 처리한 receipt(offset>0)나 (c) 아직 유효한 lease 를 쥔 receipt 는
    //   **절대 거절하지 않는다**. "오래됐다"가 아니라 "아무 진전이 없다"가 정리 기준이다.
    const lastProgressMs = Math.max(
      Date.parse(text(receipt.updatedAtIso, 80)) || 0,
      Date.parse(text(receipt.claimedAtIso, 80)) || 0,
      Date.parse(text(receipt.createdAtIso, 80)) || 0,
    );
    const stalledMs = Date.parse(nowIso) - lastProgressMs;
    // 인시던트 2026-09-29 Codex 리뷰 라운드4 #1: 절대 상한은 **생성 시각만** 본다(updatedAtIso 는
    // 제외). 쿼터 유예(recordQuotaDeferral)가 매 재청구마다 updatedAtIso 를 새로 찍으므로, 위
    // lastProgressMs 를 그대로 쓰면 진짜 진전(offset 전진·완료) 없이 유예만 반복돼도 7일 절대
    // 상한이 영원히 안 걸린다(리뷰어 지적 — 새 런을 영구 기아시킨다). createdAtIso 는 그 무엇으로도
    // 안 새므로, "생성된 지 7일이 지났는데도 아직 complete 가 아니다"를 값으로 고정한다.
    const createdAtMs = Date.parse(text(receipt.createdAtIso, 80)) || 0;
    const ageMs = createdAtMs > 0 ? Date.parse(nowIso) - createdAtMs : 0;
    const leaseExpiresMs = Date.parse(text(receipt.leaseExpiresAtIso, 80));
    const partiallyProcessed = int(receipt.offset) > 0;
    const leaseActive = Number.isFinite(leaseExpiresMs) && leaseExpiresMs > Date.parse(nowIso);
    // 인시던트 2026-09-29 Codex 리뷰 라운드3: 쿼터 유예(recordQuotaDeferral) 는 lease 를 풀고
    // offset 도 0 일 수 있다(첫 배치부터 소진) — status:"deferred" 인 동안은 "아무 진전이 없다"가
    // 아니라 "의도적으로 기다리는 중"이다(claimRun 의 nextEligibleAtIso 게이트가 별도로 "언제부터
    // 재청구 가능한가"를 판정한다 — 여기서는 그 시각까지 흉내 내지 않는다). 처음엔
    // nextEligibleAtIso > now 로만 걸었더니, QUOTA_DAILY_DEFERRAL_MS(25h)가 receiptOpenTtlMs
    // (24h)보다 길어 nextEligibleAtIso 를 막 넘긴(=재청구 가능해진) 순간의 sweep 이 claimRun 을
    // 시도하기도 전에 이 TTL 로 먼저 거절해 버렸다(실측: 에뮬 테스트로 재현). 그래서 **상태만**
    // 본다 — deferred 인 한 24h 연성 TTL 은 절대 적용하지 않는다(7일 절대 상한은 여전히 위에서 건다).
    const deferralProtected = text(receipt.status) === "deferred";
    // R2-P0: **절대 상한.** 진행 중 보호(offset>0 · 유효 lease)는 "일하는 중"을 지키자는 것이지
    //   영생을 주자는 게 아니다. 이 창은 50칸뿐이라 불멸 문서 하나가 맨 앞을 계속 차지하면
    //   신규 런이 영원히 안 읽힌다. 그래서 사유·진행 표식과 무관하게, 이만큼 아무 진전이
    //   없으면 자리를 비운다. 정상 다회 배치(10배치 · 50시간)보다 훨씬 넉넉하다.
    if (createdAtMs > 0 && ageMs > YTDLP_PROMOTION_CODE_CAPS.receiptAbsoluteStallMs) {
      if (await rejectPromotionReceipt(doc.id, "promotion_receipt_absolute_stall", nowIso)) rejected += 1;
      continue;
    }
    if (
      lastProgressMs > 0
      && stalledMs > YTDLP_PROMOTION_CODE_CAPS.receiptOpenTtlMs
      && !partiallyProcessed
      && !leaseActive
      && !deferralProtected
    ) {
      if (await rejectPromotionReceipt(doc.id, "promotion_receipt_open_ttl_expired", nowIso)) rejected += 1;
      continue;
    }
    // queued뿐 아니라 lease가 만료된 processing도 Phase 3 claim 어댑터가 재청구한다. OOM/강제종료
    // 뒤 문서가 processing에 남아도 다음 60분 신호가 없으면 영구 정지하므로 여기서 재기동 근거로 센다.
    const workerLeaseExpiresAtMs = Date.parse(text(jobSnapshot?.data()?.leaseExpiresAtIso, 80));
    if (
      jobStatus === "queued"
      || (jobStatus === "processing" && Number.isFinite(workerLeaseExpiresAtMs) && workerLeaseExpiresAtMs <= Date.parse(nowIso))
    ) {
      // W75-R1 P1-6: **소비되지 않는 잡에는 계속 신호를 보내지 않는다.**
      //   claim 어댑터가 없는 배포(예: Phase 3 미합류)에서는 워커가 즉시 exit 1 로 죽는다.
      //   그래도 잡은 queued 그대로라 매 60분 sweep 이 또 깨우고, 그 헛발이 영원히 반복되며
      //   열린 receipt 도 계속 쌓여 P1-2 기아를 가속한다.
      //
      // R1-P1-2 재설계: 판정을 **receipt 단위**로 한다. 종전에는 전역 스칼라라
      //   정지한 receipt 1건이 있으면 **방금 큐잉된 정상 잡까지** 영원히 미발사였다
      //   (리뷰어 에뮬 재현: 13.1일 정지 1건 → 신규 잡 dispatch 0). 자가 치유도 없었다.
      //   이제 정지한 그 receipt 만 신호 대상에서 빼고, 나머지는 정상적으로 깨운다.
      const unconsumed = jobStatus === "queued"
        && stalledMs > YTDLP_PROMOTION_CODE_CAPS.workerUnconsumedBackoffMs;
      if (unconsumed) {
        workerUnconsumedReceiptIds.push(doc.id);
      } else {
        workerDispatchNeeded = true;
      }
    }
    // 워커가 run→job 순서로 마감하므로 둘 중 하나라도 아직 진행 중이면 다음 sweep까지 기다린다.
    if (!runSnapshot?.exists || runStatus !== "complete" || jobStatus !== "complete") {
      const sourceTerminal = ["failed", "rejected", "dead_letter"].includes(runStatus)
        || ["failed", "rejected", "dead_letter"].includes(jobStatus);
      if (sourceTerminal && await rejectPromotionReceipt(
        doc.id,
        `shadow_source_terminal_${runStatus || jobStatus || "unknown"}`,
        nowIso,
      )) rejected += 1;
      continue;
    }
    const resolved = resolvePromotableShadowRun(doc.id, runSnapshot.data(), jobSnapshot.data(), {
      campaignId: config.campaignId,
      activationId: config.activationId,
    });
    if (resolved.ok && Date.parse(resolved.run.finishedAtIso) >= Date.parse(config.consumeAfterIso)) {
      runs.push(resolved.run);
    }
    else {
      const reasonCode = resolved.ok ? "shadow_run_before_consume_after" : resolved.reasonCode;
      if (await rejectPromotionReceipt(doc.id, reasonCode, nowIso)) rejected += 1;
      console.info(JSON.stringify({
        event: "ytdlp_promotion.shadow_run_rejected",
        shadowRunId: doc.id,
        reasonCode,
      }));
    }
  }
  // Firestore `in` 쿼리는 순서를 보장하지 않는다. 오래된 부분 런을 먼저 끝내도록 값으로 결정 정렬한다.
  runs.sort((left, right) => left.finishedAtIso.localeCompare(right.finishedAtIso) || left.id.localeCompare(right.id));
  return { runs, examined: snapshot.size, rejected, workerDispatchNeeded, workerUnconsumedReceiptIds };
}

async function claimRun(run: PromotableShadowRun, nowIso: string): Promise<ReceiptClaim | null> {
  const receiptRef = adminDb.collection(YTDLP_PROMOTION_RECEIPT_COLLECTION).doc(run.id);
  const nowMs = Date.parse(nowIso);
  const leaseOwner = `w75:${process.env.K_REVISION ?? "local"}:${process.pid}`;
  const leaseToken = createHash("sha256").update(`${run.id}\u0000${nowIso}\u0000${Math.random()}`).digest("hex").slice(0, 32);
  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(receiptRef);
    const prior = snapshot.data() ?? {};
    if (text(prior.status) === "complete" || text(prior.status) === "rejected") return null;
    const leaseExpiresMs = Date.parse(text(prior.leaseExpiresAtIso));
    if (text(prior.status) === "processing" && Number.isFinite(leaseExpiresMs) && leaseExpiresMs > nowMs) return null;
    // 인시던트 2026-09-29 Codex 리뷰 라운드3: 쿼터 유예(recordQuotaDeferral) 가 세운 하한 —
    // 일일 소진이면 다음 PT 리셋 전까지 재청구하지 않는다(필드가 없으면 즉시 재청구 가능 —
    // 단기 429 의 "다음 스윕에 바로 재시도"는 이 필드를 아예 안 세워서 얻는다).
    const nextEligibleMs = Date.parse(text(prior.nextEligibleAtIso));
    if (Number.isFinite(nextEligibleMs) && nextEligibleMs > nowMs) return null;
    const attempt = int(prior.attempt) + 1;
    const failureCount = int(prior.failureCount);
    if (failureCount >= YTDLP_PROMOTION_CODE_CAPS.receiptAttempts) {
      transaction.set(receiptRef, {
        status: "rejected",
        reasonCode: "ytdlp_promotion_attempts_exhausted",
        rejectedAtIso: nowIso,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtIso: null,
        updatedAtIso: nowIso,
      }, { merge: true });
      return null;
    }
    const offset = int(prior.offset);
    transaction.set(receiptRef, {
      id: run.id,
      version: PROMOTION_VERSION,
      status: "processing",
      shadowRunRef: `${SHADOW_RUN_COLLECTION}/${run.id}`,
      finishedAtIso: run.finishedAtIso,
      rawObservationCount: run.rawObservationCount,
      uniqueObservationCount: run.observations.length,
      queryCount: run.queryCount,
      offset,
      attempt,
      failureCount,
      leaseOwner,
      leaseToken,
      leaseExpiresAtIso: new Date(nowMs + YTDLP_PROMOTION_CODE_CAPS.receiptLeaseMs).toISOString(),
      claimedAtIso: nowIso,
      updatedAtIso: nowIso,
      createdAtIso: text(prior.createdAtIso) || nowIso,
      // 인시던트 2026-09-29 Codex 리뷰 라운드3: 재청구 시점엔 이미 지난 값이라 판정에 영향은 없지만,
      // "deferred" 흔적을 문서에 남기지 않는다(다음 실패 사유를 혼동하지 않도록).
      nextEligibleAtIso: FieldValue.delete(),
    }, { merge: true });
    return {
      run,
      offset,
      attempt,
      leaseOwner,
      leaseToken,
      priorMetricChannels: queryMetricChannels(prior.queryMetricChannels),
      priorCounters: record(prior.counters) as Record<string, number>,
    };
  });
}

async function existingCandidateEvidence(
  channelIds: readonly string[],
  promotionRunId: string,
): Promise<ReturnType<typeof classifyPromotionCandidateEvidence>> {
  const globallyExisting = new Set<string>();
  const participationRecords: PromotionCandidateEvidence[] = [];
  for (const chunk of chunks(channelIds, 300)) {
    const snapshots = await adminDb.getAll(...chunk.map((channelId) => (
      adminDb.collection(GLOBAL_CANDIDATE_COLLECTION).doc(channelId)
    )));
    snapshots.forEach((snapshot, index) => {
      if (snapshot.exists) globallyExisting.add(chunk[index]);
    });
  }
  for (const chunk of chunks(channelIds, 30)) {
    const snapshot = await adminDb.collection(CANDIDATE_COLLECTION)
      .where("candidateId", "in", chunk)
      .select("candidateId", "sourceRunId", "persistOutcome", "email")
      .get();
    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      const candidateId = text(data.candidateId, 180);
      if (!candidateId) return;
      participationRecords.push({
        candidateId,
        sourceRunId: text(data.sourceRunId, 180),
        persistOutcome: text(data.persistOutcome, 40),
        email: text(data.email, 320).toLowerCase(),
      });
    });
  }
  return classifyPromotionCandidateEvidence({
    candidateIds: channelIds,
    globallyExistingChannelIds: globallyExisting,
    participationRecords,
    promotionRunId,
  });
}

async function existingCandidateEmails(emails: readonly string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const chunk of chunks(emails, 30)) {
    const snapshots = await Promise.all(
      [GLOBAL_CANDIDATE_COLLECTION, CANDIDATE_COLLECTION].flatMap((collection) => [
        adminDb.collection(collection).where("email", "in", chunk).select("email", "emailLower").get(),
        adminDb.collection(collection).where("emailLower", "in", chunk).select("email", "emailLower").get(),
      ]),
    );
    snapshots.flatMap((snapshot) => snapshot.docs).forEach((doc) => {
      const data = doc.data();
      const email = (text(data.email, 320) || text(data.emailLower, 320)).toLowerCase();
      if (email) existing.add(email);
    });
  }
  return existing;
}

async function assertReceiptLease(claim: ReceiptClaim) {
  const snapshot = await adminDb.collection(YTDLP_PROMOTION_RECEIPT_COLLECTION).doc(claim.run.id).get();
  const current = snapshot.data() ?? {};
  const leaseExpiresMs = Date.parse(text(current.leaseExpiresAtIso));
  if (
    text(current.status) !== "processing"
    || text(current.leaseOwner) !== claim.leaseOwner
    || text(current.leaseToken) !== claim.leaseToken
    || int(current.attempt) !== claim.attempt
    || !Number.isFinite(leaseExpiresMs)
    || leaseExpiresMs <= Date.now()
  ) {
    throw new Error("ytdlp_promotion_lease_lost");
  }
}

async function processClaim(
  config: YtdlpPromotionConfig,
  claim: ReceiptClaim,
  nowIso: string,
): Promise<{
  complete: boolean;
  counters: Record<string, number>;
  delta: Record<string, number>;
  metrics: QueryPromotionMetric[];
}> {
  const batch = promotionObservationBatch(claim.run, claim.offset, config.channelsPerBatch);
  if (batch.items.length === 0) {
    throw new Error("ytdlp_promotion_receipt_offset_invalid");
  }
  const promotionRunId = safeId(`w75_${claim.run.id}`);
  const channelIds = batch.items.map((item) => item.channelId);
  const [candidateEvidence, contactedChannelKeys, coldmailChannelUrls] = await Promise.all([
    existingCandidateEvidence(channelIds, promotionRunId),
    readCreatorKeysSentInAnyProgram(channelIds.map((channelId) => `candidate:${channelId}`)),
    readYoutubeUrlsSentInColdmailHistory(batch.items.map((item) => item.channelUrl)),
  ]);
  const uncommittedItems = batch.items.filter(
    (item) => !candidateEvidence.recoveredCreatedChannelIds.has(item.channelId),
  );
  // W84: 기존 후보 중 **이미 이메일이 있는** 채널은 보충 대상에서 뺀다.
  //   R1-P2 정정: 이 사전 필터는 candidateEvidence 가 이번 런에서 회수한 채널만 알기 때문에
  //   사실상 대부분을 걸러내지 못한다("추가 읽기 0"이라던 종전 주석은 과장이었다).
  //   정합을 실제로 지키는 것은 아래 백필의 getAll 재확인이다 — 거기서 문서를 읽고
  //   이미 이메일이 있으면 건너뛴다. 이 필터는 그 앞단의 값싼 절감일 뿐이다.
  const channelSelection = selectEligiblePromotionObservations({
    observations: uncommittedItems,
    existingChannelIds: candidateEvidence.priorChannelIds,
    existingEmailChannelIds: candidateEvidence.recoveredEmailResolvedChannelIds,
    contactedChannelIds: new Set([
      ...[...contactedChannelKeys].map((key) => key.replace(/^candidate:/, "")),
      ...batch.items.filter((item) => coldmailChannelUrls.has(item.channelUrl)).map((item) => item.channelId),
    ]),
  });
  const eligibleObservations = channelSelection.eligible;
  const hydration = await hydrateYtdlpPromotionObservations({
    campaignId: config.campaignId,
    observations: eligibleObservations.map((item): YtdlpPromotionObservedChannel => ({
      channelId: item.channelId,
      channelUrl: item.channelUrl,
      title: item.title,
      queryTerms: [...item.queries],
      videoIds: [...item.videoIds],
    })),
  });
  if (hydration.canonicalProgramId !== claim.run.canonicalProgramId) {
    throw new Error("ytdlp_promotion_program_scope_changed");
  }
  // W75-R1 P1-7: **핸들 형태 콜드메일 이력 누수 차단.**
  //   관측의 channelUrl 은 항상 `/channel/UC...` 정규형인데, 콜드메일 원장에는 같은 사람이
  //   `/@handle` 형태로 남아 있을 수 있다. 두 문자열은 정규화 후에도 서로 다르므로 위
  //   coldmailChannelUrls 대조를 그대로 통과한다 — 이미 보낸 사람을 다시 발굴해 쿼터를 태운다.
  //   hydration 이 돌려준 handle 로 같은 원장을 한 번 더 본다(같은 정규화 함수를 거친다).
  const handleUrls = hydration.candidates
    .map((candidate) => text(candidate.handle, 160).trim())
    .filter(Boolean)
    .map((handle) => `https://www.youtube.com/${handle.startsWith("@") ? handle : `@${handle}`}`);
  const coldmailHandleUrls = handleUrls.length > 0
    ? await readYoutubeUrlsSentInColdmailHistory(handleUrls)
    : new Set<string>();
  const handleContactedChannelIds = new Set(
    hydration.candidates
      .filter((candidate) => {
        const handle = text(candidate.handle, 160).trim();
        if (!handle) return false;
        const url = `https://www.youtube.com/${handle.startsWith("@") ? handle : `@${handle}`}`;
        return coldmailHandleUrls.has(url);
      })
      .map(channelIdFromCandidate)
      .filter(Boolean),
  );
  const handleFilteredCandidates = hydration.candidates.filter(
    (candidate) => !handleContactedChannelIds.has(channelIdFromCandidate(candidate)),
  );

  const emails = handleFilteredCandidates.map(emailOf).filter(Boolean);
  const [existingEmails, contactedEmailKeys, coldmailEmails] = await Promise.all([
    existingCandidateEmails(emails),
    readCreatorKeysSentInAnyProgram(emails.map((email) => `email:${email}`)),
    readEmailsSentInColdmailHistory(emails),
  ]);
  const emailSelection = selectEmailDedupedPromotionCandidates({
    candidates: handleFilteredCandidates,
    emailOf,
    existingEmails,
    contactedEmails: new Set([
      ...[...contactedEmailKeys].map((key) => key.replace(/^email:/, "")),
      ...coldmailEmails,
    ]),
  });
  const dedupedCandidates = emailSelection.eligible;

  // 외부 호출과 모든 dedup 읽기가 끝난 뒤, 쓰기 직전에 lease를 재검증한다(TOCTOU fail-closed).
  await assertReceiptLease(claim);

  // ────────────────────────────────────────────────────────────────────────
  // W84 [R1-P0]: **기존 무이메일 후보 보충.**
  //
  // R1 이 치명적 결함을 잡았다: 종전에는 `hydration.descriptionByVideoId` 를 넘겼는데,
  //   그 맵은 **eligible(dedup 통과 신규 채널)의 videoId** 만 담는다. 보충 대상은 정확히
  //   그 반대 집합(기존 채널)이라 두 집합이 **구조적으로 서로소** — 프로덕션에서 no-op 였다.
  //   신규가 고갈된 배치에서는 맵이 아예 없어 호출조차 안 됐다(보충이 가장 필요한 상황).
  //   테스트 15/15 가 초록이었던 이유도 같다: 전부 맵을 수제로 만들어 직접 호출했고,
  //   hydration→backfill **통합 지점은 한 번도 안 돌았다**. 이제 관통 테스트가 그걸 막는다.
  //
  // 수리: 보충 대상 **자신의 videoId** 로 설명란을 조회한다. W77-④ 잔재로 남아 있던
  //   `readVideoDescriptionsForBackfill`(호출자 0이던 고아 함수)이 정확히 이 용도다 —
  //   캐시 선행 · 페이지 상한 · 유닛 회계 · `fetchedVideoIds`(P0-5: 조회 안 된 대상에
  //   시도를 적립하지 않기 위한 축)를 이미 갖추고 있다.
  //
  // COST 재계산(실측 기반): 보충 대상 ≤ channelsPerBatch 200, 채널당 관측 videoId 평균 1.34
  //   (프로드 실측 2026-08-15, 최대 27) → 고유 videoId ≈ 270 → **페이지 6개 = 6유닛/배치**.
  //   상한은 8페이지로 둔다(최악 400 videoId 까지 덮는다). 캐시 적중분은 유닛을 안 쓴다.
  //   실측 수율 7.6% 기준 배치당 기대 이메일 ≈ 15 — 이메일 1개당 0.4유닛 수준을 유지한다.
  //
  // lease 재검증 **뒤**에 둔다(R1-P1): 이 파일 자신의 TOCTOU 원칙이다 —
  //   외부 호출과 dedup 읽기가 끝난 뒤, 쓰기 직전에 lease 를 확인하고 나서 쓴다.
  let emailBackfill = { examined: 0, merged: 0, skipped: 0 };
  let emailBackfillVideoListCalls = 0;
  try {
    const backfillTargets = channelSelection.emailBackfillTargets
      .slice(0, CANDIDATE_EMAIL_BACKFILL_CAPS.channelsPerBatch);
    if (backfillTargets.length > 0) {
      const descriptions = await readVideoDescriptionsForBackfill(
        backfillTargets.flatMap((item) => [...item.videoIds]),
        EMAIL_BACKFILL_VIDEO_LIST_PAGE_CAP,
      );
      emailBackfillVideoListCalls = descriptions.videoListCalls;
      emailBackfill = await backfillCandidateEmailsFromDescriptions({
        // P0-5: **조회된 videoId 를 가진 대상만** 넘긴다. 페이지 상한 밖이라 아예 안 본
        //   대상에까지 시도를 적립하면, 보지도 않고 3회 만에 영구 소진된다(W77-④ 실측 함정).
        targets: backfillTargets
          .map((item) => ({
            channelId: item.channelId,
            videoIds: [...item.videoIds].filter((videoId) => descriptions.fetchedVideoIds.has(videoId)),
          }))
          .filter((item) => item.videoIds.length > 0),
        campaignId: config.campaignId,
        canonicalProgramId: hydration.canonicalProgramId,
        nowIso,
        dependencies: {
          descriptionByVideoId: descriptions.descriptionByVideoId,
          mineEmail: (text) => mineBusinessEmailFromText(text),
          classifyEmail: (email) => (isBusinessEmail(email) ? "verified" : "guessed"),
        },
      });
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: "ytdlp_promotion.email_backfill_failed",
      reasonCode: text((error as { message?: unknown } | null)?.message, 160) || "email_backfill_failed",
    }));
  }
  if (emailBackfill.examined > 0 || emailBackfill.skipped > 0) {
    // W84 관측축 소비자: 설명란 출처 실적을 매 배치 구조화 로그로 남긴다.
    console.info(JSON.stringify({
      event: "ytdlp_promotion.email_backfill",
      targets: channelSelection.emailBackfillTargets.length,
      examined: emailBackfill.examined,
      mergedDescriptionSourced: emailBackfill.merged,
      skippedByMarker: emailBackfill.skipped,
      videoListCalls: emailBackfillVideoListCalls,
    }));
  }
  // ────────────────────────────────────────────────────────────────────────

  const runRef = adminDb.collection(DISCOVERY_RUN_COLLECTION).doc(promotionRunId);
  const persisted = await persistYtdlpPromotionCandidates({
    campaignId: config.campaignId,
    canonicalProgramId: hydration.canonicalProgramId,
    promotionRunId,
    candidates: dedupedCandidates,
  });
  const promotedChannelIds = new Set(
    [
      ...candidateEvidence.recoveredCreatedChannelIds,
      ...persisted.outcomes
        .filter((item) => item.outcome === "created")
        .map((item) => item.candidateRef.replace(/^candidate_pool\//, "")),
    ],
  );
  const eligibleChannelIds = new Set([
    ...candidateEvidence.recoveredCreatedChannelIds,
    ...eligibleObservations.map((item) => item.channelId),
  ]);
  const emailResolvedChannelIds = new Set(
    [
      ...candidateEvidence.recoveredEmailResolvedChannelIds,
      // 이메일 해소율은 yt-dlp 관측이 기존 hydration에서 이메일을 찾았는지를 센다. 이후 기존 풀/접촉
      // 이메일과 중복되어 쓰지 않은 후보도 "해소됨"은 참이며, dedup 카운터가 별도로 그 탈락을 설명한다.
      ...hydration.candidates.filter((candidate) => Boolean(emailOf(candidate))).map(channelIdFromCandidate),
    ],
  );
  const metricChannels = mergeQueryPromotionChannelSets(claim.priorMetricChannels, queryPromotionChannelSets({
    observations: batch.items,
    eligibleChannelIds,
    promotedChannelIds,
    emailResolvedChannelIds,
  }));
  const metrics = metricsFromQueryPromotionChannelSets(metricChannels);
  const counters = {
    // W75-R1 P1-4: 승격이 쓴 YouTube 유닛을 런 누적으로 남긴다. 종전에는 hydrate 가 cost 를
    //   버려서 "이 기능이 쿼터를 얼마나 썼나"에 답할 수 없었다(COST 규율 위반).
    // W75-R1 P1-7: 핸들 형태 콜드메일 이력으로 걸러낸 수(재발굴 낭비를 얼마나 막았는지).
    dedupContactedHandleUrl: int(claim.priorCounters.dedupContactedHandleUrl) + handleContactedChannelIds.size,
    youtubeRecencyCalls: int(claim.priorCounters.youtubeRecencyCalls) + int(hydration.recencyVideoListCalls),
    // W77-②: 영상 설명란 마이닝 성과. 이메일 해소율이 이 축으로 올라간다.
    videoDescriptionEmails: int(claim.priorCounters.videoDescriptionEmails) + int(hydration.videoDescriptionEmails),
    /** W84: 기존 무이메일 후보에 설명란으로 채운 수(승격 신규 생성과 분리된 축). */
    descriptionSourcedEmails: int(claim.priorCounters.descriptionSourcedEmails) + emailBackfill.merged,
    // R1-P2-1: USD 축은 제거했다 — discovery 전 경로가 costLog.estimatedUsd 를 0으로 남기므로
    //   구조적으로 항상 0이었고, "비용을 보고 있다"는 착시만 준다. 회계는 **유닛 축**으로 통일한다.
    rawObserved: int(claim.priorCounters.rawObserved) + batch.items.length,
    eligibleUnique: int(claim.priorCounters.eligibleUnique) + eligibleChannelIds.size,
    dedupExistingCandidate: int(claim.priorCounters.dedupExistingCandidate) + channelSelection.dedupExisting,
    dedupContactedChannel: int(claim.priorCounters.dedupContactedChannel) + channelSelection.dedupContacted,
    hydrated: int(claim.priorCounters.hydrated) + hydration.candidates.length
      + candidateEvidence.recoveredCreatedChannelIds.size,
    recencyFiltered: int(claim.priorCounters.recencyFiltered) + hydration.recencyFiltered,
    policyFiltered: int(claim.priorCounters.policyFiltered)
      + Math.max(0, eligibleObservations.length - hydration.recencyFiltered - hydration.candidates.length),
    dedupExistingEmail: int(claim.priorCounters.dedupExistingEmail) + emailSelection.dedupExistingEmail,
    dedupContactedEmail: int(claim.priorCounters.dedupContactedEmail) + emailSelection.dedupContactedEmail,
    dedupDuplicateEmail: int(claim.priorCounters.dedupDuplicateEmail) + emailSelection.dedupDuplicateEmail,
    candidatesCreated: int(claim.priorCounters.candidatesCreated) + persisted.created
      + candidateEvidence.recoveredCreatedChannelIds.size,
    candidatesMerged: int(claim.priorCounters.candidatesMerged) + persisted.merged,
    emailResolved: int(claim.priorCounters.emailResolved) + emailResolvedChannelIds.size,
    recoveredCommittedCandidates: int(claim.priorCounters.recoveredCommittedCandidates)
      + candidateEvidence.recoveredCreatedChannelIds.size,
  };
  const receiptRef = adminDb.collection(YTDLP_PROMOTION_RECEIPT_COLLECTION).doc(claim.run.id);
  await adminDb.runTransaction(async (transaction) => {
    const campaignRef = adminDb.collection("campaigns").doc(config.campaignId);
    const programRef = adminDb.collection("programs").doc(hydration.canonicalProgramId);
    const [snapshot, campaignSnapshot, programSnapshot] = await Promise.all([
      transaction.get(receiptRef),
      transaction.get(campaignRef),
      transaction.get(programRef),
    ]);
    const current = snapshot.data() ?? {};
    const leaseExpiresMs = Date.parse(text(current.leaseExpiresAtIso));
    if (
      text(current.status) !== "processing"
      || text(current.leaseOwner) !== claim.leaseOwner
      || text(current.leaseToken) !== claim.leaseToken
      || int(current.attempt) !== claim.attempt
      || !Number.isFinite(leaseExpiresMs)
      || leaseExpiresMs <= Date.now()
    ) throw new Error("ytdlp_promotion_lease_lost");
    if (!campaignSnapshot.exists) throw new Error("ytdlp_promotion_campaign_missing_at_finalize");
    if (!programSnapshot.exists) throw new Error("ytdlp_promotion_program_missing_at_finalize");
    transaction.set(runRef, {
      id: promotionRunId,
      runRef: runRef.path,
      sourceRunId: promotionRunId,
      sourceRunRef: runRef.path,
      source: "ytdlp-promotion",
      sourceShadowRunRef: `${SHADOW_RUN_COLLECTION}/${claim.run.id}`,
      status: batch.complete ? "complete" : "processing",
      campaignId: config.campaignId,
      campaignRef: campaignRef.path,
      canonicalProgramId: hydration.canonicalProgramId,
      programId: hydration.canonicalProgramId,
      programRef: `programs/${hydration.canonicalProgramId}`,
      observationOffset: batch.nextOffset,
      observedUnique: counters.rawObserved,
      eligibleUnique: counters.eligibleUnique,
      hydrated: counters.hydrated,
      candidatesWritten: counters.candidatesCreated,
      emailReady: counters.emailResolved,
      operationalBoundary: "separate_promotion_consumer",
      updatedAtIso: nowIso,
      ...(int(claim.priorCounters.rawObserved) === 0
        ? { createdAtIso: nowIso, expireAt: expireAt180DaysFromIso(nowIso) }
        : {}),
    }, { merge: true });
    if (batch.complete) {
      const campaign = campaignSnapshot.data() ?? {};
      const state = record(campaign.shortfallDiscoveryState);
      let corpus = readKeywordCorpus(state.keywordCorpus, nowIso);
      const plan = resolveYtdlpPromotionKeywordPlan(
        campaign,
        programSnapshot.data() ?? {},
        YTDLP_PROMOTION_CODE_CAPS.queriesPerJob,
      );
      corpus = syncKeywordCorpusWithUniverse(corpus, plan.keywordUniverse, {
        defaultSource: "seed",
        nowIso,
      });
      // 기존 코퍼스가 아는 query만 기존 newUnique 축에 귀속한다. 정확한 분모/율은 receipt queryMetrics가
      // 보존하며, 수동 우주 밖 쿼리를 새 코퍼스 term으로 만들지는 않는다.
      for (const metric of metrics) {
        corpus = attributeKeywordCorpusPerformance(
          corpus,
          [metric.query],
          metric.eligibleUnique,
          nowIso,
          metric.observedUnique,
          // W90: 이메일 수율 축 이관. W75 가 이미 쿼리별로 계산해 receipt 에 넣던 값인데
          //   읽는 곳이 없어 write-only 였다 — 코퍼스로 넘어와야 수율 기반 퇴역이 성립한다.
          metric.emailResolved,
        );
      }
      transaction.set(campaignRef, {
        shortfallDiscoveryState: { keywordCorpus: corpus },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    transaction.set(receiptRef, {
      status: batch.complete ? "complete" : "queued",
      offset: batch.nextOffset,
      counters,
      queryMetrics: metrics,
      queryMetricChannels: metricChannels,
      ...(batch.complete ? { completedAtIso: nowIso, keywordFeedbackAppliedAtIso: nowIso } : {}),
      // W75-R1 P1-3: **배치가 성공하면 실패 카운터를 리셋한다.**
      //   종전에는 런 생애에 걸쳐 누적돼, 6시간 넘게 도는 다회 배치에서 일시 오류가 3번만
      //   흩어져 나도(그 사이 배치들이 전부 성공했어도) receiptAttempts 상한에 걸려 rejected 로
      //   종단됐다. 연속 실패가 아니라 총합을 세는 것은 "재시도 예산"이 아니라 "수명 제한"이다.
      failureCount: 0,
      lastFailureReasonCode: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAtIso: null,
      updatedAtIso: nowIso,
    }, { merge: true });
    // W77-③: **실관측 적재.** 이 값이 다음날 단계 상향 가드의 분모다(예약축과 별개).
    //   배치가 실제로 처리한 관측만 센다 — 예약만 하고 워커가 못 긁은 분은 여기 안 들어온다.
    transaction.set(
      adminDb.collection(YTDLP_PROMOTION_DAILY_COLLECTION).doc(seoulDayKey(Date.parse(nowIso))),
      {
        observedCount: FieldValue.increment(batch.items.length),
        // 헤세 결정(2026-09-27) 코덱스 라운드3 HIGH 수리: observedCount 는 "이 배치가 처리한
        //   관측 수"일 뿐이다 — dedup(이미 아는 채널·이미 접촉한 채널)로 100% 걸러지는 비생산적
        //   배치도 이 값을 그대로 올린다. discovery.ts 의 자동 회복 게이트
        //   (hasRecentYtdlpPromotionSupplyEvidence)는 "공급이 실제로 산다"를 확인해야 하므로
        //   **실제로 새로 만든 후보 수**를 별도 필드로 남긴다 — 기존 observedCount 의미·소비자는
        //   그대로 둔다(이 필드를 읽는 곳이 이미 있을 수 있어 바꾸지 않는다).
        candidatesCreatedCount: FieldValue.increment(persisted.created),
        updatedAtIso: nowIso,
      },
      { merge: true },
    );
  });
  // W75-R1 P2: **이 배치가 더한 양(델타)** 을 같이 돌려준다. counters 는 런 생애 누적이라
  //   호출부가 배치마다 그 값을 더하면 같은 관측을 여러 번 센다(다회 배치일수록 크게 부푼다).
  const delta: Record<string, number> = {};
  for (const [key, value] of Object.entries(counters)) {
    delta[key] = int(value) - int(claim.priorCounters[key]);
  }
  return { complete: batch.complete, counters, delta, metrics };
}

async function recordFailure(claim: ReceiptClaim, error: unknown, nowIso: string): Promise<void> {
  const reasonCode = text((error as { errorCode?: unknown } | null)?.errorCode, 160)
    || text((error as { message?: unknown } | null)?.message, 160).split(":")[0]
    || "ytdlp_promotion_failed";
  const receiptRef = adminDb.collection(YTDLP_PROMOTION_RECEIPT_COLLECTION).doc(claim.run.id);
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(receiptRef);
    const current = snapshot.data() ?? {};
    if (
      text(current.status) !== "processing"
      || text(current.leaseOwner) !== claim.leaseOwner
      || text(current.leaseToken) !== claim.leaseToken
      || int(current.attempt) !== claim.attempt
    ) return;
    transaction.set(receiptRef, {
      status: "failed",
      reasonCode: reasonCode.replace(/[^A-Za-z0-9_.-]/g, "_"),
      failureCount: FieldValue.increment(1),
      failedAtIso: nowIso,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAtIso: null,
      updatedAtIso: nowIso,
    }, { merge: true });
  });
}

// 인시던트 2026-09-29 Codex 리뷰 라운드3: YouTube 쿼터 소진(마커 스킵/라이브 429)은 **결함이 아니다**
// — recordFailure 를 타면 failureCount 가 늘어 YTDLP_PROMOTION_CODE_CAPS.receiptAttempts(3)회
// 뒤 receipt 가 영구 rejected(ytdlp_promotion_attempts_exhausted) 된다. 쿼터는 시간이 지나면
// 스스로 회복되는 조건이라 그 경로로 새면 안 된다 — 그래서 별도 종단을 둔다: failureCount 는
// **건드리지 않고** lease 만 풀어 재청구 가능 상태로 돌리고, nextEligibleAtIso 이전에는
// claimRun 이 재청구를 거절한다(일일 소진은 다음 PT 리셋까지, 단기 429 는 필드를 비워 다음
// 스윕에서 바로 재시도한다 — "skip this tick only").
async function recordQuotaDeferral(
  claim: ReceiptClaim,
  options: { reasonCode: string; nextEligibleAtIso: string | null },
  nowIso: string,
): Promise<void> {
  const receiptRef = adminDb.collection(YTDLP_PROMOTION_RECEIPT_COLLECTION).doc(claim.run.id);
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(receiptRef);
    const current = snapshot.data() ?? {};
    if (
      text(current.status) !== "processing"
      || text(current.leaseOwner) !== claim.leaseOwner
      || text(current.leaseToken) !== claim.leaseToken
      || int(current.attempt) !== claim.attempt
    ) return;
    transaction.set(receiptRef, {
      status: "deferred",
      reasonCode: options.reasonCode.replace(/[^A-Za-z0-9_.-]/g, "_"),
      nextEligibleAtIso: options.nextEligibleAtIso ?? FieldValue.delete(),
      deferredAtIso: nowIso,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAtIso: null,
      updatedAtIso: nowIso,
    }, { merge: true });
  });
}

async function enqueueNextShadowJob(
  config: YtdlpPromotionConfig,
  nowIso: string,
): Promise<ShadowJobPlanResult> {
  const campaignSnapshot = await adminDb.collection("campaigns").doc(config.campaignId).get();
  if (!campaignSnapshot.exists) return {
    queued: false,
    dispatchNeeded: false,
    reason: "ytdlp_promotion_campaign_not_found",
  };
  const campaign = campaignSnapshot.data() ?? {};
  const rawProgramId = text(campaign.programId) || text(campaign.canonicalProgramId);
  const canonicalProgramId = resolveCanonicalProgramId(rawProgramId);
  const programSnapshot = canonicalProgramId
    ? await adminDb.collection("programs").doc(canonicalProgramId).get()
    : null;
  if (!rawProgramId || !programSnapshot?.exists) return {
    queued: false,
    dispatchNeeded: false,
    reason: "ytdlp_promotion_program_not_found",
  };
  // 헤세 결정(2026-09-27) "AI Drama만 상시 허용": primaryLaneApprovalRef 가 신청돼 있으면
  //   (기본값 "" — 이 블록 자체가 no-op) 그 참조가 정확히 일치하고 대상 캠페인이 실제로
  //   ai_drama 버티컬일 때만 통과시킨다. campaignId 만 바꿔서 다른 프로그램에 이 승격을
  //   두르는 우회를 구조적으로 막는다 — SHADOW_PROHIBITED_TRIGGERS 는 건드리지 않는다(별개 게이트).
  if (config.primaryLaneApprovalRef) {
    if (config.primaryLaneApprovalRef !== AI_DRAMA_YTDLP_PRIMARY_LANE_APPROVAL_REF) {
      return { queued: false, dispatchNeeded: false, reason: "ytdlp_promotion_primary_lane_approval_invalid" };
    }
    const primaryLaneVertical = resolveProgramDiscoveryCriteria(programSnapshot.data() ?? {}, campaign).criteria.discoveryVertical;
    if (!YTDLP_PROMOTION_PRIMARY_LANE_ALLOWED_VERTICALS.includes(primaryLaneVertical)) {
      return { queued: false, dispatchNeeded: false, reason: "ytdlp_promotion_primary_lane_vertical_mismatch" };
    }
  }
  // R1-P1-3: 키워드 계획은 **queriesPerJob 을 절대 넘지 않아야 한다.** 넘기면 잡 검증이
  //   shadow_run_query_cap_exceeded 로 **런을 통째로 폐기**한다(조용한 절단이 아니라 전량 손실).
  //   실제 결합점은 HARVEST_KEYWORD_WINDOW_SIZE(admin.ts) 이고 밴딧 슬롯과 공유되므로,
  //   그쪽이 늘어나면 여기서 먼저 막는다 — 방어를 상류 상수 하나에 걸지 않는다.
  const plan = resolveYtdlpPromotionKeywordPlan(campaign, programSnapshot.data() ?? {}, config.queriesPerJob);
  if (plan.keywords.length > config.queriesPerJob) {
    plan.keywords = plan.keywords.slice(0, config.queriesPerJob);
  }
  if (plan.keywords.length === 0) return {
    queued: false,
    dispatchNeeded: false,
    reason: "ytdlp_promotion_keyword_universe_empty",
  };
  const dayKey = seoulDayKey(Date.parse(nowIso));
  const dailyRef = adminDb.collection(YTDLP_PROMOTION_DAILY_COLLECTION).doc(dayKey);
  const slot = int(record(campaign.ytdlpPromotionState).rotationTick);
  const logicalRunId = `w75_${dayKey.replace(/-/g, "")}_${safeId(config.campaignId)}_${slot}`;
  const built = await buildShadowDiscoveryJob({
    runId: logicalRunId,
    sourceRunRef: `${YTDLP_PROMOTION_DAILY_COLLECTION}/${dayKey}`,
    trigger: "scheduled_promotion",
    queryPlan: plan.keywords,
    maxQueries: Math.min(config.queriesPerJob, plan.keywords.length),
    maxItemsPerQuery: config.maxItemsPerQuery,
    scope: {
      programId: canonicalProgramId,
      canonicalProgramId,
      campaignId: config.campaignId,
    },
  }, config.activationId, nowIso);
  if (!built.ok) return { queued: false, dispatchNeeded: false, reason: built.reasonCode };
  const jobId = text(built.job.idempotencyKey, 180);
  const jobRef = adminDb.collection(SHADOW_JOB_COLLECTION).doc(jobId);
  const receiptRef = adminDb.collection(YTDLP_PROMOTION_RECEIPT_COLLECTION).doc(jobId);
  const campaignRef = adminDb.collection("campaigns").doc(config.campaignId);
  // W77-③: 직전일 관측 수를 같은 트랜잭션에서 함께 읽는다 — 단계 상향 가드의 분모다.
  const previousDayRef = adminDb.collection(YTDLP_PROMOTION_DAILY_COLLECTION)
    .doc(seoulDayKey(Date.parse(nowIso) - 24 * 60 * 60 * 1000));
  const reserved = await adminDb.runTransaction(async (transaction) => {
    const [dailySnapshot, previousDaySnapshot, jobSnapshot, receiptSnapshot] = await Promise.all([
      transaction.get(dailyRef),
      transaction.get(previousDayRef),
      transaction.get(jobRef),
      transaction.get(receiptRef),
    ]);
    if (jobSnapshot.exists) {
      const jobStatus = text(jobSnapshot.data()?.status, 40);
      // 구버전/부분 실패로 job만 남은 경우에도 소비 receipt를 복구한다. 같은 결정적 ID라 중복 생성은 없다.
      if (!receiptSnapshot.exists) {
        transaction.create(receiptRef, {
          id: jobId,
          version: PROMOTION_VERSION,
          status: "awaiting_shadow",
          campaignId: config.campaignId,
          activationId: config.activationId,
          shadowJobRef: jobRef.path,
          shadowRunRef: `${SHADOW_RUN_COLLECTION}/${jobId}`,
          queryPlanHash: built.job.queryPlanHash,
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
        });
      }
      return {
        queued: false,
        dispatchNeeded: jobStatus === "queued",
        reason: "ytdlp_promotion_idempotent_existing_job",
      };
    }
    const daily = dailySnapshot.data() ?? {};
    const jobCount = int(daily.jobCount);
    const queryCount = int(daily.queryCount);
    if (jobCount >= config.dailyJobCap) return {
      queued: false,
      dispatchNeeded: false,
      reason: "ytdlp_promotion_daily_job_cap",
    };
    if (queryCount + plan.keywords.length > config.dailyQueryCap) return {
      queued: false,
      dispatchNeeded: false,
      reason: "ytdlp_promotion_daily_query_cap",
    };
    // W77-③: **단계 상향 가드.** 코드 캡(하루 10,000 관측)은 천장이고, 실제 하루 관측은
    //   직전일의 2배를 넘지 못한다. yt-dlp 는 쿼터를 안 쓰지만 볼륨이 갑자기 뛰는 것 자체가
    //   차단 신호가 된다 — 상한을 크게 열어도 경사는 완만해야 한다는 헤세 지시의 코드 형태다.
    // R1-P0-8: 분모(직전일 observedCount)는 배치가 실제로 처리한 **고유 채널** 수다.
    //   분자를 원시 관측(쿼리×아이템)으로 두면 단위가 어긋나 상한을 즉시 초과하고,
    //   하루 1잡에서 영구 데드락이 난다(리뷰 8일 시뮬레이션). 같은 단위로 추정한다:
    //   쿼리 간 중복을 감안한 고유율(프로드 실측 561/1000 ≈ 0.56)을 보수적으로 적용한다.
    const projectedObservations = Math.min(config.queriesPerJob, plan.keywords.length)
      * config.maxItemsPerQuery;
    const stepUp = withinObservationStepUp({
      observedToday: int(daily.plannedObservationCount),
      // R2-P0-A: 분자·분모를 **같은 필드**로 맞춘다. 종전에는 분자가 예약 추정(planned)이고
      //   분모가 실측 고유 채널(observedCount)이라 단위가 달라, 배포 첫날부터 영구 1잡/일
      //   데드락이 났다(W77 이전 3잡보다 하락). 환산율로 맞추는 방식은 비율이 틀리는 순간
      //   같은 사고가 재발하므로 **필드 자체를 통일**한다.
      observedYesterday: int((previousDaySnapshot.data() ?? {}).plannedObservationCount),
      projected: projectedObservations,
    });
    if (!stepUp.allowed) return {
      queued: false,
      dispatchNeeded: false,
      reason: "ytdlp_promotion_observation_stepup_cap",
    };
    transaction.create(jobRef, { ...built.job, id: jobId });
    transaction.create(receiptRef, {
      id: jobId,
      version: PROMOTION_VERSION,
      status: "awaiting_shadow",
      campaignId: config.campaignId,
      activationId: config.activationId,
      shadowJobRef: jobRef.path,
      shadowRunRef: `${SHADOW_RUN_COLLECTION}/${jobId}`,
      queryPlanHash: built.job.queryPlanHash,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    });
    transaction.set(dailyRef, {
      id: dayKey,
      version: PROMOTION_VERSION,
      campaignId: config.campaignId,
      jobCount: jobCount + 1,
      queryCount: queryCount + plan.keywords.length,
      // W77-③: **예약 기준 관측량.** 다음 잡을 예약할 때 이 값이 단계 상향 가드의 분자가 된다.
      //   실제로 긁힌 수(observedCount)와 별개 축이다 — 예약은 즉시 알 수 있고 실관측은 나중에
      //   들어오므로, 예약축으로 막아야 같은 sweep 안에서 폭주가 안 난다.
      plannedObservationCount: int(daily.plannedObservationCount) + projectedObservations,
      lastJobRef: jobRef.path,
      lastQueryPlanHash: built.job.queryPlanHash,
      updatedAtIso: nowIso,
      createdAtIso: text(daily.createdAtIso) || nowIso,
    }, { merge: true });
    transaction.set(campaignRef, {
      ytdlpPromotionState: {
        rotationTick: plan.nextRotationTick,
        lastJobRef: jobRef.path,
        lastQueuedAtIso: nowIso,
        keywordUniverseSize: plan.keywordUniverse.length,
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { queued: true, dispatchNeeded: true, reason: "queued" };
  });
  return reserved;
}

/** 기존 60분 Functions 스윕이 부르는 단일 W75 단계. 실패는 호스트의 allSettled 격리로 전파된다. */
/**
 * W83: 스윕 단계 주입 이음매.
 *
 * 순서를 값으로 증명하려면 **배치가 느린 상태**를 만들 수 있어야 한다. 실제 사고가 정확히
 * 그 형상(배치가 예산을 다 먹어 예약이 잘림)이었는데, 주입 지점이 없으면 "순서를 바꿨다"를
 * 소스 문자열로밖에 못 본다 — 그건 행동 증명이 아니다.
 * 프로덕션 호출부는 인자를 안 넘기므로 기본 구현 그대로다.
 */
export type YtdlpPromotionSweepDependencies = {
  readonly processClaim: typeof processClaim;
  readonly enqueueNextShadowJob: typeof enqueueNextShadowJob;
  readonly dispatchYtdlpShadowWorker: typeof dispatchYtdlpShadowWorker;
};

export const DEFAULT_YTDLP_PROMOTION_SWEEP_DEPENDENCIES: YtdlpPromotionSweepDependencies = {
  processClaim,
  enqueueNextShadowJob,
  dispatchYtdlpShadowWorker,
};

export async function runYtdlpPromotionSweep(
  dependencies: YtdlpPromotionSweepDependencies = DEFAULT_YTDLP_PROMOTION_SWEEP_DEPENDENCIES,
): Promise<YtdlpPromotionSweepResult> {
  const resolution = await readConfig();
  const base: YtdlpPromotionSweepResult = {
    enabled: resolution.enabled,
    reasonCode: resolution.enabled ? "ok" : resolution.reasonCode,
    runsExamined: 0,
    runsRejected: 0,
    runsClaimed: 0,
    runsCompleted: 0,
    runsDeferred: 0,
    observedUnique: 0,
    eligibleUnique: 0,
    promotedCandidates: 0,
    emailResolved: 0,
    youtubeRecencyCalls: 0,
    shadowJobQueued: false,
    shadowJobReason: "not_attempted",
    shadowWorkerDispatched: false,
    shadowWorkerReason: "not_attempted",
  };
  if (!resolution.enabled) return base;
  const nowIso = new Date().toISOString();
  const config = resolution.config;
  const pending = await readPendingRuns(config, nowIso);
  const runs = pending.runs;
  base.runsExamined = pending.examined;
  base.runsRejected = pending.rejected;
  // 예약·배치 어느 쪽이 먼저 실패하든 첫 실패만 호스트로 올린다(단계 격리는 아래 try 들이 한다).
  let firstFailure: unknown = null;
  // ────────────────────────────────────────────────────────────────────────
  // W83 [운영 실사고 2026-08-15]: **예약·디스패치를 배치 처리보다 앞에 둔다.**
  //
  // 실측: 오늘 `ytdlp_promotion_daily` 에 jobCount 가 없다(observedCount 328 만 있음).
  //   하이드레이션 배치는 processClaim 직렬이고 배치당 ~2분이라, runsPerSweep 4 면
  //   통합 스윕의 300초 예산을 배치가 다 먹고 **enqueueNextShadowJob 까지 도달하지 못한다.**
  //   그 결과 관측 유입이 끊긴 채 소비만 도는 기아가 된다(R3 [A]P1-4 가 경고한 축).
  //
  // 예약은 트랜잭션 1회, 디스패치는 HTTP 1회 — **초 단위**다. 앞에 둬도 소비를 굶기지 않는다.
  // 반대로 뒤에 두면 예산이 빠듯한 날마다 조용히 잘린다. 잘리면 안 되는 쪽을 앞에 둔다.
  //
  // 순서를 바꿔도 판정 입력은 그대로다:
  //   · 단계 상향 가드는 **예약축**(plannedObservationCount)으로만 비교하므로(R2-P0-A)
  //     이 스윕의 배치 처리 결과가 오늘 예약 누적에 섞이지 않는다 — 순서 무관.
  //   · 백오프/디스패치 판정은 `pending`(claims 이전 조회)에서 나온다 — 순서 무관.
  // ────────────────────────────────────────────────────────────────────────
  let planned: ShadowJobPlanResult | null = null;
  try {
    planned = await dependencies.enqueueNextShadowJob(config, nowIso);
    base.shadowJobQueued = planned.queued;
    base.shadowJobReason = planned.reason;
  } catch (error) {
    base.shadowJobReason = "planning_failed";
    if (firstFailure === null) firstFailure = error;
  }
  // 새 예약뿐 아니라 이전 디스패치가 실패해 queued로 남은 durable job도 다음 60분 sweep이 다시 깨운다.
  // 일일 캡만 찬 경우에는 빈 Cloud Run Job을 호출하지 않아 비용 상한을 지킨다.
  //
  // W75-R1 P1-6: **소비자가 없으면 깨우지 않는다.** claim 어댑터가 없는 배포에서는 워커가 즉시
  //   exit 1 로 죽고 잡은 queued 그대로라, 매 sweep 이 헛발을 영원히 반복한다(무한 루프).
  //
  // R1-P1-2: 억제는 **정지한 그 receipt 에만** 적용한다. 종전 전역 스칼라는 정지 1건이
  //   방금 큐잉된 정상 잡까지 영원히 막았다. 깨울 대상이 하나라도 남아 있으면 깨운다.
  if (pending.workerUnconsumedReceiptIds.length > 0) {
    console.warn(JSON.stringify({
      event: "ytdlp_promotion.worker_unconsumed",
      reasonCode: "worker_unconsumed_backoff",
      stalledReceiptIds: pending.workerUnconsumedReceiptIds.slice(0, 5),
      stalledCount: pending.workerUnconsumedReceiptIds.length,
      hint: "shadow claim adapter 가 배포돼 있는지 확인하라(Phase 3 선행 병합).",
    }));
  }
  if (pending.workerDispatchNeeded || planned?.dispatchNeeded) {
    try {
      await dependencies.dispatchYtdlpShadowWorker();
      base.shadowWorkerDispatched = true;
      base.shadowWorkerReason = "dispatched";
    } catch (error) {
      base.shadowWorkerReason = "dispatch_failed";
      if (firstFailure === null) firstFailure = error;
    }
  } else {
    base.shadowWorkerReason = pending.workerUnconsumedReceiptIds.length > 0
      ? "worker_unconsumed_backoff"
      : "not_dispatchable";
  }

  const claims = await claimRunsWithinBudget({
    runs,
    budget: config.runsPerSweep,
    claim: (run) => claimRun(run, nowIso),
  });
  for (const claim of claims) {
    const run = claim.run;
    base.runsClaimed += 1;
    try {
      const result = await dependencies.processClaim(config, claim, nowIso);
      // W75-R1 P2: 누적값이 아니라 **이 배치의 델타**를 더한다(누적을 더하면 이중계상).
      base.observedUnique += int(result.delta.rawObserved);
      base.eligibleUnique += int(result.delta.eligibleUnique);
      base.promotedCandidates += int(result.delta.candidatesCreated);
      base.emailResolved += int(result.delta.emailResolved);
      base.youtubeRecencyCalls += int(result.delta.youtubeRecencyCalls);
      if (result.complete) {
        base.runsCompleted += 1;
      }
      // W75-R1 P1-5: **성공 경로 관측.** 종전에는 실패만 로깅해서, 켰는데 후보가 안 생길 때
      //   "관측이 없었나 / 전부 dedup 됐나 / 정책에서 걸렸나"를 로그로 구분할 수 없었다.
      //   승격 효과(관측→후보 전환·이메일 해소율)가 이 기능의 판단 근거라 반드시 남긴다.
      console.info(JSON.stringify({
        event: "ytdlp_promotion.batch_processed",
        shadowRunId: run.id,
        reasonCode: result.complete ? "run_complete" : "batch_complete",
        attempt: claim.attempt,
        offset: claim.offset,
        // 델타(이 배치) — 합산 축과 같은 값이라 로그와 결과가 갈리지 않는다.
        delta: result.delta,
        // 런 누적 — 다회 배치의 최종 성적표다.
        cumulative: result.counters,
      }));
    } catch (error) {
      // 인시던트 2026-09-29 Codex 리뷰 라운드3: YouTube 쿼터 소진(마커 스킵 — 일일 확정, 또는
      // 라이브 429 — fetchYouTubeRecord 가 own-pool+차용까지 다 써 본 뒤)은 결함이 아니다.
      // recordFailure 로 새면 failureCount 가 늘어 3회 만에 receipt 가 영구 rejected 되고, 매
      // 시간 stage_failed 도 함께 찍힌다 — 둘 다 이 코드 경로가 원래 막으려던 증상이다.
      const isQuotaDeferral = (error as { quotaLimited?: unknown } | null)?.quotaLimited === true
        || (error as { errorCode?: unknown } | null)?.errorCode === "youtube_quota_pool_exhausted";
      if (isQuotaDeferral) {
        const dailyExhausted = (error as { dailyQuotaExhausted?: unknown } | null)?.dailyQuotaExhausted === true;
        const nextEligibleAtIso = dailyExhausted
          ? new Date(Date.parse(nowIso) + QUOTA_DAILY_DEFERRAL_MS).toISOString()
          : null;
        const reasonCode = text((error as { errorCode?: unknown } | null)?.errorCode, 160) || "ytdlp_promotion_quota_deferred";
        try {
          await recordQuotaDeferral(claim, { reasonCode, nextEligibleAtIso }, nowIso);
        } catch (recordError) {
          if (firstFailure === null) firstFailure = recordError;
        }
        base.runsDeferred += 1;
        // info — 스테이지 실패가 아니다(firstFailure 를 세우지 않는다).
        console.info(JSON.stringify({
          event: "ytdlp_promotion.quota_deferred",
          shadowRunId: run.id,
          attempt: claim.attempt,
          offset: claim.offset,
          reasonCode,
          dailyExhausted,
          nextEligibleAtIso,
        }));
        continue;
      }
      try {
        await recordFailure(claim, error, nowIso);
      } catch (recordError) {
        if (firstFailure === null) firstFailure = recordError;
      }
      console.warn(JSON.stringify({
        event: "ytdlp_promotion.batch_failed",
        shadowRunId: run.id,
        attempt: claim.attempt,
        offset: claim.offset,
        reasonCode: text((error as { errorCode?: unknown } | null)?.errorCode, 160)
          || text((error as { message?: unknown } | null)?.message, 160).split(":")[0]
          || "ytdlp_promotion_failed",
      }));
      if (firstFailure === null) firstFailure = error;
    }
  }
  // W77-⑤: **미발송 상비 재고 진행률.** 문서 1개만 읽는 싼 경로다(전수 대조는 재계산 훅에서만).
  //   1만 목표 대비 진행률이 그날 보고의 핵심 숫자라 매 스윕 구조화 로그로 남긴다.
  try {
    // R1-P0-1/2/3: 증분 원장을 버리고 **SoT 센서**를 읽는다(aggregate count 3회).
    //   전이를 전수 배선하는 방식은 배선 하나 빠질 때마다 조용히 틀렸다.
    const inventory = toUnsentInventory(await measureCampaignCandidateInventory(config.campaignId));
    base.unsentInventory = inventory.unsentWithEmail;
    base.unsentInventoryProgress = inventory.progress;
    console.info(JSON.stringify({
      event: "ytdlp_promotion.unsent_inventory",
      target: YTDLP_UNSENT_INVENTORY_TARGET,
      unsentWithEmail: inventory.unsentWithEmail,
      progress: Number(inventory.progress.toFixed(4)),
      // 백필 출처 분리 — 설명란 이메일의 바운스율을 따로 봐야 한다.
      // 진행률이 왜 그 값인지 분해값 없이 숫자만 보고하지 않는다.
      emailCapable: inventory.emailCapable,
      contactedByEmail: inventory.contactedByEmail,
      blockedTargets: inventory.blockedTargets,
    }));
  } catch (error) {
    console.warn(JSON.stringify({
      event: "ytdlp_promotion.unsent_inventory_failed",
      reasonCode: text((error as { message?: unknown } | null)?.message, 160) || "unknown",
    }));
  }
  if (firstFailure !== null) throw firstFailure;
  return base;
}
