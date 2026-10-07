// Flu/Task-37 — 승인된 SCP 크리에이터 중 Flu ingest(대시보드 스냅샷) 성공 이력이 없는 계정을
// 찾는 읽기 전용 조회. 3-way 조인:
//   1) program_applications (canonicalProgramId=SCP, status="approved") — "승인된 계정" 정본
//      (functions/scpPortalCreatorBinding.ts:assertApplicationAuthority 와 동일 정본).
//   2) scp_portal_creator_bindings — Portal 신원 발행 여부(functions/scpDashboardSnapshotSources.ts
//      가 스냅샷 조립 시 읽는 것과 동일 컬렉션/도큐먼트ID).
//   3) scp_dashboard_ingest_ledger — 실제 송신 시도 이력(functions/scpDashboardIngestLedger.ts).
// PII: program_applications.email/name 원문은 절대 반환하지 않는다 — creators/{fluCreatorId} 를
// resolveCreatorDisplayIdentity 로 통과시켜 표시용 이름/핸들만 낸다(기존 listScpCreatorDirectoryRecords
// 와 동일 패턴).

import { FieldPath, type Firestore } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import { youtubeOAuthPortalBindingDocumentId } from "./youtubeOAuthHandoff";
import { resolveCreatorDisplayIdentity, MAX_PAGE_SIZE } from "./managementProfileTabsReadModels";
import {
  getDashboardIngestLedgerEntries,
  type DashboardIngestLedgerEntry,
} from "./scpDashboardIngestLedger";
import {
  classifyIngestGap,
  INGEST_GAP_REASON_CODES,
  type IngestGapLastAttempt,
  type IngestGapReasonCode,
} from "./scpApprovedIngestGapCore";

// program_applications 스캔 상한 — 오늘 기준 approved 규모는 수백 단위(리스트 API 상한과 별개로
// 승인 전체를 스캔해야 "이력 없음"을 놓치지 않는다). 필요해지면 커서 페이지네이션으로 확장한다.
const APPROVED_SCAN_CAP = 1000;

function asStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export type ScpApprovedWithoutIngestRow = {
  applicationId: string;
  fluCreatorId: string;
  portalCreatorId: string | null;
  creatorDisplayName: string | null;
  creatorHandle: string | null;
  approvedAtIso: string | null;
  bindingActive: boolean;
  reasonCode: IngestGapReasonCode;
  suspectedSheetSyncGap: boolean;
  lastAttempt: IngestGapLastAttempt;
};

export type ScpApprovedWithoutIngestResult = {
  rows: ScpApprovedWithoutIngestRow[];
  scanned: number;
  truncated: boolean;
  countsByReason: Record<IngestGapReasonCode, number>;
  generatedAtIso: string;
};

function emptyCounts(): Record<IngestGapReasonCode, number> {
  return Object.fromEntries(INGEST_GAP_REASON_CODES.map((code) => [code, 0])) as Record<
    IngestGapReasonCode,
    number
  >;
}

export async function listScpApprovedCreatorsWithoutIngest(
  limit = 100,
  db: Firestore = adminDb,
  now: Date = new Date(),
): Promise<ScpApprovedWithoutIngestResult> {
  const cap = Math.max(1, Math.min(limit, MAX_PAGE_SIZE));

  const approvedSnap = await db
    .collection("program_applications")
    .where("canonicalProgramId", "==", SCP_CANONICAL_PROGRAM_ID)
    .where("status", "==", "approved")
    .orderBy(FieldPath.documentId())
    .limit(APPROVED_SCAN_CAP)
    .get();

  type ApprovedApplication = {
    applicationId: string;
    fluCreatorId: string;
    approvedAtIso: string | null;
  };
  const approved: ApprovedApplication[] = [];
  for (const doc of approvedSnap.docs) {
    const data = doc.data();
    const fluCreatorId = asStr(data.creatorId);
    if (!fluCreatorId) continue; // 신원 없는 지원서는 애초에 ingest 대상이 아니다(기록만 남김).
    approved.push({
      applicationId: doc.id,
      fluCreatorId,
      approvedAtIso: asStr(data.qualificationApprovedAtIso) || asStr(data.updatedAtIso) || asStr(data.submittedAtIso) || null,
    });
  }

  const fluCreatorIds = [...new Set(approved.map((a) => a.fluCreatorId))];

  const bindingRefs = fluCreatorIds.map((id) =>
    db.collection("scp_portal_creator_bindings").doc(youtubeOAuthPortalBindingDocumentId(id)),
  );
  const [bindingSnapshots, ledgerByCreator, creatorSnapshots] = await Promise.all([
    bindingRefs.length ? db.getAll(...bindingRefs) : Promise.resolve([]),
    getDashboardIngestLedgerEntries(fluCreatorIds, db),
    fluCreatorIds.length
      ? db.getAll(...fluCreatorIds.map((id) => db.collection("creators").doc(id)))
      : Promise.resolve([]),
  ]);

  const bindingByFluCreatorId = new Map<
    string,
    { active: boolean; portalCreatorId: string | null }
  >();
  for (const snapshot of bindingSnapshots) {
    if (!snapshot.exists) continue;
    const data = snapshot.data() as Record<string, unknown>;
    const fluCreatorId = asStr(data.fluCreatorId);
    if (!fluCreatorId) continue;
    bindingByFluCreatorId.set(fluCreatorId, {
      active: data.status === "active",
      portalCreatorId: asStr(data.portalCreatorId) || null,
    });
  }

  const creatorByFluCreatorId = new Map<string, Record<string, unknown>>();
  for (const snapshot of creatorSnapshots) {
    if (!snapshot.exists) continue;
    creatorByFluCreatorId.set(snapshot.id, (snapshot.data() ?? {}) as Record<string, unknown>);
  }

  const rows: ScpApprovedWithoutIngestRow[] = [];
  const countsByReason = emptyCounts();

  for (const application of approved) {
    const binding = bindingByFluCreatorId.get(application.fluCreatorId) ?? null;
    const ledgerEntry: DashboardIngestLedgerEntry | undefined = ledgerByCreator.get(application.fluCreatorId);
    const lastAttempt: IngestGapLastAttempt = ledgerEntry
      ? {
          outcome: ledgerEntry.lastOutcome,
          atIso: ledgerEntry.lastAttemptAtIso,
          httpStatus: ledgerEntry.lastHttpStatus,
          code: ledgerEntry.lastCode,
          requestId: ledgerEntry.lastRequestId,
        }
      : null;

    const classification = classifyIngestGap({
      bindingActive: binding?.active === true,
      approvedAtIso: application.approvedAtIso,
      lastSuccessAtIso: ledgerEntry?.lastSuccessAtIso ?? null,
      lastAttempt,
    });
    if (!classification) continue; // 성공 이력 있음 — gap 목록에서 제외.

    countsByReason[classification.reasonCode] += 1;

    const creator = creatorByFluCreatorId.get(application.fluCreatorId);
    const displayIdentity = resolveCreatorDisplayIdentity(creator, application.fluCreatorId);

    rows.push({
      applicationId: application.applicationId,
      fluCreatorId: application.fluCreatorId,
      portalCreatorId: binding?.portalCreatorId ?? null,
      creatorDisplayName: displayIdentity.displayName || null,
      creatorHandle: displayIdentity.handle,
      approvedAtIso: application.approvedAtIso,
      bindingActive: binding?.active === true,
      reasonCode: classification.reasonCode,
      suspectedSheetSyncGap: classification.suspectedSheetSyncGap,
      lastAttempt,
    });
  }

  // 오래 방치된 순 — 승인일 오래된 것이 위로.
  rows.sort((a, b) => {
    const aAt = a.approvedAtIso ? Date.parse(a.approvedAtIso) : 0;
    const bAt = b.approvedAtIso ? Date.parse(b.approvedAtIso) : 0;
    return (Number.isFinite(aAt) ? aAt : 0) - (Number.isFinite(bAt) ? bAt : 0);
  });

  const truncated = rows.length > cap || approvedSnap.size >= APPROVED_SCAN_CAP;

  return {
    rows: rows.slice(0, cap),
    scanned: approvedSnap.size,
    truncated,
    countsByReason,
    generatedAtIso: now.toISOString(),
  };
}
