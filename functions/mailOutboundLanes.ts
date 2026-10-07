/**
 * W118 — **아웃바운드 메일 레인 분류.**
 *
 * ■ 왜 필요했나 (프로드 실측 2026-09-05)
 *   `mail_safety_state/outbound.outreachSendingEnabled=false` 하나가 **모든** auto_send 를 막았다
 *   (resolveOutboundSafetyBlock). 운영자가 끈 것은 "1차 콜드메일"인데, 같은 스위치가
 *   지원확인·로그인승인·콘텐츠접수·온보딩 같은 **거래성 메일까지** 함께 죽였다.
 *   2026-09-04 하루에만 독려 2,773건이 발송 시도→차단으로 돌면서 `scp_mail_results` ·
 *   `mail_outbound_log` 에 문서를 새로 찍었다(시간당 ~118건). 스위치가 레인을 구분하지 못한
 *   결과다.
 *
 * ■ 레인
 *   · outreach      — 1차 캠페인 콜드메일. 그리고 **분류되지 않은 모든 것**(fail-closed).
 *   · nudge         — 독려 3코호트. 코호트1·3(sweep→scp_result_mail→sendEmail)과
 *                     코호트2 `application_video_reminder`(아웃박스 드레인).
 *   · transactional — 본인 행동이 유발한 확인·안내 메일. 수동 잠금의 대상이 아니다.
 *
 * ■ `application_video_reminder` 를 nudge 로 둔 근거 (결정 기록)
 *   이 purpose 는 `mailSuppression.TRANSACTIONAL_MAIL_PURPOSES` 에도 들어 있어서 두 갈래로
 *   읽힌다. 그래도 **nudge 가 맞다**:
 *     ① `nudgeSequenceTemplates.NUDGE_LANE_PURPOSE_TO_COHORT` 가 이걸 코호트2 로 등재해
 *        독려 레인 일캡을 물린다. 그리고 `totalDailyCap`(200)은 **3코호트 합산**이다 —
 *        쿼터 축이 이미 셋을 한 레인으로 본다.
 *     ② `nudgeReportFacts.NUDGE_PURPOSE_TO_COHORT` 도 코호트2 로 세어 일일 리포트의
 *        "독려 발송"에 넣는다. 여기서만 레인을 달리 잡으면 **리포트는 독려로 세는데 스위치는
 *        안 막는** 불일치가 생긴다.
 *   억제(infly-overlap) 축에서 거래성으로 분류되는 것은 "첫 콜드 접촉 금지"라는 **다른 규칙**의
 *   예외 판정이다. 그 동작은 이 파일이 건드리지 않는다.
 *
 * ■ 위협 모델 (2026-09-05 적대 리뷰 — 종전 주석이 틀렸다)
 *   종전 주석은 "`source` 를 싣는 곳은 서버 드레인 하나뿐"이라고 적었지만 **사실이 아니었다.**
 *   `chat-ai.sendEmail` 은 **공개 콜러블**이고(index.ts), 요청 본문을 그대로 안전 판정에 넘긴다.
 *   즉 인증된 manager/admin 이 `{source:"scp_outbox_mail_worker", mailPurpose:"login_approved"}`
 *   를 페이로드에 적는 것만으로 **거래성 레인**을 열 수 있었다 — 아웃리치 정지 중에도 콜드메일이
 *   나가는 우회로다. purpose 만 위조하면 **독려 레인**도 같은 방식으로 열렸다.
 *
 *   그래서 레인은 **payload 로 정해지지 않는다.** 서버가 만든 요청만 실을 수 있는
 *   `MAIL_LANE_PROVENANCE_FIELD` 표식이 있어야 `source`/`mailPurpose` 를 **읽기 시작**한다.
 *   그 표식은 `chat-ai.stripServerOwnedMailRequestProvenance` 가 외부 콜러블 입구에서 지운다 —
 *   `NUDGE_INTERNAL_PROVENANCE_FIELD` 와 **같은 기전**이고, 같은 테스트가 잠근다.
 *   `source`/`mailPurpose` 자체는 지우지 않는다: 템플릿·로그·중복 억제·수신확인이 그 값을 쓰고,
 *   레인 축에서는 표식이 없는 순간 이미 무력하다(아래 fail-closed).
 *
 *   ⚠️ **선행 우회로(이 파일이 닫지 않는 것)**: `mode==="manual_send"` 는
 *   `resolveOutboundSafetyBlock` 에서 레인과 무관하게 수동 정지를 통과한다(그쪽 계약은 종전 그대로).
 *   `sendEmail` 은 `fromRole!=="ai"` 를 manual_send 로 분류하므로, 공개 호출자는 레인을 위조하지
 *   않고도 `fromRole` 을 빼는 것만으로 수동 정지를 지나갈 수 있다. 그건 "사람이 보내는 메일은
 *   운영자가 책임진다"는 별개 결정이고, 바꾸려면 운영자 결정이 필요하다 —
 *   tests/mail-lane-kill-switches.test.mjs 가 그 현행 계약을 명시적으로 고정한다.
 *
 * ■ 분류 실패 = 가장 좁은 레인(outreach). 스위치가 느슨해지는 방향으로 실패하지 않는다.
 */

export type MailOutboundLane = "outreach" | "nudge" | "transactional";

export const MAIL_OUTBOUND_LANES: readonly MailOutboundLane[] = ["outreach", "nudge", "transactional"];

/**
 * 독려 레인 purpose. `nudgeSequenceTemplates.NUDGE_LANE_PURPOSE_TO_COHORT` 의 키와 같아야 한다 —
 * 어긋나면 캡이 붙는 레인과 스위치가 막는 레인이 갈린다. 계약 테스트가 두 목록을 대조한다.
 */
export const NUDGE_LANE_MAIL_PURPOSES: ReadonlySet<string> = new Set([
  "nudge_cohort1_read_no_reply",
  "application_video_reminder",
  "nudge_cohort3_unread_no_reply",
  // Task-100 F-6: 반려 후 재제출 독려. 코호트2(application_video_reminder)와 같은 이유로 nudge
  // 레인이다 — 여기 없으면 outreach 로 fail-closed 되어 아웃리치 수동 정지에 함께 막힌다.
  "resubmission_nudge",
]);

/**
 * 거래성 레인 purpose. `receiptMailGoLive.RECEIPT_MAIL_GOLIVE_KNOWN_PURPOSES` 에서
 * 독려 코호트2 를 뺀 것 — 그 목록이 "아웃박스 워커가 실제로 emit 하는 purpose" 의 정본이다.
 *
 * `auto_reply` (2026-09-06 프로드 사고): Chat 자동허가(Permit)가 크리에이터에게 보내는
 * 답장은 본인이 먼저 보낸 문의에 대한 응답이다 — 아웃리치가 아니다. 종전에는 이 purpose 가
 * 이 목록에 없어 `chat-ai.sendAutoReplyJob` 이 표식 없이 보내는 payload 가 fail-closed 로
 * outreach 레인에 떨어졌고, 운영자가 아웃리치를 끄면 armed 된 Permit 자동응답까지 함께
 * 막혔다. 하드락·연습모드·억제·Infly 중복·수신자별 쿼터·Permit 자체 게이트는 그대로 적용된다 —
 * 이 목록은 **수동 정지(아웃리치/독려)와 전역 1500/일 합산 캡**만 비켜 간다.
 */
export const TRANSACTIONAL_LANE_MAIL_PURPOSES: ReadonlySet<string> = new Set([
  "onboarding",
  "uid_guide",
  "application_confirmed",
  "content_submitted",
  "video_result_mail",
  "login_approved",
  "login_rejected",
  "auto_reply",
]);

/**
 * outreach 밖의 레인을 열 수 있는 `source` — **서버가 만든 발송 경로**만.
 *
 * `scp_result_mail` 이 여기 있어야 하는 이유(2026-09-05 적대 리뷰 P0-b): 자격 결과·로그인 승인/반려·
 * 지원확인 같은 거래성 메일과 독려 코호트①③ 은 전부 `scpMail.prepareScpResultMail` → `sendEmail`
 * 경로로 나가고 그 페이로드의 source 는 `scp_result_mail` 이다. 종전 목록에는 이 값이 없어서
 * **거래성 메일이 outreach 로 분류돼 아웃리치 정지에 함께 죽었다** — 이 파일이 고치려던 바로 그 사고가
 * 내부 경로에 그대로 남아 있었다.
 *
 * `auto_reply_queue` (2026-09-06): `chat-ai.processAutoReplyQueue` → `sendAutoReplyJob` 경로.
 * 공개 콜러블이 아니라 스케줄 함수(index.ts `onSchedule`)만 이 경로를 실행하므로 이 값은
 * 클라이언트 payload 로 위조할 수 없다 — 표식은 항상 서버가 채운다.
 */
export const SERVER_OWNED_MAIL_LANE_SOURCES: ReadonlySet<string> = new Set([
  // scpOutboxMailWorkers.defaultMailSendAdapter (온보딩·UID·접수·영상결과·독려 코호트2 드레인)
  "scp_outbox_mail_worker",
  // scpMail.prepareScpResultMail (자격 결과·로그인 승인/반려·독려 코호트①③)
  "scp_result_mail",
  // chat-ai.sendAutoReplyJob (Chat 자동허가 답장)
  "auto_reply_queue",
]);

/**
 * 서버 소유 레인 표식. **이 필드가 payload 에 있어야 `source`/`mailPurpose` 가 레인 판정에 쓰인다.**
 * 외부 콜러블 입구(`chat-ai.stripServerOwnedMailRequestProvenance`)가 이 필드를 지우므로
 * 공개 호출자는 채울 수 없다 — `NUDGE_INTERNAL_PROVENANCE_FIELD` 와 같은 기전이다.
 */
export const MAIL_LANE_PROVENANCE_FIELD = "mailLaneProvenance" as const;
export const MAIL_LANE_PROVENANCE = "flu_server_owned_mail_lane_v1" as const;

/** 내부 발송 경로가 자기 레인을 명시할 때 페이로드에 펼치는 조각. */
export function serverOwnedMailLaneProvenance(
  source: string,
): { [MAIL_LANE_PROVENANCE_FIELD]: typeof MAIL_LANE_PROVENANCE; source: string } {
  return { [MAIL_LANE_PROVENANCE_FIELD]: MAIL_LANE_PROVENANCE, source };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 이 페이로드가 서버가 만든 발송 경로에서 왔는가(표식 + 등재된 source 둘 다 필요). */
export function hasServerOwnedMailLaneProvenance(data: Record<string, unknown>): boolean {
  return text(data?.[MAIL_LANE_PROVENANCE_FIELD]) === MAIL_LANE_PROVENANCE
    && SERVER_OWNED_MAIL_LANE_SOURCES.has(text(data?.source));
}

export function isNudgeLaneMail(mailPurpose: unknown): boolean {
  return NUDGE_LANE_MAIL_PURPOSES.has(text(mailPurpose));
}

/**
 * 메일 레코드 → 레인. 서버 소유 표식이 없으면 purpose 를 **읽지도 않고** `outreach` 로 닫는다
 * (위조 내성). 표식이 있어도 분류에 실패하면 `outreach` 다.
 *
 * Task-94 (자동 검수/반려): `video_result_mail` 은 거래성(캡 면제)이지만, 그 판정이
 * **AI 저자**(actorType:"ai" — videoReviewTransitionStore.ts 가 결과 메일 아웃박스 행에 싣는다)면
 * 예외를 준다. 사람이 리뷰하지 않은 자동 반려 메일까지 전역 일일 캡·아웃리치 수동 정지를
 * 통째로 비켜 가면, 자동 검수 코어가 오판을 반복할 때 그 사고가 무한정 발송될 수 있다 — 이
 * 파일의 "분류 실패 = 가장 좁은 레인" 규율과 같은 방향으로, AI 저자 거래성 메일은 outreach 로
 * 떨어뜨려 캡·수동 정지 둘 다 적용받게 한다. 사람 판정(actorType 부재/"human")은 계속 면제.
 * `actorType` 은 서버 소유 표식 뒤에서만 읽는다 — 위 provenance 가드가 없으면 애초에 이 줄에
 * 도달하지 않는다(외부 payload 로 위조 불가, MAIL_LANE_PROVENANCE_FIELD 와 동일한 위협모델).
 */
export function resolveMailOutboundLane(data: Record<string, unknown>): MailOutboundLane {
  if (!hasServerOwnedMailLaneProvenance(data)) return "outreach";
  const mailPurpose = text(data?.mailPurpose);
  if (NUDGE_LANE_MAIL_PURPOSES.has(mailPurpose)) return "nudge";
  if (TRANSACTIONAL_LANE_MAIL_PURPOSES.has(mailPurpose)) {
    return text(data?.actorType) === "ai" ? "outreach" : "transactional";
  }
  return "outreach";
}
