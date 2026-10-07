import { createHash } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import {
  reviewedSheetSourceProfiles,
  type SheetSourceKey,
} from "./sheetIntakeRuntime";
import type { SheetCutoverState } from "./sheetIntakeTypes";
import { SCP_SHEET_PUBLIC_PROJECTION_SCHEMA_VERSION } from "./scpSheetPublicProjection";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  makeBehaviorLog,
  type CallableRequestShape,
} from "./shared";

const READ_ROLES = ["super_admin", "admin", "manager"] as const;

export type SheetOperationalEngine =
  | "generic_intake"
  | "participant_roster"
  | "video_submission_bridge";

export type SheetOperationalControlPlane = "generic" | "dedicated";

export interface PublicSheetOperationCapability {
  supported: boolean;
  engine: SheetOperationalEngine;
  controlPlane: SheetOperationalControlPlane;
  genericCallableSupported: boolean;
  requiresPreview: true;
  reason: string | null;
}

export interface PublicSheetSourceOperations {
  manualSync: PublicSheetOperationCapability & {
    schedulerManaged: boolean;
  };
  reconciliation: PublicSheetOperationCapability;
  cutover: PublicSheetOperationCapability & {
    allowedTargetStates: SheetCutoverState[];
  };
}

export interface PublicSheetIntakeSourceStatus {
  key: Exclude<SheetSourceKey, "staging_fixture">;
  displayName: string;
  domain: "scp_apply" | "participant_selection" | "participant_registry" | "content_review";
  projectionStrategy: "applicant_projection" | "participant_registry_projection" | "video_submission_bridge";
  syncSupported: boolean;
  operations: PublicSheetSourceOperations;
  sourceReady: boolean;
  sourceVersion: number;
  reconciliationVersion: number;
  projectionRevision: number;
  lastSyncStatus: string | null;
  lastSyncAtIso: string | null;
  publicProjection: {
    datasetKey: "scpQualificationRows" | "scpVideoRows" | null;
    ready: boolean;
    generation: number;
    rowCount: number;
    completedAtIso: string | null;
  };
  cutover: {
    state: SheetCutoverState;
    version: number;
    ownerHash: string | null;
    enteredAtIso: string | null;
    updatedAtIso: string | null;
    targetExitAt: string | null;
    rollbackCheckpoint: SheetCutoverState | null;
    lastRollbackAtIso: string | null;
  };
}

export async function getGoogleSheetIntakeStatus(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(
    request,
    "sheet_intake.status",
    READ_ROLES,
  );
  const profiles = reviewedSheetSourceProfiles().filter(
    (profile): profile is typeof profile & { key: Exclude<SheetSourceKey, "staging_fixture"> } =>
      profile.key !== "staging_fixture",
  );
  const snapshots = await Promise.all(
    profiles.map((profile) => adminDb.collection("intake_sources").doc(profile.sourceId).get()),
  );
  const sources: PublicSheetIntakeSourceStatus[] = profiles.map((profile, index) => {
    const snapshot = snapshots[index];
    const source = asRecord(snapshot.data());
    const cutover = asRecord(source.cutover);
    const datasetKey = profile.key === "participant_selection"
      ? "scpQualificationRows" as const
      : profile.key === "content_review"
        ? "scpVideoRows" as const
        : null;
    const projection = datasetKey
      ? asRecord(asRecord(source.publicProjections)[datasetKey])
      : {};
    const sourceVersion = safeInteger(source.sourceVersion);
    const projectionRevision = safeInteger(source.projectionRevision);
    const cutoverVersion = safeInteger(cutover.version);
    const projectionReady = datasetKey
      ? publicProjectionReady({
          datasetKey,
          sourceId: profile.sourceId,
          sourceVersion,
          cutoverVersion,
          projectionRevision,
          projection,
        })
      : false;
    return {
      key: profile.key,
      displayName: profile.displayName,
      domain: profile.domain as PublicSheetIntakeSourceStatus["domain"],
      projectionStrategy: profile.projectionStrategy,
      syncSupported: profile.syncSupported,
      operations: sheetSourceOperationalCapabilities(profile.key),
      sourceReady: snapshot.exists,
      sourceVersion,
      reconciliationVersion: safeInteger(source.reconciliationVersion),
      projectionRevision,
      lastSyncStatus: optionalString(source.lastSyncStatus),
      lastSyncAtIso: optionalIso(source.lastSyncAtIso),
      publicProjection: {
        datasetKey,
        ready: projectionReady,
        generation: projectionReady ? safeInteger(projection.generation) : 0,
        rowCount: projectionReady ? safeInteger(projection.rowCount) : 0,
        completedAtIso: projectionReady ? optionalIso(projection.completedAtIso) : null,
      },
      cutover: {
        state: cutoverState(cutover.state),
        version: cutoverVersion,
        ownerHash: maskedOwner(cutover.owner),
        enteredAtIso: optionalIso(cutover.enteredAtIso),
        updatedAtIso: optionalIso(cutover.updatedAtIso),
        targetExitAt: optionalIso(cutover.targetExitAt),
        rollbackCheckpoint: optionalCutoverState(cutover.rollbackCheckpoint),
        lastRollbackAtIso: optionalIso(cutover.lastRollbackAtIso),
      },
    };
  });

  return {
    ok: true,
    topologyVersion: "scp-sheet-topology-v4-202607",
    sourceCount: sources.length,
    sources,
    behaviorLog: makeBehaviorLog(auth, "sheet_intake.status", "success", "scp-automation"),
  };
}

export function publicProjectionReady(input: {
  datasetKey: "scpQualificationRows" | "scpVideoRows";
  sourceId: string;
  sourceVersion: number;
  cutoverVersion: number;
  projectionRevision: number;
  projection: Record<string, unknown>;
}): boolean {
  const completedAtIso = asString(input.projection.completedAtIso);
  const sourceVersion = input.projection.sourceVersion;
  const cutoverVersion = input.projection.cutoverVersion;
  const projectionRevision = input.projection.projectionRevision;
  return input.projection.schemaVersion === SCP_SHEET_PUBLIC_PROJECTION_SCHEMA_VERSION &&
    input.projection.datasetKey === input.datasetKey &&
    input.projection.sourceId === input.sourceId &&
    safeInteger(input.projection.generation) > 0 &&
    safeInteger(input.projection.rowCount) > 0 &&
    /^[a-f0-9]{64}$/.test(asString(input.projection.canonicalFingerprint)) &&
    Number.isFinite(Date.parse(completedAtIso)) &&
    isNonNegativeInteger(sourceVersion) && sourceVersion === input.sourceVersion &&
    isNonNegativeInteger(cutoverVersion) && cutoverVersion === input.cutoverVersion &&
    isNonNegativeInteger(projectionRevision) && projectionRevision === input.projectionRevision;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function sheetSourceOperationalCapabilities(
  sourceKey: Exclude<SheetSourceKey, "staging_fixture">,
): PublicSheetSourceOperations {
  const generic = (
    engine: SheetOperationalEngine,
    reason: string | null = null,
  ): PublicSheetOperationCapability => ({
    supported: true,
    engine,
    controlPlane: "generic",
    genericCallableSupported: true,
    requiresPreview: true,
    reason,
  });
  const dedicated = (
    engine: SheetOperationalEngine,
    reason: string,
  ): PublicSheetOperationCapability => ({
    supported: true,
    engine,
    controlPlane: "dedicated",
    genericCallableSupported: false,
    requiresPreview: true,
    reason,
  });
  // W9-6 수리 순서 1: content_review(Sheet3) 신규 유입 차단 — 운영 registry에서 내린 소스는
  // 어떤 제어면(수동 동기화·재조정·컷오버)에서도 지원되지 않는다고 정직하게 보고한다.
  const decommissioned = (
    engine: SheetOperationalEngine,
    reason: string,
  ): PublicSheetOperationCapability => ({
    supported: false,
    engine,
    controlPlane: "dedicated",
    genericCallableSupported: false,
    requiresPreview: true,
    reason,
  });

  switch (sourceKey) {
    case "scp_apply": {
      const primaryConsumerReason =
        "The SCP_APPLY source has no proven primary read consumer; only shadow and dual-read controls are available.";
      return {
        manualSync: {
          ...generic("generic_intake"),
          schedulerManaged: false,
        },
        reconciliation: generic("generic_intake"),
        cutover: {
          ...generic("generic_intake", primaryConsumerReason),
          allowedTargetStates: ["shadow", "dual_read"],
        },
      };
    }
    case "participant_selection":
      return {
        manualSync: {
          ...generic("generic_intake"),
          schedulerManaged: false,
        },
        reconciliation: generic("generic_intake"),
        cutover: {
          ...generic("generic_intake"),
          allowedTargetStates: allCutoverStates(),
        },
      };
    case "participant_registry": {
      const dedicatedRosterReason =
        "Parity and cutover are owned by the dedicated participant roster engine; the generic control callable is disabled.";
      return {
        manualSync: {
          ...dedicated("participant_roster", dedicatedRosterReason),
          schedulerManaged: false,
        },
        reconciliation: dedicated("participant_roster", dedicatedRosterReason),
        cutover: {
          ...dedicated("participant_roster", dedicatedRosterReason),
          allowedTargetStates: allCutoverStates(),
        },
      };
    }
    case "content_review": {
      const decommissionedReason =
        "The Sheet3 content_review source is decommissioned; Portal video submission review (scp.video-submission-review.v3) is the canonical intake and no new reads or writes are permitted.";
      return {
        manualSync: {
          ...decommissioned("video_submission_bridge", decommissionedReason),
          schedulerManaged: false,
        },
        reconciliation: decommissioned("video_submission_bridge", decommissionedReason),
        cutover: {
          ...decommissioned("video_submission_bridge", decommissionedReason),
          allowedTargetStates: [],
        },
      };
    }
  }
}

function allCutoverStates(): SheetCutoverState[] {
  return ["shadow", "dual_read", "primary", "rollbackable_primary", "retired"];
}

function safeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function optionalString(value: unknown): string | null {
  const normalized = asString(value).trim();
  return normalized ? normalized.slice(0, 80) : null;
}

function optionalIso(value: unknown): string | null {
  const normalized = asString(value).trim();
  if (!normalized || !Number.isFinite(Date.parse(normalized))) return null;
  return new Date(normalized).toISOString();
}

function cutoverState(value: unknown): SheetCutoverState {
  return optionalCutoverState(value) ?? "shadow";
}

function optionalCutoverState(value: unknown): SheetCutoverState | null {
  return value === "shadow" || value === "dual_read" || value === "primary" ||
    value === "rollbackable_primary" || value === "retired"
    ? value
    : null;
}

function maskedOwner(value: unknown): string | null {
  const owner = asString(value).trim();
  return owner
    ? `operator_${createHash("sha256").update(owner).digest("hex").slice(0, 12)}`
    : null;
}
