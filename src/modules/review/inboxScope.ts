export type ReviewInboxScopeInput = {
  readonly uid: string;
  readonly tenantId: string;
  readonly role: string;
  readonly team: string;
  /** UI/cache scope only for inbox callables that do not currently accept viewAs payloads. */
  readonly viewAsUserId: string;
};

export type ReviewInboxScopeToken = {
  readonly scopeKey: string;
  readonly generation: number;
};

export function reviewInboxScopeKey(input: ReviewInboxScopeInput): string {
  return [
    `uid:${input.uid}`,
    `tenant:${input.tenantId || "default"}`,
    `role:${input.role}`,
    `team:${input.team || "none"}`,
    `viewAs:${input.viewAsUserId || "self"}`,
  ].join("|");
}

export function nextReviewInboxScopeToken(current: ReviewInboxScopeToken, scopeKey: string): ReviewInboxScopeToken {
  return { scopeKey, generation: current.generation + 1 };
}

export function isCurrentReviewInboxScopeToken(current: ReviewInboxScopeToken, token: ReviewInboxScopeToken): boolean {
  return current.scopeKey === token.scopeKey && current.generation === token.generation;
}
