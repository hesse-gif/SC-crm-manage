// Flu — 서버측 프로그램 소속 판정 (R3, 2026-07-27). 순수 함수, 런타임 import 0.
//
// 클라이언트 정본은 `src/modules/programs/programScope.ts`(U8)다. 두 런타임(Next 앱 / Cloud Functions)은
// 서로의 모듈을 import 할 수 없으므로 판정 **규칙**을 이 파일에 같은 모양으로 둔다. 규칙이 갈리면
// 같은 행이 목록/보드/서버 필터에서 다르게 분류되므로, `tests/b2-universe-scope-boundary.test.mjs` 가
// **동일 픽스처 표를 양쪽 구현에 통과시켜 분류가 완전히 같은지** 검증한다(드리프트 게이트).
//
// 규칙(U8 그대로):
//  - 프로그램 범위를 요청하지 않았으면 전부 통과.
//  - programId 가 없는 행은 어떤 프로그램 필터도 통과하지 않는다("미지정"은 "전부"가 아니다).
//  - 신원 토큰 = 요청 id + `pg-` 접두 제거 변형. 빈 토큰은 버린다.
//  - 매칭은 정확히 같거나 `<token>-` 로 시작하는 파생 id 만. 부분 문자열 포함·첫 낱말 토큰 금지
//    (pg-xphero-legacy 가 pg-xphero-creator-challenge 필터를 통과하던 교차 유출 방지).

export function normalizeProgramScopeToken(value?: string | null): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function identityTokens(rawProgramId: string | null | undefined): string[] {
  const tokens = new Set<string>();
  const normalized = normalizeProgramScopeToken(rawProgramId);
  if (normalized) {
    tokens.add(normalized);
    const withoutPrefix = normalized.replace(/^pg-/, "");
    if (withoutPrefix) tokens.add(withoutPrefix);
  }
  return [...tokens];
}

/** 행에 붙은 programId 하나가 요청된 프로그램 범위에 속하는지. */
export function programIdBelongsToProgramScope(
  candidateProgramId: string | null | undefined,
  requestedProgramId: string | null | undefined,
): boolean {
  const requested = normalizeProgramScopeToken(requestedProgramId);
  if (!requested) return true;
  const candidate = normalizeProgramScopeToken(candidateProgramId);
  if (!candidate) return false;
  const accepted = identityTokens(requestedProgramId);
  if (accepted.length === 0) return false;
  const candidates = [candidate, candidate.replace(/^pg-/, "")].filter(Boolean);
  return accepted.some((token) => candidates.some((value) => value === token || value.startsWith(`${token}-`)));
}

/** 캠페인 범위는 정확 일치만(캠페인 id 는 파생 규칙이 없다). 요청이 없으면 전부 통과. */
export function campaignIdBelongsToCampaignScope(
  candidateCampaignId: string | null | undefined,
  requestedCampaignId: string | null | undefined,
): boolean {
  const requested = normalizeProgramScopeToken(requestedCampaignId);
  if (!requested) return true;
  return normalizeProgramScopeToken(candidateCampaignId) === requested;
}
