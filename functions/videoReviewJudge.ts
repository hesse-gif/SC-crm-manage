import { asRecord, assertNonGuestAuth, makeBehaviorLog } from "./shared";
import type { CallableRequestShape } from "./shared";
import { runVideoReviewJudge } from "./videoReviewJudgeService";
import { assertScpEntitled } from "./mailAccounts";

type JudgeVideoReviewEnvelope = Awaited<ReturnType<typeof runVideoReviewJudge>> & {
  ok: true;
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;

export async function judgeVideoReview(request: CallableRequestShape): Promise<JudgeVideoReviewEnvelope> {
  const auth = assertNonGuestAuth(request, "video_review_judge.judge_submissions", WRITE_ROLES);
  // 2026-09-27 codex adversarial review round 4 FAIL-2: this AI judge tool is scp-only (/flu/scp
  // review workspace); role alone let a non-entitled manager/admin invoke it directly. The
  // scheduled drain (videoReviewAutomationOutbox.ts) calls runVideoReviewJudge (the core function)
  // directly, never this public callable, so it is unaffected.
  await assertScpEntitled(auth, request, "video_review_judge.judge_submissions");
  const input = asRecord(request.data);
  try {
    const result = await runVideoReviewJudge({
      submissionIds: input.submissionIds,
      submissionRefs: input.submissionRefs,
      submissions: input.submissions,
      dryRun: input.dryRun,
      nowIso: input.nowIso,
      requestedBy: auth.userId,
      requestedRole: auth.role,
      requestedTeam: auth.team,
    });
    return {
      ok: true,
      ...result,
      behaviorLog: makeBehaviorLog(auth, "video_review_judge.judge_submissions", "success", "scp-automation"),
    };
  } catch (error) {
    if (error && typeof error === "object" && !("behaviorLog" in error)) {
      Object.assign(error, {
        behaviorLog: makeBehaviorLog(auth, "video_review_judge.judge_submissions", "blocked", "scp-automation"),
      });
    }
    throw error;
  }
}
