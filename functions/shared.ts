export type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";
export type ResultStatus = "success" | "denied" | "error" | "mock" | "blocked" | "cache_hit" | "allow" | "deny";

export interface CallableRequestShape {
  auth?: {
    uid?: string;
    token?: {
      role?: Role;
      team?: string;
      gameId?: string;
      email?: string;
      /**
       * Reserved Firebase ID-token claim, copied only by functions/index.ts
       * after the callable runtime has verified the token and the tenant
       * boundary has accepted it.
       */
      emailVerified?: boolean;
      firebase?: {
        tenant?: string;
      };
      name?: string;
      picture?: string;
      memberName?: string;
      memberEmail?: string;
      memberPhotoURL?: string;
      claimSyncReason?: string;
      financeRole?: string;
      scpFinanceRole?: string;
      finance_role?: string;
    };
  };
  data?: unknown;
  app?: { appId?: string };
  rawRequest?: { ip?: string };
  /**
   * W72-C R2 HIGH-2: **서버가 만든 내부 호출**임을 표시한다.
   * 공개 콜러블은 외부 요청에서 서버 소유 표식(독려 예외 provenance)을 입구에서 지운다 —
   * 이 플래그가 없으면 인증된 manager 가 요청 본문에 provenance 를 넣어 예외를 열 수 있다.
   * 외부 요청은 이 값을 넣을 수 없다(request 객체를 서버 코드가 구성한다).
   */
  internalTrustedInvocation?: boolean;
}

export interface AuthContext {
  userId: string;
  role: Exclude<Role, "guest">;
  team: string;
  ip: string;
  gameId: string;
  email?: string;
  name?: string;
}

export interface BehaviorLog {
  userId: string;
  role: Role;
  team: string;
  gameId: string;
  action: string;
  time: string;
  IP: string;
  result: "success" | "denied" | "error" | "mock" | "blocked" | "cache_hit";
  cost: number;
}

export interface CacheMeta {
  checked: true;
  hit: boolean;
  key: string;
  ttlSeconds: number;
  checkedAt: string;
}

export interface CostLog {
  ledgerRef: string;
  provider: "mock" | "mock-gateway" | "mock-email" | "mock-admin" | "mock-crm" | "mock-report";
  model: string;
  cacheChecked: true;
  cacheHit: boolean;
  inputTokens: number;
  outputTokens: number;
  estimatedKRW: number;
  currency: "KRW";
  billable: false;
  loggedAt: string;
}

export function isRole(value: unknown): value is Role {
  return value === "super_admin" || value === "admin" || value === "manager" || value === "viewer" || value === "guest";
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

export function makeDeniedBehaviorLog(request: CallableRequestShape, action: string, gameId = "global", cost = 0): BehaviorLog {
  const role = isRole(request.auth?.token?.role) ? request.auth.token.role : "guest";
  return {
    userId: request.auth?.uid ?? "anonymous",
    role,
    team: request.auth?.token?.team ?? "unassigned",
    gameId,
    action,
    time: new Date().toISOString(),
    IP: request.rawRequest?.ip ?? "0.0.0.0",
    result: "denied",
    cost,
  };
}

export function assertNonGuestAuth(
  request: CallableRequestShape,
  action: string,
  allowedRoles: readonly Exclude<Role, "guest">[] = ["super_admin", "admin", "manager", "viewer"],
): AuthContext {
  const uid = request.auth?.uid;
  const role = request.auth?.token?.role ?? "guest";
  if (!uid || role === "guest" || !allowedRoles.includes(role as Exclude<Role, "guest">)) {
    const error = new Error(!uid ? "unauthenticated" : "permission-denied: role blocked");
    Object.assign(error, {
      code: !uid ? "unauthenticated" : "permission-denied", errorCode: "assert_non_guest_auth_unauthorized",
      behaviorLog: makeDeniedBehaviorLog(request, action, request.auth?.token?.gameId ?? "global"),
    });
    throw error;
  }

  return {
    userId: uid,
    role: role as Exclude<Role, "guest">,
    team: request.auth?.token?.team ?? "unassigned",
    ip: request.rawRequest?.ip ?? "0.0.0.0",
    gameId: request.auth?.token?.gameId ?? "global",
    ...(request.auth?.token?.memberEmail || request.auth?.token?.email ? { email: request.auth.token.memberEmail ?? request.auth.token.email } : {}),
    ...(request.auth?.token?.memberName || request.auth?.token?.name ? { name: request.auth.token.memberName ?? request.auth.token.name } : {}),
  };
}

export function makeBehaviorLog(context: AuthContext, action: string, result: BehaviorLog["result"], gameId = context.gameId, cost = 0): BehaviorLog {
  return {
    userId: context.userId,
    role: context.role,
    team: context.team,
    gameId,
    action,
    time: new Date().toISOString(),
    IP: context.ip,
    result,
    cost,
  };
}

export function makeCache(key: string, hit = false, ttlSeconds = 600): CacheMeta {
  return { checked: true, hit, key, ttlSeconds, checkedAt: new Date().toISOString() };
}

export function makeCostLog(action: string, model: string, cacheHit = false, tokenEstimate = 0): CostLog {
  return {
    ledgerRef: `cost_logs/${action}/${Math.abs(hashString(`${model}:${action}:${cacheHit}`))}`,
    provider: model.includes("email") ? "mock-email" : model.includes("crm") ? "mock-crm" : model.includes("report") ? "mock-report" : model.includes("admin") ? "mock-admin" : "mock-gateway",
    model,
    cacheChecked: true,
    cacheHit,
    inputTokens: cacheHit ? 0 : tokenEstimate,
    outputTokens: cacheHit ? 0 : Math.max(0, Math.round(tokenEstimate / 2)),
    estimatedKRW: 0,
    currency: "KRW",
    billable: false,
    loggedAt: new Date().toISOString(),
  };
}

export function stableRef(prefix: string, seed: string): string {
  return `${prefix}/${Math.abs(hashString(seed)).toString(36)}`;
}

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

function hashString(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return hash;
}
