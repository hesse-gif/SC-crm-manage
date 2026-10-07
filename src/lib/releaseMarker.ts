// 0a (2026-09-05 Aside 실측): 버전 배지가 "v0.6.62"만 보여주고 소스 커밋을 보여주지 않아
// 같은 버전 번호 아래 어느 배포인지 구분할 수 없었다.
//
// src/app/layout.tsx 가 이미 빌드타임에 `NEXT_PUBLIC_FLU_SOURCE_COMMIT` 을
// `data-flu-source-commit` 로 심어 prod smoke(scripts/prod-auth-smoke.mjs)가 읽는 값과 **같은**
// env var 를 재사용한다 — 새 서버 배선이 필요 없다. 화면에는 40자 전체 대신 사람이 읽는 축약
// 7자만 보여준다.
//
// 이 로직을 src/lib/appVersion.ts 에 두지 않는 이유: scripts/bump-app-version.mjs 가 매 릴리스마다
// 그 파일을 `export const APP_VERSION = "X.Y.Z";` 한 줄로 통째로 덮어쓴다(release-source-contract.mjs
// 계약은 그 한 줄만 정규식으로 찾으면 통과하지만, 실제 쓰기는 replace 다) — 여기 두면 다음 배포에서
// 조용히 사라진다.
export function shortSourceCommit(commit: string): string {
  const trimmed = commit.trim().toLowerCase();
  return /^[a-f0-9]{7,40}$/.test(trimmed) ? trimmed.slice(0, 7) : "";
}

export const APP_SOURCE_COMMIT_SHORT = shortSourceCommit(process.env.NEXT_PUBLIC_FLU_SOURCE_COMMIT ?? "");

/** 버전 배지에 실제로 그릴 문자열 — 커밋을 모르면(구버전 서버·로컬 미설정) 버전만 보여준다. */
export function appVersionLabel(version: string, sourceCommitShort: string): string {
  return sourceCommitShort ? `v${version} · ${sourceCommitShort}` : `v${version}`;
}
