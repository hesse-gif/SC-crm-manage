import { canonicalCreatorId, creatorProfileSlug } from "../../lib/creator-identity.ts";
import type { ChatConversation } from "../../lib/chat-normalization";
import type { Campaign, Program, ProgramApplication, ProgramApplicationStatus } from "./types";

export type ProgramFunnelStage =
  | "sent"
  | "responded"
  | "applied"
  | "passed"
  | "oneLink"
  | "videoSubmitted"
  | "approved"
  | "paid";

export type ProgramResponseSource = "none" | "reply" | "sheet" | "both";

export type ProgramFunnelCounts = Record<ProgramFunnelStage, number>;

export type ProgramFunnelPerson = {
  readonly key: string;
  readonly programId: string;
  readonly name: string;
  readonly avatar: string;
  readonly email: string;
  readonly emailMasked: string;
  readonly handle: string;
  readonly youtubeUrl: string;
  readonly creatorId: string;
  readonly followers: number;
  readonly region: string;
  readonly category: string;
  readonly updatedAtIso: string;
  readonly campaignIds: readonly string[];
  readonly campaignTitles: readonly string[];
  readonly stages: Readonly<Record<ProgramFunnelStage, boolean>>;
  readonly furthestStage: ProgramFunnelStage;
  readonly responseSource: ProgramResponseSource;
  readonly applicationStatus?: ProgramApplicationStatus;
  readonly href: string | null;
  readonly meta: string;
};

export type ProgramFunnel = {
  readonly programId: string;
  readonly counts: ProgramFunnelCounts;
  readonly people: readonly ProgramFunnelPerson[];
};

export type ProgramFunnelInput = {
  readonly programs: readonly Program[];
  readonly campaigns?: readonly Campaign[];
  readonly applications?: readonly ProgramApplication[];
  readonly sheetLeads?: readonly Record<string, unknown>[];
  readonly conversations?: readonly ChatConversation[];
  readonly creatorLinks?: readonly Record<string, unknown>[];
  readonly submissionTasks?: readonly Record<string, unknown>[];
  readonly submissions?: readonly Record<string, unknown>[];
};

export const PROGRAM_FUNNEL_STAGES: ReadonlyArray<{ key: ProgramFunnelStage; label: string; shortLabel: string }> = [
  { key: "sent", label: "발송", shortLabel: "발송" },
  { key: "responded", label: "반응", shortLabel: "반응" },
  { key: "applied", label: "신청", shortLabel: "신청" },
  { key: "passed", label: "합격", shortLabel: "합격" },
  { key: "oneLink", label: "OneLink", shortLabel: "OneLink" },
  { key: "videoSubmitted", label: "영상 제출", shortLabel: "제출" },
  { key: "approved", label: "승인", shortLabel: "승인" },
  { key: "paid", label: "지급", shortLabel: "지급" },
];

const STAGE_ORDER = PROGRAM_FUNNEL_STAGES.map((stage) => stage.key);
const EMPTY_COUNTS = Object.freeze(Object.fromEntries(STAGE_ORDER.map((stage) => [stage, 0])) as ProgramFunnelCounts);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function nestedText(value: unknown, key: string): string {
  return text(record(value)[key]);
}

function firstText(values: readonly unknown[]): string {
  for (const value of values) {
    const out = text(value);
    if (out) return out;
  }
  return "";
}

function normalizeEmail(value: unknown): string {
  const email = text(value).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function maskEmail(email: string): string {
  if (!email) return "";
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, Math.min(2, local.length)) || "*"}***@${domain}`;
}

function uniq(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function statusRank(status?: ProgramApplicationStatus): number {
  if (status === "approved") return 4;
  if (status === "hold") return 3;
  if (status === "pending") return 2;
  if (status === "rejected") return 1;
  return 0;
}

function latestIso(...values: unknown[]): string {
  let best = "";
  let bestMillis = 0;
  for (const value of values) {
    const candidate = text(value);
    const millis = Date.parse(candidate);
    if (!Number.isNaN(millis) && millis >= bestMillis) {
      best = candidate;
      bestMillis = millis;
    }
  }
  return best;
}

function programIdFromLead(lead: Record<string, unknown>): string {
  return firstText([
    lead.programId,
    lead.program,
    lead.programSlug,
    nestedText(lead.applicant, "programId"),
    nestedText(lead.applicant, "program"),
    lead.bridgedProgramId,
  ]) || "scp";
}

function leadEmail(lead: Record<string, unknown>): string {
  return normalizeEmail(firstText([
    lead.email,
    lead.creatorEmail,
    nestedText(lead.applicant, "email"),
    nestedText(lead.raw, "email"),
  ]));
}

function identityFor(input: {
  id?: unknown;
  creatorId?: unknown;
  email?: unknown;
  handle?: unknown;
  name?: unknown;
  youtubeUrl?: unknown;
}): string {
  const email = normalizeEmail(input.email);
  if (email) return canonicalCreatorId({ email }) || email;
  return canonicalCreatorId({
    creatorId: text(input.creatorId),
    handle: text(input.handle),
    name: text(input.name),
    youtubeUrl: text(input.youtubeUrl),
  }) || text(input.id);
}

type DraftPerson = {
  programId: string;
  key: string;
  name: string;
  avatar: string;
  email: string;
  handle: string;
  youtubeUrl: string;
  creatorId: string;
  campaignIds: string[];
  campaignTitles: string[];
  sent: boolean;
  reply: boolean;
  sheet: boolean;
  applied: boolean;
  passed: boolean;
  oneLink: boolean;
  videoSubmitted: boolean;
  approved: boolean;
  paid: boolean;
  applicationStatus?: ProgramApplicationStatus;
  followers: number;
  region: string;
  category: string;
  updatedAtIso: string;
};

function blankDraft(programId: string, key: string): DraftPerson {
  return {
    programId,
    key,
    name: "이름 없음",
    avatar: "?",
    email: "",
    handle: "",
    youtubeUrl: "",
    creatorId: "",
    campaignIds: [],
    campaignTitles: [],
    sent: false,
    reply: false,
    sheet: false,
    applied: false,
    passed: false,
    oneLink: false,
    videoSubmitted: false,
    approved: false,
    paid: false,
    followers: 0,
    region: "",
    category: "",
    updatedAtIso: "",
  };
}

function mergeDraft(base: DraftPerson, patch: Partial<DraftPerson>): DraftPerson {
  const next = base;
  const patchName = text(patch.name);
  const patchNameIsEmail = Boolean(normalizeEmail(patchName));
  const baseNameIsEmail = Boolean(normalizeEmail(base.name));
  next.name = patchName && (base.name === "이름 없음" || baseNameIsEmail || (!patchNameIsEmail && patchName.length > base.name.length)) ? patchName : base.name;
  next.avatar = text(patch.avatar) && base.avatar === "?" ? text(patch.avatar) : base.avatar;
  next.email = base.email || text(patch.email);
  next.handle = base.handle || text(patch.handle);
  next.youtubeUrl = base.youtubeUrl || text(patch.youtubeUrl);
  next.creatorId = base.creatorId || text(patch.creatorId);
  next.campaignIds = uniq([...base.campaignIds, ...(patch.campaignIds ?? [])]);
  next.campaignTitles = uniq([...base.campaignTitles, ...(patch.campaignTitles ?? [])]);
  next.sent = base.sent || patch.sent === true;
  next.reply = base.reply || patch.reply === true;
  next.sheet = base.sheet || patch.sheet === true;
  next.applied = base.applied || patch.applied === true;
  next.passed = base.passed || patch.passed === true;
  next.oneLink = base.oneLink || patch.oneLink === true;
  next.videoSubmitted = base.videoSubmitted || patch.videoSubmitted === true;
  next.approved = base.approved || patch.approved === true;
  next.paid = base.paid || patch.paid === true;
  if (statusRank(patch.applicationStatus) > statusRank(base.applicationStatus)) next.applicationStatus = patch.applicationStatus;
  next.followers = base.followers || patch.followers || 0;
  next.region = base.region || text(patch.region);
  next.category = base.category || text(patch.category);
  next.updatedAtIso = latestIso(base.updatedAtIso, patch.updatedAtIso);
  return next;
}

function leadStatusPassed(lead: Record<string, unknown>): boolean {
  const status = firstText([lead.qualificationStatus, lead.status, lead.finalVerdict]).toLowerCase();
  return status === "pass" || status === "passed" || status === "approved" || status === "qualified";
}

function submissionApproved(row: Record<string, unknown>): boolean {
  const status = firstText([row.reviewStatus, row.status]).toLowerCase();
  return status === "approved" || status === "pass" || status === "passed";
}

function conversationHasInboundReply(conversation: ChatConversation): boolean {
  if (conversation.hasCreatorReply === true) return true;
  const inboundAt = text(conversation.lastInboundAtIso);
  if (inboundAt && Number.isFinite(Date.parse(inboundAt))) return true;
  if (conversation.lastMessageFrom === "creator") return true;
  return (conversation.messages ?? []).some((message) => message.from === "creator");
}

/**
 * Flu bug (헤세, 2026-09-17 프로드 실측): `campaign_outreach` 소스의 conversation 문서는 캠페인
 * 타겟 전원에 대해 **초안(draft) 단계에서 즉시** 생성되고(functions/chat-ai.ts
 * executeCampaignOutreachProviderAttempt 계열), 실제 발송 여부는 이후 `lastDeliveryState` 로만
 * 갱신된다 — 예: "deferred_awaiting_send_authorization" → "queued_for_review" /
 * "skipped_undeliverable"(CAMPAIGN_OUTREACH_UNDELIVERABLE_STATE) / "sent" /
 * "sent_evidence_pending". 이 함수가 없었을 때는 conversation 이 존재하기만 하면 무조건
 * `sent: true` 로 upsert 돼서, Snake Clash×Pororo 캠페인(cp-mu421htee9bn)은 실발송 271건인데
 * 633건(캠페인 타겟 전원)이 "발송"으로 집계·표시됐다.
 *
 * "발송으로 센다" 의 판정 집합은 functions/operationalSnapshot.ts 의 `outboundRowCountsAsSent` /
 * `NOT_DELIVERED_ROW_STATES` 와 functions/nudgeReportFacts.ts 의 `isDeliveredOutboundLogRow`를
 * 근거로 한다 — 두 정본 모두 허용목록은 `sent` **하나뿐**이다. `sent_evidence_pending` 은
 * `NOT_DELIVERED_ROW_STATES` 에 명시적으로 들어 있고 `outboundRowCountsAsSent` 주석도 "발송이
 * 아니다"라고 못박는다("나갔을 수도 있다"는 정황 증거일 뿐, provider 미확인 상태). 그래서
 * `queued_for_review` · `skipped_undeliverable` · `deferred_awaiting_send_authorization` ·
 * `sent_evidence_pending` · `failed` · `blocked` · `suppressed_*` 등은 전부 발송이 아니고,
 * `sent` 만 발송으로 센다.
 *
 * `lastDeliveryState` 가 아예 없는 conversation(이 필드가 생기기 전에 쓰인 레거시 문서, 또는
 * campaign_outreach 가 아닌 다른 출처)은 "안 보냈다"는 명시적 증거가 없다. `ChatConversation` 에
 * 전용 발신 타임스탬프 필드가 없어 더 강한 증거를 요구할 수 없으므로, 과거 실제 발송을 안전하지
 * 않게 숨기지 않기 위해 종전 동작(발송으로 집계)을 그대로 유지한다.
 */
const CONVERSATION_SENT_DELIVERY_STATES: ReadonlySet<string> = new Set(["sent"]);

function conversationCountsAsSent(conversation: ChatConversation): boolean {
  const deliveryState = text(conversation.lastDeliveryState).toLowerCase();
  if (!deliveryState) return true;
  return CONVERSATION_SENT_DELIVERY_STATES.has(deliveryState);
}


function submissionPaid(row: Record<string, unknown>): boolean {
  const status = firstText([row.paymentStatus, row.payableStatus, row.payStatus]).toLowerCase();
  return status === "paid" || row.paid === true || Boolean(text(row.paidAt) || text(row.paidAtIso));
}

export function isScpProgramId(programId: unknown): boolean {
  const normalized = text(programId).toLowerCase();
  return normalized === "scp" || normalized.startsWith("scp-") || normalized.includes("_scp") || normalized.includes("-scp") || normalized.endsWith("scp");
}


function submissionProgramId(row: Record<string, unknown>): string {
  return firstText([row.programId, row.program, row.programSlug]) || "scp";
}

function personHref(person: DraftPerson): string | null {
  const slug = creatorProfileSlug({
    creatorId: person.creatorId,
    email: person.email,
    handle: person.handle,
    name: person.name,
    youtubeUrl: person.youtubeUrl,
  });
  return slug ? `/flu/influencers/${encodeURIComponent(slug)}` : null;
}

function furthestStage(stages: Record<ProgramFunnelStage, boolean>): ProgramFunnelStage {
  for (let i = STAGE_ORDER.length - 1; i >= 0; i -= 1) {
    const key = STAGE_ORDER[i];
    if (stages[key]) return key;
  }
  return "sent";
}

function responseSource(reply: boolean, sheet: boolean): ProgramResponseSource {
  if (reply && sheet) return "both";
  if (reply) return "reply";
  if (sheet) return "sheet";
  return "none";
}

function draftToPerson(draft: DraftPerson): ProgramFunnelPerson {
  const stages: Record<ProgramFunnelStage, boolean> = {
    // Flu bug (2026-09-17 리뷰 보강): "sent" 는 다른 단계들과 달리 **문자 그대로의 발송 증거**여야
    // 한다 — 예전에는 draft.reply/sheet/applied 등 더 뒤 단계가 하나라도 true 면 "sent" 도 자동으로
    // true 로 추론했다(더 진행했으면 당연히 보냈을 거라는 가정). 그런데 conversation 은 회신
    // 여부와 lastDeliveryState 가 서로 다른 신호라 — 예를 들어 queued_for_review 상태인 대화에
    // (다른 채널 유입 등으로) hasCreatorReply 가 찍혀 있으면, 추론식은 "발송 안 됨" 증거를 무시하고
    // sent 를 true 로 되살렸다(이번에 고친 list≠KPI 불일치와 같은 부류). draft.sent 는 이제
    // conversationCountsAsSent 가 결정한 literal 값이므로 그대로 쓴다 — 이 사람은 여전히
    // responded/applied 단계로는 보인다(아래), 다만 발송 단계로는 아니다.
    sent: draft.sent,
    responded: draft.reply || draft.sheet || draft.applied,
    applied: draft.applied || draft.sheet,
    passed: draft.passed || draft.videoSubmitted || draft.approved || draft.paid,
    oneLink: draft.oneLink,
    videoSubmitted: draft.videoSubmitted,
    approved: draft.approved,
    paid: draft.paid,
  };
  const meta = [draft.campaignTitles.join(", "), draft.handle, maskEmail(draft.email), draft.region, draft.followers ? `${draft.followers.toLocaleString("ko-KR")} 팔로워` : "", draft.category]
    .filter(Boolean)
    .join(" · ");
  return {
    key: draft.key,
    programId: draft.programId,
    name: draft.name,
    avatar: draft.avatar || draft.name.slice(0, 1),
    email: draft.email,
    emailMasked: maskEmail(draft.email),
    handle: draft.handle,
    youtubeUrl: draft.youtubeUrl,
    creatorId: draft.creatorId,
    followers: draft.followers,
    region: draft.region,
    category: draft.category,
    updatedAtIso: draft.updatedAtIso,
    campaignIds: draft.campaignIds,
    campaignTitles: draft.campaignTitles,
    stages,
    furthestStage: furthestStage(stages),
    responseSource: responseSource(draft.reply, draft.sheet),
    applicationStatus: draft.applicationStatus,
    href: personHref(draft),
    meta,
  };
}

function emptyFunnel(programId: string): ProgramFunnel {
  return { programId, counts: { ...EMPTY_COUNTS }, people: [] };
}

function campaignProgramId(campaignsById: Map<string, Campaign>, campaignId: string): string {
  return campaignsById.get(campaignId)?.programId || "";
}

export function buildProgramFunnels(input: ProgramFunnelInput): ProgramFunnel[] {
  const programs = input.programs ?? [];
  const campaigns = input.campaigns ?? [];
  const byProgram = new Map<string, Map<string, DraftPerson>>();
  const campaignsById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const programIds = new Set(programs.map((program) => program.id));

  const upsert = (programIdRaw: string, identity: string, patch: Partial<DraftPerson>) => {
    const programId = programIdRaw || "scp";
    if (!programIds.has(programId) && programIds.size > 0 && programId !== "scp") return;
    const programMap = byProgram.get(programId) ?? new Map<string, DraftPerson>();
    const fallbackSeed = text(patch.email) || text(patch.name) || text(patch.creatorId) || `${programMap.size}`;
    const key = identity || `${programId}:${fallbackSeed}`;
    const draft = programMap.get(key) ?? blankDraft(programId, key);
    programMap.set(key, mergeDraft(draft, patch));
    byProgram.set(programId, programMap);
  };

  for (const conversation of input.conversations ?? []) {
    const programId = conversation.programId || campaignProgramId(campaignsById, conversation.campaignId || "");
    if (!programId) continue;
    const email = normalizeEmail(conversation.creatorEmail);
    // C4 (2026-09-06 Aside 게이트 후속): 문서 id를 이름 폴백에 넣지 않는다 — 이름·핸들·이메일이
    // 전부 없으면 blankDraft 의 기본값 "이름 없음"이 그대로 남는다(mergeDraft 는 빈 문자열
    // patchName 을 base.name 에 반영하지 않는다). raw id 를 화면에 노출하지 않는다는 규칙은
    // src/lib/display-name.ts 의 resolveDisplayName 과 같다.
    const name = firstText([conversation.creatorName, conversation.creatorHandle, email]);
    const identity = identityFor({ creatorId: conversation.creatorId, email, handle: conversation.creatorHandle, name });
    const replied = conversationHasInboundReply(conversation);
    upsert(programId, identity, {
      name,
      avatar: conversation.creatorAvatar || name.slice(0, 1),
      email,
      handle: conversation.creatorHandle,
      creatorId: conversation.creatorId,
      campaignIds: conversation.campaignId ? [conversation.campaignId] : [],
      campaignTitles: conversation.campaignTitle ? [conversation.campaignTitle] : [],
      sent: conversationCountsAsSent(conversation),
      reply: replied,
      updatedAtIso: firstText([conversation.lastMessageAtIso, conversation.updatedAtIso]),
    });
  }

  for (const application of input.applications ?? []) {
    const identity = identityFor({
      id: application.id,
      creatorId: application.creatorId,
      email: application.email,
      handle: application.handle,
      name: application.name,
      youtubeUrl: application.youtubeUrl,
    });
    upsert(application.programId, identity, {
      name: application.name,
      avatar: application.avatar || application.name.slice(0, 1),
      email: normalizeEmail(application.email),
      handle: application.handle,
      youtubeUrl: application.youtubeUrl,
      creatorId: application.creatorId,
      campaignIds: application.campaignId ? [application.campaignId] : [],
      campaignTitles: application.campaignTitle ? [application.campaignTitle] : [],
      applied: true,
      passed: application.status === "approved",
      applicationStatus: application.status,
      oneLink: Boolean((application as { creatorLinkRef?: unknown }).creatorLinkRef),
      videoSubmitted: Boolean(application.reviewId),
      updatedAtIso: application.submittedAtIso,
      followers: application.followers,
      region: application.region,
      category: application.category,
    });
  }

  const leadIdentityById = new Map<string, { programId: string; identity: string; email: string }>();
  for (const lead of input.sheetLeads ?? []) {
    const applicant = record(lead.applicant);
    const email = leadEmail(lead);
    // C4: id를 이름 폴백에서 뺀다(위 conversations 루프와 같은 이유).
    const name = firstText([lead.name, lead.channelName, applicant.name, applicant.channelName, email]);
    const handle = firstText([lead.handle, applicant.handle, lead.youtubeHandle, applicant.youtubeHandle]);
    const youtubeUrl = firstText([lead.youtubeUrl, applicant.youtubeUrl, lead.channelUrl, applicant.channelUrl]);
    const creatorId = firstText([lead.creatorId, lead.bridgedCreatorId]);
    const identity = identityFor({ id: lead.id, creatorId, email, handle, name, youtubeUrl });
    const programId = programIdFromLead(lead);
    if (text(lead.id)) leadIdentityById.set(text(lead.id), { programId, identity, email });
    upsert(programId, identity, {
      name,
      avatar: firstText([lead.avatar, lead.thumbnailUrl, applicant.avatar, name.slice(0, 1)]),
      email,
      handle,
      youtubeUrl,
      creatorId,
      sheet: true,
      applied: true,
      passed: leadStatusPassed(lead),
      oneLink: Boolean(text(lead.creatorLinkRef) || text(lead.creatorLinkUrl) || text(lead.appsflyerOneLink)),
      videoSubmitted: Boolean(text(lead.submissionRef) || text(lead.latestSubmissionRef)),
      updatedAtIso: firstText([lead.submittedAtIso, lead.createdAtIso, lead.updatedAtIso]),
      followers: numberValue(record(lead.metrics).subscribers) || numberValue(lead.followers),
      region: firstText([lead.country, applicant.country, lead.region]),
      category: firstText([lead.category, applicant.category]),
    });
  }

  for (const link of input.creatorLinks ?? []) {
    const leadId = text(link.leadId);
    const linkedLead = leadIdentityById.get(leadId);
    const email = normalizeEmail(firstText([link.email, linkedLead?.email]));
    const creatorId = firstText([link.creatorId, linkedLead?.identity]);
    const identity = linkedLead?.identity || identityFor({ id: link.id, creatorId, email, name: link.channelName });
    upsert(firstText([link.programId, linkedLead?.programId]) || "scp", identity, {
      // C4: id를 이름 폴백에서 뺀다.
      name: firstText([link.channelName, link.creatorName, email]),
      email,
      creatorId,
      oneLink: true,
      updatedAtIso: firstText([link.updatedAtIso, link.createdAtIso]),
    });
  }

  for (const task of input.submissionTasks ?? []) {
    const leadId = text(task.leadId);
    const linkedLead = leadIdentityById.get(leadId);
    const email = normalizeEmail(firstText([task.email, linkedLead?.email]));
    const creatorId = firstText([task.creatorId, linkedLead?.identity]);
    const identity = linkedLead?.identity || identityFor({ id: task.id, creatorId, email, name: task.channelName });
    upsert(firstText([task.programId, linkedLead?.programId]) || "scp", identity, {
      // C4: id를 이름 폴백에서 뺀다.
      name: firstText([task.channelName, task.creatorName, email]),
      email,
      creatorId,
      passed: true,
      updatedAtIso: firstText([task.updatedAtIso, task.createdAtIso]),
    });
  }

  for (const submission of input.submissions ?? []) {
    const leadId = text(submission.leadId);
    const linkedLead = leadIdentityById.get(leadId);
    const email = normalizeEmail(firstText([submission.email, linkedLead?.email]));
    const creatorId = firstText([submission.creatorId, linkedLead?.identity]);
    const identity = linkedLead?.identity || identityFor({ id: submission.id, creatorId, email, name: submission.channelName });
    upsert(firstText([submission.programId, linkedLead?.programId]) || submissionProgramId(submission), identity, {
      // C4 (2026-09-06 Aside 게이트 후속): id/token 을 이름 폴백에서 뺀다 — 실측: 토큰 전용
      // 픽스처(scripts/seed-emulator.mjs 의 token:llnwm00fixtureghost1 등, submissionId 없이
      // token 만 있는 P7/P11 재현용 시드)가 이름 자리에 "token:llnwm00fixtureghost1"을 그대로
      // 노출했다. 이름·핸들·이메일이 전부 없으면 blankDraft 의 기본값 "이름 없음"이 남는다.
      name: firstText([submission.channelName, submission.creatorName, email]),
      email,
      creatorId,
      passed: true,
      videoSubmitted: true,
      approved: submissionApproved(submission),
      paid: submissionPaid(submission),
      updatedAtIso: firstText([submission.updatedAtIso, submission.submittedAtIso, submission.createdAtIso]),
    });
  }

  return programs.map((program) => {
    const people = Array.from(byProgram.get(program.id)?.values() ?? [])
      .map(draftToPerson)
      // Flu bug (2026-09-17): a campaign_outreach draft that was never actually sent (see
      // conversationCountsAsSent above) and has no other funnel evidence (no reply, no
      // application, ...) carries every stage flag false. `furthestStage` defaults such a
      // person to "sent" for lack of any true stage, which would resurrect them as a
      // 발송 person in the UI even though counts.sent (below) correctly excludes them. Drop
      // them outright instead of inventing a "draft"/"unsent" stage the UI does not have.
      .filter((person) => STAGE_ORDER.some((stage) => person.stages[stage]))
      .sort((left, right) => {
        const byStage = STAGE_ORDER.indexOf(right.furthestStage) - STAGE_ORDER.indexOf(left.furthestStage);
        return byStage || left.name.localeCompare(right.name, "ko");
      });
    const counts = { ...EMPTY_COUNTS };
    for (const person of people) {
      for (const stage of STAGE_ORDER) {
        if (person.stages[stage]) counts[stage] += 1;
      }
    }
    return { programId: program.id, counts, people };
  });
}

export function programFunnelById(funnels: readonly ProgramFunnel[]): Map<string, ProgramFunnel> {
  return new Map(funnels.map((funnel) => [funnel.programId, funnel]));
}

export function emptyProgramFunnel(programId: string): ProgramFunnel {
  return emptyFunnel(programId);
}

/**
 * 프로그램 퍼널 카운트를 "미정"으로 표시해야 하는지의 정본 규칙.
 *
 * 목록 화면과 상세 화면이 **같은 판정**을 써야 한다. 예전에는 상세만 이 규칙을 알고
 * (`selectedFunnelHasUnknownCounts`), 목록은 집계가 없을 때 `emptyProgramFunnel`(전 필드 0)로
 * 메워서 "승인 0/150건 · 0%"라는 확정형 거짓 0을 그렸다 — 실제로는 신청 74건·발송 9,487건이
 * 있는 프로그램이었다(2026-09-05 프로드 실측). 집계 부재를 0으로 은폐하지 않는다.
 *
 * SCP 계열 프로그램의 카운트 정본은 canonical 집계(운영 스냅샷 또는 aggregateScpProgramFunnel)
 * 뿐이라, 둘 다 이 프로그램을 모르면 카운트는 모르는 값이다. 그 밖의 프로그램은 클라이언트
 * 라이브 조인이 정본이므로 이 규칙을 적용하지 않는다.
 */
/**
 * C2 (2026-09-05 Aside 실측): 폴백이 있어도, **이 프로그램의 canonical 서버 집계 요청이 지금
 * 진행 중**이면 미정을 유지한다. 신선한 스냅샷·서버 집계가 이미 있으면(위 두 필드) 그쪽이
 * 여전히 이긴다 — 이 신호는 "정본이 아직 하나도 없는데 곧 온다"는 딱 그 순간에만 폴백을
 * 가린다. 안 가리면 SCP_CPM_2608 처럼 폴백의 그럴듯한 오답(예: 반응 193/신청 0)이 확정형
 * 숫자로 잠깐 그려졌다가 ~0.4초 뒤 진짜 값(229/75)으로 바뀌는 조용한 오해가 생긴다.
 *
 * Flu/Task-67: 요청이 실패한 뒤에도 fresh snapshot/server 집계가 없으면 같은 규칙을 유지한다.
 * 실패 배너 옆에서 fallback 숫자를 확정값으로 그리면 운영자가 "실패했지만 숫자는 믿어도 됨"으로
 * 읽는다. 실패 상태의 fallback 은 정본 부재를 대신하지 않는다.
 */
export function programFunnelCountsUnknown(input: {
  readonly isScpProgram: boolean;
  readonly hasSnapshotFunnel: boolean;
  readonly hasServerFunnel: boolean;
  /** partial·stale 스냅샷 폴백. 정본은 아니지만 실측 수치라 "미정"은 아니다. */
  readonly hasFallbackFunnel?: boolean;
  /** 이 프로그램의 서버 집계(aggregateScpProgramFunnel) 요청이 지금 진행 중인가. */
  readonly serverFunnelRequestPending?: boolean;
  /** 이 프로그램의 서버 집계 요청이 실패했고 fresh 정본이 아직 없는가. */
  readonly serverFunnelRequestFailed?: boolean;
}): boolean {
  if (!input.isScpProgram) return false;
  const missingCanonicalFunnel = !input.hasSnapshotFunnel && !input.hasServerFunnel;
  if (missingCanonicalFunnel && (input.serverFunnelRequestPending || input.serverFunnelRequestFailed)) return true;
  return missingCanonicalFunnel && !input.hasFallbackFunnel;
}

export function peopleForFunnelStage(funnel: ProgramFunnel | null | undefined, stage: ProgramFunnelStage): ProgramFunnelPerson[] {
  return (funnel?.people ?? []).filter((person) => person.stages[stage]);
}

// W32-C2: the funnel tile count (snapshot-wide aggregate) and the drill-down people list are two
// independent pipelines. The list is a 200-person sample of the FULL population, but the sample is
// no longer pure recency: compareFunnelPeopleForSample (functions/scpProgramFunnelAggregate.ts)
// takes everyone carrying a post-sent stage first, then fills with sent-only people by recency. So
// responded/passed/videoSubmitted/approved/paid stages now read list == count, and only the sent
// stage can still be truncated. Never shrink the count to match the list; only detect the remaining
// gap so it can be shown, not hidden.
export function programFunnelPeopleSampleGap(stageCount: number | null, visiblePeopleCount: number): boolean {
  return stageCount !== null && stageCount > visiblePeopleCount;
}

export function responseSourceLabel(source: ProgramResponseSource): string {
  if (source === "both") return "회신+시트 제출";
  if (source === "reply") return "회신";
  if (source === "sheet") return "시트 제출";
  return "반응 없음";
}

/**
 * C7 (2026-09-05 Aside 실측): `aggregateScpProgramFunnel` 이 반환하는 `truncated` 키(예:
 * `conversationsMarkerlessLegacy`)는 functions/scpProgramFunnelAggregate.ts 내부 구현
 * 식별자다 — 운영자 화면에 원문 그대로 노출하면 "이게 뭔지" 알 수 없는 내부 문자열이 배너에
 * 박힌다. 여기서 사람이 읽을 라벨로 옮긴다. 모르는 키(향후 소스 추가·오탈자)는 원문을 그대로
 * 보여주지 않고 일반 라벨로 닫는다 — 실패가 "알 수 없는 내부 키 노출" 방향으로 열리지 않게.
 */
const SCP_FUNNEL_TRUNCATION_SOURCE_LABELS: Readonly<Record<string, string>> = {
  conversations: "대화 스캔 상한 도달",
  conversationsMarkerlessLegacy: "레거시 대화 스캔 상한 도달",
};

const SCP_FUNNEL_TRUNCATION_GENERIC_LABEL = "집계 소스 일부 상한 도달";

export function scpFunnelTruncationSourceLabel(sourceKey: string): string {
  return SCP_FUNNEL_TRUNCATION_SOURCE_LABELS[sourceKey] ?? SCP_FUNNEL_TRUNCATION_GENERIC_LABEL;
}

/** 대화 truncated 키(둘 다 같은 스캔 한 번에서 나온다) — 이 값만 전용 배너로 뺀다. */
const CONVERSATION_SCAN_TRUNCATION_SOURCE_KEYS: ReadonlySet<string> = new Set([
  "conversations",
  "conversationsMarkerlessLegacy",
]);

export function isConversationScanTruncationSource(sourceKey: string): boolean {
  return CONVERSATION_SCAN_TRUNCATION_SOURCE_KEYS.has(sourceKey);
}

// #11(a) (2026-09-05 Aside 실측): functions/scpProgramFunnelAggregate.ts 의
// CONVERSATION_REPLY_SCAN_CAP 과 같은 값 — 서버 상수를 클라이언트에서 재선언한다(그 파일은
// 이번 클라이언트 전용 수정 범위 밖이라 값을 export 해서 가져올 수 없다). 상수가 바뀌면 이
// 배너 문구도 같이 갱신해야 한다.
export const CONVERSATION_SCAN_CAP = 5000;

/**
 * "집계 읽기 상한(conversationsMarkerlessLegacy)" 같은 내부 키 대신, 무엇이 얼마나 스캔됐는지
 * 사람이 읽는 문장으로 말한다. `scannedCount` 는 서버가 `scanned.conversations` 로 실어 보내는
 * 실제 스캔 건수(N) — 캡에 걸렸으면 항상 CONVERSATION_SCAN_CAP 과 같다. 전체 대화 수(M)는
 * 서버가 아직 세지 않아(전량 카운트 쿼리가 필요) 이 클라이언트 전용 수정 범위 밖이다 — 그
 * 값을 모를 때는 스캔 건수만 밝히고 지어내지 않는다.
 */
export function conversationScanCapBannerText(scannedCount: number | null | undefined): string {
  const scanned = typeof scannedCount === "number" && Number.isFinite(scannedCount)
    ? Math.max(0, Math.trunc(scannedCount))
    : null;
  const scanNote = scanned === null ? "" : ` (스캔 ${scanned.toLocaleString("ko-KR")}건)`;
  return `대화 스캔이 상한 ${CONVERSATION_SCAN_CAP.toLocaleString("ko-KR")}건에 걸려 반응 수는 하한값입니다${scanNote}.`;
}
