// Portal applicationApproved → onboarding(qualification_pass) 큐잉의 공유 코어.
//
// scpFluApplicationCommand(수신기)와 applicationManagementStore(managed 승격 훅) 양쪽이
// 이 모듈을 import 한다. 주의: 완전한 비순환이 아니다 — 3노드 지연 순환이 존재한다
// (이 모듈 → onboardingOutboxStore → applicationManagementStore → 이 모듈). CJS 는 함수
// 호출 시점 지연 접근이라 오늘은 무해하지만, **이 세 모듈 사이에서 최상위(top-level)
// 상수 상호참조를 추가하면 로드 순서에 따라 undefined 가 된다.** 함수/지연 참조만 둘 것.
//
// 복구 모델(적대 리뷰 C2 처방): 승인 명령 문서의 onboardingEnqueueState 는
// **성공 종결(deny-list) 기준**으로만 닫힌다 — "enqueued" / "already_sent" /
// "dead_letter"(온보딩 레인의 자체 종결) 외의 모든 상태(필드 없음·pending·blocked·
// enqueue_failed)는 재시도 대상이다. 재시도는 스케줄러가 아니라 이벤트로 도착한다:
// 제출 명령 처리 직후 + 관리 레코드의 managed 승격 직후(운영자 배정·아웃박스 역전파).
// gen 예약(아래)과 아웃박스 자체 멱등 덕분에 몇 번을 다시 집어도 폭주하지 않는다.

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { expireAt180DaysFromIso } from "./firestoreTtl";
import { asString } from "./shared";
import { enqueueOnboardingForManagedApplication } from "./onboardingOutboxStore";

export const SCP_APPLICATION_ONBOARDING_FLOW_VERSION = "scp-application-onboarding-v1" as const;
export const FLU_APPLICATION_COMMAND_COLLECTION = "scp_flu_application_commands";
export const FLU_APPLICATION_COMMAND_AUDIT_COLLECTION = "scp_flu_application_command_audit";

export function fluApplicationCommandId(applicationId: string): string {
  return `flu_application_command_${applicationId}_${SCP_APPLICATION_ONBOARDING_FLOW_VERSION}`;
}

// Approval commands live under their own idempotency key so a later approval never collides
// with the submission command stored for the same application. The separation is at the
// *prefix* ("flu_application_approval_command_" vs "flu_application_command_"), NOT inside
// the applicationId segment — the id charset allows "_", so a suffix-style separator could
// be forged by an applicationId ending in it (e.g. "app_approved"). Prefixes cannot.
export function fluApplicationApprovalCommandId(applicationId: string): string {
  return `flu_application_approval_command_${applicationId}_${SCP_APPLICATION_ONBOARDING_FLOW_VERSION}`;
}

// test_send(운영자 테스트 발송)가 sendGeneration 0 을 사용하므로, 실승인 큐잉은 자기
// 세대(1)를 예약해 테스트 행이 실메일 큐 자리를 선점하지 못하게 한다. 재승인은 같은
// 세대를 재사용해 멱등.
export const APPROVAL_ONBOARDING_SEND_GENERATION = 1;

// kind 로 등록된 실제 템플릿 ref 를 핀한다. "templates/onboarding-default" 는 kind 미등록
// ref 라 normalizeKind 가 qualification_pass 로 무성 강등하는 자리였다 — 누가 그 이름을
// 등록하는 순간 코드 변경 없이 동작이 바뀐다(적대 리뷰 M1).
export const APPROVAL_ONBOARDING_TEMPLATE_REF = "templates/qualification_pass";

// 성공 종결 상태(deny-list). 이 셋 외에는 어떤 값이든(필드 부재 포함) 복구 대상이다.
// - already_sent: 세대 무관으로 이미 발송된 온보딩 메일이 있어 중복 발송을 막고 종결.
// - dead_letter: 온보딩 레인 자체의 종결 상태 — 수동 복구 대상이며 자동 재큐잉하지 않는다.
export type ApprovalOnboardingEnqueueState =
  | "enqueued"
  | "already_sent"
  | "dead_letter"
  | "blocked"
  | "pending_enqueue"
  | "pending_application_record"
  | "pending_operator_generation"
  | "enqueue_failed";
const TERMINAL_ENQUEUE_STATES: ReadonlySet<string> = new Set(["enqueued", "already_sent", "dead_letter"]);

// 승인 명령의 온보딩 큐잉 실행기. 감사 기록은 enqueue 성공/실패와 **분리된 자체 try** 로
// 항상 남긴다(LOG-P0-010). 상태는 명령 문서의 onboardingEnqueueState 로 영속돼 복구
// 훅들이 deny-list 로 읽는다.
export async function runApprovalOnboardingEnqueue(
  input: {
    applicationId: string;
    approvedByActorId: string | null;
    commandRef: FirebaseFirestore.DocumentReference;
    duplicate: boolean;
    programId: string;
    trigger: "approval_command" | "submission_recovery" | "managed_promotion";
  },
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  let state: ApprovalOnboardingEnqueueState;
  let reason: string | null = null;
  let idempotent = false;
  try {
    // 운영자 세대(gen 0, test_send) 가드는 enqueue 트랜잭션 **안에서** 원자적으로 평가된다:
    // gen0 이 sent 면 두 번째 실메일을 만들지 않고 종결(already_sent), live(queued/sending/
    // failed)면 드레인이 두 세대를 한 패스에 집는 중복 창을 피해 비종결로 주차했다가 다음
    // 이벤트에서 재평가한다. dead_letter/부재는 정상 큐잉.
    const enqueue = await enqueueOnboardingForManagedApplication(
      {
        applicationId: input.applicationId,
        globalDefaultTemplateRef: APPROVAL_ONBOARDING_TEMPLATE_REF,
        sendGeneration: APPROVAL_ONBOARDING_SEND_GENERATION,
        guardAgainstGeneration: 0,
      },
      now,
    );
    idempotent = enqueue.idempotent === true;
    reason = enqueue.reason ?? null;
    // 멱등 히트는 선행 gen-1 행의 실제 상태를 그대로 보고한다 — dead_letter 를
    // enqueued 로 접으면 "메일이 나갔나"의 유일한 필드가 거짓말한다(적대 리뷰 L1).
    const rowState = enqueue.state;
    state = enqueue.reason === "other_generation_sent"
      ? "already_sent"
      : enqueue.reason === "other_generation_live"
        ? "pending_operator_generation"
        : rowState === "queued" || rowState === "sending" || rowState === "sent"
          ? "enqueued"
          : rowState === "dead_letter"
            ? "dead_letter"
            : rowState === "failed"
              ? "enqueue_failed"
              : enqueue.reason === "application_record_missing"
                ? "pending_application_record"
                : "blocked";
  } catch (error) {
    state = "enqueue_failed";
    // 원문 메시지는 경로·식별자가 섞일 수 있어 코드만 남긴다(4차 리뷰 OQ — PII 축약).
    reason = asString((error as { code?: unknown })?.code) || "unknown_error";
  }
  try {
    await input.commandRef.set(
      {
        onboardingEnqueueState: state,
        onboardingEnqueueReason: reason,
        onboardingEnqueueUpdatedAtIso: nowIso,
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } catch (error) {
    console.warn(
      "[scp-approval-onboarding] state_write_failed",
      JSON.stringify({ applicationId: input.applicationId, error: error instanceof Error ? error.message : "unknown" }),
    );
  }
  try {
    await adminDb.collection(FLU_APPLICATION_COMMAND_AUDIT_COLLECTION).add({
      operation: "application_approved_onboarding_enqueue",
      commandId: input.commandRef.id,
      applicationId: input.applicationId,
      programId: input.programId,
      approvedByActorId: input.approvedByActorId,
      trigger: input.trigger,
      duplicate: input.duplicate,
      idempotent,
      state,
      reason,
      recordedAtIso: nowIso,
      recordedAt: FieldValue.serverTimestamp(),
      expireAt: expireAt180DaysFromIso(nowIso),
    });
  } catch (error) {
    console.warn(
      "[scp-approval-onboarding] audit_write_failed",
      JSON.stringify({ applicationId: input.applicationId, error: error instanceof Error ? error.message : "unknown" }),
    );
  }
}

// 이벤트 주도 복구 훅. 제출 명령 처리 직후와 관리 레코드 managed 승격 직후에 불린다.
// 승인 명령이 없거나 이미 성공 종결이면 no-op. 실패는 로그로만 — 호출부 응답을 뒤집지
// 않는다. 술어는 deny-list 다: 필드가 아예 없는 크래시 창(C2-c)과 동시 도착 lost-update
// (C2-b), blocked 로 접힌 정상 순서(C2-a) 전부가 재시도 대상에 들어온다.
export async function recoverPendingApprovalOnboarding(
  applicationId: string,
  now: Date,
  trigger: "submission_recovery" | "managed_promotion" = "submission_recovery",
): Promise<void> {
  try {
    const approvalRef = adminDb
      .collection(FLU_APPLICATION_COMMAND_COLLECTION)
      .doc(fluApplicationApprovalCommandId(applicationId));
    const snapshot = await approvalRef.get();
    if (!snapshot.exists) return;
    const state = asString(snapshot.data()?.onboardingEnqueueState);
    if (TERMINAL_ENQUEUE_STATES.has(state)) return;
    await runApprovalOnboardingEnqueue(
      {
        applicationId,
        approvedByActorId: asString(snapshot.data()?.approvedByActorId) || null,
        commandRef: approvalRef,
        duplicate: true,
        programId: asString(snapshot.data()?.programId),
        trigger,
      },
      now,
    );
  } catch (error) {
    console.warn(
      "[scp-approval-onboarding] recovery_failed",
      JSON.stringify({ applicationId, error: error instanceof Error ? error.message : "unknown" }),
    );
  }
}
