import { envEmail } from "./opsDefaults";
import { DEFAULT_IMAP_BATCH_SIZE, DEFAULT_IMAP_MAX_RUN_SECONDS } from "./mailImapThroughput";
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
    // Explicit mailbox allowlist for the inbound auto-reply human-approval exception.
    // Empty is fail-closed; this never applies to outbound/campaign mail.
    inboundAutoReplyAllowedMailAccountIds: [] as string[],
    negotiationAutomation: true,
    contractDraftAutomation: true,
    reviewAutomation: true,
    liveSendEnabled: false,
    humanApprovalRequired: true,
    // auto-reply-approval-bypass (2026-09-25, 헤세 결정 "자동응답만 예외"): 캠페인 메일 프로필의
    // humanApprovalRequired=true 는 아웃바운드 이니셔티브(콜드메일·독려·캠페인 발송)엔 계속
    // 하드 게이트로 적용된다. 이 킬스위치는 auto_reply 레인 하나만 예외로 둔다 — 케이스북
    // auto_ok + armed permit + JEV 발송결정(또는 interest_next_steps 상시발송 허용목록)까지 전부
    // 통과한 크리에이터 REPLY 자동응답만 대상(chat-ai.ts sendAutoReplyJob의 Permit provenance
    // 게이트 재사용). false 로 끄면 이 예외 없이 종전처럼 신뢰된 IMAP 인바운드만 예외를 받는다.
    // 기본 true(헤세 명시 결정).
    autoReplyBypassesProfileHumanApproval: true,
    minReplyDelayMinutes: 60,
    // F-3(AUTO-MAIL-SAFETY-DESIGN-2026-09-16.md §D): minReplyDelayMinutes 위에 얹는 균등분포
    // 지터 상한 — 60~180분 창(기본 120)으로 흩어 "정확히 60분 뒤 자동응답"이 봇처럼 읽히지
    // 않게 한다. computeAutoReplySendAfter()가 소비.
    autoReplyJitterMaxMinutes: 120,
    // 자동 회신은 KST 평일 영업시간에만 발송(fail-safe 기본 enabled:true). 창 밖(주말·야간)이면
    // 다음 창 시작 + U(0,spread)분으로 미뤄 정각 몰림을 피한다. GAP fix(auto-reply-pacing
    // 2026-09-17): processAutoReplyQueue의 autoReplyIsDue도 발송 "시점"에 이 창을 재검증한다 —
    // 창 밖이면 claim하지 않고 다음 창까지 그대로 둔다(72h 만료가 이보다 먼저 적용된다).
    autoReplyBusinessHoursKst: { enabled: true, startHour: 10, startMinute: 0, endHour: 18, endMinute: 30, weekdaysOnly: true },
    // auto-reply-pacing(2026-09-17): 몰림 방지 U(0,spread)의 spread(분). 고정 90분이던 것을
    // 설정 가능하게 뺐다 — bounds 30~360, autoReplySendWindow.ts가 방어적으로 클램프한다.
    autoReplyBurstSpreadMinutes: 150,
    // 헤세+아키텍트 리뷰 결정(2026-09-17, 페이싱 정책): 운영 문서 값은 별도로 세팅됨 — 이
    // 기본값은 20에서 상향(버스트 방지용 시간당/패스당 캡이 새로 생겨 일일 캡만으로 페이싱을
    // 통제할 필요가 줄었다).
    maxDailyAutoSends: 40,
    // auto-reply-pacing(2026-09-17): 한 sweep 패스(5분 주기)당 claim/발송 상한. bounds 1~50 —
    // processAutoReplyQueue가 방어적으로 클램프한다. 남은 due 잡은 다음 패스로 이월된다.
    maxAutoRepliesPerPass: 10,
    // auto-reply-pacing(2026-09-17): outreach와 별개인 auto_reply 전용 시간당(Asia/Seoul) 캡.
    // bounds 1~200 — processAutoReplyQueue가 방어적으로 클램프한다.
    maxHourlyAutoSends: 20,
    // Cold/bulk outreach (campaign_outreach) per-day send cap, enforced by
    // processCampaignOutreachQueue on the Asia/Seoul calendar day (warmup-safe default).
    maxDailyOutreachSends: 50,
    // Total cap for one live campaign wave. Unlike the daily counter, this is
    // campaign-scoped and does not reset on the next calendar day.
    maxLiveCampaignWaveSends: 50,
    // Optional operator batch cap across multiple live campaigns. Inert unless
    // both id is non-blank and cap is > 0.
    liveSendBatchId: "",
    maxLiveSendBatchSends: 0,
    campaignAutoDiscoveryResultCap: 50,
    // R30-2 [사용자 승인]: 발굴 키워드 확장의 LLM 제안기 킬스위치. **기본 false** — 배포 후 리더가
    // 켠다. false 면 모델 호출 0(캐시 조회도 하지 않는다). 꺼져 있어도 기존 n-gram 마이너는
    // 종전대로 돈다(R30-3 폴백).
    keywordLlmExpansionEnabled: false,
    // AI-DRAMA-DISCOVERY-METAPROMPT W1: 고정 검색 우주 조직 — 확장 결정부(admin.ts
    // enqueueShortfallDiscoveryJob)가 이 목록의 ownerOrgId를 만나면 n-gram 마이닝·LLM 제안 두
    // 레인 모두 스킵하고 우주는 캠페인의 includeKeywords만 유지한다. 기본 빈 배열 — 아무 조직도
    // 이 목록에 없으면 기존 자가확장 동작 그대로(회귀 0). 기존 expandedKeywords 값은 이 게이트로
    // 지워지지 않는다(신규 추가만 차단).
    keywordExpansionDisabledOrgIds: [] as string[],
    // 헤세 요구(auto-reply-org-controls, 2026-09-24): T049(AI Drama) 는 어떤 자동응답 경로(케이스북
    // auto_ok, interest_next_steps 즉시발송 허용목록, 가격 가이드 리다이렉트, 역제안 가이드라인,
    // 백로그 requeue)로도 자동 발송돼서는 안 된다 — 이 목록은 keywordExpansionDisabledOrgIds와 달리
    // **기본값에 이미 "T049"가 들어 있다**(안전 최우선 디폴트, 운영자가 명시적으로 빼야만 해제됨).
    // mailHumanGate.isAutoReplyOrgExcluded 가 유일한 판정부다 — 대화는 여전히 정상적으로 사람
    // 검토로 넘어간다(발송만 막는다).
    autoReplyDisabledOrgIds: ["T049"] as string[],
    // "미답장 인박스 dismiss" (2026-09-26, 헤세 결정): 영업/에이전시 아웃리치
    // (mailHumanGate.DISMISS_ON_NO_REPLY_RULE_IDS 단독 매치)나 scp 미등록 발신자
    // (sender_not_creator, scp/canonical 전용)는 답장 없이 Gmail 읽음 처리만 하고 미답장
    // 인박스(listUnrepliedInbox)에서 뺀다 — "계속 쌓아두지 말고"(헤세). 기본 true. false 로
    // 끄면 종전처럼 waiting_for_human 으로 쌓인다. /flu/settings 자동화 카드에서 토글한다.
    dismissAgencyAndUnregisteredSenderMail: true,
    // 헤세 결정 2026-09-16: 프로그램 스코프 독립 — XP Hero 수신자를 Snake Clash×Pororo 캠페인에서
    // 재사용할 수 있게 하는 운영자 옵트인 토글("global" | "program"). **기본 "global"**(종전 R5-B
    // 전역 차단 그대로) — 이 배포 자체는 아무 것도 바꾸지 않는다. "program"으로 켜면 같은 프로그램
    // 안에서의 재발송만 막고 서로 다른 프로그램은 독립적으로 콜드메일한다
    // (programOutreachDedup.ts resolveOutreachDedupScope가 판정, 키 없음/오타는 fail-closed로
    // "global"이다).
    outreachDedupScope: "global",
    // Task-95 §4: 신청자 자격 자동 판정의 "적용" 게이트. 판정 자체(applicationEligibilityJudge)와
    // 원장 기록은 이 플래그와 무관하게 항상 돈다 — 이 값은 오직 "판정 결과를 실제로 브리지에
    // 적용하느냐"만 막는다. **기본 둘 다 false**(판정만, 사람 큐로만 나간다).
    applicationAutoDecision: {
      autoRejectEnabled: false,
      // 하드 OFF — 코드 발급 시점 확정(TICKET-MAP §3 결정 #5) 전에는 이 값이 true 여도
      // applicationEligibilityJudgeSweep.ts 가 절대 읽지 않는다(approve = 코드 발급이 한
      // 트랜잭션이라 승인 자동 적용은 물리적으로 금지).
      autoApproveEnabled: false,
    },
    // Task-94: 결정론적 자동 검수/반려 토글. **기본 false**(하드 룰) — 운영자 취소(undo)와
    // 크리에이터 이의제기(appeal) 경로가 코어에 갖춰진 뒤에만 켠다(티켓 자체 규칙,
    // videoReviewAutoRejectCore.ts + videoReviewTransitionCore.ts 의 rejected→human_review_required
    // undo edge). minDurationSeconds 는 R5(20초 미만 반려) 판정 기준값.
    videoReview: { autoRejectEnabled: false, minDurationSeconds: 20 },
    // Task-91 확장 ④: SCP 상태 문의(신청 상태·크리에이터 코드·검수 결과·정산) 유형별 자동응답
    // 토글 — 리포 불변식(draft_only 기본)에 따라 **전부 기본 false**. 유형별 결정: 켜는 건 사람의
    // 데이터 쓰기(scpInquiryClassifier.ts/scpInquiryFactResolver.ts). autoReplyEnabled·permit arm
    // 조건은 이 토글 위에 그대로 얹힌다 — 이 토글은 추가 제약이지 대체가 아니다.
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
    // 2026-10-03 (헤세 결정): 보낸 주소와 발신자가 정확히 일치(검증)하면 프로그램 귀속이 미해결이어도 일반 케이스북 템플릿 자동 회신 허용.
    // 즉시 끄는 킬스위치 — super_admin 만 변경(settings 저장 경로가 강제), 발송 시점에도 재확인.
    allowIdentityOnlyAutoReply: true,
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
    escalationInbox: envEmail("FLU_ESCALATION_INBOX"),
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
      costModel: "gemini-3.1-flash-lite",
      currentModel: "gemini-3.1-flash-lite",
      // 26-09-24 [헤세 결정]: gemini-2.5-pro는 비용 사유로 퇴역 — quality 모드도 flash로.
      premiumModel: "gemini-2.5-flash",
      mode: "cost",
      reason: "W31: 분류(triage+intent)는 저가 모델로 — 최종 게이트 판정은 로컬 결정론 규칙이 확정하며 이 모델 출력에 의존하지 않습니다.",
    },
    auto_reply_draft: {
      label: "자동 회신 초안",
      source: "functions/chat-ai.ts",
      costModel: "gemini-2.5-flash",
      currentModel: "gemini-2.5-flash",
      // 26-09-24 [헤세 결정]: gemini-2.5-pro는 비용 사유로 퇴역 — quality 모드도 flash로.
      premiumModel: "gemini-2.5-flash",
      mode: "quality",
      reason: "실제 발송 전 이메일-only 정책, 운영 가이드, 톤 태그를 지켜야 합니다.",
    },
    // R30-2 [사용자 승인]: 키워드 확장 LLM 제안기 라우트. **가용 최저가 모델**(Flash-Lite)을 쓴다 —
    // 하루 1콜·JSON 20개짜리 태스크에 상위 모델을 태울 이유가 없다. 라우트가 없으면 제안기는 호출하지
    // 않고 스킵한다(fail-closed). 실행 자체는 킬스위치
    // settings.automation.keywordLlmExpansionEnabled(기본 false)로 따로 잠겨 있다.
    keyword_expansion: {
      label: "발굴 키워드 확장 제안 (하루 1콜)",
      source: "functions/keywordLlmExpansion.ts",
      costModel: "gemini-2.5-flash-lite",
      currentModel: "gemini-2.5-flash-lite",
      premiumModel: "gemini-2.5-flash",
      mode: "cost",
      reason: "우주 밖 어휘 20개 제안. 산출은 R29 검증층을 그대로 통과해야 채택됩니다.",
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
  // ── IMAP 수신 인제스트 설정 ──
  // batchSize: 라이브+큐 합산 한 번의 IMAP 실행 최대 메일 수 (기본 50, 최대 200)
  // maxRunSeconds: 단일 IMAP 실행의 최대 허용 시간(초) (lane S-H1이 읽음, 없을 때 기본값 240)
  // 아래 ramp-up/jitter 설정은 mailSafety.outboundPolicy.rampUpPlan + jitter* 필드로 관리됨
  //   rampUpPlan: [{ day, dailyCap }] — 점진적 발송량 증가 플랜
  //   jitterMinSeconds / jitterMaxSeconds — 발송 간 무작위 지연 범위
  email: {
    imap: {
      batchSize: DEFAULT_IMAP_BATCH_SIZE,
      maxRunSeconds: DEFAULT_IMAP_MAX_RUN_SECONDS,
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
