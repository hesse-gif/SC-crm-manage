// Portal -> Flu 영상 제출 ingress (server-to-server 전용, 적대적 fail-closed).
//
// 새 포털 플로우: Apply -> (Flu 소유) UID 안내 메일 -> UID 온보딩 게이트 -> 영상 제출.
// 포털 브라우저의 Flu Firestore 직접 쓰기는 어떤 경우에도 전제하지 않는다 —
// 이 모듈이 영상 제출의 유일한 소비 계약이다: 인증(HMAC)·멱등·감사·리플레이/
// 톰스톤/충돌 시맨틱을 갖춘 HTTP ingress 1개.
//
// 계약: scp.portal-video-submission.v1
// - 헤더: X-SCP-Contract-Version: v1 · X-SCP-Timestamp(Unix s) ·
//   X-SCP-Idempotency-Key(== body.sourceObservationId) · X-SCP-Signature(sha256=hex)
// - 서명 입력: `<timestamp>\n<sourceObservationId>\n<raw-body>` (정확한 UTF-8 바이트)
// - 비밀: SCP_PORTAL_INGRESS_SECRET(+_PREVIOUS 회전 창), 32바이트 이상.
// - 브라우저/Firebase/Google bearer, Cookie 는 인증 수단으로 절대 인정하지 않는다.
//
// 시맨틱:
// - receipt(멱등): 같은 observationId + 같은 바이트 = duplicate success(저장 결과 재반환),
//   같은 observationId + 다른 바이트 = observation_conflict.
// - revision: sourceSubmissionId 별 단조 증가(같거나 낮으면 stale_source_revision).
//   sourceUpdatedAt/sourceWatermark 후퇴 금지(stale_source_update).
// - tombstone: 활성 제출 없으면 submission_not_found. 데이터 파괴 없음 — projection 만
//   tombstoned 로 표시하고 기존 submissions 문서에는 사람 검토 마커만 부착한다.
// - 매핑: scp_portal_creator_bindings(6-ID tuple, super-admin 제공)만 정본.
//   불완전/불일치/비활성 → human_required 로 fail-closed(수용·감사하되 자동화 없음,
//   submissions 컬렉션 오염 없음).
// - UID: 의미(Firebase Auth UID 인지 게임 플레이어 UID 인지 등)는 코드/데이터로
//   확정되지 않았다 — 결정 게이트. 명시적 uid.status==="verified" 에 더해 uid.kind 가
//   운영 결정 allowlist 에 있어야만 자동화를 허용하며, 기본 allowlist 는 비어 있어
//   결정 전에는 전부 human_required(uid_kind_undecided) 다.
// - 자동화 핸드오프: 모든 게이트 통과 시 submissions 생성/개정과
//   enqueueVideoReviewAutomationOutboxInTransaction 이 단일 Firestore 트랜잭션에서
//   원자적으로 커밋된다(부분 상태 불가). 실제 자동검수 실행은 이 모듈 밖(별도 drain,
//   이 작업 범위에서 실행 금지).
// - gameId(다타이틀 계약, 2026-09-05): video 페이로드의 선택 키. **정본 필드명은 `gameId`**,
//   값은 프로그램 타이틀 레지스트리(functions/programTitles.seed.json)의 title id 다.
//   현재 포털은 `gameName: "xp-hero"` 를 보내므로 두 키를 모두 받고 하나로 정규화한다
//   (id / 사람이 읽는 이름 / 대소문자 / 공백·언더스코어 표기 모두 수용).
//   * 누락 → 프로그램 기본 타이틀(SCP = `xp-hero`). 기존 제출의 오늘 동작이 그대로 보존된다.
//     단 착지한 gameId 는 행의 선언이 아니라 스탬프라 `gameIdDefaulted: true` 가 함께 붙고,
//     strict 게임 필터는 그 값을 증거로 세지 않는다.
//   * 미등록 값 → **거부하지 않는다**. 기본 타이틀로 착지시키고 `gameIdUnresolved: true` 를
//     제출/검수 레코드에 붙여 사람 게이트가 집는다(레지스트리 편집이 배포보다 앞설 수 있다).
//     이 경우도 기본값 스탬프라 `gameIdDefaulted: true` 가 함께 붙는다.
//   * 두 키가 동시에 오고 서로 다른 타이틀을 가리키면 invalid_payload(조용한 승자 없음).
// - 로그 allowlist: requestId/code/state/duplicate 만. 이메일·토큰·UID 값·링크·원문
//   페이로드는 일반 로그에 절대 남기지 않는다.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
// 2026-09-05 다타이틀: 제출이 어느 게임 타이틀인지 레지스트리로 확정한다(타이틀별 분기 없음).
import { resolveSubmissionGameId } from "./programTitles";
import { loadProgramTitleRegistry } from "./programTitlesStore";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { assertScpEntitled } from "./mailAccounts";
import { youtubeOAuthPortalBindingDocumentId } from "./youtubeOAuthHandoff";
import { enqueueVideoReviewAutomationOutboxInTransaction } from "./videoReviewAutomationOutbox";
import { planVideoReviewSourceInvalidation } from "./videoReviewSourceInvalidation";
import { videoReviewEvidenceIdentityFingerprints } from "./videoReviewEvidence";
import {
  resolveAuthoritativeVideoReviewProgramScope,
  videoReviewScopePreservingSubmissionUpdate,
  type VideoReviewProgramScope,
} from "./videoReviewProgramScope";

export const SCP_PORTAL_SUBMISSION_CONTRACT = "scp.portal-video-submission.v1" as const;
export const SCP_PORTAL_INGRESS_SECRET_ENV = "SCP_PORTAL_INGRESS_SECRET";
export const SCP_PORTAL_INGRESS_PREVIOUS_SECRET_ENV = "SCP_PORTAL_INGRESS_SECRET_PREVIOUS";
export const SCP_PORTAL_SUBMISSION_MAX_BODY_BYTES = 64 * 1024;
export const SCP_PORTAL_SUBMISSION_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
export const SCP_PORTAL_SUBMISSION_RATE_LIMIT_PER_MINUTE = 120;

export const PORTAL_SUBMISSION_RECEIPTS_COLLECTION = "scp_portal_submission_ingest_receipts";
export const PORTAL_SUBMISSION_OBSERVATIONS_COLLECTION = "scp_portal_submission_observations";
export const PORTAL_SUBMISSION_PROJECTION_COLLECTION = "scp_portal_video_submissions";
export const PORTAL_SUBMISSION_RATE_LIMITS_COLLECTION = "scp_portal_submission_ingress_rate_limits";
const BINDINGS_COLLECTION = "scp_portal_creator_bindings";

// UID 의미 결정 게이트: 운영 결정이 코드로 착지하기 전에는 어떤 kind 도 자동화를
// 열지 못한다. 결정이 나면 이 allowlist 에 kind 를 추가하는 커밋이 결정의 증거다.
export const ACCEPTED_UID_VERIFICATION_KINDS: readonly string[] = [];

export const HUMAN_REQUIRED_REASONS = [
  "mapping_not_found",
  "mapping_inactive",
  "mapping_conflict",
  "mapping_source_refs_missing",
  "program_scope_unresolved",
  "program_scope_ambiguous",
  "uid_unverified",
  "uid_kind_undecided",
  "game_id_unresolved",
  "portal_withdrawal_review",
] as const;
export type HumanRequiredReason = (typeof HUMAN_REQUIRED_REASONS)[number];

type IngressError = Error & { code: string };

function ingressError(code: string, message: string): IngressError {
  return Object.assign(new Error(message), { code });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const OBSERVATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{3,119}$/;

function requiredIdentifier(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!IDENTIFIER_RE.test(normalized)) throw ingressError("invalid_payload", `${field} is not a supported identifier`);
  return normalized;
}

function requiredIso(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  const parsed = Date.parse(normalized);
  if (!normalized || Number.isNaN(parsed)) throw ingressError("invalid_payload", `${field} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function requiredRevision(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,18}$/.test(normalized)) throw ingressError("invalid_payload", `${field} must be an unsigned integer string`);
  return BigInt(normalized).toString();
}

function requiredHttpsUrl(value: unknown, field: string, maxLength = 1_000): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) throw ingressError("invalid_payload", `${field} is required`);
  try {
    if (new URL(normalized).protocol !== "https:") throw new Error("not https");
  } catch {
    throw ingressError("invalid_payload", `${field} must be an https URL`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > maxLength) {
    throw ingressError("invalid_payload", `${field} is invalid`);
  }
  return value.trim();
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ingressError("invalid_payload", `${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw ingressError("invalid_payload", `${label} has unsupported key ${key}`);
  }
  for (const key of keys) {
    if (optional.includes(key)) continue;
    if (!(key in record)) throw ingressError("invalid_payload", `${label} is missing ${key}`);
  }
  return record;
}

// ---- 계약 타입/정규화 --------------------------------------------------------

export type PortalSubmissionCreatorTuple = {
  portalCreatorId: string;
  fluCreatorId: string;
  partnerId: string;
  programId: string;
  enrollmentId: string;
  channelId: string;
};

export type PortalSubmissionUidAttestation = {
  value: string;
  kind: string;
  status: "verified" | "unverified" | "failed";
  verifiedAt?: string;
};

export type NormalizedPortalVideoSubmission = {
  contractVersion: typeof SCP_PORTAL_SUBMISSION_CONTRACT;
  sourceObservationId: string;
  sourceSubmissionId: string;
  revision: string;
  operation: "upsert" | "tombstone";
  sourceUpdatedAt: string;
  sourceWatermark: string;
  sourceFingerprint: string;
  creator: PortalSubmissionCreatorTuple;
  uid?: PortalSubmissionUidAttestation;
  video?: {
    videoUrl: string;
    youtubeVideoId: string;
    title: string;
    contentType: string;
    submittedAt: string;
    /** 레지스트리 타이틀 id(정규화 완료). 미선언이면 빈 문자열 — 저장 시 기본 타이틀로 확정된다. */
    gameId: string;
  };
  tombstone?: { deletedAt: string; reasonCode: string };
};

export function normalizeScpPortalSubmission(
  value: unknown,
  // 2026-09-05 P1 리뷰 수리: 운영 오버라이드(settings/program_titles)가 gameId/gameName 일치
  // 검사에도 닿게 한다. 이 함수는 동기라 직접 로드하지 못한다 — 유일한 async 호출부
  // (ingestScpPortalVideoSubmission)가 진입 시 한 번 로드해 넘긴다. 미지정이면 시드만 본다.
  registryOverride?: unknown,
): NormalizedPortalVideoSubmission {
  const input = exactRecord(value, [
    "contractVersion",
    "creator",
    "operation",
    "revision",
    "sourceFingerprint",
    "sourceObservationId",
    "sourceSubmissionId",
    "sourceUpdatedAt",
    "sourceWatermark",
    "tombstone",
    "uid",
    "video",
  ], "portal submission schema", ["tombstone", "uid", "video"]);
  if (input.contractVersion !== SCP_PORTAL_SUBMISSION_CONTRACT) {
    throw ingressError("unsupported_contract", "unsupported portal submission contract");
  }
  const sourceObservationId = typeof input.sourceObservationId === "string" ? input.sourceObservationId.trim() : "";
  if (!OBSERVATION_ID_RE.test(sourceObservationId)) {
    throw ingressError("invalid_payload", "sourceObservationId is invalid");
  }
  if (input.operation !== "upsert" && input.operation !== "tombstone") {
    throw ingressError("invalid_payload", "operation must be upsert or tombstone");
  }
  const operation = input.operation;
  const sourceFingerprint = typeof input.sourceFingerprint === "string" ? input.sourceFingerprint.trim().toLowerCase() : "";
  if (!FINGERPRINT_RE.test(sourceFingerprint)) {
    throw ingressError("invalid_payload", "sourceFingerprint must be a sha256 hex digest");
  }
  const creatorRecord = exactRecord(input.creator, [
    "channelId",
    "enrollmentId",
    "fluCreatorId",
    "partnerId",
    "portalCreatorId",
    "programId",
  ], "creator tuple");
  const creator: PortalSubmissionCreatorTuple = {
    portalCreatorId: requiredIdentifier(creatorRecord.portalCreatorId, "creator.portalCreatorId"),
    fluCreatorId: requiredIdentifier(creatorRecord.fluCreatorId, "creator.fluCreatorId"),
    partnerId: requiredIdentifier(creatorRecord.partnerId, "creator.partnerId"),
    programId: requiredIdentifier(creatorRecord.programId, "creator.programId"),
    enrollmentId: requiredIdentifier(creatorRecord.enrollmentId, "creator.enrollmentId"),
    channelId: requiredIdentifier(creatorRecord.channelId, "creator.channelId"),
  };
  const sourceUpdatedAt = requiredIso(input.sourceUpdatedAt, "sourceUpdatedAt");
  const base = {
    contractVersion: SCP_PORTAL_SUBMISSION_CONTRACT,
    sourceObservationId,
    sourceSubmissionId: requiredIdentifier(input.sourceSubmissionId, "sourceSubmissionId"),
    revision: requiredRevision(input.revision, "revision"),
    operation,
    sourceUpdatedAt,
    sourceWatermark: requiredIso(input.sourceWatermark, "sourceWatermark"),
    sourceFingerprint,
    creator,
  };

  if (operation === "tombstone") {
    if (input.uid !== undefined || input.video !== undefined) {
      throw ingressError("invalid_payload", "tombstone must not carry uid or video payloads");
    }
    const tombstoneRecord = exactRecord(input.tombstone, ["deletedAt", "reasonCode"], "tombstone");
    const deletedAt = requiredIso(tombstoneRecord.deletedAt, "tombstone.deletedAt");
    if (Date.parse(deletedAt) < Date.parse(sourceUpdatedAt)) {
      throw ingressError("invalid_payload", "tombstone.deletedAt cannot be earlier than sourceUpdatedAt");
    }
    return {
      ...base,
      operation: "tombstone",
      tombstone: {
        deletedAt,
        reasonCode: requiredIdentifier(tombstoneRecord.reasonCode, "tombstone.reasonCode"),
      },
    };
  }

  if (input.tombstone !== undefined) {
    throw ingressError("invalid_payload", "upsert must not carry tombstone fields");
  }
  const uidRecord = exactRecord(input.uid, ["kind", "status", "value", "verifiedAt"], "uid attestation", ["verifiedAt"]);
  if (uidRecord.status !== "verified" && uidRecord.status !== "unverified" && uidRecord.status !== "failed") {
    throw ingressError("invalid_payload", "uid.status must be verified, unverified, or failed");
  }
  const uid: PortalSubmissionUidAttestation = {
    value: requiredIdentifier(uidRecord.value, "uid.value"),
    kind: requiredIdentifier(uidRecord.kind, "uid.kind"),
    status: uidRecord.status,
    ...(uidRecord.verifiedAt !== undefined ? { verifiedAt: requiredIso(uidRecord.verifiedAt, "uid.verifiedAt") } : {}),
  };
  if (uid.status === "verified" && !uid.verifiedAt) {
    throw ingressError("invalid_payload", "uid.verifiedAt is required when uid.status is verified");
  }
  const videoRecord = exactRecord(input.video, [
    "contentType",
    "gameId",
    "gameName",
    "submittedAt",
    "title",
    "videoUrl",
    "youtubeVideoId",
  ], "video payload", ["contentType", "gameId", "gameName", "title", "youtubeVideoId"]);
  const declaredGameId = optionalText(videoRecord.gameId, "video.gameId", 64);
  const declaredGameName = optionalText(videoRecord.gameName, "video.gameName", 120);
  if (declaredGameId && declaredGameName) {
    const byId = resolveSubmissionGameId(creator.programId, declaredGameId, registryOverride);
    const byName = resolveSubmissionGameId(creator.programId, declaredGameName, registryOverride);
    if (byId.gameId !== byName.gameId) {
      throw ingressError("invalid_payload", "video.gameId and video.gameName disagree");
    }
  }
  // 2026-09-05 P2 리뷰 수리: contentType 미선언 시 폴백은 타이틀과 무관한 상수("weaponrpg_scp_video",
  // 사실은 XP Hero 패키지명)가 아니라 이 제출이 착지할 타이틀의 슬러그에서 나온다(`<slug>_scp_video`).
  // 과거에 이 상수로 저장된 문서는 그대로 유효하다 — 아무 소비자도 contentType 값을 비교하지
  // 않는다(설명용 필드), 그래서 레거시 값을 별도로 마이그레이션할 필요가 없다.
  const resolvedTitleSlug = resolveSubmissionGameId(
    creator.programId,
    declaredGameId || declaredGameName,
    registryOverride,
  ).gameId.replace(/-/g, "_") || "scp";
  return {
    ...base,
    operation: "upsert",
    uid,
    video: {
      videoUrl: requiredHttpsUrl(videoRecord.videoUrl, "video.videoUrl"),
      youtubeVideoId: optionalText(videoRecord.youtubeVideoId, "video.youtubeVideoId", 32),
      title: optionalText(videoRecord.title, "video.title", 500),
      contentType: optionalText(videoRecord.contentType, "video.contentType", 80) || `${resolvedTitleSlug}_scp_video`,
      submittedAt: requiredIso(videoRecord.submittedAt, "video.submittedAt"),
      gameId: declaredGameId || declaredGameName,
    },
  };
}

// ---- 서명 --------------------------------------------------------------------

export function signScpPortalIngressForTest(
  rawBody: string,
  timestamp: string,
  idempotencyKey: string,
  secret: string,
): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}\n${idempotencyKey}\n${rawBody}`).digest("hex")}`;
}

export function verifyScpPortalIngressSignature(input: {
  rawBody: string;
  timestamp: string;
  idempotencyKey: string;
  signature: string;
  secret: string;
  maxBodyBytes?: number;
  now?: Date;
}): boolean {
  if (Buffer.byteLength(input.secret, "utf8") < 32) return false;
  if (Buffer.byteLength(input.rawBody, "utf8") > (input.maxBodyBytes ?? SCP_PORTAL_SUBMISSION_MAX_BODY_BYTES)) return false;
  if (!input.idempotencyKey || input.idempotencyKey.length > 200 || /\s/.test(input.idempotencyKey)) return false;
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isInteger(timestampSeconds)) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > SCP_PORTAL_SUBMISSION_SIGNATURE_TOLERANCE_SECONDS) return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(input.signature.trim());
  if (!match) return false;
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}\n${input.idempotencyKey}\n${input.rawBody}`)
    .digest();
  const received = Buffer.from(match[1], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function verifyScpPortalIngressAuth(input: {
  rawBody: string;
  timestamp: string;
  idempotencyKey: string;
  signature: string;
  isHttps: boolean;
  hasBearerOrCookie: boolean;
  contractVersionHeader: string;
  secret?: string;
  previousSecret?: string;
  maxBodyBytes?: number;
  now?: Date;
  /**
   * 계약별 정확한 버전 헤더 값 — Portal 핀 계약은 전체 schemaVersion 문자열을 쓴다.
   * 여러 계약 버전을 동시 수용하는 수신기(예: application-command v1+v2)는 배열을 전달한다.
   */
  expectedContractVersion?: string | readonly string[];
  secretEnv?: string;
  previousSecretEnv?: string;
}): void {
  if (!input.isHttps) throw ingressError("https_required", "HTTPS is required");
  if (input.hasBearerOrCookie) {
    throw ingressError("service_auth_required", "browser or bearer credentials are not accepted");
  }
  const expectedContractVersions = Array.isArray(input.expectedContractVersion)
    ? input.expectedContractVersion
    : [input.expectedContractVersion ?? "v1"];
  if (!expectedContractVersions.includes(input.contractVersionHeader)) {
    throw ingressError("unsupported_contract", "unsupported contract version header");
  }
  const secret = input.secret ?? ingressSecretFromEnv(input.secretEnv ?? SCP_PORTAL_INGRESS_SECRET_ENV);
  const previousSecret = input.previousSecret ?? ingressSecretFromEnv(input.previousSecretEnv ?? SCP_PORTAL_INGRESS_PREVIOUS_SECRET_ENV);
  const currentValid = verifyScpPortalIngressSignature({
    rawBody: input.rawBody,
    timestamp: input.timestamp,
    idempotencyKey: input.idempotencyKey,
    signature: input.signature,
    secret,
    maxBodyBytes: input.maxBodyBytes,
    now: input.now,
  });
  const previousValid = previousSecret.length > 0 && verifyScpPortalIngressSignature({
    rawBody: input.rawBody,
    timestamp: input.timestamp,
    idempotencyKey: input.idempotencyKey,
    signature: input.signature,
    secret: previousSecret,
    maxBodyBytes: input.maxBodyBytes,
    now: input.now,
  });
  if (!currentValid && !previousValid) {
    throw ingressError("invalid_signature", "invalid or stale ingress signature");
  }
}

function ingressSecretFromEnv(envName: string): string {
  const configured = process.env[envName];
  if (configured) return configured;
  if (process.env.FUNCTIONS_EMULATOR !== "true") return "";
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_CONFIG || "";
  if (!project.includes("demo-flu")) return "";
  if (envName === "SCP_FLU_VIDEO_INTAKE_SECRET") return "flu-video-intake-e2e-secret-0123456789abcdef";
  if (envName === "SCP_FLU_APPLICATION_COMMAND_SECRET") return "flu-application-command-e2e-secret-0123456789abcdef";
  return "";
}

// ---- ingest ------------------------------------------------------------------

export type IngestScpPortalVideoSubmissionInput = {
  rawBody: string;
  timestamp: string;
  idempotencyKeyHeader: string;
  contractVersionHeader: string;
  signature: string;
  isHttps: boolean;
  hasBearerOrCookie: boolean;
  now?: Date;
  secret?: string;
  previousSecret?: string;
  /** UID 의미 결정 게이트 — 프로덕션 기본값은 빈 allowlist(전부 human_required). */
  acceptedUidKinds?: readonly string[];
  /**
   * UID gate policy. Default "v1_fail_closed" preserves the deployed v1 behavior (unverified /
   * undecided UID -> human_required) for rollback compatibility. The scp.integration-event.v2
   * adapter passes "v2_non_blocking": under uidPolicy=required_before_gem, video review
   * eligibility does NOT depend on UID, so the UID gate is skipped while the binding and
   * program-scope gates still route missing/conflicting bindings to human_required. The UID
   * attestation is still recorded on the submission for operations (never falsely "verified").
   */
  uidGatePolicy?: "v1_fail_closed" | "v2_non_blocking";
};

export type IngestScpPortalVideoSubmissionResult = {
  duplicate: boolean;
  state: "auto_enqueued" | "human_required" | "tombstoned";
  humanRequiredReasons: HumanRequiredReason[];
  outboxEnqueued: boolean;
  submissionId: string | null;
  observationId: string;
};

export function portalSubmissionDocumentId(sourceSubmissionId: string): string {
  return `portal:${sourceSubmissionId}`;
}

export function portalSubmissionProjectionDocumentId(sourceSubmissionId: string): string {
  return `pvs_${sha256(sourceSubmissionId).slice(0, 40)}`;
}

function receiptDocumentId(observationId: string): string {
  return `pvsr_${sha256(observationId).slice(0, 40)}`;
}

function observationDocumentId(observationId: string): string {
  return `pvso_${sha256(observationId).slice(0, 40)}`;
}

async function consumeIngressRateLimit(now: Date): Promise<void> {
  const windowId = Math.floor(now.getTime() / 60_000);
  const ref = adminDb.collection(PORTAL_SUBMISSION_RATE_LIMITS_COLLECTION).doc(`portal_v1_${windowId}`);
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = Number(snapshot.data()?.count ?? 0);
    if (!Number.isInteger(current) || current < 0 || current >= SCP_PORTAL_SUBMISSION_RATE_LIMIT_PER_MINUTE) {
      throw ingressError("rate_limited", "authenticated ingress rate limit exceeded");
    }
    transaction.set(ref, {
      serviceIdentity: "scp-creator-portal:video-submission-v1",
      count: FieldValue.increment(1),
      windowStartIso: new Date(windowId * 60_000).toISOString(),
      expiresAtIso: new Date((windowId + 10) * 60_000).toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

function evaluateBindingGate(
  binding: Record<string, unknown> | null,
  creator: PortalSubmissionCreatorTuple,
): HumanRequiredReason[] {
  if (!binding) return ["mapping_not_found"];
  if (asString(binding.status) !== "active") return ["mapping_inactive"];
  const tupleMatches = (
    asString(binding.portalCreatorId) === creator.portalCreatorId
    && asString(binding.fluCreatorId) === creator.fluCreatorId
    && asString(binding.partnerId) === creator.partnerId
    && asString(binding.programId) === creator.programId
    && asString(binding.enrollmentId) === creator.enrollmentId
    && asString(binding.channelId) === creator.channelId
  );
  if (!tupleMatches) return ["mapping_conflict"];
  if (!asString(binding.sourceLeadRef) || !asString(binding.sourceApplicationRef)) {
    return ["mapping_source_refs_missing"];
  }
  return [];
}

function evaluateUidGate(
  uid: PortalSubmissionUidAttestation,
  acceptedKinds: readonly string[],
): HumanRequiredReason[] {
  if (uid.status !== "verified") return ["uid_unverified"];
  if (!acceptedKinds.includes(uid.kind)) return ["uid_kind_undecided"];
  return [];
}

function refDocumentId(refPath: string, collection: string): string {
  const match = new RegExp(`^${collection}/([^/]+)$`).exec(refPath.trim());
  return match ? match[1] : "";
}

export async function ingestScpPortalVideoSubmission(
  input: IngestScpPortalVideoSubmissionInput,
): Promise<IngestScpPortalVideoSubmissionResult> {
  verifyScpPortalIngressAuth({
    rawBody: input.rawBody,
    timestamp: input.timestamp,
    idempotencyKey: input.idempotencyKeyHeader,
    signature: input.signature,
    isHttps: input.isHttps,
    hasBearerOrCookie: input.hasBearerOrCookie,
    contractVersionHeader: input.contractVersionHeader,
    secret: input.secret,
    previousSecret: input.previousSecret,
    now: input.now,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    throw ingressError("invalid_payload", "invalid ingress JSON");
  }
  // 2026-09-05 P1 리뷰 수리: 레지스트리 운영 오버라이드를 한 번 로드해 정규화·저장 두 곳(아래
  // resolveSubmissionGameId 호출부)에 그대로 넘긴다 — 요청 하나 안에서 일관된 레지스트리를
  // 본다. programId 는 아직 검증 전 원문에서 얕게 읽는다: 캐시 조회 키로만 쓰이고
  // loadProgramTitleRegistry 는 알 수 없는/잘못된 값을 조용히 시드로 접는다(fail-open, 인제스트
  // 자체는 정식 검증을 normalizeScpPortalSubmission 이 그대로 담당한다).
  const declaredProgramId = asRecord(asRecord(parsed).creator).programId;
  const registryOverride = await loadProgramTitleRegistry(declaredProgramId);
  const envelope = normalizeScpPortalSubmission(parsed, registryOverride);
  if (envelope.sourceObservationId !== input.idempotencyKeyHeader) {
    throw ingressError("idempotency_mismatch", "idempotency key does not match body sourceObservationId");
  }

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const acceptedUidKinds = input.acceptedUidKinds ?? ACCEPTED_UID_VERIFICATION_KINDS;
  await consumeIngressRateLimit(now);
  const bodyHash = sha256(input.rawBody);

  const receiptRef = adminDb.collection(PORTAL_SUBMISSION_RECEIPTS_COLLECTION)
    .doc(receiptDocumentId(envelope.sourceObservationId));
  const observationRef = adminDb.collection(PORTAL_SUBMISSION_OBSERVATIONS_COLLECTION)
    .doc(observationDocumentId(envelope.sourceObservationId));
  const projectionRef = adminDb.collection(PORTAL_SUBMISSION_PROJECTION_COLLECTION)
    .doc(portalSubmissionProjectionDocumentId(envelope.sourceSubmissionId));
  const submissionRef = adminDb.collection("submissions")
    .doc(portalSubmissionDocumentId(envelope.sourceSubmissionId));
  const bindingRef = adminDb.collection(BINDINGS_COLLECTION)
    .doc(youtubeOAuthPortalBindingDocumentId(envelope.creator.fluCreatorId));

  return adminDb.runTransaction(async (transaction) => {
    // ---- 읽기 단계 (모든 read 는 write 이전) ----------------------------------
    const [receiptSnapshot, projectionSnapshot, bindingSnapshot, submissionSnapshot] = await Promise.all([
      transaction.get(receiptRef),
      transaction.get(projectionRef),
      transaction.get(bindingRef),
      transaction.get(submissionRef),
    ]);

    if (receiptSnapshot.exists) {
      const receipt = receiptSnapshot.data() ?? {};
      if (asString(receipt.bodyHash) !== bodyHash) {
        throw ingressError("observation_conflict", "sourceObservationId was reused with different bytes");
      }
      return {
        duplicate: true,
        state: (asString(receipt.state) || "human_required") as IngestScpPortalVideoSubmissionResult["state"],
        humanRequiredReasons: (Array.isArray(receipt.humanRequiredReasons)
          ? receipt.humanRequiredReasons
          : []) as HumanRequiredReason[],
        outboxEnqueued: receipt.outboxEnqueued === true,
        submissionId: asString(receipt.submissionId) || null,
        observationId: envelope.sourceObservationId,
      };
    }

    const projection = projectionSnapshot.exists ? (projectionSnapshot.data() ?? {}) : null;
    if (projection) {
      if (BigInt(envelope.revision) <= BigInt(asString(projection.revision) || "0")) {
        throw ingressError("stale_source_revision", "revision must strictly increase per sourceSubmissionId");
      }
      const storedUpdatedAt = asString(projection.sourceUpdatedAt);
      const storedWatermark = asString(projection.sourceWatermark);
      if (
        (storedUpdatedAt && Date.parse(envelope.sourceUpdatedAt) < Date.parse(storedUpdatedAt))
        || (storedWatermark && Date.parse(envelope.sourceWatermark) < Date.parse(storedWatermark))
      ) {
        throw ingressError("stale_source_update", "source clocks cannot move backward");
      }
      if (asString(projection.sourceFingerprint) === envelope.sourceFingerprint
        && asString(projection.state) !== "tombstoned"
        && envelope.operation === "upsert") {
        // 동일 콘텐츠의 새 리비전 재전송 — 새 관측으로 수용하되 자동화 재큐는 하지 않는다
        // (fingerprint 불변 → 소스 변화 없음). 감사 행은 남긴다.
      }
    } else if (envelope.operation === "tombstone") {
      throw ingressError("submission_not_found", "tombstone requires an existing active submission");
    }

    const humanReasons: HumanRequiredReason[] = [];
    let programScope: VideoReviewProgramScope | null = null;
    let candidateSubmission: Record<string, unknown> | null = null;
    const existingSubmission: (Record<string, unknown> & { id: string }) | null = submissionSnapshot.exists
      ? { ...(submissionSnapshot.data() ?? {}), id: submissionSnapshot.id }
      : null;

    // 다타이틀 해석은 게이트 판정보다 먼저 한다 — 미등록 gameId 는 거부가 아니라 사람 게이트다.
    // registryOverride 는 이 요청 진입부에서 한 번 로드한 값과 같다(위 normalizeScpPortalSubmission
    // 호출과 동일 레지스트리를 본다).
    const gameResolution = envelope.video
      ? resolveSubmissionGameId(envelope.creator.programId, envelope.video.gameId, registryOverride)
      : null;

    if (envelope.operation === "upsert") {
      const binding = bindingSnapshot.exists ? (bindingSnapshot.data() ?? {}) : null;
      if (gameResolution?.gameIdUnresolved) humanReasons.push("game_id_unresolved");
      humanReasons.push(...evaluateBindingGate(binding, envelope.creator));
      if ((input.uidGatePolicy ?? "v1_fail_closed") === "v1_fail_closed") {
        humanReasons.push(...evaluateUidGate(envelope.uid!, acceptedUidKinds));
      }

      if (!humanReasons.length && binding) {
        const leadId = refDocumentId(asString(binding.sourceLeadRef), "program_sheet_leads");
        const applicationId = refDocumentId(asString(binding.sourceApplicationRef), "program_applications");
        if (!leadId || !applicationId) {
          humanReasons.push("mapping_source_refs_missing");
        } else {
          const video = envelope.video!;
          const contentBase = {
            youtubeUrl: video.videoUrl,
            contentUrls: [video.videoUrl],
            submitNote: "",
            formResponses: [],
            submissionRequestFingerprint: envelope.sourceFingerprint,
          };
          candidateSubmission = {
            id: submissionRef.id,
            leadId,
            leadRef: `program_sheet_leads/${leadId}`,
            applicationId,
            applicationRef: `program_applications/${applicationId}`,
            creatorId: envelope.creator.fluCreatorId,
            email: "",
            app: "Weapon RPG SCP",
            ...contentBase,
            videoReviewEvidenceIdentityFingerprints: videoReviewEvidenceIdentityFingerprints({
              ...contentBase,
              submittedAtIso: nowIso,
              resubmissionCount: existingSubmission
                ? (Array.isArray(existingSubmission.revisions) ? existingSubmission.revisions.length + 1 : 1)
                : 0,
            }),
            contentType: video.contentType,
            title: video.title,
            youtubeVideoId: video.youtubeVideoId,
            // 다타이틀: 어느 게임 타이틀 제출인지. 미선언/미등록은 기본 타이틀로 착지하고
            // gameIdUnresolved 가 사람 게이트를 켠다(검수 큐가 이 필드들을 그대로 읽는다).
            // gameIdDefaulted 는 착지한 gameId 가 선언이 아니라 스탬프라는 표시다 — strict
            // 필터는 마커가 붙은 gameId 를 증거로 세지 않는다.
            ...(gameResolution ?? {}),
            submittedAtIso: nowIso,
            reviewStatus: "pending",
            rejectedReason: "",
            source: "scp_portal_video_submission_ingress",
            portalSource: {
              sourceSubmissionId: envelope.sourceSubmissionId,
              sourceObservationId: envelope.sourceObservationId,
              revision: envelope.revision,
              portalCreatorId: envelope.creator.portalCreatorId,
              enrollmentId: envelope.creator.enrollmentId,
              channelId: envelope.creator.channelId,
              partnerId: envelope.creator.partnerId,
              uidKind: envelope.uid!.kind,
              uidStatus: envelope.uid!.status,
              uidValueHash: sha256(envelope.uid!.value),
            },
            updatedAtIso: nowIso,
          };
          try {
            programScope = await resolveAuthoritativeVideoReviewProgramScope(candidateSubmission, {
              recordReader: async (collection, documentId) => {
                const related = await transaction.get(adminDb.collection(collection).doc(documentId));
                return related.exists ? { id: related.id, ...(related.data() ?? {}) } : null;
              },
            });
          } catch (error) {
            const code = (error as IngressError)?.code ?? "";
            humanReasons.push(code === "video_review_program_scope_ambiguous"
              ? "program_scope_ambiguous"
              : "program_scope_unresolved");
            programScope = null;
          }
        }
      }
    } else {
      humanReasons.push("portal_withdrawal_review");
    }

    const state: IngestScpPortalVideoSubmissionResult["state"] = envelope.operation === "tombstone"
      ? "tombstoned"
      : humanReasons.length > 0
        ? "human_required"
        : "auto_enqueued";
    let outboxEnqueued = false;
    let committedSubmissionId: string | null = null;

    // ---- 자동화 핸드오프 (enqueue 내부 read 포함 — 이후는 write 만) -----------
    if (state === "auto_enqueued" && programScope && candidateSubmission) {
      const sourcePlan = planVideoReviewSourceInvalidation({
        existingSubmission: existingSubmission,
        nextSubmission: candidateSubmission,
        nowIso,
        programScope,
      });
      await enqueueVideoReviewAutomationOutboxInTransaction(transaction, {
        submissionId: submissionRef.id,
        kind: "ai_recommendation",
        nowIso,
        source: candidateSubmission,
        sourceFingerprint: sourcePlan.nextAutomationSourceFingerprint,
        programScope: sourcePlan.programScope,
      });
      outboxEnqueued = true;
      committedSubmissionId = submissionRef.id;

      if (existingSubmission) {
        const priorRevisions = Array.isArray(existingSubmission.revisions) ? existingSubmission.revisions : [];
        transaction.update(submissionRef, videoReviewScopePreservingSubmissionUpdate({
          ...candidateSubmission,
          canonicalProgramId: programScope.canonicalProgramId,
          revisions: [
            ...priorRevisions,
            {
              revision: priorRevisions.length + 1,
              supersededAtIso: nowIso,
              reviewStatus: asString(existingSubmission.reviewStatus, "pending"),
              youtubeUrl: asString(existingSubmission.youtubeUrl, ""),
              submittedAtIso: asString(existingSubmission.submittedAtIso, ""),
            },
          ],
          resubmissionCount: priorRevisions.length + 1,
          resubmittedAtIso: nowIso,
          submittedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          ...sourcePlan.submissionPatch,
        }));
      } else {
        transaction.create(submissionRef, {
          ...candidateSubmission,
          canonicalProgramId: programScope.canonicalProgramId,
          revisions: [],
          resubmissionCount: 0,
          reviewNotes: [],
          reviewMemo: "",
          aiRecommendation: null,
          aiRecommendationMultimodal: null,
          payment: null,
          payableStatus: "not_payable",
          countsInitialized: true,
          submittedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          ...sourcePlan.submissionPatch,
        });
        transaction.set(adminDb.collection("submission_review_counts").doc(programScope.canonicalProgramId), {
          id: programScope.canonicalProgramId,
          programId: programScope.canonicalProgramId,
          statuses: { pending: FieldValue.increment(1) },
          payments: { not_payable: FieldValue.increment(1) },
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }

    if (state === "tombstoned" && existingSubmission) {
      // 데이터 파괴 금지: 리뷰 상태를 지우지 않고 사람 검토 마커만 부착한다.
      transaction.update(submissionRef, {
        portalWithdrawal: {
          sourceObservationId: envelope.sourceObservationId,
          revision: envelope.revision,
          deletedAt: envelope.tombstone!.deletedAt,
          reasonCode: envelope.tombstone!.reasonCode,
          recordedAtIso: nowIso,
        },
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      });
      committedSubmissionId = submissionRef.id;
    }

    // ---- receipt / observation / projection (항상 기록 — 감사 원장) ----------
    transaction.create(receiptRef, {
      id: receiptRef.id,
      contractVersion: envelope.contractVersion,
      sourceObservationId: envelope.sourceObservationId,
      bodyHash,
      state,
      humanRequiredReasons: humanReasons,
      outboxEnqueued,
      submissionId: committedSubmissionId,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.create(observationRef, {
      id: observationRef.id,
      contractVersion: envelope.contractVersion,
      operation: envelope.operation,
      sourceObservationId: envelope.sourceObservationId,
      sourceSubmissionId: envelope.sourceSubmissionId,
      revision: envelope.revision,
      sourceUpdatedAt: envelope.sourceUpdatedAt,
      sourceWatermark: envelope.sourceWatermark,
      sourceFingerprint: envelope.sourceFingerprint,
      creator: envelope.creator,
      ...(envelope.uid ? {
        uidKind: envelope.uid.kind,
        uidStatus: envelope.uid.status,
        uidValueHash: sha256(envelope.uid.value),
      } : {}),
      ...(envelope.video ? { videoUrl: envelope.video.videoUrl, youtubeVideoId: envelope.video.youtubeVideoId } : {}),
      ...(envelope.tombstone ? { tombstone: envelope.tombstone } : {}),
      state,
      humanRequiredReasons: humanReasons,
      outboxEnqueued,
      submissionId: committedSubmissionId,
      recordedAtIso: nowIso,
      recordedAt: FieldValue.serverTimestamp(),
    });
    const projectionWrite = {
      id: projectionRef.id,
      sourceSubmissionId: envelope.sourceSubmissionId,
      latestObservationId: envelope.sourceObservationId,
      revision: envelope.revision,
      sourceUpdatedAt: envelope.sourceUpdatedAt,
      sourceWatermark: envelope.sourceWatermark,
      sourceFingerprint: envelope.sourceFingerprint,
      creator: envelope.creator,
      state,
      humanRequiredReasons: humanReasons,
      outboxEnqueued,
      submissionId: committedSubmissionId ?? (projection ? asString(projection.submissionId) || null : null),
      ...(envelope.tombstone ? { tombstone: envelope.tombstone } : {}),
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
      ...(projection ? {} : { createdAtIso: nowIso, createdAt: FieldValue.serverTimestamp() }),
    };
    if (projection) transaction.update(projectionRef, projectionWrite);
    else transaction.create(projectionRef, projectionWrite);

    return {
      duplicate: false,
      state,
      humanRequiredReasons: humanReasons,
      outboxEnqueued,
      submissionId: committedSubmissionId,
      observationId: envelope.sourceObservationId,
    };
  });
}

// ---- 운영 감사/리포트 --------------------------------------------------------

const REPORT_ROLES = ["super_admin", "admin", "manager"] as const;
const REPORT_SCAN_LIMIT = 200;

export async function getScpPortalSubmissionIngressReport(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_portal_submission_ingress.report", REPORT_ROLES);
  // 2026-09-27 codex adversarial review round 2 sweep: no general-purpose UI reaches this report.
  await assertScpEntitled(auth, request, "scp_portal_submission_ingress.report");
  const data = asRecord(request.data);
  const limit = Math.min(Math.max(Number(data.limit ?? 20) || 20, 1), 50);
  const snapshot = await adminDb.collection(PORTAL_SUBMISSION_PROJECTION_COLLECTION)
    .orderBy("updatedAtIso", "desc")
    .limit(REPORT_SCAN_LIMIT)
    .get();
  const counts: Record<string, number> = { auto_enqueued: 0, human_required: 0, tombstoned: 0 };
  const humanRequired: Array<Record<string, unknown>> = [];
  for (const doc of snapshot.docs) {
    const row = doc.data() ?? {};
    const state = asString(row.state);
    if (state in counts) counts[state] += 1;
    if (state === "human_required" && humanRequired.length < limit) {
      humanRequired.push({
        sourceSubmissionId: asString(row.sourceSubmissionId),
        revision: asString(row.revision),
        humanRequiredReasons: Array.isArray(row.humanRequiredReasons) ? row.humanRequiredReasons : [],
        updatedAtIso: asString(row.updatedAtIso),
      });
    }
  }
  return {
    ok: true as const,
    scanned: snapshot.size,
    counts,
    humanRequired,
    uidKindDecisionGate: {
      acceptedUidKinds: [...ACCEPTED_UID_VERIFICATION_KINDS],
      decided: ACCEPTED_UID_VERIFICATION_KINDS.length > 0,
    },
    behaviorLog: makeBehaviorLog(auth, "scp_portal_submission_ingress.report", "success", "scp-automation"),
  };
}
