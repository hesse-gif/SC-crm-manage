import { createHash } from "node:crypto";

export type MailSafetyMode = "receive" | "auto_reply" | "auto_send" | "manual_send";

export type MailSafetyDecision = {
  allowed: boolean;
  severity: "ok" | "blocked" | "emergency";
  reason: string;
  ruleId: string;
  matchedKeyword?: string;
  suppressionRef?: string;
  humanRequired: boolean;
  // W117: 억제 hit 가 있었지만(예: infly-overlap) 운영자 수동 답장 예외로 통과시킨 경우에만 채운다.
  // 발송은 허용됐다는 뜻이니 UI는 이걸로 차단이 아니라 "경고 배지"만 보여줘야 한다.
  suppressionWarning?: {
    ruleId: string;
    reason: string;
    suppressionRef?: string;
  };
};

export type OutboundFailureKind =
  | "invalid_recipient"
  | "no_mx"
  | "hard_bounce"
  | "provider_suspension"
  | "rate_limit"
  | "temporary"
  | "safety_lock"
  // requeue-provenance fix (2026-09-25): an internal pipeline bug (e.g. a queue doc built
  // without the Permit provenance fields sendAutoReplyJob requires) is NOT evidence that SMTP
  // failed or that the recipient/content is risky — it must never be classified as
  // "temporary" (which reads as an SMTP retry signal in ops dashboards/Slack alerts) nor drive
  // any content-risk response. See pipelinePreconditionFailure/isPipelinePreconditionFailure.
  | "pipeline_precondition";

export type OutboundFailure = {
  kind: OutboundFailureKind;
  ruleId: string;
  reason: string;
};

export type SafeOutboundFailureEvidence = {
  failureKind: OutboundFailureKind;
  failureRuleId: string;
  failureReason: string;
  errorCode: string;
  correlationIdHash: string;
};

const CANONICAL_OUTBOUND_FAILURES: Record<
  OutboundFailureKind,
  OutboundFailure
> = {
  invalid_recipient: {
    kind: "invalid_recipient",
    ruleId: "mail-safety.invalid-recipient",
    reason: "수신자 이메일 형식이 유효하지 않습니다.",
  },
  no_mx: {
    kind: "no_mx",
    ruleId: "mail-safety.no-mx",
    reason: "수신자 도메인에 메일 수신용 MX 레코드가 없습니다.",
  },
  hard_bounce: {
    kind: "hard_bounce",
    ruleId: "mail-safety.hard-bounce",
    reason: "수신자 주소가 존재하지 않거나 영구 반송으로 판단됩니다.",
  },
  provider_suspension: {
    kind: "provider_suspension",
    ruleId: "mail-safety.provider-suspension",
    reason: "SMTP 제공자가 계정 제한·스팸·쿼터 위험 신호를 반환했습니다.",
  },
  rate_limit: {
    kind: "rate_limit",
    ruleId: "mail-safety.rate-limit",
    reason: "SMTP 제공자가 일시 제한 또는 쿼터 신호를 반환했습니다.",
  },
  temporary: {
    kind: "temporary",
    ruleId: "mail-safety.smtp-temporary-failure",
    reason: "SMTP 발송 실패가 감지되었습니다.",
  },
  safety_lock: {
    kind: "safety_lock",
    ruleId: "mail-safety.outbound-lock",
    reason: "메일 발송 안전 잠금 또는 쿼터 제한이 활성화되어 있습니다.",
  },
  pipeline_precondition: {
    kind: "pipeline_precondition",
    ruleId: "mail-safety.pipeline-precondition-failure",
    reason: "발송 전 내부 파이프라인 사전조건 검증에 실패했습니다(SMTP 발송 실패 아님, 수신자/콘텐츠 문제 아님).",
  },
};

export function canonicalOutboundFailure(
  kind: unknown,
): OutboundFailure | undefined {
  if (
    typeof kind !== "string" ||
    !Object.prototype.hasOwnProperty.call(CANONICAL_OUTBOUND_FAILURES, kind)
  ) {
    return undefined;
  }
  return { ...CANONICAL_OUTBOUND_FAILURES[kind as OutboundFailureKind] };
}

function requiredCanonicalOutboundFailure(
  kind: OutboundFailureKind,
): OutboundFailure {
  return { ...CANONICAL_OUTBOUND_FAILURES[kind] };
}

export function normalizePolicyToken(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeEmailAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function emailDomain(value: string): string {
  const normalized = normalizeEmailAddress(value);
  const at = normalized.lastIndexOf("@");
  return at >= 0 ? normalized.slice(at + 1) : "";
}

export function looksLikeEmailAddress(value: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalizeEmailAddress(value));
}

export function normalizedList(values: readonly string[]): string[] {
  return values.map(normalizePolicyToken).filter(Boolean);
}

export function firstKeywordMatch(haystack: string, keywords: readonly string[]): string | undefined {
  const normalizedHaystack = haystack.toLowerCase();
  return keywords.find((keyword) => keyword && normalizedHaystack.includes(keyword.toLowerCase()));
}

export function safeMailDocId(prefix: string, seed: string): string {
  const digest = createHash("sha1").update(seed || prefix).digest("hex").slice(0, 28);
  return `${prefix}_${digest}`;
}

function rawErrorText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return error instanceof Error ? error.message : String(error ?? "");
  }
  const record = error as Record<string, unknown>;
  return [
    record.message,
    record.response,
    record.code,
    record.command,
    record.responseCode,
  ].map((value) => typeof value === "string" || typeof value === "number" ? String(value) : "").filter(Boolean).join(" ");
}

// Compatibility helper for callers that need a diagnostic label. Never return
// provider exception text: callers may surface this string in an error that
// crosses a callable boundary.
export function errorText(error: unknown): string {
  return classifyOutboundFailure(error).ruleId;
}

// requeue-provenance fix (2026-09-25): marks an error as an internal pipeline/precondition bug
// (e.g. a queue doc missing required Permit provenance fields) rather than a genuine SMTP/
// delivery failure, so classifyOutboundFailure below can route it to its own failureKind instead
// of falling into the generic "temporary" (SMTP retry) bucket. `code`/`errorCode` stay aligned
// with the existing failedPrecondition() shape so callable error semantics are unaffected.
export function pipelinePreconditionFailure(message: string): Error {
  return Object.assign(new Error(message), {
    code: "failed-precondition",
    errorCode: "auto_reply_pipeline_precondition",
    pipelinePrecondition: true,
  });
}

export function isPipelinePreconditionFailure(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as Record<string, unknown>).pipelinePrecondition === true,
  );
}

export function classifyOutboundFailure(error: unknown): OutboundFailure {
  if (isPipelinePreconditionFailure(error)) {
    return requiredCanonicalOutboundFailure("pipeline_precondition");
  }
  const text = rawErrorText(error).toLowerCase();
  if (/outbound mail safety lock|outbound mail quota/.test(text)) {
    return requiredCanonicalOutboundFailure("safety_lock");
  }
  if (/valid recipient email|invalid recipient|invalid email/.test(text)) {
    return requiredCanonicalOutboundFailure("invalid_recipient");
  }
  if (/no mx|domain has no mx|enodata|enotfound|null mx/.test(text)) {
    return requiredCanonicalOutboundFailure("no_mx");
  }
  if (/suspended|disabled|spam|abuse|policy|too many bounced|too many messages|daily user sending limit|reached a limit|account.*limit|not permitted to send/i.test(text)) {
    return requiredCanonicalOutboundFailure("provider_suspension");
  }
  if (/rate limit|quota|temporarily deferred|try again later|4\.7\.0|4\.5\.3|(?<!\d)(?:421|450|451|452)(?!\d)/i.test(text)) {
    return requiredCanonicalOutboundFailure("rate_limit");
  }
  if (/5\.1\.1|5\.1\.0|user unknown|no such user|address not found|recipient address rejected|mailbox unavailable|mailbox not found|does not exist|undeliverable|unknown recipient/i.test(text)) {
    return requiredCanonicalOutboundFailure("hard_bounce");
  }
  return requiredCanonicalOutboundFailure("temporary");
}

export function safeOutboundFailureEvidence(
  error: unknown,
  scope = "mail_outbound",
): SafeOutboundFailureEvidence {
  const failure = classifyOutboundFailure(error);
  const privateFingerprint = rawErrorText(error) || failure.ruleId;
  return {
    failureKind: failure.kind,
    failureRuleId: failure.ruleId,
    failureReason: failure.reason,
    errorCode: `mail_outbound_${failure.kind}`,
    correlationIdHash: createHash("sha256")
      .update(`${scope}\u0000${privateFingerprint}`)
      .digest("hex")
      .slice(0, 24),
  };
}

export function failedPrecondition(message: string): Error {
  return Object.assign(new Error(message), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}
