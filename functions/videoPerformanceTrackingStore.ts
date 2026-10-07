// GAP-B store layer for the descriptive video-tracking projection
// (see ./videoPerformanceTrackingProjection.ts for the pure core + rationale).
//
// This is the ONLY file in the descriptive-tracking lane that touches Firestore. It:
//   1. resolves each `video_view_series` doc's `submissionId` -> canonical creator/enrollment SERVER-SIDE
//      (never exposing the raw `token:...` value — spec/handoff §7 "resolve submission-token:/lead-* to
//      canonical ids without exposing raw token values"),
//   2. writes descriptive rows into `video_performance_report_rows` under a namespaced, deterministic doc
//      id (`track:v:{videoId}`) so the backfill is additive + idempotent (re-run => same docs), and
//      NEVER touches the settlement rows (they have no `descriptive` flag and keep `reportEligible`),
//   3. exposes a bounded, index-backed read of the descriptive surface for the report UI.
import type {
  PersistedApprovedAuthoritativeRow,
  PersistedDescriptiveRow,
  TrackedVideoInput,
  VideoViewSeriesTrendInput,
} from "./videoPerformanceTrackingProjection";
import {
  resolveCreatorDisplayIdentity,
  resolveProfileImageProjection,
  type ProfileImageSourceInputs,
} from "./managementProfileTabsReadModels";
import {
  approvedAuthoritativeRowId,
  DESCRIPTIVE_ROW_ID_PREFIX,
  resolveApprovedCreatorIdentity,
  summarizeDescriptiveTracking,
  toPersistedApprovedAuthoritativeRow,
  toPersistedDescriptiveRow,
} from "./videoPerformanceTrackingProjection";

export { approvedAuthoritativeRowId };

type FirestoreDb = FirebaseFirestore.Firestore;

export const VIDEO_PERFORMANCE_COLLECTION = "video_performance_report_rows";
export const VIDEO_VIEW_SERIES_COLLECTION = "video_view_series";
export const SUBMISSIONS_COLLECTION = "submissions";
export const CREATORS_COLLECTION = "creators";
export const VIDEO_REVIEW_STATE_COLLECTION = "scp_video_review_state";

// Bounded fetch ceiling for the descriptive read surface (mirrors the settlement port's 500 ceiling).
export const DESCRIPTIVE_FETCH_LIMIT = 500;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function httpsUrl(value: unknown): string {
  const text = str(value);
  if (!text) return "";
  try {
    return new URL(text).protocol === "https:" ? text : "";
  } catch {
    return "";
  }
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function creatorProfileImageInputs(creator: Record<string, unknown>): ProfileImageSourceInputs {
  const profileImage = nestedRecord(creator.profileImage);
  return {
    youtubeOauthVerifiedThumbnailUrl: httpsUrl(creator.youtubeOauthVerifiedThumbnailUrl) || httpsUrl(profileImage.url) || null,
    fluCanonicalChannelImageUrl: httpsUrl(creator.fluCanonicalChannelImageUrl) || httpsUrl(creator.canonicalProfileImageUrl) || null,
    youtubeDataApiPublicThumbnailUrl: httpsUrl(creator.youtubeDataApiPublicThumbnailUrl) || null,
  };
}

function creatorProfileImageUrl(creator: Record<string, unknown>, displayName: string): string {
  return resolveProfileImageProjection(
    creatorProfileImageInputs(creator),
    displayName,
    typeof creator.profileImageRevision === "number" ? creator.profileImageRevision : 0,
    str(creator.profileImageVerifiedAt) || undefined,
  ).url ?? "";
}

// ---- resolver -----------------------------------------------------------------------------------------

export interface ResolverContext {
  readonly submissionsById: Map<string, Record<string, unknown>>;
  readonly creatorsById: Map<string, Record<string, unknown>>;
  // 정본 역추적 키: youtubeVideoId -> 정규 fluCreatorId (scp_video_review_state 에서 만든다).
  // legacy `submissions.creatorId` 는 이메일 슬러그(`CR_tokymongrey-gmail-com`)라 creators(`CR00029`)에
  // 절대 붙지 않는다 — 운영 실측 0/113. 같은 영상 기준으로 review state 를 보면 106/113 이 붙는다.
  readonly canonicalCreatorIdByVideoId?: Map<string, string>;
}

const APPROVED_REVIEW_STATUSES = new Set(["approved", "pass"]);

// scp_video_review_state 는 승인 경로가 이미 정규 fluCreatorId 의 출처로 쓰는 컬렉션이다(새 컬렉션 아님).
// 같은 영상에 상태가 여러 건이면 승인 건이 이긴다 — 정산/리포트가 보는 것이 승인 사실이기 때문이다.
export function canonicalCreatorIdByVideoId(
  reviewStates: readonly Record<string, unknown>[],
): Map<string, string> {
  const byVideoId = new Map<string, { creatorId: string; approved: boolean }>();
  for (const state of reviewStates) {
    const subject = record(state.subject);
    const youtubeVideoId = str(state.youtubeVideoId) || str(subject.youtubeVideoId);
    const creatorId = str(state.fluCreatorId) || str(subject.fluCreatorId);
    if (!youtubeVideoId || !creatorId) continue;
    const approved = APPROVED_REVIEW_STATUSES.has(str(state.state));
    const previous = byVideoId.get(youtubeVideoId);
    if (!previous || (!previous.approved && approved)) {
      byVideoId.set(youtubeVideoId, { creatorId, approved });
    }
  }
  return new Map([...byVideoId].map(([videoId, hit]) => [videoId, hit.creatorId]));
}

// Pure resolution: video_view_series doc -> TrackedVideoInput. Absent linkage => UNRESOLVED (report-only),
// never a fabricated identity. `handle` passes only as a YouTube handle (@ 접두) — the shared rule that
// keeps emails in creators.handle off every public surface.
export function resolveTrackedVideo(series: Record<string, unknown>, ctx: ResolverContext): TrackedVideoInput {
  const youtubeVideoId = str(series.videoId);
  const submissionId = str(series.submissionId);
  const submission = submissionId ? ctx.submissionsById.get(submissionId) ?? null : null;
  // 영상 기준 정규 귀속이 먼저다. legacy submissions.creatorId 는 이메일 슬러그라 creators 에 붙지 않고,
  // 그 폴백만 남겨두면 실제 크리에이터가 있는 행까지 "미귀속"으로 굳는다.
  const canonicalCreatorId = youtubeVideoId
    ? ctx.canonicalCreatorIdByVideoId?.get(youtubeVideoId) ?? ""
    : "";
  const creatorId = canonicalCreatorId || (submission ? str(submission.creatorId) : "");
  const creator = creatorId ? ctx.creatorsById.get(creatorId) ?? null : null;
  const reviewStatus = submission ? str(submission.reviewStatus) : "";
  // 이름/핸들 규칙의 정본(managementProfileTabsReadModels). 여기서는 미귀속 표기를 유지해야 하므로
  // creatorId 폴백을 쓰지 않는다 — 빈 fluCreatorId 를 넘겨 "값이 있으면 그것만" 쓰게 한다.
  const identity = resolveCreatorDisplayIdentity(creator ?? undefined, "");
  const handle = identity.handle ?? "";
  const displayName = creator ? identity.displayName || str(creator.name) || null : null;
  return {
    youtubeVideoId,
    totalViews: series.totalViews,
    latestDailyDeltaViews: series.latestDailyDeltaViews,
    publishedAtIso: series.publishedAtIso,
    updatedAtIso: series.updatedAtIso,
    dayCount: series.dayCount,
    resolvedCreatorId: creator ? str(creator.id) || creatorId : null,
    resolvedDisplayName: displayName,
    resolvedHandle: handle || null,
    resolvedCreatorProfileImageUrl: creator ? creatorProfileImageUrl(creator, displayName ?? creatorId) || null : null,
    // Legacy submissions carry no enrollment/program that resolves to the v3 model — leave UNRESOLVED.
    resolvedEnrollmentId: null,
    resolvedProgramId: null,
    resolvedProgramName: null,
    resolvedTitle: submission ? str(submission.title) || null : null,
    resolvedThumbnailUrl: submission ? str(submission.thumbnailUrl) || str(submission.thumb) || null : null,
    hasApprovedSubmissionEvidence: APPROVED_REVIEW_STATUSES.has(reviewStatus),
  };
}

// ---- bounded collection reads -------------------------------------------------------------------------

async function readAll(db: FirestoreDb, collection: string, cap = 5000): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const pageSize = 450;
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (let i = 0; i < Math.ceil(cap / pageSize) + 1 && out.length < cap; i++) {
    let q = db.collection(collection).orderBy("__name__").limit(pageSize);
    if (last) q = db.collection(collection).orderBy("__name__").startAfter(last).limit(pageSize);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) out.push({ id: doc.id, ...(doc.data() as Record<string, unknown>) });
    last = snap.docs.at(-1);
    if (snap.size < pageSize) break;
  }
  return out;
}

// ---- backfill (preview / apply / rollback) ------------------------------------------------------------

export interface DescriptiveBackfillOptions {
  readonly apply?: boolean;
  readonly db: FirestoreDb;
  // Optional pre-fetched YouTube snippet enrichment keyed by youtubeVideoId. The fetch itself lives in the
  // backfill script (server-side, YOUTUBE_API_KEY) — this module stays network-free and only merges the
  // supplied real title/thumbnail/channel onto rows whose source lacked them.
  readonly enrichment?: ReadonlyMap<string, { readonly title?: string; readonly thumbnailUrl?: string; readonly channelTitle?: string }>;
}

export type MigrationRowClassification =
  | "write_new"
  | "replace_descriptive"
  | "already_current_descriptive"
  | "skip_authoritative_approved_current"
  | "skip_non_descriptive_existing"
  | "duplicate_source_video_id"
  | "invalid_missing_video_id"
  | "authoritative_write_new"
  | "authoritative_already_current"
  | "authoritative_conflict"
  | "authoritative_source_invalid"
  | "authoritative_unavailable_no_write";

export interface MigrationManifestRow {
  readonly sourceDocId: string;
  readonly sourceIndex: number;
  readonly youtubeVideoId: string;
  readonly destinationRowId: string;
  readonly classification: MigrationRowClassification;
  readonly reason: string;
  readonly sourceDigest: string;
  readonly destinationDigest?: string;
  readonly targetDigest?: string;
  readonly attributed: boolean;
  readonly hasApprovedSubmissionEvidence: boolean;
  readonly totalViews: string;
  readonly sourceCollection: typeof VIDEO_VIEW_SERIES_COLLECTION;
  readonly destinationCollection: typeof VIDEO_PERFORMANCE_COLLECTION;
  readonly sourceSubmissionIdDigest?: string;
  readonly attributionResolution:
    | "resolved_creator"
    | "unresolved"
    | "approved_review_state";
  readonly attributionReason: string;
}

export interface MigrationBackupDoc {
  readonly rowId: string;
  readonly beforeExists: boolean;
  readonly beforeData?: Record<string, unknown>;
  readonly beforeDigest?: string;
  readonly afterDigest: string;
  readonly appliedAction: "create" | "replace";
}

export interface DescriptiveBackfillReceipt {
  readonly schema:
    | "flu.videoPerformance.descriptiveTrackingMigration.v1"
    | "flu.videoPerformance.trackingMigration.v2";
  readonly projectionKind?: "descriptive" | "approved_authoritative";
  readonly targetManifestDigest?: string;
  readonly operationId: string;
  readonly mode: "preview" | "apply";
  readonly apply: boolean;
  readonly generatedAtIso: string;
  readonly target: "emulator" | "production" | string;
  readonly projectId: string;
  readonly sourceSha: string;
  readonly treeSha: string;
  readonly rollbackCommand: string;
  readonly counts: DescriptiveBackfillCounts;
  readonly sourceFingerprint: string;
  readonly destinationFingerprint: string;
  readonly rowManifestDigest: string;
  readonly rowManifest: readonly MigrationManifestRow[];
  readonly backupDocs: readonly MigrationBackupDoc[];
}

export interface DescriptiveBackfillCounts {
  readonly scannedSeries: number;
  readonly sourceRows: number;
  readonly builtRows: number;
  readonly wouldWrite: number;
  readonly written: number;
  readonly createCount: number;
  readonly replaceCount: number;
  readonly alreadyCurrentCount: number;
  readonly skippedAuthoritativeCount: number;
  readonly skippedNonDescriptiveExistingCount: number;
  readonly duplicateSourceVideoIdCount: number;
  readonly invalidMissingVideoIdCount: number;
  readonly enrichedCount: number;
  readonly attributedCount: number;
  readonly unattributedCount: number;
  readonly approvedEvidenceCount: number;
  readonly approvedAuthoritativeTargets?: number;
  readonly authoritativeAlreadyCurrentCount?: number;
  readonly authoritativeConflictCount?: number;
  readonly authoritativeSourceInvalidCount?: number;
  readonly seriesJoinedCount?: number;
  readonly explicitUnavailableCount?: number;
  readonly totalViews: string;
  readonly classifications: Readonly<Record<MigrationRowClassification, number>>;
}

export interface DescriptiveBackfillReport extends DescriptiveBackfillCounts {
  readonly apply: boolean;
  readonly digest: string;
  readonly sourceFingerprint: string;
  readonly destinationFingerprint: string;
  readonly rowManifestDigest: string;
  readonly operationId: string;
  readonly rowManifest: readonly MigrationManifestRow[];
  readonly rollbackCommand: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

async function sha256Hex(value: unknown, length = 64): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex").slice(0, length);
}

async function digestRows(rows: readonly PersistedTrackingMigrationRow[]): Promise<string> {
  return sha256Hex(
    rows.map((row) => ({
      rowId: row.rowId,
      metrics: row.metrics,
      ...(row.descriptive
        ? {
            attributed: row.attributed,
            approved: row.hasApprovedSubmissionEvidence,
          }
        : {
            descriptive: false,
            reportEligible: true,
          }),
    })),
    24,
  );
}

function isAuthoritativeApprovedCurrent(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  return data.reportEligible === true || (data.isCurrentRevision === true && data.isApproved === true);
}

function isDescriptiveRow(data: Record<string, unknown> | undefined): boolean {
  return data?.descriptive === true && data?.reportVisible === true && data?.reportEligible === false;
}

async function getDestinationDocs(
  db: FirestoreDb,
  rowIds: readonly string[],
): Promise<Map<string, { exists: boolean; data?: Record<string, unknown>; digest: string }>> {
  const out = new Map<string, { exists: boolean; data?: Record<string, unknown>; digest: string }>();
  await Promise.all(
    rowIds.map(async (rowId) => {
      const snap = await db.collection(VIDEO_PERFORMANCE_COLLECTION).doc(rowId).get();
      const data = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : undefined;
      out.set(rowId, { exists: snap.exists, data, digest: await sha256Hex(data ?? null, 24) });
    }),
  );
  return out;
}

function emptyClassificationCounts(): Record<MigrationRowClassification, number> {
  return {
    write_new: 0,
    replace_descriptive: 0,
    already_current_descriptive: 0,
    skip_authoritative_approved_current: 0,
    skip_non_descriptive_existing: 0,
    duplicate_source_video_id: 0,
    invalid_missing_video_id: 0,
    authoritative_write_new: 0,
    authoritative_already_current: 0,
    authoritative_conflict: 0,
    authoritative_source_invalid: 0,
    authoritative_unavailable_no_write: 0,
  };
}

export interface ApprovedAuthoritativeMigrationTarget {
  readonly sourceManifestId: string;
  readonly trackingReceiptDigest: string;
  readonly submissionId: string;
  readonly youtubeVideoId: string;
  readonly revision: number;
  readonly applicationId: string;
  readonly programId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly publishedAtIso: string;
  readonly observedAtIso: string;
  readonly trackingOk: boolean;
  readonly views: number | null;
  readonly dailyDeltaViews: number | null;
  readonly trackingUnavailableReason?: "video_not_found";
}

export interface DescriptiveMigrationPlanOptions extends DescriptiveBackfillOptions {
  readonly operationId?: string;
  readonly target?: "emulator" | "production" | string;
  readonly projectId?: string;
  readonly sourceSha?: string;
  readonly treeSha?: string;
  readonly receiptPath?: string;
  readonly projectionKind?: "descriptive" | "approved_authoritative";
  readonly approvedAuthoritativeTargets?: readonly ApprovedAuthoritativeMigrationTarget[];
  readonly targetManifestDigest?: string;
}

type PersistedTrackingMigrationRow =
  | PersistedDescriptiveRow
  | PersistedApprovedAuthoritativeRow;

export interface DescriptiveMigrationPlan {
  readonly rows: readonly PersistedTrackingMigrationRow[];
  readonly sourceRows: readonly Record<string, unknown>[];
  readonly rowManifest: readonly MigrationManifestRow[];
  readonly backupDocs: readonly MigrationBackupDoc[];
  readonly counts: DescriptiveBackfillCounts;
  readonly sourceFingerprint: string;
  readonly destinationFingerprint: string;
  readonly rowManifestDigest: string;
  readonly digest: string;
  readonly operationId: string;
  readonly projectionKind?: "descriptive" | "approved_authoritative";
  readonly selectedTargetCount?: number;
  readonly authoritativeSourceChecks?: readonly {
    readonly target: ApprovedAuthoritativeMigrationTarget;
    readonly sourceDigest: string;
  }[];
  readonly receipt: DescriptiveBackfillReceipt;
}

function describeAttributionReason(
  source: Record<string, unknown>,
  ctx: ResolverContext,
  row: PersistedDescriptiveRow | undefined,
  missing: boolean,
  duplicate: boolean,
): string {
  if (missing) return "invalid_source_missing_video_id";
  if (duplicate) return "duplicate_source_video_id_first_source_row_owns_destination";
  if (row?.attributed === true) {
    return ctx.canonicalCreatorIdByVideoId?.has(str(source.videoId))
      ? "resolved_creator_id_from_video_review_state"
      : "resolved_creator_id_from_submission_creatorId";
  }
  const submissionId = str(source.submissionId);
  if (!submissionId) return "no_submission_id_on_video_view_series";
  const submission = ctx.submissionsById.get(submissionId);
  if (!submission) return "source_submission_not_found";
  const creatorId = str(submission.creatorId);
  if (!creatorId) return "legacy_submission_has_no_canonical_creatorId_profile_program_campaign_country_join";
  if (!ctx.creatorsById.has(creatorId)) return "canonical_creatorId_not_found_in_creators";
  return "canonical_enrollment_program_campaign_country_join_unavailable_descriptive_only";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedIso(value: unknown): string {
  const millis = Date.parse(str(value));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : "";
}

function uintString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value).toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return "";
}

function exactApprovedReviewState(
  target: ApprovedAuthoritativeMigrationTarget,
  review: Record<string, unknown> | undefined,
): { valid: boolean; reason: string; subject: Record<string, unknown> } {
  if (!review) {
    return { valid: false, reason: "approved review state is missing", subject: {} };
  }
  const subject = record(review.subject);
  const revision = Number(review.revision ?? subject.videoRevision);
  const matches =
    str(review.state) === "approved" &&
    revision === target.revision &&
    str(review.youtubeVideoId) === target.youtubeVideoId &&
    (str(review.videoSubmissionId) || str(subject.videoSubmissionId)) ===
      target.submissionId &&
    (str(review.applicationId) || str(subject.applicationId)) ===
      target.applicationId &&
    (str(review.programId) || str(subject.programId)) === target.programId &&
    review.reportEligible === true &&
    review.trackingEligible === true &&
    review.settlementEligible === true &&
    review.downstreamProjectionConfirmed === true &&
    review.superseded !== true &&
    review.withdrawn !== true &&
    Boolean(str(review.fluCreatorId) || str(subject.fluCreatorId)) &&
    Boolean(str(review.enrollmentId) || str(subject.enrollmentId));
  return {
    valid: matches,
    reason: matches
      ? "approved current review and downstream eligibility confirmed"
      : "review identity/revision/eligibility is not exact approved-current",
    subject,
  };
}

function exactTrackingSeries(
  target: ApprovedAuthoritativeMigrationTarget,
  series: Record<string, unknown> | undefined,
): { valid: boolean; unavailable: boolean; reason: string } {
  if (!target.trackingOk) {
    const validUnavailable =
      target.trackingUnavailableReason === "video_not_found" &&
      target.views === null &&
      target.dailyDeltaViews === null &&
      !series;
    return {
      valid: validUnavailable,
      unavailable: validUnavailable,
      reason: validUnavailable
        ? "tracking refresh explicitly verified video_not_found"
        : "unavailable tracking evidence is incomplete or conflicts with a series",
    };
  }
  if (
    !series ||
    str(series.videoId) !== target.youtubeVideoId ||
    str(series.submissionId) !== target.submissionId ||
    uintString(series.totalViews) !== uintString(target.views) ||
    uintString(series.latestDailyDeltaViews) !==
      uintString(target.dailyDeltaViews) ||
    normalizedIso(series.publishedAtIso) !==
      normalizedIso(target.publishedAtIso)
  ) {
    return {
      valid: false,
      unavailable: false,
      reason: "video_view_series does not exactly match tracking receipt and historical publish clock",
    };
  }
  return {
    valid: true,
    unavailable: false,
    reason: "video_view_series exactly joins the approved target",
  };
}

async function buildApprovedAuthoritativeTrackingMigrationPlan(
  options: DescriptiveMigrationPlanOptions,
): Promise<DescriptiveMigrationPlan> {
  const targets = options.approvedAuthoritativeTargets ?? [];
  const targetManifestDigest = str(options.targetManifestDigest);
  if (!targets.length) {
    throw new Error("approved_authoritative_targets_required");
  }
  if (!/^[a-f0-9]{64}$/.test(targetManifestDigest)) {
    throw new Error("approved_authoritative_target_manifest_digest_required");
  }
  const submissionIds = new Set<string>();
  const videoIds = new Set<string>();
  for (const target of targets) {
    if (
      !target.submissionId ||
      !target.youtubeVideoId ||
      submissionIds.has(target.submissionId) ||
      videoIds.has(target.youtubeVideoId)
    ) {
      throw new Error("approved_authoritative_target_identity_invalid");
    }
    submissionIds.add(target.submissionId);
    videoIds.add(target.youtubeVideoId);
  }

  const sources = await Promise.all(
    targets.map(async (target) => {
      const [reviewSnap, seriesSnap] = await Promise.all([
        options.db
          .collection(VIDEO_REVIEW_STATE_COLLECTION)
          .doc(target.submissionId)
          .get(),
        options.db
          .collection(VIDEO_VIEW_SERIES_COLLECTION)
          .doc(target.youtubeVideoId)
          .get(),
      ]);
      const review = reviewSnap.exists
        ? (reviewSnap.data() ?? {}) as Record<string, unknown>
        : undefined;
      const series = seriesSnap.exists
        ? (seriesSnap.data() ?? {}) as Record<string, unknown>
        : undefined;
      const reviewCheck = exactApprovedReviewState(target, review);
      const seriesCheck = exactTrackingSeries(target, series);
      return {
        target,
        review,
        series,
        reviewCheck,
        seriesCheck,
      };
    }),
  );

  const planned = await Promise.all(
    sources.map(async (source) => {
      const { target, review, series, reviewCheck, seriesCheck } =
        source;
      const valid = reviewCheck.valid && seriesCheck.valid;
      let row: PersistedApprovedAuthoritativeRow | undefined;
      if (valid && !seriesCheck.unavailable) {
        const subject = reviewCheck.subject;
        const creatorId =
          str(review?.fluCreatorId) || str(subject.fluCreatorId);
        // creators가 표시 정체성의 정본이다(핸들·표시명은 이미 저장되어 있다). 문서가 없을 때만
        // creatorId로 폴백해 CR ID가 그대로 노출되는 것을 막는다. bounded 단건 조회 — 전체 스캔 아님.
        const creatorSnap = creatorId
          ? await options.db.collection(CREATORS_COLLECTION).doc(creatorId).get()
          : undefined;
        const creator = creatorSnap?.exists
          ? (creatorSnap.data() ?? {}) as Record<string, unknown>
          : undefined;
        const identity = resolveApprovedCreatorIdentity(creator, creatorId);
        // 이미 저장된 행에 정산 인정 조회수가 확정돼 있으면 그 값을 그대로 넘긴다 — 마감 후
        // 재적재가 조회수를 다시 키워 확정 근거를 흔드는 것을 막는다.
        const existingRowSnap = await options.db
          .collection(VIDEO_PERFORMANCE_COLLECTION)
          .doc(approvedAuthoritativeRowId(
            target.submissionId,
            target.revision,
            target.youtubeVideoId,
          ))
          .get();
        const existingMetrics = existingRowSnap.exists
          ? ((existingRowSnap.data() ?? {}).metrics as Record<string, unknown> | undefined)
          : undefined;
        row = toPersistedApprovedAuthoritativeRow({
          existingEligibleViews: existingMetrics?.eligibleViews,
          sourceManifestId: target.sourceManifestId,
          trackingReceiptDigest: target.trackingReceiptDigest,
          submissionId: target.submissionId,
          youtubeVideoId: target.youtubeVideoId,
          revision: target.revision,
          canonicalUrl: target.canonicalUrl,
          title: target.title,
          publishedAtIso: target.publishedAtIso,
          observedAtIso: target.observedAtIso,
          totalViews: series?.totalViews ?? target.views,
          latestDailyDeltaViews:
            series?.latestDailyDeltaViews ?? target.dailyDeltaViews,
          fluCreatorId: creatorId,
          displayName: identity.displayName,
          handle: identity.handle,
          enrollmentId:
            str(review?.enrollmentId) || str(subject.enrollmentId),
          programId: str(review?.programId) || str(subject.programId),
          programName: "View CPM",
          campaignId:
            str(review?.campaignId) ||
            str(subject.campaignId) ||
            "unclassified",
          campaignName: "Legacy Sheet historical import",
        });
      }
      return {
        ...source,
        valid,
        row,
        sourceDigest: await sha256Hex(
          { target, review: review ?? null, series: series ?? null },
          24,
        ),
      };
    }),
  );

  const destination = await getDestinationDocs(
    options.db,
    planned
      .map((item) => item.row?.rowId)
      .filter((rowId): rowId is string => Boolean(rowId)),
  );
  const classifications = emptyClassificationCounts();
  const manifest: MigrationManifestRow[] = [];
  const rows: PersistedApprovedAuthoritativeRow[] = [];
  const backupDocs: MigrationBackupDoc[] = [];
  let totalViews = 0n;

  for (let index = 0; index < planned.length; index += 1) {
    const item = planned[index];
    const destinationState = item.row
      ? destination.get(item.row.rowId)
      : undefined;
    const targetDigest = item.row
      ? await sha256Hex(item.row, 24)
      : undefined;
    let classification: MigrationRowClassification;
    let reason: string;
    if (item.valid && item.seriesCheck.unavailable) {
      classification = "authoritative_unavailable_no_write";
      reason =
        "tracking refresh verified video_not_found; no report-eligible row is created and no zero placeholder is aggregated";
    } else if (!item.valid || !item.row) {
      classification = "authoritative_source_invalid";
      reason = `${item.reviewCheck.reason}; ${item.seriesCheck.reason}`;
    } else if (!destinationState?.exists) {
      classification = "authoritative_write_new";
      reason = "new exact approved-current report row will be created";
    } else if (destinationState.digest === targetDigest) {
      classification = "authoritative_already_current";
      reason = "approved-current report row already matches target digest";
    } else {
      classification = "authoritative_conflict";
      reason = "deterministic approved-current destination exists with drift";
    }
    classifications[classification] += 1;
    if (item.row) {
      totalViews += BigInt(item.row.metrics.totalViews);
    }
    if (classification === "authoritative_write_new" && item.row) {
      rows.push(item.row);
      backupDocs.push({
        rowId: item.row.rowId,
        beforeExists: false,
        afterDigest: targetDigest!,
        appliedAction: "create",
      });
    }
    manifest.push({
      sourceDocId: item.target.submissionId,
      sourceIndex: index,
      youtubeVideoId: item.target.youtubeVideoId,
      destinationRowId:
        item.row?.rowId ??
        approvedAuthoritativeRowId(
          item.target.submissionId,
          item.target.revision,
          item.target.youtubeVideoId,
        ),
      classification,
      reason,
      sourceDigest: item.sourceDigest,
      ...(destinationState
        ? { destinationDigest: destinationState.digest }
        : {}),
      ...(targetDigest ? { targetDigest } : {}),
      attributed: item.reviewCheck.valid,
      hasApprovedSubmissionEvidence: item.reviewCheck.valid,
      totalViews: item.row?.metrics.totalViews ?? "0",
      sourceCollection: VIDEO_VIEW_SERIES_COLLECTION,
      destinationCollection: VIDEO_PERFORMANCE_COLLECTION,
      sourceSubmissionIdDigest: await sha256Hex(
        item.target.submissionId,
        24,
      ),
      attributionResolution: "approved_review_state",
      attributionReason: reason,
    });
  }

  const counts: DescriptiveBackfillCounts = {
    scannedSeries: planned.filter((item) => Boolean(item.series)).length,
    sourceRows: targets.length,
    builtRows: planned.filter((item) => Boolean(item.row)).length,
    wouldWrite: rows.length,
    written: 0,
    createCount: classifications.authoritative_write_new,
    replaceCount: 0,
    alreadyCurrentCount: classifications.authoritative_already_current,
    skippedAuthoritativeCount: 0,
    skippedNonDescriptiveExistingCount: 0,
    duplicateSourceVideoIdCount: 0,
    invalidMissingVideoIdCount: 0,
    enrichedCount: 0,
    attributedCount: planned.filter((item) => item.reviewCheck.valid).length,
    unattributedCount: planned.filter((item) => !item.reviewCheck.valid).length,
    approvedEvidenceCount: planned.filter((item) => item.reviewCheck.valid).length,
    approvedAuthoritativeTargets: targets.length,
    authoritativeAlreadyCurrentCount:
      classifications.authoritative_already_current,
    authoritativeConflictCount: classifications.authoritative_conflict,
    authoritativeSourceInvalidCount:
      classifications.authoritative_source_invalid,
    seriesJoinedCount: planned.filter(
      (item) => item.seriesCheck.valid && !item.seriesCheck.unavailable,
    ).length,
    explicitUnavailableCount: planned.filter(
      (item) => item.seriesCheck.unavailable,
    ).length,
    totalViews: totalViews.toString(),
    classifications,
  };
  if (
    options.apply === true &&
    (classifications.authoritative_conflict > 0 ||
      classifications.authoritative_source_invalid > 0)
  ) {
    throw new Error("approved_authoritative_source_invalid");
  }
  const sourceFingerprint = await sha256Hex(
    planned.map((item) => ({
      submissionId: item.target.submissionId,
      sourceDigest: item.sourceDigest,
    })),
    64,
  );
  const destinationFingerprint = await sha256Hex(
    [...destination.entries()]
      .map(([rowId, state]) => ({
        rowId,
        exists: state.exists,
        digest: state.digest,
      }))
      .sort((left, right) => left.rowId.localeCompare(right.rowId)),
    64,
  );
  const rowManifestDigest = await sha256Hex(manifest, 64);
  const operationId =
    options.operationId ||
    `flu-video-tracking-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const receiptPath =
    options.receiptPath || `<receipt-path-for-${operationId}.json>`;
  const receipt: DescriptiveBackfillReceipt = {
    schema: "flu.videoPerformance.trackingMigration.v2",
    projectionKind: "approved_authoritative",
    targetManifestDigest,
    operationId,
    mode: options.apply ? "apply" : "preview",
    apply: options.apply === true,
    generatedAtIso: new Date().toISOString(),
    target: options.target || "unknown",
    projectId: options.projectId || "unknown",
    sourceSha: options.sourceSha || "unknown",
    treeSha: options.treeSha || "unknown",
    rollbackCommand: `node scripts/backfill-video-performance-tracking.mjs --rollback --receipt ${receiptPath}`,
    counts,
    sourceFingerprint,
    destinationFingerprint,
    rowManifestDigest,
    rowManifest: manifest,
    backupDocs,
  };
  return {
    rows,
    sourceRows: targets as unknown as Record<string, unknown>[],
    rowManifest: manifest,
    backupDocs,
    counts,
    sourceFingerprint,
    destinationFingerprint,
    rowManifestDigest,
    digest: await digestRows(
      planned
        .map((item) => item.row)
        .filter(
          (row): row is PersistedApprovedAuthoritativeRow => Boolean(row),
        ),
    ),
    operationId,
    projectionKind: "approved_authoritative",
    selectedTargetCount: targets.length,
    authoritativeSourceChecks: planned.map((item) => ({
      target: item.target,
      sourceDigest: item.sourceDigest,
    })),
    receipt,
  };
}

export async function buildDescriptiveTrackingMigrationPlan(
  options: DescriptiveMigrationPlanOptions,
): Promise<DescriptiveMigrationPlan> {
  if (options.projectionKind === "approved_authoritative") {
    return buildApprovedAuthoritativeTrackingMigrationPlan(options);
  }
  const { db, enrichment } = options;
  const operationId = options.operationId || `flu-video-tracking-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const [series, submissions, creators, reviewStates] = await Promise.all([
    readAll(db, VIDEO_VIEW_SERIES_COLLECTION),
    readAll(db, SUBMISSIONS_COLLECTION),
    readAll(db, CREATORS_COLLECTION),
    readAll(db, VIDEO_REVIEW_STATE_COLLECTION),
  ]);
  const ctx: ResolverContext = {
    submissionsById: new Map(submissions.map((s) => [str(s.id), s])),
    creatorsById: new Map(creators.map((c) => [str(c.id), c])),
    canonicalCreatorIdByVideoId: canonicalCreatorIdByVideoId(reviewStates),
  };

  let enrichedCount = 0;
  const seenVideoIds = new Set<string>();
  const candidates: Array<{ source: Record<string, unknown>; sourceIndex: number; sourceDigest: string; row?: PersistedDescriptiveRow; duplicate: boolean; missing: boolean }> = [];
  for (let sourceIndex = 0; sourceIndex < series.length; sourceIndex += 1) {
    const source = series[sourceIndex];
    const youtubeVideoId = str(source.videoId);
    const sourceDigest = await sha256Hex(source, 24);
    const missing = youtubeVideoId.length === 0;
    const duplicate = !missing && seenVideoIds.has(youtubeVideoId);
    if (!missing) seenVideoIds.add(youtubeVideoId);
    let row: PersistedDescriptiveRow | undefined;
    if (!missing && !duplicate) {
      const base = resolveTrackedVideo(source, ctx);
      const enr = enrichment?.get(base.youtubeVideoId);
      if (!enr) row = toPersistedDescriptiveRow(base);
      else {
        if (enr.title?.trim() || enr.thumbnailUrl?.trim() || enr.channelTitle?.trim()) enrichedCount += 1;
        row = toPersistedDescriptiveRow({
          ...base,
          resolvedTitle: base.resolvedTitle?.trim() || enr.title?.trim() || null,
          resolvedThumbnailUrl: base.resolvedThumbnailUrl?.trim() || enr.thumbnailUrl?.trim() || null,
          resolvedChannelTitle: enr.channelTitle?.trim() || null,
        });
      }
    }
    candidates.push({ source, sourceIndex, sourceDigest, row, duplicate, missing });
  }

  const destination = await getDestinationDocs(
    db,
    candidates.map((c) => c.row?.rowId).filter((rowId): rowId is string => Boolean(rowId)),
  );
  const targetDigestByRowId = new Map<string, string>();
  await Promise.all(
    candidates.map(async (c) => {
      if (c.row) targetDigestByRowId.set(c.row.rowId, await sha256Hex(c.row, 24));
    }),
  );

  const rows: PersistedDescriptiveRow[] = [];
  const manifest: MigrationManifestRow[] = [];
  const backupDocs: MigrationBackupDoc[] = [];
  const classifications = emptyClassificationCounts();

  for (const candidate of candidates) {
    const row = candidate.row;
    const destinationState = row ? destination.get(row.rowId) : undefined;
    const targetDigest = row ? targetDigestByRowId.get(row.rowId) : undefined;
    let classification: MigrationRowClassification;
    let reason: string;
    if (candidate.missing) {
      classification = "invalid_missing_video_id";
      reason = "source video_view_series row has no videoId; not materialized";
    } else if (candidate.duplicate) {
      classification = "duplicate_source_video_id";
      reason = "duplicate source videoId; first row owns the deterministic destination row";
    } else if (isAuthoritativeApprovedCurrent(destinationState?.data)) {
      classification = "skip_authoritative_approved_current";
      reason = "destination row is authoritative approved/current or reportEligible; never overwritten by descriptive migration";
    } else if (destinationState?.exists && !isDescriptiveRow(destinationState.data)) {
      classification = "skip_non_descriptive_existing";
      reason = "destination row exists but is not the descriptive migration surface; fail-closed";
    } else if (destinationState?.exists && destinationState.digest === targetDigest) {
      classification = "already_current_descriptive";
      reason = "destination descriptive row already matches target digest; idempotent no-op";
    } else if (destinationState?.exists) {
      classification = "replace_descriptive";
      reason = "destination descriptive row exists with drift; replace with deterministic target";
    } else {
      classification = "write_new";
      reason = "new deterministic descriptive row will be created";
    }
    classifications[classification] += 1;
    if (row && (classification === "write_new" || classification === "replace_descriptive")) {
      rows.push(row);
      backupDocs.push({
        rowId: row.rowId,
        beforeExists: destinationState?.exists === true,
        ...(destinationState?.data ? { beforeData: destinationState.data, beforeDigest: destinationState.digest } : {}),
        afterDigest: targetDigest ?? (await sha256Hex(row, 24)),
        appliedAction: destinationState?.exists === true ? "replace" : "create",
      });
    }
    manifest.push({
      sourceDocId: str(candidate.source.id),
      sourceIndex: candidate.sourceIndex,
      youtubeVideoId: row?.video.youtubeVideoId ?? str(candidate.source.videoId),
      destinationRowId: row?.rowId ?? "",
      classification,
      reason,
      sourceDigest: candidate.sourceDigest,
      ...(destinationState ? { destinationDigest: destinationState.digest } : {}),
      ...(targetDigest ? { targetDigest } : {}),
      attributed: row?.attributed === true,
      hasApprovedSubmissionEvidence: row?.hasApprovedSubmissionEvidence === true,
      totalViews: row?.metrics.totalViews ?? "0",
      sourceCollection: VIDEO_VIEW_SERIES_COLLECTION,
      destinationCollection: VIDEO_PERFORMANCE_COLLECTION,
      ...(str(candidate.source.submissionId) ? { sourceSubmissionIdDigest: await sha256Hex(str(candidate.source.submissionId), 24) } : {}),
      attributionResolution: row?.attributed === true ? "resolved_creator" : "unresolved",
      attributionReason: describeAttributionReason(candidate.source, ctx, row, candidate.missing, candidate.duplicate),
    });
  }

  const materializedRows = candidates.map((c) => c.row).filter((row): row is PersistedDescriptiveRow => Boolean(row));
  const summary = summarizeDescriptiveTracking(materializedRows);
  const counts: DescriptiveBackfillCounts = {
    scannedSeries: series.length,
    sourceRows: series.length,
    builtRows: materializedRows.length,
    wouldWrite: rows.length,
    written: 0,
    createCount: classifications.write_new,
    replaceCount: classifications.replace_descriptive,
    alreadyCurrentCount: classifications.already_current_descriptive,
    skippedAuthoritativeCount: classifications.skip_authoritative_approved_current,
    skippedNonDescriptiveExistingCount: classifications.skip_non_descriptive_existing,
    duplicateSourceVideoIdCount: classifications.duplicate_source_video_id,
    invalidMissingVideoIdCount: classifications.invalid_missing_video_id,
    enrichedCount,
    attributedCount: summary.attributedCount,
    unattributedCount: summary.unattributedCount,
    approvedEvidenceCount: summary.approvedEvidenceCount,
    totalViews: summary.totalViews,
    classifications,
  };
  const sourceFingerprint = await sha256Hex(series.map((row) => ({ id: str(row.id), digest: stableJson(row) })), 64);
  const destinationFingerprint = await sha256Hex(
    [...destination.entries()].map(([rowId, state]) => ({ rowId, exists: state.exists, digest: state.digest })).sort((a, b) => a.rowId.localeCompare(b.rowId)),
    64,
  );
  const rowManifestDigest = await sha256Hex(manifest, 64);
  const digest = await digestRows(materializedRows);
  const receiptPath = options.receiptPath || `<receipt-path-for-${operationId}.json>`;
  const receipt: DescriptiveBackfillReceipt = {
    schema: "flu.videoPerformance.descriptiveTrackingMigration.v1",
    operationId,
    mode: options.apply ? "apply" : "preview",
    apply: options.apply === true,
    generatedAtIso: new Date().toISOString(),
    target: options.target || "unknown",
    projectId: options.projectId || "unknown",
    sourceSha: options.sourceSha || "unknown",
    treeSha: options.treeSha || "unknown",
    rollbackCommand: `node scripts/backfill-video-performance-tracking.mjs --rollback --receipt ${receiptPath}`,
    counts,
    sourceFingerprint,
    destinationFingerprint,
    rowManifestDigest,
    rowManifest: manifest,
    backupDocs,
  };
  return { rows, sourceRows: series, rowManifest: manifest, backupDocs, counts, sourceFingerprint, destinationFingerprint, rowManifestDigest, digest, operationId, receipt };
}

export async function runDescriptiveTrackingBackfill(options: DescriptiveMigrationPlanOptions): Promise<DescriptiveBackfillReport> {
  const plan = await buildDescriptiveTrackingMigrationPlan(options);
  let written = 0;
  if (options.apply === true) {
    if (plan.projectionKind === "approved_authoritative") {
      written = (await applyDescriptiveTrackingMigrationPlan(options.db, plan))
        .written;
    } else {
      const batchSize = 400;
      for (let i = 0; i < plan.rows.length; i += batchSize) {
        const batch = options.db.batch();
        for (const row of plan.rows.slice(i, i + batchSize)) {
          batch.set(
            options.db
              .collection(VIDEO_PERFORMANCE_COLLECTION)
              .doc(row.rowId),
            row,
          );
        }
        await batch.commit();
        written += Math.min(batchSize, plan.rows.length - i);
      }
    }
  }
  return {
    ...plan.counts,
    written,
    apply: options.apply === true,
    digest: plan.digest,
    sourceFingerprint: plan.sourceFingerprint,
    destinationFingerprint: plan.destinationFingerprint,
    rowManifestDigest: plan.rowManifestDigest,
    operationId: plan.operationId,
    rowManifest: plan.rowManifest,
    rollbackCommand: plan.receipt.rollbackCommand,
  };
}


export async function applyDescriptiveTrackingMigrationPlan(
  db: FirestoreDb,
  plan: Pick<
    DescriptiveMigrationPlan,
    | "rows"
    | "backupDocs"
    | "projectionKind"
    | "selectedTargetCount"
    | "authoritativeSourceChecks"
  >,
): Promise<{ written: number }> {
  if (
    plan.projectionKind === "approved_authoritative" &&
    (typeof plan.selectedTargetCount !== "number" ||
      plan.selectedTargetCount < 1 ||
      plan.selectedTargetCount > 20)
  ) {
    throw new Error("approved_authoritative_batch_exceeds_20");
  }
  await db.runTransaction(async (tx) => {
    if (plan.projectionKind === "approved_authoritative") {
      const sourceChecks = plan.authoritativeSourceChecks ?? [];
      if (
        sourceChecks.length !== plan.selectedTargetCount
      ) {
        throw new Error("approved_authoritative_source_checks_missing");
      }
      for (const check of sourceChecks) {
        const reviewRef = db
          .collection(VIDEO_REVIEW_STATE_COLLECTION)
          .doc(check.target.submissionId);
        const seriesRef = db
          .collection(VIDEO_VIEW_SERIES_COLLECTION)
          .doc(check.target.youtubeVideoId);
        const [reviewSnap, seriesSnap] = await Promise.all([
          tx.get(reviewRef),
          tx.get(seriesRef),
        ]);
        const currentDigest = await sha256Hex(
          {
            target: check.target,
            review: reviewSnap.exists
              ? reviewSnap.data() ?? {}
              : null,
            series: seriesSnap.exists
              ? seriesSnap.data() ?? {}
              : null,
          },
          24,
        );
        if (currentDigest !== check.sourceDigest) {
          throw new Error(
            `approved_authoritative_source_digest_changed:${check.target.submissionId}`,
          );
        }
      }
    }
    const refs = plan.rows.map((row) => db.collection(VIDEO_PERFORMANCE_COLLECTION).doc(row.rowId));
    const snaps = [] as FirebaseFirestore.DocumentSnapshot[];
    for (const ref of refs) snaps.push(await tx.get(ref));
    for (let i = 0; i < plan.rows.length; i += 1) {
      const row = plan.rows[i];
      const backup = plan.backupDocs.find((b) => b.rowId === row.rowId);
      if (!backup) throw new Error(`migration_plan_missing_backup:${row.rowId}`);
      const snap = snaps[i];
      const currentData = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : undefined;
      const currentDigest = await sha256Hex(currentData ?? null, 24);
      const expectedBeforeDigest = backup.beforeExists ? backup.beforeDigest : await sha256Hex(null, 24);
      if (currentDigest !== expectedBeforeDigest) {
        throw new Error(`migration_destination_digest_changed:${row.rowId}`);
      }
    }
    for (let i = 0; i < plan.rows.length; i += 1) tx.set(refs[i], plan.rows[i]);
  });
  return { written: plan.rows.length };
}

export interface DescriptiveReceiptRollbackResult {
  readonly deleted: number;
  readonly restored: number;
  readonly skippedChanged: number;
  readonly checked: number;
  readonly proofDigest: string;
  readonly rows: readonly { readonly rowId: string; readonly action: "deleted" | "restored" | "skipped_changed"; readonly beforeDigest?: string; readonly afterDigest: string; readonly currentDigest: string }[];
}

export async function rollbackDescriptiveTrackingMigrationReceipt(
  db: FirestoreDb,
  receipt: Pick<
    DescriptiveBackfillReceipt,
    "backupDocs" | "operationId" | "schema" | "projectionKind"
  >,
): Promise<DescriptiveReceiptRollbackResult> {
  if (
    !receipt.operationId ||
    ![
      "flu.videoPerformance.descriptiveTrackingMigration.v1",
      "flu.videoPerformance.trackingMigration.v2",
    ].includes(receipt.schema)
  ) {
    throw new Error("tracking_migration_rollback_receipt_invalid");
  }
  if (
    receipt.schema === "flu.videoPerformance.trackingMigration.v2" &&
    (receipt.projectionKind !== "approved_authoritative" ||
      receipt.backupDocs.length > 20 ||
      receipt.backupDocs.some(
        (backup) => !backup.rowId.startsWith("approved:v:"),
      ))
  ) {
    throw new Error("approved_authoritative_rollback_receipt_invalid");
  }
  let deleted = 0;
  let restored = 0;
  let skippedChanged = 0;
  const proofRows: Array<{ readonly rowId: string; readonly action: "deleted" | "restored" | "skipped_changed"; readonly beforeDigest?: string; readonly afterDigest: string; readonly currentDigest: string }> = [];
  const batchSize = 400;
  for (let i = 0; i < receipt.backupDocs.length; i += batchSize) {
    const chunk = receipt.backupDocs.slice(i, i + batchSize);
    const result = await db.runTransaction(async (tx) => {
      const refs = chunk.map((backup) => db.collection(VIDEO_PERFORMANCE_COLLECTION).doc(backup.rowId));
      const snaps = [] as FirebaseFirestore.DocumentSnapshot[];
      for (const ref of refs) snaps.push(await tx.get(ref));
      let chunkDeleted = 0;
      let chunkRestored = 0;
      let chunkSkippedChanged = 0;
      const chunkProof: typeof proofRows = [];
      for (let j = 0; j < chunk.length; j += 1) {
        const backup = chunk[j];
        const ref = refs[j];
        const snap = snaps[j];
        const current = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : undefined;
        const currentDigest = await sha256Hex(current ?? null, 24);
        if (currentDigest !== backup.afterDigest) {
          chunkSkippedChanged += 1;
          chunkProof.push({ rowId: backup.rowId, action: "skipped_changed", beforeDigest: backup.beforeDigest, afterDigest: backup.afterDigest, currentDigest });
          continue;
        }
        if (backup.beforeExists) {
          tx.set(ref, backup.beforeData ?? {});
          chunkRestored += 1;
          chunkProof.push({ rowId: backup.rowId, action: "restored", beforeDigest: backup.beforeDigest, afterDigest: backup.afterDigest, currentDigest });
        } else {
          tx.delete(ref);
          chunkDeleted += 1;
          chunkProof.push({ rowId: backup.rowId, action: "deleted", afterDigest: backup.afterDigest, currentDigest });
        }
      }
      return { chunkDeleted, chunkRestored, chunkSkippedChanged, chunkProof };
    });
    deleted += result.chunkDeleted;
    restored += result.chunkRestored;
    skippedChanged += result.chunkSkippedChanged;
    proofRows.push(...result.chunkProof);
  }
  return { deleted, restored, skippedChanged, checked: receipt.backupDocs.length, proofDigest: await sha256Hex(proofRows, 64), rows: proofRows };
}

// Rollback: legacy broad delete every descriptive row (namespaced doc id prefix). Kept only as a fallback;
// hard-reset-safe rollback should use rollbackDescriptiveTrackingMigrationReceipt() with an apply receipt.
export async function rollbackDescriptiveTrackingBackfill(db: FirestoreDb): Promise<{ deleted: number }> {
  const snap = await db
    .collection(VIDEO_PERFORMANCE_COLLECTION)
    .where("descriptive", "==", true)
    .limit(DESCRIPTIVE_FETCH_LIMIT * 4)
    .get();
  let deleted = 0;
  const batchSize = 400;
  const refs = snap.docs.map((d) => d.ref).filter((r) => r.id.startsWith(DESCRIPTIVE_ROW_ID_PREFIX));
  for (let i = 0; i < refs.length; i += batchSize) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + batchSize)) batch.delete(ref);
    await batch.commit();
    deleted += Math.min(batchSize, refs.length - i);
  }
  return { deleted };
}

// ---- bounded read for the report UI -------------------------------------------------------------------

export interface DescriptiveFetchScope {
  readonly enrollmentId?: string;
}

// One bounded, index-light fetch of the descriptive surface: a SINGLE equality on `descriptive` (served
// by Firestore's automatic single-field index — no composite index required, no manifest drift) capped by
// `.limit(n)`. Any enrollment scoping is applied IN MEMORY over that already-bounded set (mirrors the
// settlement port's programId in-memory filter), so an enrollment-scoped read never needs a second wider
// Firestore query. `truncated` is surfaced honestly when the raw fetch hits the ceiling.
export async function fetchDescriptiveRows(
  db: FirestoreDb,
  scope: DescriptiveFetchScope = {},
  limit = DESCRIPTIVE_FETCH_LIMIT,
): Promise<{ rows: PersistedDescriptiveRow[]; truncated: boolean }> {
  const snap = await db.collection(VIDEO_PERFORMANCE_COLLECTION).where("descriptive", "==", true).limit(limit).get();
  const fetched = snap.docs.map((d) => d.data() as PersistedDescriptiveRow);
  const truncated = fetched.length >= limit;
  const rows = scope.enrollmentId ? fetched.filter((row) => row.scope.enrollmentId === scope.enrollmentId) : fetched;
  return { rows, truncated };
}


export async function fetchReportEligibleRowsForTrend(
  db: FirestoreDb,
  scope: DescriptiveFetchScope = {},
  limit = DESCRIPTIVE_FETCH_LIMIT,
): Promise<{ rows: PersistedDescriptiveRow[]; truncated: boolean }> {
  const snap = await db.collection(VIDEO_PERFORMANCE_COLLECTION).where("reportEligible", "==", true).limit(limit).get();
  const fetched = snap.docs.map((d) => d.data() as PersistedDescriptiveRow);
  const truncated = fetched.length >= limit;
  const rows = scope.enrollmentId ? fetched.filter((row) => row.scope.enrollmentId === scope.enrollmentId) : fetched;
  return { rows, truncated };
}

// 한 번의 getAll 에 넣을 문서 수 상한. 상한(DESCRIPTIVE_FETCH_LIMIT=500)까지 전부 서로 다른
// 영상이어도 두 번이면 끝난다.
const VIDEO_VIEW_SERIES_BATCH_SIZE = 300;

export async function fetchVideoViewSeriesTrendDocs(
  db: FirestoreDb,
  videoIds: readonly string[],
): Promise<VideoViewSeriesTrendInput[]> {
  const unique = [...new Set(videoIds.filter((id) => typeof id === "string" && id.length > 0))].slice(0, DESCRIPTIVE_FETCH_LIMIT);
  if (unique.length === 0) return [];
  // 배치 getAll — 영상마다 순차 왕복하면 추세 조회가 영상 수에 선형 비례해 느려진다
  // (운영 실측 2026-07-27: 114건 순차 2,627ms vs 배치 106ms). 반환 모양·순서·필터는 그대로다.
  const out: VideoViewSeriesTrendInput[] = [];
  for (let index = 0; index < unique.length; index += VIDEO_VIEW_SERIES_BATCH_SIZE) {
    const chunk = unique.slice(index, index + VIDEO_VIEW_SERIES_BATCH_SIZE);
    const docs = await db.getAll(
      ...chunk.map((videoId) => db.collection(VIDEO_VIEW_SERIES_COLLECTION).doc(videoId)),
    );
    for (const doc of docs) {
      if (!doc.exists) continue;
      const data = (doc.data() ?? {}) as Record<string, unknown>;
      out.push({
        videoId: str(data.videoId) || doc.id,
        updatedAtIso: data.updatedAtIso,
        points: Array.isArray(data.points) ? data.points as VideoViewSeriesTrendInput["points"] : [],
      });
    }
  }
  return out;
}
