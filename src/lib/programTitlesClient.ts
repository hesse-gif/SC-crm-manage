// 클라이언트가 읽는 프로그램 타이틀 레지스트리.
//
// 정본은 `functions/programTitles.seed.json` **하나뿐**이다. 이 모듈은 그 JSON 을 그대로 import 해서
// 화면이 필요한 모양으로만 좁혀 준다 — 사본을 만들지 않는다(사본은 반드시 갈린다).
// `functions/programTitles.ts` 는 서버 전용 로직(오버라이드 파싱·해시태그 조립)을 갖고 있어
// 그 **타입스크립트 모듈**은 별도 빌드 루트라 import 하지 않지만, JSON 은 데이터라 그 문제가 없다.
//
// ⭐ 하드 룰(레지스트리와 동일): 타이틀별 분기 금지. 화면은 이 목록을 순회할 뿐이고,
//    타이틀 추가는 `programTitles.seed.json` 항목 1개로 끝난다.

import registry from "../../functions/programTitles.seed.json";
import { canonicalScpProgramId, normalizeScpProgramId } from "./scp-program-alias";

export type ClientProgramTitle = {
  id: string;
  name: string;
  storeUrl: string;
  requiredHashtag: string;
  guidebookUrl?: string;
  default?: boolean;
};

type SeedProgram = {
  programId: string;
  requiredProgramHashtags?: string[];
  titles: ClientProgramTitle[];
};

const PROGRAMS: readonly SeedProgram[] = ((registry as { programs?: SeedProgram[] }).programs ?? []);

/**
 * 프로그램의 타이틀 목록. 등록되지 않은 프로그램은 SCP 프로그램으로 떨어진다 —
 * 검수 루브릭(functions/videoReviewCriteria.videoReviewRubricTitle)과 **같은 폴백**이다.
 * 타이틀별 분기가 아니라 "프로그램 미등록"에 대한 단일 폴백.
 */
export function clientProgramTitles(programId?: string): readonly ClientProgramTitle[] {
  const canonical = normalizeScpProgramId(typeof programId === "string" ? programId : "");
  const scoped = PROGRAMS.find((program) => program.programId === canonical);
  if (scoped && scoped.titles.length > 0) return scoped.titles;
  return PROGRAMS.find((program) => program.programId === canonicalScpProgramId)?.titles ?? [];
}

/** 기본 타이틀(`default: true`, 없으면 첫 항목). 등록된 타이틀이 없으면 null. */
export function clientDefaultProgramTitle(programId?: string): ClientProgramTitle | null {
  const titles = clientProgramTitles(programId);
  return titles.find((title) => title.default === true) ?? titles[0] ?? null;
}

/**
 * id(또는 사람이 읽는 이름)로 타이틀을 찾고, 못 찾으면 기본 타이틀로 착지한다.
 * 2026-09-05 P1 리뷰 수리: 서버 `normalizeProgramTitleId`(functions/programTitles.ts)와 같은
 * "뭉친" 비교(구분자를 전부 지운 형태, 예: "XPHero" -> "xphero")도 받는다 — 이 자리가 그 매칭
 * 만 빠진 부분 사본이었다.
 */
export function clientResolveProgramTitle(
  programId: string | undefined,
  raw: unknown,
): ClientProgramTitle | null {
  const text = typeof raw === "string" ? raw.trim().toLowerCase().replace(/[\s_]+/g, "-") : "";
  if (!text) return clientDefaultProgramTitle(programId);
  const squashed = text.replace(/-/g, "");
  const titles = clientProgramTitles(programId);
  return titles.find((title) => {
    const nameNormalized = title.name.toLowerCase().replace(/[\s_]+/g, "-");
    return title.id === text
      || nameNormalized === text
      || title.id.replace(/-/g, "") === squashed
      || nameNormalized.replace(/-/g, "") === squashed;
  }) ?? clientDefaultProgramTitle(programId);
}

/**
 * 캠페인 id·태스크 content_type 처럼 **식별자에 쓰는 타이틀 조각**.
 * 사람이 읽는 이름을 그대로 쓰면 공백·대소문자가 섞이므로 레지스트리 id 를 쓴다
 * (`xp-hero` → `xp_hero`). 등록된 타이틀이 없으면 프로그램 중립값으로 떨어진다.
 */
export function clientProgramTitleSlug(title: ClientProgramTitle | null): string {
  const id = title?.id?.trim() ?? "";
  return id ? id.replace(/-/g, "_") : "scp";
}
