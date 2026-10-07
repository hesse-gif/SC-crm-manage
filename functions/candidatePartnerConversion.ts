/**
 * Flu/Task-46 — 후보 회신 → 파트너 전환.
 *
 * Growth 조직의 파트너 정의(SCP 포털 비디오 검수 승인 기반, functions/partnerActivationCore.ts +
 * scp_partner_activations 컬렉션)는 여기서 절대 건드리지 않는다. 그 문서 스키마는 enrollmentId·
 * applicationId·programId·campaignId·portalCreatorId·fluCreatorId·integrationPartnerId 같은
 * SCP 전용 identity가 필수이고, getActivePartners의 행 빌더는 activationReason이
 * "video_current_revision_approved"가 아니면 fail-closed한다 — 회신 기반 전환을 억지로 그 문서
 * 모양에 맞추면 Growth 파트너 탭이 깨질 위험이 있다(0.6.69 회귀 0 요구와 정면 충돌). 대신 별도
 * 컬렉션(CANDIDATE_REPLY_PARTNERS_COLLECTION, functions/candidateTable.ts에서 export, source:
 * 'candidate_reply')에 AI Drama 전환만 적는다 — partnerActivationCore와 "같은 규칙"만 재사용한다:
 * status는 active|revoked 두 값뿐이고, revoked 후에는 자동으로 active로 되돌아가지 않는다
 * (planPartnerActivation의 "이미 revoked면 절대 재활성화하지 않는다" 불변식과 동일 — 본문은
 * SCP 전용 타입에 묶여 있어 재사용하지 않고, 이 파일에서 같은 규칙을 독립적으로 구현한다).
 *
 * 판정 기준(functions/mailHumanGate.ts INBOUND_INTENT_RULES 확장, 같은 티켓): 회신 텍스트가
 * 명시적 수락 문구면 partner_accept, 단가/일정 조건 문의면 price_inquiry로 규칙 분류되어
 * conversations.inboundIntent에 이미 저장돼 있다(receiveEmail이 새 LLM 호출 없이 규칙으로 계산 —
 * COST-P0-011). 이 파일은 그 값을 읽기만 할 뿐 어떤 분류도 새로 계산하지 않는다. 분류만으로는
 * 절대 전환하지 않는다 — 최종 전환은 이 두 콜러블(사람 확정, manager+)만 수행한다.
 */
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString, assertNonGuestAuth, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { CANDIDATE_POOL_COLLECTION, CANDIDATE_REPLY_PARTNERS_COLLECTION, channelIdFromCandidateRef } from "./candidateTable";
import { resolveMailAccountForEmail } from "./mailAccounts";
// Flu/Task-50 적대 리뷰 P0-3: super_admin "대신 보기" 검증 헬퍼 — 파트너 탭 데이터 소스 판정에도
// 같은 신원 검증(members 컬렉션 재조회)을 재사용한다.
import { resolveViewAsTarget } from "./mailAccountCallables";
import { resolvePartnerDataSourceForOrg, type PartnerDataSource } from "./orgTabPresets";

const CONVERSATIONS_COLLECTION = "conversations";

const READ_ROLES = ["super_admin", "admin", "manager", "viewer"] as const;
// candidateTable.ts WRITE_ROLES와 동일 등급 — 이 파일도 "전환/취소는 사람 확정(manager 이상)"
// 규칙을 따른다.
const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;

// ---------- 최소 구조적 Firestore 인터페이스(에뮬레이터 없이 테스트 가능) ----------
// functions/candidateTable.ts CandidateTableDb와 같은 목적의 최소 구조 타입.

interface CandidatePartnerDocSnapshot {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface CandidatePartnerDocRef {
  readonly id: string;
  get(): Promise<CandidatePartnerDocSnapshot>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
}
interface CandidatePartnerQuerySnapshot {
  readonly docs: CandidatePartnerDocSnapshot[];
}
interface CandidatePartnerQuery {
  where(field: string, op: "==" | "in", value: unknown): CandidatePartnerQuery;
  get(): Promise<CandidatePartnerQuerySnapshot>;
}
interface CandidatePartnerCollectionRef extends CandidatePartnerQuery {
  doc(id: string): CandidatePartnerDocRef;
}
export interface CandidatePartnerConversionDb {
  collection(name: string): CandidatePartnerCollectionRef;
}

function resolveDb(db?: CandidatePartnerConversionDb): CandidatePartnerConversionDb {
  return db ?? (adminDb as unknown as CandidatePartnerConversionDb);
}

function invalidArgument(errorCode: string, message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode });
}
function notFound(errorCode: string, message: string): Error {
  return Object.assign(new Error(`not-found: ${message}`), { code: "not-found", errorCode });
}
function failedPrecondition(errorCode: string, message: string): Error {
  return Object.assign(new Error(`failed-precondition: ${message}`), { code: "failed-precondition", errorCode });
}

// Task-46 적대 리뷰 LOW (2회차 수리): data.channelId와 candidateRef 파생값
// (channelIdFromCandidateRef) 둘 다 결국 client-supplied 문자열에서 나온다 — 그대로
// `.collection(CANDIDATE_REPLY_PARTNERS_COLLECTION).doc(channelId)`의 문서 ID로 쓰이므로 "/"가
// 섞이면 Firestore Admin SDK가 그 문자열을 하위 경로로 해석해 의도한 문서가 아닌 다른 위치를
// 가리킬 수 있다. candidateRef가 `CANDIDATE_POOL_COLLECTION/` 접두어 뒤에 추가 "/" 세그먼트를
// 포함한 채로 들어오면 fromRef 자체에 "/"가 남을 수 있으므로, 접두어를 벗겨낸 값이라도
// isSafeChannelId 검증을 동일하게 적용한다(신뢰값 취급 금지).
function isSafeChannelId(value: string): boolean {
  return value.length > 0 && !value.includes("/");
}

function resolveChannelId(data: Record<string, unknown>): string {
  const fromRef = channelIdFromCandidateRef(asString(data.candidateRef));
  if (isSafeChannelId(fromRef)) return fromRef;
  const fallback = asString(data.channelId);
  return isSafeChannelId(fallback) ? fallback : "";
}

// 후보의 가장 최근 partner_accept 회신이 달린 대화를 찾는다 — 클라이언트가 conversationId를
// 신뢰값으로 넘기지 않아도 되게 서버가 직접 근거를 재확인한다(회신 본문은 절대 읽지 않고
// inboundIntent 라벨만 본다, SEC-P0-009).
async function findAcceptConversationId(db: CandidatePartnerConversionDb, candidateRef: string): Promise<string | null> {
  const snapshot = await db.collection(CONVERSATIONS_COLLECTION).where("candidateRef", "==", candidateRef).get();
  let best: { id: string; decidedAtIso: string } | null = null;
  for (const doc of snapshot.docs) {
    if (!doc.exists) continue;
    const data = asRecord(doc.data());
    const intent = asRecord(data.inboundIntent);
    if (asString(intent.id) !== "partner_accept") continue;
    const decidedAtIso = asString(intent.decidedAtIso);
    if (!best || decidedAtIso > best.decidedAtIso) best = { id: doc.id, decidedAtIso };
  }
  return best?.id ?? null;
}

// ---------- convertCandidateToPartner ----------

export interface ConvertCandidateToPartnerDeps {
  db?: CandidatePartnerConversionDb;
  now?: () => number;
}

export async function convertCandidateToPartner(
  request: CallableRequestShape,
  deps: ConvertCandidateToPartnerDeps = {},
): Promise<Record<string, unknown>> {
  const ctx = assertNonGuestAuth(request, "candidatePartnerConversion.convert", WRITE_ROLES);
  const data = asRecord(request.data);
  const channelId = resolveChannelId(data);
  if (!channelId) {
    throw invalidArgument("candidate_partner_conversion_missing_candidate", "candidateRef is required");
  }
  const candidateRef = `${CANDIDATE_POOL_COLLECTION}/${channelId}`;
  const db = resolveDb(deps.db);
  const now = deps.now ?? (() => Date.now());
  const nowIso = new Date(now()).toISOString();

  const ref = db.collection(CANDIDATE_REPLY_PARTNERS_COLLECTION).doc(channelId);
  const existing = await ref.get();
  if (existing.exists) {
    const existingData = asRecord(existing.data());
    if (asString(existingData.status) === "revoked") {
      // partnerActivationCore의 "revoked면 절대 재활성화하지 않는다" 규칙과 동일.
      throw failedPrecondition(
        "candidate_partner_conversion_revoked_no_reactivation",
        "이미 취소된 파트너 전환은 자동으로 재활성화할 수 없습니다",
      );
    }
    // 이미 active — 중복 클릭에 안전한 멱등 응답.
    return {
      ok: true,
      channelId,
      candidateRef,
      conversationId: asString(existingData.conversationId) || null,
      status: "active",
      alreadyConverted: true,
      behaviorLog: makeBehaviorLog(ctx, "candidatePartnerConversion.convert", "success"),
    };
  }

  const poolSnap = await db.collection(CANDIDATE_POOL_COLLECTION).doc(channelId).get();
  if (!poolSnap.exists) {
    throw notFound("candidate_partner_conversion_candidate_not_found", `candidate ${channelId} not found`);
  }
  const poolData = asRecord(poolSnap.data());
  const conversationId = await findAcceptConversationId(db, candidateRef);

  await ref.set({
    source: "candidate_reply",
    candidateRef,
    channelId,
    conversationId,
    status: "active",
    acceptedAt: nowIso,
    acceptedBy: ctx.userId,
    name: asString(poolData.name),
    handle: asString(poolData.handle),
    platform: asString(poolData.platform, "YouTube"),
    email: asString(poolData.email) || null,
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  });

  return {
    ok: true,
    channelId,
    candidateRef,
    conversationId,
    status: "active",
    alreadyConverted: false,
    behaviorLog: makeBehaviorLog(ctx, "candidatePartnerConversion.convert", "success"),
  };
}

// ---------- revertCandidatePartnerConversion (취소) ----------

export interface RevertCandidatePartnerConversionDeps {
  db?: CandidatePartnerConversionDb;
  now?: () => number;
}

export async function revertCandidatePartnerConversion(
  request: CallableRequestShape,
  deps: RevertCandidatePartnerConversionDeps = {},
): Promise<Record<string, unknown>> {
  const ctx = assertNonGuestAuth(request, "candidatePartnerConversion.revert", WRITE_ROLES);
  const data = asRecord(request.data);
  const channelId = resolveChannelId(data);
  if (!channelId) {
    throw invalidArgument("candidate_partner_conversion_missing_candidate", "candidateRef is required");
  }
  const db = resolveDb(deps.db);
  const now = deps.now ?? (() => Date.now());
  const nowIso = new Date(now()).toISOString();

  const ref = db.collection(CANDIDATE_REPLY_PARTNERS_COLLECTION).doc(channelId);
  const existing = await ref.get();
  if (!existing.exists) {
    throw notFound("candidate_partner_conversion_not_found", `candidate ${channelId} has no partner conversion`);
  }
  const existingData = asRecord(existing.data());
  if (asString(existingData.status) === "revoked") {
    // 이미 취소됨 — 멱등 응답(재취소는 새 이력을 남기지 않는다).
    return {
      ok: true,
      channelId,
      status: "revoked",
      alreadyRevoked: true,
      behaviorLog: makeBehaviorLog(ctx, "candidatePartnerConversion.revert", "success"),
    };
  }

  await ref.set(
    {
      status: "revoked",
      revokedAt: nowIso,
      revokedBy: ctx.userId,
      revocationReasonCode: asString(data.reasonCode, "operator_correction"),
      updatedAtIso: nowIso,
    },
    { merge: true },
  );

  return {
    ok: true,
    channelId,
    status: "revoked",
    alreadyRevoked: false,
    behaviorLog: makeBehaviorLog(ctx, "candidatePartnerConversion.revert", "success"),
  };
}

// ---------- listCandidateReplyPartners (AI Drama 파트너 탭 전체 뷰) ----------
// Growth 파트너 탭(getActivePartners)과 완전히 분리된 읽기 경로 — candidate_pool과 마찬가지로
// org 파티션이 없는 전역 컬렉션이다(candidateTable.ts listCandidates와 동일 전제, 후보 시스템
// 전체가 org별 데이터 분리가 아니라 org별 탭 프리셋으로만 갈린다).
//
// Task-46 적대 리뷰 MEDIUM-1 (2026-09-11): 어떤 org가 이 콜러블을 호출해도 되는지는 더 이상
// 클라이언트(useNavPreset)를 신뢰하지 않는다 — getMyOrgContext와 같은 정의
// (functions/orgTabPresets.ts resolvePartnerDataSourceForOrg)로 호출자 org를 서버에서 재판정해,
// scp(Growth)로 판정되면 빈 목록을 돌려준다(권한 오류 대신 — 여기서는 읽기 권한(viewer+)은
// 그대로 검증하되, 데이터 자체는 scp 호출자에게 노출하지 않는다). 이메일 클레임 부재·org 조회
// 실패는 모두 안전한 기본값(scp/빈 목록)으로 떨어진다(fail-closed — 이 게이트는 UI 편의가
// 아니라 데이터 경로 게이트다).

export interface ListCandidateReplyPartnersDeps {
  db?: CandidatePartnerConversionDb;
  /** 기본값은 실제 getMyOrgContext와 같은 서버 판정(resolveMailAccountForEmail +
   *  resolvePartnerDataSourceForOrg, 둘 다 Firestore mail_accounts/mail_routing/
   *  settings/org_tab_presets를 읽는다). 테스트는 에뮬레이터 없이 이 훅만 주입해 org 판정을
   *  결정적으로 고정한다(tests/candidate-partner-conversion.test.mjs). */
  resolvePartnerDataSource?: (email: string | undefined) => Promise<PartnerDataSource>;
}

async function defaultResolveCallerPartnerDataSource(email: string | undefined): Promise<PartnerDataSource> {
  const normalizedEmail = asString(email, "").toLowerCase();
  if (!normalizedEmail) return "scp";
  try {
    const resolution = await resolveMailAccountForEmail(normalizedEmail);
    return await resolvePartnerDataSourceForOrg(resolution.orgId);
  } catch {
    return "scp";
  }
}

export async function listCandidateReplyPartners(
  request: CallableRequestShape,
  deps: ListCandidateReplyPartnersDeps = {},
): Promise<Record<string, unknown>> {
  const ctx = assertNonGuestAuth(request, "candidatePartnerConversion.list", READ_ROLES);
  // Flu/Task-50 적대 리뷰 P0-3: super_admin "대신 보기" 대상이 있으면(members 컬렉션으로 검증됨)
  // 호출자 자신이 아니라 대상자의 email로 partnerDataSource를 판정한다.
  const viewAsTarget = await resolveViewAsTarget(ctx, asRecord(request.data));
  const resolvePartnerDataSource = deps.resolvePartnerDataSource ?? defaultResolveCallerPartnerDataSource;
  const partnerDataSource = await resolvePartnerDataSource(viewAsTarget ? viewAsTarget.email : ctx.email);
  const db = resolveDb(deps.db);
  const snapshot = partnerDataSource === "candidate_reply"
    ? await db.collection(CANDIDATE_REPLY_PARTNERS_COLLECTION).where("status", "==", "active").get()
    : { docs: [] as CandidatePartnerDocSnapshot[] };
  const partners = snapshot.docs
    .filter((doc) => doc.exists)
    .map((doc) => {
      const d = asRecord(doc.data());
      return {
        channelId: doc.id,
        candidateRef: asString(d.candidateRef),
        conversationId: asString(d.conversationId) || null,
        name: asString(d.name),
        handle: asString(d.handle),
        platform: asString(d.platform, "YouTube"),
        email: asString(d.email) || null,
        acceptedAt: asString(d.acceptedAt),
        acceptedBy: asString(d.acceptedBy),
        source: "candidate_reply" as const,
      };
    });

  return {
    ok: true,
    partners,
    count: partners.length,
    behaviorLog: makeBehaviorLog(ctx, "candidatePartnerConversion.list", "success"),
  };
}
