// W72 A — 독려 3코호트 자동 적재 스윕
//
// ■ 새 스케줄 함수를 만들지 않는다 (브리프 §4 · invariant 38 유지)
//   이 모듈은 **함수가 아니라 단계**다. 기존 `scpOutreachFollowupSweep`(60분)이 자기 일을 마친 뒤
//   이 스윕을 이어서 돌린다. 새 `onSchedule` 을 추가하면 schedules invariant 가 38→39 가 되어
//   릴리스 게이트가 정지한다(인계서 §7-2).
//
// ■ 대상 선정은 W68-B 데이터 정본만 쓴다 (재계산 금지)
//     발송  = scp_coldmail_history  where source == "campaign_outreach"
//     오픈  = mail_outbound_log[trackingId].openCount / lastOpenedAtIso
//     회신  = message_sources  where direction=="inbound" (conversationId 로 대조)
//     apply = scp_application_management.identity.channelId + program_applications.channelId
//             (둘 다 submittedAtIso 가 있는 행만)
//     영상  = scp_video_review_state.currentRevisionSubmittedAtIso
//
// ■ 상관키를 프로드 실측으로 골랐다 (합동리뷰 P1-4)
//   처음에는 email 로 맞추려 했는데 세 축이 전부 어긋나 있었다:
//     · scp_application_management 에 email 필드가 **없다**(identity 는 channelId/outreachId 계열).
//       → identity.email 비교는 항상 빈 문자열이라 지원자가 하나도 제외되지 않았다.
//     · message_sources.from 은 마스킹(he***@)과 원문이 **혼재**한다. raw email 비교는 회신자를 놓친다.
//     · scp_coldmail_history.openCount 는 프로드 600행 표본에서 **전부 0** 이다. 픽셀은
//       mail_outbound_log 만 올린다 → 열람자가 전부 "안 읽음"(코호트3)으로 분류됐다.
//   그래서 **양쪽에 실재하는 정확한 키**로 바꿨다: trackingId · conversationId · channelId.
//   위 다섯 축 밖의 값으로 코호트를 만들지 않는다. 화면·리포트가 쓰는 수와 갈리면 안 된다.
//
// ■ 폭주 방지가 두 축이다
//   레인 캡(250/일)은 **배출** 상한이고, 여기 `maxEnqueuePerRun` 은 **적재** 상한이다.
//   레인 캡만 있으면 한 번의 스윕이 큐에 수천 건을 쌓고 그게 며칠에 걸쳐 나간다 — 그 사이
//   대상이 자격을 잃어도(영상 제출 등) 이미 적재된 행은 남는다. 적재 자체를 묶어야 한다.
//
// ■ 코호트1·3 은 큐잉까지만 한다
//   이 모듈에는 SMTP·라이브 발송 경로가 **없다**. 코호트1·3 은 초안 큐에만 쌓이고, 실제 발송은
//   사람이 승인하는 기존 스택이 한다(draft_only · human gate · suppression).

import { createHash } from "node:crypto";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
// W72 R3-3: creatorId 생성 규칙의 정본. 복사하지 않고 같은 함수를 쓴다.
import { safeDocId } from "./sheetIntakeService";
import {
  NUDGE_COHORT1_KEY,
  NUDGE_COHORT2_KEY,
  NUDGE_COHORT3_KEY,
  NUDGE_COHORT4_KEY,
  NUDGE_TEMPLATE_UNMAPPED_REASON,
  NUDGE_DEFAULT_CADENCE_DAYS,
  nudgeCohortCeilings,
  nudgeProgramOverrideIdFor,
  nudgeTemplateKeyForSequence,
  readNudgeSequenceConfig,
  // W114-F: 코호트1·3 드레인의 레인캡 사전확인(clean-skip)에 쓴다 — 코호트2 드레인
  //   (scpOutboxMailWorkers.ts)이 이미 같은 함수로 같은 일을 한다.
  readNudgeLaneQuotaConfig,
  // [헤세 2026-09-03] 세 코호트 합산 배출 상한.
  readNudgeTotalDailyCap,
  type NudgeCohortKey,
  type NudgeSequenceConfig,
} from "./nudgeSequenceTemplates";
import {
  CONFIRM_OUTBOX_COLLECTION,
  enqueueVideoReminderForApplication,
  VIDEO_REMINDER_HISTORY_COLLECTION,
  videoReminderGateRemainingMs,
} from "./applicationVideoPending";
// 합동리뷰 P1-6: 큐 문서만 만들면 검수 가능한 산출물이 없다. 기존 경로처럼 draft 를 실제로 만든다.
import { createNudgeDraftForSweep, sendNudgeLiveForSweep } from "./scpOutreach";
// Flu/Task-44: 후보(candidate_pool)별 독려 주기 오버라이드 — 순수 가산 조회, 없으면 기존 동작
//   바이트 동일(회귀 0). candidateTable.ts가 이 파일의 nudgeEmailDigest와 같은 규칙(export해서
//   그대로 재사용)으로 쓴 문서를 여기서 읽기만 한다.
import {
  readCandidateNudgeCadenceOverrides,
  resolveEffectiveCadenceMs,
  type CandidateNudgeCadenceOverrideDb,
} from "./candidateNudgeCadenceOverride";
// W72-C2: infly 예외 효과를 화면에서 규칙별로 갈라 보여주기 위해 정본 조회기를 그대로 쓴다.
import { findMailSuppression, INFLY_OVERLAP_RULE_ID } from "./mailSuppression";
// W114-F: 코호트2 드레인(scpOutboxMailWorkers.ts)이 쓰는 것과 **같은** 읽기 전용 사전확인이다.
//   여기서도 최종 강제는 sendNudgeLiveForSweep 내부의 reserveOutboundQuota 트랜잭션이 한다 —
//   이 peek 은 비싼 발송 왕복(prepareScpResultMail preview+apply)을 캡이 이미 찼을 때 건너뛰는
//   최적화일 뿐, 캡을 우회하는 별도 경로가 아니다.
// W118: 레인 수동 정지 사전확인도 같은 성격의 읽기 전용 peek 이다(강제는 발송 경로가 한다).
import { laneDailyQuotaAllows, totalDailyQuotaAllows, readMailLaneManualPause } from "./mailOutboundSafety";
// 리뷰어 B HIGH 수리: 코호트2 드레인이 이미 갖고 있는 stale "sending" 리클레임 TTL 을 그대로
//   재사용한다(같은 상수, 새 값 발명 금지) — 필드명(status vs deliveryState)만 이 컬렉션의
//   계약에 맞게 다르므로 함수 자체는 별도로 두되(아래 reclaimStaleSendingNudgeOutboxRows), TTL
//   값은 공유한다.
import { STALE_SENDING_RECLAIM_TTL_MS } from "./scpOutboxMailWorkers";

const COLDMAIL_HISTORY_COLLECTION = "scp_coldmail_history";
const MESSAGE_SOURCES_COLLECTION = "message_sources";
const APPLICATION_COLLECTION = "scp_application_management";
const PROGRAM_APPLICATIONS_COLLECTION = "program_applications";
const MAIL_OUTBOUND_LOG_COLLECTION = "mail_outbound_log";
/**
 * W114 수리③ [실측 2026-08-20]: `scp_coldmail_history` 고유 6,873명 중 `source` 값은
 * `campaign_outreach`(5,445) 와 `backfill:campaign_outreach`(1,428) 두 가지가 있다. 후자는
 * `scripts/backfill-coldmail-history.mjs:3` 문서대로 **실발송을 소급 기록한 행**이다(표본 400
 * 전수에 sentAtIso·trackingId·conversationId·mailOutboxRef·bodySha256·approvalRef 존재, 정규
 * 행과 동일 구조) — "발송 미검증"이 아니라 "발송 기록 시점이 다르다"는 뜻의 멱등성 마커다.
 * exact-match(`==`) 필터가 이 1,428명을 통째로 독려 스캔에서 빠뜨리고 있었다. `in` 으로 두
 * 값을 모두 받는다.
 */
export const NUDGE_COLDMAIL_SOURCES: readonly string[] = ["campaign_outreach", "backfill:campaign_outreach"];
/**
 * 합동리뷰 P1-5: 최신 N건 고정 조회는 앞 N명이 전부 쿨다운/in-flight 이면 **N+1번째가 영구 기아**다.
 * 커서를 남겨 다음 실행이 이어서 훑는다. 기존 `scp_video_submission_reminder_runtime` 과 같은
 * 형상(런타임 커서 문서 1개)이라 새 컬렉션을 만들지 않는다.
 */
const SWEEP_RUNTIME_COLLECTION = "scp_video_submission_reminder_runtime";
const SWEEP_CURSOR_DOC_ID = "cursor:w72-nudge-cohort-sweep";
const VIDEO_STATE_COLLECTION = "scp_video_review_state";
/** 코호트1·3 초안 큐. 기존 콜드메일 레인의 큐를 그대로 쓴다(새 컬렉션 금지). */
const OUTREACH_QUEUE_COLLECTION = "scp_outreach_queue";
/**
 * W72 스펙 [헤세 2026-08-13] — 코호트1·3 **발송 이력 원장**.
 *
 * 종전에 1회차만 보낸 이유는 "몇 번째를 받았는가"의 정본이 없어서였다. B2 실발송 전환으로
 * 이 레인도 이력을 남기게 되므로, 큐 원장(`scp_outreach_queue`)의 `source:"w72_nudge_sweep"` 행을
 * 회차 정본으로 삼는다(새 컬렉션 금지 — 기존 큐를 그대로 쓴다).
 *
 * ■ 회차 = **delivered 기준**(코호트2 와 같은 원칙)
 *   "시도 N번"이 아니라 "받은 N통"이다. 발송 실패/차단 행은 회차를 소모하지 않는다.
 *
 * ■ 코호트 전이 규칙 [리더 권고 채택]
 *   ③ 수신자가 도중에 읽으면 ①의 신규 대상이 된다. 이때:
 *     · **회차는 코호트별 독립 카운트** — ③의 문안과 ①의 문안은 설득 논리가 다르다.
 *       합산하면 ①의 1회차(가장 중요한 첫 설득)를 건너뛴다.
 *     · **쿨다운은 코호트 무관 마지막 수신 기준** — 합산해야 전이 직후 연속 폭격이 막힌다.
 */
// W72 마감리뷰 P1-5: `drafted`/`draft_only` 를 뺀다. draft 는 **메일이 나가지 않은 상태**다 —
//   포함하면 발송 없이 회차(3/5)를 소모한다(P0-1 강등과 겹쳐 실제로 그렇게 돌고 있었다).
//   회차는 "받은 통수"여야 한다는 코호트2 원칙과도 이제 일치한다.
const NUDGE_SENT_STATUSES: ReadonlySet<string> = new Set(["sent", "delivered"]);
/**
 * W72E-R1 P1-3: draft 는 **회차를 소모하지 않는다**(메일이 나가지 않았으므로).
 * 그런데 회차만 보고 판정하면 draft 경로가 매 스윕 같은 사람에게 draft 를 다시 만든다 —
 * 되돌림 스위치를 켜는 순간 재생성 루프가 된다. 그래서 draft 존재는 **별도로** 센다:
 * 회차(delivered)에는 안 들어가고, 재생성만 막는다.
 *
 * W114-F [적재/발송 분리]: "queued"(코호트1·3 라이브 경로의 아웃박스 대기 상태)를 이 집합에
 *   합류시킨다 — draft 와 **같은 성질**이다: 메일이 아직 안 나갔고(회차 미소모), 그런데
 *   재적재를 막아야 한다(안 막으면 드레인이 아직 처리 못 한 행을 스윕이 매시간 덮어써 큐가
 *   busy-loop 된다). "draft_pending" 이라는 차단 사유 이름은 재사용한다 — 두 상태 모두
 *   "이 회차는 이미 대기 중이니 새로 만들지 마라"라는 같은 뜻이라 이름을 새로 만들지 않는다.
 *
 * W114-F [리뷰어 B 재검증 HIGH, 엔드투엔드 재현됨 — 스윕/드레인 경합]: "sending"(드레인이 클레임해
 *   발송 중인 상태)도 이 집합에 있어야 한다. 코호트2 는 이 축을 IN_FLIGHT_REMINDER_STATES
 *   (applicationVideoPending.ts:69-74, "queued"·"sending"·"retryable_failed"·"recipient_pending")
 *   로 갖고 있는데, 코호트2 패턴을 미러링할 때 이 부분을 안 옮겼다 — 클레임/리클레임 메커니즘만
 *   가져오고 "드레인이 지금 이 행을 들고 있다"를 스윕에 알리는 축을 빠뜨렸다. 그 결과: 드레인이
 *   행을 "sending" 으로 클레임하고 발송 중(preview→apply, 16~21s)인 **바로 그 순간** 시간당
 *   스윕이 돌면, readNudgeHistory 가 "sending" 행을 안 세어(drafted 도 sent 도 아님) 회차·대기
 *   둘 다 0으로 보이고 → evaluateNudgeCandidate 가 이 사람을 다시 eligible 로 판정 →
 *   queueNudgeForCohort 의 merge 쓰기(:663-683 부근)가 "queued" 로 **덮어써서** 드레인의 클레임을
 *   지운다 → 드레인이 apply 를 끝내고 최종 status 를 쓰기 전에(또는 쓴 뒤에도 다음 틱이 이미
 *   "queued" 를 봐서) 같은 사람에게 두 번째 실발송이 나간다(리뷰어가 실제 함수로 엔드투엔드 재현:
 *   30초 된 "sending" 행 + 스윕의 merge 쓰기 적용 + 실제 drainNudgeCohort13Outbox 호출 →
 *   scanned=1, delivered=1 — 중복 라이브 발송).
 *
 *   ⚠️ 부작용: 이 집합은 evaluateNudgeCandidate 의 "draft_pending" 판정(§ draftedForCohort)에도
 *   쓰인다 — "sending" 을 넣으면 드레인이 들고 있는 in-flight 행도 검수 화면·재적재 판정에서
 *   "초안(대기) 있음"으로 잡힌다. 이건 **의도한 결과**다: 코호트2 도 같은 축(IN_FLIGHT_REMINDER_
 *   STATES)을 발송 시도 중인 행을 "아직 안 끝났으니 새로 만들지 마라"는 뜻으로 정확히 그렇게
 *   쓴다 — "sending" 이 회차를 소모하지 않으면서도(발송 완료 아님) 재적재는 막는다는 성질은
 *   "queued"/"draft_only"와 조금도 다르지 않다.
 */
const NUDGE_DRAFTED_STATUSES: ReadonlySet<string> = new Set(["drafted", "draft_only", "queued", "sending"]);
/**
 * W72F-R1 P1-3: draft 가 **종결**되면 더 이상 대기가 아니다.
 * 큐 status 만 보고 draft_pending 으로 막으면, 검수자가 그 draft 를 취소·거절했거나
 * 발송으로 전진시킨 뒤에도 그 회차가 **영구히 차단**된다(정당한 재시도·다음 회차가 막힌다).
 * 그래서 draft 대기는 "draft 이면서 아직 종결되지 않은" 행만 센다.
 */
const NUDGE_DRAFT_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "sent", "delivered", "cancelled", "rejected", "archived", "expired", "superseded",
]);

/** 스윕 1회가 적재할 수 있는 최대 건수(전 코호트 합계). 레인 캡과 **별개의** 폭주 방지 축이다. */
export const NUDGE_SWEEP_MAX_ENQUEUE_PER_RUN = 50;
/** 한 번에 훑는 발송 원장 행 수. 스윕이 60분마다 도므로 창을 나눠 훑어도 따라잡는다. */
export const NUDGE_SWEEP_SCAN_LIMIT = 400;

/**
 * W113 [헤세 배정 · 실측]: 스윕 1회의 **시간 예산**.
 *
 * 왜 필요한가: 호스트(scpOutreachFollowupSweep)는 timeoutSeconds 300 인데, 이 스윕은
 * 페이지(400행)를 끝까지 처리한 **뒤에야** 커서를 저장했다(all-or-nothing). 실측상 런 총소요가
 * 675~978s 라 매번 300s 에서 SIGKILL 됐고 → 커서 저장 지점에 영영 도달하지 못해
 * 2026-08-13T01:13 에 **동결**됐다. 매시간 같은 400행(8/6 이전 옛 수신자)만 재스캔 →
 * 전부 dup/max 로 소진 → 발송 0. Cloud Run 요청 로그 24h 18/18 이 504 · 299.97s 였다.
 *
 * 값의 근거: 마지막 발송이 예산 끝에서 시작해도 함수 천장을 넘지 않아야 한다.
 * W114 정정: 아래 발송 간격 수치는 원래 "빠른 체제/느린 체제"(서로 다른 발송 경로)로
 * 적었으나 오독이다. 실측 결과 그 둘은 **300초 타임아웃 전/후**다 — 같은 발송 코드가
 * 504(타임아웃) 이후 CPU 스로틀에 걸려 10~15배 느려진다(8/8 실행 실측: 경계 전 p50
 * 2.2~2.3s / 경계 후 p50 19~40s, p90 최대 179s). 즉 아래 p90 155s 를 "발송 단가"로 삼아
 * 세운 예산 산식(190s + SEED 60s ⇒ 최악 285s < 300s)은 **근거가 없다** — 155s 자체가
 * 타임아웃을 이미 넘긴 뒤의 관측치이지 정상 발송의 소요가 아니다.
 * 원문(참고용, W113 최초 관측): 빠른 구간 p50 16.7s, 느린 구간 p50 116~122s(p90 155s).
 * 고정 건수 상한으로는 두 국면을 한 값으로 맞출 수 없어 **시간**으로 자른다 — 이 설계
 * 결정 자체는 유효하다, 무효한 것은 그 위에 얹은 확률적 보장 주장이다.
 *
 * W114 실측 결과(0.6.9 프로드, 2026-08-20 04:27Z·05:30Z 두 런): 504 는 사라졌다
 * (200 · 205.7s / 206.8s). 그러나 maxObservedSendMs=0 이라 **코호트1·3 은 두 런 모두
 * 발송 0건**이고(적격 3,952명) totalEnqueued 1~2건은 전부 코호트2(적격 122명)다.
 * 실효 발송 개시 마감이 +130s(190s − SEED 60s)인데 0.6.8 실측 첫 발송이 +202~210s
 * (8/8)였다 — 예산이 발송 **결정**만 감시하고 그 앞 ~148초 스캔 구간이 무예산이기
 * 때문이다.
 */
export const NUDGE_SWEEP_BUDGET_MS = 190_000;
/**
 * 발송 1건 소요의 **보수적 초기 추정**. 첫 발송 전에는 관측이 없으므로 이 값으로 판단하고,
 * 이후에는 이번 런에서 관측한 최댓값과 비교해 큰 쪽을 쓴다(타임아웃 이후 스로틀 국면에서
 * 한 건 물면 즉시 멈춘다).
 *
 * W114 처리량 실측(2026-08-20, rel94 배포 후 6시간·여러 런): 정상 발송 단가는 16,017~21,398ms
 * (maxObservedSendMs 관측치들 — 16,017 / 16,471 / 16,641 / 21,398). 옛 값 60,000 의 근거였던
 * "116~155s" 는 위 NUDGE_SWEEP_BUDGET_MS 주석의 W114 정정대로 300초 호스트 타임아웃을 이미
 * 넘겨 CPU 스로틀에 걸린 **뒤**의 관측치였지 정상 발송의 소요가 아니었다 — 반증됨.
 * 옛 값(60,000)은 실측 단가의 약 3~4배라, `Math.max(SEED, maxObservedSendMs)` 가 런 내내
 * SEED 에 고정돼(관측값이 SEED 를 넘지 않으므로) 매 발송 판정마다 예산의 마지막 ~40~45s 를
 * 정상 국면에서도 항상 못 쓰게 막았다 — 190,000ms 예산 · 단가 16~21s 라면 물리적 상한은
 * 9~11건인데 7~8건에서 멈춘 게 그 증거다: (190,000−60,000)/16,000~21,000 ≈ 6.2~8.1.
 *
 * 새 값 30,000 근거: 실측 최댓값 21,398ms 의 약 1.4배 여유(변동성 대비 완충), 그리고
 * NUDGE_SWEEP_COHORT2_BUDGET_MS 와 같은 자릿수라 이 파일의 다른 예산 상수와 단위감이
 * 맞는다. 안전 불변식은 그대로 지킨다: 190,000(예산) + 30,000(새 SEED, 발송 1건 최악
 * 추정) = 220,000 < 300,000(timeoutSeconds) — 80s 여유(옛 값은 250,000, 50s 여유였다).
 * 관측이 쌓이면(Math.max 그대로) 관측값이 SEED 를 넘어서는 즉시 관측값이 우선한다 —
 * 첫 발송 전엔 보수적, 관측 후엔 실측에 더 가깝게 수렴하는 성질은 그대로 보존했다.
 */
export const NUDGE_SWEEP_SEND_ESTIMATE_SEED_MS = 30_000;
/**
 * 커서는 sentAtIso desc + startAfter 라 **과거로만** 간다. 그래서 신규 콜드메일 수신자는
 * 히스토리 끝까지 훑고 되감기 전에는 영원히 스캔되지 않는다(실측: eligible 4,074 의 대부분).
 * N 런마다 한 번은 커서를 무시하고 **최신부터** 훑어 신규 유입이 굶지 않게 한다.
 * 그 런은 커서를 전진시키지 않는다 — 백로그 진행도를 잃지 않기 위해서다.
 */
export const NUDGE_SWEEP_FRESH_SCAN_EVERY = 4;
/**
 * 커서 중간 저장 간격(발송 건수). W114 정정: "예산 산식이 실측 p90(155s) 기준이라
 * 확률적 보장"이라는 원 서술은 근거가 없다 — 위 NUDGE_SWEEP_BUDGET_MS 주석대로 그
 * 155s 는 발송 단가가 아니라 300초 타임아웃을 이미 넘긴 뒤의 관측치다. 다만 아래
 * 설계 결정(플러시 간격 1) 자체는 별개로 유효하다 — 타임아웃 이후 국면에서 발송
 * 1건이 훨씬 오래 걸리다 킬될 수 있다는 위험은 그 숫자와 무관하게 실재한다.
 *
 * 상위 백분위가 더 걸리면 여전히 300s 를 넘길 수 있고, 커서 쓰기가 루프 끝에만 있으면
 * 그때 그 런의 진행도가 통째로 날아가 **동결이 재발**한다. 그래서 발송마다 중간 저장한다.
 *
 * **왜 3 이 아니라 1 인가** (적대 리뷰 2R 이 값으로 지적): 3 은 정확히 필요한 곳에서 안 듣는다.
 *   타임아웃 경계 전 국면(16.7s/건 관측) → 런당 8건 → 3 이면 2회 발동
 *   타임아웃 경계 후 국면(116~155s/건 관측) → 런당 **1건** → 3 이면 **0회 발동**
 * tail 위험이 사는 곳이 바로 경계 후 국면인데, 거기선 발송이 1건뿐이라 간격 3 에 닿을
 * 일이 없다. 그 1건이 킬되면 그 위치가 어디에도 안 남는다. 1 로 두면 그 구멍이 닫힌다.
 * 비용: 경계 전 국면에서 런당 최대 ~8회 쓰기(시간당 1런) — 무시할 수준이다.
 */
export const NUDGE_SWEEP_CURSOR_FLUSH_EVERY = 1;

/**
 * W114 수리① [프로드 실측 2026-08-20 10:28 UTC]: 코호트2 전용 예산 상한.
 *
 * 실측: phaseCohort2Ms=189,532ms — 스테이지 예산(190,000ms)의 99.8%. 그 뒤 코호트1·3 에
 * 0.5초만 남아 rowsScanned=1 로 마감됐다(적격 대기자 3,952명인데 0건 적재). 산수: 코호트2
 * 후보(scp_application_management)가 124건이고 루프가 건당 enqueueVideoReminderForApplication 을
 * 왕복 호출한다 — 124 × ~1.5s ≈ 186s 로 스테이지 예산을 통째로 태운다.
 *
 * 인구 역전: 코호트2 는 적격 상한이 122(스윕이 `scanLimit` 만큼만 보는 작은 인구)인데
 * 코호트1·3 은 3,952 다 — 예산 배분이 인구 비중과 반대로 돼 있었다. 기존 `deadlineMs`
 * 검사(위 W113 P2)는 코호트2 가 전체 예산을 **초과**하는 것은 막지만 코호트1·3 몫을
 * **독점**하는 것은 막지 않는다 — 이 상한이 그 독점을 막는 별도 축이다.
 *
 * 값 근거: 코호트2 인구(122)가 전체(4,074)의 3% 수준이므로 엄격한 비례 배분은 ~6s 지만,
 * 배치 사전 필터(수리②) 적용 전에도 실제 발송 대상 몇 건은 처리할 여유를 주기 위해
 * 인구 비중보다 넉넉한 30,000ms(전체 예산의 16%)를 상한으로 둔다 — 그래도 코호트1·3 에
 * 최소 160,000ms(84%)가 항상 남는다. 기존 `deadlineMs` 검사는 지우지 않는다(초과 방지는
 * 여전히 그 축이 한다) — 이 상한은 **추가**다.
 */
export const NUDGE_SWEEP_COHORT2_BUDGET_MS = 30_000;

/** W72 A: 코호트1·3 은 **초안만** 만든다. 이 상수가 false 로 바뀌는 순간 실발송이 되므로 못 박는다. */
/**
 * W72-B2 [헤세 결정 2026-08-13]: 코호트1·3 도 라이브로 전환됐다.
 * 이 목록은 **비우되 지운다는 뜻이 아니다** — draft 경로 코드는 그대로 있고,
 * 코드 천장(`COHORT_CEILINGS.liveSend`)이 false 인 코호트가 생기면 자동으로 그 경로를 탄다.
 * 되돌리려면 천장 한 줄만 되돌리면 된다(경로를 다시 만들 필요가 없다).
 */
export const NUDGE_DRAFT_ONLY_COHORTS: ReadonlyArray<NudgeCohortKey> = [];

/**
 * 코호트별 mailPurpose. **레인 캡(250/일)이 이 값으로 판정된다** —
 * 코호트마다 달라야 한 코호트가 다른 코호트의 캡을 잠식하지 않는다.
 */
export const NUDGE_COHORT_MAIL_PURPOSE: Readonly<Record<NudgeCohortKey, string>> = {
  [NUDGE_COHORT1_KEY]: "nudge_cohort1_read_no_reply",
  [NUDGE_COHORT2_KEY]: "application_video_reminder",
  [NUDGE_COHORT3_KEY]: "nudge_cohort3_unread_no_reply",
  // Task-100: 코호트2 와 같은 결 — 스윕이 아니라 드레인(resubmissionNudgeMail.ts)이 보낸다.
  [NUDGE_COHORT4_KEY]: "resubmission_nudge",
};

/**
 * Task-44 적대 리뷰 MED-HIGH-2: 코호트별 유효 cadence(ms) 맵 — runNudgeCohortSweep과
 * listNudgeCohortCandidates 양쪽에 복제돼 있던 계산을 이 함수 하나로 합친다(로직 바이트 동일,
 * 회귀 0). candidateTable.ts listCandidates도 "다음 독려 예정일"을 같은 규칙으로 계산하려고
 * 이 함수를 그대로 재사용한다 — 화면(후보 탭)과 실제 스윕이 다른 cadence를 쓰는 갈라짐을 막는다.
 *
 * config.cohorts에 있는 코호트는 설정값을 ms로 바꾸고, 코호트1·3은 설정이 비어 있어도(cadence 0)
 * 전역 기본(NUDGE_DEFAULT_CADENCE_DAYS)으로 닫는다 — cadence 0은 폭송이라 여는 방향으로 실패하지
 * 않는다(W72 마감리뷰 P0-2). 코호트2는 설정이 없으면 맵에 아예 없다(호출부가 판정 불가로 처리).
 */
export function resolveCohortCadenceMsMap(config: NudgeSequenceConfig): Map<NudgeCohortKey, number> {
  const cadenceMsByCohort = new Map<NudgeCohortKey, number>();
  for (const [cohort, cohortConfig] of config.cohorts) {
    cadenceMsByCohort.set(cohort, cohortConfig.cadenceDays * 24 * 60 * 60 * 1000);
  }
  for (const cohort of [NUDGE_COHORT1_KEY, NUDGE_COHORT3_KEY] as NudgeCohortKey[]) {
    if (!(cadenceMsByCohort.get(cohort) ?? 0)) {
      cadenceMsByCohort.set(cohort, NUDGE_DEFAULT_CADENCE_DAYS * 24 * 60 * 60 * 1000);
    }
  }
  return cadenceMsByCohort;
}

export type NudgeCohortSweepCounts = {
  scanned: number;
  eligible: number;
  enqueued: number;
  skippedCooldown: number;
  skippedMaxReached: number;
  skippedInFlight: number;
  /** 회차 매핑이 없어 **적재 전에** 막은 대상 수. 리더 요구: 미설정 회차 대상자를 센다. */
  skippedUnmapped: number;
  skippedIneligible: number;
  skippedRunCap: number;
  /** 합동리뷰 P2-11: 큐 쓰기 실패는 "이미 큐에 있음"과 **다른 사실**이라 갈라 센다. */
  skippedQueueError: number;
  /**
   * 합동리뷰 R3-4: 이름을 실의미에 맞춘다. 이 값은 "건너뛴 수"가 아니라
   * **다회차가 설정돼 있는데 이 레인이 1회차만 지원해서 나머지를 못 보내는 대상 수**다.
   */
  eligibleWithUnsupportedSequences: number;
};

/**
 * W114 [헤세 배정] — 순수 계측(동작 무변경). W75 완주(+54s)와 첫 발송(+205s) 사이 148초의
 * 로그 공백을 여는 것이 목적이다. 전부 ms 또는 카운트, 실행 시작(runStartMs) 기준 상대값이다.
 */
export type NudgeSweepPhaseMetrics = {
  /** 코호트2 블록(재촉 레인 확장) 총 소요. */
  phaseCohort2Ms: number;
  /** 코호트1·3 원장 페이지 조회 소요(되감기 재조회 포함). */
  phaseHistoryQueryMs: number;
  /** 제외 집합(replied/applied/opened/nudgeHistory) Promise.all 소요. */
  phaseExclusionBatchMs: number;
  /** 코호트1·3 행 루프 총 소요. */
  phaseRowLoopMs: number;
  /** 행 루프가 실제로 훑은 행 수(중복 이메일 포함, 페이지 원행 기준). */
  rowsScanned: number;
  /** 행 루프에서 적격(eligible) 판정된 수. */
  eligibleSeen: number;
  /**
   * 행 루프의 발송 직전 재검사(nudgeStopConditionBeforeSend) 호출 수.
   * W114 리뷰(MEDIUM): **행 루프에서 직접 호출한 것만** 센다 — draftQueue 내부
   * (queueNudgeForCohort 안, 라이브 코호트1·3 경로)의 동일 재검사 호출은 이 카운터에
   * 잡히지 않는다. 그 이중 호출 자체는 별도 이슈로 추적 중이고 이 커밋은 손대지 않는다.
   */
  stopConditionCalls: number;
  /** 위 호출들의 누적 소요(ms). 포함 범위는 stopConditionCalls 와 동일하다(행 루프 호출분만). */
  stopConditionMs: number;
  /** 발송 직전 재검사가 멈춤을 반환해 recordNudgeStoppedBeforeSend 쓰기가 일어난 횟수. */
  stopWriteCalls: number;
  /**
   * 첫 발송 시도 시각(실행 시작 기준). 발송 시도가 없었으면 0.
   * W114 리뷰(MEDIUM): **코호트1·3 의 draftQueue 호출만** 잰다 — 코호트2
   * (enqueueVideoReminderForApplication, 위 phaseCohort2Ms 블록)는 이 필드를 갱신하지
   * 않는다. 프로드 실측(2026-08-20 두 런)에서 실제 발송은 코호트2 에서 났는데 이 필드는
   * 두 런 모두 0 이었다 — "발송 시도가 없었다"와 값이 같아 오독하기 쉽다. 코호트2 의
   * 첫 발송 시도 시각이 필요하면 아직 없다(phaseCohort2Ms 는 블록 총소요일 뿐 첫 시도
   * 시각이 아니다) — 별도 이슈로 추적 중이다.
   */
  firstSendOffsetMs: number;
  /** 절단(예산/상한) 시점의 deadlineMs - clock(). 절단이 없었으면 0. 음수면 이미 마감 초과. */
  deadlineHeadroomMsAtCut: number;
};

export type NudgeCohortSweepResult = {
  ok: true;
  nowIso: string;
  enabled: boolean;
  /** 설정이 꺼져 있거나 매핑이 없어 아무것도 안 한 이유. 빈 문자열이면 정상 실행이다. */
  haltReason: string;
  maxEnqueuePerRun: number;
  /** W113: 예산/상한으로 끊겼는가. 완료 판정(504 소멸·커서 전진)의 근거로 로그에 싣는다. */
  budgetStopped: boolean;
  /**
   * W113 [적대 게이트 P3]: 무엇이 끊었는지. budgetStopped 하나로는 **시간 예산**과 **건수 상한**이
   * 섞여 로그 판독이 흐려진다 — 배포 후 관측에서 "예산이 부족한가(발송 단가 문제)"와
   * "상한에 닿았는가(정상 포화)"는 정반대 처방으로 이어지므로 갈라 둔다.
   */
  /**
   * 스윕을 **실제로 끝낸** 사유. 2026-08-29 정정: 종전에는 코호트2 가 자기 예산 상한에 닿기만 해도
   * 이 필드를 `cohort2_time_budget` 으로 선점했는데, 코호트2 의 상한은 **코호트2 루프만** 끊고
   * 코호트1·3 행 루프는 그대로 진입한다(`budgetStoppedBeforeRowLoop` 스냅샷이 그래서 있다).
   * 그 결과 코호트1·3 이 400행을 정상 완주하고 적격자가 0 이라 끝난 런까지 "코호트2 예산 때문에
   * 멈췄다"로 보고돼, 장애 진단이 **코호트1·3 이 굶었다**는 틀린 결론으로 갔다(실제 오진 발생).
   * 코호트2 축은 아래 `cohort2BudgetStopped` 로 따로 싣는다 — 두 사실은 처방이 다르다.
   */
  stopReason: "" | "time_budget" | "run_cap";
  /** 코호트2 가 자기 예산 상한에 닿았는가. 스윕 종료 사유가 **아니다**(코호트1·3 은 계속 돈다). */
  cohort2BudgetStopped: boolean;
  /** W113: 이번 런이 커서를 무시하고 최신부터 훑은 회차인가. */
  freshRun: boolean;
  /**
   * W113: 이번 런에서 관측한 발송 1건 최대 소요(ms). W114 정정: 빠른/느린 체제가 아니라
   * **300초 타임아웃 전/후** 판별용이다(위 NUDGE_SWEEP_BUDGET_MS 주석 참고).
   */
  maxObservedSendMs: number;
  /**
   * W72 합동리뷰 R3-3: apply 제외가 **전량 대조가 아니라는 사실**을 결과에 싣는다.
   * 계산만 하고 버리면 "1000건 제한 노출"이 구현되지 않은 것과 같다.
   */
  applyExclusionCoverage: {
    managementScanned: number;
    managementCapped: boolean;
  };
  totalEnqueued: number;
  cohorts: Record<string, NudgeCohortSweepCounts>;
  /** W114: 단계별 소요·카운트(순수 계측 — 동작에는 아무 영향도 없다). */
  phases: NudgeSweepPhaseMetrics;
  /**
   * W118: 독려 레인이 **수동 정지**여서 이번 패스가 설정 조회·후보 스캔조차 하지 않고 끝났는가.
   * 이때 `enabled` 는 false 로 남지만 그건 "설정이 꺼졌다"가 아니라 **"읽지 않았다"** 는 뜻이다 —
   * 두 사실을 가르는 축은 이 필드와 `haltReason`("nudge_lane_paused" vs "nudge_sequence_disabled")
   * 이다. 뭉개면 "왜 안 도나"의 처방이 갈리지 않는다(설정 복구 vs 토글 재개).
   */
  lanePaused: boolean;
};

function emptyCounts(): NudgeCohortSweepCounts {
  return {
    scanned: 0,
    eligible: 0,
    enqueued: 0,
    skippedCooldown: 0,
    skippedMaxReached: 0,
    skippedInFlight: 0,
    skippedUnmapped: 0,
    skippedIneligible: 0,
    skippedRunCap: 0,
    skippedQueueError: 0,
    eligibleWithUnsupportedSequences: 0,
  };
}

export type NudgeCohortSweepOptions = {
  nowIso?: string;
  maxEnqueuePerRun?: number;
  scanLimit?: number;
  /** 절대 시각(epoch ms). 이 시각까지만 발송한다. 호스트가 함수 시작 시각 + 예산으로 준다. */
  deadlineMs?: number;
  /** 테스트 주입용 시계. 기본 Date.now. */
  clock?: () => number;
  /** 코호트1·3 초안 큐잉 어댑터. 기본은 이 파일의 draft-only 적재다(라이브 경로 없음). */
  draftQueueAdapter?: (input: {
    cohort: NudgeCohortKey;
    email: string;
    templateKey: string;
    sequence: number;
    nowIso: string;
    conversationId: string;
    /** W114-F: 드레인이 발송 직전 수신자를 재해석할 참조(적재/발송 분리 — PII 비노출). */
    coldmailHistoryDocId: string;
    /** 0.6.110: 콜드메일 이력의 캠페인/프로그램 귀속(없으면 빈 문자열). */
    campaignId?: string;
    programId?: string;
    /** 0.6.110: 이 회차 문안을 고른 프로그램 오버라이드 ID(없으면 전역 매핑 = 빈 문자열). */
    programOverrideId?: string;
  //   W72E-R1 P1-1: 반환값이 **예산을 소모했는가**다. 비발송 status(blocked 등)도 merge 는
  //   성공하므로 성공/실패로만 세면 잔재 64건이 캡 50을 다 먹어 신규 대상이 굶는다.
  }) => Promise<{ consumed: boolean; status: string }>;
  /** W118 테스트 주입용 — 기본은 실제 레인 정지 조회(mailOutboundSafety.readMailLaneManualPause). */
  lanePauseCheck?: typeof readMailLaneManualPause;
};

/**
 * 0.6.110: 큐 행/발송 호출에 싣는 캠페인·프로그램 귀속 필드. **값이 있는 것만** 싣는다 —
 * 오버라이드가 없는 전역(XP/SCP) 행은 종전과 바이트 단위로 같은 문서가 된다.
 */
function nudgeAttributionFields(input: {
  campaignId?: string;
  programId?: string;
  programOverrideId?: string;
}): { campaignId?: string; programId?: string; programOverrideId?: string } {
  return {
    ...(input.programOverrideId ? { programOverrideId: input.programOverrideId } : {}),
    ...(input.programOverrideId && input.campaignId ? { campaignId: input.campaignId } : {}),
    ...(input.programOverrideId && input.programId ? { programId: input.programId } : {}),
  };
}

/**
 * 코호트1·3 초안 적재. **여기에는 SMTP 도 sendAdapter 도 없다.**
 * `mode:"draft_only"` · `liveSend:false` 를 행에 못 박아, 이 행을 소비하는 쪽이 라이브로 바꾸려면
 * 저장된 사실과 모순되게 만들어야 한다(뮤테이션으로 그 사실을 고정한다).
 */
async function queueDraftOnlyNudge(input: {
  cohort: NudgeCohortKey;
  email: string;
  templateKey: string;
  sequence: number;
  nowIso: string;
  /** P0-3: 회신 재검사의 유효 상관축. `from` 은 마스킹 혼재라 못 쓴다. */
  conversationId: string;
  campaignId?: string;
  programId?: string;
  programOverrideId?: string;
}): Promise<{ consumed: boolean; status: string }> {
  // 합동리뷰 P1-7: 문서 ID 가 이메일 hex 접두어였다 — **가역**이라 PII 비노출 계약 위반이다.
  //   SHA-256 으로 바꾼다. 결정적 키라는 성질(같은 대상·같은 회차 = 같은 문서)은 그대로다.
  // 헤세 2026-08-13: draft 경로도 같은 멈춤을 지킨다 — 경로가 갈리면 한쪽만 지켜진다.
  const stop = await nudgeStopConditionBeforeSend({ email: input.email, conversationId: input.conversationId });
  if (stop) {
    await recordNudgeStoppedBeforeSend({
      cohort: input.cohort, sequence: input.sequence, email: input.email,
      reason: stop, nowIso: input.nowIso,
    });
    // 멈춤은 적재가 아니다 — 예산도 enqueued 도 쓰지 않는다.
    return { consumed: false, status: `stopped:${stop}` };
  }

  const emailDigest = nudgeEmailDigest(input.email);
  const id = `w72-${input.cohort}-${input.sequence}-${emailDigest.slice(0, 40)}${nudgeQueueIdSuffix(input.programOverrideId)}`;
  // 합동리뷰 R2-3: **draft 를 먼저 만든다.** 종전에는 큐를 create 한 뒤 draft 를 만들어서,
  //   draft 가 실패하면 queued 행만 영구히 남고 다음 실행이 already-exists 로 스킵해
  //   **영원히 draft 가 안 생기는** 고착이 됐다. draft 가 성공한 뒤에만 큐 행을 만든다.
  //   반대 순서의 잔여물(큐 없는 draft)은 결정적 키라 재실행에서 같은 문서를 덮으므로 고착되지 않는다.
  const draft = await createNudgeDraftForSweep({
    email: input.email,
    runKey: id,
    cohort: input.cohort,
    // 합동리뷰 R2-2: 매핑된 문안을 넘긴다 — 안 넘기면 항상 re_guide 가 생성된다.
    templateKey: input.templateKey,
    nowIso: input.nowIso,
    ...nudgeAttributionFields(input),
    conversationId: input.conversationId,
  });

  // W72 긴급(자기 점검): 라이브 경로와 **같은 병**이 여기에도 있었다.
  //   create 는 이전 사이클의 잔재 행과 충돌하고, 그 충돌이 already-exists 로 삼켜져
  //   draft 생성 사실을 잃는다 → 회차가 영원히 0 → 매 스윕 재생성.
  //   지금은 코호트1·3 이 라이브라 이 경로가 안 쓰이지만, 되돌림 경로로 **일부러 살려둔** 코드다
  //   (천장 한 줄로 draft 로 돌아갈 수 있게). 살려둔 이상 같은 수리를 받아야 한다.
  await adminDb.collection(OUTREACH_QUEUE_COLLECTION).doc(id).set({
    id,
    source: "w72_nudge_sweep",
    cohort: input.cohort,
    sequence: input.sequence,
    templateKey: input.templateKey,
    // 이 두 필드가 이 레인의 계약이다. 값이 바뀌면 draft-only 가 아니게 된다.
    mode: "draft_only",
    liveSend: false,
    status: draft.status,
    resultRef: draft.resultRef,
    // 수신자 원문은 큐에 싣지 않는다(PII 비노출 — 확인메일/재촉 레인과 같은 규약).
    //   합동리뷰 P1-7: Base64url 은 **가역**이라 해시가 아니었다. SHA-256 전체를 쓴다.
    emailHash: emailDigest,
    ...nudgeAttributionFields(input),
    createdAtIso: input.nowIso,
    updatedAtIso: input.nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  // W72E-R1 P1-1: draft 가 **실제로 생성됐을 때만** 예산을 쓴다.
  //   blocked 같은 비발송 status 도 merge 는 성공하므로, 성공 여부로 세면
  //   잔재가 캡을 다 먹어 신규 대상이 굶는다(잔재 64 > 캡 50).
  return { consumed: NUDGE_SENT_STATUSES.has(draft.status), status: draft.status };
}

/**
 * 수신자별 독려 발송 이력. 회차(코호트별)와 마지막 수신 시각(코호트 무관)을 함께 돌려준다.
 * 이력이 없으면 `{ deliveredByCohort: 빈 맵, lastSentMs: 0 }` — 1회차 대상이라는 뜻이다.
 */
/**
 * 큐 원장의 `emailHash` 와 **같은 규칙**이어야 이력이 조회된다(복제 금지).
 * Flu/Task-44: candidateNudgeCadenceOverride.ts 가 같은 조인 키로 후보별 주기 오버라이드를
 * 저장하므로 export 한다 — 새 해시 함수를 따로 만들지 않는다(복제 금지 원칙 그대로 적용).
 */
/**
 * 0.6.110 D: 회차 집계 버킷 키. 오버라이드가 적용된 수신자는 `<cohort>@<overrideId>` 버킷으로 회차·최대
 * 회차를 **프로그램별로** 센다(XP 독려를 받은 사람도 Snake 1회차부터). 오버라이드가 없으면 종전 키(`<cohort>`)
 * 그대로라 기존 카운터는 전역/XP 버킷으로 취급되고 XP 동작은 불변이다. 마지막 수신 시각(주기)·지원/회신/suppression
 * 제외는 버킷과 무관하게 전역이다.
 */
export function nudgeBucketKey(cohort: string, programOverrideId: string | undefined): string {
  return programOverrideId ? `${cohort}@${programOverrideId}` : cohort;
}

/**
 * 0.6.110 D: **다른 버킷**에 대기 중(draft/queued/sending)인 같은 코호트 행 수. 회차는 버킷별로 세지만 대기 중인
 * 행은 전역으로 막는다 — 안 그러면 전역 행이 대기 중일 때 오버라이드를 켜면 새 버킷이 비어 보여 같은 사람에게
 * 두 행이 연달아 나간다(전역 7일 간격 우회).
 */
function pendingInOtherBuckets(
  draftedByBucket: ReadonlyMap<string, number> | undefined,
  cohort: string,
  rowBucket: string,
): number {
  const overrideRow = rowBucket.includes("@");
  let total = 0;
  for (const [key, count] of draftedByBucket ?? []) {
    if (key === rowBucket) {
      // 오버라이드 버킷은 같은 버킷의 대기 행도 무조건 막는다(전역 버킷의 종전 `drafted > delivered` 규칙은 불변).
      if (overrideRow) total += count;
    } else if (overrideRow || key === cohort || key.startsWith(`${cohort}@`)) {
      // 오버라이드 행은 코호트 전이(③→①)를 가로질러서도 전역 대기를 배제한다.
      total += count;
    }
  }
  return total;
}

/** 오버라이드 행의 큐 문서 ID 접미사 — 같은 (코호트,회차,수신자)라도 프로그램마다 문서가 달라 XP 이력을 덮지 않는다. */
function nudgeQueueIdSuffix(programOverrideId: string | undefined): string {
  return programOverrideId ? `-p${createHash("sha256").update(programOverrideId, "utf8").digest("hex").slice(0, 12)}` : "";
}

export function nudgeEmailDigest(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

async function readNudgeHistory(emailDigests: string[]): Promise<Map<string, {
  deliveredByCohort: Map<string, number>;
  /** W72E-R1 P1-3: draft 생성 이력. 회차는 안 쓰지만 **재생성을 막는** 축이다. */
  draftedByCohort: Map<string, number>;
  lastSentMs: number;
}>> {
  const history = new Map<string, {
    deliveredByCohort: Map<string, number>;
    draftedByCohort: Map<string, number>;
    lastSentMs: number;
  }>();
  for (let offset = 0; offset < emailDigests.length; offset += 10) {
    const chunk = emailDigests.slice(offset, offset + 10);
    if (chunk.length === 0) continue;
    const snapshot = await adminDb.collection(OUTREACH_QUEUE_COLLECTION)
      .where("source", "==", "w72_nudge_sweep")
      .where("emailHash", "in", chunk)
      .select("emailHash", "cohort", "status", "createdAtIso", "resultRef", "programOverrideId")
      .get();
    for (const doc of snapshot.docs) {
      const row = doc.data() ?? {};
      const digest = asString(row.emailHash);
      const rawCohort = asString(row.cohort);
      if (!digest || !rawCohort) continue;
      const cohort = nudgeBucketKey(rawCohort, asString(row.programOverrideId));
      const status = asString(row.status);
      const isSent = NUDGE_SENT_STATUSES.has(status);
      const isDrafted = NUDGE_DRAFTED_STATUSES.has(status);
      // 발송도 draft 도 아니면(blocked·stopped 등) 아무 것도 세지 않는다.
      if (!isSent && !isDrafted) continue;
      const entry = history.get(digest) ?? {
        deliveredByCohort: new Map<string, number>(),
        draftedByCohort: new Map<string, number>(),
        lastSentMs: 0,
      };
      if (isSent) {
        // 회차(delivered)는 **받은 통수**다 — 발송된 행만 센다.
        entry.deliveredByCohort.set(cohort, (entry.deliveredByCohort.get(cohort) ?? 0) + 1);
        const sentMs = Date.parse(asString(row.createdAtIso));
        // 쿨다운은 **코호트 무관** 마지막 수신 기준이다(전이 직후 연속 폭격 방지).
        if (Number.isFinite(sentMs) && sentMs > entry.lastSentMs) entry.lastSentMs = sentMs;
      } else {
        // W72E-R1 P1-3: draft 는 회차를 안 쓰지만 **재생성은 막아야 한다**.
        // W72F-R1 P1-3: draft 가 **종결**됐으면 대기가 아니다 —
        //   취소·거절·발송 전진 뒤에도 막으면 그 회차가 영구 차단된다(정당한 재시도가 죽는다).
        //   큐 status 만으로는 종결을 알 수 없으므로 result 문서 상태까지 본다.
        let draftTerminal = false;
        const draftResultRef = asString(row.resultRef);
        if (draftResultRef) {
          const result = (await adminDb.doc(draftResultRef).get()).data() ?? {};
          draftTerminal = NUDGE_DRAFT_TERMINAL_STATUSES.has(asString(result.status));
        }
        if (!draftTerminal) {
          entry.draftedByCohort.set(cohort, (entry.draftedByCohort.get(cohort) ?? 0) + 1);
        }
      }
      history.set(digest, entry);
    }
  }
  return history;
}

/**
 * 발송 직전 멈춤 조건 [헤세 2026-08-13]. 멈출 사유가 있으면 사유 코드를, 없으면 빈 문자열을 돌려준다.
 *
 * 대상 선정 때 이미 걸렀지만 **그 사이의 창**을 여기서 닫는다. 두 축만 본다 —
 * 회신(`message_sources` inbound)과 지원(`program_applications` / management).
 * 조회는 수신자 1명분이라 배치 조회와 달리 창이 좁다.
 */
async function nudgeStopConditionBeforeSend(input: {
  email: string;
  conversationId: string;
}): Promise<string> {
  const normalized = normalizeApplyEmail(input.email);
  if (!normalized) return "";

  // W72 마감리뷰 P0-3: 상관축을 실제로 유효한 것으로 바꾼다.
  //   · 지원 = `program_applications.email` — trim+lower 로 **raw 를 실제 저장하는** writer 다.
  //     management 원장은 privacy 계약상 raw email 을 저장하지 않아 조회가 늘 공집합이었다.
  //   · 회신 = `conversationId` — `from` 은 마스킹(he***@)과 원문이 혼재해 신뢰할 수 없다.
  //     (같은 파일의 repliedConversationIds 주석이 스스로 그렇게 명시하고 있었다.)
  const applied = await adminDb.collection(PROGRAM_APPLICATIONS_COLLECTION)
    .where("email", "==", normalized).limit(1).get();
  if (!applied.empty) return "applied_before_send";

  if (input.conversationId) {
    const replied = await adminDb.collection(MESSAGE_SOURCES_COLLECTION)
      .where("conversationId", "==", input.conversationId)
      .where("direction", "==", "inbound")
      .limit(1)
      .get();
    if (replied.docs.some((doc) => asString((doc.data() ?? {}).receivedAtIso))) {
      return "replied_before_send";
    }
  }
  return "";
}

/** 멈춤을 **관측 가능한 사실**로 남긴다. 회차는 소모하지 않는다(비소모 종결). */
async function recordNudgeStoppedBeforeSend(input: {
  cohort: NudgeCohortKey;
  sequence: number;
  email: string;
  reason: string;
  nowIso: string;
}): Promise<void> {
  const digest = nudgeEmailDigest(input.email);
  await adminDb.collection(OUTREACH_QUEUE_COLLECTION)
    .doc(`w72-stop-${input.cohort}-${input.sequence}-${digest.slice(0, 40)}`)
    .set({
      source: "w72_nudge_sweep",
      cohort: input.cohort,
      sequence: input.sequence,
      emailHash: digest,
      // 이 status 는 NUDGE_SENT_STATUSES 에 없다 — 회차를 소모하지 않는다는 뜻이다.
      status: "stopped_before_send",
      stopReason: input.reason,
      liveSend: false,
      createdAtIso: input.nowIso,
      updatedAtIso: input.nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
}

/**
 * W72-B2 [헤세 결정 2026-08-13] — 코호트별 **발송 경로 선택기**.
 *
 * 헤세 결정으로 코호트1·3 이 라이브로 전환됐지만 **draft 경로 코드는 그대로 둔다**(되돌림 가능성).
 * 어느 쪽을 탈지는 코드 천장 `COHORT_CEILINGS.liveSend` 하나가 정한다 —
 * 되돌리려면 그 한 줄만 false 로 바꾸면 되고, 경로를 다시 만들 필요가 없다.
 *
 * 두 경로 모두 같은 것을 지난다(우회 없음):
 *   문안 매핑(fail-closed) · 미치환 토큰 거부 · suppression · 레인 캡 · 전역 캡.
 *
 * W114-F [적재/발송 분리, 하루 1,250건 구조 변경]: 이 함수의 라이브 분기는 더 이상
 * `sendNudgeLiveForSweep`(prepareScpResultMail preview→apply, 건당 16~21s)을 **인라인으로**
 * 부르지 않는다. 그 호출이 스윕의 190초 예산을 지배해 런당 7~11건까지만 처리하게 만든 지배
 * 요인이었다(design: nudge-throughput-design.md (a)). 이제 이 함수는 **적재만** 한다(건당
 * 수백 ms — Firestore 읽기 2회 + 쓰기 1회) — 실제 발송은 `drainNudgeCohort13Outbox`
 * (아래, `scpApplicationVideoReminderMailWorker` 1분 틱이 코호트2 드레인 뒤에 이어 부른다)가
 * 페이싱하며 한다. 캡·suppression·미치환 거부는 전부 그 드레인이 부르는 같은
 * `sendNudgeLiveForSweep` 이 지킨다 — 우회 경로가 아니라 **호출 시점만** 옮겼다.
 */
async function queueNudgeForCohort(input: {
  cohort: NudgeCohortKey;
  email: string;
  templateKey: string;
  sequence: number;
  nowIso: string;
  conversationId: string;
  /** W114-F: 드레인이 발송 직전에 수신자를 재해석할 참조(PII 비노출 — 이메일 원문 대신 문서ID). */
  coldmailHistoryDocId: string;
  campaignId?: string;
  programId?: string;
  programOverrideId?: string;
}): Promise<{ consumed: boolean; status: string }> {
  const ceilings = nudgeCohortCeilings();
  if (!ceilings[input.cohort]?.liveSend) {
    // 천장이 draft 를 지시하면 그 경로의 판정을 그대로 돌려준다.
    return await queueDraftOnlyNudge(input);
  }

  // W72 스펙 [헤세 2026-08-13 "실제로 제출했거나 메일 답장했으면 멈춰야 한다"]:
  //   대상 선정과 **적재** 사이의 창을 닫는다(발송 직전 재검사는 드레인이 별도로 또 한다 —
  //   적재-발송 사이에 새로 생긴, 더 넓은 창을 그쪽이 닫는다. 아래 drainNudgeCohort13Outbox 참고).
  //   중단은 **비소모 종결**이다 — 회차를 쓰지 않고 사유 코드만 남긴다.
  const stop = await nudgeStopConditionBeforeSend({ email: input.email, conversationId: input.conversationId });
  if (stop) {
    await recordNudgeStoppedBeforeSend({
      cohort: input.cohort,
      sequence: input.sequence,
      email: input.email,
      reason: stop,
      nowIso: input.nowIso,
    });
    // 멈춤은 적재가 아니다 — 예산도 enqueued 도 쓰지 않는다.
    return { consumed: false, status: `stopped:${stop}` };
  }

  const emailDigest = nudgeEmailDigest(input.email);
  const id = `w72-${input.cohort}-${input.sequence}-${emailDigest.slice(0, 40)}${nudgeQueueIdSuffix(input.programOverrideId)}`;
  // W114-F: 결정적 키(cohort+sequence+emailHash)로 merge 쓰기 — 같은 사람·같은 회차를 두 번
  //   적재해도 문서가 하나다(멱등). 이미 "queued"/그 이후 상태인 행을 다시 적재해도 같은 문서를
  //   덮어쓸 뿐 큐에 두 번 들어가지 않는다.
  await adminDb.collection(OUTREACH_QUEUE_COLLECTION).doc(id).set({
    id,
    source: "w72_nudge_sweep",
    cohort: input.cohort,
    sequence: input.sequence,
    templateKey: input.templateKey,
    // W114-F: 이 레인의 계약이 다시 바뀌었다는 사실을 행에 남긴다 — "send"(구, 인라인 발송)와
    //   구분된다. liveSend:true 는 그대로다(라이브 레인이라는 사실 자체는 안 바뀌었다).
    mode: "outbox_queued",
    liveSend: true,
    mailPurpose: NUDGE_COHORT_MAIL_PURPOSE[input.cohort],
    status: "queued",
    // 수신자 원문은 큐에 싣지 않는다(PII 비노출). 드레인은 coldmailHistoryDocId 로
    //   scp_coldmail_history(이미 이 발송 이력의 정본 — 새 노출면이 아니다)를 다시 읽어 해석한다.
    emailHash: emailDigest,
    conversationId: input.conversationId,
    coldmailHistoryDocId: input.coldmailHistoryDocId,
    ...nudgeAttributionFields(input),
    createdAtIso: input.nowIso,
    updatedAtIso: input.nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  // W114-F [코호트2 와 같은 원칙, enqueueVideoReminderForApplication 의 "queued" 참고]:
  //   적재 자체가 이번 런의 예산(remaining)을 소모한다 — "받았는가"가 아니라 "드레인 파이프라인에
  //   들어갔는가"다. 실제 배송(sent/delivered) 여부는 드레인이 판정하고, 회차(deliveredByCohort)는
  //   여전히 NUDGE_SENT_STATUSES(sent/delivered)만 센다 — 이 반환값은 run cap 용이지 회차 용이 아니다.
  return { consumed: true, status: "queued" };
}

/** W114-F: 큐 문서의 `coldmailHistoryDocId` 로 발송 직전 수신자를 재해석한다. */
async function resolveNudgeOutboxRecipientEmail(coldmailHistoryDocId: string): Promise<string> {
  if (!coldmailHistoryDocId) return "";
  const snapshot = await adminDb.collection(COLDMAIL_HISTORY_COLLECTION).doc(coldmailHistoryDocId).get();
  if (!snapshot.exists) return "";
  const row = snapshot.data() ?? {};
  // 행 루프(위 rows.map)가 email 을 뽑는 것과 같은 규칙 — 정본을 복제하지 않고 같은 우선순위를 쓴다.
  return asString(row.emailLower) || asString(row.email).trim().toLowerCase();
}

/**
 * 리뷰어 B HIGH 수리 — 코호트2 드레인의 클레임/리클레임 패턴을 미러링한다(새 패턴 발명 금지,
 * scpOutboxMailWorkers.ts:325 reclaimStaleSendingOutboxRows 와 동형, 필드명만 다르다).
 *
 * 왜 필요한가: 클레임(아래 본문의 "queued"→"sending" 트랜잭션) 뒤 워커가 죽으면(SIGKILL·타임아웃)
 * 행이 "sending" 에 갇힌다. 이 자체는 옛 인라인 설계에도 있던 위험이지만(리뷰어 B 재확인),
 * 바깥 재시도 리듬이 다르다 — 옛 설계는 다음 스윕(60분)에야 재평가됐는데, 이 드레인의 큐 조회는
 * "queued" 만 보므로 "sending" 에 갇힌 행은 **그 자체로는** 다음 틱에 안 잡힌다(좋은 방향).
 * 문제는 반대로 "sending" 인 채 영원히 안 풀리면 그 행이 영구 손실된다는 것 — 그래서 TTL(15분,
 * 코호트2 와 같은 값) 이 지나면 "queued" 로 되돌려 **1회만** 다시 시도할 기회를 준다. 이게
 * "1분마다 즉시 무한 재시도"가 아니라 "15분 백오프 뒤 1회 재시도"인 이유다.
 *
 * [리뷰어 B MEDIUM 수리] 이 스캔 자신도 마감(deadlineMs) 을 진다 — 대량 crash 직후 시나리오
 * (stale 행이 최대 50건까지 쌓인 상태)에서 각 건이 트랜잭션이라, 코호트2 드레인이 이미 예산을
 * 상당히 먹은 뒤라면 이 스캔 하나만으로 timeoutSeconds:120 을 넘길 수 있다 — 바로 이 예산
 * 장치(NUDGE_DRAIN_BUDGET_MS)가 막으려던 실패 계열(W113/690f2bb1, 호스트 타임아웃 초과 →
 * SIGKILL → 스케줄러 손상)이다. 아래 due 루프와 같은 축(clock() vs deadlineMs)으로, 매 건
 * 처리 **전에** 검사한다 — 호출부에서 한 번만 게이트하면 "시작할 때는 여유 있었는데 50건을
 * 도는 사이 넘는" 경우를 못 막으므로 루프 내부에도 건다.
 */
async function reclaimStaleSendingNudgeOutboxRows(
  now: Date,
  deadlineMs: number,
  clock: () => number,
): Promise<number> {
  const cutoffIso = new Date(now.getTime() - STALE_SENDING_RECLAIM_TTL_MS).toISOString();
  const stale = await adminDb.collection(OUTREACH_QUEUE_COLLECTION)
    .where("source", "==", "w72_nudge_sweep")
    .where("status", "==", "sending")
    .limit(50)
    .get();
  let reclaimed = 0;
  for (const doc of stale.docs) {
    if (clock() >= deadlineMs) break;
    const updatedAtIso = asString(doc.data()?.updatedAtIso);
    if (updatedAtIso && updatedAtIso > cutoffIso) continue;
    const reverted = await adminDb.runTransaction(async (transaction) => {
      const fresh = await transaction.get(doc.ref);
      const freshData = fresh.data() ?? {};
      if (asString(freshData.status) !== "sending") return false;
      const freshUpdatedAtIso = asString(freshData.updatedAtIso);
      if (freshUpdatedAtIso && freshUpdatedAtIso > cutoffIso) return false;
      transaction.set(doc.ref, {
        status: "queued",
        updatedAtIso: now.toISOString(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return true;
    });
    if (reverted) reclaimed += 1;
  }
  return reclaimed;
}

export type DrainNudgeCohort13OutboxOptions = {
  /**
   * 틱(1분)당 처리 상한. 기본 2 — 설계 근거(design: nudge-throughput-design.md (d)):
   *   **격리 상태**(이 레인 혼자일 때)의 목표 천장은 10분 창 2×10=20, 시간당 2×60=120 이다.
   *   [리뷰어 B MEDIUM 정정] burstCap(20)·hourlyCap(120) 은 **mailbox 축**이라 코호트2 드레인·
   *   확인메일 등 같은 발신함을 쓰는 모든 레인이 **공유**한다 — 다른 레인이 같은 창에서 먼저
   *   쓰면 이 레인이 실제로 쓸 수 있는 양은 20/120 보다 **적다**. "정확히 그 값에 수렴한다"는
   *   이 레인 혼자 그 공유 예산을 전부 쓴다고 가정한 것으로, 실제로는 상한일 뿐 보장이 아니다.
   *   그럼에도 batchLimit 을 작게 두는 이유는 그대로다 — 이 레인이 공유 예산을 과점하지 않게.
   */
  batchLimit?: number;
  now?: Date;
  /** 테스트 주입용 시계 — deadlineMs 판정에만 쓴다. 기본 Date.now. */
  clock?: () => number;
  /**
   * [리뷰어 B HIGH 수리] 절대 시각(epoch ms). 이 시각 이후로는 새 행을 시작하지 않는다.
   * 호출부(index.ts)가 "워커 호출 시작 시각 + 예산"으로 준다 — 코호트2 드레인이 먼저 돌고
   * 이 드레인이 **같은 워커의 timeoutSeconds:120 예산을 나눠 쓰므로**, 마감 없이 돌면 W113/
   * 690f2bb1 이 기록한 504·SIGKILL 사고(호스트 타임아웃 초과 → 스케줄러 손상)가 재발할 수 있다.
   * 미지정 시 `clock() + NUDGE_DRAIN_BUDGET_MS` 로 스스로 계산한다(단독 호출·테스트 대비).
   */
  deadlineMs?: number;
  /** 테스트 주입용 — 기본은 실제 발송(scpOutreach.ts sendNudgeLiveForSweep, preview→apply). */
  sendAdapter?: typeof sendNudgeLiveForSweep;
  /** 테스트 주입용 — 기본은 실제 레인캡 조회(mailOutboundSafety.ts). */
  laneQuotaCheck?: typeof laneDailyQuotaAllows;
  /** [헤세 2026-09-03] 테스트 주입용 — 기본은 실제 합산캡 조회(mailOutboundSafety.ts). */
  totalQuotaCheck?: typeof totalDailyQuotaAllows;
  /** W118 테스트 주입용 — 기본은 실제 레인 정지 조회(mailOutboundSafety.readMailLaneManualPause). */
  lanePauseCheck?: typeof readMailLaneManualPause;
};

/**
 * [리뷰어 B HIGH 수리] 이 드레인 자신의 시간 예산. 워커 전체(timeoutSeconds:120,000ms) 중
 * 코호트2 드레인이 먼저 쓰는 몫은 가변이라 예약해 두지 않고, 이 드레인은 **워커 호출 시작
 * 시각 기준** 이 값을 넘기면 새 행을 시작하지 않는다 — 코호트2 가 오래 걸렸으면 그만큼 이
 * 드레인의 실제 가용 시간이 줄어드는 것이 맞는 동작이다(자기 몫을 넘어 코호트2 의 실행분까지
 * 잠식하지 않는다). 120,000 − 90,000 = 30,000ms(25%) 여유 — 최종 쓰기·함수 종료 오버헤드용.
 */
export const NUDGE_DRAIN_BUDGET_MS = 90_000;

export type DrainNudgeCohort13OutboxResult = {
  /** 이번 틱에서 집어든 행 수(캡에 막혀 건드리지 않은 행은 제외). */
  scanned: number;
  /** 실제로 발송(sent/delivered)된 행 수. */
  delivered: number;
  /** 레인캡 사전확인(clean-skip)에 막혀 이번 틱에 손대지 않은 행 수. status 는 "queued" 그대로라
   *  다음 틱이 자연스럽게 재시도한다 — 이게 이 레인의 백오프다(무한 재시도가 아니라 순연). */
  laneCapped: number;
  /** [헤세 2026-09-03] 레인 캡은 통과했지만 세 코호트 합산 상한에 막혀 이번 틱에 손대지 않은
   *  행 수. laneCapped 와 같은 원칙(클레임 전에 본다, "queued" 그대로 남아 다음 틱이 재평가). */
  totalCapped: number;
  /** 발송 직전 재검사(회신·지원)에 걸려 비소모 종결된 행 수. */
  stoppedBeforeSend: number;
  /** coldmailHistoryDocId 로 수신자를 못 찾아 종결한 행 수(정상 경로에서는 0 이어야 한다). */
  unresolvedRecipient: number;
  /** 발송을 시도했지만 sent/delivered 가 아닌(차단·전송실패 등) 행 수. */
  blocked: number;
  /** 동시 클레임 충돌 등으로 이 틱이 처리하지 못하고 건너뛴 행 수(정상 범위 내 — 다음 틱 재시도). */
  claimMissed: number;
  /** 항목 처리 중 예외가 나 그 행만 건너뛴 횟수(리뷰어 B: 한 항목 실패가 나머지 due 를 막지 않는다). */
  errored: number;
  /** stale "sending" 리클레임으로 "queued" 로 되돌린 행 수. */
  reclaimed: number;
  /** 마감(deadlineMs) 때문에 이번 틱이 배치를 다 처리하지 못하고 끊겼는가. */
  deadlineStopped: boolean;
  /**
   * W118: 독려 레인이 **수동 정지**여서 이번 패스가 due 조회조차 하지 않고 끝났는가.
   * 정지 중에는 행을 하나도 건드리지 않는다 — status 는 "queued" 그대로다.
   */
  lanePaused: boolean;
};

/**
 * W114-F — 코호트1·3 **드레인**. `scpApplicationVideoReminderMailWorker`(index.ts, `onSchedule`
 * "every 1 minutes", 기존 워커 — 새 스케줄 없음)가 코호트2 드레인 뒤에 이어서 부른다.
 *
 * 코호트2 드레인(scpOutboxMailWorkers.ts drainApplicationVideoReminderOutbox)과 달리
 * `defaultMailSendAdapter`(prepareScpResultMail 우회)를 쓰지 않는다 — `sendNudgeLiveForSweep` 을
 * **그대로** 재사용해 preview→apply 2단계·미치환 토큰 거부·suppression·레인 캡을 전부 원래
 * 계약대로 지난다. 이 함수가 하는 일은 그 호출을 "적재 시점"이 아니라 "이 틱"으로 옮기는 것뿐이다.
 *
 * [리뷰어 B HIGH 수리] 클레임(queued→sending)·stale 리클레임(15분 TTL)·항목별 try/catch·마감
 * 검사는 전부 코호트2 드레인이 이미 쓰는 패턴을 미러링한 것이다(새 패턴 발명 금지).
 */
export async function drainNudgeCohort13Outbox(
  options: DrainNudgeCohort13OutboxOptions = {},
): Promise<DrainNudgeCohort13OutboxResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const clock = options.clock ?? (() => Date.now());
  const deadlineMs = Number.isFinite(options.deadlineMs)
    ? Number(options.deadlineMs)
    : clock() + NUDGE_DRAIN_BUDGET_MS;
  const batchLimit = Math.min(Math.max(Math.trunc(options.batchLimit ?? 2), 1), 20);
  const sendAdapter = options.sendAdapter ?? sendNudgeLiveForSweep;
  const laneQuotaCheck = options.laneQuotaCheck ?? laneDailyQuotaAllows;
  const totalQuotaCheck = options.totalQuotaCheck ?? totalDailyQuotaAllows;
  const lanePauseCheck = options.lanePauseCheck ?? readMailLaneManualPause;
  const result: DrainNudgeCohort13OutboxResult = {
    scanned: 0, delivered: 0, laneCapped: 0, totalCapped: 0, stoppedBeforeSend: 0, unresolvedRecipient: 0,
    blocked: 0, claimMissed: 0, errored: 0, reclaimed: 0, deadlineStopped: false, lanePaused: false,
  };

  /**
   * W118 [프로드 사고 2026-09-03~05] — **레인 정지 사전확인(clean-skip).**
   *
   * 종전에는 정지 중에도 이 드레인이 매 틱 행을 집어 발송을 시도했고, 시도마다
   * `scp_mail_results` 문서 1건 + `mail_outbound_log` 차단 행 1건이 새로 생겼다
   * (2026-09-04 하루 2,773건, 시간당 ~118건). 나가지도 않는 메일이 원장을 채우고 리포트를
   * 부풀렸다. 정지는 "지금은 안 보낸다"이지 "시도 기록을 남긴다"가 아니다.
   *
   * 레인캡 clean-skip(W114-F)과 같은 원칙이되 축이 패스 단위다 — 정지는 행마다 달라지지 않으므로
   * **패스당 한 번** 읽고, 막히면 due 조회조차 하지 않는다. 강제 자체는 발송 경로
   * (`resolveOutboundSafetyBlock`)가 그대로 하므로 우회가 아니다. 행은 "queued" 그대로 남아
   * 정지가 풀린 틱에 자연스럽게 이어진다.
   */
  if (await lanePauseCheck("nudge")) {
    result.lanePaused = true;
    // 항목별 로그 금지 — 패스당 한 줄이다.
    console.info(JSON.stringify({ event: "w118_nudge_cohort13_outbox.lane_paused", lane: "nudge", nowIso }));
    return result;
  }

  // [리뷰어 B MEDIUM 수리] 이미 마감을 넘긴 상태로 이 드레인이 불렸으면(코호트2 드레인이 예산을
  //   전부 먹은 경우 등) 리클레임 스캔 자체를 아예 시작하지 않는다 — due 루프의 마감 검사와
  //   같은 원칙, 여기서는 호출 전체를 게이트한다(루프 내부 게이트는 스캔 도중 넘는 경우를 막는다).
  if (clock() < deadlineMs) {
    result.reclaimed = await reclaimStaleSendingNudgeOutboxRows(now, deadlineMs, clock);
  }

  const due = (await adminDb.collection(OUTREACH_QUEUE_COLLECTION)
    .where("source", "==", "w72_nudge_sweep")
    .where("status", "==", "queued")
    .orderBy("createdAtIso", "asc")
    .limit(batchLimit)
    .get()).docs;

  // [헤세 2026-09-03] 합산 상한은 코호트 무관 단일 값이라(레인 캡과 달리 코호트별로 갈리지 않는다)
  //   루프 밖에서 한 번만 읽는다 — due 가 비면 읽지 않는다(T1-4 와 같은 절약 원칙, 위 주석 참고).
  const totalDailyCap = due.length > 0 ? await readNudgeTotalDailyCap() : null;

  for (const doc of due) {
    // [리뷰어 B HIGH] 마감 검사 — 코호트2 드레인이 이 워커의 timeoutSeconds:120 예산을 이미 얼마나
    //   썼는지 모르므로, 이 드레인 자신은 절대 시각 기준으로 스스로 끊는다(690f2bb1 재발 방지).
    if (clock() >= deadlineMs) {
      result.deadlineStopped = true;
      break;
    }

    const row = doc.data() ?? {};
    const cohort = asString(row.cohort) as NudgeCohortKey;
    const sequence = Math.trunc(Number(row.sequence ?? 0));
    const templateKey = asString(row.templateKey);
    const mailPurpose = asString(row.mailPurpose) || NUDGE_COHORT_MAIL_PURPOSE[cohort];
    const conversationId = asString(row.conversationId);
    const coldmailHistoryDocId = asString(row.coldmailHistoryDocId);
    const programOverrideId = asString(row.programOverrideId);

    // W114-F: 레인캡 사전확인(clean-skip). 캡이 이미 찼으면 비싼 발송 왕복(preview+apply,
    //   16~21s)을 아예 태우지 않는다 — 강제 자체는 sendAdapter 내부의 reserveOutboundQuota
    //   트랜잭션이 하므로 우회가 아니다. 여기서 막히면 행은 "queued" 그대로 남아 다음 틱에
    //   재평가된다 — 이게 "캡에 걸리면 정상적으로 백오프한다"의 실제 동작이다. 클레임 **전**에
    //   본다 — 캡에 막힐 행까지 "sending" 으로 잠그면 아무 이유 없이 15분 리클레임을 기다리게 된다.
    const laneConfig = await readNudgeLaneQuotaConfig(cohort);
    const laneQuota = await laneQuotaCheck(mailPurpose, laneConfig.dailyCap, now);
    if (!laneQuota.allowed) {
      result.laneCapped += 1;
      continue;
    }
    // [헤세 2026-09-03] 레인 캡을 통과해도 세 코호트 합산 상한을 넘으면 보내지 않는다 — 같은
    //   원칙(클레임 **전**에 본다, 캡에 막히면 "queued" 그대로 남아 다음 틱이 재평가한다).
    // [2026-09-05 적대 리뷰 P2] `continue` → `break`. 합산 상한은 **코호트 무관 단일 축**이라
    //   한 행이 걸리면 이 패스의 남은 행도 전부 걸린다 — 계속 도는 것은 순수 낭비 읽기다
    //   (행마다 레인 캡 설정 + 캡 조회 왕복). 순서·유예 의미는 그대로다: 남은 행은 "queued" 로
    //   남아 다음 틱이 같은 `createdAtIso asc` 순서로 재평가한다.
    //   ⚠️ `totalCapped` 의 뜻이 "이 패스에서 캡에 막힌 행 수" → "이 패스가 캡에 막혀 멈췄다(1)"로
    //   바뀐다. 기아(starvation) 자체 — 캡이 매일 앞쪽 코호트에 먼저 소진되는 문제 — 는 여기서
    //   고치지 않는다(순서/배분 변경은 운영자 결정 사항이다).
    const totalQuota = await totalQuotaCheck(totalDailyCap, now);
    if (!totalQuota.allowed) {
      result.totalCapped += 1;
      break;
    }

    /**
     * W118 TOCTOU 수리 [2026-09-05 적대 리뷰 P2] — **클레임 직전 레인 정지 재확인.**
     *
     * 위 패스 사전확인과 이 행의 발송 사이에는 창이 있다(배치 최대 20행 × 발송 왕복 16~21s).
     * 그 창에 운영자가 스위치를 내려도 종전에는 남은 행이 전부 그대로 나갔다 — 운영자가 "껐는데
     * 계속 나간다"고 본 형상이다.
     *
     * **비소모**다: 클레임 **전**에 보므로 행은 `queued` 그대로 남고, 결과 원장
     * (`scp_mail_results`)·`mail_outbound_log` 에도 아무것도 안 찍힌다. 정지가 풀린 틱에 같은
     * 순서로 이어진다(순서·유예 의미 무변경).
     *
     * 비용: 행당 `mail_safety_state/outbound` 1 read(배치 상한 20 → 패스당 ≤20). 발송 1건이
     * 16~21s 인 경로에서 이 정도는 무시할 수 있고, 반대 방향 실패(정지 중 발송)의 대가가 훨씬 크다.
     */
    if (await lanePauseCheck("nudge")) {
      result.lanePaused = true;
      console.info(JSON.stringify({
        event: "w118_nudge_cohort13_outbox.lane_paused_mid_batch", lane: "nudge", nowIso,
      }));
      break;
    }

    // [리뷰어 B HIGH] 클레임 — 코호트2 드레인(scpOutboxMailWorkers.ts:2498)과 같은 트랜잭션
    //   패턴이다: "queued" 인 행만 "sending" 으로 옮기고, 그 사실을 트랜잭션으로 확정한다. 이
    //   워커는 concurrency:1 이라 같은 인스턴스 안에서 두 번 집힐 일은 없지만, 클레임 자체는
    //   "발송 시도를 시작했다"는 사실을 원장에 남기는 것이 목적이다 — 이 시점 이후 워커가
    //   죽으면 위 reclaimStaleSendingNudgeOutboxRows 가 15분 뒤에만 되살린다(무한 즉시 재시도 방지).
    const claimed = await adminDb.runTransaction(async (transaction) => {
      const fresh = await transaction.get(doc.ref);
      if (asString((fresh.data() ?? {}).status) !== "queued") return false;
      transaction.set(doc.ref, {
        status: "sending", updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return true;
    });
    if (!claimed) {
      result.claimMissed += 1;
      continue;
    }

    result.scanned += 1;

    // [리뷰어 B HIGH] 항목별 try/catch — 이 행 처리 중 예외(Firestore 일시 오류 등)가 나도
    //   나머지 due 행이 조용히 버려지면 안 된다. 클레임은 이미 됐으니 실패해도 "sending" 에
    //   머물다 stale 리클레임이 되살린다(상태를 잘못 덮어써 사실을 잃는 것보다 안전하다).
    try {
      const email = await resolveNudgeOutboxRecipientEmail(coldmailHistoryDocId);
      if (!email) {
        result.unresolvedRecipient += 1;
        await doc.ref.set({
          status: "blocked", blockedReason: "recipient_unresolved",
          updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        continue;
      }

      // 발송 직전 재검사 — 적재와 발송 사이에 (최대 배치 지연만큼의) 창이 생겼다. 그 사이
      //   회신하거나 지원한 사람에게 "아직 안 하셨네요"가 나가면 안 된다. 비소모 종결이다.
      const stop = await nudgeStopConditionBeforeSend({ email, conversationId });
      if (stop) {
        await recordNudgeStoppedBeforeSend({ cohort, sequence, email, reason: stop, nowIso });
        await doc.ref.set({
          status: "stopped_before_send", stopReason: stop,
          updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        result.stoppedBeforeSend += 1;
        continue;
      }

      const sent = await sendAdapter({
        email, runKey: doc.id, cohort, templateKey, mailPurpose, nowIso,
        // 0.6.110: 오버라이드 행만 귀속(캠페인 랜딩 링크)을 싣는다. 전역 행은 인자가 종전과 같다.
        ...(programOverrideId
          ? {
            programOverrideId,
            conversationId,
            campaignId: asString(row.campaignId),
            programId: asString(row.programId),
          }
          : {}),
      });
      await doc.ref.set({
        status: sent.status, resultRef: sent.resultRef,
        ...(sent.blockedReason ? { blockedReason: sent.blockedReason } : {}),
        updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      if (NUDGE_SENT_STATUSES.has(sent.status)) result.delivered += 1;
      else result.blocked += 1;
    } catch (error) {
      result.errored += 1;
      console.error(JSON.stringify({
        event: "w114_nudge_cohort13_outbox.item_failed",
        cohort, sequence,
        reason: String((error as { message?: unknown } | null)?.message ?? error).slice(0, 300),
      }));
    }
  }

  return result;
}

/**
 * 회신 정본 조회 — **conversationId** 로 대조한다(합동리뷰 P1-4).
 * `from` 은 프로드에서 마스킹(he***@)과 원문이 혼재해 raw email 비교가 회신자를 놓친다.
 * conversationId 는 발송 원장과 수신 원장 양쪽에 **같은 값**으로 존재하는 정확한 키다.
 */
async function repliedConversationIds(conversationIds: string[]): Promise<Set<string>> {
  const replied = new Set<string>();
  for (let offset = 0; offset < conversationIds.length; offset += 10) {
    const chunk = conversationIds.slice(offset, offset + 10);
    if (chunk.length === 0) continue;
    const snapshot = await adminDb.collection(MESSAGE_SOURCES_COLLECTION)
      .where("conversationId", "in", chunk)
      .where("direction", "==", "inbound")
      .select("conversationId", "receivedAtIso")
      .get();
    for (const doc of snapshot.docs) {
      const row = doc.data() ?? {};
      // W68-B: 회신은 `receivedAtIso` 가 있는 inbound 행이다. 존재만으로 세지 않는다.
      if (!asString(row.receivedAtIso)) continue;
      const conversationId = asString(row.conversationId);
      if (conversationId) replied.add(conversationId);
    }
  }
  return replied;
}

/** 오픈 정본 — 픽셀은 `mail_outbound_log` 만 올린다(합동리뷰 P1-4). trackingId 로 직접 조회한다. */
async function openedTrackingIds(trackingIds: string[]): Promise<Set<string>> {
  const opened = new Set<string>();
  for (let offset = 0; offset < trackingIds.length; offset += 100) {
    const chunk = trackingIds.slice(offset, offset + 100);
    if (chunk.length === 0) continue;
    const snapshots = await adminDb.getAll(
      ...chunk.map((id) => adminDb.collection(MAIL_OUTBOUND_LOG_COLLECTION).doc(id)),
    );
    for (const snapshot of snapshots) {
      if (!snapshot.exists) continue;
      const row = snapshot.data() ?? {};
      if (Math.trunc(Number(row.openCount ?? 0)) > 0 || asString(row.lastOpenedAtIso)) {
        opened.add(snapshot.id);
      }
    }
  }
  return opened;
}

/**
 * apply 정본 — **creatorId(이메일 파생) + channelId** 두 축으로 대조한다(합동리뷰 R2-4).
 *
 * ■ 왜 channelId 단독으로는 안 되는가 (프로드 실측)
 *   `scp_application_management` 의 identity 는 **93행 중 2행만** 채워져 있다
 *   (channelId·fluCreatorId·portalCreatorId·outreachId·enrollmentId 전부 2/93).
 *   W62-2 헤더가 기록한 "미제출 56건 중 54건이 신원 미해석"과 같은 사실이다.
 *   → channelId 만 쓰면 지원자의 ~98%가 제외되지 않는다.
 *
 * ■ 조밀한 축은 creatorId 다
 *   `program_applications.creatorId` 는 정본 writer 들이 `CR_${safeDocId(email)}` 로 만든다
 *   (functions/scpMail.ts:1518 · submissionTasks.ts:158 · scpProgramBridge.ts:877).
 *   그래서 콜드메일 수신자 이메일에서 **같은 규칙으로** 키를 유도해 대조할 수 있다.
 *   실측 표본 4행 중 3행이 이메일 파생 형태였다(`CR_nebuacc96-gmail-com` 등).
 *
 * ■ 1000개 제한 (R2-4)
 *   management 는 `submittedAtIso desc` 최신 1000건만 본다. 그 밖은 커버되지 않으므로
 *   **커버 범위를 결과에 실어** 호출부가 "전량 대조가 아니다"를 알 수 있게 한다.
 */
/**
 * W72 스펙 [헤세 2026-08-13] — 지원 대조용 이메일 정규화.
 *
 * **손실형 정규화를 하지 않는다.** 점 제거·플러스 태그 제거는 gmail 관례일 뿐
 * 도메인 일반의 규칙이 아니어서, `a.b@x.com` / `a-b@x.com` / `a+b@x.com` 을 뭉치면
 * 서로 다른 사람의 지원으로 독려가 멈추는 **오탐**이 된다(R6 권고).
 * 대소문자와 주변 공백만 없앤 exact 대조를 쓴다.
 */
export function normalizeApplyEmail(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function creatorIdFromEmail(email: string): string {
  // W72 합동리뷰 R3-3 / R4-P2: 규칙을 복사하지 않고 정본 helper 를 공유하되,
  //   **실제 writer 의 절단 길이까지 맞춘다.** creatorLinks.ts derivedCreatorId 는 64자로 자른다 —
  //   180자 흐름으로 두면 긴 이메일에서 exclusion ID 가 갈려 지원자가 제외되지 않는다.
  //   (R2-4 와 같은 종류의 사고가 "길이"라는 다른 축으로 재발하는 것이다.)
  return `CR_${safeDocId(email.trim().toLowerCase()).slice(0, 64) || "scp"}`;
}

async function appliedIdentityKeys(): Promise<{
  keys: Set<string>;
  managementScanned: number;
  managementCapped: boolean;
}> {
  const keys = new Set<string>();
  const MANAGEMENT_LIMIT = 1000;
  const [managed, program] = await Promise.all([
    adminDb.collection(APPLICATION_COLLECTION)
      .orderBy("submittedAtIso", "desc").limit(MANAGEMENT_LIMIT)
      .select("submittedAtIso", "identity", "email").get(),
    adminDb.collection(PROGRAM_APPLICATIONS_COLLECTION)
      // W72 합동리뷰 R5-P2: 최초 writer(programs.ts)는 creatorId/channelId 를 안 쓰고 **email 을 쓴다**.
      //   creatorId 만 보면 백필 전 신규 지원자가 제외되지 않는다 — email 축을 함께 읽어 닫는다.
      .select("submittedAtIso", "channelId", "creatorId", "email").get(),
  ]);
  for (const doc of managed.docs) {
    const row = doc.data() ?? {};
    if (!asString(row.submittedAtIso)) continue;
    const identity = asRecord(row.identity);
    for (const field of ["channelId", "fluCreatorId", "portalCreatorId"]) {
      const value = asString(identity[field]);
      if (value) keys.add(value);
    }
    // R6-P2: management 원장에 이메일이 실려 있으면 그 축도 쓴다(정규화 exact).
    const managedEmail = normalizeApplyEmail(asString(row.email) || asString(identity.email));
    if (managedEmail) {
      keys.add(managedEmail);
      keys.add(creatorIdFromEmail(managedEmail));
    }
  }
  for (const doc of program.docs) {
    const row = doc.data() ?? {};
    if (!asString(row.submittedAtIso)) continue;
    const channelId = asString(row.channelId);
    const creatorId = asString(row.creatorId);
    // R6-P2 [헤세 2026-08-13 "apply 하면 멈춤"]: 최초 writer(programs.ts)는 creatorId/channelId 를
    //   안 쓰고 **email 을 쓴다**. 파생 ID 축만 보면 그 지원자가 제외되지 않는다.
    //   정규화는 소문자·공백까지만 — 점/플러스를 지우면 남의 지원으로 멈추는 오탐이 된다.
    const email = normalizeApplyEmail(asString(row.email));
    if (channelId) keys.add(channelId);
    if (creatorId) keys.add(creatorId);
    if (email) {
      keys.add(email);
      keys.add(creatorIdFromEmail(email));
    }
  }
  return {
    keys,
    managementScanned: managed.size,
    managementCapped: managed.size >= MANAGEMENT_LIMIT,
  };
}

/** 영상 제출 정본 — currentRevisionSubmittedAtIso 가 있는 상태만 제출로 본다. */
async function submittedVideoKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  const snapshot = await adminDb.collection(VIDEO_STATE_COLLECTION)
    .select("applicationId", "enrollmentId", "currentRevisionSubmittedAtIso")
    .get();
  for (const doc of snapshot.docs) {
    const row = doc.data() ?? {};
    if (!asString(row.currentRevisionSubmittedAtIso)) continue;
    const applicationId = asString(row.applicationId);
    const enrollmentId = asString(row.enrollmentId);
    if (applicationId) keys.add(applicationId);
    if (enrollmentId) keys.add(enrollmentId);
  }
  return keys;
}

export type Cohort2Candidate = { applicationId: string; appliedAtIso: string };

/** 코호트2 대상: 영상 미제출 지원자. 자격의 나머지(확인메일 delivered 등)는 코어가 판정한다. */
async function cohort2Candidates(submitted: Set<string>, limit: number): Promise<Cohort2Candidate[]> {
  const snapshot = await adminDb.collection(APPLICATION_COLLECTION)
    .orderBy("submittedAtIso", "desc")
    .limit(limit)
    .get();
  const out: Cohort2Candidate[] = [];
  for (const doc of snapshot.docs) {
    const record = doc.data() ?? {};
    const identity = asRecord(record.identity);
    const applicationId = asString(identity.applicationId) || doc.id;
    const enrollmentId = asString(identity.enrollmentId);
    if (submitted.has(applicationId) || (enrollmentId && submitted.has(enrollmentId))) continue;
    // W114 수리②: 코어(enqueueVideoReminderForApplication)와 같은 필드(submittedAtIso)에서
    //   같은 값을 뽑는다 — 사전 필터의 쿨다운 게이트가 코어와 다른 입력을 보면 판정이 갈린다.
    out.push({ applicationId, appliedAtIso: asString(record.submittedAtIso) });
  }
  return out;
}

export type Cohort2PrefilterOutcome = "pass" | "cooldown" | "confirmation_not_delivered";

/**
 * W114 수리② [실측 근거는 위 NUDGE_SWEEP_COHORT2_BUDGET_MS 주석] — 코호트2 배치 사전 필터.
 *
 * 명백한 탈락자만 싸게 거른다. **최종 판정은 여전히 enqueueVideoReminderForApplication(정본)이
 * 한다** — 이 파일의 원칙(W72-C2: "판정은 정본 함수 하나가 한다")을 지키기 위해, 여기서는
 * max_reached·in_flight·sequence_attempts_exhausted 같은 아웃박스 집계 판정을 복제하지 않는다.
 *
 * 여기서 거르는 두 축은 코어와 **같은 축 · 같은 함수**를 배치로 재사용한 것뿐이다:
 *   · 확인 메일 delivered 여부 — 코어의 `confirmState !== "delivered"` 와 동일한 비교.
 *     confirmState 는 "이 applicationId 의 확인 메일 행 중 하나라도 delivered 인가"로 구하므로,
 *     여기서 없음으로 판정하면 코어가 어떤 행을 docs[0] 으로 집어도 delivered 일 수 없다
 *     (모든 행이 non-delivered 라는 뜻이므로) — 갈릴 여지가 없다.
 *   · 쿨다운 게이트 — 코어가 그대로 노출하는 순수 함수(videoReminderGateRemainingMs)를
 *     같은 입력(appliedAtIso·lastReminderAtIso·cadenceMs)으로 호출한다. 복제가 아니라 재사용이다.
 */
export async function cohort2PrefilterClassify(
  candidates: Cohort2Candidate[],
  cadenceMs: number,
  nowMs: number,
): Promise<Array<{ applicationId: string; outcome: Cohort2PrefilterOutcome }>> {
  const ids = candidates.map((candidate) => candidate.applicationId);
  const confirmStateByApplication = new Map<string, string>();
  for (let offset = 0; offset < ids.length; offset += 10) {
    const chunk = ids.slice(offset, offset + 10);
    if (chunk.length === 0) continue;
    const snapshot = await adminDb.collection(CONFIRM_OUTBOX_COLLECTION)
      .where("applicationId", "in", chunk)
      .select("applicationId", "deliveryState")
      .get();
    for (const doc of snapshot.docs) {
      const row = doc.data() ?? {};
      const key = asString(row.applicationId);
      if (!key) continue;
      const state = asString(row.deliveryState);
      // delivered 가 하나라도 있으면 delivered 다 — 재발송으로 행이 여럿일 수 있다.
      if (state === "delivered" || !confirmStateByApplication.has(key)) confirmStateByApplication.set(key, state);
    }
  }
  const lastReminderByApplication = new Map<string, string>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    if (chunk.length === 0) continue;
    const snapshots = await adminDb.getAll(
      ...chunk.map((id) => adminDb.collection(VIDEO_REMINDER_HISTORY_COLLECTION).doc(id)),
    );
    for (const snapshot of snapshots) {
      if (!snapshot.exists) continue;
      lastReminderByApplication.set(snapshot.id, asString((snapshot.data() ?? {}).lastReminderAtIso));
    }
  }

  return candidates.map(({ applicationId, appliedAtIso }) => {
    if (confirmStateByApplication.get(applicationId) !== "delivered") {
      return { applicationId, outcome: "confirmation_not_delivered" as const };
    }
    const remaining = videoReminderGateRemainingMs({
      lastReminderAtIso: lastReminderByApplication.get(applicationId) ?? "",
      appliedAtIso,
      nowMs,
      cooldownMs: cadenceMs,
    });
    return { applicationId, outcome: remaining > 0 ? ("cooldown" as const) : ("pass" as const) };
  });
}

/**
 * W72-C2 [헤세 지시 2026-08-13] — 코호트①③ **대상 판정의 단일 정본**.
 *
 * 스윕과 검수 화면이 **이 함수 하나만** 쓴다. 판정을 복제하면 화면이 보여주는 대상과
 * 실제로 나가는 대상이 갈리고, 그 갈라짐이 곧 오발송이다(리더 하드 룰).
 *
 * 부수효과가 없다 — 조회·계산만 한다. 발송 직전 재검사(회신/지원)는 여기 없다:
 * 그건 발송 순간의 축이라 화면에서 미리 판정하면 거짓 정보가 된다.
 */
export type NudgeCandidateVerdict =
  | {
    readonly state: "eligible";
    readonly sequence: number;
    readonly templateKey: string;
    /** 0.6.110: 이 문안을 고른 프로그램 오버라이드 ID(전역 매핑이면 빈 문자열). */
    readonly programOverrideId: string;
  }
  | { readonly state: "blocked"; readonly reason: NudgeCandidateBlockReason };

export type NudgeCandidateBlockReason =
  | "cohort_disabled"
  | "replied"
  | "applied"
  | "cooldown_coldmail"
  | "cooldown_last_nudge"
  | "max_reached"
  | "unmapped"
  /** W72E-R1 P1-3: 이 회차의 draft 가 이미 있어 재생성하지 않는다(회차 비소모). */
  | "draft_pending";

export type NudgeCandidateRow = {
  readonly cohort: NudgeCohortKey;
  readonly emailHash: string;
  readonly emailMasked: string;
  readonly channelId: string;
  readonly lastColdmailSentAtIso: string;
  readonly opened: boolean;
  readonly cadenceRemainingMs: number;
  readonly deliveredCount: number;
  readonly maxSends: number;
  readonly verdict: NudgeCandidateVerdict;
};

/**
 * W72F-R2 P1-6 — **코호트② 예고(읽기 전용).**
 *
 * 코호트②는 콜드메일 이력이 아니라 신청 원장에서 나오므로 `listNudgeCohortCandidates`
 * (①③ 전용)에 잡히지 않는다. 그래서 사전 점검이 ②를 통째로 빠뜨리고 "신규 0"을 보고했다.
 * 스윕과 **같은 후보 소스**(cohort2Candidates + submittedVideoKeys)를 쓰되 적재는 하지 않는다.
 */
export async function previewCohort2CandidateCount(limit = 500): Promise<number> {
  const submitted = await submittedVideoKeys();
  const candidates = await cohort2Candidates(submitted, Math.max(1, Math.trunc(limit)));
  return candidates.length;
}

/** SEC-P0-009: 화면에 이메일 원문을 싣지 않는다 — 기존 마스킹 관례와 같은 형상. */
export function maskNudgeEmail(email: string): string {
  const [local, domain] = String(email ?? "").split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

export function evaluateNudgeCandidate(input: {
  cohort: NudgeCohortKey;
  email: string;
  channelId: string;
  conversationId: string;
  sentAtIso: string;
  opened: boolean;
  nowMs: number;
  cadenceMs: number;
  config: NudgeSequenceConfig;
  replied: ReadonlySet<string>;
  appliedKeys: ReadonlySet<string>;
  deliveredForCohort: number;
  /**
   * W72E-R1 P1-3: 이미 draft 가 만들어져 있는가(회차와 별개).
   * draft 는 회차를 안 쓰지만, 이 값을 안 보면 draft 경로가 매 스윕 같은 사람에게
   * draft 를 다시 만든다 — 되돌림 스위치를 켜는 순간 재생성 루프가 된다.
   */
  draftedForCohort?: number;
  lastNudgeSentMs: number;
  /** 0.6.110: 콜드메일 이력의 귀속. 오버라이드 해석에만 쓴다(생략 = 전역 매핑). */
  campaignId?: string;
  programId?: string;
  /** 0.6.110 D: 다른 회차 버킷의 대기 행 수(전역 대기 배제). */
  otherBucketPending?: number;
}): NudgeCandidateRow {
  const maxSends = nudgeCohortCeilings()[input.cohort]?.maxSends ?? 0;
  const sentMs = Date.parse(input.sentAtIso);
  const coldRemaining = Number.isFinite(sentMs)
    ? Math.max(0, sentMs + input.cadenceMs - input.nowMs)
    : input.cadenceMs;
  const nudgeRemaining = input.lastNudgeSentMs > 0
    ? Math.max(0, input.lastNudgeSentMs + input.cadenceMs - input.nowMs)
    : 0;
  const base = {
    cohort: input.cohort,
    emailHash: nudgeEmailDigest(input.email),
    emailMasked: maskNudgeEmail(input.email),
    channelId: input.channelId,
    lastColdmailSentAtIso: input.sentAtIso,
    opened: input.opened,
    cadenceRemainingMs: Math.max(coldRemaining, nudgeRemaining),
    deliveredCount: input.deliveredForCohort,
    maxSends,
  } as const;
  const blocked = (reason: NudgeCandidateBlockReason): NudgeCandidateRow =>
    ({ ...base, verdict: { state: "blocked", reason } });

  if (!input.config.cohorts.get(input.cohort)) return blocked("cohort_disabled");
  if (input.conversationId && input.replied.has(input.conversationId)) return blocked("replied");
  const normalizedEmail = normalizeApplyEmail(input.email);
  const hasApplied = input.appliedKeys.has(creatorIdFromEmail(input.email))
    || (Boolean(normalizedEmail) && input.appliedKeys.has(normalizedEmail))
    || (Boolean(input.channelId) && input.appliedKeys.has(input.channelId));
  if (hasApplied) return blocked("applied");
  if (coldRemaining > 0) return blocked("cooldown_coldmail");
  if (nudgeRemaining > 0) return blocked("cooldown_last_nudge");
  if (input.deliveredForCohort >= maxSends) return blocked("max_reached");
  // P1-3: 이 회차의 draft 가 이미 있으면 다시 만들지 않는다(회차는 소모하지 않은 채 대기).
  if ((input.draftedForCohort ?? 0) > input.deliveredForCohort) return blocked("draft_pending");
  if ((input.otherBucketPending ?? 0) > 0) return blocked("draft_pending");
  const sequence = input.deliveredForCohort + 1;
  const programKeys = [asString(input.campaignId), asString(input.programId)].filter(Boolean);
  const templateKey = nudgeTemplateKeyForSequence(input.config, input.cohort, sequence, programKeys);
  if (!templateKey) return blocked("unmapped");
  const programOverrideId = nudgeProgramOverrideIdFor(input.config, input.cohort, programKeys);
  return { ...base, verdict: { state: "eligible", sequence, templateKey, programOverrideId } };
}

export async function runNudgeCohortSweep(
  options: NudgeCohortSweepOptions = {},
): Promise<NudgeCohortSweepResult> {
  const nowIso = asString(options.nowIso) || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const maxEnqueuePerRun = Math.max(0, Math.trunc(
    Number.isFinite(options.maxEnqueuePerRun) ? Number(options.maxEnqueuePerRun) : NUDGE_SWEEP_MAX_ENQUEUE_PER_RUN,
  ));
  const scanLimit = Math.max(1, Math.trunc(
    Number.isFinite(options.scanLimit) ? Number(options.scanLimit) : NUDGE_SWEEP_SCAN_LIMIT,
  ));
  const draftQueue = options.draftQueueAdapter ?? queueNudgeForCohort;

  const cohorts: Record<string, NudgeCohortSweepCounts> = {
    [NUDGE_COHORT1_KEY]: emptyCounts(),
    [NUDGE_COHORT2_KEY]: emptyCounts(),
    [NUDGE_COHORT3_KEY]: emptyCounts(),
  };
  const base: NudgeCohortSweepResult = {
    ok: true,
    nowIso,
    enabled: false,
    haltReason: "",
    maxEnqueuePerRun,
    budgetStopped: false,
    stopReason: "",
    cohort2BudgetStopped: false,
    freshRun: false,
    maxObservedSendMs: 0,
    applyExclusionCoverage: { managementScanned: 0, managementCapped: false },
    totalEnqueued: 0,
    cohorts,
    phases: {
      phaseCohort2Ms: 0,
      phaseHistoryQueryMs: 0,
      phaseExclusionBatchMs: 0,
      phaseRowLoopMs: 0,
      rowsScanned: 0,
      eligibleSeen: 0,
      stopConditionCalls: 0,
      stopConditionMs: 0,
      stopWriteCalls: 0,
      firstSendOffsetMs: 0,
      deadlineHeadroomMsAtCut: 0,
    },
    lanePaused: false,
  };

  /**
   * W118 [프로드 사고 2026-09-03~05 · 후속] — **레인 정지 사전확인(clean-skip).**
   *
   * 드레인만 막으면 누수가 절반만 멈춘다. 정지 중에도 이 스윕은 매시간 돌면서
   * `scp_coldmail_history` 400행 스캔 + 제외 배치 조인(submittedVideoKeys · cohort2Candidates ·
   * apply/management 대조)을 다 태우고, 그 결과를 `scp_outreach_queue` 에 적재했다 —
   * 2026-09-04 하루에 고유 sourceRef 2,773건이 그렇게 새로 생겼다. 나가지도 않을 대상을
   * 고르느라 쓰는 읽기가 이 패스 비용의 지배분이다.
   *
   * 그래서 **모든 읽기 앞에서** 본다(설정 조회보다도 먼저). 정지면 이 패스는 문서를 하나도
   * 쓰지 않고 후보를 한 건도 읽지 않는다 — 이 문서 1건 읽기가 패스 전체 비용이다.
   * 커서도 건드리지 않으므로 정지가 풀리면 멈춘 지점에서 그대로 이어진다.
   *
   * ⚠️ 정지 패스는 설정을 **읽지 않았으므로** `enabled` 는 false 로 남는다 — 그건 "설정이
   * 꺼졌다"가 아니라 "확인하지 않았다"는 뜻이다. 두 사실을 가르는 축은 `lanePaused` 와
   * `haltReason` 이다(설정 복구 vs 토글 재개 — 처방이 다르다).
   */
  const lanePauseCheck = options.lanePauseCheck ?? readMailLaneManualPause;
  if (await lanePauseCheck("nudge")) {
    // 항목별 로그 금지 — 패스당 한 줄이다.
    console.info(JSON.stringify({ event: "w118_nudge_cohort_sweep.lane_paused", lane: "nudge", nowIso }));
    return { ...base, lanePaused: true, haltReason: "nudge_lane_paused" };
  }

  const config: NudgeSequenceConfig = await readNudgeSequenceConfig();
  // fail-closed: 설정이 없으면 **아무것도 적재하지 않는다.** 스윕이 매핑을 지어내지 않는다.
  if (!config.enabled) return { ...base, haltReason: "nudge_sequence_disabled" };
  base.enabled = true;

  const clock = options.clock ?? (() => Date.now());
  const deadlineMs = Number.isFinite(options.deadlineMs)
    ? Number(options.deadlineMs)
    : clock() + NUDGE_SWEEP_BUDGET_MS;
  /** 이번 런에서 관측한 발송 1건 최대 소요. 첫 발송 전에는 SEED 로 판단한다. */
  let maxObservedSendMs = 0;
  // W114 [헤세 배정]: 148초 로그 공백(W75 완주 +54s → 첫 발송 +205s)을 여는 순수 계측.
  //   기존 clock() 만 쓰고 제어 흐름은 건드리지 않는다 — 전부 산술 연산(빼기·증가)뿐이라
  //   계측 실패로 스윕이 죽을 여지가 없다.
  const runStartMs = clock();
  let phaseCohort2Ms = 0;
  let phaseHistoryQueryMs = 0;
  let phaseExclusionBatchMs = 0;
  let phaseRowLoopMs = 0;
  let rowsScanned = 0;
  let eligibleSeen = 0;
  let stopConditionCalls = 0;
  let stopConditionMs = 0;
  let stopWriteCalls = 0;
  let firstSendOffsetMs = 0;
  let firstSendCaptured = false;
  let deadlineHeadroomMsAtCut = 0;
  let budgetStopped = false;
  // 내부 루프의 `const stopReason`(발송 전 멈춤 사유)과 다른 축이다 — 이름으로 구분한다.
  let sweepStopReason: "" | "time_budget" | "run_cap" = "";
  let cohort2BudgetStopped = false;
  let remaining = maxEnqueuePerRun;
  // 합동리뷰 R2-5: 페이지를 **다 처리한 뒤** 이 값으로 커서를 전진시킨다.
  let draftCursorAdvance: { sentAtIso: string; docId: string } | null = null;
  let nextRunsSinceRewind: number | null = null;
  let freshRunUsed = false;
  let sendsSinceFlush = 0;
  /** 커서 중간 저장. fresh 회차는 백로그 커서를 건드리지 않으므로 호출부가 걸러 준다. */
  const flushCursor = async (position: { sentAtIso: string; docId: string }) => {
    await adminDb.collection(SWEEP_RUNTIME_COLLECTION).doc(SWEEP_CURSOR_DOC_ID).set({
      cursorSentAtIso: position.sentAtIso,
      cursorDocId: position.docId,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  };
  // R3-3: apply 제외 커버 범위. 코호트1·3 을 안 돌면 0/false 그대로 나간다(측정 가능).
  let applyExclusionCoverage = { managementScanned: 0, managementCapped: false };

  // ── 코호트2: 기존 재촉 레인 확장 (실발송 라이브 · 레인캡 250 · 회차 매핑 경유)
  const cohort2StartMs = clock();
  const cohort2Config = config.cohorts.get(NUDGE_COHORT2_KEY);
  if (cohort2Config) {
    const counts = cohorts[NUDGE_COHORT2_KEY];
    const submitted = await submittedVideoKeys();
    const candidates = await cohort2Candidates(submitted, scanLimit);
    counts.scanned = candidates.length;
    // W114 수리①: 코호트2 전용 예산 상한(근거는 NUDGE_SWEEP_COHORT2_BUDGET_MS 주석) — 이
    //   블록이 스테이지 예산을 독점해 코호트1·3 이 0.5초만 받던 사고의 재발을 막는다.
    const cohort2DeadlineMs = Math.min(deadlineMs, cohort2StartMs + NUDGE_SWEEP_COHORT2_BUDGET_MS);
    // W114 수리②: 명백한 탈락자(확인메일 미전달·쿨다운)를 배치로 걸러 건당 왕복을 줄인다
    //   (근거는 cohort2PrefilterClassify 주석 — 최종 판정은 여전히 코어가 한다).
    const cohort2CadenceMs = cohort2Config.cadenceDays * 24 * 60 * 60 * 1000;
    const classified = await cohort2PrefilterClassify(candidates, cohort2CadenceMs, nowMs);
    for (const item of classified) {
      // 사전 필터가 이미 코어와 같은 결론에 도달한 두 사유는 왕복 없이 그대로 센다
      //   (기존 switch 의 "cooldown"/미매핑 외 default 사유 집계와 같은 의미로 맞춘다).
      if (item.outcome === "confirmation_not_delivered") { counts.skippedIneligible += 1; continue; }
      if (item.outcome === "cooldown") { counts.skippedCooldown += 1; counts.eligible += 1; continue; }
      const applicationId = item.applicationId;
      if (remaining <= 0) { counts.skippedRunCap += 1; continue; }
      // W114 수리①: 코호트2 자체 상한 — 코호트1·3 몫을 넘보기 전에 먼저 끊는다.
      if (clock() >= cohort2DeadlineMs) {
        counts.skippedRunCap += 1;
        budgetStopped = true;
        // W114 [리뷰 MEDIUM]: 코호트2 **자기 몫 소진**과 스윕 **전체 예산 소진**은 처방이 다르다.
        //   같은 "time_budget" 으로 뭉개면 진단이 흐려진다. 사유를 갈라 읽게 한다.
        // 2026-08-29 정정: 그 분리를 `stopReason` **안에서** 하면 안 된다 — 코호트2 상한은 스윕을
        //   끝내지 않는데(코호트1·3 은 계속 돈다) 종료 사유 칸을 선점해, 정상 완주한 런까지
        //   "코호트2 때문에 멈춤"으로 읽혔다. 별도 축으로 싣는다.
        cohort2BudgetStopped = true;
        deadlineHeadroomMsAtCut = deadlineMs - clock();
        break;
      }
      // W113 [적대 게이트 P2]: 코호트2 는 outbox 적재라 개당 싸지만 상한까지 돌면 최악 ~60s 가
      //   **코호트1·3 의 예산을 잠식한다**(같은 런, 같은 마감). 종전에는 이 루프에만 마감이 없어
      //   190s 산정이 그 잠식분을 감안하지 않은 값이었다. 같은 마감으로 여기서도 끊는다.
      if (clock() >= deadlineMs) {
        counts.skippedRunCap += 1;
        budgetStopped = true;
        sweepStopReason = sweepStopReason || "time_budget";
        deadlineHeadroomMsAtCut = deadlineMs - clock();
        break;
      }
      const result = await enqueueVideoReminderForApplication({
        applicationId,
        // 스윕은 사람이 아니다. 감사에서 사람 클릭과 구분되어야 한다.
        actorUserId: "system:w72-nudge-sweep",
        nowMs,
        submittedKeys: submitted,
      });
      switch (result.outcome) {
        case "queued":
          counts.enqueued += 1;
          counts.eligible += 1;
          remaining -= 1;
          break;
        case "cooldown": counts.skippedCooldown += 1; counts.eligible += 1; break;
        case "in_flight": counts.skippedInFlight += 1; counts.eligible += 1; break;
        case "max_reached": counts.skippedMaxReached += 1; counts.eligible += 1; break;
        // 리더 요구: 미설정 회차 대상자는 **적재 전 차단 사유로 센다**.
        case "unmapped": counts.skippedUnmapped += 1; counts.eligible += 1; break;
        default: counts.skippedIneligible += 1; break;
      }
    }
  }
  phaseCohort2Ms = clock() - cohort2StartMs;

  // ── 코호트1·3: 발송 원장에서 오픈 여부로 가르고 **초안만** 큐잉한다
  const wantsCohort1 = Boolean(config.cohorts.get(NUDGE_COHORT1_KEY));
  const wantsCohort3 = Boolean(config.cohorts.get(NUDGE_COHORT3_KEY));
  if (wantsCohort1 || wantsCohort3) {
    // 합동리뷰 P1-5 / R2-5: 커서로 이어 훑는다. 끝에 닿으면 되감아 다음 주기에 다시 돈다.
    //   R2-5: 커서가 `sentAtIso` 단일값이면 **같은 시각 문서가 경계에서 스킵**된다(콜드메일은
    //   배치 발송이라 동시각이 흔하다). 문서 ID 타이브레이커를 붙이고 orderBy 에도 __name__ 을
    //   명시해 커서가 항상 유일한 지점을 가리키게 한다.
    const cursorRef = adminDb.collection(SWEEP_RUNTIME_COLLECTION).doc(SWEEP_CURSOR_DOC_ID);
    const cursorSnapshot = await cursorRef.get();
    const cursorSentAtIso = asString(cursorSnapshot.data()?.cursorSentAtIso);
    const cursorDocId = asString(cursorSnapshot.data()?.cursorDocId);
    // W113: N 런마다 한 번은 커서를 무시하고 최신부터 훑는다(신규 유입 기아 방지).
    //   이 런은 커서를 전진시키지 않는다 — 백로그 진행도를 덮어쓰면 되감기가 곧 진행도 손실이다.
    const runsSinceRewind = Math.max(0, Math.trunc(
      Number(cursorSnapshot.data()?.runsSinceRewind ?? 0),
    ));
    // 적대 리뷰 [MEDIUM]: `>= EVERY` 는 0 에서 4 까지 **네 번 증가**해야 하므로 실제 주기가 5 였다
    //   (fresh 회차 5·10·15…). 이름(SCAN_EVERY=4)과 동작이 달랐다. 이번 런을 포함해 센다.
    const freshRun = runsSinceRewind + 1 >= NUDGE_SWEEP_FRESH_SCAN_EVERY;
    const historyQueryStartMs = clock();
    // W114 수리③: 백필 source(NUDGE_COLDMAIL_SOURCES 주석 참고)도 스캔에 포함한다.
    const baseQuery = adminDb.collection(COLDMAIL_HISTORY_COLLECTION)
      .where("source", "in", NUDGE_COLDMAIL_SOURCES)
      .orderBy("sentAtIso", "desc")
      .orderBy(FieldPath.documentId(), "desc");
    let history = await (!freshRun && cursorSentAtIso && cursorDocId
      ? baseQuery.startAfter(cursorSentAtIso, cursorDocId)
      : baseQuery).limit(scanLimit).get();
    if (history.empty && !freshRun && cursorSentAtIso) {
      // 끝까지 훑었다 — 되감아서 다시 최신부터 본다(정지하면 신규 유입이 영원히 안 잡힌다).
      history = await baseQuery.limit(scanLimit).get();
    }
    phaseHistoryQueryMs = clock() - historyQueryStartMs;
    // R2-5: 커서 전진은 **페이지를 다 처리한 뒤**에 한다(아래). 조회 직후 올리면 그 페이지에서
    //   예외가 났을 때 다음 주기가 건너뛰어 그 구간이 영원히 처리되지 않는다.
    const lastDoc = history.docs[history.docs.length - 1];
    const rows = history.docs.map((doc) => {
      const row = doc.data() ?? {};
      const conversationId = asString(row.conversationId);
      return {
        // W113: 커서를 **처리한 prefix 까지** 부분 전진시키려면 행마다 자기 위치를 알아야 한다.
        //   종전에는 페이지 마지막 doc 하나만 들고 있어서, 중간에서 끊기면 전진이 통째로 없었다.
        docId: doc.id,
        email: asString(row.emailLower) || asString(row.email).trim().toLowerCase(),
        sentAtIso: asString(row.sentAtIso),
        conversationId,
        trackingId: asString(row.trackingId),
        // 0.6.110: 콜드메일 이력에 이미 기록된 귀속(실측: campaignId·canonicalProgramId 항상 채워짐).
        campaignId: asString(row.campaignId) || asString(row.campaign),
        programId: asString(row.canonicalProgramId) || asString(row.programId),
        // 상관키는 conversationId 접미사의 channelId 다(`campaign-<campaignId>-<channelId>`).
        //   지원 원장 두 곳이 전부 channelId 로만 식별되므로 이 축이 유일한 교집합이다.
        channelId: /(UC[A-Za-z0-9_-]{20,})$/.exec(conversationId)?.[1] ?? "",
      };
    }).filter((row) => row.email && row.sentAtIso);

    const conversationIds = [...new Set(rows.map((row) => row.conversationId).filter(Boolean))];
    const trackingIds = [...new Set(rows.map((row) => row.trackingId).filter(Boolean))];
    // (4) 다회차: 수신자별 이력을 배치로 한 번만 읽는다(회차·마지막 수신 시각).
    const emailDigests = [...new Set(rows.map((row) => nudgeEmailDigest(row.email)))];
    const exclusionBatchStartMs = clock();
    const [replied, applied, opened, nudgeHistory, candidateCadenceOverrides] = await Promise.all([
      repliedConversationIds(conversationIds),
      appliedIdentityKeys(),
      openedTrackingIds(trackingIds),
      readNudgeHistory(emailDigests),
      // Task-44: 후보 오버라이드 순수 가산 조회(문서 없으면 빈 Map — 아래 cadenceMs 계산이
      //   기존 cadenceMsByCohort 값 그대로 쓴다).
      readCandidateNudgeCadenceOverrides(adminDb as unknown as CandidateNudgeCadenceOverrideDb, emailDigests),
    ]);
    phaseExclusionBatchMs = clock() - exclusionBatchStartMs;

    applyExclusionCoverage = {
      managementScanned: applied.managementScanned,
      managementCapped: applied.managementCapped,
    };

    // W72 마감리뷰 P0-2: 종전에는 NUDGE_DRAFT_ONLY_COHORTS 를 순회했는데, B2 에서 그 배열을
    //   비우면서 **코호트1·3 의 cadence 가 통째로 0** 이 됐다(맵이 비어 아래 폴백 0 이 걸린다).
    //   콜드메일 직후 즉시 대상 + 전이 쿨다운 부재 — mode 를 고치는 순간 폭송이 되는 조합이었다.
    //   cadence 는 draft/live 와 무관한 축이므로 **설정에 있는 모든 코호트**를 순회한다(Task-44
    //   적대 리뷰 MED-HIGH-2: 이 계산은 resolveCohortCadenceMsMap 하나로 합쳤다 — candidateTable.ts
    //   listCandidates도 같은 함수를 쓴다).
    const cadenceMsByCohort = resolveCohortCadenceMsMap(config);

    const seen = new Set<string>();
    // W113: "처리 완료된 마지막 행". 반복 초입에서 **직전 행**을 승격시킨다 — 이번 행에서 끊기면
    //   이번 행은 승격되지 않아 다음 런이 정확히 여기서 이어받는다(건너뛰기 없음).
    let lastResolved: { sentAtIso: string; docId: string } | null = null;
    let pending: { sentAtIso: string; docId: string } | null = null;
    // W114: 코호트2 가 이미 예산을 끊었는지 스냅샷 — 아래에서 "이 행 루프 자신이 새로 끊었는가"를
    //   가른다. run_cap 줄은 다른 pin 테스트가 원문 그대로를 요구해 그 줄 안에는 아무것도 못 넣는다.
    const budgetStoppedBeforeRowLoop = budgetStopped;
    const rowLoopStartMs = clock();
    for (const row of rows) {
      rowsScanned += 1;
      if (pending) lastResolved = pending;
      pending = { sentAtIso: row.sentAtIso, docId: row.docId };
      if (seen.has(row.email)) continue;
      seen.add(row.email);
      // 오픈 여부가 코호트1 과 3 을 가른다 — 같은 사람이 둘 다일 수는 없다.
      //   판정 정본은 mail_outbound_log 다(P1-4: coldmail_history.openCount 는 프로드에서 전부 0).
      const cohort: NudgeCohortKey = opened.has(row.trackingId) ? NUDGE_COHORT1_KEY : NUDGE_COHORT3_KEY;
      const counts = cohorts[cohort];
      counts.scanned += 1;

      // W72-C2: 판정은 **정본 함수 하나**가 한다. 여기서 조건을 다시 쓰면 화면과 갈라진다.
      const digest = nudgeEmailDigest(row.email);
      const nudgeRow = nudgeHistory.get(digest);
      // 0.6.110 D: 회차 집계는 이 수신자에게 적용되는 오버라이드 버킷 기준(없으면 전역 버킷).
      const rowBucket = nudgeBucketKey(cohort, nudgeProgramOverrideIdFor(
        config, cohort, [row.campaignId, row.programId].filter(Boolean),
      ));
      const candidate = evaluateNudgeCandidate({
        cohort,
        email: row.email,
        channelId: row.channelId,
        conversationId: row.conversationId,
        sentAtIso: row.sentAtIso,
        opened: opened.has(row.trackingId),
        nowMs,
        // Task-44: 후보 주기 오버라이드가 있으면 코호트 cadence 대신 그 값을 쓴다(1순위).
        //   없으면(Map.get()===undefined) 기존 cadenceMsByCohort 그대로 — 회귀 0.
        cadenceMs: resolveEffectiveCadenceMs(candidateCadenceOverrides.get(digest), cadenceMsByCohort.get(cohort) ?? 0),
        config,
        replied,
        appliedKeys: applied.keys,
        deliveredForCohort: nudgeRow?.deliveredByCohort.get(rowBucket) ?? 0,
        draftedForCohort: nudgeRow?.draftedByCohort.get(rowBucket) ?? 0,
        otherBucketPending: pendingInOtherBuckets(nudgeRow?.draftedByCohort, cohort, rowBucket),
        lastNudgeSentMs: nudgeRow?.lastSentMs ?? 0,
        campaignId: row.campaignId,
        programId: row.programId,
      });
      if (candidate.verdict.state === "blocked") {
        switch (candidate.verdict.reason) {
          case "cooldown_coldmail":
          case "cooldown_last_nudge": counts.skippedCooldown += 1; break;
          case "max_reached": counts.skippedMaxReached += 1; break;
          case "unmapped": counts.skippedUnmapped += 1; break;
          default: counts.skippedIneligible += 1; break;
        }
        continue;
      }
      counts.eligible += 1;
      eligibleSeen += 1;
      const nextSequence = candidate.verdict.sequence;
      const templateKey = candidate.verdict.templateKey;
      const programOverrideId = candidate.verdict.programOverrideId;
      if ((config.cohorts.get(cohort)?.sequence.size ?? 0) > 1) {
        counts.eligibleWithUnsupportedSequences += 0;
      }

      // W72 마감리뷰 P2-6: 멈춤은 **적재가 아니다** — 실행 예산도 enqueued 도 쓰지 않는다.
      //   종전에는 어댑터 안에서 멈춰도 성공으로 세어 지표가 오염되고 뒤쪽 정상 대상이 굶었다.
      const stopCheckStartMs = clock();
      const stopReason = await nudgeStopConditionBeforeSend({
        email: row.email,
        conversationId: row.conversationId,
      });
      stopConditionMs += clock() - stopCheckStartMs;
      stopConditionCalls += 1;
      if (stopReason) {
        await recordNudgeStoppedBeforeSend({
          cohort, sequence: nextSequence, email: row.email, reason: stopReason, nowIso,
        });
        stopWriteCalls += 1;
        counts.skippedIneligible += 1;
        continue;
      }
      // W113: 건수 상한에 닿으면 **멈춘다**(종전 continue). continue 면 남은 적격자를 건너뛴 채
      //   커서가 페이지 끝까지 전진해, 그 사람들은 되감기 전까지 다시 안 잡혔다.
      if (remaining <= 0) { counts.skippedRunCap += 1; budgetStopped = true; sweepStopReason = "run_cap"; break; }
      // W113: 시간 예산. 발송 1건이 남은 예산 안에 들어갈 때만 시작한다. 관측이 쌓이면 그 값을 쓴다
      //   — W114 정정: 타임아웃 경계 전 국면에서는 계속 보내고, 경계 후(스로틀) 국면에서는
      //   한 건 물고 즉시 멈춘다(빠른/느린 "체제"가 아니다 — 위 NUDGE_SWEEP_BUDGET_MS 참고).
      const estimateMs = Math.max(NUDGE_SWEEP_SEND_ESTIMATE_SEED_MS, maxObservedSendMs);
      if (clock() + estimateMs > deadlineMs) {
        counts.skippedRunCap += 1;
        budgetStopped = true;
        sweepStopReason = "time_budget";
        break;
      }
      try {
        const sendStartedMs = clock();
        if (!firstSendCaptured) {
          firstSendOffsetMs = sendStartedMs - runStartMs;
          firstSendCaptured = true;
        }
        const outcome = await draftQueue({
          cohort, email: row.email, templateKey, sequence: nextSequence, nowIso,
          conversationId: row.conversationId,
          // W114-F: 드레인이 나중에 scp_coldmail_history 를 다시 읽어 수신자를 해석할 참조.
          coldmailHistoryDocId: row.docId,
          ...(programOverrideId
            ? { campaignId: row.campaignId, programId: row.programId, programOverrideId }
            : {}),
        });
        maxObservedSendMs = Math.max(maxObservedSendMs, clock() - sendStartedMs);
        // W72E-R1 P1-1: **실제 발송/생성된 건만** enqueued·예산을 쓴다.
        //   잔재 64건이 캡 50을 다 먹어 재개 첫 사이클에 신규 대상이 굶던 축이다.
        if (outcome.consumed) {
          counts.enqueued += 1;
          remaining -= 1;
          // 이 행은 방금 완결됐다 — 중간 저장의 기준점은 **직전까지**가 아니라 여기다.
          sendsSinceFlush += 1;
          if (!freshRun && sendsSinceFlush >= NUDGE_SWEEP_CURSOR_FLUSH_EVERY) {
            await flushCursor({ sentAtIso: row.sentAtIso, docId: row.docId });
            sendsSinceFlush = 0;
          }
        } else {
          counts.skippedIneligible += 1;
        }
      } catch (error) {
        // W72E-R1 P1-2: 큐 쓰기가 `create` → `set(merge)` 로 바뀌면서 **already-exists 는
        //   더 이상 나오지 않는다**(잔재 행이 있어도 갱신으로 성공한다).
        //   종전 주석("이미 큐에 있으면 정상 스킵")은 죽은 설명이었고, skippedInFlight 도
        //   이 경로에서는 영영 증가하지 않는다 — 그 카운터를 여기서 쓰지 않는다.
        //   이제 여기 오는 것은 **진짜 쓰기 실패**뿐이다(권한·네트워크·트랜잭션 충돌 등).
        counts.skippedQueueError += 1;
        console.error(JSON.stringify({
          event: "w72_nudge_sweep.queue_write_failed",
          cohort,
          sequence: nextSequence,
          reason: String((error as { message?: unknown } | null)?.message ?? error).slice(0, 200),
        }));
      }
    }
    const rowLoopEndMs = clock();
    phaseRowLoopMs = rowLoopEndMs - rowLoopStartMs;
    // W114: 코호트2 가 이미 끊어 놓은 상태를 이 값으로 덮지 않는다 — 이 행 루프가 **새로** 끊었을
    //   때만 여기서 헤드룸을 잰다(run_cap 판정 줄 자체는 pin 테스트가 원문을 요구해 손댈 수 없다).
    if (budgetStopped && !budgetStoppedBeforeRowLoop) {
      deadlineHeadroomMsAtCut = deadlineMs - rowLoopEndMs;
    }
    // W113: 전진 지점을 **실제로 처리한 곳**으로 정한다.
    //   - 끝까지 처리했으면 페이지 마지막 doc(종전과 동일 — 되감기 판정이 이 위치에 걸려 있다).
    //   - 예산/상한으로 끊었으면 **처리 완료한 마지막 행**까지만. 그래야 다음 런이 이어받고,
    //     동시에 종전의 all-or-nothing(=전진 0) 동결이 사라진다.
    //   W114 [리뷰 HIGH]: 판정 축은 `budgetStopped`(스윕 전역)가 아니라 **이 행 루프가 끊겼는가**다.
    //     코호트2 캡이 먼저 켜면 전역 플래그가 이미 true 라, 코호트1·3 이 페이지를 **정상 완주**해도
    //     아래 부분 전진 분기로 새서 커서가 마지막 행이 아니라 그 **직전** 행을 가리켰다
    //     (lastResolved 는 구조상 항상 한 행 뒤처진다 — 다음 반복 초입에서야 승격되기 때문).
    //     에뮬레이터 재현: 코호트3 이 5/5 를 적재했는데 커서는 index 3. 캡이 여유를 두고 발동하도록
    //     설계했으므로 이 조합은 드문 사고가 아니라 **상시**다. 위 헤드룸 계산과 같은 축을 쓴다.
    const rowLoopCutShort = budgetStopped && !budgetStoppedBeforeRowLoop;
    if (!rowLoopCutShort) {
      if (pending) lastResolved = pending;
      if (lastDoc) {
        draftCursorAdvance = { sentAtIso: asString(lastDoc.data()?.sentAtIso), docId: lastDoc.id };
      }
    } else if (lastResolved) {
      draftCursorAdvance = { sentAtIso: lastResolved.sentAtIso, docId: lastResolved.docId };
    }
    // fresh run 은 최신부터 훑은 것이라 이 위치를 백로그 커서로 쓰면 진행도가 날아간다.
    if (freshRun) draftCursorAdvance = null;
    freshRunUsed = freshRun;
    nextRunsSinceRewind = freshRun ? 0 : runsSinceRewind + 1;
  }

  // 합동리뷰 R2-5 / W113: 커서 전진은 여기서. 종전에는 **페이지를 다 처리했을 때만** 여기 도달해
  //   타임아웃 킬이 곧 영구 동결이었다. 이제 부분 전진이라 끊겨도 진행도가 남는다.
  //   runsSinceRewind 는 전진이 없는 fresh run 에서도 갱신해야 주기가 흐른다.
  if (draftCursorAdvance || nextRunsSinceRewind !== null) {
    await adminDb.collection(SWEEP_RUNTIME_COLLECTION).doc(SWEEP_CURSOR_DOC_ID).set({
      ...(draftCursorAdvance
        ? { cursorSentAtIso: draftCursorAdvance.sentAtIso, cursorDocId: draftCursorAdvance.docId }
        : {}),
      ...(nextRunsSinceRewind !== null ? { runsSinceRewind: nextRunsSinceRewind } : {}),
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  const totalEnqueued = Object.values(cohorts).reduce((sum, counts) => sum + counts.enqueued, 0);
  return {
    ...base, enabled: true, totalEnqueued, cohorts, applyExclusionCoverage,
    budgetStopped, stopReason: sweepStopReason, cohort2BudgetStopped, freshRun: freshRunUsed, maxObservedSendMs,
    phases: {
      phaseCohort2Ms,
      phaseHistoryQueryMs,
      phaseExclusionBatchMs,
      phaseRowLoopMs,
      rowsScanned,
      eligibleSeen,
      stopConditionCalls,
      stopConditionMs,
      stopWriteCalls,
      firstSendOffsetMs,
      deadlineHeadroomMsAtCut,
    },
  };
}

/** 미설정 회차 스킵 사유 코드 — 드레인과 같은 정본 상수를 쓴다(측정이 갈리지 않게). */
export const NUDGE_SWEEP_UNMAPPED_REASON = NUDGE_TEMPLATE_UNMAPPED_REASON;

/**
 * W72-C2 [헤세 지시 2026-08-13] — 검수 탭 코호트①③ **리스트업(읽기 전용)**.
 *
 * 스윕과 **같은 정본 함수**(`evaluateNudgeCandidate`)로 판정한다 — 복제 0.
 * 건수도 여기서 계산한 값만 돌려준다(화면 재계산 금지).
 *
 * ■ infly 예외 효과를 화면에서 바로 본다
 *   헤세 결정으로 코호트①③ 은 `mail-safety.infly-overlap` 의 예외다. 그 효과를 눈으로
 *   확인할 수 있게 suppression 을 **규칙별로 갈라서** 센다:
 *     · inflyOverlapSuppressed  — 예외가 없었다면 막혔을 수(= 이번 결정으로 열린 수)
 *     · otherSuppressed         — 예외와 무관하게 여전히 막히는 수(수신거부·반송·불만 등)
 *
 * ■ SEC-P0-009: 이메일 원문을 싣지 않는다(마스킹 + 해시만).
 */
export type NudgeCohortListPage = {
  ok: true;
  nowIso: string;
  rows: NudgeCandidateRow[];
  counts: {
    scanned: number;
    eligible: number;
    blocked: Record<string, number>;
    inflyOverlapSuppressed: number;
    otherSuppressed: number;
  };
  nextCursor: { sentAtIso: string; docId: string } | null;
};

export async function listNudgeCohortCandidates(options: {
  limit?: number;
  cursor?: { sentAtIso: string; docId: string } | null;
  nowIso?: string;
  /**
   * W72F-R2 P1-6: **재개 전 예고용 가정.**
   * 사전 점검은 `enabled=false` 상태(=재개 직전)에서 도는 것이 전제인데, 그대로 판정하면
   * 모든 후보가 `cohort_disabled` 로 떨어져 신규 예고가 항상 0 이 된다 — 도구가 무의미해진다.
   * 이 값이 참이면 "지금 켜면 어떻게 되는가"를 기준으로 판정한다(읽기 전용 · 저장 없음).
   */
  assumeEnabled?: boolean;
} = {}): Promise<NudgeCohortListPage> {
  const nowIso = asString(options.nowIso) || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  // P1-6: 상한을 200 으로 고정하면 그 너머 후보가 예고에서 통째로 빠진다.
  const limit = Math.min(500, Math.max(1, Math.trunc(Number(options.limit ?? 50))));
  // P1-6: 오버라이드는 **파싱 입력**에서 걸어야 한다 — 읽은 뒤 enabled 만 덮으면
  //   파서가 이미 코호트를 버린 뒤(fail-closed)라 매핑이 빈 Map 이고 예고가 그대로 0 이 된다.
  const config = await readNudgeSequenceConfig(
    options.assumeEnabled ? { assumeEnabled: true } : {},
  );

  // 스윕과 같은 커서 패턴(정렬 + __name__ 타이브레이커)을 그대로 쓴다.
  // W114 수리③: 화면 예고도 스윕과 같은 source 집합을 봐야 한다 — 갈리면 화면·실제가 어긋난다.
  const baseQuery = adminDb.collection(COLDMAIL_HISTORY_COLLECTION)
    .where("source", "in", NUDGE_COLDMAIL_SOURCES)
    .orderBy("sentAtIso", "desc")
    .orderBy(FieldPath.documentId(), "desc");
  const cursor = options.cursor;
  const snapshot = await (cursor?.sentAtIso && cursor?.docId
    ? baseQuery.startAfter(cursor.sentAtIso, cursor.docId)
    : baseQuery).limit(limit).get();

  const rows = snapshot.docs.map((doc) => {
    const row = doc.data() ?? {};
    const conversationId = asString(row.conversationId);
    return {
      email: asString(row.emailLower) || asString(row.email).trim().toLowerCase(),
      sentAtIso: asString(row.sentAtIso),
      conversationId,
      trackingId: asString(row.trackingId),
      campaignId: asString(row.campaignId) || asString(row.campaign),
      programId: asString(row.canonicalProgramId) || asString(row.programId),
      channelId: /(UC[A-Za-z0-9_-]{20,})$/.exec(conversationId)?.[1] ?? "",
    };
  }).filter((row) => row.email && row.sentAtIso);

  const listEmailDigests = [...new Set(rows.map((r) => nudgeEmailDigest(r.email)))];
  const [replied, applied, opened, nudgeHistory, candidateCadenceOverrides] = await Promise.all([
    repliedConversationIds([...new Set(rows.map((r) => r.conversationId).filter(Boolean))]),
    appliedIdentityKeys(),
    openedTrackingIds([...new Set(rows.map((r) => r.trackingId).filter(Boolean))]),
    readNudgeHistory(listEmailDigests),
    // Task-44: 판정 정본(evaluateNudgeCandidate)이 하나이듯, 이 예고 표면도 실제 스윕과 같은
    //   오버라이드 조회를 써야 화면과 스윕이 갈라지지 않는다(W72-C2 doctrine).
    readCandidateNudgeCadenceOverrides(adminDb as unknown as CandidateNudgeCadenceOverrideDb, listEmailDigests),
  ]);

  // Task-44 적대 리뷰 MED-HIGH-2: runNudgeCohortSweep과 같은 resolveCohortCadenceMsMap — 로직 복제 금지.
  const cadenceMsByCohort = resolveCohortCadenceMsMap(config);

  const out: NudgeCandidateRow[] = [];
  const blocked: Record<string, number> = {};
  const seen = new Set<string>();
  let eligible = 0;
  for (const row of rows) {
    if (seen.has(row.email)) continue;
    seen.add(row.email);
    const cohort: NudgeCohortKey = opened.has(row.trackingId) ? NUDGE_COHORT1_KEY : NUDGE_COHORT3_KEY;
    const digest = nudgeEmailDigest(row.email);
    const entry = nudgeHistory.get(digest);
    const rowBucket = nudgeBucketKey(cohort, nudgeProgramOverrideIdFor(
      config, cohort, [row.campaignId, row.programId].filter(Boolean),
    ));
    const candidate = evaluateNudgeCandidate({
      cohort,
      email: row.email,
      channelId: row.channelId,
      conversationId: row.conversationId,
      sentAtIso: row.sentAtIso,
      opened: opened.has(row.trackingId),
      nowMs,
      // Task-44: 후보 주기 오버라이드 1순위 — runNudgeCohortSweep과 같은 규칙(resolveEffectiveCadenceMs).
      cadenceMs: resolveEffectiveCadenceMs(candidateCadenceOverrides.get(digest), cadenceMsByCohort.get(cohort) ?? 0),
      config,
      replied,
      appliedKeys: applied.keys,
      deliveredForCohort: entry?.deliveredByCohort.get(rowBucket) ?? 0,
      draftedForCohort: entry?.draftedByCohort.get(rowBucket) ?? 0,
      otherBucketPending: pendingInOtherBuckets(entry?.draftedByCohort, cohort, rowBucket),
      lastNudgeSentMs: entry?.lastSentMs ?? 0,
      campaignId: row.campaignId,
      programId: row.programId,
    });
    out.push(candidate);
    if (candidate.verdict.state === "eligible") eligible += 1;
    else blocked[candidate.verdict.reason] = (blocked[candidate.verdict.reason] ?? 0) + 1;
  }

  // suppression 은 판정 축이 아니라 **발송 순간의 축**이다. 화면에는 규칙별 분포만 싣는다 —
  //   infly 예외의 효과(이번 결정으로 열린 수)와 여전히 막히는 수를 나란히 보여주기 위해서다.
  //   ⚠️ 여기서는 이메일 원문을 다시 만들지 않는다(SEC-P0-009). 자격자 이메일로만 조회한다.
  let inflyOverlapSuppressed = 0;
  let otherSuppressed = 0;
  // W72-C R1 MEDIUM-4: `rows` 는 dedupe 전이라 같은 사람이 여러 번 들어간다 —
  //   그대로 세면 억제 건수가 행 수와 안 맞는다. **판정된 행(out)** 기준으로 dedupe 해서 센다.
  const eligibleHashes = new Set(
    out.filter((c) => c.verdict.state === "eligible").map((c) => c.emailHash),
  );
  const emailByHash = new Map<string, string>();
  for (const row of rows) {
    const hash = nudgeEmailDigest(row.email);
    if (eligibleHashes.has(hash) && !emailByHash.has(hash)) emailByHash.set(hash, row.email);
  }
  const eligibleEmails = [...emailByHash.values()];
  for (const email of eligibleEmails) {
    const hit = await findMailSuppression({ email, handle: "", name: "", category: "", platform: "", text: email });
    if (!hit.blocked) continue;
    if (hit.ruleId === INFLY_OVERLAP_RULE_ID) inflyOverlapSuppressed += 1;
    else otherSuppressed += 1;
  }

  const lastDoc = snapshot.docs[snapshot.docs.length - 1];
  return {
    ok: true,
    nowIso,
    rows: out,
    counts: {
      scanned: out.length,
      eligible,
      blocked,
      inflyOverlapSuppressed,
      otherSuppressed,
    },
    nextCursor: lastDoc
      ? { sentAtIso: asString(lastDoc.data()?.sentAtIso), docId: lastDoc.id }
      : null,
  };
}
