// 프로그램 타이틀 레지스트리 — "이 프로그램에서 만들 수 있는 게임 타이틀"의 단일 정본.
//
// 배경(2026-09-05 헤세 결정): Super Creator Partners 는 **다(多)타이틀 프로그램**이 됐다.
// 크리에이터는 XP Hero 또는 Snake Clash 콘텐츠를 만든다. 새 프로그램이 아니다 — 넛지 코호트,
// 콜드메일, 상한은 전부 프로그램 단위 그대로다.
//
// ⭐ 하드 룰: **타이틀별 분기 금지**. 어떤 소비자도 `if (gameId === "snake-clash")` 같은 코드를
// 쓰지 않는다. 전부 이 레지스트리를 순회한다. 타이틀 추가 = `programTitles.seed.json` 에 항목 1개
// 추가 + `npm run build:mail-templates` 실행. 그게 전부다.
//
// 이 모듈은 순수하다(Firestore·firebase-admin import 없음) — 노드 레인이 그대로 핀할 수 있다.
// 운영 오버라이드(어드민 편집 UI)는 `programTitlesStore.ts` 가 Firestore 문서를
// 읽어 `resolveProgramTitles(programId, override)` 로 주입한다. 소비자는 그대로다.

import seed from "./programTitles.seed.json";
import { canonicalScpProgramId, normalizeScpProgramId } from "./scpProgramAlias";

export const PROGRAM_TITLE_REGISTRY_VERSION = "program-titles/v1" as const;

/** 레지스트리에 실릴 수 있는 타이틀 id 형태 — 소문자 kebab-case. */
export const PROGRAM_TITLE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ProgramTitleSampleVideo = {
  /** 크리에이터에게 보이는 샘플 파일명/제목. */
  title: string;
  /** 샘플 영상의 YouTube 주소(watch/shorts/youtu.be 무관). */
  youtubeUrl: string;
};

export type ProgramTitle = {
  /** 제출·검수·포털이 공유하는 정본 식별자. */
  id: string;
  /** 사람이 읽는 게임명 — 메일 카피·검수 룰(R6)이 그대로 쓴다. */
  name: string;
  /** 이 타이틀의 공식 스토어 주소 — 검수 룰(R2)의 허용 목적지. */
  storeUrl: string;
  /** 이 타이틀 콘텐츠에 필수인 해시태그 — 검수 룰(R8). */
  requiredHashtag: string;
  /**
   * 이 타이틀 소유로 인정하는 추가 도메인(호스트네임, 소문자) — 검수 룰(R2)이 "배정된 정확한
   * 추적 링크는 아니지만 이 타이틀 소유가 분명한 링크"(예: OneLink/Adjust 브랜드 서브도메인)를
   * unclassified 로 잘못 분류하지 않게 한다. 값이 없으면 빈 배열 — 그 타이틀은 `storeUrl` 의
   * 앱 id(쿼리/경로)로만 자기 소유가 식별된다(functions/videoReviewEvidence.ts
   * canonicalStoreDestination). play.google.com/apps.apple.com 은 모든 타이틀이 공유하는
   * 호스트라서 여기 넣지 않는다 — bare 호스트 매칭은 타이틀을 구분하지 못한다.
   */
  brandedDomains?: readonly string[];
  /** 샘플 영상 원본 폴더(메일 "Download all samples"). */
  driveFolderUrl: string;
  /** 메일의 quick-watch 플레이리스트에 실리는 샘플들. */
  sampleVideos: readonly ProgramTitleSampleVideo[];
  /** 가이드북 링크(있으면 메일이 노출). */
  guidebookUrl?: string;
  /** 이 타이틀 전용 정책 버전(없으면 프로그램 기본 정책). */
  policyVersion?: string;
  /** gameId 가 없거나 미등록 값일 때 해석되는 기본 타이틀. 프로그램당 1개. */
  default?: boolean;
};

export type ProgramTitleRegistry = {
  /** canonical program id. */
  programId: string;
  /** 타이틀과 무관하게 항상 요구되는 프로그램 해시태그(검수 룰 R8). */
  requiredProgramHashtags: readonly string[];
  titles: readonly ProgramTitle[];
};

type SeedShape = {
  registryVersion: string;
  programs: ProgramTitleRegistry[];
};

const SEED = seed as unknown as SeedShape;

function frozenRegistry(value: ProgramTitleRegistry): ProgramTitleRegistry {
  return {
    programId: value.programId,
    requiredProgramHashtags: Object.freeze([...value.requiredProgramHashtags]),
    titles: Object.freeze(value.titles.map((title) => Object.freeze({
      ...title,
      brandedDomains: Object.freeze([...(title.brandedDomains ?? [])]),
      sampleVideos: Object.freeze(title.sampleVideos.map((sample) => Object.freeze({ ...sample }))),
    }))),
  };
}

/** 코드 시드(정본 기본값). 오버라이드가 없을 때 모든 소비자가 이 값을 본다. */
export const SEEDED_PROGRAM_TITLE_REGISTRIES: readonly ProgramTitleRegistry[] =
  Object.freeze(SEED.programs.map(frozenRegistry));

/** 등록된 프로그램이 하나도 매칭되지 않을 때의 빈 레지스트리(타이틀 없음). */
function emptyRegistry(programId: string): ProgramTitleRegistry {
  return frozenRegistry({ programId, requiredProgramHashtags: [], titles: [] });
}

/**
 * 프로그램의 타이틀 레지스트리를 해석한다.
 *
 * `override` 는 후속 슬라이스(어드민 편집 UI / Firestore `settings/program_titles`)가 넘기는
 * 운영 값이다. 형식이 유효하지 않으면 조용히 시드로 폴백한다 — 설정 오류가 검수·제출을 막지
 * 않는다(fail-open 은 여기서만 허용된다: 오버라이드 부재 = 오늘의 동작).
 */
export function resolveProgramTitles(programId: unknown, override?: unknown): ProgramTitleRegistry {
  const canonical = normalizeScpProgramId(typeof programId === "string" ? programId : "");
  const fromOverride = parseProgramTitleRegistry(override, canonical);
  if (fromOverride) return fromOverride;
  return SEEDED_PROGRAM_TITLE_REGISTRIES.find((entry) => entry.programId === canonical)
    ?? emptyRegistry(canonical);
}

/** 프로그램의 기본 타이틀(`default: true`, 없으면 첫 항목). 타이틀이 없으면 null. */
export function defaultProgramTitle(registry: ProgramTitleRegistry): ProgramTitle | null {
  return registry.titles.find((title) => title.default === true) ?? registry.titles[0] ?? null;
}

/**
 * 포털/레거시가 보낸 값을 레지스트리 타이틀 id 로 정규화한다.
 * id 그대로, 대소문자 무시, 공백/언더스코어 → 하이픈, 그리고 사람이 읽는 name 매칭까지 받는다
 * (포털이 현재 `gameName: "xp-hero"` 를 보내기 때문에 id 와 name 을 모두 수용해야 한다).
 *
 * 2026-09-05 포털 계약 정정: Sheet3(content_review) 의 `game_name` 열은 별도 `game_id` 열이 생기지
 * 않고 레지스트리 id 를 직접 담거나(예: "snake-clash"), 사람이 자유롭게 적은 표기("XP Hero",
 * "xp hero", 구분자 없는 "XPHero" 등)를 담는다. 그래서 구분자(공백/언더스코어/하이픈)를 전부 지운
 * "뭉친" 형태도 함께 비교한다 — 사람이 구분자를 어떻게 쓰든 같은 타이틀로 착지해야 한다.
 * 미등록/빈 값은 null — 호출부가 계약에 맞게 기본값으로 떨어뜨릴지 거부할지 결정한다.
 */
export function normalizeProgramTitleId(registry: ProgramTitleRegistry, raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim().toLowerCase().replace(/[\s_]+/g, "-") : "";
  if (!text) return null;
  const squashed = text.replace(/-/g, "");
  const match = registry.titles.find((title) => {
    const idNormalized = title.id;
    const nameNormalized = title.name.toLowerCase().replace(/[\s_]+/g, "-");
    return idNormalized === text
      || nameNormalized === text
      || idNormalized.replace(/-/g, "") === squashed
      || nameNormalized.replace(/-/g, "") === squashed;
  });
  return match ? match.id : null;
}

/** 정규화 + 기본값 폴백. 미등록 값도 기본 타이틀로 착지한다(기존 행의 오늘 동작 보존). */
export function resolveProgramTitle(registry: ProgramTitleRegistry, raw: unknown): ProgramTitle | null {
  const id = normalizeProgramTitleId(registry, raw);
  if (!id) return defaultProgramTitle(registry);
  return registry.titles.find((title) => title.id === id) ?? defaultProgramTitle(registry);
}

/**
 * 레지스트리에 없는 프로그램은 SCP 레지스트리로 읽는다. 오늘 검수 루브릭·메일 카피가 프로그램과
 * 무관하게 XP Hero 로 하드코딩돼 있었기 때문에, 등록 전까지 그 동작을 그대로 보존하는 단일
 * 폴백이다(타이틀별 분기가 아니다).
 */
export function resolveProgramTitlesOrDefault(programId: unknown, override?: unknown): ProgramTitleRegistry {
  const registry = resolveProgramTitles(programId, override);
  return registry.titles.length > 0 ? registry : resolveProgramTitles(canonicalScpProgramId, override);
}

/**
 * 제출이 선언한 게임 값을 레지스트리 id 로 확정한다 — 모든 인제스트 경로(포털 HTTP ingress,
 * v2 `video.submitted`, Sheet3 브리지)가 이 함수 하나만 쓴다.
 *
 * 계약:
 * - 정본 필드는 `gameId`(레지스트리 id). 레거시 포털은 `gameName`(현재 "xp-hero")을 보내고,
 *   Sheet3 는 B 열(게임명)을 보낸다 — id 든 사람이 읽는 이름이든 같은 정규화를 통과한다.
 * - 값이 없으면 프로그램 기본 타이틀로 착지한다(기존 행의 오늘 동작) — 단 그 `gameId` 는
 *   행의 주장이 아니라 **기본값 스탬프**라 `gameIdDefaulted: true` 를 함께 붙인다. strict
 *   게임 필터(functions/videoReviewGameFilter.ts)는 마커가 붙은 gameId 를 증거로 인정하지
 *   않는다 — 선언 없는 행이 기본 타이틀 버킷에 조용히 들어가는 것을 막기 위해서다.
 * - 값이 있는데 레지스트리에 없으면 **거부하지 않는다**: 기본 타이틀로 착지시키고
 *   `gameIdUnresolved: true`(+ `gameIdDefaulted: true` — 역시 스탬프다)를 붙여 사람
 *   게이트가 집도록 한다(레지스트리 편집이 배포보다 앞설 수 있으므로 수신 자체를 막으면
 *   제출이 유실된다).
 */
export type ResolvedSubmissionGameId = {
  gameId: string;
  gameIdUnresolved: boolean;
  /**
   * `gameId` 가 선언 해석이 아니라 기본값 폴백으로 스탬프됐음 — 선언 누락/빈 값과 미등록
   * 선언 모두 해당. 이 마커가 true 이면 `gameId` 는 "행의 게임 주장"이 아니라 채우기
   * 값이므로 strict 필터의 증거 집합에서 제외된다. merge/update 쓰기에서 키 누락은 stale
   * true 를 남기므로 선택 필드가 아니라 항상 명시 boolean 으로 싣는다.
   */
  gameIdDefaulted: boolean;
};

export function resolveSubmissionGameId(
  programId: unknown,
  declared: unknown,
  override?: unknown,
): ResolvedSubmissionGameId {
  const registry = resolveProgramTitlesOrDefault(programId, override);
  const fallback = defaultProgramTitle(registry);
  const raw = typeof declared === "string" ? declared.trim() : "";
  const id = normalizeProgramTitleId(registry, raw);
  if (id) return { gameId: id, gameIdUnresolved: false, gameIdDefaulted: false };
  return { gameId: fallback?.id ?? "", gameIdUnresolved: raw.length > 0, gameIdDefaulted: true };
}

/** 이 프로그램에서 이 타이틀이 아닌 나머지 타이틀들 — "다른 게임 링크 금지" 룰의 대상 집합. */
export function otherProgramTitles(registry: ProgramTitleRegistry, titleId: string): readonly ProgramTitle[] {
  return registry.titles.filter((title) => title.id !== titleId);
}

/** 카피용 이름 나열("XP Hero or Snake Clash"). 리터럴 열거 금지 — 항상 이 함수로 만든다. */
export function joinProgramTitleNames(titles: readonly ProgramTitle[], conjunction = "or"): string {
  const names = titles.map((title) => title.name).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} ${conjunction} ${names[names.length - 1]}`;
}

/** 이 타이틀 제출에 요구되는 해시태그 전체(프로그램 공통 + 타이틀). */
export function requiredHashtagsForTitle(registry: ProgramTitleRegistry, title: ProgramTitle): string[] {
  return [...registry.requiredProgramHashtags, title.requiredHashtag].filter(Boolean);
}

// ---- 오버라이드 파싱(운영 문서 → 레지스트리) --------------------------------
// 순수 함수라 store 없이도 테스트가 가능하다. 하나라도 규격을 어기면 전체를 버린다
// (부분 수용은 "어떤 타이틀은 정책이 없다"는 조용한 구멍을 만든다).

function textField(value: unknown, maxLength: number): string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength
    ? value.trim()
    : "";
}

function httpsUrl(value: unknown): string {
  const text = textField(value, 1_000);
  if (!text) return "";
  try {
    return new URL(text).protocol === "https:" ? text : "";
  } catch {
    return "";
  }
}

export function parseProgramTitleRegistry(value: unknown, canonicalProgramId: string): ProgramTitleRegistry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const programId = normalizeScpProgramId(textField(record.programId, 180) || canonicalProgramId);
  if (!programId || programId !== canonicalProgramId) return null;
  if (!Array.isArray(record.titles) || record.titles.length === 0) return null;

  const titles: ProgramTitle[] = [];
  for (const entry of record.titles) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    const id = textField(row.id, 60).toLowerCase();
    const name = textField(row.name, 120);
    const storeUrl = httpsUrl(row.storeUrl);
    const requiredHashtag = textField(row.requiredHashtag, 60);
    const driveFolderUrl = httpsUrl(row.driveFolderUrl);
    if (!PROGRAM_TITLE_ID_RE.test(id) || !name || !storeUrl || !requiredHashtag || !driveFolderUrl) return null;
    if (titles.some((title) => title.id === id)) return null;
    const samplesRaw = Array.isArray(row.sampleVideos) ? row.sampleVideos : [];
    const sampleVideos: ProgramTitleSampleVideo[] = [];
    for (const sample of samplesRaw) {
      if (!sample || typeof sample !== "object" || Array.isArray(sample)) return null;
      const sampleRow = sample as Record<string, unknown>;
      const sampleTitle = textField(sampleRow.title, 200);
      const youtubeUrl = httpsUrl(sampleRow.youtubeUrl);
      if (!sampleTitle || !youtubeUrl) return null;
      sampleVideos.push({ title: sampleTitle, youtubeUrl });
    }
    const guidebookUrl = httpsUrl(row.guidebookUrl);
    const policyVersion = textField(row.policyVersion, 120);
    // brandedDomains is optional (omitted rows fall back to storeUrl-only matching); if present,
    // every entry must be a clean hostname or the whole override is rejected (no partial accept).
    const brandedDomainsRaw = Array.isArray(row.brandedDomains) ? row.brandedDomains : [];
    const brandedDomains: string[] = [];
    for (const domain of brandedDomainsRaw) {
      const cleaned = textField(domain, 253).toLowerCase();
      if (!cleaned) return null;
      brandedDomains.push(cleaned);
    }
    titles.push({
      id,
      name,
      storeUrl,
      requiredHashtag,
      driveFolderUrl,
      sampleVideos,
      brandedDomains,
      ...(guidebookUrl ? { guidebookUrl } : {}),
      ...(policyVersion ? { policyVersion } : {}),
      ...(row.default === true ? { default: true } : {}),
    });
  }
  if (titles.filter((title) => title.default === true).length > 1) return null;

  const hashtags = Array.isArray(record.requiredProgramHashtags)
    ? record.requiredProgramHashtags.map((item) => textField(item, 60)).filter(Boolean)
    : [];
  return frozenRegistry({ programId, requiredProgramHashtags: hashtags, titles });
}
