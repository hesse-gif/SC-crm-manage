// 영상 자막 3-상태 수집 + 재시도 큐 + tierTwoEligibility 순수함수.
// 3-상태: "available"(자막 확보) | "none"(자막 없음, 확정) | "fetch_failed"(수집 시도했지만 실패, 재시도 대상).
// SEC-P0-004: Firestore 쓰기는 functions(feedWorker.ts writeVideo)에서만 수행 — 여기는 순수 계산만 제공.

export type TranscriptStatus = "available" | "none" | "fetch_failed";

export type TranscriptState = {
  readonly status: TranscriptStatus;
  readonly lang?: string;
  readonly text?: string;
  readonly fetchedAt: string;
  readonly attempts: number;
};

export type TierTwoEligibility = "promoted_no_transcript" | "demoted" | "normal";

export const TRANSCRIPT_RETRY_QUEUE_COLLECTION = "transcript_retry_queue";
export const MAX_TRANSCRIPT_RETRY_ATTEMPTS = 5;
const MAX_TRANSCRIPT_TEXT_CHARS = 4000;
const TRANSCRIPT_RETRY_BACKOFF_BASE_MS = 15 * 60 * 1000; // 15분 기준 지수 백오프

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

// 임의 입력(yt-dlp 워커 페이로드/Firestore 문서)을 3-상태 TranscriptState로 정규화.
export function normalizeTranscript(raw: unknown, nowIso: string = new Date().toISOString()): TranscriptState {
  const record = asRecord(raw);
  const status: TranscriptStatus = record.status === "available" || record.status === "fetch_failed" ? record.status : "none";
  const fetchedAt = stringOrUndefined(record.fetchedAt) ?? nowIso;
  const lang = stringOrUndefined(record.lang);

  if (status === "available") {
    const text = stringOrUndefined(record.text)?.slice(0, MAX_TRANSCRIPT_TEXT_CHARS);
    if (!text) return { status: "none", fetchedAt, attempts: nonNegativeInt(record.attempts, 0) };
    return { status: "available", lang, text, fetchedAt, attempts: nonNegativeInt(record.attempts, 1) };
  }

  return { status, lang, fetchedAt, attempts: nonNegativeInt(record.attempts, status === "fetch_failed" ? 1 : 0) };
}

export type TierTwoEligibilityInput = {
  readonly transcript: Pick<TranscriptState, "status">;
  readonly matchedGame?: string | null;
  readonly ownedGameMatch?: boolean;
  readonly similarGameMatch?: boolean;
};

// tierTwoEligibility 순수함수:
//   - transcript.status !== 'none'(즉 available 이거나 아직 재시도 중인 fetch_failed)이면 'normal' — 자막 유무가 확정되기 전엔 등급 조정 보류.
//   - transcript.status === 'none' 확정 + 자사/유사게임 매칭이면 'promoted_no_transcript'(자막 없어도 승격 후보).
//   - transcript.status === 'none' 확정 + 미매칭이면 'demoted'.
export function computeTierTwoEligibility(video: TierTwoEligibilityInput): TierTwoEligibility {
  if (video.transcript.status !== "none") return "normal";
  const matched = video.ownedGameMatch === true || video.similarGameMatch === true || Boolean(video.matchedGame);
  return matched ? "promoted_no_transcript" : "demoted";
}

export type TranscriptRetryQueueEntry = {
  readonly videoId: string;
  readonly attempts: number;
  readonly nextAttemptAtIso: string;
  readonly status: "pending" | "exhausted";
};

// 재시도 backoff: 15분 * 2^(attempts-1), attempts는 MAX_TRANSCRIPT_RETRY_ATTEMPTS(5)로 캡.
export function transcriptRetryBackoffMs(attempts: number): number {
  const capped = Math.max(1, Math.min(attempts, MAX_TRANSCRIPT_RETRY_ATTEMPTS));
  return TRANSCRIPT_RETRY_BACKOFF_BASE_MS * (2 ** (capped - 1));
}

// 재시도 큐 항목 계산(순수함수, Firestore I/O 없음) — 호출부(feedWorker.ts/워커)가 반환값을 그대로 문서에 저장.
export function enqueueTranscriptRetry(
  videoId: string,
  attempts: number,
  nowIso: string = new Date().toISOString(),
): TranscriptRetryQueueEntry {
  const cappedAttempts = Math.min(Math.max(1, Math.trunc(attempts) || 1), MAX_TRANSCRIPT_RETRY_ATTEMPTS);
  const exhausted = cappedAttempts >= MAX_TRANSCRIPT_RETRY_ATTEMPTS;
  const nextAttemptAtIso = exhausted
    ? nowIso
    : new Date(Date.parse(nowIso) + transcriptRetryBackoffMs(cappedAttempts)).toISOString();
  return {
    videoId,
    attempts: cappedAttempts,
    nextAttemptAtIso,
    status: exhausted ? "exhausted" : "pending",
  };
}
