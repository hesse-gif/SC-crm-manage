// Legacy review compatibility surface — 2026-09-05 검수 탭 적대 감사 확인.
// 운영 영상 검수 정본 UI 는 `src/app/(app)/flu/review/CanonicalVideoReviewPanel.tsx` 이고,
// 이 모듈의 큐/숫자는 `review_workspace_snapshots/current` 데모 시드
// (scripts/seed-flu-0538-demo.mjs)에서 온다. 실제 제출 원장(`scp_video_review_state`)이 아니다.
// 다타이틀·검수 로직 수정은 CanonicalVideoReviewPanel 과
// `functions/videoReviewStateCallables.ts` / `functions/videoReviewCriteria.ts` 에서 한다.
// 후속 삭제 PR 범위: 이 파일 + `src/lib/reviewWorkspaceData.ts` +
// `src/components/flu/reviewWorkspace/ReviewWorkspaceView.tsx` +
// `getReviewWorkspaceSnapshot` 콜러블 등록 + review 스냅샷 시드. 이번 패스에서는 지우지 않는다.
// FLU-0538 pixel-clone (surface 09 사람 검수, operator decision B: app-font structural reproduction of the
// real /flu/review content region, shell = allowed deviation). Read-only review-workspace snapshot for the
// demo-gated overlay. RBAC manager+ (mirrors the review page's gate). The snapshot lives at
// review_workspace_snapshots/current — today DEMO-only screen-fill (scripts/seed-flu-0538-demo.mjs,
// demoSeed:true, reversible); a real review projection later writes the same doc shape. No external side
// effects; a missing doc returns an honest empty snapshot (present:false) so the UI renders the real
// ReviewPage untouched.
import { adminDb } from "./firebaseAdmin";
import {
  assertNonGuestAuth,
  asRecord,
  makeBehaviorLog,
  makeCache,
  makeCostLog,
  type CallableRequestShape,
} from "./shared";

export const REVIEW_WORKSPACE_DOC = "review_workspace_snapshots/current";
const READ_ROLES = ["super_admin", "admin", "manager"] as const;
const CACHE_TTL_SECONDS = 30;

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

export const EMPTY_REVIEW_WORKSPACE: ReviewWorkspaceSnapshot = {
  present: false,
  title: "",
  rolePill: "",
  subtitle: "",
  queueTitle: "",
  queueSub: "",
  queue: [],
  mediaTitle: "",
  videoName: "",
  videoMeta: "",
  mediaPills: [],
  evidenceTitle: "",
  evidenceLines: [],
  evidenceNote: "",
  detailTitle: "",
  detailLines: [],
  detailButton: "",
  decisionTitle: "",
  decisionSub: "",
  decisionNote: "",
  mailNoteTitle: "",
  mailNoteLines: [],
  auditTitle: "",
  auditNote: [],
  updatedAt: null,
};

const TONES = new Set<ReviewTone>(["green", "blue", "amber", "red", "purple"]);
const VALUE_TONES = new Set<ReviewValueTone>(["green", "amber", "default"]);
function toTone(value: unknown): ReviewTone {
  return typeof value === "string" && TONES.has(value as ReviewTone) ? (value as ReviewTone) : "blue";
}
function toValueTone(value: unknown): ReviewValueTone {
  return typeof value === "string" && VALUE_TONES.has(value as ReviewValueTone) ? (value as ReviewValueTone) : "default";
}
function toStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function toArr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function toStrArr(value: unknown): string[] {
  return toArr(value).map(toStr);
}
function toLines(value: unknown): ReviewLine[] {
  return toArr(value).map((l) => {
    const r = asRecord(l);
    return { label: toStr(r.label), value: toStr(r.value), valueTone: toValueTone(r.valueTone) };
  });
}

export function normalizeReviewWorkspace(raw: unknown): ReviewWorkspaceSnapshot {
  const d = asRecord(raw);
  return {
    present: true,
    title: toStr(d.title),
    rolePill: toStr(d.rolePill),
    subtitle: toStr(d.subtitle),
    queueTitle: toStr(d.queueTitle),
    queueSub: toStr(d.queueSub),
    queue: toArr(d.queue).map((q) => {
      const r = asRecord(q);
      return { handle: toStr(r.handle), program: toStr(r.program), status: toStr(r.status), active: r.active === true };
    }),
    mediaTitle: toStr(d.mediaTitle),
    videoName: toStr(d.videoName),
    videoMeta: toStr(d.videoMeta),
    mediaPills: toArr(d.mediaPills).map((p) => {
      const r = asRecord(p);
      return { tone: toTone(r.tone), label: toStr(r.label) };
    }),
    evidenceTitle: toStr(d.evidenceTitle),
    evidenceLines: toLines(d.evidenceLines),
    evidenceNote: toStr(d.evidenceNote),
    detailTitle: toStr(d.detailTitle),
    detailLines: toLines(d.detailLines),
    detailButton: toStr(d.detailButton),
    decisionTitle: toStr(d.decisionTitle),
    decisionSub: toStr(d.decisionSub),
    decisionNote: toStr(d.decisionNote),
    mailNoteTitle: toStr(d.mailNoteTitle),
    mailNoteLines: toStrArr(d.mailNoteLines),
    auditTitle: toStr(d.auditTitle),
    auditNote: toStrArr(d.auditNote),
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : null,
  };
}

export async function getReviewWorkspaceSnapshot(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "review_workspace.snapshot.get", READ_ROLES);
  const snap = await adminDb.doc(REVIEW_WORKSPACE_DOC).get();
  const snapshot = snap.exists ? normalizeReviewWorkspace(snap.data() ?? {}) : EMPTY_REVIEW_WORKSPACE;
  return {
    ok: true,
    snapshot,
    cache: makeCache("review_workspace:snapshot", false, CACHE_TTL_SECONDS),
    costLog: makeCostLog("review_workspace.snapshot.get", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "review_workspace.snapshot.get", "success"),
  };
}
