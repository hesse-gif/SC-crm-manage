// Flu — Studio 국가 오디언스 aggregate (R4, 2026-07-27).
//
// 계약 정본: artifacts/figma-scp-monitoring-20260727/B2-AUDIENCE-INGRESS-DATA-CONTRACT.md §2.2.
// P3 승인 예외로 만들어지는 **유일한 신규 컬렉션**이다:
//   scp_audience_country_channels/{audienceChannelKey}              — current projection (CAS revision)
//   scp_audience_country_channels/{audienceChannelKey}/observations — append-only 관측 원장
//
// 규칙:
//  - observationId 는 `channelId + window + sourceWatermark + sourceFingerprint` 에서 결정적으로 만든다.
//    같은 id + 같은 canonicalBytes = duplicate success / 같은 id + 다른 bytes = conflict / overwrite 금지.
//  - current root doc 만 CAS revision 으로 최신 **유효** 관측을 가리킨다.
//  - `credentialRef` 는 참조 문자열만 — secret/token 본문은 절대 저장하지 않는다.
//  - 매핑 튜플(fluCreatorId + channelId)이 어긋나면 verified 로 승격하지 않는다.
//  - 비중은 저장하지 않는다(읽기 시점에 BigInt basis point 로 계산 — 복사 금지).

import { createHash } from "node:crypto";

export const SCP_AUDIENCE_COUNTRY_CHANNELS_COLLECTION = "scp_audience_country_channels";
export const SCP_AUDIENCE_COUNTRY_OBSERVATIONS_SUBCOLLECTION = "observations";
export const AUDIENCE_COUNTRY_CHANNEL_SCHEMA_VERSION = "scp.audience-country-channel.v1";
export const AUDIENCE_COUNTRY_OBSERVATION_SCHEMA_VERSION = "scp.audience-country-observation.v1";

/** 계약이 고정한 창 길이: 최근 28개 **완결일**. */
export const AUDIENCE_WINDOW_DAYS = 28;

export type AudienceChannelStatus =
  | "oauth_pending"
  | "collecting"
  | "verified"
  | "stale"
  | "reauth_required"
  | "failed";

export interface AudienceCountryCount {
  readonly countryCode: string;
  readonly views: string;
}

export interface AudienceWindow {
  readonly startDate: string;
  readonly endDate: string;
}

export interface AudienceCountryObservationInput {
  readonly fluCreatorId: string;
  readonly portalCreatorId: string;
  readonly enrollmentId: string;
  readonly channelId: string;
  readonly mappingHash: string;
  readonly countries: readonly AudienceCountryCount[];
  readonly window: AudienceWindow;
  readonly collectedAtIso: string;
  readonly sourceWatermark: string;
}

export interface AudienceCountryObservation {
  readonly schemaVersion: typeof AUDIENCE_COUNTRY_OBSERVATION_SCHEMA_VERSION;
  readonly observationId: string;
  readonly source: "youtube_analytics";
  readonly fluCreatorId: string;
  readonly portalCreatorId: string;
  readonly enrollmentId: string;
  readonly channelId: string;
  readonly mappingHash: string;
  readonly countries: readonly AudienceCountryCount[];
  readonly totalViews: string;
  readonly primaryCountryCode: string | null;
  readonly decision: "verified" | "ambiguous_tie";
  readonly window: AudienceWindow;
  readonly collectedAtIso: string;
  readonly sourceWatermark: string;
  readonly sourceFingerprint: string;
  readonly canonicalBytes: string;
  readonly createdAtIso: string;
}

const UINT_RE = /^\d+$/;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function audienceChannelKey(fluCreatorId: string, channelId: string): string {
  return sha256(`${fluCreatorId}\u0000${channelId}`).slice(0, 48);
}

function normalizedCountryCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  // ZZ(미상)·비 ISO 는 국가로 승격하지 않는다.
  return /^[A-Z]{2}$/.test(upper) && upper !== "ZZ" ? upper : null;
}

function normalizedViews(value: unknown): string | null {
  if (typeof value === "string" && UINT_RE.test(value.trim())) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/** 관측 바이트 정규화 — 국가 코드 오름차순 + 문자열 조회수. 같은 사실이면 같은 바이트가 나온다. */
export function canonicalAudienceBytes(input: {
  readonly channelId: string;
  readonly window: AudienceWindow;
  readonly countries: readonly AudienceCountryCount[];
  readonly sourceWatermark: string;
}): string {
  const countries = [...input.countries]
    .map((entry) => ({ countryCode: entry.countryCode, views: entry.views }))
    .sort((left, right) => left.countryCode.localeCompare(right.countryCode));
  return JSON.stringify({
    channelId: input.channelId,
    window: { startDate: input.window.startDate, endDate: input.window.endDate },
    sourceWatermark: input.sourceWatermark,
    countries,
  });
}

/** `channelId + window + sourceWatermark + sourceFingerprint` 결정적 관측 id. */
export function audienceObservationId(input: {
  readonly channelId: string;
  readonly window: AudienceWindow;
  readonly sourceWatermark: string;
  readonly sourceFingerprint: string;
}): string {
  return `obs_${sha256([
    input.channelId,
    input.window.startDate,
    input.window.endDate,
    input.sourceWatermark,
    input.sourceFingerprint,
  ].join("\u0000")).slice(0, 48)}`;
}

/**
 * 수집 결과 → 관측 문서(순수). 유효하지 않은 국가/조회수는 버리고, 1위가 동률이면 `ambiguous_tie`
 * 로 남겨 verified primary 로 승격하지 않는다.
 */
export function buildAudienceCountryObservation(
  input: AudienceCountryObservationInput,
): AudienceCountryObservation {
  const countries = input.countries
    .map((entry) => ({ countryCode: normalizedCountryCode(entry.countryCode), views: normalizedViews(entry.views) }))
    .filter((entry): entry is AudienceCountryCount => Boolean(entry.countryCode) && entry.views !== null)
    .sort((left, right) => (BigInt(right.views) > BigInt(left.views) ? 1 : BigInt(right.views) < BigInt(left.views) ? -1 : left.countryCode.localeCompare(right.countryCode)));
  const totalViews = countries.reduce((total, entry) => total + BigInt(entry.views), 0n).toString();
  const top = countries[0] ?? null;
  const tie = Boolean(top) && countries.length > 1 && countries[1].views === top?.views;
  const canonicalBytes = canonicalAudienceBytes({
    channelId: input.channelId,
    window: input.window,
    countries,
    sourceWatermark: input.sourceWatermark,
  });
  const sourceFingerprint = sha256(canonicalBytes);
  return {
    schemaVersion: AUDIENCE_COUNTRY_OBSERVATION_SCHEMA_VERSION,
    observationId: audienceObservationId({
      channelId: input.channelId,
      window: input.window,
      sourceWatermark: input.sourceWatermark,
      sourceFingerprint,
    }),
    source: "youtube_analytics",
    fluCreatorId: input.fluCreatorId,
    portalCreatorId: input.portalCreatorId,
    enrollmentId: input.enrollmentId,
    channelId: input.channelId,
    mappingHash: input.mappingHash,
    countries,
    totalViews,
    primaryCountryCode: tie || !top ? null : top.countryCode,
    decision: tie || !top ? "ambiguous_tie" : "verified",
    window: input.window,
    collectedAtIso: input.collectedAtIso,
    sourceWatermark: input.sourceWatermark,
    sourceFingerprint,
    canonicalBytes,
    createdAtIso: input.collectedAtIso,
  };
}

/** 최근 28개 **완결일**(오늘은 미완결이라 제외). UTC 캘린더 기준. */
export function resolveAudienceWindow(nowIso: string, days = AUDIENCE_WINDOW_DAYS): AudienceWindow {
  const nowMs = Date.parse(nowIso);
  const endMs = Number.isFinite(nowMs) ? nowMs - 86_400_000 : Date.now() - 86_400_000;
  const endDate = new Date(endMs).toISOString().slice(0, 10);
  const startDate = new Date(endMs - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { startDate, endDate };
}

export type AudienceObservationWriteResult =
  | { readonly outcome: "created"; readonly observationId: string; readonly revision: number }
  | { readonly outcome: "duplicate"; readonly observationId: string; readonly revision: number }
  | { readonly outcome: "conflict"; readonly observationId: string; readonly reason: string };

/**
 * 관측 append-only 기록 + current projection CAS 갱신.
 *
 * - 같은 observationId + 같은 canonicalBytes → `duplicate`(성공), 문서를 덮지 않는다.
 * - 같은 observationId + 다른 canonicalBytes → `conflict`, 아무것도 쓰지 않는다.
 * - current 는 관측이 기존 것보다 새로울 때만(수집 시각 비교) CAS revision 을 올린다.
 * - `credentialRef` 는 참조 문자열만 저장한다(secret/token 본문 금지).
 */
export async function writeAudienceCountryObservation(
  db: FirebaseFirestore.Firestore,
  observation: AudienceCountryObservation,
  options: { readonly credentialRef: string; readonly nowIso: string },
): Promise<AudienceObservationWriteResult> {
  const key = audienceChannelKey(observation.fluCreatorId, observation.channelId);
  const currentRef = db.collection(SCP_AUDIENCE_COUNTRY_CHANNELS_COLLECTION).doc(key);
  const observationRef = currentRef
    .collection(SCP_AUDIENCE_COUNTRY_OBSERVATIONS_SUBCOLLECTION)
    .doc(observation.observationId);

  return db.runTransaction(async (transaction) => {
    const [observationSnapshot, currentSnapshot] = await Promise.all([
      transaction.get(observationRef),
      transaction.get(currentRef),
    ]);

    if (observationSnapshot.exists) {
      const storedBytes = observationSnapshot.data()?.canonicalBytes;
      if (storedBytes !== observation.canonicalBytes) {
        return {
          outcome: "conflict" as const,
          observationId: observation.observationId,
          reason: "observation_bytes_conflict",
        };
      }
      return {
        outcome: "duplicate" as const,
        observationId: observation.observationId,
        revision: Number(currentSnapshot.data()?.revision ?? 0),
      };
    }

    transaction.create(observationRef, { ...observation });

    const currentData = currentSnapshot.data() ?? {};
    const priorCollectedAtIso = typeof currentData.collectedAtIso === "string" ? currentData.collectedAtIso : "";
    const priorRevision = Number(currentData.revision ?? 0);
    // 오래된 관측이 뒤늦게 도착해도 current 를 되돌리지 않는다(관측 원장에는 그대로 남는다).
    if (priorCollectedAtIso && priorCollectedAtIso >= observation.collectedAtIso) {
      return { outcome: "created" as const, observationId: observation.observationId, revision: priorRevision };
    }

    const revision = priorRevision + 1;
    transaction.set(currentRef, {
      schemaVersion: AUDIENCE_COUNTRY_CHANNEL_SCHEMA_VERSION,
      fluCreatorId: observation.fluCreatorId,
      portalCreatorId: observation.portalCreatorId,
      enrollmentId: observation.enrollmentId,
      channelId: observation.channelId,
      mappingHash: observation.mappingHash,
      credentialRef: options.credentialRef,
      status: (observation.decision === "verified" ? "verified" : "collecting") satisfies AudienceChannelStatus,
      currentObservationId: observation.observationId,
      primaryCountryCode: observation.primaryCountryCode,
      countries: observation.countries.map((entry) => ({ countryCode: entry.countryCode, views: entry.views })),
      totalViews: observation.totalViews,
      window: observation.window,
      collectedAtIso: observation.collectedAtIso,
      sourceWatermark: observation.sourceWatermark,
      revision,
      updatedAtIso: options.nowIso,
    }, { merge: true });

    return { outcome: "created" as const, observationId: observation.observationId, revision };
  });
}
