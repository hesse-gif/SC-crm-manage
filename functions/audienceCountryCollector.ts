// Flu — YouTube Analytics 국가 오디언스 수집기 (R4, 2026-07-27).
//
// 리뷰 판정: `scp_audience_country_channels` 에 reader 만 있고 **생산자가 없어** Studio 권위(B)가
// 영원히 채워지지 않는다. 이 모듈이 그 생산자다.
//
// 경계:
//  - 승인된 OAuth 경로만 쓴다. 매핑·암호화 credential 은 기존 `youtubeOAuthHandoff` 원장
//    (`youtube_oauth_mappings` + 저장된 credential envelope)에서 읽고, 요구 scope
//    (`youtube.readonly`, `yt-analytics.readonly`)는 그쪽이 이미 강제한다.
//  - 외부 호출은 **서버(Functions) 안에서만** 일어난다. 클라이언트 직접 호출 없음(NET-P0-012).
//    fetcher 는 주입 가능(테스트/드라이런) — 기본값은 YouTube Analytics reports API 다.
//  - secret/token 본문은 저장하지 않는다. current 문서에는 `credentialRef`(참조 문자열)만 남는다.
//  - 28 완결일 창(`resolveAudienceWindow`). 오늘(미완결일)은 창에 넣지 않는다.
//  - 실패는 조용히 넘어가지 않는다: 채널별 결과를 집계해 돌려주고, current 문서를 거짓 verified 로
//    올리지 않는다.

import {
  buildAudienceCountryObservation,
  resolveAudienceWindow,
  writeAudienceCountryObservation,
  type AudienceCountryCount,
  type AudienceWindow,
} from "./audienceCountryChannels";
import { createHash } from "node:crypto";
import {
  YOUTUBE_OAUTH_MAPPINGS_COLLECTION,
  YOUTUBE_OAUTH_REQUIRED_SCOPES,
  decryptYouTubeOAuthCredentialEnvelope,
  type YouTubeOAuthCredentialEnvelope,
} from "./youtubeOAuthHandoff";

const YOUTUBE_OAUTH_CREDENTIALS_COLLECTION = "youtube_oauth_credentials";
const AUDIENCE_COLLECTOR_STATE_COLLECTION = "video_view_monitor_state";
const AUDIENCE_COLLECTOR_STATE_DOC = "scan";

const YOUTUBE_ANALYTICS_ENDPOINT = "https://youtubeanalytics.googleapis.com/v2/reports";
const DEFAULT_CHANNEL_SCAN_LIMIT = 25;

export interface AudienceCollectorMapping {
  readonly fluCreatorId: string;
  readonly portalCreatorId: string;
  readonly partnerId: string;
  readonly programId: string;
  readonly enrollmentId: string;
  readonly channelId: string;
  readonly mappingHash: string;
  readonly credentialRef: string;
}

export interface AudienceAnalyticsFetchInput {
  readonly mapping: AudienceCollectorMapping;
  readonly window: AudienceWindow;
}

export interface AudienceAnalyticsFetchResult {
  readonly countries: readonly AudienceCountryCount[];
  /** 원천이 준 워터마크(예: 리포트 생성 시각/ETag). 관측 id 를 결정적으로 만드는 입력이다. */
  readonly sourceWatermark: string;
}

export type AudienceAnalyticsFetcher = (
  input: AudienceAnalyticsFetchInput,
  accessToken: string,
) => Promise<AudienceAnalyticsFetchResult | null>;

export interface CollectAudienceCountriesOptions {
  readonly db: FirebaseFirestore.Firestore;
  readonly nowIso: string;
  readonly limit?: number;
  /** 주입 가능한 수집기(기본값 = 승인된 OAuth 자격으로 YouTube Analytics 조회). */
  readonly analyticsFetcher?: AudienceAnalyticsFetcher;
  /**
   * 주입 가능한 접근 토큰 해석기(테스트/드라이런). 기본값은 정본 자격 검사를 모두 거치는
   * `resolveAudienceAccessToken` 이다.
   */
  readonly accessTokenResolver?: (
    mapping: AudienceCollectorMapping,
    nowIso: string,
  ) => Promise<AudienceAccessTokenResolution>;
}

export interface CollectAudienceCountriesResult {
  scanned: number;
  collected: number;
  duplicates: number;
  conflicts: number;
  skippedNoCredential: number;
  skippedNoData: number;
  failed: number;
  /** F2: 자격 거부 사유별 카운트. 조용한 0건 수집을 만들지 않는다. */
  credentialRejections: Record<string, number>;
  cycleComplete: boolean;
}

function text(value: unknown, max = 200): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "";
}

/**
 * 기본 fetcher: 승인된 OAuth access token 으로 country 차원 조회수를 읽는다.
 * 응답 파싱은 방어적이다 — 모양이 다르면 값을 지어내지 않고 null 을 돌려준다.
 */
export const defaultAudienceAnalyticsFetcher: AudienceAnalyticsFetcher = async (input, accessToken) => {
  const params = new URLSearchParams({
    ids: `channel==${input.mapping.channelId}`,
    startDate: input.window.startDate,
    endDate: input.window.endDate,
    metrics: "views",
    dimensions: "country",
    sort: "-views",
    maxResults: "50",
  });
  const response = await fetch(`${YOUTUBE_ANALYTICS_ENDPOINT}?${params.toString()}`, {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as Record<string, unknown>;
  const rows = Array.isArray(payload.rows) ? payload.rows : null;
  if (!rows) return null;
  const countries: AudienceCountryCount[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const countryCode = typeof row[0] === "string" ? row[0] : "";
    const views = typeof row[1] === "number" && Number.isFinite(row[1]) ? Math.max(0, Math.trunc(row[1])) : null;
    if (!countryCode || views === null) continue;
    countries.push({ countryCode, views: String(views) });
  }
  if (countries.length === 0) return null;
  return {
    countries,
    // 워터마크는 원천이 준 값만 쓴다. 없으면 창 자체가 워터마크다(같은 창 재수집은 같은 id).
    sourceWatermark: text(payload.kind, 80) || `${input.window.startDate}..${input.window.endDate}`,
  };
};

/**
 * 승인된 OAuth 매핑을 훑어 채널별 국가 분포를 수집하고 aggregate 에 적재한다.
 * 매핑 튜플(fluCreatorId + channelId)은 관측·current 양쪽에 그대로 실려 reader 가 대조한다.
 */
export async function collectAudienceCountryObservations(
  options: CollectAudienceCountriesOptions,
): Promise<CollectAudienceCountriesResult> {
  const { db, nowIso } = options;
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_CHANNEL_SCAN_LIMIT, 100));
  const fetcher = options.analyticsFetcher ?? defaultAudienceAnalyticsFetcher;
  const window = resolveAudienceWindow(nowIso);
  const result: CollectAudienceCountriesResult = {
    scanned: 0,
    collected: 0,
    duplicates: 0,
    conflicts: 0,
    skippedNoCredential: 0,
    skippedNoData: 0,
    failed: 0,
    credentialRejections: {},
    cycleComplete: false,
  };

  // F2(b): 문서 id 순 + 커서. 예전 코드는 orderBy·커서가 없어 상위 25개 매핑만 영구히 재수집했다.
  const stateRef = db.collection(AUDIENCE_COLLECTOR_STATE_COLLECTION).doc(AUDIENCE_COLLECTOR_STATE_DOC);
  const stateSnapshot = await stateRef.get();
  const cursorDocId = text((stateSnapshot.data() ?? {}).audienceCollectorCursorDocId, 400);
  let query = db.collection(YOUTUBE_OAUTH_MAPPINGS_COLLECTION).orderBy("__name__", "asc");
  if (cursorDocId) query = query.startAfter(cursorDocId);
  const snap = await query.limit(limit).get();
  const scannedDocs = snap.docs ?? [];
  const cycleComplete = scannedDocs.length < limit;
  result.cycleComplete = cycleComplete;
  for (const doc of scannedDocs) {
    const data = doc.data() ?? {};
    const mapping: AudienceCollectorMapping = {
      fluCreatorId: text(data.fluCreatorId),
      portalCreatorId: text(data.portalCreatorId),
      partnerId: text(data.partnerId),
      programId: text(data.programId),
      enrollmentId: text(data.enrollmentId),
      channelId: text(data.channelId),
      mappingHash: text(data.mappingHash, 80),
      // 참조만 남긴다 — 토큰 본문은 절대 여기로 들어오지 않는다.
      credentialRef: `${YOUTUBE_OAUTH_MAPPINGS_COLLECTION}/${doc.id}`,
    };
    if (!mapping.fluCreatorId || !mapping.channelId) continue;
    result.scanned += 1;

    try {
      const resolveAccessToken = options.accessTokenResolver ?? resolveAudienceAccessToken(db);
      const resolution = await resolveAccessToken(mapping, nowIso);
      if (!resolution.ok) {
        // 자격이 없으면 수집하지 않는다. 거짓 verified 로 올리지 않고, **사유를 세어** 돌려준다.
        result.skippedNoCredential += 1;
        result.credentialRejections[resolution.reason] = (result.credentialRejections[resolution.reason] ?? 0) + 1;
        console.warn("[audience-country-collector] credential_rejected", JSON.stringify({
          channelId: mapping.channelId,
          reason: resolution.reason,
        }));
        continue;
      }
      const fetched = await fetcher({ mapping, window }, resolution.accessToken);
      if (!fetched || fetched.countries.length === 0) {
        result.skippedNoData += 1;
        continue;
      }
      const observation = buildAudienceCountryObservation({
        fluCreatorId: mapping.fluCreatorId,
        portalCreatorId: mapping.portalCreatorId,
        enrollmentId: mapping.enrollmentId,
        channelId: mapping.channelId,
        mappingHash: mapping.mappingHash,
        countries: fetched.countries,
        window,
        collectedAtIso: nowIso,
        sourceWatermark: fetched.sourceWatermark,
      });
      const write = await writeAudienceCountryObservation(db, observation, {
        credentialRef: mapping.credentialRef,
        nowIso,
      });
      if (write.outcome === "created") result.collected += 1;
      else if (write.outcome === "duplicate") result.duplicates += 1;
      else result.conflicts += 1;
    } catch (error) {
      // 실패도 삼키지 않는다 — 사유를 남긴다(다음 사이클이 같은 매핑을 다시 시도한다).
      result.failed += 1;
      console.warn("[audience-country-collector] channel_failed", JSON.stringify({
        channelId: mapping.channelId,
        error: error instanceof Error ? error.message : "unknown",
      }));
    }
  }

  // 한 바퀴 돌면 커서를 리셋해 전체를 주기적으로 재순회한다(영구 누락 불가).
  await stateRef.set({
    audienceCollectorCursorDocId: cycleComplete ? "" : scannedDocs[scannedDocs.length - 1]?.id ?? "",
    audienceCollectorLastRunAtIso: nowIso,
    ...(cycleComplete ? { audienceCollectorCycleCompletedAtIso: nowIso } : {}),
  }, { merge: true });

  return result;
}


/**
 * 기본 access token 해석기: 승인된 OAuth 원장(`youtube_oauth_credentials`)의 암호화 envelope 을
 * 복호화해 유효한 access token 만 돌려준다.
 *
 * F2: 정본(youtubeOAuthLifecycle)과 **같은 자격 검사**를 통과해야만 토큰을 내준다:
 *   - 문서 필드는 writer 가 쓰는 이름 그대로 `envelope`(예전 코드는 `data.credential as never` 를
 *     읽어 항상 복호화 실패 → 수집이 영구히 0건이었다).
 *   - `status === "active"` 아니면 거부(lifecycle claimCredential 과 동일).
 *   - scope 가 요구 2종과 정확히 일치하지 않으면 거부(lifecycle hasExactRequiredScopes 와 동일).
 *   - 매핑 튜플 불일치·만료·키 부재는 거부.
 * 거부 사유는 삼키지 않고 호출자에게 돌려준다(집계·로그). 토큰은 메모리에서만 쓰이고 저장되지 않는다.
 */
export type AudienceAccessTokenResolution =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly reason: AudienceCredentialRejection };

export type AudienceCredentialRejection =
  | "encryption_key_absent"
  | "credential_absent"
  | "credential_inactive"
  | "mapping_mismatch"
  | "scope_mismatch"
  | "credential_expired"
  | "decrypt_failed";

export function hasExactAudienceRequiredScopes(scopes: unknown): boolean {
  const list = Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [];
  const normalized = [...new Set(list)].sort();
  return normalized.length === YOUTUBE_OAUTH_REQUIRED_SCOPES.length
    && YOUTUBE_OAUTH_REQUIRED_SCOPES.every((scope) => normalized.includes(scope));
}

export function audienceCredentialDocumentId(mapping: AudienceCollectorMapping): string {
  return `ytoc_${createHash("sha256")
    .update([mapping.portalCreatorId, mapping.programId, mapping.enrollmentId].join("\n"), "utf8")
    .digest("hex")
    .slice(0, 40)}`;
}

export function resolveAudienceAccessToken(
  db: FirebaseFirestore.Firestore,
): (mapping: AudienceCollectorMapping, nowIso: string) => Promise<AudienceAccessTokenResolution> {
  return async (mapping, nowIso) => {
    const encryptionKey = process.env.YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY ?? "";
    if (!encryptionKey) return { ok: false, reason: "encryption_key_absent" };
    const snapshot = await db
      .collection(YOUTUBE_OAUTH_CREDENTIALS_COLLECTION)
      .doc(audienceCredentialDocumentId(mapping))
      .get();
    if (!snapshot.exists) return { ok: false, reason: "credential_absent" };
    const data = snapshot.data() ?? {};
    if (text(data.status, 40) !== "active") return { ok: false, reason: "credential_inactive" };
    const storedMapping = (data.mapping ?? {}) as Record<string, unknown>;
    // 매핑 튜플이 어긋나면 남의 채널 자격으로 조회하는 것이다.
    if (
      text(storedMapping.fluCreatorId) !== mapping.fluCreatorId
      || text(storedMapping.channelId) !== mapping.channelId
    ) {
      return { ok: false, reason: "mapping_mismatch" };
    }
    if (!hasExactAudienceRequiredScopes(data.scopes)) return { ok: false, reason: "scope_mismatch" };
    let credential: { accessToken: string; expiresAt: string };
    try {
      credential = decryptYouTubeOAuthCredentialEnvelope({
        envelope: data.envelope as YouTubeOAuthCredentialEnvelope,
        encryptionKey,
        mapping: {
          portalCreatorId: mapping.portalCreatorId,
          fluCreatorId: mapping.fluCreatorId,
          partnerId: mapping.partnerId,
          programId: mapping.programId,
          enrollmentId: mapping.enrollmentId,
          channelId: mapping.channelId,
        },
      });
    } catch {
      return { ok: false, reason: "decrypt_failed" };
    }
    // 만료 토큰으로 외부 호출을 시도하지 않는다(갱신은 기존 refresh 스윕의 책임).
    if (Date.parse(credential.expiresAt) <= Date.parse(nowIso)) return { ok: false, reason: "credential_expired" };
    return credential.accessToken
      ? { ok: true, accessToken: credential.accessToken }
      : { ok: false, reason: "decrypt_failed" };
  };
}
