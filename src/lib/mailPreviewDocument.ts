// data: 이미지(공식 자산 cid: 프리뷰 치환분) + 자사 호스팅(sc-flu.web.app) 서명/자산 이미지만
// 허용 — 서드파티 네트워크 요청은 여전히 0 (수신자 측 렌더링과 동일한 first-party 로드만).
const MAIL_PREVIEW_CSP = [
  "default-src 'none'",
  "img-src data: https://sc-flu.web.app",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// 자사 호스팅 공식 메일 자산(서명 로고/게임 썸네일)만 유지 — 정확 프리픽스 + 래스터 확장자.
// 쿼리스트링/프래그먼트 불허(트래킹 파라미터 부착 불가), svg 불허(compile allowlist와 동일 정책).
const FIRST_PARTY_MAIL_ASSET_SRC_RE = /^https:\/\/sc-flu\.web\.app\/scp-assets\/[A-Za-z0-9._-]{1,120}\.(?:png|jpe?g|gif|webp)$/;

const FETCHABLE_ATTRIBUTE_NAMES = new Set([
  "action",
  "archive",
  "background",
  "classid",
  "codebase",
  "data",
  "dynsrc",
  "formaction",
  "href",
  "imagesrcset",
  "lowsrc",
  "manifest",
  "ping",
  "poster",
  "profile",
  "src",
  "srcdoc",
  "srcset",
  "usemap",
  "xlink:href",
]);

const NON_VISIBLE_RESOURCE_TAG_NAMES = new Set(["base", "link", "meta"]);
const HTML_TAG_PATTERN = /<(?:[^"'<>]|"[^"]*"|'[^']*')+>/g;
const STYLE_BLOCK_PATTERN = /(<style\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)(<\/style\s*>)/gi;

function neutralizeCssResourceUrls(css: string): string {
  return css
    .replace(/@import\s+(?:url\([^;]*?\)|"[^"]*"|'[^']*'|[^;]+)\s*;?/gi, "")
    .replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, "none")
    .replace(/(?:-webkit-)?image-set\([^)]*\)/gi, "none");
}

function isWhitespace(character: string): boolean {
  return /\s/.test(character);
}

export type PreviewAssetContent = { cid: string; mime: string; base64: string };

const PREVIEW_ASSET_CID_RE = /^cid:(flu-asset-[a-f0-9]{64})$/;
// Mirror functions/mailAssets.ts ALLOWED_MAIL_ASSET_MIME exactly; the preview
// must never render a mime the compile allowlist would have rejected.
const PREVIEW_ASSET_MIME_RE = /^image\/(jpeg|png|gif|webp)$/;
const PREVIEW_ASSET_BASE64_RE = /^[A-Za-z0-9+/=]+$/;

function previewAssetDataUri(assets: ReadonlyMap<string, PreviewAssetContent>, src: string): string | null {
  const match = PREVIEW_ASSET_CID_RE.exec(src.trim());
  if (!match) return null;
  const asset = assets.get(match[1]);
  if (!asset) return null;
  if (!PREVIEW_ASSET_MIME_RE.test(asset.mime) || !PREVIEW_ASSET_BASE64_RE.test(asset.base64)) return null;
  return `data:${asset.mime};base64,${asset.base64}`;
}

function neutralizeTagResourceAttributes(tag: string, assets: ReadonlyMap<string, PreviewAssetContent>): string {
  if (!/^<[a-z]/i.test(tag)) return tag;

  let cursor = 1;
  while (cursor < tag.length && !/[\s/>]/.test(tag[cursor])) cursor += 1;
  const tagName = tag.slice(1, cursor).toLowerCase();
  if (NON_VISIBLE_RESOURCE_TAG_NAMES.has(tagName)) return "";

  const contentEnd = tag.endsWith("/>") ? tag.length - 2 : tag.length - 1;
  let output = tag.slice(0, cursor);

  while (cursor < contentEnd) {
    const attributeStart = cursor;
    while (cursor < contentEnd && isWhitespace(tag[cursor])) cursor += 1;

    if (cursor >= contentEnd) {
      output += tag.slice(attributeStart, contentEnd);
      break;
    }

    const nameStart = cursor;
    while (cursor < contentEnd && !/[\s=/>]/.test(tag[cursor])) cursor += 1;
    if (cursor === nameStart) {
      output += tag.slice(attributeStart, cursor + 1);
      cursor += 1;
      continue;
    }

    const attributeName = tag.slice(nameStart, cursor).toLowerCase();
    while (cursor < contentEnd && isWhitespace(tag[cursor])) cursor += 1;

    let valueStart: number | null = null;
    let valueEnd: number | null = null;
    if (tag[cursor] === "=") {
      cursor += 1;
      while (cursor < contentEnd && isWhitespace(tag[cursor])) cursor += 1;

      const quote = tag[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        valueStart = cursor;
        while (cursor < contentEnd && tag[cursor] !== quote) cursor += 1;
        valueEnd = cursor;
        if (cursor < contentEnd) cursor += 1;
      } else {
        valueStart = cursor;
        while (cursor < contentEnd && !isWhitespace(tag[cursor]) && tag[cursor] !== ">") cursor += 1;
        valueEnd = cursor;
      }
    }

    if (FETCHABLE_ATTRIBUTE_NAMES.has(attributeName)) {
      // 예외 1: 서버 아티팩트의 공식 자산 cid: 이미지 참조를 로컬 data: URI로 치환한다
      // (발송 시 SMTP CID inline attachment와 동일한 시각 결과).
      // 예외 2: 자사 호스팅 서명/자산 래스터 이미지(sc-flu.web.app/scp-assets/*)는 수신자 측
      // 렌더링과 동일하게 유지한다(first-party 전용 — 오픈픽셀·서드파티 URL은 계속 제거).
      if (attributeName === "src" && valueStart !== null && valueEnd !== null) {
        const rawSrc = tag.slice(valueStart, valueEnd);
        const dataUri = previewAssetDataUri(assets, rawSrc);
        if (dataUri !== null) {
          output += ` src="${dataUri}"`;
        } else if (FIRST_PARTY_MAIL_ASSET_SRC_RE.test(rawSrc)) {
          output += ` src="${rawSrc}"`;
        }
      }
      continue;
    }

    if (attributeName === "style" && valueStart !== null && valueEnd !== null) {
      output += tag.slice(attributeStart, valueStart);
      output += neutralizeCssResourceUrls(tag.slice(valueStart, valueEnd));
      output += tag.slice(valueEnd, cursor);
      continue;
    }

    output += tag.slice(attributeStart, cursor);
  }

  return output + tag.slice(contentEnd);
}

export function buildSafeMailPreviewDocument(
  compiledHtml: string,
  assetContents: readonly PreviewAssetContent[] = [],
): string {
  const assets = new Map(assetContents.map((asset) => [asset.cid, asset]));
  const previewHtml = compiledHtml
    .replace(
      STYLE_BLOCK_PATTERN,
      (_match, openingTag: string, css: string, closingTag: string) =>
        `${openingTag}${neutralizeCssResourceUrls(css)}${closingTag}`,
    )
    .replace(HTML_TAG_PATTERN, (tag) => neutralizeTagResourceAttributes(tag, assets));

  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_PREVIEW_CSP}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{color-scheme:light}body{margin:0;padding:16px;background:#fff;color:#1f2937;font:14px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#3157d5}</style></head><body>${previewHtml}</body></html>`;
}
