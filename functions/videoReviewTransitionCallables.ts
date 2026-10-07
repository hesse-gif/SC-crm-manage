// Operator callable for the canonical review transition (handoff §4). Human decisions use this
// command with actor-specific gates; the store composes the pure transition + downstream cores.
// Diagnosable, fail-closed error mapping (VideoReviewTransitionError.code -> stable public code).
// P3#9: PartnerActivationError (thrown by the SAME-transaction activation attempt, spec
// spec_partner_activation_from_video_approval §9) maps to failed-precondition with an allowlisted,
// stable errorCode — never the raw internal Error.message/stack.

import { assertNonGuestAuth, makeBehaviorLog, asRecord, asString, type CallableRequestShape, type Role } from "./shared";
import { adminDb } from "./firebaseAdmin";
import {
  transitionVideoReviewDecision,
  VideoReviewTransitionError,
  reviewDocId,
  SCP_VIDEO_REVIEW_STATE_COLLECTION,
} from "./videoReviewTransitionStore";
import { VIDEO_REVIEW_STATES, type VideoReviewState } from "./videoReviewTransitionCore";
import { isVideoReviewRuleTagKey, VIDEO_REVIEW_REASON_TAG_MAX } from "./videoReviewCriteria";
import { PartnerActivationError } from "./partnerActivationStore";
// 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate, codex round-2 adversarial
// review): this canonical review transition callable's only client UI is
// CanonicalVideoReviewPanel.tsx / ReviewWorkspace.tsx, both exclusively rendered inside the
// entitlement-gated /flu/scp page. OPERATOR_ROLES (manager+) alone let a non-entitled manager
// mutate review state directly by calling this callable even with the UI hidden.
import { assertScpEntitled } from "./mailAccounts";

const OPERATOR_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin", "manager"];

// spec §9 error contract — every code a PartnerActivationError may surface through this callable.
// Anything else collapses to the generic "partner_activation_rejected" fallback (never raw internals).
const ALLOWLISTED_PARTNER_ACTIVATION_ERROR_CODES: ReadonlySet<string> = new Set([
  "partner_activation_identity_incomplete",
  "partner_activation_identity_conflict",
  "partner_activation_not_current_revision",
  "partner_activation_withdrawn_revision",
  "partner_activation_already_revoked",
  "partner_activation_counter_drift",
  "partner_activation_unparseable",
]);

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

function integerField(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : Number.NaN;
}

// W102(헤세): 건별 운영자 편집 문안 — 수신자에게 그대로 나가는 자유 문장이라 좁게 검증한다.
//  · 변경요청/반려에서만 허용(승인 메일은 문안 축이 없다)
//  · 5~1000자, 템플릿 변수 문법({{...}}) 금지 — 발행 템플릿 컴파일러에 재해석될 여지 차단
//  · closed-world 링크(W96과 동일 원칙): URL 은 SCP 포털 호스트만 허용 — 오타·외부 링크가
//    grant 메일에 실려 나가는 사고를 원천 차단. 검증 통과 값만 원장·아웃박스에 기록된다.
const OPERATOR_MESSAGE_ALLOWED_HOST = "creator.supercent.io";
export function parseVideoReviewOperatorMessage(
  value: unknown,
  targetStatus: string,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw invalidArgument("operatorMessage must be a string");
  const message = value.trim();
  if (!message) return null;
  if (targetStatus !== "changes_requested" && targetStatus !== "rejected") {
    throw invalidArgument("operatorMessage is only allowed for changes_requested or rejected");
  }
  if (message.length < 5 || message.length > 1000) {
    throw invalidArgument("operatorMessage must be 5-1000 characters");
  }
  if (message.includes("{{") || message.includes("}}")) {
    throw invalidArgument("operatorMessage must not contain template syntax");
  }
  // 리뷰 처방(W102, 실행 재현): 스킴 생략 링크(`//evil`, `evil.tk/x`, `www.evil`)는 종전 정규식에
  // 안 잡혀 closed-world 검증을 통째로 우회했다 — 메일 클라이언트는 스킴 없는 도메인도 자동
  // 링크화한다. 판례(scpReceiptMailTemplates.rejectUnsafeHtml)와 동급으로: 프로토콜 상대는 전면
  // 금지, 도메인형 토큰은 전부 https 로 정규화해 같은 호스트 검증을 강제한다.
  if (/(?<!https:)(?<!http:)\/\//i.test(message)) {
    throw invalidArgument("operatorMessage must not contain protocol-relative links");
  }
  const urlCandidates: string[] = [...message.matchAll(/https?:\/\/[^\s)\]]+/gi)].map((match) => match[0]);
  for (const rawToken of message.split(/\s+/)) {
    // 괄호 IPv6 리터럴은 구두점 스트립 **전** 원형에서 식별한다 — `[`/`]` 가 식별 문자 그 자체다.
    const ipv6 = rawToken.match(/\[[0-9a-f:.]+\](?::\d+)?(?:\/\S*)?/i);
    if (ipv6) {
      urlCandidates.push(`https://${ipv6[0]}`);
      continue;
    }
    const token = rawToken.replace(/^[([{"'<]+/, "").replace(/[)\]}"'>.,!?;:]+$/, "");
    if (!token || /^https?:\/\//i.test(token)) continue;
    if (
      /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|$)/i.test(token)
      // 재검 NOTE 봉합: 스킴 없는 IPv4 리터럴도 도메인 패턴에 안 걸려 통과했다.
      || /^\d{1,3}(?:\.\d{1,3}){3}(?:[/:?#]|$)/.test(token)
    ) {
      urlCandidates.push(`https://${token}`);
    }
  }
  for (const candidate of urlCandidates) {
    let host = "";
    try {
      host = new URL(candidate).hostname.toLowerCase();
    } catch {
      throw invalidArgument("operatorMessage contains an unparseable URL");
    }
    if (host !== OPERATOR_MESSAGE_ALLOWED_HOST) {
      throw invalidArgument("operatorMessage may only link to the SCP creator portal");
    }
  }
  return message;
}

/**
 * W121(헤세): 사유 태그 키 — **구조화 와이어**다. 클라가 조립한 문장을 받으면 자유 텍스트와
 * 구분할 수 없으므로, 경계는 키만 통과시키고 문장은 서버 사전이 만든다(SEC-P0-009).
 *   · closed 카탈로그(videoReviewCriteria 룰 키 + 사유 문구 사전)에 있는 키만 — 미등록은 거부
 *   · 변경요청/반려에서만(승인 메일에는 사유 축이 없다 · operatorMessage 와 같은 게이트)
 *   · 중복 제거 후 최대 VIDEO_REVIEW_REASON_TAG_MAX 개, **순서는 운영자가 정한 그대로** 보존
 * 미등록 키를 조용히 버리지 않고 거부하는 이유: 버리면 운영자가 화면에서 고른 사유가 메일에서
 * 사라진 것을 아무도 모른다(fail-closed 방향 정합).
 */
export function parseVideoReviewReasonTagKeys(
  value: unknown,
  targetStatus: string,
): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw invalidArgument("reasonTagKeys must be an array");
  if (value.length === 0) return null;
  if (targetStatus !== "changes_requested" && targetStatus !== "rejected") {
    throw invalidArgument("reasonTagKeys is only allowed for changes_requested or rejected");
  }
  const keys: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw invalidArgument("reasonTagKeys must contain strings");
    const key = raw.trim();
    if (!key) continue;
    if (!isVideoReviewRuleTagKey(key)) {
      throw invalidArgument("reasonTagKeys must reference known review rule keys");
    }
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length === 0) return null;
  if (keys.length > VIDEO_REVIEW_REASON_TAG_MAX) {
    throw invalidArgument(`reasonTagKeys must contain at most ${VIDEO_REVIEW_REASON_TAG_MAX} keys`);
  }
  return keys;
}

/**
 * A human operator's final rejection always creates the transactional result-mail
 * outbox entry. The browser checkbox remains meaningful for approvals, but it
 * must not let a direct callable client silently suppress a rejection notice.
 * Delivery is still asynchronous and subject to the normal recipient, SMTP,
 * safety, retry, and audit gates.
 */
export function notifyCreatorForHumanVideoDecision(
  targetStatus: string,
  requestedNotifyCreator: unknown,
): boolean {
  return targetStatus === "rejected" || requestedNotifyCreator !== false;
}

export async function transitionVideoReviewDecisionHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "video_review.transition", OPERATOR_ROLES);
  await assertScpEntitled(auth, request, "video_review.transition");
  const data = asRecord(request.data);
  const submissionId = asString(data.submissionId);
  const targetStatus = asString(data.targetStatus);
  const decisionRef = asString(data.decisionRef);
  const expectedRevision = integerField(data.expectedRevision);
  if (!submissionId) throw invalidArgument("submissionId is required");
  if (!(VIDEO_REVIEW_STATES as readonly string[]).includes(targetStatus)) throw invalidArgument("valid targetStatus is required");
  if (!decisionRef) throw invalidArgument("decisionRef is required");
  if (!Number.isInteger(expectedRevision)) throw invalidArgument("expectedRevision is required");

  try {
    const result = await transitionVideoReviewDecision(
      {
        submissionId,
        targetStatus: targetStatus as VideoReviewState,
        reasonCode: asString(data.reasonCode) || null,
        customerMessageCode: asString(data.customerMessageCode) || null,
        operatorMessage: parseVideoReviewOperatorMessage(data.operatorMessage, targetStatus),
        reasonTagKeys: parseVideoReviewReasonTagKeys(data.reasonTagKeys, targetStatus),
        expectedRevision,
        expectedContentFingerprint: asString(data.expectedContentFingerprint),
        expectedCanonicalProgramId: asString(data.expectedCanonicalProgramId),
        expectedPolicyConfigHash: asString(data.expectedPolicyConfigHash),
        decisionRef,
        actorType: "human",
        actorId: auth.userId,
        notifyCreator: notifyCreatorForHumanVideoDecision(targetStatus, data.notifyCreator),
        evidence: Array.isArray(data.evidence) ? data.evidence : [],
      },
      new Date(),
    );
    return { ...result, behaviorLog: makeBehaviorLog(auth, "video_review.transition", "success") };
  } catch (error) {
    throw mapVideoReviewTransitionError(error, "transition_video_review_decision_handler");
  }
}

// Shared by transitionVideoReviewDecisionHandler and undoVideoReviewDecisionHandler — both call
// transitionVideoReviewDecision and must surface the SAME stable public error codes.
function mapVideoReviewTransitionError(error: unknown, errorCodePrefix: string): Error {
  if (error instanceof PartnerActivationError) {
    const errorCode = ALLOWLISTED_PARTNER_ACTIVATION_ERROR_CODES.has(error.code) ? error.code : "partner_activation_rejected";
    return Object.assign(new Error(`failed-precondition: ${errorCode}`), { code: "failed-precondition", errorCode });
  }
  if (error instanceof VideoReviewTransitionError) {
    if (error.code === "not_found") {
      return Object.assign(new Error("not-found: review state does not exist"), { code: "not-found", errorCode: `${errorCodePrefix}_review_state_exist` });
    }
    if (error.code === "invalid-argument") {
      return Object.assign(new Error(error.message), { code: "invalid-argument", errorCode: `${errorCodePrefix}_unauthorized_2` });
    }
    // stale_precondition / invalid_transition / reason_required / customer_message_required /
    // ai_not_permitted / rejected → diagnosable failed-precondition with a stable errorCode.
    const errorCode = `video_review_${error.code}`;
    return Object.assign(new Error(`failed-precondition: ${errorCode}`), { code: "failed-precondition", errorCode });
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Task-94: manager+ operator undo — the ONLY non-appeal way to move a `rejected` decision back to
 * `human_review_required`. Unlike transitionVideoReviewDecisionHandler, this does NOT trust
 * client-supplied CAS fields: it reads the review-state doc itself immediately before calling the
 * store (the store re-validates everything again inside its own transaction), so the public
 * surface is just {submissionId, expectedSeq, note}. `expectedSeq` must equal the seq of the
 * decision the caller means to undo — a stale queue view that undoes a NEWER rejection than the
 * one the operator actually reviewed fails closed with stale_precondition.
 */
export async function undoVideoReviewDecisionHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "video_review.undo", OPERATOR_ROLES);
  await assertScpEntitled(auth, request, "video_review.undo");
  const data = asRecord(request.data);
  const submissionId = asString(data.submissionId);
  const expectedSeq = integerField(data.expectedSeq);
  if (!submissionId) throw invalidArgument("submissionId is required");
  if (!Number.isInteger(expectedSeq) || expectedSeq <= 0) throw invalidArgument("expectedSeq is required");
  const note = parseUndoNote(data.note);

  const ref = adminDb.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION).doc(reviewDocId(submissionId));
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw Object.assign(new Error("not-found: review state does not exist"), { code: "not-found", errorCode: "undo_video_review_decision_handler_review_state_exist" });
  }
  const snapshotData = snapshot.data() ?? {};

  try {
    const result = await transitionVideoReviewDecision(
      {
        submissionId,
        targetStatus: "human_review_required",
        expectedRevision: Number(snapshotData.revision ?? 0),
        expectedContentFingerprint: asString(snapshotData.contentFingerprint),
        expectedCanonicalProgramId: asString(snapshotData.canonicalProgramId),
        expectedPolicyConfigHash: asString(snapshotData.policyConfigHash),
        expectedSeq,
        undoReason: "operator_undo",
        undoNote: note,
        // Deterministic per (submission, undone seq): a retried call is idempotent instead of
        // reprocessed, same discipline as every other decisionRef in this file.
        decisionRef: `operator_undo:${reviewDocId(submissionId)}:${expectedSeq}`,
        actorType: "human",
        actorId: auth.userId,
        notifyCreator: false,
      },
      new Date(),
    );
    return { ...result, behaviorLog: makeBehaviorLog(auth, "video_review.undo", "success") };
  } catch (error) {
    throw mapVideoReviewTransitionError(error, "undo_video_review_decision_handler");
  }
}

const UNDO_NOTE_MAX_LENGTH = 500;
function parseUndoNote(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw invalidArgument("note must be a string");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > UNDO_NOTE_MAX_LENGTH) throw invalidArgument(`note must be at most ${UNDO_NOTE_MAX_LENGTH} characters`);
  return trimmed;
}
