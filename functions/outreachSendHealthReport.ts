// 발송 레인 상태 경보 — 슬랙 10:00 리포트의 맨 앞 블록.
//
// WHY THIS EXISTS (2026-08-29 장애)
// --------------------------------
// 콜드 발송이 8/28 06:22 KST 부터 28시간 완전히 멈췄는데 **슬랙 리포트는 건강해 보였다.**
// 숫자가 틀린 게 아니라 **창(window)이 문제였다**: 10:00 리포트는 `*Flu 전일 리포트*` 라는
// 이름 그대로 **전일** 지표를 싣는다(slackScheduledReports.ts 의 W110 주석: "콜드 섹션이 전일
// 4지표를 그대로 싣는다"). 장애가 그날 일일 캡을 소진한 직후 시작되면 전일 숫자는 만점(캡=200)
// 이고, 오늘의 0 은 **다음날 10:00 까지** 리포트에 등장하지 않는다 — 최대 ~28시간 무증상이다.
// 실제로 8/29 10:00 리포트는 "어제 200건"을 보여줬고, 그 시점 발송은 이미 19시간째 죽어 있었다.
//
// 그래서 이 블록은 전일 축이 아니라 **지금 이 순간**을 본다. 세 축뿐이고 전부 단일 문서/집계다:
//   1) 오늘(KST) 발송 누계   campaign_outreach_daily_counters/{KST일자}.sent
//   2) 승인 대기 잔량        campaign_outreach where deliveryState == "approved" (count 집계)
//   3) 발신 주체 인증서 만료  integration_attestations/mail-provider-subject.expiresAt
//
// 경보 판정은 (1)과 (2)의 **조합**이다 — "오늘 0건"만으로는 이른 아침·주말에 오탐이 나지만,
// "승인 대기가 쌓여 있는데 오늘 0건"은 레인이 멈춘 것 외에 설명이 없다.
//
// (3)은 이번 장애의 근인이었다: 인증서는 30일 TTL(MAIL_PROVIDER_ATTESTATION_TTL_MS)인데
// 만료 경고가 **어디에도 없었다**. 만료되면 발송이 전면 차단되므로 D-7 부터 예고한다.
//
// 측정 실패는 0 으로 접지 않는다 — 이 파일의 모든 축은 실패 시 "측정 불가"로 렌더한다.
// 0 으로 접으면 조회 실패가 정상 문면(0건)으로 위장되고, 그건 이 블록이 막으려는 사고 그 자체다.
// SEC-P0-009: 카운트와 날짜만 렌더한다 — 수신자·본문·주소는 이 경로에 들어오지 않는다.

import { adminDb } from "./firebaseAdmin";
import { koreaDayKeyFrom } from "./mailOutboundSafety";
import { MAIL_PROVIDER_ATTESTATION_PATH } from "./mailProviderAttestation";

/** 인증서 만료 예고를 시작하는 잔여일. TTL 30일의 약 1/4 지점. */
export const ATTESTATION_WARN_WITHIN_DAYS = 7;

export type OutreachSendHealthFacts = {
  /** 오늘(KST) 발송 누계. null = 조회 실패(0 아님). */
  sentToday: number | null;
  /** 승인 대기 잔량. null = 조회 실패(0 아님). */
  approvedBacklog: number | null;
  /** 인증서 만료 ISO. null = 문서 없음/조회 실패. */
  attestationExpiresAtIso: string | null;
  /** 인증서 상태 문자열(active/revoked 등). null = 미상. */
  attestationState: string | null;
  nowMs: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 순수 판정 — 발송 레인이 멈춘 것으로 볼 근거가 있는가. */
export function outreachLaneLooksStalled(facts: OutreachSendHealthFacts): boolean {
  // 두 축 중 하나라도 못 읽었으면 판정하지 않는다. 모르는 것을 경보로 바꾸지 않는다.
  if (facts.sentToday === null || facts.approvedBacklog === null) return false;
  return facts.sentToday === 0 && facts.approvedBacklog > 0;
}

/** 순수 판정 — 인증서 만료까지 남은 일수. null = 만료일 미상. */
export function attestationDaysLeft(facts: OutreachSendHealthFacts): number | null {
  if (!facts.attestationExpiresAtIso) return null;
  const expiresMs = Date.parse(facts.attestationExpiresAtIso);
  if (!Number.isFinite(expiresMs)) return null;
  return Math.floor((expiresMs - facts.nowMs) / DAY_MS);
}

function isoDate(value: string): string {
  return value.slice(0, 10);
}

/** 순수 렌더 — 슬랙 문면 라인들. */
export function formatOutreachSendHealthSection(
  facts: OutreachSendHealthFacts,
  // 헤세 지시(2026-09-17): 캠페인이 둘 이상 동시 라이브면 이 전역 축 하나로는 "어느 캠페인이
  // 멈췄는지" 구분이 안 된다. 캠페인별 표를 전역 줄 **앞에** 붙인다(outreachPerCampaignReport.ts).
  // 비어 있으면(집계 실패·해당 캠페인 없음) 아무 것도 안 붙인다 — 기존 문면 그대로.
  perCampaignLines: readonly string[] = [],
): string[] {
  const lines = ["*발송 레인 상태* (리포트 발행 시점 실시간)", ...perCampaignLines];

  const sent = facts.sentToday === null ? "측정 불가" : `${facts.sentToday.toLocaleString("ko-KR")}건`;
  const backlog = facts.approvedBacklog === null
    ? "측정 불가"
    : `${facts.approvedBacklog.toLocaleString("ko-KR")}건`;
  lines.push(`• 오늘 발송: ${sent} · 승인 대기: ${backlog}`);

  const daysLeft = attestationDaysLeft(facts);
  if (facts.attestationState === "revoked") {
    lines.push("• 발신 인증서: 🔴 *폐기됨* — 발송 전면 차단 상태");
  } else if (daysLeft === null) {
    lines.push("• 발신 인증서: 측정 불가 — 인증 원장 조회 실패");
  } else if (daysLeft < 0) {
    lines.push(
      `• 발신 인증서: 🔴 *만료됨* (${isoDate(facts.attestationExpiresAtIso ?? "")}) — 발송 전면 차단 상태. 재인증 필요`,
    );
  } else if (daysLeft <= ATTESTATION_WARN_WITHIN_DAYS) {
    lines.push(
      `• 발신 인증서: ⚠️ 만료 임박 D-${daysLeft} (${isoDate(facts.attestationExpiresAtIso ?? "")}) — 만료되면 발송이 전면 차단된다`,
    );
  } else {
    lines.push(`• 발신 인증서: 정상 (D-${daysLeft}, ${isoDate(facts.attestationExpiresAtIso ?? "")} 만료)`);
  }

  if (outreachLaneLooksStalled(facts)) {
    lines.push(
      `🔴 *발송 정지 의심* — 승인 대기 ${(facts.approvedBacklog ?? 0).toLocaleString("ko-KR")}건인데 오늘 발송 0건이다.`,
    );
  }

  return lines;
}

/** I/O — 실패는 축별로 격리한다(한 축이 죽어도 나머지는 렌더된다). */
export async function collectOutreachSendHealthFacts(
  now: Date = new Date(),
): Promise<OutreachSendHealthFacts> {
  const dayKey = koreaDayKeyFrom(now);
  const [sentToday, approvedBacklog, attestation] = await Promise.all([
    adminDb.collection("campaign_outreach_daily_counters").doc(dayKey).get()
      .then((snapshot) => {
        const value = snapshot.data()?.sent;
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
      })
      .catch(() => null),
    adminDb.collection("campaign_outreach").where("deliveryState", "==", "approved").count().get()
      .then((snapshot) => Number(snapshot.data().count))
      .catch(() => null),
    adminDb.doc(MAIL_PROVIDER_ATTESTATION_PATH).get()
      .then((snapshot) => {
        const data = snapshot.data() ?? {};
        return {
          expiresAtIso: typeof data.expiresAt === "string" ? data.expiresAt : null,
          state: typeof data.state === "string" ? data.state : null,
        };
      })
      .catch(() => ({ expiresAtIso: null, state: null })),
  ]);
  return {
    sentToday,
    approvedBacklog: Number.isFinite(approvedBacklog as number) ? (approvedBacklog as number) : null,
    attestationExpiresAtIso: attestation.expiresAtIso,
    attestationState: attestation.state,
    nowMs: now.getTime(),
  };
}

/**
 * 실패해도 리포트를 죽이지 않는다 — 다른 사이드 섹션과 같은 규약. 실패는 undefined로
 * 드러낸다(0이 아니다). 호출부가 상세 채널 문면과 요약(글래스) 채널 경보를 같은 facts에서
 * 파생시키므로, Firestore 왕복은 이 한 번으로 끝난다.
 */
export async function collectOutreachSendHealthFactsSafe(
  now: Date = new Date(),
): Promise<OutreachSendHealthFacts | undefined> {
  try {
    return await collectOutreachSendHealthFacts(now);
  } catch {
    console.warn("[slack-scheduled-reports]", JSON.stringify({ outcome: "source_unavailable", metric: "outreach_send_health" }));
    return undefined;
  }
}

/**
 * 요약(글래스) 채널 전용 — 문제가 있을 때만 짧은 경보 조각을 낸다. 정상 상태(인증서 정상 등)는
 * 아무것도 반환하지 않는다(헤세 지시, 2026-09-27: 정상 상태를 매일 노출하지 않는다). 아이콘 +
 * 짧은 라벨뿐이다 — "만료되면 발송이 전면 차단된다" 같은 부연 설명은 상세 채널
 * (formatOutreachSendHealthSection) 전용으로 남긴다.
 */
export function formatOutreachGlanceWarnings(facts: OutreachSendHealthFacts): string[] {
  const warnings: string[] = [];
  const daysLeft = attestationDaysLeft(facts);
  if (facts.attestationState === "revoked") {
    warnings.push("🔴 인증서 폐기");
  } else if (daysLeft !== null && daysLeft < 0) {
    warnings.push("🔴 인증서 만료");
  } else if (daysLeft !== null && daysLeft <= ATTESTATION_WARN_WITHIN_DAYS) {
    warnings.push(`⚠️ 인증서 D-${daysLeft}`);
  }
  if (outreachLaneLooksStalled(facts)) warnings.push("🔴 발송 정지 의심");
  return warnings;
}

/**
 * 코드 리뷰 지적(2026-09-27, Medium): `collectOutreachSendHealthFactsSafe` 가 실패해
 * facts 자체가 없을 때 요약 채널이 빈 경보 배열([])을 쓰면, "정상이라 경보가 없다"와
 * "측정 자체가 실패했다"가 구분이 안 된다 — 상세 채널은 이 실패를 "측정 불가"로 이미
 * 드러내는데(formatOutreachSendHealthSection 폴백) 요약 채널만 조용히 건강해 보이면 안 된다.
 * 호출부(slackScheduledReportsHandler)가 facts 가 undefined 일 때 이 한 줄을 대신 쓴다.
 */
export const GLANCE_HEALTH_UNAVAILABLE_WARNING = "⚠️ 발송 상태 측정 불가";
