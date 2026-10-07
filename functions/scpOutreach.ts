// SCP cold-outreach reply responder + no-response follow-up (spec §4 cases B / D / F).
//
// This module implements the two cold-outreach legs that the E2E harness reported as
// not_implemented (docs/scp-cases.json B/D/F):
//   - B/D EMAIL_REPLY → RE_COLDMAIL → FORM: a recipient replies to a cold email but has NOT yet
//     submitted the application form. We detect the reply with the EXISTING inbound classifier
//     (mailInboundRoute.classifyInboundRoute — read-only reuse, no change to reply-linking), and
//     if no program_sheet_lead exists yet we queue a re_guide/re-invite mail that drives them to
//     the form. If a lead already exists (form submitted) it is a no-op.
//   - F NO_RESPONSE → FOLLOWUP: after autoFollowupDays with no reply and no form submission, a
//     sweep queues a single follow-up mail per recipient.
//
// Hard rules honored:
//   - Additive only. mailInboundRoute is imported read-only; no inbound/reply-linking behavior is
//     changed. All mail queuing flows through prepareScpResultMail (scpMail.ts), which is the mail
//     safety stack entry point: draft_only by default, human gate (isHumanGateRequired via
//     scpGate), and mail_suppressions are all enforced there. This module NEVER introduces a new
//     auto real-send path — every queued mail is mode:"draft_only".
//   - The re-guide/follow-up QUEUE is a ledger (scp_outreach + scp_outreach_queue) recording
//     status / runKey / source / leadRef; it does not send.

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  classifyInboundRoute,
  extractPlatformWrapperIdentity,
  isPlatformWrapperAddress,
} from "./mailInboundRoute";
import { prepareScpResultMail } from "./scpMail";
import { readSettings } from "./settings";
import { safeDocId } from "./sheetIntakeService";
import { assertScpEntitled } from "./mailAccounts";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  makeCache,
  makeCostLog,
  maskEmail,
  type AuthContext,
  type CallableRequestShape,
} from "./shared";
import { appendScpColdmailHistory } from "./scpColdmailHistory";
import { enqueueScpLifecycleRefreshEvent } from "./scpLifecycleProfiles";
import { SCP_PORTAL_APPLY_LINK } from "./admin";
import { PORTAL_PROGRAM_ID } from "./scpPortalApplyBindingAuthority";
import { mintScpOutreachLandingLink } from "./scpOutreachLandingLink";
import { NUDGE_INTERNAL_PROVENANCE, NUDGE_INTERNAL_PROVENANCE_FIELD } from "./mailSuppression";

const OUTREACH_COLLECTION = "scp_outreach";
const OUTREACH_QUEUE_COLLECTION = "scp_outreach_queue";
const LEADS_COLLECTION = "program_sheet_leads";
const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;
const DEFAULT_FORM_LINK = "{{form_link}}";
// W72 교정 [헤세 지적 2026-08-13]: `?locale=en&view=apply` 는 **랜딩과 본문이 문자 단위로 같다**
//   — view=apply 는 no-op 이라 지원 폼에 도달하지 못한다(실측: inputs 0 · form 없음).
//   회신 레인이 처음부터 쓰던 정본 `/apply?locale=en`(실측: h1 "Consent" · inputs 6)을 재사용한다.
//   상수를 복제하지 않는다 — 복제가 이 사고의 원인이었다.
const SCP_APPLY_LINK = SCP_PORTAL_APPLY_LINK;
const SCP_HOMEPAGE_LINK = "https://creator.supercent.io/?locale=en";
const DEFAULT_AUTO_FOLLOWUP_DAYS = 3;
const MAX_FOLLOWUPS = 1; // one gentle follow-up per no-response cold touch (warmup-safe)
const FOLLOWUP_SWEEP_SCAN_LIMIT = 200;

// A scheduled sweep has no end-user; it acts as an auditable system operator. assertNonGuestAuth
// is bypassed for this synthetic actor (the schedule itself is the authorization), but every mail
// it queues still runs the full suppression + human gate + draft_only stack inside
// prepareScpResultMail, so this cannot send anything on its own.
const SYSTEM_ACTOR: AuthContext = {
  userId: "scp-outreach-scheduler",
  role: "manager",
  team: "scp",
  ip: "0.0.0.0",
  gameId: "scp-automation",
  email: "scp-outreach@supercent.io",
  name: "SCP Outreach Scheduler",
};

export type ScpOutreachStatus =
  | "cold_sent"
  | "replied"
  | "reply_re_guided"
  | "followed_up"
  | "form_submitted";

type OutreachActionKind = "re_guide" | "followup";

function normalizeEmail(value: unknown): string {
  const raw = asString(value, "").toLowerCase().slice(0, 240);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? raw : "";
}

function outreachDocId(email: string): string {
  return safeDocId(`scp-outreach:${email}`);
}

function leadDocIdForEmail(email: string): string {
  // Mirrors sheetIntakeService.leadIdForGoogleSheetRow identity seed (email first).
  return safeDocId(`google_sheet:${email.toLowerCase()}`);
}

// Resolve the sender's real creator identity. Direct replies use the SMTP From; platform-wrapper
// relays (moonio/heepsy) carry the creator address inside the body — we reuse the existing wrapper
// extractor rather than trusting the wrapper's own address.
function resolveReplyEmail(from: string, body: string): string {
  if (isPlatformWrapperAddress(from)) {
    const extracted = extractPlatformWrapperIdentity(body ?? "");
    return extracted ? normalizeEmail(extracted.identity) : "";
  }
  const angle = String(from ?? "").match(/<([^>]+)>/);
  const candidate = angle ? angle[1] : String(from ?? "");
  const match = candidate.match(/[^\s@<>]+@[^\s@<>,;]+/);
  return match ? normalizeEmail(match[0]) : "";
}

// A form submission is represented by a program_sheet_leads doc for this email. Check the
// deterministic identity docId first, then fall back to an equality query (leads store the email
// lowercased at top level).
async function findLeadForEmail(email: string): Promise<{ id: string; path: string } | null> {
  if (!email) return null;
  const byId = await adminDb.collection(LEADS_COLLECTION).doc(leadDocIdForEmail(email)).get();
  if (byId.exists) return { id: byId.id, path: byId.ref.path };
  const byEmail = await adminDb.collection(LEADS_COLLECTION).where("email", "==", email).limit(1).get();
  if (!byEmail.empty) return { id: byEmail.docs[0].id, path: byEmail.docs[0].ref.path };
  return null;
}

async function readOutreach(email: string): Promise<Record<string, unknown> | null> {
  const snapshot = await adminDb.collection(OUTREACH_COLLECTION).doc(outreachDocId(email)).get();
  return snapshot.exists ? snapshot.data() ?? {} : null;
}

async function upsertOutreach(
  email: string,
  patch: Record<string, unknown>,
  actor: AuthContext,
  nowIso: string,
): Promise<string> {
  const ref = adminDb.collection(OUTREACH_COLLECTION).doc(outreachDocId(email));
  const existing = await ref.get();
  await ref.set({
    id: ref.id,
    emailMasked: maskEmail(email),
    email,
    ...patch,
    updatedAtIso: nowIso,
    updatedBy: actor.userId,
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: existing.exists ? existing.data()?.createdAt ?? FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
    createdAtIso: existing.exists ? asString(existing.data()?.createdAtIso, nowIso) : nowIso,
  }, { merge: true });
  const leadRef = asString(patch.leadRef);
  const leadId = leadRef.startsWith(`${LEADS_COLLECTION}/`) ? leadRef.split("/").at(-1) ?? "" : "";
  await enqueueScpLifecycleRefreshEvent({
    source: "scp_outreach",
    sourceRef: ref.path,
    reason: `scp_outreach_${asString(patch.status, "updated")}`,
    aliases: [{ email, leadId }],
    sourceUpdatedAtIso: nowIso,
  });
  return ref.path;
}

// 2026-09-27 codex adversarial review FAIL-4: this is the single choke point for all three public
// entries below (recordScpColdOutreach/handleScpInboundReply/runScpOutreachFollowup) — role
// (WRITE_ROLES) alone let any manager touch scp outreach state or queue draft mail through
// queueOutreachMail -> mailRequestFor's unconditional internalTrustedInvocation:true, bypassing
// prepareScpResultMail's own entitlement gate entirely. Gating here closes all three at once and
// never touches scpOutreachFollowupScheduled below, which calls runScpFollowupSweep(SYSTEM_ACTOR)
// directly and never goes through this function or the public runScpOutreachFollowup callable.
async function actorFromRequest(request: CallableRequestShape, action: string): Promise<AuthContext> {
  const auth = assertNonGuestAuth(request, action, WRITE_ROLES);
  await assertScpEntitled(auth, request, action);
  return auth;
}

// Build the CallableRequestShape prepareScpResultMail expects, carrying the acting operator (or the
// synthetic scheduler) so its RBAC + behavior log record the real actor.
function mailRequestFor(actor: AuthContext, data: Record<string, unknown>): CallableRequestShape {
  return {
    // W72-C R2 HIGH-2: 서버가 만든 내부 호출이다 — 공개 입구의 provenance strip 대상이 아니다.
    internalTrustedInvocation: true,
    auth: {
      uid: actor.userId,
      token: {
        role: actor.role,
        team: actor.team,
        gameId: actor.gameId,
        ...(actor.email ? { email: actor.email } : {}),
        ...(actor.name ? { name: actor.name } : {}),
      },
    },
    data,
    app: { appId: "scp-outreach" },
    rawRequest: { ip: actor.ip },
  };
}

// Queue a re_guide/follow-up mail through the mail safety stack and record a queue-ledger doc
// (status queued → drafted/held/blocked) keyed by the idempotent runKey.
async function queueOutreachMail(params: {
  actor: AuthContext;
  actionKind: OutreachActionKind;
  email: string;
  formLink: string;
  runKey: string;
  source: string;
  leadRef: string | null;
  nowIso: string;
}): Promise<{ status: string; resultRef: string | null; scpGate: unknown; queueRef: string }> {
  const { actor, actionKind, email, formLink, runKey, source, leadRef, nowIso } = params;
  const queueRef = adminDb.collection(OUTREACH_QUEUE_COLLECTION).doc(runKey);
  // status: queued — recorded before we call the mail stack so a crash mid-queue is visible.
  await queueRef.set({
    id: runKey,
    runKey,
    actionKind,
    status: "queued",
    source,
    leadRef,
    emailMasked: maskEmail(email),
    createdAtIso: nowIso,
    createdBy: actor.userId,
    updatedAtIso: nowIso,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  const mailRes = asRecord(await prepareScpResultMail(mailRequestFor(actor, {
    email,
    kind: "re_guide",
    context: "cold_reply",
    mode: "draft_only",
    formLink,
    draftRef: runKey,
    approvalRef: `${runKey}-approval`,
    programId: "scp",
    programTitle: "Super Creator Partners",
    // This is an intentional draft-ledger write, not a result-mail preview.
    // Keep provider sending disabled while making the persistence contract explicit.
    dryRun: false,
    liveSend: false,
  })));

  const resultRef = asString(mailRes.resultRef, "") || null;
  const status = asString(mailRes.status, mailRes.ok === true ? "drafted" : "blocked");
  await queueRef.set({
    status: status === "draft_only" ? "drafted" : status,
    resultRef,
    scpGate: mailRes.scpGate ?? null,
    mailSafety: mailRes.mailSafety ?? null,
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { status: status === "draft_only" ? "drafted" : status, resultRef, scpGate: mailRes.scpGate ?? null, queueRef: queueRef.path };
}

// ─────────────────────────────────────────────────────────────────────────────
// recordScpColdOutreach — mark a cold-send touchpoint (state COLD_SENT) for SCP.
// Idempotent by email; never downgrades a further-along status.
// ─────────────────────────────────────────────────────────────────────────────
export async function recordScpColdOutreach(request: CallableRequestShape) {
  const auth = await actorFromRequest(request, "scp_outreach.record_cold");
  const data = asRecord(request.data);
  const email = normalizeEmail(data.email);
  const nowIso = asString(data.nowIso, new Date().toISOString());
  if (!email) {
    throw withCallableError("invalid-argument", "a valid recipient email is required to record cold outreach", auth, "scp_outreach.record_cold");
  }
  const existing = await readOutreach(email);
  const alreadyTracked = existing !== null;
  const path = await upsertOutreach(email, {
    ...(alreadyTracked ? {} : { status: "cold_sent", followupCount: 0 }),
    coldSentAtIso: asString(existing?.coldSentAtIso, asString(data.coldSentAtIso, nowIso)),
    campaign: asString(data.campaign, asString(existing?.campaign, "")),
    leadRef: asString(existing?.leadRef, "") || null,
    source: "scp_cold_outreach",
  }, auth, nowIso);

  // append-only 발송 히스토리: alreadyTracked 여부와 무관하게 매 콜드터치를 별도 row로 기록(중복 붕괴 금지).
  //   trackingId 있으면 멱등, 없으면 sha256(email+sentAtIso+subject+source+draftRef). scp_outreach 요약은 그대로 유지.
  let historyRef: string | null = null;
  try {
    const appended = await appendScpColdmailHistory({
      email,
      koreanName: asString(data.koreanName),
      youtubeUrl: asString(data.youtubeUrl),
      subject: asString(data.subject),
      body: asString(data.body),
      campaign: asString(data.campaign),
      source: "scp_cold_outreach",
      sourceRef: path,
      draftRef: asString(data.draftRef),
      approvalRef: asString(data.approvalRef),
      trackingId: asString(data.trackingId),
      conversationId: asString(data.conversationId),
      conversationRef: asString(data.conversationRef),
      deliveryState: asString(data.deliveryState, "sent"),
      sentAtIso: asString(data.coldSentAtIso, nowIso),
    }, auth);
    historyRef = `${"scp_coldmail_history"}/${appended.id}`;
  } catch (err) {
    // 히스토리 기록 실패가 콜드터치 기록 자체를 실패시키면 안 된다 (LOG-P0-008).
    console.error("[scp-coldmail-history] append failed", { email: maskEmail(email), error: err instanceof Error ? err.message : String(err) });
  }

  return {
    ok: true,
    outreachRef: path,
    coldmailHistoryRef: historyRef,
    status: asString(existing?.status, "cold_sent"),
    alreadyTracked,
    cache: makeCache(`scp_outreach:${outreachDocId(email)}`, false),
    costLog: makeCostLog("scp_outreach.record_cold", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "scp_outreach.record_cold", "success", "scp-automation"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// handleScpInboundReply — cases B/D responder. Detects a cold-email reply and, when no lead
// (form) exists yet, queues a re_guide/re-invite mail driving to the form. No-op if a lead exists.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleScpInboundReply(request: CallableRequestShape) {
  const auth = await actorFromRequest(request, "scp_outreach.inbound_reply");
  const data = asRecord(request.data);
  const nowIso = asString(data.nowIso, new Date().toISOString());
  const from = asString(data.from, "");
  const body = asString(data.body, "");
  const subject = asString(data.subject, "");
  const formLink = asString(data.formLink, DEFAULT_FORM_LINK);

  // Read-only reuse of the existing inbound classifier — no change to reply-linking behavior.
  const route = classifyInboundRoute({
    from,
    to: asString(data.to, ""),
    subject,
    body,
    headers: asRecord(data.headers),
    hasOutboundMatch: data.hasOutboundMatch === true,
  });

  if (route.route !== "creator_reply") {
    return {
      ok: true,
      action: "ignored_non_creator_reply" as const,
      route: route.route,
      ruleId: route.ruleId,
      cache: makeCache("scp_outreach:inbound", false),
      costLog: makeCostLog("scp_outreach.inbound_reply", "mock-email", false, 0),
      behaviorLog: makeBehaviorLog(auth, "scp_outreach.inbound_reply", "success", "scp-automation"),
    };
  }

  const email = resolveReplyEmail(from, body);
  if (!email) {
    return {
      ok: true,
      action: "ignored_no_sender_identity" as const,
      route: route.route,
      cache: makeCache("scp_outreach:inbound", false),
      costLog: makeCostLog("scp_outreach.inbound_reply", "mock-email", false, 0),
      behaviorLog: makeBehaviorLog(auth, "scp_outreach.inbound_reply", "success", "scp-automation"),
    };
  }

  const lead = await findLeadForEmail(email);
  if (lead) {
    // Form already submitted → no re-invite needed. Record the terminal state and stop.
    const outreachRef = await upsertOutreach(email, {
      status: "form_submitted" as ScpOutreachStatus,
      leadRef: lead.path,
      replyReceivedAtIso: asString((await readOutreach(email))?.replyReceivedAtIso, nowIso),
    }, auth, nowIso);
    return {
      ok: true,
      action: "lead_exists_no_op" as const,
      route: route.route,
      leadRef: lead.path,
      outreachRef,
      cache: makeCache("scp_outreach:inbound", false),
      costLog: makeCostLog("scp_outreach.inbound_reply", "mock-email", false, 0),
      behaviorLog: makeBehaviorLog(auth, "scp_outreach.inbound_reply", "success", "scp-automation"),
    };
  }

  // Reply, no lead → mark replied, then queue the re-invite (draft_only + gate + suppression).
  await upsertOutreach(email, { status: "replied" as ScpOutreachStatus, replyReceivedAtIso: nowIso }, auth, nowIso);
  const runKey = safeDocId(`scp-reply-${email}`);
  const queued = await queueOutreachMail({
    actor: auth,
    actionKind: "re_guide",
    email,
    formLink,
    runKey,
    source: "scp_reply_re_guide",
    leadRef: null,
    nowIso,
  });
  const outreachRef = await upsertOutreach(email, {
    status: "reply_re_guided" as ScpOutreachStatus,
    lastReGuideRunKey: runKey,
    lastReGuideResultRef: queued.resultRef,
  }, auth, nowIso);

  return {
    ok: true,
    action: "re_guide_queued" as const,
    route: route.route,
    email: maskEmail(email),
    outreachRef,
    runKey,
    queueRef: queued.queueRef,
    mailStatus: queued.status,
    resultRef: queued.resultRef,
    scpGate: queued.scpGate,
    cache: makeCache("scp_outreach:inbound", false),
    costLog: makeCostLog("scp_outreach.inbound_reply", "mock-email", false, 0),
    behaviorLog: makeBehaviorLog(auth, "scp_outreach.inbound_reply", "success", "scp-automation"),
  };
}

export interface ScpFollowupSweepOptions {
  nowIso?: string;
  autoFollowupDays?: number;
  scanLimit?: number;
  formLink?: string;
}

export interface ScpFollowupSweepResult {
  ok: true;
  nowIso: string;
  autoFollowupDays: number;
  scanned: number;
  followedUp: number;
  skippedFormSubmitted: number;
  skippedNotDue: number;
  skippedMaxedOut: number;
  traces: string[];
}

// Core no-response follow-up sweep (case F). Shared by the manual callable and the scheduled job.
export async function runScpFollowupSweep(
  actor: AuthContext,
  options: ScpFollowupSweepOptions = {},
): Promise<ScpFollowupSweepResult> {
  const nowIso = asString(options.nowIso, new Date().toISOString());
  const nowMs = Date.parse(nowIso);
  const settings = await readSettings();
  const settingsDays = Number((settings as { manageRules?: { autoFollowupDays?: unknown } }).manageRules?.autoFollowupDays);
  const autoFollowupDays = Number.isFinite(options.autoFollowupDays)
    ? Math.max(0, Number(options.autoFollowupDays))
    : Number.isFinite(settingsDays) && settingsDays > 0
      ? settingsDays
      : DEFAULT_AUTO_FOLLOWUP_DAYS;
  const cutoffMs = nowMs - autoFollowupDays * 24 * 60 * 60 * 1000;
  const scanLimit = Number.isFinite(options.scanLimit) ? Math.max(1, Number(options.scanLimit)) : FOLLOWUP_SWEEP_SCAN_LIMIT;
  const formLink = asString(options.formLink, DEFAULT_FORM_LINK);

  // Equality-only query (no composite index needed); date + followup filtering is done in memory.
  const snapshot = await adminDb.collection(OUTREACH_COLLECTION).where("status", "==", "cold_sent").limit(scanLimit).get();
  const traces: string[] = [];
  let followedUp = 0;
  let skippedFormSubmitted = 0;
  let skippedNotDue = 0;
  let skippedMaxedOut = 0;

  for (const doc of snapshot.docs) {
    const record = doc.data() ?? {};
    const email = normalizeEmail(record.email);
    if (!email) continue;
    const coldSentMs = Date.parse(asString(record.coldSentAtIso, ""));
    const followupCount = typeof record.followupCount === "number" ? record.followupCount : 0;

    // A late form submission wins: if a lead now exists, close the touchpoint and never follow up.
    const lead = await findLeadForEmail(email);
    if (lead) {
      await upsertOutreach(email, { status: "form_submitted" as ScpOutreachStatus, leadRef: lead.path }, actor, nowIso);
      skippedFormSubmitted += 1;
      continue;
    }
    if (followupCount >= MAX_FOLLOWUPS) {
      skippedMaxedOut += 1;
      continue;
    }
    if (!Number.isFinite(coldSentMs) || coldSentMs > cutoffMs) {
      skippedNotDue += 1;
      continue;
    }

    const runKey = safeDocId(`scp-followup-${email}-${followupCount + 1}`);
    const queued = await queueOutreachMail({
      actor,
      actionKind: "followup",
      email,
      formLink,
      runKey,
      source: "scp_no_response_followup",
      leadRef: null,
      nowIso,
    });
    await upsertOutreach(email, {
      status: "followed_up" as ScpOutreachStatus,
      followupCount: followupCount + 1,
      lastFollowupRunKey: runKey,
      lastFollowupResultRef: queued.resultRef,
      lastFollowupAtIso: nowIso,
    }, actor, nowIso);
    followedUp += 1;
    traces.push(`followup queued for ${maskEmail(email)} runKey=${runKey} mailStatus=${queued.status}`);
  }

  return {
    ok: true,
    nowIso,
    autoFollowupDays,
    scanned: snapshot.size,
    followedUp,
    skippedFormSubmitted,
    skippedNotDue,
    skippedMaxedOut,
    traces,
  };
}

// Manual trigger callable (harness-driven). Uses the real operator's auth.
export async function runScpOutreachFollowup(request: CallableRequestShape) {
  const auth = await actorFromRequest(request, "scp_outreach.followup_sweep");
  const data = asRecord(request.data);
  const result = await runScpFollowupSweep(auth, {
    nowIso: asString(data.nowIso, "") || undefined,
    autoFollowupDays: typeof data.autoFollowupDays === "number" ? data.autoFollowupDays : undefined,
    scanLimit: typeof data.scanLimit === "number" ? data.scanLimit : undefined,
    formLink: asString(data.formLink, "") || undefined,
  });
  return {
    ...result,
    cache: makeCache("scp_outreach:followup", false),
    costLog: makeCostLog("scp_outreach.followup_sweep", "mock-email", false, 0),
    behaviorLog: makeBehaviorLog(auth, "scp_outreach.followup_sweep", "success", "scp-automation"),
  };
}

// Scheduled entry point (index.ts onSchedule wrapper). Runs as the synthetic system actor.
export async function scpOutreachFollowupScheduled(): Promise<ScpFollowupSweepResult> {
  return runScpFollowupSweep(SYSTEM_ACTOR);
}

function withCallableError(code: string, message: string, auth: AuthContext, action: string) {
  return Object.assign(new Error(`${code}: ${message}`), {
    code,
    behaviorLog: makeBehaviorLog(auth, action, "blocked", "scp-automation"),
  });
}

/**
 * W72 합동리뷰 P1-6 — 독려 스윕 코호트1·3 의 **draft 생성** 경로.
 *
 * 종전 스윕은 `scp_outreach_queue` 문서만 만들고 끝나서 `enqueued` 만 오르고 **검수 가능한
 * 산출물이 없었다**. 기존 follow-up 경로가 그러듯 큐 직후 `prepareScpResultMail` 을 직접 부른다.
 *
 * 이 함수는 발송하지 않는다: `mode:"draft_only"` · `liveSend:false` · `dryRun:false` 로
 * **초안 원장에만 쓴다**. 실제 발송은 사람이 승인하는 기존 스택이 한다.
 */
export async function createNudgeDraftForSweep(params: {
  email: string;
  runKey: string;
  cohort: string;
  /**
   * W72 합동리뷰 R2-2: **헤세가 패널에서 고른 문안 키**다. 이걸 안 넘기면 항상 re_guide 문안이
   * 생성돼 "회차별 문안"이라는 이 기능의 존재 이유가 사라진다. 미지의 키는 normalizeKind 가
   * qualification_pass 로 떨어뜨리므로, 호출부가 **매핑에서 온 키만** 넘겨야 한다.
   */
  templateKey: string;
  nowIso: string;
  /** 0.6.110: 프로그램 오버라이드 귀속(없으면 종전 값 그대로). */
  programOverrideId?: string;
  campaignId?: string;
  programId?: string;
  conversationId?: string;
  /**
   * W72 합동리뷰 R4-P2: 렌더 전문. `bodyPreview` 는 280자로 절단돼 단독 증거가 못 되고,
   * 원문은 SEC-P0-009 로 원장에 저장되지 않는다 — 그래서 **비영속 반환값**으로만 노출한다.
   * 호출부는 이 값을 저장하지 않는다(스윕은 큐에 해시만 남긴다).
   */
}): Promise<{ status: string; resultRef: string | null; subject: string; body: string; blockedReason?: string }> {
  const attribution = resolveNudgeProgramAttribution(params);
  if (attribution && "blockedReason" in attribution) {
    return { status: "blocked", resultRef: null, subject: "", body: "", blockedReason: attribution.blockedReason };
  }
  const mailRes = asRecord(await prepareScpResultMail(mailRequestFor(SYSTEM_ACTOR, {
    email: params.email,
    kind: params.templateKey,
    context: "cold_reply",
    mode: "draft_only",
    formLink: DEFAULT_FORM_LINK,
    draftRef: params.runKey,
    approvalRef: `${params.runKey}-approval`,
    programId: attribution?.programId ?? "scp",
    ...(attribution?.campaignId ? { campaignId: attribution.campaignId } : {}),
    programTitle: "Super Creator Partners",
    // W72 합동리뷰 R3-1: 독려 문안 계약 변수를 **명시 값**으로 넘긴다.
    applyLink: attribution?.applyLink ?? SCP_APPLY_LINK,
    homepageLink: SCP_HOMEPAGE_LINK,
    dryRun: false,
    liveSend: false,
  })));
  const resultRef = asString(mailRes.resultRef, "") || null;
  const status = asString(mailRes.status, mailRes.ok === true ? "drafted" : "blocked");
  // W72 합동리뷰 R5-1: 미치환 검사는 **prepareScpResultMail 이 영속 전에** 한다.
  //   여기서 보던 최상위 `mailRes.missingPlaceholders` 는 항상 빈값이었고(값은 draft 안에 있다),
  //   설령 맞았어도 그 시점에는 이미 원장에 draft_only 가 쓰인 뒤였다.
  const draftRendered = asRecord(mailRes.draft);
  return {
    status: status === "draft_only" ? "drafted" : status,
    resultRef,
    subject: asString(draftRendered.subject),
    body: asString(draftRendered.body),
  };
}

/**
 * 0.6.110: 프로그램 오버라이드가 적용된 독려의 귀속(프로그램·캠페인)과 **캠페인 서명 랜딩 링크**.
 *
 * 콜드메일은 수신자별 서명 랜딩 링크(`outreach_token_v2`)로 나가서 지원이 캠페인에 귀속된다. 독려가
 * 일반 `/apply` 링크로 나가면 독려로 들어온 지원이 귀속에서 빠진다. 그래서 오버라이드 행은 같은
 * outreachId(`<campaignId>_<targetId>`)·traceId 로 링크를 다시 mint 한다(admin.ts prepareCampaignOutreachDraft
 * 와 같은 규칙 — envelope.programId 는 포털 공통 스코프 PORTAL_PROGRAM_ID 다).
 *
 * 오버라이드가 없는 행은 `null` 을 돌려주고 호출부는 종전 값(SCP 일반 링크·`scp`)을 그대로 쓴다.
 * 링크를 못 만들면(키링 미바인딩 등) **발송하지 않는다**(fail-closed) — 일반 링크로 조용히 폴백하면
 * 귀속이 사라진다. 호출부가 `blockedReason` 을 받아 행을 blocked 로 남기고, 다음 스윕이 다시 적재한다.
 */
function resolveNudgeProgramAttribution(params: {
  email: string;
  programOverrideId?: string;
  campaignId?: string;
  programId?: string;
  conversationId?: string;
}): { programId: string; campaignId: string; applyLink: string } | { blockedReason: string } | null {
  if (!asString(params.programOverrideId)) return null;
  const campaignId = asString(params.campaignId);
  const programId = asString(params.programId) || "scp";
  // 캠페인 귀속이 없으면(프로그램 단위 오버라이드 + 이력에 캠페인 없음) 서명할 대상이 없다 — 일반 링크.
  if (!campaignId) return { programId, campaignId: "", applyLink: SCP_APPLY_LINK };
  const conversationId = asString(params.conversationId);
  const prefix = `campaign-${campaignId}-`;
  const targetId = conversationId.startsWith(prefix) ? conversationId.slice(prefix.length) : "";
  const outreachId = targetId
    ? `${campaignId}_${targetId}`
    : `${campaignId}_nudge_${privateNudgeDigest(params.email)}`;
  try {
    const landing = mintScpOutreachLandingLink({
      programId: PORTAL_PROGRAM_ID,
      campaignId,
      outreachId,
      traceId: `tr_${outreachId}`,
      expectedEmail: params.email,
    });
    return { programId, campaignId, applyLink: landing.url };
  } catch (error) {
    return { blockedReason: asString((error as { code?: unknown } | null)?.code, "landing_link_failed") };
  }
}

function privateNudgeDigest(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex").slice(0, 24);
}

/**
 * W72-B2 [헤세 결정 2026-08-13] — 코호트1·3 **라이브 발송** 경로.
 *
 * `createNudgeDraftForSweep` 과 **같은 렌더·같은 문안 매핑**을 쓰고, 차이는 두 가지뿐이다:
 *   · `mode: "send"` · `liveSend: true` — 사람 승인 없이 나간다
 *   · human gate 를 요구하지 않는다(헤세 결정)
 *
 * ⚠️ 우회하지 않는 것(리뷰 6라운드가 지킨 축, 그대로 통과한다):
 *   suppression · 레인 캡 250/일 · 전역 캡 · 발송 직전 재검사 · 미치환 토큰 거부(R5-1).
 *   레인 캡은 `mailPurpose` 로 판정되므로 코호트별 purpose 를 넘긴다.
 *
 * draft 경로(`createNudgeDraftForSweep`)는 **제거하지 않았다** — 설정으로 되돌릴 수 있다.
 */
export async function sendNudgeLiveForSweep(params: {
  email: string;
  runKey: string;
  cohort: string;
  templateKey: string;
  mailPurpose: string;
  nowIso: string;
  /** 0.6.110: 프로그램 오버라이드 귀속(없으면 종전 값 그대로). */
  programOverrideId?: string;
  campaignId?: string;
  programId?: string;
  conversationId?: string;
}): Promise<{ status: string; resultRef: string | null; subject: string; body: string; blockedReason?: string }> {
  // 0.6.110: 링크는 **한 번만** mint 한다 — preview 와 apply 가 같은 본문이어야 hash 가 일치한다
  //   (토큰에 만료 시각이 들어가므로 두 번 mint 하면 본문이 달라진다).
  const attribution = resolveNudgeProgramAttribution(params);
  if (attribution && "blockedReason" in attribution) {
    return { status: "blocked", resultRef: null, subject: "", body: "", blockedReason: attribution.blockedReason };
  }
  // W72 마감리뷰 P0-1 [헤세 결정 2026-08-13 하 결선]
  //
  // 종전에 `mode: "send"` 를 넘겼는데 scpMail 은 **"send_approved" 만** 발송으로 인정한다
  //   (scpMail.ts:1505). 그래서 코호트1·3 은 전부 조용히 draft_only 로 강등됐고 —
  //   SMTP 에 도달하지 않으면서 큐에는 liveSend:true 로 기록되고, 그 draft 가 delivered 로
  //   계상돼 **메일 없이 회차(3/5)를 소모**했다. mode 문자열만 바꾸면 안 된다:
  //   send_approved 분기는 previewToken/previewHash 를 요구하는 2단계 계약이기 때문이다.
  //
  // 그래서 기존 preview→apply 2단계를 **그대로** 탄다(qualification_fail 배치와 같은 형상).
  //   1) dryRun 프리뷰로 렌더·안전축을 평가하고 token/hash 를 받는다.
  //   2) 그 token/hash 로 apply 한다 — 이때만 실제 발송이다.
  // 승인 주체는 사람이 아니라 **시스템 정책**이다(헤세 결정: 코호트1·3 human gate 없음).
  //   승인 근거를 approval 필드에 남겨 감사에서 사람 승인과 구분된다.
  const baseData = {
    email: params.email,
    kind: params.templateKey,
    context: "cold_reply",
    mode: "send_approved",
    // 시스템 승인 정책. 사람 승인(pending→approved)과 값으로 구분된다.
    approval: "system_approved",
    approvalPolicy: "w72_nudge_cohort_live",
    formLink: DEFAULT_FORM_LINK,
    draftRef: params.runKey,
    approvalRef: `${params.runKey}-approval`,
    programId: attribution?.programId ?? "scp",
    ...(attribution?.campaignId ? { campaignId: attribution.campaignId } : {}),
    programTitle: "Super Creator Partners",
    applyLink: attribution?.applyLink ?? SCP_APPLY_LINK,
    homepageLink: SCP_HOMEPAGE_LINK,
    // 레인 캡(250/일)이 이 값으로 판정된다 — 빠지면 코호트 캡이 강제되지 않는다.
    mailPurpose: params.mailPurpose,
    mailType: params.mailPurpose,
    // W72-C R1 HIGH-3: 서버 소유 표식. 이 값이 있어야만 infly 예외가 열린다.
    //   공용 sendEmail 콜러블은 입구에서 이 필드를 strip 하므로 외부 요청으로는 못 넣는다.
    [NUDGE_INTERNAL_PROVENANCE_FIELD]: NUDGE_INTERNAL_PROVENANCE,
  };

  // 1단계 — 프리뷰. 여기서 미치환 토큰·suppression·쿼터가 먼저 걸린다.
  const preview = asRecord(await prepareScpResultMail(mailRequestFor(SYSTEM_ACTOR, {
    ...baseData,
    dryRun: true,
    liveSend: false,
  })));
  const previewToken = asString(preview.previewToken);
  const previewHash = asString(preview.previewHash);
  if (asString(preview.status) !== "preview" || !previewToken || !previewHash) {
    // 프리뷰가 안 서면 **발송하지 않는다**(fail-closed). 사유를 그대로 올린다.
    const draftPreview = asRecord(preview.draft);
    return {
      status: asString(preview.status, "blocked"),
      resultRef: asString(preview.resultRef, "") || null,
      subject: asString(draftPreview.subject),
      body: asString(draftPreview.body),
    };
  }

  // 2단계 — apply. 프리뷰와 내용이 다르면 hash 불일치로 거절된다(문안 바꿔치기 차단).
  const applied = asRecord(await prepareScpResultMail(mailRequestFor(SYSTEM_ACTOR, {
    ...baseData,
    previewToken,
    previewHash,
    dryRun: false,
    liveSend: true,
  })));
  const draftRendered = asRecord(applied.draft);
  return {
    status: asString(applied.status, applied.ok === true ? "sent" : "blocked"),
    resultRef: asString(applied.resultRef, "") || null,
    subject: asString(draftRendered.subject),
    body: asString(draftRendered.body),
  };
}
