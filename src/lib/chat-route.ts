export type ChatRouteState = {
  conversationId: string;
  messageRef: string;
};

export type ChatRouteTarget = {
  conversationId: string;
  messageRef?: string;
};

type SearchParamsReader = Pick<URLSearchParams, "get">;

type MessageRouteIdentity = {
  messageRef?: unknown;
};

function cleanRouteValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function parseChatRouteState(params: SearchParamsReader): ChatRouteState {
  return {
    conversationId: cleanRouteValue(params.get("conversationId"), 300),
    messageRef: cleanRouteValue(params.get("messageRef"), 500),
  };
}

export function buildChatHref(target: ChatRouteTarget): string {
  const conversationId = cleanRouteValue(target.conversationId, 300);
  if (!conversationId) return "/chat";
  const params = new URLSearchParams({ conversationId });
  const messageRef = cleanRouteValue(target.messageRef, 500);
  if (messageRef) params.set("messageRef", messageRef);
  return `/chat?${params.toString()}`;
}

export function messageIndexForRoute(
  messages: readonly MessageRouteIdentity[],
  messageRef: unknown,
): number {
  const requested = cleanRouteValue(messageRef, 500);
  if (!requested) return -1;
  return messages.findIndex((message) => cleanRouteValue(message.messageRef, 500) === requested);
}
