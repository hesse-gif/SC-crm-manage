import { adminDb } from "./firebaseAdmin";
import {
  MAIL_ASSET_REGISTRY_COLLECTION,
  cidReferencesInHtml,
  verifyMailAssetContent,
  type MailAssetContent,
  type MailAssetManifestEntry,
} from "./mailAssets";

// G002: 공식 메일 자산 레지스트리 — content-addressed(sha256 문서 ID), 서버 전용
// 쓰기, 불변(create-if-absent). 클라이언트는 Firestore에 직접 쓸 수 없으므로
// 이 레지스트리에 존재한다는 사실 자체가 "공식 자산" 증명이다.

type AssetRegistryDoc = {
  id: string;
  cid: string;
  mime: string;
  bytes: number;
  base64: string;
  createdAtIso: string;
  source: string;
};

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(`failed-precondition: ${message}`), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}

function hasBase64(entry: MailAssetManifestEntry): entry is MailAssetContent {
  const candidate = (entry as MailAssetContent).base64;
  return typeof candidate === "string" && candidate.length > 0;
}

/** Persist freshly compiled asset contents. Content-addressed and immutable — ALREADY_EXISTS is success. */
export async function upsertMailAssets(assets: readonly MailAssetManifestEntry[], source: string): Promise<void> {
  const createdAtIso = new Date().toISOString();
  await Promise.all(assets.filter(hasBase64).map(async (asset) => {
    if (!verifyMailAssetContent(asset, asset.base64)) {
      throw failedPrecondition(`mail asset content does not match its manifest hash (${asset.sha256.slice(0, 12)})`);
    }
    const document: AssetRegistryDoc = {
      id: asset.sha256,
      cid: asset.cid,
      mime: asset.mime,
      bytes: asset.bytes,
      base64: asset.base64,
      createdAtIso,
      source,
    };
    try {
      await adminDb.collection(MAIL_ASSET_REGISTRY_COLLECTION).doc(asset.sha256).create(document);
    } catch (error) {
      if ((error as { code?: number }).code !== 6) throw error;
    }
  }));
}

/** Load and hash-verify official asset contents for a persisted manifest. Fails closed on any drift. */
export async function loadMailAssetContents(manifest: readonly MailAssetManifestEntry[]): Promise<MailAssetContent[]> {
  return Promise.all(manifest.map(async (entry) => {
    if (hasBase64(entry)) {
      if (!verifyMailAssetContent(entry, entry.base64)) {
        throw failedPrecondition(`mail asset content does not match its manifest hash (${entry.sha256.slice(0, 12)})`);
      }
      return { ...entry };
    }
    const snapshot = await adminDb.collection(MAIL_ASSET_REGISTRY_COLLECTION).doc(entry.sha256).get();
    const data = (snapshot.data() ?? {}) as Partial<AssetRegistryDoc>;
    const base64 = typeof data.base64 === "string" ? data.base64 : "";
    if (!snapshot.exists || !base64 || data.mime !== entry.mime || !verifyMailAssetContent(entry, base64)) {
      throw failedPrecondition(`official mail asset is missing or corrupted (${entry.sha256.slice(0, 12)})`);
    }
    return { ...entry, base64 };
  }));
}

export type MailAssetAttachment = {
  filename: string;
  cid: string;
  content: Buffer;
  contentType: string;
};

const MIME_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Resolve SMTP CID inline attachments for a compiled artifact. Every cid
 * referenced by compiledHtml must resolve to a verified official asset —
 * missing/corrupted assets fail the send closed instead of mailing broken images.
 */
export async function resolveMailAssetAttachments(artifact: {
  compiledHtml: string;
  assets: MailAssetManifestEntry[];
}): Promise<MailAssetAttachment[]> {
  const referenced = new Set(cidReferencesInHtml(artifact.compiledHtml));
  const manifest = artifact.assets ?? [];
  for (const cid of referenced) {
    if (!manifest.some((entry) => entry.cid === cid)) {
      throw failedPrecondition(`compiled mail references an unknown image asset (${cid.slice(0, 24)})`);
    }
  }
  const contents = await loadMailAssetContents(manifest.filter((entry) => referenced.has(entry.cid)));
  return contents.map((asset) => ({
    filename: `${asset.cid}.${MIME_EXTENSION[asset.mime] ?? "bin"}`,
    cid: asset.cid,
    content: Buffer.from(asset.base64, "base64"),
    contentType: asset.mime,
  }));
}
