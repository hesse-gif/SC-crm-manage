// Flu/Task-37 — 최소 원장(ledger): scpDashboardSnapshotDelivery(P1-FLU-PRODUCER, `/api/internal/
// flu/v1/dashboard-snapshots` = Portal persistFluDashboardIngest/persistFluDashboardObservation)
// 송신 결과를 크리에이터 단위로 기록한다.
//
// 확인된 사실: 이 파일 작성 시점 기준, `deliverDashboardObservation` 을 실제로 호출하는 프로덕션
// 트리거(스케줄러/콜러블)가 아직 없다(`assembleProducerSnapshot()` 은 미해결 소스 필드 때문에
// 항상 fail-closed — functions/scpDashboardSnapshotSources.ts). 즉 오늘 기준 이 원장은 비어
// 있는 것이 정상이다. 원장은 그 자체가 이 티켓의 답(왜 ingest 가 없는가)이 아니라, 프로듀서
// 파이프라인이 언젠가 배선될 때 "성공/실패+사유+시각"을 남길 장소를 지금 만들어 두는 것이다.
//
// 이 파일은 `deliverDashboardObservation`(HMAC 서명 등 이미 검증된 순수 전송 로직)을 건드리지
// 않는다 — 그 함수를 감싸는 얇은 래퍼만 추가한다.

import type { Firestore } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  deliverDashboardObservation,
  type DashboardDeliveryResult,
  type DeliverDashboardObservationOptions,
} from "./scpDashboardSnapshotDelivery";

export const SCP_DASHBOARD_INGEST_LEDGER_COLLECTION = "scp_dashboard_ingest_ledger";

export type DashboardIngestLedgerOutcome = DashboardDeliveryResult["outcome"];

export type DashboardIngestLedgerEntry = {
  fluCreatorId: string;
  portalCreatorId: string;
  attemptCount: number;
  lastAttemptAtIso: string;
  lastOutcome: DashboardIngestLedgerOutcome;
  lastHttpStatus: number;
  lastCode: string;
  lastRequestId: string;
  firstSuccessAtIso: string | null;
  lastSuccessAtIso: string | null;
  updatedAtIso: string;
};

function isSuccessOutcome(outcome: DashboardIngestLedgerOutcome): boolean {
  return outcome === "accepted" || outcome === "duplicate";
}

// 시도 1건을 fluCreatorId 문서에 병합 기록한다. firstSuccessAtIso 는 최초 성공 시각을 보존해야
// 하므로(이후 재시도가 없어질 수 있는 정보가 아니다) 트랜잭션으로 읽고 쓴다.
export async function recordDashboardIngestDeliveryAttempt(
  params: {
    fluCreatorId: string;
    portalCreatorId: string;
    result: DashboardDeliveryResult;
  },
  deps: { db?: Firestore; now?: Date } = {},
): Promise<DashboardIngestLedgerEntry> {
  const db = deps.db ?? adminDb;
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const { fluCreatorId, portalCreatorId, result } = params;
  if (!fluCreatorId) throw new Error("recordDashboardIngestDeliveryAttempt: fluCreatorId is required");
  const ref = db.collection(SCP_DASHBOARD_INGEST_LEDGER_COLLECTION).doc(fluCreatorId);
  const succeeded = isSuccessOutcome(result.outcome);
  const httpStatus = result.httpStatus;
  const code = result.code;
  const requestId = result.requestId;

  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    const prior = existing.exists ? (existing.data() as Partial<DashboardIngestLedgerEntry>) : null;
    const entry: DashboardIngestLedgerEntry = {
      fluCreatorId,
      portalCreatorId,
      attemptCount: (prior?.attemptCount ?? 0) + 1,
      lastAttemptAtIso: nowIso,
      lastOutcome: result.outcome,
      lastHttpStatus: httpStatus,
      lastCode: code,
      lastRequestId: requestId,
      firstSuccessAtIso: prior?.firstSuccessAtIso ?? (succeeded ? nowIso : null),
      lastSuccessAtIso: succeeded ? nowIso : (prior?.lastSuccessAtIso ?? null),
      updatedAtIso: nowIso,
    };
    transaction.set(ref, entry, { merge: true });
    // FieldValue.increment 대신 위에서 이미 정수로 계산해 넣었으므로(트랜잭션이 read-then-write를
    // 보장) 별도 increment 호출은 불필요 — 동시성 충돌은 Firestore 트랜잭션 재시도가 처리한다.
    return entry;
  });
}

// `deliverDashboardObservation` 을 호출하고 결과를 원장에 남기는 래퍼. 프로듀서 파이프라인이
// 배선되면(향후 티켓) 이 함수가 실제 송신 경로가 된다 — deliverDashboardObservation 을 직접
// 부르는 새 호출부를 추가하지 말고 이 래퍼를 통해서 부른다.
export async function deliverDashboardObservationAndRecordAttempt(
  options: DeliverDashboardObservationOptions & { fluCreatorId: string; portalCreatorId: string },
  deps: { db?: Firestore; now?: Date } = {},
): Promise<DashboardDeliveryResult> {
  const result = await deliverDashboardObservation(options);
  await recordDashboardIngestDeliveryAttempt(
    { fluCreatorId: options.fluCreatorId, portalCreatorId: options.portalCreatorId, result },
    deps,
  );
  return result;
}

export async function getDashboardIngestLedgerEntries(
  fluCreatorIds: readonly string[],
  db: Firestore = adminDb,
): Promise<Map<string, DashboardIngestLedgerEntry>> {
  const map = new Map<string, DashboardIngestLedgerEntry>();
  const uniqueIds = [...new Set(fluCreatorIds)].filter(Boolean);
  if (uniqueIds.length === 0) return map;
  const refs = uniqueIds.map((id) => db.collection(SCP_DASHBOARD_INGEST_LEDGER_COLLECTION).doc(id));
  const snapshots = await db.getAll(...refs);
  for (const snapshot of snapshots) {
    if (!snapshot.exists) continue;
    map.set(snapshot.id, snapshot.data() as DashboardIngestLedgerEntry);
  }
  return map;
}
