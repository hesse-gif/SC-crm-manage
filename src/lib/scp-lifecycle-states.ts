// ── SCP canonical lifecycle 상태 (순수 상수, 무의존) ─────────────────────────
// 노드 테스트가 workflow-timeline/scp-lifecycle-macro를 직접 import할 수 있도록
// alias(@/lib)나 React/데이터 레이어 의존이 전혀 없는 순수 모듈로 분리한다.
// canonical 정본은 functions/scpLifecycleProjection.ts — 이 목록은 클라 미러이며
// 순서·구성은 서버와 동일해야 한다(21개, 테스트로 고정).
export type ScpLifecycleState =
  | "coldmail_sent"
  | "reply_received"
  | "form_submitted"
  | "qualification_pending"
  | "qualification_passed"
  | "qualification_failed"
  | "pass_mail_pending"
  | "fail_mail_pending"
  | "onelink_sent"
  | "uid_requested"
  | "uid_received"
  | "gem_scheduled"
  | "gem_paid"
  | "video_task_issued"
  | "video_submitted"
  | "video_review_pending"
  | "video_approved"
  | "video_rejected"
  | "needs_resubmission"
  | "live_tracking"
  | "done_failed";

export const SCP_LIFECYCLE_STATES: readonly ScpLifecycleState[] = [
  "coldmail_sent",
  "reply_received",
  "form_submitted",
  "qualification_pending",
  "qualification_passed",
  "qualification_failed",
  "pass_mail_pending",
  "fail_mail_pending",
  "onelink_sent",
  "uid_requested",
  "uid_received",
  "gem_scheduled",
  "gem_paid",
  "video_task_issued",
  "video_submitted",
  "video_review_pending",
  "video_approved",
  "video_rejected",
  "needs_resubmission",
  "live_tracking",
  "done_failed",
];
