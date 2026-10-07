// Pure calibration core for voice-authenticity risk (handoff §5, `voice_authenticity_risk.v1`).
// Voice authenticity is CALIBRATED RISK EVIDENCE, not forensic truth. Hard invariant: a synthetic-
// -sounding voice ALONE never auto-rejects; high or uncertain risk always routes to human review.
// Deterministic, no I/O; the analysis worker persists model/version/confidence/reasons and feeds
// the band into the review transition actor gate.

export const VOICE_AUTHENTICITY_RISK_VERSION = "voice_authenticity_risk.v1" as const;

export type VoiceRiskBand = "low" | "elevated" | "high" | "uncertain";

export type VoiceAuthenticityInput = {
  model: string;
  modelVersion: string;
  syntheticProbability: number; // 0..1 estimated probability the voice is synthetic
  confidence: number; // 0..1 the model's confidence in its own estimate
  reasons: string[];
};

export type VoiceAuthenticityDecision = {
  version: typeof VOICE_AUTHENTICITY_RISK_VERSION;
  model: string;
  modelVersion: string;
  syntheticProbability: number;
  confidence: number;
  band: VoiceRiskBand;
  requiresHumanReview: boolean;
  autoDecisionAllowed: boolean;
  autoRejectForbidden: true;
  reasons: string[];
};

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export const VOICE_RISK_CONFIDENCE_FLOOR = 0.5;
export const VOICE_RISK_HIGH_THRESHOLD = 0.7;
export const VOICE_RISK_ELEVATED_THRESHOLD = 0.4;

export function assessVoiceAuthenticityRisk(input: VoiceAuthenticityInput): VoiceAuthenticityDecision {
  const syntheticProbability = clamp01(input.syntheticProbability);
  const confidence = clamp01(input.confidence);

  let band: VoiceRiskBand;
  if (confidence < VOICE_RISK_CONFIDENCE_FLOOR) {
    // The model is not confident enough to band the estimate — treat as uncertain → human review.
    band = "uncertain";
  } else if (syntheticProbability >= VOICE_RISK_HIGH_THRESHOLD) {
    band = "high";
  } else if (syntheticProbability >= VOICE_RISK_ELEVATED_THRESHOLD) {
    band = "elevated";
  } else {
    band = "low";
  }

  const requiresHumanReview = band !== "low";
  // An AI decision may only proceed automatically on a confident low-risk band; and even then the
  // review transition core forbids auto-reject on voice risk alone (autoRejectForbidden).
  const autoDecisionAllowed = band === "low";

  return {
    version: VOICE_AUTHENTICITY_RISK_VERSION,
    model: input.model,
    modelVersion: input.modelVersion,
    syntheticProbability,
    confidence,
    band,
    requiresHumanReview,
    autoDecisionAllowed,
    autoRejectForbidden: true,
    reasons: (input.reasons ?? []).slice(0, 20),
  };
}

// Map the risk band to the review-transition evidenceRisk vocabulary (low | high | uncertain).
export function voiceRiskToEvidenceRisk(band: VoiceRiskBand): "low" | "high" | "uncertain" {
  if (band === "low") return "low";
  if (band === "uncertain") return "uncertain";
  return "high"; // elevated + high both gate to human review
}
