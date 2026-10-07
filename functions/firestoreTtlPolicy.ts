// 180일 Firestore TTL 정본 레지스트리.
//
// 데이터는 `firestoreTtlPolicy.json` 한 곳에만 있다 — 이 파일(functions writer 쪽)과
// `scripts/lib/firestore-ttl-180d-core.mjs`(PLAN/APPLY/BACKFILL 쪽) 둘 다 같은 JSON을 읽는다.
// 컬렉션 목록을 두 군데에 각각 손으로 적으면 결국 어긋난다(writer는 새 컬렉션에 expireAt을
// 찍는데 스크립트 인벤토리는 모르는 상태, 혹은 그 반대) — 그 드리프트를 구조적으로 막는다.
import policy from "./firestoreTtlPolicy.json";

export type TtlBasisType = "timestamp" | "iso";
export type TtlCollectionScope = "collectionGroup" | "topLevelCollection";

export type TtlLogCollectionEntry = {
  readonly collectionGroup: string;
  readonly basisField: string;
  readonly basisType: TtlBasisType;
  readonly fallbackField?: string;
  readonly basisVerified: boolean;
  readonly writerVerified: boolean;
  readonly scope: TtlCollectionScope;
  readonly note?: string;
};

export const EXPIRE_FIELD: string = policy.expireField;
export const TTL_DAYS: number = policy.ttlDays;

/** 절대 TTL 걸면 안 되는 운영 컬렉션(과거 문서를 다시 읽는 기능이 있음). */
export const TTL_OPERATIONAL_COLLECTIONS: readonly string[] = Object.freeze(
  policy.operational.slice(),
);

/** LOG 인벤토리 전체(마이그레이션 진행 상태 무관) — basis/writer 검증 메타데이터 포함. */
export const TTL_LOG_COLLECTION_ENTRIES: readonly TtlLogCollectionEntry[] = Object.freeze(
  policy.log.map((entry) => Object.freeze({ ...entry }) as TtlLogCollectionEntry),
);

/**
 * 180일 TTL 대상 LOG 컬렉션의 정확한 목록(정본 §2 "LOG 후보" 전체 — mutation eligible 여부와
 * 무관하게, OPERATIONAL이 아닌 LOG 컬렉션 전체). PLAN/APPLY/BACKFILL 스크립트와 writer 코드가
 * 같은 이 배열을 참조해야 어긋나지 않는다.
 */
export const TTL_180D_COLLECTIONS: readonly string[] = Object.freeze(
  TTL_LOG_COLLECTION_ENTRIES.map((entry) => entry.collectionGroup),
);

/**
 * `name`이 절대 TTL을 걸면 안 되는 OPERATIONAL 컬렉션이면 throw한다. backfill/apply 스크립트가
 * 대상 컬렉션을 건드리기 직전에 방어적으로 호출한다(인벤토리 오류로 OPERATIONAL 컬렉션이
 * LOG 목록에 섞여 들어가도 이 함수가 마지막 방어선이 된다).
 */
export function assertNotTtlCollection(name: string): void {
  if (TTL_OPERATIONAL_COLLECTIONS.includes(name)) {
    throw new Error(
      `${name} is an operational collection and must never receive a ${TTL_DAYS}-day ${EXPIRE_FIELD} TTL policy or backfill`,
    );
  }
}
