import type { MailAccountPublic, MailSenderBlockedReason, MyOrgContextEnvelope } from "./data";

/**
 * Returns the server-authorized active senders for the current caller. The caller's accessible
 * account list and the administrative inventory are intentionally not fallbacks here: neither is
 * a send-as grant.
 */
export function usableMailSenders(context: MyOrgContextEnvelope | null | undefined): MailAccountPublic[] {
  return (context?.usableSenders ?? []).filter((account) => account.status === "active");
}

export function defaultMailSender(
  context: MyOrgContextEnvelope | null | undefined,
  senders: readonly MailAccountPublic[] = usableMailSenders(context),
): MailAccountPublic | null {
  const defaultSenderId = context?.defaultSenderId?.trim();
  if (!defaultSenderId) return null;
  return senders.find((sender) => sender.accountId === defaultSenderId) ?? null;
}

export function mailSenderBlockedReasonLabel(reason: MailSenderBlockedReason | null | undefined): string {
  switch (reason) {
    case "personal_connection_required":
      return "이 팀은 개인 메일 연결이 필요합니다. 내 메일함을 연결한 뒤 발송하세요.";
    case "org_mail_account_unavailable":
      return "현재 사용할 수 있는 발신 계정이 없습니다. 계정 상태를 관리자에게 확인해 주세요.";
    default:
      return reason
        ? "서버 정책에 따라 현재 발신이 차단되었습니다. 관리자에게 확인해 주세요."
        : "현재 팀에서 사용할 수 있는 발신 계정이 없습니다. 개인 메일을 연결하거나 관리자에게 팀 메일 매핑을 요청하세요.";
  }
}

export function mailSenderPolicyMessage(
  context: MyOrgContextEnvelope | null | undefined,
  senderSelectionRequired = false,
): string {
  if (context?.orgResolutionStatus === "directory_unavailable") {
    return "Peoply 팀 매핑을 확인하지 못해 발신 계정을 결정할 수 없습니다. 잠시 후 다시 시도하세요.";
  }
  if (context?.orgResolutionStatus === "unresolved") {
    return "현재 계정은 Peoply 팀에 매핑되지 않았습니다. 공유 발신 계정은 자동으로 배정되지 않습니다.";
  }
  if (context?.senderBlockedReason) {
    return mailSenderBlockedReasonLabel(context.senderBlockedReason);
  }
  if (context && senderSelectionRequired && usableMailSenders(context).length > 0) {
    return "발송할 계정을 선택하세요.";
  }
  return mailSenderBlockedReasonLabel(context?.senderBlockedReason);
}

export function mailSenderDisplayName(account: Pick<MailAccountPublic, "label" | "mailbox">): string {
  return account.label || account.mailbox;
}
