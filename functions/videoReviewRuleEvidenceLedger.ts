import {
  VIDEO_REVIEW_POLICY_VERSION,
  VIDEO_REVIEW_RULES,
  videoReviewRuleById,
} from "./videoReviewCriteria";

export const VIDEO_REVIEW_RULE_EVIDENCE_LEDGER_VERSION =
  "flu-video-review-rule-evidence-ledger/v1" as const;

type EvidenceInput = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function verdict(value: EvidenceInput): "pass" | "fail" | "unknown" {
  const explicit = text(value.verdict);
  if (explicit === "pass" || explicit === "fail" || explicit === "unknown") {
    return explicit;
  }
  const status = text(value.status);
  if (status === "observed" || status === "passed") return "pass";
  if (status === "failed") return "fail";
  return "unknown";
}

function confidence(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(1, Math.max(0, numeric))
    : 0;
}

function gateReason(value: EvidenceInput): string | null {
  return (
    text(value.gateReason) ||
    text(value.code) ||
    text(value.reasonCode) ||
    null
  );
}

function evidenceEntry(value: EvidenceInput, nowIso: string) {
  const provider =
    text(value.provider) ||
    text(record(value.engine).kind) ||
    "unknown_engine";
  const engineVersion =
    text(value.engineVersion) ||
    text(value.version) ||
    text(record(value.engine).version) ||
    VIDEO_REVIEW_POLICY_VERSION;
  const modelId =
    text(value.modelId) ||
    text(value.model) ||
    text(record(value.engine).modelId) ||
    null;
  const evidenceRef =
    text(value.evidenceRef) ||
    text(value.inputFingerprint) ||
    text(value.code) ||
    null;
  return {
    verdict: verdict(value),
    confidence: confidence(value.confidence),
    citations: Array.isArray(value.citations)
      ? value.citations.slice(0, 12)
      : evidenceRef
        ? [{
            source: provider,
            timestampMs: null,
            frameRef: null,
            transcriptRef: null,
            evidenceRef,
          }]
        : [],
    engine: {
      kind: provider,
      version: engineVersion,
      modelId,
    },
    gateReason: gateReason(value),
    observedAtIso:
      text(value.observedAtIso) || text(value.producedAtIso) || nowIso,
  };
}

function aggregateVerdict(
  evidence: Array<ReturnType<typeof evidenceEntry>>,
): "pass" | "fail" | "unknown" {
  if (evidence.some((item) => item.verdict === "fail")) return "fail";
  if (evidence.some((item) => item.verdict === "pass")) return "pass";
  return "unknown";
}

export function initialVideoReviewRuleEvidenceLedger(nowIso: string) {
  return VIDEO_REVIEW_RULES.map((rule) => {
    const gate =
      rule.assessment === "human_only"
        ? "human_only_rule"
        : rule.id === "R7"
          ? (
            process.env.VIDEO_ANALYSIS_JUDGE_LANE_APPROVED !== "true"
              ? "VIDEO_ANALYSIS_JUDGE_LANE_APPROVED_not_true"
              : !process.env.AI_HUB_GATEWAY_URL?.trim()
                ? "AI_HUB_GATEWAY_URL_missing"
                : "analysis_pending"
          )
          : "analysis_pending";
    const initial = evidenceEntry(
      {
        provider:
          rule.assessment === "human_only"
            ? "human_review"
            : rule.id === "R7"
              ? "voice_language_analysis"
              : "pending_analysis",
        version:
          rule.id === "R7"
            ? "voice_authenticity_risk.v1+language_accent.v1"
            : VIDEO_REVIEW_POLICY_VERSION,
        verdict: "unknown",
        confidence: 0,
        gateReason: gate,
      },
      nowIso,
    );
    return {
      ruleId: rule.id,
      rubricVersion: VIDEO_REVIEW_POLICY_VERSION,
      verdict: "unknown",
      confidence: 0,
      evidence: [initial],
      requiresHumanConfirmation:
        rule.requiresHumanConfirmation || rule.assessment === "human_only",
      humanConfirmation: null,
      updatedAtIso: nowIso,
    };
  });
}

export function mergeVideoReviewRuleEvidenceLedger(
  current: unknown,
  inputs: readonly unknown[],
  nowIso: string,
) {
  const byRule = new Map<string, Record<string, unknown>>();
  for (const row of Array.isArray(current) ? current : []) {
    const item = record(row);
    const ruleId = text(item.ruleId);
    if (videoReviewRuleById(ruleId)) byRule.set(ruleId, item);
  }
  for (const rawInput of inputs) {
    const input = record(rawInput);
    const ruleId = text(input.ruleId);
    const descriptor = videoReviewRuleById(ruleId);
    if (!descriptor) continue;
    const prior = byRule.get(ruleId) ?? {};
    const priorEvidence = Array.isArray(prior.evidence)
      ? prior.evidence.map(record)
      : [];
    const next = evidenceEntry(input, nowIso);
    const identity = `${next.engine.kind}|${next.engine.version}|${next.engine.modelId ?? ""}`;
    const evidence = [
      ...priorEvidence.filter((item) => {
        const engine = record(item.engine);
        return `${text(engine.kind)}|${text(engine.version)}|${text(engine.modelId)}`
          !== identity;
      }),
      next,
    ].slice(-24) as Array<ReturnType<typeof evidenceEntry>>;
    byRule.set(ruleId, {
      ruleId,
      rubricVersion: VIDEO_REVIEW_POLICY_VERSION,
      verdict: aggregateVerdict(evidence),
      confidence: Math.max(...evidence.map((item) => item.confidence), 0),
      evidence,
      requiresHumanConfirmation:
        descriptor.requiresHumanConfirmation ||
        descriptor.assessment === "human_only",
      humanConfirmation: prior.humanConfirmation ?? null,
      updatedAtIso: nowIso,
    });
  }
  const seeded = initialVideoReviewRuleEvidenceLedger(nowIso);
  return seeded.map((row) => byRule.get(row.ruleId) ?? row);
}
