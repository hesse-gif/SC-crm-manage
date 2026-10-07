// W104(헤세): 지원서 자가신고 신원 스윕 — 포털 `scp_creator_applications.answers` 의 안전
// 서브셋(핸들·이름·국가·카테고리·채널URL)을 flu `scp_application_management.declaredIdentity` 로
// 미러링한다. 배경: token_absent 지원은 서명 material 이 아예 오지 않아(v3 전달 없음) 관리 카드가
// opaque id("지원 접수 xxxx…")로만 떴다 — 신원은 지원서에 처음부터 있었다.
//
// 안전 원칙:
//  · 이메일 등 연락처는 어떤 필드로도 건너지 않는다(EMAILISH 가드 — provenanceDisplay 와 동일 클래스).
//  · declaredIdentity 가 이미 있으면 손대지 않는다(멱등·운영자/기존 값 불가침).
//  · 포털 읽기는 legacySheetContentMigrationStore 와 같은 ADC 크로스 프로젝트 패턴 — 권한이 없으면
//    조용히 실패하지 않고 permission_denied 카운트로 보고한다(시몬에게 IAM 요청 근거).
import { getApp, initializeApp, applicationDefault } from "firebase-admin/app";
import { FieldPath, FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";

const SWEEP_PORTAL_APP_NAME = "application-declared-identity-sweep";
const PORTAL_APPLICATIONS_COLLECTION = "scp_creator_applications";
const MANAGEMENT_COLLECTION = "scp_application_management";
const SWEEP_STATE_COLLECTION = "scp_application_management_state";
const SWEEP_STATE_DOC = "declared_identity_sweep";
// 회당 상한. 포털은 라이브라 읽기 부하를 온건하게 유지한다 — 스캔은 페이지로 나눠 훑고,
// 백필(포털 문서 읽기 + flu 쓰기)이 상한에 닿으면 그 자리에서 멈춘다(다음 회차가 이어받는다).
const DEFAULT_SWEEP_SCAN_LIMIT = 600;
const DEFAULT_SWEEP_BACKFILL_LIMIT = 200;
const SWEEP_PAGE_SIZE = 200;

function portalDb(): Firestore {
  const projectId = (process.env.SCP_PORTAL_PROJECT_ID ?? "").trim() || "scp-creator-portal";
  try {
    return getFirestore(getApp(SWEEP_PORTAL_APP_NAME));
  } catch {
    return getFirestore(
      initializeApp({ credential: applicationDefault(), projectId }, SWEEP_PORTAL_APP_NAME),
    );
  }
}

const EMAILISH = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function publicText(value: unknown, limit: number): string {
  const candidate = text(value, limit);
  // 리뷰 처방(W104, 실행 재현): 전각 "＠"(U+FF20) 등 호환 문자가 ASCII 가드를 우회했다 —
  // NFKC 정규화본으로 검사한다(IME 전각 입력은 대상 사용자군에서 현실적인 아티팩트).
  return candidate && !EMAILISH.test(candidate.normalize("NFKC")) ? candidate : "";
}

export type DeclaredIdentityProjection = {
  handle: string;
  name: string;
  country: string;
  category: string;
  channelUrl: string;
  source: "portal_apply_answers";
};

/** 순수 추출기 — 포털 answers 에서 표시 가능한 자가신고 서브셋만. 이메일류는 어떤 필드에서도 탈락. */
export function declaredIdentityFromPortalAnswers(
  value: unknown,
): DeclaredIdentityProjection | null {
  const answers = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  // 리뷰 처방(W104): channelUrl 도 이메일 가드를 통과해야 한다 — 쿼리스트링·경로에 이메일이
  // 실린 URL 은 통째로 버린다(latent 저장 금지, 함수 불변식 "어떤 필드로도 금지"와 일치).
  const channelUrlRaw = publicText(answers.channelUrl, 300);
  const projection: DeclaredIdentityProjection = {
    handle: publicText(answers.youtubeHandle, 120),
    name: publicText(answers.fullName, 120),
    country: text(answers.countryOfResidence, 4).toUpperCase(),
    category: publicText(answers.primaryContentCategory, 80),
    channelUrl: /^https:\/\/(www\.)?youtube\.com\//.test(channelUrlRaw) ? channelUrlRaw : "",
    source: "portal_apply_answers",
  };
  if (!projection.handle && !projection.name) return null;
  return projection;
}

export type DeclaredIdentitySweepResult = {
  scanned: number;
  alreadyDeclared: number;
  backfilled: number;
  portalMissing: number;
  emptyAnswers: number;
  permissionDenied: boolean;
  /**
   * 재시도성 인프라 실패(UNAVAILABLE/DEADLINE_EXCEEDED/RESOURCE_EXHAUSTED)로 회차를 접었는가.
   * permissionDenied 와 같은 등급으로 다룬다 — 정지하고, 완전히 처리된 지점까지만 커서를 남긴다.
   */
  transientFailure: boolean;
  /**
   * 다른 실행(수동 콜러블 ↔ 스케줄 중첩)이 그 사이 상태 문서를 옮겨 이 회차의 커서 전진을
   * 포기했는가. 커서 되감김·리셋 유실을 막기 위한 정지 신호다.
   */
  cursorContended: boolean;
  /** 이번 회차에 컬렉션 끝까지 닿아 커서를 리셋했는가(다음 회차는 다시 최신부터 훑는다). */
  cycleComplete: boolean;
};

type SweepCursor = { submittedAtIso: string; applicationId: string };

/**
 * 커서 값은 `startAfter` 에 **그대로** 실려야 정렬축의 같은 지점을 가리킨다 — 자르거나 trim 하면
 * 그 경계에서 문서를 건너뛰거나 무한 재스캔한다. 타입만 검사하고 값은 손대지 않는다.
 */
function cursorText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 커서 상태 문서 읽기. `applicationId` 만 있으면 유효한 커서다 — `submittedAtIso` 는 빈 문자열도
 * 정렬축의 정당한 값이라(필드는 있는데 값이 빈 문서) 그것만으로 커서를 버리면 같은 머리를 영원히
 * 재스캔하게 된다.
 */
function readSweepCursor(state: Record<string, unknown>): SweepCursor | null {
  const applicationId = cursorText(state.cursorApplicationId);
  return applicationId ? { submittedAtIso: cursorText(state.cursorSubmittedAtIso), applicationId } : null;
}

function sameCursor(a: SweepCursor | null, b: SweepCursor | null): boolean {
  return (a?.applicationId ?? "") === (b?.applicationId ?? "")
    && (a?.submittedAtIso ?? "") === (b?.submittedAtIso ?? "");
}

// 재시도성 gRPC 코드. 이 형상은 "이 회차가 운이 없었다"는 뜻이라 커서를 전진시키면 안 된다 —
// 스케줄은 retryCount 0 이므로 잃은 구간을 되찾아 줄 재시도가 없다.
const RETRYABLE_GRPC_CODES = new Set<number>([4, 8, 14]);

function isPermissionDenied(caught: unknown): boolean {
  const code = (caught as { code?: number | string } | null)?.code;
  return code === 7 || code === "permission-denied" || /PERMISSION_DENIED/i.test(String(caught));
}

function isRetryableFailure(caught: unknown): boolean {
  const code = (caught as { code?: number | string } | null)?.code;
  if (typeof code === "number" && RETRYABLE_GRPC_CODES.has(code)) return true;
  if (typeof code === "string" && /^(unavailable|deadline-exceeded|resource-exhausted)$/i.test(code)) return true;
  return /\b(UNAVAILABLE|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED)\b/.test(String(caught));
}

/**
 * 이미 저장된 자가신고 값이 새 투영과 완전히 같은가. 같은 값을 다시 쓰면 `backfilledAtIso` 만
 * 갱신돼 "무언가 바뀌었다"는 잘못된 흔적을 남기므로, 실제 변화가 있을 때만 쓴다.
 */
function declaredIdentityUnchanged(
  existing: Record<string, unknown> | undefined,
  projection: DeclaredIdentityProjection,
): boolean {
  if (!existing) return false;
  return text(existing.handle, 120) === projection.handle
    && text(existing.name, 120) === projection.name
    && text(existing.country, 4).toUpperCase() === projection.country
    && text(existing.category, 80) === projection.category
    && text(existing.channelUrl, 300) === projection.channelUrl
    && text(existing.source, 40) === projection.source;
}

type SweepDocOutcome =
  | "already_declared"
  | "portal_missing"
  | "empty_answers"
  | "backfilled"
  | "permission_denied"
  | "transient_failure";

/**
 * 관리 컬렉션 전량을 회차에 걸쳐 순회하며 자가신고 신원을 백필한다.
 *
 * 커서 페이징인 이유(리뷰 처방): 예전 창은 `updatedAtIso desc` 200건 **고정**이었는데 백필 merge 는
 * `updatedAtIso` 를 갱신하지 않으므로 매 실행이 같은 상위 200건만 재스캔했다 — 그 밖의 레코드는
 * 영구 미백필. 정렬축도 목록 표면(`submittedAtIso desc`)과 어긋나 있었다. 이제 상태 문서에 진행
 * 지점을 남기고 끝에 닿으면 리셋해, 신규분과 실패분을 주기적으로 다시 덮는다.
 *
 * 체크포인트가 **페이지 경계마다**인 이유(리뷰 처방): 회차 끝 1회만 쓰면 함수 타임아웃(300s,
 * retryCount 0, 순차 포털 왕복)이나 재시도성 gRPC 예외에서 회차 전체 진행이 통째로 소실됐다.
 * 이제 "완전히 처리된 마지막 문서"만 커서로 커밋하므로 페이지 중간 실패에서도 잃는 구간이 없고,
 * 재처리분은 아래 대칭 가드(handle **또는** name)를 만나 포털 재조회 없이 즉시 스킵된다 → 0 수렴.
 *
 * 상태 문서 쓰기는 모두 트랜잭션 compare-and-set 이다: 이 회차가 마지막으로 관측한 커서와 저장본이
 * 다르면 쓰지 않고 멈춘다(cursorContended). 수동 콜러블과 스케줄이 겹쳐도 커서가 뒤로 감기거나
 * 완주 리셋이 지워지지 않는다.
 */
export async function sweepApplicationDeclaredIdentity(
  options: {
    scanLimit?: number;
    backfillLimit?: number;
    nowIso?: string;
    db?: Firestore;
    portal?: Firestore;
  } = {},
): Promise<DeclaredIdentitySweepResult> {
  const scanLimit = Math.max(1, Math.min(2000, Math.round(options.scanLimit ?? DEFAULT_SWEEP_SCAN_LIMIT)));
  const backfillLimit = Math.max(
    1,
    Math.min(scanLimit, Math.round(options.backfillLimit ?? DEFAULT_SWEEP_BACKFILL_LIMIT)),
  );
  const nowIso = options.nowIso ?? new Date().toISOString();
  const db = options.db ?? adminDb;
  const result: DeclaredIdentitySweepResult = {
    scanned: 0,
    alreadyDeclared: 0,
    backfilled: 0,
    portalMissing: 0,
    emptyAnswers: 0,
    permissionDenied: false,
    transientFailure: false,
    cursorContended: false,
    cycleComplete: false,
  };
  const stateRef = db.collection(SWEEP_STATE_COLLECTION).doc(SWEEP_STATE_DOC);
  let cursor = readSweepCursor((await stateRef.get()).data() ?? {});
  // 이 회차가 "상태 문서에 있다고 믿는" 커서. 커밋은 저장본이 이 값과 같을 때만 통과한다.
  let expected = cursor;
  // 완전히 처리된(백필·스킵·판정 완료) 마지막 문서. 체크포인트는 오직 이 지점까지만 전진한다.
  let committed: SweepCursor | null = null;
  const portal = options.portal ?? portalDb();

  const commitCursor = async (next: SweepCursor | null, cycleComplete: boolean): Promise<boolean> => {
    const applied = await db.runTransaction(async (tx) => {
      const stored = readSweepCursor((await tx.get(stateRef)).data() ?? {});
      // 다른 실행이 그 사이 커서를 옮겼다면 이 회차의 진행은 이미 낡았다 — 덮어쓰면 되감김이거나
      // 상대의 완주 리셋을 지우는 것이다. 쓰지 않고 물러난다.
      if (!sameCursor(stored, expected)) return false;
      tx.set(stateRef, {
        cursorSubmittedAtIso: next?.submittedAtIso ?? "",
        cursorApplicationId: next?.applicationId ?? "",
        lastRunAtIso: nowIso,
        // 완주하지 못한 회차가 이전 완주 시각을 남겨두면 "이번에 한 바퀴 돌았다"로 오독된다.
        cycleCompletedAtIso: cycleComplete ? nowIso : FieldValue.delete(),
      }, { merge: true });
      return true;
    });
    if (applied) expected = next;
    return applied;
  };

  const processDoc = async (docId: string, data: Record<string, unknown>): Promise<SweepDocOutcome> => {
    const declared = data.declaredIdentity as Record<string, unknown> | undefined;
    // 수용 조건(handle **또는** name)과 대칭인 스킵 가드. handle 만 보던 예전 가드는 이름만 있는
    // 신원을 매 회차 포털 재조회 + 재기록하게 만들어 영구히 수렴하지 않았다.
    if (declared && (text(declared.handle, 120) || text(declared.name, 120))) return "already_declared";
    const identity = (data.identity ?? {}) as Record<string, unknown>;
    const applicationId = text(identity.applicationId, 180) || docId;
    try {
      const application = await portal.collection(PORTAL_APPLICATIONS_COLLECTION).doc(applicationId).get();
      if (!application.exists) return "portal_missing";
      const projection = declaredIdentityFromPortalAnswers((application.data() ?? {}).answers);
      if (!projection) return "empty_answers";
      if (declaredIdentityUnchanged(declared, projection)) return "already_declared";
      await db.collection(MANAGEMENT_COLLECTION).doc(docId).set(
        { declaredIdentity: { ...projection, backfilledAtIso: nowIso } },
        { merge: true },
      );
      return "backfilled";
    } catch (caught) {
      // 크로스 프로젝트 IAM 부재는 이 스윕의 예상된 실패 형상 — 조용히 삼키지 않고 결과로 보고한다.
      if (isPermissionDenied(caught)) return "permission_denied";
      if (isRetryableFailure(caught)) return "transient_failure";
      throw caught;
    }
  };

  let stopped = false;
  while (result.scanned < scanLimit && result.backfilled < backfillLimit) {
    const pageSize = Math.min(SWEEP_PAGE_SIZE, scanLimit - result.scanned);
    // 단일 필드 정렬 + 문서 id tiebreak — 복합 인덱스가 필요 없고(자동 단일필드 인덱스가 __name__ 을
    // 포함한다) 목록 표면(listApplicationManagementLifecycleFallbackRecords)과 같은 축이다.
    let query: FirebaseFirestore.Query = db
      .collection(MANAGEMENT_COLLECTION)
      .orderBy("submittedAtIso", "desc")
      .orderBy(FieldPath.documentId(), "desc");
    if (cursor) query = query.startAfter(cursor.submittedAtIso, cursor.applicationId);
    const snapshot = await query.limit(pageSize).get();
    const docs = snapshot.docs ?? [];
    if (docs.length === 0) {
      result.cycleComplete = true;
      break;
    }
    for (const doc of docs) {
      const data = doc.data() ?? {};
      const outcome = await processDoc(doc.id, data);
      if (outcome === "permission_denied" || outcome === "transient_failure") {
        if (outcome === "permission_denied") result.permissionDenied = true;
        else result.transientFailure = true;
        stopped = true;
        break;
      }
      // 거부·재시도성 실패로 끝난 문서는 훑은 것이 아니다 — 완전히 처리된 문서만 센다(과보고 금지).
      result.scanned += 1;
      cursor = { submittedAtIso: cursorText(data.submittedAtIso), applicationId: doc.id };
      committed = cursor;
      if (outcome === "already_declared") result.alreadyDeclared += 1;
      else if (outcome === "portal_missing") result.portalMissing += 1;
      else if (outcome === "empty_answers") result.emptyAnswers += 1;
      else {
        result.backfilled += 1;
        if (result.backfilled >= backfillLimit) break;
      }
    }
    // 백필 상한으로 페이지 중간에 멈췄거나 실패로 접었으면 "끝에 닿았다"고 볼 수 없다 — 커서를
    // 리셋하면 남은 뒷부분을 통째로 건너뛴다.
    if (!stopped && result.backfilled < backfillLimit && docs.length < pageSize) result.cycleComplete = true;
    // 완주 회차는 아래 리셋 커밋 한 번으로 끝낸다(중간 체크포인트를 겹쳐 쓰지 않는다).
    if (!result.cycleComplete && committed && !sameCursor(committed, expected)) {
      if (!(await commitCursor(committed, false))) {
        result.cursorContended = true;
        break;
      }
    }
    if (stopped || result.cycleComplete || result.backfilled >= backfillLimit) break;
    // 컬렉션 크기가 pageSize 의 배수로 딱 떨어지면 이 자리에서는 끝을 알 수 없어 다음 회차가 빈
    // 페이지 한 번(문서 0건)을 더 읽는다. 비용이 미미해 별도 경계 처리를 두지 않는다.
  }

  // 완주했으면 커서를 리셋해 신규분·실패분을 다음 회차가 다시 덮는다. 권한 부재·재시도성 실패로
  // 멈춘 회차는 여기서 아무것도 더 쓰지 않는다 — 위 페이지 경계 체크포인트가 남긴 "완전히 처리된
  // 지점"이 그대로 재개 지점이 된다(그마저 없으면 상태 문서는 손대지 않은 채로 남는다).
  if (result.cycleComplete && !(await commitCursor(null, true))) result.cursorContended = true;
  return result;
}
