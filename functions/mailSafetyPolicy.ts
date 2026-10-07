import { adminDb } from "./firebaseAdmin";
import { readSettings } from "./settings";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { isHardOptOut } from "./mailHumanGate";
import {
  allowsTransactionalInflyOverlap,
  chatManualReplyInflyExemptionApplies,
  nudgeInflyExemptionApplies,
  findMailSuppression,
  mailSuppressionBlocksSend,
  INFLY_OVERLAP_RULE_ID,
} from "./mailSuppression";
import {
  chatAutoPermitCommittedRefsFromMailData,
  readOutboundSafetyBlock,
  readOutboundSafetyBlockForMail,
  recordChatAutoPermitAdverseFromCommittedRefs,
  type ChatAutoPermitAdverseHookDeps,
  type MailLaneGateDeps,
} from "./mailOutboundSafety";
import { mailIdentityBlockReason, mailIdentityBlocksMode } from "./mailIdentity";
import { resolveOperationalMailIdentity } from "./mailProfiles";
import {
  emailDomain,
  firstKeywordMatch,
  normalizeEmailAddress,
  normalizePolicyToken,
  normalizedList,
  safeMailDocId,
  safeOutboundFailureEvidence,
  type MailSafetyDecision,
  type MailSafetyMode,
} from "./mailSafetyShared";

export const ROLE_ACCOUNT_PREFIXES = new Set(["admin", "billing", "contact", "help", "info", "marketing", "noreply", "press", "sales", "support"]);
const DISPOSABLE_DOMAINS = new Set(["mailinator.com", "10minutemail.com", "tempmail.com", "guerrillamail.com", "yopmail.com"]);
const SUPPRESSION_RULE_IDS = new Set([
  "mail-safety.blocked-email",
  "mail-safety.blocked-domain",
  "mail-safety.complaint-keyword",
  "mail-safety.disposable-domain",
  "mail-safety.role-account",
  "mail-safety.suppressed-contact",
  "mail-safety.suppressed-handle",
  // W76-B: 회신 옵트아웃(unsubscribe/계정삭제 등) 의도 감지 — settings.mailSafety.emergencyKeywords
  // (운영자 편집 가능 목록)와 별개로, 코드에 고정된 isHardOptOut 패턴이 항상 켜져 있다.
  "mail-safety.reply-optout",
]);
const PUBLIC_SUPPRESSION_RULE_IDS = new Set([
  ...SUPPRESSION_RULE_IDS,
  "mail-safety.game-company-blacklist",
  "mail-safety.infly-overlap",
]);
const SUPPRESSED_CONTACT_REASON = "기존 억제 목록과 일치하여 발송을 차단합니다.";

/**
 * W62e-CRIT-A [Codex 델타] — **결정적 차단**과 **일시 잠금**을 가른다.
 *
 * 비소모 종결(suppressed)은 "다시 시도해도 결과가 같다"가 전제다. 그 전제가 맞는 것은
 * **수신자 단위 억제**뿐이다(억제 목록 매칭·역할계정·하드바운스·불만·블랙리스트·infly-overlap).
 *
 * 그런데 blocked 는 그것 말고도 **일시적인 이유**로 참이 된다:
 *   · 긴급 메일 셧다운(mail-safety.emergency-shutdown)
 *   · 아웃바운드 잠금 / 발송 스위치 OFF
 *   · 승인 미비(approvalRef 없음·approval !== approved)
 *   · 휴먼 게이트 blocked
 * 이것들은 **풀린다.** 풀린 뒤에 다시 보내야 하는데 suppressed 로 영구 종결하면 그 메일은
 * 영원히 안 나간다 — 셧다운 한 번에 그 창의 모든 메일이 죽는다.
 *
 * 그래서 종결은 이 집합에 한정하고, 나머지 blocked 는 **재시도 가능**으로 남긴다.
 */
const DETERMINISTIC_BLOCK_RULE_IDS = new Set([
  ...PUBLIC_SUPPRESSION_RULE_IDS,
  // 프로드 mail_suppressions 실측에 존재하는 규칙들 — 위 정책 상수 집합에는 없지만 억제 문서로
  // 저장되고 발송을 막는다. 빠뜨리면 "결정적인데 재시도"가 되어 6회를 태운 뒤 dead_letter 가 된다.
  "mail-safety.hard-bounce",
  "mail-safety.no-mx",
]);

/**
 * ⚠️ 기본값은 **일시(재시도 가능)** 다. 모르는 사유를 결정적으로 보면 그 메일은 영원히 안 나가고,
 * 그건 되돌릴 수 없다. 반대로 결정적인 것을 재시도로 보면 6회를 태우고 dead_letter 로 끝난다 —
 * 낭비지만 유계이고 사유도 정직하게 남는다. 비대칭이 이 방향을 정한다.
 */
export function isDeterministicMailBlockRule(ruleId: unknown): boolean {
  return typeof ruleId === "string" && DETERMINISTIC_BLOCK_RULE_IDS.has(ruleId);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function policyList(value: unknown, fallback: readonly string[]): string[] {
  const fromValue = stringArray(value);
  return fromValue.length > 0 ? normalizedList(fromValue) : normalizedList(fallback);
}

export function rolePrefix(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at).split(/[.+_-]/)[0] ?? "" : "";
}

function profilePolicyLists(mailSafety: Record<string, unknown>): {
  readonly disposableDomains: string[];
  readonly roleAccountPrefixes: string[];
  readonly blockedDomains: string[];
} {
  return {
    disposableDomains: policyList(mailSafety.disposableDomains, [...DISPOSABLE_DOMAINS]),
    roleAccountPrefixes: policyList(mailSafety.roleAccountPrefixes, [...ROLE_ACCOUNT_PREFIXES]),
    blockedDomains: policyList(mailSafety.blockedDomains, []),
  };
}

function blockedDecision(reason: string, ruleId: string): MailSafetyDecision {
  return { allowed: false, severity: "blocked", reason, ruleId, humanRequired: true };
}

// W76-①(코덱스 리뷰 HIGH) [실사고 위험]: evaluateMailSafety의 targetEmail(판정 대상)과
// recordMailSuppression의 email(저장 대상)이 각자 독립적으로 to/from 우선순위를 계산해서
// 서로 달랐다 — receive 모드에서 판정은 from(발신자=크리에이터) 우선인데 저장은 to 우선이었다.
// 인바운드 회신의 data.to는 SMTP "To:" 헤더, 즉 **우리 수신함**(scp@supercent.io)이라
// 크리에이터 대신 우리 자신을 억제 목록에 올리는 사고로 이어졌다. 판정·저장이 반드시 같은
// 함수를 거치게 해 이 종류의 드리프트가 다시 생기지 않게 한다.
function resolveMailSafetyTargetEmail(data: Record<string, unknown>, mode: MailSafetyMode): string {
  const to = normalizeEmailAddress(asString(data.to, asString(data.creatorEmail, "")));
  const from = normalizeEmailAddress(asString(data.from, ""));
  return mode === "receive" ? (from || to) : (to || from);
}

/**
 * 게이트 주입점. 프로덕션은 전부 기본값(Firestore)을 쓴다. 노드 레인에서 "이 게이트가 정말
 * payload 의 **레인**을 보고 정지를 판정하는가"를 값으로 확인하려면 이 세 조회기를 대신 넣는다 —
 * 레인 축의 결정은 잠금 조회 하나지만, 그 앞의 신원·설정 조회가 Firestore 라 함께 열어야 도달한다.
 */
export type MailSafetyGateDeps = MailLaneGateDeps & {
  readonly resolveOperationalMailIdentity?: typeof resolveOperationalMailIdentity;
  readonly readSettings?: typeof readSettings;
  readonly findMailSuppression?: typeof findMailSuppression;
};

export async function evaluateMailSafety(
  data: Record<string, unknown>,
  source: string,
  mode: MailSafetyMode,
  deps: MailSafetyGateDeps = {},
): Promise<MailSafetyDecision> {
  const identity = await (deps.resolveOperationalMailIdentity ?? resolveOperationalMailIdentity)();
  // Canonical mailbox identity is required only when outbound evaluation can contact the provider.
  // Actual sends remain fail-closed; receive and explicit dry-run/non-live probes do not contact it.
  const contactsProvider = mode !== "receive" && data.dryRun !== true && data.liveSend !== false;
  if (contactsProvider && mailIdentityBlocksMode(identity, mode)) {
    return blockedDecision(mailIdentityBlockReason(identity), identity.identityCode);
  }
  const settings = await (deps.readSettings ?? readSettings)();
  const mailSafety = settings.mailSafety as Record<string, unknown>;
  const targetEmail = resolveMailSafetyTargetEmail(data, mode);
  const domain = emailDomain(targetEmail);
  const handle = normalizePolicyToken(asString(data.creatorHandle, asString(data.handle, "")));
  const blockedEmails = new Set(normalizedList(settings.mailSafety.blockedEmails));
  const lists = profilePolicyLists(mailSafety);
  const blockedDomains = new Set(lists.blockedDomains);
  const suppressedHandles = new Set(normalizedList(settings.mailSafety.suppressedHandles));
  const textCorpus = [data.signal, data.subject, data.body, data.text, data.summaryKr, data.creatorName, data.creatorEmail, data.from, data.to]
    .map((value) => typeof value === "string" ? value : "")
    .join(" ");
  const matchedKeyword = firstKeywordMatch(textCorpus, settings.mailSafety.emergencyKeywords);

  // After the canonical identity prerequisite, emergency shutdown is the
  // highest-priority outbound policy decision. It deliberately does not stop
  // inbound collection.
  if (mode !== "receive" && settings.mailSafety.emergencyShutdownEnabled) {
    return { allowed: false, severity: "emergency", reason: "긴급 메일 셧다운이 켜져 있어 모든 자동·수동 발송을 차단합니다.", ruleId: "mail-safety.emergency-shutdown", humanRequired: true };
  }
  if (mode !== "receive") {
    // W118: 수동 정지는 레인별이다 — 이 메일의 레인 기준으로 판정한다(거래성은 하드락만 받는다).
    const block = await readOutboundSafetyBlockForMail(
      data,
      new Date().toISOString(),
      mode,
      deps.readOutboundSafetyBlock ?? readOutboundSafetyBlock,
    );
    if (block.blocked) return blockedDecision(block.reason ?? "메일 발송 안전 잠금이 활성화되어 있습니다.", block.ruleId ?? "mail-safety.outbound-lock");
  }
  if (targetEmail && blockedEmails.has(targetEmail)) return blockedDecision("블랙리스트 이메일과 일치하여 발송을 차단합니다.", "mail-safety.blocked-email");
  if (domain && blockedDomains.has(domain)) return blockedDecision("블랙리스트 도메인과 일치하여 발송을 차단합니다.", "mail-safety.blocked-domain");
  if (mode !== "receive" && domain && lists.disposableDomains.includes(domain)) return blockedDecision("일회용 메일 도메인으로 판단되어 발송을 차단합니다.", "mail-safety.disposable-domain");

  const suppression = await (deps.findMailSuppression ?? findMailSuppression)({
    email: targetEmail,
    handle,
    name: asString(data.creatorName, asString(data.name, "")),
    category: asString(data.creatorCategory, asString(data.category, "")),
    platform: asString(data.creatorPlatform, asString(data.platform, "")),
    text: [data.creatorName, data.creatorHandle, data.creatorCategory, data.creatorPlatform, data.creatorEmail, data.to, data.from]
      .map((value) => typeof value === "string" ? value : "").join(" "),
  });
  // Infly overlap is an outbound-contact guard, not an inbound-content guard.
  // Creator replies from an already-known Infly contact must still be summarized and
  // receive a draft_only reply suggestion. Every actual outbound path re-runs this
  // policy with auto_reply/manual_send and therefore continues to block the send.
  const chatManualReplyExempt = chatManualReplyInflyExemptionApplies({
    ruleId: suppression.ruleId ?? "",
    hasNonExemptibleRule: suppression.hasNonExemptibleRule === true,
    mode,
    data,
  });
  if (mailSuppressionBlocksSend(suppression, {
    // W62d-D: 거래성 메일(본인이 요청해서 발생한 확인·재촉)은 infly-overlap 을 비켜 간다.
    //   purpose 로 **서버가** 판단한다 — 호출자 플래그만 믿으면 아웃리치가 우회할 수 있다.
    //   W72-C [헤세 결정 2026-08-13]: 독려 코호트①③ 도 같은 축의 예외다.
    //   이 규칙은 "이미 Infly DB 에 있으니 **첫 콜드 접촉**을 하지 마라"는 뜻인데,
    //   독려 대상은 정의상 **이미 콜드메일을 받은 사람**이라 그 취지의 대상이 아니다.
    //   (리더 실측: 규칙 등재 이후에도 콜드 발송의 89%가 이 목록과 겹쳐 나갔다.)
    //   여기서도 purpose+templateKind 를 **서버가** 대조한다 — 호출자 플래그로는 못 연다.
    //   W117 [헤세 장애 보고 2026-09-03]: Chat 화면 운영자 수동 답장도 같은 축의 예외다 —
    //   크리에이터가 먼저 회신한 채널에 답장하는 것은 콜드 접촉이 아니다. chat-ai.ts가 실제
    //   inbound 메일과 대조 검증했을 때만(manualInboundReplyVerified) 열린다.
    allowInflyOverlap: mode === "receive"
      || data.allowInflyOverlap === true
      || allowsTransactionalInflyOverlap(data)
      || nudgeInflyExemptionApplies({
        ruleId: suppression.ruleId ?? "",
        hasNonExemptibleRule: suppression.hasNonExemptibleRule === true,
        data,
      })
      || chatManualReplyExempt,
  })) {
    const suppressionRuleId = PUBLIC_SUPPRESSION_RULE_IDS.has(suppression.ruleId ?? "")
      ? suppression.ruleId as string
      : "mail-safety.suppressed-contact";
    return blockedDecision(SUPPRESSED_CONTACT_REASON, suppressionRuleId);
  }
  // W117: infly-overlap 을 운영자 수동 답장 예외로 통과시킨 경우, 발송 자체는 막지 않되
  // "이 수신자는 Infly 중복(콜드메일 방지) 대상이었다"는 사실을 응답에 남겨 Chat 화면이
  // 경고 배지를 띄울 수 있게 한다. 최종 allowed 판정에서만 붙인다 — 아래 다른 규칙에 또
  // 걸리면 그 blockedDecision 이 우선이라 이 값은 쓰이지 않는다.
  const suppressionWarning = suppression.blocked && chatManualReplyExempt
    ? {
        ruleId: suppression.ruleId ?? INFLY_OVERLAP_RULE_ID,
        reason: suppression.reason ?? SUPPRESSED_CONTACT_REASON,
        ...(suppression.ref ? { suppressionRef: suppression.ref } : {}),
      }
    : undefined;
  if (mode !== "receive" && targetEmail && lists.roleAccountPrefixes.includes(rolePrefix(targetEmail))) return blockedDecision("역할 계정 주소로 판단되어 콜드메일 발송을 차단합니다.", "mail-safety.role-account");
  if (handle && suppressedHandles.has(handle)) return blockedDecision("블랙리스트 핸들과 일치하여 발송을 차단합니다.", "mail-safety.suppressed-handle");
  // W76-B [실사고 2026-08-13, Mickael Moy]: 회신 본문의 옵트아웃/계정삭제 의도는 운영자가 편집하는
  // emergencyKeywords 목록의 존재 여부와 무관하게 항상 감지되어야 한다 — 코드 고정 휴리스틱이라
  // Firestore 설정이 비어 있거나 이 문구를 놓쳐도 뚫리지 않는다. 오탐 방향(의심되면 suppress)으로
  // 단락하고, 자동 해제는 없다(사람 검수만 재개 가능).
  if (mode === "receive" && isHardOptOut(textCorpus)) {
    return blockedDecision("회신에서 수신거부·계정 삭제 요청이 감지되어 이후 자동 발송을 차단합니다.", "mail-safety.reply-optout");
  }
  if (matchedKeyword) {
    return { allowed: false, severity: "emergency", reason: "수신거부·법적 조치 신호가 감지되어 자동회신을 중단합니다.", ruleId: "mail-safety.complaint-keyword", matchedKeyword, humanRequired: settings.mailSafety.requireHumanAfterComplaint };
  }
  if (mode !== "manual_send" && !settings.automation.aiAutomationEnabled) return blockedDecision("AI 자동화 마스터가 꺼져 있어 자동 발송을 중단합니다.", "automation.ai-disabled");
  if (mode === "auto_reply" && !settings.automation.autoReplyEnabled) return blockedDecision("채팅 자동응답 발송이 꺼져 있어 자동 발송을 중단합니다.", "automation.auto-reply-disabled");
  if (asString(data.programId, "") && !settings.programAi.enabled && mode !== "manual_send") return blockedDecision("프로그램 AI 운영이 꺼져 있어 프로그램 자동 발송을 중단합니다.", "program-ai.disabled");
  return {
    allowed: true,
    severity: "ok",
    reason: "메일 안전 정책 통과",
    ruleId: `mail-safety.${source}.ok`,
    humanRequired: false,
    ...(suppressionWarning ? { suppressionWarning } : {}),
  };
}

export function chatAutoPermitAdverseReasonForMailSuppression(ruleId: string): "complaint" | "suppression" {
  return ruleId === "mail-safety.complaint-keyword" ? "complaint" : "suppression";
}

export async function recordMailSuppression(
  decision: MailSafetyDecision,
  data: Record<string, unknown>,
  source: string,
  mode: MailSafetyMode = "manual_send",
  permitAdverseDeps: ChatAutoPermitAdverseHookDeps = {},
): Promise<MailSafetyDecision> {
  if (decision.allowed) return decision;
  // W117 [헤세 장애 보고 2026-09-03]: mail-safety.infly-overlap 은 evaluateMailSafety 안에서
  //   findMailSuppression 이 **기존 mail_suppressions 문서**(대개 infly-db-import 배치가 쓴 문서)를
  //   찾았을 때만 나오는 ruleId다 — mail-safety.game-company-blacklist 처럼 그 자리에서 계산하는
  //   휴리스틱이 아니다. 즉 이 규칙으로 차단될 때는 **이미 그 사유를 설명하는 문서가 존재한다**.
  //   그런데 예전 코드는 여기서 매번 suppress_policy_* 문서를 또 써서, 같은 수신자에게 같은 사유의
  //   억제 문서가 중복 누적됐다(실사고: 오늘 수동 답장이 막히면서 이 경로가 중복 문서를 만들었다 —
  //   suppress_email_...(infly-db-import, 2026-06-29) 옆에 suppress_policy_...(sendEmail, 오늘)가
  //   또 생겼다). infly-overlap 은 여기서 기록하지 않는다 — 원본 문서가 이미 정본이다.
  const eligibleSuppressionRule = SUPPRESSION_RULE_IDS.has(decision.ruleId)
    || decision.ruleId === "mail-safety.game-company-blacklist";
  if (!eligibleSuppressionRule) return decision;
  // W76-①: 반드시 evaluateMailSafety와 같은 우선순위 함수를 거친다(위 주석).
  const email = resolveMailSafetyTargetEmail(data, mode);
  const domain = emailDomain(email);
  const handle = normalizePolicyToken(asString(data.creatorHandle, asString(data.handle, "")));
  const id = safeMailDocId("suppress_policy", `${email || handle || asString(data.trackingId, Date.now().toString())}:${decision.ruleId}`);
  const ref = adminDb.collection("mail_suppressions").doc(id);
  // W76-B: 회신 옵트아웃은 provenance를 "reply-optout"으로 고정한다 — 호출부의 일반 source
  // 문자열("receiveEmail" 등)로는 나중에 이 엔트리가 왜 생겼는지(사람이 직접 요청) 구분이 안 된다.
  const suppressionSource = decision.ruleId === "mail-safety.reply-optout" ? "reply-optout" : source;
  await ref.set({
    id,
    email,
    domain,
    handle,
    conversationId: asString(data.conversationId, ""),
    creatorId: asString(data.creatorId, asString(data.candidateId, "")),
    // W76-B: 근거 원문 대신 서버측 참조(messageRef)만 남긴다(SEC-P0-009 — 원문 프롬프트/응답 비노출).
    messageRef: asString(data.messageRef, ""),
    source: suppressionSource,
    status: "active",
    reason: decision.reason,
    ruleId: decision.ruleId,
    matchedKeyword: decision.matchedKeyword ?? null,
    humanRequired: decision.humanRequired,
    severity: decision.severity,
    createdAtIso: new Date().toISOString(),
  }, { merge: true });
  const nowIso = new Date().toISOString();
  // W-? [적대 리뷰 HIGH-2]: 위 억제 문서(ref)는 이미 커밋됐다 — 이 뒤의 Permit adverse 훅이
  //   충돌이 아닌 이유로 던지더라도 억제 기록 자체는 완결돼야 한다. 던지게 두면 호출자가
  //   suppressionRef 도 못 받고 재시도 루프에 들어가 같은 억제 문서를 반복 upsert 하거나,
  //   상위 발송 경로가 "억제 판정이 실패했다"고 오판할 수 있다.
  try {
    await recordChatAutoPermitAdverseFromCommittedRefs({
      reason: chatAutoPermitAdverseReasonForMailSuppression(decision.ruleId),
      sourceRef: ref.path,
      committedRefs: chatAutoPermitCommittedRefsFromMailData(data),
      nowIso,
    }, permitAdverseDeps);
  } catch (error) {
    // P1-1 [적대 리뷰]: 여기서 삼키는 에러도 disarm을 잃지 않는다 — 개별 caseId append가 실패하면
    // recordChatAutoPermitAdverseFromCommittedRefs(mailOutboundSafety.ts)가 이미 scp_canary_alerts에
    // 재시도 가능한 흔적(permit_adverse_retry)을 durable하게 남긴 뒤에 던진다. 그 재시도 흔적은
    // 기존 5분 하트비트 스케줄(monitorOutboundOutputHeartbeatSchedule)의 drainChatAutoPermitAdverseRetryAlerts
    // 단계가 다음 pass에서 다시 적용한다. 여기서는 로그만 남기고 억제 기록 완결을 우선한다.
    console.error("[chat-auto-permit-adverse] suppression hook failed", {
      suppressionRef: ref.path,
      ruleId: decision.ruleId,
      reason: chatAutoPermitAdverseReasonForMailSuppression(decision.ruleId),
      failureKind: safeOutboundFailureEvidence(error, "chat_auto_permit_adverse_suppression").failureKind,
    });
  }
  return { ...decision, suppressionRef: ref.path };
}

/**
 * W76-② — **회신 옵트아웃 억제 해제(admin+).**
 *
 * 옵트아웃 탐지는 사람 문장을 기계가 읽는 일이라 오탐이 0 이 될 수 없다. 오탐이 나면
 * 그 크리에이터는 **영구히 우리 메일을 못 받는다** — 되돌릴 경로가 없으면 탐지를 느슨하게
 * 하고 싶어지고, 그건 진짜 옵트아웃을 놓치는 반대 사고로 간다. 그래서 되돌릴 문을 둔다.
 *
 * 안전 설계:
 *  · admin 이상만. manager/viewer 는 못 연다(억제 해제는 발송을 **늘리는** 방향이다).
 *  · `reason` 필수 — 왜 오탐인지 남기지 않으면 해제하지 않는다.
 *  · 문서를 지우지 않는다. `status:"released"` 로 표시하고 해제 이력을 함께 남긴다
 *    (지우면 "왜 이 사람에게 다시 나갔는가"를 사후에 설명할 수 없다).
 *  · **회신 옵트아웃 계열만** 해제 대상이다. 바운스·블랙리스트는 여기서 못 연다(축이 다르다).
 */
const RELEASABLE_SUPPRESSION_RULE_IDS: ReadonlySet<string> = new Set([
  "mail-safety.reply-optout",
  "mail-safety.complaint-keyword",
]);

export async function releaseMailSuppression(request: CallableRequestShape) {
  const ctx = assertNonGuestAuth(request, "releaseMailSuppression", ["super_admin", "admin"]);
  const data = asRecord(request.data);
  const suppressionId = asString(data.suppressionId, "").trim();
  const reason = asString(data.reason, "").trim();
  if (!suppressionId) {
    throw Object.assign(new Error("invalid-argument: suppressionId is required"), {
      code: "invalid-argument", errorCode: "release_mail_suppression_missing_id",
    });
  }
  if (reason.length < 5) {
    throw Object.assign(new Error("invalid-argument: reason is required (>=5 chars)"), {
      code: "invalid-argument", errorCode: "release_mail_suppression_missing_reason",
    });
  }

  const ref = adminDb.collection("mail_suppressions").doc(suppressionId);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw Object.assign(new Error("not-found: suppression not found"), {
      code: "not-found", errorCode: "release_mail_suppression_not_found",
    });
  }
  const current = snapshot.data() ?? {};
  const ruleId = asString(current.ruleId, "");
  if (!RELEASABLE_SUPPRESSION_RULE_IDS.has(ruleId)) {
    // 바운스·블랙리스트를 여기서 열면 도달 불가 주소로 계속 쏘게 된다.
    throw Object.assign(new Error(`failed-precondition: rule ${ruleId} is not releasable here`), {
      code: "failed-precondition", errorCode: "release_mail_suppression_rule_not_releasable",
    });
  }
  if (asString(current.status, "") !== "active") {
    throw Object.assign(new Error("failed-precondition: suppression is not active"), {
      code: "failed-precondition", errorCode: "release_mail_suppression_not_active",
    });
  }

  const nowIso = new Date().toISOString();
  await ref.set({
    status: "released",
    releasedAtIso: nowIso,
    releasedBy: ctx.userId,
    releasedByRole: ctx.role,
    releaseReason: reason,
  }, { merge: true });

  return {
    ok: true,
    suppressionId,
    previousStatus: "active",
    status: "released",
    behaviorLog: makeBehaviorLog(ctx, "releaseMailSuppression", "success", ctx.gameId),
  };
}
