// Flu — 콘텐츠 검수 "인박스" 큐 (2026-09-17, 헤세 요청).
//
// 애매한 건(사람 판단이 필요한 건)을 세 소스에서 모아 하나의 대기 목록으로 만드는 순수 모듈.
//   ① 영상: scp_video_review_state 의 human_review_required 행 + appeal.open 행
//      (fetchedCanonicalVideoReviewStates — ReviewWorkspace 가 이미 항상 불러온다, 새 조회 없음).
//   ② 문의: reviews 컬렉션의 source==="mail_human_review" && status==="pending" 행
//      (reviewItems/useLiveReviews — ReviewWorkspace 가 이미 항상 구독한다, 새 조회 없음).
//   ③ 신청자: scp_application_management 의 qualification.verdict==="human_review" 행
//      (listApplicationManageInbox({filter:"qualification_human_review"}) — 기존 콜러블에
//      최소 필터만 추가, 새 콜러블 없음).
//
// 런타임 상대 import(.ts 확장자 포함)는 src/lib 관례와 같다 — 노드 테스트 레인에서 이 모듈을
// 그대로 import 해 행위를 고정할 수 있다.

import { buildChatHref } from "../../lib/chat-route.ts";
import { buildReviewHref } from "../../lib/review-route.ts";
import type { ScpVideoReviewStateRow } from "../../lib/data.ts";

export type ReviewInboxItemType = "video" | "mail" | "applicant";

export interface ReviewInboxItem {
  readonly id: string;
  readonly type: ReviewInboxItemType;
  readonly typeLabel: string;
  readonly who: string;
  /**
   * 보조 신원(크리에이터 @핸들 또는 지원서 제출 핸들/채널 URL). `who` 와 같은 값은 넣지 않는다.
   * 소스가 실제로 들고 있는 값만 — 없으면 부재(추정·날조 금지).
   */
  readonly handle?: string;
  /** 해석된 크리에이터의 구독자 수 — 소스에 없으면 부재(자격 판정 사유와 혼동 금지). */
  readonly subscriberCount?: number;
  /** 크리에이터 국가/거주국 코드 — 소스에 없으면 부재. */
  readonly country?: string;
  readonly reason: string;
  readonly waitingSinceIso: string;
  readonly href: string;
}

export const REVIEW_INBOX_QUEUE = "inbox" as const;
export const REVIEW_INBOX_EMPTY_MESSAGE = "지금 사람 판단을 기다리는 건이 없습니다.";
// 신청자 행의 착륙 지점은 SCP 크리에이터 탭 디렉터리다 — /flu/manage/applications 는 귀속
// 애매(manage_inbox) 건만 보여 자격 검토(human_review) 행은 아예 목록에 없으므로 착륙
// 지점이 못 된다. `applicationId` 쿼리는 review-route 가 이미 예약한 딥링크 키라 탭 전환 시
// 자동으로 지워진다(buildScpTabHref) — 새 파라미터 어휘를 만들지 않는다.
export const REVIEW_INBOX_APPLICANT_HREF = "/flu/scp?tab=creators";

/** 신청자 행 → 크리에이터 탭 디렉터리의 특정 지원서 행(applicationId 포커스 딥링크). */
export function buildApplicantInboxHref(applicationId: string): string {
  const id = applicationId.trim();
  if (!id) return REVIEW_INBOX_APPLICANT_HREF;
  const params = new URLSearchParams({ tab: "creators", applicationId: id });
  return `/flu/scp?${params.toString()}`;
}

export const REVIEW_INBOX_HREF = "/flu/scp?tab=inbox";

// 2026-09-17 [헤세] — "검수 대기" 알림(구 개념) 은퇴 결정: reviews 컬렉션의 mail_human_review
// pending 은 프로드 1013건(레거시 적체, 2026-09-17 15:45 KST 카운트) 중 대부분이 오래전에 묻힌
// 건이라 인박스를 새 적체로 다시 채운다. 14일보다 오래된 문의는 인박스에서 걸러 최근 것만 보여준다
// — 영상·신청자 소스는 그 자체가 이미 "아직 안 닫힌 건"만 남기는 상태 필터라 나이 상한이 필요 없다.
export const INBOX_MAIL_REVIEW_MAX_AGE_DAYS = 14;
const INBOX_MAIL_REVIEW_MAX_AGE_MS = INBOX_MAIL_REVIEW_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

const VIDEO_TYPE_LABEL = "영상";
const MAIL_TYPE_LABEL = "문의";
const APPLICANT_TYPE_LABEL = "신청자";

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// "@handle" 형태로 정규화 — 지원서 제출 핸들은 "@x"/"x" 둘 다 들어오고, 채널 URL
// (youtube.com/@x)에서도 핸들 구간만 뽑는다. URL/공백이 섞인 값은 핸들로 읽지 않고 버린다
// (지어내지 않는다 — 이 함수는 표시용 정규화일 뿐 새 신원을 만들지 않는다).
export function asYoutubeHandle(value: string): string {
  const text = value.trim();
  if (!text) return "";
  const urlMatch = /youtube\.com\/@([^/?#]+)/i.exec(text);
  if (urlMatch) {
    try {
      return `@${decodeURIComponent(urlMatch[1])}`;
    } catch {
      return `@${urlMatch[1]}`;
    }
  }
  if (/[\s/:?#]/.test(text)) return "";
  // "@" 단독이나 "@@" 처럼 @ 뒤가 비는 값은 핸들이 아니다 — 빈 값을 돌려 폴백을 계속하게 한다.
  const bare = text.startsWith("@") ? text.slice(1) : text;
  return bare && !bare.startsWith("@") ? `@${bare}` : "";
}

// ── ① 영상 ────────────────────────────────────────────────────────────────

function videoInboxWho(row: ScpVideoReviewStateRow): string {
  const creator = row.creator;
  if (creator && creator.available && asText(creator.displayName)) return creator.displayName;
  return "크리에이터 미확인";
}

// 영상 크리에이터 행에 이미 실려 있는 보조 신원(handle/countryCode)만 얹는다 — 없으면 부재.
function videoInboxMeta(row: ScpVideoReviewStateRow): { handle?: string; country?: string } {
  const creator = row.creator;
  if (!creator || !creator.available) return {};
  const handle = asYoutubeHandle(asText(creator.handle)) || undefined;
  const country = asText(creator.countryCode) || undefined;
  return { handle, country };
}

function videoInboxReason(row: ScpVideoReviewStateRow): string {
  if (row.appeal?.open) return "크리에이터가 반려 판정에 이의를 제기했습니다.";
  const verdict = row.aiJudge?.verdict;
  if (verdict) {
    const probability = row.aiJudge?.disapprovalProbability;
    return typeof probability === "number"
      ? `AI 사전판정이 애매해 사람 확인이 필요합니다 (거부확률 ${probability}%).`
      : "AI 사전판정이 애매해 사람 확인이 필요합니다.";
  }
  return "영상 제출이 자동판정 기준을 벗어나 사람 검토가 필요합니다.";
}

function isVideoInboxCandidate(row: ScpVideoReviewStateRow): boolean {
  if (row.withdrawn || row.superseded) return false;
  return row.state === "human_review_required" || row.appeal?.open === true;
}

export function buildVideoReviewInboxItems(
  rows: readonly ScpVideoReviewStateRow[],
  options: { readonly basePath?: string } = {},
): ReviewInboxItem[] {
  return rows.filter(isVideoInboxCandidate).map((row) => {
    const submissionId = asText(row.videoSubmissionId) || asText(row.id);
    return {
      id: `video:${submissionId || row.id}`,
      type: "video",
      typeLabel: VIDEO_TYPE_LABEL,
      who: videoInboxWho(row),
      ...videoInboxMeta(row),
      reason: videoInboxReason(row),
      waitingSinceIso: asText(row.updatedAtIso),
      href: submissionId
        ? buildReviewHref({
          kind: "video",
          submissionId,
          programId: asText(row.canonicalProgramId) || undefined,
          basePath: options.basePath,
        })
        : "",
    };
  });
}

// ── ② 문의 ────────────────────────────────────────────────────────────────

const MAIL_REASON_CODE_LABELS: Record<string, string> = {
  "human-review": "AI가 자동 회신하기 애매해 사람 검토가 필요합니다.",
};

export interface MailReviewInboxSourceItem {
  readonly id?: unknown;
  readonly source?: unknown;
  readonly status?: unknown;
  readonly deletedAt?: unknown;
  readonly archivedAt?: unknown;
  readonly deletedAtIso?: unknown;
  readonly archivedAtIso?: unknown;
  readonly creatorName?: unknown;
  readonly creatorEmail?: unknown;
  readonly reason?: unknown;
  readonly reasonCode?: unknown;
  readonly createdAtIso?: unknown;
  readonly conversationId?: unknown;
}

function mailInboxWho(row: MailReviewInboxSourceItem): string {
  return asText(row.creatorName) || asText(row.creatorEmail) || "발신자 미상";
}

function mailInboxReason(row: MailReviewInboxSourceItem): string {
  const reason = asText(row.reason);
  if (reason) return reason;
  const reasonCode = asText(row.reasonCode);
  if (reasonCode) return MAIL_REASON_CODE_LABELS[reasonCode] ?? reasonCode;
  return "AI가 자동 회신하기 애매해 사람 검토가 필요합니다.";
}

// 생성 시각을 모르거나 파싱 불가면 나이로 걸러내지 않는다(보수적으로 유지) — waitingMillis의
// "미상은 방금 막으로 취급" 과 같은 원칙: 모르는 값 때문에 실제로 애매한 최근 건을 놓치면 안 된다.
function isMailRowWithinInboxAgeLimit(row: MailReviewInboxSourceItem, nowMs: number): boolean {
  const parsed = Date.parse(asText(row.createdAtIso));
  if (!Number.isFinite(parsed)) return true;
  return nowMs - parsed <= INBOX_MAIL_REVIEW_MAX_AGE_MS;
}

function isMailInboxCandidate(row: MailReviewInboxSourceItem, nowMs: number): boolean {
  return asText(row.source) === "mail_human_review"
    && asText(row.status) === "pending"
    && !row.deletedAt
    && !row.archivedAt
    && !row.deletedAtIso
    && !row.archivedAtIso
    && isMailRowWithinInboxAgeLimit(row, nowMs);
}

export function buildMailReviewInboxItems(
  rows: readonly MailReviewInboxSourceItem[],
  options: { readonly now?: Date } = {},
): ReviewInboxItem[] {
  const nowMs = (options.now ?? new Date()).getTime();
  return rows.filter((row) => isMailInboxCandidate(row, nowMs)).map((row) => {
    const conversationId = asText(row.conversationId);
    const id = asText(row.id) || conversationId;
    return {
      id: `mail:${id}`,
      type: "mail",
      typeLabel: MAIL_TYPE_LABEL,
      who: mailInboxWho(row),
      reason: mailInboxReason(row),
      waitingSinceIso: asText(row.createdAtIso),
      href: conversationId ? buildChatHref({ conversationId }) : "",
    };
  });
}

// ── ③ 신청자 ──────────────────────────────────────────────────────────────

// Task-95 applicationEligibilityJudge.ts ApplicationEligibilityReasonCode 중 human_review 5종.
const APPLICANT_REASON_CODE_LABELS: Record<string, string> = {
  subscriber_count_hidden: "구독자 수가 비공개라 자격을 자동으로 확인할 수 없습니다.",
  channel_not_found_pending_review: "채널 정보를 찾지 못해 자격을 자동으로 확인할 수 없습니다.",
  subscriber_lookup_api_error: "구독자 수 조회가 일시적으로 실패했습니다.",
  subscriber_lookup_timeout: "구독자 수 조회가 시간 초과되었습니다.",
  subscriber_count_unavailable: "구독자 수를 확인할 수 없습니다.",
  subscriber_lookup_unavailable_after_retries: "구독자 수 조회를 여러 번 재시도했지만 실패했습니다.",
};

export interface ApplicantReviewInboxSourceRow {
  readonly applicationId?: unknown;
  readonly submittedAtIso?: unknown;
  readonly creatorDisplayName?: unknown;
  readonly creatorHandle?: unknown;
  /** 해석된 크리에이터의 followers(구독자 수) — 크리에이터 해석 실패 행은 부재. */
  readonly creatorSubscriberCount?: unknown;
  /** 해석된 크리에이터의 region(국가 코드) — 크리에이터 해석 실패 행은 부재. */
  readonly creatorCountry?: unknown;
  /** W104 스윕이 management 문서에 심은 자가신고 신원(이메일류는 쓰기 시점에 필터됨). */
  readonly declaredIdentity?: {
    readonly handle?: unknown;
    readonly name?: unknown;
    readonly country?: unknown;
    readonly category?: unknown;
    readonly channelUrl?: unknown;
  } | null;
  readonly identity?: { readonly channelId?: unknown } | null;
  readonly qualification?: {
    readonly verdict?: unknown;
    readonly reasonCode?: unknown;
    readonly judgedAtIso?: unknown;
  } | null;
}

// 신원 폴백: 해석된 크리에이터 표시명/핸들 → 지원서 자가신고(핸들·이름·채널 URL) →
// 채널 id → applicationId. 자가신고가 있으면 UUID 를 먼저 보여주지 않는다(W104 스윕이
// token_absent 행의 opaque id 문제를 위해 만든 필드다).
function applicantInboxWho(row: ApplicantReviewInboxSourceRow): string {
  const declared = asRecord(row.declaredIdentity);
  const declaredChannelUrl = asText(declared.channelUrl);
  return asText(row.creatorDisplayName)
    || asText(row.creatorHandle)
    || asYoutubeHandle(asText(declared.handle))
    || asText(declared.name)
    || asYoutubeHandle(declaredChannelUrl)
    || declaredChannelUrl
    || asText(asRecord(row.identity).channelId)
    || asText(row.applicationId)
    || "신청자 미확인";
}

// 보조 신원 — who 와 같은 값은 넣지 않는다(중복 표시 금지). 제출 채널 URL 이 @핸들 URL 이
// 아니면 핸들로 못 읽으니 그때는 원문 URL 을 그대로 보조 신원으로 쓴다.
function applicantInboxHandle(row: ApplicantReviewInboxSourceRow, who: string): string | undefined {
  const declared = asRecord(row.declaredIdentity);
  const handle = asText(row.creatorHandle)
    || asYoutubeHandle(asText(declared.handle))
    || asYoutubeHandle(asText(declared.channelUrl))
    || asText(declared.channelUrl)
    || "";
  return handle && handle !== who ? handle : undefined;
}

function applicantInboxSubscriberCount(row: ApplicantReviewInboxSourceRow): number | undefined {
  const value = row.creatorSubscriberCount;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

// 국가 우선순위: 해석된 크리에이터 region(시스템 기록) → 자가신고 거주국. 신고
// "주요 오디언스 국가"(declaredPrimaryAudienceCountry)는 거주국이 아니라 다른 축이라
// 여기에 섞지 않는다(오인 표시 금지).
function applicantInboxCountry(row: ApplicantReviewInboxSourceRow): string | undefined {
  return asText(row.creatorCountry)
    || asText(asRecord(row.declaredIdentity).country)
    || undefined;
}

function applicantInboxReason(reasonCode: string): string {
  if (!reasonCode) return "신청자 자격을 자동으로 판정하지 못했습니다.";
  return APPLICANT_REASON_CODE_LABELS[reasonCode] ?? reasonCode;
}

function isApplicantInboxCandidate(row: ApplicantReviewInboxSourceRow): boolean {
  return asText(asRecord(row.qualification).verdict) === "human_review";
}

export function buildApplicantReviewInboxItems(
  rows: readonly ApplicantReviewInboxSourceRow[],
): ReviewInboxItem[] {
  return rows.filter(isApplicantInboxCandidate).map((row) => {
    const qualification = asRecord(row.qualification);
    const applicationId = asText(row.applicationId);
    const who = applicantInboxWho(row);
    return {
      id: `applicant:${applicationId}`,
      type: "applicant",
      typeLabel: APPLICANT_TYPE_LABEL,
      who,
      handle: applicantInboxHandle(row, who),
      subscriberCount: applicantInboxSubscriberCount(row),
      country: applicantInboxCountry(row),
      reason: applicantInboxReason(asText(qualification.reasonCode)),
      waitingSinceIso: asText(qualification.judgedAtIso) || asText(row.submittedAtIso),
      href: buildApplicantInboxHref(applicationId),
    };
  });
}

// ── 합치기 + 정렬 ────────────────────────────────────────────────────────

// 대기 시간을 모르는 행(빈 waitingSinceIso, 파싱 불가)은 "방금 막 확인됨"으로 취급해 맨 뒤로
// 보낸다 — 반대로 두면(문자열 정렬) 모르는 행이 항상 최상단에 뜨는 오독이 생긴다.
function waitingMillis(iso: string, nowMs: number): number {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : nowMs;
}

export function sortReviewInboxItemsByWaitingSince(
  items: readonly ReviewInboxItem[],
  now: Date = new Date(),
): ReviewInboxItem[] {
  const nowMs = now.getTime();
  return [...items].sort(
    (left, right) => waitingMillis(left.waitingSinceIso, nowMs) - waitingMillis(right.waitingSinceIso, nowMs),
  );
}

export interface BuildReviewInboxItemsInput {
  readonly videoRows?: readonly ScpVideoReviewStateRow[];
  readonly mailRows?: readonly MailReviewInboxSourceItem[];
  readonly applicantRows?: readonly ApplicantReviewInboxSourceRow[];
  readonly reviewBasePath?: string;
  readonly now?: Date;
}

// 새로 대기가 가장 긴(가장 오래 기다린) 건이 맨 위 — 운영자가 가장 급한 것부터 본다.
export function buildReviewInboxItems(input: BuildReviewInboxItemsInput): ReviewInboxItem[] {
  const items = [
    ...buildVideoReviewInboxItems(input.videoRows ?? [], { basePath: input.reviewBasePath }),
    ...buildMailReviewInboxItems(input.mailRows ?? [], { now: input.now }),
    ...buildApplicantReviewInboxItems(input.applicantRows ?? []),
  ];
  return sortReviewInboxItemsByWaitingSince(items, input.now);
}

// ── 대기 시간 표시(상대 시각) ────────────────────────────────────────────

export function reviewInboxWaitingSinceLabel(iso: string, now: Date = new Date()): string {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(parsed)) return "대기 시간 미상";
  const diffMs = Math.max(0, now.getTime() - parsed);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}
