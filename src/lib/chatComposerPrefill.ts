// "작성창으로 가져오기" (2026-10-05) — hands a review-board template to the EXISTING /chat composer.
//
// Client-side only: the text travels in sessionStorage keyed by conversation id + a one-time nonce;
// the URL only carries the nonce (?prefill=<nonce>), never the text. The composer consumes an entry
// once (matching conversation + nonce) and then removes it. Nothing here saves a draft, schedules or
// sends — the human edits/saves/sends in the composer with the existing permissions and gates.
export const COMPOSER_PREFILL_STORAGE_KEY = "flu.composerPrefill.v1";
export const COMPOSER_PREFILL_TTL_MS = 10 * 60 * 1000;

export type ComposerPrefill = {
  conversationId: string;
  nonce: string;
  templateId: string;
  text: string;
  createdAtMs: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function newNonce(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return random.replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
}

/** Stores the prefill and returns the /chat href to open. Returns null when storage is unavailable. */
export function stageComposerPrefill(
  input: { conversationId: string; templateId: string; text: string },
  options: { store?: StorageLike | null; nowMs?: number; nonce?: string } = {},
): string | null {
  const store = options.store === undefined ? storage() : options.store;
  const conversationId = input.conversationId.trim();
  if (!store || !conversationId || !input.text.trim()) return null;
  const entry: ComposerPrefill = {
    conversationId,
    nonce: options.nonce ?? newNonce(),
    templateId: input.templateId,
    text: input.text,
    createdAtMs: options.nowMs ?? Date.now(),
  };
  try {
    store.setItem(COMPOSER_PREFILL_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    return null;
  }
  return `/chat?conversationId=${encodeURIComponent(conversationId)}&prefill=${encodeURIComponent(entry.nonce)}`;
}

/**
 * Takes the staged prefill for exactly this conversation + nonce, removing it so it is applied once.
 * A stale (TTL), mismatched or malformed entry is never applied (a mismatched one is left alone).
 */
export function consumeComposerPrefill(
  conversationId: string,
  nonce: string,
  options: { store?: StorageLike | null; nowMs?: number } = {},
): ComposerPrefill | null {
  const store = options.store === undefined ? storage() : options.store;
  if (!store || !conversationId || !nonce) return null;
  let entry: ComposerPrefill | null = null;
  try {
    const raw = store.getItem(COMPOSER_PREFILL_STORAGE_KEY);
    entry = raw ? (JSON.parse(raw) as ComposerPrefill) : null;
  } catch {
    entry = null;
  }
  if (!entry || entry.conversationId !== conversationId || entry.nonce !== nonce || typeof entry.text !== "string") return null;
  try {
    store.removeItem(COMPOSER_PREFILL_STORAGE_KEY);
  } catch {
    // ignore
  }
  if ((options.nowMs ?? Date.now()) - entry.createdAtMs > COMPOSER_PREFILL_TTL_MS) return null;
  return entry;
}
