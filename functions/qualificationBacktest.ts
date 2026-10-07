import { asRecord, assertNonGuestAuth, makeBehaviorLog } from "./shared";
import type { CallableRequestShape } from "./shared";
import { runQualificationBacktest } from "./qualificationBacktestService";
import { assertScpEntitled } from "./mailAccounts";

type RunQualificationBacktestEnvelope = Awaited<ReturnType<typeof runQualificationBacktest>> & {
  ok: true;
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;

export async function runQualificationBacktestCallable(request: CallableRequestShape): Promise<RunQualificationBacktestEnvelope> {
  const auth = assertNonGuestAuth(request, "qualification_backtest.run_sheet2", WRITE_ROLES);
  // 2026-09-27 codex adversarial review round 2 sweep: this is the scp qualification review
  // sheet's (Sheet2) backtest harness — no general-purpose UI reaches it.
  await assertScpEntitled(auth, request, "qualification_backtest.run_sheet2");
  const input = asRecord(request.data);
  try {
    const result = await runQualificationBacktest({
      spreadsheetId: input.spreadsheetId,
      tabName: input.tabName,
      startRow: input.startRow,
      rows: input.rows,
      predictions: input.predictions,
      dryRun: input.dryRun,
      judgeMissing: input.judgeMissing,
      nowIso: input.nowIso,
      minPrecision: input.minPrecision,
      minLabelCount: input.minLabelCount,
      minAutoRejectCount: input.minAutoRejectCount,
      requestedBy: auth.userId,
    });
    return {
      ok: true,
      ...result,
      behaviorLog: makeBehaviorLog(auth, "qualification_backtest.run_sheet2", "success", "scp-automation"),
    };
  } catch (error) {
    if (error && typeof error === "object" && !("behaviorLog" in error)) {
      Object.assign(error, {
        behaviorLog: makeBehaviorLog(auth, "qualification_backtest.run_sheet2", "blocked", "scp-automation"),
      });
    }
    throw error;
  }
}
