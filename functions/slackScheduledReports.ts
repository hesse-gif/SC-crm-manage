// Flu bot scheduled reports — one 10:00 KST scheduler emits daily, weekly, and monthly sections.
//
// Canonical metric sources are fixed by W68-B/W73. Do not replace them with snapshots or infer
// event time from projection timestamps:
//   send          scp_coldmail_history.sentAtIso where source == "campaign_outreach"
//   reply         message_sources.receivedAtIso after outreachFunnelSnapshot reply eligibility
//   apply         scp_application_management.submittedAtIso + program_applications.submittedAtIso
//   video submit  scp_video_review_state.currentRevisionSubmittedAtIso + revision outbox fallback
//
// NET-P0-012: Slack is called only from this Functions module. SLACK_BOT_TOKEN comes only from
// Secret Manager through the scheduler binding. SEC-P0-009: only counts/statuses are rendered or
// logged; raw mail, prompt, response, identity, and provider error text never leave the function.

import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { recipientIdentityHash, toRecipientIdentityHash } from "./recipientIdentityHash";
import {
  attributeConversionsPrecise,
  NUDGE_ATTRIBUTION_WINDOW_MS,
  normalizeAttributionEmail,
  type AttributionResult,
  type ContactEvent,
  type ConversionEvent,
} from "./nudgeReportAttribution";
import {
  isDeliveredOutboundLogRow,
  nudgeSendRowFrom,
  summarizeNudgeSends,
  type NudgeSectionFacts,
  type NudgeSendRow,
} from "./nudgeReportFacts";
import { isEligibleOutreachReply, type OutreachReplyRecord } from "./outreachFunnelSnapshot";
import { CANONICAL_OPERATIONAL_MAILBOX_V1 } from "./mailIdentity";
import { emailDomain, normalizeEmailAddress } from "./mailSafetyShared";
import { buildEmailInventorySectionSafe } from "./emailInventoryReport";
import { buildVideoReviewBacklogSectionSafe } from "./videoReviewBacklogReport";
// Task-100 §4: 같은 백로그 섹션에 재제출 대기 한 줄만 덧붙인다(자체 실패 격리, 별도 축).
import { buildResubmissionCycleBacklogLineSafe } from "./resubmissionCycleBacklogFact";
import {
  collectOutreachSendHealthFactsSafe,
  formatOutreachGlanceWarnings,
  formatOutreachSendHealthSection,
  GLANCE_HEALTH_UNAVAILABLE_WARNING,
} from "./outreachSendHealthReport";
import {
  collectPerCampaignReportRows,
  formatDetailWorkstreamReportMessages,
  formatGlanceColdCampaignLine,
  formatPerCampaignReportLines,
  groupPerCampaignRowsByWorkstream,
} from "./outreachPerCampaignReport";

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const SLACK_API_URL = "https://slack.com/api/chat.postMessage";
const SLACK_BOT_TOKEN_ENV = "SLACK_BOT_TOKEN";
const MOM_MEANINGFUL_FROM_KST = "2026-09-01";

// 2026-09-27 채널 재정의(헤세 컨펌): 코드 상 라벨이 실제 성격과 반대였다. C0ARCM9CZNG("test")는
// 팀 내부에서 캠페인별·업무별 세부까지 보는 상세 채널이고, C0AC81K92SC("production")는 헤세가
// "슬랙봇으로 공유해" 할 때 쓰는, 넓게 공유되는 요약(글래스) 채널이다. 채널 ID는 그대로 두고
// 라벨만 실제 용도로 바꾼다 — 아래 상수 값(채널 ID)은 전혀 바뀌지 않았다.
export const SLACK_SCHEDULED_REPORT_CHANNELS = [
  { id: "C0ARCM9CZNG", environment: "detail" },
  { id: "C0AC81K92SC", environment: "summary" },
] as const;

/** 이메일 재고 섹션은 상세 채널에만 append한다(헤세 지시, C0ARCM9CZNG 한정 — 요약 채널은 그대로 둔다). */
export const EMAIL_INVENTORY_SECTION_CHANNEL_ID = "C0ARCM9CZNG";

/** 같은 상세 채널 안에서 업무별 독립 top-level 리포트를 발행하는 대상이다. */
export const DETAIL_WORKSTREAM_REPORT_CHANNEL_ID = "C0ARCM9CZNG";

/**
 * W126: 검수 백로그 섹션도 같은 규약 — 부가 축은 요약 채널 문면을 바꾸지 않는다(W118 전례).
 * 요약 채널로 넓히는 결정은 이 상수 한 줄이면 되지만, 그건 사람이 내릴 결정이라 여기서 하지 않는다.
 */
export const VIDEO_REVIEW_BACKLOG_SECTION_CHANNEL_ID = "C0ARCM9CZNG";

export type ScheduledMetricKey = "sent" | "replied" | "applied" | "videoSubmitted";

export type ReportWindow = {
  startMs: number;
  endMs: number;
};

export type ScheduledReportWindows = {
  runDateKst: string;
  includeWeekly: boolean;
  includeMonthly: boolean;
  monthToDateComparisonComplete: boolean;
  daily: ReportWindow;
  weekToDate: ReportWindow;
  monthToDate: ReportWindow;
  previousMonthSamePeriod: ReportWindow;
  previousWeek: ReportWindow;
  weekBeforePrevious: ReportWindow;
  previousMonth: ReportWindow;
  monthBeforePrevious: ReportWindow;
};

export type ReportMetric =
  | { status: "complete"; count: number }
  | { status: "lower_bound"; count: number; reason: string }
  | { status: "unavailable"; reason: string };

/**
 * 2026-09-29(헤세 지시): scp@ 수신함에 그날 실제로 들어온 크리에이터 회신 총계 — 콜드메일 발송
 * 귀속(`replied`/`isEligibleOutreachReply`, matchedOutboundRef 필요)과는 별개 축이다. 9/28 KST
 * 실측에서 귀속 1건 vs 실제 회신 17건(Flu) / 25건(scp@ Gmail)의 괴리가 관측됐다 — 귀속이
 * "회신을 받았는가"의 대리 지표로 쓰이면 안 된다는 신호.
 */
export type InboundReplyCountFacts =
  | { status: "complete"; count: number; distinctCreators: number; personalMailboxCount: number }
  | { status: "unavailable"; reason: string; count: 0; distinctCreators: 0; personalMailboxCount: 0 };

type MetricDataset = {
  eventTimesMs: number[];
  lowerBoundReason?: string;
  unavailableReason?: string;
};

type CanonicalRow = Record<string, unknown> & { id: string; ref?: string };

export type ScheduledReportSource = {
  sentRows(startIso: string, endIso: string): Promise<CanonicalRow[]>;
  /**
   * W81: 독려 발송(mail_outbound_log). 큐 원장에는 이메일 평문이 없어 귀속 조인이 안 된다 —
   *   실측 확인 후 이 축으로 잡았다(to · toHash · sentAtIso · mailPurpose · templateKind · 열람).
   */
  nudgeSendRows(startIso: string, endIso: string): Promise<CanonicalRow[]>;
  /**
   * W82: 전환의 **수신자 식별 해시**를 실은 행(확인메일/제출메일 outbox).
   *   전환 원장 자체(scp_application_management)에는 식별자가 없지만, 같은 전환에 대해
   *   생성되는 이 outbox 는 `applicationId` + `recipientEmailHash` 를 이미 갖는다(실측).
   *   그래서 **새 쓰기도 백필도 없이** 기존 데이터로 귀속이 성립한다.
   */
  conversionIdentityRows(startIso: string, endIso: string): Promise<CanonicalRow[]>;
  replyRows(startIso: string, endIso: string): Promise<CanonicalRow[]>;
  applicationRows(startIso: string, endIso: string): Promise<CanonicalRow[]>;
  videoSubmissionRows(startIso: string, endIso: string): Promise<CanonicalRow[]>;
  /**
   * 2026-09-29(코덱스 3차 리뷰): message_sources 인바운드 문서 자체엔 mailAccountId 가 없다
   * (chat-ai.ts persistReceivedEmail 의 conversationData 에만 쓰인다 — sourceData 는 이
   * 필드를 아예 안 쓴다, 실측 확인). scp@ 대 개인 메일함 판정은 **연결된 대화**에서 읽어야
   * 한다. 그날 회신 후보의 고유 conversationId 만 배치 point-read 하므로(range 쿼리 아님)
   * 하루치 기준 수십 건 수준의 읽기다. 없는 문서는 반환 맵에서 제외하고, 존재하는 레거시
   * 문서에 필드가 없을 때만 ""(SCP)을 반환한다.
   */
  conversationMailAccountIds(conversationIds: readonly string[]): Promise<Record<string, string>>;
};

/**
 * R1-H1: 귀속을 "쟀다"고 말하려면 이 비율 이상이 조인돼야 한다. 부분 조인은 **부분 손실**이고,
 *   손실분은 어느 레인에도 안 잡혀 조용히 사라진다 — 그 상태의 숫자는 확신을 줄 자격이 없다.
 */
const ATTRIBUTION_JOIN_RATE_FLOOR = 0.9;

/**
 * R1-H2: 식별 아웃박스는 전환과 시각이 어긋난다(드레인 지연·수리 시각). 양방향 여유.
 */
const IDENTITY_LOOKUP_MARGIN_MS = 3 * 24 * 60 * 60 * 1000;

/** W81: 콜드/독려 두 레인의 전일 성과. 귀속은 라스트터치·7일(nudgeReportAttribution). */
export type LaneSplitFacts = {
  readonly nudge: NudgeSectionFacts;
  /** 전환 귀속 — 이중 계상 없이 한 번만 센다. */
  readonly applied: AttributionResult;
  readonly videoSubmitted: AttributionResult;
  /** 열람 후 Apply (독려 ③ 축). */
  readonly openedThenApplied: number;
  /**
   * W81: 전환 귀속을 **셀 수 있었는가**. 전환 원장에 이메일/해시가 없으면 false —
   *   그때 0을 보고하면 "전환이 없었다"는 거짓말이 된다.
   */
  readonly attributionMeasurable: boolean;
  /**
   * W110 리뷰(HIGH): 독려 발송 로그(mail_outbound_log) 조회 **자체가 성공했는가**.
   *   safeRows 가 실패를 빈 배열로 접기 때문에, 이 플래그 없이는 "독려 발송 0건"이
   *   진짜 0 과 구분되지 않는다. 누계 레인은 월요일 1회 발행이라 그 거짓이 다음 주까지
   *   정정되지 않고, 두 슬랙 채널(테스트·운영)에 그대로 나간다.
   */
  readonly nudgeMeasurable: boolean;
  readonly conversionRowsSeen: number;
  readonly conversionRowsJoinable: number;
  /** R1-H2: 구조적으로 귀속 불가한 경로(아웃박스 writer 없음)의 전환 수. 숨기지 않고 보고한다. */
  readonly unmeasurableApplicationRows: number;
  /**
   * 2026-09-27(헤세 지시): 요약 채널의 "무슨 메일이 나갔는지" 축 — 자동답장(mailPurpose ===
   *   "auto_reply") 발송 수. 독려와 같은 mail_outbound_log 원천(nudgeRows)에서 세므로,
   *   측정 가능 여부도 독려와 같은 축(nudgeMeasurable)을 공유한다 — 별도 소스 실패 플래그를
   *   두지 않는다(같은 fetch 가 죽으면 둘 다 죽는다).
   */
  readonly autoReplySent: number;
};

export type ScheduledReportFacts = {
  windows: ScheduledReportWindows;
  /** W81: 전일 기준 레인 분해. */
  laneSplit?: LaneSplitFacts;
  /**
   * W110: 누계 구간의 레인 분해. 누계 블록이 월요일에만 나가므로 **월요일에만** 모은다 —
   *   화~일에 월 구간(콜드 5천 + 독려 1만 행)을 읽으면 함수 예산만 태우고 아무도 안 본다.
   */
  laneSplitPreviousWeek?: LaneSplitFacts;
  laneSplitMonthToDate?: LaneSplitFacts;
  /**
   * 2026-09-29: 전일 구간의 "실제 수신 회신 총계" — daily.replied(콜드메일 귀속)와 별개 축.
   *   누계 구간에는 붙이지 않는다(요약 채널 헤드라인 한 줄에만 쓰인다).
   */
  dailyInboundReplies: InboundReplyCountFacts;
  daily: Record<ScheduledMetricKey, ReportMetric>;
  weekToDate: Record<ScheduledMetricKey, ReportMetric>;
  monthToDate: Record<ScheduledMetricKey, ReportMetric>;
  previousMonthSamePeriod: Record<ScheduledMetricKey, ReportMetric>;
  previousWeek: Record<ScheduledMetricKey, ReportMetric>;
  weekBeforePrevious: Record<ScheduledMetricKey, ReportMetric>;
  previousMonth: Record<ScheduledMetricKey, ReportMetric>;
  monthBeforePrevious: Record<ScheduledMetricKey, ReportMetric>;
};

const METRIC_KEYS: ScheduledMetricKey[] = [
  "sent",
  "replied",
  "applied",
  "videoSubmitted",
];

const METRIC_LABELS: Record<ScheduledMetricKey, string> = {
  sent: "발송",
  replied: "회신",
  applied: "Apply",
  videoSubmitted: "영상 제출",
};

// 2026-09-29(코덱스 리뷰): Firestore 가 문서를 **처음 쓴** 시각 — 클라이언트가 채우는 어떤
//   필드(receivedAtIso 는 발신자 메일 클라이언트의 Date 헤더가 우선이다)보다 신뢰할 수 있다.
//   snapshot 메타데이터라 .select() 프로젝션·추가 read 비용과 무관하게 항상 딸려 온다.
//   앱 데이터 필드와 절대 충돌하지 않도록 스프레드 뒤에 덧붙인다.
function rowOf(doc: QueryDocumentSnapshot): CanonicalRow {
  return {
    id: doc.id,
    ref: doc.ref.path,
    ...(doc.data() ?? {}),
    __firestoreCreateTimeIso: doc.createTime ? doc.createTime.toDate().toISOString() : undefined,
  };
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isoMillis(value: unknown): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function kstDateString(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function kstMidnightMs(year: number, monthIndex: number, day: number): number {
  return Date.UTC(year, monthIndex, day) - KST_OFFSET_MS;
}

export function buildScheduledReportWindows(nowMs: number): ScheduledReportWindows {
  const shifted = new Date(nowMs + KST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const monthIndex = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const dayOfWeek = shifted.getUTCDay();
  const todayStartMs = kstMidnightMs(year, monthIndex, day);
  const mondayOffsetDays = (dayOfWeek + 6) % 7;
  const currentWeekStartMs = todayStartMs - mondayOffsetDays * DAY_MS;
  const currentMonthStartMs = kstMidnightMs(year, monthIndex, 1);
  const previousMonthStartMs = kstMidnightMs(year, monthIndex - 1, 1);
  const monthBeforePreviousStartMs = kstMidnightMs(year, monthIndex - 2, 1);
  const previousMonthSamePeriodCandidateEndMs = previousMonthStartMs + (day - 1) * DAY_MS;

  return {
    runDateKst: kstDateString(nowMs),
    includeWeekly: dayOfWeek === 1,
    includeMonthly: day === 1,
    monthToDateComparisonComplete: previousMonthSamePeriodCandidateEndMs <= currentMonthStartMs,
    daily: { startMs: todayStartMs - DAY_MS, endMs: todayStartMs },
    // Only complete KST days are included. Monday's week-to-date is a valid zero-day cumulative.
    weekToDate: { startMs: currentWeekStartMs, endMs: todayStartMs },
    monthToDate: { startMs: currentMonthStartMs, endMs: todayStartMs },
    previousMonthSamePeriod: {
      startMs: previousMonthStartMs,
      endMs: Math.min(previousMonthSamePeriodCandidateEndMs, currentMonthStartMs),
    },
    previousWeek: { startMs: currentWeekStartMs - 7 * DAY_MS, endMs: currentWeekStartMs },
    weekBeforePrevious: { startMs: currentWeekStartMs - 14 * DAY_MS, endMs: currentWeekStartMs - 7 * DAY_MS },
    previousMonth: { startMs: previousMonthStartMs, endMs: currentMonthStartMs },
    monthBeforePrevious: { startMs: monthBeforePreviousStartMs, endMs: previousMonthStartMs },
  };
}

function earliestReadMs(windows: ScheduledReportWindows): number {
  const starts = [
    windows.daily.startMs,
    windows.weekToDate.startMs,
    windows.monthToDate.startMs,
    windows.previousMonthSamePeriod.startMs,
  ];
  if (windows.includeWeekly) starts.push(windows.weekBeforePrevious.startMs);
  if (windows.includeMonthly) starts.push(windows.monthBeforePrevious.startMs);
  return Math.min(...starts);
}

function inWindow(eventMs: number, window: ReportWindow): boolean {
  return eventMs >= window.startMs && eventMs < window.endMs;
}

function metricForWindow(dataset: MetricDataset, window: ReportWindow): ReportMetric {
  if (dataset.unavailableReason) return { status: "unavailable", reason: dataset.unavailableReason };
  const count = dataset.eventTimesMs.filter((eventMs) => inWindow(eventMs, window)).length;
  return dataset.lowerBoundReason
    ? { status: "lower_bound", count, reason: dataset.lowerBoundReason }
    : { status: "complete", count };
}

function metricsForWindow(
  datasets: Record<ScheduledMetricKey, MetricDataset>,
  window: ReportWindow,
): Record<ScheduledMetricKey, ReportMetric> {
  return Object.fromEntries(
    METRIC_KEYS.map((key) => [key, metricForWindow(datasets[key], window)]),
  ) as Record<ScheduledMetricKey, ReportMetric>;
}

function parsedTimes(rows: CanonicalRow[], field: string): number[] {
  return rows.map((row) => isoMillis(row[field])).filter((value): value is number => value !== null);
}

function submissionEventTimes(rows: CanonicalRow[]): number[] {
  const events = new Map<string, number>();
  for (const row of rows) {
    const field = row.sourceType === "revision_outbox" ? "createdAtIso" : "currentRevisionSubmittedAtIso";
    const eventMs = isoMillis(row[field]);
    if (eventMs === null) continue;
    const submissionId = safeString(row.videoSubmissionId) || row.id;
    const revision = typeof row.videoRevision === "number"
      ? row.videoRevision
      : typeof row.revision === "number" ? row.revision : null;
    const key = revision === null
      ? `${row.sourceType}:${row.id}`
      : `${submissionId}:revision:${Math.trunc(revision)}`;
    if (!events.has(key)) events.set(key, eventMs);
  }
  return [...events.values()];
}

async function captureDataset(
  metric: ScheduledMetricKey,
  read: () => Promise<MetricDataset>,
): Promise<MetricDataset> {
  try {
    return await read();
  } catch {
    console.warn("[slack-scheduled-reports]", JSON.stringify({ outcome: "source_unavailable", metric }));
    return { eventTimesMs: [], unavailableReason: `${METRIC_LABELS[metric]} 정본 조회 실패` };
  }
}

// ---- 2026-09-29: 총 인바운드 회신(콜드메일 귀속과 별개) ---------------------------------
//
// message_sources 로 direction:"inbound" 가 남는 것은 대부분 이미 classifyInboundRoute
// (mailInboundRoute.ts)의 creator_reply 게이트를 통과한 문서뿐이다 — 내부망/뉴스레터/캘린더
// 초대/벤더 역할계정/게임사는 그 게이트에서 걸러져 message_sources 자체에 쓰이지 않는다
// (mail_inbound_routes/mail_inbound_quarantine 로만 간다). 다만 자동응답(Auto-Submitted/
// X-Autoreply)은 예외다 — classifyInboundRoute Rule 1 이 "발송한 아웃바운드에 매칭되면
// 무조건 creator_reply"로 단락시키므로, 우리 콜드메일에 대한 휴가 자동응답도 그대로
// message_sources 에 적힌다. 게다가 route/inboundRoute 필드 자체가 표준 IMAP 인입 경로의
// 실제 저장문서에는 없다(리뷰 실측 — chat-ai.ts 의 인바운드 write 가 이 필드를 안 쓴다) —
// 아래 route 체크는 그 필드를 우연히 갖고 있는 레거시/타 적재 경로에 대한 방어일 뿐이고,
// 자동응답 차단의 실질 방어선은 subject 패턴이다(아래 AUTO_REPLY_SUBJECT_RE).
// 잔여 미탐(문서화): 제목에 표식이 없는 자동응답, 본문에만 문구가 있는 경우, 위 정규식이
// 못 잡는 언어의 자동응답은 여전히 샌다 — Auto-Submitted/X-Autoreply 원본 헤더가
// message_sources 에 저장되지 않는 한 완전히 막을 수 없다.
function extractReplySenderAddress(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  const angle = raw.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : raw).trim();
  const match = candidate.match(/[^\s<>,;]+@[^\s<>,;]+/);
  return match ? normalizeEmailAddress(match[0]) : "";
}

function inboundReplySenderAddress(row: CanonicalRow): string {
  const creatorEmail = safeString(row.creatorEmail);
  if (creatorEmail) return extractReplySenderAddress(creatorEmail);
  return extractReplySenderAddress(safeString(row.from));
}

// mailer-daemon@/postmaster@ 류 반송 발신자. 실사용 도메인마다 로컬파트 앞에 붙는 접두/구분자가
// 갈려서(mailer-daemon / MAILER-DAEMON / mail-daemon) 정확 매치 대신 접두 매치로 잡는다.
// 2026-09-29(코덱스 3차 리뷰): 이 주소 검사는 **row.from(실제 봉투 발신자)** 에만 걸어야
// 한다 — creatorEmail 은 귀속(대화 매칭) 값이라, 반송/DSN 이 기존 창작자 대화에 잘못
// 매칭되면 creatorEmail 이 그 창작자의 진짜 주소로 채워져 실제 발신자(mailer-daemon 등)를
// 가려버린다. 게다가 표준 라이브 인입 경로는 from 을 **마스킹해서**(chat-ai.ts
// persistReceivedEmail: author = inboundMail?.fromMasked ?? … — 로컬파트 앞 2글자+"***")
// 저장하므로, 마스킹된 값으로는 "mailer-daemon"/"postmaster" 전체 단어를 못 잡는다 — 그래서
// DSN 차단의 실질 방어선은 아래 subject 패턴이고, 이 주소 검사는 마스킹을 거치지 않는
// 경로(백필/수동 적재)에 대한 보조 방어선일 뿐이다.
const BOUNCE_SENDER_LOCAL_PART_RE = /^(mailer[-_.]?daemon|mail[-_.]?daemon|postmaster|delivery[-_.]?status)/i;

function isBounceSenderAddress(address: string): boolean {
  const at = address.lastIndexOf("@");
  const localPart = at > 0 ? address.slice(0, at) : address;
  return BOUNCE_SENDER_LOCAL_PART_RE.test(localPart);
}

// 위와 별개로, from 필드 원문이(마스킹되지 않았다면) "Mail Delivery Subsystem <mailer-daemon@…>"
// 처럼 표시이름+주소 형태일 수 있다 — 표시이름/꺾쇠를 벗겨내고 "mailer-daemon"/"postmaster" 로
// 시작하는지 직접 검사한다(주소 파싱 없이, 마스킹 여부와 무관하게 동작).
function isBounceSenderFromField(row: CanonicalRow): boolean {
  const raw = safeString(row.from).trim();
  if (!raw) return false;
  const withoutDisplayName = raw.replace(/^[^<]*<\s*/, "").replace(/^"[^"]*"\s*/, "");
  return /^(mailer[-_.]?daemon|postmaster)/i.test(withoutDisplayName);
}

// DSN/반송 제목 표식 — 코덱스 3차 리뷰 지정 문구. 주소 기반 검사가 마스킹 때문에 못 잡는
// 반송 통지를 여기서 잡는다. 자동응답 패턴과 같은 이유로 **앵커링**한다 — "Re: Delivery
// Status Notification (Failure)"처럼 사람이 반송 통지를 인용해 직접 답장한 진짜 회신까지
// 걸러지면 안 된다.
const BOUNCE_SUBJECT_START_RE =
  /^(?:delivery\s+status\s+notification|undeliverable|mail\s+delivery\s+(?:failed|failure|fail)|delivery\s+has\s+failed|returned\s+mail|메일\s?전송\s?실패)/i;

function isIdentifiableBounceSubject(row: CanonicalRow): boolean {
  const subject = safeString(row.subject).trim();
  const withoutLeadingTag = subject.replace(/^\[[^\]]{0,40}\]\s*/, "");
  return BOUNCE_SUBJECT_START_RE.test(withoutLeadingTag);
}

function isSupercentInternalAddress(address: string): boolean {
  return emailDomain(address).endsWith("supercent.io");
}

// 부재중/자동응답 제목 표식 — 영어 + 한국어 흔한 문구만. autoSubmitted/precedence 필드는
// message_sources 에 저장되지 않으므로(실측 확인) 쓸 수 없다 — subject 가 유일하게 저장되는
// 신호다. "automated response"는 9/28 실측 데이터에서 실제로 관찰돼 추가했다(실측 확인).
// 잔여 미탐(문서화, 실측 관찰): "Thank you for contacting …"/"Thanks for your mail" 류
// 문의접수 자동회신은 정형 문구가 너무 다양해서 여기 포함하지 않는다 — 일반 문구("thank
// you"/"thanks")까지 걸면 진짜 사람이 쓴 감사 인사 회신까지 오탐한다. 새로운 정형 패턴이
// 반복 관찰되면 여기 추가한다.
// 2026-09-29(코덱스 2차 리뷰): **앵커링 필수** — 아무 데나 등장하면 매치하던 예전 버전은
// "Re: Automatic reply: Out of Office until 10/5"(자동응답 자체에 대해 사람이 직접 답장한
// 진짜 회신)까지 걸러냈다. 표식은 제목의 **맨 앞**(선택적 "[태그]" 접두 하나는 허용)에서만
// 자동응답으로 인정한다 — "Re:"/"Fwd:" 뒤에 나오면 사람이 자동응답을 인용/전달한 것이라
// 매치하지 않는다.
const AUTO_REPLY_SUBJECT_START_RE =
  /^(?:out[-\s]?of[-\s]?office\b|automatic\s+repl(?:y|ies)\b|automated\s+repl(?:y|ies)\b|auto[-\s]?repl(?:y|ies)\b|autoresponder\b|automated\s+respons(?:e|es)\b|vacation\s+repl(?:y|ies)\b|자동\s?응답|자동\s?회신|부재\s?중)/i;

function isIdentifiableAutoReplySubject(row: CanonicalRow): boolean {
  const subject = safeString(row.subject).trim();
  // 앞에 붙는 대괄호 태그 하나는 무시하고 그 뒤에서 표식을 찾는다 — "[자동응답] 부재중입니다"
  // 같은 실제 표기를 놓치지 않기 위함. 태그가 없으면 원문 그대로 검사한다.
  const withoutLeadingTag = subject.replace(/^\[[^\]]{0,40}\]\s*/, "");
  return AUTO_REPLY_SUBJECT_START_RE.test(withoutLeadingTag);
}

// 2026-09-29(코덱스 리뷰): receivedAtIso 는 발신자 메일 클라이언트의 Date 헤더가 우선이고
// (mailImapLive.ts liveInboundFromParsed), IMAP internalDate 는 그 헤더가 없을 때만 쓰인다.
// 발신자 시계가 틀리면 실제로는 그날 도착한 회신이 다른 KST 날짜로 샌다. Firestore 문서의
// createTime(서버가 실제로 문서를 쓴 시각, rowOf 가 __firestoreCreateTimeIso 로 투영)을
// 우선하고, 그 메타데이터가 없는 경우(테스트 더블 등)만 receivedAtIso 로 되돌아간다.
function replyEventMsForWindowing(row: CanonicalRow): number | null {
  const createTimeMs = isoMillis(row.__firestoreCreateTimeIso);
  return createTimeMs !== null ? createTimeMs : isoMillis(row.receivedAtIso);
}

/**
 * "그날 실제로 크리에이터에게서 온 회신인가" — 콜드메일 귀속(isEligibleOutreachReply)과 달리
 * matchedOutboundRef/식별 해시를 요구하지 않는다. mail-daemon/반송, 내부 @supercent.io,
 * scp@ 자신, (식별 가능한 경우) 자동응답/부재중만 제외한다.
 */
export function isCountableInboundCreatorReply(row: CanonicalRow): boolean {
  if (safeString(row.direction).toLowerCase() !== "inbound") return false;
  const route = (safeString(row.route) || safeString(row.inboundRoute)).toLowerCase();
  if (route && route !== "creator_reply") return false;
  if (isIdentifiableAutoReplySubject(row)) return false;
  if (isIdentifiableBounceSubject(row)) return false;
  if (isBounceSenderFromField(row)) return false;
  // 2026-09-29(코덱스 3차 리뷰): 주소 기반 제외(내부망/scp@ 자신/mailer-daemon)는 **실제
  // 봉투 발신자(from)** 로만 판정한다 — creatorEmail 은 귀속 값이라 안 쓴다(위 주석 참고).
  // 크리에이터 식별(distinct count)은 여전히 creatorEmail 우선이 맞다 — 그건
  // inboundReplySenderAddress 가 별도로 담당한다.
  const fromAddress = extractReplySenderAddress(safeString(row.from));
  if (fromAddress) {
    if (fromAddress === CANONICAL_OPERATIONAL_MAILBOX_V1) return false;
    if (isSupercentInternalAddress(fromAddress)) return false;
    if (isBounceSenderAddress(fromAddress)) return false;
  }
  return true;
}

// 2026-09-29(코덱스 3차 리뷰): message_sources 인바운드 문서 자체엔 mailAccountId 가 없다
// (chat-ai.ts persistReceivedEmail 의 sourceData 는 이 필드를 안 쓴다 — conversations 문서
// 에만 쓰인다). 그래서 "행에 mailAccountId 가 없으면 scp"는 **틀린 가정**이었다(개인
// 메일함도 똑같이 비어 있다 — 리뷰 재현: personalMailboxCount 가 항상 0). 연결된 대화
// (conversations/{conversationId}.mailAccountId)에서 읽어야 한다 — 대화를 못 찾으면(레거시,
// 삭제, conversationId 부재) 행 자체의 mailAccountId 를 폴백으로만 쓴다(표준 경로엔 없지만
// 다른 적재 경로가 남길 수 있어 방어적으로 유지). 그래도 못 정하면 "scp"라고 **가정하지
// 않는다** — scp 헤드라인은 반드시 긍정적으로 확인된 것만 센다.
function mailboxIsScp(mailAccountId: string): boolean {
  return mailAccountId === "" || mailAccountId === "scp";
}

function isScpRow(row: CanonicalRow, mailAccountIdByConversation: Readonly<Record<string, string>>): boolean {
  const conversationId = safeString(row.conversationId);
  if (conversationId && Object.prototype.hasOwnProperty.call(mailAccountIdByConversation, conversationId)) {
    const conversationMailAccountId = safeString(mailAccountIdByConversation[conversationId]);
    if (conversationMailAccountId) return mailboxIsScp(conversationMailAccountId);
    // A blank account on a legacy conversation usually means SCP, but an explicit
    // row-level personal account is stronger evidence for nonstandard import paths.
    const rowLevelMailAccountId = safeString(row.mailAccountId);
    if (rowLevelMailAccountId) return mailboxIsScp(rowLevelMailAccountId);
    return true;
  }
  const rowLevelMailAccountId = safeString(row.mailAccountId);
  if (rowLevelMailAccountId) return mailboxIsScp(rowLevelMailAccountId);
  return false;
}

// 2026-09-29(코덱스 리뷰): 같은 물리 메일이 scp@ 와 개인(workspace_oauth) 메일함에 동시에
// 닿으면 서로 다른 message_sources 문서가 된다 — mailImapLive.ts stableInboundMessageRef 가
// 비-scp 계정에는 accountId 를 접두해서 dedupeKey 를 **의도적으로** 계정별로 다르게 만들기
// 때문이다(각 메일함 안에서는 독립적으로 멱등하려고). providerMessageIdHash 는 이메일 자체의
// Message-ID 해시라 어느 메일함으로 들어왔든 동일하다 — 이걸 우선해 그룹핑한다.
function replyDedupeKey(row: CanonicalRow): string {
  return safeString(row.providerMessageIdHash) || safeString(row.dedupeKey) || safeString(row.ref) || row.id;
}

/**
 * 헤드라인은 scp@ 로 스코프한다(오너가 비교하는 대상이 scp@ Gmail 수신함이므로) — 개인
 * 메일함에만 닿은 회신은 별도의 작은 보조 항목(personalMailboxCount)으로만 보고한다.
 * providerMessageIdHash 로 먼저 그룹핑해서 같은 메일이 scp@·개인 메일함 양쪽에 동시에 닿아도
 * 한 번만 세고, scp@ 사본이 하나라도 있으면 scp 축으로 잡는다(그래야 오너가 scp@ 에서 실제로
 * 본 회신과 숫자가 맞는다).
 */
async function collectDailyInboundReplyFacts(
  rows: readonly CanonicalRow[],
  window: ReportWindow,
  source: Pick<ScheduledReportSource, "conversationMailAccountIds">,
): Promise<InboundReplyCountFacts> {
  const groups = new Map<string, CanonicalRow[]>();
  for (const row of rows) {
    const eventMs = replyEventMsForWindowing(row);
    if (eventMs === null || !inWindow(eventMs, window)) continue;
    if (!isCountableInboundCreatorReply(row)) continue;
    const key = replyDedupeKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  // 후보로 남은 행들의 conversationId 만 배치 조회한다(하루치라 수십 건 수준 — range 쿼리
  // 아닌 point-read 배치, 필터를 통과 못한 행까지 조회하지 않아 최소한으로 유지한다).
  const conversationIds = new Set<string>();
  for (const group of groups.values()) {
    for (const row of group) {
      const conversationId = safeString(row.conversationId);
      if (conversationId) conversationIds.add(conversationId);
    }
  }
  const mailAccountIdByConversation = conversationIds.size > 0
    ? await source.conversationMailAccountIds([...conversationIds])
    : {};

  const scpCreators = new Set<string>();
  let scpCount = 0;
  let scpUnidentifiedMessages = 0;
  let personalMailboxCount = 0;
  for (const group of groups.values()) {
    const scpRow = group.find((row) => isScpRow(row, mailAccountIdByConversation));
    if (!scpRow) {
      // 2026-09-29(코덱스 2차 리뷰): providerMessageIdHash 가 없는 메일은 dedupeKey 가
      // 메일함별로 갈려서(mailImapLive.ts 접두 규칙) scp@ 사본이 **다른 그룹**으로 쪼개져
      // 있을 수 있다 — 이 그룹에 scp@ 행이 없다는 것만으로 "개인 메일함 전용"이라고 확신할
      // 수 없다. 그룹 안 어떤 행도 providerMessageIdHash 를 갖지 않으면(교차 메일함 식별
      // 근거 자체가 없으면) personalMailboxCount 에서 아예 뺀다 — 과다보고보다 누락이 낫다.
      const hasCrossMailboxIdentity = group.some((row) => safeString(row.providerMessageIdHash) !== "");
      if (hasCrossMailboxIdentity) personalMailboxCount += 1;
      continue;
    }
    scpCount += 1;
    const address = inboundReplySenderAddress(scpRow);
    // 발신자를 식별 못한 메시지는(레거시 문서 등) 서로 다른 사람으로 보수적으로 센다 —
    // 합쳐 세면 실제보다 적은 크리에이터 수를 보고하게 된다.
    if (address) scpCreators.add(address);
    else scpUnidentifiedMessages += 1;
  }
  return {
    status: "complete",
    count: scpCount,
    distinctCreators: scpCreators.size + scpUnidentifiedMessages,
    personalMailboxCount,
  };
}

export function createFirestoreScheduledReportSource(): ScheduledReportSource {
  const rangeRows = async (
    collection: string,
    field: string,
    startIso: string,
    endIso: string,
    selectedFields: string[],
  ): Promise<CanonicalRow[]> => {
    const snapshot = await adminDb.collection(collection)
      .where(field, ">=", startIso)
      .where(field, "<", endIso)
      .select(...selectedFields)
      .get();
    return snapshot.docs.map(rowOf);
  };

  return {
    // `source` is filtered in memory so the existing single-field sentAtIso index is sufficient.
    // The metric population is still exactly source == "campaign_outreach".
    sentRows: (startIso, endIso) => rangeRows(
      // W82 R1-C1: `emailHash` 가 **프로젝션에 없어서** 콜드 접촉이 0건이었다. select() 가
      //   필드를 자르는데 소비부는 그 필드를 읽는다 — 조인이 조용히 전멸하고 전환이 전부
      //   독려로 몰린다. 계약이 이 필드 집합 자체를 고정한다(행 주입으로는 안 잡힌다).
      "scp_coldmail_history", "sentAtIso", startIso, endIso, ["sentAtIso", "source", "emailHash"],
    ),
    // 2026-09-29: from/creatorEmail/subject/conversationId 를 추가 투영했다 — 총 인바운드
    //   회신 집계(방어적 발신자 제외: 내부망/scp@/mail-daemon, scp@ 메일함 스코프)가 이 같은
    //   range 쿼리 결과를 재사용한다(추가 read 없음). 귀속 판정(isEligibleOutreachReply)이
    //   읽는 필드 집합은 그대로라 funnel 데이터셋은 불변. mailAccountId 는 표준 인입 경로의
    //   message_sources 문서엔 실제로 없다(3차 리뷰 실측 — conversations 문서에만 쓰인다)지만,
    //   다른 적재 경로가 남길 가능성에 대비한 폴백 신호로 계속 투영해 둔다.
    replyRows: (startIso, endIso) => rangeRows(
      "message_sources", "receivedAtIso", startIso, endIso,
      [
        "dedupeKey", "direction", "inboundAttributionAmbiguous", "matchedOutboundRef",
        "matchedOutboundTrackingId", "providerMessageIdHash", "receivedAtIso", "route", "inboundRoute",
        "from", "creatorEmail", "subject", "mailAccountId", "conversationId",
      ],
    ),
    applicationRows: async (startIso, endIso) => {
      const [management, program] = await Promise.all([
        rangeRows(
          // R1-C1 과 같은 부류: 조인 키가 프로젝션에 없었다. 이 컬렉션의 applicationId 는
          //   최상위가 아니라 `identity.applicationId` 다 — 그래서 소비부가 아무것도 못 읽었다.
          //   (종전에는 문서 ID 폴백이 우연히 맞아 가려져 있었다. 폴백은 영상 아웃박스에서
          //    100% 빗나가므로 제거했고, 그 순간 이 결함이 드러났다.)
          "scp_application_management", "submittedAtIso", startIso, endIso,
          ["submittedAtIso", "identity"],
        ),
        rangeRows(
          "program_applications", "submittedAtIso", startIso, endIso,
          ["submittedAtIso"],
        ),
      ]);
      return [
        ...management.map((row) => ({ ...row, sourceType: "scp_application_management" })),
        ...program.map((row) => ({ ...row, sourceType: "program_applications" })),
      ];
    },
    // W82: 전환 식별 해시. createdAtIso 단일 필드 범위 — 신규 복합 인덱스 0.
    conversionIdentityRows: async (startIso, endIso) => {
      const [confirmed, submitted] = await Promise.all([
        rangeRows(
          "scp_application_confirmed_mail_outbox", "createdAtIso", startIso, endIso,
          ["createdAtIso", "applicationId", "recipientEmailHash"],
        ),
        rangeRows(
          "scp_content_submitted_mail_outbox", "createdAtIso", startIso, endIso,
          ["createdAtIso", "applicationId", "recipientEmailHash", "videoSubmissionId"],
        ),
      ]);
      return [
        ...confirmed.map((row) => ({ ...row, identityType: "application" })),
        ...submitted.map((row) => ({ ...row, identityType: "video" })),
      ];
    },
    // W81: sentAtIso 단일 필드 범위 — 기존 인덱스로 충분하다(mailPurpose 는 메모리에서 거른다).
    //   신규 복합 인덱스를 만들지 않는다(W75 P0-1 전례: 인덱스 누락은 매시간 전사한다).
    nudgeSendRows: (startIso, endIso) => rangeRows(
      "mail_outbound_log", "sentAtIso", startIso, endIso,
      // R1-H3: `likelyRecipientOpenCount` 는 코드 전체에서 increment(0) 뿐이라 **항상 0** 이다
      //   (mailSignature.ts). 그래서 실제로는 폴백인 원시 openCount 가 지표였고, 그건 프리페치를
      //   포함한다. 신뢰도 축(openConfidence)과 억제 사유를 함께 읽어 판정에 쓴다.
      // W118: `deliveryState` 를 **반드시** 투영한다. 이 필드가 없으면 하류
      //   (`nudgeSendRowFrom`)가 차단 행을 걸러낼 수가 없다 — 실제로 그래서 정지 기간 내내
      //   0통 나간 날의 독려가 수천 건 발송으로 보고됐다.
      ["sentAtIso", "mailPurpose", "templateKind", "to", "toHash", "openCount",
        "likelyRecipientOpenCount", "openConfidence", "openSuppressionReason",
        "deliveryState"],
    ),
    videoSubmissionRows: async (startIso, endIso) => {
      const [heads, outbox] = await Promise.all([
        rangeRows(
          "scp_video_review_state", "currentRevisionSubmittedAtIso", startIso, endIso,
          ["currentRevisionSubmittedAtIso", "revision", "videoSubmissionId"],
        ),
        rangeRows(
          // R1-C2: `applicationId` 가 없어 문서 ID 로 폴백 조인했는데, 그 ID 는
          //   applicationId 가 아니라 sha256(sub:rev) 다 → 영상 귀속 100% 미조인이었다.
          "scp_content_submitted_mail_outbox", "createdAtIso", startIso, endIso,
          ["createdAtIso", "videoRevision", "videoSubmissionId", "applicationId"],
        ),
      ]);
      return [
        ...heads.map((row) => ({ ...row, sourceType: "review_head" })),
        ...outbox.map((row) => ({ ...row, sourceType: "revision_outbox" })),
      ];
    },
    conversationMailAccountIds: async (conversationIds) => {
      const uniqueIds = [...new Set(conversationIds.filter((id) => id))];
      if (uniqueIds.length === 0) return {};
      const snapshots = await adminDb.getAll(
        ...uniqueIds.map((id) => adminDb.collection("conversations").doc(id)),
        { fieldMask: ["mailAccountId"] },
      );
      const result: Record<string, string> = {};
      snapshots.forEach((snapshot, index) => {
        if (snapshot.exists) result[uniqueIds[index]] = safeString(snapshot.data()?.mailAccountId);
      });
      return result;
    },
  };
}

/**
 * W81 — 전일 구간의 레인 분해.
 *
 * 콜드 접촉은 `scp_coldmail_history`(source campaign_outreach), 독려 접촉은 `mail_outbound_log`
 * 의 독려 purpose 행이다. 두 접촉을 한 배열로 합쳐 **라스트터치**를 계산하므로,
 * 콜드 Apply 에서 독려분을 빼는 별도 보정이 필요 없다(빼기는 순서 의존·음수 위험이 있다).
 *
 * 접촉 조회 창은 전환 창보다 **7일 앞선다** — 어제 전환한 사람의 마지막 접촉이 그저께일 수 있다.
 */
async function collectLaneSplit(
  source: ScheduledReportSource,
  window: ReportWindow,
): Promise<LaneSplitFacts> {
  const contactStartIso = new Date(window.startMs - NUDGE_ATTRIBUTION_WINDOW_MS).toISOString();
  const endIso = new Date(window.endMs).toISOString();
  const startIso = new Date(window.startMs).toISOString();
  // R1-H2: 식별 아웃박스는 전환과 **같은 시각에 생기지 않는다** — recipientEmailHash 는 드레인
  //   성공 후에야 붙고(수 시간 지연), 수리 경로의 createdAtIso 는 수리 시각이다. 전환 창과
  //   똑같이 자르면 마진 0 이라 조인이 통째로 빗나간다. 양방향으로 넉넉히 넓힌다 —
  //   이 컬렉션은 전환당 1행이라 범위를 넓혀도 읽기량이 폭증하지 않는다.
  const identityStartIso = new Date(window.startMs - IDENTITY_LOOKUP_MARGIN_MS).toISOString();
  const identityEndIso = new Date(window.endMs + IDENTITY_LOOKUP_MARGIN_MS).toISOString();

  // 소스 하나가 던져도 나머지를 살린다. Promise.all 로 묶으면 실패한 형제의 rejection 이
  //   미처리로 새어 나가고(기존 계약이 실패 소스를 일부러 던진다), 레인 분해가 리포트 전체를
  //   흔든다. 분해는 **보조 축**이므로 빠진 소스는 빈 배열로 두고 계속 간다.
  //   W110 리뷰(HIGH): 다만 **조용히** 접으면 안 된다. 종전엔 로그 한 줄도 없이 빈 배열이 돼서
  //   독려 로그 조회가 실패해도 "독려 발송 0건"이 정상 문면처럼 나갔다(사후 진단도 불가).
  //   captureDataset 과 같은 관례로 흔적을 남기고, 어느 축이 죽었는지 사실로 위에 전달한다.
  const failedSources = new Set<string>();
  const safeRows = async (label: string, load: () => Promise<CanonicalRow[]>): Promise<CanonicalRow[]> => {
    try {
      return await load();
    } catch {
      console.warn("[slack-scheduled-reports]", JSON.stringify({ outcome: "source_unavailable", laneSource: label }));
      failedSources.add(label);
      return [];
    }
  };
  const [coldRows, nudgeRows, applicationRows, videoRows, identityRows] = await Promise.all([
    safeRows("sent", () => source.sentRows(contactStartIso, endIso)),
    safeRows("nudgeSend", () => source.nudgeSendRows(contactStartIso, endIso)),
    safeRows("application", () => source.applicationRows(startIso, endIso)),
    safeRows("videoSubmission", () => source.videoSubmissionRows(startIso, endIso)),
    safeRows("conversionIdentity", () => source.conversionIdentityRows(identityStartIso, identityEndIso)),
  ]);

  // W82: applicationId → 수신자 식별 해시. 전환 원장에는 식별자가 없지만 같은 전환의
  //   outbox 가 갖고 있다(실측). 24자로 통일한다 — 접촉 원장(콜드 emailHash · 로그 toHash)이
  //   쓰는 형태이고, outbox 는 64자라 그대로 두면 조인이 전부 어긋난다.
  const identityByApplicationId = new Map<string, string>();
  const identityByVideoSubmissionId = new Map<string, string>();
  for (const row of identityRows) {
    const record = row as Record<string, unknown>;
    const hash = toRecipientIdentityHash(record.recipientEmailHash);
    if (!hash) continue;
    const applicationId = safeString(record.applicationId);
    if (applicationId) identityByApplicationId.set(applicationId, hash);
    // R1-C2: 영상 전환은 applicationId 로 안 잡히는 행(review_head)이 있어 제출 ID 축도 둔다.
    const videoSubmissionId = safeString(record.videoSubmissionId);
    if (videoSubmissionId) identityByVideoSubmissionId.set(videoSubmissionId, hash);
  }

  const nudgeSends: NudgeSendRow[] = [];
  for (const row of nudgeRows) {
    const parsed = nudgeSendRowFrom(row as Record<string, unknown>);
    if (parsed) nudgeSends.push(parsed);
  }
  // W114-fix: nudgeRows/nudgeSends 는 귀속 라스트터치용으로 일부러 넓힌 창
  //   (window.startMs - 7일 .. window.endMs) 전체를 담는다 — 아래 contacts[] 와
  //   openedAtByKey 는 그 넓은 창이 그대로 필요하다(옛 접촉·옛 열람도 귀속 후보여야 한다).
  //   하지만 "발송" 사실(sent/byCohort/opened) 은 **이 window 하나만** 세야 한다 —
  //   콜드 축(facts.daily.sent)이 이벤트 단위로 daily 창까지 되좁히는 것과 같은 원칙이다.
  //   되좁히지 않으면 8일치 발송 전부가 "어제 발송"으로 보고된다(W81/W110 사고 재현 확인).
  const nudgeSendsInWindow = nudgeSends.filter(
    (send) => send.sentAtMs >= window.startMs && send.sentAtMs < window.endMs,
  );
  // 2026-09-27(헤세 지시): 요약 채널의 "무슨 메일이 나갔는지" 축 — 자동답장은 독려 코호트
  //   판정(NUDGE_PURPOSE_TO_COHORT)에 안 걸려 nudgeSendRowFrom 이 조용히 버리므로, 같은
  //   nudgeRows(mail_outbound_log, 이 window 만) 에서 mailPurpose 로 직접 센다. W118 과 같은
  //   이유로 isDeliveredOutboundLogRow 를 반드시 같이 걸러야 한다 — 아니면 mock_sent·blocked·
  //   skipped_duplicate 행까지 "자동답장 발송"으로 보고한다(모의/차단 발송을 실발송처럼 위장).
  const autoReplySentInWindow = nudgeRows.filter((row) => {
    const record = row as Record<string, unknown>;
    if (record.mailPurpose !== "auto_reply") return false;
    if (!isDeliveredOutboundLogRow(record)) return false;
    const sentAtMs = isoMillis(record.sentAtIso);
    return sentAtMs !== null && sentAtMs >= window.startMs && sentAtMs < window.endMs;
  }).length;

  const contacts: ContactEvent[] = [];
  // 접촉도 **해시 축**으로 통일한다. 콜드 이력은 emailHash, 독려 로그는 toHash 를 이미 갖는다.
  //   평문 이메일을 조인 키로 쓰면 전환 쪽(해시만 존재)과 영원히 안 맞는다.
  for (const row of coldRows) {
    if (safeString(row.source) !== "campaign_outreach") continue;
    const record = row as Record<string, unknown>;
    const key = toRecipientIdentityHash(record.emailHash)
      || recipientIdentityHash(record.email ?? record.emailLower);
    const sentAtMs = isoMillis(row.sentAtIso);
    if (!key || sentAtMs === null) continue;
    contacts.push({ email: key, lane: "cold", sentAtMs });
  }
  for (const send of nudgeSends) {
    if (!send.identityKey) continue;
    contacts.push({ email: send.identityKey, lane: "nudge", sentAtMs: send.sentAtMs });
  }

  // W81 [실측 확인]: 전환 원장(scp_application_management)에는 이메일도 해시도 없다 —
  //   identity 전 필드 null, revisions 0(프로드 2026-08-14 실측). 즉 라스트터치 귀속의 조인 키가
  //   **아직 존재하지 않는다.** 이때 0을 찍으면 "전환이 없었다"로 읽히는 거짓 보고가 된다.
  //   그래서 조인 가능한 행이 하나도 없으면 숫자 대신 **미측정**으로 드러낸다.
  let conversionRowsSeen = 0;
  let conversionRowsJoinable = 0;
  /**
   * 전환 행 → 귀속 이벤트.
   *
   * R1-H1: 조인 실패를 `continue` 로 흘려보내면 그 전환은 **어디에도 안 잡힌다**(unattributed
   *   에도 안 들어간다). 그래서 seen/joinable 을 같이 세고, 아래에서 **조인율**로 측정 가능
   *   여부를 판정한다 — 1건만 붙어도 확신 있게 렌더하던 게 종전 결함이다.
   */
  const conversionsFrom = (rows: CanonicalRow[], field: string): ConversionEvent[] => {
    const events: ConversionEvent[] = [];
    for (const row of rows) {
      const record = row as Record<string, unknown>;
      const atMs = isoMillis(record[field]);
      if (atMs === null) continue;
      if (atMs < window.startMs || atMs >= window.endMs) continue;
      conversionRowsSeen += 1;
      // 전환 원장에는 식별자가 없다 — applicationId(없으면 영상 제출 ID)로 아웃박스 해시를 끌어온다.
      //   문서 ID 폴백은 쓰지 않는다: 그 ID 는 applicationId 가 아니라 해시라 100% 빗나간다(R1-C2).
      const applicationId = safeString(record.applicationId)
        || safeString((record.identity as Record<string, unknown> | undefined)?.applicationId);
      const videoSubmissionId = safeString(record.videoSubmissionId);
      const email = (applicationId ? identityByApplicationId.get(applicationId) : undefined)
        ?? (videoSubmissionId ? identityByVideoSubmissionId.get(videoSubmissionId) : undefined)
        ?? "";
      if (!email) continue;
      conversionRowsJoinable += 1;
      events.push({ email, atMs });
    }
    return events;
  };

  // R1-H2: `program_applications` 에는 아웃박스 writer 가 없다 — 구조적으로 영원히 미조인이다.
  //   그걸 분모에 넣으면 조인율이 영구히 낮아 전체가 미측정으로 떨어진다. 축을 분리하고
  //   "이 경로는 못 잰다"를 따로 보고한다(조용히 빼면 숫자가 맞는 것처럼 보인다).
  const attributableApplicationRows = applicationRows.filter(
    (row) => safeString(row.sourceType) !== "program_applications",
  );
  const unmeasurableApplicationRows = applicationRows.length - attributableApplicationRows.length;
  const appliedEvents = conversionsFrom(attributableApplicationRows, "submittedAtIso");

  // R1-M1: review_head 와 revision_outbox 는 **같은 제출**을 두 번 말한다. 기존 4지표와 같은 키
  //   (`${videoSubmissionId}:revision:${revision}`)로 합친다 — 안 하면 영상 전환이 2배로 부푼다.
  const videoSeen = new Set<string>();
  const dedupedVideoRows: CanonicalRow[] = [];
  for (const row of videoRows) {
    const record = row as Record<string, unknown>;
    const submissionId = safeString(record.videoSubmissionId);
    const revision = safeString(record.revision) || safeString(record.videoRevision);
    const key = submissionId ? `${submissionId}:revision:${revision}` : `row:${safeString(record.id)}`;
    if (videoSeen.has(key)) continue;
    videoSeen.add(key);
    dedupedVideoRows.push(row);
  }
  const videoEvents = [
    ...conversionsFrom(
      dedupedVideoRows.filter((row) => row.sourceType === "review_head"),
      "currentRevisionSubmittedAtIso",
    ),
    ...conversionsFrom(
      dedupedVideoRows.filter((row) => row.sourceType === "revision_outbox"),
      "createdAtIso",
    ),
  ];

  // 열람 후 Apply: 독려를 **열람한** 사람 중 그 창 안에서 Apply 한 수.
  // R1-M3: "열람 후 Apply" 는 **열람이 Apply 보다 앞설 때만** 성립한다. 종전에는 창 전체의
  //   열람자 집합을 썼기 때문에, Apply 뒤에 보낸 독려를 연 사람도 "열람 후 Apply"로 셌다.
  const openedAtByKey = new Map<string, number>();
  for (const send of nudgeSends) {
    if (!send.opened || !send.identityKey) continue;
    const current = openedAtByKey.get(send.identityKey);
    if (current === undefined || send.sentAtMs < current) openedAtByKey.set(send.identityKey, send.sentAtMs);
  }
  const openedThenApplied = appliedEvents.filter((event) => {
    const openedAtMs = openedAtByKey.get(event.email);
    return openedAtMs !== undefined && openedAtMs <= event.atMs;
  }).length;

  return {
    nudge: summarizeNudgeSends(nudgeSendsInWindow),
    applied: attributeConversionsPrecise(appliedEvents, contacts),
    videoSubmitted: attributeConversionsPrecise(videoEvents, contacts),
    openedThenApplied,
    // R1-H1: **조인율**로 판정한다. 종전에는 1건만 붙어도 측정 가능이라, 3중 1만 조인된
    //   상태에서도 확신 있게 숫자를 냈다(나머지는 unattributed 에도 안 잡히고 증발).
    //   임계 미만이면 미측정으로 강등하고, 넘더라도 렌더에 (귀속 N/M)을 함께 적는다.
    // W110 리뷰(HIGH): 조인율이 아무리 좋아도 **소스가 죽었으면** 그건 측정된 게 아니다.
    //   실패 시 분자·분모가 같이 0 이라 비율 판정은 통과해 버린다(0/0 → 측정 가능).
    //   재검 지적(MEDIUM): nudgeSend 도 포함해야 한다. contacts 의 독려 레인이 nudgeSends 로만
    //   채워지므로, 그 소스가 죽으면 applied.nudge 가 구조적으로 0 에 붙잡히거나 콜드로 오귀속된다.
    //   빼면 "발송: 측정 불가" 바로 다음 줄이 같은 축에 확신 있는 "0%" 를 찍는 자기모순이 된다.
    attributionMeasurable: !failedSources.has("sent")
      && !failedSources.has("nudgeSend")
      && !failedSources.has("application")
      && !failedSources.has("videoSubmission")
      && !failedSources.has("conversionIdentity")
      && (conversionRowsSeen === 0
        || conversionRowsJoinable / conversionRowsSeen >= ATTRIBUTION_JOIN_RATE_FLOOR),
    nudgeMeasurable: !failedSources.has("nudgeSend"),
    autoReplySent: autoReplySentInWindow,
    conversionRowsSeen,
    conversionRowsJoinable,
    unmeasurableApplicationRows,
  };
}

export async function collectScheduledReportFacts(
  nowMs: number,
  source: ScheduledReportSource = createFirestoreScheduledReportSource(),
): Promise<ScheduledReportFacts> {
  const windows = buildScheduledReportWindows(nowMs);
  const startIso = new Date(earliestReadMs(windows)).toISOString();
  const endIso = new Date(windows.daily.endMs).toISOString();

  // W81: 레인 분해는 전일 구간에만 붙인다(누계는 같은 구조로 다음 라운드).
  //   실패가 기존 리포트를 죽이면 안 된다 — 분해가 없으면 종전 문면 그대로 나간다.
  // R1-M4: 4지표보다 **앞에서 직렬로** 돌면 함수 예산(timeoutSeconds 120 · 256MiB)에 그대로
  //   더해진다. 같은 Promise.all 에 넣어 병렬로 돌린다 — 순서 의존이 없다.
  // W110: 누계 레인 분해는 월요일에만 돈다(누계 블록이 월요일에만 나간다).
  const cumulativeLane = (window: ReportWindow): Promise<LaneSplitFacts | undefined> =>
    windows.includeWeekly ? collectLaneSplit(source, window).catch(() => undefined) : Promise.resolve(undefined);

  // 2026-09-29: replyRows(range) 는 귀속 판정(replied)과 총 회신 집계(dailyInboundReplies)가
  //   같이 소비한다 — 한 번만 fetch 해서 두 지표 모두 파생시킨다(추가 Firestore read 없음).
  // 2026-09-29(코덱스 2차 리뷰): 이 쿼리 자체는 receivedAtIso 로 경계를 긋는다 — createTime 은
  //   문서 메타데이터라 .where() 로 걸 수 없고(쿼리 가능한 인입시각 필드 자체가 없다), 그래서
  //   발신자 시계가 앞뒤로 튀어 receivedAtIso 가 경계 밖으로 나가면 그날 실제로 저장된 문서도
  //   애초에 fetch 되지 않는다(replyEventMsForWindowing 이 아무리 createTime 우선이어도 행
  //   자체가 없으면 무용지물). ±2일 마진으로 넓게 읽은 뒤 그 함수가 정확히 좁힌다 — 이 마진은
  //   회신 두 지표(귀속·총계)에만 적용되고, 귀속(replied)의 최종 값은 그 자신의 window 필터가
  //   그대로 걸려서 안 바뀐다(더 넓게 읽어도 원래 안 세던 날짜는 여전히 안 센다).
  const REPLY_QUERY_CLOCK_SKEW_MARGIN_MS = 2 * DAY_MS;
  const replyQueryStartIso = new Date(Date.parse(startIso) - REPLY_QUERY_CLOCK_SKEW_MARGIN_MS).toISOString();
  const replyQueryEndIso = new Date(Date.parse(endIso) + REPLY_QUERY_CLOCK_SKEW_MARGIN_MS).toISOString();
  type ReplyRowsFetchResult = { ok: true; rows: CanonicalRow[] } | { ok: false };
  const replyRowsFetch: Promise<ReplyRowsFetchResult> = (async () => {
    try {
      return { ok: true, rows: await source.replyRows(replyQueryStartIso, replyQueryEndIso) };
    } catch {
      console.warn("[slack-scheduled-reports]", JSON.stringify({ outcome: "source_unavailable", metric: "replied" }));
      return { ok: false };
    }
  })();

  const [
    laneSplitResult,
    previousWeekLaneResult,
    monthToDateLaneResult,
    sent,
    replied,
    applied,
    videoSubmitted,
  ] = await Promise.all([
    collectLaneSplit(source, windows.daily).catch(() => undefined),
    cumulativeLane(windows.previousWeek),
    cumulativeLane(windows.monthToDate),
    captureDataset("sent", async () => {
      const rows = await source.sentRows(startIso, endIso);
      return { eventTimesMs: parsedTimes(rows.filter((row) => row.source === "campaign_outreach"), "sentAtIso") };
    }),
    (async (): Promise<MetricDataset> => {
      const fetched = await replyRowsFetch;
      if (!fetched.ok) return { eventTimesMs: [], unavailableReason: `${METRIC_LABELS.replied} 정본 조회 실패` };
      const eligible = fetched.rows.filter((row) => isEligibleOutreachReply(row as OutreachReplyRecord));
      return { eventTimesMs: parsedTimes(eligible, "receivedAtIso") };
    })(),
    captureDataset("applied", async () => ({
      eventTimesMs: parsedTimes(await source.applicationRows(startIso, endIso), "submittedAtIso"),
    })),
    captureDataset("videoSubmitted", async () => ({
      eventTimesMs: submissionEventTimes(await source.videoSubmissionRows(startIso, endIso)),
    })),
  ]);

  const replyRowsFetched = await replyRowsFetch;
  const inboundRepliesUnavailable: InboundReplyCountFacts =
    { status: "unavailable", reason: `${METRIC_LABELS.replied} 정본 조회 실패`, count: 0, distinctCreators: 0, personalMailboxCount: 0 };
  const dailyInboundReplies: InboundReplyCountFacts = replyRowsFetched.ok
    // 대화 mailAccountId 배치 조회(conversationMailAccountIds)가 실패하면 scp@ 스코프 판정
    // 자체가 불가능하다 — 0으로 위장하지 않고 이 지표 전체를 측정 불가로 남긴다(다른 축과
    // 같은 원칙).
    ? await collectDailyInboundReplyFacts(replyRowsFetched.rows, windows.daily, source).catch(() => inboundRepliesUnavailable)
    : inboundRepliesUnavailable;

  const datasets = { sent, replied, applied, videoSubmitted };
  const dailyMetrics = metricsForWindow(datasets, windows.daily);
  const previousWeekMetrics = metricsForWindow(datasets, windows.previousWeek);
  const monthToDateMetrics = metricsForWindow(datasets, windows.monthToDate);
  // R1-M2: 콜드 발송이 측정 불가면 분해의 분모(coldSent)가 0으로 접혀 "콜드 0건 · Apply 0%"
  //   같은 자기모순 문면이 나간다. 4지표와 같은 정책으로, 그때는 분해를 통째로 생략한다.
  //   W110: 누계 구간도 **그 구간의** 발송 완전성으로 각각 판정한다(전일이 온전해도 누계는 아닐 수 있다).
  const laneSplit = dailyMetrics.sent.status === "complete" ? laneSplitResult : undefined;

  return {
    windows,
    laneSplit,
    laneSplitPreviousWeek: previousWeekMetrics.sent.status === "complete" ? previousWeekLaneResult : undefined,
    laneSplitMonthToDate: monthToDateMetrics.sent.status === "complete" ? monthToDateLaneResult : undefined,
    dailyInboundReplies,
    daily: dailyMetrics,
    weekToDate: metricsForWindow(datasets, windows.weekToDate),
    monthToDate: monthToDateMetrics,
    previousMonthSamePeriod: metricsForWindow(datasets, windows.previousMonthSamePeriod),
    previousWeek: previousWeekMetrics,
    weekBeforePrevious: metricsForWindow(datasets, windows.weekBeforePrevious),
    previousMonth: metricsForWindow(datasets, windows.previousMonth),
    monthBeforePrevious: metricsForWindow(datasets, windows.monthBeforePrevious),
  };
}

function formatMetric(metric: ReportMetric, cumulative = false): string {
  if (metric.status === "unavailable") return `측정 불가(${metric.reason})`;
  const prefix = cumulative ? "누계 " : "";
  const count = metric.count.toLocaleString("ko-KR");
  return metric.status === "lower_bound"
    ? `${prefix}${count}건 ⚠️하한값(${metric.reason})`
    : `${prefix}${count}건`;
}

export function formatSendConversionRate(metric: ReportMetric, sent: ReportMetric): string {
  if (sent.status === "unavailable") return `비율 계산 불가(${sent.reason})`;
  if (sent.status === "lower_bound") return `비율 계산 불가(발송 하한값: ${sent.reason})`;
  if (metric.status === "unavailable") return `비율 계산 불가(${metric.reason})`;
  if (metric.status === "lower_bound") return `비율 계산 불가(하한값: ${metric.reason})`;
  if (sent.count === 0) return "비율 계산 불가(발송 0건)";
  return `${(metric.count / sent.count * 100).toFixed(1)}%`;
}

function formatMetricWithConversion(
  key: ScheduledMetricKey,
  values: Record<ScheduledMetricKey, ReportMetric>,
  cumulative = false,
): string {
  const metric = formatMetric(values[key], cumulative);
  if (key !== "replied" && key !== "applied") return metric;
  const rate = formatSendConversionRate(values[key], values.sent);
  return rate.startsWith("비율 계산 불가") ? `${metric} · ${rate}` : `${metric} (${rate})`;
}

function comparisonReason(metric: ReportMetric, interval: string): string | null {
  if (metric.status === "complete") return null;
  return metric.status === "lower_bound"
    ? `${interval} 하한값: ${metric.reason}`
    : `${interval} ${metric.reason}`;
}

export function formatPeriodComparison(
  current: ReportMetric,
  previous: ReportMetric,
  labels: { current: string; previous: string },
  forcedReason?: string,
): string {
  if (forcedReason) return `비교 불가(${forcedReason})`;
  const currentReason = comparisonReason(current, labels.current);
  if (currentReason) return `비교 불가(${currentReason})`;
  const previousReason = comparisonReason(previous, labels.previous);
  if (previousReason) return `비교 불가(${previousReason})`;
  if (current.status !== "complete" || previous.status !== "complete") return "비교 불가(구간 불완전)";
  if (previous.count === 0) return `비교 불가(${labels.previous} 0건)`;
  const percentage = (current.count - previous.count) / previous.count * 100;
  const sign = percentage > 0 ? "+" : "";
  return `${sign}${percentage.toFixed(1)}%`;
}

function rangeLabel(window: ReportWindow): string {
  if (window.endMs <= window.startMs) return `${kstDateString(window.startMs)} (완료일 없음)`;
  const start = kstDateString(window.startMs);
  const end = kstDateString(window.endMs - 1);
  return start === end ? start : `${start}~${end}`;
}

function metricLines(values: Record<ScheduledMetricKey, ReportMetric>, cumulative: boolean): string[] {
  return METRIC_KEYS.map((key) => `• ${METRIC_LABELS[key]}: ${formatMetricWithConversion(key, values, cumulative)}`);
}

function comparisonLines(
  current: Record<ScheduledMetricKey, ReportMetric>,
  previous: Record<ScheduledMetricKey, ReportMetric>,
  labels: { current: string; previous: string },
  comparisonLabel: "WoW" | "MoM" | "MoM 동일기간",
  forcedReason?: string,
  currentCumulative = false,
): string[] {
  return METRIC_KEYS.map((key) => [
    `• ${METRIC_LABELS[key]}: ${formatMetricWithConversion(key, current, currentCumulative)}`,
    `${comparisonLabel} ${formatPeriodComparison(current[key], previous[key], labels, forcedReason)}`,
    `${labels.previous} ${formatMetricWithConversion(key, previous)}`,
  ].join(" · "));
}

function monthNumber(window: ReportWindow): number {
  return Number(kstDateString(window.startMs).slice(5, 7));
}

/** 지표에서 셀 수 있는 값만 꺼낸다(unavailable 은 0). 분모로 쓰이므로 조용히 NaN 이 되면 안 된다. */
function metricCount(metric: ReportMetric): number {
  return metric.status === "unavailable" ? 0 : metric.count;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

/**
 * R1-H1: 조인율이 100% 가 아니면 숫자 옆에 그 사실을 적는다. 임계는 넘겼어도 일부는
 *   빠져 있고, 빠진 만큼은 어느 레인에도 안 잡힌다 — 읽는 사람이 그걸 알아야 한다.
 */
function joinNote(split: LaneSplitFacts): string {
  if (split.conversionRowsSeen === 0) return "";
  if (split.conversionRowsJoinable >= split.conversionRowsSeen) return "";
  return ` · 귀속 가능 ${split.conversionRowsJoinable}/${split.conversionRowsSeen}건`;
}

/** R1-H2: 구조적으로 못 재는 경로가 섞여 있으면 그 수를 밝힌다(조용히 빼면 숫자가 맞아 보인다). */
function unmeasurableNote(split: LaneSplitFacts): string {
  return split.unmeasurableApplicationRows > 0
    ? ` · 귀속 불가 경로 ${split.unmeasurableApplicationRows}건(아웃박스 미생성)`
    : "";
}

/**
 * 회차 요약. 0인 회차는 적지 않는다 — 자리만 차지하고 읽는 사람이 훑을 게 늘어난다.
 * 전부 1회차면 숫자 대신 그 사실만 말한다(가장 흔한 상태다).
 */
function sequenceSummary(bySequence: NudgeSectionFacts["bySequence"]): string {
  const parts: string[] = [];
  if (bySequence.first > 0) parts.push(`1회차 ${bySequence.first}`);
  if (bySequence.second > 0) parts.push(`2회차 ${bySequence.second}`);
  if (bySequence.thirdPlus > 0) parts.push(`3회차+ ${bySequence.thirdPlus}`);
  if (parts.length === 0) return "";
  if (parts.length === 1 && bySequence.first > 0) return "전부 1회차";
  return parts.join(" · ");
}

/**
 * W110 — 콜드/독려 두 섹션(헤세 확정 포맷).
 *   자동중단·상한소진·안전축 라인은 헤세가 뺐다 — 넣지 않는다.
 *   분해가 없으면(집계 실패) 한 줄도 넣지 않는다 — 틀린 숫자보다 없는 게 낫다.
 *
 * ■ W110 변경 (헤세 확정)
 *   1) 콜드 섹션이 **전일 4지표를 그대로 싣는다**. 콜드 발송은 원래부터 `daily.sent` 와
 *      같은 수라 종전 문면은 68을 두 번 보여주고 있었다. 다만 회신·Apply·영상은
 *      **당일 전체**(독려 귀속분 포함)라 제목과 어긋난다 — 그래서 꼬리 한 줄로 밝힌다.
 *      (콜드 단독 Apply 는 `독려 몫 전환` 라인의 여집합으로 읽는다.)
 *   2) 회차 라인은 0을 지운다(`sequenceSummary`).
 *   3) 종전 `전환(라스트터치·7일): ① … ② … ③ …` 은 **바로 윗줄 코호트 ①②③ 와 축이 달라서**
 *      안 읽혔다. 기호를 버리고 열람/전환을 두 줄로 나눈다.
 */
/**
 * W110 — 누계 구간의 독려 레인 한 줄.
 *
 * ⚠️ 이 숫자는 **추정**이다. 독려 메일에는 발송 식별 토큰이 없고(`scpMail.ts` 의 apply_link 는
 *   정적 URL), 전환 원장에도 outreachId 가 안 실린다(`scpFluApplicationCommand.ts` 는 null 로 쓴다).
 *   그래서 귀속은 클릭이 아니라 **이메일 해시 + 7일 라스트터치**로 추론한 값이다.
 *   문면에 `추정` 을 남기는 이유가 이것이다 — 지우면 실측처럼 읽힌다.
 */
function cumulativeLaneLine(split: LaneSplitFacts | undefined): string[] {
  if (!split) return [];
  // W110 리뷰(HIGH): 독려 로그 조회가 실패했으면 0 이 아니라 "측정 불가"다. 이 줄은 월요일에만
  //   나가므로, 여기서 0 으로 접으면 그 거짓이 다음 월요일까지 정정되지 않는다.
  if (!split.nudgeMeasurable) return ["• 독려 레인: **측정 불가** — 독려 발송 로그 조회 실패"];
  const nudge = split.nudge;
  const head = `• 독려 레인: 발송 ${nudge.sent.toLocaleString("ko-KR")}건 · 열람 ${nudge.opened.toLocaleString("ko-KR")}건(추정 · ${pct(nudge.opened, nudge.sent)})`;
  return [
    split.attributionMeasurable
      ? `${head} · 독려 몫 Apply ${split.applied.nudge}건 · 영상 제출 ${split.videoSubmitted.nudge}건 (추정·7일 라스트터치)${joinNote(split)}`
      : `${head} · 독려 몫 전환 **미측정** — 귀속 가능 ${split.conversionRowsJoinable}/${split.conversionRowsSeen}건${unmeasurableNote(split)}`,
  ];
}

function laneSplitLines(facts: ScheduledReportFacts, perCampaignLines: readonly string[] = []): string[] {
  const split = facts.laneSplit;
  if (!split) return [];
  const nudge = split.nudge;
  const coldSent = metricCount(facts.daily.sent);
  const sequence = sequenceSummary(nudge.bySequence);
  return [
    // W110 리뷰(HIGH): 독려가 측정 불가면 합계도 낼 수 없다 — 콜드만 더한 값을 "전체"라고 쓰면
    //   그게 가장 눈에 띄는 자리에서 가장 크게 틀린다.
    split.nudgeMeasurable
      ? `*전체 발송: ${coldSent + nudge.sent}건* (콜드 ${coldSent} · 독려 ${nudge.sent})`
      : `*전체 발송: 측정 불가* (콜드 ${coldSent} · 독려 조회 실패)`,
    "",
    "*── 콜드 아웃리치 (신규 접촉)*",
    // 헤세 지시(2026-09-17): 캠페인별 표를 전역 콜드 지표(바로 아래 발송/회신/Apply/영상) **앞에**
    //   붙인다 — "어느 캠페인이 멈췄는지"가 전역 합계보다 먼저 보여야 한다.
    ...perCampaignLines,
    ...metricLines(facts.daily, false),
    "   ※ 회신·Apply·영상은 당일 전체 기준",
    "",
    "*── 독려 (기접촉 팔로업)*",
    ...(split.nudgeMeasurable
      ? [
        `• 발송: ${nudge.sent}건${sequence ? ` · ${sequence}` : ""}`,
        // Task-100: nudge.sent 가 이미 cohort4 를 합산하므로(nudgeReportFacts.summarizeNudgeSends)
        //   여기서 빠지면 위 합계와 아래 분해가 어긋난다.
        `   └ ① 읽음·무응답 ${nudge.byCohort.cohort1} · ② 지원·미제출 ${nudge.byCohort.cohort2} · ③ 미열람 ${nudge.byCohort.cohort3} · ④ 재제출독려 ${nudge.byCohort.cohort4}`,
        `• 열람: ${nudge.opened}건 (추정 · ${pct(nudge.opened, nudge.sent)})`,
      ]
      // W110 리뷰(HIGH): 소스가 죽은 걸 0 으로 적으면 "독려를 안 보냈다"는 거짓 보고가 된다.
      : ["• 발송: **측정 불가** — 독려 발송 로그 조회 실패"]),
    split.attributionMeasurable
      ? `• 독려 몫 전환(7일 내 마지막 접촉 기준): Apply ${split.applied.nudge}건 (${pct(split.applied.nudge, nudge.sent)}) · 영상 제출 ${split.videoSubmitted.nudge}건 (${pct(split.videoSubmitted.nudge, nudge.sent)}) · 열람 후 Apply ${split.openedThenApplied}건${joinNote(split)}`
      : `• 독려 몫 전환(7일 내 마지막 접촉 기준): **미측정** — 귀속 가능 ${split.conversionRowsJoinable}/${split.conversionRowsSeen}건${unmeasurableNote(split)}`,
  ];
}

/**
 * W110 — 누계는 **월요일에만** 붙인다(헤세 확정). 화~일 리포트는 콜드+독려 두 섹션이 끝이다.
 *   종전의 `이번주 누계`(weekToDate)는 월요일 기준 0일 구간이라 의미가 없어 없앴고,
 *   그 자리를 **지난주 완결 구간**(previousWeek, 월~일)이 대신한다 — WoW 비교가 따라온다.
 */
export function formatScheduledReport(
  facts: ScheduledReportFacts,
  // 2026-08-29 장애: 전일 축만 싣는 리포트는 "캡 소진 직후 시작된 장애"를 최대 ~28시간 못 보여준다.
  // 실시간 발송 상태를 **맨 앞**에 둔다 — 경보는 통계 뒤에 숨으면 안 된다. 미주입이면 종전 문면.
  sendHealthSection: readonly string[] = [],
  // 헤세 지시(2026-09-17): 캠페인별 콜드메일 표. laneSplitLines 내부(콜드 헤더 바로 아래)에
  //   꽂히고, 레인 분해가 실패해 4지표 폴백으로 떨어질 때도 잃지 않게 아래에서 한 번 더 챙긴다.
  perCampaignSection: readonly string[] = [],
): string {
  const laneLines = laneSplitLines(facts, perCampaignSection);
  const lines = [
    `*Flu 전일 리포트* — ${rangeLabel(facts.windows.daily)} (KST · ${facts.windows.runDateKst} 10:00 발행)`,
    "",
    ...(sendHealthSection.length > 0 ? [...sendHealthSection, ""] : []),
    ...laneLines,
  ];

  // 레인 분해가 실패하면 콜드 섹션도 없다 — 그때만 종전 4지표 블록으로 떨어진다.
  // 분해가 깨졌다고 전일 숫자까지 통째로 사라지면 안 된다.
  if (laneLines.length === 0) {
    lines.push("*전일 4지표*", ...metricLines(facts.daily, false));
    // laneSplitLines 가 안 돌았으니 캠페인별 표도 아직 안 붙었다 — 여기서 붙인다(독립 데이터라
    //   콜드 4지표 실패와 무관하게 보여줄 수 있다).
    if (perCampaignSection.length > 0) lines.push(...perCampaignSection);
  }

  if (facts.windows.includeWeekly) {
    lines.push(
      "",
      `*전주 누계* — ${rangeLabel(facts.windows.previousWeek)}`,
      ...comparisonLines(
        facts.previousWeek,
        facts.weekBeforePrevious,
        { current: "지난주", previous: "그전주" },
        "WoW",
        undefined,
        true,
      ),
      ...cumulativeLaneLine(facts.laneSplitPreviousWeek),
      "",
      `*${monthNumber(facts.windows.monthToDate)}월 누계* — ${rangeLabel(facts.windows.monthToDate)}`,
      ...comparisonLines(
        facts.monthToDate,
        facts.previousMonthSamePeriod,
        {
          current: `${monthNumber(facts.windows.monthToDate)}월 누계`,
          previous: `${monthNumber(facts.windows.previousMonthSamePeriod)}월 동일기간`,
        },
        "MoM 동일기간",
        facts.windows.monthToDateComparisonComplete ? undefined : "비교 구간 일수 불일치",
        true,
      ),
      ...cumulativeLaneLine(facts.laneSplitMonthToDate),
    );
  }

  if (facts.windows.includeMonthly) {
    const forcedReason = facts.windows.runDateKst < MOM_MEANINGFUL_FROM_KST
      ? "MoM은 2026-09-01 리포트부터 유의미"
      : undefined;
    lines.push(
      "",
      `*전월 총계* — ${rangeLabel(facts.windows.previousMonth)}`,
      ...comparisonLines(
        facts.previousMonth,
        facts.monthBeforePrevious,
        { current: "지난달", previous: "그전달" },
        "MoM",
        forcedReason,
      ),
    );
  }

  return lines.join("\n");
}

// ---- 요약(글래스) 채널 렌더 -------------------------------------------------
//
// 2026-09-27 재설계(헤세 컨펌): 요약 채널(C0AC81K92SC)은 캠페인별 표·코호트 분해·비율 부연설명을
// 전부 뺀 3~6줄 요약만 받는다. 문제(인증서 만료 임박·발송 정지 의심)가 있을 때만 짧게 경보하고,
// 정상 상태는 아예 노출하지 않는다. 상세 축은 위 formatScheduledReport(상세 채널 전용)가 그대로
// 맡는다 — 이 절이 그 함수를 대체하지 않는다.

const GLANCE_METRIC_LABELS: Record<ScheduledMetricKey, string> = {
  sent: "발송",
  replied: "회신",
  applied: "Apply",
  videoSubmitted: "영상",
};

/** 측정 실패만 "측정 불가"로 드러낸다 — 0으로 위장하지 않는다(다른 섹션과 같은 원칙). */
function glanceCount(metric: ReportMetric): string {
  return metric.status === "unavailable" ? "측정 불가" : metric.count.toLocaleString("ko-KR");
}

/** "9/26" 형식 — 요약 채널 제목은 연도 없이 월/일만 쓴다(헤세 확정 포맷). */
function glanceDateLabel(window: ReportWindow): string {
  const match = kstDateString(window.startMs).match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${Number(match[1])}/${Number(match[2])}` : kstDateString(window.startMs);
}

/**
 * 회신 축 — 2026-09-29(헤세 지시): 헤드라인은 **그날 실제 수신 회신 총계**로 바꾸고, 종전
 * 콜드메일 귀속(발송 대비 비율)은 "콜드 귀속" 보조 항목으로 뒤에 붙인다. 9/28 KST 실측(귀속
 * 1건 vs 실제 회신 17건)에서 귀속만 보이면 "거의 회신이 없었다"는 오해를 만든다는 게 근거.
 */
function glanceReplySegment(
  daily: Record<ScheduledMetricKey, ReportMetric>,
  totalReplies: InboundReplyCountFacts,
): string {
  const attributedRate = formatSendConversionRate(daily.replied, daily.sent);
  const attributedSegment = attributedRate.startsWith("비율 계산 불가")
    ? `콜드 귀속 ${glanceCount(daily.replied)}`
    : `콜드 귀속 ${glanceCount(daily.replied)} (${attributedRate})`;
  if (totalReplies.status === "unavailable") {
    return `${GLANCE_METRIC_LABELS.replied} 측정 불가 · ${attributedSegment}`;
  }
  // 회신마다 발신자가 다 다르면(가장 흔한 경우) 크리에이터 수는 잉여 정보라 뺀다 — 같은
  // 사람이 여러 번 회신했을 때만 "(N명)" 을 덧붙인다.
  const creatorSuffix = totalReplies.count > 0 && totalReplies.distinctCreators !== totalReplies.count
    ? `(${totalReplies.distinctCreators.toLocaleString("ko-KR")}명)`
    : "";
  // 개인 메일함에만 닿은 회신은(오너가 비교하는 scp@ 축이 아니다) 0건이면 아예 안 낸다 —
  // 다른 축과 같은 원칙("0건 축은 뺀다").
  const personalSegment = totalReplies.personalMailboxCount > 0
    ? ` · 개인메일함 ${totalReplies.personalMailboxCount.toLocaleString("ko-KR")}`
    : "";
  return `${GLANCE_METRIC_LABELS.replied} ${totalReplies.count.toLocaleString("ko-KR")}${creatorSuffix} · ${attributedSegment}${personalSegment}`;
}

/** 발송·회신·Apply·영상을 한 줄로 압축한다. "건" 단위는 요약 채널에서 전부 뺀다. */
function glanceMetricLine(
  values: Record<ScheduledMetricKey, ReportMetric>,
  totalReplies: InboundReplyCountFacts,
): string {
  return METRIC_KEYS.map((key) => {
    if (key === "replied") return glanceReplySegment(values, totalReplies);
    const count = glanceCount(values[key]);
    if (key !== "applied") return `${GLANCE_METRIC_LABELS[key]} ${count}`;
    const rate = formatSendConversionRate(values[key], values.sent);
    return rate.startsWith("비율 계산 불가")
      ? `${GLANCE_METRIC_LABELS[key]} ${count}`
      : `${GLANCE_METRIC_LABELS[key]} ${count} (${rate})`;
  }).join(" · ");
}

/**
 * 무슨 메일이 나갔는지(독려·자동답장) 요약 한 줄 — 헤세 지시(2026-09-27): 귀속·비율 없이
 * 발송 건수만, 0건 축은 뺀다. 레인 분해 자체가 없으면(집계 실패) 아예 줄을 안 낸다(0으로
 * 접지 않는다). 독려·자동답장은 같은 mail_outbound_log 원천이라 측정 가능 여부도 공유한다
 * (nudgeMeasurable).
 */
function glanceNudgeLine(split: LaneSplitFacts | undefined): string | null {
  // laneSplit 자체가 없는 것도 "측정 안 됨"이다(전일 콜드 발송이 불완전해 아예 수집을
  //   시도하지 않았거나, collectLaneSplit 자체가 실패했거나) — 조용히 줄을 없애면 "독려가
  //   0건이었다"와 구분이 안 된다(다른 축과 같은 원칙, 코드 리뷰 지적 반영 2026-09-27).
  if (!split || !split.nudgeMeasurable) return "• 독려 측정 불가";
  const parts: string[] = [];
  if (split.nudge.sent > 0) parts.push(`독려 ${split.nudge.sent.toLocaleString("ko-KR")}`);
  if (split.autoReplySent > 0) parts.push(`자동답장 ${split.autoReplySent.toLocaleString("ko-KR")}`);
  return parts.length > 0 ? `• ${parts.join(" · ")}` : null;
}

function glanceWowSuffix(current: ReportMetric, previous: ReportMetric): string {
  const comparison = formatPeriodComparison(current, previous, { current: "이번 구간", previous: "이전 구간" });
  return comparison.startsWith("비교 불가") ? "" : ` (${comparison})`;
}

/** 주간/월간 누계 한 줄. 콜드 발송 자체가 불완전한 구간은 누계를 내지 않는다(다른 누계 축과 동일 원칙). */
function glanceCumulativeLine(
  label: string,
  current: Record<ScheduledMetricKey, ReportMetric>,
  previous: Record<ScheduledMetricKey, ReportMetric>,
): string | null {
  if (current.sent.status !== "complete") return null;
  const sentPart = `발송 ${current.sent.count.toLocaleString("ko-KR")}${glanceWowSuffix(current.sent, previous.sent)}`;
  const appliedPart = current.applied.status === "complete"
    ? `Apply ${current.applied.count.toLocaleString("ko-KR")}${glanceWowSuffix(current.applied, previous.applied)}`
    : "Apply 측정 불가";
  return `${label} ${sentPart} · ${appliedPart}`;
}

/**
 * 요약(글래스) 채널 렌더 — 헤세 확정 포맷:
 *   *Flu 일일 리포트 · 9/26*
 *   발송 1,015 · 회신 43 (4.2%) · Apply 27 (2.7%) · 영상 6
 *   • 콜드: Snake 800 · XP Hero 159
 *   • 독려 56 · 자동답장 12
 *   (문제 있을 때만) ⚠️ 인증서 D-6 · 🔴 발송 정지 의심
 * 콜드 4지표는 laneSplit 성공 여부와 무관하게 항상 facts.daily 를 쓴다 — "전일 4지표" 폴백과
 * 같은 정본이라, 레인 분해가 실패해도 이 줄만은 항상 낼 수 있다.
 *
 * 2026-09-27(헤세 지시): "어디서·무엇을 보냈는지"는 요약 채널에서도 보여야 한다 — 단, 비율·
 * 코호트·부연설명 없이 이름/축 + 건수만(0건은 뺀다). 캠페인별 표는 호출부(handler)가
 * outreachPerCampaignReport.formatGlanceColdCampaignLine 로 미리 한 줄을 만들어 넘긴다
 * (여기서 다시 조회하지 않는다 — Firestore 왕복을 늘리지 않는다).
 */
export function formatGlanceReport(
  facts: ScheduledReportFacts,
  glanceWarnings: readonly string[] = [],
  coldCampaignLine: string | null = null,
): string {
  const lines = [
    `*Flu 일일 리포트 · ${glanceDateLabel(facts.windows.daily)}*`,
    glanceMetricLine(facts.daily, facts.dailyInboundReplies),
  ];
  if (coldCampaignLine) lines.push(coldCampaignLine);
  const nudgeLine = glanceNudgeLine(facts.laneSplit);
  if (nudgeLine) lines.push(nudgeLine);
  if (glanceWarnings.length > 0) lines.push(glanceWarnings.join(" · "));
  if (facts.windows.includeWeekly) {
    const weekly = glanceCumulativeLine("주간 누계", facts.previousWeek, facts.weekBeforePrevious);
    if (weekly) lines.push(weekly);
  }
  if (facts.windows.includeMonthly) {
    const monthly = glanceCumulativeLine("월간 총계", facts.previousMonth, facts.monthBeforePrevious);
    if (monthly) lines.push(monthly);
  }
  return lines.join("\n");
}

export async function postScheduledReportToSlack(
  text: string,
  options: {
    token?: string;
    fetchImpl?: typeof fetch;
    emailInventorySection?: string;
    videoReviewBacklogSection?: string;
    /** 상세 채널의 공통 운영 본문. 요약 채널은 언제나 첫 번째 text(글래스 렌더)를 유지한다. */
    detailBaseText?: string;
    /** 상세 채널에서만 기존 공통 리포트 뒤에 별도 top-level 메시지로 보낸다. */
    detailWorkstreamMessages?: readonly string[];
  } = {},
): Promise<{
  posted: boolean;
  results: Array<{ channelId: string; posted: boolean; reason?: string }>;
  reason?: string;
}> {
  const token = safeString(options.token ?? process.env[SLACK_BOT_TOKEN_ENV]);
  if (!token) return { posted: false, results: [], reason: "bot_token_missing" };
  const fetchImpl = options.fetchImpl ?? fetch;
  const postMessage = async (channelId: string, messageText: string) => {
    try {
      const response = await fetchImpl(SLACK_API_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: channelId,
          text: messageText,
          unfurl_links: false,
          unfurl_media: false,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return { posted: false, reason: `slack_http_${response.status}` };
      const body = await response.json() as { ok?: boolean };
      return body.ok === true
        ? { posted: true }
        : { posted: false, reason: "slack_api_rejected" };
    } catch {
      return { posted: false, reason: "slack_transport_failed" };
    }
  };
  const results = await Promise.all(SLACK_SCHEDULED_REPORT_CHANNELS.map(async ({ id: channelId }) => {
    // 최소 분기(헤세 지시): 이메일 재고 섹션은 채널 상수와 대조해 C0ARCM9CZNG 문면에만 덧붙인다 —
    //   나머지 채널은 종전과 동일한 text 그대로 나간다.
    // W126: 검수 백로그 섹션도 같은 규약으로 뒤에 이어 붙는다. 각 섹션은 **자기 채널 상수**로
    //   따로 판정한다 — 한쪽 채널을 넓히는 결정이 다른 쪽을 끌고 가지 않게.
    const channelSections = [
      channelId === EMAIL_INVENTORY_SECTION_CHANNEL_ID ? options.emailInventorySection : "",
      channelId === VIDEO_REVIEW_BACKLOG_SECTION_CHANNEL_ID ? options.videoReviewBacklogSection : "",
    ].filter((section) => section);
    const baseText = channelId === DETAIL_WORKSTREAM_REPORT_CHANNEL_ID
      ? options.detailBaseText ?? text
      : text;
    const channelText = channelSections.length > 0
      ? [baseText, ...channelSections].join("\n\n")
      : baseText;
    const base = await postMessage(channelId, channelText);
    if (!base.posted || channelId !== DETAIL_WORKSTREAM_REPORT_CHANNEL_ID || !options.detailWorkstreamMessages?.length) {
      return { channelId, ...base };
    }
    // `thread_ts`를 넣지 않아 각 업무 알림은 독립 top-level 메시지로 남는다. 개별 실패가
    // 요약 채널 본문 전송을 바꾸지 않도록 상세 채널 결과에만 합산한다.
    const workstreamResults = await Promise.all(options.detailWorkstreamMessages.map((message) => postMessage(channelId, message)));
    const failed = workstreamResults.find((result) => !result.posted);
    return failed
      ? { channelId, posted: false, reason: failed.reason ?? "slack_workstream_post_failed" }
      : { channelId, posted: true };
  }));
  const postedCount = results.filter((result) => result.posted).length;
  if (postedCount === results.length) return { posted: true, results };
  return {
    posted: false,
    results,
    reason: postedCount === 0 ? "slack_all_channels_failed" : "slack_partial_failure",
  };
}

export async function slackScheduledReportsHandler(nowMs = Date.now()): Promise<void> {
  try {
    // R2: windows 지역 상수는 핸들러 안에서 재사용하기 위한 것(가독성 · 이메일 재고 섹션의
    //   .daily 인자)이다 — collectScheduledReportFacts 내부(:604)는 여전히 자신만의 windows 를
    //   독립적으로 계산한다. 같은 nowMs 라 결과는 항상 동일하지만, 그 내부 재계산 자체를 없애려면
    //   collectScheduledReportFacts 시그니처 변경이 필요해 여기서는 하지 않는다(범위 밖).
    const windows = buildScheduledReportWindows(nowMs);
    // M5: postScheduledReportToSlack 은 토큰이 없으면 결국 bot_token_missing 으로 스킵한다 —
    //   그 전에 비용이 큰 campaign_candidates 풀스캔(최대 MAX_SCAN_PAGES 페이지)이 도는 것을
    //   막기 위해 같은 env 이름으로 여기서도 먼저 확인한다.
    const hasSlackToken = safeString(process.env[SLACK_BOT_TOKEN_ENV]).length > 0;
    // 이메일 재고 섹션은 4대 정본 지표와 무관한 별도 축이라 병렬로 모은다(순서 의존 없음).
    //   실패 격리는 buildEmailInventorySectionSafe 내부에서 끝난다 — 이 호출은 절대 던지지 않는다.
    // W126: 검수 백로그 섹션도 같은 결 — 별도 축이라 병렬로 모으고, 실패 격리는
    //   buildVideoReviewBacklogSectionSafe 안에서 끝난다(이 호출도 절대 던지지 않는다).
    // 2026-08-29 장애 후속: 발송 레인 실시간 상태도 같은 결로 병렬 수집한다. 이 축의 facts는
    //   **두 채널 렌더 모두**의 입력이 된다 — 상세 채널은 전체 블록을, 요약 채널은 문제 상황만
    //   짧게 뽑는다(둘 다 사이드 섹션과 달리 경보이기 때문이다).
    // 헤세 지시(2026-09-17): 캠페인별 표는 발송 레인 상태 블록과 콜드 섹션 둘 다에 들어가므로
    //   여기서 한 번만 모아 두 렌더 호출에 같이 물린다(Firestore 왕복을 두 번 내지 않는다).
    const [facts, emailInventorySection, videoReviewBacklogSection, perCampaignReport, resubmissionBacklogLine, sendHealthFacts] = await Promise.all([
      collectScheduledReportFacts(nowMs),
      hasSlackToken ? buildEmailInventorySectionSafe(windows.daily) : Promise.resolve(undefined),
      hasSlackToken ? buildVideoReviewBacklogSectionSafe(nowMs) : Promise.resolve(undefined),
      hasSlackToken
        ? collectPerCampaignReportRows(nowMs)
          .then((rows) => ({ rows, available: true }))
          .catch(() => ({ rows: [], available: false }))
        : Promise.resolve({ rows: [], available: false }),
      // Task-100 §4: 검수 백로그 섹션과 같은 채널에 한 줄만 덧붙인다 — 새 옵션 필드를 만들지 않고
      //   videoReviewBacklogSection 문자열 뒤에 이어 붙인다(아래).
      hasSlackToken ? buildResubmissionCycleBacklogLineSafe() : Promise.resolve(""),
      hasSlackToken ? collectOutreachSendHealthFactsSafe(new Date(nowMs)) : Promise.resolve(undefined),
    ]);
    const perCampaignSection = formatPerCampaignReportLines(perCampaignReport.rows);
    const detailWorkstreamMessages = hasSlackToken
      ? formatDetailWorkstreamReportMessages(
          groupPerCampaignRowsByWorkstream(perCampaignReport.rows),
          perCampaignReport.available,
        )
      : [];
    // 상세 채널의 "발송 레인 상태" 블록은 기존과 동일하게 캠페인별 표를 담는다. 요약(글래스)
    //   채널은 이 블록 자체를 쓰지 않는다 — formatOutreachGlanceWarnings 로 문제 상황만
    //   따로 뽑는다(정상이면 빈 배열, 즉 요약 채널에는 아무것도 안 붙는다).
    const sendHealthSection = sendHealthFacts
      ? formatOutreachSendHealthSection(sendHealthFacts, perCampaignSection)
      : (hasSlackToken ? ["*발송 레인 상태* — 측정 불가(원장 조회 실패)"] : []);
    // 코드 리뷰 지적(2026-09-27, Medium): facts 수집 자체가 실패한 것을 빈 경보 배열로 접으면
    //   "정상이라 경보가 없다"와 "측정 자체가 실패했다"가 요약 채널에서 구분이 안 된다.
    const glanceWarnings = sendHealthFacts
      ? formatOutreachGlanceWarnings(sendHealthFacts)
      : (hasSlackToken ? [GLANCE_HEALTH_UNAVAILABLE_WARNING] : []);
    // 헤세 지시(2026-09-27): 요약 채널도 "어디서 뭘 보냈는지"는 보여야 한다 — 위에서 이미 모은
    //   같은 perCampaignReport.rows 에서 한 줄만 뽑는다(새 Firestore 왕복 없음). available 을
    //   같이 넘겨야 조회 실패가 "캠페인이 없다"(0건)로 위장되지 않는다.
    const glanceColdCampaignLine = formatGlanceColdCampaignLine(perCampaignReport.rows, perCampaignReport.available);
    // 상세 채널의 공통 본문은 전역 지표·경보만 보관한다. 업무별 행은 바로 아래 독립 메시지에서만
    // 나타나므로 같은 수치를 세 업무에 복사하거나 공통 본문에 중복하지 않는다.
    const detailCommonSendHealthSection = sendHealthSection.filter((line) => !perCampaignSection.includes(line));
    const detailBaseText = [
      "*[공통] 운영 리포트*",
      formatScheduledReport(facts, detailCommonSendHealthSection),
    ].join("\n\n");
    const result = await postScheduledReportToSlack(formatGlanceReport(facts, glanceWarnings, glanceColdCampaignLine), {
      emailInventorySection,
      videoReviewBacklogSection: videoReviewBacklogSection && resubmissionBacklogLine
        ? `${videoReviewBacklogSection}\n${resubmissionBacklogLine}`
        : videoReviewBacklogSection,
      detailWorkstreamMessages,
      detailBaseText,
    });
    const log = result.posted ? console.log : console.warn;
    log("[slack-scheduled-reports]", JSON.stringify(result));
  } catch {
    // A failed collection/render must not crash or disable the scheduler. Raw provider/Firestore
    // error text is deliberately omitted from logs (SEC-P0-009).
    console.warn("[slack-scheduled-reports]", JSON.stringify({ posted: false, reason: "report_failed" }));
  }
}
