// Flu — 프로그램 소속 판정 정본 (U8, 2026-07-27).
//
// 캠페인 목록(/flu/campaigns)·프로그램 상세의 캠페인 보드·검수 프로그램 필터가 **같은 판정**을
// 쓴다. 판정이 두 벌이면 같은 캠페인이 한쪽에서는 유령 행으로, 다른 쪽에서는 모든 프로그램
// 필터를 통과하는 상태가 된다(cp-mqz667bhgy5x·cp2·cp3·cp4 전례).
//
// 판정 규칙:
// - 프로그램 범위를 요청하지 않았으면(program·rawProgramId 둘 다 없음) 전부 통과한다.
// - programId 가 없는 행은 어떤 프로그램 필터도 통과하지 않는다. "미지정"은 "전부"가 아니다.
// - 신원 토큰 = 요청 raw id · program.id · program.slug + 각각의 `pg-` 접두 제거 변형.
//   빈 토큰은 버린다(slug 가 없는 프로그램에서 `includes("")` 가 모든 캠페인을 통과시키던 결함).
// - 매칭은 토큰과 정확히 같거나 `<token>-` 로 시작하는 파생 id 만 인정한다. 부분 문자열
//   포함(`includes`)과 첫 낱말 토큰은 쓰지 않는다 — `pg-xphero-legacy` 가
//   `pg-xphero-creator-challenge` 필터를 통과하고 `pg-supercent-official` 이
//   `pg-super-creator-partners` 필터를 통과하는 교차 유출의 원인이었다.
//
// `resolveProgramContext` 는 URL 파라미터 하나로 프로그램 **한 건을 고르는** 탐색이므로 첫 낱말
// 토큰까지 쓰는 기존 퍼지 탐색을 그대로 유지한다(소속 판정과 목적이 다르다).

import type { Campaign, Program } from "./types";

export function normalizeProgramScopeToken(value?: string | null): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function programSearchTokens(programId: string | null): string[] {
  const normalized = normalizeProgramScopeToken(programId);
  if (!normalized) return [];
  const withoutPrefix = normalized.replace(/^pg-/, "");
  const head = withoutPrefix.split("-").filter(Boolean)[0] ?? "";
  return Array.from(new Set([normalized, withoutPrefix, head].filter((token) => token.length > 1)));
}

export function resolveProgramContext(programs: Program[], rawProgramId: string | null): Program | null {
  const tokens = programSearchTokens(rawProgramId);
  if (tokens.length === 0) return null;

  const exact = programs.find((program) => {
    const id = normalizeProgramScopeToken(program.id);
    const slug = normalizeProgramScopeToken(program.slug);
    return tokens.some((token) => token === id || token === slug);
  });
  if (exact) return exact;

  return programs.find((program) => {
    const searchable = [
      program.id,
      program.slug,
      program.title,
      program.gameTitle,
      ...program.tags,
    ].map(normalizeProgramScopeToken);
    return tokens.some((token) => searchable.some((value) => value.includes(token) || token.includes(value)));
  }) ?? null;
}

function programIdentityTokens(program: Program | null, rawProgramId: string | null): string[] {
  const tokens = new Set<string>();
  for (const value of [rawProgramId, program?.id, program?.slug]) {
    const normalized = normalizeProgramScopeToken(value);
    if (normalized) tokens.add(normalized);
  }
  for (const token of [...tokens]) {
    const withoutPrefix = token.replace(/^pg-/, "");
    if (withoutPrefix) tokens.add(withoutPrefix);
  }
  return [...tokens];
}

/** 행에 붙은 programId 하나가 요청된 프로그램 범위에 속하는지. 캠페인·신청·대화 모두 이 판정 하나를 쓴다. */
export function programIdBelongsToProgram(
  candidateProgramId: string | null | undefined,
  program: Program | null,
  rawProgramId: string | null,
): boolean {
  if (!program && !rawProgramId) return true;
  const candidate = normalizeProgramScopeToken(candidateProgramId);
  if (!candidate) return false;
  const accepted = programIdentityTokens(program, rawProgramId);
  if (accepted.length === 0) return false;
  const candidates = [candidate, candidate.replace(/^pg-/, "")].filter(Boolean);
  return accepted.some((token) => candidates.some((value) => value === token || value.startsWith(`${token}-`)));
}

export function belongsToProgram(
  campaign: Pick<Campaign, "programId">,
  program: Program | null,
  rawProgramId: string | null,
): boolean {
  return programIdBelongsToProgram(campaign.programId, program, rawProgramId);
}
