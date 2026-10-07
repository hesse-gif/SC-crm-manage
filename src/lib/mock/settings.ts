// ── 설정 (모든 세팅값 — 태그형) ──
export const POLICY_CACHE_TTL_SECONDS = 600;

export const SETTINGS = {
  mail: { tone: "정중·간결", signature: "Supercent Team", languages: ["한국어", "English", "수신자 현지어 자동"], rate: "시간당 200건" },
  partnerCriteria: { targetCount: 50, minFollowers: 50000, maxFollowers: 5000000, categories: ["캐주얼", "퍼즐", "하이퍼캐주얼"], regions: ["US", "BR", "KR", "ID"] },
  candidateCriteria: {
    keywords: ["casual game", "puzzle", "hyper casual", "mobile game"],
    minFollowers: 30000,
    maxFollowers: 2000000,
    recentActivityDays: 30,
    platforms: ["YouTube", "TikTok", "Instagram", "Reddit", "Discord", "X", "Web"],
  },
  manageRules: { autoFollowupDays: 3, segments: ["무응답 7일", "협의 정체", "계약 임박"] },
  automation: {
    aiAutomationEnabled: true,
    outboundCampaignAutomation: true,
    autoReplyEnabled: false,
    // A fail-closed, account-scoped exception to the normal human-approval gate for
    // trusted IMAP inbound replies. IDs come from the server's public mailbox projection.
    inboundAutoReplyAllowedMailAccountIds: [] as string[],
    negotiationAutomation: true,
    contractDraftAutomation: true,
    reviewAutomation: true,
    // W90: 키워드 LLM 확장 킬스위치 — 기본 false(배포 후 리더가 별도로 켠다).
    keywordLlmExpansionEnabled: false,
    // AI-DRAMA-DISCOVERY-METAPROMPT W1: functions/_settings-mock.ts 와 동일 — 이 목록의 ownerOrgId
    // 조직은 발굴 키워드 자동확장(n-gram·LLM 제안) 두 레인 모두 스킵한다. 기본 빈 배열.
    keywordExpansionDisabledOrgIds: [] as string[],
    // auto-reply-org-controls (2026-09-24): functions/_settings-mock.ts 와 동일 — T049(AI Drama)는
    // 어떤 자동응답 경로로도 자동 발송돼서는 안 되므로, keywordExpansionDisabledOrgIds와 달리 기본값
    // 자체에 이미 "T049"가 들어 있다.
    autoReplyDisabledOrgIds: ["T049"] as string[],
    // 헤세 결정 2026-09-16: functions/_settings-mock.ts와 동일 — 프로그램 스코프 독립 토글
    // ("global" | "program"). 기본 "global"(전역 차단 유지), "program"이면 서로 다른 프로그램끼리
    // 독립적으로 콜드메일한다.
    outreachDedupScope: "global",
    liveSendEnabled: false,
    humanApprovalRequired: true,
    // auto-reply-approval-bypass (2026-09-25): functions/_settings-mock.ts 와 동일 — 자동응답
    // (auto_reply) 레인만 예외로 프로필의 humanApprovalRequired 를 우회할 수 있는 킬스위치.
    // 아웃바운드(콜드메일·독려·캠페인)엔 절대 영향 없음. 기본 true(헤세 명시 결정).
    autoReplyBypassesProfileHumanApproval: true,
    // "미답장 인박스 dismiss" (2026-09-26, 헤세 결정): functions/_settings-mock.ts 와 동일 —
    // 영업/에이전시·scp 미등록 발신자 메일을 답장 없이 자동 읽음 처리하는 킬스위치. 기본 true.
    dismissAgencyAndUnregisteredSenderMail: true,
    minReplyDelayMinutes: 60,
    // F-3(AUTO-MAIL-SAFETY-DESIGN-2026-09-16.md §D): functions/_settings-mock.ts 와 동일한
    // 지터/영업시간 기본값 — 프런트 목업이 서버 기본값과 어긋나지 않게 미러링.
    autoReplyJitterMaxMinutes: 120,
    autoReplyBusinessHoursKst: { enabled: true, startHour: 10, startMinute: 0, endHour: 18, endMinute: 30, weekdaysOnly: true },
    // auto-reply-pacing(2026-09-17): functions/_settings-mock.ts 와 동일 — 몰림 방지 스프레드(분),
    // bounds 30~360.
    autoReplyBurstSpreadMinutes: 150,
    // auto-reply-pacing(2026-09-17): functions/_settings-mock.ts 와 동일 — 일일 캡 상향(20→40) +
    // 패스당/시간당 캡 신설(bounds 각각 1~50 / 1~200).
    maxDailyAutoSends: 40,
    maxAutoRepliesPerPass: 10,
    maxHourlyAutoSends: 20,
    maxDailyOutreachSends: 50,
    // Task-95 §4: functions/_settings-mock.ts 와 동일한 신청자 자격 자동 판정 적용 게이트 —
    // 기본 둘 다 false. autoApproveEnabled 는 코드 발급 시점 확정 전까지 서버가 절대 읽지 않는다
    // (approve = 코드 발급이 한 트랜잭션, TICKET-MAP §3 결정 #5).
    applicationAutoDecision: {
      autoRejectEnabled: false,
      autoApproveEnabled: false,
    },
    // Task-94: functions/_settings-mock.ts 와 동일한 자동 검수/반려 토글 미러. 기본 false.
    videoReview: { autoRejectEnabled: false, minDurationSeconds: 20 },
    // Task-91 확장 ④: functions/_settings-mock.ts 와 동일 — SCP 상태 문의 유형별 자동응답 토글,
    // 리포 불변식(draft_only 기본)에 따라 전부 기본 false.
    scpInquiryAutoReply: {
      application_status: false,
      creator_code: false,
      review_result: false,
      settlement: false,
    },
  },
  humanReviewPolicy: {
    lowDataReviewMode: "strict",
    minEvidenceScore: 80,
    minSignalsForAutoReply: 3,
    autoReplyConfidenceThreshold: 0.78,
    ambiguousReviewRatePct: 35,
    requireFollowersForPricing: true,
    requireRecentViewsForPricing: true,
  },
  mailSafety: {
    emergencyShutdownEnabled: false,
    emergencyKeywords: [
      "더이상 메일",
      "메일 보내지",
      "수신거부",
      "고소",
      "법적 조치",
      "소송",
      "unsubscribe",
      "stop emailing",
      "do not email",
      "do not contact",
      "lawsuit",
      "legal action",
      "attorney",
      "lawyer",
    ],
    blockedEmails: [],
    blockedDomains: [],
    suppressedHandles: [],
    disposableDomains: ["mailinator.com", "10minutemail.com", "tempmail.com", "guerrillamail.com", "yopmail.com"],
    roleAccountPrefixes: ["admin", "billing", "contact", "help", "info", "marketing", "noreply", "press", "sales", "support"],
    outboundPolicy: {
      hourlyCap: 10,
      dailyCap: 50,
      burstCap: 3,
      uniqueRecipientDailyCap: 50,
      // A3(RT-3)/S3/인터뷰 #1 확정: 전역(차원 무관) 주간 총량 cap, UTC 월요일 시작.
      // functions/_settings-mock.ts와 동일 기본값(50) — 두 mock이 독립 유지되는 기존 컨벤션.
      weeklyTotalCap: 50,
      burstWindowMinutes: 10,
      jitterMinSeconds: 30,
      jitterMaxSeconds: 180,
      rampUpPlan: [
        { day: 1, dailyCap: 20 },
        { day: 2, dailyCap: 30 },
        { day: 3, dailyCap: 50 },
      ],
      hardBounceLockThreshold: 5,
      highVolumeEnabled: false,
      reputationStatus: "pilot",
      smtpProbingEnabled: false,
    },
    escalationInbox: "legal@supercent.io",
    requireHumanAfterComplaint: true,
  },
  programAi: {
    enabled: true,
    dryRunDefault: true,
    defaultTone: "행사 초대형·정중·간결",
    defaultFormat: "프로그램명 → 참여 혜택 → 일정 → 다음 액션",
    learningTags: ["program-brief", "eligibility", "reward", "deliverables"],
    maxDailyProgramSends: 30,
    maxPerProgramDailySends: 10,
    minProgramReplyDelayMinutes: 60,
    programTemplateNotes: ["프로그램 목적을 첫 문장에 노출", "계약·검수 조건은 요약 후 링크로 안내"],
  },
  feed: {
    ownedGameTags: [
      "XP Hero",
      "XPHERO",
      "Pizza Ready",
      "Dinosaur Universe",
      "Shark Universe",
      "Burger Please",
      "Snake Clash",
      "Lumber Chopper",
      "Suzy's Restaurant",
      "Super Big Slime",
      "Arrow Fever",
      "Downhill Racer",
      "Match Clash",
      "Spin Miner",
      "Outlets Rush",
    ],
    similarGameTags: ["Archero", "Survivor.io", "Legend of Mushroom", "Eatventure", "My Perfect Hotel", "Cooking Fever", "Good Pizza Great Pizza", "Snake.io"],
    similarGamesAutoDiscover: true,
    ugcKeywords: ["gameplay", "review", "tips", "walkthrough", "shorts", "clip", "fan art", "meme"],
    communitySubreddits: ["XPHero", "AndroidGaming", "MobileGaming", "iosgaming", "hyper_casual_games", "puzzlegames"],
    officialChannels: [],
    steamAppIds: [],
    steamLanguage: "all",
    youtubeCreatorCountries: ["US", "AU", "JP", "KR", "GB", "CA"],
    adSpendRates: {
      cpvByFormat: { dedicated: 0.20, preRoll: 0.04, shorts: 0.04 },
      cpmUsd: 20,
    },
    platforms: ["YouTube", "Reddit", "Discord", "X", "Web"],
    freshnessDays: 14,
    communityRefreshHours: 24,
    requireObservedPublishedIso: true,
    blockedSocialHosts: ["facebook.com", "m.facebook.com", "fb.com"],
    officialApiRequiredSources: ["X", "Facebook"],
  },
  contract: { templateAttached: true, templateFile: "표준_인플루언서_계약서_v3.pdf", startRatio: 60, targetRatio: 80, exclusivityDays: 21, payTermDays: 14 },
  negotiationCriteria: {
    minFollowers: 30000,
    maxFollowers: 50000000,
    recentViewsDays: 30,
    minRecentViews: 5000,
    maxRecentViews: 50000000,
    minEngagementPct: 1,
    maxEngagementPct: 20,
    maxRounds: 4,
    cadenceDays: 3,
    walkAwayPct: 110,
    nearGuidePct: 90,
    allowedTemplateRefs: ["tpl-influencer-v3", "tpl-agency-v2"],
  },
  negotiationPricing: {
    currency: "KRW",
    viewWindowDays: 30,
    startingOfferRatioPct: 60,
    targetOfferRatioPct: 80,
    maxAutoOfferRatioPct: 90,
    humanReviewAboveRatioPct: 95,
    bands: [
      { id: "nano", label: "Nano", minFollowers: 0, maxFollowers: 50000, minRecentViews: 0, maxRecentViews: 25000, targetCPMKRW: 10000, minKRW: 150000, maxKRW: 700000 },
      { id: "mid", label: "Mid", minFollowers: 50000, maxFollowers: 500000, minRecentViews: 25000, maxRecentViews: 300000, targetCPMKRW: 12000, minKRW: 500000, maxKRW: 2500000 },
      { id: "large", label: "Large", minFollowers: 500000, maxFollowers: 5000000, minRecentViews: 300000, maxRecentViews: 2000000, targetCPMKRW: 9000, minKRW: 2000000, maxKRW: 12000000 },
      { id: "mega", label: "Mega", minFollowers: 5000000, maxFollowers: 50000000, minRecentViews: 2000000, maxRecentViews: 50000000, targetCPMKRW: 7000, minKRW: 10000000, maxKRW: 60000000 },
    ],
  },
  llmModelRoutes: {
    mail_gateway_triage: {
      label: "메일 분류·검수 게이트",
      source: "functions/chat-ai.ts",
      costModel: "gemini-2.5-flash-lite",
      // 26-09-24 [헤세 결정]: gemini-2.5-pro는 비용 사유로 퇴역 — quality 모드도 flash로.
      currentModel: "gemini-2.5-flash",
      premiumModel: "gemini-2.5-flash",
      mode: "quality",
      reason: "법적 리스크·거절·태도 변화는 정밀 판단 후 사람 검수로 넘깁니다.",
    },
    auto_reply_draft: {
      label: "자동 회신 초안",
      source: "functions/chat-ai.ts",
      costModel: "gemini-2.5-flash",
      // 26-09-24 [헤세 결정]: gemini-2.5-pro는 비용 사유로 퇴역 — quality 모드도 flash로.
      currentModel: "gemini-2.5-flash",
      premiumModel: "gemini-2.5-flash",
      mode: "quality",
      reason: "실제 발송 전 이메일-only 정책, 운영 가이드, 톤 태그를 지켜야 합니다.",
    },
    knowledge_ingest: {
      label: "지식 적재 모델 라우트 (미연결)",
      source: "runtime consumer 없음",
      costModel: "gemini-2.5-flash-lite",
      currentModel: "gemini-2.5-flash-lite",
      premiumModel: "gemini-2.5-flash",
      mode: "cost",
      reason: "현재 knowledgeGraph 적재는 결정론적 저장 경로이며 이 모델 설정을 읽지 않습니다.",
    },
    candidate_discovery: {
      label: "후보 탐색 모델 라우트 (미연결)",
      source: "runtime consumer 없음",
      costModel: "minisearch-bm25",
      currentModel: "minisearch-bm25",
      premiumModel: "gemini-2.5-flash",
      mode: "cost",
      reason: "현재 후보 탐색 런타임은 이 토글을 읽지 않습니다. 연결 전까지 UI에서 변경할 수 없습니다.",
    },
  },
  policy: {
    cacheTtlSeconds: POLICY_CACHE_TTL_SECONDS,
    firestorePath: "settings/default",
    writableThrough: ["functions.updateSettings", "functions.refreshPolicyCache"],
  },
  guideLinks: {
    costGuide: { route: "/flu/cost-guide", source: "contract.templateFile", cacheKey: "settings:cost-guide:v1" },
    negotiationGuide: { route: "/flu/contracts", source: "contract.startRatio,targetRatio,exclusivityDays,payTermDays", cacheKey: "settings:negotiation-guide:v1" },
  },
};

export type Settings = typeof SETTINGS;
export type SettingsKey = keyof Settings;
