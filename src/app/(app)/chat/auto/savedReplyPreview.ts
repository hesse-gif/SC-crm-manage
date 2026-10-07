import { previewChatAutoCaseReply } from "@/lib/data";

export type SavedReplyPreviewState = { state: "loading" | "ok" | "error"; text: string };

/** Server-resolved final outgoing body of a saved reply (the same resolver dispatch uses). Read-only. */
export async function fetchSavedReplyPreview(caseId: string, text: string): Promise<SavedReplyPreviewState> {
  try {
    const result = await previewChatAutoCaseReply({ caseId, text });
    return result.valid && result.resolvedText
      ? { state: "ok", text: result.resolvedText }
      : { state: "error", text: result.errorMessage ?? "" };
  } catch {
    return { state: "error", text: "" };
  }
}
