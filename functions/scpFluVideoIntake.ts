// Portal -> Flu 영상 인테이크 수신기 (Portal 핀 계약 scp.flu.video-intake.v1).
//
// Portal 의 wire 는 의도적으로 얇다: sourceSubmissionId/applicationId/programId(+linkedCreatorId?)
// 와 video { canonicalUrl, provider:"youtube", videoId, urlHash } 뿐이며 UID/creator tuple/
// revision 이 없다. Flu 가 권위 매핑(scp_portal_creator_bindings)을 스스로 해석해 기존
// 영상검수 ingest 엔진(scpPortalSubmissionIngress)의 풍부한 봉투로 변환한다.
// - 매핑/스코프/UID 게이트는 엔진이 그대로 집행한다. UID kind allowlist 가 비어 있는 동안
//   모든 인테이크는 human_required 로 fail-closed 수용·감사된다(자동검수·submissions 잔여물 없음).
// - 멱등: 명령 ID(`flu_video_intake_<sourceSubmissionId>`) 영수증. 같은 바이트 재전송 = 200
//   duplicate(저장 결과 재반환), 다른 바이트 = 409 (Portal 은 409 를 accepted/duplicate 로 소비).
// - 응답은 안전 상태만: Portal 은 상태코드로만 결과를 소비한다(2xx/409 accepted,
//   408/425/429/5xx retry, 그 외 4xx rejected).
//
// 환경 바인딩(Flu): SCP_FLU_VIDEO_INTAKE_SECRET(+_PREVIOUS) — Portal 과 공유(32B+).

import { createHash, randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
import {
  ingestScpPortalVideoSubmission,
  signScpPortalIngressForTest,
  verifyScpPortalIngressAuth,
  type IngestScpPortalVideoSubmissionResult,
} from "./scpPortalSubmissionIngress";
import { youtubeOAuthPortalBindingDocumentId } from "./youtubeOAuthHandoff";

export const SCP_FLU_VIDEO_INTAKE_CONTRACT = "scp.flu.video-intake.v1" as const;
export const SCP_FLU_VIDEO_INTAKE_SECRET_ENV = "SCP_FLU_VIDEO_INTAKE_SECRET";
export const SCP_FLU_VIDEO_INTAKE_PREVIOUS_SECRET_ENV = "SCP_FLU_VIDEO_INTAKE_SECRET_PREVIOUS";
export const SCP_FLU_VIDEO_INTAKE_MAX_BODY_BYTES = 8 * 1024;
export const FLU_VIDEO_INTAKE_RECEIPT_COLLECTION = "scp_flu_video_intake_receipts";

const INTAKE_ID_RE = /^flu_video_intake_[A-Za-z0-9._:-]{1,128}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
// 엔진 재검증용 내부 서명 비밀 — 프로세스 수명 한정(외부 채널 인증은 이 모듈이 수행).
const INTERNAL_ENGINE_SECRET = randomBytes(32).toString("hex");

type IntakeError = Error & { code: string };

function intakeError(code: string, message: string): IntakeError {
  return Object.assign(new Error(message), { code });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requiredIdentifier(value: unknown, field: string): string {
  const text = asString(value);
  if (!IDENTIFIER_RE.test(text)) throw intakeError("invalid_payload", `${field} is not an exact identifier`);
  return text;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw intakeError("invalid_payload", `${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...keys, ...optional]);
  const requiredKeys = keys.filter((key) => !optional.includes(key));
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw intakeError("invalid_payload", `${label} has an unknown key: ${key}`);
  }
  for (const key of requiredKeys) {
    if (!(key in record)) throw intakeError("invalid_payload", `${label} is missing ${key}`);
  }
  return record;
}

export type NormalizedFluVideoIntake = {
  schemaVersion: typeof SCP_FLU_VIDEO_INTAKE_CONTRACT;
  sourceSubmissionId: string;
  applicationId: string;
  programId: string;
  linkedCreatorId: string;
  video: { canonicalUrl: string; provider: "youtube"; videoId: string; urlHash: string };
  /** 선택 키(다타이틀). 레지스트리 타이틀 id — 없으면 프로그램 기본 타이틀. */
  gameId: string;
};

export function fluVideoIntakeCommandId(sourceSubmissionId: string): string {
  return `flu_video_intake_${sourceSubmissionId}`;
}

export function normalizeFluVideoIntake(value: unknown): NormalizedFluVideoIntake {
  const record = exactRecord(value, [
    "schemaVersion", "sourceSubmissionId", "applicationId", "programId", "linkedCreatorId", "video", "gameId",
  ], "video intake", ["linkedCreatorId", "gameId"]);
  if (record.schemaVersion !== SCP_FLU_VIDEO_INTAKE_CONTRACT) {
    throw intakeError("unsupported_contract", "unsupported video-intake schema version");
  }
  const video = exactRecord(record.video, ["canonicalUrl", "provider", "videoId", "urlHash"], "video");
  if (video.provider !== "youtube") throw intakeError("invalid_payload", "video.provider must be youtube");
  const canonicalUrl = asString(video.canonicalUrl);
  if (!/^https:\/\//.test(canonicalUrl) || canonicalUrl.length > 500) {
    throw intakeError("invalid_payload", "video.canonicalUrl must be an exact https URL");
  }
  const urlHash = asString(video.urlHash);
  if (!/^[a-f0-9]{64}$/.test(urlHash)) throw intakeError("invalid_payload", "video.urlHash must be a sha256 hex digest");
  return {
    schemaVersion: SCP_FLU_VIDEO_INTAKE_CONTRACT,
    sourceSubmissionId: requiredIdentifier(record.sourceSubmissionId, "sourceSubmissionId"),
    applicationId: requiredIdentifier(record.applicationId, "applicationId"),
    programId: requiredIdentifier(record.programId, "programId"),
    linkedCreatorId: record.linkedCreatorId === undefined ? "" : requiredIdentifier(record.linkedCreatorId, "linkedCreatorId"),
    gameId: record.gameId === undefined ? "" : requiredIdentifier(record.gameId, "gameId"),
    video: {
      canonicalUrl,
      provider: "youtube",
      videoId: requiredIdentifier(video.videoId, "video.videoId"),
      urlHash,
    },
  };
}

// 권위 매핑 해석: linkedCreatorId 가 있으면 그 binding 문서, 없으면 sourceApplicationId 질의.
// 미해석 시 placeholder tuple 로 엔진에 넘겨 mapping_not_found/conflict 게이트가 감사와 함께
// human_required 로 착지하게 한다(여기서 요청을 거부하면 감사 원장이 남지 않는다).
async function resolveCreatorTuple(intake: NormalizedFluVideoIntake): Promise<Record<string, string>> {
  const unresolved = {
    portalCreatorId: "portal-unresolved",
    fluCreatorId: intake.linkedCreatorId || "CR_UNRESOLVED",
    partnerId: "partner-unresolved",
    programId: intake.programId,
    enrollmentId: "enrollment-unresolved",
    channelId: "channel-unresolved",
  };
  try {
    if (intake.linkedCreatorId) {
      const doc = await adminDb.collection("scp_portal_creator_bindings")
        .doc(youtubeOAuthPortalBindingDocumentId(intake.linkedCreatorId)).get();
      if (!doc.exists) return unresolved;
      const binding = doc.data() ?? {};
      return {
        portalCreatorId: asString(binding.portalCreatorId) || unresolved.portalCreatorId,
        fluCreatorId: asString(binding.fluCreatorId) || unresolved.fluCreatorId,
        partnerId: asString(binding.partnerId) || unresolved.partnerId,
        programId: asString(binding.programId) || unresolved.programId,
        enrollmentId: asString(binding.enrollmentId) || unresolved.enrollmentId,
        channelId: asString(binding.channelId) || unresolved.channelId,
      };
    }
    const matches = await adminDb.collection("scp_portal_creator_bindings")
      .where("sourceApplicationId", "==", intake.applicationId)
      .limit(2)
      .get();
    if (matches.size !== 1) return unresolved;
    const binding = matches.docs[0].data() ?? {};
    return {
      portalCreatorId: asString(binding.portalCreatorId) || unresolved.portalCreatorId,
      fluCreatorId: asString(binding.fluCreatorId) || unresolved.fluCreatorId,
      partnerId: asString(binding.partnerId) || unresolved.partnerId,
      programId: asString(binding.programId) || unresolved.programId,
      enrollmentId: asString(binding.enrollmentId) || unresolved.enrollmentId,
      channelId: asString(binding.channelId) || unresolved.channelId,
    };
  } catch {
    return unresolved;
  }
}

export type IngestScpFluVideoIntakeInput = {
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
  /** 테스트 전용 — 엔진 UID 결정 게이트 심(프로덕션 HTTP 표면 비노출). */
  acceptedUidKinds?: readonly string[];
};

export type IngestScpFluVideoIntakeResult = {
  duplicate: boolean;
  state: IngestScpPortalVideoSubmissionResult["state"];
  humanRequiredReasons: string[];
  outboxEnqueued: boolean;
  commandId: string;
};

export async function ingestScpFluVideoIntake(
  input: IngestScpFluVideoIntakeInput,
): Promise<IngestScpFluVideoIntakeResult> {
  verifyScpPortalIngressAuth({
    rawBody: input.rawBody,
    timestamp: input.timestamp,
    idempotencyKey: input.idempotencyKeyHeader,
    signature: input.signature,
    isHttps: input.isHttps,
    hasBearerOrCookie: input.hasBearerOrCookie,
    contractVersionHeader: input.contractVersionHeader,
    expectedContractVersion: SCP_FLU_VIDEO_INTAKE_CONTRACT,
    secret: input.secret,
    previousSecret: input.previousSecret,
    secretEnv: SCP_FLU_VIDEO_INTAKE_SECRET_ENV,
    previousSecretEnv: SCP_FLU_VIDEO_INTAKE_PREVIOUS_SECRET_ENV,
    maxBodyBytes: SCP_FLU_VIDEO_INTAKE_MAX_BODY_BYTES,
    now: input.now,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    throw intakeError("invalid_payload", "invalid video-intake JSON");
  }
  const intake = normalizeFluVideoIntake(parsed);
  const commandId = fluVideoIntakeCommandId(intake.sourceSubmissionId);
  if (input.idempotencyKeyHeader !== commandId || !INTAKE_ID_RE.test(commandId)) {
    throw intakeError("idempotency_mismatch", "idempotency key must be the exact intake command id");
  }
  const wireBodyHash = sha256(input.rawBody);
  const receiptRef = adminDb.collection(FLU_VIDEO_INTAKE_RECEIPT_COLLECTION).doc(commandId);
  const existing = await receiptRef.get();
  if (existing.exists) {
    const row = existing.data() ?? {};
    if (asString(row.wireBodyHash) !== wireBodyHash) {
      throw intakeError("intake_conflict", "intake command id was reused with different bytes");
    }
    const stored = asRecord(row.engineResult);
    return {
      duplicate: true,
      state: (asString(stored.state) || "human_required") as IngestScpPortalVideoSubmissionResult["state"],
      humanRequiredReasons: Array.isArray(stored.humanRequiredReasons)
        ? stored.humanRequiredReasons.map((reason) => asString(reason))
        : [],
      outboxEnqueued: Boolean(stored.outboxEnqueued),
      commandId,
    };
  }

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const creator = await resolveCreatorTuple(intake);
  // 엔진의 풍부한 봉투로 변환. UID 는 wire 에 존재하지 않으므로 unverified 로 명시 —
  // 결정 게이트(uid_unverified + uid_kind_undecided)가 human_required 를 강제한다.
  const envelope = {
    contractVersion: "scp.portal-video-submission.v1",
    sourceObservationId: commandId,
    sourceSubmissionId: intake.sourceSubmissionId,
    revision: "1",
    operation: "upsert",
    sourceUpdatedAt: nowIso,
    sourceWatermark: nowIso,
    sourceFingerprint: intake.video.urlHash,
    creator,
    uid: { value: "portal-onboarding-gate", kind: "portal_onboarding_gate", status: "unverified" },
    video: {
      videoUrl: intake.video.canonicalUrl,
      youtubeVideoId: intake.video.videoId,
      title: `Portal intake ${intake.sourceSubmissionId}`,
      contentType: "weaponrpg_scp_video",
      submittedAt: nowIso,
      // 미선언이면 키 자체를 싣지 않는다 — 엔진이 프로그램 기본 타이틀로 확정한다.
      ...(intake.gameId ? { gameId: intake.gameId } : {}),
    },
  };
  const engineBody = JSON.stringify(envelope);
  const engineTimestamp = String(Math.floor(now.getTime() / 1000));
  const engineResult = await ingestScpPortalVideoSubmission({
    rawBody: engineBody,
    timestamp: engineTimestamp,
    idempotencyKeyHeader: commandId,
    contractVersionHeader: "v1",
    signature: signScpPortalIngressForTest(engineBody, engineTimestamp, commandId, INTERNAL_ENGINE_SECRET),
    isHttps: true,
    hasBearerOrCookie: false,
    now,
    secret: INTERNAL_ENGINE_SECRET,
    previousSecret: "",
    acceptedUidKinds: input.acceptedUidKinds,
  });
  await receiptRef.create({
    id: commandId,
    contractVersion: intake.schemaVersion,
    sourceSubmissionId: intake.sourceSubmissionId,
    applicationId: intake.applicationId,
    programId: intake.programId,
    wireBodyHash,
    engineResult: {
      state: engineResult.state,
      humanRequiredReasons: engineResult.humanRequiredReasons,
      outboxEnqueued: engineResult.outboxEnqueued,
      observationId: engineResult.observationId,
    },
    createdAtIso: nowIso,
    createdAt: FieldValue.serverTimestamp(),
  });
  return {
    duplicate: false,
    state: engineResult.state,
    humanRequiredReasons: engineResult.humanRequiredReasons,
    outboxEnqueued: engineResult.outboxEnqueued,
    commandId,
  };
}
