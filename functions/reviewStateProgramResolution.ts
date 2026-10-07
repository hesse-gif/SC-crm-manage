// Resolves the REAL program attribution for a `scp_video_review_state` row when its
// `canonicalProgramId` only carries the Portal's global apply-gate tag (or is empty).
//
// WHY THIS EXISTS (prod deep-check 2026-09-05): the Portal signs every application-derived
// event with ONE shared programId — `scpPortalApplyBindingAuthority.ts`'s `PORTAL_PROGRAM_ID`
// ("view-cpm"), the Portal-wide apply-gate scope, never a real program. That tag was being
// written straight into `canonicalProgramId` (functions/scpIntegrationEventV2.ts,
// functions/scpVideoRevisionIngress.ts), and prod measured 229/231 `scp_video_review_state`
// rows carrying it — invisible to every program-scoped read (review-tab filter's list query,
// the program funnel's "승인" KPI). This module is the single place that decides how a
// portal-alias-tagged row's real program gets recovered, so the write path (stamping) and the
// read paths (review-tab filter, funnel KPI) and the backfill script all agree.
//
// Resolution order (first hit wins):
//   1. `canonicalProgramId` is already non-empty and not a Portal alias -> trust it as-is.
//   2. `subject.applicationId` -> `scp_application_management/{applicationId}.currentProgramId`
//      (confirmed live join, 2026-09-05 deep-check: found all 35 of CPM's real rows hidden
//      under the alias, zero false positives against a 75-application scope).
//   3. `subject.programId` itself, when it is NOT a Portal alias (rare non-portal-origin rows).
//   4. `subject.campaignId` -> a campaign's own `programId` (secondary; caller-supplied lookup).
// Anything left over stays unresolved: the raw value is preserved (never invented), and
// `programUnresolved: true` tells the caller this row could not be scoped to a real program.
//
// The Portal alias set lives in exactly one place: `scpPortalApplyBindingAuthority.ts`'s
// `PORTAL_PROGRAM_ID`. This module imports it rather than re-declaring the literal, per that
// module's own header ("other engines... reuse the exact literal instead of re-declaring it").

import { adminDb } from "./firebaseAdmin";
import { resolveCanonicalProgramId } from "./programCanonical";
import { PORTAL_PROGRAM_ID } from "./scpPortalApplyBindingAuthority";
import { SCP_APPLICATION_MANAGEMENT_COLLECTION } from "./applicationManagementStore";

/** Portal-issued ids that are apply-gate scope tags, never a real program. Single source. */
export const REVIEW_STATE_PORTAL_PROGRAM_ALIAS_IDS = [PORTAL_PROGRAM_ID] as const;

const PORTAL_ALIAS_SET = new Set<string>(REVIEW_STATE_PORTAL_PROGRAM_ALIAS_IDS);

/** True when `value` is a Portal apply-gate scope tag (e.g. "view-cpm"), never a real program id. */
export function isReviewStatePortalAliasProgramId(value: unknown): boolean {
  return typeof value === "string" && PORTAL_ALIAS_SET.has(value.trim());
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type ReviewStateProgramResolutionSubject = {
  applicationId?: unknown;
  programId?: unknown;
  campaignId?: unknown;
};

/** The minimal row shape this resolver needs — a live Firestore doc or a plan/fixture object. */
export type ReviewStateRowLike = {
  canonicalProgramId?: unknown;
  subject?: ReviewStateProgramResolutionSubject;
};

export type ReviewStateProgramResolutionSource =
  | "canonicalProgramId"
  | "applicationManagement"
  | "subjectProgramId"
  | "campaign"
  | "unresolved";

export type ReviewStateProgramResolution = {
  /** Best-known program attribution, alias-normalized. Equal to the raw value when unresolved. */
  programId: string;
  /** The raw Portal apply-gate tag this row carried, or null when none was ever seen. */
  portalProgramId: string | null;
  source: ReviewStateProgramResolutionSource;
  /** True when no real program could be recovered — `programId` is the preserved raw value. */
  programUnresolved: boolean;
};

export type ReviewStateProgramResolutionDeps = {
  /** Single-application lookup. Batch/memoize via `createApplicationProgramIdLookup` below. */
  getApplicationCurrentProgramId(applicationId: string): Promise<string | null>;
  /** Optional secondary source; omit when the caller has no campaign->program index. */
  getCampaignProgramId?(campaignId: string): Promise<string | null>;
};

export async function resolveReviewStateProgramId(
  row: ReviewStateRowLike,
  deps: ReviewStateProgramResolutionDeps,
): Promise<ReviewStateProgramResolution> {
  const rawCanonical = text(row?.canonicalProgramId);
  const subject = row?.subject ?? {};
  const applicationId = text(subject.applicationId);
  const subjectProgramId = text(subject.programId);
  const campaignId = text(subject.campaignId);

  if (rawCanonical && !isReviewStatePortalAliasProgramId(rawCanonical)) {
    return {
      programId: resolveCanonicalProgramId(rawCanonical),
      portalProgramId: null,
      source: "canonicalProgramId",
      programUnresolved: false,
    };
  }

  // The tag this row is actually hiding behind, if any — kept for audit even once resolved.
  const portalProgramId = rawCanonical
    || (isReviewStatePortalAliasProgramId(subjectProgramId) ? subjectProgramId : null);

  if (applicationId) {
    const applicationProgramId = text(await deps.getApplicationCurrentProgramId(applicationId));
    if (applicationProgramId && !isReviewStatePortalAliasProgramId(applicationProgramId)) {
      return {
        programId: resolveCanonicalProgramId(applicationProgramId),
        portalProgramId,
        source: "applicationManagement",
        programUnresolved: false,
      };
    }
  }

  if (subjectProgramId && !isReviewStatePortalAliasProgramId(subjectProgramId)) {
    return {
      programId: resolveCanonicalProgramId(subjectProgramId),
      portalProgramId,
      source: "subjectProgramId",
      programUnresolved: false,
    };
  }

  if (campaignId && deps.getCampaignProgramId) {
    const campaignProgramId = text(await deps.getCampaignProgramId(campaignId));
    if (campaignProgramId && !isReviewStatePortalAliasProgramId(campaignProgramId)) {
      return {
        programId: resolveCanonicalProgramId(campaignProgramId),
        portalProgramId,
        source: "campaign",
        programUnresolved: false,
      };
    }
  }

  return {
    // Never invent an attribution: keep whatever raw signal existed (canonicalProgramId first,
    // else the subject's own programId), so an unresolved row is still discoverable by its tag.
    programId: rawCanonical || subjectProgramId || "",
    portalProgramId,
    source: "unresolved",
    programUnresolved: true,
  };
}

/**
 * Batched + per-instance-cached `scp_application_management` reader.
 *
 * `prime()` resolves a whole page/request's worth of applicationIds in one `getAll()` round
 * trip; `getApplicationCurrentProgramId` (the `ReviewStateProgramResolutionDeps` member) then
 * serves every `resolveReviewStateProgramId` call for this request from that cache — a page of
 * 50 review-state rows costs at most one Firestore round trip for this join, not one per row.
 * Safe to use without calling `prime()` first: an uncached id falls back to a single `get()`
 * (de-duplicated against concurrent callers for the same id via `inflight`).
 */
export function createApplicationProgramIdLookup(
  db: FirebaseFirestore.Firestore = adminDb,
): {
  prime(applicationIds: Iterable<unknown>): Promise<void>;
  getApplicationCurrentProgramId(applicationId: string): Promise<string | null>;
} {
  const cache = new Map<string, string | null>();
  const inflight = new Map<string, Promise<string | null>>();

  function extractCurrentProgramId(snapshot: FirebaseFirestore.DocumentSnapshot): string | null {
    const data = snapshot.exists ? snapshot.data() : undefined;
    const value = text(data?.currentProgramId);
    return value || null;
  }

  return {
    async prime(applicationIds) {
      const ids = Array.from(new Set(Array.from(applicationIds).map(text).filter(Boolean)))
        .filter((id) => !cache.has(id));
      if (ids.length === 0) return;
      const refs = ids.map((id) => db.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).doc(id));
      const snapshots = await db.getAll(...refs);
      snapshots.forEach((snapshot, index) => cache.set(ids[index], extractCurrentProgramId(snapshot)));
    },
    async getApplicationCurrentProgramId(applicationId) {
      const id = text(applicationId);
      if (!id) return null;
      if (cache.has(id)) return cache.get(id) ?? null;
      const existing = inflight.get(id);
      if (existing) return existing;
      const pending = db.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).doc(id).get()
        .then((snapshot) => {
          const value = extractCurrentProgramId(snapshot);
          cache.set(id, value);
          return value;
        })
        .finally(() => inflight.delete(id));
      inflight.set(id, pending);
      return pending;
    },
  };
}

/** Convenience factory for a single-row resolution against live Firestore (no batching). */
export function defaultReviewStateProgramResolutionDeps(
  db: FirebaseFirestore.Firestore = adminDb,
): ReviewStateProgramResolutionDeps {
  return createApplicationProgramIdLookup(db);
}
