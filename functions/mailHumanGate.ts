export type HumanGate = {
  // auto_close (auto-close 파일럿, 케이스북 closing_acknowledgment 거울): 순수 종결 인사.
  //   auto_reply 와 달리 어떤 초안·발송·검수 큐도 만들지 않고 스레드를 종결 처리한다.
  //   결정체인에서 needs_review 와 같은 "비-발송" 취급이지만 검수 인박스는 오염시키지 않는다.
  decision: "auto_reply" | "needs_review" | "blocked" | "auto_close";
  reason: string;
  ruleIds: string[];
};

export const GENERATED_DRAFT_POLICY_VERSION = "generated-draft-safety-v1";
// v2 (auto-close 정책 B): gratitude_only_* 시나리오의 기대 판정이 needs_review → auto_close 로
//   개정됐다 (케이스북 closing_acknowledgment + isClosingAcknowledgment 거울).
export const GENERATED_DRAFT_EVAL_DATASET_VERSION =
  "generated-draft-safety-eval-v2";

export type GeneratedDraftSafetyEvidence = {
  policyVersion: typeof GENERATED_DRAFT_POLICY_VERSION;
  datasetVersion: typeof GENERATED_DRAFT_EVAL_DATASET_VERSION;
  ruleId: string;
};

export type GeneratedDraftSafetyDecision =
  | { allowed: true }
  | {
      allowed: false;
      humanGate: HumanGate;
      evidence: GeneratedDraftSafetyEvidence;
    };

type GeneratedDraftSafetyRule = {
  readonly ruleId: string;
  readonly reason: string;
  readonly pattern: RegExp;
};

// Model output is untrusted even after schema validation. These rules are
// intentionally deterministic and return only canonical evidence: never the
// matched draft, amount, address, secret, or provider response.
const GENERATED_DRAFT_SAFETY_RULES: readonly GeneratedDraftSafetyRule[] = [
  {
    ruleId: "generated-draft.sensitive-data",
    reason: "generated draft contains sensitive contact or secret material",
    pattern:
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:api[_-]?key|access[_-]?token|secret|password|private[_-]?key)\s*[:=]\s*[^\s,;]+/i,
  },
  {
    ruleId: "generated-draft.metric-manipulation",
    reason: "generated draft encourages artificial engagement manipulation",
    pattern:
      /\b(?:buy|purchase|fake|inflate|artificially\s+(?:boost|increase)|use\s+bots?)\b.{0,48}\b(?:views?|likes?|comments?|followers?|subscribers?|engagement)\b|\b(?:bots?|click\s*farms?)\b.{0,36}\b(?:views?|likes?|comments?|followers?|subscribers?)\b|(?:조회수|좋아요|댓글|팔로워|구독자).{0,24}(?:봇|조작|구매|부풀리|인위적)|(?:봇|조작|구매).{0,24}(?:조회수|좋아요|댓글|팔로워|구독자)|(?:comprar|inflar|bots?).{0,36}(?:vistas|me gusta|comentarios|seguidores)|(?:再生数|高評価|コメント|フォロワー).{0,24}(?:ボット|水増し|購入)/i,
  },
  {
    ruleId: "generated-draft.disclosure-evasion",
    reason: "generated draft attempts to hide or omit advertising disclosure",
    pattern:
      /\b(?:hide|omit|remove|skip|do\s+not|don['’]?t)\b.{0,52}\b(?:ad(?:vertising)?\s+disclosure|sponsor(?:ed|ship)?\s+(?:label|disclosure)|paid\s+partnership|advertisement)\b|\b(?:do\s+not|don['’]?t)\s+mention\b.{0,36}\b(?:advertising|sponsored|sponsorship|paid)\b|(?:광고|협찬|스폰서|유료\s*광고).{0,28}(?:숨기|누락|빼|표기하지|고지하지|말하지)|(?:숨기|누락|표기하지|고지하지).{0,28}(?:광고|협찬|스폰서)|(?:no\s+menciones?|oculta|omite).{0,44}(?:publicidad|patrocinio|anuncio)|(?:広告|スポンサー|PR).{0,28}(?:隠|表記しない|記載しない|書かない)/i,
  },
  {
    ruleId: "generated-draft.rights-violation",
    reason: "generated draft encourages unauthorized copyright or portrait use",
    pattern:
      /\b(?:use|include|copy|reupload)\b.{0,64}\b(?:celebrity|movie|tv|third[- ]party|someone(?:\s+else)?['’]s|face|voice|clip|footage)\b.{0,40}\b(?:without\s+(?:permission|consent|approval)|unauthori[sz]ed)\b|\b(?:without\s+(?:permission|consent|approval)|unauthori[sz]ed)\b.{0,64}\b(?:celebrity|movie|tv|third[- ]party|face|voice|clip|footage)\b|(?:유명인|영화|TV|타인|제3자|얼굴|목소리|클립|영상).{0,36}(?:허락|동의|승인).{0,12}(?:없이|없이\s*사용|받지\s*않고)|(?:허락|동의|승인)\s*없이.{0,36}(?:사용|포함|업로드)|(?:sin\s+permiso|sin\s+consentimiento).{0,48}(?:clips?|pel[ií]cula|rostro|voz)|(?:許可|同意)なく.{0,36}(?:使用|掲載|アップロード)/i,
  },
  {
    ruleId: "generated-draft.payment-promise",
    reason: "generated draft makes an unauthorized payment or final-rate promise",
    pattern:
      /\b(?:guarantee|promise)\s+(?:the\s+)?payment\b|\b(?:confirm(?:ed)?\s+(?:the\s+)?final\s+rate|final\s+rate\s+(?:is|has\s+been\s+approved|is\s+confirmed)|payment\s+is\s+guaranteed)\b|(?:최종\s*(?:단가|금액|보상)).{0,28}(?:확정|승인|보장)|(?:지급|결제|보상).{0,20}(?:보장|확정)|(?:garantizamos?|prometemos?).{0,32}(?:pago|tarifa\s+final)|(?:最終報酬|最終金額|支払い).{0,28}(?:確定|保証)/i,
  },
  {
    ruleId: "generated-draft.platform-policy-evasion",
    reason: "generated draft encourages bypassing platform policy",
    pattern:
      /\b(?:ignore|bypass|evade|circumvent|work\s+around)\b.{0,48}\b(?:youtube|platform|community|advertising)\s+(?:policy|policies|guidelines?|rules?)\b|(?:유튜브|플랫폼|커뮤니티|광고).{0,32}(?:정책|가이드라인|규정).{0,20}(?:우회|무시|회피)|(?:우회|무시|회피).{0,32}(?:유튜브|플랫폼|정책|가이드라인)|(?:ignora|elude|evita).{0,44}(?:pol[ií]tica|normas?|directrices?).{0,16}(?:plataforma|youtube)?|(?:YouTube|プラットフォーム|コミュニティ).{0,28}(?:ポリシー|ガイドライン|規約).{0,20}(?:無視|回避)/i,
  },
] as const;

export function evaluateGeneratedDraftSafety(
  draft: string,
): GeneratedDraftSafetyDecision {
  const normalized = typeof draft === "string" ? draft.slice(0, 20_000) : "";
  for (const rule of GENERATED_DRAFT_SAFETY_RULES) {
    if (!rule.pattern.test(normalized)) continue;
    return {
      allowed: false,
      humanGate: {
        decision: "needs_review",
        reason: rule.reason,
        ruleIds: [rule.ruleId, "model-draft-safety"],
      },
      evidence: {
        policyVersion: GENERATED_DRAFT_POLICY_VERSION,
        datasetVersion: GENERATED_DRAFT_EVAL_DATASET_VERSION,
        ruleId: rule.ruleId,
      },
    };
  }
  return { allowed: true };
}

export type HumanReviewPolicy = {
  lowDataReviewMode?: "strict" | "balanced" | "lenient" | string;
  minEvidenceScore?: number;
  minSignalsForAutoReply?: number;
  autoReplyConfidenceThreshold?: number;
  ambiguousReviewRatePct?: number;
  requireFollowersForPricing?: boolean;
  requireRecentViewsForPricing?: boolean;
  /**
   * W76-③ 자동 안내: **안전 안내 회신에 한해** 크리에이터 증거 부족 강등을 면제한다.
   *
   * 배경: lowDataReviewMode 기본값 strict 는 증거점수 80·신호 3개를 요구한다. 콜드메일에
   *   막 답장한 크리에이터는 우리 원장에 거의 아무 근거가 없으므로 이 문턱을 사실상 못 넘고,
   *   그 결과 **auto_reply 가 구조적으로 도달 불가**였다(=자동 안내가 영원히 안 나간다).
   *   그런데 여기서 막히는 회신은 "어떻게 신청하나요" 같은 안내 요청이다 — 가격·조건을
   *   확정하는 회신이 아니라 가이드 링크를 돌려주는 것이라, 크리에이터 증거의 양과 무관하다.
   *
   * 그래서 면제는 **eval 이 안전 안내로 분류한 회신에만** 적용한다(SAFE_INFO_AUTO_REPLY_RULE_IDS).
   *   가격·커밋 관련 강등(requireFollowersForPricing 등)과 blocked/needs_review 분류는 그대로다.
   *   기본값은 꺼짐 — 켜는 것은 데이터 쓰기라 사람이 판단해서 켠다.
   */
  allowLowDataAutoReplyForSafeInfo?: boolean;
  /**
   * 2026-09-24 (헤세 지시 — 가격/예산 문의 가이드 리다이렉트): 순수 가격·예산·단가 문의
   *   (구체 counter-offer·조건 제안 없음)에 달린 `budget-amount-human-review` 홀드만
   *   면제해, 헤세가 실제로 수동 발송해온 것과 같은 "내부 정책상 가이드 페이지를
   *   확인해달라"는 정본 안내로 자동 응답할 수 있게 한다.
   *
   * 배경: `hasCurrencyAmount()`(decideHumanGate)는 스레드 어딘가(우리 쪽 콜드메일 인용문
   *   포함)에 통화 기호/숫자가 있기만 해도 이 세션 전체를 `budget-amount-human-review`로
   *   묶어 needs_review 로 고정한다 — 모델/케이스북은 아예 상담되지 않는다(로컬 게이트가
   *   이미 auto_reply 가 아니므로). 이 토글은 오직 그 **결정론적 통화-토큰 홀드**만 풀고,
   *   금액/조건을 직접 제안·역제안하는 협상 문구(`budget-or-rate-human-review` 등
   *   HUMAN_REVIEW_RULES)는 절대 건드리지 않는다 — `liftBudgetInquiryHoldForGuideRedirectCase`
   *   가 그 구분을 독립적으로 재확인한다.
   *
   * 기본값은 꺼짐 — 켜는 것은 데이터 쓰기라 사람이 판단해서 켠다.
   */
  allowGuideRedirectForPricingInquiry?: boolean;
  /**
   * 2026-09-24 (헤세 지시 — 역제안 가이드라인 금액 고정회신): "역제안일 때는 우선 우리
   *   가이드라인 금액을 말해주는 형태로 가자. 역제안 절대 안 통하고." 창작자가 직접 금액을
   *   역제안·인상 요청해도(계약/법무/정산분쟁/통화/에이전시/독점권 등 다른 홀드가 섞이지 않은
   *   순수 단가 제안이면) `budget-amount-human-review`/`budget-or-rate-human-review` 단독
   *   홀드만 면제해, 그 제안에 동의·조율하지 않고 우리 쪽 고정 공개 가이드라인 금액
   *   ({{GUIDELINE_AMOUNT}}, 서버 렌더)만 안내하는 자동 회신을 보낼 수 있게 한다.
   *
   * `liftCounterOfferHoldForGuidelineAmountCase` 가 그 구분(제외 카테고리·역제안 신호)을
   *   독립적으로 재확인한다 — allowGuideRedirectForPricingInquiry 와는 별개의 토글이다
   *   (전자는 "숫자를 전혀 말하지 않는" 순수 문의, 이것은 "역제안에 우리 숫자로 답하는" 경로).
   *
   * 기본값은 꺼짐 — 켜는 것은 데이터 쓰기라 사람이 판단해서 켠다.
   */
  allowGuidelineReplyForCounterOffer?: boolean;
  /**
   * 2026-09-24 (헤세 지시 — interest_next_steps 즉시발송): 관심/지원 의사 표현("I'm interested",
   *   "how do I apply/join")은 JEV 상담 결과와 무관하게 즉시 자동발송한다. jevSendDecisionFor
   *   (chat-ai.ts)가 이 목록에 있는 caseId + escalation auto_ok + 하드룰 카테고리 비공존일 때만
   *   JEV 콜 자체를 건너뛰고 합성 send 판정을 돌려준다 — 옵트아웃/억제·메일세이프티·영업시간·
   *   캡·차단 판정은 이 목록과 무관하게 그대로 후행한다.
   *
   * 설정으로 확장/축소 가능한 목록이며, 값이 없으면(undefined) 기본값
   *   `["interest_next_steps"]`(chat-ai.ts DEFAULT_JEV_ALWAYS_SEND_CASE_IDS)를 쓴다. 명시적
   *   빈 배열([])은 허용목록을 완전히 끈다.
   */
  jevAlwaysSendCaseIds?: string[];
  /**
   * 2026-09-29 (헤세 지시 — scp@ 프로드 사고, incident-2026-09-29-chat/five-auto-candidates.md):
   *   순수 "지원/계정 승인 여부·시점" 문의에 달린 `contract-rights-human-review` 홀드만
   *   면제해, 고정 기한·승인을 약속하지 않고 포털에서 상태를 확인하라는 정본 안내로 자동
   *   응답할 수 있게 한다.
   *
   * 배경: contract-rights-human-review 는 "sign"/"contract"/"terms" 등 계약과 무관한 뜻으로도
   *   흔히 쓰이는 bare 단어들을 그대로 매치하는 블런트한 로컬 휴리스틱이다(예: "I signed up a
   *   week ago" 의 "signed"). 이 토글은 모델이 전체 문맥을 읽고 독립적으로
   *   `approval_status_inquiry` 로 확신 분류했을 때만, 그리고 이 규칙을 제외한 다른 모든
   *   HUMAN_REVIEW_RULES/옵트아웃/법적위협 신호가 없을 때만 이 특정 홀드를 면제한다 —
   *   `liftApprovalStatusHoldForGuideRedirectCase` 가 그 구분을 독립적으로 재확인한다.
   *
   * 기본값은 꺼짐 — 켜는 것은 데이터 쓰기라 사람이 판단해서 켠다.
   */
  allowGuideRedirectForApprovalStatusInquiry?: boolean;
  /**
   * 2026-10-03 (헤세 결정 — contact_channel_request 자동 회신): "WhatsApp/Telegram/Discord 로 연락하자"는 요청에
   *   "메신저는 쓰지 않고 가이드 탭 챗봇·이메일로만 소통한다"는 고정 안내(서버 렌더 템플릿)로 자동 회신한다.
   *   로컬 게이트의 `email-only-no-call-human-review` **단독** 홀드만 면제하며, 원문이 실제로 메신저 이동을
   *   요청하는지(서명·부정문 제외) 독립 재검증한다 — `liftEmailOnlyHoldForContactChannelRedirectCase`.
   *   대행사·금액·계약·정산·옵트아웃·억제·sender_not_creator·증거 게이트·JEV 는 전부 그대로 후행한다.
   *   기본값은 꺼짐 — 켜는 것은 super_admin 만(settings 저장 경로가 강제).
   */
  allowEmailOnlyRedirectForContactChannelRequest?: boolean;
  /**
   * 2026-10-03 (헤세 결정, 기본 켜짐): 발신자가 우리가 실제 보낸 그 주소로 검증(From == 발송 To)되면 프로그램/캠페인 귀속이
   * 미해결이어도 프로그램 사실이 필요 없는 일반 케이스북 템플릿 자동 회신을 허용한다(senderIdentityBinding.bindingScope
   * "identity_only"). 명시적 false 만 끈다 — 즉시 차단 킬스위치이며 super_admin 만 변경, 발송 시점에 재확인한다.
   */
  allowIdentityOnlyAutoReply?: boolean;
};

export type NegotiationPricingBand = {
  id: string;
  label: string;
  minFollowers: number;
  maxFollowers: number;
  minRecentViews: number;
  maxRecentViews: number;
  targetCPMKRW: number;
  minKRW: number;
  maxKRW: number;
};

export type NegotiationPricingPolicy = {
  currency?: string;
  viewWindowDays?: number;
  startingOfferRatioPct?: number;
  targetOfferRatioPct?: number;
  maxAutoOfferRatioPct?: number;
  humanReviewAboveRatioPct?: number;
  bands?: NegotiationPricingBand[];
};

export type HumanGateContext = {
  creatorFollowers?: number;
  creatorRecentViews?: number;
  creatorEngagementPct?: number;
  // undefined means the inbound parser did not prove attachment state (for example parser fallback).
  hasInboundAttachments?: boolean;
  humanReviewPolicy?: HumanReviewPolicy;
  negotiationPricing?: NegotiationPricingPolicy;
  // auto-close 정책(B) fail-safe (F5): 게이트 입력 신호가 clip 상한에서 잘렸으면 true —
  //   잘린 꼬리에 질문·요청이 숨어 있을 수 있으므로 종결(auto_close)을 금지하고 검수로 보낸다.
  signalTruncated?: boolean;
};

// 프로그램별 메일 템플릿 — programs/{id}.mailTemplate 에서 해석한 톤·콘텐츠 태그.
// 자동 회신 초안 본문을 이 톤/순서로 렌더한다(이메일 전용, id/추적값 본문 미노출).
export type MailTemplateRender = {
  tone: string;
  contentTags: string[];
  programTitle?: string;
};

export type EvidenceScore = {
  score: number;
  signalCount: number;
  signals: string[];
};

export type PriceNegotiation = {
  bandId: string;
  bandLabel: string;
  currency: string;
  followerRange: string;
  recentViewRange: string;
  estimatedGuideKRW: number;
  startingOfferKRW: number;
  targetOfferKRW: number;
  maxAutoOfferKRW: number;
  needsHumanReview: boolean;
};

type HumanReviewRule = {
  readonly ruleId: string;
  readonly reason: string;
  // Anything with a RegExp-style test(): the email-only rule is a contextual matcher (calls + messenger transfers).
  readonly pattern: { test(value: string): boolean };
};

// F/U-2 (meet-overmatch): "meet" 는 두 뜻이다 — 미팅(만나다) vs 요건 충족(meet the requirements).
//   자격·요건 안내 초안은 "confirm you meet the requirements" 같은 충족 용법을 자연스럽게 쓰는데
//   벌어 \bmeet\b 가 이를 통화 요청으로 오탐해 eligibility_question eval·실발송을 계통적으로
//   needs_review 로 강등시켰다(2026-09-22 prod eval 3/6 실패의 직접 원인). 충족 명사 앞의 meet 만
//   제외하고 "meet to discuss the requirements" 같은 진짜 미팅 제안은 여전히 잡는다({0,2} 한정자는
//   그 문맥을 커버하지 않음). "call" 은 관측된 오탐이 없어 그대로 둔다.
const MEET_AS_SATISFY_EXCLUSION =
  "(?!\\s+(?:\\w+\\s+){0,2}(?:requirements?|criteria|eligibility|conditions?|thresholds?|standards?|guidelines?|minimums?|qualifications?|expectations?)\\b)";
const CALL_MEETING_PATTERN = new RegExp(
  // v7 (2026-09-24, 코덱스 적대 리뷰 counter_offer_guideline_reply 1·2회차): "voice chat"/"video chat"
  // /"audio chat" 는 기존 목록("call|meeting|...")의 단어경계 매치에 하나도 안 걸렸다("discuss by
  // voice/audio chat" 가 통화 요청인데도 사람 검토 규칙을 통과).
  // 8회차: "call"/"meeting" 은 복수형(calls/meetings)이 없었다 — \bcall\b 은 "calls" 안의
  // "call"(뒤에 곧바로 "s"가 붙어 단어경계 없음)을 매치하지 못한다("Could we discuss this on
  // video calls?"). 이 규칙이 다루는 모든 가산명사에 선택적 복수 s를 추가한다.
  `\\b(brief\\s+calls?|quick\\s+calls?|calls?|meetings?|meet${MEET_AS_SATISFY_EXCLUSION}|zoom|google\\s+meets?|phones?|calendars?|availability|available\\s+next\\s+week|schedule\\s+a\\s+call|hop\\s+on|voice\\s+chats?|video\\s+chats?|audio\\s+chats?|voice\\s+calls?|video\\s+calls?)\\b|통화|미팅|회의|전화|화상|줌|구글\\s*밋|캘린더|가능한\\s*시간|가능\\s*시간|보이스\\s*챗|음성\\s*채팅`,
  "i",
);

// classification_v1 (2026-10-03, review round 4): 외부 메신저(WhatsApp/Telegram/Discord/WeChat/KakaoTalk/LINE)는
//   **연락을 그쪽으로 옮기자는 요청 문맥**일 때만 이메일 전용 위반이다. 서명의 "WhatsApp: +82…"·"No WhatsApp needed"
//   같은 단순 언급/부정문은 요청이 아니다. 요청 문맥 = ①"add/contact/message me on X" ②"let's/can we talk/move/switch … on X"
//   ③"send/share your X number/id" ④"X me" ⑤"my X is/number" ⑥한국어 "X로 연락/이야기/추가…". 요청 구절 앞 같은 절에
//   부정어가 있으면 건너뛴다. 모델 초안 안전 검사(chat-ai.ts)도 같은 함수를 쓴다 — 초안이 메신저로 유도하는 것은 막고,
//   "메신저는 쓰지 않는다"는 안내 문구(정본 템플릿)는 통과한다.
const MESSENGER_NAMES = "whats\\s?app|telegram|discord|we\\s?chat|kakao\\s?talk|line\\s+(?:app|messenger|id)|signal\\s+app";
// A bare "LINE" is too generic for most contexts; it counts only right after "<verb> me on" (message me on LINE).
const MESSENGER_NAMES_WITH_BARE_LINE = `${MESSENGER_NAMES}|line`;
const MESSENGER_NAMES_KO = "왓츠앱|왓츠\\s*앱|텔레그램|디스코드|카카오\\s*톡|카톡|위챗|라인\\s*(?:앱|메신저|아이디)";
const MESSENGER_REQUEST_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b(?:add|contact|reach|message|msg|text|dm|ping|call|talk(?:\\s+to)?|chat(?:\\s+with)?|speak(?:\\s+with)?|write(?:\\s+to)?|connect(?:\\s+with)?|find|follow)\\s+(?:me|us)\\s+(?:on|via|through|in|at|using|over)\\s+(?:the\\s+)?(?:${MESSENGER_NAMES_WITH_BARE_LINE})\\b`, "gi"),
  new RegExp(`\\b(?:let'?s|can\\s+we|could\\s+we|shall\\s+we|we\\s+can|we\\s+could|why\\s+not|how\\s+about|better\\s+to|prefer\\s+to|prefer|easier\\s+to|move|switch|continue|talk|chat|discuss|speak|communicate|connect|reach\\s+out|get\\s+in\\s+touch)\\b[^.!?\\n]{0,40}?\\b(?:on|via|through|in|using|over|to|by)\\s+(?:the\\s+)?(?:${MESSENGER_NAMES})\\b`, "gi"),
  new RegExp(`\\b(?:send|share|give|provide|drop|text)\\s+(?:me\\s+)?(?:your|ur)\\s+(?:${MESSENGER_NAMES})\\b`, "gi"),
  new RegExp(`\\byour\\s+(?:${MESSENGER_NAMES})\\s+(?:number|no\\.?|id|handle|username|contact|account)\\b`, "gi"),
  new RegExp(`\\b(?:${MESSENGER_NAMES})\\s+(?:me|us)\\b`, "gi"),
  new RegExp(`\\b(?:my|our)\\s+(?:${MESSENGER_NAMES})\\s+(?:is|number|no\\.?|id|handle|username)\\b`, "gi"),
  new RegExp(`(?:${MESSENGER_NAMES_KO})\\s*(?:으로|로|에서)?\\s*(?:연락|문의|이야기|대화|소통|메시지|dm|친구\\s*추가|추가)`, "gi"),
  new RegExp(`(?:${MESSENGER_NAMES_KO})[^.!?\\n]{0,6}(?:주소|아이디|번호|id)`, "gi"),
];
const CLAUSE_BOUNDARY_PATTERN = /[.!?\n,;:—–]|\s-\s|\b(?:but|and|so|then|however|though|although|while|instead)\b/g;
const CLAUSE_NEGATION_PATTERN = /\b(?:no|not|never|without|don['’]?t|do\s+not|doesn['’]?t|does\s+not|won['’]?t|isn['’]?t|aren['’]?t|no\s+need|need\s+not|neither|nor)\b|(?:안\s|않|필요\s*없|말고|하지\s*마|하지\s*말)/i;

export function hasMessengerChannelRequest(text: string): boolean {
  const lower = text.toLowerCase();
  for (const pattern of MESSENGER_REQUEST_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(lower); match; match = pattern.exec(lower)) {
      // Negation must sit in the SAME clause as the request phrase ("there is no need to contact me on WhatsApp"):
      // sentence, comma/semicolon/colon/dash and contrast-conjunction boundaries all end a clause, so an unrelated
      // negation earlier ("I do not know how to submit, please contact me on WhatsApp") never cancels the request.
      const before = lower.slice(0, match.index);
      let clauseStart = 0;
      for (let boundary = CLAUSE_BOUNDARY_PATTERN.exec(before); boundary; boundary = CLAUSE_BOUNDARY_PATTERN.exec(before)) {
        clauseStart = boundary.index + boundary[0].length;
      }
      CLAUSE_BOUNDARY_PATTERN.lastIndex = 0;
      if (!CLAUSE_NEGATION_PATTERN.test(lower.slice(clauseStart, match.index))) return true;
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return false;
}

/** Call/meeting/availability tokens only (no messenger names) — a real call request is never a messenger redirect. */
export function hasCallOrMeetingRequest(text: string): boolean {
  return CALL_MEETING_PATTERN.test(text);
}

export const EMAIL_ONLY_NO_CALL_PATTERN: { test(value: string): boolean } = {
  test: (value: string) => CALL_MEETING_PATTERN.test(value) || hasMessengerChannelRequest(value),
};

// F/U-1 (mail-human-gate-substring-blocked-overmatch): 배달 실패(반송/제공자 차단/속도 제한)
// 신호는 배달 상태 문구에만 매칭해야 한다. 과거엔 seed 전체에서 "blocked"/"bounce"/"rate-limit"
// 단독 substring을 찾았는데, 이 seed는 실제 창작자 회신 본문뿐 아니라 conversationId/messageRef/
// trackingId/draftRef 같은 식별자도 ":"로 이어 붙인 문자열이라(chat-ai.ts의 seed 조립부 참고),
// "blocked from accessing the game build" 같은 정상 대화나 우연히 "blocked"를 포함한 식별자까지
// 배달 차단으로 오판해 발송을 영구 중단시켰다. 배달 상태 전용 어휘만 매칭하도록 좁힌다.
const DELIVERY_FAILURE_SIGNAL_PATTERN =
  /\b(?:delivery|message|mail|email)\s+(?:is\s+|was\s+)?blocked\b|\bblocked\s+by\s+(?:the\s+|our\s+)?(?:provider|smtp|mail\s*server|mailbox\s*provider|isp)\b|\bsmtp\s+blocked\b|\brate[\s-]?limited\b|\brate[\s-]?limit\s+(?:exceeded|reached)\b|\bbounced?\b|\bundeliverable\b|\bmail\s+delivery\s+fail(?:ed|ure)\b/i;

// W95: "raise (the rate)" — 협상 시도 실측 표현(리뷰 반례)인데 기존 목록에 없었다. 정찰제 하드 룰의 로컬 결정층 보강.
// auto-reply-risk-taxonomy (2026-09-17): "협상"(negotiate 의 한국어 대응어)이 빠져 있었다 —
// "단가 협상 가능한가요?" 류가 로컬 게이트만으로는 안 걸리고 모델 분류(fixed_terms_inquiry
// 클램프)에만 의존했다. 결정론적 방어선을 하나 더 세운다.
// v7 (2026-09-24, counter_offer_guideline_reply): SIMPLE_RATE_NEGOTIATION_PATTERN(순수 "더/다르게
//   달라" 어휘)과 PAYMENT_MECHANICS_PATTERN(인보이스·계좌송금·선입금/후불·net 30·독점요율·바이아웃
//   등 지급 방식·시기·구조 어휘)으로 쪼갠 뒤 합쳐 만든다. 최초 분리 시점엔 원래 문자열과 매치
//   결과가 완전히 같았고, 코덱스 적대 리뷰 1회차 처방으로 PAYMENT_MECHANICS_PATTERN 쪽만 더
//   넓혔다(up front/paypal/익월/정산 시기 등) — HUMAN_REVIEW_RULES 의 budget-or-rate-human-review
//   는 여전히 이 합집합을 그대로 쓰므로 그 규칙도 함께 더 넓어진다(오탐 방향은 항상 사람 검토).
//   쪼개는 이유: liftCounterOfferHoldForGuidelineAmountCase 의 독립 재검사가 "budget-or-rate-
//   human-review 규칙 자체"는 건너뛰어야 하지만(그게 리프트의 트리거 축 중 하나이므로),
//   지급 방식·시기·구조 어휘(PAYMENT_MECHANICS_PATTERN)는 그 규칙에 얹혀 있다는 이유만으로
//   함께 건너뛰면 안 된다 — "$500 줄 수 있나요, 근데 계좌로 선입금해주세요" 같은 지급 시기/방식
//   변경 요청이 단가 역제안과 섞였을 때도 여전히 사람 검토로 남아야 한다(헤세 지시의 "지급 시기
//   변경" 제외 카테고리).
// 6회차 리뷰 처방: "raise"/"negotiate"/"increase" 의 활용형(raised/raises/raising 등)이 원형
// bare 단어에만 걸리던 패턴에 없었다("I raised my rate and would like you to match it." 가
// 새어나갔다 — 관대한 증거 정책 하에서 이 규칙조차 안 걸리면 다른 축의 방어도 무력화된다).
// 8회차: "negotiation"(명사)의 복수형 "negotiations"가 없었다("Negotiations about my rate are
// still open.").
const SIMPLE_RATE_NEGOTIATION_PATTERN =
  /\b(increas(?:e[sd]?|ing)|higher|rais(?:e[sd]?|ing)|negotiat(?:e[sd]?|ing|ions?))\b|단가\s*인상|협상/i;
// v7 (2026-09-24, 코덱스 적대 리뷰 counter_offer_guideline_reply 1·2회차): "up front"/"upfront",
// "prepaid", "paypal"(지급 채널 변경 요청), "익월"(다음 달)·"말일 정산"·"정산 시기/일정/방식/주기"
// 같은 지급 시기·채널·방식 변경 어휘는 기존 목록에 없었다("Please pay me up front through PayPal
// before I post.", "My rate is $500, prepaid before delivery.", "익월 말 정산으로 진행 가능할까요?").
// 1회차 수리는 "before I post/publish/upload"를 독립 어휘로 넣었다가, 지급과 무관한 "Before I
// post, is facecam mandatory?" 같은 완전히 다른 케이스(requirements_question)까지 오탐으로
// budget-or-rate-human-review 에 걸리게 만들었다(2회차 리뷰 발견 — 이 패턴은 시스템 전체 공유
// 규칙이라 이 오탐이 내 새 케이스뿐 아니라 무관한 케이스의 회귀였다). "before I post/deliver" 는
// "pay/payment" 어휘가 근접(±24자)해 있을 때만 매치하도록 좁힌다 — "pay me before I post" 는
// 여전히 잡되, 지급과 무관한 "before I post"는 더 이상 걸리지 않는다.
// 3회차 리뷰 처방: 근접 간격이 쉼표를 넘어가면("I will pay for shipping, and before I post the
//   video I need the sample files.") 서로 무관한 두 절을 하나로 묶어 오탐한다 — 쉼표도 절 경계로
//   추가한다. "pay me after I post"(지급 시기를 사후로 미루는 요청) 도 before 와 대칭으로 잡는다.
// 4회차 리뷰 처방: "before I post/publish/upload/deliver" 처럼 특정 동사를 나열하는 방식은
//   whack-a-mole 이다 — "before the video goes live" 같은 동의어가 계속 새로 나온다("My rate is
//   $500, but I need payment before the video goes live."). 특정 동사를 요구하지 않고 "pay" 어휘
//   근처의 "before"/"after" 자체를 잡는 것으로 일반화한다 — 지급 관련 문맥(±24자, 쉼표/문장부호
//   경계 유지)에서 시기를 언급하는 거의 모든 표현을 커버한다(오탐 방향은 항상 사람 검토).
// 5회차 리뷰 처방: "pay(?:ment|s|ing|me)?" 는 "paid"(불규칙 과거형 — pay+d 가 아니라 pai+d)를
//   전혀 매치하지 않았다("I must be paid before the video goes live." 가 그대로 새어나갔다).
// 6회차 리뷰 처방: "paid" 를 추가하자 "pay attention"(지급과 무관한 관용구) 의 과거형 "paid
//   (close) attention"이 "paid...before"(±24자) 근접 매치로 오탐했다("I paid close attention
//   before filming and followed the brief." 가 held 로 새어나갈 뻔했다 — 반대 방향의 오탐, 즉
//   무관한 메시지가 사람 검토로 과도하게 걸리는 것도 실사용자 경험을 해치므로 좁힌다). "pay(ing)?/
//   paid (close) attention" 관용구만 부정 전방탐색으로 제외 — 지급 관련 "paid before/after/up
//   front" 매치는 그대로 유지된다.
// 8회차: "payment"(명사) 의 복수형 "payments" 가 없었다("Payments should happen after
//   publication.").
const PAYMENT_MECHANICS_PAY_WORD = "(?:pay(?:ments?|s|ing|me)?|paid)(?!\\s+(?:close\\s+)?attention\\b)";
const PAYMENT_MECHANICS_TIMING_PHRASE = "(?:up[\\s-]+front|before|after)";
// 7회차 리뷰 처방: "discount"/"wire" 는 활용형(discounted, wired)이 없었고, "buyout"(명사)은
// "bought out"(동사 과거형 — buy 의 불규칙 활용)을 전혀 매치하지 않았다("You discounted my last
// payout without asking.", "You wired me only $300 last time.", "I bought out the footage.").
// 8회차: 이 목록의 명사는 대부분 가산명사인데 복수형이 없었다(invoicing/wiring 같은 현재분사와
// bank transfers/usage fees/license fees/buyouts 같은 복수형 모두 — "I will be invoicing you
// separately.", "Will you be wiring the fee after I post?", "Bank transfers should happen
// before filming.", "with additional usage fees if you run ads.", "excluding buyouts.").
const PAYMENT_MECHANICS_PATTERN = new RegExp(
  `\\b(discount(?:ed|s|ing)?|invoic(?:e[sd]?|ing)|deposit(?:ed|s|ing)?|wir(?:e[ds]?|ing)|bank transfers?|payment terms?|net\\s*\\d+|advance payments?|late payments?|usage fees?|license fees?|exclusive rates?|buyouts?|bought\\s+out|buy(?:s|ing)?\\s+out|paypal|prepa(?:id|y(?:ing)?|yments?))\\b` +
    `|\\b${PAYMENT_MECHANICS_PAY_WORD}\\b[^,.!?\\n]{0,24}\\b${PAYMENT_MECHANICS_TIMING_PHRASE}\\b` +
    `|\\b${PAYMENT_MECHANICS_TIMING_PHRASE}\\b[^,.!?\\n]{0,24}\\b${PAYMENT_MECHANICS_PAY_WORD}\\b` +
    `|지급일|선입금|후불|인보이스|계좌|송금|세금계산서|바이아웃|추가\\s*비용|선지급|후지급|익월|말일\\s*정산|정산\\s*(?:시기|일정|방식|주기)|지급\\s*시기`,
  "i",
);
const BUDGET_OR_RATE_PATTERN = new RegExp(
  `${SIMPLE_RATE_NEGOTIATION_PATTERN.source}|${PAYMENT_MECHANICS_PATTERN.source}`,
  "i",
);

// Extracted so both the HUMAN_REVIEW_RULES entry below and isAgencyOrManagementReply (dismiss-
// backlog policy override, 2026-09-26 hesse decision) test the exact same pattern — two independent
// copies of this regex have drifted apart before on this axis (see dismissNoReplyBacklog.ts's own
// hasProtectedHoldSignal history), so this file now owns a single source of truth for it.
const AGENCY_OR_MANAGEMENT_PATTERN =
  /\b(agency|management|managers?|managed|agents?|representative|talent\s+(?:firm|agency)|package\s+deals?|other\s+creators?|multiple\s+creators?|group\s+rate|bundle\s+deal)\b|\ball\s+(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+creators?\b|\b(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+creators?\s+together\b|소속사|대행사|매니저|담당자|에이전시|다른\s*크리에이터|여러\s*크리에이터|크리에이터들과|묶어서\s*진행|패키지로/i;

/**
 * Standalone agency/management/rep sender-language detector — reuses AGENCY_OR_MANAGEMENT_PATTERN
 * so it can never drift from the "agency-human-review" rule below. Backs the dismiss-backlog
 * hasProtectedHoldSignal override (2026-09-26, hesse policy decision): an agency/manager/rep reply
 * that also states a rate or counter-offer is still dismissed — a firm quoting a price on someone
 * else's behalf is not a creator we negotiate with through this channel.
 */
export function isAgencyOrManagementReply(seed: string): boolean {
  return AGENCY_OR_MANAGEMENT_PATTERN.test(seed.toLowerCase());
}

// Bare approval terms remain held; only the narrow post-model status exception may lift them.
const HUMAN_REVIEW_RULES: readonly HumanReviewRule[] = [
  {
    ruleId: "email-only-no-call-human-review",
    reason: "call, meeting, phone, calendar, or availability requests require human review because Flu collaboration is email-only",
    pattern: EMAIL_ONLY_NO_CALL_PATTERN,
  },
  {
    ruleId: "budget-or-rate-human-review",
    reason: "specific budget, rate, payment, or reward terms require human review",
    pattern: BUDGET_OR_RATE_PATTERN,
  },
  {
    ruleId: "schedule-human-review",
    reason: "schedule or launch-window changes require human review",
    pattern: /\b(reschedule|schedule conflict|date conflict|date conflicts|posting date conflict|posting date conflicts|launch window|upload window|move the upload|move the date|deadline|delay|postpone|specific date)\b|일정\s*변경|날짜\s*변경|업로드\s*연기|기간\s*변경|충돌/i,
  },
  {
    ruleId: "contract-rights-human-review",
    reason: "contract, signature, usage-rights, exclusivity, revision, or cancellation terms require human review",
    // v7 (2026-09-24, 코덱스 적대 리뷰 counter_offer_guideline_reply 1·2회차): "합의서"(계약서
    // 동의어)·"날인"(서명 동의어)·"동의서", "광고 소재로 활용"·"ad creative"·"cannot use my
    // video/content" 같은 사용권 조건 문구는 기존 계약/서명/사용권 키워드에 안 걸렸다
    // ("제 단가는 30만원입니다. 합의서에 날인하면 진행하겠습니다.", "you cannot use my video as ad creative").
    // 6회차: "sign" 활용형(signing/signed/signs)이 원형 bare 단어에만 걸리던 패턴에 없었다
    // ("I will be signing the agreement tomorrow.").
    // 7회차: "exclusivity"(명사)는 "exclusive"(형용사 — "must be exclusive to you")를 매치하지
    // 않았다 — 서로 다른 단어다.
    // 8회차: "contract"/"revision"/"ad creative" 의 복수형, "license"의 활용형(licensed), "terms"
    // 의 단수형(term) 이 없었다("Separate contracts are needed.", "including two revisions.",
    // "Licensed use of my footage ends after three months.", "One term is that...").
    // 9회차 (2026-09-29, 안전 재검토): bare "approval"/"approved"/"승인" 은 기본적으로
    // 다시 홀드한다. 순수 승인-상태 문의는 모델 분류 이후 isCleanApprovalStatusInquiry +
    // allowGuideRedirectForApprovalStatusInquiry + JEV/permit 경로에서만 좁게 풀 수 있다.
    pattern: new RegExp(
      `\\b(contracts?|signature|sign(?:s|ed|ing)?|usage rights|exclusiv(?:ity|e)|licens(?:e[sd]?|ing)|revisions?|cancellation|terms?|ad creatives?|advertising creatives?)\\b` +
        // 0.6.109 (코덱스 리뷰): agreement/countersign/e-sign/NDA, 영구·사용기간·화이트리스트·저작권 류 사용권 어휘.
        `|\\b(?:agreements?|countersign\\w*|e-?sign\\w*|ndas?|perpetual(?:ly)?|perpetuity|buy-?outs?|whitelist(?:ed|ing)?|copyrights?|usage\\s+(?:period|term|duration)|rights\\s+to\\s+(?:my|the|our|your)\\s+(?:footage|content|video|videos|clips?))\\b` +
        `|저작권|영구|사용\\s*기간|화이트리스트|계약서|전자\\s*서명` +
        `|\\b(?:can(?:'t|not)|cannot|do not|don'?t)\\s+use\\s+(?:it|this|my\\s+(?:video|content|clip|footage))\\b` +
        `|계약|서명|사용권|독점|수정|취소|조건|약관|합의서|날인|동의서|소재로\\s*활용|광고\\s*소재` +
        `|\\bapprov(?:al|ed)\\b|승인`,
      "i",
    ),
  },
  {
    ruleId: "agency-human-review",
    reason: "agency, management, manager, or representative replies require human review",
    // v7 (2026-09-24, 코덱스 적대 리뷰 counter_offer_guideline_reply 1·2회차): "agency/manager"
    // 같은 명시 단어 없이 "다른 크리에이터들과 묶어서/패키지로", "전체 N명 크리에이터 합쳐서" 라고만
    // 쓰는 복수 크리에이터 딜 문구는 기존 목록에 없었다("$500 for me and two other creators as a
    // package deal", "$500 for all three creators together").
    // 6회차: "managed by"(동사 활용형 — manager/management 명사형에만 걸리던 패턴에 없었다)와
    // "talent firm/talent agency"(에이전시의 동의어)를 추가한다("I am managed by a talent firm.").
    // 8회차: "manager"/"agent"/"package deal" 의 복수형이 없었다("My managers must approve it.",
    // "My agents need to review it.", "Package deals are priced differently.").
    pattern: AGENCY_OR_MANAGEMENT_PATTERN,
  },
  {
    ruleId: "ambiguous-creator-reply",
    reason: "confusing reply without a safe email-only next step requires human review",
    pattern: /\b(not sure|unclear|confusing|question about terms|question about contract|before signing|before confirming final)\b|애매|조건\s*불명확|계약\s*질문|최종\s*확인/i,
  },
  {
    ruleId: "tone-shift-human-review",
    reason: "frustration, sudden pause, build issue, or tone shift requires human review",
    // v7 (2026-09-24, 코덱스 적대 리뷰 counter_offer_guideline_reply 3회차): "frustrated" 는
    // "angry"만 있던 기존 목록에 없었다 — 이미 불만이 쌓인 창작자에게 "협상 안 합니다" 식 고정
    // 안내가 그대로 나가면 톤이 악화될 위험이 있다("I am frustrated with the way this has been
    // handled.").
    pattern: /\b(rushed|confusing|waste|angry|uncomfortable|pause|escalate|complaint|frustrat\w*|upset|disappointed)\b|불편|중단|화남|짜증|실망|안해|안\s*해/i,
  },
  // F-5 (AUTO-MAIL-SAFETY-DESIGN-2026-09-16.md §B "③민감 갭", §E-2): "안 받았다/못 받았다/금액이
  // 틀리다" 류 정산 분쟁은 숫자(금액)가 전혀 없어도 사람 검토로 보낸다 — 기존 hasCurrencyAmount
  // 축은 숫자가 있을 때만 잡는다. 절대 auto_reply·blocked 로 떨어지지 않는다(needs_review 고정).
  {
    ruleId: "settlement-dispute-human-review",
    reason: "missing payment, underpaid, or incorrect settlement claims require human review even without a stated amount",
    // v7 (2026-09-24, 코덱스 적대 리뷰 counter_offer_guideline_reply 1·2회차): "shorted me"/"paid me
    // short"(underpaid 의 구어체 동의어)는 기존 목록에 없었다("You shorted me on the previous
    // payout.", "You paid me short last time.").
    // 6회차: "have/has/had not been paid"(수동태 + not — "haven't received" 와 다른 구문)가
    // 없었다("I have not been paid for the last video.").
    // 8회차: "underpaid"/"short-changed"/"paid...less than" 의 현재분사형(underpaying,
    // short-changing, paying...less than)이 없었다("because you have been underpaying me.",
    // "because you have been short-changing me.", "You are paying me less than we agreed.").
    pattern: /\b(missing\s+payment|didn['’]?t\s+receive(?:d)?(?:\s+(?:the|my)\s+payment)?|did\s+not\s+receive(?:\s+(?:the|my)\s+payment)?|never\s+received(?:\s+(?:the|my)\s+payment)?|haven['’]?t\s+received(?:\s+(?:the|my)\s+payment)?|(?:have|has|had)\s+not\s+been\s+paid|(?:haven['’]?t|hasn['’]?t|hadn['’]?t)\s+been\s+paid|(?:was|were)\s+not\s+paid|(?:wasn['’]?t|weren['’]?t)\s+paid|still\s+waiting\s+for\s+(?:the\s+)?payment|wrong\s+amount|underpa(?:id|ying)|under-pa(?:id|ying)|shorted\s+me|short[- ]?chang(?:ed|ing)|(?:pay(?:ing|s)?|paid)\s+(?:me\s+)?less\s+than|paid\s+me\s+short|paid\s+short|overdue|unpaid|past\s+due|outstanding\s+(?:payments?|balance|invoices?|fees?)|owe[sd]?\s+me|late\s+payments?)\b|미지급|연체|미정산|정산\s*(?:이\s*)?안\s*됐|안\s*받았|못\s*받았|입금이?\s*안\s*(?:됐|되)|지급이?\s*안\s*(?:됐|되)|정산\s*누락|정산\s*오류|정산\s*안\s*됨|금액이?\s*(?:틀리|틀려)|금액\s*틀림|보상금?[을를]?\s*못\s*받|부족하게\s*(?:주|받|줬|받았)|덜\s*받/i,
  },
  // F-5 (§E-6): 언론·매체·제휴 대행사 문의는 크리에이터 본인 문의가 아니므로 자동 초안 없이
  // 사람이 먼저 확인한다.
  // AR-1 (adversarial review 2026-09-17, HIGH): bare \bmedia\b false-matched "social media"
  // (e.g. "I'll post it on social media"). Press/media terms now require outlet/press context —
  // "media" alone only counts alongside inquiry/outlet/request/coverage/kit, or as the standalone
  // "press"/"journalist"/"reporter" nouns. "interview" narrowed to "interview request" for the
  // same reason (bare "interview" alone is too generic).
  {
    ruleId: "press-partnership-human-review",
    reason: "press, media, or partnership/agency outreach requires human review",
    pattern: /\bmedia\s+(?:inquiry|outlet|request|coverage|kit)\b|\bpress\b|\bjournalist\b|\breporter\b|\binterview\s+request\b|\bpartnership\s+(?:proposal|offer)\b|\bsponsorship\b|\bagency\s+representing\b|제휴\s*제안|언론|기자|취재|광고\s*제안/i,
  },
  // F-5 (§E-4): 개인정보 열람/삭제 요청은 정책·법무 확인이 필요해 사람 검토로 보낸다.
  // AR-1 (adversarial review 2026-09-17, HIGH): explicit deletion REQUESTS of account/data/
  // information ("delete my information", "remove my data", "내 정보 삭제") moved to the hard
  // opt-out (blocked) rule below — ACCOUNT_DELETION_ACTION. This rule now only covers privacy
  // QUESTIONS (GDPR mentions, "what personal information do you store", access/처리 문의).
  {
    ruleId: "personal-data-human-review",
    reason: "personal data privacy questions (GDPR, what data is held, who can see it) require human review",
    pattern: /\bgdpr\b|\bpersonal\s+information\b|개인정보|삭제\s*요청|내\s*정보\s*열람/i,
  },
] as const;

const SAFE_INFO_REQUEST_PATTERN = /\b(send|share|provide|forward)\s+(the\s+)?(brief|details|info|information|next step|next steps|guidelines?|requirements?)\b|\b(brief first|send brief|share details|more details|next step|next steps|deliverables?|content format|three shorts|one long video|build crashes?|game build)\b|브리프|상세|자료|다음\s*단계|가이드|숏츠|롱폼|빌드/i;

// auto-reply-risk-taxonomy (2026-09-17): the trailing `\b` after 원/만원 used to require a
// word/non-word transition, which never fires between two Korean characters (Korean is entirely
// "non-word" for regex \b — same root cause called out on PARTNER_ACCEPT_NEGATION_PATTERN below).
// Natural Korean sentences never put a space or ASCII punctuation right after 원/만원
// ("30만원입니다", "30만원을"), so amounts written in continuous Korean text were silently
// invisible to this check. The 원/만원 branch below is split out from the ASCII-unit branch (which
// keeps its trailing \b — "usd/won/dollars" etc. still need it to avoid matching into English
// words like "wonderful") and drops only its own trailing boundary. This only widens matches for
// the Korean branch (strictly more cautious — routes more to needs_review, never fewer) and fixes
// real counter-offer messages like "제 단가는 30만원입니다" that previously fell through to
// auto_reply.
// 2026-09-24 (헤세 지시 — interest_next_steps 즉시발송 허용목록): 기존엔 모듈 내부 전용이었다.
//   chat-ai.ts 의 always-send 허용목록이 "원문에 구체 가격 숫자가 함께 있는가"를 독립적으로
//   재확인할 때 재사용한다 — HUMAN_REVIEW_RULES(reviewGateForText) 는 협상 어휘만 잡고 순수
//   숫자 토큰은 별도 경로(decideHumanGate 의 budget-amount-human-review)로만 걸리기 때문이다.
// 2026-10-03 (헤세 정책, 0.6.112 pricing permit reroll 실패 — "How much do you pay for this collab?" 가 reward_overview 로
//   오분류돼 고정 단가 숫자가 나간 사고): 모델 분류와 무관한 **결정론적** "순수 가격/예산/견적 질문" 판정.
//   "얼마를 지급하나 / 단가·예산·견적을 알려달라" 형태의 요청이면 true. 보상 구조 자체를 묻는 문장
//   ("How does the reward work", "How much is the reward?", "explain View Reward rates")은 이 패턴에 걸리지
//   않는다(지급 주체가 우리인 "you pay/offer/budget/your rate/quote" 형태만). 가격+구조가 섞여 있어도 true —
//   안전한 쪽(숫자 없는 가이드 리다이렉트)으로 보낸다.
// 설계 원칙(안전 방향 비대칭): 이 판정이 true 면 reward_overview(고정 단가 숫자 템플릿) → pricing_guide_redirect(숫자 없는 가이드)
//   로 바뀐다. 오탐 비용은 "숫자 없는 가이드 안내"(무해), 미탐 비용은 "순수 가격 질문에 단가 숫자 노출"(사고)이므로 재현율을 우선한다.
//   STRONG: 우리가 지급한다는 명시적 가격/예산/견적 요청 — 보상 구조 어휘가 섞여 있어도 true(가격+구조 혼합 → pricing).
//   WEAK: 가격 어휘만 있고(how much/rate/fee/price/단가…) 보상 구조 어휘(reward/정산/계산/조회수…)가 전혀 없을 때만 true.
const PRICING_MONEY_WORDS =
  "\\bhow\\s+much\\b|\\b(?:amounts?|rates?|fees?|prices?|pricing|compensat\\w*|pays?|paid|paying|payouts?|offer(?:s|ing)?|earn\\w*|remunerat\\w*)\\b|단가|출연료|페이|금액|원고료|사례비|보수|협찬료|광고비|제작비|얼마";
const PRICING_DELIVERABLE_WORDS =
  "\\b(?:videos?|posts?|collab(?:oration)?s?|integrations?|sponsor\\w*|campaigns?|reels?|shorts?)\\b|영상|콜라보|협업|포스트|게시물";
const PRICING_ASK_STRONG_PATTERN = new RegExp(
  [
    "\\bhow\\s+much\\b[^.?!\\n]{0,40}\\b(?:do|will|would|can|could|are)\\s+(?:you|u|y['’]?all)\\s+(?:pay|offer|charge|compensate|spend|budget)\\b",
    "\\bwhat\\s+(?:do|would|will|can|could|are)\\s+(?:you|u|y['’]?all)\\s+(?:pay|offer|charge|compensate|spend)\\b",
    "\\bbudget(?:s|ed|ing)?\\b|\\bquot(?:e|es|ed|ation|ations)\\b|\\bpay\\s+(?:rate|per\\s+(?:video|post|collab))\\b",
    "\\bhow\\s+much\\b[^.?!\\n]{0,25}\\b(?:for|per)\\s+(?:a|an|one|each|the)\\s+(?:video|post|collab(?:oration)?|integration|sponsor\\w*)",
    "\\bwhat\\s+(?:would|will|do|can|could)\\s+(?:i|we)\\s+(?:make|earn|get|receive|be\\s+paid)\\b",
    // 가격 어휘가 납품물(영상/포스트/콜라보…) 근처에 있으면 — 순서 무관 — 그 자체로 가격 요청이다(보상 구조 어휘가 섞여도).
    `(?:${PRICING_MONEY_WORDS})[^.?!\\n]{0,40}(?:${PRICING_DELIVERABLE_WORDS})|(?:${PRICING_DELIVERABLE_WORDS})[^.?!\\n]{0,40}(?:${PRICING_MONEY_WORDS})`,
    "\\b(?:your|ur)\\s+(?:\\w+\\s+){0,2}(?:rates?|fees?|prices?)\\b|\\b(?:rates?|fees?)\\s+per\\b|\\bwhat\\s+(?:is|are|'s|’s)\\s+(?:you|your)\\s+offer\\w*",
    "\\bhow\\s+much\\b[^.?!\\n]{0,20}\\b(?:i|we)\\s+(?:would|will|could|can|'ll|’ll)?\\s*(?:be\\s+)?(?:paid|get|make|earn|receive)\\b",
    "\\bwhat\\b[^.?!\\n,;]{0,30}\\b(?:you|u|y['’]?all)\\b[^.?!\\n,;]{0,15}\\b(?:pay(?:ing)?|offer(?:ing)?|giv(?:e|ing)|charg(?:e|ing)|compensat\\w*)\\b",
    "\\b(?:cpm|rpm)\\b|예산|견적|단가|얼마\\s*(?:를|나)?\\s*(?:지급|주시|줄|받을)",
  ].join("|"),
  "i",
);
const PRICING_ASK_WEAK_PATTERN =
  /\bhow\s+much\b|\b(?:amounts?|rates?|fees?|prices?|pricing|compensat\w*|pay|pays|paid|paying|payouts?|payments?|earn\w*|income|remunerat\w*)\b|단가|비용|얼마|출연료|페이|금액|원고료|사례비|보수|협찬료|광고비|제작비|수익|지급/i;
const REWARD_STRUCTURE_WORD_PATTERN =
  /\b(?:rewards?|view\s+rewards?|creator\s+codes?|commissions?|settle(?:ment|d|s)?|eligible\s+(?:views?|purchases?)|attribut\w*|calculat\w*|how\s+(?:does|do|is|are)\b[^.?!\n]{0,40}\b(?:work|works|determined|computed)|holdback|thresholds?|minimum\s+(?:settlement|payout|amount|balance)|net\s+purchase|pay(?:ment)?\s+(?:schedule|dates?|timing|cycle|methods?)|when\b[^.?!\n]{0,30}\b(?:paid|payment|payout))\b|정산|커미션|크리에이터\s*코드|적격|보상\s*(?:구조|방식|체계|정책)/i;
// fail-closed 보완: 가격 어휘 목록은 완결될 수 없다(어휘 우회). 그래서 반대 방향도 건다 — 본문(제목 제외, 인용 제외)에 보상 구조 어휘가 하나도
//   없으면 reward_overview(고정 단가 숫자 템플릿)를 정당화할 근거가 없으므로 pricing 으로 보낸다(오탐 = 숫자 없는 가이드 안내, 무해).
// "reward details 는 필요 없고 얼마 받는지만" 처럼 보상 구조를 명시적으로 거절하는 절은 구조 근거로 세지 않는다(절 전체 제거).
const NEGATED_STRUCTURE_CLAUSE_PATTERN =
  /\b(?:(?:do(?:es)?\s*n['’]?t|do(?:es)?\s+not|not)\s+(?:need|want|asking|ask|interested|looking|care|require)|no\s+need|without)\b[^,;.!?\n]*|[^,;.!?\n]*(?:\bnot|n['’]?t)\s+(?:needed|necessary|required|relevant)\b[^,;.!?\n]*|[^,;.!?\n]*필요\s*(?:없|않)[^,;.!?\n]*/gi;
export interface PricingAskParts {
  readonly subject?: string;
  readonly body?: string;
}
// fail-closed 보완: 가격 어휘 목록은 완결될 수 없다(어휘 우회). 그래서 반대 방향도 건다 — 본문(제목 제외, 인용 제외)에 보상 구조 어휘가 하나도
//   없으면 reward_overview(고정 단가 숫자 템플릿)를 정당화할 근거가 없으므로 pricing 으로 보낸다(오탐 = 숫자 없는 가이드 안내, 무해).
//   parts 가 있으면 제목/본문 경계를 그대로 쓰고, 없을 때만 " | " 구분자로 복원한다.
function hasRewardStructureEvidence(creatorText: string, parts?: PricingAskParts): boolean {
  const rawBody = parts ? (parts.body ?? "") : (() => {
    const segments = creatorText.split(" | ");
    return (segments.length > 1 ? segments.slice(1) : segments).join("\n");
  })();
  // 인용/서명 블록은 첫 인용 마커에서 잘라낸다(">" 줄, "On … wrote:", "-----Original Message-----", "From:/Subject:" 헤더, "--").
  const body = stripQuotedAndSignatureBlocks(rawBody);
  return REWARD_STRUCTURE_WORD_PATTERN.test(body.replace(NEGATED_STRUCTURE_CLAUSE_PATTERN, " "));
}
export function isPurePricingAsk(creatorText: string, parts?: PricingAskParts): boolean {
  const text = parts ? [parts.subject ?? "", parts.body ?? ""].map((part) => part.trim()).filter(Boolean).join("\n") : creatorText;
  if (text.trim() === "") return false;
  if (PRICING_ASK_STRONG_PATTERN.test(text)) return true;
  // 구조 어휘 veto 는 같은 문장 안에서만 — "Subject | Body" 합본이나 앞선 문장의 "View Reward" 가 별개 문장의 가격 요청을 지우지 못한다.
  if (
    text
      .split(/[.?!\n|;:,—–。？！]+|\b(?:but|and|though|however|just)\b/i)
      .some((sentence) => PRICING_ASK_WEAK_PATTERN.test(sentence) && !REWARD_STRUCTURE_WORD_PATTERN.test(sentence.replace(NEGATED_STRUCTURE_CLAUSE_PATTERN, " ")))
  ) {
    return true;
  }
  return !hasRewardStructureEvidence(text, parts);
}

// 2026-09-24 (코덱스 적대 리뷰 — interest_next_steps 허용목록 방어선): "내 요율/가격은 …" 류
//   명시적 가격 진술 문구 — 통화 기호·단위 없이도 매치한다("My fee is 500 a video." 가
//   hasCurrencyAmount/isCounterOfferSignal 양쪽에 안 걸리는 걸 코덱스가 실측했다 — 두 함수
//   모두 먼저 hasCurrencyAmount 를 통과해야만 나머지 검사를 본다). 넓은 동의-확인 어구
//   ("sounds good"/"that works"/PROPOSED_OR_ACCEPTED_AMOUNT_PATTERN 전체)는 일부러 빼낸다 —
//   가격과 무관한 순수 긍정 회신("Sounds good, I'm interested!")까지 허용목록에서 밀어내면
//   그 회신은 안전한데도 항상 실제 JEV 상담으로 떨어진다(과탐 방향 자체는 안전하지만, 이
//   함수의 목적은 "가격을 직접 진술했는가"로 좁힌다).
// 코덱스 적대 리뷰(2026-09-24, 2회차) BLOCKER: 1회차 패턴은 "is" 뒤에만 걸려 "My rate would be
//   500 a video." 처럼 "would be"/"will be"/축약형 "'s" 로 가격을 진술하면 새어나갔다(코덱스
//   실측). "is" 자리에 오는 흔한 활용형을 넓힌다.
const STATED_PRICE_PHRASE_PATTERN =
  /\bmy\s+(?:rate|fee|price|quote|budget|ask)\s+(?:is|'s|would\s+be|will\s+be|(?:'d|would)\s+be)\b|\bi\s+charge\b|\bi\s*(?:'d|would)\s+(?:need|want|charge|ask\s+for)\b|제\s*(?:단가|가격|요율|비용|금액)(?:는|은|이|가)/i;
export function isStatedPricePhrase(seed: string): boolean {
  return STATED_PRICE_PHRASE_PATTERN.test(seed);
}

export function hasCurrencyAmount(seed: string): boolean {
  return /(?:[$€£¥₩]\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m)?|\b(?:usd|eur|gbp|jpy|krw)\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m)?|\b\d[\d,]*(?:\.\d+)?\s*(?:usd|eur|gbp|jpy|krw|dollars?|euros?|won)\b|\b\d[\d,]*(?:\.\d+)?\s*(?:원|만원)|\b(?:1500|1,500|2300|2,300|10500|10,500)\b)/i.test(seed);
}

// W76-②(코덱스 리뷰 HIGH) [실사고 오탐]: 인용 답장(">" 시작 줄, "On ... wrote:", 이전 발신
// 헤더 재인용, 서명 구분선)을 제거한 뒤에만 판정한다 — 그렇지 않으면 스레드에 인용된 과거
// 발신자 문구(예: 우리 쪽 안내 메일 원문, 옛 스레드의 다른 발신자 문구)를 지금 이 발신자의
// 현재 의도로 오판한다. seed가 이미 개행 없는 한 줄(pipe join 등)이면 어떤 줄도 ">" 등으로
// 시작하지 않으므로 안전하게 no-op이다(mailImapLive.ts의 stripQuotedReply와 동형 로직).
function stripQuotedAndSignatureBlocks(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      /^>/.test(trimmed)
      || /^on .+wrote:$/i.test(trimmed)
      || /^20\d{2}년\s*.+작성:$/i.test(trimmed)
      || /^-{2,}\s*original message\s*-{2,}$/i.test(trimmed)
      || /^(from|sent|to|subject):\s/i.test(trimmed)
      || /^--\s*$/.test(trimmed)
    ) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

// W76-②(코덱스 리뷰 HIGH) [실사고 오탐]: "Please do not delete my account"가 옵트아웃으로
// 오탐됐다(부정문 미처리) — delete/close/cancel/remove + account 계열 바로 앞에 부정어(do
// not/don't/never 등)가 오면 오히려 "지우지 말아달라"는 반대 의도다. 이 계열에만 부정 가드를
// 건다 — unsubscribe/do not contact/lawsuit 등 기존 문구는 그 자체가 이미 명령형 부정이라
// 별도 가드를 걸면 그 문구 자신이 걸려 넘어진다(예: "do not contact"가 "do not"에 걸려 무효화).
// F-5 (AUTO-MAIL-SAFETY-DESIGN-2026-09-16.md §B "③민감 갭") / AR-1 (adversarial review
// 2026-09-17, HIGH): "data"/"information" were removed from this alternation in F-5, but that
// left explicit deletion REQUESTS ("delete my information", "remove my data") matching neither
// this hard opt-out nor the personal-data-human-review rule (which only covers "personal
// information"/"delete my data" phrasing, not "information"/"details" alone) — they silently
// fell through to auto_reply. Deletion REQUESTS of account/data/information belong here (hard
// opt-out, same as leaving the platform); privacy QUESTIONS (GDPR, "what personal information do
// you store") stay in personal-data-human-review (needs_review) below.
const ACCOUNT_DELETION_ACTION = /delete\s+my\s+account|delete\s+account|close\s+my\s+account|close\s+(?:my\s+)?account|cancel\s+my\s+account|remove\s+my\s+account|delete\s+my\s+profile|delete\s+my\s+(?:information|info|data|details)|remove\s+my\s+(?:information|info|data|details)|erase\s+my\s+(?:information|info|data|details)|계정\s*삭제|탈퇴|내\s*정보\s*삭제|정보\s*지워/gi;
const NEGATION_BEFORE = /\b(?:do\s+not|don['’]?t|didn['’]?t|never|no\s+need\s+to|not\s+trying\s+to|not\s+asking\s+(?:you\s+)?to)\s*(?:want\s+to\s+|wish\s+to\s+|plan\s+to\s+|intend\s+to\s+|mean\s+to\s+)?$/i;
const NEGATION_BEFORE_KO = /(?:하지\s*말아|하지\s*마세요|원하지\s*않|아니에요|아니고)\s*$/;

function hasUnnegatedAccountDeletionIntent(text: string): boolean {
  ACCOUNT_DELETION_ACTION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ACCOUNT_DELETION_ACTION.exec(text))) {
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    if (!NEGATION_BEFORE.test(before) && !NEGATION_BEFORE_KO.test(before)) return true;
  }
  return false;
}

// W76-B [실사고 2026-08-13, Mickael Moy "Please delete my account"]: 계정 삭제/탈퇴 요청은
// 명백한 옵트아웃 의도인데 기존 패턴엔 없었다 — "delete my account" 류를 unsubscribe/stop 계열과
// 동급으로 취급한다(자동 안내는 실제 탈퇴 절차 링크가 없으므로 사람 처리로 넘기는 것이 맞다).
// auto-reply-risk-taxonomy (2026-09-17): chargeback/refund-demand/공론화 위협도 같은 등급으로
// 추가한다 — 이 신호가 오면 자동 초안이 사과·설명을 시도하는 것 자체가 위험하다(사람이 정산
// 원장을 확인한 뒤 직접 응대해야 한다). 순수 금액 문의("payment is late")는 여기 걸리지 않는다
// (아래 tests/mail-human-gate-sensitive-rules.test.mjs 회귀 pin).
export function isHardOptOut(seed: string, options: { stripQuotes?: boolean } = {}): boolean {
  // stripQuotes:false 는 역제안 허용목록 게이트 전용 — 인용/서명 블록 안의 옵트아웃도 그대로 잡는다.
  const text = (options.stripQuotes === false ? seed : stripQuotedAndSignatureBlocks(seed)).toLowerCase();
  if (hasUnnegatedAccountDeletionIntent(text)) return true;
  return /unsubscribe|do not email|don't email|do not contact|don't contact|stop contacting|remove me|unwanted outreach|unwanted contact|legal action|legal issue|lawsuit|spam|chargeback|refund|dispute the charge|고소|소송|신고|법적\s*리스크|수신\s*거부|메일\s*보내지|연락하지|환불\s*요구|공론화|폭로/.test(text);
}

// auto-reply-risk-taxonomy (2026-09-17) — deterministic hard stops for safety-critical signals
// that must never reach a generated draft, distinct from the opt-out/legal blocklist above:
//   1. minor self-report (age/school-level disclosure under 19 — Super Creator Partners requires
//      19+; a minor's reply must never get an automated "here's how to apply" style response)
//   2. payment-info / impersonation attempts (someone asking to redirect payment or claiming to
//      be a different, non-official channel — classic BEC/phishing setup)
//   3. harassment / threats (explicit threats or profanity directed at the recipient)
// Each pattern targets an unambiguous signal, not ordinary complaint vocabulary — "payment is
// late" or "I'm frustrated" must NOT match (see tests/mail-human-gate-hard-stop-safety.test.mjs).
const MINOR_SELF_REPORT_PATTERN = /\bminor\b|\bunder\s*18\b|미성년|중학생|고등학생|초등학생/i;
const PAYMENT_IMPERSONATION_PATTERN = /\bsend\s+payment\s+to\b|계좌\s*변경|\bnew\s+bank\b|bank\s+details\s+changed|공식\s*계정이\s*아닌|\bnot\s+the\s+official\b/i;
const HARASSMENT_THREAT_PATTERN = /\b(?:i'?ll|i\s+will)\s+(?:kill|hurt|destroy)\s+you\b|\bkill\s+you\b|\bfuck\s+you\b|\byou\s+(?:are|'re)\s+(?:a|an)\s+(?:idiot|moron|asshole|bitch)\b|씨발|개새끼|병신\s*새끼|죽여\s*버리|죽여버릴/i;

export function isHardStopSafety(seed: string): boolean {
  const text = stripQuotedAndSignatureBlocks(seed).toLowerCase();
  return MINOR_SELF_REPORT_PATTERN.test(text)
    || PAYMENT_IMPERSONATION_PATTERN.test(text)
    || HARASSMENT_THREAT_PATTERN.test(text);
}

// 2026-09-24 (코덱스 적대 리뷰 — interest_next_steps 허용목록 방어선): MINOR_SELF_REPORT_PATTERN
//   은 "minor"/"under 18"/한국어 학교급 명사만 잡고, 구체 나이 진술("I am 17 years old", "저는
//   17살이에요")은 안 잡는다 — "I'm interested but I am 17 years old." 가 isHardStopSafety 를
//   통과해 chat-ai.ts 의 always-send 허용목록으로 샐 수 있었다(코덱스 실측). Super Creator
//   Partners 는 19세 이상만 가능하다 — 명시적 나이 진술이 19 미만이면 이 함수는 true.
//   공유 isHardStopSafety/MINOR_SELF_REPORT_PATTERN 은 다른 다수 경로가 의존해 그대로 두고,
//   허용목록 전용 방어선으로 별도 추가한다. 오탐(나이 아닌 숫자를 나이로 오판) 은 안전한
//   방향이다 — false 를 반환해도 기존 게이트는 그대로고, true 오탐은 허용목록만 미적용하고
//   실제 JEV 상담으로 떨어뜨릴 뿐 아무것도 차단하지 않는다.
// 코덱스 적대 리뷰(2026-09-24, 2회차) BLOCKER: 1회차 패턴은 "years old"/"yo" 접미사를 요구해
//   "I'm interested but I am 17." 처럼 접미사 없는 맨 나이 진술("I'm 17")과 한국어 "세" 단위
//   ("17세")를 놓쳤다(코덱스 실측). "I'm/I am <숫자>" 맨 형태와 "세" 단위를 추가한다 — 맨 형태는
//   나이가 아닌 숫자("I'm 5 minutes late")까지 과탐할 수 있지만, 방향은 항상 안전하다(허용목록
//   미적용 → 실제 JEV 상담, 아무것도 차단하지 않는다).
// 코덱스 적대 리뷰(2026-09-24, 3회차) BLOCKER: exec() 는 첫 매치에서 멈춘다 — "I am 19, actually
//   I am 17. I am interested." 는 첫 매치(19, 미성년 아님)에서 멈춰 뒤의 17 을 놓쳤다(코덱스
//   실측). 전역(g) 플래그로 원문에 등장하는 **모든** 나이 진술을 스캔해, 그중 하나라도 19 미만이면
//   true 를 반환한다.
const STATED_AGE_PATTERN =
  /\bi\s*(?:'m|am)\s+(?:only\s+)?(\d{1,2})\s*(?:years?\s*old|yo)\b|\b(\d{1,2})\s*(?:years?\s*old|yo)\b|\bi\s*(?:'m|am)\s+(?:only\s+)?(\d{1,2})\b|(\d{1,2})\s*(?:살|세)(?:이에요|입니다|이야|이고|이에용|에요)?/gi;
export function isStatedMinorAge(seed: string): boolean {
  const text = stripQuotedAndSignatureBlocks(seed);
  for (const match of text.matchAll(STATED_AGE_PATTERN)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4];
    const age = Number(raw);
    if (Number.isFinite(age) && age > 0 && age < 19) return true;
  }
  return false;
}

export function isSoftDecline(seed: string): boolean {
  const text = seed.toLowerCase();
  // auto-close 리뷰(F2): 거절 변종이 종결 인사로 새면 "정중한 거절"이 스레드를 조용히 닫는다 —
  //   i'll pass / pass on / not a fit / 안 될·안 할·못 할 / 다음에·다음 기회 류를 추가한다.
  //   R-1 (2차 리뷰): 어려 어간 추가 — "어려울 것 같아요"는 어렵 으로 잡히지 않았다.
  //   오탐 방향은 항상 needs_review(닫지 않는 쪽) — "다음에 봬요" 류도 검수로 가도 무해하다.
  return !isHardOptOut(text) && /not interested|no thanks|decline|pass for now|not now|i'?ll\s+pass|pass\s+on|not a (?:good )?fit|isn['’]?t a fit|not this time|(?:can['’]?t|cannot|can not)\s+participate|not able to (?:join|participate)|unable to (?:join|participate)|안할래|관심\s*없|관심\s*낮|거절|어렵|어려|안\s*될|안\s*할|못\s*할|다음에|다음\s*기회|fit my current content plan/.test(text);
}

// 모든 HUMAN_REVIEW_RULES 중 이메일 전용(email-only-no-call) 규칙만 제외한 매치 + 하드 옵트아웃 — "이 원문에 메신저/통화
//   홀드 말고 다른 보호 사유가 전혀 없다"를 증명하는 데 쓴다(첫 매치에서 멈추는 reviewGateForText 로는 증명 불가).
export function allReviewGateExcludingEmailOnlyMatches(seed: string): string[] {
  const text = seed.toLowerCase();
  const matches: string[] = [];
  if (isHardOptOut(seed)) matches.push("opt-out", "legal-risk", "mail-shutdown");
  for (const rule of HUMAN_REVIEW_RULES) {
    if (rule.ruleId === "email-only-no-call-human-review") continue;
    if (rule.pattern.test(text)) matches.push(rule.ruleId);
  }
  return matches;
}

// 순수 이동 요청만 자동 회신한다 — 금액·요율·지급 어휘가 하나라도 있으면(숫자 기호 없는 "my fee is 500" 포함) 사람 검토.
const MONEY_OR_PAYMENT_WORD_PATTERN =
  /\b(?:rates?|fees?|prices?|pricing|budget|cpm|usd|krw|eur|dollars?|euros?|bucks|payments?|paid|pay|payout|invoice|salary|amounts?|asking|compensat\w*|earn\w*|money|cash|hundred|thousand|million|per\s+(?:video|month|view|post|upload)|each\s+(?:video|upload|post))\b|\d{2,}|단가|금액|정산|지급|결제|비용|수수료|보상|얼마|만원|천원/i;

const COMPLAINT_OR_FRICTION_PATTERN =
  /\b(?:complain\w*|scam\w*|fraud\w*|angry|furious|frustrat\w*|terrible|unacceptable|disappoint\w*|ridiculous|outrag\w*|rip(?:ped)?\s*off|worst)\b|불만|사기|화가|짜증|항의/i;

// Exclusivity (Astra review 2026-10-03, WHITELIST): the fixed redirect answers ONLY the messenger ask. After removing messenger names,
//   EVERY remaining word must be greeting/thanks/connective filler or one of the transfer verbs the request patterns use — the words
//   between a request verb and the messenger name are validated too, never deleted ("fix my login and chat on WhatsApp", "get the
//   brief and talk on WhatsApp" fail on login/brief). No sign-off names, no non-ASCII residue (Korean etc.) — those go to a human.
//   Live signal shape is "subject | body | body…": identical parts are de-duplicated and, when several parts exist, the first is the
//   subject (reply prefixes stripped; it must be a short statement, no question — the blacklist predicates still run on it too).
//   Restrictive-only: false => human review.
// Outside the recognised request phrases only COMPLETE harmless phrases may remain (greeting, thanks, sign-off, "can you", "so we can
//   talk there", "instead of email"). A bag of allowed words is not enough — "could you email me WhatsApp chat" is built entirely from
//   individually harmless words. The wildcard request pattern (index 1) is consumed only when every word inside the match is in the
//   transfer-verb grammar below; tight phrases (fixed verb + messenger name) are consumed whole.
const MESSENGER_FILLER_PHRASES = new RegExp(
  `\\b(?:${[
    "hi(?: there)?", "hello(?: there)?", "hey(?: there)?", "dear (?:supercent )?team",
    "thanks(?: a lot| so much| again)?", "thank you(?: so much| very much| a lot)?", "many thanks", "thx",
    "please", "pls", "best regards", "kind regards", "regards", "best", "cheers", "sincerely",
    "(?:can|could|would) you(?: please)?",
    "(?:can|could|shall) we(?: please)? (?:talk|chat)(?: here| there)?(?: instead)?",
    "so we can (?:talk|chat)(?: here| there)?",
    "(?:i'd|i would) like to",
    "(?:instead of|rather than) emails?",
    "or", "and",
  ].join("|")})\\b`,
  "g",
);
// Wildcard-phrase grammar: transfer verbs + tiny connectives ONLY — no possessives/nouns ("my username"), no "and"/"or" (compound asks).
const MESSENGER_WILDCARD_SPAN_WORDS = new Set([
  "let's", "lets", "can", "could", "shall", "we", "better", "easier", "prefer", "to", "move", "switch",
  "continue", "talk", "chat", "discuss", "speak", "communicate", "connect", "reach", "out", "get", "in", "touch", "with", "us", "this",
  "our", "conversation", "further", "over", "through", "using", "via", "by", "on", "instead", "here", "there", "also", "please",
]);
function tokensOf(text: string): string[] {
  return text.split(/[^a-z']+/).filter((token) => token.length > 0);
}
function messengerResidueIsFiller(part: string): boolean {
  let residue = part.toLowerCase().replace(/[’‘]/g, "'").replace(/[—–“”"…]/g, " ");
  // "we chat" (two words) is ordinary English here, not WeChat — only the one-word spelling counts as a name when stripping residue.
  const namesPattern = new RegExp(`\\b(?:${MESSENGER_NAMES_WITH_BARE_LINE.replace("we\\s?chat", "wechat")})\\b`, "gi");
  // A messenger named as the thing being replaced/excluded ("instead of your WhatsApp number", "rather than WhatsApp") is a rejection:
  //   the clause-negation scan treats "instead" as a clause boundary, so it is checked here directly.
  if (new RegExp(`\\b(?:instead\\s+of|rather\\s+than|other\\s+than|except|without|not\\s+on)\\b[^.!?\\n,;:]{0,30}?\\b(?:${MESSENGER_NAMES_WITH_BARE_LINE})\\b`, "i").test(residue)) return false;
  // Tight request phrases are consumed whole (indices 0,2,3,4,5). Index 1 is the wildcard and indices 6/7 are Korean (a Korean
  //   phrase is always residue — never erased): they are not consumed here.
  // "send/share your <messenger>" is a complete request only when it ends there or names a contact object ("… number/ID/handle");
  //   "send me your WhatsApp chat" asks for something else and keeps its verb in the residue (which fails the vocabulary).
  const sendYour = new RegExp(
    `${MESSENGER_REQUEST_PATTERNS[2]!.source}(?:\\s+(?:number|no\\.?|id|handle|username|contact(?:\\s+details)?|account))?(?:\\s+(?:please|pls|thanks|thank\\s+you))?(?=\\s*(?:[.!?,;\\n]|$))`,
    "gi",
  );
  residue = residue.replace(sendYour, " ");
  for (const patternIndex of [0, 3, 4, 5]) {
    const pattern = MESSENGER_REQUEST_PATTERNS[patternIndex]!;
    pattern.lastIndex = 0;
    residue = residue.replace(pattern, " ");
  }
  const wildcard = MESSENGER_REQUEST_PATTERNS[1]!;
  wildcard.lastIndex = 0;
  residue = residue.replace(wildcard, (match) => {
    const span = match.replace(namesPattern, " ");
    // Characters are validated on the ORIGINAL span (tokensOf drops non-letters): digits/%/Korean/symbols inside it keep the match.
    return !/[^a-z'\s]/.test(span) && tokensOf(span).every((token) => MESSENGER_WILDCARD_SPAN_WORDS.has(token)) ? " " : match;
  });
  residue = residue.replace(namesPattern, " ");
  // Unsupported text (digits, "%", "+", currency/other symbols, Korean/other scripts) is never silently dropped — it is residue a
  //   human must read ("a 5% share"). Only letters, whitespace and plain sentence punctuation survive.
  if (/[^a-z'\s.,!?;:()\-]/.test(residue)) return false;
  // Consume complete filler phrases (repeat so a phrase freed by a prior removal is still seen), then nothing may be left.
  let previous: string;
  do {
    previous = residue;
    residue = residue.replace(MESSENGER_FILLER_PHRASES, " ");
  } while (residue !== previous);
  return tokensOf(residue).length === 0;
}

// Structured creator fields (trusted receive path, same provenance rules as the counter-offer fields): the body is word-whitelisted;
//   the subject must be empty, a reply-prefixed echo of this thread's matched OUTBOUND subject, or itself pass the whitelist — an
//   unverified subject is never exempt ("I am sixteen | Please add me on WhatsApp." holds). A parser-stripped quoted history cannot be
//   proven safe, so anything but "clean"/unspecified holds. Without fields the whole text (subject | body | body) is whitelisted.
function isMessengerRequestOnlyInput(text: string, fields: CounterOfferCreatorFields | undefined): boolean {
  if (!fields) return messengerResidueIsFiller(text.replace(/\|/g, " "));
  if (fields.quotedHistory !== undefined && fields.quotedHistory !== "clean") return false;
  // The positive request must be in the current BODY — an echoed subject only supplies context, never the ask itself.
  if (!hasMessengerChannelRequest(fields.body) || !messengerResidueIsFiller(fields.body)) return false;
  const subject = fields.subject ?? "";
  if (!subject.trim()) return true;
  const rest = normalizeSubjectForCompare(subject);
  if (!rest) return true;
  const original = normalizeSubjectForCompare(fields.originalSubject ?? "");
  if (original && rest === original) return true;
  return messengerResidueIsFiller(subject.replace(COUNTER_SUBJECT_PREFIX, ""));
}

/**
 * 원문 **전체**가 "연락을 메신저로 옮기자"는 순수 요청인지 독립 판정한다(contact_channel_request 자동 회신 전제):
 *   메신저 이동 요청 문맥이 있고(서명·부정문 제외), 통화/미팅 요청이 없고, 금액·역제안·대행사·계약·정산·옵트아웃 등 다른
 *   보호 신호와 불만·거절이 전혀 없다.
 */
export function isCleanMessengerRedirectRequest(seed: string, creatorFields?: CounterOfferCreatorFields): boolean {
  return (
    hasMessengerChannelRequest(seed) &&
    isMessengerRequestOnlyInput(seed, creatorFields) &&
    !hasCallOrMeetingRequest(seed) &&
    !hasCurrencyAmount(seed.toLowerCase()) &&
    !isCounterOfferSignal(seed) &&
    !isStatedPricePhrase(seed) &&
    !MONEY_OR_PAYMENT_WORD_PATTERN.test(seed) &&
    !isAgencyOrManagementReply(seed) &&
    allReviewGateExcludingEmailOnlyMatches(seed).length === 0 &&
    !isSoftDecline(seed) &&
    !COMPLAINT_OR_FRICTION_PATTERN.test(seed)
  );
}

export function reviewGateForText(seed: string): HumanGate | null {
  const text = seed.toLowerCase();
  for (const rule of HUMAN_REVIEW_RULES) {
    if (rule.pattern.test(text)) {
      return { decision: "needs_review", reason: rule.reason, ruleIds: [rule.ruleId] };
    }
  }
  return null;
}

// F-5 (AUTO-MAIL-SAFETY-DESIGN-2026-09-16.md §B "③민감 갭"): 이 exclusion 없이는 "share the
// details of my missing payment" 같은 문장이 SAFE_INFO_REQUEST_PATTERN("share...details")에
// 먼저 걸려 HUMAN_REVIEW_RULES(reviewGateForText, isSafeInfoRequest 보다 나중에 평가됨)의
// settlement_dispute/press_partnership/personal_data 세 규칙에 영영 못 닿고 auto_reply 로
// 새 나간다 — contract/agency 배제와 같은 기존 패턴을 그대로 따른다.
function isSafeInfoRequest(seed: string): boolean {
  const text = seed.toLowerCase();
  return SAFE_INFO_REQUEST_PATTERN.test(text)
    && !isHardOptOut(text)
    && !hasCurrencyAmount(text)
    && !/\b(contract|signature|usage rights|exclusivity|license|revision|cancellation|terms|approval|manager|agency|representative|legal action|lawsuit|unsubscribe|do not email|missing payment|didn['’]?t\s+receive|did\s+not\s+receive|never\s+received|haven['’]?t\s+received|underpaid|wrong\s+amount|press|media|journalist|interview|partnership\s+proposal|sponsorship\s+offer|delete\s+my\s+data|gdpr|personal\s+information)\b|계약|서명|사용권|독점|수정|취소|약관|매니저|대행사|소송|고소|수신\s*거부|안\s*받았|못\s*받았|정산\s*누락|정산\s*오류|제휴|언론|기자|취재|개인정보|삭제\s*요청/i.test(text);
}

// 파일럿 정책(A): 감사 표현만 있고 명시적 참여·요청·질문이 없는 저커밋 긍정은 자동답장 대신
// 사람 검수로 보낸다(감사 ≠ 참여 확정). thanks+요청/질문이면 저커밋 아님 → auto_reply 유지.
//   auto-close 정책(B) 이후 역할이 바뀌었다: 순수 종결 인사는 아래 isClosingAcknowledgment 가
//   먼저 auto_close 로 집어가고, 이 규칙은 "감사는 맞지만 종결 판정이 애매한" 나머지만
//   needs_review 로 보내는 안전망으로 남는다(오탐 방향은 항상 "닫지 않는 쪽").
function isLowCommitmentGratitude(seed: string): boolean {
  const text = seed.toLowerCase();
  const hasGratitude = /\bthank you\b|\bthanks\b|\bappreciate\b|\bgrateful\b|감사|고마/.test(text);
  if (!hasGratitude) return false;
  const hasActionableIntent =
    /\?|\b(participate|join|count me in|i'?m in|let'?s do|do it|sign|send|share|provide|forward|next step|next steps|which|when|what|how|can we|could you|would you|interested|deliverables?|brief)\b/.test(text)
    || isSafeInfoRequest(text);
  return !hasActionableIntent;
}

// 종결 인사 감지 (auto-close 파일럿 — 케이스북 closing_acknowledgment 의 결정적 거울):
//   감사·작별·긍정 마무리 **신호만** 있고 명시적 질문·요청·제안이 없는 회신이다.
//   이런 회신에 자동 답장을 보내면 감사↔감사 루프가 돌고, 사람 검수로 보내면 검수 인박스만
//   오염된다 — 결정론적으로 auto_close (발송도 검수 아이템도 없이 스레드 종결).
//
//   안전 구조 — 오탐은 항상 "닫지 않는 쪽"으로만 일어난다:
//   ① decideHumanGate 에서 HUMAN_REVIEW_RULES(통화·금액·계약·정산·언론 등)가 이 규칙보다
//      먼저 평가되므로 "감사하지만 단가를 올려달라" 는 절대 여기 닿지 않는다.
//   ② 요청 어휘 집합이 isLowCommitmentGratitude 보다 넓다 — 애매한 감사 메일은 종결되지
//      않고 기존 저커밋 규칙(needs_review)으로 그대로 떨어진다.
//   ③ 부정/거절("no thanks", 관심 없음)·옵트아웃은 상위 isSoftDecline/isHardOptOut 이 먼저
//      처리하며, 여기서도 한 번 더 가드한다(직접 호출 경로 대비 — sanitizedSummary).
function isClosingAcknowledgment(seed: string): boolean {
  // F6 (auto-close 리뷰): 인용·서명 블록은 하드 가드(isHardOptOut/isHardStopSafety)와 같은
  //   기준으로 먼저 벗긴다 — 전달문/인용 안의 질문이 새 발신자 요청으로 읽히거나, 반대로
  //   인용부의 작별 문구가 신호를 오염시키는 것을 막는다.
  const text = stripQuotedAndSignatureBlocks(seed).toLowerCase();
  if (isHardOptOut(text) || isSoftDecline(text)) return false;
  const hasClosingSignal =
    /\bthank\s+you\b|\bthanks\b|\bappreciate(?:d|s)?\b|\bgrateful\b|감사|고마/.test(text)
    || /\bhave\s+a\s+(?:good|great|nice|wonderful|lovely)\s+(?:day|weekend|week|evening|one|holiday)s?\b|\btake\s+care\b|\ball\s+the\s+best\b|\bbest\s+(?:wishes|regards)\b|\bkind\s+regards\b|\bwarm\s+regards\b|\btalk\s+soon\b|\bspeak\s+soon\b|\bno\s+need\s+to\s+(?:reply|respond)\b|\bno\s+response\s+(?:needed|required)\b/.test(text)
    || /좋은\s*하루|좋은\s*주말|좋은\s*저녁|안녕히\s*(?:가세요|계세요)|행복한\s*하루|즐거운\s*(?:하루|주말)|건강하세요|수고하세요|고생하세요|답장\s*안\s*하셔도|답변\s*안\s*하셔도|회신\s*불필요|답장\s*불필요/.test(text);
  if (!hasClosingSignal) return false;
  // F2(b): 감사 + 대조 접속("감사하지만", "고맙지만", "…습니다만", "thanks, but/however")은
  //   종결이 아니라 조건부·거절의 신호다 — isSoftDecline 어휘를 못 쓰는 변종(예: "감사합니다만
  //   이번엔 …")이 스레드를 닫지 못하게 접속사 자체를 차단한다.
  if (/하지만|지만|니다만|습니다만|그런데|근데|다만|\bbut\b|\bhowever\b|\bthough\b|\bunfortunately\b/.test(text)) return false;
  // 요청·질문 어휘는 저커밋 감지 집합의 상위 집합으로 잡는다 — 종결 오탐(요청을 놓치고
  // 스레드를 닫음)이 자동발송 억제 오탐보다 위험하므로, 조금이라도 요청으로 읽히면 닫지 않는다.
  //   F1: 한국어 요청 어휘를 대폭 넓힌다(참여/신청/지원/…싶/할게/하겠/볼게/여쭤/바람/주시/
  //   드리/연락/회신/답변/말씀/물어/…까/나요/는지/줘) — 실측된 조용한 종결("참여하고 싶습니다",
  //   "회신 주시면 감사하겠습니다", "답변 바랍니다", "여쭤볼게요", "신청할게요")을 막는다.
  //   의도된 과탐(needs_review 방향): "빠른 회신 감사합니다", "말씀 주셔서 감사합니다" 는
  //   순수 감사지만 검수로 간다 — 닫지 않는 쪽 오탐이므로 허용한다.
  //   감사 활용형(감사드립니다/감사히 드립니다)과 "회신 불필요(no need to reply)" 면제 문구는
  //   요청 판정 전에 제거한다 — 어휘 확장이 순수 종결 표현까지 삼키지 않게.
  const actionableText = text
    .replace(/감사\s*(?:히\s*)?드리(?:겠|시|세|세요|겠습)?/g, " ")
    .replace(/no\s+need\s+to\s+(?:reply|respond)|no\s+response\s+(?:needed|required)/g, " ");
  const hasActionableIntent =
    // R-1 (2차 리뷰): question/ask/wonder/clarif 추가 — "Thanks! Quick question for you",
    //   "I was wondering about the timeline" 류 감사+질문 꼬리가 여전히 새고 있었다.
    //   reply/respond 는 의도적으로 제외 — 시드의 intent 필드(":reply:")와 충돌해 종결이
    //   구조적으로 불가능해진다(1차 적용 때 회귀로 확인된 seed-form 중독).
    /\?|\b(participate|join|count me in|i'?m in|let'?s do|do it|sign|send|share|provide|forward|next steps?|which|when|what|how|where|who|why|can we|can you|could you|would you|could i|can i|may i|please|check|confirm|verify|update|let me know|i'?d like|i would like|i need|i want|any updates?|follow[ -]?ups?|following up|just checking|just following|look into|get back|interested|deliverables?|brief|feedback|thoughts?|review|questions?|ask(?:s|ed|ing)?|wonder(?:ing)?s?|clarif\w*)\b/.test(actionableText)
    // R-1: 묻 어간(묻겠/묻고/묻습/묻는/묻자 — "한 가지 묻겠습니다")과 여쭙(여쭤의 표준 활용형),
    //   바래("바래요") 추가 — 물어보/물어볼 은 기존 물어 어간이 이미 덮는다.
    || /주세요|주십시오|주시|부탁|기다리|기다릴|문의|질문|궁금|요청|가능한가|가능할까|해\s*달라|해달라|알려\s*달라|확인\s*(?:부탁|해\s*주|바람|바랍|바래|요청)|참여|신청|지원|고\s*싶|하고\s*싶|할게|할께|하겠|볼게|볼께|여쭤|여쭐|여쭙|바람|바랍|바래|드리|연락|회신|답변|말씀|물어|묻겠|묻고|묻습|묻는|묻자|될까|을까|ㄹ까|나요|는지|해\s*줘|해줘|보내줘|알려줘/.test(actionableText)
    || isSafeInfoRequest(text);
  return !hasActionableIntent;
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function scoreHumanReviewEvidence(context: HumanGateContext = {}): EvidenceScore {
  const followers = positiveNumber(context.creatorFollowers);
  const recentViews = positiveNumber(context.creatorRecentViews);
  const engagement = positiveNumber(context.creatorEngagementPct);
  const signals: string[] = [];
  let score = 0;
  if (followers > 0) {
    score += 35;
    signals.push("followers");
  }
  if (recentViews > 0) {
    score += 45;
    signals.push("recentViews");
  }
  if (engagement > 0) {
    score += 20;
    signals.push("engagement");
  }
  return { score, signalCount: signals.length, signals };
}

export function decideHumanGate(seed: string): HumanGate {
  const text = seed.toLowerCase();
  // auto-reply-risk-taxonomy (2026-09-17): hard-stop safety wins over every other rule below,
  // including the needs_review rules — a minor self-report, a payment-redirect/impersonation
  // attempt, or harassment/threats must never reach a generated draft.
  if (isHardStopSafety(text)) {
    return { decision: "blocked", reason: "hard safety stop: minor self-report, payment/account impersonation, or harassment/threat signal", ruleIds: ["hard-stop-safety"] };
  }
  if (isHardOptOut(text)) {
    return { decision: "blocked", reason: "recipient opt-out or legal threat; stop outbound and blacklist candidate", ruleIds: ["opt-out", "legal-risk", "mail-shutdown"] };
  }
  if (DELIVERY_FAILURE_SIGNAL_PATTERN.test(text)) {
    return { decision: "blocked", reason: "delivery-status signal (bounce, provider/SMTP block, or rate limit) blocked this delivery", ruleIds: ["rate-limit", "bounce-check"] };
  }
  if (text.includes("10500") || text.includes("10,500") || text.includes("over-limit") || text.includes("first-agency") || text.includes("final-signature")) {
    return { decision: "needs_review", reason: "human-in-loop rule matched: guide limit, first agency, or final signature", ruleIds: ["a3", "a4", "a5"] };
  }
  if (text.includes("1500") || text.includes("near-limit") || hasCurrencyAmount(text)) {
    return { decision: "needs_review", reason: "currency, amount, or near-guide budget term requires human review", ruleIds: ["budget-amount-human-review"] };
  }
  if (isSoftDecline(text)) {
    return { decision: "needs_review", reason: "soft decline/conditional interest requires human review before any reconsideration reply", ruleIds: ["soft-decline-human-review"] };
  }
  if (isSafeInfoRequest(text)) {
    return { decision: "auto_reply", reason: "safe brief or next-step request can be handled by email-only automation", ruleIds: ["safe-info-request-auto-reply", "email-only-next-step"] };
  }
  // auto-close 정책(B): 결정적 검수 규칙(HUMAN_REVIEW_RULES — 통화·금액·계약·정산·언론 등)이
  //   종결 인사 판정보다 **먼저** 평가된다. "감사하지만 단가/통화/계약을…" 류는 종결 인사의
  //   신호 어휘를 일부 포함해도 여기서 needs_review 로 집어간다 — 순수 종결만 아래로 내려온다.
  //   (종전엔 저커밋 감사 규칙이 검수 규칙보다 먼저여서 ruleId 만 gratitude 로 기록됐다 —
  //     판정 결과는 needs_review 로 동일하므로 구체 규칙이 먼저 찍히는 쪽이 진단에 낫다.)
  const reviewGate = reviewGateForText(text);
  if (reviewGate) return reviewGate;
  if (isClosingAcknowledgment(text)) {
    return { decision: "auto_close", reason: "terminal closing acknowledgment (gratitude/farewell with no question, request, or proposal) — close thread without replying or opening a review item", ruleIds: ["closing-acknowledgment-auto-close"] };
  }
  if (isLowCommitmentGratitude(text)) {
    return { decision: "needs_review", reason: "gratitude-only reply without explicit commitment, request, or question — pilot policy routes to human review", ruleIds: ["gratitude-low-commitment-human-review"] };
  }
  return { decision: "auto_reply", reason: "clear low-risk positive reply matched within guide", ruleIds: ["a1"] };
}

/**
 * W76-③ — **증거 부족 면제가 허용되는 안전 안내 분류의 정본.**
 *
 * 여기 있는 것만 "가이드 링크·다음 단계 안내"로 끝나는 회신이다. 가격·조건·참여 확정이
 * 얽히는 분류는 절대 넣지 않는다 — 넣는 순간 증거 문턱이 있으나 마나가 된다.
 * (decideHumanGate 가 붙이는 ruleId 와 1:1 로 맞춰야 한다.)
 */
/**
 * R1-P1-4: **면제에서 제외하는 사고·장애 어휘.**
 *
 * `SAFE_INFO_REQUEST_PATTERN` 은 브리프 논의에서 흔히 같이 나오는 단어라는 이유로
 * `build crashes` / `game build` 를 안전 안내로 함께 분류한다. 그런데 빌드가 깨졌다는 신고는
 * **가이드 링크로 답할 수 있는 회신이 아니다** — 사람이 봐야 하는 장애 보고다.
 * 증거 문턱 면제는 "자료 보내주세요"에만 주고, 이런 신고에는 주지 않는다.
 */
const EXEMPTION_BLOCKED_PATTERN = /\bcrash(es|ed|ing)?\b|\bbroken\b|\bnot working\b|\bbug\b|\berror\b|버그|오류|깨졌|안\s*돼|작동\s*안/i;

const SAFE_INFO_AUTO_REPLY_RULE_IDS: ReadonlySet<string> = new Set([
  "safe-info-request-auto-reply",
  "email-only-next-step",
]);

/**
 * "미답장 인박스 dismiss" (2026-09-26, 헤세 결정): "영업·에이전시 같은 건 계속 쌓아두지 말고
 * 그냥 읽음 표시" — needs_review 로 떨어진 사유가 오직 이 둘 중 하나뿐일 때만(다른 사유와
 * 겹치면 대상 아님 — chat-ai.ts 호출부가 `ruleIds.length === 1` 로 재확인한다) 답장 없이
 * 읽음 처리하고 인박스에서 뺀다.
 *   - agency-human-review: 발신자가 크리에이터 본인이 아니라 소속사·매니저·대행사 담당자.
 *   - press-partnership-human-review: 언론·제휴·스폰서십 제안(외부에서 들어오는 영업성 문의).
 * 수신거부·법적·계약·통화(금액)·협상 등 나머지 needs_review 사유는 절대 여기 포함하지
 * 않는다 — 그 축은 여전히 사람이 봐야 한다(헤세 명시 결정, 2026-09-26).
 */
export const DISMISS_ON_NO_REPLY_RULE_IDS: ReadonlySet<string> = new Set([
  "agency-human-review",
  "press-partnership-human-review",
]);

/**
 * The creator-evidence threshold check decideHumanGateWithContext applies to a base auto_reply, as a reusable predicate:
 * true when the evidence score/signal count is below the (strict/lenient) policy minimums. A post-model lift that turns
 * a base needs_review into auto_reply skips that check (it returned early), so such lifts re-apply it explicitly.
 */
export function humanReviewEvidenceInsufficient(context: HumanGateContext = {}): boolean {
  const policy = context.humanReviewPolicy ?? {};
  const lowDataMode = policy.lowDataReviewMode ?? "strict";
  if (lowDataMode === "lenient") return false;
  const evidence = scoreHumanReviewEvidence(context);
  const minEvidenceScore = typeof policy.minEvidenceScore === "number" ? policy.minEvidenceScore : lowDataMode === "strict" ? 80 : 55;
  const minSignalsForAutoReply = typeof policy.minSignalsForAutoReply === "number" ? policy.minSignalsForAutoReply : lowDataMode === "strict" ? 3 : 2;
  return evidence.score < minEvidenceScore || evidence.signalCount < minSignalsForAutoReply;
}

export function decideHumanGateWithContext(seed: string, context: HumanGateContext = {}): HumanGate {
  const base = decideHumanGate(seed);
  // F5 (auto-close 리뷰): 입력 신호가 clip 상한(GATEWAY_SIGNAL_CLIP_LIMIT)에서 잘렸으면
  //   잘린 꼬리에 요청·질문이 숨어 있을 수 있다 — 종결(auto_close)은 "전체가 순수 작별"임이
  //   확실할 때만 허용하므로 절단 입력에서는 needs_review 로 강등해 사람이 잔문을 본다
  //   (닫지 않는 방향으로 실패). blocked·needs_review 판정은 강한 쪽이므로 그대로 둔다.
  if (base.decision === "auto_close" && context.signalTruncated) {
    return {
      decision: "needs_review",
      reason: "closing acknowledgment seen but the inbound signal was truncated — the clipped tail may hide a request, so route to human review instead of closing",
      ruleIds: [...base.ruleIds, "truncated-signal-fail-open"],
    };
  }
  if (base.decision !== "auto_reply") return base;

  const policy = context.humanReviewPolicy ?? {};
  const lowDataMode = policy.lowDataReviewMode ?? "strict";
  if (lowDataMode === "lenient") return base;

  const evidence = scoreHumanReviewEvidence(context);
  const minEvidenceScore = typeof policy.minEvidenceScore === "number" ? policy.minEvidenceScore : lowDataMode === "strict" ? 80 : 55;
  const minSignalsForAutoReply = typeof policy.minSignalsForAutoReply === "number" ? policy.minSignalsForAutoReply : lowDataMode === "strict" ? 3 : 2;
  if (evidence.score < minEvidenceScore || evidence.signalCount < minSignalsForAutoReply) {
    // W76-③: 안전 안내 회신은 크리에이터 증거의 양과 무관하다(가이드 링크를 돌려줄 뿐이다).
    //   설정이 명시로 켜져 있고, eval 이 **안전 안내로 분류한** 회신일 때만 면제한다.
    //   그 외에는 종전대로 강등한다 — 증거 문턱은 가격·커밋 회신을 막으라고 있는 것이다.
    //
    // R1-P1-4: 여기에 `reviewGateForText(seed) === null` 을 **AND** 로 더한다.
    //   isSafeInfoRequest 는 reviewGateForText 보다 **먼저** 평가되므로, "다음 단계 알려줘"
    //   같은 안내 어휘만 섞이면 통화 요청·요율 협상·마감 조정·불만 에스컬레이션·빌드 파손
    //   신고까지 전부 안전 안내로 분류돼 면제를 타고 나간다(리뷰어 실행 재현 6건).
    //   그 어휘들은 이미 HUMAN_REVIEW_RULES 가 needs_review 로 잡고 있으므로, 면제는
    //   **그 규칙에 하나도 걸리지 않은** 회신에만 준다. 안전판을 우회하지 않는다.
    const safeInfoOnly = base.ruleIds.some((ruleId) => SAFE_INFO_AUTO_REPLY_RULE_IDS.has(ruleId))
      && reviewGateForText(seed) === null
      && !EXEMPTION_BLOCKED_PATTERN.test(seed);
    if (!(policy.allowLowDataAutoReplyForSafeInfo === true && safeInfoOnly)) {
      return {
        decision: "needs_review",
        reason: `creator evidence is below admin review threshold (${evidence.score}/${minEvidenceScore}, ${evidence.signalCount}/${minSignalsForAutoReply} signals)`,
        ruleIds: [...base.ruleIds, "data-sufficiency-human-review"],
      };
    }
  }
  return base;
}

/**
 * W105 (SCP 자동화 개방) — **post-model 증거면제 리프트.**
 *
 * 증거 문턱(minEvidenceScore/minSignalsForAutoReply)의 존재 이유는 "가격·커밋 회신을 막는 것"이다
 *   (W76-③ 주석). 발신자 지표가 답변 내용을 전혀 바꾸지 않는 **고정 안내 회신**(케이스북 auto_ok
 *   케이스의 서버 렌더 템플릿)에는 증거가 의미가 없다 — 신원 미검증 발신자에게도 "지원 방법/자격
 *   요건/다음 단계" 정본 답변은 동일하다.
 *
 * 발동 조건 — 전부 성립할 때만 needs_review 를 auto_reply 로 복원한다:
 *   ① 현재(병합) 게이트의 유일한 홀드 사유가 creator-evidence 부족 — ruleIds 에
 *     "data-sufficiency-human-review" 가 있으면 base 결정론 게이트는 이미 auto_reply 였고
 *     모든 위험 어휘 규칙(reviewGateForText·하드스톱·옵트아웃 등)을 통과한 입력이다.
 *   ② 모델 게이트도 독립적으로 auto_reply — 모델이 needs_review 를 냈으면 그 판단을 존중한다.
 *   ③ 모델이 분류한 케이스북 케이스가 auto_ok — 승인된 정적 템플릿이 있는 케이스만 해당.
 *   ④ allowLowDataAutoReplyForSafeInfo 토글 ON — 기존 안전안내 면제와 같은 운영 스위치.
 *     기본값은 꺼짐이며, 꺼져 있으면 이 함수는 항상 입력을 그대로 반환한다.
 *
 * 이 리프트는 evidence 게이트만 건너뛴다 — JEV 판정·permit·서버 렌더·메일 세이프티·억제·
 *   옵트아웃 게이트는 전부 그대로 후행한다. 상향이 아니라 "증거 게이트 적용 제외"다.
 */
export function liftEvidenceHoldForAutoOkCase(input: {
  readonly humanGate: HumanGate;
  readonly modelGate: HumanGate;
  readonly modelCaseIsAutoOk: boolean;
  readonly policy: HumanReviewPolicy | undefined;
  readonly caseId: string;
}): HumanGate {
  const { humanGate, modelGate, modelCaseIsAutoOk, policy, caseId } = input;
  if (
    humanGate.decision === "needs_review" &&
    humanGate.ruleIds.includes("data-sufficiency-human-review") &&
    modelGate.decision === "auto_reply" &&
    modelCaseIsAutoOk &&
    policy?.allowLowDataAutoReplyForSafeInfo === true
  ) {
    return {
      decision: "auto_reply",
      reason: `casebook ${caseId}: auto_ok informational reply — creator-evidence exemption under safe-info policy`,
      ruleIds: [...humanGate.ruleIds, "evidence-exempt-auto-ok-info"],
    };
  }
  return humanGate;
}

// 코덱스 적대 리뷰(2026-09-24, 2회차) BLOCKER: HUMAN_REVIEW_RULES 의 budget-or-rate-human-review 는
//   negotiate/raise/discount 같은 "협상 시도" 어휘만 잡고, "My fee is \$300", "I agree to \$300"
//   같은 평서형 제안·수락은 전혀 잡지 못한다 — 모델 오분류 하나에만 기대는 취약점이었다(1차 수리).
//   그런데 1차 수리한 동사 목록도 "Sure, \$300 works for me", "Let's do \$300", "ok \$300",
//   "30만원이면 좋습니다" 같은 **캐주얼 동의 표현**(자연어라 사실상 무한 변형)을 못 잡았다(2차 발견).
//   동의어를 하나하나 나열하는 블록리스트는 원천적으로 완결 불가능하므로(whack-a-mole), 방어를
//   뒤집는다 — 리프트는 원문이 **질문 형태**(물음표 포함)일 때만 허용한다("?" 는 EN/KO/JA/ES 전부
//   동일 문자라 언어 종속적이지 않다). "Sure, \$300 works for me." 류 평서형 동의는 물음표가 없어
//   구조적으로 걸린다. 동사/조사 패턴은 물음표가 붙은 동의-확인형("\$300 works, right?")까지
//   잡는 2차 방어선으로 유지한다.
const PROPOSED_OR_ACCEPTED_AMOUNT_PATTERN =
  /\bmy\s+(?:rate|fee|price|quote|budget|ask)\s+is\b|\bi\s+charge\b|\bi\s*(?:'d|would)\s+(?:need|want|charge|ask\s+for)\b|\bi\s+(?:can|could|will|'ll)\s+do\s+(?:it|this)\s+for\b|\bi\s+accept\b|\bi\s+agree(?:\s+to)?\b|\bcount\s+me\s+in\s+for\b|\blet'?s\s+do\s+(?:it|this)?\b|\b(?:sure|yes|yeah|yep|ok|okay|deal|agreed)\b[^.!?]{0,32}\bworks?\b|\bworks?\s+for\s+(?:me|us|you)\b|\bsounds?\s+good\b|\bthat\s+works\b|\bfine\s+by\s+me\b|\bi'?m\s+(?:ok|okay|good|fine)\s+with\b|제\s*(?:단가|가격|요율|비용|금액)(?:는|은|이|가)|수락(?:합니다|할게요|하겠습니다|해요)|동의(?:합니다|할게요|하겠습니다|해요)|좋습니다|좋아요|콜(?:이요|입니다|이에요)?\b|괜찮(?:아요|습니다)/i;

// 코덱스 적대 리뷰(2026-09-24, 3회차) BLOCKER: "seed 어딘가에 물음표"라는 전역 체크는 너무
//   느슨했다 — 실제 seed 는 제목까지 섞여 있어("Want to collaborate? | Yes, $300 is fine."),
//   본문이 평서형 수락이어도 무관한 제목의 "?" 만으로 통과했다. 그리고 "Can we settle on $300?",
//   "Is $300 okay with you?", "How about $300?" 처럼 **문법상 질문이지만 의미상 제안·확인**인
//   문장은 물음표가 있는데도 협상이다. 두 문제 모두 "물음표가 어디 있는가"가 아니라 "통화 금액이
//   실제로 등장하는 문장이 무슨 말을 하는가"로 좁혀야 풀린다 — 문장 단위로 스코프를 좁힌다.
// 코덱스 적대 리뷰(2026-09-24, 4회차) BLOCKER: 문장 분리가 "."를 전부 경계로 쓰면 "$300.00"
//   처럼 금액 자체에 소수점이 있을 때 "Would $300"/".00 work?" 로 쪼개져, 확정 동사(work)와
//   금액이 서로 다른 절에 떨어져 RATE_SETTLE_OR_CONFIRM_PATTERN 이 무력화된다. 숫자 사이의 "."
//   (센트 표기)는 보존 마커로 치환해 절이 갈라지지 않게 한다 — **복원하지 않는다**: 마커를 다시
//   "."으로 되돌리면 RATE_SETTLE_OR_CONFIRM_PATTERN 의 간격 클래스(`[^.!?\n？]`)가 그 "."에서
//   또 끊겨 "would...work" 같은 근접 매칭이 재차 무력화된다(4회차 리뷰 1차 수리에서 실측한
//   회귀). hasCurrencyAmount 는 통화 접두부(`$300`)만으로도 참이 되므로 마커가 남아 있어도
//   안전하게 매칭된다 — 이 함수가 반환하는 절은 패턴 매칭 전용이며 사람에게 보여주지 않는다.
function currencyBearingClauses(seed: string): string[] {
  const guarded = seed.replace(/(\d)\.(\d)/g, "$1\u0000$2");
  const clauses = guarded.match(/[^.!?\n？]+[.!?？]?/g) ?? [guarded];
  return clauses.filter((clause) => hasCurrencyAmount(clause));
}

// 통화 금액이 등장한 바로 그 문장이 "합의·확정·제안 수락"을 묻거나 진술하면(질문형이든 평서형이든)
//   가이드 리다이렉트 대상이 아니다 — 정찰제 하드 룰이 지키려는 게 정확히 이 경계다.
//   4회차 코덱스 리뷰가 발견한 구체 우회("Perfect, $300 it is!", "Great, $300 then?", "$300,
//   no problem.", "$300로 할게요") 를 반영해 확정 관용구를 넓혔다. 5회차는 "Can you pay me $300
//   as your rate for this video?" 류 — 창작자가 본인에게 직접 특정 금액을 지불해달라고 요청하는
//   문장(질문형이라도 실질은 금액 제안)을 추가했다. 6회차: 한국어는 "저한테 $300 주실 수
//   있나요?" 처럼 수신자 표지와 지불 동사 **사이에 금액이 끼어드는** 어순이라, 인접(`\s*`) 가정이
//   깨졌다 — 영문 근접 가드(`[^.!?\n？]{0,24}`)와 같은 간격 허용으로 통일한다. 자연어 동의·요구
//   표현은 원천적으로 완결될 수 없는 집합이므로, 이 목록은 실측된 우회를 반영해 계속 넓어질 수
//   있는 방어선이지 유일한 방어선이 아니다(후행하는 JEV 의미판정·permit·기본 꺼짐 토글이 나머지를
//   맡는다).
const RATE_SETTLE_OR_CONFIRM_PATTERN =
  /\bsettle\s+(?:on|for)\b|\bhow\s+about\b|\bwhat\s+about\b|\b(?:would|does|will|can)\b[^.!?\n？]{0,24}\bwork\b|\bworks?\s+for\s+(?:me|us|you)\b|\b(?:is|are|it'?s)\b[^.!?\n？]{0,24}\b(?:okay|ok|fine|good)\b|\bsounds?\s+good\b|\bthat\s+works\b|\bdeal\b|\bagreed\b|\bi\s+agree\b|\bi\s+accept\b|\bit\s+is\b|\bno\s+problem\b|\bgreat\b|\bperfect\b|\bthen\?|\bsounds?\s+right\b|\bpay\s+me\b|\byou\s+pay\s+me\b|\bgive\s+me\b|저(?:한테|에게)[^.!?\n？]{0,24}(?:지불|지급|주실|주시|주세요|줄래|줘)|괜찮(?:을까요|나요|습니까|아요|습니다)|좋을까요|어때요|할까요|동의|할게요|하겠습니다|할래요/i;

// 위 BLOCKER 의 근본 수리 — 구조적 게이트. 리프트는 다음 셋이 전부 참일 때만 허용한다:
//   ① seed 어딘가에 "?"/"？" 가 있다(창작자가 질문할 가능성이 있다는 최소 신호) —
//   ② 통화 금액이 등장하는 문장이 **최소 하나** 있고(hasCurrencyAmount 가 이미 seed 전체에서
//      참이었으므로 필연적으로 존재) —
//   ③ 그 통화-등장 문장들 **어느 것도** RATE_SETTLE_OR_CONFIRM_PATTERN 에 걸리지 않는다 — 걸리면
//      질문형이든 아니든(코덱스 3차 리뷰의 "질문으로 위장한 제안") 즉시 차단한다.
//   순수 안내 문의(예: 우리 쪽 콜드메일 인용문 "Get paid $1,000+ a month..."에 이어 "How much
//   would I actually get paid for a video like this?")는 통화 문장이 평서형 마케팅 카피일 뿐
//   확정/제안 어휘가 없어 통과한다 — 원래 의도한 사용례는 보존된다.
function looksLikePricingQuestion(seed: string): boolean {
  if (!seed.includes("?") && !seed.includes("？")) return false;
  const bearingClauses = currencyBearingClauses(seed);
  if (bearingClauses.length === 0) return false;
  if (bearingClauses.some((clause) => RATE_SETTLE_OR_CONFIRM_PATTERN.test(clause))) return false;
  return true;
}

/**
 * 2026-09-24 (헤세 지시 — 가격/예산 문의 가이드 리다이렉트) — **post-model 통화-토큰 홀드 리프트.**
 *
 * 실측(프로드 `reviews` 80건 pending 표본, 2026-09-24): 대기 중 budget/pricing 관련 검수의
 *   대다수가 `budget-amount-human-review`(순수 통화 토큰 감지, `hasCurrencyAmount`)이고,
 *   그중 다수는 창작자가 직접 금액을 제안한 게 아니라 스레드에 인용된 **우리 쪽 콜드메일의
 *   금액 문구**(예: "$1,000+ a month")만으로 세션 전체가 홀드된다. 이런 회신을 사람이 열어보면
 *   "관심 있음 — 브리프·다음 단계 요청" 같은 순수 안내 문의였다. 헤세가 이런 문의에 실제로
 *   수동 발송해온 답장은 금액을 밝히지 않고 "내부 정책상 가이드 페이지를 확인해달라"는
 *   정본 안내뿐이었다 — 그 패턴을 `pricing_guide_redirect` 케이스북 케이스로 고정한다.
 *
 * 발동 조건 — 전부 성립할 때만 needs_review 를 auto_reply 로 복원한다:
 *   ① 현재 게이트의 유일한 홀드 사유가 `budget-amount-human-review` (통화 토큰) — 협상 어휘
 *      (`budget-or-rate-human-review` 등 HUMAN_REVIEW_RULES)나 다른 홀드가 섞이면 대상이 아니다.
 *   ② 원문이 `reviewGateForText`(HUMAN_REVIEW_RULES 전체 — 통화/미팅·협상·일정·계약·에이전시·
 *      정산분쟁·언론·개인정보 등)와 `isSoftDecline`에 **독립적으로 재검사해도** 걸리지 않는다.
 *      통화-토큰 체크는 decideHumanGate 안에서 이 규칙들보다 **먼저** 단락되므로(§511), 이
 *      재검사 없이는 "$300 줄 수 있나요, 그리고 통화 가능할까요?" 같은 복합 신호가 새어나간다.
 *   ③ 원문이 질문 형태다(`looksLikePricingQuestion` — "?"/"？" 포함, 2차 코덱스 리뷰 처방).
 *      평서형 동의·수락("Sure, \$300 works for me.", "Let's do \$300.", "30만원이면 좋습니다.")은
 *      물음표가 없어 구조적으로 걸린다 — 동의 표현을 일일이 나열하는 블록리스트는 자연어라
 *      원천적으로 완결 불가능하므로(whack-a-mole), 대신 "질문인가"라는 구조 신호로 뒤집는다.
 *   ④ 원문이 `PROPOSED_OR_ACCEPTED_AMOUNT_PATTERN`(1차 코덱스 리뷰)에도 걸리지 않는다 — "my fee
 *      is \$300", "I agree to \$300", 물음표가 붙은 동의-확인형("\$300 works, right?")까지 잡는
 *      2차 방어선.
 *   ⑤ 모델 게이트도 독립적으로 auto_reply — 모델이 needs_review 를 냈으면 그 판단을 존중한다.
 *   ⑥ 모델이 분류한 케이스북 케이스가 `pricing_guide_redirect` — 승인된 가이드-리다이렉트
 *      정적 템플릿이 있는 케이스만 해당(구체 counter-offer 는 fixed_terms_inquiry 로 남는다).
 *   ⑦ allowGuideRedirectForPricingInquiry 토글 ON — 기본값은 꺼짐인 운영 스위치.
 *   ⑧ 수신 신호가 clip 상한에서 잘리지 않았다(`!signalTruncated`, 1차 코덱스 리뷰) — 절단된
 *      입력은 잘린 꼬리에 통화·미팅·계약 신호가 숨어 있을 수 있어(F5 auto_close 가드와 동일 이유)
 *      독립 재검사(②·③·④)가 전체 원문을 보장할 수 없다. 잘렸으면 무조건 홀드.
 *
 * 이 리프트는 통화-토큰 게이트만 건너뛴다 — JEV 판정·permit·서버 렌더·메일 세이프티·억제·
 *   옵트아웃 게이트는 전부 그대로 후행한다(evidence-exempt 리프트와 동일한 restrictive-only 계약).
 */
export function liftBudgetInquiryHoldForGuideRedirectCase(input: {
  readonly seed: string;
  readonly humanGate: HumanGate;
  readonly modelGate: HumanGate;
  readonly modelCaseIsPricingGuideRedirect: boolean;
  readonly policy: HumanReviewPolicy | undefined;
  readonly caseId: string;
  readonly signalTruncated?: boolean;
}): HumanGate {
  const { seed, humanGate, modelGate, modelCaseIsPricingGuideRedirect, policy, caseId, signalTruncated } = input;
  if (
    !signalTruncated &&
    humanGate.decision === "needs_review" &&
    humanGate.ruleIds.length === 1 &&
    humanGate.ruleIds[0] === "budget-amount-human-review" &&
    looksLikePricingQuestion(seed) &&
    !PROPOSED_OR_ACCEPTED_AMOUNT_PATTERN.test(seed) &&
    modelGate.decision === "auto_reply" &&
    modelCaseIsPricingGuideRedirect &&
    policy?.allowGuideRedirectForPricingInquiry === true &&
    reviewGateForText(seed) === null &&
    !isSoftDecline(seed)
  ) {
    return {
      decision: "auto_reply",
      reason: `casebook ${caseId}: pure pricing/budget inquiry — guide-pointer reply, no amount stated, no negotiation`,
      ruleIds: [...humanGate.ruleIds, "guide-redirect-pricing-inquiry"],
    };
  }
  return humanGate;
}

// v7 (2026-09-24, 헤세 지시 — 역제안 가이드라인 금액 고정회신): 창작자의 회신이 "같은 보상
//   구조 안에서 금액만 다시 제안"하는 역제안인지 판정한다. 두 경로 중 하나면 true:
//   ① 통화 금액이 등장하고, 그 금액-등장 문장이 제안·확정·수락을 묻거나 진술한다
//      (PROPOSED_OR_ACCEPTED_AMOUNT_PATTERN 또는 RATE_SETTLE_OR_CONFIRM_PATTERN — 둘 다
//      pricing_guide_redirect 리프트가 "순수 문의"를 가려낼 때 쓰는 것과 같은 정본 패턴이다.
//      여기서는 반대 방향으로 쓴다 — 이 패턴에 걸리면 "순수 문의"가 아니라 "역제안"이다).
//   ② 통화 금액 없이 순수 협상 어휘만 있다(SIMPLE_RATE_NEGOTIATION_PATTERN — "raise the rate",
//      "협상 가능한가요"). PAYMENT_MECHANICS_PATTERN(인보이스·계좌송금·선입금/후불·독점요율·
//      바이아웃 등)은 일부러 여기서 제외한다 — 지급 방식·시기·구조 변경 요청까지 "역제안이니
//      우리 숫자로 답한다"로 자동 흡수시키면 안 된다(헤세 지시의 지급 시기 변경 제외 카테고리).
// 2026-09-24 (코덱스 적대 리뷰 — interest_next_steps 허용목록 방어선): chat-ai.ts 의 always-send
//   허용목록이 "원문에 가격/협상 신호가 있는가"를 독립 재확인할 때 재사용한다 — 기존엔 모듈 내부
//   전용이었다. hasCurrencyAmount 하나만으로는 통화 기호/단위 없는 맨숫자 제안("My fee is 500 a
//   video")을 놓친다 — 이 함수는 SIMPLE_RATE_NEGOTIATION_PATTERN(숫자 없는 협상 어휘)과
//   PROPOSED_OR_ACCEPTED_AMOUNT_PATTERN("my fee is …" 류 문구 자체)까지 잡는다.
export function isCounterOfferSignal(seed: string): boolean {
  const text = seed.toLowerCase();
  if (SIMPLE_RATE_NEGOTIATION_PATTERN.test(text)) return true;
  if (!hasCurrencyAmount(text)) return false;
  if (PROPOSED_OR_ACCEPTED_AMOUNT_PATTERN.test(text)) return true;
  return currencyBearingClauses(text).some((clause) => RATE_SETTLE_OR_CONFIRM_PATTERN.test(clause));
}

// budget-or-rate-human-review 를 제외한 나머지 HUMAN_REVIEW_RULES 전체 + PAYMENT_MECHANICS_PATTERN
//   을 독립 재검사한다.
//   reviewGateForText() 를 그대로 쓸 수 없는 이유: 이 리프트가 대상으로 삼는 입력 자체가
//   budget-or-rate-human-review(협상 어휘) 또는 budget-amount-human-review(통화 토큰, decideHumanGate
//   에서 HUMAN_REVIEW_RULES 보다 먼저 단락)로 홀드된 입력이라, reviewGateForText 를 그대로
//   호출하면 budget-or-rate 자기 자신이 걸려 항상 non-null 이 된다(리프트가 절대 발동 못 함).
//   그 규칙 자체는 제외하되, PAYMENT_MECHANICS_PATTERN(그 규칙에 얹혀 있지만 "지급 시기/방식/
//   구조" 신호라 isCounterOfferSignal 의 트리거 축이 아닌 부분)은 별도로 다시 검사한다 —
//   그렇지 않으면 "$500 줄 수 있나요, 근데 계좌로 선입금해주세요" 처럼 지급 시기 변경이 단가
//   역제안과 섞인 입력이 budget-or-rate 규칙 하나에 얹혀 있다는 이유만으로 새어나간다.
//   나머지(통화/미팅·일정·계약·에이전시·모호·정산분쟁·언론·개인정보)는 그대로 전부 재검사해 —
//   요청 카테고리 중 하나라도 섞이면 여전히 사람 검토로 남긴다.
//
// v7 (2026-09-24, 코덱스 적대 리뷰 counter_offer_guideline_reply 1·2회차): isHardOptOut 은
//   decideHumanGate 의 최상단에서 이미 평가되지만(hard-stop 이 먼저 이기는 체인), "lawsuit"·
//   "legal action" 같은 명사구만 잡고 "I will sue if you do not pay it" 의 동사 "sue" 는
//   기존 isHardOptOut 패턴에 없다(별도 수리 — 이 함수 범위 밖). 공유 함수를 더 넓히는 대신,
//   이 리프트 전용 방어선으로 독립 재확인한다: isHardOptOut(전체 문구 재확인, defense-in-depth)
//   + "sue" 동사·"소액재판/소송 걸다" 같은 위협 표현·고소·소송 하겠다는 의지 표현.
//   2회차: "take you to small claims court" 는 "take" 와 "court" 사이에 낀 단어가 1개
//   ("this")만 허용하던 1회차 패턴에 안 걸렸다 — "you"/"small claims" 등 낀 단어 0~3개를
//   허용하고, "small claims (court)" 단독 언급도 별도로 잡는다.
//   4회차: 법적 위협은 이 파일의 다른 규칙과 달리 EN/KO 만으로는 부족할 만큼 심각도가 높다 —
//   스페인어 "demandar"(소송하다)/일본어 "訴える·訴訟"(소송·고소)를 최소한으로 추가한다(전체
//   6개 제외 카테고리를 다국어로 완전히 번역하는 건 별도 과제 — 법적 위협만 심각도상 예외).
//   6회차: "sue(?:s|d|ing)?" 는 "suing"(e 탈락 불규칙 현재분사 — sue+ing 이 아니라 su+ing)을
//   전혀 매치하지 않았다("I am suing you over the previous campaign." 가 그대로 새어나갔다).
//   8회차: "take"의 과거분사 "taken"("I have taken our previous dispute to court...")이 없었다.
const COUNTER_OFFER_LEGAL_THREAT_PATTERN =
  /\bsu(?:e(?:s|d)?|ing)\b|\btake[n]?\s+(?:\w+\s+){0,3}to\s+(?:small\s+claims\s+)?court\b|\btake[n]?\s+(?:\w+\s+){0,3}(?:to\s+)?legal\s+action\b|\bsmall\s+claims\b|demandar[ée]?|demandar(?:te|le|los)?|고소\s*(?:하|할|하겠|해)|소송\s*(?:하|할|걸|하겠)|訴え(?:る|ます)|訴訟|\bcease\b|\b(?:lawyers?|attorneys?|solicitors?)\b|\blegal\s+(?:action|counsel|team|notice)\b|\bstop\s+(?:emailing|contacting|messaging|writing)\b|\bunsubscribe\b|\bremove\s+me\b|연락\s*(?:그만|하지)|변호사|법적/i;

// 4회차 리뷰 처방: "고정/보장 월정액 같은 지급 구조 자체를 바꿔달라는 요청"은 counter_offer_
//   guideline_reply 케이스북 텍스트(signals/never)에 모델용 지시로는 있었지만, 결정론적 독립
//   재검사가 없었다 — 모델이 (실수로) 이 케이스로 잘못 분류하면 그대로 새어나간다("My rate is
//   $500 per month as a guaranteed retainer instead of View Reward."). 표준 View Reward/Creator
//   Code 요율표는 "고정 월정액으로 바꿔달라"는 요청에 대한 답이 아니다 — 리프트 전용 방어선으로
//   독립 재확인한다.
//   6회차: "switch"/"guarantee(?:d)?" 는 활용형(switched/switching, guarantees/guaranteeing)이
//   빠져 있었다("I would like to be switched to a fixed fee." 가 새어나갔다).
//   8회차: "retainer"/"flat rate/fee"/"fixed monthly rate/fee/payment"/"creator code" 의 복수형이
//   없었다("I usually work on retainers.", "I prefer flat rates for ongoing work.", "I want fixed
//   monthly payments.", "My rate is $500 instead of creator codes.").
const STRUCTURAL_PAYMENT_CHANGE_PATTERN =
  /\b(retainers?|flat\s+(?:rates?|fees?)|guarantee(?:d|s|ing)?\s+(?:a\s+)?(?:fixed|flat|monthly|weekly)\s+(?:rates?|fees?|payments?|amounts?)|fixed\s+monthly\s+(?:rates?|fees?|payments?)|(?:monthly\s+)?salary|guarantee(?:d|s|ing)?\s+(?:minimum|monthly|income|pay|salary)|minimum\s+guarantee|up-?front|advance\s+(?:payment|fee|pay)|fixed\s+(?:monthly|salary|pay)|instead\s+of\s+(?:the\s+)?(?:view\s+reward|creator\s+codes?|the\s+standard\s+reward|performance[- ]based)|switch(?:ed|es|ing)?\s+(?:me\s+)?(?:from|to)\s+(?:a\s+)?(?:flat|fixed|retainer))\b|고정\s*월정액|고정\s*급여|보장\s*(?:월급|월정액|고정액)|정액제|월급|고정\s*월|최소\s*보장|선지급|선불/i;

// 2026-09-24 (코덱스 적대 리뷰 — interest_next_steps 허용목록 방어선): chat-ai.ts 의 always-send
//   허용목록이 재사용한다 — 기존엔 모듈 내부 전용이었다. reviewGateForText 보다 강한 법적위협
//   탐지(COUNTER_OFFER_LEGAL_THREAT_PATTERN — "sue" 동사형까지 잡음, isHardOptOut 의 "lawsuit"
//   명사형만으로는 "I will sue if this is a scam" 같은 문장이 새어나갔다) + 지급방식/구조 변경
//   신호(PAYMENT_MECHANICS_PATTERN/STRUCTURAL_PAYMENT_CHANGE_PATTERN)까지 포함한다 —
//   HUMAN_REVIEW_RULES(reviewGateForText) 의 상위 집합이다(budget-or-rate 하나만 빠지며, 그건
//   허용목록이 isCounterOfferSignal/hasCurrencyAmount 로 별도 재확인한다).
export function reviewGateExcludingCounterOfferSignal(seed: string, options: { stripQuotes?: boolean } = {}): HumanGate | null {
  const text = seed.toLowerCase();
  if (isHardOptOut(seed, options) || COUNTER_OFFER_LEGAL_THREAT_PATTERN.test(text)) {
    return {
      decision: "needs_review",
      reason: "recipient opt-out or legal threat; stop outbound and blacklist candidate",
      ruleIds: ["opt-out", "legal-risk", "mail-shutdown"],
    };
  }
  if (PAYMENT_MECHANICS_PATTERN.test(text) || STRUCTURAL_PAYMENT_CHANGE_PATTERN.test(text)) {
    return {
      decision: "needs_review",
      reason: "specific budget, rate, payment, or reward terms require human review",
      ruleIds: ["budget-or-rate-human-review"],
    };
  }
  for (const rule of HUMAN_REVIEW_RULES) {
    if (rule.ruleId === "budget-or-rate-human-review") continue;
    if (rule.pattern.test(text)) {
      return { decision: "needs_review", reason: rule.reason, ruleIds: [rule.ruleId] };
    }
  }
  return null;
}

/**
 * Codex 적대 리뷰(2026-09-26, 3회차) BLOCKER 수리: reviewGateExcludingCounterOfferSignal 은
 * 우선순위 배열에서 **첫 매치**에서 멈춘다 — "이 원문에 agency 말고 다른 보호 사유가 전혀 없다"를
 * 증명하려는 호출자에게는 불충분하다(agency 가 배열에서 다른 카테고리보다 앞이면, 뒤쪽 카테고리가
 * 실제로 매치해도 절대 보이지 않는다). 이 함수는 같은 규칙 집합(법적위협/옵트아웃 +
 * 지급방식·구조변경 + budget-or-rate 제외 HUMAN_REVIEW_RULES 전체)을 **전부** 돌며 매치하는
 * ruleId를 빠짐없이 모아 반환한다 — "다른 사유가 있는가"를 정확히 판정하려는 호출자용이다.
 */
export function allReviewGateExcludingCounterOfferMatches(seed: string): string[] {
  const text = seed.toLowerCase();
  const matches: string[] = [];
  if (isHardOptOut(seed) || COUNTER_OFFER_LEGAL_THREAT_PATTERN.test(text)) {
    matches.push("opt-out", "legal-risk", "mail-shutdown");
  }
  if (PAYMENT_MECHANICS_PATTERN.test(text) || STRUCTURAL_PAYMENT_CHANGE_PATTERN.test(text)) {
    matches.push("budget-or-rate-human-review");
  }
  for (const rule of HUMAN_REVIEW_RULES) {
    if (rule.ruleId === "budget-or-rate-human-review") continue;
    if (rule.pattern.test(text)) matches.push(rule.ruleId);
  }
  return matches;
}

/**
 * Codex 적대 리뷰(2026-09-26, 3회차) BLOCKER 수리: isAgencyOrManagementReply 의 느슨한 패턴
 * ("management"/"manager"/"agent" 단어가 원문 어디든 있으면 매치)은 "이 발신자가 크리에이터
 * 본인이 아니라 대신 협상하는 대행사·매니저다"라는 **신원 증거**로 쓰기엔 너무 약하다 — 크리에이터
 * 본인이 "제 소속사(my management company)가 이 조건에 동의합니다" 처럼 자기 회신에 그 단어를
 * 얼마든지 쓸 수 있다(코덱스 실측 재현: "I am the creator and my management company approves the
 * deal. My rate is $500." 가 기존 패턴에 매치해 dismiss 대상이 됐다). 이 함수는 훨씬 더 좁게,
 * 발신자가 **1인칭으로 자신을 대행사/매니저/담당자라고 밝히거나("I am the manager for...",
 * "on behalf of...", "저는 …매니저입니다"), 명시적으로 남을 대신한다고 말하는** 경우만 매치한다 —
 * "my manager"/"제 매니저"(크리에이터가 자신의 매니저를 3인칭으로 언급) 나 "managed by a talent
 * firm"(크리에이터가 자신이 관리받는다고 말함) 처럼 크리에이터 본인이 쓸 수 있는 표현은 의도적으로
 * 제외한다.
 *
 * Codex 적대 리뷰(2026-09-26, 4회차) BLOCKER 수리: 2회차에 좁힌 패턴도 여전히 "자기 자신을
 * 대신한다"는 자기지칭 표현을 구분하지 못했다 — "I am representing myself in this negotiation."
 * (자기지칭 "representing"), "Writing on behalf of myself."(자기지칭 "on behalf of"), "제가 이
 * 채널 담당자입니다"(크리에이터 본인이 **자기 채널**의 담당자라고 자기소개 — 남을 대신하는 게
 * 아니다) 가 모두 오탐으로 매치했다(코덱스 실측 재현). "on behalf of"/"for"/"of" 뒤에
 * myself/me/ourselves 가 오면 부정 lookahead 로 제외하는 3회차 수리를 적용했었다.
 *
 * Codex 적대 리뷰(2026-09-26, 5회차) BLOCKER 수리: 그 부정 lookahead(자기지칭 **단어 블록리스트**)
 * 자체가 완결 불가능한 whack-a-mole이었다 — "I am the manager for MY OWN CHANNEL. My rate is $500."
 * 처럼 "myself/me/us/ourselves" 어디에도 없는 자기지칭 표현이 또 새었다(코덱스 실측 재현). 이
 * 코드베이스의 기존 교훈(PROPOSED_OR_ACCEPTED_AMOUNT_PATTERN 위 주석 — "동의어를 하나하나 나열하는
 * 블록리스트는 원천적으로 완결 불가능하므로, 방어를 뒤집는다")을 그대로 따른다: 자기지칭을
 * **배제**하려 하지 않고, "이/그/해당/제3자 크리에이터"라는 **제3자 지시어를 양성 조건으로 요구**한다
 * — 이미 3라운드를 버틴 "representing + this/the/her/his/their creator(s)" 분기와 정확히 같은
 * 구조다. "for my own channel"/"for myself"/"for me and my channel" 등은 이 양성 목록 중 어느
 * 것도 아니므로 전부 자동으로 걸러진다(화이트리스트라 무한 변형 자체가 문제가 안 된다).
 *
 * hasProtectedHoldSignal의 agency 오버라이드(dismissNoReplyBacklog.ts)에만 쓰인다 —
 * "agency-human-review" HUMAN_REVIEW_RULES 규칙 자체(사람 검토로 보내기만 하는, 저위험 경로)는
 * 여전히 느슨한 isAgencyOrManagementReply 를 그대로 쓴다.
 */
export function isConfirmedAgencyOrManagementSender(seed: string): boolean {
  const text = seed.toLowerCase();
  // "this/the/her/his/their/other/multiple/<N> creator(s)" — the SAME positive third-party object
  // list AGENCY_OR_MANAGEMENT_PATTERN already uses for its own "other creators"/"N creators together"
  // alternatives, reused here so a real multi-creator agency reply ("I'm the talent agency for three
  // creators") still matches.
  //
  // Known accepted residual edge cases (regex substring matching can never be perfect NLU — see
  // Codex 적대 리뷰 2026-09-26 rounds 5–6):
  //   1. A creator who personally negotiates their OWN rate while also mentioning, in the same
  //      message, that they separately manage "other creators" ("I am the creator... I'm also the
  //      manager for other creators... my rate is $500") could still match this whitelist even
  //      though THIS particular rate is their own. Removing "other"/"multiple" would lose real
  //      third-party MCN/agency introductions ("we represent multiple creators") that never state an
  //      exact headcount.
  //   2. An artificially self-negating rhetorical construction ("I am the manager for this creator?
  //      No, I am the creator myself. My rate is $500.") still matches, because `.test()` only checks
  //      substring presence, not surrounding negation/punctuation — this is not a sentence shape any
  //      real creator plausibly writes in outreach correspondence, and hardening against it
  //      (detecting a trailing "?" + a following negation word, in any language) would itself become
  //      another open-ended blocklist with its own gaps.
  // Both are narrow, low-likelihood trade-offs, deliberately not chased further here to avoid
  // reopening the exact whack-a-mole this file already rejected once (see comment above). The
  // operational runbook's MANDATORY human sampling review before any real (non-dryRun) production
  // execution — not this regex alone — is the accepted backstop for this residual risk.
  const THIRD_PARTY_CREATOR =
    "(?:this|the|her|his|their|other|multiple|two|three|four|five|six|seven|eight|nine|ten|\\d+)\\s+creators?";
  return (
    new RegExp(`\\b(?:acting\\s+)?on\\s+behalf\\s+of\\s+${THIRD_PARTY_CREATOR}\\b`).test(text) ||
    /\bi\s*(?:'m|am)\s+(?:the\s+)?(?:their|his|her|this\s+creator'?s)\s+(?:manager|agent|representative)\b/.test(text) ||
    new RegExp(`\\bi\\s*(?:'m|am)\\s+(?:the\\s+)?(?:manager|agent|representative|talent\\s+(?:agent|agency|firm))\\s+(?:for|of)\\s+${THIRD_PARTY_CREATOR}\\b`).test(text) ||
    new RegExp(`\\bwe\\s*(?:'re|are)\\s+(?:the\\s+)?(?:agency|management)\\s+for\\s+${THIRD_PARTY_CREATOR}\\b`).test(text) ||
    // Codex 적대 리뷰(2026-09-26, 5회차) BLOCKER 수리: 이 분기만 목적어 검증 없이 "agency
    // represents"만 있으면 매치했다 — "The agency represents me in other campaigns, but I am
    // speaking for myself here. My rate is $500." 처럼 크리에이터 본인이 "그 에이전시가 (다른 건에서)
    // 나를 대리한다"고 설명하면서 이번 건은 본인이 직접 답한다는 문장까지 오탐으로 매치했다(코덱스
    // 실측 재현). 다른 3개 영어 분기와 동일하게 제3자 크리에이터 목적어를 양성 조건으로 요구한다.
    new RegExp(`\\b(?:our|this|the)\\s+agency\\s+represents?\\s+${THIRD_PARTY_CREATOR}\\b`).test(text) ||
    /\brepresenting\s+(?:this|the|her|his|their)\s+creators?\b/.test(text) ||
    // 제3자 소유격("이 크리에이터의"/"그(분)의"/"해당 크리에이터의")이 명시된 경우만 인정 —
    // 소유격 없는 "저는 …담당자입니다"는 자기 채널 자기소개일 수 있어 제외한다.
    /저는\s*(?:이|그|해당)\s*크리에이터(?:님)?의\s*(?:매니저|담당자|대리인)(?:입니다|이에요|예요)/.test(text) ||
    /소속사\s*담당자입니다|대행사\s*담당자입니다|에이전시\s*담당자입니다/.test(text) ||
    /(?:크리에이터를?|그(?:분|를)|해당\s*크리에이터를?)\s*대신(?:하여|해서)?\s*(?:문의|연락|답장|회신)/.test(text) ||
    /대리하여\s*(?:문의|연락|답장|회신)/.test(text)
  );
}

/**
 * 2026-09-24 (헤세 지시 — 역제안 가이드라인 금액 고정회신) — **post-model 역제안 홀드 리프트.**
 *
 * "역제안일 때는 우선 우리 가이드라인 금액을 말해주는 형태로 가자. 역제안 절대 안 통하고."
 *   liftBudgetInquiryHoldForGuideRedirectCase 와 동형 구조(restrictive-only 리프트)이지만
 *   목적이 반대다 — 저건 "순수 문의엔 숫자를 아예 말하지 않는다", 이건 "역제안엔 우리 숫자로
 *   답하고 창작자 제안에는 동의하지 않는다".
 *
 * 발동 조건 — 전부 성립할 때만 needs_review 를 auto_reply 로 복원한다:
 *   ① 현재 게이트의 유일한 홀드 사유가 `budget-amount-human-review` 또는
 *      `budget-or-rate-human-review` 하나뿐 — 다른 홀드가 섞이면 대상이 아니다.
 *   ② 원문이 실제로 역제안 신호다(`isCounterOfferSignal`).
 *   ③ 원문이 `reviewGateExcludingCounterOfferSignal`(제외 카테고리 전체 — 계약/서명·법무·
 *      통화/미팅·일정·에이전시·모호·정산분쟁·언론·개인정보)에 걸리지 않는다. hasCurrencyAmount
 *      단락 때문에 budget-amount-human-review 홀드에서는 이 규칙들이 원래 평가조차 안 됐으므로
 *      (§511) 독립 재검사가 반드시 필요하다.
 *   ④ 원문이 `isSoftDecline` 이 아니다(조건부 거절/관심 낮음은 여전히 사람 검토).
 *   ⑤ 모델 게이트도 독립적으로 auto_reply — 모델이 needs_review 를 냈으면 그 판단을 존중한다.
 *   ⑥ 모델이 분류한 케이스북 케이스가 `counter_offer_guideline_reply` — 승인된 고정
 *      가이드라인 금액 정적 템플릿이 있는 케이스만 해당(계약/구조 변경 요청은 fixed_terms_inquiry
 *      로 남는다).
 *   ⑦ allowGuidelineReplyForCounterOffer 토글 ON — 기본값은 꺼짐인 운영 스위치.
 *   ⑧ 수신 신호가 clip 상한에서 잘리지 않았다(`!signalTruncated`) — 절단된 입력은 잘린 꼬리에
 *      계약·통화·에이전시 신호가 숨어 있을 수 있어 독립 재검사(③)가 전체 원문을 보장할 수 없다.
 *
 * 이 리프트는 통화/협상-어휘 홀드만 건너뛴다 — JEV 판정·permit·서버 렌더·메일 세이프티·억제·
 *   옵트아웃 게이트는 전부 그대로 후행한다(pricing_guide_redirect 리프트와 동일한 restrictive-only
 *   계약). JEV 필수화는 chat-ai.ts 의 counterOfferGuidelineJevRequiredHoldReasonFor 가 담당한다.
 */
export function liftCounterOfferHoldForGuidelineAmountCase(input: {
  readonly seed: string;
  readonly humanGate: HumanGate;
  readonly modelGate: HumanGate;
  readonly modelCaseIsCounterOfferGuideline: boolean;
  readonly policy: HumanReviewPolicy | undefined;
  readonly caseId: string;
  readonly signalTruncated?: boolean;
  readonly creatorFields?: CounterOfferCreatorFields;
}): HumanGate {
  const { seed, humanGate, modelGate, modelCaseIsCounterOfferGuideline, policy, caseId, signalTruncated, creatorFields } = input;
  const singleHoldReason = humanGate.ruleIds.length === 1 ? humanGate.ruleIds[0] : null;
  if (
    !signalTruncated &&
    humanGate.decision === "needs_review" &&
    (singleHoldReason === "budget-amount-human-review" || singleHoldReason === "budget-or-rate-human-review") &&
    isCounterOfferSignal(seed) &&
    // 0.6.109: 수락 + 금액 언급만으로는 역제안이 아니다 — 명시적 인상/협상/본인 단가 진술 필수(요약과 동일 기준).
    COUNTER_OFFER_EXPLICIT_ASK_PATTERN.test(seed.toLowerCase()) &&
    isPureCounterOfferInput(seed, creatorFields) &&
    reviewGateExcludingCounterOfferSignal(seed) === null &&
    !isSoftDecline(seed) &&
    modelGate.decision === "auto_reply" &&
    modelCaseIsCounterOfferGuideline &&
    policy?.allowGuidelineReplyForCounterOffer === true
  ) {
    return {
      decision: "auto_reply",
      reason: `casebook ${caseId}: counter-offer — fixed guideline amount reply, no negotiation`,
      ruleIds: [...humanGate.ruleIds, "guideline-amount-counter-offer"],
    };
  }
  return humanGate;
}

// contract-rights-human-review 를 제외한 나머지 HUMAN_REVIEW_RULES 전체 + 하드 옵트아웃/법적위협을
//   독립 재검사한다. reviewGateForText() 를 그대로 쓸 수 없는 이유: 이 리프트가 대상으로 삼는
//   입력 자체가 contract-rights-human-review 로 홀드된 입력이라, reviewGateForText 를 그대로
//   호출하면 그 규칙 자기 자신이 걸려 항상 non-null 이 된다(리프트가 절대 발동 못 함). 그 규칙만
//   제외하고 나머지는 전부 재검사한다.
//   단일 early-return 이 아니라 배열 전체를 순회하는 이유는 reviewGateExcludingCounterOfferSignal
//   의 코덱스 적대 리뷰(2026-09-26, 3회차) 교훈과 동일 — 첫 매치에서 멈추면 배열 순서상 뒤쪽에
//   있는 다른 보호 사유를 놓칠 수 있다("이 원문에 다른 사유가 전혀 없다"를 증명하려면 전부
//   훑어야 한다).
export function allReviewGateExcludingContractRightsMatches(seed: string): string[] {
  const text = seed.toLowerCase();
  const matches: string[] = [];
  if (isHardOptOut(seed)) matches.push("opt-out", "legal-risk", "mail-shutdown");
  for (const rule of HUMAN_REVIEW_RULES) {
    if (rule.ruleId === "contract-rights-human-review") continue;
    if (rule.pattern.test(text)) matches.push(rule.ruleId);
  }
  return matches;
}

/**
 * 2026-09-29 (헤세 지시 — scp@ 프로드 사고, incident-2026-09-29-chat/five-auto-candidates.md) —
 * **contract-rights-human-review 단독 홀드 리프트.**
 *
 * 실측(프로드 scp@ inbound 5건): 순수 "신청/계정 승인 상태가 어떻게 되는지" 문의 2건(je/sc)이
 *   contract-rights-human-review 의 bare "approval" 단어 매칭 하나로 needs_review 에 영구
 *   고정됐다(퍼밋/케이스북 재분류로 절대 못 푸는 사유). 원인 키워드 자체는 별도로 좁혔지만
 *   이 규칙은 여전히 "sign"/"contract"/"terms" 등 계약과 무관한 뜻으로도 흔히 쓰이는 bare
 *   단어를 그대로 매치하는 로컬
 *   휴리스틱이다(예: "I signed up a week ago, any update on my approval?"). pricing_guide_redirect/
 *   counter_offer_guideline_reply 와 같은 패턴으로, 모델이 전체 문맥을 읽고 독립적으로
 *   approval_status_inquiry 로 확신 분류했을 때만, 그리고 이 규칙을 제외한 다른 모든 보호
 *   사유가 없을 때만 면제한다.
 *
 * 발동 조건 — 전부 성립할 때만 needs_review 를 auto_reply 로 복원한다:
 *   ① 현재 게이트의 유일한 홀드 사유가 contract-rights-human-review.
 *   ② 원문이 allReviewGateExcludingContractRightsMatches(다른 HUMAN_REVIEW_RULES 전체 +
 *      하드 옵트아웃/법적위협)로 독립 재검사해도 전혀 걸리지 않는다.
 *   ③ isSoftDecline 에도 걸리지 않는다.
 *   ④ 모델 게이트도 독립적으로 auto_reply — 모델이 needs_review 를 냈으면 그 판단을 존중한다.
 *   ⑤ 모델이 분류한 케이스북 케이스가 approval_status_inquiry.
 *   ⑥ allowGuideRedirectForApprovalStatusInquiry 토글 ON — 기본값은 꺼짐인 운영 스위치.
 *   ⑦ 수신 신호가 clip 상한에서 잘리지 않았다(!signalTruncated) — 다른 리프트들과 동일 이유
 *      (절단된 입력은 잘린 꼬리에 계약/옵트아웃 신호가 숨어 있을 수 있어 독립 재검사가 전체
 *      원문을 보장할 수 없다).
 *
 * 이 리프트는 contract-rights-human-review 홀드만 건너뛴다 — JEV 판정·permit·서버 렌더·메일
 *   세이프티·억제·옵트아웃 게이트는 전부 그대로 후행한다(다른 세 리프트와 동일한 restrictive-only
 *   계약).
 */
export function isCleanApprovalStatusInquiry(seed: string, hasInboundAttachments = false): boolean {
  if (hasInboundAttachments) return false;
  // Independently classify the entire input. Signed-up is registration, not a signature.
  const text = seed.replace(/\bsign(?:ed|ing)?\s+up\b/gi, "registered");
  if (/\b(?:contracts?|agreements?|signatures?|sign(?:s|ed|ing)?|terms?|rights?|licens\w*|exclusiv\w*|legal|fees?|rates?|payments?|prices?|amounts?|negotiat\w*|ads?|advertis\w*|attachments?|attached|revisions?|cancellation)\b|계약|법무|단가|금액|결제|지급|사용권|서명|첨부|광고|합의|약관|협상|독점|취소/i.test(text)) return false;
  const accountStatus = /\b(?:my\s+)?(?:account|application)\s+status\b|\bstatus\s+of\s+my\s+(?:account|application)\b|제\s*(?:계정|지원서)\s*상태|지원서\s*상태/i.test(text);
  const approvalStatus = /\b(?:approv(?:al|ed)|accept(?:ed|ance)|awaiting\s+approval|waiting\s+for\s+approval|pending\s+approval)\b|승인|합격/i.test(text) || accountStatus;
  const statusInquiry = /\b(?:when|whether|any\s+update|checking(?:\s+on)?|do\s+you\s+know|can\s+you\s+(?:tell|check|confirm)|could\s+you\s+(?:tell|check|confirm)|approved\s+yet|has\s+(?:my\s+)?(?:account|application)\s+been\s+approved|is\s+(?:my\s+)?(?:account|application)\s+approved|what(?:'s|\s+is)?\s+(?:the\s+)?status)\b|승인\s*(?:됐|되었|되는지|여부|상태)|합격\s*(?:됐|되었|되는지|여부|상태)|상태(?:가|는)?\s*(?:궁금|어떻게|알려|확인)|(?:궁금|알려\s*주|확인\s*부탁)/i.test(text);
  const ownApplication = /\bmy\s+(?:account|application|creator\s+dashboard|dashboard)\b|\b(?:i\s+)?(?:registered|applied|signed\s+up)\b|\b(?:account|application)\s+status\b|제\s*계정|제\s*지원서|지원서|가입/i.test(text);
  return approvalStatus && statusInquiry && ownApplication && allReviewGateExcludingContractRightsMatches(seed).length === 0 && !isSoftDecline(seed);
}

export function enforceApprovalStatusCaseSafety(
  humanGate: HumanGate, caseId: string | undefined, policy: HumanReviewPolicy | undefined,
  seed: string, signalTruncated = false, hasInboundAttachments?: boolean,
): HumanGate {
  if (humanGate.decision !== "auto_reply" || caseId !== "approval_status_inquiry") return humanGate;
  if (policy?.allowGuideRedirectForApprovalStatusInquiry === true && !signalTruncated && hasInboundAttachments === false && isCleanApprovalStatusInquiry(seed, hasInboundAttachments)) return humanGate;
  return { decision: "needs_review", reason: "approval status reply requires an enabled policy and a clean whole-message status inquiry", ruleIds: [...humanGate.ruleIds, "approval-status-case-safety-required"] };
}

export function liftApprovalStatusHoldForGuideRedirectCase(input: {
  readonly seed: string;
  readonly humanGate: HumanGate;
  readonly modelGate: HumanGate;
  readonly modelCaseIsApprovalStatusInquiry: boolean;
  readonly policy: HumanReviewPolicy | undefined;
  readonly caseId: string;
  readonly signalTruncated?: boolean;
  readonly hasInboundAttachments?: boolean;
}): HumanGate {
  const { seed, humanGate, modelGate, modelCaseIsApprovalStatusInquiry, policy, caseId, signalTruncated, hasInboundAttachments } = input;
  if (
    !signalTruncated &&
    hasInboundAttachments === false &&
    humanGate.decision === "needs_review" &&
    humanGate.ruleIds.length === 1 &&
    humanGate.ruleIds[0] === "contract-rights-human-review" &&
    isCleanApprovalStatusInquiry(seed, hasInboundAttachments) &&
    !isSoftDecline(seed) &&
    modelGate.decision === "auto_reply" &&
    modelCaseIsApprovalStatusInquiry &&
    policy?.allowGuideRedirectForApprovalStatusInquiry === true
  ) {
    return {
      decision: "auto_reply",
      reason: `casebook ${caseId}: pure application/approval status inquiry — no contract/rights/payment/agency signal`,
      ruleIds: [...humanGate.ruleIds, "guide-redirect-approval-status"],
    };
  }
  return humanGate;
}

/**
 * 2026-10-03 (헤세 결정 — contact_channel_request 자동 회신) — **email-only 단독 홀드 리프트.**
 *
 * 발동 조건 — 전부 성립할 때만 needs_review 를 auto_reply 로 복원한다:
 *   ① 현재 게이트의 유일한 홀드 사유가 `email-only-no-call-human-review`.
 *   ② 원문 전체가 isCleanMessengerRedirectRequest(메신저 이동 요청 문맥 + 통화/미팅·금액·역제안·대행사·계약·정산·옵트아웃·
 *      불만·거절 없음)로 독립 재검증을 통과한다 — 서명의 메신저 ID·부정문은 요청이 아니다.
 *   ③ 모델 게이트도 독립적으로 auto_reply, ④ 모델 케이스가 contact_channel_request,
 *   ⑤ humanReviewPolicy.allowEmailOnlyRedirectForContactChannelRequest 토글 ON(기본 꺼짐), ⑥ 신호가 잘리지 않음.
 * JEV·permit·서버 렌더·메일 세이프티·억제·sender_not_creator·증거 게이트는 전부 그대로 후행한다(restrictive-only).
 */
export function liftEmailOnlyHoldForContactChannelRedirectCase(input: {
  readonly seed: string;
  readonly humanGate: HumanGate;
  readonly modelGate: HumanGate;
  readonly modelCaseIsContactChannelRequest: boolean;
  readonly policy: HumanReviewPolicy | undefined;
  readonly caseId: string;
  readonly signalTruncated?: boolean;
  /** The creator-authored text (subject | body) the content checks run on. The seed also embeds runtime identifiers
   *  (conversation/message/tracking ids), which must never trip content predicates. Falls back to the seed. */
  readonly creatorText?: string;
  readonly creatorFields?: CounterOfferCreatorFields;
}): HumanGate {
  const { seed, humanGate, modelGate, modelCaseIsContactChannelRequest, policy, caseId, signalTruncated } = input;
  const creatorText = input.creatorText ?? seed;
  if (
    !signalTruncated &&
    humanGate.decision === "needs_review" &&
    humanGate.ruleIds.length === 1 &&
    humanGate.ruleIds[0] === "email-only-no-call-human-review" &&
    modelGate.decision === "auto_reply" &&
    modelCaseIsContactChannelRequest &&
    policy?.allowEmailOnlyRedirectForContactChannelRequest === true &&
    isCleanMessengerRedirectRequest(creatorText, input.creatorFields)
  ) {
    return {
      decision: "auto_reply",
      reason: `casebook ${caseId}: messenger/channel transfer request only — fixed email-only redirect reply, no call/meeting, amount, agency, or other hold`,
      ruleIds: [...humanGate.ruleIds, "guide-redirect-contact-channel"],
    };
  }
  return humanGate;
}

/** contact_channel_request 자동 회신의 마스터 스위치 — 어떤 경로(로컬 auto_reply 직행/리프트)로 auto_reply 가 되든 토글 OFF 이거나
 *  원문이 깨끗한 메신저 이동 요청이 아니면 사람 검토로 되돌린다(restrictive-only). */
export function enforceContactChannelRedirectCaseSafety(
  humanGate: HumanGate,
  caseId: string | undefined,
  policy: HumanReviewPolicy | undefined,
  seed: string,
  signalTruncated = false,
  evidenceInsufficient = false,
  creatorText: string = seed,
  creatorFields?: CounterOfferCreatorFields,
): HumanGate {
  if (humanGate.decision !== "auto_reply" || caseId !== "contact_channel_request") return humanGate;
  // The evidence threshold is NOT bypassed by this lift (it skipped the base check): below-threshold creator evidence
  // holds unless the existing explicit low-data exemption (allowLowDataAutoReplyForSafeInfo) is on.
  const evidenceOk = !evidenceInsufficient || policy?.allowLowDataAutoReplyForSafeInfo === true;
  if (evidenceOk && policy?.allowEmailOnlyRedirectForContactChannelRequest === true && !signalTruncated && isCleanMessengerRedirectRequest(creatorText, creatorFields)) return humanGate;
  return {
    decision: "needs_review",
    reason: "contact_channel_request reply requires an enabled policy and a clean whole-message messenger transfer request",
    ruleIds: [...humanGate.ruleIds, "contact-channel-case-safety-required"],
  };
}

/**
 * 2026-09-24 (코덱스 적대 리뷰 counter_offer_guideline_reply 9회차) — **case-level 토글 마스터
 * 스위치.** `liftCounterOfferHoldForGuidelineAmountCase` 는 로컬 게이트가 이미
 * budget-amount/budget-or-rate 단독 홀드였을 때만 개입한다 — 그런데 통화 기호 없는 금액
 * ("My fee is 500 a video")은 `hasCurrencyAmount`/`BUDGET_OR_RATE_PATTERN` 어디에도 안 걸려
 * 로컬 게이트가 애초에 홀드 없이 auto_reply(ruleIds `["a1"]`)로 직행할 수 있다(충분한 크리에이터
 * 증거가 있을 때 재현됨) — 이 경로는 위 리프트를 절대 거치지 않으므로
 * `allowGuidelineReplyForCounterOffer` 토글이 전혀 상담되지 않는다.
 *
 * 토글은 "리프트 전용 옵션"이 아니라 이 케이스 전체의 마스터 스위치여야 한다 — 도달 경로(로컬
 * 게이트 직행 / 증거면제 리프트 / 위 리프트 / 향후 추가될 다른 경로)와 무관하게, 모델이
 * `counter_offer_guideline_reply` 를 골랐는데 토글이 꺼져 있으면 무조건 사람 검토로 되돌린다.
 * restrictive-only(강화만) — 이미 needs_review/blocked 인 게이트는 그대로 둔다.
 */
export function enforceCounterOfferGuidelineToggle(
  humanGate: HumanGate,
  caseId: string | undefined,
  policy: HumanReviewPolicy | undefined,
  creatorFields?: CounterOfferCreatorFields,
): HumanGate {
  // 인용 이력이 파서에서 잘려 나간 답장은 이 케이스로 자동 발송하지 않는다 — 로컬 게이트가 리프트를 거치지 않고 auto_reply 로
  //   직행하는 경로(통화 기호 없는 금액)도 막는다. restrictive-only(강화만).
  if (
    humanGate.decision === "auto_reply" &&
    caseId === "counter_offer_guideline_reply" &&
    creatorFields?.quotedHistory !== undefined && creatorFields.quotedHistory !== "clean"
  ) {
    return {
      decision: "needs_review",
      reason: "counter_offer_guideline_reply cannot auto-send when quoted history was stripped before the gate saw it",
      ruleIds: [...humanGate.ruleIds, "counter-offer-quoted-history-stripped"],
    };
  }
  if (
    humanGate.decision === "auto_reply" &&
    caseId === "counter_offer_guideline_reply" &&
    policy?.allowGuidelineReplyForCounterOffer !== true
  ) {
    return {
      decision: "needs_review",
      reason: "counter_offer_guideline_reply requires humanReviewPolicy.allowGuidelineReplyForCounterOffer to be explicitly enabled",
      ruleIds: [...humanGate.ruleIds, "counter-offer-guideline-toggle-required"],
    };
  }
  return humanGate;
}

/**
 * 2026-09-24 (코덱스 적대 리뷰 counter_offer_guideline_reply 10회차) — **case-level JEV 마스터
 * 요구.** `counterOfferGuidelineJevRequiredHoldReasonFor`(chat-ai.ts)는 모델 콜 이전에 미리
 * 계산되므로 그 시점엔 아직 모델이 무슨 caseId 를 고를지 모른다 — 그래서 `routingGate.ruleIds`
 * 가 budget-amount/budget-or-rate 단독 홀드일 때만 "JEV 필수" 사유를 만든다. 그런데
 * `enforceCounterOfferGuidelineToggle`(9회차)이 고친 것과 같은 이유로, 통화 기호 없는 금액이
 * 로컬 게이트를 auto_reply(`["a1"]`)로 직행시키면 그 사유 계산 자체가 `null`이 되고, 비-canonical-
 * SCP 메일함(jevRequired=false)에서는 jevSendDecisionFor 가 애초에 호출되지 않아 jevDecision 도
 * 항상 null 이다 — `combineJevWithHumanGate(gate, null, {requiredHoldReason: null})` 는
 * "JEV 레인 미상담 = no-op"이라 auto_reply 가 JEV 없이 그대로 나간다.
 *
 * 이 함수는 모델 caseId 를 알 수 있는 시점(late-stage, combineJevWithHumanGate 이후)에 한 번 더
 * 독립적으로 요구한다 — 최종 humanGate 가 auto_reply 이고 caseId 가 counter_offer_guideline_reply
 * 인데 `jevConsulted`(jevDecision 이 실제로 non-null 이었는지)가 false 면 무조건 사람 검토로
 * 되돌린다. jevDecision 이 있고 outcome 이 "send"가 아니면 combineJevWithHumanGate 가 이미
 * needs_review 로 내렸을 것이므로, 이 시점에 여전히 auto_reply 라면 jevDecision 이 없었거나(버그
 * 케이스) 실제로 "send" 승인을 받은 경우뿐이다 — 후자는 통과시킨다.
 */
export function enforceCounterOfferGuidelineJevRequired(
  humanGate: HumanGate,
  caseId: string | undefined,
  jevConsulted: boolean,
): HumanGate {
  if (
    humanGate.decision === "auto_reply" &&
    caseId === "counter_offer_guideline_reply" &&
    !jevConsulted
  ) {
    return {
      decision: "needs_review",
      reason: "counter_offer_guideline_reply requires an actual JEV consultation before it can auto-send",
      ruleIds: [...humanGate.ruleIds, "counter-offer-guideline-jev-required"],
    };
  }
  return humanGate;
}

/**
 * auto-reply-org-controls (2026-09-24, 헤세 요구): T049(AI Drama) 등 `settings/default.automation.
 * autoReplyDisabledOrgIds`에 등록된 조직은 어떤 자동 경로(케이스북 auto_ok, interest_next_steps
 * 즉시발송 허용목록, 가격 가이드 리다이렉트, 역제안 가이드라인 고정회신, 백로그 requeue)로도
 * 자동 발송돼선 안 된다 — 대화는 여전히 정상적으로 사람 검토로 넘어간다(이 함수는 발송만 막는다).
 *
 * org 판정 정책(fail-closed, 문서화된 선택):
 *  ①orgId 가 있으면(PLAN-ORG-MAIL-IDENTITY Slice 4 sticky-stamp) 그 값을 목록과 직접 비교한다.
 *  ②orgId 가 없는(=대다수 scp 공유 사서함 대화 — scp 는 "대화가 소유한 조직"이 정의되지 않는
 *    공유 메일함이라 orgId 가 아예 안 찍힌다, chat-ai.ts resolveOwnerOrgIdForOutbound 문서 참고)
 *    대화는 **무조건 fail-closed 로 처리하지 않는다** — mailAccountId 가 canonical 공유 scp
 *    사서함이거나(scp) 아직 어떤 계정에도 배정되지 않았으면(빈 값) T049 전용 채널일 수 없으므로
 *    "T049 아님"으로 안전하게 취급해 기존 발송 파이프라인을 그대로 통과시킨다.
 *  ③그 외(orgId 는 없는데 mailAccountId 가 scp 가 아닌 특정 조직 전용 사서함인 애매한 경우)는
 *    hold — 자동 발송을 막고 사람 검토로 넘긴다. 조직을 확실히 모르는 상태에서 "T049 아님"을
 *    함부로 가정하지 않는다(fail-closed 는 이 경우에만 적용).
 */
export function isAutoReplyOrgExcluded(input: {
  readonly orgId: unknown;
  readonly mailAccountId: unknown;
  readonly disabledOrgIds: readonly string[];
}): boolean {
  const disabledOrgIds = input.disabledOrgIds;
  if (!disabledOrgIds || disabledOrgIds.length === 0) return false;
  const orgId = typeof input.orgId === "string" ? input.orgId.trim() : "";
  if (orgId) return disabledOrgIds.includes(orgId);
  const mailAccountId = typeof input.mailAccountId === "string" ? input.mailAccountId.trim() : "";
  if (mailAccountId === "" || mailAccountId === "scp") return false;
  return true;
}

/**
 * Codex 적대 리뷰(2026-09-24, 1회차) BLOCKER 1 수리: isAutoReplyOrgExcluded 하나만으로는
 * 메일함이 여러 조직에 공유돼 있는 경우를 못 잡는다 — mailImapIngest.ts의
 * resolveOrgIdForAccount는 settings/mail_routing.byOrgId에서 같은 accountId로 매핑된
 * **첫 번째** orgId만 그 계정 전체의 conversation.orgId로 스탬프한다(계정당 1회만 해석).
 * T049와 다른 조직이 **둘 다** 같은 계정(전형적으로 공유 scp)에 매핑돼 있으면, 그 계정으로
 * 들어온 T049 발신 회신이 다른 조직 orgId로 스탬프될 수 있어 isAutoReplyOrgExcluded 가
 * orgId만 보고 "T049 아님"으로 오판할 수 있다 — resolveOrgIdForAccount 자체를 바꾸지 않고
 * (계정당-1회 스탬프는 이 기능 범위 밖의 기존 아키텍처), disabledOrgIds 중 하나라도 이
 * mailAccountId에 **같이** 매핑돼 있으면(byOrgId를 통해) 그 계정으로 들어온 회신은 어느
 * 조직 것인지 확정할 수 없으므로 orgId 값과 무관하게 hold 한다 — 이 함수가 true를 반환하면
 * isAutoReplyOrgExcluded의 결과와 OR로 합쳐 호출부가 무조건 제외 처리해야 한다.
 * byOrgId는 mailAccounts.ts readMailRoutingCached()(5분 TTL)의 결과를 그대로 넘기면 된다.
 */
export function disabledOrgSharesMailAccount(
  disabledOrgIds: readonly string[],
  mailAccountId: unknown,
  byOrgId: Readonly<Record<string, unknown>>,
): boolean {
  const accountId = typeof mailAccountId === "string" ? mailAccountId.trim() : "";
  if (!accountId || !disabledOrgIds || disabledOrgIds.length === 0) return false;
  return disabledOrgIds.some((orgId) => byOrgId[orgId] === accountId);
}

export type InboundIntentId =
  | "guide_interest"
  | "apply_how"
  | "submit_how"
  | "sample_request"
  | "partner_accept"
  | "price_inquiry"
  | "other_human";

type InboundIntentRule = {
  readonly id: InboundIntentId;
  readonly pattern: RegExp;
  /** Task-46 적대 리뷰 HIGH-1: 트리거 구절 바로 앞(NEGATION_WINDOW_TOKENS 토큰 내)에 부정어가
   *  있으면 이 규칙의 매치를 건너뛴다("I'm not ready to start creating content" 같은 부정문이
   *  partner_accept로 새는 것을 막는다). */
  readonly negationGuard?: boolean;
  /** Task-46 적대 리뷰 HIGH-1: resolveInboundIntent 호출부가 `isPersonalMailAccount: false`(scp/
   *  canonical 계정 대화로 서버가 확인)를 명시적으로 넘긴 경우에만 이 규칙을 건너뛴다.
   *  호출부가 계정 컨텍스트를 안 넘기면(옵션 생략 — 순수 텍스트 분류 테스트 등) undefined이므로
   *  기존처럼 규칙을 그대로 적용한다(회귀 0). */
  readonly personalMailAccountOnly?: boolean;
};

const NEGATION_WINDOW_TOKENS = 6;
// 영문 부정어는 단어 경계로, 한글 부정어("아직"/"안"/"못")는 공백·구두점으로 감싸인 독립
// 토큰일 때만 매치한다(\b는 비-ASCII 문자 앞뒤에서 거의 항상 성립하지 않아 "안녕"의 "안"처럼
// 단어 중간을 오탐하는 걸 막는다).
const PARTNER_ACCEPT_NEGATION_PATTERN =
  /\b(?:not|no|isn'?t|don'?t|can'?t)\b|(?:^|[\s,.!?])(?:아직|안|못)(?=[\s,.!?]|$)/i;

function hasPrecedingNegation(lowerSeed: string, matchIndex: number): boolean {
  const before = lowerSeed.slice(0, matchIndex);
  const tokens = before.split(/\s+/).filter(Boolean);
  const window = tokens.slice(-NEGATION_WINDOW_TOKENS).join(" ");
  return PARTNER_ACCEPT_NEGATION_PATTERN.test(window);
}

// Task-46 적대 리뷰 HIGH-1/2 (2026-09-11): price_inquiry/partner_accept를 기존 4개 규칙보다
// **먼저** 평가한다(배열 순서 = 매치 우선순위, resolveInboundIntent가 순서대로 탐색). 둘 다
// 매치되면 price_inquiry가 이긴다(배열에서 더 앞) — "excited to partner but what's your day
// rate" 같은 복합 메일은 조건이 아직 안 정해졌으므로 사람이 확인하기 전까지 전환 버튼이 뜨면
// 안 된다(협의 중으로 분류). "수락 구절 + 가이드/신청/제출/샘플 질문" 복합 메일이 기존 4개 규칙
// 대신 partner_accept로 분류가 바뀌는 건 의도된 변화다(PR 본문 참조) — 단 price_inquiry·
// partner_accept 둘 다 personalMailAccountOnly라(2회차 적대 리뷰 수리) scp/canonical 계정
// 대화로 확인되면 이 우선순위 변경 자체가 적용되지 않는다 — 그 대화의 intent는 기존 4개
// 규칙만으로 계산한 결과와 바이트 동일하다(Growth 회귀 0).
const INBOUND_INTENT_RULES: ReadonlyArray<InboundIntentRule> = [
  // 조건 문의(단가·일정) — 협의 중으로만 분류하고 절대 자동 전환하지 않는다(사람 확정 전용).
  // personalMailAccountOnly: scp/canonical 계정 대화에서는 이 규칙을 건너뛰어(기존 4개 규칙
  // 우선순위로 복귀) Growth 회귀 0을 보장한다 — partner_accept와 동일한 가드.
  {
    id: "price_inquiry",
    pattern:
      /\b(day\s+rate|your\s+rate|the\s+rate|budget|price|pricing|quote|how\s+much\s+(is|would|does)|payment\s+terms?|compensation)\b|단가\s*문의|비용\s*문의|가격\s*문의|견적/i,
    personalMailAccountOnly: true,
  },
  // "명시적 수락 문구"만 partner_accept로 잡는다(단순 "sounds good" 같은 느슨한 긍정은
  // other_human 그대로 — 사람 확정 없이 전환 버튼만 활성화될 뿐, 자동 전환은 없다).
  {
    id: "partner_accept",
    pattern:
      /\b(i\s+accept|i'?m\s+in|count\s+me\s+in|i'?d\s+love\s+to\s+join|happy\s+to\s+collaborate|excited\s+to\s+partner|ready\s+to\s+(start|get\s+started)|let'?s\s+get\s+started|start\s+creating\s+content)\b|수락하겠습니다|참여하겠습니다|함께\s*하겠습니다|진행하겠습니다/i,
    negationGuard: true,
    personalMailAccountOnly: true,
  },
  // 기존 4개 규칙 — 순서·패턴 보존(회귀 0, tests/inbound-intent-classification.test.mjs 5개 픽스처).
  { id: "sample_request", pattern: /\b(sample|example)s?\s+(videos?|clips?|content)\b|샘플\s*영상|예시\s*영상/i },
  { id: "submit_how", pattern: /\bhow\s+(do|can|should)\s+i\s+submit\b|\bsubmit\s+(my\s+)?(video|content|clip)\b|영상\s*제출|제출\s*방법/i },
  { id: "apply_how", pattern: /\bhow\s+(do|can|should)\s+i\s+(apply|join|sign\s*up)\b|\bapply\s+for\s+(this|the)\s+program\b|신청\s*방법|어떻게\s*신청/i },
  { id: "guide_interest", pattern: /\b(creator|program)\s+guide\b|\bmore\s+(info|information|details)\s+about\s+(the\s+)?program\b|프로그램\s*가이드/i },
];

export type ResolveInboundIntentOptions = {
  /** Task-46 적대 리뷰 HIGH-1: scp/canonical 계정 대화로 서버가 확인했으면 `false`를 넘겨
   *  personalMailAccountOnly 규칙(partner_accept)을 건너뛰게 한다. 생략(undefined)하면 기존처럼
   *  전부 적용한다(계정 컨텍스트가 없는 순수 텍스트 분류 호출 대상, 회귀 0). */
  isPersonalMailAccount?: boolean;
};

// W31 F-1: 규칙 선행(비용·일관성) — 매칭되면 모델과 무관히 확정. 미매칭·무효 모델값·필드 부재는
// other_human(사람) 고정 — 배포 직후 intent 없는 옛 캐시도 이 경로로 안전 폴백(캐시 키는 불변).
export function resolveInboundIntent(
  seed: string,
  modelIntent: unknown,
  options: ResolveInboundIntentOptions = {},
): { id: InboundIntentId; source: "rule" | "model" } {
  const lowerSeed = seed.toLowerCase();
  for (const rule of INBOUND_INTENT_RULES) {
    if (rule.personalMailAccountOnly && options.isPersonalMailAccount === false) continue;
    const match = rule.pattern.exec(lowerSeed);
    if (!match) continue;
    if (rule.negationGuard && hasPrecedingNegation(lowerSeed, match.index)) continue;
    return { id: rule.id, source: "rule" };
  }
  // 3회차 적대 리뷰 P2: 모델 폴백(source: "model")도 규칙 매치와 같은 가드를 받는다 — 모델이
  // 텍스트를 잘못 읽고 partner_accept/price_inquiry를 내도, scp/canonical 계정 대화면(가드 1)
  // 또는 트리거 직전에 부정어가 있으면(가드 2) 사람 확정 없이 전환 버튼이 뜨는 경로로 새면 안
  // 된다. negationGuard는 rule.pattern이 seed에서 실제로 매치할 때만 판단 가능하므로, 매치가
  // 없으면(모델과 정규식이 다른 근거로 같은 id를 골랐을 때) 판단을 보류하고 기존처럼 통과시킨다.
  let modelRule = INBOUND_INTENT_RULES.find((r) => r.id === modelIntent);
  if (modelRule?.personalMailAccountOnly && options.isPersonalMailAccount === false) {
    modelRule = undefined;
  } else if (modelRule?.negationGuard) {
    const match = modelRule.pattern.exec(lowerSeed);
    if (match && hasPrecedingNegation(lowerSeed, match.index)) modelRule = undefined;
  }
  return modelRule ? { id: modelRule.id, source: "model" } : { id: "other_human", source: "rule" };
}

export function sanitizedSummary(seed: string): string {
  const text = seed.toLowerCase();
  if (isHardOptOut(text)) return "수신 거부/법적 리스크 — 자동 발송 중단";
  if (isSoftDecline(text)) return "관심 낮음 — 사람 검토 필요";
  if (isClosingAcknowledgment(text)) return "종결 인사 — 자동 회신 없이 대화 종료";
  if (text.includes("user id") || text.includes("quick start guide") || text.includes("ingame") || text.includes("in-game")) {
    return "참여 수락 — 인게임 ID 전달 및 가이드 확인 예정";
  }
  if (text.includes("excited to partner") || text.includes("start creating content")) {
    return "협업 수락 — 콘텐츠 제작 준비";
  }
  if (text.includes("brief") || text.includes("details") || text.includes("next step") || text.includes("three shorts") || text.includes("one long video") || text.includes("build crash") || text.includes("game build")) {
    return "관심 있음 — 브리프·콘텐츠 형식·다음 단계 요청";
  }
  if (text.includes("10500") || text.includes("10,500")) return "5인 패키지 총 $10,500 요청 — 사람 검수 필요";
  if (text.includes("1500")) return "€1,500 요청 — 가이드 상한 근접";
  if (text.includes("2300") || text.includes("2,300")) return "$2,300 조건 — 사람 검수 필요";
  if (text.includes("budget") || text.includes("rate") || text.includes("money")) return "관심 있음 — 보상 안내와 브리프 요청";
  return "수신 메일 요약 완료 — 원문은 서버 참조로만 보관";
}

// 2026-10-02 (0.6.109): JEV 전용 요약. sanitizedSummary 는 단가/금액 역제안을 "관심 있음 — 보상 안내와
//   브리프 요청" 같은 일반 문구로 뭉개서 JEV 가 역제안 여부를 못 보고 적합도(noul)를 0.9 아래로 줬다.
//   원문이 실제로 역제안 신호(isCounterOfferSignal)이고 제외 카테고리(계약·법무·통화·일정·에이전시·
//   정산분쟁·지급구조 등)·하드옵트아웃·소프트거절·종결인사가 아닐 때만 고정 문구를 돌려준다. 금액·원문·PII 없음.
//   모델 caseId 로 고르지 않는다 — 인바운드 원문에서만 결정론적으로 도출(JEV 는 독립 검증 유지).
//   그 외 입력은 sanitizedSummary 와 동일. triage 표시(summaryKr)·draftForGate 는 이 함수를 쓰지 않는다.
// 0.6.109 (코덱스 재리뷰 결정 — 블랙리스트 확장 중단, 최대 엄격 fail-closed): 역제안 요약·리프트의 허용목록 게이트.
//   정규화(NFKC + 제로폭/서식 문자 제거 + 공백 접기)를 한 번 수행하고, 그 정규화 텍스트와 원문 양쪽에
//   모든 기존 제외 검사(reviewGateExcludingCounterOfferSignal/소프트 거절)를 돌린다(어느 쪽이든 걸리면 탈락).
//   모든 절은 (a) 고정 인사 (b) 고정 감사·맺음말 (c) 엄격한 전체 일치(full-match) 단가 템플릿 중 하나여야 한다.
//   서명 이름·인사 뒤 이름·자유 어휘는 허용하지 않는다. 하나라도 어긋나거나 상한(600자/6문장/12절)을 넘으면 false —
//   요약은 sanitizedSummary 로, 리프트는 사람 검토로 남는다. 의도적으로 보수적이다.
const PURE_COUNTER_MAX_CHARS = 600;
const PURE_COUNTER_MAX_SENTENCES = 6;
const PURE_COUNTER_MAX_CLAUSES = 12;
const PURE_COUNTER_GREETING = /^(?:hi|hello|hey|hi there|hello there|dear team|good (?:morning|afternoon|evening)|안녕하세요|안녕하십니까)$/;
const PURE_COUNTER_PLEASANTRY =
  /^(?:thanks|thank you|thanks a lot|thank you so much|thanks for reaching out|thank you for reaching out|thanks for your (?:email|message|offer|reply|time)|thank you for your (?:email|message|offer|reply|time)|thanks for the (?:offer|invitation|opportunity)|thank you for the (?:offer|invitation|opportunity)|best|best regards|kind regards|warm regards|regards|cheers|sincerely|감사합니다|고맙습니다|감사드립니다|잘 부탁드립니다)$/;
// 금액 문법: 통화 기호/코드 + 숫자(천단위 구분·소수·k) — 통화 없는 맨숫자는 허용하지 않는다.
const PC_NUM = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?";
const PC_AMT = `(?:(?:[$€£₩]|usd\\s?|eur\\s?|krw\\s?)(?:${PC_NUM})k?|(?:${PC_NUM})k?\\s?(?:usd|eur|krw|dollars?|euros?|won|원))`;
const PC_PER = "(?:\\s+per\\s+(?:video|clip|(?:1,?000|1k|thousand)\\s+views|view)|\\s+cpm)?";
const PURE_COUNTER_EN_TEMPLATES: readonly RegExp[] = [
  `(?:my|our)\\s+(?:(?:usual|current|standard|normal)\\s+)?(?:rate|fee)\\s+is\\s+${PC_AMT}${PC_PER}`,
  `i\\s+(?:(?:usually|normally|typically)\\s+)?charge\\s+${PC_AMT}${PC_PER}`,
  `i\\s+(?:(?:usually|normally|typically)\\s+)?charge\\s+more\\s+than\\s+(?:this|that|the\\s+standard)`,
  `(?:can|could|would)\\s+you\\s+(?:please\\s+)?(?:raise|increase)\\s+(?:the|my|your)\\s+(?:rate|fee|cpm)(?:\\s+a\\s+(?:bit|little)|\\s+to\\s+${PC_AMT}${PC_PER})?`,
  `(?:can|could|would)\\s+you\\s+(?:please\\s+)?(?:do|offer|match)\\s+${PC_AMT}${PC_PER}`,
  `(?:can|could|would)\\s+you\\s+(?:please\\s+)?match\\s+(?:that|it|this)`,
  `(?:can|could|would)\\s+you\\s+go\\s+higher`,
  `(?:can|could)\\s+you\\s+offer\\s+a\\s+higher\\s+(?:cpm\\s+)?(?:rate|fee)(?:\\s+for\\s+(?:view\\s+reward|creator\\s+code))?(?:\\s+than\\s+the\\s+standard(?:\\s+(?:one|rate))?)?`,
  `would\\s+you\\s+be\\s+able\\s+to\\s+offer\\s+a\\s+higher\\s+(?:cpm\\s+)?(?:rate|fee)(?:\\s+for\\s+(?:view\\s+reward|creator\\s+code))?(?:\\s+than\\s+the\\s+standard(?:\\s+(?:one|rate))?)?`,
  `is\\s+${PC_AMT}${PC_PER}\\s+possible`,
  `i(?:'d|\\s+would)\\s+like\\s+${PC_AMT}${PC_PER}`,
  `i\\s+raised\\s+my\\s+rate(?:\\s+and\\s+would\\s+like\\s+you\\s+to\\s+match\\s+(?:it|that))?`,
].map((t) => new RegExp(`^${t}$`));
const PURE_COUNTER_KO_CLAUSES: readonly RegExp[] = [
  /^(?:저는\s*)?(?:제\s*)?(?:단가|요율|금액|페이)(?:는|가|은)?\s*(?:보통은?|평소|대략|항상)?\s*(?:영상\s*당|건당|조회수당|천\s*회당)?\s*(?:약\s*)?[\d.,]+\s*(?:만\s*원|천\s*원|원|달러|usd|krw|\$)?\s*(?:정도)?\s*(?:입니다|이에요|예요|인데요?|이고|입니다만)?$/,
  /^(?:단가|요율|금액)?\s*(?:를\s*)?(?:조금\s*|좀\s*)?(?:더\s*)?(?:높게|올려|인상|협상|조정)\s*(?:해\s*)?(?:주실\s*수\s*있나요|주실\s*수\s*있을까요|가능할까요|가능한가요|가능한지요|이\s*가능할까요|이\s*가능한가요|주세요)?$/,
  /^(?:저는\s*)?(?:조회수당\s*|영상\s*당\s*)?더\s*받고\s*싶(?:어요|습니다|은데요?)$/,
  /^(?:그\s*금액에\s*|그에\s*|제\s*단가에\s*)?맞춰\s*주실\s*수\s*있(?:나요|을까요|으신가요)$/,
];

// 정규화 1회: NFKC(전각→반각 포함) + 제로폭/서식/방향 제어 문자 제거 + 공백(개행 제외) 접기.
function normalizeCounterOfferText(seed: string): string {
  return seed
    .normalize("NFKC")
    .replace(/[\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "")
    .replace(/[^\S\n]+/g, " ");
}

export function isPureCounterOfferText(seed: string): boolean {
  const normalized = normalizeCounterOfferText(seed);
  // 정규화 텍스트와 원문 양쪽에 기존 제외 검사를 돌린다 — 어느 쪽이든 걸리면 탈락.
  for (const candidate of [normalized, seed]) {
    if (
      reviewGateExcludingCounterOfferSignal(candidate) !== null ||
      reviewGateExcludingCounterOfferSignal(candidate, { stripQuotes: false }) !== null ||
      isSoftDecline(candidate)
    ) {
      return false;
    }
  }
  // 인용 이력은 제거하지 않는다 — ">" 줄·"On … wrote:"·"From:/Sent:" 헤더 등 모든 줄이 허용목록을 통과해야 하며,
  //   인용 표식/인용 내용은 어느 템플릿에도 맞지 않아 fail-closed 된다(인용 이력이 붙은 실제 답장은 설계상 사람 검토).
  const text = normalized.trim().toLowerCase();
  // 마크업/제어 구두점(~ * _ ` # | < > [ ] { } \ ^ = 등: 취소선·강조·HTML 등으로 의도를 가릴 수 있다)이 하나라도 있으면
  //   전체 탈락 — 문자·숫자·공백·통화 기호·. , ! ? ; : ' " - — – / % ( ) 만 허용한다. 경계에서 다듬지(trim) 않는다.
  if (!/^[\p{L}\p{N}\s$€£₩.,!?;:'"\-—–/%()。！？]*$/u.test(text)) return false;
  if (!text || text.length > PURE_COUNTER_MAX_CHARS) return false;
  const sentences = text.split(/[.!?;。！？\n]+/).map((x) => x.trim()).filter(Boolean);
  if (sentences.length === 0 || sentences.length > PURE_COUNTER_MAX_SENTENCES) return false;
  let clauseCount = 0;
  for (const sentence of sentences) {
    const clauses = sentence
      .replace(/(인데요?|이고|이며|지만)\s*,?\s*/g, "$1|")
      .split(/,\s+|,$|\|/)
      .map((x) => x.trim())
      .filter(Boolean);
    for (const raw of clauses) {
      const clause = raw.replace(/^[-—–\s]+|[-—–\s]+$/g, "");
      if (!clause) continue;
      clauseCount += 1;
      if (clauseCount > PURE_COUNTER_MAX_CLAUSES) return false;
      if (
        PURE_COUNTER_GREETING.test(clause) ||
        PURE_COUNTER_PLEASANTRY.test(clause) ||
        PURE_COUNTER_KO_CLAUSES.some((re) => re.test(clause)) ||
        PURE_COUNTER_EN_TEMPLATES.some((re) => re.test(clause))
      ) {
        continue;
      }
      return false;
    }
  }
  return true;
}

// 0.6.110: 런타임 seed 는 `conversationId:messageRef:trackingId:intent:signal:operatorInstruction` (+ 수신 경로에서는
//   signal 이 `제목 | 본문 | 본문`) 이라 시스템 ID·`|` 구분자가 섞여 허용목록을 절대 통과하지 못했다(0.6.109 라이브 실측).
//   크리에이터 작성 필드(제목/본문)를 따로 받아 각각 엄격 검증한다 — 필드를 조용히 버리지 않는다.
//   본문: isPureCounterOfferText 그대로(인용 규칙 불변). 제목: 비어 있거나, 답장/전달 접두어(Re:/Fwd:/답장:)를 뗀 나머지가
//   (a) 비었거나 (b) 이 스레드 원 발신 제목과 정규화 일치(신뢰 컨텍스트)이거나 (c) 같은 엄격 허용목록을 통과해야 한다. 그 외 → fail-closed.
export interface CounterOfferCreatorFields {
  readonly subject?: string;
  readonly body: string;
  readonly originalSubject?: string;
  /** 서버(IMAP 파서) 소유 표식: 본문에서 인용 이력이 이미 제거됐다 — 인용을 볼 수 없으므로 fail-closed(사람 검토). */
  readonly quotedHistory?: "clean" | "stripped" | "unknown";
}
const COUNTER_SUBJECT_PREFIX = /^(?:\s*(?:re|fwd?|fw|답장|회신|전달)\s*:)+/i;
function normalizeSubjectForCompare(subject: string): string {
  return normalizeCounterOfferText(subject).replace(COUNTER_SUBJECT_PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}
export function isPureCounterOfferFields(fields: CounterOfferCreatorFields): boolean {
  // 인용 이력이 파서에서 잘려 나간 답장은 잘린 뒤 본문만으로는 안전을 증명할 수 없다(`$500.\n> …\nstop emailing me` → `$500.`).
  if (fields.quotedHistory !== undefined && fields.quotedHistory !== "clean") return false;
  if (!isPureCounterOfferText(fields.body)) return false;
  const subject = fields.subject ?? "";
  if (!subject.trim()) return true;
  const rest = normalizeSubjectForCompare(subject);
  if (!rest) return true;
  const original = normalizeSubjectForCompare(fields.originalSubject ?? "");
  if (original && rest === original) return true;
  return isPureCounterOfferText(normalizeCounterOfferText(subject).replace(COUNTER_SUBJECT_PREFIX, ""));
}
function isPureCounterOfferInput(seed: string, fields: CounterOfferCreatorFields | undefined): boolean {
  if (!fields) return isPureCounterOfferText(seed);
  // 상속된 제목(원 발신 제목 일치)이 역제안 양성 신호를 공급하면 안 된다 — 현재 본문 자체가 명시적 역제안이어야 한다.
  const body = normalizeCounterOfferText(fields.body);
  if (!isCounterOfferSignal(body) || !COUNTER_OFFER_EXPLICIT_ASK_PATTERN.test(body.toLowerCase())) return false;
  return isPureCounterOfferFields(fields);
}

// 수락·단순 금액 언급만으로는 역제안이 아니다 — 명시적 인상/협상/본인 단가 진술이 있어야 요약이 바뀐다.
const COUNTER_OFFER_EXPLICIT_ASK_PATTERN =
  /\b(?:rais(?:e[sd]?|ing)|higher|increas(?:e[sd]?|ing)|more\s+than|my\s+(?:rate|fee|price)\s+is|i\s+(?:usually\s+)?(?:charge|get|earn)|can\s+you\s+(?:do|match|go|offer)|could\s+you\s+(?:do|match|go|offer)|would\s+you\s+be\s+able\s+to\s+offer|counter(?:\s*offer)?|negotiat(?:e[sd]?|ing|ions?))\b|인상|올려|더\s*높|더\s*받|역제안|제\s*단가는|협상/i;
export const COUNTER_OFFER_JEV_SUMMARY = "단가 인상·역제안 요청 — 공개 보상 구조 안의 금액 조정 요청";
export function jevInboundSummary(seed: string, creatorFields?: CounterOfferCreatorFields): string {
  const text = seed.toLowerCase();
  if (
    !isHardOptOut(text) &&
    !isSoftDecline(text) &&
    !isClosingAcknowledgment(text) &&
    isCounterOfferSignal(seed) &&
    COUNTER_OFFER_EXPLICIT_ASK_PATTERN.test(text) &&
    isPureCounterOfferInput(seed, creatorFields) &&
    reviewGateExcludingCounterOfferSignal(seed) === null
  ) {
    return COUNTER_OFFER_JEV_SUMMARY;
  }
  return sanitizedSummary(seed);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatKRW(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function rangeLabel(min: number, max: number, suffix: string): string {
  return `${formatKRW(min)}-${formatKRW(max)}${suffix}`;
}

function bandMatches(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

function pricingBandForContext(context: HumanGateContext): NegotiationPricingBand | undefined {
  const policy = context.negotiationPricing;
  const bands = Array.isArray(policy?.bands) ? policy.bands : [];
  const followers = positiveNumber(context.creatorFollowers);
  const recentViews = positiveNumber(context.creatorRecentViews);
  return bands.find((band) =>
    bandMatches(followers, band.minFollowers, band.maxFollowers)
    && bandMatches(recentViews, band.minRecentViews, band.maxRecentViews),
  ) ?? bands.find((band) => bandMatches(followers, band.minFollowers, band.maxFollowers))
    ?? bands.find((band) => bandMatches(recentViews, band.minRecentViews, band.maxRecentViews));
}

export function priceNegotiationFromContext(context: HumanGateContext = {}): PriceNegotiation | null {
  const band = pricingBandForContext(context);
  if (!band) return null;
  const followers = positiveNumber(context.creatorFollowers);
  const recentViews = positiveNumber(context.creatorRecentViews);
  const policy = context.negotiationPricing ?? {};
  const startingRatio = positiveNumber(policy.startingOfferRatioPct) || 60;
  const targetRatio = positiveNumber(policy.targetOfferRatioPct) || 80;
  const maxAutoRatio = positiveNumber(policy.maxAutoOfferRatioPct) || 90;
  const humanReviewAboveRatio = positiveNumber(policy.humanReviewAboveRatioPct) || 95;
  const cpmEstimate = recentViews > 0 ? (recentViews / 1000) * band.targetCPMKRW : band.minKRW;
  const estimatedGuideKRW = Math.round(clampNumber(cpmEstimate, band.minKRW, band.maxKRW));
  const startingOfferKRW = Math.round(clampNumber(estimatedGuideKRW * startingRatio / 100, band.minKRW, band.maxKRW));
  const targetOfferKRW = Math.round(clampNumber(estimatedGuideKRW * targetRatio / 100, band.minKRW, band.maxKRW));
  const maxAutoOfferKRW = Math.round(clampNumber(estimatedGuideKRW * maxAutoRatio / 100, band.minKRW, band.maxKRW));
  const needsHumanReview = estimatedGuideKRW >= Math.round(band.maxKRW * humanReviewAboveRatio / 100)
    || (context.humanReviewPolicy?.requireFollowersForPricing === true && followers <= 0)
    || (context.humanReviewPolicy?.requireRecentViewsForPricing === true && recentViews <= 0);
  return {
    bandId: band.id,
    bandLabel: band.label,
    currency: policy.currency ?? "KRW",
    followerRange: rangeLabel(band.minFollowers, band.maxFollowers, " followers"),
    recentViewRange: rangeLabel(band.minRecentViews, band.maxRecentViews, " recent views"),
    estimatedGuideKRW,
    startingOfferKRW,
    targetOfferKRW,
    maxAutoOfferKRW,
    needsHumanReview,
  };
}

// 자동 회신 가능한(=auto_reply) 경우에만 프로그램 템플릿을 렌더한다. 템플릿이 없으면 null → 기존 기본 카피 폴백.
//  - 톤(정중/간결/행사초대형)으로 인사·맺음말을 결정하고, contentTags 순서대로 본문 라인을 만든다.
//  - 이메일 전용: 통화/미팅/캘린더 문구를 만들지 않는다. id/추적값은 본문에 절대 넣지 않는다(SEC-P0-009).
function renderTemplatedDraft(template: MailTemplateRender): string | null {
  const tags = Array.isArray(template.contentTags) ? template.contentTags.map((tag) => tag.trim()).filter(Boolean) : [];
  if (tags.length === 0) return null;
  const tone = (template.tone || "정중").trim();
  const title = (template.programTitle || "").trim();

  const greeting = tone === "행사초대형"
    ? "안녕하세요, 함께할 프로그램에 초대드립니다."
    : tone === "간결"
      ? "안녕하세요, 문의 주셔서 감사합니다."
      : "안녕하세요, 관심 가져 주셔서 감사합니다.";
  const closing = tone === "행사초대형"
    ? "함께하실 수 있기를 기대하겠습니다.\n\nSupercent Team 드림"
    : tone === "간결"
      ? "회신 기다리겠습니다.\n\nSupercent Team"
      : "검토 후 회신 주시면 감사하겠습니다.\n\nSupercent Team 드림";

  const lineForTag = (tag: string): string => {
    if (tag.includes("프로그램")) return `- 프로그램: ${title || "현재 진행 중인 Supercent 프로그램"}`;
    if (tag.includes("혜택")) return "- 참여 혜택: 협업 보상과 콘텐츠 제작 지원을 이메일로 안내드립니다.";
    if (tag.includes("일정")) return "- 일정: 콘텐츠 게시 일정과 마감은 이메일로 함께 조율합니다.";
    if (tag.includes("다음") || tag.includes("액션")) return "- 다음 액션: 선호 콘텐츠 형식과 가능한 조건을 이메일로 회신해 주세요.";
    // 커스텀 태그는 그대로 라벨로 노출(원문/조건은 이메일에서 확정).
    return `- ${tag}: 자세한 내용은 이메일로 안내드립니다.`;
  };

  const body = tags.map(lineForTag);
  return [greeting, "", ...body, "", closing].join("\n");
}

// W31 F-2: intent 골격 > 프로그램 템플릿 > 모델 초안. 링크는 완성된 마크다운으로 굽는다(placeholder 금지).
// links 는 호출부(chat-ai.ts)가 functions/mailReplyLinks.ts 상수를 넘긴다 — 이 파일은 외부 import
// 없이(raw .ts 로 직접 임포트하는 기존 테스트들의 확장자 없는 상대경로 해석 제약을 건드리지 않도록) 유지한다.
export type IntentDraftLinks = { guide: string; apply: string; submit: string; sample: string };

function renderIntentDraft(intent: InboundIntentId, links: IntentDraftLinks): string | null {
  switch (intent) {
    case "guide_interest":
      return `Thanks for your interest in the Supercent Creator Program! Here is the [Creator Guide](${links.guide}) — after reviewing it, you can [Apply here](${links.apply}) to join.\n\nBest,\nSupercent Team`;
    case "apply_how":
      return `You can [Apply here](${links.apply}) — please check the program guide first to confirm you meet the requirements.\n\nBest,\nSupercent Team`;
    case "submit_how":
      return `You can [Submit your video](${links.submit}) once it's ready — please follow the content format in the program guide.\n\nBest,\nSupercent Team`;
    case "sample_request":
      return `Here are some [Sample videos](${links.sample}) from past creators for reference.\n\nBest,\nSupercent Team`;
    default:
      return null;
  }
}

// W98: needs_review 로컬 폴백 카피 — 모델이 초안을 못/안 낸 경우의 마지막 목소리도
//   담당자 실측 톤(TONE-CORPUS-HUMAN)을 따른다. 한국어 요지는 UI 안내용 고정 상수.
export const NEEDS_REVIEW_FALLBACK_DRAFT =
  "Hi:)\n\nThank you for your message! Our team is reviewing it and will get back to you shortly.\n\nBest regards,\nSupercent";
export const NEEDS_REVIEW_FALLBACK_DRAFT_KR =
  "메시지를 잘 받았고, 팀이 확인한 뒤 곧 회신드리겠다는 기본 안내입니다.";

export function draftForGate(gate: HumanGate, summaryKr: string, context: HumanGateContext = {}, template?: MailTemplateRender | null, intent?: InboundIntentId, links?: IntentDraftLinks): string {
  // auto_close (종결 인사): blocked 와 같이 초안을 만들지 않는다 — 발송·검수·참고 초안 모두 없다.
  if (gate.decision === "blocked" || gate.decision === "auto_close") {
    return "";
  }
  if (gate.decision === "needs_review") {
    return NEEDS_REVIEW_FALLBACK_DRAFT;
  }
  if (intent && links) {
    const intentDraft = renderIntentDraft(intent, links);
    if (intentDraft) return intentDraft;
  }
  // 자동 회신 본문에 프로그램 템플릿을 우선 반영한다(없거나 해석 불가 시 아래 기본 카피 폴백).
  if (template) {
    const rendered = renderTemplatedDraft(template);
    if (rendered) return rendered;
  }
  if (summaryKr.includes("상세") || summaryKr.includes("브리프") || summaryKr.includes("보상 안내")) {
    const price = priceNegotiationFromContext(context);
    const priceLines = price && !price.needsHumanReview
      ? [
        `- Reward guide: based on your recent view range (${price.recentViewRange}) and follower range (${price.followerRange}), our starting guide range is ${price.currency} ${formatKRW(price.startingOfferKRW)}-${formatKRW(price.targetOfferKRW)}.`,
        "- This is a guide for email discussion, not a final approved rate.",
      ]
      : ["- Reward guide: we will confirm the range by email after checking channel metrics and content scope."];
    return [
      "Thanks for your interest. Here is the initial brief by email:",
      "",
      "- Collaboration: mobile gameplay content for the current Supercent campaign.",
      "- Content options: short gameplay clips or one longer gameplay video can both be considered.",
      "- What we will confirm in this thread: build access, content requirements, reward range, timeline, and posting details.",
      ...priceLines,
      "- Next step: please reply with your preferred content format, rate range, language/caption preference, and any constraints.",
      "",
      "Best,",
      "Supercent Team",
    ].join("\n");
  }
  return "Thanks for your interest! For this collaboration, the proposed range is within our guide. Let us know by email if this works and we'll share the next step.\n\nBest,\nSupercent Team";
}
