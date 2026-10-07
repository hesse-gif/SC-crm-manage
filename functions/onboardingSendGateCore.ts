// Pure core for onboarding-mail send / content-grant gating (frozen contract §4.4; spec D.4).
// Only `managed` application records are eligible for an onboarding send or a content grant;
// unclassified/ambiguous/conflict are blocked. Deterministic, no side effects.

import type { AttributionClassification } from "./applicationManagementAttributionCore";

export const ONBOARDING_SEND_GATE_VERSION = "onboarding_send_gate_v2" as const;

export type OnboardingSendDecision = {
  autoSendEligible: boolean;
  contentGrantEligible: boolean;
  blockedReason: "classification_not_managed" | null;
};

export function onboardingSendGate(classification: AttributionClassification): OnboardingSendDecision {
  const managed = classification === "managed";
  return {
    autoSendEligible: managed,
    contentGrantEligible: managed,
    blockedReason: managed ? null : "classification_not_managed",
  };
}
