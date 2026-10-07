/**
 * Flu/Task-44 — 후보별 독려 주기(cadenceDays) 오버라이드.
 *
 * candidate_pool/{channelId}.candidateTableState.nudgeCadenceDaysOverride 가 화면 표시/즉시
 * 재계산용 정본이다(functions/candidateTable.ts가 직접 읽고 쓴다 — 별도 조회 없이 listCandidates
 * 응답에 바로 반영된다). 이 컬렉션(scp_candidate_nudge_cadence_overrides)은 그 값의 스윕측 사본
 * 으로, functions/nudgeCohortSweep.ts가 이메일 해시로 조회한다 — 스윕은 candidate_pool을 전혀
 * 모른다(코호트1·3 이 SCP 지원자 이메일 축만 쓴다 — Task-44 조사 결과, candidate_pool 후보와는
 * 별개 모집단). 두 축 다 candidateTable.ts의 setCandidateNudgeCadenceOverride 한 호출 안에서
 * 같이 쓴다.
 *
 * 조인 키(emailDigest)는 nudgeCohortSweep.ts nudgeEmailDigest(email)와 반드시 같은
 * sha256(email 소문자) 전체 해시여야 한다(그 파일 "복제 금지" 주석과 동일 원칙 — 호출자가 그
 * 함수로 계산해 emailDigest로 넘긴다. 이 모듈은 해시 계산 자체에는 관여하지 않는다).
 *
 * 오버라이드가 없을 때(문서 없음 / 범위 밖 값)는 스윕이 기존 코호트 cadence를 그대로 쓴다 —
 * 순수 가산(additive) 조회라 회귀 0(기존 스윕 동작 바이트 동일).
 */

export const CANDIDATE_NUDGE_CADENCE_OVERRIDES_COLLECTION = "scp_candidate_nudge_cadence_overrides";
export const CANDIDATE_CADENCE_DAYS_MIN = 1;
export const CANDIDATE_CADENCE_DAYS_MAX = 365;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
// getAll 배치 상한 — nudgeCohortSweep.ts의 getAll 청크(100, MAIL_OUTBOUND_LOG_COLLECTION/
// VIDEO_REMINDER_HISTORY_COLLECTION 조회)와 동일 근거: doc-id 직접 조회라 in-쿼리 30 상한이
// 아니라 getAll 상한을 따른다.
const OVERRIDE_LOOKUP_BATCH_SIZE = 100;

export interface CandidateNudgeCadenceOverrideDoc {
  candidateRef: string;
  emailDigest: string;
  emailMasked: string;
  cadenceDays: number | null;
  updatedAtIso: string;
  updatedBy: string;
  updatedByRole: string;
}

// ---------- 최소 구조적 Firestore 인터페이스 ----------
// candidateTable.ts의 CandidateTableDb와 같은 목적(에뮬레이터 없이 페이크로 테스트 가능)이지만,
// 이 모듈이 어느 쪽 파일에도 의존하지 않도록 여기서 따로 정의한다(nudgeCohortSweep.ts의 실제
// adminDb, candidateTable.ts의 CandidateTableDb 양쪽이 구조적으로 만족한다).
interface OverrideDocSnapshot {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface OverrideDocRef {
  readonly id: string;
  get(): Promise<OverrideDocSnapshot>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
}
interface OverrideCollectionRef {
  doc(id: string): OverrideDocRef;
}
export interface CandidateNudgeCadenceOverrideDb {
  collection(name: string): OverrideCollectionRef;
  getAll(...refs: OverrideDocRef[]): Promise<OverrideDocSnapshot[]>;
}
// 재리뷰 HIGH: candidateTable.ts setCandidateNudgeCadenceOverride가 candidate_pool 정본 쓰기와
// 이 모듈의 스윕측 사본 쓰기를 db.batch() 하나로 묶어 원자 commit하기 위한 최소 인터페이스
// (CandidateTableWriteBatch와 구조적으로 호환 — candidateTable.ts의 db.batch()를 그대로 넘긴다).
export interface CandidateNudgeCadenceOverrideWriteBatch {
  set(ref: OverrideDocRef, data: Record<string, unknown>, options?: { merge?: boolean }): void;
}

function invalidArgument(errorCode: string, message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode });
}

/** 1~365 정수만 허용 — 범위 밖/비정수는 던진다(nudgeSequenceAdmin.ts totalDailyCap과 동일한
 * "throw, 조용한 clamp 금지" 방침 — 후보 주기는 누군가 직접 편집하는 값이라 실수를 그대로
 * 삼키면 안 된다). */
export function assertValidCandidateCadenceDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw invalidArgument(
      "candidate_nudge_cadence_days_invalid",
      "cadenceDays must be an integer number of days",
    );
  }
  if (value < CANDIDATE_CADENCE_DAYS_MIN || value > CANDIDATE_CADENCE_DAYS_MAX) {
    throw invalidArgument(
      "candidate_nudge_cadence_days_out_of_range",
      `cadenceDays must be between ${CANDIDATE_CADENCE_DAYS_MIN} and ${CANDIDATE_CADENCE_DAYS_MAX}`,
    );
  }
  return value;
}

/** 스윕(nudgeCohortSweep.ts)이 후보별 오버라이드를 조회할 때 쓴다 — doc id = emailDigest라
 * in-쿼리가 아니라 getAll(직접 참조 배치 읽기)로 충분하다. */
export async function readCandidateNudgeCadenceOverrides(
  db: CandidateNudgeCadenceOverrideDb,
  emailDigests: readonly string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(emailDigests.filter((digest) => digest.length > 0))];
  const result = new Map<string, number>();
  const collection = db.collection(CANDIDATE_NUDGE_CADENCE_OVERRIDES_COLLECTION);
  for (let offset = 0; offset < unique.length; offset += OVERRIDE_LOOKUP_BATCH_SIZE) {
    const chunk = unique.slice(offset, offset + OVERRIDE_LOOKUP_BATCH_SIZE);
    if (chunk.length === 0) continue;
    const snaps = await db.getAll(...chunk.map((digest) => collection.doc(digest)));
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const data = snap.data();
      const cadenceDays = data?.cadenceDays;
      if (
        typeof cadenceDays === "number"
        && Number.isInteger(cadenceDays)
        && cadenceDays >= CANDIDATE_CADENCE_DAYS_MIN
        && cadenceDays <= CANDIDATE_CADENCE_DAYS_MAX
      ) {
        result.set(snap.id, cadenceDays);
      }
    }
  }
  return result;
}

/** 오버라이드 없음(undefined) → 코호트 cadence 그대로. 있으면 후보 주기가 이긴다(1순위). */
export function resolveEffectiveCadenceMs(
  overrideCadenceDays: number | undefined,
  cohortCadenceMs: number,
): number {
  return typeof overrideCadenceDays === "number" ? overrideCadenceDays * MS_PER_DAY : cohortCadenceMs;
}

/** candidateTable.ts의 setCandidateNudgeCadenceOverride가 쓴다. cadenceDays=null은 오버라이드
 * 해제(전역 기본으로 폴백) — 문서를 지우지 않고 null을 저장한다(readCandidateNudgeCadenceOverrides
 * 가 범위 밖 값으로 걸러 자동으로 무시하므로, 이 모듈 Db 인터페이스에 delete 권한을 추가할
 * 필요가 없다 — 최소 인터페이스 유지).
 *
 * 재리뷰 HIGH: `batch`를 넘기면 즉시 commit하지 않고 그 배치에 적재만 한다 — 호출자
 * (candidateTable.ts)가 candidate_pool 쓰기와 같은 db.batch().commit() 안에 넣어 두 쓰기를
 * 원자화한다(하나가 실패하면 둘 다 커밋되지 않는다). batch가 없으면(단위 테스트 등) 기존처럼
 * 즉시 set한다 — 회귀 0. */
export async function writeCandidateNudgeCadenceOverride(
  db: CandidateNudgeCadenceOverrideDb,
  doc: CandidateNudgeCadenceOverrideDoc,
  batch?: CandidateNudgeCadenceOverrideWriteBatch,
): Promise<void> {
  const ref = db.collection(CANDIDATE_NUDGE_CADENCE_OVERRIDES_COLLECTION).doc(doc.emailDigest);
  if (batch) {
    batch.set(ref, { ...doc }, { merge: true });
    return;
  }
  await ref.set({ ...doc }, { merge: true });
}
