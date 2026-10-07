import { asRecord, assertNonGuestAuth, makeBehaviorLog } from "./shared";
import type { CallableRequestShape } from "./shared";
import { runVideoReviewBacktest } from "./videoReviewBacktestService";
import { assertScpEntitled } from "./mailAccounts";

type RunVideoReviewBacktestEnvelope = Awaited<ReturnType<typeof runVideoReviewBacktest>> & {
  ok: true;
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;

export async function runVideoReviewBacktestCallable(request: CallableRequestShape): Promise<RunVideoReviewBacktestEnvelope> {
  const auth = assertNonGuestAuth(request, "video_review_backtest.run", WRITE_ROLES);
  // 2026-09-27 codex adversarial review round 4 FAIL-2: manual-trigger-only scp review AI backtest
  // tool (no scheduled caller) — role alone let a non-entitled manager/admin invoke it directly.
  await assertScpEntitled(auth, request, "video_review_backtest.run");
  const input = asRecord(request.data);
  try {
    const result = await runVideoReviewBacktest({
      spreadsheetId: input.spreadsheetId,
      tabName: input.tabName,
      startRow: input.startRow,
      rows: input.rows,
      predictionsBefore: input.predictionsBefore,
      predictionsAfter: input.predictionsAfter,
      dryRun: input.dryRun,
      judgeMissing: input.judgeMissing,
      nowIso: input.nowIso,
      requestedBy: auth.userId,
    });
    return {
      ok: true,
      ...result,
      behaviorLog: makeBehaviorLog(auth, "video_review_backtest.run", "success", "scp-automation"),
    };
  } catch (error) {
    if (error && typeof error === "object" && !("behaviorLog" in error)) {
      Object.assign(error, {
        behaviorLog: makeBehaviorLog(auth, "video_review_backtest.run", "blocked", "scp-automation"),
      });
    }
    throw error;
  }
}
