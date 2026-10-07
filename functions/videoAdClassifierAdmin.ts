// /admin/verify 광고분류 수동 트리거 + 온디맨드. RBAC: manager+ 서버검증. 에뮬레이터=규칙 폴백(LLM 미호출),
//   prod=실 LLM(callModel 캐시선행 + usage 로그). SEC-P0-004: 클라 직접쓰기 금지 → 이 콜러블 경유.
//   data.videoId 있으면 단일 영상 분류, 없으면 adClassificationPending 큐 배치 소진.
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { processVideoAdClassificationQueue, runAdClassificationForVideo } from "./videoAdClassifier";

const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;

function useLlm(): boolean {
  return process.env.FUNCTIONS_EMULATOR !== "true" && !process.env.FIRESTORE_EMULATOR_HOST;
}

export async function classifyFeedVideoAds(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "video_ad_classification.run", WRITE_ROLES);
  const data = asRecord(request.data);
  const videoId = asString(data.videoId);
  const limit = typeof data.limit === "number" ? Math.max(1, Math.min(50, data.limit)) : undefined;

  if (videoId) {
    const result = await runAdClassificationForVideo(videoId, { useLlm: useLlm() });
    return { ok: result.ok, mode: "single" as const, videoId, classification: result.classification, reason: result.reason ?? null, behaviorLog: makeBehaviorLog(auth, "video_ad_classification.run.single", result.ok ? "success" : "mock") };
  }

  const result = await processVideoAdClassificationQueue({ useLlm: useLlm(), limit });
  return { ok: result.ok, mode: "queue" as const, scanned: result.scanned, classified: result.classified, failed: result.failed, behaviorLog: makeBehaviorLog(auth, "video_ad_classification.run.queue", "success") };
}
