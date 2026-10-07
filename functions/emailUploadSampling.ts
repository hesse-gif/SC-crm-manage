/**
 * email-digging / 업로드 설명 샘플링 (2026-10-03, 헤세 결정: YouTube 일일 상한 5,000유닛).
 *
 * ■ 무엇
 *   이메일이 없는 후보 채널의 **최근 업로드 N개 영상 설명란**에서 비즈니스 이메일을 찾는다. 공식 YouTube Data API 만 쓴다:
 *     channels.list(contentDetails, 최대 50채널/콜) → uploads 재생목록 id
 *     playlistItems.list(채널당 1콜, 최근 N개)       → videoId
 *     videos.list(snippet, 최대 50영상/콜)           → 설명란
 *   (W84 실측: 업로드 50개 펼치기 ≈ 1.7%/채널 — 비싼 경로라 일일 상한·시도 마커로 묶는다.)
 *
 * ■ 쿼터 (발굴과 같은 풀 회계 + 이 레인 전용 상한)
 *   · 모든 호출은 발굴 레인의 `fetchYouTubeRecord` 를 지난다 — 같은 키 풀·PT 일자 문서(api_usage/youtube_pt_*)·시도/성공
 *     계측·주 키 추적 예약분 가드를 그대로 쓴다. 이 레인이 새 회계 경로를 만들지 않는다.
 *   · 그 위에 **레인 전용 일일 상한**(PT 일자, `email_digging_quota/<일자>`)을 **HTTP 시도 하나하나 앞에서 예약**한다
 *     (`fetchYouTubeRecord` 의 `reserve` 훅 — 키 회전·차용 재시도도 각각 센다. 구글은 실패한 요청에도 쿼터를 매긴다). 상한은 설정
 *     `settings.automation.emailUploadSampling.dailyUnitCap`(기본 5,000, **0 이면 꺼짐**)이며 콜러블·스케줄이 같은 원장을 쓴다.
 *   · 상한/일일 소진에 닿으면 즉시 멈춘다. 일시 오류(5xx 등)는 시도 표시를 남기지 않고 다음 실행이 다시 본다.
 *
 * ■ 안전
 *   · 설명란 이메일은 제3자(음악·스폰서·편집자) 주소가 섞인다 — **2개 이상 영상에 반복**되거나 비즈니스 키워드(business·
 *     collab·contact…)가 있는 주소만 후보로 올리고, 단발 비-비즈니스 주소는 거부한다(single_non_business).
 *   · 검증은 기존 그대로: 문법·역할계정·억제·중복·MX(+플레이스홀더/no-reply). 설명이 5,000자 상한이면 절단본으로 본다.
 *   · 메일을 보내지 않는다. 후보 문서는 update 만(신규 생성 없음), 쓰기는 트랜잭션으로 "아직 없을 때만".
 *   · dryRun 기본. dryRun 도 API 호출은 하므로 **유닛을 쓴다**(원장·감사에 기록) — 쓰기만 없다.
 *   · SEC-P0-009: 감사·로그에 이메일/설명 원문 없음(건수·유닛·사유 코드만).
 */
import { createHash } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { reserveStagingYoutubeApiUnits, youtubeQuotaDayKey, youtubeUnitCost } from "./apiQuota";
import { extractEmailsBoundarySafe, extractEmailsForDiscovery, fetchYouTubeRecord, isBusinessEmail } from "./discovery";
import { createEmailSourceGate, filterByEmailSource, type SourceGateReason } from "./emailSourceGate";
import { readSettings } from "./settings";
import { actorUidHash } from "./autoReplyBacklog";
import {
  BudgetExhausted,
  classifyEmailLine,
  defaultEmailValidationDeps,
  firestoreEmailDiggingStore,
  firstValid,
  isEmailDiggingEligible,
  type DigBudget,
  type DiggedEmailRejection,
  type EmailDiggingFoundWrite,
  type EmailDiggingRow,
  type EmailDiggingStore,
  type EmailValidationDeps,
} from "./emailDigging";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  makeDeniedBehaviorLog,
  type CallableRequestShape,
} from "./shared";

export const UPLOAD_SAMPLING_VERSION = 1;
export const UPLOAD_SAMPLING_QUOTA_COLLECTION = "email_digging_quota";
const AUDIT_ACTION = "email_digging.upload_sampling";
const RUNS_COLLECTION = "email_digging_runs";

export const UPLOAD_SAMPLING_LIMITS = Object.freeze({
  defaultDailyUnitCap: 5_000,
  // 0.6.110 integration review (Codex): operator decision = hard 5,000 YouTube units/day ceiling for this lane
  // (not the 10,000 project default). Every config parse and execution path clamps to this value.
  maxDailyUnitCap: 5_000,
  defaultVideosPerChannel: 5,
  maxVideosPerChannel: 10,
  channelBatch: 50,
  defaultChannelsPerRun: 250,
  maxChannelsPerRun: 500,
  /** 확정 음성(영상을 봤는데 이메일 없음) 재시도 간격 — 새 업로드가 쌓일 시간. */
  retryAfterMs: 60 * 24 * 60 * 60 * 1000,
  scanPageSize: 300,
  maxScanPages: 8,
  deadlineMs: 240_000,
  leaseMs: 360_000,
});

/** channels.list 1 + playlistItems 1 + videos.list 1 — 한 채널이라도 끝내는 데 필요한 최소 유닛. */
const MIN_COMPLETE_UNITS = 3;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_DESCRIPTION_CAP = 5_000;

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

export type UploadSamplingConfig = {
  readonly enabled: boolean;
  readonly dailyUnitCap: number;
  readonly videosPerChannel: number;
  readonly channelsPerRun: number;
  readonly programId: string;
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/** `settings.automation.emailUploadSampling` 해석(순수). 기본은 **꺼짐**이고 상한 0 도 꺼짐이다. */
export function uploadSamplingConfigFromSettings(automation: unknown): UploadSamplingConfig {
  const raw = asRecord(asRecord(automation).emailUploadSampling);
  const dailyUnitCap = clampInt(raw.dailyUnitCap, UPLOAD_SAMPLING_LIMITS.defaultDailyUnitCap, 0, UPLOAD_SAMPLING_LIMITS.maxDailyUnitCap);
  const programId = asString(raw.programId, "").trim();
  return {
    enabled: raw.enabled === true && dailyUnitCap > 0 && /^[A-Za-z0-9_.-]{1,120}$/.test(programId),
    dailyUnitCap,
    videosPerChannel: clampInt(raw.videosPerChannel, UPLOAD_SAMPLING_LIMITS.defaultVideosPerChannel, 1, UPLOAD_SAMPLING_LIMITS.maxVideosPerChannel),
    channelsPerRun: clampInt(raw.channelsPerRun, UPLOAD_SAMPLING_LIMITS.defaultChannelsPerRun, 1, UPLOAD_SAMPLING_LIMITS.maxChannelsPerRun),
    programId,
  };
}

// ---------------------------------------------------------------------------
// YouTube 클라이언트 (발굴 레인의 fetchYouTubeRecord 위)
// ---------------------------------------------------------------------------

export type SamplingErrorKind = "not_found" | "quota" | "transient";

export class UploadSamplingApiError extends Error {
  constructor(readonly kind: SamplingErrorKind, message: string) {
    super(message);
  }
}

/** HTTP 시도 하나 앞에서 호출된다. 레인 상한/마감이면 `StopRun` 을 던진다(호출은 나가지 않는다). */
export type UploadSamplingReserve = (operation: "channels" | "playlistItems" | "videos") => Promise<void>;

export type UploadSamplingYoutube = {
  /** channelId → uploads 재생목록 id. 응답에 없는 채널(삭제/비공개)은 맵에 없다. */
  channelUploads(channelIds: readonly string[], reserve: UploadSamplingReserve): Promise<Map<string, string>>;
  playlistVideoIds(playlistId: string, max: number, reserve: UploadSamplingReserve): Promise<string[]>;
  videoDescriptions(videoIds: readonly string[], reserve: UploadSamplingReserve): Promise<Map<string, string>>;
};

function classifyYoutubeError(error: unknown): UploadSamplingApiError {
  const record = error as { message?: unknown; errorCode?: unknown; dailyQuotaExhausted?: unknown; quotaLimited?: unknown } | null;
  const message = typeof record?.message === "string" ? record.message : "";
  const errorCode = typeof record?.errorCode === "string" ? record.errorCode : "";
  if (record?.dailyQuotaExhausted === true || record?.quotaLimited === true || /quota/i.test(errorCode)) {
    return new UploadSamplingApiError("quota", "youtube quota exhausted");
  }
  const status = Number(/\((\d{3})\)\s*$/.exec(message)?.[1] ?? 0);
  if (status === 404) return new UploadSamplingApiError("not_found", "youtube resource not found");
  return new UploadSamplingApiError("transient", `youtube transient failure${status ? ` (${status})` : ""}`);
}

export function defaultUploadSamplingYoutube(): UploadSamplingYoutube {
  // 발굴과 같은 풀·같은 계측(`lane: "discovery"`) — 이 레인이 새 회계 경로를 만들지 않는다.
  const keyState = { index: 0, lane: "discovery" as const };
  const call = async (
    path: "channels" | "playlistItems" | "videos",
    params: Record<string, string>,
    label: string,
    reserve: UploadSamplingReserve,
  ): Promise<Record<string, unknown>> => {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    try {
      return await fetchYouTubeRecord(url, label, keyState, {
        // 스테이징 안전 예약(기존) → 레인 상한 예약. **시도마다** 불린다(키 회전·차용 재시도 포함).
        reserve: async (operation) => {
          await reserveStagingYoutubeApiUnits(operation);
          await reserve(path);
        },
        fetch: (input, init) => fetch(input, init),
      });
    } catch (error) {
      if (error instanceof StopRun) throw error;
      throw classifyYoutubeError(error);
    }
  };
  const items = (response: Record<string, unknown>): Record<string, unknown>[] =>
    Array.isArray(response.items) ? response.items.map(asRecord) : [];
  return {
    async channelUploads(channelIds, reserve) {
      const response = await call("channels", { part: "contentDetails", id: channelIds.join(","), maxResults: "50" }, "YouTube uploads lookup failed", reserve);
      const out = new Map<string, string>();
      for (const item of items(response)) {
        const id = asString(item.id) ?? "";
        const uploads = asString(asRecord(asRecord(item.contentDetails).relatedPlaylists).uploads) ?? "";
        if (CHANNEL_ID_PATTERN.test(id) && uploads) out.set(id, uploads);
      }
      return out;
    },
    async playlistVideoIds(playlistId, max, reserve) {
      const response = await call("playlistItems", { part: "contentDetails", playlistId, maxResults: String(max) }, "YouTube uploads playlist read failed", reserve);
      return items(response)
        .map((item) => asString(asRecord(item.contentDetails).videoId) ?? "")
        .filter((id) => VIDEO_ID_PATTERN.test(id));
    },
    async videoDescriptions(videoIds, reserve) {
      const response = await call("videos", { part: "snippet", id: videoIds.join(","), maxResults: "50" }, "YouTube upload description lookup failed", reserve);
      const out = new Map<string, string>();
      for (const item of items(response)) {
        const id = asString(item.id) ?? "";
        const description = asString(asRecord(item.snippet).description) ?? "";
        if (VIDEO_ID_PATTERN.test(id)) out.set(id, description);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// 레인 전용 일일 유닛 원장
// ---------------------------------------------------------------------------

export type UploadSamplingMeter = {
  /** 호출 **전에** n 유닛을 예약한다. 상한을 넘기면 false(아무것도 늘리지 않는다). */
  reserve(units: number, cap: number): Promise<boolean>;
  /** 오늘 남은 유닛(cap - 사용). 묶음 크기를 정하는 데만 쓴다 — 판정은 항상 reserve 가 한다. */
  remaining(cap: number): Promise<number>;
};

export function firestoreUploadSamplingMeter(now: () => Date = () => new Date()): UploadSamplingMeter {
  return {
    async remaining(cap) {
      const snap = await adminDb.collection(UPLOAD_SAMPLING_QUOTA_COLLECTION).doc(youtubeQuotaDayKey(now())).get();
      return Math.max(0, cap - (snap.exists ? Number(snap.get("units")) || 0 : 0));
    },
    async reserve(units, cap) {
      const ref = adminDb.collection(UPLOAD_SAMPLING_QUOTA_COLLECTION).doc(youtubeQuotaDayKey(now()));
      return adminDb.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const used = snap.exists ? Number(snap.get("units")) || 0 : 0;
        if (used + units > cap) return false;
        tx.set(ref, { units: used + units, updatedAtIso: now().toISOString(), cap }, { merge: true });
        return true;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 순수 판정
// ---------------------------------------------------------------------------

export type SampleVideo = { readonly videoId: string; readonly description: string };

/**
 * 채널의 샘플 영상들에서 이메일 후보를 고른다(순수). **귀속 증거**가 필요하다: 주소가 있는 줄(또는 바로 앞줄)에
 * 크리에이터 연락 단서(business·contact·collab·문의…)가 있고, 같은 줄에 제3자 크레딧 단서(music by·edit by·sponsored by…)가
 * 없어야 한다. 주소 문자열 안의 키워드나 영상 간 반복만으로는 후보가 아니다(편집자·음악·스폰서 주소가 반복되기 때문).
 * 반환은 우선순위 순(비즈니스 키워드 주소 → 근거 영상 수 많은 순)이다.
 */
export function pickSampleEmailCandidates(videos: readonly SampleVideo[]): { candidates: string[]; unattributed: number; skippedDescriptions: number; sourceGateRejected: Record<SourceGateReason, number>; thirdPartyRejected: number; strictModeRejected: number } {
  let thirdPartyRejected = 0;
  let strictModeRejected = 0;
  const sourceGateRejected: Record<SourceGateReason, number> = { absent: 0, left_boundary: 0, right_continuation: 0 };
  const evidence = new Map<string, Set<string>>();
  const seenAny = new Set<string>();
  let skippedDescriptions = 0;
  for (const video of videos) {
    // 설명 상한(5,000자)에 닿으면 절단본이다 — 그 영상의 설명란은 건너뛴다(잘린 도메인을 믿지 않는다). 건너뛴 사실은
    // 호출부로 전달한다: 검사하지 않은 설명이 있으면 "이메일 없음"을 확정할 수 없다.
    if (video.description.length >= YOUTUBE_DESCRIPTION_CAP) { skippedDescriptions += 1; continue; }
    const lines = video.description.split(/\r?\n/);
    // 출처 경계는 설명 **전체**에서 판정한다(`\n[dot]vn` 처럼 줄 밖으로 이어지는 꼬리 포함) — 줄 단위 결과는 이 집합에 있을 때만 채택.
    const allowed = new Set(extractEmailsBoundarySafe(video.description));
    // 쓰기 게이트(공용): 최종 주소가 전체 정규화 원문에 독립 토큰으로 실재해야 한다.
    const gate = createEmailSourceGate(video.description);
    lines.forEach((line, index) => {
      const safeLine = extractEmailsBoundarySafe(line);
      for (const email of extractEmailsForDiscovery(line)) if (!safeLine.includes(email)) sourceGateRejected.right_continuation += 1;
      const emails = filterByEmailSource(safeLine.filter((email) => allowed.has(email)), gate, (reason) => { sourceGateRejected[reason] += 1; });
      if (emails.length === 0) return;
      // 귀속 판정(연락 단서·제3자 크레딧)은 설명란 재파싱과 같은 공용 헬퍼(emailDigging.classifyEmailLine)를 쓴다.
      const { contactCue, thirdParty, strictRejected } = classifyEmailLine(lines, index);
      if (thirdParty) { thirdPartyRejected += emails.length; if (strictRejected) strictModeRejected += emails.length; }
      const attributed = contactCue && !thirdParty;
      for (const email of emails) {
        seenAny.add(email);
        if (!attributed) continue;
        const set = evidence.get(email) ?? new Set<string>();
        set.add(video.videoId);
        evidence.set(email, set);
      }
    });
  }
  const ranked = [...evidence.entries()]
    .map(([email, ids]) => ({ email, count: ids.size, business: isBusinessEmail(email) }))
    .sort((x, y) => Number(y.business) - Number(x.business) || y.count - x.count);
  return { candidates: ranked.map((entry) => entry.email), unattributed: [...seenAny].filter((email) => !evidence.has(email)).length, skippedDescriptions, sourceGateRejected, thirdPartyRejected, strictModeRejected };
}

// ---------------------------------------------------------------------------
// 실행 코어
// ---------------------------------------------------------------------------

export type UploadSamplingStore = Pick<
  EmailDiggingStore,
  "readState" | "acquireLease" | "releaseLease" | "scanPage" | "applyFound" | "markAttempt" | "writeAudit"
>;

export type UploadSamplingInput = {
  readonly programId: string;
  readonly dryRun: boolean;
  readonly dailyUnitCap: number;
  readonly videosPerChannel: number;
  readonly channelsPerRun: number;
  readonly cursor: string | null;
  readonly runId: string;
  readonly auditActor: Record<string, unknown>;
};

export type UploadSamplingDeps = {
  readonly store: UploadSamplingStore;
  readonly youtube: UploadSamplingYoutube;
  readonly meter: UploadSamplingMeter;
  readonly validation: EmailValidationDeps;
  readonly now?: () => number;
};

export type UploadSamplingCounters = {
  scanned: number;
  eligible: number;
  channelsExamined: number;
  found: number;
  skippedAlreadyFilled: number;
  negativeMarked: number;
  channelMissing: number;
  noUploads: number;
  transient: number;
  unattributed: number;
  /** 유효 주소가 행당 검증 상한을 넘어 일부를 못 본 채널 수(음성 마커를 남기지 않는다). */
  incomplete: number;
  /** 쓰기 게이트 거부 수 — 사유별. */
  sourceGateRejected: Record<SourceGateReason, number>;
  /** 제3자/크레딧 판정으로 귀속에서 뺀 주소 수와 그중 엄격 모드 몫. */
  thirdPartyRejected: number;
  strictModeRejected: number;
  rejected: Record<DiggedEmailRejection, number>;
  validations: number;
  calls: { channels: number; playlistItems: number; videos: number };
  units: number;
};

export type UploadSamplingResult = {
  readonly ok: true;
  readonly runId: string;
  readonly programId: string;
  readonly dryRun: boolean;
  readonly counters: UploadSamplingCounters;
  readonly nextCursor: string | null;
  readonly completed: boolean;
  readonly stoppedBy: "end_of_collection" | "channel_limit" | "unit_cap" | "quota_exhausted" | "deadline" | "dependency_unavailable" | "scan_pages";
  readonly costLog: { readonly provider: "youtube-data-api"; readonly model: "email-upload-sampling"; readonly units: number; readonly estimatedUsd: 0 };
};

function emptyCounters(): UploadSamplingCounters {
  return {
    scanned: 0, eligible: 0, channelsExamined: 0, found: 0, skippedAlreadyFilled: 0, negativeMarked: 0, channelMissing: 0,
    noUploads: 0, transient: 0, unattributed: 0, incomplete: 0,
    sourceGateRejected: { absent: 0, left_boundary: 0, right_continuation: 0 },
    thirdPartyRejected: 0,
    strictModeRejected: 0,
    rejected: { invalid: 0, role_account: 0, suppressed: 0, no_mx: 0, duplicate: 0 },
    validations: 0, calls: { channels: 0, playlistItems: 0, videos: 0 }, units: 0,
  };
}

class StopRun extends Error {
  constructor(readonly reason: UploadSamplingResult["stoppedBy"]) {
    super(`upload sampling stop: ${reason}`);
  }
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 32);

export async function runUploadSampling(input: UploadSamplingInput, deps: UploadSamplingDeps): Promise<UploadSamplingResult> {
  const clock = deps.now ?? Date.now;
  const startedMs = clock();
  const startedIso = new Date(startedMs).toISOString();
  const counters = emptyCounters();
  const channelsPerRun = clampInt(input.channelsPerRun, UPLOAD_SAMPLING_LIMITS.defaultChannelsPerRun, 1, UPLOAD_SAMPLING_LIMITS.maxChannelsPerRun);
  const videosPerChannel = clampInt(input.videosPerChannel, UPLOAD_SAMPLING_LIMITS.defaultVideosPerChannel, 1, UPLOAD_SAMPLING_LIMITS.maxVideosPerChannel);
  const cap = clampInt(input.dailyUnitCap, 0, 0, UPLOAD_SAMPLING_LIMITS.maxDailyUnitCap);
  if (cap <= 0) throw Object.assign(new Error("failed-precondition: upload sampling is off (dailyUnitCap = 0)"), { code: "failed-precondition", errorCode: "email_upload_sampling_off" });

  if (!input.dryRun) {
    const leased = await deps.store.acquireLease(input.programId, input.runId, startedMs, UPLOAD_SAMPLING_LIMITS.leaseMs);
    if (!leased) throw Object.assign(new Error("failed-precondition: another upload-sampling run holds the lease"), { code: "failed-precondition", errorCode: "email_upload_sampling_lease_held" });
  }

  let cursor: string | null = input.cursor;
  let cursorBefore: string | null = input.cursor;
  let cursorKnown = input.cursor !== null || input.dryRun;
  let completed = false;
  let stoppedBy: UploadSamplingResult["stoppedBy"] = "scan_pages";
  const budget: DigBudget = { startedMs, clock, validations: 0 };

  /** HTTP **시도 하나** 앞에서 불린다(youtube 클라이언트의 reserve 훅). 상한·마감이면 호출은 나가지 않는다. */
  const reserve: UploadSamplingReserve = async (operation) => {
    if (clock() - startedMs > UPLOAD_SAMPLING_LIMITS.deadlineMs) throw new StopRun("deadline");
    const units = youtubeUnitCost(operation);
    if (!(await deps.meter.reserve(units, cap))) throw new StopRun("unit_cap");
    counters.units += units;
    if (operation === "channels") counters.calls.channels += 1;
    else if (operation === "playlistItems") counters.calls.playlistItems += 1;
    else counters.calls.videos += 1;
  };

  /** API 호출을 감싼다: quota 는 실행 중단, 그 외 오류는 호출부가 처리하도록 다시 던진다. */
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof UploadSamplingApiError && error.kind === "quota") throw new StopRun("quota_exhausted");
      throw error;
    }
  };

  // 한 videos.list 페이지(50개)에 들어가는 채널 수 — 이 크기의 **완결된 묶음**(재생목록들 → 설명 → 판정·표시)으로 처리해
  // 작은 상한에서도 묶음마다 진행(표시·커서)이 남는다. 모든 재생목록을 먼저 읽고 상한에 걸려 아무것도 못 끝내는 일이 없다.
  const chunkSize = Math.max(1, Math.floor(50 / videosPerChannel));

  const processBatch = async (batch: EmailDiggingRow[]): Promise<void> => {
    const rowsByChannel = new Map<string, EmailDiggingRow[]>();
    for (const row of batch) rowsByChannel.set(row.candidateId, [...(rowsByChannel.get(row.candidateId) ?? []), row]);
    const channelIds = [...rowsByChannel.keys()];
    // 커서는 **연속으로 끝난** 지점까지만 전진한다: 아직 끝나지 않은 첫 채널의 첫 행 바로 앞. 확정/미결(일시 오류·불완전)
    // 모두 "끝남"이다 — 미결 채널은 표시 없이 지나가 다음 전체 주기에 다시 보이지만, 같은 채널이 매일 머리를 막지는 않는다.
    const doneChannels = new Set<string>();
    const progress = () => {
      const firstOpen = batch.findIndex((row) => !doneChannels.has(row.candidateId));
      if (firstOpen === -1) cursor = batch[batch.length - 1]?.docId ?? cursor;
      else if (firstOpen > 0) cursor = batch[firstOpen - 1].docId;
    };
    const markNegative = async (channelId: string, kind: "gone" | "none") => {
      counters.negativeMarked += 1;
      if (kind === "gone") counters.channelMissing += 1;
      if (!input.dryRun) for (const row of rowsByChannel.get(channelId) ?? []) await deps.store.markAttempt(row.docId, startedIso);
    };

    // 완결된 최소 묶음(channels 1 + playlistItems 1 + videos 1)을 못 끝낼 만큼 남았다면 **쓰기 전에** 멈춘다 —
    // 작은 상한이 매일 같은 유닛을 태우고 아무것도 못 끝내는 일이 없다.
    if ((await deps.meter.remaining(cap)) < MIN_COMPLETE_UNITS) throw new StopRun("unit_cap");
    let uploads: Map<string, string>;
    try {
      uploads = await guarded(() => deps.youtube.channelUploads(channelIds, reserve));
    } catch (error) {
      if (error instanceof StopRun) throw error;
      counters.transient += channelIds.length; // 일시 오류 — 표시 없이 다음 실행이 다시 본다
      for (const id of channelIds) doneChannels.add(id);
      progress();
      return;
    }
    counters.channelsExamined += channelIds.length;

    for (let offset = 0; offset < channelIds.length;) {
      // 묶음 크기: 남은 유닛으로 **끝낼 수 있는** 만큼만(채널당 playlistItems 1 + videos 페이지 1). 최소 1채널.
      const remaining = await deps.meter.remaining(cap);
      if (remaining < 2) throw new StopRun("unit_cap");
      const size = Math.max(1, Math.min(chunkSize, remaining - 1));
      const chunk = channelIds.slice(offset, offset + size);
      offset += size;
      const videoIdsByChannel = new Map<string, string[]>();
      for (const channelId of chunk) {
        const playlist = uploads.get(channelId);
        if (!playlist) { await markNegative(channelId, "gone"); continue; }
        try {
          const ids = await guarded(() => deps.youtube.playlistVideoIds(playlist, videosPerChannel, reserve));
          if (ids.length === 0) { counters.noUploads += 1; await markNegative(channelId, "none"); continue; }
          videoIdsByChannel.set(channelId, ids.slice(0, videosPerChannel));
        } catch (error) {
          if (error instanceof StopRun) throw error;
          if (error instanceof UploadSamplingApiError && error.kind === "not_found") { await markNegative(channelId, "gone"); continue; }
          counters.transient += 1;
        }
      }

      const allVideoIds = [...new Set([...videoIdsByChannel.values()].flat())];
      const settle = () => { for (const id of chunk) doneChannels.add(id); progress(); };
      const descriptions = new Map<string, string>();
      const failedVideos = new Set<string>();
      for (let index = 0; index < allVideoIds.length; index += 50) {
        const page = allVideoIds.slice(index, index + 50);
        try {
          for (const [id, description] of await guarded(() => deps.youtube.videoDescriptions(page, reserve))) descriptions.set(id, description);
        } catch (error) {
          if (error instanceof StopRun) throw error;
          for (const id of page) failedVideos.add(id);
        }
      }

      for (const [channelId, ids] of videoIdsByChannel) {
        if (ids.some((id) => failedVideos.has(id))) { counters.transient += 1; continue; } // 페이지 실패 — 표시 없이 재시도
        const videos = ids.map((videoId) => ({ videoId, description: descriptions.get(videoId) ?? "" }));
        const { candidates, unattributed, skippedDescriptions, sourceGateRejected, thirdPartyRejected, strictModeRejected } = pickSampleEmailCandidates(videos);
        counters.thirdPartyRejected += thirdPartyRejected;
        counters.strictModeRejected += strictModeRejected;
        counters.unattributed += unattributed;
        for (const reason of Object.keys(sourceGateRejected) as SourceGateReason[]) counters.sourceGateRejected[reason] += sourceGateRejected[reason];
        const rows = rowsByChannel.get(channelId) ?? [];
        const first = rows[0];
        const picked = first
          ? await firstValid(candidates, first, deps, counters, budget).catch((error) => {
            if (error instanceof BudgetExhausted) throw new StopRun("deadline");
            throw error;
          })
          : { email: null, resolverDown: false, retryLater: false, incomplete: false };
        counters.validations = budget.validations;
        if (picked.resolverDown) throw new StopRun("dependency_unavailable");
        if (picked.retryLater) { counters.transient += 1; continue; }
        if (!picked.email) {
          // 검증이 상한에서 끝났다면(완전 소진이 아니다) 음성으로 굳히지 않는다.
          // 건너뛴(절단본) 설명이 있었다면 "없음"을 확정할 수 없다 — 같은 규칙으로 표시하지 않는다.
          if (picked.incomplete || skippedDescriptions > 0) { counters.incomplete += 1; continue; }
          await markNegative(channelId, "none");
          continue;
        }
        const email = picked.email;
        if (input.dryRun) { counters.found += 1; continue; }
        let appliedAny = false;
        for (const row of rows) {
          const write: EmailDiggingFoundWrite = {
            docId: row.docId, candidateId: row.candidateId, email,
            // 소유 증명이 없는 주소다 — 이 레인은 비즈니스 키워드가 있어도 verified 로 올리지 않는다.
            emailStatus: "guessed",
            emailSource: "upload_description_sample", emailSourceKind: "upload_description_sample", sourceHost: null, donorOrigin: null,
          };
          if (await deps.store.applyFound(write, startedIso, input.runId)) appliedAny = true;
          else counters.skippedAlreadyFilled += 1;
        }
        if (appliedAny) counters.found += 1;
      }
      settle();
    }
  };

  try {
    if (cursor === null && !input.dryRun) cursor = (await deps.store.readState(input.programId)).cursor;
    cursorKnown = true;
    cursorBefore = cursor;
    let pending: EmailDiggingRow[] = [];
    let lastProcessedDocId: string | null = cursor;
    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      await processBatch(batch);
    };
    scan: for (let page = 0; page < UPLOAD_SAMPLING_LIMITS.maxScanPages; page += 1) {
      const scanned = await deps.store.scanPage(input.programId, cursor, UPLOAD_SAMPLING_LIMITS.scanPageSize);
      if (scanned.rawCount === 0) { completed = true; stoppedBy = "end_of_collection"; break; }
      for (const row of scanned.rows) {
        counters.scanned += 1;
        const eligibility = isEmailDiggingEligible(row, clock(), UPLOAD_SAMPLING_VERSION, UPLOAD_SAMPLING_LIMITS.retryAfterMs);
        if (eligibility === "eligible" && CHANNEL_ID_PATTERN.test(row.candidateId)) {
          if (counters.eligible >= channelsPerRun) { stoppedBy = "channel_limit"; await flush(); cursor = lastProcessedDocId; break scan; }
          counters.eligible += 1;
          pending.push(row);
          if (new Set(pending.map((item) => item.candidateId)).size >= UPLOAD_SAMPLING_LIMITS.channelBatch) {
            await flush();
          }
        }
        lastProcessedDocId = row.docId;
        // 커서는 **배치가 처리된 뒤**에만 전진한다(대기 중인 행 앞에서 멈추면 그 행은 다음 실행이 다시 본다).
        if (pending.length === 0) cursor = lastProcessedDocId;
      }
      await flush();
      cursor = scanned.lastDocId ?? cursor;
      if (scanned.rawCount < UPLOAD_SAMPLING_LIMITS.scanPageSize) { completed = true; stoppedBy = "end_of_collection"; break; }
    }
  } catch (error) {
    if (!(error instanceof StopRun)) {
      try { await finalize(); } catch { /* 감사 실패가 원래 오류를 가리지 않는다 */ }
      throw error;
    }
    stoppedBy = error.reason;
  }
  await finalize();
  return {
    ok: true,
    runId: input.runId,
    programId: input.programId,
    dryRun: input.dryRun,
    counters,
    nextCursor: completed ? null : cursor,
    completed,
    stoppedBy,
    costLog: { provider: "youtube-data-api", model: "email-upload-sampling", units: counters.units, estimatedUsd: 0 },
  };

  async function finalize(): Promise<void> {
    const nextCursor = completed ? null : cursor;
    try {
      await deps.store.writeAudit(input.runId, {
        ...input.auditActor,
        lane: "upload_sampling",
        runId: input.runId,
        programId: input.programId,
        version: UPLOAD_SAMPLING_VERSION,
        dryRun: input.dryRun,
        dailyUnitCap: cap,
        videosPerChannel,
        startedAtIso: startedIso,
        finishedAtIso: new Date(clock()).toISOString(),
        cursorBefore,
        cursorAfter: nextCursor,
        completed,
        stoppedBy,
        counters,
        costLog: { provider: "youtube-data-api", units: counters.units, estimatedUsd: 0 },
      });
    } finally {
      if (!input.dryRun) {
        await deps.store.releaseLease(input.programId, input.runId, { cursor: cursorKnown ? nextCursor : undefined, completed, nowIso: new Date(clock()).toISOString() });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 기본 의존성 / callable / 스케줄
// ---------------------------------------------------------------------------

export function firestoreUploadSamplingStore(): UploadSamplingStore {
  return firestoreEmailDiggingStore({ markerPrefix: "emailUploadSample", version: UPLOAD_SAMPLING_VERSION, stateNamespace: "upload:" });
}

function invalidArgument(message: string, errorCode: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode });
}

export type UploadSamplingCallableDeps = Partial<UploadSamplingDeps> & {
  readonly config?: UploadSamplingConfig;
  readonly runId?: string;
};

export async function emailUploadSamplingBackfill(request: CallableRequestShape, deps: UploadSamplingCallableDeps = {}) {
  const auth = assertNonGuestAuth(request, AUDIT_ACTION, ["super_admin"]);
  const data = asRecord(request.data);
  if ((typeof data.viewAsUserId === "string" && data.viewAsUserId.trim()) || (typeof data.viewAsEmail === "string" && data.viewAsEmail.trim())) {
    throw Object.assign(new Error("permission-denied: this console does not support viewAs preview"), {
      code: "permission-denied", errorCode: "email_upload_sampling_view_as_unsupported",
      behaviorLog: makeDeniedBehaviorLog(request, AUDIT_ACTION, auth.gameId),
    });
  }
  const programId = asString(data.programId, "").trim();
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(programId)) throw invalidArgument("programId is required", "email_upload_sampling_program_invalid");
  if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") throw invalidArgument("dryRun must be a boolean", "email_upload_sampling_dry_run_invalid");
  const dryRun = data.dryRun !== false;
  const config = deps.config ?? uploadSamplingConfigFromSettings((await readSettings()).automation);
  // 상한은 설정이 정본이다 — 호출 파라미터로는 올릴 수 없고(내릴 수만), 0 이면 콜러블도 꺼진다.
  const requestedCap = clampInt(data.dailyUnitCap, config.dailyUnitCap, 0, config.dailyUnitCap);
  const cursor = typeof data.cursor === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(data.cursor) ? data.cursor : null;
  const runId = deps.runId ?? `eups_${Date.now().toString(36)}_${sha(`${auth.userId}:${Math.random()}`).slice(0, 8)}`;
  const result = await runUploadSampling(
    {
      programId, dryRun,
      dailyUnitCap: requestedCap,
      videosPerChannel: clampInt(data.videosPerChannel, config.videosPerChannel, 1, UPLOAD_SAMPLING_LIMITS.maxVideosPerChannel),
      channelsPerRun: clampInt(data.channelsPerRun, Math.min(config.channelsPerRun, 100), 1, UPLOAD_SAMPLING_LIMITS.maxChannelsPerRun),
      cursor, runId,
      auditActor: { action: AUDIT_ACTION, actorUidHash: actorUidHash(auth.userId), actorRole: auth.role },
    },
    {
      store: deps.store ?? firestoreUploadSamplingStore(),
      youtube: deps.youtube ?? defaultUploadSamplingYoutube(),
      meter: deps.meter ?? firestoreUploadSamplingMeter(),
      validation: deps.validation ?? defaultEmailValidationDeps(programId),
    },
  );
  return { ...result, behaviorLog: makeBehaviorLog(auth, AUDIT_ACTION, "success") };
}

export type UploadSamplingScheduleResult =
  | { status: "disabled" }
  | { status: "leased" }
  | { status: "completed"; stoppedBy: UploadSamplingResult["stoppedBy"]; found: number; units: number }
  | { status: "failed"; errorCode: string };

/** 스케줄 진입점 — 설정이 켜져 있을 때만 돈다(기본 꺼짐). 시스템 행위자, 항상 apply(dryRun=false). */
export async function runEmailUploadSamplingScheduled(
  deps: Partial<UploadSamplingDeps> & { readonly config?: UploadSamplingConfig } = {},
): Promise<UploadSamplingScheduleResult> {
  try {
    const config = deps.config ?? uploadSamplingConfigFromSettings((await readSettings()).automation);
    if (!config.enabled) return { status: "disabled" };
    const result = await runUploadSampling(
      {
        programId: config.programId, dryRun: false, dailyUnitCap: config.dailyUnitCap, videosPerChannel: config.videosPerChannel,
        channelsPerRun: config.channelsPerRun, cursor: null,
        runId: `eups_sched_${Date.now().toString(36)}_${sha(String(Math.random())).slice(0, 8)}`,
        auditActor: { action: AUDIT_ACTION, actor: "system:schedule", actorRole: "system" },
      },
      {
        store: deps.store ?? firestoreUploadSamplingStore(),
        youtube: deps.youtube ?? defaultUploadSamplingYoutube(),
        meter: deps.meter ?? firestoreUploadSamplingMeter(),
        validation: deps.validation ?? defaultEmailValidationDeps(config.programId),
      },
    );
    return { status: "completed", stoppedBy: result.stoppedBy, found: result.counters.found, units: result.counters.units };
  } catch (error) {
    const errorCode = (error as { errorCode?: unknown } | null)?.errorCode;
    if (errorCode === "email_upload_sampling_lease_held") return { status: "leased" };
    return { status: "failed", errorCode: typeof errorCode === "string" ? errorCode : "unknown" };
  }
}
