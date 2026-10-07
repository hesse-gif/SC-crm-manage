// 영상 분류(taxonomy) 서버 사이드 로더 — TS 시드(taxonomy/video-taxonomy.v1.ts)가 단일 소스.
// 신규 enum은 골든셋(goldenSetCount>=5) 확보 전까지 activeEnumIds()에서 제외되어
// LLM 프롬프트/스키마에 노출되지 않는다(governance: docs/VIDEO-TAXONOMY.md 참고).

import { videoTaxonomyV1 } from "./taxonomy/video-taxonomy.v1";

export type TaxonomyAxis = "format" | "genreStyle" | "contentNature";

export type TaxonomyEntry = {
  id: string;
  labelKo: string;
  description: string;
  addedInVersion: number;
  goldenSetCount: number;
  active?: boolean;
};

export type VideoTaxonomy = {
  version: number;
  axes: Record<TaxonomyAxis, TaxonomyEntry[]>;
};

const TAXONOMY_AXES: readonly TaxonomyAxis[] = ["format", "genreStyle", "contentNature"];

export function loadTaxonomy(): VideoTaxonomy {
  return videoTaxonomyV1 as VideoTaxonomy;
}

export function taxonomyVersion(): number {
  return loadTaxonomy().version;
}

function isAxis(axis: string): axis is TaxonomyAxis {
  return (TAXONOMY_AXES as readonly string[]).includes(axis);
}

// 활성 enum 판정 규칙: active !== false 이면서, (골든셋 5건 이상 확보 || v1에서 추가된 항목).
// 즉 v1 이후 새로 추가된 enum은 골든셋이 쌓이기 전까지 활성 목록에서 빠진다.
export function activeEnumIds(axis: TaxonomyAxis): string[] {
  const taxonomy = loadTaxonomy();
  const entries = taxonomy.axes[axis] ?? [];
  return entries
    .filter((entry) => entry.active !== false && (entry.goldenSetCount >= 5 || entry.addedInVersion === 1))
    .map((entry) => entry.id);
}

export function isValidEnumId(axis: TaxonomyAxis | string, id: string): boolean {
  if (!isAxis(axis)) return false;
  return activeEnumIds(axis).includes(id);
}
