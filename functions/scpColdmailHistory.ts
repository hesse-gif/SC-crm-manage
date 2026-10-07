// SCP 콜드메일 발송 히스토리 — append-only 원장 (PR1).
//
// 3-컬렉션 소유 경계 (omx_wiki/flu-scp-coldmail-history.md):
//   - scp_outreach          = 이메일당 현재 STATE (idempotent, 중복 붕괴 O)  [scpOutreach.ts]
//   - mail_outbound_log     = trackingId당 DELIVERY/open(openCount)/reply(hasReply) 신호  [mailSignature.ts]
//   - scp_coldmail_history  = 발송 이벤트당 append-only 비즈니스 히스토리 (중복 발송=별도 row)  [이 모듈]
//   조인: trackingId(→delivery/open), conversationId(→reply).
//
// 하드 규칙:
//   - append-only. 같은 발송(같은 trackingId)은 파생필드(open/reply)만 merge, 절대 새 row/붕괴 금지.
//     서로 다른 발송(서로 다른 trackingId)은 항상 별도 row.
//   - doc id = trackingId(있으면) else sha256(email+sentAtIso+subject+source+draftRef). 정규화 이메일 단독 금지.
//   - RBAC: list/export super_admin/admin/manager. 전체 본문 CSV는 admin/super_admin + includeBody(서버 집행).
//   - 본문은 서버측 아웃바운드 본문일 때만 저장(인바운드 원문/프롬프트 원문 저장 금지, SEC-P0-009).
//   - 클라 직접쓰기 금지(SEC-P0-004): append는 서버 발송경로에서만 호출.

import { createHash } from "node:crypto";
import { FieldPath, FieldValue, type Query } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  maskEmail,
  type AuthContext,
  type CallableRequestShape,
} from "./shared";
import { enqueueScpLifecycleRefreshEvent } from "./scpLifecycleProfiles";
// 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): see scpAutomationSettings.ts.
import { assertScpEntitled } from "./mailAccounts";
import { conversationHasReply } from "./mailSignature";
import { resolveCanonicalProgramId } from "./programCanonical";
import { confirmedProgramScope, readConfirmedProgramAliasRegistryState } from "./programAliasRegistry";
import { campaignCandidateRefFor } from "./candidateScope";

const HISTORY_COLLECTION = "scp_coldmail_history";
const PROJECTION_COLLECTION = "scp_coldmail_history_projection";
const PII_ACCESS_AUDIT_COLLECTION = "scp_coldmail_history_pii_access_audits";
// trackingId 기준 투영 입력 — mailSignature.ts의 아웃바운드 원장(doc id = trackingId).
// 콜드 발송 시점엔 대화가 없어 conversationId가 비어있는 게 정상이다. 수신/발신 write path와
// 명시적 rebuild가 projection을 물질화한다. list는 현재 페이지의 trackingId 문서만 bounded
// getAll로 확인할 수 있지만 conversation scan이나 쓰기는 하지 않는다.
const MAIL_OUTBOUND_LOG_COLLECTION = "mail_outbound_log";
const READ_ROLES = ["super_admin", "admin", "manager"] as const;
const FULL_BODY_ROLES = ["super_admin", "admin"] as const;
const DEFAULT_PROGRAM_ID = "scp";
const LIST_LIMIT_MAX = 100;
const LIST_LIMIT_DEFAULT = 100;
const BODY_PREVIEW_MAX = 280;
const PROJECTION_VERSION = "scp_coldmail_history_projection_v2";
const YOUTUBE_MATERIALIZATION_VERSION = "scp_coldmail_youtube_scope_v2";
const REBUILD_CURSOR_VERSION = 1;
const REBUILD_LIMIT_MAX = 500;
const LOOKUP_CHUNK_SIZE = 10;

export type ColdmailYoutubeProjection = {
  youtubeUrl: string;
  youtubeSource: "send_payload" | "history_legacy" | "campaign_candidate" | "program_sheet_lead" | "creator_profile" | "missing";
  youtubeValidation: "channel_url_format" | "missing";
  youtubeConfidence: number;
  youtubeVerifiedAtIso: string;
};

type YoutubeEvidenceKind =
  | "history_send_payload"
  | "history_ledger"
  | "campaign_candidate_participation"
  | "program_sheet_lead_scope"
  | "materialized_missing";

function youtubeEvidenceKindForSource(
  source: ColdmailYoutubeProjection["youtubeSource"],
): YoutubeEvidenceKind | "" {
  if (source === "send_payload") return "history_send_payload";
  if (source === "history_legacy") return "history_ledger";
  if (source === "campaign_candidate") return "campaign_candidate_participation";
  if (source === "program_sheet_lead") return "program_sheet_lead_scope";
  if (source === "missing") return "materialized_missing";
  return "";
}

export type ScpColdmailHistoryInput = {
  email: string;
  koreanName?: string;
  youtubeUrl?: string;
  subject?: string;
  body?: string;
  programId?: string;
  templateKind?: string;
  templateRef?: string;
  campaign?: string;
  campaignId?: string;
  campaignRef?: string;
  source?: string;
  sourceRef?: string;
  draftRef?: string;
  approvalRef?: string;
  trackingId?: string;
  mailOutboxRef?: string;
  conversationId?: string;
  conversationRef?: string;
  deliveryState?: string;
  approvalRevision?: string;
  compilerVersion?: string;
  templateRevision?: string;
  bodyFormat?: string;
  contentHash?: string;
  compiledHash?: string;
  textHash?: string;
  compiledFingerprint?: string;
  sentAtIso?: string;
  hasReply?: boolean;
};

function normalizeEmail(value: unknown): string {
  return asString(value).toLowerCase();
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:@-]+/g, "_").slice(0, 200);
}

function callableError(code: "invalid-argument" | "failed-precondition", message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

type ColdmailProgramScope = { programId: string; queryProgramIds: string[]; aliasRegistryRevision: string };

async function requireExactCanonicalProgramScope(value: unknown): Promise<ColdmailProgramScope> {
  const requestedProgramId = asString(value);
  if (!requestedProgramId) {
    throw callableError("invalid-argument", "programId is required for coldmail history reads");
  }
  const registry = await readConfirmedProgramAliasRegistryState();
  const scope = confirmedProgramScope(requestedProgramId, registry);
  if (scope.canonicalProgramId !== requestedProgramId) {
    throw callableError(
      "failed-precondition",
      "programId must be the exact canonical program id for coldmail history reads",
    );
  }
  return {
    programId: scope.canonicalProgramId,
    queryProgramIds: scope.identityProgramIds,
    aliasRegistryRevision: scope.aliasRegistryRevision,
  };
}

type CampaignScope = { campaignId: string; campaignRef: string };

function campaignScopeOf(input: Record<string, unknown>, allowLegacyCampaign: boolean): CampaignScope {
  const legacyCampaignId = allowLegacyCampaign ? asString(input.campaign) : "";
  const requestedCampaignId = asString(input.campaignId, legacyCampaignId);
  const requestedCampaignRef = asString(input.campaignRef);
  if (!requestedCampaignId && !requestedCampaignRef) return { campaignId: "", campaignRef: "" };

  const match = /^campaigns\/([^/]+)$/.exec(requestedCampaignRef);
  if (requestedCampaignRef && !match) {
    throw callableError("invalid-argument", "campaignRef must be an exact campaigns/{campaignId} reference");
  }
  const campaignIdFromRef = match?.[1] ?? "";
  if (requestedCampaignId && campaignIdFromRef && requestedCampaignId !== campaignIdFromRef) {
    throw callableError("failed-precondition", "campaignId and campaignRef must identify the same campaign");
  }
  const campaignId = requestedCampaignId || campaignIdFromRef;
  if (!campaignId || campaignId.includes("/")) {
    throw callableError("invalid-argument", "campaignId must be a single Firestore document id");
  }
  return { campaignId, campaignRef: `campaigns/${campaignId}` };
}

function storedCampaignScopeOf(row: Record<string, unknown>): CampaignScope {
  const declaredCampaignId = asString(row.campaignId, asString(row.campaign));
  const campaignRef = asString(row.campaignRef, declaredCampaignId ? `campaigns/${declaredCampaignId}` : "");
  const match = /^campaigns\/([^/]+)$/.exec(campaignRef);
  const campaignId = declaredCampaignId || match?.[1] || "";
  if (!campaignId || campaignId.includes("/") || !match || match[1] !== campaignId) {
    return { campaignId: "", campaignRef: "" };
  }
  return { campaignId, campaignRef };
}

function exactStoredCampaignScopeOf(row: Record<string, unknown>): CampaignScope {
  const campaignId = asString(row.campaignId);
  const legacyCampaignId = asString(row.campaign);
  const declaredCampaignId = campaignId || legacyCampaignId;
  const campaignRef = asString(row.campaignRef);
  const match = /^campaigns\/([^/]+)$/.exec(campaignRef);
  if (
    !declaredCampaignId
    || Boolean(campaignId && legacyCampaignId && campaignId !== legacyCampaignId)
    || declaredCampaignId.includes("/")
    || !match
    || match[1] !== declaredCampaignId
  ) return { campaignId: "", campaignRef: "" };
  return { campaignId: declaredCampaignId, campaignRef };
}

function exactStoredProgramScopeOf(row: Record<string, unknown>): { programId: string; programRef: string } | null {
  const storedProgramId = asString(row.programId);
  const programId = resolveCanonicalProgramId(storedProgramId);
  const programRef = asString(row.programRef);
  if (
    !programId
    || storedProgramId !== programId
    || asString(row.canonicalProgramId) !== programId
    || programRef !== `programs/${programId}`
  ) return null;
  return { programId, programRef };
}

function historyBelongsToCampaign(row: Record<string, unknown>, scope: CampaignScope): boolean {
  if (!scope.campaignId) return true;
  const rowScope = storedCampaignScopeOf(row);
  return rowScope.campaignId === scope.campaignId && rowScope.campaignRef === scope.campaignRef;
}

// 발송 이벤트의 결정적 doc id. trackingId 우선(같은 발송 멱등), 없으면 발송 구성요소 해시.
export function coldmailHistoryDocId(input: ScpColdmailHistoryInput): string {
  const trackingId = asString(input.trackingId);
  if (trackingId) return `cmh_${safeSegment(trackingId)}`;
  const email = normalizeEmail(input.email);
  const seed = [email, asString(input.sentAtIso), asString(input.subject), asString(input.source), asString(input.draftRef)].join("\u0000");
  return `cmh_${createHash("sha256").update(seed).digest("hex").slice(0, 40)}`;
}

function bodyPreviewOf(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > BODY_PREVIEW_MAX ? `${collapsed.slice(0, BODY_PREVIEW_MAX)}…` : collapsed;
}

function youtubeProjection(
  value: unknown,
  source: ColdmailYoutubeProjection["youtubeSource"],
  nowIso: string,
  confidence = 1,
): ColdmailYoutubeProjection {
  const youtubeUrl = normalizePublicYouTubeChannelUrl(value);
  if (!youtubeUrl) {
    return {
      youtubeUrl: "",
      youtubeSource: "missing",
      youtubeValidation: "missing",
      youtubeConfidence: 0,
      youtubeVerifiedAtIso: "",
    };
  }
  return {
    youtubeUrl,
    youtubeSource: source,
    youtubeValidation: "channel_url_format",
    youtubeConfidence: Math.min(1, Math.max(0, confidence)),
    youtubeVerifiedAtIso: nowIso,
  };
}

function historyYoutubeScopeEvidence(id: string, history: Record<string, unknown>): Record<string, unknown> {
  const rawProgramId = asString(history.programId);
  const programId = resolveCanonicalProgramId(rawProgramId);
  const exactProgram = exactStoredProgramScopeOf(history);
  const campaign = exactStoredCampaignScopeOf(history);
  const email = normalizeEmail(history.email ?? history.emailLower);
  const emailHash = asString(
    history.emailHash,
    email ? createHash("sha256").update(email).digest("hex").slice(0, 24) : "",
  );
  const historyRef = `${HISTORY_COLLECTION}/${id}`;
  const youtubeHistoryScopeHash = createHash("sha256").update(JSON.stringify([
    historyRef,
    rawProgramId,
    programId,
    asString(history.canonicalProgramId),
    asString(history.programRef),
    campaign.campaignId,
    campaign.campaignRef,
    asString(history.campaignId),
    asString(history.campaign),
    asString(history.campaignRef),
    emailHash,
    asString(history.source),
    asString(history.sourceRef),
    asString(history.trackingId),
    asString(history.sentAtIso),
  ])).digest("hex");
  return {
    youtubeMaterializationVersion: YOUTUBE_MATERIALIZATION_VERSION,
    youtubeHistoryScopeHash,
    youtubeHistoryRef: historyRef,
    youtubeProgramId: programId,
    youtubeProgramRef: exactProgram?.programRef ?? "",
    youtubeCampaignId: campaign.campaignId,
    youtubeCampaignRef: campaign.campaignRef,
    youtubeEvidenceRef: historyRef,
  };
}

function trustedYoutubeMaterialization(
  id: string,
  history: Record<string, unknown>,
  projection: Record<string, unknown>,
): boolean {
  if (!exactCanonicalHistoryYoutubeScope({ id, ...history })) return false;
  const expected = historyYoutubeScopeEvidence(id, history);
  if (
    asString(projection.projectionVersion) !== PROJECTION_VERSION
    || asString(projection.historyRef) !== `${HISTORY_COLLECTION}/${id}`
    || asString(projection.youtubeMaterializationVersion) !== YOUTUBE_MATERIALIZATION_VERSION
    || asString(projection.youtubeHistoryScopeHash) !== expected.youtubeHistoryScopeHash
    || asString(projection.youtubeHistoryRef) !== expected.youtubeHistoryRef
    || asString(projection.youtubeProgramId) !== expected.youtubeProgramId
    || asString(projection.youtubeProgramRef) !== expected.youtubeProgramRef
    || asString(projection.youtubeCampaignId) !== expected.youtubeCampaignId
    || asString(projection.youtubeCampaignRef) !== expected.youtubeCampaignRef
  ) return false;
  const source = asString(projection.youtubeSource);
  const evidenceKind = asString(projection.youtubeEvidenceKind);
  const evidenceRef = asString(projection.youtubeEvidenceRef);
  const youtubeUrl = normalizePublicYouTubeChannelUrl(projection.youtubeUrl);
  if (source === "campaign_candidate" && evidenceKind === "campaign_candidate_participation") {
    return Boolean(youtubeUrl && exactCollectionDocumentPath(evidenceRef, "campaign_candidates"));
  }
  if (source === "program_sheet_lead" && evidenceKind === "program_sheet_lead_scope") {
    return Boolean(youtubeUrl && exactCollectionDocumentPath(evidenceRef, "program_sheet_leads"));
  }
  if (source === "send_payload" && evidenceKind === "history_send_payload") {
    return Boolean(youtubeUrl && evidenceRef === expected.youtubeHistoryRef);
  }
  if (source === "history_legacy" && evidenceKind === "history_ledger") {
    return Boolean(
      youtubeUrl
      && youtubeUrl === normalizePublicYouTubeChannelUrl(history.youtubeUrl)
      && evidenceRef === expected.youtubeHistoryRef,
    );
  }
  if (source === "missing" && evidenceKind === "materialized_missing") {
    return !youtubeUrl && evidenceRef === expected.youtubeHistoryRef;
  }
  return false;
}

function safeProjectionPayload(
  id: string,
  history: Record<string, unknown>,
  nowIso: string,
  source: ColdmailYoutubeProjection["youtubeSource"] = "history_legacy",
): Record<string, unknown> {
  const email = normalizeEmail(history.email ?? history.emailLower);
  const projectedYoutube = youtubeProjection(history.youtubeUrl, source, nowIso);
  return {
    id,
    historyRef: `${HISTORY_COLLECTION}/${id}`,
    projectionVersion: PROJECTION_VERSION,
    programId: resolveCanonicalProgramId(history.programId),
    emailMasked: asString(history.emailMasked, maskEmail(email) ?? ""),
    emailHash: asString(history.emailHash, email ? createHash("sha256").update(email).digest("hex").slice(0, 24) : ""),
    trackingId: asString(history.trackingId),
    conversationId: asString(history.conversationId),
    hasReply: history.hasReply === true,
    sentAtIso: asString(history.sentAtIso),
    ...projectedYoutube,
    ...historyYoutubeScopeEvidence(id, history),
    youtubeEvidenceKind: youtubeEvidenceKindForSource(projectedYoutube.youtubeSource),
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function exactReobservationYoutubeUrl(
  input: ScpColdmailHistoryInput,
  existing: Record<string, unknown>,
  inputCampaign: CampaignScope,
  publicYoutubeUrl: string,
): string {
  if (!publicYoutubeUrl || normalizeEmail(input.email) !== normalizeEmail(existing.email ?? existing.emailLower)) return "";
  const requestedProgramId = asString(input.programId);
  const existingProgram = exactStoredProgramScopeOf(existing);
  const existingCampaign = exactStoredCampaignScopeOf(existing);
  const inputSource = asString(input.source);
  const inputSourceRef = asString(input.sourceRef);
  const existingSourceRef = asString(existing.sourceRef);
  const authoritativeSourceRef = inputSource === "campaign_outreach"
    ? exactCollectionDocumentPath(inputSourceRef, "campaign_outreach")
    : inputSource === "scp_cold_outreach"
      ? exactCollectionDocumentPath(inputSourceRef, "scp_outreach")
      : "";
  if (
    !existingProgram
    || !requestedProgramId
    || resolveCanonicalProgramId(requestedProgramId) !== existingProgram.programId
    || inputCampaign.campaignId !== existingCampaign.campaignId
    || inputCampaign.campaignRef !== existingCampaign.campaignRef
    || !inputSource
    || inputSource !== asString(existing.source)
    || !authoritativeSourceRef
    || inputSourceRef !== existingSourceRef
    || (asString(existing.trackingId) && asString(input.trackingId) !== asString(existing.trackingId))
  ) return "";
  return publicYoutubeUrl;
}

function clearYoutubeMaterializationFields(): Record<string, unknown> {
  return {
    projectionVersion: FieldValue.delete(),
    youtubeUrl: FieldValue.delete(),
    youtubeSource: FieldValue.delete(),
    youtubeValidation: FieldValue.delete(),
    youtubeConfidence: FieldValue.delete(),
    youtubeVerifiedAtIso: FieldValue.delete(),
    youtubeMaterializationVersion: FieldValue.delete(),
    youtubeHistoryScopeHash: FieldValue.delete(),
    youtubeHistoryRef: FieldValue.delete(),
    youtubeProgramId: FieldValue.delete(),
    youtubeProgramRef: FieldValue.delete(),
    youtubeCampaignId: FieldValue.delete(),
    youtubeCampaignRef: FieldValue.delete(),
    youtubeEvidenceKind: FieldValue.delete(),
    youtubeEvidenceRef: FieldValue.delete(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// appendScpColdmailHistory — 발송 이벤트 1건을 append. 절대 붕괴/다운그레이드 금지.
//   같은 trackingId 재관측 시 파생필드(deliveryState/openCount/hasReply)만 merge.
// ─────────────────────────────────────────────────────────────────────────────
export async function appendScpColdmailHistory(input: ScpColdmailHistoryInput, actor: AuthContext): Promise<{ id: string; created: boolean }> {
  const email = normalizeEmail(input.email);
  if (!email) throw new Error("appendScpColdmailHistory requires a recipient email");
  const nowIso = new Date().toISOString();
  const sentAtIso = asString(input.sentAtIso, nowIso);
  const id = coldmailHistoryDocId({ ...input, sentAtIso });
  const ref = adminDb.collection(HISTORY_COLLECTION).doc(id);
  const projectionRef = adminDb.collection(PROJECTION_COLLECTION).doc(id);
  const body = asString(input.body);
  const publicYoutubeUrl = normalizePublicYouTubeChannelUrl(input.youtubeUrl);
  const canonicalProgramId = resolveCanonicalProgramId(asString(input.programId, DEFAULT_PROGRAM_ID));
  const campaignScope = campaignScopeOf(input as Record<string, unknown>, true);

  const transactionResult = await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      // 같은 발송 재관측: 파생 신호만 갱신(append-only 불변식 — 본문/식별자/최초 발송시각 불변).
      const existing = snap.data() ?? {};
      const projectionSnapshot = await tx.get(projectionRef);
      const existingProjection = projectionSnapshot.data() ?? {};
      const existingEmail = normalizeEmail(existing.email ?? existing.emailLower);
      const existingProgramId = resolveCanonicalProgramId(existing.programId);
      const existingPublicYoutubeUrl = normalizePublicYouTubeChannelUrl(existing.youtubeUrl);
      const reobservedPublicYoutubeUrl = exactReobservationYoutubeUrl(
        input,
        existing,
        campaignScope,
        publicYoutubeUrl,
      );
      const priorYoutubeTrusted = projectionSnapshot.exists
        && trustedYoutubeMaterialization(id, existing, existingProjection);
      const authoritativeYoutubePatch: Record<string, unknown> = existingPublicYoutubeUrl
        ? {
          projectionVersion: PROJECTION_VERSION,
          ...historyYoutubeScopeEvidence(id, existing),
          ...youtubeProjection(existingPublicYoutubeUrl, "history_legacy", nowIso),
          youtubeEvidenceKind: youtubeEvidenceKindForSource("history_legacy"),
          youtubeEvidenceRef: ref.path,
        }
        : reobservedPublicYoutubeUrl
          ? {
            projectionVersion: PROJECTION_VERSION,
            ...historyYoutubeScopeEvidence(id, existing),
            ...youtubeProjection(reobservedPublicYoutubeUrl, "send_payload", nowIso),
            youtubeEvidenceKind: youtubeEvidenceKindForSource("send_payload"),
            youtubeEvidenceRef: ref.path,
          }
          : priorYoutubeTrusted
            ? {}
            : clearYoutubeMaterializationFields();
      const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
      if (input.deliveryState) patch.deliveryState = asString(input.deliveryState);
      if (input.conversationId) patch.conversationId = asString(input.conversationId);
      if (input.mailOutboxRef) patch.mailOutboxRef = asString(input.mailOutboxRef);
      // hasReply는 단조(monotonic) — 한번 true면 재관측에서도 되돌리지 않는다(mailSignature.ts 원장과 동일 불변식).
      if (input.hasReply === true) patch.hasReply = true;
      tx.set(ref, patch, { merge: true });
      tx.set(projectionRef, {
        id,
        historyRef: ref.path,
        ...authoritativeYoutubePatch,
        programId: existingProgramId,
        emailMasked: asString(existing.emailMasked, maskEmail(existingEmail) ?? ""),
        emailHash: asString(
          existing.emailHash,
          existingEmail ? createHash("sha256").update(existingEmail).digest("hex").slice(0, 24) : "",
        ),
        ...(input.conversationId ? { conversationId: asString(input.conversationId) } : {}),
        ...(input.hasReply === true ? { hasReply: true } : {}),
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return {
        created: false,
        lifecycleEmail: existingEmail || email,
        lifecycleTrackingId: asString(existing.trackingId, asString(input.trackingId)),
        lifecycleConversationId: asString(input.conversationId, asString(existing.conversationId)),
        sourceUpdatedAtIso: asString(existing.sentAtIso, sentAtIso),
      };
    }
    tx.set(ref, {
      id,
      programId: canonicalProgramId,
      canonicalProgramId,
      programRef: `programs/${canonicalProgramId}`,
      email,
      emailLower: email,
      emailMasked: maskEmail(email),
      emailHash: createHash("sha256").update(email).digest("hex").slice(0, 24),
      koreanName: asString(input.koreanName),
      youtubeUrl: asString(input.youtubeUrl),
      subject: asString(input.subject),
      subjectHash: createHash("sha256").update(asString(input.subject)).digest("hex"),
      body, // 서버측 아웃바운드 본문만 (호출부 책임)
      bodyPreview: bodyPreviewOf(body),
      bodySha256: body ? createHash("sha256").update(body).digest("hex") : "",
      templateKind: asString(input.templateKind),
      templateRef: asString(input.templateRef),
      campaign: campaignScope.campaignId,
      campaignId: campaignScope.campaignId,
      campaignRef: campaignScope.campaignRef,
      source: asString(input.source, "scp_cold_outreach"),
      sourceRef: asString(input.sourceRef),
      draftRef: asString(input.draftRef),
      approvalRef: asString(input.approvalRef),
      approvalRevision: asString(input.approvalRevision),
      compilerVersion: asString(input.compilerVersion),
      templateRevision: asString(input.templateRevision),
      bodyFormat: asString(input.bodyFormat),
      contentHash: asString(input.contentHash),
      compiledHash: asString(input.compiledHash),
      textHash: asString(input.textHash),
      compiledFingerprint: asString(input.compiledFingerprint),
      trackingId: asString(input.trackingId),
      mailOutboxRef: asString(input.mailOutboxRef),
      conversationId: asString(input.conversationId),
      conversationRef: asString(input.conversationRef),
      deliveryState: asString(input.deliveryState, "sent"),
      openCount: 0,
      lastOpenedAtIso: "",
      hasReply: input.hasReply === true,
      sentAtIso,
      createdAtIso: nowIso,
      createdBy: actor.userId,
      createdByRole: actor.role,
      createdByTeam: actor.team,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(projectionRef, {
      ...safeProjectionPayload(id, {
        programId: canonicalProgramId,
        canonicalProgramId,
        programRef: `programs/${canonicalProgramId}`,
        email,
        emailMasked: maskEmail(email),
        emailHash: createHash("sha256").update(email).digest("hex").slice(0, 24),
        youtubeUrl: publicYoutubeUrl,
        campaign: campaignScope.campaignId,
        campaignId: campaignScope.campaignId,
        campaignRef: campaignScope.campaignRef,
        source: asString(input.source, "scp_cold_outreach"),
        sourceRef: asString(input.sourceRef),
        trackingId: input.trackingId,
        conversationId: input.conversationId,
        hasReply: input.hasReply === true,
        sentAtIso,
      }, nowIso, "send_payload"),
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: false });
    return {
      created: true,
      lifecycleEmail: email,
      lifecycleTrackingId: asString(input.trackingId),
      lifecycleConversationId: asString(input.conversationId),
      sourceUpdatedAtIso: sentAtIso,
    };
  });
  await enqueueScpLifecycleRefreshEvent({
    source: "scp_coldmail_history",
    sourceRef: `${HISTORY_COLLECTION}/${id}`,
    reason: transactionResult.created ? "coldmail_history_appended" : "coldmail_history_updated",
    aliases: [{
      email: transactionResult.lifecycleEmail,
      trackingId: transactionResult.lifecycleTrackingId,
      conversationId: transactionResult.lifecycleConversationId,
    }],
    sourceUpdatedAtIso: transactionResult.sourceUpdatedAtIso,
  });

  return { id, created: transactionResult.created };
}

type HistoryRow = Record<string, unknown> & { id: string };

function wantsPii(data: Record<string, unknown>): boolean {
  return data.includePii === true;
}

function assertColdmailHistoryPiiAccess(auth: AuthContext, data: Record<string, unknown>): boolean {
  if (!wantsPii(data)) return false;
  // Raw recipient email is available only for explicit super-admin break-glass access.
  if (auth.role !== "super_admin") {
    const error = new Error("permission-denied: includePii requires super_admin");
    Object.assign(error, { code: "permission-denied", errorCode: "assert_coldmail_history_pii_access_include_pii_requires_super_admin" });
    throw error;
  }
  return true;
}

async function auditColdmailHistoryPiiAccess(
  auth: AuthContext,
  operation: "list" | "export",
  data: Record<string, unknown>,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const seed = [
    operation,
    auth.userId,
    nowIso,
    asString(data.programId),
    normalizeEmail(data.email),
    asString(data.query),
  ].join("\u0000");
  await adminDb.collection(PII_ACCESS_AUDIT_COLLECTION).doc(
    createHash("sha256").update(seed).digest("hex").slice(0, 40),
  ).set({
    operation,
    actor: {
      uid: auth.userId,
      role: auth.role,
      team: auth.team,
      email: auth.email ?? null,
    },
    filters: {
      programId: asString(data.programId),
      campaignId: asString(data.campaignId),
      campaignRef: asString(data.campaignRef),
      emailHash: normalizeEmail(data.email)
        ? createHash("sha256").update(normalizeEmail(data.email)).digest("hex")
        : "",
      queryHash: asString(data.query)
        ? createHash("sha256").update(asString(data.query)).digest("hex")
        : "",
      dateFrom: asString(data.dateFrom),
      dateTo: asString(data.dateTo),
      limit: Number(data.limit ?? LIST_LIMIT_DEFAULT) || LIST_LIMIT_DEFAULT,
    },
    createdAtIso: nowIso,
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

function matchesQuery(row: Record<string, unknown>, q: string): boolean {
  if (!q) return true;
  const hay = [row.emailLower, row.koreanName, row.youtubeUrl, row.subject].map((v) => asString(v).toLowerCase()).join(" ");
  return hay.includes(q.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Reply discovery is a write-path projector. Ordinary list requests never fan out to
// outbound/conversation collections and never mutate the ledger.
export async function projectScpColdmailReplyLink(input: {
  trackingId: string;
  conversationId?: string;
  hasReply?: boolean;
}): Promise<{ updated: number }> {
  const trackingId = asString(input.trackingId);
  if (!trackingId) return { updated: 0 };
  const [historySnapshot, outboundSnapshot] = await Promise.all([
    adminDb.collection(HISTORY_COLLECTION).where("trackingId", "==", trackingId).limit(20).get(),
    adminDb.collection(MAIL_OUTBOUND_LOG_COLLECTION).doc(trackingId).get(),
  ]);
  if (historySnapshot.empty) return { updated: 0 };

  const outbound = outboundSnapshot.data() ?? {};
  const historyConversationId = historySnapshot.docs.map((doc) => asString(doc.data().conversationId)).find(Boolean) ?? "";
  const conversationId = asString(input.conversationId) || asString(outbound.conversationId) || historyConversationId;
  if (!conversationId && input.hasReply !== true && outbound.hasReply !== true) return { updated: 0 };
  let hasReply = input.hasReply === true || outbound.hasReply === true || historySnapshot.docs.some((doc) => doc.data().hasReply === true);
  if (!hasReply && conversationId) {
    const conversationSnapshot = await adminDb.collection("conversations").doc(conversationId).get();
    hasReply = await conversationHasReply(conversationId, conversationSnapshot.data() ?? {});
  }

  const nowIso = new Date().toISOString();
  const batch = adminDb.batch();
  let updated = 0;
  for (const historyDoc of historySnapshot.docs) {
    const existing = historyDoc.data() ?? {};
    const previousConversationId = asString(existing.conversationId);
    const previousHasReply = existing.hasReply === true;
    const conversationChanged = Boolean(conversationId) && conversationId !== previousConversationId;
    const replyChanged = hasReply && !previousHasReply;
    if (!conversationChanged && !replyChanged) continue;
    const patch = {
      ...(conversationChanged ? { conversationId, conversationRef: `conversations/${conversationId}` } : {}),
      ...(replyChanged ? { hasReply: true, replyProjectedAtIso: nowIso } : {}),
      replyProjectionVersion: "scp-coldmail-reply-v1",
      updatedAt: FieldValue.serverTimestamp(),
    };
    batch.set(historyDoc.ref, patch, { merge: true });
    batch.set(adminDb.collection(PROJECTION_COLLECTION).doc(historyDoc.id), {
      id: historyDoc.id,
      historyRef: historyDoc.ref.path,
      projectionVersion: PROJECTION_VERSION,
      ...(conversationChanged ? { conversationId } : {}),
      ...(replyChanged ? { hasReply: true } : {}),
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    updated += 1;
  }
  if (updated > 0) await batch.commit();
  return { updated };
}

type YoutubeCandidate = ColdmailYoutubeProjection & { priority: number; evidenceRef: string };

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function candidateYoutubeUrl(row: Record<string, unknown>): string {
  const applicant = asRecord(row.applicant);
  return asString(row.youtubeUrl)
    || asString(row.channelUrl)
    || asString(row.profileUrl)
    || asString(applicant.youtubeUrl)
    || asString(applicant.channelUrl)
    || asString(applicant.profileUrl);
}

function candidateEmail(row: Record<string, unknown>): string {
  const applicant = asRecord(row.applicant);
  return normalizeEmail(
    asString(row.email)
      || asString(row.emailLower)
      || asString(row.creatorEmail)
      || asString(row.to)
      || asString(applicant.email)
      || asString(applicant.emailLower),
  );
}

function addYoutubeCandidate(
  output: Map<string, YoutubeCandidate>,
  key: string,
  value: unknown,
  source: ColdmailYoutubeProjection["youtubeSource"],
  priority: number,
  nowIso: string,
  evidenceRef: string,
): void {
  if (!key || (output.get(key)?.priority ?? -1) >= priority) return;
  const projected = youtubeProjection(value, source, nowIso, priority / 100);
  if (!projected.youtubeUrl) return;
  output.set(key, { ...projected, priority, evidenceRef });
}

type HistoryYoutubeScope = {
  row: HistoryRow;
  programId: string;
  programRef: string;
  campaignId: string;
  campaignRef: string;
  email: string;
};

function exactCollectionDocumentPath(value: unknown, collection: string): string {
  const path = asString(value);
  const match = /^([A-Za-z0-9_]+)\/([A-Za-z0-9_.:-]{1,180})$/.exec(path);
  if (!match || match[1] !== collection || match[2] === "." || match[2] === "..") return "";
  return path;
}

function exactCanonicalHistoryYoutubeScope(row: HistoryRow): HistoryYoutubeScope | null {
  const program = exactStoredProgramScopeOf(row);
  const campaign = exactStoredCampaignScopeOf(row);
  const email = candidateEmail(row);
  if (
    !program
    || !campaign.campaignId
    || !email
  ) return null;
  return {
    row,
    programId: program.programId,
    programRef: program.programRef,
    campaignId: campaign.campaignId,
    campaignRef: campaign.campaignRef,
    email,
  };
}

function exactScopedRecord(record: Record<string, unknown>, scope: HistoryYoutubeScope): boolean {
  return asString(record.programId) === scope.programId
    && asString(record.canonicalProgramId) === scope.programId
    && asString(record.programRef) === scope.programRef
    && asString(record.campaignId) === scope.campaignId
    && asString(record.campaignRef) === scope.campaignRef;
}

function youtubeScopeKey(scope: HistoryYoutubeScope): string {
  return [scope.programId, scope.campaignId, scope.campaignRef, scope.email].join("\u0000");
}

function campaignOutreachSourcePath(scope: HistoryYoutubeScope): string {
  if (asString(scope.row.source) !== "campaign_outreach") return "";
  return exactCollectionDocumentPath(scope.row.sourceRef, "campaign_outreach");
}

function candidatePoolDocId(value: unknown): string {
  const id = asString(value);
  return /^[A-Za-z0-9_-]{1,180}$/.test(id) ? id : "";
}

function exactCampaignCandidateParticipation(
  record: Record<string, unknown>,
  refPath: string,
  scope: HistoryYoutubeScope,
  candidateId: string,
): boolean {
  const refId = refPath.slice("campaign_candidates/".length);
  return exactScopedRecord(record, scope)
    && asString(record.id) === refId
    && asString(record.campaignCandidateRef) === refPath
    && asString(record.candidateId) === candidateId
    && asString(record.candidateRef) === `candidate_pool/${candidateId}`;
}

function exactCandidateIdentity(
  record: Record<string, unknown>,
  candidateId: string,
  email: string,
): boolean {
  return asString(record.id) === candidateId
    && asString(record.candidateId) === candidateId
    && asString(record.candidateRef) === `candidate_pool/${candidateId}`
    && candidateEmail(record) === email;
}

async function resolveCampaignCandidateYoutubeByHistoryId(
  scopes: HistoryYoutubeScope[],
  nowIso: string,
): Promise<Map<string, YoutubeCandidate>> {
  const output = new Map<string, YoutubeCandidate>();
  const historiesBySourcePath = new Map<string, HistoryYoutubeScope[]>();
  for (const scope of scopes) {
    const sourcePath = campaignOutreachSourcePath(scope);
    if (!sourcePath) continue;
    const group = historiesBySourcePath.get(sourcePath) ?? [];
    group.push(scope);
    historiesBySourcePath.set(sourcePath, group);
  }
  const sourcePaths = Array.from(historiesBySourcePath.keys());
  if (sourcePaths.length === 0) return output;
  const sourceSnapshots = await adminDb.getAll(...sourcePaths.map((path) => adminDb.doc(path)));
  const candidateLinks: Array<{
    scope: HistoryYoutubeScope;
    candidateId: string;
    candidateRef: string;
    participationRef: string;
  }> = [];
  for (const sourceSnapshot of sourceSnapshots) {
    if (!sourceSnapshot.exists) continue;
    const source = sourceSnapshot.data() ?? {};
    const candidateId = candidatePoolDocId(source.candidateId);
    if (!candidateId || asString(source.id) !== sourceSnapshot.id) continue;
    for (const scope of historiesBySourcePath.get(sourceSnapshot.ref.path) ?? []) {
      const expectedCandidateRef = `candidate_pool/${candidateId}`;
      const expectedParticipationRef = campaignCandidateRefFor(scope.programId, scope.campaignId, candidateId);
      if (
        !exactScopedRecord(source, scope)
        || candidateEmail(source) !== scope.email
        || asString(source.candidateRef) !== expectedCandidateRef
        || asString(source.campaignCandidateRef) !== expectedParticipationRef
      ) continue;
      candidateLinks.push({
        scope,
        candidateId,
        candidateRef: expectedCandidateRef,
        participationRef: expectedParticipationRef,
      });
    }
  }
  const participationRefs = Array.from(new Set(candidateLinks.map((link) => link.participationRef)));
  if (participationRefs.length === 0) return output;
  const participationSnapshots = await adminDb.getAll(...participationRefs.map((path) => adminDb.doc(path)));
  const participationByRef = new Map(
    participationSnapshots.filter((snapshot) => snapshot.exists).map((snapshot) => [snapshot.ref.path, snapshot.data() ?? {}]),
  );
  const verifiedLinks = candidateLinks.filter((link) => {
    const participation = participationByRef.get(link.participationRef);
    return Boolean(participation && exactCampaignCandidateParticipation(
      participation,
      link.participationRef,
      link.scope,
      link.candidateId,
    ));
  });
  const candidateRefs = Array.from(new Set(verifiedLinks.map((link) => link.candidateRef)));
  if (candidateRefs.length === 0) return output;
  const candidateSnapshots = await adminDb.getAll(...candidateRefs.map((path) => adminDb.doc(path)));
  const candidateByRef = new Map(
    candidateSnapshots.filter((snapshot) => snapshot.exists).map((snapshot) => [snapshot.ref.path, snapshot.data() ?? {}]),
  );
  for (const link of verifiedLinks) {
    const candidate = candidateByRef.get(link.candidateRef);
    if (!candidate || !exactCandidateIdentity(candidate, link.candidateId, link.scope.email)) continue;
    addYoutubeCandidate(
      output,
      link.scope.row.id,
      candidateYoutubeUrl(candidate),
      "campaign_candidate",
      98,
      nowIso,
      link.participationRef,
    );
  }
  return output;
}

function exactProgramSheetLead(
  record: Record<string, unknown>,
  refPath: string,
  scope: HistoryYoutubeScope,
): boolean {
  const leadId = refPath.slice("program_sheet_leads/".length);
  const declaredLeadId = asString(record.id, asString(record.leadId));
  const declaredLeadRef = asString(record.leadRef);
  const sourceContract = asRecord(record.sourceContract);
  return exactScopedRecord(record, scope)
    && declaredLeadId === leadId
    && (!declaredLeadRef || declaredLeadRef === refPath)
    && (!Object.keys(sourceContract).length || asString(sourceContract.canonicalProgramId) === scope.programId)
    && candidateEmail(record) === scope.email;
}

async function resolveProgramSheetLeadYoutubeByHistoryId(
  scopes: HistoryYoutubeScope[],
  nowIso: string,
): Promise<Map<string, YoutubeCandidate>> {
  const output = new Map<string, YoutubeCandidate>();
  const scopesByKey = new Map<string, HistoryYoutubeScope[]>();
  const scopeKeysByEmail = new Map<string, Set<string>>();
  for (const scope of scopes) {
    const key = youtubeScopeKey(scope);
    const group = scopesByKey.get(key) ?? [];
    group.push(scope);
    scopesByKey.set(key, group);
    const keys = scopeKeysByEmail.get(scope.email) ?? new Set<string>();
    keys.add(key);
    scopeKeysByEmail.set(scope.email, keys);
  }
  const emails = Array.from(new Set(scopes.map((scope) => scope.email)));
  const leadCandidates = new Map<string, YoutubeCandidate>();
  const conflictingKeys = new Set<string>();
  const seenLeadRefs = new Set<string>();
  for (const emailChunk of chunks(emails, LOOKUP_CHUNK_SIZE)) {
    const snapshots = await Promise.all([
      adminDb.collection("program_sheet_leads").where("email", "in", emailChunk).get(),
      adminDb.collection("program_sheet_leads").where("emailLower", "in", emailChunk).get(),
      adminDb.collection("program_sheet_leads").where("applicant.email", "in", emailChunk).get(),
      adminDb.collection("program_sheet_leads").where("applicant.emailLower", "in", emailChunk).get(),
    ]);
    for (const snapshot of snapshots) {
      for (const doc of snapshot.docs) {
        if (seenLeadRefs.has(doc.ref.path)) continue;
        seenLeadRefs.add(doc.ref.path);
        const record = doc.data() ?? {};
        const matchingScopeKeys = scopeKeysByEmail.get(candidateEmail(record)) ?? [];
        for (const key of matchingScopeKeys) {
          const scopedHistories = scopesByKey.get(key) ?? [];
          const scope = scopedHistories[0];
          if (!scope) continue;
          if (!exactProgramSheetLead(record, doc.ref.path, scope)) continue;
          const projected = youtubeProjection(candidateYoutubeUrl(record), "program_sheet_lead", nowIso, 0.95);
          if (!projected.youtubeUrl || conflictingKeys.has(key)) continue;
          const existing = leadCandidates.get(key);
          if (existing && existing.youtubeUrl !== projected.youtubeUrl) {
            leadCandidates.delete(key);
            conflictingKeys.add(key);
            continue;
          }
          leadCandidates.set(key, { ...projected, priority: 95, evidenceRef: doc.ref.path });
        }
      }
    }
  }
  for (const [key, scopedHistories] of scopesByKey) {
    const candidate = conflictingKeys.has(key) ? undefined : leadCandidates.get(key);
    if (!candidate) continue;
    for (const scope of scopedHistories) output.set(scope.row.id, candidate);
  }
  return output;
}

async function resolveYoutubeCandidatesBulk(rows: HistoryRow[], nowIso: string): Promise<Map<string, YoutubeCandidate>> {
  const output = new Map<string, YoutubeCandidate>();
  const scopes = rows.map(exactCanonicalHistoryYoutubeScope).filter((scope): scope is HistoryYoutubeScope => Boolean(scope));
  for (const scope of scopes) {
    addYoutubeCandidate(
      output,
      scope.row.id,
      scope.row.youtubeUrl,
      "history_legacy",
      100,
      nowIso,
      `${HISTORY_COLLECTION}/${scope.row.id}`,
    );
  }
  const unresolvedScopes = scopes.filter((scope) => !output.has(scope.row.id));
  const campaignCandidates = await resolveCampaignCandidateYoutubeByHistoryId(unresolvedScopes, nowIso);
  for (const [historyId, candidate] of campaignCandidates) output.set(historyId, candidate);
  const programSheetLeads = await resolveProgramSheetLeadYoutubeByHistoryId(
    unresolvedScopes.filter((scope) => !output.has(scope.row.id)),
    nowIso,
  );
  for (const [historyId, candidate] of programSheetLeads) output.set(historyId, candidate);
  return output;
}

function inlineConversationHasReply(conversation: Record<string, unknown>): boolean {
  if (asString(conversation.lastMessageFrom) === "creator") return true;
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  return messages.some((message) => asString(asRecord(message).from) === "creator");
}

type ColdmailRebuildCursor = {
  version: typeof REBUILD_CURSOR_VERSION;
  programId: string;
  aliasRegistryRevision: string;
  sentAtIso: string;
  docId: string;
};

function encodeColdmailRebuildCursor(input: Omit<ColdmailRebuildCursor, "version">): string {
  return Buffer.from(JSON.stringify({ version: REBUILD_CURSOR_VERSION, ...input }), "utf8").toString("base64url");
}

function decodeColdmailRebuildCursor(value: unknown): ColdmailRebuildCursor | null {
  const raw = asString(value);
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(raw)) return null;
  try {
    const parsed = asRecord(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    const programId = asString(parsed.programId);
    const aliasRegistryRevision = asString(parsed.aliasRegistryRevision);
    const sentAtIso = asString(parsed.sentAtIso);
    const docId = asString(parsed.docId);
    if (
      parsed.version !== REBUILD_CURSOR_VERSION
      || !programId
      || !aliasRegistryRevision
      || !sentAtIso
      || sentAtIso.length > 80
      || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(docId)
    ) return null;
    return { version: REBUILD_CURSOR_VERSION, programId, aliasRegistryRevision, sentAtIso, docId };
  } catch {
    return null;
  }
}

const REBUILD_PLAN_VERSION = "scp-coldmail-projection-rebuild-plan-v1";
const REBUILD_PROJECTION_SEMANTIC_FIELDS = [
  "id",
  "historyRef",
  "projectionVersion",
  "programId",
  "emailMasked",
  "emailHash",
  "trackingId",
  "conversationId",
  "hasReply",
  "sentAtIso",
  "youtubeUrl",
  "youtubeSource",
  "youtubeValidation",
  "youtubeConfidence",
  "youtubeMaterializationVersion",
  "youtubeHistoryScopeHash",
  "youtubeHistoryRef",
  "youtubeProgramId",
  "youtubeProgramRef",
  "youtubeCampaignId",
  "youtubeCampaignRef",
  "youtubeEvidenceKind",
  "youtubeEvidenceRef",
] as const;

function rebuildProjectionSemantics(row: Record<string, unknown>): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const field of REBUILD_PROJECTION_SEMANTIC_FIELDS) {
    if (field === "hasReply") output[field] = row[field] === true;
    else if (field === "youtubeConfidence") output[field] = Number(row[field]) || 0;
    else output[field] = asString(row[field]);
  }
  return output;
}

function rebuildProjectionChanged(
  current: Record<string, unknown>,
  planned: Record<string, unknown>,
): boolean {
  return JSON.stringify(rebuildProjectionSemantics(current)) !== JSON.stringify(rebuildProjectionSemantics(planned));
}

function coldmailRebuildPlanFingerprint(input: {
  programId: string;
  aliasRegistryRevision: string;
  cursor: string;
  pageSize: number;
  nextCursor: string | null;
  projections: Array<{
    row: HistoryRow;
    conversationId: string;
    hasReply: boolean;
    payload: Record<string, unknown>;
  }>;
}): string {
  return createHash("sha256").update(JSON.stringify({
    version: REBUILD_PLAN_VERSION,
    programId: input.programId,
    aliasRegistryRevision: input.aliasRegistryRevision,
    cursor: input.cursor,
    pageSize: input.pageSize,
    nextCursor: input.nextCursor,
    rows: input.projections.map((item) => ({
      id: item.row.id,
      projection: rebuildProjectionSemantics(item.payload),
      history: {
        conversationId: item.conversationId,
        hasReply: item.hasReply,
      },
    })),
  })).digest("hex");
}

export async function rebuildScpColdmailHistoryProjections(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_coldmail_history.project", ["super_admin", "admin"] as const);
  await assertScpEntitled(auth, request, "scp_coldmail_history.project");
  const data = asRecord(request.data);
  const dryRun = data.dryRun !== false;
  const actual = data.actual === true;
  if (!dryRun && !actual) {
    const error = new Error("failed-precondition: actual projection rebuild requires dryRun:false and actual:true");
    Object.assign(error, { code: "failed-precondition", errorCode: "rebuild_scp_coldmail_history_projections_actual_projection_rebuild" });
    throw error;
  }
  const programScope = await requireExactCanonicalProgramScope(data.programId);
  const pageSize = Math.min(REBUILD_LIMIT_MAX, Math.max(1, Number(data.pageSize ?? data.limit ?? 100) || 100));
  const expectedFingerprint = asString(data.expectedFingerprint);
  if (expectedFingerprint && !/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
    throw callableError("invalid-argument", "expectedFingerprint must be a SHA-256 hex digest from dry-run preview");
  }
  const rawCursor = asString(data.cursor);
  const cursor = rawCursor ? decodeColdmailRebuildCursor(rawCursor) : null;
  if (rawCursor && !cursor) throw callableError("invalid-argument", "cursor is invalid or expired");
  if (cursor && (
    cursor.programId !== programScope.programId
    || cursor.aliasRegistryRevision !== programScope.aliasRegistryRevision
  )) {
    throw callableError("failed-precondition", "cursor does not match the canonical program/alias registry scope");
  }
  let query: Query = adminDb.collection(HISTORY_COLLECTION);
  query = programScope.queryProgramIds.length === 1
    ? query.where("programId", "==", programScope.programId)
    : query.where("programId", "in", programScope.queryProgramIds);
  query = query.orderBy("sentAtIso", "desc").orderBy(FieldPath.documentId(), "desc");
  if (cursor) query = query.startAfter(cursor.sentAtIso, cursor.docId);
  const snapshot = await query.limit(pageSize + 1).get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const hasMore = snapshot.docs.length > pageSize;
  const lastDoc = pageDocs.at(-1);
  const nextCursor = hasMore && lastDoc
    ? encodeColdmailRebuildCursor({
      programId: programScope.programId,
      aliasRegistryRevision: programScope.aliasRegistryRevision,
      sentAtIso: asString(lastDoc.get("sentAtIso")),
      docId: lastDoc.id,
    })
    : null;
  const rows: HistoryRow[] = pageDocs.map((doc) => ({ id: doc.id, ...(doc.data() ?? {}) }));
  const nowIso = new Date().toISOString();
  const [youtubeByHistoryId, existingProjections] = await Promise.all([
    resolveYoutubeCandidatesBulk(rows, nowIso),
    loadColdmailPublicProjections(rows),
  ]);
  const trackingIds = Array.from(new Set(rows.map((row) => asString(row.trackingId)).filter(Boolean)));
  const outboundSnapshots = trackingIds.length > 0
    ? await adminDb.getAll(...trackingIds.map((trackingId) => adminDb.collection(MAIL_OUTBOUND_LOG_COLLECTION).doc(trackingId)))
    : [];
  const outboundByTrackingId = new Map(outboundSnapshots.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data() ?? {}]));
  const conversationIds = Array.from(new Set(rows.map((row) => {
    const outbound = outboundByTrackingId.get(asString(row.trackingId)) ?? {};
    return asString(outbound.conversationId, asString(row.conversationId));
  }).filter(Boolean)));
  const conversationSnapshots = conversationIds.length > 0
    ? await adminDb.getAll(...conversationIds.map((id) => adminDb.collection("conversations").doc(id)))
    : [];
  const conversationById = new Map(conversationSnapshots.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data() ?? {}]));

  const projections = rows.map((row) => {
    const outbound = outboundByTrackingId.get(asString(row.trackingId)) ?? {};
    const conversationId = asString(outbound.conversationId, asString(row.conversationId));
    const hasReply = row.hasReply === true || outbound.hasReply === true || inlineConversationHasReply(conversationById.get(conversationId) ?? {});
    const youtube = youtubeByHistoryId.get(row.id) ?? {
      ...youtubeProjection("", "missing", nowIso),
      priority: 0,
      evidenceRef: `${HISTORY_COLLECTION}/${row.id}`,
    };
    const { priority: _priority, evidenceRef, ...youtubePayload } = youtube;
    const payload = {
      ...safeProjectionPayload(row.id, { ...row, conversationId, hasReply }, nowIso),
      ...youtubePayload,
      youtubeEvidenceKind: youtubeEvidenceKindForSource(youtube.youtubeSource),
      youtubeEvidenceRef: evidenceRef,
    };
    const historyPatch: Record<string, unknown> = {};
    if (conversationId && conversationId !== asString(row.conversationId)) {
      historyPatch.conversationId = conversationId;
      historyPatch.conversationRef = `conversations/${conversationId}`;
    }
    if (hasReply && row.hasReply !== true) historyPatch.hasReply = true;
    return {
      row,
      conversationId,
      hasReply,
      payload,
      historyPatch,
      projectionChanged: rebuildProjectionChanged(existingProjections.get(row.id) ?? {}, payload),
    };
  });
  const replyLinks = projections.filter((item) => item.conversationId || item.hasReply).length;
  const youtubeResolved = projections.filter((item) => asString(item.payload.youtubeUrl)).length;
  const planned = projections.filter((item) => item.projectionChanged || Object.keys(item.historyPatch).length > 0).length;
  const planFingerprint = coldmailRebuildPlanFingerprint({
    programId: programScope.programId,
    aliasRegistryRevision: programScope.aliasRegistryRevision,
    cursor: rawCursor,
    pageSize,
    nextCursor,
    projections,
  });
  if (!dryRun && expectedFingerprint && expectedFingerprint !== planFingerprint) {
    throw callableError("failed-precondition", "projection rebuild plan changed after preview; run dry-run again");
  }
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      scanned: rows.length,
      eligible: projections.length,
      replyLinks,
      youtubeResolved,
      planned,
      updated: 0,
      planFingerprint,
      programId: programScope.programId,
      aliasRegistryRevision: programScope.aliasRegistryRevision,
      pageSize,
      nextCursor,
      complete: nextCursor === null,
    };
  }

  let updated = 0;
  for (const group of chunks(projections, 200)) {
    const batch = adminDb.batch();
    let hasWrites = false;
    for (const item of group) {
      let itemChanged = false;
      if (item.projectionChanged) {
        batch.set(adminDb.collection(PROJECTION_COLLECTION).doc(item.row.id), item.payload, { merge: true });
        hasWrites = true;
        itemChanged = true;
      }
      if (Object.keys(item.historyPatch).length > 0) {
        batch.set(adminDb.collection(HISTORY_COLLECTION).doc(item.row.id), {
          ...item.historyPatch,
          replyProjectionVersion: "scp-coldmail-reply-v1",
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        hasWrites = true;
        itemChanged = true;
      }
      if (itemChanged) updated += 1;
    }
    if (hasWrites) await batch.commit();
  }
  return {
    ok: true,
    dryRun: false,
    scanned: rows.length,
    eligible: projections.length,
    replyLinks,
    youtubeResolved,
    planned,
    updated,
    planFingerprint,
    requestedBy: auth.userId,
    programId: programScope.programId,
    aliasRegistryRevision: programScope.aliasRegistryRevision,
    pageSize,
    nextCursor,
    complete: nextCursor === null,
  };
}

async function loadColdmailPublicProjections(rows: HistoryRow[]): Promise<Map<string, Record<string, unknown>>> {
  if (rows.length === 0) return new Map();
  const snapshots = await adminDb.getAll(...rows.map((row) => adminDb.collection(PROJECTION_COLLECTION).doc(row.id)));
  return new Map(snapshots.filter((snapshot) => snapshot.exists).map((snapshot) => [snapshot.id, snapshot.data() ?? {}]));
}

// A history page is capped at LIST_LIMIT_MAX. Read only its distinct tracking IDs in
// small batches, so the operator view can prefer fresh outbound evidence without a
// collection scan, conversation lookup, or write-back side effect.
async function loadOutboundByTrackingId(rows: HistoryRow[]): Promise<Map<string, Record<string, unknown>>> {
  const trackingIds = Array.from(new Set(rows.map((row) => asString(row.trackingId)).filter(Boolean)));
  const outboundByTrackingId = new Map<string, Record<string, unknown>>();
  for (const trackingIdChunk of chunks(trackingIds, LOOKUP_CHUNK_SIZE)) {
    const snapshots = await adminDb.getAll(
      ...trackingIdChunk.map((trackingId) => adminDb.collection(MAIL_OUTBOUND_LOG_COLLECTION).doc(trackingId)),
    );
    for (const snapshot of snapshots) {
      if (snapshot.exists) outboundByTrackingId.set(snapshot.id, snapshot.data() ?? {});
    }
  }
  return outboundByTrackingId;
}

// ─────────────────────────────────────────────────────────────────────────────
// listScpColdmailHistory — 필터 + newest-first. RBAC super_admin/admin/manager.
// ─────────────────────────────────────────────────────────────────────────────
export async function listScpColdmailHistory(request: CallableRequestShape) {
  // 2026-09-27 codex adversarial review FAIL-2: this returns real scp mailbox content (recipient
  // email/mask, subject, bodyPreview, deliveryState, conversationId) — reachability from the
  // general-purpose Influencer detail page did not make that payload general-purpose data. Now
  // gated the same as exportCsv/rebuildProjections below; the Influencer detail page's
  // CreatorOutreachHistoryCard hides itself for a non-entitled caller instead of calling this.
  const auth = assertNonGuestAuth(request, "scp_coldmail_history.list", READ_ROLES);
  await assertScpEntitled(auth, request, "scp_coldmail_history.list");
  const data = asRecord(request.data);
  const includePii = assertColdmailHistoryPiiAccess(auth, data);
  // 일반 운영 조회는 항상 한 canonical program에 닫혀 있다. 전역 감사 조회가 필요하면
  // 이 endpoint를 넓히지 말고 별도 super_admin-only callable로 설계해야 한다.
  const programScope = await requireExactCanonicalProgramScope(data.programId);
  const programId = programScope.programId;
  const campaignScope = campaignScopeOf(data, false);
  const email = normalizeEmail(data.email);
  const query = asString(data.query);
  const dateFrom = asString(data.dateFrom);
  const dateTo = asString(data.dateTo);
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, Number(data.limit ?? LIST_LIMIT_DEFAULT) || LIST_LIMIT_DEFAULT));

  let ref: Query = adminDb.collection(HISTORY_COLLECTION);
  ref = programScope.queryProgramIds.length === 1
    ? ref.where("programId", "==", programId)
    : ref.where("programId", "in", programScope.queryProgramIds);
  if (email) ref = ref.where("emailLower", "==", email);
  // sentAtIso 문자열(ISO) 범위 — 사전식 정렬 == 시간순.
  if (dateFrom) ref = ref.where("sentAtIso", ">=", dateFrom);
  if (dateTo) ref = ref.where("sentAtIso", "<=", dateTo);
  const snap = await ref.orderBy("sentAtIso", "desc").limit(email || query || campaignScope.campaignId ? 500 : limit).get();

  const rows: HistoryRow[] = (snap.docs ?? [])
    .map((d) => ({ id: d.id, ...(d.data() ?? {}) }))
    .filter((r) => historyBelongsToCampaign(r, campaignScope))
    .filter((r) => matchesQuery(r, query))
    .slice(0, limit);

  const [publicProjections, outboundByTrackingId] = await Promise.all([
    loadColdmailPublicProjections(rows),
    loadOutboundByTrackingId(rows),
  ]);
  if (includePii) await auditColdmailHistoryPiiAccess(auth, "list", data);

  return {
    ok: true,
    rows: rows.map((r) => {
      const projection = publicProjections.get(r.id) ?? {};
      const outbound = outboundByTrackingId.get(asString(r.trackingId)) ?? {};
      const materializationTrusted = trustedYoutubeMaterialization(r.id, r, projection);
      const publicYoutube = materializationTrusted
        ? projection
        : youtubeProjection("", "missing", asString(r.sentAtIso, new Date().toISOString()));
      const rowCampaignScope = storedCampaignScopeOf(r);
      return {
        id: r.id,
        programId,
        // Default API/UI/CSV exposure is masked. Public, format-validated channel URLs are safe
        // for authorized operators; raw recipient email still requires audited break-glass access.
        email: includePii ? asString(r.email) : "",
        emailMasked: asString(r.emailMasked, maskEmail(asString(r.email)) ?? ""),
        koreanName: asString(r.koreanName),
        youtubeUrl: asString(publicYoutube.youtubeUrl),
        youtubeSource: asString(publicYoutube.youtubeSource, "missing"),
        youtubeValidation: asString(publicYoutube.youtubeValidation, "missing"),
        youtubeConfidence: Number(publicYoutube.youtubeConfidence) || 0,
        youtubeVerifiedAtIso: asString(publicYoutube.youtubeVerifiedAtIso),
        youtubeMaterializationVersion: materializationTrusted ? YOUTUBE_MATERIALIZATION_VERSION : "",
        humanMigrationRequired: !materializationTrusted,
        subject: asString(r.subject),
        bodyPreview: asString(r.bodyPreview),
        campaign: rowCampaignScope.campaignId,
        campaignId: rowCampaignScope.campaignId,
        campaignRef: rowCampaignScope.campaignRef,
        source: asString(r.source),
        templateKind: asString(r.templateKind),
        sentAtIso: asString(r.sentAtIso),
        deliveryState: asString(r.deliveryState),
        openCount: Number(r.openCount) || 0,
        hasReply: r.hasReply === true || projection.hasReply === true || outbound.hasReply === true,
        conversationId: asString(outbound.conversationId, asString(projection.conversationId, asString(r.conversationId))),
        createdByRole: asString(r.createdByRole),
      };
    }),
    count: rows.length,
    programId,
    includedPii: includePii,
  };
}

function csvCell(value: unknown): string {
  const s = asString(typeof value === "number" || typeof value === "boolean" ? String(value) : value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// exportScpColdmailHistoryCsv — list와 동일 필터. 전체 본문은 admin/super_admin + includeBody(서버 집행).
// ─────────────────────────────────────────────────────────────────────────────
export async function exportScpColdmailHistoryCsv(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_coldmail_history.export", READ_ROLES);
  await assertScpEntitled(auth, request, "scp_coldmail_history.export");
  const data = asRecord(request.data);
  const includePii = assertColdmailHistoryPiiAccess(auth, data);
  const wantsBody = data.includeBody === true;
  const canFullBody = (FULL_BODY_ROLES as readonly string[]).includes(auth.role);
  const includeBody = wantsBody && canFullBody; // 서버측 RBAC 집행 — manager는 preview만

  const listing = await listScpColdmailHistory(request);
  if (includePii) await auditColdmailHistoryPiiAccess(auth, "export", data);
  // 전체 본문 export는 원본 컬렉션을 한 번의 bulk read로 읽는다(list는 preview만 반환).
  const rows = listing.rows;
  const bodyById = new Map<string, string>();
  if (includeBody && rows.length > 0) {
    const snapshots = await adminDb.getAll(...rows.map((row) => adminDb.collection(HISTORY_COLLECTION).doc(row.id)));
    for (const snapshot of snapshots) bodyById.set(snapshot.id, asString(snapshot.data()?.body));
  }

  const header = [includePii ? "email" : "emailMasked", "koreanName", "youtubeUrl", "humanMigrationRequired", "subject", includeBody ? "body" : "bodyPreview", "sentAtIso", "programId", "campaignId", "campaignRef", "source", "deliveryState", "openCount", "hasReply", "conversationId"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push([
      includePii ? r.email : r.emailMasked, r.koreanName, r.youtubeUrl, r.humanMigrationRequired, r.subject,
      includeBody ? (bodyById.get(r.id) ?? "") : r.bodyPreview,
      r.sentAtIso, r.programId, r.campaignId, r.campaignRef, r.source, r.deliveryState, r.openCount, r.hasReply, r.conversationId,
    ].map(csvCell).join(","));
  }
  const csv = lines.join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);

  return {
    ok: true,
    filename: `coldmail-history-${safeSegment(listing.programId)}-${stamp}.csv`,
    mimeType: "text/csv;charset=utf-8",
    csv,
    rowCount: rows.length,
    includedBody: includeBody,
    includedPii: includePii,
  };
}

export function normalizePublicYouTubeChannelUrl(value: unknown): string {
  const raw = asString(value);
  if (!raw || raw.length > 500) return "";
  const candidate = raw.startsWith("@") ? `https://www.youtube.com/${raw}` : raw;
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    if (url.protocol !== "https:" || hostname !== "youtube.com" || url.username || url.password || url.port) return "";
    const segments = url.pathname.split("/").filter(Boolean);
    let channelPath = "";
    if (segments[0]?.startsWith("@") && segments[0].length > 1) channelPath = `/${segments[0]}`;
    else if ((segments[0] === "channel" || segments[0] === "c" || segments[0] === "user") && segments[1]) {
      channelPath = `/${segments[0]}/${segments[1]}`;
    }
    if (!channelPath || /[\s?#]/.test(channelPath)) return "";
    return `https://www.youtube.com${channelPath}`;
  } catch {
    return "";
  }
}
