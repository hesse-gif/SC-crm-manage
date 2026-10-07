// 티켓(버그 제보·개선 의견) 순수 로직 — Firebase 의존 없음(노드 레인에서 단위 테스트).
// 출처: supercent-io/ticket-widget-skill (assets/firebase-tickets.ts · firestore-tickets.rules) 의
// 검증 규칙을 서버 경계로 옮겼다. 클라이언트는 Firestore를 만지지 않는다(SEC-P0-004).
import { createHash } from "node:crypto";

export type TicketKind = "bug" | "idea";
export type TicketStatus = "open" | "done";
export type TicketSyncStatus = "pending" | "synced" | "failed" | "manual";

export const TICKET_MAX_BODY = 2000;
export const TICKET_MAX_IMAGES = 5;
// 장당 상한 — 5장이 Firestore 문서 1MB 상한 안에 들어오도록 잡은 값(5 × 180KB = 900KB).
export const TICKET_MAX_IMAGE = 180_000;
export const TICKET_MAX_LOGS = 20_000;
export const TICKET_LIST_LIMIT = 500;

export interface TicketSubmission {
  kind: TicketKind;
  body: string;
  images: string[];
  logs: string | null;
}

export class TicketValidationError extends Error {
  readonly code = "invalid-argument" as const;
  constructor(message: string) {
    super(message);
    this.name = "TicketValidationError";
  }
}

const DATA_IMAGE_RE = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export function validateTicketSubmission(input: unknown): TicketSubmission {
  const data = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const kind = data.kind;
  if (kind !== "bug" && kind !== "idea") throw new TicketValidationError("kind must be bug|idea");
  const body = typeof data.body === "string" ? data.body.trim() : "";
  if (!body) throw new TicketValidationError("body is required");
  if (body.length > TICKET_MAX_BODY) throw new TicketValidationError(`body exceeds ${TICKET_MAX_BODY} chars`);
  const rawImages = data.images === undefined ? [] : data.images;
  if (!Array.isArray(rawImages)) throw new TicketValidationError("images must be an array");
  if (rawImages.length > TICKET_MAX_IMAGES) throw new TicketValidationError(`at most ${TICKET_MAX_IMAGES} images`);
  const images = rawImages.map((value, index) => {
    if (typeof value !== "string" || !DATA_IMAGE_RE.test(value)) {
      throw new TicketValidationError(`image ${index + 1} must be a base64 data URL`);
    }
    if (value.length > TICKET_MAX_IMAGE) throw new TicketValidationError(`image ${index + 1} exceeds ${TICKET_MAX_IMAGE} bytes`);
    return value;
  });
  let logs: string | null = null;
  if (data.logs !== undefined && data.logs !== null && data.logs !== "") {
    if (typeof data.logs !== "string") throw new TicketValidationError("logs must be a string");
    // 버그 티켓에만 붙는 콘솔 로그 — 초과분은 오래된 앞부분을 버린다(클라이언트 상한과 동일).
    logs = data.logs.length > TICKET_MAX_LOGS ? data.logs.slice(-TICKET_MAX_LOGS) : data.logs;
  }
  return { kind, body, images, logs };
}

export function validateTicketStatus(value: unknown): TicketStatus {
  if (value !== "open" && value !== "done") throw new TicketValidationError("status must be open|done");
  return value;
}

export function validateTicketId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TicketValidationError("ticketId is invalid");
  }
  return value;
}

// ─── SuperBoard 어댑터 ────────────────────────────────────────────────────────
// sb CLI(`sb create`)와 같은 `/v1/tasks` 계약을 쓴다. 토큰은 서버 env(SUPERBOARD_TOKEN)에서만 읽고
// 없으면 `manual`로 종료한다 — 사용자 제출은 이 결과와 무관하게 이미 저장돼 있다.
export const SUPERBOARD_API_BASE_DEFAULT =
  "https://asia-northeast3-aix-board.cloudfunctions.net/fnApiV1/v1";
// Flu 보드 식별자(비밀 아님). env 로 덮어쓸 수 있다.
export const SUPERBOARD_FLU_PROJECT_ID_DEFAULT = "tp-1782269858156-cwxyyk";
export const SUPERBOARD_FLU_TEAM_ID_DEFAULT = "personal:iWngT3d81gYOYbPn6D3awUXKGZG2";
export const SUPERBOARD_SOURCE_APP = "flu";
export const SUPERBOARD_REPO = "flu";
export const SUPERBOARD_SYNC_TIMEOUT_MS = 8_000;
export const SUPERBOARD_PRODUCTION_APP_URL = "https://sc-flu.web.app";
// sb CLI 의 인테이크 상한(MAX_INTAKE_CONTENT_BYTES 850_000)과 같은 예산 — 본문+로그+이미지 전체가 이 안이어야 한다.
export const SUPERBOARD_CONTENT_BUDGET_BYTES = 800_000;
export const SUPERBOARD_LOG_LINES_MAX = 40;
export const SUPERBOARD_LOG_CHARS_MAX = 6_000;

export interface SuperboardConfig {
  token: string | null;
  apiBase: string;
  projectId: string;
  teamId: string;
  appUrl: string | null;
}

export function readSuperboardConfig(env: NodeJS.ProcessEnv): SuperboardConfig {
  const token = typeof env.SUPERBOARD_TOKEN === "string" && env.SUPERBOARD_TOKEN.trim()
    ? env.SUPERBOARD_TOKEN.trim()
    : null;
  return {
    token,
    apiBase: (env.SUPERBOARD_API_BASE || SUPERBOARD_API_BASE_DEFAULT).replace(/\/+$/, ""),
    projectId: env.SUPERBOARD_PROJECT_ID || SUPERBOARD_FLU_PROJECT_ID_DEFAULT,
    teamId: env.SUPERBOARD_TEAM_ID || SUPERBOARD_FLU_TEAM_ID_DEFAULT,
    // Admin 링크 절대화: env 로 덮어쓰지 않으면 프로덕션 레인에서만 라이브 호스팅 도메인을 쓴다
    // (functions/.env.influchat-77db6 는 레인 3-튜플만 허용해 FLU_APP_URL 을 넣을 수 없다).
    appUrl: typeof env.FLU_APP_URL === "string" && env.FLU_APP_URL.trim()
      ? env.FLU_APP_URL.trim().replace(/\/+$/, "")
      : env.FLU_RUNTIME_ENV === "production"
        ? SUPERBOARD_PRODUCTION_APP_URL
        : null,
  };
}

export function ticketIntakeKey(projectId: string, ticketId: string): string {
  const seed = `flu-ticket:${ticketId}`;
  return `intake:${createHash("sha256").update(`${projectId}\n${seed}`).digest("hex").slice(0, 24)}`;
}

export function maskTicketEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***${email.slice(at)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const KIND_LABEL: Record<TicketKind, string> = { bug: "버그 제보", idea: "개선 의견" };

export function ticketTitle(kind: TicketKind, body: string): string {
  const firstLine = body.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const head = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  return `[Flu 제보] ${KIND_LABEL[kind]}: ${head}`;
}

export interface SuperboardTaskBody {
  teamId: string;
  taskProjectId: string;
  title: string;
  status: "todo";
  content: string;
  properties: Record<string, string>;
}

// 이미지 data URL은 SuperBoard에 중복 저장하지 않는다 — 본문에는 원문과 Admin 링크만.
export interface SuperboardTicketInput {
  id: string;
  kind: TicketKind;
  body: string;
  authorEmail: string;
  images: string[]; // data URL — SuperBoard 본문에 예산 안에서 그대로 임베드
  logs: string | null; // 위젯이 모은 환경 헤더(URL/Title/UA/…) + 페이지 이동([nav]) + 콘솔 오류
}

// 위젯 로그 헤더(`Key: value` 줄)와 본문 줄을 나눈다. 헤더가 곧 "어느 페이지에서 났는가"의 근거다.
export function parseTicketLogs(logs: string | null): { header: Record<string, string>; lines: string[] } {
  const header: Record<string, string> = {};
  const lines: string[] = [];
  if (!logs) return { header, lines };
  let inHeader = true;
  for (const raw of logs.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (inHeader) {
      const m = /^(URL|Title|Page|UA|Viewport|Time):\s*(.*)$/.exec(line);
      if (m) { header[m[1]] = m[2].trim(); continue; }
      if (line === "") { inHeader = false; continue; }
      inHeader = false;
    }
    if (line !== "") lines.push(line);
  }
  return { header, lines };
}

function pagePathOf(url: string | undefined): string | null {
  if (!url) return null;
  try { const u = new URL(url); return `${u.pathname}${u.search}`; } catch { return url; }
}

// 이미지 data URL은 sb 인테이크와 같은 <figure><img> 형태로 임베드하되 전체 예산을 넘기지 않는다.
export function buildSuperboardTask(config: SuperboardConfig, ticket: SuperboardTicketInput): SuperboardTaskBody {
  const adminPath = `/admin/tickets?ticket=${encodeURIComponent(ticket.id)}`;
  const adminLink = config.appUrl ? `${config.appUrl}${adminPath}` : adminPath;
  const { header, lines } = parseTicketLogs(ticket.logs);
  const pagePath = pagePathOf(header.URL);
  const navTrail = lines.filter((l) => l.includes("[nav]")).slice(-8);
  const errorLines = lines.filter((l) => !l.includes("[nav]")).slice(-SUPERBOARD_LOG_LINES_MAX);

  const where = [
    pagePath ? `발생 페이지: <code>${escapeHtml(pagePath)}</code>${header.Title ? ` — ${escapeHtml(header.Title)}` : ""}` : "",
    header.URL ? `URL: <a href="${escapeHtml(header.URL)}">${escapeHtml(header.URL)}</a>` : "",
    header.Time ? `제출 시각: ${escapeHtml(header.Time)}` : "",
    header.UA ? `브라우저: ${escapeHtml(header.UA)}` : "",
    header.Viewport ? `뷰포트: ${escapeHtml(header.Viewport)}` : "",
    navTrail.length ? `직전 페이지 이동: ${escapeHtml(navTrail.map((l) => l.replace(/^.*\[nav\]\s*/, "")).join(" → "))}` : "",
  ].filter(Boolean);
  const evidence = [
    `제보자: ${escapeHtml(maskTicketEmail(ticket.authorEmail))}`,
    `Flu Admin 티켓(원본·이미지·전체 로그): <a href="${escapeHtml(adminLink)}">${escapeHtml(adminLink)}</a>`,
  ];
  let logBlock = "";
  if (errorLines.length) {
    const text = errorLines.join("\n").slice(-SUPERBOARD_LOG_CHARS_MAX);
    logBlock = `<h2>최근 콘솔 오류 (${errorLines.length}줄)</h2><pre>${escapeHtml(text)}</pre>`;
  } else if (ticket.kind === "bug") {
    logBlock = `<h2>최근 콘솔 오류</h2><p>제출 시점에 기록된 콘솔 오류·경고 없음</p>`;
  }

  let content =
    `<h2>요약</h2><p>${escapeHtml(KIND_LABEL[ticket.kind])} (Flu 앱 내 제보 위젯)</p>` +
    `<h2>문제</h2><p>${escapeHtml(ticket.body).replace(/\r?\n/g, "<br>")}</p>` +
    (where.length ? `<h2>발생 위치</h2><ul>${where.map((line) => `<li>${line}</li>`).join("")}</ul>` : "") +
    `<h2>관찰 근거</h2><ul>${evidence.map((line) => `<li>${line}</li>`).join("")}</ul>` +
    logBlock;

  // 이미지는 예산이 남는 만큼 순서대로 임베드, 나머지는 장수만 남긴다.
  const figures: string[] = [];
  let used = Buffer.byteLength(content, "utf8");
  let omitted = 0;
  ticket.images.forEach((src, i) => {
    const fig = `<figure><img src="${escapeHtml(src)}" alt="첨부 이미지 ${i + 1}" /></figure>`;
    const bytes = Buffer.byteLength(fig, "utf8");
    if (used + bytes <= SUPERBOARD_CONTENT_BUDGET_BYTES) { figures.push(fig); used += bytes; } else omitted += 1;
  });
  if (figures.length || omitted) {
    content += `<h2>첨부 이미지</h2>${figures.join("")}`;
    if (omitted) content += `<p>용량 제한으로 ${omitted}장은 생략 — Flu Admin 에서 확인</p>`;
  }
  return {
    teamId: config.teamId,
    taskProjectId: config.projectId,
    title: ticketTitle(ticket.kind, ticket.body),
    status: "todo",
    content,
    properties: {
      intakeKey: ticketIntakeKey(config.projectId, ticket.id),
      intakeSource: "flu-ticket-widget",
      intakeSourceRef: `flu-ticket:${ticket.id}`,
      sourceApp: SUPERBOARD_SOURCE_APP,
      sourceTicketId: ticket.id,
      repo: SUPERBOARD_REPO,
      intakeRepo: SUPERBOARD_REPO,
      deliveryMode: "github",
    },
  };
}

export interface SuperboardSyncResult {
  status: TicketSyncStatus;
  taskId: string | null;
  ticketKey: string | null;
  error: string | null;
}

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function syncTicketToSuperboard(
  config: SuperboardConfig,
  ticket: SuperboardTicketInput,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<SuperboardSyncResult> {
  if (!config.token) return { status: "manual", taskId: null, ticketKey: null, error: null };
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const body = buildSuperboardTask(config, ticket);
  try {
    const response = await fetchImpl(`${config.apiBase}/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? SUPERBOARD_SYNC_TIMEOUT_MS),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !json || json.ok === false) {
      const detail = json && typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
      return { status: "failed", taskId: null, ticketKey: null, error: detail.slice(0, 300) };
    }
    const task = (json.data ?? json.task ?? json) as Record<string, unknown>;
    const taskId = typeof task.id === "string" ? task.id : typeof task.docId === "string" ? task.docId : null;
    if (!taskId) return { status: "failed", taskId: null, ticketKey: null, error: "response has no task id" };
    const ticketId = typeof task.ticketId === "string" ? task.ticketId : null;
    return { status: "synced", taskId, ticketKey: ticketId ? `Flu/${ticketId}` : null, error: null };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { status: "failed", taskId: null, ticketKey: null, error: message.slice(0, 300) };
  }
}
