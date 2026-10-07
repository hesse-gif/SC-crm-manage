// TASK 4 — UID-guide mail delivery worker (Portal G008 recovery). Drains the durable fail-closed
// intents in `scp_integration_event_v2_uid_guide_outbox` (written by scpIntegrationEventV2's
// dispatchApplicationEvent): retrieves the Portal v2 protected material IN MEMORY through the
// attested MATERIAL-ring client (fetchCreatorPipelineV3OnboardingMaterial — recipientEmail +
// uidGuideUrl are never logged or persisted), renders a minimal locale-aware guide mail, and sends
// through the shared fail-closed adapter where the production-pilot fence (e2eMailFence) is
// evaluated immediately before the provider send. Nonmatch/unconfigured outcomes release the claim
// with ZERO state/attempt mutation; real failures follow retry/backoff/dead-letter. One effect per
// intent: `delivered` is terminal for the current revision (a Portal "resend" re-queues it).
//
// W124 [프로덕션 장애 · 2026-08-24 실측]: 이 레인은 2026-07-19 이후 **한 통도 나가지 않았다**.
//   아웃박스 60행 전량 queued · attempts 0 · lastErrorCode 없음. 근인은 셋이 겹쳤다:
//   ① ack 게이트 기아 — 이 워커가 요구하는 `scp_creator_pipeline_v3_management_ack_receipts` 의
//      materialized 영수증이 프로드에 **1건**뿐이고 그마저 materialization_conflict 다.
//      그 위쪽 사슬(v3 intake 영수증 원장 4문서 · 운영자 프로비저닝 바인딩 22건)은 flu 밖에서
//      채워지는 값이라 flu 코드로는 못 고친다 → v1 커맨드 전달자료 경로를 사다리에 추가했다
//      (scpOutboxMailWorkers.resolveSignedMaterialRecipient 이 이미 쓰는 그 순서 그대로).
//   ② orderBy 부재 head-of-line 기아 — 문서 id 순 앞 10개만 반복 스캔돼 **29행은 생성 이후
//      드레인에 닿은 적조차 없었다** → 접수 순 정렬(메모리 정렬, 새 복합 인덱스 없음).
//   ③ 관측 부재 — 무변이 스킵이 아무 흔적도 남기지 않았다 → 사유별 카운터 + 행의 lastSkipReason.
//   그리고 이 셋을 고치면 적체 60건이 배포 즉시 나가므로, **기본 닫힘 롤아웃 게이트**
//   (settings/scp_uid_guide_mail_rollout)를 앞단에 세운다. 게이트가 닫혀 있으면 이 드레인은
//   Firestore 에 **한 번도 쓰지 않는다**(claim 도 attempts 도 건드리지 않는다).

import { createHash } from "node:crypto";
import { isTerminalSuppressionReason } from "./scpOutboxMailWorkers";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asString } from "./shared";
import {
  INTEGRATION_EVENT_V2_UID_GUIDE_OUTBOX_COLLECTION,
} from "./scpIntegrationEventV2";
import {
  SCP_CREATOR_PIPELINE_V3_MANAGEMENT_ACK_RECEIPTS_COLLECTION,
} from "./scpCreatorPipelineV3ManagementAckStore";
import {
  fetchCreatorPipelineV3OnboardingMaterial,
  type CreatorPipelineV3Material,
  type CreatorPipelineV3OnboardingMaterialInput,
  type CreatorPipelineV3MaterialFetchOptions,
} from "./scpCreatorPipelineV3MaterialClient";
import { defaultMailSendAdapter, reclaimStaleSendingOutboxRows, type MailSendAdapter } from "./scpOutboxMailWorkers";
import { buildScpBrandedMailHtml } from "./scpBrandedMailHtml";
import { resolveScpMailTemplateOverride } from "./scpReceiptMailTemplates";
import {
  readUidGuideMailRolloutGate,
  type UidGuideMailRolloutGate,
} from "./scpUidGuideMailRollout";
import { FLU_APPLICATION_COMMAND_COLLECTION, fluApplicationCommandId } from "./scpApprovalOnboarding";
import {
  fetchScpPortalDeliveryMaterial,
  type PortalDeliveryMaterial,
} from "./scpFluApplicationCommand";

export const UID_GUIDE_MAIL_WORKER_VERSION = "scp_uid_guide_mail_worker_v1" as const;
export const UID_GUIDE_MAIL_CALLER_ID = "flu-uid-guide-mail-worker" as const;
const UID_GUIDE_MAIL_MAX_ATTEMPTS = 6;
const UID_GUIDE_MATERIAL_EXPIRY_SECONDS = 300;

/**
 * W124 [공정성]: 드레인 쿼리에 orderBy 가 없어 Firestore 가 `__name__` 순으로만 앞 batchLimit 개를
 * 돌려줬다 — 실측 결과 60행 중 **29행은 생성 이후 단 한 번도 드레인에 닿지 않았다**(updatedAtIso 가
 * createdAtIso 와 동일). 문서 id 는 sha256 이라 사실상 무작위이고, 그 순서는 접수 순서와 아무 관계가
 * 없다. 릴리스 고정 Firestore 매니페스트에 복합 인덱스를 새로 넣지 않기 위해(같은 파일의 ack 조회가
 * 쓰는 방식 그대로) **단일 필드 쿼리로 넉넉히 읽고 메모리에서 createdAtIso 오름차순 정렬**한다.
 * 이 아웃박스는 지원 건당 1행이라 크기가 구조적으로 작다(2026-08 실측 60행).
 */
const UID_GUIDE_FAIRNESS_SCAN_LIMIT = 300;
const UID_GUIDE_DUE_STATES = ["queued", "retryable_failed"] as const;

/**
 * W124 [관측]: 두 달간 아무도 몰랐던 이유는 **스킵이 아무 흔적도 남기지 않아서**다.
 * 이 레인의 스킵은 전부 "시도를 소모하지 않는" 무변이 스킵이라 attempts 도 lastErrorCode 도
 * 움직이지 않는다. 그래서 사유를 별도 축(카운터 + 행의 lastSkipReason)으로 남긴다.
 * SEC-P0-009: 사유는 **코드**뿐이다 — 수신자·URL·프롬프트 원문은 어디에도 싣지 않는다.
 */
export type UidGuideDrainSkipReason =
  | "rollout_gate_closed"
  | "closed_without_send"
  | "row_fields_missing"
  | "retry_backoff"
  | "claim_lost"
  | "material_binding_absent"
  | "material_unavailable"
  | "material_expired"
  | "send_fence_denied";

/**
 * F4③: Portal MATERIAL 의 UID 링크 스킴 사전 검증. `javascript:` / `data:` / `//host` 같은 값이
 * 그대로 렌더러에 들어가면 rejectUnsafeHtml 이 던져 드레인 전체가 멈췄다(실측 3/3). 여기서
 * 걸러 **해당 행만** 실패로 격리한다. https 만 허용하고 자격증명 포함 URL 도 거부한다.
 */
function isSafeUidGuideUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function receiptsDocId(value: string): string {
  // Mirrors scpIntegrationEventV2's private docId — the durable receipt id for an eventId.
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 48);
}

// P5/P9: the apply confirmation mail is HTML-first. The plain-text `body` here stays the multipart
// TEXT FALLBACK (unchanged wording, still carries the raw uidGuideUrl) — mail clients that reject or
// strip HTML still get the working link.
//
// W7-3d: 이 레인은 확인 메일 HTML(SCP_APPLICATION_CONFIRMED_EMAIL_EN_HTML)을 **공유**하고 있었다.
// 그래서 ①UID 링크가 HTML 본문에 아예 없었고(텍스트 폴백에만 있었다) ②확인 메일 디자인을 고치면
// UID 안내까지 같이 바뀌었다(코드 주석이 스스로 known gap 이라고 적어둔 결합). 전용 최소 템플릿
// (정본 마스터의 600px 다크 셸 재사용)으로 분리하고, 링크는 `{{uid_guide_link}}` 를 렌더러가 치환한다.
// ko/ja HTML 현지화는 여전히 없다 — ko 는 한국어 subject/text + 영문 HTML(기존과 동일).
const UID_GUIDE_FALLBACK_HTML = buildScpBrandedMailHtml({
  heading: "Register your UID",
  paragraphs: [
    "Thanks for applying to Super Creator Partners.",
    "Open your secure UID registration guide with the button below. The link expires after a short period; you can request a resend from the portal.",
  ],
  cta: { label: "Open the UID guide", href: "{{uid_guide_link}}" },
  closing: ["Questions? Reply to this email and our team will help."],
});

function renderUidGuideMail(locale: string, uidGuideUrl: string): { subject: string; body: string; html: string } {
  if (locale === "ko") {
    return {
      subject: "[Super Creator Partners] UID 등록 안내",
      body: [
        "안녕하세요, Super Creator Partners입니다.",
        "",
        "지원해 주셔서 감사합니다. 아래 보안 링크에서 UID 등록 안내를 확인해 주세요.",
        uidGuideUrl,
        "",
        "링크는 일정 시간 후 만료됩니다. 만료 시 포털에서 재발송을 요청할 수 있습니다.",
      ].join("\n"),
      html: UID_GUIDE_FALLBACK_HTML,
    };
  }
  return {
    // F7f: 이 레인은 UID 등록 안내다. 예전 제목("Application Confirmed")은 확인 메일과 같은 문구라
    // 수신자가 같은 메일을 두 번 받은 것처럼 보였다(ko 는 이미 UID 안내 제목이었다).
    subject: "[Super Creator Partners] UID registration guide",
    body: [
      "Hello from Super Creator Partners,",
      "",
      "Thanks for applying. Please open your secure UID registration guide below.",
      uidGuideUrl,
      "",
      "The link expires after a short period; you can request a resend from the portal.",
    ].join("\n"),
    html: UID_GUIDE_FALLBACK_HTML,
  };
}

export type DrainUidGuideOutboxOptions = {
  batchLimit?: number;
  now?: Date;
  sendAdapter?: MailSendAdapter;
  materialFetcher?: (
    input: CreatorPipelineV3OnboardingMaterialInput,
    options?: CreatorPipelineV3MaterialFetchOptions,
  ) => Promise<CreatorPipelineV3Material | null>;
  /**
   * W124: 커맨드 레인 전달자료 회수(`/api/internal/flu/application-command-delivery`). 실드레인은
   * 정본 fetcher 를 쓴다 — 주입은 테스트용이며 기존 materialFetcher 주입과 같은 관례다.
   */
  commandMaterialFetcher?: (commandId: string) => Promise<PortalDeliveryMaterial>;
  /** 생략하면 `settings/scp_uid_guide_mail_rollout` 를 읽는다(부재 시 **닫힘**). */
  rolloutGate?: UidGuideMailRolloutGate;
};

export type DrainUidGuideOutboxResult = {
  scanned: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  skipped: number;
  /** W124: 사유별 스킵 카운터. 건수만 — 수신자 원문은 절대 싣지 않는다(SEC-P0-009). */
  skipReasons: Partial<Record<UidGuideDrainSkipReason, number>>;
  /** W124: 어떤 material 경로로 나갔는지. 두 경로 모두 **행 하나당 1회 발송**이다. */
  materialRoutes: Partial<Record<UidGuideMaterialRoute, number>>;
  /** W124: 게이트가 닫혀 있어 한 건도 처리하지 않았는가(쓰기 0건 보장 경로). */
  rolloutGateClosed: boolean;
};

export type UidGuideMaterialRoute = "management_ack" | "application_command";

type UidGuideMaterialResolution =
  | { readonly material: CreatorPipelineV3Material; readonly route: UidGuideMaterialRoute }
  | { readonly material: null; readonly reason: UidGuideDrainSkipReason };

/**
 * W124 [수렴 · 단일 발송자]: 이 아웃박스 행 하나가 UID 안내 메일 한 통의 유일한 단위다.
 * material 회수 경로는 둘이지만 **발송 주체는 이 드레인 하나뿐**이다(커맨드 레인의 자체 드레인은
 * 같은 릴리스에서 정식 폐기했다 — scpFluApplicationCommand 의 폐기 주석 참조). 경로가 둘인 이유:
 *
 *  ① `management_ack`  — Portal 이 핀한 온보딩 material 계약
 *    (PORTAL_EXACT_ONBOARDING_MATERIAL_TUPLE_ANSWER_20260719). materialized ack 영수증이 있어야만
 *    성립한다. 이 경로가 정본이며 있으면 먼저 쓴다.
 *  ② `application_command` — v1 신청 커맨드 전달자료 계약(`scp.flu.application-delivery-material.v1`).
 *    commandId 는 applicationId 에서 결정적으로 파생된다(fluApplicationCommandId).
 *
 * ②가 필요한 이유는 프로드 실측이다(2026-08-24): ①의 선행 원장인
 * `scp_creator_pipeline_v3_management_ack_receipts` 는 문서가 **1개**뿐이고 그마저
 * materialization_conflict 다. 그 위쪽 사슬(v3 intake 영수증 원장 4문서, 운영자 프로비저닝
 * `scp_portal_creator_bindings` 22건)은 **flu 밖에서 채워지는 값**이라 flu 코드로는 못 고친다.
 * 반면 같은 지원 건들은 `scp_flu_application_commands` 에 `uidGuideRequested` 로 60건 중 56건이
 * 들어와 있다 — Portal 이 실제로 이 레인으로 UID 안내를 요청한 기록이다.
 */
export async function resolveUidGuideMaterial(
  input: {
    applicationId: string;
    now: Date;
    ackMaterialFetcher: NonNullable<DrainUidGuideOutboxOptions["materialFetcher"]>;
    commandMaterialFetcher: NonNullable<DrainUidGuideOutboxOptions["commandMaterialFetcher"]>;
  },
): Promise<UidGuideMaterialResolution> {
  const { applicationId, now } = input;
  const expiresAt = new Date(now.getTime() + UID_GUIDE_MATERIAL_EXPIRY_SECONDS * 1000).toISOString();

  // Portal-pinned tuple contract: the onboarding-material route accepts ONLY the identifiers of a
  // delivered Flu application.management.acknowledged — managementEventId = that ack's eventId and
  // managementReceiptId = its payload.receiptId, both persisted verbatim in the durable ack receipts
  // ledger after Portal accepts the ack. A v2-derived tuple can never pass.
  // Single-field query + in-memory selection (bounded): avoids a new composite index in the
  // release-pinned Firestore manifest; ack receipts per application are few by construction.
  const ackQuery = await adminDb
    .collection(SCP_CREATOR_PIPELINE_V3_MANAGEMENT_ACK_RECEIPTS_COLLECTION)
    .where("applicationId", "==", applicationId)
    .limit(20)
    .get();
  // W124 [적대 리뷰 M6] 술어를 원본 사다리(scpOutboxMailWorkers.loadCreatorPipelineV3OnboardingGrantBinding,
  // `WHERE applicationId== AND grantIssued==true`)와 **정확히 같은 강도**로 맞춘다.
  // `materializationStatus === "materialized"` 만 보면 grantIssued 가 false 인 영수증
  // (grantId 부재 / managedEnrollment.status 가 active 가 아님 — ManagementAckStore.ts:407-410)
  // 도 통과해 버린다. 둘 다 요구하는 쪽이 좁고, Portal 계약과도 일치한다.
  const ack = ackQuery.docs
    .map((snap) => snap.data() ?? {})
    .filter((record) => asString(record.materializationStatus) === "materialized" && record.grantIssued === true)
    .sort((a, b) => asString(b.createdAtIso).localeCompare(asString(a.createdAtIso)))[0] ?? null;
  const managementEventId = asString(ack?.managementEventId);
  const managementReceiptId = asString(ack?.managementReceiptId);
  const ackGrantId = asString(ack?.grantId);
  if (managementEventId && managementReceiptId) {
    // W124 [적대 리뷰 M6] grantId 폴백 제거. 예전에는 영수증에 grantId 가 없으면 v2 아웃박스 행의
    // uidGrantId 로 채웠는데, 그러면 managementEventId/ReceiptId 는 영수증 출처 · grantId 는 v2 출처인
    // **혼합 튜플**이 Portal 의 exact-tuple 계약으로 나간다. 지금은 403 fail-closed 라 사고가 안 나지만,
    // 상류가 복구되면 그 거절이 `material_unavailable` 로 뭉개져 원인을 못 찾는다.
    // 셋이 한 영수증에서 같이 나오지 않으면 회선이 없는 것으로 본다.
    if (!ackGrantId) {
      return { material: null, reason: "material_binding_absent" };
    }
    const material = await input.ackMaterialFetcher({
      applicationId,
      callerId: UID_GUIDE_MAIL_CALLER_ID,
      expiresAt,
      grantId: ackGrantId,
      managementEventId,
      managementReceiptId,
    }, { now });
    if (material?.recipientEmail && material.uidGuideUrl) {
      return { material, route: "management_ack" };
    }
    // ack 튜플이 있는데 material 이 안 나오면 커맨드 경로로 내려가지 않는다 — 두 계약을 섞으면
    // 어느 쪽이 거절했는지 사유가 뭉개진다.
    return { material: null, reason: "material_unavailable" };
  }

  // ② 커맨드 레인 경로. 커맨드 문서가 없거나 uidGuideRequested 가 아니면 **회선 자체가 없다** —
  // 네트워크 호출 전에 fail-closed 로 끊고, 그 사실을 사유로 남긴다(예전에는 이 자리에서 아무
  // 기록 없이 조용히 스킵했다).
  const commandId = fluApplicationCommandId(applicationId);
  const commandSnap = await adminDb.collection(FLU_APPLICATION_COMMAND_COLLECTION).doc(commandId).get();
  const commandTypes = commandSnap.exists ? commandSnap.data()?.commandTypes : null;
  if (
    !commandSnap.exists
    // 저장된 applicationId 재확인 — scpOutboxMailWorkers.loadV1CommandId 가 이미 쓰는 방어다.
    // 문서 id 가 applicationId 를 품고 있어도 이 확인을 빼면 자료 회수 키가 다른 지원 건을
    // 가리킬 수 있고, 그건 곧 **다른 사람에게 메일이 가는** 사고다.
    || asString(commandSnap.data()?.applicationId) !== applicationId
    || !Array.isArray(commandTypes)
    || !commandTypes.includes("uidGuideRequested")
  ) {
    return { material: null, reason: "material_binding_absent" };
  }
  let delivery: PortalDeliveryMaterial;
  try {
    delivery = await input.commandMaterialFetcher(commandId);
  } catch {
    // 미구성·전송 실패·Portal 거절 모두 fail-closed 다(사유는 Portal 이 generic 403 으로만 준다).
    return { material: null, reason: "material_unavailable" };
  }
  if (!delivery?.recipientEmail || !delivery.uidGuideUrl) {
    return { material: null, reason: "material_unavailable" };
  }
  return {
    material: { recipientEmail: delivery.recipientEmail, uidGuideUrl: delivery.uidGuideUrl, expiresAt: delivery.expiresAt },
    route: "application_command",
  };
}

export async function drainUidGuideOutbox(
  options: DrainUidGuideOutboxOptions = {},
): Promise<DrainUidGuideOutboxResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const batchLimit = Math.min(Math.max(Math.trunc(options.batchLimit ?? 10), 1), 50);
  const sendAdapter = options.sendAdapter ?? defaultMailSendAdapter;
  const materialFetcher = options.materialFetcher ?? fetchCreatorPipelineV3OnboardingMaterial;
  const commandMaterialFetcher = options.commandMaterialFetcher ?? fetchScpPortalDeliveryMaterial;

  const result: DrainUidGuideOutboxResult = {
    scanned: 0, delivered: 0, retried: 0, deadLettered: 0, skipped: 0,
    skipReasons: {}, materialRoutes: {}, rolloutGateClosed: false,
  };
  const bumpSkip = (reason: UidGuideDrainSkipReason, by = 1) => {
    result.skipReasons[reason] = (result.skipReasons[reason] ?? 0) + by;
    result.skipped += by;
  };

  // W124: 롤아웃 게이트는 **가장 먼저** 본다. 닫혀 있으면 이 함수는 Firestore 에 단 한 번도 쓰지
  // 않는다 — reclaim 도, claim 도, 상태/시도 갱신도 없다. 적체 수치만 세서 돌려준다.
  const rolloutGate = options.rolloutGate ?? await readUidGuideMailRolloutGate();
  if (!rolloutGate.deliveryEnabled) {
    result.rolloutGateClosed = true;
    // 2026-09-27 비용 감사: 게이트가 닫혀 있으면 이 드레인은 아무것도 쓰지 않는다(W124) — 적체
    // "건수"만 관측치로 필요하고 문서 내용은 필요 없다. 종전에는 그 건수를 얻으려고 최대 500건의
    // 문서를 통째로 읽었다(select() 는 필드 투영만 줄일 뿐 read 과금은 그대로다) — 5분 스케줄에서
    // 게이트가 닫혀 있는 동안 매 틱 최대 500 read 가 나갔다. count() 집계 쿼리는 같은 필터로
    // 정확한 건수를 훨씬 싸게 준다(문서를 내려받지 않는다).
    const backlogCount = await adminDb
      .collection(INTEGRATION_EVENT_V2_UID_GUIDE_OUTBOX_COLLECTION)
      .where("deliveryState", "in", [...UID_GUIDE_DUE_STATES])
      .count()
      .get();
    const backlogSize = Math.max(0, Math.round(backlogCount.data().count ?? 0));
    result.scanned = backlogSize;
    if (backlogSize > 0) bumpSkip("rollout_gate_closed", backlogSize);
    return result;
  }

  await reclaimStaleSendingOutboxRows(INTEGRATION_EVENT_V2_UID_GUIDE_OUTBOX_COLLECTION, now);

  const scanned = await adminDb
    .collection(INTEGRATION_EVENT_V2_UID_GUIDE_OUTBOX_COLLECTION)
    .where("deliveryState", "in", [...UID_GUIDE_DUE_STATES])
    .limit(UID_GUIDE_FAIRNESS_SCAN_LIMIT)
    .get();
  /**
   * W124 [적대 리뷰 H2] 무발송 종결의 최후 방어선 — **선택 단계에서** 끊는다.
   *
   * 종결 스크립트는 행을 `dead_letter` 로 내려 due 쿼리 밖으로 뺀다. 그 **형태**만 믿으면 안 된다:
   * 같은 레포의 `scpIntegrationEventV2.dispatchApplicationEvent`(:1683-1706) 멱등 가드는 현재
   * deliveryState 를 보지 않아서, Portal 이 같은 지원 건을 더 높은 revision 이나 `resend` 로 다시
   * 보내면 `dead_letter` 를 `queued` 로 덮는다(merge 라 `closedReason` 은 그대로 남는다).
   * 가정이 아니라 실측이다 — 2026-08-24 Portal flush 로 이 아웃박스가 60행 → 147행이 됐다.
   * 그래서 상태가 아니라 **내용**(`closedReason`)으로 막는다. 되살리기는 그 필드를 지우는 명시적
   * 행위여야 한다(스크립트가 남긴 `closedFromState` 로 복원).
   *
   * 정렬·배치 선택보다 **앞에서** 걸러내는 것이 중요하다: 종결된 행은 정의상 가장 오래된 행들이라,
   * 뒤에서 걸러내면 접수순 정렬의 머리를 차지해 매 패스 batchLimit 를 먹고 신규 행을 굶긴다
   * (②에서 막 없앤 그 기아를 되살리는 셈).
   */
  const closedRows = scanned.docs.filter((doc) => asString(doc.data()?.closedReason));
  if (closedRows.length > 0) {
    result.scanned += closedRows.length;
    bumpSkip("closed_without_send", closedRows.length);
  }

  // 접수 순(createdAtIso 오름차순) — 동률이면 문서 id 로 결정적으로 끊는다.
  const dueDocs = scanned.docs
    .filter((doc) => !asString(doc.data()?.closedReason))
    .sort((a, b) => {
      const byCreated = asString(a.data()?.createdAtIso).localeCompare(asString(b.data()?.createdAtIso));
      return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
    })
    .slice(0, batchLimit);

  for (const doc of dueDocs) {
    result.scanned += 1;
    const row = doc.data() ?? {};
    // 종결(`closedReason`) 행은 선택 단계에서 이미 빠졌다 — 위 closedRows 참조.
    const applicationId = asString(row.applicationId);
    const uidGrantId = asString(row.uidGrantId);
    const lastEventId = asString(row.lastEventId);
    const traceId = asString(row.traceId);
    const locale = asString(row.locale, "en") || "en";
    const attempts = Math.max(0, Math.trunc(Number(row.attempts ?? 0)));
    const nextAttemptAtIso = asString(row.nextAttemptAtIso);
    if (!applicationId || !uidGrantId || !lastEventId) {
      bumpSkip("row_fields_missing");
      continue;
    }
    if (nextAttemptAtIso && nextAttemptAtIso > nowIso) {
      bumpSkip("retry_backoff");
      continue;
    }

    // Claim (queued/retryable_failed -> sending) so concurrent drains can never double-send.
    const claimed = await adminDb.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const freshState = asString(fresh.data()?.deliveryState);
      if (freshState !== "queued" && freshState !== "retryable_failed") return false;
      tx.set(doc.ref, { deliveryState: "sending", updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
    if (!claimed) {
      bumpSkip("claim_lost");
      continue;
    }

    /**
     * 무변이 해제. W124 이전에는 사유를 **아무 데도 남기지 않았다** — 그래서 60행이 두 달간
     * attempts 0 · lastErrorCode 없음으로 조용히 서 있었고, 원장만 봐서는 "아직 처리 전"과
     * "매분 집었다가 매번 거절당함"을 구분할 수 없었다. 시도는 그대로 소모하지 않되(그건 옳다),
     * **왜 못 나갔는지는 남긴다**. SEC-P0-009: 코드만 — 수신자·URL 원문 금지.
     */
    const releaseClaim = async (reason: UidGuideDrainSkipReason) => {
      await doc.ref.set(
        {
          deliveryState: asString(row.deliveryState, "queued") || "queued",
          lastSkipReason: reason,
          lastSkipAtIso: nowIso,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      bumpSkip(reason);
    };

    // W124: material 회수 사다리. scpOutboxMailWorkers.resolveSignedMaterialRecipient 이 이미
    // 프로덕션에서 쓰는 것과 **같은 순서**다(v3 ack 바인딩 → v1 커맨드). 여기서만 새로 발명한
    // 경로가 아니다.
    // F4② 와 같은 이유로 이 구간의 예외는 **그 행에서** 끝낸다. 클레임한 행이 예외로 빠져나가면
    // `sending` 으로 잠긴 채 아무 기록도 남지 않고, 잔여 행까지 통째로 멈춘다.
    let resolved: UidGuideMaterialResolution;
    try {
      resolved = await resolveUidGuideMaterial({
        applicationId,
        now,
        ackMaterialFetcher: materialFetcher,
        commandMaterialFetcher,
      });
    } catch {
      resolved = { material: null, reason: "material_unavailable" };
    }
    if (!resolved.material) {
      // Material unavailable/rejected: stay fail-closed with NO attempt mutation.
      await releaseClaim(resolved.reason);
      continue;
    }
    const material = resolved.material;

    // W124 [적대 리뷰 LOW] Portal 이 실어 준 만료 시각을 **회수만 하고 검사하지 않으면**, 만료된
    // material 로 죽은 링크를 발송하게 된다(수신자에게는 "안내 메일이 왔는데 안 열린다"로 보인다).
    // 발송 자체가 낭비이자 문의를 만든다. 만료/파싱불가는 무변이 스킵이다 — 다음 패스에서 새 material 을
    // 받으면 그대로 나간다. 만료 시각 자체는 어디에도 기록하지 않는다(사유 코드만).
    const materialExpiresAtMs = Date.parse(asString(material.expiresAt));
    if (!Number.isFinite(materialExpiresAtMs) || materialExpiresAtMs <= now.getTime()) {
      await releaseClaim("material_expired");
      continue;
    }

    result.materialRoutes[resolved.route] = (result.materialRoutes[resolved.route] ?? 0) + 1;

    // F4②: 이 아래 구간(렌더·발송)에서 예기치 못한 예외가 나면 **그 행만** 실패로 기록하고 다음 행을
    // 계속 처리한다. 예전에는 예외가 드레인 루프를 뚫고 나가 배치 잔여 행이 통째로 멈추고, 이미
    // 클레임한 행은 `sending` 으로 잠긴 채 아무 기록도 남지 않았다.
    const recordRowFailure = async (reason: string) => {
      // W62e-MAJ-A: 결정적 차단은 비소모 종결이다 — 같은 억제 목록에 같은 수신자면 결과가 같다.
      if (isTerminalSuppressionReason(reason)) {
        await doc.ref.set({
          deliveryState: "suppressed",
          lastErrorCode: reason.slice(0, 120),
          nextAttemptAtIso: null,
          updatedAtIso: now.toISOString(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return;
      }
      const nextAttempts = attempts + 1;
      const deadLetter = nextAttempts >= UID_GUIDE_MAIL_MAX_ATTEMPTS;
      await doc.ref.set(
        {
          deliveryState: deadLetter ? "dead_letter" : "retryable_failed",
          attempts: nextAttempts,
          lastErrorCode: reason.slice(0, 120),
          nextAttemptAtIso: deadLetter ? null : new Date(now.getTime() + Math.min(2 ** nextAttempts, 60) * 60_000).toISOString(),
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      if (deadLetter) result.deadLettered += 1;
      else result.retried += 1;
    };

    // F4③: 오염된 링크는 렌더러까지 가지 않는다 — 그 행만 실패로 격리한다.
    if (!isSafeUidGuideUrl(material.uidGuideUrl)) {
      await recordRowFailure("uid_guide_url_scheme_rejected");
      continue;
    }

    // W7-3c: 운영자가 `scp_mail_templates/uid_guide` 를 발행하면 그 템플릿이 이기고, 문서가 없거나
    // archived 면 위 하드코딩 렌더가 fallback 이다(fail-closed — 문서를 지우면 오늘과 동일 동작).
    // 링크는 값으로만 들어간다: 템플릿 본문에 URL 을 적어 넣을 수 없다.
    let rendered: Awaited<ReturnType<typeof resolveScpMailTemplateOverride>>;
    let sendResult: Awaited<ReturnType<MailSendAdapter>>;
    try {
      const fallback = renderUidGuideMail(locale, material.uidGuideUrl);
      rendered = await resolveScpMailTemplateOverride(
        "uid_guide",
        { subject: fallback.subject, text: fallback.body, html: fallback.html },
        { uid_guide_link: material.uidGuideUrl },
      );
    } catch (error) {
      await recordRowFailure(`render_failed:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const trackingId = `uid-guide-${receiptsDocId(`${applicationId}:${uidGrantId}:${Number(row.revision ?? 1)}`)}`.slice(0, 60);
    try {
      sendResult = await sendAdapter({
      to: material.recipientEmail,
      subject: rendered.subject,
      text: rendered.text,
      // W8-1a: 와이어는 컴파일 입력(자산화 이전)을 싣는다 — sendEmail 이 유일한 컴파일러다.
      // W8-3: 텍스트 전용 발행본이면 html 을 싣지 않는다.
      ...(rendered.bodyFormat === "text" ? {} : { html: rendered.htmlSource || rendered.html }),
      trackingId,
      draftRef: `uid-guide-outbox-${doc.id}`,
      approvalRef: `uid-guide-outbox-${doc.id}-approval`,
      mailPurpose: "uid_guide",
      templateKind: "uid_guide",
      gameId: "scp-automation",
      sourceRef: doc.ref.path,
      conversationId: `uid-guide-${applicationId}`,
      fenceApplicationId: applicationId,
      fenceTraceId: traceId || undefined,
      fenceSendGeneration: attempts + 1,
      });
    } catch (error) {
      await recordRowFailure(`send_threw:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (sendResult.sent) {
      await doc.ref.set(
        {
          deliveryState: "delivered",
          transport: "smtp",
          attempts: attempts + 1,
          providerMessageIdHash: receiptsDocId(sendResult.providerMessageId ?? trackingId),
          lastErrorCode: null,
          lastSkipReason: null,
          materialRoute: resolved.route,
          deliveredAtIso: nowIso,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      result.delivered += 1;
      continue;
    }
    if (sendResult.reason === "provider_unconfigured" || sendResult.reason?.startsWith("pilot_fence_denied")) {
      // Fence-denied or provider race: release with ZERO state/attempt mutation (Portal G005/G008).
      await releaseClaim("send_fence_denied");
      continue;
    }
    await recordRowFailure(sendResult.reason ?? "send_failed");
  }

  return result;
}
