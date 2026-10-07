// 티켓(버그 제보·개선 의견) callable 핸들러 — Firestore `tickets` 컬렉션은 Admin SDK 로만 읽고 쓴다.
// 제출은 viewer 이상 누구나, 열람·상태 변경·삭제·재동기화는 admin 이상(서버 최종 검증, AUTH-P0).
// SuperBoard 전달은 부가 기능: 실패해도 제출은 이미 저장돼 있고 Admin 에서 재시도한다.
import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { assertNonGuestAuth, asRecord, makeBehaviorLog, type CallableRequestShape } from "./shared";
import {
  readSuperboardConfig,
  syncTicketToSuperboard,
  SUPERBOARD_REPO,
  SUPERBOARD_SOURCE_APP,
  TICKET_LIST_LIMIT,
  validateTicketId,
  validateTicketStatus,
  validateTicketSubmission,
  type SuperboardSyncResult,
  type TicketKind,
  type TicketStatus,
  type TicketSyncStatus,
} from "./ticketsCore";

const TICKETS_COLLECTION = "tickets";
const ADMIN_ROLES = ["super_admin", "admin"] as const;

export interface TicketRecord {
  id: string;
  kind: TicketKind;
  body: string;
  images: string[];
  logs: string | null;
  authorEmail: string;
  status: TicketStatus;
  createdAtMs: number | null;
  superboardSync: SuperboardSyncResult;
}

function toMillis(value: unknown): number | null {
  const stamp = value as Timestamp | undefined;
  return stamp && typeof stamp.toMillis === "function" ? stamp.toMillis() : null;
}

function readSync(value: unknown): SuperboardSyncResult {
  const record = asRecord(value);
  const status = record.status;
  return {
    status: status === "synced" || status === "failed" || status === "manual" ? (status as TicketSyncStatus) : "pending",
    taskId: typeof record.taskId === "string" ? record.taskId : null,
    ticketKey: typeof record.ticketKey === "string" ? record.ticketKey : null,
    error: typeof record.error === "string" ? record.error : null,
  };
}

function toTicketRecord(id: string, data: Record<string, unknown>): TicketRecord {
  return {
    id,
    kind: data.kind === "idea" ? "idea" : "bug",
    body: typeof data.body === "string" ? data.body : "",
    images: Array.isArray(data.images) ? data.images.filter((v): v is string => typeof v === "string") : [],
    logs: typeof data.logs === "string" ? data.logs : null,
    authorEmail: typeof data.authorEmail === "string" ? data.authorEmail : "",
    status: data.status === "done" ? "done" : "open",
    createdAtMs: toMillis(data.createdAt),
    superboardSync: readSync(data.superboardSync),
  };
}

function notFound(ticketId: string): Error {
  return Object.assign(new Error(`ticket not found: ${ticketId}`), { code: "not-found" });
}

async function runSuperboardSync(ticketId: string, data: Record<string, unknown>): Promise<SuperboardSyncResult> {
  const config = readSuperboardConfig(process.env);
  const record = toTicketRecord(ticketId, data);
  const result = await syncTicketToSuperboard(config, {
    id: ticketId,
    kind: record.kind,
    body: record.body,
    authorEmail: record.authorEmail,
    images: record.images,
    logs: record.logs,
  });
  await adminDb.collection(TICKETS_COLLECTION).doc(ticketId).set(
    {
      deliveryMode: result.status === "synced" ? "github" : "manual",
      superboardSync: { ...result, updatedAt: FieldValue.serverTimestamp() },
    },
    { merge: true },
  );
  return result;
}

export async function submitTicket(request: CallableRequestShape) {
  const ctx = assertNonGuestAuth(request, "tickets.submit");
  const email = (ctx.email ?? "").trim().toLowerCase();
  if (!email) {
    throw Object.assign(new Error("permission-denied: email claim required"), {
      code: "permission-denied",
      behaviorLog: makeBehaviorLog(ctx, "tickets.submit", "denied"),
    });
  }
  const submission = validateTicketSubmission(request.data);
  const ref = adminDb.collection(TICKETS_COLLECTION).doc();
  const doc: Record<string, unknown> = {
    kind: submission.kind,
    body: submission.body,
    ...(submission.images.length ? { images: submission.images } : {}),
    ...(submission.logs ? { logs: submission.logs } : {}),
    authorEmail: email,
    authorUid: ctx.userId,
    status: "open",
    sourceApp: SUPERBOARD_SOURCE_APP,
    repo: SUPERBOARD_REPO,
    deliveryMode: "manual",
    superboardSync: { status: "pending", taskId: null, ticketKey: null, error: null },
    createdAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);
  // 전달 실패는 제출을 되돌리지 않는다 — 상태만 기록하고 Admin 에서 재시도.
  const superboardSync = await runSuperboardSync(ref.id, doc).catch((error): SuperboardSyncResult => ({
    status: "failed",
    taskId: null,
    ticketKey: null,
    error: error instanceof Error ? error.message.slice(0, 300) : String(error),
  }));
  return {
    id: ref.id,
    superboardSync,
    behaviorLog: makeBehaviorLog(ctx, "tickets.submit", "success"),
  };
}

export async function listTickets(request: CallableRequestShape) {
  const ctx = assertNonGuestAuth(request, "tickets.list", ADMIN_ROLES);
  const snapshot = await adminDb
    .collection(TICKETS_COLLECTION)
    .orderBy("createdAt", "desc")
    .limit(TICKET_LIST_LIMIT)
    .get();
  const tickets = snapshot.docs.map((docSnap) => toTicketRecord(docSnap.id, docSnap.data() as Record<string, unknown>));
  return {
    tickets,
    superboardConfigured: readSuperboardConfig(process.env).token !== null,
    behaviorLog: makeBehaviorLog(ctx, "tickets.list", "success"),
  };
}

export async function setTicketStatus(request: CallableRequestShape) {
  const ctx = assertNonGuestAuth(request, "tickets.setStatus", ADMIN_ROLES);
  const data = asRecord(request.data);
  const ticketId = validateTicketId(data.ticketId);
  const status = validateTicketStatus(data.status);
  const ref = adminDb.collection(TICKETS_COLLECTION).doc(ticketId);
  const snap = await ref.get();
  if (!snap.exists) throw notFound(ticketId);
  // 상태만 바뀐다 — 본문·이미지·작성자는 서버에서도 손대지 않는다.
  await ref.set({ status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { id: ticketId, status, behaviorLog: makeBehaviorLog(ctx, "tickets.setStatus", "success") };
}

export async function deleteTicket(request: CallableRequestShape) {
  const ctx = assertNonGuestAuth(request, "tickets.delete", ADMIN_ROLES);
  const ticketId = validateTicketId(asRecord(request.data).ticketId);
  const ref = adminDb.collection(TICKETS_COLLECTION).doc(ticketId);
  const snap = await ref.get();
  if (!snap.exists) throw notFound(ticketId);
  // 완료된 티켓만 지운다 — 처리 전 제보가 실수로 사라지면 복구할 곳이 없다.
  if ((snap.data() as Record<string, unknown>).status !== "done") {
    throw Object.assign(new Error("failed-precondition: only done tickets can be deleted"), {
      code: "failed-precondition",
      behaviorLog: makeBehaviorLog(ctx, "tickets.delete", "denied"),
    });
  }
  await ref.delete();
  return { id: ticketId, deleted: true, behaviorLog: makeBehaviorLog(ctx, "tickets.delete", "success") };
}

export async function retryTicketSuperboardSync(request: CallableRequestShape) {
  const ctx = assertNonGuestAuth(request, "tickets.retrySuperboardSync", ADMIN_ROLES);
  const ticketId = validateTicketId(asRecord(request.data).ticketId);
  const snap = await adminDb.collection(TICKETS_COLLECTION).doc(ticketId).get();
  if (!snap.exists) throw notFound(ticketId);
  const current = readSync((snap.data() as Record<string, unknown>).superboardSync);
  // 이미 태스크가 만들어진 티켓은 다시 만들지 않는다(중복 방지).
  if (current.status === "synced" && current.taskId) {
    return { id: ticketId, superboardSync: current, behaviorLog: makeBehaviorLog(ctx, "tickets.retrySuperboardSync", "cache_hit") };
  }
  const superboardSync = await runSuperboardSync(ticketId, snap.data() as Record<string, unknown>);
  return {
    id: ticketId,
    superboardSync,
    behaviorLog: makeBehaviorLog(ctx, "tickets.retrySuperboardSync", superboardSync.status === "failed" ? "error" : "success"),
  };
}
