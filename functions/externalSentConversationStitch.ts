/**
 * **보낸편지함 편입분의 대화 물질화(stitch)**.
 *
 * ■ 이 레인이 아는 것과 모르는 것 (W116 — 라벨 정직화)
 *   편입 대상은 Sent 편지함 **전량**이다. 사람이 Gmail 에서 직접 쓴 메일과 포털·툴이 자동 발송한
 *   메일이 섞여 있고, Flu 원장에 대응 행이 없으면 그 전부가 external import 로 들어온다. 즉 이 레인은
 *   **발신 주체를 알지 못한다** — "수동"이라고 쓰면 지어내는 것이다(프로드에서 ~2,400건이 그렇게 나갔다).
 *   그래서 라벨은 편입 경로만 말하고(`IMPORTED_SENT_LABEL`), 세분화는 **원장 교차 근거가 있을 때만**
 *   한다: 같은 수신자·제목의 툴 발송이 ±5분 안에 있으면 그 발송의 Sent 사본이므로 물질화하지 않는다
 *   (`skippedToolDuplicate`). 이미 물질화된 분량은 `mode: "relabel"` 이 같은 규칙으로 되돌린다.
 *
 * ■ 왜 필요한가 — 프로드 실측
 *   스케줄 임포터(`mailExternalSentImport.importSentMailToOutboxScheduled`)는 보낸편지함의 메일을
 *   `mail_outbound_log`(source=`external_sent_mail_import`) 와
 *   `message_sources`(`external-sent-{trackingId}`)까지 편입한다 — 여기까지는 완주가 확인됐다.
 *   그런데 **대화(`conversations/{id}/messages`) 물질화 경로가 없다**: 편입 문서의 conversationId 는
 *   null 이고 6시간 관찰에서도 자동으로 붙지 않았다. 그래서 chat 화면에서 우리 발신이 보이지 않고,
 *   사람은 "우리가 아무 말도 안 한 것"처럼 읽는다.
 *
 * ■ 왜 persistSentEmail 재사용이 아닌가
 *   툴 발송은 `persistSentEmail`(chat-ai.ts)이 **발송 시점에** 대화 메시지를 만든다. 그 함수는
 *   SMTP 발송을 전제로 `message_sources` 재작성 · 대화 카운터 갱신 · knowledge node 적재 ·
 *   lifecycle refresh 이벤트까지 함께 일으킨다. 이미 나간 메일을 사후에 붙이는 데 쓰면 그 부수효과가
 *   "지금 발송했다"는 사실을 원장에 다시 만든다(원장 이중 기록). 그래서 그 함수의 **메시지 문서
 *   컨벤션만** 그대로 따르고, 쓰기는 여기서 최소로 한다.
 *
 * ■ 원장 역기록은 `conversationId` 가 아니라 `stitchedConversationId` 다 (C1 — 공유 축 분리)
 *   `mail_outbound_log.conversationId` 는 이 레인의 것이 아니다. 최소 4개 형제 레인이 그 축을
 *   **읽어서 판정한다**:
 *     · `scpColdmailHistory.ts:1201/1210` — outbound.conversationId 로 대화를 끌어와 `hasReply` 를 만든다.
 *       사후 물질화된 대화를 여기에 꽂으면 "답장 받았다"가 조용히 참이 된다(발송만 했는데).
 *     · `scpColdmailHistory.ts:681/1414`  — 이력 행의 conversationId 를 이 축으로 덮어쓴다.
 *     · `mailBounce.ts:245`               — 반송 라우팅이 이 축으로 대화를 특정한다.
 *     · `sentOnlyAttribution.ts:426-459`  — `assertNoReplyOrConversation` 이 **conversationId 존재만으로**
 *       sent-only 귀속을 거부한다.
 *   그래서 이 레인은 전용 축(`stitchedConversationId`)에만 쓴다. 멱등 판정도 이 축이 기준이다.
 *   부수 효과로 sent-only 레인과의 상호배타 순환도 사라진다 — 물질화된 행도 그 레인의 대상으로
 *   남는다(대화가 "붙었다"는 사실은 답장이 왔다는 뜻이 아니므로 이게 맞는 관계다).
 *
 * ■ 의도적으로 하지 않는 것
 *   - 대화 문서에서 **목록 프리뷰 3필드(lastMessage/lastMessageFrom/lastMessageAtIso)만** 만진다.
 *     `unread` 를 비롯한 그 밖의 모든 필드는 무접촉이다 — 미읽음 카운터·알림 레인이 이 레인의
 *     사후 물질화를 "새 메시지 도착"으로 오독하지 않아야 한다(테스트로 봉인).
 *   - 평문 수신자 이메일을 메시지에 **새로 쓰지 않는다**(아래 개인정보 축 참조).
 *   - 매칭 대화가 0이거나 애매하면 지어내지 않는다. 건너뛰고 **사유별 숫자**로 남긴다.
 *
 * ■ 개인정보 축 (정직한 범위)
 *   이 레인이 메시지에 새로 쓰는 수신자 필드는 **없다** — to/toMasked/toHash/creatorEmail 어느 것도
 *   쓰지 않고, 매칭에 필요한 평문은 원장에서 읽기만 하고 저장하지 않는다.
 *   다만 **본문 프리뷰와 제목은 원장 값 그대로** 들어간다. 제목이나 본문에 이메일 주소가 들어 있으면
 *   그대로 대화 메시지에 남는다 — 마스킹하지 않는다. 근거: 툴 발송(`persistSentEmail`)이 같은 대화에
 *   본문 전문을 그대로 적재하고 있어, 여기만 가리면 같은 화면에서 등급이 갈린다. 이 레인은 기존 툴
 *   발송과 **같은 등급**을 유지한다(등급을 올리려면 발송 경로부터 같이 올려야 한다).
 */
import { createHash } from "crypto";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { expireAt180DaysFromIso } from "./firestoreTtl";
import { sourceRef as makeSourceRef } from "./knowledgeGraph";
import { CANONICAL_OPERATIONAL_MAILBOX_V1 } from "./mailIdentity";
import { safeOutboundFailureEvidence } from "./mailSafetyShared";
import { recipientIdentityHash, toRecipientIdentityHash } from "./recipientIdentityHash";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  type CallableRequestShape,
} from "./shared";

const OUTBOX_COLLECTION = "mail_outbound_log";
const MESSAGE_SOURCES_COLLECTION = "message_sources";
const CONVERSATIONS_COLLECTION = "conversations";
const COLDMAIL_HISTORY_COLLECTION = "scp_coldmail_history";
const AUDIT_COLLECTION = "external_sent_stitch_audits";
const IMPORT_SOURCE = "external_sent_mail_import";
const IMPORT_MAIL_TYPE = "manual_external_gmail";
const STITCH_ROLES = ["super_admin", "admin", "manager"] as const;

/** 스케줄 편승 회차의 액터 — 사람 관리자와 감사에서 섞이면 안 된다(형제 임포터와 같은 결). */
const STITCH_ACTOR_SYSTEM_UID = "system:external-sent-stitch";
const STITCH_ACTOR_SYSTEM_ROLE = "system_scheduled";

/**
 * 물질화 메시지의 출처 라벨 — **아는 것만 말한다**(W116).
 *
 * ■ 왜 "Gmail 수동 발신(가져옴)" 을 버렸나 (프로드 실측)
 *   편입 대상은 Sent 편지함 **전량**이다. 거기엔 사람이 Gmail 에서 직접 쓴 메일뿐 아니라 포털·툴이
 *   자동 발송한 메일(승인 안내 "[SCP] You're in!", 콜드 아웃리치 등)도 섞여 있고, Flu 원장에 대응 행이
 *   없으면 그 전부가 external import 로 편입된다. 스티처는 그 메일이 사람 손에서 나왔는지 알 방법이
 *   **없는데도** "수동"이라고 단정했다 — 화면 전체가 거짓 라벨이 됐다(프로드 ~2,400건).
 *   이제 라벨은 **어디서 가져왔는지**만 말한다(편입 경로는 확실히 안다). 발신 주체는 말하지 않는다.
 */
const IMPORTED_SENT_LABEL = "보낸편지함 가져옴";

/**
 * W119: 버블 문구가 **원문이 아니라 모델이 만든 요약**일 때만 붙는 꼬리표.
 * 요약을 원문인 척 보여 주지 않는 것이 이 레인의 라벨 규칙(W116)과 같은 결이다.
 */
const AI_SUMMARY_LABEL = "AI 요약";

/**
 * 툴 발송과 중복으로 판정된 메시지에 다는 마킹.
 * **삭제하지 않는다** — 파괴적이고 되돌릴 수 없다. 클라이언트가 이 값을 보고 숨긴다
 * (`src/lib/chat-normalization.ts` normalizeMessage).
 */
const HIDDEN_TOOL_DUPLICATE = "tool_duplicate";

/** 회당 처리 상한. 스케줄 편승·백필 콜러블 모두 이 값을 넘지 못한다. */
export const EXTERNAL_SENT_STITCH_MAX_ROWS = 200;
/** 스케줄 편승이 임포트 뒤에 쓸 수 있는 시간 예산. 소진분은 `deferred` 로 남고 다음 회차가 잇는다. */
export const EXTERNAL_SENT_STITCH_PIGGYBACK_BUDGET_MS = 60_000;
/** 해시 1개당 평문 수신자 복구에 훑는 원장 문서 수 상한. */
const IDENTITY_PROBE_LIMIT = 10;
/** 한 수신자에 매칭되는 대화 후보 상한. 여기에 꽉 차면 잘렸다는 뜻이라 물질화를 거부한다. */
const CONVERSATION_CANDIDATE_LIMIT = 20;
/** 한 해시당 조회할 평문 표기 변형(정규 소문자 + 원본 케이싱) 상한. */
const IDENTITY_VARIANT_LIMIT = 3;
/**
 * 규칙 1(발신 직전 인바운드)의 **최신성 창**.
 * 이게 없으면 3년 전에 한 번 답장하고 끊긴 묵은 스레드가, 어제 활발했던 스레드를 이긴다
 * (규칙 1이 규칙 2보다 항상 우선이므로). 창 밖이면 규칙 1 후보에서 빠지고 규칙 2가 판정한다.
 */
const STITCH_INBOUND_RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 1970년 값은 임포터의 **결손 폴백**이다(`isoDate(..., new Date(0))`, mailExternalSentImport.ts).
 * 그 값을 발신 시각으로 믿으면 스레드 선택이 "가장 오래된 것"으로 쏠리고, 메시지 createdAtIso 도
 * 1970이 되어 대화 맨 위에 박힌다. 시각이 없는 행은 붙이지 않는다.
 */
const LEDGER_EPOCH_FLOOR_MS = Date.UTC(1971, 0, 1);
/** 감사 문서에 남기는 매칭 쌍 상한(문서 크기 보호). 넘으면 잘렸음을 같이 남긴다. */
const AUDIT_PAIR_LIMIT = 50;
/**
 * 툴 발송 중복 판정 창 (W116).
 * 같은 수신자·같은 제목의 **툴 발송 원장 행**이 이 창 안에 있으면, 편입 행은 그 발송이 Sent 편지함에
 * 남긴 사본이다 — 물질화하면 같은 메일이 대화에 두 번 그려진다. 제공자 Message-ID 가 어긋나
 * 임포터의 중복 판정(`providerMessageAlreadyKnown`)을 빠져나온 분량이 여기서 걸린다.
 */
const TOOL_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
/**
 * 대조 1건당 훑는 후보 상한.
 *
 * ■ 왜 (toHash + subjectHash) **등가 2축**인가 — 리뷰 H2(프로브 P2)
 *   toHash 한 축 + limit 만 걸면 정렬이 암묵 `__name__` 오름차순이라 `external-sent-*` 문서가
 *   포털 발신 계열(`login-approved-*`/`onboarding-*`/`scp-*` 등)보다 **항상 앞에** 온다.
 *   편입 행이 20건 넘는 수신자에서는 창이 편입분으로 가득 차 툴 발송이 구조적으로 0% 탐지된다.
 *   제목 축을 조회에 넣으면 창이 "같은 제목"으로 좁혀져 포화 자체가 거의 사라진다.
 *
 * ■ 색인 (확인 2026-08-23 — 새 색인 불요)
 *   등가 필터만 있고 orderBy 가 없는 쿼리는 Firestore **색인 병합(index merging)** 으로
 *   각 필드의 자동 단일필드 색인을 합쳐 서빙된다 — 복합 색인이 필요 없다.
 *   실측 근거 3개: ① `firestore.indexes.json` 에 `fieldOverrides` 가 0건이라 두 필드 모두 자동
 *   단일필드 색인이 살아 있다. ② 같은 매니페스트에 `mail_outbound_log` 복합 색인은 0건인데 이 레인은
 *   이미 프로드에서 toHash 등가 조회를 돌고 있다. ③ 같은 형태(등가 2 + limit, orderBy 없음)가 이미
 *   프로드에서 돈다 — `applicationManagementStore.ts:386-388`
 *   (`scp_portal_creator_bindings` portalCreatorId + status), 매니페스트에 그 복합 색인은 없다.
 *   그래서 3중 장부(firestore.indexes.json · PRODUCTION_REQUIRED_INDEXES · CRITICAL_QUERY_SHAPES)에
 *   등재할 것이 없다 — 그 표들은 **복합 색인이 필요한** 쿼리만 다룬다.
 */
const TOOL_DUPLICATE_PROBE_LIMIT = 20;

export type ExternalSentStitchDeps = {
  db?: FirebaseFirestore.Firestore;
  /** 예산 판정용 시계. 테스트가 "예산이 회차 중간에 끊기는" 경계를 결정론적으로 재현하기 위한 이음매다. */
  now?: () => number;
};

/**
 * `relabel` 은 **이미 물질화된 메시지를 고치는** 모드다(W116 프로드 정정).
 * 원장(`mail_outbound_log`)을 같은 커서로 훑되 대화를 새로 찾지 않고, 그 행이 이미 붙여 둔
 * `stitchedConversationId` 의 메시지 문서만 열어 라벨을 새 규칙으로 다시 쓴다.
 * 컬렉션그룹 조회를 새로 만들지 않는 이유: 원장이 "무엇을 어디에 붙였는지"의 정본이라 경로를
 * 직접 조립할 수 있고, 새 색인(그리고 배포 전 FAILED_PRECONDITION 위험)이 필요 없다.
 *
 * `unhide` 는 그 반대 방향의 **사람 판단 문**이다(리뷰 M2). 자동 판정이 틀렸을 때 관리자가
 * `trackingIds` 를 짚어 숨김 마킹을 걷어낸다 — 전량 스윕이 아니라 지목이어야 하므로 커서를 받지 않는다.
 */
export type ExternalSentStitchMode = "tracking_ids" | "scan" | "relabel" | "unhide";

export type ExternalSentStitchResult = {
  ok: true;
  dryRun: boolean;
  mode: ExternalSentStitchMode;
  /** 이번 회차에 검토한 편입 원장 행 수. 아래 종결 카운터의 합과 항상 같다. */
  scanned: number;
  /** 대화 메시지를 물질화한(dry-run 이면 물질화 대상으로 확정한) 행 수. */
  matched: number;
  /**
   * 대화 문서의 목록 프리뷰를 함께 갱신한 행 수.
   * 물질화는 3필드(lastMessage/lastMessageFrom/lastMessageAtIso), relabel 은 문구 1필드만 고친다.
   */
  previewUpdated: number;
  /** 이미 물질화 완료(원장 역기록 있음) — 대화를 조회하지도 않았다. */
  alreadyStitchedLedger: number;
  /** 메시지는 있는데 원장 역기록이 빠진 중단 상태 — 역기록만 채웠다. */
  alreadyStitchedMessage: number;
  /** 메시지도 역기록도 이미 같은 값 — 아무것도 쓰지 않았다. */
  alreadyStitchedNoop: number;
  /** 평문 수신자를 어떤 원장에서도 되찾지 못했다(해시만 있는 상태). */
  skippedNoIdentity: number;
  /** 평문은 되찾았는데 그 수신자의 대화가 0건이다. */
  skippedNoConversationForIdentity: number;
  /** 대화는 있는데 발신 시각 기준으로 붙일 만한 스레드가 없다(전부 발신 이후 활동뿐). */
  skippedNoEligibleThread: number;
  /** 후보가 상한에 꽉 차 잘렸다 — 어느 스레드인지 확정할 수 없어 거부했다. */
  skippedAmbiguous: number;
  /** 같은 수신자·제목의 툴 발송이 ±5분 안에 있다 — 그 발송의 Sent 사본이라 물질화하지 않았다. */
  skippedToolDuplicate: number;
  /**
   * 중복 조회 창이 상한까지 찼는데 쓸 수 있는 툴 행이 0건이었다 — **못 본 것과 없는 것을 구분한다**.
   * 근거가 없으므로 물질화하지 않고 남긴다. 원장 역기록을 쓰지 않으므로 다음 회차가 다시 판정한다.
   */
  skippedToolDuplicateUnknown: number;
  /** sentAtIso 가 결손이거나 1970 폴백이라 붙일 시각이 없다. */
  skippedNoTimestamp: number;
  /** 문서 id 와 본문 trackingId 가 어긋난 팬텀 행. */
  skippedIdMismatch: number;
  /** 편입 행 형태가 깨졌다(sourceRef 결손 등). 조용히 넘기지 않는다. */
  skippedMalformedRow: number;
  /** (relabel) 메시지 문서를 새 규칙으로 다시 쓴 수. */
  relabeled: number;
  /** (relabel) 이미 새 규칙과 같아 아무것도 쓰지 않은 수 — 멱등의 관측 축이다. */
  relabelNoop: number;
  /** (relabel) 아직 물질화된 적 없는 행 — 고칠 메시지가 없다. */
  relabelSkippedNotStitched: number;
  /** (relabel) 원장은 붙였다고 하는데 메시지 문서가 없다(사람이 지웠거나 대화가 병합됐다). */
  relabelSkippedMissingMessage: number;
  /** (relabel) 이번 회차에 `hiddenReason: tool_duplicate` 를 **새로** 단 수. */
  hiddenMarked: number;
  /**
   * (relabel) 숨긴 메시지의 문구가 **대화 목록 프리뷰에 그대로 남아 있는** 수.
   * 숨김은 메시지만 가릴 뿐 목록 프리뷰를 고치지 못한다(그 자리를 대신할 메시지를 이 레인이 모른다).
   * 되감기보다 드러내기를 택한다 — 이 값이 0이 아니면 목록에 구 문구가 남아 있다는 뜻이다.
   */
  previewStaleAfterHide: number;
  /** (unhide) 숨김 마킹과 근거 필드를 걷어낸 수. */
  unhidden: number;
  /** (unhide) 이미 숨김이 아니어서 아무것도 쓰지 않은 수 — 멱등의 관측 축이다. */
  unhideNoop: number;
  /** 시간 예산 소진으로 이번 회차가 손대지 않은 행 수. 커서는 여기까지만 전진한다. */
  deferred: number;
  /** 이번 회차의 감사 문서 경로(쓰지 않았으면 빈 문자열). */
  auditRef: string;
  /** 이번 회차에 물질화를 보류하거나 숨긴 행(원장 식별자 + 사유). 감사 문서와 같은 상한으로 절단된다. */
  suppressed: Array<{ trackingId: string; reason: SuppressionReason }>;
  suppressedTruncated: boolean;
  /**
   * (relabel) **문구가 새 규칙과 같음이 확인된** 행의 원장 식별자. `relabeled`(새로 썼다)와
   * `relabelNoop`(이미 같았다) 두 결말만 들어간다 — 어느 쪽이든 그 행을 지금 다시 relabel 해도
   * 아무 일도 일어나지 않는다는 뜻이다.
   *
   * ■ 왜 반환하는가 (W123 읽기 증폭 제거)
   *   호출자(`externalSentSummary`)는 "이미 요약된 행"을 매 회차 relabel 후보로 다시 실어 보냈다.
   *   백필이 끝난 뒤에도 후보 1건당 원장 doc read 1 + 툴중복 쿼리 1 + 트랜잭션 read 2 가 영구
   *   반복됐다. 그 호출자가 **어느 행이 끝났는지** 소스 문서에 표시하려면 회차 합계가 아니라
   *   행 단위 결말이 필요하다 — 합계로는 "3건 중 어느 2건이 끝났는지"를 알 수 없다.
   *   `relabelSkippedMissingMessage` 는 **넣지 않는다**: 고칠 문서가 없어 못 고친 상태이지
   *   문구가 맞다는 확인이 아니다(그 축은 회수 신호로 남아야 한다).
   *
   * dry-run 회차는 **항상 빈 배열**이다 — 아무것도 쓰지 않은 회차의 판정으로 호출자가 영속
   * 마킹을 하면 그 행은 실제로 고쳐지지 않은 채 완료로 굳는다.
   */
  relabelSettledTrackingIds: string[];
  /** 다음 호출에 그대로 넘기면 이어서 백필된다. 빈 문자열이면 더 없다. */
  nextCursor: string;
  done: boolean;
};

type StitchLedgerRow = {
  trackingId: string;
  /** 스캔이 실제로 읽은 문서의 ref 를 그대로 쓴다 — 경로를 다시 조립하지 않는다(M3). */
  ref: FirebaseFirestore.DocumentReference;
  toHash: string;
  subject: string;
  bodyPreview: string;
  /** W119: 요약 레인(externalSentSummary)이 원장에 미러한 한국어 한 줄 요약. 없으면 빈 문자열. */
  summaryKr: string;
  sentAtIso: string;
  sentAtMs: number;
  sourceRefPath: string;
  stitchedConversationId: string;
  /**
   * 편입을 수행한 mail_accounts 행 ("scp" = canonical, 그 외 = 개인 계정). 개인 발송분은
   * **같은 계정이 소유한 대화에만** 붙는다 — 발신 계정이 다른 대화로 새면 "누가 보냈는가"가
   * 화면에서 거짓이 되고, 계정 경계(member.mailAccountIds 필터)를 찢는다. 역대 편입분은
   * 이 필드가 없다 → canonical 과 동일하게 취급한다.
   */
  mailAccountId: string;
};

type LedgerSkipReason = "id_mismatch" | "malformed" | "no_timestamp";

type LedgerRowOutcome =
  | { kind: "row"; row: StitchLedgerRow }
  | { kind: "skip"; reason: LedgerSkipReason }
  /** 이 레인의 행이 아니다(툴 발송 등) — 검토 수에도 넣지 않는다. */
  | { kind: "foreign" };

/** 검토 대상으로 확정된 항목. `foreign` 은 적재 단계에서 이미 걸러졌다(검토 수에 들지 않는다). */
type LedgerEntry = { id: string; outcome: Exclude<LedgerRowOutcome, { kind: "foreign" }> };

type ConversationCandidate = {
  id: string;
  lastInboundAtMs: number;
  recencyMs: number;
};

type ConversationMatchSkip =
  | "no_identity"
  | "no_conversation_for_identity"
  | "no_eligible_thread"
  | "ambiguous";

type ConversationMatch =
  | { kind: "matched"; conversationId: string }
  | { kind: "skip"; reason: ConversationMatchSkip };

type StitchWriteOutcome = "materialized" | "ledger_backfilled" | "noop";

/** 감사 문서의 쌍에 남기는 결말. relabel/unhide 는 실제로 쓴 것만 남긴다(noop 은 되돌릴 사건이 없다). */
type AuditPairOutcome = StitchWriteOutcome | "relabeled" | "unhidden";

/**
 * 억제 사유(리뷰 M3). "무엇을 안 보여주기로 했는가"를 원장 식별자와 함께 남긴다 —
 * 이게 없으면 사라진 메시지를 사후에 되짚을 방법이 감사 문서에 없다.
 */
type SuppressionReason = "tool_duplicate" | "tool_duplicate_unknown" | "hidden_tool_duplicate";

/** 툴 발송 원장 행의 대조축. 평문은 담지 않는다(원장 식별자와 시각뿐). */
type ToolSentRow = { trackingId: string; sentAtMs: number };

/**
 * 중복 판정 결과 — **"중복 없음"과 "못 봄"을 구분한다**(리뷰 H2-1).
 * `unknown` 은 조회 창이 가득 찼는데 쓸 수 있는 툴 행이 하나도 없던 경우다. 근거가 없으므로
 * 물질화도 숨김도 하지 않고 별도 사유로 남긴다 — `skippedAmbiguous`(후보 절단)와 같은 결이다.
 */
type ToolDuplicateVerdict =
  | { kind: "duplicate"; trackingId: string }
  | { kind: "none" }
  | { kind: "unknown" };

function parseMs(value: unknown): number {
  const parsed = Date.parse(asString(value, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function boundedLimit(value: unknown): number {
  const parsed = Math.trunc(Number(value ?? EXTERNAL_SENT_STITCH_MAX_ROWS));
  if (!Number.isFinite(parsed)) return EXTERNAL_SENT_STITCH_MAX_ROWS;
  return Math.min(Math.max(parsed, 1), EXTERNAL_SENT_STITCH_MAX_ROWS);
}

/** 결정론적 메시지 id — 같은 발신을 몇 번 돌려도 같은 문서 하나만 생긴다. */
function stitchMessageId(trackingId: string): string {
  return `msg-external-sent-${trackingId}`;
}

/**
 * **문구 규칙의 세대값** (W123 적대 리뷰 H1).
 *
 * ■ 왜 필요한가
 *   `externalSentSummary` 는 relabel 이 끝난 행에 정산 마커를 남겨 다음 회차부터 그 행을 후보에서
 *   뺀다(읽기 증폭 제거). 그런데 relabel 의 판정 입력은 **요약만이 아니다** — 아래
 *   `stitchMessageText` 의 조립 규칙 자체가 입력이다. 규칙이 바뀌면 이미 정산된 행은 후보로 돌아오지
 *   못해 **영영 옛 문구**로 남는다. 실제로 이 규칙은 최근 10 릴리스에서 두 번 바뀌었고
 *   (W116-R2 라벨 정직화, W119 `· AI 요약` 추가) 그 두 번의 회수 경로가 정확히 이 relabel 축이었다.
 *
 * ■ 계약
 *   `stitchMessageText` 의 **산출 문구가 달라지는 변경**을 하면 이 값을 반드시 올린다. 그러면 마커에
 *   실린 옛 세대값이 현재 값과 달라져 전량이 자동으로 relabel 후보로 복귀한다.
 *   tests/w123-cost-audit-caching.test.mjs 가 규칙의 산출 지문을 이 값과 함께 고정하므로,
 *   **올리지 않고 규칙만 바꾸면 그 테스트가 깨진다**(잊어버릴 수 없게 만든 이유다).
 */
export const STITCH_TEXT_RULE_VERSION = "w119-summary-kr-v1";

/**
 * 화면에 보일 본문.
 * 원장에 `bodyPreview`(240자)가 있으면 제목보다 그쪽이 읽을 만하다 — 사람이 "무슨 말을 보냈나"를
 * 제목만으로는 못 읽는다.
 *
 * W117 갱신 (헤세 결정 2026-08-23): 편입 레인이 이제 원장에 `bodyPreview` 를 싣는다
 * (mailExternalSentImport — 툴 발송 레인과 같은 노출 등급). 그래서 이 분기는 **신규 편입분에서
 * 실제로 켜진다**. 제목 폴백은 그대로 남긴다 — 백필로 본문을 되찾지 못한 과거 편입분이 있다.
 *
 * W119 갱신 (헤세 지적 2026-08-24): 프리뷰는 **영어 원문 240자**다. 수신 메일은 한국어 한 줄
 * 요약으로 렌더되는데 편입 발신만 원문이 그대로 박혀, 같은 타임라인에서 사람이 매번 다시 읽고
 * 해석해야 했다. 요약 레인(externalSentSummary)이 원장에 `summaryKr` 을 미러하면 그 값이
 * 버블 문구가 되고, 라벨에 `AI 요약` 을 덧붙여 **가공된 문장임을 화면에서 밝힌다**(원문 열람은
 * 종전대로 `messageRef` → getMessageSource 의 "서버 보관 원문"). 요약이 없으면 현행 그대로다 —
 * 이 분기는 요약이 붙은 행에서만 켜지므로 relabel 은 나머지 전량에서 멱등(noop)이다.
 *
 * ⚠️ **산출 문구를 바꾸면 `STITCH_TEXT_RULE_VERSION`(바로 위)을 반드시 올린다** — 안 올리면
 *   정산 마커가 붙은 행이 후보로 복귀하지 못해 영영 옛 문구로 남는다(W123 적대 리뷰 H1).
 */
export function stitchMessageText(
  row: Pick<StitchLedgerRow, "subject" | "bodyPreview" | "summaryKr">,
): string {
  if (row.summaryKr) return `${row.summaryKr} · ${IMPORTED_SENT_LABEL} · ${AI_SUMMARY_LABEL}`;
  const head = row.bodyPreview || row.subject;
  return head ? `${head} · ${IMPORTED_SENT_LABEL}` : IMPORTED_SENT_LABEL;
}

/**
 * 제목 대조축. 툴 발송 원장은 `sha256(subject)` **전체**를 `subjectHash` 로 싣는다
 * (mailSignature.recordMailOutboundLog). 편입 원장은 그 필드가 없으므로 여기서 같은 식으로 만든다.
 */
function subjectFingerprint(subject: string): string {
  return createHash("sha256").update(subject).digest("hex");
}

/**
 * 이 수신자에게 **툴이** 같은 제목으로 보낸 원장 행들. 편입 행(source=IMPORT_SOURCE)은 제외한다 —
 * 편입분끼리는 서로 중복 근거가 되지 못한다(둘 다 Sent 사본일 뿐 어느 쪽도 원 발송이 아니다).
 *
 * ■ 왜 source 값을 열거하지 않는가
 *   "smtp/outbox 계열"을 열거하려면 어떤 값이 툴 발송인지 **추정**해야 한다. 실제로 sendEmail 경로는
 *   `source` 를 아예 싣지 않는 회차도 있다(deliverySource 만 있다). 우리가 확실히 아는 사실은 하나뿐이다:
 *   **이 레인이 편입한 행이 아니면 Flu 원장에 직접 기록된 발송이다.** 그 사실만 쓴다.
 *
 * 반환값의 `saturated` 는 창이 상한까지 찼다는 뜻이다 — 쓸 수 있는 행이 0건이면 판정을 포기한다.
 */
async function loadToolSentRows(
  db: FirebaseFirestore.Firestore,
  toHash: string,
  fingerprint: string,
): Promise<{ rows: ToolSentRow[]; saturated: boolean }> {
  const snapshot = await db
    .collection(OUTBOX_COLLECTION)
    .where("toHash", "==", toHash)
    .where("subjectHash", "==", fingerprint)
    .limit(TOOL_DUPLICATE_PROBE_LIMIT)
    .get();
  const rows: ToolSentRow[] = [];
  for (const doc of snapshot.docs) {
    const data = asRecord(doc.data());
    if (asString(data.source, "") === IMPORT_SOURCE) continue;
    const sentAtMs = parseMs(data.sentAtIso);
    if (!Number.isFinite(sentAtMs)) continue;
    rows.push({ trackingId: doc.id, sentAtMs });
  }
  return { rows, saturated: snapshot.docs.length >= TOOL_DUPLICATE_PROBE_LIMIT };
}

/**
 * 툴 발송 중복 판정. 수신자+제목 조합당 1회만 조회하고 캐시한다 — 같은 조합의 편입분이 여러 건이어도
 * 읽기는 상수다. 제목이 없는 편입 행은 대조축이 없어 판정하지 않는다(`none`).
 */
async function resolveToolSentDuplicate(
  db: FirebaseFirestore.Firestore,
  row: StitchLedgerRow,
  cache: Map<string, { rows: ToolSentRow[]; saturated: boolean }>,
): Promise<ToolDuplicateVerdict> {
  if (!row.toHash || !row.subject) return { kind: "none" };
  const fingerprint = subjectFingerprint(row.subject);
  const cacheKey = `${row.toHash}\u0000${fingerprint}`;
  let probe = cache.get(cacheKey);
  if (probe === undefined) {
    probe = await loadToolSentRows(db, row.toHash, fingerprint);
    cache.set(cacheKey, probe);
  }
  const hit = probe.rows.find((candidate) =>
    Math.abs(candidate.sentAtMs - row.sentAtMs) <= TOOL_DUPLICATE_WINDOW_MS);
  if (hit) return { kind: "duplicate", trackingId: hit.trackingId };
  // 창이 가득 찼는데 쓸 수 있는 툴 행이 0건 = 못 본 행이 있을 수 있다. "중복 없음"이라고 말하지 않는다.
  if (probe.saturated && probe.rows.length === 0) return { kind: "unknown" };
  return { kind: "none" };
}

function ledgerRow(snapshot: FirebaseFirestore.DocumentSnapshot): LedgerRowOutcome {
  const data = asRecord(snapshot.data());
  if (asString(data.source, "") !== IMPORT_SOURCE) return { kind: "foreign" };
  // M3: 문서 id 와 본문 trackingId 가 다르면 어느 쪽이 진짜인지 모른다. 그 상태로 붙이면
  // 다른 발신의 메시지 id 를 만들거나 남의 원장에 역기록한다 — 팬텀으로 세고 손대지 않는다.
  const trackingId = asString(data.trackingId, "");
  if (!trackingId || trackingId !== snapshot.id) return { kind: "skip", reason: "id_mismatch" };
  const sourceRefPath = asString(data.sourceRef, "");
  if (!sourceRefPath.startsWith(`${MESSAGE_SOURCES_COLLECTION}/`)) {
    return { kind: "skip", reason: "malformed" };
  }
  const sentAtIso = asString(data.sentAtIso, "");
  const sentAtMs = parseMs(sentAtIso);
  if (!Number.isFinite(sentAtMs) || sentAtMs < LEDGER_EPOCH_FLOOR_MS) {
    return { kind: "skip", reason: "no_timestamp" };
  }
  return {
    kind: "row",
    row: {
      trackingId,
      ref: snapshot.ref,
      toHash: toRecipientIdentityHash(data.toHash),
      subject: asString(data.subject, ""),
      bodyPreview: asString(data.bodyPreview, ""),
      summaryKr: asString(data.summaryKr, ""),
      sentAtIso,
      sentAtMs,
      sourceRefPath,
      stitchedConversationId: asString(data.stitchedConversationId, ""),
      mailAccountId: asString(data.mailAccountId, ""),
    },
  };
}

/**
 * 해시 → 평문 수신자 복구.
 *
 * 편입 원장은 `toMasked`/`toHash` 만 갖는다(의도적). 대화는 `creatorEmail` 을 평문으로 갖는다.
 * 그래서 매칭하려면 둘 중 하나를 상대 축으로 옮겨야 하는데, 대화 전량을 훑어 해시를 만드는 것은
 * 10분마다 도는 레인이 감당할 읽기량이 아니다. 대신 **이미 같은 해시를 색인해 둔 원장**에서
 * 평문을 되찾아 대화를 등가 조회(single-field 색인)한다 — 읽기가 수신자당 상수로 묶인다.
 * 되찾은 평문은 어디에도 저장하지 않는다.
 *
 * ■ 대소문자 (H3 — 한계까지 정직하게)
 *   대화 쓰기 경로가 `creatorEmail` 을 **정규화하지 않는다**(chat-ai.ts:4633 — `data.to` 원본 케이싱을
 *   그대로 싣는다). 등가 조회는 대소문자를 구분하므로 소문자 한 축만 조회하면 `Creator@X.com` 으로
 *   저장된 대화를 영영 못 찾는다. 임의의 케이싱 변형을 만들어 조회하는 건 불가능하므로(2^n),
 *   **실제로 원장에서 되찾은 표기**만 조회한다: 정규 소문자 + 복구 소스가 보존한 원본 케이싱.
 *   복구 소스별 보존 여부(실측):
 *     · `message_sources.toNormalized` → 소문자(normalizeEmailAddress)
 *     · `message_sources.to` / `.creatorEmail` → **원본 케이싱 보존**(chat-ai.ts:4750/4797)
 *     · `scp_coldmail_history.email` / `.emailLower` → 둘 다 소문자
 *   즉 원본 케이싱은 툴 발송 이력이 있는 수신자에서만 복구된다. `creatorEmailLower` 색인 필드를
 *   신설하면 한 축으로 정리되지만 그건 **대화 쓰기 경로 전수 수정 + 백필**이라 이번 범위 밖이다.
 *   그 한계로 못 찾은 행은 `skippedNoConversationForIdentity` 로 분리돼 진단에 잡힌다.
 */
async function resolveRecipientEmails(
  db: FirebaseFirestore.Firestore,
  toHash: string,
): Promise<string[]> {
  const probes: Array<{ collection: string; field: string; valueFields: string[] }> = [
    // 툴 발송(persistSentEmail)이 남긴 아웃바운드 원문 — toNormalized 가 정규화 평문이다.
    { collection: MESSAGE_SOURCES_COLLECTION, field: "toHash", valueFields: ["toNormalized", "creatorEmail", "to"] },
    // 답장 수신(receiveEmail)이 남긴 인바운드 원문 — 크리에이터가 발신자다.
    { collection: MESSAGE_SOURCES_COLLECTION, field: "fromHash", valueFields: ["creatorEmail"] },
    // 콜드메일 이력 — 툴 대화가 아직 없던 접촉도 여기엔 남는다.
    { collection: COLDMAIL_HISTORY_COLLECTION, field: "emailHash", valueFields: ["emailLower", "email"] },
  ];
  const variants: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    if (!value || seen.has(value) || variants.length >= IDENTITY_VARIANT_LIMIT) return;
    seen.add(value);
    variants.push(value);
  };
  for (const probe of probes) {
    const snapshot = await db
      .collection(probe.collection)
      .where(probe.field, "==", toHash)
      .limit(IDENTITY_PROBE_LIMIT)
      .get();
    for (const doc of snapshot.docs) {
      const data = asRecord(doc.data());
      for (const field of probe.valueFields) {
        const raw = asString(data[field], "").trim();
        // 되찾은 평문이 정말 그 해시인지 확인한다 — 원장 필드가 어긋나도 엉뚱한 대화에 붙지 않는다.
        // (해시는 소문자 정규화를 거치므로 원본 케이싱 값도 그대로 대조된다.)
        if (!raw || recipientIdentityHash(raw) !== toHash) continue;
        push(raw.toLowerCase());
        push(raw);
      }
    }
    // 리뷰(재검증 M-1): 소문자 변형만으로 멈추면 콜드메일 원장의 **원본 케이싱**을 못 본다 —
    // 케이싱 변형(정규 소문자 외 1개 이상)을 얻었거나 상한에 닿았을 때만 멈춘다. 읽기 증가는
    // 해시당 최대 프로브 수(상수)로 여전히 유계다.
    if (variants.length >= IDENTITY_VARIANT_LIMIT || variants.some((v) => v !== v.toLowerCase())) break;
  }
  return variants;
}

/**
 * 스레드 선택 규칙(스펙 고정):
 *   1) 발신 시각 **이전**이면서 **최신성 창(30일) 안**의 lastInboundAtIso 가 가장 최근인 대화 —
 *      그 발신이 응답한 스레드다. 창을 두는 이유: 3년 전 답장하고 끊긴 스레드가 규칙 1이라는
 *      이유만으로 어제 활발한 스레드를 이기면 안 된다.
 *   2) 그런 대화가 없으면 **발신 시각 이전의** 최근 활동(lastMessageAtIso → lastInboundAtIso →
 *      updatedAtIso) 이 가장 큰 대화. 발신 이후 활동만 있는 대화는 그 발신이 향한 곳이 아니다.
 *   둘 다 비면 **지어내지 않는다**(빈 문자열 → skippedNoEligibleThread). 발신보다 미래의 대화만
 *   있는 상태에서 "그중 가장 가까운 것"을 고르는 건 근거 없는 추정이다.
 *   동률은 대화 id 오름차순으로 끊는다(재실행마다 같은 답).
 */
function pickStitchConversation(
  candidates: ConversationCandidate[],
  sentAtMs: number,
): string {
  if (candidates.length === 0 || !Number.isFinite(sentAtMs)) return "";
  const ordered = [...candidates].sort((left, right) => left.id.localeCompare(right.id));
  const recentInbound = ordered.filter((row) =>
    Number.isFinite(row.lastInboundAtMs)
    && row.lastInboundAtMs <= sentAtMs
    && sentAtMs - row.lastInboundAtMs <= STITCH_INBOUND_RECENCY_WINDOW_MS);
  const pool = recentInbound.length > 0
    ? recentInbound
    : ordered.filter((row) => Number.isFinite(row.recencyMs) && row.recencyMs <= sentAtMs);
  if (pool.length === 0) return "";
  const key = recentInbound.length > 0
    ? (row: ConversationCandidate) => row.lastInboundAtMs
    : (row: ConversationCandidate) => row.recencyMs;
  let best = pool[0];
  for (const row of pool.slice(1)) {
    if (key(row) > key(best)) best = row;
  }
  return best.id;
}

/**
 * 계정 경계 (personal Sent ingest — feat/personal-sent-ingest):
 *   대화의 `mailAccountId` 는 **그 대화를 소유한 수집 계정**이다(persistReceivedEmail 의 sticky
 *   stamp — 최초 인바운드가 귀속시키고 이후 다른 계정이 뒤집지 못한다). 편입 발신은 그 경계를
 *   넘지 않는다:
 *     · 개인 계정 발송분 → 같은 계정이 귀속받은 대화만. 미귀속(legacy) 대화에 붙이면 scp 화면
 *       컨텍스트에 개인 발신이 섞인다. 안 붙는 행은 skippedNoConversationForIdentity 로 남고,
 *       그 대화로 개인 인바운드가 도착해 귀속되면 다음 회차에 자연히 물질화된다.
 *     · canonical/legacy 발송분("scp"·무스탬프) → 미귀속 또는 "scp" 귀속 대화만. 개인 계정이
 *       귀속받은 대화로 scp 발신이 새는 것도 막는다 — 경계는 양방향이다.
 *   ※ 스티치는 대화의 소유권 필드를 쓰지 않는다(읽기만) — 귀속은 인바운드 레인의 몫이다.
 */
function conversationEligibleForAccount(rowMailAccountId: string, conversationMailAccountId: string): boolean {
  if (rowMailAccountId && rowMailAccountId !== "scp") {
    return conversationMailAccountId === rowMailAccountId;
  }
  return !conversationMailAccountId || conversationMailAccountId === "scp";
}

async function findConversationForRow(
  db: FirebaseFirestore.Firestore,
  row: StitchLedgerRow,
  identityCache: Map<string, string[]>,
): Promise<ConversationMatch> {
  if (!row.toHash) return { kind: "skip", reason: "no_identity" };
  let emails = identityCache.get(row.toHash);
  if (emails === undefined) {
    emails = await resolveRecipientEmails(db, row.toHash);
    identityCache.set(row.toHash, emails);
  }
  if (emails.length === 0) return { kind: "skip", reason: "no_identity" };

  const byId = new Map<string, ConversationCandidate>();
  for (const email of emails) {
    const snapshot = await db
      .collection(CONVERSATIONS_COLLECTION)
      .where("creatorEmail", "==", email)
      .limit(CONVERSATION_CANDIDATE_LIMIT)
      .get();
    // 상한에 꽉 찼다 = 후보가 잘렸을 수 있다. 잘린 집합에서 "가장 그럴듯한 하나"를 고르면
    // 조회 상한이 곧 정답을 바꾸는 셈이라 재현성이 없다. 물질화를 거부하고 숫자로 남긴다.
    //
    // ■ 왜 `.orderBy("lastMessageAtIso","desc")` 를 붙이지 않는가 (H1c 판단)
    //   정렬의 목적은 "잘릴 때 오래된 쪽이 잘리게" 하는 것인데, 이 레인은 **잘린 집합을 아예
    //   쓰지 않는다**(바로 위 거부). 즉 정렬은 결과를 하나도 바꾸지 못한다.
    //   반대로 비용은 실재한다: 등가+정렬은 복합 색인
    //   `conversations(creatorEmail ASC, lastMessageAtIso DESC, __name__ DESC)` 를 요구하는데
    //   지금 매니페스트에 creatorEmail 색인은 **없다**(firestore.indexes.json 실측). 붙이는 순간
    //   색인 배포 전까지 이 조회가 FAILED_PRECONDITION 으로 통째로 죽는다 — R28-7·W75-R1·W114-F 와
    //   같은 사고 형상이다. 나중에 상한을 올려 잘린 집합을 쓰기로 바꾼다면, 그때 3중 장부
    //   (firestore.indexes.json + PRODUCTION_REQUIRED_INDEXES + CRITICAL_QUERY_SHAPES)에 색인을
    //   add-only 로 등재하고 정렬을 붙여야 한다.
    if (snapshot.docs.length >= CONVERSATION_CANDIDATE_LIMIT) {
      return { kind: "skip", reason: "ambiguous" };
    }
    for (const doc of snapshot.docs) {
      if (byId.has(doc.id)) continue;
      const data = asRecord(doc.data());
      // 스펙의 대조축을 그대로 다시 확인한다: sha256(creatorEmail)[:24] === toHash.
      if (recipientIdentityHash(asString(data.creatorEmail, "")) !== row.toHash) continue;
      // 계정 경계 — 수신자가 같아도 발신 계정이 다른 대화에는 붙지 않는다(위 헬퍼 주석 참조).
      if (!conversationEligibleForAccount(row.mailAccountId, asString(data.mailAccountId, ""))) continue;
      const lastInboundAtMs = parseMs(data.lastInboundAtIso);
      const recencyCandidates = [
        parseMs(data.lastMessageAtIso),
        lastInboundAtMs,
        parseMs(data.updatedAtIso),
      ].filter((value) => Number.isFinite(value));
      byId.set(doc.id, {
        id: doc.id,
        lastInboundAtMs,
        recencyMs: recencyCandidates.length > 0 ? Math.max(...recencyCandidates) : Number.NaN,
      });
    }
  }
  if (byId.size === 0) return { kind: "skip", reason: "no_conversation_for_identity" };
  const conversationId = pickStitchConversation([...byId.values()], row.sentAtMs);
  return conversationId
    ? { kind: "matched", conversationId }
    : { kind: "skip", reason: "no_eligible_thread" };
}

async function loadEntriesByTrackingIds(
  db: FirebaseFirestore.Firestore,
  trackingIds: string[],
  limit: number,
): Promise<LedgerEntry[]> {
  const unique = [...new Set(trackingIds.filter(Boolean))].slice(0, limit);
  if (unique.length === 0) return [];
  const snapshots = await Promise.all(
    unique.map((trackingId) => db.collection(OUTBOX_COLLECTION).doc(trackingId).get()),
  );
  const entries: LedgerEntry[] = [];
  for (const snapshot of snapshots) {
    if (!snapshot.exists) continue;
    const outcome = ledgerRow(snapshot);
    if (outcome.kind === "foreign") continue;
    entries.push({ id: snapshot.id, outcome });
  }
  return entries;
}

async function loadEntriesByScan(
  db: FirebaseFirestore.Firestore,
  cursor: string,
  limit: number,
): Promise<{ entries: LedgerEntry[]; lastId: string; exhausted: boolean }> {
  let query = db
    .collection(OUTBOX_COLLECTION)
    .where("source", "==", IMPORT_SOURCE)
    .orderBy(FieldPath.documentId());
  if (cursor) query = query.startAfter(cursor);
  const snapshot = await query.limit(limit).get();
  const entries: LedgerEntry[] = [];
  for (const doc of snapshot.docs) {
    const outcome = ledgerRow(doc);
    if (outcome.kind === "foreign") continue;
    entries.push({ id: doc.id, outcome });
  }
  return {
    entries,
    lastId: snapshot.docs.at(-1)?.id ?? "",
    exhausted: snapshot.docs.length < limit,
  };
}

/**
 * 목록 프리뷰 갱신 판정.
 * 이 발신보다 **최신** 활동이 이미 있으면 건드리지 않는다 — 사후 물질화가 목록 정렬을 되감으면
 * 안 된다. 기존 값이 없는 경우는 프리뷰가 비어 있다는 뜻이라 채우는 게 이득이다.
 */
function shouldRefreshPreview(
  conversation: Record<string, unknown>,
  sentAtMs: number,
): boolean {
  const existing = parseMs(conversation.lastMessageAtIso);
  return !Number.isFinite(existing) || existing < sentAtMs;
}

/**
 * 메시지 문서 본문. persistSentEmail 의 아웃바운드 컨벤션을 따른다.
 * createdAtIso 는 필수다 — 대화 메시지 조회가 createdAtIso 로 orderBy 하므로 없으면 화면에서
 * 문서 자체가 빠진다(read.ts listConversationMessages). 발신 시각을 그대로 쓴다.
 */
function stitchMessageDocument(
  row: StitchLedgerRow,
  messageId: string,
  text: string,
): Record<string, unknown> {
  return {
    id: messageId,
    from: "human",
    text,
    summaryKr: text,
    // 제목은 본문 프리뷰와 섞지 않고 자기 필드로 남긴다.
    // ■ 용도는 **relabel 멱등 판정 전용**이다(리뷰 L3). 화면에는 전달되지 않는다 —
    //   `read.ts projectConversationMessageForClient` 의 화이트리스트에 없어 클라이언트로 나가지 않고,
    //   화면 문구는 `text`(본문 프리뷰 우선) 한 축이다. 이 필드가 없으면 relabel 이 매 회차
    //   "제목이 바뀌었다"로 오판해 쓰기를 반복한다.
    subject: row.subject,
    trackingId: row.trackingId,
    messageRef: row.sourceRefPath,
    deliveryState: "sent",
    createdAtIso: row.sentAtIso,
    sentAtIso: row.sentAtIso,
    mailEventAtIso: row.sentAtIso,
    source: IMPORT_SOURCE,
    mailType: IMPORT_MAIL_TYPE,
    // persistReceivedEmail 의 per-event 스탬프와 같은 축 — 어느 계정의 Sent 에서 온 발신인가.
    // 역대 편입분(필드 없음)은 키를 생략해 종전 문서와 바이트 동일하게 유지한다.
    ...(row.mailAccountId ? { mailAccountId: row.mailAccountId } : {}),
    sourceRefs: [makeSourceRef(row.sourceRefPath, "message_source", text)],
  };
}

/**
 * 원장 역기록 페이로드. **`conversationId` 를 쓰지 않는다** — 파일 헤더 C1 참조(형제 4개 레인이
 * 읽는 공유 축이다). 이 두 필드는 이 레인 **전용 쓰기 필드**이고, 읽는 곳도 이 레인뿐이다.
 */
function ledgerBackrefPayload(conversationId: string, stitchedAtIso: string): Record<string, unknown> {
  return { stitchedConversationId: conversationId, conversationStitchedAtIso: stitchedAtIso };
}

async function materializeRow(
  db: FirebaseFirestore.Firestore,
  row: StitchLedgerRow,
  conversationId: string,
  stitchedAtIso: string,
  dryRun: boolean,
): Promise<{ outcome: StitchWriteOutcome; previewUpdated: boolean }> {
  const conversationRef = db.collection(CONVERSATIONS_COLLECTION).doc(conversationId);
  const messageRef = conversationRef.collection("messages").doc(stitchMessageId(row.trackingId));
  const text = stitchMessageText(row);

  if (dryRun) {
    // dry-run 은 **읽기만** 한다. 계획이 실제 회차와 같은 판정을 내도록 같은 문서를 읽는다.
    const existing = await messageRef.get();
    // 여기 오는 행은 원장 역기록이 비어 있다(있으면 호출 전에 걸러진다). 메시지만 있다면
    // 실제 회차가 할 일은 역기록 채우기다.
    if (existing.exists) return { outcome: "ledger_backfilled", previewUpdated: false };
    const conversation = await conversationRef.get();
    return {
      outcome: "materialized",
      previewUpdated: shouldRefreshPreview(asRecord(conversation.data()), row.sentAtMs),
    };
  }

  return db.runTransaction(async (transaction) => {
    // 읽기를 모두 먼저 한다(Firestore 트랜잭션 규약: read-before-write).
    const messageSnapshot = await transaction.get(messageRef);
    const conversationSnapshot = await transaction.get(conversationRef);
    const ledgerSnapshot = await transaction.get(row.ref);
    const ledgerStitched = asString(asRecord(ledgerSnapshot.data()).stitchedConversationId, "");

    if (messageSnapshot.exists) {
      // 메시지는 있는데 역기록만 빠진 상태(중단된 회차) — 역기록만 채우고 메시지는 덮지 않는다.
      if (ledgerStitched === conversationId) {
        return { outcome: "noop" as StitchWriteOutcome, previewUpdated: false };
      }
      transaction.set(row.ref, ledgerBackrefPayload(conversationId, stitchedAtIso), { merge: true });
      return { outcome: "ledger_backfilled" as StitchWriteOutcome, previewUpdated: false };
    }

    transaction.set(messageRef, stitchMessageDocument(row, messageRef.id, text));
    const previewUpdated = shouldRefreshPreview(asRecord(conversationSnapshot.data()), row.sentAtMs);
    if (previewUpdated) {
      // 정확히 이 3필드만 쓴다. `unread` 는 절대 건드리지 않는다 — 사후 물질화가 미읽음·알림을
      // 만들면 "지금 도착한 메시지"로 오독된다. lastMessageFrom 은 "human" 이다: "creator" 로
      // 쓰면 회신 판정 레인(slackDailyReport.ts:76, scpColdmailHistory.ts:1030 등)이 우리 발신을
      // 크리에이터 답장으로 센다.
      transaction.set(conversationRef, {
        lastMessage: text,
        lastMessageFrom: "human",
        lastMessageAtIso: row.sentAtIso,
      }, { merge: true });
    }
    transaction.set(row.ref, ledgerBackrefPayload(conversationId, stitchedAtIso), { merge: true });
    return { outcome: "materialized" as StitchWriteOutcome, previewUpdated };
  });
}

type RelabelCounter =
  | "relabeled"
  | "relabelNoop"
  | "relabelSkippedNotStitched"
  | "relabelSkippedMissingMessage"
  | "unhidden"
  | "unhideNoop";

type RelabelOutcome = {
  counter: RelabelCounter;
  conversationId: string;
  hiddenMarked: boolean;
  previewUpdated: boolean;
  /** 숨긴 메시지의 문구가 목록 프리뷰에 그대로 남았다(리뷰 M1) — 되감지 않고 드러낸다. */
  previewStaleAfterHide: boolean;
};

/**
 * 이미 물질화된 메시지 1건의 정정 계획. 바뀔 게 없으면 `null` — 멱등의 근거다.
 *
 * `hiddenReason` 은 **달기만 하고 떼지 않는다**. 중복 근거가 사라져 보이는 경우는 대개 조회 상한
 * (TOOL_DUPLICATE_PROBE_LIMIT)에 걸려 못 본 것이지 "중복이 아니게 된 것"이 아니다. 매 회차 마킹이
 * 붙었다 떨어지면 화면이 깜빡인다 — 되돌리기는 사람이 `mode: "unhide"` 로 판단한다.
 * 마킹에는 시각과 **근거 원장 식별자**를 같이 남긴다: 그게 없으면 왜 사라졌는지 되짚을 수 없다.
 */
function relabelPlan(
  current: Record<string, unknown>,
  row: StitchLedgerRow,
  text: string,
  duplicate: ToolDuplicateVerdict,
  hiddenAtIso: string,
): { payload: Record<string, unknown>; textChanged: boolean; hiddenMarked: boolean } | null {
  const payload: Record<string, unknown> = {};
  const textChanged = asString(current.text, "") !== text;
  if (textChanged) {
    payload.text = text;
    payload.summaryKr = text;
    payload.sourceRefs = [makeSourceRef(row.sourceRefPath, "message_source", text)];
  }
  if (asString(current.subject, "") !== row.subject) payload.subject = row.subject;
  const hiddenMarked = duplicate.kind === "duplicate"
    && asString(current.hiddenReason, "") !== HIDDEN_TOOL_DUPLICATE;
  if (hiddenMarked) {
    payload.hiddenReason = HIDDEN_TOOL_DUPLICATE;
    payload.hiddenAtIso = hiddenAtIso;
    payload.hiddenEvidenceTrackingId = duplicate.trackingId;
  }
  if (Object.keys(payload).length === 0) return null;
  return { payload, textChanged, hiddenMarked };
}

/**
 * 대화 목록 프리뷰가 **정확히 이 메시지의 문구**인지. 문구와 시각이 둘 다 일치할 때만 참이다.
 * 그 뒤에 다른 메시지가 프리뷰를 덮었다면 거짓 — 사후 정정이 목록을 되감으면 안 된다.
 */
function previewShowsMessage(
  conversation: Record<string, unknown>,
  row: StitchLedgerRow,
  messageText: string,
): boolean {
  if (!messageText) return false;
  return asString(conversation.lastMessage, "") === messageText
    && asString(conversation.lastMessageAtIso, "") === row.sentAtIso;
}

/** 숨김 마킹 제거 페이로드. 필드만 지우고 **메시지 문서는 남긴다**. */
function unhidePayload(): Record<string, unknown> {
  return {
    hiddenReason: FieldValue.delete(),
    hiddenAtIso: FieldValue.delete(),
    hiddenEvidenceTrackingId: FieldValue.delete(),
  };
}

/**
 * 재라벨 1건. 대화를 새로 찾지 않는다 — 원장이 이미 기록한 `stitchedConversationId` 만 따라간다.
 * 메시지 문서를 **지우지 않는다**: 중복은 `hiddenReason` 마킹으로만 처리한다.
 *
 * 숨겨진(또는 이번에 숨기는) 메시지는 **목록 프리뷰를 건드리지 않는다**(리뷰 M1). 그 자리를 대신할
 * 메시지를 이 레인은 모르기 때문이다 — 대신 구 문구가 남았다는 사실을 카운터로 드러낸다.
 */
async function relabelRow(
  db: FirebaseFirestore.Firestore,
  row: StitchLedgerRow,
  duplicate: ToolDuplicateVerdict,
  hiddenAtIso: string,
  dryRun: boolean,
): Promise<RelabelOutcome> {
  const conversationId = row.stitchedConversationId;
  const miss = (counter: RelabelCounter, id = conversationId): RelabelOutcome => ({
    counter,
    conversationId: id,
    hiddenMarked: false,
    previewUpdated: false,
    previewStaleAfterHide: false,
  });
  if (!conversationId) return miss("relabelSkippedNotStitched", "");
  const conversationRef = db.collection(CONVERSATIONS_COLLECTION).doc(conversationId);
  const messageRef = conversationRef.collection("messages").doc(stitchMessageId(row.trackingId));
  const text = stitchMessageText(row);

  const decide = (
    current: Record<string, unknown>,
    conversation: Record<string, unknown>,
  ): { plan: ReturnType<typeof relabelPlan>; outcome: RelabelOutcome } => {
    const plan = relabelPlan(current, row, text, duplicate, hiddenAtIso);
    // 이번에 숨기든, 이미 숨겨져 있든 — 숨은 메시지의 문구는 목록을 대표할 수 없다.
    const hidden = plan?.hiddenMarked === true
      || asString(current.hiddenReason, "") === HIDDEN_TOOL_DUPLICATE;
    const previewIsThisMessage = previewShowsMessage(conversation, row, asString(current.text, ""));
    if (!plan) {
      return {
        plan,
        outcome: {
          counter: "relabelNoop",
          conversationId,
          hiddenMarked: false,
          previewUpdated: false,
          previewStaleAfterHide: hidden && previewIsThisMessage,
        },
      };
    }
    return {
      plan,
      outcome: {
        counter: "relabeled",
        conversationId,
        hiddenMarked: plan.hiddenMarked,
        previewUpdated: !hidden && plan.textChanged && previewIsThisMessage,
        previewStaleAfterHide: hidden && previewIsThisMessage,
      },
    };
  };

  if (dryRun) {
    const existing = await messageRef.get();
    if (!existing.exists) return miss("relabelSkippedMissingMessage");
    const conversation = await conversationRef.get();
    return decide(asRecord(existing.data()), asRecord(conversation.data())).outcome;
  }

  return db.runTransaction(async (transaction) => {
    const messageSnapshot = await transaction.get(messageRef);
    const conversationSnapshot = await transaction.get(conversationRef);
    if (!messageSnapshot.exists) return miss("relabelSkippedMissingMessage");
    const { plan, outcome } = decide(
      asRecord(messageSnapshot.data()),
      asRecord(conversationSnapshot.data()),
    );
    if (!plan) return outcome;
    transaction.set(messageRef, plan.payload, { merge: true });
    // 프리뷰는 문구 1필드만 고친다 — 시각·발신자·미읽음은 물질화 때와 똑같이 무접촉이다.
    if (outcome.previewUpdated) transaction.set(conversationRef, { lastMessage: text }, { merge: true });
    return outcome;
  });
}

/**
 * 숨김 해제 1건(리뷰 M2). 관리자가 지목한 행의 마킹만 걷어낸다 — 라벨/프리뷰는 손대지 않는다.
 * 이미 숨김이 아니면 아무것도 쓰지 않는다(멱등).
 */
async function unhideRow(
  db: FirebaseFirestore.Firestore,
  row: StitchLedgerRow,
  dryRun: boolean,
): Promise<RelabelOutcome> {
  const conversationId = row.stitchedConversationId;
  /** unhide 는 라벨·프리뷰를 손대지 않으므로 결말이 카운터 하나로 끝난다. */
  const settle = (counter: RelabelCounter, id = conversationId): RelabelOutcome => ({
    counter,
    conversationId: id,
    hiddenMarked: false,
    previewUpdated: false,
    previewStaleAfterHide: false,
  });
  if (!conversationId) return settle("relabelSkippedNotStitched", "");
  const messageRef = db
    .collection(CONVERSATIONS_COLLECTION)
    .doc(conversationId)
    .collection("messages")
    .doc(stitchMessageId(row.trackingId));

  if (dryRun) {
    const existing = await messageRef.get();
    if (!existing.exists) return settle("relabelSkippedMissingMessage");
    const hidden = asString(asRecord(existing.data()).hiddenReason, "") === HIDDEN_TOOL_DUPLICATE;
    return settle(hidden ? "unhidden" : "unhideNoop");
  }

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(messageRef);
    if (!snapshot.exists) return settle("relabelSkippedMissingMessage");
    if (asString(asRecord(snapshot.data()).hiddenReason, "") !== HIDDEN_TOOL_DUPLICATE) {
      return settle("unhideNoop");
    }
    transaction.set(messageRef, unhidePayload(), { merge: true });
    return settle("unhidden");
  });
}

/**
 * 편입 원장 → 대화 메시지 물질화.
 *
 * `trackingIds` 를 주면 그 행만 본다(스케줄 편승 — 방금 편입된 분량).
 * 주지 않으면 `cursor` 부터 편입 원장을 훑는다(백필 — 반복 호출로 전량).
 * `mode: "relabel"` 이면 물질화하지 않고 **이미 붙인 메시지의 라벨만** 새 규칙으로 다시 쓴다.
 * `mode: "unhide"` 는 지목한 `trackingIds` 의 숨김 마킹만 걷어낸다.
 *
 * 리뷰 L1: `trackingIds` 는 **모든 모드에서 존중된다**. relabel 에 넘겨도 조용히 무시하지 않고
 * 그 행만 본다(사람이 한 건을 짚어 고치는 경로가 실제로 필요하다).
 */
export async function stitchExternalSentConversationsCore(
  input: {
    trackingIds?: string[];
    cursor?: string;
    limit?: number;
    dryRun?: boolean;
    /**
     * `"relabel"`·`"unhide"` 만 의미가 있다. 나머지는 trackingIds 유무로 정해진다(기존 계약 유지).
     * `"unhide"` 는 trackingIds 가 반드시 있어야 한다.
     */
    mode?: ExternalSentStitchMode;
    /** 이 시각(ms)을 넘기면 남은 행은 손대지 않고 `deferred` 로 남긴다. */
    stitchDeadlineMs?: number;
    actorUid?: string;
    actorRole?: string;
  } = {},
  deps: ExternalSentStitchDeps = {},
): Promise<ExternalSentStitchResult> {
  const db = deps.db ?? adminDb;
  const now = deps.now ?? Date.now;
  const limit = boundedLimit(input.limit);
  const dryRun = input.dryRun === true;
  const mode: ExternalSentStitchMode = input.mode === "relabel" || input.mode === "unhide"
    ? input.mode
    : input.trackingIds ? "tracking_ids" : "scan";
  // 리뷰 M2: unhide 는 전량 스윕이 아니라 **지목**이다. 커서로 훑게 두면 사람이 의도하지 않은 대량
  // 해제가 한 호출로 일어난다 — 대상을 명시하지 않으면 아무것도 하지 않고 거부한다.
  if (mode === "unhide" && (input.trackingIds ?? []).length === 0) {
    throw Object.assign(new Error("invalid-argument: unhide requires trackingIds."), {
      code: "invalid-argument",
      errorCode: "stitch_external_sent_conversations_unhide_tracking_ids_required",
    });
  }
  const cursor = asString(input.cursor, "");
  const actorUid = asString(input.actorUid, STITCH_ACTOR_SYSTEM_UID);
  const actorRole = asString(input.actorRole, STITCH_ACTOR_SYSTEM_ROLE);
  const deadlineMs = Number.isFinite(Number(input.stitchDeadlineMs))
    ? Number(input.stitchDeadlineMs)
    : Number.POSITIVE_INFINITY;

  // relabel 도 편입 원장을 같은 커서로 훑는다 — 커서 의미(문서 id 오름차순)가 물질화와 동일해야
  // 두 모드가 같은 진행률 표를 쓴다. 다만 trackingIds 가 오면 어느 모드든 그 행만 본다(리뷰 L1).
  const scan = input.trackingIds ? null : await loadEntriesByScan(db, cursor, limit);
  const entries = scan ? scan.entries : await loadEntriesByTrackingIds(db, input.trackingIds ?? [], limit);

  const counts = {
    matched: 0,
    previewUpdated: 0,
    alreadyStitchedLedger: 0,
    alreadyStitchedMessage: 0,
    alreadyStitchedNoop: 0,
    skippedNoIdentity: 0,
    skippedNoConversationForIdentity: 0,
    skippedNoEligibleThread: 0,
    skippedAmbiguous: 0,
    skippedToolDuplicate: 0,
    skippedToolDuplicateUnknown: 0,
    skippedNoTimestamp: 0,
    skippedIdMismatch: 0,
    skippedMalformedRow: 0,
    relabeled: 0,
    relabelNoop: 0,
    relabelSkippedNotStitched: 0,
    relabelSkippedMissingMessage: 0,
    hiddenMarked: 0,
    previewStaleAfterHide: 0,
    unhidden: 0,
    unhideNoop: 0,
    deferred: 0,
  };
  const skipCounter: Record<LedgerSkipReason, keyof typeof counts> = {
    id_mismatch: "skippedIdMismatch",
    malformed: "skippedMalformedRow",
    no_timestamp: "skippedNoTimestamp",
  };
  const matchSkipCounter: Record<ConversationMatchSkip, keyof typeof counts> = {
    no_identity: "skippedNoIdentity",
    no_conversation_for_identity: "skippedNoConversationForIdentity",
    no_eligible_thread: "skippedNoEligibleThread",
    ambiguous: "skippedAmbiguous",
  };
  const identityCache = new Map<string, string[]>();
  /** 수신자+제목 조합당 1회만 툴 발송 원장을 훑는다 — 같은 조합의 편입분이 여러 건이어도 읽기는 상수다. */
  const toolSentCache = new Map<string, { rows: ToolSentRow[]; saturated: boolean }>();
  const pairs: Array<{ trackingId: string; conversationId: string; outcome: AuditPairOutcome }> = [];
  /** 리뷰 M3: 안 보여주기로 한 행. pairs 와 같은 상한·절단 규칙을 쓴다. */
  const suppressed: Array<{ trackingId: string; reason: SuppressionReason }> = [];
  /** W123: 문구가 새 규칙과 같음이 확인된 행(결과 계약 참조). 로그·감사에는 싣지 않는다. */
  const relabelSettledTrackingIds: string[] = [];
  /** 예산 소진으로 끊겼을 때 커서가 여기까지만 전진해야 한다 — 안 그러면 남은 행을 영영 건너뛴다. */
  let lastProcessedId = "";

  for (let index = 0; index < entries.length; index += 1) {
    if (now() >= deadlineMs) {
      counts.deferred = entries.length - index;
      break;
    }
    const entry = entries[index];
    lastProcessedId = entry.id;
    if (entry.outcome.kind === "skip") {
      counts[skipCounter[entry.outcome.reason]] += 1;
      continue;
    }
    const row = entry.outcome.row;
    if (mode === "unhide") {
      const result = await unhideRow(db, row, dryRun);
      counts[result.counter] += 1;
      if (result.counter === "unhidden") {
        pairs.push({
          trackingId: row.trackingId,
          conversationId: result.conversationId,
          outcome: "unhidden",
        });
      }
      continue;
    }
    if (mode === "relabel") {
      // 고칠 메시지가 없는 행에는 중복 판정 읽기를 쓰지 않는다(2,400행 백필에서 그대로 비용이 된다).
      const duplicate: ToolDuplicateVerdict = row.stitchedConversationId
        ? await resolveToolSentDuplicate(db, row, toolSentCache)
        : { kind: "none" };
      const relabelled = await relabelRow(db, row, duplicate, new Date().toISOString(), dryRun);
      counts[relabelled.counter] += 1;
      if (relabelled.hiddenMarked) counts.hiddenMarked += 1;
      if (relabelled.previewUpdated) counts.previewUpdated += 1;
      if (relabelled.previewStaleAfterHide) counts.previewStaleAfterHide += 1;
      // W123: 문구가 맞다고 **확인된** 행만 호출자에게 돌려준다. dry-run 은 아무것도 쓰지 않았으므로
      //   그 판정으로 영속 마킹을 하면 고쳐지지 않은 행이 완료로 굳는다 — 회차째로 비운다.
      if (
        !dryRun &&
        (relabelled.counter === "relabeled" || relabelled.counter === "relabelNoop")
      ) {
        relabelSettledTrackingIds.push(row.trackingId);
      }
      // 감사에는 **실제로 쓴 것**만 남긴다 — noop 은 되돌릴 사건이 없다.
      if (relabelled.counter === "relabeled") {
        pairs.push({
          trackingId: row.trackingId,
          conversationId: relabelled.conversationId,
          outcome: "relabeled",
        });
      }
      if (relabelled.hiddenMarked) {
        suppressed.push({ trackingId: row.trackingId, reason: "hidden_tool_duplicate" });
      }
      continue;
    }
    // 원장 전용 축에 이미 값이 있으면 물질화가 끝난 행이다 — 아무것도 읽지도 쓰지도 않는다.
    if (row.stitchedConversationId) {
      counts.alreadyStitchedLedger += 1;
      continue;
    }
    // 툴 발송의 Sent 사본이면 대화를 찾지도 않는다 — 같은 메일을 두 번 그리지 않는 게 먼저다.
    // 창이 포화돼 판정 못 한 행도 물질화하지 않는다: 근거 없이 그리지 않는다(skippedAmbiguous 와 같은 결).
    const duplicate = await resolveToolSentDuplicate(db, row, toolSentCache);
    if (duplicate.kind !== "none") {
      const reason: SuppressionReason = duplicate.kind === "duplicate"
        ? "tool_duplicate"
        : "tool_duplicate_unknown";
      if (duplicate.kind === "duplicate") counts.skippedToolDuplicate += 1;
      else counts.skippedToolDuplicateUnknown += 1;
      suppressed.push({ trackingId: row.trackingId, reason });
      continue;
    }
    const match = await findConversationForRow(db, row, identityCache);
    if (match.kind === "skip") {
      counts[matchSkipCounter[match.reason]] += 1;
      continue;
    }
    const stitchedAtIso = new Date().toISOString();
    const written = await materializeRow(db, row, match.conversationId, stitchedAtIso, dryRun);
    if (written.outcome === "materialized") counts.matched += 1;
    else if (written.outcome === "ledger_backfilled") counts.alreadyStitchedMessage += 1;
    else counts.alreadyStitchedNoop += 1;
    if (written.previewUpdated) counts.previewUpdated += 1;
    pairs.push({
      trackingId: row.trackingId,
      conversationId: match.conversationId,
      outcome: written.outcome,
    });
  }

  const scanned = entries.length;
  // 예산이 끊겼으면 커서는 **실제로 처리한 마지막 행**까지만 전진한다. 페이지 끝(scan.lastId)으로
  // 밀면 손대지 않은 행을 영영 건너뛴다. 한 건도 처리하지 못했으면 들어온 커서 그대로 되돌린다.
  const nextCursor = scan
    ? (counts.deferred > 0 ? (lastProcessedId || cursor) : (scan.exhausted ? "" : scan.lastId))
    : "";
  // 남은 분량이 있으면 완주가 아니다 — trackingIds 편승도 마찬가지다(다음 회차·백필이 잇는다).
  const done = !nextCursor && counts.deferred === 0;

  // LOG-P0-010: 회차당 감사 문서 1건. 무엇을 어느 대화에 붙였는지(trackingId→conversationId)가
  // 남아야 사후에 되돌릴 수 있다. dry-run 은 아무것도 쓰지 않는 계약이라 제외하고, 검토 행이 0인
  // 회차(10분마다 도는 빈 편승)는 감사할 사건이 없으므로 쓰지 않는다 — 쓰기 증폭 방지.
  let auditRef = "";
  if (!dryRun && scanned > 0) {
    const auditDoc = db.collection(AUDIT_COLLECTION).doc();
    const runAtIso = new Date().toISOString();
    await auditDoc.set({
      id: auditDoc.id,
      // v2: W116 에서 라벨 정정(relabel)·툴 중복 스킵 카운터가 붙었다.
      schemaVersion: "external-sent-stitch-audit-v2",
      actorUid,
      actorRole,
      mode,
      runAtIso,
      expireAt: expireAt180DaysFromIso(runAtIso),
      cursorStart: cursor,
      cursorEnd: nextCursor,
      scanned,
      ...counts,
      // 평문 수신자는 남기지 않는다 — 원장 식별자(trackingId)와 대화 id 만 남긴다.
      pairs: pairs.slice(0, AUDIT_PAIR_LIMIT),
      pairsTruncated: pairs.length > AUDIT_PAIR_LIMIT,
      // 리뷰 M3: 무엇을 **안 보여주기로 했는가**. 이게 없으면 사라진 메시지를 되짚을 근거가 없다.
      suppressed: suppressed.slice(0, AUDIT_PAIR_LIMIT),
      suppressedTruncated: suppressed.length > AUDIT_PAIR_LIMIT,
    });
    auditRef = auditDoc.path;
  }

  const result: ExternalSentStitchResult = {
    ok: true,
    dryRun,
    mode,
    scanned,
    ...counts,
    auditRef,
    suppressed: suppressed.slice(0, AUDIT_PAIR_LIMIT),
    suppressedTruncated: suppressed.length > AUDIT_PAIR_LIMIT,
    relabelSettledTrackingIds,
    nextCursor,
    done,
  };
  // 회차당 로그는 이 한 줄이다(호출부는 따로 성공 로그를 남기지 않는다 — 중복 집계 방지).
  // 커서(trackingId)는 반환값·감사 문서로만 오간다(로그의 원장 식별자 최소화).
  console.log("[external-sent-stitch]", JSON.stringify({
    outcome: "run",
    dryRun,
    mode,
    actorRole,
    scanned,
    ...counts,
    suppressedCount: suppressed.length,
    auditWritten: Boolean(auditRef),
    cursorAdvanced: Boolean(nextCursor),
  }));
  return result;
}

/**
 * 백필 콜러블. dryRun 이 기본이고 `{ dryRun: false, actual: true }` 에서만 쓴다.
 * 역할 게이트는 형제 편입 콜러블(`importManualSentMailToOutbox`)과 같은 등급을 쓴다 —
 * 이 레인은 그 편입분에만 작용하므로 더 넓지도 좁지도 않아야 한다.
 *
 * `{ mode: "relabel" }` 은 이미 물질화된 메시지의 라벨만 정정한다(대화를 새로 찾지 않는다).
 * 같은 커서 계약을 쓰므로 dryRun → actual → 커서 반복이 물질화 백필과 동일하다.
 * `{ mode: "unhide", trackingIds: [...] }` 는 자동 숨김이 틀렸을 때 사람이 되돌리는 문이다 —
 * 지목이 없으면 거부한다(대량 해제를 한 호출로 일으키지 않는다).
 */
export async function stitchExternalSentConversations(
  request: CallableRequestShape,
): Promise<ExternalSentStitchResult> {
  const auth = assertNonGuestAuth(request, "mail_external_sent_stitch.run", STITCH_ROLES);
  const data = asRecord(request.data);
  const dryRun = data.dryRun !== false;
  const actual = data.actual === true || data.execute === true;
  if (!dryRun && !actual) {
    throw Object.assign(new Error("invalid-argument: actual:true is required when dryRun is false."), {
      code: "invalid-argument",
      errorCode: "stitch_external_sent_conversations_actual_required",
    });
  }
  return stitchExternalSentConversationsCore({
    cursor: asString(data.cursor, ""),
    limit: Number(data.limit),
    dryRun,
    ...(asString(data.mode, "") === "relabel" ? { mode: "relabel" as const } : {}),
    // unhide 는 사람이 지목한 행만 되돌린다(커서 스윕 불가) — 목록은 상한까지 그대로 넘긴다.
    ...(asString(data.mode, "") === "unhide"
      ? {
        mode: "unhide" as const,
        trackingIds: (Array.isArray(data.trackingIds) ? data.trackingIds : [])
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      }
      : {}),
    // 리뷰(재검증 M-3): 함수 예산(300s) 안에서 감사 문서 쓰기까지 끝나도록 여유를 남긴다 —
    // 예산이 끊기면 남은 행은 deferred 로 반환되고 다음 호출이 같은 커서에서 잇는다.
    stitchDeadlineMs: Date.now() + 240_000,
    actorUid: auth.userId,
    actorRole: auth.role,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 편입 발신 스티치 **재시도** 레인 (feat/personal-sent-ingest 리뷰 P1 — 영구 정체 수리)
//
// ■ 왜 있는가
//   스케줄 편승은 **그 회차에 편입된 trackingId** 만 넘긴다(functions/index.ts 의
//   stitchTrackingIds). 편입 시점에 매칭이 실패한 행 — 대표적으로 수신자의 대화가 아직
//   없거나 그 계정에 귀속되지 않아 skippedNoConversationForIdentity 로 끝난 개인 발송 —
//   은 다시는 시도되지 않았다. 스캔 모드는 수동 콜러블 뒤에만 있고, 개인 행은 미귀속
//   대화에 붙는 게 금지라(conversationEligibleForAccount) "먼저 보내고 나중에 대화가
//   귀속되는" 상시 경로가 구조적으로 빈다. 그렇게 stitchedConversationId 가 계속 비면
//   mailSignature 의 회신 판정 폴백(listMailOutbox·reconcileMailOutboxReplies)이 발화하지
//   못해 hasReply 가 영영 false — "내가 보낸 메일에 답장 안 온 사람" 질의가 정확히
//   이 행들을 조용히 놓친다.
//
// ■ 형태 — 계정별 순환 커서
//   계정마다 원장 편입분(source=external_sent_mail_import && mailAccountId=계정)을 문서 id
//   순으로 한 창(SENT_IMPORT_STITCH_RETRY_SCAN_LIMIT)씩 훑고, 창 안에서 아직 안 붙은 행을
//   **최신순**으로 최대 SENT_IMPORT_STITCH_RETRY_ROW_LIMIT 개 기존 스티치 코어에 넘긴다
//   (자격·중복·타임스탬프 판정은 코어가 그대로 수행한다 — 이 레인은 후보 선별만 한다).
//   커서는 창 끝으로 전진하고 끝에 닿으면 처음으로 되감긴다 — 그래서 모든 미부착 행이
//   순환적으로 재시도된다. 회차당 읽기는 (계정 수 × 창 크기)로 유계다 — 잔량이 쌓여도
//   회차당 비용이 자라지 않는다.
//
// ■ 왜 sentAtIso 서버 정렬이 아닌가 (색인)
//   등가 2축 + __name__ 정렬은 단일필드 색인 병합으로 서빙된다 — 복합 색인 불요
//   (loadEntriesByScan 의 source+__name__ 과 같은 이치). 여기에 sentAtIso 정렬을 얹는
//   순간 (source, mailAccountId, sentAtIso) 복합 색인이 필요해지고 색인 배포 전까지
//   이 조회는 FAILED_PRECONDITION 으로 통째로 죽는다(H1c 주석과 같은 사고 형상).
//   그래서 최신순 선택은 **가져온 창 안에서만** 한다.
//
// ■ 남는 한계(정직하게)
//   - 한 창 안의 미부착 행이 ROW_LIMIT 을 넘고 최신순 상위가 계속 실패하면, 하위 행은
//     창이 한 바퀴 돌아 되감길 때까지 시도가 밀린다. 완전한 공정성이 아니라 "신선한 실패
//     우선"이다 — 이 레인의 목적(대화 귀속 직후의 재시도)에는 그게 맞다.
//
// ■ mailAccountId 없는 역대 편입 행 — "scp" 계정은 fromHash 로 잡는다 (2026-09-25 수리)
//   프로드 실측: scp Sent 편입분 2,068건 중 8건만 mailAccountId 를 갖는다 — 나머지 ~99.6%는
//   personal-sent-ingest(이 필드를 처음 도입한 기능) 이전에 들어온 역대 행이라 애초에 그
//   필드가 없다. 종전 코드는 "scp" 계정 창도 `mailAccountId == "scp"` 등가로만 잡아, 그
//   역대 행 전량이 어느 창에도 들지 못해 영구히 재시도되지 않았다(대화가 나중에 귀속돼도
//   다시 안 집힘) — 그 결과 `stitchedConversationId` 가 영영 비어 있어 회신 판정
//   (hasReply 폴백)뿐 아니라 자동회신 파이프라인도 "크리에이터가 마지막으로 말했다"로
//   오판할 수 있었다(manualReplyDetection.ts 가 같은 원장을 직접 대조해 별도로 방어한다).
//   fromHash 는 스탬프 유무와 무관하게 **전량**이 갖는다(발신 계정 식별은 임포터가 항상
//   기록했다 — mailExternalSentImport.ts `emailHash(firstSender(parsed))`) — "scp" 계정
//   전용으로 등가축을 mailAccountId 대신 fromHash 로 바꾸면 스탬프된 8건과 역대 2,060건을
//   한 창에서 같이 잡는다. 개인 계정은 그대로 mailAccountId 축을 쓴다(personal-sent-ingest
//   가 그 필드와 함께 도입됐으므로 역대 무스탬프 개인 행 자체가 없다).
const RETRY_CURSOR_COLLECTION = "external_sent_stitch_retry_cursors";
/**
 * scp 메일함 자신의 발신 해시. `manualReplyDetection.ts` 의 같은 상수와 동일한 계산이다
 * (다른 파일에 각자 두는 이유: 이 값을 쓰는 지점이 서로 다른 실행 경로이고, 공유 상수 하나로
 * 묶으면 그쪽 모듈이 이 스티치 파일을 임포트해야 해서 결합이 불필요하게 늘어난다).
 */
const SCP_RETRY_FROM_HASH = recipientIdentityHash(CANONICAL_OPERATIONAL_MAILBOX_V1);
/** 회차·계정당 원장 스캔 창 크기. */
export const SENT_IMPORT_STITCH_RETRY_SCAN_LIMIT = 50;
/** 회차·계정당 스티치 코어에 넘기는 미부착 행 상한. */
export const SENT_IMPORT_STITCH_RETRY_ROW_LIMIT = 25;

export type SentImportStitchRetryAccountOutcome = {
  mailAccountId: string;
  ok: boolean;
  /** 이번 회차 창에서 읽은 편입 원장 문서 수. */
  scanned: number;
  /** 창 안에서 stitchedConversationId 가 없는 행 수(시도 상한 전). */
  pending: number;
  /** 실제로 스티치 코어에 넘긴 행 수(최신순 상한 적용 후). */
  attempted: number;
  /** 물질화 또는 원장 역기록 보완으로 스티치가 완료된 행 수. */
  stitched: number;
  /** 코어가 반환한 스킵 사유 — 이 레인의 진단 축은 P1 의 그 카운터다. */
  skippedNoIdentity: number;
  skippedNoConversationForIdentity: number;
  skippedNoEligibleThread: number;
  /** 창이 끝에 닿아 다음 회차가 처음부터 다시 훑는다(순환의 관측 축). */
  cursorWrapped: boolean;
  /** 실패 시에만 — 분류된 증거이며 원문 에러는 절대 담지 않는다. */
  failureCode?: string;
  correlationIdHash?: string;
};

export type SentImportStitchRetryResult = {
  ok: boolean;
  accountCount: number;
  /** 시간 예산 소진으로 이번 회차 건너뛴 계정 수. */
  deferredAccounts: number;
  scanned: number;
  pending: number;
  attempted: number;
  stitched: number;
  outcomes: SentImportStitchRetryAccountOutcome[];
};

/**
 * 계정 단위로 미부착 편입 행을 다시 시도한다.
 *
 * `accountIds` 는 호출자가 결정한다 — 스케줄 호출부는 방금 돌린 개인 계정 인벤토리의
 * outcome 에서 얻는다(실패 계정도 포함한다: IMAP 실패와 미부착 스티치는 무관하다).
 * "scp" 를 넣으면 canonical 스탬프 행도 순환 대상이 된다 — 같은 영구 정체가 거기에도
 * 있기 때문이다. "scp" 창은 mailAccountId 대신 fromHash 로 잡으므로(위 파일 헤더 주석)
 * mailAccountId 무스탬프 역대 행도 이 창에 들어온다. 개인 계정은 여전히 mailAccountId
 * 축이다 — personal-sent-ingest 가 그 필드와 함께 도입돼 역대 무스탬프 개인 행이 없다.
 */
export async function retryUnstitchedSentImportStitches(
  input: {
    accountIds: readonly string[];
    scanLimit?: number;
    rowLimit?: number;
    /** 이 시각(ms)을 넘기면 남은 계정은 다음 회차로 미룬다. */
    stitchDeadlineMs?: number;
  },
  deps: ExternalSentStitchDeps = {},
): Promise<SentImportStitchRetryResult> {
  const db = deps.db ?? adminDb;
  const now = deps.now ?? Date.now;
  const deadlineMs = Number.isFinite(Number(input.stitchDeadlineMs))
    ? Number(input.stitchDeadlineMs)
    : Number.POSITIVE_INFINITY;
  const scanLimit = Math.min(
    Math.max(Math.trunc(Number(input.scanLimit ?? SENT_IMPORT_STITCH_RETRY_SCAN_LIMIT)) || SENT_IMPORT_STITCH_RETRY_SCAN_LIMIT, 1),
    200,
  );
  const rowLimit = Math.min(
    Math.max(Math.trunc(Number(input.rowLimit ?? SENT_IMPORT_STITCH_RETRY_ROW_LIMIT)) || SENT_IMPORT_STITCH_RETRY_ROW_LIMIT, 1),
    EXTERNAL_SENT_STITCH_MAX_ROWS,
  );
  const accountIds = [...new Set(
    input.accountIds.map((value) => asString(value, "")).filter(Boolean),
  )];
  const outcomes: SentImportStitchRetryAccountOutcome[] = [];
  let deferredAccounts = 0;

  for (const accountId of accountIds) {
    if (now() >= deadlineMs) {
      deferredAccounts = accountIds.length - outcomes.length;
      break;
    }
    try {
      const cursorRef = db.collection(RETRY_CURSOR_COLLECTION)
        .doc(`acct-${accountId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120) || "unknown"}`);
      const cursorSnapshot = await cursorRef.get();
      const after = asString(asRecord(cursorSnapshot.data()).lastId, "");
      // "scp" 는 fromHash 축으로 잡는다(스탬프 유무 무관 — 위 파일 헤더 주석). 다른 계정은
      // 종전대로 mailAccountId 등가다. 둘 다 등가 2축 + __name__ 정렬이라 같은 이치로
      // 복합 색인이 필요 없다(loadEntriesByScan/이 함수의 기존 쿼리와 동일한 형태).
      const useScpFromHash = accountId === "scp" && Boolean(SCP_RETRY_FROM_HASH);
      let query: FirebaseFirestore.Query = db.collection(OUTBOX_COLLECTION)
        .where("source", "==", IMPORT_SOURCE)
        .where(useScpFromHash ? "fromHash" : "mailAccountId", "==", useScpFromHash ? SCP_RETRY_FROM_HASH : accountId)
        .orderBy(FieldPath.documentId());
      if (after) query = query.startAfter(after);
      const snapshot = await query.limit(scanLimit).get();
      // 창 안의 미부착 행만 추려 **최신순**으로 자른다 — 서버 정렬은 복합 색인이 필요해 금지(위 주석).
      const pendingRows = snapshot.docs
        .map((doc) => {
          const data = asRecord(doc.data());
          return {
            trackingId: doc.id,
            sentAtMs: parseMs(data.sentAtIso),
            unstitched: asString(data.stitchedConversationId, "") === "",
          };
        })
        .filter((row) => row.unstitched)
        .sort((left, right) =>
          (Number.isFinite(right.sentAtMs) ? right.sentAtMs : Number.NEGATIVE_INFINITY)
          - (Number.isFinite(left.sentAtMs) ? left.sentAtMs : Number.NEGATIVE_INFINITY));
      const attemptedIds = pendingRows.slice(0, rowLimit).map((row) => row.trackingId);
      let stitch: Pick<
        ExternalSentStitchResult,
        "matched" | "alreadyStitchedMessage" | "skippedNoIdentity"
          | "skippedNoConversationForIdentity" | "skippedNoEligibleThread"
      > = {
        matched: 0,
        alreadyStitchedMessage: 0,
        skippedNoIdentity: 0,
        skippedNoConversationForIdentity: 0,
        skippedNoEligibleThread: 0,
      };
      if (attemptedIds.length > 0) {
        const result = await stitchExternalSentConversationsCore(
          { trackingIds: attemptedIds, stitchDeadlineMs: deadlineMs },
          { db, now },
        );
        stitch = result;
      }
      // 커서는 **스캔 위치**로 전진한다 — 시도에 실패한 행은 미부착 상태로 남아 다음 순환에
      // 다시 잡힌다. 창이 끝에 닿으면(lastId 소진) 처음으로 되감겨 재순환한다.
      const exhausted = snapshot.docs.length < scanLimit;
      await cursorRef.set({
        schemaVersion: "sent-import-stitch-retry-cursor-v1",
        accountId,
        lastId: exhausted ? "" : (snapshot.docs.at(-1)?.id ?? ""),
        updatedAtIso: new Date(now()).toISOString(),
      }, { merge: true });
      outcomes.push({
        mailAccountId: accountId,
        ok: true,
        scanned: snapshot.docs.length,
        pending: pendingRows.length,
        attempted: attemptedIds.length,
        stitched: stitch.matched + stitch.alreadyStitchedMessage,
        skippedNoIdentity: stitch.skippedNoIdentity,
        skippedNoConversationForIdentity: stitch.skippedNoConversationForIdentity,
        skippedNoEligibleThread: stitch.skippedNoEligibleThread,
        cursorWrapped: exhausted,
      });
    } catch (error) {
      // 계정별 격리 — 한 계정의 스캔/스티치 실패가 나머지 계정과 호스트 스윕을 막지 않는다
      // (mailImapIngest 의 계정 루프·importSentMailForActivePersonalAccounts 와 같은 결).
      // 로그는 분류된 증거만 — 원문 에러(사서함·토큰 잔재가 섞일 수 있다)는 담지 않는다.
      const evidence = safeOutboundFailureEvidence(
        error,
        `sent-import-stitch-retry:${accountId}`,
      );
      console.warn("[external-sent-stitch]", JSON.stringify({
        outcome: "retry_account_failed",
        mailAccountId: accountId,
        errorCode: evidence.errorCode,
        failureKind: evidence.failureKind,
        failureRuleId: evidence.failureRuleId,
        correlationIdHash: evidence.correlationIdHash,
      }));
      outcomes.push({
        mailAccountId: accountId,
        ok: false,
        scanned: 0,
        pending: 0,
        attempted: 0,
        stitched: 0,
        skippedNoIdentity: 0,
        skippedNoConversationForIdentity: 0,
        skippedNoEligibleThread: 0,
        cursorWrapped: false,
        failureCode: evidence.errorCode,
        correlationIdHash: evidence.correlationIdHash,
      });
    }
  }

  const result: SentImportStitchRetryResult = {
    ok: outcomes.every((outcome) => outcome.ok),
    accountCount: accountIds.length,
    deferredAccounts,
    scanned: outcomes.reduce((sum, outcome) => sum + outcome.scanned, 0),
    pending: outcomes.reduce((sum, outcome) => sum + outcome.pending, 0),
    attempted: outcomes.reduce((sum, outcome) => sum + outcome.attempted, 0),
    stitched: outcomes.reduce((sum, outcome) => sum + outcome.stitched, 0),
    outcomes,
  };
  // 회차 로그는 이 한 줄이다(코어 회차 로그와 겹치지 않게 outcome 으로 구분한다).
  // 이 버그 자체가 "조용한 누락"에서 왔다 — 매 회차 빈 결과라도 찍어 관측 가능하게 둔다.
  console.log("[external-sent-stitch]", JSON.stringify({
    outcome: "retry_scan",
    ok: result.ok,
    accountCount: result.accountCount,
    deferredAccounts: result.deferredAccounts,
    scanned: result.scanned,
    pending: result.pending,
    attempted: result.attempted,
    stitched: result.stitched,
    failedAccounts: outcomes.filter((outcome) => !outcome.ok).length,
  }));
  return result;
}
