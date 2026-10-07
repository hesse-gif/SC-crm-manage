/**
 * Flu/Task-47 — admin-triggered rematch of previously-unregistered personal-account
 * conversations against candidate_pool. A candidate registered AFTER a conversation's messages
 * were ingested never gets picked up by persistReceivedEmail retroactively (it only re-stamps
 * on the NEXT inbound message) — this callable closes that gap on demand.
 *
 * No new onSchedule: tests/w72-a-nudge-sweep.test.mjs pins the exact onSchedule count in
 * functions/index.ts, and the ticket asks for "운영자 수동 실행" (operator-triggered) anyway.
 * startCandidateRematch both creates the job doc (first call) and advances it by one bounded
 * batch synchronously — calling it again resumes the SAME job from its cursor until `hasMore`
 * is false. Shape mirrors functions/mailImapBackfill.ts's job-doc/resume pattern; there is no
 * live IMAP connection here, only Firestore reads/writes.
 *
 * 2026-09-11 adversarial review fixes:
 *   - P1-3: `request.data.mode === "backfill_legacy"` sweeps personal-account conversations
 *     that predate this feature entirely — `counterpartyRegistered` is absent, not `false` —
 *     which a plain equality query can never match. This mode does a plain cursor-paginated
 *     conversations scan (no `where`) and filters "legacy personal-account row" client-side,
 *     using its own fixed job doc so it never shares cursor/counts with the standard job.
 *   - P1-5: two `startCandidateRematch` calls arriving at nearly the same moment used to both
 *     see "no active job" (a plain query, not atomic) and both mint a fresh random-id job doc,
 *     doubling the scan. Job ids are now fixed per mode ("global" / "legacy_backfill") and
 *     claimed inside a Firestore transaction: `inFlight` marks a claim actively held by the
 *     call currently mid-batch (NOT the same thing as `status:"running"`, which legitimately
 *     stays set between calls whenever `hasMore` was true, waiting for the next resume tap). A
 *     second call that finds `inFlight:true` backs off and returns `alreadyRunning:true`
 *     instead of scanning; the claim is released (status/counts/cursor written, `inFlight`
 *     cleared) at the end of the same call that took it.
 */
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { findRegisteredCandidateByEmail, type RegisteredCandidateMatch } from "./candidateRegistrationMatch";
import { PERSONAL_MAIL_ACCOUNT_KINDS, readMailAccounts } from "./mailAccounts";
import { normalizeEmailAddress } from "./mailSafetyShared";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  type CallableRequestShape,
} from "./shared";

export const CANDIDATE_REMATCH_JOBS_COLLECTION = "candidate_rematch_jobs";
export const CONVERSATIONS_COLLECTION = "conversations";

// Bounded per-invocation Firestore read cost (COST-P0-006 observability) — a job whose
// unregistered backlog exceeds this resumes on the next `startCandidateRematch` call instead of
// scanning unbounded in one request.
export const CANDIDATE_REMATCH_BATCH_PER_RUN = 200;

// P2-9: "queued" was dead — no doc this module ever writes uses it (every job is created
// directly at "running"); kept out of the enum now instead of carrying an unreachable state.
export const CANDIDATE_REMATCH_JOB_STATUSES = ["running", "done"] as const;
export type CandidateRematchJobStatus = typeof CANDIDATE_REMATCH_JOB_STATUSES[number];

// P1-5: fixed per-mode doc ids replace the old `candidate_rematch_${now}_${random}` id — see
// claimJob below.
const STANDARD_JOB_ID = "global";
const LEGACY_BACKFILL_JOB_ID = "legacy_backfill";

// HIGH (2026-09-11 second adversarial review): a claim whose `updatedAt` is older than this is
// treated as abandoned (the invocation that took it crashed hard enough to skip even the
// try/finally release in startCandidateRematch below) and may be reclaimed — see claimJob.
const CLAIM_STALE_MS = 10 * 60 * 1000;

export type CandidateRematchJob = {
  readonly jobId: string;
  readonly requestedBy: string;
  readonly status: CandidateRematchJobStatus;
  readonly scanned: number;
  readonly matched: number;
  readonly lastConversationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

// ---------- minimal Firestore seam (mirrors functions/mailImapBackfill.ts's test seam) ----------

type FirestoreDocSnapshot = {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
};

type FirestoreQuerySnapshot = {
  readonly docs: readonly FirestoreDocSnapshot[];
};

type FirestoreDocRef = {
  get(): Promise<FirestoreDocSnapshot>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
};

type FirestoreQuery = {
  orderBy(field: string): FirestoreQuery;
  startAfter(value: unknown): FirestoreQuery;
  limit(count: number): FirestoreQuery;
  get(): Promise<FirestoreQuerySnapshot>;
};

type FirestoreCollectionRef = FirestoreQuery & {
  doc(id: string): FirestoreDocRef;
  where(field: string, op: "==", value: unknown): FirestoreQuery;
};

// P1-5: the subset of firebase-admin's real Transaction this module needs. `set` is
// intentionally synchronous (matches the real SDK — a transaction's writes are buffered and
// only actually committed when the callback's promise resolves, not awaited individually).
type FirestoreTransaction = {
  get(ref: FirestoreDocRef): Promise<FirestoreDocSnapshot>;
  set(ref: FirestoreDocRef, data: Record<string, unknown>, options?: { merge?: boolean }): unknown;
};

export type CandidateRematchFirestoreDb = {
  collection(name: string): FirestoreCollectionRef;
  runTransaction<T>(updateFunction: (transaction: FirestoreTransaction) => Promise<T>): Promise<T>;
};

let dbOverrideForTests: CandidateRematchFirestoreDb | null = null;

/** Test-only seam (mirrors setMailBackfillDbForTests in functions/mailImapBackfill.ts). */
export function setCandidateRematchDbForTests(db: CandidateRematchFirestoreDb | null): void {
  dbOverrideForTests = db;
}

function resolveCandidateRematchDb(explicit?: CandidateRematchFirestoreDb): CandidateRematchFirestoreDb {
  return explicit ?? dbOverrideForTests ?? (adminDb as unknown as CandidateRematchFirestoreDb);
}

function isCandidateRematchJobStatus(value: unknown): value is CandidateRematchJobStatus {
  return typeof value === "string" && (CANDIDATE_REMATCH_JOB_STATUSES as readonly string[]).includes(value);
}

function cleanCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function parseJobDoc(id: string, raw: unknown): CandidateRematchJob {
  const data = asRecord(raw);
  return {
    jobId: id,
    requestedBy: asString(data.requestedBy, ""),
    // Defensive fallback only — every doc this module writes sets status explicitly.
    status: isCandidateRematchJobStatus(data.status) ? data.status : "running",
    scanned: cleanCount(data.scanned),
    matched: cleanCount(data.matched),
    lastConversationId: asString(data.lastConversationId, ""),
    createdAt: asString(data.createdAt, ""),
    updatedAt: asString(data.updatedAt, ""),
  };
}

type ClaimResult =
  | { readonly claimed: true; readonly job: CandidateRematchJob }
  | { readonly claimed: false; readonly job: CandidateRematchJob };

/**
 * P1-5: atomically claims the fixed job doc `jobId` for THIS call. A terminal ("done") or
 * missing job resets scanned/matched/cursor to a fresh start (mirrors the old
 * `readActiveJob`-returns-null → new random id behavior); a non-terminal ("running") job
 * resumes from its existing counters/cursor. Either way the doc is stamped `inFlight:true`
 * inside the same transaction, so a concurrent second call that reads `inFlight:true` here
 * backs off instead of scanning the same backlog twice.
 *
 * HIGH (2026-09-11 second adversarial review): startCandidateRematch releases the claim
 * (`inFlight` cleared, `updatedAt` refreshed) in a try/finally around its scan, so a normal
 * failure never leaves this stuck. But a hard crash (process killed, OOM) can skip even that —
 * so a claim whose `updatedAt` is older than CLAIM_STALE_MS is treated as abandoned and
 * reclaimed here (resumed from its last-persisted counters/cursor, same as any other
 * non-terminal job) instead of blocking every future call with `alreadyRunning` forever.
 */
async function claimJob(
  db: CandidateRematchFirestoreDb,
  jobId: string,
  requestedBy: string,
  nowIso: string,
): Promise<ClaimResult> {
  const nowMs = Date.parse(nowIso);
  const jobRef = db.collection(CANDIDATE_REMATCH_JOBS_COLLECTION).doc(jobId);
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(jobRef);
    const rawData = snapshot.exists ? asRecord(snapshot.data()) : null;
    const existing = rawData ? parseJobDoc(jobId, rawData) : null;
    const isInFlight = rawData?.inFlight === true;
    const updatedAtMs = existing ? Date.parse(existing.updatedAt) : NaN;
    const isStale = !Number.isFinite(updatedAtMs) || (Number.isFinite(nowMs) && nowMs - updatedAtMs > CLAIM_STALE_MS);
    if (existing && isInFlight && !isStale) {
      return { claimed: false, job: existing };
    }
    const resetting = !existing || existing.status === "done";
    const job: CandidateRematchJob = {
      jobId,
      requestedBy: resetting ? requestedBy : (existing?.requestedBy || requestedBy),
      status: "running",
      scanned: resetting ? 0 : existing!.scanned,
      matched: resetting ? 0 : existing!.matched,
      lastConversationId: resetting ? "" : existing!.lastConversationId,
      createdAt: resetting ? nowIso : (existing?.createdAt || nowIso),
      updatedAt: nowIso,
    };
    tx.set(jobRef, { ...job, inFlight: true }, { merge: true });
    return { claimed: true, job };
  });
}

export type StartCandidateRematchDeps = {
  readonly db?: CandidateRematchFirestoreDb;
  readonly findRegisteredCandidateByEmail?: (
    email: string,
  ) => Promise<RegisteredCandidateMatch | null>;
  readonly readMailAccounts?: typeof readMailAccounts;
  readonly now?: () => number;
};

export type StartCandidateRematchResult = {
  readonly ok: true;
  readonly jobId: string;
  readonly status: CandidateRematchJobStatus;
  readonly scanned: number;
  readonly matched: number;
  readonly hasMore: boolean;
  /** P1-5: true when this call backed off because another invocation already holds the claim
   * — no scan happened, `scanned`/`matched` echo the in-flight job's last-persisted counters. */
  readonly alreadyRunning: boolean;
  readonly behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

/**
 * admin/super_admin only. Advances the single global rematch job (or, with
 * `request.data.mode === "backfill_legacy"`, the separate legacy-backfill job) by one bounded
 * batch. Call again while `hasMore` is true to continue; a `done` job resets on the next call
 * (e.g. after registering another candidate).
 *
 * Standard mode targets `counterpartyRegistered === false` conversations (only ever set on
 * personal-account rows by persistReceivedEmail). Legacy-backfill mode additionally targets
 * personal-account conversations that predate this field existing at all (P1-3).
 */
export async function startCandidateRematch(
  request: CallableRequestShape,
  deps: StartCandidateRematchDeps = {},
): Promise<StartCandidateRematchResult> {
  const auth = assertNonGuestAuth(request, "candidate_rematch.start", ["super_admin", "admin"]);
  const db = resolveCandidateRematchDb(deps.db);
  const matchEmail = deps.findRegisteredCandidateByEmail ?? findRegisteredCandidateByEmail;
  const fetchMailAccounts = deps.readMailAccounts ?? readMailAccounts;
  const now = deps.now ?? (() => Date.now());
  const nowIso = new Date(now()).toISOString();
  const mode = asString(asRecord(request.data).mode, "") === "backfill_legacy"
    ? "backfill_legacy"
    : "standard";
  const jobId = mode === "backfill_legacy" ? LEGACY_BACKFILL_JOB_ID : STANDARD_JOB_ID;

  const claim = await claimJob(db, jobId, auth.userId, nowIso);
  if (!claim.claimed) {
    return {
      ok: true,
      jobId,
      status: claim.job.status,
      scanned: claim.job.scanned,
      matched: claim.job.matched,
      hasMore: true,
      alreadyRunning: true,
      behaviorLog: makeBehaviorLog(auth, "candidate_rematch.start", "blocked", "global", 0),
    };
  }

  let { scanned, matched, lastConversationId } = claim.job;
  let hasMoreDocs = false;
  // HIGH (2026-09-11 second adversarial review): the claim taken above must never stay stuck at
  // inFlight:true just because the scan below throws (a matcher/Firestore error mid-batch) — the
  // finally block always releases it and persists whatever scanned/matched/lastConversationId
  // this batch reached before the throw, so the next call resumes from there instead of being
  // told alreadyRunning forever (claimJob's staleness fallback is a second, slower safety net for
  // the rarer case where the process dies hard enough to skip even this finally).
  let scanError: unknown = null;
  try {
    if (mode === "backfill_legacy") {
      const accounts = await fetchMailAccounts();
      const personalAccountIds = new Set(
        accounts.filter((account) => PERSONAL_MAIL_ACCOUNT_KINDS.has(account.kind)).map((account) => account.accountId),
      );
      let query = db.collection(CONVERSATIONS_COLLECTION).orderBy("__name__").limit(CANDIDATE_REMATCH_BATCH_PER_RUN);
      if (lastConversationId) query = query.startAfter(lastConversationId);
      const snapshot = await query.get();

      for (const doc of snapshot.docs) {
        scanned += 1;
        lastConversationId = doc.id;
        const data = doc.data() ?? {};
        const isLegacyPersonalRow =
          !Object.prototype.hasOwnProperty.call(data, "counterpartyRegistered") &&
          personalAccountIds.has(asString(data.mailAccountId, ""));
        if (!isLegacyPersonalRow) continue;
        const email = normalizeEmailAddress(asString(data.creatorEmail, ""));
        const match = email ? await matchEmail(email) : null;
        if (match) matched += 1;
        await db.collection(CONVERSATIONS_COLLECTION).doc(doc.id).set(
          match
            ? { counterpartyRegistered: true, candidateRef: match.candidateRef, candidateRematchedAtIso: nowIso }
            : { counterpartyRegistered: false, candidateRematchedAtIso: nowIso },
          { merge: true },
        );
      }
      hasMoreDocs = snapshot.docs.length === CANDIDATE_REMATCH_BATCH_PER_RUN;
    } else {
      let query = db
        .collection(CONVERSATIONS_COLLECTION)
        .where("counterpartyRegistered", "==", false)
        .orderBy("__name__")
        .limit(CANDIDATE_REMATCH_BATCH_PER_RUN);
      if (lastConversationId) query = query.startAfter(lastConversationId);
      const snapshot = await query.get();

      for (const doc of snapshot.docs) {
        scanned += 1;
        lastConversationId = doc.id;
        const email = normalizeEmailAddress(asString(doc.data()?.creatorEmail, ""));
        if (!email) continue;
        const match = await matchEmail(email);
        if (!match) continue;
        matched += 1;
        await db.collection(CONVERSATIONS_COLLECTION).doc(doc.id).set(
          { counterpartyRegistered: true, candidateRef: match.candidateRef, candidateRematchedAtIso: nowIso },
          { merge: true },
        );
      }
      hasMoreDocs = snapshot.docs.length === CANDIDATE_REMATCH_BATCH_PER_RUN;
    }
  } catch (error) {
    scanError = error;
  } finally {
    const jobRef = db.collection(CANDIDATE_REMATCH_JOBS_COLLECTION).doc(jobId);
    await jobRef.set(
      {
        // Never "done" on a throw — the batch did not actually finish.
        status: (scanError || hasMoreDocs ? "running" : "done") as CandidateRematchJobStatus,
        scanned,
        matched,
        lastConversationId,
        updatedAt: new Date(now()).toISOString(),
        inFlight: FieldValue.delete(),
      },
      { merge: true },
    );
  }
  if (scanError) throw scanError;

  const status: CandidateRematchJobStatus = hasMoreDocs ? "running" : "done";
  return {
    ok: true,
    jobId,
    status,
    scanned,
    matched,
    hasMore: hasMoreDocs,
    alreadyRunning: false,
    behaviorLog: makeBehaviorLog(auth, "candidate_rematch.start", "success", "global", 0),
  };
}
