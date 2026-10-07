// W124 — UID 안내 메일 발송 롤아웃 스위치 (`settings/scp_uid_guide_mail_rollout`).
//
// 왜 새 게이트인가 [헤세 결정 2026-08-24]:
//   이 레인은 2026-07-19 이후 **한 통도 나가지 않았다**(프로드 실측: 아웃박스 60행 전량 queued,
//   attempts 0). 배선을 고치는 순간 그 적체가 그대로 나가면 두 달 전 지원자들에게 안내 메일이
//   쏟아진다 — 사용자가 명시적으로 막은 상황이다. 그래서 배선 수리와 **발송 개방을 분리**한다.
//
// ⚠️ 기본값이 `settings/scp_video_result_mail_rollout`(W120) 과 **정반대**다.
//   W120 은 현행이 "발송 중"이라 문서 부재 = 현행 유지(활성)가 맞았다.
//   여기는 현행이 "0건 발송"이다 — 문서 부재를 활성으로 읽으면 그게 곧 회귀다.
//   따라서 fail-closed: 문서 없음 / 필드 없음 / null / 오타 / 읽기 실패 = 전부 **발송 안 함**.
//   정확히 boolean `true` 일 때만 열린다("true" 문자열도 열지 않는다).
//
// 이 코드는 게이트 문서를 **쓰지 않는다**. 개방(문서 생성)은 배포 후 사람이 한다.
//
// COST-P0-006: 게이트 읽기는 5분마다 문서 1건이다(≈288 read/일). 게이트가 닫혀 있을 때 드레인이
// 추가로 세는 적체 수치는(2026-09-27 비용 감사로) count() 집계 쿼리다 — 문서를 내려받지 않고
// 건수만 받으므로 적체 규모와 무관하게 읽기 과금이 사실상 상수다(예전에는 최대 500건 문서를
// 통째로 읽어 적체 규모에 비례해 커졌다).
//
// GA 스위치(receiptMailGoLive)·파일럿 펜스(e2eMailFence)·억제·쿼터는 이 게이트와 무관하게
// 그대로 평가된다. 이건 그 앞단에 하나 더 붙는 레인 전용 스위치다.

import { adminDb } from "./firebaseAdmin";

export const UID_GUIDE_MAIL_ROLLOUT_DOC_PATH = "settings/scp_uid_guide_mail_rollout" as const;

export type UidGuideMailRolloutGate = Readonly<{
  deliveryEnabled: boolean;
  openedAtIso: string;
  openedBy: string;
}>;

export const UID_GUIDE_MAIL_ROLLOUT_CLOSED: UidGuideMailRolloutGate = {
  deliveryEnabled: false,
  openedAtIso: "",
  openedBy: "",
};

function text(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** 순수 파서. 정확히 `deliveryEnabled === true` 일 때만 열린다 — 그 외 전부 닫힘. */
export function parseUidGuideMailRolloutGate(
  record: Record<string, unknown> | null | undefined,
): UidGuideMailRolloutGate {
  if (!record || record.deliveryEnabled !== true) return UID_GUIDE_MAIL_ROLLOUT_CLOSED;
  return {
    deliveryEnabled: true,
    openedAtIso: text(record.openedAtIso, 40),
    openedBy: text(record.openedBy, 120),
  };
}

export async function readUidGuideMailRolloutGate(
  db: FirebaseFirestore.Firestore = adminDb,
): Promise<UidGuideMailRolloutGate> {
  try {
    const [collection, docId] = UID_GUIDE_MAIL_ROLLOUT_DOC_PATH.split("/");
    const snapshot = await db.collection(collection).doc(docId).get();
    return parseUidGuideMailRolloutGate(snapshot.exists ? (snapshot.data() ?? null) : null);
  } catch {
    // 읽기 실패도 닫힘이다 — 이 파일이 무엇을 잘못 읽어도 발송이 늘어나는 방향으로는 실패하지 않는다.
    return UID_GUIDE_MAIL_ROLLOUT_CLOSED;
  }
}
