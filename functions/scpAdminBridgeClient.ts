// Flu -> Portal signed client for the PARALLEL-IMPLEMENTED `scp.flu.admin-bridge.v1` contract
// (Portal repo, not visible from here — this module implements the PINNED contract handed down by
// the orchestrator; Portal's own implementation is out of this repo's reach, so field/behavior
// assumptions below are the cross-check risk surface called out in the final report).
//
// Reuses the exact conventions of ./scpCreatorPipelineV3MaterialClient (the canonical reference for
// every Flu -> Portal signed client in this repo): fail-closed null on any unconfigured/invalid/
// rejected/drifted condition (never throws), canonical JSON body built ONCE and reused for both the
// signature and the send (byte-identical on a caller-level retry), a bounded response size, and never
// logging/persisting the recovered payload (creator PII, command results).
//
// Wire (both endpoints):
//   - POST `<SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL><endpointPath>`. HTTPS only, no query string, no
//     hash, no origin/cookie/authorization/content-encoding headers.
//   - request body: canonical JSON (deterministic key order), <= ADMIN_BRIDGE_MAX_REQUEST_BYTES.
//   - headers: content-type: application/json, x-scp-event-id == x-scp-idempotency-key (a fresh
//     `req_` + 32 lowercase-hex id per call), x-scp-key-id (ADMIN ring CURRENT key id), x-scp-timestamp
//     (unix seconds), x-scp-signature = "sha256=" + HMAC-SHA256(adminCurrentSecret,
//     `${timestamp}\n${eventId}\n${rawBody}`) — the same 3-part newline-joined message the MATERIAL and
//     management-ack clients sign (NOT the `${timestamp}.${body}` scheme).
//
// FAIL-CLOSED:
//   - fetchScpAdminBridgeCreatorsDirectory returns `null` on ANY unconfigured/invalid/transport/
//     non-2xx/drifted condition — this is a read surface with no partial-trust contract, so a single
//     malformed row fails the whole page rather than silently dropping rows.
//   - sendScpAdminBridgeCreatorCommand returns `null` ONLY on transport failure or envelope drift (the
//     module header for the two endpoints spells this out below in more detail) — Portal's OWN
//     `{ error, requestId }` command-rejection body is a normal, expected outcome (stale revision,
//     receipt conflict, workflow-required, mapping-conflict, RBAC-scope errors) that the caller MUST
//     be able to distinguish, so it is returned verbatim rather than collapsed to null.
import { randomBytes, createHmac } from "node:crypto";
import { canonicalJson } from "./integrationEventV2";
import { asRecord } from "./shared";
import { SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL_ENV } from "./scpCreatorPipelineV3MaterialClient";

export const SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_ID_ENV = "SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_ID";
export const SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_SECRET_ENV = "SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_SECRET";
export const SCP_CREATOR_PIPELINE_V3_ADMIN_PREVIOUS_KEY_ID_ENV = "SCP_CREATOR_PIPELINE_V3_ADMIN_PREVIOUS_KEY_ID";
export const SCP_CREATOR_PIPELINE_V3_ADMIN_PREVIOUS_KEY_SECRET_ENV = "SCP_CREATOR_PIPELINE_V3_ADMIN_PREVIOUS_KEY_SECRET";

export const SCP_ADMIN_BRIDGE_CREATORS_DIRECTORY_PATH = "/api/internal/flu/admin-bridge/creators-directory" as const;
export const SCP_ADMIN_BRIDGE_CREATOR_COMMANDS_PATH = "/api/internal/flu/admin-bridge/creator-commands" as const;

export const SCP_ADMIN_BRIDGE_MAX_REQUEST_BYTES = 4096;
// Defensive bound on the response body — the pinned contract does not spell out a response size, but a
// directory page (bounded by MAX_PAGE_SIZE=100 rows) must never be allowed to balloon in memory.
const ADMIN_BRIDGE_DIRECTORY_RESPONSE_MAX_BYTES = 512 * 1024;
const ADMIN_BRIDGE_COMMAND_RESPONSE_MAX_BYTES = 16 * 1024;

const ADMIN_BRIDGE_CALLER_ID = "scp-flu-admin-bridge-v1" as const;
const ADMIN_BRIDGE_MAX_LIMIT = 100;

export type ScpAdminBridgeFetchOptions = Readonly<{
  baseUrl?: string;
  keyId?: string;
  secret?: string;
  now?: Date;
  fetcher?: typeof fetch;
}>;

// W93 정정(실측 드리프트): 포털은 값이 없는 profile 필드를 아예 생략한다(값을 넣어 보내지 않는다)
// — 4개 전부 optional. 실측 샘플 기준 language 는 37행 중 36행이 생략, displayName 없이 완전히
// 빈 profile:{} 도 온다.
export type ScpAdminBridgeCreatorProfile = Readonly<{
  displayName?: string;
  channelUrl?: string;
  country?: string;
  language?: string;
}>;

export type ScpAdminBridgeApprovalApplication = Readonly<{
  id: string;
  status: string;
  revision: number;
  loginRequested: boolean;
  programId?: string;
}>;

export type ScpAdminBridgeDataLink = Readonly<{
  fluCreatorId?: string;
  partnerId?: string;
  enrollmentCount: number;
}>;

// Pinned "포털 row" shape (scp.flu.admin-bridge.v1). raw email never arrives here — emailMasked only.
export type ScpAdminBridgeCreatorRow = Readonly<{
  id: string;
  name?: string;
  emailMasked: string;
  status: string;
  role: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  loginRequestedAt?: string;
  portalReady: boolean;
  profile: ScpAdminBridgeCreatorProfile;
  audienceGeo?: Record<string, unknown>;
  approvalApplicationId?: string;
  approvalApplication?: ScpAdminBridgeApprovalApplication;
  dataLink: ScpAdminBridgeDataLink;
}>;

export type ScpAdminBridgeCreatorsDirectoryResult = Readonly<{
  rows: readonly ScpAdminBridgeCreatorRow[];
  nextCursor?: string;
  generatedAt: string;
}>;

export type ScpAdminBridgeCreatorsDirectoryInput = Readonly<{
  cursor?: string;
  limit?: number;
  updatedSince?: string;
}>;

function adminBridgeSigningKey(options: ScpAdminBridgeFetchOptions): { keyId: string; secret: string } | null {
  const keyId = options.keyId ?? process.env[SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_ID_ENV] ?? "";
  const secret = options.secret ?? process.env[SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_SECRET_ENV] ?? "";
  if (!keyId || Buffer.byteLength(secret, "utf8") < 32) return null;
  return { keyId, secret };
}

function adminBridgeBaseUrl(options: ScpAdminBridgeFetchOptions): URL | null {
  const raw = options.baseUrl ?? process.env[SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL_ENV] ?? "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return null;
    return url;
  } catch {
    return null;
  }
}

function adminBridgeEventId(): string {
  return `req_${randomBytes(16).toString("hex")}`;
}

// Pinned signing message: `${timestamp}\n${eventId}\n${rawBody}` — same 3-part form as the MATERIAL
// and management-ack clients (NOT `${timestamp}.${body}`).
function adminBridgeSignature(secret: string, timestamp: number, eventId: string, body: string): string {
  const message = `${timestamp}\n${eventId}\n${body}`;
  return `sha256=${createHmac("sha256", Buffer.from(secret, "utf8")).update(Buffer.from(message, "utf8")).digest("hex")}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// W93 정정(실측 드리프트): optional 필드는 포털이 값이 없으면 키를 생략하거나(가장 흔함) `null` 을
// 보내기도 한다(예: audienceGeo) — 둘 다 "값 없음"으로 관용화하고, 타입이 맞을 때만 통과시키는
// allowlist 원칙은 유지한다(문자열이 아닌 다른 타입이 오면 여전히 드리프트로 reject).
function isOptionalStringField(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function parseAdminBridgeProfile(raw: unknown): ScpAdminBridgeCreatorProfile | null {
  const record = asRecord(raw);
  if (
    !isOptionalStringField(record.displayName)
    || !isOptionalStringField(record.channelUrl)
    || !isOptionalStringField(record.country)
    || !isOptionalStringField(record.language)
  ) {
    return null;
  }
  return {
    ...(typeof record.displayName === "string" ? { displayName: record.displayName } : {}),
    ...(typeof record.channelUrl === "string" ? { channelUrl: record.channelUrl } : {}),
    ...(typeof record.country === "string" ? { country: record.country } : {}),
    ...(typeof record.language === "string" ? { language: record.language } : {}),
  };
}

function parseAdminBridgeApprovalApplication(raw: unknown): ScpAdminBridgeApprovalApplication | null | undefined {
  if (raw === undefined) return undefined;
  const record = asRecord(raw);
  if (
    !isNonEmptyString(record.id)
    || !isNonEmptyString(record.status)
    || typeof record.revision !== "number"
    || !Number.isSafeInteger(record.revision)
    || typeof record.loginRequested !== "boolean"
    || !isOptionalStringField(record.programId)
  ) {
    return null;
  }
  return {
    id: record.id,
    status: record.status,
    revision: record.revision,
    loginRequested: record.loginRequested,
    ...(typeof record.programId === "string" ? { programId: record.programId } : {}),
  };
}

function parseAdminBridgeDataLink(raw: unknown): ScpAdminBridgeDataLink | null {
  const record = asRecord(raw);
  if (
    !isOptionalStringField(record.fluCreatorId)
    || !isOptionalStringField(record.partnerId)
    || typeof record.enrollmentCount !== "number"
    || !Number.isSafeInteger(record.enrollmentCount)
    || record.enrollmentCount < 0
  ) {
    return null;
  }
  return {
    ...(typeof record.fluCreatorId === "string" ? { fluCreatorId: record.fluCreatorId } : {}),
    ...(typeof record.partnerId === "string" ? { partnerId: record.partnerId } : {}),
    enrollmentCount: record.enrollmentCount,
  };
}

// Strict, allowlist-only parse — a single malformed row fails the WHOLE response (never partial trust).
function parseAdminBridgeCreatorRow(raw: unknown): ScpAdminBridgeCreatorRow | null {
  const record = asRecord(raw);
  if (
    !isNonEmptyString(record.id)
    || !isNonEmptyString(record.emailMasked)
    || !isNonEmptyString(record.status)
    || !isNonEmptyString(record.role)
    || !isNonEmptyString(record.createdAt)
    || !isNonEmptyString(record.updatedAt)
    || typeof record.portalReady !== "boolean"
    || !isOptionalStringField(record.name)
    || !isOptionalStringField(record.lastLoginAt)
    || !isOptionalStringField(record.loginRequestedAt)
    || !isOptionalStringField(record.approvalApplicationId)
    // audienceGeo:null is a common "no data" shape from Portal (33/37 rows in a live sample) — treat
    // it the same as absent (omitted below); a present-but-non-record value is still schema drift.
    || (record.audienceGeo !== undefined && record.audienceGeo !== null && !isPlainRecord(record.audienceGeo))
  ) {
    return null;
  }
  const profile = parseAdminBridgeProfile(record.profile);
  if (!profile) return null;
  const approvalApplication = parseAdminBridgeApprovalApplication(record.approvalApplication);
  if (approvalApplication === null) return null;
  const dataLink = parseAdminBridgeDataLink(record.dataLink);
  if (!dataLink) return null;
  return {
    id: record.id,
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    emailMasked: record.emailMasked,
    status: record.status,
    role: record.role,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(typeof record.lastLoginAt === "string" ? { lastLoginAt: record.lastLoginAt } : {}),
    ...(typeof record.loginRequestedAt === "string" ? { loginRequestedAt: record.loginRequestedAt } : {}),
    portalReady: record.portalReady,
    profile,
    ...(isPlainRecord(record.audienceGeo) ? { audienceGeo: record.audienceGeo } : {}),
    ...(typeof record.approvalApplicationId === "string" ? { approvalApplicationId: record.approvalApplicationId } : {}),
    ...(approvalApplication ? { approvalApplication } : {}),
    dataLink,
  };
}

/**
 * Portal creators-directory route — bounded, cursor-paginated list of Portal creator accounts joined
 * with their (optional) approval application + Flu data-link. Fail-closed `null` on any unconfigured/
 * invalid/rejected/drifted condition; never throws, never logs the recovered rows.
 */
export async function fetchScpAdminBridgeCreatorsDirectory(
  input: ScpAdminBridgeCreatorsDirectoryInput = {},
  options: ScpAdminBridgeFetchOptions = {},
): Promise<ScpAdminBridgeCreatorsDirectoryResult | null> {
  try {
    const key = adminBridgeSigningKey(options);
    if (!key) return null;
    const base = adminBridgeBaseUrl(options);
    if (!base) return null;
    if (
      (input.cursor !== undefined && typeof input.cursor !== "string")
      || (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1))
      || (input.updatedSince !== undefined && typeof input.updatedSince !== "string")
    ) {
      return null;
    }
    const limit = input.limit !== undefined ? Math.min(input.limit, ADMIN_BRIDGE_MAX_LIMIT) : undefined;

    const eventId = adminBridgeEventId();
    const requestBody = {
      callerId: ADMIN_BRIDGE_CALLER_ID,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(input.updatedSince ? { updatedSince: input.updatedSince } : {}),
    };
    // Built exactly once: the identical raw bytes are signed AND sent, so a caller-level retry of this
    // same call is byte-identical (never re-serialized/re-timestamped per attempt).
    const body = canonicalJson(requestBody);
    if (Buffer.byteLength(body, "utf8") > SCP_ADMIN_BRIDGE_MAX_REQUEST_BYTES) return null;

    const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1000);
    const url = new URL(SCP_ADMIN_BRIDGE_CREATORS_DIRECTORY_PATH, base);
    if (url.protocol !== "https:" || url.search || url.hash) return null;
    const fetcher = options.fetcher ?? fetch;

    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-scp-idempotency-key": eventId,
          "x-scp-event-id": eventId,
          "x-scp-key-id": key.keyId,
          "x-scp-timestamp": String(timestamp),
          "x-scp-signature": adminBridgeSignature(key.secret, timestamp, eventId, body),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;

    let raw: string;
    try {
      raw = await response.text();
    } catch {
      return null;
    }
    if (Buffer.byteLength(raw, "utf8") > ADMIN_BRIDGE_DIRECTORY_RESPONSE_MAX_BYTES) return null;

    let envelope: Record<string, unknown>;
    try {
      envelope = asRecord(JSON.parse(raw));
    } catch {
      return null;
    }
    if (!Array.isArray(envelope.rows) || !isNonEmptyString(envelope.generatedAt)) return null;
    if (envelope.nextCursor !== undefined && typeof envelope.nextCursor !== "string") return null;
    const rows: ScpAdminBridgeCreatorRow[] = [];
    for (const rawRow of envelope.rows) {
      const parsed = parseAdminBridgeCreatorRow(rawRow);
      // A single malformed row drifts the WHOLE page — never return a partially-trusted list.
      if (!parsed) return null;
      rows.push(parsed);
    }
    return {
      rows,
      ...(typeof envelope.nextCursor === "string" && envelope.nextCursor ? { nextCursor: envelope.nextCursor } : {}),
      generatedAt: envelope.generatedAt,
    };
  } catch {
    return null;
  }
}

export type ScpAdminBridgeCommandOperator = Readonly<{
  fluUid: string;
  role: string;
  emailMasked: string;
}>;

export type ScpAdminBridgeCreatorCommandInput = Readonly<{
  operator: ScpAdminBridgeCommandOperator;
  command: string;
  targetId: string;
  expectedRevision?: number;
  expectedUpdatedAt?: string;
  params?: Record<string, unknown>;
}>;

export type ScpAdminBridgeCommandOutcome =
  // `eventId` is the id THIS call signed the request with (req_ + 32hex) — callers that enqueue a
  // downstream effect keyed to this exact command attempt (e.g. the login_approved mail material
  // lookup) need it verbatim, not a freshly-generated one. `requestId` is Portal's own request id,
  // pinned on BOTH branches (success envelope is `{ ok:true, result, requestId }`).
  | Readonly<{ ok: true; result: Record<string, unknown>; requestId: string; eventId: string }>
  | Readonly<{ ok: false; error: string; requestId: string; eventId: string }>;

/**
 * Portal creator-commands route — operator-attributed CAS command (application review transitions,
 * creator status/notes, Flu data-link). Fail-closed `null` ONLY on transport failure or envelope
 * drift; Portal's own `{ error, requestId }` command-rejection body is a normal, expected business
 * outcome (stale revision, receipt conflict, workflow-required, mapping-conflict, RBAC-scope errors)
 * and is returned verbatim so the caller can map it to a stable, diagnosable errorCode — collapsing it
 * to `null` here would make every rejection indistinguishable from an internal error.
 */
export async function sendScpAdminBridgeCreatorCommand(
  input: ScpAdminBridgeCreatorCommandInput,
  options: ScpAdminBridgeFetchOptions = {},
): Promise<ScpAdminBridgeCommandOutcome | null> {
  try {
    const key = adminBridgeSigningKey(options);
    if (!key) return null;
    const base = adminBridgeBaseUrl(options);
    if (!base) return null;
    if (
      !isNonEmptyString(input.operator?.fluUid)
      || !isNonEmptyString(input.operator?.role)
      || !isNonEmptyString(input.operator?.emailMasked)
      || !isNonEmptyString(input.command)
      || !isNonEmptyString(input.targetId)
      || (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0))
      || (input.expectedUpdatedAt !== undefined && typeof input.expectedUpdatedAt !== "string")
      || (input.params !== undefined && !isPlainRecord(input.params))
    ) {
      return null;
    }

    const eventId = adminBridgeEventId();
    const requestBody = {
      // 26-08-27 [첫 실사용 계약 불일치 수리]: Portal validator(parseFluAdminBridgeCommandRequest)는
      // callerId 를 첫 검사에서 요구한다. directory 요청은 처음부터 실었는데 커맨드 요청에만
      // 빠져 있어, 이 레인의 프로드 첫 사용(헤세 approve)이 invalid_body 로 거절됐다.
      callerId: ADMIN_BRIDGE_CALLER_ID,
      operator: {
        fluUid: input.operator.fluUid,
        role: input.operator.role,
        emailMasked: input.operator.emailMasked,
      },
      command: input.command,
      targetId: input.targetId,
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
      ...(input.params ? { params: input.params } : {}),
    };
    // Built exactly once: the identical raw bytes are signed AND sent, so a caller-level retry of this
    // same call is byte-identical (never re-serialized/re-timestamped per attempt).
    const body = canonicalJson(requestBody);
    if (Buffer.byteLength(body, "utf8") > SCP_ADMIN_BRIDGE_MAX_REQUEST_BYTES) return null;

    const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1000);
    const url = new URL(SCP_ADMIN_BRIDGE_CREATOR_COMMANDS_PATH, base);
    if (url.protocol !== "https:" || url.search || url.hash) return null;
    const fetcher = options.fetcher ?? fetch;

    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-scp-idempotency-key": eventId,
          "x-scp-event-id": eventId,
          "x-scp-key-id": key.keyId,
          "x-scp-timestamp": String(timestamp),
          "x-scp-signature": adminBridgeSignature(key.secret, timestamp, eventId, body),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null;
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch {
      return null;
    }
    if (Buffer.byteLength(raw, "utf8") > ADMIN_BRIDGE_COMMAND_RESPONSE_MAX_BYTES) return null;

    let envelope: Record<string, unknown>;
    try {
      envelope = asRecord(JSON.parse(raw));
    } catch {
      return null;
    }

    if (envelope.ok === true) {
      if (!isPlainRecord(envelope.result) || !isNonEmptyString(envelope.requestId)) return null;
      return { ok: true, result: envelope.result, requestId: envelope.requestId, eventId };
    }
    if (isNonEmptyString(envelope.error) && isNonEmptyString(envelope.requestId)) {
      return { ok: false, error: envelope.error, requestId: envelope.requestId, eventId };
    }
    // Neither a recognized success nor a recognized failure envelope — schema drift.
    return null;
  } catch {
    return null;
  }
}
