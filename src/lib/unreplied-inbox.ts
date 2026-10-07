// "미답장 인박스" (2026-09-26, 헤세 요청) — listUnrepliedInbox 콜러블이 내려준 행을 화면용
// 아이템으로 바꾸는 순수 모듈. 필터·RBAC·조직 스코프·manual-reply 재검증은 전부 서버
// (functions/read.ts listUnrepliedInboxHandler)가 끝낸 뒤 내려주므로, 이 모듈은 오직 표시용
// 가공만 한다 — 새 정책을 만들지 않는다.
//
// 런타임 상대 import(.ts 확장자 포함)는 src/lib 관례와 같다(src/modules/review/inbox.ts 참고) —
// 노드 테스트 레인에서 이 모듈을 그대로 import 해 행위를 고정할 수 있다.
import { buildChatHref } from "./chat-route.ts";
import type { UnrepliedInboxRow } from "./data.ts";

export interface UnrepliedInboxItem {
  readonly id: string;
  readonly who: string;
  /** 보조 신원(이메일 또는 핸들) — who 와 같은 값이면 넣지 않는다. */
  readonly handle?: string;
  readonly reason: string;
  /** 참고 초안(draft_only 상태에만 있음) — 없으면 부재(지어내지 않는다). */
  readonly draftPreview?: string;
  readonly autoReplyStatus: string;
  readonly waitingSinceIso: string;
  readonly href: string;
}

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

// 서버 humanGate 판정 문구가 없을 때의 폴백 — 실제로는 draft_only/waiting_for_human 모두
// autoReplyBlockedReason 또는 draft 원문이 있는 게 정상이라 이 문구는 드물게만 보인다.
const WAITING_FOR_HUMAN_FALLBACK_REASON = "AI가 자동 회신하기 애매해 사람 확인이 필요합니다.";
const DRAFT_ONLY_FALLBACK_REASON = "AI가 참고 초안을 만들었습니다 — 확인 후 발송해 주세요.";

export function unrepliedInboxReasonForRow(row: UnrepliedInboxRow): string {
  const explicit = asText(row.autoReplyBlockedReason);
  if (explicit) return explicit;
  return row.autoReplyStatus === "draft_only"
    ? DRAFT_ONLY_FALLBACK_REASON
    : WAITING_FOR_HUMAN_FALLBACK_REASON;
}

export function unrepliedInboxItemFromRow(row: UnrepliedInboxRow): UnrepliedInboxItem {
  const email = asText(row.creatorEmail);
  const who = asText(row.creatorName) || email || "발신자 미상";
  const secondary = asText(row.creatorHandle) || (email !== who ? email : "");
  return {
    id: row.id,
    who,
    handle: secondary && secondary !== who ? secondary : undefined,
    reason: unrepliedInboxReasonForRow(row),
    draftPreview: asText(row.humanDraftSuggestionKr) || asText(row.humanDraftSuggestion) || undefined,
    autoReplyStatus: asText(row.autoReplyStatus),
    waitingSinceIso: asText(row.lastInboundAtIso) || asText(row.lastMessageAtIso),
    href: buildChatHref({ conversationId: row.id }),
  };
}

// 서버가 이미 오래 기다린 순으로 정렬해 내려준다(lastInboundAtIso asc Firestore 쿼리) — 이
// 함수는 그 순서를 보존한 채 표시용으로만 매핑한다(재정렬하지 않는다).
export function unrepliedInboxItemsFromRows(rows: readonly UnrepliedInboxRow[]): UnrepliedInboxItem[] {
  return rows.map(unrepliedInboxItemFromRow);
}

export function unrepliedInboxWaitingSinceLabel(iso: string, now: Date = new Date()): string {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(parsed)) return "대기 시간 미상";
  const diffMs = Math.max(0, now.getTime() - parsed);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}
