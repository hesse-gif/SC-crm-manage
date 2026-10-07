// Manager-gated read of §6 duplicate detection for a single submission (operational UI + manual
// reviewer explanation). Composes the bounded duplicateDetectionStore — NEVER an all-pairs scan.
// RBAC manager+ enforced server-side. No raw PII in/out (opaque submission ids + derived signals only).

import {
  asRecord,
  asString,
  assertNonGuestAuth,
  makeBehaviorLog,
  type CallableRequestShape,
  type Role,
} from "./shared";
import { evaluateDuplicateForSubmission } from "./duplicateDetectionStore";
import { assertScpEntitled } from "./mailAccounts";

const OPERATOR_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin", "manager"];

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

function optionalPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

export async function evaluateVideoDuplicateHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "video_duplicate.evaluate", OPERATOR_ROLES);
  // 2026-09-27 codex adversarial review round 2 sweep: scp video submission duplicate-detection
  // read — no general-purpose UI reaches it.
  await assertScpEntitled(auth, request, "video_duplicate.evaluate");
  const data = asRecord(request.data);
  const videoSubmissionId = asString(data.videoSubmissionId);
  if (!videoSubmissionId) throw invalidArgument("videoSubmissionId is required");
  const threshold = typeof data.threshold === "number" && Number.isFinite(data.threshold) ? data.threshold : undefined;
  try {
    const result = await evaluateDuplicateForSubmission(
      videoSubmissionId,
      {
        candidateLimitPerQuery: optionalPositiveInt(data.candidateLimitPerQuery),
        topK: optionalPositiveInt(data.topK),
        threshold,
      },
      new Date(),
    );
    return { ...result, behaviorLog: makeBehaviorLog(auth, "video_duplicate.evaluate", "success") };
  } catch (error) {
    // Fail-closed diagnosable: a missing/stale query fingerprint must NOT collapse to permission-denied.
    const message = String((error as { message?: string })?.message ?? "");
    if (message.startsWith("not_found")) {
      throw Object.assign(new Error("failed-precondition: video_duplicate_fingerprint_absent"), {
        code: "failed-precondition",
        errorCode: "video_duplicate_fingerprint_absent",
      });
    }
    if (message.startsWith("failed-precondition")) {
      throw Object.assign(new Error("failed-precondition: video_duplicate_fingerprint_stale"), {
        code: "failed-precondition",
        errorCode: "video_duplicate_fingerprint_stale",
      });
    }
    throw error;
  }
}
