import { createHash } from "node:crypto";

export const FEEDBACK_SCOPE_VERSION = "feedback-scope-v2" as const;
export const EXPLICIT_GLOBAL_SCOPE = "global" as const;

export type FeedbackGovernanceScope = {
  version: typeof FEEDBACK_SCOPE_VERSION;
  kind: "campaign" | "global";
  scopeKey: string;
  accountOwnerUid: string | null;
  programId: string | null;
  campaignId: string | null;
  locale: string;
};

export type FeedbackReviewState = {
  status: string;
  reviewStatus: string;
  retrievalStatus: string;
  evalStatus: string;
  promotionStatus: string;
  revision: number;
  lastTransitionId?: string;
};

export type FeedbackReviewTransitionInput = {
  current: FeedbackReviewState;
  decision: "approve" | "reject";
  expectedRevision: number;
  transitionId: string;
  rating: "up" | "down";
  evaluationPassed: boolean;
  correctionNote?: string;
};

export type FeedbackReviewTransitionPlan = {
  idempotent: boolean;
  revision: number;
  next: FeedbackReviewState;
};

function governanceError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function hash(value: string, length = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function cleanIdentity(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/[^a-zA-Z0-9._~-]/g, "-").replace(/-+/g, "-").slice(0, 160)
    : "";
}

export function canonicalizeFeedbackLocale(value: unknown): string {
  const locale = typeof value === "string" ? value.trim().replace(/_/g, "-").toLowerCase() : "";
  if (!locale || !/^(?:und|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/.test(locale)) {
    throw governanceError("invalid_feedback_locale");
  }
  return locale.slice(0, 48);
}

export function buildFeedbackGovernanceScope(input: {
  canonicalProgramId?: unknown;
  campaignId?: unknown;
  campaignCanonicalProgramId?: unknown;
  accountOwnerUid?: unknown;
  locale?: unknown;
  globalScope?: unknown;
}): FeedbackGovernanceScope {
  const locale = canonicalizeFeedbackLocale(input.locale);
  const canonicalProgramId = cleanIdentity(input.canonicalProgramId);
  const campaignId = cleanIdentity(input.campaignId);
  const campaignCanonicalProgramId = cleanIdentity(input.campaignCanonicalProgramId);
  const accountOwnerUid = cleanIdentity(input.accountOwnerUid);
  const explicitGlobal = input.globalScope === EXPLICIT_GLOBAL_SCOPE;

  if (explicitGlobal) {
    if (canonicalProgramId || campaignId || campaignCanonicalProgramId || accountOwnerUid) {
      throw governanceError("ambiguous_feedback_scope");
    }
    const identity = `global|${locale}`;
    return {
      version: FEEDBACK_SCOPE_VERSION,
      kind: "global",
      scopeKey: `scope-${hash(identity)}`,
      accountOwnerUid: null,
      programId: null,
      campaignId: null,
      locale,
    };
  }

  if (!canonicalProgramId || !campaignId || !campaignCanonicalProgramId) {
    throw governanceError("feedback_campaign_scope_required");
  }
  if (canonicalProgramId !== campaignCanonicalProgramId) {
    throw governanceError("feedback_campaign_program_mismatch");
  }
  if (!accountOwnerUid) {
    throw governanceError("feedback_account_owner_required");
  }
  const identity = `campaign|${accountOwnerUid}|${canonicalProgramId}|${campaignId}|${locale}`;
  return {
    version: FEEDBACK_SCOPE_VERSION,
    kind: "campaign",
    scopeKey: `scope-${hash(identity)}`,
    accountOwnerUid,
    programId: canonicalProgramId,
    campaignId,
    locale,
  };
}

export function feedbackScopeFromStored(value: unknown): FeedbackGovernanceScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== FEEDBACK_SCOPE_VERSION) return null;
  try {
    return buildFeedbackGovernanceScope({
      canonicalProgramId: record.kind === "campaign" ? record.programId : undefined,
      campaignId: record.kind === "campaign" ? record.campaignId : undefined,
      campaignCanonicalProgramId: record.kind === "campaign" ? record.programId : undefined,
      accountOwnerUid: record.kind === "campaign" ? record.accountOwnerUid : undefined,
      locale: record.locale,
      globalScope: record.kind === "global" ? EXPLICIT_GLOBAL_SCOPE : undefined,
    });
  } catch {
    return null;
  }
}

export function feedbackScopesEqual(left: FeedbackGovernanceScope, right: FeedbackGovernanceScope): boolean {
  return left.version === right.version
    && left.kind === right.kind
    && left.scopeKey === right.scopeKey
    && left.accountOwnerUid === right.accountOwnerUid
    && left.programId === right.programId
    && left.campaignId === right.campaignId
    && left.locale === right.locale;
}

export function requireStoredFeedbackScope(value: unknown, expected: FeedbackGovernanceScope): FeedbackGovernanceScope {
  const stored = feedbackScopeFromStored(value);
  if (!stored || !feedbackScopesEqual(stored, expected)) {
    throw governanceError("feedback_scope_mismatch");
  }
  return stored;
}

export function redactKnowledgeText(value: unknown, fallback = ""): string {
  const source = typeof value === "string" ? value : fallback;
  return source
    .replace(/\b(?:bearer\s+)[a-z0-9._~+/=-]+/gi, "Bearer [redacted-token]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[redacted-phone]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b(api[_-]?key|client[_-]?secret|secret|token|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted-secret]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function redactKnowledgeRef(value: unknown, fallback = "artifact/redacted"): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback;
  // Firestore lineage references are identifiers, not prose. A millisecond epoch
  // inside a named document id (for example `videos/foo-1720000000000`) must not be
  // mistaken for a phone number or the source lineage is destroyed. The same applies
  // to server-generated `epochMs + short numeric nonce` ids. Probe the path with only
  // a plausible 2000-2100 epoch (and up to six nonce digits) replaced, then run the
  // complete PII/secret redactor on that probe. This keeps the exception narrow: raw
  // emails, phone-only ids, IPs, URLs, query strings, and secret-shaped ids still hash.
  const internalFirestorePath = /^[A-Za-z][A-Za-z0-9_.~-]{0,127}\/[A-Za-z0-9_.:~-]+(?:\/[A-Za-z0-9_.:~-]+)*$/;
  const segments = raw.split("/");
  const redactionProbe = segments.map((segment, index) => {
    if (index % 2 === 0 || !/[A-Za-z]/.test(segment)) return segment;
    return segment.replace(/(^|\D)(\d{13})(\d{0,6})(?!\d)/g, (match, prefix: string, digits: string, nonce: string) => {
      const epochMs = Number(digits);
      return epochMs >= 946_684_800_000 && epochMs <= 4_102_444_800_000
        ? `${prefix}epochms${nonce ? "nonce" : ""}`
        : match;
    });
  }).join("/");
  if (
    raw.length <= 240
    && internalFirestorePath.test(raw)
    && redactKnowledgeText(redactionProbe) === redactionProbe
  ) return raw;
  const redacted = redactKnowledgeText(raw);
  if (redacted !== raw || /[?&#=]/.test(raw)) return `redacted-ref-${hash(raw, 24)}`;
  return raw.replace(/[^a-zA-Z0-9/_:.~-]/g, "-").replace(/-+/g, "-").slice(0, 240) || fallback;
}

export function planFeedbackReviewTransition(input: FeedbackReviewTransitionInput): FeedbackReviewTransitionPlan {
  const transitionId = cleanIdentity(input.transitionId);
  if (!transitionId) throw governanceError("feedback_transition_id_required");
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw governanceError("feedback_expected_revision_required");
  }
  if (input.current.lastTransitionId === transitionId) {
    return { idempotent: true, revision: input.current.revision, next: { ...input.current } };
  }
  if (input.current.revision !== input.expectedRevision) {
    throw governanceError("feedback_revision_conflict");
  }
  const correctionNote = redactKnowledgeText(input.correctionNote).trim();
  if (input.decision === "approve" && input.rating === "down" && correctionNote.length < 4) {
    throw governanceError("feedback_correction_note_required");
  }

  const revision = input.current.revision + 1;
  if (input.decision === "reject") {
    return {
      idempotent: false,
      revision,
      next: {
        status: "rejected",
        reviewStatus: "rejected",
        retrievalStatus: "excluded_rejected",
        evalStatus: input.current.evalStatus || "not_started",
        promotionStatus: input.current.promotionStatus === "promoted" ? "revoked" : "not_promoted",
        revision,
        lastTransitionId: transitionId,
      },
    };
  }

  const passed = input.evaluationPassed;
  return {
    idempotent: false,
    revision,
    next: {
      status: passed ? "promoted" : "eval_failed",
      reviewStatus: "approved",
      retrievalStatus: passed ? "active" : "excluded_eval_failed",
      evalStatus: passed ? "passed" : "failed",
      promotionStatus: passed ? "promoted" : "not_promoted",
      revision,
      lastTransitionId: transitionId,
    },
  };
}

export function fineTuneOutboxId(feedbackId: string, scopeKey: string, reviewRevision: number): string {
  return `ft-${hash(`${scopeKey}|${feedbackId}|${reviewRevision}`, 32)}`;
}

export function fineTuneIdempotencyKey(feedbackRef: string, promotionRef: string, reviewRevision: number): string {
  return `flu-ft-${hash(`${feedbackRef}|${promotionRef}|${reviewRevision}`, 40)}`;
}

export function encodeFeedbackCursor(promotedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ promotedAt, id }), "utf8").toString("base64url");
}

export function decodeFeedbackCursor(value: unknown): { promotedAt: string; id: string } | null {
  if (typeof value !== "string" || !value || value.length > 400) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const promotedAt = typeof parsed.promotedAt === "string" ? parsed.promotedAt : "";
    const id = cleanIdentity(parsed.id);
    return promotedAt && id ? { promotedAt, id } : null;
  } catch {
    return null;
  }
}
