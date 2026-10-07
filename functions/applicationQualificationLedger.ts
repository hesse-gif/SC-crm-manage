// Task-95 §2 원장 — application_qualification_decisions (applicationId 기반). 기존
// qualification_decisions(qualificationJudgeService.ts, leadId + Sheet2 리드 전용)와 완전히
// 별개 컬렉션·별개 파일이다 — 이름과 키 축이 겹치지 않게 의도적으로 분리했다.
//
// append-only: transaction.create() 의 결정적 doc id 로 중복 판정을 막는다(§2 "create semantics
// blocks duplicates"). 원장 기록과 scp_application_management 의 qualification 마커는 같은
// 트랜잭션 안에서 쓴다 — 둘이 갈라지면 /flu/manage/applications 배지가 원장과 어긋난다.
//
// updatedAtIso/updatedAt 은 일부러 건드리지 않는다 — scpCreatorPipelineV3ManagementAckStore.ts의
// declaredAudienceCountry 백필과 같은 관례: 이 컬렉션의 updatedAtIso 는 "사용자 활동" 신호로
// 소비하는 다른 코드가 있어, 자동화 쓰기가 그걸 흔들면 안 된다.
// 예외: applicationQualificationRejudge.ts 는 창 밖 문서를 스윕 스캔 창으로 되돌리려고
// updatedAtIso 를 명시적으로 갱신한다(재판정 대상을 실제로 업데이트하는 정직한 신호).

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, assertNonGuestAuth, asString, makeBehaviorLog, type CallableRequestShape, type Role } from "./shared";
import { SCP_APPLICATION_MANAGEMENT_COLLECTION } from "./applicationManagementStore";
import type { ApplicationEligibilityJudgeResult } from "./applicationEligibilityJudge";

export const APPLICATION_QUALIFICATION_DECISIONS_COLLECTION = "application_qualification_decisions";
export const APPLICATION_QUALIFICATION_LEDGER_VERSION = "application_qualification_ledger.v1" as const;

const OPERATOR_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin", "manager"];

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

export function sanitizeApplicationId(applicationId: string): string {
  const safe = String(applicationId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
  if (!safe) throw invalidArgument("applicationId is required");
  return safe;
}

// 일반 경로는 언제나 1 — 트리거(applicationEligibilityJudgeSweep.ts)가 관리 레코드의 qualification
// 마커를 먼저 확인해 이미 판정된 신청은 재실행하지 않는다. 수동 재판정(applicationQualificationRejudge.ts)
// 은 최신 seq + 1 로 새 결정 문서를 만들어 이전 결정을 지우지 않고 원장 이력을 보존한다.
export const INITIAL_QUALIFICATION_DECISION_SEQ = 1;

// 판정에 쓰인 channelId 의 출처 — identity.channelId(기존 OAuth 검증 경로) 와
// declaredIdentity(channelUrl/handle 자가신고 폴백) 를 원장 evidence 에서 구분한다.
// declaredIdentity 출처는 자가신고 값이므로 판정 근거의 신뢰 등급이 다르다(운영 추적용).
export type ApplicationChannelIdSource = "identity" | "declared_identity";

export function applicationQualificationDecisionDocId(applicationId: string, seq: number): string {
  return `${sanitizeApplicationId(applicationId)}__${seq}`;
}

export type ApplicationQualificationDecisionApplied = boolean | "undone";

export interface ApplicationQualificationDecisionRecord {
  applicationId: string;
  verdict: ApplicationEligibilityJudgeResult["verdict"];
  reasonCode: ApplicationEligibilityJudgeResult["reasonCode"];
  evidence: {
    subscriberCount: number | null;
    lookupStatus: string;
    channelId: string | null;
    // channelId 가 있을 때만 — 어느 신원 필드에서 해소됐는지(위 ApplicationChannelIdSource 주석).
    channelIdSource?: ApplicationChannelIdSource;
    checkedAtIso: string;
  };
  minimumSubscribers: number;
  judgedAtIso: string;
  applied: ApplicationQualificationDecisionApplied;
  appliedCommand?: string;
  appliedAtIso?: string;
  actorType: "ai";
  undo?: { requestedAtIso: string; by: string };
  // 수동 재판정(applicationQualificationRejudge.ts)으로 만들어진 결정에만 붙는 감사 꼬리표 —
  // 판정 자체는 여전히 판정 코어(actorType:"ai")가 내리고, 누가 재판정을 시켰는지만 기록한다.
  // 직전 결정 문서에는 같은 트랜잭션에서 rejudged{requestedAtIso,by,supersededBy} 가 함께 새긴다.
  rejudged?: { by: string; fromDecisionRef: string | null; requestedAtIso: string };
}

export interface RecordApplicationQualificationDecisionInput {
  applicationId: string;
  judge: ApplicationEligibilityJudgeResult;
  channelId: string | null;
  channelIdSource?: ApplicationChannelIdSource;
  now: Date;
  // 기본 INITIAL_QUALIFICATION_DECISION_SEQ — 재판정은 직전 결정을 덮어쓰지 않고 다음 seq 에 쓴다.
  decisionSeq?: number;
  rejudged?: { by: string; fromDecisionRef: string | null };
  // 테스트 대역 주입용 — 생략하면 adminDb(기존 동작 그대로).
  firestore?: FirebaseFirestore.Firestore;
}

export interface RecordApplicationQualificationDecisionResult {
  status: "written" | "idempotent";
  decisionRef: string;
  record: ApplicationQualificationDecisionRecord | null;
}

export async function recordApplicationQualificationDecision(
  input: RecordApplicationQualificationDecisionInput,
): Promise<RecordApplicationQualificationDecisionResult> {
  const applicationId = sanitizeApplicationId(input.applicationId);
  const db = input.firestore ?? adminDb;
  const decisionSeq = Number.isInteger(input.decisionSeq) && (input.decisionSeq ?? 0) >= INITIAL_QUALIFICATION_DECISION_SEQ
    ? input.decisionSeq as number
    : INITIAL_QUALIFICATION_DECISION_SEQ;
  const decisionId = applicationQualificationDecisionDocId(applicationId, decisionSeq);
  const decisionRef = db.collection(APPLICATION_QUALIFICATION_DECISIONS_COLLECTION).doc(decisionId);
  const managementRef = db.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).doc(applicationId);
  const nowIso = input.now.toISOString();

  const record: ApplicationQualificationDecisionRecord = {
    applicationId,
    verdict: input.judge.verdict,
    reasonCode: input.judge.reasonCode,
    evidence: {
      subscriberCount: input.judge.evidence.subscriberCount,
      lookupStatus: input.judge.evidence.lookupStatus,
      channelId: input.channelId,
      ...(input.channelIdSource ? { channelIdSource: input.channelIdSource } : {}),
      checkedAtIso: nowIso,
    },
    minimumSubscribers: input.judge.evidence.minimumSubscribers,
    judgedAtIso: nowIso,
    applied: false,
    actorType: "ai",
    ...(input.rejudged
      ? { rejudged: { by: input.rejudged.by, fromDecisionRef: input.rejudged.fromDecisionRef, requestedAtIso: nowIso } }
      : {}),
  };

  // 재판정이면 직전 결정 문서에 superseded 주석을 같은 트랜잭션으로 새긴다 — Firestore 트랜잭션은
  // 모든 read 가 write 보다 먼저여야 하므로 두 문서 읽기를 먼저 끝낸다.
  const priorDecisionRef = input.rejudged?.fromDecisionRef ? db.doc(input.rejudged.fromDecisionRef) : null;

  const written = await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(decisionRef);
    if (existing.exists) return false;
    const priorSnap = priorDecisionRef ? await transaction.get(priorDecisionRef) : null;
    transaction.create(decisionRef, {
      ...record,
      version: APPLICATION_QUALIFICATION_LEDGER_VERSION,
      createdAt: FieldValue.serverTimestamp(),
    });
    // /flu/manage/applications 배지용 마커. merge:true — 관리 레코드의 다른 필드는 건드리지 않는다.
    transaction.set(managementRef, {
      qualification: {
        verdict: record.verdict,
        reasonCode: record.reasonCode,
        judgedAtIso: nowIso,
        decisionRef: decisionRef.path,
      },
    }, { merge: true });
    if (priorSnap?.exists) {
      transaction.set(priorDecisionRef!, {
        rejudged: { requestedAtIso: nowIso, by: input.rejudged!.by, supersededBy: decisionRef.path },
      }, { merge: true });
    }
    return true;
  });

  return {
    status: written ? "written" : "idempotent",
    decisionRef: decisionRef.path,
    record: written ? record : null,
  };
}

// 자동 반려가 실제로 브리지에 적용됐을 때만 호출한다(applicationEligibilityJudgeSweep.ts).
// 원장 문서는 이미 create() 로 존재하므로 여기는 set(merge:true) — 두 번째 쓰기.
// decisionSeq 는 그 판정이 기록된 문서와 같은 seq 여야 한다 — 재판정(seq>=2)이 자동 반려되면
// 새 문서 쪽에 applied 를 새겨야 최초 결정(__1)이 오염되지 않는다.
export async function markApplicationQualificationDecisionApplied(
  applicationId: string,
  appliedCommand: string,
  now: Date,
  decisionSeq: number = INITIAL_QUALIFICATION_DECISION_SEQ,
  firestore?: FirebaseFirestore.Firestore,
): Promise<void> {
  const safeId = sanitizeApplicationId(applicationId);
  const decisionRef = (firestore ?? adminDb)
    .collection(APPLICATION_QUALIFICATION_DECISIONS_COLLECTION)
    .doc(applicationQualificationDecisionDocId(safeId, decisionSeq));
  await decisionRef.set({
    applied: true,
    appliedCommand,
    appliedAtIso: now.toISOString(),
  }, { merge: true });
}

export interface LatestApplicationQualificationDecision {
  seq: number;
  ref: string;
  reasonCode: string | null;
}

// 수동 재판정(applicationQualificationRejudge.ts)이 다음 seq 를 정하고 직전 결정을 superseded 로
// 주석 달 때 쓰는 최신 결정 조회 — doc id 접미사가 곧 seq 다(`${applicationId}__${seq}`).
export async function latestApplicationQualificationDecision(
  applicationId: string,
  firestore?: FirebaseFirestore.Firestore,
): Promise<LatestApplicationQualificationDecision | null> {
  const safeId = sanitizeApplicationId(applicationId);
  const db = firestore ?? adminDb;
  const snapshot = await db
    .collection(APPLICATION_QUALIFICATION_DECISIONS_COLLECTION)
    .where("applicationId", "==", safeId)
    .get();
  let latest: LatestApplicationQualificationDecision | null = null;
  for (const doc of snapshot.docs) {
    const seq = Number(doc.id.split("__").at(-1));
    if (!Number.isInteger(seq)) continue;
    if (!latest || seq > latest.seq) {
      const reasonCode = doc.data().reasonCode;
      latest = {
        seq,
        ref: doc.ref.path,
        reasonCode: typeof reasonCode === "string" ? reasonCode : null,
      };
    }
  }
  return latest;
}

export type UndoApplicationQualificationDecisionStatus = "undone" | "not_found" | "already_undone";

export interface UndoApplicationQualificationDecisionResult {
  status: UndoApplicationQualificationDecisionStatus;
  decisionRef: string;
}

// Task-95 §4 undo — record-only. 포털 admin-bridge 에는 application.reopen 커맨드가 없다
// (TICKET-MAP §3 결정 #11) — 이 함수는 반려를 실제로 되돌리지 않고, 운영자가 "이 자동 반려를
// 취소 요청했다"는 감사 기록만 남긴다. 실제 되돌림은 포털 수동 처리 또는 향후 브리지 커맨드 추가.
export async function undoApplicationQualificationDecision(input: {
  applicationId: string;
  by: string;
  now: Date;
  // 테스트 대역 주입용 — 생략하면 adminDb(기존 동작 그대로).
  firestore?: FirebaseFirestore.Firestore;
}): Promise<UndoApplicationQualificationDecisionResult> {
  const applicationId = sanitizeApplicationId(input.applicationId);
  const db = input.firestore ?? adminDb;
  // 최신 결정에 undo 주석을 단다 — 수동 재판정(applicationQualificationRejudge.ts) 이후에는
  // 살아 있는 결정이 __1 이 아니라 최신 seq 다. __1 에 주석을 달면 이미 superseded 된 옛
  // 결정만 오염시킨다(적대적 리뷰 F3). 미판정 문서는 latest 가 없어 종전과 동일하게 not_found.
  const latest = await latestApplicationQualificationDecision(applicationId, db);
  const decisionRef = latest
    ? db.doc(latest.ref)
    : db
      .collection(APPLICATION_QUALIFICATION_DECISIONS_COLLECTION)
      .doc(applicationQualificationDecisionDocId(applicationId, INITIAL_QUALIFICATION_DECISION_SEQ));
  const nowIso = input.now.toISOString();

  const status = await db.runTransaction(async (transaction): Promise<UndoApplicationQualificationDecisionStatus> => {
    const snap = await transaction.get(decisionRef);
    if (!snap.exists) return "not_found";
    const data = snap.data() ?? {};
    if (data.applied === "undone") return "already_undone";
    transaction.set(decisionRef, {
      applied: "undone",
      undo: { requestedAtIso: nowIso, by: input.by },
    }, { merge: true });
    return "undone";
  });

  return { status, decisionRef: decisionRef.path };
}

export async function undoApplicationQualificationDecisionHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "application_qualification.undo", OPERATOR_ROLES);
  const data = asRecord(request.data);
  const applicationId = asString(data.applicationId);
  if (!applicationId) throw invalidArgument("applicationId is required");
  const result = await undoApplicationQualificationDecision({ applicationId, by: auth.userId, now: new Date() });
  return { ...result, behaviorLog: makeBehaviorLog(auth, "application_qualification.undo", "success") };
}
