import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CHAT_AUTO_PERMIT_RELEASE_IDENTITY_SCHEMA_VERSION =
  "flu.chat-auto-permit-release-identity.v1" as const;
export const CHAT_AUTO_PERMIT_RELEASE_IDENTITY_ARTIFACT =
  "chatAutoPermitReleaseIdentity.generated.json" as const;

export type ChatAutoPermitReleaseIdentityArtifact = {
  schemaVersion: typeof CHAT_AUTO_PERMIT_RELEASE_IDENTITY_SCHEMA_VERSION;
  sourceCommit: string;
  runtimeEnvironment: "production";
  databaseId: "(default)";
  functionsCodebase: "default";
  firebaseProjectId: "influchat-77db6";
  generatedAtIso: string;
  generator: "scripts/deploy-prod.mjs";
  artifactSha256: string;
};

export type ChatAutoPermitReleaseIdentity = {
  sourceCommit: string;
  metadataSha256: string;
  generatedAtIso: string;
};

const LOWERCASE_COMMIT = /^[a-f0-9]{40}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function failReleaseIdentity(message: string): never {
  throw Object.assign(
    new Error(`failed-precondition: server release identity is unavailable: ${message}`),
    {
      code: "failed-precondition",
      errorCode: "chat_auto_case_permit_release_identity_unavailable",
    },
  );
}

function canonicalReleaseIdentityPayload(
  artifact: Omit<ChatAutoPermitReleaseIdentityArtifact, "artifactSha256">,
): Omit<ChatAutoPermitReleaseIdentityArtifact, "artifactSha256"> {
  return {
    schemaVersion: artifact.schemaVersion,
    sourceCommit: artifact.sourceCommit,
    runtimeEnvironment: artifact.runtimeEnvironment,
    databaseId: artifact.databaseId,
    functionsCodebase: artifact.functionsCodebase,
    firebaseProjectId: artifact.firebaseProjectId,
    generatedAtIso: artifact.generatedAtIso,
    generator: artifact.generator,
  };
}

function releaseIdentitySha256(
  artifact: Omit<ChatAutoPermitReleaseIdentityArtifact, "artifactSha256">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalReleaseIdentityPayload(artifact)), "utf8")
    .digest("hex");
}

export function expectedChatAutoPermitReleaseIdentitySha256(
  artifact: Omit<ChatAutoPermitReleaseIdentityArtifact, "artifactSha256">,
): string {
  return releaseIdentitySha256(artifact);
}

export function assertChatAutoPermitReleaseIdentityArtifact(
  artifact: unknown,
): ChatAutoPermitReleaseIdentityArtifact {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    failReleaseIdentity("metadata artifact is not a JSON object");
  }
  const record = artifact as Record<string, unknown>;
  const expectedKeys = [
    "artifactSha256",
    "databaseId",
    "firebaseProjectId",
    "functionsCodebase",
    "generatedAtIso",
    "generator",
    "runtimeEnvironment",
    "schemaVersion",
    "sourceCommit",
  ];
  if (Object.keys(record).sort().join("\n") !== expectedKeys.join("\n")) {
    failReleaseIdentity("metadata artifact has unexpected fields");
  }
  const typed = record as ChatAutoPermitReleaseIdentityArtifact;
  if (typed.schemaVersion !== CHAT_AUTO_PERMIT_RELEASE_IDENTITY_SCHEMA_VERSION) {
    failReleaseIdentity("metadata artifact schema is invalid");
  }
  if (!LOWERCASE_COMMIT.test(String(typed.sourceCommit ?? ""))) {
    failReleaseIdentity("metadata artifact source commit is invalid");
  }
  if (
    typed.runtimeEnvironment !== "production" ||
    typed.databaseId !== "(default)" ||
    typed.functionsCodebase !== "default" ||
    typed.firebaseProjectId !== "influchat-77db6" ||
    typed.generator !== "scripts/deploy-prod.mjs"
  ) {
    failReleaseIdentity("metadata artifact lane identity is invalid");
  }
  if (
    typeof typed.generatedAtIso !== "string" ||
    Number.isNaN(new Date(typed.generatedAtIso).getTime()) ||
    new Date(typed.generatedAtIso).toISOString() !== typed.generatedAtIso
  ) {
    failReleaseIdentity("metadata artifact timestamp is invalid");
  }
  if (
    !SHA256_HEX.test(String(typed.artifactSha256 ?? "")) ||
    typed.artifactSha256 !== releaseIdentitySha256(typed)
  ) {
    failReleaseIdentity("metadata artifact hash is invalid");
  }
  return Object.freeze({ ...typed });
}

export function resolveChatAutoPermitReleaseIdentity({
  artifactPath = join(__dirname, CHAT_AUTO_PERMIT_RELEASE_IDENTITY_ARTIFACT),
  readFile = readFileSync,
}: {
  artifactPath?: string;
  readFile?: typeof readFileSync;
} = {}): ChatAutoPermitReleaseIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(readFile(artifactPath, "utf8")));
  } catch {
    failReleaseIdentity("metadata artifact is missing or invalid JSON");
  }
  const artifact = assertChatAutoPermitReleaseIdentityArtifact(parsed);
  return Object.freeze({
    sourceCommit: artifact.sourceCommit,
    metadataSha256: artifact.artifactSha256,
    generatedAtIso: artifact.generatedAtIso,
  });
}

let cachedSourceCommit: string | null | undefined;
let cachedFailureAtMs: number | undefined;

// P2-3 [적대 리뷰]: 성공한 조회는 프로세스 수명 내내 유효하다(배포 아티팩트는 프로세스 수명 동안
// 안 바뀐다 — 새 배포 = 새 인스턴스). 하지만 **실패**를 똑같이 영구 캐시하면, 일시적 이유(예:
// 배포 직후 파일시스템 레이스, 컨테이너 콜드스타트 중 아티팩트 미기록)로 한 번 실패한 인스턴스가
// 남은 수명 내내 이 축의 release-identity 체크를 계속 건너뛰게 된다. 실패만 짧은 창(60초) 동안만
// 캐시해 다음 조회에서 재시도하게 한다.
const FAILURE_CACHE_TTL_MS = 60_000;

/**
 * [적대 리뷰 MED-3] 발송 시점 게이트(sendAutoReplyJob)가 매 자동회신마다 이 파일을 다시 읽고
 * 해시 검증하는 비용/실패 가능성을 지지 않도록 **프로세스당 한 번만** resolve 한다. 단, 실패는
 * FAILURE_CACHE_TTL_MS 동안만 캐시한다(위 주석) — 그 창 안에서는 재시도하지 않고 조용히 null을
 * 반환하지만(로그는 실패마다 새로 뜨지 않는다, 창당 1회), 창이 지나면 다시 resolve를 시도한다.
 */
export function cachedChatAutoPermitReleaseSourceCommit(
  resolve: typeof resolveChatAutoPermitReleaseIdentity = resolveChatAutoPermitReleaseIdentity,
  nowMs: number = Date.now(),
): string | null {
  if (cachedSourceCommit !== undefined) {
    if (cachedSourceCommit !== null) return cachedSourceCommit;
    if (cachedFailureAtMs !== undefined && nowMs - cachedFailureAtMs < FAILURE_CACHE_TTL_MS) return null;
  }
  try {
    cachedSourceCommit = resolve().sourceCommit;
    cachedFailureAtMs = undefined;
  } catch (error) {
    cachedSourceCommit = null;
    cachedFailureAtMs = nowMs;
    // 창당 1회만 찍는다 — 위 조기 return이 창 안의 나머지 호출을 로그 없이 흡수한다.
    console.error(
      "[chat-auto-permit-release-identity] release identity unavailable, caching failure for 60s",
      error instanceof Error ? error.message : String(error),
    );
  }
  return cachedSourceCommit;
}

/** 테스트 전용: 프로세스 캐시를 리셋한다. */
export function __resetCachedChatAutoPermitReleaseSourceCommitForTest(): void {
  cachedSourceCommit = undefined;
  cachedFailureAtMs = undefined;
}
