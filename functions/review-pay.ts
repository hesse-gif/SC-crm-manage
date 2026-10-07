import crypto from "node:crypto";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { authHeader, getRuntimeIntegration, liveIntegrationsEnabled, publicString, requireEnvSecret, timeoutSignal } from "./liveIntegrations";
import { safeDocId } from "./sheetIntakeService";
import { projectScpApprovedFeed, type ScpApprovedFeedProjectionResult } from "./scpApprovedFeed";
import {
  enqueueScpLifecycleRefreshEvent,
  readScpIdentityConflictAutomationGate,
  type ScpIdentityConflictAutomationReceipt,
} from "./scpLifecycleProfiles";
import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import { resolveProgramApplicationWorkflowIdentityInTransaction } from "./programs";
import {
  assertMutationOwner,
  mutationOwnerUids,
  permissionDenied,
  type MutationAuthorizationActor,
} from "./mutationAuthorization";
import {
  programScopeError,
  resolveAuthoritativeVideoReviewProgramScope,
  sameVideoReviewProgramScope,
  videoReviewProgramScopeKey,
  videoReviewProgramScopeFromTrustedRecords,
  type VideoReviewProgramScope,
} from "./videoReviewProgramScope";
import { isCallerScpEntitled } from "./mailAccounts";
import { canReadConversationRowForScope, resolveConversationMailAccessScope } from "./conversationMailAccessScope";

export type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";
type ReviewStatus = "pending" | "pass" | "revise" | "blocked" | "human_handled";
type DomainReviewSource = "program_application" | "mail_human_review";
type VideoReviewStatus = "pending" | "approved" | "rejected" | "needs_review";
type ReviewReasonCode = "missing_link" | "missing_hashtag" | "brand_mismatch" | "quality_issue" | "approved";
type PaymentStatus = "not_payable" | "payable" | "paid";
type VideoPaymentStatus = "payable" | "paid" | "hold";
type CurrencyCode = "KRW" | "USD";

type CallableRequest = {
  auth?: { uid?: string; token?: { role?: Role; team?: string; email?: string } };
  data?: unknown;
  rawRequest?: { ip?: string };
};

type BehaviorLog = {
  userId: string;
  role: Role;
  team: string;
  gameId: string;
  action: string;
  time: string;
  IP: string;
  result: "allow" | "deny" | "error";
  cost: number;
};

type CacheMeta = { checked: true; hit: boolean; key: string; ttlSeconds: number };
type CostLog = { meter: "firestore" | "revi-api"; tokens: 0; amount: 0; currency: CurrencyCode; reason: string };
type LedgerPageInfo = { pageSize: number; maxRows: number; returned: number; truncated: boolean; nextCursor: string | null };
type LedgerRead = { rows: ReviewLedgerRow[]; pageInfo: LedgerPageInfo };

type ReviewLedgerRow = {
  reviewId: string;
  submissionId: string;
  source?: string;
  creatorId: string;
  gameId: string;
  status: ReviewStatus;
  reasonCode: ReviewReasonCode;
  payableStatus: PaymentStatus;
  amount: number;
  currency: CurrencyCode;
  vatIncluded: boolean;
  reviewer: string;
  paidAt?: string;
};

function isDomainReviewSource(value: unknown): value is DomainReviewSource {
  return value === "program_application" || value === "mail_human_review";
}

const WRITE_ROLES: Role[] = ["super_admin", "admin", "manager"];
const REVIEW_LEDGER_COLLECTION = "review_ledger";
const SCP_FEED_PROJECTION_FAILURES_COLLECTION = "scp_feed_projection_failures";
const LEDGER_PAGE_SIZE = 500;
const MAX_LEDGER_SYNC_ROWS = 5_000;
const LEGACY_SUBMISSION_SCOPE_SCHEMA_VERSION = "scp-public-submission/v1";
const PROGRAM_APPLICATION_REVIEW_IDENTITY_VERSION = "program-application-review/v2";
const PROGRAM_APPLICATION_CONTRACT_IDENTITY_VERSION = "program-application-contract/v2";
// block and human_reply are operator actions on any non-terminal status.
// Terminal statuses (pass, blocked, human_handled) accept no further transitions
// except where noted.  block / human_reply are accepted via the action param, not
// via the normal status transition guard; see updateReviewStatus below.
const STATUS_FLOW: Record<ReviewStatus, ReviewStatus[]> = {
  pending: ["pass", "revise"],
  revise: ["pending", "pass"],
  pass: [],
  blocked: [],
  human_handled: [],
};
const REASON_CODES: ReviewReasonCode[] = ["missing_link", "missing_hashtag", "brand_mismatch", "quality_issue", "approved"];

const REVIEW_LEDGER_SEED: ReviewLedgerRow[] = [
  { reviewId: "r1", submissionId: "s4", creatorId: "c4", gameId: "flu-puzzle", status: "pending", reasonCode: "missing_hashtag", payableStatus: "not_payable", amount: 1500000, currency: "KRW", vatIncluded: true, reviewer: "헤세" },
  { reviewId: "r2", submissionId: "s5", creatorId: "c10", gameId: "flu-midcore", status: "pass", reasonCode: "approved", payableStatus: "paid", amount: 6200000, currency: "KRW", vatIncluded: true, reviewer: "시몬", paidAt: "06-18 14:30" },
  { reviewId: "r3", submissionId: "s3", creatorId: "c6", gameId: "flu-casual", status: "revise", reasonCode: "missing_link", payableStatus: "not_payable", amount: 2800000, currency: "KRW", vatIncluded: true, reviewer: "헤세" },
  { reviewId: "r4", submissionId: "s2", creatorId: "c6", gameId: "flu-casual", status: "pass", reasonCode: "approved", payableStatus: "payable", amount: 2800000, currency: "KRW", vatIncluded: true, reviewer: "헤세" },
  { reviewId: "r-verify-console", submissionId: "s-verify-console", creatorId: "verify-creator", gameId: "flu-verify", status: "pass", reasonCode: "approved", payableStatus: "payable", amount: 1, currency: "KRW", vatIncluded: true, reviewer: "verify-console" },
];

function readObject(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  return {};
}

function now() {
  return new Date().toISOString();
}

function isEmulatorRuntime(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}

// Append-only ledger ids are derived from the *server* clock (not a
// caller-supplied decidedAtIso) plus a random suffix, so two writes can never
// collide onto the same doc and a malicious/duplicate caller cannot target an
// existing row to overwrite it. Combined with transaction.create() this makes
// review_ledger event rows immutable once written.
function serverLedgerId(submissionId: string): string {
  return safeDocId(`${submissionId}:${Date.now()}:${crypto.randomUUID()}`);
}

// Infly validateAmount parity: settlement amounts must be finite and never
// negative. numberValue() already coerces NaN/Infinity to a fallback, so this
// guards against a caller passing an explicit negative payout.
function assertNonNegativeAmount(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("invalid-argument: settlement amount must be a finite value of at least 0");
  }
}

function cacheMeta(key: string): CacheMeta {
  return { checked: true, hit: false, key, ttlSeconds: 300 };
}

function costLog(reason: string, meter: CostLog["meter"] = "firestore"): CostLog {
  return { meter, tokens: 0, amount: 0, currency: "KRW", reason };
}

function behaviorLog(request: CallableRequest, action: string, result: BehaviorLog["result"], gameId = "unknown"): BehaviorLog {
  const role = request.auth?.token?.role ?? "guest";
  return {
    userId: request.auth?.uid ?? "anonymous",
    role,
    team: request.auth?.token?.team ?? "unknown",
    gameId,
    action,
    time: now(),
    IP: request.rawRequest?.ip ?? "0.0.0.0",
    result,
    cost: 0,
  };
}

function requireWriteRole(request: CallableRequest, action: string, gameId?: string) {
  const role = request.auth?.token?.role ?? "guest";
  if (!request.auth?.uid || !WRITE_ROLES.includes(role)) {
    const error = new Error(!request.auth?.uid ? "unauthenticated" : "permission-denied: review/pay writes require super_admin, admin, or manager role");
    return { ok: false as const, error, behaviorLog: behaviorLog(request, action, "deny", gameId) };
  }
  return { ok: true as const, role };
}

// 2026-09-27 codex adversarial review round 4 FAIL-3: updateReviewStatus/recordPayment's video
// submissionId branches mutate scp video review memo/status/payment — role alone (requireWriteRole)
// let any manager/admin change them through this general review-pay callable, bypassing /flu/scp's
// own entitlement gate. Only the video-submissionId branches gate — the reviewId-based ledger
// branches below (block/human_reply/pass/revise/pending, plus the general recordPayment path) stay
// role-only by owner scope decision, since they also serve non-scp review sources
// (isDomainReviewSource: program_application/mail_human_review).
async function assertVideoSubmissionScpEntitled(request: CallableRequest, role: Role, action: string, gameId: string): Promise<void> {
  const scpEntitled = await isCallerScpEntitled(request.auth?.token?.email ?? "", role === "super_admin", {
    userId: request.auth?.uid,
  });
  if (scpEntitled) return;
  throw Object.assign(new Error("permission-denied: scp entitlement required"), {
    code: "permission-denied",
    errorCode: "scp_entitlement_required",
    behaviorLog: behaviorLog(request, action, "deny", gameId),
  });
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid-argument: ${field} is required`);
  return value;
}

export function canonicalReviewStatus<T>(value: T): T | "approved" {
  if (value === "pass" || value === "passed" || value === "approved") return "approved";
  return value;
}

function canonicalReviewStatusText(value: unknown): string {
  const canonical = canonicalReviewStatus(value);
  return typeof canonical === "string" ? canonical : "";
}

function asReviewStatus(value: unknown): ReviewStatus {
  const canonical = canonicalReviewStatus(value);
  if (canonical === "approved") return "pass";
  if (value === "pending" || value === "revise" || value === "blocked" || value === "human_handled") return value;
  throw new Error("invalid-argument: status must be pending, pass, passed, approved, revise, blocked, or human_handled");
}

function asReasonCode(value: unknown, status: ReviewStatus): ReviewReasonCode {
  if (status === "pass") return "approved";
  if (typeof value === "string" && REASON_CODES.includes(value as ReviewReasonCode) && value !== "approved") return value as ReviewReasonCode;
  throw new Error("invalid-argument: revise/pending updates require a sanitized reasonCode");
}

async function ensureSeedLedger() {
  // The demo rows (r1..r4) are mock fixtures carrying fabricated payable/paid
  // amounts. Seeding them into a live project would inject phantom settlement
  // rows into the ledger, so seeding is restricted to the emulator.
  if (!isEmulatorRuntime()) return;
  const snapshot = await adminDb.collection(REVIEW_LEDGER_COLLECTION).limit(1).get();
  if (!snapshot.empty) return;

  const batch = adminDb.batch();
  for (const row of REVIEW_LEDGER_SEED) {
    batch.set(adminDb.collection(REVIEW_LEDGER_COLLECTION).doc(row.reviewId), {
      ...row,
      source: "seed",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();
}

async function findLedgerRow(reviewId: string): Promise<ReviewLedgerRow> {
  await ensureSeedLedger();
  const [ledgerSnapshot, reviewSnapshot] = await Promise.all([
    adminDb.collection(REVIEW_LEDGER_COLLECTION).doc(reviewId).get(),
    adminDb.collection("reviews").doc(reviewId).get(),
  ]);
  if (ledgerSnapshot.exists) {
    const ledger = ledgerSnapshot.data() ?? {};
    const review = reviewSnapshot.data() ?? {};
    return normalizeLedgerRow({
      ...ledger,
      source: text(review.source, 120) || text(ledger.source, 120),
    }, reviewId);
  }
  // Only fall back to the mock seed under the emulator. In a live project the
  // seed rows do not exist, so a reviewId that only matches a mock fixture must
  // not fabricate a row and propagate its stub submissionId/creatorId into the
  // reviews/submissions collections.
  const seed = isEmulatorRuntime() ? REVIEW_LEDGER_SEED.find((item) => item.reviewId === reviewId) : undefined;
  if (seed) return { ...seed };
  // Reviews created by programs.ts (program approval) and chat-ai.ts (mail human
  // review) live only in the `reviews` collection with no review_ledger row.
  // Fall back to that source so 검수 통과/수정 요청 actions and the downstream
  // submission/payment chain stay reachable for them.
  if (reviewSnapshot.exists) return normalizeLedgerRow(reviewSnapshot.data() ?? {}, reviewId);
  throw new Error("not-found: review item does not exist in persisted ledger");
}

async function readLedgerRows(gameId: string): Promise<LedgerRead> {
  await ensureSeedLedger();
  const collection = adminDb.collection(REVIEW_LEDGER_COLLECTION);
  const rows: ReviewLedgerRow[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let truncated = false;
  let nextCursor: string | null = null;

  while (rows.length < MAX_LEDGER_SYNC_ROWS) {
    const remaining = MAX_LEDGER_SYNC_ROWS - rows.length;
    const pageSize = Math.min(LEDGER_PAGE_SIZE, remaining);
    let query = gameId === "all"
      ? collection.orderBy(FieldPath.documentId()).limit(pageSize + 1)
      : collection.where("gameId", "==", gameId).orderBy(FieldPath.documentId()).limit(pageSize + 1);
    if (cursor) query = query.startAfter(cursor);

    const snapshot = await query.get();
    const pageDocs = snapshot.docs.slice(0, pageSize);
    for (const doc of pageDocs) rows.push(normalizeLedgerRow(doc.data(), doc.id));

    const hasMore = snapshot.docs.length > pageSize;
    const lastIncluded = pageDocs.at(-1) ?? null;
    if (!hasMore || !lastIncluded) {
      nextCursor = null;
      break;
    }

    cursor = lastIncluded;
    nextCursor = lastIncluded.id;
    if (rows.length >= MAX_LEDGER_SYNC_ROWS) {
      truncated = true;
      break;
    }
  }

  return {
    rows,
    pageInfo: {
      pageSize: LEDGER_PAGE_SIZE,
      maxRows: MAX_LEDGER_SYNC_ROWS,
      returned: rows.length,
      truncated,
      nextCursor: truncated ? nextCursor : null,
    },
  };
}

function normalizeLedgerRow(row: Record<string, unknown>, fallbackReviewId: string): ReviewLedgerRow {
  const source = text(row.source, 120);
  const canonicalStatus = canonicalReviewStatus(row.status);
  const status = canonicalStatus === "approved"
    ? "pass"
    : row.status === "revise" || row.status === "pending" || row.status === "blocked" || row.status === "human_handled" ? row.status : "pending";
  const payableStatus = row.payableStatus === "paid" || row.payableStatus === "payable" || row.payableStatus === "not_payable" ? row.payableStatus : status === "pass" ? "payable" : "not_payable";
  const currency = row.currency === "USD" ? "USD" : "KRW";
  const reasonCode = row.reasonCode === "approved" || row.reasonCode === "missing_link" || row.reasonCode === "missing_hashtag" || row.reasonCode === "brand_mismatch" || row.reasonCode === "quality_issue"
    ? row.reasonCode
    : status === "pass" ? "approved" : "quality_issue";

  return {
    reviewId: typeof row.reviewId === "string" ? row.reviewId : fallbackReviewId,
    submissionId: isDomainReviewSource(source)
      ? ""
      : typeof row.submissionId === "string" ? row.submissionId : fallbackReviewId,
    source: source || undefined,
    creatorId: typeof row.creatorId === "string" ? row.creatorId : "unknown",
    gameId: typeof row.gameId === "string" ? row.gameId : "flu",
    status,
    reasonCode,
    payableStatus,
    amount: typeof row.amount === "number" && Number.isFinite(row.amount) ? row.amount : 0,
    currency,
    vatIncluded: row.vatIncluded === true,
    reviewer: typeof row.reviewer === "string" ? row.reviewer : "reviewer",
    paidAt: typeof row.paidAt === "string" ? row.paidAt : undefined,
  };
}

type ReviewExtra = {
  blockedAt?: string;
  blockedBy?: string;
  blockReason?: string;
  humanReplyText?: string;
  humanReplyAt?: string;
  humanReplyBy?: string;
};

type VideoPayment = {
  payStatus: VideoPaymentStatus;
  payableAt?: string;
  paidAt?: string;
  amount?: number;
  currency?: CurrencyCode;
  paymentRef?: string;
};

type VideoTransitionResult = {
  submissionId: string;
  reviewId: string;
  creatorId: string;
  leadId: string | null;
  from: VideoReviewStatus;
  to: VideoReviewStatus;
  payment: VideoPayment | null;
  ledgerRef: string;
  scpApprovedFeed: ScpApprovedFeedProjectionResult;
};

const VIDEO_REVIEW_FLOW: Record<VideoReviewStatus, VideoReviewStatus[]> = {
  pending: ["approved", "rejected", "needs_review"],
  needs_review: ["pending", "approved", "rejected"],
  rejected: ["pending", "needs_review", "approved"],
  approved: ["pending", "rejected", "needs_review"],
};

function asVideoReviewStatus(value: unknown): VideoReviewStatus {
  if (value === "pending" || value === "approved" || value === "rejected" || value === "needs_review") return value;
  throw new Error("invalid-argument: status must be pending, approved, rejected, or needs_review for video submissions");
}

function isVideoReviewStatus(value: unknown): value is VideoReviewStatus {
  return value === "pending" || value === "approved" || value === "rejected" || value === "needs_review";
}

function normalizeVideoReviewStatus(value: unknown): VideoReviewStatus {
  const canonical = canonicalReviewStatus(value);
  return isVideoReviewStatus(canonical) ? canonical : "pending";
}

function videoToLegacyStatus(status: VideoReviewStatus): ReviewStatus {
  if (status === "approved") return "pass";
  if (status === "needs_review") return "revise";
  if (status === "rejected") return "blocked";
  return "pending";
}

function videoReasonCode(status: VideoReviewStatus): ReviewReasonCode {
  return status === "approved" ? "approved" : "quality_issue";
}

function asCurrency(value: unknown): CurrencyCode {
  return value === "USD" ? "USD" : "KRW";
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown, max = 2000): string {
  if (typeof value === "string") return value.trim().slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, max);
  return "";
}

function reviewApplicationId(record: Record<string, unknown>): string {
  const directIds = [
    record.applicationId,
    record.programApplicationId,
    record.bridgedApplicationId,
  ].map((value) => text(value, 500));
  const referencedIds = [
    record.applicationRef,
    record.programApplicationRef,
    record.bridgedApplicationRef,
  ].map((value) => /^program_applications\/([^/]+)$/.exec(text(value, 1000))?.[1] ?? "");
  const candidates = [...new Set([...directIds, ...referencedIds].filter(Boolean))];
  if (candidates.length > 1 || candidates.some((value) => value.includes("/"))) {
    throw programScopeError("video_review_program_scope_ambiguous");
  }
  return candidates[0] ?? "";
}

function hasDeclaredValue(value: unknown): boolean {
  return value !== null && value !== undefined && (typeof value !== "string" || value.trim().length > 0);
}

export function explicitLegacySubmissionScopeFallbackEligible(submission: Record<string, unknown>): boolean {
  const authoritativeReferenceFields = [
    "taskRef", "taskId", "submissionTaskRef", "submissionTaskId",
    "leadRef", "leadId",
    "applicationRef", "applicationId", "programApplicationRef", "programApplicationId",
    "bridgedApplicationRef", "bridgedApplicationId",
  ];
  if (authoritativeReferenceFields.some((field) => hasDeclaredValue(submission[field]))) return false;
  const explicitLegacySource = text(submission.source, 120) === "scp_public_submission_form";
  const explicitLegacyVersion = text(submission.schemaVersion, 120) === LEGACY_SUBMISSION_SCOPE_SCHEMA_VERSION
    || text(submission.sourceVersion, 120) === "1";
  return explicitLegacySource && explicitLegacyVersion;
}

function requireExplicitLegacySubmissionScope(
  submission: Record<string, unknown>,
  scope: VideoReviewProgramScope,
): VideoReviewProgramScope {
  if (scope.legacyScpFallback && !explicitLegacySubmissionScopeFallbackEligible(submission)) {
    throw programScopeError("video_review_program_scope_unresolved");
  }
  return scope;
}

function legacySubmissionProgramScopeOrThrow(
  submission: Record<string, unknown>,
  error: unknown,
): VideoReviewProgramScope {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code !== "video_review_program_scope_unresolved" || !explicitLegacySubmissionScopeFallbackEligible(submission)) {
    throw error;
  }
  return requireExplicitLegacySubmissionScope(
    submission,
    videoReviewProgramScopeFromTrustedRecords(
      { submission },
      { legacyScpFallback: false },
    ),
  );
}

function reviewMutationActor(request: CallableRequest): MutationAuthorizationActor {
  return {
    uid: text(request.auth?.uid, 180),
    role: request.auth?.token?.role ?? "guest",
  };
}

function cleanApplicationIdFromMutationRecord(record: Record<string, unknown>): string {
  return reviewApplicationId(record);
}

function programIdsFromMutationRecord(record: Record<string, unknown>): string[] {
  return [record.canonicalProgramId, record.programId]
    .map((value) => text(value, 180))
    .filter(Boolean);
}

async function assertReviewMutationAuthorized(
  transaction: FirebaseFirestore.Transaction,
  request: CallableRequest,
  input: {
    records: Array<Record<string, unknown> | null | undefined>;
    expectedCanonicalProgramId?: string;
    expectedApplicationId?: string;
  },
): Promise<void> {
  const actor = reviewMutationActor(request);
  if (actor.role === "super_admin" || actor.role === "admin") return;
  const records = input.records.filter((record): record is Record<string, unknown> => Boolean(record));
  const applicationIds = [...new Set([
    text(input.expectedApplicationId, 500),
    ...records.map(cleanApplicationIdFromMutationRecord),
  ].filter(Boolean))];
  if (applicationIds.length > 1) throw permissionDenied("review mutation application ownership is ambiguous");

  const applicationSnapshot = applicationIds[0]
    ? await transaction.get(adminDb.collection("program_applications").doc(applicationIds[0]))
    : null;
  if (applicationIds[0] && !applicationSnapshot?.exists) {
    throw permissionDenied("review mutation application ownership is unavailable");
  }
  const application = applicationSnapshot?.exists ? (applicationSnapshot.data() ?? {}) : null;

  const rawProgramIds = [
    text(input.expectedCanonicalProgramId, 180),
    ...records.flatMap(programIdsFromMutationRecord),
    ...programIdsFromMutationRecord(application ?? {}),
  ].filter(Boolean);
  const canonicalProgramIds = [...new Set(rawProgramIds.map((value) => resolveCanonicalProgramId(value)).filter(Boolean))];
  if (canonicalProgramIds.length !== 1) {
    throw permissionDenied("review mutation program ownership is missing or ambiguous");
  }
  const canonicalProgramId = canonicalProgramIds[0];
  if (input.expectedCanonicalProgramId
    && resolveCanonicalProgramId(input.expectedCanonicalProgramId) !== canonicalProgramId) {
    throw permissionDenied("review mutation program scope changed");
  }

  const programDocIds = [...new Set([
    canonicalProgramId,
    ...rawProgramIds,
    ...(canonicalProgramId === SCP_CANONICAL_PROGRAM_ID ? ["scp"] : []),
  ].filter(Boolean))];
  if (programDocIds.some((programId) => programId.includes("/"))) {
    throw permissionDenied("review mutation program identity is invalid");
  }
  const programSnapshots = [] as FirebaseFirestore.DocumentSnapshot[];
  for (const programId of programDocIds) {
    const snapshot = await transaction.get(adminDb.collection("programs").doc(programId));
    if (snapshot.exists) programSnapshots.push(snapshot);
  }
  if (programSnapshots.length === 0) {
    throw permissionDenied("review mutation program ownership is unavailable");
  }

  assertMutationOwner(
    actor,
    programSnapshots.flatMap((snapshot) => mutationOwnerUids(snapshot.data() ?? {}, { includeCreatedBy: true })),
    "review/payment program",
  );
  if (application) {
    assertMutationOwner(actor, mutationOwnerUids(application), "review/payment application");
  }
}

export function videoReviewIdentityDocId(input: {
  canonicalProgramId: string;
  applicationId: string;
  leadId: string;
  creatorId: string;
  submissionId: string;
}): string {
  return safeDocId([
    "review",
    input.canonicalProgramId,
    input.applicationId || "legacy",
    input.leadId || input.creatorId || "unknown",
    input.submissionId,
  ].join(":"));
}

function exactApplicationScopedRecord(
  collection: string,
  record: Record<string, unknown>,
  exactApplicationId: string,
): Record<string, unknown> {
  // Once the immutable submission names an exact application, a shared lead's
  // reverse application/program mirrors are compatibility data, not authority.
  if (collection === "program_sheet_leads" && exactApplicationId) {
    return { id: record.id };
  }
  return record;
}

function videoReviewDecisionRef(value: unknown): string {
  const ref = text(value, 500);
  return /^video_review_(?:multimodal_)?decisions\/[A-Za-z0-9:._-]+$/.test(ref) ? ref : "";
}

function authoritativeVideoReviewDecisionRef(
  submission: Record<string, unknown>,
  scope: Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash">,
): string {
  const projections = readObject(submission.videoReviewByScope);
  const projection = readObject(projections[videoReviewProgramScopeKey(scope)]);
  const textProjection = readObject(projection.text);
  return videoReviewDecisionRef(textProjection.latestVideoReviewDecisionRef)
    || videoReviewDecisionRef(submission.latestVideoReviewDecisionRef);
}

type ExpectedVideoReviewProgramScope = Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash">;

function expectedVideoReviewProgramScope(data: Record<string, unknown>): ExpectedVideoReviewProgramScope | null {
  const canonicalProgramId = text(data.expectedCanonicalProgramId, 180);
  const policyConfigHash = text(data.expectedPolicyConfigHash, 128);
  if (!canonicalProgramId && !policyConfigHash) return null;
  if (!canonicalProgramId || !/^[a-f0-9]{64}$/.test(policyConfigHash)) {
    throw programScopeError("video_review_program_scope_changed");
  }
  return { canonicalProgramId, policyConfigHash };
}

function reviewNoteFrom(
  data: Record<string, unknown>,
  from: VideoReviewStatus,
  to: VideoReviewStatus,
  decidedBy: string,
  decidedAtIso: string,
  trustedDecisionRef: string | null,
) {
  const reasonText = text(data.reasonText ?? data.reason ?? data.rejectedReason, 4000);
  const feedbackText = text(data.feedbackText ?? data.feedback ?? data.reviewMemo, 8000);
  const source = data.source === "flu_video_review_human" ? "flu_video_review_human" : "flu_video_review_transition";
  return {
    source,
    decision: to,
    from,
    to,
    reasonText,
    feedbackText,
    decidedBy,
    decisionRef: trustedDecisionRef,
    createdAt: decidedAtIso,
    createdAtIso: decidedAtIso,
  };
}

function normalizePayment(value: unknown): VideoPayment | null {
  const data = readObject(value);
  const status = data.payStatus === "paid" || data.payStatus === "payable" || data.payStatus === "hold" ? data.payStatus : null;
  if (!status) return null;
  return {
    payStatus: status,
    payableAt: text(data.payableAt, 80) || undefined,
    paidAt: text(data.paidAt, 80) || undefined,
    amount: numberValue(data.amount, 0),
    currency: asCurrency(data.currency),
    paymentRef: text(data.paymentRef, 240) || undefined,
  };
}

function paymentSnapshot(payment: VideoPayment | null) {
  return payment
    ? {
      payStatus: payment.payStatus,
      payableAt: payment.payableAt ?? null,
      paidAt: payment.paidAt ?? null,
      amount: payment.amount ?? 0,
      currency: payment.currency ?? "KRW",
      paymentRef: payment.paymentRef ?? null,
    }
    : { payStatus: "not_payable", payableAt: null, paidAt: null, amount: 0, currency: "KRW", paymentRef: null };
}

async function enqueueReviewLifecycleRefresh(input: {
  ledgerRef: string;
  submissionId: string;
  creatorId: string;
  leadId?: string | null;
  videoRef?: string | null;
  videoId?: string | null;
  reason: string;
  sourceUpdatedAtIso: string;
}) {
  const aliases = [{
    submissionId: input.submissionId,
    creatorId: input.creatorId,
    leadId: input.leadId ?? "",
    videoId: input.videoId ?? "",
  }];
  await enqueueScpLifecycleRefreshEvent({
    source: "review_ledger",
    sourceRef: input.ledgerRef,
    reason: input.reason,
    aliases,
    sourceUpdatedAtIso: input.sourceUpdatedAtIso,
  });
  await enqueueScpLifecycleRefreshEvent({
    source: "submissions",
    sourceRef: `submissions/${input.submissionId}`,
    reason: `${input.reason}_submission_updated`,
    aliases,
    sourceUpdatedAtIso: input.sourceUpdatedAtIso,
  });
  if (input.videoRef) {
    await enqueueScpLifecycleRefreshEvent({
      source: "videos",
      sourceRef: input.videoRef,
      reason: `${input.reason}_approved_feed_projected`,
      aliases,
      sourceUpdatedAtIso: input.sourceUpdatedAtIso,
    });
  }
}

function countDeltas(from: VideoReviewStatus, to: VideoReviewStatus, previousPayment: VideoPayment | null, nextPayment: VideoPayment | null, countPreviousStatus: boolean): Record<string, Record<string, FieldValue>> {
  const statusDeltas: Record<string, number> = {};
  const paymentDeltas: Record<string, number> = {};
  const add = (bucket: Record<string, number>, key: string, amount: number) => {
    if (!amount) return;
    bucket[key] = (bucket[key] ?? 0) + amount;
  };
  if (from !== to) {
    if (countPreviousStatus) add(statusDeltas, from, -1);
    add(statusDeltas, to, 1);
  }
  const previousPayStatus = previousPayment?.payStatus ?? "not_payable";
  const nextPayStatus = nextPayment?.payStatus ?? "not_payable";
  if (previousPayStatus !== nextPayStatus) {
    if (countPreviousStatus) add(paymentDeltas, previousPayStatus, -1);
    add(paymentDeltas, nextPayStatus, 1);
  }
  return {
    ...(Object.keys(statusDeltas).length ? { statuses: Object.fromEntries(Object.entries(statusDeltas).map(([key, value]) => [key, FieldValue.increment(value)])) } : {}),
    ...(Object.keys(paymentDeltas).length ? { payments: Object.fromEntries(Object.entries(paymentDeltas).map(([key, value]) => [key, FieldValue.increment(value)])) } : {}),
  };
}

type ReviewRowCas = Pick<ReviewLedgerRow, "submissionId" | "creatorId" | "status" | "reasonCode" | "payableStatus">;

type ReviewPersistenceResult = {
  kind: "submission_backed" | DomainReviewSource;
  idempotent: boolean;
  automationGate?: ScpIdentityConflictAutomationReceipt;
};

function reviewRowCas(row: ReviewLedgerRow): ReviewRowCas {
  return {
    submissionId: row.submissionId,
    creatorId: row.creatorId,
    status: row.status,
    reasonCode: row.reasonCode,
    payableStatus: row.payableStatus,
  };
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(`failed-precondition: ${message}`), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}

function exactDomainDocumentId(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 500
    || value.trim() !== value
    || value.includes("/")) {
    throw failedPrecondition(`${label} is missing or invalid`);
  }
  return value;
}

function exactOptionalLinkString(value: unknown, label: string, maxLength: number): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.trim() !== value || value.length > maxLength) {
    throw failedPrecondition(`${label} is not an exact string`);
  }
  return value;
}

function programApplicationReviewId(applicationId: string): string {
  return `review-application-${applicationId}`;
}

function exactReviewMembershipIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw failedPrecondition("mail conversation review membership is not an array");
  }
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string"
      || item.length === 0
      || item.length > 500
      || item.trim() !== item
      || item.includes("/")) {
      throw failedPrecondition("mail conversation review membership contains a non-canonical string id");
    }
    ids.push(item);
  }
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length !== ids.length) {
    throw failedPrecondition("mail conversation review membership contains duplicate ids");
  }
  return uniqueIds;
}

function assertSameDeclaredIdentity(
  review: Record<string, unknown>,
  domain: Record<string, unknown>,
  field: string,
  label: string,
) {
  const reviewValue = text(review[field], 500);
  const domainValue = text(domain[field], 500);
  if (reviewValue && domainValue && reviewValue !== domainValue) {
    throw failedPrecondition(`${label} changed before mutation commit`);
  }
}

function domainReviewDecisionMatches(
  review: Record<string, unknown>,
  row: ReviewLedgerRow,
  extra: ReviewExtra | undefined,
): boolean {
  const current = normalizeLedgerRow(review, row.reviewId);
  if (current.status !== row.status || current.reasonCode !== row.reasonCode) return false;
  if (extra?.blockedAt) {
    return text(review.blockReason, 4000) === text(extra.blockReason, 4000)
      && text(review.blockedBy, 180) === text(extra.blockedBy, 180);
  }
  if (extra?.humanReplyAt) {
    return text(review.humanReplyText, 8000) === text(extra.humanReplyText, 8000)
      && text(review.humanReplyBy, 180) === text(extra.humanReplyBy, 180);
  }
  return true;
}

function domainReviewRecordProjectionMatches(
  review: Record<string, unknown>,
  row: ReviewLedgerRow,
  extra: ReviewExtra | undefined,
  automationGate: ScpIdentityConflictAutomationReceipt | null,
): boolean {
  const canonicalStatus = canonicalReviewStatusText(row.status);
  return canonicalReviewStatusText(review.reviewStatus) === canonicalStatus
    && review.payableStatus === "not_payable"
    && text(review.reviewedBy, 180) === text(
      extra?.blockedBy ?? extra?.humanReplyBy ?? row.reviewer,
      180,
    )
    && identityAutomationGateProjectionMatches(review, automationGate);
}

function identityAutomationGateProjectionMatches(
  record: Record<string, unknown>,
  automationGate: ScpIdentityConflictAutomationReceipt | null,
): boolean {
  if (!automationGate) return record.automationBlocked !== true;
  const projected = readObject(record.automationGate);
  const sourceRefs = Array.isArray(projected.sourceRefs)
    ? projected.sourceRefs.map((value) => text(value, 1000)).filter(Boolean).sort()
    : [];
  return record.automationBlocked === true
    && text(record.automationBlockReasonCode, 120) === automationGate.reasonCode
    && text(record.canonicalIdentityHash, 120) === automationGate.canonicalIdentityHash
    && text(projected.resolutionState, 120) === automationGate.resolutionState
    && JSON.stringify(sourceRefs) === JSON.stringify(automationGate.sourceRefs);
}

function domainReviewProjectionMatches(
  source: DomainReviewSource,
  review: Record<string, unknown>,
  domain: Record<string, unknown>,
  row: ReviewLedgerRow,
  extra: ReviewExtra | undefined,
  automationGate: ScpIdentityConflictAutomationReceipt | null,
): boolean {
  if (!domainReviewRecordProjectionMatches(review, row, extra, automationGate)) return false;
  const canonicalStatus = canonicalReviewStatusText(row.status);
  if (source === "program_application") {
    return text(domain.reviewId, 500) === row.reviewId
      && canonicalReviewStatusText(domain.reviewStatus) === canonicalStatus
      && text(domain.reviewReasonCode, 120) === row.reasonCode
      && identityAutomationGateProjectionMatches(domain, automationGate)
      && (!automationGate
        || (domain.resultMailEligibility === "blocked"
          && text(domain.resultMailEligibilityReasonCode, 120) === automationGate.reasonCode));
  }
  const expectedAutoReplyStatus = automationGate
    ? "blocked"
    : row.status === "blocked"
      ? "blocked"
      : row.status === "revise" || row.status === "pending" ? "waiting_for_human" : "human_handled";
  return text(domain.reviewId, 500) === row.reviewId
    && domain.humanReviewStatus === row.status
    && canonicalReviewStatusText(domain.reviewStatus) === canonicalStatus
    && text(domain.humanReviewReasonCode, 120) === row.reasonCode
    && domain.autoReplyStatus === expectedAutoReplyStatus
    && identityAutomationGateProjectionMatches(domain, automationGate);
}

function identityAutomationGatePatch(
  automationGate: ScpIdentityConflictAutomationReceipt | null,
): Record<string, unknown> {
  if (!automationGate) {
    return {
      automationBlocked: false,
      automationBlockReasonCode: FieldValue.delete(),
      automationGate: FieldValue.delete(),
      canonicalIdentityHash: FieldValue.delete(),
      identityConflictSourceRefs: FieldValue.delete(),
    };
  }
  return {
    automationBlocked: true,
    automationBlockReasonCode: automationGate.reasonCode,
    automationGate,
    canonicalIdentityHash: automationGate.canonicalIdentityHash,
    identityConflictSourceRefs: automationGate.sourceRefs,
  };
}

function domainReviewPatches(
  source: DomainReviewSource,
  row: ReviewLedgerRow,
  updatedAtIso: string,
  reviewer: string,
  extra: ReviewExtra | undefined,
  automationGate: ScpIdentityConflictAutomationReceipt | null,
): {
  review: Record<string, unknown>;
  domain: Record<string, unknown>;
} {
  const canonicalStatus = canonicalReviewStatusText(row.status);
  const reviewPatch: Record<string, unknown> = {
    status: row.status,
    reviewStatus: canonicalStatus,
    reasonCode: row.reasonCode,
    payableStatus: "not_payable",
    payableAmountKRW: 0,
    paidAt: null,
    reviewer,
    reviewedBy: reviewer,
    reviewedAtIso: updatedAtIso,
    updatedAtIso,
    transitionedAt: FieldValue.serverTimestamp(),
    ...(extra ?? {}),
    ...identityAutomationGatePatch(automationGate),
  };
  if (source === "program_application") {
    return {
      review: reviewPatch,
      domain: {
        reviewId: row.reviewId,
        reviewStatus: canonicalStatus,
        reviewActionStatus: row.status,
        reviewReasonCode: row.reasonCode,
        reviewedBy: reviewer,
        reviewedAtIso: updatedAtIso,
        resultMailEligibility: automationGate ? "blocked" : FieldValue.delete(),
        resultMailEligibilityReasonCode: automationGate?.reasonCode ?? FieldValue.delete(),
        ...identityAutomationGatePatch(automationGate),
        updatedAtIso,
      },
    };
  }

  const autoReplyStatus = automationGate
    ? "blocked"
    : row.status === "blocked"
      ? "blocked"
      : row.status === "revise" || row.status === "pending" ? "waiting_for_human" : "human_handled";
  const conversationPatch: Record<string, unknown> = {
    reviewId: row.reviewId,
    reviewStatus: canonicalStatus,
    humanReviewStatus: row.status,
    humanReviewReasonCode: row.reasonCode,
    humanReviewUpdatedBy: reviewer,
    humanReviewUpdatedAtIso: updatedAtIso,
    autoReplyStatus,
    ...identityAutomationGatePatch(automationGate),
    updatedAtIso,
  };
  if (automationGate) {
    conversationPatch.autoReplyBlockedReason = automationGate.reasonCode;
  } else if (row.status === "blocked") {
    conversationPatch.autoReplyBlockedReason = text(extra?.blockReason, 4000) || "운영자 차단";
  } else if (row.status === "pass" || row.status === "human_handled") {
    conversationPatch.autoReplyBlockedReason = FieldValue.delete();
  }
  if (row.status === "human_handled") {
    conversationPatch.humanReplyText = text(extra?.humanReplyText, 8000);
    conversationPatch.humanReplyAt = updatedAtIso;
    conversationPatch.humanReplyBy = reviewer;
  }
  return { review: reviewPatch, domain: conversationPatch };
}

async function persistDomainReviewRow(
  transaction: FirebaseFirestore.Transaction,
  request: CallableRequest,
  source: DomainReviewSource,
  reviewRef: FirebaseFirestore.DocumentReference,
  review: Record<string, unknown>,
  row: ReviewLedgerRow,
  expected: ReviewRowCas,
  updatedAtIso: string,
  paymentRef: string | undefined,
  extra: ReviewExtra | undefined,
): Promise<ReviewPersistenceResult> {
  if (paymentRef) throw failedPrecondition(`${source} reviews cannot enter the payment ledger`);
  if (text(review.id, 500) && text(review.id, 500) !== row.reviewId) {
    throw failedPrecondition("review identity changed before mutation commit");
  }

  row.payableStatus = "not_payable";
  row.paidAt = undefined;
  const reviewer = text(request.auth?.uid, 180) || "unknown";
  let domainRef: FirebaseFirestore.DocumentReference;
  let domain: Record<string, unknown>;
  let domainReviewIsActive = true;
  let automationGate: ScpIdentityConflictAutomationReceipt | null = null;

  if (source === "program_application") {
    const originalReviewId = row.reviewId;
    const applicationId = exactDomainDocumentId(reviewApplicationId(review), "program application identity");
    domainRef = adminDb.collection("program_applications").doc(applicationId);
    const applicationSnapshot = await transaction.get(domainRef);
    if (!applicationSnapshot.exists) throw failedPrecondition("program application does not exist");
    domain = applicationSnapshot.data() ?? {};
    if (text(domain.status, 120) !== "approved" || domain.participationActive !== true) {
      throw failedPrecondition("program application is not approved and active for review action");
    }
    if (text(domain.reviewId, 500) !== row.reviewId) {
      throw failedPrecondition("program application review link changed");
    }
    assertSameDeclaredIdentity(review, domain, "creatorId", "program review creator identity");
    const canonicalProgramId = resolveCanonicalProgramId(
      text(review.canonicalProgramId, 180)
        || text(review.programId, 180)
        || text(domain.canonicalProgramId, 180)
        || text(domain.programId, 180),
    );
    const creatorId = exactDomainDocumentId(
      text(domain.creatorId, 180) || text(review.creatorId, 180),
      "program review creator identity",
    );
    if (!canonicalProgramId) throw failedPrecondition("program review program identity is missing");
    await assertReviewMutationAuthorized(transaction, request, {
      records: [review, domain],
      expectedApplicationId: applicationId,
      expectedCanonicalProgramId: canonicalProgramId,
    });
    automationGate = await readScpIdentityConflictAutomationGate({
      programId: canonicalProgramId,
      aliases: [
        { kind: "leadId", value: domain.leadId },
        { kind: "leadId", value: review.leadId },
        { kind: "creatorId", value: creatorId },
        { kind: "channelId", value: domain.channelId },
        { kind: "channelId", value: domain.youtubeChannelId },
        { kind: "channelId", value: review.channelId },
        { kind: "email", value: domain.email },
        { kind: "email", value: domain.creatorEmail },
        { kind: "email", value: review.email },
        { kind: "email", value: review.creatorEmail },
        { kind: "conversationId", value: domain.conversationId },
        { kind: "conversationId", value: review.conversationId },
      ],
    }, transaction);

    const current = normalizeLedgerRow(review, originalReviewId);
    const decisionMatches = domainReviewDecisionMatches(review, row, extra);
    if (!decisionMatches) {
      if (current.status === row.status || current.status === "pass" || current.status === "blocked" || current.status === "human_handled") {
        throw failedPrecondition(`review ${current.status} already has a different terminal or replay payload`);
      }
      if (current.submissionId !== expected.submissionId
        || current.creatorId !== expected.creatorId
        || current.status !== expected.status
        || current.reasonCode !== expected.reasonCode
        || current.payableStatus !== expected.payableStatus) {
        throw failedPrecondition("review changed before mutation commit");
      }
    }

    const expectedReviewId = programApplicationReviewId(applicationId);
    const legacyIdentity = originalReviewId !== expectedReviewId
      || text(domain.reviewIdentityVersion, 120) !== PROGRAM_APPLICATION_REVIEW_IDENTITY_VERSION
      || text(domain.contractId, 500) !== `contract-application-${applicationId}`
      || text(domain.contractIdentityVersion, 120) !== PROGRAM_APPLICATION_CONTRACT_IDENTITY_VERSION;
    row.reviewId = expectedReviewId;
    const patches = domainReviewPatches(source, row, updatedAtIso, reviewer, extra, automationGate);
    const workflowIdentity = await resolveProgramApplicationWorkflowIdentityInTransaction(transaction, {
      applicationRef: domainRef,
      application: domain,
      canonicalProgramId,
      creatorId,
      nowIso: updatedAtIso,
      reviewPatchOnMigration: patches.review,
      contractPatchOnMigration: {
        participationActive: true,
        participationStatus: "active",
        participationStage: "contract",
        participationUpdatedAtIso: updatedAtIso,
        retractedAtIso: FieldValue.delete(),
        updatedAtIso,
      },
    });
    if (!workflowIdentity.reviewExists || !workflowIdentity.contractExists) {
      throw failedPrecondition("linked program workflow artifact is missing");
    }
    if (!legacyIdentity
      && text(workflowIdentity.review?.reviewIdentityVersion, 120) !== PROGRAM_APPLICATION_REVIEW_IDENTITY_VERSION) {
      throw failedPrecondition("program review identity version changed before mutation commit");
    }
    if (!legacyIdentity
      && decisionMatches
      && domainReviewProjectionMatches(source, workflowIdentity.review ?? review, domain, row, extra, automationGate)) {
      if (extra?.blockedAt) extra.blockedAt = text(review.blockedAt, 80) || extra.blockedAt;
      if (extra?.humanReplyAt) extra.humanReplyAt = text(review.humanReplyAt, 80) || extra.humanReplyAt;
      return { kind: source, idempotent: true, ...(automationGate ? { automationGate } : {}) };
    }
    if (!workflowIdentity.reviewCreatedByMigration) {
      transaction.set(workflowIdentity.reviewRef, patches.review, { merge: true });
    }
    transaction.set(domainRef, {
      ...workflowIdentity.applicationPatch,
      ...patches.domain,
    }, { merge: true });
    return { kind: source, idempotent: false, ...(automationGate ? { automationGate } : {}) };
  } else {
    const conversationId = exactDomainDocumentId(review.conversationId, "mail conversation identity");
    domainRef = adminDb.collection("conversations").doc(conversationId);
    const conversationSnapshot = await transaction.get(domainRef);
    if (!conversationSnapshot.exists) throw failedPrecondition("mail conversation does not exist");
    domain = conversationSnapshot.data() ?? {};
    const declaredConversationRef = exactOptionalLinkString(review.conversationRef, "mail review conversation ref", 1000);
    const membershipIds = exactReviewMembershipIds(domain.humanReviewIds);
    const activeHumanReviewId = exactOptionalLinkString(domain.activeHumanReviewId, "mail active review id", 500);
    const activeHumanReviewRef = exactOptionalLinkString(domain.activeHumanReviewRef, "mail active review ref", 1000);
    const mirroredReviewId = exactOptionalLinkString(domain.reviewId, "mail mirrored review id", 500);
    const hasMembershipContract = membershipIds.length > 0 || Boolean(activeHumanReviewId || activeHumanReviewRef);
    if (hasMembershipContract) {
      if (declaredConversationRef !== domainRef.path
        || !membershipIds.includes(row.reviewId)
        || !activeHumanReviewId
        || activeHumanReviewRef !== `reviews/${activeHumanReviewId}`
        || mirroredReviewId !== activeHumanReviewId) {
        throw failedPrecondition("mail conversation review membership or active link changed");
      }
      domainReviewIsActive = activeHumanReviewId === row.reviewId;
    } else if (mirroredReviewId !== row.reviewId) {
      throw failedPrecondition("legacy mail review lacks an exact current conversation link");
    }
    assertSameDeclaredIdentity(review, domain, "creatorId", "mail review creator identity");
    assertSameDeclaredIdentity(review, domain, "programId", "mail review program identity");
    assertSameDeclaredIdentity(review, domain, "campaignId", "mail review campaign identity");
    // Flu conversation org-filter round 15 (codex adversarial review round 15, finding #1): this
    // branch is source==="mail_human_review" exclusively (the only other DomainReviewSource,
    // "program_application", takes the branch above) — every conversation it ever touches is the
    // scp@ auto-reply human-review mailbox, so (unlike conversationAttribution.ts's general,
    // multi-conversation-type reclassify tool) it is always safe and correct to require the FULL
    // shared mailbox-entitlement predicate here, not just the org-only one. assertMutationOwner
    // alone returns immediately for role "admin"/"super_admin" with no org/mailbox check, and for
    // "manager" only checks conversation.ownerUid/programOwnerUid/createdBy — none of which an
    // scp@-received conversation (system-created, no personal owner) ever carries. An admin without
    // an scp grant, or a manager/admin from a different org, could otherwise change another org's
    // scp conversation's human-review and auto-reply state (block/human_reply/pass/revise/pending).
    const accessScope = await resolveConversationMailAccessScope({
      role: request.auth?.token?.role ?? "guest",
      email: request.auth?.token?.email,
      userId: request.auth?.uid,
    });
    if (!canReadConversationRowForScope({ id: conversationId, ...domain }, accessScope)) {
      throw Object.assign(new Error("permission-denied: conversation belongs to another mail account/org"), {
        code: "permission-denied",
        errorCode: "persist_domain_review_row_conversation_scope_denied",
      });
    }
    assertMutationOwner(
      reviewMutationActor(request),
      mutationOwnerUids(domain, { includeCreatedBy: true }),
      "mail review conversation",
    );
    const canonicalProgramId = resolveCanonicalProgramId(
      text(review.canonicalProgramId, 180)
        || text(review.programId, 180)
        || text(domain.canonicalProgramId, 180)
        || text(domain.programId, 180),
    );
    if (canonicalProgramId) {
      automationGate = await readScpIdentityConflictAutomationGate({
        programId: canonicalProgramId,
        aliases: [
          { kind: "leadId", value: domain.leadId },
          { kind: "leadId", value: review.leadId },
          { kind: "creatorId", value: domain.creatorId },
          { kind: "creatorId", value: review.creatorId },
          { kind: "channelId", value: domain.channelId },
          { kind: "channelId", value: domain.youtubeChannelId },
          { kind: "channelId", value: review.channelId },
          { kind: "email", value: domain.creatorEmail },
          { kind: "email", value: domain.email },
          { kind: "email", value: review.creatorEmail },
          { kind: "email", value: review.email },
          { kind: "conversationId", value: conversationId },
        ],
      }, transaction);
    }
  }

  const current = normalizeLedgerRow(review, row.reviewId);
  const patches = domainReviewPatches(source, row, updatedAtIso, reviewer, extra, automationGate);
  const decisionMatches = domainReviewDecisionMatches(review, row, extra);
  if (source === "mail_human_review" && !domainReviewIsActive) {
    if (decisionMatches && domainReviewRecordProjectionMatches(review, row, extra, automationGate)) {
      if (extra?.blockedAt) extra.blockedAt = text(review.blockedAt, 80) || extra.blockedAt;
      if (extra?.humanReplyAt) extra.humanReplyAt = text(review.humanReplyAt, 80) || extra.humanReplyAt;
      return { kind: source, idempotent: true, ...(automationGate ? { automationGate } : {}) };
    }
    // Multiple inbound messages can legitimately create multiple pending reviews.
    // The conversation projects only its newest active review, while older exact
    // members remain independently actionable. Resolving an inactive member is a
    // review-only CAS write: it never overwrites the newer conversation state.
    if (decisionMatches) {
      transaction.set(reviewRef, {
        ...patches.review,
        conversationProjectionPolicy: "inactive-review-only/v1",
        resolvedWhileInactive: true,
      }, { merge: true });
      return { kind: source, idempotent: false, ...(automationGate ? { automationGate } : {}) };
    }
    if (current.status === row.status || current.status === "pass" || current.status === "blocked" || current.status === "human_handled") {
      throw failedPrecondition(`inactive mail review ${current.status} already has a different terminal or replay payload`);
    }
    if (current.submissionId !== expected.submissionId
      || current.creatorId !== expected.creatorId
      || current.status !== expected.status
      || current.reasonCode !== expected.reasonCode
      || current.payableStatus !== expected.payableStatus) {
      throw failedPrecondition("inactive mail review changed before mutation commit");
    }
    transaction.set(reviewRef, {
      ...patches.review,
      conversationProjectionPolicy: "inactive-review-only/v1",
      resolvedWhileInactive: true,
    }, { merge: true });
    return { kind: source, idempotent: false, ...(automationGate ? { automationGate } : {}) };
  }
  if (decisionMatches && domainReviewProjectionMatches(source, review, domain, row, extra, automationGate)) {
    if (extra?.blockedAt) extra.blockedAt = text(review.blockedAt, 80) || extra.blockedAt;
    if (extra?.humanReplyAt) extra.humanReplyAt = text(review.humanReplyAt, 80) || extra.humanReplyAt;
    return { kind: source, idempotent: true, ...(automationGate ? { automationGate } : {}) };
  }
  if (decisionMatches) {
    transaction.set(reviewRef, patches.review, { merge: true });
    transaction.set(domainRef, patches.domain, { merge: true });
    return { kind: source, idempotent: false, ...(automationGate ? { automationGate } : {}) };
  }
  if (current.status === row.status || current.status === "pass" || current.status === "blocked" || current.status === "human_handled") {
    throw failedPrecondition(`review ${current.status} already has a different terminal or replay payload`);
  }
  if (current.submissionId !== expected.submissionId
    || current.creatorId !== expected.creatorId
    || current.status !== expected.status
    || current.reasonCode !== expected.reasonCode
    || current.payableStatus !== expected.payableStatus) {
    throw failedPrecondition("review changed before mutation commit");
  }

  transaction.set(reviewRef, patches.review, { merge: true });
  transaction.set(domainRef, patches.domain, { merge: true });
  return { kind: source, idempotent: false, ...(automationGate ? { automationGate } : {}) };
}

async function persistReviewRow(
  request: CallableRequest,
  row: ReviewLedgerRow,
  expected: ReviewRowCas,
  paymentRef?: string,
  extra?: ReviewExtra,
): Promise<ReviewPersistenceResult> {
  const updatedAtIso = extra?.blockedAt ?? extra?.humanReplyAt ?? row.paidAt ?? now();
  const canonicalStatus = canonicalReviewStatusText(row.status);
  const ledgerRef = adminDb.collection("review_ledger").doc(row.reviewId);
  const reviewRef = adminDb.collection("reviews").doc(row.reviewId);
  const persistence = await adminDb.runTransaction<ReviewPersistenceResult>(async (transaction) => {
    const ledgerSnapshot = await transaction.get(ledgerRef);
    const reviewSnapshot = await transaction.get(reviewRef);
    if (!ledgerSnapshot.exists && !reviewSnapshot.exists) {
      throw new Error("not-found: review item does not exist in persisted ledger");
    }
    const ledger = ledgerSnapshot.data() ?? {};
    const review = reviewSnapshot.data() ?? {};
    const persistedSource = text(review.source, 120);
    if (isDomainReviewSource(persistedSource) || isDomainReviewSource(row.source)) {
      if (!reviewSnapshot.exists || !isDomainReviewSource(persistedSource) || (isDomainReviewSource(row.source) && row.source !== persistedSource)) {
        throw failedPrecondition("source-aware review identity changed before mutation commit");
      }
      return persistDomainReviewRow(
        transaction,
        request,
        persistedSource,
        reviewRef,
        review,
        row,
        expected,
        updatedAtIso,
        paymentRef,
        extra,
      );
    }

    const submissionRef = adminDb.collection("submissions").doc(row.submissionId);
    const submissionSnapshot = await transaction.get(submissionRef);
    const submission = submissionSnapshot.data() ?? {};
    const storedSubmissionIds = [...new Set([
      text(ledger.submissionId, 500),
      text(review.submissionId, 500),
    ].filter(Boolean))];
    if (storedSubmissionIds.length !== 1 || storedSubmissionIds[0] !== row.submissionId) {
      throw permissionDenied("review mutation submission ownership is missing or ambiguous");
    }
    const current = normalizeLedgerRow(ledgerSnapshot.exists ? ledger : review, row.reviewId);
    if (current.submissionId !== expected.submissionId
      || current.creatorId !== expected.creatorId
      || current.status !== expected.status
      || current.reasonCode !== expected.reasonCode
      || current.payableStatus !== expected.payableStatus) {
      throw new Error("failed-precondition: review changed before mutation commit");
    }
    await assertReviewMutationAuthorized(transaction, request, {
      records: [ledger, review, submissionSnapshot.exists ? submission : null],
    });
    if (reviewMutationActor(request).role === "manager" && !submissionSnapshot.exists) {
      throw permissionDenied("review mutation authoritative submission is unavailable");
    }
    transaction.set(ledgerRef, {
      ...row,
      ...(extra ?? {}),
      paymentRef: paymentRef ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(reviewRef, {
      status: row.status,
      reviewStatus: canonicalStatus,
      reasonCode: row.reasonCode,
      payableStatus: row.payableStatus,
      payableAmountKRW: row.currency === "KRW" ? row.amount : undefined,
      paidAt: row.paidAt ?? null,
      transitionedAt: FieldValue.serverTimestamp(),
      ...(extra ?? {}),
    }, { merge: true });
    transaction.set(submissionRef, {
      reviewStatus: canonicalStatus,
      reviewReasonCode: row.reasonCode,
      payableStatus: row.payableStatus,
      payableAmountKRW: row.currency === "KRW" ? row.amount : undefined,
      paidAt: row.paidAt ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { kind: "submission_backed", idempotent: false };
  });
  if (persistence.kind === "submission_backed") {
    await enqueueReviewLifecycleRefresh({
      ledgerRef: `${REVIEW_LEDGER_COLLECTION}/${row.reviewId}`,
      submissionId: row.submissionId,
      creatorId: row.creatorId,
      reason: `review_ledger_${row.status}_${row.payableStatus}`,
      sourceUpdatedAtIso: updatedAtIso,
    });
  }
  return persistence;
}

type LegacyProjectionSubmission = {
  submissionId: string;
  submissionRef: FirebaseFirestore.DocumentReference;
  submission: Record<string, unknown>;
};

function logLegacyApprovedProjectionMiss(source: string, row: ReviewLedgerRow, reason: string, error?: unknown) {
  console.warn("[scp-approved-feed] legacy approved projection skipped", {
    source,
    reason,
    reviewId: row.reviewId,
    submissionId: row.submissionId,
    status: row.status,
    canonicalStatus: canonicalReviewStatusText(row.status),
    error: error instanceof Error ? error.message : undefined,
  });
}

function legacyProjectionFailureRef(row: ReviewLedgerRow) {
  const submissionId = row.submissionId.trim() || row.reviewId;
  return adminDb.collection(SCP_FEED_PROJECTION_FAILURES_COLLECTION).doc(submissionId);
}

export async function recordLegacyProjectionFailure(row: ReviewLedgerRow, source: string, error: unknown) {
  // Drain target: ops can replay/clear these durable legacy-path failures later.
  await legacyProjectionFailureRef(row).set({
    reviewId: row.reviewId,
    submissionId: row.submissionId,
    error: error instanceof Error ? error.message : String(error),
    at: now(),
    source: "legacy_path",
    legacySource: source,
  }, { merge: true });
}

async function clearLegacyProjectionFailure(row: ReviewLedgerRow) {
  await legacyProjectionFailureRef(row).delete();
}

function addSubmissionCandidate(candidates: Set<string>, value: unknown) {
  if (typeof value === "string" && value.trim()) candidates.add(value.trim());
}

async function resolveLegacyProjectionSubmission(transaction: FirebaseFirestore.Transaction, row: ReviewLedgerRow): Promise<LegacyProjectionSubmission | null> {
  const candidates = new Set<string>();
  addSubmissionCandidate(candidates, row.submissionId);

  const ledgerSnapshot = await transaction.get(adminDb.collection(REVIEW_LEDGER_COLLECTION).doc(row.reviewId));
  const ledgerData = ledgerSnapshot.exists ? (ledgerSnapshot.data() ?? {}) : {};
  addSubmissionCandidate(candidates, ledgerData.submissionId);

  const reviewSnapshot = await transaction.get(adminDb.collection("reviews").doc(row.reviewId));
  const reviewData = reviewSnapshot.exists ? (reviewSnapshot.data() ?? {}) : {};
  addSubmissionCandidate(candidates, reviewData.submissionId);

  for (const submissionId of candidates) {
    const submissionRef = adminDb.collection("submissions").doc(submissionId);
    const submissionSnapshot = await transaction.get(submissionRef);
    if (submissionSnapshot.exists) {
      return {
        submissionId,
        submissionRef,
        submission: submissionSnapshot.data() ?? {},
      };
    }
  }

  return null;
}

async function projectLegacyApprovedFeed(row: ReviewLedgerRow, source: string): Promise<ScpApprovedFeedProjectionResult | null> {
  const canonicalStatus = canonicalReviewStatusText(row.status);
  if (canonicalStatus !== "approved") return null;

  let projection: ScpApprovedFeedProjectionResult | null = null;
  try {
    projection = await adminDb.runTransaction(async (transaction) => {
      const resolved = await resolveLegacyProjectionSubmission(transaction, row);
      if (!resolved) {
        logLegacyApprovedProjectionMiss(source, row, "submission_unresolved");
        return null;
      }

      return projectScpApprovedFeed({
        transaction,
        submissionId: resolved.submissionId,
        submissionRef: resolved.submissionRef,
        submission: {
          ...resolved.submission,
          reviewStatus: canonicalStatus,
        },
        reviewStatus: canonicalStatus,
        previousReviewStatus: canonicalReviewStatusText(resolved.submission.reviewStatus),
        reasonText: resolved.submission.reasonText ?? resolved.submission.rejectedReason,
        approver: row.reviewer,
        approvedAtIso: row.paidAt,
        payableStatus: row.payableStatus,
      });
    });
  } catch (error) {
    logLegacyApprovedProjectionMiss(source, row, "projection_failed", error);
    await recordLegacyProjectionFailure(row, source, error).catch((recordError) => {
      console.warn("[scp-approved-feed] legacy approved projection failure record failed", {
        reviewId: row.reviewId,
        submissionId: row.submissionId,
        error: recordError instanceof Error ? recordError.message : String(recordError),
      });
    });
    return null;
  }
  if (projection) await clearLegacyProjectionFailure(row);
  return projection;
}

async function runVideoReviewTransition(request: CallableRequest, data: Record<string, unknown>) {
  const submissionId = requireString(data.submissionId, "submissionId");
  const nextStatus = asVideoReviewStatus(data.status ?? data.reviewStatus);
  const reviewer = request.auth?.uid ?? "unknown";
  const decidedAtIso = text(data.decidedAtIso, 80) || now();
  const reasonText = text(data.reasonText ?? data.reason ?? data.rejectedReason, 4000);
  if (nextStatus === "rejected" && !reasonText) {
    throw new Error("invalid-argument: rejected transitions require reasonText");
  }
  // This optional fence is supplied by server-side automated reviewers. Public
  // callers gain no authority by supplying it: a partial or stale value can only
  // reject a transition that their existing role would otherwise be allowed to make.
  const expectedProgramScope = expectedVideoReviewProgramScope(data);
  const requestedDecisionRef = videoReviewDecisionRef(data.latestVideoReviewDecisionRef ?? data.decisionRef);
  const submissionRef = adminDb.collection("submissions").doc(submissionId);

  const result = await adminDb.runTransaction<VideoTransitionResult>(async (transaction) => {
    const submissionSnapshot = await transaction.get(submissionRef);
    if (!submissionSnapshot.exists) throw new Error("not-found: submission item does not exist");
    const submission = submissionSnapshot.data() ?? {};
    const applicationId = reviewApplicationId(submission);
    const authoritativeScopeRecords: Record<string, unknown>[] = [];
    let programScope: VideoReviewProgramScope;
    try {
      programScope = requireExplicitLegacySubmissionScope(
        submission,
        await resolveAuthoritativeVideoReviewProgramScope({ id: submissionSnapshot.id, ...submission }, {
          recordReader: async (collection, documentId) => {
            const snapshot = await transaction.get(adminDb.collection(collection).doc(documentId));
            const record = snapshot.exists
              ? exactApplicationScopedRecord(collection, { id: snapshot.id, ...(snapshot.data() ?? {}) }, applicationId)
              : null;
            if (record) authoritativeScopeRecords.push(record);
            return record;
          },
        }),
      );
    } catch (error) {
      // A declared task/lead/application reference is an authoritative claim. If
      // that record is missing or broken, falling back to submission.programId
      // would turn a dangling reference into an authorization bypass.
      if (expectedProgramScope) throw error;
      programScope = legacySubmissionProgramScopeOrThrow(submission, error);
    }
    if (expectedProgramScope && !sameVideoReviewProgramScope(programScope, expectedProgramScope)) {
      throw programScopeError("video_review_program_scope_changed");
    }
    await assertReviewMutationAuthorized(transaction, request, {
      records: [submission, ...authoritativeScopeRecords],
      expectedCanonicalProgramId: programScope.canonicalProgramId,
      expectedApplicationId: applicationId,
    });
    let trustedDecisionRef: string | null = null;
    if (requestedDecisionRef) {
      const authoritativeDecisionRef = authoritativeVideoReviewDecisionRef(submission, programScope);
      if (requestedDecisionRef !== authoritativeDecisionRef) {
        throw new Error("failed-precondition: video_review_decision_ref_mismatch");
      }
      const decisionSnapshot = await transaction.get(adminDb.doc(requestedDecisionRef));
      const decision = decisionSnapshot.data() ?? {};
      const decisionScopeFieldsPresent = Boolean(
        text(decision.canonicalProgramId, 180)
        || text(decision.policyConfigHash, 128)
        || text(decision.programScopeVersion, 120),
      );
      const decisionScopeMatches = text(decision.canonicalProgramId, 180) === programScope.canonicalProgramId
        && text(decision.policyConfigHash, 128) === programScope.policyConfigHash
        && decision.programScopeVersion === programScope.scopeVersion;
      if (!decisionSnapshot.exists
        || text(decision.submissionId, 500) !== submissionId
        || (expectedProgramScope ? !decisionScopeMatches : decisionScopeFieldsPresent && !decisionScopeMatches)) {
        throw new Error("failed-precondition: video_review_decision_ref_mismatch");
      }
      trustedDecisionRef = requestedDecisionRef;
    }
    const currentStatus = normalizeVideoReviewStatus(submission.reviewStatus);
    if (currentStatus === nextStatus) {
      throw new Error(`failed-precondition: cannot transition submission ${currentStatus} -> ${nextStatus}`);
    }
    if (!VIDEO_REVIEW_FLOW[currentStatus].includes(nextStatus)) {
      throw new Error(`failed-precondition: cannot transition submission ${currentStatus} -> ${nextStatus}`);
    }

    const previousPayment = normalizePayment(submission.payment);

    const amount = numberValue(data.amount ?? data.amountKRW ?? data.payableAmountKRW ?? previousPayment?.amount ?? submission.payableAmountKRW ?? submission.amount, 0);
    assertNonNegativeAmount(amount);
    const currency = asCurrency(data.currency ?? previousPayment?.currency ?? submission.currency);
    // Infly contract: `paid` is immutable. A transition away from `approved`
    // still proceeds (status may move to rejected/needs_review/pending) but the
    // paid payment record is preserved rather than reversed or deleted — the
    // settlement already happened. A not-yet-paid payable is created on approve
    // and cleared (null) on any non-approve transition.
    const nextPayment: VideoPayment | null = previousPayment?.payStatus === "paid"
      ? previousPayment
      : nextStatus === "approved"
        ? {
          payStatus: "payable",
          payableAt: previousPayment?.payableAt ?? decidedAtIso,
          paidAt: previousPayment?.paidAt,
          amount,
          currency,
          paymentRef: previousPayment?.paymentRef,
        }
        : null;

    const reviewNotes = Array.isArray(submission.reviewNotes) ? [...submission.reviewNotes] : [];
    const note = reviewNoteFrom(data, currentStatus, nextStatus, reviewer, decidedAtIso, trustedDecisionRef);
    reviewNotes.push(note);

    const creatorId = text(submission.creatorId, 180) || "unknown";
    const rawProgramIdAlias = text(submission.programId, 180);
    const programId = programScope.canonicalProgramId;
    // Attribution snapshot: carry the lead / OneLink / campaign identity forward
    // so the ledger row joins on stable ids, not just email. These are recorded
    // on the submission at submit time; a transition preserves them.
    const leadId = text(submission.leadId, 180) || "";
    const campaign = text(submission.campaign, 240);
    const creatorLinkRef = text(submission.creatorLinkRef, 240);
    const reviewId = text(submission.reviewId, 180) || videoReviewIdentityDocId({
      canonicalProgramId: programScope.canonicalProgramId,
      applicationId,
      leadId,
      creatorId,
      submissionId,
    });
    const ledgerId = serverLedgerId(submissionId);
    const ledgerRef = adminDb.collection(REVIEW_LEDGER_COLLECTION).doc(ledgerId);
    const payableSnapshot = paymentSnapshot(nextPayment);
    const countPatch = countDeltas(currentStatus, nextStatus, previousPayment, nextPayment, submission.countsInitialized === true);
    const payableStatus: PaymentStatus = nextPayment?.payStatus === "paid" ? "paid" : nextPayment?.payStatus === "payable" ? "payable" : "not_payable";
    const rejectedReason = nextStatus === "rejected" ? reasonText : nextStatus === "approved" || nextStatus === "pending" ? "" : text(data.rejectedReason ?? reasonText, 4000);
    const projectedSubmission = {
      ...submission,
      programId,
      canonicalProgramId: programScope.canonicalProgramId,
      rawProgramIdAlias: rawProgramIdAlias && rawProgramIdAlias !== programScope.canonicalProgramId ? rawProgramIdAlias : null,
      applicationId: applicationId || null,
      policyConfigHash: programScope.policyConfigHash,
      programScopeVersion: programScope.scopeVersion,
      reviewId,
      reviewStatus: nextStatus,
      rejectedReason,
      reviewReasonCode: videoReasonCode(nextStatus),
      payableStatus,
      payment: nextPayment,
      leadId: leadId || null,
      campaign: campaign || null,
      creatorLinkRef: creatorLinkRef || null,
    };
    const scpApprovedFeed = await projectScpApprovedFeed({
      transaction,
      submissionId,
      submissionRef,
      submission: projectedSubmission,
      reviewStatus: nextStatus,
      previousReviewStatus: currentStatus,
      verdict: data.verdict ?? note.decision,
      reasons: data.reasons,
      reasonText,
      feedbackText: data.feedbackText,
      approver: reviewer,
      approvedAtIso: nextStatus === "approved" ? decidedAtIso : undefined,
      payableStatus,
      latestVideoReviewDecisionRef: note.decisionRef || undefined,
      archivedAtIso: decidedAtIso,
    });

    transaction.set(submissionRef, {
      programId,
      canonicalProgramId: programScope.canonicalProgramId,
      rawProgramIdAlias: rawProgramIdAlias && rawProgramIdAlias !== programScope.canonicalProgramId ? rawProgramIdAlias : null,
      applicationId: applicationId || null,
      policyConfigHash: programScope.policyConfigHash,
      programScopeVersion: programScope.scopeVersion,
      reviewId,
      reviewStatus: nextStatus,
      rejectedReason,
      reviewReasonCode: videoReasonCode(nextStatus),
      reviewNotes,
      latestReviewLedgerRef: ledgerRef.path,
      payment: nextPayment,
      payableStatus,
      payableAmountKRW: currency === "KRW" ? amount : null,
      paidAt: nextPayment?.paidAt ?? null,
      leadId: leadId || null,
      campaign: campaign || null,
      creatorLinkRef: creatorLinkRef || null,
      countsInitialized: true,
      transitionedAtIso: decidedAtIso,
      updatedAtIso: decidedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    transaction.set(adminDb.collection("reviews").doc(reviewId), {
      id: reviewId,
      submissionId,
      creatorId,
      gameId: programId,
      programId,
      canonicalProgramId: programScope.canonicalProgramId,
      rawProgramIdAlias: rawProgramIdAlias && rawProgramIdAlias !== programScope.canonicalProgramId ? rawProgramIdAlias : null,
      applicationId: applicationId || null,
      leadId: leadId || null,
      policyConfigHash: programScope.policyConfigHash,
      programScopeVersion: programScope.scopeVersion,
      status: videoToLegacyStatus(nextStatus),
      reviewStatus: nextStatus,
      reasonCode: videoReasonCode(nextStatus),
      rejectedReason,
      payableStatus,
      payableAmountKRW: currency === "KRW" ? amount : null,
      payment: nextPayment,
      transitionedAtIso: decidedAtIso,
      transitionedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      source: "scp_video_review",
    }, { merge: true });

    // Append-only: create() fails if this event id already exists, so a row can
    // never be overwritten (server-derived id guarantees no legitimate collision).
    transaction.create(ledgerRef, {
      id: ledgerId,
      reviewId,
      submissionId,
      creatorId,
      programId,
      gameId: programId,
      canonicalProgramId: programScope.canonicalProgramId,
      rawProgramIdAlias: rawProgramIdAlias && rawProgramIdAlias !== programScope.canonicalProgramId ? rawProgramIdAlias : null,
      applicationId: applicationId || null,
      policyConfigHash: programScope.policyConfigHash,
      programScopeVersion: programScope.scopeVersion,
      leadId: leadId || null,
      campaign: campaign || null,
      creatorLinkRef: creatorLinkRef || null,
      status: videoToLegacyStatus(nextStatus),
      reasonCode: videoReasonCode(nextStatus),
      payableStatus,
      amount,
      currency,
      vatIncluded: true,
      reviewer,
      paidAt: nextPayment?.paidAt ?? null,
      transition: {
        from: currentStatus,
        to: nextStatus,
        decision: note.decision,
        source: note.source,
        decidedBy: reviewer,
        decidedAtIso,
        reasonText,
        decisionRef: note.decisionRef,
      },
      payableSnapshot,
      source: "scp_video_review_transition",
      createdAtIso: decidedAtIso,
      createdAt: FieldValue.serverTimestamp(),
    });

    transaction.set(adminDb.collection("submission_review_counts").doc(programScope.canonicalProgramId), {
      id: programScope.canonicalProgramId,
      programId: programScope.canonicalProgramId,
      canonicalProgramId: programScope.canonicalProgramId,
      lastRawProgramIdAlias: rawProgramIdAlias && rawProgramIdAlias !== programScope.canonicalProgramId ? rawProgramIdAlias : null,
      ...countPatch,
      updatedAtIso: decidedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return {
      submissionId,
      reviewId,
      creatorId,
      leadId: leadId || null,
      from: currentStatus,
      to: nextStatus,
      payment: nextPayment,
      ledgerRef: ledgerRef.path,
      scpApprovedFeed,
    };
  });
  await enqueueReviewLifecycleRefresh({
    ledgerRef: result.ledgerRef,
    submissionId: result.submissionId,
    creatorId: result.creatorId,
    leadId: result.leadId,
    videoRef: result.scpApprovedFeed.videoRef,
    videoId: result.scpApprovedFeed.videoId,
    reason: `video_review_${result.to}`,
    sourceUpdatedAtIso: decidedAtIso,
  });

  return {
    review: {
      reviewId: result.reviewId,
      submissionId: result.submissionId,
      reviewStatus: result.to,
      status: videoToLegacyStatus(result.to),
      from: result.from,
      to: result.to,
      payment: result.payment,
      ledgerRef: result.ledgerRef,
      scpApprovedFeed: result.scpApprovedFeed,
    },
    cache: cacheMeta(`submission-review:${submissionId}`),
    costLog: costLog("persisted video review transition"),
    behaviorLog: behaviorLog(request, "updateReviewStatus:video_transition", "allow", "scp-automation"),
  };
}

async function recordSubmissionPayment(request: CallableRequest, data: Record<string, unknown>) {
  const submissionId = requireString(data.submissionId, "submissionId");
  const paymentRef = requireString(data.paymentRef, "paymentRef");
  const reviewer = request.auth?.uid ?? "unknown";
  const paidAtIso = text(data.paidAtIso, 80) || now();
  const submissionRef = adminDb.collection("submissions").doc(submissionId);

  const result = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(submissionRef);
    if (!snapshot.exists) throw new Error("not-found: submission item does not exist");
    const submission = snapshot.data() ?? {};
    const applicationId = reviewApplicationId(submission);
    const authoritativeScopeRecords: Record<string, unknown>[] = [];
    let computedProgramScope: VideoReviewProgramScope;
    try {
      computedProgramScope = requireExplicitLegacySubmissionScope(
        submission,
        await resolveAuthoritativeVideoReviewProgramScope({ id: snapshot.id, ...submission }, {
          recordReader: async (collection, documentId) => {
            const linked = await transaction.get(adminDb.collection(collection).doc(documentId));
            const record = linked.exists
              ? exactApplicationScopedRecord(collection, { id: linked.id, ...(linked.data() ?? {}) }, applicationId)
              : null;
            if (record) authoritativeScopeRecords.push(record);
            return record;
          },
        }),
      );
    } catch (error) {
      computedProgramScope = legacySubmissionProgramScopeOrThrow(submission, error);
    }
    const storedPolicyConfigHash = text(submission.policyConfigHash, 128);
    const programScope = {
      canonicalProgramId: computedProgramScope.canonicalProgramId,
      policyConfigHash: submission.programScopeVersion === computedProgramScope.scopeVersion && /^[a-f0-9]{64}$/.test(storedPolicyConfigHash)
        ? storedPolicyConfigHash
        : computedProgramScope.policyConfigHash,
      scopeVersion: computedProgramScope.scopeVersion,
    };
    await assertReviewMutationAuthorized(transaction, request, {
      records: [submission, ...authoritativeScopeRecords],
      expectedCanonicalProgramId: programScope.canonicalProgramId,
      expectedApplicationId: applicationId,
    });
    const reviewStatus = normalizeVideoReviewStatus(submission.reviewStatus);
    const previousPayment = normalizePayment(submission.payment);
    if (reviewStatus !== "approved" || previousPayment?.payStatus !== "payable") {
      throw new Error("failed-precondition: only approved payable submissions can be marked paid");
    }

    const nextPayment: VideoPayment = {
      ...previousPayment,
      payStatus: "paid",
      paidAt: paidAtIso,
      paymentRef,
    };
    const creatorId = text(submission.creatorId, 180) || "unknown";
    const rawProgramIdAlias = text(submission.programId, 180);
    const programId = programScope.canonicalProgramId;
    const leadId = text(submission.leadId, 180) || "";
    const campaign = text(submission.campaign, 240);
    const creatorLinkRef = text(submission.creatorLinkRef, 240);
    const reviewId = text(submission.reviewId, 180) || videoReviewIdentityDocId({
      canonicalProgramId: programScope.canonicalProgramId,
      applicationId,
      leadId,
      creatorId,
      submissionId,
    });
    const ledgerId = serverLedgerId(submissionId);
    const ledgerRef = adminDb.collection(REVIEW_LEDGER_COLLECTION).doc(ledgerId);
    const note = {
      source: "flu_video_review_payment",
      decision: "paid",
      from: "approved",
      to: "approved",
      reasonText: text(data.reasonText, 4000),
      feedbackText: "",
      decidedBy: reviewer,
      createdAt: paidAtIso,
      createdAtIso: paidAtIso,
    };
    const reviewNotes = Array.isArray(submission.reviewNotes) ? [...submission.reviewNotes, note] : [note];
    const scpApprovedFeed = await projectScpApprovedFeed({
      transaction,
      submissionId,
      submissionRef,
      submission: {
        ...submission,
        payment: nextPayment,
        payableStatus: "paid",
        paidAt: paidAtIso,
      },
      reviewStatus: "approved",
      previousReviewStatus: "approved",
      payableStatus: "paid",
      archivedAtIso: paidAtIso,
    });


    transaction.set(submissionRef, {
      reviewNotes,
      payment: nextPayment,
      payableStatus: "paid",
      paidAt: paidAtIso,
      updatedAtIso: paidAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(adminDb.collection("reviews").doc(reviewId), {
      id: reviewId,
      submissionId,
      creatorId,
      gameId: programId,
      programId,
      canonicalProgramId: programScope.canonicalProgramId,
      rawProgramIdAlias: rawProgramIdAlias && rawProgramIdAlias !== programScope.canonicalProgramId ? rawProgramIdAlias : null,
      applicationId: applicationId || null,
      leadId: leadId || null,
      policyConfigHash: programScope.policyConfigHash,
      programScopeVersion: programScope.scopeVersion,
      status: "pass",
      reviewStatus: "approved",
      payableStatus: "paid",
      payment: nextPayment,
      paidAt: paidAtIso,
      paymentRef,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    // Append-only: a paid event is a distinct immutable ledger row.
    transaction.create(ledgerRef, {
      id: ledgerId,
      reviewId,
      submissionId,
      creatorId,
      programId,
      gameId: programId,
      canonicalProgramId: programScope.canonicalProgramId,
      rawProgramIdAlias: rawProgramIdAlias && rawProgramIdAlias !== programScope.canonicalProgramId ? rawProgramIdAlias : null,
      applicationId: applicationId || null,
      policyConfigHash: programScope.policyConfigHash,
      programScopeVersion: programScope.scopeVersion,
      leadId: leadId || null,
      campaign: campaign || null,
      creatorLinkRef: creatorLinkRef || null,
      status: "pass",
      reasonCode: "approved",
      payableStatus: "paid",
      amount: nextPayment.amount ?? 0,
      currency: nextPayment.currency ?? "KRW",
      vatIncluded: true,
      reviewer,
      paidAt: paidAtIso,
      transition: {
        from: "approved",
        to: "approved",
        decision: "paid",
        decidedBy: reviewer,
        decidedAtIso: paidAtIso,
        reasonText: text(data.reasonText, 4000),
      },
      payableSnapshot: paymentSnapshot(nextPayment),
      source: "scp_video_review_payment",
      paymentRef,
      createdAtIso: paidAtIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(adminDb.collection("submission_review_counts").doc(programScope.canonicalProgramId), {
      id: programScope.canonicalProgramId,
      programId: programScope.canonicalProgramId,
      canonicalProgramId: programScope.canonicalProgramId,
      lastRawProgramIdAlias: rawProgramIdAlias && rawProgramIdAlias !== programScope.canonicalProgramId ? rawProgramIdAlias : null,
      payments: {
        payable: FieldValue.increment(-1),
        paid: FieldValue.increment(1),
      },
      updatedAtIso: paidAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { reviewId, creatorId, leadId: leadId || null, programId, payment: nextPayment, ledgerRef: ledgerRef.path, scpApprovedFeed };
  });
  await enqueueReviewLifecycleRefresh({
    ledgerRef: result.ledgerRef,
    submissionId,
    creatorId: result.creatorId,
    leadId: result.leadId,
    videoRef: result.scpApprovedFeed.videoRef,
    videoId: result.scpApprovedFeed.videoId,
    reason: "video_review_paid",
    sourceUpdatedAtIso: paidAtIso,
  });

  return {
    payment: {
      paymentRef,
      reviewId: result.reviewId,
      submissionId,
      creatorId: result.creatorId,
      paymentStatus: result.payment.payStatus,
      amount: result.payment.amount ?? 0,
      currency: result.payment.currency ?? "KRW",
      vatIncluded: true,
      paidAt: result.payment.paidAt,
      ledgerRef: result.ledgerRef,
    },
    scpApprovedFeed: result.scpApprovedFeed,
    cache: cacheMeta(`submission-payment:${paymentRef}`),
    costLog: costLog("persisted video payment ledger write"),
    behaviorLog: behaviorLog(request, "recordPayment:video_submission", "allow", result.programId),
  };
}

async function updateSubmissionReviewMemo(request: CallableRequest, data: Record<string, unknown>) {
  const submissionId = requireString(data.submissionId, "submissionId");
  const reviewMemo = text(data.reviewMemo ?? data.memo, 8000);
  const updatedAtIso = text(data.decidedAtIso, 80) || now();
  const submissionRef = adminDb.collection("submissions").doc(submissionId);
  const result = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(submissionRef);
    if (!snapshot.exists) throw new Error("not-found: submission item does not exist");
    const submission = snapshot.data() ?? {};
    const applicationId = reviewApplicationId(submission);
    const authoritativeScopeRecords: Record<string, unknown>[] = [];
    let programScope: VideoReviewProgramScope;
    try {
      programScope = requireExplicitLegacySubmissionScope(
        submission,
        await resolveAuthoritativeVideoReviewProgramScope({ id: snapshot.id, ...submission }, {
          recordReader: async (collection, documentId) => {
            const linked = await transaction.get(adminDb.collection(collection).doc(documentId));
            const record = linked.exists
              ? exactApplicationScopedRecord(collection, { id: linked.id, ...(linked.data() ?? {}) }, applicationId)
              : null;
            if (record) authoritativeScopeRecords.push(record);
            return record;
          },
        }),
      );
    } catch (error) {
      programScope = legacySubmissionProgramScopeOrThrow(submission, error);
    }
    await assertReviewMutationAuthorized(transaction, request, {
      records: [submission, ...authoritativeScopeRecords],
      expectedCanonicalProgramId: programScope.canonicalProgramId,
      expectedApplicationId: applicationId,
    });
    const rawProgramIdAlias = text(submission.programId, 180);
    const programId = programScope.canonicalProgramId;
    const creatorId = text(submission.creatorId, 180) || "unknown";
    const leadId = text(submission.leadId, 180);
    const reviewId = text(submission.reviewId, 180) || videoReviewIdentityDocId({
      canonicalProgramId: programScope.canonicalProgramId,
      applicationId,
      leadId,
      creatorId,
      submissionId,
    });
    transaction.set(submissionRef, {
      programId,
      canonicalProgramId: programScope.canonicalProgramId,
      rawProgramIdAlias: rawProgramIdAlias && rawProgramIdAlias !== programScope.canonicalProgramId ? rawProgramIdAlias : null,
      applicationId: applicationId || null,
      policyConfigHash: programScope.policyConfigHash,
      programScopeVersion: programScope.scopeVersion,
      reviewId,
      reviewMemo,
      updatedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(adminDb.collection("reviews").doc(reviewId), {
      id: reviewId,
      submissionId,
      creatorId,
      gameId: programId,
      programId,
      canonicalProgramId: programScope.canonicalProgramId,
      rawProgramIdAlias: rawProgramIdAlias && rawProgramIdAlias !== programScope.canonicalProgramId ? rawProgramIdAlias : null,
      applicationId: applicationId || null,
      leadId: leadId || null,
      policyConfigHash: programScope.policyConfigHash,
      programScopeVersion: programScope.scopeVersion,
      reviewMemo,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { reviewId, programId };
  });
  return {
    review: {
      reviewId: result.reviewId,
      submissionId,
      reviewMemo,
    },
    cache: cacheMeta(`submission-review-memo:${submissionId}`),
    costLog: costLog("persisted video review memo"),
    behaviorLog: behaviorLog(request, "updateReviewStatus:video_memo", "allow", result.programId),
  };
}

async function fetchReviLedger(gameId: string): Promise<ReviewLedgerRow[] | null> {
  if (!liveIntegrationsEnabled("revi")) return null;

  const config = await getRuntimeIntegration("externalApi");
  const endpoint = publicString(config, "reviEndpoint", "REVI_ENDPOINT");
  if (!endpoint) return null;

  const apiKey = requireEnvSecret("REVI_API_KEY", "Revi API");
  const url = new URL(endpoint);
  if (gameId !== "all") url.searchParams.set("gameId", gameId);

  const response = await fetch(url, {
    headers: { Accept: "application/json", ...authHeader(apiKey) },
    signal: timeoutSignal(12_000),
  });
  if (!response.ok) throw Object.assign(new Error(`Revi ledger sync failed (${response.status})`), { code: "failed-precondition", errorCode: "fetch_revi_ledger_revi_ledger_sync" });

  const json = await response.json() as unknown;
  const root = readObject(json);
  const rawRows = Array.isArray(root.rows) ? root.rows : Array.isArray(json) ? json as unknown[] : [];
  const rows = rawRows.map((row, index) => normalizeReviRow(readObject(row), gameId, index));

  if (rows.length > 0) {
    const batch = adminDb.batch();
    for (const row of rows) {
      batch.set(adminDb.collection("review_ledger").doc(row.reviewId), { ...row, source: "revi-api", syncedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    await batch.commit();
    const syncedAtIso = now();
    await Promise.all(rows.map((row) => enqueueReviewLifecycleRefresh({
      ledgerRef: `${REVIEW_LEDGER_COLLECTION}/${row.reviewId}`,
      submissionId: row.submissionId,
      creatorId: row.creatorId,
      reason: "review_ledger_synced",
      sourceUpdatedAtIso: syncedAtIso,
    })));
    await Promise.all(rows.map((row) => projectLegacyApprovedFeed(row, "syncReviewLedger:revi")));
  }

  return rows;
}

function normalizeReviRow(row: Record<string, unknown>, requestedGameId: string, index: number): ReviewLedgerRow {
  const canonicalStatus = canonicalReviewStatus(row.status);
  const status = canonicalStatus === "approved"
    ? "pass"
    : row.status === "revise" || row.status === "pending" || row.status === "blocked" || row.status === "human_handled" ? row.status : "pending";
  const payableStatus = row.payableStatus === "paid" || row.payableStatus === "payable" || row.payableStatus === "not_payable" ? row.payableStatus : status === "pass" ? "payable" : "not_payable";
  const currency = row.currency === "USD" ? "USD" : "KRW";
  const amount = typeof row.amount === "number" && Number.isFinite(row.amount) ? row.amount : 0;
  return {
    reviewId: typeof row.reviewId === "string" ? row.reviewId : `revi-${requestedGameId}-${index}`,
    submissionId: typeof row.submissionId === "string" ? row.submissionId : `submission-${index}`,
    creatorId: typeof row.creatorId === "string" ? row.creatorId : "unknown",
    gameId: typeof row.gameId === "string" ? row.gameId : requestedGameId,
    status,
    reasonCode: status === "pass" ? "approved" : "quality_issue",
    payableStatus,
    amount,
    currency,
    vatIncluded: row.vatIncluded === true,
    reviewer: typeof row.reviewer === "string" ? row.reviewer : "revi",
    paidAt: typeof row.paidAt === "string" ? row.paidAt : undefined,
  };
}

export async function updateReviewStatus(request: CallableRequest) {
  const data = readObject(request.data);
  if (typeof data.submissionId === "string" && data.submissionId) {
    const action = typeof data.action === "string" ? data.action : null;
    const gateAction = action === "memo" ? "updateReviewStatus:video_memo" : "updateReviewStatus:video_transition";
    const gameId = text(data.programId, 180) || "scp-automation";
    const guard = requireWriteRole(request, gateAction, gameId);
    if (!guard.ok) throw guard.error;
    await assertVideoSubmissionScpEntitled(request, guard.role, gateAction, gameId);
    if (action === "memo") return updateSubmissionReviewMemo(request, data);
    return runVideoReviewTransition(request, data);
  }

  const reviewId = requireString(data.reviewId, "reviewId");
  const action = typeof data.action === "string" ? data.action : null;
  const preliminaryGuard = requireWriteRole(request, "updateReviewStatus", "unknown");
  if (!preliminaryGuard.ok) throw preliminaryGuard.error;
  const row = await findLedgerRow(reviewId);
  const sourceAware = isDomainReviewSource(row.source);

  const reviewer = request.auth?.uid ?? "unknown";

  // ── block action ──────────────────────────────────────────────────────────
  if (action === "block") {
    const expected = reviewRowCas(row);
    const reason = typeof data.reason === "string" && data.reason.trim() ? data.reason.trim() : "사유 없음";
    row.status = "blocked";
    row.payableStatus = "not_payable";
    row.reasonCode = "quality_issue";
    const extra: ReviewExtra = {
      blockedAt: now(),
      blockedBy: reviewer,
      blockReason: reason,
    };
    const persistence = await persistReviewRow(request, row, expected, undefined, extra);
    return {
      idempotent: persistence.idempotent,
      ...(persistence.automationGate ? { automationGate: persistence.automationGate } : {}),
      review: {
        reviewId: row.reviewId,
        ...(row.submissionId ? { submissionId: row.submissionId } : {}),
        creatorId: row.creatorId,
        status: row.status,
        reasonCode: row.reasonCode,
        payableStatus: row.payableStatus,
        amount: row.amount,
        currency: row.currency,
        vatIncluded: row.vatIncluded,
        blockedAt: extra.blockedAt,
        blockedBy: extra.blockedBy,
        blockReason: extra.blockReason,
      },
      cache: cacheMeta(`review:${row.reviewId}`),
      costLog: costLog("persisted block action"),
      behaviorLog: behaviorLog(request, "updateReviewStatus:block", "allow", row.gameId),
    };
  }

  // ── human_reply action ────────────────────────────────────────────────────
  if (action === "human_reply") {
    const expected = reviewRowCas(row);
    const replyText = typeof data.replyText === "string" && data.replyText.trim() ? data.replyText.trim() : "";
    if (!replyText) throw new Error("invalid-argument: replyText is required for human_reply action");
    row.status = "human_handled";
    row.payableStatus = "not_payable";
    row.reasonCode = "quality_issue";
    const extra: ReviewExtra = {
      humanReplyText: replyText,
      humanReplyAt: now(),
      humanReplyBy: reviewer,
    };
    const persistence = await persistReviewRow(request, row, expected, undefined, extra);
    return {
      idempotent: persistence.idempotent,
      ...(persistence.automationGate ? { automationGate: persistence.automationGate } : {}),
      review: {
        reviewId: row.reviewId,
        ...(row.submissionId ? { submissionId: row.submissionId } : {}),
        creatorId: row.creatorId,
        status: row.status,
        reasonCode: row.reasonCode,
        payableStatus: row.payableStatus,
        amount: row.amount,
        currency: row.currency,
        vatIncluded: row.vatIncluded,
        humanReplyText: extra.humanReplyText,
        humanReplyAt: extra.humanReplyAt,
        humanReplyBy: extra.humanReplyBy,
      },
      cache: cacheMeta(`review:${row.reviewId}`),
      costLog: costLog("persisted human_reply action"),
      behaviorLog: behaviorLog(request, "updateReviewStatus:human_reply", "allow", row.gameId),
    };
  }

  // ── existing pass / revise / pending flow ─────────────────────────────────
  const nextStatus = asReviewStatus(data.status);
  const expected = reviewRowCas(row);
  if (!STATUS_FLOW[row.status].includes(nextStatus) && !(sourceAware && row.status === nextStatus)) {
    throw new Error(`failed-precondition: cannot transition review ${row.status} -> ${nextStatus}`);
  }

  const reasonCode = asReasonCode(data.reasonCode, nextStatus);
  row.status = nextStatus;
  row.reasonCode = reasonCode;
  row.payableStatus = nextStatus === "pass" ? "payable" : "not_payable";
  const persistence = await persistReviewRow(request, row, expected);
  const scpApprovedFeed = persistence.kind === "submission_backed"
    ? await projectLegacyApprovedFeed(row, "updateReviewStatus:legacy_review_id")
    : null;

  return {
    idempotent: persistence.idempotent,
    ...(persistence.automationGate ? { automationGate: persistence.automationGate } : {}),
    review: {
      reviewId: row.reviewId,
      ...(row.submissionId ? { submissionId: row.submissionId } : {}),
      creatorId: row.creatorId,
      status: row.status,
      reasonCode: row.reasonCode,
      payableStatus: row.payableStatus,
      amount: row.amount,
      currency: row.currency,
      vatIncluded: row.vatIncluded,
      ...(scpApprovedFeed ? { scpApprovedFeed } : {}),
    },
    cache: cacheMeta(`review:${row.reviewId}`),
    costLog: costLog("persisted review status write"),
    behaviorLog: behaviorLog(request, "updateReviewStatus", "allow", row.gameId),
  };
}

export async function recordPayment(request: CallableRequest) {
  const data = readObject(request.data);
  if (typeof data.submissionId === "string" && data.submissionId) {
    const gameId = text(data.programId, 180) || "scp-automation";
    const guard = requireWriteRole(request, "recordPayment:video_submission", gameId);
    if (!guard.ok) throw guard.error;
    await assertVideoSubmissionScpEntitled(request, guard.role, "recordPayment:video_submission", gameId);
    return recordSubmissionPayment(request, data);
  }

  const reviewId = requireString(data.reviewId, "reviewId");
  const paymentRef = requireString(data.paymentRef, "paymentRef");
  const preliminaryGuard = requireWriteRole(request, "recordPayment", "unknown");
  if (!preliminaryGuard.ok) throw preliminaryGuard.error;
  const row = await findLedgerRow(reviewId);

  if (row.status !== "pass" || row.payableStatus !== "payable") {
    throw new Error("failed-precondition: only passed payable reviews can be marked paid");
  }

  const expected = reviewRowCas(row);
  row.payableStatus = "paid";
  row.paidAt = now();
  await persistReviewRow(request, row, expected, paymentRef);

  return {
    payment: {
      paymentRef,
      reviewId: row.reviewId,
      submissionId: row.submissionId,
      creatorId: row.creatorId,
      paymentStatus: row.payableStatus,
      amount: row.amount,
      currency: row.currency,
      vatIncluded: row.vatIncluded,
      paidAt: row.paidAt,
    },
    cache: cacheMeta(`payment:${paymentRef}`),
    costLog: costLog("persisted payment ledger write"),
    behaviorLog: behaviorLog(request, "recordPayment", "allow", row.gameId),
  };
}

export async function syncReviewLedger(request: CallableRequest) {
  const data = readObject(request.data);
  const gameId = typeof data.gameId === "string" ? data.gameId : "all";
  const guard = requireWriteRole(request, "syncReviewLedger", gameId);
  if (!guard.ok) throw guard.error;
  if (guard.role === "manager") {
    throw permissionDenied("global review ledger synchronization requires an admin role");
  }

  const liveRows = await fetchReviLedger(gameId);
  const ledgerRead: LedgerRead = liveRows
    ? {
      rows: liveRows,
      pageInfo: { pageSize: liveRows.length, maxRows: liveRows.length, returned: liveRows.length, truncated: false, nextCursor: null },
    }
    : await readLedgerRows(gameId);
  const rows = ledgerRead.rows;
  const payable = rows.filter((row) => row.payableStatus === "payable");
  const paid = rows.filter((row) => row.payableStatus === "paid");
  const complete = !ledgerRead.pageInfo.truncated;

  return {
    summary: {
      gameId,
      totalReviews: complete ? rows.length : null,
      sampledReviews: rows.length,
      complete,
      pending: rows.filter((row) => row.status === "pending").length,
      pass: rows.filter((row) => row.status === "pass").length,
      revise: rows.filter((row) => row.status === "revise").length,
      payableCount: payable.length,
      payableAmountKRW: payable.reduce((sum, row) => sum + row.amount, 0),
      paidCount: paid.length,
      paidAmountKRW: paid.reduce((sum, row) => sum + row.amount, 0),
    },
    pageInfo: ledgerRead.pageInfo,
    rows: rows.map((row) => ({
      reviewId: row.reviewId,
      submissionId: row.submissionId,
      creatorId: row.creatorId,
      gameId: row.gameId,
      status: row.status,
      reasonCode: row.reasonCode,
      payableStatus: row.payableStatus,
      amount: row.amount,
      currency: row.currency,
      vatIncluded: row.vatIncluded,
      paidAt: row.paidAt,
    })),
    cache: cacheMeta(`review-ledger:${gameId}`),
    source: liveRows ? "revi-live-callable" : "review-ledger-firestore-callable",
    costLog: costLog(liveRows ? "revi live ledger sync" : "persisted ledger aggregate", liveRows ? "revi-api" : "firestore"),
    behaviorLog: behaviorLog(request, "syncReviewLedger", "allow", gameId),
  };
}
