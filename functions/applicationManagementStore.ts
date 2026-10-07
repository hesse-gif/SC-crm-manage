// Firestore-backed store for Portal Apply → Flu Manage application-management records (spec B §2-3,7).
// Composes the pure applicationManagementAttributionCore. Fail-closed: with no signed outreach
// attribution evidence in the current Portal application-event, records classify unclassified/
// token_absent and route to the Manage inbox for operator assignment (never auto-managed).
//
// PRIVACY: no raw PII (email/UID/token) is ever stored here — only opaque Portal IDs + hashes.
// The current scp.integration-event.v2 application.submitted event carries no email at all.

import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { recoverPendingApprovalOnboarding } from "./scpApprovalOnboarding";
import { resolveCanonicalProgramId } from "./programCanonical";
import { LEGACY_SHEET_PORTAL_PROGRAM_ID } from "./legacySheetContentMigrationProjection";
import {
  APPLICATION_MANAGEMENT_ATTRIBUTION_VERSION,
  ATTRIBUTION_CLASSIFICATION_STATES,
  MANAGE_INBOX_STATES,
  appendAssignmentRevision,
  buildIdentityMapping,
  classifyApplication,
  computeAttributionKpi,
  currentAssignment,
  currentRevisionNumber,
  emptyLedger,
  type AssignmentLedger,
  type AttributionClassification,
  type ClassificationResult,
  type SignedTokenEvidence,
} from "./applicationManagementAttributionCore";
import { enqueueManagementAckForApplication } from "./scpCreatorPipelineV3ManagementAckWiring";
import {
  MAX_PAGE_SIZE,
  resolveCreatorDisplayIdentity,
  type ManagementCreatorIdentityMatchedBy,
} from "./managementProfileTabsReadModels";
import {
  SCP_APPLICATION_CONFIRMED_MAIL_OUTBOX_COLLECTION,
  applicationConfirmedMailOutboxDocId,
  applicationConfirmedMailOutboxRow,
} from "./scpReceiptMailOutbox";
import { resolveScpReceiptMailTemplate } from "./scpReceiptMailTemplates";

export const SCP_APPLICATION_MANAGEMENT_COLLECTION = "scp_application_management";
export const APPLICATION_MANAGEMENT_STORE_VERSION = "application_management_store_v2" as const;

function storeDocId(applicationId: string): string {
  const safe = String(applicationId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
  if (!safe) throw new Error("invalid-argument: applicationId is required");
  return safe;
}

function asStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** creators 팩의 followers(구독자 수) 같은 운영 통계 — 없거나 음수/파싱 불가면 null(추정 금지). */
function nonNegativeIntOrNull(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

import { declaredAudienceCountryFromMaterial as extractDeclaredAudienceCountry } from "./applicationDeclaredAudienceCountry";

export type MaterializeApplicationInput = {
  applicationId: string;
  programId: string | null;
  campaignId: string | null;
  outreachId: string | null;
  portalCreatorId?: string | null;
  fluCreatorId?: string | null;
  enrollmentId?: string | null;
  settlementCreatorCode?: string | null;
  channelId?: string | null;
  submittedAtIso: string;
  /**
   * `submittedAtIso` 의 출처. Portal v3 intake 는 이벤트 occurredAt 이라 생략하고, 제출 시각을
   * 모르는 호환 경로(v1 application-command)는 반드시 출처를 남겨서 화면이 이 값을 포털 제출
   * 시각으로 오해하지 않게 한다(날조 금지).
   */
  submittedAtSource?: string | null;
  traceId: string;
  eventId: string;
  revision: number;
  sourceContract?: string;
  // Present only once the Portal v3 application-event carries verifiable signed attribution.
  // Absent today → fail-closed unclassified/token_absent.
  signedTokenEvidence?: SignedTokenEvidence | null;
  /**
   * W47: the real attributed program, resolved by the caller from campaignId (never from
   * `programId`/`identity.programId` — since W47 that field is the Portal-wide apply-gate scope,
   * not a program). Omitted/null => currentProgramId stays null; never guessed here.
   */
  resolvedProgramId?: string | null;
};

const NO_EVIDENCE: SignedTokenEvidence = {
  tokenPresent: false,
  signatureVerified: false,
  expired: false,
  revoked: false,
  candidateCount: 0,
  conflictingSignedEvidence: false,
};

export type MaterializeResult = {
  applicationId: string;
  classification: AttributionClassification;
  reasonCode: string;
  manageInbox: boolean;
  idempotent: boolean;
  /** R2: duplicate 경로에서 누락된 지원 완료 메일 outbox 를 복구했는지. */
  confirmationMailRepaired: boolean;
};

// Materialize (idempotent, stale-revision guarded) on application.submitted. Additive collection.
export async function materializeApplicationManagementRecord(
  input: MaterializeApplicationInput,
  now: Date,
): Promise<MaterializeResult> {
  const classification: ClassificationResult = classifyApplication(input.signedTokenEvidence ?? NO_EVIDENCE);
  const identity = buildIdentityMapping({
    applicationId: input.applicationId,
    programId: input.programId,
    campaignId: input.campaignId,
    outreachId: input.outreachId,
    portalCreatorId: input.portalCreatorId ?? null,
    fluCreatorId: input.fluCreatorId ?? null,
    enrollmentId: input.enrollmentId ?? null,
    settlementCreatorCode: input.settlementCreatorCode ?? null,
    channelId: input.channelId ?? null,
  });
  const ref = adminDb.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).doc(storeDocId(input.applicationId));
  const confirmationMailRef = adminDb
    .collection(SCP_APPLICATION_CONFIRMED_MAIL_OUTBOX_COLLECTION)
    .doc(applicationConfirmedMailOutboxDocId(input.applicationId));
  const confirmationTemplate = await resolveScpReceiptMailTemplate(
    "application_confirmed",
    {
      application_id: input.applicationId,
      program_name: input.programId ?? "Super Creator Partners",
    },
  );
  const nowIso = now.toISOString();
  // Auto-managed applications bind to their signed campaign; non-managed carry no current campaign
  // until an operator assigns one (§3.4).
  const currentCampaignId = classification.classification === "managed" ? identity.campaignId : null;
  // W47: identity.programId is the raw envelope value (Portal-wide apply-gate scope since the mint
  // fix), never the attributed program — currentProgramId only ever takes the caller-resolved value.
  const currentProgramId = classification.classification === "managed" ? (input.resolvedProgramId ?? null) : null;

  let idempotent = false;
  // R2: duplicate 경로에서 메일 outbox 를 복구했는지(관측용). 반환값에 실어 호출자가 로그로 남긴다.
  let confirmationMailRepaired = false;
  // Effective (returned) state defaults to the freshly-classified create values; when we touch an
  // EXISTING record we overwrite these with the preserved stored state.
  let effectiveClassification = classification.classification;
  let effectiveReasonCode: string = classification.reasonCode;
  let effectiveManageInbox = classification.routeToManageInbox;

  await adminDb.runTransaction(async (transaction) => {
    const [snap, confirmationMailSnapshot] = await Promise.all([
      transaction.get(ref),
      transaction.get(confirmationMailRef),
    ]);
    if (snap.exists) {
      const data = snap.data() ?? {};
      const priorRevision = Number(data.sourceRevision ?? 0);
      const storedClassification = (typeof data.classification === "string"
        ? (data.classification as AttributionClassification)
        : effectiveClassification);
      effectiveClassification = storedClassification;
      effectiveReasonCode = typeof data.reasonCode === "string" ? data.reasonCode : effectiveReasonCode;
      effectiveManageInbox = data.manageInbox === true;
      if (input.revision <= priorRevision) {
        idempotent = true;
        // R2(역방향 half-state 복구): management 는 있는데 지원 완료 메일 outbox 가 없는 반쪽 상태가
        // 실제로 가능하다(v1 command 이전 경로, 또는 outbox 생성 실패 후 재전송). duplicate 조기
        // 반환으로 나가 버리면 그 상태가 영구화되므로, **나가기 전에** outbox intent 를 idempotent 하게
        // 만든다. `transaction.create` + 결정적 doc id 라서 이미 있으면 만들지 않고(중복 0),
        // 기존 레코드·운영자 원장·classification 은 그대로 둔다(정방향 duplicate 경로 무변화).
        // F4(c): 정방향(fresh create)은 `revision === 1` 로 게이트돼 있다. 복구 경로도 **같은 강도**로
        // revision 정합을 요구한다 — 뒤늦게 도착한 stale revision(저장된 sourceRevision 보다 낮음)이
        // 최신 레코드에 메일 intent 를 만들면 그 시점 데이터로 만든 안내가 나가 버린다.
        const sameRevisionDuplicate = input.revision === priorRevision;
        if (sameRevisionDuplicate && input.programId && !confirmationMailSnapshot.exists) {
          transaction.create(
            confirmationMailRef,
            applicationConfirmedMailOutboxRow({
              applicationId: input.applicationId,
              programId: input.programId,
              ...(input.campaignId ? { campaignId: input.campaignId } : {}),
              ...(input.outreachId ? { outreachId: input.outreachId } : {}),
              ...(input.portalCreatorId ? { portalCreatorId: input.portalCreatorId } : {}),
              ...(input.fluCreatorId ? { fluCreatorId: input.fluCreatorId } : {}),
              ...(input.enrollmentId ? { enrollmentId: input.enrollmentId } : {}),
              eventId: input.eventId,
              traceId: input.traceId,
              sourceContract:
                input.sourceContract ?? "scp.application-management.materialization.v1",
              templateSnapshot: confirmationTemplate,
              nowIso,
            }),
          );
          confirmationMailRepaired = true;
        }
        return; // stale/duplicate: keep the existing record + operator ledger untouched.
      }
      // Strictly-higher revision on an EXISTING record: refresh ONLY source-derived identity + audit.
      // NEVER write revisions/revoked/classification/reasonCode/manageInbox/current* — a materialize
      // must never clobber the append-only operator ledger or silently un-attribute a managed record
      // (contract deletePriorRevisions:false / revoke.deletesHistory:false, §3.5/§3.6, exactly-once KPI).
      // Signed-evidence re-classification (Portal v3) is a separate, explicit path — not a silent merge.
      transaction.set(ref, {
        identity,
        traceId: input.traceId,
        lastEventId: input.eventId,
        sourceRevision: input.revision,
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }
    // Fresh create only: full projection + empty append-only ledger.
    const ledger: AssignmentLedger = emptyLedger(input.applicationId);
    transaction.set(ref, {
      version: APPLICATION_MANAGEMENT_ATTRIBUTION_VERSION,
      storeVersion: APPLICATION_MANAGEMENT_STORE_VERSION,
      identity,
      classification: classification.classification,
      reasonCode: classification.reasonCode,
      autoManagedEligible: classification.autoManagedEligible,
      manageInbox: classification.routeToManageInbox,
      currentProgramId,
      currentCampaignId,
      submittedAtIso: input.submittedAtIso,
      ...(input.submittedAtSource ? { submittedAtSource: input.submittedAtSource } : {}),
      revisions: ledger.revisions,
      revoked: ledger.revoked,
      // hash-only audit; opaque IDs only (no raw email/UID/token)
      traceId: input.traceId,
      lastEventId: input.eventId,
      sourceRevision: input.revision,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (
      input.revision === 1 &&
      input.programId &&
      !confirmationMailSnapshot.exists
    ) {
      transaction.create(
        confirmationMailRef,
        applicationConfirmedMailOutboxRow({
          applicationId: input.applicationId,
          programId: input.programId,
          ...(input.campaignId ? { campaignId: input.campaignId } : {}),
          ...(input.outreachId ? { outreachId: input.outreachId } : {}),
          ...(input.portalCreatorId
            ? { portalCreatorId: input.portalCreatorId }
            : {}),
          ...(input.fluCreatorId ? { fluCreatorId: input.fluCreatorId } : {}),
          ...(input.enrollmentId ? { enrollmentId: input.enrollmentId } : {}),
          eventId: input.eventId,
          traceId: input.traceId,
          sourceContract:
            input.sourceContract ??
            "scp.application-management.materialization.v1",
          templateSnapshot: confirmationTemplate,
          nowIso,
        }),
      );
    }
  });

  // NOTE: the auto-managed (v3 signed-attribution) management-ack enqueue is fired by
  // scpCreatorPipelineV3Receiver AFTER it commits the intake material (effectState:"done") — NOT here.
  // materialize runs before that receipt write, so firing here would race a receipt-less doc (fail-safe
  // but ineffective). The operator-assign path fires its own enqueue in assignApplicationManagementRecord.
  //
  // 승인 온보딩 복구 훅은 반대로 **여기가 정위치다**: "managed 를 만드는/확인하는 모든 쓰기"에
  // 훅이 달려 있어야 v3 서명귀속 fresh-create 같은 새 managed 경로가 생겨도 빠지지 않는다
  // (적대 리뷰 HIGH-1 — 호출부마다 수동으로 달면 다음 경로에서 또 빠진다). 온보딩 큐잉은
  // intake receipt 를 읽지 않으므로 receipt 이전에 발사해도 race 가 없고, 승인 명령이 없으면
  // no-op 이라 v1 unclassified 경로 비용은 doc-get 1회다.
  if (effectiveClassification === "managed") {
    void recoverPendingApprovalOnboarding(input.applicationId, now, "managed_promotion").catch((error) => {
      console.warn(
        "[application-management] approval_onboarding_recovery_hook_failed",
        JSON.stringify({ applicationId: input.applicationId, error: error instanceof Error ? error.message : "unknown" }),
      );
    });
  }
  return {
    applicationId: input.applicationId,
    classification: effectiveClassification,
    reasonCode: effectiveReasonCode,
    manageInbox: effectiveManageInbox,
    idempotent,
    confirmationMailRepaired,
  };
}

export type AssignApplicationInput = {
  applicationId: string;
  programId: string | null;
  campaignId: string | null;
  actor: string;
  reason: string;
  expectedRevision: number;
};

export type AssignResult = {
  applicationId: string;
  revision: number;
  currentCampaignId: string | null;
  classification: AttributionClassification;
};

// Operator manual assign/reassign — append-only ledger revision; KPI moves exactly once because the
// projection derives from currentCampaignId. Throws on revision conflict / revoked (from the core).
export async function assignApplicationManagementRecord(
  input: AssignApplicationInput,
  now: Date,
): Promise<AssignResult> {
  const ref = adminDb.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).doc(storeDocId(input.applicationId));
  const nowIso = now.toISOString();
  // A managed assignment with neither program nor campaign would be invisible (out of inbox) AND
  // uncounted (unattributed KPI) — reject it. Cap operator reason length (durable append-only text).
  if (!input.programId && !input.campaignId) {
    throw Object.assign(
      new Error("invalid-argument: assign requires at least one of programId or campaignId"),
      { code: "invalid-argument", errorCode: "assign_application_management_record_assign_requires_at_least_program" },
    );
  }
  const reason = input.reason.slice(0, 280);
  const assignResult = await adminDb.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new Error("not-found: application-management record does not exist");
    const data = snap.data() ?? {};
    const priorLedger: AssignmentLedger = {
      applicationId: input.applicationId,
      revisions: Array.isArray(data.revisions) ? (data.revisions as AssignmentLedger["revisions"]) : [],
      revoked: data.revoked === true,
    };
    const nextLedger = appendAssignmentRevision(priorLedger, {
      actor: input.actor,
      reason,
      programId: input.programId,
      campaignId: input.campaignId,
      classification: "managed",
      atIso: nowIso,
      expectedRevision: input.expectedRevision,
    });
    const head = currentAssignment(nextLedger);
    transaction.set(ref, {
      revisions: nextLedger.revisions,
      classification: "managed",
      reasonCode: "operator_assigned",
      manageInbox: false,
      currentProgramId: input.programId,
      currentCampaignId: input.campaignId,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return {
      applicationId: input.applicationId,
      revision: head ? head.revision : currentRevisionNumber(nextLedger),
      currentCampaignId: input.campaignId,
      classification: "managed" as AttributionClassification,
    };
  });
  // Operator managed-assignment committed → enqueue the management-ack (fire-and-forget, fail-closed).
  void enqueueManagementAckForApplication(input.applicationId, {}).catch(() => {});
  // managed 승격은 승인 온보딩 게이트(§4.4)를 여는 사건이다 — 승격 이전에 도착해
  // blocked/pending 으로 남은 Portal 승인 명령이 있으면 지금 큐잉한다(deny-list 복구).
  void recoverPendingApprovalOnboarding(input.applicationId, now, "managed_promotion").catch((error) => {
    console.warn(
      "[application-management] approval_onboarding_recovery_hook_failed",
      JSON.stringify({ applicationId: input.applicationId, error: error instanceof Error ? error.message : "unknown" }),
    );
  });
  return assignResult;
}

type ResolvedCreatorRecord = {
  id: string;
  data: Record<string, unknown>;
};

async function resolveCreatorForApplicationIdentity(
  identity: {
    fluCreatorId: string | null;
    portalCreatorId: string | null;
    channelId: string | null;
  },
  directCreators?: ReadonlyMap<string, ResolvedCreatorRecord>,
): Promise<ResolvedCreatorRecord | null> {
  if (identity.fluCreatorId) {
    const direct = directCreators
      ? directCreators.get(identity.fluCreatorId)
      : await adminDb.collection("creators").doc(identity.fluCreatorId).get().then((snapshot) =>
        snapshot.exists
          ? { id: snapshot.id, data: (snapshot.data() ?? {}) as Record<string, unknown> }
          : undefined,
      );
    // A concrete fluCreatorId is the highest-authority ownership claim. If it cannot be resolved, do
    // not attach a lower-authority Portal/channel creator to the row.
    return direct ?? null;
  }

  if (identity.portalCreatorId) {
    const bindingSnapshot = await adminDb
      .collection("scp_portal_creator_bindings")
      .where("portalCreatorId", "==", identity.portalCreatorId)
      .where("status", "==", "active")
      .limit(2)
      .get();
    if (bindingSnapshot.docs.length > 1) return null;
    if (bindingSnapshot.docs.length === 1) {
      const binding = bindingSnapshot.docs[0].data() as Record<string, unknown>;
      const boundFluCreatorId = binding.status === "active" ? asStr(binding.fluCreatorId) : null;
      if (!boundFluCreatorId) return null;
      const creator = await adminDb.collection("creators").doc(boundFluCreatorId).get();
      return creator.exists
        ? { id: creator.id, data: (creator.data() ?? {}) as Record<string, unknown> }
        : null;
    }
  }

  if (!identity.channelId) return null;
  // Creator writers historically used channelId/youtubeChannelId, while canonical-media reconciliation
  // may expose canonicalChannelId. Query every accepted convention, then require one unique creator.
  const channelSnapshots = await Promise.all(
    ["channelId", "youtubeChannelId", "canonicalChannelId"].map((field) =>
      adminDb.collection("creators").where(field, "==", identity.channelId).limit(2).get(),
    ),
  );
  const matches = new Map<string, ResolvedCreatorRecord>();
  for (const snapshot of channelSnapshots) {
    for (const creator of snapshot.docs) {
      matches.set(creator.id, {
        id: creator.id,
        data: (creator.data() ?? {}) as Record<string, unknown>,
      });
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}
// 2026-09-17 [헤세 · 콘텐츠 검수 인박스]: manageInbox==true(귀속 애매)와 qualification.verdict
// ==="human_review"(Task-95 자격 애매)는 서로 다른 축이라 하나가 다른 하나를 부분집합으로
// 포함하지 않는다(구독자 수 비공개/조회 실패 신청은 귀속이 이미 확정돼도 manageInbox=false일
// 수 있다). 인박스 화면이 두 번째 축을 놓치지 않도록, 기존 콜러블에 새 콜러블을 만들지 않고
// 조회 축만 하나 더한다 — 기본값(manage_inbox)은 기존 호출부(/flu/manage/applications)의
// 동작을 그대로 보존한다.
export type ManageInboxRecordsFilter = "manage_inbox" | "qualification_human_review";

export async function listManageInboxRecords(
  limit = 100,
  filter: ManageInboxRecordsFilter = "manage_inbox",
): Promise<Array<Record<string, unknown>>> {
  const query = filter === "qualification_human_review"
    ? adminDb.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).where("qualification.verdict", "==", "human_review")
    : adminDb.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).where("manageInbox", "==", true);
  const snap = await query
    .limit(Math.max(1, Math.min(limit, 500)))
    .get();
  const rows = snap.docs.map((doc) => {
    const d = doc.data();
    const identity = (d.identity && typeof d.identity === "object" && !Array.isArray(d.identity)
      ? d.identity
      : {}) as Record<string, unknown>;
    // Task-95 §3: applicationEligibilityJudgeSweep.ts 가 쓴 마커(있으면). 원장 원문은 여기서
    // 절대 노출하지 않는다 — verdict/reasonCode/판정 시각/원장 참조만.
    const qualification = (d.qualification && typeof d.qualification === "object" && !Array.isArray(d.qualification)
      ? d.qualification
      : null) as Record<string, unknown> | null;
    // W104 스윕(applicationDeclaredIdentitySweep.ts)이 포털 지원 답변에서 이메일류를 걸러
    // 심은 자가신고 신원 — 문서에 없으면 null(지어내지 않는다). source/backfilledAtIso 같은
    // 내부 메타는 표시 필드만 골라 싣는다.
    const declared = (d.declaredIdentity && typeof d.declaredIdentity === "object" && !Array.isArray(d.declaredIdentity)
      ? d.declaredIdentity
      : null) as Record<string, unknown> | null;
    return {
      applicationId: doc.id,
      classification: asStr(d.classification),
      reasonCode: asStr(d.reasonCode),
      currentCampaignId: asStr(d.currentCampaignId),
      currentProgramId: asStr(d.currentProgramId),
      submittedAtIso: asStr(d.submittedAtIso),
      qualification: qualification ? {
        verdict: asStr(qualification.verdict),
        reasonCode: asStr(qualification.reasonCode),
        judgedAtIso: asStr(qualification.judgedAtIso),
      } : null,
      // 인박스 행에 신원이 하나도 없으면 운영자는 무엇을 배정하는지 모른 채 배정한다.
      // 레코드가 실제로 들고 있는 신원 클레임만 그대로 싣는다(없으면 null — 지어내지 않는다).
      identity: {
        fluCreatorId: asStr(identity.fluCreatorId),
        channelId: asStr(identity.channelId),
        portalCreatorId: asStr(identity.portalCreatorId),
        enrollmentId: asStr(identity.enrollmentId),
        outreachId: asStr(identity.outreachId),
        programId: asStr(identity.programId),
      },
      declaredIdentity: declared ? {
        handle: asStr(declared.handle),
        name: asStr(declared.name),
        country: asStr(declared.country),
        category: asStr(declared.category),
        channelUrl: asStr(declared.channelUrl),
      } : null,
      // B2-7 프로젝션(projectDeclaredAudienceCountry)이 심은 신고 오디언스 국가 — 거주국
      // (declaredIdentity.country)과는 다른 축이라 별도 필드로 내린다.
      declaredPrimaryAudienceCountry: asStr(d.declaredPrimaryAudienceCountry),
      creatorDisplayName: null as string | null,
      creatorHandle: null as string | null,
      creatorSubscriberCount: null as number | null,
      creatorCountry: null as string | null,
    };
  });

  // Preserve the existing batched doc-id lookup for the highest-authority fluCreatorId claim. Only
  // rows unresolved by that batch pay for the lower-authority binding/channel field queries.
  const visibleRows = rows;
  const directCreatorIds = [...new Set(
    visibleRows
      .map((row) => row.identity.fluCreatorId)
      .filter((id): id is string => Boolean(id)),
  )];
  const directCreators = new Map<string, ResolvedCreatorRecord>();
  if (directCreatorIds.length > 0) {
    const snapshots = await adminDb.getAll(
      ...directCreatorIds.map((id) => adminDb.collection("creators").doc(id)),
    );
    for (const snapshot of snapshots) {
      if (!snapshot.exists) continue;
      directCreators.set(snapshot.id, {
        id: snapshot.id,
        data: (snapshot.data() ?? {}) as Record<string, unknown>,
      });
    }
  }

  const fallbackLookups = new Map<string, Promise<ResolvedCreatorRecord | null>>();
  for (let offset = 0; offset < visibleRows.length; offset += 10) {
    await Promise.all(visibleRows.slice(offset, offset + 10).map(async (row) => {
      const lookupKey = [
        row.identity.fluCreatorId ?? "",
        row.identity.portalCreatorId ?? "",
        row.identity.channelId ?? "",
      ].join("\u0000");
      let lookup = fallbackLookups.get(lookupKey);
      if (!lookup) {
        lookup = resolveCreatorForApplicationIdentity(row.identity, directCreators);
        fallbackLookups.set(lookupKey, lookup);
      }
      const creator = await lookup;
      if (!creator) return;
      const resolved = resolveCreatorDisplayIdentity(creator.data, creator.id);
      row.creatorDisplayName = resolved.displayName || null;
      row.creatorHandle = resolved.handle;
      // creators 팩의 운영 통계 컨벤션(creatorCanonicalMediaReconciliation 이 followers=구독자 수,
      // region=국가를 쓴다) — 해석된 크리에이터가 있을 때만 채운다. 필드가 없으면 null.
      row.creatorSubscriberCount = nonNegativeIntOrNull(creator.data.followers);
      row.creatorCountry = asStr(creator.data.region);
    }));
  }
  return rows;
}

// ---- W91 [헤세 · 크리에이터 탭]: Portal 지원서 관리 레코드 전체를 Flu 매핑 유무와 함께 보여주는
// 읽기 전용 디렉터리. listManageInboxRecords 와 달리 manageInbox==true 필터가 없다 — 이미 배정된
// 지원서도 "Flu 크리에이터로 연결됐는가"는 별개 축이라 여기서 함께 보여준다. 실행 액션(승인/배정
// 등)은 이 P0 범위에 없다 — Portal 로 딥링크만 보낸다(포털 API 호출 금지).

export type ScpCreatorDirectoryIdentity = {
  portalCreatorId: string | null;
  fluCreatorId: string | null;
  channelId: string | null;
  enrollmentId: string | null;
  programId: string | null;
};

export type ScpCreatorDirectoryBinding = {
  linked: boolean;
  fluCreatorId: string | null;
  partnerId: string | null;
  enrollmentId: string | null;
};

export type ScpCreatorDirectoryRow = {
  applicationId: string;
  classification: AttributionClassification;
  reasonCode: string | null;
  currentProgramId: string | null;
  currentCampaignId: string | null;
  submittedAtIso: string | null;
  revision: number;
  identity: ScpCreatorDirectoryIdentity;
  // W104 스윕이 심은 자가신고 신원(이메일류는 쓰기 시점에 필터됨). 해석된 크리에이터가
  // 없는 행도 opaque applicationId 대신 지원자가 제출한 신원을 보여줄 수 있다 — 없으면 null.
  declaredIdentity: {
    handle: string | null;
    name: string | null;
    country: string | null;
    category: string | null;
    channelUrl: string | null;
  } | null;
  creatorDisplayName: string | null;
  creatorHandle: string | null;
  binding: ScpCreatorDirectoryBinding;
  manageInboxPending: boolean;
};

const NO_CREATOR_BINDING: ScpCreatorDirectoryBinding = {
  linked: false,
  fluCreatorId: null,
  partnerId: null,
  enrollmentId: null,
};

const CREATOR_BINDINGS_COLLECTION = "scp_portal_creator_bindings";

function chunkValues<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

// portalCreatorId(주) 또는 sourceApplicationId(보조)로 scp_portal_creator_bindings 를 청크 `in`
// 질의(10개 단위)로 일괄 조회한다 — 디렉터리 행 수만큼 개별 질의하는 N+1 을 피한다.
async function loadActiveCreatorBindings(
  field: "portalCreatorId" | "sourceApplicationId",
  values: readonly string[],
): Promise<Map<string, ScpCreatorDirectoryBinding>> {
  const map = new Map<string, ScpCreatorDirectoryBinding>();
  // 같은 키(portalCreatorId/sourceApplicationId)로 active 바인딩이 2개 이상이면 first-match-wins
  // 하지 않고 fail-closed 로 해당 키는 미부착 처리한다 — resolveCreatorForApplicationIdentity 의
  // `docs.length > 1 → null` 가드와 대칭.
  const ambiguous = new Set<string>();
  const unique = [...new Set(values)];
  for (const group of chunkValues(unique, 10)) {
    if (group.length === 0) continue;
    const snap = await adminDb
      .collection(CREATOR_BINDINGS_COLLECTION)
      .where(field, "in", group)
      .where("status", "==", "active")
      .get();
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>;
      const key = asStr(d[field]);
      if (!key || ambiguous.has(key)) continue;
      if (map.has(key)) {
        map.delete(key);
        ambiguous.add(key);
        continue;
      }
      map.set(key, {
        linked: true,
        fluCreatorId: asStr(d.fluCreatorId),
        partnerId: asStr(d.partnerId),
        enrollmentId: asStr(d.enrollmentId),
      });
    }
  }
  return map;
}

/**
 * 지원서 관리 레코드를 submittedAtIso 내림차순으로 최대 `limit`건 조회한다(classification 무관 —
 * inbox 상태만이 아니라 전체). 각 행에 scp_portal_creator_bindings 조인 결과(binding.linked)와
 * 표시 신원(creatorDisplayName/creatorHandle)을 얹는다. 단일 필드 정렬만 쓰므로 복합 인덱스가
 * 필요 없다(computeApplicationManagementKpi 와 동일 근거).
 */
export async function listScpCreatorDirectoryRecords(limit = 100): Promise<{
  rows: ScpCreatorDirectoryRow[];
  scanned: number;
  truncated: boolean;
}> {
  const cap = Math.max(1, Math.min(limit, MAX_PAGE_SIZE));
  const snap = await adminDb
    .collection(SCP_APPLICATION_MANAGEMENT_COLLECTION)
    .orderBy("submittedAtIso", "desc")
    .limit(cap)
    .get();

  const rows: ScpCreatorDirectoryRow[] = snap.docs.map((doc) => {
    const d = doc.data();
    const identity = (d.identity && typeof d.identity === "object" && !Array.isArray(d.identity)
      ? d.identity
      : {}) as Record<string, unknown>;
    const classification = (ATTRIBUTION_CLASSIFICATION_STATES as readonly string[]).includes(String(d.classification))
      ? (d.classification as AttributionClassification)
      : "unclassified";
    const ledger: AssignmentLedger = {
      applicationId: doc.id,
      revisions: Array.isArray(d.revisions) ? (d.revisions as AssignmentLedger["revisions"]) : [],
      revoked: d.revoked === true,
    };
    const declared = (d.declaredIdentity && typeof d.declaredIdentity === "object" && !Array.isArray(d.declaredIdentity)
      ? d.declaredIdentity
      : null) as Record<string, unknown> | null;
    return {
      applicationId: doc.id,
      classification,
      reasonCode: asStr(d.reasonCode),
      currentProgramId: asStr(d.currentProgramId),
      currentCampaignId: asStr(d.currentCampaignId),
      submittedAtIso: asStr(d.submittedAtIso),
      revision: currentRevisionNumber(ledger),
      identity: {
        portalCreatorId: asStr(identity.portalCreatorId),
        fluCreatorId: asStr(identity.fluCreatorId),
        channelId: asStr(identity.channelId),
        enrollmentId: asStr(identity.enrollmentId),
        programId: asStr(identity.programId),
      },
      declaredIdentity: declared ? {
        handle: asStr(declared.handle),
        name: asStr(declared.name),
        country: asStr(declared.country),
        category: asStr(declared.category),
        channelUrl: asStr(declared.channelUrl),
      } : null,
      creatorDisplayName: null,
      creatorHandle: null,
      binding: NO_CREATOR_BINDING,
      manageInboxPending: (MANAGE_INBOX_STATES as readonly string[]).includes(classification),
    };
  });

  // 바인딩 조인: portalCreatorId 우선, 못 찾은 행만 sourceApplicationId 로 2차 조회(N+1 회피).
  const portalCreatorIds = rows
    .map((row) => row.identity.portalCreatorId)
    .filter((id): id is string => Boolean(id));
  const byPortalCreatorId = await loadActiveCreatorBindings("portalCreatorId", portalCreatorIds);
  const unresolvedApplicationIds = rows
    .filter((row) => !(row.identity.portalCreatorId && byPortalCreatorId.has(row.identity.portalCreatorId)))
    .map((row) => row.applicationId);
  const bySourceApplicationId = unresolvedApplicationIds.length > 0
    ? await loadActiveCreatorBindings("sourceApplicationId", unresolvedApplicationIds)
    : new Map<string, ScpCreatorDirectoryBinding>();
  for (const row of rows) {
    row.binding =
      (row.identity.portalCreatorId ? byPortalCreatorId.get(row.identity.portalCreatorId) : undefined)
      ?? bySourceApplicationId.get(row.applicationId)
      ?? NO_CREATOR_BINDING;
  }

  // 표시 신원 해석: listManageInboxRecords 와 같은 배치 전략(직접 fluCreatorId doc-id 일괄 조회 →
  // 남은 행만 하위-권위 fallback, 10개 청크). 관리 인박스와 별개 뷰라 로직을 복제해 둔다(그 함수의
  // 기존 계약/테스트를 건드리지 않기 위함).
  const directCreatorIds = [...new Set(
    rows.map((row) => row.identity.fluCreatorId).filter((id): id is string => Boolean(id)),
  )];
  const directCreators = new Map<string, ResolvedCreatorRecord>();
  if (directCreatorIds.length > 0) {
    const snapshots = await adminDb.getAll(
      ...directCreatorIds.map((id) => adminDb.collection("creators").doc(id)),
    );
    for (const snapshot of snapshots) {
      if (!snapshot.exists) continue;
      directCreators.set(snapshot.id, {
        id: snapshot.id,
        data: (snapshot.data() ?? {}) as Record<string, unknown>,
      });
    }
  }
  const fallbackLookups = new Map<string, Promise<ResolvedCreatorRecord | null>>();
  for (let offset = 0; offset < rows.length; offset += 10) {
    await Promise.all(rows.slice(offset, offset + 10).map(async (row) => {
      const lookupKey = [
        row.identity.fluCreatorId ?? "",
        row.identity.portalCreatorId ?? "",
        row.identity.channelId ?? "",
      ].join("\u0000");
      let lookup = fallbackLookups.get(lookupKey);
      if (!lookup) {
        lookup = resolveCreatorForApplicationIdentity(row.identity, directCreators);
        fallbackLookups.set(lookupKey, lookup);
      }
      const creator = await lookup;
      if (!creator) return;
      const resolved = resolveCreatorDisplayIdentity(creator.data, creator.id);
      row.creatorDisplayName = resolved.displayName || null;
      row.creatorHandle = resolved.handle;
    }));
  }

  return { rows, scanned: snap.size, truncated: snap.size >= cap };
}

export async function computeApplicationManagementKpi(limit = 2000) {
  const cap = Math.max(1, Math.min(limit, 5000));
  // Deterministic order + explicit truncation signal so a KPI beyond the cap is never silently wrong
  // (spec §7). submittedAtIso is set on every record → single-field order needs no composite index.
  const snap = await adminDb
    .collection(SCP_APPLICATION_MANAGEMENT_COLLECTION)
    .orderBy("submittedAtIso", "desc")
    .limit(cap)
    .get();
  const apps = snap.docs.map((doc) => {
    const d = doc.data();
    const classification = (ATTRIBUTION_CLASSIFICATION_STATES as readonly string[]).includes(String(d.classification))
      ? (d.classification as AttributionClassification)
      : "unclassified";
    return {
      applicationId: doc.id,
      submittedAtIso: asStr(d.submittedAtIso) ?? "",
      currentCampaignId: asStr(d.currentCampaignId),
      currentProgramId: asStr(d.currentProgramId),
      classification,
    };
  });
  const projection = computeAttributionKpi(apps);
  return { ...projection, scanned: snap.size, truncated: snap.size >= cap };
}

export const MANAGE_INBOX_CLASSIFICATIONS = MANAGE_INBOX_STATES;

export type ApplicationManagementLifecycleFallbackProfile = {
  applicationId: string;
  matchedIdentifier: string;
  /**
   * W104-2: 폴백 행이 alias 매칭에 실을 수 있는 유일한 신원 근거(관리 문서 `identity` 서브셋).
   * 없으면 없는 대로 둔다 — 지어내지 않는다. 소비자는 scpLifecycleProfiles.applicationManagementFallbackProfileRow.
   */
  fluCreatorId?: string;
  channelId?: string;
  programId: string | null;
  campaignId: string | null;
  outreachId: string | null;
  outreachName?: string;
  outreachHandle?: string;
  /** W101: 관리 목록 카드 부제용 — 서명 아웃리치 문서에서만 파생(campaignId 일치 검증 후). */
  outreachPlatform?: string;
  outreachCountry?: string;
  outreachCategory?: string;
  /**
   * W104: 지원서 자가신고 신원(포털 answers 안전 서브셋, 이메일 제외). 발송 귀속과 다른 축 —
   * 귀속 미확인이어도 지원자가 직접 적은 핸들·이름은 표시할 수 있고, 지어낸 값이 아니다.
   */
  declaredHandle?: string;
  declaredName?: string;
  declaredCountry?: string;
  declaredCategory?: string;
  campaignName?: string;
  classification: AttributionClassification;
  reasonCode: string;
  manageInbox: boolean;
  submittedAtIso: string;
};

type ApplicationManagementLookupDb = Pick<FirebaseFirestore.Firestore, "collection">;

export const APPLICATION_MANAGEMENT_IDENTITY_FALLBACK_FIELDS = [
  "identity.fluCreatorId",
  "identity.portalCreatorId",
  "identity.channelId",
] as const;

export type ApplicationManagementIdentityLookupMatch = {
  matchedBy: ManagementCreatorIdentityMatchedBy;
  records: Array<{ applicationId: string; data: Record<string, unknown> }>;
};

export type ApplicationManagementIdentityLookupCursor = {
  matchedBy: (typeof APPLICATION_MANAGEMENT_IDENTITY_FALLBACK_FIELDS)[number];
  submittedAtIso: string;
  applicationId: string;
};

export async function findApplicationManagementRecordsByIdentityFallback(
  candidateIdentifier: string,
  options: {
    db?: ApplicationManagementLookupDb;
    limit?: number;
    includeApplicationId?: boolean;
    programId?: string;
    cursor?: ApplicationManagementIdentityLookupCursor | null;
  } = {},
): Promise<ApplicationManagementIdentityLookupMatch | null> {
  const candidate = asStr(candidateIdentifier);
  if (!candidate) return null;
  const db = options.db ?? adminDb;
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 1), MAX_PAGE_SIZE + 1));
  const scopedProgramId = options.programId === undefined ? null : asStr(options.programId);
  if (options.programId !== undefined && !scopedProgramId) return null;

  if (options.includeApplicationId !== false && !options.cursor) {
    const byApplicationId = await db
      .collection(SCP_APPLICATION_MANAGEMENT_COLLECTION)
      .doc(storeDocId(candidate))
      .get();
    if (byApplicationId.exists) {
      const data = (byApplicationId.data() ?? {}) as Record<string, unknown>;
      if (!scopedProgramId || applicationManagementIdentityField(data, "programId") === scopedProgramId) {
        return {
          matchedBy: "applicationId",
          records: [{ applicationId: byApplicationId.id, data }],
        };
      }
    }
  }

  for (const field of APPLICATION_MANAGEMENT_IDENTITY_FALLBACK_FIELDS) {
    if (options.cursor && options.cursor.matchedBy !== field) continue;
    let query: FirebaseFirestore.Query = db
      .collection(SCP_APPLICATION_MANAGEMENT_COLLECTION)
      .where(field, "==", candidate);
    if (scopedProgramId) {
      query = query
        .where("identity.programId", "==", scopedProgramId)
        .orderBy("submittedAtIso", "desc")
        .orderBy(FieldPath.documentId(), "desc");
      if (options.cursor) {
        query = query.startAfter(options.cursor.submittedAtIso, options.cursor.applicationId);
      }
    }
    const snapshot = await query.limit(limit).get();
    if (snapshot.docs.length === 0) {
      if (options.cursor) return null;
      continue;
    }
    return {
      matchedBy: field,
      records: snapshot.docs.map((doc) => ({
        applicationId: doc.id,
        data: (doc.data() ?? {}) as Record<string, unknown>,
      })),
    };
  }
  return null;
}

function applicationManagementIdentityField(data: Record<string, unknown>, field: string): string | null {
  const identity = data.identity;
  if (!identity || typeof identity !== "object") return null;
  return asStr((identity as Record<string, unknown>)[field]);
}

export function applicationManagementLifecycleProgramId(data: Record<string, unknown>): string | null {
  const currentProgramId = asStr(data.currentProgramId);
  if (currentProgramId) return currentProgramId;
  const identityProgramId = applicationManagementIdentityField(data, "programId");
  if (!identityProgramId) return null;
  // W45-FIX contract: unattributed is null, not a fallback guess. The portal cannot distinguish
  // programs (see operationalSnapshot.ts's normalizeProgramId), so its "view-cpm" tag must not
  // leak into the program-id slot here (W48-3) — a real, non-portal identity.programId still falls
  // back normally.
  if (identityProgramId === LEGACY_SHEET_PORTAL_PROGRAM_ID) return null;
  return resolveCanonicalProgramId(identityProgramId) || null;
}

function toApplicationManagementLifecycleFallbackProfile(
  applicationId: string,
  data: Record<string, unknown>,
  matchedIdentifier: string,
): ApplicationManagementLifecycleFallbackProfile {
  const classification = (ATTRIBUTION_CLASSIFICATION_STATES as readonly string[]).includes(String(data.classification))
    ? (data.classification as AttributionClassification)
    : "unclassified";
  const declared = (data.declaredIdentity && typeof data.declaredIdentity === "object" && !Array.isArray(data.declaredIdentity))
    ? data.declaredIdentity as Record<string, unknown>
    : {};
  const declaredHandle = asStr(declared.handle) ?? "";
  const declaredName = asStr(declared.name) ?? "";
  const declaredCountry = asStr(declared.country) ?? "";
  const declaredCategory = asStr(declared.category) ?? "";
  const fluCreatorId = applicationManagementIdentityField(data, "fluCreatorId") ?? "";
  const channelId = applicationManagementIdentityField(data, "channelId") ?? "";
  return {
    applicationId,
    matchedIdentifier,
    ...(fluCreatorId ? { fluCreatorId } : {}),
    ...(channelId ? { channelId } : {}),
    programId: applicationManagementLifecycleProgramId(data),
    campaignId: asStr(data.currentCampaignId) ?? applicationManagementIdentityField(data, "campaignId"),
    outreachId: applicationManagementIdentityField(data, "outreachId"),
    classification,
    reasonCode: asStr(data.reasonCode) ?? "unknown",
    manageInbox: data.manageInbox === true,
    submittedAtIso: asStr(data.submittedAtIso) ?? "",
    ...(declaredHandle ? { declaredHandle } : {}),
    ...(declaredName ? { declaredName } : {}),
    ...(declaredCountry ? { declaredCountry } : {}),
    ...(declaredCategory ? { declaredCategory } : {}),
  };
}

// Bounded single-record lookup used ONLY as a last-resort fallback by the SCP lifecycle profile
// resolver (P2, FLU-0540) when none of its existing sources (scp_lifecycle_profiles / scp_identity_
// aliases) know about a Portal-origin creator whose only durable Flu record is this application-
// management materialization. For each candidate identifier, the shared resolver tries the exact
// application doc id and then identity.fluCreatorId → identity.portalCreatorId → identity.channelId.
// Every field query is explicitly bounded; the collection is never scanned.
export async function findApplicationManagementRecordForLifecycleFallback(
  candidateIdentifiers: readonly string[],
): Promise<ApplicationManagementLifecycleFallbackProfile | null> {
  const seen = new Set<string>();
  for (const raw of candidateIdentifiers) {
    const candidate = asStr(raw);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    const match = await findApplicationManagementRecordsByIdentityFallback(candidate, {
      limit: 1,
      includeApplicationId: true,
    });
    const record = match?.records[0];
    if (record) {
      return toApplicationManagementLifecycleFallbackProfile(
        record.applicationId,
        record.data,
        candidate,
      );
    }
  }
  return null;
}
/**
 * B2-7: 목록 유입용 bounded 스캔. `scp_application_management` 는 accepted Apply 의 정본
 * projection 이지만 lifecycle 소스가 아니어서, management-only Apply 는 관리 목록 universe 에
 * 나타나지 않았다("메일은 갔는데 관리에 안 보인다"의 나머지 절반).
 *
 * 단일 필드 정렬(submittedAtIso)만 쓰므로 복합 인덱스가 필요 없고, 상한에서 잘렸다는 사실을 함께
 * 돌려준다(조용한 누락 금지). 신원은 이 컬렉션이 실제로 들고 있는 값만 쓴다 — 이름을 지어내지 않는다.
 */
export async function listApplicationManagementLifecycleFallbackRecords(
  limit = 200,
): Promise<{ records: ApplicationManagementLifecycleFallbackProfile[]; truncated: boolean }> {
  const cap = Math.max(1, Math.min(limit, 500));
  const snap = await adminDb
    .collection(SCP_APPLICATION_MANAGEMENT_COLLECTION)
    .orderBy("submittedAtIso", "desc")
    .limit(cap)
    .get();
  const records = snap.docs.map((doc) => {
    const data = doc.data() ?? {};
    // 매칭 식별자 순서는 상세 경로(findApplicationManagementRecordForLifecycleFallback)와 동일:
    // identity.fluCreatorId → identity.portalCreatorId → identity.channelId → applicationId.
    const matchedIdentifier =
      applicationManagementIdentityField(data, "fluCreatorId")
      ?? applicationManagementIdentityField(data, "portalCreatorId")
      ?? applicationManagementIdentityField(data, "channelId")
      ?? doc.id;
    return toApplicationManagementLifecycleFallbackProfile(doc.id, data, matchedIdentifier);
  });
  return { records, truncated: snap.size >= cap };
}


// ---- B2-7: Apply 신고 오디언스 국가 current projection ------------------------------------------
//
// 계약(B2-AUDIENCE-INGRESS-DATA-CONTRACT §2.1): `scp_application_management/{applicationId}` 에
// `declaredPrimaryAudienceCountry`(normalized ISO alpha-2) + 출처 증거만 additive 하게 저장한다.
// raw 지원서 answers 전체를 복사하지 않고, application revision 이 오르면 current projection 을
// 새 revision 으로 갱신한다(이전 원본은 protected material/event 원장에 그대로 남는다).

export { declaredAudienceCountryFromMaterial } from "./applicationDeclaredAudienceCountry";

export type ProjectDeclaredAudienceCountryInput = {
  applicationId: string;
  applicationRevision: number;
  materialEventId: string;
  materialHash: string;
  material: unknown;
};

export type ProjectDeclaredAudienceCountryResult = {
  projected: boolean;
  countryCode: string | null;
  reason: "projected" | "no_allowlisted_country" | "stale_revision" | "record_absent";
};

/**
 * 신고 국가 current projection 갱신. management 레코드가 없으면 만들지 않는다(그 생성은 intake 경로의
 * 책임). 저장된 증거 revision 보다 낮으면 덮지 않는다.
 */
export async function projectDeclaredAudienceCountry(
  input: ProjectDeclaredAudienceCountryInput,
  now: Date,
): Promise<ProjectDeclaredAudienceCountryResult> {
  const countryCode = extractDeclaredAudienceCountry(input.material);
  if (!countryCode) return { projected: false, countryCode: null, reason: "no_allowlisted_country" };
  const ref = adminDb.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).doc(storeDocId(input.applicationId));
  const nowIso = now.toISOString();
  let result: ProjectDeclaredAudienceCountryResult = {
    projected: false,
    countryCode,
    reason: "record_absent",
  };
  await adminDb.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const data = snap.data() ?? {};
    const evidence = data.declaredAudienceCountryEvidence;
    const priorRevision = Number(
      (evidence && typeof evidence === "object" && !Array.isArray(evidence)
        ? (evidence as Record<string, unknown>).applicationRevision
        : 0) ?? 0,
    );
    if (Number.isFinite(priorRevision) && input.applicationRevision < priorRevision) {
      result = { projected: false, countryCode, reason: "stale_revision" };
      return;
    }
    transaction.set(ref, {
      declaredPrimaryAudienceCountry: countryCode,
      declaredAudienceCountryEvidence: {
        source: "portal_apply",
        applicationId: input.applicationId,
        applicationRevision: input.applicationRevision,
        materialEventId: input.materialEventId,
        materialHash: input.materialHash,
        observedAtIso: nowIso,
      },
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    result = { projected: true, countryCode, reason: "projected" };
  });
  return result;
}

// W99(헤세, 2026-08-17): 아웃박스 역전파 — apply 시점에 서명 토큰이 없어(token_absent)
// unclassified 로 남은 관리 문서를, 메일 발송 레인이 나중에 해석해낸 서명 귀속
// (campaignId+outreachId)으로 승격한다. 실측: unclassified 102건 전부가 컨펌 아웃박스와
// 조인되고 27건은 campaignId+outreachId 가 이미 해석돼 있었다("데이터는 있는데 배선이
// 없다"). 발송 기록은 추정이 아니라 실증이므로 managed 승격 근거가 된다.
// 불가침: unclassified+token_absent 일 때만 — 운영자 배정(operator_assigned)·기존 서명
// 귀속은 절대 덮지 않는다.
export async function backfillApplicationManagementFromOutbox(
  applicationId: string,
  campaignId: string,
  outreachId: string,
  now: Date,
): Promise<"promoted" | "skipped"> {
  const ref = adminDb.collection("scp_application_management").doc(applicationId);
  const outcome = await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return "skipped";
    const data = snap.data() ?? {};
    if (String(data.classification) !== "unclassified") return "skipped";
    if (asStr(data.reasonCode) !== "token_absent") return "skipped";
    const campaignSnap = await tx.get(adminDb.collection("campaigns").doc(campaignId));
    const campaignProgramId = resolveCanonicalProgramId(
      String(campaignSnap.data()?.programId ?? ""),
    );
    const identity = (data.identity && typeof data.identity === "object")
      ? { ...(data.identity as Record<string, unknown>) }
      : {};
    identity.campaignId = campaignId;
    identity.outreachId = outreachId;
    tx.set(ref, {
      classification: "managed",
      reasonCode: "outbox_resolved",
      currentCampaignId: campaignId,
      ...(campaignProgramId ? { currentProgramId: campaignProgramId } : {}),
      identity,
      // W99 리뷰 처방: 승격 = 인박스 해소 — 형제 함수(assignApplicationManagementRecord)와
      // 동형으로 정리하지 않으면 listManageInboxRecords(manageInbox==true)에 영구 잔류한다.
      manageInbox: false,
      updatedAtIso: now.toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return "promoted";
  });
  if (outcome === "promoted") {
    // 아웃박스 역전파 승격도 운영자 배정과 동형으로 승인 온보딩 복구를 깨운다.
    void recoverPendingApprovalOnboarding(applicationId, now, "managed_promotion").catch((error) => {
      console.warn(
        "[application-management] approval_onboarding_recovery_hook_failed",
        JSON.stringify({ applicationId, error: error instanceof Error ? error.message : "unknown" }),
      );
    });
  }
  return outcome;
}
