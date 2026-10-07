/**
 * R30-2 [사용자 승인] — 하루 1콜 LLM 키워드 제안기.
 *
 * 왜: R24 n-gram 마이너는 이미 찾은 후보 텍스트에서만 캐는 닫힌 루프라 **우주 밖 어휘**를 만들지
 * 못한다. 2026-08-01 실측으로 풀 고갈이 확정됐다(이메일 보유 1,690 중 1,597 기컨택 → 발송 가능 9명).
 * 새 모집단을 열려면 장르 밖 어휘가 필요하다.
 *
 * 하드 룰(전부 이 파일에서 강제한다):
 * - SEC-P0-005: 외부 AI API 직접 호출 금지 → 모델 호출은 주입된 기존 게이트웨이 chokepoint
 *   (vertex.ts callModel; transport ai_hub_gateway|vertex_direct)만 쓴다. 새 HTTP 클라이언트 없음.
 * - COST-P0-011: 캐시 조회 없이 모델 호출 금지 → cacheLookup 선행, 히트면 호출 0.
 * - COST-P0-006/007: 토큰·비용은 aiHubReport 의 정본 writer 로 기록(캐시 히트는 transport "cache", 비용 0).
 * - SEC-P0-009: 프롬프트 원문·응답 텍스트는 Firestore·로그·에러 어디에도 남기지 않는다(길이·해시·
 *   건수만). 단, 24h TTL 캐시에는 **제안된 term 문자열 배열**이 담긴다 — 재호출을 막기 위한 값이고
 *   PII 가 아니다(프롬프트 입력 자체에 개인정보를 넣지 않는다).
 * - 킬스위치 기본 false · 라우트 미설정이면 fail-closed 스킵 · 하루 1콜.
 *
 * 설계 원칙: **LLM 을 신뢰하지 않는다.** 산출은 R29 검증층(연락처 제거 → 정규화 → 불용어 →
 * 기존 우주 토큰 부분집합 배제 → excludeKeywords → 일/총 상한)을 그대로 통과한 것만 채택한다.
 * 검증층은 호출자가 주입한다(admin.ts 소유) — 두 경로(n-gram·LLM)가 같은 층을 공유하기 위함이다.
 */
import { createHash } from "node:crypto";

export const KEYWORD_EXPANSION_LLM_ROUTE = "keyword_expansion" as const;
export const KEYWORD_EXPANSION_LLM_CACHE_TTL_SECONDS = 24 * 60 * 60;
export const KEYWORD_EXPANSION_LLM_MAX_SUGGESTIONS = 20;
/**
 * W90: 하루 **2콜**(롤링 24h) — 제안자 1 + 크리틱 1. R30-2 는 제안자만 있어 1이었다.
 * 크리틱을 별도 축으로 두지 않고 같은 예산에 넣는 이유: 두 콜은 **한 세대의 한 질문**이고,
 * 캐시 히트 시에는 둘 다 안 부른다(캐시에 이미 크리틱 통과분이 들어 있다).
 * 채택 상한(일 8개)과는 여전히 별개 축이다.
 */
export const KEYWORD_EXPANSION_LLM_DAILY_CALL_CAP = 2;
/** 크리틱 사유는 원장·어드민에 노출되므로 길이를 못 박는다(원문 유출 방지 · SEC-P0-009). */
export const KEYWORD_CRITIC_REASON_MAX_LENGTH = 80;

export type KeywordLlmSkipReason =
  | "kill_switch_off"
  | "route_unconfigured"
  | "daily_call_cap"
  | "empty_context"
  | "cache_hit"
  | "model_error"
  | "unparseable_response"
  | "no_valid_terms"
  // W90: 제안은 나왔지만 크리틱이 전부 거부했다. "모델이 안 돌았다"와 구분해야 한다 —
  //   전자는 게이트가 일한 것이고 후자는 고장이다.
  | "critic_rejected_all"
  | "critic_error"
  | "critic_unparseable";

/** W90: 크리틱 판정 1건. `reason` 은 서버가 정제한 짧은 문자열만(프롬프트/응답 원문 금지). */
export type KeywordCriticVerdict = {
  term: string;
  accepted: boolean;
  reason: string;
};

export type KeywordLlmSuggestionOutcome = {
  terms: string[];
  /** 모델을 실제로 호출했는가(캐시 히트·스킵이면 false). 수용 기준 ①②③④의 관측점. */
  modelCalled: boolean;
  cacheStatus: "hit" | "miss" | "skipped";
  skipReason: KeywordLlmSkipReason | null;
  /** SEC-P0-009: 원문 대신 남기는 증거. */
  promptChars: number;
  responseHash: string | null;
  suggestedCount: number;
  acceptedCount: number;
  /** W90: 크리틱이 실제로 돌았는가. 킬스위치 off·캐시 히트·제안 0이면 false. */
  criticCalled: boolean;
  /** W90: 판정 원장(채택/거부 + 한 줄 사유). 코퍼스에 그대로 남아 어드민에 뜬다. */
  criticVerdicts: KeywordCriticVerdict[];
  /** W90: 크리틱이 거부한 수(코드 필터 탈락과 구분된다). */
  criticRejectedCount: number;
  /**
   * W90-R2 [리더 결정 · **시도 기준**]: 이 pass 가 게이트웨이로 **디스패치한 횟수**.
   * 성공 여부가 아니라 시도 수다 — 상한의 목적은 호출 횟수 통제이고, 게이트웨이가 5xx 를
   * 던지기 전에 토큰을 태울 수 있으며, 무엇보다 실패가 상한을 안 먹으면 고장난 캠페인이
   * 하루 종일 재시도한다. `modelCalled`(성공 의미)는 기존 소비자를 위해 그대로 둔다.
   */
  callsMade: number;
};

export type KeywordLlmRoute = {
  mode?: string;
  costModel?: string;
  currentModel?: string;
  premiumModel?: string;
};

export type KeywordLlmSuggestInput = {
  /** 킬스위치. **정확히 true** 만 실행 — 비불리언(문자열·숫자·객체)은 전부 차단된다. */
  enabled: unknown;
  route: KeywordLlmRoute | null | undefined;
  campaignId: string;
  gameId: string;
  categories: string[];
  activeTerms: string[];
  retiredTerms: string[];
  /** W75가 기존 keywordCorpus에 누적한 query별 신규율 상위 힌트. PII 없이 term+집계만 허용. */
  performanceHints?: string[];
  targetCountries: string[];
  /** 롤링 24h 창 안에서 이미 쓴 LLM 호출 수. */
  dailyCallCount: number;
  nowIso: string;
  /** 캐시 계층(discovery.ts 의 기존 TTL 캐시를 주입한다 — 새 캐시 구현 금지). */
  cache: {
    key(seedParts: string[]): string;
    lookup(key: string, ttlSeconds: number): Promise<{ status: "hit" | "miss"; value?: Record<string, unknown> }>;
    store(key: string, ttlSeconds: number, value: Record<string, unknown>): Promise<unknown>;
  };
  /** 모델 chokepoint(vertex.ts callModel). 이 파일은 HTTP 를 직접 만지지 않는다. */
  callModel: (modelId: string, responseSchema: unknown, promptText: string) => Promise<{
    json?: unknown;
    modelId?: string;
    provider?: string;
    transport?: string;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  }>;
  /** 정본 사용량 writer(aiHubReport.reportLlmUsage). */
  reportUsage: (usage: {
    modelId: string;
    provider?: string;
    transport: string;
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
    actionId: string;
  }) => Promise<void>;
  /** R29 검증층(admin.ts 소유). 통과분만 채택한다. */
  validate: (terms: string[]) => string[];
};

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    terms: { type: "array", items: { type: "string" }, maxItems: KEYWORD_EXPANSION_LLM_MAX_SUGGESTIONS },
  },
  required: ["terms"],
} as const;

function skipped(reason: KeywordLlmSkipReason, cacheStatus: KeywordLlmSuggestionOutcome["cacheStatus"] = "skipped"): KeywordLlmSuggestionOutcome {
  return {
    terms: [],
    modelCalled: false,
    cacheStatus,
    skipReason: reason,
    promptChars: 0,
    responseHash: null,
    suggestedCount: 0,
    acceptedCount: 0,
    criticCalled: false,
    criticVerdicts: [],
    criticRejectedCount: 0,
    callsMade: 0,
  };
}

/**
 * W90 크리틱 프롬프트 — 제안자와 **역할이 반대**다. 제안자는 "더 내놔"이고 크리틱은 "이게 정말
 * 연락 가능한 게임 크리에이터를 데려오냐"를 묻는다. 그럴듯함(plausibility)과 수율(yield)을
 * 가르는 게 목적이므로, 거부 클래스를 **실측 정크로** 못 박아 준다(cp-bd7d1ea7aq4k 실존 사례).
 *
 * 프롬프트에 넣는 것: 카테고리·기존 term·후보 term 뿐. 후보 이메일·크리에이터 식별자·국가별
 * 개인정보는 없다(SEC-P0-009 — 제안자 프롬프트와 같은 규율).
 */
export function buildKeywordCriticPrompt(input: {
  categories: string[];
  activeTerms: string[];
  performanceHints?: string[];
  candidates: string[];
}): string {
  const lines = [
    "You are a strict critic for a YouTube creator-discovery keyword set (mobile game marketing).",
    "For each candidate term, decide: would searching YouTube with this term surface CONTACTABLE GAME CREATORS?",
    `Campaign categories (the domain axis): ${input.categories.slice(0, 10).join(", ") || "(unspecified)"}`,
    `Existing keywords (the universe we already cover): ${input.activeTerms.slice(0, 60).join(", ") || "(none)"}`,
    `Query families that already convert well: ${(input.performanceHints ?? []).slice(0, 12).join(", ") || "(none yet)"}`,
    "Reject a candidate when ANY of these hold:",
    '- stopword or grammar fragment ("like", "have a", "re", "go", "join")',
    '- contact-detail fragment ("gmail com", "email casual", "business inquiries")',
    "- outside the campaign domain (not about games or game creators)",
    '- standalone over-broad word ("news", "daily", "updates", "culture", "all levels")',
    "- a subset/synonym of the existing keywords (adds no new creator population)",
    "Accept only terms a real person would type to find game creators in this domain.",
    `Candidates: ${input.candidates.join(", ")}`,
    'Respond as JSON: {"verdicts": [{"term": "...", "accept": true, "reason": "short reason"}]}',
    `Keep each reason under ${KEYWORD_CRITIC_REASON_MAX_LENGTH} characters, plain ASCII, no quotes from this prompt.`,
  ];
  return lines.join("\n");
}

const CRITIC_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      maxItems: KEYWORD_EXPANSION_LLM_MAX_SUGGESTIONS,
      items: {
        type: "object",
        properties: {
          term: { type: "string" },
          accept: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["term", "accept"],
      },
    },
  },
  required: ["verdicts"],
} as const;

/** 사유 정제 — 모델이 뭘 뱉든 짧은 안전 문자열만 원장에 남는다(개행·따옴표 제거, 길이 절단). */
export function sanitizeCriticReason(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\r\n\t"]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, KEYWORD_CRITIC_REASON_MAX_LENGTH);
}

/**
 * 크리틱 응답 → 판정 맵. **모르는 term 은 거부로 취급한다**(fail-closed): 크리틱이 빠뜨린 후보를
 * 통과시키면 "크리틱을 붙였는데 안 거친 것이 들어오는" 구멍이 생긴다.
 */
export function parseCriticVerdicts(json: unknown, candidates: string[]): KeywordCriticVerdict[] | null {
  const record = json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : null;
  const raw = Array.isArray(json) ? json : record?.verdicts;
  if (!Array.isArray(raw)) return null;
  const byTerm = new Map<string, { accepted: boolean; reason: string }>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const term = typeof entry.term === "string" ? entry.term.trim().toLowerCase() : "";
    if (!term) continue;
    byTerm.set(term, {
      accepted: entry.accept === true,
      reason: sanitizeCriticReason(entry.reason),
    });
  }
  return candidates.map((term) => {
    const verdict = byTerm.get(term.trim().toLowerCase());
    if (!verdict) return { term, accepted: false, reason: "critic returned no verdict" };
    return {
      term,
      accepted: verdict.accepted,
      reason: verdict.reason || (verdict.accepted ? "accepted" : "rejected"),
    };
  });
}

/** 라우트에서 모델 id 를 고른다. 미설정이면 null → 호출하지 않는다(fail-closed). */
export function resolveKeywordExpansionModel(route: KeywordLlmRoute | null | undefined): string | null {
  if (!route) return null;
  const candidate = route.mode === "quality"
    ? route.premiumModel
    : route.costModel ?? route.currentModel;
  const modelId = typeof candidate === "string" ? candidate.trim() : "";
  // 26-09-24 [헤세 결정]: gemini-2.5-pro는 비용 사유로 퇴역 — 저장된 라우트가 과거 값을 그대로 들고
  // 있어도 이 fail-closed 경로는 그 모델을 다시 불러오지 않고 route_unconfigured 로 스킵한다.
  if (modelId === "gemini-2.5-pro") return null;
  return modelId || null;
}

/**
 * 캐시 키 씨앗: 캠페인 + 활성 코퍼스 해시 + 최근 은퇴 term + gameId.
 * 우주가 그대로면 같은 질문이므로 24h 안에는 모델을 다시 부르지 않는다(COST-P0-011).
 */
/**
 * W90-R1 [리뷰어 발견 · 크리틱 우회 창]: **캐시 엔트리가 어느 크리틱 계약으로 만들어졌는지**를
 * 키에 박는다.
 *
 * 없으면 무슨 일이 나는가: 캐시는 24h TTL 이고 저장 대상이 "크리틱 통과분"이다. 그런데 배포
 * 직전에 만들어진 구엔트리는 **크리틱을 안 거친 제안 원본**이고, 앞으로 크리틱 프롬프트/판정
 * 스키마를 개정해도 구엔트리는 그대로 히트한다. 두 경우 모두 히트 경로가 코드 필터만 통과하고
 * 크리틱을 건너뛴다 — 최대 24h 짜리 게이트 우회 창이다.
 *
 * ⚠️ 범프 규약: **크리틱 프롬프트 문안·거부 클래스·verdict 스키마 중 하나라도 바꾸면 이 상수를
 *   올린다.** 올리지 않으면 옛 계약으로 판정된 답이 새 계약인 척 재사용된다. 제안자 프롬프트만
 *   바꿀 때는 범프가 필요 없다(그건 이미 activeHash/retiredHash/힌트 해시가 덮는다).
 */
export const KEYWORD_CRITIC_CONTRACT_VERSION = "critic_v1";

export function keywordLlmCacheSeedParts(input: {
  campaignId: string;
  gameId: string;
  activeTerms: string[];
  retiredTerms: string[];
  performanceHints?: string[];
}): string[] {
  const activeHash = createHash("sha256")
    .update(JSON.stringify([...input.activeTerms].map((term) => term.trim().toLowerCase()).sort()))
    .digest("hex")
    .slice(0, 24);
  const retiredHash = createHash("sha256")
    .update(JSON.stringify([...input.retiredTerms].map((term) => term.trim().toLowerCase()).sort()))
    .digest("hex")
    .slice(0, 16);
  // W90-R1: 크리틱 계약 버전을 **base 조각에** 넣는다. 꼬리에 붙이면 무힌트 경로(아래 조기 반환)가
  //   버전을 안 싣고 나가 우회 창이 그대로 남는다 — 두 경로 모두 반드시 버전을 통과해야 한다.
  //   이 변경으로 기존 keyword_expansion 캐시는 전량 미스가 된다. 의도된 비용이다:
  //   구엔트리는 크리틱을 안 거친 답이라 재사용하면 안 되는 값이다.
  const baseParts = [input.campaignId, input.gameId, KEYWORD_CRITIC_CONTRACT_VERSION, activeHash, retiredHash];
  const performanceHints = [...(input.performanceHints ?? [])]
    .map((hint) => hint.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  // W75 이전 호출은 성과 힌트가 없었다. 빈 힌트까지 새 seed 조각으로 직렬화하면 기존
  // keyword_expansion 캐시를 전량 놓쳐 불필요한 Gateway 호출이 생기므로, 무힌트 경로의
  // 키는 R30-2 형식을 바이트 단위로 보존한다.
  if (performanceHints.length === 0) return baseParts;
  const performanceHash = createHash("sha256")
    .update(JSON.stringify(performanceHints))
    .digest("hex")
    .slice(0, 16);
  return [...baseParts, performanceHash];
}

/**
 * 프롬프트. **개인정보·후보 이메일·크리에이터 식별자를 넣지 않는다** — 카테고리/키워드/국가 힌트뿐이다.
 * 원문은 어디에도 저장하지 않으며, 길이만 결과에 남긴다(SEC-P0-009).
 */
export function buildKeywordExpansionPrompt(input: {
  categories: string[];
  activeTerms: string[];
  retiredTerms: string[];
  performanceHints?: string[];
  targetCountries: string[];
}): string {
  const lines = [
    "You expand a YouTube creator-discovery keyword set for a mobile game marketing campaign.",
    "Goal: propose search terms that reach creator populations the current set does NOT reach.",
    `Game categories: ${input.categories.slice(0, 10).join(", ") || "(unspecified)"}`,
    `Target countries: ${input.targetCountries.slice(0, 10).join(", ") || "(any)"}`,
    `Current keywords (do not repeat, do not return sub-phrases of these): ${input.activeTerms.slice(0, 60).join(", ") || "(none)"}`,
    `Retired keywords (these failed, avoid them and close variants): ${input.retiredTerms.slice(0, 20).join(", ") || "(none)"}`,
    `High-performing query families (expand adjacent populations, do not merely repeat): ${(input.performanceHints ?? []).slice(0, 12).join(", ") || "(none yet)"}`,
    "Rules:",
    "- Return adjacent audiences, formats, and sub-genres, not synonyms of the current set.",
    "- 2-30 characters per term, no email addresses, no URLs, no handles, no brand-less generic words.",
    `- Return at most ${KEYWORD_EXPANSION_LLM_MAX_SUGGESTIONS} terms.`,
    'Respond as JSON: {"terms": ["...", "..."]}',
  ];
  return lines.join("\n");
}

function parseSuggestedTerms(json: unknown): string[] | null {
  const record = json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : null;
  const raw = Array.isArray(json) ? json : record?.terms;
  if (!Array.isArray(raw)) return null;
  const terms = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, KEYWORD_EXPANSION_LLM_MAX_SUGGESTIONS);
  return terms;
}

/**
 * 게이트 순서가 곧 계약이다: 킬스위치 → 라우트 → 일 1콜 → **캐시** → 모델 → 파싱 → R29 검증층.
 * 어느 단계에서 멈추든 발굴 엔진은 계속 돈다(throw 하지 않는다 — 사유만 돌려준다).
 */
export async function suggestKeywordsViaLlm(input: KeywordLlmSuggestInput): Promise<KeywordLlmSuggestionOutcome> {
  // R30-4 [적대 리뷰 MEDIUM-2]: 킬스위치는 **정확히 true** 일 때만 열린다. truthy 허용(!enabled)이면
  // 설정 문서에 "true"(문자열)·1 같은 값이 들어갔을 때 라이브러리 경계가 조용히 열린다 — 프로덕션
  // 안전이 호출부(admin.ts)의 ===true 한 겹에만 걸려 있게 된다. 경계에서도 fail-closed 로 못 박는다.
  if (input.enabled !== true) return skipped("kill_switch_off");
  const modelId = resolveKeywordExpansionModel(input.route);
  if (!modelId) return skipped("route_unconfigured");
  if (input.dailyCallCount >= KEYWORD_EXPANSION_LLM_DAILY_CALL_CAP) return skipped("daily_call_cap");
  if (input.activeTerms.length === 0 && input.categories.length === 0) return skipped("empty_context");

  const cacheKey = input.cache.key(keywordLlmCacheSeedParts({
    campaignId: input.campaignId,
    gameId: input.gameId,
    activeTerms: input.activeTerms,
    retiredTerms: input.retiredTerms,
    performanceHints: input.performanceHints,
  }));

  // COST-P0-011: 캐시 선행. 히트면 모델 호출 0 — 그래도 사용량은 transport "cache" 로 남긴다(비용 0).
  const cached = await input.cache.lookup(cacheKey, KEYWORD_EXPANSION_LLM_CACHE_TTL_SECONDS).catch(() => ({ status: "miss" as const }));
  if (cached.status === "hit") {
    const cachedTerms = Array.isArray(cached.value?.terms)
      ? (cached.value?.terms as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
    const accepted = input.validate(cachedTerms);
    await input.reportUsage({
      modelId,
      transport: "cache",
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
      actionId: "keyword_expansion.llm.cache_hit",
    }).catch(() => {});
    // W90: 캐시에는 **크리틱을 이미 통과한** term 만 들어간다(아래 store 지점 참조).
    //   그래서 히트 경로에서 크리틱을 다시 부르지 않는다 — 같은 질문에 같은 판정을 두 번 사거나,
    //   반대로 검증 안 된 값을 통과시키는 두 실패를 모두 피한다.
    return {
      terms: accepted,
      modelCalled: false,
      callsMade: 0,
      cacheStatus: "hit",
      skipReason: "cache_hit",
      promptChars: 0,
      responseHash: null,
      suggestedCount: cachedTerms.length,
      acceptedCount: accepted.length,
      criticCalled: false,
      criticVerdicts: [],
      criticRejectedCount: 0,
    };
  }

  const promptText = buildKeywordExpansionPrompt({
    categories: input.categories,
    activeTerms: input.activeTerms,
    retiredTerms: input.retiredTerms,
    performanceHints: input.performanceHints,
    targetCountries: input.targetCountries,
  });

  let result: Awaited<ReturnType<KeywordLlmSuggestInput["callModel"]>>;
  try {
    result = await input.callModel(modelId, RESPONSE_SCHEMA, promptText);
  } catch {
    // SEC-P0-009: 에러 메시지에 프롬프트·응답이 섞일 수 있으므로 **사유 토큰만** 남긴다.
    // W90-R2: **시도했다가 실패한 호출도 상한을 소모한다.** 종전에는 여기가 0 이라 게이트웨이가
    //   던지는 동안 상한이 영원히 안 차고 재시도가 무한이었다(크리틱 이전부터 있던 구멍).
    return { ...skipped("model_error", "miss"), promptChars: promptText.length, callsMade: 1 };
  }

  await input.reportUsage({
    modelId: typeof result.modelId === "string" && result.modelId ? result.modelId : modelId,
    provider: typeof result.provider === "string" ? result.provider : undefined,
    transport: typeof result.transport === "string" && result.transport ? result.transport : "ai_hub_gateway",
    inputTokens: Number(result.inputTokens ?? 0),
    outputTokens: Number(result.outputTokens ?? 0),
    totalCostUsd: Number(result.estimatedCostUsd ?? 0),
    actionId: "keyword_expansion.llm.call",
  }).catch(() => {});

  const suggested = parseSuggestedTerms(result.json);
  if (!suggested) {
    return { ...skipped("unparseable_response", "miss"), promptChars: promptText.length, modelCalled: true, callsMade: 1 };
  }
  const responseHash = createHash("sha256").update(JSON.stringify(suggested)).digest("hex").slice(0, 24);

  // ── W90 크리틱 패스 ────────────────────────────────────────────────────────
  // 제안자는 "그럴듯한" 것을 잘 만든다. 실측이 보여준 문제는 그럴듯함이 **수율**을 뜻하지
  // 않는다는 것이다(cp-bd7d1ea7aq4k 의 "like"/"join"/"news"/"email casual"). 그래서 코드 필터로
  // 넘기기 **전에** 두 번째 발화로 각 후보를 심문한다. 코드 필터는 문자열 형태만 보고,
  // 크리틱은 도메인 적합성을 본다 — 두 층이 잡는 것이 다르다.
  //
  // 크리틱이 고장나면(호출 실패·파싱 실패) **아무것도 채택하지 않는다**(fail-closed).
  // "크리틱을 붙였는데 고장 시엔 그냥 통과"는 게이트가 없는 것과 같다.
  let criticVerdicts: KeywordCriticVerdict[] = [];
  let criticCalled = false;
  if (suggested.length > 0) {
    const criticPrompt = buildKeywordCriticPrompt({
      categories: input.categories,
      activeTerms: input.activeTerms,
      performanceHints: input.performanceHints,
      candidates: suggested,
    });
    let criticResult: Awaited<ReturnType<KeywordLlmSuggestInput["callModel"]>>;
    try {
      criticResult = await input.callModel(modelId, CRITIC_RESPONSE_SCHEMA, criticPrompt);
      criticCalled = true;
    } catch {
      return {
        ...skipped("critic_error", "miss"),
        // W90-R2: 제안자 1 + 크리틱 1 = 시도 2. 실패해도 소모한다.
        callsMade: 2,
        promptChars: promptText.length + criticPrompt.length,
        modelCalled: true,
        suggestedCount: suggested.length,
        responseHash,
      };
    }
    await input.reportUsage({
      modelId: typeof criticResult.modelId === "string" && criticResult.modelId ? criticResult.modelId : modelId,
      provider: typeof criticResult.provider === "string" ? criticResult.provider : undefined,
      transport: typeof criticResult.transport === "string" && criticResult.transport ? criticResult.transport : "ai_hub_gateway",
      inputTokens: Number(criticResult.inputTokens ?? 0),
      outputTokens: Number(criticResult.outputTokens ?? 0),
      totalCostUsd: Number(criticResult.estimatedCostUsd ?? 0),
      actionId: "keyword_expansion.llm.critic",
    }).catch(() => {});
    const parsed = parseCriticVerdicts(criticResult.json, suggested);
    if (!parsed) {
      return {
        ...skipped("critic_unparseable", "miss"),
        callsMade: 2,
        promptChars: promptText.length + criticPrompt.length,
        modelCalled: true,
        criticCalled: true,
        suggestedCount: suggested.length,
        responseHash,
      };
    }
    criticVerdicts = parsed;
  }
  const criticApproved = criticVerdicts.filter((verdict) => verdict.accepted).map((verdict) => verdict.term);
  const criticRejectedCount = criticVerdicts.length - criticApproved.length;

  // R30-4 [적대 리뷰 LOW-1 주석 정정]: 여기 저장되는 것은 **모델이 제안한 term 문자열 배열**(정규화
  // 이전 값)이다. 프롬프트 원문·모델 응답 텍스트 전체·토큰 로그는 저장하지 않으며, 제안 term 은
  // 검색어일 뿐 후보 이메일·크리에이터 식별자 같은 PII 가 아니다(프롬프트에 애초에 넣지 않는다).
  // TTL 24h 후 자연 만료된다.
  //
  // W90: 저장 대상이 `suggested` → **`criticApproved`** 로 바뀌었다. 캐시는 "이 세대의 답"이고,
  //   이 세대의 답은 이제 크리틱을 통과한 것이다. 제안 원본을 캐시에 두면 24h 동안 히트마다
  //   크리틱을 우회한 값이 흘러든다.
  await input.cache.store(cacheKey, KEYWORD_EXPANSION_LLM_CACHE_TTL_SECONDS, {
    terms: criticApproved,
    suggestedAtIso: input.nowIso,
  }).catch(() => {});

  const accepted = input.validate(criticApproved);
  return {
    terms: accepted,
    modelCalled: true,
    cacheStatus: "miss",
    skipReason: accepted.length === 0
      ? (criticApproved.length === 0 && criticVerdicts.length > 0 ? "critic_rejected_all" : "no_valid_terms")
      : null,
    promptChars: promptText.length,
    responseHash,
    suggestedCount: suggested.length,
    acceptedCount: accepted.length,
    criticCalled,
    criticVerdicts,
    criticRejectedCount,
    // 제안이 0건이면 크리틱 블록을 건너뛰므로 시도는 1이다.
    callsMade: criticCalled ? 2 : 1,
  };
}
