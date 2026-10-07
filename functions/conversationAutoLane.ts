/**
 * Flu F-7 (AUTO-MAIL-SAFETY-DESIGN-2026-09-16.md §B "①크로스레인 중복", §F-7) — thread ownership
 * lock: one `conversations/{id}` can only be actively worked by ONE auto lane at a time
 * (auto_reply · video_review_reject · resubmission_nudge · qualification_result). Without this,
 * nothing stopped e.g. auto_reply and Task-100's resubmission_nudge from both enqueueing a job for
 * the same conversation at the same time — the timeline gate (assertOutboundTimelineAllowed) only
 * covers conversationId-bearing mail paths, not cross-lane races in general.
 *
 * Storage: a single field on the conversation doc — `autoLaneOwner: { lane, jobRef, setAtIso }`.
 * No new collection, no new onSchedule (pin 42).
 *
 * Usage:
 *   - claimConversationAutoLane(conversationId, lane, jobRef): transactional. Fails closed with
 *     `{ ok:false, ownerLane }` when a DIFFERENT lane already owns the conversation (never
 *     overwrites another lane's claim). Re-claiming the SAME lane (e.g. a superseding auto_reply
 *     job replacing an earlier one) just refreshes jobRef/setAtIso and succeeds.
 *   - releaseConversationAutoLane(conversationId, lane, jobRef): transactional
 *     compare-and-delete — clears the field only when the current owner is exactly this
 *     (lane, jobRef); a job that finishes late after being superseded can never clobber the
 *     newer owner's claim. Tolerant of a missing conversation doc or an already-cleared field —
 *     always resolves, never throws (a lock release must never be the reason a terminal mail
 *     path fails).
 *
 * auto_reply (this file's only wired caller today) sets the field directly inside chat-ai.ts's
 * existing persistReceivedEmail batch at enqueue time (same atomic write as the rest of that
 * batch — see the `autoReplyStatus: "scheduled"` batch.set) rather than calling
 * claimConversationAutoLane, since a second transaction inside an already-open batch would break
 * that function's single-batch-commit shape; claimConversationAutoLane exists so lanes that don't
 * already hold an open batch at claim time (Task-94 video_review_reject / Task-95
 * qualification_result / Task-100 resubmission_nudge drains — not wired yet, built separately)
 * have one canonical, conflict-checked entry point. Release always goes through
 * releaseConversationAutoLane from every terminal chat-ai.ts auto_reply path (sent, failed,
 * expired, blocked-by-supersede, cancelled-by-human-takeover) — see chat-ai.ts call sites.
 */
import { adminDb } from "./firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { asRecord, asString } from "./shared";

export const CONVERSATION_AUTO_LANE_IDS = [
  "auto_reply",
  "video_review_reject",
  "resubmission_nudge",
  "qualification_result",
] as const;
export type ConversationAutoLane = (typeof CONVERSATION_AUTO_LANE_IDS)[number];

export type ConversationAutoLaneOwner = {
  lane: ConversationAutoLane;
  jobRef: string;
  setAtIso: string;
};

export type ClaimConversationAutoLaneResult =
  | { ok: true }
  | { ok: false; ownerLane: ConversationAutoLane };

const CONVERSATION_AUTO_LANE_ID_SET: ReadonlySet<string> = new Set(CONVERSATION_AUTO_LANE_IDS);

function isConversationAutoLane(value: unknown): value is ConversationAutoLane {
  return typeof value === "string" && CONVERSATION_AUTO_LANE_ID_SET.has(value);
}

function readAutoLaneOwner(data: Record<string, unknown> | undefined): ConversationAutoLaneOwner | null {
  const raw = asRecord(data?.autoLaneOwner);
  const jobRef = asString(raw.jobRef, "");
  if (!isConversationAutoLane(raw.lane) || !jobRef) return null;
  return { lane: raw.lane, jobRef, setAtIso: asString(raw.setAtIso, "") };
}

export async function claimConversationAutoLane(
  conversationId: string,
  lane: ConversationAutoLane,
  jobRef: string,
  nowIso: string = new Date().toISOString(),
): Promise<ClaimConversationAutoLaneResult> {
  const ref = adminDb.collection("conversations").doc(conversationId);
  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const owner = readAutoLaneOwner(snapshot.exists ? (snapshot.data() as Record<string, unknown>) : undefined);
    if (owner && owner.lane !== lane) {
      return { ok: false, ownerLane: owner.lane };
    }
    transaction.set(
      ref,
      { autoLaneOwner: { lane, jobRef, setAtIso: nowIso } },
      { merge: true },
    );
    return { ok: true };
  });
}

/**
 * The conversation patch that releases the auto-lane lock IF (and only if) it is owned by this lane + job — for callers
 * that must release it inside their OWN transaction (atomic cleanup) instead of the tolerant standalone release below.
 * Returns null when the lock is absent or owned by something else (nothing to release).
 */
export function autoLaneReleasePatchFor(
  conversationData: Record<string, unknown> | undefined,
  lane: ConversationAutoLane,
  jobRef: string,
): Record<string, unknown> | null {
  const owner = readAutoLaneOwner(conversationData);
  if (!owner || owner.lane !== lane || owner.jobRef !== jobRef) return null;
  return { autoLaneOwner: FieldValue.delete() };
}

export async function releaseConversationAutoLane(
  conversationId: string,
  lane: ConversationAutoLane,
  jobRef: string,
): Promise<void> {
  if (!conversationId || !jobRef) return;
  const ref = adminDb.collection("conversations").doc(conversationId);
  try {
    await adminDb.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return;
      const owner = readAutoLaneOwner(snapshot.data() as Record<string, unknown>);
      if (!owner || owner.lane !== lane || owner.jobRef !== jobRef) return;
      transaction.set(ref, { autoLaneOwner: FieldValue.delete() }, { merge: true });
    });
  } catch (error) {
    // 락 해제 실패가 발송/실패/만료 종결 자체를 막으면 안 된다 — 다음 claim이 owner를 다시
    // 읽어 스스로 정리되므로(다음 잡이 같은 레인이면 그냥 갱신, 다른 레인이면 그때 충돌 판정)
    // 여기서 던지지 않고 로그만 남긴다.
    console.error(
      "[conversationAutoLane.releaseConversationAutoLane] release failed — tolerated",
      { conversationId, lane, jobRef, error: error instanceof Error ? error.message : String(error) },
    );
  }
}
