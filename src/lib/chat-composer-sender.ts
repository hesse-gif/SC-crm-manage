// Flu/Task-56 — [Chat] 발신 계정 표시: chat/page.tsx(답장 입력창)에서 쓰는 순수 파생 함수만 모은다.
// page.tsx는 JSX를 포함한 .tsx라 node의 타입 스트리핑만으로는 직접 단위 테스트를 import할 수 없어
// (tests/chat-composer-sender.test.mjs) chat-normalization.ts와 같은 방식으로 분리했다.

export type ComposerSenderLabel = {
  /** 답장 입력창 근처에 "발신: {label}" 로 보여줄 계정 라벨. null이면(조직 미해석 등) 추측할
   *  근거가 없다는 뜻 — 행 자체를 생략한다. */
  label: string | null;
  /** true: 계정 보기 토글(canToggleMailAccountView)로 실제 viewAccountId를 서버에 보내는 경로라
   *  functions/chat-ai.ts가 그 값을 핀 계정보다 먼저 검증·적용해 이 라벨 그대로 발송한다.
   *  false: 토글이 없어(viewAccountId 미전송) label이 orgContext.accountLabel/accountMailbox로
   *  대체된 경우 — 적대 리뷰(Task-56) 지적: 이 분기에서 서버 functions/mailAccountSelection.ts의
   *  selectOutboundMailAccount는 ① 대화 핀 계정(conversation.mailAccountId, ACTIVE)을 ② 발신자
   *  이메일 해석(=orgContext.accountLabel/accountMailbox가 반영하는 값)보다 먼저 쓴다. 즉 이
   *  대화가 이미 다른 계정에 핀돼 있으면 실제 발신 계정이 이 라벨과 다를 수 있다 — 호출부가 문구를
   *  완화해서 보여줘야 한다. */
  certain: boolean;
};

/** 답장 입력창 근처에 "발신: {label}" 로 보여줄 계정 라벨과, 그 라벨이 실제 발신 계정과 확실히
 *  일치하는지(certain)를 함께 정한다. 계정 보기 토글이 가능한 조직(Task-48)이면 현재 선택된
 *  보기의 라벨(viewingMailAccountLabel)을 그대로 쓰고 certain: true — 클라이언트가 그 계정 id를
 *  viewAccountId로 서버에 보내고, 서버는 대화 핀보다 그 값을 우선 적용하기 때문이다(정확). 토글이
 *  없는 단일 계정 조직(Growth/scp 등)에서는 getMyOrgContext가 내려주는 조직 배정 계정
 *  (accountLabel/accountMailbox)으로 대체하지만 certain: false — 이 분기는 viewAccountId를
 *  보내지 않아 서버가 대화 핀 계정을 이 값보다 우선할 수 있다(위 타입 주석 참고). 셋 다 없으면
 *  label: null — 추측해서 보여주지 않는다. */
export function deriveComposerSenderLabel(input: {
  viewingMailAccountLabel: string | null;
  orgAccountLabel: string | null;
  orgAccountMailbox: string | null;
}): ComposerSenderLabel {
  if (input.viewingMailAccountLabel) {
    return { label: input.viewingMailAccountLabel, certain: true };
  }
  return { label: input.orgAccountLabel || input.orgAccountMailbox || null, certain: false };
}

/** The composer has two independent identities: the mailbox used to view history and the account
 * selected for a new send. Warn when they differ so the user can review the explicit sender choice
 * before sending. The legacy fields remain optional for older tests/callers that used this helper
 * for the former view-switch confirmation. */
export function isComposerSenderViewMismatched(input: {
  selectedViewMailAccountId?: string | null;
  selectedSenderAccountId?: string | null;
  chatMailAccountView?: "personal" | "org";
  hasSelectedViewMailAccountId?: boolean;
  conversationOpenedView?: "personal" | "org" | null;
}): boolean {
  if (input.selectedViewMailAccountId !== undefined || input.selectedSenderAccountId !== undefined) {
    return Boolean(input.selectedViewMailAccountId)
      && Boolean(input.selectedSenderAccountId)
      && input.selectedViewMailAccountId !== input.selectedSenderAccountId;
  }
  return (
    input.chatMailAccountView === "personal"
    && input.hasSelectedViewMailAccountId === true
    && input.conversationOpenedView !== null
    && input.conversationOpenedView !== undefined
    && input.conversationOpenedView !== "personal"
  );
}
