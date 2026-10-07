// SCP 답장 템플릿 라이브러리 (2026-10-05) — REVIEW-ONLY reference texts for the /chat/auto 검토 보드.
//
// Texts are copied VERBATIM from the operator's non-PII sources (do not edit wording here — change the
// source and re-copy):
//   - A~G: casebook-inbox-2026-10-01/gpt-dot-reply-metaprompt.md "승인된 답장 문구"
//   - greeting_a: scp-review/draft-greeting-A-review-only.md (body only)
//   - rate_policy: scp-review/draft-custom-rate-policy-review-only.md (body only)
// Nothing here is sent, scheduled or saved by the board. A human may copy a template or load it into
// the EXISTING /chat composer, where the existing permissions and gates apply unchanged.
export type ScpReplyTemplateId = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "greeting_a" | "rate_policy";

export type ScpReplyTemplate = {
  id: ScpReplyTemplateId;
  /** Short display letter/label. */
  badge: string;
  title: string;
  usage: string;
  provenance: string;
  /** false = reference only; the board never recommends or preselects it (D under the current policy). */
  recommendable: boolean;
  /** A usage condition shown next to the template (e.g. G only while an account check is in progress). */
  condition: string | null;
  text: string;
};

export const SCP_REPLY_TEMPLATES: readonly ScpReplyTemplate[] = [
  {
    id: "A",
    badge: "A",
    title: "일반 / 참여 방법",
    usage: "참여 방법·관심 표시·일반 질문",
    provenance: "운영자 승인 문구 (2026-10-05)",
    recommendable: true,
    condition: null,
    text: "Hi :)\n\nThank you for reaching out, and sorry for the slow reply! We have had a big surge in inquiries and new participants recently, so it took us a little longer than usual to get back to you.\n\nEverything you need is in our program guide, including how View Reward and Creator Code work, the content requirements, and how to apply: [Super Creator Partners Guide](https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm#guide-overview)\n\nFor the fastest answers, please use the chatbot in the Guide tab. It can help you right away while our inbox is this busy.\n\nWhen you are ready, you can apply here: [Apply to Super Creator Partners](https://creator.supercent.io/apply?locale=en)\n\nWe look forward to seeing your content!\n\nBest regards,\nSuper Creator Partners Team",
  },
  {
    id: "B",
    badge: "B",
    title: "제출 / 콘텐츠 요건",
    usage: "콘텐츠 요건·영상 형식·제출 방법",
    provenance: "운영자 승인 문구 (2026-10-05)",
    recommendable: true,
    condition: null,
    text: "Hi,\n\nThank you for your message, and sorry for the delayed reply. We have had a big increase in submissions and inquiries recently.\n\nPlease check the content requirements in the guide and make sure your video meets each item before submitting again. The chatbot in the Guide tab can also help you check what may need to change: [Super Creator Partners Guide](https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm#guide-overview)\n\nThank you for your understanding.\n\nBest regards,\nSuper Creator Partners Team",
  },
  {
    id: "C",
    badge: "C",
    title: "단가 / 예산 (숫자 금지)",
    usage: "단가·예산 문의 (숫자 없이 가이드 안내)",
    provenance: "운영자 승인 문구 (2026-10-05)",
    recommendable: true,
    condition: null,
    text: "Hi,\n\nThank you for your interest, and sorry for the slow reply. We have had a big surge in inquiries recently.\n\nAll reward details for Super Creator Partners, including how View Reward and Creator Code work, are explained in our official program guide: [Super Creator Partners Guide](https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm#guide-overview)\n\nThe chatbot in the Guide tab can answer questions about the program right away. If the program works for you, you can apply here: [Apply to Super Creator Partners](https://creator.supercent.io/apply?locale=en)\n\nBest regards,\nSuper Creator Partners Team",
  },
  {
    id: "D",
    badge: "D",
    title: "고정 수수료 / 개인 계약 (정중한 거절)",
    usage: "이전 기준 참고(2026-10-05 이전) · 현재 정책에서는 추천·선택하지 않음 · 고정 단가 제안만 있는 건은 무회신",
    provenance: "운영자 승인 문구 (2026-10-05)",
    recommendable: false,
    condition: null,
    text: "Hi,\n\nThank you for your interest in working with us, and sorry for the delayed reply. We have had a large increase in inquiries recently.\n\nTo keep things fair for every creator, Super Creator Partners runs only on the standard terms in our program guide. We are not able to offer fixed fees, individual contracts, or custom rates, so we cannot move forward with a separate paid arrangement.\n\nIf the standard program works for you, you are more than welcome to join. You can find the full terms here: [Super Creator Partners Guide](https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm#guide-overview)\n\nFor any questions about the guide, the chatbot in the Guide tab is the quickest way to get an answer.\n\nBest regards,\nSuper Creator Partners Team",
  },
  {
    id: "E",
    badge: "E",
    title: "메신저 / 전화 / 미팅 요청",
    usage: "메신저·전화·미팅 요청",
    provenance: "운영자 승인 문구 (2026-10-05)",
    recommendable: true,
    condition: null,
    text: "Hi :)\n\nThank you for reaching out, and sorry for the slow reply! We have had a big surge in inquiries and participants recently.\n\nWe handle all Super Creator Partners communication by email, so we are not able to connect by phone, WhatsApp, Telegram, or Discord, or to arrange calls or meetings. For quick answers, please use the chatbot in the Guide tab: [Super Creator Partners Guide](https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm#guide-overview)\n\nYou can also reply to this email anytime, and we will get back to you.\n\nBest regards,\nSuper Creator Partners Team",
  },
  {
    id: "F",
    badge: "F",
    title: "지원 결과 / 심사 상태",
    usage: "지원 결과·심사 상태 문의",
    provenance: "운영자 승인 문구 (2026-10-05)",
    recommendable: true,
    condition: null,
    text: "Hi :)\n\nThank you for your patience, and sorry for the slow reply! Because of a big surge in applications and inquiries, reviews are taking a little longer than usual.\n\nYou can check your status anytime in your portal dashboard, and you will see the result there once the review is complete. The chatbot in the Guide tab can also answer most questions right away: [Super Creator Partners Guide](https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm#guide-overview)\n\nThank you for waiting with us!\n\nBest regards,\nSuper Creator Partners Team",
  },
  {
    id: "G",
    badge: "G",
    title: "정산 숫자 일반 문의 (장애 언급 금지)",
    usage: "정산 숫자 일반 문의 (분쟁·누락 주장은 운영자 판단)",
    provenance: "운영자 승인 문구 (2026-10-05) · 장애 언급 문구는 운영 규칙에 따라 제거됨",
    recommendable: true,
    condition: "실제 계정 확인이 진행 중일 때만 사용",
    text: "Hi,\n\nThank you for letting us know, and sorry for the late reply. We have been handling a very high volume of inquiries.\n\nEarnings in your dashboard are updated as view data is collected and reviewed, so recent numbers can take some time to be fully reflected. Our team is checking your account, and any update will appear in your dashboard, so there is no need to submit anything again.\n\nThe guide explains how View Reward and Creator Code earnings are calculated, and the chatbot in the Guide tab can help with general questions: [Super Creator Partners Guide](https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm#guide-overview)\n\nThank you for your patience.\n\nBest regards,\nSuper Creator Partners Team",
  },
  {
    id: "greeting_a",
    badge: "첫 인사 A",
    title: "첫 인사 참여 안내",
    usage: "첫 인사·고민 중 (참여 안내)",
    provenance: "운영자 결정 2026-10-05 + 과거 실제 SENT 답신 suffix YyQs6g(2026-10-03)",
    recommendable: true,
    condition: null,
    text: "Hi :)\n\nThank you for reaching out, and sorry for the slow reply! We have had a big surge in inquiries and new participants recently, so it took us a little longer than usual to get back to you.\n\nIf you are considering joining Super Creator Partners, everything you need is in our program guide, including how View Reward and Creator Code work, the content requirements, and how to apply: [Super Creator Partners Guide](https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm#guide-overview)\n\nFor the fastest answers, please use the chatbot in the Guide tab. It can help you right away while our inbox is this busy.\n\nWhen you are ready, you can apply here: [Apply to Super Creator Partners](https://creator.supercent.io/apply?locale=en)\n\nWe look forward to seeing your content!\n\nBest regards,\nSuper Creator Partners Team",
  },
  {
    id: "rate_policy",
    badge: "단가 정책",
    title: "개별 단가 변경 정책 안내",
    usage: "표준 단가의 개별 변경·인상 요청 (고정 수수료 제안·정산 분쟁에는 쓰지 않음)",
    provenance: "운영자 결정 2026-10-05 ('internal policy' 문장은 과거 원문 인용 아님) + 과거 실제 SENT suffix caa40c(2026-10-02 12:42 KST), 6194a6(2026-10-03 10:32 KST)",
    recommendable: true,
    condition: null,
    text: "Hi,\n\nThank you for your interest in working with us, and sorry for the delayed reply. We have had a large increase in inquiries recently.\n\nUnder our internal policy, Super Creator Partners runs on the standard terms in our program guide, so we are not able to offer custom rates or adjust them individually. These terms are the same for every creator in the program.\n\nIf the standard program works for you, you are more than welcome to join. You can find the full terms here: [Super Creator Partners Guide](https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm#guide-overview)\n\nFor any questions about the guide, the chatbot in the Guide tab is the quickest way to get an answer.\n\nWhen you are ready, you can apply here: [Apply to Super Creator Partners](https://creator.supercent.io/apply?locale=en)\n\nBest regards,\nSuper Creator Partners Team",
  },
];

export function scpReplyTemplate(id: string | null | undefined): ScpReplyTemplate | null {
  return SCP_REPLY_TEMPLATES.find((template) => template.id === id) ?? null;
}
