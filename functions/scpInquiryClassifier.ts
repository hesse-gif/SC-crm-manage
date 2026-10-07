// Task-91 확장 ①: SCP(Super Creator Partners) 챗 문의를 "본인 신청/코드/검수/정산에 대한
// 개인화 상태 질문"인지 그리고 그중 어떤 유형인지로 분류한다.
//
// 이 파일은 순수 함수만 담는다 — firebase-admin 등 런타임 의존성이 전혀 없다
// (tests/scp-inquiry-classifier.test.mjs 가 에뮬레이터 없이 ts.transpileModule 로 직접 로드한다).
//
// 케이스북(chatCasebook.ts)의 caseId 분류와는 다른 축이다: 케이스북은 "어떤 답변 골격을 쓸지"를
// 고르고, 이 분류기는 "본인 신청/코드/검수/정산 상태에 대한 문의라서 시스템 정본 값이 필요한지,
// 필요하다면 어떤 값인지"를 고른다. 결정론 키워드/정규식 규칙만 쓴다 — LLM 호출 없음.
//
// 낮은 확신(low)이거나 매칭 유형이 없음(other)이면 호출부가 자동응답 후보에서 반드시 제외한다
// (SCP 전용 게이트를 적용하지 않고 기존 케이스북/퍼밋 경로를 그대로 따른다) — 애매하면 사람.

export const SCP_INQUIRY_TYPES = [
  "application_status",
  "creator_code",
  "review_result",
  "settlement",
  "other",
] as const;

export type ScpInquiryType = (typeof SCP_INQUIRY_TYPES)[number];
export type ScpInquiryConfidence = "high" | "low";

export type ScpInquiryClassification = {
  readonly type: ScpInquiryType;
  readonly confidence: ScpInquiryConfidence;
  readonly matchedTerms: readonly string[];
};

type InquiryPattern = {
  readonly term: string;
  readonly re: RegExp;
  // high = 개인화된 명시적 신호("신청 상태 알려주세요"). low = 다른 유형과 겹칠 수 있는
  // 일반 키워드 하나뿐("코드"만 단독으로 나온 경우 등) — 단독으로는 자동응답 후보가 아니다.
  readonly weight: "high" | "low";
};

type ScpInquirySpecificType = Exclude<ScpInquiryType, "other">;

const RULES: Readonly<Record<ScpInquirySpecificType, readonly InquiryPattern[]>> = {
  application_status: [
    { term: "application status", re: /\bapplication\s+status\b/i, weight: "high" },
    { term: "status of my application", re: /\bstatus\s+of\s+my\s+application\b/i, weight: "high" },
    { term: "received my application", re: /\b(did you|have you)\s+(receive|get)d?\s+my\s+application\b/i, weight: "high" },
    { term: "when will I be accepted", re: /\bwhen\s+will\s+i\s+(be\s+)?(accept|approve)/i, weight: "high" },
    { term: "have I been accepted", re: /\bhave\s+i\s+(been\s+)?(accepted|approved)\b/i, weight: "high" },
    { term: "신청 상태", re: /신청\s*상태/i, weight: "high" },
    { term: "심사 상태", re: /심사\s*상태/i, weight: "high" },
    { term: "신청 결과", re: /신청\s*결과/i, weight: "high" },
    { term: "승인됐나요", re: /승인\s*(됐|되었|되나요|된건가요|된)/i, weight: "high" },
    { term: "언제 승인", re: /언제\s*승인/i, weight: "high" },
    { term: "application", re: /\bapplication\b/i, weight: "low" },
    { term: "신청", re: /신청/i, weight: "low" },
  ],
  creator_code: [
    { term: "creator code", re: /\bcreator\s*code\b/i, weight: "high" },
    { term: "my code", re: /\bmy\s+code\b/i, weight: "high" },
    { term: "code hasn't arrived", re: /\bcode\b[^.\n]{0,20}\b(hasn'?t|has\s+not|never)\s+(arrived|received|come)\b/i, weight: "high" },
    { term: "when do I get my code", re: /\bwhen\s+(do|will)\s+i\s+(get|receive)\s+(my\s+)?code\b/i, weight: "high" },
    { term: "크리에이터 코드", re: /크리에이터\s*코드/i, weight: "high" },
    { term: "코드 언제", re: /코드[^.\n]{0,6}언제/i, weight: "high" },
    { term: "코드 발급", re: /코드\s*발급/i, weight: "high" },
    { term: "code", re: /\bcode\b/i, weight: "low" },
    { term: "코드", re: /코드/i, weight: "low" },
  ],
  review_result: [
    { term: "review result", re: /\breview\s+result\b/i, weight: "high" },
    { term: "why was my video rejected", re: /\bwhy\s+(was|is|did)\s+my\s+video\s+(get\s+)?(rejected|declined)\b/i, weight: "high" },
    { term: "rejection reason", re: /\brejection\s+reason\b/i, weight: "high" },
    { term: "video approved or rejected", re: /\bvideo\b[^.\n]{0,20}\b(approved|rejected)\b/i, weight: "high" },
    { term: "검수 결과", re: /검수\s*결과/i, weight: "high" },
    { term: "반려 사유", re: /반려\s*사유/i, weight: "high" },
    { term: "왜 반려", re: /왜\s*반려/i, weight: "high" },
    { term: "영상 심사", re: /영상\s*심사/i, weight: "high" },
    { term: "review", re: /\breview\b/i, weight: "low" },
    { term: "rejected", re: /\brejected\b/i, weight: "low" },
    { term: "반려", re: /반려/i, weight: "low" },
    { term: "검수", re: /검수/i, weight: "low" },
  ],
  settlement: [
    { term: "settlement", re: /\bsettlement\b/i, weight: "high" },
    { term: "when will I get paid", re: /\bwhen\s+(will|do)\s+i\s+(get|receive)\s+paid\b/i, weight: "high" },
    { term: "haven't received payment", re: /\b(haven'?t|have\s+not|never)\s+(received|got(ten)?)\s+(my\s+)?(payment|payout)\b/i, weight: "high" },
    { term: "payout", re: /\bpayout\b/i, weight: "high" },
    { term: "정산", re: /정산/i, weight: "high" },
    { term: "입금", re: /입금/i, weight: "high" },
    { term: "보상 언제", re: /보상[^.\n]{0,6}언제/i, weight: "high" },
    { term: "돈 언제", re: /돈[^.\n]{0,6}언제/i, weight: "high" },
    { term: "payment", re: /\bpayment\b/i, weight: "low" },
    { term: "paid", re: /\bpaid\b/i, weight: "low" },
  ],
};

const SPECIFIC_TYPES = Object.keys(RULES) as ScpInquirySpecificType[];

function matchType(text: string, type: ScpInquirySpecificType): { high: string[]; low: string[] } {
  const high: string[] = [];
  const low: string[] = [];
  for (const pattern of RULES[type]) {
    if (pattern.re.test(text)) {
      (pattern.weight === "high" ? high : low).push(pattern.term);
    }
  }
  return { high, low };
}

/**
 * subject+body 를 결정론 규칙으로 분류한다. `caseId`(기존 케이스북 분류 결과)는 시그니처에는
 * 받지만 판정에는 쓰지 않는다 — 이 분류기가 적용되는 시점(호출부의 humanGate.decision===
 * "auto_reply")엔 이미 케이스북이 opt_out/blocked 류를 걸러낸 뒤이므로 caseId 로 추가 억제할
 * 신호가 남아 있지 않고, 반대로 caseId 로 유형을 보정하면 "추측"이 되어 하드 룰(값을 지어내지
 * 않는다)에 어긋난다. 향후 신호가 필요해지면 여기서 확장한다.
 */
export function classifyScpInquiry(input: {
  readonly subject: string;
  readonly body: string;
  readonly caseId?: string | null;
}): ScpInquiryClassification {
  const text = `${input.subject ?? ""}\n${input.body ?? ""}`.slice(0, 8000);
  const matches = SPECIFIC_TYPES.map((type) => ({ type, ...matchType(text, type) })).filter(
    (m) => m.high.length > 0 || m.low.length > 0,
  );

  if (matches.length === 0) {
    return { type: "other", confidence: "low", matchedTerms: [] };
  }

  if (matches.length > 1) {
    // 둘 이상의 유형이 동시에 매칭 — 어느 쪽이 맞는지 추측하지 않는다. 매칭이 가장 많은 유형을
    // 참고용으로 보고하되, 호출부는 confidence:"low" 를 반드시 "자동응답 후보 아님"으로 취급한다.
    const [best] = [...matches].sort(
      (a, b) => b.high.length + b.low.length - (a.high.length + a.low.length),
    );
    return {
      type: best.type,
      confidence: "low",
      matchedTerms: [...new Set(matches.flatMap((m) => [...m.high, ...m.low]))].slice(0, 12),
    };
  }

  const [only] = matches;
  return {
    type: only.type,
    confidence: only.high.length > 0 ? "high" : "low",
    matchedTerms: [...only.high, ...only.low],
  };
}

type ScpGeneralInquiryInput = {
  readonly subject: string;
  readonly body: string;
};

// Fail closed: any personal status/application/rejection/payment-not-received signal anywhere in
// the inquiry overrides general program-explanation wording. This keeps mixed requests on the
// existing human/state-backed path instead of treating them as general FAQ material.
const SCP_PERSONAL_OR_STATUS_OVERRIDE_PATTERNS: readonly RegExp[] = [
  /\bmy\s+(?:creator\s*)?code\b/i,
  /\b(?:where|what)\s+is\s+my\s+(?:creator\s*)?code\b/i,
  /\bwhere\s+is\s+(?:the\s+|my\s+)?(?:creator\s*)?code\b/i,
  /\bwhen\s+(?:will|do)\s+i\s+(?:get|receive)\s+(?:my\s+)?(?:creator\s*)?code\b/i,
  /\b(?:my\s+)?(?:creator\s*)?code\b[^.\n]{0,40}\b(?:hasn'?t|has\s+not|never|not)\b[^.\n]{0,20}\b(?:arrived|received|come)\b/i,
  /\b(?:have\s+not|has\s+not|haven'?t|hasn'?t|did\s+not|didn'?t|never|not)\b[^.\n]{0,40}\b(?:receive|received|got|gotten)\b[^.\n]{0,40}\b(?:creator\s*)?code\b/i,
  /\bwhen\b[^.\n]{0,50}\b(?:my\s+)?(?:creator\s*)?code\b[^.\n]{0,50}\b(?:issued|issue|arrive|arrives|arrived|sent|available|receive|received|get|got|given)\b/i,
  /\b(?:haven'?t|have\s+not|never|not)\s+(?:received|got(?:ten)?)\s+(?:my\s+)?(?:payment|payout|settlement)\b/i,
  /\bwhere\s+is\s+my\s+(?:payment|payout|settlement)\b/i,
  /\bwhen\s+(?:will|do)\s+i\s+(?:get|receive)\s+paid\b/i,
  /\bmy\s+(?:payment|payout|settlement)\b/i,
  /\bmy\s+(?:application|review|video)\b/i,
  /\bmy\b[^.\n]{0,40}\bstatus\b/i,
  /\b(?:application|review|video)\s+(?:status|result)\b/i,
  /\bstatus\s+of\s+my\s+application\b/i,
  /\b(?:approved|rejected|declined|rejection)\b/i,
  /제\s*(?:크리에이터\s*)?코드/,
  /내\s*(?:크리에이터\s*)?코드/,
  /(?:크리에이터\s*)?코드(?:가|는|도)?\s*(?:안|못)\s*(?:왔|온|받|발급)/,
  /(?:크리에이터\s*)?코드[^.\n]{0,30}(?:언제|발급)/,
  /(?:정산|입금|수수료|보상|돈)(?:을|를|이|가|은|는|도)?\s*(?:못|안)\s*받/,
  /(?:정산|입금|보상|돈)[^.\n]{0,20}언제/,
  /(?:제|내)\s*(?:신청|검수|영상|정산|입금|보상|코드)/,
  /(?:신청|심사)\s*상태/,
  /(?:신청|제출|참여)\s*(?:결과|여부|상태|완료)/,
  /(?:정산|입금|보상|수수료|코드)[^.\n]{0,20}상태/,
  /(?:검수|심사)\s*결과/,
  /반려/,
  /거절/,
  /(?:승인|합격|통과)\s*(?:됐|되었|되나요|된)/,
];

const SCP_GENERAL_TOPIC_PATTERN =
  /\b(?:creator\s*code|view\s*reward|reward\s*rates?|commission|settlement|thresholds?|rates?)\b|크리에이터\s*코드|뷰\s*리워드|수수료율|수수료|정산|최소\s*금액|요율|기준/i;

const SCP_GENERAL_EXPLANATION_PATTERN =
  /\bhow\s+(?:does|do)\b[\s\S]{0,120}\b(?:work|calculated|determined)\b|\bwhat\s+are\s+the\s+(?:standard|current|general|program)\b|\bplease\s+explain\b|\bexplain\b[\s\S]{0,120}\b(?:rates?|commission|settlement|thresholds?|creator\s*code)\b|\bhow\s+(?:is|are)\b[\s\S]{0,120}\b(?:calculated|determined)\b|(?:어떻게|어떤\s*기준으로)\s*(?:계산|산정|정해|결정)|(?:일반|표준|기본)\s*(?:정산\s*)?(?:기준|요율|수수료율|최소\s*금액)|(?:알려\s*주세요|설명해\s*주세요|안내해\s*주세요)/i;

const SCP_GENERAL_APPLICATION_PATTERN =
  /\bhow\s+(?:do|can|should)\s+i\s+(?:apply|join|participate|submit)\b|\b(?:application|joining|participation|submission)\s+(?:steps?|process|method|procedure|instructions?|guide)\b|\b(?:apply|join|participate|submit)\b[\s\S]{0,80}\b(?:steps?|process|method|procedure|instructions?|guide)\b|(?:신청|제출|참여)\s*(?:방법|절차|순서|과정)|(?:어떻게|어떤\s*방식으로)\s*(?:신청|제출|참여)/i;

/**
 * Returns true only for explicit general SCP program/rate/commission/threshold explanations.
 * Keyword-only fragments are not enough, and any own-status/payment/rejection/application-status
 * signal anywhere fails closed.
 */
export function isExplicitGeneralScpInquiry(input: ScpGeneralInquiryInput): boolean {
  const text = `${input.subject ?? ""}\n${input.body ?? ""}`;
  if (text.length > 8000) {
    return false;
  }
  if (SCP_PERSONAL_OR_STATUS_OVERRIDE_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }

  return (
    (SCP_GENERAL_TOPIC_PATTERN.test(text) && SCP_GENERAL_EXPLANATION_PATTERN.test(text)) ||
    SCP_GENERAL_APPLICATION_PATTERN.test(text)
  );
}
