// 담당자 표시명의 정본 해석기.
//
// `creators.owner` 한 필드에 네 종류가 섞여 있다(2026-07-26 운영 실측 400건 표본):
// "ai-discovery" 315 · 없음 69 · "헤세" 10 · "시몬" 4 · Firebase UID "8Wxr…" 2.
// 화면마다 `owner ?? ownerUid ?? "-"` 같은 즉석 체인을 쓰면 관리 목록엔 UID 원문이 뜨고
// hover 엔 또 다른 값이 뜬다. 해석은 여기 한 곳에서만 한다.
//
// ⚠️ members 문서는 uid 로 저장된 것(PPotNUc3…)과 레거시 id 로 저장된 것(u1·u2·invite-*)이
// 섞여 있고, UID "8Wxr…" 는 **문서 id 가 아니라 members/u1.uid** 다(운영 실측). doc id 조인만
// 하면 그 UID 는 영영 안 붙는다 — docId·uid·email·name 네 축으로 색인해야 한다.
//
// 붙지 않으면 지어내지 않는다: UID·이메일·시스템 액터는 "미지정"으로 남긴다.

import { adminDb } from "./firebaseAdmin";

export const OWNER_DISPLAY_UNRESOLVED = "미지정";

/** 사람 담당자가 아닌 자동화 액터. 담당자 칸에 그대로 두면 사람 이름처럼 읽힌다. */
const SYSTEM_OWNER_TOKENS = new Set([
  "ai-discovery",
  "system",
  "auth.oncreate",
  "seed",
  "unassigned",
  "unknown",
  "none",
]);

/** Firebase UID 형태(길고 불투명한 토큰) — 사람에게 보여줄 이름이 아니다. */
const OPAQUE_IDENTITY = /^[A-Za-z0-9_-]{20,}$/;

// members 는 사내 인원 수만큼만 존재한다(운영 실측 14건). 상한은 폭주 방지용 캡이고,
// 실제 읽기는 존재하는 문서 수만큼이다.
const MEMBER_INDEX_LIMIT = 500;

// 크리에이터 목록은 한 화면에서 getDataset + listCreators 페이지네이션으로 여러 번 읽힌다.
// 매번 members 전체를 다시 읽지 않도록 프로세스 안에서 짧게 재사용한다. 담당자 이름이 바뀌면
// 최대 이 시간만큼 옛 이름이 보인다 — 표시명이라 허용 가능한 지연이고, 값을 복사해 저장하지는 않는다.
const OWNER_DISPLAY_INDEX_TTL_MS = 30_000;

let cachedIndex: { readonly at: number; readonly index: Promise<OwnerDisplayIndex> } | null = null;

/** 테스트에서 캐시 경계를 명시적으로 통제하기 위한 초기화 훅. */
export function resetOwnerDisplayIndexCache(): void {
  cachedIndex = null;
}

export type OwnerDisplayIndex = ReadonlyMap<string, string>;

export const EMPTY_OWNER_DISPLAY_INDEX: OwnerDisplayIndex = new Map();

function indexKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** members 스냅샷 → 조회 색인. docId·uid·email·name 을 모두 같은 표시명으로 접는다. */
export function buildOwnerDisplayIndex(
  members: Iterable<{ readonly id: string; readonly data: Record<string, unknown> }>,
): OwnerDisplayIndex {
  const index = new Map<string, string>();
  for (const member of members) {
    const displayName = typeof member.data.name === "string" ? member.data.name.trim() : "";
    if (!displayName) continue;
    for (const key of [member.id, member.data.uid, member.data.email, displayName]) {
      const normalized = indexKey(key);
      if (normalized && !index.has(normalized)) index.set(normalized, displayName);
    }
  }
  return index;
}

async function readOwnerDisplayIndex(): Promise<OwnerDisplayIndex> {
  const snapshot = await adminDb.collection("members").limit(MEMBER_INDEX_LIMIT).get();
  return buildOwnerDisplayIndex(
    snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() ?? {} })),
  );
}

/**
 * members 색인을 한 번만 만들고 짧게 재사용한다. 동시에 들어온 호출은 같은 in-flight 프라미스를
 * 공유하므로, 한 요청 안에서 이 함수를 여러 번 불러도 members 조회는 1회다.
 */
export function loadOwnerDisplayIndex(nowMs: number = Date.now()): Promise<OwnerDisplayIndex> {
  if (cachedIndex && nowMs - cachedIndex.at < OWNER_DISPLAY_INDEX_TTL_MS) {
    return cachedIndex.index;
  }
  const index = readOwnerDisplayIndex().catch((error) => {
    // 실패한 프라미스를 캐시에 남기면 TTL 동안 계속 같은 에러를 되돌려준다.
    cachedIndex = null;
    throw error;
  });
  cachedIndex = { at: nowMs, index };
  return index;
}

/** 담당자 토큰 1개 → 표시명. 못 붙는 신원(UID·이메일·시스템 액터)은 "미지정". */
export function resolveOwnerDisplayName(owner: unknown, index: OwnerDisplayIndex): string {
  const raw = typeof owner === "string" ? owner.trim() : "";
  if (!raw) return OWNER_DISPLAY_UNRESOLVED;
  const matched = index.get(raw.toLowerCase());
  if (matched) return matched;
  if (SYSTEM_OWNER_TOKENS.has(raw.toLowerCase())) return OWNER_DISPLAY_UNRESOLVED;
  if (raw.includes("@") || OPAQUE_IDENTITY.test(raw)) return OWNER_DISPLAY_UNRESOLVED;
  // members 에 없어도 사람이 읽을 수 있는 짧은 라벨이면 그대로 둔다(운영자가 손으로 적은 담당자).
  return raw;
}

/** 문서 1건 → 담당자 표시명. owner → ownerName → ownerUid → ownerEmail 순으로 본다. */
export function resolveOwnerDisplayForRecord(
  record: Record<string, unknown> | null | undefined,
  index: OwnerDisplayIndex,
): string {
  if (!record) return OWNER_DISPLAY_UNRESOLVED;
  for (const field of ["owner", "ownerName", "ownerUid", "ownerEmail"]) {
    const resolved = resolveOwnerDisplayName(record[field], index);
    if (resolved !== OWNER_DISPLAY_UNRESOLVED) return resolved;
  }
  return OWNER_DISPLAY_UNRESOLVED;
}
