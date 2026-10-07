import { createHash } from "node:crypto";
import { convert as htmlToText } from "html-to-text";
import sanitizeHtml from "sanitize-html";

import {
  MAIL_ASSET_CID_SRC_RE,
  extractInlineImageAssets,
  mailAssetManifest,
  mailAssetManifestFromSnapshot,
  mailAssetParityValid,
  mailAssetsHash,
  type MailAssetManifestEntry,
} from "./mailAssets";

export const MAIL_COMPILER_VERSION = "g002-mail-compiler-v2";
export const MAIL_MAX_INPUT_BYTES = 256 * 1024;

export type MailBodyFormat = "markdown" | "text" | "html";

export type MailCompileInput = {
  body: unknown;
  bodyFormat?: unknown;
  values?: Record<string, unknown>;
  templateRevision?: unknown;
};

export type MailArtifact = {
  bodyFormat: MailBodyFormat;
  compilerVersion: string;
  templateRevision: string;
  compiledHtml: string;
  text: string;
  contentHash: string;
  compiledHash: string;
  textHash: string;
  sourceHash: string;
  /** Official inline-image assets referenced from compiledHtml via cid: — manifest only; base64 exists in-memory right after compile. */
  assets: MailAssetManifestEntry[];
};

const ALLOWED_TAGS = [
  "a", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2",
  "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre",
  "s", "span", "strong", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
  "u", "ul",
];

// 이메일 클라이언트 호환 inline CSS만 허용. url()/expression()/image-set() 등
// 리소스 참조 값은 전면 차단(원격 요청·추적 금지) — linear-gradient 등 순수
// 표현 값만 통과한다.
const SAFE_STYLE_VALUE_RE = /^(?!.*(?:url|expression|image-set|element|paint)\s*\()[^;{}<>]{1,500}$/i;

const ALLOWED_STYLE_PROPERTIES = [
  "background", "background-color", "background-image",
  "border", "border-bottom", "border-collapse", "border-left", "border-radius",
  "border-right", "border-spacing", "border-top",
  "color", "display",
  "font", "font-family", "font-size", "font-style", "font-weight",
  "height", "letter-spacing", "line-height",
  "margin", "margin-bottom", "margin-left", "margin-right", "margin-top",
  "max-height", "max-width", "min-height", "min-width", "mso-hide",
  "opacity", "overflow",
  "padding", "padding-bottom", "padding-left", "padding-right", "padding-top",
  "text-align", "text-decoration", "text-transform",
  "vertical-align", "white-space", "width", "word-break",
];

export const MAIL_SANITIZE_ALLOWED_STYLES: Record<string, Record<string, RegExp[]>> = {
  "*": Object.fromEntries(ALLOWED_STYLE_PROPERTIES.map((property) => [property, [SAFE_STYLE_VALUE_RE]])),
};
const ALLOWED_STYLES = MAIL_SANITIZE_ALLOWED_STYLES;

const ALLOWED_ATTRIBUTES: Record<string, Array<string | { name: string; values: string[] }>> = {
  "*": ["style"],
  a: ["href", "target", "rel", "style"],
  img: ["src", "alt", "width", "height", "style"],
  // 이메일 HTML은 테이블 표현 속성이 레이아웃의 뼈대다(외부 제작 템플릿 호환).
  // 전부 표현 전용 속성 — fetch/script 표면이 없어 보안 경계를 넓히지 않는다.
  // role은 presentation 값만 — 레이아웃 테이블의 스크린리더 오독 방지(이메일 표준).
  table: ["width", "align", "bgcolor", "cellpadding", "cellspacing", "border", "style", { name: "role", values: ["presentation"] }],
  tr: ["align", "valign", "bgcolor", "style"],
  td: ["colspan", "rowspan", "width", "height", "align", "valign", "bgcolor", "style"],
  th: ["colspan", "rowspan", "width", "height", "align", "valign", "bgcolor", "style"],
};

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const MALFORMED_PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;
const FORBIDDEN_PLACEHOLDER_CONTAINERS = new Set([
  "script", "style", "iframe", "object", "embed", "svg", "math", "form", "template",
]);
const HTML_ASCII_WHITESPACE_RE = /[\t\n\f\r ]/;
const MARKDOWN_LINK_RE =
  /\[([^\]\n]+)\]\((https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)?)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s<>"']+/g;
const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid-argument", errorCode: "invalid_unauthorized" });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPE[character] ?? character);
}

function normalizedBodyFormat(value: unknown): MailBodyFormat {
  if (value === "html") return "html";
  if (value === "text") return "text";
  return "markdown";
}

function isMailBodyFormat(value: unknown): value is MailBodyFormat {
  return value === "markdown" || value === "text" || value === "html";
}

function normalizedRevision(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 160);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "0";
}

export function resolveMailSubject(value: unknown, values?: Record<string, unknown>): string {
  const source = typeof value === "string" ? value.replace(/\r\n?/g, " ") : String(value ?? "");
  validatePlaceholders(source);
  const stringified = stringValues(values);
  return source.replace(PLACEHOLDER_RE, (_match, key: string) => stringified[key] ?? `{{${key}}}`).replace(/\s+/g, " ").trim().slice(0, 400);
}

function stringValues(values: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [key, typeof value === "string" ? value : String(value ?? "")]),
  );
}

function replacePlaceholders(value: string, values: Record<string, string>): string {
  return value.replace(PLACEHOLDER_RE, (_match, key: string) => values[key] ?? `{{${key}}}`);
}

function replaceTextPlaceholders(value: string, values: Record<string, string>): string {
  return value.replace(PLACEHOLDER_RE, (_match, key: string) => escapeHtml(values[key] ?? `{{${key}}}`));
}

function validatePlaceholders(value: string): void {
  for (const match of value.matchAll(MALFORMED_PLACEHOLDER_RE)) {
    if (!/^[a-zA-Z0-9_]+$/.test(match[1]?.trim() ?? "")) {
      throw invalid("mail template contains a malformed placeholder");
    }
  }
}

function htmlTagIdentity(tag: string): {
  name: string;
  closing: boolean;
  selfClosing: boolean;
} | null {
  const match = /^<(\/)?([a-z][a-z0-9:-]*)(?=[\t\n\f\r />])/i.exec(tag);
  if (!match) return null;
  const name = match[2].toLowerCase();
  return {
    name,
    closing: Boolean(match[1]),
    // HTML의 void element인 embed는 닫는 태그 없이 끝나므로 금지 스택을 열어 두지 않는다.
    selfClosing: name === "embed",
  };
}

function replaceHtmlHrefPlaceholders(tag: string, values: Record<string, string>): string {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const opener = /^<a(?=[\t\n\f\r >])/i.exec(tag);
  if (!opener) return tag;

  let cursor = opener[0].length;
  while (cursor < tag.length) {
    while (cursor < tag.length && HTML_ASCII_WHITESPACE_RE.test(tag[cursor])) cursor += 1;
    if (cursor >= tag.length || tag[cursor] === ">" || tag[cursor] === "/") break;

    const nameStart = cursor;
    while (cursor < tag.length && !/[\t\n\f\r =/>]/.test(tag[cursor])) cursor += 1;
    const attributeName = tag.slice(nameStart, cursor).toLowerCase();
    while (cursor < tag.length && HTML_ASCII_WHITESPACE_RE.test(tag[cursor])) cursor += 1;
    if (tag[cursor] !== "=") continue;

    cursor += 1;
    while (cursor < tag.length && HTML_ASCII_WHITESPACE_RE.test(tag[cursor])) cursor += 1;
    const quote = tag[cursor];
    if (quote !== '"' && quote !== "'") {
      while (cursor < tag.length && !/[\t\n\f\r >]/.test(tag[cursor])) cursor += 1;
      continue;
    }

    const valueStart = cursor + 1;
    const valueEnd = tag.indexOf(quote, valueStart);
    if (valueEnd < 0) throw invalid("mail template contains malformed HTML");
    if (attributeName === "href") {
      const placeholder = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/.exec(tag.slice(valueStart, valueEnd));
      if (placeholder) {
        const key = placeholder[1];
        const resolved = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : "";
        if (!resolved) {
          replacements.push({ start: valueStart, end: valueEnd, value: "" });
        } else {
          const normalized = normalizedAbsoluteUrl(resolved);
          if (!normalized) {
            throw invalid("mail template URL placeholder is not an absolute URL");
          }
          replacements.push({ start: valueStart, end: valueEnd, value: escapeHtml(normalized) });
        }
      }
    }
    cursor = valueEnd + 1;
  }

  let output = tag;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
}

/**
 * HTML variables remain text-node-only except for a complete `href="{{key}}"` value on a real
 * anchor element. Comments and the enumerated forbidden-container stack reject placeholders;
 * other RCDATA/RAWTEXT-like containers are parsed as ordinary text here and are removed by the
 * outbound sanitizer. Missing href values become inert so the campaign landing-link guard can
 * persist a blocked draft without leaking a literal placeholder.
 */
function replaceHtmlTextPlaceholders(value: string, values: Record<string, string>): string {
  validatePlaceholders(value);
  const forbiddenStack: string[] = [];
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    if (value.startsWith("<!--", cursor)) {
      const end = value.indexOf("-->", cursor + 4);
      if (end < 0 || value.slice(cursor, end + 3).includes("{{")) {
        throw invalid("mail template placeholder is not in a text node");
      }
      output += value.slice(cursor, end + 3);
      cursor = end + 3;
      continue;
    }
    if (value[cursor] !== "<") {
      const nextTag = value.indexOf("<", cursor);
      const end = nextTag < 0 ? value.length : nextTag;
      const text = value.slice(cursor, end);
      if (forbiddenStack.length > 0 && text.includes("{{")) {
        throw invalid("mail template placeholder is not in a text node");
      }
      output += forbiddenStack.length > 0 ? text : replaceTextPlaceholders(text, values);
      cursor = end;
      continue;
    }
    let quote = "";
    let end = cursor + 1;
    for (; end < value.length; end += 1) {
      const character = value[end];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (end >= value.length) throw invalid("mail template contains malformed HTML");
    const tag = value.slice(cursor, end + 1);
    const identity = htmlTagIdentity(tag);
    const resolvedTag = forbiddenStack.length === 0
      && identity?.name === "a"
      && !identity.closing
      ? replaceHtmlHrefPlaceholders(tag, values)
      : tag;
    if (resolvedTag.includes("{{")) throw invalid("mail template placeholder is not in a text node");
    output += resolvedTag;

    if (identity && FORBIDDEN_PLACEHOLDER_CONTAINERS.has(identity.name)) {
      if (identity.closing) {
        if (forbiddenStack[forbiddenStack.length - 1] === identity.name) forbiddenStack.pop();
      } else if (!identity.selfClosing) {
        forbiddenStack.push(identity.name);
      }
    }
    cursor = end + 1;
  }
  return output;
}

function normalizedAbsoluteUrl(value: string): string | null {
  const normalized = value.trim().replace(/[\u0000-\u0020\u007f]/g, "");
  if (!normalized || normalized.startsWith("//")) return null;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:"
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function validAbsoluteUrl(value: string): boolean {
  return normalizedAbsoluteUrl(value) !== null;
}

// 공식 서명/브랜드 이미지가 서빙되는 회사 소유 HTTPS 호스트의 정본.
// mailSignature(서명 렌더·발송 sanitize)와 컴파일 sanitize가 같은 목록을 공유한다
// (mailSignature가 이 모듈을 import하므로 순환 없이 여기가 단일 출처).
export const OFFICIAL_MAIL_IMAGE_HTTPS_HOSTS = [
  "sc-flu.web.app",
  "supercent.io",
  "www.supercent.io",
  "cdn-official-site.supercent.io",
  "challenges.supercent.io",
] as const;
const OFFICIAL_MAIL_IMAGE_HOSTS = new Set<string>(OFFICIAL_MAIL_IMAGE_HTTPS_HOSTS);

// 회사 소유 호스트의 https 이미지 URL인지 검증한다(포트/자격증명/fragment 금지).
// 컴파일 단계는 호스트 수준까지만 판정하고, 발송 관문(sanitizeTrustedOutboundHtml)이
// 설정 기반 정확한 URL allowlist로 최종 강등을 결정한다.
export function isOfficialHostHttpsImageUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && !parsed.port
      && !parsed.username
      && !parsed.password
      && !parsed.hash
      && OFFICIAL_MAIL_IMAGE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function sanitizeUrlAttributes(tag: string, attributes: Record<string, string>): { tagName: string; attribs: Record<string, string> } {
  const next = { ...attributes };
  if (tag === "a" && next.href && !validAbsoluteUrl(next.href)) delete next.href;
  return { tagName: tag, attribs: next };
}

// 본문 이미지는 공식 자산(cid:flu-asset-<sha256>)과 회사 소유 호스트의 https 이미지만
// 허용. 그 외 모든 이미지(임의 원격 http(s), data:, 상대경로, placeholder)는 alt 텍스트
// span으로 대체되어 레이아웃 의미는 남기되 원격 요청·추적 벡터를 제거한다.
// v0.5.34: HTML 직접 작성 본문에 포함된 공식 서명 블록(로고+게임 그리드)이 컴파일에서
// 먼저 죽지 않도록 공식 호스트 https 이미지를 보존한다 — 발송 관문이 설정 기반 정확한
// URL allowlist로 최종 판정하므로 비공식 이미지는 여전히 발송 산출물에 남지 않는다.
function sanitizeBodyImage(tag: string, attributes: Record<string, string>): sanitizeHtml.Tag {
  const src = (attributes.src ?? "").trim();
  if (!MAIL_ASSET_CID_SRC_RE.test(src) && !isOfficialHostHttpsImageUrl(src)) {
    return { tagName: "span", attribs: {}, text: attributes.alt ?? "" };
  }
  return { tagName: tag, attribs: { ...attributes, src } };
}

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedStyles: ALLOWED_STYLES,
  allowedSchemes: ["http", "https", "mailto", "cid"],
  // img https는 sanitizeBodyImage transform이 공식 호스트만 통과시킨 뒤 src를 보존하기
  // 위한 스킴 허용 — 게이팅 자체는 transform(cid/공식 호스트)이 담당한다.
  allowedSchemesByTag: { a: ["http", "https", "mailto"], img: ["cid", "https"] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  enforceHtmlBoundary: true,
  parser: { lowerCaseTags: true, lowerCaseAttributeNames: true, decodeEntities: true },
  transformTags: {
    a: (tag, attributes) => sanitizeUrlAttributes(tag, attributes),
    img: (tag, attributes) => sanitizeBodyImage(tag, attributes),
  },
};

export function sanitizeMailHtml(value: unknown): string {
  const html = typeof value === "string" ? value : String(value ?? "");
  if (Buffer.byteLength(html, "utf8") > MAIL_MAX_INPUT_BYTES) throw invalid("mail template is too large");
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

function splitTrailingUrlPunctuation(value: string): { url: string; trailing: string } {
  let url = value;
  let trailing = "";
  while (/[.,!?;:)]$/.test(url)) {
    trailing = url.slice(-1) + trailing;
    url = url.slice(0, -1);
  }
  return { url, trailing };
}

function markdownLinkHtml(value: string): string {
  let lastIndex = 0;
  const parts: string[] = [];
  for (const match of value.matchAll(MARKDOWN_LINK_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(bareUrlHtml(value.slice(lastIndex, index)));
    const label = escapeHtml(match[1] ?? "");
    const url = match[2] ?? "";
    parts.push(validAbsoluteUrl(url) ? `<a href="${escapeHtml(url)}">${label}</a>` : label);
    lastIndex = index + match[0].length;
  }
  if (lastIndex < value.length) parts.push(bareUrlHtml(value.slice(lastIndex)));
  return parts.join("");
}

function bareUrlHtml(value: string): string {
  let lastIndex = 0;
  const parts: string[] = [];
  for (const match of value.matchAll(BARE_URL_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(escapeHtml(value.slice(lastIndex, index)));
    const { url, trailing } = splitTrailingUrlPunctuation(match[0]);
    parts.push(validAbsoluteUrl(url) ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` : escapeHtml(match[0]));
    parts.push(escapeHtml(trailing));
    lastIndex = index + match[0].length;
  }
  if (lastIndex < value.length) parts.push(escapeHtml(value.slice(lastIndex)));
  return parts.join("");
}

function sourceToHtml(source: string, format: MailBodyFormat, values: Record<string, string>): string {
  if (format === "html") return replaceHtmlTextPlaceholders(source, values);
  const resolved = replacePlaceholders(source, values);
  if (format === "text") {
    const escaped = escapeHtml(resolved);
    return escaped.split(/\n{2,}/).map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`).join("\n");
  }
  return resolved.split(/\n{2,}/).map((paragraph) => `<p>${markdownLinkHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join("\n");
}

export function artifactFromCompiledHtml(
  base: Omit<MailArtifact, "compiledHtml" | "text" | "compiledHash" | "textHash">,
  compiledHtml: string,
  sanitizer: (value: unknown) => string = sanitizeMailHtml,
): MailArtifact {
  const safeHtml = sanitizer(compiledHtml);
  if (!mailAssetParityValid(safeHtml, base.assets ?? [])) {
    throw invalid("mail template image references drifted from the official asset manifest");
  }
  const text = htmlToText(safeHtml, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: false } },
      { selector: "ul", options: { itemPrefix: "* " } },
      { selector: "ol", options: { itemPrefix: "1. " } },
    ],
  }).trim();
  return {
    ...base,
    compiledHtml: safeHtml,
    text,
    compiledHash: sha256(safeHtml),
    textHash: sha256(text),
  };
}

export function compileMailArtifact(input: MailCompileInput): MailArtifact {
  const source = typeof input.body === "string" ? input.body.replace(/\r\n?/g, "\n") : String(input.body ?? "");
  if (Buffer.byteLength(source, "utf8") > MAIL_MAX_INPUT_BYTES) throw invalid("mail template is too large");
  const bodyFormat = normalizedBodyFormat(input.bodyFormat);
  validatePlaceholders(source);
  const values = stringValues(input.values);
  // HTML 본문의 data: 인라인 이미지는 컴파일 시점에 공식 자산으로 추출되어
  // cid: 참조로 치환된다. contentHash/sourceHash는 운영자가 저장한 원본
  // (자산화 이전) 기준 — 원본이 바뀌면 해시가 바뀌어 기존 승인이 무효화된다.
  const assetization = bodyFormat === "html" ? extractInlineImageAssets(source) : { html: source, assets: [] };
  const base = {
    bodyFormat,
    compilerVersion: MAIL_COMPILER_VERSION,
    templateRevision: normalizedRevision(input.templateRevision),
    contentHash: sha256(source),
    sourceHash: sha256(source),
    assets: assetization.assets,
  };
  return artifactFromCompiledHtml(base, sourceToHtml(assetization.html, bodyFormat, values));
}

export function compiledArtifactFingerprint(artifact: Pick<MailArtifact, "bodyFormat" | "compilerVersion" | "templateRevision" | "compiledHash" | "textHash" | "contentHash"> & { assets?: MailAssetManifestEntry[] }): string {
  const assets = artifact.assets ?? [];
  return sha256(JSON.stringify({
    bodyFormat: artifact.bodyFormat,
    compilerVersion: artifact.compilerVersion,
    templateRevision: artifact.templateRevision,
    contentHash: artifact.contentHash,
    compiledHash: artifact.compiledHash,
    textHash: artifact.textHash,
    // 자산이 있는 아티팩트만 assetsHash가 지문에 참여한다(자산 없는 기존
    // 지문과의 호환 유지). 자산 내용/구성이 바뀌면 승인 지문이 달라진다.
    ...(assets.length > 0 ? { assetsHash: mailAssetsHash(assets) } : {}),
  }));
}

export function mailArtifactFromSnapshot(value: Record<string, unknown>): MailArtifact | null {
  if (value.bodyFormat !== undefined && !isMailBodyFormat(value.bodyFormat)) return null;
  const bodyFormat = normalizedBodyFormat(value.bodyFormat);
  const compilerVersion = typeof value.compilerVersion === "string" ? value.compilerVersion : "";
  const templateRevision = typeof value.templateRevision === "string" ? value.templateRevision : "";
  const compiledHtml = typeof value.compiledHtml === "string" ? value.compiledHtml : "";
  const text = typeof value.text === "string" ? value.text : "";
  const contentHash = typeof value.contentHash === "string" ? value.contentHash : "";
  const sourceHash = typeof value.sourceHash === "string" ? value.sourceHash : contentHash;
  const compiledHash = typeof value.compiledHash === "string" ? value.compiledHash : "";
  const textHash = typeof value.textHash === "string" ? value.textHash : "";
  if (compilerVersion !== MAIL_COMPILER_VERSION || !templateRevision || !compiledHtml || !contentHash || !compiledHash || !textHash) return null;
  const assets = mailAssetManifestFromSnapshot(value.assets);
  if (assets === null) return null;
  if (!mailAssetParityValid(compiledHtml, assets)) return null;
  const safeHtml = sanitizeMailHtml(compiledHtml);
  const derivedText = htmlToText(safeHtml, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: false } },
      { selector: "ul", options: { itemPrefix: "* " } },
      { selector: "ol", options: { itemPrefix: "1. " } },
    ],
  }).trim();
  if (sourceHash !== contentHash || safeHtml !== compiledHtml || sha256(compiledHtml) !== compiledHash || sha256(text) !== textHash || text !== derivedText) return null;
  return { bodyFormat, compilerVersion, templateRevision, compiledHtml, text, contentHash, sourceHash, compiledHash, textHash, assets: mailAssetManifest(assets) };
}
