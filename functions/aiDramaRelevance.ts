/**
 * AI Drama JEV relevance gate.
 *
 * Problem: ai_drama discovery has been surfacing channels with nothing to do with AI-generated
 * drama/microdrama content (e.g. Valorant/Minecraft channels stamped `category: "ai microdrama"`
 * purely because the run was ai_drama-scoped). PR #203 (merged 2026-09-27, just ahead of this module
 * on main) fixed the STRUCTURAL leak at its source: `most_popular` (fetchPopularSeedChannelIds
 * hardcoded the region's *Gaming* chart regardless of vertical) and `channel_graph` (neighbors of
 * already-known, program-blind candidates) are now fully disabled for discoveryVertical ===
 * "ai_drama", and the local lexicon gate (gateDiscoveryCandidatesByLexicon) fails closed for
 * non-keyword candidates when no lexicon is configured instead of passing them through. That fix does
 * NOT, and this module does: (a) semantically judge the KEYWORD lane's own results — YouTube's search
 * API can itself return loosely-related channels for a query, independent of any fallback lane: (b)
 * produce a score + reason the admin UI can show as a "관련도" badge and audit panel; (c) let an
 * operator re-judge/clean up candidates that were already materialized before either fix existed. This
 * module adds a semantic JEV judgment as an independent, mandatory gate for discoveryVertical ===
 * "ai_drama": every candidate — regardless of which lane found it — must be judged "primarily AI
 * drama" by JEV before it is durably written as a campaign candidate.
 *
 * FAIL-CLOSED: JEV unavailable/malformed/exception => `held`, never `accepted` — a held candidate is
 * dropped from this discovery pass exactly like a `rejected` one (both are audited, neither is
 * written to campaign_candidates/candidate_pool). This mirrors the house JEV convention
 * (functions/jev/jevDecision.ts — unavailable/uncertain never authorizes the guarded action).
 *
 * CACHE (COST-P0-011): keyed by channelId + a hash of the judged content, 7-day TTL, checked BEFORE
 * any JEV call. This is deliberately a *separate* cache from functions/jev/jevCache.ts's built-in
 * 5-minute cacheScope cache (unsuitable TTL for "does this channel make AI drama", which does not
 * change minute to minute) — the wire JEV call below intentionally omits `cacheScope` so the two
 * caches never fight over the same content.
 *
 * COST-P0-006/007: real JEV calls already log token/cost via functions/jev/jevClient.ts's callJev.
 * A cache hit here additionally logs a zero-cost "cache" transport entry for observability parity
 * with jevClient's own cache-hit logging.
 *
 * SEC-P0-009: the JEV state carries only title/description/video-title/tags — metadata the discovery
 * pipeline itself already fetched from YouTube's public API — never an email or the raw JEV
 * prompt/response. Callers (the admin UI) read only the derived score/reason on the returned
 * judgment/stamp, never a raw model payload.
 */
import { createHash } from "node:crypto";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString, assertNonGuestAuth, type CallableRequestShape } from "./shared";
import { candidateIdFromCandidate } from "./candidateScope";
import { reportLlmUsage } from "./aiHubReport";
import { callJev, type JevTransport } from "./jev/jevClient";
import { JEV_MODEL_ID, JEV_PROVIDER, validateJevQuestions, type JevNoulQuestion, type JevRequest } from "./jev/jevTypes";
import { assertAccountOwnershipForRecordAsync, resolveAccountOwnershipScopeForRequest } from "./accountOwnership";
import { normalizeDiscoveryVertical, readOwnedDiscoveryVertical } from "./discoveryVerticalPolicy";

export const AI_DRAMA_RELEVANCE_CACHE_COLLECTION = "ai_drama_relevance_cache";
export const AI_DRAMA_RELEVANCE_AUDIT_COLLECTION = "ai_drama_relevance_audit";
export const AI_DRAMA_RELEVANCE_SETTINGS_DOC = "settings/ai_drama_discovery";
export const AI_DRAMA_RELEVANCE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — COST-P0-011.
export const DEFAULT_AI_DRAMA_RELEVANCE_THRESHOLD = 0.6;
export const AI_DRAMA_RELEVANCE_QUESTION_ID = "ai_drama_relevance";
export const AI_DRAMA_RELEVANCE_REJUDGE_CONFIRMATION = "REJUDGE_AI_DRAMA_RELEVANCE";

const TITLE_MAX_CHARS = 200;
const DESCRIPTION_MAX_CHARS = 2000;
const TAGS_MAX = 10;
const REJUDGE_SCAN_LIMIT_DEFAULT = 200;
const REJUDGE_SCAN_LIMIT_MAX = 500;
// Adversarial review (2026-09-27, round 2): the rejudge callable is registered with a 540s timeout
// (functions/index.ts) — up to REJUDGE_SCAN_LIMIT_MAX sequential JEV calls could otherwise exceed
// that and time out with no cursor returned. Stop with a safety margin instead.
const REJUDGE_TIME_BUDGET_MS = 480_000;

export type AiDramaRelevanceVerdict = "accepted" | "rejected" | "held";

export type AiDramaRelevanceJudgment = {
  verdict: AiDramaRelevanceVerdict;
  score: number | null; // 0..1 — null only when held/unavailable.
  scorePercent: number | null; // 0..100 rounded — null only when held/unavailable.
  reason: string; // short derived code — never raw JEV prompt/response (SEC-P0-009).
  modelId: string;
  provider: string;
  judgedAtIso: string;
  cacheHit: boolean;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

/** Stamped onto an accepted candidate's own document — the only shape the admin UI ever reads. */
export type AiDramaRelevanceStamp = {
  score: number;
  scorePercent: number;
  reason: string;
  judgedAtIso: string;
  modelId: string;
};

export type AiDramaRelevanceCandidateInput = {
  channelId: string;
  title: string;
  description: string;
  videoTitle?: string | null;
  videoTags?: readonly string[];
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function truncate(value: string | null | undefined, maxChars: number): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function canonicalTags(tags: readonly string[] | undefined): string[] {
  return [...(tags ?? [])]
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, TAGS_MAX)
    .sort();
}

/** Hash of the exact content that will be judged — a cache entry is valid only while this is unchanged. */
export function contentHashForAiDramaRelevance(input: AiDramaRelevanceCandidateInput): string {
  const canonical = JSON.stringify({
    title: truncate(input.title, TITLE_MAX_CHARS),
    description: truncate(input.description, DESCRIPTION_MAX_CHARS),
    videoTitle: truncate(input.videoTitle, TITLE_MAX_CHARS),
    videoTags: canonicalTags(input.videoTags),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function aiDramaRelevanceQuestion(): JevNoulQuestion {
  return {
    type: "noul",
    instructions:
      "Using only the provided YouTube channel title, description, and (when present) a recent "
      + "qualifying video's title and tags, judge whether this channel's content is PRIMARILY "
      + "AI-generated drama: AI microdrama/short drama/vertical drama, AI-generated anime/animation "
      + "story series, or similar AI-generated narrative content (romance, fantasy, isekai, revenge, "
      + "rebirth serials made with AI generation tools). A channel about unrelated gaming (e.g. "
      + "shooter/sandbox gameplay), vlogging, music, tutorials, or generic entertainment is NOT AI "
      + "drama even if it was discovered during an AI-drama-focused search or loosely overlaps a "
      + "keyword. Thin or absent video evidence is not by itself proof of either outcome.",
    criteria: {
      true: "The provided title/description/video evidence show this channel primarily produces AI-generated drama, microdrama, or AI animation/anime story content.",
      false: "The provided title/description/video evidence show this channel does NOT primarily produce AI-generated drama/microdrama/AI animation content — e.g. it is unrelated gaming, vlogging, music, or generic content.",
    },
  };
}

export async function readAiDramaRelevanceThreshold(db: FirebaseFirestore.Firestore = adminDb): Promise<number> {
  try {
    const snapshot = await db.doc(AI_DRAMA_RELEVANCE_SETTINGS_DOC).get();
    const raw = snapshot.exists ? snapshot.data()?.relevanceThreshold : undefined;
    if (raw === undefined) return DEFAULT_AI_DRAMA_RELEVANCE_THRESHOLD;
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    // Adversarial review (2026-09-27): an out-of-range value (e.g. a misconfigured -1) must NOT be
    // clamped — clamping a negative threshold to 0 would silently accept every score (score is
    // always >= 0), turning a malformed setting into an "accept everything" gate. Treat anything
    // outside [0,1] as malformed configuration and fail safe to the default instead.
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_AI_DRAMA_RELEVANCE_THRESHOLD;
  } catch {
    // Fail-closed to the safe default rather than letting a settings-read error block discovery.
    return DEFAULT_AI_DRAMA_RELEVANCE_THRESHOLD;
  }
}

type RelevanceCacheEntry = {
  version: 1;
  contentHash: string;
  score: number;
  modelId: string;
  provider: string;
  judgedAtIso: string;
  expiresAtMs: number;
};

function isRelevanceCacheEntry(value: unknown): value is RelevanceCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return entry.version === 1
    && typeof entry.contentHash === "string"
    // Adversarial review (2026-09-27): a corrupted/out-of-range cached score (e.g. 2) previously
    // passed this check and was silently clamp01()'d to an accepted 1 downstream. A cache entry is
    // only ever written by this module with a score in [0,1] (see the `set()` call below) — anything
    // outside that range did not come from a real judgment and must be treated as a cache miss.
    && typeof entry.score === "number" && Number.isFinite(entry.score) && entry.score >= 0 && entry.score <= 1
    && typeof entry.expiresAtMs === "number" && Number.isFinite(entry.expiresAtMs);
}

function judgmentFromScore(
  score: number,
  threshold: number,
  meta: Pick<AiDramaRelevanceJudgment, "modelId" | "provider" | "judgedAtIso" | "cacheHit" | "inputTokens" | "outputTokens" | "estimatedCostUsd">,
): AiDramaRelevanceJudgment {
  const bounded = clamp01(score);
  const accepted = bounded >= threshold;
  return {
    verdict: accepted ? "accepted" : "rejected",
    score: bounded,
    scorePercent: Math.round(bounded * 100),
    reason: accepted ? "jev_ai_drama_relevant" : "jev_not_ai_drama",
    ...meta,
  };
}

function heldJudgment(reason: string, nowIso: string, meta: Partial<Pick<AiDramaRelevanceJudgment, "modelId" | "provider" | "inputTokens" | "outputTokens" | "estimatedCostUsd">> = {}): AiDramaRelevanceJudgment {
  return {
    verdict: "held",
    score: null,
    scorePercent: null,
    reason,
    modelId: meta.modelId ?? JEV_MODEL_ID,
    provider: meta.provider ?? JEV_PROVIDER,
    judgedAtIso: nowIso,
    cacheHit: false,
    inputTokens: meta.inputTokens ?? 0,
    outputTokens: meta.outputTokens ?? 0,
    estimatedCostUsd: meta.estimatedCostUsd ?? 0,
  };
}

/**
 * Adversarial review (2026-09-27, round 3): a per-candidate deadline check BEFORE starting a JEV call
 * bounds how many NEW calls get started, but a call that IS started can still run past the deadline —
 * functions/jev/jevClient.ts retries up to 3 times at up to 60s each (~180s worst case), which alone
 * exceeds either caller's whole time budget (discovery's 120s worker deadline, rejudge's 480s budget
 * under its 540s callable timeout). Racing the judgment against the remaining time turns an
 * already-in-flight call that overruns into a held result instead of blocking the loop for however
 * long the JEV client's own retry/backoff takes. The judgment promise itself is not cancelled (no
 * AbortController plumbing here) — it is only stopped being waited on; any late result is discarded.
 */
function raceJudgmentAgainstDeadline(
  judgmentPromise: Promise<AiDramaRelevanceJudgment>,
  remainingMs: number,
  onTimeout: () => AiDramaRelevanceJudgment,
): Promise<AiDramaRelevanceJudgment> {
  // An already-passed (finite, non-positive) deadline times out immediately. An absent deadline
  // (+Infinity — the common case: no context.deadlineMs was given) must wait as long as needed, NOT
  // be treated as "already expired" — Number.isFinite(Infinity) is false, so this is checked first.
  if (!Number.isFinite(remainingMs)) return judgmentPromise;
  if (remainingMs <= 0) return Promise.resolve(onTimeout());
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, remainingMs);
    judgmentPromise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        // judgeAiDramaChannelRelevance never rejects (it is fail-closed internally) — this branch
        // only guards against a future change or an injected test double that does.
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(onTimeout());
      },
    );
  });
}

export type JudgeAiDramaChannelRelevanceDeps = {
  db?: FirebaseFirestore.Firestore;
  callJevFn?: typeof callJev;
  transport?: JevTransport;
  now?: () => number;
};

/**
 * Single-channel JEV relevance judgment with its own 7-day content-hash cache (COST-P0-011),
 * checked BEFORE any JEV call. Fail-closed: any egress/parse failure resolves to `held`, never
 * `accepted` (see file header).
 */
export async function judgeAiDramaChannelRelevance(
  input: AiDramaRelevanceCandidateInput,
  threshold: number,
  deps: JudgeAiDramaChannelRelevanceDeps = {},
): Promise<AiDramaRelevanceJudgment> {
  const db = deps.db ?? adminDb;
  const now = deps.now ?? Date.now;
  const doCallJev = deps.callJevFn ?? callJev;
  const nowIso = new Date(now()).toISOString();
  const contentHash = contentHashForAiDramaRelevance(input);
  const channelId = input.channelId.trim();

  if (channelId) {
    try {
      const snapshot = await db.collection(AI_DRAMA_RELEVANCE_CACHE_COLLECTION).doc(channelId).get();
      const entry = snapshot.data();
      if (isRelevanceCacheEntry(entry) && entry.contentHash === contentHash && entry.expiresAtMs > now()) {
        try {
          await reportLlmUsage({
            modelId: entry.modelId || JEV_MODEL_ID,
            provider: entry.provider || JEV_PROVIDER,
            transport: "cache",
            inputTokens: 0,
            outputTokens: 0,
            totalCostUsd: 0,
          });
        } catch {
          // Monitoring must not break the gate.
        }
        return judgmentFromScore(entry.score, threshold, {
          modelId: entry.modelId || JEV_MODEL_ID,
          provider: entry.provider || JEV_PROVIDER,
          judgedAtIso: entry.judgedAtIso || nowIso,
          cacheHit: true,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
        });
      }
    } catch {
      // Cache lookup failure is a miss — fall through to a real JEV call.
    }
  }

  const questions = { [AI_DRAMA_RELEVANCE_QUESTION_ID]: aiDramaRelevanceQuestion() };
  const request: JevRequest = {
    state: {
      title: truncate(input.title, TITLE_MAX_CHARS),
      description: truncate(input.description, DESCRIPTION_MAX_CHARS),
      video_title: truncate(input.videoTitle, TITLE_MAX_CHARS),
      video_tags: canonicalTags(input.videoTags),
    },
    model: JEV_MODEL_ID,
    questions,
  };

  let result;
  try {
    validateJevQuestions(questions);
    // No cacheScope on purpose — our own 7-day cache above already prevents redundant spend, and
    // layering jevClient's 5-minute cacheScope cache on top would only add a second, shorter-lived,
    // differently-keyed cache for no benefit (see file header).
    result = await doCallJev(request, deps.transport, {});
  } catch {
    return heldJudgment("jev_unavailable", nowIso);
  }

  const answer = result.response.answers[AI_DRAMA_RELEVANCE_QUESTION_ID];
  const modelId = result.response.model || JEV_MODEL_ID;
  const callMeta = {
    modelId,
    provider: result.provider,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
  };
  if (!answer || answer.type !== "noul") {
    return heldJudgment("jev_answer_missing", nowIso, callMeta);
  }

  const score = clamp01(answer.noul);
  if (channelId) {
    try {
      await db.collection(AI_DRAMA_RELEVANCE_CACHE_COLLECTION).doc(channelId).set({
        version: 1,
        contentHash,
        score,
        modelId,
        provider: result.provider,
        judgedAtIso: nowIso,
        expiresAtMs: now() + AI_DRAMA_RELEVANCE_CACHE_TTL_MS,
      } satisfies RelevanceCacheEntry);
    } catch {
      // Cache writes are best-effort and must never gate the decision.
    }
  }

  return judgmentFromScore(score, threshold, {
    ...callMeta,
    judgedAtIso: nowIso,
    cacheHit: result.cacheHit === true,
  });
}

export function aiDramaRelevanceStampFromJudgment(judgment: AiDramaRelevanceJudgment): AiDramaRelevanceStamp | null {
  if (judgment.verdict !== "accepted" || judgment.score === null || judgment.scorePercent === null) return null;
  return {
    score: judgment.score,
    scorePercent: judgment.scorePercent,
    reason: judgment.reason,
    judgedAtIso: judgment.judgedAtIso,
    modelId: judgment.modelId,
  };
}

function auditDocId(campaignId: string, channelId: string): string {
  return `${campaignId}::${channelId}`.slice(0, 1500);
}

async function writeAiDramaRelevanceAudit(
  db: FirebaseFirestore.Firestore,
  input: {
    campaignId: string;
    ownerOrgId: string;
    channelId: string;
    channelName: string;
    judgment: AiDramaRelevanceJudgment;
  },
  nowIso: string,
): Promise<void> {
  if (input.judgment.verdict === "accepted") return;
  await db.collection(AI_DRAMA_RELEVANCE_AUDIT_COLLECTION).doc(auditDocId(input.campaignId, input.channelId)).set({
    campaignId: input.campaignId,
    ownerOrgId: input.ownerOrgId,
    channelId: input.channelId,
    channelName: input.channelName || "",
    verdict: input.judgment.verdict, // "rejected" | "held"
    score: input.judgment.score,
    scorePercent: input.judgment.scorePercent,
    reason: input.judgment.reason,
    modelId: input.judgment.modelId,
    provider: input.judgment.provider,
    judgedAtIso: input.judgment.judgedAtIso,
    updatedAtIso: nowIso,
  }, { merge: true });
}

/**
 * Adversarial review (2026-09-27): a channel that was rejected/held on a prior pass and is now
 * accepted (content changed, threshold changed, or JEV became available again) must not keep
 * showing as "rejected"/"held" in the audit panel — the audit collection's whole purpose is "what
 * did the gate drop", and an accepted channel was not dropped. Best-effort: an audit doc going stale
 * for one pass is a display nit, never a correctness issue (the accepted candidate itself is still
 * correctly written either way).
 */
async function clearAiDramaRelevanceAudit(db: FirebaseFirestore.Firestore, campaignId: string, channelId: string): Promise<void> {
  try {
    await db.collection(AI_DRAMA_RELEVANCE_AUDIT_COLLECTION).doc(auditDocId(campaignId, channelId)).delete();
  } catch {
    // Best-effort — never let audit cleanup block an accepted candidate from being kept.
  }
}

export type AiDramaRelevanceGateContext = {
  campaignId?: string | null;
  ownerOrgId?: string | null;
  /**
   * Absolute deadline (Date.now()-scale) after which the gate stops calling JEV and holds every
   * remaining candidate instead (audited with reason "jev_gate_budget_exhausted") — protects the
   * calling discovery worker's own deadline from an unbounded sequential JEV-call loop. Callers
   * should pass their own remaining-time budget minus a safety margin; omitted = no deadline.
   */
  deadlineMs?: number;
};

// Adversarial review (2026-09-27): sequential per-candidate JEV calls had no cap — a pass with
// hundreds of candidates could both blow a worker's time budget and run up JEV cost in one go. This
// is a hard ceiling independent of the deadline check above (deadlineMs may be generous/absent in a
// test or a future caller; this constant is the last line of defense).
export const AI_DRAMA_RELEVANCE_MAX_JUDGMENTS_PER_PASS = 60;

export type AiDramaRelevanceGateDeps = JudgeAiDramaChannelRelevanceDeps & {
  judgeFn?: typeof judgeAiDramaChannelRelevance;
  threshold?: number;
  maxJudgmentsPerPass?: number;
};

export type AiDramaRelevanceGateResult<T> = {
  gated: T[];
  judged: number;
  accepted: number;
  rejected: number;
  held: number;
};

// Structural shape only — deliberately NOT importing CandidateResult from discovery.ts (one-way
// dependency, same convention as functions/creatorCommentSentiment.ts).
type AiDramaGateCandidateShape = {
  channelRef?: string;
  candidateRef?: string;
  candidateId?: string;
  id?: string;
  name: string;
  publicDescription?: string;
  qualifyingVideo?: { title?: string; tags?: readonly string[] };
};

function channelIdForGate(candidate: AiDramaGateCandidateShape): string {
  return candidateIdFromCandidate(candidate) || asString(candidate.channelRef) || asString(candidate.candidateRef);
}

/**
 * Batch relevance gate — the single choke point discovery.ts calls for discoveryVertical ===
 * "ai_drama", covering the keyword lane and both fallback lanes (most_popular/channel_graph)
 * identically, since by the time this runs all three lanes are merged into one candidate list (see
 * file header). Accepted candidates are returned with an `aiDramaRelevance` stamp attached (flows
 * straight into candidate_pool/campaign_candidates via the existing generic field-spread write path —
 * no separate hydrate step needed for the admin badge). Rejected/held candidates are dropped and
 * recorded in AI_DRAMA_RELEVANCE_AUDIT_COLLECTION for admin review; a per-candidate audit write
 * failure is logged and does not stop the gate (the drop itself is authoritative either way).
 */
export async function gateAiDramaCandidatesByRelevance<T extends AiDramaGateCandidateShape>(
  candidates: readonly T[],
  context: AiDramaRelevanceGateContext,
  deps: AiDramaRelevanceGateDeps = {},
): Promise<AiDramaRelevanceGateResult<T & { aiDramaRelevance: AiDramaRelevanceStamp }>> {
  const db = deps.db ?? adminDb;
  const now = deps.now ?? Date.now;
  const doJudge = deps.judgeFn ?? judgeAiDramaChannelRelevance;
  const threshold = deps.threshold ?? await readAiDramaRelevanceThreshold(db);
  const campaignId = asString(context.campaignId) || "unscoped";
  const ownerOrgId = asString(context.ownerOrgId) || "unscoped";
  const deadlineMs = context.deadlineMs ?? Number.POSITIVE_INFINITY;
  const maxJudgments = deps.maxJudgmentsPerPass ?? AI_DRAMA_RELEVANCE_MAX_JUDGMENTS_PER_PASS;

  const gated: (T & { aiDramaRelevance: AiDramaRelevanceStamp })[] = [];
  let judged = 0;
  // Adversarial review (2026-09-27, round 2): the budget must cap real JEV calls (the actual
  // cost/latency source), not every judged candidate — a pass where the first N candidates are all
  // cheap 7-day cache hits must not starve candidate N+1 of ever reaching a real JEV call.
  let jevCallsMade = 0;
  let accepted = 0;
  let rejected = 0;
  let held = 0;

  for (const candidate of candidates) {
    const channelId = channelIdForGate(candidate);
    const nowIso = new Date(now()).toISOString();

    const budgetExhausted = jevCallsMade >= maxJudgments || now() >= deadlineMs;
    const judgment = budgetExhausted
      ? heldJudgment("jev_gate_budget_exhausted", nowIso)
      : await raceJudgmentAgainstDeadline(
          doJudge({
            channelId,
            title: candidate.name ?? "",
            description: candidate.publicDescription ?? "",
            videoTitle: candidate.qualifyingVideo?.title ?? null,
            videoTags: candidate.qualifyingVideo?.tags ?? [],
          }, threshold, deps),
          deadlineMs - now(),
          () => heldJudgment("jev_gate_deadline_exceeded", nowIso),
        );
    if (judgment.reason !== "jev_gate_budget_exhausted") {
      judged += 1;
      if (!judgment.cacheHit) jevCallsMade += 1;
    }

    const stamp = aiDramaRelevanceStampFromJudgment(judgment);
    if (judgment.verdict === "accepted" && stamp) {
      accepted += 1;
      gated.push({ ...candidate, aiDramaRelevance: stamp });
      if (channelId) await clearAiDramaRelevanceAudit(db, campaignId, channelId);
      continue;
    }
    if (judgment.verdict === "rejected") rejected += 1; else held += 1;
    try {
      await writeAiDramaRelevanceAudit(db, {
        campaignId,
        ownerOrgId,
        channelId,
        channelName: candidate.name ?? "",
        judgment,
      }, nowIso);
    } catch (error) {
      console.warn("[ai-drama-relevance] audit write failed — candidate still dropped", {
        channelId,
        verdict: judgment.verdict,
        errorCode: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
  }

  return { gated, judged, accepted, rejected, held };
}

// ---------- Operator re-judge callable (super_admin only) ----------

export type RejudgeAiDramaCandidatesResult = {
  ok: true;
  dryRun: boolean;
  campaignId: string;
  threshold: number;
  scanned: number;
  kept: number;
  wouldReject: number;
  wouldHold: number;
  cleaned: number;
  hasMore: boolean;
  /** Pass back as `afterCandidateId` to continue past this page when `hasMore` is true. */
  nextCursor: string | null;
};

/**
 * Mirrors discovery.ts's private `normalizedProgramCriteriaSnapshot` — but ONLY its
 * discoveryVertical-normalization behavior, which is all `readOwnedDiscoveryVertical` below actually
 * consumes. Cannot import that function directly: it is not exported, and exporting it would create a
 * circular import (discovery.ts already imports gateAiDramaCandidatesByRelevance from this module).
 * Adversarial review (2026-09-27, round 3): a raw `{...program.eligibilityCriteria,
 * ...program.candidateCriteria}` merge (round-2's version) can disagree with discovery.ts's real
 * result whenever one side uses the legacy `vertical` key and the other uses `discoveryVertical` —
 * e.g. eligibilityCriteria.discoveryVertical="ai_drama" + candidateCriteria.vertical="game" raw-merges
 * to `{discoveryVertical:"ai_drama", vertical:"game"}` (eligibility's key survives untouched, so
 * `discoveryVertical` wins), whereas discovery.ts normalizes each side to a single `discoveryVertical`
 * key FIRST, so candidateCriteria's normalized "game" correctly overwrites eligibility's on merge.
 * Keep in sync with discovery.ts's normalizedProgramCriteriaSnapshot if that ever changes.
 */
function normalizedDiscoveryVerticalOnly(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const owned = Object.prototype.hasOwnProperty.call(record, "discoveryVertical")
    || Object.prototype.hasOwnProperty.call(record, "vertical");
  return owned ? { discoveryVertical: normalizeDiscoveryVertical(record.discoveryVertical ?? record.vertical) } : {};
}

/**
 * Adversarial review (2026-09-27, round 2): resolves the campaign's OWN authoritative
 * discoveryVertical using the EXACT SAME source precedence discovery.ts itself uses for live
 * discovery (resolveProgramDiscoveryCriteria, discovery.ts ~line 2454:
 * `readOwnedDiscoveryVertical([campaign, targeting, programDefaults])`, where `targeting` is
 * `campaign.targetingCriteria` and `programDefaults` merges the campaign's own program's
 * normalized `eligibilityCriteria`/`candidateCriteria`, candidateCriteria winning — see
 * normalizedDiscoveryVerticalOnly above). Round-1's version only looked at
 * `campaign.candidateCriteria`/`candidateCriteriaSnapshot` — fields discovery.ts does not
 * authoritatively read for this decision — which meant a campaign whose CURRENT vertical is "game"
 * but that carries a stale `candidateCriteriaSnapshot` from an earlier "ai_drama" run could still
 * pass this guard. A mistaken/stale campaignId must never reach the judge+delete loop below — every
 * one of its candidates would fail an AI-drama judgment and be deleted.
 */
async function assertCampaignIsAiDramaScoped(db: FirebaseFirestore.Firestore, campaignId: string): Promise<void> {
  const campaignSnapshot = await db.collection("campaigns").doc(campaignId).get();
  const campaign = asRecord(campaignSnapshot.data());
  const targeting = asRecord(campaign.targetingCriteria);
  const programId = asString(campaign.canonicalProgramId) || asString(campaign.programId);
  let programDefaults: Record<string, unknown> = {};
  if (programId) {
    const programSnapshot = await db.collection("programs").doc(programId).get();
    const program = asRecord(programSnapshot.data());
    programDefaults = {
      ...normalizedDiscoveryVerticalOnly(program.eligibilityCriteria),
      ...normalizedDiscoveryVerticalOnly(program.candidateCriteria),
    };
  }
  const vertical = readOwnedDiscoveryVertical([campaign, targeting, programDefaults]);
  if (vertical !== "ai_drama") {
    throw Object.assign(
      new Error("failed-precondition: campaign is not ai_drama-scoped — refusing to judge/delete its candidates"),
      { code: "failed-precondition", errorCode: "ai_drama_relevance_rejudge_not_ai_drama_campaign" },
    );
  }
}

/**
 * Super-admin operator tool: re-judges existing campaign_candidates docs for a campaign against the
 * current threshold/JEV judgment, to clean up ai_drama candidates that were materialized before this
 * gate existed (or under a stale threshold). `dryRun` defaults true and never writes. A real
 * (non-dryRun) run requires the confirm literal (house convention — see
 * functions/campaignCandidateMigration.ts), stamps `aiDramaRelevance` onto candidates that would now
 * be kept, and deletes+audits the campaign_candidates link doc for any that would now be
 * rejected/held (candidate_pool identity docs are untouched — only the campaign-scoped link is
 * removed). Deterministically ordered by document id with an `afterCandidateId` cursor (house
 * pagination convention — functions/candidateScopeRepair.ts) so a caller can page through a campaign
 * with more candidates than one call's `limit`.
 */
export async function rejudgeAiDramaCampaignCandidates(
  request: CallableRequestShape,
  deps: AiDramaRelevanceGateDeps = {},
): Promise<RejudgeAiDramaCandidatesResult> {
  assertNonGuestAuth(request, "ai_drama_relevance.rejudge", ["super_admin"]);
  const db = deps.db ?? adminDb;
  const data = asRecord(request.data);
  const campaignId = asString(data.campaignId);
  if (!campaignId) {
    throw Object.assign(new Error("invalid-argument: campaignId is required"), { code: "invalid-argument", errorCode: "ai_drama_relevance_rejudge_missing_campaign_id" });
  }
  const dryRun = data.dryRun !== false;
  const rawLimit = typeof data.limit === "number" ? data.limit : Number(data.limit);
  const limit = Math.max(1, Math.min(REJUDGE_SCAN_LIMIT_MAX, Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : REJUDGE_SCAN_LIMIT_DEFAULT));
  const afterCandidateId = asString(data.afterCandidateId);
  if (!dryRun && data.confirm !== AI_DRAMA_RELEVANCE_REJUDGE_CONFIRMATION) {
    throw Object.assign(new Error(`failed-precondition: confirm must equal ${JSON.stringify(AI_DRAMA_RELEVANCE_REJUDGE_CONFIRMATION)}`), { code: "failed-precondition", errorCode: "ai_drama_relevance_rejudge_confirm_required" });
  }
  await assertCampaignIsAiDramaScoped(db, campaignId);

  const doJudge = deps.judgeFn ?? judgeAiDramaChannelRelevance;
  const threshold = deps.threshold ?? await readAiDramaRelevanceThreshold(db);
  let query = db.collection("campaign_candidates")
    .where("campaignId", "==", campaignId)
    .orderBy(FieldPath.documentId())
    .limit(limit);
  if (afterCandidateId) query = query.startAfter(afterCandidateId);
  const snapshot = await query.get();

  let scanned = 0;
  let kept = 0;
  let wouldReject = 0;
  let wouldHold = 0;
  let cleaned = 0;
  let lastDocId: string | null = null;
  // Adversarial review (2026-09-27, round 2): up to `limit` (max 500) sequential JEV calls inside a
  // 540s callable can otherwise time out mid-page with zero cursor returned, losing that page's
  // progress entirely. Stop early with a safety margin and hand back a cursor for whatever was
  // actually finished — `hasMore` covers both "more docs in this page" and "stopped before finishing
  // this page" uniformly.
  const rejudgeDeadlineMs = (deps.now?.() ?? Date.now()) + REJUDGE_TIME_BUDGET_MS;
  let stoppedEarly = false;

  for (const doc of snapshot.docs) {
    if ((deps.now?.() ?? Date.now()) >= rejudgeDeadlineMs) {
      stoppedEarly = true;
      break;
    }
    scanned += 1;
    lastDocId = doc.id;
    const row = asRecord(doc.data());
    const qualifyingVideo = asRecord(row.qualifyingVideo);
    const channelId = asString(row.candidateId) || doc.id;
    const judgment = await raceJudgmentAgainstDeadline(
      doJudge({
        channelId,
        title: asString(row.name),
        description: asString(row.publicDescription),
        videoTitle: asString(qualifyingVideo.title) || null,
        videoTags: Array.isArray(qualifyingVideo.tags) ? qualifyingVideo.tags.filter((tag): tag is string => typeof tag === "string") : [],
      }, threshold, deps),
      rejudgeDeadlineMs - (deps.now?.() ?? Date.now()),
      () => heldJudgment("jev_gate_deadline_exceeded", new Date().toISOString()),
    );

    const stamp = aiDramaRelevanceStampFromJudgment(judgment);
    if (judgment.verdict === "accepted" && stamp) {
      kept += 1;
      if (!dryRun) {
        await doc.ref.set({ aiDramaRelevance: stamp }, { merge: true });
        await clearAiDramaRelevanceAudit(db, campaignId, channelId);
      }
      continue;
    }
    if (judgment.verdict === "rejected") wouldReject += 1; else wouldHold += 1;
    if (!dryRun) {
      await writeAiDramaRelevanceAudit(db, {
        campaignId,
        ownerOrgId: asString(row.ownerOrgId) || "unscoped",
        channelId,
        channelName: asString(row.name),
        judgment,
      }, new Date().toISOString());
      await doc.ref.delete();
      cleaned += 1;
    }
  }

  const hasMore = stoppedEarly || snapshot.size === limit;
  return {
    ok: true,
    dryRun,
    campaignId,
    threshold,
    scanned,
    kept,
    wouldReject,
    wouldHold,
    cleaned,
    hasMore,
    nextCursor: hasMore ? lastDocId : null,
  };
}

// ---------- Admin audit read (rejected/held candidates, for the "관련도 감사" panel) ----------

export type AiDramaRelevanceAuditRow = {
  channelId: string;
  channelName: string;
  verdict: "rejected" | "held";
  scorePercent: number | null;
  reason: string;
  judgedAtIso: string;
};

export type ListAiDramaRelevanceAuditResult = {
  ok: true;
  campaignId: string;
  rows: AiDramaRelevanceAuditRow[];
  hasMore: boolean;
};

const AUDIT_LIST_SCAN_LIMIT = 200;
const AUDIT_LIST_ROWS_MAX = 100;

/**
 * Read-only admin audit view over AI_DRAMA_RELEVANCE_AUDIT_COLLECTION for one campaign — the
 * rejected/held channels an ai_drama discovery pass dropped, with their score/reason, so an operator
 * can spot-check the gate instead of only seeing what it let through. viewer+ (same grade as
 * listCandidates), gated by the SAME per-campaign account-ownership check listCampaignCandidates uses
 * (functions/campaigns.ts) — adversarial review (2026-09-27) flagged that any authenticated viewer
 * could otherwise pass an arbitrary campaignId and read another organization's audit rows. A
 * genuine (non-viewAs) super_admin bypasses this, same as everywhere else in the codebase.
 * Deliberately queries by `campaignId` equality only (no orderBy — avoids requiring a composite
 * Firestore index for what is a small, bounded admin-only read) and sorts/filters the bounded scan
 * window in memory.
 */
export type ListAiDramaRelevanceAuditDeps = {
  db?: FirebaseFirestore.Firestore;
  resolveAccountOwnershipScope?: typeof resolveAccountOwnershipScopeForRequest;
  assertAccountOwnership?: typeof assertAccountOwnershipForRecordAsync;
};

export async function listAiDramaRelevanceAudit(
  request: CallableRequestShape,
  deps: ListAiDramaRelevanceAuditDeps = {},
): Promise<ListAiDramaRelevanceAuditResult> {
  const db = deps.db ?? adminDb;
  const data = asRecord(request.data);
  const campaignId = asString(data.campaignId);
  if (!campaignId) {
    throw Object.assign(new Error("invalid-argument: campaignId is required"), { code: "invalid-argument", errorCode: "ai_drama_relevance_audit_missing_campaign_id" });
  }
  const doResolveScope = deps.resolveAccountOwnershipScope ?? resolveAccountOwnershipScopeForRequest;
  const doAssertOwnership = deps.assertAccountOwnership ?? assertAccountOwnershipForRecordAsync;
  const accountOwnershipScope = await doResolveScope(
    request,
    "ai_drama_relevance.audit.list",
    ["super_admin", "admin", "manager", "viewer"],
  );
  const campaignSnapshot = await db.collection("campaigns").doc(campaignId).get();
  await doAssertOwnership(accountOwnershipScope, campaignSnapshot.data() ?? {}, "ai_drama_relevance.audit.list");
  const verdictFilter = data.verdict === "rejected" || data.verdict === "held" ? data.verdict : "all";

  const snapshot = await db.collection(AI_DRAMA_RELEVANCE_AUDIT_COLLECTION)
    .where("campaignId", "==", campaignId)
    .limit(AUDIT_LIST_SCAN_LIMIT)
    .get();

  const rows: AiDramaRelevanceAuditRow[] = [];
  for (const doc of snapshot.docs) {
    const row = asRecord(doc.data());
    const verdict = row.verdict === "rejected" || row.verdict === "held" ? row.verdict : null;
    if (!verdict || (verdictFilter !== "all" && verdict !== verdictFilter)) continue;
    rows.push({
      channelId: asString(row.channelId) || doc.id,
      channelName: asString(row.channelName),
      verdict,
      scorePercent: typeof row.scorePercent === "number" && Number.isFinite(row.scorePercent) ? row.scorePercent : null,
      reason: asString(row.reason) || "unknown",
      judgedAtIso: asString(row.judgedAtIso),
    });
  }
  rows.sort((left, right) => right.judgedAtIso.localeCompare(left.judgedAtIso));

  return {
    ok: true,
    campaignId,
    rows: rows.slice(0, AUDIT_LIST_ROWS_MAX),
    hasMore: snapshot.size === AUDIT_LIST_SCAN_LIMIT,
  };
}
