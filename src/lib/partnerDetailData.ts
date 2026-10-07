// FLU-0538 pixel-clone surface 05 (/flu/partners/{id} — 개요 tab) — typed client contract for the
// getPartnerDetailSnapshot read callable. Mirrors the server snapshot shape 1:1. Reads go through the
// Functions callable (SEC-P0-004: no client Firestore direct read). DEMO-seeded today
// (scripts/seed-flu-0538-demo.mjs, demoSeed:true, single --rollback); values port the frozen mockup
// 05-partner-detail-proposal-final.png verbatim (PNG-only; geometry reverse-engineered).
//
// FLU-0540 gap-closure: `buildPartnerDetailSnapshotFromReal` below is the promotion path — it maps the
// REAL activation/profile/journey/video read-model (already loaded by the partner detail page via the
// registered `getPartnerTabEnvelopes` batch call) onto this same snapshot shape, so `PartnerDetailCloneView`
// can become the default overview-tab layout without a second network round-trip. Only the mockup's static
// UI chrome (section titles, fixed category labels) stays literal; every creator/enrollment-specific value
// comes from the real projection or degrades to an explicit "—" — never invented.
import type {
  PartnerJourneyEvent,
  PartnerJourneyStage,
  PartnerProfileProjection,
  PartnerVideo,
  RawPartnerActivationRecord,
} from "./partnerData";
import { formatKst } from "./datetime";
export interface PartnerDetailStep {
  label: string;
  sub: string;
  active?: boolean;
}
export interface PartnerDetailMoreRow {
  label: string;
}
export interface PartnerDetailSnapshot {
  present: boolean;
  backLabel: string;
  techInfoLabel: string;
  avatarInitial: string;
  profileImageUrl: string | null;
  imageStatusLabel: string;
  handle: string;
  statusBadge: string;
  name: string;
  tags: string[];
  steps: PartnerDetailStep[];
  activeAt: string;
  tabs: string[];
  activeTab: string;
  reasonTitle: string;
  reasonLabel: string;
  reasonText: string;
  reasonProgramLabel: string;
  reasonProgram: string;
  reasonCampaignLabel: string;
  reasonCampaign: string;
  videoTitle: string;
  videoThumbLabel: string;
  videoDuration: string;
  videoCanon: string;
  videoType: string;
  videoButton: string;
  nextTitle: string;
  nextStepLabel: string;
  nextStepText: string;
  nextButton: string;
  recommendLabel: string;
  recommendText: string;
  moreTitle: string;
  moreSub: string;
  moreRowsLeft: PartnerDetailMoreRow[];
  moreRowsMid: PartnerDetailMoreRow[];
  warnTitle: string;
  warnText: string;
  warnButton: string;
  footerNote: string;
  updatedAt: string | null;
}
export interface PartnerDetailEnvelope {
  ok: boolean;
  snapshot: PartnerDetailSnapshot;
}

// ---- callable transport (mirrors callSettlementCallable in ./partnerSettlementData.ts; standalone so
// data.ts + its tested FLU_CALLABLES union stay untouched — same non-goal as partnerData) ----
async function callPartnerDetailCallable<TResponse>(name: string, payload: Record<string, unknown> = {}): Promise<TResponse> {
  if (typeof window === "undefined") {
    throw new Error(`Partner-detail callable "${name}" must be invoked from a client interaction.`);
  }
  const [{ httpsCallable }, { functions, getFluCallableName }] = await Promise.all([
    import("firebase/functions"),
    import("./firebase"),
  ]);
  const callable = httpsCallable<Record<string, unknown>, TResponse>(functions, getFluCallableName(name));
  const result = await callable(payload);
  return result.data;
}

// Demo-gated overlay fetch for surface 05: present:false when unseeded → caller renders the real overview tab.
export async function getPartnerDetailSnapshot(): Promise<PartnerDetailSnapshot> {
  const env = await callPartnerDetailCallable<PartnerDetailEnvelope>("getPartnerDetailSnapshot");
  return env.snapshot;
}

// Honest present:false shell for the clone's own loading/empty/error states (paired with
// `PartnerDetailCloneView`'s `emptyMessage` prop) — never a fallback to a different layout.
export function emptyPartnerDetailSnapshot(): PartnerDetailSnapshot {
  return {
    present: false,
    backLabel: "",
    techInfoLabel: "",
    avatarInitial: "",
    profileImageUrl: null,
    imageStatusLabel: "이미지 미연결",
    handle: "",
    statusBadge: "",
    name: "",
    tags: [],
    steps: [],
    activeAt: "",
    tabs: [],
    activeTab: "개요",
    reasonTitle: "",
    reasonLabel: "",
    reasonText: "",
    reasonProgramLabel: "",
    reasonProgram: "",
    reasonCampaignLabel: "",
    reasonCampaign: "",
    videoTitle: "",
    videoThumbLabel: "",
    videoDuration: "",
    videoCanon: "",
    videoType: "",
    videoButton: "",
    nextTitle: "",
    nextStepLabel: "",
    nextStepText: "",
    nextButton: "",
    recommendLabel: "",
    recommendText: "",
    moreTitle: "",
    moreSub: "",
    moreRowsLeft: [],
    moreRowsMid: [],
    warnTitle: "",
    warnText: "",
    warnButton: "",
    footerNote: "",
    updatedAt: null,
  };
}

// ---- FLU-0540 gap-closure: real-data adapter (promotion path) ---------------------------------------
// 6 fixed Journey-stepper labels mirroring the mockup, mapped onto the real `PartnerJourneyStage` enum so
// each step's completion/sub-label comes from an actual journey event instead of a hardcoded demo string.
const STEP_DEFS: { label: string; stages: PartnerJourneyStage[] }[] = [
  { label: "프로그램", stages: ["program"] },
  { label: "캠페인/콜드메일", stages: ["campaign", "outreach"] },
  { label: "Apply", stages: ["apply"] },
  { label: "Enrollment", stages: ["enrollment"] },
  { label: "영상 승인", stages: ["video_submitted", "video_approved"] },
  { label: "Partner 활성", stages: ["partner_active"] },
];

function latestEventFor(events: PartnerJourneyEvent[], stages: PartnerJourneyStage[]): PartnerJourneyEvent | null {
  const matches = events.filter((event) => stages.includes(event.stage));
  if (matches.length === 0) return null;
  return matches.reduce((latest, candidate) =>
    candidate.occurredAtIso.localeCompare(latest.occurredAtIso) > 0 ? candidate : latest,
  );
}

function findApprovedVideo(videos: PartnerVideo[], submissionId: string, revision: number): PartnerVideo | null {
  return videos.find((video) => video.videoSubmissionId === submissionId && video.revisions.some((r) => r.revision === revision)) ?? null;
}

// Maps the real activation/profile/journey/video read-model (all already loaded by the partner detail
// page via the single registered `getPartnerTabEnvelopes` batch call) onto the PartnerDetailSnapshot shape
// `PartnerDetailCloneView` renders. Static mockup chrome (section titles, fixed category-row labels) is
// kept literal — it is UI copy, not per-creator data. Every field that varies by creator/enrollment comes
// from the real projection; anything the current read-model cannot supply degrades to an honest "—"
// rather than being invented (e.g. video duration/type/next-action have no backing field today).
export function buildPartnerDetailSnapshotFromReal(input: {
  profile: PartnerProfileProjection;
  activation: RawPartnerActivationRecord;
  videos: PartnerVideo[];
  journeyEvents: PartnerJourneyEvent[];
}): PartnerDetailSnapshot {
  const { profile, activation, videos, journeyEvents } = input;
  const approvedVideo = findApprovedVideo(videos, activation.evidence.submissionId, activation.evidence.videoRevision);
  const approvedRevision = approvedVideo?.revisions.find((r) => r.revision === activation.evidence.videoRevision) ?? null;

  const steps = STEP_DEFS.map((def, index) => {
    const isLast = index === STEP_DEFS.length - 1;
    if (isLast) {
      return { label: def.label, sub: "활성", active: true };
    }
    const matched = latestEventFor(journeyEvents, def.stages);
    return { label: def.label, sub: matched ? "완료" : "—", active: false };
  });

  const videoCanon = approvedRevision
    ? `YouTube 승인 영상 · 개정 ${activation.evidence.videoRevision}`
    : `승인 영상 · 개정 ${activation.evidence.videoRevision}`;

  const reasonText = `현재 영상 개정 ${activation.evidence.videoRevision}이 승인되어 Partner 상태가 활성화되었습니다.`;

  return {
    present: true,
    backLabel: "파트너 목록",
    techInfoLabel: "기술 정보 보기",
    avatarInitial: profile.profileImage.fallbackInitials,
    profileImageUrl: profile.profileImage.url,
    imageStatusLabel: profile.profileImage.url ? "이미지 연결됨" : "이미지 미연결 · 복구 필요",
    handle: profile.handle ?? "—",
    statusBadge: profile.status === "active" ? "파트너 활성" : "파트너 비활성",
    name: profile.displayName,
    tags: [profile.programName, profile.handle ?? profile.displayName].filter((t): t is string => Boolean(t)),
    steps,
    activeAt: profile.activatedAtIso ? `활성 일시: ${formatKst(profile.activatedAtIso)}` : "—",
    tabs: ["개요", "Journey", "영상", "성과·정산", "감사"],
    activeTab: "개요",
    reasonTitle: "파트너 전환 근거",
    reasonLabel: "활성 이유",
    reasonText,
    reasonProgramLabel: "프로그램",
    reasonProgram: profile.programName || profile.programId || "—",
    reasonCampaignLabel: "캠페인",
    reasonCampaign: profile.campaignName || profile.campaignId || "—",
    videoTitle: "현재 승인 영상",
    videoThumbLabel: approvedVideo?.title ?? approvedRevision?.youtubeVideoId ?? "—",
    videoDuration: "—",
    videoCanon,
    videoType: "—",
    videoButton: "영상 자세히 보기",
    nextTitle: "다음 액션",
    nextStepLabel: "다음 단계",
    nextStepText: profile.highestPriorityBlocker?.label ?? "추가로 필요한 조치가 없습니다.",
    nextButton: profile.highestPriorityBlocker?.actionTarget ? "조치 열기" : "조치 없음",
    recommendLabel: "권장 작업",
    recommendText: "—",
    moreTitle: "추가 정보 (접기/확장)",
    moreSub: "수익, 정산, 이력 등 세부 정보",
    moreRowsLeft: [{ label: "상태 및 추적" }, { label: "정산 및 지급" }, { label: "검토 이력" }],
    moreRowsMid: [{ label: "ID 및 일반 정보" }, { label: "영상 소스 상태" }, { label: "감사 로그" }],
    warnTitle: "일부 세부 정보가 존재합니다",
    warnText: "접근 권한 또는 조건에 따라 일부 세부가 비공개로 설정되어 있습니다.",
    warnButton: "권한 및 조건 확인",
    footerNote: "기술 정보는 권한이 있는 운영 도구에서 확인",
    updatedAt: new Date().toISOString(),
  };
}
