// 프로그램 타이틀 레지스트리의 운영 오버라이드 리더.
//
// 정본은 코드 시드(`programTitles.seed.json`)다. 이 모듈은 그 위에 **운영이 편집할 수 있는 한 겹**을
// 얹는다: Firestore `settings/program_titles` 문서의 `programs.<canonicalProgramId>` 가 유효한
// 레지스트리면 그 값을, 아니면 시드를 돌려준다. 어드민 편집 UI 는 후속 슬라이스지만 읽기 경로를
// 먼저 열어 두어, UI 가 붙을 때 소비자를 한 줄도 고치지 않게 한다.
//
// 비용/실패 규율: 프로세스 메모리에 짧은 TTL(60s)로 캐시한다. 문서 부재·문서 형식 오류는
// 시드로 폴백하지만, Firestore 읽기 장애는 운영 오버라이드 부재로 오인하지 않는다.
//
// 순수 해석은 전부 `programTitles.ts`(Firestore import 없음)에 있다. 이 모듈은 I/O 만 담당한다.

import { HttpsError } from "firebase-functions/v2/https";
import { adminDb } from "./firebaseAdmin";
import { canonicalScpProgramId, normalizeScpProgramId } from "./scpProgramAlias";
import { resolveProgramTitles, resolveProgramTitlesOrDefault, type ProgramTitleRegistry } from "./programTitles";

export const PROGRAM_TITLES_SETTINGS_COLLECTION = "settings";
export const PROGRAM_TITLES_SETTINGS_DOCUMENT = "program_titles";
const CACHE_TTL_MS = 60_000;

type CacheEntry = { expiresAtMs: number; overrides: Record<string, unknown> };
let cache: CacheEntry | null = null;

export const PROGRAM_TITLE_REGISTRY_UNAVAILABLE = "program_title_registry_unavailable" as const;

function programTitleRegistryUnavailable(error: unknown): HttpsError {
  return new HttpsError(
    "unavailable",
    "program title registry is unavailable",
    { errorCode: PROGRAM_TITLE_REGISTRY_UNAVAILABLE, causeCode: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null },
  );
}

/** 테스트/운영 핫픽스용 — 다음 호출이 문서를 다시 읽는다. */
export function resetProgramTitleOverrideCache(): void {
  cache = null;
}

async function readOverrides(now: number): Promise<Record<string, unknown>> {
  if (cache && cache.expiresAtMs > now) return cache.overrides;
  let snapshot: FirebaseFirestore.DocumentSnapshot;
  try {
    snapshot = await adminDb
      .collection(PROGRAM_TITLES_SETTINGS_COLLECTION)
      .doc(PROGRAM_TITLES_SETTINGS_DOCUMENT)
      .get();
  } catch (error) {
    throw programTitleRegistryUnavailable(error);
  }

  const data = snapshot.exists ? snapshot.data() ?? {} : {};
  const programs = (data as Record<string, unknown>).programs;
  const overrides = programs && typeof programs === "object" && !Array.isArray(programs)
    ? programs as Record<string, unknown>
    : {};
  cache = { expiresAtMs: now + CACHE_TTL_MS, overrides };
  return overrides;
}

/**
 * 프로그램의 타이틀 레지스트리(운영 오버라이드 우선, 없으면 코드 시드).
 * 소비자는 이 함수 하나만 부르면 되고, 오버라이드 저장소가 바뀌어도 시그니처는 그대로다.
 */
export async function loadProgramTitleRegistry(
  programId: unknown,
  now: Date = new Date(),
): Promise<ProgramTitleRegistry> {
  const canonical = normalizeScpProgramId(typeof programId === "string" ? programId : "");
  const overrides = await readOverrides(now.getTime());
  const scoped = resolveProgramTitles(canonical, overrides[canonical]);
  if (scoped.titles.length > 0) return scoped;
  return resolveProgramTitlesOrDefault(canonicalScpProgramId, overrides[canonicalScpProgramId]);
}
