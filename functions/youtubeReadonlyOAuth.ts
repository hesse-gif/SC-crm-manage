/**
 * Flu/Task-49 재리뷰 P1-3 — mail_oauth youtube.readonly 소비 헬퍼.
 *
 * functions/mailOAuth.ts의 beginMailOAuth는 비-growth 풀(드라마 등)에 한해 동의 시
 * `https://www.googleapis.com/auth/youtube.readonly`를 추가로 요청한다(mailOAuthScopeForPool).
 * 이 파일은 그 스코프로 실제 YouTube Data API를 호출하고, 그 호출을 **자격증명이 연결된 풀의
 * 원장에** 기록하는 경로다 — 이 티켓 시점엔 아직 실사용처(호출부)가 없지만("실사용처는 아직
 * 없어도 됨" — 재리뷰 지시), 나중에 붙는 소비자가 이 계상 로직을 다시 만들 필요가 없도록 미리
 * 마련해 둔다.
 *
 * getMailOAuthAccessToken이 반환하는 poolId(그 자격증명이 연결될 때 저장된 풀 — growth로 연결된
 * 계정은 항상 "growth")를 그대로 원장 poolId로 쓴다. 슬롯은 항상 0 — 이 경로는 mail_oauth 계정 1개당
 * 자체 OAuth 토큰 하나만 쓰는 소비자이지, functions/apiQuota.ts의 API-키 로테이션 축(여러 키를 슬롯
 * 0..N에 배정)과는 무관하다(functions/activityRefresh.ts의 youtubeGet도 같은 이유로 슬롯을 명시하지
 * 않는 호출은 0을 쓴다).
 */
import { getMailOAuthAccessToken, type GetMailOAuthAccessTokenDeps, type MailOAuthAccessToken } from "./mailOAuth";
import { recordYoutubeApiUnits } from "./apiQuota";

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

export type FetchYouTubeWithMailOAuthDeps = GetMailOAuthAccessTokenDeps & {
  readonly fetchImpl?: typeof fetch;
  readonly getAccessToken?: (accountId: string, deps: GetMailOAuthAccessTokenDeps) => Promise<MailOAuthAccessToken>;
  readonly recordUnits?: typeof recordYoutubeApiUnits;
};

/**
 * `accountId`(mail_accounts 문서 id)에 연결된 mail_oauth 자격증명의 access token으로 YouTube Data
 * API v3의 `resource`(예: "channels", "search")를 호출하고, 성공 시 그 자격증명의 poolId 원장에
 * 1콜을 기록한다(COST-P0-006). 토큰이 없거나(연결 안 됨/revoked) youtube.readonly 스코프 없이
 * 연결된 계정이면 getMailOAuthAccessToken/YouTube 쪽에서 그대로 에러가 올라간다 — 이 헬퍼는 그 위에
 * fail-open 폴백을 추가하지 않는다(호출자가 판단할 문제).
 */
export async function fetchYouTubeWithMailOAuth(
  accountId: string,
  resource: string,
  params: Record<string, string>,
  deps: FetchYouTubeWithMailOAuthDeps = {},
): Promise<Record<string, unknown>> {
  const doGetAccessToken = deps.getAccessToken ?? getMailOAuthAccessToken;
  const doFetch = deps.fetchImpl ?? fetch;
  const doRecordUnits = deps.recordUnits ?? recordYoutubeApiUnits;
  const token = await doGetAccessToken(accountId, deps);

  const url = new URL(`${YOUTUBE_API}/${resource}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  const response = await doFetch(url, {
    headers: { authorization: `Bearer ${token.accessToken}` },
    signal: AbortSignal.timeout(12_000),
  });
  const text = await response.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new Error(`youtube-readonly-${resource}-failed-${response.status}`);
  }
  // 슬롯 0 고정 — 위 파일 헤더 참고.
  await doRecordUnits(resource, 1, 0, token.poolId);
  return json;
}
