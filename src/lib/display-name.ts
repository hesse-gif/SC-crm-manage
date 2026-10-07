// 표시 이름 공용 resolver (P7, ADR-2 1단계 — 클라이언트 전용).
// 우선순위: creatorName > channelName/handle > email > safe short id > raw token(절대 비노출).
// 서버 scp_lifecycle_profiles에는 아직 이름 필드가 없으므로(별도 승인 대상, 서버 projection 변경은
// 이번 라운드 제외), 이름다운 값이 하나도 없을 때는 원문 토큰/ID를 그대로 보여주는 대신
// scp-alias-id.ts의 shortHash를 재사용해 "라벨 #ab12cd" 형태의 안전한 짧은 식별자로 대체한다.
import { shortHash } from "./scp-alias-id.ts";

export type ResolveDisplayNameInput = {
  creatorName?: unknown;
  channelName?: unknown;
  handle?: unknown;
  email?: unknown;
  rawId?: unknown;
};

const DEFAULT_FALLBACK_LABEL = "크리에이터";
const INVALID_DISPLAY_NAMES = new Set(["true", "false", "null", "undefined", "nan", "n/a", "na", "-"]);
const GENERIC_SCP_DISPLAY_NAME = /^scp(?:프로필|파트너|profile|partner)(?:#[\p{L}\p{N}_-]+)?$/iu;

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

// NFKC 정규화+공백 제거 후 판정 — 전각(ＴＲＵＥ)·공백 삽입(123 456) 우회 차단(scpPartnerAdapter.ts와 동일 클래스).
export function isUsableDisplayName(value: unknown): boolean {
  const candidate = text(value);
  if (!candidate) return false;
  const normalized = candidate.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  if (!normalized || INVALID_DISPLAY_NAMES.has(normalized)) return false;
  if (GENERIC_SCP_DISPLAY_NAME.test(normalized)) return false;
  if (/^[0-9]+$/.test(normalized)) return false;
  return /[\p{L}\p{N}@]/u.test(candidate);
}

function emailLocalPart(email: string): string {
  const at = email.indexOf("@");
  const local = (at > 0 ? email.slice(0, at) : email).replace(/[._-]+/g, " ").trim();
  return local;
}

/** raw id/token → 6자리 안전 해시. 원문을 그대로 노출하지 않는 안정적 짧은 식별자용. */
export function safeShortId(rawId: unknown): string {
  const id = text(rawId);
  return id ? shortHash(id).slice(0, 6) : "";
}

/** "<라벨> #ab12cd" 형태. rawId가 없으면 라벨만. raw token은 절대 그대로 반환하지 않는다. */
export function safeShortLabel(rawId: unknown, fallbackLabel: string = DEFAULT_FALLBACK_LABEL): string {
  const shortId = safeShortId(rawId);
  return shortId ? `${fallbackLabel} #${shortId}` : fallbackLabel;
}

/**
 * 표시 이름 공용 resolver.
 * 우선순위: creatorName > channelName/handle > email(local part) > safe short id(rawId 해시) > fallbackLabel.
 * 어떤 분기에서도 raw token/id 원문은 반환하지 않는다.
 */
export function resolveDisplayName(input: ResolveDisplayNameInput, fallbackLabel: string = DEFAULT_FALLBACK_LABEL): string {
  const creatorName = text(input.creatorName);
  if (isUsableDisplayName(creatorName)) return creatorName;

  const channelName = text(input.channelName);
  if (isUsableDisplayName(channelName)) return channelName;

  const handle = text(input.handle);
  if (isUsableDisplayName(handle)) return handle;

  const email = text(input.email);
  if (email.includes("@")) {
    const local = emailLocalPart(email.toLowerCase());
    if (isUsableDisplayName(local)) return local;
  }

  return safeShortLabel(input.rawId, fallbackLabel);
}
