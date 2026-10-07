/**
 * Shared AES-256-GCM envelope crypto primitives for OAuth credential storage.
 *
 * Extracted from functions/youtubeOAuthHandoff.ts (PLAN-ORG-MAIL-IDENTITY Slice 2, see
 * docs/PLAN-ORG-MAIL-IDENTITY.md) so functions/mailOAuth.ts can reuse the exact same KEK/DEK
 * AES-256-GCM envelope construction instead of duplicating it. youtubeOAuthHandoff.ts now
 * imports these primitives instead of defining them locally — behavior is byte-identical,
 * only the implementation moved (see tests/youtube-oauth-handoff-v1.test.mjs, which must stay
 * green). Each domain (youtube, mail) keeps its own typed encrypt/decrypt wrapper with its own
 * AAD (additional authenticated data) prefix strings, so an envelope from one domain can never
 * be decrypted as another's even though both share an encryption key.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type AesGcmCiphertext = {
  ciphertext: string;
  iv: string;
  tag: string;
};

export type OAuthEnvelopeError = Error & { code: string };

export function oauthEnvelopeError(code: string, message: string): OAuthEnvelopeError {
  return Object.assign(new Error(message), { code });
}

export function encryptAesGcm(key: Buffer, plaintext: Buffer, aad: Buffer): AesGcmCiphertext {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptAesGcm(key: Buffer, value: AesGcmCiphertext, aad: Buffer): Buffer {
  const iv = parseBase64(value.iv, 12);
  const tag = parseBase64(value.tag, 16);
  const ciphertext = parseBase64(value.ciphertext);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Base64-decodes a 32-byte (256-bit) key; throws encryption_unavailable on any malformed input. */
export function parseEncryptionKey(value: string): Buffer {
  try {
    const key = parseBase64(value, 32);
    if (key.toString("base64") !== value) throw new Error("non-canonical base64");
    return key;
  } catch {
    throw oauthEnvelopeError("encryption_unavailable", "credential encryption is unavailable");
  }
}

export function parseBase64(value: unknown, expectedLength?: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("invalid base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (expectedLength !== undefined && decoded.length !== expectedLength) throw new Error("invalid decoded length");
  return decoded;
}

export function encryptionKeyVersion(key: Buffer): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
