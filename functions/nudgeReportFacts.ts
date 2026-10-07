/**
 * W81 — 전일 리포트의 **독려 섹션 집계**.
 *
 * ■ 데이터 축을 왜 mail_outbound_log 로 잡았나 (실측 근거)
 *   큐 원장(`scp_outreach_queue`, source w72_nudge_sweep)에는 **이메일 평문이 없다** —
 *   `emailHash` 뿐이다(프로드 실측: 206 sent 행 전부). 그런데 전환 귀속은 이메일로 조인한다.
 *   `mail_outbound_log` 는 같은 발송에 대해 `to`(평문) · `sentAtIso` · `mailPurpose` ·
 *   `templateKind` · 열람(`openCount`/`firstRawOpenedAtIso`)을 **한 문서에** 갖는다.
 *   그래서 발송·코호트·회차·열람·귀속을 한 축에서 낼 수 있다. 큐는 이 축의 상류일 뿐이다.
 *
 * ■ 코호트 매핑 (프로드 실측)
 *   nudge_cohort1_read_no_reply   → ① 읽음·무응답
 *   nudge_cohort3_unread_no_reply → ③ 미열람
 *   application_video_reminder    → ② 지원·미제출 (기존 재촉 레인 편입 — 헤세 확정)
 *
 * ■ 회차
 *   `templateKind` 의 접미(`_w2`, `_w3`…)가 회차다. 접미가 없으면 1회차다(W72F 키 규칙).
 */

import { recipientIdentityHash, toRecipientIdentityHash } from "./recipientIdentityHash";

/** 독려로 인정되는 mailPurpose → 코호트. 이 목록 밖은 독려가 아니다(콜드로도 안 센다). */
export const NUDGE_PURPOSE_TO_COHORT: Readonly<Record<string, "cohort1" | "cohort2" | "cohort3" | "cohort4">> =
  Object.freeze({
    nudge_cohort1_read_no_reply: "cohort1",
    nudge_cohort3_unread_no_reply: "cohort3",
    application_video_reminder: "cohort2",
    // Task-100 F-6: 반려 후 재제출 독려. 코호트2 와 같은 축(콜드메일 독려가 아니다) — 소비처가
    //   이미 cohort2 를 별도 취급하는 두 지점(candidateTable.ts)도 cohort4 를 같이 제외한다.
    resubmission_nudge: "cohort4",
  });

export type NudgeSendRow = {
  readonly email: string;
  readonly sentAtMs: number;
  readonly mailPurpose: string;
  readonly templateKind: string;
  readonly opened: boolean;
  /** W82: 귀속 조인 키(24자 해시). toHash 가 있으면 그것, 없으면 to 로 만든다. */
  readonly identityKey: string;
};

export type NudgeSectionFacts = {
  readonly sent: number;
  readonly byCohort: { cohort1: number; cohort2: number; cohort3: number; cohort4: number };
  readonly bySequence: { first: number; second: number; thirdPlus: number };
  readonly opened: number;
};

function int(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * templateKind 접미에서 회차를 읽는다. W72F 키 규칙: base 키가 1회차, `_w2`.. 가 그 이후.
 * 규칙을 모르는 형태는 1회차로 본다 — 회차를 부풀리는 방향으로 실패하지 않는다.
 */
export function sequenceFromTemplateKind(templateKind: string): number {
  const matched = /_w(\d+)$/i.exec(String(templateKind ?? ""));
  if (!matched) return 1;
  const parsed = Number(matched[1]);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 1;
}

export function isNudgeSend(mailPurpose: unknown): boolean {
  return typeof mailPurpose === "string"
    && Object.prototype.hasOwnProperty.call(NUDGE_PURPOSE_TO_COHORT, mailPurpose);
}

/** 발송 행 묶음 → 독려 섹션 숫자(순수). */
/**
 * 열람으로 세지 **않는** 사유. 픽셀 분류기(classifyPixelOpen)가 붙인다.
 *   · mail_client_or_proxy_prefetch — 메일 클라이언트/프록시 선반입. 사람이 안 봤다.
 *   · local_or_operator_probe       — 우리 쪽 프로브. 우리가 우리를 센 것이다.
 *
 * ⚠️ **억제 사유가 붙었다고 전부 버리면 안 된다**(실측으로 확인했다). 프로드 2026-08-14:
 *   독려 발송 196 중 openCount>0 이 85건인데, 그 85건 **전부** 억제 사유를 달고 있다 —
 *   prefetch 65 · pixel_identity_unverified 20. 사유 존재만으로 거르면 열람이 0이 되고,
 *   그건 "아무도 안 열었다"는 거짓 보고다. `pixel_identity_unverified` 는 "누군지 확인 못 했다"
 *   이지 "봇이 열었다"가 아니다 — 그래서 남기고, 렌더가 추정치임을 밝힌다.
 */
const OPEN_NOISE_REASONS: ReadonlySet<string> = new Set([
  "mail_client_or_proxy_prefetch",
  "local_or_operator_probe",
]);

/**
 * 이 지표는 **추정치**다. 픽셀 신호 중 알려진 노이즈만 걷어낸 값이고,
 * "수신자가 실제로 열었다"를 확증하는 축은 아직 없다(likelyRecipientOpenCount 는 항상 0).
 * 렌더가 이 사실을 문면에 밝힌다 — 숫자만 크게 보이면 과신하게 된다.
 */
export const LIKELY_OPEN_IS_ESTIMATE = true;

export function isLikelyRecipientOpen(doc: Record<string, unknown>): boolean {
  if (int(doc.openCount) <= 0) return false;
  // 신뢰도·억제 사유 **양쪽**에서 알려진 노이즈만 뺀다. 사유가 붙었다는 사실 자체로 버리지 않는다.
  const reason = typeof doc.openSuppressionReason === "string" ? doc.openSuppressionReason : "";
  const confidence = typeof doc.openConfidence === "string" ? doc.openConfidence : "";
  return !OPEN_NOISE_REASONS.has(reason) && !OPEN_NOISE_REASONS.has(confidence);
}

export function summarizeNudgeSends(rows: readonly NudgeSendRow[]): NudgeSectionFacts {
  const byCohort = { cohort1: 0, cohort2: 0, cohort3: 0, cohort4: 0 };
  const bySequence = { first: 0, second: 0, thirdPlus: 0 };
  let opened = 0;
  for (const row of rows) {
    const cohort = NUDGE_PURPOSE_TO_COHORT[row.mailPurpose];
    if (!cohort) continue;
    byCohort[cohort] += 1;
    const sequence = sequenceFromTemplateKind(row.templateKind);
    if (sequence <= 1) bySequence.first += 1;
    else if (sequence === 2) bySequence.second += 1;
    else bySequence.thirdPlus += 1;
    if (row.opened) opened += 1;
  }
  return {
    sent: byCohort.cohort1 + byCohort.cohort2 + byCohort.cohort3 + byCohort.cohort4,
    byCohort,
    bySequence,
    opened,
  };
}

/**
 * W118 [헤세 장애 보고 2026-09-05] — **행이 있다는 것과 메일이 나갔다는 것은 다르다.**
 *
 * 프로드 실측: 아웃리치 수동 정지(2026-09-03 09:20Z) 이후 독려 시도가 매시간 차단되면서
 * `mail_outbound_log` 에 `deliveryState:"blocked"` · `deliverySource:"email-blocked-callable"`
 * 행이 계속 쌓였다(2026-09-04 하루 2,773건). 그런데 이 파서는 상태를 보지 않았다 —
 * 그래서 일일 리포트가 **한 통도 안 나간 날의 독려를 수천 건 발송으로** 보고했다.
 *
 * 발송으로 세는 상태는 `sent` 하나다:
 *   · `mock_sent`        — 공급자에 닿지 않았다(모의 발송).
 *   · `skipped_duplicate`— 중복 예약. 실제 발송 행은 따로 있어서 세면 이중 계상이다.
 *   · `blocked`          — 안전 규칙에 막혔다. 나가지 않았다.
 * 상태 필드가 없는 행도 세지 않는다 — 독려 레인은 이 필드가 상시 기록된 뒤에 라이브가 됐다.
 * (`chat-ai.ts` deliveryState 산출부 참조)
 */
export const DELIVERED_OUTBOUND_DELIVERY_STATE = "sent";

export function isDeliveredOutboundLogRow(doc: Record<string, unknown>): boolean {
  return typeof doc.deliveryState === "string"
    && doc.deliveryState.trim() === DELIVERED_OUTBOUND_DELIVERY_STATE;
}

/** mail_outbound_log 문서 → 발송 행. 형상이 어긋나면 조용히 버리지 않고 null 로 드러낸다. */
export function nudgeSendRowFrom(doc: Record<string, unknown>): NudgeSendRow | null {
  const mailPurpose = typeof doc.mailPurpose === "string" ? doc.mailPurpose : "";
  if (!isNudgeSend(mailPurpose)) return null;
  // 차단·모의·중복 행은 발송이 아니다(위 주석). 여기서 걸러야 sent·byCohort·bySequence·opened 가
  // 전부 같은 모집단을 쓴다.
  if (!isDeliveredOutboundLogRow(doc)) return null;
  const email = typeof doc.to === "string" ? doc.to.trim().toLowerCase() : "";
  const sentAtMs = Date.parse(typeof doc.sentAtIso === "string" ? doc.sentAtIso : "");
  if (!email || !Number.isFinite(sentAtMs)) return null;
  return {
    email,
    sentAtMs,
    mailPurpose,
    templateKind: typeof doc.templateKind === "string" ? doc.templateKind : "",
    // R1-H3 정정: `likelyRecipientOpenCount` 는 코드 전체에서 `increment(0)` 뿐이라 **항상 0** 이다
    //   (mailSignature.ts 픽셀 핸들러). 그래서 종전 구현은 사실상 원시 openCount 를 썼고,
    //   거기엔 메일 클라이언트 프리페치와 우리 자신의 프로브가 그대로 섞여 있었다.
    //   지금은 신뢰도 축으로 **알려진 노이즈를 뺀다** — 그래도 "수신자가 봤다"는 확증은 아니라서
    //   렌더가 추정치임을 밝힌다(위 LIKELY_OPEN_IS_ESTIMATE 참고).
    opened: isLikelyRecipientOpen(doc),
    identityKey: toRecipientIdentityHash(doc.toHash) || recipientIdentityHash(email),
  };
}
