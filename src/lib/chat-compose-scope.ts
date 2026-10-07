// Chat composer scope and async-result guards.
//
// The chat page can keep the same conversation key while the authenticated user, ViewAs target,
// or mailbox changes. These helpers make that broader scope explicit and keep late preview/send
// results from writing into a newer composer instance.

export type ChatComposeScopeInput = Readonly<{
  authScopeKey?: string | null;
  authScopeGeneration?: number;
  mailAccountViewScopeKey: string;
  isNewCompose: boolean;
  conversationKey?: string | null;
  replySourceKey?: string | null;
  requestedMessageRef?: string | null;
}>;

export type ChatComposeEffectivePolicyInput = Readonly<{
  /** Stable caller/view identity, excluding the policy response's incidental metadata. */
  identityScopeKey?: string | null;
  /** The mailbox view that is effective for the composer, when policy is resolved. */
  viewMode?: string | null;
  viewMailAccountId?: string | null;
  /** Only a lost grant changes the composer scope; changing between still-authorized senders
   * invalidates the exact-input preview below without erasing the draft. */
  selectedSenderPermission: "authorized" | "revoked";
}>;

export type ChatComposeSenderSelectionInput = Readonly<{
  currentSenderId?: string | null;
  policyPending: boolean;
  usableSenderIds: readonly string[];
  defaultSenderId?: string | null;
  /** Pass this when a resolved mailbox view must select exactly its own sender. */
  viewedSenderId?: string | null;
  /** A caller/view identity transition always starts with no sender selection. */
  identityChanged?: boolean;
}>;

/**
 * Resolve the sender state used by the chat effects. A policy refresh has no usable answer yet,
 * so it retains the current selection; the resolved path applies the existing default/viewed
 * account rules and can clear a sender only after that answer is authoritative.
 */
export function chatComposeSenderSelection(input: ChatComposeSenderSelectionInput): string {
  const currentSenderId = input.currentSenderId?.trim() ?? "";
  if (input.identityChanged) return "";
  if (input.policyPending) return currentSenderId;

  const usableSenderIds = new Set(input.usableSenderIds);
  if (input.viewedSenderId !== undefined) {
    const viewedSenderId = input.viewedSenderId?.trim() ?? "";
    return viewedSenderId && usableSenderIds.has(viewedSenderId) ? viewedSenderId : "";
  }
  if (currentSenderId && usableSenderIds.has(currentSenderId)) return currentSenderId;

  const defaultSenderId = input.defaultSenderId?.trim() ?? "";
  return defaultSenderId && usableSenderIds.has(defaultSenderId) ? defaultSenderId : "";
}

/**
 * Stable policy boundary for composer input state. The org-context envelope also contains
 * labels, statuses, and Peoply resolution metadata that can legitimately change during a
 * refresh while the effective mailbox and selected sender grant stay the same. Those fields do
 * not belong in the input-state boundary; the page keeps the last resolved view/grant while the
 * next policy response is pending and feeds only these semantic dimensions here.
 */
export function chatComposeEffectivePolicyKey(input: ChatComposeEffectivePolicyInput): string {
  return JSON.stringify([
    "chat-compose-policy-v1",
    input.identityScopeKey ?? "",
    input.viewMode ?? "",
    input.viewMailAccountId ?? "",
    input.selectedSenderPermission,
  ]);
}

/**
 * Stable identity for one composer instance. JSON encoding keeps delimiters inside scope values
 * unambiguous while still producing a deterministic key for React effect dependencies.
 */
export function chatComposeScopeKey(input: ChatComposeScopeInput): string {
  return JSON.stringify([
    "chat-compose-v1",
    input.authScopeKey ?? "",
    input.authScopeGeneration ?? 0,
    input.mailAccountViewScopeKey,
    input.isNewCompose ? "new" : "reply",
    input.conversationKey ?? "",
    input.replySourceKey ?? "",
    input.requestedMessageRef ?? "",
  ]);
}

export type ChatComposeAsyncRequest = Readonly<{
  scopeKey: string;
  scopeGeneration: number;
  requestGeneration: number;
  /** The authorized sender is part of preview/send validity even when the draft text is unchanged. */
  senderAccountId: string;
}>;

/**
 * A response may update the composer only when both its scope and request generation are active.
 * The page increments request generations for newer requests and scope generations for identity,
 * mailbox, route-mode, conversation, or reply-source changes.
 */
export function isCurrentChatComposeAsyncRequest(
  request: ChatComposeAsyncRequest,
  active: ChatComposeAsyncRequest,
): boolean {
  return request.scopeKey === active.scopeKey
    && request.scopeGeneration === active.scopeGeneration
    && request.requestGeneration === active.requestGeneration
    && request.senderAccountId === active.senderAccountId;
}

export type ChatComposeAiDraftRequest = Readonly<{
  scopeKey: string;
  scopeGeneration: number;
  requestGeneration: number;
  conversationKey: string;
  inputKey: string;
}>;

/**
 * AI draft responses need the composer scope plus the exact input and request generation. This
 * keeps a late model response from restoring a draft after a user edit, send, policy refresh, or
 * scope transition, including a transition that later returns to an earlier scope key.
 */
export function isCurrentChatComposeAiDraftRequest(
  request: ChatComposeAiDraftRequest,
  active: ChatComposeAiDraftRequest,
): boolean {
  return request.scopeKey === active.scopeKey
    && request.scopeGeneration === active.scopeGeneration
    && request.requestGeneration === active.requestGeneration
    && request.conversationKey === active.conversationKey
    && request.inputKey === active.inputKey;
}
