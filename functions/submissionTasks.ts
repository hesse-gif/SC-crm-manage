import crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb, adminStorage } from "./firebaseAdmin";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, makeCache, makeCostLog, maskEmail, type AuthContext, type CallableRequestShape } from "./shared";
import { safeDocId } from "./sheetIntakeService";
import { normalizedReminderEmailHash } from "./scpVideoSubmissionReminderStore";
import { enqueueScpLifecycleRefreshEvent } from "./scpLifecycleProfiles";
import { enqueueVideoReviewAutomationOutboxInTransaction } from "./videoReviewAutomationOutbox";
import { videoReviewEvidenceIdentityFingerprints } from "./videoReviewEvidence";
import {
  resolveAuthoritativeVideoReviewProgramScope,
  videoReviewScopePreservingSubmissionUpdate,
} from "./videoReviewProgramScope";
import { planVideoReviewSourceInvalidation } from "./videoReviewSourceInvalidation";
import { resolveCanonicalProgramId, resolveCanonicalProgramIdentity, SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import {
  confirmedProgramScope,
  readConfirmedProgramAliasRegistryState,
  readConfirmedProgramAliasRegistryStateInTransaction,
  type ConfirmedProgramAliasRegistryState,
} from "./programAliasRegistry";
import { creatorLinkIdentityDocId } from "./creatorLinks";
import { assertMutationOwner, mutationOwnerUids, type MutationAuthorizationActor } from "./mutationAuthorization";
import {
  isStagingSafetyRuntime,
  resolveStagingUploadBucket,
  submissionUploadObjectPrefix,
} from "./stagingSafety";

const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;
const SUBMISSION_TASKS_COLLECTION = "submission_tasks";
const SUBMISSIONS_COLLECTION = "submissions";
const UPLOAD_THROTTLE_COLLECTION = "submission_upload_throttles";
const DEFAULT_PROGRAM_ID = "scp";
// flu.supercent.io is NXDOMAIN — never provisioned. The live production Hosting site is
// sc-flu.web.app; publicFormLink mounts /scp/submit/<token> on this base.
const DEFAULT_PUBLIC_FORM_BASE_URL = "https://sc-flu.web.app";
const DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 90;
const MAX_FIELDS = 50;
const MAX_FIELD_VALUE_LEN = 8000;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_URL_LEN = 2000;
const MAX_NOTE_LEN = 8000;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;
const UPLOAD_THROTTLE_WINDOW_MS = 10 * 60 * 1000;
const UPLOAD_THROTTLE_MAX = 20;
const ALLOWED_UPLOAD_TYPES = new Set(["video/mp4"]);

type PublicSubmissionField = {
  key: string;
  label: string;
  type: string;
  value: string;
  sortOrder: number | null;
};

type SubmissionTask = Record<string, unknown> & {
  id: string;
  submitToken: string;
  taskStatus: string;
  expiresAtIso: string;
};

type SubmissionUploadReservation = {
  id: string;
  bucket: string;
  objectPath: string;
  fileUrl: string;
  contentType: string;
  size: number;
  issuedAtIso: string;
  expiresAtIso: string;
  status: "issued" | "consumed";
  generation?: string;
  consumedAtIso?: string;
};

type ParsedSubmissionUpload = {
  bucket: string;
  objectPath: string;
};

export type SubmissionUploadMetadata = {
  bucket?: string | null;
  name?: string | null;
  contentType?: string | null;
  size?: string | number | null;
  generation?: string | number | null;
};

export type SubmissionUploadMetadataReader = (
  bucket: string,
  objectPath: string,
) => Promise<SubmissionUploadMetadata>;

export type SubmitPublicSubmissionOptions = {
  uploadMetadataReader?: SubmissionUploadMetadataReader;
};

type VerifiedSubmissionUpload = {
  reservation: SubmissionUploadReservation;
  bucket: string;
  objectPath: string;
  fileUrl: string;
  contentType: string;
  size: number;
  generation: string;
};

export async function issueSubmissionTask(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "submission_tasks.issue", WRITE_ROLES);
  const data = asRecord(request.data);
  const nowIso = asString(data.nowIso, new Date().toISOString());
  const leadId = exactScopedId(data.leadId, "requested lead", auth);
  if (!leadId) {
    throw withCallableError("failed-precondition", "submission task requires a qualified leadId", auth);
  }
  const leadRef = adminDb.collection("program_sheet_leads").doc(leadId);
  const leadSnapshot = await leadRef.get();
  if (!leadSnapshot.exists) {
    throw withCallableError("failed-precondition", "submission task requires an existing qualified lead", auth);
  }
  const lead = leadSnapshot.data() ?? {};
  const applicationId = submissionTaskApplicationId(data, lead, auth);
  const applicationRef = applicationId
    ? adminDb.collection("program_applications").doc(applicationId)
    : null;
  const applicationSnapshot = applicationRef ? await applicationRef.get() : null;
  if (applicationRef && !applicationSnapshot?.exists) {
    throw withCallableError("failed-precondition", "submission task application scope does not exist", auth);
  }
  const application = applicationSnapshot?.data() ?? null;
  const initialAliasRegistry = await readConfirmedProgramAliasRegistryState({ bypassCache: true });
  const initialScope = resolveSubmissionTaskProgramScope(data, leadId, lead, applicationId, application, initialAliasRegistry, auth);
  const programRefs = submissionTaskProgramRefs(initialScope, auth);
  const initialProgramSnapshots = await adminDb.getAll(...programRefs);
  const initialProgram = resolveSubmissionTaskProgramAuthority(initialProgramSnapshots, initialScope, initialAliasRegistry, auth);
  assertSubmissionTaskMutationAuthorized(auth, lead, application, initialProgram);

  const applicationCreatorId = exactScopedId(application?.creatorId, "application creator", auth);
  const leadCreatorId = submissionTaskLeadCreatorId(lead, auth);
  const explicitCreatorId = safeId(data.creatorId);
  const email = cleanEmail(data.email) || leadEmail(lead);
  const creatorLink = await resolveCreatorLink({
    leadId,
    email,
    canonicalProgramId: initialScope.canonicalProgramId,
    applicationId: initialScope.applicationId,
    aliasRegistry: initialAliasRegistry,
    auth,
  });
  const creatorLinkId = safeId(creatorLink?.id);
  const creatorLinkPath = creatorLinkId ? `creator_links/${creatorLinkId}` : "";
  const creatorLinkCampaign = text(creatorLink?.campaign, 240);
  const creatorId = initialScope.creatorId
    || explicitCreatorId
    || safeId(creatorLink?.creatorId)
    || `CR_${safeDocId(email || leadId || "scp")}`;
  const programId = initialScope.canonicalProgramId;
  const taskId = safeDocId(asString(data.taskId, submissionTaskIdentityDocId({
    canonicalProgramId: programId,
    applicationId: initialScope.applicationId,
    leadId,
    creatorId,
  })));
  const ref = adminDb.collection(SUBMISSION_TASKS_COLLECTION).doc(taskId);
  const ttlDays = boundedNumber(data.ttlDays, DEFAULT_TTL_DAYS, 1, MAX_TTL_DAYS);
  const expiresAtIso = addDaysIso(nowIso, ttlDays);
  const result = await adminDb.runTransaction(async (transaction) => {
    const currentLeadSnapshot = await transaction.get(leadRef);
    const currentApplicationSnapshot = applicationRef ? await transaction.get(applicationRef) : null;
    const snapshot = await transaction.get(ref);
    if (!currentLeadSnapshot.exists) {
      throw withCallableError("failed-precondition", "submission task requires an existing qualified lead", auth);
    }
    if (applicationRef && !currentApplicationSnapshot?.exists) {
      throw withCallableError("failed-precondition", "submission task application scope does not exist", auth);
    }
    const currentLead = currentLeadSnapshot.data() ?? {};
    const currentApplication = currentApplicationSnapshot?.data() ?? null;
    const currentApplicationId = submissionTaskApplicationId(data, currentLead, auth);
    if (currentApplicationId !== applicationId) {
      throw withCallableError("failed-precondition", "submission task application scope changed", auth);
    }
    const currentAliasRegistry = await readConfirmedProgramAliasRegistryStateInTransaction(transaction);
    const scope = resolveSubmissionTaskProgramScope(
      data,
      leadId,
      currentLead,
      currentApplicationId,
      currentApplication,
      currentAliasRegistry,
      auth,
    );
    const currentProgramSnapshots = await transaction.getAll(...submissionTaskProgramRefs(scope, auth));
    const currentProgram = resolveSubmissionTaskProgramAuthority(currentProgramSnapshots, scope, currentAliasRegistry, auth);
    assertSubmissionTaskMutationAuthorized(auth, currentLead, currentApplication, currentProgram);
    if (scope.canonicalProgramId !== initialScope.canonicalProgramId
      || scope.applicationId !== initialScope.applicationId
      || scope.applicationRef !== initialScope.applicationRef
      || scope.aliasRegistryRevision !== initialScope.aliasRegistryRevision
      || !sameStringArray(scope.identityProgramIds, initialScope.identityProgramIds)) {
      throw withCallableError("failed-precondition", "submission task authoritative scope changed", auth);
    }
    const currentApplicationCreatorId = exactScopedId(currentApplication?.creatorId, "application creator", auth);
    const currentLeadCreatorId = submissionTaskLeadCreatorId(currentLead, auth);
    if (currentApplicationCreatorId !== applicationCreatorId
      || currentLeadCreatorId !== leadCreatorId
      || scope.creatorId !== initialScope.creatorId) {
      throw withCallableError("failed-precondition", "submission task creator scope changed", auth);
    }
    const existingData = snapshot.data() as SubmissionTask | undefined;
    assertExistingSubmissionTaskScope(existingData, leadId, scope, currentAliasRegistry, auth);
    const forceNew = data.forceNewToken === true || isExpired(existingData, nowIso);
    const submitToken = !forceNew && existingData?.submitToken ? existingData.submitToken : crypto.randomUUID();
    const formLink = publicFormLink(submitToken, asString(data.baseUrl, asString(process.env.SCP_PUBLIC_FORM_BASE_URL, DEFAULT_PUBLIC_FORM_BASE_URL)));
    const currentEmail = cleanEmail(data.email) || leadEmail(currentLead) || email;
    const locale = normalizeLocale(data.locale ?? currentLead.locale);
    const contentType = text(data.contentType, 120) || "weaponrpg_scp_video";
    const task = {
      id: taskId,
      leadId,
      leadRef: leadRef.path,
      creatorId,
      creatorLinkRef: creatorLinkPath || null,
      campaign: creatorLinkCampaign || null,
      programId: scope.canonicalProgramId,
      canonicalProgramId: scope.canonicalProgramId,
      programIdentityIds: scope.identityProgramIds,
      aliasRegistryRevision: scope.aliasRegistryRevision,
      ...(scope.applicationId ? {
        applicationId: scope.applicationId,
        applicationRef: scope.applicationRef,
      } : {}),
      qualificationPolicyHash: scope.qualificationPolicyHash || null,
      videoReviewPolicySnapshot: scope.videoReviewPolicySnapshot,
      email: currentEmail,
      emailMasked: maskEmail(currentEmail),
      channelName: text(data.channelName, 160) || leadChannelName(currentLead) || currentEmail || creatorId,
      country: text(data.country, 80) || asString(currentLead.country, ""),
      submitToken,
      taskStatus: "issued",
      expiresAtIso,
      locale,
      contentType,
      app: text(data.app, 120) || text(data.appName, 120) || text(currentApplication?.programTitle, 120) || "SCP Content Submission",
      formTitle: text(data.formTitle, 160) || "SCP Content Submission",
      formInstructions: text(data.formInstructions, 3000) || "Submit your published content URL and optional MP4 source file for review.",
      requiredFields: stringList(data.requiredFields).length ? stringList(data.requiredFields, MAX_FIELDS) : ["youtube_url"],
      formTemplateSnapshot: formTemplateSnapshot(locale),
      formLink,
      source: "scp_submission_task",
      updatedAtIso: nowIso,
      updatedBy: auth.userId,
      createdAtIso: asString(existingData?.createdAtIso, nowIso),
      createdBy: asString(existingData?.createdBy, auth.userId),
    };
    transaction.set(ref, {
      ...task,
      createdAt: snapshot.exists ? snapshot.data()?.createdAt ?? FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    // The global lead fields are a compatibility mirror for the canonical SCP lane only.
    // Native programs are application-scoped and must never overwrite another program's
    // task/link state on the shared lead document.
    if (scope.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID) {
      transaction.set(leadRef, {
        creatorId,
        canonicalProgramId: scope.canonicalProgramId,
        aliasRegistryRevision: scope.aliasRegistryRevision,
        submissionTaskRef: ref.path,
        submissionTaskStatus: "issued",
        formLink,
        updatedAtIso: nowIso,
      }, { merge: true });
    }
    if (applicationRef) {
      transaction.set(applicationRef, {
        creatorId,
        canonicalProgramId: scope.canonicalProgramId,
        aliasRegistryRevision: scope.aliasRegistryRevision,
        submissionTaskRef: ref.path,
        submissionTaskStatus: "issued",
        formLink,
        updatedAtIso: nowIso,
      }, { merge: true });
    }
    return { task, formLink, email: currentEmail };
  });
  await enqueueScpLifecycleRefreshEvent({
    source: "submission_tasks",
    sourceRef: ref.path,
    reason: "submission_task_issued",
    aliases: [{ leadId, creatorId, email: result.email }],
    sourceUpdatedAtIso: nowIso,
  });
  if (initialScope.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID) {
    await enqueueScpLifecycleRefreshEvent({
      source: "program_sheet_leads",
      sourceRef: `program_sheet_leads/${leadId}`,
      reason: "submission_task_ref_updated",
      aliases: [{ leadId, creatorId, email: result.email }],
      sourceUpdatedAtIso: nowIso,
    });
  }


  return {
    ok: true,
    task: result.task,
    taskRef: ref.path,
    formLink: result.formLink,
    cache: makeCache(`submission_tasks:${taskId}`, false),
    costLog: makeCostLog("submission_tasks.issue", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, `submission_tasks.issue(${taskId})`, "success", "scp-automation"),
  };
}

export async function getPublicSubmissionForm(request: CallableRequestShape) {
  assertPublicAppCheck(request, "submission_form.public.read");
  const data = asRecord(request.data);
  const token = tokenString(data.token);
  if (!token) throw publicError("not-found", "submission form not found", request, "submission_form.public.read");
  const taskDoc = await taskByToken(token);
  if (!taskDoc) throw publicError("not-found", "submission form not found", request, "submission_form.public.read");
  const task = taskDoc.data() as SubmissionTask;
  if (isExpired(task)) {
    const expiredAtIso = new Date().toISOString();
    await taskDoc.ref.set({ taskStatus: "expired", expiredAtIso, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await enqueueScpLifecycleRefreshEvent({
      source: "submission_tasks",
      sourceRef: taskDoc.ref.path,
      reason: "submission_task_expired",
      aliases: [{
        leadId: asString(task.leadId),
        creatorId: asString(task.creatorId),
        email: asString(task.email),
      }],
      sourceUpdatedAtIso: expiredAtIso,
    });
    throw publicError("not-found", "submission form not found", request, "submission_form.public.read");
  }
  return {
    ok: true,
    form: publicFormPayload(taskDoc.id, task),
    cache: makeCache(`submission_form:${token.slice(0, 8)}`, false),
    behaviorLog: makeBehaviorLog(publicAuthContext(request), "submission_form.public.read", "success", "scp-automation"),
  };
}

export async function createSubmissionUploadUrl(request: CallableRequestShape) {
  assertPublicAppCheck(request, "submission_form.upload_url");
  const data = asRecord(request.data);
  const token = tokenString(data.token);
  if (!token) throw publicError("not-found", "submission form not found", request, "submission_form.upload_url");
  const taskDoc = await taskByToken(token);
  if (!taskDoc) throw publicError("not-found", "submission form not found", request, "submission_form.upload_url");
  const task = taskDoc.data() as SubmissionTask;
  if (isExpired(task)) throw publicError("not-found", "submission form not found", request, "submission_form.upload_url");

  const filename = text(data.filename, 240) || "upload.mp4";
  const contentType = text(data.contentType, 120).toLowerCase() || "video/mp4";
  const size = boundedFileSize(data.size);
  if (!ALLOWED_UPLOAD_TYPES.has(contentType)) {
    throw publicError("invalid-argument", "unsupported file type; only video/mp4 is allowed", request, "submission_form.upload_url");
  }
  if (size <= 0 || size > MAX_UPLOAD_BYTES) {
    throw publicError("invalid-argument", "file is too large", request, "submission_form.upload_url");
  }
  // Resolve the staging-only bucket before allocating throttle/reservation
  // state. A missing explicit bucket must fail without leaving DB artifacts.
  const stagingBucketName = isStagingSafetyRuntime() ? resolveStagingUploadBucket() : "";
  const issuedAtIso = new Date().toISOString();
  const submissionRef = adminDb.collection(SUBMISSIONS_COLLECTION).doc(safeDocId(taskDoc.id));
  // Reject terminal/in-review states before allocating throttle state or signing an upload URL.
  // The same predicate is rechecked in the reservation write transaction below to close races.
  await adminDb.runTransaction(async (transaction) => {
    const currentTask = await transaction.get(taskDoc.ref);
    const currentSubmission = await transaction.get(submissionRef);
    assertSubmissionUploadIssuanceAllowed(
      currentTask.exists,
      currentTask.data() as SubmissionTask | undefined,
      currentSubmission.exists,
      currentSubmission.data(),
      token,
      issuedAtIso,
      request,
    );
  });
  const throttleRef = await checkUploadThrottle(token, request, issuedAtIso);
  const uploadId = crypto.randomUUID();
  const downloadToken = crypto.randomUUID();
  const objectPath = `${submissionUploadObjectPrefix()}${safeDocId(taskDoc.id)}/${Date.parse(issuedAtIso)}-${uploadId}${safeUploadExt(filename)}`;
  const contentLengthRange = `0,${MAX_UPLOAD_BYTES}`;
  const requiredHeaders = {
    "Content-Type": contentType,
    "x-goog-if-generation-match": "0",
    "x-goog-meta-firebaseStorageDownloadTokens": downloadToken,
    "x-goog-content-length-range": contentLengthRange,
  };
  const emulatorRuntime = isEmulatorRuntime();
  const bucket = emulatorRuntime
    ? null
    : stagingBucketName
      ? adminStorage.bucket(stagingBucketName)
      : adminStorage.bucket();
  const bucketName = stagingBucketName || bucket?.name || `${process.env.GCLOUD_PROJECT || "demo-flu"}.appspot.com`;
  const uploadUrl = emulatorRuntime
    ? `http://127.0.0.1/mock-signed-upload/${encodeURIComponent(objectPath)}`
    : (await bucket!.file(objectPath).getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + UPLOAD_URL_TTL_MS,
      contentType,
      extensionHeaders: {
        "x-goog-if-generation-match": "0",
        "x-goog-meta-firebaseStorageDownloadTokens": downloadToken,
        "x-goog-content-length-range": contentLengthRange,
      },
    }))[0];
  const fileUrl = firebaseDownloadUrl(bucketName, objectPath, downloadToken);
  const uploadReservation: SubmissionUploadReservation = {
    id: uploadId,
    bucket: bucketName.toLowerCase(),
    objectPath,
    fileUrl,
    contentType,
    size,
    issuedAtIso,
    expiresAtIso: new Date(Date.parse(issuedAtIso) + UPLOAD_URL_TTL_MS).toISOString(),
    status: "issued",
  };
  await adminDb.runTransaction(async (transaction) => {
    const current = await transaction.get(taskDoc.ref);
    const currentSubmission = await transaction.get(submissionRef);
    assertSubmissionUploadIssuanceAllowed(
      current.exists,
      current.data() as SubmissionTask | undefined,
      currentSubmission.exists,
      currentSubmission.data(),
      token,
      issuedAtIso,
      request,
    );
    transaction.set(taskDoc.ref, {
      uploadReservation,
      updatedAtIso: issuedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  return {
    ok: true,
    uploadUrl,
    method: "PUT",
    requiredHeaders,
    fileUrl,
    objectPath,
    uploadReservationId: uploadId,
    maxBytes: MAX_UPLOAD_BYTES,
    expiresInMs: UPLOAD_URL_TTL_MS,
    throttleRef,
    cache: makeCache(`submission_upload:${token.slice(0, 8)}`, false),
    behaviorLog: makeBehaviorLog(publicAuthContext(request), "submission_form.upload_url", "success", "scp-automation"),
  };
}

export async function submitPublicSubmission(
  request: CallableRequestShape,
  options: SubmitPublicSubmissionOptions = {},
) {
  assertPublicAppCheck(request, "submission_form.submit");
  const data = asRecord(request.data);
  const token = tokenString(data.token);
  if (!token) throw publicError("not-found", "submission form not found", request, "submission_form.submit");
  assertPayloadSize(data, request);
  const taskDoc = await taskByToken(token);
  if (!taskDoc) throw publicError("not-found", "submission form not found", request, "submission_form.submit");
  const initialTask = taskDoc.data() as SubmissionTask;
  const nowIso = new Date().toISOString();
  if (isExpired(initialTask, nowIso)) {
    throw publicError("not-found", "submission form not found", request, "submission_form.submit");
  }
  const parsed = parseSubmissionPayload(data, request);
  const taskRef = taskDoc.ref;
  const submissionRef = adminDb.collection(SUBMISSIONS_COLLECTION).doc(safeDocId(taskDoc.id));
  const requestFingerprint = submissionRequestFingerprint(parsed);
  const preflightSubmission = await submissionRef.get();
  const preflightData = preflightSubmission.data() ?? {};
  if (preflightSubmission.exists
    && !hasTerminalSubmissionLifecycle(initialTask, preflightData)
    && submissionIsIdempotent(preflightData, requestFingerprint)) {
    return {
      ok: true,
      submissionId: submissionRef.id,
      submissionRef: submissionRef.path,
      reviewStatus: asString(preflightData.reviewStatus, "pending"),
      resubmitted: false,
      idempotent: true,
    };
  }
  const verifiedUpload = await verifySubmissionUpload(
    taskDoc.id,
    initialTask,
    parsed.uploadedFile,
    parsed.uploadedFileGeneration,
    nowIso,
    request,
    options.uploadMetadataReader ?? readSubmissionUploadMetadata,
  );

  const result = await adminDb.runTransaction(async (transaction) => {
    const taskSnapshot = await transaction.get(taskRef);
    if (!taskSnapshot.exists) return { code: "no_task" as const };
    const task = taskSnapshot.data() as SubmissionTask;
    if (tokenString(task.submitToken) !== token) return { code: "no_task" as const };
    if (isExpired(task, nowIso)) return { code: "expired" as const };
    const existingSubmission = await transaction.get(submissionRef);
    const existingData = existingSubmission.exists ? existingSubmission.data() ?? {} : null;
    // Re-read the canonical lifecycle inside the same transaction that may reset review/payment
    // fields. An upload reservation can outlive a later approval or payment, and Storage metadata
    // verification happens before this transaction, so neither earlier check is authoritative here.
    if (hasTerminalSubmissionLifecycle(task, existingData ?? undefined)) {
      return { code: "lifecycle_locked" as const };
    }
    // Case J (재제출): a creator who was asked to revise (reviewStatus
    // "needs_review") may submit again through the same token form. Any other
    // existing state (pending/approved/rejected/paid) stays locked as a first
    // submission — this is not a general "overwrite" path.
    const taskStatus = asString(task.taskStatus).trim().toLowerCase();
    const isFirstSubmission = !existingSubmission.exists && taskStatus === "issued";
    const isResubmission = existingData !== null
      && taskStatus === "submitted"
      && asString(existingData.reviewStatus, "pending").trim().toLowerCase() === "needs_review";
    if (!isFirstSubmission && !isResubmission) {
      if (existingData && submissionIsIdempotent(existingData, requestFingerprint)) {
        return { code: "idempotent" as const, reviewStatus: asString(existingData.reviewStatus, "pending") };
      }
      return { code: "already_submitted" as const };
    }
    if (verifiedUpload && !reservationMatchesVerifiedUpload(task, verifiedUpload, nowIso)) {
      return { code: "invalid_upload" as const };
    }
    let taskProgramIdentity;
    let existingProgramIdentity;
    try {
      taskProgramIdentity = resolveCanonicalProgramIdentity({
        programId: task.programId,
        canonicalProgramId: task.canonicalProgramId,
        programIdAlias: task.programIdAlias,
        fallbackProgramId: DEFAULT_PROGRAM_ID,
      });
      existingProgramIdentity = existingData
        ? resolveCanonicalProgramIdentity({
          programId: existingData.programId,
          canonicalProgramId: existingData.canonicalProgramId,
          programIdAlias: existingData.programIdAlias,
          fallbackProgramId: taskProgramIdentity.canonicalProgramId,
        })
        : null;
    } catch {
      return { code: "program_scope_conflict" as const };
    }
    if (existingProgramIdentity && existingProgramIdentity.canonicalProgramId !== taskProgramIdentity.canonicalProgramId) {
      return { code: "program_scope_conflict" as const };
    }
    const canonicalProgramId = taskProgramIdentity.canonicalProgramId;
    const existingAlias = asString(existingData?.programIdAlias, "");
    const rawProgramIdAlias = taskProgramIdentity.rawProgramIdAlias
      ?? existingProgramIdentity?.rawProgramIdAlias
      ?? (existingAlias !== canonicalProgramId && resolveCanonicalProgramId(existingAlias) === canonicalProgramId ? existingAlias : null);
    const taskScopeFields = {
      taskId: taskRef.id,
      taskRef: taskRef.path,
      programId: canonicalProgramId,
      canonicalProgramId,
      programIdAlias: rawProgramIdAlias !== canonicalProgramId ? rawProgramIdAlias : null,
      leadId: asString(task.leadId, "") || null,
      leadRef: asString(task.leadRef, asString(task.leadId) ? `program_sheet_leads/${asString(task.leadId)}` : "") || null,
      normalizedEmailHash: normalizedReminderEmailHash(task.email) || null,
      applicationId: asString(task.applicationId, "") || null,
      applicationRef: asString(task.applicationRef, "") || null,
      qualificationPolicyHash: asString(task.qualificationPolicyHash, "") || null,
      videoReviewPolicySnapshot: boundedTaskPolicyRecord(task.videoReviewPolicySnapshot),
    };
    const uploadedFileGcsUri = verifiedUpload
      ? canonicalSubmissionUploadGcsUri(verifiedUpload.bucket, verifiedUpload.objectPath)
      : "";
    const formResponses = parsed.fields.map((field, index) => ({
      fieldKey: field.key,
      fieldLabel: field.label,
      fieldType: field.type,
      answerText: field.type === "file" && verifiedUpload ? verifiedUpload.fileUrl : field.value,
      sortOrder: field.sortOrder ?? index,
    }));
    const contentFieldsBase = {
      youtubeUrl: parsed.youtubeUrl,
      tiktokUrl: parsed.tiktokUrl,
      instaUrl: parsed.instaUrl,
      instagramUrl: parsed.instaUrl,
      uploadedFileUrl: verifiedUpload?.fileUrl ?? "",
      uploadedFileContentType: verifiedUpload?.contentType ?? "",
      uploadedFileGeneration: verifiedUpload?.generation ?? "",
      uploadedFileSize: verifiedUpload?.size ?? null,
      uploadedFileBucket: verifiedUpload?.bucket ?? "",
      uploadedFileObjectPath: verifiedUpload?.objectPath ?? "",
      // Persist the credential-free canonical object identity together with the immutable
      // generation verified by the server. A resubmission replaces (never inherits) this
      // descriptor, so downstream reviewers cannot silently reuse a superseded upload.
      uploadedFileGcsUri,
      uploadedMedia: verifiedUpload ? {
        source: "gcs",
        bucket: verifiedUpload.bucket,
        objectPath: verifiedUpload.objectPath,
        gcsUri: uploadedFileGcsUri,
        mimeType: verifiedUpload.contentType,
        generation: verifiedUpload.generation,
        size: verifiedUpload.size,
        verifiedAtIso: nowIso,
      } : null,
      contentUrls: parsed.contentUrls,
      submitNote: parsed.submitNote,
      formResponses,
      submissionRequestFingerprint: requestFingerprint,
    };
    const contentFields = {
      ...contentFieldsBase,
      videoReviewEvidenceIdentityFingerprints: videoReviewEvidenceIdentityFingerprints({
        ...contentFieldsBase,
        submittedAtIso: nowIso,
        resubmissionCount: existingData ? (Array.isArray(existingData.revisions) ? existingData.revisions.length + 1 : 1) : 0,
      }),
    };
    const consumedUploadPatch = verifiedUpload ? {
      uploadReservation: {
        ...verifiedUpload.reservation,
        status: "consumed" as const,
        generation: verifiedUpload.generation,
        consumedAtIso: nowIso,
      },
    } : {};

    if (isResubmission && existingData) {
      // Archive the superseded revision (append-only history) and reset the
      // submission back to pending review without discarding prior review notes.
      const priorRevisions = Array.isArray(existingData.revisions) ? existingData.revisions : [];
      const revisions = [
        ...priorRevisions,
        {
          revision: priorRevisions.length + 1,
          supersededAtIso: nowIso,
          reviewStatus: asString(existingData.reviewStatus, "needs_review"),
          youtubeUrl: asString(existingData.youtubeUrl, ""),
          uploadedFileUrl: asString(existingData.uploadedFileUrl, ""),
          contentUrls: Array.isArray(existingData.contentUrls) ? existingData.contentUrls : [],
          submittedAtIso: asString(existingData.submittedAtIso, ""),
        },
      ];
      const nextSubmissionSource = {
        ...existingData,
        ...taskScopeFields,
        ...contentFields,
        id: submissionRef.id,
        submittedAtIso: nowIso,
        updatedAtIso: nowIso,
        resubmissionCount: priorRevisions.length + 1,
      };
      const authoritativeProgramScope = await resolveAuthoritativeVideoReviewProgramScope(nextSubmissionSource, {
        recordReader: async (collection, documentId) => {
          const related = await transaction.get(adminDb.collection(collection).doc(documentId));
          return related.exists ? { id: related.id, ...(related.data() ?? {}) } : null;
        },
      });
      const sourceInvalidation = planVideoReviewSourceInvalidation({
        existingSubmission: existingData,
        nextSubmission: nextSubmissionSource,
        nowIso,
        programScope: authoritativeProgramScope,
      });
      await enqueueVideoReviewAutomationOutboxInTransaction(transaction, {
        submissionId: submissionRef.id,
        kind: "ai_recommendation",
        nowIso,
        source: nextSubmissionSource,
        sourceFingerprint: sourceInvalidation.nextAutomationSourceFingerprint,
        programScope: sourceInvalidation.programScope,
      });
      transaction.update(submissionRef, videoReviewScopePreservingSubmissionUpdate({
        ...taskScopeFields,
        ...contentFields,
        reviewStatus: "pending",
        rejectedReason: "",
        payment: null,
        payableStatus: "not_payable",
        revisions,
        resubmissionCount: priorRevisions.length + 1,
        resubmittedAtIso: nowIso,
        submittedAtIso: nowIso,
        submittedAt: FieldValue.serverTimestamp(),
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
        ...sourceInvalidation.submissionPatch,
      }));
      transaction.set(taskRef, {
        taskStatus: "submitted",
        resubmittedAtIso: nowIso,
        submissionRef: submissionRef.path,
        ...consumedUploadPatch,
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(adminDb.collection("submission_review_counts").doc(canonicalProgramId), {
        id: canonicalProgramId,
        programId: canonicalProgramId,
        programIdAlias: rawProgramIdAlias !== canonicalProgramId ? rawProgramIdAlias : null,
        statuses: { needs_review: FieldValue.increment(-1), pending: FieldValue.increment(1) },
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { code: "ok" as const, resubmitted: true };
    }

    const submission = {
      id: submissionRef.id,
      ...taskScopeFields,
      creatorId: asString(task.creatorId, ""),
      creatorLinkRef: asString(task.creatorLinkRef, "") || null,
      campaign: asString(task.campaign, "") || null,
      email: asString(task.email, ""),
      normalizedEmailHash: normalizedReminderEmailHash(task.email) || null,
      app: asString(task.app, asString(task.appName, "Weapon RPG SCP")),
      ...contentFields,
      contentType: asString(task.contentType, "weaponrpg_scp_video"),
      submittedAtIso: nowIso,
      submittedAt: FieldValue.serverTimestamp(),
      token,
      reviewStatus: "pending",
      rejectedReason: "",
      reviewNotes: [],
      reviewMemo: "",
      aiRecommendation: null,
      aiRecommendationMultimodal: null,
      payment: null,
      payableStatus: "not_payable",
      revisions: [],
      resubmissionCount: 0,
      countsInitialized: true,
      source: "scp_public_submission_form",
      updatedAtIso: nowIso,
    };
    const authoritativeProgramScope = await resolveAuthoritativeVideoReviewProgramScope(submission, {
      recordReader: async (collection, documentId) => {
        const related = await transaction.get(adminDb.collection(collection).doc(documentId));
        return related.exists ? { id: related.id, ...(related.data() ?? {}) } : null;
      },
    });
    const initialSourcePlan = planVideoReviewSourceInvalidation({
      existingSubmission: null,
      nextSubmission: submission,
      nowIso,
      programScope: authoritativeProgramScope,
    });
    await enqueueVideoReviewAutomationOutboxInTransaction(transaction, {
      submissionId: submissionRef.id,
      kind: "ai_recommendation",
      nowIso,
      source: submission,
      sourceFingerprint: initialSourcePlan.nextAutomationSourceFingerprint,
      programScope: initialSourcePlan.programScope,
    });
    transaction.create(submissionRef, submission);
    transaction.set(taskRef, {
      taskStatus: "submitted",
      submittedAtIso: nowIso,
      submissionRef: submissionRef.path,
      ...consumedUploadPatch,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(adminDb.collection("submission_review_counts").doc(canonicalProgramId), {
      id: canonicalProgramId,
      programId: canonicalProgramId,
      programIdAlias: rawProgramIdAlias !== canonicalProgramId ? rawProgramIdAlias : null,
      statuses: { pending: FieldValue.increment(1) },
      payments: { not_payable: FieldValue.increment(1) },
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { code: "ok" as const, submission };
  });

  if (result.code === "no_task" || result.code === "expired") {
    throw publicError("not-found", "submission form not found", request, "submission_form.submit");
  }
  if (result.code === "already_submitted") {
    throw publicError("already-exists", "submission already submitted", request, "submission_form.submit");
  }
  if (result.code === "lifecycle_locked") {
    throw publicError(
      "failed-precondition",
      "submission is not allowed for the current submission state",
      request,
      "submission_form.submit",
    );
  }
  if (result.code === "program_scope_conflict") {
    throw publicError(
      "failed-precondition",
      "submission program scope is invalid",
      request,
      "submission_form.submit",
    );
  }
  if (result.code === "invalid_upload") {
    throw publicError("invalid-argument", "uploaded file no longer matches the server-issued upload reservation", request, "submission_form.submit");
  }
  if (result.code === "idempotent") {
    return {
      ok: true,
      submissionId: submissionRef.id,
      submissionRef: submissionRef.path,
      reviewStatus: result.reviewStatus,
      resubmitted: false,
      idempotent: true,
    };
  }
  const taskForLifecycle = taskDoc.data() as SubmissionTask;
  await enqueueScpLifecycleRefreshEvent({
    source: "submissions",
    sourceRef: submissionRef.path,
    reason: "public_submission_received",
    aliases: [{
      submissionId: submissionRef.id,
      leadId: asString(taskForLifecycle.leadId),
      creatorId: asString(taskForLifecycle.creatorId),
      email: asString(taskForLifecycle.email),
    }],
    sourceUpdatedAtIso: nowIso,
  });
  await enqueueScpLifecycleRefreshEvent({
    source: "submission_tasks",
    sourceRef: taskRef.path,
    reason: "submission_task_submitted",
    aliases: [{
      submissionId: submissionRef.id,
      leadId: asString(taskForLifecycle.leadId),
      creatorId: asString(taskForLifecycle.creatorId),
      email: asString(taskForLifecycle.email),
    }],
    sourceUpdatedAtIso: nowIso,
  });
  return {
    ok: true,
    submissionId: submissionRef.id,
    submissionRef: submissionRef.path,
    reviewStatus: "pending",
    resubmitted: "resubmitted" in result,
    idempotent: false,
    behaviorLog: makeBehaviorLog(publicAuthContext(request), `submission_form.submit(${submissionRef.id})`, "success", "scp-automation"),
  };
}

type SubmissionTaskProgramScope = {
  canonicalProgramId: string;
  identityProgramIds: string[];
  aliasRegistryRevision: string;
  applicationId: string;
  applicationRef: string;
  creatorId: string;
  qualificationPolicyHash: string;
  videoReviewPolicySnapshot: Record<string, unknown>;
};

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function submissionTaskProgramRefs(
  scope: SubmissionTaskProgramScope,
  auth: AuthContext,
): FirebaseFirestore.DocumentReference[] {
  const canonicalProgramDocId = safeId(scope.canonicalProgramId);
  if (!canonicalProgramDocId || canonicalProgramDocId !== scope.canonicalProgramId) {
    throw withCallableError("failed-precondition", "submission task program identity is invalid", auth);
  }
  const docIds = [...new Set([canonicalProgramDocId, ...scope.identityProgramIds])];
  if (docIds.some((programId) => safeId(programId) !== programId)) {
    throw withCallableError("failed-precondition", "submission task confirmed program identity is invalid", auth);
  }
  return docIds.map((programId) => adminDb.collection("programs").doc(programId));
}

function resolveSubmissionTaskProgramAuthority(
  snapshots: readonly FirebaseFirestore.DocumentSnapshot[],
  scope: SubmissionTaskProgramScope,
  aliasRegistry: ConfirmedProgramAliasRegistryState,
  auth: AuthContext,
): Record<string, unknown> {
  const snapshot = snapshots.find((candidate) => candidate.exists) ?? null;
  if (!snapshot) {
    throw withCallableError("failed-precondition", "submission task program scope does not exist", auth);
  }
  const storedProgram = snapshot.data() ?? {};
  const declaredProgramIds = [...new Set([
    snapshot.id,
    exactScopedId(storedProgram.id, "program identity", auth),
    exactScopedId(storedProgram.canonicalProgramId, "program canonical identity", auth),
    exactScopedId(storedProgram.programId, "program declared identity", auth),
  ]
    .map((value) => resolveCanonicalProgramId(value, aliasRegistry.aliasMap))
    .filter(Boolean))];
  if (
    !scope.identityProgramIds.includes(snapshot.id)
    || aliasRegistry.revision !== scope.aliasRegistryRevision
    || declaredProgramIds.length !== 1
    || declaredProgramIds[0] !== scope.canonicalProgramId
  ) {
    throw withCallableError("failed-precondition", "submission task program authority does not match the application or lead", auth);
  }
  return { ...storedProgram, id: snapshot.id };
}

function assertSubmissionTaskMutationAuthorized(
  auth: AuthContext,
  lead: Record<string, unknown>,
  application: Record<string, unknown> | null,
  program: Record<string, unknown> | null,
): void {
  const actor: MutationAuthorizationActor = { uid: auth.userId, role: auth.role };
  const programOwners = mutationOwnerUids(program, { includeCreatedBy: true });
  assertMutationOwner(actor, programOwners, "submission task program");

  const applicationOwners = mutationOwnerUids(application, { includeCreatedBy: true });
  if (application) {
    assertMutationOwner(actor, applicationOwners, "submission task application");
  }

  // program_sheet_leads is a global source/identity row and older Sheet-backed rows
  // intentionally have no account owner. When it does declare ownership, however,
  // it must agree with the authoritative program/application owner.
  const leadOwners = mutationOwnerUids(lead, { includeCreatedBy: true });
  if (leadOwners.length) {
    assertMutationOwner(actor, leadOwners, "submission task lead");
  }
  assertMutationOwner(
    actor,
    [...programOwners, ...applicationOwners, ...leadOwners],
    "submission task program/application/lead",
  );
}

export function submissionTaskIdentityDocId(input: {
  canonicalProgramId: string;
  applicationId: string;
  leadId: string;
  creatorId: string;
}): string {
  if (input.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID && !input.applicationId) {
    return safeDocId(`${input.canonicalProgramId}:${input.creatorId}`);
  }
  return safeDocId(`submission-task:${input.canonicalProgramId}:${input.applicationId || "legacy"}:${input.leadId || input.creatorId}`);
}

function exactScopedId(value: unknown, label: string, auth: AuthContext): string {
  const raw = text(value, 300);
  if (!raw) return "";
  if (safeId(raw) !== raw) {
    throw withCallableError("failed-precondition", `submission task ${label} identity is invalid`, auth);
  }
  return raw;
}

function documentIdFromRef(value: unknown, collection: string, label: string, auth: AuthContext): string {
  const raw = text(value, 300);
  if (!raw) return "";
  const match = new RegExp(`^${collection}/([^/]+)$`).exec(raw);
  if (!match || safeId(match[1]) !== match[1]) {
    throw withCallableError("failed-precondition", `submission task ${label} reference is invalid`, auth);
  }
  return match[1];
}

function applicationIdFromRef(value: unknown, auth: AuthContext): string {
  return documentIdFromRef(value, "program_applications", "application", auth);
}

function leadIdFromRef(value: unknown, auth: AuthContext): string {
  return documentIdFromRef(value, "program_sheet_leads", "lead", auth);
}

function programIdFromRef(value: unknown, auth: AuthContext): string {
  return documentIdFromRef(value, "programs", "program", auth);
}

function submissionTaskApplicationId(
  data: Record<string, unknown>,
  lead: Record<string, unknown>,
  auth: AuthContext,
): string {
  const explicitCandidates = [
    exactScopedId(data.applicationId, "requested application", auth),
    applicationIdFromRef(data.applicationRef, auth),
  ].filter(Boolean);
  const explicitDistinct = [...new Set(explicitCandidates)];
  if (explicitDistinct.length > 1) {
    throw withCallableError("failed-precondition", "submission task application scope is ambiguous", auth);
  }
  const leadCandidates = [
    exactScopedId(lead.applicationId, "lead application", auth),
    applicationIdFromRef(lead.applicationRef, auth),
    applicationIdFromRef(lead.bridgedApplicationRef, auth),
  ].filter(Boolean);
  const leadDistinct = [...new Set(leadCandidates)];
  if (leadDistinct.length > 1) {
    throw withCallableError("failed-precondition", "submission task application scope is ambiguous", auth);
  }
  if (explicitDistinct[0]) {
    if (leadDistinct.length !== 1 || leadDistinct[0] !== explicitDistinct[0]) {
      throw withCallableError("failed-precondition", "submission task lead application scope does not match the request", auth);
    }
    return explicitDistinct[0];
  }
  return leadDistinct[0] ?? "";
}

function submissionTaskLeadCreatorId(lead: Record<string, unknown>, auth: AuthContext): string {
  const creatorIds = [...new Set([
    exactScopedId(lead.creatorId, "lead creator", auth),
    exactScopedId(lead.bridgedCreatorId, "lead bridged creator", auth),
  ].filter(Boolean))];
  if (creatorIds.length > 1) {
    throw withCallableError("failed-precondition", "submission task lead creator scope is ambiguous", auth);
  }
  return creatorIds[0] ?? "";
}

function qualificationPassed(record: Record<string, unknown> | null): boolean {
  if (!record) return false;
  const status = asString(record.qualificationStatus, asString(record.finalVerdict, "")).trim().toLowerCase();
  return status === "pass" || status === "approved";
}

function boundedTaskPolicyRecord(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 5) return {};
  const result: Record<string, unknown> = {};
  for (const [rawKey, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    const key = rawKey.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80);
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (!key || /(?:email|token|secret|credential|credentials|password|apikey|privatekey)$/.test(normalizedKey)) continue;
    if (Array.isArray(child)) {
      result[key] = child.slice(0, 50).map((item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) return boundedTaskPolicyRecord(item, depth + 1);
        if (typeof item === "string") return item.replace(/\s+/g, " ").trim().slice(0, 500);
        return typeof item === "number" && Number.isFinite(item) || typeof item === "boolean" || item === null ? item : null;
      });
    } else if (child && typeof child === "object") {
      result[key] = boundedTaskPolicyRecord(child, depth + 1);
    } else if (typeof child === "string") {
      result[key] = child.replace(/\s+/g, " ").trim().slice(0, 500);
    } else if (typeof child === "number" && Number.isFinite(child) || typeof child === "boolean" || child === null) {
      result[key] = child;
    }
  }
  return result;
}

function resolveSubmissionTaskProgramScope(
  data: Record<string, unknown>,
  leadId: string,
  lead: Record<string, unknown>,
  applicationId: string,
  application: Record<string, unknown> | null,
  aliasRegistry: ConfirmedProgramAliasRegistryState,
  auth: AuthContext,
): SubmissionTaskProgramScope {
  const declaredLeadIds = [...new Set([
    exactScopedId(lead.id, "lead", auth),
    exactScopedId(lead.leadId, "lead", auth),
  ].filter(Boolean))];
  if (declaredLeadIds.some((declaredLeadId) => declaredLeadId !== leadId)) {
    throw withCallableError("failed-precondition", "submission task lead identity does not match the requested document", auth);
  }

  const expectedApplicationRef = applicationId ? `program_applications/${applicationId}` : "";
  if (applicationId) {
    if (!application) {
      throw withCallableError("failed-precondition", "submission task application scope does not exist", auth);
    }
    const storedApplicationId = exactScopedId(application.id, "application", auth);
    if (storedApplicationId && storedApplicationId !== applicationId) {
      throw withCallableError("failed-precondition", "submission task application identity does not match", auth);
    }
    const storedApplicationRef = text(application.applicationRef, 300);
    if (storedApplicationRef
      && applicationIdFromRef(storedApplicationRef, auth) !== applicationId) {
      throw withCallableError("failed-precondition", "submission task application reference does not match", auth);
    }
    const applicationLeadIds = [...new Set([
      exactScopedId(application.leadId, "application lead", auth),
      leadIdFromRef(application.leadRef, auth),
    ].filter(Boolean))];
    if (applicationLeadIds.length !== 1 || applicationLeadIds[0] !== leadId) {
      throw withCallableError("failed-precondition", "submission task application does not own the lead", auth);
    }
    const leadApplicationIds = [...new Set([
      exactScopedId(lead.applicationId, "lead application", auth),
      applicationIdFromRef(lead.applicationRef, auth),
      applicationIdFromRef(lead.bridgedApplicationRef, auth),
    ].filter(Boolean))];
    if (leadApplicationIds.length !== 1 || leadApplicationIds[0] !== applicationId) {
      throw withCallableError("failed-precondition", "submission task lead application scope does not match", auth);
    }
    if (!qualificationPassed(application)) {
      throw withCallableError("failed-precondition", "submission task can be issued only after application qualification pass", auth);
    }
  } else if (!qualificationPassed(lead)) {
    throw withCallableError("failed-precondition", "submission task can be issued only after qualification pass", auth);
  }

  const requestProgramIds = [...new Set([
    exactScopedId(data.canonicalProgramId, "requested canonical program", auth),
    exactScopedId(data.programId, "requested program", auth),
    programIdFromRef(data.programRef, auth),
  ].map((value) => resolveCanonicalProgramId(value, aliasRegistry.aliasMap)).filter(Boolean))];
  const leadProgramIds = [...new Set([
    exactScopedId(lead.canonicalProgramId, "lead canonical program", auth),
    exactScopedId(lead.programId, "lead program", auth),
    exactScopedId(lead.bridgedProgramId, "lead bridged program", auth),
    programIdFromRef(lead.programRef, auth),
  ].map((value) => resolveCanonicalProgramId(value, aliasRegistry.aliasMap)).filter(Boolean))];
  const applicationProgramIds = [...new Set([
    exactScopedId(application?.canonicalProgramId, "application canonical program", auth),
    exactScopedId(application?.programId, "application program", auth),
    programIdFromRef(application?.programRef, auth),
  ].map((value) => resolveCanonicalProgramId(value, aliasRegistry.aliasMap)).filter(Boolean))];
  if (requestProgramIds.length > 1 || leadProgramIds.length > 1 || applicationProgramIds.length > 1) {
    throw withCallableError("failed-precondition", "submission task program scope is ambiguous", auth);
  }
  if (applicationId && (leadProgramIds.length !== 1 || applicationProgramIds.length !== 1)) {
    throw withCallableError("failed-precondition", "submission task application and lead require an exact program scope", auth);
  }
  const canonicalProgramIds = [...new Set([
    ...requestProgramIds,
    ...leadProgramIds,
    ...applicationProgramIds,
  ])];
  if (canonicalProgramIds.length > 1) {
    throw withCallableError("failed-precondition", "submission task application and lead program scopes do not match", auth);
  }
  const canonicalProgramId = canonicalProgramIds[0] || SCP_CANONICAL_PROGRAM_ID;
  const programScope = confirmedProgramScope(canonicalProgramId, aliasRegistry);
  if (!applicationId && canonicalProgramId !== SCP_CANONICAL_PROGRAM_ID) {
    throw withCallableError("failed-precondition", "non-SCP submission tasks require an exact application scope", auth);
  }

  const explicitCreatorId = exactScopedId(data.creatorId, "requested creator", auth);
  const leadCreatorId = submissionTaskLeadCreatorId(lead, auth);
  const applicationCreatorId = exactScopedId(application?.creatorId, "application creator", auth);
  if (applicationId && (!applicationCreatorId || !leadCreatorId)) {
    throw withCallableError("failed-precondition", "submission task application and lead creator scope is missing", auth);
  }
  if (applicationId && applicationCreatorId !== leadCreatorId) {
    throw withCallableError("failed-precondition", "submission task application and lead creator scopes do not match", auth);
  }
  const creatorId = applicationId ? applicationCreatorId : leadCreatorId || explicitCreatorId;
  if (explicitCreatorId && creatorId && explicitCreatorId !== creatorId) {
    throw withCallableError("failed-precondition", "submission task creator does not match the authoritative application or lead", auth);
  }

  const applicationPolicy = boundedTaskPolicyRecord(application?.videoReviewPolicySnapshot);
  const leadPolicy = applicationId ? {} : boundedTaskPolicyRecord(lead.videoReviewPolicySnapshot);
  const videoReviewPolicySnapshot = Object.keys(applicationPolicy).length > 0
    ? applicationPolicy
    : Object.keys(leadPolicy).length > 0
      ? leadPolicy
      : { minimumDurationSeconds: 20 };
  return {
    canonicalProgramId: programScope.canonicalProgramId,
    identityProgramIds: programScope.identityProgramIds,
    aliasRegistryRevision: programScope.aliasRegistryRevision,
    applicationId,
    applicationRef: expectedApplicationRef,
    creatorId,
    qualificationPolicyHash: text(application?.qualificationPolicyHash, 128)
      || (!applicationId ? text(lead.qualificationPolicyHash, 128) : ""),
    videoReviewPolicySnapshot,
  };
}

function assertExistingSubmissionTaskScope(
  task: SubmissionTask | undefined,
  leadId: string,
  scope: SubmissionTaskProgramScope,
  aliasRegistry: ConfirmedProgramAliasRegistryState,
  auth: AuthContext,
) {
  if (!task) return;
  const existingLeadId = safeId(task.leadId);
  if (existingLeadId && existingLeadId !== leadId) {
    throw withCallableError("already-exists", "submission task id belongs to another lead", auth);
  }
  const existingProgramId = resolveCanonicalProgramId(
    task.canonicalProgramId || task.programId,
    aliasRegistry.aliasMap,
  );
  if (existingProgramId && existingProgramId !== scope.canonicalProgramId) {
    throw withCallableError("already-exists", "submission task id belongs to another program", auth);
  }
  const existingApplicationId = safeId(task.applicationId)
    || applicationIdFromRef(task.applicationRef, auth);
  if (existingApplicationId && existingApplicationId !== scope.applicationId) {
    throw withCallableError("already-exists", "submission task id belongs to another application", auth);
  }
  if (!scope.applicationId && existingApplicationId) {
    throw withCallableError("already-exists", "submission task application scope cannot be removed", auth);
  }
}

async function resolveCreatorLink(input: {
  leadId: string;
  email: string;
  canonicalProgramId: string;
  applicationId: string;
  aliasRegistry: ConfirmedProgramAliasRegistryState;
  auth: AuthContext;
}): Promise<Record<string, unknown> | null> {
  const exactId = creatorLinkIdentityDocId({
    canonicalProgramId: input.canonicalProgramId,
    applicationId: input.applicationId || null,
    leadId: input.leadId,
    creatorId: "",
  });
  const exactSnapshot = await adminDb.collection("creator_links").doc(exactId).get();
  if (exactSnapshot.exists) {
    const exact: Record<string, unknown> = { id: exactSnapshot.id, ...(exactSnapshot.data() ?? {}) };
    assertCreatorLinkScope(exact, input);
    return asString(exact.status, "active") === "active" ? exact : null;
  }

  const candidateDocuments: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  if (input.leadId) {
    const byLead = await adminDb.collection("creator_links").where("leadId", "==", input.leadId).limit(20).get();
    candidateDocuments.push(...byLead.docs);
  }
  if (!candidateDocuments.length && input.email) {
    const byEmail = await adminDb.collection("creator_links").where("email", "==", input.email).limit(20).get();
    candidateDocuments.push(...byEmail.docs);
  }
  const activeCandidates = candidateDocuments
    .map<Record<string, unknown>>((doc) => ({ id: doc.id, ...(doc.data() ?? {}) }))
    .filter((record) => asString(record.status, "active") === "active");
  const matching = activeCandidates.filter((record) => creatorLinkMatchesScope(record, input));
  if (matching.length > 1) {
    throw withCallableError("failed-precondition", "creator link scope is ambiguous", input.auth);
  }
  if (matching[0]) return matching[0];
  if (activeCandidates.length) {
    throw withCallableError("failed-precondition", "creator link scope mismatch", input.auth);
  }
  return null;
}

function creatorLinkMatchesScope(
  record: Record<string, unknown>,
  input: {
    leadId: string;
    canonicalProgramId: string;
    applicationId: string;
    aliasRegistry: ConfirmedProgramAliasRegistryState;
  },
): boolean {
  const programId = resolveCanonicalProgramId(
    record.canonicalProgramId || record.programId,
    input.aliasRegistry.aliasMap,
  );
  const applicationId = safeId(record.applicationId);
  const leadId = safeId(record.leadId);
  return programId === input.canonicalProgramId
    && applicationId === input.applicationId
    && (!leadId || leadId === input.leadId);
}

function assertCreatorLinkScope(
  record: Record<string, unknown>,
  input: {
    leadId: string;
    canonicalProgramId: string;
    applicationId: string;
    aliasRegistry: ConfirmedProgramAliasRegistryState;
    auth: AuthContext;
  },
): void {
  if (!creatorLinkMatchesScope(record, input)) {
    throw withCallableError("failed-precondition", "creator link scope mismatch", input.auth);
  }
}

async function taskByToken(token: string) {
  const snapshot = await adminDb.collection(SUBMISSION_TASKS_COLLECTION).where("submitToken", "==", token).limit(1).get();
  return snapshot.empty ? null : snapshot.docs[0];
}

function hasTerminalSubmissionLifecycle(
  task: Record<string, unknown> | undefined,
  submission: Record<string, unknown> | undefined,
): boolean {
  const payment = asRecord(submission?.payment);
  const terminalStatuses = new Set([
    "approved",
    "pass",
    "passed",
    "paid",
    "payable",
    "settled",
    "payment_complete",
    "paid_complete",
  ]);
  const lifecycleStatuses = [
    task?.taskStatus,
    task?.status,
    submission?.reviewStatus,
    submission?.status,
  ].map((value) => asString(value).trim().toLowerCase());
  if (lifecycleStatuses.some((status) => terminalStatuses.has(status))) return true;

  // Missing payment fields remain compatible with legacy needs_review rows. Once a canonical
  // payment state exists, only the explicit unpaid value is eligible for resubmission.
  const paymentStatuses = [
    submission?.payableStatus,
    payment.payStatus,
    payment.status,
    submission?.paymentStatus,
  ].map((value) => asString(value).trim().toLowerCase());
  if (paymentStatuses.some((status) => status && status !== "not_payable")) {
    return true;
  }

  return submission?.paid === true
    || task?.paid === true
    || Boolean(
      asString(payment.paidAt)
      || asString(payment.paidAtIso)
      || asString(submission?.paidAt)
      || asString(submission?.paidAtIso)
      || asString(task?.paidAt)
      || asString(task?.paidAtIso),
    );
}

function assertSubmissionUploadIssuanceAllowed(
  taskExists: boolean,
  task: SubmissionTask | undefined,
  submissionExists: boolean,
  submission: Record<string, unknown> | undefined,
  token: string,
  nowIso: string,
  request: CallableRequestShape,
): void {
  if (!taskExists || tokenString(task?.submitToken) !== token || isExpired(task, nowIso)) {
    throw publicError("not-found", "submission form not found", request, "submission_form.upload_url");
  }
  const taskStatus = asString(task?.taskStatus).trim().toLowerCase();
  const reviewStatus = asString(submission?.reviewStatus).trim().toLowerCase();
  const terminalLifecycle = hasTerminalSubmissionLifecycle(task, submission);
  const freshIssuedTask = taskStatus === "issued" && !submissionExists && !terminalLifecycle;
  const needsReviewResubmission = taskStatus === "submitted"
    && submissionExists
    && reviewStatus === "needs_review"
    && !terminalLifecycle;
  if (!freshIssuedTask && !needsReviewResubmission) {
    throw publicError(
      "failed-precondition",
      "upload is not allowed for the current submission state",
      request,
      "submission_form.upload_url",
    );
  }
}

async function checkUploadThrottle(token: string, request: CallableRequestShape, nowIso: string): Promise<string> {
  const nowMs = Date.parse(nowIso);
  const ref = adminDb.collection(UPLOAD_THROTTLE_COLLECTION).doc(safeDocId(token));
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data() ?? {};
    const windowStartedAtIso = asString(data.windowStartedAtIso, "");
    const windowStartMs = Date.parse(windowStartedAtIso);
    const expiredWindow = !Number.isFinite(windowStartMs) || nowMs - windowStartMs > UPLOAD_THROTTLE_WINDOW_MS;
    const count = expiredWindow ? 0 : numberValue(data.count, 0);
    if (count >= UPLOAD_THROTTLE_MAX) {
      throw publicError("resource-exhausted", "too many upload requests", request, "submission_form.upload_url");
    }
    transaction.set(ref, {
      id: ref.id,
      tokenHash: safeDocId(token),
      count: expiredWindow ? 1 : FieldValue.increment(1),
      limit: UPLOAD_THROTTLE_MAX,
      windowMs: UPLOAD_THROTTLE_WINDOW_MS,
      windowStartedAtIso: expiredWindow ? nowIso : windowStartedAtIso,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return ref.path;
}

function parseSubmissionPayload(data: Record<string, unknown>, request: CallableRequestShape) {
  const youtubeUrl = optionalUrl(data.youtubeUrl, "youtubeUrl", request);
  const tiktokUrl = optionalUrl(data.tiktokUrl, "tiktokUrl", request);
  const instaUrl = optionalUrl(data.instaUrl ?? data.instagramUrl, "instaUrl", request);
  const uploadedFile = optionalUploadedFileUrl(data.uploadedFileUrl, request);
  const uploadedFileGeneration = optionalUploadGeneration(data.uploadedFileGeneration, request);
  if (uploadedFileGeneration && !uploadedFile) {
    throw publicError("invalid-argument", "uploadedFileGeneration requires an uploadedFileUrl", request, "submission_form.submit");
  }
  const submitNote = text(data.submitNote, MAX_NOTE_LEN);
  const contentUrls = arrayValue(data.contentUrls, MAX_FIELDS, "contentUrls", request).map((value, index) => optionalUrl(value, `contentUrls[${index}]`, request)).filter(Boolean);
  const fields = arrayValue(data.fields, MAX_FIELDS, "fields", request).map((value) => {
    const record = asRecord(value);
    return {
      key: text(record.key, 200),
      label: text(record.label, 500),
      type: text(record.type, 100),
      value: text(record.value, MAX_FIELD_VALUE_LEN),
      sortOrder: record.sortOrder === undefined || record.sortOrder === null ? null : finiteNumber(record.sortOrder),
    } satisfies PublicSubmissionField;
  });
  const hasContent = Boolean(youtubeUrl || tiktokUrl || instaUrl || uploadedFile || contentUrls.length);
  if (!hasContent) {
    throw publicError("invalid-argument", "at least one content URL or MP4 upload is required", request, "submission_form.submit");
  }
  return { youtubeUrl, tiktokUrl, instaUrl, uploadedFile, uploadedFileGeneration, submitNote, contentUrls, fields };
}

function publicFormPayload(id: string, task: SubmissionTask) {
  return {
    id,
    app: asString(task.app, asString(task.appName, "Weapon RPG SCP")),
    appName: asString(task.app, asString(task.appName, "Weapon RPG SCP")),
    contentType: asString(task.contentType, "weaponrpg_scp_video"),
    locale: normalizeLocale(task.locale),
    formTitle: asString(task.formTitle, "SCP Content Submission"),
    formInstructions: asString(task.formInstructions, "Submit your published content URL and optional MP4 source file for review."),
    requiredFields: stringList(task.requiredFields, MAX_FIELDS),
    taskStatus: asString(task.taskStatus, "issued"),
    expiresAtIso: asString(task.expiresAtIso, ""),
    snapshot: asRecord(task.formTemplateSnapshot),
    maxUploadBytes: MAX_UPLOAD_BYTES,
    uploadContentType: "video/mp4",
  };
}


function tokenString(value: unknown): string {
  return text(value, 160).replace(/[^a-zA-Z0-9_-]/g, "");
}

function publicAuthContext(request?: CallableRequestShape): AuthContext {
  return {
    userId: "public-submission-form",
    role: "viewer",
    team: "public",
    ip: request?.rawRequest?.ip ?? "0.0.0.0",
    gameId: "scp-automation",
  };
}

function assertPublicAppCheck(request: CallableRequestShape, action: string) {
  if (isEmulatorRuntime()) return;
  if (request.app?.appId) return;
  throw publicError("failed-precondition", "App Check required for public submission form", request, action);
}

function publicError(code: string, message: string, request: CallableRequestShape, action: string) {
  const error = new Error(`${code}: ${message}`);
  Object.assign(error, { code, behaviorLog: makeBehaviorLog(publicAuthContext(request), action, code === "not-found" ? "denied" : "error", "scp-automation") });
  return error;
}

function withCallableError(code: string, message: string, auth: ReturnType<typeof assertNonGuestAuth>) {
  const error = new Error(`${code}: ${message}`);
  Object.assign(error, { code, behaviorLog: makeBehaviorLog(auth, "submission_tasks.issue", code === "permission-denied" ? "denied" : "error", "scp-automation") });
  return error;
}

function assertPayloadSize(data: Record<string, unknown>, request: CallableRequestShape) {
  try {
    const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
    if (bytes > MAX_PAYLOAD_BYTES) {
      throw publicError("invalid-argument", "payload too large", request, "submission_form.submit");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error;
    throw publicError("invalid-argument", "invalid payload", request, "submission_form.submit");
  }
}

function optionalUrl(value: unknown, field: string, request: CallableRequestShape): string {
  const raw = text(value, MAX_URL_LEN);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
    return parsed.href;
  } catch {
    throw publicError("invalid-argument", `${field} must be an http(s) url`, request, "submission_form.submit");
  }
}

function optionalUploadedFileUrl(value: unknown, request: CallableRequestShape): ParsedSubmissionUpload | null {
  const raw = text(value, MAX_URL_LEN);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") || parsed.hash) throw new Error("unsafe upload url");
    const host = parsed.hostname.toLowerCase();
    let bucket = "";
    let objectPath = "";
    if (host === "firebasestorage.googleapis.com") {
      const match = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
      if (match) {
        bucket = safeDecodeUploadPart(match[1]).toLowerCase();
        objectPath = safeDecodeUploadPart(match[2]);
      }
    } else if (host === "storage.googleapis.com") {
      const [, bucketSegment = "", ...objectSegments] = parsed.pathname.split("/");
      bucket = safeDecodeUploadPart(bucketSegment).toLowerCase();
      objectPath = safeDecodeUploadPart(objectSegments.join("/"));
    } else if (host.endsWith(".storage.googleapis.com")) {
      bucket = host.slice(0, -".storage.googleapis.com".length);
      objectPath = safeDecodeUploadPart(parsed.pathname.replace(/^\/+/, ""));
    }
    if (!approvedUploadBuckets().has(bucket)) throw new Error("unapproved bucket");
    if (!objectPath.startsWith(submissionUploadObjectPrefix()) || !/\.mp4$/i.test(objectPath)) throw new Error("invalid object path");
    if (objectPath.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new Error("invalid object path");
    return { bucket, objectPath };
  } catch {
    throw publicError("invalid-argument", "uploadedFileUrl must reference an approved Firebase Storage MP4", request, "submission_form.submit");
  }
}

function optionalUploadGeneration(value: unknown, request: CallableRequestShape): string {
  const generation = text(value, 80);
  if (!generation) return "";
  if (!/^\d+$/.test(generation)) throw publicError("invalid-argument", "uploadedFileGeneration must be a decimal object generation", request, "submission_form.submit");
  return generation;
}

function submissionRequestFingerprint(parsed: ReturnType<typeof parseSubmissionPayload>): string {
  const normalizedFields = parsed.fields.map((field) => ({
    ...field,
    value: field.type === "file" && parsed.uploadedFile
      ? `gs://${parsed.uploadedFile.bucket}/${parsed.uploadedFile.objectPath}`
      : field.value,
  }));
  return crypto.createHash("sha256").update(JSON.stringify({
    youtubeUrl: parsed.youtubeUrl,
    tiktokUrl: parsed.tiktokUrl,
    instaUrl: parsed.instaUrl,
    uploadedFile: parsed.uploadedFile ? {
      bucket: parsed.uploadedFile.bucket,
      objectPath: parsed.uploadedFile.objectPath,
    } : null,
    uploadedFileGeneration: parsed.uploadedFileGeneration,
    submitNote: parsed.submitNote,
    contentUrls: parsed.contentUrls,
    fields: normalizedFields,
  })).digest("hex");
}

function submissionIsIdempotent(existing: Record<string, unknown>, requestFingerprint: string): boolean {
  return asString(existing.reviewStatus, "pending") !== "needs_review"
    && asString(existing.submissionRequestFingerprint) === requestFingerprint;
}

async function verifySubmissionUpload(
  taskId: string,
  task: SubmissionTask,
  uploadedFile: ParsedSubmissionUpload | null,
  expectedGeneration: string,
  nowIso: string,
  request: CallableRequestShape,
  metadataReader: SubmissionUploadMetadataReader,
): Promise<VerifiedSubmissionUpload | null> {
  if (!uploadedFile) return null;
  const expectedPrefix = `${submissionUploadObjectPrefix()}${safeDocId(taskId)}/`;
  if (!uploadedFile.objectPath.startsWith(expectedPrefix)) {
    throw publicError("invalid-argument", "uploaded file is not reserved for this submission task", request, "submission_form.submit");
  }
  const reservation = uploadReservationFromTask(task);
  if (!reservation
    || reservation.status !== "issued"
    || Date.parse(reservation.expiresAtIso) <= Date.parse(nowIso)
    || reservation.bucket !== uploadedFile.bucket
    || reservation.objectPath !== uploadedFile.objectPath) {
    throw publicError("invalid-argument", "uploaded file must match a server-issued upload reservation", request, "submission_form.submit");
  }

  let metadata: SubmissionUploadMetadata;
  try {
    metadata = await metadataReader(uploadedFile.bucket, uploadedFile.objectPath);
  } catch {
    throw publicError("failed-precondition", "uploaded file could not be verified", request, "submission_form.submit");
  }
  const metadataBucket = metadataText(metadata.bucket).toLowerCase();
  const metadataObjectPath = metadataText(metadata.name);
  if (metadataBucket !== reservation.bucket || metadataObjectPath !== reservation.objectPath) {
    throw publicError("invalid-argument", "uploaded file object identity does not match the upload reservation", request, "submission_form.submit");
  }
  const contentType = metadataText(metadata.contentType).toLowerCase();
  if (!ALLOWED_UPLOAD_TYPES.has(contentType) || contentType !== reservation.contentType) {
    throw publicError("invalid-argument", "uploaded file content type is not allowed", request, "submission_form.submit");
  }
  const size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES || size !== reservation.size) {
    throw publicError("invalid-argument", "uploaded file size is invalid", request, "submission_form.submit");
  }
  const generation = metadataText(metadata.generation);
  if (!/^\d+$/.test(generation)) {
    throw publicError("invalid-argument", "uploaded file generation is invalid", request, "submission_form.submit");
  }
  if (expectedGeneration && expectedGeneration !== generation) {
    throw publicError("invalid-argument", "uploaded file generation does not match Storage metadata", request, "submission_form.submit");
  }
  return {
    reservation,
    bucket: reservation.bucket,
    objectPath: reservation.objectPath,
    fileUrl: reservation.fileUrl,
    contentType,
    size,
    generation,
  };
}

function reservationMatchesVerifiedUpload(task: SubmissionTask, upload: VerifiedSubmissionUpload, nowIso: string): boolean {
  const reservation = uploadReservationFromTask(task);
  return Boolean(reservation
    && reservation.status === "issued"
    && Date.parse(reservation.expiresAtIso) > Date.parse(nowIso)
    && reservation.id === upload.reservation.id
    && reservation.bucket === upload.bucket
    && reservation.objectPath === upload.objectPath
    && reservation.fileUrl === upload.fileUrl
    && reservation.contentType === upload.contentType
    && reservation.size === upload.size);
}

function uploadReservationFromTask(task: Record<string, unknown>): SubmissionUploadReservation | null {
  const raw = asRecord(task.uploadReservation);
  const id = text(raw.id, 160);
  const bucket = text(raw.bucket, 240).toLowerCase();
  const objectPath = text(raw.objectPath, MAX_URL_LEN);
  const fileUrl = text(raw.fileUrl, MAX_URL_LEN);
  const contentType = text(raw.contentType, 120).toLowerCase();
  const size = Number(raw.size);
  const issuedAtIso = text(raw.issuedAtIso, 80);
  const expiresAtIso = text(raw.expiresAtIso, 80);
  const status = text(raw.status, 40);
  if (!id || !bucket || !objectPath || !fileUrl || !ALLOWED_UPLOAD_TYPES.has(contentType)
    || !Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES
    || !Number.isFinite(Date.parse(issuedAtIso)) || !Number.isFinite(Date.parse(expiresAtIso))
    || (status !== "issued" && status !== "consumed")) {
    return null;
  }
  const generation = optionalDecimalMetadata(raw.generation);
  const consumedAtIso = text(raw.consumedAtIso, 80);
  return {
    id,
    bucket,
    objectPath,
    fileUrl,
    contentType,
    size,
    issuedAtIso,
    expiresAtIso,
    status,
    ...(generation ? { generation } : {}),
    ...(consumedAtIso ? { consumedAtIso } : {}),
  };
}

async function readSubmissionUploadMetadata(bucket: string, objectPath: string): Promise<SubmissionUploadMetadata> {
  const [metadata] = await adminStorage.bucket(bucket).file(objectPath).getMetadata();
  return metadata;
}

function metadataText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return "";
}

function optionalDecimalMetadata(value: unknown): string {
  const result = metadataText(value);
  return /^\d+$/.test(result) ? result : "";
}

function approvedUploadBuckets(): Set<string> {
  if (isStagingSafetyRuntime()) return new Set([resolveStagingUploadBucket()]);
  const buckets = new Set<string>();
  const projectId = (process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "").trim().toLowerCase();
  if (projectId) {
    buckets.add(`${projectId}.appspot.com`);
    buckets.add(`${projectId}.firebasestorage.app`);
  }
  try {
    const config = JSON.parse(process.env.FIREBASE_CONFIG || "{}") as { storageBucket?: unknown };
    if (typeof config.storageBucket === "string" && config.storageBucket.trim()) buckets.add(config.storageBucket.trim().toLowerCase());
  } catch {
    // Fail closed below when runtime configuration is malformed.
  }
  try {
    const bucket = adminStorage.bucket().name.trim().toLowerCase();
    if (bucket) buckets.add(bucket);
  } catch {
    // Emulator tests use GCLOUD_PROJECT; projects without storage stay fail-closed.
  }
  return buckets;
}

function safeDecodeUploadPart(value: string): string {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function arrayValue(value: unknown, max: number, field: string, request: CallableRequestShape): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw publicError("invalid-argument", `${field} must be an array`, request, "submission_form.submit");
  if (value.length > max) throw publicError("invalid-argument", `${field} must be at most ${max}`, request, "submission_form.submit");
  return value;
}

function stringList(value: unknown, max = 20): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out: string[] = [];
  for (const item of source) {
    const next = text(item, 200);
    if (next && !out.includes(next)) out.push(next);
    if (out.length >= max) break;
  }
  return out;
}

function text(value: unknown, max = 1000): string {
  if (typeof value === "string") return value.trim().slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, max);
  return "";
}

function safeId(value: unknown): string {
  const raw = asString(value, "");
  return raw ? safeDocId(raw) : "";
}

function cleanEmail(value: unknown): string {
  return text(value, 180).toLowerCase();
}

function leadEmail(lead: Record<string, unknown>): string {
  return cleanEmail(lead.email) || cleanEmail(asRecord(lead.applicant).email) || cleanEmail(lead.profileMatchedEmail);
}

function leadChannelName(lead: Record<string, unknown>): string {
  const applicant = asRecord(lead.applicant);
  return text(lead.channelName, 160) || text(applicant.channelName, 160) || text(lead.name, 160) || text(applicant.name, 160);
}

function normalizeLocale(value: unknown): string {
  const raw = text(value, 20).toLowerCase();
  if (raw === "ko" || raw === "kr" || raw === "korean") return "ko";
  if (raw === "vi" || raw === "vie" || raw === "vietnamese") return "vi";
  return "en";
}

function formTemplateSnapshot(locale: string) {
  return {
    defaultValues: {
      block_order: ["youtube", "file", "note"],
      enabled_blocks: ["youtube", "file", "note"],
      youtube_label: locale === "ko" ? "콘텐츠 URL" : "Content URL",
      file_label: locale === "ko" ? "원본 MP4 파일" : "Original MP4 file",
      note_label: locale === "ko" ? "메모" : "Note",
    },
  };
}

function publicFormLink(token: string, baseUrl: string): string {
  try {
    const base = new URL(baseUrl || DEFAULT_PUBLIC_FORM_BASE_URL);
    return new URL(`/scp/submit/${encodeURIComponent(token)}`, base).href;
  } catch {
    return `${DEFAULT_PUBLIC_FORM_BASE_URL}/scp/submit/${encodeURIComponent(token)}`;
  }
}

function addDaysIso(nowIso: string, days: number): string {
  const base = new Date(nowIso);
  const ms = Number.isFinite(base.getTime()) ? base.getTime() : Date.now();
  return new Date(ms + days * 24 * 60 * 60 * 1000).toISOString();
}

function isExpired(task?: Record<string, unknown>, nowIso = new Date().toISOString()): boolean {
  if (!task) return false;
  const expiresAtIso = asString(task.expiresAtIso, "");
  if (!expiresAtIso) return false;
  return Date.parse(expiresAtIso) <= Date.parse(nowIso);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.trunc(n), max));
}

function boundedFileSize(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeUploadExt(filename: string): string {
  const lower = filename.toLowerCase();
  return lower.endsWith(".mp4") ? ".mp4" : ".mp4";
}

function firebaseDownloadUrl(bucket: string, objectPath: string, downloadToken: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectPath)}?alt=media&token=${encodeURIComponent(downloadToken)}`;
}

function canonicalSubmissionUploadGcsUri(bucket: string, objectPath: string): string {
  return `gs://${bucket.toLowerCase()}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}

function isEmulatorRuntime(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}
