import { createHash } from "node:crypto";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { nudgeProgramMailTemplateBaseKind } from "./scpReceiptMailTemplates";

export type MailSuppressionLookup = {
  email?: string;
  handle?: string;
  name?: string;
  category?: string;
  platform?: string;
  domain?: string;
  text?: string;
};

export type MailSuppressionHit = {
  blocked: boolean;
  ref?: string;
  matchedField?: "email" | "handle" | "domain" | "text";
  reason?: string;
  ruleId?: string;
  /**
   * W72-C R1 HIGH-2: 이 수신자에게 **예외로 뚫을 수 없는 억제**가 하나라도 있는가.
   * first-hit 만 보면 infly 뒤에 숨은 수신거부를 놓쳐 실수신자에게 메일이 나간다.
   */
  hasNonExemptibleRule?: boolean;
};

function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeSuppressionEmail(value: unknown): string {
  const email = normalizeToken(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 240) : "";
}

export function suppressionEmailDomain(email: string): string {
  const normalized = normalizeSuppressionEmail(email);
  const at = normalized.lastIndexOf("@");
  return at >= 0 ? normalized.slice(at + 1) : "";
}

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "nate.com",
  "qq.com",
  "163.com",
  "126.com",
  "proton.me",
  "protonmail.com",
]);

const KNOWN_GAME_COMPANY_DOMAINS = new Set([
  "supercell.com",
  "riotgames.com",
  "ea.com",
  "ubisoft.com",
  "nintendo.com",
  "nintendo.co.jp",
  "sony.com",
  "playstation.com",
  "xbox.com",
  "activision.com",
  "blizzard.com",
  "epicgames.com",
  "steampowered.com",
  "valvesoftware.com",
  "tencent.com",
  "neteasegames.com",
  "bandainamcoent.com",
  "square-enix.com",
  "sega.com",
  "konami.com",
  "capcom.com",
  "take2games.com",
  "2k.com",
  "zynga.com",
  "king.com",
  "mihoyo.com",
  "hoyoverse.com",
  "roblox.com",
]);

export const INFLY_OVERLAP_RULE_ID = "mail-safety.infly-overlap";
export const GAME_COMPANY_RULE_ID = "mail-safety.game-company-blacklist";
// chat-ai.ts의 Chat 수동 답장 콜러블(src/app/(app)/chat/page.tsx의 sendEmail 호출)이 싣는 intent 값.
// 여기·chat-ai.ts 양쪽이 이 상수 하나를 쓴다 — 문자열이 갈라지면 예외가 조용히 죽는다.
export const CHAT_MANUAL_REPLY_INTENT = "chat_manual_reply";
// W117 R1 CRITICAL 수리: 서버 소유 표식 필드명. chat-ai.ts의 enrichChatManualReplyData가
// **검증에 성공했을 때만** 세팅한다. sendEmail 콜러블 입구는 외부 요청에서 이 필드를
// NUDGE_INTERNAL_PROVENANCE_FIELD와 같은 방식으로 strip한다 — 그렇지 않으면 요청 페이로드에
// 이 이름의 필드를 그대로 실어 검증을 건너뛸 수 있다(리뷰어 값 확인: fromRole:"ai"로 보내면
// isChatManualReply가 false가 되어 enrichChatManualReplyData가 검증 없이 원본 data를
// 그대로 통과시키므로, strip이 없으면 위조 플래그가 evaluateMailSafety까지 살아 남는다).
export const MANUAL_INBOUND_REPLY_VERIFIED_FIELD = "manualInboundReplyVerified";

function normalizeDomain(value: unknown): string {
  const raw = normalizeToken(value);
  const domain = raw.includes("@") ? suppressionEmailDomain(raw) : raw;
  return domain.replace(/^www\./, "").slice(0, 240);
}

function flattenedDomain(value: string): string {
  return value.replace(/[^a-z0-9]/g, "");
}

function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain);
}

function domainLooksLikeGameCompany(domain: string): boolean {
  if (!domain || isFreeMailDomain(domain)) return false;
  if (KNOWN_GAME_COMPANY_DOMAINS.has(domain)) return true;
  const compact = flattenedDomain(domain);
  return (
    /(?:^|[a-z0-9])gamestudios?(?:[a-z0-9]|$)/.test(compact) ||
    /(?:^|[a-z0-9])gamedev(?:[a-z0-9]|$)/.test(compact) ||
    /(?:^|[a-z0-9])gamepublisher(?:[a-z0-9]|$)/.test(compact) ||
    /(?:^|[a-z0-9])publisher(?:[a-z0-9]|$)/.test(compact) ||
    /(?:^|[a-z0-9])interactive(?:[a-z0-9]|$)/.test(compact) ||
    /(?:^|[a-z0-9])entertainment(?:[a-z0-9]|$)/.test(compact) ||
    /(?:^|[a-z0-9])games(?:[a-z0-9]|$)/.test(compact)
  );
}

function textLooksLikeGameCompany(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return (
    /\b(?:game|games|gaming|video game|mobile game)\s+(?:studio|studios|developer|development|publisher|publishing|company|companies|agency|maker|makers)\b/i.test(normalized) ||
    /\b(?:studio|studios|developer|development|publisher|publishing|company|companies|agency)\s+(?:for\s+)?(?:game|games|gaming|video game|mobile game)\b/i.test(normalized) ||
    /\b(?:indie|mobile|video)\s+game\s+(?:studio|developer|publisher)\b/i.test(normalized) ||
    /\b(?:inc|ltd|limited|llc|corp|corporation|co\.?\s*ltd|company|gmbh|sas|s\.a\.|pty|bv|oy|ab)\b.*\b(?:game|games|studio|publisher|developer|interactive|entertainment)\b/i.test(normalized) ||
    /\b(?:game|games|studio|publisher|developer|interactive|entertainment)\b.*\b(?:inc|ltd|limited|llc|corp|corporation|co\.?\s*ltd|company|gmbh|sas|s\.a\.|pty|bv|oy|ab)\b/i.test(normalized) ||
    /(?:株式会社|有限会社|合同会社).*(?:ゲーム|ゲーミング|開発|スタジオ|パブリッシャー)/u.test(text) ||
    /(?:ゲーム|ゲーミング|開発|スタジオ|パブリッシャー).*(?:株式会社|有限会社|合同会社)/u.test(text) ||
    /(?:게임사|게임\s*회사|게임\s*개발사|개발사|퍼블리셔|퍼블리싱|게임\s*스튜디오|스튜디오).*?(?:법인|회사|주식회사)?/u.test(text)
  );
}

export function evaluateGameCompanySuppression(input: MailSuppressionLookup): MailSuppressionHit | null {
  const email = normalizeSuppressionEmail(input.email);
  const domain = normalizeDomain(input.domain) || suppressionEmailDomain(email);
  const text = [
    input.name,
    input.handle,
    input.category,
    input.platform,
    input.text,
    domain,
  ].map((value) => typeof value === "string" ? value : "").join(" ");
  const domainBlocked = domainLooksLikeGameCompany(domain);
  const textBlocked = textLooksLikeGameCompany(text);
  const officialGameBrandBlocked = Boolean(
    domain
    && !isFreeMailDomain(domain)
    && /\bofficial\s+(?:channel|page|account|youtube)\b/i.test(text)
    && /\b(?:game|games|gaming|mobile game|android game|ios game|rpg|strategy rpg)\b/i.test(text),
  );
  if (!domainBlocked && !textBlocked && !officialGameBrandBlocked) return null;
  return {
    blocked: true,
    matchedField: domainBlocked ? "domain" : "text",
    reason: "게임사·게임 개발사·퍼블리셔로 판단되어 콜드메일 발송을 차단합니다.",
    ruleId: GAME_COMPANY_RULE_ID,
  };
}

export function normalizeSuppressionHandle(value: unknown): string {
  return normalizeToken(value).replace(/^@/, "").slice(0, 160);
}

export function mailSuppressionDocId(kind: "email" | "domain" | "handle" | "channel", value: string): string {
  const normalized = normalizeToken(value);
  const digest = createHash("sha1").update(`${kind}\0${normalized}`).digest("hex").slice(0, 24);
  return `suppress_${kind}_${digest}`;
}

/**
 * 억제가 아직 유효한가.
 *
 * W76-② R3-P0: `released` 가 빠져 있어서 **해제 콜러블이 무해한 no-op 였다** —
 *   문서에는 status:"released" 가 찍히는데 이 술어가 그걸 여전히 active 로 읽어
 *   findMailSuppression 은 계속 blocked=true 를 냈다. 해제 경로를 만들 때 이 술어를
 *   같이 안 고치면 "되돌릴 수 있다"는 약속만 있고 실제로는 아무도 못 돌아온다.
 *   (문서 필드만 검사한 테스트는 이걸 못 잡는다 — 아래 행위 테스트가 정본이다.)
 */
function activeSuppression(data: Record<string, unknown>): boolean {
  const status = normalizeToken(data.status);
  return status !== "inactive"
    && status !== "resolved"
    && status !== "expired"
    && status !== "released";
}

/**
 * 억제 문서 데이터가 **현재 active** 인지 — `email in (...)` 같은 배치 조회로 가져온
 * 문서를 호출자 쪽에서 로컬 판정할 때 쓰는 얇은 export 래퍼다. 판정 정본은 위
 * activeSuppression 하나다(두 번째 구현을 만들지 않는다 — W72-C 의 "갈라진 구현 금지"
 * 교훈). campaignCandidateMigration.ts 가 대량 억제 조인에 사용한다.
 */
export function isActiveMailSuppressionDoc(data: Record<string, unknown>): boolean {
  return activeSuppression(data);
}

async function findByDocId(kind: "email" | "handle", value: string): Promise<MailSuppressionHit | null> {
  if (!value) return null;
  const snap = await adminDb.collection("mail_suppressions").doc(mailSuppressionDocId(kind, value)).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  if (!activeSuppression(data)) return null;
  return {
    blocked: true,
    ref: snap.ref.path,
    matchedField: kind,
    reason: typeof data.reason === "string" && data.reason ? data.reason : "기존 억제 목록과 일치합니다.",
    ruleId: typeof data.ruleId === "string" && data.ruleId ? data.ruleId : "mail-safety.suppressed-contact",
  };
}

/** 한 페이지 크기. 상한이 아니라 **페이지 단위**다 — 커서로 끝까지 훑는다. */
const SUPPRESSION_SCAN_PAGE_SIZE = 50;

/**
 * W72-C R2 HIGH-1: **정본 억제 조회기.** 임의 상한 없이 active hit 를 전량 순회한다.
 *
 * 종전 `limit(10)` 은 fail-open 이었다 — active 11건 중 11번째가 수신거부면 그 사람에게
 * 메일이 나간다(리뷰어 값 재현). 상한을 없애되 비용은 **단락 중단**으로 잡는다:
 * 예외로 뚫을 수 없는 규칙을 만나는 순간 즉시 멈춘다. 단락이 **차단 방향**이라 안전하다
 * (더 훑어도 결론이 "차단"에서 바뀔 수 없다).
 *
 * 이 함수가 유일한 조회 구현이다. 갈라진 구현이 이번 라운드 내내 결함의 온상이었다 —
 * scpMail 의 별개 구현도 이 함수를 쓴다(도메인 축 포함).
 */
export type MailSuppressionScan = {
  readonly hits: MailSuppressionHit[];
  readonly nonExemptible: MailSuppressionHit | null;
};

/**
 * W72-C R3 HIGH-1: **도메인 축은 명시 스코프 문서만 본다.**
 *
 * 프로드 실측(전량 12,378건): `domain` 필드는 6,891건이 갖고 있는데 **domain-only 문서는 0건**이다.
 * 즉 지금 저장된 domain 값은 전부 "이 이메일의 도메인"이라는 **부가 정보**이지
 * "이 도메인 전체를 막아라"라는 억제가 아니다(gmail.com 만 4,837건 — 전부 개인 이메일 문서).
 *
 * 그런데 도메인 축으로 조회하면 그 문서들이 전부 잡힌다. 결과가 두 가지 병리다:
 *   ① 교차수신자 오판 — 다른 gmail 사용자의 hard-bounce 가 우리 대상을 차단한다.
 *   ② 읽기 폭증 — 이메일 1건 조회에 12,001 reads / 242 순차 쿼리(리뷰어 재현).
 *
 * 도메인 억제의 **실사용이 0** 이므로, 도메인 축을 `scope: "domain"` 을 명시한 문서 전용으로
 * 새로 정의한다. 기존 데이터는 그 필드가 없으므로 도메인 축에 걸리지 않는다 —
 * 이메일/핸들 축은 종전 그대로라 실제 억제력은 하나도 줄지 않는다.
 */
export const MAIL_SUPPRESSION_DOMAIN_SCOPE = "domain" as const;

export async function scanActiveMailSuppressions(
  checks: ReadonlyArray<readonly ["email" | "handle" | "domain", string]>,
): Promise<MailSuppressionScan> {
  const hits: MailSuppressionHit[] = [];
  for (const [kind, value] of checks) {
    if (!value) continue;
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (;;) {
      const collection = adminDb.collection("mail_suppressions");
      // 도메인 축만 **명시 스코프** 조건을 더한다. 이 조건이 없으면 같은 도메인의
      //   개인 이메일 문서 전부가 잡혀 교차수신자 오판 + 읽기 폭증이 난다(R3 HIGH-1).
      const scoped = kind === "domain"
        ? collection.where("domain", "==", value).where("scope", "==", MAIL_SUPPRESSION_DOMAIN_SCOPE)
        : collection.where(kind, "==", value);
      let query = scoped.orderBy(FieldPath.documentId()).limit(SUPPRESSION_SCAN_PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const snap = await query.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        const data = doc.data() ?? {};
        if (!activeSuppression(data)) continue;
        const hit: MailSuppressionHit = {
          blocked: true,
          ref: doc.ref.path,
          matchedField: kind,
          reason: typeof data.reason === "string" && data.reason ? data.reason : "기존 억제 목록과 일치합니다.",
          ruleId: typeof data.ruleId === "string" && data.ruleId ? data.ruleId : "mail-safety.suppressed-contact",
        };
        hits.push(hit);
        // 차단 방향 단락 — 더 훑어도 결론이 바뀌지 않는다.
        if (hit.ruleId !== INFLY_OVERLAP_RULE_ID) return { hits, nonExemptible: hit };
      }
      if (snap.size < SUPPRESSION_SCAN_PAGE_SIZE) break;
      cursor = snap.docs[snap.docs.length - 1];
    }
  }
  return { hits, nonExemptible: null };
}

export async function findMailSuppression(input: MailSuppressionLookup): Promise<MailSuppressionHit> {
  const gameCompany = evaluateGameCompanySuppression(input);
  if (gameCompany) return gameCompany;
  const email = normalizeSuppressionEmail(input.email);
  const handle = normalizeSuppressionHandle(input.handle);
  // W72-C R1 HIGH-2: **first-hit 즉시 반환은 진짜 차단 사유를 가린다.**
  //   같은 이메일에 infly-overlap 과 수신거부/반송/수동 등재가 공존할 때 infly 가 먼저 잡히면,
  //   독려 예외가 그 hit 하나만 보고 발송을 허용한다 — 수신거부자에게 메일이 나간다.
  //   그래서 **모든 active hit 를 모아** 평가하고, infly 가 아닌 것이 하나라도 있으면 그것을
  //   대표 hit 로 돌려준다(예외가 뚫지 못하는 사유가 항상 우선한다).
  const directHits: MailSuppressionHit[] = [];
  for (const [kind, value] of [
    ["email", email],
    ["handle", handle],
  ] as Array<["email" | "handle", string]>) {
    const direct = await findByDocId(kind, value);
    if (direct) directHits.push(direct);
  }
  const directNonExemptible = directHits.find((hit) => hit.ruleId !== INFLY_OVERLAP_RULE_ID) ?? null;
  const scan = directNonExemptible
    ? { hits: directHits, nonExemptible: directNonExemptible }
    : await scanActiveMailSuppressions([["email", email], ["handle", handle]]);
  const hits = [...directHits, ...scan.hits];
  if (hits.length === 0) return { blocked: false };
  const nonExemptible = directNonExemptible ?? scan.nonExemptible;
  const representative = nonExemptible ?? hits[0];
  return {
    ...representative,
    // 예외 판정이 "이 사람에게 infly 말고 다른 억제도 있는가"를 알 수 있어야 한다.
    hasNonExemptibleRule: Boolean(nonExemptible),
  };
}

/**
 * W62d-D [리더 지시 · infly-overlap 트랜잭셔널 예외]
 *
 * infly-overlap 억제의 목적은 **콜드 접촉의 중복 노출 방지**다. 그런데 실측에서 이 억제가
 * 지원자 **본인이 신청해서 발생한** 확인 메일 28건을 막고 있었다(W62-3 A3). 억제의 목적과
 * 정반대 상황이다 — 본인이 요청한 거래성 메일까지 "중복 노출"로 취급한 것이다.
 *
 * 그래서 **거래성(transactional) purpose 에 한해서만** 이 규칙을 비켜 간다.
 * 판단을 호출자 플래그에 맡기지 않고 **purpose 로 서버가 정하는** 이유: 플래그는 아웃리치
 * 경로에서도 실릴 수 있고, 그러면 콜드메일이 억제를 우회한다. 목록을 좁게 유지한다.
 *
 * 하드바운스·불만·역할계정은 **절대 예외 대상이 아니다** — 그 셋은 수신자 의사와 실패 이력에서
 * 온 억제다. 이 함수는 infly-overlap 하나만 다룬다.
 */
const TRANSACTIONAL_MAIL_PURPOSES = new Set([
  "application_confirmed",
  "application_video_reminder",
  // Task-100 F-6: 반려 후 재제출 독려. application_video_reminder(코호트2)와 같은 경로로 드레인
  // 되는 receipt-outbox 레인이다(reserved-outbox drain, 스윕이 아니다) — 등록하지 않으면 발송의
  // ~89%가 infly-overlap 에 걸려 suppressed 된다(코호트①③ 실측치와 같은 축, 이 파일 하단
  // NUDGE_INFLY_EXEMPT_PURPOSE_TEMPLATE_KINDS 주석 참고). 이 purpose 는 본인이 반려당한 제출 건에
  // 대한 응답이라 콜드 접촉이 아니다.
  "resubmission_nudge",
  // W105(헤세 장애 보고 2026-08-18): 콘텐츠 제출 확인·검수 결과 메일이 이 지도에 빠져
  // infly-overlap 에 걸렸다(실측: 콘텐츠 확인 43건 중 18건 suppressed — 형제 레인 2종은
  // 등재돼 있어 정상 발송). 본인이 제출해서 발생한 거래성 메일이라 같은 축의 예외다.
  // 옵트아웃·바운스·불만 억제는 계속 막는다(mailSuppressionBlocksSend 는 infly-overlap 만 연다).
  "content_submitted",
  "video_result_mail",
  // 헤세 확정(26-08-27, 대화형 승인): 로그인 승인·반려 안내도 본인 지원이 유발한 거래성 메일이다 —
  // 실측: 일괄 처리 21건 중 9건(승인 8·반려 1)이 infly-overlap 에 걸려 suppressed(W105 와 동일 축,
  // 당시 콘텐츠 확인 18/43건과 같은 패턴). 개별 대조 결과 해당 프리픽스 버킷에 수신거부·법적조치
  // 클래스 0건, 바운스·역할계정은 이 예외의 범위 밖이라 계속 차단된다.
  "login_approved",
  "login_rejected",
]);

/**
 * W62e-MAJ2 [독립 델타]: purpose 만 보면 **호출자가 공급하는 문자열 하나**로 억제를 우회할 수 있다.
 * 임의 호출부가 `mailPurpose: "application_confirmed"` 를 실으면 콜드메일도 예외를 탄다.
 *
 * 그래서 세 가지를 **함께** 요구한다:
 *   ① purpose 가 거래성 목록에 있고
 *   ② sourceRef 가 **영수증 아웃박스 문서 경로**이고(=드레인이 실제 아웃박스 행을 처리 중)
 *   ③ templateKind 가 그 purpose 와 일치한다
 * 셋 다 맞아야 예외가 열린다. 하나라도 호출자가 지어내면 나머지가 걸린다.
 */
const RECEIPT_OUTBOX_COLLECTIONS = new Set([
  "scp_application_confirmed_mail_outbox",
  "scp_application_video_reminder_outbox",
  "scp_content_submitted_mail_outbox",
  "scp_video_result_mail_outbox",
  "scp_login_approved_mail_outbox",
  "scp_login_rejected_mail_outbox",
  // Task-100 F-6: resubmissionNudgeMail.ts 드레인의 아웃박스 컬렉션.
  "scp_resubmission_nudge_mail_outbox",
]);

/** purpose ↔ templateKind 대응. 둘이 어긋나면 거래성으로 보지 않는다. (W105: 검수 결과 메일은
 * mailKind 3종이 templateKind 로 오므로 허용 집합으로 확장 — 서버 드레인만 이 값을 싣는다.) */
const TRANSACTIONAL_PURPOSE_TEMPLATE_KINDS: Record<string, ReadonlySet<string>> = {
  application_confirmed: new Set(["scp_application_confirmed"]),
  application_video_reminder: new Set(["application_video_reminder"]),
  content_submitted: new Set(["content_submitted"]),
  video_result_mail: new Set(["content_approved", "content_changes_requested", "content_rejected"]),
  login_approved: new Set(["login_approved"]),
  // 반려는 사유별 templateKind 2종 — 드레인만 이 값을 싣는다(scpOutboxMailWorkers).
  login_rejected: new Set(["login_rejected_subscriber_minimum", "login_rejected_channel_not_found"]),
  // Task-100 F-6.
  resubmission_nudge: new Set(["resubmission_nudge_en"]),
};

export function isTransactionalMailPurpose(value: unknown): boolean {
  return typeof value === "string" && TRANSACTIONAL_MAIL_PURPOSES.has(value);
}

function isReceiptOutboxSourceRef(value: unknown): boolean {
  if (typeof value !== "string") return false;
  // `<collection>/<docId>` 형태여야 한다 — 컬렉션 이름만 포함된 임의 문자열은 통과시키지 않는다.
  const [collection, ...rest] = value.split("/");
  return RECEIPT_OUTBOX_COLLECTIONS.has(collection) && rest.length === 1 && rest[0].length > 0;
}

/**
 * W72-C [헤세 결정 2026-08-13] — **독려 코호트①③ 은 infly-overlap 규칙의 예외다.**
 *
 * 근거(리더 실측): `infly-db-import` 고유 이메일 6,580 중 우리가 실제 발송한 5,984명과
 * 5,340명(발송의 89%)이 겹친다 — 콜드 레인은 이 규칙 등재(2026-06-29) 이후에도 계속 발송해 왔다.
 * 즉 이 규칙은 "이미 Infly DB 에 있으니 **첫 콜드 접촉**을 하지 마라"는 뜻이고,
 * 이미 콜드메일을 받은 사람에게 보내는 **후속 독려**는 그 취지의 대상이 아니다.
 *
 * ■ 스코프를 좁힌 지점 (이 세 가지가 전부 맞을 때만 예외다)
 *   ① ruleId 가 `mail-safety.infly-overlap` 일 때만 — 수신거부·반송·불만·수동 등재는 **그대로 차단**
 *   ② mailPurpose 가 독려 코호트①③ purpose 일 때만
 *   ③ templateKind 가 그 purpose 에 대응하는 독려 문안일 때만(purpose 만 위조해도 안 열린다)
 *   콜드·확인메일 등 다른 purpose 의 동작은 **문자 그대로 불변**이다.
 */
const NUDGE_INFLY_EXEMPT_PURPOSE_TEMPLATE_KINDS: Record<string, string> = {
  nudge_cohort1_read_no_reply: "scp_nudge_cohort1_read_no_reply_en",
  nudge_cohort3_unread_no_reply: "scp_nudge_cohort3_unread_no_reply_en",
};

/**
 * W72-C R1 HIGH-3: **서버 소유 표식**. 스윕 내부 경로만 이 값을 넣는다.
 * 공용 `sendEmail` 콜러블은 입구에서 이 필드를 strip 하므로, 요청 본문에 purpose/kind 두
 * 문자열을 맞춰 넣어도 예외가 열리지 않는다(위조 차단).
 */
export const NUDGE_INTERNAL_PROVENANCE = "w72.nudge-sweep.internal" as const;
export const NUDGE_INTERNAL_PROVENANCE_FIELD = "nudgeInternalProvenance" as const;

export function allowsNudgeInflyOverlap(data: Record<string, unknown>): boolean {
  // ① 서버 소유 표식이 있어야 한다(콜러블 입구에서 제거되므로 외부에서 못 넣는다).
  if (data[NUDGE_INTERNAL_PROVENANCE_FIELD] !== NUDGE_INTERNAL_PROVENANCE) return false;
  const purpose = typeof data.mailPurpose === "string" ? data.mailPurpose : "";
  const expectedKind = NUDGE_INFLY_EXEMPT_PURPOSE_TEMPLATE_KINDS[purpose];
  if (!expectedKind) return false;
  const actualKind = typeof data.templateKind === "string" ? data.templateKind : "";
  // 0.6.110: 프로그램 전용 독려 문안(`scp_nudge_<slug>_cohortN_..._en[_wN]`)은 같은 purpose 의 같은
  //   base 문안이다 — base 와 정확히 같은 경우만 열던 종전 규칙을 이 형상에만 넓힌다.
  //   (기존 `_wN` 키에는 적용하지 않는다 — 기존 동작 불변.)
  return actualKind === expectedKind || nudgeProgramMailTemplateBaseKind(actualKind) === expectedKind;
}

/**
 * W72-C R1 HIGH-1/2: **예외의 최종 판정 한 곳.** 두 발송 경로가 이 함수만 쓴다.
 *   · 예외 대상 규칙(infly-overlap)이 아니면 차단
 *   · 같은 수신자에게 예외 불가 억제가 하나라도 있으면 차단(first-hit 마스킹 방지)
 *   · 독려 표식·purpose·templateKind 가 전부 맞아야 통과
 */
export function nudgeInflyExemptionApplies(input: {
  ruleId: string;
  hasNonExemptibleRule: boolean;
  data: Record<string, unknown>;
}): boolean {
  if (input.ruleId !== INFLY_OVERLAP_RULE_ID) return false;
  if (input.hasNonExemptibleRule) return false;
  return allowsNudgeInflyOverlap(input.data);
}

/**
 * W117 [헤세 장애 보고 2026-09-03, R1 CRITICAL 수리 반영] — **운영자 수동 답장은
 * infly-overlap 의 취지 밖이다.**
 *
 * infly-overlap 은 "이미 Infly DB 에 있으니 **첫 콜드 접촉**을 하지 마라"는 뜻이다(위
 * NUDGE 예외 주석 참고). 그런데 Chat 화면에서 운영자가 크리에이터의 **기존 회신**에 수동으로
 * 답장하는 것은 콜드 접촉이 아니다 — 상대가 먼저 말을 건 채널이다. 실사고: 프로덕션 실측으로
 * 억제 문서 956/970건이 infly-db-import(infly-overlap)이었고, 운영자가 그런 수신자에게 답장을
 * 보내려 하자 "기존 억제 목록과 일치하여 발송을 차단합니다" 로 막혔다(chat-ai.ts의 sendEmail이
 * allowInflyOverlap 을 안 줬다).
 *
 * 스코프(네 가지 전부 맞을 때만 열린다):
 *   ① ruleId 가 infly-overlap 일 때만 — 수신거부·법적조치·bounce·게임사 블랙리스트는 그대로 차단
 *   ② 같은 수신자에게 예외 불가 억제가 없을 때만(hasNonExemptibleRule)
 *   ③ `mode === "manual_send"` 일 때만. **이게 실제 방어의 핵심이다** — R1 CRITICAL 리뷰가
 *      잡은 우회: `intent`/`manualInboundReplyVerified` 두 필드만 보고 mode 를 안 보면,
 *      외부 요청이 `fromRole:"ai"`(→ mode="auto_send")와 함께 두 필드를 흉내 내는 것만으로
 *      `isChatManualReply`(chat-ai.ts, mode==="manual_send" 를 요구)를 우회해
 *      `enrichChatManualReplyData` 의 실제 검증(원본 대조)을 건너뛰고도 여기서 예외가 열렸다.
 *      mode 를 필수로 요구하면 그 우회 조합(auto_send + 위조 플래그)은 ①에서 걸리지 않아도
 *      여기서 막힌다.
 *   ④ `data[MANUAL_INBOUND_REPLY_VERIFIED_FIELD] === true` 일 때만. 이 필드는 **서버 소유
 *      표식**이다 — `sendEmail` 콜러블 입구가 `NUDGE_INTERNAL_PROVENANCE_FIELD` 와 같은 방식으로
 *      외부 요청에서 이 필드를 strip 하므로(chat-ai.ts:sendEmail 앞부분), 요청 페이로드가
 *      이 이름의 필드를 직접 실어도 도달하지 않는다. 그 후 `enrichChatManualReplyData` 가
 *      **실제 inbound 메일과 대조해 검증에 성공했을 때만** 이 필드를 다시 세팅한다. mode 필수(③)와
 *      이 strip(④)이 **함께** 있어야 위조가 막힌다 — 하나만 있으면 위 우회가 재현된다(R1 CRITICAL
 *      리뷰가 mode 단독 부재로 이걸 재현했다).
 */
export function chatManualReplyInflyExemptionApplies(input: {
  ruleId: string;
  hasNonExemptibleRule: boolean;
  mode: string;
  data: Record<string, unknown>;
}): boolean {
  if (input.ruleId !== INFLY_OVERLAP_RULE_ID) return false;
  if (input.hasNonExemptibleRule) return false;
  if (input.mode !== "manual_send") return false;
  return (
    input.data.intent === CHAT_MANUAL_REPLY_INTENT
    && input.data[MANUAL_INBOUND_REPLY_VERIFIED_FIELD] === true
  );
}

/**
 * W62e-MAJ2: 거래성 예외의 **최종 판정**. 호출부는 이 함수 하나만 쓴다.
 */
export function allowsTransactionalInflyOverlap(data: Record<string, unknown>): boolean {
  const purpose = typeof data.mailPurpose === "string" ? data.mailPurpose : "";
  if (!isTransactionalMailPurpose(purpose)) return false;
  if (!isReceiptOutboxSourceRef(data.sourceRef)) return false;
  const expectedKinds = TRANSACTIONAL_PURPOSE_TEMPLATE_KINDS[purpose];
  const actualKind = typeof data.templateKind === "string" ? data.templateKind : "";
  return Boolean(expectedKinds) && expectedKinds.has(actualKind);
}

export function mailSuppressionBlocksSend(
  suppression: MailSuppressionHit,
  options: { allowInflyOverlap?: boolean } = {},
): boolean {
  if (!suppression.blocked) return false;
  return !(options.allowInflyOverlap === true && suppression.ruleId === INFLY_OVERLAP_RULE_ID);
}
