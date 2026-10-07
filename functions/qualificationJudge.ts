import { asRecord, assertNonGuestAuth, makeBehaviorLog } from "./shared";
import type { CallableRequestShape } from "./shared";
import { runQualificationJudge } from "./qualificationJudgeService";

type JudgeQualificationEnvelope = Awaited<ReturnType<typeof runQualificationJudge>> & {
  ok: true;
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;

export async function judgeQualification(request: CallableRequestShape): Promise<JudgeQualificationEnvelope> {
  const auth = assertNonGuestAuth(request, "qualification_judge.judge_program_sheet_leads", WRITE_ROLES);
  const input = asRecord(request.data);
  try {
    const result = await runQualificationJudge({
      leadIds: input.leadIds,
      leadRefs: input.leadRefs,
      leads: input.leads,
      dryRun: input.dryRun,
      nowIso: input.nowIso,
      finalVerdict: input.finalVerdict,
      finalReason: input.finalReason,
      overrideOfRef: input.overrideOfRef,
      requestedBy: auth.userId,
      requestedRole: auth.role,
      requestedTeam: auth.team,
      requestedEmail: auth.email,
      requestedName: auth.name,
      requestedGameId: auth.gameId,
      requestedIp: auth.ip,
    });
    return {
      ok: true,
      ...result,
      behaviorLog: makeBehaviorLog(auth, "qualification_judge.judge_program_sheet_leads", "success", "scp-automation"),
    };
  } catch (error) {
    if (error && typeof error === "object" && !("behaviorLog" in error)) {
      Object.assign(error, {
        behaviorLog: makeBehaviorLog(auth, "qualification_judge.judge_program_sheet_leads", "blocked", "scp-automation"),
      });
    }
    throw error;
  }
}
