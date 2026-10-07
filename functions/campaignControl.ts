import { createHash } from "node:crypto";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  assertCampaignControlActor,
  assertCampaignControlIdentity,
  campaignControlSafeFields,
  parseCampaignControlUpdateInput,
  validateCampaignControlMutation,
  CAMPAIGN_CANCELLED_OPERATIONAL_STATE,
  type CampaignControlUpdateInput,
} from "./campaignControlCore";
import { resolveCanonicalProgramId } from "./programCanonical";
import {
  confirmedProgramScope,
  readConfirmedProgramAliasRegistryState,
  readConfirmedProgramAliasRegistryStateInTransaction,
  type ConfirmedProgramAliasRegistryState,
} from "./programAliasRegistry";
import type { MutationAuthorizationActor } from "./mutationAuthorization";
import { readSettings } from "./settings";
import {
  assertAccountOwnershipForRecordAsync,
  assertWritableAccountOwnershipScope,
  resolveAccountOwnershipScopeForRequest,
  type AccountOwnershipScope,
} from "./accountOwnership";

type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";
type CallableRequest = {
  auth?: { uid?: string; token?: { role?: Role; team?: string; email?: string; tenant?: string; tenantId?: string; firebase?: { tenant?: string } } };
  data?: unknown;
};

const WRITE_ROLES = new Set<Role>(["super_admin", "admin", "manager"]);
const ARCHIVE_REQUEUE_LIMIT = 400; // 트랜잭션 쓰기 한도 여유분. 이 수와 같으면 절단 가능성으로 본다.
const COMMITTED_OUTREACH_STATES = ["approved", "processing", "sent", "mock_sent"];
const CAMPAIGN_CONTROL_AUDIT_COLLECTION = "campaign_control_audits";
const CAMPAIGN_APPROVAL_AUDIT_COLLECTION = "campaign_outreach_approval_audits";

function controlError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, max = 180): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function actorHash(uid: string): string {
  return createHash("sha256").update(uid).digest("hex").slice(0, 24);
}

function requireActor(request: CallableRequest): MutationAuthorizationActor {
  const uid = text(request.auth?.uid, 180);
  const role = request.auth?.token?.role ?? "guest";
  if (!uid) throw controlError("unauthenticated", "authentication required");
  if (!WRITE_ROLES.has(role)) throw controlError("permission-denied", "manager or admin role required");
  return { uid, role };
}

export function campaignControlActor(request: CallableRequest): MutationAuthorizationActor {
  return requireActor(request);
}

export function campaignControlRefs(
  programId: string,
  campaignId: string,
  aliasRegistryState?: ConfirmedProgramAliasRegistryState,
) {
  const canonicalProgramId = resolveCanonicalProgramId(programId, aliasRegistryState?.aliasMap ?? {});
  if (!canonicalProgramId || canonicalProgramId.includes("/")) {
    throw controlError("invalid-argument", "programId is not canonicalizable");
  }
  return {
    canonicalProgramId,
    programRef: adminDb.collection("programs").doc(canonicalProgramId),
    campaignRef: adminDb.collection("campaigns").doc(campaignId),
  };
}

export async function readAuthorizedCampaignControlInTransaction(input: {
  transaction: Transaction;
  actor: MutationAuthorizationActor;
  accountScope?: AccountOwnershipScope;
  programId: string;
  campaignId: string;
  expectedVersion?: number;
}) {
  const aliasRegistryState = await readConfirmedProgramAliasRegistryStateInTransaction(input.transaction);
  const scope = confirmedProgramScope(input.programId, aliasRegistryState);
  const refs = campaignControlRefs(scope.canonicalProgramId, input.campaignId, aliasRegistryState);
  const [programSnapshot, campaignSnapshot] = await Promise.all([
    input.transaction.get(refs.programRef),
    input.transaction.get(refs.campaignRef),
  ]);
  if (!programSnapshot.exists) throw controlError("not-found", "authoritative program not found");
  if (!campaignSnapshot.exists) throw controlError("not-found", "campaign not found");
  const program: Record<string, unknown> = { id: programSnapshot.id, ...(programSnapshot.data() ?? {}) };
  const campaign: Record<string, unknown> = { id: campaignSnapshot.id, ...(campaignSnapshot.data() ?? {}) };
  const canonicalProgramId = assertCampaignControlIdentity({
    requestedProgramId: input.programId,
    requestedCampaignId: input.campaignId,
    program,
    campaign,
    aliasMap: aliasRegistryState.aliasMap,
  });
  if (input.accountScope) {
    await assertAccountOwnershipForRecordAsync(input.accountScope, program, "campaign control program");
    await assertAccountOwnershipForRecordAsync(input.accountScope, campaign, "campaign control campaign");
  } else {
    assertCampaignControlActor(input.actor, program, campaign);
  }
  const safeFields = campaignControlSafeFields(campaign, program);
  if (input.expectedVersion !== undefined && safeFields.controlVersion !== input.expectedVersion) {
    throw controlError("aborted", `campaign control version conflict: expected ${input.expectedVersion}, current ${safeFields.controlVersion}`);
  }
  return {
    ...refs,
    program,
    campaign,
    safeFields,
    canonicalProgramId,
    identityProgramIds: scope.identityProgramIds,
    aliasMap: aliasRegistryState.aliasMap,
    aliasRegistryRevision: scope.aliasRegistryRevision,
  };
}

export async function campaignCommittedFloorInTransaction(
  transaction: Transaction,
  campaignId: string,
  campaign: Record<string, unknown>,
): Promise<number> {
  const committedQuery = adminDb.collection("campaign_outreach")
    .where("campaignId", "==", campaignId)
    .where("deliveryState", "in", COMMITTED_OUTREACH_STATES)
    .select();
  const activeReservationsQuery = adminDb.collection("campaign_outreach_reservations")
    .where("campaignId", "==", campaignId)
    .where("status", "==", "selected");
  const [committedSnapshot, activeReservationsSnapshot] = await Promise.all([
    transaction.get(committedQuery),
    transaction.get(activeReservationsQuery),
  ]);
  const committedRows = committedSnapshot.size;
  const activeReservations = activeReservationsSnapshot.size;
  const storedSent = Math.max(
    integer(campaign.sent, 0),
    integer(campaign.sentCount, 0),
  );
  return Math.max(committedRows, storedSent + activeReservations);
}

export async function updateCampaignControl(request: CallableRequest) {
  const actor = requireActor(request);
  const accountScope = await resolveAccountOwnershipScopeForRequest(request, "campaignControl.update", ["super_admin", "admin", "manager"], { data: record(request.data) });
  assertWritableAccountOwnershipScope(accountScope, "campaignControl.update");
  // daily-cap-fairness: dailyCap 의 상한은 전역 일일 캡(automation.maxDailyOutreachSends)이다 —
  // 트랜잭션 밖에서 한 번만 읽어, 아래 1차 파싱과 validateCampaignControlMutation 내부 2차 파싱에
  // 같은 상한을 준다(둘이 갈리면 1차는 통과하고 2차가 던지는 모순이 생긴다).
  const settings = await readSettings();
  const dailyCapCeiling = Math.max(0, Math.round(settings.automation.maxDailyOutreachSends));
  const parsed = parseCampaignControlUpdateInput(request.data, dailyCapCeiling);
  const auditRef = adminDb.collection(CAMPAIGN_CONTROL_AUDIT_COLLECTION).doc();
  const nowIso = new Date().toISOString();
  const result = await adminDb.runTransaction(async (transaction) => {
    const authorized = await readAuthorizedCampaignControlInTransaction({
      transaction,
      actor,
      accountScope,
      programId: parsed.programId,
      campaignId: parsed.campaignId,
      expectedVersion: parsed.expectedVersion,
    });
    const committedCount = await campaignCommittedFloorInTransaction(transaction, parsed.campaignId, authorized.campaign);
    const validated = validateCampaignControlMutation({
      input: record(request.data),
      actor,
      program: authorized.program,
      campaign: authorized.campaign,
      committedCount,
      aliasMap: authorized.aliasMap,
      dailyCapCeiling,
      allowAccountScopedCriteriaEdit: true,
    });
    const currentArbiter = record(authorized.campaign.campaignArbiter);
    const currentTargetingCriteria = record(authorized.campaign.targetingCriteria);
    const patch: Record<string, unknown> = {
      targetMetric: validated.after.targetMetric,
      targetValue: validated.after.targetValue,
      campaignQuota: validated.after.outreachQuota,
      priority: validated.after.priority,
      operatorPriorityOverride: validated.after.priority,
      operationalState: validated.after.operationalState,
      // 취소는 운영자가 세울 수 없는 판정 전용 상태다(campaignControlCore). 여기 else 로 흘려보내면
      // 취소된 캠페인의 다른 필드를 한 번 고치는 것만으로 status 가 "대기" 로 덮여 취소 표식이 사라진다.
      status: validated.after.operationalState === CAMPAIGN_CANCELLED_OPERATIONAL_STATE
        ? text(authorized.campaign.status, 120) || CAMPAIGN_CANCELLED_OPERATIONAL_STATE
        : validated.after.operationalState === "paused"
          ? "일시정지"
          : validated.after.operationalState === "completed"
            ? "완료"
            : "대기",
      // W41 보관: 기존 필드만 쓴다(새 컬렉션·콜러블·설정키 0). archivedAtIso 는 서버 목록 판정
      // isSoftHidden(read.ts:1203-1205)이 이미 보는 필드이고, operationalState=completed 는 발송
      // 선정·리필·승인 게이트가 이미 요구하는 active 를 닫는다. 과거 발송 실적 필드는 건드리지 않는다.
      ...(parsed.archived === undefined ? {} : parsed.archived
        ? { archivedAtIso: nowIso, operationalState: "completed", status: "완료" }
        : { archivedAtIso: "" }),
      controlVersion: validated.nextVersion,
      controlUpdatedAtIso: nowIso,
      controlUpdatedByHash: actorHash(actor.uid),
      updatedAtIso: nowIso,
      campaignArbiter: {
        ...currentArbiter,
        quota: validated.after.outreachQuota,
        priorityOverride: validated.after.priority,
        overrideReasonCode: "operator_campaign_control",
        overrideVersion: validated.nextVersion,
        updatedAtIso: nowIso,
      },
    };
    if (validated.parsed.name !== undefined) patch.name = validated.after.name;
    if (validated.parsed.liveSendCap !== undefined) {
      // W100: 요청된 때만 쓴다(무조건 쓰면 미설정 캠페인에 0 을 도장 찍는다). source 는 자동
      // 라벨 — 누가(actor 해시) 어떤 경로(campaign-control 콜러블)로 바꿨는지 문서만 봐도 안다.
      patch.liveSendCap = validated.after.liveSendCap;
      patch.liveSendCapSource = `manual.campaign-control.${actorHash(actor.uid)}`;
      patch.liveSendCapReason = validated.parsed.liveSendCapReason ?? "";
      patch.liveSendCapUpdatedAtIso = nowIso;
    }
    // daily-cap-fairness: liveSendCap 과 같은 이유로 요청된 때만 쓴다. super_admin·사유 요구는
    // 없다(manager+ 면 누구나) — 감사는 아래 changedFields 가 before/after 를 일반 필드처럼 남긴다.
    if (validated.parsed.dailyCap !== undefined) patch.dailyCap = validated.after.dailyCap;
    let targetingCriteria = currentTargetingCriteria;
    if (validated.countryProjection) {
      const country = validated.countryProjection;
      patch.countryTargeting = country.countryTargeting;
      patch.effectiveCountryTargeting = country.effectiveCountryTargeting;
      patch.targetCountries = country.targetCountries ?? FieldValue.delete();
      patch.excludedCountries = country.excludedCountries;
      targetingCriteria = {
        ...targetingCriteria,
        countryTargeting: country.countryTargeting,
        effectiveCountryTargeting: country.effectiveCountryTargeting,
        targetCountries: country.targetCountries ?? FieldValue.delete(),
        excludedCountries: country.excludedCountries,
        regions: country.regions,
      };
    }
    if (validated.parsed.targetingCriteria !== undefined) {
      const nextTargetingCriteria = { ...targetingCriteria, ...validated.parsed.targetingCriteria.values };
      for (const key of validated.parsed.targetingCriteria.deleteKeys) delete nextTargetingCriteria[key];
      targetingCriteria = nextTargetingCriteria;
    }
    if (validated.parsed.allowInflyOverlap !== undefined) {
      patch.allowInflyOverlap = validated.after.allowInflyOverlap;
      targetingCriteria = { ...targetingCriteria, allowInflyOverlap: validated.after.allowInflyOverlap };
    }
    if (targetingCriteria !== currentTargetingCriteria) patch.targetingCriteria = targetingCriteria;
    if (validated.before.priority !== validated.after.priority) {
      patch.priorityVersion = integer(authorized.campaign.priorityVersion, 0) + 1;
      patch.priorityUpdatedAtIso = nowIso;
      patch.priorityUpdatedByHash = actorHash(actor.uid);
    }
    // W41-4 [발송 워커 실측]: chat-ai.ts:6925-6932 의 발송 스윕은 campaign_outreach 를
    // deliveryState in [approved, processing] + sendAfterIso 로만 고르고 **캠페인 문서를 읽지 않는다**.
    // 그래서 operationalState=completed 만으로는 이미 승인된 행이 보관 후에도 그대로 발송된다.
    // 핫패스에 캠페인 조회를 넣지 않고 보관 시점에 approved 행만 큐 대기로 되돌린다(원자적, 스윕 비용 0).
    // processing 은 발사 중이라 무접촉(중복·유실 위험) · sent/mock_sent 등 실적도 무접촉이다.
    let archiveRequeued = 0;
    let archiveRequeueTruncated = false;
    if (parsed.archived === true) {
      const approvedRows = await transaction.get(
        adminDb.collection("campaign_outreach")
          .where("campaignId", "==", parsed.campaignId)
          .where("deliveryState", "==", "approved")
          .select()
          .limit(ARCHIVE_REQUEUE_LIMIT),
      );
      for (const doc of approvedRows.docs) {
        transaction.update(doc.ref, { deliveryState: "queued_for_review", updatedAtIso: nowIso });
      }
      archiveRequeued = approvedRows.size;
      archiveRequeueTruncated = approvedRows.size === ARCHIVE_REQUEUE_LIMIT;
    }
    transaction.set(authorized.campaignRef, patch, { merge: true });
    transaction.create(auditRef, {
      id: auditRef.id,
      action: "campaign_control_update",
      programId: validated.canonicalProgramId,
      campaignId: parsed.campaignId,
      programRef: authorized.programRef.path,
      campaignRef: authorized.campaignRef.path,
      requestedProgramId: parsed.programId,
      aliasRegistryRevision: authorized.aliasRegistryRevision,
      before: validated.before,
      after: validated.after,
      committedCount,
      changedFields: (Object.keys(validated.after) as Array<keyof typeof validated.after>)
        .filter((key) => JSON.stringify(validated.before[key]) !== JSON.stringify(validated.after[key])),
      actorUserIdHash: actorHash(actor.uid),
      actorRole: actor.role,
      ...(validated.parsed.liveSendCap !== undefined
        ? { liveSendCapReason: validated.parsed.liveSendCapReason ?? "" }
        : {}),
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { validated, committedCount, archiveRequeued, archiveRequeueTruncated };
  });
  return {
    ok: true,
    campaignId: parsed.campaignId,
    programId: result.validated.canonicalProgramId,
    controlVersion: result.validated.nextVersion,
    committedCount: result.committedCount,
    controls: result.validated.after,
    archiveRequeued: result.archiveRequeued,
    archiveRequeueTruncated: result.archiveRequeueTruncated,
    auditRef: auditRef.path,
  };
}

function maskedRecipient(value: unknown): string {
  const email = text(value, 320).toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return "";
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

function approvalQueueInput(value: unknown) {
  const data = record(value);
  const programId = text(data.programId, 120);
  const campaignId = text(data.campaignId, 120);
  const limit = data.limit === undefined ? 20 : integer(data.limit, -1);
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(programId)) throw controlError("invalid-argument", "programId required");
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(campaignId)) throw controlError("invalid-argument", "campaignId required");
  if (limit < 1 || limit > 50) throw controlError("invalid-argument", "limit must be from 1 to 50");
  return { programId, campaignId, limit };
}

export async function listCampaignOutreachApprovalQueue(request: CallableRequest) {
  const actor = requireActor(request);
  const accountScope = await resolveAccountOwnershipScopeForRequest(request, "campaignControl.approvalQueue.list", ["super_admin", "admin", "manager"], { data: record(request.data) });
  const input = approvalQueueInput(request.data);
  const aliasRegistryState = await readConfirmedProgramAliasRegistryState();
  const scope = confirmedProgramScope(input.programId, aliasRegistryState);
  const refs = campaignControlRefs(scope.canonicalProgramId, input.campaignId, aliasRegistryState);
  const [programSnapshot, campaignSnapshot] = await adminDb.getAll(refs.programRef, refs.campaignRef);
  if (!programSnapshot.exists) throw controlError("not-found", "authoritative program not found");
  if (!campaignSnapshot.exists) throw controlError("not-found", "campaign not found");
  const program = { id: programSnapshot.id, ...(programSnapshot.data() ?? {}) };
  const campaign = { id: campaignSnapshot.id, ...(campaignSnapshot.data() ?? {}) };
  const canonicalProgramId = assertCampaignControlIdentity({
    requestedProgramId: input.programId,
    requestedCampaignId: input.campaignId,
    program,
    campaign,
    aliasMap: aliasRegistryState.aliasMap,
  });
  await assertAccountOwnershipForRecordAsync(accountScope, program, "campaign control program");
  await assertAccountOwnershipForRecordAsync(accountScope, campaign, "campaign control campaign");
  assertCampaignControlActor(actor, program, campaign);
  const campaignQuery = adminDb.collection("campaign_outreach")
    .where("campaignId", "==", input.campaignId)
    .where("deliveryState", "==", "queued_for_review");
  const baseQuery = scope.identityProgramIds.length === 1
    ? campaignQuery.where("programId", "==", scope.identityProgramIds[0])
    : campaignQuery.where("programId", "in", scope.identityProgramIds);
  const [rowsSnapshot, countSnapshot] = await Promise.all([
    baseQuery.limit(input.limit).get(),
    baseQuery.count().get(),
  ]);
  const rows = rowsSnapshot.docs.map((snapshot) => {
    const row = snapshot.data() ?? {};
    const countryDecision = text(row.countryDecision, 80);
    return {
      id: snapshot.id,
      recipientMasked: maskedRecipient(row.creatorEmail || row.to),
      country: text(row.country || row.creatorRegion, 4).toUpperCase(),
      countryDecision: [
        "countryAllowed",
        "excludedByIncludedCountries",
        "excludedByExplicitCountry",
        "unknownCountryHeld",
      ].includes(countryDecision) ? countryDecision : null,
      createdAtIso: text(row.createdAtIso, 40),
      sendAfterIso: text(row.sendAfterIso, 40),
      liveSend: row.liveSend === true && row.dryRun !== true,
    };
  });
  return {
    ok: true,
    programId: canonicalProgramId,
    aliasRegistryRevision: scope.aliasRegistryRevision,
    campaignId: input.campaignId,
    pendingCount: integer(countSnapshot.data().count, 0),
    returnedCount: rows.length,
    selectionLimit: 5,
    controlVersion: campaignControlSafeFields(campaign).controlVersion,
    rows,
  };
}

export function campaignApprovalAuditRef() {
  return adminDb.collection(CAMPAIGN_APPROVAL_AUDIT_COLLECTION).doc();
}

export function campaignControlActorHash(uid: string): string {
  return actorHash(uid);
}
