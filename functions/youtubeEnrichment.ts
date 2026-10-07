import { asRecord, assertNonGuestAuth, makeBehaviorLog } from "./shared";
import type { CallableRequestShape } from "./shared";
import { enrichProgramSheetLeadYouTubeMetrics } from "./youtubeEnrichmentService";

type SyncYouTubeEnrichmentEnvelope = Awaited<ReturnType<typeof enrichProgramSheetLeadYouTubeMetrics>> & {
  ok: true;
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;

export async function syncYouTubeEnrichment(request: CallableRequestShape): Promise<SyncYouTubeEnrichmentEnvelope> {
  const auth = assertNonGuestAuth(request, "youtube_enrichment.sync_program_sheet_leads", WRITE_ROLES);
  const input = asRecord(request.data);
  try {
    const result = await enrichProgramSheetLeadYouTubeMetrics({
      leadIds: input.leadIds,
      leadRefs: input.leadRefs,
      leads: input.leads,
      dryRun: input.dryRun,
      nowIso: input.nowIso,
      requestedBy: auth.userId,
    });
    return {
      ok: true,
      ...result,
      behaviorLog: makeBehaviorLog(auth, "youtube_enrichment.sync_program_sheet_leads", "success", "scp-automation"),
    };
  } catch (error) {
    if (error && typeof error === "object" && !("behaviorLog" in error)) {
      Object.assign(error, {
        behaviorLog: makeBehaviorLog(auth, "youtube_enrichment.sync_program_sheet_leads", "blocked", "scp-automation"),
      });
    }
    throw error;
  }
}
