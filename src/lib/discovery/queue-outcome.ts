export const COMMUNITY_DISCOVERY_PARTIAL_WARNING =
  "부분 성공: YouTube 후보 탐색은 시작했지만 커뮤니티 탐색은 시작하지 못했습니다. YouTube 탐색 상태와 결과는 계속 확인합니다.";

export type DiscoveryQueueOutcome<TYoutube> =
  | {
      kind: "youtube-failed";
      error: unknown;
    }
  | {
      kind: "youtube-queued";
      youtubeRun: TYoutube;
      partialWarning: string | null;
    };

export function resolveDiscoveryQueueOutcome<TYoutube>(
  results: readonly [
    PromiseSettledResult<TYoutube>,
    PromiseSettledResult<unknown>,
  ],
): DiscoveryQueueOutcome<TYoutube> {
  const [youtube, community] = results;
  if (youtube.status === "rejected") {
    return {
      kind: "youtube-failed",
      error: youtube.reason,
    };
  }

  return {
    kind: "youtube-queued",
    youtubeRun: youtube.value,
    partialWarning: community.status === "rejected"
      ? COMMUNITY_DISCOVERY_PARTIAL_WARNING
      : null,
  };
}
