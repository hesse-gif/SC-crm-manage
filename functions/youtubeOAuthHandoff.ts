import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
// PLAN-ORG-MAIL-IDENTITY Slice 2: the AES-256-GCM envelope primitives used below were
// extracted verbatim into ./oauthCredentialEnvelope so functions/mailOAuth.ts can reuse them
// without duplicating this crypto. Behavior here is byte-identical to before the move.
import {
  decryptAesGcm,
  encryptAesGcm,
  encryptionKeyVersion,
  parseEncryptionKey,
  sha256,
  stableStringify,
  type AesGcmCiphertext,
} from "./oauthCredentialEnvelope";

export const YOUTUBE_OAUTH_HANDOFF_CONTRACT = "scp.youtube-oauth-handoff.v1";
export const YOUTUBE_OAUTH_HANDOFF_STATUS_CONTRACT = "scp.youtube-oauth-handoff-status.v1";

const MAX_BODY_BYTES = 64 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const MAX_AUTHENTICATED_REQUESTS_PER_MINUTE = 120;
// F2: audience collector 도 **같은 목록**으로 scope 정합을 판정해야 한다(사본 금지).
export const YOUTUBE_OAUTH_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
] as const;
const REQUIRED_SCOPES = YOUTUBE_OAUTH_REQUIRED_SCOPES;

const HANDOFFS_COLLECTION = "youtube_oauth_handoffs";
const PORTAL_BINDINGS_COLLECTION = "scp_portal_creator_bindings";
// R4: audience collector 가 같은 매핑 원장을 읽어야 하므로 컬렉션 이름·해시 규칙을 노출한다
// (사본 금지 — 매핑 튜플 판정이 갈리면 채널을 엉뚱한 creator 에 붙인다).
export const YOUTUBE_OAUTH_MAPPINGS_COLLECTION = "youtube_oauth_mappings";
const MAPPINGS_COLLECTION = YOUTUBE_OAUTH_MAPPINGS_COLLECTION;
const CREATOR_BINDINGS_COLLECTION = "youtube_oauth_creator_bindings";
const FLU_CREATOR_BINDINGS_COLLECTION = "youtube_oauth_flu_creator_bindings";
const CREDENTIALS_COLLECTION = "youtube_oauth_credentials";
const RATE_LIMITS_COLLECTION = "youtube_oauth_handoff_rate_limits";

export type YouTubeOAuthHandoffMapping = {
  portalCreatorId: string;
  fluCreatorId: string;
  partnerId: string;
  programId: string;
  enrollmentId: string;
  channelId: string;
};

export type YouTubeOAuthCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes: string[];
};

export type YouTubeOAuthCredentialEnvelope = {
  version: 1;
  algorithm: "AES-256-GCM";
  keyVersion: string;
  keyEncryption: AesGcmCiphertext;
  payloadEncryption: AesGcmCiphertext;
};

export type NormalizedYouTubeOAuthHandoff = {
  contractVersion: typeof YOUTUBE_OAUTH_HANDOFF_CONTRACT;
  handoffId: string;
  mapping: YouTubeOAuthHandoffMapping;
  token: YouTubeOAuthCredential;
};

export type IngestYouTubeOAuthHandoffInput = {
  rawBody: string;
  timestamp: string;
  handoffIdHeader: string;
  contractVersionHeader: string;
  signature: string;
  isHttps: boolean;
  secret?: string;
  previousSecret?: string;
  encryptionKey?: string;
  now?: Date;
  db?: Firestore;
};

export type QueryYouTubeOAuthHandoffStatusInput = Omit<
  IngestYouTubeOAuthHandoffInput,
  "encryptionKey"
>;

type HandoffError = Error & { code: string };

export function youtubeOAuthPortalBindingDocumentId(fluCreatorId: string): string {
  return `scppb_${sha256(requiredIdentifier(fluCreatorId, "fluCreatorId")).slice(0, 40)}`;
}

export function signYouTubeOAuthHandoffForTest(
  rawBody: string,
  timestamp: string,
  handoffId: string,
  secret: string,
): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}\n${handoffId}\n${rawBody}`).digest("hex")}`;
}

export function verifyYouTubeOAuthHandoffSignature(input: {
  rawBody: string;
  timestamp: string;
  handoffId: string;
  signature: string;
  secret: string;
  now?: Date;
}): boolean {
  if (Buffer.byteLength(input.secret, "utf8") < 32) return false;
  if (Buffer.byteLength(input.rawBody, "utf8") > MAX_BODY_BYTES) return false;
  if (!validHandoffId(input.handoffId)) return false;
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isInteger(timestampSeconds)) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const signatureMatch = /^sha256=([a-f0-9]{64})$/i.exec(input.signature.trim());
  if (!signatureMatch) return false;
  const receivedHex = signatureMatch[1];
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}\n${input.handoffId}\n${input.rawBody}`)
    .digest();
  const received = Buffer.from(receivedHex, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function normalizeYouTubeOAuthHandoff(
  value: unknown,
  _now = new Date(),
): NormalizedYouTubeOAuthHandoff {
  const input = exactRecord(value, ["channel", "contractVersion", "creator", "handoffId", "token"], "handoff schema");
  if (input.contractVersion !== YOUTUBE_OAUTH_HANDOFF_CONTRACT) {
    throw handoffError("unsupported_contract", "unsupported handoff contract");
  }
  const handoffId = requiredIdentifier(input.handoffId, "handoffId", 128);
  if (!validHandoffId(handoffId)) throw handoffError("invalid_payload", "handoffId is invalid");

  const creator = exactRecord(input.creator, [
    "enrollmentId",
    "fluCreatorId",
    "partnerId",
    "portalCreatorId",
    "programId",
  ], "creator schema");
  const channel = exactRecord(input.channel, [
    "handle",
    "id",
    "thumbnailUrl",
    "title",
    "url",
  ], "channel schema", ["handle", "thumbnailUrl", "title", "url"]);
  const token = exactRecord(input.token, [
    "accessToken",
    "expiresAt",
    "refreshToken",
    "scopes",
  ], "token schema");

  validateOptionalChannelText(channel.handle, "channel.handle", 200);
  validateOptionalChannelText(channel.title, "channel.title", 500);
  validateOptionalHttpsUrl(channel.thumbnailUrl, "channel.thumbnailUrl");
  validateOptionalHttpsUrl(channel.url, "channel.url");

  const scopes = normalizeRequiredScopes(token.scopes);
  const expiresAt = requiredIso(token.expiresAt, "token.expiresAt");
  const accessToken = requiredSecretValue(token.accessToken, "token.accessToken");
  const refreshToken = requiredSecretValue(token.refreshToken, "token.refreshToken");
  const mapping: YouTubeOAuthHandoffMapping = {
    portalCreatorId: requiredIdentifier(creator.portalCreatorId, "creator.portalCreatorId"),
    fluCreatorId: requiredIdentifier(creator.fluCreatorId, "creator.fluCreatorId"),
    partnerId: requiredIdentifier(creator.partnerId, "creator.partnerId"),
    programId: requiredIdentifier(creator.programId, "creator.programId"),
    enrollmentId: requiredIdentifier(creator.enrollmentId, "creator.enrollmentId"),
    channelId: requiredIdentifier(channel.id, "channel.id"),
  };
  return {
    contractVersion: YOUTUBE_OAUTH_HANDOFF_CONTRACT,
    handoffId,
    mapping,
    token: { accessToken, refreshToken, expiresAt, scopes },
  };
}

export function encryptYouTubeOAuthCredentialEnvelope(input: {
  credential: YouTubeOAuthCredential;
  encryptionKey: string;
  mapping: YouTubeOAuthHandoffMapping;
}): YouTubeOAuthCredentialEnvelope {
  const keyEncryptionKey = parseEncryptionKey(input.encryptionKey);
  const dataEncryptionKey = randomBytes(32);
  const mappingDigest = mappingHash(input.mapping);
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    keyVersion: encryptionKeyVersion(keyEncryptionKey),
    keyEncryption: encryptAesGcm(
      keyEncryptionKey,
      dataEncryptionKey,
      Buffer.from(`scp.youtube-oauth-key.v1:${mappingDigest}`, "utf8"),
    ),
    payloadEncryption: encryptAesGcm(
      dataEncryptionKey,
      Buffer.from(stableStringify(input.credential), "utf8"),
      Buffer.from(`scp.youtube-oauth-payload.v1:${mappingDigest}`, "utf8"),
    ),
  };
}

export function decryptYouTubeOAuthCredentialEnvelope(input: {
  envelope: YouTubeOAuthCredentialEnvelope;
  encryptionKey: string;
  mapping: YouTubeOAuthHandoffMapping;
}): YouTubeOAuthCredential {
  try {
    if (input.envelope.version !== 1 || input.envelope.algorithm !== "AES-256-GCM") {
      throw new Error("unsupported envelope");
    }
    const keyEncryptionKey = parseEncryptionKey(input.encryptionKey);
    if (input.envelope.keyVersion !== encryptionKeyVersion(keyEncryptionKey)) {
      throw new Error("encryption key version mismatch");
    }
    const mappingDigest = mappingHash(input.mapping);
    const dataEncryptionKey = decryptAesGcm(
      keyEncryptionKey,
      input.envelope.keyEncryption,
      Buffer.from(`scp.youtube-oauth-key.v1:${mappingDigest}`, "utf8"),
    );
    if (dataEncryptionKey.length !== 32) throw new Error("invalid data key");
    const plaintext = decryptAesGcm(
      dataEncryptionKey,
      input.envelope.payloadEncryption,
      Buffer.from(`scp.youtube-oauth-payload.v1:${mappingDigest}`, "utf8"),
    );
    return normalizeCredential(JSON.parse(plaintext.toString("utf8")));
  } catch (error) {
    if ((error as HandoffError)?.code === "encryption_unavailable") throw error;
    throw handoffError("credential_decrypt_failed", "credential decrypt failed");
  }
}

export async function ingestYouTubeOAuthHandoff(
  input: IngestYouTubeOAuthHandoffInput,
): Promise<{ duplicate: boolean }> {
  if (!input.isHttps) throw handoffError("https_required", "HTTPS is required");
  if (input.contractVersionHeader !== "v1") {
    throw handoffError("unsupported_contract", "unsupported handoff contract header");
  }
  const now = input.now ?? new Date();
  const secret = input.secret ?? process.env.SCP_FLU_OAUTH_HANDOFF_SECRET ?? "";
  const previousSecret = input.previousSecret ?? process.env.SCP_FLU_OAUTH_HANDOFF_SECRET_PREVIOUS ?? "";
  const currentSignatureValid = verifyYouTubeOAuthHandoffSignature({
    rawBody: input.rawBody,
    timestamp: input.timestamp,
    handoffId: input.handoffIdHeader,
    signature: input.signature,
    secret,
    now,
  });
  const previousSignatureValid = previousSecret.length > 0 && verifyYouTubeOAuthHandoffSignature({
    rawBody: input.rawBody,
    timestamp: input.timestamp,
    handoffId: input.handoffIdHeader,
    signature: input.signature,
    secret: previousSecret,
    now,
  });
  if (!currentSignatureValid && !previousSignatureValid) {
    throw handoffError("invalid_signature", "invalid or stale handoff signature");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    throw handoffError("invalid_payload", "invalid handoff JSON");
  }
  const handoff = normalizeYouTubeOAuthHandoff(parsed, now);
  if (handoff.handoffId !== input.handoffIdHeader) {
    throw handoffError("idempotency_mismatch", "idempotency key does not match body");
  }
  const encryptionKey = input.encryptionKey ?? process.env.YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY ?? "";
  let envelope: YouTubeOAuthCredentialEnvelope;
  try {
    envelope = encryptYouTubeOAuthCredentialEnvelope({
      credential: handoff.token,
      encryptionKey,
      mapping: handoff.mapping,
    });
  } catch (error) {
    if ((error as HandoffError)?.code === "encryption_unavailable") throw error;
    throw handoffError("encryption_unavailable", "credential encryption is unavailable");
  }

  const db = input.db ?? (await import("./firebaseAdmin")).adminDb;
  await consumeAuthenticatedRateLimit(db, now);
  const bodyHash = sha256(input.rawBody);
  const handoffDocumentId = `ytoh_${sha256(handoff.handoffId).slice(0, 40)}`;
  const portalBindingDocumentId = youtubeOAuthPortalBindingDocumentId(handoff.mapping.fluCreatorId);
  const mappingDocumentId = `ytom_${sha256([
    handoff.mapping.portalCreatorId,
    handoff.mapping.programId,
    handoff.mapping.enrollmentId,
  ].join("\n")).slice(0, 40)}`;
  const creatorBindingDocumentId = `ytob_${sha256(handoff.mapping.portalCreatorId).slice(0, 40)}`;
  const fluCreatorBindingDocumentId = `ytof_${sha256(handoff.mapping.fluCreatorId).slice(0, 40)}`;
  const credentialDocumentId = `ytoc_${sha256([
    handoff.mapping.portalCreatorId,
    handoff.mapping.programId,
    handoff.mapping.enrollmentId,
  ].join("\n")).slice(0, 40)}`;

  return db.runTransaction(async (transaction) => {
    const handoffRef = db.collection(HANDOFFS_COLLECTION).doc(handoffDocumentId);
    const portalBindingRef = db.collection(PORTAL_BINDINGS_COLLECTION).doc(portalBindingDocumentId);
    const mappingRef = db.collection(MAPPINGS_COLLECTION).doc(mappingDocumentId);
    const creatorBindingRef = db.collection(CREATOR_BINDINGS_COLLECTION).doc(creatorBindingDocumentId);
    const fluCreatorBindingRef = db.collection(FLU_CREATOR_BINDINGS_COLLECTION).doc(fluCreatorBindingDocumentId);
    const credentialRef = db.collection(CREDENTIALS_COLLECTION).doc(credentialDocumentId);
    const handoffSnapshot = await transaction.get(handoffRef);
    if (handoffSnapshot.exists) {
      if (asString(handoffSnapshot.data()?.bodyHash) !== bodyHash) {
        throw handoffError("handoff_conflict", "handoff id was reused with different bytes");
      }
      return { duplicate: true };
    }

    const [portalBindingSnapshot, mappingSnapshot, creatorBindingSnapshot, fluCreatorBindingSnapshot, credentialSnapshot] = await Promise.all([
      transaction.get(portalBindingRef),
      transaction.get(mappingRef),
      transaction.get(creatorBindingRef),
      transaction.get(fluCreatorBindingRef),
      transaction.get(credentialRef),
    ]);
    if (!portalBindingSnapshot.exists || asString(portalBindingSnapshot.data()?.status) !== "active") {
      throw handoffError("mapping_unavailable", "active Portal creator binding is unavailable");
    }
    assertSameMapping(portalBindingSnapshot.data(), handoff.mapping);
    assertSameMapping(mappingSnapshot.data(), handoff.mapping);
    assertSameCreatorBinding(creatorBindingSnapshot.data(), handoff.mapping);
    assertSameCreatorBinding(fluCreatorBindingSnapshot.data(), handoff.mapping);
    assertSameMapping(credentialSnapshot.data()?.mapping, handoff.mapping);

    const nowIso = now.toISOString();
    if (!mappingSnapshot.exists) {
      transaction.create(mappingRef, {
        ...handoff.mapping,
        createdAtIso: nowIso,
        mappingHash: mappingHash(handoff.mapping),
      });
    }
    if (!creatorBindingSnapshot.exists) {
      transaction.create(creatorBindingRef, {
        portalCreatorId: handoff.mapping.portalCreatorId,
        fluCreatorId: handoff.mapping.fluCreatorId,
        partnerId: handoff.mapping.partnerId,
        channelId: handoff.mapping.channelId,
        createdAtIso: nowIso,
      });
    }
    if (!fluCreatorBindingSnapshot.exists) {
      transaction.create(fluCreatorBindingRef, {
        portalCreatorId: handoff.mapping.portalCreatorId,
        fluCreatorId: handoff.mapping.fluCreatorId,
        partnerId: handoff.mapping.partnerId,
        channelId: handoff.mapping.channelId,
        createdAtIso: nowIso,
      });
    }
    transaction.set(credentialRef, {
      id: credentialDocumentId,
      mapping: handoff.mapping,
      mappingHash: mappingHash(handoff.mapping),
      envelope,
      expiresAt: handoff.token.expiresAt,
      scopes: handoff.token.scopes,
      status: "active",
      createdAtIso: asString(credentialSnapshot.data()?.createdAtIso) || nowIso,
      updatedAtIso: nowIso,
      sourceHandoffIdHash: sha256(handoff.handoffId),
    });
    transaction.create(handoffRef, {
      id: handoffDocumentId,
      bodyHash,
      contractVersion: handoff.contractVersion,
      credentialRef: credentialRef.path,
      portalBindingRef: portalBindingRef.path,
      mappingRef: mappingRef.path,
      mappingHash: mappingHash(handoff.mapping),
      receivedAtIso: nowIso,
      status: "committed",
    });
    return { duplicate: false };
  });
}

export async function queryYouTubeOAuthHandoffStatus(
  input: QueryYouTubeOAuthHandoffStatusInput,
): Promise<{ status: "committed" | "missing" }> {
  if (!input.isHttps) throw handoffError("https_required", "HTTPS is required");
  if (input.contractVersionHeader !== "v1") {
    throw handoffError("unsupported_contract", "unsupported handoff status contract header");
  }
  const now = input.now ?? new Date();
  const secret = input.secret ?? process.env.SCP_FLU_OAUTH_HANDOFF_SECRET ?? "";
  const previousSecret = input.previousSecret ?? process.env.SCP_FLU_OAUTH_HANDOFF_SECRET_PREVIOUS ?? "";
  const currentSignatureValid = verifyYouTubeOAuthHandoffSignature({
    rawBody: input.rawBody,
    timestamp: input.timestamp,
    handoffId: input.handoffIdHeader,
    signature: input.signature,
    secret,
    now,
  });
  const previousSignatureValid = previousSecret.length > 0 && verifyYouTubeOAuthHandoffSignature({
    rawBody: input.rawBody,
    timestamp: input.timestamp,
    handoffId: input.handoffIdHeader,
    signature: input.signature,
    secret: previousSecret,
    now,
  });
  if (!currentSignatureValid && !previousSignatureValid) {
    throw handoffError("invalid_signature", "invalid or stale handoff status signature");
  }

  const db = input.db ?? (await import("./firebaseAdmin")).adminDb;
  await consumeAuthenticatedRateLimit(db, now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    throw handoffError("invalid_payload", "invalid handoff status JSON");
  }
  const statusRequest = exactRecord(parsed, ["contractVersion", "handoffId"], "handoff status schema");
  if (statusRequest.contractVersion !== YOUTUBE_OAUTH_HANDOFF_STATUS_CONTRACT) {
    throw handoffError("unsupported_contract", "unsupported handoff status contract");
  }
  const handoffId = requiredIdentifier(statusRequest.handoffId, "handoffId", 128);
  if (!validHandoffId(handoffId)) throw handoffError("invalid_payload", "handoffId is invalid");
  if (handoffId !== input.handoffIdHeader) {
    throw handoffError("idempotency_mismatch", "idempotency key does not match status body");
  }
  const handoffRef = db.collection(HANDOFFS_COLLECTION).doc(`ytoh_${sha256(handoffId).slice(0, 40)}`);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(handoffRef);
    return {
      status: snapshot.exists && asString(snapshot.data()?.status) === "committed"
        ? "committed"
        : "missing",
    };
  });
}

async function consumeAuthenticatedRateLimit(db: Firestore, now: Date): Promise<void> {
  const windowStartMs = Math.floor(now.getTime() / 60_000) * 60_000;
  const ref = db.collection(RATE_LIMITS_COLLECTION).doc(`portal_v1_${Math.floor(windowStartMs / 60_000)}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = Number(snapshot.data()?.count ?? 0);
    if (!Number.isInteger(current) || current < 0 || current >= MAX_AUTHENTICATED_REQUESTS_PER_MINUTE) {
      throw handoffError("rate_limited", "authenticated handoff rate limit exceeded");
    }
    transaction.set(ref, {
      serviceIdentity: "scp-creator-portal:v1",
      windowStartIso: new Date(windowStartMs).toISOString(),
      count: current + 1,
      updatedAtIso: now.toISOString(),
    });
  });
}

function assertSameMapping(value: unknown, expected: YouTubeOAuthHandoffMapping): void {
  if (value === undefined) return;
  const record = asRecord(value);
  const candidate = "mapping" in record ? asRecord(record.mapping) : record;
  for (const key of Object.keys(expected) as Array<keyof YouTubeOAuthHandoffMapping>) {
    if (candidate[key] !== expected[key]) {
      throw handoffError("mapping_conflict", "immutable creator/channel mapping conflict");
    }
  }
}

function assertSameCreatorBinding(value: unknown, expected: YouTubeOAuthHandoffMapping): void {
  if (value === undefined) return;
  const record = asRecord(value);
  for (const key of ["portalCreatorId", "fluCreatorId", "partnerId", "channelId"] as const) {
    if (record[key] !== expected[key]) {
      throw handoffError("mapping_conflict", "immutable creator/channel binding conflict");
    }
  }
}

function normalizeCredential(value: unknown): YouTubeOAuthCredential {
  const token = exactRecord(value, ["accessToken", "expiresAt", "refreshToken", "scopes"], "credential schema");
  return {
    accessToken: requiredSecretValue(token.accessToken, "accessToken"),
    refreshToken: requiredSecretValue(token.refreshToken, "refreshToken"),
    expiresAt: requiredIso(token.expiresAt, "expiresAt"),
    scopes: normalizeRequiredScopes(token.scopes),
  };
}

function exactRecord(
  value: unknown,
  allowedKeys: string[],
  field: string,
  optionalKeys: string[] = [],
): Record<string, unknown> {
  const record = asRecord(value);
  const keys = Object.keys(record).sort();
  const allowed = [...allowedKeys].sort();
  if (keys.some((key) => !allowed.includes(key))) throw handoffError("invalid_payload", `${field} is invalid`);
  const required = allowedKeys.filter((key) => !optionalKeys.includes(key));
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) {
    throw handoffError("invalid_payload", `${field} is incomplete`);
  }
  return record;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requiredIdentifier(value: unknown, field: string, maxLength = 160): string {
  const text = asString(value);
  if (!text || text.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(text)) {
    throw handoffError("invalid_payload", `${field} is invalid`);
  }
  return text;
}

function validHandoffId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value);
}

function requiredSecretValue(value: unknown, field: string): string {
  const text = asString(value);
  if (!text || Buffer.byteLength(text, "utf8") > 16 * 1024) {
    throw handoffError("invalid_payload", `${field} is invalid`);
  }
  return text;
}

function requiredIso(value: unknown, field: string): string {
  const text = asString(value);
  if (!text || !Number.isFinite(Date.parse(text))) throw handoffError("invalid_payload", `${field} is invalid`);
  return new Date(text).toISOString();
}

function normalizeRequiredScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string")) {
    throw handoffError("invalid_payload", "token scopes are invalid");
  }
  const scopes = [...new Set(value)].sort();
  if (scopes.length !== REQUIRED_SCOPES.length || REQUIRED_SCOPES.some((scope) => !scopes.includes(scope))) {
    throw handoffError("invalid_payload", "both required read-only scopes are mandatory");
  }
  return scopes;
}

function validateOptionalChannelText(value: unknown, field: string, maxLength: number): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.length > maxLength) throw handoffError("invalid_payload", `${field} is invalid`);
}

function validateOptionalHttpsUrl(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.length > 2_048) throw handoffError("invalid_payload", `${field} is invalid`);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") throw new Error("not https");
  } catch {
    throw handoffError("invalid_payload", `${field} is invalid`);
  }
}

export function youtubeOAuthMappingHash(mapping: YouTubeOAuthHandoffMapping): string {
  return mappingHash(mapping);
}

function mappingHash(mapping: YouTubeOAuthHandoffMapping): string {
  return sha256(stableStringify(mapping));
}

function handoffError(code: string, message: string): HandoffError {
  return Object.assign(new Error(message), { code });
}
