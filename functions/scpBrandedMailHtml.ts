// SCP 브랜디드 메일 최소 템플릿 (W7-3e).
//
// 정본 마스터(`functions/mailTemplates/src/scp_application_confirmed_email_en.html`,
// `content_submitted_email_en.html`)의 **구조만** 재사용한다: 600px 다크 셸 · 좌측 워드마크 자리 ·
// 우측 프로그램 라벨 · 그라디언트 히어로 · #141414 본문/푸터 카드. 마스터 파일을 복사하지 않는다 —
// 104KB HTML 사본은 원본이 갱신될 때마다 어긋나는 복사본이고(하드룰: 복사 금지, 읽기 시점 조인),
// 히어로 base64 자산까지 복제하면 메일 크기만 커진다.
//
// 이 셸은 지금까지 html 이 아예 없던 레인(onboarding · video_result)과 확인 메일 HTML 을 공유하던
// 레인(uid_guide)의 **전용 HTML** 을 만드는 데 쓴다. 운영자가 `scp_mail_templates/{kind}` 문서를
// 발행하면 그 문서가 이기고, 문서가 없으면 이 셸로 만든 코드 기본값이 fallback 이다(fail-closed).

const FONT_STACK =
  "Pretendard, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Apple SD Gothic Neo', 'Malgun Gothic', Arial, sans-serif";

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * 텍스트를 HTML 로 넣기 전에 이스케이프한다. `{{var}}` 토큰은 영숫자·밑줄뿐이라 영향받지 않으므로
 * 셸 안에서도 그대로 남고, 실제 값 치환은 상위 렌더러(replaceReceiptHtmlPlaceholders)가 escape 한다.
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPE[character] ?? character);
}

export type ScpBrandedMailContent = {
  /** 히어로 제목 한 줄. */
  readonly heading: string;
  /**
   * 본문 단락. 운영자 템플릿 본문처럼 신뢰할 수 없는 문자열도 허용된다(이스케이프됨).
   * 단락 안의 단일 개행은 `<br>` 로 보존되고, 평문 https URL 은 앵커가 된다 — 발송 텍스트 파트가
   * html 에서 파생되므로(F2) 여기서 구조를 잃으면 수신자가 보는 텍스트가 뭉개진다.
   */
  readonly paragraphs: readonly string[];
  /** 단일 CTA 버튼. href 는 `{{var}}` 토큰이거나 https URL 이어야 한다. */
  readonly cta?: { readonly label: string; readonly href: string } | null;
  /** 푸터 위 마무리 문장. */
  readonly closing?: readonly string[];
};

// 평문 URL 을 앵커로 바꾼다. 이스케이프는 조각별로 따로 한다 — 먼저 통째로 이스케이프하면
// 쿼리스트링의 `&` 가 `&amp;` 로 바뀐 뒤 URL 판정이 흔들린다.
const BARE_URL_RE = /https?:\/\/[^\s<>"']+/g;

function linkifyEscaped(text: string): string {
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(BARE_URL_RE)) {
    const start = match.index ?? 0;
    output += escapeHtml(text.slice(cursor, start));
    const url = match[0];
    output += `<a href="${escapeHtml(url)}" style="color:#8ab4ff; text-decoration:underline;">${escapeHtml(url)}</a>`;
    cursor = start + url.length;
  }
  return output + escapeHtml(text.slice(cursor));
}

/** 단락 하나. 단일 개행은 `<br>` 로 남겨 텍스트 파트에서도 줄이 유지된다. */
function paragraphBlock(text: string): string {
  const body = text
    .split("\n")
    .map((line) => linkifyEscaped(line))
    .join("<br>");
  return `<div style="font-family:${FONT_STACK}; font-size:15px; line-height:1.7; color:#e4e4e4; padding-bottom:14px;">${body}</div>`;
}

function ctaBlock(cta: { label: string; href: string }): string {
  // F2: 버튼 아래에 URL 을 평문으로 한 번 더 찍던 줄은 없앴다. 텍스트 파트는 앵커에서
  // `라벨 [주소]` 로 파생되므로 주소는 이미 남고, HTML 파트에서는 클릭 가능한 앵커만 남는다.
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;">',
    '<tr><td align="left">',
    `<a href="${escapeHtml(cta.href)}" style="display:inline-block; font-family:${FONT_STACK}; font-size:14px; font-weight:700; color:#ffffff; background-color:#605bf8; border-radius:12px; padding:12px 22px; text-decoration:none;">${escapeHtml(cta.label)}</a>`,
    "</td></tr>",
    "</table>",
  ].join("");
}

/** 마스터 구조를 따르는 최소 브랜디드 HTML. 새 디자인을 만들지 않는다. */
export function buildScpBrandedMailHtml(content: ScpBrandedMailContent): string {
  const paragraphs = content.paragraphs.filter((line) => line.trim().length > 0).map(paragraphBlock).join("");
  const closing = (content.closing ?? [])
    .filter((line) => line.trim().length > 0)
    .map((line) => escapeHtml(line))
    .join("<br>");
  return [
    // F1: `<!DOCTYPE html>`/html/head/title/body 를 넣지 않는다. mailCompiler 의 ALLOWED_TAGS
    // (mailCompiler.ts:41-46)에 그 태그들이 없어서 sanitize 가 **태그만 벗기고 텍스트는 남긴다** —
    // 그래서 <title> 문구가 compiledHtml 선두와 파생 텍스트 첫 줄에 평문으로 새어 나갔다.
    // 메일 본문은 조각(fragment)으로 넘기고 문서 골격은 메일 클라이언트에 맡긴다.
    //
    // F2: preheader(숨김 미리보기 줄)도 넣지 않는다. `display:none` 은 HTML 렌더에만 통하고
    // html→text 파생에는 통하지 않아서, 수신자의 텍스트 파트 첫 줄이 본문과 중복됐다.
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0b0b0b">',
    '<tr><td align="center" style="padding:0 12px;">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%;">',
    // Header — 마스터와 같은 좌측 워드마크(텍스트) / 우측 프로그램 라벨.
    '<tr><td style="padding:24px 8px 20px 8px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>',
    `<td align="left" translate="no" class="notranslate" style="font-family:${FONT_STACK}; font-size:16px; font-weight:800; color:#ffffff;">Supercent</td>`,
    `<td align="right" translate="no" class="notranslate" style="font-family:${FONT_STACK}; font-size:13px; font-weight:500; color:#b0b0b0;">Super Creator Partners</td>`,
    "</tr></table>",
    "</td></tr>",
    // Hero — 마스터의 그라디언트 히어로(캐릭터 base64 자산은 싣지 않는다).
    '<tr><td align="left" bgcolor="#605bf8" style="border-radius:20px 20px 0 0; padding:36px 28px 32px 28px; background-image:linear-gradient(180deg, #605bf8 0%, #926cf9 100%);">',
    // F2: eyebrow 가 제목과 같은 문구면 텍스트 파트에서 같은 줄이 두 번 보인다 — 그때는 뺀다.
    content.heading.trim() === "Super Creator Partners"
      ? ""
      : `<div translate="no" class="notranslate" style="font-family:${FONT_STACK}; font-size:12px; font-weight:700; letter-spacing:0.12em; color:rgba(255,255,255,0.85); text-transform:uppercase; padding-bottom:14px;">Super Creator Partners</div>`,
    `<div style="font-family:${FONT_STACK}; font-size:28px; line-height:1.3; font-weight:900; color:#ffffff; letter-spacing:-0.02em;">${escapeHtml(content.heading)}</div>`,
    "</td></tr>",
    // Body
    '<tr><td style="padding:28px 28px 8px 28px; border:1px solid #2a2a2e; border-top:none; border-bottom:none;" bgcolor="#141414">',
    paragraphs,
    content.cta ? ctaBlock(content.cta) : "",
    "</td></tr>",
    // Footer
    '<tr><td style="padding:20px 28px 40px 28px; border-radius:0 0 20px 20px; border:1px solid #2a2a2e; border-top:none;" bgcolor="#141414">',
    closing
      ? `<div style="font-family:${FONT_STACK}; font-size:13px; line-height:1.8; color:#b0b0b0;">${closing}</div>`
      : "",
    `<div style="font-family:${FONT_STACK}; font-size:14px; font-weight:700; color:#ffffff; padding-top:18px;">Thank you.<br>The Supercent Team</div>`,
    `<div style="font-family:${FONT_STACK}; font-size:11px; color:#737373; padding-top:22px; line-height:1.7;"><span translate="no" class="notranslate">&#169; Supercent, Inc. &#183; Super Creator Partners</span></div>`,
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
  ].join("\n");
}
