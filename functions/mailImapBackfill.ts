/**
 * PLAN-ORG-MAIL-IDENTITY Slice 4 — mail history backfill.
 * See docs/PLAN-ORG-MAIL-IDENTITY.md for the data model and rollout plan.
 *
 * `startMailBackfill` (callable, the account owner or an admin) queues ONE job at a time per
 * account in `mail_backfill_jobs/{jobId}`. `runMailBackfillJobs` (a plain export — piggybacked
 * onto its OWN dedicated schedule in functions/index.ts rather than the existing 1-minute
 * `processImapIngestQueue` schedule: a backfill batch's own IMAP round-trips need up to a
 * 4-minute budget of their own, and stacking that onto the already-tight 300s/1-minute ingest
 * schedule risks blowing its timeout on every tick a job is active — the exact reasoning
 * functions/index.ts already documents for `scpSheetReviewSyncSchedule`, "기존 5분/15분 워커에
 * 편승할 수 없는 이유는 ... 별도 예산(timeoutSeconds)이 필요해서다") picks the oldest
 * queued/running job, opens the account's IMAP mailbox with the exact same per-kind connection
 * builder live ingest uses (functions/mailImapLive.ts's resolveImapConnectionForAccount),
 * SEARCHes SINCE the requested date, and fetches ascending UIDs in bounded batches.
 *
 * Every backfilled message is routed through the exact same receiveEmail/persistReceivedEmail
 * path live ingest uses (functions/chat-ai.ts), with `dryRun:true` + `draftOnly:true` — the
 * same flag pair functions/mailImapRescan.ts's `ingestRescannedMail` already relies on to
 * guarantee no auto-reply/auto-send is ever enqueued: receiveEmail's queueState gate forces
 * "draft_only" whenever either flag is set, and the auto_reply_queue write is gated strictly on
 * queueState === "queued_for_send" (functions/chat-ai.ts, W76-③) — draft_only never reaches it.
 * Idempotency on re-runs comes from that same receiveEmail path's own message_sources/messageRef
 * dedup (no separate dedupe bookkeeping needed here).
 *
 * `getMailBackfillStatus` (callable, owner or admin) returns the job projection.
 */
import { receiveEmail } from "./chat-ai";
import {
  defaultCreateImapFlowClient,
  liveInboundFromParsed,
  parseEmailSource,
  resolveImapConnectionForAccount,
  type CreateImapFlowClientFn,
  type ImapScanConnection,
  type ResolveImapConnectionForAccountDeps,
} from "./mailImapLive";
import {
  isMailAccountIdSlug,
  readMailAccounts,
  type MailAccount,
  type MailAccountsFirestoreDb,
} from "./mailAccounts";
import { adminDb } from "./firebaseAdmin";
import { safeMailDocId } from "./mailSafetyShared";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  type AuthContext,
  type CallableRequestShape,
} from "./shared";

export const MAIL_BACKFILL_JOBS_COLLECTION = "mail_backfill_jobs";

export const MAIL_BACKFILL_MIN_DAYS = 1;
export const MAIL_BACKFILL_MAX_DAYS = 90;
export const MAIL_BACKFILL_DEFAULT_DAYS = 30;

// One worker invocation processes at most this many UIDs (checkpointing progress every
// MAIL_BACKFILL_BATCH_PER_RUN of them) within MAIL_BACKFILL_TIME_BUDGET_MS — whichever comes
// first stops the run; the job stays "running" and resumes from `lastUid` next invocation.
export const MAIL_BACKFILL_BATCH_PER_RUN = 50;
export const MAIL_BACKFILL_MAX_PER_RUN = 300;
export const MAIL_BACKFILL_TIME_BUDGET_MS = 4 * 60_000;

export const MAIL_BACKFILL_JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export type MailBackfillJobStatus = typeof MAIL_BACKFILL_JOB_STATUSES[number];

export type MailBackfillJob = {
  readonly jobId: string;
  readonly accountId: string;
  readonly requestedBy: string;
  readonly sinceIso: string;
  readonly status: MailBackfillJobStatus;
  readonly scannedUids: number;
  readonly ingested: number;
  readonly skippedDuplicates: number;
  readonly lastUid: number;
  /** Last-observed IMAP UIDVALIDITY for this mailbox, persisted so the next run can detect a
   * change (mailbox recreated/renamed server-side) and know lastUid no longer refers to the
   * same UID space — mirrors functions/mailImapLive.ts's readCursorState reset semantics. */
  readonly uidValidity: string;
  /** How many times a UIDVALIDITY change forced lastUid back to 0 for this job (observability). */
  readonly uidValidityResets: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly errorCode?: string;
};

// ---------- Firestore seam (mirrors functions/mailAccounts.ts's test seam) ----------

export type MailBackfillFirestoreDb = MailAccountsFirestoreDb;

let dbOverrideForTests: MailBackfillFirestoreDb | null = null;

/** Test-only seam (mirrors setMailAccountsDbForTests in functions/mailAccounts.ts). */
export function setMailBackfillDbForTests(db: MailBackfillFirestoreDb | null): void {
  dbOverrideForTests = db;
}

function resolveMailBackfillDb(explicit?: MailBackfillFirestoreDb): MailBackfillFirestoreDb {
  return explicit ?? dbOverrideForTests ?? (adminDb as unknown as MailBackfillFirestoreDb);
}

function isMailBackfillJobStatus(value: unknown): value is MailBackfillJobStatus {
  return typeof value === "string" && (MAIL_BACKFILL_JOB_STATUSES as readonly string[]).includes(value);
}

function cleanCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function parseJobDoc(id: string, raw: unknown): MailBackfillJob {
  const data = asRecord(raw);
  const errorCode = asString(data.errorCode, "");
  return {
    jobId: id,
    accountId: asString(data.accountId, ""),
    requestedBy: asString(data.requestedBy, ""),
    sinceIso: asString(data.sinceIso, ""),
    status: isMailBackfillJobStatus(data.status) ? data.status : "queued",
    scannedUids: cleanCount(data.scannedUids),
    ingested: cleanCount(data.ingested),
    skippedDuplicates: cleanCount(data.skippedDuplicates),
    lastUid: cleanCount(data.lastUid),
    uidValidity: asString(data.uidValidity, ""),
    uidValidityResets: cleanCount(data.uidValidityResets),
    createdAt: asString(data.createdAt, ""),
    updatedAt: asString(data.updatedAt, ""),
    ...(errorCode ? { errorCode } : {}),
  };
}

async function readAllJobs(db: MailBackfillFirestoreDb): Promise<MailBackfillJob[]> {
  const snapshot = await db.collection(MAIL_BACKFILL_JOBS_COLLECTION).get();
  return snapshot.docs.map((doc) => parseJobDoc(doc.id, doc.data()));
}

// 2026-09-27 비용 감사: runMailBackfillJobs(5분 스케줄, functions/index.ts
// runMailBackfillJobsSchedule)만 readAllJobs 를 쓴다 — 그 워커는 queued/running 한 건만 필요한데
// readAllJobs 는 done/failed 이력까지 포함해 **컬렉션 전량**을 매 틱 읽었다. startMailBackfill(중복
// 가드)·getMailBackfillStatus(계정별 최신 이력)는 완료/실패 이력도 봐야 하므로 readAllJobs 를 그대로
// 쓴다 — 사람이 트리거하는 콜러블이라 빈도가 낮고, 이력 조회는 의미가 다르다(바꾸면 상태 화면이
// 완료된 백필을 못 보게 된다).
const MAIL_BACKFILL_ACTIVE_STATUSES = ["queued", "running"] as const;

// MailBackfillFirestoreDb (= MailAccountsFirestoreDb) is deliberately narrow — it only declares
// doc()/collection().get() so its node-lane test fake stays a plain in-memory map (no query
// planner to fake). Real Firestore (the only thing ever passed in production — dbOverrideForTests
// is test-only) supports where() too, so this widened view is a same-shape cast, not a behavior
// change. Tests that exercise this path give their fake collection() a matching where().get()
// chain (tests/mail-imap-backfill.test.mjs's createFakeDb).
type MailBackfillQueryableDb = {
  collection(name: string): {
    where(field: string, op: "in", value: readonly string[]): {
      get(): Promise<{ docs: readonly { id: string; data(): Record<string, unknown> | undefined }[]; size: number }>;
    };
  };
};

// 적대 리뷰(2026-09-27): 처음엔 여기에 limit(100) 을 걸었다 — 그런데 이 status "in" 쿼리는
// orderBy 가 없어 Firestore 가 문서 id(해시, 생성시각과 무관) 순으로 자른다. 활성 잡이 상한을
// 넘으면 **진짜 가장 오래된 잡이 창 밖으로 밀려날 수 있고**, 아래 createdAt 정렬은 이미 잘려나간
// 뒤라 못 구해준다 — 정지 없는 조용한 순서 역전(기아)이다. createdAt 으로 Firestore 쪽에서
// orderBy 하면 바로잡히지만 이 "in" 필터 + 다른 필드 orderBy 조합은 새 복합 색인이 필요해(T2-2
// 주석과 같은 이유로 documentId() 는 무료지만 createdAt 은 아니다) 배포 없이는 못 붙인다. 그래서
// 상한을 아예 없앴다 — status 필터만으로도 이미 이 컬렉션 전량(신규 항목: 완료/실패 이력 전부)을
// 읽던 것보다 훨씬 작다(계정당 동시 1건 가드로 활성 잡은 실질적으로 항상 소수다), 그리고 정렬
// 정확성이 상한보다 우선한다.
async function readActiveJobs(db: MailBackfillFirestoreDb): Promise<MailBackfillJob[]> {
  const queryableDb = db as unknown as MailBackfillQueryableDb;
  const snapshot = await queryableDb
    .collection(MAIL_BACKFILL_JOBS_COLLECTION)
    .where("status", "in", MAIL_BACKFILL_ACTIVE_STATUSES)
    .get();
  return snapshot.docs.map((doc) => parseJobDoc(doc.id, doc.data()));
}

// ---------- RBAC (mirrors functions/mailOAuth.ts's owner-or-admin check) ----------

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument", errorCode: "mail_backfill_invalid_argument",
  });
}

function permissionDenied(message: string): Error {
  return Object.assign(new Error(`permission-denied: ${message}`), {
    code: "permission-denied", errorCode: "mail_backfill_permission_denied",
  });
}

type RequireOwnerOrAdminDeps = { readonly readMailAccounts?: typeof readMailAccounts };

async function requireOwnerOrAdminAccount(
  auth: AuthContext,
  accountId: string,
  deps: RequireOwnerOrAdminDeps,
): Promise<MailAccount> {
  if (!isMailAccountIdSlug(accountId)) throw invalidArgument("accountId must match ^[a-z0-9][a-z0-9-]{1,40}$");
  const fetchAccounts = deps.readMailAccounts ?? readMailAccounts;
  const accounts = await fetchAccounts();
  const account = accounts.find((item) => item.accountId === accountId);
  if (!account) throw invalidArgument(`unknown accountId: ${accountId}`);
  const callerEmail = asString(auth.email, "").toLowerCase();
  const isOwner = Boolean(callerEmail) && account.ownerEmail === callerEmail;
  const isAdmin = auth.role === "super_admin" || auth.role === "admin";
  if (!isOwner && !isAdmin) throw permissionDenied("only the account owner or an admin may backfill this mailbox");
  return account;
}

// ---------- startMailBackfill ----------

export type StartMailBackfillDeps = {
  readonly db?: MailBackfillFirestoreDb;
  readonly readMailAccounts?: typeof readMailAccounts;
  readonly now?: () => number;
};

export async function startMailBackfill(request: CallableRequestShape, deps: StartMailBackfillDeps = {}) {
  const auth = assertNonGuestAuth(request, "mail_backfill.start");
  const data = asRecord(request.data);
  const accountId = asString(data.accountId);
  const account = await requireOwnerOrAdminAccount(auth, accountId, deps);

  const requestedDays = typeof data.days === "number" && Number.isFinite(data.days)
    ? Math.round(data.days)
    : MAIL_BACKFILL_DEFAULT_DAYS;
  if (requestedDays < MAIL_BACKFILL_MIN_DAYS || requestedDays > MAIL_BACKFILL_MAX_DAYS) {
    throw invalidArgument(`days must be between ${MAIL_BACKFILL_MIN_DAYS} and ${MAIL_BACKFILL_MAX_DAYS}`);
  }

  const db = resolveMailBackfillDb(deps.db);
  const existingJobs = (await readAllJobs(db)).filter((job) => job.accountId === account.accountId);
  if (existingJobs.some((job) => job.status === "queued" || job.status === "running")) {
    throw invalidArgument(`a backfill job is already queued or running for account ${account.accountId}`);
  }

  const now = deps.now ?? (() => Date.now());
  const nowIso = new Date(now()).toISOString();
  const sinceIso = new Date(now() - requestedDays * 24 * 60 * 60 * 1000).toISOString();
  const jobId = safeMailDocId("mail_backfill_job", `${account.accountId}:${now()}:${Math.random()}`);
  await db.collection(MAIL_BACKFILL_JOBS_COLLECTION).doc(jobId).set({
    accountId: account.accountId,
    requestedBy: auth.userId,
    sinceIso,
    status: "queued",
    scannedUids: 0,
    ingested: 0,
    skippedDuplicates: 0,
    lastUid: 0,
    uidValidity: "",
    uidValidityResets: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  return {
    ok: true,
    jobId,
    accountId: account.accountId,
    status: "queued" as const,
    sinceIso,
    behaviorLog: makeBehaviorLog(auth, "mail_backfill.start", "success", "global", 0),
  };
}

// ---------- getMailBackfillStatus ----------

export type GetMailBackfillStatusDeps = {
  readonly db?: MailBackfillFirestoreDb;
  readonly readMailAccounts?: typeof readMailAccounts;
};

export async function getMailBackfillStatus(request: CallableRequestShape, deps: GetMailBackfillStatusDeps = {}) {
  const auth = assertNonGuestAuth(request, "mail_backfill.status");
  const data = asRecord(request.data);
  const accountId = asString(data.accountId);
  const account = await requireOwnerOrAdminAccount(auth, accountId, deps);

  const db = resolveMailBackfillDb(deps.db);
  const jobs = (await readAllJobs(db)).filter((job) => job.accountId === account.accountId);
  const job = jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

  return {
    ok: true,
    accountId: account.accountId,
    job,
    behaviorLog: makeBehaviorLog(auth, "mail_backfill.status", "success", "global", 0),
  };
}

// ---------- runMailBackfillJobs (worker — not a callable) ----------

export type RunMailBackfillJobsDeps = {
  readonly db?: MailBackfillFirestoreDb;
  readonly readMailAccounts?: typeof readMailAccounts;
  readonly resolveConnection?: (account: MailAccount, deps?: ResolveImapConnectionForAccountDeps) => Promise<ImapScanConnection>;
  readonly connectionDeps?: ResolveImapConnectionForAccountDeps;
  readonly createImapClient?: CreateImapFlowClientFn;
  readonly receiveEmail?: typeof receiveEmail;
  readonly now?: () => number;
};

export type RunMailBackfillJobsResult =
  | { readonly ok: true; readonly processed: false }
  | {
      readonly ok: boolean;
      readonly processed: true;
      readonly jobId: string;
      readonly accountId: string;
      readonly status: MailBackfillJobStatus;
      readonly scannedUids: number;
      readonly ingested: number;
      readonly skippedDuplicates: number;
      readonly lastUid: number;
      readonly errorCode?: string;
    };

/** Picks the oldest queued/running job (if any) and advances it by one bounded batch. */
export async function runMailBackfillJobs(deps: RunMailBackfillJobsDeps = {}): Promise<RunMailBackfillJobsResult> {
  const db = resolveMailBackfillDb(deps.db);
  const now = deps.now ?? (() => Date.now());
  const fetchAccounts = deps.readMailAccounts ?? readMailAccounts;
  const resolveConnection = deps.resolveConnection ?? resolveImapConnectionForAccount;
  const createClient = deps.createImapClient ?? defaultCreateImapFlowClient;
  const doReceiveEmail = deps.receiveEmail ?? receiveEmail;

  const candidates = (await readActiveJobs(db))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const job = candidates[0];
  if (!job) return { ok: true, processed: false };

  const jobRef = db.collection(MAIL_BACKFILL_JOBS_COLLECTION).doc(job.jobId);
  await jobRef.set({ status: "running", updatedAt: new Date(now()).toISOString() }, { merge: true });

  const failJob = async (errorCode: string): Promise<RunMailBackfillJobsResult> => {
    await jobRef.set({ status: "failed", errorCode, updatedAt: new Date(now()).toISOString() }, { merge: true });
    return {
      ok: false,
      processed: true,
      jobId: job.jobId,
      accountId: job.accountId,
      status: "failed",
      scannedUids: job.scannedUids,
      ingested: job.ingested,
      skippedDuplicates: job.skippedDuplicates,
      lastUid: job.lastUid,
      errorCode,
    };
  };

  let account: MailAccount | undefined;
  try {
    const accounts = await fetchAccounts();
    account = accounts.find((item) => item.accountId === job.accountId && item.status === "active");
  } catch {
    return failJob("account_lookup_failed");
  }
  if (!account) return failJob("account_unavailable");

  let connection: ImapScanConnection;
  try {
    connection = await resolveConnection(account, deps.connectionDeps);
  } catch {
    return failJob("imap_connection_failed");
  }

  const client = createClient({
    host: connection.host,
    port: connection.port,
    secure: connection.secure,
    auth: connection.auth,
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    maxLiteralSize: Math.max(64_000, connection.maxBytes),
  });

  let scannedUids = job.scannedUids;
  let ingested = job.ingested;
  let skippedDuplicates = job.skippedDuplicates;
  let lastUid = job.lastUid;
  let uidValidity = job.uidValidity;
  let uidValidityResets = job.uidValidityResets;
  let hasMoreAfterThisBatch = false;
  let errorCode: string | undefined;

  try {
    await client.connect();
    try {
      const opened = await client.mailboxOpen(connection.mailbox, { readOnly: true });
      const observedUidValidity = String(opened.uidValidity);
      // UIDs are only meaningful within one UIDVALIDITY epoch (mirrors functions/
      // mailImapLive.ts's readCursorState). If the mailbox's UIDVALIDITY changed since the last
      // run (recreated/renamed on the IMAP server), the stored lastUid no longer refers to the
      // same UID space — resuming from it could silently skip or misinterpret messages, so
      // restart the scan from 0 and count the reset for observability.
      if (uidValidity && uidValidity !== observedUidValidity) {
        lastUid = 0;
        uidValidityResets += 1;
      }
      uidValidity = observedUidValidity;
      const sinceDate = new Date(job.sinceIso);
      const found = await client.search(
        Number.isNaN(sinceDate.getTime()) ? {} : { since: sinceDate },
        { uid: true },
      );
      const pendingUids = (Array.isArray(found) ? (found as number[]) : [])
        .filter((uid) => uid > lastUid)
        .sort((a, b) => a - b);
      const scanUids = pendingUids.slice(0, MAIL_BACKFILL_MAX_PER_RUN);
      hasMoreAfterThisBatch = pendingUids.length > scanUids.length;
      const deadlineMs = now() + MAIL_BACKFILL_TIME_BUDGET_MS;

      let processedThisRun = 0;
      for (const uid of scanUids) {
        if (now() >= deadlineMs) {
          hasMoreAfterThisBatch = true;
          break;
        }
        if (processedThisRun > 0 && processedThisRun % MAIL_BACKFILL_BATCH_PER_RUN === 0) {
          await jobRef.set(
            { scannedUids, ingested, skippedDuplicates, lastUid, uidValidity, uidValidityResets, updatedAt: new Date(now()).toISOString() },
            { merge: true },
          );
        }
        processedThisRun += 1;
        scannedUids += 1;
        lastUid = uid;

        const fetched = await client.fetchOne(
          String(uid),
          { uid: true, source: { maxLength: connection.maxBytes }, envelope: true, internalDate: true },
          { uid: true },
        );
        if (!fetched || !fetched.source) continue;
        const parsed = await parseEmailSource(fetched.source);
        const inbound = liveInboundFromParsed(parsed, {
          mailbox: connection.mailbox,
          uidValidity,
          uid,
          user: connection.auth.user,
          // Backfill never touches the shared live-ingest cursor — it tracks its own progress
          // via this job doc's lastUid, so cursorDocId/cursorAdvanceAllowed are unused here.
          cursorDocId: "",
          cursorAdvanceAllowed: false,
          internalDate: fetched.internalDate,
          mailAccountId: account.accountId,
          accountMailbox: account.mailbox,
        });

        const response = await doReceiveEmail({
          // Same server-owned invocation markers processOneLiveMail/ingestRescannedMail use —
          // strip at the public callable boundary, so only server workers can set them.
          internalTrustedInvocation: true,
          auth: { uid: "mail-backfill-worker", token: { role: "admin", team: "system", email: "mail-backfill@supercent.io" } },
          data: {
            allowMockGatewayFallback: true,
            imapIngestPayload: true,
            skipLiveImapRead: true,
            // Never trigger any auto-reply/auto-send for backfilled history — the exact same
            // flag pair mailImapRescan.ts's ingestRescannedMail relies on (see module docblock).
            dryRun: true,
            draftOnly: true,
            ingestRunId: job.jobId,
            ingestSource: `backfill:${account.accountId}`,
            trackingId: inbound.trackingId,
            messageRef: inbound.messageRef,
            providerMessageId: inbound.providerMessageId ?? "",
            from: inbound.fromNormalized ?? inbound.fromMasked ?? "",
            to: "",
            subject: inbound.subject,
            body: inbound.body ?? inbound.signal,
            text: inbound.body ?? inbound.signal,
            signal: inbound.signal,
            receivedAtIso: inbound.receivedAtIso,
            replyHeaders: inbound.replyHeaders,
            ...(inbound.routingHeaders ? { routingHeaders: inbound.routingHeaders } : {}),
            quotedOriginalRecipientEmail: inbound.quotedOriginalRecipientEmail ?? "",
            ...(typeof inbound.quotedHistoryStripped === "boolean" ? { quotedHistoryStripped: inbound.quotedHistoryStripped } : {}),
            ingestImap: inbound.imap,
            mailAccountId: account.accountId,
            accountMailbox: account.mailbox,
            // Flu/Task-47: same account-kind stamp mailImapIngest.ts's liveMailData now carries —
            // chat-ai.ts's persistReceivedEmail uses it to gate the candidate_pool registration
            // check (canonical_scp backfills stay fully unstamped, byte-identical to today).
            mailAccountKind: account.kind,
          },
          rawRequest: { ip: "127.0.0.1" },
        });
        const record = asRecord(response);
        if (record.duplicate === true) skippedDuplicates += 1;
        else ingested += 1;
      }
    } finally {
      await client.logout();
    }
  } catch {
    errorCode = "imap_scan_failed";
  }

  const finalStatus: MailBackfillJobStatus = errorCode ? "failed" : hasMoreAfterThisBatch ? "running" : "done";
  await jobRef.set({
    status: finalStatus,
    scannedUids,
    ingested,
    skippedDuplicates,
    lastUid,
    uidValidity,
    uidValidityResets,
    updatedAt: new Date(now()).toISOString(),
    ...(errorCode ? { errorCode } : {}),
  }, { merge: true });

  return {
    ok: !errorCode,
    processed: true,
    jobId: job.jobId,
    accountId: job.accountId,
    status: finalStatus,
    scannedUids,
    ingested,
    skippedDuplicates,
    lastUid,
    ...(errorCode ? { errorCode } : {}),
  };
}
