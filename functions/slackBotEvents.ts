// Flu Slack bot — @멘션 조회만 처리한다.
//
// 2026-09-27: 담당자 DM 경보 경로(enqueueDirectSlackAlert/formatDirectAlert)를 삭제했다 —
// 정의만 있고 호출부가 없어 한 번도 발송된 적이 없는 죽은 코드였다(발송정지·dead_letter·
// 반송률초과 경보는 대신 슬랙 예약 리포트의 요약 채널 경보 줄로 나간다).
//
// 규정 준수 메모:
// - NET-P0-012 / SEC-P0-005: Slack 외부 호출은 이 Functions 레이어에서만 수행한다.
// - SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET 은 Secret Manager 로만 주입한다. 평문 .env 금지.
// - SEC-P0-009: 메일 본문·프롬프트·응답 원문을 Slack/로그/인박스에 저장하지 않는다.
// - 서명은 JSON 파싱 전에 request.rawBody 바이트 그대로 검증한다(v0 HMAC-SHA256, 5분 창).
// - ACK 경로는 검증 + allowlist + 멱등 inbox create 까지만 수행한다. Slack API 호출은 별도
//   Firestore 생성 트리거가 처리한다.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { type DocumentData, type DocumentReference } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";

export const SLACK_EVENT_INBOX_COLLECTION = "slack_event_inbox";
export const SLACK_BOT_CONFIG_DOC = "slack_bot_configs/runtime";

const SLACK_SIGNING_SECRET_ENV = "SLACK_SIGNING_SECRET";
const SLACK_BOT_TOKEN_ENV = "SLACK_BOT_TOKEN";
const SLACK_API_ORIGIN = "https://slack.com";
const SLACK_SIGNATURE_WINDOW_SECONDS = 300;
const SLACK_MAX_BODY_BYTES = 64 * 1024;
const SLACK_INBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const EVENT_ID_PATTERN = /^[A-Za-z0-9._-]{8,160}$/;
const CHANNEL_ID_PATTERN = /^[CDG][A-Z0-9]{8,}$/;
const USER_ID_PATTERN = /^[UW][A-Z0-9]{8,}$/;
const SLACK_TS_PATTERN = /^[0-9]{1,16}(?:\.[0-9]{1,8})?$/;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SAFE_STATUS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

const SAFE_STATUS_COLLECTIONS = new Set([
  "campaign_outreach",
  "mail_delivery_failures",
  "scp_integration_event_v2_callback_outbox",
]);

export type SlackAllowlist = {
  active: boolean;
  allowedChannelIds: ReadonlySet<string>;
  allowedUserIds: ReadonlySet<string>;
};

export type SlackSignatureVerification =
  | { ok: true }
  | { ok: false; code: "signature_invalid" | "timestamp_invalid" | "timestamp_out_of_window" };

export type SlackMentionCommand =
  | { kind: "help"; responseCode: "help" | "unsupported_command" }
  | { kind: "status"; referenceId: string; responseCode: "status" };

export type SlackMentionInboxRecord = {
  kind: "mention";
  status: "queued";
  eventIdHash: string;
  retryNum: number | null;
  channelId: string;
  userId: string;
  threadTs: string;
  command: SlackMentionCommand;
  createdAt: Date;
  expiresAt: Date;
};

export type SlackHttpRequestLike = {
  method?: string;
  rawBody?: Buffer;
  get(name: string): string | undefined;
};

export type SlackHttpResponseLike = {
  set(name: string, value: string): unknown;
  status(code: number): SlackHttpResponseLike;
  send(body: unknown): unknown;
};

export type SlackEndpointDeps = {
  signingSecret: string;
  nowMs: () => number;
  loadAllowlist: () => Promise<SlackAllowlist>;
  persistMention: (eventId: string, record: SlackMentionInboxRecord) => Promise<"created" | "duplicate">;
};

type SlackEventCallbackPayload = {
  type: "event_callback";
  event_id: string;
  event: {
    type: "app_mention";
    channel: string;
    user: string;
    text: string;
    ts: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
  };
};

type SlackWebApiMethod = "users.lookupByEmail" | "conversations.open" | "chat.postMessage";

type SlackWebApiResponse = {
  ok?: boolean;
  error?: string;
  user?: { id?: string };
  channel?: { id?: string };
};

type SlackWebApi = {
  call(method: SlackWebApiMethod, body: Record<string, unknown>): Promise<SlackWebApiResponse>;
};

type SlackBotErrorCode =
  | "allowlist_denied"
  | "slack_api_failed"
  | "slack_bot_token_missing"
  | "status_reference_invalid"
  | "status_reference_not_found";

class SlackBotError extends Error {
  constructor(readonly code: SlackBotErrorCode) {
    super(code);
    this.name = "SlackBotError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeErrorCode(error: unknown): string {
  if (error instanceof SlackBotError) return error.code;
  const code = safeString((error as { code?: unknown })?.code);
  if (/^[a-z0-9._:-]{2,80}$/i.test(code)) return code;
  return "temporarily_unavailable";
}

function safeOperationalValue(value: unknown): string {
  const candidate = safeString(value);
  return SAFE_STATUS_PATTERN.test(candidate) ? candidate : "unknown";
}

function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 6 || code === "6" || code === "already-exists" || code === "ALREADY_EXISTS";
}

function eventDocumentId(kind: "mention", eventId: string): string {
  return `${kind}_${sha256(eventId)}`;
}

function clientMessageId(eventIdHash: string): string {
  return [
    eventIdHash.slice(0, 8),
    eventIdHash.slice(8, 12),
    `5${eventIdHash.slice(13, 16)}`,
    `8${eventIdHash.slice(17, 20)}`,
    eventIdHash.slice(20, 32),
  ].join("-");
}

export function verifySlackRequestSignature(input: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer;
  nowMs: number;
}): SlackSignatureVerification {
  const timestamp = safeString(input.timestamp);
  const signature = safeString(input.signature);
  if (!/^(?:0|[1-9][0-9]*)$/.test(timestamp)) return { ok: false, code: "timestamp_invalid" };

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(input.nowMs / 1000);
  if (!Number.isSafeInteger(timestampSeconds)) return { ok: false, code: "timestamp_invalid" };
  if (Math.abs(nowSeconds - timestampSeconds) > SLACK_SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, code: "timestamp_out_of_window" };
  }
  if (input.signingSecret.length < 16 || !/^v0=[a-f0-9]{64}$/.test(signature)) {
    return { ok: false, code: "signature_invalid" };
  }

  const hmac = createHmac("sha256", Buffer.from(input.signingSecret, "utf8"));
  hmac.update(Buffer.from(`v0:${timestamp}:`, "utf8"));
  hmac.update(input.rawBody);
  const expected = Buffer.from(`v0=${hmac.digest("hex")}`, "utf8");
  const actual = Buffer.from(signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual)
    ? { ok: true }
    : { ok: false, code: "signature_invalid" };
}

export function evaluateSlackAllowlist(
  identity: { channelId: string; userId: string },
  allowlist: SlackAllowlist,
): { allowed: true } | { allowed: false; code: "bot_disabled" | "channel_not_allowed" | "user_not_allowed" } {
  if (!allowlist.active) return { allowed: false, code: "bot_disabled" };
  if (!allowlist.allowedChannelIds.has(identity.channelId)) {
    return { allowed: false, code: "channel_not_allowed" };
  }
  if (!allowlist.allowedUserIds.has(identity.userId)) {
    return { allowed: false, code: "user_not_allowed" };
  }
  return { allowed: true };
}

export function parseSlackMentionCommand(text: string): SlackMentionCommand {
  const withoutMention = text.replace(/^\s*<@[A-Z0-9]+>\s*/i, "").trim();
  if (!withoutMention || /^help$/i.test(withoutMention)) {
    return { kind: "help", responseCode: "help" };
  }
  const statusMatch = withoutMention.match(/^status\s+([^\s]+)$/i);
  if (statusMatch && SAFE_REFERENCE_PATTERN.test(statusMatch[1])) {
    const referenceId = normalizeOperationalReference(statusMatch[1]);
    if (referenceId) return { kind: "status", referenceId, responseCode: "status" };
  }
  return { kind: "help", responseCode: "unsupported_command" };
}

function normalizeOperationalReference(value: string): string {
  if (!SAFE_REFERENCE_PATTERN.test(value)) return "";
  const slash = value.indexOf("/");
  if (slash <= 0 || slash !== value.lastIndexOf("/")) return "";
  const collection = value.slice(0, slash);
  const id = value.slice(slash + 1);
  if (!SAFE_STATUS_COLLECTIONS.has(collection) || !id || id === "." || id === "..") return "";
  return `${collection}/${id}`;
}

function parseRetryNum(value: string | undefined): number | null | "invalid" {
  if (value === undefined || value === "") return null;
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(value)) return "invalid";
  return Number(value);
}

function isSlackEventCallbackPayload(value: unknown): value is SlackEventCallbackPayload {
  const payload = value as Partial<SlackEventCallbackPayload> | null;
  const event = payload?.event;
  return payload?.type === "event_callback"
    && EVENT_ID_PATTERN.test(safeString(payload.event_id))
    && event?.type === "app_mention"
    && CHANNEL_ID_PATTERN.test(safeString(event.channel))
    && USER_ID_PATTERN.test(safeString(event.user))
    && typeof event.text === "string"
    && event.text.length <= 500
    && SLACK_TS_PATTERN.test(safeString(event.ts))
    && (!event.thread_ts || SLACK_TS_PATTERN.test(event.thread_ts));
}

function sendHttp(
  response: SlackHttpResponseLike,
  status: number,
  body: Record<string, unknown>,
): void {
  response.status(status).send(body);
}

export async function slackBotEventsHandlerWithDeps(
  request: SlackHttpRequestLike,
  response: SlackHttpResponseLike,
  deps: SlackEndpointDeps,
): Promise<void> {
  response.set("Cache-Control", "private, no-store, max-age=0");
  response.set("X-Content-Type-Options", "nosniff");

  if ((request.method ?? "").toUpperCase() !== "POST") {
    response.set("Allow", "POST");
    sendHttp(response, 405, { ok: false, code: "method_not_allowed" });
    return;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.get("content-type") ?? "")) {
    sendHttp(response, 415, { ok: false, code: "unsupported_media_type" });
    return;
  }
  const rawBody = Buffer.isBuffer(request.rawBody) ? request.rawBody : Buffer.alloc(0);
  if (rawBody.length === 0 || rawBody.length > SLACK_MAX_BODY_BYTES) {
    sendHttp(response, 400, { ok: false, code: "invalid_body" });
    return;
  }

  const signature = verifySlackRequestSignature({
    signingSecret: deps.signingSecret,
    timestamp: request.get("x-slack-request-timestamp"),
    signature: request.get("x-slack-signature"),
    rawBody,
    nowMs: deps.nowMs(),
  });
  if (!signature.ok) {
    sendHttp(response, 401, { ok: false, code: signature.code });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    sendHttp(response, 400, { ok: false, code: "invalid_json" });
    return;
  }

  if ((payload as { type?: unknown })?.type === "url_verification") {
    const challenge = safeString((payload as { challenge?: unknown }).challenge);
    if (!/^[A-Za-z0-9_-]{8,256}$/.test(challenge)) {
      sendHttp(response, 400, { ok: false, code: "invalid_challenge" });
      return;
    }
    sendHttp(response, 200, { challenge });
    return;
  }

  if (!isSlackEventCallbackPayload(payload)) {
    sendHttp(response, 400, { ok: false, code: "invalid_event" });
    return;
  }
  if (payload.event.bot_id || payload.event.subtype) {
    sendHttp(response, 200, { ok: true, ignored: true, code: "bot_event_ignored" });
    return;
  }

  const retryNum = parseRetryNum(request.get("x-slack-retry-num"));
  if (retryNum === "invalid") {
    sendHttp(response, 400, { ok: false, code: "invalid_retry_num" });
    return;
  }

  const allowlist = await deps.loadAllowlist();
  const allowed = evaluateSlackAllowlist({
    channelId: payload.event.channel,
    userId: payload.event.user,
  }, allowlist);
  if (!allowed.allowed) {
    // 서명이 유효한 Slack 이벤트이므로 200 으로 소비하되 어떤 작업도 적재하지 않는다.
    // 403 은 Slack 재전송을 유발해 기본거부 이벤트를 불필요하게 반복시킨다.
    sendHttp(response, 200, { ok: true, ignored: true, code: allowed.code });
    return;
  }

  const nowMs = deps.nowMs();
  const record: SlackMentionInboxRecord = {
    kind: "mention",
    status: "queued",
    eventIdHash: sha256(payload.event_id),
    retryNum,
    channelId: payload.event.channel,
    userId: payload.event.user,
    threadTs: payload.event.thread_ts || payload.event.ts,
    command: parseSlackMentionCommand(payload.event.text),
    createdAt: new Date(nowMs),
    expiresAt: new Date(nowMs + SLACK_INBOX_RETENTION_MS),
  };

  const persisted = await deps.persistMention(payload.event_id, record);
  sendHttp(response, 200, { ok: true, duplicate: persisted === "duplicate" });
}

export async function loadSlackRuntimeAllowlist(): Promise<SlackAllowlist> {
  const snapshot = await adminDb.doc(SLACK_BOT_CONFIG_DOC).get();
  const data = snapshot.data() ?? {};
  const channels = Array.isArray(data.allowedChannelIds)
    ? data.allowedChannelIds.filter((value): value is string => typeof value === "string" && CHANNEL_ID_PATTERN.test(value))
    : [];
  const users = Array.isArray(data.allowedUserIds)
    ? data.allowedUserIds.filter((value): value is string => typeof value === "string" && USER_ID_PATTERN.test(value))
    : [];
  return {
    active: data.active === true,
    allowedChannelIds: new Set(channels),
    allowedUserIds: new Set(users),
  };
}

export async function persistSlackMentionEvent(
  eventId: string,
  record: SlackMentionInboxRecord,
): Promise<"created" | "duplicate"> {
  const ref = adminDb.collection(SLACK_EVENT_INBOX_COLLECTION).doc(eventDocumentId("mention", eventId));
  try {
    await ref.create(record);
    return "created";
  } catch (error) {
    if (isAlreadyExists(error)) return "duplicate";
    throw error;
  }
}

export async function slackBotEventsHandler(
  request: SlackHttpRequestLike,
  response: SlackHttpResponseLike,
): Promise<void> {
  const startedAt = Date.now();
  let statusCode = 200;
  const trackedResponse: SlackHttpResponseLike = {
    set: (name, value) => response.set(name, value),
    status: (code) => {
      statusCode = code;
      response.status(code);
      return trackedResponse;
    },
    send: (body) => response.send(body),
  };
  try {
    await slackBotEventsHandlerWithDeps(request, trackedResponse, {
      signingSecret: safeString(process.env[SLACK_SIGNING_SECRET_ENV]),
      nowMs: Date.now,
      loadAllowlist: loadSlackRuntimeAllowlist,
      persistMention: persistSlackMentionEvent,
    });
    console.log("[slack-bot-events]", JSON.stringify({
      outcome: statusCode === 200 ? "acknowledged" : "rejected",
      statusCode,
      latencyMs: Date.now() - startedAt,
    }));
  } catch (error) {
    const code = safeErrorCode(error);
    console.warn("[slack-bot-events]", JSON.stringify({
      outcome: "failed",
      code,
      statusCode: 503,
      latencyMs: Date.now() - startedAt,
    }));
    sendHttp(response, 503, { ok: false, code: "temporarily_unavailable" });
  }
}

export function createSlackWebApi(
  token: string,
  fetchImpl: typeof fetch = fetch,
): SlackWebApi {
  if (!token) throw new SlackBotError("slack_bot_token_missing");
  return {
    async call(method, body) {
      const url = new URL(`/api/${method}`, SLACK_API_ORIGIN);
      if (url.origin !== SLACK_API_ORIGIN || !url.pathname.startsWith("/api/")) {
        throw new SlackBotError("slack_api_failed");
      }
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        throw new SlackBotError("slack_api_failed");
      }
      if (!response.ok) throw new SlackBotError("slack_api_failed");
      const result = await response.json() as SlackWebApiResponse;
      if (result.ok !== true) throw new SlackBotError("slack_api_failed");
      return result;
    },
  };
}

async function loadSafeOperationalStatus(referenceId: string): Promise<{ status: string; code: string }> {
  const normalized = normalizeOperationalReference(referenceId);
  if (!normalized) throw new SlackBotError("status_reference_invalid");
  const snapshot = await adminDb.doc(normalized).get();
  if (!snapshot.exists) throw new SlackBotError("status_reference_not_found");
  const data = snapshot.data() ?? {};
  const collection = normalized.slice(0, normalized.indexOf("/"));
  if (collection === "campaign_outreach") {
    return {
      status: safeOperationalValue(data.deliveryState ?? data.status),
      code: safeOperationalValue(data.failureKind ?? data.lastErrorCode),
    };
  }
  if (collection === "mail_delivery_failures") {
    return {
      status: safeOperationalValue(data.kind ?? data.status),
      code: safeOperationalValue(data.code),
    };
  }
  return {
    status: safeOperationalValue(data.deliveryState),
    code: safeOperationalValue(data.lastErrorCode),
  };
}

function formatMentionReply(command: SlackMentionCommand, status?: { status: string; code: string }): string {
  if (command.kind === "status" && status) {
    return [
      `*Flu 상태 조회* — \`${command.referenceId}\``,
      `• 상태: \`${status.status}\``,
      `• 코드: \`${status.code}\``,
    ].join("\n");
  }
  return [
    "*Flu 봇 조회 명령*",
    "• `@Flu 운영봇 help`",
    "• `@Flu 운영봇 status <collection/document-id>`",
    "• 조회 허용: `campaign_outreach`, `mail_delivery_failures`, `scp_integration_event_v2_callback_outbox`",
    "상태 변경 명령은 지원하지 않습니다.",
  ].join("\n");
}

async function postSlackMessage(
  api: SlackWebApi,
  input: { channel: string; text: string; threadTs?: string; clientMessageId: string },
): Promise<void> {
  if (!CHANNEL_ID_PATTERN.test(input.channel)) throw new SlackBotError("slack_api_failed");
  await api.call("chat.postMessage", {
    channel: input.channel,
    text: input.text,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    client_msg_id: input.clientMessageId,
    unfurl_links: false,
    unfurl_media: false,
  });
}

async function claimInboxRecord(ref: DocumentReference<DocumentData>): Promise<SlackMentionInboxRecord | null> {
  // Eventarc 중복 전달에서도 Slack 호출은 최대 한 번만 시작한다. processing 상태는 자동 재시도하지
  // 않아 모호한 네트워크 실패에서 사용자에게 중복 메시지가 보이는 사고를 우선 차단한다.
  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data() ?? {};
    if (!snapshot.exists || data.status !== "queued") return null;
    transaction.update(ref, {
      status: "processing",
      processingStartedAt: new Date(),
    });
    return data as unknown as SlackMentionInboxRecord;
  });
}

export async function processSlackBotInboxDocument(snapshot: {
  ref: DocumentReference<DocumentData>;
  id: string;
} | undefined): Promise<void> {
  if (!snapshot) return;
  const startedAt = Date.now();
  const record = await claimInboxRecord(snapshot.ref);
  if (!record) {
    console.log("[slack-bot-worker]", JSON.stringify({ outcome: "duplicate_skipped", latencyMs: Date.now() - startedAt }));
    return;
  }

  try {
    const allowlist = await loadSlackRuntimeAllowlist();
    const api = createSlackWebApi(safeString(process.env[SLACK_BOT_TOKEN_ENV]));
    const allowed = evaluateSlackAllowlist({ channelId: record.channelId, userId: record.userId }, allowlist);
    if (!allowed.allowed) throw new SlackBotError("allowlist_denied");
    let status: { status: string; code: string } | undefined;
    if (record.command.kind === "status") {
      try {
        status = await loadSafeOperationalStatus(record.command.referenceId);
      } catch (error) {
        status = { status: "unavailable", code: safeErrorCode(error) };
      }
    }
    await postSlackMessage(api, {
      channel: record.channelId,
      threadTs: record.threadTs,
      text: formatMentionReply(record.command, status),
      clientMessageId: clientMessageId(record.eventIdHash),
    });
    await snapshot.ref.update({ status: "delivered", completedAt: new Date(), failureCode: null });
    console.log("[slack-bot-worker]", JSON.stringify({
      outcome: "delivered",
      kind: record.kind,
      latencyMs: Date.now() - startedAt,
    }));
  } catch (error) {
    const code = safeErrorCode(error);
    await snapshot.ref.update({ status: "failed", completedAt: new Date(), failureCode: code });
    console.warn("[slack-bot-worker]", JSON.stringify({
      outcome: "failed",
      kind: record.kind,
      code,
      latencyMs: Date.now() - startedAt,
    }));
  }
}
