// PRODUCT-SAFE enrollment-identity resolution + wiring for the `scp-creator-pipeline-v3`
// management-ack sender (./scpCreatorPipelineV3ManagementAckStore.ts's documented FLU-DOMAIN GAP).
//
// This module closes that gap WITHOUT any fabrication, schema change, or new secret: it sources
// `managedEnrollment.{fluCreatorId,partnerId,enrollmentId,channelId}` from the EXISTING immutable
// operator-provisioned `scp_portal_creator_bindings` registry (./scpPortalCreatorBinding.ts), the
// EXISTING `scp_application_management` record (./applicationManagementStore.ts), and the EXISTING
// `scp_creator_pipeline_v3_receipts` intake ledger (./scpCreatorPipelineV3Receiver.ts). It does not
// read/write any new collection and does not alter any of those modules' schemas.
//
// Fail-closed everywhere: any missing/ambiguous/inactive binding, missing/unmanaged management
// record, or missing intake material yields `null` (resolver) or `{ enqueued: false, reason }`
// (enqueue) — NEVER a fabricated identity, and NEVER a thrown exception out of the public functions.
//
// PRIVACY P0: only opaque ids/hashes ever cross into this module or its logs — no raw PII.
import { createHash } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
import { sha256Hex } from "./integrationEventV2";
import { SCP_APPLICATION_MANAGEMENT_COLLECTION } from "./applicationManagementStore";
import { CREATOR_PIPELINE_V3_RECEIPTS_COLLECTION } from "./scpCreatorPipelineV3Receiver";
import { type IntakeMaterialCase } from "./applicationInitialAudienceCountry";
import {
  enqueueManagementAck,
  type ManagementAckEnqueueInput,
} from "./scpCreatorPipelineV3ManagementAckStore";

export const MANAGEMENT_ACK_WIRING_POLICY_VERSION = "scp-management-2026-07-v1";

// Mirrors scpPortalCreatorBinding.ts's private `BINDINGS_COLLECTION` literal (not exported there —
// this is the same collection name, not a new one).
const BINDINGS_COLLECTION = "scp_portal_creator_bindings";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

// ---- binding resolution -------------------------------------------------------------------------

export type ManagementAckEnrollmentBinding = Readonly<{
  fluCreatorId: string;
  partnerId: string;
  enrollmentId: string;
  channelId?: string;
  portalCreatorId: string;
  programId: string;
}>;

export type ResolveManagementAckEnrollmentBindingOptions = Readonly<{
  firestore?: FirebaseFirestore.Firestore;
}>;

/**
 * Fail-closed resolve-by-application lookup against the immutable `scp_portal_creator_bindings`
 * registry (mirrors the proven `resolveCreatorTupleByApplication` query shape in
 * ./scpIntegrationEventV2.ts:272-307 — WHERE sourceApplicationId==applicationId — but, unlike that
 * v2 helper, NEVER returns a placeholder tuple: 0 matches, >1 matches, or a non-"active" match all
 * yield `null`). scpPortalCreatorBinding.ts exports no by-application resolver of its own (its only
 * export is the provisioning callable), so this query is the reuse point.
 */
export async function resolveManagementAckEnrollmentBinding(
  applicationId: string,
  options: ResolveManagementAckEnrollmentBindingOptions = {},
): Promise<ManagementAckEnrollmentBinding | null> {
  if (!isNonEmptyString(applicationId)) return null;
  const db = options.firestore ?? adminDb;
  try {
    const matches = await db
      .collection(BINDINGS_COLLECTION)
      .where("sourceApplicationId", "==", applicationId)
      .where("status", "==", "active")
      .limit(2)
      .get();
    if (matches.size !== 1) return null;

    const data = matches.docs[0].data() ?? {};
    const fluCreatorId = asString(data.fluCreatorId);
    const partnerId = asString(data.partnerId);
    const enrollmentId = asString(data.enrollmentId);
    const portalCreatorId = asString(data.portalCreatorId);
    const programId = asString(data.programId);
    const channelId = asString(data.channelId);
    if (!fluCreatorId || !partnerId || !enrollmentId || !portalCreatorId || !programId) return null;

    return {
      fluCreatorId,
      partnerId,
      enrollmentId,
      portalCreatorId,
      programId,
      ...(channelId ? { channelId } : {}),
    };
  } catch {
    // Registry read failure is indistinguishable from "no active binding" at this fail-closed
    // boundary — never surface a partial/fabricated identity either way.
    return null;
  }
}

// ---- deterministic sourceEventId ----------------------------------------------------------------

/**
 * Deterministic `managedEnrollment.sourceEventId`, matching Portal's IDENTIFIER_PATTERN
 * (^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$) and the `deriveReceiptId`/receiver `receiptId` naming
 * convention. MUST be deterministic so the outer eventId (which hashes managedEnrollment) is
 * retry-stable across re-enqueues of the same (applicationId, revision).
 */
export function deriveManagementAckSourceEventId(applicationId: string, revision: number | string): string {
  return `flu_assignment_${sha256Hex(`${applicationId}:${String(revision)}`).slice(0, 32)}`;
}

// ---- pure snapshot builder -----------------------------------------------------------------------

export type ManagementAckManagementRecordSnapshot = Readonly<{
  applicationId: string;
  traceId: string | null;
  portalCreatorId: string | null;
  programId: string | null;
  campaignId: string | null;
  outreachId?: string | null;
}>;

export type ManagementAckIntakeMaterialSnapshot = Readonly<{
  materialEventId: string;
  materialHash: string;
  applicationRevision: number;
}>;

export type BuildManagementAckEnqueueInputParams = Readonly<{
  managementRecord: ManagementAckManagementRecordSnapshot;
  intakeReceipt: ManagementAckIntakeMaterialSnapshot;
  binding: ManagementAckEnrollmentBinding;
  revision: number;
  assignmentMode: "signed_attribution" | "operator_assigned";
  policyVersion: string;
}>;

/**
 * PURE builder: assembles `ManagementAckEnqueueInput` from the management record, intake receipt,
 * and resolved binding. Returns `null` (never throws, never fabricates) when any required input is
 * missing/empty, or when the binding's `programId`/`portalCreatorId` (the enrollment-identity
 * authority) disagrees with the management record's own values. `settlementCreatorCode` is always
 * omitted — Flu has no source for it and this module never invents one.
 */
export function buildManagementAckEnqueueInputForApplication(
  params: BuildManagementAckEnqueueInputParams,
): ManagementAckEnqueueInput | null {
  const { managementRecord, intakeReceipt, binding, revision, assignmentMode, policyVersion } = params;
  if (!managementRecord || !intakeReceipt || !binding) return null;

  if (!isNonEmptyString(managementRecord.applicationId)) return null;
  if (!isNonEmptyString(managementRecord.traceId ?? undefined)) return null;
  if (!isNonEmptyString(managementRecord.portalCreatorId ?? undefined)) return null;
  if (!isNonEmptyString(managementRecord.programId ?? undefined)) return null;
  if (!isNonEmptyString(managementRecord.campaignId ?? undefined)) return null;

  if (!isNonEmptyString(intakeReceipt.materialEventId)) return null;
  if (!isNonEmptyString(intakeReceipt.materialHash)) return null;
  if (!isPositiveInteger(intakeReceipt.applicationRevision)) return null;

  if (!isPositiveInteger(revision)) return null;
  if (assignmentMode !== "signed_attribution" && assignmentMode !== "operator_assigned") return null;
  if (!isNonEmptyString(policyVersion)) return null;

  if (!isNonEmptyString(binding.fluCreatorId)) return null;
  if (!isNonEmptyString(binding.partnerId)) return null;
  if (!isNonEmptyString(binding.enrollmentId)) return null;
  if (!isNonEmptyString(binding.portalCreatorId)) return null;
  if (!isNonEmptyString(binding.programId)) return null;

  // The binding is the enrollment-identity authority; disagreement with the management record's own
  // portalCreatorId/programId is a fail-closed conflict signal, never silently resolved either way.
  if (binding.programId !== managementRecord.programId) return null;
  if (binding.portalCreatorId !== managementRecord.portalCreatorId) return null;

  const outreachId = isNonEmptyString(managementRecord.outreachId ?? undefined)
    ? (managementRecord.outreachId as string)
    : null;
  const channelId = isNonEmptyString(binding.channelId) ? (binding.channelId as string) : null;

  return {
    applicationId: managementRecord.applicationId,
    traceId: managementRecord.traceId as string,
    revision,
    applicationRevision: intakeReceipt.applicationRevision,
    materialEventId: intakeReceipt.materialEventId,
    materialHash: intakeReceipt.materialHash,
    portalCreatorId: managementRecord.portalCreatorId as string,
    programId: managementRecord.programId as string,
    campaignId: managementRecord.campaignId as string,
    ...(outreachId ? { outreachId } : {}),
    assignmentMode,
    policyVersion,
    fluCreatorId: binding.fluCreatorId,
    partnerId: binding.partnerId,
    enrollmentId: binding.enrollmentId,
    sourceEventId: deriveManagementAckSourceEventId(managementRecord.applicationId, revision),
    status: "active",
    ...(channelId ? { channelId } : {}),
  };
}

// ---- Firestore doc-id helper (mirrors scpCreatorPipelineV3Receiver.ts's private `docId`) --------

function receiptsDocId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 48);
}

// Mirrors applicationManagementStore.ts's private `storeDocId` (not exported there).
function managementRecordDocId(applicationId: string): string {
  return String(applicationId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
}

// R25-B: exported so scpCreatorPipelineV3ManagementAckStore.ts's declared-audience-country backfill
// pass can resolve intake material for an application WITHOUT requiring the ack-outbox eligibility
// gate (classification==="managed" + full Flu enrollment-identity binding) — this receipt ledger has
// no such gate (scpCreatorPipelineV3Receiver.ts writes effectState:"done"+receipt for every
// submission, regardless of classification). Same function, same behavior — export only.
//
// W63 [실측 2026-08-10]: 이 함수는 **다섯 개의 서로 다른 사실**을 전부 null 로 접고 있었다 —
//   포인터 문서 부재 · lastEventId 부재 · evt 문서 부재 · effectState!=="done" · 영수증 필드 결손.
//   앞의 넷은 영수증이 생길 수 없는 상태(결정적)이고 effectState 만 진행 중일 수 있는데, 호출부는
//   전부 `no_intake_material` 하나로 받아 **영구 실패를 영원히 재시도**했다(관리 문서 70건 전건이
//   포인터 부재, attempts 5~17회). 사실을 되돌려 주는 상세 로더를 추가한다 — 기존 함수는 그대로 둔다.
// 하위 사유 열거의 정본은 리프 모듈(applicationInitialAudienceCountry)이 소유한다 —
// 같은 목록을 두 파일에 복제하면 종결 판정과 사유 기록이 서로 다른 사실을 말하게 된다.
export type ManagementAckIntakeMaterialCase = IntakeMaterialCase;

export type ManagementAckIntakeMaterialLookup = {
  readonly material: ManagementAckIntakeMaterialSnapshot | null;
  readonly intakeCase: ManagementAckIntakeMaterialCase;
};

export async function loadManagementAckIntakeMaterialDetailed(
  db: FirebaseFirestore.Firestore,
  applicationId: string,
): Promise<ManagementAckIntakeMaterialLookup> {
  const appRef = db.collection(CREATOR_PIPELINE_V3_RECEIPTS_COLLECTION).doc(`app:${receiptsDocId(applicationId)}`);
  const appSnap = await appRef.get();
  if (!appSnap.exists) return { material: null, intakeCase: "app_pointer_absent" };
  const lastEventId = asString(appSnap.data()?.lastEventId);
  if (!lastEventId) return { material: null, intakeCase: "last_event_id_absent" };

  const eventRef = db.collection(CREATOR_PIPELINE_V3_RECEIPTS_COLLECTION).doc(`evt:${receiptsDocId(lastEventId)}`);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) return { material: null, intakeCase: "event_absent" };
  const eventData = eventSnap.data() ?? {};
  // 진행 중일 수 있는 유일한 사유다 — 여기만 재시도가 정당하다.
  if (asString(eventData.effectState) !== "done") return { material: null, intakeCase: "effect_state_pending" };

  const receipt = asRecord(eventData.receipt);
  const materialEventId = asString(receipt.eventId) || asString(eventData.eventId);
  const materialHash = asString(receipt.materialHash);
  const applicationRevisionRaw = receipt.applicationRevision ?? eventData.applicationRevision;
  const applicationRevision = typeof applicationRevisionRaw === "number" ? applicationRevisionRaw : NaN;

  if (!isNonEmptyString(materialEventId) || !isNonEmptyString(materialHash) || !isPositiveInteger(applicationRevision)) {
    return { material: null, intakeCase: "receipt_fields_malformed" };
  }
  return { material: { materialEventId, materialHash, applicationRevision }, intakeCase: "resolvable" };
}

export async function loadManagementAckIntakeMaterial(
  db: FirebaseFirestore.Firestore,
  applicationId: string,
): Promise<ManagementAckIntakeMaterialSnapshot | null> {
  return (await loadManagementAckIntakeMaterialDetailed(db, applicationId)).material;
}

// ---- orchestration --------------------------------------------------------------------------------

export type EnqueueManagementAckForApplicationOptions = Readonly<{
  firestore?: FirebaseFirestore.Firestore;
  now?: Date;
  policyVersion?: string;
}>;

/**
 * Fail-closed, non-throwing orchestration: loads the existing management record, the existing
 * intake-receipt material, and the existing enrollment binding; builds the snapshot; delegates to
 * `enqueueManagementAck` (which re-checks eligibility itself). Safe to call fire-and-forget from a
 * managed-transition call-site — every failure mode returns `{ enqueued: false, reason }`, never
 * throws.
 */
export async function enqueueManagementAckForApplication(
  applicationId: string,
  options: EnqueueManagementAckForApplicationOptions = {},
): Promise<{ enqueued: boolean; reason?: string }> {
  if (!isNonEmptyString(applicationId)) {
    return { enqueued: false, reason: "invalid_application_id" };
  }
  const db = options.firestore ?? adminDb;
  const now = options.now ?? new Date();
  const policyVersion = options.policyVersion ?? MANAGEMENT_ACK_WIRING_POLICY_VERSION;

  let managementData: Record<string, unknown>;
  try {
    const managementDoc = await db
      .collection(SCP_APPLICATION_MANAGEMENT_COLLECTION)
      .doc(managementRecordDocId(applicationId))
      .get();
    if (!managementDoc.exists) return { enqueued: false, reason: "not_managed" };
    managementData = managementDoc.data() ?? {};
  } catch {
    return { enqueued: false, reason: "error" };
  }

  const classification = asString(managementData.classification);
  if (classification !== "managed") return { enqueued: false, reason: "not_managed" };

  const identity = asRecord(managementData.identity);
  const revision = typeof managementData.sourceRevision === "number" ? managementData.sourceRevision : NaN;
  if (!isPositiveInteger(revision)) return { enqueued: false, reason: "not_managed" };

  const managementRecord: ManagementAckManagementRecordSnapshot = {
    applicationId,
    traceId: asString(managementData.traceId) || null,
    portalCreatorId: asString(identity.portalCreatorId) || null,
    programId: asString(managementData.currentProgramId) || null,
    campaignId: asString(managementData.currentCampaignId) || null,
    outreachId: asString(identity.outreachId) || null,
  };
  const reasonCode = asString(managementData.reasonCode);
  const assignmentMode: "signed_attribution" | "operator_assigned" =
    reasonCode === "exact_signed_match" ? "signed_attribution" : "operator_assigned";

  let intakeReceipt: ManagementAckIntakeMaterialSnapshot | null;
  try {
    intakeReceipt = await loadManagementAckIntakeMaterial(db, applicationId);
  } catch {
    return { enqueued: false, reason: "error" };
  }
  if (!intakeReceipt) return { enqueued: false, reason: "no_intake_material" };

  const binding = await resolveManagementAckEnrollmentBinding(applicationId, { firestore: db });
  if (!binding) return { enqueued: false, reason: "no_active_binding" };

  const snapshot = buildManagementAckEnqueueInputForApplication({
    managementRecord,
    intakeReceipt,
    binding,
    revision,
    assignmentMode,
    policyVersion,
  });
  if (!snapshot) return { enqueued: false, reason: "ineligible" };

  try {
    return await enqueueManagementAck(snapshot, { firestore: db, now });
  } catch {
    return { enqueued: false, reason: "error" };
  }
}
