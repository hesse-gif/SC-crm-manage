import { evaluateGameCompanySuppression } from "./mailSuppression";

export type InboundRoute =
  | "creator_reply"
  | "internal_company"
  | "vendor_role"
  | "game_company"
  | "newsletter_or_bulk"
  | "calendar_invite"
  | "auto_reply"
  | "unknown_quarantine";

/** Outbound match evidence conflicting with notification/bulk evidence on the same inbound (audit record). */
export type InboundRouteConflict = {
  kind: "outbound_match_vs_bulk" | "outbound_match_vs_noreply_sender" | "outbound_match_vs_auto_submitted";
  /**
   * bulk_wins: routed as a no-reply notification (affirmative notification-only evidence).
   * quarantined: ambiguous (bulk headers vs an outbound match) — held for human review, NEVER discarded.
   * thread_proof_wins / kept_creator_reply: kept as a creator reply (still audited).
   */
  resolution: "bulk_wins" | "quarantined" | "thread_proof_wins" | "kept_creator_reply";
};

export type InboundRouteDecision = {
  route: InboundRoute;
  allowChat: boolean;
  reason: string;
  ruleId: string;
  confidence: number;
  conflict?: InboundRouteConflict;
};

export type ClassifyInboundRouteInput = {
  from: string;
  to?: string;
  subject: string;
  body: string;
  headers?: Record<string, unknown>;
  hasOutboundMatch: boolean;
  /**
   * How the outbound match was proven (chat-ai.ts enrichInboundDataFromOutboundSource): "reply_header" /
   * "tracking_id" are thread proof; "from_address" is a weak sender-address match. Absent = unknown (treated
   * as not thread-proven for bulk evidence, unchanged for everything else).
   */
  outboundMatchBasis?: string;
};

// Minimal normalized notification/bulk header evidence (no raw header dump) carried from IMAP parse to
// receiveEmail. Booleans + a short whitelisted token only — nothing a sender controls verbatim.
export type InboundRoutingFlags = {
  listUnsubscribe: boolean;
  listId: boolean;
  precedence: "" | "bulk" | "list" | "junk";
  autoSubmitted: "" | "auto-generated" | "auto-replied" | "auto-notified" | "other";
};

function precedenceToken(value: unknown): InboundRoutingFlags["precedence"] {
  const token = String(value ?? "").trim().toLowerCase();
  return token === "bulk" || token === "list" || token === "junk" ? token : "";
}

function autoSubmittedToken(value: unknown): InboundRoutingFlags["autoSubmitted"] {
  const token = String(value ?? "").trim().toLowerCase().split(/[\s;]/)[0] ?? "";
  if (!token || token === "no") return "";
  if (token === "auto-generated" || token === "auto-replied" || token === "auto-notified") return token;
  return "other";
}

/** Flags from a mailparser-style header map (`has`/`get`, lowercase names). */
export function routingFlagsFromHeaderMap(headers: { has(name: string): boolean; get(name: string): unknown }): InboundRoutingFlags {
  const first = (name: string): unknown => {
    const value = headers.get(name);
    return Array.isArray(value) ? value[0] : value;
  };
  // mailparser does NOT expose List-Unsubscribe / List-Id under their own names: it folds every List-* header
  // into one structured `list` entry ({ unsubscribe, id, ... }). Accept both shapes (plain map in tests/queues).
  const listEntry = headers.get("list");
  const listKeys = listEntry && typeof listEntry === "object" ? Object.keys(listEntry as Record<string, unknown>) : [];
  return {
    listUnsubscribe: headers.has("list-unsubscribe") || listKeys.includes("unsubscribe"),
    listId: headers.has("list-id") || listKeys.includes("id"),
    precedence: precedenceToken(first("precedence")),
    autoSubmitted: autoSubmittedToken(first("auto-submitted")),
  };
}

/** Flags from a raw RFC822 header block (parser-failure fallback). Unfolded lines only; value tokens whitelisted. */
export function routingFlagsFromRawHeaderBlock(headerBlock: string): InboundRoutingFlags {
  const present = (name: string): boolean => new RegExp(`^${name}:`, "im").test(headerBlock);
  const value = (name: string): string => headerBlock.match(new RegExp(`^${name}:[ \\t]*([^\\r\\n]*)`, "im"))?.[1] ?? "";
  return {
    listUnsubscribe: present("List-Unsubscribe"),
    listId: present("List-Id"),
    precedence: precedenceToken(value("Precedence")),
    autoSubmitted: autoSubmittedToken(value("Auto-Submitted")),
  };
}

/** Re-validate flags from any untrusted record (queue docs, callable payload): whitelist everything, drop the rest. */
export function normalizeInboundRoutingFlags(value: unknown): InboundRoutingFlags | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const flags: InboundRoutingFlags = {
    listUnsubscribe: record.listUnsubscribe === true,
    listId: record.listId === true,
    precedence: precedenceToken(record.precedence),
    autoSubmitted: autoSubmittedToken(record.autoSubmitted),
  };
  return flags.listUnsubscribe || flags.listId || flags.precedence || flags.autoSubmitted ? flags : null;
}

/** Header-shaped view of the flags for classifyInboundRoute's header lookups. */
export function routingFlagsToHeaders(flags: InboundRoutingFlags | null): Record<string, string> {
  if (!flags) return {};
  return {
    ...(flags.listUnsubscribe ? { "list-unsubscribe": "1" } : {}),
    ...(flags.listId ? { "list-id": "1" } : {}),
    ...(flags.precedence ? { precedence: flags.precedence } : {}),
    ...(flags.autoSubmitted ? { "auto-submitted": flags.autoSubmitted } : {}),
  };
}

// A message that carries a substantive creator-side request/dispute must never be dismissed as a notification,
// even when the sender looks automated: payout/settlement disputes, refunds, and first-person asks.
const SUBSTANTIVE_CREATOR_REQUEST_PATTERN =
  /\b(?:never\s+received|haven['’]?t\s+received|did\s+not\s+receive|didn['’]?t\s+receive|unpaid|not\s+been\s+paid|payout|payment\s+(?:issue|problem|missing)|refund|chargeback|invoice\s+dispute|i\s+(?:would|'d)\s+like|i\s+(?:want|need)\s+to|i\s+have\s+a\s+question|can\s+(?:you|we)|could\s+(?:you|we)|how\s+do\s+i|when\s+will\s+i)\b|정산|미지급|환불|안\s*받았|못\s*받았|문의/i;

// Known notification/transactional sender patterns (affirmative evidence for an UNMATCHED bulk-header message).
const NOTIFICATION_LOCAL_PARTS = new Set([
  "noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "do_not_reply",
  "notification", "notifications", "notify", "alert", "alerts", "newsletter", "newsletters", "mailer-daemon", "postmaster",
  "bounce", "bounces", "updates", "digest", "announcements",
]);
// Requires a real sending SUBDOMAIN (at least three labels, e.g. mail.brand.example) so free-mail apex domains such as
// mail.com / mail.ru / e.mail never count.
const NOTIFICATION_SENDING_SUBDOMAIN_PATTERN = /^(?:mail|email|e|em|notify|notifications?|bounces?|mailer|news|newsletter|send|mg|smtp|updates?)\.[^.]+\.[^.]+/i;

const STRICT_NOREPLY_LOCAL_PARTS = new Set(["noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "do_not_reply"]);

const ROLE_LOCAL_PARTS = new Set([
  "support",
  "info",
  "sales",
  "noreply",
  "no-reply",
  "contact",
  "help",
  "team",
  "billing",
  "marketing",
  "press",
  "admin",
]);

function normalizeAddress(value: string): string {
  const raw = (value ?? "").toLowerCase();
  const angle = raw.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : raw).trim();
  const match = candidate.match(/[^\s@]+@[^\s@]+/);
  return (match ? match[0] : candidate).replace(/[>,;]+$/, "").trim();
}

function addressDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) : "";
}

function addressLocalPart(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(0, at) : "";
}

function headerLookup(headers: Record<string, unknown> | undefined, name: string): string {
  if (!headers) return "";
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value.find((entry): entry is string => typeof entry === "string") ?? "";
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.value === "string") return record.value;
    }
    return value == null ? "" : String(value);
  }
  return "";
}

function hasHeader(headers: Record<string, unknown> | undefined, name: string): boolean {
  if (!headers) return false;
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function hasBulkEvidence(headers: Record<string, unknown> | undefined): boolean {
  const precedence = headerLookup(headers, "precedence").toLowerCase();
  return (
    hasHeader(headers, "list-unsubscribe") ||
    hasHeader(headers, "list-id") ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk"
  );
}

export function classifyInboundRoute(input: ClassifyInboundRouteInput): InboundRouteDecision {
  // Rule 1: an outbound match normally reaches Chat as a creator reply — but a match is only a linking
  // fact, not a verdict on the sender's role or the message's nature (classification_v1). Bulk /
  // notification evidence is therefore evaluated even here and any conflict is recorded:
  //   - bulk headers (List-Unsubscribe / List-ID / Precedence bulk|list|junk) on a message that is NOT
  //     thread-proven (From-address match only) or that comes from a strict no-reply sender → no-reply
  //     notification (newsletter_or_bulk);
  //   - bulk headers on a thread-proven reply (In-Reply-To/References/tracking id) from any sender that can
  //     author a reply (personal or role account) → stays creator_reply (a true reply in our thread), conflict
  //     audited — a proven reply is never discarded;
  //   - a strict no-reply sender (noreply@/no-reply@/donotreply@) on a From-address-only match → vendor no-reply;
  //   - platform relay wrappers (moonio/heepsy) keep their creator-reply path (their footers are not evidence);
  //   - Auto-Submitted keeps flowing to Chat (OOO replies are classified there) with the conflict audited.
  if (input.hasOutboundMatch) {
    const matchHeaders = input.headers;
    const matchAddress = normalizeAddress(input.from);
    const matchLocalPart = addressLocalPart(matchAddress);
    const threadProven = input.outboundMatchBasis === "reply_header" || input.outboundMatchBasis === "tracking_id";
    if (!isPlatformWrapperAddress(input.from)) {
      if (hasBulkEvidence(matchHeaders)) {
        // Affirmative notification-only evidence (any one, and no substantive creator request in the text):
        // a strict no-reply sender, an Auto-Submitted auto-generated/auto-notified marker, or a role account
        // (support@/info@/billing@...) on a weak From-address-only match. Bulk headers alone are NOT enough — a
        // genuine creator can send through a service that adds List-Unsubscribe/List-ID.
        const autoGenerated = /^auto-(?:generated|notified)$/.test(headerLookup(matchHeaders, "auto-submitted").toLowerCase().split(/[\s;]/)[0] ?? "");
        const substantive = SUBSTANTIVE_CREATOR_REQUEST_PATTERN.test(`${input.subject}\n${input.body}`);
        // Role addresses (info@/support@/team@) are NOT proof: real creator studios use them. Only a strict no-reply
        // sender or an Auto-Submitted auto-generated/auto-notified marker is affirmative notification-only evidence.
        const notificationOnlyEvidence = STRICT_NOREPLY_LOCAL_PARTS.has(matchLocalPart) || autoGenerated;
        if (notificationOnlyEvidence && !substantive) {
          return {
            route: "newsletter_or_bulk",
            allowChat: false,
            reason: "아웃바운드 매칭이 있지만 알림 전용 증거(no-reply/자동 생성/역할 계정)와 대량 발송 헤더가 있어 알림 메일로 처리",
            ruleId: "inbound-route.outbound-match-bulk-conflict",
            confidence: 0.85,
            conflict: { kind: "outbound_match_vs_bulk", resolution: "bulk_wins" },
          };
        }
        if (!threadProven) {
          // Ambiguous: an outbound From-address match plus bulk headers but no affirmative notification evidence.
          // Genuine creator mail can look like this — hold it for human review instead of dropping it.
          return {
            route: "unknown_quarantine",
            allowChat: false,
            reason: "아웃바운드 발신 주소 매칭 + 대량 발송 헤더가 충돌 — 알림 전용 증거가 없어 사람 검토 대기(격리)",
            ruleId: "inbound-route.outbound-match-bulk-ambiguous",
            confidence: 0.5,
            conflict: { kind: "outbound_match_vs_bulk", resolution: "quarantined" },
          };
        }
        return {
          route: "creator_reply",
          allowChat: true,
          reason: "발송한 아웃바운드 스레드에 연결된 회신 — 대량 발송 헤더가 있으나 스레드 증거가 우선(충돌 기록)",
          ruleId: "inbound-route.outbound-match",
          confidence: 0.8,
          conflict: { kind: "outbound_match_vs_bulk", resolution: "thread_proof_wins" },
        };
      }
      if (
        input.outboundMatchBasis === "from_address" &&
        STRICT_NOREPLY_LOCAL_PARTS.has(matchLocalPart) &&
        !SUBSTANTIVE_CREATOR_REQUEST_PATTERN.test(`${input.subject}\n${input.body}`)
      ) {
        return {
          route: "vendor_role",
          allowChat: false,
          reason: `발신 주소 매칭뿐인 no-reply 계정(${matchLocalPart}@) — 크리에이터 회신이 아닌 시스템·벤더 알림`,
          ruleId: "inbound-route.outbound-match-noreply-sender",
          confidence: 0.85,
          conflict: { kind: "outbound_match_vs_noreply_sender", resolution: "bulk_wins" },
        };
      }
      const autoSubmittedValue = headerLookup(matchHeaders, "auto-submitted").toLowerCase();
      if ((autoSubmittedValue && autoSubmittedValue !== "no") || hasHeader(matchHeaders, "x-autoreply")) {
        return {
          route: "creator_reply",
          allowChat: true,
          reason: "발송한 아웃바운드에 연결된 회신(자동응답 헤더 있음 — 부재중 등은 Chat 분류가 처리, 충돌 기록)",
          ruleId: "inbound-route.outbound-match",
          confidence: 0.9,
          conflict: { kind: "outbound_match_vs_auto_submitted", resolution: "kept_creator_reply" },
        };
      }
    }
    return {
      route: "creator_reply",
      allowChat: true,
      reason: "발송한 아웃바운드에 연결된 검증된 크리에이터 회신",
      ruleId: "inbound-route.outbound-match",
      confidence: 1,
    };
  }

  const headers = input.headers;
  const address = normalizeAddress(input.from);
  const domain = addressDomain(address);
  const localPart = addressLocalPart(address);

  // Rule 2: internal company sender (with no outbound match).
  if (domain.endsWith("supercent.io")) {
    return {
      route: "internal_company",
      allowChat: false,
      reason: "내부 직원(@supercent.io) 발신 메일은 크리에이터 회신이 아닙니다.",
      ruleId: "inbound-route.internal-company",
      confidence: 0.95,
    };
  }

  // Rule 3: newsletter / bulk markers. Bulk headers alone never justify discarding a message (a genuine creator can
  // send through a service that adds List-Unsubscribe/List-ID, and a missing request phrase proves nothing): it is
  // dismissed ONLY with affirmative notification-only evidence — a known no-reply/notification sender pattern, a
  // transactional/notification sending subdomain, or Auto-Submitted auto-generated/auto-notified — and only when no
  // substantive creator request is present. Everything else is held for human review (quarantine).
  if (hasBulkEvidence(headers)) {
    const unmatchedAutoGenerated = /^auto-(?:generated|notified)$/.test(headerLookup(headers, "auto-submitted").toLowerCase().split(/[\s;]/)[0] ?? "");
    const affirmativeNotification =
      NOTIFICATION_LOCAL_PARTS.has(localPart) ||
      NOTIFICATION_SENDING_SUBDOMAIN_PATTERN.test(domain) ||
      unmatchedAutoGenerated;
    if (!affirmativeNotification || SUBSTANTIVE_CREATOR_REQUEST_PATTERN.test(`${input.subject}\n${input.body}`)) {
      return {
        route: "unknown_quarantine",
        allowChat: false,
        reason: "대량 발송 헤더가 있으나 알림 전용 증거가 없거나 실질 요청 문구가 있어 사람 검토 대기(격리)",
        ruleId: "inbound-route.bulk-ambiguous",
        confidence: 0.5,
      };
    }
    return {
      route: "newsletter_or_bulk",
      allowChat: false,
      reason: "뉴스레터·대량 발송(List-Unsubscribe/List-ID/Precedence: bulk) + 알림 전용 증거(알림 발신 패턴/자동 생성)",
      ruleId: "inbound-route.newsletter-bulk",
      confidence: 0.9,
    };
  }

  // Rule 4: calendar invite.
  const contentType = headerLookup(headers, "content-type").toLowerCase();
  const calendarMethod = headerLookup(headers, "method").toLowerCase();
  if (
    contentType.includes("text/calendar") ||
    contentType.includes("method=request") ||
    calendarMethod === "request" ||
    hasHeader(headers, "x-google-calendar") ||
    Object.keys(headers ?? {}).some((key) => key.toLowerCase().startsWith("x-google-calendar"))
  ) {
    return {
      route: "calendar_invite",
      allowChat: false,
      reason: "캘린더 초대(text/calendar / method=REQUEST) 메일",
      ruleId: "inbound-route.calendar-invite",
      confidence: 0.9,
    };
  }

  // Rule 5: auto-reply / vacation responder.
  const autoSubmitted = headerLookup(headers, "auto-submitted").toLowerCase();
  if ((autoSubmitted && autoSubmitted !== "no") || hasHeader(headers, "x-autoreply")) {
    return {
      route: "auto_reply",
      allowChat: false,
      reason: "자동응답(Auto-Submitted/X-Autoreply) 메일",
      ruleId: "inbound-route.auto-reply",
      confidence: 0.85,
    };
  }

  // Rule 6: game company by domain/text (reuse suppression heuristics).
  const gameCompany = evaluateGameCompanySuppression({
    email: address,
    domain,
    text: [input.subject, input.body].filter(Boolean).join(" "),
  });
  if (gameCompany) {
    return {
      route: "game_company",
      allowChat: false,
      reason: gameCompany.reason ?? "게임사·게임 개발사·퍼블리셔로 판단되어 채팅 라우팅을 차단합니다.",
      ruleId: "inbound-route.game-company",
      confidence: gameCompany.matchedField === "domain" ? 0.8 : 0.6,
    };
  }

  // Rule 7: vendor / role-account local part.
  if (ROLE_LOCAL_PARTS.has(localPart)) {
    return {
      route: "vendor_role",
      allowChat: false,
      reason: `역할 계정(${localPart}@) 발신 메일은 크리에이터 회신이 아닙니다.`,
      ruleId: "inbound-route.vendor-role",
      confidence: 0.7,
    };
  }

  // Rule 8: default — treat as a creator reply (do NOT over-block unknown personal senders).
  return {
    route: "creator_reply",
    allowChat: true,
    reason: "분류 노이즈 조건에 해당하지 않아 크리에이터 회신으로 처리합니다.",
    ruleId: "inbound-route.default-creator",
    confidence: 0.5,
  };
}

// Platform wrappers (moonio / heepsy) deliver a creator's reply inside a relay envelope:
// the SMTP From is the platform (e.g. reply-to+<token>@moonio.io / notifications@heepsy.com),
// and the actual creator-authored text + author identity live in the body. We match on the
// EMBEDDED creator identity — never on the wrapper's own address or its unsubscribe footer
// (treating wrapper opt-out text as a creator opt-out would be wrong).
const PLATFORM_WRAPPER_DOMAINS = ["moonio.io", "heepsy.com"];

export function isPlatformWrapperAddress(from: string): boolean {
  const domain = addressDomain(normalizeAddress(from));
  return PLATFORM_WRAPPER_DOMAINS.some((wrapper) => domain === wrapper || domain.endsWith(`.${wrapper}`));
}

export type PlatformWrapperExtract = { identity: string; confidence: number };

// Pull the embedded creator email identity out of a platform-wrapper body. Looks for the
// labeled "from/reply-to/sender/creator" line a wrapper renders for the original author, and
// falls back to the first non-wrapper, non-noreply email address found. Returns null when no
// embedded creator identity can be recovered. Low confidence (single bare address, no label)
// is reported so the caller can quarantine instead of auto-attaching.
export function extractPlatformWrapperIdentity(body: string): PlatformWrapperExtract | null {
  const text = (body ?? "").toString();
  if (!text) return null;
  const emailPattern = /[^\s<>@]+@[^\s<>@,;]+\.[^\s<>@,;]+/gi;
  // 1) Labeled author line (highest confidence): "From: Jane <jane@example.com>", "Reply-To: ...",
  //    "Creator: ...", Korean "보낸사람"/"작성자".
  const labeled = text.match(
    /(?:from|reply[-\s]?to|sender|creator|author|보낸\s*사람|작성자)\s*[:：]\s*[^\n]*?([^\s<>@]+@[^\s<>@,;]+\.[^\s<>@,;]+)/i,
  );
  if (labeled && labeled[1]) {
    const identity = normalizeAddress(labeled[1]);
    if (identity.includes("@") && !isPlatformWrapperAddress(identity) && !isWrapperNoiseAddress(identity)) {
      return { identity, confidence: 0.8 };
    }
  }
  // 2) Fallback: first embedded address that is not the wrapper itself or its noreply/unsubscribe
  //    footer. Lower confidence — no explicit author label to anchor on.
  const matches = text.match(emailPattern) ?? [];
  for (const raw of matches) {
    const identity = normalizeAddress(raw);
    if (!identity.includes("@")) continue;
    if (isPlatformWrapperAddress(identity)) continue;
    if (isWrapperNoiseAddress(identity)) continue;
    return { identity, confidence: 0.5 };
  }
  return null;
}

function isWrapperNoiseAddress(address: string): boolean {
  const local = addressLocalPart(address);
  return (
    local === "noreply" ||
    local === "no-reply" ||
    local === "unsubscribe" ||
    local === "notifications" ||
    local === "notification" ||
    local === "support" ||
    local === "help"
  );
}
