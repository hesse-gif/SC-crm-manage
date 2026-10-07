import MiniSearch from "minisearch";
import type { RecCandidate } from "./_rec-mock";

export type CandidateCriteriaForSimilarity = {
  keywords: string[];
  minFollowers: number;
  maxFollowers: number;
  recentActivityDays: number;
  platforms: string[];
};

export type RecommendationSimilarityContext = {
  campaignRef: string;
  creatorRefs: string[];
  gameId: string;
  referenceTerms?: string[];
};

// SEC-P0-005 / P1-26 게이트웨이 임베딩 확장 지점 — vertex.ts 게이트웨이(generateJson)는 현재
// 구조화 JSON 생성만 제공하고 임베딩 엔드포인트가 없다(functions 전역 embed* 호출부 없음, 2026-07
// 재검증). 여기서 외부 임베딩 API를 직접 호출하면 SEC-P0-005(내부 Gateway 경유 강제) 위반이라
// 대신 폴백을 안전하게 만드는 쪽을 택했다. 실제 게이트웨이 임베딩 경로가 생기면 이 인터페이스로
// 주입해 아래 lexical 점수를 폴백으로 내리는 것이 목표(후속 배선: docs/GAPS.md 참고). 지금은
// 타입만 정의하고 미사용 — 가짜 임베딩 신호를 만들지 않는다.
export interface EmbeddingVector {
  readonly values: readonly number[];
}

export interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingVector>;
}

type SearchDocument = {
  id: string;
  name: string;
  handle: string;
  category: string;
  region: string;
  reasons: string;
  signals: string;
};

const clampScore = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/https?:\/\/|www\./g, " ")
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeToken(value)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function uniqueTerms(values: readonly string[], limit: number): string[] {
  const out: string[] = [];
  for (const value of values) {
    for (const token of tokenize(value)) {
      if (out.includes(token)) continue;
      out.push(token);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function documentText(candidate: RecCandidate): string {
  return [
    candidate.name,
    candidate.handle,
    candidate.category,
    candidate.region,
    candidate.youtubeUrl,
    candidate.channelId,
    ...candidate.reasons,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildSearchDocument(candidate: RecCandidate): SearchDocument {
  return {
    id: candidate.id,
    name: candidate.name,
    handle: candidate.handle,
    category: candidate.category,
    region: candidate.region,
    reasons: candidate.reasons.join(" "),
    signals: documentText(candidate),
  };
}

// 필드 가중(P1-26) — 이전 버전은 signals(모든 필드를 이어붙인 설명성 혼합 텍스트)가 name보다 높게
// 부스트되어 "제목(정체성)보다 설명이 더 센" 상태였다. 정체성 필드(name·category·handle)를 signals
// 보다 우선하도록 교정한다.
const FIELD_BOOST: Record<keyof Omit<SearchDocument, "id">, number> = {
  name: 2.6,
  category: 2.2,
  handle: 1.8,
  reasons: 1.4,
  region: 1.1,
  signals: 1.0,
};

const SEARCH_FIELDS: (keyof Omit<SearchDocument, "id">)[] = ["name", "handle", "category", "region", "reasons", "signals"];

function buildSingleDocumentIndex(document: SearchDocument): MiniSearch<SearchDocument> {
  const search = new MiniSearch<SearchDocument>({
    fields: SEARCH_FIELDS,
    storeFields: ["id"],
    searchOptions: {
      boost: FIELD_BOOST,
      prefix: true,
      fuzzy: 0.2,
    },
  });
  search.add(document);
  return search;
}

// 절대 스케일 lexical 점수(P1-26) — 이전 버전은 배치 전체를 하나의 MiniSearch 코퍼스에 넣고
// `score / batchMaxScore`로 정규화했다. BM25류 스코어링은 IDF가 코퍼스(=배치 구성원 전체)에
// 의존하므로, 같은 (질의, 후보) 쌍도 같이 들어온 다른 후보가 누구냐에 따라 값이 달라지는
// 비결정적 결과를 냈다. 여기서는 후보 1건만 담은 단독 코퍼스를 만들어 (a) 실제 질의 점수와
// (b) 그 후보 자신의 전체 어휘를 질의로 쓴 자기참조 최대 점수를 그 후보 하나만의 코퍼스에서
// 계산한다 — 둘 다 같은 단독 코퍼스에서 나오므로 다른 배치 구성원의 존재/부재와 무관하게
// 같은 (질의, 후보) 쌍에 항상 같은 값을 낸다.
function absoluteLexicalScore(candidate: RecCandidate, query: string): number {
  if (!query) return 0;
  const document = buildSearchDocument(candidate);
  const index = buildSingleDocumentIndex(document);

  const [queryResult] = index.search(query);
  const rawScore = queryResult?.score ?? 0;
  if (rawScore <= 0) return 0;

  const selfQuery = uniqueTerms([documentText(candidate)], 96).join(" ");
  if (!selfQuery) return 0;
  const [selfResult] = index.search(selfQuery);
  const selfScore = selfResult?.score ?? 0;
  if (selfScore <= 0) return 0;

  return clampScore((rawScore / selfScore) * 100);
}

function followerFit(candidate: RecCandidate, criteria: CandidateCriteriaForSimilarity): number {
  if (!Number.isFinite(candidate.followers) || candidate.followers <= 0) return 45;
  if (candidate.followers >= criteria.minFollowers && candidate.followers <= criteria.maxFollowers) return 100;
  if (candidate.followers < criteria.minFollowers) {
    const ratio = candidate.followers / Math.max(criteria.minFollowers, 1);
    return clampScore(40 + ratio * 45);
  }
  const ratio = criteria.maxFollowers / Math.max(candidate.followers, 1);
  return clampScore(55 + ratio * 35);
}

function overlapScore(candidate: RecCandidate, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0;
  const candidateTokens = new Set(tokenize(documentText(candidate)));
  const matched = queryTerms.filter((term) => candidateTokens.has(term)).length;
  return clampScore((matched / queryTerms.length) * 100);
}

// recentActivityDays 실사용(P1-26) — 이전 버전은 타입에만 선언되고 어떤 계산에도 쓰이지 않아
// freshness가 유사도에 전혀 반영되지 않았다(감사 기록 "freshness 0"). 상위 파이프라인이 채워주는
// breakdown.freshness(0=활동 정지 추정·100=방금 활동)를 "정지 추정 일수"로 역산한 뒤, 기준
// criteria의 recentActivityDays를 감쇠 윈도우로 쓰는 지수 감쇠를 lexical 신호에 곱한다 — 최신성
// 기준이 엄격할수록(윈도우가 짧을수록) 같은 정도로 오래된 후보를 더 강하게 벌점 준다.
// 주의: 다른 필드들과 달리 `|| 60`을 쓰지 않는다 — freshness가 정말로 0(완전 정지 추정)인 경우를
// falsy로 오인해 60(중립 기본값)으로 되돌리면 "freshness 0" 케이스가 감쇠에 전혀 반영되지 않는
// 바로 그 버그를 재도입하게 된다. 결측(undefined/NaN)일 때만 60으로 기본값을 둔다.
function freshnessDecayFactor(candidate: RecCandidate, criteria: CandidateCriteriaForSimilarity): number {
  const rawFreshness = candidate.breakdown.freshness;
  const freshnessSignal = Number.isFinite(rawFreshness) ? clampScore(rawFreshness) : 60;
  const windowDays = Number.isFinite(criteria.recentActivityDays) && criteria.recentActivityDays > 0
    ? criteria.recentActivityDays
    : 30;
  const impliedStaleDays = 100 - freshnessSignal;
  if (impliedStaleDays <= 0) return 1;
  return Math.exp(-impliedStaleDays / windowDays);
}

function reasonSet(candidate: RecCandidate, scores: { bm25: number; overlap: number; followerFit: number }, hasReferenceTerms: boolean): string[] {
  const reasons: string[] = [];
  if (scores.bm25 >= 65 || scores.overlap >= 35) reasons.push("설정 키워드와 채널 맥락 유사");
  if (scores.overlap >= 20) reasons.push("카테고리·태그 기준 일치");
  if (scores.followerFit >= 90) reasons.push("팔로워 기준 범위 내");
  if (hasReferenceTerms && scores.bm25 >= 45) reasons.push("기존 협업 맥락과 유사");
  for (const reason of candidate.reasons) {
    if (reason && !reasons.includes(reason)) reasons.push(reason);
    if (reasons.length >= 3) break;
  }
  return reasons.length > 0 ? reasons.slice(0, 3) : ["후보탐색 기준 기반 유사 채널"];
}

export function buildSimilarityQuery(
  criteria: CandidateCriteriaForSimilarity,
  context: RecommendationSimilarityContext,
): string {
  return uniqueTerms([
    ...criteria.keywords,
    ...criteria.platforms,
    context.gameId,
    context.campaignRef,
    ...context.creatorRefs,
    ...(context.referenceTerms ?? []),
  ], 48).join(" ");
}

export function rerankCandidatesBySimilarity(
  candidates: readonly RecCandidate[],
  criteria: CandidateCriteriaForSimilarity,
  context: RecommendationSimilarityContext,
): RecCandidate[] {
  if (candidates.length === 0) return [];

  const query = buildSimilarityQuery(criteria, context);
  const queryTerms = uniqueTerms([query], 48);
  const hasReferenceTerms = Boolean(context.referenceTerms?.length || context.creatorRefs.length);

  return candidates
    .map((candidate) => {
      const bm25 = absoluteLexicalScore(candidate, query);
      const overlap = overlapScore(candidate, queryTerms);
      const decay = freshnessDecayFactor(candidate, criteria);
      const fit = followerFit(candidate, criteria);
      const priorSimilarity = candidate.breakdown.similarity || 0;
      // lexical 신호(bm25+overlap)만 recency 감쇠를 받는다 — priorSimilarity는 상위 파이프라인이
      // 이미 채운 외부 신호(향후 실제 임베딩 유사도가 들어올 자리)라 여기서 이중 감쇠하지 않는다.
      const lexicalBlend = (bm25 * 0.58 + overlap * 0.24) * decay;
      const similarity = clampScore(lexicalBlend + priorSimilarity * 0.18);
      const relevance = clampScore((candidate.breakdown.relevance || candidate.matchScore) * 0.55 + bm25 * 0.3 + fit * 0.15);
      const freshness = clampScore(candidate.breakdown.freshness || 60);
      const contact = clampScore(candidate.breakdown.contact || (candidate.email ? 100 : 45));
      const matchScore = clampScore(relevance * 0.34 + similarity * 0.28 + freshness * 0.16 + contact * 0.10 + fit * 0.12);

      return {
        ...candidate,
        matchScore,
        reasons: reasonSet(candidate, { bm25, overlap, followerFit: fit }, hasReferenceTerms),
        breakdown: {
          relevance,
          similarity,
          freshness,
          contact,
        },
      };
    })
    .sort((left, right) => right.matchScore - left.matchScore || right.breakdown.similarity - left.breakdown.similarity);
}
