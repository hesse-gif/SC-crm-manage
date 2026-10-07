/**
 * AI-DRAMA-DISCOVERY-METAPROMPT W5 — JEV 댓글 감성 파이프라인 (비동기).
 *
 * 수집: functions/activityRefresh.ts의 fetchTopComments(공식 commentThreads.list, 1 unit/call —
 * 이미 존재하는 함수, 새 provider 없음)를 그 후보의 discovery-time 자격증거 영상(qualifyingVideo)에
 * 대해 호출한다.
 *
 * 스코어링: callJev choice 문항 1콜/후보. 원시 댓글은 절대 State에 넣지 않는다 — 댓글마다
 * ≤240자로 자른 excerpt만 보낸다(SEC-P0-009). 채널/후보 식별자도 안 보낸다(순수 텍스트 배열).
 *
 * 캐싱·사용량: callJev(functions/jev/jevClient.ts)가 cacheScope 기반 캐시 선행과
 * reportLlmUsage(COST-P0-006/007)를 이미 내장한다 — 이 모듈은 그 계약을 그대로 쓴다.
 *
 * 큐잉(Codex 적대 리뷰 P0 수리): 전용 컬렉션 comment_insights_pending/{orgId}::{channelId}를
 * 쓴다 — candidate_pool/campaign_candidates 문서에는 절대 쓰지 않는다. 이유: exact-scope(프로그램+
 * 캠페인 스코프) 발굴은 candidateScope.ts buildProgramScopedCandidateParticipationWrites 를
 * 타면 candidate_pool 문서를 **아예 안 쓴다**(discovery.ts persistCandidates — plan 이 있으면
 * campaign_candidates 만 쓴다). T049 캠페인은 정확히 이 exact-scope 경로다(스펙: "campaign_candidates에
 * accountOwnership 스탬프로 기록"). candidate_pool 에 merge:true 로 pending 플래그를 쓰면
 * **존재하지 않던 candidate_pool 문서를 새로 만들어**, listCandidates 의 rowFromPoolDocData
 * (poolBacked:true, 거의 빈 문서)가 원래 정상 경로였던 rowFromLinkDocData(poolBacked:false,
 * campaign_candidates 의 완전한 데이터)를 밀어내는 심각한 회귀가 된다. 전용 컬렉션은 이 문제가
 * 구조적으로 없다 — 필요한 컨텍스트(ownerOrgId, qualifyingVideoId)는 enqueue 시점에 이미 들고
 * 있는 CandidateResult 에서 직접 캡처해 이 문서 자체에 싣는다.
 *
 * org 스코핑(최종 전체-브랜치 Codex 적대 리뷰 P0 수리): pending/insight 문서 id는
 * `${orgId}::${channelId}`다(orgScopedInsightKey) — channelId만으로 키하면 T049가 분석한
 * 결과를 T056이 같은 채널을 발굴했을 때 그대로 재활용해 버려("이미 분석됨"으로 판단, JEV
 * 재호출 스킵) T049가 낸 비용으로 만든 결과를 다른 org가 읽는 구조가 됐다. org마다 독립 문서로
 * 완전히 분리한다 — 같은 채널을 여러 org가 각자 발굴하면 각자 JEV를 한 번씩 낸다(중복 비용
 * 가능성보다 격리를 우선).
 *
 * 저장: creator_comment_insights/{orgId}::{channelId} — 기존 리더(functions/read.ts
 * listCreatorCommentInsights)가 이 컬렉션을 재활용하지만, 그 리더는 범용 페이지네이션 목록이라
 * 문서 id 형식에 의존하지 않는다. 기존 Gemini 기반 필드(status/weightedSentiment/..., 여전히
 * 평범한 channelId를 doc id로 쓸 수 있음)와는 병존(merge:true)하되 서로 다른 문서다 — 이 모듈은
 * {choice, probabilities, confidence, analyzedCount, modelId, analyzedAtIso} 만 쓴다.
 *
 * listCandidates 요청 내 라이브 분석 금지(4초/5건 예산 보호) — 이 스윕은 별도 스케줄에서만 돈다.
 */
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
import { fetchTopComments, type YoutubeGetQuotaContext } from "./activityRefresh";
import {
  selectYoutubeApiKey,
  YoutubeQuotaPoolExhaustedError,
  type SelectYoutubeApiKeyInput,
} from "./youtubeQuotaPools";
import { YOUTUBE_GROWTH_POOL_ID } from "./apiQuota";
import { callJev } from "./jev/jevClient";
import { validateJevQuestions, type JevChoiceQuestion, type JevRequest } from "./jev/jevTypes";

const COMMENT_INSIGHTS_PENDING_COLLECTION = "comment_insights_pending";
const CREATOR_COMMENT_INSIGHTS_COLLECTION = "creator_comment_insights";

/** 후보당 표본이 이 미만이면 insufficient_sample(스펙: "≥10개 미만"). */
export const CREATOR_COMMENT_SENTIMENT_MIN_SAMPLE = 10;
/** 댓글 1건당 JEV로 보내는 원문 상한(SEC-P0-009 — 전문 금지, excerpt만). */
export const CREATOR_COMMENT_EXCERPT_MAX_CHARS = 240;
/** 후보당 분석에 쓰는 최대 댓글 수(상한 100 — fetchTopComments 1페이지 콜로 충분). */
const CREATOR_COMMENT_SENTIMENT_SAMPLE_CAP = 50;
/** 한 pass가 드레인하는 후보 수 상한(listCandidates 응답 경로와 완전히 분리된 별도 스케줄). */
export const CREATOR_COMMENT_SENTIMENT_SWEEP_LIMIT = 5;
/** 큐 아사 방지(Codex 적대 리뷰 라운드2 P1 수리): 조회창은 실제 작업 상한(limit)과 무관하게 항상
 * 이 고정값까지 넓힌다 — 쿼터-차단 항목이 앞쪽을 계속 채워도 뒤쪽 건강한 항목을 이번 pass에서
 * 훑을 수 있다. 라운드3 재검증 수리: 예전엔 `limit * 배수`(유효 limit 범위 1~20에서 최대 120)로
 * 계산해서 이 상수를 실질적으로 절대 못 건드렸다(스케줄이 쓰는 기본 limit=5면 30에서 멈춤) — 이제
 * limit과 무관하게 곧장 이 값을 쓴다. 잔여 위험(문서화, 지금은 보류): 조회창 자체보다 더 많은
 * 항목이 동시에 쿼터-차단 상태면(현재 T049 단일 org 파일럿 규모에서는 비현실적 — 스코프별 org
 * 수만큼만 pending이 쌓이고, 각 org의 소진은 매일 자정(PT) 자연 회복된다) 그 뒤의 건강한 항목은
 * 이번 pass에서 못 본다. 진짜 무한 큐 회전(커서/셔플)은 아직 도달 불가능한 규모의 문제를 미리
 * 해결하는 추측성 설계라 지금은 보류 — 실제로 스코프가 넓어지면 재검토한다. */
const SCAN_WINDOW_CAP = 200;
/** Firestore 배치 쓰기 상한(500)보다 낮게 — 이 리포 다른 청크 배치(discovery.ts persistCandidates)
 * 와 같은 200을 쓴다(Codex 적대 리뷰 P1 수리 — 발굴 잡 1건이 최대 1,000건까지 결과를 낼 수 있다). */
const ENQUEUE_BATCH_CHUNK_SIZE = 200;

const JEV_SENTIMENT_MODEL_ID = "jev-latest";
const JEV_SENTIMENT_QUESTION_ID = "creator_comment_sentiment";
export const JEV_SENTIMENT_CHOICE_POSITIVE = "positive";
export const JEV_SENTIMENT_CHOICE_MIXED = "mixed";
export const JEV_SENTIMENT_CHOICE_NEGATIVE = "negative";

export type CreatorCommentSentimentPendingCandidate = {
  readonly channelId: string;
  /** discovery-time qualifying-video evidence's videoId — captured at enqueue time so the sweep
   * never has to re-derive it from a doc that may not carry it (see file header). */
  readonly qualifyingVideoId: string | null;
};

function chunkArray<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

// 최종 전체-브랜치 Codex 적대 리뷰 P0 수리: pending/insight 문서를 channelId만으로 키하면, T049가
// 어떤 채널을 분석한 뒤 다른 org(T056 등)가 그 같은 채널을 발굴했을 때 T056의 enqueue가
// (이미 분석됐다는 이유로) 조용히 스킵되고 T056의 candidate 응답이 T049가 돈 내고 만든 분석
// 결과를 그대로 받는다 — "T049 격리는 양방향" 요구를 어긴다. org마다 독립된 문서로 완전히
// 분리한다(비용 공유 최적화보다 격리를 우선) — 같은 채널을 여러 org가 각자 발굴하면 각자 한 번씩
// 낸다(중복 JEV 비용이 생길 수 있지만, 이 정도 빈도에서는 격리가 더 중요한 값이다).
function orgScopedInsightKey(orgId: string, channelId: string): string {
  return `${orgId}::${channelId}`;
}

/**
 * ai_drama 발굴 materialize 직후 호출 — 새로 생성된(merge 아님) candidate만 넘긴다(Codex 적대 리뷰
 * P2 수리 — 이미 이전 pass에서 큐잉/분석된 merge 후보를 다시 태우면 JEV 캐시 TTL(5분) 밖에서 매번
 * 다시 비용을 낸다). 전용 컬렉션(comment_insights_pending)에만 쓴다 — candidate_pool/
 * campaign_candidates는 절대 건드리지 않는다(파일 헤더 참고). 이 함수를 호출하지 않는 모든 기존
 * 경로(growth 발굴 포함)는 이 컬렉션을 절대 건드리지 않는다 — 회귀 0.
 */
export async function enqueueCreatorCommentSentimentPending(
  candidates: readonly CreatorCommentSentimentPendingCandidate[],
  ownerOrgId: string,
  deps: { db?: FirebaseFirestore.Firestore; nowIso?: string } = {},
): Promise<void> {
  const db = deps.db ?? adminDb;
  const trimmedOrgId = ownerOrgId.trim();
  if (!trimmedOrgId) return;
  const byChannelId = new Map<string, CreatorCommentSentimentPendingCandidate>();
  for (const candidate of candidates) {
    const channelId = candidate.channelId.trim();
    if (channelId) byChannelId.set(channelId, candidate);
  }
  if (byChannelId.size === 0) return;

  // Codex 적대 리뷰 라운드2 P0 수리, 라운드3(재검증)에서 read-then-write 레이스 추가 수리:
  // persistOutcome==="created"는 채널 단위가 아니라 (program, campaign, channel) 참여 링크
  // 단위다(discovery.ts persistCandidates — exact-scope는 campaign_candidates 문서 존재 여부로
  // 판정) — 즉 같은 채널이 서로 다른 캠페인(같은 org든 다른 org든)에 새로 링크될 때마다 매번
  // "created"로 다시 들어온다. 이미 대기 중이거나 이미 분석된 채널을 또 큐잉하면 (a) 나중에 온
  // enqueue가 먼저 온 org의 ownerOrgId/qualifyingVideoId를 덮어써 잘못된 조직 쿼터로 청구될 수
  // 있고, (b) 매 캠페인 링크마다 같은 채널을 다시 JEV로 돌려 비용이 샌다(COST-P0). "이미 있으면
  // 스킵"을 읽기(getAll)와 쓰기(batch)를 분리해서 하면, 두 발굴 잡이 같은 채널을 거의 동시에
  // enqueue할 때 둘 다 "없음"을 읽고 둘 다 쓸 수 있다 — 청크 단위 transaction으로 읽기+조건부
  // 쓰기를 하나의 원자 연산으로 묶어 이 레이스를 없앤다(같은 channelId가 여러 청크에 걸치지
  // 않도록 Map으로 이미 dedupe된 뒤라 청크 간 경합은 없다).
  const nowIso = deps.nowIso ?? new Date().toISOString();
  for (const chunk of chunkArray([...byChannelId.values()], ENQUEUE_BATCH_CHUNK_SIZE)) {
    await db.runTransaction(async (transaction) => {
      const pendingRefs = chunk.map((c) => db.collection(COMMENT_INSIGHTS_PENDING_COLLECTION).doc(orgScopedInsightKey(trimmedOrgId, c.channelId)));
      const insightRefs = chunk.map((c) => db.collection(CREATOR_COMMENT_INSIGHTS_COLLECTION).doc(orgScopedInsightKey(trimmedOrgId, c.channelId)));
      const [pendingSnaps, insightSnaps] = await Promise.all([
        transaction.getAll(...pendingRefs),
        transaction.getAll(...insightRefs),
      ]);
      chunk.forEach((candidate, index) => {
        const alreadyPending = pendingSnaps[index].exists;
        const alreadyAnalyzed = insightSnaps[index].exists && Boolean(asRecord(insightSnaps[index].data()).commentSentiment);
        if (alreadyPending || alreadyAnalyzed) return;
        transaction.set(pendingRefs[index], {
          channelId: candidate.channelId,
          ownerOrgId: trimmedOrgId,
          qualifyingVideoId: candidate.qualifyingVideoId ?? null,
          queuedAtIso: nowIso,
        }, { merge: true });
      });
    });
  }
}

/** commentThreads.list 응답 한 항목에서 ≤240자 excerpt만 뽑는다. 채널/작성자 식별자는 담지 않는다. */
function commentExcerpt(item: Record<string, unknown>): string | null {
  const topLevelComment = asRecord(asRecord(item.snippet).topLevelComment);
  const commentSnippet = asRecord(topLevelComment.snippet);
  const text = asString(commentSnippet.textDisplay) || asString(commentSnippet.textOriginal);
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, CREATOR_COMMENT_EXCERPT_MAX_CHARS) : null;
}

function sentimentQuestion(): JevChoiceQuestion {
  return {
    type: "choice",
    instructions:
      "Using only the provided short comment excerpts (each independently truncated, with no "
      + "channel, creator, or author identity attached), judge the overall audience sentiment "
      + "these comments express toward the video/creator they were left on. Choose exactly one "
      + "option. Off-topic or spam-heavy excerpts alone are not evidence of negative sentiment.",
    criteria: {
      [JEV_SENTIMENT_CHOICE_POSITIVE]: "The excerpts are predominantly positive, supportive, or enthusiastic about the content.",
      [JEV_SENTIMENT_CHOICE_MIXED]: "The excerpts show a real split between positive and negative/critical reactions, or are mostly neutral/off-topic with no clear lean.",
      [JEV_SENTIMENT_CHOICE_NEGATIVE]: "The excerpts are predominantly negative, critical, or hostile about the content.",
    },
  };
}

export type CreatorCommentSentimentInsight = {
  status: "ok" | "insufficient_sample" | "unavailable";
  choice: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  analyzedCount: number;
  modelId: string | null;
  analyzedAtIso: string;
};

async function writeSentimentInsight(
  db: FirebaseFirestore.Firestore,
  ownerOrgId: string,
  channelId: string,
  insight: CreatorCommentSentimentInsight,
): Promise<void> {
  // org-scoped 문서 키(orgScopedInsightKey) — 위 파일 상단 참고, T049/T056 등 서로 다른 org가 같은
  // 채널을 분석해도 서로의 결과를 절대 읽지 않는다.
  await db.collection(CREATOR_COMMENT_INSIGHTS_COLLECTION).doc(orgScopedInsightKey(ownerOrgId, channelId)).set({
    creatorId: channelId,
    ownerOrgId,
    commentSentiment: insight,
  }, { merge: true });
}

async function clearPending(db: FirebaseFirestore.Firestore, pendingDocId: string): Promise<void> {
  await db.collection(COMMENT_INSIGHTS_PENDING_COLLECTION).doc(pendingDocId).delete();
}

export type SweepCreatorCommentSentimentDeps = {
  db?: FirebaseFirestore.Firestore;
  limit?: number;
  nowIso?: string;
  fetchComments?: typeof fetchTopComments;
  callJevFn?: typeof callJev;
  selectApiKey?: (input: SelectYoutubeApiKeyInput) => ReturnType<typeof selectYoutubeApiKey>;
};

export type SweepCreatorCommentSentimentResult = {
  scanned: number;
  analyzed: number;
  insufficientSample: number;
  skippedQuotaExhausted: number;
  errors: number;
};

/**
 * comment_insights_pending 큐를 상한만큼 드레인한다. 후보 하나의 실패(쿼터 소진 제외)는 pending
 * 문서를 그대로 둔다 — 다음 pass가 재시도한다(무한 재시도 방지는 스케줄 주기 자체가 맡는다).
 */
export async function sweepCreatorCommentSentiment(
  deps: SweepCreatorCommentSentimentDeps = {},
): Promise<SweepCreatorCommentSentimentResult> {
  const db = deps.db ?? adminDb;
  const limit = Math.max(1, Math.min(20, deps.limit ?? CREATOR_COMMENT_SENTIMENT_SWEEP_LIMIT));
  const doFetchComments = deps.fetchComments ?? fetchTopComments;
  const doCallJev = deps.callJevFn ?? callJev;
  const doSelectApiKey = deps.selectApiKey ?? selectYoutubeApiKey;
  const nowIso = deps.nowIso ?? new Date().toISOString();

  // Codex 적대 리뷰 라운드2 P1 수리(큐 아사 방지): 쿼터-차단 항목은 그대로 두고 재시도하므로,
  // 조회창이 limit과 같으면 계속 소진 상태인 앞쪽 몇 건이 매 pass마다 뒤에 있는 건강한 항목을
  // 밀어낼 수 있다. 조회는 limit과 무관하게 SCAN_WINDOW_CAP까지 하되, 실제 외부 호출
  // (fetchComments+callJev)을 쓰는 "진짜 작업"은 여전히 limit건으로만 제한한다 — 쿼터-차단
  // 스킵은 작업 예산을 쓰지 않으므로 뒤쪽 항목까지 훑을 수 있다.
  const snapshot = await db.collection(COMMENT_INSIGHTS_PENDING_COLLECTION).limit(SCAN_WINDOW_CAP).get();
  const docs = snapshot.docs ?? [];

  const result: SweepCreatorCommentSentimentResult = {
    scanned: 0, analyzed: 0, insufficientSample: 0, skippedQuotaExhausted: 0, errors: 0,
  };
  let workBudgetSpent = 0;

  for (const doc of docs) {
    if (workBudgetSpent >= limit) break;
    result.scanned += 1;
    // Codex 적대 리뷰 라운드2 재검증(P2) 수리: 이전에는 "실제 작업" 분기마다 개별적으로
    // workBudgetSpent를 올렸는데, 그 분기 안의 await(쓰기)가 던지면 바깥 catch가 또 한 번 올려서
    // 같은 후보가 예산을 두 번 소비했다(그만큼 이번 pass가 처리하는 후보 수가 줄어듦). 쿼터-차단
    // continue 두 곳에서만 false로 내리고, 나머지는 성공이든 예외든 finally에서 정확히 한 번만
    // 반영한다.
    let consumesWorkBudget = true;
    try {
      const data = asRecord(doc.data());
      const channelId = asString(data.channelId);
      const ownerOrgId = asString(data.ownerOrgId);
      const videoId = asString(data.qualifyingVideoId);

      // org-scoped 문서 키(orgScopedInsightKey)를 쓰는 enqueueCreatorCommentSentimentPending은
      // ownerOrgId/channelId를 항상 채운다 — 둘 중 하나라도 비어 있으면 이 문서 자체가 오염된
      // 상태다(예: 다른 경로에서 잘못 쓴 문서). org-scope 없이는 안전하게 처리할 수 없으므로
      // 에러로 남기고 건너뛴다(성공한 것처럼 삭제하지 않는다 — 원인 조사가 가능해야 한다).
      if (!channelId || !ownerOrgId) {
        consumesWorkBudget = false;
        result.errors += 1;
        console.warn("[creator-comment-sentiment-sweep] pending doc missing channelId/ownerOrgId — skipping without deleting", { docId: doc.id });
        continue;
      }

      if (!videoId) {
        result.insufficientSample += 1;
        await writeSentimentInsight(db, ownerOrgId, channelId, {
          status: "insufficient_sample", choice: null, probabilities: null, confidence: null,
          analyzedCount: 0, modelId: null, analyzedAtIso: nowIso,
        });
        await clearPending(db, doc.id);
        continue;
      }

      let apiKey = "";
      let quotaContext: YoutubeGetQuotaContext = {};
      try {
        // disallowCrossBorrow(Codex 적대 리뷰 라운드2 P1 수리): crossBorrow는 선택 시점에 lender의
        // 일일 borrow 카운터를 이미 소비한다(recordBorrowGrant) — 빌린 키를 받고 나서 아래에서
        // 거부하면 실제로는 한 번도 안 쓴 borrow grant를 매 sweep pass마다 낭비해, 진짜 빌려야 하는
        // 다른 발굴 잡을 밀어낼 수 있었다. drama_1 자신이 소진됐다면 그냥 재시도 대상(쿼터 소진)일
        // 뿐 growth로 새지 않아야 하므로, 애초에 빌리기 자체를 막는다.
        const selection = await doSelectApiKey({ orgId: ownerOrgId, disallowCrossBorrow: true });
        // 이 큐는 오직 org-scoped(ai_drama) 발굴에서만 채워지므로 정상 해석은 항상 그 org 자신의
        // 풀이어야 한다. growth로 떨어진다면(매핑 미설정/오설정) T049 격리 요구("T049 잡은 drama_1
        // 외 키·쿼터를 못 씀")를 지키기 위해 그대로 진행하지 않는다 — 쿼터 소진과 같은 급으로
        // 취급, pending을 그대로 두고 다음 pass에서 재시도한다. (borrowedFromPoolId 체크는
        // disallowCrossBorrow 이후 이론상 절대 true가 될 수 없지만, 테스트 더블/향후 변경에 대한
        // 방어적 이중 체크로 남긴다.)
        if (selection.poolId === YOUTUBE_GROWTH_POOL_ID || selection.borrowedFromPoolId) {
          consumesWorkBudget = false;
          result.skippedQuotaExhausted += 1;
          console.warn("[creator-comment-sentiment-sweep] refused a growth-resolved/borrowed key — org pool mapping may be missing", {
            channelId, ownerOrgId: ownerOrgId ?? "unknown", resolvedPoolId: selection.poolId, borrowedFromPoolId: selection.borrowedFromPoolId ?? null,
          });
          continue;
        }
        apiKey = selection.apiKey;
        quotaContext = { slotIndex: selection.slotIndex, poolId: selection.poolId };
      } catch (error) {
        if (error instanceof YoutubeQuotaPoolExhaustedError) {
          // 그 org의 풀이 오늘 소진 — growth로 대신 태우지 않는다(격리 유지). pending은 그대로 두고
          // 다음 pass에서 재시도한다(리셋 이후 자연 회복).
          consumesWorkBudget = false;
          result.skippedQuotaExhausted += 1;
          continue;
        }
        throw error;
      }

      const items = await doFetchComments(videoId, apiKey, 100, quotaContext);
      const excerpts = items
        .map(commentExcerpt)
        .filter((text): text is string => Boolean(text))
        .slice(0, CREATOR_COMMENT_SENTIMENT_SAMPLE_CAP);

      if (excerpts.length < CREATOR_COMMENT_SENTIMENT_MIN_SAMPLE) {
        result.insufficientSample += 1;
        await writeSentimentInsight(db, ownerOrgId, channelId, {
          status: "insufficient_sample", choice: null, probabilities: null, confidence: null,
          analyzedCount: excerpts.length, modelId: null, analyzedAtIso: nowIso,
        });
        await clearPending(db, doc.id);
        continue;
      }

      const questions = { [JEV_SENTIMENT_QUESTION_ID]: sentimentQuestion() };
      validateJevQuestions(questions);
      // SEC-P0-009: state에 실리는 것은 이미 ≤240자로 자른 excerpt 배열뿐이다 — 채널/후보 식별자,
      // 이메일, 원문 전체는 절대 포함하지 않는다.
      const request: JevRequest = { state: { excerpts }, model: JEV_SENTIMENT_MODEL_ID, questions };
      // 최종 전체-브랜치 Codex 적대 리뷰 2차 재검증 P0 수리: jevCacheKey(functions/jev/jevCache.ts)는
      // {request, scope, route, endpoint}를 해시한다 — scope.messageId가 channelId뿐이면, T049와
      // T056이 5분 캐시 창 안에서 같은 채널(같은 영상 댓글 excerpts)을 분석할 때 같은 캐시 키가
      // 되어 나중에 온 쪽이 앞선 org의 결과를 그대로 캐시 히트로 받는다 — Firestore 문서 키를
      // org-scope해도 이 캐시 레이어에서 값 자체가 샌다. messageId도 org-scope한다(Firestore와
      // 동일한 orgScopedInsightKey 규칙).
      const jevResult = await doCallJev(request, undefined, {
        cacheScope: {
          tenantKey: "ai_drama_comment_sentiment",
          messageId: orgScopedInsightKey(ownerOrgId, channelId),
          revision: String(excerpts.length),
          policyVersion: "ai-drama-comment-sentiment-v1",
        },
      });
      const answer = jevResult.response.answers[JEV_SENTIMENT_QUESTION_ID];

      if (!answer || answer.type !== "choice") {
        result.errors += 1;
        await writeSentimentInsight(db, ownerOrgId, channelId, {
          status: "unavailable", choice: null, probabilities: null, confidence: null,
          analyzedCount: excerpts.length, modelId: jevResult.response.model || JEV_SENTIMENT_MODEL_ID, analyzedAtIso: nowIso,
        });
        await clearPending(db, doc.id);
        continue;
      }

      await writeSentimentInsight(db, ownerOrgId, channelId, {
        status: "ok",
        choice: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
        analyzedCount: excerpts.length,
        modelId: jevResult.response.model || JEV_SENTIMENT_MODEL_ID,
        analyzedAtIso: nowIso,
      });
      await clearPending(db, doc.id);
      result.analyzed += 1;
    } catch (error) {
      result.errors += 1;
      console.warn("[creator-comment-sentiment-sweep] failed", {
        channelId: doc.id,
        errorCode: (error as { errorCode?: unknown; code?: unknown } | null)?.errorCode
          ?? (error as { code?: unknown } | null)?.code ?? "unknown",
      });
    } finally {
      if (consumesWorkBudget) workBudgetSpent += 1;
    }
  }

  return result;
}
