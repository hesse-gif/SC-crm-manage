// 주의: 이 파일은 tests/scp-partner-adapter.test.mjs가 ts.transpileModule+vm으로 직접 로드한다
// (require 베이스가 tests/ 라 상대경로/별칭 임포트가 깨짐) — 의도적으로 외부 파일 임포트 없이 자족시킨다.
export type PartnerRecordRow = Record<string, unknown>;

export type PartnerReviewStatus = "approved" | "rejected" | "pending" | "needs_review" | "unknown";

export type ScpPartner = {
  id: string;
  routeId: string;
  routeAliases: string[];
  name: string;
  handle: string;
  email: string;
  leadId?: string;
  submissionId?: string;
  creatorId?: string;
  channelId?: string;
  youtubeUrl?: string;
  country: string;
  app: string;
  subscribers: number | null;
  subscribersSource?: string;
  reviewStatus: PartnerReviewStatus;
  qualificationStatus: string;
  lifecycleState: string;
  submittedAtIso: string;
  sourceLabel: string;
  sourceRefs: string[];
  contentUrls: string[];
  submissions: PartnerRecordRow[];
  sheetVideoRows: PartnerRecordRow[];
  lead?: PartnerRecordRow;
  qualification?: PartnerRecordRow;
  creator?: PartnerRecordRow;
  channelStat?: PartnerRecordRow;
  lifecycleProfile?: PartnerRecordRow;
  submissionTasks: PartnerRecordRow[];
  creatorLinks: PartnerRecordRow[];
};

export type BuildScpPartnersInput = {
  submissions: PartnerRecordRow[];
  programSheetLeads: PartnerRecordRow[];
  scpQualificationRows?: PartnerRecordRow[];
  creators: PartnerRecordRow[];
  channelStats: Record<string, PartnerRecordRow>;
  submissionTasks?: PartnerRecordRow[];
  creatorLinks?: PartnerRecordRow[];
  scpLifecycleProfiles?: PartnerRecordRow[];
  contracts?: PartnerRecordRow[];
};

type PartnerSource = {
  row: PartnerRecordRow;
  kind: "submission" | "sheet3" | "lifecycle" | "contract";
};

const INVALID_DISPLAY_NAMES = new Set(["true", "false", "null", "undefined", "nan", "n/a", "na", "-"]);
const GENERIC_SCP_DISPLAY_NAME = /^scp(?:프로필|파트너|profile|partner)(?:#[\p{L}\p{N}_-]+)?$/iu;

export function text(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || fallback;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function lower(value: unknown): string {
  return text(value).toLowerCase();
}

function record(value: unknown): PartnerRecordRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as PartnerRecordRow : {};
}

function arrayRecords(value: unknown): PartnerRecordRow[] {
  return Array.isArray(value) ? value.filter((item): item is PartnerRecordRow => !!item && typeof item === "object" && !Array.isArray(item)) : [];
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = text(value).replace(/,/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return "";
}

function firstUsableName(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (isUsableDisplayName(candidate)) return candidate;
  }
  return "";
}

export function isUsableDisplayName(value: unknown): boolean {
  const candidate = text(value);
  if (!candidate) return false;
  // NFKC 정규화+공백 제거 후 판정 — 전각(ＴＲＵＥ/１２３４５)·공백 삽입(123 456) 우회 차단(서버 가드와 동일 클래스).
  const normalized = candidate.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  if (!normalized) return false;
  if (INVALID_DISPLAY_NAMES.has(normalized)) return false;
  if (GENERIC_SCP_DISPLAY_NAME.test(normalized)) return false;
  if (/^[0-9]+$/.test(normalized)) return false;
  return /[\p{L}\p{N}@]/u.test(candidate);
}

function emailLocalPart(email: string): string {
  const local = email.split("@")[0]?.replace(/[._-]+/g, " ").trim();
  return local || "SCP 파트너";
}

function stableHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function routeEmailHash(email: string): string {
  return `email-${stableHash(email.toLowerCase())}`;
}

function applicant(row: PartnerRecordRow): PartnerRecordRow {
  return record(row.applicant);
}

function metrics(row: PartnerRecordRow): PartnerRecordRow {
  return record(row.metrics);
}

function normalizedEmail(row: PartnerRecordRow): string {
  const app = applicant(row);
  return lower(row.email) || lower(app.email) || lower(record(row.formResponses).email);
}

function normalizedLeadId(row: PartnerRecordRow): string {
  return firstText(row.leadId, row.programSheetLeadId, row.leadRef, applicant(row).leadId);
}

function normalizedCreatorId(row: PartnerRecordRow): string {
  return firstText(row.creatorId, applicant(row).creatorId);
}

function normalizedChannelId(row: PartnerRecordRow): string {
  return firstText(row.channelId, row.youtubeChannelId, row.channel?.toString?.(), applicant(row).channelId);
}

function normalizedToken(row: PartnerRecordRow): string {
  return firstText(row.token, row.submitToken, row.submissionToken, applicant(row).token);
}

function normalizedHandle(row: PartnerRecordRow): string {
  const direct = firstText(row.handle, row.youtubeHandle, applicant(row).handle, applicant(row).youtubeHandle);
  if (direct) return direct.startsWith("@") ? direct : `@${direct}`;
  const url = normalizedYoutubeUrl(row);
  const match = url.match(/(?:youtube\.com\/(?:@|c\/|channel\/)|youtu\.be\/)([^/?#]+)/i);
  return match?.[1] ? (url.includes("/@") ? `@${match[1]}` : match[1]) : "";
}

function normalizedYoutubeUrl(row: PartnerRecordRow): string {
  const app = applicant(row);
  return firstText(row.youtubeUrl, row.youtube, row.channelUrl, app.youtubeUrl, app.youtube, record(row.formResponses).youtubeUrl);
}

function submittedAt(row: PartnerRecordRow): string {
  return firstText(row.submittedAtIso, row.submittedAt, row.createdAtIso, row.updatedAtIso, row.date);
}

function sourceRef(row: PartnerRecordRow, kind: PartnerSource["kind"]): string {
  const id = firstText(row.id, row.submissionId, row.taskId, row.rowId);
  if (kind === "submission" && id) return `submissions/${id}`;
  if (kind === "lifecycle") return `scp_lifecycle_profiles/${firstText(row.profileId, id, stableHash(JSON.stringify(row)))}`;
  if (kind === "contract") return `contracts/${id || stableHash(JSON.stringify(row))}`;
  const spreadsheetId = firstText(row.spreadsheetId);
  const rowNumber = firstText(row.rowNumber);
  if (spreadsheetId || rowNumber) return `sheet3/${spreadsheetId || "sheet"}#${rowNumber || id || "row"}`;
  return kind === "sheet3" ? `sheet3/${id || stableHash(JSON.stringify(row))}` : `submissions/${stableHash(JSON.stringify(row))}`;
}

export function partnerContentUrls(row: PartnerRecordRow): string[] {
  return Array.from(new Set([
    ...stringArray(row.contentUrls),
    ...stringArray(record(row.formResponses).contentUrls),
    firstText(row.youtubeUrl, row.youtube, row.videoUrl, row.url),
    firstText(row.tiktokUrl, row.tiktok),
    firstText(row.instagramUrl, row.instaUrl, row.instagram),
    firstText(row.uploadedFileUrl, row.fileUrl, row.file),
  ].filter(Boolean)));
}

function sourceSubmissionId(row: PartnerRecordRow): string {
  return firstText(row.submissionId, row.id, row.taskId);
}

// P11(A8) — 평문 반환. 인코딩은 뷰 계층(예: partners/page.tsx의 router.push)에서 딱 1회만 수행한다.
// 과거엔 여기서 encodeURIComponent를 먼저 적용한 뒤 뷰에서 다시 인코딩해 %253A 이중 인코딩이 발생했다.
export function partnerRouteId(row: PartnerRecordRow): string {
  const submissionId = sourceSubmissionId(row);
  // Sheet3 파서 id(sheet3:{sheet}:{row}:{cellsHash})는 셀 수정만으로 바뀌므로 URL 키로 쓰지 않는다 —
  // 토큰/리드/이메일 등 stable 키를 우선하고, 파서 id는 최후 수단으로만.
  const parserBased = /^sheet3[:\-_]/.test(submissionId);
  if (submissionId && !parserBased) return `submission-${submissionId}`;
  const token = text(row.token);
  if (token) return `submission-token:${token}`;
  const leadId = normalizedLeadId(row);
  if (leadId) return `lead-${leadId}`;
  const email = normalizedEmail(row);
  if (email) return routeEmailHash(email);
  if (submissionId) return `submission-${submissionId}`;
  return `row-${stableHash(JSON.stringify(row))}`;
}

function routeIdCandidates(partner: ScpPartner): string[] {
  return Array.from(new Set([
    partner.routeId,
    ...partner.routeAliases,
    partner.submissionId ? `submission-${partner.submissionId}` : "",
    partner.leadId ? `lead-${partner.leadId}` : "",
    partner.email ? routeEmailHash(partner.email) : "",
    partner.id,
  ].filter(Boolean)));
}

function sameIdentity(row: PartnerRecordRow, source: PartnerRecordRow): boolean {
  const rowProgramId = declaredProgramId(row);
  const sourceProgramId = declaredProgramId(source);
  if (rowProgramId && sourceProgramId && rowProgramId !== sourceProgramId) return false;
  const sourceEmail = normalizedEmail(source);
  const sourceLeadId = normalizedLeadId(source);
  const sourceCreatorId = normalizedCreatorId(source);
  const sourceToken = normalizedToken(source);
  const sourceChannelId = normalizedChannelId(source);
  const sourceYoutubeUrl = normalizedYoutubeUrl(source);
  const sourceHandle = normalizedHandle(source).toLowerCase();
  return Boolean(sourceLeadId && normalizedLeadId(row) === sourceLeadId)
    || Boolean(sourceEmail && normalizedEmail(row) === sourceEmail)
    || Boolean(sourceCreatorId && normalizedCreatorId(row) === sourceCreatorId)
    || Boolean(sourceToken && normalizedToken(row) === sourceToken)
    || Boolean(sourceChannelId && normalizedChannelId(row) === sourceChannelId)
    || Boolean(sourceYoutubeUrl && normalizedYoutubeUrl(row) === sourceYoutubeUrl)
    || Boolean(sourceHandle && normalizedHandle(row).toLowerCase() === sourceHandle);
}

function matchesCreator(creator: PartnerRecordRow, source: PartnerRecordRow): boolean {
  const email = normalizedEmail(source);
  const creatorId = normalizedCreatorId(source);
  const channelId = normalizedChannelId(source);
  const youtubeUrl = normalizedYoutubeUrl(source);
  const handle = normalizedHandle(source).toLowerCase();
  return Boolean(creatorId && text(creator.id) === creatorId)
    || Boolean(email && (lower(creator.email) === email || lower(creator.profileMatchedEmail) === email))
    || Boolean(channelId && firstText(creator.channelId, creator.youtubeChannelId) === channelId)
    || Boolean(youtubeUrl && firstText(creator.youtubeUrl, creator.channelUrl) === youtubeUrl)
    || Boolean(handle && lower(creator.handle) === handle);
}

function channelStatsEntries(channelStats: Record<string, PartnerRecordRow>): Array<[string, PartnerRecordRow]> {
  return Object.entries(channelStats ?? {}).filter((entry): entry is [string, PartnerRecordRow] => !!entry[1] && typeof entry[1] === "object");
}

function findChannelStat(source: PartnerRecordRow, creator: PartnerRecordRow | undefined, channelStats: Record<string, PartnerRecordRow>): PartnerRecordRow | undefined {
  const creatorId = creator ? text(creator.id) : normalizedCreatorId(source);
  const channelId = firstText(normalizedChannelId(source), creator?.channelId, creator?.youtubeChannelId);
  if (creatorId && channelStats[creatorId]) return channelStats[creatorId];
  if (channelId && channelStats[channelId]) return channelStats[channelId];
  return channelStatsEntries(channelStats).find(([, stat]) => firstText(stat.channelId, stat.youtubeChannelId) === channelId)?.[1];
}

function subscriberMetric(...rows: Array<PartnerRecordRow | undefined>): { value: number | null; source?: string } {
  for (const row of rows) {
    if (!row) continue;
    const rowMetrics = metrics(row);
    const value = numberValue(rowMetrics.subscribers) ?? numberValue(row.subscribers) ?? numberValue(row.subscriberCount);
    if (value !== null) return { value, source: "metrics" };
  }
  return { value: null };
}

function channelSubscriberMetric(stat: PartnerRecordRow | undefined): { value: number | null; source?: string } {
  if (!stat) return { value: null };
  const value = numberValue(stat.subscriberCount) ?? numberValue(stat.subscribers);
  return value !== null ? { value, source: "channelStats" } : { value: null };
}

function creatorSubscriberMetric(creator: PartnerRecordRow | undefined): { value: number | null; source?: string } {
  const value = numberValue(creator?.followers);
  return value && value > 0 ? { value, source: "creator" } : { value: null };
}

function reviewStatus(row: PartnerRecordRow): PartnerReviewStatus {
  const raw = lower(row.reviewStatus) || lower(row.status) || lower(row.verdict);
  if (["approved", "approval", "pass", "게시"].includes(raw)) return "approved";
  if (["rejected", "disapproval", "fail", "revise", "수정요청", "반려"].includes(raw)) return "rejected";
  if (["needs_review", "hold"].includes(raw)) return "needs_review";
  if (["pending", "검수중", ""].includes(raw)) return "pending";
  return "unknown";
}

function qualificationStatus(qualification: PartnerRecordRow | undefined, lead: PartnerRecordRow | undefined): string {
  return firstText(qualification?.qualificationStatus, qualification?.finalVerdict, qualification?.status, lead?.qualificationStatus, lead?.finalVerdict, "unknown").toLowerCase();
}

function lifecycleState(profile: PartnerRecordRow | undefined): string {
  return firstText(profile?.currentState, profile?.state, "—");
}

function appLabel(source: PartnerRecordRow, lead: PartnerRecordRow | undefined): string {
  return firstText(source.app, source.gameTitle, source.programTitle, lead?.app, lead?.gameTitle, record(lead?.applicant).app, "SCP");
}

function sourceLabel(kind: PartnerSource["kind"]): string {
  if (kind === "submission") return "submissions";
  if (kind === "lifecycle") return "lifecycle";
  if (kind === "contract") return "contract";
  return "영상 제출 원장";
}

function isReadErrorRow(row: PartnerRecordRow): boolean {
  return row.readError === true;
}

function declaredProgramId(row: PartnerRecordRow): string {
  return firstText(row.canonicalProgramId, row.programId, row.bridgedProgramId, row.campaignProgramId).toLowerCase();
}

function isDeclaredScpProgram(row: PartnerRecordRow): boolean {
  const programId = declaredProgramId(row);
  return programId === "pg-super-creator-partners" || programId === "scp" || programId === "super-creator-partners";
}

function isScpSubmission(row: PartnerRecordRow): boolean {
  if (isReadErrorRow(row)) return false;
  if (declaredProgramId(row)) return isDeclaredScpProgram(row);
  const source = `${lower(row.source)} ${lower(row.sourceType)} ${lower(row.bridgeSource)} ${lower(row.collection)}`;
  if (/\bscp\b|scp_|_scp|sheet3|sheet_3|video_review/.test(source)) return true;
  if (Array.isArray(row.sourceRowRefs) || text(row.bridgeKey)) return true;
  return Boolean(normalizedLeadId(row) && partnerContentUrls(row).length > 0 && normalizedEmail(row));
}

const PARTNER_LIFECYCLE_STATES = new Set([
  "onelink_sent", "uid_requested", "uid_received", "gem_scheduled", "gem_paid",
  "video_task_issued", "video_submitted", "video_review_pending", "video_approved",
  "video_rejected", "needs_resubmission", "live_tracking",
]);

function isActivatedPartnerLifecycle(row: PartnerRecordRow): boolean {
  if (isReadErrorRow(row) || (declaredProgramId(row) && !isDeclaredScpProgram(row))) return false;
  return PARTNER_LIFECYCLE_STATES.has(lower(row.currentState) || lower(row.state));
}

function isActiveScpContract(row: PartnerRecordRow): boolean {
  if (isReadErrorRow(row) || !isDeclaredScpProgram(row)) return false;
  return !["cancelled", "canceled", "rejected", "deleted", "archived"].includes(lower(row.status));
}

function contentDedupeKey(row: PartnerRecordRow): string {
  const email = normalizedEmail(row);
  const at = submittedAt(row);
  const content = partnerContentUrls(row)[0] || "";
  return [email, at, content].filter(Boolean).join("|").toLowerCase();
}

function findRelatedRows(rows: PartnerRecordRow[], source: PartnerRecordRow): PartnerRecordRow[] {
  return rows.filter((row) => !isReadErrorRow(row) && sameIdentity(row, source));
}

function findLifecycleProfile(rows: PartnerRecordRow[], source: PartnerRecordRow, lead: PartnerRecordRow | undefined, creator: PartnerRecordRow | undefined): PartnerRecordRow | undefined {
  const identities = [source, lead, creator].filter(Boolean) as PartnerRecordRow[];
  return rows.find((profile) => identities.some((identity) => sameIdentity(profile, identity))
    || identities.some((identity) => {
      const refs = stringArray(profile.sourceRefs);
      const leadId = normalizedLeadId(identity);
      const creatorId = normalizedCreatorId(identity) || text(identity.id);
      return Boolean((leadId && refs.some((ref) => ref.includes(leadId))) || (creatorId && refs.some((ref) => ref.includes(creatorId))));
    }));
}

// P7 표시 이름 우선순위(src/lib/display-name.ts의 resolveDisplayName과 동일 규칙):
// creatorName > channelName/handle > email > safe short id. 원문 토큰을 그대로 노출하지 않는다.
// (이 파일은 tests/scp-partner-adapter.test.mjs가 외부 임포트 없이 직접 로드하므로 로컬 구현 유지)
function displayName(source: PartnerRecordRow, creator: PartnerRecordRow | undefined, channelStat: PartnerRecordRow | undefined): string {
  // source.creatorName은 채널명과 분리된 실제 제출자 이름 필드일 때만 존재 — 있으면 최우선.
  // creator.name/channelStat.channelName은 이 도메인에서 채널명 성격이라 기존 tier에 남긴다.
  const creatorName = firstUsableName(source.creatorName);
  if (creatorName) return creatorName;
  const channelName = firstUsableName(channelStat?.channelTitle, channelStat?.channelName, channelStat?.title, channelStat?.name, creator?.channelTitle, creator?.channelName, creator?.name, source.channelName);
  if (channelName) return channelName;
  const handle = normalizedHandle(source) || text(creator?.handle);
  if (handle) return handle;
  const email = normalizedEmail(source);
  return email ? emailLocalPart(email) : "SCP 파트너";
}

function partnerFromSource(source: PartnerSource, input: BuildScpPartnersInput): ScpPartner {
  const row = source.row;
  const relatedLead = findRelatedRows(input.programSheetLeads, row)[0];
  const relatedQualification = findRelatedRows(input.scpQualificationRows ?? [], row)[0];
  const creator = input.creators.find((candidate) => matchesCreator(candidate, row) || (relatedLead ? matchesCreator(candidate, relatedLead) : false));
  const channelStat = findChannelStat(row, creator, input.channelStats);
  const lifecycleProfile = findLifecycleProfile(input.scpLifecycleProfiles ?? [], row, relatedLead, creator);
  const sourceRows = source.kind === "submission" ? [row] : [];
  const sheetRows = source.kind === "sheet3" ? [row] : [];
  const subscriberFromMetrics = subscriberMetric(row, relatedLead, relatedQualification);
  const subscriberFromChannel = channelSubscriberMetric(channelStat);
  const subscriberFromCreator = creatorSubscriberMetric(creator);
  const subscribers = subscriberFromMetrics.value ?? subscriberFromChannel.value ?? subscriberFromCreator.value;
  const subscriberSource = subscriberFromMetrics.source ?? subscriberFromChannel.source ?? subscriberFromCreator.source;
  const routeId = partnerRouteId(row);
  const email = normalizedEmail(row) || normalizedEmail(relatedLead ?? {}) || lower(creator?.email) || lower(creator?.profileMatchedEmail);
  const leadId = normalizedLeadId(row) || normalizedLeadId(relatedLead ?? {});
  const submissionId = source.kind === "submission" ? sourceSubmissionId(row) : firstText(row.submissionId);
  return {
    id: routeId,
    routeId,
    routeAliases: [routeId],
    name: displayName(row, creator, channelStat),
    handle: normalizedHandle(row) || text(creator?.handle) || (email ? `@${emailLocalPart(email).replace(/\s+/g, "")}` : "—"),
    email,
    leadId: leadId || undefined,
    submissionId: submissionId || undefined,
    creatorId: normalizedCreatorId(row) || text(creator?.id) || undefined,
    channelId: normalizedChannelId(row) || firstText(creator?.channelId, channelStat?.channelId) || undefined,
    youtubeUrl: normalizedYoutubeUrl(row) || firstText(creator?.youtubeUrl, channelStat?.url) || undefined,
    country: firstText(row.country, applicant(relatedLead ?? {}).country, relatedLead?.country, creator?.region, "—"),
    app: appLabel(row, relatedLead),
    subscribers,
    subscribersSource: subscriberSource,
    reviewStatus: reviewStatus(row),
    qualificationStatus: qualificationStatus(relatedQualification, relatedLead),
    lifecycleState: lifecycleState(lifecycleProfile),
    submittedAtIso: submittedAt(row),
    sourceLabel: sourceLabel(source.kind),
    sourceRefs: [sourceRef(row, source.kind)],
    contentUrls: partnerContentUrls(row),
    submissions: sourceRows,
    sheetVideoRows: sheetRows,
    lead: relatedLead,
    qualification: relatedQualification,
    creator,
    channelStat,
    lifecycleProfile,
    submissionTasks: findRelatedRows(input.submissionTasks ?? [], row),
    creatorLinks: findRelatedRows(input.creatorLinks ?? [], row),
  };
}

function mergePartner(base: ScpPartner, next: ScpPartner): ScpPartner {
  const preferred = base.sourceLabel === "submissions" ? base : next.sourceLabel === "submissions" ? next : base;
  const fallback = preferred === base ? next : base;
  const preferredName = firstUsableName(preferred.name);
  const fallbackName = firstUsableName(fallback.name);
  const preferredEmailFallback = Boolean(preferred.email) && preferredName.toLowerCase() === emailLocalPart(preferred.email).toLowerCase();
  const fallbackEmailFallback = Boolean(fallback.email) && fallbackName.toLowerCase() === emailLocalPart(fallback.email).toLowerCase();
  const preferredRealName = preferredEmailFallback ? "" : preferredName;
  const fallbackRealName = fallbackEmailFallback ? "" : fallbackName;
  const mergedHandle = preferred.handle !== "—" ? preferred.handle : fallback.handle;
  return {
    ...preferred,
    name: preferredRealName || fallbackRealName || (mergedHandle !== "—" ? mergedHandle : "") || preferredName || fallbackName || preferred.name || fallback.name || "SCP 파트너",
    handle: mergedHandle,
    email: preferred.email || fallback.email,
    leadId: preferred.leadId || fallback.leadId,
    submissionId: preferred.submissionId || fallback.submissionId,
    subscribers: preferred.subscribers ?? fallback.subscribers,
    subscribersSource: preferred.subscribersSource ?? fallback.subscribersSource,
    reviewStatus: preferred.reviewStatus !== "unknown" ? preferred.reviewStatus : fallback.reviewStatus,
    qualificationStatus: preferred.qualificationStatus !== "unknown" ? preferred.qualificationStatus : fallback.qualificationStatus,
    lifecycleState: preferred.lifecycleState !== "—" ? preferred.lifecycleState : fallback.lifecycleState,
    submittedAtIso: preferred.submittedAtIso || fallback.submittedAtIso,
    sourceLabel: preferred.sourceLabel === fallback.sourceLabel ? preferred.sourceLabel : "제출 원장 통합",
    sourceRefs: Array.from(new Set([...preferred.sourceRefs, ...fallback.sourceRefs])),
    routeAliases: Array.from(new Set([...preferred.routeAliases, ...fallback.routeAliases, preferred.routeId, fallback.routeId])),
    contentUrls: Array.from(new Set([...preferred.contentUrls, ...fallback.contentUrls])),
    submissions: [...preferred.submissions, ...fallback.submissions],
    sheetVideoRows: [...preferred.sheetVideoRows, ...fallback.sheetVideoRows],
    lead: preferred.lead ?? fallback.lead,
    qualification: preferred.qualification ?? fallback.qualification,
    creator: preferred.creator ?? fallback.creator,
    channelStat: preferred.channelStat ?? fallback.channelStat,
    lifecycleProfile: preferred.lifecycleProfile ?? fallback.lifecycleProfile,
    submissionTasks: [...preferred.submissionTasks, ...fallback.submissionTasks],
    creatorLinks: [...preferred.creatorLinks, ...fallback.creatorLinks],
  };
}

function samePartnerKey(partner: ScpPartner): string[] {
  return [
    partner.submissionId ? `submission:${partner.submissionId}` : "",
    partner.leadId ? `lead:${partner.leadId}` : "",
    partner.email && partner.submittedAtIso ? `email-date:${partner.email}|${partner.submittedAtIso}` : "",
    partner.email && partner.contentUrls[0] ? `email-url:${partner.email}|${partner.contentUrls[0]}` : "",
    partner.email ? `email:${partner.email}` : "",
    partner.creatorId ? `creator:${partner.creatorId}` : "",
  ].filter(Boolean).map((value) => value.toLowerCase());
}

export function buildScpPartners(input: BuildScpPartnersInput): ScpPartner[] {
  const sources: PartnerSource[] = [
    ...input.submissions.filter(isScpSubmission).map((row) => ({ row, kind: "submission" as const })),
    ...(input.scpLifecycleProfiles ?? []).filter(isActivatedPartnerLifecycle).map((row) => ({ row, kind: "lifecycle" as const })),
    ...(input.contracts ?? []).filter(isActiveScpContract).map((row) => ({ row, kind: "contract" as const })),
  ];
  const partners: ScpPartner[] = [];
  const keyToIndex = new Map<string, number>();
  for (const source of sources) {
    const partner = partnerFromSource(source, input);
    const keys = samePartnerKey(partner);
    const existingIndex = keys.map((key) => keyToIndex.get(key)).find((index): index is number => typeof index === "number");
    if (typeof existingIndex === "number") {
      partners[existingIndex] = mergePartner(partners[existingIndex], partner);
      for (const key of samePartnerKey(partners[existingIndex])) keyToIndex.set(key, existingIndex);
      continue;
    }
    const index = partners.length;
    partners.push(partner);
    for (const key of keys) keyToIndex.set(key, index);
    const contentKey = contentDedupeKey(source.row);
    if (contentKey) keyToIndex.set(`content:${contentKey}`, index);
  }
  return partners.sort((left, right) => text(right.submittedAtIso).localeCompare(text(left.submittedAtIso)) || left.name.localeCompare(right.name));
}

// P11(A8) — 과도기 하위호환: routeId가 새 평문 규칙(1회 인코딩)으로 들어오면 첫 후보에서 바로 매칭되고,
// 과거 이중 인코딩(%253A)으로 공유/북마크된 링크는 추가 디코드 단계에서 매칭된다. decodeURIComponent가
// 잘못된 시퀀스에 예외를 던질 수 있어 각 단계는 방어적으로 시도한다.
export function findScpPartnerByRouteId(partners: ScpPartner[], routeId: string): ScpPartner | undefined {
  const candidates = new Set<string>([routeId]);
  let current = routeId;
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      candidates.add(next);
      current = next;
    } catch {
      break;
    }
  }
  return partners.find((partner) => {
    const partnerCandidates = routeIdCandidates(partner);
    return Array.from(candidates).some((candidate) => partnerCandidates.includes(candidate));
  });
}

export function reviewStatusLabel(status: PartnerReviewStatus): string {
  if (status === "approved") return "승인";
  if (status === "rejected") return "반려";
  if (status === "needs_review") return "검토필요";
  if (status === "pending") return "검수중";
  return "미상";
}

export function qualificationStatusLabel(status: string): string {
  const normalized = status.toLowerCase();
  if (["pass", "approved", "approval", "합격"].includes(normalized)) return "자격 pass";
  if (["fail", "rejected", "disapproval", "불합격"].includes(normalized)) return "자격 fail";
  if (["pending", "hold", "unreviewed"].includes(normalized)) return "자격 pending";
  return "자격 —";
}
