/**
 * D1 — 후보의 Instagram 핸들 확보 (스캐폴드, 순수 함수 전용).
 *
 * instagramBusinessDiscovery.ts 의 business_discovery 조회는 **username(핸들)** 을 입력으로
 * 요구한다. 이 모듈은 그 핸들을 어디서 얻을지를 다룬다 — 네트워크 호출도 Firestore 접근도 하지
 * 않는 순수 함수만 둔다. 호출부(후속 배선)가 실제 문서/텍스트를 읽어서 넘긴다.
 *
 * ■ 스키마 실측 근거 (read-only, 2026-08-22)
 *   candidate_pool 스키마(discovery.ts `CandidateResult` 타입)와 creators 스키마(crm.ts
 *   `CreatorRecord` 타입)를 전수 확인한 결과 **instagramUrl/instagramHandle 류 필드가 없다.**
 *   반면 SCP 신청 파이프라인 스키마는 전부 `instagramUrl` 이름으로 이 값을 옮긴다 —
 *     · sheetIntakeTypes.ts  `ProgramSheetLeadApplicant.instagramUrl`
 *     · qualificationJudgeService.ts  `applicant.instagramUrl` / `lead.instagramUrl`
 *     · scpSheetReviewService.ts  row.instagramUrl
 *     · sheet3SubmissionBridge.ts  candidate.instagramUrl
 *   그래서 새 이름을 짓지 않고 이 컨벤션을 그대로 따른다. candidate_pool/creators 문서에 실제로
 *   이 필드가 채워지는 배선(신청 파이프라인 값을 candidate_pool 로 복사하는 것)은 이번 스캐폴드
 *   범위 밖이다(통합자 후속 작업).
 *
 *   "About/웹 enrich가 수집한 외부 링크"도 같은 방식으로 확인했다: discovery.ts 의 공개 웹 이메일
 *   백필(enrichCandidateViaPublicWeb / publicYoutubeUrls / fetchPublicYoutubeChannelText)은 YouTube
 *   about 페이지 텍스트를 그 자리에서 이메일만 뽑고 버린다 — 링크 목록을 Firestore 에 남기는
 *   필드가 없다. 그래서 resolveInstagramHandleFromExternalLinks 는 특정 필드명에 묶이지 않고,
 *   호출부가 어디서 모았든 문자열 배열(URL 이든 그 URL 을 포함한 자유 텍스트든)을 넘기면 그 안에서
 *   instagram.com/{handle} 패턴을 찾는 범용 함수로 둔다 — "무엇을 모아서 넘길지"의 배선도 후속이다.
 *
 *   근거가 없으면 null 을 반환한다 — 지어내지 않는다.
 */

// instagram.com/xxx 형태지만 프로필이 아닌 예약 경로. IG 자체 기능 경로라 사용자명이 아니다.
const RESERVED_INSTAGRAM_PATHS = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct",
  "about", "developer", "legal", "privacy", "terms", "web", "embed", "graphql",
]);

const INSTAGRAM_HANDLE_CHARSET_PATTERN = /^[A-Za-z0-9._]{1,30}$/;
// (?<!...) 로 "fakeinstagram.com" 같은 비-IG 도메인의 서브스트링 오탐을 막는다 — instagram 앞에
// 영숫자가 붙어 있으면(다른 단어의 일부면) 매치하지 않는다.
const INSTAGRAM_URL_HANDLE_PATTERN = /(?<![a-z0-9])instagram\.com\/([a-z0-9._]{1,30})/i;

function normalizeInstagramHandleCandidate(raw: string): string | null {
  const trimmed = raw.trim().replace(/^@/, "").replace(/\.+$/, "");
  if (!trimmed || !INSTAGRAM_HANDLE_CHARSET_PATTERN.test(trimmed)) return null;
  const handle = trimmed.toLowerCase();
  return RESERVED_INSTAGRAM_PATHS.has(handle) ? null : handle;
}

/** URL 이든 자유 텍스트든, 그 안에서 첫 instagram.com/{handle} 패턴을 찾는다. 없으면 null. */
export function parseInstagramHandleFromUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = value.match(INSTAGRAM_URL_HANDLE_PATTERN);
  const raw = match?.[1];
  return raw ? normalizeInstagramHandleCandidate(raw) : null;
}

// candidate_pool/creators 문서에 (미래에) 이 값이 채워진다면 쓰일 이름들. 위 헤더 코멘트의 실측
// 근거대로 SCP 신청 파이프라인 컨벤션(instagramUrl)을 최우선으로 하고, 순수 핸들 별칭을 보조로 받는다.
const CANDIDATE_INSTAGRAM_FIELD_KEYS = ["instagramUrl", "instagramHandle", "instagram"] as const;

/** candidate_pool/creators 문서 형태의 레코드에서 이미 있는 IG 필드를 찾는다. 없으면 null. */
export function resolveInstagramHandleFromCandidateFields(
  candidate: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  if (!candidate) return null;
  for (const key of CANDIDATE_INSTAGRAM_FIELD_KEYS) {
    const value = candidate[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const fromUrl = parseInstagramHandleFromUrl(value);
    if (fromUrl) return fromUrl;
    // instagramHandle/instagram 필드는 URL 이 아니라 순수 핸들(@handle 또는 handle)로 들어올 수 있다.
    const bare = normalizeInstagramHandleCandidate(value);
    if (bare) return bare;
  }
  return null;
}

/** About/웹 enrich 가 모은 외부 링크(또는 자유 텍스트) 목록에서 첫 IG 핸들을 찾는다. 없으면 null. */
export function resolveInstagramHandleFromExternalLinks(links: readonly unknown[] | null | undefined): string | null {
  if (!links) return null;
  for (const link of links) {
    const handle = parseInstagramHandleFromUrl(link);
    if (handle) return handle;
  }
  return null;
}

/** candidate_pool 문서 필드 우선, 없으면 외부 링크로 폴백한다. 근거 없으면 null — 지어내지 않는다. */
export function resolveInstagramHandle(input: {
  readonly candidate?: Readonly<Record<string, unknown>> | null;
  readonly externalLinks?: readonly unknown[] | null;
}): string | null {
  return (
    resolveInstagramHandleFromCandidateFields(input.candidate) ??
    resolveInstagramHandleFromExternalLinks(input.externalLinks)
  );
}
