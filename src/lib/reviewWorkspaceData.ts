// Legacy review compatibility surface — 2026-09-05 검수 탭 적대 감사 확인.
// 운영 영상 검수 정본 UI 는 `src/app/(app)/flu/review/CanonicalVideoReviewPanel.tsx` 이고,
// 이 모듈의 큐/숫자는 `review_workspace_snapshots/current` 데모 시드
// (scripts/seed-flu-0538-demo.mjs)에서 온다. 실제 제출 원장(`scp_video_review_state`)이 아니다.
// 다타이틀·검수 로직 수정은 CanonicalVideoReviewPanel 과
// `functions/videoReviewStateCallables.ts` / `functions/videoReviewCriteria.ts` 에서 한다.
// 후속 삭제 PR 범위: 이 파일 + `functions/reviewWorkspace.ts` +
// `src/components/flu/reviewWorkspace/ReviewWorkspaceView.tsx` +
// `getReviewWorkspaceSnapshot` 콜러블 등록 + review 스냅샷 시드. 이번 패스에서는 지우지 않는다.
// FLU-0538 pixel-clone surface 09 (/flu/review — human review workspace) — typed client contract for the
// getReviewWorkspaceSnapshot read callable. Mirrors the server snapshot shape 1:1. Reads go through the
// Functions callable (SEC-P0-004: no client Firestore direct read). DEMO-seeded today
// (scripts/seed-flu-0538-demo.mjs, demoSeed:true, single --rollback); values port the frozen mockup
// #review section verbatim (artifacts/ux-audit-20260719/07-view-settlement-scp-review-mockups.html).
export type ReviewTone = "green" | "blue" | "amber" | "red" | "purple";
export type ReviewValueTone = "green" | "amber" | "default";

export interface ReviewQueueItem {
  handle: string;
  program: string;
  status: string;
  active: boolean;
}
export interface ReviewPill {
  tone: ReviewTone;
  label: string;
}
export interface ReviewLine {
  label: string;
  value: string;
  valueTone: ReviewValueTone;
}
export interface ReviewWorkspaceSnapshot {
  present: boolean;
  title: string;
  rolePill: string;
  subtitle: string;
  queueTitle: string;
  queueSub: string;
  queue: ReviewQueueItem[];
  mediaTitle: string;
  videoName: string;
  videoMeta: string;
  mediaPills: ReviewPill[];
  evidenceTitle: string;
  evidenceLines: ReviewLine[];
  evidenceNote: string;
  detailTitle: string;
  detailLines: ReviewLine[];
  detailButton: string;
  decisionTitle: string;
  decisionSub: string;
  decisionNote: string;
  mailNoteTitle: string;
  mailNoteLines: string[];
  auditTitle: string;
  auditNote: string[];
  updatedAt: string | null;
}
export interface ReviewWorkspaceEnvelope {
  ok: boolean;
  snapshot: ReviewWorkspaceSnapshot;
}

// ---- callable transport (standalone; data.ts + its tested FLU_CALLABLES union stay untouched) ----
async function callReviewWorkspaceCallable<TResponse>(name: string, payload: Record<string, unknown> = {}): Promise<TResponse> {
  if (typeof window === "undefined") {
    throw new Error(`Review workspace callable "${name}" must be invoked from a client interaction.`);
  }
  const [{ httpsCallable }, { functions, getFluCallableName }] = await Promise.all([
    import("firebase/functions"),
    import("./firebase"),
  ]);
  const callable = httpsCallable<Record<string, unknown>, TResponse>(functions, getFluCallableName(name));
  const result = await callable(payload);
  return result.data;
}

// Demo-gated overlay fetch for surface 09: present:false when unseeded → caller renders the real ReviewPage.
export async function getReviewWorkspaceSnapshot(): Promise<ReviewWorkspaceSnapshot> {
  const env = await callReviewWorkspaceCallable<ReviewWorkspaceEnvelope>("getReviewWorkspaceSnapshot");
  return env.snapshot;
}
