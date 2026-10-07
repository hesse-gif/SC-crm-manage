// Task-58: /admin/integrations 의 조직 검색(OrgMultiPicker·RoutingOrgAdder)은 서버 콜러블
// searchPeoplyDirectory({kind:"orgs", q})를 그대로 렌더했다. 실제 매칭/랭킹은 이 저장소 밖 외부
// Peoply API가 수행하는데("Growth" 검색에 "User Acquisition"·"AI Drama" 같은 무관 조직이 섞여
// 나옴 — 0.6.73 Aside 관찰), 응답을 로컬에서 재필터링하는 코드가 없었다.
//
// 완전 무관해 보이는 결과만 제외하고, 이름은 무관해도 **상위 조직명**이 입력어와 일치하면 유지한다
// (Peoply가 상위 디비전 검색 시 그 하위 팀들을 함께 돌려주는 경우 — 이 경우까지 걷어내면 정상
// 매칭도 함께 잃는다). 부분일치를 너무 엄격하게 걸면 별칭·구 조직명 매칭 결과가 부당하게 걸러질 수
// 있어(완료 조건: 기존 정확 일치 검색은 회귀 없음), 이름 부분일치 우선 + 상위 조직명 폴백만 두고
// 그 외는 제외한다.
//
// 순수함수로 뽑는 이유: 클라이언트(OrgMultiPicker·RoutingOrgAdder)에서 그대로 쓰고, 서버
// functions/peoplyCallables.ts에도 최소 동등 로직을 넣는다 — 양쪽 다 진리표로 단정해야
// 회귀에 강하다(소스 문자열 검사는 이 레포에서 우회된 전례가 있다).

export type OrgLike = {
  id: string;
  name: string;
  parentId?: string | null;
};

export type OrgSearchMatch<T extends OrgLike> = {
  org: T;
  /**
   * "name": 조직명 자체가 입력어를 포함.
   * "parent": 조직명은 무관하지만 상위 조직명이 입력어를 포함(무관해 보이지 않도록 유지하되 구분).
   */
  matchedVia: "name" | "parent";
  parentName?: string;
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 조직 목록을 입력어 기준으로 방어적 재필터한다.
 * - 입력어가 비어 있으면(전체 조회) 필터하지 않는다.
 * - 조직명이 입력어를 부분일치로 포함하면 "name"으로 유지.
 * - 이름은 무관해도 상위 조직명(directory 또는 이번 배치에서 해석 가능한 경우)이 입력어를
 *   포함하면 "parent"로 유지.
 * - 둘 다 아니면 결과에서 제외한다.
 *
 * @param directory 누적 id→name 조회용(선택). 이번 배치의 조직 이름으로도 보강된다.
 */
export function filterOrgsByQuery<T extends OrgLike>(
  orgs: readonly T[],
  query: string,
  directory: Readonly<Record<string, string>> = {},
): OrgSearchMatch<T>[] {
  const needle = normalize(query);
  if (!needle) return orgs.map((org) => ({ org, matchedVia: "name" as const }));

  const batchDirectory: Record<string, string> = { ...directory };
  for (const org of orgs) batchDirectory[org.id] = org.name;

  const matches: OrgSearchMatch<T>[] = [];
  for (const org of orgs) {
    if (normalize(org.name).includes(needle)) {
      matches.push({ org, matchedVia: "name" });
      continue;
    }
    const parentName = org.parentId ? batchDirectory[org.parentId] : undefined;
    if (parentName && normalize(parentName).includes(needle)) {
      matches.push({ org, matchedVia: "parent", parentName });
    }
  }
  return matches;
}
