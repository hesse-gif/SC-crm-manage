// requeueAutoReplyBacklog (Task C, auto-reply-risk-taxonomy 2026-09-17): super_admin-only
// maintenance callable that re-examines conversations Flu never sent an automated reply to and,
// for each one, re-runs the SAME receive-time classification + permit + SCP gate the inbound path
// uses (bypassing the gateway cache) — if that fresh evaluation now allows auto_reply, it enqueues
// an auto_reply_queue job; otherwise it leaves the conversation exactly as it was and records why.
//
// Selection criteria (updated 2026-09-17 15:30 KST against live prod counts — hesse): conversations
// whose last message is from the creator (`lastMessageFrom === "creator"`, never re-examines a
// conversation a human already answered) and whose autoReplyStatus is "waiting_for_human" (the
// receive-time needs_review lane — chat-ai.ts persistReceivedEmail, ~line 5938) or "draft_only"
// (auto_reply that got downgraded before send), within the last `maxAgeHours`. "blocked" is never
// selected — hard stops must stay stopped.
//
// This callable makes a REAL LLM call per candidate (runGatewayLive with bypassGatewayCache:true —
// that is the whole point, a stale cached classification would defeat the "re-run from scratch"
// requirement) — it is real cost, gated to super_admin, and denied in staging
// (functions-staging/runtime/index.cjs DENIED_PRODUCTION_ONLY_PERMIT_CALLABLES, same reasoning as
// its sibling runChatAutoCasePermitEval).
import { createHash } from "node:crypto";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  buildChatAutoPermitReceivePlan,
  evaluateScpInquiryAutoReplyGate,
  runGatewayLive,
} from "./chat-ai";
import {
  isChatAutoPermitCaseId,
  type ChatAutoCasePermitDecision,
  type ChatAutoPermitCaseId,
} from "./chatAutoCasePermit";
import { readChatAutoCasePermit, writeChatAutoCaseIntentBatch } from "./chatAutoCasePermitStore";
import { cachedChatAutoPermitReleaseSourceCommit } from "./chatAutoPermitReleaseIdentity";
import { CHAT_CASEBOOK_CONTENT_HASH, CHAT_CASEBOOK_VERSION } from "./chatCasebook";
import { claimConversationAutoLane, releaseConversationAutoLane } from "./conversationAutoLane";
import { readByOrgIdForAutoReplyOrgExclusion, readMailAccounts } from "./mailAccounts";
import { isTrustedInboundAutoReplyAccount, type InboundAutoReplyAccount } from "./inboundAutoReplyPolicy";
import { readAddressAliasKeys, readCanonicalIdentityGroups, sourceActorIsAgency, readSenderBindingForGate, hasAmbiguousCreatorIdentity, hasCandidateLinkedToProvingSend, hasUnlinkedExplicitIdentity, identityOnlyAutoReplyEnabled, caseNeedsProgramFacts, personalRegistered } from "./inboundSenderIdentity";
import { disabledOrgSharesMailAccount, isAutoReplyOrgExcluded } from "./mailHumanGate";
import { normalizeInboundRoutingFlags } from "./mailInboundRoute";
import { resolveMailProfile } from "./mailProfiles";
import { evaluateMailSafety, recordMailSuppression } from "./mailSafetyPolicy";
import { detectManualReplySinceInbound } from "./manualReplyDetection";
import { readSettings, readSettingsWithRevision } from "./settings";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  type CallableRequestShape,
} from "./shared";

export const AUTO_REPLY_BACKLOG_CONFIRM_TOKEN = "REQUEUE_AUTO_REPLY_BACKLOG" as const;
const DEFAULT_MAX_AGE_HOURS = 72;
// 2026-09-24 (hesse operator run — backlog re-judge under the lenient low-data review policy):
// the default stays 72h (unchanged call sites keep today's behavior), but the ceiling widens to
// 2160h (90 days) so an operator can sweep the full aged backlog explicitly via maxAgeHours,
// paging through it with `cursor` (below) to stay under the callable's 540s timeout.
// Exported (case-backlog-send, 2026-09-27) so chatAutoCaseBacklogSend.ts's per-case "지금 보내기"
// flow and its held-count read callable can bound their own queries to the exact same maximum
// window this sweep can ever act on — a wider display/count window than the sweep can reach would
// show an operator a "held N건" number "지금 보내기" could never fully honor.
export const MAX_MAX_AGE_HOURS = 2160;
const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
// Mirrors chat-ai.ts's AUTO_REPLY_EXPIRY_HOURS (module-private there) — a requeued job expires on
// the same 72h horizon as a freshly-enqueued one.
const AUTO_REPLY_QUEUE_EXPIRY_HOURS = 72;
// Exported (case-backlog-send, 2026-09-27) — chatAutoCaseBacklogSend.ts's held-count callable
// scans the exact same candidate population this sweep selects from, so it reuses this literal
// instead of risking the two lists drifting apart.
export const SELECTABLE_AUTO_REPLY_STATUSES = ["waiting_for_human", "draft_only"] as const;
const AUTO_REPLY_BACKLOG_AUDIT_COLLECTION = "chat_auto_backlog_requeue_audits" as const;
const VERIFIED_ATTRIBUTION_POLICY_VERSION = "conversation_attribution_v1" as const;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

// Exported (case-backlog-send, 2026-09-27) — chatAutoCaseBacklogSend.ts's own audit write
// (chat_auto_case_backlog_send_audits) uses the exact same actor-hashing scheme as this sweep's
// audit collection, so the two audit trails stay comparable rather than hashing the same uid two
// different ways.
export function actorUidHash(uid: string): string {
  return createHash("sha256").update(uid).digest("hex").slice(0, 24);
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export type RequeueAutoReplyBacklogRequest = {
  maxAgeHours?: number;
  limit?: number;
  dryRun?: boolean;
  confirm?: string;
  cursor?: string;
  // case-backlog-send (2026-09-27): scopes the sweep to exactly one already-classified case — see
  // the caseIdFilter comment on the main loop below for how this narrows the candidate set AFTER
  // (never before) the same live reclassification + every existing safety gate a plain sweep runs.
  caseIdFilter?: string;
  // [적대 리뷰, case-backlog-send round 5, 2026-09-28] when provided, bypasses the windowed
  // `queryCandidates` query entirely and re-reads exactly these conversation ids fresh (each still
  // runs through every existing gate below, unchanged) — `limit`/`cursor` are ignored.
  // sendChatAutoCaseHeldBacklogNow uses this to bound its real (enqueue) pass to the EXACT set of
  // conversations its own preview pass planned (RequeueAutoReplyBacklogResult.plannedConversationIds
  // below), so a row dropping in/out of the query window between the two passes can never let a
  // later, unpreviewed row slip into the enqueue pass — queued can only ever be a subset of planned.
  conversationIds?: readonly string[];
};

// Opaque JSON-encoded {lastInboundAtIso, id} of the last candidate scanned in a previous page —
// passed back as `cursor` to resume a bounded sweep of a large (up to 90-day) backlog across
// multiple calls instead of requiring a single call to fit the whole window under the 540s
// timeout. `lastInboundAtIso` ALONE is not a safe cursor: it is not unique, so a page boundary
// that falls in the middle of a group of candidates sharing the same timestamp would silently
// skip the rest of that group on the next page ([적대 리뷰] Codex gate 2026-09-24, HIGH — Firestore
// query-cursor docs: a single non-unique orderBy field is ambiguous for startAfter). The document
// id is carried as a tiebreaker and matches the id-ordered secondary sort defaultQueryCandidates
// now applies. Anything unparseable falls back to null (start from cutoffIso) rather than throwing.
export type AutoReplyBacklogCursor = { lastInboundAtIso: string; id: string };

// Firestore document ids can't contain "/", can't be exactly "." or "..", can't match
// __.*__, and are capped at 1500 BYTES (UTF-8), not JS string length — a multi-byte character
// (e.g. non-ASCII) can be well under 1500 chars but over 1500 bytes and still reach Firestore's
// own startAfter() to throw instead of failing open. A value that needed trimming is rejected
// outright (not silently trimmed) rather than accepted — a genuine `conversations/{id}` never
// carries surrounding whitespace, so a padded value signals a malformed/hand-edited cursor, and
// resuming from the TRIMMED value would put startAfter() at a different sort key than the id
// nextCursor actually emitted, reopening the same skip risk the tiebreak above exists to close.
// ([적대 리뷰] Codex gate 2026-09-24, rounds 2–3)
function safeCursorDocumentId(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (value !== value.trim()) return null;
  if (Buffer.byteLength(value, "utf8") > 1500) return null;
  if (value.includes("/") || value === "." || value === ".." || /^__.*__$/.test(value)) return null;
  return value;
}

// A cursor's lastInboundAtIso must be the EXACT canonical ISO-8601 string nextCursor emitted
// (`Date.prototype.toISOString()`'s own output, e.g. always an uppercase "Z", 3-digit
// milliseconds). `Date.parse()` alone is not enough: it accepts syntactic variants (lowercase
// "z", a numeric offset instead of "Z", missing milliseconds, …) that parse to the SAME instant
// but are a DIFFERENT string — and Firestore's startAfter() cursor compares the stored string
// value lexicographically, not semantically. A variant that sorts after the real stored value
// (e.g. lowercase "z" > uppercase "Z" in ASCII) would silently skip the rest of a group of
// candidates sharing that exact timestamp, reopening the same-timestamp skip risk the id tiebreak
// exists to close. ([적대 리뷰] Codex gate 2026-09-24, round 3)
function isCanonicalIsoString(value: string): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

// Exported (2026-09-26) so dismissNoReplyBacklog.ts's full-backlog scan mode can reuse this exact
// hardened parser (canonical-ISO + safe-document-id validation, see comments above) instead of
// re-implementing the same cursor-safety checks a second time.
export function readCursor(value: unknown): AutoReplyBacklogCursor | null {
  if (typeof value !== "string" || !value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const lastInboundAtIsoRaw = record.lastInboundAtIso;
  const lastInboundAtIso =
    typeof lastInboundAtIsoRaw === "string" && isCanonicalIsoString(lastInboundAtIsoRaw) ? lastInboundAtIsoRaw : "";
  const id = safeCursorDocumentId(record.id);
  if (!lastInboundAtIso || !id) return null;
  return { lastInboundAtIso, id };
}

function readRequeueRequest(data: Record<string, unknown>): {
  maxAgeHours: number;
  limit: number;
  dryRun: boolean;
  cursor: AutoReplyBacklogCursor | null;
} {
  return {
    maxAgeHours: clampInt(data.maxAgeHours, DEFAULT_MAX_AGE_HOURS, 1, MAX_MAX_AGE_HOURS),
    limit: clampInt(data.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    dryRun: data.dryRun !== false,
    cursor: readCursor(data.cursor),
  };
}

// ── Pure selection/skip logic (no Firestore) — exercised directly by
//    tests/auto-reply-backlog-requeue.test.mjs without an emulator. ─────────────────────────────

// manualReplyDetected is NOT produced by evaluateAutoReplyBacklogSkip below — that function is
// deliberately pure/no-Firestore (its whole point is being exercised without an emulator). The
// manual-reply check needs a message_sources read (see manualReplyDetection.ts), so it runs as a
// separate async step in requeueAutoReplyBacklog's loop, right after this pure check and still
// before the live model call. It shares this union/the `skipped` counter bucket so the reason
// vocabulary for "why didn't this candidate requeue" stays in one place.
export type AutoReplyBacklogSkipReason = "takenOver" | "alreadyReplied" | "aiInactive" | "recentlyDenied" | "orgExcluded" | "manualReplyDetected" | "humanReviewHeld";

// [적대 리뷰, case-backlog-send round 2, 2026-09-28] evaluateChatAutoCasePermit's deny reasons that
// exist ONLY because the case wasn't armed (or its pin/eval/counter evidence was stale) at judgment
// time — see evaluateChatAutoCasePermit in chatAutoCasePermit.ts for where each of these is pushed.
// Deliberately EXCLUDES reasons unrelated to arm state (case_unclassified, sender_not_creator,
// mail_safety_blocked, scp_gate_denied, case_not_auto_ok, etc.) — arming a case can never resolve
// those, so a marker carrying any of them must keep suppressing re-evaluation exactly as before.
const PERMIT_NOT_ARMED_DENY_REASONS: ReadonlySet<string> = new Set([
  "permit_missing",
  // [적대 리뷰, case-backlog-send round 3, 2026-09-28] evaluateChatAutoCasePermit
  // (chatAutoCasePermit.ts) pushes "permit_disarmed" for a permit doc that EXISTS but isn't
  // currently armed (`!input.permit.armed || input.permit.state !== "armed"`) — distinct from
  // "permit_missing" (no permit doc at all), but exactly as arm-state-resolvable: arming the case
  // fixes it. Omitting it here left a prior unscoped-sweep denial stamped "permit_disarmed"
  // permanently stuck as recentlyDenied even after the case was armed (confirmed by direct
  // repro) — the arm event that should have re-opened it was never recognized as relevant.
  "permit_disarmed",
  "permit_case_mismatch",
  "pin_mismatch",
  "eval_missing",
  "eval_not_passed",
  "counter_floor_not_met",
  "counter_evidence_unavailable",
]);

// [recentlyDenied policy re-arm fix, 2026-09-27] What actually changed between "a candidate was
// denied" and "this candidate might now be answerable" is not always a casebook edit — it can be
// a settings/humanReviewPolicy change (e.g. widening humanReviewPolicy.jevAlwaysSendCaseIds) or a
// pure code deploy that changes classification/attribution behavior with NO settings-doc write at
// all (e.g. PR #198's ownershipConflictAllOurScpPrograms — a sender_not_creator fix that shipped
// as a code-only change). CHAT_CASEBOOK_CONTENT_HASH alone catches neither. This fingerprint pairs
// with the existing casebookHash check in evaluateAutoReplyBacklogSkip/defaultWriteRequeueDenyMarker
// below — ANY of the three (casebookHash, settingsRevision, buildSha) changing re-arms the
// candidate for re-judgment.
export type AutoReplyBacklogPolicyFingerprint = {
  // settings/default's CAS revision counter (settingsRevisionFromRecord in settings.ts) — bumps on
  // every settings/default mutation, not just humanReviewPolicy, so this is a conservative
  // superset trigger (an unrelated settings change also re-arms) rather than a narrower
  // field-specific hash that could itself drift out of sync with what actually matters.
  settingsRevision: number;
  // Deployed functions build's git commit, from the SAME release-identity artifact the permit
  // arm/send buildSha gate already uses (chatAutoPermitReleaseIdentity.ts) — reused rather than
  // re-implemented. "" when unavailable (local dev/emulator, or a transient artifact-read
  // failure): an empty stored OR current value is always treated as a mismatch (see the compare
  // below), which biases toward paying for one extra live re-evaluation instead of silently
  // trusting a marker this process cannot prove is still valid under the current deploy.
  buildSha: string;
};

async function defaultReadRequeuePolicyFingerprint(): Promise<AutoReplyBacklogPolicyFingerprint> {
  const { revision } = await readSettingsWithRevision();
  return { settingsRevision: revision, buildSha: cachedChatAutoPermitReleaseSourceCommit() ?? "" };
}

/**
 * Conversation-level skip checks that don't require a fresh classification call. Order matters
 * only for the reason reported — a conversation can match more than one.
 *
 * recentlyDenied: a deny path in a previous requeue run stamps the conversation
 * (autoReplyRequeueDeniedAtIso/…CasebookHash/…SettingsRevision/…BuildSha) so the NEXT run skips it
 * before spending another live model call. Without this, every invocation re-processes the same
 * oldest-first persistent denials and burns the whole timeout window on them — a head-of-line
 * livelock that prevents the backlog from ever draining. The marker only suppresses re-evaluation
 * while it is newer than the last inbound message AND was written under the exact same casebook +
 * settings revision + deployed build as right now — a new inbound reply (newer lastInboundAtIso),
 * a casebook edit, a settings/policy change (e.g. humanReviewPolicy.jevAlwaysSendCaseIds), OR a
 * code-only deploy that changes classification/attribution/render behavior all re-arm the
 * candidate automatically. A marker written before this fix (missing the settings-revision/
 * buildSha fields entirely) also fails the comparison and re-arms — this fix is retroactive for
 * every already-stamped conversation, not just future denials.
 *
 * orgExcluded (auto-reply-org-controls, 2026-09-24): settings/default.automation.
 * autoReplyDisabledOrgIds (e.g. T049/AI Drama) is checked here too — a backlog sweep must never
 * requeue an auto-send for an org that the live inbound path (chat-ai.ts persistReceivedEmail) and
 * the send-time sweep (processAutoReplyQueue) both already refuse. Checked BEFORE spending a live
 * model call (unlike the other two enforcement points, this one can avoid the cost entirely).
 * Codex 적대 리뷰(2026-09-24, 1·2회차) BLOCKER 1: isAutoReplyOrgExcluded 만으로는 T049와 다른
 * 조직이 같은 공유 계정(전형적으로 scp)에 함께 매핑돼 있을 때를 못 잡는다 —
 * disabledOrgSharesMailAccount로 그 경우도 함께 잡는다(mailHumanGate.ts의 두 함수 doc 참고).
 * byOrgId는 mailAccounts.ts readByOrgIdForAutoReplyOrgExclusion() 결과를 그대로 넘기면 된다
 * (readMailRoutingCached가 아니다 — 그 5분 캐시는 여러 warm 인스턴스에 걸친 신선도를 이
 * 안전-critical 판정에서 보장 못 한다, 2회차 리뷰).
 *
 * humanReviewHeld (case-backlog-send round 2, 2026-09-28): review-pay.ts's transitionReviewRow
 * stamps `humanReviewStatus: "revise" | "pending"` (alongside `autoReplyStatus: "waiting_for_human"`)
 * when a HUMAN reviewer explicitly asked for a revision or left an item pending — this is a genuine,
 * actively-owned human hold, never a system "case not armed yet" denial. It must never be resurfaced
 * by any requeue path (scoped or unscoped) — checked here, unconditionally, before the
 * recentlyDenied/arm-event logic below, so no caseIdFilter-scoped bypass can ever reach it.
 *
 * caseArmContext (case-backlog-send round 2, 2026-09-28): [적대 리뷰] the original caseIdFilter fix
 * bypassed the ENTIRE recentlyDenied marker for a scoped run — too broad: it would also resurrect a
 * denial for reasons an arm event can never fix (case_unclassified, sender_not_creator,
 * mail_safety_blocked, scp_gate_denied). Narrowed: a marker is now bypassed ONLY when EVERY recorded
 * deny reason is in PERMIT_NOT_ARMED_DENY_REASONS (i.e. the denial existed solely because this case
 * wasn't armed/pinned/evidenced yet) AND the denial predates caseArmContext.armedAtIso (the current
 * permit doc's own updatedAtIso — bumped by every arm/eval-refresh). This is ADDITIVE to, not a
 * replacement for, the existing casebookHash/settingsRevision/buildSha re-arm checks below — either
 * mechanism re-arming is sufficient.
 */
export function evaluateAutoReplyBacklogSkip(
  conversationData: Record<string, unknown>,
  // Defaults to [] (no-op) so every existing 1/2-arg call site/test keeps its old behavior — only
  // requeueAutoReplyBacklog's real orchestration passes settings.automation.autoReplyDisabledOrgIds
  // and the live mail_routing.byOrgId map.
  disabledOrgIds: readonly string[] = [],
  byOrgId: Readonly<Record<string, unknown>> = {},
  // Sentinel default (never equals a real stored marker — real settingsRevision starts at 1 and a
  // real buildSha is a 40-char hex string) so a caller that doesn't pass one (e.g. a test only
  // exercising the aiInactive/takenOver/alreadyReplied/orgExcluded branches, which all return
  // before this is read) keeps its old behavior, while any caller that DOES reach the
  // recentlyDenied branch without an explicit fingerprint fails open to "not recently denied"
  // (re-evaluate) rather than silently matching every stale marker.
  currentPolicyFingerprint: AutoReplyBacklogPolicyFingerprint = { settingsRevision: -1, buildSha: "" },
  // null (default) when unscoped, or when scoped but the filtered case isn't actually armed — see
  // doc comment above.
  caseArmContext: { armedAtIso: string } | null = null,
): AutoReplyBacklogSkipReason | null {
  if (conversationData.aiActive === false) return "aiInactive";
  const manualStatus = asString(asRecord(conversationData.manualIntervention).status, "");
  if (manualStatus === "open") return "takenOver";
  const autoRepliedCaseIds = Array.isArray(conversationData.autoRepliedCaseIds)
    ? conversationData.autoRepliedCaseIds
    : [];
  if (autoRepliedCaseIds.length > 0) return "alreadyReplied";
  const humanReviewStatus = asString(conversationData.humanReviewStatus, "");
  if (humanReviewStatus === "revise" || humanReviewStatus === "pending") return "humanReviewHeld";
  if (
    isAutoReplyOrgExcluded({
      orgId: conversationData.orgId,
      mailAccountId: conversationData.mailAccountId,
      disabledOrgIds,
    }) || disabledOrgSharesMailAccount(disabledOrgIds, conversationData.mailAccountId, byOrgId)
  ) return "orgExcluded";
  const requeueDeniedAtIso = asString(conversationData.autoReplyRequeueDeniedAtIso, "");
  if (!requeueDeniedAtIso) return null;
  if (requeueDeniedAtIso < asString(conversationData.lastInboundAtIso, "")) return null;
  if (caseArmContext) {
    const deniedReasons = Array.isArray(conversationData.autoReplyRequeueDenyReasons)
      ? conversationData.autoReplyRequeueDenyReasons
      : [];
    const allNotArmedReasons = deniedReasons.length > 0
      && deniedReasons.every((reason) => typeof reason === "string" && PERMIT_NOT_ARMED_DENY_REASONS.has(reason));
    if (allNotArmedReasons && requeueDeniedAtIso < caseArmContext.armedAtIso) return null;
  }
  if (asString(conversationData.autoReplyRequeueDenyCasebookHash, "") !== CHAT_CASEBOOK_CONTENT_HASH) return null;
  // [적대 리뷰 LOW-2/LOW-3, 2026-09-27] Residual scope, not closed by this fix: this fingerprint
  // only covers the casebook + settings/default CAS revision + deployed build. A deny decision can
  // also turn on mail_suppressions/*, project_mail_profiles/*, or SCP application-fact docs
  // (evaluateMailSafety/resolveMailProfile/evaluateScpInquiryAutoReplyGate) — none of those bump
  // settingsRevision, so lifting a suppression or editing a profile/template alone won't re-arm a
  // marker. Likewise a settings/default write that bypasses updateSettings' CAS transaction (an
  // ops script's raw .set(merge)) won't bump revision either. Both gaps pre-date this fix (the old
  // casebookHash-only check had the same blind spot) and are bounded in practice — a deploy
  // re-arms everything via buildSha, and a fresh inbound reply re-arms via the lastInboundAtIso
  // comparison just above regardless of any of this (AUTO_REPLY_QUEUE_EXPIRY_HOURS, below, governs
  // an enqueued job's own send-by deadline — unrelated to this re-arm check).
  const storedSettingsRevision = asNumber(conversationData.autoReplyRequeueDenySettingsRevision, Number.NaN);
  if (storedSettingsRevision !== currentPolicyFingerprint.settingsRevision) return null;
  const storedBuildSha = asString(conversationData.autoReplyRequeueDenyBuildSha, "");
  if (!storedBuildSha || !currentPolicyFingerprint.buildSha || storedBuildSha !== currentPolicyFingerprint.buildSha) return null;
  return "recentlyDenied";
}

export function isAutoReplyBacklogCandidateStatus(value: unknown): value is (typeof SELECTABLE_AUTO_REPLY_STATUSES)[number] {
  return typeof value === "string" && (SELECTABLE_AUTO_REPLY_STATUSES as readonly string[]).includes(value);
}

/**
 * [적대 리뷰, case-backlog-send round 6, 2026-09-28] The two predicates defaultQueryCandidates'
 * own Firestore query enforces — `lastMessageFrom == "creator"` and `lastInboundAtIso` within the
 * requested age window — extracted into one shared, explicit check so BOTH candidate sources use
 * it: the normal windowed query (redundant there — the query already filtered it, this is just
 * defense-in-depth) AND the id-list re-read (readCandidatesByIds), which has NO query to enforce
 * either predicate at all.
 *
 * Why this matters for id-list mode specifically: a conversation whose latest activity moves to a
 * human reply between the preview read and the enqueue pass's fresh by-id re-read would otherwise
 * sail through undetected — externalSentConversationStitch.ts's own materialization touches only
 * `lastMessage`/`lastMessageFrom`/`lastMessageAtIso` (never `lastMessageRef`), so this is NOT the
 * same signal the commit transaction's own lastMessageRef/lastInboundAtIso staleness check already
 * covers. The separate manual-reply ledger check (detectManualReplySinceInbound) is a best-effort
 * signal that can miss an unstitched or not-yet-retried import — this is a direct, cheap check on
 * the exact field the query itself already filters on, not a replacement for that ledger check.
 */
export function isBacklogCandidateEligible(conversationData: Record<string, unknown>, cutoffIso: string): boolean {
  if (asString(conversationData.lastMessageFrom, "") !== "creator") return false;
  const lastInboundAtIso = asString(conversationData.lastInboundAtIso, "");
  return Boolean(lastInboundAtIso) && lastInboundAtIso >= cutoffIso;
}

/**
 * [적대 리뷰 HIGH-1] F-7 same-lane reclaim conservativeness: claimConversationAutoLane always
 * succeeds when the existing owner is the SAME lane ("auto_reply") — it never distinguishes "no
 * one is actively working this" from "a live inbound job already owns it". Without this guard the
 * requeue's own claim (jobRef = `requeue:...`) would silently steal the lane from a live
 * scheduled/processing job (jobRef = an `auto_reply_queue/...` doc path), and both jobs would then
 * write a queue doc for the same conversation. Pure/no-Firestore — reads only the already-fetched
 * candidate snapshot from the initial query; the authoritative, race-proof guard is the
 * transactional re-check in defaultCommitAutoReplyBacklogRequeue right before the write.
 */
/**
 * [적대 리뷰, case-backlog-send round 4, 2026-09-28] COST-P0 cheap prefilter's own trust condition,
 * isolated into one helper so it is a single, obvious edit point once conversations persist a
 * receive-time-scoped case reference proving freshness.
 *
 * [case-backlog-send round 8, 2026-09-28] feat/casebook-p1p2 landed a persisted stamp — chat-ai.ts
 * writes `autoCaseId`/`autoCaseMessageRef` on the conversation for every classified inbound — and
 * this was briefly wired up to trust it whenever `autoCaseMessageRef === lastMessageRef`.
 *
 * [case-backlog-send round 9, 2026-09-28, codex review] REVERTED — every call site below passes
 * `false` again, permanently. The stamp only proves MESSAGE identity (this is still the same inbound
 * message that got classified), never that the classification ITSELF is still valid under the
 * CURRENT casebook content, model version, or release. chat-ai.ts stamps whatever caseId the live
 * gateway returned AT THAT TIME, under whatever casebook/model/release was deployed then. If the
 * casebook (a case's own trigger conditions edited), the model, or the release has since changed,
 * the SAME message could classify differently TODAY — specifically, it could now match caseIdFilter
 * even though the stale stamp names a DIFFERENT case, and trusting the stamp would silently skip it
 * (`skipped.caseMismatch`) without ever giving it the fresh judgment that would prove it actually
 * belongs. That is exactly the false-skip failure round 4 built this guard to prevent — round 8 just
 * reintroduced it via a different kind of staleness (casebook/model/release drift) than round 4
 * anticipated (message-identity drift). Safely enabling this would require the stamp to ALSO carry
 * the casebook content hash and model/release identity active at classification time (see
 * chatAutoCasePermitPin/CHAT_CASEBOOK_CONTENT_HASH) and compare that against the CURRENT pin before
 * trusting it — `autoCaseId`/`autoCaseMessageRef` alone is not enough. Cost is bounded regardless
 * (this callable never scans past MAX_LIMIT≈200 rows per invocation, and "지금 보내기" is an
 * infrequent, human-triggered action, not a background sweep), so paying for one extra live model
 * call per row is an acceptable, deliberate price for correctness — this is not a TODO to re-enable
 * casually.
 *
 * chatAutoCaseBacklogSend.ts's own `chatAutoCaseHeldBacklogPrimaryCaseId` (the "보류 N건" label) is a
 * DIFFERENT, lower-stakes case and is NOT reverted: it is a display-only estimate, never gates an
 * actual send (sendChatAutoCaseHeldBacklogNow always re-derives the real caseId from a fresh
 * `gateway.caseId` live judgment — see the caseIdFilter match check below), so the same
 * casebook/model/release drift risk this function guards against does not apply there.
 *
 * The rest of this function's contract from round 4 is unchanged: when `isStoredClassificationCurrent`
 * is false, this always returns null; the case_unclassified guard and "the first candidate is the
 * decided case" still apply whenever a caller passes `true` (kept for the unit tests below and any
 * future caller with a genuinely stronger freshness proof, e.g. one that also pins casebook/model).
 */
export function trustedStoredPrimaryCaseId(
  conversationData: Record<string, unknown>,
  isStoredClassificationCurrent: boolean,
): string | null {
  if (!isStoredClassificationCurrent) return null;
  const deniedReasonsSoFar = Array.isArray(conversationData.permitDenyReasons) ? conversationData.permitDenyReasons : [];
  if (deniedReasonsSoFar.includes("case_unclassified")) return null;
  const storedCandidates = Array.isArray(conversationData.caseCandidates) ? conversationData.caseCandidates : [];
  if (storedCandidates.length === 0) return null;
  return asString(asRecord(storedCandidates[0]).caseId, "") || null;
}

export function isConversationAutoLaneLockedForRequeue(conversationData: Record<string, unknown>): boolean {
  const owner = asRecord(conversationData.autoLaneOwner);
  const jobRef = asString(owner.jobRef, "");
  if (!jobRef) return false;
  return !jobRef.startsWith("requeue:");
}

/**
 * Builds the receive-time-shaped gateway input from the stored last-inbound message_sources doc.
 * Pure — no Firestore, no model call. The literal `signal` construction mirrors receiveEmail's
 * gatewaySignal (subject + body), which is what decideHumanGate/the model prompt actually see.
 *
 * [적대 리뷰, case-backlog-send round 2, 2026-09-28] `mailAccountId` was missing entirely — chat-
 * ai.ts's runGatewayLive reads `data.mailAccountId` to decide `isCanonicalScpAccount`/`jevRequired`
 * (the identity-based JEV-consultation gate — see chat-ai.ts's `const jevRequired = ...` around the
 * canonical-scp block). Without it every backlog-reclassified candidate looked mailbox-less, so
 * `jevRequired` fell through to the WEAKER content-heuristic fallback
 * (`scpInquiryAutoReplyRequired`) instead of the identity check — a genuine scp@ conversation could
 * silently skip the mandatory JEV final judgment on reclassification. This is a PRE-EXISTING gap in
 * the unscoped sweep too (nothing about it is caseIdFilter-specific); fixing it here fixes both.
 */
export function buildAutoReplyBacklogGatewayInput(input: {
  conversationId: string;
  sourceDoc: Record<string, unknown>;
  mailAccountId?: string;
  // [적대 리뷰, case-backlog-send round 2, 2026-09-28] the CONVERSATION's own persisted
  // lastMessageRef (latest-inbound identity) — distinct from `messageRef` below, which is the
  // SOURCE doc's own originalMessageRef/messageRef (an external provider reference that can repeat
  // across distinct inbound message_sources records). sendChatAutoCaseHeldBacklogNow's
  // gateway-judgment cache keys on THIS field (see chatAutoCaseBacklogSend.ts), never on
  // `messageRef`, so a stale judgment can never be reused for a conversation whose latest inbound
  // message actually changed between the dry-run and real pass.
  conversationLastMessageRef?: string;
}): Record<string, unknown> {
  const { conversationId, sourceDoc } = input;
  const subject = asString(sourceDoc.subject, "");
  const body = asString(sourceDoc.body, "");
  const signal = [subject, body].filter(Boolean).join(" | ");
  return {
    conversationId,
    messageRef: asString(sourceDoc.originalMessageRef, asString(sourceDoc.messageRef, "")),
    conversationLastMessageRef: asString(input.conversationLastMessageRef, ""),
    trackingId: asString(sourceDoc.trackingId, ""),
    intent: "requeue-auto-reply-backlog",
    signal,
    subject,
    body,
    // Copy parser-proven attachment state from the stored source row. Missing legacy metadata
    // stays unknown so approval-status classification fails closed rather than assuming clean.
    ...(typeof sourceDoc.hasInboundAttachments === "boolean"
      ? { hasInboundAttachments: sourceDoc.hasInboundAttachments }
      : {}),
    text: body,
    from: asString(sourceDoc.from, ""),
    to: asString(sourceDoc.to, ""),
    // Prefer the sticky conversation-level mailAccountId (threaded via `input.mailAccountId`);
    // fall back to whatever the stored message_sources doc itself carries.
    mailAccountId: asString(input.mailAccountId, asString(sourceDoc.mailAccountId, "")),
    programId: asString(sourceDoc.programId, ""),
    campaignId: asString(sourceDoc.campaignId, ""),
    programTitle: asString(sourceDoc.programTitle, ""),
    campaignTitle: asString(sourceDoc.campaignTitle, ""),
    creatorId: asString(sourceDoc.creatorId, ""),
    creatorFollowers: asNumber(sourceDoc.creatorFollowers, 0),
    creatorRecentViews: asNumber(sourceDoc.creatorRecentViews, 0),
    creatorEngagementPct: asNumber(sourceDoc.creatorEngagementPct, 0),
    // classification_v1: the stored minimal routing evidence (List-*/Precedence/Auto-Submitted flags) so the RFC 3834
    // "never auto-reply an Auto-Submitted message" hold also applies when a held message is re-judged from its source.
    ...(normalizeInboundRoutingFlags(sourceDoc.inboundRoutingHeaders)
      ? { routingHeaders: normalizeInboundRoutingFlags(sourceDoc.inboundRoutingHeaders) }
      : {}),
  };
}

// ── Orchestration (Firestore + live gateway) ────────────────────────────────────────────────────

export type AutoReplyBacklogDependencies = {
  now?: () => Date;
  queryCandidates?: (input: { cutoffIso: string; limit: number; cursor: AutoReplyBacklogCursor | null; restrictToMailAccountId?: string }) => Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  // [적대 리뷰, case-backlog-send round 5, 2026-09-28] used instead of queryCandidates when the
  // request carries `conversationIds` — reads each id fresh, in the given order. Missing docs come
  // back as `{ id, data: {} }` (never thrown — the existing `isAutoReplyBacklogCandidateStatus`
  // defensive check then skips them the same way a query would have excluded them).
  readCandidatesByIds?: (ids: readonly string[]) => Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  /** Recheck caller authorization against the transaction-fresh conversation immediately before enqueue. */
  authorizeConversationAtCommit?: (freshConversationData: Record<string, unknown>) => boolean;
  readMailAccounts?: () => Promise<InboundAutoReplyAccount[]>;
  readLatestInboundSource?: (conversationData: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  readSettings?: typeof readSettings;
  readRequeuePolicyFingerprint?: () => Promise<AutoReplyBacklogPolicyFingerprint>;
  readByOrgIdForAutoReplyOrgExclusion?: typeof readByOrgIdForAutoReplyOrgExclusion;
  detectManualReply?: typeof detectManualReplySinceInbound;
  runGatewayLive?: typeof runGatewayLive;
  buildChatAutoPermitReceivePlan?: typeof buildChatAutoPermitReceivePlan;
  evaluateScpInquiryAutoReplyGate?: typeof evaluateScpInquiryAutoReplyGate;
  resolveMailProfile?: typeof resolveMailProfile;
  evaluateMailSafety?: typeof evaluateMailSafety;
  recordMailSuppression?: typeof recordMailSuppression;
  claimConversationAutoLane?: typeof claimConversationAutoLane;
  releaseConversationAutoLane?: typeof releaseConversationAutoLane;
  commitRequeue?: typeof defaultCommitAutoReplyBacklogRequeue;
  writeRequeueDenyMarker?: typeof defaultWriteRequeueDenyMarker;
  readPermit?: typeof readChatAutoCasePermit;
  // [case-backlog-send round 2, 2026-09-28] per-row wall-clock budget — see the main loop below.
  // `nowMs`/`deadlineMs` are a SEPARATE clock pair from `now` (which stamps written records) so a
  // caller (sendChatAutoCaseHeldBacklogNow) can thread its OWN elapsed-time source through without
  // perturbing what gets written as `nowIso`. `deadlineMs` is an absolute epoch-ms value (NOT a
  // duration) computed once by the caller — omitted, the loop never stops early (processes the
  // whole fetched page, matching pre-existing behavior for every caller that doesn't pass one).
  nowMs?: () => number;
  deadlineMs?: number;
};

/**
 * Persistent-denial marker written on deliberate deny paths (post-model permit/scp-gate denials,
 * unrenderable drafts, unclassifiable cases) so the next requeue invocation skips the candidate
 * before paying for another live model call. Deliberately NOT written for transient failures
 * (gateway_unavailable, internal_error, stale commit races) — those must be retried.
 */
async function defaultWriteRequeueDenyMarker(input: {
  conversationId: string;
  reasons: readonly string[];
  nowIso: string;
  policyFingerprint: AutoReplyBacklogPolicyFingerprint;
}): Promise<void> {
  await adminDb.collection("conversations").doc(input.conversationId).update({
    autoReplyRequeueDeniedAtIso: input.nowIso,
    autoReplyRequeueDenyReasons: [...input.reasons],
    autoReplyRequeueDenyCasebookHash: CHAT_CASEBOOK_CONTENT_HASH,
    autoReplyRequeueDenySettingsRevision: input.policyFingerprint.settingsRevision,
    autoReplyRequeueDenyBuildSha: input.policyFingerprint.buildSha,
  });
}

export type RequeueAutoReplyBacklogResult = {
  ok: true;
  scanned: number;
  requeued: number;
  skipped: {
    takenOver: number;
    alreadyReplied: number;
    laneLocked: number;
    aiInactive: number;
    denied: number;
    stale: number;
    recentlyDenied: number;
    orgExcluded: number;
    manualReplyDetected: number;
    // case-backlog-send (2026-09-27): a candidate that passed every gate above but was freshly
    // reclassified into a DIFFERENT case than caseIdFilter — never populated when caseIdFilter is
    // unset (an unscoped sweep never buckets anything here).
    caseMismatch: number;
    // case-backlog-send round 2 (2026-09-28): an explicit human review hold (humanReviewStatus
    // revise/pending) — never auto-released regardless of caseIdFilter/arm state.
    humanReviewHeld: number;
  };
  denyReasons: Record<string, number>;
  // Counts of the internal sub-reasons behind denyReasons.sender_not_creator (BacklogSenderIdentityDiagnostic).
  senderIdentityDiagnostics: Record<string, number>;
  dryRun: boolean;
  // ISO-8601 lastInboundAtIso of the last scanned candidate, or null when the page came back
  // short of `limit` (the window is exhausted). Pass back as `cursor` to resume a bounded sweep.
  nextCursor: string | null;
  // [적대 리뷰, case-backlog-send round 3, 2026-09-28] true when THIS call stopped because
  // deps.deadlineMs was reached, rather than because the query genuinely came back short of
  // `limit`. A multi-page caller (sendChatAutoCaseHeldBacklogNow) needs this to tell "ran out of
  // time, more work likely remains" apart from "there is nothing left to do" — critically, even
  // when `nextCursor` is null (deadlineHit + null nextCursor must NEVER be read as "exhausted").
  deadlineHit: boolean;
  // [적대 리뷰, case-backlog-send round 5, 2026-09-28] the conversation ids that reached the
  // "dry_run_preview" outcome this call (only populated when dryRun is true — mirrors
  // denyReasons.dry_run_preview exactly, same two exit points). The exact list a following real
  // (dryRun:false) call should be given via `conversationIds` in its own request, so the real pass
  // never re-derives "which rows" from a fresh count-bounded query that could drift from what this
  // dry-run call actually examined. Always [] for a real (non-dry) call.
  plannedConversationIds: string[];
  behaviorLog: Record<string, unknown>;
};

// [적대 리뷰 HIGH-1] Write-time race guard: the candidate query runs once, then each candidate is
// processed serially with a real LLM call (seconds of latency) — a live inbound reply can enqueue
// its own auto_reply_queue job for the same conversation in that window. This is the ONLY place
// that actually prevents a double-send: it re-reads the conversation and checks for a live queue
// job INSIDE the same transaction that performs the enqueue write, so the check and the write are
// atomic. `originalConversationData` is the candidate snapshot from the initial query — if the
// live doc has since diverged on any of the three fields below, or a scheduled/processing job
// already exists, the transaction aborts without writing anything.
export type AutoReplyBacklogCommitOutcome =
  | { committed: true }
  | { committed: false; reason: "stale_conversation" | "live_job_exists" | "human_review_held" | "scope_denied" };

export async function defaultCommitAutoReplyBacklogRequeue(input: {
  conversationId: string;
  originalConversationData: Record<string, unknown>;
  queueRef: FirebaseFirestore.DocumentReference;
  queueDocBase: Record<string, unknown>;
  conversationPatch: Record<string, unknown>;
  fallbackCaseIntentRef: string | null;
  authorizeConversationAtCommit?: (freshConversationData: Record<string, unknown>) => boolean;
  caseIntentInput: {
    conversationId: string;
    messageSourceId: string;
    caseId: ChatAutoPermitCaseId;
    queueRef: FirebaseFirestore.DocumentReference;
    decision: ChatAutoCasePermitDecision;
    nowIso: string;
  };
}): Promise<AutoReplyBacklogCommitOutcome> {
  const conversationRef = adminDb.collection("conversations").doc(input.conversationId);
  const liveQueueQuery = adminDb
    .collection("auto_reply_queue")
    .where("conversationId", "==", input.conversationId)
    .where("status", "in", ["scheduled", "processing"])
    .limit(1);
  return adminDb.runTransaction(async (transaction) => {
    const [conversationSnapshot, liveQueueSnapshot] = await Promise.all([
      transaction.get(conversationRef),
      transaction.get(liveQueueQuery),
    ]);
    if (!liveQueueSnapshot.empty) {
      return { committed: false, reason: "live_job_exists" };
    }
    const freshData = conversationSnapshot.exists
      ? ((conversationSnapshot.data() as Record<string, unknown>) ?? {})
      : {};
    const original = input.originalConversationData;
    const stale =
      asString(freshData.lastMessageRef, "") !== asString(original.lastMessageRef, "") ||
      asString(freshData.lastInboundAtIso, "") !== asString(original.lastInboundAtIso, "") ||
      asString(freshData.autoReplyStatus, "") !== asString(original.autoReplyStatus, "");
    if (stale) {
      return { committed: false, reason: "stale_conversation" };
    }
    // Authorization scope can change while the gateway judgment is in flight. A caller may
    // provide a row-level predicate so the same transaction that enqueues the reply also checks
    // the fresh conversation's current org/mail-account scope.
    if (input.authorizeConversationAtCommit && !input.authorizeConversationAtCommit(freshData)) {
      return { committed: false, reason: "scope_denied" };
    }
    // [적대 리뷰, case-backlog-send round 6, 2026-09-28] lastMessageFrom flipping to a human reply
    // is NOT necessarily caught by the lastMessageRef/lastInboundAtIso checks above —
    // externalSentConversationStitch.ts's own materialization touches only
    // lastMessage/lastMessageFrom/lastMessageAtIso, never lastMessageRef, so a stitched manual
    // reply landing between the initial read and this exact instant could otherwise slip through
    // both this transaction and the id-list re-read's own isBacklogCandidateEligible check (which
    // only sees whatever was fetched BEFORE this transaction's own fresh read). Re-assert it here,
    // inside the same transaction as the write, so it always wins.
    if (asString(freshData.lastMessageFrom, "") !== "creator") {
      return { committed: false, reason: "stale_conversation" };
    }
    // [적대 리뷰, case-backlog-send round 2, 2026-09-28] A human reviewer can stamp
    // humanReviewStatus "revise"/"pending" (review-pay.ts transitionReviewRow) WHILE this
    // candidate's live reclassification is in flight (a real model call — seconds of latency) —
    // and that transition leaves `autoReplyStatus` at "waiting_for_human" the whole time (see
    // review-pay.ts domainReviewPatches: revise/pending both map to "waiting_for_human"), so the
    // staleness check just above never notices it. Without this, a fresh human hold that appeared
    // mid-flight would be silently queued over. Re-read here — inside the SAME transaction as the
    // write — so a hold that appears between the initial query and this exact instant still wins.
    const freshHumanReviewStatus = asString(freshData.humanReviewStatus, "");
    if (freshHumanReviewStatus === "revise" || freshHumanReviewStatus === "pending") {
      return { committed: false, reason: "human_review_held" };
    }
    const caseIntentRef = writeChatAutoCaseIntentBatch(transaction, input.caseIntentInput);
    transaction.set(
      input.queueRef,
      {
        ...input.queueDocBase,
        caseIntentRef: caseIntentRef?.path ?? input.fallbackCaseIntentRef ?? FieldValue.delete(),
      },
      { merge: true },
    );
    transaction.set(conversationRef, input.conversationPatch, { merge: true });
    return { committed: true };
  });
}

// [적대 리뷰, case-backlog-send round 2, 2026-09-28] restrictToMailAccountId is a QUERY PREDICATE,
// not a post-classification filter — a caseIdFilter-scoped run (see requeueAutoReplyBacklog) passes
// "scp" here so the Firestore query itself never RETURNS a non-scp conversation, instead of fetching
// the whole cross-mailbox backlog and discarding non-matches after paying for reads/classification.
// This also closes the authorization gap a manager-without-scp-entitlement scope check alone can't:
// even a genuinely scp-entitled operator's "지금 보내기" click can never touch another org's mailbox
// through this path. Requires the composite index (mailAccountId, lastMessageFrom, autoReplyStatus,
// lastInboundAtIso, __name__) in firestore.indexes.json.
async function defaultQueryCandidates(input: { cutoffIso: string; limit: number; cursor: AutoReplyBacklogCursor | null; restrictToMailAccountId?: string }): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  let query: FirebaseFirestore.Query = adminDb.collection("conversations");
  if (input.restrictToMailAccountId) {
    query = query.where("mailAccountId", "==", input.restrictToMailAccountId);
  }
  query = query
    .where("lastMessageFrom", "==", "creator")
    .where("autoReplyStatus", "in", [...SELECTABLE_AUTO_REPLY_STATUSES])
    .where("lastInboundAtIso", ">=", input.cutoffIso)
    // Document id as a secondary sort key breaks ties within a shared lastInboundAtIso value —
    // required for startAfter(iso, id) below to be an unambiguous, gap-free page boundary
    // ([적대 리뷰] Codex gate 2026-09-24, HIGH: lastInboundAtIso alone can repeat across
    // conversations, e.g. a bulk backfill or campaign send landing multiple inbound replies in
    // the same second — startAfter(iso) alone would then skip whichever of that group didn't
    // make the previous page).
    .orderBy("lastInboundAtIso", "asc")
    .orderBy(FieldPath.documentId(), "asc");
  // Pagination: resume strictly after the last candidate the previous page scanned, oldest-first.
  if (input.cursor) query = query.startAfter(input.cursor.lastInboundAtIso, input.cursor.id);
  const snapshot = await query.limit(input.limit).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() ?? {} }));
}

// [적대 리뷰, case-backlog-send round 5, 2026-09-28] see AutoReplyBacklogDependencies's own doc
// comment — reads exactly the given ids fresh via a single batched getAll, in the given order.
async function defaultReadCandidatesByIds(ids: readonly string[]): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  if (ids.length === 0) return [];
  const refs = ids.map((id) => adminDb.collection("conversations").doc(id));
  const snapshots = await adminDb.getAll(...refs);
  return snapshots.map((snapshot, index) => ({ id: ids[index], data: snapshot.exists ? (snapshot.data() ?? {}) : {} }));
}

async function defaultReadLatestInboundSource(conversationData: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const lastMessageRef = asString(conversationData.lastMessageRef, "");
  if (!lastMessageRef) return null;
  const snapshot = await adminDb.doc(lastMessageRef).get();
  if (!snapshot.exists) return null;
  return snapshot.data() ?? {};
}

/**
 * A stored creatorId is not proof of sender identity: legacy receive writes may have filled it
 * with the conversationId when attribution had no creator identity. Backlog reclassification
 * therefore requires the same server-computed inbound attribution evidence used by fresh receive,
 * or the receive path's server-stamped personal-account registration result. Never accept a
 * caller/job boolean as a substitute for these source-of-truth fields.
 */
export function isVerifiedBacklogSenderIdentity(
  sourceDoc: Record<string, unknown>,
  conversationId: string,
  allowedAccountIds: unknown,
  accounts: readonly InboundAutoReplyAccount[],
  options: BacklogSenderIdentityOptions = {},
): boolean {
  return diagnoseBacklogSenderIdentity(sourceDoc, conversationId, allowedAccountIds, accounts, options).ok;
}

/** `allowIdentityOnly` = humanReviewPolicy.allowIdentityOnlyAutoReply (kill switch). Default false: fail closed. */
export type BacklogSenderIdentityOptions = { allowIdentityOnly?: boolean };

/**
 * Internal sub-reason codes for WHY `sender_not_creator` fired (2026-10-03). They never change the
 * verdict — `isVerifiedBacklogSenderIdentity` is exactly `diagnose(...).ok` — and are surfaced to
 * operators only as counts (`senderIdentityDiagnostics`) and audit counters.
 */
export type BacklogSenderIdentityDiagnostic =
  | "ok"
  | "source_shape_invalid"
  | "provenance_missing"
  | "account_untrusted"
  | "attribution_review_required"
  | "identity_binding_review_required"
  | "binding_missing_legacy"
  | "identity_binding_invalid"
  | "identity_ambiguous"
  | "identity_candidate_unlinked"
  | "identity_only_disabled"
  | "identity_only_not_for_personal"
  | "identity_only_agency_actor"
  | "policy_version_mismatch"
  | "attribution_status_unverified"
  | "identity_evidence_missing";

export function diagnoseBacklogSenderIdentity(
  sourceDoc: Record<string, unknown>,
  conversationId: string,
  allowedAccountIds: unknown,
  accounts: readonly InboundAutoReplyAccount[],
  options: BacklogSenderIdentityOptions = {},
): { ok: boolean; reason: BacklogSenderIdentityDiagnostic; identityOnly?: true } {
  const creatorId = asString(sourceDoc.creatorId, "");
  const provenance = asRecord(sourceDoc.inboundMailProvenance);
  const accountId = asString(provenance.accountId, "");
  const mailbox = asString(provenance.mailbox, "");
  if (sourceDoc.source !== "receiveEmail" || sourceDoc.direction !== "inbound" || creatorId.includes("/")) {
    return { ok: false, reason: "source_shape_invalid" };
  }
  if (
    asString(provenance.kind, "") !== "imap"
    || !accountId
    || !mailbox
    || asString(sourceDoc.mailAccountId, "") !== accountId
    || asString(sourceDoc.accountMailbox, "") !== mailbox
  ) return { ok: false, reason: "provenance_missing" };
  // A program-attributed binding still needs resolved attribution (checked after the binding is read: identity_only
  // proves only the address and is allowed while program attribution is unresolved).
  const earlyBinding = readSenderBindingForGate(sourceDoc);
  const identityOnlyScope = earlyBinding.ok && earlyBinding.scope === "identity_only";
  if (sourceDoc.attributionReviewRequired === true && !identityOnlyScope) return { ok: false, reason: "attribution_review_required" };
  if (!isTrustedInboundAutoReplyAccount({
    allowedAccountIds,
    accountId,
    accountMailbox: mailbox,
    account: accounts.find((item) => item.accountId === accountId) ?? null,
  })) return { ok: false, reason: "account_untrusted" };
  // POSITIVE ALLOWLIST: every source — personal accounts included — needs a current VERIFIED
  // actual-sender <-> outreach-recipient binding (inboundSenderIdentity.ts). Legacy rows (no binding),
  // review_required and invalid bindings, and ambiguous creators are all denied.
  const senderBinding = earlyBinding;
  if (!senderBinding.ok) return { ok: false, reason: senderBinding.reason };
  {
    const binding = asRecord(sourceDoc.senderIdentityBinding);
    const linkedRefs = Array.isArray(binding.linkedCandidateRefs) ? binding.linkedCandidateRefs.filter((v): v is string => typeof v === "string") : [];
    const linkedKeys = Array.isArray(binding.linkedIdentityKeys) ? binding.linkedIdentityKeys.filter((v): v is string => typeof v === "string") : [];
    // The SAME stored canonical groups the repair / ingest wrote (shared reader): all gates judge identical identities.
    const identityGroups = readCanonicalIdentityGroups(binding.canonicalIdentityGroups);
    const aliasKeys = senderBinding.scope === "identity_only" ? readAddressAliasKeys(binding.addressAliasKeys) : [];
    if (hasAmbiguousCreatorIdentity(asRecord(sourceDoc.attribution).rankedCandidates, asString(binding.outboundRef, ""), linkedRefs, linkedKeys, identityGroups, aliasKeys)) {
      return { ok: false, reason: "identity_ambiguous" };
    }
    if (senderBinding.scope === "identity_only") {
      // Address-only identity: kill switch, no personal-registry shortcut, no explicit creator identity left unlinked.
      // (The case-level program-facts refusal runs once the case is known — requeue / dispatch.)
      if (options.allowIdentityOnly !== true) return { ok: false, reason: "identity_only_disabled" };
      if (personalRegistered(sourceDoc)) return { ok: false, reason: "identity_only_not_for_personal" };
      if (sourceActorIsAgency(sourceDoc)) return { ok: false, reason: "identity_only_agency_actor" };
      if (hasUnlinkedExplicitIdentity(asRecord(sourceDoc.attribution).rankedCandidates, asString(binding.outboundRef, ""), linkedRefs, linkedKeys, identityGroups, aliasKeys)) {
        return { ok: false, reason: "identity_candidate_unlinked" };
      }
      return { ok: true, reason: "ok", identityOnly: true };
    }
    if (!personalRegistered(sourceDoc) && !hasCandidateLinkedToProvingSend(asRecord(sourceDoc.attribution).rankedCandidates, asString(binding.outboundRef, ""), linkedRefs, linkedKeys)) {
      return { ok: false, reason: "identity_candidate_unlinked" };
    }
  }

  // Personal mail's receive-time registry lookup is server-side and stamped only after a match.
  // Keep this tied to the per-event source stamp and the matching Firestore candidate reference;
  // the conversation-level registration flag is sticky and cannot prove this inbound sender.
  const registeredCandidateRef = asString(sourceDoc.candidateRef, "");
  if (
    sourceDoc.counterpartyRegistered === true
    && /^candidate_pool\/[A-Za-z0-9_.:-]+$/.test(registeredCandidateRef)
  ) return { ok: true, reason: "ok" };

  const attribution = asRecord(sourceDoc.attribution);
  if (attribution.policyVersion !== VERIFIED_ATTRIBUTION_POLICY_VERSION) return { ok: false, reason: "policy_version_mismatch" };
  if (attribution.reviewRequired !== false) return { ok: false, reason: "attribution_review_required" };
  if (!["automatic", "manual_confirmed"].includes(asString(attribution.attributionStatus, ""))) {
    return { ok: false, reason: "attribution_status_unverified" };
  }

  const rankedCandidates = Array.isArray(attribution.rankedCandidates)
    ? attribution.rankedCandidates
    : [];
  const identityKeys = new Set<string>();
  // canonicalCreatorIdForData historically falls back to conversationId. Do not turn that
  // placeholder into a creator identity; it is permitted only when separate source attribution
  // evidence below independently links the inbound sender hash to a creator candidate.
  if (creatorId && creatorId !== conversationId) {
    identityKeys.add(`creator:${creatorId.normalize("NFKC").trim().toLowerCase()}`);
  }
  const channelId = asString(sourceDoc.channelId, asString(sourceDoc.youtubeChannelId, asString(sourceDoc.creatorChannelId, "")))
    .normalize("NFKC").trim().toLowerCase();
  if (channelId) identityKeys.add(`channel:${channelId}`);
  const handle = asString(sourceDoc.creatorHandle, asString(sourceDoc.handle, ""))
    .normalize("NFKC").trim().toLowerCase().replace(/^@+/, "").replace(/\s+/g, "");
  if (handle) identityKeys.add(`handle:${handle}`);
  const candidateId = asString(sourceDoc.candidateId, asString(sourceDoc.leadId, asString(sourceDoc.applicationId, "")))
    .normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
  if (candidateId) identityKeys.add(`candidate:${candidateId}`);
  const youtubeUrl = asString(sourceDoc.youtubeUrl, asString(sourceDoc.channelUrl, ""));
  if (youtubeUrl) {
    try {
      const parsed = new URL(youtubeUrl);
      const canonical = `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
      if (canonical) identityKeys.add(`youtube:${canonical}`);
    } catch {
      const canonical = youtubeUrl.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
      if (canonical) identityKeys.add(`youtube:${canonical}`);
    }
  }
  // `fromHash` historically hashed the (possibly outbound-copied) creatorEmail, not the real From.
  // Rows written since 2026-10-03 carry the actual server-parsed sender in `inboundSenderHash`;
  // when present that — never the conflated value — is what the `recipient:` identity key means.
  const inboundSenderHash = asString(sourceDoc.inboundSenderHash, "");
  const fromHash = /^[a-f0-9]{24}$/.test(inboundSenderHash) ? inboundSenderHash : asString(sourceDoc.fromHash, "");
  if (/^[a-f0-9]{24}$/.test(fromHash)) identityKeys.add(`recipient:${fromHash}`);
  // A repair-written verified binding adds the bound candidate's key — but that candidate must cite
  // the very outbound record that proved From == recipient (checked in the match below).
  if (senderBinding.identityKey) identityKeys.add(senderBinding.identityKey);
  const matched = rankedCandidates.some((value) => {
    const candidate = asRecord(value);
    const candidateRef = asString(candidate.candidateRef, "");
    const programId = asString(candidate.programId, "");
    const identityKey = asString(candidate.creatorIdentityKey, "");
    const evidenceRefs = Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs : [];
    const signalIds = Array.isArray(candidate.signalIds) ? candidate.signalIds : [];
    return Boolean(
      /^[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]+$/.test(candidateRef)
      && programId
      && identityKey
      && identityKey !== "identity:unknown"
      && identityKeys.has(identityKey)
      && Number.isFinite(candidate.score)
      && Number(candidate.score) > 0
      && evidenceRefs.some((ref) => typeof ref === "string" && /^[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]+$/.test(ref))
      && signalIds.some((signal) => typeof signal === "string" && signal.length > 0)
      && (
        !senderBinding.identityKey
        || identityKey !== senderBinding.identityKey
        || evidenceRefs.includes(senderBinding.outboundRef)
      )
    );
  });
  return matched ? { ok: true, reason: "ok" } : { ok: false, reason: "identity_evidence_missing" };
}

function incrementDenyReasons(target: Record<string, number>, reasons: readonly string[]): void {
  for (const reason of reasons) {
    target[reason] = (target[reason] ?? 0) + 1;
  }
}

export async function requeueAutoReplyBacklog(
  request: CallableRequestShape,
  deps: AutoReplyBacklogDependencies = {},
): Promise<RequeueAutoReplyBacklogResult> {
  const auth = assertNonGuestAuth(request, "auto_reply_backlog.requeue", ["super_admin"]);
  const data = asRecord(request.data);
  const { maxAgeHours, limit, dryRun, cursor } = readRequeueRequest(data);
  if (!dryRun && asString(data.confirm, "") !== AUTO_REPLY_BACKLOG_CONFIRM_TOKEN) {
    const error = new Error(`confirm must equal "${AUTO_REPLY_BACKLOG_CONFIRM_TOKEN}" when dryRun=false`);
    Object.assign(error, { code: "invalid-argument", errorCode: "requeue_auto_reply_backlog_confirm_required" });
    throw error;
  }
  // case-backlog-send (2026-09-27): optional, validated ∈ CHAT_CASEBOOK. Kept OUT of
  // readRequeueRequest (a pure, no-Firestore/no-throw parser) because this is the one field here
  // that must reject an unknown value outright rather than silently fall back — a typo'd caseId
  // must never quietly degrade into "no filter" (which would sweep/send the ENTIRE backlog instead
  // of the one case an operator meant to scope to).
  const caseIdFilterRaw = typeof data.caseIdFilter === "string" ? data.caseIdFilter.trim() : "";
  let caseIdFilter: ChatAutoPermitCaseId | null = null;
  if (caseIdFilterRaw) {
    if (!isChatAutoPermitCaseId(caseIdFilterRaw)) {
      const error = new Error(`caseIdFilter "${caseIdFilterRaw}" must be a known casebook case`);
      Object.assign(error, { code: "invalid-argument", errorCode: "requeue_auto_reply_backlog_case_id_filter_invalid" });
      throw error;
    }
    caseIdFilter = caseIdFilterRaw;
  }
  // [적대 리뷰, case-backlog-send round 5, 2026-09-28] optional — see RequeueAutoReplyBacklogRequest's
  // own doc comment. Kept OUT of readRequeueRequest for the same reason caseIdFilter is: a malformed
  // value must reject outright rather than silently fall back to the windowed query (which would
  // sweep a much wider set than the caller asked for).
  const conversationIdsRaw = data.conversationIds;
  let conversationIds: readonly string[] | null = null;
  if (conversationIdsRaw !== undefined) {
    if (!Array.isArray(conversationIdsRaw) || conversationIdsRaw.some((id) => typeof id !== "string" || !id)) {
      const error = new Error("conversationIds must be an array of non-empty strings");
      Object.assign(error, { code: "invalid-argument", errorCode: "requeue_auto_reply_backlog_conversation_ids_invalid" });
      throw error;
    }
    conversationIds = conversationIdsRaw as string[];
  }

  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - maxAgeHours * 60 * 60 * 1000).toISOString();

  const queryCandidates = deps.queryCandidates ?? defaultQueryCandidates;
  const readCandidatesByIds = deps.readCandidatesByIds ?? defaultReadCandidatesByIds;
  const readLatestInboundSource = deps.readLatestInboundSource ?? defaultReadLatestInboundSource;
  const runLiveGateway = deps.runGatewayLive ?? runGatewayLive;
  const buildPermitPlan = deps.buildChatAutoPermitReceivePlan ?? buildChatAutoPermitReceivePlan;
  const evaluateScpGate = deps.evaluateScpInquiryAutoReplyGate ?? evaluateScpInquiryAutoReplyGate;
  const resolveProfile = deps.resolveMailProfile ?? resolveMailProfile;
  const evaluateSafety = deps.evaluateMailSafety ?? evaluateMailSafety;
  const recordSuppression = deps.recordMailSuppression ?? recordMailSuppression;
  const claimLane = deps.claimConversationAutoLane ?? claimConversationAutoLane;
  const releaseLane = deps.releaseConversationAutoLane ?? releaseConversationAutoLane;
  const detectManualReply = deps.detectManualReply ?? detectManualReplySinceInbound;
  const commitRequeue = deps.commitRequeue ?? defaultCommitAutoReplyBacklogRequeue;
  const writeDenyMarker = deps.writeRequeueDenyMarker ?? defaultWriteRequeueDenyMarker;

  // [적대 리뷰 LOW-1, 2026-09-27] Fetch order matters: fetching the fingerprint BEFORE settings
  // (rather than after) means a settings commit landing between the two reads can only make the
  // stamped fingerprint revision STALE relative to what was actually used to judge this sweep —
  // never the reverse. A stale-low stamped revision self-heals (the next sweep's real revision no
  // longer matches, so the marker re-arms); the reverse ordering could stamp a revision NEWER than
  // the policy actually applied, which would then match forever and reopen this exact commit's own
  // bug in miniature.
  const policyFingerprint = await (deps.readRequeuePolicyFingerprint ?? defaultReadRequeuePolicyFingerprint)();
  const settings = await (deps.readSettings ?? readSettings)();
  const disabledOrgByOrgId = await (deps.readByOrgIdForAutoReplyOrgExclusion ?? readByOrgIdForAutoReplyOrgExclusion)();

  // case-backlog-send round 2 (2026-09-28): fetched once per run, only when scoped — feeds both the
  // narrow recentlyDenied re-arm exception (evaluateAutoReplyBacklogSkip's caseArmContext) and, via
  // its mere presence/armed flag, nothing else (arming itself is still re-verified per-candidate by
  // evaluateChatAutoCasePermit inside buildPermitPlan — this is only the "when did it arm" signal).
  const filteredCasePermit = caseIdFilter ? await (deps.readPermit ?? readChatAutoCasePermit)(caseIdFilter) : null;
  const caseArmContext = filteredCasePermit?.armed === true ? { armedAtIso: filteredCasePermit.updatedAtIso } : null;

  const skipped = { takenOver: 0, alreadyReplied: 0, laneLocked: 0, aiInactive: 0, denied: 0, stale: 0, recentlyDenied: 0, orgExcluded: 0, manualReplyDetected: 0, caseMismatch: 0, humanReviewHeld: 0 };
  const denyReasons: Record<string, number> = {};
  const senderIdentityDiagnostics: Record<string, number> = {};
  let requeued = 0;

  // [적대 리뷰, case-backlog-send round 2] restrictToMailAccountId is a query predicate — see
  // defaultQueryCandidates's own doc comment. "scp" is hardcoded (not caller-suppliable) because
  // every casebook case in this backlog is exclusively an scp@ concept; a caseIdFilter-scoped run
  // never has a reason to sweep any other mailbox.
  //
  // [적대 리뷰, case-backlog-send round 5, 2026-09-28] `conversationIds` bypasses this query
  // entirely (see readCandidatesByIds) — that path loses the QUERY's own mailAccountId=="scp"
  // predicate, so the per-row scp-mailbox check just inside the loop below re-asserts it explicitly
  // whenever caseIdFilter is set, closing the same authorization gap for id-list mode.
  const candidates = conversationIds
    ? await readCandidatesByIds(conversationIds)
    : await queryCandidates({ cutoffIso, limit, cursor, restrictToMailAccountId: caseIdFilter ? "scp" : undefined });
  let inboundAccountsPromise: Promise<InboundAutoReplyAccount[]> | null = null;
  const readInboundAccounts = () => {
    inboundAccountsPromise ??= (deps.readMailAccounts ?? readMailAccounts)();
    return inboundAccountsPromise;
  };
  const nowMsFn = deps.nowMs ?? (() => Date.now());
  // [적대 리뷰, case-backlog-send round 2, 2026-09-28] per-row wall-clock budget — sendChatAutoCase
  // HeldBacklogNow threads an absolute `deadlineMs` (epoch-ms) through `deps` so its dry-run and
  // real pass of a page share ONE budget instead of each getting a fresh allowance, and so a single
  // oversized page (up to MAX_LIMIT rows, each a real live-model round trip) stops STARTING new rows
  // well before this callable's own 540s timeout instead of only checking between pages. Seeded with
  // the input `cursor` so a call that hits the deadline before processing even its first candidate
  // still returns a cursor identical to the one it was given (no forward progress silently assumed).
  let lastLookedAtCursor: AutoReplyBacklogCursor | null = cursor;
  let deadlineHit = false;
  let candidatesLookedAt = 0;
  const plannedConversationIds: string[] = [];
  for (const candidate of candidates) {
    if (typeof deps.deadlineMs === "number" && nowMsFn() >= deps.deadlineMs) {
      deadlineHit = true;
      break;
    }
    candidatesLookedAt += 1;
    const conversationId = candidate.id;
    const conversationData = candidate.data;
    // Updated unconditionally, before any skip/deny/requeue branch below, so a deadline hit on the
    // NEXT candidate always resumes right after this one — regardless of which branch this
    // candidate's own processing took.
    lastLookedAtCursor = { lastInboundAtIso: asString(conversationData.lastInboundAtIso, ""), id: conversationId };

    if (!isAutoReplyBacklogCandidateStatus(conversationData.autoReplyStatus)) continue; // defensive — query already filters this

    // [적대 리뷰, case-backlog-send round 6, 2026-09-28] see isBacklogCandidateEligible's own doc
    // comment — redundant (but harmless) for the windowed query path; the ONLY thing enforcing
    // lastMessageFrom=="creator"/the age window for the id-list re-read path.
    if (!isBacklogCandidateEligible(conversationData, cutoffIso)) {
      skipped.denied += 1;
      incrementDenyReasons(denyReasons, ["backlog_candidate_ineligible"]);
      continue;
    }

    // [적대 리뷰, case-backlog-send round 5, 2026-09-28] id-list mode (readCandidatesByIds) has no
    // query predicate to enforce this — re-assert it per row so a caseIdFilter-scoped run can never
    // reach a non-scp mailbox conversation this way either, matching defaultQueryCandidates's own
    // restrictToMailAccountId behavior for the normal windowed path.
    if (caseIdFilter && conversationIds && asString(conversationData.mailAccountId, "") !== "scp") {
      skipped.denied += 1;
      incrementDenyReasons(denyReasons, ["non_scp_mailbox"]);
      continue;
    }

    // COST-P0 cheap prefilter (case-backlog-send round 2, 2026-09-28) — kept permanently DISABLED
    // (round 8, 2026-09-28, briefly enabled this via the autoCaseId/autoCaseMessageRef stamp; round
    // 9, 2026-09-28 codex review reverted it). See trustedStoredPrimaryCaseId's own doc comment above
    // for why: the stamp proves message identity, not that the stored classification still matches
    // the CURRENT casebook/model/release, so trusting it could silently skip a row a fresh judgment
    // would now correctly match. `isStoredClassificationCurrent` stays hardcoded `false` — a row
    // whose stored classification is a DIFFERENT, KNOWN case still proceeds to full reclassification,
    // never skipped for free.
    if (caseIdFilter) {
      const storedPrimaryCaseId = trustedStoredPrimaryCaseId(conversationData, false);
      if (storedPrimaryCaseId && storedPrimaryCaseId !== caseIdFilter) {
        skipped.caseMismatch += 1;
        continue;
      }
    }

    const skipReason = evaluateAutoReplyBacklogSkip(
      conversationData,
      settings.automation.autoReplyDisabledOrgIds,
      disabledOrgByOrgId,
      policyFingerprint,
      caseArmContext,
    );
    if (skipReason) {
      skipped[skipReason] += 1;
      continue;
    }

    // manual-reply defense-in-depth (see manualReplyDetection.ts): the legacy scp@ Sent-mailbox
    // import backlog is mostly unstitched (99.6% never carried mailAccountId, so the stitch
    // retry lane's account-scoped window never re-tried them), so conversation.lastMessageFrom
    // can still read "creator" even though scp already replied by hand via Gmail. Re-check the
    // SAME message_sources ledger the stitcher reads (not the stitched conversation) — this
    // still catches a manual reply even where stitching failed or hasn't run yet. Cheap single
    // read; checked before the lane claim/live model call below like the other skip checks.
    const manualReply = await detectManualReply({
      creatorEmail: asString(conversationData.creatorEmail, ""),
      lastInboundAtIso: asString(conversationData.lastInboundAtIso, ""),
    });
    if (manualReply.detected) {
      skipped.manualReplyDetected += 1;
      continue;
    }

    const sourceDoc = await readLatestInboundSource(conversationData);
    if (!sourceDoc) {
      skipped.denied += 1;
      incrementDenyReasons(denyReasons, ["source_unavailable"]);
      continue;
    }

    // [적대 리뷰 HIGH-1] same-lane reclaim in claimConversationAutoLane always succeeds — it only
    // rejects a DIFFERENT lane's owner. Without this pre-check the claim below would silently
    // steal the lane from an already-scheduled/processing live job. Cheap/no-extra-read: uses the
    // already-fetched candidate snapshot, so it can go stale between the query and here — the
    // transactional re-check in commitRequeue right before the write is the actual race-proof
    // guard; this is a pre-filter that also avoids wasting an LLM call on an obviously-doomed
    // candidate.
    if (isConversationAutoLaneLockedForRequeue(conversationData)) {
      skipped.laneLocked += 1;
      continue;
    }

    // case-backlog-send (2026-09-27): an UNSCOPED dryRun preview keeps its original cheap
    // behavior exactly — it exits here, before the live model call, so a plain "how big is the
    // backlog" preview never pays for reclassification. A caseIdFilter-SCOPED dryRun cannot take
    // this shortcut: knowing whether a candidate matches caseIdFilter requires the same live
    // reclassification a real send would run, so it falls through to the (more expensive, but
    // ≤`limit`-bounded) second dryRun exit below, placed AFTER every gate — including the
    // caseIdFilter match itself — has already run.
    if (dryRun && !caseIdFilter) {
      skipped.denied += 1;
      incrementDenyReasons(denyReasons, ["dry_run_preview"]);
      plannedConversationIds.push(conversationId);
      continue;
    }

    let senderIsCreator = false;
    let senderIdentityOnly = false;
    let senderIdentityDiagnostic: BacklogSenderIdentityDiagnostic = "provenance_missing";
    const sourceProvenance = asRecord(sourceDoc.inboundMailProvenance);
    const hasSourceBoundImapMarker = asString(sourceProvenance.kind, "") === "imap"
      && Boolean(asString(sourceProvenance.accountId, ""))
      && Boolean(asString(sourceProvenance.mailbox, ""))
      && asString(sourceDoc.mailAccountId, "") === asString(sourceProvenance.accountId, "")
      && asString(sourceDoc.accountMailbox, "") === asString(sourceProvenance.mailbox, "");
    if (hasSourceBoundImapMarker) {
      try {
        const accounts = await readInboundAccounts();
        const verdict = diagnoseBacklogSenderIdentity(
          sourceDoc,
          conversationId,
          settings.automation.inboundAutoReplyAllowedMailAccountIds,
          accounts,
          { allowIdentityOnly: identityOnlyAutoReplyEnabled(settings.humanReviewPolicy) },
        );
        senderIsCreator = verdict.ok;
        senderIdentityOnly = verdict.identityOnly === true;
        senderIdentityDiagnostic = verdict.reason;
      } catch (error) {
        senderIdentityDiagnostic = "account_untrusted";
        console.warn("[requeueAutoReplyBacklog] inbound account provenance lookup failed; denying candidate", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!senderIsCreator) {
      skipped.denied += 1;
      incrementDenyReasons(denyReasons, ["sender_not_creator"]);
      // Counts only: WHY sender_not_creator fired (never an address, ref or name).
      senderIdentityDiagnostics[senderIdentityDiagnostic] = (senderIdentityDiagnostics[senderIdentityDiagnostic] ?? 0) + 1;
      continue;
    }

    // F-7 thread-ownership lock — claimed further below, AFTER the live gateway call and the
    // caseIdFilter match check (round 5, 2026-09-28). [적대 리뷰, case-backlog-send round 5,
    // 2026-09-28] claiming HERE (before knowing the live case) would write autoLaneOwner — and
    // later release it — for a row that turns out to belong to a DIFFERENT case than caseIdFilter:
    // a write-then-undo that still violates "zero writes for a non-matching row" during a scoped
    // REAL run (dryRun's claim was already a no-op — round 2 — but a real run's claim genuinely
    // writes), and a failed release could leave that OTHER case's conversation lane stuck locked.
    // `laneJobRef`/`laneReleased` are declared here (not assigned yet) so the `finally` below can
    // safely release whatever claim, if any, ends up actually taken further inside the try.
    let laneJobRef: string | null = null;
    let laneReleased = true;
    const releaseOnce = async () => {
      if (laneReleased || !laneJobRef) return;
      laneReleased = true;
      await releaseLane(conversationId, "auto_reply", laneJobRef);
    };

    try {
      const gatewayInput = buildAutoReplyBacklogGatewayInput({
        conversationId,
        sourceDoc,
        mailAccountId: asString(conversationData.mailAccountId, ""),
        conversationLastMessageRef: asString(conversationData.lastMessageRef, ""),
      });
      const gateway = await runLiveGateway(gatewayInput, "requeueAutoReplyBacklog", {
        bypassGatewayCache: true,
        // 저장 행의 본문은 IMAP 파서가 인용 이력을 잘라 낸 뒤의 것이다 — 파서 표식을 이어 역제안 허용목록이 fail-closed 하게 한다.
        // 3상태: 저장 행의 명시 불리언(true=잘림/false=깨끗) 또는 없음(표식 도입 전 레거시 = unknown → 역제안 보류).
        quotedHistory: sourceDoc.quotedHistoryStripped === true ? "stripped" : sourceDoc.quotedHistoryStripped === false ? "clean" : "unknown",
      });
      if (!gateway) {
        skipped.denied += 1;
        incrementDenyReasons(denyReasons, ["gateway_unavailable"]);
        continue;
      }

      // [적대 리뷰, case-backlog-send round 2, 2026-09-28] caseIdFilter match — checked HERE, before
      // any write below (mail-safety suppression record via recordMailSuppression, deny marker via
      // writeRequeueDenyMarker), using the SAME caseId derivation buildChatAutoPermitReceivePlan
      // uses internally (`isChatAutoCaseId(gateway.caseId)` — chat-ai.ts) so this can never disagree
      // with the "real" plan.decision.caseId computed further down (evaluateChatAutoCasePermit only
      // ever passes that same value through, never reassigns it — see chatAutoCasePermit.ts). A row
      // whose stored classification wasn't reliable enough for the cheap prefilter above (so it
      // reached this live reclassification) but turns out to belong to a DIFFERENT case must never
      // cause a write for that OTHER case during THIS case's scoped send — skip with zero writes,
      // exactly like the cheap-prefilter match above.
      if (caseIdFilter) {
        const liveCaseId = typeof gateway.caseId === "string" && isChatAutoPermitCaseId(gateway.caseId) ? gateway.caseId : null;
        if (liveCaseId !== caseIdFilter) {
          skipped.caseMismatch += 1;
          continue;
        }
      }

      // F-7 thread-ownership lock (round 5, 2026-09-28: moved to here, after the live gateway call
      // and caseIdFilter match above — see this block's own doc comment further up) — claim now
      // that the row is confirmed to be either unscoped or a genuine caseIdFilter match, so a
      // conversation belonging to another case is never written (claimed) at all, not even
      // write-then-release. [적대 리뷰, case-backlog-send round 2, 2026-09-28] a dryRun preview must
      // write NOTHING — claimConversationAutoLane WRITES autoLaneOwner even for a same-lane
      // "re-claim" (see conversationAutoLane.ts's own doc comment), so the claim stays a no-op
      // during dryRun; a real run's claim genuinely writes.
      laneJobRef = `requeue:${conversationId}:${nowIso}`;
      const claim = dryRun ? ({ ok: true } as const) : await claimLane(conversationId, "auto_reply", laneJobRef, nowIso);
      if (!claim.ok) {
        skipped.laneLocked += 1;
        continue;
      }
      laneReleased = dryRun;

      // The verified-source guard above rules out blank and conversation-id fallback identities.
      const creatorId = asString(sourceDoc.creatorId, "");
      const creatorEmail = asString(sourceDoc.creatorEmail, asString(sourceDoc.to, ""));
      const programId = asString(sourceDoc.programId, "");
      const campaignId = asString(sourceDoc.campaignId, "");
      const profileResolution = await resolveProfile({
        campaignId,
        programId,
        gameId: asString(sourceDoc.gameId, ""),
        intent: "auto_reply",
        baseIso: nowIso,
      });

      const queueSafetyInput = {
        ...sourceDoc,
        to: creatorEmail,
        creatorEmail,
        creatorId,
        programId,
        campaignId,
        trackingId: asString(sourceDoc.trackingId, ""),
        messageRef: asString(conversationData.lastMessageRef, ""),
        summaryKr: gateway.summaryKr,
        text: gateway.draftText ?? "",
      };
      const automationSafety = await evaluateSafety(queueSafetyInput, "requeueAutoReplyBacklog", "auto_reply");
      // [적대 리뷰, case-backlog-send round 2, 2026-09-28] recordSuppression WRITES a
      // mail_suppressions doc (plus a Permit adverse-hook call) whenever the safety decision denies
      // — unconditionally, with no dryRun awareness of its own. A caseIdFilter-scoped dryRun now
      // genuinely reaches this line (see the two dryRun-exit comments below), so a real write must
      // not happen during what is supposed to be a read-only preview. `automationSafety` itself
      // (evaluateMailSafety) is pure/read-only — reuse its decision directly during dryRun instead
      // of calling the persisting wrapper.
      const queueSafety = dryRun
        ? automationSafety
        : await recordSuppression(automationSafety, queueSafetyInput, "requeueAutoReplyBacklog", "auto_reply");

      const plan = await buildPermitPlan({
        data: gatewayInput,
        conversationId,
        messageSourceId: asString(conversationData.lastMessageRef, "").replace(/^message_sources\//, "") || conversationId,
        gateway,
        effectiveQueueState: "queued_for_send",
        receivedAtIso: nowIso,
        conversationAiActive: conversationData.aiActive !== false,
        autoReplyEnabled: settings.automation.autoReplyEnabled === true,
        draftOnly: false,
        // [적대 리뷰, case-backlog-send round 2, 2026-09-28] This is NEVER the outer `dryRun`
        // request flag — that field means something else entirely to evaluateChatAutoCasePermit
        // (it denies with reason "dry_run", modeling a SYNTHETIC test message submitted with
        // dryRun:true at ingest time — see chat-ai.ts persistReceivedEmail's
        // `dryRun: data.dryRun === true`). A backlog reclassification always re-examines a REAL,
        // already-received message, never a synthetic one, so this must always be false. Before
        // this fix, passing the outer flag through was harmless dead code ONLY because the old
        // unconditional early dryRun-exit (above) meant this line was never reached with dryRun
        // true; the caseIdFilter-scoped preview now reaches it for real, and the outer flag being
        // wired here would have denied every single candidate with "dry_run" before the
        // caseIdFilter match/late-exit logic ever ran — reporting `planned: 0` unconditionally.
        dryRun: false,
        senderTrusted: true, // caller is super_admin-gated (SEND_ROLES-equivalent trust)
        senderIsCreator,
        mailSafetyAllowed: queueSafety.allowed,
        profileEnabled: profileResolution.resolvedProfileSnapshot.enabled,
        caseAlreadySent: false, // evaluateAutoReplyBacklogSkip already excluded non-empty autoRepliedCaseIds
      });

      const scpGate = await evaluateScpGate({
        subject: asString(sourceDoc.subject, ""),
        body: asString(sourceDoc.body, ""),
        caseId: plan.decision.caseId,
        // [적대 리뷰, case-backlog-send round 5, 2026-09-28] required for the
        // scp_application_received path (evaluateScpInquiryAutoReplyGate resolves the verified
        // application-status facts by conversationId) — omitting it made that path always fail
        // closed with scp_facts_unavailable, in BOTH the unscoped sweep and this new scoped send.
        conversationId,
        creatorId,
        nowIso,
        settings,
      });

      // The deny marker is best-effort bookkeeping — a write failure must not turn a deliberate
      // deny into internal_error (the worst case is one extra model call on the next run).
      // [적대 리뷰, case-backlog-send round 2, 2026-09-28] a dryRun preview must write NOTHING —
      // this deny-marker write is skipped entirely (not just best-effort) when dryRun is true. This
      // only matters for the caseIdFilter-scoped preview (the unscoped dryRun exits long before
      // this code, unchanged); it now correctly reaches every deny branch below for real.
      const stampDenied = async (reasons: readonly string[]) => {
        if (dryRun) return;
        try {
          await writeDenyMarker({ conversationId, reasons, nowIso, policyFingerprint });
        } catch (error) {
          console.warn("[requeueAutoReplyBacklog] deny marker write failed", {
            conversationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      if (!plan.decision.allowed || !scpGate.allowed) {
        const reasons = plan.decision.allowed
          ? [scpGate.denyReason ?? "scp_gate_denied"]
          : plan.decision.denyReasons.length
            ? plan.decision.denyReasons
            : ["case_unclassified"];
        skipped.denied += 1;
        incrementDenyReasons(denyReasons, reasons);
        await stampDenied(reasons);
        continue;
      }

      if (!plan.resolvedDraftText || !plan.resolvedDraftHash) {
        skipped.denied += 1;
        incrementDenyReasons(denyReasons, ["server_render_unavailable"]);
        await stampDenied(["server_render_unavailable"]);
        continue;
      }

      const rawCaseId = plan.decision.caseId;
      if (!isChatAutoPermitCaseId(rawCaseId)) {
        skipped.denied += 1;
        incrementDenyReasons(denyReasons, ["case_unclassified"]);
        await stampDenied(["case_unclassified"]);
        continue;
      }
      const caseId: ChatAutoPermitCaseId = rawCaseId;
      // identity_only (address-verified, program unresolved) may only answer the generic templates: a case that needs
      // program / per-creator facts stays human.
      if (senderIdentityOnly && caseNeedsProgramFacts(caseId, Boolean(scpGate.record), plan.serverDraft?.renderSource === "operator_override")) {
        skipped.denied += 1;
        incrementDenyReasons(denyReasons, ["identity_only_case_needs_program"]);
        await stampDenied(["identity_only_case_needs_program"]);
        continue;
      }

      // [적대 리뷰, case-backlog-send round 2, 2026-09-28] the caseIdFilter match check that used to
      // live here (AFTER evaluateChatAutoCasePermit/mail-safety recording/deny-marker writes) moved
      // to immediately after the live gateway call above — a row reclassified into a DIFFERENT case
      // must never cause a write for that other case (suppression record, deny marker) during THIS
      // case's scoped send. `caseId` here is guaranteed to already equal caseIdFilter whenever
      // caseIdFilter is set (or caseIdFilter is unset) — nothing left to check.

      // Second dryRun exit — unreachable for an unscoped dryRun call (it already exited above,
      // before the live model call). Reachable only for a caseIdFilter-scoped dryRun call that
      // reached this point, meaning: reclassified, every existing gate passed, AND it matches
      // caseIdFilter — i.e. exactly the set that would be requeued for real. Reuses the same
      // "dry_run_preview" denyReasons bucket a plain sweep's preview uses, so callers read
      // `denyReasons.dry_run_preview` as "planned" either way.
      if (dryRun) {
        skipped.denied += 1;
        incrementDenyReasons(denyReasons, ["dry_run_preview"]);
        plannedConversationIds.push(conversationId);
        continue;
      }

      // requeue-provenance fix (2026-09-25): parity with the receive path (chat-ai.ts
      // persistReceivedEmail — trustedImapProvenance/mailAccountId/accountMailbox). Without this,
      // sendAutoReplyJob's mailbox-provenance re-check (recheckTrustedInboundAutoReplyAccount)
      // always reports "not trusted" for a requeued job even when the original inbound message
      // genuinely arrived via a trusted IMAP account — losing that mail profile's
      // humanApprovalRequired bypass eligibility purely because the requeue path never carried
      // the provenance forward. `sourceDoc` already has the persisted `inboundMailProvenance`
      // the original receive wrote (or none, if it was never trusted) — reuse it as-is rather
      // than re-deriving trust here.
      const inboundProvenance = asRecord(sourceDoc.inboundMailProvenance);
      const trustedImapProvenance = asString(inboundProvenance.kind, "") === "imap"
        && Boolean(asString(inboundProvenance.accountId, ""));
      const inboundMailAccountId = asString(inboundProvenance.accountId, "");
      const inboundAccountMailbox = asString(inboundProvenance.mailbox, "");

      const queueRef = adminDb
        .collection("auto_reply_queue")
        .doc(`auto-requeue-${conversationId}-${asString(sourceDoc.trackingId, conversationId)}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 140));
      const expiresAtIso = new Date(now.getTime() + AUTO_REPLY_QUEUE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

      const queueDocBase: Record<string, unknown> = {
        id: queueRef.id,
        status: "scheduled",
        conversationId,
        threadId: asString(conversationData.threadId, conversationId),
        contextKey: asString(conversationData.contextKey, ""),
        conversationRef: `conversations/${conversationId}`,
        // auto-reply-org-controls (2026-09-24): mirrors the same field chat-ai.ts's
        // persistReceivedEmail stamps on enqueue — evaluateAutoReplyBacklogSkip above already
        // excluded this candidate if its org were disabled, but processAutoReplyQueue's
        // defense-in-depth re-check re-reads these fields from the job doc at send time, so a
        // requeued job must carry them too (a policy change after requeue-time must still hold).
        ownerOrgId: asString(conversationData.orgId, "") || FieldValue.delete(),
        ownerMailAccountId: asString(conversationData.mailAccountId, "") || FieldValue.delete(),
        messageRef: asString(conversationData.lastMessageRef, ""),
        sourceRef: asString(conversationData.lastMessageRef, ""),
        sourceRefs: Array.isArray(conversationData.sourceRefs) ? conversationData.sourceRefs : [],
        trackingId: asString(sourceDoc.trackingId, ""),
        creatorId,
        creatorName: asString(sourceDoc.creatorName, ""),
        creatorEmail,
        creatorHandle: asString(sourceDoc.creatorHandle, ""),
        creatorPlatform: asString(sourceDoc.creatorPlatform, ""),
        creatorFollowers: asNumber(sourceDoc.creatorFollowers, 0),
        creatorRecentViews: asNumber(sourceDoc.creatorRecentViews, 0),
        creatorEngagementPct: asNumber(sourceDoc.creatorEngagementPct, 0),
        ...(campaignId ? { campaignId } : {}),
        ...(programId ? { programId } : {}),
        programTitle: asString(sourceDoc.programTitle, ""),
        campaignTitle: asString(sourceDoc.campaignTitle, ""),
        summaryKr: gateway.summaryKr,
        draftRef: gateway.draftRef,
        draftText: plan.resolvedDraftText,
        to: creatorEmail,
        sendAfterIso: profileResolution.sendAfterIso,
        expiresAtIso,
        minimumDelayMinutes: profileResolution.resolvedProfileSnapshot.minReplyDelayMinutes,
        effectiveDelayMinutes: profileResolution.effectiveDelayMinutes,
        deferredToBusinessWindow: profileResolution.deferredToBusinessWindow,
        resolvedProfileSnapshot: profileResolution.resolvedProfileSnapshot,
        templateSnapshot: profileResolution.templateSnapshot,
        policyVersion: profileResolution.policyVersion,
        dryRun: profileResolution.dryRun,
        liveSend: profileResolution.liveSend,
        humanGate: gateway.humanGate,
        caseId,
        permitDecisionId: plan.permitDecisionId,
        casebookHash: asString(plan.metadata.casebookHash, CHAT_CASEBOOK_CONTENT_HASH),
        casebookVersion: CHAT_CASEBOOK_VERSION,
        gatewayModelVersion: gateway.costLog.model,
        gatewayTransport: gateway.costLog.transport,
        draftHash: plan.resolvedDraftHash,
        coreDraftHash: plan.coreDraftHash,
        // [requeue-provenance fix 2026-09-25] parity with the receive path (chat-ai.ts
        // persistReceivedEmail queueDocBase, "draftRenderSource"/"draftFactTokenIds"): without
        // these, sendAutoReplyJob's Permit provenance gate (`job.draftRenderSource !==
        // "casebook_template"`) fails closed on every requeued job — the requeue path was never
        // setting them, so every backlog requeue was DOA (mislabeled as an SMTP temporary
        // failure, and disarming the permit on top of that; see mailSafetyShared.ts /
        // sendAutoReplyJob for the rest of that fix).
        draftRenderSource: plan.decision.draft?.renderSource ?? FieldValue.delete(),
        draftFactTokenIds: plan.decision.draft?.factTokenIds ?? FieldValue.delete(),
        ...(trustedImapProvenance ? { mailAccountId: inboundMailAccountId, accountMailbox: inboundAccountMailbox } : {}),
        inboundMailProvenance: trustedImapProvenance
          ? { kind: "imap", accountId: inboundMailAccountId, mailbox: inboundAccountMailbox }
          : FieldValue.delete(),
        source: "requeueAutoReplyBacklog",
        createdAtIso: nowIso,
        scpInquiry: scpGate.record ?? FieldValue.delete(),
      };
      const conversationPatch: Record<string, unknown> = {
        autoReplyStatus: "scheduled",
        autoReplyQueueRef: queueRef.path,
        autoReplyDraftText: FieldValue.delete(),
        autoReplyBlockedReason: FieldValue.delete(),
        nextAutoReplyAtIso: profileResolution.sendAfterIso,
        autoLaneOwner: { lane: "auto_reply", jobRef: queueRef.path, setAtIso: nowIso },
      };

      // [적대 리뷰 HIGH-1] the authoritative race guard — re-reads the conversation and checks for
      // a live auto_reply_queue job INSIDE the same transaction as the write, so a job that was
      // enqueued by the live inbound path after our initial query (or after our lane pre-check)
      // aborts this write instead of racing it into a second send.
      const commit = await commitRequeue({
        conversationId,
        originalConversationData: conversationData,
        queueRef,
        queueDocBase,
        conversationPatch,
        fallbackCaseIntentRef: plan.caseIntentRef ?? null,
        authorizeConversationAtCommit: deps.authorizeConversationAtCommit,
        caseIntentInput: {
          conversationId,
          messageSourceId: asString(conversationData.lastMessageRef, "").replace(/^message_sources\//, "") || conversationId,
          caseId,
          queueRef,
          decision: plan.decision,
          nowIso,
        },
      });
      if (!commit.committed) {
        // [적대 리뷰, case-backlog-send round 2, 2026-09-28] a human hold that appeared mid-flight
        // (see commitRequeue's own humanReviewStatus re-check) is a distinct, honestly-labeled
        // outcome — never folded into the generic "stale" bucket, which would obscure that a human
        // reviewer, not a data race, is why this candidate wasn't queued.
        if (commit.reason === "human_review_held") {
          skipped.humanReviewHeld += 1;
        } else if (commit.reason === "scope_denied") {
          skipped.denied += 1;
          incrementDenyReasons(denyReasons, ["conversation_access_denied"]);
        } else {
          skipped.stale += 1;
        }
        continue;
      }
      // The lane is now owned by the real queue job (jobRef = queueRef.path), not our
      // provisional claim — release the provisional claim's bookkeeping without clearing the
      // conversation's autoLaneOwner (the transaction above already overwrote it to the queue ref).
      laneReleased = true;
      requeued += 1;
    } catch (error) {
      skipped.denied += 1;
      incrementDenyReasons(denyReasons, ["internal_error"]);
      console.error("[requeueAutoReplyBacklog] candidate failed", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Covers both the success path (laneReleased already true — no-op) and every deny/error
      // `continue`/throw above (laneReleased still false — releases the provisional claim).
      if (!laneReleased) await releaseOnce();
    }
  }

  // A page that came back short of `limit` proves the query exhausted the [cutoffIso, now] window
  // — nothing to resume. A full page may or may not be the last; the caller re-pages with
  // nextCursor and stops once a short page (or scanned:0) comes back. The cursor carries the last
  // candidate's id alongside its lastInboundAtIso (see AutoReplyBacklogCursor) so a resumed page
  // cannot skip sibling conversations sharing that exact timestamp.
  //
  // [적대 리뷰, case-backlog-send round 2, 2026-09-28] `deadlineHit` overrides this: `scanned` then
  // reports only the candidates actually looked at (not the whole fetched page), and `nextCursor`
  // always resumes from `lastLookedAtCursor` — the last candidate this call actually looked at, or
  // the ORIGINAL input cursor unchanged if the deadline hit before looking at any of them.
  const scanned = deadlineHit ? candidatesLookedAt : candidates.length;
  const validCursor = lastLookedAtCursor && lastLookedAtCursor.lastInboundAtIso ? lastLookedAtCursor : null;
  // [적대 리뷰, case-backlog-send round 5, 2026-09-28] id-list mode (conversationIds) has no
  // ordered query window to resume — `limit`/`cursor` are meaningless for it, so nextCursor is
  // always null (the caller drives its own continuation from the PREVIEW call's own nextCursor,
  // never this real/enqueue call's).
  const nextCursor = conversationIds
    ? null
    : deadlineHit
      ? (validCursor ? JSON.stringify(validCursor) : null)
      : (candidates.length >= limit && validCursor ? JSON.stringify(validCursor) : null);
  // [적대 리뷰, case-backlog-send round 2, 2026-09-28] a dryRun preview must write NOTHING — this
  // run-summary audit doc is skipped entirely (not just best-effort) when dryRun is true.
  if (!dryRun) {
    await adminDb.collection(AUTO_REPLY_BACKLOG_AUDIT_COLLECTION).add({
      actorUidHash: actorUidHash(auth.userId),
      actorRole: auth.role,
      params: { maxAgeHours, limit, dryRun, cursor, caseIdFilter },
      counts: { scanned, requeued, skipped, denyReasons, senderIdentityDiagnostics },
      nextCursor,
      // [적대 리뷰 NIT-6, 2026-09-27] Recorded so a later trace ("why did/didn't recentlyDenied fire
      // this run") can read the fingerprint this sweep actually compared against directly off the
      // audit doc instead of having to reconstruct it from settings/default + the deploy artifact —
      // exactly the reconstruction this fix's own investigation had to do by hand.
      policyFingerprint,
      createdAtIso: nowIso,
    });
  }

  return {
    ok: true,
    scanned,
    requeued,
    skipped,
    denyReasons,
    senderIdentityDiagnostics,
    dryRun,
    nextCursor,
    deadlineHit,
    plannedConversationIds,
    behaviorLog: { ...makeBehaviorLog(auth, "auto_reply_backlog.requeue", "success") },
  };
}
