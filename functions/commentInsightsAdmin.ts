// /admin/verify 댓글 인사이트 수동 트리거 — 시드 영상 1건의 저장된 댓글(creator_comments)을 로드해
//   analyzeVideoCommentInsights로 분석·저장. RBAC: manager+ 서버검증. 에뮬레이터는 정규식 폴백(LLM 미호출),
//   prod는 실 LLM(캐시선행). SEC-P0-004: 클라 Firestore 직접쓰기 금지 → 이 callable 경유.
import { adminDb } from "./firebaseAdmin";
import { assertNonGuestAuth, asRecord, asString, type CallableRequestShape } from "./shared";
import { analyzeVideoCommentInsights } from "./videoCommentAnalysisInline";
import type { CommentInput } from "./videoCommentAnalysis";

const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;

export async function runCommentInsightsForVideo(request: CallableRequestShape) {
  assertNonGuestAuth(request, "comment_insights.run_for_video", WRITE_ROLES);
  const data = asRecord(request.data);
  const videoId = asString(data.videoId);
  if (!videoId) throw Object.assign(new Error("videoId required"), { code: "invalid-argument", errorCode: "run_comment_insights_for_video_video_id_required" });

  const videoSnap = await adminDb.collection("videos").doc(videoId).get();
  if (!videoSnap.exists) throw Object.assign(new Error("video not found"), { code: "not-found", errorCode: "run_comment_insights_for_video_video_found" });
  const video = videoSnap.data() ?? {};
  const creatorId = asString(video.creatorId);

  const commentsSnap = await adminDb.collection("creator_comments").where("videoId", "==", videoId).limit(100).get();
  const comments: CommentInput[] = commentsSnap.docs
    .map((d) => {
      const c = d.data() ?? {};
      return { text: asString(c.text), author: asString(c.author), likeCount: typeof c.likeCount === "number" ? c.likeCount : 0 };
    })
    .filter((c) => c.text);
  const latest = commentsSnap.docs.reduce((m, d) => {
    const t = asString((d.data() ?? {}).time);
    return t > m ? t : m;
  }, "");

  const useLlm = process.env.FUNCTIONS_EMULATOR !== "true" && !process.env.FIRESTORE_EMULATOR_HOST;
  const result = await analyzeVideoCommentInsights(
    {
      videoId,
      creatorId,
      comments,
      commentCount: typeof video.comments === "number" ? video.comments : comments.length,
      latestCommentTimeIso: latest || undefined,
    },
    { analyzeOptions: { useLlm } },
  );

  return {
    ok: true as const,
    videoId,
    creatorId,
    analyzed: result.analyzed,
    reason: result.reason ?? null,
    commentCount: comments.length,
    insight: result.insight ?? null,
  };
}
