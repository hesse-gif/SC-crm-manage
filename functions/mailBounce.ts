import { adminDb } from "./firebaseAdmin";
import { syncCampaignFunnelForCampaign } from "./campaigns";
import { mailSuppressionDocId } from "./mailSuppression";
import { asString } from "./shared";
import {
  emailDomain,
  normalizeEmailAddress,
  safeMailDocId,
} from "./mailSafetyShared";
import { lockOutboundMail, readOutboundPolicy } from "./mailOutboundSafety";

const BOUNCE_LOCK_MS = 24 * 60 * 60 * 1000;
const BOUNCE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type BounceClassification = "hard_bounce" | "deferred" | "not_bounce";

export type ParsedDeliveryStatusNotification = {
  readonly isBounce: boolean;
  readonly classification: BounceClassification;
  readonly finalRecipient?: string;
  readonly originalRecipient?: string;
  readonly action?: string;
  readonly status?: string;
  readonly diagnosticCode?: string;
  readonly originalMessageId?: string;
};

export type BounceRecordResult = {
  readonly bounced: boolean;
  readonly classification: BounceClassification;
  readonly sourceRef?: string;
  readonly suppressionCreated?: boolean;
};

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, "");
}

function unfoldDsnLines(value: string): string[] {
  const lines: string[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    if (/^\s/.test(rawLine) && lines.length > 0) {
      lines[lines.length - 1] = `${lines[lines.length - 1]} ${rawLine.trim()}`;
    } else {
      lines.push(rawLine.trim());
    }
  }
  return lines.filter(Boolean);
}

function fieldValue(lines: readonly string[], name: string): string {
  const prefix = `${name.toLowerCase()}:`;
  const line = lines.find((item) => item.toLowerCase().startsWith(prefix));
  if (!line) return "";
  return line.slice(prefix.length).trim();
}

function fieldValues(lines: readonly string[], name: string): string[] {
  const prefix = `${name.toLowerCase()}:`;
  return lines
    .filter((item) => item.toLowerCase().startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
    .filter(Boolean);
}

function recipientValue(value: string): string {
  const candidate = value.includes(";") ? value.split(";").pop() ?? value : value;
  return normalizeEmailAddress(candidate.replace(/[<>]/g, ""));
}

function firstEmail(value: string): string {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? normalizeEmailAddress(match[0]) : "";
}

function bodyValue(input: Record<string, unknown>): string {
  return [
    asString(input.body, ""),
    asString(input.text, ""),
    asString(input.raw, ""),
    asString(input.source, ""),
    asString(input.rfc822, ""),
  ].filter(Boolean).join("\n");
}

const SMTP_STATUS_TOKEN = String.raw`(?:[45]\.\d+\.\d+|421|450|451|452|550)`;
const DIRECT_SMTP_STATUS_LINE = new RegExp(
  String.raw`^(?:(?:smtp|lmtp)(?:\s+(?:error|reply|response))?\s*[;:]\s*)?${SMTP_STATUS_TOKEN}\b`,
  "i",
);
const CONTEXTUAL_SMTP_STATUS_LINE = new RegExp(
  String.raw`^(?:remote\s+host|host|server)\b.{0,240}\b(?:said|replied|response)\s*:\s*${SMTP_STATUS_TOKEN}\b`,
  "i",
);

function inferredSmtpDiagnosticLine(lines: readonly string[]): string {
  return lines.find((line) =>
    DIRECT_SMTP_STATUS_LINE.test(line) || CONTEXTUAL_SMTP_STATUS_LINE.test(line)
  ) ?? "";
}

function inferredStatusFromDiagnostic(diagnosticCode: string): string {
  if (/\b5\.\d+\.\d+\b|\b550\b/.test(diagnosticCode)) return "5.0.0";
  if (/\b4\.\d+\.\d+\b|\b4(?:21|50|51|52)\b/.test(diagnosticCode)) return "4.0.0";
  return "";
}

function classifyDsn(action: string, status: string, diagnosticCode: string): BounceClassification {
  const text = `${action} ${status} ${diagnosticCode}`.toLowerCase();
  if (/^(failed|failure)$/.test(action) || /^5\./.test(status) || /5\.1\.1|user unknown|no such user|address not found|mailbox unavailable|does not exist/.test(text)) {
    return "hard_bounce";
  }
  if (/^(delayed|deferred)$/.test(action) || /^4\./.test(status) || /rate limit|temporarily deferred|try again later|421|450|451|452/.test(text)) {
    return "deferred";
  }
  return "not_bounce";
}

// Known automated bounce/daemon senders (provider-side), incl. Naver, that
// emit non-RFC3464 (often Korean) failure notices.
const BOUNCE_SENDER_PATTERN = /(?:^|[<\s])(?:navermail_noreply@navercorp\.com|mailer-daemon@|postmaster@)/i;

function isKnownBounceSender(from: string): boolean {
  return Boolean(from) && BOUNCE_SENDER_PATTERN.test(from.toLowerCase());
}

// Korean failure-notice phrases. Hard = recipient does not exist / refused;
// soft = mailbox full / over quota / temporary.
const KOREAN_HARD_BOUNCE = /사용자를 찾을 수 없|존재하지 않는 주소|수신 거부|받는 사람이 없|주소를 찾을 수 없/;
const KOREAN_SOFT_BOUNCE = /메일함 용량|용량 초과|수신함이 가득|전송 실패|메일을 보낼 수 없|일시적/;
const KOREAN_BOUNCE_LIKE = new RegExp(`${KOREAN_HARD_BOUNCE.source}|${KOREAN_SOFT_BOUNCE.source}`);

function classifyKoreanBounce(text: string): BounceClassification {
  if (KOREAN_HARD_BOUNCE.test(text)) return "hard_bounce";
  if (KOREAN_SOFT_BOUNCE.test(text)) return "deferred";
  return "not_bounce";
}

export function parseDeliveryStatusNotification(input: Record<string, unknown>): ParsedDeliveryStatusNotification {
  const subject = asString(input.subject, "");
  const body = bodyValue(input);
  const from = asString(input.from, "") || firstEmail(asString(input.fromAddress, "") || asString(input.sender, ""));
  const knownBounceSender = isKnownBounceSender(from) || isKnownBounceSender(body);
  const lines = unfoldDsnLines(body);
  const finalRecipient = recipientValue(fieldValue(lines, "Final-Recipient") || fieldValue(lines, "X-Failed-Recipients")) ||
    firstEmail(asString(input.finalRecipient, "")) ||
    firstEmail(body.match(/Delivery to the following recipient failed permanently:\s*([\s\S]{0,240})/i)?.[1] ?? "") ||
    firstEmail(body.match(/The email account that you tried to reach does not exist\.\s*([\s\S]{0,240})/i)?.[1] ?? "") ||
    // Korean bounce notices quote the failed recipient near "받는 사람"/"수신자".
    firstEmail(body.match(/(?:받는\s*사람|받는사람|수신자|받으실\s*분)[^\n\r]{0,160}/)?.[0] ?? "");
  const originalRecipient = recipientValue(fieldValue(lines, "Original-Recipient"));
  const bounceLikeSubjectEn = /delivery status notification|undelivered|returned mail|mail delivery failed|failure notice|delivery incomplete/i.test(subject);
  const bounceLikeBodyEn = /delivery to the following recipient failed|address not found|user unknown|mailbox unavailable|temporarily deferred|rate limit/i.test(body);
  const bounceLikeSubject = bounceLikeSubjectEn || /전송 실패|메일.*반송|배달.*실패|반송된 메일/.test(subject);
  const bounceLikeBody = bounceLikeBodyEn || KOREAN_BOUNCE_LIKE.test(body) || KOREAN_BOUNCE_LIKE.test(subject);
  const hasBounceContext = knownBounceSender || bounceLikeSubject || bounceLikeBody || Boolean(finalRecipient || originalRecipient);
  // Only synthesize an English "failed" action from English bounce-like text.
  // Korean notices have no soft/hard signal in "failed", so they must be
  // classified by the Korean dictionary (below), not this synthesized action.
  const action = (fieldValue(lines, "Action") || (bounceLikeSubjectEn && bounceLikeBodyEn ? "failed" : "")).toLowerCase();
  const diagnosticCode = fieldValue(lines, "Diagnostic-Code") ||
    (hasBounceContext
      ? inferredSmtpDiagnosticLine(lines)
      : "");
  const status = fieldValue(lines, "Status") || inferredStatusFromDiagnostic(diagnosticCode);
  const messageIds = fieldValues(lines, "Message-ID").map(normalizeMessageId).filter(Boolean);
  const originalMessageId = normalizeMessageId(
    fieldValue(lines, "Original-Message-ID") ||
    fieldValue(lines, "Original-Message-Id") ||
    messageIds[messageIds.length - 1] ||
    "",
  );
  const koreanText = `${subject}\n${body}`;
  const englishClassification = classifyDsn(action, status, diagnosticCode);
  // English RFC3464 takes precedence; only when it yields nothing do we fall
  // back to Korean / known-bounce-sender detection (Naver and friends).
  let classification = englishClassification;
  if (classification === "not_bounce" && (knownBounceSender || bounceLikeBody)) {
    const korean = classifyKoreanBounce(koreanText);
    // A known daemon sender that we still can't read defaults to a soft
    // bounce (deferred) — never create a permanent suppression on a guess.
    classification = korean !== "not_bounce" ? korean : knownBounceSender ? "deferred" : "not_bounce";
  }
  const isBounce = classification !== "not_bounce" ||
    Boolean(finalRecipient && (action || status || diagnosticCode)) ||
    Boolean(originalMessageId && bounceLikeSubject);
  return {
    isBounce,
    classification,
    ...(finalRecipient ? { finalRecipient } : {}),
    ...(originalRecipient ? { originalRecipient } : {}),
    ...(action ? { action } : {}),
    ...(status ? { status } : {}),
    ...(diagnosticCode ? { diagnosticCode } : {}),
    ...(originalMessageId ? { originalMessageId } : {}),
  };
}

async function findOutboundSource(parsed: ParsedDeliveryStatusNotification): Promise<{ readonly path: string; readonly data: Record<string, unknown> } | null> {
  const messageId = parsed.originalMessageId ?? "";
  if (messageId) {
    for (const [field, value] of [
      ["providerMessageIdNormalized", messageId],
      ["providerMessageId", messageId],
      ["providerMessageId", `<${messageId}>`],
    ] as const) {
      const snapshot = await adminDb.collection("message_sources").where(field, "==", value).limit(5).get();
      const match = snapshot.docs.find((doc) => asString(doc.data().direction, "") === "outbound");
      if (match) return { path: match.ref.path, data: match.data() ?? {} };
    }
  }
  const recipient = parsed.finalRecipient ?? parsed.originalRecipient ?? "";
  if (!recipient) return null;
  const snapshot = await adminDb.collection("message_sources").where("toNormalized", "==", recipient).limit(20).get();
  const picked = snapshot.docs
    .map((doc) => ({ path: doc.ref.path, data: doc.data() ?? {} }))
    .filter((doc) => asString(doc.data.direction, "") === "outbound")
    .sort((left, right) => asString(right.data.createdAtIso, "").localeCompare(asString(left.data.createdAtIso, "")))[0];
  return picked ?? null;
}

async function findOutreachRows(sourcePath: string, campaignId: string): Promise<Array<{ readonly path: string; readonly data: Record<string, unknown> }>> {
  const byMessageRef = await adminDb.collection("campaign_outreach").where("messageRef", "==", sourcePath).limit(20).get();
  if (!byMessageRef.empty) return byMessageRef.docs.map((doc) => ({ path: doc.ref.path, data: doc.data() ?? {} }));
  if (!campaignId) return [];
  const byCampaign = await adminDb.collection("campaign_outreach").where("campaignId", "==", campaignId).limit(50).get();
  return byCampaign.docs
    .map((doc) => ({ path: doc.ref.path, data: doc.data() ?? {} }))
    .filter((doc) => asString(doc.data.messageRef, "") === sourcePath);
}

async function recentHardBounceCount(nowMs: number): Promise<number> {
  const snapshot = await adminDb.collection("mail_delivery_failures").where("createdAtMs", ">=", nowMs - BOUNCE_WINDOW_MS).limit(500).get();
  return snapshot.docs.filter((doc) => asString(doc.data().kind, "") === "hard_bounce").length;
}

export async function recordBounceFromEmail(input: Record<string, unknown>): Promise<BounceRecordResult> {
  const parsed = parseDeliveryStatusNotification(input);
  if (!parsed.isBounce) return { bounced: false, classification: "not_bounce" };
  const nowMs = Date.now();
  const nowIso = asString(input.receivedAtIso, new Date(nowMs).toISOString());
  const outbound = await findOutboundSource(parsed);
  const recipient = parsed.finalRecipient ?? parsed.originalRecipient ?? normalizeEmailAddress(asString(outbound?.data.to, ""));
  const campaignId = asString(outbound?.data.campaignId, "");
  const conversationId = asString(outbound?.data.conversationId, "");
  const sourcePath = outbound?.path ?? "";
  const outreachRows = sourcePath ? await findOutreachRows(sourcePath, campaignId) : [];
  const bouncePatch = {
    deliveryState: parsed.classification === "deferred" ? "deferred" : "bounced",
    status: parsed.classification === "deferred" ? "deferred" : "bounced",
    bouncedAtIso: nowIso,
    bounce: parsed,
    updatedAtIso: nowIso,
  };
  const batch = adminDb.batch();
  if (sourcePath) batch.set(adminDb.doc(sourcePath), bouncePatch, { merge: true });
  for (const row of outreachRows) batch.set(adminDb.doc(row.path), bouncePatch, { merge: true });
  const suppressionCreated = parsed.classification === "hard_bounce" && Boolean(recipient);
  let suppressionRef = "";
  if (suppressionCreated) {
    suppressionRef = `mail_suppressions/${mailSuppressionDocId("email", recipient)}`;
    batch.set(adminDb.doc(suppressionRef), {
      id: suppressionRef.split("/").pop() ?? suppressionRef,
      email: recipient,
      domain: emailDomain(recipient),
      status: "active",
      source: "bounce-dsn",
      reason: parsed.diagnosticCode ?? "hard bounce DSN",
      ruleId: "mail-safety.hard-bounce",
      severity: "blocked",
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    }, { merge: true });
  }
  const failureId = safeMailDocId("bounce_failure", `${nowMs}:${sourcePath}:${recipient}:${parsed.originalMessageId ?? ""}`);
  batch.set(adminDb.collection("mail_delivery_failures").doc(failureId), {
    id: failureId,
    kind: parsed.classification,
    ruleId: parsed.classification === "deferred" ? "mail-safety.deferred-bounce" : "mail-safety.hard-bounce",
    reason: parsed.diagnosticCode ?? parsed.status ?? "delivery status notification",
    source: "bounce-dsn",
    email: recipient,
    domain: emailDomain(recipient),
    campaignId,
    conversationId,
    messageRef: sourcePath,
    suppressionRef,
    createdAtIso: nowIso,
    createdAtMs: nowMs,
  }, { merge: true });
  await batch.commit();
  for (const campaign of new Set(outreachRows.map((row) => asString(row.data.campaignId, campaignId)).filter(Boolean))) {
    await syncCampaignFunnelForCampaign(campaign);
  }
  if (parsed.classification === "hard_bounce") {
    const policy = await readOutboundPolicy();
    const bounceCount = await recentHardBounceCount(nowMs);
    if (bounceCount >= policy.hardBounceLockThreshold) {
      await lockOutboundMail(`최근 24시간 영구 반송이 ${bounceCount}건 감지되어 메일 발송을 중단합니다.`, "mail-safety.bounce-threshold", BOUNCE_LOCK_MS, nowIso);
    }
  }
  return { bounced: true, classification: parsed.classification, ...(sourcePath ? { sourceRef: sourcePath } : {}), suppressionCreated };
}
