import { FieldPath } from "firebase-admin/firestore";
import type { ApplicationManagementLifecycleFallbackProfile } from "./applicationManagementStore";
import { LEGACY_SHEET_PORTAL_PROGRAM_ID } from "./legacySheetContentMigrationProjection";
import { normalizeScpProgramId } from "./scpProgramAlias";

export const PROVENANCE_IN_QUERY_LIMIT = 30;
export const APPLICATION_PROVENANCE_WINDOW_LIMIT = 200;

const CAMPAIGN_OUTREACH_COLLECTION = "campaign_outreach";
const CAMPAIGNS_COLLECTION = "campaigns";
const PROGRAMS_COLLECTION = "programs";

type FirestoreDb = Pick<FirebaseFirestore.Firestore, "collection">;

type OutreachDisplayIdentity = {
  readonly campaignId: string;
  readonly name: string;
  readonly handle: string;
  // W101(헤세): 유입 대기 섹션 폐지 — Apply 행이 관리 목록 카드에 직접 합류하므로 카드 부제
  // (플랫폼·국가·카테고리)도 같은 서명 아웃리치 문서에서만 건넨다. 이메일 등 raw 연락처는 금지.
  readonly platform: string;
  readonly country: string;
  readonly category: string;
};

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function containsRawEmail(value: string): boolean {
  return /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(value);
}

function documentId(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized
    && Buffer.byteLength(normalized, "utf8") <= 1_500
    && normalized !== "."
    && normalized !== ".."
    && !normalized.includes("/")
    ? normalized
    : "";
}

function publicName(data: Record<string, unknown>): string {
  for (const value of [data.creatorName, data.name, data.channelTitle]) {
    const candidate = text(value, 200);
    if (candidate && !containsRawEmail(candidate)) return candidate;
  }
  return "";
}

function publicHandle(data: Record<string, unknown>): string {
  for (const value of [data.creatorHandle, data.handle, data.channelName]) {
    const candidate = text(value, 120);
    if (candidate && !containsRawEmail(candidate)) return candidate;
  }
  return "";
}

function campaignDisplayName(data: Record<string, unknown>): string {
  for (const value of [data.title, data.name, data.displayName, data.label]) {
    const candidate = text(value, 200);
    if (candidate && !containsRawEmail(candidate)) return candidate;
  }
  return "";
}

function boundedDocumentIds(values: readonly string[], limit: number): string[] {
  return [...new Set(values.map(documentId).filter(Boolean))].slice(0, limit);
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

async function readDocumentsById(
  db: FirestoreDb,
  collectionName: string,
  ids: readonly string[],
  limit: number,
): Promise<Map<string, Record<string, unknown>>> {
  const boundedIds = boundedDocumentIds(ids, limit);
  if (boundedIds.length === 0) return new Map();
  const snapshots = await Promise.all(
    chunks(boundedIds, PROVENANCE_IN_QUERY_LIMIT).map((batch) =>
      db.collection(collectionName)
        .where(FieldPath.documentId(), "in", batch)
        .limit(batch.length)
        .get()),
  );
  const rows = new Map<string, Record<string, unknown>>();
  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) rows.set(doc.id, (doc.data() ?? {}) as Record<string, unknown>);
  }
  return rows;
}

export async function loadCampaignDisplayNames(
  db: FirestoreDb,
  campaignIds: readonly string[],
  limit = APPLICATION_PROVENANCE_WINDOW_LIMIT,
): Promise<Map<string, string>> {
  const documents = await readDocumentsById(db, CAMPAIGNS_COLLECTION, campaignIds, limit);
  const names = new Map<string, string>();
  for (const [id, data] of documents) {
    const name = campaignDisplayName(data);
    if (name) names.set(id, name);
  }
  return names;
}

// ---- 프로그램 표시명 (파트너 표면 정본 해석기) ----------------------------------------------------
//
// W91: 파트너 리스트와 상세가 **반드시 같은 판정**을 쓰게 하는 한 곳. 예전엔 리스트가 원시 id
// (`프로그램 view-cpm`)를 그대로 뿌리고, 상세는 view-cpm 을 "Super Creator Partners" 로 정적
// 매핑했다 — 후자는 scpProgramFunnelAggregate.ts 주석이 NO-SHIP 블로커로 금지한 오귀속 패턴이다.
// `view-cpm` 은 포털이 모든 신청에 붙이는 전역 태그라 특정 프로그램을 가리키지 않으므로 이름이
// 없다(applicationManagementLifecycleProgramId 의 null 드랍과 같은 결). 그 외에는 별칭을
// 정규화한 뒤 programs 문서의 표시명만 조인하고, 조인이 비면 이름을 지어내지 않는다.

const GLOBAL_PROGRAM_TAG_IDS = new Set<string>([LEGACY_SHEET_PORTAL_PROGRAM_ID]);

/** 표시명을 조회할 실제 프로그램 문서 id. 전역 태그이거나 빈 값이면 null(조회 자체를 하지 않는다). */
export function partnerProgramLookupId(programId: unknown): string | null {
  const raw = documentId(programId);
  if (!raw) return null;
  if (GLOBAL_PROGRAM_TAG_IDS.has(raw.toLowerCase())) return null;
  return documentId(normalizeScpProgramId(raw)) || null;
}

/** programs 문서 → 표시명. 전역 태그·문서 없음·이름 없음은 모두 null. */
export function partnerProgramDisplayName(
  programId: unknown,
  document: Record<string, unknown> | null | undefined,
): string | null {
  if (!partnerProgramLookupId(programId)) return null;
  return (document ? campaignDisplayName(document) : "") || null;
}

/** 리스트용 배치 조인 — loadCampaignDisplayNames 와 같은 방식. 키는 호출자가 준 원시 programId. */
export async function loadPartnerProgramDisplayNames(
  db: FirestoreDb,
  programIds: readonly string[],
  limit = APPLICATION_PROVENANCE_WINDOW_LIMIT,
): Promise<Map<string, string>> {
  const lookupByRawId = new Map<string, string>();
  for (const programId of programIds) {
    const lookupId = partnerProgramLookupId(programId);
    if (lookupId) lookupByRawId.set(programId, lookupId);
  }
  if (lookupByRawId.size === 0) return new Map();
  const documents = await readDocumentsById(db, PROGRAMS_COLLECTION, [...lookupByRawId.values()], limit);
  const names = new Map<string, string>();
  for (const [rawId, lookupId] of lookupByRawId) {
    const name = partnerProgramDisplayName(rawId, documents.get(lookupId));
    if (name) names.set(rawId, name);
  }
  return names;
}

async function loadOutreachDisplayIdentities(
  db: FirestoreDb,
  outreachIds: readonly string[],
): Promise<Map<string, OutreachDisplayIdentity>> {
  const documents = await readDocumentsById(
    db,
    CAMPAIGN_OUTREACH_COLLECTION,
    outreachIds,
    APPLICATION_PROVENANCE_WINDOW_LIMIT,
  );
  const identities = new Map<string, OutreachDisplayIdentity>();
  for (const [id, data] of documents) {
    const campaignId = documentId(data.campaignId);
    const name = publicName(data);
    const handle = publicHandle(data);
    if (!campaignId || (!name && !handle)) continue;
    // 리뷰 처방(W101, 실행 재현): platform/category 는 discovery 가 스크랩한 준자유문자열이라
    // 채널 소개란의 연락 이메일이 흘러들 수 있다 — publicName/publicHandle 과 같은 가드를 통과한
    // 값만 채택한다(불통과는 필드 생략이지 마스킹이 아니다).
    const publicToken = (value: string): string => (value && !containsRawEmail(value) ? value : "");
    const platform = publicToken(text(data.creatorPlatform, 40));
    const country = publicToken(text(data.country, 4) || text(data.creatorRegion, 4));
    // creatorCategory 는 공백 구분 토픽 나열 — 카드 부제에는 첫 토픽만(길이 통제).
    const category = publicToken(text(data.creatorCategory, 400).split(/\s+/)[0]?.replace(/_/g, " ") ?? "");
    identities.set(id, { campaignId, name, handle, platform, country, category });
  }
  return identities;
}

export async function enrichApplicationManagementProvenance(
  db: FirestoreDb,
  records: readonly ApplicationManagementLifecycleFallbackProfile[],
): Promise<ApplicationManagementLifecycleFallbackProfile[]> {
  const window = records.slice(0, APPLICATION_PROVENANCE_WINDOW_LIMIT);
  const campaignManaged = window.filter((record) =>
    record.classification === "managed" && Boolean(record.campaignId));
  const signedManaged = campaignManaged.filter((record) => Boolean(record.outreachId));
  if (campaignManaged.length === 0) return [...window];

  const [outreachById, campaignNames] = await Promise.all([
    loadOutreachDisplayIdentities(db, signedManaged.flatMap((record) => record.outreachId ? [record.outreachId] : [])),
    loadCampaignDisplayNames(db, campaignManaged.flatMap((record) => record.campaignId ? [record.campaignId] : [])),
  ]);

  return window.map((record) => {
    if (record.classification !== "managed" || !record.campaignId) return record;
    const campaignName = campaignNames.get(record.campaignId) ?? "";
    if (!record.outreachId) {
      // Operator assignment proves only campaign membership. Without a signed outreach id it must never
      // unlock a creator name or handle, but the verified campaign document is still factual display data.
      return {
        ...record,
        ...(campaignName ? { campaignName } : {}),
      };
    }
    const outreach = outreachById.get(record.outreachId);
    // The signed attribution identity is authoritative. An outreach document under the requested id still
    // has to claim the same campaign before its public name/handle can cross the callable boundary.
    const matchingOutreach = outreach?.campaignId === record.campaignId ? outreach : null;
    return {
      ...record,
      ...(matchingOutreach?.name ? { outreachName: matchingOutreach.name } : {}),
      ...(matchingOutreach?.handle ? { outreachHandle: matchingOutreach.handle } : {}),
      ...(matchingOutreach?.platform ? { outreachPlatform: matchingOutreach.platform } : {}),
      ...(matchingOutreach?.country ? { outreachCountry: matchingOutreach.country.toUpperCase() } : {}),
      ...(matchingOutreach?.category ? { outreachCategory: matchingOutreach.category } : {}),
      ...(campaignName ? { campaignName } : {}),
    };
  });
}
