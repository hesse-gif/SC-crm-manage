// Real Firestore-backed ports for the Partner detail 5-tab surface
// (.specs/spec_partner_profile_tabs/spec.md) — wires ./partnerProfileTabsCallables.ts's injected
// `ActivePartnersPort`/`ResolvePartnerRouteAliasPort`/`PartnerTabEnvelopesPort` contracts to bounded,
// index-backed Firestore reads. This is the ONLY file in this lane allowed to touch Firestore directly
// for these tabs (mirrors functions/managementProfileTabsPorts.ts's role for the Management seven-tab
// surface — same bounded-by-construction discipline: every list query below is built from exactly one
// declared composite-index signature, `.limit(n)` always applied, never an unbounded scan).
//
// DECISION (documented, not silently papered over): `functions/partnerProfileTabsReadModels.ts`'s
// `PARTNER_REQUIRED_INDEXES` comment block declares `collectionGroup: "partner_activations"` /
// `"partner_activation_events"` with field names `activatedAtIso`/`occurredAtIso`/`submittedAtIso`. The
// ACTUAL activation store (`./partnerActivationStore.ts`, already wired same-transaction with review
// decisions per the I1 integration commit) writes to `scp_partner_activations` /
// `scp_partner_activation_events` — the collection names the read-model comment used are speculative and
// were never the real write target. Querying the documented-but-nonexistent collection names would make
// `getActivePartners`/the audit tab permanently return empty pages against real data, which is a
// correctness bug, not a faithful port. This file queries the REAL collections
// (`SCP_PARTNER_ACTIVATIONS_COLLECTION`/`SCP_PARTNER_ACTIVATION_EVENTS_COLLECTION` from
// `./partnerActivationStore.ts`) using the REAL field names those writers actually persist
// (`status`/`activatedAtIso` on activations — these DO match the read-model comment; `atIso`, not
// `occurredAtIso`, on activation events — see `PartnerActivationEvent` in `./partnerActivationCore.ts`).
// The read-model lane owner should reconcile `PARTNER_REQUIRED_INDEXES`'s text in a follow-up; this file
// does not edit that file (out of this lane's ownership) but stays functionally correct against the real
// store.
//
// Journey/videos are projections over existing canonical activation/application/review/submission
// collections. There is no separate Partner journey/video ledger here; when the activation cannot be
// attributed to an approved current submission, these ports return reason-coded empty payloads rather
// than fabricating data or querying dead collections.
import { adminDb } from "./firebaseAdmin";
import {
  creatorProfileImageSourceInputs,
  resolveCreatorDisplayIdentity,
  resolveProfileImageProjection,
} from "./managementProfileTabsReadModels";
import type {
  ActivePartnersPort,
  PartnerTabEnvelopesPort,
  ResolvePartnerRouteAliasPort,
} from "./partnerProfileTabsCallables";
import {
  DEFAULT_PAGE_SIZE,
  PartnerReadModelError,
  PARTNER_TAB_KEYS,
  matchesPartnerListScope,
  type BuildPartnerListRowInput,
  type PartnerListQueryScope,
  type PartnerScopeRequest,
  type PartnerTabKey,
  type PartnerTabLoaders,
  type PartnerAuditEvent,
  type PartnerJourneyData,
  type PartnerJourneyEvent,
  type PartnerJourneyStage,
  type PartnerJourneyStageStatus,
  type PartnerVideo,
  type PartnerVideoRevision,
  assertNoDuplicateVideoSubmissionRows,
} from "./partnerProfileTabsReadModels";
import { activationEventMatchesLineage, partnerActivationId, type PartnerActivationDocument } from "./partnerActivationCore";
import { isOperationalFixtureRecord } from "./operationalFixtureProvenance";
import { resolveApprovedVideoTitle } from "./videoTitleProjection";
import { extractYouTubeVideoIdFromSubmissionUrl } from "./scpApprovedFeed";
import {
  SCP_PARTNER_ACTIVATIONS_COLLECTION,
  SCP_PARTNER_ACTIVATION_EVENTS_COLLECTION,
  parsePartnerActivationDocument,
} from "./partnerActivationStore";
import { contentSubmittedEvidence, onboardingSentEvidence } from "./enrollmentJourneyEvidence";
import { loadCampaignDisplayNames, loadPartnerProgramDisplayNames, partnerProgramDisplayName } from "./provenanceDisplay";

type FirestoreDb = Pick<FirebaseFirestore.Firestore, "collection">;

// Best-effort creator identity/profile-image projection source. No canonical schema is confirmed for
// this collection's display fields ([확인 필요]-adjacent — never fabricated, always falls back to the
// bare fluCreatorId/initials precedence chain already owned by resolveProfileImageProjection).
const CREATORS_COLLECTION = "creators";
const APPLICATION_MANAGEMENT_COLLECTION = "scp_application_management";
const VIDEO_REVIEW_STATE_COLLECTION = "scp_video_review_state";
const PORTAL_VIDEO_SUBMISSIONS_COLLECTION = "scp_portal_video_submissions";
const LEGACY_SUBMISSIONS_COLLECTION = "submissions";
const ONBOARDING_OUTBOX_COLLECTION = "scp_onboarding_outbox";
const PROGRAMS_COLLECTION = "programs";
const CAMPAIGNS_COLLECTION = "campaigns";

// Real event-doc field is `atIso` (see PartnerActivationEvent in ./partnerActivationCore.ts), NOT the
// `occurredAtIso` the read-model comment speculates — see file header DECISION note.
const PARTNER_AUDIT_ORDER_FIELD = "atIso";

// Bounded raw-fetch batch size per Firestore round trip while loop-fetching a scoped page (see
// fetchActiveActivationPage below) — never larger than a single bounded query; possibly issued more than
// once only when the caller scoped to one programId/campaignId out of a larger unscoped ordering.
const RAW_ACTIVATION_BATCH_SIZE = 50;
// Hard ceiling on how many raw activation docs one `fetchActiveActivationPage` call will scan across all
// of its internal raw batches — bounds the loop-fetch so a scope that matches almost nothing can never
// degrade into an effectively unbounded collection scan.
const MAX_RAW_ACTIVATIONS_SCANNED = 500;

function docToRow(doc: Pick<FirebaseFirestore.DocumentSnapshot, "id" | "data">): Record<string, unknown> {
  return { id: doc.id, ...((doc.data() ?? {}) as Record<string, unknown>) };
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function classifiedScopeId(value: unknown): string | null {
  const normalized = textField(value).trim();
  return normalized && normalized !== "unclassified" ? normalized : null;
}

function numberField(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function recordField(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function publicLabel(row: Record<string, unknown> | null, fallback: string): string {
  if (!row) return fallback;
  return textField(row.title) || textField(row.name) || textField(row.displayName) || textField(row.label) || fallback;
}

function attributionClassification(application: Record<string, unknown>): "managed" | "unclassified" {
  if (textField(application.classification) === "unclassified") {
    return "unclassified";
  }
  if (classifiedScopeId(recordField(application, "identity").campaignId) === null) {
    return "unclassified";
  }
  return "managed";
}

function youtubeWatchUrl(videoId: string): string {
  return `https://youtu.be/${encodeURIComponent(videoId)}`;
}

function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

function creatorProfileInputs(
  creator: Record<string, unknown> | undefined,
  fluCreatorId: string,
): Omit<BuildPartnerListRowInput, "activation"> {
  const { displayName, handle } = resolveCreatorDisplayIdentity(creator, fluCreatorId);
  return {
    displayName,
    handle,
    profileImageInputs: creatorProfileImageSourceInputs(creator ?? {}),
    profileImageRevision: typeof creator?.profileImageRevision === "number" ? creator.profileImageRevision : 0,
    profileImageVerifiedAt:
      typeof creator?.profileImageVerifiedAt === "string" ? creator.profileImageVerifiedAt : undefined,
  };
}
async function readDoc(db: FirestoreDb, collectionName: string, id: string | undefined): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  const snap = await db.collection(collectionName).doc(id).get();
  return snap.exists ? docToRow(snap) : null;
}

function activationIdentity(row: Record<string, unknown> | null): Record<string, unknown> {
  return row ? recordField(row, "identity") : {};
}

function activationEvidence(row: Record<string, unknown> | null): Record<string, unknown> {
  return row ? recordField(row, "evidence") : {};
}

function applicationMatchesActivation(
  activation: Record<string, unknown>,
  application: Record<string, unknown> | null,
): application is Record<string, unknown> {
  if (!application) return false;
  const identity = activationIdentity(activation);
  const applicationIdentity = recordField(application, "identity");
  return (textField(application.applicationId) || textField(application.id)) === textField(identity.applicationId)
    && textField(applicationIdentity.fluCreatorId) === textField(identity.fluCreatorId)
    && textField(applicationIdentity.programId) === textField(identity.programId)
    && classifiedScopeId(applicationIdentity.campaignId) === classifiedScopeId(identity.campaignId)
    && textField(applicationIdentity.enrollmentId) === textField(identity.enrollmentId);
}

function reviewMatchesActivation(
  activation: Record<string, unknown>,
  review: Record<string, unknown> | null,
): review is Record<string, unknown> {
  if (!review) return false;
  const identity = activationIdentity(activation);
  const evidence = activationEvidence(activation);
  const subject = recordField(review, "subject");
  const submissionId = textField(evidence.submissionId);
  return textField(review.id) === submissionId
    && textField(subject.videoSubmissionId) === submissionId
    && textField(subject.applicationId) === textField(identity.applicationId)
    && textField(subject.fluCreatorId) === textField(identity.fluCreatorId)
    && textField(subject.programId) === textField(identity.programId)
    && classifiedScopeId(subject.campaignId) === classifiedScopeId(identity.campaignId)
    && textField(subject.enrollmentId) === textField(identity.enrollmentId)
    && numberField(review.revision ?? subject.videoRevision, -1) === numberField(evidence.videoRevision, -2);
}

async function loadActivationBundle(db: FirestoreDb, enrollmentId: string): Promise<{
  activation: Record<string, unknown> | null;
  program: Record<string, unknown> | null;
  campaign: Record<string, unknown> | null;
}> {
  const activation = await readDoc(db, SCP_PARTNER_ACTIVATIONS_COLLECTION, partnerActivationId(enrollmentId));
  const identity = activationIdentity(activation);
  const [program, campaign] = await Promise.all([
    readDoc(db, PROGRAMS_COLLECTION, textField(identity.programId)),
    readDoc(db, CAMPAIGNS_COLLECTION, classifiedScopeId(identity.campaignId) ?? undefined),
  ]);
  return { activation, program, campaign };
}

function event(
  stage: PartnerJourneyStage,
  occurredAtIso: string,
  source: string,
  actor: PartnerJourneyEvent["actor"],
  index: number,
  enrollmentId: string,
): PartnerJourneyEvent | null {
  if (!occurredAtIso) return null;
  return {
    eventId: `${stage}:${index}`,
    enrollmentId,
    stage,
    occurredAtIso,
    source,
    sourceRef: source,
    actor,
    confidence: "verified",
    delayedReceipt: false,
  };
}

export function partnerActivationEventToAuditEvent(row: Record<string, unknown>): PartnerAuditEvent {
  const rawEventType = textField(row.eventType);
  const eventType: PartnerAuditEvent["eventType"] = rawEventType === "revoked" || rawEventType === "partner.revoked"
    ? "partner.revoked"
    : "partner.activated";
  const rawResult = textField(row.result);
  const result: PartnerAuditEvent["result"] = rawResult === "failed" || rawResult === "rejected" ? rawResult : "success";
  const actorId = textField(row.actorId) || null;
  const rawActorType = textField(row.actorType);
  const actorKind: PartnerAuditEvent["actor"]["kind"] = rawActorType === "ai"
    ? "ai"
    : rawActorType === "system" || !actorId
      ? "system"
      : "human";
  const occurredAtIso = textField(row.atIso) || textField(row.occurredAtIso);
  const decisionRef = textField(row.decisionRef);
  return {
    eventId: textField(row.eventId) || textField(row.id),
    enrollmentId: textField(row.enrollmentId),
    // Activation events created before provenance expansion may lack these optional fields;
    // preserve the absence as an integrity signal rather than inferring identity from an
    // unrelated current document. New events always carry the immutable activation lineage.
    fluCreatorId: textField(row.fluCreatorId),
    programId: textField(row.programId),
    eventType,
    occurredAtIso,
    recordedAtIso: textField(row.recordedAtIso) || occurredAtIso,
    actor: { kind: actorKind, actorId },
    result,
    source: "Partner 활성화 원장",
    sourceRefHash: null,
    idempotencyKeyHash: null,
    evidenceRefs: [
      ...(decisionRef ? [decisionRef] : []),
      ...(textField(row.submissionId) ? [`submission:${textField(row.submissionId)}`] : []),
      ...(Number.isInteger(row.videoRevision) ? [`revision:${String(row.videoRevision)}`] : []),
    ],
    reasonCode: textField(row.reasonCode) || null,
    policyVersion: textField(row.policyVersion) || null,
    beforeHash: null,
    afterHash: null,
  };
}

// One bounded, enrollmentId-scoped, index-backed list fetch for the audit tab — equality on enrollmentId,
// ordered DESC by the tab's declared trailing field, `.limit(n)` always applied. Fails closed (empty
// page) when enrollmentId is missing from scope rather than ever widening to an unscoped scan.
async function fetchEnrollmentScopedPage(
  db: FirestoreDb,
  collectionName: string,
  orderField: string,
  enrollmentId: string | undefined,
  limit: number,
): Promise<Record<string, unknown>[]> {
  if (typeof enrollmentId !== "string" || enrollmentId.length === 0) return [];
  const snapshot = await db
    .collection(collectionName)
    .where("enrollmentId", "==", enrollmentId)
    .orderBy(orderField, "desc")
    .limit(limit)
    .get();
  return snapshot.docs.map(docToRow);
}

// ---- getActivePartners (spec §9) ------------------------------------------------------------------

// 파트너 목록 커서는 "어디서부터"(activation id) + "이미 낸 enrollment"를 함께 나른다.
// 직렬화 필드명 `emittedCreatorIds`는 기존 opaque 커서 호환을 위해 유지하되 값의 축은 enrollmentId다.
const PARTNER_CURSOR_SEPARATOR = "~";
const PARTNER_CURSOR_EMITTED_CAP = 200;

// 시작 위치는 정렬 필드 튜플이어야 한다. 예전에는 enrollmentId 를 그대로 넘겨
// orderBy("activatedAtIso") 커서 자리에 문서 id 를 비교시켰다 — 정렬 축이 다르므로
// 어디서 이어질지 보장되지 않는다.
const PARTNER_CURSOR_TUPLE_SEPARATOR = "|";

export interface PartnerListCursorPosition {
  readonly activatedAtIso: string;
  readonly activationId: string;
}

export function encodePartnerListCursor(
  startAfter: PartnerListCursorPosition | string,
  emittedCreatorIds: readonly string[],
): string {
  const position = typeof startAfter === "string"
    ? startAfter
    : `${startAfter.activatedAtIso}${PARTNER_CURSOR_TUPLE_SEPARATOR}${startAfter.activationId}`;
  const encodedPosition = Buffer.from(position, "utf8").toString("base64url");
  const trimmed = emittedCreatorIds.slice(-PARTNER_CURSOR_EMITTED_CAP);
  if (trimmed.length === 0) return encodedPosition;
  return `${encodedPosition}${PARTNER_CURSOR_SEPARATOR}${Buffer.from(trimmed.join(","), "utf8").toString("base64url")}`;
}

export function decodePartnerListCursor(
  cursor: string | null,
): { position: PartnerListCursorPosition | null; startAfterId: string | null; emittedCreatorIds: string[] } {
  if (!cursor) return { position: null, startAfterId: null, emittedCreatorIds: [] };
  const separatorIndex = cursor.indexOf(PARTNER_CURSOR_SEPARATOR);
  const rawPosition = separatorIndex < 0 ? cursor : cursor.slice(0, separatorIndex);
  let emittedCreatorIds: string[] = [];
  if (separatorIndex >= 0) {
    try {
      const decoded = Buffer.from(cursor.slice(separatorIndex + PARTNER_CURSOR_SEPARATOR.length), "base64url").toString("utf8");
      emittedCreatorIds = decoded ? decoded.split(",").filter(Boolean) : [];
    } catch {
      emittedCreatorIds = [];
    }
  }
  // base64url 디코드는 아무 문자열이나 통과시키므로, 다시 인코딩해서 원본과 같을 때만 인정한다.
  // 그래야 배포 이전에 발급된 평문 커서("enr-9")를 쓰레기로 해석하지 않는다.
  let decodedPosition = rawPosition;
  try {
    const candidate = Buffer.from(rawPosition, "base64url").toString("utf8");
    if (candidate && Buffer.from(candidate, "utf8").toString("base64url") === rawPosition) {
      decodedPosition = candidate;
    }
  } catch {
    // 레거시 평문 커서 — 그대로 둔다.
  }
  const tupleIndex = decodedPosition.indexOf(PARTNER_CURSOR_TUPLE_SEPARATOR);
  if (tupleIndex < 0) {
    // 배포 이전에 발급된 커서(문서 id 단독). 위치 튜플이 없으므로 문서 id 로만 이어붙인다.
    return { position: null, startAfterId: decodedPosition || null, emittedCreatorIds };
  }
  return {
    position: {
      activatedAtIso: decodedPosition.slice(0, tupleIndex),
      activationId: decodedPosition.slice(tupleIndex + PARTNER_CURSOR_TUPLE_SEPARATOR.length),
    },
    startAfterId: decodedPosition.slice(tupleIndex + PARTNER_CURSOR_TUPLE_SEPARATOR.length) || null,
    emittedCreatorIds,
  };
}

export function createFirestoreActivePartnersPort(db: FirestoreDb = adminDb): ActivePartnersPort {
  return {
    // Adversarial-review remediation (scoped-pagination under-fetch): the underlying Firestore query has
    // no programId/campaignId equality clause — `identity.programId`/`identity.campaignId` are nested,
    // and a real activation doc's true leading equality field for this query is just `status`. When the
    // caller scopes to one programId/campaignId, filtering AFTER a single raw `limit(n)` fetch can starve
    // the page even though plenty of in-scope rows exist further down the unscoped `activatedAtIso`
    // ordering. This loop-fetches successive bounded raw batches (never unbounded — capped by
    // MAX_RAW_ACTIVATIONS_SCANNED) until either the requested page is filled with in-scope rows or the
    // underlying collection is exhausted.
    async fetchActiveActivationPage(scope: PartnerListQueryScope, page) {
      const collected: PartnerActivationDocument[] = [];
      // Partner 행의 정본 축은 enrollmentId다. 같은 크리에이터가 프로그램/캠페인별 enrollment를 여러
      // 건 가질 수 있으므로 fluCreatorId로 접지 않는다. 앞 페이지에서 이미 낸 enrollment는 opaque
      // 커서의 기존 `emittedCreatorIds` 슬롯에 실어 페이지 경계에서도 같은 축을 유지한다.
      const { position, startAfterId, emittedCreatorIds } = decodePartnerListCursor(page.cursor);
      const seenEnrollmentIds = new Set<string>(emittedCreatorIds);
      let cursorDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
      let scanned = 0;
      let usedOuterCursor = false;
      while (collected.length < page.limit && scanned < MAX_RAW_ACTIVATIONS_SCANNED) {
        let query: FirebaseFirestore.Query = db
          .collection(SCP_PARTNER_ACTIVATIONS_COLLECTION)
          .where("status", "==", "active")
          .orderBy("activatedAtIso", "desc");
        if (cursorDoc) {
          query = query.startAfter(cursorDoc);
        } else if ((position || startAfterId) && !usedOuterCursor) {
          // First raw batch only: resume where the previous page ended.
          //
          // 문서 스냅샷 커서를 쓴다. 예전에는 enrollmentId 문자열을 orderBy("activatedAtIso")
          // 커서 자리에 넘겨서 정렬 축이 다른 값끼리 비교됐다. 정렬 필드 값만 넘기면 동일
          // activatedAtIso 인 행이 통째로 건너뛰어진다. 스냅샷 커서는 배포된 인덱스
          // (status, activatedAtIso DESC, __name__)를 그대로 쓰면서 두 문제를 모두 없앤다.
          const anchorId = position?.activationId ?? startAfterId;
          const anchor = anchorId
            ? await db.collection(SCP_PARTNER_ACTIVATIONS_COLLECTION).doc(anchorId).get()
            : null;
          if (anchor?.exists) {
            query = query.startAfter(anchor);
          } else if (position) {
            // 앵커 문서가 사라졌으면 정렬 값으로라도 이어붙인다.
            query = query.startAfter(position.activatedAtIso);
          }
          usedOuterCursor = true;
        }
        query = query.limit(RAW_ACTIVATION_BATCH_SIZE);
        const snapshot = await query.get();
        if (snapshot.empty) break;
        for (const doc of snapshot.docs) {
          const raw = doc.data() as Record<string, unknown>;
          // 시드/픽스처 행은 파트너 목록에 실제 파트너처럼 섞이면 안 된다 — 붙는 creators 문서도 없어서
          // 이름 자리에 seed-0540-flu-creator-1 같은 raw id 가 그대로 떴다.
          if (isOperationalFixtureRecord(raw, SCP_PARTNER_ACTIVATIONS_COLLECTION)) continue;
          const parsed = parsePartnerActivationDocument({ exists: doc.exists, data: () => raw });
          if (
            parsed &&
            matchesPartnerListScope(scope, {
              programId: parsed.identity.programId,
              campaignId: parsed.identity.campaignId ?? null,
            })
          ) {
            if (seenEnrollmentIds.has(parsed.identity.enrollmentId)) continue;
            seenEnrollmentIds.add(parsed.identity.enrollmentId);
            collected.push(parsed);
            // 호출자가 준 상한(limit+1)을 넘겨 모으면 buildCursorPage 가 failed-precondition 으로
            // 500 을 낸다(원시 배치 50 vs 페이지 20). 상한에 닿으면 즉시 멈춘다.
            if (collected.length >= page.limit) break;
          }
        }
        scanned += snapshot.docs.length;
        cursorDoc = snapshot.docs[snapshot.docs.length - 1] ?? null;
        if (snapshot.docs.length < RAW_ACTIVATION_BATCH_SIZE) break; // underlying collection exhausted
      }
      return collected;
    },
    async resolveProfileInputs(identity): Promise<Omit<BuildPartnerListRowInput, "activation">> {
      const snap = await db.collection(CREATORS_COLLECTION).doc(identity.fluCreatorId).get();
      const data = (snap.exists ? snap.data() : undefined) as Record<string, unknown> | undefined;
      // 이름/핸들/이미지 입력은 overview envelope의 직접 creators 조인과 같은 정본 투영을 쓴다.
      return creatorProfileInputs(data, identity.fluCreatorId);
    },
    async resolveCampaignNames(campaignIds): Promise<ReadonlyMap<string, string>> {
      return loadCampaignDisplayNames(db, campaignIds);
    },
    async resolveProgramNames(programIds): Promise<ReadonlyMap<string, string>> {
      return loadPartnerProgramDisplayNames(db, programIds);
    },
  };
}

// ---- resolvePartnerRouteAlias (spec §2.1, §9) -------------------------------------------------------

// No legacy alias table exists anywhere in this codebase (Sheet3/submission-token/lead aliases are
// explicitly forbidden as Partner-membership evidence — spec §1 rule 2, reaffirmed in
// partnerProfileTabsReadModels.ts's header comment). This port therefore ALWAYS resolves to
// unresolved (null); resolvePartnerRoute() already turns that into the correct fail-closed
// `failed-precondition` for the caller. A real alias-table lookup is a distinct, explicit future change,
// never inferred here.
export function createFirestoreResolvePartnerRouteAliasPort(_db: FirestoreDb = adminDb): ResolvePartnerRouteAliasPort {
  return {
    async lookup(): Promise<string | null> {
      return null;
    },
  };
}

// ---- Partner tab-envelope batch (mirrors createFirestoreManagementTabEnvelopesPort) -----------------

export function createFirestorePartnerTabEnvelopesPort(db: FirestoreDb = adminDb): PartnerTabEnvelopesPort {
  return {
    buildLoaders(scope: PartnerScopeRequest): PartnerTabLoaders {
      const loaders: PartnerTabLoaders = {};
      for (const tab of PARTNER_TAB_KEYS as readonly PartnerTabKey[]) {
        loaders[tab] = () => loadPartnerTab(db, tab, scope);
      }
      return loaders;
    },
  };
}

async function loadPartnerTab(db: FirestoreDb, tab: PartnerTabKey, scope: PartnerScopeRequest): Promise<unknown> {
  switch (tab) {
    case "overview":
    case "performance": {
      // Single-record tabs use deterministic bounded doc gets, never a list scan. Overview additionally
      // joins the exact creators/{fluCreatorId} document for Tier-A identity. No settlement/payout ledger
      // source of truth is wired yet ([확인 필요] per partnerProfileTabsReadModels.ts header), so
      // `performance` surfaces only the activation evidence and never fabricates settlement figures.
      const bundle = await loadActivationBundle(db, scope.enrollmentId);
      if (!bundle.activation) return { activation: null };
      const identity = activationIdentity(bundle.activation);
      const campaignId = classifiedScopeId(identity.campaignId);
      let overviewIdentity:
        | {
            displayName: string;
            handle: string | null;
            profileImage: ReturnType<typeof resolveProfileImageProjection>;
          }
        | null = null;
      if (tab === "overview") {
        const creator = await readDoc(db, CREATORS_COLLECTION, textField(identity.fluCreatorId));
        const profile = creatorProfileInputs(creator ?? undefined, textField(identity.fluCreatorId));
        overviewIdentity = {
          displayName: profile.displayName,
          handle: profile.handle,
          profileImage: resolveProfileImageProjection(
            profile.profileImageInputs,
            profile.displayName,
            profile.profileImageRevision,
            profile.profileImageVerifiedAt,
          ),
        };
      }
      return {
        activation: bundle.activation,
        program: {
          id: textField(identity.programId),
          // 리스트와 같은 해석기. 전역 태그(view-cpm)나 이름 없는 문서는 빈 문자열이고, 클라가
          // "프로그램명 미연결"로 남긴다 — 정적 매핑으로 특정 프로그램에 귀속시키지 않는다.
          name: partnerProgramDisplayName(textField(identity.programId), bundle.program) ?? "",
        },
        campaign: campaignId
          ? {
              id: campaignId,
              name: publicLabel(bundle.campaign, "캠페인명 미연결"),
            }
          : null,
        ...(overviewIdentity ?? {}),
      };
    }
    case "journey": {
      const bundle = await loadActivationBundle(db, scope.enrollmentId);
      const activation = bundle.activation;
      if (!activation) return { rows: [], emptyReasonCode: "partner_activation_missing" };
      const identity = activationIdentity(activation);
      const evidence = activationEvidence(activation);
      const applicationId = textField(identity.applicationId);
      const videoSubmissionId = textField(evidence.submissionId);
      const [application, onboardingRows, review] = await Promise.all([
        applicationId
          ? readDoc(db, APPLICATION_MANAGEMENT_COLLECTION, applicationId)
          : Promise.resolve(null),
        applicationId
          ? Promise.all(
              Array.from({ length: 5 }, (_, generation) =>
                readDoc(db, ONBOARDING_OUTBOX_COLLECTION, `${applicationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160)}__${generation}`),
              ),
            ).then((rows) => rows.filter((row): row is Record<string, unknown> => row !== null))
          : Promise.resolve([]),
        videoSubmissionId
          ? readDoc(db, VIDEO_REVIEW_STATE_COLLECTION, videoSubmissionId)
          : Promise.resolve(null),
      ]);
      const scopedApplication = applicationMatchesActivation(activation, application) ? application : null;
      const scopedOnboardingRows = onboardingRows.filter((row) => textField(row.applicationId) === applicationId);
      const scopedReview = reviewMatchesActivation(activation, review) ? review : null;
      const campaignId = classifiedScopeId(identity.campaignId);
      const events = [
        event("program", textField(bundle.program?.createdAtIso) || textField(activation.activatedAtIso), "program", "operator", 1, scope.enrollmentId),
        campaignId
          ? event("campaign", textField(bundle.campaign?.createdAtIso) || textField(activation.activatedAtIso), "campaign", "operator", 2, scope.enrollmentId)
          : null,
        event("apply", textField(scopedApplication?.submittedAtIso) || textField(scopedApplication?.createdAtIso), "application", "portal", 3, scope.enrollmentId),
        event("enrollment", textField(scopedApplication?.enrolledAtIso) || textField(scopedApplication?.submittedAtIso), "application", "portal", 4, scope.enrollmentId),
        // U7 P4: 온보딩·제출 근거 수집은 공용 모듈 한 벌(enrollmentJourneyEvidence)로. 관리 상세도
        // 같은 규칙을 쓴다. 단계 이름(어휘)은 각 화면 계약 그대로 둔다.
        event("onboarding", onboardingSentEvidence(scopedOnboardingRows)?.occurredAtIso ?? "", "onboarding_receipt", "flu_automation", 5, scope.enrollmentId),
        event("video_submitted", contentSubmittedEvidence(scopedReview)?.occurredAtIso ?? "", "review_state", "creator", 6, scope.enrollmentId),
        event("video_approved", textField(evidence.approvedAtIso), "activation_evidence", textField(evidence.actorType) === "ai" ? "ai" : "operator", 7, scope.enrollmentId),
        event("partner_active", textField(activation.activatedAtIso), "partner_activation", "flu_automation", 8, scope.enrollmentId),
      ].filter((item): item is PartnerJourneyEvent => item !== null)
        .sort((a, b) => b.occurredAtIso.localeCompare(a.occurredAtIso))
        .slice(0, DEFAULT_PAGE_SIZE);
      const complete = new Set(events.map((row) => row.stage));
      const stages: PartnerJourneyStageStatus[] = ([
        "program",
        "campaign",
        "apply",
        "enrollment",
        "onboarding",
        "video_submitted",
        "video_approved",
        "partner_active",
      ] as PartnerJourneyStage[]).map((stage) => ({
        stage,
        complete: complete.has(stage),
        missingLabel: complete.has(stage) ? null : `${stage}_evidence_missing`,
        critical: stage === "video_submitted" || stage === "video_approved" || stage === "partner_active",
      }));
      const data: PartnerJourneyData = {
        stages,
        events,
        attribution: scopedApplication
          ? {
              classification: attributionClassification(scopedApplication),
              programId: textField(identity.programId),
              campaignId,
              outreachId: textField(identity.outreachId) || null,
              applicationId,
              enrollmentId: scope.enrollmentId,
              assignmentRevision: Math.max(0, Math.trunc(numberField(scopedApplication?.revision ?? scopedApplication?.sourceRevision, 0))),
              reasonCode: "partner_activation_identity",
            }
          : null,
      };
      return data.events.length > 0 ? data : { ...data, emptyReasonCode: "partner_journey_evidence_missing" };
    }
    case "videos": {
      const bundle = await loadActivationBundle(db, scope.enrollmentId);
      const activation = bundle.activation;
      if (!activation) return { rows: [], emptyReasonCode: "partner_activation_missing" };
      const identity = activationIdentity(activation);
      const evidence = activationEvidence(activation);
      const videoSubmissionId = textField(evidence.submissionId);
      if (!videoSubmissionId) return { rows: [], emptyReasonCode: "enrollment_submission_attribution_missing" };
      const review = await readDoc(db, VIDEO_REVIEW_STATE_COLLECTION, videoSubmissionId);
      if (!reviewMatchesActivation(activation, review)) {
        return { rows: [], emptyReasonCode: "approved_current_submission_missing" };
      }
      const [portalSubmission, legacySubmission] = await Promise.all([
        readDoc(db, PORTAL_VIDEO_SUBMISSIONS_COLLECTION, videoSubmissionId),
        readDoc(db, LEGACY_SUBMISSIONS_COLLECTION, videoSubmissionId),
      ]);
      const approvedCurrent = textField(review.state) === "approved"
        && review.withdrawn !== true
        && review.superseded !== true
        && numberField(review.revision) === numberField(evidence.videoRevision);
      if (!approvedCurrent) return { rows: [], emptyReasonCode: "approved_current_submission_missing" };
      // U7 P1: videoId 해석 공용화. 파트너 상세에서 videoId 가 빈 문자열로 남아 관리 상세와 값이
      // 갈렸다(실측: "" vs "7jHkz1liyHg"). 체인 말미에 제출 URL 파서와 원장 videoId 를 더한다 —
      // 관리 상세(managementProfileTabsPorts)와 **같은 헬퍼·같은 순서**다.
      const youtubeVideoId = textField(review.youtubeVideoId)
        || textField(portalSubmission?.youtubeVideoId)
        || textField(legacySubmission?.youtubeVideoId)
        || extractYouTubeVideoIdFromSubmissionUrl(review.youtubeUrl)
        || extractYouTubeVideoIdFromSubmissionUrl(portalSubmission?.youtubeUrl)
        || extractYouTubeVideoIdFromSubmissionUrl(legacySubmission?.submissionUrl)
        || textField(review.videoId)
        || "";
      // 표시 제목·썸네일의 정본은 `videos` 다(복사 금지 — 읽는 시점에 조인).
      const videoDoc = youtubeVideoId ? await readDoc(db, "videos", youtubeVideoId) : null;
      const revision: PartnerVideoRevision = {
        revision: numberField(review.revision),
        state: "current",
        canonicalUrl:
          textField(review.youtubeUrl)
          || textField(portalSubmission?.canonicalVideoUrl)
          || textField(legacySubmission?.youtubeUrl)
          || (youtubeVideoId ? youtubeWatchUrl(youtubeVideoId) : "#"),
        youtubeVideoId,
        submittedAtIso: textField(review.submittedAtIso) || textField(review.createdAtIso) || textField(review.updatedAtIso),
        reviewStatus: "approved",
        decisionId: textField(evidence.reviewDecisionRef) || null,
        decisionAtIso: textField(evidence.approvedAtIso) || null,
        publicReasonCode: textField(review.reasonCode) || null,
        analysisEvidenceRef: textField(review.analysisEvidenceRef) || null,
      };
      const video: PartnerVideo = {
        videoSubmissionId,
        applicationId: textField(identity.applicationId),
        enrollmentId: scope.enrollmentId,
        // 제목·썸네일은 정본 해석기를 거친다. 레거시 시트 이관분은 portal/legacy 제출 문서가 아예
        // 없고 원장 제목이 사내 라벨("Legacy XP Hero content")이라, 여기까지만 보면 파트너 영상 탭이
        // 라벨과 빈 썸네일만 보여준다(운영 실측 8/8). 진짜 값은 이미 `videos` 에 들어와 있다.
        // U7 P2: 제목 해석은 공용 래퍼 한 벌(resolveApprovedVideoTitle)로. 관리 상세도 같은 래퍼를 쓴다.
        title:
          resolveApprovedVideoTitle(
            videoDoc,
            portalSubmission?.title,
            legacySubmission?.title,
            review.title,
          ).title,
        // 썸네일은 원래 경로 그대로 둔다(이미 20건 중 19건이 붙어 있었다) — 여기서 고칠 것은 제목이다.
        // videos 문서가 실제 썸네일 URL 을 들고 있으면 그것만 한 단계 더 우선한다.
        thumbnailUrl:
          textField(portalSubmission?.thumbnailUrl)
          || textField(legacySubmission?.thumbnailUrl)
          || textField(videoDoc?.thumbnailUrl)
          || textField(review.thumbnailUrl)
          || (youtubeVideoId ? youtubeThumbnailUrl(youtubeVideoId) : null),
        currentRevision: revision.revision,
        revisions: [revision],
        trackingEligible: review.trackingEligible === true,
        settlementEligible: review.settlementEligible === true,
        downstreamProjectionConfirmed: review.downstreamProjectionConfirmed === true,
      };
      assertNoDuplicateVideoSubmissionRows([video]);
      return { rows: [video] };
    }
    case "audit": {
      // U7 P3: 감사 이벤트도 관리 상세와 **같은 계보 판정**을 통과한 것만 보여준다(강화). enrollment
      // 범위만 맞으면 다른 계보 이벤트가 섞일 수 있었다 — present-only equality 로 걸러낸다.
      const auditBundle = await loadActivationBundle(db, scope.enrollmentId);
      // F7(a): activation 이 없으면 계보를 판정할 근거 자체가 없다. 형제 탭(영상·Journey)과 같은
      // 사유 코드를 돌려준다 — 빈 목록만 주면 "이벤트가 없다"와 "판정 근거가 없다"가 구분되지 않는다.
      if (!auditBundle.activation) {
        return { rows: [], emptyReasonCode: "partner_activation_missing" };
      }
      const auditIdentity = activationIdentity(auditBundle.activation);
      const auditRows = await fetchEnrollmentScopedPage(
        db,
        SCP_PARTNER_ACTIVATION_EVENTS_COLLECTION,
        PARTNER_AUDIT_ORDER_FIELD,
        scope.enrollmentId,
        DEFAULT_PAGE_SIZE,
      );
      return {
        rows: auditRows
          .filter((row) => activationEventMatchesLineage(row, auditIdentity))
          .map(partnerActivationEventToAuditEvent),
      };
    }
    default:
      return { rows: [] };
  }
}
