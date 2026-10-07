import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  SCP_QUALIFICATION_REVIEW_GID,
  SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID,
  SCP_QUALIFICATION_REVIEW_TAB_NAME,
} from "./scpSheetReviewService";
import { sha256AtoZ, sourceIdForGoogleSheet } from "./sheetIntakeService";
import {
  qualificationBoundaryError,
  qualificationBoundaryException,
  qualificationIdentityHash,
} from "./qualificationPrivacy";
import { assertStagingExternalSideEffectAllowed } from "./stagingSafety";
import { assertNonGuestAuth, asRecord, asString, type AuthContext, type CallableRequestShape } from "./shared";
import { assertScpEntitled } from "./mailAccounts";

const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;
const ACTION = "scp_qualification_sheet_writeback.write_results";
const AUDIT_COLLECTION = "scp_qualification_sheet_writeback_audit";
const ROW_CLAIM_COLLECTION = "scp_qualification_sheet_writeback_claims";
const ROW_CLAIM_LEASE_MS = 2 * 60 * 1_000;
const SHEETS_UPDATE_TIMEOUT_MS = 30 * 1_000;
const WRITE_IN_FLIGHT_SAFETY_MARGIN_MS = 30 * 1_000;
const DECISIONS_COLLECTION = "qualification_decisions";
const SHEETS_VALUES_BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const A_TO_AK_COLUMNS = makeColumns("AK");
const ALLOWED_AG = ["합격", "불합격"] as const;
const ALLOWED_AH = ["장르불일치", "저티어국가", "구독자1K미만", "업로드빈도", "인게이지먼트", "중복지원", "유튜브없음", "비대상언어", "보류"] as const;

type QualificationSheetResult = typeof ALLOWED_AG[number];
type QualificationSheetReason = typeof ALLOWED_AH[number] | "";
type WritebackStatus = "dry_run" | "written" | "blocked" | "idempotent/noop";

export interface QualificationSheetWritebackInput {
  spreadsheetId?: unknown;
  tabName?: unknown;
  gid?: unknown;
  rowNumber?: unknown;
  rowNumbers?: unknown;
  rows?: unknown;
  sourceDecisionRef?: unknown;
  desiredAG?: unknown;
  desiredAH?: unknown;
  force?: unknown;
  dryRun?: unknown;
  actor?: unknown;
}

export interface QualificationSheetWritebackDeps {
  sheets?: SheetsClient;
  db?: FirestoreLike;
  now?: () => Date;
  sheetsUpdateTimeoutMs?: number;
}

export interface SheetsClient {
  validateSourceContract?(input: {
    spreadsheetId: string;
    tabName: string;
    gid: string;
  }): Promise<void>;
  getValues(input: { spreadsheetId: string; range: string }): Promise<unknown[][]>;
  updateValues(input: { spreadsheetId: string; range: string; values: string[][]; signal?: AbortSignal }): Promise<unknown>;
}

type FirestoreSnapshotLike = {
  exists?: boolean;
  data(): Record<string, unknown> | undefined;
  ref?: { path?: string };
};

type FirestoreDocumentRefLike = {
  set(value: Record<string, unknown>): Promise<unknown>;
  path?: string;
  id?: string;
};

type FirestoreTransactionLike = {
  get(ref: FirestoreDocumentRefLike): Promise<FirestoreSnapshotLike>;
  set(ref: FirestoreDocumentRefLike, value: Record<string, unknown>, options?: { merge?: boolean }): unknown;
  delete(ref: FirestoreDocumentRefLike): unknown;
};

type FirestoreLike = {
  doc(path: string): { get(): Promise<{ exists?: boolean; data(): Record<string, unknown> | undefined; ref?: { path?: string } }> };
  collection(name: string): { doc(id?: string): FirestoreDocumentRefLike };
  runTransaction<T>(update: (transaction: FirestoreTransactionLike) => Promise<T>): Promise<T>;
};

export interface QualificationSheetWritebackRowEvidence {
  rowNumber: number;
  current: { AG: string; AH: string };
  previous: { AG: string; AH: string };
  applicantHash: string;
  emailHash: string;
  youtubeHash: string;
  appHash: string;
  metricsHash: string;
}

type QualificationSheetWritebackRawRowEvidence = Omit<
  QualificationSheetWritebackRowEvidence,
  "applicantHash" | "emailHash" | "youtubeHash" | "appHash"
> & {
  email: string;
  youtubeUrl: string;
  app: string;
  range: string;
};

export interface QualificationSheetWritebackRowResult extends QualificationSheetWritebackRowEvidence {
  desired: { AG: QualificationSheetResult; AH: QualificationSheetReason };
  wrote: { AG: QualificationSheetResult; AH: QualificationSheetReason } | null;
  status: WritebackStatus;
  blockedReason?: string;
  auditRef?: string | null;
}

export interface QualificationSheetWritebackResult {
  ok: true;
  dryRun: boolean;
  sourceDecisionRef: string | null;
  updatePayload: Array<{
    rowNumber: number;
    columns: ["AG", "AH"];
    values: [[QualificationSheetResult, QualificationSheetReason]];
  }>;
  rows: QualificationSheetWritebackRowResult[];
  wroteCount: number;
  blockedCount: number;
  idempotentCount: number;
}

export function toPublicQualificationSheetWritebackResult(
  result: QualificationSheetWritebackResult,
): QualificationSheetWritebackResult {
  return {
    ok: true,
    dryRun: result.dryRun,
    sourceDecisionRef: result.sourceDecisionRef,
    updatePayload: result.updatePayload.map((payload) => ({
      rowNumber: payload.rowNumber,
      columns: ["AG", "AH"],
      values: [[payload.values[0][0], payload.values[0][1]]],
    })),
    rows: result.rows.map((row) => ({
      rowNumber: row.rowNumber,
      current: { AG: row.current.AG, AH: row.current.AH },
      previous: { AG: row.previous.AG, AH: row.previous.AH },
      applicantHash: row.applicantHash,
      emailHash: row.emailHash,
      youtubeHash: row.youtubeHash,
      appHash: row.appHash,
      metricsHash: row.metricsHash,
      desired: { AG: row.desired.AG, AH: row.desired.AH },
      wrote: row.wrote ? { AG: row.wrote.AG, AH: row.wrote.AH } : null,
      status: row.status,
      ...(row.blockedReason === undefined ? {} : { blockedReason: row.blockedReason }),
      ...(row.auditRef === undefined ? {} : { auditRef: row.auditRef }),
    })),
    wroteCount: result.wroteCount,
    blockedCount: result.blockedCount,
    idempotentCount: result.idempotentCount,
  };
}

export async function writeBackQualificationSheetResults(
  input: QualificationSheetWritebackInput = {},
  deps: QualificationSheetWritebackDeps = {},
): Promise<QualificationSheetWritebackResult> {
  const dryRun = input.dryRun === true;
  if (!dryRun) assertStagingExternalSideEffectAllowed("sheets-write");
  const db = (deps.db ?? adminDb) as FirestoreLike;
  const sheets = deps.sheets ?? makeAuthenticatedSheetsClient();
  const now = deps.now ?? (() => new Date());
  const sheetsUpdateTimeoutMs = boundedSheetsUpdateTimeout(deps.sheetsUpdateTimeoutMs);
  const writeInFlightLockMs = sheetsUpdateTimeoutMs + WRITE_IN_FLIGHT_SAFETY_MARGIN_MS + 1;
  assertCanonicalTargetInput(input);
  const spreadsheetId = SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID;
  const tabName = SCP_QUALIFICATION_REVIEW_TAB_NAME;
  const gid = SCP_QUALIFICATION_REVIEW_GID;
  if (sheets.validateSourceContract) {
    try {
      await sheets.validateSourceContract({ spreadsheetId, tabName, gid });
    } catch (error) {
      throw qualificationBoundaryException(
        error,
        "qualification_sheet_source_contract_failed",
      );
    }
  }
  const sourceDecisionRef = cleanDecisionRef(input.sourceDecisionRef);
  const authority = sourceDecisionRef ? await authorityFromDecisionRef(sourceDecisionRef, db) : null;
  const rowNumbers = authoritativeRowNumbers(input, authority);
  const desired = authority?.desired ?? explicitDesired(input.desiredAG, input.desiredAH);
  const force = input.force === true;
  const updatePayload: QualificationSheetWritebackResult["updatePayload"] = [];
  const rows: QualificationSheetWritebackRowResult[] = [];

  for (const rowNumber of rowNumbers) {
    const rereadRange = `${quoteSheetName(tabName)}!A${rowNumber}:AK${rowNumber}`;
    let values: unknown[][];
    try {
      values = await sheets.getValues({ spreadsheetId, range: rereadRange });
    } catch (error) {
      throw qualificationBoundaryException(error, "qualification_sheet_reread_failed");
    }
    const cells = cellsFromValues(values[0] ?? []);
    const evidence = rowEvidence(rowNumber, cells, tabName);
    const publicEvidence = piiMinimizedRowEvidence(evidence);
    if (authority) assertRowMatchesAuthority(evidence, cells, authority);
    const updateRange = `${quoteSheetName(tabName)}!AG${rowNumber}:AH${rowNumber}`;
    const payload = {
      rowNumber,
      columns: ["AG", "AH"] as ["AG", "AH"],
      values: [[desired.AG, desired.AH]] as [[QualificationSheetResult, QualificationSheetReason]],
    };
    updatePayload.push(payload);

    const idempotent = evidence.current.AG === desired.AG && evidence.current.AH === desired.AH;
    const conflict = conflictReason(evidence.current, desired);
    const deterministicAudit = sourceDecisionRef ? auditRefForSourceDecision(db, {
      sourceDecisionRef,
      spreadsheetId,
      tabName,
      gid,
      rowNumber,
      desired,
    }) : null;
    const operationKey = rowWriteOperationKey({ sourceDecisionRef, spreadsheetId, tabName, gid, rowNumber, desired });
    if (idempotent) {
      const reconciledAuditRef = deterministicAudit && !dryRun
        ? await reconcilePendingSourceDecisionAudit(db, deterministicAudit, {
          sourceDecisionRef,
          spreadsheetId,
          tabName,
          gid,
          rowNumber,
          desired,
          now,
        })
        : null;
      if (!dryRun) {
        await recordMatchingWritebackReadback(db, {
          spreadsheetId,
          tabName,
          gid,
          rowNumber,
          operationKey,
          desired,
          now,
        });
      }
      rows.push({ ...publicEvidence, desired, wrote: null, status: "idempotent/noop", auditRef: reconciledAuditRef });
      continue;
    }
    if (conflict && !force) {
      rows.push({ ...publicEvidence, desired, wrote: null, status: "blocked", blockedReason: conflict });
      continue;
    }
    if (dryRun) {
      rows.push({ ...publicEvidence, desired, wrote: desired, status: "dry_run" });
      continue;
    }

    let claim: RowWritebackClaim | null;
    try {
      claim = await acquireRowWritebackClaim(db, {
        spreadsheetId,
        tabName,
        gid,
        rowNumber,
        operationKey,
        desired,
        actor: actorFromInput(input),
        now,
      });
    } catch (error) {
      throw qualificationBoundaryException(error, "qualification_sheet_writeback_failed");
    }
    if (!claim) {
      rows.push({
        ...publicEvidence,
        desired,
        wrote: null,
        status: "blocked",
        blockedReason: "qualification_sheet_writeback_in_progress",
      });
      continue;
    }

    try {
      let claimedValues: unknown[][];
      try {
        claimedValues = await sheets.getValues({ spreadsheetId, range: rereadRange });
      } catch (error) {
        throw qualificationBoundaryException(error, "qualification_sheet_reread_failed");
      }
      const claimedCells = cellsFromValues(claimedValues[0] ?? []);
      const claimedEvidence = rowEvidence(rowNumber, claimedCells, tabName);
      if (authority) {
        try {
          assertRowMatchesAuthority(claimedEvidence, claimedCells, authority);
        } catch (error) {
          throw qualificationBoundaryException(error, "qualification_sheet_identity_changed");
        }
      }
      const claimedPublicEvidence = piiMinimizedRowEvidence(claimedEvidence);
      const claimedPair = claimedEvidence.current;
      const claimedIdempotent = claimedPair.AG === desired.AG && claimedPair.AH === desired.AH;
      if (claimedIdempotent) {
        const reconciledAuditRef = deterministicAudit
          ? await reconcilePendingSourceDecisionAudit(db, deterministicAudit, {
            sourceDecisionRef: sourceDecisionRef!,
            spreadsheetId,
            tabName,
            gid,
            rowNumber,
            desired,
            now,
          })
          : null;
        await recordMatchingWritebackReadback(db, {
          spreadsheetId,
          tabName,
          gid,
          rowNumber,
          operationKey,
          desired,
          now,
        });
        rows.push({ ...claimedPublicEvidence, desired, wrote: null, status: "idempotent/noop", auditRef: reconciledAuditRef });
        continue;
      }
      const claimedConflict = conflictReason(claimedPair, desired);
      const matchesRecoveryPreState = claim.quarantineRequired
        && claim.recoveryPreviousHash
        && claim.recoveryPreviousHash === rowWritePreviousHash(claimedPair);
      if ((claim.quarantineRequired && !matchesRecoveryPreState) || (claimedConflict && !force)) {
        rows.push({
          ...claimedPublicEvidence,
          desired,
          wrote: null,
          status: "blocked",
          blockedReason: claim.quarantineRequired ? "qualification_sheet_writeback_quarantined" : claimedConflict,
        });
        continue;
      }
      if (!(await renewRowWritebackClaimSafely(db, claim, now))) {
        rows.push({
          ...claimedPublicEvidence,
          desired,
          wrote: null,
          status: "blocked",
          blockedReason: "qualification_sheet_writeback_lease_lost",
        });
        continue;
      }

      const auditRef = deterministicAudit?.ref ?? db.collection(AUDIT_COLLECTION).doc();
      const auditRefPath = auditRef.path ?? `${AUDIT_COLLECTION}/${auditRef.id ?? "unknown"}`;
      const audit = {
        auditRef: auditRefPath,
        auditId: auditRef.id ?? null,
        auditPayloadDigest: deterministicAudit?.payloadDigest ?? null,
        source: auditSourceIdentity({ sourceDecisionRef, spreadsheetId, tabName, gid, rowNumber, desired }),
        rowNumber,
        previous: claimedEvidence.previous,
        intended: desired,
        actor: actorFromInput(input),
        subject: auditSubjectIdentity(claimedEvidence),
        status: "pending",
        metricsHash: claimedEvidence.metricsHash,
        createdAt: FieldValue.serverTimestamp(),
      };
      try {
        await auditRef.set(audit);
      } catch (error) {
        throw qualificationBoundaryException(error, "qualification_sheet_audit_prepare_failed");
      }
      if (!(await beginRowWriteInFlightSafely(db, claim, {
        previous: claimedPair,
        intended: desired,
        requestTimeoutMs: sheetsUpdateTimeoutMs,
        lockMs: writeInFlightLockMs,
        now,
      }))) {
        rows.push({
          ...claimedPublicEvidence,
          desired,
          wrote: null,
          status: "blocked",
          blockedReason: "qualification_sheet_writeback_lease_lost",
          auditRef: auditRef.path ?? null,
        });
        continue;
      }
      let updateAcknowledged = false;
      try {
        await updateSheetsValuesWithinDeadline(
          sheets,
          { spreadsheetId, range: updateRange, values: [[desired.AG, desired.AH]] },
          sheetsUpdateTimeoutMs,
        );
        updateAcknowledged = true;
      } catch (error) {
        let recoveryPair: { AG: string; AH: string } | null = null;
        try {
          recoveryPair = await rereadResultPair(sheets, spreadsheetId, updateRange);
        } catch {
          recoveryPair = null;
        }
        if (!(await markRowWriteInFlightUnknownSafely(db, claim, {
          observedMatchesIntended: recoveryPair?.AG === desired.AG && recoveryPair?.AH === desired.AH,
          observedMatchesPrevious: recoveryPair?.AG === claimedPair.AG && recoveryPair?.AH === claimedPair.AH,
          now,
        }))) {
          const leaseError = codedError("failed-precondition", "failed-precondition: qualification Sheet writeback lease ownership was lost");
          throw qualificationBoundaryException(leaseError, "qualification_sheet_writeback_lease_lost");
        }
        if (recoveryPair?.AG === desired.AG && recoveryPair?.AH === desired.AH) {
          updateAcknowledged = false;
        } else {
          const failure = qualificationBoundaryError(error, "qualification_sheet_update_unknown");
          await auditRef.set({
            ...audit,
            status: "pending",
            updateOutcome: "unknown",
            lastCheckedAtIso: now().toISOString(),
            failure,
          }).catch(() => undefined);
          throw qualificationBoundaryException(error, "qualification_sheet_update_unknown");
        }
      }

      let verifiedPair: { AG: string; AH: string };
      if (updateAcknowledged) {
        if (!(await markRowWriteInFlightConfirmedSafely(db, claim, now))) {
          const leaseError = codedError("failed-precondition", "failed-precondition: qualification Sheet writeback lease ownership was lost");
          throw qualificationBoundaryException(leaseError, "qualification_sheet_writeback_lease_lost");
        }
        try {
          verifiedPair = await rereadResultPair(sheets, spreadsheetId, updateRange);
        } catch (error) {
          const failure = qualificationBoundaryError(error, "qualification_sheet_verify_failed");
          await auditRef.set({ ...audit, status: "failed", failedAtIso: now().toISOString(), failure }).catch(() => undefined);
          throw qualificationBoundaryException(error, "qualification_sheet_verify_failed");
        }
      } else {
        verifiedPair = desired;
      }
      if (verifiedPair.AG !== desired.AG || verifiedPair.AH !== desired.AH) {
        const verificationError = codedError("failed-precondition", "failed-precondition: Sheet AG:AH verification mismatch");
        const failure = qualificationBoundaryError(verificationError, "qualification_sheet_verify_failed");
        await auditRef.set({ ...audit, status: "failed", failedAtIso: now().toISOString(), failure }).catch(() => undefined);
        throw qualificationBoundaryException(verificationError, "qualification_sheet_verify_failed");
      }

      if (!(await renewRowWritebackClaimSafely(db, claim, now))) {
        const leaseError = codedError("failed-precondition", "failed-precondition: qualification Sheet writeback lease ownership was lost");
        throw qualificationBoundaryException(leaseError, "qualification_sheet_writeback_lease_lost");
      }
      const wroteAtIso = now().toISOString();
      try {
        await auditRef.set({ ...audit, status: "written", wroteAtIso, wrote: desired });
      } catch (error) {
        throw qualificationBoundaryException(error, "qualification_sheet_audit_finalize_failed");
      }
      rows.push({ ...claimedPublicEvidence, desired, wrote: desired, status: "written", auditRef: auditRef.path ?? null });
    } finally {
      await releaseRowWritebackClaim(db, claim, now).catch(() => undefined);
    }
  }

  return {
    ok: true,
    dryRun,
    sourceDecisionRef: sourceDecisionRef || null,
    updatePayload,
    rows,
    wroteCount: rows.filter((row) => row.status === "written").length,
    blockedCount: rows.filter((row) => row.status === "blocked").length,
    idempotentCount: rows.filter((row) => row.status === "idempotent/noop").length,
  };
}

export async function writeBackQualificationSheetResultsCallable(request: CallableRequestShape) {
  const context = assertNonGuestAuth(request, ACTION, WRITE_ROLES);
  // 2026-09-27 codex adversarial review round 2 sweep: writes back to the scp qualification
  // review sheet — no general-purpose UI reaches it.
  await assertScpEntitled(context, request, ACTION);
  const payload = { ...asRecord(request.data), actor: actorFromContext(context) };
  const result = await writeBackQualificationSheetResults(payload);
  return toPublicQualificationSheetWritebackResult(result);
}

type SourceDecisionAuditIdentityInput = {
  sourceDecisionRef: string;
  spreadsheetId: string;
  tabName: string;
  gid: string;
  rowNumber: number;
  desired: { AG: QualificationSheetResult; AH: QualificationSheetReason };
};

type SourceDecisionAuditIdentity = {
  ref: ReturnType<FirestoreLike["collection"]>["doc"] extends (id?: string) => infer T ? T : never;
  id: string;
  path: string;
  payloadDigest: string;
};

type RowWritebackClaim = {
  ref: FirestoreDocumentRefLike;
  ownerKey: string;
  leaseVersion: string;
  operationKey: string;
  intended: { AG: QualificationSheetResult; AH: QualificationSheetReason };
  quarantineRequired: boolean;
  recoveryPreviousHash: string;
};

type RowWritebackClaimInput = {
  spreadsheetId: string;
  tabName: string;
  gid: string;
  rowNumber: number;
  operationKey: string;
  desired: { AG: QualificationSheetResult; AH: QualificationSheetReason };
  actor: Record<string, unknown>;
  now: () => Date;
};

async function acquireRowWritebackClaim(
  db: FirestoreLike,
  input: RowWritebackClaimInput,
): Promise<RowWritebackClaim | null> {
  const key = canonicalRowClaimKey(input);
  const id = `row_${createHash("sha256").update(key).digest("hex").slice(0, 48)}`;
  const ref = db.collection(ROW_CLAIM_COLLECTION).doc(id);
  const ownerKey = qualificationIdentityHash("writeback-lease-owner", randomUUID());
  const leaseVersion = qualificationIdentityHash("writeback-lease-version", randomUUID());
  const nowDate = input.now();
  const nowEpochMs = nowDate.getTime();
  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.data() ?? {};
    const writeInFlight = asRecord(current.writeInFlight);
    const inFlightStatus = cleanText(writeInFlight.status, "", 32);
    const unresolvedInFlight = inFlightStatus === "active" || inFlightStatus === "unknown";
    const sameOperation = cleanHash(writeInFlight.operationKey) === input.operationKey
      && resultPairMatches(writeInFlight.intended, input.desired);
    if (current.status === "quarantined" || inFlightStatus === "quarantined") {
      return { acquired: false, quarantineRequired: true };
    }
    if (unresolvedInFlight && !sameOperation) {
      return { acquired: false, quarantineRequired: true };
    }
    const activeLease = current.status === "processing"
      && Number(current.leaseUntilEpochMs) > nowEpochMs;
    const activeInFlightLock = unresolvedInFlight
      && Number(writeInFlight.takeoverAfterEpochMs) > nowEpochMs;
    if (activeLease || activeInFlightLock) return { acquired: false, quarantineRequired: unresolvedInFlight };
    const quarantineRequired = unresolvedInFlight && sameOperation;
    transaction.set(ref, {
      status: "processing",
      ownerKey,
      leaseVersion,
      operationKey: input.operationKey,
      intended: input.desired,
      quarantineRequired,
      leaseUntilEpochMs: nowEpochMs + ROW_CLAIM_LEASE_MS,
      leaseUntilIso: new Date(nowEpochMs + ROW_CLAIM_LEASE_MS).toISOString(),
      target: {
        spreadsheetHash: qualificationIdentityHash("spreadsheet", input.spreadsheetId),
        tabHash: qualificationIdentityHash("sheet-tab", input.tabName),
        gidHash: qualificationIdentityHash("sheet-gid", input.gid),
        rowNumber: input.rowNumber,
        columns: "AG:AH",
      },
      actor: actorFromRecord(input.actor),
      createdAt: FieldValue.serverTimestamp(),
    }, quarantineRequired ? { merge: true } : undefined);
    return {
      acquired: true,
      quarantineRequired,
      recoveryPreviousHash: quarantineRequired ? cleanHash(writeInFlight.previousHash) : "",
    };
  });
  if (!result.acquired) return null;
  return {
    ref,
    ownerKey,
    leaseVersion,
    operationKey: input.operationKey,
    intended: input.desired,
    quarantineRequired: result.quarantineRequired,
    recoveryPreviousHash: result.recoveryPreviousHash ?? "",
  };
}

async function renewRowWritebackClaimSafely(
  db: FirestoreLike,
  claim: RowWritebackClaim,
  now: () => Date,
): Promise<boolean> {
  try {
    return await renewRowWritebackClaim(db, claim, now);
  } catch (error) {
    throw qualificationBoundaryException(error, "qualification_sheet_writeback_lease_lost");
  }
}

async function renewRowWritebackClaim(
  db: FirestoreLike,
  claim: RowWritebackClaim,
  now: () => Date,
): Promise<boolean> {
  const nowEpochMs = now().getTime();
  if (!Number.isFinite(nowEpochMs)) return false;
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(claim.ref);
    const current = snapshot.data() ?? {};
    const ownsUnexpiredLease = current.status === "processing"
      && current.ownerKey === claim.ownerKey
      && current.leaseVersion === claim.leaseVersion
      && current.operationKey === claim.operationKey
      && Number(current.leaseUntilEpochMs) > nowEpochMs;
    if (!ownsUnexpiredLease) return false;
    transaction.set(claim.ref, {
      leaseUntilEpochMs: nowEpochMs + ROW_CLAIM_LEASE_MS,
      leaseUntilIso: new Date(nowEpochMs + ROW_CLAIM_LEASE_MS).toISOString(),
      renewedAtIso: new Date(nowEpochMs).toISOString(),
    }, { merge: true });
    return true;
  });
}

type BeginRowWriteInFlightInput = {
  previous: { AG: string; AH: string };
  intended: { AG: QualificationSheetResult; AH: QualificationSheetReason };
  requestTimeoutMs: number;
  lockMs: number;
  now: () => Date;
};

async function beginRowWriteInFlightSafely(
  db: FirestoreLike,
  claim: RowWritebackClaim,
  input: BeginRowWriteInFlightInput,
): Promise<boolean> {
  try {
    const nowEpochMs = input.now().getTime();
    if (!Number.isFinite(nowEpochMs)) return false;
    return await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(claim.ref);
      const current = snapshot.data() ?? {};
      const ownsUnexpiredLease = current.status === "processing"
        && current.ownerKey === claim.ownerKey
        && current.leaseVersion === claim.leaseVersion
        && current.operationKey === claim.operationKey
        && Number(current.leaseUntilEpochMs) > nowEpochMs;
      if (!ownsUnexpiredLease) return false;
      const requestDeadlineEpochMs = nowEpochMs + input.requestTimeoutMs;
      const takeoverAfterEpochMs = nowEpochMs + input.lockMs;
      const leaseUntilEpochMs = Math.max(Number(current.leaseUntilEpochMs) || 0, takeoverAfterEpochMs);
      transaction.set(claim.ref, {
        leaseUntilEpochMs,
        leaseUntilIso: new Date(leaseUntilEpochMs).toISOString(),
        writeInFlight: {
          status: "active",
          operationKey: claim.operationKey,
          intended: input.intended,
          previousHash: rowWritePreviousHash(input.previous),
          requestTimeoutMs: input.requestTimeoutMs,
          requestDeadlineEpochMs,
          requestDeadlineIso: new Date(requestDeadlineEpochMs).toISOString(),
          takeoverAfterEpochMs,
          takeoverAfterIso: new Date(takeoverAfterEpochMs).toISOString(),
          startedAtIso: new Date(nowEpochMs).toISOString(),
        },
      }, { merge: true });
      return true;
    });
  } catch (error) {
    throw qualificationBoundaryException(error, "qualification_sheet_writeback_lease_lost");
  }
}

async function markRowWriteInFlightUnknownSafely(
  db: FirestoreLike,
  claim: RowWritebackClaim,
  input: { observedMatchesIntended: boolean; observedMatchesPrevious: boolean; now: () => Date },
): Promise<boolean> {
  try {
    const nowEpochMs = input.now().getTime();
    if (!Number.isFinite(nowEpochMs)) return false;
    return await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(claim.ref);
      const current = snapshot.data() ?? {};
      const writeInFlight = asRecord(current.writeInFlight);
      const ownsFlight = current.status === "processing"
        && current.ownerKey === claim.ownerKey
        && current.leaseVersion === claim.leaseVersion
        && current.operationKey === claim.operationKey
        && writeInFlight.operationKey === claim.operationKey
        && (writeInFlight.status === "active" || writeInFlight.status === "unknown");
      if (!ownsFlight) return false;
      const takeoverAfterEpochMs = Math.max(
        Number(writeInFlight.takeoverAfterEpochMs) || 0,
        nowEpochMs + WRITE_IN_FLIGHT_SAFETY_MARGIN_MS,
      );
      const leaseUntilEpochMs = Math.max(Number(current.leaseUntilEpochMs) || 0, takeoverAfterEpochMs);
      transaction.set(claim.ref, {
        leaseUntilEpochMs,
        leaseUntilIso: new Date(leaseUntilEpochMs).toISOString(),
        writeInFlight: {
          ...writeInFlight,
          status: "unknown",
          operationKey: claim.operationKey,
          intended: claim.intended,
          observedMatchesIntended: input.observedMatchesIntended,
          observedMatchesPrevious: input.observedMatchesPrevious,
          lastCheckedAtIso: new Date(nowEpochMs).toISOString(),
          takeoverAfterEpochMs,
          takeoverAfterIso: new Date(takeoverAfterEpochMs).toISOString(),
        },
      }, { merge: true });
      return true;
    });
  } catch (error) {
    throw qualificationBoundaryException(error, "qualification_sheet_writeback_lease_lost");
  }
}

async function markRowWriteInFlightConfirmedSafely(
  db: FirestoreLike,
  claim: RowWritebackClaim,
  now: () => Date,
): Promise<boolean> {
  try {
    const nowEpochMs = now().getTime();
    if (!Number.isFinite(nowEpochMs)) return false;
    return await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(claim.ref);
      const current = snapshot.data() ?? {};
      const writeInFlight = asRecord(current.writeInFlight);
      const ownsUnexpiredFlight = current.status === "processing"
        && current.ownerKey === claim.ownerKey
        && current.leaseVersion === claim.leaseVersion
        && current.operationKey === claim.operationKey
        && Number(current.leaseUntilEpochMs) > nowEpochMs
        && writeInFlight.status === "active"
        && writeInFlight.operationKey === claim.operationKey
        && Number(writeInFlight.takeoverAfterEpochMs) > nowEpochMs;
      if (!ownsUnexpiredFlight) return false;
      const leaseUntilEpochMs = nowEpochMs + ROW_CLAIM_LEASE_MS;
      transaction.set(claim.ref, {
        leaseUntilEpochMs,
        leaseUntilIso: new Date(leaseUntilEpochMs).toISOString(),
        writeInFlight: {
          ...writeInFlight,
          status: "confirmed",
          confirmedAtIso: new Date(nowEpochMs).toISOString(),
        },
      }, { merge: true });
      return true;
    });
  } catch (error) {
    throw qualificationBoundaryException(error, "qualification_sheet_writeback_lease_lost");
  }
}

async function releaseRowWritebackClaim(db: FirestoreLike, claim: RowWritebackClaim, now: () => Date): Promise<void> {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(claim.ref);
    const current = snapshot.data() ?? {};
    const ownsClaim = current.status === "processing"
      && current.ownerKey === claim.ownerKey
      && current.leaseVersion === claim.leaseVersion
      && current.operationKey === claim.operationKey;
    if (!ownsClaim) return;
    const writeInFlight = asRecord(current.writeInFlight);
    if (claim.quarantineRequired) {
      transaction.set(claim.ref, {
        status: "quarantined",
        operationKey: claim.operationKey,
        intended: claim.intended,
        quarantineRequired: true,
        writeInFlight: {
          ...writeInFlight,
          status: "quarantined",
          operationKey: claim.operationKey,
          intended: claim.intended,
        },
        quarantinedAtIso: now().toISOString(),
      }, { merge: true });
      return;
    }
    if (writeInFlight.status === "active" || writeInFlight.status === "unknown" || writeInFlight.status === "quarantined") return;
    transaction.delete(claim.ref);
  });
}

async function recordMatchingWritebackReadback(
  db: FirestoreLike,
  input: Pick<RowWritebackClaimInput, "spreadsheetId" | "tabName" | "gid" | "rowNumber" | "operationKey" | "desired" | "now">,
): Promise<void> {
  try {
    const ref = rowWritebackClaimRef(db, input);
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return;
      const current = snapshot.data() ?? {};
      const writeInFlight = asRecord(current.writeInFlight);
      const matchingUnknownOperation = cleanHash(writeInFlight.operationKey) === input.operationKey
        && resultPairMatches(writeInFlight.intended, input.desired)
        && (writeInFlight.status === "active" || writeInFlight.status === "unknown" || writeInFlight.status === "quarantined");
      const matchingQuarantine = current.status === "quarantined"
        && cleanHash(current.operationKey) === input.operationKey
        && resultPairMatches(current.intended, input.desired);
      if (!matchingUnknownOperation && !matchingQuarantine) return;
      transaction.set(ref, {
        status: "quarantined",
        operationKey: input.operationKey,
        intended: input.desired,
        quarantineRequired: true,
        writeInFlight: {
          ...writeInFlight,
          status: "quarantined",
          operationKey: input.operationKey,
          intended: input.desired,
          observedMatchesIntended: true,
          lastCheckedAtIso: input.now().toISOString(),
        },
        quarantinedAtIso: input.now().toISOString(),
      }, { merge: true });
    });
  } catch (error) {
    throw qualificationBoundaryException(error, "qualification_sheet_writeback_failed");
  }
}

function canonicalRowClaimKey(input: Pick<RowWritebackClaimInput, "spreadsheetId" | "tabName" | "gid" | "rowNumber">): string {
  return JSON.stringify({
    spreadsheetId: input.spreadsheetId,
    tabName: input.tabName,
    gid: input.gid,
    rowNumber: input.rowNumber,
  });
}

function rowWritebackClaimRef(
  db: FirestoreLike,
  input: Pick<RowWritebackClaimInput, "spreadsheetId" | "tabName" | "gid" | "rowNumber">,
): FirestoreDocumentRefLike {
  const id = `row_${createHash("sha256").update(canonicalRowClaimKey(input)).digest("hex").slice(0, 48)}`;
  return db.collection(ROW_CLAIM_COLLECTION).doc(id);
}

function resultPairMatches(value: unknown, expected: { AG: string; AH: string }): boolean {
  const pair = asRecord(value);
  return pair.AG === expected.AG && pair.AH === expected.AH;
}

function rowWritePreviousHash(value: { AG: string; AH: string }): string {
  return qualificationIdentityHash("sheet-write-previous", JSON.stringify(value));
}

function rowWriteOperationKey(input: {
  sourceDecisionRef: string;
  spreadsheetId: string;
  tabName: string;
  gid: string;
  rowNumber: number;
  desired: { AG: QualificationSheetResult; AH: QualificationSheetReason };
}): string {
  return createHash("sha256").update(JSON.stringify({
    sourceDecisionHash: qualificationIdentityHash("source-decision", input.sourceDecisionRef || "operator-explicit"),
    target: {
      spreadsheetHash: qualificationIdentityHash("spreadsheet", input.spreadsheetId),
      tabHash: qualificationIdentityHash("sheet-tab", input.tabName),
      gidHash: qualificationIdentityHash("sheet-gid", input.gid),
      rowNumber: input.rowNumber,
      columns: "AG:AH",
    },
    intended: input.desired,
  })).digest("hex");
}

function boundedSheetsUpdateTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return SHEETS_UPDATE_TIMEOUT_MS;
  return Math.max(1, Math.min(SHEETS_UPDATE_TIMEOUT_MS, Math.trunc(value)));
}

async function updateSheetsValuesWithinDeadline(
  sheets: SheetsClient,
  input: { spreadsheetId: string; range: string; values: string[][] },
  timeoutMs: number,
): Promise<void> {
  // Defense in depth: even a future caller that bypasses the service-level
  // dry-run branch must not issue a Sheets PUT from staging.
  assertStagingExternalSideEffectAllowed("sheets-write");
  const controller = new AbortController();
  const timeoutError = codedError("deadline-exceeded", "deadline-exceeded: Google Sheets update exceeded its bounded request lifetime");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    const request = Promise.resolve().then(() => sheets.updateValues({ ...input, signal: controller.signal }));
    await Promise.race([request, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function rereadResultPair(
  sheets: SheetsClient,
  spreadsheetId: string,
  range: string,
): Promise<{ AG: string; AH: string }> {
  const values = await sheets.getValues({ spreadsheetId, range });
  const row = values[0] ?? [];
  return {
    AG: cleanText(row[0], "", 120),
    AH: cleanText(row[1], "", 120),
  };
}

function auditRefForSourceDecision(db: FirestoreLike, input: SourceDecisionAuditIdentityInput): SourceDecisionAuditIdentity {
  const key = canonicalAuditPayload(input);
  const payloadDigest = createHash("sha256").update(key).digest("hex");
  const id = `src_${payloadDigest.slice(0, 48)}`;
  const ref = db.collection(AUDIT_COLLECTION).doc(id);
  return { ref, id, path: ref.path ?? `${AUDIT_COLLECTION}/${id}`, payloadDigest };
}

async function reconcilePendingSourceDecisionAudit(
  db: FirestoreLike,
  audit: SourceDecisionAuditIdentity,
  input: SourceDecisionAuditIdentityInput & { now: () => Date },
): Promise<string | null> {
  const snapshot = await db.doc(audit.path).get();
  if (!snapshot.exists) return null;
  const pending = snapshot.data() ?? {};
  if (!matchesPendingSourceDecisionAudit(pending, audit, input)) return null;
  await audit.ref.set({
    auditRef: cleanText(pending.auditRef, audit.path, 300) || audit.path,
    auditId: cleanText(pending.auditId, audit.id, 180) || audit.id,
    auditPayloadDigest: cleanText(pending.auditPayloadDigest, audit.payloadDigest, 128) || audit.payloadDigest,
    source: auditSourceIdentity(input),
    rowNumber: input.rowNumber,
    previous: resultPair(pending.previous),
    intended: input.desired,
    actor: actorFromRecord(pending.actor),
    subject: auditSubjectFromRecord(pending.subject),
    metricsHash: cleanHash(pending.metricsHash),
    status: "written",
    wrote: input.desired,
    createdAt: pending.createdAt ?? FieldValue.serverTimestamp(),
    reconciledAtIso: input.now().toISOString(),
  });
  return audit.path;
}

function matchesPendingSourceDecisionAudit(
  value: Record<string, unknown>,
  audit: SourceDecisionAuditIdentity,
  input: SourceDecisionAuditIdentityInput,
): boolean {
  if (value.status !== "pending") return false;
  if (cleanText(value.auditPayloadDigest, "", 128) && cleanText(value.auditPayloadDigest, "", 128) !== audit.payloadDigest) return false;
  const source = asRecord(value.source);
  const expectedSource = auditSourceIdentity(input);
  if (cleanHash(source.decisionHash) !== expectedSource.decisionHash) return false;
  if (cleanHash(source.spreadsheetHash) !== expectedSource.spreadsheetHash) return false;
  if (cleanHash(source.tabHash) !== expectedSource.tabHash) return false;
  if (cleanHash(source.gidHash) !== expectedSource.gidHash) return false;
  if (Number(value.rowNumber) !== input.rowNumber) return false;
  const intended = asRecord(value.intended);
  return intended.AG === input.desired.AG && intended.AH === input.desired.AH;
}

function auditSourceIdentity(input: SourceDecisionAuditIdentityInput): Record<string, unknown> {
  return {
    decisionHash: qualificationIdentityHash("source-decision", input.sourceDecisionRef),
    spreadsheetHash: qualificationIdentityHash("spreadsheet", input.spreadsheetId),
    tabHash: qualificationIdentityHash("sheet-tab", input.tabName),
    gidHash: qualificationIdentityHash("sheet-gid", input.gid),
    rowNumber: input.rowNumber,
    columns: "AG:AH",
  };
}

function canonicalAuditPayload(input: SourceDecisionAuditIdentityInput): string {
  return JSON.stringify({
    sourceDecisionRef: input.sourceDecisionRef,
    target: {
      spreadsheetId: input.spreadsheetId,
      tabName: input.tabName,
      gid: input.gid,
      rowNumber: input.rowNumber,
      range: `${quoteSheetName(input.tabName)}!AG${input.rowNumber}:AH${input.rowNumber}`,
    },
    desired: input.desired,
  });
}

type DecisionAuthority = {
  desired: { AG: QualificationSheetResult; AH: QualificationSheetReason };
  rowNumber: number;
  email: string;
  youtubeUrl: string;
  app: string;
  category: string;
  rowHash: string;
};

type DecisionSourceSnapshot = {
  sourceId: string;
  spreadsheetId: string;
  gid: string;
  tabName: string;
  rowNumber: number;
  sourceHash: string;
  sourceRef: string;
  sourceUrl: string;
  rowHash: string;
};

async function authorityFromDecisionRef(ref: string, db: FirestoreLike): Promise<DecisionAuthority> {
  const snapshot = await db.doc(ref).get();
  if (!snapshot.exists) throw codedError("not-found", `not-found: source decision not found (${ref})`);
  const decision = snapshot.data() ?? {};
  const finalVerdict = decision.finalVerdict === "pass" || decision.finalVerdict === "fail" ? decision.finalVerdict : null;
  if (!finalVerdict) throw codedError("failed-precondition", "failed-precondition: source decision has no persisted pass/fail finalVerdict");

  const source = decisionSourceSnapshot(decision.sourceSnapshot);
  const raw = await rawRowFromDecisionSnapshot(source, db);
  assertRawMatchesDecisionSourceSnapshot(raw, source);
  const rawCells = asRecord(raw.rawCells);
  return {
    desired: {
      AG: finalVerdict === "pass" ? "합격" : "불합격",
      AH: finalVerdict === "pass"
        ? ""
        : normalizeReasonForAuthority(decision.finalReason ?? firstArrayValue(asRecord(decision.aiRecommendation).reasons) ?? firstArrayValue(asRecord(decision.aiRecommendation).policyFlags), raw),
    },
    rowNumber: source.rowNumber,
    email: normalizeEmail(rawCells.D),
    youtubeUrl: normalizeUrl(rawCells.R),
    app: cleanText(rawCells.K ?? rawCells.B, "", 160),
    category: cleanText(rawCells.N ?? rawCells.J, "", 160),
    rowHash: source.rowHash,
  };
}

function authoritativeRowNumbers(input: QualificationSheetWritebackInput, authority: DecisionAuthority | null): number[] {
  const requested = parseRowNumbers(input);
  if (!authority) {
    if (requested.length === 0) throw codedError("invalid-argument", "invalid-argument: rowNumber or rowNumbers is required");
    return requested;
  }
  if (requested.length === 0) return [authority.rowNumber];
  if (requested.length !== 1 || requested[0] !== authority.rowNumber) {
    throw codedError("failed-precondition", "failed-precondition: requested rowNumber does not match source decision lead row");
  }
  return requested;
}

function assertCanonicalTargetInput(input: QualificationSheetWritebackInput): void {
  if (input.spreadsheetId !== undefined && cleanSpreadsheetId(input.spreadsheetId, "") !== SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID) {
    throw codedError("failed-precondition", "failed-precondition: spreadsheetId must match the server-owned SCP qualification Sheet");
  }
  if (input.tabName !== undefined && cleanText(input.tabName, "", 120) !== SCP_QUALIFICATION_REVIEW_TAB_NAME) {
    throw codedError("failed-precondition", "failed-precondition: tabName must match the server-owned SCP qualification tab");
  }
  if (input.gid !== undefined && cleanText(input.gid, "", 32) !== SCP_QUALIFICATION_REVIEW_GID) {
    throw codedError("failed-precondition", "failed-precondition: gid must match the server-owned SCP qualification tab gid");
  }
}

function decisionSourceSnapshot(value: unknown): DecisionSourceSnapshot {
  const source = asRecord(value);
  if (Object.keys(source).length === 0) throw codedError("failed-precondition", "failed-precondition: source decision is missing immutable source snapshot");
  if (cleanText(source.sourceType, "", 40) !== "google_sheet") throw codedError("failed-precondition", "failed-precondition: source snapshot sourceType is not canonical google_sheet");
  const expectedSourceId = sourceIdForGoogleSheet(SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID);
  const sourceId = cleanText(source.sourceId, "", 260);
  if (sourceId !== expectedSourceId) throw codedError("failed-precondition", "failed-precondition: source snapshot sourceId is not the canonical SCP qualification Sheet");
  const sheetId = cleanSpreadsheetId(source.sheetId, "");
  const spreadsheetId = cleanSpreadsheetId(source.spreadsheetId, "");
  if (sheetId !== SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID || spreadsheetId !== sheetId) {
    throw codedError("failed-precondition", "failed-precondition: source snapshot sheetId/spreadsheetId is not canonical");
  }
  const gid = cleanText(source.gid, "", 32);
  if (gid !== SCP_QUALIFICATION_REVIEW_GID) throw codedError("failed-precondition", "failed-precondition: source snapshot gid is not canonical");
  const tabName = cleanText(source.tabName, "", 120);
  if (tabName !== SCP_QUALIFICATION_REVIEW_TAB_NAME) throw codedError("failed-precondition", "failed-precondition: source snapshot tabName is not canonical");
  const rowNumber = parseRowNumberValue(source.rowNumber, "source snapshot rowNumber");
  const sourceHash = cleanSourceHash(source.sourceHash, "source snapshot sourceHash");
  const sourceRef = cleanText(source.sourceRef, "", 300);
  if (!/^sheet_raw_rows\/[a-zA-Z0-9_:-]{1,240}$/.test(sourceRef)) throw codedError("failed-precondition", "failed-precondition: source snapshot sourceRef is missing or invalid");
  const sourceUrl = cleanText(source.sourceUrl, "", 1_000);
  const expectedSourceUrl = `https://docs.google.com/spreadsheets/d/${SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID}/edit#gid=${SCP_QUALIFICATION_REVIEW_GID}&range=A${rowNumber}`;
  if (sourceUrl !== expectedSourceUrl) throw codedError("failed-precondition", "failed-precondition: source snapshot sourceUrl does not match its canonical row identity");
  return { sourceId, spreadsheetId, gid, tabName, rowNumber, sourceHash, sourceRef, sourceUrl, rowHash: cleanSourceHash(source.rowHash, "source snapshot rowHash") };
}

async function rawRowFromDecisionSnapshot(source: DecisionSourceSnapshot, db: FirestoreLike): Promise<Record<string, unknown>> {
  const snapshot = await db.doc(source.sourceRef).get();
  if (!snapshot.exists) throw codedError("not-found", `not-found: source lead raw row not found (${source.sourceRef})`);
  return snapshot.data() ?? {};
}

function assertRawMatchesDecisionSourceSnapshot(raw: Record<string, unknown>, source: DecisionSourceSnapshot): void {
  if (cleanText(raw.sourceId, "", 260) !== source.sourceId) throw codedError("failed-precondition", "failed-precondition: source raw row sourceId does not match decision snapshot");
  if (cleanSpreadsheetId(raw.spreadsheetId, "") !== source.spreadsheetId) throw codedError("failed-precondition", "failed-precondition: source raw row spreadsheetId does not match decision snapshot");
  if (cleanText(raw.gid, "", 32) !== source.gid) throw codedError("failed-precondition", "failed-precondition: source raw row gid does not match decision snapshot");
  if (cleanText(raw.tabName, "", 120) !== source.tabName) throw codedError("failed-precondition", "failed-precondition: source raw row tabName does not match decision snapshot");
  if (parseRowNumberValue(raw.rowNumber, "source raw row rowNumber") !== source.rowNumber) throw codedError("failed-precondition", "failed-precondition: source raw row rowNumber does not match decision snapshot");
  if (cleanSourceHash(raw.rowHash, "source raw row rowHash") !== source.rowHash) throw codedError("failed-precondition", "failed-precondition: source raw row rowHash does not match decision snapshot");
  const rawSourceHash = cleanText(raw.sourceHash, "", 128);
  if (rawSourceHash && cleanSourceHash(rawSourceHash, "source raw row sourceHash") !== source.sourceHash) throw codedError("failed-precondition", "failed-precondition: source raw row sourceHash does not match decision snapshot");
}

function cleanSourceHash(value: unknown, fieldName: string): string {
  const hash = cleanText(value, "", 128);
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw codedError("failed-precondition", `failed-precondition: ${fieldName} must be a sha256 hash`);
  return hash.toLowerCase();
}

function assertRowMatchesAuthority(evidence: QualificationSheetWritebackRawRowEvidence, cells: Record<string, string>, authority: DecisionAuthority): void {
  if (evidence.rowNumber !== authority.rowNumber) throw codedError("failed-precondition", "failed-precondition: Sheet row does not match source decision rowNumber");
  const actualEmail = normalizeEmail(evidence.email);
  const actualYoutube = normalizeUrl(evidence.youtubeUrl);
  if (authority.email && actualEmail !== authority.email) throw codedError("failed-precondition", "failed-precondition: Sheet row email does not match source decision lead");
  if (authority.youtubeUrl && actualYoutube !== authority.youtubeUrl) throw codedError("failed-precondition", "failed-precondition: Sheet row youtubeUrl does not match source decision lead");
  const actualApp = cleanText(evidence.app, "", 160);
  if (authority.app && actualApp && actualApp !== authority.app) throw codedError("failed-precondition", "failed-precondition: Sheet row app does not match source decision lead");
  if (authority.category && cells.J && cleanText(cells.J, "", 160) !== authority.category) throw codedError("failed-precondition", "failed-precondition: Sheet row category does not match source decision lead");
  if (sha256AtoZ(cells) !== authority.rowHash) throw codedError("failed-precondition", "failed-precondition: Sheet row hash does not match source decision lead");
}

function normalizeEmail(value: unknown): string {
  return cleanText(value, "", 240).toLowerCase();
}

function normalizeUrl(value: unknown): string {
  return cleanText(value, "", 1_000).replace(/\/+$/, "").toLowerCase();
}

function explicitDesired(ag: unknown, ah: unknown): { AG: QualificationSheetResult; AH: QualificationSheetReason } {
  // Operator-only admin/RBAC escape hatch when sourceDecisionRef is absent; still canonical-target, no-overwrite, and audit guarded.
  if (!isAllowedAg(ag)) throw codedError("invalid-argument", "invalid-argument: desiredAG must be exactly 합격 or 불합격 when sourceDecisionRef is absent");
  if (ag === "합격") {
    if (cleanText(ah, "", 120)) throw codedError("invalid-argument", "invalid-argument: desiredAH must be blank when desiredAG is 합격");
    return { AG: ag, AH: "" };
  }
  if (!isAllowedAh(ah)) throw codedError("invalid-argument", "invalid-argument: desiredAH must be an allowed one-token reason");
  return { AG: ag, AH: ah };
}

function rowEvidence(rowNumber: number, cells: Record<string, string>, tabName: string): QualificationSheetWritebackRawRowEvidence {
  return {
    rowNumber,
    current: { AG: cells.AG ?? "", AH: cells.AH ?? "" },
    previous: { AG: cells.AG ?? "", AH: cells.AH ?? "" },
    email: (cells.D ?? "").toLowerCase(),
    youtubeUrl: cells.R ?? "",
    app: cells.K || cells.B || "",
    metricsHash: hashMetrics(cells),
    range: `${quoteSheetName(tabName)}!A${rowNumber}:AK${rowNumber}`,
  };
}

function piiMinimizedRowEvidence(evidence: QualificationSheetWritebackRawRowEvidence): QualificationSheetWritebackRowEvidence {
  const subject = auditSubjectIdentity(evidence);
  return {
    rowNumber: evidence.rowNumber,
    current: evidence.current,
    previous: evidence.previous,
    applicantHash: subject.applicantHash,
    emailHash: subject.emailHash,
    youtubeHash: subject.youtubeHash,
    appHash: subject.appHash,
    metricsHash: evidence.metricsHash,
  };
}

function auditSubjectIdentity(evidence: Pick<QualificationSheetWritebackRawRowEvidence, "email" | "youtubeUrl" | "app">) {
  const email = normalizeEmail(evidence.email);
  const youtubeUrl = normalizeUrl(evidence.youtubeUrl);
  const app = cleanText(evidence.app, "", 160);
  return {
    applicantHash: qualificationIdentityHash("applicant", `${email}\0${youtubeUrl}`),
    emailHash: qualificationIdentityHash("applicant-email", email),
    youtubeHash: qualificationIdentityHash("applicant-youtube", youtubeUrl),
    appHash: qualificationIdentityHash("source-app", app),
  };
}

function conflictReason(current: { AG: string; AH: string }, desired: { AG: string; AH: string }): string {
  const conflicts: string[] = [];
  if (current.AG && !isNonHumanAgPlaceholder(current.AG) && current.AG !== desired.AG) conflicts.push(`AG current ${current.AG} differs from desired ${desired.AG}`);
  if (current.AH && current.AH !== desired.AH) conflicts.push(`AH current ${current.AH} differs from desired ${desired.AH}`);
  return conflicts.join("; ");
}

function isNonHumanAgPlaceholder(value: string): boolean {
  const normalized = value.replace(/[\s/_-]+/g, "").toLowerCase();
  return ["pending", "unreviewed", "reviewpending", "미검수", "검수대기", "대기", "보류", "미심사", "심사대기", "미확인"].includes(normalized);
}

function parseRowNumbers(input: QualificationSheetWritebackInput): number[] {
  if (Array.isArray(input.rowNumbers)) return [...new Set(input.rowNumbers.map((value) => parseRowNumberValue(value, "rowNumbers[]")))];
  if (Array.isArray(input.rows)) return [...new Set(input.rows.map((row) => parseRowNumberValue(asRecord(row).rowNumber, "rows[].rowNumber")))];
  const rowNumber = parseOptionalRowNumber(input.rowNumber, "rowNumber");
  return rowNumber === undefined ? [] : [rowNumber];
}

function parseOptionalRowNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return parseRowNumberValue(value, fieldName);
}

function parseRowNumberValue(value: unknown, fieldName: string): number {
  let parsed = Number.NaN;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string" && value.trim()) parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) {
    throw codedError("invalid-argument", `invalid-argument: ${fieldName} must be an integer from 1 to 100000`);
  }
  return parsed;
}

function cellsFromValues(values: unknown[]): Record<string, string> {
  return Object.fromEntries(A_TO_AK_COLUMNS.map((column, index) => [column, cleanText(values[index], "", 2_000)]));
}

function makeAuthenticatedSheetsClient(): SheetsClient {
  return {
    async validateSourceContract(input) {
      const accessToken = await sheetsAccessToken();
      const metadataUrl = new URL(
        `${SHEETS_VALUES_BASE_URL}/${encodeURIComponent(input.spreadsheetId)}`,
      );
      metadataUrl.searchParams.set("includeGridData", "false");
      metadataUrl.searchParams.set("fields", "sheets.properties(sheetId,title)");
      const metadataResponse = await fetch(metadataUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!metadataResponse.ok) {
        throw codedError(
          "failed-precondition",
          `failed-precondition: Google Sheets source metadata read failed with HTTP ${metadataResponse.status}`,
        );
      }
      const metadata = await metadataResponse.json() as {
        sheets?: Array<{ properties?: { sheetId?: unknown; title?: unknown } }>;
      };
      const resolved = Array.isArray(metadata.sheets)
        ? metadata.sheets.find(
            (sheet) => Number(sheet.properties?.sheetId) === Number(input.gid),
          )
        : undefined;
      if (cleanText(resolved?.properties?.title, "", 120) !== input.tabName) {
        throw codedError(
          "failed-precondition",
          "failed-precondition: Google Sheets writeback gid/tab contract mismatch",
        );
      }
      const headerRange = `${quoteSheetName(input.tabName)}!AG1:AH1`;
      const headerUrl = new URL(
        `${SHEETS_VALUES_BASE_URL}/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(headerRange)}`,
      );
      headerUrl.searchParams.set("majorDimension", "ROWS");
      const headerResponse = await fetch(headerUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!headerResponse.ok) {
        throw codedError(
          "failed-precondition",
          `failed-precondition: Google Sheets writeback header read failed with HTTP ${headerResponse.status}`,
        );
      }
      const header = await headerResponse.json() as { values?: unknown[][] };
      const cells = Array.isArray(header.values?.[0]) ? header.values?.[0] ?? [] : [];
      if (
        cleanText(cells[0], "", 120) !== "비고" ||
        cleanText(cells[1], "", 120) !== "사유"
      ) {
        throw codedError(
          "failed-precondition",
          "failed-precondition: Google Sheets writeback AG/AH header contract mismatch",
        );
      }
    },
    async getValues(input) {
      const accessToken = await sheetsAccessToken();
      const url = new URL(`${SHEETS_VALUES_BASE_URL}/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.range)}`);
      url.searchParams.set("majorDimension", "ROWS");
      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw codedError("failed-precondition", `failed-precondition: Google Sheets reread failed with HTTP ${response.status}`);
      const body = await response.json() as { values?: unknown[][] };
      return Array.isArray(body.values) ? body.values : [];
    },
    async updateValues(input) {
      const accessToken = await sheetsAccessToken();
      const url = new URL(`${SHEETS_VALUES_BASE_URL}/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.range)}`);
      url.searchParams.set("valueInputOption", "USER_ENTERED");
      const response = await fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ range: input.range, majorDimension: "ROWS", values: input.values }),
        signal: input.signal,
      });
      if (!response.ok) throw codedError("failed-precondition", `failed-precondition: Google Sheets update failed with HTTP ${response.status}`);
      return response.json();
    },
  };
}

async function sheetsAccessToken(): Promise<string> {
  const env = envString("GOOGLE_SHEETS_ACCESS_TOKEN") || envString("SHEETS_ACCESS_TOKEN");
  if (env) return env;
  const metadata = await metadataAccessToken();
  if (metadata) return metadata;
  throw codedError("failed-precondition", "failed-precondition: Google Sheets bearer credentials are not configured for writeback");
}

async function metadataAccessToken(): Promise<string> {
  if (process.env.FUNCTIONS_EMULATOR === "true" || process.env.FIRESTORE_EMULATOR_HOST) return "";
  if (!process.env.K_SERVICE && !process.env.FUNCTION_TARGET && !process.env.FUNCTION_NAME) return "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "Metadata-Flavor": "Google" },
      signal: controller.signal,
    });
    if (!response.ok) return "";
    const body = await response.json() as { access_token?: unknown };
    return cleanText(body.access_token, "", 4096);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function actorFromContext(context: AuthContext) {
  return {
    actorHash: qualificationIdentityHash("actor", context.userId),
    role: auditLabel(context.role, "service"),
    team: auditLabel(context.team, "scp"),
  };
}

function actorFromInput(input: QualificationSheetWritebackInput): Record<string, unknown> {
  return actorFromRecord(asRecord(input).actor);
}

function actorFromRecord(value: unknown): Record<string, unknown> {
  const actor = asRecord(value);
  const suppliedHash = cleanHash(actor.actorHash);
  const stableIdentity = asString(actor.uid, "") || asString(actor.email, "") || "system";
  return {
    actorHash: suppliedHash || qualificationIdentityHash("actor", stableIdentity),
    role: auditLabel(actor.role, "service"),
    team: auditLabel(actor.team, "scp"),
  };
}

function auditSubjectFromRecord(value: unknown): Record<string, string> {
  const subject = asRecord(value);
  return {
    applicantHash: cleanHash(subject.applicantHash) || qualificationIdentityHash("applicant", ""),
    emailHash: cleanHash(subject.emailHash) || qualificationIdentityHash("applicant-email", ""),
    youtubeHash: cleanHash(subject.youtubeHash) || qualificationIdentityHash("applicant-youtube", ""),
    appHash: cleanHash(subject.appHash) || qualificationIdentityHash("source-app", ""),
  };
}

function resultPair(value: unknown): { AG: string; AH: string } {
  const pair = asRecord(value);
  return { AG: cleanText(pair.AG, "", 120), AH: cleanText(pair.AH, "", 120) };
}

function cleanHash(value: unknown): string {
  const hash = cleanText(value, "", 64).toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

function auditLabel(value: unknown, fallback: string): string {
  const label = cleanText(value, "", 40).toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(label) ? label : fallback;
}

function normalizeReasonForAuthority(value: unknown, raw: Record<string, unknown>): QualificationSheetReason {
  const reason = normalizeReason(value);
  if (reason === "유튜브없음" && authorityHasYoutubeUrl(raw)) return "보류";
  return reason;
}

function normalizeReason(value: unknown): QualificationSheetReason {
  const raw = cleanText(value, "", 120);
  const compact = raw.replace(/[\s/_-]+/g, "");
  if (isAllowedAh(compact)) return compact;
  if (/language|언어|accent|비대상/i.test(compact) || (/country|국가/i.test(compact) && /gate|language|언어|accent|confidence|억양/i.test(compact))) return "비대상언어";
  if (/genre|장르|게임|category/i.test(compact)) return "장르불일치";
  if (/country|국가|tier|저티어/i.test(compact)) return "저티어국가";
  if (/subscriber|구독|1k|1000/i.test(compact)) return "구독자1K미만";
  if (/upload|업로드|frequency|빈도/i.test(compact)) return "업로드빈도";
  if (/engagement|인게이지|참여/i.test(compact)) return "인게이지먼트";
  if (/duplicate|중복/i.test(compact)) return "중복지원";
  if (/youtube|유튜브|url/i.test(compact)) return "유튜브없음";
  return "보류";
}

function authorityHasYoutubeUrl(raw: Record<string, unknown>): boolean {
  return firstYoutubeLikeCell(asRecord(raw.rawCells)) !== "";
}

function firstYoutubeLikeCell(cells: Record<string, unknown>): string {
  for (const value of Object.values(cells)) {
    if (looksLikeYoutubeUrl(value)) return cleanText(value, "", 1_000);
  }
  return "";
}

function looksLikeYoutubeUrl(value: unknown): boolean {
  return /(?:youtube\.com|youtu\.be)\//i.test(cleanText(value, "", 1_000));
}

function firstArrayValue(value: unknown): unknown {
  return Array.isArray(value) ? value.find((item) => typeof item === "string" && item.trim()) : undefined;
}

function isAllowedAg(value: unknown): value is QualificationSheetResult {
  return value === "합격" || value === "불합격";
}

function isAllowedAh(value: unknown): value is QualificationSheetReason {
  return typeof value === "string" && (ALLOWED_AH as readonly string[]).includes(value);
}

function cleanDecisionRef(value: unknown): string {
  const raw = cleanText(value, "", 240);
  if (!raw) return "";
  if (/^qualification_decisions\/[a-zA-Z0-9_-]{1,180}$/.test(raw)) return raw;
  if (!raw.includes("/")) return `${DECISIONS_COLLECTION}/${safeDocId(raw)}`;
  throw codedError("invalid-argument", "invalid-argument: sourceDecisionRef must point to qualification_decisions");
}

function hashMetrics(cells: Record<string, string>): string {
  const metrics = ["AA", "AB", "AC", "AD", "AE", "AF"].map((column) => [column, cells[column] ?? ""]);
  return createHash("sha256").update(JSON.stringify(metrics)).digest("hex");
}

function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function makeColumns(lastColumn: "AK"): string[] {
  const columns: string[] = [];
  for (let index = 0; index < 26; index += 1) columns.push(String.fromCharCode("A".charCodeAt(0) + index));
  if (lastColumn === "AK") {
    for (let index = 0; index <= 10; index += 1) columns.push(`A${String.fromCharCode("A".charCodeAt(0) + index)}`);
  }
  return columns;
}

function cleanSpreadsheetId(value: unknown, fallback: string): string {
  const raw = asString(value, fallback);
  return raw.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 180) || fallback;
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  let raw: string;
  if (typeof value === "string") {
    raw = value;
  } else if (value === null || value === undefined) {
    raw = fallback;
  } else {
    raw = String(value);
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeDocId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180);
}

function envString(name: string): string {
  return typeof process.env[name] === "string" ? process.env[name]?.trim() ?? "" : "";
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
