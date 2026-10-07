import { createHash } from "node:crypto";

export interface LegacySheetResolvedIdentity {
  channelId?: unknown;
  channelIdVerified?: unknown;
  creatorId?: unknown;
  email?: unknown;
  identityConflict?: unknown;
  classification?: unknown;
  testData?: unknown;
}

export interface LegacySheetContentRow {
  sourceRowNumber: number;
  email?: unknown;
  youtubeUrl?: unknown;
  youtube_url?: unknown;
  submittedAt?: unknown;
  summited_at?: unknown;
  status?: unknown;
  rawStatus?: unknown;
  youtubePublishedAt?: unknown;
  resolvedIdentity?: LegacySheetResolvedIdentity | null;
  testData?: unknown;
  [key: string]: unknown;
}

export interface PlanLegacySheetContentMigrationInput {
  rows: LegacySheetContentRow[];
  importedAt: string;
}

export type LegacyDecisionStatus = "approved" | "rejected";
export type LegacyIdentityResolutionSource =
  | "verified_youtube_channel_id"
  | "creator_id"
  | "normalized_email"
  | "identity_conflict"
  | "unclassified";
export type LegacyMediaClassification = "valid_youtube_video" | "invalid_media";
export type LegacyIdentityClassification = "resolved" | "identity_conflict" | "unclassified";
export type LegacyMigrationExclusionReason =
  | "invalid_media"
  | "identity_conflict"
  | "identity_unclassified"
  | "test_data";

export interface LegacySheetMigrationAttempt {
  sourceRowNumber: number;
  sourceRow: Readonly<Record<string, unknown>>;
  rawStatus: string;
  decisionStatus: LegacyDecisionStatus;
  youtubeVideoId: string | null;
  canonicalYoutubeUrl: string | null;
  canonicalMediaKey: string | null;
  videoRevision: number | null;
  youtubePublishedAt: string | null;
  legacyFormSubmittedAt: string | null;
  importedAt: string;
  identityKey: string | null;
  identityResolutionSource: LegacyIdentityResolutionSource;
  identityClassification: LegacyIdentityClassification;
  mediaClassification: LegacyMediaClassification;
  testData: boolean;
  exclusionReasons: LegacyMigrationExclusionReason[];
  isCurrent: boolean;
  decisionImportEligible: boolean;
  transitionEligible: boolean;
  decisionRef: string;
}

export interface LegacySheetContentMigrationCounts {
  totalAttempts: number;
  approvedAttempts: number;
  rejectedAttempts: number;
  pendingAttempts: number;
  validMediaAttempts: number;
  invalidMediaAttempts: number;
  uniqueCanonicalVideos: number;
  duplicateVideoGroups: number;
  currentAttempts: number;
  currentApprovedAttempts: number;
  currentRejectedAttempts: number;
  currentPendingAttempts: number;
  decisionImportEligibleAttempts: number;
  transitionEligibleAttempts: number;
  identityConflictAttempts: number;
  unclassifiedIdentityAttempts: number;
  testDataAttempts: number;
}

export interface LegacySheetContentMigrationPlan {
  manifestId: string;
  counts: LegacySheetContentMigrationCounts;
  attempts: LegacySheetMigrationAttempt[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rawText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function iso(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const koreanSheetDate = raw.match(
    /^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(오전|오후)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (koreanSheetDate) {
    const [, yearRaw, monthRaw, dayRaw, meridiem, hourRaw, minuteRaw, secondRaw = "0"] = koreanSheetDate;
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    const twelveHour = Number(hourRaw);
    const minute = Number(minuteRaw);
    const second = Number(secondRaw);
    if (
      month >= 1 && month <= 12
      && day >= 1 && day <= 31
      && twelveHour >= 1 && twelveHour <= 12
      && minute >= 0 && minute <= 59
      && second >= 0 && second <= 59
    ) {
      const hour = (twelveHour % 12) + (meridiem === "오후" ? 12 : 0);
      const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - 9 * 60 * 60 * 1_000;
      const kstCheck = new Date(utcMillis + 9 * 60 * 60 * 1_000);
      if (
        kstCheck.getUTCFullYear() === year
        && kstCheck.getUTCMonth() === month - 1
        && kstCheck.getUTCDate() === day
        && kstCheck.getUTCHours() === hour
      ) {
        return new Date(utcMillis).toISOString();
      }
    }
    return null;
  }
  const millis = Date.parse(raw);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function youtubeVideoId(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let candidate = "";
    if (host === "youtu.be") {
      candidate = url.pathname.split("/").filter(Boolean)[0] ?? "";
    } else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (url.pathname === "/watch") candidate = url.searchParams.get("v") ?? "";
      else {
        const parts = url.pathname.split("/").filter(Boolean);
        if (["shorts", "embed", "live"].includes(parts[0] ?? "")) candidate = parts[1] ?? "";
      }
    }
    return /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function resolveIdentity(row: LegacySheetContentRow): {
  identityKey: string | null;
  identityResolutionSource: LegacyIdentityResolutionSource;
  identityClassification: LegacyIdentityClassification;
} {
  const identity = row.resolvedIdentity ?? {};
  const declaredClassification = text(identity.classification).toLowerCase();
  if (identity.identityConflict === true || ["identity_conflict", "conflict"].includes(declaredClassification)) {
    return {
      identityKey: null,
      identityResolutionSource: "identity_conflict",
      identityClassification: "identity_conflict",
    };
  }
  if (declaredClassification === "unclassified") {
    return {
      identityKey: null,
      identityResolutionSource: "unclassified",
      identityClassification: "unclassified",
    };
  }
  const channelId = text(identity.channelId);
  if (identity.channelIdVerified === true && channelId) {
    return {
      identityKey: `youtube_channel:${channelId}`,
      identityResolutionSource: "verified_youtube_channel_id",
      identityClassification: "resolved",
    };
  }
  const creatorId = text(identity.creatorId);
  if (creatorId) {
    return {
      identityKey: `creator:${creatorId}`,
      identityResolutionSource: "creator_id",
      identityClassification: "resolved",
    };
  }
  const email = text(identity.email || row.email).toLowerCase();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return {
      identityKey: `email:${email}`,
      identityResolutionSource: "normalized_email",
      identityClassification: "resolved",
    };
  }
  return {
    identityKey: null,
    identityResolutionSource: "unclassified",
    identityClassification: "unclassified",
  };
}

function stableDecisionRef(input: {
  sourceRowNumber: number;
  decisionStatus: LegacyDecisionStatus;
  youtubeVideoId: string | null;
  legacyFormSubmittedAt: string | null;
  identityKey: string | null;
  identityClassification: LegacyIdentityClassification;
  testData: boolean;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 20);
  return `legacy_sheet_content:r${input.sourceRowNumber}:${digest}`;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function hash24(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 24);
}

function migrationSourceRow(row: LegacySheetContentRow): Readonly<Record<string, unknown>> {
  const {
    // Reader observation time is not part of the A:L source contract and used
    // to be populated from wall-clock time. Never persist or hash it as source
    // evidence, otherwise an unchanged Sheet forks the manifest.
    updatedAtIso: _updatedAtIso,
    ...sourceRow
  } = row;
  return sourceRow;
}

export function planLegacySheetContentMigration(
  input: PlanLegacySheetContentMigrationInput,
): LegacySheetContentMigrationPlan {
  const attempts = input.rows.map((row) => {
    const rawStatus = rawText(row.rawStatus ?? row.status);
    const normalizedStatus = rawStatus.trim().toLowerCase();
    const decisionStatus: LegacyDecisionStatus =
      normalizedStatus === "approval" ? "approved" : "rejected";
    const videoId = youtubeVideoId(row.youtubeUrl ?? row.youtube_url);
    const legacyFormSubmittedAt = iso(row.submittedAt ?? row.summited_at);
    const identity = resolveIdentity(row);
    const testData = row.testData === true || row.resolvedIdentity?.testData === true;
    const exclusionReasons: LegacyMigrationExclusionReason[] = [];
    if (!videoId) exclusionReasons.push("invalid_media");
    if (identity.identityClassification === "identity_conflict") exclusionReasons.push("identity_conflict");
    if (identity.identityClassification === "unclassified") exclusionReasons.push("identity_unclassified");
    if (testData) exclusionReasons.push("test_data");
    return {
      sourceRowNumber: row.sourceRowNumber,
      sourceRow: migrationSourceRow(row),
      rawStatus,
      decisionStatus,
      youtubeVideoId: videoId,
      canonicalYoutubeUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
      canonicalMediaKey: videoId ? `youtube:${videoId}` : null,
      videoRevision: null,
      youtubePublishedAt: iso(row.youtubePublishedAt),
      legacyFormSubmittedAt,
      importedAt: iso(input.importedAt) ?? input.importedAt,
      ...identity,
      mediaClassification: videoId ? "valid_youtube_video" as const : "invalid_media" as const,
      testData,
      exclusionReasons,
      isCurrent: false,
      decisionImportEligible: false,
      transitionEligible: false,
      decisionRef: stableDecisionRef({
        sourceRowNumber: row.sourceRowNumber,
        decisionStatus,
        youtubeVideoId: videoId,
        legacyFormSubmittedAt,
        identityKey: identity.identityKey,
        identityClassification: identity.identityClassification,
        testData,
      }),
    };
  }).sort((left, right) => left.sourceRowNumber - right.sourceRowNumber);

  const attemptsByVideoId = new Map<string, LegacySheetMigrationAttempt[]>();
  for (const attempt of attempts) {
    if (!attempt.youtubeVideoId) continue;
    const group = attemptsByVideoId.get(attempt.youtubeVideoId) ?? [];
    group.push(attempt);
    attemptsByVideoId.set(attempt.youtubeVideoId, group);
  }
  for (const group of attemptsByVideoId.values()) {
    group.sort((left, right) => {
      const submittedOrder = (left.legacyFormSubmittedAt ?? "").localeCompare(right.legacyFormSubmittedAt ?? "");
      return submittedOrder || left.sourceRowNumber - right.sourceRowNumber;
    });
    group.forEach((attempt, index) => {
      attempt.videoRevision = index + 1;
    });
    const current = group[group.length - 1];
    current.isCurrent = true;
    current.decisionImportEligible = current.exclusionReasons.length === 0;
    current.transitionEligible =
      current.decisionImportEligible &&
      current.decisionStatus === "approved";
  }

  const groupSizes = new Map<string, number>();
  for (const attempt of attempts) {
    if (!attempt.youtubeVideoId) continue;
    groupSizes.set(attempt.youtubeVideoId, (groupSizes.get(attempt.youtubeVideoId) ?? 0) + 1);
  }
  const counts: LegacySheetContentMigrationCounts = {
    totalAttempts: attempts.length,
    approvedAttempts: attempts.filter((attempt) => attempt.decisionStatus === "approved").length,
    rejectedAttempts: attempts.filter((attempt) => attempt.decisionStatus === "rejected").length,
    pendingAttempts: 0,
    validMediaAttempts: attempts.filter((attempt) => attempt.mediaClassification === "valid_youtube_video").length,
    invalidMediaAttempts: attempts.filter((attempt) => attempt.mediaClassification === "invalid_media").length,
    uniqueCanonicalVideos: groupSizes.size,
    duplicateVideoGroups: [...groupSizes.values()].filter((size) => size > 1).length,
    currentAttempts: attempts.filter((attempt) => attempt.isCurrent).length,
    currentApprovedAttempts: attempts.filter((attempt) => attempt.isCurrent && attempt.decisionStatus === "approved").length,
    currentRejectedAttempts: attempts.filter((attempt) => attempt.isCurrent && attempt.decisionStatus === "rejected").length,
    currentPendingAttempts: 0,
    decisionImportEligibleAttempts: attempts.filter((attempt) => attempt.decisionImportEligible).length,
    transitionEligibleAttempts: attempts.filter((attempt) => attempt.transitionEligible).length,
    identityConflictAttempts: attempts.filter((attempt) => attempt.identityClassification === "identity_conflict").length,
    unclassifiedIdentityAttempts: attempts.filter((attempt) => attempt.identityClassification === "unclassified").length,
    testDataAttempts: attempts.filter((attempt) => attempt.testData).length,
  };
  const manifestId = `legacy_sheet_content_manifest:${hash24(attempts.map((attempt) => ({
    sourceRowNumber: attempt.sourceRowNumber,
    sourceRow: attempt.sourceRow,
    decisionRef: attempt.decisionRef,
    youtubeVideoId: attempt.youtubeVideoId,
    videoRevision: attempt.videoRevision,
    identityKey: attempt.identityKey,
    isCurrent: attempt.isCurrent,
    decisionImportEligible: attempt.decisionImportEligible,
    transitionEligible: attempt.transitionEligible,
  })))}`;
  return { manifestId, counts, attempts };
}
