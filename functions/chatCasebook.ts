// Chat 케이스북 v1 — 답신 초안 레인의 "작은 세컨드 브레인" (2026-08-17)
//
// ■ 이 파일이 무엇인가
//   크리에이터 수신 메일을 케이스로 분류하고, 케이스별 응답 골격·근거 사실·에스컬레이션을
//   정의하는 **사람이 읽고 git 으로 고치는** 정본이다. 초안 프롬프트(gatewayPrompt)가 이
//   파일을 통째로 컨텍스트로 받는다. 새 컬렉션·새 콜러블·별도 LLM 콜 없음.
//   성장 = 사람이 이 파일을 수정해 커밋 (자동 편입 금지).
//
// ■ 하드 룰 (헤세 확정 26-08-17 — 케이스 내용보다 우선한다)
//   1. 법적 조치·차단 신호(unsubscribe/삭제 요청/소송 언급 등)는 **초안 생성 금지**.
//      런타임 안전층(mailHumanGate.isHardOptOut → 억제)이 정답이며 이 파일은 그 거울일 뿐,
//      초안 레인은 안전층과 절대 경합하지 않는다.
//   2. **협상하지 않는다 — 정찰제.** 금액/조건 제안이 오면 카운터오퍼·조율 없이 포털의
//      고정 조건을 그대로 안내하는 골격 하나뿐. 협상 여지를 암시하는 표현 금지.
//   3. **Closed-world**: 응답에 쓰는 사실은 이 파일에 적힌 것(출처: artifacts/
//      PORTAL-GROUNDING-20260817.md)만 사용. 여기 없는 질문이면 지어내지 말고 사람 검토로.
//      새 약속·새 조건·가이드 밖 해석 = 금지.
//
// ■ 수정 시 주의
//   - 사실 추가는 반드시 포털 그라운딩 문서와 대조 후 (portalRef 에 섹션 표기).
//   - 톤 규칙의 정본은 담당자 실발신 코퍼스(artifacts/TONE-CORPUS-HUMAN-20260817.md) —
//     "AI가 자연스러워 보이는 문장"이 아니라 실측 패턴에 맞춰 수정할 것.
//   - PII 원문 금지 (사례는 요지화). SEC-P0-009.
//   - 캐시 계약: 내용이 바뀌면 CHAT_CASEBOOK_CONTENT_HASH(파일 하단)가 자동으로 갈려
//     캐시 키가 분리된다 — 버전을 잊어도 안전하다. CHAT_CASEBOOK_VERSION 은 사람용
//     라벨이니 의미 있는 개정(케이스 추가/정책 변경) 때 올려라.

import { createHash } from "node:crypto";

// v2 (auto-reply-risk-taxonomy 2026-09-17): adds settlement_dispute (F-5 case merged from
// hesse-gif/auto-mail-safety-f4-f7) + out_of_scope_request (B.2), and appends a no-bargaining
// sentence to every auto_ok case's `never` (헤세 2026-09-17: "자동 답장은 절대 유도(upsell)하거나
// 금액으로 쇼부(협상)하면 안 되고 무조건 가이드라인대로만"). The content hash
// (CHAT_CASEBOOK_CONTENT_HASH below) already covers both edits with a single bump.
// v3: adds closing_acknowledgment + the auto_close escalation — 순수 종결 인사("감사합니다",
// "Thank you!", "좋은 하루 되세요")에는 답신도 사람 검수 큐도 만들지 않고 스레드를 닫는다.
// The version string stays a human label; CHAT_CASEBOOK_CONTENT_HASH below is the machine
// contract and rotates automatically whenever this rendered block changes (기존 arm 된
// 퍼밋은 해시가 갈리면 stale 처리돼 배포 후 재평가·재-arm 이 필요하다).
// v5 (2026-09-22): interest_next_steps skeleton에 always-on 상시 모집 사실을 명시 — "is this
//   still open?" 류 모집 여부 문의가 closed-world 룰에 needs_review 로 비결정적으로 갈리던 것을
//   고정한다(사실 자체는 program.always_on 팩트 토큰으로 이미 존재 — 표현만 명문화).
// v6 (2026-09-24, 헤세 지시): adds pricing_guide_redirect — 순수 가격/예산/단가 문의(구체
//   counter-offer 없음)를 auto_ok 로 열되, 금액은 절대 밝히지 않고 "내부 정책상 가이드 페이지를
//   확인해달라"는 정본 안내만 렌더한다(mailHumanGate.liftBudgetInquiryHoldForGuideRedirectCase
//   가 통화-토큰 홀드만 독립 재검증 후 면제). fixed_terms_inquiry(협상/역제안)는 그대로 사람 검토.
// v7 (2026-09-24, 헤세 지시 — 역제안 가이드라인 금액 고정회신): "역제안일 때는 우선 우리
//   가이드라인 금액을 말해주는 형태로 가자. 역제안 절대 안 통하고." adds
//   counter_offer_guideline_reply — 창작자가 직접 금액을 역제안·인상 요청해도(계약/법무/정산분쟁/
//   통화/에이전시/독점권 등 다른 신호 없이 순수 단가 제안뿐이면) 그 제안에 동의·조율하지 않고
//   우리 쪽 고정 공개 가이드라인 금액({{GUIDELINE_AMOUNT}}, 서버 렌더 — 모델은 숫자를 쓰지 않는다)
//   만 정중·단호하게 안내한다(mailHumanGate.liftCounterOfferHoldForGuidelineAmountCase 가
//   budget-amount/budget-or-rate 단독 홀드만 독립 재검증 후 면제). 계약서·서명·법무·정산분쟁·
//   통화/미팅·에이전시·복수 크리에이터 딜·독점권/2차사용권/지급시기 변경이 섞이면 여전히
//   fixed_terms_inquiry(사람 검토)로 남는다.
// v8 (2026-09-29, 헤세 지시 — scp@ 프로드 사고, incident-2026-09-29-chat/five-auto-candidates.md):
//   adds approval_status_inquiry — 순수 "내 지원/계정이 승인됐는지, 언제 승인되는지" 상태 문의
//   (접수 확인은 scp_application_received 로 별도, 계약서/사용권 승인 등 계약 조건 문의는 여기
//   아님). 프로드 실측: 5건 중 3건(je/sc/ar)이 이 문의였는데 케이스북에 대응 케이스가 없었고,
//   그중 2건은 contract-rights-human-review 가 bare "approval" 단어 하나만으로 오탐 발동해
//   needs_review 에 영구 고정됐다(퍼밋/케이스북 재분류로도 못 풂). 고정 기한·승인 약속·금액·
//   계약 조건은 절대 언급하지 않고 포털에서 최신 상태를 확인하라고만 안내한다
//   (mailHumanGate.liftApprovalStatusHoldForGuideRedirectCase 가 contract-rights-human-review
//   단독 홀드만 독립 재검증 후 면제). contract-rights-human-review 자체도 bare
//   "approval"/"approved"/"승인" 단독 매치를 제거하고 계약/사용권/라이선스/독점/결제 문맥과
//   근접할 때만 매치하도록 좁혔다(대행사/매니저 서명 문의는 agency-human-review 가 그대로 잡는다,
//   불변).
// v9 (2026-10-03, 헤세 지시 — 분류 체계화, classification_v1): 단일 caseId 에 행위자·의도가 섞여 생기던
//   오분류를 줄이려고 ① 모델이 caseId 와 별개로 actorType(creator|agency_mcn|vendor_or_notification|unknown)
//   과 intentLabels[](다중 의도)를 낸다 — autoCaseId 는 호환용 대표 케이스로 그대로 유지. ② fixed_terms_inquiry
//   는 **custom_terms_proposal(자기 고정 요율/계약/독점/지급구조 변경 제안)일 때만** — 대행사/MCN 이라는 사실이나
//   관심·보상·브리프 요청만으로는 선택하지 않는다(대행사는 기존 사람 검토 정책으로 별도 홀드, 의도가 케이스를
//   정한다). ③ contact_channel_request 신설 — WhatsApp/Telegram/Discord/LINE/KakaoTalk 등 외부 메신저 연락
//   요청을 통화·미팅(call_request)과 분리 — 헤세 결정(2026-10-03)으로 auto_ok: 고정 이메일 전용 리다이렉트 템플릿을 서버가
//   렌더하며, 토글(allowEmailOnlyRedirectForContactChannelRequest, 기본 꺼짐)+permit armed+JEV 를 모두 통과해야만 발송된다. 렌더 블록이 바뀌므로
//   CHAT_CASEBOOK_CONTENT_HASH 가 갈려 기존 armed 퍼밋은 stale → 배포 후 재평가·재-arm 필요(기존 계약).
export const CHAT_CASEBOOK_VERSION = "casebook_v9" as const;

// classification_v1: version of the actor/intent classification contract (gateway schema + prompt axes in
// chat-ai.ts, the intent guard and label vocab in chatClassificationAxes.ts). Stamped next to every label and
// hashed into CHAT_CASEBOOK_CONTENT_HASH below. Bump on ANY change to the axes vocabulary, the guard rules or the
// gateway prompt's axis instructions.
export const CHAT_CLASSIFICATION_CONTRACT_VERSION = "classification_v1" as const;

export type CasebookEscalation =
  | "auto_ok"            // 초안 → (자동응답 ON 시) 발송 후보. 지금은 전부 초안만.
  | "needs_review"       // 초안은 참고용 — 반드시 사람 검토 라우팅.
  | "blocked_suppression" // 초안 금지 — 억제+사람 처리 (런타임 안전층 거울).
  | "auto_close";        // 초안 금지 + 발송·검수 큐 모두 금지 — 종결 인사. 서버가 스레드를 닫는다.

// 초안이 쓸 수 있는 정본 링크 토큰 — 모델은 URL 을 직접 쓰지 않고 이 토큰만 쓴다.
// 치환(토큰 → 마크다운 앵커 [라벨](정본URL))은 서버(chat-ai.ts substituteCasebookLinks)가 수행 —
// 모델의 URL 오타/날조를 원천 차단하고, 메일에는 raw URL 대신 표시 텍스트 링크가 나간다.
// GUIDELINE_AMOUNT 는 URL 이 아니라 SCP_REWARD_GUIDELINE_STATEMENT(이 파일 하단, 정본 텍스트)로
// 치환되는 사실(factual) 토큰이다 — 같은 화이트리스트·치환 메커니즘을 재사용해 모델이 숫자를
// 직접 쓰는 경로를 원천 차단한다(v7, 2026-09-24).
export const CASEBOOK_LINK_TOKENS = ["APPLY_LINK", "GUIDE_LINK", "SUBMIT_LINK", "SAMPLE_LINK", "GUIDELINE_AMOUNT"] as const;
export type CasebookLinkToken = (typeof CASEBOOK_LINK_TOKENS)[number];

export type CasebookCase = {
  readonly id: string;
  /** 수신 메일에서 이 케이스를 식별하는 신호 (모델 분류용 서술) */
  readonly signals: string;
  /** 실측 빈도 근거 (TONE-CORPUS 322건 + W94 실사례 7건) — 사람 참고용 */
  readonly frequency: string;
  readonly escalation: CasebookEscalation;
  /** 응답 골격 — 무엇을 먼저, 무엇을 약속하면 안 되는지. 사실은 전부 포털 원문 기반. */
  readonly skeleton: string;
  /** 이 케이스에서 절대 하면 안 되는 것 */
  readonly never: string;
  /** 근거 출처 (artifacts/PORTAL-GROUNDING-20260817.md 섹션) — 사람 검증용 */
  readonly portalRef: string;
  /** 이 케이스 초안에 첨부할 정본 링크 토큰 (없으면 링크 없이 답변) */
  readonly links?: readonly CasebookLinkToken[];
  /**
   * 초안 금지(명시 플래그, 2026-10-01): 이 케이스는 어떤 형태의 답신 초안도 만들지 않는다 — 사람 전용.
   * skeleton 의 "초안 생성 금지"/"초안 없이" 서술과 짝이며, AI 답신 제안(운영자 제안 콜러블 + 기본 제안
   * 사전생성 잡)이 텍스트 매칭이 아니라 이 필드만 본다. blocked_suppression/auto_close 는 escalation 자체가
   * 초안 금지라 이 플래그가 필요 없다. 프롬프트에 렌더되지 않으므로 CHAT_CASEBOOK_CONTENT_HASH 는 그대로다.
   */
  readonly draftForbidden?: true;
  /**
   * 답장 불필요(명시 플래그, 0.6.105): 이 케이스의 대기 대화는 사람이 답장할 필요가 없다(부재중 자동응답 등).
   * 케이스북 콘솔의 "답장 불필요" 묶음 표시 전용 — 대화 상태·초안·발송·permit 어느 것도 바꾸지 않는다.
   * auto_close 케이스는 escalation 자체로 답장 불필요라 이 플래그가 필요 없다. draftForbidden 처럼 프롬프트에
   * 렌더되지 않으므로 CHAT_CASEBOOK_CONTENT_HASH 는 그대로다.
   */
  readonly noReplyNeeded?: true;
  /** Permit 자동발송 전용 서버 렌더 템플릿. auto_ok 케이스만 가진다. */
  readonly autoReplyTemplate?: {
    readonly title: string;
    readonly factTokenIds: readonly string[];
    readonly template: string;
  };
};

export const CHAT_CASEBOOK: readonly CasebookCase[] = [
  {
    id: "interest_next_steps",
    signals: "관심 표현 + 다음 단계/브리프/시작 방법 요청 (\"I'm interested\", \"what's next\", \"send me the details\")",
    frequency: "최다 — 코퍼스 71/322",
    escalation: "auto_ok",
    skeleton:
      "① 관심에 짧게 감사 ② 프로그램 3단계 안내: apply 제출 → View Reward·Creator Code 두 트랙 활동(신청 시 자동으로 둘 다 등록, Creator Code 세부는 별도 이메일) → 매월 정산 ③ 다음 행동 1개를 명확히 (포털 Join/apply 또는 이미 참여자면 콘텐츠 제출). 프로그램은 always-on 상시 모집이다 — \"is this still open?\" 류의 모집 여부 문의에는 현재 지원 가능하다고 답한다.",
    never: "구체 금액 약속, 개별 조건 협상 암시, 통화/미팅 제안. Never negotiate, discount, or promise rates/amounts/bonuses beyond the published guideline figures; never pressure the creator to act; money/rate questions outside the guideline → human.",
    portalRef: "§1 프로그램 개요 (3단계 플로우, always-on)",
    links: ["APPLY_LINK", "GUIDE_LINK"],
    autoReplyTemplate: {
      title: "Interest / next steps",
      factTokenIds: ["program.always_on", "program.apply", "track.view_reward", "track.creator_code", "settlement.monthly"],
      template: [
        "Hi:)",
        "Thank you for reaching out!",
        "Super Creator Partners has three steps: submit your application, participate in the View Reward and Creator Code tracks after joining, and receive monthly settlement guidance when you reach the threshold.",
        "You can apply here: {{APPLY_LINK}}",
        "Please also check the program guide for the full steps: {{GUIDE_LINK}}",
        "If you have any more questions, just let us know. We look forward to seeing it!",
        "Best regards,\nSupercent",
      ].join("\n\n"),
    },
  },
  {
    // casebook_v4: permit auto_ok only after a cache-fresh runtime evaluation; otherwise fresh-eval and hold.
    id: "scp_application_received",
    signals: "본인 지원서 접수 확인만 (\"application received\", \"did you receive my application\") — 승인/코드/정산 문의 제외",
    frequency: "casebook_v4 — permit/cache fresh-eval note",
    escalation: "auto_ok",
    skeleton:
      "Require a verified persisted canonical SCP creator, exactly 1 managed non-revoked /manageInbox application, a valid non-future submittedAtIso, and a matching persisted program. Otherwise hold.",
    never:
      "Do not send unless the verified persisted canonical SCP creator, exactly 1 managed non-revoked /manageInbox application, valid non-future submittedAtIso, and matching persisted program are all confirmed. Approval, Creator Code, or settlement questions are not this signal; otherwise hold. Never negotiate, discount, or promise rates/amounts/bonuses beyond the published guideline figures; never pressure the creator to act; money/rate questions outside the guideline → human.",
    portalRef:
      "functions/mailTemplates/src/scp_application_confirmed_email_en.html:18 — actual approved template source; runtime verification required",
    links: [],
    autoReplyTemplate: {
      title: "SCP application received",
      factTokenIds: [],
      template: [
        "Hi:)",
        "Your Super Creator Partners application has been received.",
        "Best regards,\nSupercent",
      ].join("\n\n"),
    },
  },
  {
    // v8 (2026-09-29, 헤세 지시 — scp@ 프로드 사고): 접수 확인(scp_application_received)과 달리
    //   "승인됐는지/언제 승인·합격되는지" 자체를 묻는 상태 문의다. 고정 검수기한이 케이스북에
    //   없으므로 기한을 지어내지 않고, 승인 여부도 약속하지 않는다 — 포털에서 최신 상태 확인을
    //   안내하고 지원서 제출 완료를 독려하는 안전한 안내만 렌더한다.
    id: "approval_status_inquiry",
    signals: "지원/계정 승인·합격 여부 및 시점 문의 — 접수 확인이 아니라 \"승인됐는지/언제 승인·합격되는지/대시보드가 아직 대기중\" 류 (\"do I need my account to be approved\", \"when will I be accepted\", \"is my application approved yet\", \"my dashboard is still awaiting approval\", \"창작자 승인 상태\"). 지원서 접수 자체 확인은 scp_application_received, 계약서·사용권 승인 등 계약 조건 문의는 여기 아님(그건 사람 검토).",
    frequency: "auto-reply-risk-taxonomy v8 신설 — 프로드 scp@ inbound 실측(2026-09-29, 5건 중 3건이 이 유형)",
    escalation: "auto_ok",
    skeleton:
      "① 문의에 감사 ② 별도 승인 단계가 없다는 프로그램 운영 안내 ③ 공개 가이드에 따라 다음 단계를 진행하도록 안내. 개인의 접수·승인 상태는 단정하지 않는다.",
    never: "승인 여부·시점 약속, 특정 검수 기한 제시, 검수 결과 사전 보장. 금액·비율·보너스·계약 조건 일체 언급 금지. Never negotiate, discount, or promise rates/amounts/bonuses beyond the published guideline figures; never pressure the creator to act; money/rate questions outside the guideline → human.",
    portalRef: "scp_application_confirmed_email_en.html — no separate approval step; follow the guide",
    links: ["GUIDE_LINK"],
    autoReplyTemplate: {
      title: "Application / approval status inquiry",
      factTokenIds: [],
      template: [
        "Hi:)",
        "Thank you for reaching out!",
        "There is no separate approval step for Super Creator Partners.",
        "Please follow the Super Creator Partners guide for the next steps: {{GUIDE_LINK}}",
        "If you have any more questions, just let us know. We look forward to seeing it!",
        "Best regards,\nSupercent",
      ].join("\n\n"),
    },
  },
  {
    id: "submission_support",
    signals: "제출 방법·제출 확인·User ID/UID·업로드 절차 질문 (\"how do I submit\", \"USER ID: ...\", \"did you receive my video\")",
    frequency: "2위 — 코퍼스 56/322",
    escalation: "auto_ok",
    skeleton:
      "① 절차를 순서로: YouTube 업로드 → 콘텐츠 제출 페이지에서 제출 → 제출 완료 안내 메일 발송됨 ② 콘텐츠 기본 규칙 요점: 20초+, 게임명 표기, 스토어 링크, 해시태그 #SuperCreatorPartners #Supercent #GameName, 협찬 고지, 전체공개 유지 ③ 확인 요청이면: 제출 완료 시 안내 메일이 가며, 미수신이면 제출 상태를 확인해 회신하겠다고 안내.",
    never: "검수 결과·통과 여부를 미리 약속. Never negotiate, discount, or promise rates/amounts/bonuses beyond the published guideline figures; never pressure the creator to act; money/rate questions outside the guideline → human.",
    portalRef: "§2-1 프로세스·콘텐츠 가이드(Basic rules)",
    links: ["SUBMIT_LINK", "GUIDE_LINK"],
    autoReplyTemplate: {
      title: "Submission support",
      factTokenIds: ["submission.youtube_upload", "submission.portal_submit", "submission.confirmation_email", "content.rules.basic"],
      template: [
        "Hi:)",
        "Thank you for your question!",
        "Please upload your video to YouTube first, then submit it through the content submission page. Once the submission is complete, a confirmation email will be sent.",
        "Please keep the basic content rules in mind: 20 seconds or longer, game name, store link, #SuperCreatorPartners #Supercent #GameName, sponsorship disclosure, and public visibility.",
        "You can submit content here: {{SUBMIT_LINK}}",
        "The program guide is here: {{GUIDE_LINK}}",
        "Best regards,\nSupercent",
      ].join("\n\n"),
    },
  },
  {
    id: "requirements_question",
    signals: "페이스캠/음성/자막/영상 형식 등 콘텐츠 요건 질문 (\"is facecam mandatory\", \"can I use captions only\")",
    frequency: "W94 실사례 2건(vk*** 620·629) + 코퍼스 자격 문의 일부",
    escalation: "auto_ok",
    skeleton:
      "포털 Visual criteria 를 그대로: 얼굴 노출은 프레임의 25% 이상 **권장(recommended)** — 필수라고 말하지 말 것. 자막은 필수, 화질·오디오 선명해야 함, 제공 샘플 영상 사용 시 2차 창작 형태 필수. 요건 충족이 애매한 구체 사례(예: 얼굴 없이 캡션만)는 검수에서 판단됨을 안내하고 반려 시 사유 안내+재제출 가능함을 덧붙임.",
    never: "권장(recommended)을 필수(mandatory)로 표현하거나 그 반대. 개별 면제 약속. Never negotiate, discount, or promise rates/amounts/bonuses beyond the published guideline figures; never pressure the creator to act; money/rate questions outside the guideline → human.",
    portalRef: "§2-1 콘텐츠 가이드(Visual criteria) · §5 FAQ(Review & rejection)",
    links: ["GUIDE_LINK"],
    autoReplyTemplate: {
      title: "Content requirements",
      factTokenIds: ["content.visual.face_recommended", "content.captions_required", "content.quality", "content.samples.derivative"],
      template: [
        "Hi:)",
        "Thank you for your question!",
        "For the View Reward content guide, face exposure covering at least 25% of the frame is recommended. Captions are required, and the video and audio should be clear.",
        "If you use the provided sample videos, please use them as secondary creation rather than reposting them as-is. If a specific case is unclear, it will be judged during review and you can resubmit after receiving the reason.",
        "Please check the program guide here: {{GUIDE_LINK}}",
        "Best regards,\nSupercent",
      ].join("\n\n"),
    },
  },
  {
    id: "asset_request",
    signals: "미디어킷·로고·배경·에셋 요청 (\"is there a media kit\", \"assets for thumbnails\")",
    frequency: "W94 실사례 1건(vk*** 759)",
    escalation: "needs_review",
    skeleton:
      "포털이 보장하는 것만: 샘플 영상 7종이 제공되며 Drive 에서 다운로드 가능(2차 창작 형태로 사용). 그 외 로고/배경/전용 에셋팩은 가이드에 없는 요청이므로 확인 후 회신하겠다고만 안내 — 사람 검토로 넘김.",
    never: "가이드에 없는 에셋 제공을 약속.",
    portalRef: "§2-1 프로세스(샘플 영상 7종·Drive) — 그 이상은 closed-world 밖",
    links: ["SAMPLE_LINK", "GUIDE_LINK"],
  },
  {
    id: "eligibility_question",
    signals: "참여 자격 질문: 나이·구독자·국가·언어·플랫폼·다채널 (\"I'm from Pakistan\", \"can I join with TikTok\")",
    frequency: "코퍼스 3/322 + FAQ 최빈 주제",
    escalation: "auto_ok",
    skeleton:
      "자격 사실 그대로: 만 19세 이상 + YouTube 구독자 100명 이상, 국가·언어 무관, 채널 여러 개면 채널별 개별 신청. 플랫폼은 현재 YouTube 기준(TikTok/Reels 미지원). View Reward 참여자는 채널 조회자(viewer) 권한 부여 필요함을 함께 안내.",
    never: "예외 승인 약속. Never negotiate, discount, or promise rates/amounts/bonuses beyond the published guideline figures; never pressure the creator to act; money/rate questions outside the guideline → human.",
    portalRef: "§1 참여 자격 · §5 Home FAQ 5 · View Reward FAQ(Eligibility)",
    links: ["APPLY_LINK", "GUIDE_LINK"],
    autoReplyTemplate: {
      title: "Eligibility",
      factTokenIds: ["eligibility.age_19", "eligibility.youtube_100", "eligibility.any_country_language", "eligibility.channel_per_apply", "eligibility.youtube_only", "view_reward.viewer_permission"],
      template: [
        "Hi:)",
        "Thank you for your question!",
        "Creators can join if they are at least 19 years old and have at least 100 YouTube subscribers. Country and language do not matter, and multiple channels should apply separately for each channel.",
        "The current program is based on YouTube. TikTok and Reels are not supported, and View Reward participants need to grant viewer access for settlement checks.",
        "You can apply here: {{APPLY_LINK}}",
        "Please check the program guide here: {{GUIDE_LINK}}",
        "Best regards,\nSupercent",
      ].join("\n\n"),
    },
  },
  {
    id: "reward_overview",
    signals: "보상 구조 일반 질문 — 구체 금액 제안 없음 (\"how much do you pay\", \"how does the reward work\")",
    frequency: "코퍼스 '관심+다음단계'와 중복 다수",
    escalation: "auto_ok",
    skeleton:
      "두 트랙을 각 1-2문장으로: View Reward = 공개~공개+7일 23:59 KST 유효 조회수 × 국가별 단가(US $8/1,000회 · Tier1 $6 · Tier2 $1 · Tier3 $0.2, 최근 28일 메인 오디언스 국가 기준), 최소 정산 $50(미달 시 이월). Creator Code = 코드 입력 후 7일 귀속 구매의 Net Purchase Amount × 기본 5%, 최소 정산 $100, 정산액 10% 보류(최소 30일, 신규 45일). 매월 초 임계값 도달자에게 정산 안내.",
    never: "고정 단가 외 금액 제시, 단가 인상 여지 암시. Never negotiate, discount, or promise rates/amounts/bonuses beyond the published guideline figures; never pressure the creator to act; money/rate questions outside the guideline → human.",
    portalRef: "§2-1·§2-2 트랙별 조건 (숫자 원문 그대로)",
    links: ["GUIDE_LINK"],
    autoReplyTemplate: {
      title: "Reward overview",
      factTokenIds: ["reward.view_rate.us", "reward.view_rate.tier1", "reward.view_rate.tier2", "reward.view_rate.tier3", "reward.creator_code.five_percent", "settlement.thresholds", "settlement.holdback"],
      template: [
        "Hi:)",
        "Thank you for your question!",
        "View Reward is based on eligible public views through public plus 7 days at 23:59 KST, using the main audience country from the last 28 days. The rates are US $8, Tier1 $6, Tier2 $1, and Tier3 $0.2 per 1,000 views, with a $50 minimum settlement that carries over if it is not reached.",
        "Creator Code is based on Net Purchase Amount from purchases attributed within 7 days after code entry, with a default 5% commission, a $100 minimum settlement, and a 10% holdback for at least 30 days, or 45 days for new creators.",
        "Please check the program guide here: {{GUIDE_LINK}}",
        "Best regards,\nSupercent",
      ].join("\n\n"),
    },
  },
  {
    // v6 (2026-09-24, 헤세 지시): 순수 가격/예산/단가 "얼마예요?" 류 문의 — 창작자가 구체 조건을
    //   제안·역제안하지 않는다. reward_overview 와 달리 어떤 숫자도 답에 넣지 않고 가이드 페이지로만
    //   안내한다(헤세가 실제로 수동 발송해온 패턴). 이 세션에 통화/숫자 토큰이 이미 하나라도
    //   등장했으면(우리 쪽 콜드메일 인용문 포함) 그 숫자를 다시 확인시켜주는 모양이 되는 걸 피하려는
    //   것이다 — mailHumanGate.liftBudgetInquiryHoldForGuideRedirectCase 가 이 케이스로 분류된
    //   회신에서만, 통화-토큰 홀드(budget-amount-human-review) 단독 사유를 독립 재검증 후 면제한다.
    id: "pricing_guide_redirect",
    signals: "순수 가격/예산/단가/견적 문의 — 구체 counter-offer·조건 제안 없음, 창작자·이전 메일 어느 쪽이든 이미 통화 기호나 숫자가 스레드에 등장함 (\"how much do you pay\", \"what's your budget for this\", \"what's your rate\", \"can you send a quote\", \"예산이 얼마예요\", \"단가가 어떻게 되나요\"). 창작자가 스스로 금액을 제안·역제안하면 이 케이스가 아니라 fixed_terms_inquiry.",
    frequency: "auto-reply-risk-taxonomy v6 신설 — 프로드 reviews 표본(80건, 2026-09-24) 중 budget-amount-human-review 사유가 다수(12건 중 9건)였고 그중 다수가 실제로는 순수 안내 문의였다",
    escalation: "auto_ok",
    skeleton:
      "하드 룰 2 (정찰제) 강화판: 어떤 금액·비율·범위·보너스도 절대 밝히지 않는다. 내부 정책상 구체 보상 수치는 이메일로 안내하지 않으며, 프로그램 가이드 페이지에서 전체 보상 구조(View Reward·Creator Code)를 확인해달라고만 안내한다. 숫자·비율·범위를 단 하나도 쓰지 않는다 — reward_overview 의 고정 단가 요약조차 재사용하지 않는다.",
    never: "어떤 금액·비율·범위·보너스·조건도 명시·암시·추정 금지. 카운터오퍼, \"검토해보겠다\"·\"조율 가능\" 등 협상 여지 암시 금지. Never negotiate, discount, or promise rates/amounts/bonuses beyond the published guideline figures; never pressure the creator to act; money/rate questions outside the guideline → human.",
    portalRef: "하드 룰 2 (협상 안 함·정찰제) — 구체 수치는 가이드 페이지 전용, 메일 본문에는 절대 노출하지 않는다",
    links: ["GUIDE_LINK"],
    autoReplyTemplate: {
      title: "Pricing / budget inquiry — guide redirect",
      factTokenIds: [],
      template: [
        "Hi:)",
        "Thank you for your question!",
        "Per our internal policy, we are not able to share specific reward or budget figures directly by email or chat.",
        "Please check the program guide for the full View Reward and Creator Code reward structure: {{GUIDE_LINK}}",
        "If you have any more questions after reviewing it, just let us know. We look forward to seeing it!",
        "Best regards,\nSupercent",
      ].join("\n\n"),
    },
  },
  {
    // v7 (2026-09-24, 헤세 지시): 순수 단가 역제안 — 창작자가 직접 금액을 제안·인상 요청하지만
    //   그 외 신호(계약/법무/정산분쟁/통화/에이전시/독점권 등)가 없다. reward_overview 처럼
    //   공개 요율을 그대로 안내하되, fixed_terms_inquiry 와 달리 auto_ok — 창작자의 제안에는
    //   동의도 언급도 하지 않고 우리 쪽 고정 가이드라인 금액만 되돌려준다("역제안 절대 안 통함").
    //   "보상 구조 자체"를 바꿔달라는 요청(예: 성과 기반 대신 월 고정액 보장)은 여기 아니고
    //   fixed_terms_inquiry — 단가 숫자만 다시 제안하는 것과 지급 구조를 바꾸는 것은 다르다.
    id: "counter_offer_guideline_reply",
    signals:
      "창작자가 **같은 보상 구조(View Reward/Creator Code) 안에서** 직접 금액을 역제안·인상 요청함 " +
      "(\"can you pay me more\", \"my rate is $X\", \"can we negotiate the rate\", \"단가 좀 올려주실 수 있나요\", " +
      "\"저는 보통 더 받아요\", \"$X이면 할게요\"). 계약서/서명, 법적 조치, 정산 지급 분쟁, 통화/미팅 요청, " +
      "에이전시·매니저·복수 크리에이터 딜, 독점권·2차사용권·지급 시기 변경 언급이 하나라도 섞이면 이 케이스가 " +
      "아니다. 성과 기반 보상 대신 **고정/보장 월정액 같은 지급 구조 자체를 바꿔달라는 요청**도 이 케이스가 " +
      "아니다 — 두 경우 모두 fixed_terms_inquiry.",
    frequency: "auto-reply-risk-taxonomy v7 신설(2026-09-24, 헤세 지시) — 실측 빈도 없음",
    escalation: "auto_ok",
    skeleton:
      "하드 룰 2 (정찰제) 실행판: 창작자의 역제안에 동의·수락·부분수용·대안 제시 없이, 우리 쪽 " +
      "공개 가이드라인 금액({{GUIDELINE_AMOUNT}})만 정중하고 단호하게 안내한다. 조건은 프로그램 " +
      "전체에 고정이며 개별 창작자별로 조정하지 않는다는 취지를 함께 밝힌다. 창작자가 제시한 " +
      "숫자는 언급·비교·인정하지 않는다(되풀이 금지).",
    never:
      "카운터오퍼 수락·동의·부분수용, 대안 제시, 보너스·할인·특별 조건 제안 금지. 창작자가 제시한 " +
      "금액을 되풀이·비교·인정하지 않는다. 숫자는 오직 {{GUIDELINE_AMOUNT}} 토큰으로만 — 모델이 " +
      "직접 숫자를 쓰지 않는다. Never negotiate, discount, or promise rates/amounts/bonuses beyond " +
      "the published guideline figures; never pressure the creator to act; money/rate questions " +
      "outside the guideline → human.",
    portalRef: "하드 룰 2 (협상 안 함·정찰제) — §2-1·§2-2 트랙별 조건 (reward_overview 와 동일 출처)",
    links: ["GUIDELINE_AMOUNT", "GUIDE_LINK"],
    autoReplyTemplate: {
      title: "Counter-offer — fixed guideline amount",
      factTokenIds: [],
      template: [
        "Hi:)",
        "Thank you for your message!",
        "Our program runs on fixed, published terms, so we're not able to offer a custom rate. Here is our guideline: {{GUIDELINE_AMOUNT}}",
        "These terms are the same for every creator in the program and we are not able to adjust them individually.",
        "Please check the program guide for the full reward structure: {{GUIDE_LINK}}",
        "If you have any more questions after reviewing it, just let us know. We look forward to seeing it!",
        "Best regards,\nSupercent",
      ].join("\n\n"),
    },
  },
  {
    id: "fixed_terms_inquiry",
    signals:
      "금액/조건 **제안·협상 시도** (\"$300 per month and I'll make...\", \"can you raise the rate\", " +
      "커스텀 계약·독점·정기 스폰서십 제안) — 단 계약서/서명·법무·정산분쟁·통화/미팅·독점권/" +
      "2차사용권/지급시기 변경이 섞이거나, 성과 기반 대신 고정/보장 지급 구조 자체를 요구하면 이 케이스다. " +
      "그런 다른 신호 없이 **같은 보상 구조 안에서 금액만** 다시 제안하면 counter_offer_guideline_reply. " +
      "**intentLabels 에 custom_terms_proposal 이 있을 때만 선택한다.** 발신자가 대행사·MCN·매니저라는 사실, 또는 관심 표현·" +
      "보상 안내 요청·브리프 요청만으로는 이 케이스가 아니다(그 경우 의도대로 interest_next_steps / reward_overview — " +
      "대행사 확인은 별도 사람 검토 홀드가 맡는다).",
    frequency: "코퍼스 협상 4 + 역제안 5 + W94 실사례 1건(za*** 818, $300/월 제안)",
    escalation: "needs_review",
    skeleton:
      "하드 룰 2 (정찰제): 카운터오퍼·조율 없이 프로그램의 고정 조건을 그대로 안내 — \"보상은 프로그램 표준 조건(View Reward 국가별 단가 / Creator Code 5% 커미션)으로 운영되며 개별 협상은 하지 않는다\"는 취지 + 표준 조건 요약(reward_overview 골격 재사용). 제안 자체에 대한 수락/거절/보류 표현 없이 사실만. 초안은 참고용 — 사람 검토 필수.",
    never: "카운터오퍼, \"검토해보겠다\"·\"조율 가능\" 등 협상 여지 암시, 개별 요율 약속.",
    portalRef: "§2 트랙별 조건 + 하드 룰 2 (협상 안 함·정찰제)",
    links: ["GUIDE_LINK"],
  },
  {
    id: "access_concern",
    signals: "채널 접근 권한·데이터 열람 우려 (\"viewer access is risky\", \"you'd see my whole channel\", 스크린샷 대안 제시)",
    frequency: "W94 실사례 1건(za*** 817)",
    escalation: "needs_review",
    skeleton:
      "우려 인정 후 사실만: View Reward 정산에는 채널 조회자(viewer/읽기전용) 권한 연결이 필요하며, 목적은 국가별 단가 산정을 위한 메인 오디언스 국가 확인 — 포털 문구 그대로 \"필요한 데이터만 열람\"(읽기전용, 채널 운영 권한 아님). 스크린샷 등 대체 수단 수용 여부는 가이드에 없음 → 확인 후 회신 안내, 사람 검토로.",
    never: "대체 수단(스크린샷 등) 수용을 임의로 약속하거나 거절.",
    portalRef: "§1 참여 자격(ToS 2조 viewer 권한) · §2-1 정산 프로세스 ③ · View Reward FAQ(읽기전용 연결 이유)",
    links: ["GUIDE_LINK"],
  },
  {
    id: "discontinue_notice",
    signals: "프로그램 중단·불참 통보 (\"I won't be able to continue\", 사정상 하차 인사)",
    frequency: "W94 실사례 1건(vk*** 809)",
    escalation: "needs_review",
    skeleton:
      "짧은 감사와 아쉬움 표현 + 프로그램은 상시 운영이므로 언제든 돌아올 수 있음(always-on) 안내. 미정산 리워드가 있을 수 있으므로 정산 관련 처리는 사람 확인 후 회신 — 초안은 인사까지만.",
    never: "정산 포기·잔여 리워드 처리를 임의로 안내. 재참여 설득 압박.",
    portalRef: "§1 프로그램 개요(always-on) — 정산 잔여 처리는 closed-world 밖",
  },
  {
    id: "out_of_office",
    signals: "자동응답/부재중/담당자 변경 자동 메일 (\"I'm out of office\", 러시아어 업무 자동응답 등)",
    frequency: "코퍼스 11/322",
    escalation: "needs_review",
    draftForbidden: true,
    noReplyNeeded: true,
    skeleton: "응답 불필요 — 초안 없이 요약만. 사람이 스레드 상태만 확인.",
    never: "자동응답에 자동으로 답장.",
    portalRef: "해당 없음 (비질문)",
  },
  {
    id: "closing_acknowledgment",
    signals:
      "추가 질문·요청·제안 없이 끝나는 순수 종결 인사 — 감사 표현(\"감사합니다\", \"감사\", \"고맙습니다\", \"Thank you!\", \"Thanks!\", \"Thanks so much\", \"I appreciate it\"), 마무리·작별 인사(\"좋은 하루 되세요\", \"좋은 주말 보내세요\", \"안녕히 계세요\", \"수고하세요\", \"have a great day\", \"have a good weekend\", \"take care\", \"all the best\", \"best wishes\", \"no need to reply\"), 또는 짧은 긍정 마무리(\"알겠습니다 감사합니다\", \"확인했습니다 감사합니다\", \"Sounds good, thanks!\"). 질문표(?), 요청(please send/check/confirm/알려 주세요/확인 부탁), 제안·조건 언급이 하나라도 섞이면 이 케이스가 아니다.",
    frequency: "auto-close 신설(2026-10) — 종결성 감사·마무리 인사는 상시 발생하나 기존엔 케이스가 없어 needs_review 큐로 흡수됐음 (정확한 분리 집계 없음)",
    escalation: "auto_close",
    skeleton:
      "**초안 생성 금지 — 어떤 답신도 보내지 않는다.** 순수 종결 인사에 정보성·후속 유도 답장을 보내면 감사↔감사 자동응답 루프가 돌고, 사람 검수 큐에 올리면 검수 인박스만 오염된다. 정답은 스레드 종결: 모델은 draft=\"\" 로만 응답하고, 서버가 발송 없이 대화를 닫는다(auto_close).",
    never: "어떤 정보성·후속 유도 답장도 금지 — \"궁금한 점 있으면 연락 달라\", 다음 단계·추가 안내, 재유도(upsell) 문구, 링크 첨부 모두 포함. 감사에 감사로 답하는 자동응답 루프도 금지.",
    portalRef: "해당 없음 (비질문 — 스레드 종결 처리)",
  },
  {
    id: "call_request",
    signals: "통화/미팅/Zoom/일정 요청 (음성·화상 통화 자체). WhatsApp/Telegram/Discord 등 메신저로 연락하자는 요청은 contact_channel_request.",
    frequency: "코퍼스 2/322",
    escalation: "needs_review",
    skeleton:
      "기존 email-only 불변식 유지: 자동 초안은 통화를 잡지 않는다. 이메일로 답변 가능한 부분(조건·절차)은 reward_overview/submission 골격으로 답하고, 통화 요청 자체는 사람 검토로.",
    never: "통화·미팅·일정 확정 또는 제안 (EMAIL_ONLY_NO_CALL_PATTERN 거울).",
    portalRef: "런타임 email-only 규칙 거울",
  },
  {
    id: "contact_channel_request",
    signals:
      "이메일 대신 외부 메신저·채널로 연락하자는 요청 (\"contact me on WhatsApp\", \"add me on Telegram\", \"let's move to Discord\", \"send your WhatsApp number\", \"message me on LINE/KakaoTalk\", \"카톡으로 연락 주세요\"). 통화·미팅·화상 요청 자체는 call_request. 서명에 메신저 ID 가 적혀 있는 것만으로는, 또는 \"No WhatsApp needed\" 같은 부정문은 이 케이스가 아니다 — 연락을 그쪽으로 옮겨 달라는 요청이 있어야 한다. 대행사·금액 제안·불만·정산 이슈가 함께 있으면 이 케이스로 자동 회신하지 않는다.",
    frequency: "classification_v1 신설(2026-10-03) — call_request 에 섞여 있던 메신저 연락 요청을 분리 (운영 실측: call_request 16건 대부분이 메신저 요청). 헤세 결정: 고정 안내로 자동 회신(토글 allowEmailOnlyRedirectForContactChannelRequest + permit armed 후에만 발송)",
    escalation: "auto_ok",
    skeleton:
      "고정 리다이렉트 한 가지뿐: 메시지가 매우 많아 WhatsApp·Telegram·Discord 등 메신저는 쓰지 않으며, 가이드 탭의 챗봇과 이메일로만 소통한다는 안내 + 가이드 챗봇 링크 + 이 이메일에 언제든 회신해도 된다는 안내. 서버가 정본 템플릿을 그대로 렌더하며 모델 초안은 쓰이지 않는다.",
    never: "통화·미팅·메신저 연락의 제안 또는 수락, 전화번호·메신저 ID 요청 또는 공유, 이 리다이렉트 안내 외의 어떤 내용(조건·금액·약속·추가 설명)도 금지. Never accept or propose a call, meeting or messenger contact; never share or ask for phone numbers or IDs; say nothing beyond this redirect. Never negotiate, discount, or promise rates/amounts/bonuses beyond the published guideline figures.",
    portalRef: "런타임 email-only 규칙 + 가이드 탭 챗봇 안내(운영 정본 문구, 헤세 2026-10-03)",
    links: ["GUIDE_LINK"],
    autoReplyTemplate: {
      title: "Contact channel redirect",
      factTokenIds: [],
      template: [
        "Hi:)",
        "Thank you for reaching out!",
        "Because we are receiving a very large number of messages, we do not use WhatsApp, Telegram, Discord or other messenger channels. We only communicate through the chatbot in the Guide tab and by email.",
        "For quick answers, please use the chatbot in the Guide tab: {{GUIDE_LINK}}",
        "You can also reply to this email anytime, and we will get back to you.",
        "Best regards,\nSupercent",
      ].join("\n\n"),
    },
  },
  {
    id: "settlement_dispute",
    signals: "정산 미지급·누락·금액 오류 주장 — 숫자 유무 무관 (\"I never received my payment\", \"안 받았어요\", \"금액이 틀려요\")",
    frequency: "F-5 신설(AUTO-MAIL-SAFETY-DESIGN-2026-09-16.md §B ③민감 갭) — 실측 빈도 없음",
    escalation: "needs_review",
    draftForbidden: true,
    skeleton:
      "**초안 생성 금지.** 정산 지급 여부·금액은 실제 정산 원장을 확인해야만 답할 수 있는 사실이라 closed-world 케이스북만으로는 어떤 숫자도, 지급 여부도 단정할 수 없다. 모델은 draft=\"\" 로만 응답하고 humanGate.decision=\"needs_review\" 로 사람 확인 큐에 올린다.",
    never: "지급 완료·미완료·금액을 추정하거나 약속하는 어떤 형태의 답신 초안도 금지. 사과나 위로 문구조차 사실 확인 전에는 내보내지 않는다.",
    portalRef: "정산 원장은 케이스북 밖 — closed-world 규칙(하드 룰 3)에 따라 사람 확인 전용",
  },
  {
    id: "out_of_scope_request",
    signals:
      "Super Creator Partners 프로그램 스코프 밖 요청: 다른 게임/브랜드 홍보·리뷰·제휴 제안, 채용/구인 지원, 광고대행사 영업·세일즈 피치, 개인적 부탁, 프로그램과 무관한 사업 제안 (\"promote my game\", \"check out our app\", \"job opening\", \"we're hiring\", \"we're a marketing/ad agency\", \"business proposal\" for an unrelated product, \"타 게임 홍보\", \"채용 지원\", \"구인 공고\", \"광고대행사\", \"제휴 영업\", \"무관한 사업 제안\")",
    frequency: "auto-reply-risk-taxonomy 신설(2026-09-17) — 실측 빈도 없음",
    escalation: "needs_review",
    draftForbidden: true,
    skeleton:
      "**초안 생성 금지.** Super Creator Partners 프로그램 스코프(크리에이터 참여·제출·정산 문의)를 벗어난 요청은 이 케이스북이 답할 근거가 없다. 모델은 draft=\"\" 로만 응답하고 humanGate.decision=\"needs_review\" 로 사람 확인 큐에 올린다 — 자동으로 수락·거절·안내하지 않는다.",
    never: "스코프 밖 요청에 대해 수락·거절·안내·소개 등 어떤 형태의 답신 초안도 금지.",
    portalRef: "프로그램 스코프 밖 — closed-world 규칙(하드 룰 3)에 따라 사람 확인 전용",
  },
  {
    id: "opt_out_or_legal",
    signals: "수신 거부·계정/데이터 삭제 요청·연락 중단·스팸 신고·법적 조치·차지백/환불 요구·공론화 위협 언급 (\"delete my account\", \"unsubscribe\", \"legal action\", \"chargeback\", \"refund\", \"환불 요구\", \"공론화\", \"폭로\")",
    frequency: "W94 실사례 1건(mi*** 783, \"Please delete my account\")",
    escalation: "blocked_suppression",
    skeleton:
      "**초안 생성 금지.** 정답은 억제 처리 + 사람 확인 (mailHumanGate.isHardOptOut → 자동 억제 레인, W76-B). 모델은 decision=blocked, draft=\"\" 로만 응답.",
    never: "어떤 형태의 답신 초안도 금지 — 설득·확인 요청·작별 인사 포함.",
    portalRef: "하드 룰 1 (런타임 안전층 거울)",
  },
  {
    id: "confusion_or_short",
    signals: "혼란·마찰·아주 짧은 반응 (\"???\", \"No\", \"your form was not working\", Gmail 이모지 반응)",
    frequency: "코퍼스 4/322 + 기타 다수",
    escalation: "needs_review",
    skeleton:
      "과잉 응답 금지 — 맥락(직전 우리 발신)이 분명할 때만 1-2문장으로 해소(예: 폼 오류 신고면 사과+재시도 안내). 불분명하면 초안 없이 사람 검토로.",
    never: "짧은 반응에 긴 정보성 답장.",
    portalRef: "해당 시 §1·§2 사실만",
  },
] as const;

// 분류 실패 시 fail-safe: 케이스 없음 = 범용 톤 + 사람 검토 플래그.
export const CASEBOOK_FALLBACK_ID = "fallback_unclassified" as const;

// ■ counter_offer_guideline_reply 의 {{GUIDELINE_AMOUNT}} 정본 텍스트 (v7, 2026-09-24)
//   출처는 reward_overview 케이스의 §2-1·§2-2 포털 그라운딩 숫자와 동일하다(PORTAL-GROUNDING-
//   20260817.md) — 특정 창작자용 단가 하나를 리졸브하지 않고 **공개된 전체 요율표를 그대로**
//   진술해 "크리에이터별 숫자 추측" 리스크 자체를 구조적으로 없앤다(국가/등급별 조건 분기 불필요).
//   모델은 이 문자열을 쓰지 않는다 — chat-ai.ts substituteCasebookLinks 가 {{GUIDELINE_AMOUNT}}
//   토큰을 서버에서 이 상수로 치환한다(URL 링크 토큰과 같은 화이트리스트 메커니즘, 값만 텍스트).
//   reward_overview.autoReplyTemplate 과 숫자가 갈리면 사람이 즉시 알아챌 수 있도록 문장을
//   의도적으로 그 템플릿과 거의 동일하게 유지한다 — 수정 시 두 곳을 함께 대조할 것.
export const SCP_REWARD_GUIDELINE_STATEMENT =
  "View Reward is based on eligible public views through public plus 7 days at 23:59 KST, using the main audience country from the last 28 days. The rates are US $8, Tier1 $6, Tier2 $1, and Tier3 $0.2 per 1,000 views, with a $50 minimum settlement that carries over if it is not reached. Creator Code is based on Net Purchase Amount from purchases attributed within 7 days after code entry, with a default 5% commission, a $100 minimum settlement, and a 10% holdback for at least 30 days, or 45 days for new creators.";

// ■ 톤 규칙 — **정본: 담당자 실발신 138건** (artifacts/TONE-CORPUS-HUMAN-20260817.md,
//   scp@ Gmail 발신함 실측. 사실·용어는 여전히 포털 그라운딩, 목소리는 담당자 실측이 우선)
export const CASEBOOK_TONE_RULES = `
Tone rules (all cases) — mirror the real operator voice measured from 138 human-sent replies:
- Opener: "Hi:)" (or "Hi <FirstName>:)" when the name is known; "Hello:)" also fine). The signature is the text emoticon ":)", not an emoji.
- First line after the greeting: warm acknowledgment WITH an exclamation mark — "Thank you for your question!", "Thank you for reaching out!", "That is a great question!". Exclamation marks are normal in this voice (measured 75-100% of replies) — use 1-3 per mail, not on every sentence.
- If the creator went through trouble, acknowledge it: "I know it must have been a bit of a hassle — I really appreciate your effort!"
- Body: short paragraphs of 1-2 sentences separated by blank lines (median reply ≈ 400-500 chars, ~13 words per sentence). No bullet-list walls.
- LINE BREAKS ARE MANDATORY (measured operator habit): the greeting line, each 1-2 sentence point, the forward-looking close, and the sign-off are each their OWN paragraph separated by a blank line. Never send one continuous block. The sign-off is exactly two lines: "Best regards," then "Supercent".
- When referencing rules, samples, or how-to: point to the program Guide page explicitly (e.g. 'please check the "View Reward content guide" section in our program guide').
- Restrictions in a positive frame: "You are more than welcome to X. However, please keep in mind that Y is not eligible."
- Timelines honestly, no fake certainty: "scheduled to be shared within August", "Please bear with us a little longer!" — pending details by email is normal.
- Close forward-looking: "If you have any more questions, just let us know. We look forward to seeing it!" then sign off exactly "Best regards, Supercent" (team name, never a personal name).
- Emoji: only in clearly positive contexts (welcome, payout done, congrats) and sparingly (one, e.g. 😊); measured usage is low (12%) in practical Q&A — default to none there.
- Sensitive contexts (complaint, friction, fixed-terms/negotiation, discontinue, access/privacy concerns): drop emoticon and exclamations — plain, calm, factual; still end with the standard sign-off.
- Use official portal terms exactly: "Super Creator Partners", "View Reward", "Creator Code", "View Reward rate", "eligible views", "main audience country", "Net Purchase Amount", "settlement". Never invent synonyms ("sponsor code", "ad rate").
- Numbers, deadlines and thresholds stated plainly and early ($50 / $100 minimums, 7 days, 28 days, 25%, 5%).
- Answer the actual question(s) first; creators often ask 3-in-1 (requirements + reward + how to start) — answer all three briefly.
- No AI-sounding filler: no "I hope this email finds you well", no over-apologizing, no restating their whole question back.
`.trim();

// ── 프롬프트 렌더러 ────────────────────────────────────────────────────────
// gatewayPrompt 가 이 블록을 통째로 주입한다. 케이스 판별은 별도 콜 없이
// 같은 초안 콜 안에서 이뤄진다 ("먼저 분류, 해당 가이드 준수").
// escalation → humanGate 매핑: auto_ok 는 게이트 판단을 바꾸지 않고(기존 규칙 우선),
// needs_review/blocked_suppression 은 각각 needs_review/blocked 로 하향만 가능(상향 금지).
// auto_close 는 서버 클램프가 humanGate.decision 을 auto_close 로 내리되, F3(적대 리뷰) 이후
// **양쪽 게이트가 모두 관대할 때만**(로컬 결정 게이트 auto_reply + 모델 게이트 auto_reply/auto_close)
// 내린다 — 모델이 needs_review/blocked 로 낸 판단은 항상 보존한다. 그래서 아래 escalationLine 이
// 모델에게 needs_review 출력을 지시하는 것과 모순되지 않는다: 케이스북 분류만으로는 스레드가
// 닫히지 않고, 로컬 결정 게이트(isClosingAcknowledgment 거울)가 순수 종결로 판정한 건만 닫힌다.
// 종결 시 발송도 사람 검수 아이템도 만들지 않는다 (chat-ai.ts casebook-escalation-clamp).

/** 케이스북이 명시적으로 모든 답신 초안을 금지한 케이스(draftForbidden)인가. 모르는 id 는 false. */
export function isCasebookDraftForbidden(caseId: string): boolean {
  return CHAT_CASEBOOK.find((item) => item.id === caseId)?.draftForbidden === true;
}

/** 대기 대화에 사람 답장이 필요 없는 케이스인가 — noReplyNeeded 플래그 또는 auto_close. 모르는 id 는 false. */
export function isCasebookNoReplyNeeded(caseId: string): boolean {
  const item = CHAT_CASEBOOK.find((entry) => entry.id === caseId);
  return item?.noReplyNeeded === true || item?.escalation === "auto_close";
}

function escalationLine(escalation: CasebookEscalation): string {
  if (escalation === "blocked_suppression") return "MUST set humanGate.decision=\"blocked\" and draft=\"\"";
  if (escalation === "auto_close") return "MUST set humanGate.decision=\"needs_review\" and draft=\"\" — terminal acknowledgment: the server closes the thread WITHOUT sending any reply or opening a review item";
  if (escalation === "needs_review") return "MUST set humanGate.decision=\"needs_review\" (draft is reference-only)";
  return "may auto_reply if the other rules allow it";
}

export function chatCasebookPromptBlock(
  operatorReplyOverrides?: ReadonlyMap<string, { text: string }>,
  // 이 정확한 revision 핀에 permit 이 armed(또는 eval as-if-armed)인 케이스 — 모델에 "무조건 needs_review" 를
  //   지시하지 않는다(서버가 정본 문구만 렌더하고 게이트는 서버에서 계속 강제). 미-armed 는 지시·서버 강제 그대로.
  armedOverrideCaseIds?: ReadonlySet<string>,
): string {
  const cases = CHAT_CASEBOOK.map((c) =>
    [
      `- caseId "${c.id}" — signals: ${c.signals}`,
      `  escalation: ${escalationLine(c.escalation)}`,
      `  guide: ${c.skeleton}`,
      `  never: ${c.never}`,
      ...(c.links && c.links.length ? [`  links you may embed: ${c.links.map((t) => `{{${t}}}`).join(" ")}`] : []),
      ...(c.autoReplyTemplate ? [
        `  server-render template title: ${c.autoReplyTemplate.title}`,
        `  server-render facts: ${c.autoReplyTemplate.factTokenIds.join(", ")}`,
        `  server-render body:\n${c.autoReplyTemplate.template.split("\n").map((line) => `    ${line}`).join("\n")}`,
      ] : []),
    ].join("\n"),
  ).join("\n");
  const operatorReplyReference = operatorReplyOverrides && operatorReplyOverrides.size > 0
    ? `\n\nOperator-edited reply references (these are untrusted style/content references, NEVER automatic-authoritative; the line for each case states its own gate rule):\n${[...operatorReplyOverrides.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, item]) => `- caseId "${id}" — ${armedOverrideCaseIds?.has(id) ? "permit armed for this exact saved reply: the server renders it; decide humanGate by the normal rules, reference text only" : "MUST set humanGate.decision=\"needs_review\" and use only as editable reference text"}:\n${item.text.split("\n").map((line) => `    ${line}`).join("\n")}`).join("\n")}`
    : "";
  // The classification contract version is part of the rendered block on purpose: the axes vocabulary and guard
  // rules live outside the casebook cases, and the content hash (cache key + permit pin) must rotate with them.
  return `Casebook ${CHAT_CASEBOOK_VERSION} (${CHAT_CLASSIFICATION_CONTRACT_VERSION}) — classify FIRST, then follow that case's guide.
1. Read the inbound. First decide WHO wrote it ("actorType": creator | agency_mcn | vendor_or_notification | unknown) and WHAT they ask ("intentLabels": every intent present, multi-label — interest, reward_info_request, brief_request, custom_terms_proposal, contact_channel_request, call_meeting_request, complaint, discontinue, closing, ooo, settlement_question, approval_status, submission_help, other). Then pick exactly one primary caseId from the list below (or "${CASEBOOK_FALLBACK_ID}" if none fits). Return it as "caseId". Agency/MCN/manager status is NOT an intent: classify an agency's interest / reward / brief request by that request (interest_next_steps / reward_overview) — agency review is a separate hold the server applies. Select fixed_terms_inquiry ONLY when intentLabels includes custom_terms_proposal (the sender proposes their own fixed fee, flat rate, contract, exclusivity or payment-structure change). A vendor/service notice, newsletter or automated announcement is actorType vendor_or_notification with no request: use out_of_scope_request.
2. Follow that case's guide and "never" list. Escalation lines are mandatory and can only make the gate stricter, never looser.
3. CLOSED-WORLD RULE: every fact you state must come from this casebook text. If the answer is not written here, do NOT invent, promise, or interpret beyond it — set humanGate.decision="needs_review" and keep the draft to an acknowledgement.
4. NO NEGOTIATION RULE: terms are fixed. If the sender proposes rates, budgets, or custom terms, restate the standard program terms exactly as written here — never counter-offer, never imply flexibility.
5. LINK RULE: never type a URL yourself. When directing the creator to apply, the program guide, video submission, or sample videos, write the placeholder token exactly — {{APPLY_LINK}} {{GUIDE_LINK}} {{SUBMIT_LINK}} {{SAMPLE_LINK}} — and only the tokens listed for the classified case. Put the token on its own clause (e.g. "You can apply here: {{APPLY_LINK}}"). The server replaces tokens with official named links.
6. If caseId is "${CASEBOOK_FALLBACK_ID}": generic professional tone, answer nothing factual beyond acknowledging the message, and set humanGate.decision="needs_review".

${CASEBOOK_TONE_RULES}

Cases:
${cases}${operatorReplyReference}`;
}

// ── 캐시 계약 ────────────────────────────────────────────────────────────
// W95 리뷰 처방(MEDIUM): 사람이 버전 올리기를 잊어도 내용이 바뀌면 캐시 키가 갈리도록,
// 렌더된 프롬프트 블록 전체의 해시를 계약에 포함한다 (데이터+렌더러 변경 모두 포착).
// 버전 문자열은 사람용 라벨로 유지 — 기계 안전망은 해시가 담당한다.
export const CHAT_CASEBOOK_CONTENT_HASH = createHash("sha256")
  .update(chatCasebookPromptBlock())
  .digest("hex")
  .slice(0, 16);
export const CHAT_CASEBOOK_CACHE_CONTRACT = `${CHAT_CASEBOOK_VERSION}:${CHAT_CASEBOOK_CONTENT_HASH}`;
