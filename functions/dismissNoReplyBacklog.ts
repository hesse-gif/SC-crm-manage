// "미답장 인박스 dismiss 백로그 정리" (2026-09-26, 헤세 결정) — 이 기능이 배포되기 전부터
// 이미 waiting_for_human/draft_only 로 쌓여 있던 scp 대화 중, 재판정 결과 permitDenyReasons 에
// "sender_not_creator"(등록 크리에이터로 귀속 실패) 또는 "mail_safety_blocked"(퍼밋 게이트가
// 발송을 막음) 가 남아 있는 것만 dismiss(답장 없음 + Gmail 읽음 처리 + 인박스에서 제외) 한다.
// 실시간 경로(functions/chat-ai.ts persistReceivedEmail)의 DISMISS_ON_NO_REPLY_RULE_IDS(영업/
// 에이전시)와는 다른 축이다 — 그쪽은 이번 인바운드의 humanGate ruleIds를, 이 백로그는 이미
// 저장된 permitDenyReasons를 본다(헤세가 명시적으로 지정한 두 사유).
//
// **헤세 지시: 이 콜러블은 dryRun 기본값(true)으로만 배포한다 — 실제 실행(dryRun:false)은
// 헤세가 배포 후 직접 돌린다. 이 PR/워크트리에서는 호출하지 않는다.**
import { FieldPath, FieldValue, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString, assertNonGuestAuth, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { enqueueImapMarkRead } from "./mailImapMarkRead";
import { readCursor, type AutoReplyBacklogCursor } from "./autoReplyBacklog";
import {
  allReviewGateExcludingCounterOfferMatches,
  hasCurrencyAmount,
  isConfirmedAgencyOrManagementSender,
  isCounterOfferSignal,
  isHardStopSafety,
  isSoftDecline,
  isStatedMinorAge,
  isStatedPricePhrase,
} from "./mailHumanGate";
import { discoverInboundConversationAttribution } from "./conversationAttribution";
import { senderBindingBlockReason } from "./inboundSenderIdentity";
import { evaluateMailSafety } from "./mailSafetyPolicy";
import { CANONICAL_OPERATIONAL_MAILBOX_V1 } from "./mailIdentity";
import { normalizeEmailAddress } from "./mailSafetyShared";
import { extractQuotedOriginalRecipientEmail } from "./mailQuotedReplyAttribution";

// Codex 적대 리뷰(0.6.96 item 2, 11회차) — **알려진, 받아들여진 스케일 한계(scale limitation),
// 정확성/안전 버그 아님**: 각 array-contains 쿼리는 raw 매치 상위 200건만 가져온 뒤(정렬 없이,
// Firestore 문서 순서) 자격 필터를 적용한다. 한 사유(예: sender_not_creator)에 딸린 미처리
// 대화가 200건을 넘고, 이전 실행이 그 상위 200건 중 상당수를 이미 dismiss(그래도 permitDenyReasons
// 는 안 지워짐 — backlogReasonForRow/denyReasonSetFrom 는 dismiss 후에도 그대로 남는다)했다면,
// 재실행이 매번 같은 이미 처리된 200건만 다시 훑고 200번째를 못 넘는 시나리오가 이론상 가능하다
// (정렬 안 된 array-contains 쿼리라 "이미 처리된 것부터 온다"는 보장은 없지만, 반대도 보장 못
// 한다). 이 저장소의 실측 스캐폴딩(backfill-permit-deny-reasons-dryrun.mjs, 2026-09-26)이 이미
// 확인한 실제 규모는 sender_not_creator/mail_safety_blocked 합쳐 376건(두 개의 200-한도 쿼리에
// 각각 나뉘어 들어가므로 개별 쿼리가 200에 닿을 가능성은 낮다) — 지금 단계에서 커서 기반
// 페이지네이션을 새로 설계하는 것은 이 PR의 범위(TOCTOU/스푸핑 방지)를 벗어난다. 실행 전 dryRun
// 결과의 scanned 값이 200에 닿아 있으면(=쿼리가 상한에 걸렸다는 신호) 재검토하고, 필요해지면
// 별도 티켓으로 커서 페이지네이션을 추가한다.
const BACKLOG_SCAN_LIMIT = 200;
const BACKLOG_ELIGIBLE_STATUSES = new Set(["waiting_for_human", "draft_only"]);
const BACKLOG_DENY_REASONS = ["sender_not_creator", "mail_safety_blocked"] as const;

// Codex 적대 리뷰(2026-09-26, 2회차 재검증) BLOCKER 수리: permitDenyReasons 의
// "mail_safety_blocked" 는 퍼밋 게이트가 어떤 이유로든 자동발송을 막았다는 광범위한 신호일 뿐,
// "영업/미등록 발신자라 답장이 필요 없다"는 증거가 아니다. 1회차 수리는 저장된 사유 라벨
// (autoReplyBlockedReason)만 재검증해 원문 자체를 안 봤다 — 라벨이 비어 있거나 안 걸리면
// 통과했다(2회차 BLOCKER). 이 함수는 이제 message_sources 원문(subject+body)을 직접 재검증한다
// — chat-ai.ts persistReceivedEmail 의 dismiss 게이트와 같은 조합(원시 함수들 +
// reviewGateExcludingCounterOfferSignal, HUMAN_REVIEW_RULES 전체를 도는 하드닝된 헬퍼)이다.
//
// 헤세 정책 결정(2026-09-26, "agency/management/rep 답장도 마저 dismiss"): 소속사·매니저·대행사
// 담당자가 보낸 회신은 요율·역제안·완곡 거절을 함께 언급해도 dismiss 대상이다 — 남의 몫을 대신
// 협상하는 대행사는 이 채널로 직접 협상할 크리에이터가 아니다.
//
// Codex 적대 리뷰(2026-09-26, 3회차) BLOCKER 수리 — 1회차 구현의 문제 둘:
//   ① 느슨한 isAgencyOrManagementReply 매치 하나만으로 신원을 증명 삼아 보호를 전부 해제했다 —
//      크리에이터 본인이 "제 소속사(my management company)가 동의합니다" 처럼 그 단어를 자기
//      회신에 얼마든지 쓸 수 있어(코덱스 실측 재현 포함), 진짜 크리에이터의 가격 협상이 오탐으로
//      dismiss될 위험이 있었다 → isConfirmedAgencyOrManagementSender(1인칭 자기신원 표명만 인정,
//      "my manager"류 3인칭 언급은 배제)로 훨씬 좁힌다.
//   ② reviewGateExcludingCounterOfferSignal은 우선순위 배열 첫 매치에서 멈춰, agency 패턴이 배열
//      앞쪽이라 계약/법무/일정/정산분쟁/개인정보 같은 **agency와 무관한** 다른 보호 사유가 뒤에서
//      실제로 매치해도 가려졌다 → allReviewGateExcludingCounterOfferMatches(전체 매치 열거)로
//      "agency 말고 다른 사유가 정말 없다"를 직접 확인한다.
// 하드스톱 안전 신호와 미성년 자기신고(isHardStopSafety/isStatedMinorAge)는 발신자가 누구든
// 절대 우회하지 않는 고정 보호선으로 남긴다 — 이 둘을 가장 먼저 검사한다.
export function hasProtectedHoldSignal(text: string): boolean {
  if (isHardStopSafety(text) || isStatedMinorAge(text)) return true;

  // conv_13ioeao (2026-09-27, 헤세 지시 — quoted-reply 귀속 안전망): 회신이 우리가 실제 발송한
  // 주소와 다른 곳에서 왔더라도(개인 메일함 등), 본문에 우리 scp@ 발신을 가리키는 인용 헤더
  // 블록(Von/From/발신 + An/To/수신)이 남아 있으면 그 회신은 우리 아웃리치에 대한 진짜 응답일
  // 가능성이 높다 — inboundFromAddress 기반 귀속이 실패해(zero candidates) sender_not_creator 로
  // 떨어져도, 이 신호가 있으면 절대 자동 dismiss 하지 않는다(사람이 인박스에서 계속 본다). 이
  // 함수는 dismissAgencyAndUnregisteredSenderBacklogHandler(이 파일)와 chat-ai.ts persistReceivedEmail
  // 의 실시간 dismiss 가지(dismissForUnregisteredSender 등, `!hasProtectedHold` 로 게이트) 양쪽이
  // 공유하는 단일 정본이라, 여기 한 곳만 고치면 둘 다 보호된다.
  if (extractQuotedOriginalRecipientEmail(text)) return true;

  // agency-human-review 말고 다른 사유(계약/법무·옵트아웃/일정/정산분쟁/개인정보/모호/톤변화/
  // 통화없는-미팅요청/언론제휴)가 하나라도 매치하면, 발신자가 누구든 절대적으로 보호한다 —
  // 이번 정책 변경의 범위 밖이다.
  const otherHolds = allReviewGateExcludingCounterOfferMatches(text).filter((ruleId) => ruleId !== "agency-human-review");
  if (otherHolds.length > 0) return true;

  // agency-human-review 만 매치했거나 아무 카테고리도 매치하지 않았다 — 남은 것은
  // 통화금액/가격진술/역제안/완곡거절뿐이다. 이것도 없으면 보호할 것이 전혀 없다(agency 단독
  // 매치도 이 지점에서 이미 통과 — "가격 언급 없는 순수 agency 문의"도 dismiss 대상이라는
  // 헤세 정책과 일치한다).
  const priceOrNegotiationSignal =
    hasCurrencyAmount(text) || isStatedPricePhrase(text) || isCounterOfferSignal(text) || isSoftDecline(text);
  if (!priceOrNegotiationSignal) return false;

  // 통화·가격·역제안·완곡거절 신호가 있다 — 발신자가 1인칭으로 자신을 대행사/매니저/담당자라고
  // 확실히 밝힌 경우에만 보호를 해제한다(그 외엔 진짜 크리에이터의 가격 협상일 수 있으므로 그대로
  // 보호).
  return !isConfirmedAgencyOrManagementSender(text);
}

export interface DismissNoReplyBacklogSample {
  readonly id: string;
  readonly reason: (typeof BACKLOG_DENY_REASONS)[number];
}

export interface DismissNoReplyBacklogEnvelope {
  ok: true;
  dryRun: boolean;
  scanned: number;
  matched: number;
  dismissed: number;
  sample: DismissNoReplyBacklogSample[];
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
}

function backlogReasonForRow(row: Record<string, unknown>): (typeof BACKLOG_DENY_REASONS)[number] {
  const denyReasons = Array.isArray(row.permitDenyReasons) ? row.permitDenyReasons : [];
  return denyReasons.includes("sender_not_creator") ? "sender_not_creator" : "mail_safety_blocked";
}

/**
 * scp 대화만 대상이다(mailAccountId가 비어 있는 레거시 행은 scp 공유 사서함 기본값 — 기존
 * isAutoReplyOrgExcluded 등과 같은 관례) — 개인 계정은 이 백로그가 절대 건드리지 않는다.
 */
function isScpConversationRow(row: Record<string, unknown>): boolean {
  const mailAccountId = asString(row.mailAccountId);
  return mailAccountId === "" || mailAccountId === "scp";
}

export interface BacklogCandidateRow {
  readonly doc: QueryDocumentSnapshot;
  readonly row: Record<string, unknown>;
  readonly lastMessageRef: string;
}

export interface BacklogCandidateScan {
  // Codex 적대 리뷰(0.6.96 item 2, 1회차) HIGH 수리: 이 필드는
  // dismissAgencyAndUnregisteredSenderBacklogHandler 가 이미 응답 계약으로 내보내던
  // `scanned`(필터링 전, 두 array-contains 쿼리의 원시 매치 합집합 크기)와 정확히 같은 뜻이어야
  // 한다 — 리팩터 전에는 `byId.size` 였다. 후보 필터(scp/상태/발신자/lastMessageRef)를 통과한
  // 개수와 섞이면 기존 콜러블의 응답 계약이 조용히 바뀐다.
  readonly totalMatched: number;
  readonly rows: readonly BacklogCandidateRow[];
}

/**
 * dismissAgencyAndUnregisteredSenderBacklogHandler 와 backfillInboundMailProvenanceHandler
 * (0.6.96 item 2) 가 공유하는 후보 스캔 — 두 콜러블이 "어떤 conversations 행이 이 백로그
 * 대상인가"에 대해 서로 다른 정의를 갖는 드리프트를 막는다(scp 스코프·상태·마지막 발신자·
 * lastMessageRef 존재는 두 기능 모두에게 동일한 전제여야 한다).
 */
async function fetchBacklogCandidateRows(): Promise<BacklogCandidateScan> {
  const [bySenderNotCreator, byMailSafetyBlocked] = await Promise.all([
    adminDb.collection("conversations")
      .where("permitDenyReasons", "array-contains", "sender_not_creator")
      .limit(BACKLOG_SCAN_LIMIT)
      .get(),
    adminDb.collection("conversations")
      .where("permitDenyReasons", "array-contains", "mail_safety_blocked")
      .limit(BACKLOG_SCAN_LIMIT)
      .get(),
  ]);
  const byId = new Map<string, QueryDocumentSnapshot>();
  for (const doc of [...bySenderNotCreator.docs, ...byMailSafetyBlocked.docs]) byId.set(doc.id, doc);

  const rows: BacklogCandidateRow[] = [];
  for (const doc of byId.values()) {
    const row = asRecord(doc.data());
    if (!isScpConversationRow(row)) continue;
    if (!BACKLOG_ELIGIBLE_STATUSES.has(asString(row.autoReplyStatus))) continue;
    // 여전히 창작자 인바운드가 마지막 메시지인 행만 대상이다 — listUnrepliedInboxHandler 의
    // 필터와 같은 축(defense in depth). 사람이 이미 답장했으면(mailReplyFrom!=="creator")
    // dismiss 할 이유 자체가 없다.
    if (asString(row.lastMessageFrom) !== "creator") continue;
    const lastMessageRef = asString(row.lastMessageRef);
    if (!lastMessageRef) continue;
    rows.push({ doc, row, lastMessageRef });
  }
  return { totalMatched: byId.size, rows };
}

// ── 0.6.97: pre-0.6.95 scp 백로그 전체 재판정 페이지네이션 스캔 (2026-09-26, 헤세 승인) ──────
//
// 위 fetchBacklogCandidateRows (array-contains) 는 conversations.permitDenyReasons 가 이미
// "sender_not_creator"/"mail_safety_blocked" 를 담고 있는 행만 찾을 수 있다 — array-contains 쿼리의
// 정의상 그 필드가 아예 없는 문서는 절대 매치하지 않는다. 이 백필 기능 자체가 배포되기 전부터
// waiting_for_human/draft_only 로 쌓여 있던 scp 대화(약 324건)는 permitDenyReasons 필드 자체가
// 없어 지금까지 한 번도 재판정 대상이 되지 못했다(0.6.96 백필 실행이 376건 중 7건만 스캔한 근인).
// 이 함수는 permitDenyReasons 유무와 무관하게 status+lastMessageFrom 만으로 conversations 를
// 커서 기반(startAfter) 페이지네이션 스캔한다 — autoReplyBacklog.ts defaultQueryCandidates /
// read.ts listUnrepliedInboxHandler 와 바이트 단위로 같은 쿼리 모양(lastMessageFrom=="creator" +
// autoReplyStatus in [...] + lastInboundAtIso asc + __name__ asc)이라 같은 복합 인덱스를 그대로
// 재사용한다(새 인덱스 배포 불필요). 커서 파싱은 autoReplyBacklog.ts 의 하드닝된 readCursor를
// 그대로 재사용한다(정본 캐노니컬 ISO·안전 문서 id 검증을 다시 구현하지 않는다).
const FULL_BACKLOG_SCAN_DEFAULT_PAGE_SIZE = 50;
const FULL_BACKLOG_SCAN_MAX_PAGE_SIZE = BACKLOG_SCAN_LIMIT;

export type BacklogScanMode = "array_contains" | "full_backlog";

export interface BacklogCandidatePage {
  readonly rows: readonly BacklogCandidateRow[];
  readonly scannedInPage: number;
  readonly nextCursor: string | null;
}

export function clampFullBacklogPageSize(value: unknown): number {
  const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : FULL_BACKLOG_SCAN_DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(FULL_BACKLOG_SCAN_MAX_PAGE_SIZE, num));
}

/**
 * 순수 함수로 분리해서(Firestore 없이) 페이지네이션 커서 계산을 직접 실행 테스트할 수 있게 한다 —
 * code-reviewer 지적(2026-09-26): 이 계산이 소스-텍스트 계약 테스트로만 덮여 있으면 런타임
 * 오프바이원/커서 로직 자체는 한 번도 실행되지 않는다.
 *
 * 꽉 찬 페이지(docs.length >= pageSize)의 마지막 문서가 안전한 커서 값(비어 있지 않은
 * lastInboundAtIso)을 못 주면, 조용히 null(="백로그 소진")을 반환하지 않고 fail-closed 로
 * 던진다 — code-reviewer MEDIUM 수리: 조용한 null 은 "백로그 소진"과 똑같이 보여, 커서를 못 만든
 * 그 문서 뒤에 남아 있을 수 있는 나머지 행이 경고 없이 통째로 스캔에서 빠질 위험이 있었다.
 */
export function computeFullScanNextCursor(
  scannedDocs: readonly { readonly id: string; readonly lastInboundAtIso: string }[],
  pageSize: number,
): string | null {
  if (scannedDocs.length < pageSize) return null; // 짧은 페이지 — 이 상태 창을 다 스캔했다.
  const lastDoc = scannedDocs[scannedDocs.length - 1];
  if (!lastDoc || !lastDoc.lastInboundAtIso) {
    throw new Error(
      "fetchBacklogCandidateRowsFullScan: full page but the last document has no usable lastInboundAtIso — refusing to silently report the backlog as exhausted",
    );
  }
  return JSON.stringify({ lastInboundAtIso: lastDoc.lastInboundAtIso, id: lastDoc.id });
}

/**
 * status+lastMessageFrom 만으로 conversations 를 한 페이지(pageSize) 스캔한다. 반환된 rows는
 * fetchBacklogCandidateRows 와 동일한 BacklogCandidateRow 모양이라, 호출자(아래
 * backfillInboundMailProvenanceHandler)의 나머지 처리(원문 재검증·결정론적 재판정·TOCTOU
 * 트랜잭션)는 후보의 출처(array-contains vs 전체 스캔)와 무관하게 완전히 동일하게 재사용된다.
 *
 * nextCursor 는 requeueAutoReplyBacklog(autoReplyBacklog.ts) 와 동일한 계약이다 — 이번 페이지가
 * pageSize 미만으로 돌아오면(=이 상태 창을 다 스캔했다는 뜻) null, 꽉 찬 페이지면 마지막 문서의
 * (lastInboundAtIso, id)를 담은 불투명 JSON 문자열이다.
 */
async function fetchBacklogCandidateRowsFullScan(
  cursor: AutoReplyBacklogCursor | null,
  pageSize: number,
): Promise<BacklogCandidatePage> {
  let query = adminDb
    .collection("conversations")
    .where("lastMessageFrom", "==", "creator")
    .where("autoReplyStatus", "in", [...BACKLOG_ELIGIBLE_STATUSES])
    .orderBy("lastInboundAtIso", "asc")
    .orderBy(FieldPath.documentId(), "asc")
    .limit(pageSize);
  if (cursor) query = query.startAfter(cursor.lastInboundAtIso, cursor.id);
  const snapshot = await query.get();

  const rows: BacklogCandidateRow[] = [];
  for (const doc of snapshot.docs) {
    const row = asRecord(doc.data());
    if (!isScpConversationRow(row)) continue;
    const lastMessageRef = asString(row.lastMessageRef);
    if (!lastMessageRef) continue;
    rows.push({ doc, row, lastMessageRef });
  }

  const nextCursor = computeFullScanNextCursor(
    snapshot.docs.map((doc) => ({ id: doc.id, lastInboundAtIso: asString(asRecord(doc.data()).lastInboundAtIso) })),
    pageSize,
  );

  return { rows, scannedInPage: snapshot.docs.length, nextCursor };
}

async function resolveBackfillCandidatePage(
  scanMode: BacklogScanMode,
  cursor: AutoReplyBacklogCursor | null,
  pageSize: number,
): Promise<BacklogCandidatePage> {
  if (scanMode === "full_backlog") return fetchBacklogCandidateRowsFullScan(cursor, pageSize);
  const { totalMatched, rows } = await fetchBacklogCandidateRows();
  return { rows, scannedInPage: totalMatched, nextCursor: null };
}

export async function dismissAgencyAndUnregisteredSenderBacklogHandler(
  request: CallableRequestShape,
): Promise<DismissNoReplyBacklogEnvelope> {
  const auth = assertNonGuestAuth(request, "mail.dismissAgencyAndUnregisteredSenderBacklog", ["super_admin"]);
  const requestData = asRecord(request.data);
  // dryRun 기본값은 반드시 true — 헤세가 배포 후 직접 dryRun:false 로 실행한다.
  const dryRun = requestData.dryRun !== false;

  const { totalMatched, rows: candidates } = await fetchBacklogCandidateRows();

  let matched = 0;
  let dismissed = 0;
  const sample: DismissNoReplyBacklogSample[] = [];
  const nowIso = new Date().toISOString();

  for (const { doc, row, lastMessageRef } of candidates) {
    // Codex 적대 리뷰(2026-09-26, 2회차) HIGH/신규 수리: lastMessageRef 를 맹신하지 않고, dryRun
    // 여부와 무관하게 항상 먼저 검증한다 — dryRun 결과가 실제 실행(dryRun:false)의 정직한
    // 미리보기가 되려면 같은 검증을 반드시 같은 순서로 통과해야 한다(1회차 수리는 dryRun 이면
    // 이 검증 전체를 건너뛰어 dryRun 이 실제보다 더 많이 "matched" 로 보고했다).
    const sourceSnapshot = await adminDb.doc(lastMessageRef).get();
    const sourceData = asRecord(sourceSnapshot.data());
    if (
      !sourceSnapshot.exists ||
      asString(sourceData.conversationId) !== doc.id ||
      asString(sourceData.direction) !== "inbound"
    ) continue;
    const provenance = asRecord(sourceData.inboundMailProvenance);
    if (provenance.kind !== "imap" || asString(provenance.accountId) !== "scp") continue;

    // Codex 적대 리뷰(2026-09-26, 2회차) BLOCKER 수리: 저장된 사유 라벨이 아니라 실제
    // message_sources 원문(subject+body)을 재검증한다 — 라벨이 비어 있어도 원문에 보호 신호가
    // 있으면 걸러야 한다.
    const sourceText = `${asString(sourceData.subject)}\n${asString(sourceData.body)}`;
    if (hasProtectedHoldSignal(sourceText)) continue;
    // A source that now carries a current VERIFIED sender binding (e.g. repaired after the stale
    // sender_not_creator reason was recorded) is an identified creator reply: never dismissed here.
    // identity_only (verified exact address, program unresolved) is equally an identified creator: held for a human when the
    // kill switch is off or the case needs program facts, but never auto-dismissed as "not a creator".
    const bindingBlock = senderBindingBlockReason(sourceData, { allowIdentityOnly: true });
    if (bindingBlock === "" || bindingBlock === "identity_only_case_needs_program") continue;
    if (bindingBlock === "identity_only_disabled") continue;

    matched += 1;
    const reason = backlogReasonForRow(row);
    const scannedDenyReasons = denyReasonSetFrom(row.permitDenyReasons);
    const scannedSourceFingerprint = sourceDecisionFingerprint(sourceData);
    if (sample.length < 20) sample.push({ id: doc.id, reason });
    if (dryRun) continue;

    // Codex 적대 리뷰(2026-09-26, 2회차 + 0.6.96 item 2, 4·5회차) 수리: 트랜잭션으로 다시 한번
    // 최신 상태를 읽어 이 스캔 이후 대화/원문이 이미 바뀌지 않았는지 확인한 뒤에만 쓴다(TOCTOU
    // 방지) — 이 스캔은 오래 걸릴 수 있어 그 사이 실제 인바운드(또는 같은 messageRef 재전송)가
    // 새로 도착했을 수 있다. 4회차 BLOCKER 수리: autoReplyStatus/lastMessageFrom/lastMessageRef
    // 만으로는 부족했다(permitDenyReasons 만 바뀌는 case_already_reserved 재시도 경로). 5회차
    // BLOCKER 수리: 그것도 부족했다 — lastMessageRef·permitDenyReasons 는 그대로인 채
    // message_sources 원문(subject/body/provenance/imap)만 재전송으로 덮어써도(같은 messageRef,
    // merge:true) 이 판정이 근거로 삼은 hasProtectedHoldSignal(sourceText) 결과 자체가 stale
    // 해질 수 있었다 — sourceDecisionFingerprint 로 원문까지 통째로 재확인한다.
    const committed = await adminDb.runTransaction(async (transaction) => {
      const freshSnapshot = await transaction.get(doc.ref);
      const freshRow = asRecord(freshSnapshot.data());
      const freshSourceSnapshot = await transaction.get(sourceSnapshot.ref);
      const freshSourceData = asRecord(freshSourceSnapshot.data());
      if (
        !freshSnapshot.exists ||
        // Codex 적대 리뷰(0.6.96 item 2, 7회차) BLOCKER 수리: mailAccountId 도 판정 입력이다 —
        // isScpConversationRow(row) 가 스캔 시점에 scp 스코프를 걸렀지만, 쓰기 시점에 다른
        // mail_accounts 로 바뀌었을 수 있는데 재확인하지 않았다(개인 계정 대화를 조용히
        // dismiss 하지 않는다는 전제가 스캔 시점에만 유효했다).
        !isScpConversationRow(freshRow) ||
        !BACKLOG_ELIGIBLE_STATUSES.has(asString(freshRow.autoReplyStatus)) ||
        asString(freshRow.lastMessageFrom) !== "creator" ||
        asString(freshRow.lastMessageRef) !== lastMessageRef ||
        !sameStringSet(denyReasonSetFrom(freshRow.permitDenyReasons), scannedDenyReasons) ||
        !freshSourceSnapshot.exists ||
        sourceDecisionFingerprint(freshSourceData) !== scannedSourceFingerprint
      ) return false;
      transaction.set(
        doc.ref,
        {
          autoReplyStatus: "dismissed_no_reply",
          dismissedNoReplyReason: reason,
          dismissedAtIso: nowIso,
          nextAutoReplyAtIso: FieldValue.delete(),
          autoReplyDraftText: FieldValue.delete(),
          autoReplyQueueRef: FieldValue.delete(),
        },
        { merge: true },
      );
      return true;
    });
    if (!committed) continue;
    // Gmail 읽음 표시 — best-effort, 실패해도 dismiss 자체는 이미 커밋됐다.
    const imap = asRecord(sourceData.imap);
    await enqueueImapMarkRead({
      mailAccountId: "scp",
      mailbox: imap.mailbox,
      uid: imap.uid,
      uidValidity: imap.uidValidity,
      conversationId: doc.id,
      sourceRef: lastMessageRef,
      reason: "dismissed_no_reply",
    });
    dismissed += 1;
  }

  return {
    ok: true,
    dryRun,
    scanned: totalMatched,
    matched,
    dismissed,
    sample,
    behaviorLog: makeBehaviorLog(auth, "mail.dismissAgencyAndUnregisteredSenderBacklog", "success"),
  };
}

// ── 0.6.96 item 2: inboundMailProvenance 백필 (2026-09-26, 헤세 결정) ──────────────────────────
//
// 0.6.95 이전 scp 백로그 대화 376건 중 324건은 message_sources 문서에 inboundMailProvenance 가
// 아예 없다(이 필드는 0.6.95 에서 신설됐다) — 그래서 dismissAgencyAndUnregisteredSenderBacklog 의
// `provenance.kind !== "imap" || accountId !== "scp"` 가드에 전부 걸려 스킵된다. 이 콜러블은 그
// 324건을 message_sources 문서 자신 안의 **검증 가능한 증거만으로** provenance 를 채운다 — LLM
// 없이, message_sources.imap(mailbox/uid/uidValidity — 실제 IMAP fetch 가 아니면 존재하지 않는
// 메타데이터. mailImapLive.ts liveInboundFromParsed 참고) 이 온전한 형태로 있는지만 본다.
//
// scp 단일 사서함 시대(PLAN-ORG-MAIL-IDENTITY Slice 4 이전)에는 readImapLatestLive 가 유일한
// IMAP 리더였고 mailAccountId:"scp" 를 하드코딩했다(mailImapLive.ts). Slice 4 이후에는 다른
// mail_accounts 도 IMAP 을 가질 수 있으므로, message_sources.imap.user(그 IMAP 로그인 계정) 가
// 있다면 CANONICAL_OPERATIONAL_MAILBOX_V1("scp@supercent.io")과 일치하는지 추가로 확인한다 —
// 있는데 다르면 "non-scp" 로 건너뛴다(모호하면 절대 찍지 않는다). 없으면(옛 스키마) 이미
// isScpConversationRow 로 대화 자체가 scp 스코프임을 확인했으므로 그대로 인정한다.
//
// Codex 적대 리뷰(0.6.96 item 2, 1회차) BLOCKER 수리: message_sources.imap 하나만으로는 증거가
// 스푸핑 가능하다 — 공개 receiveEmail 콜러블은 internalTrustedInvocation 이 아닌 호출자에게서도
// `skipLiveImapRead:true` + `imap:{mailbox,uid,uidValidity,user}` 를 그대로 받아 persistReceivedEmail
// 이 sourceData.imap 에 고스란히 저장한다(chat-ai.ts persistReceivedEmail 의
// `else { const ingestImap = asRecord(data.ingestImap || data.imap); ... }` 분기 — readImapLatest 가
// skipLiveImapRead:true 면 null 을 반환해 inboundMail 이 없어지고, 이 else 분기가 캐치되지 않은
// data.imap 을 그대로 믿는다). imap.user 일치 확인만으로는 공격자가 정확한 문자열
// "scp@supercent.io" 를 그대로 적으면 무력화된다.
//
// 그래서 mail_ingest_cursors 컬렉션과 교차검증한다 — 이 컬렉션은 신뢰된 인입 경로(워커의
// mailImapIngest.ts advanceCursor/advanceLiveCursor, 또는 chat-ai.ts 의 inboundMail.imap.
// cursorAdvanceAllowed 분기, 전부 request.internalTrustedInvocation===true 로만 도달 가능 —
// 그 필드는 request.data 가 아니라 request 객체 자체에 있어 공개 콜러블 경계를 넘어오는 어떤
// caller-supplied 값으로도 절대 설정할 수 없다)로만 전진한다. skipLiveImapRead:true 로 위조된
// 호출은 inboundMail 이 null 이라 이 커서 전진 분기 자체가 통째로 스킵된다 — 즉 어떤 위조
// imap 값을 넣어도 실제로 mail_ingest_cursors 가 그 uid 까지 전진했다는 기록은 만들 수 없다.
// (잔여 위험: 공격자가 실제로 존재했던 과거 uidValidity·그 안에서 이미 커서가 도달한 uid 범위를
// 정확히 알아맞히면 여전히 통과한다 — 하지만 이는 "아무 값이나 넣으면 통과"에서 "실제 IMAP
// 인입 이력의 정확한 좌표를 미리 알아야 통과"로 공격 표면을 근본적으로 좁힌다. 이 잔여 위험은
// 실제 실행 전 필수 사람 샘플링 검토(§운영 런북)의 몫으로 남긴다 — mailHumanGate.ts 의 기존
// "받아들여진 잔여 위험" 관례와 동일한 구조다.)
//
// 동시에 permitDenyReasons(sender_not_creator/mail_safety_blocked) 도 결정론적으로 재판정한다 —
// 저장된 사유가 몇 주 전 판정일 수 있고, 그 사이 크리에이터가 candidate_pool/프로그램에 등록됐거나
// 억제 목록이 바뀌었을 수 있다. 둘 다 결정론적 기존 함수 재사용(LLM 호출 없음):
//   - sender_not_creator → discoverInboundConversationAttribution (Firestore 조회만, 모델 없음)
//   - mail_safety_blocked → evaluateMailSafety(..., "receive") (블랙리스트/억제 목록 판정, 모델 없음)
// 재판정 결과 둘 다 더 이상 성립하지 않으면(진짜 크리에이터로 새로 귀속됐거나 억제가 풀렸으면) 그
// 대화는 이 백로그 대상에서 완전히 빠져야 한다 — provenance 는 찍지 않고, permitDenyReasons 에서
// 두 사유만 제거한다(인박스에 남아 사람이 본다 — "귀속만 실패했던 진짜 크리에이터 문의는 반드시
// 인박스에 남아야 한다"는 헤세 지시와 일치).
//
// **헤세 지시: 이 콜러블도 dryRun 기본값(true)으로만 배포한다 — 실제 실행은 헤세가 배포 후
// 직접 돌린다. 이 PR/워크트리에서는 호출하지 않는다.**

const IMAP_PROVENANCE_ACTIONS = [
  "stamped",
  "skipped_ambiguous_imap_evidence",
  "skipped_already_has_provenance",
  "permit_deny_reasons_revised_no_longer_eligible",
  // 재판정 결과 더 이상 대상이 아니고(stillEligibleForBacklog===false), permitDenyReasons 도
  // 바뀔 게 없다 — 이 행에 대해 아무것도 쓰지 않는다(진짜 아무 변화 없음).
  "not_eligible_no_change",
  // Codex 적대 리뷰(0.6.96 item 2, 2회차) BLOCKER 수리: 스캔 이후 이 대화의 lastMessageRef 가
  // 바뀌었다(새 인바운드 도착 등) — TOCTOU 트랜잭션이 아무것도 쓰지 않고 건너뛰었다.
  "skipped_conversation_changed_since_scan",
] as const;

export interface BackfillInboundMailProvenanceSample {
  readonly id: string;
  readonly conversationId: string;
  readonly action: (typeof IMAP_PROVENANCE_ACTIONS)[number];
}

export interface BackfillInboundMailProvenanceEnvelope {
  ok: true;
  dryRun: boolean;
  scanMode: BacklogScanMode;
  scanned: number;
  eligible: number;
  stamped: number;
  skippedAmbiguous: number;
  skippedAlreadyStamped: number;
  permitDenyReasonsRevised: number;
  // full_backlog 모드에서만 값이 있다 — 다음 페이지를 이어서 스캔하려면 이 값을 그대로
  // requestData.cursor 로 넘긴다. array_contains 모드(기본값)는 항상 null(이 모드는 페이지네이션
  // 대상이 아니다 — 기존 배포와 동일한 단일 스캔).
  nextCursor: string | null;
  sample: BackfillInboundMailProvenanceSample[];
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
}

export interface ImapCursorAdvancement {
  readonly mailbox: string;
  readonly uidValidity: string;
  readonly lastUid: number;
}

/**
 * mail_ingest_cursors 전체를 한 번만 읽어온다(handler당 1회 — 후보마다 다시 읽지 않는다). 이
 * 컬렉션은 신뢰된 인입 경로만 쓴다(위 헤더 주석) — mailbox/uidValidity/lastUid 필드만 뽑아
 * 메모리에서 후보별로 대조한다(문서 id 해시 방식이 mailImapIngest.ts 의 legacy 큐 경로와
 * mailImapLive.ts 의 live 경로가 서로 달라, id로 직접 조회하지 않고 필드 값으로 대조한다).
 *
 * Codex 적대 리뷰(0.6.96 item 2, 2회차) BLOCKER 수리: 커서를 user 로 거르지 않으면, 자기 자신의
 * 연동 개인 메일함(Slice 4 워크스페이스 계정)을 가진 아무나 그 계정의 실제 커서 좌표(mailbox·
 * uidValidity·lastUid — 전부 본인 계정이라 정당하게 열람 가능)를 그대로 읽어 imap.user 만
 * "scp@supercent.io" 로 바꿔 제출하면 통과했다 — SCP 의 과거 좌표를 몰라도 스푸핑이 가능해
 * 애초에 이 교차검증이 막으려던 위협보다 더 쉬운 우회였다. scp 정본 계정(user 가
 * CANONICAL_OPERATIONAL_MAILBOX_V1) 소유 커서만 남긴다 — 다른 계정 커서는 애초에 후보군에서
 * 제외되므로 hasWellFormedScpImapEvidence 는 더 이상 "어떤 계정이든 커서만 맞으면 통과"가 될 수
 * 없다.
 */
export async function fetchMailIngestCursorAdvancements(): Promise<ImapCursorAdvancement[]> {
  const snapshot = await adminDb.collection("mail_ingest_cursors").get();
  const advancements: ImapCursorAdvancement[] = [];
  for (const cursorDoc of snapshot.docs) {
    const data = asRecord(cursorDoc.data());
    if (normalizeEmailAddress(asString(data.user)) !== CANONICAL_OPERATIONAL_MAILBOX_V1) continue;
    advancements.push({
      mailbox: asString(data.mailbox),
      uidValidity: asString(data.uidValidity),
      lastUid: typeof data.lastUid === "number" && Number.isFinite(data.lastUid) ? data.lastUid : -1,
    });
  }
  return advancements;
}

/**
 * message_sources.imap 이 실제 IMAP fetch 를 통해서만 생길 수 있는 형태(mailbox/uidValidity 는
 * 비지 않은 문자열, uid 는 양의 정수)를 갖췄는지, imap.user 가 있다면 scp 정본 사서함과
 * 일치하는지, 그리고 — 결정적으로 — scp 정본 계정 소유 mail_ingest_cursors(위 fetch 단계에서
 * 이미 user 로 걸러짐) 중 같은 mailbox+uidValidity 조합의 커서가 이 uid 까지 실제로 전진해
 * 있는지(=scp 신뢰된 인입 경로가 이 좌표를 실제로 처리한 적이 있다는 독립 증거)까지 전부
 * 확인한다. 하나라도 애매하면 false(스탬프하지 않는다).
 */
export function hasWellFormedScpImapEvidence(
  imap: Record<string, unknown>,
  scpCursorAdvancements: readonly ImapCursorAdvancement[],
): boolean {
  const mailbox = asString(imap.mailbox);
  const uidValidity = asString(imap.uidValidity);
  // Codex 적대 리뷰(0.6.96 item 2, 1회차) 수리: Number.isFinite 만으로는 1.5 같은 소수 uid 도
  // "양의 정수"로 통과했다 — 실제 IMAP UID는 항상 정수다.
  const uid = typeof imap.uid === "number" && Number.isInteger(imap.uid) ? imap.uid : 0;
  if (!mailbox || !uidValidity || uid <= 0) return false;
  const imapUser = asString(imap.user);
  if (imapUser && normalizeEmailAddress(imapUser) !== CANONICAL_OPERATIONAL_MAILBOX_V1) return false;
  return scpCursorAdvancements.some(
    (cursor) => cursor.mailbox === mailbox && cursor.uidValidity === uidValidity && cursor.lastUid >= uid,
  );
}

function denyReasonSetFrom(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
}

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

/**
 * dismissAgencyAndUnregisteredSenderBacklogHandler 와 backfillInboundMailProvenanceHandler 가
 * 스캔 시점에 읽은 message_sources 문서 중, 실제로 dismiss/backfill 판정에 쓰인 필드만 뽑아
 * 필드별로 명시 직렬화한다(중첩 객체를 통째로 JSON.stringify 하지 않는다 — Firestore 가 같은
 * 문서를 두 번 읽어도 내부 키 순서가 달라질 가능성을 원천 차단하기 위해 leaf 값만 뽑아 고정된
 * 순서로 나열한다).
 *
 * Codex 적대 리뷰(0.6.96 item 2, 5회차) BLOCKER 수리: 같은 messageRef 를 가리키는 인바운드
 * 재전송(persistReceivedEmail 은 항상 merge:true)이 스캔과 트랜잭션 사이에 subject/body/발신자
 * 정보/provenance/imap 좌표를 다른 값으로 덮어쓸 수 있다 — 4회차까지는 lastMessageRef·
 * permitDenyReasons(dismiss)나 imap 좌표만(backfill) 개별로 재확인했는데, 실측 재현(Codex 5회차):
 * 스캔은 보호되지 않은 원문("We are the agency for this creator.")을 봤지만, 트랜잭션 직전
 * 재전송이 같은 messageRef 에 진짜 크리에이터의 가격 협상("I am the creator. My rate is $500 for
 * a video.")을 덮어써도 lastMessageRef·permitDenyReasons 는 그대로라 두 콜러블 모두 그대로
 * 커밋했다. 판정에 실제로 쓰인 원문 자체가 트랜잭션 시점에도 스캔 때와 정확히 같은지 이
 * 지문으로 직접 대조한다 — 개별 필드를 하나씩 뒤쫓는 대신, 판정에 관련된 모든 leaf 필드를
 * 한 번에 봉인한다.
 */
function sourceDecisionFingerprint(sourceData: Record<string, unknown>): string {
  // Codex 적대 리뷰(0.6.96 item 2, 6회차) BLOCKER 수리: asRecord(sourceData.inboundMailProvenance)
  // 는 null 도 {} 도 똑같이 {}로 강등돼, provenanceKind/provenanceAccountId 가 둘 다 빈 문자열이
  // 되어 지문이 같아진다 — "provenance 가 아예 없다"와 "provenance 가 빈 객체로 있다"를 이
  // 지문만으로는 구분 못 했다(hasAnyExistingProvenance 판정과 어긋남). 존재 여부 자체를 먼저
  // 별도 필드로 봉인한다.
  const provenancePresent = sourceData.inboundMailProvenance !== undefined && sourceData.inboundMailProvenance !== null;
  const provenance = asRecord(sourceData.inboundMailProvenance);
  const imap = asRecord(sourceData.imap);
  return JSON.stringify({
    conversationId: asString(sourceData.conversationId),
    direction: asString(sourceData.direction),
    subject: asString(sourceData.subject),
    body: asString(sourceData.body),
    to: asString(sourceData.to),
    creatorEmail: asString(sourceData.creatorEmail),
    creatorHandle: asString(sourceData.creatorHandle),
    creatorName: asString(sourceData.creatorName),
    creatorCategory: asString(sourceData.creatorCategory),
    creatorPlatform: asString(sourceData.creatorPlatform),
    // Codex 적대 리뷰(0.6.96 item 2, 6회차) BLOCKER 수리: backfillInboundMailProvenanceHandler 가
    // discoverInboundConversationAttribution 에 넘기는 receivedAtIso/matchedOutboundRef/
    // matchedOutboundMatchBasis 가 지문에서 빠져 있었다 — 이 셋은 귀속 판정의 정확한 아웃바운드
    // 증거·최신성 점수에 쓰인다. 같은 messageRef 재전송으로 이 필드만 바뀌어도(subject/body 등
    // 나머지는 그대로) 재판정 결과(sender_not_creator 등)가 stale 해질 수 있는데, 그때까지의
    // 지문은 안 바뀌어 통과했다.
    receivedAtIso: asString(sourceData.receivedAtIso),
    matchedOutboundRef: asString(sourceData.matchedOutboundRef),
    matchedOutboundMatchBasis: asString(sourceData.matchedOutboundMatchBasis),
    // conv_13ioeao: also a discoverInboundConversationAttribution input (senderStillNotCreator) —
    // same staleness risk as matchedOutboundRef/matchedOutboundMatchBasis above.
    quotedOriginalRecipientEmail: asString(sourceData.quotedOriginalRecipientEmail),
    provenancePresent,
    senderBindingStatus: asString(asRecord(sourceData.senderIdentityBinding).status),
    senderBindingEvidence: asString(asRecord(sourceData.senderIdentityBinding).evidenceFingerprint),
    provenanceKind: asString(provenance.kind),
    provenanceAccountId: asString(provenance.accountId),
    imapMailbox: asString(imap.mailbox),
    imapUidValidity: asString(imap.uidValidity),
    imapUid: typeof imap.uid === "number" ? imap.uid : null,
    imapUser: asString(imap.user),
  });
}

export async function backfillInboundMailProvenanceHandler(
  request: CallableRequestShape,
): Promise<BackfillInboundMailProvenanceEnvelope> {
  const auth = assertNonGuestAuth(request, "mail.backfillInboundMailProvenance", ["super_admin"]);
  const requestData = asRecord(request.data);
  // dryRun 기본값은 반드시 true — 헤세가 배포 후 직접 dryRun:false 로 실행한다.
  const dryRun = requestData.dryRun !== false;
  // scanMode 기본값은 기존 배포와 완전히 동일한 array_contains(단일 스캔) — full_backlog 는
  // 명시적으로 요청해야만 켜지는 opt-in 페이지네이션 스캔이다(위 헤더 주석 참조).
  const scanMode: BacklogScanMode = asString(requestData.scanMode, "array_contains") === "full_backlog"
    ? "full_backlog"
    : "array_contains";
  const rawCursor = requestData.cursor;
  const cursor = scanMode === "full_backlog" ? readCursor(rawCursor) : null;
  // code-reviewer 지적(2026-09-26) LOW 수리: readCursor 는 안전을 위해 파싱 실패를 조용히 null
  // (="처음부터")로 낮춘다 — 그 자체는 옳지만(공격 표면 축소), 오퍼레이터가 진짜 nextCursor 를
  // 잘못 옮겨 붙였을 때 그냥 계속 1페이지부터 도는 걸 눈치 못 채고 같은 구간을 무한히 반복할 수
  // 있다. cursor 를 아예 안 준 것(=의도적으로 처음부터)과 준 값이 깨진 것(=오퍼레이터 실수)을
  // 구분해, 후자는 명시적으로 거부한다.
  if (scanMode === "full_backlog" && rawCursor !== undefined && rawCursor !== null && rawCursor !== "" && !cursor) {
    const error = new Error(
      "backfillInboundMailProvenance: cursor is not a valid opaque cursor string — pass the previous response's nextCursor verbatim, or omit it to start from the beginning",
    );
    Object.assign(error, { code: "invalid-argument", errorCode: "backfill_inbound_mail_provenance_invalid_cursor" });
    throw error;
  }
  const pageSize = clampFullBacklogPageSize(requestData.pageSize);

  const [{ rows: candidates, scannedInPage: totalMatched, nextCursor }, cursorAdvancements] = await Promise.all([
    resolveBackfillCandidatePage(scanMode, cursor, pageSize),
    fetchMailIngestCursorAdvancements(),
  ]);

  let eligible = 0;
  let stamped = 0;
  let skippedAmbiguous = 0;
  let skippedAlreadyStamped = 0;
  let permitDenyReasonsRevised = 0;
  const sample: BackfillInboundMailProvenanceSample[] = [];

  for (const { doc, row, lastMessageRef } of candidates) {
    const sourceSnapshot = await adminDb.doc(lastMessageRef).get();
    const sourceData = asRecord(sourceSnapshot.data());
    if (
      !sourceSnapshot.exists ||
      asString(sourceData.conversationId) !== doc.id ||
      asString(sourceData.direction) !== "inbound"
    ) continue;
    eligible += 1;
    const scannedSourceFingerprint = sourceDecisionFingerprint(sourceData);

    // ── 결정론적 재판정 (no LLM) ────────────────────────────────────────────────────────────
    //
    // Codex 적대 리뷰(0.6.96 item 2, 8·9회차) — **받아들여진 잔여 위험(accepted residual risk)**:
    // discoverInboundConversationAttribution 은 message_sources 뿐 아니라 campaign_outreach·
    // creator_links·program_sheet_leads·program_applications·scp_coldmail_history 등 여러
    // 컬렉션을 조회한다. 이 호출과 바로 아래 트랜잭션 커밋 사이(후보 하나당 attribution 쿼리 +
    // evaluateMailSafety 왕복 시간 — 배치 전체 실행 시간이 아니다)에 그 컬렉션들 중 하나에 이
    // 발신자의 신규 등록이 들어오면, sourceDecisionFingerprint·permitDenyReasons·mailAccountId
    // 재확인은 모두 통과하면서도(그 셋은 안 바뀌었으므로) senderStillNotCreator 판정 자체는
    // stale 해질 수 있다 — Firestore 트랜잭션은 "이 두 문서(conversation+message_sources)가
    // 그대로인가"만 원자적으로 보장하지, discoverInboundConversationAttribution 이 훑는 임의
    // 개수의 외부 컬렉션 전체를 잠글 수는 없다. 완전히 닫으려면 그 함수(실시간 인바운드 경로도
    // 공유)를 이 트랜잭션의 transaction.get() 으로 다시 쓰는 구조 변경이 필요한데, 1회성·
    // dryRun 기본·사람 검토 후 실행하는 관리자 백필 도구 범위를 크게 벗어난다.
    //
    // Codex 9회차 수리: 8회차 초안은 "dryRun 표본을 사람이 검토하면 이 경쟁을 잡는다"고 적었는데
    // 틀렸다 — dryRun 미리보기는 그 시점의 스냅샷이고, 이 경쟁은 **실제 실행(dryRun:false) 도중**
    // 에만 일어나므로 사전 미리보기로는 원천적으로 못 잡는다(mailHumanGate.ts 의 정규식 경계
    // 사례와 다른 점 — 그건 오분류가 미리보기 시점 텍스트 자체에 이미 있어 미리보기로 드러난다).
    // 부분적 백스톱은 **이 백필이 실제 실행을 끝낸 뒤에 이어지는, dismissAgencyAndUnregisteredSenderBacklog
    // 자신의 dryRun 리뷰**다(운영 절차: 백필 dryRun → 백필 real → dismiss dryRun → dismiss
    // real) — 이 경쟁으로 stale sender_not_creator 가 남았다면, 그 대화는 이제 막 provenance 가
    // 찍혀 dismiss dryRun 의 matched 집계에 포함된다. 단, **이 백스톱은 확실하지 않다** — dismiss
    // dryRun 의 sample 은 matched 중 최초 20건만 담는다(dismissAgencyAndUnregisteredSenderBacklogHandler
    // 의 `if (sample.length < 20) sample.push(...)`) — 후보가 20건을 넘으면 이 특정 대화가 표본
    // 밖에 놓일 수 있고, 그러면 오퍼레이터가 표본을 아무리 꼼꼼히(각 id 를 직접 열어 원문까지)
    // 검토해도 애초에 보이지 않는다. 이 잔여 노출은 다음 세 조건이 전부 겹쳐야만 실현된다:
    // (1) 발신자가 이 좁은 경쟁 창(후보 하나당 attribution 쿼리+mail-safety 왕복 시간) 안에
    // 우연히 등록되고, (2) 그 회신 본문이 hasProtectedHoldSignal 이 잡는 어떤 보호 카테고리에도
    // 걸리지 않으며, (3) 해당 dismiss 실행에서 matched 후보가 20건을 넘어 이 대화가 표본 밖으로
    // 밀려난다 — 세 조건이 모두 겹칠 낮은 확률의 좁은 잔여 위험으로 판단해 받아들인다(코드로
    // 원천 차단하지 않는다). matched 가 20을 크게 웃돌면(대량 배치) 오퍼레이터가 sample 외에
    // matched 전체 개수를 대조하는 등 추가 확인을 하는 것이 좋다.
    const senderEmail = asString(sourceData.creatorEmail, asString(row.creatorEmail, ""));
    const attributionMaterialization = await discoverInboundConversationAttribution({
      conversationId: doc.id,
      senderEmail,
      inboundSubject: asString(sourceData.subject, ""),
      inboundBody: asString(sourceData.body, ""),
      receivedAtIso: asString(sourceData.receivedAtIso, ""),
      // conv_13ioeao: only present on message_sources rows ingested after this fix shipped
      // (mailImapLive.ts/mailImapIngest.ts). Empty for older backlog rows — falls back to
      // today's zero-candidate behavior, unchanged.
      quotedOriginalRecipientEmail: asString(sourceData.quotedOriginalRecipientEmail, ""),
      matchedOutboundRef: asString(sourceData.matchedOutboundRef, ""),
      matchBasis: asString(sourceData.matchedOutboundMatchBasis, ""),
      requesterUid: auth.userId,
      requesterRole: auth.role,
    });
    const senderStillNotCreator = attributionMaterialization.resolution.rankedCandidates.length === 0;
    const mailSafetyDecision = await evaluateMailSafety(
      {
        to: asString(sourceData.to, ""),
        // sourceData.from is the MASKED display address (persistReceivedEmail stores
        // `author = inboundMail?.fromMasked` there) — evaluateMailSafety's "receive" mode
        // prioritizes `from` over `to` for its blocked-email/domain/role-prefix checks
        // (mailSafetyPolicy.ts resolveMailSafetyTargetEmail), so passing the masked value here
        // would silently defeat those checks. Use the real unmasked address (senderEmail, same
        // one persistReceivedEmail derives via creatorEmail/inboundMail.fromNormalized) instead —
        // mirrors chat-ai.ts's own live safetyInput.from (`inbound.fromNormalized ?? fromMasked`).
        from: senderEmail,
        creatorEmail: senderEmail,
        creatorHandle: asString(sourceData.creatorHandle, ""),
        creatorName: asString(sourceData.creatorName, ""),
        creatorCategory: asString(sourceData.creatorCategory, ""),
        creatorPlatform: asString(sourceData.creatorPlatform, ""),
        subject: asString(sourceData.subject, ""),
        body: asString(sourceData.body, ""),
      },
      "backfillInboundMailProvenance",
      "receive",
    );
    const mailSafetyStillBlocked = !mailSafetyDecision.allowed;
    const stillEligibleForBacklog = senderStillNotCreator || mailSafetyStillBlocked;

    const existingDenyReasons = denyReasonSetFrom(row.permitDenyReasons);
    const revisedDenyReasons = [...existingDenyReasons].filter(
      (reasonId) => reasonId !== "sender_not_creator" && reasonId !== "mail_safety_blocked",
    );
    if (senderStillNotCreator) revisedDenyReasons.push("sender_not_creator");
    if (mailSafetyStillBlocked) revisedDenyReasons.push("mail_safety_blocked");
    const denyReasonsChanged =
      revisedDenyReasons.length !== existingDenyReasons.size ||
      revisedDenyReasons.some((reasonId) => !existingDenyReasons.has(reasonId));

    // Codex 적대 리뷰(0.6.96 item 2, 1회차) BLOCKER 수리: asRecord(sourceData.inboundMailProvenance)
    // 는 값이 문자열이거나 빈 객체({})면 조용히 {}로 강등되어 Object.keys(...).length===0 이 되고,
    // "이미 provenance 가 있다"는 판정을 통째로 우회한다 — 기존 판정이 조용히 덮어써졌다. 필드가
    // 실제로 존재하는지(undefined/null 이 아닌지)만으로 판정한다 — 형태는 상관없다.
    const hasAnyExistingProvenance =
      sourceData.inboundMailProvenance !== undefined && sourceData.inboundMailProvenance !== null;

    // 1단계: 스캔 시점 데이터만으로 잠정 결정한다(아직 아무것도 쓰지 않는다, 카운터도 안 건드린다).
    let action: (typeof IMAP_PROVENANCE_ACTIONS)[number];
    let wantsToStampProvenance = false;
    if (!stillEligibleForBacklog) {
      // 재판정 결과 둘 다 더 이상 성립하지 않는다 — 귀속만 실패했던 진짜 크리에이터 문의일 수
      // 있으므로 provenance 는 절대 찍지 않고 인박스에 남긴다. permitDenyReasons 만 정리한다.
      action = denyReasonsChanged ? "permit_deny_reasons_revised_no_longer_eligible" : "not_eligible_no_change";
    } else if (hasAnyExistingProvenance) {
      // 이미 provenance 가 있다(imap/scp 든 다른 값이든) — 기존 판정을 덮어쓰지 않는다.
      action = "skipped_already_has_provenance";
    } else {
      const imap = asRecord(sourceData.imap);
      if (hasWellFormedScpImapEvidence(imap, cursorAdvancements)) {
        wantsToStampProvenance = true;
        action = "stamped";
      } else {
        action = "skipped_ambiguous_imap_evidence";
      }
    }

    // 2단계: 실제 쓰기(dryRun:false)만 트랜잭션으로 보낸다 — Codex 적대 리뷰(0.6.96 item 2, 2·3·
    // 4·5회차) BLOCKER 수리 누적: conversations/{id}.permitDenyReasons 쓰기와 message_sources
    // provenance 쓰기 모두, 트랜잭션 없이(또는 일부 필드만) 스캔 시점의 stale 값을 그대로
    // 덮어썼다 — 스캔 이후 새 인바운드·같은 messageRef 재전송이 이 대화/원문을 이미 바꿨을 수
    // 있는데도 무시하고 덮어쓸 수 있었다. provenance 스탬프(source 문서)와 permitDenyReasons
    // 정리(conversation 문서)를 하나의 트랜잭션으로 묶어, 커밋 직전 두 문서 모두 "스캔 때와 같은
    // 상태"(lastMessageRef 불변 + permitDenyReasons 불변 + message_sources 판정 관련 원문 전체
    // 불변 — sourceDecisionFingerprint + provenance 여전히 없음)인지 다시 확인한 뒤에만 쓴다.
    if (!dryRun && (denyReasonsChanged || wantsToStampProvenance)) {
      const outcome = await adminDb.runTransaction(async (transaction) => {
        const freshDoc = await transaction.get(doc.ref);
        const freshRow = asRecord(freshDoc.data());
        const freshSourceSnapshot = await transaction.get(sourceSnapshot.ref);
        const freshSourceData = asRecord(freshSourceSnapshot.data());
        // Codex 적대 리뷰(0.6.96 item 2, 3·5회차) BLOCKER 수리: lastMessageRef·permitDenyReasons
        // 만으로는 부족하다 — chat-ai.ts 의 case_already_reserved/duplicate_case_intent 재시도가
        // permitDenyReasons 만, 같은 messageRef 재전송(merge:true)이 subject/body/provenance/imap
        // 좌표만 바꿀 수 있다(둘 다 lastMessageRef 는 그대로 둔 채). 판정에 쓰인 conversation 필드와
        // message_sources 원문(sourceDecisionFingerprint) 을 모두 스캔 때와 정확히 같은지 확인한다.
        if (
          !freshDoc.exists ||
          // dismissAgencyAndUnregisteredSenderBacklogHandler 의 기존 트랜잭션과 동일하게, 이
          // 대화가 여전히 백로그 대상 상태인지도 재확인한다(fetchBacklogCandidateRows 가 스캔
          // 시점에 이미 걸렀지만, 쓰기 시점에도 같은 전제가 유지되는지 별도로 봐야 한다).
          // Codex 적대 리뷰(0.6.96 item 2, 7회차) BLOCKER 수리: mailAccountId 도 재확인한다 —
          // 스캔 이후 다른 mail_accounts 로 바뀌었으면 개인 계정 대화를 조용히 건드리게 된다.
          !isScpConversationRow(freshRow) ||
          !BACKLOG_ELIGIBLE_STATUSES.has(asString(freshRow.autoReplyStatus)) ||
          asString(freshRow.lastMessageFrom) !== "creator" ||
          asString(freshRow.lastMessageRef) !== lastMessageRef ||
          !sameStringSet(denyReasonSetFrom(freshRow.permitDenyReasons), existingDenyReasons) ||
          // Codex 적대 리뷰(0.6.96 item 2, 6회차) 수리 준비: senderEmail 은 sourceData.creatorEmail
          // 이 비어 있으면 row.creatorEmail(conversation 문서)로 폴백한다 — 그 폴백이 실제로
          // 쓰이는 행에서는 conversation 문서의 creatorEmail 도 스캔 때와 같은지 확인해야
          // discoverInboundConversationAttribution 의 senderEmail 입력이 stale 해지지 않는다.
          asString(freshRow.creatorEmail) !== asString(row.creatorEmail) ||
          !freshSourceSnapshot.exists ||
          sourceDecisionFingerprint(freshSourceData) !== scannedSourceFingerprint
        ) {
          return { conversationStale: true, provenanceStale: false };
        }
        let provenanceStale = false;
        if (wantsToStampProvenance) {
          provenanceStale =
            freshSourceData.inboundMailProvenance !== undefined && freshSourceData.inboundMailProvenance !== null;
        }
        if (denyReasonsChanged) {
          transaction.set(doc.ref, { permitDenyReasons: revisedDenyReasons }, { merge: true });
        }
        if (wantsToStampProvenance && !provenanceStale) {
          transaction.set(
            sourceSnapshot.ref,
            { inboundMailProvenance: { kind: "imap", accountId: "scp" } },
            { merge: true },
          );
        }
        return { conversationStale: false, provenanceStale };
      });
      if (outcome.conversationStale) {
        // 대화 자체가 스캔 이후 바뀌었다 — denyReasons/provenance 어느 쪽도 쓰지 않았다.
        action = "skipped_conversation_changed_since_scan";
        wantsToStampProvenance = false;
      } else if (wantsToStampProvenance && outcome.provenanceStale) {
        // 대화는 그대로지만 provenance 만 그 사이 다른 경로로 이미 찍혔다 — provenance 만 취소.
        action = "skipped_already_has_provenance";
        wantsToStampProvenance = false;
      }
    }

    // 3단계: 최종 action 을 기준으로 카운터를 정확히 한 번씩만 집계한다(dryRun 과 real 실행 동일
    // 경로 — dryRun 은 트랜잭션을 안 타니 1단계 잠정값이 그대로 최종값이 된다).
    if (action === "stamped") stamped += 1;
    else if (action === "skipped_already_has_provenance") skippedAlreadyStamped += 1;
    else if (action === "skipped_ambiguous_imap_evidence") skippedAmbiguous += 1;
    if (denyReasonsChanged && action !== "skipped_conversation_changed_since_scan") permitDenyReasonsRevised += 1;

    // "not_eligible_no_change" 는 아무 일도 안 일어난 행이다 — 샘플에서 뺀다(사람 검토는 실제
    // 결정이 난 행만 봐야 한다).
    if (action !== "not_eligible_no_change" && sample.length < 20) {
      sample.push({ id: sourceSnapshot.id, conversationId: doc.id, action });
    }
  }

  return {
    ok: true,
    dryRun,
    scanMode,
    scanned: totalMatched,
    eligible,
    stamped,
    skippedAmbiguous,
    skippedAlreadyStamped,
    permitDenyReasonsRevised,
    nextCursor,
    sample,
    behaviorLog: makeBehaviorLog(auth, "mail.backfillInboundMailProvenance", "success"),
  };
}
