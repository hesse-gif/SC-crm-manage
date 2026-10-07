// Content-submission eligibility evaluator (spec C / frozen §5). Composes the pure
// contentSubmissionEligibilityCore with the F2 application-management record (managed enrollment)
// and the caller-supplied grant/country/binding conditions. Fail-closed: any missing condition blocks.
// UID verification + YouTube OAuth are NEVER inputs here (§5.2). Eligibility NEVER implies approval (§5.3).

import { adminDb } from "./firebaseAdmin";
import { SCP_APPLICATION_MANAGEMENT_COLLECTION } from "./applicationManagementStore";
import {
  contentSubmissionEligibility,
  type ContentSubmissionEligibilityResult,
} from "./contentSubmissionEligibilityCore";

export const CONTENT_ELIGIBILITY_STORE_VERSION = "content_eligibility_store_v2" as const;

function storeDocId(applicationId: string): string {
  const safe = String(applicationId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
  if (!safe) throw new Error("invalid-argument: applicationId is required");
  return safe;
}

export type ContentGrantInput = {
  signed: boolean;
  unexpired: boolean;
  unrevoked: boolean;
};

export type EvaluateContentEligibilityInput = {
  applicationId: string;
  // Flu-side/portal-side conditions that are not yet on the application-management record. Absent =>
  // fail-closed (blocked). The Portal-signed content grant is provided by the caller (never invented).
  contentGrant?: ContentGrantInput | null;
  declaredPrimaryAudienceCountry?: string | null;
  bindingAcknowledged?: boolean;
};

export type EvaluateContentEligibilityResult = ContentSubmissionEligibilityResult & {
  applicationId: string;
  managedRecordFound: boolean;
};

export async function evaluateContentSubmissionEligibility(
  input: EvaluateContentEligibilityInput,
): Promise<EvaluateContentEligibilityResult> {
  const snap = await adminDb.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).doc(storeDocId(input.applicationId)).get();
  const record = snap.exists ? (snap.data() ?? {}) : null;
  const managed = record?.classification === "managed";
  const applicationStatus = typeof record?.applicationStatus === "string" ? record.applicationStatus : "submitted";
  const grant = input.contentGrant ?? null;

  const conditions = {
    // C.4: application not rejected/withdrawn (record must exist and not be in a terminal-negative state).
    applicationNotRejectedOrWithdrawn: Boolean(record) && applicationStatus !== "rejected" && applicationStatus !== "withdrawn",
    // §5.1(a): managed active program enrollment (operator-assigned/auto-managed).
    managedActiveProgramEnrollment: managed,
    // §5.1(b): stable application/creator binding acknowledged by Flu (managed + an explicit ack).
    stableApplicationCreatorBinding: managed && input.bindingAcknowledged === true,
    // §5.1(c): Portal-issued signed, unexpired, unrevoked content grant.
    signedUnexpiredUnrevokedContentGrant: Boolean(grant && grant.signed && grant.unexpired && grant.unrevoked),
    // §5.1(d): versioned declaredPrimaryAudienceCountry present.
    declaredPrimaryAudienceCountryPresent:
      typeof input.declaredPrimaryAudienceCountry === "string" && input.declaredPrimaryAudienceCountry.length > 0,
  };

  return {
    applicationId: input.applicationId,
    managedRecordFound: Boolean(record),
    ...contentSubmissionEligibility(conditions),
  };
}
