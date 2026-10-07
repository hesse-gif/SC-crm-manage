// 운영 스냅샷의 "식별자 충돌 검토 필요" 배너 상세 문구.
//
// 예전에는 전역 불리언 한 줄만 떠서, 운영자가 Firestore 를 직접 뒤지지 않으면 어떤 프로그램이
// 충돌인지 특정할 방법이 없었다(행동 불가능한 경고). 서버는 이미 `conflictSummaries` 로
// `{conflictType, canonicalProgramId, sourceCount}` 를 실어 보내고 있고
// (functions/operationalSnapshot.ts summarizeOperationalIdentityConflicts), 클라이언트도
// use-operational-snapshot.ts partialDetailsFromWire 에서 그대로 통과시키고 있었다 —
// 화면만 안 쓰고 있었다. 강한 별칭은 해시로만 오므로(개인정보 비노출) 여기서도 프로그램 ID·
// 충돌 유형·건수까지만 적는다.
//
// 별칭 등록이 필요한 쌍인지 그냥 유령 문서인지의 판단은 사람 몫이라, 화면은 "어디를 보라"까지만
// 말하고 문서를 지우거나 숨기지 않는다.

type ConflictSummaryLike = Record<string, unknown>;

type SnapshotConflictDetailsLike = {
  partialReasons?: readonly string[];
  conflictSummaries?: readonly ConflictSummaryLike[];
};

const MAX_LISTED_PROGRAMS = 5;

// #10 (2026-09-05 Aside 실측): 이 함수는 예전에 `conflictSummaries` 항목 수를 그대로 "건"으로
// 셌다 — 같은 충돌 클러스터(같은 hashedStrongAlias)가 배열에 두 번 이상 실리면(재빌드·라운드
// 재계산 등으로) 실제로는 하나인 충돌이 "2건"으로 부풀려졌다. 여기서는
// `functions/operationalSnapshot.ts summarizeOperationalIdentityConflicts` 가 클러스터당 실어
// 보내는 `hashedStrongAlias`(클러스터 식별자, 해시라 원문 비노출)로 먼저 중복 제거하고,
// 그 클러스터가 실제로 묶은 소스 문서 수(`sourceCount`)를 합산해 보여준다 — "2건" 같은
// 애매한 숫자 대신 "충돌 클러스터 N개 · 소스 문서 M개"로 규모를 밝힌다.
//
// 주의: 어떤 식별자 축(leadId/creatorId 등)이 충돌했는지는 서버가 아직 클러스터별로 실어
// 보내지 않는다(`conflictType`은 "unsafe_strong_collision" 처럼 구조적 분류만 담고, leadId 축과
// creatorId 축 충돌이 같은 값으로 나온다) — 축 표시는 서버 스키마 확장이 필요해 이 클라이언트
// 전용 수정 범위 밖이다.
export function snapshotIdentityConflictDetail(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const details = snapshot as SnapshotConflictDetailsLike;
  const reasons = Array.isArray(details.partialReasons) ? details.partialReasons : [];
  if (!reasons.includes("identity_conflict")) return null;
  const summaries = Array.isArray(details.conflictSummaries) ? details.conflictSummaries : [];
  if (summaries.length === 0) return null;

  type ClusterEntry = { sourceCount: number; types: Set<string> };
  const clustersByProgram = new Map<string, Map<string, ClusterEntry>>();
  let unkeyedSequence = 0;
  for (const summary of summaries) {
    const rawProgramId = typeof summary.canonicalProgramId === "string" ? summary.canonicalProgramId.trim() : "";
    const programId = rawProgramId || "귀속 미확인";
    const hashedStrongAlias = typeof summary.hashedStrongAlias === "string" ? summary.hashedStrongAlias.trim() : "";
    // 클러스터 식별자가 없는(구버전 서버) 항목은 서로 다른 클러스터로 본다 — 잘못 합쳐 실제
    // 충돌 규모를 과소 표시하는 쪽보다, 식별 못 한 항목을 안 합치는 쪽이 안전하다.
    unkeyedSequence += 1;
    const clusterKey = hashedStrongAlias || `__unkeyed_${unkeyedSequence}`;
    const sourceCount = typeof summary.sourceCount === "number" && Number.isFinite(summary.sourceCount)
      ? Math.max(0, Math.trunc(summary.sourceCount))
      : 0;
    const conflictType = typeof summary.conflictType === "string" ? summary.conflictType.trim() : "";

    const clusters = clustersByProgram.get(programId) ?? new Map<string, ClusterEntry>();
    const existing = clusters.get(clusterKey);
    if (existing) {
      // 같은 클러스터가 두 번 이상 실리면 같은 소스 문서 집합을 다시 세는 것이다 — 더하지 않고
      // 지금까지 관측된 값 중 큰 쪽을 쓴다(정상 상태면 항상 같은 값).
      existing.sourceCount = Math.max(existing.sourceCount, sourceCount);
      if (conflictType) existing.types.add(conflictType);
    } else {
      clusters.set(clusterKey, { sourceCount, types: new Set(conflictType ? [conflictType] : []) });
    }
    clustersByProgram.set(programId, clusters);
  }

  const perProgram = [...clustersByProgram.entries()].map(([programId, clusters]) => {
    const totalSourceCount = [...clusters.values()].reduce((sum, entry) => sum + entry.sourceCount, 0);
    const types = new Set<string>();
    for (const entry of clusters.values()) for (const type of entry.types) types.add(type);
    return { programId, clusterCount: clusters.size, totalSourceCount, typesLabel: [...types].sort().join("/") };
  });

  const listed = perProgram
    .sort((left, right) => right.totalSourceCount - left.totalSourceCount || left.programId.localeCompare(right.programId))
    .slice(0, MAX_LISTED_PROGRAMS)
    .map(({ programId, clusterCount, totalSourceCount, typesLabel }) => (
      `${programId} 충돌 클러스터 ${clusterCount}개 · 소스 문서 ${totalSourceCount.toLocaleString("ko-KR")}개${typesLabel ? ` (${typesLabel})` : ""}`
    ));
  const remaining = perProgram.length - listed.length;
  return `충돌 레코드: ${listed.join(" · ")}${remaining > 0 ? ` 외 ${remaining}개 프로그램` : ""}`;
}
