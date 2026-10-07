// Firestore-backed duplicate detection at scale (handoff §6). Composes the pure
// duplicateDetectionCore (exact gates + bounded near-duplicate ranking). Fail-closed, bounded
// everywhere:
//  - Candidate retrieval NEVER scans the whole collection — it issues three bounded, indexed
//    (`.where(...).where("stale","==",false).limit(N)`) queries (exact youtubeVideoId, exact
//    fileHash, pHashBucket) and unions the result, then hands that bounded set to the pure core's
//    O(candidates) ranking. No all-pairs / O(n^2) scan exists anywhere in this file.
//  - Fingerprints are versioned (DUPLICATE_DETECTION_VERSION) and revision-guarded: an
//    out-of-order/older-revision write is rejected rather than regressing live signal content, and
//    `invalidateStaleFingerprintsOnRevision` marks any lower-revision fingerprint doc `stale:true` so
//    it can never resurface as a live candidate for other submissions once a newer canonical revision
//    exists.
//
// PRIVACY: fingerprints store only opaque submission/program ids and derived hash/vector signals
// (fileHash/pHash/minHash) — never raw PII, no email/UID/token/recipient address.

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  DUPLICATE_DETECTION_VERSION,
  detectExactDuplicate,
  rankNearDuplicateCandidates,
  type ExactDuplicateHit,
  type NearDuplicateCandidate,
  type VideoFingerprint,
} from "./duplicateDetectionCore";

export const SCP_VIDEO_FINGERPRINT_COLLECTION = "scp_video_fingerprints";
export const SCP_VIDEO_DEDUP_RESULT_COLLECTION = "scp_video_dedup_results";
export const DUPLICATE_DETECTION_STORE_VERSION = "duplicate_detection_store_v1" as const;

const DEFAULT_CANDIDATE_LIMIT_PER_QUERY = 50;
const MAX_CANDIDATE_LIMIT_PER_QUERY = 200;
const STALE_INVALIDATION_LIMIT = 25;
const DEFAULT_BACKFILL_LIMIT = 500;
const MAX_BACKFILL_LIMIT = 500;

function fingerprintDocId(videoSubmissionId: unknown): string {
  const safe = String(videoSubmissionId ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
  if (!safe) throw new Error("invalid-argument: videoSubmissionId is required");
  return safe;
}

function clampCandidateLimit(value: number | undefined): number {
  const n = Number.isFinite(value) ? Math.trunc(value as number) : DEFAULT_CANDIDATE_LIMIT_PER_QUERY;
  return Math.min(MAX_CANDIDATE_LIMIT_PER_QUERY, Math.max(1, n));
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableNumberArray(value: unknown): number[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "number") ? (value as number[]) : null;
}

function pHashBucketOf(pHash: string | null): string | null {
  return typeof pHash === "string" && pHash.length >= 4 ? pHash.slice(0, 4).toLowerCase() : null;
}

function fingerprintFromDocData(fallbackId: string, data: Record<string, unknown>): VideoFingerprint {
  return {
    videoSubmissionId: asNullableString(data.videoSubmissionId) ?? fallbackId,
    youtubeVideoId: asNullableString(data.youtubeVideoId),
    fileHash: asNullableString(data.fileHash),
    pHash: asNullableString(data.pHash),
    transcriptMinHash: asNullableNumberArray(data.transcriptMinHash),
  };
}

export type UpsertFingerprintInput = {
  videoSubmissionId: string;
  youtubeVideoId?: string | null;
  fileHash?: string | null;
  pHash?: string | null;
  transcriptMinHash?: number[] | null;
  revision: number;
  canonicalProgramId?: string | null;
};

export type UpsertFingerprintResult = {
  videoSubmissionId: string;
  revision: number;
  stale: boolean;
  // true when an out-of-order/older-revision write arrived after a newer revision was already
  // stored — rejected (no-op) rather than regressing the live fingerprint content.
  rejectedStaleWrite: boolean;
};

// Idempotent upsert of a video's current fingerprint. Full-document overwrite (never a partial
// merge) so a genuine new revision fully replaces prior signal content — stale detection candidates
// can never see a blend of old + new fields. Out-of-order writes (revision below what is already
// stored) are rejected fail-closed rather than silently regressing the registry.
export async function upsertVideoFingerprint(input: UpsertFingerprintInput, now: Date): Promise<UpsertFingerprintResult> {
  if (!input.videoSubmissionId) throw new Error("invalid-argument: videoSubmissionId is required");
  if (!Number.isFinite(input.revision) || input.revision < 0) {
    throw new Error("invalid-argument: revision must be a non-negative finite number");
  }
  const ref = adminDb.collection(SCP_VIDEO_FINGERPRINT_COLLECTION).doc(fingerprintDocId(input.videoSubmissionId));
  const nowIso = now.toISOString();
  const pHash = asNullableString(input.pHash ?? null);
  const pHashBucket = pHashBucketOf(pHash);

  let rejectedStaleWrite = false;
  let effectiveRevision = input.revision;

  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const priorRevision = Number(snap.data()?.revision ?? 0);
      if (input.revision < priorRevision) {
        rejectedStaleWrite = true;
        effectiveRevision = priorRevision;
        return;
      }
    }
    tx.set(ref, {
      videoSubmissionId: input.videoSubmissionId,
      youtubeVideoId: input.youtubeVideoId ?? null,
      fileHash: input.fileHash ?? null,
      pHash,
      pHashBucket,
      transcriptMinHash: Array.isArray(input.transcriptMinHash) ? input.transcriptMinHash : null,
      revision: input.revision,
      canonicalProgramId: input.canonicalProgramId ?? null,
      version: DUPLICATE_DETECTION_VERSION,
      stale: false,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return {
    videoSubmissionId: input.videoSubmissionId,
    revision: effectiveRevision,
    stale: false,
    rejectedStaleWrite,
  };
}

// Mark any fingerprint doc for `videoSubmissionId` whose stored revision is strictly below
// `newRevision` as stale=true. Bounded, indexed query (never a collection scan) so a new canonical
// revision safely invalidates prior-revision fingerprints — they stop matching future candidate
// queries (which always filter `stale == false`) without being deleted (audit trail preserved).
export async function invalidateStaleFingerprintsOnRevision(
  videoSubmissionId: string,
  newRevision: number,
  now: Date,
): Promise<number> {
  if (!videoSubmissionId) throw new Error("invalid-argument: videoSubmissionId is required");
  if (!Number.isFinite(newRevision)) throw new Error("invalid-argument: newRevision must be finite");
  const nowIso = now.toISOString();
  const snap = await adminDb
    .collection(SCP_VIDEO_FINGERPRINT_COLLECTION)
    .where("videoSubmissionId", "==", videoSubmissionId)
    .where("stale", "==", false)
    .where("revision", "<", newRevision)
    .limit(STALE_INVALIDATION_LIMIT)
    .get();
  if (snap.empty) return 0;
  const batch = adminDb.batch();
  for (const doc of snap.docs) {
    batch.set(doc.ref, { stale: true, updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  await batch.commit();
  return snap.size;
}

export type EvaluateDuplicateOptions = {
  candidateLimitPerQuery?: number;
  topK?: number;
  threshold?: number;
};

export type EvaluateDuplicateResult = {
  videoSubmissionId: string;
  exactHit: ExactDuplicateHit | null;
  topK: NearDuplicateCandidate[];
  clusterId: string | null;
  scanned: number;
  version: typeof DUPLICATE_DETECTION_VERSION;
  evaluatedAtIso: string;
};

// Evaluate a registered submission's fingerprint against a BOUNDED candidate set built from three
// indexed queries (exact youtubeVideoId, exact fileHash, pHashBucket), each `.limit(N)` and filtered
// to `stale == false`. Candidates are unioned + deduped, self- and stale-excluded, then handed to the
// pure core (detectExactDuplicate + rankNearDuplicateCandidates) — never an all-pairs / full-scan
// comparison. Persists a bounded result doc for reviewer consumption and returns it.
export async function evaluateDuplicateForSubmission(
  videoSubmissionId: string,
  opts: EvaluateDuplicateOptions = {},
  now: Date = new Date(),
): Promise<EvaluateDuplicateResult> {
  if (!videoSubmissionId) throw new Error("invalid-argument: videoSubmissionId is required");
  const queryRef = adminDb.collection(SCP_VIDEO_FINGERPRINT_COLLECTION).doc(fingerprintDocId(videoSubmissionId));
  const querySnap = await queryRef.get();
  if (!querySnap.exists) throw new Error("not_found: no fingerprint registered for videoSubmissionId");
  const queryData = querySnap.data() ?? {};
  if (queryData.stale === true) {
    throw new Error("failed-precondition: query fingerprint is stale; upsert a current-revision fingerprint before evaluating");
  }
  const queryFp = fingerprintFromDocData(videoSubmissionId, queryData);
  const limitPerQuery = clampCandidateLimit(opts.candidateLimitPerQuery);
  const col = adminDb.collection(SCP_VIDEO_FINGERPRINT_COLLECTION);

  const pending: Promise<FirebaseFirestore.QuerySnapshot>[] = [];
  if (queryFp.youtubeVideoId) {
    pending.push(col.where("youtubeVideoId", "==", queryFp.youtubeVideoId).where("stale", "==", false).limit(limitPerQuery).get());
  }
  if (queryFp.fileHash) {
    pending.push(col.where("fileHash", "==", queryFp.fileHash).where("stale", "==", false).limit(limitPerQuery).get());
  }
  const pHashBucket = asNullableString(queryData.pHashBucket) ?? pHashBucketOf(queryFp.pHash ?? null);
  if (pHashBucket) {
    pending.push(col.where("pHashBucket", "==", pHashBucket).where("stale", "==", false).limit(limitPerQuery).get());
  }

  const snaps = pending.length ? await Promise.all(pending) : [];
  const byId = new Map<string, VideoFingerprint>();
  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const data = doc.data();
      const candidateId = asNullableString(data.videoSubmissionId) ?? doc.id;
      if (candidateId === videoSubmissionId) continue; // exclude self
      if (data.stale === true) continue; // defensive double-guard: never resurface a stale prior-revision fingerprint
      if (byId.has(candidateId)) continue; // union + dedup across the three bounded candidate queries
      byId.set(candidateId, fingerprintFromDocData(candidateId, data));
    }
  }
  const candidates = Array.from(byId.values());

  const exactHit = detectExactDuplicate(queryFp, candidates);
  const nearDup = rankNearDuplicateCandidates(queryFp, candidates, { topK: opts.topK, threshold: opts.threshold });
  const nowIso = now.toISOString();

  const result: EvaluateDuplicateResult = {
    videoSubmissionId,
    exactHit,
    topK: nearDup.topK,
    clusterId: nearDup.clusterId,
    scanned: nearDup.scanned,
    version: DUPLICATE_DETECTION_VERSION,
    evaluatedAtIso: nowIso,
  };

  await adminDb.collection(SCP_VIDEO_DEDUP_RESULT_COLLECTION).doc(fingerprintDocId(videoSubmissionId)).set({
    videoSubmissionId,
    exactHit,
    topK: result.topK,
    clusterId: result.clusterId,
    scanned: result.scanned,
    version: DUPLICATE_DETECTION_VERSION,
    evaluatedAtIso: nowIso,
    evaluatedAt: FieldValue.serverTimestamp(),
  });

  return result;
}

export type BackfillMappedSource = {
  youtubeVideoId?: string | null;
  fileHash?: string | null;
  canonicalProgramId?: string | null;
};

export type BackfillOptions = {
  sourceCollection: string;
  limit?: number;
  now?: Date;
  // Maps a source-collection doc to derivable identity fields. Perceptual/transcript signals are
  // NEVER derived here (they require downloading + processing the media asset, which is external and
  // credential-gated) — the created fingerprint is always marked pendingCompute:true for those.
  mapSourceDoc?: (videoSubmissionId: string, data: Record<string, unknown>) => BackfillMappedSource | null;
};

export type BackfillResult = {
  scanned: number;
  created: number;
  skippedExisting: number;
  pendingCompute: number;
};

// Bounded backfill (hard cap 500 per call, never unbounded/whole-collection). Callers needing full
// registry coverage must page with their own cursor across repeated bounded calls. Rows whose
// perceptual/transcript signals cannot be derived without external media compute are created with
// `pendingCompute:true` + a truthful reasonCode rather than a fabricated fingerprint value.
export async function backfillVideoFingerprintRegistry(opts: BackfillOptions): Promise<BackfillResult> {
  if (!opts.sourceCollection) throw new Error("invalid-argument: sourceCollection is required");
  const limit = Math.min(MAX_BACKFILL_LIMIT, Math.max(1, Math.trunc(opts.limit ?? DEFAULT_BACKFILL_LIMIT)));
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  const sourceSnap = await adminDb.collection(opts.sourceCollection).limit(limit).get();

  let created = 0;
  let skippedExisting = 0;
  let pendingCompute = 0;

  for (const doc of sourceSnap.docs) {
    const videoSubmissionId = doc.id;
    const fpRef = adminDb.collection(SCP_VIDEO_FINGERPRINT_COLLECTION).doc(fingerprintDocId(videoSubmissionId));
    const existing = await fpRef.get();
    if (existing.exists) {
      skippedExisting += 1;
      continue;
    }
    const data = doc.data() ?? {};
    const mapped = opts.mapSourceDoc ? opts.mapSourceDoc(videoSubmissionId, data) : null;
    await fpRef.set({
      videoSubmissionId,
      youtubeVideoId: mapped?.youtubeVideoId ?? null,
      fileHash: mapped?.fileHash ?? null,
      pHash: null,
      pHashBucket: null,
      transcriptMinHash: null,
      revision: 0,
      canonicalProgramId: mapped?.canonicalProgramId ?? null,
      version: DUPLICATE_DETECTION_VERSION,
      stale: false,
      pendingCompute: true,
      pendingComputeReasonCode: "media_compute_unavailable",
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    });
    created += 1;
    pendingCompute += 1;
  }

  return { scanned: sourceSnap.size, created, skippedExisting, pendingCompute };
}
