// Production-safe creator canonical-media reconciliation for audited creator docs.
// Network-free core. Public artifacts expose only redacted digests; private rollback backups are produced by
// the script from `privateBackupDocs` and must be stored outside shareable artifact paths.

type FirestoreDb = FirebaseFirestore.Firestore;
export const CREATORS_COLLECTION = "creators";
export const TARGET_FIELD = "youtubeDataApiPublicThumbnailUrl";
export const RECEIPT_SCHEMA = "flu.creatorCanonicalMediaReconciliation.v2";
export const PRIVATE_BACKUP_SCHEMA = "flu.creatorCanonicalMediaPrivateRollbackBackup.v1";
export const MAX_CAS_BATCH_SIZE = 200;
export const STABLE_PREVIEW_OPERATION_TIMESTAMP_ISO = "1970-01-01T00:00:00.000Z";

function str(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function num(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function isHttpsUrl(value: string): boolean { try { return new URL(value).protocol === "https:"; } catch { return false; } }
function isLegacyYoutubeAvatarUrl(value: string): boolean {
  if (!isHttpsUrl(value)) return false;
  const host = new URL(value).hostname.toLowerCase();
  return host === "yt3.ggpht.com" || host.endsWith(".ggpht.com") || host === "yt3.googleusercontent.com";
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
export async function sha256Hex(value: unknown, length = 64): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex").slice(0, length);
}
async function readAll(db: FirestoreDb, collection: string, cap = 10000): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const pageSize = 450;
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (let i = 0; i < Math.ceil(cap / pageSize) + 1 && out.length < cap; i += 1) {
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

export type CanonicalMediaEvidenceSource = "youtube_data_api_channels_list" | "legacy_youtube_hosted_avatar_url";
export type CanonicalMediaClassification = "create" | "update" | "skip_already_current" | "skip_no_evidence" | "skip_waived_no_evidence" | "conflict_existing_canonical";
export interface CanonicalMediaEvidence { readonly source: CanonicalMediaEvidenceSource; readonly url: string; readonly thumbnailUrl?: string; readonly channelId?: string; readonly channelIdSource?: "creator_field" | "deterministic_creator_id"; readonly channelTitle?: string; readonly customUrl?: string; readonly subscriberCount?: string | number; readonly country?: string; readonly hiddenSubscriberCount?: boolean; readonly sourceUrlDigest?: string; readonly fetchedAtIso?: string; }
export interface CanonicalMediaWaiver { readonly owner: string; readonly reason: string; readonly expiresAtIso: string; }
export interface CanonicalMediaWaiverPlan { readonly rows?: Record<string, CanonicalMediaWaiver>; }
export interface CanonicalMediaManifestRow {
  readonly creatorDigest: string;
  readonly channelIdDigest?: string;
  readonly legacyAvatarDigest?: string;
  readonly targetUrlDigest?: string;
  readonly beforeDigest: string;
  readonly deterministicAfterDigest?: string;
  readonly classification: CanonicalMediaClassification;
  readonly reason: string;
  readonly source: CanonicalMediaEvidenceSource | "none";
  readonly evidenceFetchedAtIso?: string;
  readonly projectedFieldCount?: number;
  readonly waiver?: { readonly waiverDigest: string; readonly expiresAtIso: string };
}
export interface CanonicalMediaPublicBackupRef { readonly creatorDigest: string; readonly beforeDigest: string; readonly deterministicAfterDigest: string; readonly appliedAction: "create" | "update"; }
export interface CanonicalMediaPrivateBackupDoc extends CanonicalMediaPublicBackupRef { readonly creatorId: string; readonly beforeExists: boolean; readonly beforeData: Record<string, unknown>; }
export interface CanonicalMediaCommittedBatch { readonly batchIndex: number; readonly count: number; readonly batchDigest: string; readonly committedAtIso: string; readonly creatorDigests: readonly string[]; }
export interface CanonicalMediaCounts { readonly scanned: number; readonly eligibleEvidence: number; readonly wouldWrite: number; readonly written: number; readonly createCount: number; readonly updateCount: number; readonly skipAlreadyCurrentCount: number; readonly skipNoEvidenceCount: number; readonly waivedNoEvidenceCount: number; readonly conflictCount: number; readonly classifications: Readonly<Record<CanonicalMediaClassification, number>>; }
export interface CanonicalMediaPublicReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly artifactSensitivity: "public_redacted_no_pii";
  readonly operationId: string;
  readonly mode: "preview" | "apply_pending" | "apply_final";
  readonly apply: boolean;
  readonly final: boolean;
  readonly generatedAtIso: string;
  readonly operationTimestampIso: string;
  readonly target: string;
  readonly projectId: string;
  readonly sourceSha: string;
  readonly treeSha: string;
  readonly rollbackCommand: string;
  readonly counts: CanonicalMediaCounts;
  readonly sourceFingerprint: string;
  readonly destinationFingerprint: string;
  readonly rowManifestDigest: string;
  readonly rowManifest: readonly CanonicalMediaManifestRow[];
  readonly publicBackupRefs: readonly CanonicalMediaPublicBackupRef[];
  readonly privateBackupReceipt: { readonly sensitivity: "restricted_pii_private_rollback_backup"; readonly storageClass: "non_shareable_gitignored_chmod_0600"; readonly pathClassification: "private_local_path_not_for_sharing"; readonly digest: string };
  readonly committedBatches: readonly CanonicalMediaCommittedBatch[];
}
export interface CanonicalMediaPrivateBackupReceipt { readonly schema: typeof PRIVATE_BACKUP_SCHEMA; readonly sensitivity: "restricted_pii_private_rollback_backup"; readonly operationId: string; readonly publicReceiptDigest: string; readonly generatedAtIso: string; readonly backupDocs: readonly CanonicalMediaPrivateBackupDoc[]; }
export interface CanonicalMediaPlanOptions { readonly db: FirestoreDb; readonly apply?: boolean; readonly operationId?: string; readonly operationTimestampIso?: string; readonly target?: string; readonly projectId?: string; readonly sourceSha?: string; readonly treeSha?: string; readonly receiptPath?: string; readonly privateBackupPath?: string; readonly targetCreatorIds?: readonly string[]; readonly youtubeEvidenceByChannelId?: ReadonlyMap<string, CanonicalMediaEvidence>; readonly legacyAvatarEvidenceByCreatorId?: ReadonlyMap<string, CanonicalMediaEvidence>; readonly waiverPlan?: CanonicalMediaWaiverPlan; }
export interface CanonicalMediaWrite { readonly creatorId: string; readonly creatorDigest: string; readonly deterministicData: Record<string, unknown>; readonly beforeDigest: string; readonly deterministicAfterDigest: string; readonly appliedAction: "create" | "update"; }
export interface CanonicalMediaPlan { readonly writes: readonly CanonicalMediaWrite[]; readonly rowManifest: readonly CanonicalMediaManifestRow[]; readonly publicBackupRefs: readonly CanonicalMediaPublicBackupRef[]; readonly privateBackupDocs: readonly CanonicalMediaPrivateBackupDoc[]; readonly counts: CanonicalMediaCounts; readonly sourceFingerprint: string; readonly destinationFingerprint: string; readonly rowManifestDigest: string; readonly operationId: string; readonly operationTimestampIso: string; readonly receipt: CanonicalMediaPublicReceipt; readonly privateBackupReceipt: CanonicalMediaPrivateBackupReceipt; }

function emptyClassifications(): Record<CanonicalMediaClassification, number> { return { create: 0, update: 0, skip_already_current: 0, skip_no_evidence: 0, skip_waived_no_evidence: 0, conflict_existing_canonical: 0 }; }
function validateOperationTimestamp(value: string): string { const parsed = new Date(value).toISOString(); if (parsed !== value) throw new Error("operation_timestamp_must_be_canonical_iso"); return value; }
function validateWaiver(waiver: CanonicalMediaWaiver | undefined): CanonicalMediaWaiver | undefined { if (!waiver) return undefined; const owner = str(waiver.owner); const reason = str(waiver.reason); const expiresAtIso = str(waiver.expiresAtIso); const expiry = new Date(expiresAtIso).getTime(); if (!owner || !reason || !expiresAtIso || Number.isNaN(expiry) || expiry <= Date.now()) return undefined; return { owner, reason, expiresAtIso }; }
function legacyAvatarCandidate(creator: Record<string, unknown>): string { for (const key of ["avatar", "avatarUrl", "imageUrl", "profileImageUrl", "thumbnailUrl"]) { const value = str(creator[key]); if (isLegacyYoutubeAvatarUrl(value)) return value; } return ""; }
function resolvedCreatorChannel(creator: Record<string, unknown>): { channelId: string; source: "creator_field" | "deterministic_creator_id" } | null {
  const explicit = str(creator.channelId) || str(creator.youtubeChannelId) || str(creator.canonicalChannelId);
  if (explicit) return { channelId: explicit, source: "creator_field" };
  const deterministicSuffix = str(creator.id).match(/(UC[A-Za-z0-9_-]{22})$/)?.[1] ?? "";
  return deterministicSuffix ? { channelId: deterministicSuffix, source: "deterministic_creator_id" } : null;
}
function chooseEvidence(creator: Record<string, unknown>, yt: ReadonlyMap<string, CanonicalMediaEvidence> | undefined, legacy: ReadonlyMap<string, CanonicalMediaEvidence> | undefined): CanonicalMediaEvidence | null { const channel = resolvedCreatorChannel(creator); if (channel) { const ytEvidence = yt?.get(channel.channelId); if (ytEvidence?.url && isHttpsUrl(ytEvidence.url)) return { ...ytEvidence, channelId: channel.channelId, channelIdSource: channel.source }; } const legacyEvidence = legacy?.get(str(creator.id)); if (legacyEvidence?.url && isLegacyYoutubeAvatarUrl(legacyEvidence.url)) return legacyEvidence; return null; }
function isTestIdentity(creatorId: string): boolean { return creatorId === "seed-0540-flu-creator-1" || creatorId.startsWith("creator-persona-") || creatorId.startsWith("test-"); }
function validateTargetCreatorIds(targetCreatorIds: readonly string[] | undefined, creators: readonly Record<string, unknown>[]): readonly string[] | null {
  if (!targetCreatorIds) return null;
  if (targetCreatorIds.length > MAX_CAS_BATCH_SIZE) throw new Error("target_creator_count_exceeds_limit");
  const seen = new Set<string>();
  for (const rawId of targetCreatorIds) {
    const id = str(rawId);
    if (!id) throw new Error("target_creator_id_required");
    if (seen.has(id)) throw new Error("duplicate_target_creator_id");
    seen.add(id);
  }
  const existing = new Set(creators.map((creator) => str(creator.id)));
  for (const id of seen) {
    if (!existing.has(id)) throw new Error("target_creator_missing");
    if (isTestIdentity(id)) throw new Error("target_creator_is_test_identity");
  }
  return [...seen];
}
function usableHandle(value: unknown): string { const raw = str(value); if (!raw) return ""; return raw.startsWith("@") ? raw : `@${raw}`; }
function subscriberNumber(value: unknown): number { if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value); const parsed = Number.parseInt(str(value), 10); return Number.isFinite(parsed) && parsed > 0 ? parsed : 0; }
function hasProfileEvidence(evidence: CanonicalMediaEvidence): boolean { return Boolean(str(evidence.channelTitle) || str(evidence.customUrl) || subscriberNumber(evidence.subscriberCount) || str(evidence.country)); }
function newerOwnedEvidenceWouldRegress(creator: Record<string, unknown>, evidence: CanonicalMediaEvidence): boolean {
  if (!isOwnedCanonical(creator)) return false;
  const reconciliation = creator.canonicalMediaReconciliation as Record<string, unknown> | undefined;
  const currentAt = Date.parse(str(reconciliation?.evidenceFetchedAtIso));
  const proposedAt = Date.parse(str(evidence.fetchedAtIso));
  return Number.isFinite(currentAt) && Number.isFinite(proposedAt) && currentAt > proposedAt;
}
function projectedProfileMatches(creator: Record<string, unknown>, evidence: CanonicalMediaEvidence): boolean {
  const thumbnailUrl = str(evidence.thumbnailUrl) || str(evidence.url);
  const channelId = str(evidence.channelId);
  const channelTitle = str(evidence.channelTitle);
  const customUrl = usableHandle(evidence.customUrl);
  const subscriberCount = evidence.hiddenSubscriberCount === true ? 0 : subscriberNumber(evidence.subscriberCount);
  const country = str(evidence.country);
  if (channelId && str(creator.channelId) !== channelId) return false;
  if (evidence.source === "youtube_data_api_channels_list") {
    if (channelTitle && (str(creator.displayName) !== channelTitle || str(creator.name) !== channelTitle)) return false;
    if (customUrl && str(creator.handle) !== customUrl) return false;
    if (subscriberCount > 0 && num(creator.followers) !== subscriberCount) return false;
    if (country && str(creator.region) !== country) return false;
  }
  if (thumbnailUrl && isHttpsUrl(thumbnailUrl)) {
    if (str(creator[TARGET_FIELD]) !== thumbnailUrl) return false;
    const hasHigherPriorityOauth = isHttpsUrl(str(creator.youtubeOauthVerifiedThumbnailUrl));
    if (!hasHigherPriorityOauth && str(creator.avatar) !== thumbnailUrl) return false;
  }
  return true;
}
function setProjectedField(target: Record<string, unknown>, fieldSources: Record<string, unknown>, field: string, value: unknown, source: string): number {
  if (value === undefined || value === null || value === "") return 0;
  if (field === "followers" && typeof value === "number" && value <= 0) return 0;
  target[field] = value;
  fieldSources[field] = { source };
  return 1;
}
function buildTarget(creator: Record<string, unknown>, evidence: CanonicalMediaEvidence, operationTimestampIso: string): { data: Record<string, unknown>; projectedFieldCount: number } {
  const revision = num(creator.profileImageRevision) + 1;
  const fieldSources: Record<string, unknown> = {};
  const source = evidence.source;
  const target: Record<string, unknown> = { ...creator };
  let projectedFieldCount = 0;
  const thumbnailUrl = str(evidence.thumbnailUrl) || str(evidence.url);
  const channelTitle = str(evidence.channelTitle);
  const customUrl = usableHandle(evidence.customUrl);
  const subscriberCount = evidence.hiddenSubscriberCount === true ? 0 : subscriberNumber(evidence.subscriberCount);
  const country = str(evidence.country);
  if (str(evidence.channelId)) projectedFieldCount += setProjectedField(target, fieldSources, "channelId", str(evidence.channelId), evidence.channelIdSource ?? source);
  if (source === "youtube_data_api_channels_list") {
    if (channelTitle) {
      projectedFieldCount += setProjectedField(target, fieldSources, "displayName", channelTitle, source);
      projectedFieldCount += setProjectedField(target, fieldSources, "name", channelTitle, source);
    }
    projectedFieldCount += setProjectedField(target, fieldSources, "handle", customUrl, source);
    projectedFieldCount += setProjectedField(target, fieldSources, "followers", subscriberCount, source);
    projectedFieldCount += setProjectedField(target, fieldSources, "region", country, source);
  }
  if (thumbnailUrl && isHttpsUrl(thumbnailUrl)) {
    projectedFieldCount += setProjectedField(target, fieldSources, TARGET_FIELD, thumbnailUrl, source);
    if (!isHttpsUrl(str(creator.youtubeOauthVerifiedThumbnailUrl))) {
      projectedFieldCount += setProjectedField(target, fieldSources, "avatar", thumbnailUrl, source);
    }
  }
  if (str(creator.category)) fieldSources.category = { source: "preserved_existing" };
  const provenance: Record<string, unknown> = { schema: "flu.creatorCanonicalProfile.v1", status: "verified", targetField: TARGET_FIELD, source, verifiedAtIso: operationTimestampIso, revision, fieldSources };
  if (evidence.sourceUrlDigest) provenance.sourceUrlDigest = evidence.sourceUrlDigest;
  if (evidence.fetchedAtIso) provenance.evidenceFetchedAtIso = evidence.fetchedAtIso;
  target.profileImageRevision = revision;
  target.profileImageVerifiedAt = operationTimestampIso;
  target.canonicalMediaReconciliation = provenance;
  return { data: target, projectedFieldCount };
}
function isOwnedCanonical(data: Record<string, unknown>): boolean { const rec = data.canonicalMediaReconciliation as Record<string, unknown> | undefined; return (rec?.schema === "flu.creatorCanonicalMedia.v1" || rec?.schema === "flu.creatorCanonicalProfile.v1") && rec?.targetField === TARGET_FIELD; }

export async function buildCreatorCanonicalMediaPlan(options: CanonicalMediaPlanOptions): Promise<CanonicalMediaPlan> {
  const operationId = options.operationId || `flu-creator-media-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const operationTimestampIso = validateOperationTimestamp(options.operationTimestampIso || (options.apply ? new Date().toISOString() : STABLE_PREVIEW_OPERATION_TIMESTAMP_ISO));
  const allCreators = await readAll(options.db, CREATORS_COLLECTION);
  const targetCreatorIds = validateTargetCreatorIds(options.targetCreatorIds, allCreators);
  const targetSet = targetCreatorIds ? new Set(targetCreatorIds) : null;
  const creators = targetSet ? allCreators.filter((creator) => targetSet.has(str(creator.id))) : allCreators;
  const classifications = emptyClassifications();
  const writes: CanonicalMediaWrite[] = [];
  const manifest: CanonicalMediaManifestRow[] = [];
  const publicBackupRefs: CanonicalMediaPublicBackupRef[] = [];
  const privateBackupDocs: CanonicalMediaPrivateBackupDoc[] = [];
  for (const creator of creators) {
    const creatorId = str(creator.id);
    const creatorDigest = await sha256Hex(creatorId, 24);
    const beforeDigest = await sha256Hex(creator, 24);
    const channelId = resolvedCreatorChannel(creator)?.channelId ?? "";
    const legacyAvatar = legacyAvatarCandidate(creator);
    const evidence = chooseEvidence(creator, options.youtubeEvidenceByChannelId, options.legacyAvatarEvidenceByCreatorId);
    const waiver = validateWaiver(options.waiverPlan?.rows?.[creatorId]);
    let classification: CanonicalMediaClassification; let reason = ""; let target: Record<string, unknown> | undefined; let deterministicAfterDigest: string | undefined; let projectedFieldCount: number | undefined;
    if (!evidence) { if (waiver) { classification = "skip_waived_no_evidence"; reason = "explicit waiver for missing canonical media evidence; not marked repaired"; } else { classification = "skip_no_evidence"; reason = "no verified channel thumbnail or verified legacy YouTube-hosted avatar evidence"; } }
    else if (newerOwnedEvidenceWouldRegress(creator, evidence)) { classification = "conflict_existing_canonical"; reason = "newer verified canonical profile evidence must not be replaced by older evidence"; }
    else if (isOwnedCanonical(creator) && !hasProfileEvidence(evidence) && str(creator[TARGET_FIELD]) === evidence.url) { classification = "skip_already_current"; reason = "target field already matches verified canonical media and owned metadata"; }
    else if (isOwnedCanonical(creator) && projectedProfileMatches(creator, evidence)) { classification = "skip_already_current"; reason = hasProfileEvidence(evidence) ? "verified canonical profile fields already match the reviewed evidence" : "target field already matches verified canonical media and owned metadata"; }
    else { const built = buildTarget(creator, evidence, operationTimestampIso); target = built.data; projectedFieldCount = built.projectedFieldCount; deterministicAfterDigest = await sha256Hex(target, 24); const current = str(creator[TARGET_FIELD]); if (current && current !== evidence.url && !isOwnedCanonical(creator)) { classification = "conflict_existing_canonical"; reason = "existing canonical thumbnail differs and is not owned by this reconciliation receipt"; } else if (current) { classification = "update"; reason = "owned canonical profile projection will be updated to deterministic target"; } else { classification = "create"; reason = "canonical profile projection will be created from verified evidence"; } }
    classifications[classification] += 1;
    if (target && deterministicAfterDigest && (classification === "create" || classification === "update")) {
      const appliedAction = classification;
      writes.push({ creatorId, creatorDigest, deterministicData: target, beforeDigest, deterministicAfterDigest, appliedAction });
      publicBackupRefs.push({ creatorDigest, beforeDigest, deterministicAfterDigest, appliedAction });
      privateBackupDocs.push({ creatorId, creatorDigest, beforeExists: true, beforeData: creator, beforeDigest, deterministicAfterDigest, appliedAction });
    }
    manifest.push({ creatorDigest, ...(channelId ? { channelIdDigest: await sha256Hex(channelId, 24) } : {}), ...(legacyAvatar ? { legacyAvatarDigest: await sha256Hex(legacyAvatar, 24) } : {}), ...(evidence?.url ? { targetUrlDigest: await sha256Hex(evidence.url, 24) } : {}), beforeDigest, ...(deterministicAfterDigest ? { deterministicAfterDigest } : {}), classification, reason, source: evidence?.source ?? "none", ...(evidence?.fetchedAtIso ? { evidenceFetchedAtIso: evidence.fetchedAtIso } : {}), ...(projectedFieldCount !== undefined ? { projectedFieldCount } : {}), ...(waiver ? { waiver: { waiverDigest: await sha256Hex(waiver, 24), expiresAtIso: waiver.expiresAtIso } } : {}) });
  }
  const counts: CanonicalMediaCounts = { scanned: creators.length, eligibleEvidence: manifest.filter((r) => r.source !== "none").length, wouldWrite: writes.length, written: 0, createCount: classifications.create, updateCount: classifications.update, skipAlreadyCurrentCount: classifications.skip_already_current, skipNoEvidenceCount: classifications.skip_no_evidence, waivedNoEvidenceCount: classifications.skip_waived_no_evidence, conflictCount: classifications.conflict_existing_canonical, classifications };
  const sourceRows = await Promise.all(creators.map(async (c) => ({ creatorDigest: await sha256Hex(str(c.id), 24), docDigest: await sha256Hex(c, 24) })));
  const sourceFingerprint = await sha256Hex(sourceRows, 64);
  const destinationRows = await Promise.all(creators.map(async (c) => ({ creatorDigest: await sha256Hex(str(c.id), 24), targetDigest: str(c[TARGET_FIELD]) ? await sha256Hex(str(c[TARGET_FIELD]), 24) : null })));
  const destinationFingerprint = await sha256Hex(destinationRows, 64);
  const rowManifestDigest = await sha256Hex(manifest, 64);
  const receiptPath = options.receiptPath || `<public-receipt-path-for-${operationId}.json>`;
  const privateBackupReceipt: CanonicalMediaPrivateBackupReceipt = { schema: PRIVATE_BACKUP_SCHEMA, sensitivity: "restricted_pii_private_rollback_backup", operationId, publicReceiptDigest: "pending_public_receipt_digest", generatedAtIso: operationTimestampIso, backupDocs: privateBackupDocs };
  const privateDigest = await sha256Hex(privateBackupReceipt, 64);
  const receipt: CanonicalMediaPublicReceipt = { schema: RECEIPT_SCHEMA, artifactSensitivity: "public_redacted_no_pii", operationId, mode: options.apply ? "apply_pending" : "preview", apply: options.apply === true, final: false, generatedAtIso: operationTimestampIso, operationTimestampIso, target: options.target || "unknown", projectId: options.projectId || "unknown", sourceSha: options.sourceSha || "unknown", treeSha: options.treeSha || "unknown", rollbackCommand: `node scripts/reconcile-creator-canonical-media.mjs --rollback --receipt ${receiptPath}`, counts, sourceFingerprint, destinationFingerprint, rowManifestDigest, rowManifest: manifest, publicBackupRefs, privateBackupReceipt: { sensitivity: "restricted_pii_private_rollback_backup", storageClass: "non_shareable_gitignored_chmod_0600", pathClassification: "private_local_path_not_for_sharing", digest: privateDigest }, committedBatches: [] };
  return { writes, rowManifest: manifest, publicBackupRefs, privateBackupDocs, counts, sourceFingerprint, destinationFingerprint, rowManifestDigest, operationId, operationTimestampIso, receipt, privateBackupReceipt: { ...privateBackupReceipt, publicReceiptDigest: await sha256Hex(receipt, 64) } };
}

export async function applyCreatorCanonicalMediaPlan(db: FirestoreDb, plan: Pick<CanonicalMediaPlan, "writes">, onBatchCommitted?: (batch: CanonicalMediaCommittedBatch, committedBatches: readonly CanonicalMediaCommittedBatch[]) => void | Promise<void>): Promise<{ written: number; committedBatches: CanonicalMediaCommittedBatch[] }> {
  const committedBatches: CanonicalMediaCommittedBatch[] = [];
  let written = 0;
  for (let i = 0; i < plan.writes.length; i += MAX_CAS_BATCH_SIZE) {
    const chunk = plan.writes.slice(i, i + MAX_CAS_BATCH_SIZE);
    const batchIndex = i / MAX_CAS_BATCH_SIZE;
    await db.runTransaction(async (tx) => {
      const refs = chunk.map((w) => db.collection(CREATORS_COLLECTION).doc(w.creatorId));
      const snaps: FirebaseFirestore.DocumentSnapshot[] = [];
      for (const ref of refs) snaps.push(await tx.get(ref));
      for (let j = 0; j < chunk.length; j += 1) { const write = chunk[j]; const snap = snaps[j]; const current = snap.exists ? ({ id: snap.id, ...(snap.data() ?? {}) } as Record<string, unknown>) : null; const currentDigest = await sha256Hex(current, 24); if (currentDigest !== write.beforeDigest) throw new Error(`creator_media_before_digest_changed:${write.creatorDigest}`); }
      for (let j = 0; j < chunk.length; j += 1) tx.set(refs[j], Object.fromEntries(Object.entries(chunk[j].deterministicData).filter(([key]) => key !== "id")), { merge: false });
    });
    const batchDigest = await sha256Hex(chunk.map((w) => ({ creatorDigest: w.creatorDigest, beforeDigest: w.beforeDigest, afterDigest: w.deterministicAfterDigest })), 64);
    const committedBatch = { batchIndex, count: chunk.length, batchDigest, committedAtIso: new Date().toISOString(), creatorDigests: chunk.map((w) => w.creatorDigest) };
    committedBatches.push(committedBatch);
    await onBatchCommitted?.(committedBatch, committedBatches);
    written += chunk.length;
  }
  return { written, committedBatches };
}

type RollbackRow = { readonly creatorDigest: string; readonly action: "restored" | "skipped_changed"; readonly beforeDigest: string; readonly afterDigest: string; readonly currentDigest: string };

async function assertValidRollbackReceipts(publicReceipt: CanonicalMediaPublicReceipt, privateReceipt: CanonicalMediaPrivateBackupReceipt, mode: "final" | "pending"): Promise<void> {
  if (publicReceipt.schema !== RECEIPT_SCHEMA) throw new Error("invalid_public_receipt_schema");
  if (publicReceipt.apply !== true) throw new Error("rollback_requires_apply_receipt");
  if (mode === "final" && (publicReceipt.mode !== "apply_final" || publicReceipt.final !== true)) throw new Error("rollback_requires_final_apply_receipt");
  if (mode === "pending" && (publicReceipt.mode !== "apply_pending" || publicReceipt.final !== false)) throw new Error("pending_recovery_requires_pending_apply_receipt");
  if (!Array.isArray(publicReceipt.committedBatches) || publicReceipt.committedBatches.length === 0) throw new Error("rollback_requires_committed_batches");
  if (privateReceipt.schema !== PRIVATE_BACKUP_SCHEMA || privateReceipt.sensitivity !== "restricted_pii_private_rollback_backup") throw new Error("invalid_private_backup_receipt");
  if (privateReceipt.operationId !== publicReceipt.operationId) throw new Error("rollback_receipt_operation_mismatch");
  const publicRefs = new Map(publicReceipt.publicBackupRefs.map((ref) => [ref.creatorDigest, ref]));
  for (const batch of publicReceipt.committedBatches) {
    if (batch.count > MAX_CAS_BATCH_SIZE) throw new Error("rollback_committed_batch_exceeds_limit");
    if (!Array.isArray(batch.creatorDigests) || batch.creatorDigests.length !== batch.count) throw new Error("rollback_invalid_committed_batch_shape");
    for (const creatorDigest of batch.creatorDigests) if (!publicRefs.has(creatorDigest)) throw new Error("rollback_committed_creator_missing_public_ref");
    const expectedBatchDigest = await sha256Hex(batch.creatorDigests.map((creatorDigest: string) => { const ref = publicRefs.get(creatorDigest)!; return { creatorDigest, beforeDigest: ref.beforeDigest, afterDigest: ref.deterministicAfterDigest }; }), 64);
    if (batch.batchDigest !== expectedBatchDigest) throw new Error("rollback_committed_batch_digest_mismatch");
  }
  const committedDigestCounts = new Map<string, number>();
  for (const batch of publicReceipt.committedBatches) for (const creatorDigest of batch.creatorDigests) committedDigestCounts.set(creatorDigest, (committedDigestCounts.get(creatorDigest) ?? 0) + 1);
  for (const [creatorDigest, count] of committedDigestCounts) if (count !== 1) throw new Error("rollback_duplicate_committed_creator_digest");
  const privateBackupCounts = new Map<string, number>();
  for (const backup of privateReceipt.backupDocs) if (committedDigestCounts.has(backup.creatorDigest)) privateBackupCounts.set(backup.creatorDigest, (privateBackupCounts.get(backup.creatorDigest) ?? 0) + 1);
  for (const creatorDigest of committedDigestCounts.keys()) {
    const count = privateBackupCounts.get(creatorDigest) ?? 0;
    if (count === 0) throw new Error("rollback_missing_private_backup_for_committed_creator");
    if (count > 1) throw new Error("rollback_duplicate_private_backup_for_committed_creator");
  }
  for (const backup of privateReceipt.backupDocs) {
    const ref = publicRefs.get(backup.creatorDigest);
    if (!ref) continue;
    const canonicalBeforeData = { id: backup.creatorId, ...backup.beforeData };
    const canonicalBeforeDigest = await sha256Hex(canonicalBeforeData, 24);
    if (canonicalBeforeDigest !== backup.beforeDigest) throw new Error("rollback_private_before_data_digest_mismatch");
    if (ref.beforeDigest !== backup.beforeDigest || ref.deterministicAfterDigest !== backup.deterministicAfterDigest || ref.appliedAction !== backup.appliedAction) throw new Error("rollback_private_backup_mismatches_public_after_digest");
  }
}

async function rollbackCommittedBatches(db: FirestoreDb, publicReceipt: CanonicalMediaPublicReceipt, privateReceipt: CanonicalMediaPrivateBackupReceipt, mode: "final" | "pending"): Promise<{ restored: number; skippedChanged: number; checked: number; proofDigest: string; rows: readonly RollbackRow[] }> {
  await assertValidRollbackReceipts(publicReceipt, privateReceipt, mode);
  const committed = new Set(publicReceipt.committedBatches.flatMap((b) => b.creatorDigests));
  const publicRefByDigest = new Map(publicReceipt.publicBackupRefs.map((ref) => [ref.creatorDigest, ref]));
  const backups = privateReceipt.backupDocs.filter((b) => committed.has(b.creatorDigest));
  let restored = 0; let skippedChanged = 0; const rows: RollbackRow[] = [];
  for (let i = 0; i < backups.length; i += MAX_CAS_BATCH_SIZE) {
    const chunk = backups.slice(i, i + MAX_CAS_BATCH_SIZE);
    const result = await db.runTransaction(async (tx) => { const refs = chunk.map((b) => db.collection(CREATORS_COLLECTION).doc(b.creatorId)); const snaps: FirebaseFirestore.DocumentSnapshot[] = []; for (const ref of refs) snaps.push(await tx.get(ref)); const chunkRows: RollbackRow[] = []; let chunkRestored = 0; let chunkSkipped = 0; for (let j = 0; j < chunk.length; j += 1) { const backup = chunk[j]; const publicRef = publicRefByDigest.get(backup.creatorDigest); const canonicalBeforeDigest = await sha256Hex({ id: backup.creatorId, ...backup.beforeData }, 24); if (canonicalBeforeDigest !== backup.beforeDigest) throw new Error("rollback_private_before_data_digest_mismatch"); if (!publicRef || publicRef.deterministicAfterDigest !== backup.deterministicAfterDigest || publicRef.beforeDigest !== backup.beforeDigest) throw new Error("rollback_private_backup_mismatches_public_after_digest"); const snap = snaps[j]; const current = snap.exists ? ({ id: snap.id, ...(snap.data() ?? {}) } as Record<string, unknown>) : null; const currentDigest = await sha256Hex(current, 24); if (currentDigest !== backup.deterministicAfterDigest) { chunkSkipped += 1; chunkRows.push({ creatorDigest: backup.creatorDigest, action: "skipped_changed", beforeDigest: backup.beforeDigest, afterDigest: backup.deterministicAfterDigest, currentDigest }); continue; } tx.set(refs[j], Object.fromEntries(Object.entries(backup.beforeData).filter(([key]) => key !== "id")), { merge: false }); chunkRestored += 1; chunkRows.push({ creatorDigest: backup.creatorDigest, action: "restored", beforeDigest: backup.beforeDigest, afterDigest: backup.deterministicAfterDigest, currentDigest }); } return { chunkRows, chunkRestored, chunkSkipped }; });
    restored += result.chunkRestored; skippedChanged += result.chunkSkipped; rows.push(...result.chunkRows);
  }
  return { restored, skippedChanged, checked: backups.length, proofDigest: await sha256Hex(rows, 64), rows };
}

export async function rollbackCreatorCanonicalMediaReceipt(db: FirestoreDb, publicReceipt: CanonicalMediaPublicReceipt, privateReceipt: CanonicalMediaPrivateBackupReceipt): Promise<{ restored: number; skippedChanged: number; checked: number; proofDigest: string; rows: readonly RollbackRow[] }> {
  return rollbackCommittedBatches(db, publicReceipt, privateReceipt, "final");
}

export async function rollbackCreatorCanonicalMediaPendingReceipt(db: FirestoreDb, publicReceipt: CanonicalMediaPublicReceipt, privateReceipt: CanonicalMediaPrivateBackupReceipt): Promise<{ restored: number; skippedChanged: number; checked: number; proofDigest: string; rows: readonly RollbackRow[] }> {
  return rollbackCommittedBatches(db, publicReceipt, privateReceipt, "pending");
}
