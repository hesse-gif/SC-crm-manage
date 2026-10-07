import { SCP_LIFECYCLE_STATES, type ScpLifecycleState } from "./scp-lifecycle-states.ts";

export type ScpLifecycleMacroId = "outreach" | "qualification" | "onboarding" | "video" | "live_done";

export type ScpLifecycleMacroPhase = {
  readonly id: ScpLifecycleMacroId;
  readonly label: string;
  readonly description: string;
  readonly stateIds: readonly ScpLifecycleState[];
};

export const SCP_LIFECYCLE_MACRO_PHASES: readonly ScpLifecycleMacroPhase[] = [
  {
    id: "outreach",
    label: "아웃리치",
    description: "콜드메일 발송부터 답장·폼 제출까지",
    stateIds: ["coldmail_sent", "reply_received", "form_submitted"],
  },
  {
    id: "qualification",
    label: "자격",
    description: "지원자 자격 판정과 합격·탈락 메일 게이트",
    stateIds: ["qualification_pending", "qualification_passed", "qualification_failed", "pass_mail_pending", "fail_mail_pending"],
  },
  {
    id: "onboarding",
    label: "온보딩",
    description: "OneLink 안내, UID 확인, 젬 지급",
    stateIds: ["onelink_sent", "uid_requested", "uid_received", "gem_scheduled", "gem_paid"],
  },
  {
    id: "video",
    label: "영상",
    description: "영상 과제 발급부터 제출·검수·재제출까지",
    stateIds: ["video_task_issued", "video_submitted", "video_review_pending", "video_approved", "video_rejected", "needs_resubmission"],
  },
  {
    id: "live_done",
    label: "라이브/종료",
    description: "라이브 조회수 추적과 종료·실패 처리",
    stateIds: ["live_tracking", "done_failed"],
  },
] as const;

const MACRO_BY_STATE = new Map<ScpLifecycleState, ScpLifecycleMacroPhase>(
  SCP_LIFECYCLE_MACRO_PHASES.flatMap((phase) => phase.stateIds.map((state) => [state, phase] as const)),
);

export type ScpLifecycleMacroCoverage = {
  readonly ok: boolean;
  readonly totalStates: number;
  readonly mappedStates: number;
  readonly missing: readonly ScpLifecycleState[];
  readonly duplicates: readonly ScpLifecycleState[];
  readonly unknown: readonly string[];
};

export function stateToMacro(state: ScpLifecycleState | string | null | undefined): ScpLifecycleMacroPhase | null {
  return MACRO_BY_STATE.get(state as ScpLifecycleState) ?? null;
}

export function validateScpLifecycleMacroCoverage(
  phases: readonly ScpLifecycleMacroPhase[] = SCP_LIFECYCLE_MACRO_PHASES,
  states: readonly ScpLifecycleState[] = SCP_LIFECYCLE_STATES,
): ScpLifecycleMacroCoverage {
  const canonical = new Set<string>(states);
  const seen = new Set<string>();
  const duplicateSet = new Set<ScpLifecycleState>();
  const unknownSet = new Set<string>();

  for (const phase of phases) {
    for (const state of phase.stateIds) {
      if (!canonical.has(state)) {
        unknownSet.add(state);
        continue;
      }
      if (seen.has(state)) duplicateSet.add(state);
      seen.add(state);
    }
  }

  const missing = states.filter((state) => !seen.has(state));
  const duplicates = states.filter((state) => duplicateSet.has(state));
  const unknown = [...unknownSet].sort();
  return {
    ok: missing.length === 0 && duplicates.length === 0 && unknown.length === 0,
    totalStates: states.length,
    mappedStates: seen.size,
    missing,
    duplicates,
    unknown,
  };
}
