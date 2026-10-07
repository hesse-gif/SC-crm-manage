// Real Firestore-backed ports for the creator Management detail seven-tab surface.
// Every tab reads existing canonical writer collections only; dead/speculative collections are not queried.
import { adminDb } from "./firebaseAdmin";
import type { CallableAuthContext, ManagementTabEnvelopesPort, ScopedTabListPort } from "./managementProfileTabsCallables";
import { lazyConversationMailAccessScope } from "./conversationMailAccessScope";
import { canReadScpConversationRowForOrg, isExplicitScpMailAccountRow } from "./mailConversationAuthorization";
import {
  DEFAULT_PAGE_SIZE,
  filterRecordsByScope,
  MANAGEMENT_CREATOR_IDENTITY_MATCH,
  MANAGEMENT_TAB_KEYS,
  MANAGEMENT_TAB_REQUIRED_INDEXES,
  type ManagementCreatorIdentityMatchedBy,
  type ManagementTabKey,
  type ManagementTabLoaders,
  type ScopedRecord,
  type UnderlyingQueryScope,
} from "./managementProfileTabsReadModels";
import {
  APPLICATION_MANAGEMENT_IDENTITY_FALLBACK_FIELDS,
  findApplicationManagementRecordsByIdentityFallback,
  type ApplicationManagementIdentityLookupCursor,
} from "./applicationManagementStore";
import { activationEventMatchesLineage, partnerActivationId } from "./partnerActivationCore";
import { extractYouTubeVideoIdFromSubmissionUrl } from "./scpApprovedFeed";
import { resolveApprovedVideoTitle } from "./videoTitleProjection";
import {
  contentSubmittedEvidence,
  onboardingSentEvidence,
  videoReviewedEvidence,
} from "./enrollmentJourneyEvidence";

type FirestoreDb = Pick<FirebaseFirestore.Firestore, "collection">;
export type ManagementTabRow = ScopedRecord & Record<string, unknown>;
type QueryPage = { cursor: string | null; limit: number };
type QueryLike = FirebaseFirestore.Query;
type Equality = [string, string | undefined];

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const APPLICATION_CURSOR_PREFIX = "application-management:v1:";
// Option B for campaign/enrollment scoping: production held 18 management rows at review time, so avoid
// six more composite-index variants and continue bounded identity pages in-memory. The hard ceiling keeps
// a nearly-empty scope from turning into an unbounded scan if that operational assumption later drifts.
const MAX_APPLICATION_SCOPE_ROWS_SCANNED = 500;

function encodeApplicationCursor(cursor: ApplicationManagementIdentityLookupCursor): string {
  return `${APPLICATION_CURSOR_PREFIX}${Buffer.from(JSON.stringify([
    cursor.matchedBy,
    cursor.submittedAtIso,
    cursor.applicationId,
  ]), "utf8").toString("base64url")}`;
}

function decodeApplicationCursor(cursor: string): ApplicationManagementIdentityLookupCursor | null {
  if (!cursor.startsWith(APPLICATION_CURSOR_PREFIX)) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor.slice(APPLICATION_CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 3) return null;
    const [matchedBy, submittedAtIso, applicationId] = decoded;
    if (
      typeof matchedBy !== "string"
      || !APPLICATION_MANAGEMENT_IDENTITY_FALLBACK_FIELDS.includes(
        matchedBy as (typeof APPLICATION_MANAGEMENT_IDENTITY_FALLBACK_FIELDS)[number],
      )
      || typeof submittedAtIso !== "string"
      || !submittedAtIso
      || typeof applicationId !== "string"
      || !applicationId
    ) {
      return null;
    }
    return {
      matchedBy: matchedBy as ApplicationManagementIdentityLookupCursor["matchedBy"],
      submittedAtIso,
      applicationId,
    };
  } catch {
    return null;
  }
}
const numberValue = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function docData(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  return { id: doc.id, ...(doc.data() as Record<string, unknown>) };
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function optionalScopeMatches(expected: string | undefined, actual: string): boolean {
  return expected === undefined || actual === expected;
}

function activationMatchesScope(
  activation: Record<string, unknown> | null,
  scope: UnderlyingQueryScope,
): activation is Record<string, unknown> {
  if (!activation || !scope.enrollmentId) return false;
  const identity = objectField(activation, "identity");
  return text(identity.fluCreatorId) === scope.fluCreatorId
    && text(identity.programId) === scope.programId
    && text(identity.enrollmentId) === scope.enrollmentId
    && optionalScopeMatches(scope.campaignId, text(identity.campaignId));
}

async function readDocument(
  db: FirestoreDb,
  collection: string,
  id: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  const snap = await db.collection(collection).doc(id).get();
  return snap.exists ? { id: snap.id, ...(snap.data() as Record<string, unknown>) } : null;
}

async function readScopedActivation(
  db: FirestoreDb,
  scope: UnderlyingQueryScope,
): Promise<Record<string, unknown> | null> {
  const activation = await readDocument(
    db,
    "scp_partner_activations",
    scope.enrollmentId ? partnerActivationId(scope.enrollmentId) : undefined,
  );
  return activationMatchesScope(activation, scope) ? activation : null;
}

async function readScopedCurrentReview(
  db: FirestoreDb,
  scope: UnderlyingQueryScope,
): Promise<{ activation: Record<string, unknown>; review: Record<string, unknown> } | null> {
  const activation = await readScopedActivation(db, scope);
  if (!activation) return null;
  const evidence = objectField(activation, "evidence");
  const submissionId = text(evidence.submissionId);
  const review = await readDocument(db, "scp_video_review_state", submissionId);
  if (!review) return null;
  const identity = objectField(activation, "identity");
  const subject = objectField(review, "subject");
  const evidenceRevision = numberValue(evidence.videoRevision, -1);
  const reviewRevision = numberValue(review.revision ?? subject.videoRevision, -2);
  const exactScope = text(review.id) === submissionId
    && text(subject.videoSubmissionId) === submissionId
    && text(subject.applicationId) === text(identity.applicationId)
    && text(subject.fluCreatorId) === text(identity.fluCreatorId)
    && text(subject.programId) === text(identity.programId)
    && text(subject.campaignId) === text(identity.campaignId)
    && text(subject.enrollmentId) === text(identity.enrollmentId)
    && optionalScopeMatches(scope.campaignId, text(subject.campaignId));
  return exactScope && evidenceRevision === reviewRevision ? { activation, review } : null;
}

function onboardingOutboxDocumentId(applicationId: string, sendGeneration: number): string {
  const normalized = applicationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160);
  return normalized ? `${normalized}__${Math.max(0, Math.trunc(sendGeneration))}` : "";
}

async function boundedQuery(
  db: FirestoreDb,
  collection: string,
  equalities: readonly Equality[],
  orderField: string,
  page: QueryPage,
): Promise<Record<string, unknown>[]> {
  for (const [, value] of equalities) {
    if (!value) return [];
  }
  let query: QueryLike = db.collection(collection);
  for (const [field, value] of equalities) query = query.where(field, "==", value);
  query = query.orderBy(orderField, "desc");
  if (page.cursor) query = query.startAfter(page.cursor);
  query = query.limit(page.limit);
  const snap = await query.get();
  return snap.docs.map(docData);
}

function sortBound(rows: ManagementTabRow[], page: QueryPage): ManagementTabRow[] {
  return rows
    .sort((a, b) =>
      text(b._sortAt ?? b.occurredAt ?? b.updatedAtIso ?? b.submittedAt ?? b.sentAt ?? b.id)
        .localeCompare(text(a._sortAt ?? a.occurredAt ?? a.updatedAtIso ?? a.submittedAt ?? a.sentAt ?? a.id)),
    )
    .slice(0, page.limit);
}

function flattenApplication(row: Record<string, unknown>): ManagementTabRow {
  const identity = objectField(row, "identity");
  return {
    ...row,
    applicationId: text(row.applicationId) || text(row.id),
    fluCreatorId: text(identity.fluCreatorId) || text(row.fluCreatorId),
    portalCreatorId: text(row.portalCreatorId) || text(identity.portalCreatorId) || undefined,
    channelId: text(row.channelId) || text(identity.channelId) || undefined,
    outreachId: text(row.outreachId) || text(identity.outreachId) || undefined,
    programId: text(row.programId) || text(identity.programId),
    campaignId: text(row.campaignId) || text(identity.campaignId) || undefined,
    enrollmentId: text(row.enrollmentId) || text(identity.enrollmentId) || undefined,
  } as ManagementTabRow;
}

function scopedCampaignEqualities(scope: UnderlyingQueryScope): Equality[] {
  const equalities: Equality[] = [["programId", scope.programId]];
  if (scope.campaignId) equalities.push(["campaignId", scope.campaignId]);
  return equalities;
}

function maskEmail(email: unknown): string {
  const value = text(email);
  const at = value.indexOf("@");
  if (at <= 0) return "";
  const tld = value.slice(at + 1).split(".").filter(Boolean).at(-1);
  return `${value[0]}***@***${tld ? `.${tld}` : ""}`;
}

function outreach(row: Record<string, unknown>): ManagementTabRow {
  const sentAt = text(row.sentAtIso) || text(row.sentAt) || text(row.createdAtIso);
  return {
    id: text(row.id),
    fluCreatorId: text(row.fluCreatorId),
    programId: text(row.programId),
    campaignId: text(row.campaignId) || undefined,
    campaignName: text(row.campaign) || undefined,
    sentAt,
    subject: text(row.subject) || undefined,
    bodyPreview: text(row.bodyPreview) || undefined,
    deliveryState: text(row.deliveryState) || undefined,
    openCount: typeof row.openCount === "number" ? row.openCount : undefined,
    replied: Boolean(row.hasReply ?? row.replied),
    conversationHref: text(row.conversationId) ? `/chat?conversationId=${encodeURIComponent(text(row.conversationId))}` : undefined,
    emailMasked: text(row.emailMasked) || maskEmail(row.email),
    _cursor: sentAt || text(row.id),
    _sortAt: sentAt,
  };
}

function application(
  row: Record<string, unknown>,
  matchedBy?: ManagementCreatorIdentityMatchedBy,
): ManagementTabRow {
  const flat = flattenApplication(row);
  const submittedAt = text(row.submittedAtIso) || text(row.submittedAt) || text(row.createdAtIso) || new Date(0).toISOString();
  const classification = text(row.classification);
  const applicationId = text(flat.applicationId);
  const cursor = matchedBy && matchedBy !== "applicationId"
    ? encodeApplicationCursor({ matchedBy, submittedAtIso: submittedAt, applicationId })
    : submittedAt;
  return {
    id: applicationId,
    applicationId,
    // Preserve the row's authoritative owner. A compatibility token may only pass the outer scope gate
    // through the exact resolver axis recorded in the non-serializing proof below.
    fluCreatorId: flat.fluCreatorId,
    portalCreatorId: text(flat.portalCreatorId) || undefined,
    enrollmentId: flat.enrollmentId,
    programId: flat.programId,
    campaignId: flat.campaignId,
    outreachId: text(flat.outreachId) || undefined,
    settlementCreatorCode: undefined,
    channelId: text(flat.channelId) || undefined,
    submittedAt,
    declaredPrimaryAudienceCountry: text(row.declaredPrimaryAudienceCountry) || undefined,
    attributionState:
      classification === "managed" ? "managed" :
      classification === "ambiguous" ? "ambiguous" :
      classification === "conflict" ? "conflict" : "unclassified",
    latestRevision: Math.max(0, Math.trunc(numberValue(row.revision ?? row.sourceRevision, 0))),
    revokedAt: text(row.revokedAtIso) || undefined,
    _cursor: cursor,
    _sortAt: submittedAt,
    ...(matchedBy ? { [MANAGEMENT_CREATOR_IDENTITY_MATCH]: { matchedBy } } : {}),
  };
}

async function fetchActivationScopedApplications(
  db: FirestoreDb,
  scope: UnderlyingQueryScope,
  page: QueryPage,
): Promise<ManagementTabRow[]> {
  if (!scope.enrollmentId || page.cursor) return [];
  const activation = await readScopedActivation(db, scope);
  const identity = objectField(activation ?? {}, "identity");
  const source = await readDocument(db, "scp_application_management", text(identity.applicationId));
  if (!source) return [];
  const row = application(source);
  return text(row.applicationId) === text(identity.applicationId)
      && text(row.fluCreatorId) === text(identity.fluCreatorId)
      && text(row.programId) === text(identity.programId)
      && text(row.campaignId) === text(identity.campaignId)
      && text(row.enrollmentId) === text(identity.enrollmentId)
    ? [row].slice(0, page.limit)
    : [];
}

async function fetchApplications(
  db: FirestoreDb,
  scope: UnderlyingQueryScope,
  page: QueryPage,
): Promise<ManagementTabRow[]> {
  const cursor = page.cursor ? decodeApplicationCursor(page.cursor) : null;
  if (page.cursor && !cursor) return [];

  const collected: ManagementTabRow[] = [];
  let scanCursor = cursor;
  let scanned = 0;
  while (collected.length < page.limit && scanned < MAX_APPLICATION_SCOPE_ROWS_SCANNED) {
    const queryLimit = Math.min(page.limit, MAX_APPLICATION_SCOPE_ROWS_SCANNED - scanned);
    const match = await findApplicationManagementRecordsByIdentityFallback(scope.fluCreatorId, {
      db,
      limit: queryLimit,
      // Direct applicationId compatibility was intentionally removed: only a proven creator identity axis
      // may authorize this deployed read surface.
      includeApplicationId: false,
      programId: scope.programId,
      cursor: scanCursor,
    });
    if (!match || match.matchedBy === "applicationId") break;

    scanned += match.records.length;
    for (const record of match.records) {
      const row = application({
        ...record.data,
        // Document id wins over any stale duplicated applicationId field.
        id: record.applicationId,
        applicationId: record.applicationId,
      }, match.matchedBy);
      if (
        optionalScopeMatches(scope.campaignId, text(row.campaignId))
        && optionalScopeMatches(scope.enrollmentId, text(row.enrollmentId))
      ) {
        collected.push(row);
        if (collected.length >= page.limit) break;
      }
    }

    const last = match.records.at(-1);
    if (!last || match.records.length < queryLimit) break;
    const nextCursor: ApplicationManagementIdentityLookupCursor = {
      matchedBy: match.matchedBy,
      submittedAtIso: text(last.data.submittedAtIso),
      applicationId: last.applicationId,
    };
    if (
      !nextCursor.submittedAtIso
      || (scanCursor
        && scanCursor.matchedBy === nextCursor.matchedBy
        && scanCursor.submittedAtIso === nextCursor.submittedAtIso
        && scanCursor.applicationId === nextCursor.applicationId)
    ) {
      break;
    }
    scanCursor = nextCursor;
  }
  return collected;
}

function journeyEvent(input: ManagementTabRow, stage: string, occurredAt: string, source: string): ManagementTabRow {
  return {
    id: `${source}:${input.id}`,
    eventId: `${source}:${input.id}`,
    fluCreatorId: text(input.fluCreatorId),
    programId: text(input.programId),
    campaignId: text(input.campaignId) || undefined,
    enrollmentId: text(input.enrollmentId) || undefined,
    stage,
    occurredAt,
    source,
    sourceRef: source,
    actor: stage === "replied"
      ? "creator"
      : source === "scp_application_management"
        ? "portal"
        : source === "scp_partner_activations" ? "flu_automation" : "operator",
    confidence: "verified",
    payloadSummary: {},
    _cursor: occurredAt,
    _sortAt: occurredAt,
  };
}

// 캠페인 아웃리치로 만들어진 크리에이터는 SCP 원장 세 곳(scp_coldmail_history /
// scp_application_management / scp_partner_activations)에 아무 행이 없다. 실제 진행은
// `conversations/<creatorId>` 와 그 messages 서브컬렉션에 있다(운영 실측 2026-07-27:
// rkreddy 는 세 원장 모두 0건, 대화에는 아웃바운드 1 + 인바운드 2).
//
// 여기서는 **아웃바운드 발송만** coldmail_sent 이벤트로 붙인다. 인바운드 답장에 대응하는
// JourneyStage 가 없고, 없는 stage 를 지어내거나 다른 stage 에 욱여넣지 않는다(스펙 어휘 불변).
// 답장 수신 사실은 상세 상태 카드가 이미 보여준다.
const CONVERSATION_OUTBOUND_SCAN_LIMIT = 10;

// 2026-09-10 적대 리뷰 LOW-11: 이 포트는 functions/read.ts 의 canReadConversationForAuth
// (조직 스코프 대화 읽기 게이트, 계정 엔타이틀먼트 포함)를 거치지 않는다 — 이유는 두 가지다.
// ① 이 함수가 읽어서 반환하는 두 필드(occurredAt·repliedAt)는 대화의 타임스탬프일 뿐, 메시지
//    본문·제목·발신자 같은 콘텐츠가 전혀 아니다.
// ② 이 포트를 호출하는 createScopedTabListHandler(managementProfileTabsCallables.ts)가 이미
//    assertRoleAtLeast로 프로필 열람 권한을 검증한 뒤에만 내려온다.
// 2026-09-27 codex 적대 리뷰 round 2: 위 근거는 "다른 조직의 대화"까지는 막지 못한다 — T056
// 권한자가 T046의 scp 대화 conversationId를 알면(program/campaign 탭 등에서 유추 가능) 그
// 발송/답장 시각을 그대로 받아갈 수 있었다. functions/mailConversationAuthorization.ts의 scp
// 게이트(canReadScpConversationRowForOrg)만 추가한다 — mailAccountId:"scp"로 명시 스탬프된
// 행에만 작동하는 no-op 게이트이므로, PR#216의 더 넓은 메일함 엔타이틀먼트 체크(이 포트가
// 원래 갖지 않던 것)까지 새로 들여오지 않는다. auth는 ScopedTabListPort.fetchPage /
// ManagementTabEnvelopesPort.buildLoaders 를 통해 스레딩된다(managementProfileTabsCallables.ts).
// 2026-09-28 owner scope decision (codex round 2 finding #1): 명시 scp 행은 org 일치뿐 아니라
// scp 그랜트 보유(hasScpEntitlement)도 함께 요구한다 — org 일치만으로는 scp 미부여 조직원도
// 자기 조직의 scp journey 이벤트를 볼 수 있었다.
async function fetchConversationOutreach(
  db: FirestoreDb,
  scope: UnderlyingQueryScope,
  // A caller predating this fix (or a direct/legacy invocation) that omits auth entirely is
  // treated as the least-privileged, org-unresolved caller — fail-closed for an explicit-scp row,
  // pass-through (unaffected) for every other row, same as any other unresolved-org caller.
  auth: CallableAuthContext = { uid: null, role: null, email: null },
): Promise<{
  occurredAt: string;
  repliedAt: string;
  conversationId: string;
  campaignId: string;
  programId: string;
} | null> {
  const conversation = await readDocument(db, "conversations", scope.fluCreatorId);
  if (!conversation) return null;
  const conversationRow = { ...conversation, id: text(conversation.id) || scope.fluCreatorId };
  // Flu conversation org-filter round 22 (codex adversarial review round 22, finding #2): this is
  // one of six Promise.all branches fetchJourney (below) runs in parallel — resolving the Peoply
  // scope EAGERLY, and letting a directory outage THROW, failed the entire journey tab (mail
  // history, applications, onboarding, review — everything), even though only an explicit-scp
  // conversation ever needed it. Skip the lookup entirely for a non-explicit-scp/legacy
  // conversation (canReadScpConversationRowForOrg's own first branch already returns true
  // unconditionally for one), and on a lookup failure deny only THIS row rather than throwing —
  // the rest of the journey tab must keep working.
  if (isExplicitScpMailAccountRow(conversationRow)) {
    const resolveLazyConversationAccessScope = lazyConversationMailAccessScope(
      { role: auth.role ?? "guest", email: auth.email ?? undefined, userId: auth.uid ?? undefined },
      (err) => console.warn("[management-profile-tabs] conversation_org_scope_lookup_failed", {
        fluCreatorId: scope.fluCreatorId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    const conversationAccessScope = await resolveLazyConversationAccessScope();
    if (!canReadScpConversationRowForOrg(conversationRow, conversationAccessScope)) return null;
  }
  // 스코프가 지정돼 있으면 그 프로그램/캠페인 대화만 인정한다.
  const conversationProgramId = text(conversation.canonicalProgramId) || text(conversation.programId);
  if (scope.programId && conversationProgramId && conversationProgramId !== scope.programId) return null;
  const conversationCampaignId = text(conversation.campaignId);
  if (scope.campaignId && conversationCampaignId && conversationCampaignId !== scope.campaignId) return null;

  // 발송 시각은 대화 문서에 없다(lastMessageAtIso 는 마지막 메시지 = 보통 답장이다).
  // 첫 아웃바운드 메시지를 서브컬렉션에서 정직하게 읽는다 — 단일 필드 정렬, 상한 있음.
  const snap = await db
    .collection("conversations")
    .doc(text(conversation.id) || scope.fluCreatorId)
    .collection("messages")
    .orderBy("createdAtIso", "asc")
    .limit(CONVERSATION_OUTBOUND_SCAN_LIMIT)
    .get()
    .catch(() => null);
  const outbound = (snap?.docs ?? [])
    .map((doc) => doc.data() as Record<string, unknown>)
    .find((message) => {
      const from = text(message.from) || text(message.fromRole);
      return from === "ai" || from === "human" || from === "operator";
    });
  const occurredAt = text(outbound?.createdAtIso)
    || text(outbound?.sentAtIso)
    || text(conversation.lastMessageAtIso);
  // 답장 시각은 대화가 기록한 lastInboundAtIso 만 쓴다 — 없으면 추측하지 않고 이벤트를 만들지 않는다.
  const repliedAt = conversation.hasCreatorReply === true ? text(conversation.lastInboundAtIso) : "";
  if (!occurredAt && !repliedAt) return null;
  return {
    occurredAt,
    repliedAt,
    conversationId: text(conversation.id) || scope.fluCreatorId,
    campaignId: conversationCampaignId,
    programId: conversationProgramId,
  };
}

async function fetchJourney(
  db: FirestoreDb,
  scope: UnderlyingQueryScope,
  page: QueryPage,
  auth: CallableAuthContext = { uid: null, role: null, email: null },
): Promise<ManagementTabRow[]> {
  const activation = await readScopedActivation(db, scope);
  // U7 P4: `onboarding_sent` / `content_submitted` / `video_reviewed` 는 어휘로 선언만 돼 있고 한 건도
  // 발행되지 않았다(관리 6 vs 파트너 2 의 원인). 이 탭의 **기존 읽기 경로**(온보딩 탭·검수 탭이 이미
  // 쓰는 fetchOnboarding/readScopedCurrentReview)를 재사용하고, 근거 판정은 공용 모듈
  // `enrollmentJourneyEvidence` 한 벌로만 한다(새 컬렉션·새 쿼리 없음, 어휘 확장 없음).
  const [mailRows, appRows, activationRows, conversationOutreach, onboardingRows, currentReview] = await Promise.all([
    boundedQuery(db, "scp_coldmail_history", scopedCampaignEqualities(scope), "sentAtIso", page)
      .then((rows) => rows.map(outreach).filter((row) => row.fluCreatorId === scope.fluCreatorId)),
    fetchActivationScopedApplications(db, scope, page),
    Promise.resolve(activation
      ? [{ ...flattenApplication(activation), activatedAtIso: text(activation.activatedAtIso), status: text(activation.status), id: text(activation.id) }]
        .filter((row) => row.fluCreatorId === scope.fluCreatorId && row.programId === scope.programId)
      : []),
    fetchConversationOutreach(db, scope, auth),
    fetchOnboarding(db, scope, { cursor: null, limit: Math.min(page.limit, 20) }),
    readScopedCurrentReview(db, scope),
  ]);
  const journeyAnchor = (appRows[0] ?? activationRows[0] ?? null) as ManagementTabRow | null;
  const onboardingEvidence = onboardingSentEvidence(onboardingRows as Record<string, unknown>[]);
  const submittedEvidence = contentSubmittedEvidence(currentReview?.review ?? null);
  const reviewedEvidence = videoReviewedEvidence(currentReview?.review ?? null);
  const evidenceRows = journeyAnchor
    ? [
      ...(onboardingEvidence ? [journeyEvent(journeyAnchor, "onboarding_sent", onboardingEvidence.occurredAtIso, onboardingEvidence.sourceRef)] : []),
      ...(submittedEvidence ? [journeyEvent(journeyAnchor, "content_submitted", submittedEvidence.occurredAtIso, submittedEvidence.sourceRef)] : []),
      ...(reviewedEvidence ? [journeyEvent(journeyAnchor, "video_reviewed", reviewedEvidence.occurredAtIso, reviewedEvidence.sourceRef)] : []),
    ]
    : [];
  const conversationRow = conversationOutreach
    ? {
      id: conversationOutreach.conversationId,
      fluCreatorId: scope.fluCreatorId,
      programId: conversationOutreach.programId || text(scope.programId),
      campaignId: conversationOutreach.campaignId || text(scope.campaignId),
      enrollmentId: text(scope.enrollmentId),
    } as ManagementTabRow
    : null;
  // 콜드메일 원장에 이미 행이 있으면 발송은 중복 근거다 — 원장이 정본이므로 그때는 붙이지 않는다.
  const conversationRows = conversationRow && conversationOutreach
    ? [
      ...(mailRows.length === 0 && conversationOutreach.occurredAt
        ? [journeyEvent(conversationRow, "coldmail_sent", conversationOutreach.occurredAt, "conversations")]
        : []),
      // 답장은 원장에 시각이 없다(hasReply 플래그뿐). 대화가 기록한 실제 수신 시각으로만 붙인다.
      ...(conversationOutreach.repliedAt
        ? [journeyEvent(conversationRow, "replied", conversationOutreach.repliedAt, "conversations")]
        : []),
    ]
    : [];
  return sortBound([
    ...mailRows.map((row) => journeyEvent(row, "coldmail_sent", text(row.sentAt), "scp_coldmail_history")),
    ...conversationRows,
    ...appRows.map((row) => journeyEvent(row, row.attributionState === "managed" ? "qualified" : "applied", text(row.submittedAt), "scp_application_management")),
    ...activationRows.map((row) => journeyEvent(row, "partner_active", text(row.activatedAtIso), "scp_partner_activations")),
    ...evidenceRows,
  ].filter((row) => text(row.occurredAt)), page);
}

async function fetchOnboarding(db: FirestoreDb, scope: UnderlyingQueryScope, page: QueryPage): Promise<ManagementTabRow[]> {
  const apps = await fetchActivationScopedApplications(db, scope, { cursor: null, limit: Math.min(page.limit, 20) });
  const pages = await Promise.all(apps.map((app) =>
    Promise.all(
      Array.from({ length: 5 }, (_, generation) =>
        readDocument(
          db,
          "scp_onboarding_outbox",
          onboardingOutboxDocumentId(text(app.applicationId), generation),
        ),
      ),
    ).then((rows) => rows.filter((row): row is Record<string, unknown> => row !== null)),
  ));
  return sortBound(pages.flat().map((row) => {
    const updatedAt = text(row.sentAtIso) || text(row.updatedAtIso) || text(row.createdAtIso);
    return {
      id: text(row.id),
      fluCreatorId: scope.fluCreatorId,
      programId: scope.programId,
      campaignId: scope.campaignId,
      enrollmentId: scope.enrollmentId,
      stepLabel: "온보딩 메일",
      status: text(row.state) || "queued",
      requestedAt: text(row.createdAtIso) || updatedAt,
      completedAt: text(row.sentAtIso) || undefined,
      receiptRef: text(row.providerMessageIdHash) ? "provider-receipt-hash" : undefined,
      retryState: text(row.lastFailureReason) || undefined,
      _cursor: updatedAt,
      _sortAt: updatedAt,
    };
  }), page);
}

async function fetchContentReview(db: FirestoreDb, scope: UnderlyingQueryScope, page: QueryPage): Promise<ManagementTabRow[]> {
  if (page.cursor) return [];
  const bundle = await readScopedCurrentReview(db, scope);
  const rows = bundle ? [bundle.review] : [];
  return rows.map((row) => {
    const subject = objectField(row, "subject");
    const updatedAt = text(row.updatedAtIso) || text(row.submittedAtIso) || text(row.createdAtIso);
    return {
      id: text(row.id),
      submissionId: text(subject.videoSubmissionId) || text(row.submissionId) || text(row.id),
      revisionId: text(row.id),
      revision: Math.max(0, Math.trunc(numberValue(row.revision ?? subject.videoRevision, 0))),
      // U7 P1: 같은 공용 헬퍼로 마지막까지 해석한 뒤에만 "unavailable" 로 떨어뜨린다.
      canonicalVideoId: text(row.youtubeVideoId)
        || text(subject.youtubeVideoId)
        || extractYouTubeVideoIdFromSubmissionUrl(row.youtubeUrl)
        || text(row.videoId)
        || "unavailable",
      canonicalUrl: text(row.youtubeUrl) || "#",
      fingerprint: text(row.contentFingerprint) || text(subject.contentFingerprint) || "redacted",
      submittedAt: updatedAt,
      isCurrentRevision: true,
      reviewState: text(row.state) || "queued",
      reasonCode: text(row.reviewReasonCode) || undefined,
      policyVersion: text(row.policyConfigHash) || text(subject.policyVersion) || undefined,
      reviewedAt: text(row.reviewedAtIso) || text(row.approvedAtIso) || undefined,
      analyzerStatus: text(row.analyzerStatus) || "complete",
      fluCreatorId: text(subject.fluCreatorId),
      programId: text(subject.programId),
      campaignId: text(subject.campaignId) || undefined,
      enrollmentId: text(subject.enrollmentId) || undefined,
      _cursor: updatedAt,
      _sortAt: updatedAt,
    };
  });
}

async function fetchChannel(db: FirestoreDb, scope: UnderlyingQueryScope, page: QueryPage): Promise<ManagementTabRow[]> {
  if (page.cursor) return [];
  const bundle = await readScopedCurrentReview(db, scope);
  if (!bundle) return [];
  const subject = objectField(bundle.review, "subject");
  const youtubeVideoId = text(bundle.review.youtubeVideoId)
    || text(subject.youtubeVideoId)
    || extractYouTubeVideoIdFromSubmissionUrl(
      text(bundle.review.youtubeUrl) || text(bundle.review.canonicalUrl) || text(bundle.review.videoUrl),
    )
    || "";
  const video = await readDocument(db, "videos", youtubeVideoId);
  const rows = video ? [video] : [];
  return rows.slice(0, page.limit).map((row) => ({
    id: text(row.id) || text(row.videoId),
    fluCreatorId: text(subject.fluCreatorId),
    programId: text(subject.programId),
    campaignId: text(subject.campaignId) || undefined,
    enrollmentId: text(subject.enrollmentId) || undefined,
    kind: "video",
    // U7 P2: 채널 탭 제목도 공용 래퍼로. 사내 라벨(등록 시점 값)은 실제 제목으로 승격하지 않으므로
    // 스냅샷 확인분이 없으면 "(제목 없음)" 으로 정직하게 남는다 — 라벨을 제목처럼 박지 않는다.
    title: resolveApprovedVideoTitle(row, row.title).title ?? "(제목 없음)",
    occurredAt: text(row.publishedIso) || text(row.publishedAtIso) || text(row.published) || text(row.updatedAtIso),
    viewCount: numberValue(row.views ?? row.viewCount, 0),
    href: text(row.youtubeUrl) || (text(row.videoId) ? `https://www.youtube.com/watch?v=${encodeURIComponent(text(row.videoId))}` : undefined),
    _cursor: text(row.id),
    _sortAt: text(row.publishedIso) || text(row.publishedAtIso) || text(row.published) || text(row.id),
  }));
}

async function fetchAudit(db: FirestoreDb, scope: UnderlyingQueryScope, page: QueryPage): Promise<ManagementTabRow[]> {
  if (!scope.enrollmentId) return [];
  const activation = await readScopedActivation(db, scope);
  if (!activation) return [];
  const identity = objectField(activation, "identity");
  const rows = await boundedQuery(db, "scp_partner_activation_events", [["enrollmentId", scope.enrollmentId]], "atIso", page);
  // U7 P3: 계보 판정 공용화. 다섯 필드 전량 strict equality 는 레거시 이벤트(캠페인·applicationId 가
  // 비어 있는 행)를 전멸시켰다(실측: 감사 1 vs 0). 공용 판정은 **양쪽에 값이 있는 필드만** 비교한다.
  return rows.filter((row) =>
    activationEventMatchesLineage(row, identity)
    && optionalScopeMatches(scope.campaignId, text(row.campaignId)),
  ).map((row) => ({
    id: text(row.eventId) || text(row.id),
    fluCreatorId: scope.fluCreatorId,
    programId: text(row.programId),
    campaignId: text(row.campaignId) || undefined,
    enrollmentId: text(row.enrollmentId) || undefined,
    occurredAt: text(row.atIso) || text(row.occurredAtIso),
    eventType: text(row.eventType) || "partner.activation",
    actor: "system",
    scope: "Partner 활성화 증적",
    result: text(row.result) || text(row.toStatus) || "success",
    sourceRef: "scp_partner_activation_events",
    _cursor: text(row.atIso) || text(row.id),
    _sortAt: text(row.atIso) || text(row.id),
  }));
}

export function createFirestoreScopedTabListPort(tab: ManagementTabKey, db: FirestoreDb = adminDb): ScopedTabListPort<ManagementTabRow> {
  return {
    async fetchPage(scope, page, auth) {
      switch (tab) {
        case "journey": return fetchJourney(db, scope, page, auth);
        case "outreach": return boundedQuery(db, "scp_coldmail_history", scopedCampaignEqualities(scope), "sentAtIso", page)
          .then((rows) => rows.map(outreach).filter((row) => row.fluCreatorId === scope.fluCreatorId));
        case "applications": return fetchApplications(db, scope, page);
        case "onboarding": return fetchOnboarding(db, scope, page);
        case "content-review": return fetchContentReview(db, scope, page);
        case "channel-intelligence": return fetchChannel(db, scope, page);
        case "audit": return fetchAudit(db, scope, page);
      }
    },
    cursorOf(row) { return text(row._cursor) || text(row.id); },
  };
}

export function createFirestoreManagementTabEnvelopesPort(db: FirestoreDb = adminDb): ManagementTabEnvelopesPort {
  return {
    buildLoaders(scope, auth): ManagementTabLoaders {
      const loaders: ManagementTabLoaders = {};
      for (const tab of MANAGEMENT_TAB_KEYS) {
        const port = createFirestoreScopedTabListPort(tab, db);
        loaders[tab] = async () => ({ rows: filterRecordsByScope(scope, await port.fetchPage(scope, { cursor: null, limit: DEFAULT_PAGE_SIZE }, auth)) });
      }
      return loaders;
    },
  };
}

export { MANAGEMENT_TAB_REQUIRED_INDEXES };
