// Firestore CAS store for the canonical review transition (handoff §4). Composes the pure
// videoReviewTransitionCore + downstreamEligibilityCore over additive collections. One transaction
// atomically: CAS-checks the current revision/fingerprint/program/policy, persists the transition,
// appends the append-only review ledger, sets approved-only downstream eligibility, and enqueues the
// Portal review-callback + creator-result-mail outboxes. External sends happen in retryable
// post-commit workers (fail-closed transport:"unconfigured" until secrets bind). No raw PII stored.

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  VIDEO_REVIEW_TRANSITION_VERSION,
  normalizeLegacyReviewState,
  planVideoReviewTransition,
  type ActorType,
  type EvidenceRisk,
  type VideoReviewState,
} from "./videoReviewTransitionCore";
import { computeDownstreamEligibility } from "./downstreamEligibilityCore";
import { projectScpApprovedFeed } from "./scpApprovedFeed";
import {
  applyPartnerActivationWrites,
  buildPartnerActivationRefs,
  PartnerActivationError,
  readPartnerActivationTransactionContext,
  type PartnerActivationTransactionContext,
} from "./partnerActivationStore";
import { partnerActivationEventId, type PartnerActivationResult, type VideoReviewSubject } from "./partnerActivationCore";
// W122: the review-doc id derivation and the subject normalizer moved to a pure module so every
// reader/writer of this collection shares ONE definition (a repair lane that re-derives either of
// them by hand silently misses documents). Re-exported here to keep existing importers working.
import { reviewDocId, subjectFromReviewStateData } from "./videoReviewSubjectShape";
// Task-53: 판정이 실제로 상태를 바꾸면(아래 `applied: true`) 검수 큐 배지·포털 별칭 스플라이스
// 캐시 중 영향받는 항목만 비운다(reviewQueueCountsCache.ts 의 유일한 저수준 무효화 진입점). 이
// 함수가 사람 판정(videoReviewTransitionCallables.ts) 뿐 아니라 AI 자동 판정
// (videoReviewAnalysisJudge.ts)·시트 동기화(scpSheetReviewSync.ts)·포털 통합 이벤트
// (scpIntegrationEventV2.ts)의 공통 경유지다 — 단, review-state 를 바꾸는 또 다른 경로인
// scpVideoRevisionIngress.ts(reserveAndUpsertVideoRevision)는 이 함수를 거치지 않으므로 거기서
// 별도로 같은 진입점을 부른다(적대 리뷰 2026-09-11 정정).
import { invalidateReviewQueueCachesForWrite } from "./reviewQueueCountsCache";
// Task-100: reasonCode 표준화(갭 ②) + 재제출 사이클 원장(갭 ①). 이 함수가 유일한 쓰기 경로라는
// 성질을 그대로 재사용한다 — 네 개 생산 레인(AI 판정·시트 동기화·포털 통합 이벤트·운영자 패널)
// 전부 여기를 지나므로 여기 한 곳에만 훅을 걸면 전부 커버된다.
import { normalizeVideoReviewReasonCode } from "./videoReviewReasonCodeCatalog";
import {
  buildResubmissionCycleCreatedDoc,
  buildResubmissionCycleResolvedPatch,
  buildResubmissionCycleUndonePatch,
  resubmissionCycleDocId,
  VIDEO_RESUBMISSION_CYCLE_COLLECTION,
} from "./videoResubmissionCycleCore";
import { readResubmissionCyclePolicy, type ResubmissionCyclePolicy } from "./resubmissionCyclePolicy";

export { reviewDocId, subjectFromReviewStateData };


export const SCP_VIDEO_REVIEW_STATE_COLLECTION = "scp_video_review_state";
export const SCP_VIDEO_REVIEW_CALLBACK_OUTBOX_COLLECTION = "scp_video_review_callback_outbox";
export const SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION = "scp_video_result_mail_outbox";
export const SCP_VIDEO_DOWNSTREAM_CALLBACK_OUTBOX_COLLECTION = "scp_video_downstream_callback_outbox";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const SAFE_EVIDENCE_TOKEN_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const SAFE_EVIDENCE_URI_RE = /^evidence:\/\/[A-Za-z0-9._:/-]{1,480}$/;
const SAFE_EVIDENCE_DIGEST_RE = /^[a-f0-9]{16,128}$/i;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_CHANNEL_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;

function safeEvidenceToken(value: unknown): string | null {
  const clean = typeof value === "string" ? value.trim() : "";
  return SAFE_EVIDENCE_TOKEN_RE.test(clean) ? clean : null;
}

function sanitizeDecisionEvidenceItem(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const kind = safeEvidenceToken(input.kind);
  if (!kind) return null;
  const out: Record<string, unknown> = { kind };
  for (const key of ["ruleId", "verdict", "assessment", "applicability"] as const) {
    const token = safeEvidenceToken(input[key]);
    if (token) out[key] = token;
  }
  const digest = typeof input.sourceRefDigest === "string" ? input.sourceRefDigest.trim() : "";
  if (SAFE_EVIDENCE_DIGEST_RE.test(digest)) out.sourceRefDigest = digest;
  const uri = typeof input.uri === "string" ? input.uri.trim() : "";
  if (SAFE_EVIDENCE_URI_RE.test(uri)) out.uri = uri;
  const videoId = typeof input.videoId === "string" ? input.videoId.trim() : "";
  if (YOUTUBE_VIDEO_ID_RE.test(videoId)) out.videoId = videoId;
  const channelId = typeof input.channelId === "string" ? input.channelId.trim() : "";
  if (YOUTUBE_CHANNEL_ID_RE.test(channelId)) out.channelId = channelId;
  const country = typeof input.verifiedCountry === "string" ? input.verifiedCountry.trim().toUpperCase() : "";
  if (/^[A-Z]{2}$/.test(country)) out.verifiedCountry = country;
  if (typeof input.historicalAttribution === "boolean") out.historicalAttribution = input.historicalAttribution;
  return out;
}

function boundedDecisionEvidence(value: unknown, fallback: Record<string, unknown>): Record<string, unknown>[] {
  const sanitized = Array.isArray(value)
    ? value.slice(0, 20).map(sanitizeDecisionEvidenceItem).filter((item): item is Record<string, unknown> => item !== null)
    : [];
  const bounded = Buffer.byteLength(JSON.stringify(sanitized), "utf8") <= 8192 ? sanitized : sanitized.slice(0, 5);
  return bounded.length > 0 ? bounded : [fallback];
}

// Task-94: the auto-reject core's threshold/measured-value snapshot for audit. Flat, primitive-only
// (never nested objects/arrays) — bounded the same way the decision evidence array above is.
const AUTO_REJECT_EVIDENCE_MAX_KEYS = 12;
const AUTO_REJECT_EVIDENCE_KEY_RE = /^[A-Za-z0-9_]{1,60}$/;
const AUTO_REJECT_EVIDENCE_STRING_MAX = 200;

function sanitizeAutoRejectEvidence(value: unknown): Record<string, string | number | boolean> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= AUTO_REJECT_EVIDENCE_MAX_KEYS) break;
    if (!AUTO_REJECT_EVIDENCE_KEY_RE.test(key)) continue;
    if (typeof raw === "string") {
      const trimmed = raw.trim().slice(0, AUTO_REJECT_EVIDENCE_STRING_MAX);
      if (!trimmed) continue;
      out[key] = trimmed;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    } else if (typeof raw === "boolean") {
      out[key] = raw;
    } else {
      continue;
    }
    count += 1;
  }
  return count > 0 ? out : null;
}

const UNDO_NOTE_MAX_LENGTH = 500;
function sanitizeUndoNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, UNDO_NOTE_MAX_LENGTH);
  return trimmed || null;
}

const APPEAL_MESSAGE_MAX_LENGTH = 1000;
function sanitizeAppealMessage(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, APPEAL_MESSAGE_MAX_LENGTH) : "";
}

function strictOrNowIso(value: unknown, nowIso: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : nowIso;
}

export class VideoReviewTransitionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "VideoReviewTransitionError";
  }
}

export type TransitionCommandInput = {
  submissionId: string;
  targetStatus: VideoReviewState;
  reasonCode?: string | null;
  customerMessageCode?: string | null;
  /** W102: 콜러블에서 검증 완료된 운영자 편집 문안 — 원장·메일 아웃박스에 그대로 동봉된다. */
  operatorMessage?: string | null;
  /**
   * W121: 콜러블에서 closed 카탈로그 검증을 끝낸 사유 태그 키(순서 = 메일 불릿 순서).
   * 문장이 아니라 **키**만 여기까지 온다 — 문장은 드레인 렌더러가 서버 사전으로 만든다.
   */
  reasonTagKeys?: readonly string[] | null;
  expectedRevision: number;
  expectedContentFingerprint: string;
  expectedCanonicalProgramId: string;
  expectedPolicyConfigHash: string;
  decisionRef: string;
  actorType: ActorType;
  actorId: string;
  notifyCreator?: boolean;
  aiAutoPilotEnabled?: boolean;
  evidenceRisk?: EvidenceRisk;
  evidence?: unknown[];
  deliveryMode?: "live" | "historical_import";
  /**
   * Task-94: only meaningful for the `rejected -> human_review_required` undo edge (operator undo
   * or creator appeal). When provided, the CURRENT ledger length (= seq of the decision about to be
   * undone) must equal this value or the transition fails closed — protects an operator/creator from
   * undoing a DIFFERENT, newer rejection than the one they actually saw.
   */
  expectedSeq?: number | null;
  /**
   * Task-94: required whenever this call performs the `rejected -> human_review_required` undo
   * edge; recorded verbatim on the new ledger entry so "why did this return to human review" is
   * always answerable from the ledger alone.
   */
  undoReason?: "operator_undo" | "creator_appeal" | null;
  /** Task-94: free-text operator/creator note accompanying an undo/appeal (bounded, sanitized). */
  undoNote?: string | null;
  /**
   * Task-94: the deterministic auto-reject core's threshold/measured-value snapshot for an
   * AI-authored `rejected` decision — flat, primitive-only, bounded (see sanitizeAutoRejectEvidence).
   */
  autoRejectEvidence?: Record<string, unknown> | null;
  /**
   * Task-94: `video.review.appeal` event payload. Only applied on the undo edge — stamps
   * `appeal: {open:true, ...}` on the review-state doc in the SAME transaction as the transition.
   */
  appeal?: { message: string; submittedAtIso: string } | null;
};

export type TransitionCommandResult = {
  applied: boolean;
  idempotent: boolean;
  nextState: VideoReviewState;
  projectToFeed: boolean;
  requiresHumanReview: boolean;
  mailKind: string | null;
  /**
   * W120: 계획된 메일이 실제로 큐에 들어가지 않은 사유. `null` 이면 계획대로 처리됐다는 뜻이고,
   * `mailKind` 는 **계획값** 그대로다(종전 계약 불변 — 호출부가 판정 종류를 계속 읽을 수 있다).
   */
  mailSkippedReason: string | null;
  // Full partnerActivationCore.PartnerActivationResult per spec §7.1 — null when not attempted
  // (nextState !== "approved"); never collapsed to a flat status string so callers get
  // enrollmentId/activationId/kpiApplied without a second read.
  partnerActivation: PartnerActivationResult | null;
};


// W86-B [아웃박스 입자 · 결정 근거는 artifacts/W86B-WORKER-REPORT.md]
//
// 이 파일이 적재하는 세 아웃박스의 문서 키는 `${submissionId}__${seq}` 이고
// `seq = reviewLedger.length + 1` 이다 — **결정의 신원이 아니라 배열 길이에서 나온 순번**이다.
// 검수 헤드가 재생성되면(`plan.isCreate` 에서 `reviewLedger`/`appliedDecisionRefs` 를 빈 배열로
// 되돌린다 · scpVideoRevisionIngress.ts:1046) 순번은 1부터 다시 시작하는데, 아웃박스 세 컬렉션은
// 그 초기화에 딸려 지워지지 않는다. 종전 코드는 그 자리에 `set(..., { merge: true })` 로 얹었다.
// 즉 **이미 delivered 인 옛 행을 읽지도 않고** `deliveryState:"queued"` · `attempts:0` ·
// `nextAttemptAtIso: now` 로 되살렸다:
//   ① 이미 나간 결과 메일이 드레인에 다시 잡혀 한 번 더 나간다(중복 발송)
//   ② 옛 행의 감사 기록(evidence/decisionRef/attempts)이 덮여 사라진다
//   ③ 드레인의 trackingId 가 문서 id 파생이라 옛 발송과 같은 값이 되어, 이번 정상 메일이
//      하류 dedupe(mail_outbound_log / mail_quota_events)에서 "중복"으로 분류돼 **조용히 미발송**
//      될 수도 있다 — 중복 발송과 미발송이 한 뿌리에서 양방향으로 터진다.
//
// 키 스킴은 바꾸지 않는다. 읽기 모델(videoReviewStateCallables.reviewOutboxDocumentId), Portal
// 콜백 계약, 그리고 **이미 큐에 있는 행 전부**가 이 형상을 쓴다 — 키를 갈면 기존 대기 행이
// 읽기 모델에서 통째로 사라진다. 대신 적재를 `create` 로 바꿔 **키가 자기 입자를 스스로 강제**
// 하게 한다: 같은 키가 이미 있으면 트랜잭션이 통째로 되감기므로 조용한 덮어쓰기가 불가능하다.
// 정상 경로는 결정마다 seq 가 새 값이라 create 가 항상 성공한다(동작 불변).
// 같은 결정의 재시도는 이 함수 첫머리의 `appliedDecisionRefs` 가드가 이미 먼저 잡는다.
//
// 이 규율은 형제 레인의 선례와 같다 — applicationVideoPending.ts:480 이 같은 이유로
// `set` 이 아니라 `create` 를 쓴다("키가 이미 있으면 충돌로 실패해 같은 사람에게 두 번 발송 방지").
const FIRESTORE_ALREADY_EXISTS_CODE = 6;

/**
 * 아웃박스 키 충돌(= 위 ①②③ 이 일어나려던 순간)을 진단 가능한 도메인 오류로 바꾼다.
 * 원인 불명의 `ALREADY_EXISTS` 로 새어 나가면 운영자가 "왜 검수 결정이 실패했나"를 되짚을 수 없다.
 * 되감기 자체는 이미 일어났다 — 여기서는 사유만 이름 붙인다.
 */
function mapReviewOutboxGrainCollision(error: unknown): unknown {
  // 이미 이름이 붙은 도메인 오류는 그대로 통과시킨다 — 메시지 문자열 매칭이 남의 사유를
  // 가로채면(예: 활성화 실패) 근인이 바뀌어 버린다.
  if (
    error instanceof VideoReviewTransitionError ||
    error instanceof PartnerActivationError
  ) {
    return error;
  }
  const record =
    error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const message = String(record.message ?? "");
  const alreadyExists =
    record.code === FIRESTORE_ALREADY_EXISTS_CODE || /already exists/i.test(message);
  if (!alreadyExists) return error;
  // 같은 트랜잭션에는 아웃박스 밖의 create 도 있다(예: 파트너 활성화 문서 — partnerActivationStore).
  // 세 아웃박스 컬렉션 경로가 확인될 때만 이 사유를 주장하고, 아니면 원본을 그대로 흘려보낸다 —
  // 남의 ALREADY_EXISTS 에 이 이름을 붙이면 디버깅이 아웃박스 쪽으로 오도된다.
  const fromReviewOutbox = [
    SCP_VIDEO_REVIEW_CALLBACK_OUTBOX_COLLECTION,
    SCP_VIDEO_DOWNSTREAM_CALLBACK_OUTBOX_COLLECTION,
    SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION,
  ].some((collection) => message.includes(collection));
  if (!fromReviewOutbox) return error;
  const mapped = new VideoReviewTransitionError(
    "outbox_grain_collision",
    "review outbox row for this transition sequence already exists; refusing to overwrite a prior decision's row",
  );
  // 서버 로그가 충돌한 실제 문서 경로를 잃지 않도록 원본을 보존한다(클라이언트로는 나가지 않음).
  (mapped as Error & { cause?: unknown }).cause = error;
  return mapped;
}

/**
 * W120 [적대 리뷰 H6] 시트 레인 컷오버 게이트.
 *
 * flu 검수 탭 레인과 시트(Apps Script) 수동 반려 레인 사이에는 **이중 발송을 막는 장치가 없다**
 * (mailSuppression 은 video_result_mail 3종을 거래성으로 면제하고, quota 원장은 flu 내부 식별자만
 * 본다). 두 레인이 동시에 살아 있는 컷오버 구간에 대비해 사람이 내릴 수 있는 스위치를 둔다.
 *
 * 규칙:
 *   - 문서가 없거나 필드가 없으면 **현행 유지(활성)** — 배포가 프로드 동작을 조용히 바꾸지 않는다.
 *   - 반려·변경요청 통지에만 적용한다. 승인은 flu 단독 레인이라 게이트 대상이 아니다.
 *   - 스킵은 조용히 지나가지 않는다: 원장 엔트리에 사유를 남긴다(`mailSkippedReason`).
 */
export const VIDEO_RESULT_MAIL_ROLLOUT_SETTINGS_DOC = "settings/scp_video_result_mail_rollout" as const;

export async function readVideoResultMailRolloutGate(
  db: FirebaseFirestore.Firestore,
): Promise<{ rejectionMailEnabled: boolean }> {
  const [collection, docId] = VIDEO_RESULT_MAIL_ROLLOUT_SETTINGS_DOC.split("/");
  const snapshot = await db.collection(collection).doc(docId).get().catch(() => null);
  const value = snapshot?.exists ? snapshot.data()?.rejectionMailEnabled : undefined;
  // 명시적 false 일 때만 닫힌다(부재·오타·null 은 전부 현행 유지).
  return { rejectionMailEnabled: value !== false };
}

export type VideoResultMailOutboxRowInput = {
  submissionId: string;
  mailKind: string;
  decisionRef: string;
  actorType: ActorType;
  reasonCode: string | null;
  customerMessageCode: string | null;
  operatorMessage: string | null;
  reasonTagKeys: readonly string[] | null;
  reviewedAt: string;
  policyVersion: string;
  contentFingerprint: string;
  currentRevision: unknown;
  evidence: unknown;
  evidencePacket: unknown;
  nowIso: string;
};

/**
 * 결과 메일 아웃박스 행의 단일 빌더. 전이 경로(transitionVideoReviewDecision)와 승인 메일 재적재
 * 콜러블(scpVideoApprovalMailEnqueue.ts)이 같은 형상을 쓰도록 한 곳에 둔다 — 드레인 계약 불변.
 */
export function buildVideoResultMailOutboxRow(input: VideoResultMailOutboxRowInput) {
  return {
    submissionId: input.submissionId,
    mailKind: input.mailKind,
    // W86-B: 형제 아웃박스 두 개(callback/downstream)는 이미 싣는데 결과 메일 행만 빠져 있었다.
    //   행이 자기 결정을 이름대지 못하면 "이 메일은 어느 판정에서 나왔나"를 사후에 맞출 수 없고,
    //   키가 충돌해도 어느 결정이 선점했는지 못 밝힌다. 추가 필드라 드레인 계약은 불변이다.
    decisionRef: input.decisionRef,
    // Task-94: mailOutboundLanes.ts 가 AI 저자 거래성 메일을 outbound cap 대상으로 돌리는 데
    //   쓴다(§NET-P0-012 무관, mailOutboundLanes.ts 참조) — 사람 판정은 계속 캡 면제.
    actorType: input.actorType,
    reasonCode: input.reasonCode,
    customerMessageCode: input.customerMessageCode,
    operatorMessage: input.operatorMessage,
    // W121: 드레인이 이 키 배열을 서버 사전으로 렌더해 사유 불릿을 만든다(문장 미동봉).
    reasonTagKeys: input.reasonTagKeys ? [...input.reasonTagKeys] : null,
    reviewedAt: input.reviewedAt,
    policyVersion: input.policyVersion,
    contentFingerprint: input.contentFingerprint,
    currentRevision: input.currentRevision,
    evidence: input.evidence,
    evidencePacket: input.evidencePacket,
    deliveryState: "queued",
    attempts: 0,
    nextAttemptAtIso: input.nowIso,
    createdAtIso: input.nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/** W120: 반려·변경요청만 컷오버 게이트를 탄다(승인은 flu 단독 레인). 전이·재적재 공용. */
export function videoResultMailRolloutSkipReason(
  mailKind: string | null,
  rolloutGate: { rejectionMailEnabled: boolean },
): string | null {
  const mailGated = mailKind === "content_rejected" || mailKind === "content_changes_requested";
  return mailGated && !rolloutGate.rejectionMailEnabled ? "rollout_gate" : null;
}

export async function transitionVideoReviewDecision(
  input: TransitionCommandInput,
  now: Date,
  options: {
    firestore?: FirebaseFirestore.Firestore;
    /** 테스트·호출부 주입용. 생략하면 settings 문서를 읽는다(부재 시 활성). */
    rolloutGate?: { rejectionMailEnabled: boolean };
    /** Task-100 테스트·호출부 주입용. 생략하면 settings/scp_resubmission_policy 를 읽는다. */
    resubmissionPolicy?: ResubmissionCyclePolicy;
  } = {},
): Promise<TransitionCommandResult> {
  const db = options.firestore ?? adminDb;
  const ref = db.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION).doc(reviewDocId(input.submissionId));
  const nowIso = now.toISOString();
  if (!input.decisionRef) throw new VideoReviewTransitionError("invalid-argument", "decisionRef is required");
  if (!input.actorId) throw new VideoReviewTransitionError("invalid-argument", "actorId is required");
  // 트랜잭션 밖에서 읽는다 — 롤아웃 스위치는 결정 원장의 불변식이 아니라 운영 스위치다.
  const rolloutGate = options.rolloutGate ?? await readVideoResultMailRolloutGate(db);
  // Task-100: 재제출 사이클의 deadlineAtIso 계산에만 쓴다 — enabled:false 여도 원장은 그대로 쓰인다
  // (resubmissionCyclePolicy.ts 헤더 참고). 트랜잭션 밖에서 한 번만 읽는다(위 rolloutGate 와 동형).
  const resubmissionPolicy = options.resubmissionPolicy ?? await readResubmissionCyclePolicy(db);

  // Task-53: 트랜잭션이 실제로 새 상태를 커밋할 때만(아래 `applied:true` 분기) 채운다 — idempotent
  // 재적용(위 분기)은 아무것도 안 바꾸므로 무효화 대상이 없다. 배열에 담아 두는 이유: 바깥 `let`
  // 을 트랜잭션 콜백 안에서 재대입하면 TS 가 콜백 뒤의 읽기 지점을 도달 불가로 오판해(닫힘 너머
  // 대입 추적 한계) `never` 로 좁혀버린다 — `push`/인덱스 접근은 그 오판을 트리거하지 않는다.
  //
  // 적대 재리뷰(2026-09-11, [MEDIUM]): Firestore 트랜잭션은 경합 시 콜백을 재시도한다 — 이 배열은
  // 콜백 밖에 선언돼 재시도마다 안 비면 1차 시도(버려진 시도)가 push 한 값이 남는다. 콜백
  // **시작**에서 매번 비우고, 성공한 마지막 시도가 push 한 값만(끝 원소) 읽는다.
  const writtenReviewStateWrites: Array<{ canonicalProgramId: string; campaignId: string }> = [];

  const result = await db.runTransaction(async (tx) => {
    // 이번 시도(재시도 포함) 것만 남긴다 — 버려진 이전 시도의 push 를 절대 안 들고 간다.
    writtenReviewStateWrites.length = 0;
    const snap = await tx.get(ref);
    if (!snap.exists) throw new VideoReviewTransitionError("not_found", "review state does not exist");
    const data = snap.data() ?? {};

    const appliedRefs: string[] = Array.isArray(data.appliedDecisionRefs) ? (data.appliedDecisionRefs as string[]) : [];
    if (appliedRefs.includes(input.decisionRef)) {
      return {
        applied: false,
        idempotent: true,
        nextState: normalizeLegacyReviewState(String(data.state ?? "queued")),
        projectToFeed: false,
        requiresHumanReview: false,
        mailKind: null,
        mailSkippedReason: null,
        partnerActivation: null,
      };
    }

    const current = {
      state: normalizeLegacyReviewState(String(data.state ?? "queued")),
      revision: Number(data.revision ?? 0),
      contentFingerprint: String(data.contentFingerprint ?? ""),
      canonicalProgramId: String(data.canonicalProgramId ?? ""),
      policyConfigHash: String(data.policyConfigHash ?? ""),
      superseded: data.superseded === true,
    };

    const plan = planVideoReviewTransition({
      current,
      targetStatus: input.targetStatus,
      expectedRevision: input.expectedRevision,
      expectedContentFingerprint: input.expectedContentFingerprint,
      expectedCanonicalProgramId: input.expectedCanonicalProgramId,
      expectedPolicyConfigHash: input.expectedPolicyConfigHash,
      reasonCode: input.reasonCode ?? null,
      customerMessageCode: input.customerMessageCode ?? null,
      actorType: input.actorType,
      aiAutoPilotEnabled: input.aiAutoPilotEnabled,
      evidenceRisk: input.evidenceRisk,
    });
    if (!plan.allowed || !plan.nextState) {
      throw new VideoReviewTransitionError(plan.errorCode ?? "rejected", `transition rejected: ${plan.errorCode ?? "rejected"}`);
    }
    const nextState = plan.nextState;

    const ledger: unknown[] = Array.isArray(data.reviewLedger) ? (data.reviewLedger as unknown[]) : [];
    const seq = ledger.length + 1;

    // Task-94: `rejected -> human_review_required` is ONLY the operator-undo / creator-appeal edge.
    // Require an explicit reason marker and, when the caller knows which decision it means to undo,
    // an exact match on the ledger length at the moment of the call — otherwise an operator who
    // loaded a stale queue view could silently undo a DIFFERENT, newer rejection than the one they
    // reviewed.
    const isUndoEdge = current.state === "rejected" && nextState === "human_review_required";
    if (isUndoEdge && !input.undoReason) {
      throw new VideoReviewTransitionError("reason_required", "undo/appeal requires undoReason");
    }
    if (isUndoEdge && typeof input.expectedSeq === "number" && input.expectedSeq !== ledger.length) {
      throw new VideoReviewTransitionError("stale_precondition", "expectedSeq no longer matches the last review decision");
    }
    const undoneDecisionSeq = isUndoEdge ? ledger.length : null;
    // Any reject-mail outbox row for the decision being undone must be cancelled before it sends —
    // read it now (all transaction reads happen before any write; see below for the matching write).
    const undoneMailOutboxRef = isUndoEdge && undoneDecisionSeq
      ? db.collection(SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION).doc(`${reviewDocId(input.submissionId)}__${undoneDecisionSeq}`)
      : null;
    const undoneMailOutboxSnapshot = undoneMailOutboxRef ? await tx.get(undoneMailOutboxRef) : null;

    const subjectRecord = data.subject && typeof data.subject === "object" ? (data.subject as Record<string, unknown>) : {};
    const subjectPolicyVersion = isNonEmptyString(subjectRecord.policyVersion)
      ? subjectRecord.policyVersion
      : "";
    const storedPolicyVersion = isNonEmptyString(data.policyVersion)
      ? data.policyVersion
      : "";
    const policyVersion =
      subjectPolicyVersion || storedPolicyVersion || current.policyConfigHash;
    if (nextState === "approved") {
      // Two canonical ingress shapes exist in production:
      //  - v3 binds `subject.policyVersion` directly to the review-head policyConfigHash.
      //  - integration-event v2 carries the human-readable version at both
      //    `subject.policyVersion` and top-level `policyVersion`, while the separately CAS-bound
      //    `policyConfigHash` is the concrete configuration digest.
      // Treating the v2 version string as though it must equal the SHA digest rejected every valid
      // v2 approval. The hash remains mandatory and is still protected by the transition CAS above;
      // this gate only verifies that the subject's policy authority is one of the two canonical
      // bindings. A free-standing or mismatched subject value still fails closed.
      const policyAuthorityBound =
        isNonEmptyString(subjectPolicyVersion) &&
        (
          subjectPolicyVersion === current.policyConfigHash ||
          (
            isNonEmptyString(storedPolicyVersion) &&
            subjectPolicyVersion === storedPolicyVersion
          )
        );
      if (!isNonEmptyString(current.policyConfigHash) || !policyAuthorityBound) {
        throw new VideoReviewTransitionError("stale_precondition", "approval requires canonical policyVersion bound to the current review head");
      }
      if (!isNonEmptyString(current.contentFingerprint) || !Number.isInteger(current.revision) || current.revision <= 0) {
        throw new VideoReviewTransitionError("stale_precondition", "approval requires current revision and content fingerprint evidence");
      }
      if (current.superseded === true || data.withdrawn === true) {
        throw new VideoReviewTransitionError("stale_precondition", "partner_activation_withdrawn_revision: approval requires a non-superseded, non-withdrawn current revision");
      }
    }
    // Task-100 갭 ②: closed 카탈로그 밖 reasonCode 는 other_documented 로 강등하고 원래 값은
    // reasonCodeRaw 에 보존한다 — 기존 ledgerEntry.reasonCode(= input.reasonCode, 메일 문구 지도가
    // 읽는 값)는 아래에서 그대로 두므로 기존 생산자의 발송 문구는 바뀌지 않는다(새 필드만 추가).
    const normalizedReason = normalizeVideoReviewReasonCode(input.reasonCode);
    const decisionEvidence = boundedDecisionEvidence(input.evidence, {
      kind: "canonical_review_head",
      ruleId: "current_revision_cas",
      verdict: nextState,
    });
    const evidencePacket = {
      schemaVersion: "flu.video-review-decision-evidence.v1",
      decisionRef: input.decisionRef,
      reviewedAt: nowIso,
      revision: current.revision,
      policyVersion,
      policyConfigHash: current.policyConfigHash,
      contentFingerprint: current.contentFingerprint,
      currentRevision: {
        videoSubmissionId: input.submissionId,
        revision: current.revision,
        isCurrent: true,
        superseded: current.superseded === true,
        withdrawn: data.withdrawn === true,
      },
      preconditions: {
        expectedRevision: input.expectedRevision,
        expectedContentFingerprint: input.expectedContentFingerprint,
        expectedCanonicalProgramId: input.expectedCanonicalProgramId,
        expectedPolicyConfigHash: input.expectedPolicyConfigHash,
      },
      transitionVersion: VIDEO_REVIEW_TRANSITION_VERSION,
      deliveryMode: input.deliveryMode ?? "live",
    };
    // W120: 반려·변경요청만 컷오버 게이트를 탄다(승인은 flu 단독 레인).
    const mailSkippedReason: string | null = videoResultMailRolloutSkipReason(plan.mailKind, rolloutGate);
    const ledgerEntry = {
      seq,
      fromState: current.state,
      toState: nextState,
      // 스킵을 조용히 지나가지 않는다 — "왜 이 판정엔 메일이 없나"를 원장에서 되짚을 수 있어야 한다.
      mailSkippedReason,
      // W126: 아웃박스 생성의 세 게이트 중 이것만 원장에 흔적이 없었다 — 사후에 "이 판정은
      //   크리에이터에게 통지됐나"를 되짚을 수가 없었다(무메일 백필이 정확히 그 경로다).
      //   추가 필드라 읽는 쪽 계약은 불변이고, summarizeVideoReviewLedger 의 notifiedOnly 가
      //   이 값을 본다(없으면 통지된 것으로 본다 — 이 필드 이전 엔트리 호환).
      notifyCreator: input.notifyCreator !== false,
      actorType: input.actorType,
      actorId: input.actorId,
      reasonCode: input.reasonCode ?? null,
      customerMessageCode: input.customerMessageCode ?? null,
      operatorMessage: input.operatorMessage ?? null,
      // Task-100: 카탈로그 검증을 거친 추가 필드. 위 reasonCode(=input.reasonCode 그대로)는
      // 메일 문구 지도가 읽으므로 불변 — 이 두 필드는 resubmissionCycleMetrics 같은 새 소비자용.
      reasonCodeNormalized: normalizedReason.reasonCodeNormalized,
      ...(normalizedReason.reasonCodeRaw !== null ? { reasonCodeRaw: normalizedReason.reasonCodeRaw } : {}),
      // W121: 발송본의 사유 불릿을 사후에 되짚을 수 있어야 한다 — 키만 남기면 사전으로 문장을
      //   그대로 복원할 수 있고, 사전이 바뀌어도 "그때 무엇을 근거로 반려했나"는 보존된다.
      reasonTagKeys: input.reasonTagKeys ? [...input.reasonTagKeys] : null,
      // Task-94: undo/appeal marker + the seq of the decision this entry undoes (null on every
      // other transition). autoRejectEvidence is the deterministic auto-reject core's snapshot,
      // recorded only on an AI-authored `rejected` decision.
      reason: isUndoEdge ? input.undoReason ?? null : null,
      undoneDecisionSeq,
      undoNote: isUndoEdge ? sanitizeUndoNote(input.undoNote) : null,
      autoRejectEvidence: sanitizeAutoRejectEvidence(input.autoRejectEvidence),
      decisionRef: input.decisionRef,
      atIso: nowIso,
      reviewedAt: nowIso,
      revision: current.revision,
      policyVersion,
      contentFingerprint: current.contentFingerprint,
      fingerprint: current.contentFingerprint,
      currentRevision: evidencePacket.currentRevision,
      evidence: decisionEvidence,
      evidencePacket,
      transitionVersion: VIDEO_REVIEW_TRANSITION_VERSION,
      deliveryMode: input.deliveryMode ?? "live",
    };

    // Approved-only downstream eligibility (approval alone leaves tracking/settlement false until the
    // downstream projection callback is confirmed by a later step).
    const eligibility = computeDownstreamEligibility(
      // P2#3 fix: read the real head field instead of blindly hardcoding `superseded: false` — a head
      // whose OWN state doc still carries `superseded: true` (stale/legacy data) must never be treated
      // as eligible just because this transition call happens to run against it.
      { reviewState: nextState, isCurrentRevision: true, superseded: current.superseded, withdrawn: false, downstreamProjectionConfirmed: false },
      { videoSubmissionId: input.submissionId, revision: current.revision },
    );
    // Partner activation: reads the activation/program/campaign context BEFORE any write in this
    // transaction (Firestore requires all reads before any write — spec_partner_activation_from_video_
    // approval §6.2). Only attempted when the CURRENT, non-withdrawn revision becomes approved
    // (plan.projectToFeed is true exactly when nextState === "approved"); a forbidden/failed activation
    // precondition (identity incomplete/conflict, withdrawn head, stale CAS re-check) throws
    // PartnerActivationError, which aborts the WHOLE decision transaction — the video approval and the
    // activation are one atomic unit, never partially applied. Non-approved decisions never touch
    // activation state at all (zero reads, zero writes).
    let activationContext: PartnerActivationTransactionContext | null = null;
    let activationApplyInput: {
      review: {
        previousState: VideoReviewState;
        nextState: VideoReviewState;
        revision: number;
        contentFingerprint: string;
        canonicalProgramId: string;
        policyConfigHash: string;
        withdrawn: boolean;
        subject: VideoReviewSubject;
      };
      command: {
        expectedRevision: number;
        expectedContentFingerprint: string;
        expectedCanonicalProgramId: string;
        expectedPolicyConfigHash: string;
        decisionRef: string;
        actorType: ActorType;
        actorId: string;
      };
      reviewTransitionSeq: number;
    } | null = null;
    if (plan.projectToFeed) {
      const subject = subjectFromReviewStateData(data.subject);
      if (!isNonEmptyString(subject.enrollmentId)) {
        throw new PartnerActivationError("partner_activation_identity_incomplete", "partner activation preconditions failed");
      }
      // P3#8 quarantine: a subject that omits its OWN videoRevision/contentFingerprint is incomplete
      // migration/legacy evidence — never structurally repaired by echoing the already-CAS-validated
      // head values (subjectFromReviewStateData no longer does that echo at all).
      if (!Number.isInteger(subject.videoRevision) || !isNonEmptyString(subject.contentFingerprint)) {
        throw new PartnerActivationError("partner_activation_identity_incomplete", "partner activation preconditions failed");
      }
      // P3#10d: subject.programId is what KPI refs are built from below; it must agree with the
      // CAS-validated canonicalProgramId on the head, or the activation would attribute program KPIs to
      // an unverified program. Mismatch fails closed rather than silently trusting the subject bag.
      if (subject.programId !== current.canonicalProgramId) {
        throw new PartnerActivationError("partner_activation_identity_conflict", "partner activation preconditions failed");
      }
      const eventId = partnerActivationEventId({
        enrollmentId: subject.enrollmentId,
        submissionId: subject.videoSubmissionId,
        videoRevision: subject.videoRevision,
        decisionRef: input.decisionRef,
      });
      const activationRefs = buildPartnerActivationRefs(db, {
        enrollmentId: subject.enrollmentId,
        eventId,
        programId: subject.programId || null,
        campaignId: subject.campaignId || null,
      });
      activationContext = await readPartnerActivationTransactionContext(tx, activationRefs);
      activationApplyInput = {
        review: {
          previousState: current.state,
          nextState,
          revision: current.revision,
          contentFingerprint: current.contentFingerprint,
          canonicalProgramId: current.canonicalProgramId,
          policyConfigHash: current.policyConfigHash,
          withdrawn: data.withdrawn === true,
          subject,
        },
        command: {
          expectedRevision: input.expectedRevision,
          expectedContentFingerprint: input.expectedContentFingerprint,
          expectedCanonicalProgramId: input.expectedCanonicalProgramId,
          expectedPolicyConfigHash: input.expectedPolicyConfigHash,
          decisionRef: input.decisionRef,
          actorType: input.actorType,
          actorId: input.actorId,
        },
        reviewTransitionSeq: seq,
      };
    }


    // Wire the CURRENT approved revision into the existing approved-only Feed/Report projection.
    // Runs BEFORE the state/outbox writes so all transaction reads precede writes (Firestore rule).
    // youtubeUrl is seeded on the review-state doc by the canonical revision ingestion; when absent
    // (e.g. legacy/unseeded), projectScpApprovedFeed is a safe no-op (ignored: no_youtube_submission_url).
    if (plan.projectToFeed) {
      const subjectRec = data.subject && typeof data.subject === "object" ? (data.subject as Record<string, unknown>) : {};
      await projectScpApprovedFeed({
        transaction: tx,
        submissionId: input.submissionId,
        submissionRef: ref,
        submission: {
          youtubeUrl: data.youtubeUrl,
          programId: data.canonicalProgramId ?? subjectRec.programId,
          campaign: subjectRec.campaignId,
          creatorId: subjectRec.fluCreatorId,
        },
        reviewStatus: "approved",
        previousReviewStatus: current.state,
        approver: input.actorId,
        approvedAtIso: nowIso,
        latestVideoReviewDecisionRef: input.decisionRef,
      });
    }

    // Applies the activation write-plan into this SAME transaction (never opens its own — see
    // partnerActivationStore.ts header). Runs after the feed-projection read/write so all reads happen
    // first; not_applicable/already_active/already_revoked issue zero writes (idempotent by
    // construction), "reject" throws and aborts the whole transaction above in the guard.
    let partnerActivation: PartnerActivationResult | null = null;
    if (activationContext && activationApplyInput) {
      partnerActivation = applyPartnerActivationWrites(tx, activationContext, activationApplyInput, now);
    }


    // Task-94: the undo edge always resolves the review-state doc's `appeal` marker in the SAME
    // write — either opening a fresh one (this call IS the appeal event) or closing whatever was
    // open before (operator undo, or a second undo superseding a prior appeal). Every other
    // transition leaves `appeal` untouched (field omitted from the merge).
    const appealPatch = isUndoEdge
      ? {
          appeal: input.appeal
            ? {
                open: true,
                message: sanitizeAppealMessage(input.appeal.message),
                submittedAtIso: strictOrNowIso(input.appeal.submittedAtIso, nowIso),
                decisionSeq: undoneDecisionSeq,
                recordedAtIso: nowIso,
              }
            : {
                open: false,
                resolvedAtIso: nowIso,
                resolvedByDecisionRef: input.decisionRef,
              },
        }
      : {};

    // Task-100 갭 ①: 재제출 사이클 원장. rejected 전이가 새 사이클을 열고, 그다음 판정(승인/재반려)이
    // 열린 사이클을 닫는다. ALLOWED_NEXT 상 "rejected"는 terminal(videoReviewTransitionCore.ts) 이라
    // 이 트랜잭션이 실행된다는 것 자체가 이미 리비전이 올라간 재제출이 있었다는 뜻이다(revision CAS
    // 가 그걸 강제한다) — 그래서 review-state 문서에 남긴 resubmissionCycleSeq/Active 만으로 "어느
    // 사이클을 닫을지" 결정할 수 있고, 추가 조회(쿼리)가 필요 없다. changes_requested 는 판정 보류로
    // 보고 사이클을 닫지 않는다(별첨 B 미확정 — 사람 결정 #7 대기, TICKET-MAP §3).
    const resubmissionCycleSeqBefore = Number(data.resubmissionCycleSeq ?? 0);
    const resubmissionCycleWasActive = data.resubmissionCycleActive === true;
    let resubmissionCycleSeqPatch: number | undefined;
    let resubmissionCycleActivePatch: boolean | undefined;

    if (
      resubmissionCycleWasActive &&
      resubmissionCycleSeqBefore > 0 &&
      (nextState === "approved" || nextState === "rejected")
    ) {
      const resolvedPatch = buildResubmissionCycleResolvedPatch({
        outcome: nextState === "approved" ? "passed" : "failed",
        decidedAtIso: nowIso,
        decidedRevision: current.revision,
        decisionRef: input.decisionRef,
      });
      tx.set(
        db.collection(VIDEO_RESUBMISSION_CYCLE_COLLECTION)
          .doc(resubmissionCycleDocId(input.submissionId, resubmissionCycleSeqBefore)),
        resolvedPatch,
        { merge: true },
      );
      resubmissionCycleActivePatch = false;
    } else if (isUndoEdge && resubmissionCycleWasActive && resubmissionCycleSeqBefore > 0) {
      // Task-94 × Task-100 정합: undo 엣지(rejected → human_review_required)는 그 반려가 연 사이클을
      // 같은 트랜잭션에서 `undone` 으로 닫는다 — 열린 채 두면 독려 스윕(awaiting_resubmission 조회)이
      // 취소된 반려를 근거로 크리에이터에게 재제출 독려를 보낸다. 지표(resubmissionCycleMetrics)도
      // undone 은 반려 분모에서 뺀다. 다음 rejected 는 원장 rejected 수 +1 로 새 seq 를 받는다(ID 충돌 없음).
      tx.set(
        db.collection(VIDEO_RESUBMISSION_CYCLE_COLLECTION)
          .doc(resubmissionCycleDocId(input.submissionId, resubmissionCycleSeqBefore)),
        buildResubmissionCycleUndonePatch({ undoneAtIso: nowIso, decisionRef: input.decisionRef }),
        { merge: true },
      );
      resubmissionCycleActivePatch = false;
    }

    if (nextState === "rejected") {
      // 이 제출의 몇 번째 반려인지 = 지금까지 원장에 쌓인 rejected 엔트리 수 + 1(이번 것 제외 카운트
      // 라 +1). 별도 쿼리 없이 이미 트랜잭션에 있는 ledger 배열에서 셀 수 있다.
      const priorRejectionCount = ledger.filter(
        (entry) => (entry as Record<string, unknown>).toState === "rejected",
      ).length;
      const newCycleSeq = priorRejectionCount + 1;
      const cycleDoc = buildResubmissionCycleCreatedDoc({
        submissionId: input.submissionId,
        applicationId: typeof subjectRecord.applicationId === "string" ? subjectRecord.applicationId : "",
        creatorId: typeof subjectRecord.fluCreatorId === "string" ? subjectRecord.fluCreatorId : null,
        cycleSeq: newCycleSeq,
        rejectedAtIso: nowIso,
        rejectedRevision: current.revision,
        reasonCode: normalizedReason.reasonCode,
        reasonCodeRaw: normalizedReason.reasonCodeRaw,
        deadlineDays: resubmissionPolicy.deadlineDays,
        decisionRef: input.decisionRef,
      });
      // W86-B 형제 아웃박스와 같은 규율: create 로 적재해 키(submissionId__cycleSeq)가 중복을 막는다.
      tx.create(
        db.collection(VIDEO_RESUBMISSION_CYCLE_COLLECTION).doc(resubmissionCycleDocId(input.submissionId, newCycleSeq)),
        cycleDoc,
      );
      resubmissionCycleSeqPatch = newCycleSeq;
      resubmissionCycleActivePatch = true;
    }

    tx.set(ref, {
      state: nextState,
      reviewLedger: [...ledger, ledgerEntry],
      appliedDecisionRefs: FieldValue.arrayUnion(input.decisionRef),
      feedEligible: eligibility.feedEligible,
      reportEligible: eligibility.reportEligible,
      trackingEligible: eligibility.trackingEligible,
      settlementEligible: eligibility.settlementEligible,
      downstreamProjectionConfirmed: false,
      lastTransitionSeq: seq,
      reviewedAtIso: nowIso,
      lastReviewEvidence: evidencePacket,
      lastDecisionEvidence: decisionEvidence,
      ...appealPatch,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
      ...(resubmissionCycleSeqPatch !== undefined ? { resubmissionCycleSeq: resubmissionCycleSeqPatch } : {}),
      ...(resubmissionCycleActivePatch !== undefined ? { resubmissionCycleActive: resubmissionCycleActivePatch } : {}),
    }, { merge: true });

    // Task-94: cancel the reject-mail outbox row for the decision being undone if it has not sent
    // yet. `undoneMailOutboxSnapshot` was read above (before any write in this transaction).
    if (undoneMailOutboxRef && undoneMailOutboxSnapshot?.exists) {
      const undoneMailData = undoneMailOutboxSnapshot.data() ?? {};
      if (undoneMailData.deliveryState !== "delivered" && undoneMailData.cancelled !== "undone") {
        tx.set(undoneMailOutboxRef, {
          cancelled: "undone",
          cancelledAtIso: nowIso,
          cancelledByDecisionRef: input.decisionRef,
          deliveryState: "cancelled",
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }

    // Flu → Portal review-status callback outbox (fail-closed transport until secret binds).
    // W86-B: `set(merge)` → `create`. 키가 이 전이의 입자(submission × seq)를 강제한다.
    tx.create(
      db.collection(SCP_VIDEO_REVIEW_CALLBACK_OUTBOX_COLLECTION).doc(`${reviewDocId(input.submissionId)}__${seq}`),
      {
        submissionId: input.submissionId,
        reviewStatus: nextState,
        reviewId: `review_${reviewDocId(input.submissionId)}`,
        revision: seq,
        decisionRef: input.decisionRef,
        publicReasonCode: input.customerMessageCode ?? input.reasonCode ?? null,
        reviewedAt: nowIso,
        policyVersion,
        contentFingerprint: current.contentFingerprint,
        currentRevision: evidencePacket.currentRevision,
        evidence: decisionEvidence,
        evidencePacket,
        deliveryState: "queued",
        attempts: 0,
        nextAttemptAtIso: nowIso,
        createdAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
    );

    // Downstream projection callback outbox — enqueued only when the CURRENT revision becomes approved.
    // Delivery (Flu → Portal) is the accepted step that flips tracking/settlement eligible.
    if (plan.projectToFeed) {
      tx.create(
        db.collection(SCP_VIDEO_DOWNSTREAM_CALLBACK_OUTBOX_COLLECTION).doc(`${reviewDocId(input.submissionId)}__${seq}`),
        {
          submissionId: input.submissionId,
          revision: seq,
          decisionRef: input.decisionRef,
          reviewedAt: nowIso,
          policyVersion,
          contentFingerprint: current.contentFingerprint,
          currentRevision: evidencePacket.currentRevision,
          evidence: decisionEvidence,
          evidencePacket,
          deliveryState: "queued",
          attempts: 0,
          nextAttemptAtIso: nowIso,
          createdAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
      );
    }

    // Creator-result mail outbox (approved/changes_requested/rejected) when notifyCreator.
    // W120: `plan.mailKind` 가 승인에도 값을 주면서 이 블록이 3판정을 모두 태운다. 게이트는
    // 종전 그대로다 — notifyCreator=false(자동/백필 경로)와 historical_import 는 여전히 메일을
    // 만들지 않는다. 즉 과거 원장 재적재가 승인 메일을 소급 발송하는 일은 없다.
    if (
      plan.mailKind &&
      input.notifyCreator !== false &&
      input.deliveryMode !== "historical_import" &&
      !mailSkippedReason
    ) {
      tx.create(
        db.collection(SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION).doc(`${reviewDocId(input.submissionId)}__${seq}`),
        buildVideoResultMailOutboxRow({
          submissionId: input.submissionId,
          mailKind: plan.mailKind,
          decisionRef: input.decisionRef,
          actorType: input.actorType,
          reasonCode: input.reasonCode ?? null,
          customerMessageCode: input.customerMessageCode ?? null,
          operatorMessage: input.operatorMessage ?? null,
          reasonTagKeys: input.reasonTagKeys ?? null,
          reviewedAt: nowIso,
          policyVersion,
          contentFingerprint: current.contentFingerprint,
          currentRevision: evidencePacket.currentRevision,
          evidence: decisionEvidence,
          evidencePacket,
          nowIso,
        }),
      );
    }

    // Task-53: 판정은 canonicalProgramId 를 안 건드린다 — `current.canonicalProgramId` 가 이번
    //   커밋 이후 값과 같다. campaignId 는 subject 에서 그대로 읽는다(판정이 subject 를 안 바꾼다).
    writtenReviewStateWrites.push({
      canonicalProgramId: current.canonicalProgramId,
      campaignId: typeof subjectRecord.campaignId === "string" ? subjectRecord.campaignId : "",
    });

    return {
      applied: true,
      idempotent: false,
      nextState,
      projectToFeed: plan.projectToFeed,
      requiresHumanReview: plan.requiresHumanReview,
      mailKind: plan.mailKind,
      mailSkippedReason,
      partnerActivation,
    };
  }).catch((error: unknown) => {
    throw mapReviewOutboxGrainCollision(error);
  });
  // Task-53: idempotent 재적용(applied:false)은 상태를 안 바꾸므로 비우지 않는다 — 판정이 실제로
  //   새 상태를 만들었을 때만(배열에 항목이 들어왔을 때만) 영향받는 키를 비운다. 끝 원소를 읽는다
  //   — 콜백 시작에서 매번 비우므로 성공한 마지막 시도의 값과 같지만, 방어적으로 인덱스를 못박지
  //   않는다(재리뷰 [MEDIUM]).
  const committedWrite = writtenReviewStateWrites[writtenReviewStateWrites.length - 1];
  if (result.applied && committedWrite) {
    invalidateReviewQueueCachesForWrite(committedWrite.canonicalProgramId, committedWrite.campaignId);
  }
  return result;
}
