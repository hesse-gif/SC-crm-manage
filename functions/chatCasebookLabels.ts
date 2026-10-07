/** Public operator labels; these never change case classification or reply policy. */
export const CHAT_CASEBOOK_LABELS: Readonly<Record<string, { title: string; description: string }>> = {
  interest_next_steps: { title: "참여·다음 단계", description: "프로그램에 관심을 보이거나 참여 방법과 다음 단계를 묻는 문의" },
  scp_application_received: { title: "지원서 접수 확인", description: "지원서가 정상적으로 접수됐는지 확인하는 문의" },
  approval_status_inquiry: { title: "승인 상태 문의", description: "지원·계정의 승인 여부나 검토 시점을 묻는 문의" },
  submission_support: { title: "콘텐츠 제출 도움", description: "영상 제출 방법이나 제출 과정의 문제를 묻는 문의" },
  requirements_question: { title: "제작 조건 문의", description: "영상 형식·분량·표기 등 제작 가이드를 묻는 문의" },
  asset_request: { title: "자료·예시 요청", description: "제작에 필요한 자료나 참고 예시를 요청하는 메일" },
  eligibility_question: { title: "참여 자격 문의", description: "채널·계정이 프로그램 참여 조건에 맞는지 묻는 문의" },
  reward_overview: { title: "보상 구조 문의", description: "프로그램의 보상 방식과 정산 절차를 묻는 문의" },
  pricing_guide_redirect: { title: "단가 가이드 문의", description: "가격·예산·단가를 묻는 문의를 공식 가이드로 안내" },
  counter_offer_guideline_reply: { title: "단가 역제안", description: "단가 인상이나 다른 금액을 제안하는 메일" },
  fixed_terms_inquiry: { title: "계약·조건 협의", description: "개별 계약이나 표준 조건의 변경을 요청하는 문의" },
  access_concern: { title: "채널 접근 우려", description: "채널 권한 연결이나 데이터 열람에 대한 우려" },
  discontinue_notice: { title: "참여 중단 안내", description: "프로그램 참여를 중단하거나 불참하겠다는 메일" },
  out_of_office: { title: "부재중 자동회신", description: "부재중·담당자 변경 등을 알리는 자동응답 메일" },
  closing_acknowledgment: { title: "대화 마무리", description: "추가 질문 없이 감사나 작별 인사로 끝나는 메일" },
  call_request: { title: "통화·미팅 요청", description: "전화나 온라인 미팅으로 협의하자는 요청" },
  contact_channel_request: { title: "외부 채널 연락 요청", description: "WhatsApp·Telegram·Discord 등 메신저로 연락하자는 요청" },
  settlement_dispute: { title: "정산 이의 제기", description: "지급액·정산 결과·미지급 등에 이의를 제기하는 문의" },
  out_of_scope_request: { title: "가이드 밖 요청", description: "공식 가이드에 없는 사실이나 조건을 확인해야 하는 요청" },
  opt_out_or_legal: { title: "수신 거부·법적 요청", description: "연락 중단·삭제·차단 또는 법적 조치를 요구하는 메일" },
  confusion_or_short: { title: "내용 확인 필요", description: "짧거나 뜻이 불분명해 질문의 의미를 먼저 확인해야 하는 메일" },
};

export function chatCasebookLabel(caseId: string): { title: string; description: string } {
  return CHAT_CASEBOOK_LABELS[caseId] ?? { title: "분류 확인 필요", description: "문의 내용을 확인한 뒤 사람이 검토해야 합니다." };
}
