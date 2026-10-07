import { SCP_PROGRAM_ALIAS_IDS, isScpLikeProgramId, normalizeScpProgramId } from "./scpProgramAlias";
import type { WhereFilterOp } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, makeCache } from "./shared";
import type { CallableRequestShape } from "./shared";
import { SCP_APPLICATION_MANAGEMENT_COLLECTION } from "./applicationManagementStore";
import {
  REVIEW_STATE_PORTAL_PROGRAM_ALIAS_IDS,
  resolveReviewStateProgramId,
  type ReviewStateProgramResolutionDeps,
} from "./reviewStateProgramResolution";

const ACTION = "scp_program_funnel.aggregate";
const READ_ROLES = ["super_admin", "admin", "manager"] as const;
const SAMPLE_LIMIT = 10;
const PEOPLE_SAMPLE_LIMIT = 200;
const FIRESTORE_IN_LIMIT = 30;
/**
 * W7-1c-fix (2026-09-06): bound on the canonical-approvals source read (scp_video_review_state).
 * Unlike the sibling collections above, this one grows per submission across EVERY program (not
 * per program), so an unbounded full scan on a global (no requestedProgramIds) request is unsafe.
 * Prod measured 231 rows system-wide (2026-09-05); generous headroom until well past that.
 */
const REVIEW_STATE_APPROVED_SCAN_CAP = 5000;

// "sheetLeads" 는 이 계약의 **apply(신청) 스테이지**다. 이름은 구글시트만이 신청 경로이던
// 시절의 잔재이고, 지금은 시트 리드 ∪ 포털 신청을 담는다. 와이어 키는 소비처 60여 곳이
// 물려 있어 유지한다 — 의미는 여기 정본으로 적는다.
export type ScpProgramFunnelCanonicalStage = "sent" | "sheetLeads" | "responded" | "passed" | "oneLinkSent" | "videoSubmitted" | "approved" | "paid";

// W45-FIX: view-cpm 은 포털이 "모든" 신청에 붙이는 전역 단일 ID다 — 특정 프로그램을 가리키지
// 않는다. 지금까지 들어온 신청이 전부 pg-super-creator-partners 였을 뿐이고, 여기서 정적으로
// 매핑하면(예전 W45-F1) 앞으로 들어올 다른 CPM 프로그램 신청까지 SCP 로 잘못 귀속된다(독립
// 리뷰 NO-SHIP 블로커). 그래서 이제는 귀속에 쓰지 않는다 — 신청별 귀속은 토큰 유래
// currentProgramId 만 쓴다. 이 상수는 scp_application_management 를 "탐색"할 때만 참조로
// 남긴다(아래 applications 쿼리의 identity.programId 조건과 루프의 포털 별칭 가드).
// 토큰 없는(또는 currentProgramId 자리에 이 별칭만 있는) 신청은 포털 토큰 흐름을 수리한 뒤
// 백필로 해소한다.
// Single source of truth for this literal: functions/scpPortalApplyBindingAuthority.ts's
// PORTAL_PROGRAM_ID, re-exported by functions/reviewStateProgramResolution.ts (the same module
// the canonical-approvals source below and the review-tab list/badge callables all resolve
// through — one alias set, not one literal per file).
const PORTAL_PROGRAM_ALIAS = REVIEW_STATE_PORTAL_PROGRAM_ALIAS_IDS[0];

export interface ScpProgramFunnelPersonSample {
  key: string;
  programId: string;
  name: string;
  email: string;
  emailMasked: string;
  handle: string;
  creatorId: string;
  stages: Record<ScpProgramFunnelCanonicalStage, boolean>;
  evidenceRefs: Record<ScpProgramFunnelCanonicalStage, string[]>;
  updatedAtIso: string;
}

export interface ScpProgramFunnelAggregateRow {
  programId: string;
  counts: Record<ScpProgramFunnelCanonicalStage, number>;
  evidenceRefs: Record<ScpProgramFunnelCanonicalStage, string[]>;
  people: ScpProgramFunnelPersonSample[];
}

export interface ScpProgramFunnelAggregateEnvelope {
  ok: true;
  generatedAtIso: string;
  scanned: Record<string, number>;
  /** 읽기 상한에 걸려 일부만 집계된 컬렉션. true 면 그 컬렉션 유래 카운트는 하한이다. */
  truncated: Record<string, boolean>;
  /**
   * W7-1c-fix (2026-09-06): `units.approved`(→ 각 행의 `counts.approved`)에 기여한 원시 신호 수,
   * 출처별. `legacy` = `submissions`/`review_ledger`(구 심사 파이프라인). `canonical` =
   * `scp_video_review_state`(v3 검수 원장 — 포털 전역 태그로 남아 있던 행은
   * reviewStateProgramResolution.ts 로 실 프로그램을 조인한 뒤에만 센다). 두 수는 전역
   * 합계이고(요청 프로그램 무관), `counts.approved` 자체는 이미 두 출처를 합쳐 중복 없이
   * 반영한다 — 이 필드는 "어디서 왔나"를 보여주는 진단용이다.
   */
  approvedSources: { legacy: number; canonical: number };
  aggregates: ScpProgramFunnelAggregateRow[];
  cache: ReturnType<typeof makeCache>;
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
}

type SourceRow = Record<string, unknown> & { id: string; ref: string };
type Draft = {
  programId: string;
  key: string;
  name: string;
  email: string;
  handle: string;
  creatorId: string;
  stages: Record<ScpProgramFunnelCanonicalStage, boolean>;
  evidenceRefs: Record<ScpProgramFunnelCanonicalStage, string[]>;
  updatedAtIso: string;
};

type AliasIndex = {
  peopleByProgram: Map<string, Map<string, Draft>>;
  aliasToKeyByProgram: Map<string, Map<string, string>>;
};

// W45-FIX: videoSubmitted/approved counts are submission-document-unit (§canonicalStageMetrics
// parity), unlike every other stage which is person-unit. This tracks that per-program.
type SubmissionUnits = { submitted: Set<string>; approved: Set<string> };

function submissionUnitsFor(index: Map<string, SubmissionUnits>, programId: string): SubmissionUnits {
  const existing = index.get(programId);
  if (existing) return existing;
  const created: SubmissionUnits = { submitted: new Set(), approved: new Set() };
  index.set(programId, created);
  return created;
}

const EMPTY_STAGE_FLAGS: Record<ScpProgramFunnelCanonicalStage, boolean> = {
  sent: false,
  sheetLeads: false,
  responded: false,
  passed: false,
  oneLinkSent: false,
  videoSubmitted: false,
  approved: false,
  paid: false,
};


/**
 * 이 집계가 Firestore 에 요구하는 **최소 표면**. `adminDb` 는 모듈 스코프 import 라 주입점이 없었고,
 * 그래서 "읽는 범위"에 관한 계약이 전부 소스 정규식으로만 잠겨 있었다(정규식은 행이 실제로 세어지는지
 * 증명하지 못한다). 이 타입 하나로 노드 레인이 가짜 Firestore 를 물릴 수 있다.
 */
export type FunnelAggregateQuery = {
  where(field: string, op: WhereFilterOp, value: unknown): FunnelAggregateQuery;
  select(...fields: string[]): FunnelAggregateQuery;
  limit(count: number): FunnelAggregateQuery;
  get(): Promise<{
    readonly size: number;
    readonly docs: readonly { readonly id: string; data(): Record<string, unknown> | undefined }[];
  }>;
};
export type FunnelAggregateDocRef = {
  get(): Promise<{ readonly exists: boolean; data(): Record<string, unknown> | undefined }>;
};
// `.doc()` only exists on the fresh collection reference (matches real Firestore: a Query built
// from `.where()`/`.select()` cannot `.doc()`). Needed for the canonical-approvals join below
// (subject.applicationId -> scp_application_management.currentProgramId, reviewStateProgramResolution.ts).
export type FunnelAggregateCollection = FunnelAggregateQuery & {
  doc(id: string): FunnelAggregateDocRef;
};
export type FunnelAggregateDb = { collection(name: string): FunnelAggregateCollection };

const defaultFunnelAggregateDb = adminDb as unknown as FunnelAggregateDb;

export async function aggregateScpProgramFunnel(
  request: CallableRequestShape,
  deps: { db?: FunnelAggregateDb } = {},
): Promise<ScpProgramFunnelAggregateEnvelope> {
  const db = deps.db ?? defaultFunnelAggregateDb;
  // 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): NOT gated by
  // assertScpEntitled — this funnel aggregate backs the general-purpose Programs page
  // (src/app/(app)/flu/programs/page.tsx), reachable by every org regardless of scp mailbox
  // entitlement, not exclusive to /flu/scp. READ_ROLES (manager+) remains the only gate here.
  const auth = assertNonGuestAuth(request, ACTION, READ_ROLES);
  const data = asRecord(request.data);
  const requestedProgramIds = normalizeProgramIds(data.programIds);
  const requestedSet = requestedProgramIds.length > 0 ? new Set(requestedProgramIds) : null;
  const requestedProgramQueryIds = programQueryIds(requestedProgramIds);

  const leadFields = [
    "programId", "program", "programSlug", "bridgedProgramId", "email", "creatorEmail", "applicant", "raw", "name", "channelName", "handle", "youtubeHandle", "youtubeUrl", "channelUrl", "creatorId", "bridgedCreatorId", "qualificationStatus", "status", "finalVerdict", "submittedAtIso", "createdAtIso", "updatedAtIso", "qualifiedAtIso",
  ];
  const coldmailFields = [
    "programId", "email", "emailLower", "koreanName", "youtubeUrl", "creatorId", "handle", "deliveryState", "hasReply", "replyReceivedAtIso", "repliedAtIso", "replyAtIso", "lastReplyAtIso", "sentAtIso", "createdAtIso", "updatedAtIso", "conversationId", "trackingId",
  ];
  const outreachFields = [
    "programId", "email", "status", "campaign", "leadRef", "coldSentAtIso", "createdAtIso", "updatedAtIso",
  ];
  const campaignFields = [
    "programId",
  ];
  // 2026-09-28 owner scope decision (codex adversarial review round 2, finding #2): this funnel
  // aggregate is general SCP-program data, not a scp@ mailbox surface — out of the scp org-filter's
  // scope (role-only, unchanged) per 헤세's decision that general SCP-program data stays role-gated.
  const conversationFields = [
    "programId", "campaignId", "creatorEmail", "creatorName", "creatorHandle", "creatorId", "hasCreatorReply", "lastInboundAtIso", "lastMessageFrom", "messages", "lastMessageAtIso", "updatedAtIso",
  ];
  const decisionFields = [
    "programId", "leadId", "email", "creatorId", "creatorName", "channelName", "finalVerdict", "decision", "status", "result", "aiRecommendation", "decidedAtIso", "createdAtIso", "updatedAtIso",
  ];
  const mailResultFields = [
    "programId", "leadId", "email", "creatorId", "creatorName", "channelName", "status", "result", "sentAtIso", "createdAtIso", "updatedAtIso", "mailType", "templateType", "templateKind", "kind", "onelinkUrl",
  ];
  const submissionTaskFields = [
    "programId", "leadId", "email", "creatorId", "creatorName", "channelName", "handle", "taskStatus", "issuedAtIso", "createdAtIso", "updatedAtIso",
  ];
  const applicationFields = [
    "identity", "currentProgramId", "classification", "submittedAtIso", "createdAtIso", "updatedAtIso",
  ];
  const submissionFields = [
    "programId", "leadId", "email", "creatorId", "creatorName", "channelName", "handle", "reviewStatus", "status", "source", "contentType", "submittedAtIso", "createdAtIso", "updatedAtIso", "paymentStatus", "payableStatus", "paid", "paidAt", "paidAtIso",
  ];
  const reviewLedgerFields = [
    "programId", "submissionId", "leadId", "email", "creatorId", "status", "reviewStatus", "canonicalStatus", "decidedAtIso", "paidAt", "paidAtIso", "updatedAtIso", "createdAtIso",
  ];

  const [leads, coldmailHistory, outreachRows, campaignRows] = await Promise.all([
    readCollectionRowsForScope(db, "program_sheet_leads", leadFields, requestedProgramIds, [
      { field: "programId", values: requestedProgramQueryIds },
      { field: "program", values: requestedProgramQueryIds },
      { field: "programSlug", values: requestedProgramQueryIds },
      { field: "bridgedProgramId", values: requestedProgramQueryIds },
      { field: "applicant.programId", values: requestedProgramQueryIds },
      { field: "applicant.program", values: requestedProgramQueryIds },
    ]),
    readCollectionRowsForScope(db, "scp_coldmail_history", coldmailFields, requestedProgramIds, [
      { field: "programId", values: requestedProgramQueryIds },
    ]),
    readCollectionRowsForScope(db, "scp_outreach", outreachFields, requestedProgramIds, [
      { field: "programId", values: requestedProgramQueryIds },
    ]),
    readCollectionRowsForScope(db, "campaigns", campaignFields, requestedProgramIds, [
      { field: "programId", values: requestedProgramQueryIds },
    ]),
  ]);
  const applications = await readCollectionRowsForScope(db, "scp_application_management", applicationFields, requestedProgramIds, [
    // 탐색용: identity.programId 는 포털 전역 별칭(view-cpm)이라 귀속 매핑이 아니라 포털 발원 행을
    // 놓치지 않기 위한 탐색 조건이다(F-7). 실제 프로그램 귀속은 아래 루프에서 currentProgramId 로만
    // 판정한다.
    { field: "identity.programId", values: [...requestedProgramQueryIds, PORTAL_PROGRAM_ALIAS] },
    { field: "currentProgramId", values: requestedProgramQueryIds },
  ]);

  const index: AliasIndex = { peopleByProgram: new Map(), aliasToKeyByProgram: new Map() };
  const submissionUnits = new Map<string, SubmissionUnits>();
  // W7-1c-fix: diagnostic-only counters for the approvedSources envelope field below.
  let legacyApprovedAdditions = 0;
  let canonicalApprovedAdditions = 0;
  const leadLookup = new Map<string, { programId: string; aliases: string[]; email: string; creatorId: string; name: string }>();
  const submissionLookup = new Map<string, { programId: string; aliases: string[]; email: string; creatorId: string; name: string }>();
  const coldmailProgramByEmail = new Map<string, string>();
  const coldmailProgramByConversation = new Map<string, string>();
  const campaignProgramById = new Map<string, string>();
  for (const campaign of campaignRows) {
    const rawProgramId = firstText([campaign.programId]);
    if (!rawProgramId) continue;
    campaignProgramById.set(campaign.id, normalizeProgramId(rawProgramId));
  }

  let scopedLeadRows = 0;
  for (const lead of leads) {
    const programId = normalizeProgramId(programIdFromLead(lead));
    if (!shouldIncludeProgram(programId, requestedSet)) continue;
    scopedLeadRows += 1;
    const email = leadEmail(lead);
    const creatorId = firstText([lead.creatorId, lead.bridgedCreatorId]);
    // C4 (2026-09-06 Aside 게이트 후속): 이름 자리 폴백에서 원본 문서 id를 뺀다 — 이름·핸들·
    // 이메일이 전부 없으면 finalizeAggregate() 의 finalizePersonName() 이 "이름 없음"으로 채운다.
    const name = firstText([lead.name, lead.channelName, nestedText(lead.applicant, "name"), nestedText(lead.applicant, "channelName"), email]);
    const handle = firstText([lead.handle, lead.youtubeHandle, nestedText(lead.applicant, "handle"), nestedText(lead.applicant, "youtubeHandle")]);
    const aliases = aliasesFor({ leadId: lead.id, email, creatorId, handle, name, youtubeUrl: firstText([lead.youtubeUrl, lead.channelUrl, nestedText(lead.applicant, "youtubeUrl")]) });
    leadLookup.set(lead.id, { programId, aliases, email, creatorId, name });
    upsert(index, programId, aliases, {
      name,
      email,
      handle,
      creatorId,
      updatedAtIso: firstText([lead.updatedAtIso, lead.submittedAtIso, lead.createdAtIso]),
      evidence: { sheetLeads: lead.ref },
      stages: { sheetLeads: true },
    });
  }

  // W45-F3: 포털 신청(scp_application_management)은 이 집계의 어떤 소스에도 없었다. apply 신호가
  // program_sheet_leads(구글시트) 하나뿐이라 포털로 들어온 신청이 통째로 빠졌다. 토큰 없이 들어온
  // 귀속은 **토큰 유래 currentProgramId 만** 신뢰한다. identity.programId 는 포털 전역 별칭이라
  // 프로그램을 특정하지 못하고, 그 별칭이 currentProgramId 자리에 들어온 경우도 마찬가지다(프로드 1건).
  // 귀속 근거가 없는 신청은 어느 프로그램에도 더하지 않고 미귀속 카운터로만 남긴다 — 숫자를 낮추는
  // 것이 아니라, 없는 귀속을 지어내지 않으면서 사라지지도 않게 하는 것이다(F-7).
  let portalApplicationsUnidentified = 0;
  for (const application of applications) {
    const identity = asRecord(application.identity);
    const attributed = firstText([application.currentProgramId]);
    if (!attributed || attributed.toLowerCase() === PORTAL_PROGRAM_ALIAS) {
      portalApplicationsUnidentified += 1;
      continue;
    }
    const programId = normalizeProgramId(attributed);
    if (!shouldIncludeProgram(programId, requestedSet)) continue;
    const creatorId = firstText([asString(identity.fluCreatorId)]);
    const channelId = firstText([asString(identity.channelId)]);
    upsert(index, programId, creatorId || channelId ? aliasesFor({ creatorId, handle: channelId }) : [`application:${application.id}`], {
      // C4 (2026-09-06 Aside 게이트 후속): 원본 문서 id를 이름 폴백에서 뺀다.
      name: firstText([creatorId, channelId]),
      creatorId,
      updatedAtIso: firstText([application.submittedAtIso, application.createdAtIso, application.updatedAtIso]),
      evidence: { sheetLeads: application.ref },
      stages: { sheetLeads: true },
    });
  }

  for (const history of coldmailHistory) {
    const programId = normalizeProgramId(firstText([history.programId]));
    if (!shouldIncludeProgram(programId, requestedSet)) continue;
    if (!coldmailHistorySent(history)) continue;
    const email = normalizeEmail(firstText([history.email, history.emailLower]));
    if (email) coldmailProgramByEmail.set(email, programId);
    for (const conversationId of [firstText([history.conversationId]), firstText([history.trackingId])].filter(Boolean)) {
      coldmailProgramByConversation.set(conversationId, programId);
    }
    const creatorId = firstText([history.creatorId]);
    // C4 (2026-09-06 Aside 게이트 후속): 원본 문서 id를 이름 폴백에서 뺀다.
    const name = firstText([history.koreanName, history.handle, email]);
    const handle = firstText([history.handle]);
    const aliases = aliasesFor({ email, creatorId, handle, name, youtubeUrl: firstText([history.youtubeUrl]) });
    const replied = coldmailHistoryResponded(history);
    upsert(index, programId, aliases, {
      name,
      email,
      handle,
      creatorId,
      updatedAtIso: firstText([history.sentAtIso, history.updatedAtIso, history.createdAtIso]),
      evidence: { sent: history.ref, ...(replied ? { responded: history.ref } : {}) },
      stages: { sent: true, responded: replied },
    });
  }

  for (const outreach of outreachRows) {
    const programId = normalizeProgramId(firstText([outreach.programId]));
    if (!shouldIncludeProgram(programId, requestedSet)) continue;
    if (!outreachSent(outreach)) continue;
    const email = normalizeEmail(outreach.email);
    const leadId = firstText([outreach.leadRef]).split("/").at(-1) ?? "";
    const linkedLead = leadLookup.get(leadId);
    const aliases = aliasesFor({ leadId, email: email || linkedLead?.email, creatorId: linkedLead?.creatorId, name: linkedLead?.name });
    const replied = outreachResponded(outreach);
    upsert(index, programId, aliases, {
      // C4 (2026-09-06 Aside 게이트 후속): 원본 문서 id를 이름 폴백에서 뺀다.
      name: firstText([linkedLead?.name, email]),
      email: email || linkedLead?.email,
      creatorId: linkedLead?.creatorId,
      updatedAtIso: firstText([outreach.updatedAtIso, outreach.coldSentAtIso, outreach.createdAtIso]),
      evidence: { sent: outreach.ref, ...(replied ? { responded: outreach.ref } : {}) },
      stages: { sent: true, responded: replied },
    });
  }

  const scopedLeadIds = Array.from(leadLookup.keys());

  const [conversationScan, decisions, mailResults, submissionTasks, submissions] = await Promise.all([
    readRepliedConversationRows(db, conversationFields, {
      programQueryIds: requestedProgramQueryIds,
      campaignIds: [...campaignProgramById.keys()],
    }),
    readCollectionRowsForScope(db, "qualification_decisions", decisionFields, requestedProgramIds, [
      { field: "programId", values: requestedProgramQueryIds },
      { field: "leadId", values: scopedLeadIds },
    ]),
    readCollectionRowsForScope(db, "scp_mail_results", mailResultFields, requestedProgramIds, [
      { field: "programId", values: requestedProgramQueryIds },
      { field: "leadId", values: scopedLeadIds },
    ]),
    readCollectionRowsForScope(db, "submission_tasks", submissionTaskFields, requestedProgramIds, [
      { field: "programId", values: requestedProgramQueryIds },
      { field: "leadId", values: scopedLeadIds },
    ]),
    readCollectionRowsForScope(db, "submissions", submissionFields, requestedProgramIds, [
      { field: "programId", values: requestedProgramQueryIds },
      { field: "leadId", values: scopedLeadIds },
    ]),
  ]);

  const conversations = conversationScan.rows;
  let scopedConversationRows = 0;
  for (const conversation of conversations) {
    if (!conversationHasInboundReply(conversation)) continue;
    const email = normalizeEmail(conversation.creatorEmail);
    // 귀속 근거(대화의 programId · 캠페인 · 콜드메일 이메일/대화 ID) 가 하나도 없는 대화는 어느
    // 프로그램에도 더하지 않는다. normalizeProgramId("") 는 레거시 기본값 "scp"(=SCP canonical)
    // 로 접히므로, 그냥 넘기면 미귀속 답장이 전부 SCP 로 흘러든다.
    const programId = conversationProgramIdForAggregate([
      conversation.programId,
      campaignProgramById.get(firstText([conversation.campaignId])),
      coldmailProgramByEmail.get(email),
      coldmailProgramByConversation.get(conversation.id),
    ]);
    if (programId === null) continue;
    if (!shouldIncludeProgram(programId, requestedSet)) continue;
    scopedConversationRows += 1;
    const creatorId = firstText([conversation.creatorId]);
    const handle = firstText([conversation.creatorHandle]);
    // C4 (2026-09-06 Aside 게이트 후속): 원본 문서 id를 이름 폴백에서 뺀다.
    const name = firstText([conversation.creatorName, handle, email]);
    const aliases = email || creatorId || handle
      ? aliasesFor({ email, creatorId, handle, name })
      : [`conversation:${conversation.id}`];
    upsert(index, programId, aliases, {
      name,
      email,
      handle,
      creatorId,
      updatedAtIso: firstText([conversation.lastInboundAtIso, conversation.lastMessageAtIso, conversation.updatedAtIso]),
      evidence: { responded: conversation.ref },
      stages: { responded: true },
    });
  }

  for (const decision of decisions) {
    const linkedLead = leadLookup.get(firstText([decision.leadId]));
    const programId = normalizeProgramId(firstText([decision.programId, linkedLead?.programId]));
    if (!shouldIncludeProgram(programId, requestedSet)) continue;
    if (!qualificationDecisionPassed(decision)) continue;
    const email = normalizeEmail(firstText([decision.email, linkedLead?.email]));
    const creatorId = firstText([decision.creatorId, linkedLead?.creatorId]);
    // C4 (2026-09-06 Aside 게이트 후속): 원본 문서 id를 이름 폴백에서 뺀다.
    const name = firstText([decision.creatorName, decision.channelName, linkedLead?.name, email]);
    const aliases = aliasesFor({ leadId: firstText([decision.leadId]), email, creatorId, name });
    upsert(index, programId, aliases, {
      name,
      email,
      creatorId,
      updatedAtIso: firstText([decision.decidedAtIso, decision.updatedAtIso, decision.createdAtIso]),
      evidence: { passed: decision.ref },
      stages: { passed: true },
    });
  }

  for (const mail of mailResults) {
    const linkedLead = leadLookup.get(firstText([mail.leadId]));
    const programId = normalizeProgramId(firstText([mail.programId, linkedLead?.programId]));
    if (!shouldIncludeProgram(programId, requestedSet)) continue;
    if (!oneLinkMailSent(mail)) continue;
    const email = normalizeEmail(firstText([mail.email, linkedLead?.email]));
    const creatorId = firstText([mail.creatorId, linkedLead?.creatorId]);
    // C4 (2026-09-06 Aside 게이트 후속): 원본 문서 id를 이름 폴백에서 뺀다.
    const name = firstText([mail.creatorName, mail.channelName, linkedLead?.name, email]);
    const aliases = aliasesFor({ leadId: firstText([mail.leadId]), email, creatorId, name });
    upsert(index, programId, aliases, {
      name,
      email,
      creatorId,
      updatedAtIso: firstText([mail.sentAtIso, mail.updatedAtIso, mail.createdAtIso]),
      evidence: { oneLinkSent: mail.ref },
      stages: { oneLinkSent: true },
    });
  }

  for (const task of submissionTasks) {
    const linkedLead = leadLookup.get(firstText([task.leadId]));
    const programId = normalizeProgramId(firstText([task.programId, linkedLead?.programId]));
    if (!shouldIncludeProgram(programId, requestedSet)) continue;
    const email = normalizeEmail(firstText([task.email, linkedLead?.email]));
    const creatorId = firstText([task.creatorId, linkedLead?.creatorId]);
    // C4 (2026-09-06 Aside 게이트 후속): 원본 문서 id를 이름 폴백에서 뺀다.
    const name = firstText([task.creatorName, task.channelName, linkedLead?.name, email]);
    const aliases = aliasesFor({ leadId: firstText([task.leadId]), email, creatorId, handle: firstText([task.handle]), name });
    upsert(index, programId, aliases, {
      name,
      email,
      handle: firstText([task.handle]),
      creatorId,
      updatedAtIso: firstText([task.issuedAtIso, task.updatedAtIso, task.createdAtIso]),
      evidence: { passed: task.ref },
      stages: { passed: true },
    });
  }

  for (const submission of submissions) {
    const linkedLead = leadLookup.get(firstText([submission.leadId]));
    const programId = normalizeProgramId(firstText([submission.programId, linkedLead?.programId]));
    if (!shouldIncludeProgram(programId, requestedSet)) continue;
    if (!isScpSubmission(submission)) continue;
    const submissionApproved = canonicalReviewStatus(submission.reviewStatus ?? submission.status) === "approved";
    const units = submissionUnitsFor(submissionUnits, programId);
    units.submitted.add(submission.id);
    if (submissionApproved) {
      units.approved.add(submission.id);
      legacyApprovedAdditions += 1;
    }
    const email = normalizeEmail(firstText([submission.email, linkedLead?.email]));
    const creatorId = firstText([submission.creatorId, linkedLead?.creatorId]);
    // C4 (2026-09-06 Aside 게이트 후속 — 실측 재현: 26-09-06 Playwright, submissions/token:<token>
    // 픽스처가 이름 자리에 "token:<token>" 을 그대로 노출했다): 원본 문서 id/token 을 이름
    // 폴백에서 뺀다. 이름·핸들·이메일이 전부 없으면 finalizePersonName() 이 "이름 없음"으로 채운다.
    const name = firstText([submission.creatorName, submission.channelName, linkedLead?.name, email]);
    const aliases = aliasesFor({ leadId: firstText([submission.leadId]), email, creatorId, handle: firstText([submission.handle]), name });
    submissionLookup.set(submission.id, { programId, aliases, email, creatorId, name });
    upsert(index, programId, aliases, {
      name,
      email,
      handle: firstText([submission.handle]),
      creatorId,
      updatedAtIso: firstText([submission.updatedAtIso, submission.submittedAtIso, submission.createdAtIso]),
      evidence: { passed: submission.ref, videoSubmitted: submission.ref, ...(canonicalReviewStatus(submission.reviewStatus ?? submission.status) === "approved" ? { approved: submission.ref } : {}), ...(submissionPaid(submission) ? { paid: submission.ref } : {}) },
      stages: { passed: true, videoSubmitted: true, approved: canonicalReviewStatus(submission.reviewStatus ?? submission.status) === "approved", paid: submissionPaid(submission) },
    });
  }

  const reviewLedger = await readCollectionRowsForScope(db, "review_ledger", reviewLedgerFields, requestedProgramIds, [
    { field: "programId", values: requestedProgramQueryIds },
    { field: "leadId", values: scopedLeadIds },
    { field: "submissionId", values: Array.from(submissionLookup.keys()) },
  ]);

  for (const ledger of reviewLedger) {
    const linkedSubmission = submissionLookup.get(firstText([ledger.submissionId]));
    const linkedLead = leadLookup.get(firstText([ledger.leadId]));
    const programId = normalizeProgramId(firstText([ledger.programId, linkedSubmission?.programId, linkedLead?.programId]));
    if (!shouldIncludeProgram(programId, requestedSet)) continue;
    if (canonicalReviewStatus(ledger.canonicalStatus ?? ledger.reviewStatus ?? ledger.status) !== "approved") continue;
    submissionUnitsFor(submissionUnits, programId).approved.add(firstText([ledger.submissionId]) || ledger.id);
    legacyApprovedAdditions += 1;
    const email = normalizeEmail(firstText([ledger.email, linkedSubmission?.email, linkedLead?.email]));
    const creatorId = firstText([ledger.creatorId, linkedSubmission?.creatorId, linkedLead?.creatorId]);
    // C4 (2026-09-06 Aside 게이트 후속): 원본 문서 id를 이름 폴백에서 뺀다.
    const name = firstText([linkedSubmission?.name, linkedLead?.name, email]);
    const aliases = aliasesFor({ submissionId: firstText([ledger.submissionId]), leadId: firstText([ledger.leadId]), email, creatorId, name });
    upsert(index, programId, aliases, {
      name,
      email,
      creatorId,
      updatedAtIso: firstText([ledger.decidedAtIso, ledger.paidAtIso, ledger.paidAt, ledger.updatedAtIso, ledger.createdAtIso]),
      evidence: { approved: ledger.ref },
      stages: { approved: true },
    });
  }

  // W7-1c-fix (2026-09-06): canonical (v3) video approvals — `scp_video_review_state`, state
  // "approved" — were never read by this aggregate (only the legacy submissions/review_ledger
  // pipeline was), so SCP's "승인" KPI showed 80 while 124 canonical approvals existed system-
  // wide, and CPM (zero legacy-pipeline rows) showed 0 while its real video-review pipeline had
  // real activity hidden under the Portal's global apply-gate tag (view-cpm). Joined through the
  // SAME resolver the write path and the review-tab list/badge use
  // (reviewStateProgramResolution.ts) so all three surfaces agree on one program per row.
  const canonicalApprovalRows = await readCanonicalVideoApprovalRows(db, requestedProgramQueryIds);
  const applicationProgramIdCache = new Map<string, Promise<string | null>>();
  const canonicalResolutionDeps: ReviewStateProgramResolutionDeps = {
    getApplicationCurrentProgramId(applicationId) {
      if (!applicationId) return Promise.resolve(null);
      let pending = applicationProgramIdCache.get(applicationId);
      if (!pending) {
        pending = db.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).doc(applicationId).get()
          .then((snapshot) => {
            const data = snapshot.exists ? snapshot.data() : undefined;
            const value = typeof data?.currentProgramId === "string" ? data.currentProgramId.trim() : "";
            return value || null;
          })
          .catch(() => null);
        applicationProgramIdCache.set(applicationId, pending);
      }
      return pending;
    },
  };
  for (const row of canonicalApprovalRows.rows) {
    if (firstText([row.state]).toLowerCase() !== "approved") continue;
    const subject = record(row.subject);
    const resolution = await resolveReviewStateProgramId(
      { canonicalProgramId: row.canonicalProgramId, subject },
      canonicalResolutionDeps,
    );
    // Never invent an attribution: a row the resolver could not place stays out of every
    // program's count — the same discipline as the portal-application "unattributed" bucket
    // above (portalApplicationsUnidentified), not a silent drop.
    if (resolution.programUnresolved) continue;
    const programId = normalizeProgramId(resolution.programId);
    if (!shouldIncludeProgram(programId, requestedSet)) continue;
    canonicalApprovedAdditions += 1;
    const videoSubmissionId = firstText([subject.videoSubmissionId, row.videoSubmissionId]) || row.id;
    // Same Set as the legacy sources above -> a coincidental id collision across pipelines
    // (deliberately unlikely, since they use unrelated id schemes) is deduped for free.
    submissionUnitsFor(submissionUnits, programId).approved.add(videoSubmissionId);
  }

  const aggregates = Array.from(index.peopleByProgram.entries())
    .map(([programId, peopleMap]) => finalizeAggregate(programId, peopleMap, submissionUnitsFor(submissionUnits, programId)))
    .filter((row) => !requestedSet || requestedSet.has(row.programId))
    .sort((left, right) => left.programId.localeCompare(right.programId));

  for (const requested of requestedProgramIds) {
    // W7-1c-fix: use whatever this program already accumulated in submissionUnits (e.g. canonical
    // approvals with no other funnel signal yet) instead of a hardcoded empty pair — identical to
    // the old hardcoded {submitted:Set(),approved:Set()} for a program with no signal at all.
    if (!aggregates.some((row) => row.programId === requested)) aggregates.push(finalizeAggregate(requested, new Map(), submissionUnitsFor(submissionUnits, requested)));
  }

  return {
    ok: true,
    generatedAtIso: new Date().toISOString(),
    scanned: {
      program_sheet_leads: scopedLeadRows,
      // W45-F7: 포털 신청이 조용히 사라지지 않게 관측 가능하게 남긴다. unattributed_global 은
      // **토큰 귀속이 없어 어느 프로그램에도 더하지 못한** 포털 발원 신청 수다. 포털 토큰 흐름을
      // 수리한 뒤 백필로 해소한다(프로드 실측 29건 중 27건이 이 상태이고 지금껏 아무 데도 안 남았다).
      // W45-FIX: 요청 프로그램과 무관한 **전역** 수치다 — 어떤 programIds 로 요청해도 같은 값이
      // 나온다(프로드 실측: SCP 27 · CPM 27). 프로그램별로 오독되지 않게 키 이름에 명시한다.
      scp_application_management: applications.length,
      scp_application_management_unattributed_global: portalApplicationsUnidentified,
      scp_coldmail_history: coldmailHistory.length,
      scp_outreach: outreachRows.length,
      campaigns: campaignRows.length,
      // `readRepliedConversationRows` intentionally reads global reply markers so legacy
      // conversations can still be attributed by campaign/coldmail joins. The public scanned
      // contract is an in-scope diagnostic, so do not expose other programs' marker cardinality.
      conversations: scopedConversationRows,
      qualification_decisions: decisions.length,
      scp_mail_results: mailResults.length,
      submission_tasks: submissionTasks.length,
      submissions: submissions.length,
      review_ledger: reviewLedger.length,
      scp_video_review_state: canonicalApprovalRows.rows.length,
    },
    truncated: {
      conversations: conversationScan.truncated,
      // 마커 없는 레거시 답장(`messages[]` 의 creator 발신만 있는 행)을 다 못 봤는가.
      // 전역 요청은 항상 true 다 — conversations 전량 스캔을 하지 않기 때문이다.
      conversationsMarkerlessLegacy: conversationScan.markerlessLegacyTruncated,
      scp_video_review_state: canonicalApprovalRows.truncated,
    },
    approvedSources: { legacy: legacyApprovedAdditions, canonical: canonicalApprovedAdditions },
    aggregates,
    cache: makeCache(requestedProgramIds.length > 0 ? "scp_program_funnel:program_scoped_select" : "scp_program_funnel:full_scan_select", false, 0),
    behaviorLog: makeBehaviorLog(auth, ACTION, "success", "scp-automation"),
  };
}

type CollectionScope = { field: string; values: readonly string[] };

async function readCollectionRows(db: FunnelAggregateDb, collection: string, fields: string[]): Promise<SourceRow[]> {
  const snapshot = await db.collection(collection).select(...fields).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ref: `${collection}/${doc.id}`, ...(doc.data() ?? {}) }));
}

async function readCollectionRowsForScope(db: FunnelAggregateDb, collection: string, fields: string[], requestedProgramIds: readonly string[], scopes: readonly CollectionScope[]): Promise<SourceRow[]> {
  if (requestedProgramIds.length === 0) return readCollectionRows(db, collection, fields);
  const rows = new Map<string, SourceRow>();
  await Promise.all(scopes.map(async (scope) => {
    const values = Array.from(new Set(scope.values.map((value) => text(value)).filter(Boolean)));
    const chunks = values.length === 1 ? [values] : chunk(values, FIRESTORE_IN_LIMIT);
    await Promise.all(chunks.map(async (valueChunk) => {
      const query = valueChunk.length === 1
        ? db.collection(collection).where(scope.field, "==", valueChunk[0])
        : db.collection(collection).where(scope.field, "in", valueChunk);
      const snapshot = await query.select(...fields).get();
      for (const doc of snapshot.docs) rows.set(doc.id, { id: doc.id, ref: `${collection}/${doc.id}`, ...(doc.data() ?? {}) });
    }));
  }));
  return Array.from(rows.values());
}

const CANONICAL_VIDEO_APPROVAL_FIELDS = ["canonicalProgramId", "state", "subject", "videoSubmissionId", "updatedAtIso"];

/**
 * W7-1c-fix: bounded read of `scp_video_review_state` for the canonical-approvals source. Unlike
 * `readCollectionRowsForScope` above, a global (no requestedProgramIds) request does NOT fall
 * back to an unfiltered full scan — this collection accumulates across every program forever
 * (REVIEW_STATE_APPROVED_SCAN_CAP's comment), not per program like the sibling collections. The
 * Portal apply-gate tag is included in the scope query alongside the requested programs' real
 * identities so a still-unresolved row can be found and joined (resolveReviewStateProgramId
 * decides, per row, whether it actually belongs in scope — this query only bounds what gets read).
 */
async function readCanonicalVideoApprovalRows(
  db: FunnelAggregateDb,
  requestedProgramQueryIds: readonly string[],
): Promise<{ rows: SourceRow[]; truncated: boolean }> {
  const collection = "scp_video_review_state";
  const scopeValues = requestedProgramQueryIds.length > 0
    ? Array.from(new Set([...requestedProgramQueryIds, PORTAL_PROGRAM_ALIAS]))
    : [];
  if (scopeValues.length === 0) {
    const snapshot = await db.collection(collection)
      .select(...CANONICAL_VIDEO_APPROVAL_FIELDS)
      .limit(REVIEW_STATE_APPROVED_SCAN_CAP)
      .get();
    return {
      rows: snapshot.docs.map((doc) => ({ id: doc.id, ref: `${collection}/${doc.id}`, ...(doc.data() ?? {}) })),
      truncated: snapshot.size >= REVIEW_STATE_APPROVED_SCAN_CAP,
    };
  }
  const rows = new Map<string, SourceRow>();
  let truncated = false;
  for (const valueChunk of chunk(scopeValues, FIRESTORE_IN_LIMIT)) {
    const query = valueChunk.length === 1
      ? db.collection(collection).where("canonicalProgramId", "==", valueChunk[0])
      : db.collection(collection).where("canonicalProgramId", "in", valueChunk);
    const snapshot = await query.select(...CANONICAL_VIDEO_APPROVAL_FIELDS).limit(REVIEW_STATE_APPROVED_SCAN_CAP).get();
    if (snapshot.size >= REVIEW_STATE_APPROVED_SCAN_CAP) truncated = true;
    for (const doc of snapshot.docs) rows.set(doc.id, { id: doc.id, ref: `${collection}/${doc.id}`, ...(doc.data() ?? {}) });
  }
  return { rows: Array.from(rows.values()), truncated };
}

// W48: 이 집계가 conversations 에서 쓰는 행은 conversationHasInboundReply 가 true 인 것뿐이다
// (아래 루프 첫 줄에서 나머지는 그대로 버려진다). 예전 구현은 programId·campaignId·
// creatorEmail(콜드메일 이메일 전량을 30개씩 chunked `in`)·conversationId 단건 get 으로
// **읽을 범위**를 잡은 뒤 답장 여부를 메모리에서 걸렀다. 프로드 실측(2026-09-05):
// pg-scp-cpm-2608-2 한 프로그램에 대화 11,137건을 읽어 실제로 쓴 건 100건, 콜러블 지연
// 40~53초(타임아웃 60초 코앞) — 그동안 화면 상단은 계속 "미정"이었다.
// 아래 마커 3종은 conversationHasInboundReply 의 canonical 마커 집합과 같고 각각 단일 필드
// 인덱스로 조회된다(복합 인덱스 불필요). 전 프로덕션 합집합이 464건이다(실측).
// 읽는 집합이 좁아져도 답장 있는 대화는 전부 들어오므로 counts 는 낮아지지 않는다.
const CONVERSATION_REPLY_SCAN_CAP = 5000;
// 각 항목은 "이 마커만 가진 행"이 conversationHasInboundReply 를 통과해야 한다는 계약을 진다
// (tests/scp-program-funnel-conversation-scan.test.mjs 가 실행으로 고정한다). 쿼리를 좁히면서
// 술어를 같이 안 고치면 반응 인원이 조용히 사라지는 게 이 계약이 막는 사고다.
export const CONVERSATION_REPLY_MARKERS = [
  { field: "hasCreatorReply", op: "==" as const, value: true as unknown, sampleRow: { hasCreatorReply: true } },
  { field: "lastInboundAtIso", op: ">" as const, value: "" as unknown, sampleRow: { lastInboundAtIso: "2026-09-05T00:00:00.000Z" } },
  { field: "lastMessageFrom", op: "==" as const, value: "creator" as unknown, sampleRow: { lastMessageFrom: "creator" } },
];

/**
 * 마커 없는 **레거시 답장**의 유계 폴백 상한 (2026-09-05 적대 리뷰 P1).
 *
 * 사고 형상: `conversationHasInboundReply` 는 `messages[]` 안의 creator 발신도 답장으로 인정하는데,
 * 위 마커 3종은 그런 행을 **한 건도 불러오지 못한다**(세 필드가 전부 없다). 게다가 `truncated` 도
 * false 로 남아 화면이 "완전한 수"라고 말했다 — 조용한 과소 계상이다.
 * 그래서 요청 프로그램 스코프가 있을 때는 `programId`/`campaignId` 로 좁힌 **마커 없는** 조회를
 * 유계로 한 번 더 돈다(단일 필드 인덱스 — 새 복합 인덱스 없음).
 */
const CONVERSATION_LEGACY_SCAN_TOTAL_CAP = 5000;
const CONVERSATION_LEGACY_SCAN_CHUNK_CAP = 1000;

type ConversationScanScope = {
  readonly programQueryIds: readonly string[];
  readonly campaignIds: readonly string[];
};

type ConversationScanResult = {
  rows: SourceRow[];
  truncated: boolean;
  /** 마커 없는 레거시 답장을 **다 못 봤다**(스코프 없음 = 아예 못 봄 · 또는 캡 도달). */
  markerlessLegacyTruncated: boolean;
};

async function readRepliedConversationRows(
  db: FunnelAggregateDb,
  fields: string[],
  scope: ConversationScanScope,
): Promise<ConversationScanResult> {
  const rows = new Map<string, SourceRow>();
  let truncated = false;
  const collect = (snapshot: { readonly docs: readonly { readonly id: string; data(): Record<string, unknown> | undefined }[] }) => {
    for (const doc of snapshot.docs) rows.set(doc.id, { id: doc.id, ref: `conversations/${doc.id}`, ...(doc.data() ?? {}) });
  };

  await Promise.all(CONVERSATION_REPLY_MARKERS.map(async (marker) => {
    const snapshot = await db.collection("conversations")
      .where(marker.field, marker.op, marker.value)
      .select(...fields)
      .limit(CONVERSATION_REPLY_SCAN_CAP)
      .get();
    if (snapshot.size >= CONVERSATION_REPLY_SCAN_CAP) truncated = true;
    collect(snapshot);
  }));

  const legacyScopes: CollectionScope[] = [
    { field: "programId", values: scope.programQueryIds },
    { field: "campaignId", values: scope.campaignIds },
  ].filter((entry) => entry.values.length > 0);
  // 스코프가 없으면(전역 요청) 레거시 폴백을 돌리지 않는다 — conversations 전량 스캔이 되기 때문이다.
  // 그 사실을 숨기지 않고 `markerlessLegacyTruncated` 로 표면화한다.
  if (scope.programQueryIds.length === 0) {
    return { rows: Array.from(rows.values()), truncated, markerlessLegacyTruncated: true };
  }

  let legacyBudget = CONVERSATION_LEGACY_SCAN_TOTAL_CAP;
  let markerlessLegacyTruncated = false;
  // 총량 예산을 공유하므로 **순차**다 — 병렬이면 예산을 넘겨 읽는다.
  for (const legacyScope of legacyScopes) {
    const values = Array.from(new Set(legacyScope.values.map((value) => text(value)).filter(Boolean)));
    for (const valueChunk of chunk(values, FIRESTORE_IN_LIMIT)) {
      if (legacyBudget <= 0) { markerlessLegacyTruncated = true; break; }
      const pageLimit = Math.min(legacyBudget, CONVERSATION_LEGACY_SCAN_CHUNK_CAP);
      const query = valueChunk.length === 1
        ? db.collection("conversations").where(legacyScope.field, "==", valueChunk[0])
        : db.collection("conversations").where(legacyScope.field, "in", valueChunk);
      const snapshot = await query.select(...fields).limit(pageLimit).get();
      legacyBudget -= snapshot.size;
      if (snapshot.size >= pageLimit) markerlessLegacyTruncated = true;
      collect(snapshot);
    }
  }
  return { rows: Array.from(rows.values()), truncated, markerlessLegacyTruncated };
}

function normalizeProgramIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => normalizeProgramId(asString(item))).filter(Boolean)));
}

function programQueryIds(programIds: readonly string[]): string[] {
  const canonicalScp = normalizeScpProgramId("scp");
  const queryIds = programIds.flatMap((programId) => programId === canonicalScp ? [...SCP_PROGRAM_ALIAS_IDS] : [programId]);
  return Array.from(new Set(queryIds.map((item) => text(item)).filter(Boolean)));
}

function normalizeProgramId(value: string): string {
  return normalizeScpProgramId(value.trim() || "scp");
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function shouldIncludeProgram(programId: string, requestedSet: Set<string> | null): boolean {
  if (requestedSet) return requestedSet.has(programId);
  return isScpLikeProgramId(programId);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nestedText(value: unknown, key: string): string {
  return text(record(value)[key]);
}

function programIdFromLead(lead: SourceRow): string {
  return firstText([lead.programId, lead.program, lead.programSlug, nestedText(lead.applicant, "programId"), nestedText(lead.applicant, "program"), lead.bridgedProgramId]) || "scp";
}

function leadEmail(lead: SourceRow): string {
  return normalizeEmail(firstText([lead.email, lead.creatorEmail, nestedText(lead.applicant, "email"), nestedText(lead.raw, "email")]));
}

function aliasesFor(input: { leadId?: string; submissionId?: string; email?: string; creatorId?: string; handle?: string; name?: string; youtubeUrl?: string }): string[] {
  const aliases = [
    input.leadId ? `lead:${input.leadId}` : "",
    input.submissionId ? `submission:${input.submissionId}` : "",
    input.email ? `email:${normalizeEmail(input.email)}` : "",
    input.creatorId ? `creator:${input.creatorId}` : "",
    input.handle ? `handle:${input.handle.toLowerCase().replace(/^@/, "")}` : "",
    input.youtubeUrl ? `youtube:${input.youtubeUrl.toLowerCase()}` : "",
    input.name && !input.email ? `name:${input.name.toLowerCase()}` : "",
  ].filter(Boolean);
  return Array.from(new Set(aliases));
}

// C4 (2026-09-06 Aside 게이트 후속 — 실측: Playwright, submissions/token:<token> 픽스처가 이름
// 자리에 "token:llnwm00fixtureghost1"을 그대로 노출했다). 위 upsert() 호출부 10곳에서 이름 폴백
// 후보에 원본 문서 id를 넣지 않도록 고쳤지만, 사람 표시 이름이 최종 확정되는 곳은 여기
// finalizeAggregate() 단 한 곳이다 — 앞으로 새 소스가 추가되며 같은 실수(id/토큰을 이름 후보에
// 섞는 것)를 반복해도 여기서 걸러진다. aliasesFor()/upsert() 가 쓰는 "prefix:value" 별칭 형태
// (token:, lead:, submission: 등)로 시작하는 값은 사람 이름이 아니라 원본 식별자이므로 절대
// 그대로 내보내지 않는다.
const SYNTHETIC_ALIAS_NAME_PATTERN = /^(?:token|lead|submission|application|conversation|creator|handle|youtube|email|name|row):/i;

function finalizePersonName(name: string): string {
  const trimmed = text(name);
  if (!trimmed || SYNTHETIC_ALIAS_NAME_PATTERN.test(trimmed)) return "이름 없음";
  return trimmed;
}

function blankDraft(programId: string, key: string): Draft {
  return {
    programId,
    key,
    name: "이름 없음",
    email: "",
    handle: "",
    creatorId: "",
    stages: { ...EMPTY_STAGE_FLAGS },
    evidenceRefs: cloneRefs(),
    updatedAtIso: "",
  };
}

function cloneRefs(): Record<ScpProgramFunnelCanonicalStage, string[]> {
  return {
    sent: [],
    sheetLeads: [],
    responded: [],
    passed: [],
    oneLinkSent: [],
    videoSubmitted: [],
    approved: [],
    paid: [],
  };
}

function upsert(
  index: AliasIndex,
  programId: string,
  aliases: string[],
  patch: {
    name?: string;
    email?: string;
    handle?: string;
    creatorId?: string;
    updatedAtIso?: string;
    stages?: Partial<Record<ScpProgramFunnelCanonicalStage, boolean>>;
    evidence?: Partial<Record<ScpProgramFunnelCanonicalStage, string>>;
  },
): void {
  const programAliases = index.aliasToKeyByProgram.get(programId) ?? new Map<string, string>();
  const people = index.peopleByProgram.get(programId) ?? new Map<string, Draft>();
  const key = aliases.map((alias) => programAliases.get(alias)).find(Boolean) ?? aliases[0] ?? `row:${programId}:${people.size}`;
  for (const alias of aliases) programAliases.set(alias, key);
  const draft = people.get(key) ?? blankDraft(programId, key);

  const name = text(patch.name);
  const nameIsEmail = Boolean(normalizeEmail(name));
  const draftNameIsEmail = Boolean(normalizeEmail(draft.name));
  if (name && (draft.name === "이름 없음" || draftNameIsEmail || (!nameIsEmail && name.length > draft.name.length))) draft.name = name;
  if (!draft.email && patch.email) draft.email = normalizeEmail(patch.email);
  if (!draft.handle && patch.handle) draft.handle = text(patch.handle);
  if (!draft.creatorId && patch.creatorId) draft.creatorId = text(patch.creatorId);
  draft.updatedAtIso = latestIso(draft.updatedAtIso, patch.updatedAtIso);

  for (const [stage, enabled] of Object.entries(patch.stages ?? {}) as Array<[ScpProgramFunnelCanonicalStage, boolean]>) {
    if (enabled) draft.stages[stage] = true;
  }
  for (const [stage, ref] of Object.entries(patch.evidence ?? {}) as Array<[ScpProgramFunnelCanonicalStage, string]>) {
    if (ref && !draft.evidenceRefs[stage].includes(ref) && draft.evidenceRefs[stage].length < SAMPLE_LIMIT) draft.evidenceRefs[stage].push(ref);
  }

  people.set(key, draft);
  index.peopleByProgram.set(programId, people);
  index.aliasToKeyByProgram.set(programId, programAliases);
}

function latestIso(left?: unknown, right?: unknown): string {
  const a = text(left);
  const b = text(right);
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) >= Date.parse(a) ? b : a;
}


function qualificationDecisionPassed(decision: SourceRow): boolean {
  const aiRecommendation = record(decision.aiRecommendation);
  return passLike(firstText([decision.finalVerdict, decision.decision, decision.status, decision.result, aiRecommendation.verdict]));
}

function passLike(value: unknown): boolean {
  const status = text(value).toLowerCase();
  return status === "pass" || status === "passed" || status === "approved" || status === "qualified";
}

function oneLinkMailSent(row: SourceRow): boolean {
  const status = firstText([row.status, row.result]).toLowerCase();
  return status === "sent";
}

function coldmailHistorySent(row: SourceRow): boolean {
  const state = firstText([row.deliveryState]).toLowerCase();
  return !state || state === "sent" || state === "delivered" || state === "accepted" || state === "opened" || state === "replied";
}

function coldmailHistoryResponded(row: SourceRow): boolean {
  return row.hasReply === true || Boolean(firstText([row.replyReceivedAtIso, row.repliedAtIso, row.replyAtIso, row.lastReplyAtIso]));
}

function outreachSent(row: SourceRow): boolean {
  const status = firstText([row.status]).toLowerCase();
  return status === "cold_sent" || status === "replied" || status === "reply_re_guided" || status === "followed_up" || status === "form_submitted";
}

function outreachResponded(row: SourceRow): boolean {
  const status = firstText([row.status]).toLowerCase();
  return status === "replied" || status === "reply_re_guided" || status === "form_submitted";
}

function isScpSubmission(row: SourceRow): boolean {
  const programId = firstText([row.programId]);
  if (programId && !isScpLikeProgramId(programId)) return false;
  const source = firstText([row.source]).toLowerCase();
  const contentType = firstText([row.contentType]).toLowerCase();
  return !source || source.includes("scp") || source === "sheet3_bridge" || contentType.includes("scp");
}

function canonicalReviewStatus(value: unknown): string {
  const status = text(value).toLowerCase();
  if (status === "pass" || status === "passed" || status === "approved" || status === "approval") return "approved";
  return status;
}

function submissionPaid(row: SourceRow): boolean {
  const status = firstText([row.paymentStatus, row.payableStatus]).toLowerCase();
  return status === "paid" || row.paid === true || Boolean(firstText([row.paidAt, row.paidAtIso]));
}

/**
 * 대화 한 건의 프로그램 귀속. 귀속 근거가 하나도 없으면 **null** 이다.
 *
 * normalizeProgramId("") 는 레거시 기본값 "scp"(= SCP canonical) 로 접히므로 그냥 넘기면
 * 미귀속 답장이 전부 SCP 로 흘러들어 SCP 반응 수를 부풀린다. 예전에는 읽는 범위 자체가
 * programId·campaignId·콜드메일 이메일로 스코프돼 있어서 이 기본값이 드러나지 않았지만,
 * 읽기를 "답장 있는 대화 전체"로 바꾸면 그대로 사고가 된다.
 */
export function conversationProgramIdForAggregate(sources: readonly unknown[]): string | null {
  const attributed = firstText(sources);
  return attributed ? normalizeProgramId(attributed) : null;
}

export function conversationHasInboundReply(row: SourceRow): boolean {
  if (row.hasCreatorReply === true) return true;
  const inboundAt = firstText([row.lastInboundAtIso]);
  if (inboundAt && Number.isFinite(Date.parse(inboundAt))) return true;
  // canonical 인바운드 마커 집합은 P0 projection 게이트와 동일해야 한다(오라클 fork 방지):
  // creator가 마지막 발신자면 답장 이력이 존재한다.
  if (firstText([row.lastMessageFrom]).toLowerCase() === "creator") return true;
  const messages = Array.isArray(row.messages) ? row.messages : [];
  return messages.some((message) => {
    const item = record(message);
    return firstText([item.from, item.authorRole, item.role]).toLowerCase() === "creator";
  });
}

// W32-C2: 발송(sent) 이후 단계의 신호를 하나라도 가진 사람. 표본 절단에서 이들을 먼저 담는다.
export function hasDownstreamStage(stages: Record<ScpProgramFunnelCanonicalStage, boolean>): boolean {
  return stages.sheetLeads || stages.responded || stages.passed || stages.oneLinkSent
    || stages.videoSubmitted || stages.approved || stages.paid;
}

type FunnelPeopleSampleOrderInput = {
  stages: Record<ScpProgramFunnelCanonicalStage, boolean>;
  updatedAtIso: string;
  name: string;
};

// W32-C2: 표본 절단 순서의 정본. 다운스트림 신호가 있는 사람이 먼저, 그 다음 최근 갱신순.
export function compareFunnelPeopleForSample(left: FunnelPeopleSampleOrderInput, right: FunnelPeopleSampleOrderInput): number {
  const leftRank = hasDownstreamStage(left.stages) ? 0 : 1;
  const rightRank = hasDownstreamStage(right.stages) ? 0 : 1;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return String(right.updatedAtIso).localeCompare(String(left.updatedAtIso)) || left.name.localeCompare(right.name, "ko");
}

function finalizeAggregate(programId: string, peopleMap: Map<string, Draft>, units: SubmissionUnits): ScpProgramFunnelAggregateRow {
  const counts: Record<ScpProgramFunnelCanonicalStage, number> = { sent: 0, sheetLeads: 0, responded: 0, passed: 0, oneLinkSent: 0, videoSubmitted: 0, approved: 0, paid: 0 };
  const evidenceRefs: Record<ScpProgramFunnelCanonicalStage, string[]> = cloneRefs();
  const people = Array.from(peopleMap.values())
    .map((person) => {
      const stages = { ...person.stages, responded: person.stages.responded || person.stages.sheetLeads, passed: person.stages.passed || person.stages.videoSubmitted || person.stages.approved || person.stages.paid };
      for (const stage of Object.keys(counts) as ScpProgramFunnelCanonicalStage[]) {
        if (stages[stage]) counts[stage] += 1;
        for (const ref of person.evidenceRefs[stage]) {
          if (!evidenceRefs[stage].includes(ref) && evidenceRefs[stage].length < SAMPLE_LIMIT) evidenceRefs[stage].push(ref);
        }
      }
      return {
        key: person.key,
        programId,
        name: finalizePersonName(person.name),
        email: person.email,
        emailMasked: maskEmail(person.email),
        handle: person.handle,
        creatorId: person.creatorId,
        stages,
        evidenceRefs: person.evidenceRefs,
        updatedAtIso: person.updatedAtIso,
      };
    })
    // W32-C2: counts 는 위 map 에서 **전체 모수**로 채우는데 people 은 recency 상위
    // PEOPLE_SAMPLE_LIMIT 절단이라, 반응 이후 단계의 사람이 창 밖으로 밀리면 목록이 카운트와
    // 어긋났다(프로드 실측: 반응 13명 중 표본 안에 4명). 절단은 payload 상한이라 유지하되
    // 다운스트림 신호가 있는 사람을 먼저 담아 그 단계들은 목록 = 카운트가 되게 한다. 발송 전용
    // 인원만 recency 로 뒤를 채운다. 상한 값과 counts 계산은 불변 — 숫자를 낮추지 않는다.
    .sort(compareFunnelPeopleForSample)
    .slice(0, PEOPLE_SAMPLE_LIMIT);
  // W45-FIX: 이 두 스테이지만 제출물 단위로 덮어쓴다 — 정본(operationalSnapshot.ts:1393-1410
  // submissionIdentity)과 단위를 맞춘 것이다. 위 W32-C2 의 "counts = people" 원칙에 대한 의도된
  // 예외이며, people[].stages 는 사람 단위 플래그로 남으므로 두 값이 달라도 버그가 아니다.
  counts.videoSubmitted = units.submitted.size;
  counts.approved = units.approved.size;
  return { programId, counts, evidenceRefs, people };
}
