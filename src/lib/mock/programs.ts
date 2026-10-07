export type ProgramStatus = "draft" | "open" | "closed";
export type ProgramApplicationStatus = "pending" | "approved" | "rejected" | "hold";
export type ProgramKpiMetric = "applicants" | "approved" | "contracted" | "reviewed" | "live";
export type CountryScope = "inherit" | "all" | "include";

export interface CountryTargeting {
  countryScope: CountryScope;
  includedCountries: string[];
  excludedCountries: string[];
}

export interface ProgramLink {
  label: string;
  url: string;
}

export type MailTemplateTone = "정중" | "간결" | "행사초대형";

export interface ProgramMailTemplate {
  tone: MailTemplateTone;
  contentTags: string[];
}

export interface ProgramColdMailLocalized {
  subject: string;
  body: string;
  lang: string;
  sourceHash?: string;
  translatedAtIso?: string;
}

export type ProgramColdMailBodyFormat = "markdown" | "text" | "html";

export interface ProgramColdMail {
  subject: string;
  body: string;
  sourceCountry: string;
  targetCountries: string[];
  // "text"는 일반 텍스트, "html"은 원문 HTML로 처리한다(HTML은 국가별 자동번역 비활성화). 기본 "markdown".
  bodyFormat?: ProgramColdMailBodyFormat;
  localized?: Record<string, ProgramColdMailLocalized>;
  updatedAtIso?: string;
}

export interface Program {
  id: string;
  canonicalProgramId?: string;
  aliases?: string[];
  legacyProgramIds?: string[];
  slug: string;
  title: string;
  status: ProgramStatus;
  brief: string;
  gameTitle: string;
  owner: string;
  rewardKRW: number;
  kpiMetric: ProgramKpiMetric;
  kpiTarget: number;
  tags: string[];
  applicationCount: number;
  approvedCount: number;
  contractCount: number;
  reviewCount: number;
  publicApplyPath: string;
  imageUrl?: string;
  discoveryVertical?: "game" | "ai_drama" | string;
  mailTemplate?: ProgramMailTemplate;
  coldMail?: ProgramColdMail;
  countryTargeting?: CountryTargeting;
  targetCountries?: string[];
  excludedCountries?: string[];
  requiredLinks?: ProgramLink[];
  assetLinks?: ProgramLink[];
  submissionEndpoint?: ProgramLink;
  applicationEndpoint?: ProgramLink;
  qualificationPolicy?: Record<string, unknown>;
  qualificationConfig?: Record<string, unknown>;
  candidateCriteria?: Record<string, unknown>;
  eligibilityCriteria?: Record<string, unknown>;
  videoReviewPolicy?: Record<string, unknown>;
  videoReviewConfig?: Record<string, unknown>;
  programAi: {
    enabled: boolean;
    dryRunDefault: boolean;
    defaultTone: string;
    defaultFormat: string;
    toneTags?: string[];
    formatTags?: string[];
    learningTags: string[];
    maxPerProgramDailySends: number;
    minProgramReplyDelayMinutes: number;
    programTemplateNotes: string[];
  };
}

export interface ProgramApplication {
  id: string;
  programId: string;
  programSlug: string;
  programTitle: string;
  status: ProgramApplicationStatus;
  name: string;
  email: string;
  handle: string;
  youtubeUrl: string;
  platform: string;
  followers: number;
  region: string;
  category: string;
  pitch: string;
  avatar: string;
  submittedAtIso: string;
  canonicalProgramId?: string;
  leadId?: string;
  leadRef?: string;
  applicationRef?: string;
  qualificationStatus?: string;
  qualificationRecommendation?: string;
  qualificationDecisionRef?: string;
  qualificationPolicyHash?: string;
  qualificationPolicySnapshot?: Record<string, unknown>;
  videoReviewPolicySnapshot?: Record<string, unknown>;
  submissionTaskRef?: string;
  submissionTaskStatus?: string;
  creatorId?: string;
  conversationId?: string;
  contractId?: string;
  reviewId?: string;
  campaignId?: string;
  campaignTitle?: string;
  participationActive?: boolean;
  participationStatus?: "pending" | "hold" | "active" | "retracted";
  participationStage?: "contact" | "negotiation" | "contract" | "review" | "live";
  participationUpdatedAtIso?: string;
}

export const PROGRAMS: Program[] = [
  {
    id: "pg-xphero-creator-challenge",
    slug: "xphero-creator-challenge",
    title: "XPHERO 크리에이터 챌린지",
    status: "open",
    brief: "XPHERO 숏폼과 플레이 리뷰를 모집하고 승인된 신청자는 계약과 검수로 연결합니다.",
    gameTitle: "XPHERO",
    owner: "헤세",
    rewardKRW: 2300000,
    kpiMetric: "approved",
    kpiTarget: 20,
    tags: ["UGC", "YouTube", "KR"],
    applicationCount: 1,
    approvedCount: 0,
    contractCount: 0,
    reviewCount: 0,
    publicApplyPath: "/programs/xphero-creator-challenge/apply",
    requiredLinks: [
      { label: "참여 가이드", url: "https://supercent.io" },
      { label: "신청 링크", url: "/programs/xphero-creator-challenge/apply" },
    ],
    assetLinks: [
      { label: "키아트", url: "https://supercent.io" },
    ],
    submissionEndpoint: { label: "영상 제출 폼", url: "https://supercent.io" },
    applicationEndpoint: { label: "공개 신청", url: "/programs/xphero-creator-challenge/apply" },
    programAi: {
      enabled: true,
      dryRunDefault: true,
      defaultTone: "행사 초대형·정중·간결",
      defaultFormat: "프로그램명 → 참여 혜택 → 일정 → 다음 액션",
      toneTags: ["행사 초대형", "정중", "간결"],
      formatTags: ["프로그램명", "참여 혜택", "일정", "다음 액션"],
      learningTags: ["program-brief", "eligibility", "reward", "deliverables"],
      maxPerProgramDailySends: 10,
      minProgramReplyDelayMinutes: 60,
      programTemplateNotes: ["프로그램 목적을 첫 문장에 노출", "계약·검수 조건은 요약 후 링크로 안내"],
    },
  },
];

export const PROGRAM_APPLICATIONS: ProgramApplication[] = [
  {
    id: "pg-xphero-creator-challenge-hesse-supercent-io",
    programId: "pg-xphero-creator-challenge",
    programSlug: "xphero-creator-challenge",
    programTitle: "XPHERO 크리에이터 챌린지",
    status: "pending",
    creatorId: "rc-hesse",
    campaignId: "cp1",
    campaignTitle: "캐주얼 신작 글로벌 컨택",
    name: "Supercent Official",
    email: "hesse@supercent.io",
    handle: "@supercent_official",
    youtubeUrl: "https://www.youtube.com/@supercent_official",
    platform: "YouTube",
    followers: 2800000,
    region: "KR",
    category: "Mobile Game/XPHERO",
    pitch: "MVP 프로그램 신청과 승인, 계약, 검수 흐름을 확인하는 고정 테스트 신청자입니다.",
    avatar: "https://yt3.ggpht.com/gf0wAEnwry8iGHxxMSusiFzcqbcj8nzX3k7S8rQMv4BoNJgP7KN9yLu7K9bBMof_PfuuIoDY9A=s800-c-k-c0x00ffffff-no-rj",
    submittedAtIso: "2026-06-23T15:00:00.000+09:00",
  },
];
