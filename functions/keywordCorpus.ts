/**
 * R30-1 [사용자 승인 · "LLM wiki 처럼 구조화"] — 캠페인 키워드 코퍼스.
 *
 * 왜 필요한가: R24 마이너는 **이미 찾은 후보 텍스트에서만** 단어를 캐는 닫힌 루프라 우주 밖 어휘를
 * 만들지 못한다. 새 출처(LLM)를 들이려면 "이 term 이 어디서 왔고 얼마나 벌었나"를 기록하는 원장이
 * 필요하다 — 출처별 성과가 없으면 LLM 이 쓸모없어도 그걸 알 방법이 없다.
 *
 * 저장 위치는 **캠페인 문서 안**(shortfallDiscoveryState.keywordCorpus) — 새 Firestore 컬렉션 0.
 * 기존 `targetingCriteria.expandedKeywords`(string[])는 shape 를 그대로 두고 **active 항목의 투영**으로
 * 계속 채운다(하위 호환: 소비처·엔진 무수정).
 *
 * ⚠️ 성과 귀속의 한계(명시): 기존 shortfall 잡은 검색 창(harvest window)에 여러 term 을 함께 태우고,
 * 산출 newUnique 를 창 단위로만 관측한다. 그 호출은 분모 없이 창 전체에 균등 귀속하며 순위 힌트일
 * 뿐이다. W75 승격 런은 query별 관측 집합을 보존하므로 optional observedUnique 분모를 함께 넘겨
 * query별 신규율을 누적한다. 어느 쪽도 인과 효과를 뜻하지 않는다.
 */

export type KeywordCorpusSource = "seed" | "mined" | "llm";
export type KeywordCorpusState = "active" | "retired";

export type KeywordCorpusTerm = {
  source: KeywordCorpusSource;
  addedAtIso: string;
  generation: number;
  jobsUsed: number;
  newUniqueTotal: number;
  /** W75: query별 신규 채널률의 정확한 분모. 기존 job 단위 귀속은 이 값 없이 그대로 유지한다. */
  observedUniqueTotal?: number;
  /** W75: 위 분모와 같은 query별 관측에서 나온 신규 수. 기존 창 단위 newUnique와 섞지 않는다. */
  observedNewUniqueTotal?: number;
  /**
   * W90: 이 term 으로 검색해 **연락 가능한**(이메일이 잡힌) 후보가 몇 명 나왔나.
   * W75 가 이미 쿼리별로 계산해 receipt 에 넣던 값(emailResolved)을 코퍼스로 끌어온 것이다 —
   * 새 계측이 아니다. 신규 채널 수(newUnique)와 다른 축인 이유: 관측은 잘 되는데 아무도
   * 연락처가 없는 키워드가 실존한다(그게 정확히 우리가 걸러야 할 것이다).
   */
  emailResolvedTotal?: number;
  /** W90: 관측은 있었는데(observed>0) 이메일이 0이었던 **연속** 귀속 횟수. 수율 퇴역의 근거. */
  emailZeroStreak?: number;
  /** W90: LLM 크리틱 판정 사유(채택 시에도 남긴다 — 왜 통과했는지가 다음 판단의 근거다). */
  criticReason?: string;
  /** W90: 퇴역 사유(수율/필터 재검증 등). 조용히 사라지지 않게 한다. */
  retiredReason?: string;
  state: KeywordCorpusState;
  lastUsedAtIso?: string;
  retiredAtIso?: string;
};

export type KeywordCorpus = {
  terms: Record<string, KeywordCorpusTerm>;
  generation: number;
  updatedAtIso: string;
  /** W90-R3: 크리틱 거부 이력(유계 rolling list · 최신 우선). */
  rejections?: KeywordCorpusRejection[];
};

const MAX_TERMS = 400; // 활성 60 + 은퇴 이력. 문서 크기 유계(1MiB 한참 아래).
const SOURCES: ReadonlySet<string> = new Set(["seed", "mined", "llm"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

function safeIso(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/** 손상·부재 문서를 fail-open 으로 읽는다 — 원장이 깨져도 발굴 엔진은 계속 돈다. */
export function readKeywordCorpus(value: unknown, nowIso: string): KeywordCorpus {
  const record = isRecord(value) ? value : {};
  const rawTerms = isRecord(record.terms) ? record.terms : {};
  const terms: Record<string, KeywordCorpusTerm> = {};
  for (const [term, raw] of Object.entries(rawTerms)) {
    if (!term || !isRecord(raw)) continue;
    const source = typeof raw.source === "string" && SOURCES.has(raw.source)
      ? raw.source as KeywordCorpusSource
      : "mined";
    terms[term] = {
      source,
      addedAtIso: safeIso(raw.addedAtIso, nowIso),
      generation: safeInteger(raw.generation, 0),
      jobsUsed: safeInteger(raw.jobsUsed, 0),
      newUniqueTotal: safeInteger(raw.newUniqueTotal, 0),
      ...(safeInteger(raw.observedUniqueTotal, 0) > 0
        ? { observedUniqueTotal: safeInteger(raw.observedUniqueTotal, 0) }
        : {}),
      ...(safeInteger(raw.observedNewUniqueTotal, 0) > 0
        ? { observedNewUniqueTotal: safeInteger(raw.observedNewUniqueTotal, 0) }
        : {}),
      state: raw.state === "retired" ? "retired" : "active",
      ...(typeof raw.lastUsedAtIso === "string" && raw.lastUsedAtIso ? { lastUsedAtIso: raw.lastUsedAtIso } : {}),
      ...(typeof raw.retiredAtIso === "string" && raw.retiredAtIso ? { retiredAtIso: raw.retiredAtIso } : {}),
      // W90-F4 [같은 클래스 · 읽기 경로]: 이 모듈은 term 을 **화이트리스트로 재조립**한다.
      //   축을 추가할 때 타입·생산 지점만 고치고 여기를 빠뜨리면 저장은 되는데 **다시 읽을 때
      //   사라진다** — 실측으로 emailZeroStreak 이 매 pass 0으로 리셋돼 수율 퇴역(임계 3)이
      //   영원히 도달하지 못하는 상태였다. 아래 왕복 pin 이 이 경계를 상시 지킨다.
      ...(safeInteger(raw.emailResolvedTotal, 0) > 0
        ? { emailResolvedTotal: safeInteger(raw.emailResolvedTotal, 0) }
        : {}),
      ...(safeInteger(raw.emailZeroStreak, 0) > 0
        ? { emailZeroStreak: safeInteger(raw.emailZeroStreak, 0) }
        : {}),
      ...(typeof raw.criticReason === "string" && raw.criticReason
        ? { criticReason: raw.criticReason.slice(0, 80) }
        : {}),
      ...(typeof raw.retiredReason === "string" && raw.retiredReason
        ? { retiredReason: raw.retiredReason.slice(0, 80) }
        : {}),
    };
  }
  return {
    terms,
    generation: safeInteger(record.generation, 0),
    updatedAtIso: safeIso(record.updatedAtIso, nowIso),
    // W90-R3: 거부 이력 복원. 저장된 값이 배열이 아니거나 항목이 깨져 있으면 조용히 버린다
    //   — 이 축은 진단용이라 읽기 실패가 코퍼스 전체를 못 쓰게 만들면 안 된다.
    ...(Array.isArray(record.rejections)
      ? {
        rejections: record.rejections
          .filter((entry): entry is Record<string, unknown> => isRecord(entry))
          .map((entry) => ({
            term: typeof entry.term === "string" ? entry.term.slice(0, 80) : "",
            reason: typeof entry.reason === "string" ? entry.reason.slice(0, 120) : "",
            rejectedAtIso: safeIso(entry.rejectedAtIso, nowIso),
          }))
          .filter((entry) => entry.term)
          .slice(0, KEYWORD_CORPUS_REJECTION_LIMIT),
      }
      : {}),
  };
}

/** 활성 term 투영 — expandedKeywords(string[]) 의 정본 소스다. 입력 순서를 보존한다. */
export function keywordCorpusActiveTerms(corpus: KeywordCorpus): string[] {
  return Object.entries(corpus.terms)
    .filter(([, entry]) => entry.state === "active")
    .map(([term]) => term);
}

/**
 * 현재 우주(expandedKeywords)와 코퍼스를 동기화한다.
 * - 우주에 있는데 코퍼스에 없는 term → 등재(출처는 호출자가 준 값; 기존 배포분 이관은 "seed").
 * - 코퍼스에 active 인데 우주에서 사라진 term → retired(가지치기 결과 반영).
 * 코퍼스가 우주를 **바꾸지는 않는다** — 투영만 한다(엔진 판정 경로 무접촉).
 */
export function syncKeywordCorpusWithUniverse(
  corpus: KeywordCorpus,
  universe: string[],
  input: { defaultSource: KeywordCorpusSource; nowIso: string; sourceByTerm?: Record<string, KeywordCorpusSource> },
): KeywordCorpus {
  const next: Record<string, KeywordCorpusTerm> = { ...corpus.terms };
  const universeSet = new Set(universe);
  for (const term of universe) {
    const existing = next[term];
    if (existing) {
      next[term] = existing.state === "active"
        ? existing
        : { ...existing, state: "active", retiredAtIso: undefined };
      continue;
    }
    next[term] = {
      source: input.sourceByTerm?.[term] ?? input.defaultSource,
      addedAtIso: input.nowIso,
      generation: corpus.generation,
      jobsUsed: 0,
      newUniqueTotal: 0,
      state: "active",
    };
  }
  for (const [term, entry] of Object.entries(next)) {
    if (entry.state === "active" && !universeSet.has(term)) {
      next[term] = { ...entry, state: "retired", retiredAtIso: input.nowIso };
    }
  }
  // W90-F3 [리뷰 BLOCK · 축 탈락]: **반드시 `...corpus` 로 시작한다.** 이 모듈은 반환을 새
  //   객체 리터럴로 재조립하는데, 그러면 top-level optional 축(rejections 등)이 조용히 지워진다.
  //   실측: append 로 쌓은 거부 이력이 바로 뒤 sync/retire 에서 매 pass 전멸했다. 스프레드를
  //   앞에 두면 앞으로 축이 늘어도 자동으로 살아남는다(다음 사람이 세 곳을 기억할 필요가 없다).
  return { ...corpus, terms: boundTerms(next), generation: corpus.generation, updatedAtIso: input.nowIso };
}

/** 새 term 등재(출처 명시). 이미 있으면 출처를 덮어쓰지 않는다 — 최초 발견자가 공로를 갖는다. */
export function upsertKeywordCorpusTerms(
  corpus: KeywordCorpus,
  terms: string[],
  input: { source: KeywordCorpusSource; nowIso: string },
): KeywordCorpus {
  if (terms.length === 0) return corpus;
  const next: Record<string, KeywordCorpusTerm> = { ...corpus.terms };
  for (const term of terms) {
    if (!term) continue;
    const existing = next[term];
    next[term] = existing
      ? { ...existing, state: "active", retiredAtIso: undefined }
      : {
        source: input.source,
        addedAtIso: input.nowIso,
        generation: corpus.generation + 1,
        jobsUsed: 0,
        newUniqueTotal: 0,
        state: "active",
      };
  }
  // W90-F3: 위 세 함수와 같은 이유로 `...corpus` 를 앞에 둔다(upsert 도 반환을 재조립한다).
  return {
    ...corpus,
    terms: boundTerms(next),
    generation: corpus.generation + 1,
    updatedAtIso: input.nowIso,
  };
}

/**
 * 가지치기 결과를 코퍼스에 반영한다(문서에서 지우지 않는다 — 왜 죽었는지가 다음 판단의 근거다).
 * W90: `reason` 을 함께 남긴다. "언제 죽었나"만으로는 다음 세대가 같은 실수를 반복한다.
 */
export function retireKeywordCorpusTerms(
  corpus: KeywordCorpus,
  terms: string[],
  nowIso: string,
  reason?: string,
): KeywordCorpus {
  if (terms.length === 0) return corpus;
  const next: Record<string, KeywordCorpusTerm> = { ...corpus.terms };
  for (const term of terms) {
    const existing = next[term];
    if (!existing) continue;
    next[term] = {
      ...existing,
      state: "retired",
      retiredAtIso: nowIso,
      ...(reason ? { retiredReason: reason.slice(0, 80) } : {}),
    };
  }
  // W90-F3 [리뷰 BLOCK · 축 탈락]: **반드시 `...corpus` 로 시작한다.** 이 모듈은 반환을 새
  //   객체 리터럴로 재조립하는데, 그러면 top-level optional 축(rejections 등)이 조용히 지워진다.
  //   실측: append 로 쌓은 거부 이력이 바로 뒤 sync/retire 에서 매 pass 전멸했다. 스프레드를
  //   앞에 두면 앞으로 축이 늘어도 자동으로 살아남는다(다음 사람이 세 곳을 기억할 필요가 없다).
  return { ...corpus, terms: boundTerms(next), generation: corpus.generation, updatedAtIso: nowIso };
}

/**
 * 잡 완료 성과를 귀속한다(위 ⚠️ 한계 주석 참조). observedUnique=0 인 기존 호출은 창 단위,
 * W75가 한 query씩 호출하며 분모를 넘기는 경우에는 query 단위 집계다.
 * 창에 들지 않은 term 은 손대지 않는다 — 쓰이지 않은 키워드에 성과나 벌점을 주면 원장이 거짓이 된다.
 */
export function attributeKeywordCorpusPerformance(
  corpus: KeywordCorpus,
  windowTerms: string[],
  newUnique: number,
  nowIso: string,
  observedUnique = 0,
  emailResolved = 0,
): KeywordCorpus {
  const attributed = windowTerms.filter((term) => corpus.terms[term]);
  if (attributed.length === 0) return corpus;
  const gain = Math.max(0, Math.trunc(newUnique));
  const emails = Math.max(0, Math.trunc(emailResolved));
  const observed = Math.max(0, Math.trunc(observedUnique));
  const next: Record<string, KeywordCorpusTerm> = { ...corpus.terms };
  for (const term of attributed) {
    const entry = next[term];
    next[term] = {
      ...entry,
      jobsUsed: entry.jobsUsed + 1,
      newUniqueTotal: entry.newUniqueTotal + gain,
      // W90: 이메일 축은 **관측이 있었던 귀속에서만** 센다. 관측 0인 pass 는 "이메일이 안 나왔다"의
      //   증거가 아니라 "안 써봤다"의 증거다 — 그걸로 벌점을 주면 원장이 거짓이 된다.
      //   이메일이 하나라도 나오면 스트릭은 0으로 리셋된다(누적 총합은 계속 쌓인다).
      ...(observed > 0 ? {
        observedUniqueTotal: (entry.observedUniqueTotal ?? 0) + observed,
        observedNewUniqueTotal: (entry.observedNewUniqueTotal ?? 0) + Math.min(gain, observed),
        emailResolvedTotal: (entry.emailResolvedTotal ?? 0) + emails,
        emailZeroStreak: emails > 0 ? 0 : (entry.emailZeroStreak ?? 0) + 1,
      } : {}),
      lastUsedAtIso: nowIso,
    };
  }
  // W90-F3 [리뷰 BLOCK · 축 탈락]: **반드시 `...corpus` 로 시작한다.** 이 모듈은 반환을 새
  //   객체 리터럴로 재조립하는데, 그러면 top-level optional 축(rejections 등)이 조용히 지워진다.
  //   실측: append 로 쌓은 거부 이력이 바로 뒤 sync/retire 에서 매 pass 전멸했다. 스프레드를
  //   앞에 두면 앞으로 축이 늘어도 자동으로 살아남는다(다음 사람이 세 곳을 기억할 필요가 없다).
  return { ...corpus, terms: next, generation: corpus.generation, updatedAtIso: nowIso };
}

/**
 * W90 [수율 기반 퇴역]: **관측은 계속 나오는데 이메일 전환이 연속 0** 인 term 을 고른다.
 *
 * 기존 pruneDeadExpandedKeywords 는 "신규 채널 0"만 봤다. 그런데 실측 정크의 특징은 다르다 —
 * "like"/"news" 류는 신규 채널을 **잘 데려온다**(광의어라 항상 뭔가 걸린다). 다만 그 채널들이
 * 연락 가능하지 않다. 즉 기존 기준으로는 영원히 살아남는 부류이고, 그래서 이 축이 필요하다.
 *
 * 판정 조건 셋을 모두 만족해야 한다:
 *   ① 관측이 실제로 있었다(observedUniqueTotal > 0) — 안 써본 term 을 죽이지 않는다.
 *   ② 신규 채널은 나온다(newUniqueTotal > 0) — 이 축이 겨냥하는 건 "관측되는데 수율 0"이다.
 *      신규 0인 term 은 기존 슬라이스 기준이 이미 담당하므로 여기서 중복 판정하지 않는다.
 *   ③ 이메일 총합 0이고 연속 0 스트릭이 임계 이상.
 *
 * 임계 N: 기존 상수 체계와 맞춘다. 슬라이스 죽음은 "서로 다른 슬라이스 ≥2"로 노이즈를 견디는데,
 * 이메일 축은 귀속 1회가 곧 쿼리 1회라 표본이 더 작다. 그래서 한 단계 보수적으로 **3**을 쓴다
 * (2면 우연한 연속 2회 무이메일에 반응한다 — 지역·시간대 편차로 실제 발생한다).
 */
export const KEYWORD_CORPUS_EMAIL_ZERO_STREAK_RETIRE = 3;

export function keywordCorpusEmailDeadTerms(
  corpus: KeywordCorpus,
  eligible: ReadonlySet<string>,
  streakThreshold = KEYWORD_CORPUS_EMAIL_ZERO_STREAK_RETIRE,
): string[] {
  const dead: string[] = [];
  for (const [term, entry] of Object.entries(corpus.terms)) {
    if (entry.state !== "active") continue;
    // 운영자 시드 보호는 호출부가 eligible 집합으로 강제한다(기계 추가분만 들어온다).
    if (!eligible.has(term)) continue;
    if ((entry.observedUniqueTotal ?? 0) <= 0) continue;
    if (entry.newUniqueTotal <= 0) continue;
    if ((entry.emailResolvedTotal ?? 0) > 0) continue;
    if ((entry.emailZeroStreak ?? 0) < streakThreshold) continue;
    dead.push(term);
  }
  return dead;
}

/**
 * W90: 크리틱 판정 사유를 코퍼스 term 에 붙인다. **코퍼스에 이미 있는 term 만** 건드린다 —
 * 거부된 후보는 애초에 우주에 안 들어가므로 등재 대상이 아니다(거부 사유는 pass 이벤트 링에 남는다).
 * 사유 문자열은 keywordLlmExpansion.sanitizeCriticReason 이 이미 정제·절단한 값이다.
 */
export function annotateKeywordCorpusCriticReasons(
  corpus: KeywordCorpus,
  verdicts: ReadonlyArray<{ term: string; accepted: boolean; reason: string }>,
): KeywordCorpus {
  if (verdicts.length === 0) return corpus;
  const next: Record<string, KeywordCorpusTerm> = { ...corpus.terms };
  let touched = false;
  for (const verdict of verdicts) {
    const entry = next[verdict.term];
    if (!entry || !verdict.reason) continue;
    next[verdict.term] = { ...entry, criticReason: verdict.reason.slice(0, 80) };
    touched = true;
  }
  return touched ? { ...corpus, terms: next } : corpus;
}

/**
 * W90-R3 [리뷰 HIGH · 거부 사유 유실]: 크리틱이 **거부한** 후보의 사유를 남긴다.
 *
 * 왜 term map 이 아니라 별도 rolling list 인가: 거부된 후보는 우주에 들어가지 않으므로 코퍼스
 * term 자체가 없다. 없는 term 에 사유를 달 수 없어서 종전에는 **부분 거부 pass 의 흔적이 0** 이었다
 * (전량 거부일 때만 이벤트 링에 skipReason 이 남았다). 헤세가 "그럴듯함 ≠ 수율"을 판단하려면
 * 오히려 무엇이 왜 걸러졌는지가 더 중요한 쪽인데 그게 안 보였다.
 *
 * 문서 크기 통제: 코퍼스는 **캠페인 문서 안의 map** 이라 무한히 자라면 안 된다(새 컬렉션 금지 제약).
 *   · 상한 30건 — 최신 우선, 오래된 것부터 밀어낸다.
 *   · 항목당 term 80자 + reason 120자 → 최악 ~6KB. 문서 1MB 한도에서 무시할 수준이고,
 *     term map 상한(400)이 이미 지배적이라 이 축이 병목이 되지 않는다.
 *   · 같은 term 이 반복 거부되면 **최신 1건만** 남긴다 — 같은 사유가 목록을 채워 다른 거부를
 *     밀어내면 가시성이 오히려 나빠진다.
 */
export const KEYWORD_CORPUS_REJECTION_LIMIT = 30;

export type KeywordCorpusRejection = {
  term: string;
  reason: string;
  rejectedAtIso: string;
};

export function appendKeywordCorpusRejections(
  corpus: KeywordCorpus,
  verdicts: ReadonlyArray<{ term: string; accepted: boolean; reason: string }>,
  nowIso: string,
): KeywordCorpus {
  const rejected = verdicts.filter((verdict) => !verdict.accepted);
  if (rejected.length === 0) return corpus;
  const incoming: KeywordCorpusRejection[] = rejected.map((verdict) => ({
    term: verdict.term.slice(0, 80),
    reason: verdict.reason.slice(0, 120),
    rejectedAtIso: nowIso,
  }));
  const seen = new Set(incoming.map((entry) => entry.term));
  const retained = (corpus.rejections ?? []).filter((entry) => !seen.has(entry.term));
  return {
    ...corpus,
    rejections: [...incoming, ...retained].slice(0, KEYWORD_CORPUS_REJECTION_LIMIT),
    updatedAtIso: nowIso,
  };
}

/**
 * W90 [write-only 해소]: 어드민 표면에 그대로 실을 수 있는 **읽기 전용 행 투영**.
 *
 * 코퍼스는 캠페인 문서 안의 map 이라 화면이 직접 읽을 수 없다(SEC-P0-004: 클라 Firestore 직접
 * 읽기 금지). 콜러블이 이 함수로 정제된 행만 내보낸다 — 프롬프트·응답 원문은 애초에 저장하지
 * 않으므로 나갈 것도 없고, 사유는 이미 절단된 짧은 문자열이다.
 */
export type KeywordCorpusRow = {
  term: string;
  source: KeywordCorpusSource;
  state: KeywordCorpusState;
  newUniqueTotal: number;
  observedUniqueTotal: number;
  emailResolvedTotal: number;
  emailZeroStreak: number;
  criticReason: string;
  retiredReason: string;
  lastUsedAtIso: string;
};

export function keywordCorpusRows(corpus: KeywordCorpus, limit = 200): KeywordCorpusRow[] {
  return Object.entries(corpus.terms)
    .map(([term, entry]) => ({
      term,
      source: entry.source,
      state: entry.state,
      newUniqueTotal: entry.newUniqueTotal,
      observedUniqueTotal: entry.observedUniqueTotal ?? 0,
      emailResolvedTotal: entry.emailResolvedTotal ?? 0,
      emailZeroStreak: entry.emailZeroStreak ?? 0,
      criticReason: entry.criticReason ?? "",
      retiredReason: entry.retiredReason ?? "",
      lastUsedAtIso: entry.lastUsedAtIso ?? "",
    }))
    // 활성 먼저, 그 안에서는 이메일 수율 높은 순 — 화면 맨 위가 "지금 일하는 키워드"가 되게.
    .sort((left, right) => {
      if (left.state !== right.state) return left.state === "active" ? -1 : 1;
      if (right.emailResolvedTotal !== left.emailResolvedTotal) return right.emailResolvedTotal - left.emailResolvedTotal;
      return left.term.localeCompare(right.term);
    })
    .slice(0, Math.max(0, limit));
}

/**
 * 기존 코퍼스에서 다음 LLM 세대에 줄 비식별 성과 힌트만 만든다. 새 원장/새 모델 경로는 없다.
 * 표본 5개 미만은 우연 변동이 커 제외하고, 신규율→신규수→term 순으로 결정적으로 정렬한다.
 */
export function keywordCorpusPerformanceHints(corpus: KeywordCorpus, limit = 12): string[] {
  return Object.entries(corpus.terms)
    .filter(([term, entry]) => (
      entry.state === "active"
      && (entry.observedUniqueTotal ?? 0) >= 5
      // 운영자 seed도 코퍼스에 들어올 수 있으므로 모델 프롬프트 경계에서 연락처/URL 형태를 재차 뺀다.
      && term.length <= 80
      && !/@|https?:\/\/|www\./i.test(term)
    ))
    .map(([term, entry]) => ({
      term,
      observed: entry.observedUniqueTotal ?? 0,
      fresh: Math.min(entry.observedNewUniqueTotal ?? 0, entry.observedUniqueTotal ?? 0),
    }))
    .sort((left, right) => (
      (right.fresh / right.observed) - (left.fresh / left.observed)
      || right.fresh - left.fresh
      || left.term.localeCompare(right.term)
    ))
    .slice(0, Math.max(0, Math.min(20, Math.trunc(limit))))
    .map((item) => `${item.term} (${item.fresh}/${item.observed} new)`);
}

/** 최근 은퇴한 term(LLM 회피 힌트용). 개인정보 아님 — 키워드 문자열뿐이다. */
export function recentlyRetiredTerms(corpus: KeywordCorpus, limit = 20): string[] {
  return Object.entries(corpus.terms)
    .filter(([, entry]) => entry.state === "retired" && entry.retiredAtIso)
    .sort(([, left], [, right]) => String(right.retiredAtIso).localeCompare(String(left.retiredAtIso)))
    .slice(0, limit)
    .map(([term]) => term);
}

/** 문서 크기 유계: 활성은 전부 보존하고, 은퇴 이력만 오래된 것부터 버린다. */
function boundTerms(terms: Record<string, KeywordCorpusTerm>): Record<string, KeywordCorpusTerm> {
  const entries = Object.entries(terms);
  if (entries.length <= MAX_TERMS) return terms;
  const active = entries.filter(([, entry]) => entry.state === "active");
  const retired = entries
    .filter(([, entry]) => entry.state !== "active")
    .sort(([, left], [, right]) => String(right.retiredAtIso ?? right.addedAtIso).localeCompare(String(left.retiredAtIso ?? left.addedAtIso)))
    .slice(0, Math.max(0, MAX_TERMS - active.length));
  return Object.fromEntries([...active, ...retired]);
}

/**
 * W90-F3 [리뷰어 권고 · 조립을 코드로 고정]: 한 shortfall pass 가 코퍼스에 가하는 **전체 갱신열**.
 *
 * 왜 헬퍼로 뽑는가: F3 의 근인은 개별 함수가 아니라 **조립**이었다. append 로 쌓은 축을 바로 뒤
 * sync/retire 가 지웠는데 각 함수의 단위 테스트는 전부 초록이었다. 호출열이 admin.ts 안에 흩어져
 * 있으면 테스트가 그 순서를 **복사**해야 하고, 복사본은 원본이 바뀌는 순간 거짓말이 된다.
 * 여기로 모으면 pin 이 **실제 조립 그 자체**를 태우므로 다음에 단계가 하나 더 붙어도 자동으로 덮인다.
 *
 * 순서가 의미를 갖는 지점만 적어 둔다:
 *   ① llm 을 mined 보다 **먼저** 등재 — 같은 term 이면 출처가 mined 로 덮이면 안 된다(R30-1).
 *   ② 사유 주석·거부 이력은 sync 앞 — sync 는 우주 기준으로 term 을 정리하는 단계라
 *      그 전에 이번 pass 의 판정 사실을 얹어 둔다.
 *   ③ retire 는 sync 뒤 — sync 가 내린 retired 에 **축별 사유**를 덧씌우는 것이 목적이다.
 *   ④ 성과 귀속은 맨 끝 — 직전 잡의 결과이지 이번 pass 편집의 일부가 아니다.
 */
export function applyKeywordCorpusPassUpdates(
  corpus: KeywordCorpus,
  input: {
    llmTerms: string[];
    minedTerms: string[];
    criticVerdicts: ReadonlyArray<{ term: string; accepted: boolean; reason: string }>;
    universe: string[];
    filterRetiredTerms: string[];
    emailDeadTerms: string[];
    harvestKeywords: string[];
    lastJobNewUnique: number;
    nowIso: string;
  },
): KeywordCorpus {
  let next = upsertKeywordCorpusTerms(corpus, input.llmTerms, { source: "llm", nowIso: input.nowIso });
  next = upsertKeywordCorpusTerms(next, input.minedTerms, { source: "mined", nowIso: input.nowIso });
  next = annotateKeywordCorpusCriticReasons(next, input.criticVerdicts);
  next = appendKeywordCorpusRejections(next, input.criticVerdicts, input.nowIso);
  next = syncKeywordCorpusWithUniverse(next, input.universe, { defaultSource: "seed", nowIso: input.nowIso });
  next = retireKeywordCorpusTerms(next, input.filterRetiredTerms, input.nowIso, "filter_reconcile");
  next = retireKeywordCorpusTerms(next, input.emailDeadTerms, input.nowIso, "email_yield_zero");
  return attributeKeywordCorpusPerformance(next, input.harvestKeywords, input.lastJobNewUnique, input.nowIso);
}
