import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { resolveConversationScope } from "./conversationScope";
import { canReadConversationRowForScope, resolveConversationMailAccessScope } from "./conversationMailAccessScope";
import { cancelQueuedAutoRepliesForHumanTakeover } from "./chat-ai";
import { asRecord, asString, assertNonGuestAuth, makeBehaviorLog } from "./shared";
import { projectScpApprovedFeed, type ScpApprovedFeedProjectionResult } from "./scpApprovedFeed";
import type { CallableRequestShape } from "./shared";

type WorkflowEntity =
  | "conversation"
  | "campaign"
  | "program"
  | "programApplication"
  | "creator"
  | "contract"
  | "review"
  | "submission"
  | "candidate"
  | "candidatePool"
  | "escalation"
  | "video"
  | "communityPost";

type WorkflowAction = "archive" | "delete" | "request_human" | "restore";

const COLLECTION_BY_ENTITY: Record<WorkflowEntity, string> = {
  conversation: "conversations",
  campaign: "campaigns",
  program: "programs",
  programApplication: "program_applications",
  creator: "creators",
  contract: "contracts",
  review: "reviews",
  submission: "submissions",
  candidate: "rec_candidates",
  candidatePool: "candidate_pool",
  escalation: "escalations",
  video: "videos",
  communityPost: "community_posts",
};

const ACTION_LABEL: Record<WorkflowAction, string> = {
  archive: "보관",
  delete: "삭제",
  request_human: "사람 개입",
  restore: "복구",
};

function isWorkflowEntity(value: unknown): value is WorkflowEntity {
  return (
    value === "conversation" ||
    value === "campaign" ||
    value === "program" ||
    value === "programApplication" ||
    value === "creator" ||
    value === "contract" ||
    value === "review" ||
    value === "submission" ||
    value === "candidate" ||
    value === "candidatePool" ||
    value === "escalation" ||
    value === "video" ||
    value === "communityPost"
  );
}

function isWorkflowAction(value: unknown): value is WorkflowAction {
  return value === "archive" || value === "delete" || value === "request_human" || value === "restore";
}

function isProtectedEntity(entity: WorkflowEntity, id: string, current: Record<string, unknown>): boolean {
  if (current.protected === true) return true;
  if (entity === "conversation" && id === "v-hesse") return true;
  if (entity === "creator" && id === "rc-hesse") return true;
  return false;
}

function manualInterventionRef(entity: WorkflowEntity, id: string, requestedAtIso: string) {
  const safeId = `${entity}_${id}_${requestedAtIso}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 150);
  return adminDb.collection("manual_interventions").doc(safeId);
}

export async function updateWorkflowItemState(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "workflow.item.update", ["super_admin", "admin", "manager"]);
  const data = asRecord(request.data);
  const entity = isWorkflowEntity(data.entity) ? data.entity : undefined;
  const action = isWorkflowAction(data.action) ? data.action : undefined;
  const id = asString(data.id);
  const reason = asString(data.reason, "manual_override");
  const gameId = asString(data.gameId, auth.gameId);
  if (!entity || !action || !id) {
    const error = new Error("invalid-argument: entity, id, action are required");
    Object.assign(error, { code: "invalid-argument", errorCode: "update_workflow_item_state_entity_id_action_required", behaviorLog: makeBehaviorLog(auth, "workflow.item.update", "error", gameId) });
    throw error;
  }

  const collectionName = COLLECTION_BY_ENTITY[entity];
  const itemRef = adminDb.collection(collectionName).doc(id);
  const snapshot = await itemRef.get();
  const current = snapshot.exists ? snapshot.data() ?? {} : {};
  const protectedEntity = isProtectedEntity(entity, id, current);
  const nowIso = new Date().toISOString();

  // Flu conversation org-filter round 14 (codex adversarial review round 14, finding #1):
  // updateWorkflowItemState mutated (archived/deleted/restored) any caller-supplied conversation id
  // with no mailbox/org authorization at all — only assertNonGuestAuth's role check. archive/
  // delete/restore write itemRef directly (no thread bundling), so the existing single-doc fetch
  // above is the authorization-relevant target here; request_human's own (possibly multi-doc)
  // targets are checked separately below, against conversationScope.scopedSnapshots.
  const accessScope = entity === "conversation" ? await resolveConversationMailAccessScope(auth) : null;
  if (
    entity === "conversation" && action !== "request_human" && snapshot.exists && accessScope &&
    !canReadConversationRowForScope({ id, ...current }, accessScope)
  ) {
    const error = new Error("permission-denied: conversation belongs to another mail account/org");
    Object.assign(error, {
      code: "permission-denied",
      errorCode: "update_workflow_item_state_conversation_scope_denied",
      behaviorLog: makeBehaviorLog(auth, "workflow.item.update", "denied", gameId),
    });
    throw error;
  }

  if (protectedEntity && (action === "archive" || action === "delete")) {
    return {
      ok: false,
      blocked: true,
      entity,
      id,
      action,
      reason: "protected_test_record",
      message: "보호된 테스트 레코드는 보관/삭제하지 않습니다.",
      behaviorLog: makeBehaviorLog(auth, "workflow.item.update.blocked", "blocked", gameId),
    };
  }

  const basePatch = {
    updatedAtIso: nowIso,
    updatedBy: auth.userId,
    lastManualAction: {
      action,
      label: ACTION_LABEL[action],
      reason,
      at: nowIso,
      by: auth.userId,
    },
  };

  const patch: Record<string, unknown> =
    action === "archive"
      ? {
          ...basePatch,
          archivedAt: nowIso,
          archivedBy: auth.userId,
          archiveReason: reason,
        }
      : action === "delete"
        ? {
            ...basePatch,
            deletedAt: nowIso,
            deletedBy: auth.userId,
            deletionReason: reason,
            deletionMode: "soft_delete",
          }
        : action === "restore"
          ? {
              ...basePatch,
              archivedAt: FieldValue.delete(),
              archivedBy: FieldValue.delete(),
              archiveReason: FieldValue.delete(),
              deletedAt: FieldValue.delete(),
              deletedBy: FieldValue.delete(),
              deletionReason: FieldValue.delete(),
              deletionMode: FieldValue.delete(),
            }
          : {
              ...basePatch,
              aiActive: false,
              humanGate: "needs_review",
              manualIntervention: {
                status: "open",
                reason,
                requestedAt: nowIso,
                requestedBy: auth.userId,
              },
              alert: asString(current.alert, "") || "사람 개입 요청됨 — 자동 처리를 중단하고 담당자 검토가 필요합니다.",
            };

  let scpApprovedFeed: ScpApprovedFeedProjectionResult | undefined;
  if (entity === "submission" && (action === "archive" || action === "delete" || action === "restore")) {
    scpApprovedFeed = await adminDb.runTransaction(async (transaction) => {
      const transactionSnapshot = await transaction.get(itemRef);
      const transactionCurrent = transactionSnapshot.exists ? transactionSnapshot.data() ?? {} : {};
      if (isProtectedEntity(entity, id, transactionCurrent)) {
        const error = new Error("failed-precondition: protected test record cannot be hidden");
        Object.assign(error, { code: "failed-precondition", errorCode: "update_workflow_item_state_protected_test_record_cannot_be", behaviorLog: makeBehaviorLog(auth, "workflow.item.update.blocked", "blocked", gameId) });
        throw error;
      }


      const projectedSubmission: Record<string, unknown> = {
        ...transactionCurrent,
        ...basePatch,
      };
      if (action === "archive") {
        projectedSubmission.archivedAt = nowIso;
        projectedSubmission.archivedBy = auth.userId;
        projectedSubmission.archiveReason = reason;
      } else if (action === "delete") {
        projectedSubmission.deletedAt = nowIso;
        projectedSubmission.deletedBy = auth.userId;
        projectedSubmission.deletionReason = reason;
        projectedSubmission.deletionMode = "soft_delete";
      } else {
        delete projectedSubmission.archivedAt;
        delete projectedSubmission.archivedAtIso;
        delete projectedSubmission.archivedBy;
        delete projectedSubmission.archiveReason;
        delete projectedSubmission.deletedAt;
        delete projectedSubmission.deletedAtIso;
        delete projectedSubmission.deletedBy;
        delete projectedSubmission.deletionReason;
        delete projectedSubmission.deletionMode;
      }

      const projection = await projectScpApprovedFeed({
        transaction,
        submissionId: id,
        submissionRef: itemRef,
        submission: projectedSubmission,
        reviewStatus: asString(projectedSubmission.reviewStatus),
        previousReviewStatus: asString(transactionCurrent.reviewStatus),
        archivedAtIso: nowIso,
      });
      transaction.set(itemRef, patch, { merge: true });
      return projection;
    });

    return {
      ok: true,
      entity,
      id,
      action,
      itemRef: itemRef.path,
      itemRefs: [itemRef.path],
      scpApprovedFeed,
      hidden: action === "archive" || action === "delete",
      behaviorLog: makeBehaviorLog(auth, `workflow.item.${action}`, "success", gameId),
    };
  }
  const batch = adminDb.batch();
  const conversationScope = entity === "conversation" && action === "request_human"
    ? await resolveConversationScope({ ...data, conversationId: id }, id, { maxTargets: 20, fallbackToCanonicalRef: false })
    : null;
  if (conversationScope && conversationScope.targetRefs.length === 0) {
    const error = new Error("not-found: no existing conversation in the requested thread context");
    Object.assign(error, { code: "not-found", errorCode: "update_workflow_item_state_existing_conversation_in_requested_thread", behaviorLog: makeBehaviorLog(auth, "workflow.item.update", "error", gameId) });
    throw error;
  }
  // Flu conversation org-filter round 14: request_human's real write targets are
  // conversationScope.scopedSnapshots (fallbackToCanonicalRef is false above, so targetRefs is
  // exactly scopedSnapshots' refs) — a thread can bundle more than one document, any of which may
  // belong to another org/mailbox even when the caller-supplied id itself passed the check above.
  // Deny the whole request if any bundled target is unauthorized; no partial writes.
  if (conversationScope && accessScope) {
    const unauthorizedTarget = conversationScope.scopedSnapshots.find(
      (snap) => !canReadConversationRowForScope({ id: snap.id, ...(snap.data() ?? {}) }, accessScope),
    );
    if (unauthorizedTarget) {
      const error = new Error("permission-denied: conversation belongs to another mail account/org");
      Object.assign(error, {
        code: "permission-denied",
        errorCode: "update_workflow_item_state_conversation_scope_denied",
        behaviorLog: makeBehaviorLog(auth, "workflow.item.update", "denied", gameId),
      });
      throw error;
    }
  }
  const targetRefs = conversationScope ? conversationScope.targetRefs : [itemRef];
  for (const targetRef of targetRefs) {
    batch.set(targetRef, patch, { merge: true });
  }

  let interventionPath: string | undefined;
  if (action === "request_human") {
    for (const targetRef of targetRefs) {
      const intervention = manualInterventionRef(entity, targetRef.id, nowIso);
      interventionPath = interventionPath ?? intervention.path;
      batch.set(intervention, {
        id: intervention.id,
        entity,
        entityId: targetRef.id,
        entityRef: targetRef.path,
        reason,
        status: "open",
        requestedAtIso: nowIso,
        requestedBy: auth.userId,
        team: auth.team,
        gameId,
      }, { merge: true });
    }
  }

  await batch.commit();

  // FIX (P0): 대화 사람 개입 시, 예약된 자동회신을 취소해 인계 후 자동 발송을 막는다.
  let cancelledAutoReplies = 0;
  if (entity === "conversation" && action === "request_human") {
    for (const targetRef of targetRefs) {
      cancelledAutoReplies += await cancelQueuedAutoRepliesForHumanTakeover(
        { ...data, conversationId: targetRef.id },
        targetRef.id,
        reason,
        nowIso,
      );
    }
  }

  return {
    ok: true,
    entity,
    id,
    action,
    itemRef: itemRef.path,
    itemRefs: targetRefs.map((ref) => ref.path),
    threadId: conversationScope?.threadId,
    contextKey: conversationScope?.contextKey,
    interventionRef: interventionPath,
    ...(entity === "conversation" && action === "request_human" ? { cancelledAutoReplies } : {}),
    hidden: action === "archive" || action === "delete",
    behaviorLog: makeBehaviorLog(auth, `workflow.item.${action}`, "success", gameId),
  };
}
