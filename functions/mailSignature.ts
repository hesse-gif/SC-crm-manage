import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import sanitizeHtml from "sanitize-html";
import { adminDb, adminRuntimeEnvironment } from "./firebaseAdmin";
import { expireAt180DaysFromIso } from "./firestoreTtl";
import { asRecord, asString, assertNonGuestAuth, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { enqueueScpLifecycleRefreshEvent } from "./scpLifecycleProfiles";
import { lazyConversationMailAccessScope, resolveConversationMailAccessScope } from "./conversationMailAccessScope";
import { resolveViewAsTarget } from "./mailAccountCallables";
import { canReadScpConversationRowForOrg, isExplicitScpMailAccountRow } from "./mailConversationAuthorization";
import { envEmail } from "./opsDefaults";
import {
  isStrictScpProviderConfirmed,
  SCP_RESULT_PROVIDER_VERIFIED_MIGRATION_MARKER,
} from "./scpResultMailDelivery";
import {
  MAIL_SANITIZE_ALLOWED_STYLES,
  OFFICIAL_MAIL_IMAGE_HTTPS_HOSTS,
  artifactFromCompiledHtml,
  compileMailArtifact,
  sanitizeMailHtml,
  type MailArtifact,
  type MailCompileInput,
} from "./mailCompiler";
import { MAIL_ASSET_CID_SRC_RE } from "./mailAssets";

// 아웃바운드 메일 공통 서명 + 열람(오픈) 트래킹 픽셀.
//
// - 서명: settings/mail_signature 문서로 내용을 운영에서 덮어쓸 수 있고, 문서가 없으면
//   공홈(supercent.io) 자산 기반 기본 서명을 쓴다. 이미지는 회사 CDN을 직접 참조한다
//   (cdn-official-site.supercent.io — 핫링크 보호 없음 확인, 2026-07-03).
// - 픽셀: 수신자가 메일을 열면 mailOpenPixel HTTP 엔드포인트가 1x1 GIF를 서빙하며
//   mail_open_events에 기록한다. tid(trackingId)만 전달 — 본문/주소 원문은 절대
//   URL에 싣지 않는다 (SEC-P0-009).

export const SIGNATURE_MARKER = "data-flu-signature";
export const SIGNATURE_TAGLINE =
  "Hyper-casual & Hybrid games loved by 400M+ players worldwide";
export const SIGNATURE_ADDRESS =
  "9th Floor, Lotte World Tower, 300 Olympic-ro, Songpa-gu, Seoul, Supercent";
// 정본은 mailCompiler(컴파일 sanitize와 공유) — 기존 소비자를 위해 재노출한다.
export const SIGNATURE_ALLOWED_HTTPS_HOSTS = OFFICIAL_MAIL_IMAGE_HTTPS_HOSTS;
const PIXEL_PATH = "mailOpenPixel";
// 메일에 실리는 공개 호스트. 이미지 자산과 같은 도메인을 쓴다(프로젝트 ID 비노출).
const MAIL_PUBLIC_HOST = "sc-flu.web.app";
const OPEN_EVENTS_COLLECTION = "mail_open_events";
const SIGNATURE_SETTINGS_REF = "settings/mail_signature";
const SIGNATURE_AUDIT_COLLECTION = "mail_signature_audits";
const TRACKING_ID_RE = /^[A-Za-z0-9_-]{4,120}$/;
const SIGNATURE_HOSTS = new Set<string>(SIGNATURE_ALLOWED_HTTPS_HOSTS);
// 서명 "링크"(사이트/게임 CTA 목적지)는 이미지 자산과 달리 공식 스토어 랜딩도 허용한다.
// 이미지 허용목록(SIGNATURE_HOSTS)에는 절대 합치지 않는다 — 이미지는 회사 소유 호스트로만
// 제한되어야 한다. Task-33: DEFAULT_SIGNATURE.games[].linkUrl 이 Google Play 링크로 바뀌었는데
// (d2e3a9c8) 이 allowlist가 그대로였던 게 write 모드 invalid-argument의 근인이었다.
const SIGNATURE_LINK_HOSTS = new Set<string>([
  ...SIGNATURE_ALLOWED_HTTPS_HOSTS,
  "play.google.com",
  "apps.apple.com",
]);
const TRUSTED_OUTBOUND_ALLOWED_TAGS = [
  "a", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2",
  "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre",
  "s", "span", "strong", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
  "u", "ul",
];
const TRUSTED_OUTBOUND_ALLOWED_ATTRIBUTES: Record<string, Array<string | { name: string; values: string[] }>> = {
  "*": ["style"],
  a: ["href", "target", "rel", "style"],
  img: ["src", "alt", "width", "height", "style"],
  // 컴파일러(ALLOWED_ATTRIBUTES)와 동일한 이메일 표현 속성 — 발송 단계에서
  // 레이아웃이 다시 벗겨지지 않도록 두 sanitize 허용목록을 정합시킨다.
  // role은 presentation 값만 — 레이아웃 테이블의 스크린리더 오독 방지(이메일 표준).
  table: ["width", "align", "bgcolor", "cellpadding", "cellspacing", "border", "style", { name: "role", values: ["presentation"] }],
  tr: ["align", "valign", "bgcolor", "style"],
  td: ["colspan", "rowspan", "width", "height", "align", "valign", "bgcolor", "style"],
  th: ["colspan", "rowspan", "width", "height", "align", "valign", "bgcolor", "style"],
};
const MAIL_SIGNATURE_FAILURE_CODES = {
  settingsRead: "mail_signature_settings_read_failed",
  outboxInvalidTrackingId: "mail_outbox_invalid_tracking_id",
  outboxWrite: "mail_outbox_write_failed",
  outboxLifecycleEnqueue: "mail_outbox_lifecycle_enqueue_failed",
  outboxReplyMemoize: "mail_outbox_reply_memoize_failed",
  openEventWrite: "mail_open_event_write_failed",
} as const;

type MailSignatureFailureCode =
  typeof MAIL_SIGNATURE_FAILURE_CODES[keyof typeof MAIL_SIGNATURE_FAILURE_CODES];

function correlationIdHash(scope: string, value: string): string {
  return createHash("sha256")
    .update(`${scope}\u0000${value}`)
    .digest("hex")
    .slice(0, 24);
}

function logMailSignatureFailure(
  errorCode: MailSignatureFailureCode,
  correlationHash: string,
): void {
  // Keep this payload deliberately closed: caught error objects/messages may
  // contain credentials, provider payloads, recipients, or tracking IDs.
  console.error("[mail-signature] operation failed", {
    errorCode,
    correlationIdHash: correlationHash,
  });
}

function safeMailSignatureError(
  message: string,
  errorCode: MailSignatureFailureCode,
  correlationHash: string,
  code: "invalid-argument" | "internal" = "internal",
): Error {
  return Object.assign(new Error(message), {
    code,
    errorCode,
    correlationIdHash: correlationHash,
  });
}

export type MailSignatureGame = {
  name: string;
  imageUrl: string;
  linkUrl: string;
};

/**
 * W111-B (헤세): 서명 하단 공식 채널 아이콘. 게임 카드와 같은 구조(name/imageUrl/linkUrl)를
 * 쓰지만 **고정 목록**이다 — 사용자가 임의 URL 을 넣을 수 있으면 서명이 외부 링크 배포 수단이
 * 된다. 그래서 normalizeSignatureInput 은 이 배열을 저장값에서 읽지 않고 항상 정본으로 덮는다.
 */
export type MailSignatureSocial = {
  name: string;
  imageUrl: string;
  linkUrl: string;
};

export type MailSignatureSettings = {
  senderName: string;
  senderTeam: string;
  senderEmail: string;
  siteUrl: string;
  logoUrl: string;
  tagline: string;
  games: MailSignatureGame[];
  socials: MailSignatureSocial[];
};

export const DEFAULT_SIGNATURE: MailSignatureSettings = {
  senderName: "Super Creator Partners",
  senderTeam: "",
  senderEmail: envEmail("FLU_DEFAULT_SIGNATURE_EMAIL"),
  siteUrl: "https://supercent.io",
  logoUrl: "https://sc-flu.web.app/scp-assets/scp-logo-black.png",
  tagline: SIGNATURE_TAGLINE,
  games: [
    {
      name: "XP Hero",
      imageUrl: "https://sc-flu.web.app/scp-assets/game-xp-hero.png",
      linkUrl: "https://play.google.com/store/apps/details?id=io.supercent.weaponrpg",
    },
    {
      name: "Age of Dinosaurs",
      imageUrl: "https://sc-flu.web.app/scp-assets/game-dinosaur-universe.png",
      linkUrl: "https://play.google.com/store/apps/details?id=io.supercent.ageofdinosaurs",
    },
    {
      name: "Snake Clash",
      imageUrl: "https://sc-flu.web.app/scp-assets/game-snake-clash.png",
      linkUrl: "https://play.google.com/store/apps/details?id=io.supercent.linkedcubic",
    },
    {
      name: "Burger Please",
      imageUrl: "https://sc-flu.web.app/scp-assets/game-burger-please.png",
      linkUrl: "https://play.google.com/store/apps/details?id=io.supercent.burgeridle",
    },
    {
      name: "Pizza Ready",
      imageUrl: "https://sc-flu.web.app/scp-assets/game-pizza-ready.png",
      linkUrl: "https://play.google.com/store/apps/details?id=io.supercent.pizzaidle",
    },
  ],
  socials: [
    {
      name: "Supercent",
      imageUrl: "https://sc-flu.web.app/scp-assets/social-home.png",
      linkUrl: "https://supercent.io/",
    },
    {
      name: "YouTube",
      imageUrl: "https://sc-flu.web.app/scp-assets/social-youtube.png",
      linkUrl: "https://www.youtube.com/channel/UCB_NwEsoJQkEgzzqsjaPSpQ",
    },
    {
      name: "TikTok",
      imageUrl: "https://sc-flu.web.app/scp-assets/social-tiktok.png",
      linkUrl: "https://www.tiktok.com/@supercent.official",
    },
    {
      name: "Instagram",
      imageUrl: "https://sc-flu.web.app/scp-assets/social-instagram.png",
      linkUrl: "https://www.instagram.com/supercent_official/",
    },
  ],
};

type MailSignatureState = {
  settings: MailSignatureSettings;
  version: number;
  contentHash: string;
  exists: boolean;
};

async function readMailSignatureState(): Promise<MailSignatureState> {
  try {
    const snapshot = await adminDb.doc(SIGNATURE_SETTINGS_REF).get();
    if (!snapshot.exists) {
      return {
        settings: DEFAULT_SIGNATURE,
        version: 0,
        contentHash: signatureContentHash(DEFAULT_SIGNATURE),
        exists: false,
      };
    }
    const data = snapshot.data() ?? {};
    const settings = normalizeSignatureInput(data, "read");
    return {
      settings,
      version: storedSignatureVersion(data.version),
      contentHash: signatureContentHash(settings),
      exists: true,
    };
  } catch {
    logMailSignatureFailure(
      MAIL_SIGNATURE_FAILURE_CODES.settingsRead,
      correlationIdHash("mail_signature_settings", SIGNATURE_SETTINGS_REF),
    );
    return {
      settings: DEFAULT_SIGNATURE,
      version: 0,
      contentHash: signatureContentHash(DEFAULT_SIGNATURE),
      exists: false,
    };
  }
}

export async function readMailSignatureSettings(): Promise<MailSignatureSettings> {
  return (await readMailSignatureState()).settings;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 이메일 클라이언트 호환을 위해 table + inline style만 사용한다.
export function renderMailSignatureHtml(settings: MailSignatureSettings): string {
  const normalized = normalizeSignatureInput(settings, "read");
  const games = normalized.games
    .map(
      (game) => `
        <td style="padding:0 8px 0 0;vertical-align:top;">
          <a href="${escapeHtml(game.linkUrl)}" style="text-decoration:none;color:#111827;">
            <img src="${escapeHtml(game.imageUrl)}" alt="${escapeHtml(game.name)}" width="60" height="60" style="display:block;width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;" />
          </a>
        </td>`,
    )
    .join("");
  // W111-B (헤세): 공식 채널 아이콘 줄. 게임 카드(60px)보다 작게(24px) 두어 위계를 만든다.
  // 아이콘은 밝은 서명 배경에 맞춘 단색(먹색)이라 배경 박스 없이 그대로 올린다.
  const socials = normalized.socials
    .map(
      (social) => `
        <td style="padding:0 10px 0 0;vertical-align:middle;">
          <a href="${escapeHtml(social.linkUrl)}" style="text-decoration:none;">
            <img src="${escapeHtml(social.imageUrl)}" alt="${escapeHtml(social.name)}" width="24" height="24" style="display:block;width:24px;height:24px;object-fit:contain;border:0;" />
          </a>
        </td>`,
    )
    .join("");
  const contactItems = [
    normalized.senderTeam ? escapeHtml(normalized.senderTeam) : "",
    normalized.senderEmail
      ? `<a href="mailto:${escapeHtml(normalized.senderEmail)}" style="color:#6b7280;text-decoration:none;">${escapeHtml(normalized.senderEmail)}</a>`
      : "",
  ].filter(Boolean);
  const contactLine = contactItems.length > 0
    ? `<div style="font:500 12px/1.5 -apple-system,'Segoe UI',Roboto,'Apple SD Gothic Neo',sans-serif;color:#6b7280;">${contactItems.join(" · ")}</div>`
    : "";
  return `
<table ${SIGNATURE_MARKER}="1" role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;border-top:1px solid #e5e7eb;padding-top:0;width:100%;max-width:520px;">
  <tr><td style="padding:16px 0 0 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:0 12px 0 0;vertical-align:middle;">
          <a href="${escapeHtml(normalized.siteUrl)}"><img src="${escapeHtml(normalized.logoUrl)}" alt="Supercent" width="120" height="32" style="display:block;width:120px;height:32px;object-fit:contain;" /></a>
        </td>
        <td style="vertical-align:middle;">
          <div style="font:700 14px/1.5 -apple-system,'Segoe UI',Roboto,'Apple SD Gothic Neo',sans-serif;color:#111827;">${escapeHtml(normalized.senderName)}</div>
          ${contactLine}
        </td>
      </tr>
    </table>
    <div style="font:400 12px/1.6 -apple-system,'Segoe UI',Roboto,'Apple SD Gothic Neo',sans-serif;color:#6b7280;padding:10px 0 8px 0;">${escapeHtml(normalized.tagline)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${games}</tr></table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="padding-top:12px;"><tr>${socials}</tr></table>
    <div style="font:400 11px/1.6 -apple-system,'Segoe UI',Roboto,'Apple SD Gothic Neo',sans-serif;color:#9ca3af;padding-top:10px;">${escapeHtml(SIGNATURE_ADDRESS)}</div>
  </td></tr>
</table>`;
}

export function hasStructuralSignatureMarker(html: string): boolean {
  const structuralHtml = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, "");
  const tableTags = structuralHtml.match(/<table\b[^>]*>/gi) ?? [];
  return tableTags.some((tag) => {
    const marker = new RegExp(
      `\\b${SIGNATURE_MARKER}\\s*=\\s*(["'])1\\1`,
      "i",
    ).test(tag);
    const presentationTable = /\brole\s*=\s*(["'])presentation\1/i.test(tag);
    return marker && presentationTable;
  });
}

export function openPixelUrl(trackingId: string): string {
  if (adminRuntimeEnvironment.runtimeEnvironment === "staging") {
    throw Object.assign(
      new Error("failed-precondition: mail open tracking is disabled in staging"),
      { code: "failed-precondition", errorCode: "open_pixel_url_mail_open_tracking_disabled_in" },
    );
  }
  const projectId = asString(process.env.GCLOUD_PROJECT, "influchat-77db6");
  // W111 (헤세, 실제 발송분 확인): 종전 픽셀 URL 은 `us-central1-influchat-77db6.cloudfunctions.net`
  //   이라 **외부 크리에이터에게 나가는 메일에 Firebase 프로젝트 ID 가 그대로 노출**됐다.
  //   같은 메일의 이미지 자산은 이미 호스팅 도메인(sc-flu.web.app)을 쓰고 있어 픽셀만 튀었다.
  //   호스팅 rewrite(/mailOpenPixel → mailOpenPixel 함수)로 **호스트만** 가린다.
  //   경로(`mailOpenPixel`)는 일부러 유지한다 — mailExternalSentImport 가 발송분에서 추적 ID 를
  //   그 경로로 파싱하므로 경로를 바꾸면 그쪽 수집이 조용히 끊긴다.
  //   이미 나간 메일은 기존 cloudfunctions.net URL 을 가리키는데, 그 함수는 그대로 살아 있어
  //   과거 열람 추적도 계속 동작한다.
  const base = process.env.FUNCTIONS_EMULATOR === "true"
    ? `http://127.0.0.1:5001/${projectId}/us-central1/${PIXEL_PATH}`
    : `https://${MAIL_PUBLIC_HOST}/${PIXEL_PATH}`;
  return `${base}?tid=${encodeURIComponent(trackingId)}`;
}

function trustedSignatureImageUrls(settings: MailSignatureSettings): Set<string> {
  const normalized = normalizeSignatureInput(settings, "read");
  return new Set([
    normalized.logoUrl,
    ...normalized.games.map((game) => game.imageUrl),
    // 등재하지 않으면 sanitizeMailHtml 의 호스트 검증을 통과해도 최종 게이트에서 스팬으로 강등된다.
    ...normalized.socials.map((social) => social.imageUrl),
  ]);
}

function isValidatedOfficialSignatureImage(
  value: string,
  allowedImageUrls: ReadonlySet<string>,
): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && !parsed.port
      && !parsed.username
      && !parsed.password
      && !parsed.hash
      && allowedImageUrls.has(parsed.toString());
  } catch {
    return false;
  }
}

function isCanonicalOpenPixelUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const projectId = asString(process.env.GCLOUD_PROJECT, "influchat-77db6");
    const expectedPath = process.env.FUNCTIONS_EMULATOR === "true"
      ? `/${projectId}/us-central1/${PIXEL_PATH}`
      : `/${PIXEL_PATH}`;
    // 신규 발송은 호스팅 도메인을 쓰지만, **이미 나간 메일은 기존 cloudfunctions.net URL** 을
    // 갖고 있다. 둘 다 정본으로 인정한다.
    // 리뷰 지적(LOW): 현재 추적 가능한 호출 경로는 전부 sanitizeMailHtml(호스트 allowlist 에
    //   cloudfunctions.net 없음)을 먼저 거치므로 이 legacy 분기는 도달 불가로 보인다. 그럼에도
    //   **방어적으로 남긴다** — 지웠다가 아직 못 찾은 재검증 경로가 있으면 과거 발송분이 비정본
    //   처리된다. 남겨두는 비용은 0 이다(스푸핑 차단은 별도로 실행 검증됨: 서브도메인·prefix·
    //   userinfo·추가경로·추가쿼리 전부 거부).
    const validOrigin = process.env.FUNCTIONS_EMULATOR === "true"
      ? parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port === "5001"
      : parsed.protocol === "https:"
        && (parsed.hostname === MAIL_PUBLIC_HOST
          || parsed.hostname === `us-central1-${projectId}.cloudfunctions.net`)
        && !parsed.port;
    return validOrigin
      && !parsed.username
      && !parsed.password
      && parsed.pathname === expectedPath
      && [...parsed.searchParams.keys()].length === 1
      && parsed.searchParams.has("tid")
      && TRACKING_ID_RE.test(parsed.searchParams.get("tid") ?? "")
      && !parsed.hash;
  } catch {
    return false;
  }
}

function sanitizeTrustedOutboundHtml(
  value: unknown,
  allowedImageUrls: ReadonlySet<string>,
): string {
  const html = typeof value === "string" ? value : String(value ?? "");
  return sanitizeHtml(html, {
    allowedTags: TRUSTED_OUTBOUND_ALLOWED_TAGS,
    allowedAttributes: TRUSTED_OUTBOUND_ALLOWED_ATTRIBUTES,
    allowedStyles: MAIL_SANITIZE_ALLOWED_STYLES,
    allowedSchemes: ["http", "https", "mailto", "cid"],
    allowedSchemesByTag: {
      a: ["http", "https", "mailto"],
      img: ["http", "https", "cid"],
    },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
    parser: { lowerCaseTags: true, lowerCaseAttributeNames: true, decodeEntities: true },
    transformTags: {
      img: (tagName, attributes) => {
        const src = attributes.src ?? "";
        // 본문 공식 자산(cid) / 공식 서명 이미지 / 수신확인 픽셀만 통과.
        if (
          !MAIL_ASSET_CID_SRC_RE.test(src.trim())
          && !isValidatedOfficialSignatureImage(src, allowedImageUrls)
          && !isCanonicalOpenPixelUrl(src)
        ) {
          return { tagName: "span", attribs: {}, text: attributes.alt ?? "" };
        }
        return { tagName, attribs: attributes };
      },
    },
  });
}

// 콜드메일 raw HTML 바디(bodyFormat:"html")도 공통 parser allowlist를 통과한다.
// 발송 관문(sendEmailLive)과 프로그램 콜드메일 미리보기(admin.programColdmailPreview) 양쪽에서
// 재사용 — 미리보기가 실제 발송과 동일한 살균 결과를 보여주도록.
export function sanitizeEmailHtml(html: string): string {
  return sanitizeMailHtml(html);
}

export type OutboundMailCompileOptions = { trackingId: string };

/** Preview and SMTP share this exact post-decoration artifact. */
export async function compileOutboundMailArtifact(
  input: MailCompileInput,
  options: OutboundMailCompileOptions,
): Promise<MailArtifact> {
  const base = compileMailArtifact(input);
  return decorateOutboundMailArtifact(base, options);
}

export type DecorateOptions = {
  trackingId: string;
};

export async function decorateOutboundMailArtifact(
  base: MailArtifact,
  options: DecorateOptions,
): Promise<MailArtifact> {
  const settings = await readMailSignatureSettings();
  const decorated = await decorateOutboundHtmlWithSettings(base.compiledHtml, options, settings);
  return artifactFromCompiledHtml(
    base,
    decorated,
    (html) => sanitizeTrustedOutboundHtml(html, trustedSignatureImageUrls(settings)),
  );
}

// sendEmailLive 단일 관문에서 호출 — 모든 실발송 HTML에 서명·수신확인 픽셀을
// **강제** 적용한다 (헤세 결정 2026-07-03: 옵트아웃 없음, 커스텀은 내용만 가능).
// 서명은 마커로 멱등, 픽셀은 유효한 trackingId일 때 항상 부착.
export async function decorateOutboundHtml(html: string, options: DecorateOptions): Promise<string> {
  return decorateOutboundHtmlWithSettings(html, options, await readMailSignatureSettings());
}

async function decorateOutboundHtmlWithSettings(
  html: string,
  options: DecorateOptions,
  settings: MailSignatureSettings,
): Promise<string> {
  const alreadySigned = hasStructuralSignatureMarker(html);
  let decorated = sanitizeMailHtml(html);
  if (!alreadySigned) {
    decorated = `${decorated}\n${renderMailSignatureHtml(settings)}`;
  }
  if (
    adminRuntimeEnvironment.runtimeEnvironment !== "staging" &&
    TRACKING_ID_RE.test(options.trackingId)
  ) {
    decorated = `${decorated}\n<img src="${escapeHtml(openPixelUrl(options.trackingId))}" width="1" height="1" alt="" style="display:none;" />`;
  }
  return sanitizeTrustedOutboundHtml(decorated, trustedSignatureImageUrls(settings));
}

// ---- 서명 커스텀 설정 콜러블 (설정 화면) ------------------------------------

const SIGNATURE_READ_ROLES = ["super_admin", "admin", "manager"] as const;
const SIGNATURE_WRITE_ROLES = ["super_admin", "admin"] as const;

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

type SignatureNormalizeMode = "write" | "read";
type SignatureUrlKind = "link" | "image";

function cleanHttpsUrl(
  value: unknown,
  field: string,
  required: boolean,
  kind: SignatureUrlKind,
  mode: SignatureNormalizeMode,
  fallback: string,
): string {
  const text = asString(value, "").trim();
  if (!text) {
    if (required && mode === "write" && !fallback) {
      throw invalidArgument(`${field}은(는) 필수입니다`);
    }
    return fallback;
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    if (mode === "read") return fallback;
    throw invalidArgument(`${field}이(가) 올바른 URL이 아닙니다`);
  }
  const validHost = (kind === "image" ? SIGNATURE_HOSTS : SIGNATURE_LINK_HOSTS)
    .has(parsed.hostname.toLowerCase());
  const validImage = kind !== "image"
    || /\.(?:png|jpe?g|webp|gif)$/i.test(parsed.pathname);
  if (
    parsed.protocol !== "https:"
    || !validHost
    || parsed.port
    || parsed.username
    || parsed.password
    || !validImage
  ) {
    if (mode === "read") return fallback;
    throw invalidArgument(
      `${field}은(는) 허용된 공식 HTTPS 호스트${kind === "image" ? "의 이미지" : ""}만 사용할 수 있습니다`,
    );
  }
  const normalized = parsed.toString();
  return parsed.pathname === "/" && !parsed.search && !parsed.hash
    ? normalized.slice(0, -1)
    : normalized;
}

// Task-33: d2e3a9c8 이전 저장 문서는 게임 linkUrl에 이 옛 기본값(공홈)이 문자 그대로 남아 있을
// 수 있다. 여전히 유효한 공식 호스트라 검증은 통과하지만, 그러면 옛 문서가 영원히 이 링크에
// 갇힌다 — isLegacyDefaultGameLinkUrl로 "미설정"과 동치 취급해 canonical(스토어) 링크로 폴백시킨다.
const LEGACY_DEFAULT_GAME_LINK_URL = "https://supercent.io";

function isLegacyDefaultGameLinkUrl(value: string): boolean {
  return value.trim().replace(/\/+$/, "") === LEGACY_DEFAULT_GAME_LINK_URL;
}

function cleanSignatureText(
  value: unknown,
  fallback: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/\r\n?/g, "\n").replace(/\n+/g, " ").trim();
  if (!text) return allowEmpty ? "" : fallback;
  return text.slice(0, maxLength);
}

function normalizeSignatureInput(
  value: unknown,
  mode: SignatureNormalizeMode = "write",
): MailSignatureSettings {
  const data = asRecord(value);
  const senderName = cleanSignatureText(
    data.senderName,
    DEFAULT_SIGNATURE.senderName,
    80,
  );
  const senderTeam = cleanSignatureText(data.senderTeam, "", 80, true);
  const rawEmail = cleanSignatureText(
    data.senderEmail,
    DEFAULT_SIGNATURE.senderEmail,
    120,
    true,
  );
  const senderEmail = !rawEmail
    ? ""
    : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)
      ? rawEmail
      : mode === "read"
        ? DEFAULT_SIGNATURE.senderEmail
        : (() => { throw invalidArgument("발신자 이메일 형식이 올바르지 않습니다"); })();
  const siteUrl = cleanHttpsUrl(
    data.siteUrl,
    "사이트 URL",
    true,
    "link",
    mode,
    DEFAULT_SIGNATURE.siteUrl,
  );
  const logoUrl = cleanHttpsUrl(
    data.logoUrl,
    "로고 URL",
    true,
    "image",
    mode,
    DEFAULT_SIGNATURE.logoUrl,
  );
  const rawGames = Array.isArray(data.games) ? data.games : DEFAULT_SIGNATURE.games;
  if (rawGames.length > 5 && mode === "write") {
    throw invalidArgument("게임 포트폴리오는 최대 5개까지입니다");
  }
  const configuredGames = new Map<string, MailSignatureGame>();
  for (const [index, entry] of rawGames.slice(0, 5).entries()) {
    const game = asRecord(entry);
    const name = cleanSignatureText(game.name, "", 60, true);
    if (!name) {
      if (mode === "write") {
        throw invalidArgument(`게임 ${index + 1}의 이름이 비어 있습니다`);
      }
      continue;
    }
    const canonical = DEFAULT_SIGNATURE.games.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    );
    if (!canonical) {
      if (mode === "write") {
        throw invalidArgument(
          `게임 ${index + 1}은(는) canonical five 목록에 없습니다`,
        );
      }
      continue;
    }
    if (configuredGames.has(canonical.name)) {
      if (mode === "write") {
        throw invalidArgument(`게임 ${canonical.name}이(가) 중복되었습니다`);
      }
      continue;
    }
    const rawImageUrl = asString(game.imageUrl, "").trim();
    if (rawImageUrl) {
      const validatedImageUrl = cleanHttpsUrl(
        rawImageUrl,
        `게임 ${index + 1} 이미지 URL`,
        true,
        "image",
        mode,
        "",
      );
      if (!validatedImageUrl && mode === "read") continue;
    }
    // 읽기에서만 옛 기본값(공홈)을 "미설정"으로 취급해 canonical 스토어 링크로 폴백한다 —
    // 운영자가 옛 기본값이 아닌 다른 공식 URL을 명시적으로 넣은 경우는 그대로 보존한다.
    const rawLinkUrl = asString(game.linkUrl, "").trim();
    const linkUrlInput =
      mode === "read" && isLegacyDefaultGameLinkUrl(rawLinkUrl) ? "" : game.linkUrl;
    const linkUrl = cleanHttpsUrl(
      linkUrlInput,
      `게임 ${index + 1} 링크 URL`,
      false,
      "link",
      mode,
      canonical.linkUrl || siteUrl,
    );
    configuredGames.set(canonical.name, {
      name: canonical.name,
      imageUrl: canonical.imageUrl,
      linkUrl,
    });
  }
  const games = DEFAULT_SIGNATURE.games.map((canonical) =>
    configuredGames.get(canonical.name) ?? { ...canonical, linkUrl: canonical.linkUrl || siteUrl });
  return {
    senderName,
    senderTeam,
    senderEmail,
    siteUrl,
    logoUrl,
    tagline: SIGNATURE_TAGLINE,
    games,
    // 공식 채널은 설정으로 바꾸지 않는다 — 임의 URL 주입 통로를 만들지 않기 위해 정본을 그대로 쓴다.
    socials: DEFAULT_SIGNATURE.socials.map((social) => ({ ...social })),
  };
}

function signatureContentHash(settings: MailSignatureSettings): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

function storedSignatureVersion(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

type SignatureCasExpectation = {
  expectedVersion?: number;
  expectedHash?: string;
};

function signatureCasExpectation(
  data: Record<string, unknown>,
): SignatureCasExpectation {
  const expectation: SignatureCasExpectation = {};
  if (Object.prototype.hasOwnProperty.call(data, "expectedVersion")) {
    if (
      typeof data.expectedVersion !== "number"
      || !Number.isSafeInteger(data.expectedVersion)
      || data.expectedVersion < 0
    ) {
      throw invalidArgument("expectedVersion must be a non-negative integer");
    }
    expectation.expectedVersion = data.expectedVersion;
  }
  if (Object.prototype.hasOwnProperty.call(data, "expectedHash")) {
    if (
      typeof data.expectedHash !== "string"
      || (data.expectedHash !== "" && !/^[a-f0-9]{64}$/i.test(data.expectedHash))
    ) {
      throw invalidArgument("expectedHash must be empty or a SHA-256 hash");
    }
    expectation.expectedHash = data.expectedHash.toLowerCase();
  }
  return expectation;
}

function assertSignatureCas(
  expectation: SignatureCasExpectation,
  currentVersion: number,
  currentHash: string,
): void {
  if (
    expectation.expectedVersion === undefined
    && expectation.expectedHash === undefined
  ) {
    throw invalidArgument("expectedVersion or expectedHash is required");
  }
  if (
    expectation.expectedVersion !== undefined
    && expectation.expectedVersion !== currentVersion
  ) {
    throw Object.assign(
      new Error(
        `mail signature version conflict: expected ${expectation.expectedVersion}, current ${currentVersion}`,
      ),
      { code: "failed-precondition", errorCode: "assert_signature_cas_mail_signature_version_conflict_expected" },
    );
  }
  if (
    expectation.expectedHash !== undefined
    && expectation.expectedHash !== currentHash
  ) {
    throw Object.assign(
      new Error(
        `mail signature hash conflict: expected ${expectation.expectedHash || "<empty>"}, current ${currentHash || "<empty>"}`,
      ),
      { code: "failed-precondition", errorCode: "assert_signature_cas_mail_signature_hash_conflict_expected" },
    );
  }
}

function changedSignatureFields(
  before: MailSignatureSettings,
  after: MailSignatureSettings,
): string[] {
  const fields = [
    "senderName",
    "senderTeam",
    "senderEmail",
    "siteUrl",
    "logoUrl",
    "tagline",
    "games",
  ] as const;
  return fields.filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}

function signatureActorHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export async function getMailSignatureSettings(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "mail_signature.get", SIGNATURE_READ_ROLES);
  const state = await readMailSignatureState();
  return {
    ok: true,
    settings: state.settings,
    previewHtml: renderMailSignatureHtml(state.settings),
    version: state.version,
    contentHash: state.contentHash,
    allowedHttpsHosts: [...SIGNATURE_ALLOWED_HTTPS_HOSTS],
    behaviorLog: makeBehaviorLog(auth, "mail_signature.get", "success", "scp-automation"),
  };
}

export async function updateMailSignatureSettings(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "mail_signature.update", SIGNATURE_WRITE_ROLES);
  const data = asRecord(request.data);
  const settings = normalizeSignatureInput(data.settings ?? request.data, "write");
  const nowIso = new Date().toISOString();
  const previewHtml = renderMailSignatureHtml(settings);
  const contentHash = signatureContentHash(settings);
  const current = await readMailSignatureState();
  let behaviorLog = makeBehaviorLog(
    auth,
    data.dryRun === true ? "mail_signature.preview" : "mail_signature.update",
    "success",
    "scp-automation",
  );

  if (data.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      sideEffects: "none" as const,
      settings,
      previewHtml,
      contentHash,
      currentHash: current.contentHash,
      currentVersion: current.version,
      validation: {
        valid: true as const,
        allowedHttpsHosts: [...SIGNATURE_ALLOWED_HTTPS_HOSTS],
        maximumGames: 5,
        gameCount: settings.games.length,
      },
      behaviorLog,
    };
  }

  const expectation = signatureCasExpectation(data);
  const settingsRef = adminDb.doc(SIGNATURE_SETTINGS_REF);
  const auditRef = adminDb.collection(SIGNATURE_AUDIT_COLLECTION).doc();
  const applied = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(settingsRef);
    const stored = snapshot.data() ?? {};
    const beforeSettings = snapshot.exists
      ? normalizeSignatureInput(stored, "read")
      : DEFAULT_SIGNATURE;
    const beforeVersion = storedSignatureVersion(stored.version);
    const beforeHash = signatureContentHash(beforeSettings);
    if (snapshot.exists && beforeHash === contentHash) {
      return {
        beforeHash,
        beforeVersion,
        nextVersion: beforeVersion,
        noop: true as const,
      };
    }
    assertSignatureCas(expectation, beforeVersion, beforeHash);
    const nextVersion = beforeVersion + 1;
    transaction.set(settingsRef, {
      ...settings,
      version: nextVersion,
      contentHash,
      updatedByHash: signatureActorHash(auth.userId),
      updatedByRole: auth.role,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
      createdAtIso: asString(stored.createdAtIso, nowIso),
      createdAt: snapshot.exists
        ? (stored.createdAt ?? FieldValue.serverTimestamp())
        : FieldValue.serverTimestamp(),
    }, { merge: false });
    transaction.create(auditRef, {
      action: snapshot.exists ? "update" : "create",
      settingsRef: settingsRef.path,
      beforeVersion,
      afterVersion: nextVersion,
      beforeHash,
      afterHash: contentHash,
      changedFields: changedSignatureFields(beforeSettings, settings),
      actorUserIdHash: signatureActorHash(auth.userId),
      actorRole: auth.role,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { beforeHash, beforeVersion, nextVersion, noop: false as const };
  });
  if (applied.noop) {
    behaviorLog = makeBehaviorLog(
      auth,
      "mail_signature.noop",
      "success",
      "scp-automation",
    );
  }
  return {
    ok: true,
    dryRun: false,
    applied: !applied.noop,
    noop: applied.noop,
    noopReason: applied.noop ? "identical_content" : undefined,
    settings,
    previewHtml,
    contentHash,
    previousHash: applied.beforeHash,
    previousVersion: applied.beforeVersion,
    version: applied.nextVersion,
    auditRef: applied.noop ? null : auditRef.path,
    validation: {
      valid: true as const,
      allowedHttpsHosts: [...SIGNATURE_ALLOWED_HTTPS_HOSTS],
      maximumGames: 5,
      gameCount: settings.games.length,
    },
    behaviorLog,
  };
}

// ---- 아웃바운드 메일 원장 (Chat 메일 탭) ------------------------------------
// 발송 시 1행 기록, 픽셀이 열람 카운트를 O(1)로 조인한다. 사용자(manager+)는
// listMailOutbox 콜러블로 읽는다 — 클라이언트 Firestore 직접 접근 없음(SEC-P0-004).

const OUTBOX_COLLECTION = "mail_outbound_log";
const OUTBOX_READ_ROLES = ["super_admin", "admin", "manager"] as const;

export type MailOutboundLogEntry = {
  trackingId: string;
  to: string;
  subject: string;
  // Flu conversation org-filter round 15 (codex adversarial review round 15, finding #2): the
  // actually-selected sender account for THIS send (chat-ai.ts sendEmailInternal's already-resolved
  // outboundMailAccount, stamped as sendData.mailAccountId before dispatch) — lets the outbox pager
  // (mailSignature.ts pageAuthorizedOutboxRows) decide scp gating by what this row itself sent as,
  // instead of only the linked conversation's stamp. Left undefined (never written as "") for any
  // caller that does not resolve one, so a legacy row (written before this field existed) stays
  // indistinguishable from "not yet stamped" and keeps deferring to the linked conversation.
  mailAccountId?: string;
  deliveryState: string;
  /** Legacy input only. recordMailOutboundLog hashes it and deletes the raw stored field. */
  providerMessageId?: string;
  providerMessageIdHash?: string;
  providerConfirmed?: boolean;
  deliverySource?: string;
  acceptedCount?: number;
  rejectedCount?: number;
  persisted?: boolean;
  verificationMarker?: string;
  draftRef: string;
  gameId: string;
  sentByUserId: string;
  sentByRole: string;
  sentAtIso?: string;
  conversationId?: string;
  conversationRef?: string;
  campaignId?: string;
  programId?: string;
  outreachId?: string;
  applicationId?: string;
  portalCreatorId?: string;
  fluCreatorId?: string;
  partnerId?: string;
  enrollmentId?: string;
  submissionId?: string;
  revision?: number;
  traceId?: string;
  eventId?: string;
  source?: string;
  sourceRef?: string;
  mailType?: string;
  mailPurpose?: string;
  templateKind?: string;
  approvalRef?: string;
  approvalRevision?: string;
  compilerVersion?: string;
  templateRevision?: string;
  bodyFormat?: string;
  contentHash?: string;
  compiledHash?: string;
  textHash?: string;
  compiledFingerprint?: string;
  toMasked?: string;
  toHash?: string;
};

export type MailOutboundLogWriteResult =
  | {
      ok: true;
      status: "written";
      correlationIdHash: string;
      lifecycleRefreshEnqueued: boolean;
      lifecycleRefreshErrorCode?: typeof MAIL_SIGNATURE_FAILURE_CODES.outboxLifecycleEnqueue;
    }
  | {
      ok: false;
      status: "failed";
      correlationIdHash: string;
      errorCode:
        | typeof MAIL_SIGNATURE_FAILURE_CODES.outboxInvalidTrackingId
        | typeof MAIL_SIGNATURE_FAILURE_CODES.outboxWrite;
      reason: "invalid_tracking_id" | "write_failed";
    };

export type MailOutboundLogWriteOptions = {
  // Ordinary send paths must never fail the send solely because the evidence
  // ledger is unavailable. Repair/reconciliation paths, however, must fail
  // closed so they cannot count a missing ledger row as repaired.
  throwOnFailure?: boolean;
};

type MailConversationSnapshot = {
  id: string;
  ref: string;
  threadId: string;
  creatorId: string;
  creatorName: string;
  creatorEmailMasked: string;
  creatorHandle: string;
  programId: string;
  campaignId: string;
  lastMessageFrom: string;
  lastMessageAtIso: string;
};

function maskEmail(value: string): string {
  if (!value) return "";
  const [local = "", domain = ""] = value.split("@");
  return `${local.slice(0, Math.min(2, local.length)) || "*"}***@${domain}`;
}

function emailHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 24) : "";
}

function conversationIdFromRef(ref: string): string {
  const match = ref.match(/^conversations\/([^/]+)$/);
  return match?.[1] ?? "";
}

function conversationSnapshotFromData(id: string, row: Record<string, unknown>): MailConversationSnapshot {
  return {
    id,
    ref: `conversations/${id}`,
    threadId: asString(row.threadId, ""),
    creatorId: asString(row.creatorId, ""),
    creatorName: asString(row.creatorName, ""),
    creatorEmailMasked: maskEmail(asString(row.creatorEmail, "")),
    creatorHandle: asString(row.creatorHandle, ""),
    programId: asString(row.programId, ""),
    campaignId: asString(row.campaignId, ""),
    lastMessageFrom: asString(row.lastMessageFrom, ""),
    lastMessageAtIso: asString(row.lastMessageAtIso, ""),
  };
}

async function readConversationSnapshot(conversationId: string): Promise<MailConversationSnapshot | null> {
  if (!conversationId) return null;
  const snapshot = await adminDb.collection("conversations").doc(conversationId).get();
  if (!snapshot.exists) return {
    id: conversationId,
    ref: `conversations/${conversationId}`,
    threadId: "",
    creatorId: "",
    creatorName: "",
    creatorEmailMasked: "",
    creatorHandle: "",
    programId: "",
    campaignId: "",
    lastMessageFrom: "",
    lastMessageAtIso: "",
  };
  return conversationSnapshotFromData(snapshot.id, snapshot.data() ?? {});
}

function isCompleteOutboxRow(row: Record<string, unknown>): boolean {
  // Pixel-only documents can exist when the public tracking endpoint merges
  // counters before any send ledger exists. Receipts are a send-ledger view,
  // so require explicit sent metadata before listing a row.
  const sentAtIso = asString(row.sentAtIso, "");
  const deliveryState = asString(row.deliveryState, "");
  const subject = asString(row.subject, "");
  const recipientSignal = asString(row.toHash, "") || asString(row.toMasked, "") || asString(row.to, "");
  return Boolean(sentAtIso && deliveryState && subject && recipientSignal);
}

function classifyPixelOpen(userAgent: string, ip: string): { confidence: string; suppressionReason: string } {
  const ua = userAgent.toLowerCase();
  if (/googleimageproxy|gmailimageproxy|yahoo|outlook|microsoft office|thunderbird proxy|mailprivacy|cloudflare|bot|crawler|spider/.test(ua)) {
    return { confidence: "pixel_only_unconfirmed", suppressionReason: "mail_client_or_proxy_prefetch" };
  }
  if (/^127\.|^10\.|^172\.(1[6-9]|2\d|3[0-1])\.|^192\.168\.|^::1$/.test(ip)) {
    return { confidence: "pixel_only_unconfirmed", suppressionReason: "local_or_operator_probe" };
  }
  return { confidence: "pixel_only_unconfirmed", suppressionReason: "pixel_identity_unverified" };
}

function mailOutboundLogWriteError(
  reason: "invalid_tracking_id" | "write_failed",
  correlationHash: string,
): Error {
  const errorCode = reason === "invalid_tracking_id"
    ? MAIL_SIGNATURE_FAILURE_CODES.outboxInvalidTrackingId
    : MAIL_SIGNATURE_FAILURE_CODES.outboxWrite;
  return safeMailSignatureError(
    `mail-outbox-record-failed: ${reason}`,
    errorCode,
    correlationHash,
    reason === "invalid_tracking_id" ? "invalid-argument" : "internal",
  );
}

/**
 * `sentAtIso` 기본값을 만들 수 있는 상태 — 공급자(또는 에뮬레이터 목 공급자)에 **닿은** 행뿐이다.
 * 판정 정본(`nudgeReportFacts.isDeliveredOutboundLogRow`)보다 넓은 이유: `mock_sent` ·
 * `sent_evidence_pending` 은 "발송으로 세는 행"은 아니지만 **시각이 실재하는** 행이고,
 * 목/회수 경로가 그 시각을 읽는다. 차단·억제·큐 상태에는 시각을 만들지 않는다.
 */
const MAIL_OUTBOUND_SEND_ATTEMPTED_STATES: ReadonlySet<string> = new Set([
  "sent",
  "mock_sent",
  "sent_evidence_pending",
  "delivered",
]);

export async function recordMailOutboundLog(
  entry: MailOutboundLogEntry,
  options: MailOutboundLogWriteOptions = {},
): Promise<MailOutboundLogWriteResult> {
  const ref = `${OUTBOX_COLLECTION}/${entry.trackingId}`;
  const correlationHash = correlationIdHash("mail_outbound_log", entry.trackingId);
  if (!TRACKING_ID_RE.test(entry.trackingId)) {
    const result: MailOutboundLogWriteResult = {
      ok: false,
      status: "failed",
      correlationIdHash: correlationHash,
      errorCode: MAIL_SIGNATURE_FAILURE_CODES.outboxInvalidTrackingId,
      reason: "invalid_tracking_id",
    };
    if (options.throwOnFailure) {
      throw mailOutboundLogWriteError(result.reason, correlationHash);
    }
    return result;
  }
  let sentAtIso = "";
  let conversationId = "";
  let conversationSnapshot: MailConversationSnapshot | null = null;
  try {
    conversationId = entry.conversationId || conversationIdFromRef(entry.conversationRef ?? "");
    conversationSnapshot = await readConversationSnapshot(conversationId);
    // W118 [2026-09-05 적대 리뷰 P1] — **근인**: 여기서 상태를 안 보고 "지금"을 찍었다.
    //   그래서 `deliveryState:"blocked"` 행도 truthy 한 `sentAtIso` 를 들고 나갔고, 하류 프로젝션의
    //   `Boolean(row.sentAtIso)` 폴백이 그 행을 **발송으로 되살렸다**(아웃리치 정지 기간 하루 수천 건).
    //   공급자(또는 목 공급자)에 **닿기라도 한** 상태만 기본값을 만든다. 호출자가 명시한 값은 그대로 존중한다.
    sentAtIso = asString(
      entry.sentAtIso,
      MAIL_OUTBOUND_SEND_ATTEMPTED_STATES.has(asString(entry.deliveryState).trim().toLowerCase())
        ? new Date().toISOString()
        : "",
    );
    const rawRecipient = asString(entry.to, "");
    const toMasked = entry.toMasked || maskEmail(rawRecipient);
    const toHash = entry.toHash || emailHash(rawRecipient);
    const suppliedProviderHash = asString(entry.providerMessageIdHash, "")
      .trim()
      .toLowerCase();
    const rawProviderMessageId = asString(entry.providerMessageId, "");
    const providerMessageIdHash = /^[a-f0-9]{64}$/.test(
      suppliedProviderHash,
    )
      ? suppliedProviderHash
      : rawProviderMessageId
        ? createHash("sha256").update(rawProviderMessageId).digest("hex")
        : "";
    const deliverySource = asString(
      entry.deliverySource,
      asString(entry.source, ""),
    );
    const acceptedCount = Number(entry.acceptedCount ?? 0);
    const rejectedCount = Number(entry.rejectedCount ?? 0);
    const persisted = entry.persisted === true;
    const verificationMarker =
      asString(entry.verificationMarker, "") ===
      SCP_RESULT_PROVIDER_VERIFIED_MIGRATION_MARKER
        ? SCP_RESULT_PROVIDER_VERIFIED_MIGRATION_MARKER
        : "";
    const providerConfirmed = isStrictScpProviderConfirmed(
      {
        deliveryState: entry.deliveryState,
        deliverySource,
        providerMessageIdHash,
        acceptedCount,
        persisted,
        providerConfirmed: entry.providerConfirmed === true,
        verificationMarker,
      },
      "outbound",
    );
    const {
      providerMessageId: _legacyRawProviderMessageId,
      ...entryWithoutRawProviderMessageId
    } = entry;
    const safeEntry = {
      ...entryWithoutRawProviderMessageId,
      // mail_outbound_log is manager-readable through listMailOutbox, so never
      // persist a raw recipient here. Detailed send artifacts may keep internal
      // routing data, but this operational evidence surface is masked+hashed.
      to: toMasked,
      toMasked,
      toHash,
      // Flu conversation org-filter round 15: written as "" (never omitted, matching every other
      // field here) whenever the caller does not resolve one — pageAuthorizedOutboxRows treats a
      // blank value exactly like a genuinely absent field (a legacy row from before this field
      // existed), so this is never a behavior difference, only a storage-shape one.
      mailAccountId: asString(entry.mailAccountId, ""),
      // Result-mail duplicate reconciliation consumes this exact hash-only tuple.
      // Delete the legacy raw field on every merge so old rows cannot leak it.
      providerMessageId: FieldValue.delete(),
      providerMessageIdHash,
      providerConfirmed,
      deliverySource,
      acceptedCount: Number.isFinite(acceptedCount) ? acceptedCount : 0,
      rejectedCount: Number.isFinite(rejectedCount) ? rejectedCount : 0,
      persisted,
      verificationMarker: verificationMarker || FieldValue.delete(),
      subjectHash: createHash("sha256").update(asString(entry.subject, "")).digest("hex"),
      // Hash/version references let operators reconcile the exact approved
      // artifact without persisting raw body or placeholder values here.
      approvalRef: asString(entry.approvalRef),
      approvalRevision: asString(entry.approvalRevision),
      compilerVersion: asString(entry.compilerVersion),
      templateRevision: asString(entry.templateRevision),
      bodyFormat: asString(entry.bodyFormat),
      contentHash: asString(entry.contentHash),
      compiledHash: asString(entry.compiledHash),
      textHash: asString(entry.textHash),
      compiledFingerprint: asString(entry.compiledFingerprint),
    };
    await adminDb.collection(OUTBOX_COLLECTION).doc(entry.trackingId).set({
      ...safeEntry,
      ...(conversationSnapshot ? {
        conversationId: conversationSnapshot.id,
        conversationRef: conversationSnapshot.ref,
        conversationSnapshot,
      } : {}),
      sentAtIso,
      openCount: FieldValue.increment(0),
    }, { merge: true });
  } catch {
    // Ordinary send paths intentionally inspect/ignore this structured failure;
    // strict repair paths throw so they can never emit a false-success audit.
    logMailSignatureFailure(
      MAIL_SIGNATURE_FAILURE_CODES.outboxWrite,
      correlationHash,
    );
    const result: MailOutboundLogWriteResult = {
      ok: false,
      status: "failed",
      correlationIdHash: correlationHash,
      errorCode: MAIL_SIGNATURE_FAILURE_CODES.outboxWrite,
      reason: "write_failed",
    };
    if (options.throwOnFailure) {
      throw mailOutboundLogWriteError(result.reason, correlationHash);
    }
    return result;
  }

  let lifecycleRefreshEnqueued = true;
  try {
    await enqueueScpLifecycleRefreshEvent({
      source: "mail_outbound_log",
      sourceRef: ref,
      reason: "mail_outbound_logged",
      aliases: [{
        trackingId: entry.trackingId,
        conversationId,
        creatorId: conversationSnapshot?.creatorId,
      }],
      sourceUpdatedAtIso: sentAtIso,
    });
  } catch {
    // The ledger already exists, so report a truthful write success while
    // surfacing the independently retryable projection enqueue failure.
    lifecycleRefreshEnqueued = false;
    logMailSignatureFailure(
      MAIL_SIGNATURE_FAILURE_CODES.outboxLifecycleEnqueue,
      correlationHash,
    );
  }
  return {
    ok: true,
    status: "written",
    correlationIdHash: correlationHash,
    lifecycleRefreshEnqueued,
    ...(!lifecycleRefreshEnqueued ? {
      lifecycleRefreshErrorCode: MAIL_SIGNATURE_FAILURE_CODES.outboxLifecycleEnqueue,
    } : {}),
  };
}

// Flu conversation org-filter round 8 (codex adversarial review round 8, finding #2): both
// listMailOutbox and reconcileMailOutboxReplies used to fetch a FIXED window of the newest rows
// (capped at 300) and only THEN filter by per-org authorization — for a non-super-admin, if 300+
// newer rows belonged to OTHER orgs, that caller's own authorized rows were permanently
// unreachable (no continuation existed at all). This pages through the outbox (newest first, with
// a deterministic doc-id tiebreaker) applying the SAME per-row authorization gate INLINE, and
// keeps fetching further pages — up to a bounded per-call scan budget, matching the previous
// single-call ceiling — until `limit` authorized rows are found or the budget/collection is
// exhausted. A cursor is returned whenever the budget was hit before `limit` was reached, so a
// caller (the receipts page's "더 보기") can continue the same scan across another call.
const OUTBOX_PAGE_FETCH_SIZE = 100;
const OUTBOX_PAGE_SCAN_BUDGET = 300;

type OutboxPageCursor = { sentAtIso: string; docId: string };

type AuthorizedOutboxCandidate = {
  doc: FirebaseFirestore.QueryDocumentSnapshot;
  row: Record<string, unknown>;
  conversationId: string;
  liveConversation: Record<string, unknown> | null;
};

function outboxCursorFromRequest(data: Record<string, unknown>): OutboxPageCursor | null {
  const sentAtIso = asString(data.cursorSentAtIso, "");
  const docId = asString(data.cursorTrackingId, "");
  return sentAtIso && docId ? { sentAtIso, docId } : null;
}

async function pageAuthorizedOutboxRows(
  // Flu conversation org-filter round 22 (codex adversarial review round 22, finding #2): a lazy,
  // failure-isolated resolver (functions/conversationMailAccessScope.ts
  // lazyConversationMailAccessScope) instead of an already-resolved scope — this pager mixes
  // personal-account and scp receipts in the SAME scan, and the real (Peoply-backed) scope is only
  // ever consulted for a row that might actually be scp-relevant (see the per-row guard below).
  // Most callers' receipts (personal sends, or scp rows whose linked conversation already exists
  // and isn't itself scp-stamped) never touch it at all, so a Peoply outage no longer fails the
  // whole page — only the scp-relevant rows within it deny.
  resolveConversationAccessScope: () => Promise<Awaited<ReturnType<typeof resolveConversationMailAccessScope>>>,
  limit: number,
  startCursor: OutboxPageCursor | null,
  maxScanned: number = OUTBOX_PAGE_SCAN_BUDGET,
): Promise<{
  candidates: AuthorizedOutboxCandidate[];
  scannedCount: number;
  nextCursor: OutboxPageCursor | null;
}> {
  const candidates: AuthorizedOutboxCandidate[] = [];
  let scannedCount = 0;
  let cursor = startCursor;
  let reachedEnd = false;
  outer: while (candidates.length < limit && scannedCount < maxScanned) {
    const pageSize = Math.min(OUTBOX_PAGE_FETCH_SIZE, maxScanned - scannedCount);
    let pageQuery = adminDb
      .collection(OUTBOX_COLLECTION)
      .orderBy("sentAtIso", "desc")
      .orderBy(FieldPath.documentId(), "desc")
      .limit(pageSize);
    if (cursor) pageQuery = pageQuery.startAfter(cursor.sentAtIso, cursor.docId);
    const pageSnapshot = await pageQuery.get();
    if (pageSnapshot.empty) {
      reachedEnd = true;
      break;
    }
    scannedCount += pageSnapshot.docs.length;
    for (const doc of pageSnapshot.docs) {
      // Flu conversation org-filter round 9 (codex adversarial review round 9, finding #1): the
      // cursor must land on the last row actually RETURNED (or, short of that, the last row
      // examined), never on the last row merely FETCHED in this page. Round 8's version set the
      // cursor to the page's last fetched doc up front, then broke the inner loop early once
      // `limit` was hit — so a page containing MORE authorized rows than the remaining `limit`
      // silently discarded the rest with no way to reach them (nextCursor pointed PAST them).
      // Setting it per-doc, right here, guarantees that whenever we stop mid-page, cursor is
      // exactly the doc that caused candidates.length to reach `limit` — which is itself a
      // returned row.
      cursor = { sentAtIso: asString(doc.data()?.sentAtIso, ""), docId: doc.id };
      const row = doc.data() ?? {};
      if (isCompleteOutboxRow(row)) {
        const snapshotData = asRecord(row.conversationSnapshot);
        const conversationId = asString(row.conversationId, asString(snapshotData.id, conversationIdFromRef(asString(row.conversationRef, ""))))
          || asString(row.stitchedConversationId, "");
        const conversationSnapshotDoc = conversationId
          ? await adminDb.collection("conversations").doc(conversationId).get()
          : null;
        const liveConversation = conversationSnapshotDoc?.data() ?? null;
        // Flu conversation org-filter round 15 (codex adversarial review round 15, finding #2): the
        // outbox row's OWN sender account (mailAccountId, stamped at send time by
        // chat-ai.ts sendEmailInternal → recordMailOutboundLog) now decides whether this receipt is
        // even a candidate for scp gating — a row explicitly stamped with a NON-scp account (a
        // genuine personal-mailbox send) must never be hidden by the LINKED CONVERSATION's own scp
        // stamp (a creator thread can still be scp-flavored even when one particular reply in it
        // went out from someone's personal mailbox). The binding exception is "the mail outbox
        // pager applies the scp gate to scp-stamped outbox rows but does not restrict
        // personal-account sends" — a caller who later loses their scp grant must still see their
        // own personal-send receipts. Only a row with NO stamp at all (written before this field
        // existed) keeps today's behavior of deferring to the linked conversation's own stamp.
        const rowAccountId = typeof row.mailAccountId === "string" ? row.mailAccountId.trim() : "";
        const rowIsExplicitScp = isExplicitScpMailAccountRow(row);
        const isExplicitPersonalSendRow = Boolean(rowAccountId) && !rowIsExplicitScp;
        if (isExplicitPersonalSendRow) {
          candidates.push({ doc, row, conversationId, liveConversation });
        } else {
          // Flu conversation org-filter round 22 (codex adversarial review round 22, finding #2):
          // the real (Peoply-backed) scope is only ever consulted below when this row could
          // actually resolve to an explicit-scp decision — either the row itself is scp-stamped
          // (the dangling-row branch just below, or the forced override further down), or its
          // LIVE linked conversation already is. Every other shape here (a blank/legacy row whose
          // linked conversation, if any, isn't scp-stamped either) is proven in-scope by the cheap
          // synchronous checks alone regardless of what the scope object contains — see
          // canReadScpConversationRowForOrg's own first branches — so this stub is never actually
          // read for that shape.
          const conversationIsExplicitScp = liveConversation ? isExplicitScpMailAccountRow(liveConversation) : false;
          const mightNeedRealAccessScope = rowIsExplicitScp || conversationIsExplicitScp;
          const conversationAccessScope = mightNeedRealAccessScope
            ? await resolveConversationAccessScope()
            : { viewerOrgId: null, authorizedMailAccountIds: [], isSuperAdmin: false, hasScpEntitlement: false };
          if (
            // Flu conversation org-filter round 4 (codex adversarial review round 4, finding #2):
            // the row itself is scp-stamped (mailAccountId:"scp" — imported SCP Sent rows can
            // carry this before a later stitching pass ever attaches a conversationId) but has no
            // provable in-scope conversation to check org against — canReadScpConversationRowForOrg
            // would read an absent/missing linked doc as `{}` (not explicitly scp) and pass it
            // through. Fail closed for every non-super_admin instead of trusting an unlinked or
            // dangling scp row.
            conversationSnapshotDoc?.exists || !rowIsExplicitScp || conversationAccessScope.isSuperAdmin
          ) {
            if (!conversationId) {
              candidates.push({ doc, row, conversationId: "", liveConversation: null });
            } else {
              // Flu conversation org-filter round 5 (codex adversarial review round 5, finding #2):
              // canReadScpConversationRowForOrg only ever looked at the LINKED CONVERSATION's own
              // mailAccountId stamp — a stitching pass can link an scp-stamped outbox row to an
              // unstamped legacy conversation (no mailAccountId at all), which reads as "not
              // explicitly scp" and lets the predicate pass through with no entitlement/org check at
              // all. Force the check to treat this row as explicitly scp whenever the OUTBOX ROW
              // ITSELF says so, regardless of the linked conversation's own stamp — the org match
              // itself still comes from the linked conversation's own orgId (via the spread below),
              // which fails closed for a non-super_admin when that org isn't provable.
              const scpAuthCheckRow = {
                id: conversationId,
                ...(liveConversation ?? {}),
                ...(rowIsExplicitScp ? { mailAccountId: "scp" } : {}),
              };
              if (canReadScpConversationRowForOrg(scpAuthCheckRow, conversationAccessScope)) {
                candidates.push({ doc, row, conversationId, liveConversation: liveConversation ?? {} });
              }
            }
          }
        }
      }
      if (candidates.length >= limit) break outer;
    }
    if (pageSnapshot.docs.length < pageSize) {
      reachedEnd = true;
      break;
    }
  }
  return { candidates, scannedCount, nextCursor: reachedEnd ? null : cursor };
}

export async function listMailOutbox(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "mail_outbox.list", OUTBOX_READ_ROLES);
  const data = asRecord(request.data);
  const rawLimit = Number(data.limit ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 50;
  // Flu conversation org-filter round 6 (codex adversarial review round 6, finding #4): a
  // super_admin previewing a restricted member (viewAs) must have this scope computed for the
  // TARGET, not the super_admin's own unrestricted bypass — otherwise the receipts page shows
  // every org's scp outbox while "viewing as" someone who should see none of it. Same
  // resolveViewAsTarget verification every other conversation-reading surface already uses
  // (functions/dashboardPipelineProjection.ts, functions/read.ts).
  const viewAsTarget = await resolveViewAsTarget(auth, data);
  const conversationScopeAuth = viewAsTarget
    ? { ...auth, role: viewAsTarget.role ?? "viewer", userId: viewAsTarget.uid, email: viewAsTarget.email }
    : auth;
  // 2026-09-28 owner scope decision (codex adversarial review round 2, finding #2): mail_outbox is
  // explicitly within the scp@ mailbox gate scope ("conversations, messages, sending, auto-reply,
  // mail outbox") — a no-op for any row whose joined conversation isn't explicitly
  // mailAccountId:"scp" (this outbox also carries personal-account sends, which this gate must
  // never restrict). Flu conversation org-filter round 22 (codex adversarial review round 22,
  // finding #2): resolved lazily and failure-isolated (at most once per request, only if a row
  // this scan actually reaches needs it) — a Peoply outage used to reject this eagerly-resolved
  // lookup before a single row was scanned, hiding the caller's own personal-send receipts too.
  const resolveConversationAccessScope = lazyConversationMailAccessScope(
    conversationScopeAuth,
    (err) => console.warn("[mail-outbox] conversation_org_scope_lookup_failed", {
      callable: "mail_outbox.list",
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  const { candidates, nextCursor } = await pageAuthorizedOutboxRows(
    resolveConversationAccessScope,
    limit,
    outboxCursorFromRequest(data),
  );
  const rows = await Promise.all(candidates.map(async ({ doc, row, conversationId, liveConversation }) => {
    const snapshotData = asRecord(row.conversationSnapshot);
    const conversationRef = asString(row.conversationRef, conversationId ? `conversations/${conversationId}` : "");
    // 목록 조회는 projection-only다. 아직 원장에 memoize되지 않은 회신은 live join으로
    // 표시하되, 조회 경로에서는 Firestore write나 lifecycle enqueue를 절대 실행하지 않는다.
    const ledgerHasReply = row.hasReply === true;
    let hasReply = ledgerHasReply;
    if (!ledgerHasReply && conversationId) {
      // The row already passed the per-org gate above, so the live conversation fetched there
      // (or an empty object for a since-deleted doc) is reused instead of refetched.
      hasReply = await conversationHasReply(conversationId, liveConversation ?? {});
    }
    return {
      trackingId: asString(row.trackingId, doc.id),
      // 어느 mail_accounts 행의 Sent 에서 온 발신인가 — "hesse@supercent.io 에서 보낸 메일에
      // 답장 안 온 사람" 같은 계정 단위 질의의 구분축. 역대 행은 필드가 없다 → 빈 문자열.
      mailAccountId: asString(row.mailAccountId, ""),
      to: asString(row.toMasked, maskEmail(asString(row.to, ""))),
      toMasked: asString(row.toMasked, maskEmail(asString(row.to, ""))),
      toHash: asString(row.toHash, ""),
      subject: asString(row.subject, ""),
      deliveryState: asString(row.deliveryState, "unknown"),
      sentAtIso: asString(row.sentAtIso, ""),
      openCount: typeof row.openCount === "number" ? row.openCount : 0,
      lastOpenedAtIso: asString(row.lastOpenedAtIso, ""),
      rawOpenCount: typeof row.rawOpenCount === "number" ? row.rawOpenCount : (typeof row.openCount === "number" ? row.openCount : 0),
      likelyRecipientOpenCount: typeof row.likelyRecipientOpenCount === "number" ? row.likelyRecipientOpenCount : 0,
      firstLikelyRecipientOpenedAtIso: asString(row.firstLikelyRecipientOpenedAtIso, ""),
      openConfidence: asString(row.openConfidence, ""),
      openSuppressionReason: asString(row.openSuppressionReason, ""),
      openSignalVersion: asString(row.openSignalVersion, ""),
      source: asString(row.source, ""),
      mailType: asString(row.mailType, ""),
      gameId: asString(row.gameId, ""),
      conversationId,
      conversationRef,
      conversationSnapshot: snapshotData,
      hasReply,
      hasReplySource: ledgerHasReply ? "ledger" : hasReply ? "live_projection" : "none",
    };
  }));
  return {
    ok: true,
    rows,
    // Flu conversation org-filter round 8 (codex adversarial review round 8, finding #2): non-null
    // whenever the per-call scan budget was exhausted before `limit` authorized rows were found —
    // the receipts page's "더 보기" passes cursorSentAtIso/cursorTrackingId back to continue the
    // SAME scan instead of ever treating "nothing more found in this page" as "nothing more
    // exists".
    nextCursor: nextCursor ? { sentAtIso: nextCursor.sentAtIso, trackingId: nextCursor.docId } : null,
    behaviorLog: makeBehaviorLog(auth, `mail_outbox.list(${rows.length})`, "success", "scp-automation"),
  };
}

export async function reconcileMailOutboxReplies(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(
    request,
    "mail_outbox.reconcile_replies",
    OUTBOX_READ_ROLES,
  );
  const data = asRecord(request.data);
  // Flu conversation org-filter round 6 (codex adversarial review round 6, finding #4): "대신
  // 보기" (viewAs) is a read-only preview everywhere else in this codebase — reconcile can mutate
  // (actual:true memoizes hasReply, and even dryRun probes another org's reply status). This
  // callable is not on viewAsWriteGuard.ts's VIEW_AS_READ_ALLOWLIST, so the shared callable()
  // wrapper already rejects a viewAsUserId payload before this handler ever runs; this is an
  // explicit, directly-testable defense-in-depth check at the handler itself.
  if (asString(data.viewAsUserId) || asString(data.viewAsEmail)) {
    throw safeMailSignatureError(
      "reconcileMailOutboxReplies does not support viewAs — it is a mutation-capable callable, and viewAs is read-only preview everywhere else.",
      MAIL_SIGNATURE_FAILURE_CODES.outboxReplyMemoize,
      correlationIdHash("mail_outbound_log", auth.userId),
      "invalid-argument",
    );
  }
  const dryRun = data.dryRun !== false;
  const actual = data.actual === true;
  if (!dryRun && !actual) {
    throw safeMailSignatureError(
      "actual:true is required when dryRun is false.",
      MAIL_SIGNATURE_FAILURE_CODES.outboxReplyMemoize,
      correlationIdHash("mail_outbound_log", auth.userId),
      "invalid-argument",
    );
  }

  const rawLimit = Number(data.limit ?? 100);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
    : 100;

  // Flu conversation org-filter round 8 (codex adversarial review round 8, finding #2): the same
  // shared pager listMailOutbox uses — authorization is applied WHILE paging, never after
  // narrowing to a fixed pre-authorization window first. The old code sliced to the first `limit`
  // COMPLETE rows (out of up to 300 fetched) and only authorized inside that already-narrowed set:
  // if none of those top rows belonged to the caller's own org, this reconciled and reported on
  // zero rows while the caller's own real, authorized backlog sat unreached further back with no
  // way to continue the scan.
  // Flu conversation org-filter round 22 (codex adversarial review round 22, finding #2): resolved
  // lazily and failure-isolated, same as listMailOutbox above — a Peoply outage must not stop this
  // callable from reconciling the caller's own personal-send receipts.
  const resolveConversationAccessScope = lazyConversationMailAccessScope(
    auth,
    (err) => console.warn("[mail-outbox] conversation_org_scope_lookup_failed", {
      callable: "mail_outbox.reconcile_replies",
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  const { candidates, nextCursor } = await pageAuthorizedOutboxRows(
    resolveConversationAccessScope,
    limit,
    outboxCursorFromRequest(data),
  );
  const inspected = await Promise.all(candidates.map(async ({ doc, row, conversationId, liveConversation }) => {
    if (row.hasReply === true) {
      return { doc, conversationId: "", detected: false, alreadyMemoized: true };
    }
    if (!conversationId) {
      return { doc, conversationId: "", detected: false, alreadyMemoized: false };
    }
    const detected = await conversationHasReply(conversationId, liveConversation ?? {});
    return { doc, conversationId, detected, alreadyMemoized: false };
  }));

  const pending = inspected.filter((item) => item.detected && item.conversationId);
  let updatedCount = 0;
  let lifecycleEnqueuedCount = 0;
  let lifecycleFailedCount = 0;

  if (!dryRun && pending.length > 0) {
    const hasReplyAtIso = new Date().toISOString();
    const batch = adminDb.batch();
    for (const { doc } of pending) {
      batch.set(doc.ref, { hasReply: true, hasReplyAtIso }, { merge: true });
    }
    try {
      await batch.commit();
      updatedCount = pending.length;
    } catch {
      const correlationHash = correlationIdHash(
        "mail_outbound_log_reconcile",
        `${auth.userId}:${pending.map((item) => item.doc.id).sort().join(":")}`,
      );
      logMailSignatureFailure(
        MAIL_SIGNATURE_FAILURE_CODES.outboxReplyMemoize,
        correlationHash,
      );
      throw safeMailSignatureError(
        "mail-outbox-operation-failed: reply_memoize",
        MAIL_SIGNATURE_FAILURE_CODES.outboxReplyMemoize,
        correlationHash,
      );
    }

    const lifecycleResults = await Promise.all(pending.map(async ({ doc, conversationId }) => {
      const correlationHash = correlationIdHash("mail_outbound_log", doc.id);
      try {
        await enqueueScpLifecycleRefreshEvent({
          source: "mail_outbound_log",
          sourceRef: doc.ref.path,
          reason: "mail_outbound_reply_memoized",
          aliases: [{ trackingId: doc.id, conversationId }],
          sourceUpdatedAtIso: hasReplyAtIso,
        });
        return { updated: true, lifecycleEnqueued: true };
      } catch {
        logMailSignatureFailure(
          MAIL_SIGNATURE_FAILURE_CODES.outboxLifecycleEnqueue,
          correlationHash,
        );
        return { updated: true, lifecycleEnqueued: false };
      }
    }));
    lifecycleEnqueuedCount = lifecycleResults.filter((result) => result.lifecycleEnqueued).length;
    lifecycleFailedCount = lifecycleResults.filter((result) => !result.lifecycleEnqueued).length;
  }

  return {
    ok: true,
    dryRun,
    mode: dryRun ? "dry_run" : "actual",
    // Now the count of AUTHORIZED rows actually inspected for reply status (never an unauthorized
    // row the caller never learns anything about) — see pageAuthorizedOutboxRows above.
    scannedCount: inspected.length,
    alreadyMemoizedCount: inspected.filter((item) => item.alreadyMemoized).length,
    detectedReplyCount: pending.length,
    pendingWriteCount: dryRun ? pending.length : 0,
    updatedCount,
    lifecycleEnqueuedCount,
    lifecycleFailedCount,
    // Flu conversation org-filter round 8 (finding #2): non-null when the scan budget was
    // exhausted before `limit` authorized rows were found — pass cursorSentAtIso/cursorTrackingId
    // back to continue the same scan instead of assuming the backlog is fully accounted for.
    nextCursor: nextCursor ? { sentAtIso: nextCursor.sentAtIso, trackingId: nextCursor.docId } : null,
    behaviorLog: makeBehaviorLog(
      auth,
      `mail_outbox.reconcile_replies(${inspected.length})`,
      "success",
      "scp-automation",
    ),
  };
}

// listMailOutbox 라이브 회신 판정과 동일 패턴 — 다른 원장(scp_coldmail_history)의
// list-time join(hasReply/conversationId 해석)에서도 재사용한다 (S1/P1).
export async function conversationHasReply(conversationId: string, conversation: Record<string, unknown>): Promise<boolean> {
  if (!conversationId) return false;
  if (asString(conversation.lastMessageFrom, "") === "creator") return true;
  const inlineMessages = Array.isArray(conversation.messages) ? conversation.messages : [];
  if (inlineMessages.some((message) => asString(asRecord(message).from, "") === "creator")) return true;
  const replySnapshot = await adminDb.collection("conversations")
    .doc(conversationId)
    .collection("messages")
    .where("from", "==", "creator")
    .limit(1)
    .get();
  return !replySnapshot.empty;
}

// 1x1 투명 GIF (43 bytes).
const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export async function mailOpenPixelHandler(req: Request, res: Response): Promise<void> {
  const trackingId = asString(req.query?.tid, "");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Content-Type", "image/gif");
  if (TRACKING_ID_RE.test(trackingId)) {
    try {
      const openedAtIso = new Date().toISOString();
      const userAgent = asString(req.headers?.["user-agent"], "").slice(0, 300);
      const ip = asString(req.headers?.["x-forwarded-for"], asString(req.ip, "")).split(",")[0].trim().slice(0, 64);
      const classification = classifyPixelOpen(userAgent, ip);
      await adminDb.collection(OPEN_EVENTS_COLLECTION).add({
        trackingId,
        openedAtIso,
        expireAt: expireAt180DaysFromIso(openedAtIso),
        userAgent,
        ip,
        source: "pixel",
        openSignalVersion: "pixel-shadow-v1",
        openConfidence: classification.confidence,
        openSuppressionReason: classification.suppressionReason,
      });
      // 아웃박스 원장에 열람 카운트 조인 (원장 doc이 없어도 merge로 카운트만 유지).
      await adminDb.collection(OUTBOX_COLLECTION).doc(trackingId).set({
        openCount: FieldValue.increment(1),
        rawOpenCount: FieldValue.increment(1),
        likelyRecipientOpenCount: FieldValue.increment(0),
        lastOpenedAtIso: openedAtIso,
        lastRawOpenedAtIso: openedAtIso,
        firstRawOpenedAtIso: openedAtIso,
        openSignalVersion: "pixel-shadow-v1",
        openConfidence: classification.confidence,
        openSuppressionReason: classification.suppressionReason,
      }, { merge: true });
      await enqueueScpLifecycleRefreshEvent({
        source: "mail_outbound_log",
        sourceRef: `${OUTBOX_COLLECTION}/${trackingId}`,
        reason: "mail_outbound_opened",
        aliases: [{ trackingId }],
        sourceUpdatedAtIso: openedAtIso,
      });
    } catch {
      // LOG-P0-008: 실패도 남긴다 — 픽셀 응답은 항상 성공시켜 수신자 UX에 영향 주지 않는다.
      logMailSignatureFailure(
        MAIL_SIGNATURE_FAILURE_CODES.openEventWrite,
        correlationIdHash("mail_outbound_log", trackingId),
      );
    }
  }
  res.status(200).send(PIXEL_GIF);
}
