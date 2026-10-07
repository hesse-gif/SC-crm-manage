// 영수증 메일 GA 스위치 (사용자 결정 2026-07-27: 파일럿 펜스 전면 개방).
//
// e2eMailFence.ts 의 파일럿 펜스는 **단일 수신자·단일 신원·1회 발송**에 핀을 박는 검증용 장치다.
// E2E 가 끝난 지금 그 핀을 계속 요구하면 모든 영수증 메일이 pilot_fence_denied 로 무한 스킵된다.
// 이 파일은 그 **핀 요구만** 해제하는 스위치를 읽는다 — 다른 안전장치는 하나도 건드리지 않는다.
//
// ⚠️ GA 가 여는 것은 "파일럿 핀"뿐이다. SMTP 라이브 게이트, sendEmail 파이프라인의 승인·분류기·
//    킬스위치는 GA 이후에도 전부 그대로 평가된다(scpOutboxMailWorkers.defaultMailSendAdapter 참조).
//
// fail-closed: 문서 없음 / enabled !== true / purposes 가 배열이 아니거나 비어 있음 / 아는 레인이
// 하나도 없음 → null 을 돌려주고, 호출부는 오늘과 완전히 동일하게 파일럿 펜스를 평가한다.
// 읽기 실패도 null 이다. 즉 이 파일이 무엇을 잘못 읽어도 발송이 늘어나는 방향으로는 실패하지 않는다.
//
// 이 코드는 GA 문서를 **쓰지 않는다**. 실제 개방(문서 생성)은 배포 후 사람이 한다.

import { adminDb } from "./firebaseAdmin";

export const RECEIPT_MAIL_GOLIVE_DOC_PATH = "settings/scp_receipt_mail_golive";

/**
 * GA 로 열 수 있는 mailPurpose 의 전체 집합 — 각 워커가 defaultMailSendAdapter 에 **실제로 넘기는
 * 문자열**이다(값을 바꾸면 그 레인은 다시 펜스로 돌아간다):
 *  - onboarding             scpOutboxMailWorkers.ts:784
 *  - video_result_mail      scpOutboxMailWorkers.ts:1088   ← "video_result" 아님
 *  - content_submitted      scpOutboxMailWorkers.ts:1360
 *  - application_confirmed  scpOutboxMailWorkers.ts:1663
 *  - uid_guide              scpUidGuideMailWorker.ts:204
 *
 * 설정 문서가 이 집합 밖의 purpose 를 적어도 무시한다. 검증되지 않은 레인이 설정 오타 하나로
 * 열리는 것을 막기 위한 것이고, 5레인 중 일부만 여는 것은 문서로 그대로 가능하다.
 */
export const RECEIPT_MAIL_GOLIVE_KNOWN_PURPOSES: readonly string[] = [
  "onboarding",
  "uid_guide",
  "application_confirmed",
  "content_submitted",
  "video_result_mail",
  // W62e-CRIT [독립 델타]: 재촉 레인. 이 목록에 없으면 설정 문서에 purpose 를 적어도 **무시**되고,
  //   goLiveAllows 가 영원히 false → 파일럿 펜스가 default-deny 로 거절한다.
  //   그 거절은 (의도대로) 시도를 소모하지 않으므로 행이 queued 로 남고, 드레인이 **매분 다시 집는다**
  //   — 영구 미발송 + 무한 루프다. 1줄이 빠지면 레인 전체가 조용히 죽는 자리라 테스트로 못 박는다.
  "application_video_reminder",
  // 26-08-27 [헤세 확정: 로그인 승인 메일 자동화]: 26-08-26 파일럿 펜스 7통 실발사로 레인이
  //   검증됐다(delivered 7/7, /login 링크·브랜딩 확인). GA 개방 근거다. scpOutboxMailWorkers.ts:2874.
  "login_approved",
  // 26-08-27 [헤세 확정: 반려 안내 메일 2종(구독자 미달·채널 확인 불가)]: 사유는 templateKind 로
  //   갈리고 GA purpose 는 이 하나다 — drainLoginRejectedMailOutbox 가 emit 하는 문자열과 정확히
  //   같아야 한다. 운영 개방은 배포 후 사람이 설정 문서 purposes 에 추가한다.
  "login_rejected",
  // Task-100 F-6: 반려 후 재제출 독려. 코호트2(application_video_reminder)와 같은 이유로 여기
  //   없으면 goLiveAllows 가 영원히 false → 파일럿 펜스가 default-deny 로 거절하고 행이 queued 로
  //   영구 정체한다(위 application_video_reminder 주석과 동일 함정). resubmissionNudgeMail.ts 드레인
  //   이 emit 하는 문자열과 정확히 같아야 한다.
  "resubmission_nudge",
];
// W72-B2 [헤세 결정 2026-08-13] — 코호트1·3 독려 purpose 를 **여기 넣지 않는 것이 맞다.**
//   한 번 넣었다가 되돌렸으므로 이유를 남긴다.
//   이 목록의 불변식은 "**워커가 실제 emit 하는** purpose 만 연다"이다(아래 세 계약 테스트가 고정).
//   그런데 이 파일럿 펜스는 `scpOutboxMailWorkers` 의 아웃박스 드레인 경로에서만 평가된다.
//   코호트1·3 라이브는 sweep → prepareScpResultMail → chat-ai `sendEmail` 로 나가고
//   그 경로에는 이 펜스가 없다 — 넣어도 **아무도 읽지 않는다.**
//   넣으면 오히려 "GA 문서에 적으면 레인이 열린다"는 거짓 신호를 남긴다(실제로는 무관).
//   코호트1·3 의 발송 안전은 다른 축이 강제한다:
//     · 레인 캡 250/일 — mailOutboundSafety 의 **쿼터 예약 트랜잭션 안**(경로 무관 강제)
//     · suppression · 전역 캡 · 발송 직전 재검사 · fail-closed 문안 매핑(미발행이면 0건)
//   코호트2 는 드레인으로 나가므로 `application_video_reminder` 는 계속 여기 있어야 한다.

export type ReceiptMailGoLiveConfig = {
  enabled: true;
  purposes: readonly string[];
  openedAtIso: string;
  openedBy: string;
};

function text(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function parseReceiptMailGoLiveConfig(
  record: Record<string, unknown> | null | undefined,
): ReceiptMailGoLiveConfig | null {
  if (!record || record.enabled !== true) return null;
  if (!Array.isArray(record.purposes)) return null;
  const purposes = [...new Set(
    record.purposes
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => RECEIPT_MAIL_GOLIVE_KNOWN_PURPOSES.includes(value)),
  )];
  // 열 레인이 하나도 없으면 스위치가 없는 것과 같다.
  if (purposes.length === 0) return null;
  return {
    enabled: true,
    purposes,
    openedAtIso: text(record.openedAtIso, 40),
    openedBy: text(record.openedBy, 120),
  };
}

/** GA 가 이 메일의 파일럿 핀 요구를 해제하는가. config 가 null 이면 항상 false. */
export function receiptMailGoLiveAllows(
  config: ReceiptMailGoLiveConfig | null,
  mailPurpose: unknown,
): boolean {
  if (!config) return false;
  const purpose = text(mailPurpose, 80);
  if (!purpose) return false;
  return config.purposes.includes(purpose);
}

export async function readReceiptMailGoLiveConfig(): Promise<ReceiptMailGoLiveConfig | null> {
  try {
    const snapshot = await adminDb.doc(RECEIPT_MAIL_GOLIVE_DOC_PATH).get();
    return parseReceiptMailGoLiveConfig(snapshot.exists ? (snapshot.data() ?? null) : null);
  } catch {
    return null; // 읽기 실패 = 스위치 없음 = 오늘과 동일하게 파일럿 펜스 평가
  }
}
