// 영상 분류(taxonomy) 클라이언트 사이드 접근자 — main/functions/videoTaxonomy.ts와 동일한
// TS 시드(functions/taxonomy/video-taxonomy.v1.ts)를 단일 소스로 참조한다(타입/데이터 중복 최소화).

import { videoTaxonomyV1 } from "../../../functions/taxonomy/video-taxonomy.v1";

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

const taxonomy = videoTaxonomyV1 as VideoTaxonomy;

export function allEntries(axis: TaxonomyAxis): TaxonomyEntry[] {
  return taxonomy.axes[axis] ?? [];
}

export function labelFor(axis: TaxonomyAxis, id: string): string {
  const entry = allEntries(axis).find((candidate) => candidate.id === id);
  return entry?.labelKo ?? id;
}

export function taxonomyVersion(): number {
  return taxonomy.version;
}
