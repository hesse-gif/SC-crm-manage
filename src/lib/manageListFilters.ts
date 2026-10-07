// 관리 목록 필터의 선택지 유도 + 적용 규칙.
//
// 2026-07-26 감사: 담당자·지역·가이드 상태 선택지가 실데이터에 하나도 없는 하드코딩 값이라
// 세 필터가 항상 0건이었고, 가이드는 한글 라벨을 영문 enum(within/near/over)과 비교해서
// 어떤 선택지도 참이 될 수 없었다. 규칙을 화면 밖으로 꺼내 실제 동작을 테스트로 고정한다.
import type { Creator, GuideStatus } from "./data";
// 국가 해석은 정본 해석기(functions/creatorCountryProjection)만 쓴다. 2자 코드가 아니면
// 통과시키지 않는다 — "United Kingdom" → "UN" 같은 날조를 막기 위한 규칙이다.
import { resolveCreatorCountryProjection } from "../../functions/creatorCountryProjection.ts";

export const OWNER_UNASSIGNED_LABEL = "미지정";

export const GUIDE_LABEL_BY_KEY: Record<GuideStatus, string> = {
  within: "가이드 내",
  near: "상한 근접",
  over: "가이드 초과",
};

const GUIDE_FILTER_ORDER: readonly GuideStatus[] = ["within", "near", "over"];

export interface ManageListFilterOptions {
  platforms: string[];
  countries: string[];
  guide: Array<{ key: GuideStatus; label: string }>;
  owners: string[];
}

export interface ManageListFilterState {
  stages: string[];
  platforms: string[];
  /** 저장 값 그대로의 2자 국가 코드(KR/US/…). 예전 "서울/경기/부산/해외" 라벨이 아니다. */
  countries: string[];
  /** 저장 값 그대로의 guideStatus enum(within/near/over). */
  guide: string[];
  /** ownerDisplayProjection 이 해석한 담당자 표시명. */
  owners: string[];
  aiOnly: boolean;
}

export const EMPTY_MANAGE_LIST_FILTERS: ManageListFilterState = {
  stages: [],
  platforms: [],
  countries: [],
  guide: [],
  owners: [],
  aiOnly: false,
};

export function creatorCountryCode(creator: Creator): string {
  return resolveCreatorCountryProjection(creator as unknown as Record<string, unknown>).code ?? "";
}

export function creatorOwnerLabel(creator: Creator): string {
  return creator.ownerDisplayName || OWNER_UNASSIGNED_LABEL;
}

function isGuideStatus(value: unknown): value is GuideStatus {
  return value === "within" || value === "near" || value === "over";
}

/** 선택지는 로드된 행에서만 유도한다 — 실데이터에 없는 값을 고를 수 있게 두지 않는다. */
export function buildFilterOptions(creators: readonly Creator[]): ManageListFilterOptions {
  const platforms = new Set<string>();
  const countries = new Set<string>();
  const guide = new Set<GuideStatus>();
  const owners = new Set<string>();
  for (const creator of creators) {
    if (creator.platform) platforms.add(creator.platform);
    const country = creatorCountryCode(creator);
    if (country) countries.add(country);
    if (isGuideStatus(creator.guideStatus)) guide.add(creator.guideStatus);
    owners.add(creatorOwnerLabel(creator));
  }
  return {
    platforms: [...platforms].sort(),
    countries: [...countries].sort(),
    guide: GUIDE_FILTER_ORDER.filter((key) => guide.has(key)).map((key) => ({ key, label: GUIDE_LABEL_BY_KEY[key] })),
    owners: [...owners].sort((left, right) =>
      left === OWNER_UNASSIGNED_LABEL ? 1 : right === OWNER_UNASSIGNED_LABEL ? -1 : left.localeCompare(right),
    ),
  };
}

/**
 * 필터 적용. 칩 라벨이 아니라 저장 값과 비교한다(가이드 상태는 enum, 국가는 2자 코드,
 * 담당자는 해석된 표시명).
 */
export function applyManageListFilters(
  creators: readonly Creator[],
  filters: ManageListFilterState,
  stageKeyByLabel: Record<string, string>,
): Creator[] {
  let list = [...creators];
  if (filters.stages.length > 0) {
    const stageKeys = filters.stages.map((stage) => stageKeyByLabel[stage] ?? stage);
    list = list.filter((creator) => stageKeys.includes(creator.stage));
  }
  if (filters.platforms.length > 0) {
    list = list.filter((creator) => filters.platforms.includes(creator.platform ?? ""));
  }
  if (filters.countries.length > 0) {
    list = list.filter((creator) => filters.countries.includes(creatorCountryCode(creator)));
  }
  if (filters.guide.length > 0) {
    list = list.filter((creator) => filters.guide.includes(creator.guideStatus));
  }
  if (filters.owners.length > 0) {
    list = list.filter((creator) => filters.owners.includes(creatorOwnerLabel(creator)));
  }
  if (filters.aiOnly) {
    list = list.filter((creator) => creator.aiHandling);
  }
  return list;
}

export function activeFilterCount(filters: ManageListFilterState): number {
  return (
    filters.stages.length
    + filters.platforms.length
    + filters.countries.length
    + filters.guide.length
    + filters.owners.length
    + (filters.aiOnly ? 1 : 0)
  );
}
