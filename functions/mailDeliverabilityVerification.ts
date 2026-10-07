import { createHash } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { asString } from "./shared";

// 사용자 결정 2026-08-10: 2년(한번 검증하면 2년간 재과금 없음).
export const MAIL_VERIFICATION_JUDGMENT_TTL_MS = 730 * 24 * 60 * 60 * 1000;

const JUDGMENTS_COLLECTION = "mail_verification_judgments";
// 선택 시점 배치 읽기의 getAll 청크 크기 — 스캔 창(수천)이 넘겨주는 이메일이 전부 문서 경로로
// 변환되므로, 한 RPC 에 담는 참조 수를 유계한다(읽기 과금은 문서 수 기준으로 불변).
const JUDGMENT_READ_CHUNK_SIZE = 500;
const BOUNCER_QUERY_TIMEOUT_SECONDS = 10;
const BOUNCER_ABORT_MS = 12_000;
const VALID_STATUSES = new Set(["deliverable", "risky", "undeliverable", "unknown"]);

export type MailDeliverabilityStatus = "deliverable" | "risky" | "undeliverable" | "unknown";

export type MailDeliverabilityResult = {
  status: MailDeliverabilityStatus;
  cacheHit: boolean;
  failOpen?: boolean;
};

export type MailDeliverabilityDeps = {
  fetchImpl?: typeof fetch;
  db?: FirebaseFirestore.Firestore;
  now?: () => Date;
  apiKey?: string;
};

// mailExternalSentImport.ts:212 컨벤션 재사용: sha256(normalizeEmail(v)).slice(0,24).
// 판정 문서 id 정본 — 캐시 전용 벌크 조회(readCachedMailDeliverabilityStatuses)도 같은 해시를 쓴다.
export function emailHash(value: string): string {
  const normalized = asString(value, "").trim().toLowerCase();
  return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 24) : "";
}

async function bouncerVerify(
  email: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<MailDeliverabilityStatus | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOUNCER_ABORT_MS);
  try {
    const url = `https://api.usebouncer.com/v1.1/email/verify?email=${encodeURIComponent(email)}&timeout=${BOUNCER_QUERY_TIMEOUT_SECONDS}`;
    const response = await fetchImpl(url, {
      headers: { "x-api-key": apiKey },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { status?: unknown };
    const status = asString(body?.status, "");
    return VALID_STATUSES.has(status) ? (status as MailDeliverabilityStatus) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 단일 진입점. 캐시 조회가 항상 먼저이고(조건부 우회 없음), 미스에서만 벤더를 호출한다.
// 벤더 예외/402/429/타임아웃/스키마 불일치는 전부 fail-open("unknown")이며, 그 경우 판정 문서를
// 쓰지 않는다 — 오류를 캐시하면 다음 발송까지 근거 없이 막히기 때문이다.
export async function resolveMailDeliverability(
  email: string,
  deps: MailDeliverabilityDeps = {},
): Promise<MailDeliverabilityResult> {
  const hash = emailHash(email);
  if (!hash) return { status: "unknown", cacheHit: false, failOpen: true };
  const db = deps.db ?? adminDb;
  const now = deps.now ?? (() => new Date());
  const docRef = db.collection(JUDGMENTS_COLLECTION).doc(hash);
  const cached = (await docRef.get()).data();
  if (cached && Date.parse(asString(cached.expiresAtIso)) > now().getTime()) {
    return { status: cached.status as MailDeliverabilityStatus, cacheHit: true };
  }
  const apiKey = deps.apiKey ?? process.env.BOUNCER_API_KEY ?? "";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const status = apiKey ? await bouncerVerify(email, apiKey, fetchImpl) : null;
  if (!status) return { status: "unknown", cacheHit: false, failOpen: true };
  const checkedAtIso = now().toISOString();
  const expiresAtIso = new Date(now().getTime() + MAIL_VERIFICATION_JUDGMENT_TTL_MS).toISOString();
  await docRef.set({ status, checkedAtIso, expiresAtIso, source: "bouncer" });
  return { status, cacheHit: false };
}

/**
 * P0-2: **선택 시점 전용 캐시-온리 리더.** resolveMailDeliverability 와 달리 벤더
 * (Bouncer/fetch)를 절대 호출하지 않는다 — deps 타입에 fetchImpl 자리가 아예 없다.
 * 준비/수집 경로가 후보당 1크레딧을 태울 수는 없고, 캐시 미스를 "통과"(발송 시점 게이트로
 * 위임)로 읽어야 하므로 미스에 대한 판정 문서를 새로 쓰지도 않는다.
 *
 * 읽기 비용: 이메일 해시 → 문서 경로 변환 후 `db.getAll` 배치 읽기라 쿼리 없이 문서 수에
 * 유계다. 만료 문서(expiresAtIso 경과)는 부재와 동일하게 취급한다 — 만료 판정으로 후보를
 * 영구 제외하지 않는다(발송 시점 재검증 fail-open 방향과 같은 쪽).
 *
 * 반환 Map 의 키는 `trim().toLowerCase()` 정규화 이메일이다(해시 규약과 같은 정규화).
 */
export async function readCachedMailDeliverabilityStatuses(
  emails: readonly string[],
  deps: { db?: FirebaseFirestore.Firestore; now?: () => Date } = {},
): Promise<Map<string, MailDeliverabilityStatus>> {
  const db = deps.db ?? adminDb;
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const refsByEmail = new Map<string, FirebaseFirestore.DocumentReference>();
  for (const value of emails) {
    const normalized = asString(value, "").trim().toLowerCase();
    if (!normalized || refsByEmail.has(normalized)) continue;
    const hash = emailHash(normalized);
    if (!hash) continue;
    refsByEmail.set(normalized, db.collection(JUDGMENTS_COLLECTION).doc(hash));
  }
  const statuses = new Map<string, MailDeliverabilityStatus>();
  if (refsByEmail.size === 0) return statuses;
  const emailByRefPath = new Map(
    [...refsByEmail.entries()].map(([email, ref]) => [ref.path, email] as const),
  );
  const refs = [...refsByEmail.values()];
  const refChunks: FirebaseFirestore.DocumentReference[][] = [];
  for (let index = 0; index < refs.length; index += JUDGMENT_READ_CHUNK_SIZE) {
    refChunks.push(refs.slice(index, index + JUDGMENT_READ_CHUNK_SIZE));
  }
  // 청크 간에는 의존이 없으므로 병렬 — 예산·순서 결합이 없는 순수 배치 읽기다.
  const snapshots = (await Promise.all(refChunks.map((chunk) => db.getAll(...chunk)))).flat();
  for (const snapshot of snapshots) {
    if (!snapshot.exists) continue;
    const email = emailByRefPath.get(snapshot.ref.path);
    if (!email) continue;
    const data = snapshot.data() ?? {};
    const status = asString(data.status, "");
    if (!VALID_STATUSES.has(status)) continue;
    // resolveMailDeliverability 와 같은 해석: expiresAtIso 가 없거나 파싱 불가(NaN)여도
    // "유효 판정 아님" = 부재다 — 만료뿐 아니라 형식 불량 판정으로도 후보를 걸러내지 않는다.
    const expiresAtMs = Date.parse(asString(data.expiresAtIso));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) continue;
    statuses.set(email, status as MailDeliverabilityStatus);
  }
  return statuses;
}
