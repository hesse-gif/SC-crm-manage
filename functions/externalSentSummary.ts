/**
 * **편입 발신(보낸편지함 가져옴)의 한국어 AI 요약 레인** (W119, 헤세 지적 2026-08-24).
 *
 * ■ 무엇이 문제였나 (프로드 화면)
 *   같은 채팅 타임라인에서 수신 메일은 한 줄 한국어 요약으로 렌더된다(chat-ai.receiveEmail →
 *   게이트웨이 `summaryKr`). 그런데 편입 발신 메시지는 **영어 원문 프리뷰 240자**가 버블에 그대로
 *   박힌다(W117 이 원장에 프리뷰를 실으면서 켜진 분기). 그래서 우리가 무슨 말을 보냈는지 알려면
 *   사람이 매번 영어 원문을 다시 읽고 해석해야 했다. 본문 원문은 이미 서버에 있다
 *   (`message_sources/external-sent-{tid}.body`, W117) — 없는 건 **요약뿐**이다.
 *
 * ■ 이 레인이 하는 일
 *   본문이 있고 아직 요약이 없는 편입 소스 문서에 대해 게이트웨이로 한국어 한 줄 요약을 만들어
 *   ① 소스 문서(`summaryKr`/`summaryBodyHash`/`summarizedAtIso`)와
 *   ② 원장 행(`mail_outbound_log.summaryKr` — 스티치가 읽는 축)에 **한 배치로** 쓴다.
 *   그 다음 형제 스티치의 `mode: "relabel"` 로 이미 물질화된 메시지 문구를 갱신한다.
 *   문구 조립은 여기서 하지 않는다 — `externalSentConversationStitch.stitchMessageText` 한 곳이다.
 *
 * ■ 규범 축 (형제 레인과 같은 자리)
 *   - SEC-P0-005: 모델 호출은 `chat-ai.runExternalSentSummaryGateway` → `vertex.callModel`
 *     단일 초크포인트뿐이다. 이 파일은 HTTP 도 모델 SDK 도 직접 만지지 않는다.
 *   - COST-P0-011: **저장된 요약이 캐시다.** `summaryKr` 이 있고 `summaryBodyHash` 가 현재
 *     `bodyHash` 와 같으면 모델을 부르지 않는다. 본문이 바뀐 행(해시 불일치)만 다시 요약한다.
 *     그 위에 게이트웨이 자체 TTL 캐시(ai_gateway_cache)가 한 겹 더 있다 — 같은 자동 안내 문안이
 *     다수인 편입분에서 실제로 히트한다.
 *   - COST-P0-006: 호출당 `reportLlmUsage`(정본 llm_usage) — 게이트웨이 함수 안에서 히트/미스
 *     양쪽 다 집계한다. **읽기** 쪽은 W123 이 `relabelAlreadySettled`(아낀 후보 수)와
 *     `relabelSettledMarked`(정산 마킹 수)를 회차 로그·감사에 같이 싣는다(건수뿐 — SEC-P0-009).
 *   - W123 읽기 증폭 제거: relabel 후보는 **한 번 정산되면 다시 잡히지 않는다**
 *     (`externalSentRelabelSettled` 주석 참조). 종전에는 백필이 끝난 뒤에도 후보 1건당
 *     원장 read 1 + 툴중복 쿼리 1 + 트랜잭션 read 2 가 매 회차 영구 반복됐다.
 *   - SEC-P0-009: 로그·감사 문서에 본문도 요약 원문도 싣지 않는다 — 건수와 커서뿐이다.
 *   - LOG-P0-010: 실제 회차당 감사 문서 1건.
 *
 * ■ 라이브 불가 환경의 계약 (mock 을 **영속시키지 않는다**)
 *   게이트웨이가 꺼져 있거나 미승인이면 회차 전체를 `skippedReason: "gateway_unavailable"` 로
 *   조용히 건너뛴다(형제 하이드레이트의 `imap_disabled` 와 같은 결). receiveEmail 은 dryRun
 *   호출자에게 목 요약을 **응답으로만** 돌려주지만, 이 레인의 산출물은 대화에 남는 **영속 문구**다.
 *   목 분류기 문장을 프로드 타임라인에 굳히는 것은 정확히 W62 `mock_sent` 사고의 양식이라,
 *   여기서는 그 강등을 하지 않는다. 행 단위 호출 실패는 회차를 무너뜨리지 않고 `failedSummaries`
 *   로 세고 다음 회차가 같은 행을 다시 집는다(멱등).
 *
 * ■ 실행 경로 2개
 *   ① 신규 편입분: `processImapIngestQueue` 의 편입 단계 **뒤, 스티치 앞**에 편승한다(index.ts).
 *      요약을 먼저 쓰면 스티치가 처음부터 요약 문구로 물질화한다 — relabel 왕복이 없다.
 *   ② 백필: `summarizeExternalSentMessages` 콜러블. dryRun 기본 · `actual:true` 필수 ·
 *      커서 페이징 · limit 클램프 — 형제 `hydrateExternalSentBodies` 와 같은 계약이다.
 *
 * ■ 운영 순서 — **campaign 원장 정합 작업과 동시 실행 금지** (W119 리뷰 M-NEW1)
 *   `reconcileCampaignLedger` 계열(admin.ts, preview → apply 2단)은 대상 `mail_outbound_log/{tid}`
 *   문서의 **전체 데이터**를 해싱해 `stateFingerprint` 를 만들고(admin.ts:10256 부근
 *   `campaignReconciliationDocumentState`), apply 단계에서 그 지문이 preview 때와 같은지 확인한다.
 *   이 레인은 같은 컬렉션의 문서에 `summaryKr` 미러를 쓴다 — preview 와 apply 사이에 끼면 지문이
 *   바뀌어 apply 가 `preview-mismatch` 로 거부된다(운영자에겐 원인 불명의 실패로 보인다).
 *   두 레인의 **대상 집합은 실제로는 겹치지 않는다**(정합 대상은 `campaign_outreach` 에 행이 있는
 *   툴 발송이고, 이 레인은 `message_sources/external-sent-{tid}` 가 있는 편입분만 만진다 —
 *   W117-R2 로 오분류가 복구된 뒤로는 교집합이 비어 있다). 그래도 **동시 실행은 하지 않는다**:
 *   교집합이 비었다는 것은 데이터 상태에 의존하는 사실이지 코드가 보장하는 불변식이 아니다.
 *   정합 작업(preview→apply)이 끝난 뒤 요약 백필을 돌린다. 코드 수정은 admin.ts 소관이라 하지 않는다.
 */
import { createHash } from "node:crypto";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { expireAt180DaysFromIso } from "./firestoreTtl";
import {
  externalSentSummaryGatewayReady,
  runExternalSentSummaryGateway,
} from "./chat-ai";
import {
  STITCH_TEXT_RULE_VERSION,
  stitchExternalSentConversationsCore,
} from "./externalSentConversationStitch";
import { safeOutboundFailureEvidence } from "./mailSafetyShared";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  type CallableRequestShape,
} from "./shared";

const OUTBOX_COLLECTION = "mail_outbound_log";
const MESSAGE_SOURCES_COLLECTION = "message_sources";
const AUDIT_COLLECTION = "external_sent_summary_audits";
const IMPORT_SOURCE = "external_sent_mail_import";
/** 형제 편입 콜러블(`importManualSentMailToOutbox`)과 **같은 등급**이다 — 이 레인은 그 편입분에만 작용한다. */
const SUMMARY_ROLES = ["super_admin", "admin", "manager"] as const;
const SUMMARY_SOURCE = "external_sent_summary";

/** 회차당 상한. 모델 왕복이라 형제 본문 백필(IMAP 왕복)과 같은 보수적 값을 쓴다. */
export const EXTERNAL_SENT_SUMMARY_MAX_ROWS = 50;
export const EXTERNAL_SENT_SUMMARY_DEFAULT_ROWS = 25;
/**
 * 스케줄 편승이 쓸 수 있는 시간 예산. 호스트(`processImapIngestQueue`)는 300초 상한 안에서
 * INBOX 수집 → 편입 → **요약** → 스티치를 차례로 돈다. 소진분은 `deferred` 로 남고 백필
 * 콜러블이 회수한다(형제 스티치 편승과 같은 계약).
 */
export const EXTERNAL_SENT_SUMMARY_PIGGYBACK_BUDGET_MS = 60_000;
/**
 * **relabel 전용 예산**(W119 리뷰 H1-a / M5-b).
 *
 * 종전에는 relabel 에 회차와 **같은** deadline 을 넘겼다. 요약 루프가 예산을 다 쓰고 나면 relabel 은
 * 남은 시간이 0 인 상태로 시작해 조용히 0건으로 끝나는데, **요약은 이미 커밋돼 있다**. 다음 회차는
 * 그 행을 `already_summarized` 로 건너뛰므로 화면 문구는 영어 원문 그대로 **영구 고착**된다.
 * 그래서 회차 예산에서 이만큼을 미리 떼어 두고, 요약 루프는 그 경계에서 멈춘다(남은 시간이
 * 이 예산보다 작으면 즉시 중단 → 나머지는 `deferred`).
 */
export const EXTERNAL_SENT_SUMMARY_RELABEL_BUDGET_MS = 30_000;

function hashHex(value: string, length = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export type ExternalSentSummarySkipReason =
  | "not_imported"
  | "id_mismatch"
  | "no_body"
  | "already_summarized";

export type ExternalSentSummaryPlan =
  | { kind: "summarize"; body: string; bodyHash: string; resummarize: boolean }
  | { kind: "skip"; reason: ExternalSentSummarySkipReason };

/**
 * 요약 캐시 키. 임포터가 실은 `bodyHash`(**절단과 무관한 원문 전체 해시**)가 정본이고, 그 필드가
 * 없는 과거 행에서만 저장 본문으로 만든다 — 없는 값을 지어내지 않기 위해 순서가 이렇다.
 */
export function externalSentBodyHash(source: Record<string, unknown>): string {
  const stored = asString(source.bodyHash, "");
  if (stored) return stored;
  const body = asString(source.body, "");
  // 임포터 정본과 **같은 형상**(sha256 앞 32자, mailExternalSentImport.hashHex(text, 32))이어야 한다.
  // 64자 full digest 를 쓰면 같은 본문인데도 저장된 해시와 영원히 어긋나 매 회차 재요약한다.
  return body ? hashHex(body, 32) : "";
}

/**
 * 요약 대상 판정 — **순수 함수**다(Firestore 접근 없음, 테스트로 봉인).
 *
 * COST-P0-011 의 실체가 여기다: 저장된 요약(`summaryKr` + `summaryBodyHash`)이 곧 캐시이고,
 * 해시가 현재 본문과 같으면 모델을 다시 부르지 않는다. 본문이 바뀐 경우(백필이 원문을 되찾아
 * `body` 를 채운 행 등)만 `resummarize` 로 다시 부른다.
 */
export function externalSentSummaryPlan(
  source: Record<string, unknown>,
  trackingId: string,
  options: { force?: boolean } = {},
): ExternalSentSummaryPlan {
  if (asString(source.source, "") !== IMPORT_SOURCE) return { kind: "skip", reason: "not_imported" };
  // 문서 id 와 본문 trackingId 가 어긋나면 어느 쪽이 진짜인지 모른다 — 형제 레인과 같은 판단(M3).
  if (!trackingId || asString(source.trackingId, "") !== trackingId) {
    return { kind: "skip", reason: "id_mismatch" };
  }
  const body = asString(source.body, "");
  // 본문이 없으면 요약할 것이 없다. 제목만으로 지어내지 않는다 — 그게 W116 라벨 사고의 양식이다.
  if (!body) return { kind: "skip", reason: "no_body" };
  const bodyHash = externalSentBodyHash(source);
  const summaryKr = asString(source.summaryKr, "");
  // M3: `force` 는 캐시를 **의도적으로** 무시한다(프롬프트 개정 후 품질 재생성 등). 기본은 꺼져 있고
  // 콜러블에서 명시해야 켜진다 — 실수로 전량 재호출하는 비용 사고를 막기 위해 opt-in 이다.
  if (!options.force && summaryKr && bodyHash && asString(source.summaryBodyHash, "") === bodyHash) {
    return { kind: "skip", reason: "already_summarized" };
  }
  return { kind: "summarize", body, bodyHash, resummarize: Boolean(summaryKr) };
}

/**
 * **relabel 정산 마커**(W123 읽기 증폭 제거). 소스 문서에만 쓴다 — 원장(`mail_outbound_log`)에
 * 쓰면 campaign 정합 도구의 `stateFingerprint` 를 흔든다(파일 헤더 "운영 순서" 절).
 */
const RELABEL_SETTLED_FIELD = "summaryRelabeledAtIso";
/** 마커를 만든 **문구 규칙의 세대값**. 규칙이 바뀌면 값이 달라져 전량이 후보로 복귀한다(H1). */
const RELABEL_RULE_VERSION_FIELD = "summaryRelabelRuleVersion";

/**
 * **툴 중복 재프로브 주기 — 24시간**(W123 적대 리뷰 H1-A).
 *
 * relabel 의 세 번째 판정 입력인 `resolveToolSentDuplicate` 는 **라이브 쿼리**다. 늦게 도착한
 * 툴 발송(같은 수신자·제목의 원 발송)은 그 프로브를 다시 돌려야만 보이고, 그때 편입 사본이 숨는다.
 * 마커로 그 축까지 덮으면 "늦게 도착한 중복이 영영 안 숨는" 상태가 된다 —
 * `relabelPlan` 주석이 말하는 "조회 상한에 걸려 못 본 것"이 바로 이 형상이다.
 *
 * 그래서 마커는 **하루짜리**다: 정산된 행도 24시간이 지나면 후보로 한 번 돌아와 프로브를 다시 돌고,
 * 마커가 갱신된다. 비용 상한이 "회차마다 1회"에서 "행마다 24시간에 1회"로 바뀌는 것이지
 * 탐지 메커니즘이 사라지는 것이 아니다(백필 sweep 을 하루에 몇 번 돌리든 상한은 같다).
 */
export const EXTERNAL_SENT_RELABEL_REPROBE_MS = 24 * 60 * 60 * 1000;

/**
 * 이 행의 화면 문구가 **현재 판정 기준으로 이미 정산됐는가** — 순수 함수다(Firestore 접근 없음).
 *
 * ■ 무엇을 고치는가 (W123 / W119 적대 리뷰 미수정 백로그)
 *   종전에는 `already_summarized && stitchedConversationId` 인 행을 **매 회차 무조건** relabel
 *   후보로 실어 보냈다. 백필이 끝난 정상 상태에서도 후보 1건당
 *   원장 doc read 1(요약 루프가 방금 읽은 같은 문서 재독) + 툴중복 쿼리 1 + 트랜잭션 read 2 가
 *   영구 반복되고, 결과는 언제나 `relabelRetried=N, relabelNoop=N, relabeledMessages=0` 이었다.
 *   즉 **관측 지표는 정상인데 비용만 영구히 나가는** 상태다.
 *
 * ■ relabel 의 판정 입력은 3개다 — 마커는 그 **셋 다**를 추적해야 한다 (적대 리뷰 H1)
 *   ① 요약(`summaryKr`) → `summarizedAtIso` 대비 마커 시각으로 추적.
 *   ② **문구 조립 규칙**(`stitchMessageText`) → 마커에 실린 `STITCH_TEXT_RULE_VERSION` 으로 추적.
 *      이게 없으면 규칙 개정 뒤 정산된 행은 영영 옛 문구다(W116-R2·W119 가 그 전례다).
 *   ③ 툴 중복 라이브 쿼리 → 마커로 덮지 않고 24시간 재프로브로 남긴다
 *      (`EXTERNAL_SENT_RELABEL_REPROBE_MS` 주석 참조).
 *   종전 주석의 "재요약하면 자동 복귀" 는 ①에만 참이었다 — ②③ 이 이 함수에 들어온 이유다.
 *
 * ■ 여기 두는 것은 **불린 플래그뿐**이다
 *   "문구가 무엇이어야 하는가"는 스티치(`stitchMessageText`) 한 곳의 규칙이고, 이 함수는 그 규칙이
 *   이 행에 이미 적용됐다는 사실만 읽는다. 문구를 여기서 다시 조립하면 규칙이 두 벌이 된다.
 */
export function externalSentRelabelSettled(
  source: Record<string, unknown>,
  options: { nowMs?: number; ruleVersion?: string } = {},
): boolean {
  const relabeledAtIso = asString(source[RELABEL_SETTLED_FIELD], "");
  if (!relabeledAtIso) return false;
  // ② 규칙축. 마커에 세대값이 없는 과거 행(W123 이전 마커)도 여기서 걸려 한 번 재정산된다.
  const ruleVersion = options.ruleVersion ?? STITCH_TEXT_RULE_VERSION;
  if (asString(source[RELABEL_RULE_VERSION_FIELD], "") !== ruleVersion) return false;
  // ① 요약축. 두 값 모두 `new Date().toISOString()`(고정폭 UTC)이라 사전순 비교가 곧 시각순이다.
  //    요약 시각이 없는 행(이 레인 밖에서 `summaryKr` 이 붙은 과거 행)은 비교축이 없다 — 마커가
  //    있다는 것은 이 레인이 그 문구를 확인했다는 뜻이므로 통과시킨다(없는 값을 지어내지 않는다).
  const summarizedAtIso = asString(source.summarizedAtIso, "");
  if (summarizedAtIso && relabeledAtIso < summarizedAtIso) return false;
  // ③ 툴중복축. 파싱 불가한 마커는 신뢰하지 않는다(정산 아님 → 후보로 돌린다).
  const relabeledAtMs = Date.parse(relabeledAtIso);
  if (!Number.isFinite(relabeledAtMs)) return false;
  const nowMs = options.nowMs ?? Date.now();
  return nowMs - relabeledAtMs < EXTERNAL_SENT_RELABEL_REPROBE_MS;
}

export function boundedSummaryLimit(value: unknown): number {
  const parsed = Math.trunc(Number(value ?? EXTERNAL_SENT_SUMMARY_DEFAULT_ROWS));
  if (!Number.isFinite(parsed) || parsed <= 0) return EXTERNAL_SENT_SUMMARY_DEFAULT_ROWS;
  return Math.min(parsed, EXTERNAL_SENT_SUMMARY_MAX_ROWS);
}

export function boundedSummaryTrackingIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    const id = asString(entry, "");
    if (id) seen.add(id);
    if (seen.size >= EXTERNAL_SENT_SUMMARY_MAX_ROWS) break;
  }
  return [...seen];
}

export type ExternalSentSummaryResult = {
  ok: boolean;
  dryRun: boolean;
  mode: "dry_run" | "actual";
  /** 게이트웨이가 꺼져 있어 아무것도 하지 않고 돌아왔을 때의 사유. */
  skippedReason?: string;
  /** 이번 회차가 검토한 편입 원장 행 수. */
  scanned: number;
  /** 요약을 새로 붙인(또는 dryRun 에서 붙일) 수. */
  summarized: number;
  /** 그중 본문이 바뀌어 **다시** 요약한 수(해시 불일치). */
  resummarized: number;
  /** 게이트웨이 TTL 캐시로 모델 호출 없이 얻은 수(COST-P0-011 관측축). */
  cacheHits: number;
  /** 본문이 없어 요약할 수 없던 수(백필 대상 — 본문 하이드레이트가 먼저다). */
  skippedNoBody: number;
  /** 이미 같은 본문의 요약이 있어 모델을 부르지 않은 수(멱등의 관측축). */
  alreadySummarized: number;
  /** 문서 id 와 본문 trackingId 가 어긋나 손대지 않은 수. */
  skippedIdMismatch: number;
  /**
   * 편입 레인 행이 아니어서 손대지 않은 수(L2).
   * `skippedIdMismatch` 와 섞으면 "지정 id 가 틀렸다"와 "이 레인 대상이 아니다"가 한 숫자가 돼
   * 운영자가 원인을 못 가른다 — 지정 회차(편승·수동)에서 특히 갈려야 한다.
   */
  skippedNotImported: number;
  /** 대응 소스 문서가 없거나 포인터가 깨져 손대지 않은 수. */
  skippedMissingSource: number;
  /** 모델 호출이 실패했거나 산출 요약이 수용 게이트를 통과하지 못한 수. 다음 회차가 다시 집는다. */
  failedSummaries: number;
  /** 이미 물질화된 대화 메시지의 문구를 갱신한 수(스티치 relabel 재사용). */
  relabeledMessages: number;
  /**
   * 이미 같은 문구라 아무것도 쓰지 않은 수. 0건 relabel 이 **정상(멱등)**인지 **고착**인지 가른다 —
   * 이 값이 크면 정상이고, 아래 두 값이 크면 고착이다(H1-b).
   */
  relabelNoop: number;
  /** relabel 이 시간 예산을 소진해 손대지 못한 수 — 요약은 이미 커밋됐으므로 회수가 필요하다. */
  relabelDeferred: number;
  /** 원장은 붙었다는데 대화 메시지 문서가 없어 고치지 못한 수(사람이 지웠거나 대화가 병합됐다). */
  relabelSkippedMissingMessage: number;
  /**
   * H1-c 재시도 **후보** 수 — 이미 요약된 행 중 물질화까지 끝나 문구가 고착됐을 수 있어 relabel 에
   * 같이 실어 보낸 건수다(**치유 건수가 아니다**). 대부분은 이미 같은 문구라 noop 으로 지나간다.
   * 고착 신호는 이 값이 아니라 **`relabeledMessages` 대 `relabelNoop` 의 비율**로 읽는다:
   * 후보가 계속 잡히는데 `relabeledMessages` 가 0 이면 정상(멱등), 반대로 매 회차 실제 갱신이
   * 생기면 앞 회차의 relabel 이 예산·문서 부재로 못 끝내고 있다는 뜻이다
   * (`relabelDeferred`·`relabelSkippedMissingMessage` 가 그 원인을 가른다).
   *
   * W123 이후 이 값은 **한 번 정산되면 0 으로 내려간다** — 정산된 행은 `relabelAlreadySettled`
   * 로 옮겨간다. 백필 완료 뒤에도 이 값이 페이지 크기만큼 계속 잡히면 마커가 안 붙는 회귀다.
   */
  relabelRetried: number;
  /**
   * W123 **읽기 절감의 관측축**(COST-P0-006). 이미 요약됐고 물질화도 끝났지만 정산 마커가 있어
   * relabel 후보에서 **뺀** 수 = 이번 회차가 아끼기로 한 후보 수다. 후보 1건이 아끼는 읽기는
   * 원장 doc 1 + 툴중복 쿼리 1 + 트랜잭션 read 2 다.
   * 백필이 끝난 정상 상태에서는 이 값이 페이지 크기에 수렴하고 `relabelRetried` 는 0 으로 간다 —
   * 반대로 `relabelRetried` 가 계속 크면 마커가 안 붙고 있다는 뜻이다(회귀 신호).
   */
  relabelAlreadySettled: number;
  /** 이번 회차에 정산 마커(`summaryRelabeledAtIso`)를 새로 쓴 수. 행당 1 write, 1회성이다. */
  relabelSettledMarked: number;
  /** 요약은 저장됐지만 문구 갱신이 실패한 수 — 회차를 되돌리지 않고 숫자로 남긴다. */
  relabelFailed: number;
  /** 시간 예산 소진으로 손대지 않은 수. 커서는 여기까지만 전진한다. */
  deferred: number;
  auditRef: string;
  cursor: string;
  nextCursor: string;
  done: boolean;
};

/**
 * 게이트웨이 주입 이음매. 프로드 배선은 기본값(`runExternalSentSummaryGateway`)이라 거동이 같고,
 * 에뮬레이터·테스트만 이 축으로 결정론적 요약기를 꽂는다
 * (chat-ai 의 `ReceiveEmailDependencies` 와 같은 관례).
 */
export type ExternalSentSummarizer = (input: {
  trackingId: string;
  subject: string;
  body: string;
}) => Promise<{ summaryKr: string; cacheHit: boolean } | null>;

export type ExternalSentSummaryCoreInput = {
  trackingIds?: readonly string[];
  cursor?: string;
  limit?: number;
  dryRun?: boolean;
  deadlineMs?: number;
  actorUid?: string;
  actorRole?: string;
  summarizer?: ExternalSentSummarizer;
  /** M3: 저장된 요약(캐시)을 무시하고 다시 요약한다. 기본 false. */
  force?: boolean;
  /**
   * L4: 물질화 메시지 문구 갱신을 이 회차에서 수행할지. 기본 true.
   * 스케줄 편승은 **바로 뒤에 스티치가 물질화**하므로 false 로 끈다 — 아직 존재하지 않는 메시지를
   * 상대로 relabel 을 돌리면 원장·메시지를 한 번씩 더 읽고 전량 `relabelSkippedNotStitched` 로 끝난다.
   */
  relabel?: boolean;
  /** 게이트웨이 가용성 판정 이음매(테스트 전용 — 프로드는 기본값). */
  gatewayReady?: () => boolean;
  /**
   * M2: 정산 마커를 **무시하고** 이미 요약된 행까지 전부 relabel 후보로 싣는다. 기본 false.
   * 마커 3축(요약·규칙 세대·24h 재프로브)이 전부 자동인데도 사람이 강제로 한 번 훑어야 하는
   * 경우(마커 쓰기가 실패해 남은 잔여분 회수 등)를 위한 opt-in 이다 — **읽기 비용이 행 수만큼
   * 든다**(정확히 W123 이 제거한 그 비용이다). 기본이 꺼져 있는 이유가 그것이다.
   */
  ignoreSettled?: boolean;
  /** 정산 판정의 현재 시각 이음매(테스트 전용 — 24h 재프로브 경계를 결정론적으로 넘기기 위함). */
  settledNowMs?: number;
};

export async function summarizeExternalSentMessagesCore(
  input: ExternalSentSummaryCoreInput = {},
): Promise<ExternalSentSummaryResult> {
  const dryRun = input.dryRun !== false;
  const cursor = asString(input.cursor, "");
  const actorUid = asString(input.actorUid, "");
  const actorRole = asString(input.actorRole, "");
  const requestedIds = boundedSummaryTrackingIds(input.trackingIds);
  // 지정 회차의 기본 상한은 **넘어온 id 수**다. 스캔 기본값(25)을 그대로 적용하면 편입 배치(≤50)의
  // 뒷부분이 어느 카운터에도 안 잡히고 조용히 사라진다 — 커서가 없는 편승에선 영영 누락이다.
  const limit = input.limit === undefined && requestedIds.length > 0
    ? Math.min(requestedIds.length, EXTERNAL_SENT_SUMMARY_MAX_ROWS)
    : boundedSummaryLimit(input.limit);
  const trackingIds = requestedIds.slice(0, limit);
  const deadlineMs = Number.isFinite(Number(input.deadlineMs))
    ? Number(input.deadlineMs)
    : Number.POSITIVE_INFINITY;
  const summarizer = input.summarizer ?? runExternalSentSummaryGateway;
  const gatewayReady = input.gatewayReady ?? externalSentSummaryGatewayReady;
  const force = input.force === true;
  const relabelEnabled = input.relabel !== false;
  const ignoreSettled = input.ignoreSettled === true;
  const settledNowMs = Number.isFinite(Number(input.settledNowMs))
    ? Number(input.settledNowMs)
    : Date.now();
  /**
   * H1-a / M5-b: 요약 루프는 **relabel 예산을 남겨 두고** 멈춘다. 이 경계를 넘어서 한 통 더
   * 요약하면 그 요약은 커밋되는데 문구 갱신은 0건이 되고, 다음 회차는 `already_summarized` 로
   * 건너뛰어 화면이 영구 고착된다. 예산이 무한(콜러블 밖 테스트)이면 경계도 무한이다.
   */
  const summarizeDeadlineMs = Number.isFinite(deadlineMs) && relabelEnabled
    ? deadlineMs - EXTERNAL_SENT_SUMMARY_RELABEL_BUDGET_MS
    : deadlineMs;

  const counts = {
    scanned: 0, summarized: 0, resummarized: 0, cacheHits: 0, skippedNoBody: 0,
    alreadySummarized: 0, skippedIdMismatch: 0, skippedNotImported: 0,
    skippedMissingSource: 0, failedSummaries: 0, relabeledMessages: 0,
    relabelNoop: 0, relabelDeferred: 0, relabelSkippedMissingMessage: 0,
    relabelRetried: 0, relabelAlreadySettled: 0, relabelSettledMarked: 0,
    relabelFailed: 0, deferred: 0,
  };
  const empty: ExternalSentSummaryResult = {
    ok: true, dryRun, mode: dryRun ? "dry_run" : "actual", ...counts,
    auditRef: "", cursor, nextCursor: cursor, done: false,
  };

  // 게이트웨이가 없으면 요약도 없다. 행마다 실패로 세지 않고 회차째로 조용히 건너뛴다.
  // (dryRun 은 모델을 부르지 않으므로 계획만 세우는 것은 여기서도 허용한다.)
  if (!dryRun && !gatewayReady()) {
    return { ...empty, skippedReason: "gateway_unavailable", done: true };
  }

  // 스캔 회차는 형제 복구 레인(repairExternalSentSourceMisclassificationCore)과 **같은 모양**이다
  // (등가 필터 + 문서 id 정렬) — 프로드에서 이미 도는 형태라 색인 요구가 새로 생기지 않는다.
  // 지정 회차(편승)는 방금 편입한 행만 직접 집는다 — 읽기량이 배치 크기로 묶인다.
  let docs;
  if (trackingIds.length > 0) {
    const snapshots = await adminDb.getAll(
      ...trackingIds.map((id) => adminDb.collection(OUTBOX_COLLECTION).doc(id)),
    );
    docs = snapshots.filter((snapshot) => snapshot.exists);
  } else {
    let query = adminDb
      .collection(OUTBOX_COLLECTION)
      .where("source", "==", IMPORT_SOURCE)
      .orderBy(FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor);
    docs = (await query.limit(limit).get()).docs;
  }

  const summarizedTrackingIds: string[] = [];
  /**
   * H1-c: 이미 요약됐지만 **화면 문구가 아직 요약이 아닐 수 있는** 행. 모델은 부르지 않고
   * relabel 만 재시도한다 — 지난 회차가 요약을 커밋한 뒤 relabel 이 예산/메시지 부재로 0건이
   * 됐다면, 이 축이 없으면 그 행은 영원히 `already_summarized` 로 건너뛰어 고착된다.
   * 문구가 이미 같으면 relabel 이 `relabelNoop` 으로 지나가므로 쓰기는 발생하지 않는다
   * (판정은 스티치 한 곳에만 둔다 — 여기서 문구를 다시 조립하면 규칙이 두 벌이 된다).
   */
  const relabelRetryTrackingIds: string[] = [];
  /**
   * W123: 정산 마커를 쓸 대상의 소스 문서 ref. 루프가 **이미 읽은** ref 를 그대로 들고 있다가
   * relabel 이 끝난 뒤 재사용한다 — 경로를 다시 조립하거나 문서를 다시 읽지 않는다.
   */
  const settleRefs = new Map<string, FirebaseFirestore.DocumentReference>();
  const summarizedAtIso = new Date().toISOString();
  let lastProcessedId = "";

  for (const doc of docs) {
    // M5-b: relabel 예산 경계 앞에서 멈춘다(H1-a 주석 참조).
    if (Date.now() > summarizeDeadlineMs) {
      counts.deferred += 1;
      continue;
    }
    counts.scanned += 1;
    const data = asRecord(doc.data());
    const trackingId = asString(data.trackingId, "");
    if (!trackingId || trackingId !== doc.id) {
      counts.skippedIdMismatch += 1;
      lastProcessedId = doc.id;
      continue;
    }
    const sourceRefPath = asString(data.sourceRef, "");
    if (!sourceRefPath.startsWith(`${MESSAGE_SOURCES_COLLECTION}/`)) {
      counts.skippedMissingSource += 1;
      lastProcessedId = doc.id;
      continue;
    }
    const sourceRef = adminDb.doc(sourceRefPath);
    const sourceSnapshot = await sourceRef.get();
    if (!sourceSnapshot.exists) {
      counts.skippedMissingSource += 1;
      lastProcessedId = doc.id;
      continue;
    }
    const source = asRecord(sourceSnapshot.data());
    const plan = externalSentSummaryPlan(source, trackingId, { force });
    if (plan.kind === "skip") {
      if (plan.reason === "no_body") counts.skippedNoBody += 1;
      else if (plan.reason === "not_imported") counts.skippedNotImported += 1;
      else if (plan.reason === "already_summarized") {
        counts.alreadySummarized += 1;
        // 물질화된 행만 재시도 후보다 — 아직 대화에 붙지 않았으면 고칠 문구 자체가 없다.
        if (!dryRun && relabelEnabled && asString(data.stitchedConversationId, "")) {
          // W123: 지난 회차가 "문구가 맞다"고 확인해 둔 행은 후보에서 뺀다. 이 분기가 없으면
          //   백필이 끝난 뒤에도 후보 1건당 읽기 3 + 쿼리 1 이 매 회차 영구 반복된다.
          if (!ignoreSettled && externalSentRelabelSettled(source, { nowMs: settledNowMs })) {
            counts.relabelAlreadySettled += 1;
          }
          else {
            relabelRetryTrackingIds.push(trackingId);
            settleRefs.set(trackingId, sourceRef);
          }
        }
      } else counts.skippedIdMismatch += 1;
      lastProcessedId = doc.id;
      continue;
    }

    if (dryRun) {
      // dry-run 은 **모델을 부르지 않는다** — 계획 회차가 비용을 쓰면 dryRun 의 의미가 사라진다.
      counts.summarized += 1;
      if (plan.resummarize) counts.resummarized += 1;
      lastProcessedId = doc.id;
      continue;
    }

    let summary: { summaryKr: string; cacheHit: boolean } | null = null;
    try {
      summary = await summarizer({
        trackingId,
        subject: asString(source.subject, ""),
        body: plan.body,
      });
    } catch (error) {
      // 한 통의 실패가 회차를 무너뜨리지 않는다. 본문·요약 원문은 로그에 싣지 않는다(SEC-P0-009).
      console.error("[external-sent-summary]", JSON.stringify({
        outcome: "summary_failed",
        errorCode: safeOutboundFailureEvidence(error, "external-sent-summary:gateway").errorCode,
      }));
    }
    if (!summary?.summaryKr) {
      counts.failedSummaries += 1;
      lastProcessedId = doc.id;
      continue;
    }

    // 소스 문서와 원장 미러는 **한 배치로 원자적으로** 쓴다. 순차 쓰기였다면 그 사이에서 끊길 때
    // 소스에는 요약이 있는데 원장엔 없는 부분 상태가 남고, 다음 회차가 그걸 완료로 오독한다
    // (`already_summarized` 로 스킵) — 그러면 화면 문구는 영영 원문 그대로다.
    const batch = adminDb.batch();
    batch.set(sourceRef, {
      summaryKr: summary.summaryKr,
      summaryBodyHash: plan.bodyHash,
      summarizedAtIso,
      summarySource: SUMMARY_SOURCE,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    // 스티치는 원장만 훑는다(읽기량을 배치 크기로 묶는 그 레인의 계약). 요약을 화면 문구로 쓰려면
    // 같은 이름으로 원장에도 미러해야 한다 — W117 의 `bodyPreview` 미러와 같은 자리·같은 이유다.
    batch.set(doc.ref, { summaryKr: summary.summaryKr }, { merge: true });
    await batch.commit();

    counts.summarized += 1;
    if (plan.resummarize) counts.resummarized += 1;
    if (summary.cacheHit) counts.cacheHits += 1;
    summarizedTrackingIds.push(trackingId);
    // W123: 방금 요약한 행도 정산 대상이다. 마커를 안 남기면 다음 회차부터 그대로 후보로 돌아온다.
    settleRefs.set(trackingId, sourceRef);
    lastProcessedId = doc.id;
  }

  // 이미 물질화된 메시지의 문구는 **스티치의 relabel 을 그대로 재사용**해 갱신한다. 여기서 메시지
  // 문서를 직접 쓰면 같은 문서에 두 번째 쓰기 경로가 생긴다 — 그게 곧 우회로다(형제 하이드레이트
  // 와 같은 판단). 재시도 축(H1-c)도 같은 호출에 실어 보낸다 — 문구가 이미 같으면 noop 이다.
  const relabelTargets = [...new Set([...summarizedTrackingIds, ...relabelRetryTrackingIds])];
  if (relabelEnabled && relabelTargets.length > 0) {
    counts.relabelRetried = relabelRetryTrackingIds.length;
    try {
      const relabel = await stitchExternalSentConversationsCore({
        mode: "relabel",
        trackingIds: relabelTargets,
        // H1-a: 회차 deadline 을 그대로 넘기면 요약이 예산을 다 쓴 뒤 relabel 이 0건으로 끝난다.
        //   여기서만 쓰는 **별도 예산**을 준다 — 요약 루프는 위에서 이미 이만큼을 남겨 두고 멈췄다.
        stitchDeadlineMs: Date.now() + EXTERNAL_SENT_SUMMARY_RELABEL_BUDGET_MS,
        actorUid: actorUid || undefined,
        actorRole: actorRole || undefined,
      });
      counts.relabeledMessages = relabel.relabeled;
      // H1-b: 0건 relabel 이 "이미 같아서"인지 "예산/문서 부재로 못 해서"인지 결과가 말해야 한다.
      //   뒤 두 값이 0 이 아니면 요약은 커밋됐는데 화면은 아직 영어라는 뜻이다(회수 필요).
      counts.relabelNoop = relabel.relabelNoop;
      counts.relabelDeferred = relabel.deferred;
      counts.relabelSkippedMissingMessage = relabel.relabelSkippedMissingMessage;
      // W123: 문구가 맞다고 **확인된** 행에만 정산 마커를 쓴다. 예산 소진(deferred)·메시지 부재로
      //   끝난 행은 목록에 없으므로 다음 회차가 그대로 다시 집는다(회수 축이 살아 있다).
      //   마커는 소스 문서에만 쓴다 — 원장에 쓰면 campaign 정합의 지문을 흔든다(헤더 "운영 순서").
      //   마킹 실패는 relabel 실패가 아니다(문구는 이미 맞다) — 별도 try 로 가른다. 실패하면
      //   마커가 없으니 다음 회차가 같은 행을 다시 집는다(종전 거동으로 안전하게 되돌아간다).
      const settledAtIso = new Date().toISOString();
      const settleBatch = adminDb.batch();
      let settled = 0;
      for (const trackingId of relabel.relabelSettledTrackingIds) {
        const ref = settleRefs.get(trackingId);
        if (!ref) continue;
        settleBatch.set(ref, {
          [RELABEL_SETTLED_FIELD]: settledAtIso,
          // H1-②: 어느 규칙 세대로 확인한 문구인지 같이 남긴다 — 규칙이 바뀌면 이 값이 어긋나
          //   전량이 자동으로 후보로 복귀한다(마커만 남기면 규칙 개정 회수 경로가 사라진다).
          [RELABEL_RULE_VERSION_FIELD]: STITCH_TEXT_RULE_VERSION,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        settled += 1;
      }
      if (settled > 0) {
        try {
          await settleBatch.commit();
          counts.relabelSettledMarked = settled;
        } catch (error) {
          console.error("[external-sent-summary]", JSON.stringify({
            outcome: "relabel_settle_failed",
            count: settled,
            errorCode: safeOutboundFailureEvidence(error, "external-sent-summary:settle").errorCode,
          }));
        }
      }
    } catch (error) {
      // 요약은 이미 저장됐다(내구적). 여기서 던지면 그 회차는 실패로 보이지만 다음 회차는
      // `alreadySummarized` 로 지나간다 — 그래서 격리하고 숫자로 남긴다(재시도 축이 회수한다).
      counts.relabelFailed = relabelTargets.length;
      console.error("[external-sent-summary]", JSON.stringify({
        outcome: "relabel_failed",
        count: relabelTargets.length,
        errorCode: safeOutboundFailureEvidence(error, "external-sent-summary:relabel").errorCode,
      }));
    }
  }

  // L1: **예산이 끊긴 회차는 완료가 아니다.** 종전에는 지정 회차(trackingIds)를 무조건 소진으로
  //   보아 전량 deferred 인데도 `done: true` 를 돌려줬다 — 호출자가 "다 됐다"로 읽고 회수하지 않는다.
  //   커서 전진과 완료 판정을 분리한다: 지정 회차는 커서 레인이 아니라 nextCursor 가 없지만,
  //   deferred 가 남아 있으면 done 은 false 다(같은 id 로 다시 불러야 한다).
  const exhausted = counts.deferred === 0 && (trackingIds.length > 0 || docs.length < limit);
  const nextCursor = exhausted || trackingIds.length > 0 ? "" : (lastProcessedId || cursor);

  let auditRef = "";
  if (!dryRun && counts.scanned > 0) {
    const auditDoc = adminDb.collection(AUDIT_COLLECTION).doc();
    // LOG-P0-010: 회차당 감사 문서 1건. 평문(본문·제목·수신자·요약)은 남기지 않는다 — 숫자와 커서뿐이다.
    await auditDoc.set({
      id: auditDoc.id,
      schemaVersion: "external-sent-summary-audit-v1",
      actorUidHash: hashHex(actorUid, 32),
      actorRole,
      runAtIso: summarizedAtIso,
      expireAt: expireAt180DaysFromIso(summarizedAtIso),
      cursorStart: cursor,
      cursorEnd: nextCursor,
      targeted: trackingIds.length > 0,
      ...counts,
      createdAt: FieldValue.serverTimestamp(),
    });
    auditRef = auditDoc.path;
  }

  const result: ExternalSentSummaryResult = {
    ok: true,
    dryRun,
    mode: dryRun ? "dry_run" : "actual",
    ...counts,
    auditRef,
    cursor,
    nextCursor,
    done: exhausted,
  };
  // 회차당 로그 한 줄. 본문·요약 원문은 절대 싣지 않는다(closed log contract).
  console.log("[external-sent-summary]", JSON.stringify({
    outcome: "run",
    dryRun,
    actorRole,
    ...counts,
    targeted: trackingIds.length > 0,
    auditWritten: Boolean(auditRef),
    cursorAdvanced: Boolean(nextCursor),
  }));
  return result;
}

/**
 * 백필 콜러블. `dryRun` 이 기본이고 `{ dryRun: false, actual: true }` 에서만 쓴다.
 * 역할 게이트는 형제 편입 콜러블(`importManualSentMailToOutbox`·`hydrateExternalSentBodies`)과
 * 같은 등급이다 — 이 레인은 그 편입분에만 작용하므로 더 넓지도 좁지도 않아야 한다.
 *
 * `{ force: true }`(= `mode: "resummarize"`) 는 저장된 요약(캐시)을 무시하고 다시 요약한다.
 * 프롬프트/수용 게이트 개정 뒤 품질 재생성용이며 **비용이 행 수만큼 든다** — 기본은 꺼져 있고
 * dryRun 계약은 동일하다(계획 회차는 모델을 부르지 않는다).
 *
 * ■ **문구 회수는 이 콜러블의 일이 아니다** (W123 M2 — 운영자가 헷갈리는 지점)
 *   이 레인의 relabel 은 **요약을 새로 붙인 행의 뒷정리**일 뿐이다. 두 경로 모두 전량 스윕이 아니다:
 *     - 스케줄 편승(`index.ts` `processImapIngestQueue`)은 `relabel: false` 다 — 바로 뒤 스티치가
 *       처음부터 요약 문구로 물질화하므로 relabel 레인 자체를 돌지 않는다.
 *     - 이 백필 콜러블은 정산 마커가 붙은 행을 후보에서 뺀다(W123 읽기 증폭 제거).
 *   그러므로 **이미 물질화된 대화 문구를 전량 다시 쓰는 정본 경로는 형제 콜러블**이다:
 *     `stitchExternalSentConversations({ mode: "relabel", dryRun: false, actual: true, cursor })`
 *   — 커서로 편입 원장을 끝까지 훑는다. 라벨 규칙(`stitchMessageText`) 개정 뒤 회수, 늦게 도착한
 *   툴 중복 일괄 숨김이 그 경로다.
 *   여기서 `{ ignoreSettled: true }` 는 그 대체재가 아니라 **마커 쓰기가 실패해 남은 잔여분**을
 *   요약 레인 안에서 한 번 훑는 좁은 도구다(마커 3축은 규칙 개정·재요약·24h 재프로브를 이미
 *   자동으로 덮는다 — `externalSentRelabelSettled` 주석).
 *
 * ⚠️ 운영 순서: **campaign 원장 정합(preview→apply)과 동시에 돌리지 않는다.** 이 레인의
 *   `mail_outbound_log.summaryKr` 쓰기가 그 도구의 `stateFingerprint` 를 churn 시켜 apply 가
 *   `preview-mismatch` 로 거부될 수 있다(근거·범위는 파일 헤더 "운영 순서" 절 참조).
 */
export async function summarizeExternalSentMessages(
  request: CallableRequestShape,
): Promise<ExternalSentSummaryResult> {
  const auth = assertNonGuestAuth(request, "mail_external_sent_summary.run", SUMMARY_ROLES);
  const data = asRecord(request.data);
  const dryRun = data.dryRun !== false;
  const actual = data.actual === true || data.execute === true;
  if (!dryRun && !actual) {
    throw Object.assign(
      new Error("invalid-argument: actual:true is required when dryRun is false."),
      { code: "invalid-argument", errorCode: "summarize_external_sent_messages_actual_required" },
    );
  }
  // 리뷰 L1(형제 스티치와 같은 계약): `trackingIds` 를 주면 그 행만 본다 — 조용히 무시하지 않는다.
  const trackingIds = boundedSummaryTrackingIds(data.trackingIds);
  // M3: 두 표기를 모두 받는다 — 형제 백필이 `mode` 로 분기하는 관례와 `actual`/`execute` 별칭 전례.
  const force = data.force === true || asString(data.mode, "") === "resummarize";
  // W123 M2: 정산 마커 무시 opt-in. 기본은 꺼져 있다(읽기 비용이 행 수만큼 든다 — 위 주석 참조).
  const ignoreSettled = data.ignoreSettled === true;
  return summarizeExternalSentMessagesCore({
    cursor: asString(data.cursor, ""),
    ...(data.limit === undefined ? {} : { limit: Number(data.limit) }),
    dryRun,
    force,
    // 함수 예산(300s) 안에서 감사 문서 쓰기까지 끝나도록 여유를 남긴다 — 형제 백필과 같은 규칙.
    deadlineMs: Date.now() + 240_000,
    actorUid: auth.userId,
    actorRole: auth.role,
    ...(ignoreSettled ? { ignoreSettled } : {}),
    ...(trackingIds.length > 0 ? { trackingIds } : {}),
  });
}
