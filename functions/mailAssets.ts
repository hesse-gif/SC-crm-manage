import { createHash } from "node:crypto";

// G002: 콜드메일 본문 인라인 이미지의 공식 자산화(assetization).
// 원본 HTML의 data:image/*;base64 이미지는 저장·승인 전에 content-addressed
// 자산으로 추출되어 `cid:flu-asset-<sha256>` 참조로 치환된다. 임의 원격 이미지는
// 계속 차단되며, 발송 시 SMTP CID inline attachment 로만 이미지가 전달된다.

export const MAIL_ASSET_CID_PREFIX = "flu-asset-";
export const MAIL_ASSET_REGISTRY_COLLECTION = "mail_assets";
export const MAX_MAIL_ASSET_BYTES = 200 * 1024;
export const MAX_MAIL_ASSET_TOTAL_BYTES = 600 * 1024;
export const MAX_MAIL_ASSETS_PER_TEMPLATE = 8;

export const ALLOWED_MAIL_ASSET_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export type MailAssetManifestEntry = {
  cid: string;
  sha256: string;
  mime: string;
  bytes: number;
};

export type MailAssetContent = MailAssetManifestEntry & { base64: string };

export const MAIL_ASSET_CID_SRC_RE = /^cid:flu-asset-[a-f0-9]{64}$/;

const DATA_IMAGE_SRC_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid-argument", errorCode: "invalid_unauthorized" });
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function mailAssetCid(sha256: string): string {
  return `${MAIL_ASSET_CID_PREFIX}${sha256}`;
}

export function mailAssetCidSrc(sha256: string): string {
  return `cid:${mailAssetCid(sha256)}`;
}

/**
 * Extract every `data:image/...;base64` `<img src>` into a content-addressed
 * official asset and rewrite the src as `cid:flu-asset-<sha256>`.
 * Identical images dedupe onto one asset. Fails closed on oversized,
 * malformed, or non-allowlisted image payloads.
 */
export function extractInlineImageAssets(html: string): { html: string; assets: MailAssetContent[] } {
  const assetsBySha = new Map<string, MailAssetContent>();
  let totalBytes = 0;
  const rewritten = html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)("([^"]*)"|'([^']*)')/gi,
    (match, prefix: string, _quoted: string, doubleQuoted?: string, singleQuoted?: string) => {
      const src = (doubleQuoted ?? singleQuoted ?? "").trim();
      if (!src.toLowerCase().startsWith("data:")) return match;
      const parsed = DATA_IMAGE_SRC_RE.exec(src);
      if (!parsed) throw invalid("mail template contains an unsupported data: image");
      const mime = parsed[1].toLowerCase();
      if (!ALLOWED_MAIL_ASSET_MIME.has(mime)) {
        throw invalid(`mail template image type is not allowed: ${mime}`);
      }
      const base64 = parsed[2].replace(/\s+/g, "");
      let content: Buffer;
      try {
        content = Buffer.from(base64, "base64");
      } catch {
        throw invalid("mail template contains a malformed base64 image");
      }
      if (content.length === 0 || content.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
        throw invalid("mail template contains a malformed base64 image");
      }
      if (content.length > MAX_MAIL_ASSET_BYTES) {
        throw invalid("mail template image exceeds the per-image size limit");
      }
      const digest = sha256Hex(content);
      if (!assetsBySha.has(digest)) {
        totalBytes += content.length;
        if (assetsBySha.size + 1 > MAX_MAIL_ASSETS_PER_TEMPLATE) {
          throw invalid("mail template contains too many inline images");
        }
        if (totalBytes > MAX_MAIL_ASSET_TOTAL_BYTES) {
          throw invalid("mail template images exceed the total size limit");
        }
        assetsBySha.set(digest, {
          cid: mailAssetCid(digest),
          sha256: digest,
          mime,
          bytes: content.length,
          base64: content.toString("base64"),
        });
      }
      return `${prefix}"${mailAssetCidSrc(digest)}"`;
    },
  );
  return { html: rewritten, assets: [...assetsBySha.values()] };
}

/** Canonical hash binding a compiled artifact to its exact official assets. */
export function mailAssetsHash(assets: readonly MailAssetManifestEntry[]): string {
  const canonical = [...assets]
    .map(({ cid, sha256, mime, bytes }) => ({ cid, sha256, mime, bytes }))
    .sort((left, right) => (left.cid < right.cid ? -1 : left.cid > right.cid ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function mailAssetManifest(assets: readonly MailAssetManifestEntry[]): MailAssetManifestEntry[] {
  return assets.map(({ cid, sha256, mime, bytes }) => ({ cid, sha256, mime, bytes }));
}

export type MailAssetPreviewContent = { cid: string; mime: string; base64: string };

/** In-memory asset contents for sandboxed preview substitution (cid: -> data:). */
export function mailAssetPreviewContents(assets: readonly MailAssetManifestEntry[]): MailAssetPreviewContent[] {
  return assets
    .filter((entry): entry is MailAssetContent => {
      const base64 = (entry as MailAssetContent).base64;
      return typeof base64 === "string" && base64.length > 0;
    })
    .map(({ cid, mime, base64 }) => ({ cid, mime, base64 }));
}

export function mailAssetManifestFromSnapshot(value: unknown): MailAssetManifestEntry[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const manifest: MailAssetManifestEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const sha256 = typeof record.sha256 === "string" ? record.sha256 : "";
    const cid = typeof record.cid === "string" ? record.cid : "";
    const mime = typeof record.mime === "string" ? record.mime : "";
    const bytes = typeof record.bytes === "number" ? record.bytes : NaN;
    if (!/^[a-f0-9]{64}$/.test(sha256) || cid !== mailAssetCid(sha256)) return null;
    if (!ALLOWED_MAIL_ASSET_MIME.has(mime)) return null;
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_MAIL_ASSET_BYTES) return null;
    if (seen.has(cid)) return null;
    seen.add(cid);
    manifest.push({ cid, sha256, mime, bytes });
  }
  if (manifest.length > MAX_MAIL_ASSETS_PER_TEMPLATE) return null;
  return manifest;
}

export function cidReferencesInHtml(html: string): string[] {
  const refs = new Set<string>();
  for (const match of html.matchAll(/\bsrc\s*=\s*"cid:([^"]+)"/gi)) {
    refs.add(match[1]);
  }
  return [...refs];
}

/**
 * Compiled HTML and its asset manifest must reference each other exactly:
 * every `cid:` in the HTML has a manifest entry and every manifest entry is
 * referenced. Any drift invalidates the artifact (fail closed).
 */
export function mailAssetParityValid(compiledHtml: string, manifest: readonly MailAssetManifestEntry[]): boolean {
  const referenced = new Set(cidReferencesInHtml(compiledHtml));
  const declared = new Set(manifest.map((entry) => entry.cid));
  if (referenced.size !== declared.size) return false;
  for (const cid of referenced) {
    if (!declared.has(cid)) return false;
  }
  return true;
}

export function verifyMailAssetContent(entry: MailAssetManifestEntry, base64: string): boolean {
  let content: Buffer;
  try {
    content = Buffer.from(base64, "base64");
  } catch {
    return false;
  }
  return content.length === entry.bytes && sha256Hex(content) === entry.sha256;
}
