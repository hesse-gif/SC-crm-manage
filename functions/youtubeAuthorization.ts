import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  type CallableRequestShape,
} from "./shared";

export const YOUTUBE_AUTH_POLICY_VERSION = "youtube-external-auth-v1";

export type YouTubeAuthorizationStatus =
  | "NOT_CONFIGURED"
  | "AUTH_PENDING"
  | "AUTHORIZED"
  | "EXPIRED"
  | "REVOKED"
  | "ERROR";

export type YouTubeAuthorizationEventType =
  | "CONNECTION_STARTED"
  | "AUTHORIZED"
  | "REFRESHED"
  | "CHECKED"
  | "EXPIRED"
  | "REVOKED"
  | "FAILED";

export type NormalizedYouTubeAuthorizationEvent = {
  eventDocumentId: string;
  payloadHash: string;
  sourceEventId: string;
  eventType: YouTubeAuthorizationEventType;
  connectionId: string;
  bindingDocumentId: string;
  programId: string;
  userRef: string;
  channelId: string;
  providerAccountRef: string;
  scopes: string[];
  occurredAtIso: string;
  requestedAt: string;
  authorizedAt: string;
  expiresAt: string;
  revokedAt: string;
  lastCheckedAt: string;
  errorCode: string;
  policyVersion: string;
  programVersion: string;
  authMode: "external_api_login";
};

export type YouTubeAuthorizationRecord = {
  id: string;
  connectionId: string;
  programId: string;
  status: YouTubeAuthorizationStatus;
  authMode: "external_api_login" | "viewer_fallback";
  providerAccountRefHash: string;
  providerAccountRefMasked: string;
  userRefHash: string;
  channelId: string;
  scopes: string[];
  requestedAt: string;
  authorizedAt: string;
  expiresAt: string;
  revokedAt: string;
  lastCheckedAt: string;
  sourceEventId: string;
  policyVersion: string;
  programVersion: string;
  errorCode: string;
  needsReconnect: boolean;
  version: number;
  updatedAtIso: string;
};

export type SignedYouTubeAuthorizationWebhookInput = {
  rawBody: string;
  timestamp: string;
  signature: string;
  secret?: string;
  now?: Date;
  db?: Firestore;
};

const READ_ROLES = ["super_admin", "admin", "manager", "viewer"] as const;
const MAX_WEBHOOK_BYTES = 64 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const ALLOWED_SCOPES = new Set([
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/youtubepartner-channel-audit",
]);
const EVENT_TYPES = new Set<YouTubeAuthorizationEventType>([
  "CONNECTION_STARTED",
  "AUTHORIZED",
  "REFRESHED",
  "CHECKED",
  "EXPIRED",
  "REVOKED",
  "FAILED",
]);
const CREDENTIAL_KEY = /(?:token|secret|credential|password|privatekey|authorizationcode|authcode)/i;

export function signYouTubeAuthorizationWebhookForTest(rawBody: string, timestamp: string, secret: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function verifyYouTubeAuthorizationWebhookSignature(input: {
  rawBody: string;
  timestamp: string;
  signature: string;
  secret: string;
  now?: Date;
}): boolean {
  const { rawBody, timestamp, secret } = input;
  if (!secret || Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) return false;
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds)) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - seconds) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const receivedHex = input.signature.trim().replace(/^(?:v1|sha256)=/i, "");
  if (!/^[a-f0-9]{64}$/i.test(receivedHex)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const received = Buffer.from(receivedHex, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function normalizeYouTubeAuthorizationEvent(
  value: unknown,
  now = new Date(),
): NormalizedYouTubeAuthorizationEvent {
  if (containsCredentialMaterial(value)) throw validationError("credential fields are forbidden; Flu stores status, never OAuth credentials");
  const input = asRecord(value);
  const sourceEventId = requiredId(input.sourceEventId, "sourceEventId");
  const connectionId = requiredId(input.connectionId, "connectionId");
  const eventType = asString(input.eventType).toUpperCase() as YouTubeAuthorizationEventType;
  if (!EVENT_TYPES.has(eventType)) throw validationError("unsupported authorization event type");
  const occurredAtIso = requiredIso(input.occurredAtIso, "occurredAtIso");
  if (Date.parse(occurredAtIso) > now.getTime() + SIGNATURE_TOLERANCE_SECONDS * 1000) throw validationError("authorization event timestamp is in the future");
  const scopes = normalizeScopes(input.scopes);
  const channelId = safeOpaqueRef(input.channelId, 160);
  const expiresAt = optionalIso(input.expiresAt);
  if ((eventType === "AUTHORIZED" || eventType === "REFRESHED") && (!channelId || scopes.length === 0 || !expiresAt)) {
    throw validationError("authorized events require channelId, at least one allowed scope, and expiresAt");
  }
  const sanitized = {
    sourceEventId,
    eventType,
    connectionId,
    programId: safeId(input.programId, "scp"),
    userRef: safeOpaqueRef(input.userRef, 200),
    channelId,
    providerAccountRef: safeOpaqueRef(input.providerAccountRef, 200),
    scopes,
    occurredAtIso,
    requestedAt: optionalIso(input.requestedAt),
    authorizedAt: optionalIso(input.authorizedAt),
    expiresAt,
    revokedAt: optionalIso(input.revokedAt),
    lastCheckedAt: optionalIso(input.lastCheckedAt) || occurredAtIso,
    errorCode: safeErrorCode(input.errorCode),
    policyVersion: safeId(input.policyVersion, YOUTUBE_AUTH_POLICY_VERSION),
    programVersion: safeId(input.programVersion, "unversioned"),
    authMode: "external_api_login" as const,
  };
  const payloadHash = stableHash(sanitized);
  return {
    ...sanitized,
    payloadHash,
    eventDocumentId: `ytae_${stableHash(sourceEventId).slice(0, 40)}`,
    bindingDocumentId: `ytac_${stableHash(connectionId).slice(0, 40)}`,
  };
}

export function reduceYouTubeAuthorizationState(
  current: YouTubeAuthorizationRecord | null,
  event: NormalizedYouTubeAuthorizationEvent,
  now = new Date(),
): YouTubeAuthorizationRecord {
  if (current?.updatedAtIso && event.occurredAtIso < current.updatedAtIso) throw validationError("stale authorization event cannot overwrite newer state");
  const previousStatus = effectiveStatus(current, now);
  let status: YouTubeAuthorizationStatus;
  switch (event.eventType) {
    case "CONNECTION_STARTED": status = "AUTH_PENDING"; break;
    case "AUTHORIZED":
    case "REFRESHED": status = event.expiresAt && Date.parse(event.expiresAt) <= now.getTime() ? "EXPIRED" : "AUTHORIZED"; break;
    case "EXPIRED": status = "EXPIRED"; break;
    case "REVOKED": status = "REVOKED"; break;
    case "FAILED": status = "ERROR"; break;
    case "CHECKED": status = previousStatus; break;
  }
  const providerAccountRef = event.providerAccountRef || "";
  const next: YouTubeAuthorizationRecord = {
    id: event.bindingDocumentId,
    connectionId: event.connectionId,
    programId: event.programId || current?.programId || "scp",
    status,
    authMode: "external_api_login",
    providerAccountRefHash: providerAccountRef ? stableHash(providerAccountRef) : current?.providerAccountRefHash ?? "",
    providerAccountRefMasked: providerAccountRef ? maskOpaqueRef(providerAccountRef) : current?.providerAccountRefMasked ?? "",
    userRefHash: event.userRef ? stableHash(event.userRef) : current?.userRefHash ?? "",
    channelId: event.channelId || current?.channelId || "",
    scopes: event.scopes.length > 0 ? event.scopes : current?.scopes ?? [],
    requestedAt: event.requestedAt || (event.eventType === "CONNECTION_STARTED" ? event.occurredAtIso : current?.requestedAt ?? ""),
    authorizedAt: event.authorizedAt || ((event.eventType === "AUTHORIZED" || event.eventType === "REFRESHED") ? event.occurredAtIso : current?.authorizedAt ?? ""),
    expiresAt: event.expiresAt || current?.expiresAt || "",
    revokedAt: event.revokedAt || (event.eventType === "REVOKED" ? event.occurredAtIso : current?.revokedAt ?? ""),
    lastCheckedAt: event.lastCheckedAt || event.occurredAtIso,
    sourceEventId: event.sourceEventId,
    policyVersion: event.policyVersion,
    programVersion: event.programVersion,
    errorCode: event.eventType === "FAILED" ? event.errorCode || "external_authorization_failed" : "",
    needsReconnect: status === "EXPIRED" || status === "REVOKED" || status === "ERROR",
    version: (current?.version ?? 0) + 1,
    updatedAtIso: event.occurredAtIso,
  };
  return next;
}

export async function ingestSignedYouTubeAuthorizationWebhook(
  input: SignedYouTubeAuthorizationWebhookInput,
): Promise<{ ok: true; idempotent: boolean; connection: ReturnType<typeof publicConnection> }> {
  const now = input.now ?? new Date();
  const secret = input.secret ?? process.env.YOUTUBE_AUTH_WEBHOOK_SECRET ?? "";
  if (!verifyYouTubeAuthorizationWebhookSignature({
    rawBody: input.rawBody,
    timestamp: input.timestamp,
    signature: input.signature,
    secret,
    now,
  })) throw callableError("permission-denied", "invalid or stale YouTube authorization webhook signature");

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    throw callableError("invalid-argument", "invalid YouTube authorization webhook JSON");
  }
  const db = input.db ?? (await import("./firebaseAdmin")).adminDb;
  let event: NormalizedYouTubeAuthorizationEvent;
  try {
    event = normalizeYouTubeAuthorizationEvent(parsed, now);
  } catch (error) {
    await writeDeadLetter(db, parsed, input.rawBody, error, now);
    throw error;
  }

  try {
    return await db.runTransaction(async (transaction) => {
      const eventRef = db.collection("youtube_authorization_events").doc(event.eventDocumentId);
      const bindingRef = db.collection("youtube_authorizations").doc(event.bindingDocumentId);
      const [eventSnapshot, bindingSnapshot] = await Promise.all([
        transaction.get(eventRef),
        transaction.get(bindingRef),
      ]);
      if (eventSnapshot.exists) {
        if (asString(eventSnapshot.data()?.payloadHash) !== event.payloadHash) throw callableError("already-exists", "source event id replayed with different payload");
        return {
          ok: true as const,
          idempotent: true,
          connection: publicConnection(bindingSnapshot.data() as YouTubeAuthorizationRecord | undefined, now),
        };
      }
      const current = bindingSnapshot.exists ? bindingSnapshot.data() as YouTubeAuthorizationRecord : null;
      const next = reduceYouTubeAuthorizationState(current, event, now);
      transaction.create(eventRef, {
        id: event.eventDocumentId,
        sourceEventId: event.sourceEventId,
        payloadHash: event.payloadHash,
        eventType: event.eventType,
        connectionIdHash: stableHash(event.connectionId),
        bindingRef: bindingRef.path,
        programId: event.programId,
        channelId: event.channelId,
        scopes: event.scopes,
        occurredAtIso: event.occurredAtIso,
        policyVersion: event.policyVersion,
        programVersion: event.programVersion,
        errorCode: event.errorCode,
        createdAtIso: now.toISOString(),
      });
      transaction.set(bindingRef, next, { merge: false });
      return { ok: true as const, idempotent: false, connection: publicConnection(next, now) };
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "already-exists") await writeDeadLetter(db, parsed, input.rawBody, error, now);
    throw error;
  }
}

export async function getYouTubeAuthorizationStatus(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "youtube.authorization.read", READ_ROLES);
  const data = asRecord(request.data);
  const connectionId = safeId(data.connectionId, "");
  const programId = safeId(data.programId, "");
  const db = (await import("./firebaseAdmin")).adminDb;
  const integrationSnapshot = await db.doc("integrations/default").get();
  const externalApi = asRecord(integrationSnapshot.data()?.externalApi);
  const publicConfig = asRecord(externalApi.public);
  const callbackEnabled = publicConfig.youtubeAuthCallbackEnabled === true;
  const configuredMode = publicConfig.youtubeAuthMode === "external_api_login"
    ? "external_api_login"
    : "viewer_fallback";
  const mode = callbackEnabled && configuredMode === "external_api_login"
    ? "external_api_login"
    : "viewer_fallback";
  let rows: YouTubeAuthorizationRecord[] = [];
  if (connectionId) {
    const snapshot = await db.collection("youtube_authorizations").doc(`ytac_${stableHash(connectionId).slice(0, 40)}`).get();
    if (snapshot.exists) rows = [snapshot.data() as YouTubeAuthorizationRecord];
  } else {
    const snapshot = programId
      ? await db.collection("youtube_authorizations").where("programId", "==", programId).limit(50).get()
      : await db.collection("youtube_authorizations").orderBy("updatedAtIso", "desc").limit(50).get();
    rows = snapshot.docs.map((doc) => doc.data() as YouTubeAuthorizationRecord);
  }
  const now = new Date();
  return {
    ok: true,
    configuration: {
      mode,
      callbackEnabled,
      callbackSecretReady: Boolean(process.env.YOUTUBE_AUTH_WEBHOOK_SECRET),
      externalToolName: safeLabel(publicConfig.youtubeAuthToolName),
      policyVersion: safeId(publicConfig.youtubeAuthPolicyVersion, YOUTUBE_AUTH_POLICY_VERSION),
      allowedScopes: Array.from(ALLOWED_SCOPES),
      fallbackViewer: "scp@supercent.io",
    },
    summaryStatus: rows.length > 0
      ? summarizeStatus(rows.map((row) => effectiveStatus(row, now)))
      : "NOT_CONFIGURED" as YouTubeAuthorizationStatus,
    connections: rows.map((row) => publicConnection(row, now)),
    behaviorLog: makeBehaviorLog(auth, "youtube.authorization.read", "success", programId || "global", 0),
  };
}

function publicConnection(value: YouTubeAuthorizationRecord | undefined, now: Date) {
  if (!value) return {
    id: "",
    programId: "",
    status: "NOT_CONFIGURED" as YouTubeAuthorizationStatus,
    channelId: "",
    scopes: [] as string[],
    needsReconnect: false,
    updatedAtIso: "",
  };
  const status = effectiveStatus(value, now);
  return {
    id: value.id,
    programId: value.programId,
    status,
    authMode: value.authMode,
    providerAccountRef: value.providerAccountRefMasked,
    channelId: value.channelId,
    scopes: value.scopes,
    requestedAt: value.requestedAt,
    authorizedAt: value.authorizedAt,
    expiresAt: value.expiresAt,
    revokedAt: value.revokedAt,
    lastCheckedAt: value.lastCheckedAt,
    policyVersion: value.policyVersion,
    programVersion: value.programVersion,
    errorCode: value.errorCode,
    needsReconnect: status === "EXPIRED" || status === "REVOKED" || status === "ERROR",
    version: value.version,
    updatedAtIso: value.updatedAtIso,
  };
}

function effectiveStatus(value: YouTubeAuthorizationRecord | null | undefined, now: Date): YouTubeAuthorizationStatus {
  if (!value) return "NOT_CONFIGURED";
  if (value.status === "AUTHORIZED" && value.expiresAt && Date.parse(value.expiresAt) <= now.getTime()) return "EXPIRED";
  return value.status;
}

function summarizeStatus(statuses: YouTubeAuthorizationStatus[]): YouTubeAuthorizationStatus {
  const precedence: YouTubeAuthorizationStatus[] = ["ERROR", "REVOKED", "EXPIRED", "AUTH_PENDING", "AUTHORIZED", "NOT_CONFIGURED"];
  return precedence.find((status) => statuses.includes(status)) ?? "NOT_CONFIGURED";
}

async function writeDeadLetter(db: Firestore, parsed: unknown, rawBody: string, error: unknown, now: Date): Promise<void> {
  const sourceEventId = safeOpaqueRef(asRecord(parsed).sourceEventId, 160);
  const id = `ytadl_${stableHash([sourceEventId, stableHash(rawBody)]).slice(0, 40)}`;
  await db.collection("youtube_authorization_dead_letters").doc(id).set({
    id,
    sourceEventIdHash: sourceEventId ? stableHash(sourceEventId) : "",
    payloadHash: stableHash(rawBody),
    errorCode: safeFailureCode(error),
    retryable: safeFailureCode(error) === "transient_storage_failure",
    createdAtIso: now.toISOString(),
  }, { merge: false }).catch(() => undefined);
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const scopes = Array.from(new Set(value.map((scope) => asString(scope)).filter(Boolean))).sort();
  if (scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) throw validationError("unsupported YouTube authorization scope");
  return scopes;
}

function containsCredentialMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialMaterial);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => (
    CREDENTIAL_KEY.test(key.replace(/[^a-z0-9]/gi, "")) || containsCredentialMaterial(nested)
  ));
}

function requiredId(value: unknown, field: string): string {
  const id = safeId(value, "");
  if (!id) throw validationError(`${field} is required`);
  return id;
}

function safeId(value: unknown, fallback: string): string {
  const text = asString(value);
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(text) ? text : fallback;
}

function safeOpaqueRef(value: unknown, max: number): string {
  const text = asString(value);
  return /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$/.test(text) ? text.slice(0, max) : "";
}

function safeLabel(value: unknown): string {
  return asString(value).replace(/[^\p{L}\p{N} ._/-]/gu, "").slice(0, 80);
}

function requiredIso(value: unknown, field: string): string {
  const iso = optionalIso(value);
  if (!iso) throw validationError(`${field} must be an ISO timestamp`);
  return iso;
}

function optionalIso(value: unknown): string {
  const text = asString(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : "";
}

function safeErrorCode(value: unknown): string {
  const code = asString(value).toLowerCase();
  return /^[a-z][a-z0-9_.-]{2,79}$/.test(code) ? code : "";
}

function maskOpaqueRef(value: string): string {
  if (value.length <= 6) return "••••";
  return `${value.slice(0, 3)}••••${value.slice(-3)}`;
}

function safeFailureCode(error: unknown): string {
  const code = asString((error as { code?: unknown })?.code).toLowerCase();
  if (/^[a-z][a-z0-9_.-]{2,79}$/.test(code)) return code;
  return error instanceof Error && /stale|invalid|unsupported|required|forbidden/i.test(error.message)
    ? "invalid_event"
    : "transient_storage_failure";
}

function validationError(message: string): Error {
  return callableError("invalid-argument", message);
}

function callableError(code: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
}

function stableHash(value: unknown): string {
  const serialized = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(serialized).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
