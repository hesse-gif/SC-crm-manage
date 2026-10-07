import type { Firestore } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  UID_GUIDE_MAIL_ROLLOUT_DOC_PATH,
  parseUidGuideMailRolloutGate,
} from "./scpUidGuideMailRollout";
import { SCP_RECEIPT_MAIL_AUTOMATION_VERSION } from "./scpReceiptMailOutbox";
import { resolveVideoTitleProjection } from "./videoTitleProjection";
import { SCP_VIDEO_REVIEW_STATE_COLLECTION } from "./videoReviewTransitionStore";

export const SCP_CONTROL_READ_MODEL_VERSION = "scp_automation_control.real_read_model.v1" as const;
export const SCP_CONTROL_DEFAULT_LIMIT = 25;
export const SCP_CONTROL_MAX_LIMIT = 50;

export type ScpControlSourcePath =
  | "scp_video_review_state"
  | "program_applications"
  | "scp_application_management"
  | "programs"
  | "campaigns"
  | "creators"
  | "scp_lifecycle_profiles"
  | "video_performance_report_rows"
  | "videos"
  | "video_view_series"
  | "video_metric_operational_readiness_receipts"
  | "scp_onboarding_outbox"
  | "scp_flu_application_commands"
  | "scp_application_confirmed_mail_outbox"
  | "scp_content_submitted_mail_outbox"
  | "scp_integration_event_v2_uid_guide_outbox"
  | "scp_video_result_mail_outbox"
  // W62c-C2: 재촉 레인. 회계 축에도 등록해야 "읽었는데 안 세는" 구멍이 안 생긴다.
  | "scp_application_video_reminder_outbox";

export type ScpControlPilotRow = {
  id: string;
  review: {
    statePath: string;
    videoSubmissionId: string;
    state: string;
    revision: number;
    isCurrentRevision: boolean;
    contentFingerprint: string;
    policyVersion: string;
    policyConfigHash: string;
    decisionRef: string;
    reviewedAt: string;
    reasonCode: string | null;
    currentRevisionEvidence: "review_state_head";
  };
  application: {
    applicationId: string;
    sourcePath: string;
    status: string;
    submittedAtIso: string;
    managementPath: string;
    classification: string;
  };
  program: { programId: string; sourcePath: string; title: string; status: string };
  campaign: { campaignId: string; sourcePath: string; title: string; status: string };
  creator: { fluCreatorId: string; sourcePath: string; displayName: string; handle: string };
  profile: { profileId: string; sourcePath: string; currentState: string; activeServing: boolean };
  country: { sourcePath: string; declared: string; verified: string; effective: string; state: string };
  video: {
    sourcePath: string;
    exists: boolean;
    youtubeVideoId: string;
    url: string;
    title: string;
    publishedAt: string;
    reportRowPath: string;
    reportRowExists: boolean;
    reportEligible: boolean;
    trackingState: string;
    settlementState: string;
  };
  trend: { sourcePath: string; exists: boolean; watermarkIso: string; totalViews: string; pointCount: number; points: Array<{ timestamp: string; views: string; dailyDeltaViews: string }> };
  provenance: {
    applicationExists: boolean;
    managementExists: boolean;
    programExists: boolean;
    campaignExists: boolean;
    creatorExists: boolean;
    profileExists: boolean;
    countryEvidenceExists: boolean;
    videoExists: boolean;
    trendExists: boolean;
    fullyAttributed: boolean;
    attributionGapReasons: string[];
  };
};

export type ScpControlRealReadModel = {
  version: typeof SCP_CONTROL_READ_MODEL_VERSION;
  generatedAtIso: string;
  sourceWatermarkIso: string | null;
  bounded: {
    requestedLimit: number;
    effectiveLimit: number;
    maxLimit: number;
    queryCount: number;
    documentReadUpperBound: number;
    sourceReads: Record<ScpControlSourcePath, number>;
    indexBackedQueries: string[];
  };
  aggregates: {
    totalRows: number;
    queued: number;
    inReview: number;
    humanReviewRequired: number;
    changesRequested: number;
    approvedCurrent: number;
    rejected: number;
    reportEligible: number;
    trackingEligible: number;
    settlementEligible: number;
    partnerActivationReady: number;
    fullyAttributed: number;
    missingAuthority: number;
  };
  rows: ScpControlPilotRow[];
  operationalReadiness: {
    exact168hOperational: false;
    sourcePath: string;
    blockerCode: string;
    checkedAtIso: string;
  };
  /**
   * 메일 큐 정체 — "보낼 때가 됐는데 워커가 한 번도 집지 않은" 행의 수.
   * 2026-07-27 사고: 온보딩 워커 스케줄러가 07-22부터 PAUSED 였는데, due 인데 attempts=0 인 상태를
   * 어떤 화면도 보여주지 않아 닷새 동안 아무도 몰랐다. 읽기 전용 카운트다(새 컬렉션·스케줄러 없음).
   */
  mailQueue: {
    checkedAtIso: string;
    lanes: ScpMailQueueLaneStall[];
    totalStalled: number;
    totalAwaitingPortalMaterial: number;
    /** 읽지 못한 레인 수. >0 이면 totalStalled 는 하한이다. */
    unavailableLaneCount: number;
    /** W127 [적대 리뷰 N3]: 게이트는 행 히스토그램 항목이 아니라 **설정 상태**다.
     *  사유 카운트가 유일한 운반자면 잔여 0(전 행에 행 사유가 붙은 경우)에서 통째로 사라진다. */
    uidGuideRolloutGate: "open" | "closed" | "unknown";
    queryCount: number;
    documentReadUpperBound: number;
  };
};

export type ScpMailQueueLaneStall = {
  lane: string;
  label: string;
  collection: string;
  /** due && attempts==0 && 워커가 아직 집을 수 있는 상태. 워커가 안 돌고 있다는 신호. */
  stalled: number;
  /**
   * W127: 종결(`closedReason`)된 채 대기 집합에 다시 앉아 있는 행. **`stalled` 에 넣지 않는다.**
   *
   * Portal 이 같은 지원 건을 다시 보내면 멱등 가드가 `dead_letter` 를 `queued` 로 덮는데 merge 라
   * `closedReason` 은 남는다(scpUidGuideMailWorker 의 closedRows 주석 — 실측). 드레인은 그 행을
   * 선택 단계에서 끊으므로 **발송을 기다리는 행이 아니다**. 그런데 `stalled` 에 남겨 두면 게이트가
   * 닫혔을 때 그 행까지 `rollout_gate_closed` 로 그려진다 — 게이트를 열어도 안 나가는 행에 게이트를
   * 사유로 다는 것이라 거짓 사유다. 축을 나눠야 "게이트 때문"과 "이미 종결"이 섞이지 않는다.
   */
  closedWithoutSend: number;
  /**
   * W127 [적대 리뷰 M4]: 그 종결 행들이 **언제부터** 큐에 앉아 있는가. 건수만 있으면 "어제 한 건"과
   * "두 달째 147건"이 같은 회색 한 줄이 된다 — 그 구분 불능이 애초의 사고였다.
   */
  oldestClosedSinceIso: string | null;
  /** 위 시계가 임계(CLOSED_WITHOUT_SEND_STALE_MS)를 넘었다. 임계 정책을 화면이 재구현하지 않게 여기서 판정한다. */
  closedWithoutSendStale: boolean;
  /**
   * 이 레인은 `totalStalled` 롤업에서 빠진다(발송 레인이 아니라 원장이라 소비자가 0인 행이 정상).
   * 화면이 합계와 레인 수치의 차이를 설명할 수 있게 사실을 같이 올린다.
   */
  excludedFromTotals: boolean;
  /**
   * 그중 Portal 전달자료(recipientMaterialState)가 아직 pending 이라 워커가 fail-closed 로
   * 건너뛴 건. 워커는 살아 있으므로 스케줄러 정지와 구분해서 센다.
   */
  awaitingPortalMaterial: number;
  /** W4: 워커가 attempt를 소모하지 않고 건너뛴 비PII 사유 코드별 현재 대기 건수. */
  skipReasonCounts: Record<string, number>;
  oldestWaitingSinceIso: string | null;
  /**
   * 대기 후보가 조회 상한을 넘겼다 — 표시된 수가 전부가 아니다.
   * W127 [적대 리뷰 M7]: 상한 하나를 `stalled` 와 `closedWithoutSend` 가 **나눠 쓴다**. 그래서 이
   * 플래그는 두 수 **모두**의 하한 표기다(화면도 둘 다에 "이상"을 붙인다).
   */
  truncated: boolean;
  /**
   * 이 레인을 읽지 못했다. 0건과 절대 같지 않다 — 화면은 "확인 불가"로 그린다(fail-closed).
   * 조회 실패를 조용히 삼키면 오늘 사고와 똑같이 정체가 안 보인다.
   */
  unavailable: boolean;
};

type DocRow = { id: string; path: string; data: Record<string, unknown> };

function clampLimit(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, SCP_CONTROL_MAX_LIMIT) : SCP_CONTROL_DEFAULT_LIMIT;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function bool(value: unknown): boolean {
  return value === true;
}

function titleOf(row: Record<string, unknown>, fallback: string): string {
  return str(row.title) || str(row.name) || str(row.programName) || str(row.campaignName) || str(row.displayName) || fallback;
}

function latestLedgerEntry(row: Record<string, unknown>): Record<string, unknown> {
  const ledger = Array.isArray(row.reviewLedger) ? row.reviewLedger : [];
  return rec(ledger[ledger.length - 1]);
}

function keySet(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).slice(0, SCP_CONTROL_MAX_LIMIT);
}

function youtubeVideoIdFor(state: Record<string, unknown>, subject: Record<string, unknown>): string {
  return str(state.youtubeVideoId) || str(state.videoId) || str(subject.youtubeVideoId);
}

async function getDocs(collection: string, ids: string[], db: Firestore): Promise<Map<string, DocRow>> {
  const unique = keySet(ids);
  if (unique.length === 0) return new Map();
  const refs = unique.map((id) => db.collection(collection).doc(id));
  const snaps = await db.getAll(...refs);
  const out = new Map<string, DocRow>();
  for (const snap of snaps) {
    if (!snap.exists) continue;
    out.set(snap.id, { id: snap.id, path: snap.ref.path, data: snap.data() ?? {} });
  }
  return out;
}

async function getReportRows(submissionIds: string[], db: Firestore): Promise<Map<string, DocRow>> {
  const unique = keySet(submissionIds);
  const out = new Map<string, DocRow>();
  for (let i = 0; i < unique.length; i += 30) {
    const chunk = unique.slice(i, i + 30);
    if (!chunk.length) continue;
    const snap = await db
      .collection("video_performance_report_rows")
      .where("video.videoSubmissionId", "in", chunk)
      .limit(chunk.length)
      .get();
    for (const doc of snap.docs) {
      const data = doc.data() ?? {};
      const video = rec(data.video);
      const sid = str(video.videoSubmissionId) || doc.id;
      if (!out.has(sid)) out.set(sid, { id: doc.id, path: doc.ref.path, data });
    }
  }
  return out;
}

async function getDescriptiveTrackingRows(knownSubmissionIds: string[], limit: number, db: Firestore): Promise<DocRow[]> {
  const known = new Set(knownSubmissionIds);
  const snap = await db
    .collection("video_performance_report_rows")
    .where("descriptive", "==", true)
    .limit(limit)
    .get();
  const rows: DocRow[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() ?? {};
    const video = rec(data.video);
    const sid = str(video.videoSubmissionId) || doc.id;
    if (known.has(sid)) continue;
    rows.push({ id: doc.id, path: doc.ref.path, data });
  }
  return rows;
}

function rowFromDescriptiveReport(report: DocRow): ScpControlPilotRow {
  const data = report.data;
  const video = rec(data.video);
  const creator = rec(data.creator);
  const scope = rec(data.scope);
  const country = rec(data.country);
  const metrics = rec(data.metrics);
  const settlement = rec(data.settlement);
  const videoSubmissionId = str(video.videoSubmissionId) || report.id;
  const youtubeVideoId = str(video.youtubeVideoId);
  const programId = str(scope.programId) || "unclassified";
  const campaignId = str(scope.campaignId);
  const fluCreatorId = str(creator.fluCreatorId);
  // 제목은 정본 해석기만 통과시킨다. 예전엔 제목이 없으면 youtubeVideoId·제출 UUID 를 제목 자리에
  // 넣어서 운영자가 토큰을 영상 제목으로 읽었다. 붙지 않으면 빈 값으로 두고 화면이 미확인이라 밝힌다.
  const title = resolveVideoTitleProjection(video.title, null).title ?? "";
  return {
    id: report.id,
    review: {
      statePath: "",
      videoSubmissionId,
      state: "tracking_observation",
      revision: 0,
      isCurrentRevision: bool(data.isCurrentRevision),
      contentFingerprint: "",
      policyVersion: "",
      policyConfigHash: "",
      decisionRef: "",
      reviewedAt: str(data.lastSyncedAt) || str(metrics.lastObservedAt),
      reasonCode: null,
      currentRevisionEvidence: "review_state_head",
    },
    application: {
      applicationId: str(scope.enrollmentId),
      sourcePath: "",
      status: "descriptive_tracking",
      submittedAtIso: str(video.publishedAt),
      managementPath: "",
      classification: "unattributed_tracking",
    },
    program: { programId, sourcePath: "", title: str(scope.programName) || programId, status: "" },
    campaign: { campaignId, sourcePath: "", title: str(scope.campaignName) || campaignId, status: "" },
    creator: {
      fluCreatorId,
      sourcePath: "",
      // 폴백 문구는 아래 review-model 행과 동일하게 맞춘다. 예전 폴백은 귀속 여부를 단정하는
      // 문장이었는데, 이 행에도 fluCreatorId 가 붙어 있을 수 있어서 "이름이 비었다"는 사실과
      // 섞으면 안 된다.
      displayName: str(creator.displayName) || "이름 미확인",
      handle: str(creator.handle),
    },
    profile: { profileId: "", sourcePath: "", currentState: "", activeServing: false },
    country: {
      sourcePath: report.path,
      declared: str(country.declared, 8),
      verified: str(country.verified, 8),
      effective: str(country.effective, 8),
      state: str(country.state) || "unresolved",
    },
    video: {
      sourcePath: "",
      exists: Boolean(youtubeVideoId || str(video.canonicalUrl)),
      youtubeVideoId,
      url: str(video.canonicalUrl),
      title,
      publishedAt: str(video.publishedAt),
      reportRowPath: report.path,
      reportRowExists: true,
      reportEligible: bool(data.reportEligible),
      trackingState: str(data.trackingState),
      settlementState: str(settlement.state),
    },
    trend: {
      sourcePath: report.path,
      exists: true,
      watermarkIso: str(metrics.lastObservedAt),
      totalViews: typeof metrics.totalViews === "number" ? String(metrics.totalViews) : str(metrics.totalViews),
      pointCount: 0,
      points: [],
    },
    provenance: {
      applicationExists: false,
      managementExists: false,
      programExists: Boolean(str(scope.programId)),
      campaignExists: Boolean(str(scope.campaignId)),
      creatorExists: Boolean(fluCreatorId),
      profileExists: false,
      countryEvidenceExists: Boolean(str(country.effective, 8) || str(country.verified, 8) || str(country.declared, 8)),
      videoExists: Boolean(youtubeVideoId || str(video.canonicalUrl)),
      trendExists: true,
      fullyAttributed: false,
      attributionGapReasons: ["review_state_missing", "profile_missing", ...(campaignId ? [] : ["campaign_missing"])],
    },
  };
}

// 메일 발송 레인. 컬렉션 이름과 **대기 상태 집합은 각 워커가 실제로 쓰는 due 쿼리에서 가져왔다**
// (추측 금지). 레인마다 상태 필드도 값도 달라서 하나의 공통 규칙으로는 판정할 수 없다.
//
//  - scp_onboarding_outbox           : state          in [queued, failed]  (scpOutboxMailWorkers.ts:693)
//    ⚠️ `blocked` 는 대기가 아니다 — 분류 게이트가 막은 것이라 워커가 다시 집지 않는다.
//  - scp_flu_application_commands    : deliveryState  in [queued, failed]  (scpFluApplicationCommand.ts:668)
//  - scp_application_confirmed_...   : automationVersion == 현재 버전 AND
//                                      deliveryState  in [queued, retryable_failed, recipient_pending]
//                                                                          (scpOutboxMailWorkers.ts:1506-1507,1517-1518)
//  - scp_content_submitted_...       : automationVersion == 현재 버전 AND
//                                      deliveryState  in [queued, retryable_failed, recipient_pending]
//                                                                          (scpOutboxMailWorkers.ts:1222-1223,1233-1234)
//  - scp_integration_event_v2_uid_...: deliveryState  in [queued, retryable_failed]
//                                                                          (scpUidGuideMailWorker.ts:110)
//  - scp_video_result_mail_outbox    : deliveryState  in [queued, leased, retryable_failed]
//                                                                          (scpOutboxMailWorkers.ts:1004)
type MailQueueLaneConfig = {
  lane: string;
  label: string;
  collection: ScpControlSourcePath;
  stateField: "state" | "deliveryState";
  waitingStates: readonly string[];
  /**
   * 워커가 due 쿼리에 함께 거는 동등 조건. 영수증 메일 두 레인은 automationVersion 을 걸기 때문에
   * 이걸 빼면 워커가 집지도 않는 구버전 행까지 정체로 과다 계상된다.
   */
  equalityFilters?: readonly (readonly [field: string, value: string])[];
  /**
   * W127: 이 레인의 대기 건수를 `totalStalled` 합계에서 뺀다.
   *
   * 합계는 "발송이 밀려 있다"는 한 문장을 만드는 숫자다. 발송 레인이 아닌 원장(아래
   * `onboarding_commands`)이 거기 섞이면 그 문장이 거짓이 된다 — 소비자가 0인 것이 정상인 144행이
   * 매일 배너를 켠 채로 두면 배너 자체가 무시된다. 레인 줄은 그대로 남겨 적체는 계속 보이게 하고,
   * 합계에서만 뺀다.
   */
  excludeFromTotals?: boolean;
  /**
   * W127: 행에 `closedReason` 이 있으면 대기가 아니라 **종결**로 센다(위 `closedWithoutSend`).
   * 지금은 UID 안내 레인만 그 규약을 쓴다(종결 스크립트 · 드레인 선택 가드가 그 필드를 본다).
   */
  closedReasonAware?: boolean;
};

const MAIL_QUEUE_LANES: readonly MailQueueLaneConfig[] = [
  { lane: "onboarding", label: "온보딩 메일", collection: "scp_onboarding_outbox", stateField: "state", waitingStates: ["queued", "failed"] },
  // W124 [적대 리뷰 M4②]: 이 레인의 UID 안내 드레인은 폐기됐다(scpFluApplicationCommand 의 폐기 주석).
  //   `queued` 는 더 이상 "워커가 안 돌아서 밀린 발송 대기"가 아니라 **원장에 보관된 접수 상태**다
  //   (접수확인 메일 material 의 sourceEventId · UID 안내 material 의 commandId 가 여기 걸려 있다).
  //   레인을 지우면 승인 온보딩 적체가 안 보이므로 유지하되, 라벨이 사실을 말하게 한다 —
  //   그대로 두면 화면이 144행을 영원히 "정체"로 신고한다.
  //   W127: 같은 이유로 `totalStalled` 합계에서도 뺀다 — 발송이 아닌 행 144건이 합계에 상주하면
  //   "발송 대기 정체 N건" 배너가 상시 켜져 있어 진짜 정체가 묻힌다.
  { lane: "onboarding_commands", label: "온보딩 커맨드 원장(발송 아님 · 드레인 폐기)", collection: "scp_flu_application_commands", stateField: "deliveryState", waitingStates: ["queued", "failed"], excludeFromTotals: true },
  { lane: "application_confirmed", label: "지원 확인 메일", collection: "scp_application_confirmed_mail_outbox", stateField: "deliveryState", waitingStates: ["queued", "retryable_failed", "recipient_pending"], equalityFilters: [["automationVersion", SCP_RECEIPT_MAIL_AUTOMATION_VERSION]] },
  { lane: "content_submitted", label: "콘텐츠 제출 메일", collection: "scp_content_submitted_mail_outbox", stateField: "deliveryState", waitingStates: ["queued", "retryable_failed", "recipient_pending"], equalityFilters: [["automationVersion", SCP_RECEIPT_MAIL_AUTOMATION_VERSION]] },
  { lane: "uid_guide", label: "UID 안내 메일", collection: "scp_integration_event_v2_uid_guide_outbox", stateField: "deliveryState", waitingStates: ["queued", "retryable_failed"], closedReasonAware: true },
  { lane: "video_result", label: "영상 검수 결과 메일", collection: "scp_video_result_mail_outbox", stateField: "deliveryState", waitingStates: ["queued", "leased", "retryable_failed"] },
  // W62c-C2 [두 리뷰 수렴 · 메타 원인]: 재촉 레인을 여기 **등록하지 않으면** 적재만 되고 아무도
  //   소비하지 않는 상태가 화면에서 보이지 않는다. 실제로 1차 구현이 그랬다 — 아웃박스는 만들었는데
  //   드레인이 없었고, "소비자가 존재하는가"를 묻는 테스트가 없어서 아무도 못 봤다.
  //   레인 등록은 그 질문을 상시로 만드는 장치다(적체가 쌓이면 여기서 stalled 로 뜬다).
  { lane: "application_video_reminder", label: "영상 제출 재촉 메일", collection: "scp_application_video_reminder_outbox", stateField: "deliveryState", waitingStates: ["queued", "retryable_failed"] },
];

// 대기 집합만 조회하므로 문서 수가 적다. 상한 +1 을 읽어 초과 여부(truncated)를 정직하게 판정한다.
const MAIL_QUEUE_LANE_CAP = 200;
const VIDEO_RESULT_MAIL_SKIP_REASON_CODES = new Set([
  "recipient_unresolved",
  "correction_link_unavailable",
  "provider_unconfigured",
  "pilot_fence_denied:pilot_fence_closed",
  "pilot_fence_denied:pilot_fence_recipient_denied",
  "pilot_fence_denied:pilot_fence_purpose_denied",
  "pilot_fence_denied:pilot_fence_identity_denied",
  "pilot_fence_denied:pilot_fence_trace_denied",
  "pilot_fence_denied:pilot_fence_generation_denied",
  "pilot_fence_denied:unknown",
]);
// W124 [적체가 보이는 축]: UID 안내 레인의 정체는 이 화면에 **건수만** 떠 있었다(60행). 왜 안 나가는지가
//   없으니 두 달간 아무도 그 60이 "아직 처리 전"이 아니라 "매 패스 거절"이라는 걸 몰랐다.
//   드레인이 무변이 스킵마다 행에 남기는 `lastSkipReason`(scpUidGuideMailWorker.UidGuideDrainSkipReason)을
//   같은 skipReasonCounts 축에 올린다. 영상 결과 레인이 배열(`lastSkipReasonCodes`)인 것과 달리 이
//   레인은 스킵이 항상 단일 사유라 스칼라다 — 그래서 목록도 필드도 따로 둔다.
//   화이트리스트인 이유는 영상 레인과 같다: 드리프트한 값이 조용히 새 축을 만들지 못하게.
// 행에 실제로 기록될 수 있는 사유만 둔다. `rollout_gate_closed` / `closed_without_send` 는
// 여기 없다 — 둘 다 **행에 쓰지 않는 스킵**이기 때문이다(게이트 닫힘은 쓰기 0 계약이고,
// 종결 스킵은 claim 전에 끊는다). 화이트리스트에 두면 영원히 도달 불가 코드가 된다.
// 게이트 닫힘은 아래 UID_GUIDE_ROLLOUT_GATE_CLOSED_REASON 경로가 설정 문서에서 직접 그린다.
// 종결은 W127 이후 사유 축이 아니라 **별도 카운터**(`closedWithoutSend`)다 — 대기가 아닌 행을
// 대기의 사유 분해에 섞으면 사유 합이 stalled 를 넘어 표가 스스로 모순된다.
const UID_GUIDE_MAIL_SKIP_REASON_CODES = new Set([
  "row_fields_missing",
  "retry_backoff",
  "claim_lost",
  "material_binding_absent",
  "material_unavailable",
  "material_expired",
  "send_fence_denied",
]);
/**
 * W127 [적대 리뷰 M4]: 종결 행이 이만큼 오래 큐에 남아 있으면 그건 "방금 종결"이 아니라 **적체**다.
 * 7일인 이유: Portal 재발송 주기(지원 건 revision 갱신)가 그보다 짧아, 일주일이 지나도록 남아 있다면
 * 되살아난 행이 계속 쌓이고 있다는 뜻이다. 임계 정책은 화면이 아니라 여기 한 곳에 둔다.
 */
export const CLOSED_WITHOUT_SEND_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** 게이트가 닫혀 있을 때 UID 레인이 화면에 내는 사유 코드(행이 아니라 설정에서 나온다). */
export const UID_GUIDE_ROLLOUT_GATE_CLOSED_REASON = "rollout_gate_closed" as const;

async function collectMailQueueLane(
  db: Firestore,
  lane: MailQueueLaneConfig,
  nowIso: string,
  /**
   * W124 [적대 리뷰 M4①]: UID 레인 한정. 게이트가 닫혀 있으면 드레인은 **행에 아무것도 쓰지 않으므로**
   * 사유가 행에서 나올 수 없다(그게 "쓰기 0" 계약의 대가다). 그러면 패널에는 147행이 사유 없이
   * 대기로만 떠서, 두 달간 아무도 못 봤던 그 화면이 그대로 재현된다. 그래서 사유를 **설정 문서에서**
   * 가져온다 — 지금 이 순간의 진짜 차단 사유이기도 하다.
   */
  uidGuideRolloutGateClosed = false,
): Promise<ScpMailQueueLaneStall & { readDocuments: number; collection: ScpControlSourcePath }> {
  const base: ScpMailQueueLaneStall & { readDocuments: number; collection: ScpControlSourcePath } = {
    lane: lane.lane,
    label: lane.label,
    collection: lane.collection,
    stalled: 0,
    closedWithoutSend: 0,
    oldestClosedSinceIso: null,
    closedWithoutSendStale: false,
    excludedFromTotals: lane.excludeFromTotals === true,
    awaitingPortalMaterial: 0,
    skipReasonCounts: {},
    oldestWaitingSinceIso: null,
    truncated: false,
    unavailable: false,
    readDocuments: 0,
  };
  let snapshot;
  try {
    // 무순서 표본이 아니라 **대기 상태만** 조회한다. 예전 limit(200) 전체 표본은 대기 행이
    // 표본 밖에 있으면 정체를 0으로 보고했다.
    let query: FirebaseFirestore.Query = db.collection(lane.collection);
    for (const [field, value] of lane.equalityFilters ?? []) {
      query = query.where(field, "==", value);
    }
    snapshot = await query
      .where(lane.stateField, "in", [...lane.waitingStates])
      .limit(MAIL_QUEUE_LANE_CAP + 1)
      .get();
  } catch {
    // 조용히 숨기지 않는다 — 못 읽었다는 사실 자체를 올린다.
    return { ...base, unavailable: true };
  }
  const truncated = snapshot.docs.length > MAIL_QUEUE_LANE_CAP;
  const docs = truncated ? snapshot.docs.slice(0, MAIL_QUEUE_LANE_CAP) : snapshot.docs;
  let stalled = 0;
  let closedWithoutSend = 0;
  let oldestClosedSinceIso: string | null = null;
  let awaitingPortalMaterial = 0;
  let oldestWaitingSinceIso: string | null = null;
  const skipReasonCounts: Record<string, number> = {};
  for (const doc of docs) {
    const data = doc.data() ?? {};
    if (num(data.attempts) !== 0) continue;
    // 언제부터 기다렸나 — 재시도 예정 시각이 없으면 생성 시각이 곧 대기 시작이다.
    const waitingSince = str(data.nextAttemptAtIso) || str(data.sendAfterIso) || str(data.createdAtIso);
    if (!waitingSince || waitingSince > nowIso) continue;
    // W127: 종결된 행은 발송 대기가 아니다 — 드레인이 선택 단계에서 끊는다. 대기로 세면 게이트가
    //   닫혔을 때 이 행까지 게이트 사유로 그려져 **거짓 사유**가 된다(게이트를 열어도 안 나간다).
    //   가장 오래된 대기 시각에도 넣지 않는다 — 종결된 행은 그 시계의 대상이 아니다.
    if (lane.closedReasonAware && str(data.closedReason)) {
      closedWithoutSend += 1;
      // M4: 종결 행의 시계는 대기 시계와 **다른 축**이다. 섞지 않고 따로 가장 오래된 것을 남긴다.
      if (!oldestClosedSinceIso || waitingSince < oldestClosedSinceIso) oldestClosedSinceIso = waitingSince;
      continue;
    }
    stalled += 1;
    if (str(data.recipientMaterialState) === "pending") awaitingPortalMaterial += 1;
    if (lane.lane === "video_result" && Array.isArray(data.lastSkipReasonCodes)) {
      const reasonCodes = new Set(
        data.lastSkipReasonCodes.filter(
          (value): value is string =>
            typeof value === "string" &&
            VIDEO_RESULT_MAIL_SKIP_REASON_CODES.has(value),
        ),
      );
      for (const reasonCode of reasonCodes) {
        skipReasonCounts[reasonCode] = (skipReasonCounts[reasonCode] ?? 0) + 1;
      }
    }
    if (lane.lane === "uid_guide") {
      const reasonCode = str(data.lastSkipReason);
      if (UID_GUIDE_MAIL_SKIP_REASON_CODES.has(reasonCode)) {
        skipReasonCounts[reasonCode] = (skipReasonCounts[reasonCode] ?? 0) + 1;
      }
    }
    if (!oldestWaitingSinceIso || waitingSince < oldestWaitingSinceIso) oldestWaitingSinceIso = waitingSince;
  }
  // 게이트가 닫혀 있으면 그 사실이 화면에 있어야 한다(없으면 W124 처럼 사유 없는 대기만 뜬다).
  //
  // W127 [적대 리뷰 M1·M2]: 다만 **대기 전량**에 붙이면 안 된다. 그러면 행 사유를 가진 행이 두 번
  //   세어져 `사유 합 > stalled` 가 되고, 바로 위 화이트리스트 주석이 금지하는 자기모순 표가 된다.
  //   그리고 행 사유가 있는 행에 게이트를 다는 것 자체가 거짓 사유다 — 게이트를 열어도 그 행은
  //   `material_unavailable` 로 그대로 서 있다. 그래서 **지금 막는 유일한 사유가 게이트인 행**,
  //   즉 행 사유가 하나도 없는 잔여분에만 배정한다. 그 결과 사유 합 == stalled 로 보존된다.
  //   M2: 게이트 키를 스프레드 **뒤**에 둔다 — 충돌 시 어느 쪽이 이기는지가 코드에 드러나야 한다
  //   (실제로는 게이트 코드가 행 화이트리스트에 없어 충돌이 불가능하다).
  //   `closedReason` 행은 애초에 stalled 에서 빠졌으므로 이 사유가 붙지 않는다(위 참조).
  const rowReasonTotal = Object.values(skipReasonCounts).reduce((sum, count) => sum + count, 0);
  const gateOnlyStalled = Math.max(0, stalled - rowReasonTotal);
  const effectiveSkipReasonCounts =
    lane.lane === "uid_guide" && uidGuideRolloutGateClosed && gateOnlyStalled > 0
      ? { ...skipReasonCounts, [UID_GUIDE_ROLLOUT_GATE_CLOSED_REASON]: gateOnlyStalled }
      : skipReasonCounts;

  return {
    ...base,
    stalled,
    closedWithoutSend,
    oldestClosedSinceIso,
    closedWithoutSendStale: oldestClosedSinceIso !== null
      && Date.parse(nowIso) - Date.parse(oldestClosedSinceIso) >= CLOSED_WITHOUT_SEND_STALE_MS,
    awaitingPortalMaterial,
    skipReasonCounts: Object.fromEntries(
      Object.entries(effectiveSkipReasonCounts).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    oldestWaitingSinceIso,
    truncated,
    readDocuments: snapshot.docs.length,
  };
}

async function collectMailQueueStalls(
  db: Firestore,
  nowIso: string,
): Promise<{ mailQueue: ScpControlRealReadModel["mailQueue"]; readDocumentsByCollection: Map<ScpControlSourcePath, number> }> {
  // 설정 문서 1건. 읽기 실패는 **닫힘으로 보지 않는다** — 못 읽었는데 "게이트 때문"이라고 그리면
  // 거짓 사유가 된다. 그 경우 종전처럼 행 사유만 그린다(파서 자체는 fail-closed 라 발송 쪽은 안전).
  //
  // W127 [적대 리뷰 N3]: 게이트 상태 자체는 스냅샷 축으로 승격한다(불리언이 아니라 3상태) — 레인이
  // `unavailable` 로 지키는 원칙과 같다: 못 읽었을 때 "열림"으로 접으면 거짓으로 열렸다고 말하는
  // 것이고, "닫힘"으로 접으면 거짓 사유를 만든다. 그래서 읽기 실패는 반드시 "unknown"이다.
  let uidGuideRolloutGate: "open" | "closed" | "unknown" = "unknown";
  try {
    const [gateCollection, gateDocId] = UID_GUIDE_MAIL_ROLLOUT_DOC_PATH.split("/");
    const gateSnapshot = await db.collection(gateCollection).doc(gateDocId).get();
    uidGuideRolloutGate = parseUidGuideMailRolloutGate(
      gateSnapshot.exists ? (gateSnapshot.data() ?? null) : null,
    ).deliveryEnabled
      ? "open"
      : "closed";
  } catch {
    uidGuideRolloutGate = "unknown";
  }
  // 행 사유 주입은 현행 동작 그대로 "닫힘"일 때만 건다 — "모름"에 "게이트 때문"이라는 거짓 사유를
  // 달지 않는다(위와 같은 fail-closed 원칙).
  const uidGuideRolloutGateClosed = uidGuideRolloutGate === "closed";
  const results = await Promise.all(
    MAIL_QUEUE_LANES.map((lane) => collectMailQueueLane(db, lane, nowIso, uidGuideRolloutGateClosed)),
  );
  const readDocumentsByCollection = new Map<ScpControlSourcePath, number>();
  for (const result of results) {
    readDocumentsByCollection.set(result.collection, result.readDocuments);
  }
  // 0건이고 읽기도 성공한 레인은 화면에 줄을 만들지 않는다. 못 읽은 레인은 반드시 남긴다.
  // W127: 종결 행만 있는 레인도 줄을 남긴다 — 대기에서 뺐다고 화면에서 지우면 "되살아난 종결 행"이
  //   조용해질 뿐 사라지지 않는다(그 형상이 다시 안 보이게 되는 것이 애초의 사고다).
  const lanes = results
    .filter((result) => result.stalled > 0 || result.closedWithoutSend > 0 || result.unavailable)
    .map(({ readDocuments: _readDocuments, ...lane }) => lane);
  return {
    mailQueue: {
      checkedAtIso: nowIso,
      lanes,
      // W127: 합계는 **발송 레인만** 센다. 원장 레인(excludedFromTotals)은 줄로는 보이되 합계에서
      //   빠진다 — 소비자가 0인 것이 정상인 행이 배너를 상시 켜 두면 배너가 무시된다.
      totalStalled: lanes.reduce(
        (total, lane) => total + (lane.excludedFromTotals ? 0 : lane.stalled),
        0,
      ),
      // W127 [적대 리뷰 M5]: 위 totalStalled 와 **같은 제외**를 건다. 바로 옆줄이 비대칭이면
      //   어느 쪽이 의도인지 읽는 사람이 알 수 없고, 원장 레인이 자료 대기 합계만 오염시킨다.
      totalAwaitingPortalMaterial: lanes.reduce(
        (total, lane) => total + (lane.excludedFromTotals ? 0 : lane.awaitingPortalMaterial),
        0,
      ),
      unavailableLaneCount: lanes.filter((lane) => lane.unavailable).length,
      // W127 [적대 리뷰 N3]: 게이트는 행 히스토그램이 아니라 설정 상태다 — 전 행에 행 사유가 붙어
      //   사유 잔여가 0이어도 이 필드는 남아 게이트 사실을 전달한다.
      uidGuideRolloutGate,
      // +1: UID 레인 롤아웃 게이트 설정 문서(위) — 조회 1건 · 문서 1건.
      queryCount: MAIL_QUEUE_LANES.length + 1,
      documentReadUpperBound: MAIL_QUEUE_LANES.length * MAIL_QUEUE_LANE_CAP + 1,
    },
    readDocumentsByCollection,
  };
}

export async function buildRealScpAutomationControlReadModel(options: {
  limit?: unknown;
  now?: Date;
  firestore?: Firestore;
} = {}): Promise<ScpControlRealReadModel> {
  const db = options.firestore ?? adminDb;
  const effectiveLimit = clampLimit(options.limit);
  const nowIso = (options.now ?? new Date()).toISOString();
  const reviewSnap = await db
    .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION)
    .orderBy("updatedAtIso", "desc")
    .limit(effectiveLimit)
    .get();
  const reviewRows: DocRow[] = reviewSnap.docs.map((doc) => ({ id: doc.id, path: doc.ref.path, data: doc.data() ?? {} }));

  const subjects = reviewRows.map((row) => rec(row.data.subject));
  const applicationIds = keySet(subjects.map((s) => str(s.applicationId)));
  const programIds = keySet(reviewRows.map((row, index) => str(row.data.canonicalProgramId) || str(subjects[index].programId)));
  const campaignIds = keySet(subjects.map((s) => str(s.campaignId)));
  const creatorIds = keySet(subjects.map((s) => str(s.fluCreatorId)));
  const submissionIds = keySet(subjects.map((s, index) => str(s.videoSubmissionId) || reviewRows[index].id));
  const youtubeIds = keySet(reviewRows.map((row, index) => youtubeVideoIdFor(row.data, subjects[index])));

  const [applications, management, programs, campaigns, creators, profiles, reportRows, videos, descriptiveReports] = await Promise.all([
    getDocs("program_applications", applicationIds, db),
    getDocs("scp_application_management", applicationIds, db),
    getDocs("programs", programIds, db),
    getDocs("campaigns", campaignIds, db),
    getDocs("creators", creatorIds, db),
    getDocs("scp_lifecycle_profiles", applicationIds, db),
    getReportRows(submissionIds, db),
    getDocs("videos", youtubeIds, db),
    getDescriptiveTrackingRows(submissionIds, effectiveLimit, db),
  ]);
  const [series, readinessSnap] = await Promise.all([
    getDocs("video_view_series", youtubeIds, db),
    db.collection("video_metric_operational_readiness_receipts").orderBy("createdAtIso", "desc").limit(1).get().catch(() => null),
  ]);
  const readinessDoc = readinessSnap?.docs?.[0];
  const readinessData = readinessDoc?.data() ?? {};
  const { mailQueue, readDocumentsByCollection: mailQueueReads } = await collectMailQueueStalls(db, nowIso);

  const sourceReads: Record<ScpControlSourcePath, number> = {
    scp_video_review_state: reviewRows.length,
    program_applications: applications.size,
    scp_application_management: management.size,
    programs: programs.size,
    campaigns: campaigns.size,
    creators: creators.size,
    scp_lifecycle_profiles: profiles.size,
    video_performance_report_rows: reportRows.size + descriptiveReports.length,
    videos: videos.size,
    video_view_series: series.size,
    video_metric_operational_readiness_receipts: readinessDoc ? 1 : 0,
    // 메일 레인은 대기 상태만 조회한다 — 실제로 읽은 문서 수를 그대로 회계에 넣는다.
    scp_onboarding_outbox: mailQueueReads.get("scp_onboarding_outbox") ?? 0,
    scp_flu_application_commands: mailQueueReads.get("scp_flu_application_commands") ?? 0,
    scp_application_confirmed_mail_outbox: mailQueueReads.get("scp_application_confirmed_mail_outbox") ?? 0,
    scp_content_submitted_mail_outbox: mailQueueReads.get("scp_content_submitted_mail_outbox") ?? 0,
    scp_integration_event_v2_uid_guide_outbox: mailQueueReads.get("scp_integration_event_v2_uid_guide_outbox") ?? 0,
    scp_video_result_mail_outbox: mailQueueReads.get("scp_video_result_mail_outbox") ?? 0,
    scp_application_video_reminder_outbox: mailQueueReads.get("scp_application_video_reminder_outbox") ?? 0,
  };

  const reviewModelRows: ScpControlPilotRow[] = reviewRows.map((row, index) => {
    const state = row.data;
    const subject = subjects[index];
    const ledger = latestLedgerEntry(state);
    const applicationId = str(subject.applicationId);
    const programId = str(state.canonicalProgramId) || str(subject.programId);
    const campaignId = str(subject.campaignId);
    const fluCreatorId = str(subject.fluCreatorId);
    const videoSubmissionId = str(subject.videoSubmissionId) || row.id;
    const youtubeVideoId = youtubeVideoIdFor(state, subject);
    const app = applications.get(applicationId);
    const mgmt = management.get(applicationId);
    const program = programs.get(programId);
    const campaign = campaigns.get(campaignId);
    const creator = creators.get(fluCreatorId);
    const profile = profiles.get(applicationId);
    const report = reportRows.get(videoSubmissionId);
    const reportData = report?.data ?? {};
    const reportVideo = rec(reportData.video);
    const reportCountry = rec(reportData.country);
    const reportSettlement = rec(reportData.settlement);
    const video = videos.get(youtubeVideoId);
    const trend = series.get(youtubeVideoId);
    const videoData = video?.data ?? {};
    const trendData = trend?.data ?? {};
    const revision = num(state.revision);
    const subjectRevision = num(subject.videoRevision);
    const trendPoints = Array.isArray(trendData.points)
      ? trendData.points.slice(-14).map((point) => {
        const p = rec(point);
        return {
          timestamp: str(p.timestamp, 40) || str(p.date, 20),
          views: typeof p.views === "number" ? String(p.views) : str(p.views, 40),
          dailyDeltaViews: typeof p.dailyDeltaViews === "number" ? String(p.dailyDeltaViews) : str(p.dailyDeltaViews, 40),
        };
      }).filter((point) => point.timestamp)
      : [];
    const isCurrentRevision = Number.isInteger(revision) && revision > 0 && revision === subjectRevision && !bool(state.superseded) && !bool(state.withdrawn);
    const countryEvidenceExists = Boolean(report && (str(reportCountry.effective, 8) || str(reportCountry.verified, 8) || str(reportCountry.declared, 8)));
    const attributionGapReasons = [
      !creator ? "creator_missing" : "",
      !profile ? "profile_missing" : "",
      !program ? "program_missing" : "",
      !campaign ? "campaign_missing" : "",
      !countryEvidenceExists ? "country_evidence_missing" : "",
      !video ? "video_missing" : "",
    ].filter(Boolean);
    const fullyAttributed = attributionGapReasons.length === 0;
    return {
      id: row.id,
      review: {
        statePath: row.path,
        videoSubmissionId,
        state: str(state.state) || "queued",
        revision,
        isCurrentRevision,
        contentFingerprint: str(state.contentFingerprint) || str(subject.contentFingerprint),
        policyVersion: str(subject.policyVersion) || str(state.policyConfigHash),
        policyConfigHash: str(state.policyConfigHash),
        decisionRef: str(ledger.decisionRef),
        reviewedAt: str(ledger.reviewedAt) || str(ledger.atIso) || str(state.reviewedAtIso),
        reasonCode: str(ledger.reasonCode) || null,
        currentRevisionEvidence: "review_state_head",
      },
      application: {
        applicationId,
        sourcePath: app?.path ?? "",
        status: str(app?.data.status) || str(app?.data.finalVerdict) || "unknown",
        submittedAtIso: str(app?.data.submittedAtIso) || str(mgmt?.data.submittedAtIso),
        managementPath: mgmt?.path ?? "",
        classification: str(mgmt?.data.classification),
      },
      program: { programId, sourcePath: program?.path ?? "", title: titleOf(program?.data ?? {}, programId), status: str(program?.data.status) },
      campaign: { campaignId, sourcePath: campaign?.path ?? "", title: titleOf(campaign?.data ?? {}, campaignId), status: str(campaign?.data.status) },
      creator: {
        fluCreatorId,
        sourcePath: creator?.path ?? "",
        // 붙지 않는 신원을 Firestore 문서 id 로 메우지 않는다 — 화면이 UUID 를 사람 이름으로 읽는다.
        displayName: str(creator?.data.displayName) || str(creator?.data.name) || str(rec(reportData.creator).displayName) || "이름 미확인",
        handle: str(creator?.data.handle) || str(rec(reportData.creator).handle),
      },
      profile: {
        profileId: str(profile?.data.profileId) || profile?.id || applicationId,
        sourcePath: profile?.path ?? "",
        currentState: str(profile?.data.currentState),
        activeServing: bool(profile?.data.activeServing),
      },
      country: {
        sourcePath: report?.path ?? "",
        declared: str(reportCountry.declared, 8),
        verified: str(reportCountry.verified, 8),
        effective: str(reportCountry.effective, 8),
        state: str(reportCountry.state) || "unresolved",
      },
      video: {
        sourcePath: video?.path ?? "",
        exists: Boolean(video),
        youtubeVideoId,
        url: str(state.youtubeUrl) || str(reportVideo.canonicalUrl) || str(videoData.youtubeUrl) || str(videoData.url),
        // 리포트행·videos 어느 쪽도 그냥 쓰면 사내 라벨이 실제 제목처럼 박힌다.
        // 스냅샷이 확인해 준 제목만 승격하는 정본 해석기를 거친다.
        title:
          resolveVideoTitleProjection(reportVideo.title, videoData).title ?? "",
        publishedAt: str(reportVideo.publishedAt) || str(videoData.publishedAtIso) || str(videoData.publishedIso),
        reportRowPath: report?.path ?? "",
        reportRowExists: Boolean(report),
        reportEligible: bool(reportData.reportEligible),
        trackingState: str(reportData.trackingState),
        settlementState: str(reportSettlement.state),
      },
      trend: {
        sourcePath: trend?.path ?? "",
        exists: Boolean(trend),
        watermarkIso: str(trendData.updatedAtIso) || str(trendData.lastObservedAtIso) || str(trendData.watermarkIso),
        totalViews: typeof trendData.totalViews === "number" ? String(trendData.totalViews) : str(trendData.totalViews),
        pointCount: trendPoints.length || (Number.isFinite(Number(trendData.dayCount)) ? Number(trendData.dayCount) : 0),
        points: trendPoints,
      },
      provenance: {
        applicationExists: Boolean(app),
        managementExists: Boolean(mgmt),
        programExists: Boolean(program),
        campaignExists: Boolean(campaign),
        creatorExists: Boolean(creator),
        profileExists: Boolean(profile),
        countryEvidenceExists,
        videoExists: Boolean(video),
        trendExists: Boolean(trend),
        fullyAttributed,
        attributionGapReasons,
      },
    };
  });

  const rows: ScpControlPilotRow[] = [...reviewModelRows, ...descriptiveReports.map(rowFromDescriptiveReport)].slice(0, effectiveLimit);

  const aggregates = {
    totalRows: rows.length,
    queued: rows.filter((r) => r.review.state === "queued").length,
    inReview: rows.filter((r) => r.review.state === "in_review").length,
    humanReviewRequired: rows.filter((r) => r.review.state === "human_review_required").length,
    changesRequested: rows.filter((r) => r.review.state === "changes_requested").length,
    approvedCurrent: rows.filter((r) => r.review.state === "approved" && r.review.isCurrentRevision).length,
    rejected: rows.filter((r) => r.review.state === "rejected").length,
    reportEligible: rows.filter((r) => r.video.reportEligible).length,
    trackingEligible: reviewRows.filter((r) => bool(r.data.trackingEligible)).length + descriptiveReports.filter((r) => str(r.data.trackingState) === "active").length,
    settlementEligible: reviewRows.filter((r) => bool(r.data.settlementEligible)).length,
    partnerActivationReady: rows.filter((r) => r.review.state === "approved" && r.review.isCurrentRevision && r.provenance.managementExists && r.provenance.profileExists).length,
    fullyAttributed: rows.filter((r) => r.provenance.fullyAttributed).length,
    missingAuthority: rows.filter((r) => !r.review.isCurrentRevision || !r.review.contentFingerprint || !r.review.policyVersion || !r.review.policyConfigHash).length,
  };

  const queryCount = 1 + Math.ceil(submissionIds.length / 30);
  return {
    version: SCP_CONTROL_READ_MODEL_VERSION,
    generatedAtIso: nowIso,
    sourceWatermarkIso: rows[0]?.review.reviewedAt || str(reviewRows[0]?.data.updatedAtIso) || null,
    bounded: {
      requestedLimit: typeof options.limit === "number" ? options.limit : SCP_CONTROL_DEFAULT_LIMIT,
      effectiveLimit,
      maxLimit: SCP_CONTROL_MAX_LIMIT,
      // 메일 레인 조회도 이 회계에 포함한다 — 예산에 안 잡히는 조회를 몰래 늘리지 않는다.
      queryCount: queryCount + 1 + mailQueue.queryCount,
      documentReadUpperBound: effectiveLimit * 10 + 1 + mailQueue.documentReadUpperBound,
      sourceReads,
      indexBackedQueries: [
        `scp_video_review_state.orderBy(updatedAtIso desc).limit(${effectiveLimit})`,
        "video_performance_report_rows.where(video.videoSubmissionId in <=30).limit(chunkLength)",
        `video_performance_report_rows.where(descriptive == true).limit(${effectiveLimit})`,
        "direct document getAll by authoritative ids for program_applications/scp_application_management/programs/campaigns/creators/scp_lifecycle_profiles/videos/video_view_series",
        "video_metric_operational_readiness_receipts.orderBy(createdAtIso desc).limit(1)",
        `mail queue lanes: <collection>.where(<state field> in <waiting states>).limit(${MAIL_QUEUE_LANE_CAP + 1}) x ${MAIL_QUEUE_LANES.length}`,
      ],
    },
    aggregates,
    rows,
    mailQueue,
    operationalReadiness: {
      exact168hOperational: false,
      sourcePath: readinessDoc?.ref.path ?? "",
      blockerCode: str(readinessData.blockerCode) || str(readinessData.reasonCode) || "exact168h_operational_proof_missing",
      checkedAtIso: str(readinessData.createdAtIso) || str(readinessData.assessedAtIso) || str(readinessData.checkedAtIso) || nowIso,
    },
  };
}
