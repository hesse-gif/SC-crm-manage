import { createHash, createHmac, randomUUID } from "node:crypto";
import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import {
  decryptYouTubeOAuthCredentialEnvelope,
  encryptYouTubeOAuthCredentialEnvelope,
  type YouTubeOAuthCredential,
  type YouTubeOAuthCredentialEnvelope,
  type YouTubeOAuthHandoffMapping,
} from "./youtubeOAuthHandoff";

const CREDENTIALS_COLLECTION = "youtube_oauth_credentials";
const OUTBOX_COLLECTION = "youtube_oauth_lifecycle_outbox";
const DEAD_LETTER_COLLECTION = "youtube_oauth_lifecycle_dead_letters";
const LIFECYCLE_SCHEMA_VERSION = "scp.youtube-oauth-lifecycle.v1";
const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
] as const;
const REFRESH_AHEAD_MS = 10 * 60 * 1000;
const REFRESH_LEASE_MS = 2 * 60 * 1000;
const DELIVERY_LEASE_MS = 2 * 60 * 1000;
const MAX_REFRESH_FAILURES_AFTER_EXPIRY = 8;
const MAX_DELIVERY_ATTEMPTS = 8;

export type YouTubeOAuthLifecycleCode =
  | "channel_changed"
  | "expired"
  | "invalid_grant"
  | "reauth_required"
  | "revoked"
  | "scope_revoked";

export type YouTubeOAuthLifecyclePayload = YouTubeOAuthHandoffMapping & {
  code: YouTubeOAuthLifecycleCode;
  revision: string;
  schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
  sourceObservationId: string;
  sourceUpdatedAt: string;
  state: "channelChanged" | "expired" | "reauthRequired" | "revoked";
};

type FetchLike = typeof fetch;

type CredentialClaim = {
  credentialRef: DocumentReference;
  envelope: YouTubeOAuthCredentialEnvelope;
  expiresAt: string;
  leaseToken: string;
  mapping: YouTubeOAuthHandoffMapping;
  refreshFailureCount: number;
  scopes: string[];
};

type LifecycleOutboxRecord = {
  attemptCount: number;
  id: string;
  nextAttemptAtIso: string;
  payload: YouTubeOAuthLifecyclePayload;
  status: "pending" | "delivered" | "dead_letter";
};

export type RefreshCredentialResult = {
  credentialId: string;
  outcome: "channel_changed" | "expired" | "invalid_grant" | "not_due" | "refreshed" | "retry_scheduled" | "revoked" | "scope_revoked";
};

export type DeliverLifecycleResult = {
  outboxId: string;
  outcome: "dead_letter" | "delivered" | "not_due" | "retry_scheduled";
};

export async function runYouTubeOAuthCredentialRefreshSweep(input: {
  batchSize?: number;
  db?: Firestore;
  encryptionKey?: string;
  fetchImpl?: FetchLike;
  googleClientId?: string;
  googleClientSecret?: string;
  now?: Date;
} = {}): Promise<{ failed: number; notDue: number; refreshed: number; terminal: number }> {
  const db = input.db ?? (await import("./firebaseAdmin")).adminDb;
  const now = input.now ?? new Date();
  const batchSize = boundedBatchSize(input.batchSize);
  const thresholdIso = new Date(now.getTime() + REFRESH_AHEAD_MS).toISOString();
  const snapshot = await db.collection(CREDENTIALS_COLLECTION)
    .where("expiresAt", "<=", thresholdIso)
    .orderBy("expiresAt", "asc")
    .limit(batchSize * 5)
    .get();
  const summary = { failed: 0, notDue: 0, refreshed: 0, terminal: 0 };
  let processed = 0;
  for (const document of snapshot.docs) {
    if (processed >= batchSize) break;
    try {
      const result = await refreshYouTubeOAuthCredential({
        credentialRef: document.ref,
        db,
        encryptionKey: input.encryptionKey,
        fetchImpl: input.fetchImpl,
        googleClientId: input.googleClientId,
        googleClientSecret: input.googleClientSecret,
        now,
      });
      if (result.outcome === "refreshed") {
        summary.refreshed += 1;
        processed += 1;
      } else if (result.outcome === "not_due") {
        summary.notDue += 1;
      } else if (result.outcome === "retry_scheduled") {
        summary.failed += 1;
        processed += 1;
      } else {
        summary.terminal += 1;
        processed += 1;
      }
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

export async function refreshYouTubeOAuthCredential(input: {
  credentialRef: DocumentReference;
  db?: Firestore;
  encryptionKey?: string;
  fetchImpl?: FetchLike;
  googleClientId?: string;
  googleClientSecret?: string;
  now?: Date;
}): Promise<RefreshCredentialResult> {
  const db = input.db ?? (await import("./firebaseAdmin")).adminDb;
  const now = input.now ?? new Date();
  const claim = await claimCredential(db, input.credentialRef, now);
  if (!claim) return { credentialId: input.credentialRef.id, outcome: "not_due" };

  const encryptionKey = input.encryptionKey ?? process.env.YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY ?? "";
  const googleClientId = input.googleClientId ?? process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
  const googleClientSecret = input.googleClientSecret ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    if (!googleClientId || !googleClientSecret) throw lifecycleError("refresh_configuration_unavailable");
    const credential = decryptYouTubeOAuthCredentialEnvelope({
      encryptionKey,
      envelope: claim.envelope,
      mapping: claim.mapping,
    });
    if (!hasExactRequiredScopes(credential.scopes)) {
      await persistTerminalLifecycle(db, claim, now, "scope_revoked");
      return { credentialId: claim.credentialRef.id, outcome: "scope_revoked" };
    }

    const tokenResponse = await fetchImpl("https://oauth2.googleapis.com/token", {
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const tokenBody = await boundedJson(tokenResponse, 32 * 1024);
    if (!tokenResponse.ok) {
      if (tokenResponse.status === 400 && asString(tokenBody.error) === "invalid_grant") {
        await persistTerminalLifecycle(db, claim, now, "invalid_grant");
        return { credentialId: claim.credentialRef.id, outcome: "invalid_grant" };
      }
      throw lifecycleError("token_refresh_unavailable");
    }
    const accessToken = asString(tokenBody.access_token);
    const expiresIn = Number(tokenBody.expires_in);
    if (!accessToken || !Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 86_400) {
      throw lifecycleError("token_refresh_unavailable");
    }
    const refreshedScopes = tokenBody.scope === undefined
      ? credential.scopes
      : asString(tokenBody.scope).split(/\s+/).filter(Boolean);
    if (!hasExactRequiredScopes(refreshedScopes)) {
      await persistTerminalLifecycle(db, claim, now, "scope_revoked");
      return { credentialId: claim.credentialRef.id, outcome: "scope_revoked" };
    }

    const channelResponse = await fetchImpl("https://www.googleapis.com/youtube/v3/channels?part=id&mine=true", {
      headers: { authorization: `Bearer ${accessToken}` },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (channelResponse.status === 401) {
      await discardResponse(channelResponse);
      await persistTerminalLifecycle(db, claim, now, "revoked");
      return { credentialId: claim.credentialRef.id, outcome: "revoked" };
    }
    const channelBody = await boundedJson(channelResponse, 64 * 1024);
    if (channelResponse.status === 403 && providerReasonCodes(channelBody).some(isScopeFailureReason)) {
      await persistTerminalLifecycle(db, claim, now, "scope_revoked");
      return { credentialId: claim.credentialRef.id, outcome: "scope_revoked" };
    }
    if (!channelResponse.ok) throw lifecycleError("channel_check_unavailable");
    const observedChannelId = firstChannelId(channelBody);
    if (!observedChannelId || observedChannelId !== claim.mapping.channelId) {
      await persistTerminalLifecycle(db, claim, now, "channel_changed");
      return { credentialId: claim.credentialRef.id, outcome: "channel_changed" };
    }

    const refreshedCredential: YouTubeOAuthCredential = {
      accessToken,
      expiresAt: new Date(now.getTime() + Math.floor(expiresIn * 1000)).toISOString(),
      refreshToken: credential.refreshToken,
      scopes: [...REQUIRED_SCOPES],
    };
    const envelope = encryptYouTubeOAuthCredentialEnvelope({
      credential: refreshedCredential,
      encryptionKey,
      mapping: claim.mapping,
    });
    await persistSuccessfulRefresh(db, claim, refreshedCredential, envelope, now);
    return { credentialId: claim.credentialRef.id, outcome: "refreshed" };
  } catch {
    const terminal = now.getTime() >= Date.parse(claim.expiresAt) && claim.refreshFailureCount + 1 >= MAX_REFRESH_FAILURES_AFTER_EXPIRY;
    if (terminal) {
      await persistTerminalLifecycle(db, claim, now, "expired");
      return { credentialId: claim.credentialRef.id, outcome: "expired" };
    }
    await persistRefreshFailure(db, claim, now);
    return { credentialId: claim.credentialRef.id, outcome: "retry_scheduled" };
  }
}

export async function runYouTubeOAuthLifecycleDeliverySweep(input: {
  batchSize?: number;
  baseUrl?: string;
  db?: Firestore;
  fetchImpl?: FetchLike;
  now?: Date;
  secret?: string;
} = {}): Promise<{ deadLetter: number; delivered: number; failed: number; notDue: number }> {
  const db = input.db ?? (await import("./firebaseAdmin")).adminDb;
  const now = input.now ?? new Date();
  const batchSize = boundedBatchSize(input.batchSize);
  const snapshot = await db.collection(OUTBOX_COLLECTION).where("status", "==", "pending").limit(batchSize * 5).get();
  const summary = { deadLetter: 0, delivered: 0, failed: 0, notDue: 0 };
  let processed = 0;
  for (const document of snapshot.docs) {
    if (processed >= batchSize) break;
    try {
      const result = await deliverYouTubeOAuthLifecycleOutboxItem({
        baseUrl: input.baseUrl,
        db,
        fetchImpl: input.fetchImpl,
        now,
        outboxRef: document.ref,
        secret: input.secret,
      });
      if (result.outcome === "delivered") {
        summary.delivered += 1;
        processed += 1;
      } else if (result.outcome === "dead_letter") {
        summary.deadLetter += 1;
        processed += 1;
      } else if (result.outcome === "not_due") {
        summary.notDue += 1;
      } else {
        summary.failed += 1;
        processed += 1;
      }
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

export async function deliverYouTubeOAuthLifecycleOutboxItem(input: {
  baseUrl?: string;
  db?: Firestore;
  fetchImpl?: FetchLike;
  now?: Date;
  outboxRef: DocumentReference;
  secret?: string;
}): Promise<DeliverLifecycleResult> {
  const db = input.db ?? (await import("./firebaseAdmin")).adminDb;
  const now = input.now ?? new Date();
  const claim = await claimOutbox(db, input.outboxRef, now);
  if (!claim) return { outboxId: input.outboxRef.id, outcome: "not_due" };
  const secret = input.secret ?? process.env.SCP_FLU_OAUTH_LIFECYCLE_SECRET ?? process.env.SCP_FLU_INGEST_SECRET ?? "";
  let endpoint: string;
  try {
    endpoint = lifecycleEndpoint(input.baseUrl ?? process.env.SCP_CREATOR_PORTAL_BASE_URL ?? "");
    if (Buffer.byteLength(secret, "utf8") < 32) throw lifecycleError("delivery_configuration_unavailable");
  } catch {
    return finalizeDeliveryFailure(db, input.outboxRef, claim, now, true);
  }
  const body = JSON.stringify(claim.payload);
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signature = `sha256=${createHmac("sha256", secret)
    .update(`${timestamp}\n${claim.id}\n${body}`)
    .digest("hex")}`;
  try {
    const response = await (input.fetchImpl ?? fetch)(endpoint, {
      body,
      headers: {
        "content-type": "application/json",
        "x-scp-idempotency-key": claim.id,
        "x-scp-signature": signature,
        "x-scp-timestamp": timestamp,
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    await discardResponse(response);
    if (response.status === 200 || response.status === 201) {
      await markDelivered(db, input.outboxRef, claim, now, response.status);
      return { outboxId: claim.id, outcome: "delivered" };
    }
    const retryable = response.status === 429 || response.status >= 500;
    return finalizeDeliveryFailure(db, input.outboxRef, claim, now, retryable, response.status);
  } catch {
    return finalizeDeliveryFailure(db, input.outboxRef, claim, now, true);
  }
}

async function claimCredential(db: Firestore, credentialRef: DocumentReference, now: Date): Promise<CredentialClaim | null> {
  const leaseToken = randomUUID();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(credentialRef);
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data());
    if (data.status !== "active") return null;
    const expiresAt = canonicalIso(data.expiresAt);
    if (Date.parse(expiresAt) > now.getTime() + REFRESH_AHEAD_MS) return null;
    const nextAttemptAtIso = optionalIso(data.refreshNextAttemptAtIso);
    if (nextAttemptAtIso && Date.parse(nextAttemptAtIso) > now.getTime()) return null;
    const currentLease = asRecord(data.refreshLease);
    const leaseUntilIso = optionalIso(currentLease.untilIso);
    if (leaseUntilIso && Date.parse(leaseUntilIso) > now.getTime()) return null;
    const mapping = requiredMapping(data.mapping);
    const envelope = requiredEnvelope(data.envelope);
    const scopes = requiredScopes(data.scopes);
    transaction.set(credentialRef, {
      refreshLease: { token: leaseToken, untilIso: new Date(now.getTime() + REFRESH_LEASE_MS).toISOString() },
      refreshStartedAtIso: now.toISOString(),
    }, { merge: true });
    return {
      credentialRef,
      envelope,
      expiresAt,
      leaseToken,
      mapping,
      refreshFailureCount: nonNegativeInteger(data.refreshFailureCount),
      scopes,
    };
  });
}

async function persistSuccessfulRefresh(
  db: Firestore,
  claim: CredentialClaim,
  credential: YouTubeOAuthCredential,
  envelope: YouTubeOAuthCredentialEnvelope,
  now: Date,
): Promise<void> {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(claim.credentialRef);
    assertClaim(snapshot.data(), claim.leaseToken);
    transaction.set(claim.credentialRef, {
      envelope,
      expiresAt: credential.expiresAt,
      refreshFailureCount: 0,
      refreshLease: null,
      refreshNextAttemptAtIso: null,
      refreshedAtIso: now.toISOString(),
      scopes: credential.scopes,
      status: "active",
      updatedAtIso: now.toISOString(),
    }, { merge: true });
  });
}

async function persistRefreshFailure(db: Firestore, claim: CredentialClaim, now: Date): Promise<void> {
  const failureCount = claim.refreshFailureCount + 1;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(claim.credentialRef);
    assertClaim(snapshot.data(), claim.leaseToken);
    transaction.set(claim.credentialRef, {
      refreshFailureCount: failureCount,
      refreshLease: null,
      refreshNextAttemptAtIso: new Date(now.getTime() + retryDelayMs(failureCount)).toISOString(),
      updatedAtIso: now.toISOString(),
    }, { merge: true });
  });
}

async function persistTerminalLifecycle(
  db: Firestore,
  claim: CredentialClaim,
  now: Date,
  code: YouTubeOAuthLifecycleCode,
): Promise<void> {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(claim.credentialRef);
    const data = asRecord(snapshot.data());
    assertClaim(data, claim.leaseToken);
    const previousRevision = decimalRevision(data.lifecycleRevision);
    const clockRevision = BigInt(now.getTime()) * 1000n;
    const revision = (previousRevision >= clockRevision ? previousRevision + 1n : clockRevision).toString();
    const sourceObservationId = `ytol_${sha256(`${claim.credentialRef.id}\n${revision}\n${code}`).slice(0, 48)}`;
    const payload: YouTubeOAuthLifecyclePayload = {
      ...claim.mapping,
      code,
      revision,
      schemaVersion: LIFECYCLE_SCHEMA_VERSION,
      sourceObservationId,
      sourceUpdatedAt: now.toISOString(),
      state: lifecycleState(code),
    };
    const outboxId = `ytolo_${sha256(sourceObservationId).slice(0, 48)}`;
    const outboxRef = db.collection(OUTBOX_COLLECTION).doc(outboxId);
    transaction.create(outboxRef, {
      attemptCount: 0,
      createdAtIso: now.toISOString(),
      id: outboxId,
      nextAttemptAtIso: now.toISOString(),
      payload,
      status: "pending",
      updatedAtIso: now.toISOString(),
    });
    transaction.set(claim.credentialRef, {
      lifecycleRevision: revision,
      refreshLease: null,
      refreshNextAttemptAtIso: null,
      status: lifecycleCredentialStatus(code),
      updatedAtIso: now.toISOString(),
    }, { merge: true });
  });
}

async function claimOutbox(db: Firestore, outboxRef: DocumentReference, now: Date): Promise<(LifecycleOutboxRecord & { leaseToken: string }) | null> {
  const leaseToken = randomUUID();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(outboxRef);
    if (!snapshot.exists) return null;
    const record = requiredOutbox(snapshot.data());
    if (record.status !== "pending" || Date.parse(record.nextAttemptAtIso) > now.getTime()) return null;
    const currentLease = asRecord(asRecord(snapshot.data()).deliveryLease);
    const leaseUntilIso = optionalIso(currentLease.untilIso);
    if (leaseUntilIso && Date.parse(leaseUntilIso) > now.getTime()) return null;
    transaction.set(outboxRef, {
      deliveryLease: { token: leaseToken, untilIso: new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString() },
      updatedAtIso: now.toISOString(),
    }, { merge: true });
    return { ...record, leaseToken };
  });
}

async function markDelivered(
  db: Firestore,
  outboxRef: DocumentReference,
  claim: LifecycleOutboxRecord & { leaseToken: string },
  now: Date,
  responseStatus: number,
): Promise<void> {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(outboxRef);
    assertDeliveryClaim(snapshot.data(), claim.leaseToken);
    transaction.set(outboxRef, {
      attemptCount: claim.attemptCount + 1,
      deliveredAtIso: now.toISOString(),
      deliveryLease: null,
      responseStatus,
      status: "delivered",
      updatedAtIso: now.toISOString(),
    }, { merge: true });
  });
}

async function finalizeDeliveryFailure(
  db: Firestore,
  outboxRef: DocumentReference,
  claim: LifecycleOutboxRecord & { leaseToken: string },
  now: Date,
  retryable: boolean,
  responseStatus?: number,
): Promise<DeliverLifecycleResult> {
  const attemptCount = claim.attemptCount + 1;
  const deadLetter = !retryable || attemptCount >= MAX_DELIVERY_ATTEMPTS;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(outboxRef);
    assertDeliveryClaim(snapshot.data(), claim.leaseToken);
    if (deadLetter) {
      const deadLetterRef = db.collection(DEAD_LETTER_COLLECTION).doc(claim.id);
      transaction.set(deadLetterRef, {
        attemptCount,
        deadLetteredAtIso: now.toISOString(),
        id: claim.id,
        payload: claim.payload,
        responseStatus: responseStatus ?? null,
      });
      transaction.set(outboxRef, {
        attemptCount,
        deadLetteredAtIso: now.toISOString(),
        deliveryLease: null,
        responseStatus: responseStatus ?? null,
        status: "dead_letter",
        updatedAtIso: now.toISOString(),
      }, { merge: true });
      return;
    }
    transaction.set(outboxRef, {
      attemptCount,
      deliveryLease: null,
      nextAttemptAtIso: new Date(now.getTime() + retryDelayMs(attemptCount)).toISOString(),
      responseStatus: responseStatus ?? null,
      updatedAtIso: now.toISOString(),
    }, { merge: true });
  });
  return { outboxId: claim.id, outcome: deadLetter ? "dead_letter" : "retry_scheduled" };
}

function requiredOutbox(value: unknown): LifecycleOutboxRecord {
  const record = asRecord(value);
  const payload = requiredLifecyclePayload(record.payload);
  const id = requiredIdentifier(record.id);
  const status = record.status;
  if (status !== "pending" && status !== "delivered" && status !== "dead_letter") throw lifecycleError("invalid_outbox");
  return {
    attemptCount: nonNegativeInteger(record.attemptCount),
    id,
    nextAttemptAtIso: canonicalIso(record.nextAttemptAtIso),
    payload,
    status,
  };
}

function requiredLifecyclePayload(value: unknown): YouTubeOAuthLifecyclePayload {
  const record = asRecord(value);
  const expectedKeys = [
    "channelId", "code", "enrollmentId", "fluCreatorId", "partnerId", "portalCreatorId", "programId",
    "revision", "schemaVersion", "sourceObservationId", "sourceUpdatedAt", "state",
  ].sort();
  if (Object.keys(record).sort().join("|") !== expectedKeys.join("|")) throw lifecycleError("invalid_outbox");
  const mapping = requiredMapping(record);
  const code = asString(record.code) as YouTubeOAuthLifecycleCode;
  if (!["channel_changed", "expired", "invalid_grant", "reauth_required", "revoked", "scope_revoked"].includes(code)) {
    throw lifecycleError("invalid_outbox");
  }
  const revision = asString(record.revision);
  if (!/^[1-9]\d{0,19}$/.test(revision)) throw lifecycleError("invalid_outbox");
  const sourceObservationId = requiredIdentifier(record.sourceObservationId);
  const sourceUpdatedAt = canonicalIso(record.sourceUpdatedAt);
  if (record.schemaVersion !== LIFECYCLE_SCHEMA_VERSION || record.state !== lifecycleState(code)) throw lifecycleError("invalid_outbox");
  return {
    ...mapping,
    code,
    revision,
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    sourceObservationId,
    sourceUpdatedAt,
    state: lifecycleState(code),
  };
}

function requiredMapping(value: unknown): YouTubeOAuthHandoffMapping {
  const record = asRecord(value);
  return {
    channelId: requiredIdentifier(record.channelId),
    enrollmentId: requiredIdentifier(record.enrollmentId),
    fluCreatorId: requiredIdentifier(record.fluCreatorId),
    partnerId: requiredIdentifier(record.partnerId),
    portalCreatorId: requiredIdentifier(record.portalCreatorId),
    programId: requiredIdentifier(record.programId),
  };
}

function requiredEnvelope(value: unknown): YouTubeOAuthCredentialEnvelope {
  const record = asRecord(value);
  if (record.version !== 1 || record.algorithm !== "AES-256-GCM") throw lifecycleError("invalid_credential");
  return value as YouTubeOAuthCredentialEnvelope;
}

function requiredScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw lifecycleError("invalid_credential");
  return [...value];
}

function assertClaim(value: unknown, leaseToken: string): void {
  const record = asRecord(value);
  if (asString(asRecord(record.refreshLease).token) !== leaseToken || record.status !== "active") {
    throw lifecycleError("refresh_claim_lost");
  }
}

function assertDeliveryClaim(value: unknown, leaseToken: string): void {
  const record = asRecord(value);
  if (asString(asRecord(record.deliveryLease).token) !== leaseToken || record.status !== "pending") {
    throw lifecycleError("delivery_claim_lost");
  }
}

function lifecycleState(code: YouTubeOAuthLifecycleCode): YouTubeOAuthLifecyclePayload["state"] {
  if (code === "channel_changed") return "channelChanged";
  if (code === "expired") return "expired";
  if (code === "revoked" || code === "scope_revoked") return "revoked";
  return "reauthRequired";
}

function lifecycleCredentialStatus(code: YouTubeOAuthLifecycleCode): string {
  if (code === "channel_changed") return "channel_changed";
  if (code === "expired") return "expired";
  if (code === "revoked" || code === "scope_revoked") return "revoked";
  return "reauth_required";
}

function hasExactRequiredScopes(scopes: string[]): boolean {
  const normalized = [...new Set(scopes)].sort();
  return normalized.length === REQUIRED_SCOPES.length && REQUIRED_SCOPES.every((scope) => normalized.includes(scope));
}

function firstChannelId(value: unknown): string {
  const items = asRecord(value).items;
  if (!Array.isArray(items) || items.length !== 1) return "";
  return asString(asRecord(items[0]).id);
}

function providerReasonCodes(value: unknown): string[] {
  const errors = asRecord(asRecord(value).error).errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((item) => asString(asRecord(item).reason)).filter(Boolean);
}

function isScopeFailureReason(reason: string): boolean {
  return reason === "insufficientPermissions" || reason === "insufficient_scope";
}

async function boundedJson(response: Response, maximumBytes: number): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) throw lifecycleError("provider_response_invalid");
  try {
    return asRecord(JSON.parse(text));
  } catch {
    throw lifecycleError("provider_response_invalid");
  }
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Deliberately discard provider/Portal response bodies; they are not log or audit material.
  }
}

function lifecycleEndpoint(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw lifecycleError("delivery_configuration_unavailable");
  }
  parsed.pathname = "/api/internal/flu/v1/youtube-oauth-lifecycle";
  return parsed.toString();
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(6 * 60 * 60 * 1000, 60_000 * (2 ** Math.min(Math.max(attemptCount - 1, 0), 8)));
}

function decimalRevision(value: unknown): bigint {
  const text = asString(value);
  return /^[1-9]\d{0,19}$/.test(text) ? BigInt(text) : 0n;
}

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw lifecycleError("invalid_batch_size");
  return value;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function requiredIdentifier(value: unknown): string {
  const text = asString(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(text)) throw lifecycleError("invalid_identifier");
  return text;
}

function canonicalIso(value: unknown): string {
  const text = asString(value);
  if (!text || !Number.isFinite(Date.parse(text))) throw lifecycleError("invalid_timestamp");
  const canonical = new Date(text).toISOString();
  if (canonical !== text) throw lifecycleError("invalid_timestamp");
  return canonical;
}

function optionalIso(value: unknown): string | null {
  return value === undefined || value === null ? null : canonicalIso(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lifecycleError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
