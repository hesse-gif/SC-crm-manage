export const SCP_RESULT_PROVIDER_SOURCE = "smtp-live-callable";
export const SCP_RESULT_PROVIDER_VERIFIED_MIGRATION_MARKER =
  "scp_provider_delivery_verified_migration_v1";

export type ScpProviderEvidenceShape = "result" | "outbound";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Fail-closed provider-delivery truth shared by Functions guards and the review UI.
 *
 * A stored result needs its explicit delivery-truth bit plus complete, persisted SMTP
 * evidence. Historical rows may bypass only the evidence tuple with the exact verified
 * migration marker; status/delivery state/provider IDs never establish truth by themselves.
 */
export function isStrictScpProviderConfirmed(
  value: unknown,
  shape: ScpProviderEvidenceShape = "result",
): boolean {
  const row = asRecord(value);
  const evidence = shape === "result" ? asRecord(row.sendResult) : row;
  const deliveryTruth =
    shape === "result" ? asRecord(row.deliveryTruth) : row;
  const terminalState =
    shape === "result" ? asText(row.status) : asText(row.deliveryState);

  if (terminalState.toLowerCase() !== "sent") return false;
  if (deliveryTruth.providerConfirmed !== true) return false;

  if (
    asText(deliveryTruth.verificationMarker) ===
    SCP_RESULT_PROVIDER_VERIFIED_MIGRATION_MARKER
  ) {
    return true;
  }

  const acceptedCount = Number(evidence.acceptedCount ?? 0);
  const providerEvidence = asText(evidence.providerMessageIdHash);
  const deliverySource =
    shape === "outbound"
      ? asText(evidence.deliverySource) || asText(evidence.source)
      : asText(evidence.source);

  return (
    asText(evidence.deliveryState).toLowerCase() === "sent" &&
    deliverySource === SCP_RESULT_PROVIDER_SOURCE &&
    providerEvidence.length > 0 &&
    Number.isFinite(acceptedCount) &&
    acceptedCount > 0 &&
    evidence.persisted === true
  );
}
