"use client";

// ── SCP lifecycle flow — 단일 클라이언트 메타데이터 소스 ─────────────────────────
// 대시보드(/flu)와 프로필 상세가 각자 하드코딩하던 컬럼 순서/라벨/터미널/휴먼게이트
// 세트를 이 모듈 하나로 통합한다(드리프트 방지). 서버 설정(scp_lifecycle_flow/{programId})
// 이 있으면 그 순서/라벨/게이트 핀을 쓰고, 없거나 로드 실패면 canonical 순서로
// 폴백한다(비차단 경고). canonical state ID는 서버 projection 소유로 불변이다.
import { useEffect, useState } from "react";
import { getScpLifecycleFlowConfig, type ScpLifecycleFlowConfigData, type ScpLifecycleFlowStep, type ScpLifecycleFlowTone } from "@/lib/data";

// 순수 상수는 무의존 모듈에서 재수출(노드 테스트가 workflow-timeline/macro를 직접 import 가능).
export type { ScpLifecycleState } from "./scp-lifecycle-states";
export { SCP_LIFECYCLE_STATES } from "./scp-lifecycle-states";
import { SCP_LIFECYCLE_STATES, type ScpLifecycleState } from "./scp-lifecycle-states";

// 보드 컬럼용 짧은 라벨/톤 (기존 /flu SCP_LIFECYCLE_COLUMNS와 동일 — 기본값 렌더링 불변).
export const SCP_LIFECYCLE_BOARD_META: Record<ScpLifecycleState, { label: string; description: string; tone: ScpLifecycleFlowTone }> = {
  coldmail_sent: { label: "콜드메일", description: "초기 아웃리치 발송", tone: "info" },
  reply_received: { label: "답장", description: "크리에이터 답장 수신", tone: "ai" },
  form_submitted: { label: "폼 제출", description: "Typeform 지원서 제출", tone: "accent" },
  qualification_pending: { label: "자격 대기", description: "자격 판정 입력 대기", tone: "warn" },
  qualification_passed: { label: "자격 통과", description: "자격 판정 통과", tone: "ok" },
  qualification_failed: { label: "자격 실패", description: "자격 판정 탈락", tone: "danger" },
  pass_mail_pending: { label: "합격 메일 대기", description: "통과 메일 사람 승인 대기", tone: "warn" },
  fail_mail_pending: { label: "불합격 메일 대기", description: "탈락 메일 사람 승인 대기", tone: "warn" },
  onelink_sent: { label: "OneLink 발송", description: "OneLink 안내 발송", tone: "accent" },
  uid_requested: { label: "UID 요청", description: "게임 UID 요청", tone: "ai" },
  uid_received: { label: "UID 수신", description: "게임 UID 수신 완료", tone: "ok" },
  gem_scheduled: { label: "젬 예약", description: "젬 지급 예약", tone: "accent" },
  gem_paid: { label: "젬 지급", description: "젬 지급 완료", tone: "ok" },
  video_task_issued: { label: "영상 과제", description: "영상 과제 발급", tone: "info" },
  video_submitted: { label: "영상 제출", description: "영상 제출 완료", tone: "ai" },
  video_review_pending: { label: "영상 검수", description: "영상 검수 결정 대기", tone: "warn" },
  video_approved: { label: "영상 승인", description: "영상 검수 승인", tone: "ok" },
  video_rejected: { label: "영상 반려", description: "영상 검수 반려", tone: "danger" },
  needs_resubmission: { label: "재제출 필요", description: "재제출 요청/확인 필요", tone: "danger" },
  live_tracking: { label: "라이브 추적", description: "조회수 추적 진행", tone: "ok" },
  done_failed: { label: "종료 실패", description: "종료/실패 처리", tone: "danger" },
};

// 프로필 상세용 긴 상태 라벨 (기존 상세 페이지 SCP_LIFECYCLE_STATE_LABELS와 동일).
export const SCP_LIFECYCLE_DETAIL_LABELS: Record<ScpLifecycleState, string> = {
  coldmail_sent: "콜드메일 발송",
  reply_received: "답장 수신",
  form_submitted: "폼 제출",
  qualification_pending: "자격 판정 대기",
  qualification_passed: "자격 통과",
  qualification_failed: "자격 탈락",
  pass_mail_pending: "통과 메일 대기",
  fail_mail_pending: "탈락 메일 대기",
  onelink_sent: "OneLink 발송",
  uid_requested: "UID 요청",
  uid_received: "UID 수신",
  gem_scheduled: "젬 지급 예약",
  gem_paid: "젬 지급 완료",
  video_task_issued: "영상 과제 발급",
  video_submitted: "영상 제출",
  video_review_pending: "영상 검수 대기",
  video_approved: "영상 승인",
  video_rejected: "영상 반려",
  needs_resubmission: "재제출 필요",
  live_tracking: "라이브 추적",
  done_failed: "종료/실패",
};

// Projection이 방출하는 운영 액션/블로커 기계 코드 → 운영자용 문구.
// 새 코드가 추가되면 tests/scp-operator-copy.test.mjs 전수성 테스트가 누락을 잡는다.
export const SCP_NEXT_ACTION_LABELS: Record<string, string> = {
  wait_for_reply: "답장 대기",
  send_or_confirm_form: "Typeform 안내/확인",
  run_qualification: "자격 판정 실행",
  decide_qualification: "자격 판정 입력",
  prepare_pass_mail: "통과 메일 초안 준비",
  prepare_fail_mail: "탈락 메일 초안 준비",
  send_pass_mail_after_gate: "통과 메일 사람 승인",
  send_fail_mail_after_gate: "탈락 메일 사람 승인",
  request_uid: "UID 요청",
  wait_for_uid: "UID 수신 대기",
  schedule_gem_grant: "젬 지급 예약",
  mark_gem_paid_after_audit: "젬 지급 감사/완료 처리",
  issue_video_task: "영상 과제 발급",
  wait_for_video_submission: "영상 제출 대기",
  review_video: "영상 검수",
  start_view_tracking: "조회수 추적 시작",
  close_or_resubmit: "종료 또는 재제출 판단",
  request_resubmission: "재제출 요청",
  monitor_views: "조회수 모니터링",
  none: "추가 액션 없음",
  resolve_identity_conflict: "동일 프로그램 신원 충돌 해소",
};

export const SCP_BLOCKER_LABELS: Record<string, string> = {
  human_mail_gate_or_draft_only: "메일은 draft_only 및 사람 승인 게이트 이후 발송",
  qualification_decision_required: "자격 판정 입력 필요",
  video_review_required: "영상 검수 결정 필요",
  view_tracking_not_matched: "조회수 추적 데이터 연결 필요",
  resubmission_required: "재제출 요청/확인 필요",
  identity_conflict_human_required: "신원 충돌 — 사람 확인 전 자동화 차단",
};

export function scpNextActionLabel(value?: string | null): string {
  if (!value) return "—";
  return SCP_NEXT_ACTION_LABELS[value] ?? "다음 작업 확인 필요";
}

export function scpBlockerLabel(value?: string | null): string {
  if (!value) return "차단 없음";
  return SCP_BLOCKER_LABELS[value] ?? "확인 필요";
}

// 터미널/실패 상태(성공 전환 금지) — 서버 SCP_LIFECYCLE_TERMINAL_STATES와 동일 계약.
export const SCP_LIFECYCLE_TERMINAL_STATES: readonly ScpLifecycleState[] = [
  "qualification_failed",
  "video_rejected",
  "done_failed",
];

// 잠금 휴먼게이트(비활성/삭제/핀 해제 불가) — 서버 SCP_LIFECYCLE_LOCKED_GATE_STATES와 동일 계약.
export const SCP_LIFECYCLE_LOCKED_GATE_STATES: readonly ScpLifecycleState[] = [
  "qualification_pending",
  "pass_mail_pending",
  "fail_mail_pending",
  "video_review_pending",
  "needs_resubmission",
];

// 기본 휴먼게이트 핀 = 기존 보드/상세 하드코딩 세트의 합집합(두 표면 패리티 수리).
export const SCP_LIFECYCLE_DEFAULT_GATE_STATES: readonly ScpLifecycleState[] = [
  "qualification_pending",
  "pass_mail_pending",
  "fail_mail_pending",
  "uid_requested",
  "gem_scheduled",
  "video_review_pending",
  "video_rejected",
  "needs_resubmission",
];

export function buildDefaultScpLifecycleFlowSteps(): ScpLifecycleFlowStep[] {
  const terminal = new Set<string>(SCP_LIFECYCLE_TERMINAL_STATES);
  const gates = new Set<string>(SCP_LIFECYCLE_DEFAULT_GATE_STATES);
  return SCP_LIFECYCLE_STATES.map((state, index) => ({
    id: state,
    label: SCP_LIFECYCLE_BOARD_META[state].label,
    description: SCP_LIFECYCLE_BOARD_META[state].description,
    order: index,
    enabled: true,
    deletedAtIso: null,
    terminal: terminal.has(state),
    humanGateRequired: gates.has(state),
    tone: SCP_LIFECYCLE_BOARD_META[state].tone,
  }));
}

export type ResolvedScpLifecycleFlow = {
  /** 보드에 렌더링할 컬럼(활성 + 미삭제), 설정 순서. */
  columns: Array<{ key: ScpLifecycleState; label: string; tone: ScpLifecycleFlowTone; description: string }>;
  /** 비활성/삭제된 canonical 상태 — 프로필은 "숨김/비활성 단계" 버킷으로 이동, 절대 드랍 금지. */
  hiddenStates: Set<ScpLifecycleState>;
  /** 휴먼게이트 핀 상태 세트(잠금 게이트 포함). */
  gateStates: Set<ScpLifecycleState>;
  /** 터미널/실패 상태 세트(설정으로 변경 불가). */
  terminalStates: Set<ScpLifecycleState>;
  /** state → 라벨 (설정 라벨 우선, canonical 폴백). */
  labelFor: (state: ScpLifecycleState | string | undefined, surface?: "board" | "detail") => string;
  toneFor: (state: ScpLifecycleState | string | undefined) => ScpLifecycleFlowTone;
  /** 설정 출처: 저장된 설정("program"/"default") vs canonical 폴백("canonical"). */
  source: "program" | "default" | "canonical";
  version: number;
};

export function resolveScpLifecycleFlow(
  config: ScpLifecycleFlowConfigData | null,
  source: "program" | "default" | "canonical" = "canonical",
): ResolvedScpLifecycleFlow {
  const canonicalSet = new Set<string>(SCP_LIFECYCLE_STATES);
  const steps = (config?.steps ?? []).filter((step) => canonicalSet.has(step.id));
  const usable = steps.length === SCP_LIFECYCLE_STATES.length ? steps : buildDefaultScpLifecycleFlowSteps();
  const effectiveSource = steps.length === SCP_LIFECYCLE_STATES.length ? source : "canonical";
  const ordered = [...usable].sort((left, right) => left.order - right.order);
  const hiddenStates = new Set<ScpLifecycleState>();
  const gateStates = new Set<ScpLifecycleState>();
  const labelByState = new Map<ScpLifecycleState, string>();
  const toneByState = new Map<ScpLifecycleState, ScpLifecycleFlowTone>();
  const columns: ResolvedScpLifecycleFlow["columns"] = [];
  for (const step of ordered) {
    const state = step.id as ScpLifecycleState;
    labelByState.set(state, step.label || SCP_LIFECYCLE_BOARD_META[state].label);
    toneByState.set(state, step.tone || SCP_LIFECYCLE_BOARD_META[state].tone);
    if (step.humanGateRequired) gateStates.add(state);
    if (!step.enabled || step.deletedAtIso !== null) {
      hiddenStates.add(state);
      continue;
    }
    columns.push({
      key: state,
      label: step.label || SCP_LIFECYCLE_BOARD_META[state].label,
      tone: step.tone || SCP_LIFECYCLE_BOARD_META[state].tone,
      description: step.description,
    });
  }
  const hasSavedConfig = effectiveSource !== "canonical";
  return {
    columns,
    hiddenStates,
    gateStates,
    terminalStates: new Set<ScpLifecycleState>(SCP_LIFECYCLE_TERMINAL_STATES),
    labelFor: (state, surface = "board") => {
      if (!state || !canonicalSet.has(state)) return String(state ?? "");
      const canonical = state as ScpLifecycleState;
      // 저장된 설정이 있으면 라벨 rename이 보드/상세 모두에 적용된다.
      if (hasSavedConfig) return labelByState.get(canonical) ?? SCP_LIFECYCLE_BOARD_META[canonical].label;
      return surface === "detail" ? SCP_LIFECYCLE_DETAIL_LABELS[canonical] : SCP_LIFECYCLE_BOARD_META[canonical].label;
    },
    toneFor: (state) => {
      if (!state || !canonicalSet.has(state)) return "neutral";
      return toneByState.get(state as ScpLifecycleState) ?? SCP_LIFECYCLE_BOARD_META[state as ScpLifecycleState].tone;
    },
    source: effectiveSource,
    version: config?.version ?? 0,
  };
}

export type ScpLifecycleFlowHookState = {
  flow: ResolvedScpLifecycleFlow;
  loading: boolean;
  /** 설정 로드 실패 시 비차단 경고 메시지(canonical 폴백으로 렌더 지속). */
  warning: string | null;
};

// 설정 1회 로드 훅 — 실패해도 보드/상세는 canonical 순서로 계속 렌더된다(비차단).
export function useScpLifecycleFlow(programId?: string): ScpLifecycleFlowHookState {
  const [state, setState] = useState<ScpLifecycleFlowHookState>({
    flow: resolveScpLifecycleFlow(null, "canonical"),
    loading: true,
    warning: null,
  });

  useEffect(() => {
    let cancelled = false;
    getScpLifecycleFlowConfig(programId ? { programId } : {})
      .then((envelope) => {
        if (cancelled) return;
        setState({
          flow: resolveScpLifecycleFlow(envelope.config ?? null, envelope.source ?? "canonical"),
          loading: false,
          warning: null,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          flow: resolveScpLifecycleFlow(null, "canonical"),
          loading: false,
          warning: `단계 설정을 불러오지 못해 기본 순서로 표시 중입니다 (${error instanceof Error ? error.message : String(error)})`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [programId]);

  return state;
}
